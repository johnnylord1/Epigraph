<script lang="ts">
  import { onMount } from "svelte";
  import { Books, CheckSquare, Folder, FolderSimplePlus, Trash, X } from "phosphor-svelte";
  import { thumbUrl } from "../../lib/client";
  import { createComicLibraryCardId } from "../../lib/library/cardIdentity";
  import { buildComicsLibraryCardVm } from "../../lib/library/comicsSection";
  import { computeLibraryLayout, type LibraryPreferredGridColumns, type LibraryViewMode } from "../../lib/libraryDisplay";
  import type { ComicsSectionVM } from "../../lib/library/contracts";
  import { getCategoryDisplayName } from "../../lib/library/categories";
  import type { Category, Manga } from "../../lib/types";
  import {
    setLibraryReturnToMangaId,
    setLibraryScrollTop,
    setLibraryVisibleCount,
    setActiveManga,
    store,
  } from "../../store/state.svelte";
  import ContextMenu, { type MenuEntry } from "../shared/ContextMenu.svelte";
  import LibraryCardGrid from "./LibraryCardGrid.svelte";

  type Props = {
    vm: ComicsSectionVM;
    mangas: Manga[];
    categories: Category[];
    categoryMangaMap: Map<number, Manga[]>;
    trackedCompletedIds?: ReadonlySet<number>;
    trackedChapterTotalsByMangaId?: ReadonlyMap<number, number>;
    renderLimit?: number;
    viewKey: string;
    viewMode: LibraryViewMode;
    preferredColumns: LibraryPreferredGridColumns;
    showProgress: boolean;
    showOutline: boolean;
    onRemoveFromLibrary?: (manga: Manga) => Promise<void> | void;
    onAddToLibrary?: (manga: Manga) => Promise<void> | void;
    onDeleteAllDownloads?: (manga: Manga) => Promise<void> | void;
    onToggleCategory?: (manga: Manga, category: Category) => Promise<void> | void;
    onCreateAndAssign?: (manga: Manga) => Promise<void> | void;
    onCreateCategory?: () => Promise<void> | void;
  };

  let {
    vm,
    mangas,
    categories,
    categoryMangaMap,
    trackedCompletedIds = new Set(),
    trackedChapterTotalsByMangaId = new Map(),
    viewKey,
    viewMode = "grid",
    preferredColumns = "auto",
    showProgress = true,
    showOutline = true,
    onRemoveFromLibrary = async () => {},
    onAddToLibrary = async () => {},
    onDeleteAllDownloads = async () => {},
    onToggleCategory = async () => {},
    onCreateAndAssign = async () => {},
    onCreateCategory = async () => {},
  }: Props = $props();

  let contentEl: HTMLDivElement | null = $state(null);
  let contentWidth = $state(0);
  let ctx: { x: number; y: number; manga: Manga } | null = $state(null);
  let emptyCtx: { x: number; y: number } | null = $state(null);
  let selectMode = $state(false);
  let selectedIds = $state(new Set<number>());
  let bulkWorking = $state(false);
  let bulkMoveOpen = $state(false);
  let failedCoverIds = $state(new Set<number>());
  let coverRetryCounts = $state(new Map<number, number>());
  let viewStateReady = false;
  let pendingScrollRestore = false;
  let pendingCardRestore = false;
  let prevActiveMangaId: number | null = null;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  const coverSessionSeed = Math.random().toString(36).slice(2);
  const coverRetryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const coverRecoveryTimers = new Map<number, ReturnType<typeof setTimeout>>();

  const mangaByCardId = $derived(
    new Map(mangas.map((manga) => [createComicLibraryCardId(manga.id), manga])),
  );

  const visibleCards = $derived(
    mangas.map((manga) => {
      const card = buildComicsLibraryCardVm(manga, {
        cropCovers: store.settings.libraryCropCovers,
        selectedIds,
        trackedCompletedIds,
        trackedChapterTotalsByMangaId,
      });

      return {
        ...card,
        coverSrc: hasUsableCover(manga) ? getCoverSrc(manga) : null,
      };
    }),
  );
  const layout = $derived(
    computeLibraryLayout({
      availableWidth: contentWidth,
      preferredColumns,
      mode: viewMode,
    }),
  );

  function enterSelectMode(id?: number) {
    selectMode = true;
    if (id !== undefined) selectedIds = new Set([id]);
  }

  function exitSelectMode() {
    selectMode = false;
    selectedIds = new Set();
    bulkMoveOpen = false;
  }

  function toggleSelect(id: number) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
    if (next.size === 0) exitSelectMode();
  }

  function selectAll() {
    selectedIds = new Set(mangas.map((manga) => manga.id));
  }

  function onCardPointerDown(cardId: string, event: PointerEvent) {
    const manga = mangaByCardId.get(cardId);
    if (!manga || event.button !== 0) return;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      enterSelectMode(manga.id);
    }, 500);
  }

  function clearLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function onOpenCard(cardId: string, event: MouseEvent | KeyboardEvent) {
    clearLongPress();
    const manga = mangaByCardId.get(cardId);
    if (!manga) return;

    if (selectMode) {
      toggleSelect(manga.id);
      return;
    }

    if (event instanceof MouseEvent && (event.metaKey || event.ctrlKey || event.shiftKey)) {
      event.preventDefault();
      enterSelectMode(manga.id);
      return;
    }

    setActiveManga(manga);
  }

  async function bulkMoveToCategory(category: Category) {
    bulkWorking = true;
    bulkMoveOpen = false;
    try {
      await Promise.all(
        [...selectedIds].map((id) => {
          const manga = mangas.find((entry) => entry.id === id);
          return manga ? onToggleCategory(manga, category) : Promise.resolve();
        }),
      );
    } finally {
      bulkWorking = false;
      exitSelectMode();
    }
  }

  async function bulkRemoveFromLibrary() {
    bulkWorking = true;
    try {
      await Promise.all(
        [...selectedIds].map((id) => {
          const manga = mangas.find((entry) => entry.id === id);
          return manga ? onRemoveFromLibrary(manga) : Promise.resolve();
        }),
      );
    } finally {
      bulkWorking = false;
      exitSelectMode();
    }
  }

  function handleCoverError(cardId: string) {
    const manga = mangaByCardId.get(cardId);
    if (!manga || failedCoverIds.has(manga.id)) return;

    const attempts = coverRetryCounts.get(manga.id) ?? 0;
    if (attempts < 2) {
      if (coverRetryTimers.has(manga.id)) return;

      const timer = setTimeout(() => {
        coverRetryTimers.delete(manga.id);
        const nextRetries = new Map(coverRetryCounts);
        nextRetries.set(manga.id, attempts + 1);
        coverRetryCounts = nextRetries;
      }, 900 * (attempts + 1));

      coverRetryTimers.set(manga.id, timer);
      return;
    }

    const nextFailed = new Set(failedCoverIds);
    nextFailed.add(manga.id);
    failedCoverIds = nextFailed;

    if (coverRecoveryTimers.has(manga.id)) return;

    const recoveryTimer = setTimeout(() => {
      coverRecoveryTimers.delete(manga.id);

      const nextFailures = new Set(failedCoverIds);
      nextFailures.delete(manga.id);
      failedCoverIds = nextFailures;

      const nextRetries = new Map(coverRetryCounts);
      nextRetries.set(manga.id, (nextRetries.get(manga.id) ?? 0) + 1);
      coverRetryCounts = nextRetries;
    }, 15000);

    coverRecoveryTimers.set(manga.id, recoveryTimer);
  }

  function handleCoverLoad(cardId: string) {
    const manga = mangaByCardId.get(cardId);
    if (!manga) return;

    if (coverRetryTimers.has(manga.id)) {
      clearTimeout(coverRetryTimers.get(manga.id)!);
      coverRetryTimers.delete(manga.id);
    }

    if (failedCoverIds.has(manga.id)) {
      const nextFailed = new Set(failedCoverIds);
      nextFailed.delete(manga.id);
      failedCoverIds = nextFailed;
    }

    if (coverRecoveryTimers.has(manga.id)) {
      clearTimeout(coverRecoveryTimers.get(manga.id)!);
      coverRecoveryTimers.delete(manga.id);
    }

    if (coverRetryCounts.has(manga.id)) {
      const nextRetries = new Map(coverRetryCounts);
      nextRetries.delete(manga.id);
      coverRetryCounts = nextRetries;
    }
  }

  function hasUsableCover(manga: Manga): boolean {
    return !!manga.thumbnailUrl && !failedCoverIds.has(manga.id);
  }

  function getCoverSignature(manga: Manga): string {
    const sourceId = typeof manga.source?.id === "string" ? manga.source.id : "";
    const title = typeof manga.title === "string" ? manga.title.trim().toLowerCase() : "";
    return encodeURIComponent(`${manga.id}:${sourceId}:${title}`);
  }

  function getCoverSrc(manga: Manga): string {
    if (!manga.thumbnailUrl) return "";
    const base = thumbUrl(manga.thumbnailUrl);
    const sig = getCoverSignature(manga);
    const retry = coverRetryCounts.get(manga.id) ?? 0;
    const params = [`aethon_cover_sig=${sig}`, `aethon_cover_session=${coverSessionSeed}`];
    if (retry > 0) params.push(`aethon_cover_retry=${retry}`);
    return `${base}${base.includes("?") ? "&" : "?"}${params.join("&")}`;
  }

  function handleContentScroll() {
    if (!contentEl) return;
    setLibraryScrollTop(contentEl.scrollTop);
  }

  function openCtx(cardId: string, event: MouseEvent) {
    const manga = mangaByCardId.get(cardId);
    if (!manga) return;
    if (selectMode) {
      toggleSelect(manga.id);
      return;
    }
    event.preventDefault();
    ctx = { x: event.clientX, y: event.clientY, manga };
  }

  function buildCtxItems(manga: Manga): MenuEntry[] {
    const categoryEntries: MenuEntry[] = categories.map((category) => {
      const inCategory = (categoryMangaMap.get(category.id) ?? []).some((entry) => entry.id === manga.id);
      return {
        label: inCategory
          ? `Remove from ${getCategoryDisplayName(category)}`
          : `Add to ${getCategoryDisplayName(category)}`,
        icon: Folder,
        onClick: () => onToggleCategory(manga, category),
      };
    });

    return [
      {
        label: manga.inLibrary ? "Remove from library" : "Add to library",
        icon: Books,
        onClick: () => (manga.inLibrary ? onRemoveFromLibrary(manga) : onAddToLibrary(manga)),
      },
      {
        label: "Delete all downloads",
        icon: Trash,
        danger: true,
        disabled: !(manga.downloadCount && manga.downloadCount > 0),
        onClick: () => onDeleteAllDownloads(manga),
      },
      { separator: true },
      { label: "Select this manga", icon: CheckSquare, onClick: () => enterSelectMode(manga.id) },
      ...(categoryEntries.length ? ([{ separator: true } as MenuEntry, ...categoryEntries]) : []),
      { separator: true },
      { label: "New folder", icon: FolderSimplePlus, onClick: () => onCreateAndAssign(manga) },
    ];
  }

  function buildEmptyCtx(): MenuEntry[] {
    return [{
      label: "New folder",
      icon: FolderSimplePlus,
      onClick: () => onCreateCategory(),
    }];
  }

  $effect(() => {
    mangas.length;
    setLibraryVisibleCount(mangas.length);
  });

  $effect(() => {
    viewKey;
    if (!viewStateReady) {
      viewStateReady = true;
      return;
    }

    exitSelectMode();
    setLibraryScrollTop(0);
    if (contentEl) contentEl.scrollTo({ top: 0 });
  });

  $effect(() => {
    const activeMangaId = store.activeManga?.id ?? null;

    if (activeMangaId !== null && contentEl) {
      clearLongPress();
      setLibraryScrollTop(contentEl.scrollTop);
      setLibraryVisibleCount(mangas.length);
      setLibraryReturnToMangaId(activeMangaId);
    }

    if (prevActiveMangaId !== null && activeMangaId === null) {
      pendingScrollRestore = store.libraryScrollTop > 0;
      pendingCardRestore = !pendingScrollRestore && store.libraryReturnToMangaId !== null;
    }

    prevActiveMangaId = activeMangaId;
  });

  $effect(() => {
    if (!pendingScrollRestore || vm.loading || !contentEl || store.activeManga) return;

    const targetTop = store.libraryScrollTop;
    if (targetTop <= 0) {
      pendingScrollRestore = false;
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!contentEl) return;
        contentEl.scrollTo({ top: targetTop });
        pendingScrollRestore = false;
        pendingCardRestore = false;
      });
    });
  });

  $effect(() => {
    if (!pendingCardRestore || vm.loading || !contentEl || store.activeManga) return;

    const targetId = store.libraryReturnToMangaId;
    if (targetId === null) {
      pendingCardRestore = false;
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!contentEl) return;
        const card = contentEl.querySelector<HTMLElement>(`[data-card-id="${createComicLibraryCardId(targetId)}"]`);
        if (card) {
          card.scrollIntoView({ block: "center", inline: "nearest" });
          pendingCardRestore = false;
        }
      });
    });
  });

  onMount(() => {
    let resizeObserver: ResizeObserver | null = null;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && selectMode) exitSelectMode();
      if ((event.key === "a" && (event.metaKey || event.ctrlKey)) && selectMode) {
        event.preventDefault();
        selectAll();
      }
    }

    queueMicrotask(() => {
      if (contentEl) {
        contentWidth = contentEl.clientWidth;
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver((entries) => {
            const nextWidth = entries[0]?.contentRect.width ?? contentEl?.clientWidth ?? 0;
            contentWidth = nextWidth;
          });
          resizeObserver.observe(contentEl);
        }
        requestAnimationFrame(() => {
          if (contentEl) contentWidth = contentEl.clientWidth;
        });
      }
      if (store.libraryScrollTop > 0) {
        pendingScrollRestore = true;
      }
      if (store.libraryScrollTop <= 0 && store.libraryReturnToMangaId !== null) {
        pendingCardRestore = true;
      }
    });

    window.addEventListener("keydown", onKeyDown);

    return () => {
      clearLongPress();
      for (const timer of coverRetryTimers.values()) clearTimeout(timer);
      coverRetryTimers.clear();
      for (const timer of coverRecoveryTimers.values()) clearTimeout(timer);
      coverRecoveryTimers.clear();
      resizeObserver?.disconnect();
      window.removeEventListener("keydown", onKeyDown);
    };
  });
