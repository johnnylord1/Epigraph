<script lang="ts">
  import { onMount } from "svelte";
  import { _ } from "../../lib/i18n/runtime";
  import { store } from "../../store/state.svelte";
  import type { EpigraphRestorePlan } from "../../lib/backup/epigraphRestorePlanner";
  import type { BackupLaunchIntent } from "../../lib/backup/backupRollout";
  import Sidebar from "./Sidebar.svelte";
  import NocturneState from "../shared/NocturneState.svelte";
  import { peekPersistedBookEntry } from "../../lib/books/libraryState";
  import type { NavPage } from "../../store/state.svelte";

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
  type DetailKey = "book" | "series";
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
    series: () => import("../pages/SeriesDetail.svelte"),
  };

  const pageComponentPromises = new Map<PageKey, Promise<any>>();
  const detailComponentPromises = new Map<DetailKey, Promise<any>>();
  const pageComponentCache = new Map<PageKey, any>();
  const detailComponentCache = new Map<DetailKey, any>();
  let libraryComponent = $state<any>(null);
  let pageComponent = $state<any>(null);
  let pageKey = $state<PageKey | null>(null);
  let pageLoadedKey = $state<PageKey | null>(null);
  let pageError = $state<string | null>(null);
  let pageLoadRequestId = 0;
  let detailComponent = $state<any>(null);
  let detailKey = $state<DetailKey | null>(null);
  let detailLoadedKey = $state<DetailKey | null>(null);
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
      if (nextKey === "library") libraryComponent = cachedComponent;
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
      if (nextKey === "library") libraryComponent = component;
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

    if (hasActiveBook) {
      void loadDetail("book");
      return;
    }

    detailKey = null;
    detailComponent = null;
    detailLoadedKey = null;
  });

  onMount(() => {
    queueMicrotask(() => {
      void getCachedComponent(pageComponentPromises, "library", pageLoaders.library)
        .then((component) => {
          pageComponentCache.set("library", component);
          libraryComponent = component;
        })
        .catch((error) => {
          console.warn("Library preload did not complete; navigation will retry it.", error);
        });
      void getCachedComponent(pageComponentPromises, "home", pageLoaders.home)
        .catch((error) => {
          console.warn("Home preload did not complete; navigation will retry it.", error);
        });
    });
  });
</script>

<div class="root epigraph-app-shell">
  <Sidebar />
  <div class="main" class:main--settings={navPage === "settings"}>
    {#if libraryComponent}
      {@const LibraryPage = libraryComponent}
      <div
        class="page-keepalive"
        class:is-active={navPage === "library"}
        aria-hidden={navPage !== "library"}
        inert={navPage !== "library"}
      >
        <LibraryPage
          {onOpenThemeEditor}
          {backupAuditPlan}
          {backupRestoreLaunchIntent}
        />
      </div>
    {/if}

    {#if navPage === "library" && !libraryComponent}
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
      {:else if pageComponent && pageLoadedKey === navPage}
        {@const Page = pageComponent}
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
    {:else if navPage !== "library"}
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
        {:else if pageComponent && pageLoadedKey === navPage}
          {@const Page = pageComponent}
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

    {#if navPage !== "settings" && navPage !== "downloads" && !readerActive}
      {#if detailComponent && ((detailLoadedKey === "series" && store.activeManga) || (detailLoadedKey === "book" && hasActiveBook))}
        {@const DetailPage = detailComponent}
        <div class="detail-layer">
          <DetailPage />
        </div>
      {:else if detailKey && ((detailKey === "series" && store.activeManga) || (detailKey === "book" && hasActiveBook))}
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

<style>
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
  }

  .page-keepalive:not(.is-active) {
    position: absolute;
    inset: 0;
    z-index: var(--component-app-keepalive-hidden-z-index);
    visibility: hidden;
    opacity: 0;
    pointer-events: none;
    overflow: hidden;
    contain: layout paint style;
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
  }

</style>
