<script lang="ts">
  import { onMount, tick } from "svelte";
  import { _ } from "../../lib/i18n/runtime";
  import { hadPersistedStoreAtStartup, store } from "../../store/state.svelte";
  import type { EpigraphRestorePlan } from "../../lib/backup/epigraphRestorePlanner";
  import type { BackupLaunchIntent } from "../../lib/backup/backupRollout";
  import Sidebar from "./Sidebar.svelte";
  import NocturneState from "../shared/NocturneState.svelte";
  import { peekPersistedBookEntry } from "../../lib/books/libraryState";
  import type { NavPage } from "../../store/state.svelte";
  import { FIRST_RUN_COMPLETED_EVENT, FIRST_RUN_STORAGE_KEY, shouldStartFirstRun } from "../../lib/firstRun";
  import FirstRun from "../firstRun/FirstRun.svelte";
  import { enterView, prefersReducedMotion } from "../../lib/motion/motion";

  interface Props {
    onOpenThemeEditor?: (id?: string | null) => void;
    backupAuditPlan?: EpigraphRestorePlan | null;
    backupRestoreLaunchIntent?: BackupLaunchIntent | null;
  }

  let {
    onOpenThemeEditor,
    backupAuditPlan = null,
    backupRestoreLaunchIntent = null,
  }: Props = $props();

  let firstRunPending = $state(readFirstRunPending());

  function readFirstRunPending() {
    try {
      return shouldStartFirstRun(
        localStorage.getItem(FIRST_RUN_STORAGE_KEY),
        hadPersistedStoreAtStartup,
      );
    } catch {
      return false;
    }
  }

  const hasActiveBook = $derived(
    !!store.activeBookId && (
      !store.booksLibraryHydrated
      || store.books.some((book) => book.id === store.activeBookId)
      || !!peekPersistedBookEntry(store.activeBookId)
    ),
  );
  const navPage = $derived(store.navPage);
  const readerActive = $derived(!!store.activeChapter || !!store.activeBookReaderId || !!store.activeNovelReader);

  type PageKey = NavPage;
  type DetailKey = "book" | "novel" | "series";
  type PageModule = { default: any };

  const pageLoaders: Record<PageKey, () => Promise<PageModule>> = {
    home: () => import("../pages/Home.svelte"),
    library: () => import("../pages/Library.svelte"),
    search: () => import("../pages/Search.svelte"),
    downloads: () => import("../pages/Downloads.svelte"),
    settings: () => import("../settings/Settings.svelte"),
  };

  const detailLoaders: Record<DetailKey, () => Promise<PageModule>> = {
    book: () => import("../pages/BookDetail.svelte"),
    novel: () => import("../pages/NovelDetail.svelte"),
    series: () => import("../pages/SeriesDetail.svelte"),
  };

  const pageComponentPromises = new Map<PageKey, Promise<any>>();
  const detailComponentPromises = new Map<DetailKey, Promise<any>>();
  const pageComponentCache = new Map<PageKey, any>();
  const detailComponentCache = new Map<DetailKey, any>();
  // Pages that stay mounted once visited: switching back to them is a visibility change, not a
  // rebuild of thousands of nodes and a refetch of their data. Downloads (global Escape handler and
  // polling) and Settings are still mounted on demand.
  const KEEP_ALIVE_PAGES = ["home", "library", "search"] as const;
  type KeepAlivePage = (typeof KEEP_ALIVE_PAGES)[number];
  function isKeepAlivePage(page: PageKey | null): page is KeepAlivePage {
    return page !== null && (KEEP_ALIVE_PAGES as readonly string[]).includes(page);
  }
  let keptPages = $state<Partial<Record<KeepAlivePage, any>>>({});
  let leavingPage = $state<KeepAlivePage | null>(null);
  let leavingTimer: ReturnType<typeof setTimeout> | null = null;
  let previousNavPage: PageKey | null = null;
  const libraryComponent = $derived(keptPages.library ?? null);
  let pageComponent = $state<any>(null);
  let pageKey = $state<PageKey | null>(null);
  let pageLoadedKey = $state<PageKey | null>(null);
  let pageError = $state<string | null>(null);
  let pageLoadRequestId = 0;
  let detailComponent = $state<any>(null);
  let detailKey = $state<DetailKey | null>(null);
  let detailLoadedKey = $state<DetailKey | null>(null);
  let mainElement = $state<HTMLDivElement>();
  // A page that was loaded before renders in the same frame as the switch, so no loading state
  // flashes between two cached pages (the load effect only runs after that first render).
  const cachedPageForNav = $derived.by(() => {
    const page = navPage;
    return pageLoadedKey === page || pageComponentCache.has(page) ? pageComponentCache.get(page) ?? null : null;
  });
  let enteredPage = "";
  // Page arrivals follow the menu: moving down the sidebar rises from below, moving up drops in.
  const NAV_ORDER: string[] = ["home", "library", "search", "downloads", "settings"];
  let enteredDetail = "";

  // Every arrival of a page plays once; a kept-alive page replays when the user returns to it.
  $effect(() => {
    const page = navPage;
    const ready = isKeepAlivePage(page) ? !!keptPages[page] : pageLoadedKey === page || !!cachedPageForNav;
    if (!ready || !mainElement || page === enteredPage) return;
    const direction = NAV_ORDER.indexOf(page) >= NAV_ORDER.indexOf(enteredPage) ? 1 : -1;
    enteredPage = page;
    void tick().then(() => {
      const root = isKeepAlivePage(page)
        ? mainElement?.querySelector(":scope > .page-keepalive.is-active > *")
        : mainElement?.querySelector(":scope > :not(.page-keepalive):not(.detail-layer):not(.activity-overlay-pending)");
      enterView(root, { y: 24 * direction });
    });
  });

  // A detail view (a series, a novel or a book) rises in over the page each time a different work opens.
  const detailIdentity = $derived(
    detailLoadedKey === "series" && store.activeManga ? `series:${store.activeManga.id}`
      : detailLoadedKey === "novel" && store.activeNovelDetail ? `novel:${store.activeNovelDetail.novel.id}`
      : detailLoadedKey === "book" && hasActiveBook ? `book:${store.activeBookId}`
      : "",
  );
  $effect(() => {
    const identity = detailIdentity;
    if (identity === enteredDetail) return;
    enteredDetail = identity;
    if (!identity) return;
    void tick().then(() => enterView(mainElement?.querySelector(":scope > .detail-layer > *"), { y: 16 }));
  });
  let detailError = $state<string | null>(null);
  let detailLoadRequestId = 0;
  let ActivityOverlayComponent = $state<any>(null);
  let activityOverlayPromise: Promise<any> | null = null;
  let activityOverlayError = $state<string | null>(null);

  function ensureActivityOverlay() {
    activityOverlayError = null;
    activityOverlayPromise ??= import("./ActivityOverlay.svelte")
      .then((module) => module.default)
      .catch((error) => {
        activityOverlayPromise = null;
        activityOverlayError = error instanceof Error ? error.message : String(error);
        console.error("Failed to load the activity overlay:", error);
        return null;
      });
    return activityOverlayPromise;
  }

  function getCachedComponent<Key extends string>(
    cache: Map<Key, Promise<any>>,
    key: Key,
    loader: () => Promise<PageModule>,
  ) {
    let pending = cache.get(key);
    if (!pending) {
      pending = loader()
        .then((module) => module.default)
        .catch((error) => {
          cache.delete(key);
          throw error;
        });
      cache.set(key, pending);
    }
    return pending;
  }

  async function loadPage(nextKey: PageKey) {
    const requestId = ++pageLoadRequestId;
    pageKey = nextKey;
    pageError = null;

    const cachedComponent = pageComponentCache.get(nextKey);
    if (cachedComponent) {
      if (isKeepAlivePage(nextKey)) keptPages[nextKey] = cachedComponent;
      pageComponent = cachedComponent;
      pageLoadedKey = nextKey;
      return;
    }

    pageComponent = null;
    pageLoadedKey = null;

    try {
      const component = await getCachedComponent(pageComponentPromises, nextKey, pageLoaders[nextKey]);
      if (requestId !== pageLoadRequestId) return;
      pageComponentCache.set(nextKey, component);
      if (isKeepAlivePage(nextKey)) keptPages[nextKey] = component;
      pageComponent = component;
      pageLoadedKey = nextKey;
    } catch (error) {
      if (requestId !== pageLoadRequestId) return;
      pageComponent = null;
      pageLoadedKey = null;
      pageError = error instanceof Error ? error.message : String(error);
      console.error(`Failed to load page "${nextKey}":`, error);
    }
  }

  function detailActive(key: DetailKey) {
    if (key === "series") return !!store.activeManga;
    if (key === "novel") return !!store.activeNovelDetail;
    return hasActiveBook;
  }

  async function loadDetail(nextKey: DetailKey) {
    const requestId = ++detailLoadRequestId;
    detailKey = nextKey;
    detailError = null;

    const cachedComponent = detailComponentCache.get(nextKey);
    if (cachedComponent) {
      detailComponent = cachedComponent;
      detailLoadedKey = nextKey;
      return;
    }

    detailComponent = null;
    detailLoadedKey = null;

    try {
      const component = await getCachedComponent(detailComponentPromises, nextKey, detailLoaders[nextKey]);
      if (requestId !== detailLoadRequestId) return;
      detailComponentCache.set(nextKey, component);
      detailComponent = component;
      detailLoadedKey = nextKey;
    } catch (error) {
      if (requestId !== detailLoadRequestId) return;
      detailComponent = null;
      detailLoadedKey = null;
      detailError = error instanceof Error ? error.message : String(error);
      console.error(`Failed to load detail page "${nextKey}":`, error);
    }
  }

  $effect(() => {
    if (store.activityPanelOpen && !ActivityOverlayComponent && !activityOverlayError) {
      void ensureActivityOverlay().then((component) => {
        ActivityOverlayComponent = component;
      });
    }
  });

  $effect(() => {
    const nextPage = navPage;
    void loadPage(nextPage);
  });

  // The page being left fades out on top while the next one rises in (keep-alive pages only: the
  // others are already gone). Purely visual; input goes to the new page at once.
  $effect(() => {
    const page = navPage;
    const previous = previousNavPage;
    previousNavPage = page;
    if (previous === null || previous === page) return;
    // Hidden pages are not marked inert: toggling inert restyles the whole page on every switch.
    // content-visibility already keeps them out of the Tab order, so only a focus left behind needs to go.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest(`[data-keepalive-page="${previous}"]`)) focused.blur();
    if (leavingTimer) clearTimeout(leavingTimer);
    if (!isKeepAlivePage(previous) || !keptPages[previous] || prefersReducedMotion()) {
      leavingPage = null;
      return;
    }
    leavingPage = previous;
    leavingTimer = setTimeout(() => {
      leavingTimer = null;
      leavingPage = null;
    }, 200);
  });

  $effect(() => {
    if (navPage === "settings" || navPage === "downloads") {
      detailKey = null;
      detailComponent = null;
      detailLoadedKey = null;
      detailError = null;
      return;
    }

    if (store.activeManga) {
      void loadDetail("series");
      return;
    }

    if (store.activeNovelDetail) {
      void loadDetail("novel");
      return;
    }

    if (hasActiveBook) {
      void loadDetail("book");
      return;
    }

    detailKey = null;
    detailComponent = null;
    detailLoadedKey = null;
  });

  onMount(() => {
    const handleFirstRunCompleted = () => { firstRunPending = readFirstRunPending(); };
    window.addEventListener(FIRST_RUN_COMPLETED_EVENT, handleFirstRunCompleted);
    queueMicrotask(() => {
      void getCachedComponent(pageComponentPromises, "library", pageLoaders.library)
        .then((component) => {
          pageComponentCache.set("library", component);
          keptPages.library = component;
        })
        .catch((error) => {
          console.warn("Library preload did not complete; navigation will retry it.", error);
        });
      void getCachedComponent(pageComponentPromises, "home", pageLoaders.home)
        .catch((error) => {
          console.warn("Home preload did not complete; navigation will retry it.", error);
        });
    });
    return () => window.removeEventListener(FIRST_RUN_COMPLETED_EVENT, handleFirstRunCompleted);
  });
