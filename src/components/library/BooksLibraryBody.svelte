<script lang="ts" module>
  const sessionStableBookCoverSrc = new Map<string, string>();
  const sessionStableNovelCoverSrc = new Map<string, string>();
</script>

<script lang="ts">
  import { _, translate } from "../../lib/i18n/runtime";
  import { onMount, type ComponentProps } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { Folder, FolderSimplePlus, UploadSimple } from "phosphor-svelte";
  import { addToast, setActiveBookId, setLibraryScrollTop, store, updateSettings, upsertBook } from "../../store/state.svelte";
  import { hasBookLocalAsset, MISSING_BOOK_ASSET_MESSAGE } from "../../lib/books/availability";
  import { BookAssetResolver } from "../../lib/books/assets";
  import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
  import { BOOK_IMPORT_EXTENSIONS, importLocalBookFile, isSupportedBookImportPath } from "../../lib/books/importFile";
  import type { BookEntry, BookProgress } from "../../lib/books/types";
  import { isBookFinished } from "../../lib/books/progress";
  import { presentBookWithCoverSrc } from "../../lib/books/presentation";
  import { getBookSectionCount } from "../../lib/books/summary";
  import { createBookLibraryCardId } from "../../lib/library/cardIdentity";
  import {
    createBooksCategory,
    isBookAssignedToCategory,
    sortBooksCategories,
    toggleBookCategoryAssignment,
  } from "../../lib/library/domainCategories";
  import { computeLibraryLayout, measureListViewportHeight, type LibraryPreferredGridColumns, type LibraryViewMode } from "../../lib/libraryDisplay";
  import type { BooksSectionVM, LibraryCardVM } from "../../lib/library/contracts";
  import {
    buildNovelShelfCard,
    type NovelShelfCard,
    type NovelShelfCardContext,
  } from "../../lib/novels/libraryShelf";
  import type { PersistedNovelLibraryEntry } from "../../lib/novels/domain";
  import ContextMenu from "../shared/ContextMenu.svelte";
  import NocturneState from "../shared/NocturneState.svelte";
  import VirtualLibraryCardGrid from "./VirtualLibraryCardGrid.svelte";

  type MenuEntry = ComponentProps<typeof ContextMenu>["items"][number];

  type Props = {
    vm: BooksSectionVM;
    active?: boolean;
    books: BookEntry[];
    totalBooks: number;
    renderLimit?: number;
    viewKey: string;
    viewMode?: LibraryViewMode;
    preferredColumns?: LibraryPreferredGridColumns;
    showProgress?: boolean;
    showOutline?: boolean;
    novelEntries?: PersistedNovelLibraryEntry[];
    novelCardContext?: NovelShelfCardContext;
    onOpenNovel?: (novelId: string) => void;
    /** True when search, status, genre or shelf filters hide titles that exist. */
    filtersActive?: boolean;
    onClearFilters?: () => void;
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
    filtersActive = false,
    onClearFilters,
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
  let contentHeight = $state(0);
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
  const lazyVirtualizeAfter = 48;

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
    if (isBookFinished(progress)) return chapterCount;
    // Only chapters wholly behind the reader count; a PDF is one chapter, so page 2 of 3 is not done.
    const pct = Math.max(0, Math.min(1, progress?.progressPercent ?? 0));
    return Math.max(0, Math.min(chapterCount - 1, Math.floor(pct * chapterCount)));
  }

  function formatBookFileSource(book: BookEntry): string {
    return book.subtype.toUpperCase();
  }

  function buildBookWorkStatus(hasLocalAsset: boolean, isReadFinished: boolean, hasStarted: boolean): string {
    if (!hasLocalAsset) return "Missing file";
    if (isReadFinished) return "Finished";
    return hasStarted ? "In progress" : "Not started";
  }

  const totalCardCount = $derived(books.length + novelEntries.length);
  const layout = $derived(
    computeLibraryLayout({
      availableWidth: contentWidth,
      availableHeight: contentHeight,
      preferredColumns,
      mode: viewMode,
    }),
  );

  function syncContentWidth() {
    if (!contentEl) return;
    const nextWidth = contentEl.clientWidth;
    if (nextWidth > 0 && nextWidth !== contentWidth) contentWidth = nextWidth;
    const nextHeight = measureListViewportHeight(contentEl);
    if (nextHeight > 0 && nextHeight !== contentHeight) contentHeight = nextHeight;
  }

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
      ? [{ kind: "status" as const, label: translate("ui_missingFile") }]
      : [];
    const metaChips = [buildBookWorkStatus(hasLocalAsset, readCount >= chapterCount && chapterCount > 0, (progress?.progressPercent ?? 0) > 0 || (progress?.lastReadAt ?? 0) > 0)];
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
            secondaryLabel: chapterCount > 0 ? translate("library.card.ofChapters", { count: chapterCount }) : undefined,
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
    return path.split(/[\\/]/).pop() ?? translate("library.import.fallbackName");
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
        ? translate("library.import.updatedTitle", { type: entry.subtype.toUpperCase() })
        : translate("library.import.importedTitle", { type: entry.subtype.toUpperCase() }),
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
        title: translate("ui_noSupportedBooksDetected"),
        body: translate("ui_dropEpubOrPdfFilesIntoTheBooks"),
      });
      return;
    }

    if (skipped.length) {
      addToast({
        kind: "info",
        title: translate("ui_someFilesWereSkipped"),
        body: translate("ui_onlyEpubAndPdfFilesCanBeImported"),
      });
    }

    importingDrop = true;
    try {
      for (const path of supported) {
        try {
          await importBookFile(path);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : translate("library.import.failedBody", { file: fileBasename(path) });
          addToast({
            kind: "error",
            title: translate("library.import.failedTitle", { file: fileBasename(path) }),
            body: message,
          });
        }
      }
    } finally {
      importingDrop = false;
    }
  }

  /** Imports books chosen in the system file picker, for people who do not drag files in. */
  export async function pickBooksToImport() {
    if (importingDrop) return;
    const picked = await openFileDialog({
      multiple: true,
      directory: false,
      filters: [{ name: translate("library.import.pickerFilter"), extensions: [...BOOK_IMPORT_EXTENSIONS] }],
    });
    const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
    if (paths.length) await importDroppedPaths(paths);
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
        title: translate("bookDetail_fileMissing"),
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
    const name = prompt(translate("library.category.namePrompt"));
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
        label: assigned
          ? translate("library.category.removeFrom", { name: category.name })
          : translate("library.category.addTo", { name: category.name }),
        icon: Folder,
        onClick: () => toggleCategory(book, category.id),
      };
    });

    return [
      ...categoryItems,
      ...(categoryItems.length ? ([{ separator: true } as MenuEntry]) : []),
      {
        label: translate("ui_newCategory"),
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
    contentHeight = measureListViewportHeight(contentEl);
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
      if (!card) continue;
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

  $effect(() => {
    const el = contentEl;
    if (!active || !el) return;

    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(syncContentWidth);

    syncContentWidth();
    resizeObserver?.observe(el);
    window.addEventListener("resize", syncContentWidth, { passive: true });
    window.visualViewport?.addEventListener("resize", syncContentWidth, { passive: true });
    firstFrame = requestAnimationFrame(() => {
      firstFrame = null;
      syncContentWidth();
      secondFrame = requestAnimationFrame(() => {
        secondFrame = null;
        syncContentWidth();
      });
    });

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncContentWidth);
      window.visualViewport?.removeEventListener("resize", syncContentWidth);
      if (firstFrame !== null) cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
  });

  onMount(() => {
    let unlisten: (() => void) | undefined;

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

    syncContentWidth();
    queueMicrotask(() => {
      if (contentEl) {
        syncContentWidth();
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
      unlisten?.();
    };
  });
</script>

<div class="content" class:library-scroll-active={isScrolling} bind:this={contentEl} onscroll={handleContentScroll}>
  {#if totalCardCount === 0 && filtersActive && onClearFilters}
    <div class="center books-empty" data-library-empty="filtered">
      <NocturneState
        layout="open"
        tone="info"
        icon="search"
        eyebrow={$_("library.eyebrow")}
        title={$_("library_empty_noMatchesTitle")}
        body={vm.emptyMessage}
        actions={[{ label: $_("library_empty_clear"), kind: "primary", onClick: onClearFilters }]}
      />
    </div>
  {:else if totalCardCount === 0}
    <div class="center books-empty" data-library-empty="shelf">
      <NocturneState
        layout="open"
        tone="info"
        icon="books"
        eyebrow={$_("library.eyebrow")}
        title={$_("ui_noBooksHereYet")}
        body={vm.emptyMessage}
        actions={vm.dragDropEnabled
          ? [{ label: $_("library.import.pick"), kind: "primary", icon: "books", disabled: importingDrop, onClick: () => void pickBooksToImport() }]
          : []}
      />
    </div>
  {:else}
    <VirtualLibraryCardGrid
      itemCount={totalCardCount}
      getItem={getVisibleCardAt}
      getItemId={getCardIdAt}
      {viewMode}
      effectiveColumns={layout.effectiveColumns}
      listRowHeight={layout.listRowHeight}
      scrollElement={contentEl}
      {showProgress}
      {showOutline}
      onOpen={(cardId) => openBook(cardId)}
      onContextMenu={openBookContext}
      onCoverLoad={handleCoverLoad}
      onCoverError={handleCoverError}
      onVisibleRangeChange={handleVisibleRangeChange}
      virtualizeAfter={lazyVirtualizeAfter}
      {active}
      panelMotionEnabled={!isScrolling}
    />
  {/if}

  {#if vm.dragDropEnabled && (dropActive || importingDrop)}
    <div class="book-drop-overlay" aria-hidden="true">
      <div class="book-drop-panel">
        <UploadSimple size={22} weight="bold" />
        <div class="book-drop-copy">
          <strong>{importingDrop ? $_("ui_importingBooks") : $_("ui_dropEpubOrPdfFilesHere")}</strong>
          <span>{importingDrop ? $_("ui_epigraphIsAddingThemToTheBooksShelf") : $_("ui_importedBooksStaySeparateFromComics")}</span>
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
    z-index: var(--component-library-panel-z-index);
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
    background: var(--component-library-drop-overlay-bg);
    backdrop-filter: var(--component-library-drop-overlay-blur);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--component-library-header-z-index);
  }

  .book-drop-panel {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-4) var(--sp-5);
    border: 1px solid var(--component-library-accent-border);
    border-radius: var(--radius-lg);
    background: var(--component-library-drop-panel-bg);
    box-shadow: var(--component-library-drop-panel-shadow);
    color: var(--component-library-accent-fg);
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
