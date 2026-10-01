<script lang="ts">
  // Root of a detached reader window. It hosts one manga, book or novel reader and relays every change the reader
  // makes to the main window, which stays the only writer of persisted state.
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import {
    store,
    closeBookReader,
    closeNovelReader,
    closeReader,
    openBookReader,
    openReader,
    replaceBooksState,
    setActiveNovelDetail,
    setActiveNovelReader,
  } from "../../store/state.svelte";
  import { configureDetachedMangaProgress, flushAllMangaProgress } from "../../lib/reader/mangaProgressRuntime";
  import type { DetachedReaderClient } from "../../lib/reader/detachedReaderClient";
  import { readDetachedPageUrls } from "../../lib/reader/detachedChannel";
  import { setNovelReaderRelay } from "../../lib/novels/readerData";
  import { setChapterPagesRelay } from "../../lib/manga/runtime/sourceOperations";
  import { relayDetachedStoreMethods } from "../../lib/reader/detachedStoreRelay";
  import { setFlareSolverrStartRelay } from "../../lib/flaresolverr";
  import { setOfflineMangaRelay } from "../../lib/reader/offlineManga";
  import { applyCustomTheme, clearCustomThemeProperties } from "../../lib/theme/provider";
  import { DEFAULT_BUILTIN_THEME_ID, normalizeThemeSelection } from "../../lib/theme/contract";
  import { _, applyAppLanguage } from "../../lib/i18n/runtime";
  import type { LocalProfileMeta } from "../../lib/localProfiles";

  let { client }: { client: DetachedReaderClient | null } = $props();

  const HUD_BASE_WIDTH = 1440;
  const HUD_BASE_HEIGHT = 900;
  const HUD_MIN_SCALE = 0.82;
  const HUD_MAX_SCALE = 1.08;
  const CLOSE_PROGRESS_WAIT_MS = 400;

  let MangaReaderComponent = $state<any>(null);
  let BookReaderComponent = $state<any>(null);
  let NovelReaderComponent = $state<any>(null);
  let novelReaderView = $state<{ requestNovelReaderClose(): Promise<unknown> } | null>(null);
  let ToasterComponent = $state<any>(null);
  let initialPages = $state.raw<{ chapterId: number; urls: string[] } | null>(null);
  let ready = $state(false);
  let finalizing = false;
  let readerWasOpen = false;
  let viewportRafId: number | null = null;
  let storeRelay: ReturnType<typeof relayDetachedStoreMethods> | null = null;

  const win = getCurrentWindow();
  const readerOpen = $derived(!!store.activeChapter || !!store.activeBookReaderId || !!store.activeNovelReader);
  const readerRenderKey = $derived(store.activeChapter ? `${store.activeChapter.id}:${store.readerSessionId}` : null);
  const windowTitle = $derived.by(() => {
    if (store.activeChapter) {
      return [store.activeManga?.title, store.activeChapter.name].filter(Boolean).join(" - ") || "Epigraph";
    }
    if (store.activeBookReaderId) {
      return store.books.find((book) => book.id === store.activeBookReaderId)?.title || "Epigraph";
    }
    if (store.activeNovelReader) {
      const reader = store.activeNovelReader;
      const novelTitle = store.activeNovelDetail?.novel.id === reader.novelId ? store.activeNovelDetail.novel.title : null;
      return [novelTitle, reader.chapterTitle].filter(Boolean).join(" - ") || "Epigraph";
    }
    return "Epigraph";
  });

  async function hydrateBooks() {
    const { reloadBookLibraryState } = await import("../../lib/books/libraryState");
    const next = await reloadBookLibraryState({ profileId: store.runtimeResolvedLocalProfileId });
    replaceBooksState({
      books: next.books,
      bookProgress: next.bookProgress,
      bookBookmarks: next.bookBookmarks,
      booksCategories: next.booksCategories,
      booksCategoryAssignments: next.booksCategoryAssignments,
      booksLibraryUi: next.booksLibraryUi,
    });
  }

  async function finalize() {
    if (finalizing || !client) return;
    finalizing = true;
    try {
      // Reading progress is in this window's journal from the moment it is recorded, and the main window takes that
      // journal over once this window is gone, so closing never waits on Suwayomi (Mihon's reader likewise saves
      // locally and syncs later). A reachable server still gets the last page before the window goes away.
      await Promise.race([flushAllMangaProgress(), new Promise((resolve) => setTimeout(resolve, CLOSE_PROGRESS_WAIT_MS))]);
      if (client.context.target.kind === "book") {
        await client.request("flushBookLibraryPersistence", []).catch((error) => console.warn("Book progress was not flushed:", error));
      }
      await client.drain();
    } finally {
      await win.destroy().catch(() => {});
    }
  }

  function applyViewportMetrics() {
    if (viewportRafId !== null) cancelAnimationFrame(viewportRafId);
    viewportRafId = requestAnimationFrame(() => {
      viewportRafId = null;
      const uiZoom = store.settings.uiZoom ?? 1.0;
      const visualWidth = window.innerWidth / uiZoom;
      const visualHeight = window.innerHeight / uiZoom;
      const hud = Math.min(HUD_MAX_SCALE, Math.max(HUD_MIN_SCALE, Math.min(visualWidth / HUD_BASE_WIDTH, visualHeight / HUD_BASE_HEIGHT)));
      const shellVisualWidth = Math.max(320, visualWidth - (88 * hud));
      const root = document.documentElement;
      root.style.setProperty("--visual-vh", `${visualHeight}px`);
      root.style.setProperty("--visual-vw", `${visualWidth}px`);
      root.style.setProperty("--app-shell-visual-width", `${shellVisualWidth}px`);
      root.style.setProperty("--hud-scale", hud.toFixed(4));
      root.style.setProperty("--app-resolution-scale", (1 + (hud - 1) * 0.6).toFixed(4));
      root.setAttribute("data-app-resolution-tier", shellVisualWidth <= 760 ? "compact" : shellVisualWidth <= 1220 ? "cozy" : "full");
    });
  }

  async function exitFullscreen() {
    await win.setFullscreen(false).catch((error) => console.warn("Could not exit fullscreen:", error));
    store.isFullscreen = await win.isFullscreen().catch(() => false);
  }

  function handleFullscreenEscape(event: KeyboardEvent) {
    if (event.key !== "Escape" || !store.isFullscreen) return;
    event.preventDefault();
    event.stopPropagation();
    void exitFullscreen();
  }

  $effect(() => {
    const themeId = normalizeThemeSelection(store.settings.theme, store.settings.customThemes ?? []);
    const root = document.documentElement;
    if (!themeId.startsWith("custom:")) {
      clearCustomThemeProperties(root);
      root.setAttribute("data-theme", themeId);
      return;
    }
    const custom = store.settings.customThemes?.find((theme) => theme.id === themeId);
    if (!custom || !applyCustomTheme(root, custom)) {
      clearCustomThemeProperties(root);
      root.setAttribute("data-theme", DEFAULT_BUILTIN_THEME_ID);
    }
  });

  $effect(() => {
    const uiZoom = store.settings.uiZoom ?? 1.0;
    document.documentElement.style.setProperty("--ui-zoom", String(uiZoom));
    document.documentElement.style.setProperty("--ui-scale", String(uiZoom));
    document.documentElement.style.zoom = `${uiZoom * 100}%`;
    applyViewportMetrics();
  });

  $effect(() => {
    applyAppLanguage(store.settings.appLanguage);
  });

  $effect(() => {
    const title = windowTitle;
    document.title = title;
    void win.setTitle(title).catch(() => {});
  });

  $effect(() => {
    if (!ready) return;
    if (readerOpen) {
      readerWasOpen = true;
      return;
    }
    if (readerWasOpen) void finalize();
  });

  onMount(() => {
    document.body.dataset.appShellMode = "reader";
    let disposed = false;
    const cleanups: Array<() => void> = [];

    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) return;
      if (storeRelay) storeRelay.adoptPersistedState();
      else store.adoptPersistedReaderState();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("keydown", handleFullscreenEscape, true);
    window.addEventListener("resize", applyViewportMetrics);
    cleanups.push(
      () => window.removeEventListener("storage", onStorage),
      () => window.removeEventListener("keydown", handleFullscreenEscape, true),
      () => window.removeEventListener("resize", applyViewportMetrics),
    );

    void import("../layout/Toaster.svelte").then((module) => { if (!disposed) ToasterComponent = module.default; });

    void (async () => {
      store.isFullscreen = await win.isFullscreen().catch(() => false);
      const unlistenResize = await win.onResized(async () => {
        store.isFullscreen = await win.isFullscreen().catch(() => store.isFullscreen);
      }).catch(() => () => {});
      const unlistenClose = await win.onCloseRequested((event) => {
        if (!client || finalizing) return;
        event.preventDefault();
        // Closing goes through the reader's own exit so progress is saved before the window goes away.
        if (store.activeChapter) closeReader();
        else if (store.activeBookReaderId) closeBookReader();
        else if (store.activeNovelReader) {
          if (novelReaderView) void novelReaderView.requestNovelReaderClose();
          else closeNovelReader();
        } else void finalize();
      }).catch(() => () => {});
      if (disposed) {
        unlistenResize();
        unlistenClose();
        return;
      }
      cleanups.push(unlistenResize, unlistenClose);
    })();

    if (client) {
      const link = client;
      const { context } = link;
      store.runtimeServerUrl = context.runtimeServerUrl;
      store.runtimeServerLabel = context.runtimeServerLabel;
      store.runtimeResolvedLocalProfileId = context.runtimeResolvedLocalProfileId as typeof store.runtimeResolvedLocalProfileId;
      store.runtimeResolvedLocalProfileMeta = context.runtimeResolvedLocalProfileMeta as LocalProfileMeta | null;
      storeRelay = relayDetachedStoreMethods(store, link);
      configureDetachedMangaProgress(link.label, (scope, progress) => link.notify("mangaProgressSaved", [scope, progress]));

      void (async () => {
        const target = context.target;
        if (target.kind === "manga") {
          setChapterPagesRelay(({ chapterId, mangaId }) => link.request("fetchChapterPages", [chapterId, mangaId]));
          setOfflineMangaRelay({
            open: (input) => link.request("openOfflineMangaChapter", [input]),
          });
          MangaReaderComponent = (await import("./Reader.svelte")).default;
          if (disposed) return;
          const urls = readDetachedPageUrls(target.pageUrls);
          if (urls) initialPages = { chapterId: target.chapter.id, urls };
          openReader(target.chapter, target.chapterList, target.manga);
        } else if (target.kind === "novel") {
          setNovelReaderRelay({
            loadChapter: (scope, reader) => link.request("loadNovelChapter", [scope, reader]),
            saveChanges: (scope, changes) => link.request("saveNovelReaderChanges", [scope, changes]),
          });
          setFlareSolverrStartRelay(() => link.request("startFlareSolverr", []));
          NovelReaderComponent = (await import("./NovelReader.svelte")).default;
          if (disposed) return;
          if (target.detail) setActiveNovelDetail(target.detail);
          setActiveNovelReader(target.reader);
        } else {
          await hydrateBooks().catch((error) => console.warn("Detached reader could not load the book library:", error));
          BookReaderComponent = (await import("./BookReader.svelte")).default;
          if (disposed) return;
          openBookReader(target.bookId);
        }
        ready = true;
      })().catch((error) => {
        console.error("Detached reader failed to open:", error);
        void finalize();
      });
    }

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      delete document.body.dataset.appShellMode;
    };
  });
