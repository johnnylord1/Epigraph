<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { BookOpen, Folder, FolderSimplePlus, UploadSimple } from "phosphor-svelte";
  import { addToast, setActiveBookId, setLibraryScrollTop, store, updateSettings, upsertBook } from "../../store/state.svelte";
  import { hasBookLocalAsset, MISSING_BOOK_ASSET_MESSAGE } from "../../lib/books/availability";
  import { BookAssetResolver } from "../../lib/books/assets";
  import { importLocalBookFile, isSupportedBookImportPath } from "../../lib/books/importFile";
  import type { BookEntry, BookProgress } from "../../lib/books/types";
  import { presentBookWithCoverSrc } from "../../lib/books/presentation";
  import { createBookLibraryCardId } from "../../lib/library/cardIdentity";
  import {
    createBooksCategory,
    isBookAssignedToCategory,
    sortBooksCategories,
    toggleBookCategoryAssignment,
  } from "../../lib/library/domainCategories";
  import { computeLibraryLayout, type LibraryPreferredGridColumns, type LibraryViewMode } from "../../lib/libraryDisplay";
  import type { BooksSectionVM } from "../../lib/library/contracts";
  import ContextMenu, { type MenuEntry } from "../shared/ContextMenu.svelte";
  import LibraryCardGrid from "./LibraryCardGrid.svelte";

  type Props = {
    vm: BooksSectionVM;
    books: BookEntry[];
    totalBooks: number;
    renderLimit?: number;
    viewKey: string;
    viewMode: LibraryViewMode;
    preferredColumns: LibraryPreferredGridColumns;
    showProgress: boolean;
    showOutline: boolean;
  };

  let {
    vm,
    books,
    totalBooks,
    renderLimit = 48,
    viewKey,
    viewMode = "grid",
    preferredColumns = "auto",
    showProgress = true,
    showOutline = true,
  }: Props = $props();

  const win = getCurrentWindow();
  let contentEl: HTMLDivElement | null = $state(null);
  let dropActive = $state(false);
  let importingDrop = $state(false);
  let brokenCoverKeys = $state(new Set<string>());
  let contentWidth = $state(0);
  let ctx: { x: number; y: number; book: BookEntry } | null = $state(null);
  let renderVisible = $state(0);
  let scrollReady = false;
  let viewStateReady = false;

  const bookByCardId = $derived(
    new Map(books.map((book) => [createBookLibraryCardId(book.id), book])),
  );

  const bookProgressById = $derived(
    new Map(store.bookProgress.map((progress: BookProgress) => [progress.bookId, progress])),
  );

  const visibleBooks = $derived(books.slice(0, renderVisible));
  const visibleCards = $derived(
    visibleBooks.map((book) => {
      const progress = bookProgressById.get(book.id);
      const coverSrc = brokenCoverKeys.has(bookCoverKey(book))
        ? null
        : BookAssetResolver.resolveCoverSrc(book);
      const presented = presentBookWithCoverSrc(book, progress, coverSrc);
      const hasLocalAsset = hasBookLocalAsset(book);
      const badges = [{ kind: "subtype" as const, label: presented.subtypeLabel }];
      if (!hasLocalAsset) {
        badges.push({ kind: "status" as const, label: "Missing file" });
      }
      const metaChips = [presented.sectionCountLabel];
      if (!hasLocalAsset) {
        metaChips.push("Metadata only");
      }

      return {
        id: createBookLibraryCardId(book.id),
        title: presented.title,
        subtitle: presented.authorLabel,
        coverSrc: presented.coverSrc,
        coverFit: "cover" as const,
        badges,
        metaChips,
        progress: presented.showProgress
          ? {
              primaryLabel: presented.progressSummary,
              secondaryLabel: presented.readPercentLabel,
              percent: presented.readPercent,
            }
          : null,
        selectable: false,
        selected: false,
        disabled: !hasLocalAsset,
      };
    }),
  );
  const hasMore = $derived(books.length > renderVisible);
  const remainingCount = $derived(Math.max(0, books.length - renderVisible));
  const layout = $derived(
    computeLibraryLayout({
      availableWidth: contentWidth,
      preferredColumns,
      mode: viewMode,
    }),
  );

  function bookCoverKey(book: Pick<BookEntry, "id" | "coverPath" | "updatedAt">): string {
    return `${book.id}:${book.coverPath ?? "none"}:${book.updatedAt}`;
  }

  function fileBasename(path: string): string {
    return path.split(/[\\/]/).pop() ?? "Imported book";
  }

  function fileStem(path: string): string {
    return fileBasename(path).replace(/\.[^.]+$/i, "");
  }

  function setsEqual<T>(left: Set<T>, right: Set<T>): boolean {
    if (left.size !== right.size) return false;
    for (const value of left) {
      if (!right.has(value)) return false;
    }
    return true;
  }

  function loadMore() {
    renderVisible = Math.min(books.length, renderVisible + renderLimit);
  }

  function maybeLoadMore() {
    if (!contentEl || !hasMore) return;
    const nearBottom = contentEl.scrollTop + contentEl.clientHeight >= contentEl.scrollHeight - 800;
    if (nearBottom) {
      loadMore();
    }
  }

  $effect(() => {
    const liveKeys = new Set(books.map(bookCoverKey));
    const next = new Set([...brokenCoverKeys].filter((key) => liveKeys.has(key)));
    if (!setsEqual(brokenCoverKeys, next)) {
      brokenCoverKeys = next;
    }
  });

  $effect(() => {
    viewKey;
    if (!viewStateReady) {
      viewStateReady = true;
      scrollReady = true;
      renderVisible = Math.min(renderLimit, books.length);
      setLibraryScrollTop(0);
      return;
    }

    renderVisible = Math.min(renderLimit, books.length);
    setLibraryScrollTop(0);
    if (contentEl) contentEl.scrollTo({ top: 0 });
  });

  $effect(() => {
    books.length;
    if (renderVisible > books.length) {
      renderVisible = books.length;
    }
    if (scrollReady && contentEl) {
      maybeLoadMore();
    }
  });

  async function importBookFile(sourcePath: string): Promise<BookEntry> {
    const imported = await importLocalBookFile(sourcePath, { existingBooks: store.books });
    const entry = imported.entry;
    upsertBook(entry);
    addToast({
      kind: "success",
      title: imported.existing
        ? `Updated ${entry.subtype.toUpperCase()}`
        : `Imported ${entry.subtype.toUpperCase()}`,
      body: entry.title,
    });
    return entry;
  }

  async function importDroppedPaths(paths: string[]) {
    const deduped = [...new Set(paths)];
    const supported = deduped.filter(isSupportedBookImportPath);
    const skipped = deduped.filter((path) => !isSupportedBookImportPath(path));

    if (!supported.length) {
      addToast({
        kind: "info",
        title: "No supported books detected",
        body: "Drop EPUB or PDF files into the Books shelf.",
      });
      return;
    }

    if (skipped.length) {
      addToast({
        kind: "info",
        title: "Some files were skipped",
        body: "Only EPUB and PDF files can be imported into Books.",
      });
    }

    importingDrop = true;
    try {
      for (const path of supported) {
        try {
          await importBookFile(path);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : `Could not import ${fileBasename(path)}.`;
          addToast({
            kind: "error",
            title: `Import failed: ${fileBasename(path)}`,
            body: message,
          });
        }
      }
    } finally {
      importingDrop = false;
    }
  }

  function openBook(cardId: string) {
    const book = bookByCardId.get(cardId);
    if (!book) return;
    if (!hasBookLocalAsset(book)) {
      addToast({
        kind: "info",
        title: "File missing",
        body: MISSING_BOOK_ASSET_MESSAGE,
      });
      return;
    }
    setActiveBookId(book.id);
  }

  function openBookContext(cardId: string, event: MouseEvent) {
    const book = bookByCardId.get(cardId);
    if (!book) return;
    event.preventDefault();
    ctx = { x: event.clientX, y: event.clientY, book };
  }

  function toggleCategory(book: BookEntry, categoryId: string) {
    updateSettings({
      booksCategoryAssignments: toggleBookCategoryAssignment(
        store.settings.booksCategoryAssignments,
        book.id,
        categoryId,
      ),
    });
  }

  function createCategoryAndAssign(book: BookEntry) {
    const name = prompt("Category name:");
    if (!name?.trim()) return;

    const nextCategory = createBooksCategory(store.settings.booksCategories, name);
    updateSettings({
      booksCategories: sortBooksCategories([...store.settings.booksCategories, nextCategory]),
      booksCategoryAssignments: toggleBookCategoryAssignment(
        store.settings.booksCategoryAssignments,
        book.id,
        nextCategory.id,
      ),
    });
  }

  function buildContextItems(book: BookEntry): MenuEntry[] {
    const categoryItems: MenuEntry[] = store.settings.booksCategories.map((category) => {
      const assigned = isBookAssignedToCategory(
        book.id,
        category.id,
        store.settings.booksCategoryAssignments,
      );

      return {
        label: assigned ? `Remove from ${category.name}` : `Add to ${category.name}`,
        icon: Folder,
        onClick: () => toggleCategory(book, category.id),
      };
    });

    return [
      ...categoryItems,
      ...(categoryItems.length ? ([{ separator: true } as MenuEntry]) : []),
      {
        label: "New category",
        icon: FolderSimplePlus,
        onClick: () => createCategoryAndAssign(book),
      },
    ];
  }

  function handleCoverError(cardId: string) {
    const book = bookByCardId.get(cardId);
    if (!book) return;

    BookAssetResolver.dropCoverSrc(book.coverPath);
    brokenCoverKeys = new Set([...brokenCoverKeys, bookCoverKey(book)]);
  }

  function handleContentScroll() {
    if (!contentEl) return;
    setLibraryScrollTop(contentEl.scrollTop);
    maybeLoadMore();
  }

  onMount(() => {
    let unlisten: (() => void) | undefined;
    let resizeObserver: ResizeObserver | null = null;

    void (async () => {
      unlisten = await win.onDragDropEvent((event) => {
        if (event.payload.type === "enter") {
          dropActive = event.payload.paths.some(isSupportedBookImportPath);
          return;
        }

        if (event.payload.type === "leave") {
          dropActive = false;
          return;
        }

        if (event.payload.type === "drop") {
          dropActive = false;
          void importDroppedPaths(event.payload.paths);
        }
      });
    })();

    queueMicrotask(() => {
      if (contentEl) {
        contentWidth = contentEl.clientWidth;
        resizeObserver = new ResizeObserver((entries) => {
          const nextWidth = entries[0]?.contentRect.width ?? contentEl?.clientWidth ?? 0;
          contentWidth = nextWidth;
        });
        resizeObserver.observe(contentEl);
      }
    });

    return () => {
      dropActive = false;
      resizeObserver?.disconnect();
      unlisten?.();
    };
  });
