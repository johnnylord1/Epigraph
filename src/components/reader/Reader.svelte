<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { onMount, onDestroy, untrack, tick } from "svelte";
  import {
    X, CaretLeft, CaretRight, ArrowLeft, ArrowRight,
    Square, Rows, Download, ArrowsLeftRight,
    CircleNotch, MagnifyingGlassMinus, MagnifyingGlassPlus,
    Bookmark, BookOpen, MonitorPlay, GlobeHemisphereWest, ArrowSquareOut,
    SlidersHorizontal,
  } from "phosphor-svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { open } from "@tauri-apps/plugin-shell";
  import { getServerAuthHeader, getServerUrl, gql, thumbUrl } from "../../lib/client";
  import { acquireResolvedMediaUrl, preloadBlobUrls, resetImageCache, resolvedImage, warmResolvedMediaUrl } from "../../lib/imageCache";
  import { MARK_CHAPTER_READ, ENQUEUE_DOWNLOAD, ENQUEUE_CHAPTERS_DOWNLOAD } from "../../lib/queries";
  import { fetchSourceChapterPages } from "../../lib/manga/runtime";
  import { toSuwayomiWebViewUrl } from "../../lib/suwayomiWebView";
  import { store, closeReader, openReader, addHistory, updateSettings, checkAndMarkCompleted, setSettingsOpen, addBookmark, removeBookmark } from "../../store/state.svelte";
  import { matchesKeybind, toggleFullscreen, DEFAULT_KEYBINDS } from "../../lib/keybinds";
  import { loadOfflineMangaChapter, revokeOfflineMangaPages } from "../../lib/reader/offlineManga";
  import { isReaderControlKeyboardTarget, registerReaderCommandHandler } from "../../lib/reader/commands";
  import { setReading } from "../../lib/discord";
  import { canResolveDiscordCover, canRunDiscordCoverImprovement } from "../../lib/discord/coverImprovementGate";
  import { isDiscordPublicImageUrl } from "../../lib/discord/coverResolver";
  import { discordCoverService, type DiscordCoverSource } from "../../lib/discord/discordCoverService";
  import { discordPublicCoverResolver } from "../../lib/discord/discordPublicCoverResolver";
  import { resolveTrackedMangaDiscordCover } from "../../lib/discord/trackerCoverResolver";
  import type { FitMode } from "../../store/state.svelte";
  import type { Manga } from "../../lib/types";
  import NocturneState from "../shared/NocturneState.svelte";
  import ReaderHud from "./ReaderHud.svelte";

  const AVG_MIN_PER_PAGE = 0.33;
  const READ_LINE_PCT    = 0.20;
  const ZOOM_STEP        = 0.05;
  const ZOOM_MIN         = 0.1;
  const ZOOM_MAX         = 1.0;
  const STRIP_WINDOW_RADIUS = 1;
  const MAX_ASPECT_CACHE_ENTRIES = 500;
  const PRELOAD_FORWARD_PAGES = 2;
  const PRELOAD_BACKWARD_PAGES = 1;
  const EMPTY_PAGES_RETRY_MS = 800;

  const PAGE_STYLES = ["single", "fade", "double", "longstrip"] as const;
  type PageStyle = typeof PAGE_STYLES[number];

  const pageCache = new Map<number, string[]>();
  const inflight  = new Map<number, Promise<string[]>>();
  let offlinePageUrls: string[] = [];

  function clearOfflinePages() {
    revokeOfflineMangaPages(offlinePageUrls);
    offlinePageUrls = [];
  }

  function isCloudflareLikeError(message: string | null): boolean {
    if (!message) return false;
    const normalized = message.toLowerCase();
    return normalized.includes("cloudflare")
      || normalized.includes("captcha")
      || normalized.includes("challenge")
      || normalized.includes("just a moment")
      || normalized.includes("bypass");
  }

  function clearChapterPageCache(chapterId: number) {
    pageCache.delete(chapterId);
    inflight.delete(chapterId);
  }

  function fetchPages(chapterId: number, signal?: AbortSignal): Promise<string[]> {
    const cached = pageCache.get(chapterId);
    if (cached?.length) return Promise.resolve(cached);
    if (cached && cached.length === 0) pageCache.delete(chapterId);
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (!inflight.has(chapterId)) {
      const p = fetchSourceChapterPages({ chapterId })
        .then(d => {
          const urls = d.fetchChapterPages.pages.map(thumbUrl);
          if (urls.length) {
            void preloadBlobUrls(urls.slice(0, 2), 0).catch(() => {});
            pageCache.set(chapterId, urls);
          }
          return urls;
        })
        .finally(() => inflight.delete(chapterId));
      inflight.set(chapterId, p);
    }
    const base = inflight.get(chapterId)!;
    if (!signal) return base;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      base.then(resolve, reject);
    });
  }

  function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function fetchPagesWithEmptyRetry(id: number, signal: AbortSignal): Promise<string[]> {
    let urls = await fetchPages(id, signal);
    if (urls.length > 0 || signal.aborted) return urls;

    clearChapterPageCache(id);
    await sleep(EMPTY_PAGES_RETRY_MS);
    if (signal.aborted) return [];

    urls = await fetchPages(id, signal);
    if (urls.length === 0) {
      throw new Error("No pages returned for this chapter. The source may still be preparing the chapter or blocking image fetches.");
    }
    return urls;
  }

  const aspectCache = new Map<string, number>();
  function rememberAspect(url: string, aspect: number) {
    if (aspectCache.has(url)) aspectCache.delete(url);
    aspectCache.set(url, aspect);
    while (aspectCache.size > MAX_ASPECT_CACHE_ENTRIES) {
      const oldest = aspectCache.keys().next().value;
      if (!oldest) break;
      aspectCache.delete(oldest);
    }
  }

  function preloadImage(url: string) {
    if (!url) return;
    if (store.settings.serverAuthEnabled) {
      void warmResolvedMediaUrl(url).catch(() => {});
      return;
    }
    new Image().src = url;
  }

  function measureAspect(url: string): Promise<number> {
    if (aspectCache.has(url)) return Promise.resolve(aspectCache.get(url)!);
    return new Promise(res => {
      const img = new Image();
      let release: (() => void) | null = null;
      let resolved = false;
      const finish = (value: number) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        release?.();
        release = null;
        res(value);
      };

      const timeoutId = setTimeout(() => {
        finish(0.67);
      }, 4000);

      img.onload  = () => {
        const r = img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 0.67;
        rememberAspect(url, r);
        finish(r);
      };
      img.onerror = () => finish(0.67);
      acquireResolvedMediaUrl(url)
        .then((lease) => {
          if (resolved) { lease.release(); return; }
          release = lease.release;
          img.src = lease.resolvedUrl;
        })
        .catch(() => {
          if (resolved) return;
          img.src = url;
        });
    });
  }

  interface StripChapter { chapterId: number; chapterName: string; urls: string[]; }

  let containerEl: HTMLDivElement;
  let containerWidth = $state(0);
  let zoomAnchorEl:     HTMLElement | null = null;
  let zoomAnchorOffset: number             = 0;
  let zoomRestoreRafId: number | null = null;

  function captureZoomAnchor() {
    if (!containerEl || style !== "longstrip") return;
    const imgs = containerEl.querySelectorAll<HTMLElement>("img[data-local-page]");
    const containerTop = containerEl.getBoundingClientRect().top;
    for (const img of imgs) {
      const rect = img.getBoundingClientRect();
      if (rect.bottom > containerTop) {
        zoomAnchorEl     = img;
        zoomAnchorOffset = rect.top - containerTop;
        return;
      }
    }
  }

  function restoreZoomAnchor() {
    if (!zoomAnchorEl || !containerEl) return;
    const el = zoomAnchorEl;
    zoomAnchorEl = null;
    if (zoomRestoreRafId !== null) cancelAnimationFrame(zoomRestoreRafId);
    zoomRestoreRafId = requestAnimationFrame(() => {
      zoomRestoreRafId = null;
      if (!containerEl || !el.isConnected) return;
      const containerTop = containerEl.getBoundingClientRect().top;
      const newRect      = el.getBoundingClientRect();
      containerEl.scrollTop += (newRect.top - containerTop) - zoomAnchorOffset;
    });
  }

  let loading          = $state(true);
  let error: string | null = $state(null);
  let dlOpen           = $state(false);
  let zoomOpen         = $state(false);
  let toolsOpen        = $state(false);
  let activeSubPanel   = $state<"main" | "reading" | "display" | "behavior" | "downloads">("main");
  let uiVisible        = $state(true);
  let pageReady        = $state(false);
  let pageGroups: number[][] = $state([]);
  let stripChapters: StripChapter[] = $state([]);
  let visibleChapterId: number | null = $state(null);
  let nextN            = $state(5);
  let dlBusy           = $state(false);
  let hideTimer:       ReturnType<typeof setTimeout> | null = null;
  let markedRead       = new Set<number>();
  let appending        = false;
  let abortCtrl:       AbortController | null = null;
  let hasNavigated     = false;
  let resumePage        = $state(0);
  let resumeDismissed   = $state(false);
  let resumeTimer:      ReturnType<typeof setTimeout> | null = null;
  let resumeFadeTimer:  ReturnType<typeof setTimeout> | null = null;
  let resumeFading      = $state(false);
  let resumeVisible     = $state(false);
  let webViewWindowOpen = $state(false);
  let retryingAfterWebViewClose = false;
  let emptyReaderRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerInsideHud = false;
  let readerSessionGeneration = 0;
  let resumeRafId: number | null = null;
  let scrollTrackingRafId: number | null = null;
  let preloadedChapterIds = new Set<number>();
  let autoAppendedChapterIds = new Set<number>();

  function scheduleResumeDismiss() {
    if (resumeTimer)     clearTimeout(resumeTimer);
    if (resumeFadeTimer) clearTimeout(resumeFadeTimer);
    resumeFading  = false;
    resumeFadeTimer = setTimeout(() => { resumeFading = true; },  1500);
    resumeTimer     = setTimeout(() => { resumeVisible = false; resumeFading = false; }, 2500);
  }
  let stripResumeReady  = $state(false);
  let fadingOut         = $state(false);
  let sliderDragging    = $state(false);
  let sliderHover       = $state(false);

  const rtl         = $derived(store.settings.readingDirection === "rtl");
  const fit         = $derived((store.settings.fitMode ?? "width") as FitMode);
  const style       = $derived((store.settings.pageStyle ?? "single") as PageStyle);
  const zoom        = $derived(store.settings.readerZoom ?? 1.0);
  const autoNext    = $derived(store.settings.autoNextChapter ?? false);
  const markOnNext  = $derived(store.settings.markReadOnNext ?? true);
  const overlayBars = $derived(store.settings.overlayBars ?? false);
  const lastPage    = $derived(store.pageUrls.length);
  const effectiveWidth = $derived(containerWidth > 0 ? Math.round(containerWidth * zoom) : undefined);
  const zoomPct = $derived(Math.round(zoom * 100));

  const displayChapter = $derived(
    style === "longstrip" && visibleChapterId
      ? (store.activeChapterList.find(c => c.id === visibleChapterId) ?? store.activeChapter)
      : store.activeChapter
  );
  const currentBookmark = $derived(displayChapter ? store.bookmarks.find(b => b.chapterId === displayChapter!.id) : undefined);
  const isBookmarked = $derived(!!currentBookmark && currentBookmark.pageNumber === store.pageNumber);

  const showResumeBanner = $derived(
    resumeVisible && resumePage > 1 &&
    (style === "longstrip" ? stripResumeReady : store.pageNumber === resumePage)
  );

  const adjacent = $derived.by(() => {
    const ref = displayChapter ?? store.activeChapter;
    if (!ref || !store.activeChapterList.length) return { prev: null, next: null, remaining: [] };
    const idx = store.activeChapterList.findIndex(c => c.id === ref.id);
    return {
      prev:      idx > 0                                   ? store.activeChapterList[idx - 1] : null,
      next:      idx < store.activeChapterList.length - 1 ? store.activeChapterList[idx + 1] : null,
      remaining: store.activeChapterList.slice(idx + 1),
    };
  });

  const visibleChunkLastPage = $derived.by(() => {
    if (style !== "longstrip") return lastPage;
    const chId  = visibleChapterId ?? store.activeChapter?.id;
    const chunk = stripChapters.find(c => c.chapterId === chId);
    return chunk?.urls.length ?? lastPage;
  });

  const imgCls = $derived([
    "img",
    fit === "width"    && "fit-width",
    fit === "height"   && "fit-height",
    fit === "screen"   && "fit-screen",
    fit === "original" && "fit-original",
    store.settings.optimizeContrast && "optimize-contrast",
  ].filter(Boolean).join(" "));

  const fitLabel = $derived({ width: "Fit W", height: "Fit H", screen: "Fit Screen", original: "1:1" }[fit]);
  const webViewUrl = $derived(displayChapter?.realUrl ?? store.activeChapter?.realUrl ?? null);
  const suwayomiWebViewUrl = $derived.by(() => {
    if (!webViewUrl) return null;
    try {
      return toSuwayomiWebViewUrl(getServerUrl(), webViewUrl);
    } catch {
      return webViewUrl;
    }
  });
  const canOpenWebView = $derived(!!webViewUrl);

  const stripToRender = $derived(
    style === "longstrip"
      ? (stripChapters.length > 0
          ? stripChapters
          : [{ chapterId: store.activeChapter?.id ?? 0, chapterName: store.activeChapter?.name ?? "", urls: store.pageUrls }])
      : []
  );

  const currentGroup = $derived(
    style === "double" && pageGroups.length
      ? (pageGroups.find(g => g.includes(store.pageNumber)) ?? [store.pageNumber])
      : [store.pageNumber]
  );

  const sliderPage = $derived.by(() => {
    if (style === "double" && pageGroups.length) {
      return pageGroups.findIndex(g => g.includes(store.pageNumber)) + 1;
    }
    return store.pageNumber;
  });

  const sliderMax = $derived.by(() => {
    if (style === "double" && pageGroups.length) return pageGroups.length;
    if (style === "longstrip") return visibleChunkLastPage || 1;
    return lastPage || 1;
  });

  const sliderPct = $derived(sliderMax > 1 ? ((sliderPage - 1) / (sliderMax - 1)) * 100 : 0);
  let lastDiscordMangaId: number | null = null;
  let lastDiscordChapterId: number | null = null;
  let lastDiscordPrivacySignature: string | null = null;
  let mangaTrackerStateVersion = $state(0);
  let discordCoverMangaId: number | null = null;
  let discordCoverLookupKey: string | null = null;
  let discordCoverLookupVersion = 0;
  let discordPublicCoverUrl: string | null = null;

  $effect(() => {
    const handleTrackerStateChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; mangaId?: number | string | null }>).detail;
      if (detail?.kind && detail.kind !== "comic") return;
      const changedMangaId = detail?.mangaId == null ? null : Number(detail.mangaId);
      if (Number.isFinite(changedMangaId) && store.activeManga?.id !== changedMangaId) return;
      mangaTrackerStateVersion += 1;
    };
    globalThis.addEventListener?.("epigraph-tracker-state-changed", handleTrackerStateChanged);
    return () => {
      globalThis.removeEventListener?.("epigraph-tracker-state-changed", handleTrackerStateChanged);
    };
  });

  function canResolveDiscordExternalCover() {
    return canResolveDiscordCover(store.settings);
  }

  function absoluteServerMediaUrl(path: string): string | null {
    try {
      return new URL(path, `${getServerUrl()}/`).toString();
    } catch {
      return null;
    }
  }

  function mangaDiscordCoverSource(manga: Manga): DiscordCoverSource | null {
    const thumbnail = typeof manga.thumbnailUrl === "string" ? manga.thumbnailUrl.trim() : "";
    if (!thumbnail) return null;
    if (isDiscordPublicImageUrl(thumbnail)) return { type: "public-url", value: thumbnail };
    const trustedUrl = absoluteServerMediaUrl(thumbnail);
    if (!trustedUrl) return null;
    return {
      type: "trusted-thumbnail",
      value: trustedUrl,
      trustedLocalBaseUrl: getServerUrl(),
      authHeader: getServerAuthHeader(),
    };
  }

  function coverSourceKey(source: DiscordCoverSource | null): string | null {
    if (!source?.value) return null;
    if (source.type === "trusted-thumbnail") {
      return `${source.type}:${source.value}:${source.trustedLocalBaseUrl ?? ""}`;
    }
    return `${source.type}:${source.value}`;
  }

  function publishResolvedDiscordCover(manga: Manga, coverUrl: string, lookupVersion: number) {
    if (lookupVersion !== discordCoverLookupVersion) return;
    if (store.activeManga?.id !== manga.id || !canResolveDiscordExternalCover()) return;
    const chapter = store.activeChapter;
    if (!chapter) return;
    discordPublicCoverUrl = coverUrl;
    void setReading(manga, chapter, {
      progressPercent: sliderPct,
      publicCoverUrl: coverUrl,
      settings: store.settings,
      reason: "work-change",
    });
  }

  function refreshDiscordCoverForManga(manga: Manga) {
    const publicThumbnail = isDiscordPublicImageUrl(manga.thumbnailUrl) ? manga.thumbnailUrl : null;
    const shouldImproveCover = canRunDiscordCoverImprovement(store.settings);
    if (manga.id !== discordCoverMangaId) {
      discordCoverMangaId = manga.id;
      discordCoverLookupKey = null;
      discordPublicCoverUrl = publicThumbnail;
      discordCoverLookupVersion += 1;
    }

    if (!canResolveDiscordExternalCover()) {
      discordPublicCoverUrl = null;
      return;
    }

    const source = mangaDiscordCoverSource(manga);
    const key = [
      "tracker-first",
      publicThumbnail ?? "",
      mangaTrackerStateVersion,
      coverSourceKey(source) ?? "",
    ].join(":");
    if (discordCoverLookupKey === key) return;
    const lookupVersion = ++discordCoverLookupVersion;
    discordCoverLookupKey = key;
    void discordPublicCoverResolver.resolve({
      settings: store.settings,
      workKind: "comic",
      workId: manga.id,
      existingPublicCoverUrl: publicThumbnail,
      trackerKey: `manga-track-records:${mangaTrackerStateVersion}`,
      resolveTrackerCover: () => resolveTrackedMangaDiscordCover(manga.id),
      workerSource: shouldImproveCover ? source : null,
      resolveWorkerCover: shouldImproveCover && source
        ? (candidate) => discordCoverService.resolveOptimizedCover({
            settings: store.settings,
            workKind: "comic",
            workId: manga.id,
            source: candidate,
          })
        : null,
    }).then((result) => {
      if (result?.url) publishResolvedDiscordCover(manga, result.url, lookupVersion);
    });
  }

  $effect(() => {
    mangaTrackerStateVersion;
    const chapter = displayChapter;
    const manga   = store.activeManga;
    if (!store.settings.discordRpc || !chapter || !manga) {
      lastDiscordPrivacySignature = null;
      return;
    }
    refreshDiscordCoverForManga(manga);
    const privacySignature = JSON.stringify({
      privateMode: store.settings.discordRpcPrivateMode,
      showCover: store.settings.discordRpcShowCover,
      improveCovers: store.settings.discordRpcImproveCovers,
      showProgress: store.settings.discordRpcShowProgress,
      showTitle: store.settings.discordRpcShowTitle,
    });
    const reason = manga.id !== lastDiscordMangaId
      ? "work-change"
      : chapter.id !== lastDiscordChapterId
        ? "chapter-change"
        : privacySignature !== lastDiscordPrivacySignature
          ? "privacy-change"
          : "progress";
    lastDiscordMangaId = manga.id;
    lastDiscordChapterId = chapter.id;
    lastDiscordPrivacySignature = privacySignature;
    void setReading(manga, chapter, {
      progressPercent: sliderPct,
      publicCoverUrl: discordPublicCoverUrl,
      settings: store.settings,
      reason,
    });
  });

  $effect(() => {
    const ch = store.activeChapter;
    if (ch) untrack(() => loadChapter(ch.id));
  });

  $effect(() => {
    const ch = store.activeChapter;
    const hasPages = store.pageUrls.length > 0;
    if (!ch || loading || error || hasPages) {
      if (emptyReaderRecoveryTimer) {
        clearTimeout(emptyReaderRecoveryTimer);
        emptyReaderRecoveryTimer = null;
      }
      return;
    }

    emptyReaderRecoveryTimer = setTimeout(() => {
      emptyReaderRecoveryTimer = null;
      const current = store.activeChapter;
      if (current && current.id === ch.id && !loading && !error && store.pageUrls.length === 0) {
        void loadChapter(current.id);
      }
    }, 250);

    return () => {
      if (emptyReaderRecoveryTimer) {
        clearTimeout(emptyReaderRecoveryTimer);
        emptyReaderRecoveryTimer = null;
      }
    };
  });

  async function loadChapter(id: number) {
    readerSessionGeneration += 1;
    abortCtrl?.abort();
    const ctrl = new AbortController();
    abortCtrl  = ctrl;
    hasNavigated     = false;
    appending        = false;
    markedRead       = new Set();
    preloadedChapterIds = new Set();
    autoAppendedChapterIds = new Set();
    loading          = true;
    error            = null;
    pageGroups       = [];
    pageReady        = false;
    resetReaderSessionCaches();
    clearOfflinePages();
    store.pageUrls   = [];
    fadingOut        = false;
    closeReaderWebView().catch(() => {});

    const bookmark  = store.bookmarks.find(b => b.chapterId === id);
    const resumeTo  = bookmark ? bookmark.pageNumber : 0;
    resumePage      = resumeTo > 1 ? resumeTo : 0;
    resumeDismissed  = false;
    resumeVisible    = resumeTo > 1;
    if (resumeTo > 1) scheduleResumeDismiss();
    stripResumeReady = false;

    store.pageNumber = 1;
    try {
      let urls: string[];
      try {
        urls = await fetchPagesWithEmptyRetry(id, ctrl.signal);
      } catch (networkError) {
        const chapter = store.activeChapter;
        const manga = store.activeManga;
        if (!chapter?.isDownloaded || chapter.id !== id || !manga?.source?.displayName) throw networkError;
        urls = await loadOfflineMangaChapter({
          downloadsPath: store.settings.serverDownloadsPath ?? "",
          sourceName: manga.source.displayName,
          mangaTitle: manga.title,
          chapterName: chapter.name,
          scanlator: chapter.scanlator,
        });
        if (urls.length === 0) throw networkError;
        offlinePageUrls = urls;
      }
      if (ctrl.signal.aborted) return;
      store.pageUrls = urls;
      if (resumeTo > 1) store.pageNumber = Math.min(resumeTo, urls.length || resumeTo);
      pageReady = true;
      loading   = false;
    } catch (e: any) {
      if (ctrl.signal.aborted) return;
      error   = e instanceof Error ? e.message : String(e);
      loading = false;
    }
  }

  $effect(() => {
    if (style === "longstrip" && store.pageUrls.length && store.activeChapter) {
      const ch       = store.activeChapter;
      const urls     = store.pageUrls;
      const targetPg = untrack(() => resumePage);
      appending        = false;
      stripChapters    = [{ chapterId: ch.id, chapterName: ch.name, urls }];
      visibleChapterId = ch.id;
      tick().then(() => {
        if (!containerEl) return;
        if (targetPg > 1) {
          const chId = ch.id;
          const generation = readerSessionGeneration;
          let attempts = 0;
          const scrollToResumePage = () => {
            resumeRafId = null;
            if (
              generation !== readerSessionGeneration
              || store.activeChapter?.id !== chId
              || style !== "longstrip"
              || !containerEl
            ) return;
            const target = containerEl.querySelector<HTMLImageElement>(`img[data-local-page="${targetPg}"][data-chapter="${chId}"]`);
            if (!target) {
              attempts += 1;
              if (attempts < 120) resumeRafId = requestAnimationFrame(scrollToResumePage);
              return;
            }
            containerEl.querySelectorAll<HTMLImageElement>(`img[data-chapter="${chId}"]`).forEach((img, i) => { if (i < targetPg) img.loading = "eager"; });
            const doScroll = () => {
              if (generation !== readerSessionGeneration || !target.isConnected) return;
              target.scrollIntoView({ block: "start" });
              stripResumeReady = true;
            };
            if (target.complete && target.naturalHeight > 0) { doScroll(); }
            else { target.loading = "eager"; target.addEventListener("load", doScroll, { once: true }); }
          };
          if (resumeRafId !== null) cancelAnimationFrame(resumeRafId);
          scrollToResumePage();
          return;
        }
        containerEl.scrollTop = 0;
      });
    }
  });

  function pruneStripWindow(anchorChapterId: number | null) {
    if (style !== "longstrip" || !anchorChapterId || stripChapters.length <= (STRIP_WINDOW_RADIUS * 2 + 1)) return;
    const list = store.activeChapterList;
    const anchorIndex = list.findIndex((chapter) => chapter.id === anchorChapterId);
    if (anchorIndex < 0) return;

    const keepIds = new Set(
      list
        .slice(Math.max(0, anchorIndex - STRIP_WINDOW_RADIUS), anchorIndex + STRIP_WINDOW_RADIUS + 1)
        .map((chapter) => chapter.id),
    );

    const removed = stripChapters.filter((chunk) => !keepIds.has(chunk.chapterId));
    if (!removed.length) return;

    stripChapters = stripChapters.filter((chunk) => keepIds.has(chunk.chapterId));
    for (const chunk of removed) {
      clearChapterPageCache(chunk.chapterId);
    }
  }

  function resetReaderSessionCaches() {
    if (resumeRafId !== null) {
      cancelAnimationFrame(resumeRafId);
      resumeRafId = null;
    }
    if (scrollTrackingRafId !== null) {
      cancelAnimationFrame(scrollTrackingRafId);
      scrollTrackingRafId = null;
    }
    if (zoomRestoreRafId !== null) {
      cancelAnimationFrame(zoomRestoreRafId);
      zoomRestoreRafId = null;
    }
    pageCache.clear();
    inflight.clear();
    aspectCache.clear();
    stripChapters = [];
    visibleChapterId = null;
    resetImageCache();
  }

  $effect(() => { if (style !== "longstrip" && containerEl) containerEl.scrollTop = 0; });

  $effect(() => {
    const chId = visibleChapterId;
    if (!chId || style !== "longstrip") return;
    if (chId === store.activeChapter?.id) return;
    // Only resume if this chapter was opened directly, not auto-appended while reading
    const wasAppended = untrack(() => stripChapters.findIndex(c => c.chapterId === chId)) > 0;
    if (wasAppended) { untrack(() => { resumePage = 0; resumeVisible = false; }); return; }
    const bookmark = store.bookmarks.find(b => b.chapterId === chId);
    if (bookmark && bookmark.pageNumber > 1) {
      untrack(() => {
        resumePage = bookmark.pageNumber; resumeDismissed = false; resumeVisible = true; stripResumeReady = true;
        scheduleResumeDismiss();
      });
    } else {
      untrack(() => { resumePage = 0; resumeDismissed = false; resumeVisible = false; stripResumeReady = false; });
    }
  });

  function appendNextChapter() {
    if (appending || !stripChapters.length) return;
    const lastChunk = stripChapters[stripChapters.length - 1];
    const list      = store.activeChapterList;
    const lastIdx   = list.findIndex(c => c.id === lastChunk.chapterId);
    if (lastIdx < 0 || lastIdx >= list.length - 1) return;
    const next = list[lastIdx + 1];
    if (
      !next
      || stripChapters.some(c => c.chapterId === next.id)
      || autoAppendedChapterIds.has(next.id)
    ) return;
    const generation = readerSessionGeneration;
    appending = true;
    fetchPages(next.id)
      .then(urls => {
        urls.slice(0, PRELOAD_FORWARD_PAGES).forEach(preloadImage);
        return urls;
      })
      .then(urls => {
        if (generation !== readerSessionGeneration || !autoNext) {
          appending = false;
          return;
        }
        if (stripChapters.some(c => c.chapterId === next.id)) { appending = false; return; }
        autoAppendedChapterIds.add(next.id);
        stripChapters = [...stripChapters, { chapterId: next.id, chapterName: next.name, urls }];
        pruneStripWindow(visibleChapterId ?? next.id);
        appending = false;
      })
      .catch(() => { appending = false; });
  }

  function preloadNextChapter() {
    if (!stripChapters.length) return;
    const lastChunk = stripChapters[stripChapters.length - 1];
    const list = store.activeChapterList;
    const lastIndex = list.findIndex((chapter) => chapter.id === lastChunk.chapterId);
    const next = lastIndex >= 0 ? list[lastIndex + 1] : null;
    if (!next || preloadedChapterIds.has(next.id)) return;
    const generation = readerSessionGeneration;
    preloadedChapterIds.add(next.id);
    void fetchPages(next.id)
      .then((urls) => {
        if (generation !== readerSessionGeneration) return;
        urls.slice(0, PRELOAD_FORWARD_PAGES).forEach(preloadImage);
      })
      .catch(() => {
        if (generation === readerSessionGeneration) preloadedChapterIds.delete(next.id);
      });
  }

  let stripChaptersRef: StripChapter[] = [];
  $effect(() => { stripChaptersRef = stripChapters; });

  async function openExternalWebView() {
    if (!webViewUrl) return;
    await open(webViewUrl).catch((err) => {
      error = err instanceof Error ? err.message : String(err);
    });
  }

  async function closeReaderWebView(options: { retryAfterClose?: boolean } = {}) {
    await invoke("close_reader_webview").catch(() => {});
    webViewWindowOpen = false;
    if (options.retryAfterClose) {
      await retryAfterSuwayomiWebViewClose();
    }
  }

  async function retryAfterSuwayomiWebViewClose() {
    const chapter = store.activeChapter;
    if (!chapter || !isCloudflareLikeError(error) || retryingAfterWebViewClose) return;
    retryingAfterWebViewClose = true;
    try {
      clearChapterPageCache(chapter.id);
      await loadChapter(chapter.id);
    } finally {
      retryingAfterWebViewClose = false;
    }
  }

  async function refreshReaderWebViewState() {
    webViewWindowOpen = await invoke<boolean>("reader_webview_is_open").catch(() => false);
  }

  async function openReaderWebView() {
    if (!webViewUrl || !suwayomiWebViewUrl) return;
    const windowTitle = [store.activeManga?.title, displayChapter?.name].filter(Boolean).join(" - ") || "Chapter Web View";
    try {
      await invoke("open_reader_webview", { url: suwayomiWebViewUrl, title: windowTitle });
      webViewWindowOpen = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      webViewWindowOpen = false;
    }
  }

  async function toggleReaderWebView() {
    await refreshReaderWebViewState();
    if (webViewWindowOpen) {
      await closeReaderWebView({ retryAfterClose: true });
      return;
    }
    await openReaderWebView();
  }

  async function exitReader() {
    await closeReaderWebView();
    closeReader();
  }

  function setupScrollTracking(): () => void {
    if (!containerEl || style !== "longstrip") return () => {};
    const scrollEl = containerEl;

    function processScroll() {
      scrollTrackingRafId = null;
      const imgs = scrollEl.querySelectorAll<HTMLElement>("img[data-local-page]");
      if (!imgs.length) return;
      const containerTop = scrollEl.getBoundingClientRect().top;
      const readLineY    = containerTop + scrollEl.clientHeight * READ_LINE_PCT;
      let activePage: number | null = null;
      let activeChId: number | null = null;
      for (const img of imgs) {
        if (img.getBoundingClientRect().top <= readLineY) {
          activePage = Number(img.dataset.localPage);
          activeChId = Number(img.dataset.chapter);
        } else break;
      }
      if (activePage === null) {
        activePage = Number(imgs[0].dataset.localPage);
        activeChId = Number(imgs[0].dataset.chapter);
      }
      if (activePage !== null) store.pageNumber = activePage;
      if (activeChId && activeChId !== visibleChapterId) visibleChapterId = activeChId;
      if (store.settings.autoMarkRead && activePage !== null && activeChId) {
        const chunk = stripChaptersRef.find(c => c.chapterId === activeChId);
        const total = chunk ? chunk.urls.length : store.pageUrls.length;
        if (total > 0 && activePage >= total) markChapterRead(activeChId);
      }
      const atChapterEnd = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 40;
      if (atChapterEnd) {
        const last = stripChaptersRef[stripChaptersRef.length - 1];
        if (last && store.settings.autoMarkRead) markChapterRead(last.chapterId);
        if (autoNext) appendNextChapter();
      }
      const pct = (scrollEl.scrollTop + scrollEl.clientHeight) / scrollEl.scrollHeight;
      if (pct >= 0.80) preloadNextChapter();
    }

    function onScroll() {
      if (scrollTrackingRafId !== null) return;
      scrollTrackingRafId = requestAnimationFrame(processScroll);
    }

    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      if (scrollTrackingRafId !== null) {
        cancelAnimationFrame(scrollTrackingRafId);
        scrollTrackingRafId = null;
      }
    };
  }

  let cleanupScroll: () => void = () => {};

  $effect(() => {
    void style;
    if (!containerEl) return;
    untrack(() => { cleanupScroll(); cleanupScroll = setupScrollTracking(); });
  });

  $effect(() => {
    if (style === "double" && store.pageUrls.length) {
      let cancelled = false;
      const snap = store.pageUrls;
      Promise.all(snap.map(measureAspect)).then(aspects => {
        if (cancelled || snap !== store.pageUrls) return;
        const offset = store.settings.offsetDoubleSpreads;
        const groups: number[][] = [[1]];
        if (offset) groups.push([2]);
        let i = offset ? 3 : 2;
        while (i <= snap.length) {
          const a = aspects[i - 1];
          if (a > 1.2 || i === snap.length) { groups.push([i++]); }
          else { groups.push(rtl ? [i + 1, i] : [i, i + 1]); i += 2; }
        }
        pageGroups = groups;
      });
      return () => { cancelled = true; };
    } else { pageGroups = []; }
  });

  $effect(() => {
    for (let i = 1; i <= PRELOAD_FORWARD_PAGES; i++) {
      const url = store.pageUrls[store.pageNumber - 1 + i];
      if (url) preloadImage(url);
    }
    for (let i = 1; i <= PRELOAD_BACKWARD_PAGES; i++) {
      const url = store.pageUrls[store.pageNumber - 1 - i];
      if (url) preloadImage(url);
    }
  });

  $effect(() => {
    if (style !== "longstrip") return;
    pruneStripWindow(visibleChapterId ?? store.activeChapter?.id ?? null);
  });

  $effect(() => {
    const ch = displayChapter ?? store.activeChapter;
    const autoBookmark = store.settings.autoBookmark ?? true;
    if (ch && lastPage && store.activeManga) {
      const chapterId   = ch.id;
      const chapterName = ch.name;
      const mangaId     = store.activeManga.id;
      const mangaTitle  = store.activeManga.title;
      const thumb       = store.activeManga.thumbnailUrl;
      const pageNum     = store.pageNumber;
      const atLast      = store.pageNumber === lastPage;
      if (pageNum > 1) hasNavigated = true;
      untrack(() => {
        if (!hasNavigated) return;
        if (style === "longstrip" && visibleChapterId && chapterId !== visibleChapterId) return;
        addHistory({ mangaId, mangaTitle, thumbnailUrl: thumb, chapterId, chapterName, readAt: Date.now() });
        if (autoBookmark) {
          addBookmark({ mangaId, mangaTitle, thumbnailUrl: thumb, chapterId, chapterName, pageNumber: pageNum });
        }
        if (style !== "longstrip" && store.settings.autoMarkRead && atLast) markChapterRead(chapterId);
      });
    }
  });

  function markChapterRead(id: number) {
    if (markedRead.has(id)) return;
    markedRead.add(id);
    const chapter = store.activeChapterList.find(c => c.id === id) ?? store.activeChapter;
    const pages   = chapter?.pageCount ?? store.pageUrls.length ?? 15;
    const minutes = Math.max(1, Math.round(pages * AVG_MIN_PER_PAGE));
    if (store.activeManga && chapter) {
      addHistory(
        { mangaId: store.activeManga.id, mangaTitle: store.activeManga.title, thumbnailUrl: store.activeManga.thumbnailUrl, chapterId: id, chapterName: chapter.name, readAt: Date.now() },
        true, minutes,
      );
    }
    gql(MARK_CHAPTER_READ, { id, isRead: true })
      .then(async () => {
        if (store.activeManga) {
          const updated = store.activeChapterList.map(c => c.id === id ? { ...c, isRead: true } : c);
          await checkAndMarkCompleted(store.activeManga.id, updated);
        }
      })
      .catch(e => { markedRead.delete(id); console.error(e); });
  }

  function maybeMarkCurrentRead() {
    const ch = displayChapter ?? store.activeChapter;
    if (ch && markOnNext) markChapterRead(ch.id);
  }

  function advanceGroup(forward: boolean) {
    if (!pageGroups.length) return;
    const gi = pageGroups.findIndex(g => g.includes(store.pageNumber));
    if (forward) {
      if (gi < pageGroups.length - 1) store.pageNumber = pageGroups[gi + 1][0];
      else if (adjacent.next) { store.pageNumber = 1; openReader(adjacent.next, store.activeChapterList); }
        else exitReader();
    } else {
      if (gi > 0) store.pageNumber = pageGroups[gi - 1][0];
      else if (adjacent.prev) openReader(adjacent.prev, store.activeChapterList);
    }
  }

  async function animateFade(fn: () => void) {
    const generation = readerSessionGeneration;
    fadingOut = true;
    await new Promise(r => setTimeout(r, 100));
    if (generation !== readerSessionGeneration) return;
    fn();
    fadingOut = false;
  }

  function goForward() {
    if (loading) return;
    if (style === "longstrip") {
      if (adjacent.next) { maybeMarkCurrentRead(); openReader(adjacent.next, store.activeChapterList); }
      return;
    }
    if (style === "double" && pageGroups.length) { advanceGroup(true); return; }
    if (!store.pageUrls.length) return;
    if (store.pageNumber < lastPage) {
      if (style === "fade") { animateFade(() => { store.pageNumber++; }); }
      else { store.pageNumber++; }
    } else if (adjacent.next) {
      maybeMarkCurrentRead();
      store.pageNumber = 1;
      openReader(adjacent.next, store.activeChapterList);
    } else { exitReader(); }
  }

  function goBack() {
    if (loading) return;
    if (style === "longstrip") {
      if (adjacent.prev) openReader(adjacent.prev, store.activeChapterList);
      return;
    }
    if (style === "double" && pageGroups.length) { advanceGroup(false); return; }
    if (!store.pageUrls.length) return;
    if (store.pageNumber > 1) {
      if (style === "fade") { animateFade(() => { store.pageNumber--; }); }
      else { store.pageNumber--; }
    } else if (adjacent.prev) { openReader(adjacent.prev, store.activeChapterList); }
  }

  const goNext = $derived(rtl ? goBack    : goForward);
  const goPrev = $derived(rtl ? goForward : goBack);

  function jumpToPage(page: number) {
    if (style === "longstrip") {
      const chId = visibleChapterId ?? store.activeChapter?.id;
      const target = containerEl?.querySelector<HTMLImageElement>(`img[data-local-page="${page}"][data-chapter="${chId}"]`);
      target?.scrollIntoView({ block: "start" });
      return;
    }
    if (style === "double" && pageGroups.length) {
      const group = pageGroups[page - 1];
      if (group) store.pageNumber = group[0];
    } else {
      store.pageNumber = Math.max(1, Math.min(lastPage, page));
    }
  }

  function clampZoom(z: number): number {
    return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 1000) / 1000;
  }

  function adjustZoom(delta: number) {
    captureZoomAnchor();
    updateSettings({ readerZoom: clampZoom(zoom + delta) });
    restoreZoomAnchor();
  }

  function resetZoom() {
    captureZoomAnchor();
    updateSettings({ readerZoom: 1.0 });
    restoreZoomAnchor();
  }

  function toggleBookmark() {
    const ch    = displayChapter;
    const manga = store.activeManga;
    if (!ch || !manga) return;
    if (isBookmarked) {
      removeBookmark(ch.id);
      resumeVisible = false;
    } else {
      addBookmark({ mangaId: manga.id, mangaTitle: manga.title, thumbnailUrl: manga.thumbnailUrl, chapterId: ch.id, chapterName: ch.name, pageNumber: store.pageNumber });
    }
  }

  function cycleStyle() {
    const idx = PAGE_STYLES.indexOf(style);
    updateSettings({ pageStyle: PAGE_STYLES[(idx + 1) % PAGE_STYLES.length] });
  }

  function cycleFit() {
    const opts: FitMode[] = ["width", "height", "screen", "original"];
    updateSettings({ fitMode: opts[(opts.indexOf(fit) + 1) % opts.length] });
  }

  function showUi() {
    uiVisible = true;
    if (hideTimer) clearTimeout(hideTimer);
    if (toolsOpen) return;
    hideTimer = setTimeout(() => {
      if (!toolsOpen && !pointerInsideHud) uiVisible = false;
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
    if (!toolsOpen) showUi();
  }

  $effect(() => {
    if (toolsOpen) {
      uiVisible = true;
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    } else {
      activeSubPanel = "main";
      showUi();
    }
  });

  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    adjustZoom(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }

  function onSliderInput(e: Event) {
    jumpToPage(Number((e.currentTarget as HTMLInputElement).value));
  }

  function onKey(e: KeyboardEvent) {
    if (isReaderControlKeyboardTarget(e.target)) return;
    const kb = store.settings.keybinds ?? DEFAULT_KEYBINDS;
    const r  = store.settings.readingDirection === "rtl";
    if (e.key === "Escape") {
      e.preventDefault();
      if (zoomOpen) { zoomOpen = false; return; }
      if (dlOpen)   { dlOpen   = false; return; }
      exitReader(); return;
    }
    if (e.ctrlKey && (e.key === "=" || e.key === "+")) { e.preventDefault(); adjustZoom(ZOOM_STEP * 2); return; }
    if (e.ctrlKey && e.key === "-")                    { e.preventDefault(); adjustZoom(-ZOOM_STEP * 2); return; }
    if (e.ctrlKey && e.key === "0")                    { e.preventDefault(); resetZoom(); return; }
    if      (matchesKeybind(e, kb.exitReader))             { e.preventDefault(); exitReader(); }
    else if (matchesKeybind(e, kb.pageRight))              { e.preventDefault(); goForward(); }
    else if (matchesKeybind(e, kb.pageLeft))               { e.preventDefault(); goBack(); }
    else if (matchesKeybind(e, kb.firstPage))              { e.preventDefault(); store.pageNumber = 1; }
    else if (matchesKeybind(e, kb.lastPage))               { e.preventDefault(); store.pageNumber = lastPage; }
    else if (matchesKeybind(e, kb.chapterRight)) {
      e.preventDefault();
      const list = store.activeChapterList;
      const idx  = list.findIndex(c => c.id === store.activeChapter?.id);
      const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
      if (next) { maybeMarkCurrentRead(); openReader(next, list); }
    }
    else if (matchesKeybind(e, kb.chapterLeft)) {
      e.preventDefault();
      const list = store.activeChapterList;
      const idx  = list.findIndex(c => c.id === store.activeChapter?.id);
      const prev = idx > 0 ? list[idx - 1] : null;
      if (prev) openReader(prev, list);
    }
    else if (matchesKeybind(e, kb.togglePageStyle))        { e.preventDefault(); cycleStyle(); }
    else if (matchesKeybind(e, kb.toggleReadingDirection)) { e.preventDefault(); updateSettings({ readingDirection: r ? "ltr" : "rtl" }); }
    else if (matchesKeybind(e, kb.toggleFullscreen))       { e.preventDefault(); toggleFullscreen().catch(console.error); }
    else if (matchesKeybind(e, kb.openSettings))           { e.preventDefault(); setSettingsOpen(true); }
    else if (matchesKeybind(e, kb.toggleBookmark))         { e.preventDefault(); toggleBookmark(); }
  }

  function handleTap(e: MouseEvent) {
    if (style === "longstrip") return;
    const x = e.clientX / window.innerWidth;
    if (!rtl) {
      if (x > 0.6) { e.stopPropagation(); goForward(); }
      else if (x < 0.4) { e.stopPropagation(); goBack(); }
    }
    else {
      if (x < 0.4) { e.stopPropagation(); goForward(); }
      else if (x > 0.6) { e.stopPropagation(); goBack(); }
    }
  }

  async function runDl(fn: () => Promise<unknown>) {
    dlBusy = true;
    try { await fn(); } catch (e: any) { console.error(e); }
    dlBusy = false; dlOpen = false;
  }

  onMount(() => {
    showUi();
    const unregisterCommands = registerReaderCommandHandler("manga", onKey);
    window.addEventListener("wheel", onWheel, { passive: false });
    containerEl?.focus({ preventScroll: true });
    refreshReaderWebViewState().catch(() => {});
    if (store.activeChapter) {
      void loadChapter(store.activeChapter.id);
    }

    let readerWebViewUnlisten: (() => void) | null = null;
    let cleanedUp = false;
    listen<boolean>("reader-webview-state", (event) => {
      const wasOpen = webViewWindowOpen;
      webViewWindowOpen = !!event.payload;
      if (wasOpen && !webViewWindowOpen) {
        void retryAfterSuwayomiWebViewClose();
      }
    }).then((unlisten) => {
      if (cleanedUp) {
        unlisten();
        return;
      }
      readerWebViewUnlisten = unlisten;
    });

    const ro = new ResizeObserver(entries => { containerWidth = entries[0].contentRect.width; });
    ro.observe(containerEl);

    return () => {
      cleanedUp = true;
      readerSessionGeneration += 1;
      readerWebViewUnlisten?.();
      abortCtrl?.abort();
      if (hideTimer) clearTimeout(hideTimer);
      if (emptyReaderRecoveryTimer) clearTimeout(emptyReaderRecoveryTimer);
      if (resumeTimer) clearTimeout(resumeTimer);
      if (resumeFadeTimer) clearTimeout(resumeFadeTimer);
      unregisterCommands();
      window.removeEventListener("wheel", onWheel);
      cleanupScroll();
      ro.disconnect();
      resetReaderSessionCaches();
    };
  });

  onDestroy(() => {
    closeReaderWebView().catch(() => {});
    clearOfflinePages();
    resetReaderSessionCaches();
  });
</script>

<ReaderHud
  bind:toolsOpen={toolsOpen}
  title={store.activeManga?.title}
  chapterTitle={displayChapter?.name}
  progressLabel={loading ? "..." : `${sliderPage} / ${sliderMax}`}
  sliderValue={sliderPage}
  sliderMax={sliderMax}
  sliderPct={sliderPct}
  bookmarkPct={isBookmarked && currentBookmark ? (sliderMax > 1 ? ((currentBookmark.pageNumber - 1) / (sliderMax - 1)) * 100 : 0) : null}
  isBookmarked={isBookmarked}
  prevDisabled={loading || (style === "longstrip" ? !adjacent.prev : (store.pageNumber === 1 && !adjacent.prev))}
  nextDisabled={loading || (style === "longstrip" ? !adjacent.next : (store.pageNumber === lastPage && !adjacent.next))}
  uiVisible={uiVisible}
  rtl={rtl}
  onMouseMove={(e) => { if (e.clientY < 60 || window.innerHeight - e.clientY < 60) showUi(); }}
  onclose={exitReader}
  onprev={goPrev}
  onnext={goNext}
  onjump={jumpToPage}
  onbookmark={toggleBookmark}
  onHudMouseEnter={keepHudVisible}
  onHudMouseLeave={releaseHudVisibility}
>
  {#snippet settingsPopover()}
    <dl>
      {#if activeSubPanel === "main"}
        <div class="popover-tts-row" role="button" tabindex="0" onclick={() => activeSubPanel = "reading"} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "reading"; }}>
          <dt>{$_("ui_reading")}</dt>
          <dd>{style === "longstrip" ? "Strip" : style === "double" ? "Double" : style === "fade" ? "Fade" : "Single"} · {rtl ? "RTL" : "LTR"} <span class="popover-chevron">&gt;</span></dd>
        </div>
        <div class="popover-tts-row" role="button" tabindex="0" onclick={() => activeSubPanel = "display"} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "display"; }}>
          <dt>{$_("library_display_title")}</dt>
          <dd>{fitLabel} · {zoomPct}% <span class="popover-chevron">&gt;</span></dd>
        </div>
        <div class="popover-tts-row" role="button" tabindex="0" onclick={() => activeSubPanel = "behavior"} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "behavior"; }}>
          <dt>{$_("ui_behavior")}</dt>
          <dd>{store.settings.preloadPages ?? 2} {$_("ui_preload")} <span class="popover-chevron">&gt;</span></dd>
        </div>
        <div class="popover-tts-row" role="button" tabindex="0" onclick={() => activeSubPanel = "downloads"} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "downloads"; }}>
          <dt>{$_("downloads_eyebrow")}</dt>
          <dd>{$_("ui_manager")} <span class="popover-chevron">&gt;</span></dd>
        </div>
      {:else if activeSubPanel === "reading"}
        <div class="popover-tts-row" role="button" tabindex="0" onclick={() => activeSubPanel = "main"} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "main"; }}>
          <dt>{$_("ui_back_f13dfaca")}</dt>
          <dd>{$_("ui_reading")}</dd>
        </div>
        <div>
          <dt>{$_("ui_style")}</dt>
          <dd>
            <div class="popover-segmented">
              <button class="popover-segment" class:active={style === "single"} onclick={() => updateSettings({ pageStyle: "single" })}>{$_("ui_single")}</button>
              <button class="popover-segment" class:active={style === "double"} onclick={() => updateSettings({ pageStyle: "double" })}>{$_("ui_double")}</button>
              <button class="popover-segment" class:active={style === "longstrip"} onclick={() => updateSettings({ pageStyle: "longstrip" })}>{$_("ui_strip")}</button>
              <button class="popover-segment" class:active={style === "fade"} onclick={() => updateSettings({ pageStyle: "fade" })}>{$_("ui_fade")}</button>
            </div>
          </dd>
        </div>
        <div>
          <dt>{$_("ui_direction")}</dt>
          <dd>
            <div class="popover-segmented">
              <button class="popover-segment" class:active={!rtl} onclick={() => updateSettings({ readingDirection: "ltr" })}>LTR</button>
              <button class="popover-segment" class:active={rtl} onclick={() => updateSettings({ readingDirection: "rtl" })}>RTL</button>
            </div>
          </dd>
        </div>
      {:else if activeSubPanel === "display"}
        <div class="popover-tts-row" role="button" tabindex="0" onclick={() => activeSubPanel = "main"} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "main"; }}>
          <dt>{$_("ui_back_f13dfaca")}</dt>
          <dd>{$_("library_display_title")}</dd>
        </div>
        <div>
          <dt>{$_("ui_fitMode")}</dt>
          <dd>
            <button class="popover-btn" onclick={cycleFit}>{fitLabel}</button>
          </dd>
        </div>
        <div>
          <dt>{$_("ui_zoom")}</dt>
          <dd>
            <div class="popover-stepper">
              <button class="popover-step-btn" onclick={() => adjustZoom(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN}>-</button>
              <span class="popover-step-val">{zoomPct}%</span>
              <button class="popover-step-btn" onclick={() => adjustZoom(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX}>+</button>
            </div>
          </dd>
        </div>
        <div>
          <dt>{$_("ui_contrast")}</dt>
          <dd>
            <button class="popover-toggle" type="button" aria-label={$_("ui_toggleContrastOptimization")} title={$_("ui_toggleContrastOptimization")} class:active={store.settings.optimizeContrast} onclick={() => updateSettings({ optimizeContrast: !store.settings.optimizeContrast })}></button>
          </dd>
        </div>
        {#if style === "double"}
          <div>
            <dt>{$_("ui_spreadOffset")}</dt>
            <dd>
              <button class="popover-toggle" type="button" aria-label={$_("ui_toggleOffsetSpreads")} title={$_("ui_toggleOffsetSpreads")} class:active={store.settings.offsetDoubleSpreads} onclick={() => updateSettings({ offsetDoubleSpreads: !store.settings.offsetDoubleSpreads })}></button>
            </dd>
          </div>
        {/if}
        {#if style === "longstrip"}
          <div>
            <dt>{$_("ui_pageGap")}</dt>
            <dd>
              <button class="popover-toggle" type="button" aria-label={$_("ui_togglePageGap")} title={$_("ui_togglePageGap")} class:active={store.settings.pageGap} onclick={() => updateSettings({ pageGap: !store.settings.pageGap })}></button>
            </dd>
          </div>
        {/if}
      {:else if activeSubPanel === "behavior"}
        <div class="popover-tts-row" role="button" tabindex="0" onclick={() => activeSubPanel = "main"} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "main"; }}>
          <dt>{$_("ui_back_f13dfaca")}</dt>
          <dd>{$_("ui_behavior")}</dd>
        </div>
        <div>
          <dt>{$_("ui_preloadPages")}</dt>
          <dd>
            <div class="popover-stepper">
              <button class="popover-step-btn" onclick={() => updateSettings({ preloadPages: Math.max(0, (store.settings.preloadPages ?? 2) - 1) })} disabled={(store.settings.preloadPages ?? 2) <= 0}>-</button>
              <span class="popover-step-val">{store.settings.preloadPages ?? 2}</span>
              <button class="popover-step-btn" onclick={() => updateSettings({ preloadPages: Math.min(10, (store.settings.preloadPages ?? 2) + 1) })} disabled={(store.settings.preloadPages ?? 2) >= 10}>+</button>
            </div>
          </dd>
        </div>
      {:else if activeSubPanel === "downloads"}
        <div class="popover-tts-row" role="button" tabindex="0" onclick={() => activeSubPanel = "main"} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "main"; }}>
          <dt>{$_("ui_back_f13dfaca")}</dt>
          <dd>{$_("downloads_eyebrow")}</dd>
        </div>
        <div>
          <dt>{$_("ui_manager")}</dt>
          <dd>
            <button class="popover-btn" onclick={() => dlOpen = true}>{$_("ui_openManager")}</button>
          </dd>
        </div>
      {:else if false}
      <div>
        <dt>{$_("library_display_layout")}</dt>
        <dd>
          <div class="popover-segmented">
            <button class="popover-segment" class:active={style === "single"} onclick={() => updateSettings({ pageStyle: "single" })}>{$_("ui_single")}</button>
            <button class="popover-segment" class:active={style === "double"} onclick={() => updateSettings({ pageStyle: "double" })}>{$_("ui_double")}</button>
            <button class="popover-segment" class:active={style === "longstrip"} onclick={() => updateSettings({ pageStyle: "longstrip" })}>{$_("ui_strip")}</button>
            <button class="popover-segment" class:active={style === "fade"} onclick={() => updateSettings({ pageStyle: "fade" })}>{$_("ui_fade")}</button>
          </div>
        </dd>
      </div>
      <div>
        <dt>{$_("ui_fitMode")}</dt>
        <dd>
          <button class="popover-btn" onclick={cycleFit}>{fitLabel}</button>
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
        <dt>{$_("ui_direction")}</dt>
        <dd>
          <div class="popover-segmented">
            <button class="popover-segment" class:active={!rtl} onclick={() => updateSettings({ readingDirection: "ltr" })}>LTR</button>
            <button class="popover-segment" class:active={rtl} onclick={() => updateSettings({ readingDirection: "rtl" })}>RTL</button>
          </div>
        </dd>
      </div>
      <div>
        <dt>{$_("ui_contrast")}</dt>
        <dd>
          <button class="popover-toggle" type="button" aria-label={$_("ui_toggleContrastOptimization")} title={$_("ui_toggleContrastOptimization")} class:active={store.settings.optimizeContrast} onclick={() => updateSettings({ optimizeContrast: !store.settings.optimizeContrast })}></button>
        </dd>
      </div>
      {#if style === "double"}
        <div>
          <dt>{$_("ui_offsetSpreads")}</dt>
          <dd>
            <button class="popover-toggle" type="button" aria-label={$_("ui_toggleOffsetSpreads")} title={$_("ui_toggleOffsetSpreads")} class:active={store.settings.offsetDoubleSpreads} onclick={() => updateSettings({ offsetDoubleSpreads: !store.settings.offsetDoubleSpreads })}></button>
          </dd>
        </div>
      {/if}
      {#if style === "longstrip"}
        <div>
          <dt>{$_("ui_pageGap")}</dt>
          <dd>
            <button class="popover-toggle" type="button" aria-label={$_("ui_togglePageGap")} title={$_("ui_togglePageGap")} class:active={store.settings.pageGap} onclick={() => updateSettings({ pageGap: !store.settings.pageGap })}></button>
          </dd>
        </div>
      {/if}
      <div>
        <dt>{$_("ui_preloadPages")}</dt>
        <dd>
          <div class="popover-stepper">
            <button class="popover-step-btn" onclick={() => updateSettings({ preloadPages: Math.max(0, (store.settings.preloadPages ?? 2) - 1) })} disabled={(store.settings.preloadPages ?? 2) <= 0}>−</button>
            <span class="popover-step-val">{store.settings.preloadPages ?? 2}</span>
            <button class="popover-step-btn" onclick={() => updateSettings({ preloadPages: Math.min(10, (store.settings.preloadPages ?? 2) + 1) })} disabled={(store.settings.preloadPages ?? 2) >= 10}>+</button>
          </div>
        </dd>
      </div>
      <div>
        <dt>{$_("downloads_eyebrow")}</dt>
        <dd>
          <button class="popover-btn" onclick={() => dlOpen = true}>{$_("ui_openManager")}</button>
        </dd>
      </div>
      {/if}
    </dl>
  {/snippet}

  {#if showResumeBanner}
    <button
      type="button"
      class="resume-banner"
      class:fading={resumeFading}
      aria-label={`Dismiss bookmark resume notice for page ${resumePage}`}
      onclick={() => { resumeVisible = false; resumeFading = false; }}
    >
      <span>{$_("ui_bookmarkAtPage")} {resumePage}</span>
    </button>
  {/if}

  <div
    bind:this={containerEl}
    class="viewer"
    class:strip={style === "longstrip"}
    style={effectiveWidth != null ? `--effective-width:${effectiveWidth}px` : ""}
    role="presentation"
    tabindex="-1"
    onclick={handleTap}
    onwheel={(e) => { if (e.ctrlKey) e.preventDefault(); }}
    onkeydown={(e) => { if (e.key === " " && style === "longstrip") { e.preventDefault(); containerEl?.scrollBy({ top: containerEl.clientHeight * 0.85, behavior: "smooth" }); } }}
  >
    {#if loading}
      <div class="center-overlay"><CircleNotch size={20} weight="light" class="anim-spin" style="color:var(--text-faint)" /></div>
    {/if}
    {#if error}
      <div class="center-overlay error-stack">
        <NocturneState
          layout="center"
          tone="danger"
          icon="warning"
          eyebrow={$_("ui_reader")}
          title={$_("ui_couldNotLoadChapterPages")}
          body={error}
          actions={canOpenWebView ? [
            {
              label: webViewWindowOpen ? $_("ui_closeWebView") : $_("ui_tryWebView"),
              kind: "primary",
              icon: "plug",
              onClick: toggleReaderWebView,
            },
            {
              label: $_("ui_openInBrowser"),
              kind: "secondary",
              icon: "info",
              onClick: openExternalWebView,
            },
          ] : []}
        />
      </div>
    {/if}

    {#if style === "longstrip"}
      {#each stripToRender as chunk}
        {#each chunk.urls as url, i}
          <img
            use:resolvedImage={url}
            alt="{chunk.chapterName} – Page {i + 1}"
            data-local-page={i + 1}
            data-chapter={chunk.chapterId}
            data-total={chunk.urls.length}
            class="{imgCls}{store.settings.pageGap ? ' strip-gap' : ''}"
            loading={i < 5 ? "eager" : "lazy"}
            decoding="async"
          />
        {/each}
      {/each}
      <div style="height:1px;flex-shrink:0"></div>

    {:else if style === "fade" && pageReady}
      <img
        use:resolvedImage={store.pageUrls[store.pageNumber - 1]}
        alt="Page {store.pageNumber}"
        class={imgCls}
        decoding="async"
        style="opacity: {fadingOut ? 'var(--component-reader-core-fade-hidden-opacity)' : 'var(--component-reader-core-fade-visible-opacity)'}; transition: opacity var(--component-reader-core-fade-transition);"
      />

    {:else if style === "double" && pageReady}
      {#if pageGroups.length}
        <div class="double-wrap">
          {#each currentGroup as pg, i}
            <img
              use:resolvedImage={store.pageUrls[pg - 1]}
              alt="Page {pg}"
              class="{imgCls} page-half {i === 0 ? 'gap-left' : 'gap-right'}"
              decoding="async"
            />
          {/each}
        </div>
      {:else}
        <div class="center-overlay"><CircleNotch size={20} weight="light" class="anim-spin" style="color:var(--text-faint)" /></div>
      {/if}

    {:else if pageReady}
      <img use:resolvedImage={store.pageUrls[store.pageNumber - 1]} alt="Page {store.pageNumber}" class={imgCls} decoding="async" />
    {/if}
  </div>

  {#if dlOpen && store.activeChapter}
    {@const queueable = adjacent.remaining.filter(c => !c.isDownloaded)}
    <div class="dl-backdrop" role="presentation" onclick={() => dlOpen = false}>
      <div class="dl-modal" role="presentation" onclick={(e) => e.stopPropagation()}>
        <p class="dl-title">{$_("detail_actions_download")}</p>
        <button class="dl-option" disabled={dlBusy || !!store.activeChapter.isDownloaded}
          onclick={() => runDl(() => gql(ENQUEUE_DOWNLOAD, { chapterId: store.activeChapter!.id }))}>
          {$_("ui_thisChapter")}
          <span class="dl-sub">{store.activeChapter.isDownloaded ? $_("ui_alreadyDownloaded") : store.activeChapter.name}</span>
        </button>
        <div class="dl-row">
          <button class="dl-option" disabled={dlBusy || queueable.length === 0}
            onclick={() => runDl(() => gql(ENQUEUE_CHAPTERS_DOWNLOAD, { chapterIds: queueable.slice(0, nextN).map(c => c.id) }))}>
            {$_("ui_nextChapters")}
            <span class="dl-sub">{Math.min(nextN, queueable.length)} {$_("ui_notYetDownloaded")}</span>
          </button>
          <div class="dl-stepper" role="presentation" onclick={(e) => e.stopPropagation()}>
            <button class="dl-step-btn" onclick={() => nextN = Math.max(1, nextN - 1)} disabled={nextN <= 1}>−</button>
            <span class="dl-step-val">{nextN}</span>
            <button class="dl-step-btn" onclick={() => nextN = Math.min(queueable.length || 1, nextN + 1)} disabled={nextN >= queueable.length}>+</button>
          </div>
        </div>
        <button class="dl-option" disabled={dlBusy || queueable.length === 0}
          onclick={() => runDl(() => gql(ENQUEUE_CHAPTERS_DOWNLOAD, { chapterIds: queueable.map(c => c.id) }))}>
          {$_("ui_allRemaining")}
          <span class="dl-sub">{queueable.length} {$_("ui_notYetDownloaded")}</span>
        </button>
      </div>
    </div>
  {/if}
</ReaderHud>

<style>
  .error-stack { display: flex; flex-direction: column; align-items: center; gap: var(--component-reader-core-error-stack-gap); }
  .reader-error-actions { display: flex; align-items: center; gap: var(--component-reader-core-error-actions-gap); flex-wrap: wrap; justify-content: center; }
  .reader-error-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--component-reader-core-action-gap);
    min-height: var(--component-reader-core-action-min-height);
    padding: var(--component-reader-core-action-padding);
    border-radius: var(--component-reader-core-action-radius);
    border: var(--component-reader-core-action-border);
    background: var(--component-reader-core-action-bg);
    color: var(--component-reader-core-action-fg);
    font-family: var(--component-reader-core-action-font);
    font-size: var(--component-reader-core-action-font-size);
    font-weight: var(--component-reader-core-action-font-weight);
    letter-spacing: var(--component-reader-core-action-letter-spacing);
    cursor: pointer;
    transition: var(--component-reader-core-action-transition);
  }
  .reader-error-btn:hover {
    border-color: var(--component-reader-core-action-hover-border);
    background: var(--component-reader-core-action-hover-bg);
    transform: var(--component-reader-core-action-hover-transform);
  }
  .reader-error-btn.subtle {
    border-color: var(--component-reader-core-action-subtle-border);
    background: var(--component-reader-core-action-subtle-bg);
    color: var(--component-reader-core-action-subtle-fg);
  }
  .reader-error-btn.subtle:hover {
    border-color: var(--component-reader-core-action-subtle-hover-border);
    color: var(--component-reader-core-action-subtle-hover-fg);
  }

  .viewer { flex: 1; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; align-items: center; justify-content: center; -webkit-overflow-scrolling: touch; position: relative; }
  .viewer.strip { justify-content: flex-start; padding: var(--sp-4) 0; }
  .viewer:focus { outline: none; }

  .img { display: block; user-select: none; image-rendering: auto; }
  .img.optimize-contrast { image-rendering: -webkit-optimize-contrast; }
  .fit-width    { max-width: var(--effective-width, 100%); width: 100%; height: auto; }
  .fit-height   { max-height: calc(100vh - 80px); width: auto; max-width: var(--effective-width, 100%); height: auto; }
  .fit-screen   { max-width: var(--effective-width, 100%); max-height: calc(100vh - 80px); object-fit: contain; height: auto; }
  .fit-original { max-width: 100%; width: auto; height: auto; }
  .strip-gap { margin-bottom: var(--component-reader-core-strip-gap); }

  .double-wrap { display: flex; align-items: flex-start; justify-content: center; max-width: calc(var(--effective-width, 100%) * 2); width: 100%; }
  .page-half { flex: 1; min-width: 0; object-fit: contain; }
  .gap-left  { margin-right: 2px; }
  .gap-right { margin-left: 2px; }

  .center-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }

  .resume-banner { position: fixed; top: var(--component-reader-core-resume-top); left: 50%; display: flex; align-items: center; gap: var(--sp-2); background: var(--component-reader-core-resume-bg); border: var(--component-reader-core-resume-border); border-radius: var(--component-reader-core-resume-radius); padding: var(--component-reader-core-resume-padding); font-family: var(--component-reader-core-action-font); font-size: var(--component-reader-core-resume-font-size); font-weight: var(--component-reader-core-resume-font-weight); color: var(--component-reader-core-resume-fg); z-index: var(--component-reader-core-resume-z-index); box-shadow: var(--component-reader-core-resume-shadow); backdrop-filter: var(--component-reader-core-resume-blur); animation: bannerIn var(--component-reader-core-resume-in-animation); white-space: nowrap; cursor: pointer; }
  .resume-banner.fading { animation: bannerOut var(--component-reader-core-resume-out-animation); }
  @keyframes bannerIn  { from { opacity: var(--component-reader-core-fade-hidden-opacity); transform: var(--component-reader-core-banner-in-from-transform); } to { opacity: var(--component-reader-core-fade-visible-opacity); transform: var(--component-reader-core-banner-in-to-transform); } }
  @keyframes bannerOut { from { opacity: var(--component-reader-core-fade-visible-opacity); transform: var(--component-reader-core-banner-out-from-transform); } to { opacity: var(--component-reader-core-fade-hidden-opacity); transform: var(--component-reader-core-banner-out-to-transform); } }
  .resume-jump { font-family: var(--component-reader-core-action-font); font-size: var(--component-reader-core-action-font-size); font-weight: var(--component-reader-core-action-font-weight); letter-spacing: var(--component-reader-core-action-letter-spacing); color: var(--component-reader-core-action-fg); background: var(--component-reader-core-action-bg); border: var(--component-reader-core-action-border); border-radius: var(--component-reader-core-action-radius); padding: var(--component-reader-core-resume-jump-padding); cursor: pointer; transition: var(--component-reader-core-resume-jump-transition); }
  .resume-jump:hover { background: var(--component-reader-core-action-hover-bg); border-color: var(--component-reader-core-action-hover-border); transform: var(--component-reader-core-action-hover-transform); }

  .dl-backdrop { position: fixed; inset: 0; z-index: var(--component-reader-core-download-z-index); display: flex; align-items: flex-start; justify-content: flex-end; padding: var(--component-reader-core-download-backdrop-padding); }
  .dl-modal {
    background: var(--component-reader-core-download-panel-bg);
    border: var(--component-reader-core-download-panel-border);
    border-radius: var(--component-reader-core-download-panel-radius);
    padding: var(--component-reader-core-download-panel-padding);
    min-width: var(--component-reader-core-download-panel-min-width);
    display: flex;
    flex-direction: column;
    gap: var(--component-reader-core-download-panel-gap);
    box-shadow: var(--component-reader-core-download-panel-shadow);
    backdrop-filter: var(--component-reader-core-download-panel-blur);
    animation: scaleIn var(--t-fast) both;
    transform-origin: top right;
  }
  .dl-title {
    font-family: var(--component-reader-core-action-font);
    font-size: var(--component-reader-core-download-title-font-size);
    font-weight: var(--component-reader-core-action-font-weight);
    color: var(--component-reader-core-download-title-fg);
    letter-spacing: var(--component-reader-core-download-title-letter-spacing);
    text-transform: uppercase;
    padding: var(--component-reader-core-download-title-padding);
    border-bottom: var(--component-reader-core-download-title-border);
    margin-bottom: var(--component-reader-core-download-title-margin-bottom);
  }
  .dl-option {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--component-reader-core-download-option-gap);
    width: 100%;
    padding: var(--component-reader-core-download-option-padding);
    border-radius: var(--component-reader-core-download-option-radius);
    font-family: var(--component-reader-core-action-font);
    font-size: var(--component-reader-core-action-font-size);
    font-weight: var(--component-reader-core-download-option-font-weight);
    color: var(--component-reader-core-download-option-fg);
    background: var(--component-reader-core-download-option-bg);
    border: var(--component-reader-core-download-option-border);
    cursor: pointer;
    text-align: left;
    transition: var(--component-reader-core-download-option-transition);
  }
  .dl-option:hover:not(:disabled) {
    background: var(--component-reader-core-download-option-hover-bg);
    border-color: var(--component-reader-core-download-option-hover-border);
    color: var(--component-reader-core-download-option-fg);
    transform: var(--component-reader-core-action-hover-transform);
  }
  .dl-option:disabled {
    opacity: var(--component-reader-core-download-option-disabled-opacity);
    background: var(--component-reader-core-download-option-disabled-bg);
    border-color: var(--component-reader-core-download-option-disabled-border);
    cursor: default;
  }
  .dl-sub { font-size: var(--component-reader-core-download-sub-font-size); color: var(--component-reader-core-download-sub-fg); letter-spacing: var(--component-reader-core-download-sub-letter-spacing); }
  .dl-row { display: flex; align-items: stretch; gap: var(--component-reader-core-download-row-gap); width: 100%; }
  .dl-row .dl-option { flex: 1; min-width: 0; }
  .dl-stepper {
    display: flex;
    align-items: center;
    background: var(--component-reader-core-download-stepper-bg);
    border: var(--component-reader-core-download-stepper-border);
    border-radius: var(--component-reader-core-download-stepper-radius);
    overflow: hidden;
    flex-shrink: 0;
  }
  .dl-step-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--component-reader-core-download-step-size);
    height: 100%;
    min-height: var(--component-reader-core-download-step-min-height);
    font-size: var(--component-reader-core-download-step-font-size);
    color: var(--component-reader-core-download-step-fg);
    background: transparent;
    border: none;
    cursor: pointer;
    line-height: 1;
    transition: color var(--t-fast), background var(--t-fast);
  }
  .dl-step-btn:hover:not(:disabled) {
    color: var(--component-reader-core-download-option-fg);
    background: var(--component-reader-core-download-option-hover-bg);
  }
  .dl-step-btn:disabled { opacity: var(--component-reader-core-download-step-disabled-opacity); cursor: default; }
  .dl-step-val {
    font-family: var(--component-reader-core-action-font);
    font-size: var(--component-reader-core-download-title-font-size);
    font-weight: var(--component-reader-core-action-font-weight);
    color: var(--component-reader-core-download-option-fg);
    min-width: var(--component-reader-core-download-step-size);
    text-align: center;
    letter-spacing: var(--component-reader-core-action-letter-spacing);
    border-inline: var(--component-reader-core-download-step-val-border);
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  @keyframes scaleIn { from { opacity: var(--component-reader-core-fade-hidden-opacity); transform: var(--component-reader-core-scale-in-from-transform) } to { opacity: var(--component-reader-core-fade-visible-opacity); transform: var(--component-reader-core-scale-in-to-transform) } }
  @keyframes readerToolsIn { from { opacity: var(--component-reader-core-fade-hidden-opacity); transform: var(--component-reader-core-tools-in-from-transform) } to { opacity: var(--component-reader-core-fade-visible-opacity); transform: var(--component-reader-core-tools-in-to-transform) } }

  @media (max-width: 900px) {
    .reader-tools-panel {
      display: none;
    }
  }
</style>