</script>

<div id="app-shell" class="root epigraph-app-shell">
  <div class="content">
    {#if !client}
      <div class="page-loading" role="alert">{$_("reader_detachedDisconnected")}</div>
    {:else if store.activeChapter}
      {#if MangaReaderComponent}
        {@const MangaReaderView = MangaReaderComponent}
        {#key readerRenderKey}
          <MangaReaderView {initialPages} />
        {/key}
      {/if}
    {:else if store.activeBookReaderId}
      {#if BookReaderComponent}
        {@const BookReaderView = BookReaderComponent}
        <BookReaderView />
      {/if}
    {:else if store.activeNovelReader}
      {#if NovelReaderComponent}
        {@const NovelReaderView = NovelReaderComponent}
        <NovelReaderView bind:this={novelReaderView} />
      {/if}
    {:else if !ready}
      <div class="page-loading" aria-busy="true" aria-live="polite">
        {client.context.target.kind === "book" ? $_("ui_loadingBook") : $_("ui_loadingChapters")}
      </div>
    {/if}
  </div>
  {#if store.isFullscreen}
    <button
      type="button"
      class="fullscreen-exit-btn"
      title={$_("ui_exitFullscreen")}
      aria-label={$_("ui_exitFullscreen")}
      onclick={() => void exitFullscreen()}
    >
      {$_("ui_exitFullscreen")}
    </button>
  {/if}
  {#if ToasterComponent}
    {@const ToasterView = ToasterComponent}
    <ToasterView />
  {/if}
</div>

<style>
  .root {
    position: relative;
    height: 100%;
    overflow: hidden;
    background: var(--bg-void);
  }

  .content {
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
  }

  .page-loading {
    display: grid;
    place-items: center;
    min-height: 100%;
    padding: 24px;
    text-align: center;
    color: var(--component-app-loading-fg);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .fullscreen-exit-btn {
    position: fixed;
    top: 14px;
    right: 14px;
    z-index: var(--component-app-fullscreen-exit-z-index);
    min-height: var(--component-app-fullscreen-exit-min-height);
    padding: var(--component-app-fullscreen-exit-padding);
    border-radius: var(--component-app-fullscreen-exit-radius);
    border: var(--component-app-fullscreen-exit-border);
    background: var(--component-app-fullscreen-exit-bg);
    color: var(--component-app-fullscreen-exit-fg);
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    box-shadow: var(--component-app-fullscreen-exit-shadow);
    cursor: pointer;
  }

  .fullscreen-exit-btn:hover,
  .fullscreen-exit-btn:focus-visible {
    color: var(--component-app-fullscreen-exit-hover-fg);
    border-color: var(--component-app-fullscreen-exit-hover-border);
    background: var(--component-app-fullscreen-exit-hover-bg);
  }
</style>
