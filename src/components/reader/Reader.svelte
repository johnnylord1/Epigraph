<script lang="ts">
  import { onMount, onDestroy, untrack, tick } from "svelte";
  import {
    X, CaretLeft, CaretRight, ArrowLeft, ArrowRight,
    Square, Rows, Download, ArrowsLeftRight, ArrowsIn, ArrowsOut, ArrowsVertical,
    CircleNotch, MagnifyingGlassMinus, MagnifyingGlassPlus,
    Bookmark, BookOpen, MonitorPlay, GlobeHemisphereWest, ArrowSquareOut,
  } from "phosphor-svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { open } from "@tauri-apps/plugin-shell";
  import { getServerUrl, gql, thumbUrl } from "../../lib/client";
  import { acquireResolvedMediaUrl, preloadBlobUrls, resetImageCache, resolvedImage, warmResolvedMediaUrl } from "../../lib/imageCache";
  import { FETCH_CHAPTER_PAGES, MARK_CHAPTER_READ, ENQUEUE_DOWNLOAD, ENQUEUE_CHAPTERS_DOWNLOAD } from "../../lib/queries";
  import { toSuwayomiWebViewUrl } from "../../lib/suwayomiWebView";
  import { store, closeReader, openReader, addHistory, updateSettings, checkAndMarkCompleted, setSettingsOpen, addBookmark, removeBookmark } from "../../store/state.svelte";
  import { matchesKeybind, toggleFullscreen, DEFAULT_KEYBINDS } from "../../lib/keybinds";
  import { setReading } from "../../lib/discord";
  import type { FitMode } from "../../store/state.svelte";
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

  const PAGE_STYLES = ["single", "fade", "double", "longstrip"] as const;
  type PageStyle = typeof PAGE_STYLES[number];

  const pageCache = new Map<number, string[]>();
  const inflight  = new Map<number, Promise<string[]>>();

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
    if (cached) return Promise.resolve(cached);
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (!inflight.has(chapterId)) {
      const p = gql<{ fetchChapterPages: { pages: string[] } }>(FETCH_CHAPTER_PAGES, { chapterId })
        .then(d => {
          const urls = d.fetchChapterPages.pages.map(thumbUrl);
          void preloadBlobUrls(urls.slice(0, 2), 0).catch(() => {});
          pageCache.set(chapterId, urls);
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
      const finish = (value: number) => {
        release?.();
        release = null;
        res(value);
      };
      img.onload  = () => {
        const r = img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 0.67;
        rememberAspect(url, r);
        finish(r);
      };
      img.onerror = () => finish(0.67);
      acquireResolvedMediaUrl(url)
        .then((lease) => {
          release = lease.release;
          img.src = lease.resolvedUrl;
        })
        .catch(() => {
          img.src = url;
        });
    });
  }

  interface StripChapter { chapterId: number; chapterName: string; urls: string[]; }

  let containerEl: HTMLDivElement;
  let containerWidth = $state(0);
  let zoomAnchorEl:     HTMLElement | null = null;
  let zoomAnchorOffset: number             = 0;

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
    requestAnimationFrame(() => {
      const containerTop = containerEl.getBoundingClientRect().top;
      const newRect      = el.getBoundingClientRect();
      containerEl.scrollTop += (newRect.top - containerTop) - zoomAnchorOffset;
    });
  }

  let loading          = $state(true);
  let error: string | null = $state(null);
  let dlOpen           = $state(false);
  let zoomOpen         = $state(false);
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

  $effect(() => {
    const chapter = displayChapter;
    const manga   = store.activeManga;
    if (store.settings.discordRpc && chapter && manga) setReading(manga, chapter);
  });

  $effect(() => {
    const ch = store.activeChapter;
    if (ch) untrack(() => loadChapter(ch.id));
  });

  async function loadChapter(id: number) {
    abortCtrl?.abort();
    const ctrl = new AbortController();
    abortCtrl  = ctrl;
    hasNavigated     = false;
    appending        = false;
    markedRead       = new Set();
    loading          = true;
    error            = null;
    pageGroups       = [];
    pageReady        = false;
    resetReaderSessionCaches();
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
      const urls = await fetchPages(id, ctrl.signal);
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
          const scrollToResumePage = () => {
            const target = containerEl.querySelector<HTMLImageElement>(`img[data-local-page="${targetPg}"][data-chapter="${chId}"]`);
            if (!target) { requestAnimationFrame(scrollToResumePage); return; }
            containerEl.querySelectorAll<HTMLImageElement>(`img[data-chapter="${chId}"]`).forEach((img, i) => { if (i < targetPg) img.loading = "eager"; });
            const doScroll = () => { target.scrollIntoView({ block: "start" }); stripResumeReady = true; };
            if (target.complete && target.naturalHeight > 0) { doScroll(); }
            else { target.loading = "eager"; target.addEventListener("load", doScroll, { once: true }); }
          };
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
    if (!next || stripChapters.some(c => c.chapterId === next.id)) return;
    appending = true;
    fetchPages(next.id)
      .then(urls => {
        urls.slice(0, PRELOAD_FORWARD_PAGES).forEach(preloadImage);
        return urls;
      })
      .then(urls => {
        if (stripChapters.some(c => c.chapterId === next.id)) { appending = false; return; }
        stripChapters = [...stripChapters, { chapterId: next.id, chapterName: next.name, urls }];
        pruneStripWindow(visibleChapterId ?? next.id);
        appending = false;
      })
      .catch(() => { appending = false; });
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

    function onScroll() {
      const imgs = containerEl.querySelectorAll<HTMLElement>("img[data-local-page]");
      if (!imgs.length) return;
      const containerTop = containerEl.getBoundingClientRect().top;
      const readLineY    = containerTop + containerEl.clientHeight * READ_LINE_PCT;
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
      if (containerEl.scrollTop + containerEl.clientHeight >= containerEl.scrollHeight - 40) {
        const last = stripChaptersRef[stripChaptersRef.length - 1];
        if (last && store.settings.autoMarkRead) markChapterRead(last.chapterId);
      }
    }

    function onScrollAppend() {
      const pct = (containerEl.scrollTop + containerEl.clientHeight) / containerEl.scrollHeight;
      if (pct >= 0.80) appendNextChapter();
    }

    containerEl.addEventListener("scroll", onScroll,       { passive: true });
    containerEl.addEventListener("scroll", onScrollAppend, { passive: true });
    return () => {
      containerEl.removeEventListener("scroll", onScroll);
      containerEl.removeEventListener("scroll", onScrollAppend);
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
    fadingOut = true;
    await new Promise(r => setTimeout(r, 100));
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
    hideTimer = setTimeout(() => uiVisible = false, 3000);
  }

  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    adjustZoom(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }

  function onSliderInput(e: Event) {
    jumpToPage(Number((e.currentTarget as HTMLInputElement).value));
  }

  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
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
    if (!rtl) { if (x > 0.6) goForward(); else if (x < 0.4) goBack(); }
    else       { if (x < 0.4) goForward(); else if (x > 0.6) goBack(); }
  }

  async function runDl(fn: () => Promise<unknown>) {
    dlBusy = true;
    try { await fn(); } catch (e: any) { console.error(e); }
    dlBusy = false; dlOpen = false;
  }

  onMount(() => {
    showUi();
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: false });
    containerEl?.focus({ preventScroll: true });
    refreshReaderWebViewState().catch(() => {});

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
      readerWebViewUnlisten?.();
      abortCtrl?.abort();
      if (hideTimer) clearTimeout(hideTimer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
      cleanupScroll();
      ro.disconnect();
      resetReaderSessionCaches();
    };
  });

  onDestroy(() => {
    closeReaderWebView().catch(() => {});
    resetReaderSessionCaches();
  });
