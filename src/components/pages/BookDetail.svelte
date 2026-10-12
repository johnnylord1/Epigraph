<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import {
    ArrowsLeftRight,
    BookOpen,
    BookmarkSimple,
    CaretDown,
    ChartLineUp,
    CheckCircle,
    FolderSimplePlus,
    FunnelSimple,
    List,
    Play,
    SortAscending,
    SortDescending,
    SquaresFour,
    X,
  } from "phosphor-svelte";
  import {
    addToast,
    getBookProgress,
    openBookReader,
    removeBook,
    replaceBookProgress,
    setActiveBookId,
    setBookProgress,
    store,
    updateSettings,
    upsertBook,
  } from "../../store/state.svelte";
  import { _, translate as t } from "../../lib/i18n/runtime";
  import type { BooksCategory } from "../../store/state.svelte";
  import {
    getBookSectionCount,
    getBookSectionsSummary,
    findBookSectionIndex,
    resolveBookSectionLabel,
    resolveBookSectionProgress,
  } from "../../lib/books/summary";
  import type { BookEntry, BookProgress, BookSectionSummaryItem } from "../../lib/books/types";
  import { createPdfPageHref, parsePdfPageHref } from "../../lib/books/pdf";
  import { BookAssetResolver } from "../../lib/books/assets";
  import { getBookProgressPrecision, resolveBookResumeTarget, resolveEpubDisplayTarget } from "../../lib/books/progress";
  import {
    classifyBookRuntimeFailure,
    probeBookRuntimeSource,
    resolveBookRuntimeSource,
    type BookRuntimeProbeEvidence,
    type BookRuntimeRequestKind,
    type BookRuntimeStage,
  } from "../../lib/books/runtime";
  import { hasBookLocalAsset, MISSING_BOOK_ASSET_MESSAGE } from "../../lib/books/availability";
  import { presentBook } from "../../lib/books/presentation";
  import { mediaAuditEnabled, traceMediaAudit } from "../../lib/mediaAudit";
  import { peekPersistedBookEntry, peekPersistedBookProgress } from "../../lib/books/libraryState";
  import { removeBookAssets } from "../../lib/books/storage";
  import { createBooksCategory, sortBooksCategories, toggleBookCategoryAssignment } from "../../lib/library/domainCategories";
  import NocturneState from "../shared/NocturneState.svelte";
  import NovelTrackingPanel from "../shared/NovelTrackingPanel.svelte";
  import SeriesDetailV3Shell from "../shared/SeriesDetailV3Shell.svelte";
  import BookToNovelModal from "./BookToNovelModal.svelte";
  import { getServerAuthHeader } from "../../lib/client";
  import { requiresAuthenticatedMediaFetch } from "../../lib/imageCache";

  const SECTIONS_PER_PAGE = 25;
  let epubFactoryPromise: Promise<typeof import("epubjs").default> | null = null;

  function loadEpubFactory() {
    epubFactoryPromise ??= import("epubjs").then((module) => module.default);
    return epubFactoryPromise;
  }

  type SectionFilter = "all" | "unread" | "read" | "bookmarked" | "current";
  type BookSectionView = BookSectionSummaryItem & {
    sectionNumber: number;
    progressPercent: number;
    pageNumber: number | null;
    isRead: boolean;
    isCurrent: boolean;
    isBookmarked: boolean;
  };

  let previewing = $state(false);
  let previewLoading = $state(false);
  let previewError: string | null = $state(null);
  let previewHost = $state<HTMLDivElement | null>(null);
  let currentBookRef: any = null;
  let currentRendition: any = null;
  let currentPreviewObjectUrl: string | null = null;
  let currentPreviewStage = $state<BookRuntimeStage>("idle");
  let currentPreviewSourceUrl = $state<string | null>(null);
  let currentPreviewProbe = $state<BookRuntimeProbeEvidence | null>(null);
  let sectionPage = $state(1);
  let detailsOpen = $state(false);
  let coverBroken = $state(false);
  let trackingOpen = $state(false);
  let novelCopyOpen = $state(false);
  let sectionSortDir: "asc" | "desc" = $state("asc");
  let sortMenuOpen = $state(false);
  let filterMenuOpen = $state(false);
  let folderPickerOpen = $state(false);
  let folderCreating = $state(false);
  let folderNewName = $state("");
  let folderPickerRef: HTMLDivElement | undefined = $state();
  let sectionFilter: SectionFilter = $state("all");
  let viewMode: "list" | "grid" = $state("list");
  const booksLibraryReady = $derived(store.booksLibraryHydrated);

  const activeBook = $derived(
    store.activeBookId
      ? store.books.find((book) => book.id === store.activeBookId)
        ?? peekPersistedBookEntry(store.activeBookId)
      : null,
  );
  const activeProgress = $derived(
    activeBook
      ? getBookProgress(activeBook.id) ?? peekPersistedBookProgress(activeBook.id)
      : null,
  );
  const activePresentation = $derived(activeBook ? presentBook(activeBook, activeProgress) : null);
  const detailSections = $derived(activeBook ? getBookSectionsSummary(activeBook) : []);
  const readPercent = $derived(activePresentation?.readPercent ?? Math.max(0, Math.min(1, activeProgress?.progressPercent ?? 0)));
  const fallbackPdfSections = $derived.by(() => {
    if (!activeBook || activeBook.subtype !== "pdf" || detailSections.length > 0) return [];
    const pageCount = Math.max(1, activeBook.pageCount ?? activeProgress?.totalPages ?? 1);
    return Array.from({ length: pageCount }, (_, index) => {
      const pageNumber = index + 1;
      return {
        id: `pdf-page:${pageNumber}`,
        label: t("detail.pageNumber", { value: pageNumber }),
        href: createPdfPageHref(pageNumber),
        depth: 0,
      } satisfies BookSectionSummaryItem;
    });
  });
  const baseSections = $derived(detailSections.length > 0 ? detailSections : fallbackPdfSections);
  const totalSectionCount = $derived(activePresentation?.sectionCount ?? (activeBook ? getBookSectionCount(activeBook) : 0));
  const displaySectionCount = $derived(Math.max(totalSectionCount, baseSections.length));
  const readSectionCount = $derived(activePresentation?.readSectionCount ?? (
    displaySectionCount > 0 ? Math.min(displaySectionCount, Math.round(readPercent * displaySectionCount)) : 0
  ));
  const showProgress = $derived(activePresentation?.showProgress ?? (displaySectionCount > 0 || !!activeProgress));
  const usesPagesLabel = $derived(activeBook?.subtype === "pdf" && detailSections.length === 0);
  const previewHeading = $derived(previewing ? t("bookDetail.preview") : (usesPagesLabel ? t("bookDetail.pages") : t("detail.stats.chapters")));
  const coverSrc = $derived(activePresentation?.coverSrc ?? (activeBook ? BookAssetResolver.resolveCoverSrc(activeBook) : null));
  const bookFileAvailable = $derived(activeBook ? hasBookLocalAsset(activeBook) : false);
  const currentBookmark = $derived(activeBook ? store.bookBookmarks.find((bookmark) => bookmark.bookId === activeBook.id) ?? null : null);
  const currentEpubSectionIndex = $derived.by(() => {
    if (activeBook?.subtype !== "epub" || !baseSections.length) return -1;
    const hrefIndex = findBookSectionIndex(baseSections, activeProgress?.href);
    if (hrefIndex >= 0) return hrefIndex;
    if (activeProgress?.sectionLabel) {
      const labelIndex = baseSections.findIndex((item) => item.label === activeProgress.sectionLabel);
      if (labelIndex >= 0) return labelIndex;
    }
    if (typeof activeProgress?.progressPercent === "number" && activeProgress.progressPercent > 0) {
      return Math.max(0, Math.min(baseSections.length - 1, Math.floor(activeProgress.progressPercent * baseSections.length)));
    }
    return -1;
  });
  const bookmarkedEpubSectionIndex = $derived.by(() => {
    if (activeBook?.subtype !== "epub" || !baseSections.length) return -1;
    const hrefIndex = findBookSectionIndex(baseSections, currentBookmark?.href);
    if (hrefIndex >= 0) return hrefIndex;
    if (typeof currentBookmark?.progressPercent === "number" && currentBookmark.progressPercent > 0) {
      return Math.max(0, Math.min(baseSections.length - 1, Math.floor(currentBookmark.progressPercent * baseSections.length)));
    }
    return -1;
  });
  const sectionViews = $derived.by<BookSectionView[]>(() => {
    if (!activeBook) return [];
    const count = Math.max(1, baseSections.length);
    return baseSections.map((item, index) => {
      const pageNumber = activeBook.subtype === "pdf" ? parsePdfPageHref(item.href) : null;
      const progressPercent = activeBook.subtype === "pdf"
        ? (pageNumber && (activeBook.pageCount ?? activeProgress?.totalPages ?? 0) > 1
          ? (pageNumber - 1) / Math.max(1, (activeBook.pageCount ?? activeProgress?.totalPages ?? 1) - 1)
          : 0)
        : (count > 1 ? index / count : 0);
      const isCurrent = activeBook.subtype === "pdf"
        ? !!pageNumber && activeProgress?.pageIndex === pageNumber
        : currentEpubSectionIndex === index;
      const isBookmarked = activeBook.subtype === "pdf"
        ? !!pageNumber && currentBookmark?.pageIndex === pageNumber
        : bookmarkedEpubSectionIndex === index;
      const isRead = activeBook.subtype === "pdf"
        ? !!pageNumber && typeof activeProgress?.pageIndex === "number" && activeProgress.pageIndex >= pageNumber
        : index + 1 <= readSectionCount;
      return {
        ...item,
        sectionNumber: index + 1,
        progressPercent,
        pageNumber,
        isRead,
        isCurrent,
        isBookmarked,
      };
    });
  });
  const filteredSections = $derived.by(() => {
    const filtered = sectionViews.filter((item) => {
      if (sectionFilter === "read") return item.isRead;
      if (sectionFilter === "unread") return !item.isRead;
      if (sectionFilter === "bookmarked") return item.isBookmarked;
      if (sectionFilter === "current") return item.isCurrent;
      return true;
    });
    return [...filtered].sort((left, right) => sectionSortDir === "asc"
      ? left.sectionNumber - right.sectionNumber
      : right.sectionNumber - left.sectionNumber);
  });
  const totalSectionPages = $derived(Math.max(1, Math.ceil(filteredSections.length / SECTIONS_PER_PAGE)));
  const visibleSections = $derived(
    filteredSections.slice((sectionPage - 1) * SECTIONS_PER_PAGE, sectionPage * SECTIONS_PER_PAGE),
  );
  const currentSectionView = $derived(sectionViews.find((item) => item.isCurrent) ?? null);
  const allBookCategories = $derived(sortBooksCategories(store.settings.booksCategories ?? []));
  const assignedBookCategoryIds = $derived(activeBook ? store.settings.booksCategoryAssignments[activeBook.id] ?? [] : []);
  const assignedBookCategories = $derived(allBookCategories.filter((category) => assignedBookCategoryIds.includes(category.id)));
  const hasFolders = $derived(assignedBookCategories.length > 0);
  const primaryActionLabel = $derived.by(() => {
    if (previewLoading) return t("novelSources.loading.opening");
    if (!activeProgress) return t("detail.actions.startReading");
    if (currentSectionView) {
      if (usesPagesLabel) return t("bookDetail.continuePage", { page: currentSectionView.pageNumber ?? currentSectionView.sectionNumber });
      const title = sectionTitle(currentSectionView);
      const chapterMatch = title.match(/^chapter\s+(\d+(?:\.\d+)?)/i);
      return chapterMatch ? t("detail.actions.continueChapter", { chapter: chapterMatch[1], page: "" }) : t("bookDetail.continueSection", { section: title });
    }
    return t("bookDetail.continueReading");
  });

  function revokeObjectUrl(url: string | null | undefined) {
    if (!url?.startsWith("blob:")) return;
    URL.revokeObjectURL(url);
  }

  function tracePreview(event: string, payload: Record<string, unknown> = {}) {
    if (!activeBook) return;
    traceMediaAudit({
      event,
      bookId: activeBook.id,
      title: activeBook.title,
      subtype: activeBook.subtype,
      stage: currentPreviewStage,
      sourceUrl: currentPreviewSourceUrl,
      ...payload,
    });
  }

  function setPreviewStage(stage: BookRuntimeStage) {
    currentPreviewStage = stage;
  }

  function logPreviewFetchProbeEvent(
    phase: "started" | "succeeded" | "failed",
    requestKind: BookRuntimeRequestKind,
    payload: Record<string, unknown>,
  ) {
    tracePreview(`books.preview.fetch.${phase}`, {
      requestKind,
      ...payload,
    });
    setPreviewStage(phase === "failed" ? "fetch.failed" : phase === "succeeded" ? "fetch.succeeded" : "fetch.started");
  }

  let lastDetailAuditSignature = $state("");

  function auditDetailState(reason: string) {
    if (!activeBook || !activePresentation) return;
    const precision = getBookProgressPrecision(activeProgress);
    const signature = JSON.stringify({
      reason,
      bookId: activeBook.id,
      location: activeProgress?.location ?? null,
      href: activeProgress?.href ?? null,
      progressPercent: activeProgress?.progressPercent ?? 0,
      sectionLabel: activeProgress?.sectionLabel ?? null,
      precision,
      progressSummary: activePresentation.progressSummary,
      readPercentLabel: activePresentation.readPercentLabel,
    });
    if (signature === lastDetailAuditSignature) return;
    lastDetailAuditSignature = signature;
    tracePreview("books.detail.state", {
      reason,
      precision,
      location: activeProgress?.location ?? null,
      href: activeProgress?.href ?? null,
      progressPercent: activeProgress?.progressPercent ?? 0,
      sectionLabel: activeProgress?.sectionLabel ?? null,
      progressSummary: activePresentation.progressSummary,
      readPercentLabel: activePresentation.readPercentLabel,
      showProgress,
    });
  }

  function closeDetail() {
    closePreview();
    setActiveBookId(null);
  }

  function disposePreview() {
    try {
      currentRendition?.destroy?.();
    } catch {}
    try {
      currentBookRef?.destroy?.();
    } catch {}
    currentRendition = null;
    currentBookRef = null;
    revokeObjectUrl(currentPreviewObjectUrl);
    currentPreviewObjectUrl = null;
    if (previewHost) previewHost.innerHTML = "";
  }

  function goToSectionPage(nextPage: number) {
    sectionPage = Math.max(1, Math.min(totalSectionPages, nextPage));
  }

  function setSortDir(next: "asc" | "desc") {
    sectionSortDir = next;
    sectionPage = 1;
    sortMenuOpen = false;
  }

  function setFilter(next: SectionFilter) {
    sectionFilter = next;
    sectionPage = 1;
    filterMenuOpen = false;
  }

  function filterLabel(filter: SectionFilter) {
    if (filter === "read") return t("bookDetail.filter.read");
    if (filter === "unread") return t("detail.stats.unread");
    if (filter === "bookmarked") return t("bookDetail.filter.bookmarked");
    if (filter === "current") return t("bookDetail.filter.current");
    return t("bookDetail.filter.all");
  }

  function handleFolderOutside(event: MouseEvent) {
    if (folderPickerRef && !folderPickerRef.contains(event.target as Node)) {
      folderPickerOpen = false;
      folderCreating = false;
      folderNewName = "";
    }
  }

  function createFolder() {
    const name = folderNewName.trim();
    if (!activeBook || !name) return;
    const category = createBooksCategory(allBookCategories, name);
    updateSettings({
      booksCategories: sortBooksCategories([...allBookCategories, category]),
      booksCategoryAssignments: toggleBookCategoryAssignment(
        store.settings.booksCategoryAssignments,
        activeBook.id,
        category.id,
      ),
    });
    folderNewName = "";
    folderCreating = false;
  }

  function toggleFolder(category: BooksCategory) {
    if (!activeBook) return;
    updateSettings({
      booksCategoryAssignments: toggleBookCategoryAssignment(
        store.settings.booksCategoryAssignments,
        activeBook.id,
        category.id,
      ),
    });
  }

  function splitChapterLabel(label: string) {
    const normalized = label.trim().replace(/\s+/g, " ");
    const match = normalized.match(/^(chapter\s+\d+(?:\.\d+)?|chapters?\s+[ivxlcdm]+|prologue|epilogue|cover|information|appendix)(?:\s*[:\-–—]\s+(.+))$/i);
    if (!match) return { title: normalized, subtitle: "" };
    return {
      title: match[1] ?? normalized,
      subtitle: match[2]?.trim() ?? "",
    };
  }

  function sectionTitle(item: BookSectionView) {
    if (usesPagesLabel) return item.label;
    return splitChapterLabel(item.label).title;
  }

  function sectionSubtitle(item: BookSectionView) {
    if (usesPagesLabel) return t("bookDetail.pageNumber", { number: item.pageNumber ?? item.sectionNumber });
    return splitChapterLabel(item.label).subtitle;
  }

  function openBookSection(section: BookSectionView) {
    if (!activeBook || !bookFileAvailable) return;
    closePreview();
    const pageNumber = activeBook.subtype === "pdf" ? section.pageNumber : null;
    replaceBookProgress({
      bookId: activeBook.id,
      location: null,
      href: activeBook.subtype === "epub" ? section.href : null,
      progressPercent: section.progressPercent,
      lastReadAt: Date.now(),
      pageIndex: pageNumber,
      totalPages: activeBook.subtype === "pdf" ? activeBook.pageCount ?? activeProgress?.totalPages ?? null : null,
      sectionLabel: section.label,
      renderer: activeBook.subtype,
    });
    openBookReader(activeBook.id);
  }

  async function waitForPreviewHost() {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await tick();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      if (previewHost) return previewHost;
      const fallbackHost = document.querySelector(".preview-host");
      if (fallbackHost instanceof HTMLDivElement) {
        previewHost = fallbackHost;
        return fallbackHost;
      }
    }

    throw new Error("Preview surface is not ready.");
  }

  async function openPreview() {
    if (!activeBook) return;
    previewing = true;
    previewLoading = true;
    previewError = null;
    currentPreviewStage = "idle";
    currentPreviewSourceUrl = null;
    currentPreviewProbe = null;
    disposePreview();

    try {
      const host = await waitForPreviewHost();
      const source = resolveBookRuntimeSource(activeBook);
      currentPreviewSourceUrl = source.sourceUrl;
      setPreviewStage("source.resolved");
      tracePreview("books.preview.source.resolved", {
        origin: source.origin,
      });

      if (mediaAuditEnabled()) {
        currentPreviewProbe = await probeBookRuntimeSource(source, {
          expectRange: activeBook.subtype === "pdf",
          onEvent: ({ phase, requestKind, payload }) => {
            logPreviewFetchProbeEvent(phase, requestKind, {
              origin: source.origin,
              status: payload.status,
              headers: payload.headers,
              finalUrl: payload.finalUrl,
              error: payload.error,
            });
          },
        });
      }

      if (activeBook.subtype === "pdf") {
        setPreviewStage("pdf.open.started");
        tracePreview("books.preview.pdf.open.started", {
          origin: source.origin,
          classification: currentPreviewProbe?.classification ?? null,
        });
        const frame = document.createElement("iframe");
        frame.src = `${source.sourceUrl}#toolbar=0&navpanes=0`;
        frame.title = activeBook.title;
        frame.style.width = "100%";
        frame.style.height = "100%";
        frame.style.border = "0";
        host.innerHTML = "";
        host.appendChild(frame);
        tracePreview("books.preview.loaded", {
          renderer: "iframe",
        });
        return;
      }

      setPreviewStage("epub.open.started");
      tracePreview("books.preview.epub.open.started", {
        origin: source.origin,
        classification: currentPreviewProbe?.classification ?? null,
      });
      const ePub = await loadEpubFactory();
      const ePubOptions: any = {};
      if (requiresAuthenticatedMediaFetch(source.sourceUrl)) {
        const authHeader = getServerAuthHeader();
        if (authHeader) {
          ePubOptions.requestHeaders = {
            Authorization: authHeader,
          };
        }
      }
      const book = ePub(source.sourceUrl, ePubOptions);
      const rendition = book.renderTo(host, {
        width: "100%",
        height: "100%",
        flow: "paginated",
        spread: "none",
      });

      currentBookRef = book;
      currentRendition = rendition;

      rendition.on("relocated", (location: any) => {
        if (!activeBook) return;
        const start = location?.start ?? {};
        const precisePercent =
          typeof currentBookRef?.locations?.length === "function" &&
          typeof currentBookRef?.locations?.percentageFromCfi === "function" &&
          start.cfi
            ? currentBookRef.locations.percentageFromCfi(start.cfi)
            : null;
        const progress: BookProgress = {
          bookId: activeBook.id,
          location: start.cfi ?? null,
          href: start.href ?? null,
          progressPercent:
            typeof location?.percentage === "number"
              ? Math.max(0, Math.min(1, location.percentage))
              : typeof precisePercent === "number" && Number.isFinite(precisePercent)
                ? Math.max(0, Math.min(1, precisePercent))
                : resolveBookSectionProgress(detailSections, start.href ?? null),
          lastReadAt: Date.now(),
          sectionLabel: resolveBookSectionLabel(detailSections, start.href ?? null),
          renderer: "epub",
        };
        setBookProgress(progress);
      });

      await book.ready;
      setPreviewStage("epub.ready");
      tracePreview("books.preview.epub.ready");
      const targetLocation = resolveEpubDisplayTarget(book.spine, resolveBookResumeTarget(activeProgress));
      await rendition.display(targetLocation);
      setPreviewStage("epub.displayed");
      tracePreview("books.preview.epub.displayed", {
        restoredLocation: targetLocation ?? null,
      });
      void (async () => {
        try {
          setPreviewStage("epub.locations.started");
          tracePreview("books.preview.epub.locations.started");
          if (typeof book.locations?.pause === "number") {
            book.locations.pause = 0;
          }
          await book.locations.generate(1000);
          setPreviewStage("epub.locations.ready");
          tracePreview("books.preview.epub.locations.ready", {
            totalLocations: typeof book.locations?.length === "function" ? book.locations.length() : null,
          });
        } catch (locationError) {
          tracePreview("books.preview.error", {
            message: locationError instanceof Error ? locationError.message : "Could not generate EPUB locations.",
            classification: classifyBookRuntimeFailure(currentPreviewProbe, "epub.locations.ready", locationError),
          });
        }
      })();
      tracePreview("books.preview.loaded", {
        renderer: "epubjs",
        restoredLocation: targetLocation ?? null,
      });
    } catch (error) {
      disposePreview();
      previewError = error instanceof Error ? error.message : t("bookDetail.errors.couldNotOpen");
      tracePreview("books.preview.error", {
        message: previewError,
        classification: classifyBookRuntimeFailure(currentPreviewProbe, currentPreviewStage, error),
      });
    } finally {
      previewLoading = false;
    }
  }

  function openFullscreenReader() {
    if (!activeBook || !bookFileAvailable) return;
    closePreview();
    openBookReader(activeBook.id);
  }

  function closePreview() {
    previewing = false;
    previewLoading = false;
    previewError = null;
    disposePreview();
  }

  async function handleRemove() {
    if (!activeBook) return;
    const removed = activeBook;
    closeDetail();
    removeBook(removed.id);

    try {
      await removeBookAssets(removed.assetPath, removed.coverPath);
      addToast({
        kind: "info",
        title: t("ui_removedFromLibrary"),
        body: removed.title,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("bookDetail.removeFilesFailed");
      addToast({
        kind: "info",
        title: t("ui_removedFromLibrary"),
        body: `${removed.title} (${message})`,
      });
    }
  }

  function updateBookHardcoverLink(link: { hardcoverBookId: number | null; hardcoverCoverUrl: string | null }) {
    const book = activeBook;
    if (!book) return;
    const next: BookEntry = {
      ...book,
      hardcoverBookId: link.hardcoverBookId,
      hardcoverCoverUrl: link.hardcoverCoverUrl,
      updatedAt: Date.now(),
    };
    upsertBook(next);
  }

  $effect(() => {
    activeBook?.id;
    sectionPage = 1;
    detailsOpen = false;
    coverBroken = false;
    trackingOpen = false;
    sortMenuOpen = false;
    filterMenuOpen = false;
    folderPickerOpen = false;
    folderCreating = false;
    folderNewName = "";
    sectionFilter = "all";
    sectionSortDir = "asc";
    viewMode = "list";
    untrack(() => {
      closePreview();
    });
  });

  $effect(() => {
    if (sectionPage > totalSectionPages) sectionPage = totalSectionPages;
    if (sectionPage < 1) sectionPage = 1;
  });

  $effect(() => {
    if (folderPickerOpen) {
      setTimeout(() => document.addEventListener("mousedown", handleFolderOutside, true), 0);
    } else {
      document.removeEventListener("mousedown", handleFolderOutside, true);
    }
    return () => document.removeEventListener("mousedown", handleFolderOutside, true);
  });

  $effect(() => {
    if (!store.activeBookId) {
      untrack(() => {
        closePreview();
      });
    }
  });

  $effect(() => {
    if (!activeBook || !activePresentation) return;
    activeBook.id;
    activeProgress?.location;
    activeProgress?.href;
    activeProgress?.progressPercent;
    activeProgress?.sectionLabel;
    activePresentation.progressSummary;
    activePresentation.readPercentLabel;
    showProgress;
    untrack(() => {
      auditDetailState("state.changed");
    });
  });

  onDestroy(() => {
    disposePreview();
  });
</script>

{#if activeBook}
  <SeriesDetailV3Shell
    mediaKind="novel"
    title={activePresentation?.title ?? activeBook.title}
    subtitle={activePresentation?.authorLabel ?? activeBook.author ?? $_("bookDetail.unknownAuthor")}
    coverUrl={coverSrc && !coverBroken ? coverSrc : null}
    fallbackLabel={activePresentation?.subtypeLabel ?? activeBook.subtype.toUpperCase()}
    statusLabel={activePresentation?.subtypeLabel ?? activeBook.subtype.toUpperCase()}
    sourceLabel={$_("common.books")}
    sourceLine={`${$_("common.books")} - ${activePresentation?.subtypeLabel ?? activeBook.subtype.toUpperCase()}`}
    description={activePresentation?.description ?? activeBook.description}
    tags={[activeBook.subtype === "pdf" ? "PDF" : "EPUB"]}
    detailsOpen={detailsOpen}
    progressLabel={showProgress ? (activePresentation?.progressSummary ?? $_("bookDetail.progressRead", { read: readSectionCount, total: displaySectionCount })) : null}
    progressPercent={readPercent * 100}
    metrics={[
      { label: usesPagesLabel ? $_("bookDetail.pages") : $_("detail.stats.chapters"), value: String(displaySectionCount) },
      { label: $_("detail.stats.unread"), value: String(Math.max(0, displaySectionCount - readSectionCount)) },
      { label: $_("bookDetail.filter.bookmarks"), value: String(currentBookmark ? 1 : 0) },
    ]}
    onBack={closeDetail}
    onDetailsToggle={() => detailsOpen = !detailsOpen}
  >
    {#snippet primaryAction()}
      <button class="series-primary" onclick={openFullscreenReader} disabled={previewLoading || !bookFileAvailable}>
        <Play size={13} weight="fill" />
        {#if !bookFileAvailable}
          {$_("bookDetail.fileMissing")}
        {:else}
          {primaryActionLabel}
        {/if}
      </button>
    {/snippet}

    {#snippet secondaryActions()}
      <button class="series-action series-icon-action active" type="button" onclick={handleRemove} title={$_("bookDetail.removeFromLibrary")} aria-label={$_("bookDetail.removeFromLibrary")}>
        <BookmarkSimple size={13} weight="fill" />
      </button>
      <button class="series-action series-icon-action" type="button" onclick={() => trackingOpen = true} title={$_("detail.actions.tracking")} aria-label={$_("detail.actions.tracking")}>
        <ChartLineUp size={13} weight="light" />
      </button>
    {/snippet}

    {#snippet utilityActions()}
      <div class="fp-wrap" bind:this={folderPickerRef}>
        <button class="series-utility" class:active={hasFolders} type="button" onclick={() => folderPickerOpen = !folderPickerOpen} title={$_("detail.actions.folders")}>
          <FolderSimplePlus size={14} weight={hasFolders ? "fill" : "light"} />
          {$_("detail.actions.folder")}
        </button>
        {#if folderPickerOpen}
          <div class="fp-menu">
            {#if allBookCategories.length === 0 && !folderCreating}
              <NocturneState layout="compact" tone="info" icon="folder" eyebrow={$_("detail.actions.folders")} title={$_("detail.folders.emptyTitle")} body={$_("bookDetail.folders.emptyBody")} />
            {/if}
            {#each allBookCategories as category (category.id)}
              {@const isIn = assignedBookCategoryIds.includes(category.id)}
              <button class="fp-item" class:fp-item-active={isIn} type="button" onclick={() => toggleFolder(category)}>
                <span class="fp-check" aria-hidden="true">{isIn ? "✓" : ""}</span>
                {category.name}
              </button>
            {/each}
            <div class="fp-div"></div>
            {#if folderCreating}
              <div class="fp-create">
                <input
                  class="fp-input"
                  placeholder={$_("detail.folders.namePlaceholder")}
                  bind:value={folderNewName}
                  onkeydown={(event) => {
                    if (event.key === "Enter") createFolder();
                    if (event.key === "Escape") {
                      folderCreating = false;
                      folderNewName = "";
                    }
                  }}
                />
                <button class="fp-confirm" type="button" onclick={createFolder} disabled={!folderNewName.trim()}>{$_("detail.folders.add")}</button>
                <button class="fp-cancel" type="button" onclick={() => { folderCreating = false; folderNewName = ""; }} aria-label={$_("detail.folders.cancelCreation")}>
                  <X size={12} weight="light" />
                </button>
              </div>
            {:else}
              <button class="fp-new" type="button" onclick={() => folderCreating = true}>{$_("detail.folders.new")}</button>
            {/if}
          </div>
        {/if}
      </div>
      <button class="series-utility" type="button" onclick={() => novelCopyOpen = true} title={$_("bookToNovel_actionTitle")} aria-label={$_("bookToNovel_actionTitle")} data-book-to-novel-open>
        <ArrowsLeftRight size={14} weight="light" />
        {$_("bookToNovel_action")}
      </button>
    {/snippet}

    {#snippet detailsExtra()}
      <div class="v3-details-stack">
        <div class="detail-row"><span class="detail-key">{$_("bookDetail.type")}</span><span class="detail-val">{activePresentation?.subtypeLabel ?? activeBook.subtype.toUpperCase()}</span></div>
        <div class="detail-row"><span class="detail-key">{usesPagesLabel ? $_("bookDetail.pages") : $_("detail.stats.chapters")}</span><span class="detail-val">{displaySectionCount}</span></div>
        {#if hasFolders}<div class="detail-row"><span class="detail-key">{$_("detail.actions.folders")}</span><span class="detail-val">{assignedBookCategories.map((category) => category.name).join(", ")}</span></div>{/if}
        {#if activeBook.subtype === "pdf"}<div class="detail-row"><span class="detail-key">{$_("bookDetail.pages")}</span><span class="detail-val">{activePresentation?.pageCountLabel ?? $_("bookDetail.pageCount", { count: activeBook.pageCount ?? 0 })}</span></div>{/if}
        {#if activeBook.subtype === "epub"}<div class="detail-row"><span class="detail-key">{$_("bookDetail.spineItems")}</span><span class="detail-val">{activeBook.spineCount ?? activeBook.spine?.length ?? 0}</span></div>{/if}
        {#if activeProgress}<div class="detail-row"><span class="detail-key">{$_("bookDetail.lastProgress")}</span><span class="detail-val">{activePresentation?.progressSummary ?? `${Math.round(readPercent * 100)}%`}</span></div>{/if}
        <div class="detail-file">
          <span class="detail-key">{$_("bookDetail.sourceFile")}</span>
          <p class="detail-path">{activeBook.importPath || $_("bookDetail.metadataOnlyRestore")}</p>
        </div>
      </div>
    {/snippet}

    {#snippet chapterControls()}
      <div class="list-header-left">
        {#if !bookFileAvailable}<span class="sort-meta">{MISSING_BOOK_ASSET_MESSAGE}</span>{/if}
        {#if !previewing && sectionViews.length > 0}
          <div class="sort-wrap">
            <button class="series-toolbar-btn" type="button" onclick={() => { sortMenuOpen = !sortMenuOpen; filterMenuOpen = false; }}>
              {#if sectionSortDir === "desc"}<SortDescending size={14} weight="light" />{:else}<SortAscending size={14} weight="light" />{/if}
              {$_("library.sort")}
              <CaretDown size={10} weight="light" />
            </button>
            {#if sortMenuOpen}
              <div class="sort-menu" role="presentation" onmouseleave={() => sortMenuOpen = false}>
                <p class="sort-section-label">{usesPagesLabel ? $_("bookDetail.pageOrder") : $_("bookDetail.chapterOrder")}</p>
                <button class="sort-option" class:active={sectionSortDir === "asc"} onclick={() => setSortDir("asc")}>{$_("library.sort.ascending")}</button>
                <button class="sort-option" class:active={sectionSortDir === "desc"} onclick={() => setSortDir("desc")}>{$_("library.sort.descending")}</button>
              </div>
            {/if}
          </div>
          <div class="sort-wrap">
            <button class="series-toolbar-btn" class:active={sectionFilter !== "all"} type="button" onclick={() => { filterMenuOpen = !filterMenuOpen; sortMenuOpen = false; }}>
              <FunnelSimple size={14} weight={sectionFilter !== "all" ? "fill" : "light"} />
              {filterLabel(sectionFilter)}
              <CaretDown size={10} weight="light" />
            </button>
            {#if filterMenuOpen}
              <div class="sort-menu" role="presentation" onmouseleave={() => filterMenuOpen = false}>
                <p class="sort-section-label">{$_("library.filter")}</p>
                <button class="sort-option" class:active={sectionFilter === "all"} onclick={() => setFilter("all")}>{usesPagesLabel ? $_("bookDetail.allPages") : $_("bookDetail.allChapters")}</button>
                <button class="sort-option" class:active={sectionFilter === "unread"} onclick={() => setFilter("unread")}>{$_("detail.stats.unread")}</button>
                <button class="sort-option" class:active={sectionFilter === "read"} onclick={() => setFilter("read")}>{$_("bookDetail.filter.read")}</button>
                <button class="sort-option" class:active={sectionFilter === "bookmarked"} onclick={() => setFilter("bookmarked")}>{$_("bookDetail.filter.bookmarked")}</button>
                <button class="sort-option" class:active={sectionFilter === "current"} onclick={() => setFilter("current")}>{$_("bookDetail.filter.current")}</button>
              </div>
            {/if}
          </div>
        {/if}
      </div>
      <div class="list-header-right">
        {#if !previewing && sectionViews.length > 0}
          <div class="view-segmented" aria-label={$_("bookDetail.sectionView", { section: previewHeading })}>
            <button class="series-icon" class:active={viewMode === "list"} onclick={() => viewMode = "list"} title={$_("detail.view.list")}><List size={14} weight="light" /></button>
            <button class="series-icon" class:active={viewMode === "grid"} onclick={() => viewMode = "grid"} title={$_("detail.view.grid")}><SquaresFour size={14} weight="light" /></button>
          </div>
        {/if}
      </div>
    {/snippet}

    {#snippet chapterList()}
      {#if previewing}
        {#if previewError}
          <NocturneState
            layout="compact"
            tone="danger"
            icon="info"
            eyebrow={$_("bookDetail.readerPreview")}
            title={$_("bookDetail.errors.couldNotOpen")}
            body={previewError}
          />
        {:else}
          <div class="preview-frame" class:is-loading={previewLoading}>
            <div class="preview-host" bind:this={previewHost}></div>
            {#if previewLoading}
              <div class="preview-loading">{$_("bookDetail.openingType", { type: activePresentation?.subtypeLabel ?? activeBook.subtype.toUpperCase() })}</div>
            {/if}
          </div>
        {/if}
      {:else if sectionViews.length > 0 && filteredSections.length === 0}
        <NocturneState layout="compact" tone="info" icon="search" eyebrow={usesPagesLabel ? $_("bookDetail.pages") : $_("detail.stats.chapters")} title={usesPagesLabel ? $_("bookDetail.empty.noPagesMatch") : $_("bookDetail.empty.noChaptersMatch")} body={$_("bookDetail.empty.tryAnotherStatusFilter")} />
      {:else if filteredSections.length > 0}
        <div class={viewMode === "grid" ? "ch-grid v3-ch-grid" : "ch-list v3-ch-list"}>
          {#if viewMode === "grid"}
            {#each filteredSections as item (item.id)}
              <button class="grid-cell book-grid-cell" class:read={item.isRead} class:in-progress={item.isCurrent} onclick={() => openBookSection(item)} title={item.label}>
                <span class="grid-cell-title">{sectionTitle(item)}</span>
                {#if sectionSubtitle(item)}<span class="grid-cell-sub">{sectionSubtitle(item)}</span>{/if}
                <span class="chapter-progress" class:is-empty={!item.isRead}><span class="chapter-progress__fill" style={`width: ${item.isRead ? 100 : 0}%`}></span></span>
                {#if item.isCurrent}<span class="grid-cell-mark" title={$_("bookDetail.filter.current")}></span>{/if}
                {#if item.isBookmarked}<span class="grid-cell-dot" title={$_("bookDetail.filter.bookmarked")}></span>{/if}
              </button>
            {/each}
          {:else}
            <div class="chapter-table-header">
              <span>{usesPagesLabel ? $_("bookDetail.page") : $_("detail.table.chapter")}</span>
              <span>{$_("bookDetail.type")}</span>
              <span>{activeBook.subtype === "pdf" ? $_("bookDetail.position") : $_("bookDetail.depth")}</span>
              <span>{$_("detail.table.status")}</span>
            </div>
            {#each visibleSections as item (item.id)}
              <button class="ch-row v3-ch-row" class:read={item.isRead} class:ch-selected={item.isCurrent} style={`--toc-depth:${item.depth};`} onclick={() => openBookSection(item)}>
                <div class="ch-left">
                  <span class="ch-title">
                    <span class="ch-name">{sectionTitle(item)}</span>
                    {#if item.isBookmarked}<span class="ch-bookmark" role="img" title={$_("bookDetail.filter.bookmarked")} aria-label={$_("bookDetail.filter.bookmarked")}><BookmarkSimple size={12} weight="fill" /></span>{/if}
                  </span>
                  <div class="ch-meta">
                    {#if sectionSubtitle(item)}<span class="ch-meta-item">{sectionSubtitle(item)}</span>{/if}
                    {#if item.isCurrent}<span class="ch-meta-item">{$_("bookDetail.filter.current")}</span>{/if}
                    {#if item.depth > 0}<span class="ch-meta-item">{$_("bookDetail.depthValue", { depth: item.depth })}</span>{/if}
                  </div>
                  <div class="chapter-progress" class:is-empty={!item.isRead}><div class="chapter-progress__fill" style={`width: ${item.isRead ? 100 : 0}%`}></div></div>
                </div>
                <span class="ch-provider">{activePresentation?.subtypeLabel ?? activeBook.subtype.toUpperCase()}</span>
                <span class="ch-date">{activeBook.subtype === "pdf" && item.pageNumber ? `${Math.round(item.progressPercent * 100)}%` : (item.depth > 0 ? $_("bookDetail.depthValue", { depth: item.depth }) : "")}</span>
                <div class="ch-status" class:ch-status-read-row={item.isRead}>
                  <span class="ch-status-read">{#if item.isRead}<CheckCircle size={14} weight="fill" class="read-icon" />{/if}</span>
                  <span class="ch-status-main">
                    {#if item.isCurrent}
                      <BookOpen size={14} weight="fill" class="read-icon" title={$_("bookDetail.filter.current")} />
                    {/if}
                  </span>
                  <span class="ch-status-action"></span>
                </div>
              </button>
            {/each}
          {/if}
        </div>
      {:else}
        <NocturneState
          layout="compact"
          tone="info"
          icon="books"
          eyebrow={$_("bookDetail.contents")}
          title={$_("bookDetail.empty.noReadableSections")}
          body={activeBook.subtype === "pdf" ? $_("bookDetail.empty.pdfNoReadablePages") : $_("bookDetail.empty.epubNoReadableMetadata")}
        />
      {/if}
    {/snippet}

    {#snippet chapterFooter()}
      {#if !previewing && viewMode === "list" && filteredSections.length > 0 && totalSectionPages > 1}
        <div class="pagination-bottom v3-pagination">
          <button class="series-page-btn" onclick={() => goToSectionPage(sectionPage - 1)} disabled={sectionPage === 1}>{$_("library.pagination.prev")}</button>
          <span class="page-num">{sectionPage} / {totalSectionPages}</span>
          <button class="series-page-btn" onclick={() => goToSectionPage(sectionPage + 1)} disabled={sectionPage === totalSectionPages}>{$_("library.pagination.next")}</button>
        </div>
      {/if}
    {/snippet}
  </SeriesDetailV3Shell>
  {#if novelCopyOpen}
    <BookToNovelModal book={activeBook} progress={activeProgress ?? null} coverSrc={coverSrc} onClose={() => novelCopyOpen = false} />
  {/if}
  {#if trackingOpen}
    <NovelTrackingPanel
      title={activePresentation?.title ?? activeBook.title}
      author={activeBook.author}
      libraryTitle={activeBook.title}
      sourceNovelId={activeBook.id}
      contentLabel={t("bookDetail.contentLabel")}
      onHardcoverLinkChanged={updateBookHardcoverLink}
      onClose={() => trackingOpen = false}
    />
  {/if}
{:else if store.activeBookId && !booksLibraryReady}
  <div class="root root--loading">
    <div class="loading-shell">
      <BookOpen size={28} weight="duotone" />
      <p>{$_("ui_loadingBookLibrary")}</p>
    </div>
  </div>
{:else if store.activeBookId}
  <div class="root root--missing">
    <div class="loading-shell">
      <BookOpen size={28} weight="duotone" />
      <p>{$_("ui_bookCouldNotBeResolvedYet")}</p>
    </div>
  </div>
{/if}

<style>
  .grid-cell-mark,
  .grid-cell-dot {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 5px;
    height: 5px;
    border-radius: var(--component-detail-grid-cell-dot-border-radius);
    background: var(--component-detail-grid-cell-dot-background);
  }

  .grid-cell-dot {
    right: 18px;
    opacity: var(--component-detail-grid-cell-dot-opacity);
  }

  .root {
    display: flex;
    height: 100%;
    overflow: hidden;
    animation: fadeIn 0.14s ease both;
  }

  .root--loading,
  .root--missing {
    align-items: center;
    justify-content: center;
    background: var(--bg-base);
  }

  .loading-shell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-3);
    color: var(--text-muted);
    font-size: var(--text-sm);
    letter-spacing: 0;
    text-transform: none;
  }

  .detail-file {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    padding-top: var(--sp-1);
  }

  .detail-path {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    line-height: var(--leading-base);
    word-break: break-all;
  }

  .ch-left {
    padding-left: calc(var(--toc-depth, 0) * 12px);
  }

  .preview-loading {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: var(--text-sm);
    padding: var(--sp-5);
    text-align: center;
  }

  .preview-frame {
    position: relative;
    flex: 1;
    overflow: hidden;
    background: var(--component-detail-preview-frame-background);
  }

  .preview-host {
    position: absolute;
    inset: 0;
  }

  .preview-frame.is-loading .preview-host {
    opacity: var(--component-detail-preview-frame-is-loading-preview-host-opacity);
  }

  @keyframes fadeIn {
    from { opacity: var(--component-detail-keyframes-fadein-from-opacity); }
    to { opacity: var(--component-detail-to-opacity); }
  }

  @media (max-width: 980px) {
    .root {
      flex-direction: column;
    }
  }
</style>