</script>

<div class="content" bind:this={contentEl} onscroll={handleContentScroll}>
  {#if totalBooks === 0 || books.length === 0}
    <div class="center books-empty">
      <BookOpen size={28} weight="duotone" />
      <span>{vm.emptyMessage}</span>
    </div>
  {:else}
    <LibraryCardGrid
      items={visibleCards}
      {viewMode}
      effectiveColumns={layout.effectiveColumns}
      {showProgress}
      {showOutline}
      onOpen={(cardId) => openBook(cardId)}
      onContextMenu={openBookContext}
      onCoverError={handleCoverError}
    />
    {#if hasMore}
      <div class="load-more-row">
        <button type="button" class="load-more-btn" onclick={loadMore}>
          Show {Math.min(remainingCount, renderLimit)} more
          <span class="load-more-count">({remainingCount} remaining)</span>
        </button>
      </div>
    {/if}
  {/if}

  {#if vm.dragDropEnabled && (dropActive || importingDrop)}
    <div class="book-drop-overlay" aria-hidden="true">
      <div class="book-drop-panel">
        <UploadSimple size={22} weight="bold" />
        <div class="book-drop-copy">
          <strong>{importingDrop ? "Importing books..." : "Drop EPUB or PDF files here"}</strong>
          <span>{importingDrop ? "Aethon is adding them to the Books shelf." : "Imported books stay separate from Comics."}</span>
        </div>
      </div>
    </div>
  {/if}
</div>

{#if ctx}
  <ContextMenu x={ctx.x} y={ctx.y} items={buildContextItems(ctx.book)} onClose={() => ctx = null} />
{/if}

<style>
  .content {
    position: relative;
    flex: 1;
    overflow-y: auto;
    padding: var(--sp-5) var(--sp-6) var(--sp-6);
    min-height: 0;
    will-change: scroll-position;
    -webkit-overflow-scrolling: touch;
  }

  .center {
    position: relative;
    z-index: 1;
    min-height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-3);
    text-align: center;
    color: var(--text-muted);
  }

  .books-empty {
    font-size: var(--text-sm);
    line-height: var(--leading-base);
  }

  .load-more-row {
    display: flex;
    justify-content: center;
    padding: var(--sp-5) 0 var(--sp-2);
    position: relative;
    z-index: 1;
  }

  .load-more-btn {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    padding: 8px 20px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
    color: var(--text-muted);
    cursor: pointer;
    transition: color var(--t-base), border-color var(--t-base), background var(--t-base);
  }

  .load-more-btn:hover {
    color: var(--accent-fg);
    border-color: var(--accent-dim);
    background: var(--accent-muted);
  }

  .load-more-count {
    color: var(--text-faint);
    font-size: var(--text-2xs);
  }

  .book-drop-overlay {
    position: absolute;
    inset: 0;
    background: rgba(5, 8, 6, 0.78);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 6;
  }

  .book-drop-panel {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-4) var(--sp-5);
    border: 1px solid var(--accent-dim);
    border-radius: var(--radius-lg);
    background: linear-gradient(180deg, var(--bg-overlay), color-mix(in srgb, var(--bg-overlay) 70%, var(--accent-muted)));
    box-shadow: 0 16px 42px rgba(0, 0, 0, 0.42);
    color: var(--accent-fg);
  }

  .book-drop-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .book-drop-copy strong {
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    color: var(--text-primary);
  }

  .book-drop-copy span {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-muted);
    letter-spacing: var(--tracking-wide);
  }
</style>
