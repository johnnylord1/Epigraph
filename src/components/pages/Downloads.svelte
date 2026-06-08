<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { CircleNotch } from "phosphor-svelte";
  import { gql, thumbUrl } from "../../lib/client";
  import AppTopbar from "../layout/AppTopbar.svelte";
  import WindowControlsInline from "../layout/WindowControlsInline.svelte";
  import {
    GET_DOWNLOAD_STATUS,
    GET_DOWNLOADS_PATH,
    ENQUEUE_DOWNLOAD,
    START_DOWNLOADER,
    STOP_DOWNLOADER,
    DEQUEUE_DOWNLOAD,
    REORDER_DOWNLOAD,
  } from "../../lib/queries";
  import type { DownloadQueueItem, DownloadStatus } from "../../lib/types";
  import { store, openHomeDashboard, setActiveDownloads, setPausedDownloads } from "../../store/state.svelte";
  import type { ActiveDownload, PausedDownloadItem } from "../../store/state.svelte";

  type DownloadVisualState = "downloading" | "paused" | "queued" | "error" | "finished";
  type DisplayDownloadItem = DownloadQueueItem & {
    localState?: "PAUSED";
    localOrder?: number;
  };
  interface StorageInfo {
    manga_bytes: number;
    total_bytes: number;
    free_bytes: number;
    path: string;
  }
  interface ProgressSample {
    at: number;
    totalProgress: number;
  }

  let status: DownloadStatus | null = $state(null);
  let searchQuery = $state("");
  let pausingAll = $state(false);
  let resumingAll = $state(false);
  let dequeueing = $state(new Set<number>());
  let reordering = $state(new Set<number>());
  let pausingItems = $state(new Set<number>());
  let resumingItems = $state(new Set<number>());
  let itemOrder = $state(new Map<number, number>());
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let storageTimer: ReturnType<typeof setTimeout> | null = null;
  let storageInfo: StorageInfo | null = $state(null);
  let speedSample: ProgressSample | null = $state(null);
  let observedSpeedPerSecond = $state<number | null>(null);
  let initialLoadTimedOut = $state(false);
  let statusHydrated = $state(false);
  let statusRefreshInFlight = false;

  function syncPausedItems(next: PausedDownloadItem[]) {
    setPausedDownloads(next);
  }

  function getPausedItemsMap(): Map<number, PausedDownloadItem> {
    return new Map(store.pausedDownloads.map((item) => [item.chapterId, item]));
  }

  function toPausedDownloadItem(item: DisplayDownloadItem): PausedDownloadItem {
    return {
      chapterId: item.chapter.id,
      mangaId: item.chapter.mangaId,
      progress: item.progress,
      chapterName: item.chapter.name,
      pageCount: item.chapter.pageCount,
      mangaTitle: item.chapter.manga?.title ?? "Unknown title",
      thumbnailUrl: item.chapter.manga?.thumbnailUrl ?? "",
      order: item.localOrder ?? itemOrder.get(item.chapter.id) ?? 0,
    };
  }

  function fromPausedDownloadItem(item: PausedDownloadItem): DisplayDownloadItem {
    return {
      progress: item.progress,
      state: "QUEUED",
      localState: "PAUSED",
      localOrder: item.order,
      chapter: {
        id: item.chapterId,
        name: item.chapterName,
        mangaId: item.mangaId,
        pageCount: item.pageCount,
        manga: {
          id: item.mangaId,
          title: item.mangaTitle,
          thumbnailUrl: item.thumbnailUrl,
        },
      },
    };
  }

  function buildActiveDownloads(nextStatus: DownloadStatus | null, pausedItems: PausedDownloadItem[]): ActiveDownload[] {
    const merged = new Map<number, ActiveDownload>();
    (nextStatus?.queue ?? []).forEach((item) => {
      merged.set(item.chapter.id, {
        chapterId: item.chapter.id,
        mangaId: item.chapter.mangaId,
        progress: item.progress,
        state: item.state,
      });
    });
    pausedItems.forEach((item) => {
      if (!merged.has(item.chapterId)) {
        merged.set(item.chapterId, {
          chapterId: item.chapterId,
          mangaId: item.mangaId,
          progress: item.progress,
          state: "PAUSED",
        });
      }
    });
    return Array.from(merged.values());
  }

  function updateObservedSpeed(nextStatus: DownloadStatus) {
    const totalProgress = nextStatus.queue
      .filter((item) => item.state === "DOWNLOADING")
      .reduce((sum, item) => sum + item.progress, 0);
    const now = Date.now();

    if (speedSample) {
      const elapsed = Math.max((now - speedSample.at) / 1000, 0.001);
      const delta = Math.max(totalProgress - speedSample.totalProgress, 0);
      observedSpeedPerSecond = delta > 0 ? (delta * 100) / elapsed : (totalProgress > 0 ? 0 : null);
    }

    speedSample = { at: now, totalProgress };
  }

  function applyStatus(next: DownloadStatus) {
    initialLoadTimedOut = false;
    const nextOrder = new Map(itemOrder);
    next.queue.forEach((item, index) => {
      nextOrder.set(item.chapter.id, index);
    });
    itemOrder = nextOrder;

    const nextPaused = getPausedItemsMap();
    next.queue.forEach((item) => {
      nextPaused.delete(item.chapter.id);
    });
    syncPausedItems(Array.from(nextPaused.values()));

    status = next;
    updateObservedSpeed(next);
  }

  function leaveDownloads() {
    openHomeDashboard();
  }

  function syncDownloadsSearchDim(active: boolean) {
    document.body.classList.toggle("aethon-downloads-search-engaged", active);
  }

  async function loadStatus() {
    if (statusRefreshInFlight) return;
    statusRefreshInFlight = true;
    try {
      const data = await gql<{ downloadStatus: DownloadStatus }>(GET_DOWNLOAD_STATUS);
      applyStatus(data.downloadStatus);
    } catch (error) {
      console.error(error);
    } finally {
      statusHydrated = true;
      statusRefreshInFlight = false;
    }
  }

  async function loadStorageInfo() {
    try {
      const data = await gql<{ settings: { downloadsPath: string } }>(GET_DOWNLOADS_PATH);
      storageInfo = await invoke<StorageInfo>("get_storage_info", {
        downloadsPath: data.settings.downloadsPath ?? "",
      });
    } catch (error) {
      console.error(error);
      storageInfo = null;
    }
  }

  function clearDownloadTimers() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (storageTimer) {
      clearTimeout(storageTimer);
      storageTimer = null;
    }
  }

  function nextStatusPollDelay() {
    const liveQueue = status?.queue ?? [];
    const hasActiveWork = liveQueue.some((item) => item.state === "DOWNLOADING" || item.state === "QUEUED");
    return hasActiveWork || store.pausedDownloads.length > 0 ? 2000 : 8000;
  }

  function scheduleStatusPoll(delayMs = nextStatusPollDelay()) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      await loadStatus();
      scheduleStatusPoll();
    }, delayMs);
  }

  function scheduleStoragePoll(delayMs = 30000) {
    if (storageTimer) clearTimeout(storageTimer);
    storageTimer = setTimeout(async () => {
      await loadStorageInfo();
      scheduleStoragePoll();
    }, delayMs);
  }

  onMount(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        leaveDownloads();
      }
    };
    const initialLoadGuard = setTimeout(() => {
      if (!statusHydrated && status === null) {
        initialLoadTimedOut = true;
      }
    }, 1800);

    window.addEventListener("keydown", onKeydown);
    void loadStatus();
    void loadStorageInfo();
    scheduleStatusPoll(2000);
    scheduleStoragePoll();

    return () => {
      clearTimeout(initialLoadGuard);
      window.removeEventListener("keydown", onKeydown);
      document.body.classList.remove("aethon-downloads-search-engaged");
      clearDownloadTimers();
    };
  });

  $effect(() => {
    const nextActiveDownloads = buildActiveDownloads(status, store.pausedDownloads);
    if (sameActiveDownloads(nextActiveDownloads, store.activeDownloads)) return;
    setActiveDownloads(nextActiveDownloads);
  });

  async function pauseAll() {
    if (pausingAll || !status || activeCount === 0) return;
    pausingAll = true;

    try {
      const data = await gql<{ stopDownloader: { downloadStatus: DownloadStatus } }>(STOP_DOWNLOADER);
      applyStatus(data.stopDownloader.downloadStatus);
    } catch (error) {
      console.error(error);
      await loadStatus();
    } finally {
      pausingAll = false;
    }
  }

  async function resumeAll() {
    if (resumingAll || pausedCount === 0) return;
    resumingAll = true;
    const pausedEntries = [...store.pausedDownloads].sort((left, right) => left.order - right.order);

    try {
      if (pausedEntries.length > 0) {
        syncPausedItems([]);
        for (const entry of pausedEntries) {
          await gql(ENQUEUE_DOWNLOAD, { chapterId: entry.chapterId });
          if (entry.order <= 0) {
            await gql(REORDER_DOWNLOAD, { chapterId: entry.chapterId, to: 0 });
          }
        }
      }
      await gql<{ startDownloader: { downloadStatus: DownloadStatus } }>(START_DOWNLOADER);
      await loadStatus();
    } catch (error) {
      console.error(error);
      syncPausedItems(pausedEntries);
      await loadStatus();
    } finally {
      resumingAll = false;
    }
  }

  async function dequeue(chapterId: number) {
    if (dequeueing.has(chapterId)) return;

    dequeueing = new Set(dequeueing).add(chapterId);

    const pausedItems = getPausedItemsMap();
    if (pausedItems.has(chapterId)) {
      pausedItems.delete(chapterId);
      syncPausedItems(Array.from(pausedItems.values()));
      const next = new Set(dequeueing);
      next.delete(chapterId);
      dequeueing = next;
      return;
    }

    if (status) {
      status = {
        ...status,
        queue: status.queue.filter((item) => item.chapter.id !== chapterId),
      };
    }

    try {
      await gql(DEQUEUE_DOWNLOAD, { chapterId });
      await loadStatus();
    } catch (error) {
      console.error(error);
      await loadStatus();
    } finally {
      const next = new Set(dequeueing);
      next.delete(chapterId);
      dequeueing = next;
    }
  }

  async function pauseItem(item: DownloadQueueItem) {
    const chapterId = item.chapter.id;
    const pausedItems = getPausedItemsMap();
    if (pausingItems.has(chapterId) || pausedItems.has(chapterId)) return;

    pausingItems = new Set(pausingItems).add(chapterId);
    pausedItems.set(chapterId, toPausedDownloadItem({
      ...item,
      localState: "PAUSED",
      localOrder: itemOrder.get(item.chapter.id) ?? status?.queue.findIndex((entry) => entry.chapter.id === item.chapter.id) ?? 0,
    }));
    syncPausedItems(Array.from(pausedItems.values()));

    if (status) {
      status = {
        ...status,
        queue: status.queue.filter((entry) => entry.chapter.id !== chapterId),
      };
    }

    try {
      await gql(DEQUEUE_DOWNLOAD, { chapterId });
      await loadStatus();
    } catch (error) {
      console.error(error);
      pausedItems.delete(chapterId);
      syncPausedItems(Array.from(pausedItems.values()));
      await loadStatus();
    } finally {
      const next = new Set(pausingItems);
      next.delete(chapterId);
      pausingItems = next;
    }
  }

  async function resumeItem(item: DisplayDownloadItem) {
    const chapterId = item.chapter.id;
    if (resumingItems.has(chapterId)) return;

    resumingItems = new Set(resumingItems).add(chapterId);

    const pausedItems = getPausedItemsMap();
    const pausedEntry = pausedItems.get(chapterId) ?? toPausedDownloadItem(item);
    pausedItems.delete(chapterId);
    syncPausedItems(Array.from(pausedItems.values()));

    try {
      if (!item.localState && status?.queue.some((entry) => entry.chapter.id === chapterId)) {
        await gql(DEQUEUE_DOWNLOAD, { chapterId });
      }
      const data = await gql<{ enqueueChapterDownload: { downloadStatus: DownloadStatus } }>(ENQUEUE_DOWNLOAD, { chapterId });
      if (pausedEntry.order <= 0) {
        await gql(REORDER_DOWNLOAD, { chapterId, to: 0 });
      }
      applyStatus(data.enqueueChapterDownload.downloadStatus);
    } catch (error) {
      console.error(error);
      syncPausedItems([...store.pausedDownloads, pausedEntry]);
      await loadStatus();
    } finally {
      const next = new Set(resumingItems);
      next.delete(chapterId);
      resumingItems = next;
    }
  }

  async function moveToTop(chapterId: number) {
    if (reordering.has(chapterId)) return;

    const pausedItems = getPausedItemsMap();
    if (pausedItems.has(chapterId)) {
      const pausedItem = pausedItems.get(chapterId);
      if (!pausedItem) return;
      const nextBusy = new Set(reordering);
      nextBusy.add(chapterId);
      reordering = nextBusy;

      pausedItems.set(chapterId, {
        ...pausedItem,
        order: -1,
      });
      syncPausedItems(Array.from(pausedItems.values()));
      itemOrder = new Map(itemOrder).set(chapterId, -1);

      const next = new Set(reordering);
      next.delete(chapterId);
      reordering = next;
      return;
    }

    if (!status) return;

    const nextBusy = new Set(reordering);
    nextBusy.add(chapterId);
    reordering = nextBusy;

    const currentIndex = status.queue.findIndex((item) => item.chapter.id === chapterId);
    if (currentIndex > 0) {
      const reordered = [...status.queue];
      const [selected] = reordered.splice(currentIndex, 1);
      reordered.unshift(selected);
      status = { ...status, queue: reordered };
    }

    try {
      const data = await gql<{ reorderChapterDownload: { downloadStatus: DownloadStatus } }>(REORDER_DOWNLOAD, {
        chapterId,
        to: 0,
      });
      applyStatus(data.reorderChapterDownload.downloadStatus);
    } catch (error) {
      console.error(error);
      await loadStatus();
    } finally {
      const next = new Set(reordering);
      next.delete(chapterId);
      reordering = next;
    }
  }

  function matchesSearch(item: DisplayDownloadItem, query: string) {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return true;

    return (
      (item.chapter.manga?.title ?? "").toLowerCase().includes(normalized) ||
      item.chapter.name.toLowerCase().includes(normalized)
    );
  }

  function getVisualState(item: DisplayDownloadItem): DownloadVisualState {
    if (item.localState === "PAUSED") return "paused";
    if (item.state === "ERROR") return "error";
    if (item.state === "FINISHED") return "finished";
    if (status?.state === "STOPPED") return "paused";
    if (item.state === "QUEUED") return "queued";
    return "downloading";
  }

  function getStatusText(item: DisplayDownloadItem) {
    const visualState = getVisualState(item);
    const percent = Math.round(item.progress * 100);

    if (visualState === "error") return "Network Error";
    if (visualState === "finished") return "Finished";
    if (visualState === "queued") return "Queued";
    if (visualState === "paused") return `Paused · ${percent}%`;
    return `${percent}%`;
  }

  function getActionIcon(item: DisplayDownloadItem) {
    const visualState = getVisualState(item);
    if (visualState === "downloading" || visualState === "queued") return "pause";
    if (visualState === "paused") return "play_arrow";
    if (visualState === "error") return "replay";
    if (visualState === "finished") return "done";
    return "pause";
  }

  function getActionLabel(item: DisplayDownloadItem) {
    const visualState = getVisualState(item);
    if (visualState === "downloading" || visualState === "queued") return "Pause";
    if (visualState === "paused") return "Resume";
    if (visualState === "error") return "Retry";
    if (visualState === "finished") return "Completed";
    return "Pause";
  }

  function isActionBusy(item: DisplayDownloadItem) {
    return reordering.has(item.chapter.id) || pausingItems.has(item.chapter.id) || resumingItems.has(item.chapter.id);
  }

  let queue: DisplayDownloadItem[] = $derived.by((): DisplayDownloadItem[] => {
    const liveQueue = status?.queue ?? [];
    const merged = [
      ...liveQueue.map((item) => ({ ...item, localOrder: itemOrder.get(item.chapter.id) ?? liveQueue.findIndex((entry) => entry.chapter.id === item.chapter.id) })),
      ...store.pausedDownloads.map(fromPausedDownloadItem),
    ];

    return merged.sort((left, right) => {
      const leftOrder = left.localOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.localOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.chapter.id - right.chapter.id;
    });
  });
  let filteredQueue: DisplayDownloadItem[] = $derived(queue.filter((item: DisplayDownloadItem) => matchesSearch(item, searchQuery)));
  let queueSize: number = $derived(queue.length);
  let activeCount: number = $derived(queue.filter((item: DownloadQueueItem) => getVisualState(item) === "downloading").length);
  let pausedCount: number = $derived(queue.filter((item: DownloadQueueItem) => getVisualState(item) === "paused").length);
  let storageSummary: string = $derived.by(() =>
    storageInfo
      ? `${fmtBytes(storageInfo.manga_bytes)} / ${fmtBytes(storageInfo.free_bytes)} free`
      : "—",
  );
  let speedSummary: string = $derived(
    activeCount === 0 ? "Idle" : observedSpeedPerSecond === null ? "Measuring..." : `${formatObservedSpeed(observedSpeedPerSecond)}/s`,
  );
  let summaryStatus: string = $derived(
    queueSize === 0 ? "No downloads queued" : `${activeCount} Running · ${pausedCount} Paused`,
  );

  function fmtBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, index)).toFixed(index >= 2 ? 1 : 0)} ${units[index]}`;
  }

  function formatObservedSpeed(value: number): string {
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`;
  }

  function sameActiveDownloads(left: ActiveDownload[], right: ActiveDownload[]) {
    if (left.length !== right.length) return false;

    return left.every((entry, index) => {
      const other = right[index];
      return !!other
        && entry.chapterId === other.chapterId
        && entry.mangaId === other.mangaId
        && entry.progress === other.progress
        && entry.state === other.state;
    });
  }
