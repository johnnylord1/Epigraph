<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "../../store/state.svelte";
  import type { AethonRestorePlan } from "../../lib/backup/aethonRestorePlanner";
  import type { BackupLaunchIntent } from "../../lib/backup/backupRollout";
  import Sidebar from "./Sidebar.svelte";
  import NocturneState from "../shared/NocturneState.svelte";
  import { peekPersistedBookEntry } from "../../lib/books/libraryState";
  import type { NavPage } from "../../store/state.svelte";

  interface Props {
    onOpenThemeEditor?: (id?: string | null) => void;
    backupAuditPlan?: AethonRestorePlan | null;
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
  let pageComponent = $state<any>(null);
  let pageKey = $state<PageKey | null>(null);
  let pageError = $state<string | null>(null);
  let pageLoadRequestId = 0;
  let detailComponent = $state<any>(null);
  let detailKey = $state<DetailKey | null>(null);
  let detailError = $state<string | null>(null);
  let detailLoadRequestId = 0;

  function getCachedComponent<Key extends string>(
    cache: Map<Key, Promise<any>>,
    key: Key,
    loader: () => Promise<PageModule>,
  ) {
    let pending = cache.get(key);
    if (!pending) {
      pending = loader().then((module) => module.default);
      cache.set(key, pending);
    }
    return pending;
  }

  async function loadPage(nextKey: PageKey) {
    const requestId = ++pageLoadRequestId;
    pageKey = nextKey;
    pageError = null;

    try {
      const component = await getCachedComponent(pageComponentPromises, nextKey, pageLoaders[nextKey]);
      if (requestId !== pageLoadRequestId) return;
      pageComponent = component;
    } catch (error) {
      if (requestId !== pageLoadRequestId) return;
      pageComponent = null;
      pageError = error instanceof Error ? error.message : String(error);
      console.error(`Failed to load page "${nextKey}":`, error);
    }
  }

  async function loadDetail(nextKey: DetailKey) {
    const requestId = ++detailLoadRequestId;
    detailKey = nextKey;
    detailError = null;

    try {
      const component = await getCachedComponent(detailComponentPromises, nextKey, detailLoaders[nextKey]);
      if (requestId !== detailLoadRequestId) return;
      detailComponent = component;
    } catch (error) {
      if (requestId !== detailLoadRequestId) return;
      detailComponent = null;
      detailError = error instanceof Error ? error.message : String(error);
      console.error(`Failed to load detail page "${nextKey}":`, error);
    }
  }

  $effect(() => {
    const nextPage = navPage;
    void loadPage(nextPage);
  });

  $effect(() => {
    if (navPage === "settings" || navPage === "downloads") {
      detailKey = null;
      detailComponent = null;
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
  });

  onMount(() => {
    queueMicrotask(() => {
      void getCachedComponent(pageComponentPromises, "library", pageLoaders.library);
      void getCachedComponent(pageComponentPromises, "home", pageLoaders.home);
    });
  });
</script>

<div class="root aethon-app-shell">
  <Sidebar />
  <div class="main" class:main--settings={navPage === "settings"}>
    {#key navPage}
      {#if pageError}
        <div class="page-state">
          <NocturneState
            layout="center"
            tone="danger"
            icon="warning"
            eyebrow="Page status"
            title="Page failed to load"
            body="Aethon couldn't open this page."
            detail={pageError}
            actions={[{
              label: "Retry page",
              kind: "primary",
              icon: "retry",
              onClick: () => void loadPage(navPage),
            }]}
          />
        </div>
      {:else if pageComponent && pageKey === navPage}
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
            eyebrow="Loading"
            title="Opening page"
            body="Aethon is loading this surface."
          />
        </div>
      {/if}
    {/key}

    {#if navPage !== "settings" && navPage !== "downloads" && !readerActive}
      {#if detailComponent && ((detailKey === "series" && store.activeManga) || (detailKey === "book" && hasActiveBook))}
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
            eyebrow="Detail status"
            title="Opening details"
            body="Aethon is loading this detail page."
          />
        </div>
      {:else if detailError}
        <div class="detail-layer detail-layer--state">
          <NocturneState
            layout="center"
            tone="danger"
            icon="warning"
            eyebrow="Detail status"
            title="Details failed to load"
            body="Aethon couldn't open this detail page."
            detail={detailError}
            actions={[{
              label: "Retry details",
              kind: "primary",
              icon: "retry",
              onClick: () => detailKey && void loadDetail(detailKey),
            }]}
          />
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .root {
    position: relative;
    height: 100%;
    background: var(--n-gradient-bg), #131313;
    overflow: hidden;
  }

  .main {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    min-height: 0;
    margin-left: var(--n-sidebar-width, 74px);
    overflow-x: hidden;
    overflow-y: auto;
    background: var(--n-gradient-bg), #131313;
    overscroll-behavior: contain;
  }

  .main--settings {
    background: var(--n-gradient-bg), #131313;
    isolation: isolate;
  }

  .detail-layer {
    position: absolute;
    inset: 0;
    z-index: calc(var(--z-reader) + 10);
    background: var(--bg-surface);
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