</script>

<ReaderHud
  {overlayBars}
  {uiVisible}
  onMouseMove={(e) => { if (e.clientY < 60 || window.innerHeight - e.clientY < 60) showUi(); }}
>
  {#snippet topbarLeft()}
        <button class="icon-btn" onclick={exitReader} title="Close reader"><X size={15} weight="light" /></button>
      <button class="icon-btn" onclick={() => { if (adjacent.prev) { maybeMarkCurrentRead(); openReader(adjacent.prev, store.activeChapterList); } }} disabled={!adjacent.prev}>
        <CaretLeft size={14} weight="light" />
      </button>
      <span class="ch-label">
        <span class="ch-title">{store.activeManga?.title}</span>
        <span class="ch-sep">/</span>
        <span>{displayChapter?.name}</span>
      </span>
      <button class="icon-btn" onclick={() => { if (adjacent.next) { maybeMarkCurrentRead(); openReader(adjacent.next, store.activeChapterList); } }} disabled={!adjacent.next}>
        <CaretRight size={14} weight="light" />
      </button>
      <span class="page-label">{store.pageNumber} / {visibleChunkLastPage || "…"}</span>
  {/snippet}

  {#snippet topbarRight()}
      <div class="top-sep"></div>

      <button class="mode-btn" onclick={cycleFit}>
        {#if fit === "width"}<ArrowsLeftRight size={14} weight="light" />
        {:else if fit === "height"}<ArrowsVertical size={14} weight="light" />
        {:else if fit === "screen"}<ArrowsIn size={14} weight="light" />
        {:else}<ArrowsOut size={14} weight="light" />{/if}
        <span class="mode-label">{fitLabel}</span>
      </button>

      <div class="zoom-wrap">
        <div class="zoom-inline">
          <button class="zoom-step-btn" onclick={() => adjustZoom(-ZOOM_STEP)} title="Zoom out" disabled={zoom <= ZOOM_MIN}>
            <MagnifyingGlassMinus size={13} weight="light" />
          </button>
          <button class="zoom-pct-btn" onclick={() => zoomOpen = !zoomOpen} title="Click to adjust zoom">
            {zoomPct}%
          </button>
          <button class="zoom-step-btn" onclick={() => adjustZoom(ZOOM_STEP)} title="Zoom in" disabled={zoom >= ZOOM_MAX}>
            <MagnifyingGlassPlus size={13} weight="light" />
          </button>
        </div>
        {#if zoomOpen}
          <div class="zoom-popover">
            <div class="zoom-slider-row">
              <input type="range" class="zoom-slider" min={10} max={100} step={5} value={zoomPct}
                oninput={(e) => { captureZoomAnchor(); updateSettings({ readerZoom: clampZoom(Number(e.currentTarget.value) / 100) }); restoreZoomAnchor(); }} />
            </div>
            <button class="zoom-reset" onclick={resetZoom} disabled={zoom === 1.0}>Reset</button>
          </div>
        {/if}
      </div>

      <button class="mode-btn" class:active={rtl} onclick={() => updateSettings({ readingDirection: rtl ? "ltr" : "rtl" })}>
        <ArrowsLeftRight size={14} weight="light" /><span class="mode-label">{rtl ? "RTL" : "LTR"}</span>
      </button>

      <button class="mode-btn" onclick={cycleStyle} title="Cycle view mode">
        {#if style === "single"}<Square size={14} weight="light" />
        {:else if style === "fade"}<MonitorPlay size={14} weight="light" />
        {:else if style === "double"}<BookOpen size={14} weight="light" />
        {:else}<Rows size={14} weight="light" />{/if}
        <span class="mode-label">{style}</span>
      </button>

      <div class="mode-extras">
        {#if style === "double"}
          <button class="mode-btn" class:active={store.settings.offsetDoubleSpreads} onclick={() => updateSettings({ offsetDoubleSpreads: !store.settings.offsetDoubleSpreads })}>
            <span class="mode-label">Offset</span>
          </button>
        {/if}
        {#if style === "longstrip"}
          <button class="mode-btn" class:active={store.settings.pageGap} onclick={() => updateSettings({ pageGap: !store.settings.pageGap })}>
            <span class="mode-label">Gap</span>
          </button>
          <button class="mode-btn" class:active={autoNext} onclick={() => updateSettings({ autoNextChapter: !autoNext })}>
            <span class="mode-label">Auto</span>
          </button>
        {/if}
        {#if !autoNext}
          <button class="mode-btn" class:active={markOnNext} onclick={() => updateSettings({ markReadOnNext: !markOnNext })}>
            <span class="mode-label">Mk.Read</span>
          </button>
        {/if}
      </div>

      <button class="mode-btn" onclick={() => dlOpen = true}>
        <Download size={14} weight="light" />
      </button>

        {#if canOpenWebView}
          <button class="mode-btn" class:active={webViewWindowOpen} onclick={toggleReaderWebView} title={webViewWindowOpen ? "Close chapter web view" : "Open chapter web view"}>
            <GlobeHemisphereWest size={14} weight="light" />
            <span class="mode-label">Web</span>
          </button>
        {/if}

      <button class="icon-btn" class:active={isBookmarked} onclick={toggleBookmark} title={isBookmarked ? "Remove bookmark" : "Bookmark this page"}>
          <Bookmark size={15} weight={isBookmarked ? "fill" : "regular"} />
        </button>
  {/snippet}

  {#if showResumeBanner}
    <div class="resume-banner" class:fading={resumeFading} role="status" onclick={() => { resumeVisible = false; resumeFading = false; }}>
      <span>Bookmark at page {resumePage}</span>

    </div>
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
          <p class="error-msg">{error}</p>
          {#if canOpenWebView}
            <div class="reader-error-actions">
              <button class="reader-error-btn" onclick={toggleReaderWebView}>
                <GlobeHemisphereWest size={14} weight="light" />
                {webViewWindowOpen ? "Close web view" : "Try web view"}
              </button>
            <button class="reader-error-btn subtle" onclick={openExternalWebView}>
              <ArrowSquareOut size={14} weight="light" />
              Open in browser
            </button>
          </div>
        {/if}
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
        style="opacity: {fadingOut ? 0 : 1}; transition: opacity 0.1s ease;"
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

  {#snippet bottombar()}
    <button class="nav-btn" onclick={goPrev} disabled={loading || (style === "longstrip" ? !adjacent.prev : (store.pageNumber === 1 && !adjacent.prev))}>
      <ArrowLeft size={13} weight="light" />
    </button>

    {#if sliderMax > 1}
      <div
        class="slider-wrap"
        class:dragging={sliderDragging}
        onmouseenter={() => sliderHover = true}
        onmouseleave={() => { sliderHover = false; }}
        role="presentation"
      >
        <div class="slider-track-bg">
          <div class="slider-fill" style="width: {rtl ? 100 - sliderPct : sliderPct}%"></div>
        </div>
        {#if isBookmarked && currentBookmark}
          {@const bPct = sliderMax > 1 ? ((currentBookmark.pageNumber - 1) / (sliderMax - 1)) * 100 : 0}
          <div
            class="slider-checkpoint bookmark-checkpoint"
            style="left: {rtl ? 100 - bPct : bPct}%"
            title="Bookmark: Page {currentBookmark.pageNumber}"
          ></div>
        {/if}
        <input
          type="range"
          class="slider-input"
          min={1}
          max={sliderMax}
          step={1}
          value={sliderPage}
          dir={rtl ? "rtl" : "ltr"}
          oninput={onSliderInput}
          onmousedown={() => sliderDragging = true}
          onmouseup={() => sliderDragging = false}
          ontouchstart={() => sliderDragging = true}
          ontouchend={() => sliderDragging = false}
          aria-label="Page {sliderPage} of {sliderMax}"
        />
        {#if sliderHover || sliderDragging}
          <div class="slider-tooltip" style="left: {rtl ? 100 - sliderPct : sliderPct}%">
            {sliderPage} / {sliderMax}
          </div>
        {/if}
      </div>
    {/if}

    <button class="nav-btn" onclick={goNext} disabled={loading || (style === "longstrip" ? !adjacent.next : (store.pageNumber === lastPage && !adjacent.next))}>
      <ArrowRight size={13} weight="light" />
    </button>
  {/snippet}

  {#if dlOpen && store.activeChapter}
    {@const queueable = adjacent.remaining.filter(c => !c.isDownloaded)}
    <div class="dl-backdrop" role="presentation" onclick={() => dlOpen = false}>
      <div class="dl-modal" role="presentation" onclick={(e) => e.stopPropagation()}>
        <p class="dl-title">Download</p>
        <button class="dl-option" disabled={dlBusy || !!store.activeChapter.isDownloaded}
          onclick={() => runDl(() => gql(ENQUEUE_DOWNLOAD, { chapterId: store.activeChapter!.id }))}>
          This chapter
          <span class="dl-sub">{store.activeChapter.isDownloaded ? "Already downloaded" : store.activeChapter.name}</span>
        </button>
        <div class="dl-row">
          <button class="dl-option" disabled={dlBusy || queueable.length === 0}
            onclick={() => runDl(() => gql(ENQUEUE_CHAPTERS_DOWNLOAD, { chapterIds: queueable.slice(0, nextN).map(c => c.id) }))}>
            Next chapters
            <span class="dl-sub">{Math.min(nextN, queueable.length)} not yet downloaded</span>
          </button>
          <div class="dl-stepper" role="presentation" onclick={(e) => e.stopPropagation()}>
            <button class="dl-step-btn" onclick={() => nextN = Math.max(1, nextN - 1)} disabled={nextN <= 1}>−</button>
            <span class="dl-step-val">{nextN}</span>
            <button class="dl-step-btn" onclick={() => nextN = Math.min(queueable.length || 1, nextN + 1)} disabled={nextN >= queueable.length}>+</button>
          </div>
        </div>
        <button class="dl-option" disabled={dlBusy || queueable.length === 0}
          onclick={() => runDl(() => gql(ENQUEUE_CHAPTERS_DOWNLOAD, { chapterIds: queueable.map(c => c.id) }))}>
          All remaining
          <span class="dl-sub">{queueable.length} not yet downloaded</span>
        </button>
      </div>
    </div>
  {/if}
</ReaderHud>

<style>
  .error-stack { display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .reader-error-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .reader-error-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: var(--radius-md); border: 1px solid var(--accent-dim); background: var(--accent-muted); color: var(--accent-fg); font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); cursor: pointer; transition: background var(--t-base), border-color var(--t-base), color var(--t-base); }
  .reader-error-btn:hover { background: var(--accent-dim); }
  .reader-error-btn.subtle { border-color: var(--border-strong); background: var(--bg-raised); color: var(--text-secondary); }
  .reader-error-btn.subtle:hover { border-color: var(--border-focus); color: var(--text-primary); }

  .viewer { flex: 1; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; align-items: center; justify-content: center; -webkit-overflow-scrolling: touch; position: relative; }
  .viewer.strip { justify-content: flex-start; padding: var(--sp-4) 0; }
  .viewer:focus { outline: none; }

  .img { display: block; user-select: none; image-rendering: auto; }
  .img.optimize-contrast { image-rendering: -webkit-optimize-contrast; }
  .fit-width    { max-width: var(--effective-width, 100%); width: 100%; height: auto; }
  .fit-height   { max-height: calc(100vh - 80px); width: auto; max-width: var(--effective-width, 100%); height: auto; }
  .fit-screen   { max-width: var(--effective-width, 100%); max-height: calc(100vh - 80px); object-fit: contain; height: auto; }
  .fit-original { max-width: 100%; width: auto; height: auto; }
  .strip-gap { margin-bottom: 8px; }

  .double-wrap { display: flex; align-items: flex-start; justify-content: center; max-width: calc(var(--effective-width, 100%) * 2); width: 100%; }
  .page-half { flex: 1; min-width: 0; object-fit: contain; }
  .gap-left  { margin-right: 2px; }
  .gap-right { margin-left: 2px; }

  .center-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
  .error-msg { color: var(--color-error); font-size: var(--text-base); }

  .resume-banner { position: fixed; top: 48px; left: 50%; display: flex; align-items: center; gap: var(--sp-2); background: var(--bg-raised); border: 1px solid var(--border-base); border-radius: var(--hud-toast-radius); padding: 6px var(--sp-3); font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-secondary); z-index: 20; box-shadow: 0 4px 16px rgba(0,0,0,0.4); animation: bannerIn var(--t-slow) cubic-bezier(0.16,1,0.3,1) both; white-space: nowrap; cursor: pointer; }
  .resume-banner.fading { animation: bannerOut 1s ease forwards; }
  @keyframes bannerIn  { from { opacity: 0; transform: translateX(-50%) translateY(-6px) scale(0.97); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }
  @keyframes bannerOut { from { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } to { opacity: 0; transform: translateX(-50%) translateY(-4px) scale(0.97); } }
  .resume-jump { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--accent-fg); background: var(--accent-muted); border: 1px solid var(--accent-dim); border-radius: var(--radius-sm); padding: 2px 8px; cursor: pointer; transition: filter var(--t-fast); }
  .resume-jump:hover { filter: brightness(1.15); }

  .dl-backdrop { position: fixed; inset: 0; z-index: calc(var(--z-reader) + 10); display: flex; align-items: flex-start; justify-content: flex-end; padding: 48px var(--sp-4) 0; }
  .dl-modal { background: var(--bg-raised); border: 1px solid var(--border-base); border-radius: var(--hud-popover-radius); padding: var(--sp-3); min-width: 210px; display: flex; flex-direction: column; gap: var(--sp-1); box-shadow: 0 8px 32px rgba(0,0,0,0.6); animation: scaleIn var(--t-fast) both; transform-origin: top right; }
  .dl-title { font-family: var(--font-ui); font-size: var(--text-2xs); color: var(--text-faint); letter-spacing: var(--tracking-wider); text-transform: uppercase; padding: 2px var(--sp-2) var(--sp-2); border-bottom: 1px solid var(--border-dim); margin-bottom: var(--sp-1); }
  .dl-option { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; padding: 7px var(--sp-3); border-radius: var(--radius-md); font-size: var(--text-sm); color: var(--text-secondary); background: none; border: none; cursor: pointer; text-align: left; transition: background var(--t-fast), color var(--t-fast); }
  .dl-option:hover:not(:disabled) { background: var(--bg-overlay); color: var(--text-primary); }
  .dl-option:disabled { opacity: 0.3; cursor: default; }
  .dl-sub { font-size: var(--text-xs); color: var(--text-faint); }
  .dl-row { display: flex; align-items: center; gap: var(--sp-2); }
  .dl-stepper { display: flex; align-items: center; gap: 2px; background: var(--bg-overlay); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); overflow: hidden; flex-shrink: 0; }
  .dl-step-btn { display: flex; align-items: center; justify-content: center; width: 22px; height: 28px; font-size: var(--text-base); color: var(--text-muted); background: none; border: none; cursor: pointer; line-height: 1; transition: color var(--t-fast), background var(--t-fast); }
  .dl-step-btn:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-raised); }
  .dl-step-btn:disabled { opacity: 0.25; cursor: default; }
  .dl-step-val { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-secondary); min-width: 24px; text-align: center; letter-spacing: var(--tracking-wide); }

  @keyframes scaleIn { from { opacity: 0; transform: scale(0.97) } to { opacity: 1; transform: scale(1) } }
</style>
