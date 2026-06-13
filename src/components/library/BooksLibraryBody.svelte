<script lang="ts" module>
  const sessionStableNovelCoverSrc = new Map<string, string>();
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { Folder, FolderSimplePlus, UploadSimple } from "phosphor-svelte";
  import { addToast, setActiveBookId, setLibraryScrollTop, store, updateSettings, upsertBook } from "../../store/state.svelte";
  import { hasBookLocalAsset, MISSING_BOOK_ASSET_MESSAGE } from "../../lib/books/availability";
  import { BookAssetResolver } from "../../lib/books/assets";
  import { importLocalBookFile, isSupportedBookImportPath } from "../../lib/books/importFile";
  import type { BookEntry, BookProgress } from "../../lib/books/types";
  import { presentBookWithCoverSrc } from "../../lib/books/presentation";
  import { getBookSectionCount } from "../../lib/books/summary";
  import { createBookLibraryCardId } from "../../lib/library/cardIdentity";
  import {
    createBooksCategory,
    isBookAssignedToCategory,
    sortBooksCategories,
    toggleBookCategoryAssignment,
  } from "../../lib/library/domainCategories";
  import { computeLibraryLayout, type LibraryPreferredGridColumns, type LibraryViewMode } from "../../lib/libraryDisplay";
  import type { BooksSectionVM } from "../../lib/library/contracts";
  import type { NovelShelfCard } from "../../lib/novels/libraryShelf";
  import ContextMenu, { type MenuEntry } from "../shared/ContextMenu.svelte";
  import NocturneState from "../shared/NocturneState.svelte";
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
    novelCards?: NovelShelfCard[];
    onOpenNovel?: (novelId: string) => void;
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
    novelCards = [],
    onOpenNovel = () => {},
  }: Props = $props();

  const win = getCurrentWindow();
  let contentEl: HTMLDivElement | null = $state(null);
  let dropActive = $state(false);
  let importingDrop = $state(false);
  let brokenCoverKeys = $state(new Set<string>());
  let stableNovelCoverSrc = $state(new Map<string, string>(sessionStableNovelCoverSrc));
  let contentWidth = $state(0);
  let ctx: { x: number; y: number; book: BookEntry } | null = $state(null);
  let renderVisible = $state(0);
  let scrollReady = false;
  let viewStateReady = false;
  let scrollPersistFrame: number | null = null;
  let pendingScrollTop = 0;

  const bookByCardId = $derived(
    new Map(books.map((book) => [createBookLibraryCardId(book.id), book])),
  );

  const bookProgressById = $derived(
    new Map(store.bookProgress.map((progress: BookProgress) => [progress.bookId, progress])),
  );

  function getBookChapterCount(book: BookEntry): number {
    const sectionCount = getBookSectionCount(book);
    if (sectionCount > 0) return sectionCount;
    return book.subtype === "pdf" && typeof book.pageCount === "number" && book.pageCount > 0 ? 1 : 0;
  }

  function getBookReadChapterCount(book: BookEntry, progress: BookProgress | null | undefined): number {
    const chapterCount = getBookChapterCount(book);
    if (chapterCount <= 0) return 0;
    const pct = Math.max(0, Math.min(1, progress?.progressPercent ?? 0));
    return Math.max(0, Math.min(chapterCount, Math.round(pct * chapterCount)));
  }

  function formatBookFileSource(book: BookEntry): string {
    return book.subtype.toUpperCase();
  }

  function buildBookWorkStatus(hasLocalAsset: boolean, isReadFinished: boolean): string {
    if (!hasLocalAsset) return "Missing file";
    return isReadFinished ? "Finished" : "Completed";
  }

  const visibleBooks = $derived(books.slice(0, renderVisible));
  const visibleBookCards = $derived(
    visibleBooks.map((book) => {
      const progress = bookProgressById.get(book.id);
      const coverSrc = brokenCoverKeys.has(bookCoverKey(book))
        ? null
        : BookAssetResolver.resolveCoverSrc(book);
      const presented = presentBookWithCoverSrc(book, progress, coverSrc);
      const hasLocalAsset = hasBookLocalAsset(book);
      const chapterCount = getBookChapterCount(book);
      const readCount = getBookReadChapterCount(book, progress);
      const unreadCount = Math.max(0, chapterCount - readCount);
      const badges = !hasLocalAsset
        ? [{ kind: "status" as const, label: "Missing file" }]
        : [];
      const metaChips = [buildBookWorkStatus(hasLocalAsset, readCount >= chapterCount && chapterCount > 0)];
      if (!hasLocalAsset) metaChips.push("Metadata only");

      return {
        id: createBookLibraryCardId(book.id),
        title: presented.title,
        subtitle: formatBookFileSource(book),
        coverSrc: presented.coverSrc,
        coverFit: "cover" as const,
        badges,
        metaChips,
        progress: presented.showProgress
          ? {
              primaryLabel: String(readCount),
              secondaryLabel: chapterCount > 0 ? `/ ${chapterCount} chapters` : undefined,
              percent: chapterCount > 0 ? Math.max(0, Math.min(1, readCount / chapterCount)) : presented.readPercent,
            }
          : null,
        selectable: false,
        selected: false,
        disabled: !hasLocalAsset,
        sourceMetricBanner: {
          flagLabel: "",
          downloadedCount: 0,
          newCount: unreadCount,
          sourceName: null,
        },
      };
    }),
  );
  const visibleNovelCards = $derived(
    novelCards.map((card) => {
      const cachedCoverSrc = stableNovelCoverSrc.get(card.id);
      const coverSrc = cachedCoverSrc === card.coverSrc ? cachedCoverSrc : card.coverSrc;
      return coverSrc === card.coverSrc ? card : { ...card, coverSrc };
    }),
  );
  const visibleCards = $derived([...visibleBookCards, ...visibleNovelCards]);
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

  function novelCoverKey(card: Pick<NovelShelfCard, "id" | "coverSrc">): string {
    return `${card.id}:${card.coverSrc ?? "none"}`;
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
    const liveKeys = new Set([
      ...books.map(bookCoverKey),
      ...novelCards.map(novelCoverKey),
    ]);
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
    if (renderVisible === 0 && books.length > 0) {
      renderVisible = Math.min(renderLimit, books.length);
    }
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
    const novel = novelCards.find((card) => card.id === cardId);
    if (novel) {
      onOpenNovel(novel.novelId);
      return;
    }

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
    const novel = novelCards.find((card) => card.id === cardId);
    if (novel) {
      return;
    }

    const book = bookByCardId.get(cardId);
    if (!book) return;

    BookAssetResolver.dropCoverSrc(book.coverPath);
    brokenCoverKeys = new Set([...brokenCoverKeys, bookCoverKey(book)]);
  }

  function handleCoverLoad(cardId: string) {
    const novel = novelCards.find((card) => card.id === cardId);
    if (!novel?.coverSrc) return;

    const nextCovers = new Map(stableNovelCoverSrc);
    nextCovers.set(cardId, novel.coverSrc);
    stableNovelCoverSrc = nextCovers;
    sessionStableNovelCoverSrc.set(cardId, novel.coverSrc);

    const key = novelCoverKey(novel);
    if (brokenCoverKeys.has(key)) {
      const nextBroken = new Set(brokenCoverKeys);
      nextBroken.delete(key);
      brokenCoverKeys = nextBroken;
    }
  }

  function handleContentScroll() {
    if (!contentEl) return;
    pendingScrollTop = contentEl.scrollTop;
    if (scrollPersistFrame !== null) return;
    scrollPersistFrame = requestAnimationFrame(() => {
      scrollPersistFrame = null;
      setLibraryScrollTop(pendingScrollTop);
      maybeLoadMore();
    });
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
      if (scrollPersistFrame !== null) {
        cancelAnimationFrame(scrollPersistFrame);
        scrollPersistFrame = null;
      }
      resizeObserver?.disconnect();
      unlisten?.();
    };
  });
</script>

<div class="content" bind:this={contentEl} onscroll={handleContentScroll}>
  {#if totalBooks === 0 || visibleCards.length === 0}
    <div class="center books-empty">
      <NocturneState
        layout="center"
        tone="info"
        icon="books"
        eyebrow="Library"
        title="No books here yet"
        body={vm.emptyMessage}
      />
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
      onCoverLoad={handleCoverLoad}
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
    padding:
      var(--library-content-padding-top, var(--sp-5))
      var(--library-shell-padding-x, var(--sp-6))
      var(--library-content-padding-bottom, var(--sp-6));
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
