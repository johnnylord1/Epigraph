<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import {
    ArrowLeft,
    ArrowRight,
    Bookmark,
    BookOpen,
    CircleNotch,
    MagnifyingGlassMinus,
    MagnifyingGlassPlus,
    SlidersHorizontal,
    X,
  } from "phosphor-svelte";
  import {
    configurePdfJsWorker,
    createPdfDocumentInit,
    resolvePdfSectionLabel,
  } from "../../lib/books/pdf";
  import {
    extractReflowedPage,
    getReflowElementKey,
    pruneReflowedPages,
    type ReflowedPage,
  } from "../../lib/books/pdfReflow";
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
  import type { BookBookmarkEntry, BookEntry, BookProgress, BookSectionSummaryItem } from "../../lib/books/types";
  import { peekPersistedBookEntry, peekPersistedBookProgress } from "../../lib/books/libraryState";
  import {
    addBookBookmark,
    closeBookReader,
    removeBookBookmark,
    setBookProgress,
    store,
    updateSettings,
  } from "../../store/state.svelte";
  import type { PdfFitMode } from "../../store/state.svelte";
  import { getServerAuthHeader, getServerUrl } from "../../lib/client";
  import { requiresAuthenticatedMediaFetch } from "../../lib/imageCache";
  import NocturneState from "../shared/NocturneState.svelte";
  import ReaderHud from "./ReaderHud.svelte";
  import { createDomTtsTextProvider, createTtsController } from "../../lib/reader/tts";
  import { clampReaderPage, selectDominantReaderPage, type VisibleReaderPage } from "../../lib/reader/runtime";
  import { setGenericReading, setTtsPresence } from "../../lib/discord";
  import { canResolveDiscordCover, canRunDiscordCoverImprovement } from "../../lib/discord/coverImprovementGate";
  import { isDiscordPublicImageUrl } from "../../lib/discord/coverResolver";
  import { discordCoverService, type DiscordCoverSource } from "../../lib/discord/discordCoverService";
  import { discordPublicCoverResolver } from "../../lib/discord/discordPublicCoverResolver";
  import { createOpenLibraryBookDiscordTrackerKey, resolveOpenLibraryBookDiscordCover } from "../../lib/discord/openLibraryCoverResolver";
  import { createHardcoverBookDiscordTrackerKey, resolveHardcoverBookDiscordCover } from "../../lib/discord/trackerCoverResolver";
  import { matchesKeybind, toggleFullscreen, DEFAULT_KEYBINDS } from "../../lib/keybinds";
  import { isReaderControlKeyboardTarget, registerReaderCommandHandler } from "../../lib/reader/commands";
  import TtsControls from "./TtsControls.svelte";
  import {
    DEFAULT_PROSE_READER_BACKGROUND_COLOR,
    DEFAULT_PROSE_READER_TEXT_COLOR,
    proseReaderThemeSwatch,
    resolveProseReaderPalette,
  } from "../../lib/reader/prosePalette";

  const ZOOM_STEP = 0.1;
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 4;
  const MAX_PDF_CANVAS_PIXELS = 16_000_000;
  let epubFactoryPromise: Promise<typeof import("epubjs").default> | null = null;
  let pdfJsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

  function loadEpubFactory() {
    epubFactoryPromise ??= import("epubjs").then((module) => module.default);
    return epubFactoryPromise;
  }

  async function loadPdfJs() {
    const pdfjsLib = await (pdfJsPromise ??= import("pdfjs-dist"));
    configurePdfJsWorker(pdfjsLib);
    return pdfjsLib;
  }

  const activeBook = $derived(
    store.activeBookReaderId
      ? store.books.find((book) => book.id === store.activeBookReaderId)
        ?? peekPersistedBookEntry(store.activeBookReaderId)
      : null,
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
  const proseTheme = $derived(store.settings.proseReaderTheme ?? "nocturne");
  const proseFontSize = $derived(store.settings.proseReaderFontSize ?? 18);
  const proseLineHeight = $derived(store.settings.proseReaderLineHeight ?? 1.75);
  const proseParagraphSpacing = $derived(store.settings.proseReaderParagraphSpacing ?? 1.1);
  const proseContentWidth = $derived(store.settings.proseReaderContentWidth ?? 760);
  const proseFontFamily = $derived(store.settings.proseReaderFontFamily || "Georgia, serif");
  const proseTextAlign = $derived(store.settings.proseReaderTextAlign ?? "left");
  const pdfFitMode = $derived(store.settings.pdfFitMode ?? "width");
  const pdfDarkMode = $derived(store.settings.pdfDarkMode ?? false);
  const pdfReflowMode = $derived(store.settings.pdfReflowMode ?? false);
  const pdfReflowCleanBackgrounds = $derived(store.settings.pdfReflowCleanBackgrounds ?? true);
  const pdfReflowIllustrationScale = $derived(store.settings.pdfReflowIllustrationScale ?? 1);
  const reflowPageNumbers = $derived.by(() => {
    const loaded = reflowedPages.map((entry) => entry.pageNumber);
    const loading = Array.from(reflowLoadingPages);
    return Array.from(new Set([...loaded, ...loading])).sort((left, right) => left - right);
  });
  const prosePalette = $derived.by(() => {
    const textColor: string = store.settings.proseReaderTextColor ?? DEFAULT_PROSE_READER_TEXT_COLOR;
    const backgroundColor: string = store.settings.proseReaderBackgroundColor ?? DEFAULT_PROSE_READER_BACKGROUND_COLOR;
    return resolveProseReaderPalette(
      proseTheme,
      textColor,
      backgroundColor,
    );
  });
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
  let toolsOpen = $state(true);
  let activeSubPanel = $state<"main" | "pdf" | "appearance" | "typography" | "layout" | "display" | "images" | "tts">("main");
  const tts = createTtsController();
  let ttsStateVersion = $state(0);
  let lastDiscordTtsPlaying = false;
  let lastDiscordBookId: string | null = null;
  let lastDiscordPrivacySignature: string | null = null;
  let hardcoverStateVersion = $state(0);
  let discordCoverBookId: string | null = null;
  let discordCoverLookupKey: string | null = null;
  let discordCoverLookupVersion = 0;
  let discordPublicCoverUrl: string | null = null;
  let pageNumber = $state(1);
  const REFLOWED_PAGE_RETAIN_RADIUS = 8;

  $effect(() => {
    const unsubscribe = tts.subscribe(() => {
      ttsStateVersion += 1;
    });
    return unsubscribe;
  });

  $effect(() => {
    const handleHardcoverStateChanged = () => {
      hardcoverStateVersion += 1;
    };
    globalThis.addEventListener?.("epigraph-hardcover-state-changed", handleHardcoverStateChanged);
    return () => {
      globalThis.removeEventListener?.("epigraph-hardcover-state-changed", handleHardcoverStateChanged);
    };
  });

  $effect(() => {
    hardcoverStateVersion;
    const bookId = activeBook?.id ?? null;
    const title = activeBook?.title;
    if (!store.settings.discordRpc || !bookId || !title) {
      lastDiscordBookId = bookId;
      lastDiscordPrivacySignature = null;
      return;
    }
    refreshDiscordCoverForBook(activeBook);
    const privacySignature = discordPrivacySignature();
    const reason = bookId !== lastDiscordBookId
      ? "work-change"
      : privacySignature !== lastDiscordPrivacySignature
        ? "privacy-change"
        : "progress";
    lastDiscordBookId = bookId;
    lastDiscordPrivacySignature = privacySignature;
    void setGenericReading(
      title,
      store.settings,
      reason,
      bookDiscordState(),
      discordPublicCoverUrl,
      bookDiscordProgressPercent(),
    );
  });

  $effect(() => {
    ttsStateVersion;
    const playing = tts.state.isPlaying;
    const title = activeBook?.title;
    if (store.settings.discordRpc && title && playing !== lastDiscordTtsPlaying) {
      void setTtsPresence(title, playing, store.settings, discordPublicCoverUrl);
    }
    lastDiscordTtsPlaying = playing;
  });

  function bookDiscordCoverSource(book: BookEntry): DiscordCoverSource | null {
    if (isDiscordPublicImageUrl(book.coverUrl)) return { type: "public-url", value: book.coverUrl };
    const coverPath = typeof book.coverPath === "string" ? book.coverPath.trim() : "";
    if (coverPath) return { type: "trusted-local-path", value: coverPath };
    return null;
  }

  function coverSourceKey(source: DiscordCoverSource | null): string | null {
    if (!source?.value) return null;
    return `${source.type}:${source.value}`;
  }

  function refreshDiscordCoverForBook(book: BookEntry) {
    const canShowCover = canResolveDiscordCover(store.settings);
    const shouldImproveCover = canRunDiscordCoverImprovement(store.settings);
    const fallbackCover = isDiscordPublicImageUrl(book.coverUrl) ? book.coverUrl : null;
    if (!canShowCover) {
      discordCoverLookupKey = null;
      discordPublicCoverUrl = null;
      return;
    }
    if (book.id !== discordCoverBookId) {
      discordCoverBookId = book.id;
      discordCoverLookupKey = null;
      discordPublicCoverUrl = fallbackCover;
      discordCoverLookupVersion += 1;
    }

    const source = bookDiscordCoverSource(book);
    const scopeInput = {
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl ?? getServerUrl(),
    };
    const trackerKey = [
      createHardcoverBookDiscordTrackerKey({ book, scopeInput }),
      createOpenLibraryBookDiscordTrackerKey(book),
      scopeInput.profileId ?? "",
      scopeInput.serverUrl ?? "",
    ].join(":");
    const key = [
      "tracker-first",
      fallbackCover ?? "",
      trackerKey,
      coverSourceKey(source) ?? "",
    ].join(":");
    if (discordCoverLookupKey === key) return;

    const lookupVersion = ++discordCoverLookupVersion;
    discordCoverLookupKey = key;
    void discordPublicCoverResolver.resolve({
      settings: store.settings,
      workKind: "book",
      workId: book.id,
      existingPublicCoverUrl: fallbackCover,
      trackerKey,
      resolveTrackerCover: async () => resolveHardcoverBookDiscordCover({
        book,
        scopeInput,
      }) ?? resolveOpenLibraryBookDiscordCover(book),
      workerSource: shouldImproveCover ? source : null,
      resolveWorkerCover: shouldImproveCover && source
        ? (candidate) => discordCoverService.resolveOptimizedCover({
            settings: store.settings,
            workKind: "book",
            workId: book.id,
            source: candidate,
          })
        : null,
    }).then((result) => {
      const coverUrl = result?.url ?? null;
      if (!coverUrl || lookupVersion !== discordCoverLookupVersion) return;
      if (activeBook?.id !== book.id || !canResolveDiscordCover(store.settings)) return;
      discordPublicCoverUrl = coverUrl;
      void setGenericReading(
        book.title,
        store.settings,
        "work-change",
        bookDiscordState(),
        coverUrl,
        bookDiscordProgressPercent(),
      );
      if (tts.state.isPlaying) void setTtsPresence(book.title, true, store.settings, coverUrl);
    });
  }

  $effect(() => {
    if (!toolsOpen) {
      activeSubPanel = "main";
    }
  });

  $effect(() => {
    const bookType = activeBook?.subtype;
    const reflow = pdfReflowMode;
    const loadedPageCount = reflowedPages.length;
    if (bookType === "pdf" && reflow && loadedPageCount > 0) {
      untrack(() => {
        void refreshPdfReflowTtsProvider();
      });
    } else if (bookType === "pdf") {
      untrack(() => tts.setProvider(null));
    }
  });
  let totalPages = $state(1);
  let progressPercent = $state(0);
  let currentLocation: string | null = $state(null);
  let currentHref: string | null = $state(null);
  let currentSectionLabel: string | null = $state(null);
  let canPrev = $state(false);
  let canNext = $state(false);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerInsideHud = false;
  let loadToken = 0;
  let currentBookRef: any = null;
  let currentRendition: any = null;
  let currentPdfDoc: any = null;
  let currentPdfJsLib: typeof import("pdfjs-dist") | null = null;
  let pdfRenderTask: any = null;
  let pdfDocumentGeneration = $state(0);
  let pendingPdfPage: number | null = null;
  let reflowedPages = $state<ReflowedPage[]>([]);
  let reflowLoadingPages = $state<Set<number>>(new Set());
  let suspendReflowProgressUntil = 0;
  let lastProgressSignature: string | null = null;
  let visiblePdfPages = new Map<number, VisibleReaderPage>();
  let visiblePdfProgressRafId: number | null = null;
  let reflowAnchorRafId: number | null = null;
  let resolveReflowAnchorFrame: (() => void) | null = null;
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
      return ((clampReaderPage(currentBookmark.pageIndex, totalPages) - 1) / (totalPages - 1)) * 100;
    }
    return Math.max(0, Math.min(100, currentBookmark.progressPercent * 100));
  });

  function discordPrivacySignature() {
    const settings = store.settings;
    return JSON.stringify({
      privateMode: settings.discordRpcPrivateMode,
      showCover: settings.discordRpcShowCover,
      improveCovers: settings.discordRpcImproveCovers,
      showProgress: settings.discordRpcShowProgress,
      showTitle: settings.discordRpcShowTitle,
    });
  }

  function isGenericDiscordBookLabel(value: string | null | undefined): boolean {
    const label = (value ?? "").trim().toLowerCase();
    return !label || label === "epub" || label === "pdf" || label === "cover" || label === "information" || label === "untitled";
  }

  function normalizeDiscordBookLabel(value: string | null | undefined): string | null {
    const label = (value ?? "").trim().replace(/\s+/g, " ");
    return isGenericDiscordBookLabel(label) ? null : label;
  }

  function resolveDiscordSectionFromProgress(sections: BookSectionSummaryItem[], progress: number): string | null {
    if (!sections.length) return null;
    const index = Math.max(0, Math.min(sections.length - 1, Math.round(progress * (sections.length - 1))));
    for (let i = index; i < sections.length; i += 1) {
      const label = normalizeDiscordBookLabel(sections[i]?.label);
      if (label) return label;
    }
    for (let i = index - 1; i >= 0; i -= 1) {
      const label = normalizeDiscordBookLabel(sections[i]?.label);
      if (label) return label;
    }
    return null;
  }

  function bookDiscordState(): string | undefined {
    if (!activeBook) return undefined;
    const persistedLabel = normalizeDiscordBookLabel(activeProgress?.sectionLabel);
    const currentLabel = normalizeDiscordBookLabel(currentSectionLabel);

    if (activeBook.subtype === "pdf") {
      const pageLabel = normalizeDiscordBookLabel(resolvePdfSectionLabel(pdfSections, pageNumber));
      const progressLabel = resolveDiscordSectionFromProgress(pdfSections, activeProgress?.progressPercent ?? progressPercent);
      return currentLabel ?? persistedLabel ?? pageLabel ?? progressLabel ?? `Chapter ${pageNumber}`;
    }

    const hrefLabel = normalizeDiscordBookLabel(resolveBookSectionLabel(epubSections, currentHref));
    const progressLabel = resolveDiscordSectionFromProgress(epubSections, activeProgress?.progressPercent ?? progressPercent);
    return currentLabel ?? persistedLabel ?? hrefLabel ?? progressLabel ?? "Chapter";
  }

  function bookDiscordProgressPercent(): number | undefined {
    if (!activeBook) return undefined;
    const sourceProgress = Number.isFinite(progressPercent) && progressPercent > 0
      ? progressPercent
      : activeProgress?.progressPercent ?? progressPercent;
    const percent = sourceProgress * 100;
    if (Number.isFinite(percent)) return percent;
    if (activeBook.subtype === "pdf" && totalPages > 1) return ((pageNumber - 1) / (totalPages - 1)) * 100;
    return undefined;
  }

  function clampZoom(value: number) {
    return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 100) / 100;
  }

  function resolveEpubApproxProgress(href: string | null | undefined) {
    return resolveBookSectionProgress(epubSections, href);
  }

  function resolveEpubHrefFromPercentage(pct: number) {
    return resolveBookSectionHrefFromProgress(epubSections, pct);
  }

  function applyEpubTheme() {
    const rendition = currentRendition;
    if (!rendition || activeBook?.subtype !== "epub") return;
    const epubLinkColor = getComputedStyle(document.documentElement)
      .getPropertyValue("--component-reader-core-epub-link-fg")
      .trim() || prosePalette.text;
    const themeCss = `
      html,
      body {
        background: ${prosePalette.surface} !important;
        color: ${prosePalette.text} !important;
        font-family: ${proseFontFamily} !important;
        font-size: ${proseFontSize}px !important;
        line-height: ${proseLineHeight} !important;
        text-align: ${proseTextAlign} !important;
      }

      body {
        padding: 0 1.6rem !important;
      }

      body,
      body * {
        color: ${prosePalette.text} !important;
        font-family: ${proseFontFamily} !important;
      }

      p,
      li,
      blockquote,
      div {
        font-family: ${proseFontFamily} !important;
        font-size: ${proseFontSize}px !important;
        line-height: ${proseLineHeight} !important;
      }

      p {
        margin-bottom: ${proseParagraphSpacing}em !important;
        text-align: ${proseTextAlign} !important;
      }

      a {
        color: ${epubLinkColor} !important;
      }
    `;
    rendition.themes.default({
      "html, body": {
        "background": prosePalette.surface,
        "color": prosePalette.text,
        "font-family": proseFontFamily,
        "font-size": `${proseFontSize}px`,
        "line-height": String(proseLineHeight),
        "text-align": proseTextAlign,
      },
      body: {
        "font-family": proseFontFamily,
        "font-size": `${proseFontSize}px`,
        "line-height": String(proseLineHeight),
        "text-align": proseTextAlign,
        "color": prosePalette.text,
        "background": prosePalette.surface,
        "padding": "0 1.6rem",
      },
      p: {
        "color": prosePalette.text,
        "margin-bottom": `${proseParagraphSpacing}em`,
      },
      a: {
        "color": epubLinkColor,
      },
    });
    rendition.themes.fontSize(`${zoomPct}%`);
    for (const content of rendition.getContents?.() ?? []) {
      const doc = content.document;
      if (!doc) continue;
      let style = doc.getElementById("epigraph-epub-reader-theme");
      if (!style) {
        style = doc.createElement("style");
        style.id = "epigraph-epub-reader-theme";
        doc.head.appendChild(style);
      }
      style.textContent = themeCss;
    }
  }

  function cycleProseTheme() {
    const themes = ["nocturne", "dark", "sepia", "light", "oled", "slate", "forest", "nord", "warm"] as const;
    const current = themes.findIndex((theme) => theme === proseTheme);
    updateSettings({ proseReaderTheme: themes[(current + 1) % themes.length] });
  }

  function updateFontSize(delta: number) {
    const patch = { proseReaderFontSize: Math.max(12, Math.min(32, proseFontSize + delta)) };
    if (activeBook?.subtype === "pdf" && pdfReflowMode) updateAnchoredReaderSettings(patch);
    else updateSettings(patch);
  }

  function updateLineHeight(delta: number) {
    const patch = { proseReaderLineHeight: Math.round(Math.max(1.2, Math.min(2.4, proseLineHeight + delta)) * 100) / 100 };
    if (activeBook?.subtype === "pdf" && pdfReflowMode) updateAnchoredReaderSettings(patch);
    else updateSettings(patch);
  }

  function updateContentWidth(delta: number) {
    const patch = { proseReaderContentWidth: Math.max(520, Math.min(1600, proseContentWidth + delta)) };
    if (activeBook?.subtype === "pdf" && pdfReflowMode) updateAnchoredReaderSettings(patch);
    else updateSettings(patch);
  }

  function updateIllustrationScale(delta: number) {
    updateAnchoredReaderSettings({
      pdfReflowIllustrationScale: Math.round(Math.max(0.5, Math.min(2, pdfReflowIllustrationScale + delta)) * 100) / 100,
    });
  }

  function updateProseColor(key: "text" | "background", value: string) {
    const patch: Partial<typeof store.settings> = key === "text"
      ? { proseReaderTheme: "nocturne", proseReaderTextColor: value }
      : { proseReaderTheme: "nocturne", proseReaderBackgroundColor: value };
    if (activeBook?.subtype === "pdf" && pdfReflowMode) updateAnchoredReaderSettings(patch);
    else updateSettings(patch);
  }

  function getReflowScrollAnchor() {
    if (!pdfReflowMode || activeBook?.subtype !== "pdf") return null;
    const viewer = document.querySelector(".book-viewer") as HTMLElement | null;
    if (!viewer) return null;
    const viewerRect = viewer.getBoundingClientRect();
    const elements = Array.from(document.querySelectorAll<HTMLElement>('.pdf-reflow-page [id^="pdf-page:"]'));
    const anchor = elements.find((element) => element.getBoundingClientRect().bottom > viewerRect.top + 96) ?? elements[0];
    if (!anchor) return null;
    return {
      id: anchor.id,
      offset: anchor.getBoundingClientRect().top - viewerRect.top,
      scrollTop: viewer.scrollTop,
    };
  }

  async function preserveReflowScroll(anchor: ReturnType<typeof getReflowScrollAnchor>) {
    if (!anchor) return;
    const token = loadToken;
    await tick();
    if (reflowAnchorRafId !== null) {
      cancelAnimationFrame(reflowAnchorRafId);
      resolveReflowAnchorFrame?.();
    }
    await new Promise<void>((resolve) => {
      resolveReflowAnchorFrame = resolve;
      reflowAnchorRafId = requestAnimationFrame(() => {
        reflowAnchorRafId = null;
        resolveReflowAnchorFrame = null;
        resolve();
      });
    });
    if (token !== loadToken) return;
    const viewer = document.querySelector(".book-viewer") as HTMLElement | null;
    const element = document.getElementById(anchor.id);
    if (!viewer || !element) return;
    const viewerTop = viewer.getBoundingClientRect().top;
    const nextOffset = element.getBoundingClientRect().top - viewerTop;
    viewer.scrollTop += nextOffset - anchor.offset;
    if (!Number.isFinite(viewer.scrollTop)) viewer.scrollTop = anchor.scrollTop;
  }

  function updateAnchoredReaderSettings(patch: Partial<typeof store.settings>) {
    const anchor = getReflowScrollAnchor();
    suspendReflowProgressUntil = Date.now() + 900;
    updateSettings(patch);
    void preserveReflowScroll(anchor);
  }

  function cyclePdfFit() {
    const modes = ["width", "page", "actual"] as const;
    const current = modes.indexOf(pdfFitMode as any);
    updateSettings({ pdfFitMode: modes[(current + 1) % modes.length] });
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
      if (pointerInsideHud || zoomOpen) {
        hideTimer = null;
        return;
      }
      uiVisible = false;
    }, 3000);
  }

  function keepHudVisible() {
    pointerInsideHud = true;
    uiVisible = true;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function releaseHudVisibility() {
    pointerInsideHud = false;
    showUi();
  }

  function disposeReader() {
    tts.stop();
    tts.setProvider(null);
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
    pendingPdfPage = null;
    lastProgressSignature = null;
    visiblePdfPages.clear();
    if (visiblePdfProgressRafId !== null) {
      cancelAnimationFrame(visiblePdfProgressRafId);
      visiblePdfProgressRafId = null;
    }
    if (reflowAnchorRafId !== null) {
      cancelAnimationFrame(reflowAnchorRafId);
      reflowAnchorRafId = null;
      resolveReflowAnchorFrame?.();
      resolveReflowAnchorFrame = null;
    }
    currentRendition = null;
    currentBookRef = null;
    currentPdfDoc = null;
    currentPdfJsLib = null;
    reflowedPages = [];
    reflowLoadingPages = new Set();
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
    const nextProgress = {
      bookId: activeBook.id,
      location: currentLocation,
      href: currentHref,
      progressPercent,
      pageIndex: activeBook.subtype === "pdf" ? pageNumber : null,
      totalPages: activeBook.subtype === "pdf" ? totalPages : null,
      sectionLabel: currentSectionLabel,
      renderer: activeBook.subtype,
      ...patch,
    };
    const signature = JSON.stringify(nextProgress);
    if (signature === lastProgressSignature) return;
    lastProgressSignature = signature;
    setBookProgress({ ...nextProgress, lastReadAt: Date.now() });
    auditReader("books.reader.progress", {
      location: patch.location ?? currentLocation,
      href: patch.href ?? currentHref,
      pageIndex: patch.pageIndex ?? (activeBook.subtype === "pdf" ? pageNumber : null),
    });
  }

  function syncPdfProgress(nextPage = pageNumber, elementIndex = 0) {
    if (!activeBook || activeBook.subtype !== "pdf") return;
    pageNumber = clampReaderPage(nextPage, totalPages);
    progressPercent = totalPages > 1 ? (pageNumber - 1) / (totalPages - 1) : 1;
    currentLocation = pdfReflowMode ? getReflowElementKey(pageNumber, elementIndex) : null;
    currentHref = null;
    currentSectionLabel = resolvePdfSectionLabel(pdfSections, pageNumber);
    canPrev = pageNumber > 1;
    canNext = pageNumber < totalPages;
    if (!loading) {
      persistProgress({
        location: currentLocation,
        href: null,
        progressPercent,
        pageIndex: pageNumber,
        totalPages,
        sectionLabel: currentSectionLabel,
        renderer: "pdf",
      });
    }
  }

  function getReflowPage(pageNum: number) {
    return reflowedPages.find((entry) => entry.pageNumber === pageNum) ?? null;
  }

  async function loadReflowPage(pageNum: number) {
    if (!currentPdfDoc || !currentPdfJsLib || pageNum < 1 || pageNum > totalPages) return;
    if (getReflowPage(pageNum) || reflowLoadingPages.has(pageNum)) return;
    const token = loadToken;
    const documentRef = currentPdfDoc;
    const pdfJsRef = currentPdfJsLib;
    const bookId = activeBook?.id ?? null;
    reflowLoadingPages = new Set(reflowLoadingPages).add(pageNum);
    try {
      const page = await documentRef.getPage(pageNum);
      if (token !== loadToken || documentRef !== currentPdfDoc || bookId !== activeBook?.id) return;
      const reflowed = await extractReflowedPage(page, pageNum, pdfJsRef, {
        removeDecorativeBackgrounds: pdfReflowCleanBackgrounds,
      });
      if (token !== loadToken || documentRef !== currentPdfDoc || bookId !== activeBook?.id) return;
      if (!getReflowPage(pageNum)) {
        reflowedPages = pruneReflowedPages(
          [...reflowedPages, reflowed],
          pageNumber,
          REFLOWED_PAGE_RETAIN_RADIUS,
        );
      }
    } catch (err) {
      if (token !== loadToken) return;
      console.error("Failed to reflow PDF page", pageNum, err);
    } finally {
      if (token !== loadToken) return;
      const next = new Set(reflowLoadingPages);
      next.delete(pageNum);
      reflowLoadingPages = next;
    }
  }

  async function loadReflowPagesAround(centerPage = pageNumber) {
    const end = Math.min(totalPages, centerPage + 2);
    await loadReflowPage(centerPage);
    for (let offset = 1; offset <= 2; offset += 1) {
      const next = centerPage + offset;
      if (next <= end) void loadReflowPage(next);
    }
    void refreshPdfReflowTtsProvider();
  }

  async function refreshPdfReflowTtsProvider() {
    if (activeBook?.subtype !== "pdf" || !pdfReflowMode) return;
    await tick();
    const stage = document.querySelector(".pdf-reflow-stage") as HTMLElement | null;
    tts.setProvider(stage ? createDomTtsTextProvider(stage, "h1, h2, h3, p") : null);
  }

  async function loadPreviousReflowPages() {
    if (!pdfReflowMode || !currentPdfDoc || reflowLoadingPages.size > 0) return;
    const firstLoaded = reflowPageNumbers[0] ?? pageNumber;
    if (firstLoaded <= 1) return;
    const viewer = document.querySelector(".book-viewer") as HTMLElement | null;
    const previousPages = [firstLoaded - 2, firstLoaded - 1].filter((entry) => entry >= 1);
    const beforeHeight = viewer?.scrollHeight ?? 0;
    const beforeTop = viewer?.scrollTop ?? 0;
    await Promise.all(previousPages.map((entry) => loadReflowPage(entry)));
    await tick();
    if (viewer) {
      viewer.scrollTop = beforeTop + Math.max(0, viewer.scrollHeight - beforeHeight);
    }
  }

  function loadNextReflowPages() {
    if (!pdfReflowMode || !currentPdfDoc) return;
    const lastLoaded = reflowPageNumbers[reflowPageNumbers.length - 1] ?? pageNumber;
    for (let page = lastLoaded + 1; page <= Math.min(totalPages, lastLoaded + 2); page += 1) {
      void loadReflowPage(page);
    }
  }

  function scrollToPdfPage(targetPage = pageNumber, behavior: ScrollBehavior = "smooth") {
    const selector = pdfReflowMode ? ".pdf-reflow-page" : ".pdf-page-wrapper";
    const el = document.querySelector(`${selector}[data-page="${targetPage}"]`);
    el?.scrollIntoView({ behavior, block: "start" });
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
    const ePub = await loadEpubFactory();
    if (token !== loadToken || activeBook.subtype !== "epub") return;
    const ePubOptions: any = {};
    if (requiresAuthenticatedMediaFetch(sourceUrl)) {
      const authHeader = getServerAuthHeader();
      if (authHeader) {
        ePubOptions.requestHeaders = {
          Authorization: authHeader,
        };
      }
    }
    const book = ePub(sourceUrl, ePubOptions);
    const rendition = book.renderTo(hostEl, {
      width: "100%",
      height: "100%",
      flow: store.settings.bookReaderFlow === "scrolled" ? "scrolled" : "paginated",
      manager: store.settings.bookReaderFlow === "scrolled" ? "continuous" : "default",
      spread: "none",
    });

    rendition.hooks.content.register((contents: any) => {
      const doc = contents.document;
      untrack(() => {
        tts.setProvider(createDomTtsTextProvider(doc.body, "p, li, blockquote, h1, h2, h3, h4, h5, h6"));
      });
      doc.addEventListener("click", (e: MouseEvent) => {
        if (token !== loadToken || currentRendition !== rendition) return;
        if ((e.target as HTMLElement).closest("a, button")) return;
        const width = doc.documentElement.clientWidth;
        const x = e.clientX;
        if (store.settings.bookReaderFlow === "scrolled") {
          showUi();
          return;
        }
        if (x < width * 0.3) {
          goPrev();
        } else if (x > width * 0.7) {
          goNext();
        } else {
          showUi();
        }
      });
      doc.addEventListener("keydown", (e: KeyboardEvent) => {
        if (token !== loadToken || currentRendition !== rendition) return;
        onKey(e);
      });
    });

    currentBookRef = book;
    currentRendition = rendition;
    applyEpubTheme();
    rendition.on("relocated", (location: any) => {
      if (token !== loadToken || currentRendition !== rendition) return;
      updateEpubProgress(location);
      const contents = rendition.getContents();
      if (contents && contents.length > 0) {
        const d = contents[0].document;
        if (d && d.body) {
          tts.setProvider(createDomTtsTextProvider(d.body, "p, li, blockquote, h1, h2, h3, h4, h5, h6"));
        }
      }
    });
    rendition.on("rendered", applyEpubTheme);

    await book.ready;
    setStage("epub.ready");
    auditReader("books.reader.epub.ready", {
      stage: currentStage,
      sourceUrl,
    });
    const target = resolveBookResumeTarget(activeProgress) ?? undefined;
    if (target) await rendition.display(target);
    else await rendition.display();
    applyEpubTheme();
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
    const targetPage = clampReaderPage(nextPage, totalPages);
    if (pdfReflowMode) {
      syncPdfProgress(targetPage);
      await loadReflowPagesAround(targetPage);
      await tick();
      scrollToPdfPage(targetPage, "auto");
      setStage("pdf.reflow.ready");
      return;
    }
    if (!currentPdfDoc || !canvasEl || !activeBook) return;
    if (pdfRenderTask) {
      pendingPdfPage = targetPage;
      try {
        pdfRenderTask.cancel();
      } catch {}
      return;
    }

    const token = loadToken;
    const documentRef = currentPdfDoc;
    const bookId = activeBook.id;
    const page = await documentRef.getPage(targetPage);
    if (token !== loadToken || documentRef !== currentPdfDoc || bookId !== activeBook?.id) return;
    const canvas = canvasEl;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const nativeViewport = page.getViewport({ scale: 1 });
    const stage = canvas.parentElement;
    const availableWidth = Math.max(320, (stage?.clientWidth ?? window.innerWidth) - 48);
    const availableHeight = Math.max(320, window.innerHeight - 150);
    const fitScale = pdfFitMode === "actual"
      ? 1
      : pdfFitMode === "page"
        ? Math.min(availableWidth / nativeViewport.width, availableHeight / nativeViewport.height)
        : availableWidth / nativeViewport.width;
    const baseScale = Math.max(0.1, zoom) * Math.max(0.1, fitScale);
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

    const renderTask = page.render({ canvasContext: ctx, viewport });
    pdfRenderTask = renderTask;
    try {
      await renderTask.promise;
    } catch (err: any) {
      if (err?.name !== "RenderingCancelledException") throw err;
    } finally {
      if (pdfRenderTask !== renderTask) return;
      pdfRenderTask = null;
      const queuedPage = pendingPdfPage;
      pendingPdfPage = null;
      if (queuedPage !== null) {
        await renderPdfPage(queuedPage);
        return;
      }
    }

    if (token !== loadToken || documentRef !== currentPdfDoc || bookId !== activeBook?.id) return;
    syncPdfProgress(targetPage);
    setStage("pdf.page.rendered");
    auditReader("books.reader.pdf.page.rendered", {
      stage: currentStage,
      sourceUrl: currentSourceUrl,
      pageNumber: targetPage,
      totalPages,
      sectionLabel: currentSectionLabel,
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
    const pdfjsLib = await loadPdfJs();
    currentPdfJsLib = pdfjsLib;
    if (token !== loadToken || activeBook.subtype !== "pdf") return;
    const authHeader = requiresAuthenticatedMediaFetch(sourceUrl) ? getServerAuthHeader() : null;
    const pdf = await pdfjsLib.getDocument(createPdfDocumentInit(sourceUrl, authHeader)).promise;
    if (token !== loadToken) {
      await pdf.destroy();
      return;
    }

    currentPdfDoc = pdf;
    pdfDocumentGeneration += 1;
    setStage("pdf.ready");
    auditReader("books.reader.pdf.ready", {
      stage: currentStage,
      sourceUrl,
      totalPages: pdf.numPages || 1,
    });
    totalPages = pdf.numPages || 1;
    pageNumber = clampReaderPage(activeProgress?.pageIndex ?? 1, totalPages);
    if (pdfReflowMode) {
      await loadReflowPagesAround(pageNumber);
      await tick();
      scrollToPdfPage(pageNumber, "auto");
      syncPdfProgress(pageNumber);
      setStage("pdf.reflow.ready");
    } else if (store.settings.bookReaderFlow === "scrolled") {
      syncPdfProgress(pageNumber);
      await tick();
      scrollToPdfPage(pageNumber, "auto");
    } else {
      await tick();
      await renderPdfPage(pageNumber);
    }
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
    tts.stop();
    if (activeBook.subtype === "epub") {
      void currentRendition?.prev?.();
      return;
    }
    if (pageNumber > 1) {
      pageNumber -= 1;
      if (pdfReflowMode) {
        loadReflowPagesAround(pageNumber);
        scrollToPdfPage(pageNumber);
        syncPdfProgress(pageNumber);
      } else if (store.settings.bookReaderFlow === "scrolled") {
        scrollToPdfPage(pageNumber);
      } else {
        void renderPdfPage(pageNumber);
      }
    }
  }

  function goNext() {
    if (!activeBook || loading) return;
    tts.stop();
    if (activeBook.subtype === "epub") {
      void currentRendition?.next?.();
      return;
    }
    if (pageNumber < totalPages) {
      pageNumber += 1;
      if (pdfReflowMode) {
        loadReflowPagesAround(pageNumber);
        scrollToPdfPage(pageNumber);
        syncPdfProgress(pageNumber);
      } else if (store.settings.bookReaderFlow === "scrolled") {
        scrollToPdfPage(pageNumber);
      } else {
        void renderPdfPage(pageNumber);
      }
    }
  }

  function jumpToSliderValue(value: number) {
    if (!activeBook || loading) return;
    tts.stop();
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
    if (pdfReflowMode) {
      loadReflowPagesAround(pageNumber);
      scrollToPdfPage(pageNumber);
      syncPdfProgress(pageNumber);
    } else if (store.settings.bookReaderFlow === "scrolled") {
      scrollToPdfPage(pageNumber);
    } else {
      void renderPdfPage(pageNumber);
    }
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
    tts.stop();
    if (!auditCloseSent) {
      auditReader("books.reader.closed", { reason });
      auditCloseSent = true;
    }
    closeBookReader();
  }

  function onKey(event: KeyboardEvent) {
    if (isReaderControlKeyboardTarget(event.target)) return;
    const keybinds = store.settings.keybinds ?? DEFAULT_KEYBINDS;
    showUi();
    if (event.key === "Escape" || event.key === "Backspace") {
      event.preventDefault();
      requestClose("keyboard");
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if ((store.settings.bookReaderFlow === "scrolled" || pdfReflowMode) && activeBook?.subtype === "pdf") {
        const viewerEl = document.querySelector(".book-viewer");
        viewerEl?.scrollBy({ top: -viewerEl.clientHeight * 0.85, behavior: "smooth" });
      } else {
        goPrev();
      }
      return;
    }
    if (event.key === "ArrowRight" || event.key === " ") {
      event.preventDefault();
      if ((store.settings.bookReaderFlow === "scrolled" || pdfReflowMode) && activeBook?.subtype === "pdf") {
        const viewerEl = document.querySelector(".book-viewer");
        viewerEl?.scrollBy({ top: viewerEl.clientHeight * 0.85, behavior: "smooth" });
      } else {
        goNext();
      }
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
    if (matchesKeybind(event, keybinds.toggleFullscreen)) {
      event.preventDefault();
      void toggleFullscreen();
      return;
    }
    if (matchesKeybind(event, keybinds.toggleBookmark)) {
      event.preventDefault();
      toggleBookmark();
    }
  }

  $effect(() => {
    const book = activeBook;
    const flow = store.settings.bookReaderFlow;
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
    if (
      book.subtype === "pdf"
      && !canvasEl
      && !pdfReflowMode
      && flow !== "scrolled"
    ) return;
    untrack(() => {
      void loadActiveBook();
    });
  });

  $effect(() => {
    const book = activeBook;
    const rendition = currentRendition;
    const pdf = currentPdfDoc;
    const nextZoom = zoom;
    pdfReflowMode;
    if (book?.subtype === "epub" && rendition) {
      applyEpubTheme();
      return;
    }
    if (book?.subtype === "pdf" && pdf) {
      untrack(() => {
        if (pdfReflowMode) {
          loadReflowPagesAround(pageNumber);
          void tick().then(() => scrollToPdfPage(pageNumber, "auto"));
          syncPdfProgress(pageNumber);
        } else {
          void renderPdfPage(pageNumber);
        }
      });
    }
  });

  $effect(() => {
    proseTheme;
    proseFontSize;
    proseLineHeight;
    proseParagraphSpacing;
    proseFontFamily;
    proseTextAlign;
    prosePalette.text;
    prosePalette.surface;
    if (activeBook?.subtype === "epub" && currentRendition) {
      untrack(() => applyEpubTheme());
    }
  });

  $effect(() => {
    pdfFitMode;
    pdfDarkMode;
    pdfReflowMode;
    pdfReflowCleanBackgrounds;
    if (activeBook?.subtype === "pdf" && currentPdfDoc && pdfReflowMode) {
      untrack(() => {
        reflowedPages = [];
        reflowLoadingPages = new Set();
        loadReflowPagesAround(pageNumber);
      });
      return;
    }
    if (activeBook?.subtype === "pdf" && currentPdfDoc && !pdfReflowMode) {
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
    const unregisterCommands = registerReaderCommandHandler("book", onKey);
    return () => {
      unregisterCommands();
      if (hideTimer) clearTimeout(hideTimer);
      disposeReader();
    };
  });

  function handleViewerClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest("button, input, select, a")) return;

    if (store.settings.bookReaderFlow === "scrolled" || pdfReflowMode) {
      return;
    }

    const width = window.innerWidth;
    const x = e.clientX;
    if (x < width * 0.3) {
      e.stopPropagation();
      goPrev();
    } else if (x > width * 0.7) {
      e.stopPropagation();
      goNext();
    }
  }

  function handleViewerWheel(event: WheelEvent) {
    if (!pdfReflowMode || activeBook?.subtype !== "pdf") return;
    const viewer = event.currentTarget as HTMLElement;
    if (event.deltaY < 0 && viewer.scrollTop < 96) {
      void loadPreviousReflowPages();
      return;
    }
    if (event.deltaY > 0 && viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 720) {
      loadNextReflowPages();
    }
  }

  function scheduleDominantPdfProgress() {
    if (visiblePdfProgressRafId !== null) return;
    visiblePdfProgressRafId = requestAnimationFrame(() => {
      visiblePdfProgressRafId = null;
      if (loading || Date.now() < suspendReflowProgressUntil) return;
      const dominantPage = selectDominantReaderPage(visiblePdfPages.values());
      if (dominantPage !== null) syncPdfProgress(dominantPage);
    });
  }

  function trackPdfPageVisibility(pageNum: number, entry: IntersectionObserverEntry) {
    const viewerRect = (entry.target as Element).closest(".book-viewer")?.getBoundingClientRect();
    const rootTop = Math.max(0, viewerRect?.top ?? 0);
    const rootBottom = Math.min(window.innerHeight, viewerRect?.bottom ?? window.innerHeight);
    const rect = entry.boundingClientRect;
    const visiblePixels = Math.max(0, Math.min(rect.bottom, rootBottom) - Math.max(rect.top, rootTop));
    const denominator = Math.max(1, Math.min(rect.height, rootBottom - rootTop));
    if (visiblePixels <= 0) {
      visiblePdfPages.delete(pageNum);
    } else {
      visiblePdfPages.set(pageNum, {
        pageNumber: pageNum,
        visibleRatio: visiblePixels / denominator,
        centerDistance: Math.abs(((rect.top + rect.bottom) / 2) - ((rootTop + rootBottom) / 2)),
      });
    }
    scheduleDominantPdfProgress();
  }

  function forgetPdfPageVisibility(pageNum: number) {
    visiblePdfPages.delete(pageNum);
    if (visiblePdfPages.size === 0) {
      if (visiblePdfProgressRafId !== null) {
        cancelAnimationFrame(visiblePdfProgressRafId);
        visiblePdfProgressRafId = null;
      }
      return;
    }
    scheduleDominantPdfProgress();
  }

  function lazyRenderPdfPage(
    node: HTMLElement,
    params: { pageNum: number; zoom: number; pdfFitMode: PdfFitMode; documentGeneration: number },
  ) {
    let observer: IntersectionObserver | null = null;
    let localRenderTask: any = null;
    let canvas: HTMLCanvasElement | null = null;
    let isIntersecting = false;
    let pageNum = params.pageNum;
    let renderGeneration = 0;

    async function render() {
      if (!currentPdfDoc || canvas) return;
      const generation = ++renderGeneration;
      const token = loadToken;
      const documentRef = currentPdfDoc;
      const targetPage = pageNum;

      canvas = document.createElement("canvas");
      node.appendChild(canvas);

      try {
        const page = await documentRef.getPage(targetPage);
        if (
          generation !== renderGeneration
          || token !== loadToken
          || documentRef !== currentPdfDoc
          || !canvas?.isConnected
        ) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const nativeViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(320, (node.clientWidth || window.innerWidth) - 48);
        const availableHeight = Math.max(320, window.innerHeight - 150);
        const fitScale = pdfFitMode === "actual"
          ? 1
          : pdfFitMode === "page"
            ? Math.min(availableWidth / nativeViewport.width, availableHeight / nativeViewport.height)
            : availableWidth / nativeViewport.width;
        const baseScale = Math.max(0.1, zoom) * Math.max(0.1, fitScale);
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

        const renderTask = page.render({ canvasContext: ctx, viewport });
        localRenderTask = renderTask;
        await renderTask.promise;
      } catch (err: any) {
        if (err?.name !== "RenderingCancelledException") {
          console.error(err);
        }
      } finally {
        if (generation === renderGeneration) localRenderTask = null;
      }
    }

    function cleanup() {
      renderGeneration += 1;
      if (localRenderTask) {
        try {
          localRenderTask.cancel();
        } catch {}
        localRenderTask = null;
      }
      if (canvas) {
        canvas.remove();
        canvas = null;
      }
    }

    observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        isIntersecting = entry.isIntersecting;
        trackPdfPageVisibility(pageNum, entry);
        if (isIntersecting) {
          void render();
        } else {
          cleanup();
        }
      });
    }, {
      rootMargin: "80% 0px 80% 0px",
      threshold: 0.05
    });

    observer.observe(node);

    return {
      update(nextParams: { pageNum: number; zoom: number; pdfFitMode: PdfFitMode; documentGeneration: number }) {
        forgetPdfPageVisibility(pageNum);
        params = nextParams;
        pageNum = nextParams.pageNum;
        cleanup();
        if (isIntersecting) {
          void render();
        }
      },
      destroy() {
        observer?.disconnect();
        forgetPdfPageVisibility(pageNum);
        cleanup();
      }
    };
  }

  function lazyRenderReflowPage(node: HTMLElement, pageNum: number) {
    let observer: IntersectionObserver | null = null;

    observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        trackPdfPageVisibility(pageNum, entry);
        if (!entry.isIntersecting) return;
        if (pageNum >= (reflowPageNumbers[reflowPageNumbers.length - 1] ?? pageNum)) {
          loadNextReflowPages();
        }
      });
    }, {
      rootMargin: "45% 0px 65% 0px",
      threshold: 0.05,
    });

    observer.observe(node);

    return {
      update(nextPage: number) {
        forgetPdfPageVisibility(pageNum);
        pageNum = nextPage;
      },
      destroy() {
        observer?.disconnect();
        forgetPdfPageVisibility(pageNum);
      },
    };
  }

  function renderReflowImage(node: HTMLCanvasElement, objectId: string) {
    let cancelled = false;

    async function render() {
      if (!currentPdfDoc || objectId.startsWith("inline:")) return;
      const token = loadToken;
      const documentRef = currentPdfDoc;
      const sourcePage = Number(node.closest("[data-page]")?.getAttribute("data-page") ?? pageNumber);
      const page = await documentRef.getPage(sourcePage);
      if (cancelled || token !== loadToken || documentRef !== currentPdfDoc) return;
      const image = await new Promise<any>((resolve) => {
        try {
          if (page.objs?.has?.(objectId)) {
            resolve(page.objs.get(objectId));
            return;
          }
          page.objs?.get?.(objectId, resolve);
        } catch {
          resolve(null);
        }
      });
      if (cancelled || token !== loadToken || documentRef !== currentPdfDoc || !image) return;
      const width = Number(image.width ?? image.bitmap?.width ?? node.width);
      const height = Number(image.height ?? image.bitmap?.height ?? node.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
      const ctx = node.getContext("2d");
      if (!ctx) return;
      node.width = width;
      node.height = height;
      node.style.aspectRatio = `${width} / ${height}`;

      if (image.bitmap) {
        ctx.drawImage(image.bitmap, 0, 0, width, height);
        return;
      }

      const data = image.data;
      if (!data || typeof data.length !== "number") return;
      const rgba = new Uint8ClampedArray(width * height * 4);
      if (data.length >= width * height * 4) {
        rgba.set(data.slice(0, rgba.length));
      } else {
        for (let source = 0, target = 0; source < data.length && target < rgba.length; source += 3, target += 4) {
          rgba[target] = data[source] ?? 0;
          rgba[target + 1] = data[source + 1] ?? rgba[target];
          rgba[target + 2] = data[source + 2] ?? rgba[target];
          rgba[target + 3] = 255;
        }
      }
      ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    }

    void render();

    return {
      update(nextObjectId: string) {
        objectId = nextObjectId;
        void render();
      },
      destroy() {
        cancelled = true;
      },
    };
  }

  onDestroy(() => {
    tts.destroy();
    if (auditOpenBookId && !auditCloseSent) {
      auditReader("books.reader.closed", { reason: translate("ui_destroy") });
      auditCloseSent = true;
    }
    ++loadToken;
    disposeReader();
  });
</script>

<ReaderHud
  bind:toolsOpen={toolsOpen}
  title={activeBook?.title ?? "Book"}
  chapterTitle={currentSectionLabel ?? activeBook?.subtype.toUpperCase() ?? "BOOK"}
  progressLabel={progressLabel}
  sliderValue={sliderValue}
  sliderMax={sliderMax}
  sliderPct={sliderPct}
  bookmarkPct={currentBookmark ? bookmarkPct : null}
  isBookmarked={isBookmarked}
  prevDisabled={loading || !canPrev}
  nextDisabled={loading || !canNext}
  uiVisible={uiVisible}
  onMouseMove={(event) => { if (event.clientY < 60 || window.innerHeight - event.clientY < 60) showUi(); }}
  onHudMouseEnter={keepHudVisible}
  onHudMouseLeave={releaseHudVisibility}
  onclose={() => requestClose("toolbar")}
  onprev={goPrev}
  onnext={goNext}
  onjump={jumpToSliderValue}
  onbookmark={toggleBookmark}
>
  {#snippet settingsPopover()}
    {#if activeSubPanel === "tts" && (activeBook?.subtype === "epub" || (activeBook?.subtype === "pdf" && pdfReflowMode && reflowedPages.length > 0))}
      <TtsControls controller={tts} onback={() => activeSubPanel = "main"} />
    {:else}
      <dl>
        {#if activeSubPanel === "main"}
          {#if activeBook?.subtype === "pdf"}
            <div class="popover-tts-row" onclick={() => activeSubPanel = "pdf"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "pdf"; }}>
              <dt>PDF</dt>
              <dd>{pdfReflowMode ? "Reflow" : "Canvas"} · {pdfReflowCleanBackgrounds ? "Clean" : "Original"} <span class="popover-chevron">&gt;</span></dd>
            </div>
            {#if pdfReflowMode}
              <div class="popover-tts-row" onclick={() => activeSubPanel = "appearance"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "appearance"; }}>
                <dt>{$_("ui_appearance")}</dt>
                <dd>{proseTheme} <span class="popover-chevron">&gt;</span></dd>
              </div>
              <div class="popover-tts-row" onclick={() => activeSubPanel = "typography"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "typography"; }}>
                <dt>{$_("ui_typography")}</dt>
                <dd>{proseFontSize}{$_("ui_px")} {proseLineHeight.toFixed(2)} <span class="popover-chevron">&gt;</span></dd>
              </div>
              <div class="popover-tts-row" onclick={() => activeSubPanel = "layout"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "layout"; }}>
                <dt>{$_("library_display_layout")}</dt>
                <dd>{store.settings.proseReaderFullWidth ? $_("ui_full") : `${proseContentWidth}px`} · {proseTextAlign} <span class="popover-chevron">&gt;</span></dd>
              </div>
              <div class="popover-tts-row" onclick={() => activeSubPanel = "images"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "images"; }}>
                <dt>{$_("ui_images")}</dt>
                <dd>{Math.round(pdfReflowIllustrationScale * 100)}% <span class="popover-chevron">&gt;</span></dd>
              </div>
              <div class="popover-tts-row" onclick={() => { if (reflowedPages.length > 0) activeSubPanel = "tts"; }} role="button" tabindex="0" aria-disabled={reflowedPages.length === 0} onkeydown={(e) => { if ((e.key === "Enter" || e.key === " ") && reflowedPages.length > 0) activeSubPanel = "tts"; }}>
                <dt>{$_("ui_textToSpeech")}</dt>
                <dd>{reflowedPages.length > 0 ? $_("ui_configure") : $_("ui_waitingForReflow")} <span class="popover-chevron">&gt;</span></dd>
              </div>
            {:else}
              <div class="popover-tts-row" onclick={() => activeSubPanel = "display"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "display"; }}>
                <dt>{$_("library_display_title")}</dt>
                <dd>{pdfFitMode} · {Math.round(zoom * 100)}% <span class="popover-chevron">&gt;</span></dd>
              </div>
              <div class="popover-tts-row" onclick={() => activeSubPanel = "layout"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "layout"; }}>
                <dt>{$_("library_display_layout")}</dt>
                <dd>{store.settings.bookReaderFlow === "scrolled" ? $_("ui_scroll") : $_("bookDetail_page")} <span class="popover-chevron">&gt;</span></dd>
              </div>
            {/if}
          {:else if activeBook?.subtype === "epub"}
            <div class="popover-tts-row" onclick={() => activeSubPanel = "appearance"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "appearance"; }}>
              <dt>{$_("ui_appearance")}</dt>
              <dd>{proseTheme} <span class="popover-chevron">&gt;</span></dd>
            </div>
            <div class="popover-tts-row" onclick={() => activeSubPanel = "typography"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "typography"; }}>
              <dt>{$_("ui_typography")}</dt>
              <dd>{proseFontSize}{$_("ui_px")} {proseLineHeight.toFixed(2)} <span class="popover-chevron">&gt;</span></dd>
            </div>
            <div class="popover-tts-row" onclick={() => activeSubPanel = "layout"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "layout"; }}>
              <dt>{$_("library_display_layout")}</dt>
              <dd>{store.settings.bookReaderFlow === "scrolled" ? $_("ui_scroll") : $_("bookDetail_page")} · {store.settings.proseReaderFullWidth ? $_("ui_full") : `${proseContentWidth}px`} <span class="popover-chevron">&gt;</span></dd>
            </div>
            <div class="popover-tts-row" onclick={() => activeSubPanel = "tts"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "tts"; }}>
              <dt>{$_("ui_textToSpeech")}</dt>
              <dd>{$_("ui_configure")} <span class="popover-chevron">&gt;</span></dd>
            </div>
          {/if}
        {:else if activeSubPanel === "pdf" && activeBook?.subtype === "pdf"}
          <div class="popover-tts-row" onclick={() => activeSubPanel = "main"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "main"; }}>
            <dt>{$_("ui_back_f13dfaca")}</dt>
            <dd>PDF</dd>
          </div>
          <div>
            <dt>{$_("ui_reflow")}</dt>
            <dd>
              <button class="popover-toggle" type="button" aria-label={$_("ui_togglePdfReflowMode")} title={$_("ui_togglePdfReflowMode")} class:active={pdfReflowMode} onclick={() => updateSettings({ pdfReflowMode: !pdfReflowMode })}></button>
            </dd>
          </div>
          {#if pdfReflowMode}
            <div>
              <dt>{$_("ui_cleanBg")}</dt>
              <dd>
                <button class="popover-toggle" type="button" aria-label={$_("ui_removePdfBackgroundsAndWatermarks")} title={$_("ui_removePdfBackgroundsAndWatermarks")} class:active={pdfReflowCleanBackgrounds} onclick={() => updateSettings({ pdfReflowCleanBackgrounds: !pdfReflowCleanBackgrounds })}></button>
              </dd>
            </div>
          {:else}
            <div>
              <dt>{$_("ui_darkPdf")}</dt>
              <dd>
                <button class="popover-toggle" type="button" aria-label={$_("ui_toggleDarkPdfMode")} title={$_("ui_toggleDarkPdfMode")} class:active={pdfDarkMode} onclick={() => updateSettings({ pdfDarkMode: !pdfDarkMode })}></button>
              </dd>
            </div>
          {/if}
        {:else if activeSubPanel === "appearance"}
          <div class="popover-tts-row" onclick={() => activeSubPanel = "main"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "main"; }}>
            <dt>{$_("ui_back_f13dfaca")}</dt>
            <dd>{$_("ui_appearance")}</dd>
          </div>
          <div>
            <dt>{$_("ui_theme")}</dt>
            <dd>
              <div class="popover-color-swatches" style="display: flex; flex-wrap: wrap; gap: 4px; max-width: 150px;">
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("sepia")} class:active={proseTheme === "sepia"} onclick={() => activeBook?.subtype === "pdf" ? updateAnchoredReaderSettings({ proseReaderTheme: "sepia" }) : updateSettings({ proseReaderTheme: "sepia" })} title={$_("ui_sepia")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("oled")} class:active={proseTheme === "oled"} onclick={() => activeBook?.subtype === "pdf" ? updateAnchoredReaderSettings({ proseReaderTheme: "oled" }) : updateSettings({ proseReaderTheme: "oled" })} title={$_("ui_oled")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("dark")} class:active={proseTheme === "dark"} onclick={() => activeBook?.subtype === "pdf" ? updateAnchoredReaderSettings({ proseReaderTheme: "dark" }) : updateSettings({ proseReaderTheme: "dark" })} title={$_("ui_dark")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("light")} class:active={proseTheme === "light"} onclick={() => activeBook?.subtype === "pdf" ? updateAnchoredReaderSettings({ proseReaderTheme: "light" }) : updateSettings({ proseReaderTheme: "light" })} title={$_("ui_light")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("nocturne")} class:active={proseTheme === "nocturne"} onclick={() => activeBook?.subtype === "pdf" ? updateAnchoredReaderSettings({ proseReaderTheme: "nocturne" }) : updateSettings({ proseReaderTheme: "nocturne" })} title={$_("ui_nocturne")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("slate")} class:active={proseTheme === "slate"} onclick={() => activeBook?.subtype === "pdf" ? updateAnchoredReaderSettings({ proseReaderTheme: "slate" }) : updateSettings({ proseReaderTheme: "slate" })} title={$_("ui_slate")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("forest")} class:active={proseTheme === "forest"} onclick={() => activeBook?.subtype === "pdf" ? updateAnchoredReaderSettings({ proseReaderTheme: "forest" }) : updateSettings({ proseReaderTheme: "forest" })} title={$_("ui_forest")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("nord")} class:active={proseTheme === "nord"} onclick={() => activeBook?.subtype === "pdf" ? updateAnchoredReaderSettings({ proseReaderTheme: "nord" }) : updateSettings({ proseReaderTheme: "nord" })} title={$_("ui_nord")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("warm")} class:active={proseTheme === "warm"} onclick={() => activeBook?.subtype === "pdf" ? updateAnchoredReaderSettings({ proseReaderTheme: "warm" }) : updateSettings({ proseReaderTheme: "warm" })} title={$_("ui_warm")}></button>
              </div>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_textColor")}</dt>
            <dd>
              <input class="popover-color-picker" type="color" value={prosePalette.text} onchange={(event) => updateProseColor("text", event.currentTarget.value)} title={$_("ui_textColor_1c7a30e5")} />
            </dd>
          </div>
          <div>
            <dt>{$_("ui_paperColor")}</dt>
            <dd>
              <input class="popover-color-picker" type="color" value={prosePalette.surface} onchange={(event) => updateProseColor("background", event.currentTarget.value)} title={$_("ui_pageBackground")} />
            </dd>
          </div>
        {:else if activeSubPanel === "typography"}
          <div class="popover-tts-row" onclick={() => activeSubPanel = "main"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "main"; }}>
            <dt>{$_("ui_back_f13dfaca")}</dt>
            <dd>{$_("ui_typography")}</dd>
          </div>
          <div>
            <dt>{$_("ui_font")}</dt>
            <dd>
              <select class="popover-select" value={proseFontFamily} onchange={(event) => activeBook?.subtype === "pdf" ? updateAnchoredReaderSettings({ proseReaderFontFamily: event.currentTarget.value }) : updateSettings({ proseReaderFontFamily: event.currentTarget.value })}>
                <option value="Georgia, serif">Georgia</option>
                <option value="Merriweather, Georgia, serif">Merriweather</option>
                <option value="'EB Garamond', serif">EB Garamond</option>
                <option value="Lora, serif">Lora</option>
                <option value="Literata, serif">Literata</option>
                <option value="Inter, sans-serif">Inter</option>
                <option value="Atkinson Hyperlegible, Inter, sans-serif">Atkinson</option>
                <option value='"Segoe UI", sans-serif'>Segoe UI</option>
              </select>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_textSize")}</dt>
            <dd>
              <div class="popover-stepper">
                <button class="popover-step-btn" onclick={() => updateFontSize(-1)} disabled={proseFontSize <= 12}>-</button>
                <span class="popover-step-val">{proseFontSize}{$_("ui_px_07a65dd6")}</span>
                <button class="popover-step-btn" onclick={() => updateFontSize(1)} disabled={proseFontSize >= 32}>+</button>
              </div>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_lineHeight")}</dt>
            <dd>
              <div class="popover-stepper">
                <button class="popover-step-btn" onclick={() => updateLineHeight(-0.05)} disabled={proseLineHeight <= 1.2}>-</button>
                <span class="popover-step-val">{proseLineHeight.toFixed(2)}</span>
                <button class="popover-step-btn" onclick={() => updateLineHeight(0.05)} disabled={proseLineHeight >= 2.4}>+</button>
              </div>
            </dd>
          </div>
        {:else if activeSubPanel === "layout"}
          <div class="popover-tts-row" onclick={() => activeSubPanel = "main"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "main"; }}>
            <dt>{$_("ui_back_f13dfaca")}</dt>
            <dd>{$_("library_display_layout")}</dd>
          </div>
          {#if activeBook?.subtype === "epub" || pdfReflowMode}
            <div>
              <dt>{$_("ui_align")}</dt>
              <dd>
                <div class="popover-segmented">
                  <button class="popover-segment" class:active={proseTextAlign === "left"} onclick={() => activeBook?.subtype === "pdf" ? updateAnchoredReaderSettings({ proseReaderTextAlign: "left" }) : updateSettings({ proseReaderTextAlign: "left" })}>{$_("ui_left")}</button>
                  <button class="popover-segment" class:active={proseTextAlign === "justify"} onclick={() => activeBook?.subtype === "pdf" ? updateAnchoredReaderSettings({ proseReaderTextAlign: "justify" }) : updateSettings({ proseReaderTextAlign: "justify" })}>{$_("ui_justified")}</button>
                </div>
              </dd>
            </div>
            <div>
              <dt>{$_("ui_width")}</dt>
              <dd style="display: flex; align-items: center; gap: 8px;">
                <div class="popover-stepper">
                  <button class="popover-step-btn" onclick={() => updateContentWidth(-40)} disabled={store.settings.proseReaderFullWidth}>-</button>
                  <span class="popover-step-val" style={store.settings.proseReaderFullWidth ? "opacity: var(--component-reader-core-disabled-step-opacity);" : ""}>
                    {store.settings.proseReaderFullWidth ? $_("ui_full") : `${proseContentWidth}px`}
                  </span>
                  <button class="popover-step-btn" onclick={() => updateContentWidth(40)} disabled={store.settings.proseReaderFullWidth}>+</button>
                </div>
                <button class="popover-btn" class:active={store.settings.proseReaderFullWidth} onclick={() => activeBook?.subtype === "pdf" ? updateAnchoredReaderSettings({ proseReaderFullWidth: !store.settings.proseReaderFullWidth }) : updateSettings({ proseReaderFullWidth: !store.settings.proseReaderFullWidth })}>{$_("ui_full")}</button>
              </dd>
            </div>
          {/if}
          {#if activeBook?.subtype === "epub" || !pdfReflowMode}
            <div>
              <dt>{$_("ui_flow")}</dt>
              <dd>
                <div class="popover-segmented">
                  <button class="popover-segment" class:active={store.settings.bookReaderFlow !== "scrolled"} onclick={() => updateSettings({ bookReaderFlow: "paginated" })}>{$_("bookDetail_page")}</button>
                  <button class="popover-segment" class:active={store.settings.bookReaderFlow === "scrolled"} onclick={() => updateSettings({ bookReaderFlow: "scrolled" })}>{$_("ui_scroll")}</button>
                </div>
              </dd>
            </div>
          {/if}
          {#if activeBook?.subtype === "pdf" && !pdfReflowMode}
            <div>
              <dt>{$_("ui_fullWidth")}</dt>
              <dd>
                <button class="popover-toggle" type="button" aria-label={$_("ui_toggleFullWidthReading")} title={$_("ui_toggleFullWidthReading")} class:active={store.settings.proseReaderFullWidth} onclick={() => updateSettings({ proseReaderFullWidth: !store.settings.proseReaderFullWidth })}></button>
              </dd>
            </div>
          {/if}
        {:else if activeSubPanel === "display" && activeBook?.subtype === "pdf"}
          <div class="popover-tts-row" onclick={() => activeSubPanel = "main"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "main"; }}>
            <dt>{$_("ui_back_f13dfaca")}</dt>
            <dd>{$_("library_display_title")}</dd>
          </div>
          <div>
            <dt>{$_("ui_fitMode")}</dt>
            <dd>
              <button class="popover-btn" onclick={cyclePdfFit}>{pdfFitMode}</button>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_zoom")}</dt>
            <dd>
              <div class="popover-stepper">
                <button class="popover-step-btn" onclick={() => adjustZoom(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN}>-</button>
                <span class="popover-step-val">{Math.round(zoom * 100)}%</span>
                <button class="popover-step-btn" onclick={() => adjustZoom(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX}>+</button>
              </div>
            </dd>
          </div>
        {:else if activeSubPanel === "images" && activeBook?.subtype === "pdf" && pdfReflowMode}
          <div class="popover-tts-row" onclick={() => activeSubPanel = "main"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "main"; }}>
            <dt>{$_("ui_back_f13dfaca")}</dt>
            <dd>{$_("ui_images")}</dd>
          </div>
          <div>
            <dt>{$_("ui_imageSize")}</dt>
            <dd>
              <div class="popover-stepper">
                <button class="popover-step-btn" onclick={() => updateIllustrationScale(-0.1)} disabled={pdfReflowIllustrationScale <= 0.5}>-</button>
                <span class="popover-step-val">{Math.round(pdfReflowIllustrationScale * 100)}%</span>
                <button class="popover-step-btn" onclick={() => updateIllustrationScale(0.1)} disabled={pdfReflowIllustrationScale >= 2}>+</button>
              </div>
            </dd>
          </div>
        {:else if false}
        {#if activeBook?.subtype === "epub"}
        <div>
          <dt>{$_("ui_theme")}</dt>
          <dd>
            <div class="popover-color-swatches" style="display: flex; flex-wrap: wrap; gap: 4px; max-width: 150px;">
              <button class="popover-swatch" style:background={proseReaderThemeSwatch("sepia")} class:active={proseTheme === "sepia"} onclick={() => updateSettings({ proseReaderTheme: "sepia" })} title={$_("ui_sepia")}></button>
              <button class="popover-swatch" style:background={proseReaderThemeSwatch("oled")} class:active={proseTheme === "oled"} onclick={() => updateSettings({ proseReaderTheme: "oled" })} title={$_("ui_oled")}></button>
              <button class="popover-swatch" style:background={proseReaderThemeSwatch("dark")} class:active={proseTheme === "dark"} onclick={() => updateSettings({ proseReaderTheme: "dark" })} title={$_("ui_dark")}></button>
              <button class="popover-swatch" style:background={proseReaderThemeSwatch("light")} class:active={proseTheme === "light"} onclick={() => updateSettings({ proseReaderTheme: "light" })} title={$_("ui_light")}></button>
              <button class="popover-swatch" style:background={proseReaderThemeSwatch("nocturne")} class:active={proseTheme === "nocturne"} onclick={() => updateSettings({ proseReaderTheme: "nocturne" })} title={$_("ui_nocturne")}></button>
              <button class="popover-swatch" style:background={proseReaderThemeSwatch("slate")} class:active={proseTheme === "slate"} onclick={() => updateSettings({ proseReaderTheme: "slate" })} title={$_("ui_slate")}></button>
              <button class="popover-swatch" style:background={proseReaderThemeSwatch("forest")} class:active={proseTheme === "forest"} onclick={() => updateSettings({ proseReaderTheme: "forest" })} title={$_("ui_forest")}></button>
              <button class="popover-swatch" style:background={proseReaderThemeSwatch("nord")} class:active={proseTheme === "nord"} onclick={() => updateSettings({ proseReaderTheme: "nord" })} title={$_("ui_nord")}></button>
              <button class="popover-swatch" style:background={proseReaderThemeSwatch("warm")} class:active={proseTheme === "warm"} onclick={() => updateSettings({ proseReaderTheme: "warm" })} title={$_("ui_warm")}></button>
            </div>
          </dd>
        </div>
        <div>
          <dt>{$_("ui_textColor")}</dt>
          <dd>
            <input
              class="popover-color-picker"
              type="color"
              value={prosePalette.text}
              onchange={(event) => updateProseColor("text", event.currentTarget.value)}
              title={$_("ui_textColor_1c7a30e5")}
            />
          </dd>
        </div>
        <div>
          <dt>{$_("ui_paperColor")}</dt>
          <dd>
            <input
              class="popover-color-picker"
              type="color"
              value={prosePalette.surface}
              onchange={(event) => updateProseColor("background", event.currentTarget.value)}
              title={$_("ui_pageBackground")}
            />
          </dd>
        </div>
        <div>
          <dt>{$_("ui_font")}</dt>
          <dd>
            <select
              class="popover-select"
              value={proseFontFamily}
              onchange={(event) => updateSettings({ proseReaderFontFamily: event.currentTarget.value })}
            >
              <option value="Georgia, serif">Georgia</option>
              <option value="Merriweather, Georgia, serif">Merriweather</option>
              <option value="'EB Garamond', serif">EB Garamond</option>
              <option value="Lora, serif">Lora</option>
              <option value="Literata, serif">Literata</option>
              <option value="Inter, sans-serif">Inter</option>
              <option value="Atkinson Hyperlegible, Inter, sans-serif">Atkinson</option>
              <option value='"Segoe UI", sans-serif'>Segoe UI</option>
            </select>
          </dd>
        </div>
        <div>
          <dt>{$_("ui_size")}</dt>
          <dd>
            <div class="popover-stepper">
              <button class="popover-step-btn" onclick={() => updateFontSize(-1)}>−</button>
              <span class="popover-step-val">{proseFontSize}{$_("ui_px_07a65dd6")}</span>
              <button class="popover-step-btn" onclick={() => updateFontSize(1)}>+</button>
            </div>
          </dd>
        </div>
        <div>
          <dt>{$_("ui_line")}</dt>
          <dd>
            <div class="popover-stepper">
              <button class="popover-step-btn" onclick={() => updateLineHeight(-0.05)}>−</button>
              <span class="popover-step-val">{proseLineHeight.toFixed(2)}</span>
              <button class="popover-step-btn" onclick={() => updateLineHeight(0.05)}>+</button>
            </div>
          </dd>
        </div>
        <div>
          <dt>{$_("ui_align")}</dt>
          <dd>
            <div class="popover-segmented">
              <button class="popover-segment" class:active={proseTextAlign === "left"} onclick={() => updateSettings({ proseReaderTextAlign: "left" })}>{$_("ui_left")}</button>
              <button class="popover-segment" class:active={proseTextAlign === "justify"} onclick={() => updateSettings({ proseReaderTextAlign: "justify" })}>{$_("ui_justified")}</button>
            </div>
          </dd>
        </div>
        <div>
          <dt>{$_("ui_width")}</dt>
          <dd style="display: flex; align-items: center; gap: 8px;">
            <div class="popover-stepper">
              <button class="popover-step-btn" onclick={() => updateContentWidth(-40)} disabled={store.settings.proseReaderFullWidth}>−</button>
              <span class="popover-step-val" style={store.settings.proseReaderFullWidth ? "opacity: var(--component-reader-core-disabled-step-opacity);" : ""}>
                {store.settings.proseReaderFullWidth ? $_("ui_full") : `${proseContentWidth}px`}
              </span>
              <button class="popover-step-btn" onclick={() => updateContentWidth(40)} disabled={store.settings.proseReaderFullWidth}>+</button>
            </div>
            <button class="popover-btn" class:active={store.settings.proseReaderFullWidth} onclick={() => updateSettings({ proseReaderFullWidth: !store.settings.proseReaderFullWidth })}>{$_("ui_full")}</button>
          </dd>
        </div>
        <div>
          <dt>{$_("ui_flow")}</dt>
          <dd>
            <div class="popover-segmented">
              <button class="popover-segment" class:active={store.settings.bookReaderFlow !== "scrolled"} onclick={() => updateSettings({ bookReaderFlow: "paginated" })}>{$_("bookDetail_page")}</button>
              <button class="popover-segment" class:active={store.settings.bookReaderFlow === "scrolled"} onclick={() => updateSettings({ bookReaderFlow: "scrolled" })}>{$_("ui_scroll")}</button>
            </div>
          </dd>
        </div>
        <div class="popover-tts-row" onclick={() => activeSubPanel = "tts"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') activeSubPanel = "tts"; }}>
          <dt style="color: var(--reader-text);">{$_("ui_textToSpeech")}</dt>
          <dd style="color: var(--reader-accent-bright); font-weight: 600; display: flex; align-items: center; gap: 4px;">
            <span>{$_("ui_configure")}</span>
            <span class="popover-chevron">&gt;</span>
          </dd>
        </div>
      {:else if activeBook?.subtype === "pdf"}
        <div>
          <dt>{$_("ui_reflow")}</dt>
          <dd>
            <button class="popover-toggle" type="button" aria-label={$_("ui_togglePdfReflowMode")} title={$_("ui_togglePdfReflowMode")} class:active={pdfReflowMode} onclick={() => updateSettings({ pdfReflowMode: !pdfReflowMode })}></button>
          </dd>
        </div>
        {#if !pdfReflowMode}
        <div>
          <dt>{$_("ui_fitMode")}</dt>
          <dd>
            <button class="popover-btn" onclick={cyclePdfFit}>{pdfFitMode}</button>
          </dd>
        </div>
        <div>
          <dt>{$_("ui_zoom")}</dt>
          <dd>
            <div class="popover-stepper">
              <button class="popover-step-btn" onclick={() => adjustZoom(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN}>−</button>
              <span class="popover-step-val">{Math.round(zoom * 100)}%</span>
              <button class="popover-step-btn" onclick={() => adjustZoom(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX}>+</button>
            </div>
          </dd>
        </div>
        <div>
          <dt>{$_("ui_flow")}</dt>
          <dd>
            <div class="popover-segmented">
              <button class="popover-segment" class:active={store.settings.bookReaderFlow !== "scrolled"} onclick={() => updateSettings({ bookReaderFlow: "paginated" })}>{$_("bookDetail_page")}</button>
              <button class="popover-segment" class:active={store.settings.bookReaderFlow === "scrolled"} onclick={() => updateSettings({ bookReaderFlow: "scrolled" })}>{$_("ui_scroll")}</button>
            </div>
          </dd>
        </div>
        <div>
          <dt>{$_("ui_darkPdf")}</dt>
          <dd>
            <button class="popover-toggle" type="button" aria-label={$_("ui_toggleDarkPdfMode")} title={$_("ui_toggleDarkPdfMode")} class:active={pdfDarkMode} onclick={() => updateSettings({ pdfDarkMode: !pdfDarkMode })}></button>
          </dd>
        </div>
        <div>
          <dt>{$_("ui_fullWidth")}</dt>
          <dd>
            <button class="popover-toggle" type="button" aria-label={$_("ui_toggleFullWidthReading")} title={$_("ui_toggleFullWidthReading")} class:active={store.settings.proseReaderFullWidth} onclick={() => updateSettings({ proseReaderFullWidth: !store.settings.proseReaderFullWidth })}></button>
          </dd>
        </div>
        {/if}
        {#if pdfReflowMode}
          <div>
            <dt>{$_("ui_cleanBg")}</dt>
            <dd>
              <button
                class="popover-toggle"
                type="button"
                aria-label={$_("ui_removePdfBackgroundsAndWatermarks")}
                title={$_("ui_removePdfBackgroundsAndWatermarks")}
                class:active={pdfReflowCleanBackgrounds}
                onclick={() => updateSettings({ pdfReflowCleanBackgrounds: !pdfReflowCleanBackgrounds })}
              ></button>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_theme")}</dt>
            <dd>
              <div class="popover-color-swatches" style="display: flex; flex-wrap: wrap; gap: 4px; max-width: 150px;">
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("sepia")} class:active={proseTheme === "sepia"} onclick={() => updateAnchoredReaderSettings({ proseReaderTheme: "sepia" })} title={$_("ui_sepia")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("oled")} class:active={proseTheme === "oled"} onclick={() => updateAnchoredReaderSettings({ proseReaderTheme: "oled" })} title={$_("ui_oled")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("dark")} class:active={proseTheme === "dark"} onclick={() => updateAnchoredReaderSettings({ proseReaderTheme: "dark" })} title={$_("ui_dark")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("light")} class:active={proseTheme === "light"} onclick={() => updateAnchoredReaderSettings({ proseReaderTheme: "light" })} title={$_("ui_light")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("nocturne")} class:active={proseTheme === "nocturne"} onclick={() => updateAnchoredReaderSettings({ proseReaderTheme: "nocturne" })} title={$_("ui_nocturne")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("slate")} class:active={proseTheme === "slate"} onclick={() => updateAnchoredReaderSettings({ proseReaderTheme: "slate" })} title={$_("ui_slate")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("forest")} class:active={proseTheme === "forest"} onclick={() => updateAnchoredReaderSettings({ proseReaderTheme: "forest" })} title={$_("ui_forest")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("nord")} class:active={proseTheme === "nord"} onclick={() => updateAnchoredReaderSettings({ proseReaderTheme: "nord" })} title={$_("ui_nord")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("warm")} class:active={proseTheme === "warm"} onclick={() => updateAnchoredReaderSettings({ proseReaderTheme: "warm" })} title={$_("ui_warm")}></button>
              </div>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_textColor")}</dt>
            <dd>
              <input
                class="popover-color-picker"
                type="color"
                value={prosePalette.text}
                onchange={(event) => updateProseColor("text", event.currentTarget.value)}
                title={$_("ui_textColor_1c7a30e5")}
              />
            </dd>
          </div>
          <div>
            <dt>{$_("ui_paperColor")}</dt>
            <dd>
              <input
                class="popover-color-picker"
                type="color"
                value={prosePalette.surface}
                onchange={(event) => updateProseColor("background", event.currentTarget.value)}
                title={$_("ui_pageBackground")}
              />
            </dd>
          </div>
          <div>
            <dt>{$_("ui_font")}</dt>
            <dd>
              <select class="popover-select" value={proseFontFamily} onchange={(e) => updateAnchoredReaderSettings({ proseReaderFontFamily: (e.target as HTMLSelectElement).value })}>
                <option value="Georgia, serif">Georgia</option>
                <option value="Merriweather, Georgia, serif">Merriweather</option>
                <option value="'EB Garamond', serif">EB Garamond</option>
                <option value="Lora, serif">Lora</option>
                <option value="Literata, serif">Literata</option>
                <option value="Inter, sans-serif">Inter</option>
                <option value="Atkinson Hyperlegible, Inter, sans-serif">Atkinson</option>
                <option value='"Segoe UI", sans-serif'>Segoe UI</option>
              </select>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_textSize")}</dt>
            <dd>
              <div class="popover-stepper">
                <button class="popover-step-btn" onclick={() => updateFontSize(-1)} disabled={proseFontSize <= 12}>-</button>
                <span class="popover-step-val">{proseFontSize}{$_("ui_px_07a65dd6")}</span>
                <button class="popover-step-btn" onclick={() => updateFontSize(1)} disabled={proseFontSize >= 32}>+</button>
              </div>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_lineHeight")}</dt>
            <dd>
              <div class="popover-stepper">
                <button class="popover-step-btn" onclick={() => updateLineHeight(-0.05)} disabled={proseLineHeight <= 1.2}>-</button>
                <span class="popover-step-val">{proseLineHeight.toFixed(2)}</span>
                <button class="popover-step-btn" onclick={() => updateLineHeight(0.05)} disabled={proseLineHeight >= 2.4}>+</button>
              </div>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_align")}</dt>
            <dd>
              <div class="popover-segmented">
                <button class="popover-segment" class:active={proseTextAlign === "left"} onclick={() => updateAnchoredReaderSettings({ proseReaderTextAlign: "left" })}>{$_("ui_left")}</button>
                <button class="popover-segment" class:active={proseTextAlign === "justify"} onclick={() => updateAnchoredReaderSettings({ proseReaderTextAlign: "justify" })}>{$_("ui_justified")}</button>
              </div>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_width")}</dt>
            <dd style="display: flex; align-items: center; gap: 8px;">
              <div class="popover-stepper">
                <button class="popover-step-btn" onclick={() => updateContentWidth(-40)} disabled={store.settings.proseReaderFullWidth}>-</button>
                <span class="popover-step-val" style={store.settings.proseReaderFullWidth ? "opacity: var(--component-reader-core-disabled-step-opacity);" : ""}>
                  {store.settings.proseReaderFullWidth ? $_("ui_full") : `${proseContentWidth}px`}
                </span>
                <button class="popover-step-btn" onclick={() => updateContentWidth(40)} disabled={store.settings.proseReaderFullWidth}>+</button>
              </div>
              <button class="popover-btn" class:active={store.settings.proseReaderFullWidth} onclick={() => updateAnchoredReaderSettings({ proseReaderFullWidth: !store.settings.proseReaderFullWidth })}>{$_("ui_full")}</button>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_imageSize")}</dt>
            <dd>
              <div class="popover-stepper">
                <button class="popover-step-btn" onclick={() => updateIllustrationScale(-0.1)} disabled={pdfReflowIllustrationScale <= 0.5}>-</button>
                <span class="popover-step-val">{Math.round(pdfReflowIllustrationScale * 100)}%</span>
                <button class="popover-step-btn" onclick={() => updateIllustrationScale(0.1)} disabled={pdfReflowIllustrationScale >= 2}>+</button>
              </div>
            </dd>
          </div>
          <div class="popover-tts-row" onclick={() => { if (reflowedPages.length > 0) activeSubPanel = "tts"; }} role="button" tabindex="0" aria-disabled={reflowedPages.length === 0} onkeydown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && reflowedPages.length > 0) activeSubPanel = "tts"; }}>
            <dt style="color: var(--reader-text);">{$_("ui_textToSpeech")}</dt>
            <dd style="color: var(--reader-accent-bright); font-weight: 600; display: flex; align-items: center; gap: 4px;">
              <span>{reflowedPages.length > 0 ? $_("ui_configure") : $_("ui_waitingForReflow")}</span>
              <span class="popover-chevron">&gt;</span>
            </dd>
          </div>
        {/if}
      {/if}
      {/if}
    </dl>
    {/if}
  {/snippet}

  <div
    class="viewer book-viewer"
    class:pdf={activeBook?.subtype === "pdf"}
    class:pdf-dark={pdfDarkMode}
    class:pdf-reflow={pdfReflowMode}
    class:full-width-panel={store.settings.proseReaderFullWidth}
    style={`--prose-page-bg:${prosePalette.bg};--prose-bg:${prosePalette.surface};--prose-text:${prosePalette.text};--prose-content-width:${proseContentWidth}px;--prose-font-family:${proseFontFamily};--prose-font-size:${proseFontSize}px;--prose-line-height:${proseLineHeight};--prose-paragraph-spacing:${proseParagraphSpacing}em;--prose-text-align:${proseTextAlign};--pdf-reflow-image-scale:${pdfReflowIllustrationScale};`}
    onclick={handleViewerClick}
    onwheel={handleViewerWheel}
    role="presentation"
  >
    {#if waitingForBookHydration}
      <div class="center-overlay">
        <CircleNotch size={20} weight="light" class="anim-spin" style="color:var(--text-faint)" />
      </div>
    {/if}

    {#if activeBook?.subtype === "epub"}
      <div class="epub-host" bind:this={hostEl}></div>
    {:else if activeBook?.subtype === "pdf"}
      {#if pdfReflowMode}
        <div class="pdf-reflow-stage">
          {#each reflowPageNumbers as pageNum}
            {@const page = getReflowPage(pageNum)}
            <section class="pdf-reflow-page" data-page={pageNum} use:lazyRenderReflowPage={pageNum}>
              {#if page}
                {#if page.elements.length}
                  {#each page.elements as element, index}
                    {#if element.type === "heading"}
                      <svelte:element this={`h${element.level}`} id={getReflowElementKey(pageNum, index)}>{element.text}</svelte:element>
                    {:else if element.type === "paragraph"}
                      <p id={getReflowElementKey(pageNum, index)}>{element.text}</p>
                    {:else if element.type === "image"}
                      <figure class="pdf-reflow-figure" id={getReflowElementKey(pageNum, index)}>
                        <canvas
                          aria-label={`Illustration from page ${pageNum}`}
                          width={element.width}
                          height={element.height}
                          style={`aspect-ratio:${element.width}/${element.height}`}
                          use:renderReflowImage={element.objectId}
                        ></canvas>
                      </figure>
                    {/if}
                  {/each}
                {:else}
                  <div class="pdf-reflow-empty" aria-label={`Blank PDF page ${pageNum}`}></div>
                {/if}
              {:else}
                <div class="pdf-reflow-placeholder">
                  <CircleNotch size={18} weight="light" class="anim-spin" />
                </div>
              {/if}
            </section>
          {/each}
        </div>
      {:else if store.settings.bookReaderFlow === "scrolled"}
        <div class="pdf-scroll-stage">
          {#each Array.from({ length: totalPages }, (_, i) => i + 1) as pageNum}
            <div class="pdf-page-wrapper" data-page={pageNum} use:lazyRenderPdfPage={{ pageNum, zoom, pdfFitMode, documentGeneration: pdfDocumentGeneration }}>
              <!-- Canvas is dynamically appended in the lazyRenderPdfPage action -->
            </div>
          {/each}
        </div>
      {:else}
        <div class="pdf-stage">
          <canvas bind:this={canvasEl}></canvas>
        </div>
      {/if}
    {/if}

    {#if loading}
      <div class="center-overlay">
        <CircleNotch size={20} weight="light" class="anim-spin" style="color:var(--text-faint)" />
      </div>
    {/if}
    {#if error}
      <div class="center-overlay error-stack">
        <NocturneState
          layout="center"
          tone="danger"
          icon="warning"
          eyebrow={$_("ui_reader")}
          title={$_("bookDetail_errors_couldNotOpen")}
          body={error}
        />
      </div>
    {/if}
  </div>
</ReaderHud>

<style>
  .book-viewer {
    flex: 1;
    overflow: auto;
    display: flex;
    align-items: stretch;
    justify-content: center;
    position: relative;
    background: var(--component-reader-core-prose-viewer-bg);
    color: var(--component-reader-core-book-viewer-fg);
  }

  .book-viewer.pdf {
    align-items: flex-start;
    padding: var(--sp-5) 0;
  }

  .epub-host {
    width: min(var(--prose-content-width, 920px), 100%);
    height: 100%;
    margin: var(--sp-3) 0;
    border: var(--component-reader-core-prose-panel-border);
    border-radius: var(--component-reader-core-prose-panel-radius);
    background: var(--component-reader-core-epub-bg);
    color: var(--component-reader-core-epub-fg);
    box-shadow: var(--component-reader-core-prose-panel-shadow);
    overflow: hidden;
  }

  .pdf-stage {
    display: flex;
    justify-content: center;
    min-width: 100%;
  }

  .pdf-stage canvas {
    display: block;
    background: var(--component-reader-core-pdf-page-bg);
    border-radius: var(--component-reader-core-pdf-page-radius);
    box-shadow: var(--component-reader-core-pdf-page-shadow);
  }

  .book-viewer.pdf-dark .pdf-stage canvas,
  .book-viewer.pdf-dark :global(.pdf-page-wrapper canvas) {
    filter: invert(1) hue-rotate(180deg) contrast(0.92);
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
    background: var(--component-reader-core-error-overlay-bg);
  }

  /* Full Width Reading Panel */
  .book-viewer.full-width-panel .epub-host {
    width: 100%;
    max-width: 100%;
    height: 100%;
    margin: 0;
    border: none;
    border-radius: var(--component-reader-core-prose-panel-full-radius);
    box-shadow: var(--component-reader-core-prose-panel-full-shadow);
  }

  .book-viewer.full-width-panel .pdf-scroll-stage,
  .book-viewer.full-width-panel .pdf-stage,
  .book-viewer.full-width-panel .pdf-reflow-stage {
    width: 100%;
    max-width: 100%;
    padding: 0;
  }

  .pdf-reflow-stage {
    width: min(var(--prose-content-width, 760px), calc(100% - 32px));
    margin: 0 auto;
    padding: clamp(24px, 5vw, 64px) 0;
    color: var(--component-reader-core-pdf-reflow-fg);
    font-family: var(--prose-font-family, Georgia, serif);
  }

  .pdf-reflow-page {
    min-height: 48px;
    padding: 0;
  }

  .pdf-reflow-page + .pdf-reflow-page {
    margin-top: var(--prose-paragraph-spacing, 1.1em);
  }

  .pdf-reflow-page :is(h1, h2, h3) {
    max-width: 100%;
    margin: 1.7em 0 0.75em;
    color: var(--component-reader-core-pdf-reflow-fg);
    font-family: var(--prose-font-family, Georgia, serif);
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: 0;
    text-align: var(--prose-text-align, left);
  }

  .pdf-reflow-page h1 {
    font-size: calc(var(--prose-font-size, 18px) * 1.75);
  }

  .pdf-reflow-page h2,
  .pdf-reflow-page h3 {
    font-size: calc(var(--prose-font-size, 18px) * 1.28);
  }

  .pdf-reflow-page p {
    margin: 0 0 var(--prose-paragraph-spacing, 1.1em);
    color: var(--component-reader-core-pdf-reflow-fg);
    font-family: var(--prose-font-family, Georgia, serif);
    font-size: var(--prose-font-size, 18px);
    line-height: var(--prose-line-height, 1.75);
    letter-spacing: 0;
    text-align: var(--prose-text-align, left);
    overflow-wrap: anywhere;
  }

  .pdf-reflow-figure {
    display: flex;
    justify-content: center;
    width: min(calc(100vw - 40px), calc(min(var(--prose-content-width, 760px), 760px) * var(--pdf-reflow-image-scale, 1)));
    margin: clamp(18px, 4vw, 40px) 0;
    margin-left: 50%;
    transform: translateX(-50%);
  }

  .pdf-reflow-figure canvas {
    display: block;
    width: 100%;
    height: auto;
    max-height: calc(86vh * var(--pdf-reflow-image-scale, 1));
    object-fit: contain;
    background: transparent;
    border-radius: var(--component-reader-core-pdf-figure-radius);
  }

  .pdf-reflow-placeholder,
  .pdf-reflow-empty {
    min-height: 64px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--component-reader-core-pdf-placeholder-fg);
  }

  /* PDF Scrolled Continuous Reading Mode */
  .pdf-scroll-stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-4);
    width: 100%;
    height: auto;
    padding: var(--sp-4) 0;
  }

  .pdf-page-wrapper {
    display: flex;
    justify-content: center;
    align-items: center;
    width: 100%;
    min-height: 500px;
    position: relative;
  }

  :global(.pdf-page-wrapper canvas) {
    display: block;
    background: var(--component-reader-core-pdf-page-bg);
    border-radius: var(--component-reader-core-pdf-page-radius);
    box-shadow: var(--component-reader-core-pdf-page-compact-shadow);
  }
</style>
