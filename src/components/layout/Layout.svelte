<script lang="ts">
  import { store } from "../../store/state.svelte";
  import type { AethonRestorePlan } from "../../lib/backup/aethonRestorePlanner";
  import type { BackupLaunchIntent } from "../../lib/backup/backupRollout";
  import Sidebar from "./Sidebar.svelte";
  import HomePage from "../pages/Home.svelte";
  import LibraryPage from "../pages/Library.svelte";
  import SearchPage from "../pages/Search.svelte";
  import DownloadsPage from "../pages/Downloads.svelte";
  import SettingsPage from "../settings/Settings.svelte";
  import SeriesDetailPage from "../pages/SeriesDetail.svelte";
  import { peekPersistedBookEntry } from "../../lib/books/libraryState";

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

  type DetailKey = "book";
  type PageModule = { default: any };

  const detailLoaders: Record<DetailKey, () => Promise<PageModule>> = {
    book: () => import("../pages/BookDetail.svelte"),
  };

  const detailComponentPromises = new Map<DetailKey, Promise<any>>();
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
    if (navPage === "settings" || navPage === "downloads") {
      detailKey = null;
      detailComponent = null;
      detailError = null;
      return;
    }

    if (hasActiveBook) {
      void loadDetail("book");
      return;
    }

    detailKey = null;
    detailComponent = null;
  });
</script>

<div class="root aethon-app-shell">
  <Sidebar />
  <div class="main" class:main--settings={navPage === "settings"}>
    {#if navPage === "library"}
      <LibraryPage
        {onOpenThemeEditor}
        {backupAuditPlan}
        {backupRestoreLaunchIntent}
      />
    {/if}

    {#key navPage}
      {#if navPage === "home"}
        <HomePage
          {onOpenThemeEditor}
          {backupAuditPlan}
          {backupRestoreLaunchIntent}
        />
      {:else if navPage === "search"}
        <SearchPage
          {onOpenThemeEditor}
          {backupAuditPlan}
          {backupRestoreLaunchIntent}
        />
      {:else if navPage === "downloads"}
        <DownloadsPage
          {onOpenThemeEditor}
          {backupAuditPlan}
          {backupRestoreLaunchIntent}
        />
      {:else if navPage === "settings"}
        <SettingsPage
          {onOpenThemeEditor}
          {backupAuditPlan}
          {backupRestoreLaunchIntent}
        />
      {/if}
    {/key}

    {#if navPage !== "settings" && navPage !== "downloads" && !readerActive}
      {#if store.activeManga}
        <div class="detail-layer">
          <SeriesDetailPage />
        </div>
      {:else if detailKey === "book" && detailComponent && hasActiveBook}
        {@const DetailPage = detailComponent}
        <div class="detail-layer">
          <DetailPage />
        </div>
      {:else if detailError}
        <div class="detail-layer">
          <div class="load-state" role="alert">
            <div class="load-state__title">Details failed to load</div>
            <div class="load-state__detail">{detailError}</div>
            <button type="button" class="load-state__action" onclick={() => detailKey && void loadDetail(detailKey)}>
              Retry details
            </button>
          </div>
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

  .load-state {
    display: grid;
    place-items: center;
    align-content: center;
    gap: 10px;
    min-height: 100%;
    padding: 32px;
    text-align: center;
    color: var(--n-text-muted);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .load-state__title {
    color: var(--n-text);
  }

  .load-state__detail {
    max-width: min(680px, 100%);
    letter-spacing: 0.02em;
    text-transform: none;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .load-state__action {
    border: 1px solid var(--n-border);
    background: var(--n-surface);
    color: var(--n-text);
    border-radius: 999px;
    padding: 10px 16px;
    cursor: pointer;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
</style>
