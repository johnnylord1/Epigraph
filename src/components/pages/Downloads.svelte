<script lang="ts">
  import { onMount } from "svelte";
  import { leaveView } from "../../lib/motion/motion";
  import { invoke } from "@tauri-apps/api/core";
  import { open as openPath } from "@tauri-apps/plugin-shell";
  import { CircleNotch } from "phosphor-svelte";
  import { _ } from "../../lib/i18n/runtime";
  import { gql } from "../../lib/client";
  import { resolveMangaCoverUrl } from "../../lib/manga/coverResolver";
  import AppTopbar from "../layout/AppTopbar.svelte";
  import ActivityButton from "../layout/ActivityButton.svelte";
  import WindowControlsInline from "../layout/WindowControlsInline.svelte";
  import {
    GET_DOWNLOAD_STATUS,
    GET_DOWNLOADS_PATH,
    ENQUEUE_DOWNLOAD,
    START_DOWNLOADER,
    STOP_DOWNLOADER,
    CLEAR_DOWNLOADER,
    DEQUEUE_DOWNLOAD,
    REORDER_DOWNLOAD,
  } from "../../lib/queries";
  import type { DownloadQueueItem, DownloadStatus } from "../../lib/types";
  import { store, openHomeDashboard, engageSearch, disengageSearch, openSearchPalette, setActiveDownloads, setPausedDownloads, setSearchDownloads, setSearchQuery } from "../../store/state.svelte";
  import type { ActiveDownload, PausedDownloadItem } from "../../store/state.svelte";

  type DownloadVisualState = "downloading" | "paused" | "queued" | "error" | "finished";
  type DownloadFilter = "all" | DownloadVisualState;
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
  let downloadFilter = $state<DownloadFilter>("all");
  let filterPanelOpen = $state(false);
  let morePanelOpen = $state(false);
  let clearingFinished = $state(false);
  let retryingFailed = $state(false);
  let openingFolder = $state(false);
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
      mangaTitle: item.chapter.manga?.title ?? $_("downloads.unknownTitle"),
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

    // A chapter that leaves the queue after downloading is on disk now, so the storage figure is stale.
    const nextIds = new Set(next.queue.map((item) => item.chapter.id));
    if (status?.queue.some((item) => item.state === "DOWNLOADING" && !nextIds.has(item.chapter.id))) void loadStorageInfo();
    status = next;
    updateObservedSpeed(next);
  }

  function leaveDownloads() {
    openHomeDashboard();
  }

  $effect(() => {
    if (store.searchContext === "downloads" && searchQuery !== store.searchQuery) {
      searchQuery = store.searchQuery;
    }
  });

  function toggleFilterPanel() {
    filterPanelOpen = !filterPanelOpen;
    if (filterPanelOpen) morePanelOpen = false;
  }

  function toggleMorePanel() {
    morePanelOpen = !morePanelOpen;
    if (morePanelOpen) filterPanelOpen = false;
  }

  function selectDownloadFilter(filter: DownloadFilter) {
    downloadFilter = filter;
    filterPanelOpen = false;
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
      // A blank path means the running profile's default folder, not the main profile's.
      storageInfo = await invoke<StorageInfo>("get_storage_info", {
        downloadsPath: data.settings.downloadsPath ?? "",
        profileId: store.runtimeResolvedLocalProfileId ?? null,
      });
    } catch (error) {
      console.error(error);
      storageInfo = null;
    }
  }

  async function getDownloadsPath() {
    if (storageInfo?.path) return storageInfo.path;
    const data = await gql<{ settings: { downloadsPath: string } }>(GET_DOWNLOADS_PATH);
    return data.settings.downloadsPath ?? "";
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
        if (filterPanelOpen || morePanelOpen) {
          filterPanelOpen = false;
          morePanelOpen = false;
          return;
        }
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
      document.body.classList.remove("epigraph-downloads-search-engaged");
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

  async function clearFinished() {
    if (clearingFinished || finishedCount === 0) return;
    clearingFinished = true;
    morePanelOpen = false;

    try {
      const data = await gql<{ clearDownloader: { downloadStatus: DownloadStatus } }>(CLEAR_DOWNLOADER);
      applyStatus(data.clearDownloader.downloadStatus);
    } catch (error) {
      console.error(error);
      await loadStatus();
    } finally {
      clearingFinished = false;
    }
  }

  async function retryFailed() {
    if (retryingFailed || failedCount === 0) return;
    retryingFailed = true;
    morePanelOpen = false;

    try {
      const failedItems = queue.filter((item) => getVisualState(item) === "error");
      for (const item of failedItems) {
        await resumeItem(item);
      }
      await loadStatus();
    } finally {
      retryingFailed = false;
    }
  }

  async function openDownloadsFolder() {
    if (openingFolder) return;
    openingFolder = true;
    morePanelOpen = false;

    try {
      const downloadsPath = await getDownloadsPath();
      if (downloadsPath) await openPath(downloadsPath);
    } catch (error) {
      console.error(error);
    } finally {
      openingFolder = false;
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

    if (visualState === "error") return $_("downloads.status.failed");
    if (visualState === "finished") return $_("downloads.status.finished");
    if (visualState === "queued") return $_("downloads.status.queued");
    if (visualState === "paused") return $_("downloads.status.pausedPercent", { values: { percent } });
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
    if (visualState === "downloading" || visualState === "queued") return $_("downloads.actions.pause");
    if (visualState === "paused") return $_("downloads.actions.resume");
    if (visualState === "error") return $_("downloads.actions.retry");
    if (visualState === "finished") return $_("downloads.actions.completed");
    return $_("downloads.actions.pause");
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
  $effect(() => {
    setSearchDownloads([
      ...store.novelDownloads.map((novel) => ({
        novelId: novel.novelId,
        mangaTitle: novel.title,
        chapterName: $_("novelDetail_download_progress", { done: novel.done, total: novel.total }),
        progress: novel.total > 0 ? novel.done / novel.total : 0,
        status: "DOWNLOADING",
        image: novel.coverUrl ?? null,
      })),
      ...queue.map((item) => ({
        chapterId: item.chapter.id,
        mangaTitle: item.chapter.manga?.title ?? $_("downloads.unknownTitle"),
        chapterName: item.chapter.name,
        progress: item.progress,
        status: item.state,
        image: item.chapter.manga?.thumbnailUrl ?? null,
      })),
    ]);
  });
  let filteredQueue: DisplayDownloadItem[] = $derived(queue.filter((item: DisplayDownloadItem) => {
    if (!matchesSearch(item, searchQuery)) return false;
    return downloadFilter === "all" || getVisualState(item) === downloadFilter;
  }));
  // A novel being saved is always an active download, found by its title.
  let filteredNovelDownloads = $derived(store.novelDownloads.filter((novel) => {
    const normalized = searchQuery.trim().toLowerCase();
    if (normalized && !novel.title.toLowerCase().includes(normalized)) return false;
    return downloadFilter === "all" || downloadFilter === "downloading";
  }));
  let queueSize: number = $derived(queue.length);
  let activeCount: number = $derived(queue.filter((item: DownloadQueueItem) => getVisualState(item) === "downloading").length);
  let pausedCount: number = $derived(queue.filter((item: DownloadQueueItem) => getVisualState(item) === "paused").length);
  let queuedCount: number = $derived(queue.filter((item: DownloadQueueItem) => getVisualState(item) === "queued").length);
  let failedCount: number = $derived(queue.filter((item: DownloadQueueItem) => getVisualState(item) === "error").length);
  let finishedCount: number = $derived(queue.filter((item: DownloadQueueItem) => getVisualState(item) === "finished").length);
  let storageSummary: string = $derived.by(() =>
    storageInfo
      ? $_("downloads.storageSummary", { used: fmtBytes(storageInfo.manga_bytes), free: fmtBytes(storageInfo.free_bytes) })
      : "�",
  );
  let speedSummary: string = $derived(
    activeCount === 0 ? $_("downloads.summary.idle") : observedSpeedPerSecond === null ? $_("downloads.summary.measuring") : `${formatObservedSpeed(observedSpeedPerSecond)}/s`,
  );
  let summaryStatus: string = $derived(
    queueSize === 0
      ? $_("downloads.summary.noneQueued")
      : $_("downloads.summary.counts", { values: { active: activeCount, paused: pausedCount } }),
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

<div class="root n-page-shell epigraph-port--downloads" out:leaveView|global>
  <AppTopbar className="downloads-topbar">
    {#snippet center()}
      <div class="n-search" data-component="search-bar">
        <span class="n-search__icon material-symbols-outlined" aria-hidden="true">search</span>
        <input
          class="n-search__input"
          type="text"
          role="combobox"
          aria-expanded={store.searchOpen}
          aria-controls="epigraph-search-results"
          aria-activedescendant={store.searchOpen ? store.searchActiveResultId ?? undefined : undefined}
          aria-autocomplete="list"
          placeholder={$_("downloads.searchPlaceholder")}
          value={searchQuery}
          onfocus={engageSearch}
          onclick={engageSearch}
          onblur={disengageSearch}
          oninput={(event) => {
            searchQuery = (event.currentTarget as HTMLInputElement).value;
            setSearchQuery(searchQuery);
            if (searchQuery.trim()) openSearchPalette("downloads", searchQuery);
          }}
        />
      </div>
    {/snippet}
    {#snippet right()}
      <div class="downloads-topbar-menu">
        <button
          class="n-icon-btn"
          class:is-active={filterPanelOpen || downloadFilter !== "all"}
          type="button"
          title={$_("downloads.filter.title")}
          aria-label={$_("downloads.filter.title")}
          aria-expanded={filterPanelOpen}
          onclick={toggleFilterPanel}
        >
          <span class="material-symbols-outlined" aria-hidden="true">filter_list</span>
        </button>
        {#if filterPanelOpen}
          <div class="downloads-menu-panel downloads-filter-panel n-popover-surface n-popover-menu" role="menu">
            <p class="n-popover-label">{$_("downloads.filter.show")}</p>
            {#each [
              { id: "all", label: $_("downloads.filter.all"), count: queueSize + store.novelDownloads.length },
              { id: "downloading", label: $_("downloads.filter.active"), count: activeCount + store.novelDownloads.length },
              { id: "queued", label: $_("downloads.filter.queued"), count: queuedCount },
              { id: "paused", label: $_("downloads.filter.paused"), count: pausedCount },
              { id: "error", label: $_("downloads.filter.failed"), count: failedCount },
              { id: "finished", label: $_("downloads.filter.finished"), count: finishedCount },
            ] as option}
              <button
                type="button"
                class="n-popover-item"
                class:is-selected={downloadFilter === option.id}
                role="menuitemradio"
                aria-checked={downloadFilter === option.id}
                onclick={() => selectDownloadFilter(option.id as DownloadFilter)}
              >
                <span>{option.label}</span>
                <small>{option.count}</small>
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <div class="downloads-topbar-menu">
        <button
          class="n-icon-btn"
          class:is-active={morePanelOpen}
          type="button"
          title={$_("downloads.more.title")}
          aria-label={$_("downloads.more.title")}
          aria-expanded={morePanelOpen}
          onclick={toggleMorePanel}
        >
          <span class="material-symbols-outlined" aria-hidden="true">more_vert</span>
        </button>
        {#if morePanelOpen}
          <div class="downloads-menu-panel downloads-more-panel n-popover-surface n-popover-menu" role="menu">
            <p class="n-popover-label">{$_("downloads.more.queueActions")}</p>
            <button
              type="button"
              class="n-popover-item"
              role="menuitem"
              disabled={finishedCount === 0 || clearingFinished}
              onclick={clearFinished}
            >
              <span>{clearingFinished ? $_("downloads.actions.clearing") : $_("downloads.actions.clearFinished")}</span>
              <small>{finishedCount}</small>
            </button>
            <button
              type="button"
              class="n-popover-item"
              role="menuitem"
              disabled={failedCount === 0 || retryingFailed}
              onclick={retryFailed}
            >
              <span>{retryingFailed ? $_("downloads.actions.retrying") : $_("downloads.actions.retryFailed")}</span>
              <small>{failedCount}</small>
            </button>
            <button
              type="button"
              class="n-popover-item"
              role="menuitem"
              disabled={openingFolder}
              onclick={openDownloadsFolder}
            >
              <span>{openingFolder ? $_("downloads.actions.opening") : $_("downloads.actions.openFolder")}</span>
              <small class="material-symbols-outlined" aria-hidden="true">folder_open</small>
            </button>
          </div>
        {/if}
      </div>
      <ActivityButton />
      <WindowControlsInline />
    {/snippet}
  </AppTopbar>

  <div class="downloads-scroll n-content">
    <div class="downloads-page">
      <div class="downloads-page__header">
        <div>
          <p class="n-eyebrow downloads-page__eyebrow">{$_("downloads.eyebrow")}</p>
          <h1 class="n-title-xl">{$_("downloads.title")}</h1>
        </div>
        <div class="downloads-page__header-actions">
          <div class="n-soft-pill downloads-pill">
            <span class="material-symbols-outlined" aria-hidden="true">download</span>
            <span>{$_(queueSize === 1 ? "downloads.itemCount" : "downloads.itemCountPlural", { values: { count: queueSize } })}</span>
          </div>
          <button
            class="n-btn n-btn--md n-btn-ghost downloads-page__exit"
            type="button"
            onclick={leaveDownloads}
          >
            <span class="material-symbols-outlined" aria-hidden="true">home</span>
            <span>{$_("shell.navigation.home")}</span>
          </button>
        </div>
      </div>

      <section class="downloads-summary">
        <div class="downloads-summary__cluster">
          <div class="downloads-summary__metric">
            <span>{$_("downloads.summary.status")}</span>
            <strong>{summaryStatus}</strong>
          </div>
          <div class="downloads-summary__divider"></div>
          <div class="downloads-summary__metric">
            <span>{$_("downloads.summary.storage")}</span>
            <strong>{storageSummary}</strong>
          </div>
          <div class="downloads-summary__divider"></div>
          <div class="downloads-summary__metric">
            <span>{$_("downloads.summary.speed")}</span>
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
            <span>{$_("downloads.actions.pauseAll")}</span>
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
            <span>{$_("downloads.actions.resumeAll")}</span>
          </button>
        </div>
      </section>

      {#if initialLoadTimedOut && status === null}
        <div class="downloads-load-note" role="status">
          <span>{$_("downloads.load.slow")}</span>
        </div>
      {/if}

      {#if !statusHydrated && status === null}
        <div class="downloads-load-note downloads-load-note--inline" role="status">
          <span>{$_("downloads.load.loading")}</span>
        </div>
      {/if}

      <div class="downloads-list">
        {#each filteredNovelDownloads as novel (novel.novelId)}
          <div class="dl-row" data-download-novel-id={novel.novelId} tabindex="-1">
            <div class="dl-row__thumb">
              {#if novel.coverUrl}
                <img class="dl-row__image" alt="" src={novel.coverUrl} loading="lazy" decoding="async" />
              {/if}
            </div>

            <div class="dl-row__body">
              <div class="dl-row__header">
                <div>
                  <h3 class="dl-row__title">{novel.title}</h3>
                </div>
                <span class="dl-row__status dl-row__status--accent">
                  {$_("novelDetail_download_progress", { done: novel.done, total: novel.total })}
                </span>
              </div>

              <div class="dl-progress">
                <div class="dl-progress__fill" style={`width: ${novel.total > 0 ? Math.round((novel.done / novel.total) * 100) : 0}%;`}></div>
              </div>
            </div>
          </div>
        {/each}
        {#if filteredQueue.length === 0 && filteredNovelDownloads.length === 0}
          <div class="downloads-empty">
            <span>{queueSize === 0 && store.novelDownloads.length === 0 ? $_("downloads.empty.none") : $_("downloads.empty.noSearchMatch")}</span>
          </div>
        {:else}
          {#each filteredQueue as item (item.chapter.id)}
            {@const manga = item.chapter.manga}
            {@const visualState = getVisualState(item)}
            {@const percent = Math.round(item.progress * 100)}
            {@const isRemoving = dequeueing.has(item.chapter.id)}
            {@const isActionPending = isActionBusy(item)}
            <div
              class="dl-row"
              class:is-paused={visualState === "paused"}
              class:is-faded={isRemoving}
              data-download-chapter-id={item.chapter.id}
              tabindex="-1"
            >
              <div class="dl-row__thumb">
                {#if manga?.thumbnailUrl}
                  <img
                    class="dl-row__image"
                    alt={manga.title}
                    src={resolveMangaCoverUrl(manga, { context: "downloads", persistence: "persistent", cacheGeneration: store.libraryCoverCacheGeneration })}
                    loading="lazy"
                    decoding="async"
                  />
                {/if}
              </div>

              <div class="dl-row__body">
                <div class="dl-row__header">
                  <div>
                    <h3 class="dl-row__title">{manga?.title ?? $_("downloads.unknownTitle")}</h3>
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
                    style={`width: ${visualState === "queued" ? 0 : percent}%; ${visualState === "queued" ? "opacity: var(--component-downloads-progress-queued-opacity);" : ""}`}
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
                  aria-label={$_("downloads.actions.remove")}
                  title={$_("downloads.actions.remove")}
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
                  aria-label={$_("downloads.actions.moveTop")}
                  title={$_("downloads.actions.moveTop")}
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
    --component-downloads-scale-active: var(--component-downloads-scale);

    position: relative;
    display: flex;
    height: 100%;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
  }

  .downloads-scroll {
    position: relative;
    z-index: var(--component-downloads-content-z-index);
  }

  .downloads-topbar-menu {
    position: relative;
    display: inline-flex;
  }

  .downloads-menu-panel {
    position: absolute;
    top: calc(100% + var(--component-downloads-menu-offset));
    right: 0;
    z-index: var(--component-downloads-menu-z-index);
    width: min(var(--component-downloads-menu-width), calc(100vw - var(--component-downloads-menu-viewport-inset)));
    opacity: var(--component-downloads-menu-opacity);
  }

  .downloads-scroll {
    flex: 1;
    min-height: 0;
    padding: 0 var(--component-downloads-page-padding-x);
  }

  .downloads-page {
    width: 100%;
    margin: 0;
    padding: var(--component-downloads-page-padding-top) 0 0;
  }

  .downloads-page__header {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: var(--component-downloads-header-gap);
    padding: var(--component-downloads-header-padding-y) 0;
  }

  .downloads-page__header-actions {
    display: flex;
    align-items: center;
    gap: var(--component-downloads-header-actions-gap);
  }

  .downloads-page__exit {
    white-space: nowrap;
  }

  .downloads-page__eyebrow {
    margin: 0 0 var(--component-downloads-eyebrow-margin-bottom);
  }

  .downloads-pill .material-symbols-outlined {
    color: var(--component-downloads-pill-icon-fg);
    font-size: var(--component-downloads-pill-icon-size);
  }

  .downloads-pill {
    background: var(--component-downloads-pill-bg);
    border-color: var(--component-downloads-pill-border);
    color: var(--component-downloads-pill-fg);
    min-height: var(--component-downloads-pill-min-height);
    padding-inline: var(--component-downloads-pill-padding-x);
    letter-spacing: var(--component-downloads-pill-letter-spacing);
  }

  .downloads-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--component-downloads-summary-gap);
    margin: var(--component-downloads-summary-margin-y) 0;
    padding: var(--component-downloads-summary-padding);
    border: 1px solid var(--component-downloads-summary-border);
    border-radius: var(--component-downloads-summary-radius);
    background: var(--component-downloads-summary-bg);
    box-shadow: var(--component-downloads-summary-shadow);
  }

  .downloads-summary__cluster {
    display: flex;
    align-items: center;
    gap: var(--component-downloads-summary-cluster-gap);
    min-width: 0;
    flex-wrap: nowrap;
  }

  .downloads-summary__metric {
    display: flex;
    flex-direction: column;
    gap: var(--component-downloads-summary-metric-gap);
    min-width: var(--component-downloads-summary-metric-min-width);
  }

  .downloads-summary__metric span {
    color: var(--component-downloads-summary-label-fg);
    font-size: var(--component-downloads-summary-label-font-size);
    font-weight: var(--component-downloads-summary-label-font-weight);
    letter-spacing: var(--component-downloads-summary-label-letter-spacing);
    text-transform: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .downloads-summary__metric strong {
    color: var(--component-downloads-summary-value-fg);
    font-size: var(--component-downloads-summary-value-font-size);
    font-weight: var(--component-downloads-summary-value-font-weight);
    line-height: var(--component-downloads-summary-value-line-height);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .downloads-summary__accent {
    color: var(--component-downloads-accent-fg);
  }

  .downloads-summary__divider {
    width: var(--component-downloads-summary-divider-width);
    height: var(--component-downloads-summary-divider-height);
    background: var(--component-downloads-summary-divider-bg);
  }

  .downloads-summary__actions {
    display: flex;
    gap: var(--component-downloads-summary-actions-gap);
    flex-wrap: nowrap;
    flex-shrink: 0;
  }

  .downloads-summary__button {
    min-width: 0;
    min-height: var(--component-downloads-summary-button-min-height);
    justify-content: center;
    border-radius: var(--component-downloads-summary-button-radius);
    padding-inline: var(--component-downloads-summary-button-padding-x);
    font-size: var(--component-downloads-summary-button-font-size);
    font-weight: var(--component-downloads-summary-button-font-weight);
    letter-spacing: var(--component-downloads-summary-button-letter-spacing);
    text-transform: none;
  }

  .downloads-summary__button .material-symbols-outlined {
    font-size: var(--component-downloads-summary-button-icon-size);
  }

  .downloads-resume-all-btn {
    gap: var(--component-downloads-primary-button-gap);
    border: none;
    background: var(--component-downloads-primary-button-bg);
    color: var(--component-downloads-primary-button-fg);
    font-size: var(--component-downloads-summary-button-font-size);
    font-weight: var(--component-downloads-primary-button-font-weight);
    letter-spacing: var(--component-downloads-primary-button-letter-spacing);
    text-transform: none;
    box-shadow: var(--component-downloads-primary-button-shadow);
    transition:
      filter var(--component-downloads-transition-fast),
      box-shadow var(--component-downloads-transition-fast),
      transform var(--component-downloads-transition-fast);
  }

  .downloads-resume-all-btn:hover:not(:disabled):not([aria-disabled="true"]) {
    filter: var(--component-downloads-primary-button-hover-filter);
    box-shadow: var(--component-downloads-primary-button-hover-shadow);
    transform: var(--component-downloads-hover-transform);
  }

  .downloads-resume-all-btn:active:not(:disabled):not([aria-disabled="true"]) {
    transform: var(--component-downloads-primary-button-active-transform);
    box-shadow: var(--component-downloads-primary-button-active-shadow);
  }

  .downloads-resume-all-btn .material-symbols-outlined {
    font-size: var(--component-downloads-primary-button-icon-size);
    font-variation-settings: "FILL" 1, "wght" 500, "GRAD" 0, "opsz" 20;
    line-height: 1;
  }

  .downloads-summary__button.n-btn-ghost:disabled,
  .downloads-summary__button.n-btn-ghost[aria-disabled="true"] {
    opacity: var(--component-downloads-summary-button-disabled-opacity);
    cursor: default;
    filter: none;
  }

  .downloads-resume-all-btn:disabled,
  .downloads-resume-all-btn[aria-disabled="true"] {
    opacity: var(--component-downloads-primary-button-disabled-opacity);
    cursor: default;
    filter: none;
    box-shadow: var(--component-downloads-primary-button-shadow);
  }

  .downloads-list {
    display: flex;
    flex-direction: column;
    gap: var(--component-downloads-list-gap);
  }

  .downloads-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: var(--component-downloads-empty-min-height);
    color: var(--component-downloads-empty-fg);
    font-size: var(--component-downloads-empty-font-size);
    text-align: center;
  }

  .downloads-load-note--inline {
    margin-top: var(--component-downloads-load-note-inline-margin-top);
  }

  .downloads-load-note {
    margin-top: var(--component-downloads-load-note-margin-top);
    padding: var(--component-downloads-load-note-padding);
    border: 1px solid var(--component-downloads-load-note-border);
    border-radius: var(--component-downloads-load-note-radius);
    background: var(--component-downloads-load-note-bg);
    color: var(--component-downloads-load-note-fg);
    font-size: var(--component-downloads-load-note-font-size);
  }

  .dl-row {
    display: flex;
    align-items: center;
    gap: var(--component-downloads-row-gap);
    padding: var(--component-downloads-row-padding);
    background: var(--component-downloads-row-bg);
    border-radius: var(--component-downloads-row-radius);
    cursor: default;
    transition:
      background var(--component-downloads-transition-fast),
      opacity var(--component-downloads-transition-fast);
  }

  .dl-row:hover {
    background: var(--component-downloads-row-hover-bg);
  }

  .dl-row.is-paused {
    opacity: var(--component-downloads-row-paused-opacity);
  }

  .dl-row.is-faded {
    opacity: var(--component-downloads-row-faded-opacity);
  }

  .dl-row__thumb {
    width: var(--component-downloads-thumb-width);
    height: var(--component-downloads-thumb-height);
    flex-shrink: 0;
    overflow: hidden;
    border-radius: var(--component-downloads-thumb-radius);
    background: var(--component-downloads-thumb-bg);
    box-shadow: var(--component-downloads-thumb-shadow);
  }

  .dl-row.is-paused .dl-row__thumb {
    filter: var(--component-downloads-thumb-paused-filter);
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
    gap: var(--component-downloads-row-header-gap);
    margin-bottom: var(--component-downloads-row-header-margin-bottom);
  }

  .dl-row__title {
    margin: 0;
    color: var(--component-downloads-row-title-fg);
    font-size: var(--component-downloads-row-title-font-size);
    font-weight: var(--component-downloads-row-title-font-weight);
    line-height: var(--component-downloads-row-title-line-height);
  }

  .dl-row__subtitle {
    color: var(--component-downloads-row-subtitle-fg);
    font-size: var(--component-downloads-row-subtitle-font-size);
    line-height: var(--component-downloads-row-subtitle-line-height);
  }

  .dl-row__status {
    flex-shrink: 0;
    color: var(--component-downloads-row-status-fg);
    font-size: var(--component-downloads-row-status-font-size);
    font-weight: var(--component-downloads-row-status-font-weight);
    line-height: var(--component-downloads-row-status-line-height);
  }

  .dl-row__status--accent {
    color: var(--component-downloads-accent-fg);
  }

  .dl-row__status--muted {
    color: var(--component-downloads-row-status-muted-fg);
  }

  .dl-row__status--error {
    color: var(--component-downloads-danger-fg);
  }

  .dl-progress {
    height: var(--component-downloads-progress-height);
    overflow: hidden;
    border-radius: var(--component-downloads-progress-radius);
    background: var(--component-downloads-progress-track-bg);
  }

  .dl-progress__fill {
    height: 100%;
    border-radius: var(--component-downloads-progress-radius);
    background: var(--component-downloads-progress-fill-bg);
    transition: width var(--component-downloads-progress-transition);
  }

  .dl-progress__fill--paused {
    background: var(--component-downloads-progress-paused-bg);
  }

  .dl-progress__fill--error {
    background: var(--component-downloads-danger-fg);
  }

  .dl-row__actions {
    display: flex;
    align-items: center;
    gap: var(--component-downloads-row-actions-gap);
    opacity: var(--component-downloads-row-actions-hidden-opacity);
    transition:
      opacity var(--component-downloads-transition-fast),
      filter var(--component-downloads-row-actions-filter-transition);
  }

  .dl-row:hover .dl-row__actions,
  .dl-row__actions.is-visible {
    opacity: var(--component-downloads-row-actions-visible-opacity);
    filter: none;
  }

  .dl-row__icon-btn {
    width: var(--component-downloads-row-action-size);
    height: var(--component-downloads-row-action-size);
    border-color: var(--component-downloads-row-action-border);
    background: var(--component-downloads-row-action-bg);
    opacity: var(--component-downloads-row-action-opacity);
    transition:
      opacity var(--component-downloads-transition-fast),
      background var(--component-downloads-transition-fast),
      border-color var(--component-downloads-transition-fast),
      box-shadow var(--component-downloads-transition-fast),
      transform var(--component-downloads-transition-press);
  }

  .dl-row__icon-btn:hover:not(:disabled) {
    color: var(--component-downloads-row-action-hover-fg);
    background: var(--component-downloads-row-action-hover-bg);
    border-color: var(--component-downloads-row-action-hover-border);
    transform: var(--component-downloads-hover-transform);
    box-shadow: var(--component-downloads-row-action-hover-shadow);
  }

  .dl-row__icon-btn:active:not(:disabled) {
    transform: var(--component-downloads-row-action-active-transform);
  }

  .dl-row__icon-btn:disabled {
    opacity: var(--component-downloads-row-action-disabled-opacity);
  }

  .downloads-summary__button:focus-visible,
  .dl-row__icon-btn:focus-visible {
    outline: none;
    box-shadow: var(--component-downloads-focus-ring);
  }

  .dl-row__icon-btn .material-symbols-outlined {
    font-size: var(--component-downloads-row-action-icon-size);
  }

  .dl-row__icon-btn--danger .material-symbols-outlined {
    color: var(--component-downloads-danger-fg);
  }

  .downloads-bottom-spacer {
    height: var(--component-downloads-bottom-spacer-height);
  }

  @media (max-width: 520px) {
    .downloads-summary {
      flex-direction: column;
      align-items: flex-start;
    }

    .downloads-summary__actions {
      width: 100%;
    }
  }

  @media (max-width: 520px) {
    .downloads-scroll {
      padding: 0 var(--component-downloads-page-padding-x-compact);
    }

    .downloads-page__header {
      align-items: flex-start;
      flex-direction: column;
    }

    .downloads-summary__cluster {
      gap: var(--component-downloads-summary-cluster-gap-compact);
    }

    .downloads-summary__divider {
      display: none;
    }

    .dl-row {
      gap: var(--component-downloads-row-gap-compact);
    }

    .dl-row__header {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