</script>

<div class="root n-page-shell aethon-port--downloads">
  <div class="downloads-topbar-shell">
    <AppTopbar className="downloads-topbar">
      {#snippet center()}
        <div class="n-search" data-component="search-bar">
          <span class="n-search__icon material-symbols-outlined" aria-hidden="true">search</span>
          <input
            class="n-search__input"
            type="text"
            placeholder="Search downloads..."
            bind:value={searchQuery}
            onfocus={() => syncDownloadsSearchDim(true)}
            onblur={() => syncDownloadsSearchDim(false)}
          />
        </div>
      {/snippet}
      {#snippet right()}
        <button
          class="n-icon-btn"
          type="button"
          title="Filter"
          aria-label="Filter"
          data-inert-control="downloads-filter"
        >
          <span class="material-symbols-outlined" aria-hidden="true">filter_list</span>
        </button>
        <button
          class="n-icon-btn"
          type="button"
          title="More options"
          aria-label="More options"
          data-inert-control="downloads-more"
        >
          <span class="material-symbols-outlined" aria-hidden="true">more_vert</span>
        </button>
        <WindowControlsInline />
      {/snippet}
    </AppTopbar>
  </div>

  <div class="downloads-scroll">
    <div class="downloads-page">
      <div class="downloads-page__header">
        <div>
          <p class="n-eyebrow downloads-page__eyebrow">Downloads</p>
          <h1 class="n-title-xl">Download Queue</h1>
        </div>
        <div class="downloads-page__header-actions">
          <div class="n-soft-pill downloads-pill">
            <span class="material-symbols-outlined" aria-hidden="true">download</span>
            <span>{queueSize} {queueSize === 1 ? "Item" : "Items"}</span>
          </div>
          <button
            class="n-btn n-btn--md n-btn-ghost downloads-page__exit"
            type="button"
            onclick={leaveDownloads}
          >
            <span class="material-symbols-outlined" aria-hidden="true">home</span>
            <span>Home</span>
          </button>
        </div>
      </div>

      <section class="downloads-summary">
        <div class="downloads-summary__cluster">
          <div class="downloads-summary__metric">
            <span>Status</span>
            <strong>{summaryStatus}</strong>
          </div>
          <div class="downloads-summary__divider"></div>
          <div class="downloads-summary__metric">
            <span>Storage</span>
            <strong>{storageSummary}</strong>
          </div>
          <div class="downloads-summary__divider"></div>
          <div class="downloads-summary__metric">
            <span>Speed</span>
            <strong class="downloads-summary__accent">{speedSummary}</strong>
          </div>
        </div>

        <div class="downloads-summary__actions">
          <button
            class="n-btn n-btn--md n-btn-ghost downloads-summary__button"
            type="button"
            onclick={pauseAll}
            aria-disabled={queueSize === 0 || pausingAll}
          >
            {#if pausingAll}
              <CircleNotch size={16} weight="light" class="anim-spin" />
            {:else}
              <span class="material-symbols-outlined" aria-hidden="true">pause_circle</span>
            {/if}
            <span>Pause All</span>
          </button>
          <button
            class="n-btn n-btn--md n-btn-primary downloads-summary__button downloads-resume-all-btn"
            type="button"
            onclick={resumeAll}
            aria-disabled={queueSize === 0 || resumingAll}
          >
            {#if resumingAll}
              <CircleNotch size={16} weight="light" class="anim-spin" />
            {:else}
              <span class="material-symbols-outlined" aria-hidden="true">play_arrow</span>
            {/if}
            <span>Resume All</span>
          </button>
        </div>
      </section>

      {#if initialLoadTimedOut && status === null}
        <div class="downloads-load-note" role="status">
          <span>Download status is taking longer than usual. The page is still usable.</span>
        </div>
      {/if}

      {#if !statusHydrated && status === null}
        <div class="downloads-load-note downloads-load-note--inline" role="status">
          <span>Loading download queue...</span>
        </div>
      {/if}

      <div class="downloads-list">
        {#if filteredQueue.length === 0}
          <div class="downloads-empty">
            <span>{queueSize === 0 ? "No downloads queued." : "No downloads match this search."}</span>
          </div>
        {:else}
          {#each filteredQueue as item (item.chapter.id)}
            {@const manga = item.chapter.manga}
            {@const visualState = getVisualState(item)}
            {@const percent = Math.round(item.progress * 100)}
            {@const isRemoving = dequeueing.has(item.chapter.id)}
            {@const isActionPending = isActionBusy(item)}
            <div class="dl-row" class:is-paused={visualState === "paused"} class:is-faded={isRemoving}>
              <div class="dl-row__thumb">
                {#if manga?.thumbnailUrl}
                  <img
                    class="dl-row__image"
                    alt={manga.title}
                    src={thumbUrl(manga.thumbnailUrl)}
                    loading="lazy"
                    decoding="async"
                  />
                {/if}
              </div>

              <div class="dl-row__body">
                <div class="dl-row__header">
                  <div>
                    <h3 class="dl-row__title">{manga?.title ?? "Unknown title"}</h3>
                    <span class="dl-row__subtitle">{item.chapter.name}</span>
                  </div>
                  <span
                    class="dl-row__status"
                    class:dl-row__status--accent={visualState === "downloading"}
                    class:dl-row__status--muted={visualState === "paused" || visualState === "queued" || visualState === "finished"}
                    class:dl-row__status--error={visualState === "error"}
                  >
                    {getStatusText(item)}
                  </span>
                </div>

                <div class="dl-progress">
                  <div
                    class="dl-progress__fill"
                    class:dl-progress__fill--paused={visualState === "paused"}
                    class:dl-progress__fill--error={visualState === "error"}
                    style={`width: ${visualState === "queued" ? 0 : percent}%; ${visualState === "queued" ? "opacity: 0.15;" : ""}`}
                  ></div>
                </div>
              </div>

              <div class="dl-row__actions is-visible">
                <button
                  class="n-icon-btn dl-row__icon-btn"
                  type="button"
                  aria-label={getActionLabel(item)}
                  title={getActionLabel(item)}
                  onclick={() => {
                    if (visualState === "paused" || visualState === "error") {
                      void resumeItem(item);
                    } else if (visualState !== "finished") {
                      void pauseItem(item);
                    }
                  }}
                  disabled={visualState === "finished" || isActionPending}
                >
                  {#if isActionPending}
                    <CircleNotch size={16} weight="light" class="anim-spin" />
                  {:else}
                    <span class="material-symbols-outlined" aria-hidden="true">{getActionIcon(item)}</span>
                  {/if}
                </button>
                <button
                  class="n-icon-btn dl-row__icon-btn dl-row__icon-btn--danger"
                  type="button"
                  aria-label="Remove download"
                  title="Remove download"
                  onclick={() => dequeue(item.chapter.id)}
                  disabled={isRemoving}
                >
                  {#if isRemoving}
                    <CircleNotch size={16} weight="light" class="anim-spin" />
                  {:else}
                    <span class="material-symbols-outlined" aria-hidden="true">close</span>
                  {/if}
                </button>
                <button
                  class="n-icon-btn dl-row__icon-btn"
                  type="button"
                  aria-label="Move to top"
                  title="Move to top"
                  onclick={() => moveToTop(item.chapter.id)}
                  disabled={visualState === "finished" || isActionPending || queueSize <= 1}
                >
                  {#if reordering.has(item.chapter.id)}
                    <CircleNotch size={16} weight="light" class="anim-spin" />
                  {:else}
                    <span class="material-symbols-outlined" aria-hidden="true">vertical_align_top</span>
                  {/if}
                </button>
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <div class="downloads-bottom-spacer"></div>
    </div>
  </div>
</div>

<style>
  .root {
    position: relative;
    display: flex;
    min-height: 0;
    flex-direction: column;
  }

  .downloads-scroll {
    position: relative;
    z-index: 1;
  }

  .downloads-topbar-shell {
    position: sticky;
    top: 0;
    z-index: 50;
    flex-shrink: 0;
  }

  .downloads-topbar-shell :global(.n-topbar) {
    position: relative;
    top: auto;
    right: auto;
    left: auto;
    height: var(--n-topbar-height);
  }

  .downloads-topbar-shell :global(.n-topbar::before) {
    pointer-events: none;
  }

  .downloads-scroll {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    margin-top: 0;
    padding: 0 calc(40px * var(--n-hud-scale));
  }

  .downloads-page {
    width: 100%;
    margin: 0;
    padding: calc(20px * var(--n-hud-scale)) 0 0;
  }

  .downloads-page__header {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: calc(18px * var(--n-hud-scale));
    padding: calc(2px * var(--n-hud-scale)) 0;
  }

  .downloads-page__header-actions {
    display: flex;
    align-items: center;
    gap: calc(10px * var(--n-hud-scale));
  }

  .downloads-page__exit {
    white-space: nowrap;
  }

  .downloads-page__eyebrow {
    margin: 0 0 calc(4px * var(--n-hud-scale));
  }

  .downloads-pill .material-symbols-outlined {
    color: var(--n-primary-container);
    font-size: calc(12px * var(--n-hud-scale));
  }

  .downloads-pill {
    background: rgba(26, 25, 34, 0.6);
    border-color: rgba(184, 167, 234, 0.06);
    color: #b8b2c5;
    min-height: calc(30px * var(--n-hud-scale));
    padding-inline: calc(12px * var(--n-hud-scale));
    letter-spacing: 0.06em;
  }

  .downloads-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: calc(24px * var(--n-hud-scale));
    margin: calc(24px * var(--n-hud-scale)) 0;
    padding: calc(16px * var(--n-hud-scale));
    border: 1px solid rgba(72, 69, 79, 0.05);
    border-radius: calc(12px * var(--n-hud-scale));
    background: rgba(28, 27, 27, 0.6);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.015);
  }

  .downloads-summary__cluster {
    display: flex;
    align-items: center;
    gap: calc(24px * var(--n-hud-scale));
    min-width: 0;
    flex-wrap: wrap;
  }

  .downloads-summary__metric {
    display: flex;
    flex-direction: column;
    gap: calc(4px * var(--n-hud-scale));
    min-width: calc(120px * var(--n-hud-scale));
  }

  .downloads-summary__metric span {
    color: rgba(202, 196, 208, 0.4);
    font-size: calc(9px * var(--n-hud-scale));
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .downloads-summary__metric strong {
    color: var(--n-on-surface);
    font-size: calc(12px * var(--n-hud-scale));
    font-weight: 800;
    line-height: 1.2;
  }

  .downloads-summary__accent {
    color: var(--n-primary);
  }

  .downloads-summary__divider {
    width: 1px;
    height: calc(20px * var(--n-hud-scale));
    background: rgba(72, 69, 79, 0.1);
  }

  .downloads-summary__actions {
    display: flex;
    gap: calc(8px * var(--n-hud-scale));
    flex-wrap: wrap;
  }

  .downloads-summary__button {
    min-width: 0;
    min-height: calc(40px * var(--n-hud-scale));
    justify-content: center;
    border-radius: calc(12px * var(--n-hud-scale));
    padding-inline: calc(20px * var(--n-hud-scale));
    font-size: calc(12px * var(--n-hud-scale));
    font-weight: 700;
    letter-spacing: 0;
    text-transform: none;
  }

  .downloads-summary__button .material-symbols-outlined {
    font-size: calc(16px * var(--n-hud-scale));
  }

  .downloads-resume-all-btn {
    gap: calc(8px * var(--n-hud-scale));
    border: none;
    background: var(--n-gradient-primary);
    color: var(--n-on-primary);
    font-size: calc(12px * var(--n-hud-scale));
    font-weight: 800;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    box-shadow: 0 calc(4px * var(--n-hud-scale)) calc(16px * var(--n-hud-scale)) rgba(184, 167, 234, 0.18);
    transition: filter 140ms ease, box-shadow 140ms ease, transform 140ms ease;
  }

  .downloads-resume-all-btn:hover:not(:disabled):not([aria-disabled="true"]) {
    filter: brightness(1.1);
    box-shadow: 0 calc(6px * var(--n-hud-scale)) calc(20px * var(--n-hud-scale)) rgba(184, 167, 234, 0.28);
    transform: translateY(-1px);
  }

  .downloads-resume-all-btn:active:not(:disabled):not([aria-disabled="true"]) {
    transform: scale(0.95) translateY(0);
    box-shadow: 0 calc(2px * var(--n-hud-scale)) calc(8px * var(--n-hud-scale)) rgba(184, 167, 234, 0.15);
  }

  .downloads-resume-all-btn .material-symbols-outlined {
    font-size: calc(15px * var(--n-hud-scale));
    font-variation-settings: "FILL" 1, "wght" 500, "GRAD" 0, "opsz" 20;
    line-height: 1;
  }

  .downloads-summary__button.n-btn-ghost:disabled,
  .downloads-summary__button.n-btn-ghost[aria-disabled="true"] {
    opacity: 0.55;
    cursor: default;
    filter: none;
  }

  .downloads-resume-all-btn:disabled,
  .downloads-resume-all-btn[aria-disabled="true"] {
    opacity: 1;
    cursor: default;
    filter: none;
    box-shadow: 0 calc(4px * var(--n-hud-scale)) calc(16px * var(--n-hud-scale)) rgba(184, 167, 234, 0.18);
  }

  .downloads-list {
    display: flex;
    flex-direction: column;
    gap: calc(2px * var(--n-hud-scale));
  }

  .downloads-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: calc(180px * var(--n-hud-scale));
    color: rgba(202, 196, 208, 0.42);
    font-size: calc(12px * var(--n-hud-scale));
    text-align: center;
  }

  .downloads-load-note--inline {
    margin-top: calc(12px * var(--n-hud-scale));
  }

  .downloads-load-note {
    margin-top: calc(8px * var(--n-hud-scale));
    padding: calc(10px * var(--n-hud-scale)) calc(12px * var(--n-hud-scale));
    border: 1px solid rgba(184, 167, 234, 0.08);
    border-radius: calc(12px * var(--n-hud-scale));
    background: rgba(184, 167, 234, 0.04);
    color: rgba(227, 221, 240, 0.78);
    font-size: calc(11px * var(--n-hud-scale));
  }

  .dl-row {
    display: flex;
    align-items: center;
    gap: calc(20px * var(--n-hud-scale));
    padding: calc(12px * var(--n-hud-scale));
    background: transparent;
    border-radius: calc(12px * var(--n-hud-scale));
    cursor: default;
    transition:
      background 140ms ease,
      opacity 140ms ease;
  }

  .dl-row:hover {
    background: rgba(184, 167, 234, 0.03);
  }

  .dl-row.is-paused {
    opacity: 0.5;
  }

  .dl-row.is-faded {
    opacity: 0.5;
  }

  .dl-row__thumb {
    width: calc(44px * var(--n-hud-scale));
    height: calc(56px * var(--n-hud-scale));
    flex-shrink: 0;
    overflow: hidden;
    border-radius: calc(8px * var(--n-hud-scale));
    background: #353534;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
  }

  .dl-row.is-paused .dl-row__thumb {
    filter: grayscale(0.6);
  }

  .dl-row__image {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .dl-row__body {
    flex: 1;
    min-width: 0;
  }

  .dl-row__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: calc(16px * var(--n-hud-scale));
    margin-bottom: calc(6px * var(--n-hud-scale));
  }

  .dl-row__title {
    margin: 0;
    color: #e5e2e1;
    font-size: calc(12px * var(--n-hud-scale));
    font-weight: 800;
    line-height: 1.25;
  }

  .dl-row__subtitle {
    color: rgba(202, 196, 208, 0.5);
    font-size: calc(10px * var(--n-hud-scale));
    line-height: 1.2;
  }

  .dl-row__status {
    flex-shrink: 0;
    color: rgba(202, 196, 208, 0.4);
    font-size: calc(10px * var(--n-hud-scale));
    font-weight: 800;
    line-height: 1.2;
  }

  .dl-row__status--accent {
    color: var(--n-primary);
  }

  .dl-row__status--muted {
    color: rgba(202, 196, 208, 0.4);
  }

  .dl-row__status--error {
    color: var(--n-error);
  }

  .dl-progress {
    height: 3px;
    overflow: hidden;
    border-radius: 2px;
    background: rgba(148, 143, 154, 0.1);
  }

  .dl-progress__fill {
    height: 100%;
    border-radius: 2px;
    background: var(--n-gradient-primary);
    transition: width 400ms ease;
  }

  .dl-progress__fill--paused {
    background: rgba(148, 143, 154, 0.25);
  }

  .dl-progress__fill--error {
    background: var(--n-error);
  }

  .dl-row__actions {
    display: flex;
    align-items: center;
    gap: calc(2px * var(--n-hud-scale));
    opacity: 0;
    transition:
      opacity 140ms ease,
      filter 180ms ease;
  }

  .dl-row:hover .dl-row__actions,
  .dl-row__actions.is-visible {
    opacity: 1;
    filter: none;
  }

  .dl-row__icon-btn {
    width: calc(28px * var(--n-hud-scale));
    height: calc(28px * var(--n-hud-scale));
    border-color: transparent;
    background: transparent;
    opacity: 0.92;
    transition:
      opacity 140ms ease,
      background 140ms ease,
      border-color 140ms ease,
      box-shadow 140ms ease,
      transform 90ms ease;
  }

  .dl-row__icon-btn:hover:not(:disabled) {
    color: var(--n-on-surface);
    background: rgba(184, 167, 234, 0.06);
    border-color: rgba(184, 167, 234, 0.12);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  }

  .dl-row__icon-btn:active:not(:disabled) {
    transform: scale(0.9);
  }

  .dl-row__icon-btn:disabled {
    opacity: 0.7;
  }

  .dl-row__icon-btn .material-symbols-outlined {
    font-size: calc(16px * var(--n-hud-scale));
  }

  .dl-row__icon-btn--danger .material-symbols-outlined {
    color: var(--n-error);
  }

  .downloads-bottom-spacer {
    height: calc(48px * var(--n-hud-scale));
  }

  @media (max-width: 1180px) {
    .downloads-summary {
      flex-direction: column;
      align-items: flex-start;
    }

    .downloads-summary__actions {
      width: 100%;
    }
  }

  @media (max-width: 720px) {
    .downloads-scroll {
      padding: 0 calc(24px * var(--n-hud-scale));
    }

    .downloads-page__header {
      align-items: flex-start;
      flex-direction: column;
    }

    .downloads-summary__cluster {
      gap: calc(16px * var(--n-hud-scale));
    }

    .downloads-summary__divider {
      display: none;
    }

    .dl-row {
      gap: calc(14px * var(--n-hud-scale));
    }

    .dl-row__header {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