</script>

{#snippet detailSurface()}
  {#if navPage !== "settings" && navPage !== "downloads" && !readerActive}
    {#if detailComponent && detailLoadedKey && detailActive(detailLoadedKey)}
      {@const DetailPage = detailComponent}
      <div class="detail-layer">
        <DetailPage />
      </div>
    {:else if detailKey && detailActive(detailKey)}
      <div class="detail-layer detail-layer--state">
        <NocturneState
          layout="center"
          tone="info"
          icon="info"
          eyebrow={$_("shell.detailState.status")}
          title={$_("shell.detailState.openingTitle")}
          body={$_("shell.detailState.openingBody")}
        />
      </div>
    {:else if detailError}
      <div class="detail-layer detail-layer--state">
        <NocturneState
          layout="center"
          tone="danger"
          icon="warning"
          eyebrow={$_("shell.detailState.status")}
          title={$_("shell.detailState.failedTitle")}
          body={$_("shell.detailState.failedBody")}
          actions={[{
            label: $_("shell.detailState.retry"),
            kind: "primary",
            icon: "retry",
            onClick: () => detailKey && void loadDetail(detailKey),
          }]}
        />
      </div>
    {/if}
  {/if}
{/snippet}

{#if firstRunPending}
  <div class="first-run-layout">
    <FirstRun onComplete={() => (firstRunPending = false)} />
    {@render detailSurface()}
  </div>
{:else}
<div class="root epigraph-app-shell">
  <Sidebar />
  <div class="main" class:main--settings={navPage === "settings"} bind:this={mainElement}>
    {#each KEEP_ALIVE_PAGES as key (key)}
      {#if keptPages[key]}
        {@const KeptPage = keptPages[key]}
        <div
          class="page-keepalive"
          class:is-active={navPage === key}
          class:is-leaving={leavingPage === key && navPage !== key}
          data-keepalive-page={key}
          aria-hidden={navPage !== key}
        >
          <KeptPage
            {onOpenThemeEditor}
            {backupAuditPlan}
            {backupRestoreLaunchIntent}
          />
        </div>
      {/if}
    {/each}

    {#if isKeepAlivePage(navPage) && !keptPages[navPage]}
      {#if pageError}
        <div class="page-state">
          <NocturneState
            layout="center"
            tone="danger"
            icon="warning"
            eyebrow={$_("shell.pageState.status")}
            title={$_("shell.pageState.failedTitle")}
            body={$_("shell.pageState.failedBody")}
            actions={[{
              label: $_("shell.pageState.retry"),
              kind: "primary",
              icon: "retry",
              onClick: () => void loadPage(navPage),
            }]}
          />
        </div>
      {:else}
        <div class="page-state">
          <NocturneState
            layout="center"
            tone="info"
            icon="info"
            eyebrow={$_("shell.pageState.loading")}
            title={$_("shell.pageState.openingTitle")}
            body={$_("shell.pageState.openingBody")}
          />
        </div>
      {/if}
    {:else if !isKeepAlivePage(navPage)}
      {#key navPage}
        {#if pageError}
          <div class="page-state">
            <NocturneState
              layout="center"
              tone="danger"
              icon="warning"
              eyebrow={$_("shell.pageState.status")}
              title={$_("shell.pageState.failedTitle")}
              body={$_("shell.pageState.failedBody")}
              actions={[{
                label: $_("shell.pageState.retry"),
                kind: "primary",
                icon: "retry",
                onClick: () => void loadPage(navPage),
              }]}
            />
          </div>
        {:else if cachedPageForNav || (pageComponent && pageLoadedKey === navPage)}
          {@const Page = cachedPageForNav ?? pageComponent}
          <Page
            {onOpenThemeEditor}
            {backupAuditPlan}
            {backupRestoreLaunchIntent}
          />
        {:else}
          <div class="page-state">
            <NocturneState
              layout="center"
              tone="info"
              icon="info"
              eyebrow={$_("shell.pageState.loading")}
              title={$_("shell.pageState.openingTitle")}
              body={$_("shell.pageState.openingBody")}
            />
          </div>
        {/if}
      {/key}
    {/if}

    {@render detailSurface()}

    {#if store.activityPanelOpen && !readerActive}
      {#if ActivityOverlayComponent}
        {@const ActivityOverlayView = ActivityOverlayComponent}
        <ActivityOverlayView />
      {:else if activityOverlayError}
        <div class="activity-overlay-pending">
          <NocturneState
            layout="center"
            tone="danger"
            icon="warning"
            eyebrow={$_("shell.pageState.status")}
            title={$_("shell.pageState.failedTitle")}
            body={$_("shell.pageState.failedBody")}
            actions={[{
              label: $_("shell.pageState.retry"),
              kind: "primary",
              icon: "retry",
              onClick: () => void ensureActivityOverlay().then((component) => {
                if (component) ActivityOverlayComponent = component;
              }),
            }]}
          />
        </div>
      {:else}
        <div class="activity-overlay-pending" aria-busy="true" aria-live="polite">
          <NocturneState layout="center" tone="info" icon="info" eyebrow={$_("ui_recentActivity")} title={$_("ui_loading")} />
        </div>
      {/if}
    {/if}
  </div>
</div>
{/if}

<style>
  .first-run-layout {
    position: relative;
    height: 100%;
  }

  .root {
    position: relative;
    height: 100%;
    background: var(--component-app-bg);
    overflow: hidden;
  }

  .activity-overlay-pending {
    position: absolute;
    inset: 0;
    z-index: var(--component-activity-overlay-z-index);
    display: grid;
    place-items: center;
    background: var(--component-activity-overlay-bg);
    backdrop-filter: var(--component-activity-overlay-blur);
  }

  .main {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    min-height: 0;
    margin-left: var(--component-layout-main-sidebar-offset);
    overflow-x: hidden;
    overflow-y: auto;
    background: var(--component-app-bg);
    overscroll-behavior: contain;
  }

  .main--settings {
    background: var(--component-app-bg);
    isolation: isolate;
  }

  .page-keepalive {
    flex: 1;
    min-width: 0;
    min-height: 0;
    position: relative;
    /* Pages scroll inside themselves. Without the clip, a page rising in overflowed .main for the length of
       its entrance: a scrollbar came and went, narrowing the Library grid and re-laying out every card twice. */
    overflow: clip;
  }

  .page-keepalive:not(.is-active) {
    position: absolute;
    inset: 0;
    z-index: var(--component-app-keepalive-hidden-z-index);
    /* content-visibility instead of visibility: toggling an inherited visibility left WebView2 holding a
       stale `hidden` style on blocks that were animating in, so parts of a returning page stayed blank.
       It also skips rendering the hidden pages altogether. */
    content-visibility: hidden;
    opacity: 0;
    pointer-events: none;
    overflow: hidden;
    contain: layout paint style;
  }

  .page-keepalive.is-leaving:not(.is-active) {
    content-visibility: visible;
    animation: pageLeave 180ms cubic-bezier(0.4, 0, 1, 1) forwards;
  }

  @keyframes pageLeave {
    from { opacity: 1; transform: none; filter: blur(0); }
    to { opacity: 0; transform: translateY(-8px) scale(0.99); filter: blur(4px); }
  }

  .detail-layer {
    position: absolute;
    inset: 0;
    z-index: calc(var(--z-reader) + 10);
    background: var(--component-detail-layer-bg);
  }

  .detail-layer--state {
    display: grid;
    place-items: center;
    padding: 32px;
  }

  .page-state {
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
    padding: 32px;
    /* Only a slow first load shows its opening state; fast loads never flash it. */
    animation: fadeIn 240ms ease 180ms both;
  }

</style>
