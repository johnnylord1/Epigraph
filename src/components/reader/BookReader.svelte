<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import ePub from "epubjs";
  import * as pdfjsLib from "pdfjs-dist";
  import {
    ArrowLeft,
    ArrowRight,
    Bookmark,
    BookOpen,
    CircleNotch,
    MagnifyingGlassMinus,
    MagnifyingGlassPlus,
    X,
  } from "phosphor-svelte";
  import {
    configurePdfJsWorker,
    createPdfDocumentInit,
    resolvePdfSectionLabel,
  } from "../../lib/books/pdf";
  import {
    classifyBookRuntimeFailure,
    probeBookRuntimeSource,
    resolveBookRuntimeSource,
    type BookRuntimeProbeEvidence,
    type BookRuntimeRequestKind,
    type BookRuntimeStage,
  } from "../../lib/books/runtime";
  import {
    getBookSectionsSummary,
    resolveBookSectionHrefFromProgress,
    resolveBookSectionLabel,
    resolveBookSectionProgress,
  } from "../../lib/books/summary";
  import { resolveBookResumeTarget } from "../../lib/books/progress";
  import { hasBookLocalAsset, MISSING_BOOK_ASSET_MESSAGE } from "../../lib/books/availability";
  import { mediaAuditEnabled, traceMediaAudit } from "../../lib/mediaAudit";
  import type { BookBookmarkEntry, BookProgress } from "../../lib/books/types";
  import { peekPersistedBookEntry, peekPersistedBookProgress } from "../../lib/books/libraryState";
  import {
    addBookBookmark,
    closeBookReader,
    removeBookBookmark,
    setBookProgress,
    store,
    updateSettings,
  } from "../../store/state.svelte";
  import ReaderHud from "./ReaderHud.svelte";

  configurePdfJsWorker(pdfjsLib);

  const ZOOM_STEP = 0.1;
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 4;
  const MAX_PDF_CANVAS_PIXELS = 16_000_000;
  const activeBook = $derived(
    (store.activeBookReaderId && store.books.find((book) => book.id === store.activeBookReaderId))
    ?? (store.activeBookReaderId ? peekPersistedBookEntry(store.activeBookReaderId) : null),
  );
  const activeProgress = $derived(
    activeBook
      ? store.bookProgress.find((progress) => progress.bookId === activeBook.id)
        ?? peekPersistedBookProgress(activeBook.id)
      : null,
  );
  const booksLibraryReady = $derived(store.booksLibraryHydrated);
  const waitingForBookHydration = $derived(
    !!store.activeBookReaderId && !activeBook && !booksLibraryReady,
  );
  const currentBookmark = $derived(
    activeBook ? store.bookBookmarks.find((bookmark) => bookmark.bookId === activeBook.id) ?? null : null,
  );
  const isBookmarked = $derived(!!currentBookmark);
  const zoom = $derived(store.settings.readerZoom ?? 1);
  const zoomPct = $derived(Math.round(zoom * 100));
  const pdfSections = $derived(
    activeBook?.subtype === "pdf" ? getBookSectionsSummary(activeBook) : [],
  );
  const epubSections = $derived(
    activeBook?.subtype === "epub" ? getBookSectionsSummary(activeBook) : [],
  );

  let hostEl: HTMLDivElement | null = $state(null);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let loading = $state(false);
  let error: string | null = $state(null);
  let uiVisible = $state(true);
  let zoomOpen = $state(false);
  let pageNumber = $state(1);
  let totalPages = $state(1);
  let progressPercent = $state(0);
  let currentLocation: string | null = $state(null);
  let currentHref: string | null = $state(null);
  let currentSectionLabel: string | null = $state(null);
  let canPrev = $state(false);
  let canNext = $state(false);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let loadToken = 0;
  let currentBookRef: any = null;
  let currentRendition: any = null;
  let currentPdfDoc: any = null;
  let pdfRenderTask: any = null;
  let pendingPdfPage = false;
  let auditOpenBookId: string | null = null;
  let auditCloseSent = false;
  let currentStage: BookRuntimeStage = $state("idle");
  let currentSourceUrl: string | null = $state(null);
  let currentProbe: BookRuntimeProbeEvidence | null = $state(null);

  const progressLabel = $derived.by(() => {
    if (!activeBook) return "";
    if (activeBook.subtype === "pdf") return `${pageNumber} / ${totalPages || 1}`;
    return `${Math.max(0, Math.min(100, Math.round(progressPercent * 100)))}%`;
  });

  const sliderMax = $derived(activeBook?.subtype === "pdf" ? Math.max(1, totalPages) : 100);
  const sliderValue = $derived(activeBook?.subtype === "pdf" ? pageNumber : Math.max(1, Math.min(100, Math.round(progressPercent * 100))));
  const sliderPct = $derived(sliderMax > 1 ? ((sliderValue - 1) / (sliderMax - 1)) * 100 : 0);
  const bookmarkPct = $derived.by(() => {
    if (!currentBookmark) return 0;
    if (activeBook?.subtype === "pdf" && currentBookmark.pageIndex && totalPages > 1) {
      return ((currentBookmark.pageIndex - 1) / (totalPages - 1)) * 100;
    }
    return Math.max(0, Math.min(100, currentBookmark.progressPercent * 100));
  });

  function clampZoom(value: number) {
    return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 100) / 100;
  }

  function resolveEpubApproxProgress(href: string | null | undefined) {
    return resolveBookSectionProgress(epubSections, href);
  }

  function resolveEpubHrefFromPercentage(pct: number) {
    return resolveBookSectionHrefFromProgress(epubSections, pct);
  }

  function auditReader(event: string, payload: Record<string, unknown> = {}) {
    if (!activeBook) return;
    traceMediaAudit({
      event,
      bookId: activeBook.id,
      title: activeBook.title,
      subtype: activeBook.subtype,
      renderer: activeBook.subtype,
      pageNumber,
      totalPages,
      progressPercent,
      sectionLabel: currentSectionLabel,
      bookmarked: isBookmarked,
      ...payload,
    });
  }

  function showUi() {
    uiVisible = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      uiVisible = false;
    }, 3000);
  }

  function disposeReader() {
    try {
      pdfRenderTask?.cancel?.();
    } catch {}
    try {
      currentRendition?.destroy?.();
    } catch {}
    try {
      currentBookRef?.destroy?.();
    } catch {}
    try {
      currentPdfDoc?.destroy?.();
    } catch {}
    pdfRenderTask = null;
    currentRendition = null;
    currentBookRef = null;
    currentPdfDoc = null;
    if (hostEl) hostEl.innerHTML = "";
  }

  function setStage(stage: BookRuntimeStage) {
    currentStage = stage;
  }

  function logFetchProbeEvent(
    phase: "started" | "succeeded" | "failed",
    requestKind: BookRuntimeRequestKind,
    payload: Record<string, unknown>,
  ) {
    auditReader(`books.reader.fetch.${phase}`, {
      stage: phase === "failed" ? "fetch.failed" : phase === "succeeded" ? "fetch.succeeded" : "fetch.started",
      requestKind,
      sourceUrl: currentSourceUrl,
      ...payload,
    });
    setStage(phase === "failed" ? "fetch.failed" : phase === "succeeded" ? "fetch.succeeded" : "fetch.started");
  }

  function persistProgress(patch: Partial<BookProgress>) {
    if (!activeBook) return;
    setBookProgress({
      bookId: activeBook.id,
      location: currentLocation,
      href: currentHref,
      progressPercent,
      lastReadAt: Date.now(),
      pageIndex: activeBook.subtype === "pdf" ? pageNumber : null,
      totalPages: activeBook.subtype === "pdf" ? totalPages : null,
      sectionLabel: currentSectionLabel,
      renderer: activeBook.subtype,
      ...patch,
    });
    auditReader("books.reader.progress", {
      location: patch.location ?? currentLocation,
      href: patch.href ?? currentHref,
      pageIndex: patch.pageIndex ?? (activeBook.subtype === "pdf" ? pageNumber : null),
    });
  }

  function updateEpubProgress(location: any) {
    if (!activeBook) return;
    const start = location?.start ?? {};
    currentLocation = start.cfi ?? null;
    currentHref = start.href ?? null;
    currentSectionLabel = resolveBookSectionLabel(epubSections, currentHref);

    const percentage =
      typeof location?.percentage === "number"
        ? location.percentage
        : currentBookRef?.locations && currentLocation && currentBookRef.locations.length()
          ? currentBookRef.locations.percentageFromCfi(currentLocation)
          : resolveEpubApproxProgress(currentHref);

    progressPercent = Math.max(0, Math.min(1, percentage || 0));
    pageNumber = Math.max(1, Math.min(100, Math.round(progressPercent * 100)));
    totalPages = 100;
    canPrev = progressPercent > 0.001;
    canNext = progressPercent < 0.999;
    persistProgress({
      location: currentLocation,
      href: currentHref,
      progressPercent,
      pageIndex: null,
      totalPages: null,
      sectionLabel: currentSectionLabel,
      renderer: "epub",
    });
  }

  async function generateEpubLocationsInBackground(book: any, token: number, sourceUrl: string) {
    try {
      setStage("epub.locations.started");
      auditReader("books.reader.epub.locations.started", {
        stage: currentStage,
        sourceUrl,
      });
      if (typeof book.locations?.pause === "number") {
        book.locations.pause = 0;
      }
      await book.locations.generate(1000);
      if (token !== loadToken || currentBookRef !== book) return;
      setStage("epub.locations.ready");
      auditReader("books.reader.epub.locations.ready", {
        stage: currentStage,
        sourceUrl,
        totalLocations: typeof book.locations?.length === "function" ? book.locations.length() : null,
      });
      if (currentLocation && typeof book.locations?.percentageFromCfi === "function") {
        progressPercent = Math.max(0, Math.min(1, book.locations.percentageFromCfi(currentLocation) || 0));
        pageNumber = Math.max(1, Math.min(100, Math.round(progressPercent * 100)));
        persistProgress({
          location: currentLocation,
          href: currentHref,
          progressPercent,
          pageIndex: null,
          totalPages: null,
          sectionLabel: currentSectionLabel,
          renderer: "epub",
        });
      }
    } catch (err) {
      if (token !== loadToken || currentBookRef !== book) return;
      auditReader("books.reader.error", {
        message: err instanceof Error ? err.message : "Could not generate EPUB locations.",
        stage: "epub.locations.ready",
        sourceUrl,
        classification: classifyBookRuntimeFailure(currentProbe, "epub.locations.ready", err),
      });
    }
  }

  async function loadEpub(token: number) {
    if (!activeBook || !hostEl) return;
    const source = resolveBookRuntimeSource(activeBook);
    const sourceUrl = source.sourceUrl;
    if (token !== loadToken || activeBook.subtype !== "epub") return;
    currentSourceUrl = sourceUrl;
    currentProbe = null;
    setStage("source.resolved");
    auditReader("books.reader.source.resolved", {
      stage: currentStage,
      origin: source.origin,
      sourceUrl,
    });

    if (mediaAuditEnabled()) {
      currentProbe = await probeBookRuntimeSource(source, {
        expectRange: false,
        onEvent: ({ phase, requestKind, payload }) => {
          logFetchProbeEvent(phase, requestKind, {
            origin: source.origin,
            sourceUrl,
            status: payload.status,
            headers: payload.headers,
            finalUrl: payload.finalUrl,
            error: payload.error,
          });
        },
      });
    }

    setStage("epub.open.started");
    auditReader("books.reader.epub.open.started", {
      stage: currentStage,
      origin: source.origin,
      sourceUrl,
      classification: currentProbe?.classification ?? null,
    });
    const book = ePub(sourceUrl);
    const rendition = book.renderTo(hostEl, {
      width: "100%",
      height: "100%",
      flow: "paginated",
      spread: "none",
    });

    currentBookRef = book;
    currentRendition = rendition;
    rendition.themes.default({
      body: {
        "font-family": "Georgia, serif",
        "line-height": "1.7",
      },
    });
    rendition.themes.fontSize(`${zoomPct}%`);
    rendition.on("relocated", updateEpubProgress);

    await book.ready;
    setStage("epub.ready");
    auditReader("books.reader.epub.ready", {
      stage: currentStage,
      sourceUrl,
    });
    const target = resolveBookResumeTarget(activeProgress) ?? undefined;
    if (target) await rendition.display(target);
    else await rendition.display();
    setStage("epub.displayed");
    auditReader("books.reader.epub.displayed", {
      stage: currentStage,
      restoredLocation: target ?? null,
      sourceUrl,
    });
    void generateEpubLocationsInBackground(book, token, sourceUrl);
    auditReader("books.reader.loaded", {
      engine: "epubjs",
      restoredLocation: target ?? null,
    });
  }

  async function renderPdfPage(nextPage = pageNumber) {
    if (!currentPdfDoc || !canvasEl || !activeBook) return;
    if (pdfRenderTask) {
      pendingPdfPage = true;
      try {
        pdfRenderTask.cancel();
      } catch {}
      return;
    }

    const page = await currentPdfDoc.getPage(nextPage);
    const canvas = canvasEl;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const baseScale = Math.max(0.1, zoom) * 1.5;
    const baseViewport = page.getViewport({ scale: baseScale });
    const dpr = window.devicePixelRatio || 1;
    const pixelRatio = dpr * dpr;
    const requestedPixels = baseViewport.width * baseViewport.height * pixelRatio;
    const pixelClamp = requestedPixels > MAX_PDF_CANVAS_PIXELS
      ? Math.sqrt(MAX_PDF_CANVAS_PIXELS / requestedPixels)
      : 1;
    const viewport = page.getViewport({ scale: baseScale * pixelClamp });
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    pdfRenderTask = page.render({ canvasContext: ctx, viewport });
    try {
      await pdfRenderTask.promise;
    } catch (err: any) {
      if (err?.name !== "RenderingCancelledException") throw err;
    } finally {
      pdfRenderTask = null;
      if (pendingPdfPage) {
        pendingPdfPage = false;
        await renderPdfPage(pageNumber);
      }
    }

    progressPercent = totalPages > 1 ? (pageNumber - 1) / (totalPages - 1) : 1;
    currentLocation = null;
    currentHref = null;
    currentSectionLabel = resolvePdfSectionLabel(pdfSections, pageNumber);
    canPrev = pageNumber > 1;
    canNext = pageNumber < totalPages;
    setStage("pdf.page.rendered");
    auditReader("books.reader.pdf.page.rendered", {
      stage: currentStage,
      sourceUrl: currentSourceUrl,
      pageNumber,
      totalPages,
      sectionLabel: currentSectionLabel,
    });
    persistProgress({
      location: null,
      href: null,
      progressPercent,
      pageIndex: pageNumber,
      totalPages,
      sectionLabel: currentSectionLabel,
      renderer: "pdf",
    });
  }

  async function loadPdf(token: number) {
    if (!activeBook) return;
    const source = resolveBookRuntimeSource(activeBook);
    const sourceUrl = source.sourceUrl;
    if (token !== loadToken || activeBook.subtype !== "pdf") return;
    currentSourceUrl = sourceUrl;
    currentProbe = null;
    setStage("source.resolved");
    auditReader("books.reader.source.resolved", {
      stage: currentStage,
      origin: source.origin,
      sourceUrl,
    });

    if (mediaAuditEnabled()) {
      currentProbe = await probeBookRuntimeSource(source, {
        expectRange: true,
        onEvent: ({ phase, requestKind, payload }) => {
          logFetchProbeEvent(phase, requestKind, {
            origin: source.origin,
            sourceUrl,
            status: payload.status,
            headers: payload.headers,
            finalUrl: payload.finalUrl,
            error: payload.error,
          });
        },
      });
    }

    setStage("pdf.open.started");
    auditReader("books.reader.pdf.open.started", {
      stage: currentStage,
      origin: source.origin,
      sourceUrl,
      classification: currentProbe?.classification ?? null,
    });
    const pdf = await pdfjsLib.getDocument(createPdfDocumentInit(sourceUrl)).promise;
    if (token !== loadToken) {
      await pdf.destroy();
      return;
    }

    currentPdfDoc = pdf;
    setStage("pdf.ready");
    auditReader("books.reader.pdf.ready", {
      stage: currentStage,
      sourceUrl,
      totalPages: pdf.numPages || 1,
    });
    totalPages = pdf.numPages || 1;
    pageNumber = Math.max(1, Math.min(totalPages, activeProgress?.pageIndex ?? 1));
    await tick();
    await renderPdfPage(pageNumber);
    auditReader("books.reader.loaded", {
      engine: "pdfjs-dist",
      restoredPageIndex: pageNumber,
      totalPages,
    });
  }

  async function loadActiveBook() {
    const book = activeBook;
    if (!book) return;
    const token = ++loadToken;
    loading = true;
    error = null;
    currentStage = "idle";
    currentSourceUrl = null;
    currentProbe = null;
    pageNumber = 1;
    totalPages = 1;
    progressPercent = 0;
    currentLocation = null;
    currentHref = null;
    currentSectionLabel = null;
    canPrev = false;
    canNext = false;
    disposeReader();
    await tick();

    if (!hasBookLocalAsset(book)) {
      if (token === loadToken) {
        error = MISSING_BOOK_ASSET_MESSAGE;
        auditReader("books.reader.error", {
          message: error,
          stage: "idle",
          sourceUrl: null,
          classification: null,
        });
        loading = false;
      }
      return;
    }

    try {
      if (book.subtype === "epub") await loadEpub(token);
      else await loadPdf(token);
    } catch (err) {
      if (token === loadToken) {
        error = err instanceof Error ? err.message : "Could not open this book.";
        auditReader("books.reader.error", {
          message: error,
          stage: currentStage,
          sourceUrl: currentSourceUrl,
          classification: classifyBookRuntimeFailure(currentProbe, currentStage, err),
        });
      }
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  function goPrev() {
    if (!activeBook || loading) return;
    if (activeBook.subtype === "epub") {
      void currentRendition?.prev?.();
      return;
    }
    if (pageNumber > 1) {
      pageNumber -= 1;
      void renderPdfPage(pageNumber);
    }
  }

  function goNext() {
    if (!activeBook || loading) return;
    if (activeBook.subtype === "epub") {
      void currentRendition?.next?.();
      return;
    }
    if (pageNumber < totalPages) {
      pageNumber += 1;
      void renderPdfPage(pageNumber);
    }
  }

  function jumpToSliderValue(value: number) {
    if (!activeBook || loading) return;
    if (activeBook.subtype === "epub") {
      const pct = Math.max(0, Math.min(1, value / 100));
      const cfi = currentBookRef?.locations?.length?.() ? currentBookRef?.locations?.cfiFromPercentage?.(pct) : null;
      if (cfi) {
        void currentRendition?.display?.(cfi);
        return;
      }
      const href = resolveEpubHrefFromPercentage(pct);
      if (href) void currentRendition?.display?.(href);
      return;
    }
    pageNumber = Math.max(1, Math.min(totalPages, value));
    void renderPdfPage(pageNumber);
  }

  function adjustZoom(delta: number) {
    updateSettings({ readerZoom: clampZoom(zoom + delta) });
  }

  function resetZoom() {
    updateSettings({ readerZoom: 1 });
  }

  function toggleBookmark() {
    if (!activeBook) return;
    if (isBookmarked) {
      removeBookBookmark(activeBook.id);
      auditReader("books.reader.bookmark.removed");
      return;
    }

    const entry: Omit<BookBookmarkEntry, "savedAt"> = {
      bookId: activeBook.id,
      location: currentLocation,
      href: currentHref,
      pageIndex: activeBook.subtype === "pdf" ? pageNumber : null,
      progressPercent,
      label: currentSectionLabel ?? undefined,
    };
    addBookBookmark(entry);
    auditReader("books.reader.bookmark.added", {
      location: entry.location,
      href: entry.href,
      pageIndex: entry.pageIndex,
      label: entry.label ?? null,
    });
  }

  function requestClose(reason = "user") {
    if (!auditCloseSent) {
      auditReader("books.reader.closed", { reason });
      auditCloseSent = true;
    }
    closeBookReader();
  }

  function onKey(event: KeyboardEvent) {
    if ((event.target as HTMLElement)?.tagName === "INPUT") return;
    showUi();
    if (event.key === "Escape" || event.key === "Backspace") {
      event.preventDefault();
      requestClose("keyboard");
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      goPrev();
      return;
    }
    if (event.key === "ArrowRight" || event.key === " ") {
      event.preventDefault();
      goNext();
      return;
    }
    if (event.ctrlKey && (event.key === "=" || event.key === "+")) {
      event.preventDefault();
      adjustZoom(ZOOM_STEP);
      return;
    }
    if (event.ctrlKey && event.key === "-") {
      event.preventDefault();
      adjustZoom(-ZOOM_STEP);
      return;
    }
    if (event.ctrlKey && event.key === "0") {
      event.preventDefault();
      resetZoom();
      return;
    }
    if (event.key.toLowerCase() === "m") {
      event.preventDefault();
      toggleBookmark();
    }
  }

  $effect(() => {
    const book = activeBook;
    if (!book) return;
    if (auditOpenBookId !== book.id) {
      auditOpenBookId = book.id;
      auditCloseSent = false;
      traceMediaAudit({
        event: "books.reader.opened",
        bookId: book.id,
        title: book.title,
        subtype: book.subtype,
      });
    }
    if (book.subtype === "epub" && !hostEl) return;
    if (book.subtype === "pdf" && !canvasEl) return;
    untrack(() => {
      void loadActiveBook();
    });
  });

  $effect(() => {
    const book = activeBook;
    const rendition = currentRendition;
    const pdf = currentPdfDoc;
    const nextZoom = zoom;
    if (book?.subtype === "epub" && rendition) {
      rendition.themes.fontSize(`${Math.round(nextZoom * 100)}%`);
      return;
    }
    if (book?.subtype === "pdf" && pdf) {
      untrack(() => {
        void renderPdfPage(pageNumber);
      });
    }
  });

  $effect(() => {
    if (store.activeBookReaderId && !activeBook && booksLibraryReady) {
      requestClose("missing-book");
    }
  });

  onMount(() => {
    showUi();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (hideTimer) clearTimeout(hideTimer);
      disposeReader();
    };
  });

  onDestroy(() => {
    if (auditOpenBookId && !auditCloseSent) {
      auditReader("books.reader.closed", { reason: "destroy" });
      auditCloseSent = true;
    }
    ++loadToken;
    disposeReader();
  });
</script>

<ReaderHud
  overlayBars={false}
  {uiVisible}
  onMouseMove={(event) => { if (event.clientY < 60 || window.innerHeight - event.clientY < 60) showUi(); }}
>
  {#snippet topbarLeft()}
    <button class="icon-btn" onclick={() => requestClose("toolbar")} title="Close reader">
      <X size={15} weight="light" />
    </button>
    <span class="ch-label">
      <span class="ch-title">{activeBook?.title ?? "Book"}</span>
      <span class="ch-sep">/</span>
      <span>{currentSectionLabel ?? activeBook?.subtype.toUpperCase() ?? "BOOK"}</span>
    </span>
    <span class="page-label">{progressLabel}</span>
  {/snippet}

  {#snippet topbarRight()}
    <div class="top-sep"></div>
    <div class="zoom-wrap">
      <div class="zoom-inline">
        <button class="zoom-step-btn" onclick={() => adjustZoom(-ZOOM_STEP)} title="Zoom out" disabled={zoom <= ZOOM_MIN}>
          <MagnifyingGlassMinus size={13} weight="light" />
        </button>
        <button class="zoom-pct-btn" onclick={() => (zoomOpen = !zoomOpen)} title="Click to adjust zoom">
          {zoomPct}%
        </button>
        <button class="zoom-step-btn" onclick={() => adjustZoom(ZOOM_STEP)} title="Zoom in" disabled={zoom >= ZOOM_MAX}>
          <MagnifyingGlassPlus size={13} weight="light" />
        </button>
      </div>
      {#if zoomOpen}
        <div class="zoom-popover">
          <div class="zoom-slider-row">
            <input
              type="range"
              class="zoom-slider"
              min={50}
              max={400}
              step={10}
              value={zoomPct}
              oninput={(event) => updateSettings({ readerZoom: clampZoom(Number(event.currentTarget.value) / 100) })}
            />
          </div>
          <button class="zoom-reset" onclick={resetZoom} disabled={zoom === 1}>Reset</button>
        </div>
      {/if}
    </div>
    <button class="mode-btn" disabled>
      <BookOpen size={14} weight="light" />
      <span class="mode-label">{activeBook?.subtype ?? "book"}</span>
    </button>
    <button class="icon-btn" class:active={isBookmarked} onclick={toggleBookmark} title={isBookmarked ? "Remove bookmark" : "Bookmark this position"}>
      <Bookmark size={15} weight={isBookmarked ? "fill" : "regular"} />
    </button>
  {/snippet}

  <div class="viewer book-viewer" class:pdf={activeBook?.subtype === "pdf"}>
    {#if waitingForBookHydration}
      <div class="center-overlay">
        <CircleNotch size={20} weight="light" class="anim-spin" style="color:var(--text-faint)" />
      </div>
    {/if}

    {#if activeBook?.subtype === "epub"}
      <div class="epub-host" bind:this={hostEl}></div>
    {:else if activeBook?.subtype === "pdf"}
      <div class="pdf-stage">
        <canvas bind:this={canvasEl}></canvas>
      </div>
    {/if}

    {#if loading}
      <div class="center-overlay">
        <CircleNotch size={20} weight="light" class="anim-spin" style="color:var(--text-faint)" />
      </div>
    {/if}
    {#if error}
      <div class="center-overlay error-stack">
        <p class="error-msg">{error}</p>
      </div>
    {/if}
  </div>

  {#snippet bottombar()}
    <button class="nav-btn" onclick={goPrev} disabled={loading || !canPrev}>
      <ArrowLeft size={13} weight="light" />
    </button>

    <div
      class="slider-wrap"
      role="presentation"
    >
      <div class="slider-track-bg">
        <div class="slider-fill" style="width: {sliderPct}%"></div>
      </div>
      {#if isBookmarked && currentBookmark}
        <div
          class="slider-checkpoint bookmark-checkpoint"
          style="left: {bookmarkPct}%"
          title={activeBook?.subtype === "pdf" && currentBookmark.pageIndex ? `Bookmark: Page ${currentBookmark.pageIndex}` : "Bookmark"}
        ></div>
      {/if}
      <input
        type="range"
        class="slider-input"
        min={1}
        max={sliderMax}
        step={1}
        value={sliderValue}
        oninput={(event) => jumpToSliderValue(Number(event.currentTarget.value))}
        aria-label={activeBook?.subtype === "pdf" ? `Page ${pageNumber} of ${totalPages}` : `Progress ${sliderValue}%`}
      />
    </div>

    <button class="nav-btn" onclick={goNext} disabled={loading || !canNext}>
      <ArrowRight size={13} weight="light" />
    </button>
  {/snippet}
</ReaderHud>

<style>
  .book-viewer {
    flex: 1;
    overflow: auto;
    display: flex;
    align-items: stretch;
    justify-content: center;
    position: relative;
    background: var(--bg-void);
    color: var(--text-muted);
  }

  .book-viewer.pdf {
    align-items: flex-start;
    padding: var(--sp-5) 0;
  }

  .epub-host {
    width: min(920px, 100%);
    height: 100%;
    background: var(--bg-base);
    color: var(--text-primary);
  }

  .pdf-stage {
    display: flex;
    justify-content: center;
    min-width: 100%;
  }

  .pdf-stage canvas {
    display: block;
    background: #fff;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.48);
  }

  .center-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  .error-stack {
    flex-direction: column;
    gap: var(--sp-3);
    background: rgba(0, 0, 0, 0.72);
  }

  .error-msg {
    max-width: 70ch;
    color: var(--color-error);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    line-height: var(--leading-base);
    text-align: center;
  }
</style>