</script>

{#if selectMode}
  <div class="select-bar">
    <div class="select-bar-left">
      <button type="button" class="sel-btn sel-cancel" onclick={exitSelectMode} title="Cancel (Esc)">
        <X size={13} weight="bold" />
      </button>
      <span class="sel-count">{selectedIds.size} selected</span>
      <button type="button" class="sel-btn sel-all" onclick={selectAll} title="Select all">
        Select all
      </button>
    </div>
    <div class="select-bar-right">
      {#if categories.length}
        <div class="bulk-move-wrap">
          <button
            type="button"
            class="sel-btn sel-move"
            disabled={selectedIds.size === 0 || bulkWorking}
            onclick={() => bulkMoveOpen = !bulkMoveOpen}
          >
            <Folder size={13} weight="bold" />
            Move to folder
          </button>
          {#if bulkMoveOpen}
            <div class="bulk-folder-list">
              {#each categories as category}
                <button type="button" class="bulk-folder-item" onclick={() => bulkMoveToCategory(category)}>
                  <Folder size={11} weight="bold" />
                  {getCategoryDisplayName(category)}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      <button
        type="button"
        class="sel-btn sel-remove"
        disabled={selectedIds.size === 0 || bulkWorking}
        onclick={bulkRemoveFromLibrary}
      >
        <Trash size={13} weight="bold" />
        Remove
      </button>
    </div>
  </div>
{/if}

<div
  class="content"
  role="presentation"
  bind:this={contentEl}
  onscroll={handleContentScroll}
  oncontextmenu={(event) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    emptyCtx = { x: event.clientX, y: event.clientY };
  }}
>
  {#if vm.loading}
    <div class="grid-skeleton">
      {#each Array(12) as _}
        <div class="card-skeleton">
          <div class="cover-skeleton skeleton"></div>
          <div class="title-skeleton skeleton"></div>
        </div>
      {/each}
    </div>
  {:else if mangas.length === 0}
    <div class="center">{vm.emptyMessage}</div>
  {:else}
    <LibraryCardGrid
      items={visibleCards}
      {viewMode}
      effectiveColumns={layout.effectiveColumns}
      {showProgress}
      {showOutline}
      showSelectableState={selectMode}
      onOpen={onOpenCard}
      onContextMenu={openCtx}
      onPointerDown={onCardPointerDown}
      onPointerUp={() => clearLongPress()}
      onPointerLeave={() => clearLongPress()}
      onCoverLoad={handleCoverLoad}
      onCoverError={handleCoverError}
    />
  {/if}
</div>

{#if ctx}
  <ContextMenu x={ctx.x} y={ctx.y} items={buildCtxItems(ctx.manga)} onClose={() => ctx = null} />
{/if}
{#if emptyCtx}
  <ContextMenu x={emptyCtx.x} y={emptyCtx.y} items={buildEmptyCtx()} onClose={() => emptyCtx = null} />
{/if}

<style>
  .content {
    flex: 1;
    overflow-y: auto;
    padding: var(--sp-5) var(--sp-6) var(--sp-6);
    min-height: 0;
    will-change: scroll-position;
    -webkit-overflow-scrolling: touch;
  }

  .grid-skeleton {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: var(--sp-4);
  }

  .card-skeleton {
    padding: 0;
  }

  .cover-skeleton {
    aspect-ratio: 2 / 3;
    border-radius: var(--radius-md);
  }

  .title-skeleton {
    height: 12px;
    margin-top: var(--sp-2);
    width: 80%;
    border-radius: var(--radius-sm);
  }

  .center {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 60%;
    color: var(--text-muted);
    font-size: var(--text-sm);
    gap: var(--sp-2);
    text-align: center;
    line-height: var(--leading-base);
  }

  .select-bar {
    position: relative;
    z-index: 4;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-6);
    background: var(--bg-raised);
    border-bottom: 1px solid var(--accent-dim);
    flex-shrink: 0;
    animation: fadeIn 0.1s ease both;
  }

  .select-bar-left {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }

  .select-bar-right {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    position: relative;
  }

  .sel-count {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--accent-fg);
    letter-spacing: var(--tracking-wide);
  }

  .sel-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-dim);
    background: var(--bg-base);
    color: var(--text-muted);
    cursor: pointer;
    transition: color var(--t-base), border-color var(--t-base), background var(--t-base);
    white-space: nowrap;
  }

  .sel-btn:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--border-strong);
  }

  .sel-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .sel-cancel {
    border-color: transparent;
    background: transparent;
  }

  .sel-cancel:hover {
    background: var(--bg-raised);
    border-color: var(--border-dim);
  }

  .sel-move {
    color: var(--accent-fg);
    border-color: var(--accent-dim);
    background: var(--accent-muted);
  }

  .sel-move:hover:not(:disabled) {
    background: var(--accent-dim);
  }

  .sel-remove {
    color: var(--color-error, #e05c5c);
    border-color: color-mix(in srgb, var(--color-error, #e05c5c) 30%, transparent);
  }

  .sel-remove:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-error, #e05c5c) 12%, transparent);
  }

  .sel-all {
    border-color: transparent;
    background: transparent;
  }

  .bulk-move-wrap {
    position: relative;
  }

  .bulk-folder-list {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 10;
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
    border-radius: var(--radius-md);
    padding: 4px;
    min-width: 160px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    animation: fadeIn 0.1s ease both;
  }

  .bulk-folder-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    cursor: pointer;
    text-align: left;
    transition: background var(--t-base), color var(--t-base);
  }

  .bulk-folder-item:hover {
    background: var(--bg-hover, var(--bg-base));
    color: var(--text-primary);
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
