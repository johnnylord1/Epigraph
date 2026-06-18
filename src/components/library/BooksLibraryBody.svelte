<script lang="ts" module>
  const sessionStableBookCoverSrc = new Map<string, string>();
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
  import type { BooksSectionVM, LibraryCardVM } from "../../lib/library/contracts";
  import {
    buildNovelShelfCard,
    type NovelShelfCard,
    type NovelShelfCardContext,
  } from "../../lib/novels/libraryShelf";
  import type { PersistedNovelLibraryEntry } from "../../lib/novels/domain";
  import ContextMenu, { type MenuEntry } from "../shared/ContextMenu.svelte";
  import NocturneState from "../shared/NocturneState.svelte";
  import VirtualLibraryCardGrid from "./VirtualLibraryCardGrid.svelte";

  type Props = {
    vm: BooksSectionVM;
    active?: boolean;
    books: BookEntry[];
    totalBooks: number;
    renderLimit?: number;
    viewKey: string;
    viewMode: LibraryViewMode;
    preferredColumns: LibraryPreferredGridColumns;
    showProgress: boolean;
    showOutline: boolean;
    novelEntries?: PersistedNovelLibraryEntry[];
    novelCardContext?: NovelShelfCardContext;
    onOpenNovel?: (novelId: string) => void;
  };

  let {
    vm,
    active = true,
    books,
    totalBooks,
    renderLimit = 48,
    viewKey,
    viewMode = "grid",
    preferredColumns = "auto",
    showProgress = true,
    showOutline = true,
    novelEntries = [],
    novelCardContext = {
      readCounts: new Map(),
      progressByNovelId: new Map(),
      hardcoverRecordByNovelId: new Map(),
    },
    onOpenNovel = () => {},
  }: Props = $props();

  const win = getCurrentWindow();
  let contentEl: HTMLDivElement | null = $state(null);
  let dropActive = $state(false);
  let importingDrop = $state(false);
  let brokenCoverKeys = $state(new Set<string>());
  let stableBookCoverSrc = $state(new Map<string, string>(sessionStableBookCoverSrc));
  let stableNovelCoverSrc = $state(new Map<string, string>(sessionStableNovelCoverSrc));
  let prewarmStartIndex = $state(0);
  let prewarmEndIndex = $state(0);
  let contentWidth = $state(0);
  let ctx: { x: number; y: number; book: BookEntry } | null = $state(null);
  let scrollReady = false;
  let viewStateReady = false;
  let previousViewKey: string | null = null;
  let scrollPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingScrollTop = 0;
  let isScrolling = $state(false);
  const pendingStableBookCoverSrc = new Map<string, string>();
  const pendingStableNovelCoverSrc = new Map<string, string>();
  const coverPrewarmInflight = new Set<string>();
  let coverPrewarmQueue: Array<{ id: string; src: string; kind: "book" | "novel" }> = [];
  let coverPrewarmHandle: ReturnType<typeof setTimeout> | number | null = null;
  let coverPrewarmUsesIdleCallback = false;
  let coverFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const lazyVirtualizeAfter = 180;

  const bookByCardId = $derived(
    new Map(books.map((book) => [createBookLibraryCardId(book.id), book])),
  );
  const novelByCardId = $derived(
    new Map(novelEntries.map((entry) => [`novel-card:${entry.id}`, entry])),
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

  const totalCardCount = $derived(books.length + novelEntries.length);
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

  function novelCoverKey(entry: Pick<PersistedNovelLibraryEntry, "id" | "coverUrl">): string {
    return `novel-card:${entry.id}:${entry.coverUrl ?? "none"}`;
  }

  function buildRawBookCard(book: BookEntry): LibraryCardVM {
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
      coverFit: "cover",
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
  }

  function buildRawNovelCard(entry: PersistedNovelLibraryEntry): NovelShelfCard {
    return buildNovelShelfCard(entry, novelCardContext);
  }

  function getRawCardAt(index: number): LibraryCardVM | null {
    const book = books[index];
    if (book) return buildRawBookCard(book);
    const novel = novelEntries[index - books.length];
    return novel ? buildRawNovelCard(novel) : null;
  }

  function getVisibleCardAt(index: number): LibraryCardVM | null {
    const card = getRawCardAt(index);
    if (!card) return null;
    if (card.id.startsWith("novel-card:")) {
      const cachedCoverSrc = stableNovelCoverSrc.get(card.id);
      return cachedCoverSrc && cachedCoverSrc === card.coverSrc ? card : { ...card, coverSrc: null };
    }
    const stable = stableBookCoverSrc.get(card.id);
    return stable && stable === card.coverSrc ? card : { ...card, coverSrc: null };
  }

  function getCardIdAt(index: number): string {
    const book = books[index];
    if (book) return createBookLibraryCardId(book.id);
    const novel = novelEntries[index - books.length];
    return novel ? `novel-card:${novel.id}` : String(index);
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

  $effect(() => {
    const liveKeys = new Set([
      ...books.map(bookCoverKey),
      ...novelEntries.map(novelCoverKey),
    ]);
    const next = new Set([...brokenCoverKeys].filter((key) => liveKeys.has(key)));
    if (!setsEqual(brokenCoverKeys, next)) {
      brokenCoverKeys = next;
    }
  });

  $effect(() => {
    const nextViewKey = viewKey;
    if (!viewStateReady) {
      viewStateReady = true;
      previousViewKey = nextViewKey;
      scrollReady = true;
      if (active) setLibraryScrollTop(0);
      return;
    }
    if (nextViewKey === previousViewKey) return;
    previousViewKey = nextViewKey;
    prewarmStartIndex = 0;
    prewarmEndIndex = Math.min(totalCardCount, Math.max(1, renderLimit || 48));

    if (active) {
      setLibraryScrollTop(0);
      if (contentEl) contentEl.scrollTo({ top: 0 });
    }
  });

  $effect(() => {
    books.length;
    scrollReady;
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
    const novel = novelByCardId.get(cardId);
    if (novel) {
      onOpenNovel(novel.id);
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
    const novel = novelByCardId.get(cardId);
    if (novel) {
      const key = novelCoverKey(novel);
      const nextStable = new Map(stableNovelCoverSrc);
      nextStable.delete(cardId);
      stableNovelCoverSrc = nextStable;
      sessionStableNovelCoverSrc.delete(cardId);
      brokenCoverKeys = new Set([...brokenCoverKeys, key]);
      return;
    }

    const book = bookByCardId.get(cardId);
    if (!book) return;

    BookAssetResolver.dropCoverSrc(book.coverPath);
    const nextStable = new Map(stableBookCoverSrc);
    nextStable.delete(cardId);
    stableBookCoverSrc = nextStable;
    sessionStableBookCoverSrc.delete(cardId);
    brokenCoverKeys = new Set([...brokenCoverKeys, bookCoverKey(book)]);
  }

  function handleCoverLoad(cardId: string) {
    const novel = novelByCardId.get(cardId);
    if (!novel?.coverUrl) {
      const book = bookByCardId.get(cardId);
      const coverSrc = book ? BookAssetResolver.resolveCoverSrc(book) : null;
      if (!coverSrc) return;
      const nextBooks = new Map(stableBookCoverSrc);
      nextBooks.set(cardId, coverSrc);
      stableBookCoverSrc = nextBooks;
      sessionStableBookCoverSrc.set(cardId, coverSrc);
      return;
    }

    const nextCovers = new Map(stableNovelCoverSrc);
    nextCovers.set(cardId, novel.coverUrl);
    stableNovelCoverSrc = nextCovers;
    sessionStableNovelCoverSrc.set(cardId, novel.coverUrl);

    const key = novelCoverKey(novel);
    if (brokenCoverKeys.has(key)) {
      const nextBroken = new Set(brokenCoverKeys);
      nextBroken.delete(key);
      brokenCoverKeys = nextBroken;
    }
  }

  async function decodeCoverUrl(url: string) {
    if (typeof Image === "undefined") return;
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    if (typeof image.decode !== "function") return;
    try {
      await image.decode();
    } catch {
      await new Promise<void>((resolve) => {
        image.onload = () => resolve();
        image.onerror = () => resolve();
        setTimeout(resolve, 1200);
      });
    }
  }

  function clearCoverPrewarmSchedule() {
    if (coverPrewarmHandle === null) return;
    if (
      coverPrewarmUsesIdleCallback
      && typeof window !== "undefined"
      && typeof window.cancelIdleCallback === "function"
    ) {
      window.cancelIdleCallback(coverPrewarmHandle as number);
    } else {
      clearTimeout(coverPrewarmHandle as ReturnType<typeof setTimeout>);
    }
    coverPrewarmHandle = null;
    coverPrewarmUsesIdleCallback = false;
  }

  function scheduleCoverFlush() {
    if (coverFlushTimer !== null) return;
    coverFlushTimer = setTimeout(flushCoverUpdates, isScrolling ? 220 : 80);
  }

  function flushCoverUpdates() {
    coverFlushTimer = null;
    if (isScrolling) {
      scheduleCoverFlush();
      return;
    }

    if (pendingStableBookCoverSrc.size) {
      const nextBooks = new Map(stableBookCoverSrc);
      for (const [cardId, src] of pendingStableBookCoverSrc) nextBooks.set(cardId, src);
      pendingStableBookCoverSrc.clear();
      stableBookCoverSrc = nextBooks;
    }

    if (pendingStableNovelCoverSrc.size) {
      const nextNovels = new Map(stableNovelCoverSrc);
      for (const [cardId, src] of pendingStableNovelCoverSrc) nextNovels.set(cardId, src);
      pendingStableNovelCoverSrc.clear();
      stableNovelCoverSrc = nextNovels;
    }
  }

  async function prewarmCover(entry: { id: string; src: string; kind: "book" | "novel" }) {
    const key = `${entry.kind}:${entry.id}:${entry.src}`;
    if (coverPrewarmInflight.has(key)) return;
    coverPrewarmInflight.add(key);
    try {
      await decodeCoverUrl(entry.src);
      if (entry.kind === "book") {
        pendingStableBookCoverSrc.set(entry.id, entry.src);
        sessionStableBookCoverSrc.set(entry.id, entry.src);
      } else {
        pendingStableNovelCoverSrc.set(entry.id, entry.src);
        sessionStableNovelCoverSrc.set(entry.id, entry.src);
      }
      scheduleCoverFlush();
    } finally {
      coverPrewarmInflight.delete(key);
    }
  }

  function scheduleNextCoverPrewarmBatch() {
    if (coverPrewarmHandle !== null || coverPrewarmQueue.length === 0) return;

    const run = () => {
      coverPrewarmHandle = null;
      coverPrewarmUsesIdleCallback = false;
      if (isScrolling) {
        scheduleNextCoverPrewarmBatch();
        return;
      }
      const batch = coverPrewarmQueue.splice(0, 4);
      for (const entry of batch) void prewarmCover(entry);
      scheduleNextCoverPrewarmBatch();
    };

    if (
      typeof window !== "undefined"
      && typeof window.requestIdleCallback === "function"
    ) {
      coverPrewarmUsesIdleCallback = true;
      coverPrewarmHandle = window.requestIdleCallback(run, { timeout: 300 });
      return;
    }

    coverPrewarmUsesIdleCallback = false;
    coverPrewarmHandle = setTimeout(run, 32);
  }

  function scheduleCoverPrewarm(entries: Array<{ id: string; src: string; kind: "book" | "novel" }>) {
    coverPrewarmQueue = entries;
    clearCoverPrewarmSchedule();
    scheduleNextCoverPrewarmBatch();
  }

  function handleVisibleRangeChange(startIndex: number, endIndex: number) {
    if (prewarmStartIndex === startIndex && prewarmEndIndex === endIndex) return;
    prewarmStartIndex = startIndex;
    prewarmEndIndex = endIndex;
  }

  function handleContentScroll() {
    if (!active || !contentEl) return;
    isScrolling = true;
    pendingScrollTop = contentEl.scrollTop;

    if (scrollIdleTimer !== null) clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => {
      scrollIdleTimer = null;
      isScrolling = false;
    }, 160);

    if (Math.abs(pendingScrollTop - store.libraryScrollTop) < 24) return;
    if (scrollPersistTimer !== null) clearTimeout(scrollPersistTimer);
    scrollPersistTimer = setTimeout(() => {
      scrollPersistTimer = null;
      setLibraryScrollTop(pendingScrollTop);
    }, 180);
  }

  $effect(() => {
    if (!active || !contentEl) return;
    contentWidth = contentEl.clientWidth;
  });

  $effect(() => {
    if (!active) {
      coverPrewarmQueue = [];
      clearCoverPrewarmSchedule();
      return;
    }

    const prewarmLimit = Math.max(1, renderLimit || 48);
    const visibleEnd = Math.max(prewarmEndIndex, Math.min(totalCardCount, prewarmLimit));
    const entries: Array<{ id: string; src: string; kind: "book" | "novel" }> = [];
    for (let index = prewarmStartIndex; index < visibleEnd; index += 1) {
      const card = getRawCardAt(index);
      if (!card.coverSrc) continue;
      if (card.id.startsWith("novel-card:")) {
        if (stableNovelCoverSrc.get(card.id) === card.coverSrc) continue;
        entries.push({ id: card.id, src: card.coverSrc, kind: "novel" });
      } else {
        if (stableBookCoverSrc.get(card.id) === card.coverSrc) continue;
        entries.push({ id: card.id, src: card.coverSrc, kind: "book" });
      }
    }
    scheduleCoverPrewarm(entries);
  });

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
      if (scrollPersistTimer !== null) {
        clearTimeout(scrollPersistTimer);
        scrollPersistTimer = null;
        setLibraryScrollTop(pendingScrollTop);
      }
      if (scrollIdleTimer !== null) {
        clearTimeout(scrollIdleTimer);
        scrollIdleTimer = null;
      }
      coverPrewarmQueue = [];
      pendingStableBookCoverSrc.clear();
      pendingStableNovelCoverSrc.clear();
      coverPrewarmInflight.clear();
      if (coverFlushTimer !== null) {
        clearTimeout(coverFlushTimer);
        coverFlushTimer = null;
      }
      clearCoverPrewarmSchedule();
      resizeObserver?.disconnect();
      unlisten?.();
    };
  });
</script>

<div class="content" class:library-scroll-active={isScrolling} bind:this={contentEl} onscroll={handleContentScroll}>
  {#if totalCardCount === 0}
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
    <VirtualLibraryCardGrid
      itemCount={totalCardCount}
      getItem={getVisibleCardAt}
      getItemId={getCardIdAt}
      {viewMode}
      effectiveColumns={layout.effectiveColumns}
      scrollElement={contentEl}
      {showProgress}
      {showOutline}
      onOpen={(cardId) => openBook(cardId)}
      onContextMenu={openBookContext}
      onCoverLoad={handleCoverLoad}
      onCoverError={handleCoverError}
      onVisibleRangeChange={handleVisibleRangeChange}
      virtualizeAfter={lazyVirtualizeAfter}
    />
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
