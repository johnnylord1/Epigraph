<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { formatDayLabel, formatRelativeTime } from "../../lib/i18n/format";
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-shell";
  import { ClockCounterClockwise, Trash, Play, X } from "phosphor-svelte";
  import { cubicOut } from "svelte/easing";
  import { slide, type TransitionConfig } from "svelte/transition";
  import { listFlip, prefersReducedMotion } from "../../lib/motion/motion";
  import { getServerUrl } from "../../lib/client";
  import { startLocalFlareSolverrAndEnable } from "../../lib/flaresolverr";
  import { finishLibraryUpdateToast, retryComicsLibrarySourceUpdate } from "../../lib/library/updateRuntime";
  import { resolveMangaCoverUrl } from "../../lib/manga/coverResolver";
  import { fetchSyncedComicHistory } from "../../lib/history/syncedComicHistory";
  import { groupReadingSessions } from "../../lib/history/sessions";
  import { groupRefreshedNovelChaptersForNotifications, refreshNovelLibraryFromSources } from "../../lib/novels/libraryRefresh";
  import {
    buildNovelDetailRecordFromLibrary,
    getNovelLibraryChapters,
    getNovelReadingHistory,
    loadNovelLibraryState,
    peekNovelLibraryState,
    saveNovelLibraryState,
    type NovelReadingHistoryItem,
  } from "../../lib/novels/libraryState";
  import type { PersistedNovelLibraryState } from "../../lib/novels/domain";
  import { toSuwayomiWebViewUrl } from "../../lib/suwayomiWebView";
  import {
    store,
    addToast,
    clearHistory,
    mergeSyncedHistory,
    clearLibraryUpdateNotifications,
    closeActivityPanel,
    clearSystemNotifications,
    dismissLibraryUpdateIssues,
    dismissLibraryUpdateNotification,
    dismissSystemNotification,
    openMangaDetail,
    recordLibraryUpdateIssues,
    recordNovelUpdateNotifications,
    setActiveNovelDetail,
    setLibraryUpdateInFlight,
    setSettingsOpen,
  } from "../../store/state.svelte";
  import type { Manga } from "../../lib/types";
  import type { HistoryEntry, LibraryUpdateIssue, LibraryUpdateNotification, SystemNotification } from "../../store/state.svelte";

  type ActivityTab = "all" | "updates" | "history" | "system";
  const TAB_ORDER: ActivityTab[] = ["all", "updates", "history", "system"];

  let confirmClear = $state(false);
  let activeTab: ActivityTab = $state("all");
  let tabDirection = $state(1);
  let body: HTMLElement | undefined = $state();
  let filtersEl: HTMLElement | undefined = $state();
  const indicator = $state({ x: 0, width: 0, ready: false });
  let indicatorReadyScheduled = false;

  function selectTab(tab: ActivityTab) {
    if (tab === activeTab) return;
    tabDirection = TAB_ORDER.indexOf(tab) > TAB_ORDER.indexOf(activeTab) ? 1 : -1;
    activeTab = tab;
    confirmClear = false;
    body?.scrollTo({ top: 0 });
  }

  // The active tab's pill glides between tabs instead of jumping.
  $effect(() => {
    const filters = filtersEl;
    const tab = activeTab;
    if (!filters) return;
    const measure = () => {
      const button = filters.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
      if (!button) return;
      indicator.x = button.offsetLeft;
      indicator.width = button.offsetWidth;
      // The first placement lands without a glide; later ones animate.
      if (!indicatorReadyScheduled) {
        indicatorReadyScheduled = true;
        requestAnimationFrame(() => { indicator.ready = true; });
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const button of filters.querySelectorAll("[data-tab]")) observer.observe(button);
    return () => observer.disconnect();
  });

  function panelIn(_node: Element, { direction }: { direction: number }): TransitionConfig {
    if (prefersReducedMotion()) return { duration: 0 };
    return { duration: 320, easing: cubicOut, css: (t, u) => `opacity:${t};transform:translateX(${u * direction * 18}px)` };
  }

  function rowOut(node: Element): TransitionConfig {
    return prefersReducedMotion() ? { duration: 0 } : slide(node, { duration: 220, easing: cubicOut });
  }

  function timeAgo(ts: number): string {
    return formatRelativeTime(ts);
  }

  function dayLabel(ts: number): string {
    return formatDayLabel(ts);
  }

  function issueAffectedCount(issue: LibraryUpdateIssue) {
    if (Number.isFinite(Number(issue.affectedCount))) {
      return Math.max(1, Math.floor(Number(issue.affectedCount)));
    }
    const match = issue.message.match(/\b(\d+)\s+titles?\b/i);
    if (match) return Math.max(1, Number(match[1]));
    return 1;
  }

  interface Session {
    key:               string;
    kind:              "comic" | "novel";
    novelId:           string | null;
    mangaId:           number;
    mangaTitle:        string;
    thumbnailUrl:      string;
    latestChapterId:   number;
    latestChapterName: string;
    firstChapterName:  string;
    chapterCount:      number;
    readAt:            number;
  }

  interface UpdateEntry {
    id: string;
    notification: LibraryUpdateNotification;
    manga: Manga | null;
    isNovel: boolean;
    title: string;
    subtitle: string;
    count: number;
    source: string;
    readAt: number;
  }

  interface IssueGroup {
    id: string;
    sourceName: string;
    extensionName: string;
    count: number;
    latestAt: number;
    items: LibraryUpdateIssue[];
    /** Every issue in the card, for dismissing it; `items` is the newest few shown. */
    all?: LibraryUpdateIssue[];
  }

  type SystemEntry = SystemNotification;

  function buildSessions(entries: HistoryEntry[]): Session[] {
    return groupReadingSessions(entries, (entry) => entry.mangaId, (entry) => entry.readAt).map((group) => {
      const latest = group[0], oldest = group[group.length - 1];
      return {
        key:               `comic:${latest.chapterId}`,
        kind:              "comic",
        novelId:           null,
        mangaId:           latest.mangaId,
        mangaTitle:        latest.mangaTitle,
        thumbnailUrl:      latest.thumbnailUrl,
        latestChapterId:   latest.chapterId,
        latestChapterName: latest.chapterName,
        firstChapterName:  oldest.chapterName,
        chapterCount:      group.length,
        readAt:            latest.readAt,
      };
    });
  }

  function buildNovelSessions(items: NovelReadingHistoryItem[]): Session[] {
    return groupReadingSessions(items, (item) => item.novel.id, (item) => item.entry.readAt).map((group) => {
      const anchor = group[0], oldest = group[group.length - 1];
      return {
        key:               `novel:${anchor.novel.id}:${anchor.entry.chapterId ?? anchor.entry.readAt}`,
        kind:              "novel",
        novelId:           anchor.novel.id,
        mangaId:           0,
        mangaTitle:        anchor.novel.title,
        thumbnailUrl:      anchor.novel.coverUrl ?? "",
        latestChapterId:   0,
        latestChapterName: anchor.entry.chapterTitle ?? "",
        firstChapterName:  oldest.entry.chapterTitle ?? "",
        chapterCount:      group.length,
        readAt:            anchor.entry.readAt,
      };
    });
  }

  let novelLibraryState: PersistedNovelLibraryState | null = $state(null);
  $effect(() => {
    const scope = { profileId: store.runtimeResolvedLocalProfileId, serverUrl: store.runtimeServerUrl };
    store.contentSetupVersion;
    store.activeNovelReader;
    void loadNovelLibraryState(scope).then((state) => { novelLibraryState = state; });
  });

  // Comic reads from paired devices reach Suwayomi through Epigraph Core, not this store.
  $effect(() => {
    if (!store.runtimeServerUrl) return;
    store.contentSetupVersion;
    void fetchSyncedComicHistory().then(mergeSyncedHistory).catch(() => {});
  });

  const sessions = $derived(
    [
      ...buildSessions(store.history),
      ...buildNovelSessions(novelLibraryState ? getNovelReadingHistory(novelLibraryState) : []),
    ].sort((left, right) => right.readAt - left.readAt),
  );
  const updateNotifications = $derived((store.libraryUpdateNotifications ?? []).filter((entry) => store.matchesRuntimeProfile(entry)));
  const updateIssues = $derived((store.libraryUpdateIssues ?? []).filter((entry) => store.matchesRuntimeProfile(entry)));
  const systemNotifications = $derived((store.systemNotifications ?? []).filter((entry) => store.matchesRuntimeProfile(entry)));

  const updateEntries = $derived.by(() => {
    const mangaById = new Map(store.libraryMangaSnapshot.map((manga) => [manga.id, manga]));
    return updateNotifications
      .map((notification): UpdateEntry => {
        const manga = typeof notification.mangaId === "number" ? mangaById.get(notification.mangaId) ?? null : null;
        const count = Math.max(1, Number(notification.chapterDelta ?? 1));
        const firstTitle = notification.chapterTitles?.[0];
        const subtitle = firstTitle
          ? count > 1
            ? translate("activity.updateTitleMore", { title: firstTitle, more: count - 1 })
            : translate("activity.updateTitle", { title: firstTitle })
          : translate("activity.updateCount", { count });
        return {
          id: notification.id,
          notification,
          manga,
          isNovel: notification.kind === "novels",
          title: notification.mangaTitle || manga?.title || translate("downloads_unknownTitle"),
          subtitle,
          count,
          source: notification.sourceName || manga?.source?.displayName || manga?.source?.name || translate("shell.navigation.library"),
          readAt: notification.createdAt,
        };
      })
      .sort((left, right) => right.readAt - left.readAt || right.count - left.count || left.title.localeCompare(right.title))
      .slice(0, 80);
  });

  const issueGroups = $derived.by(() => {
    const groups = new Map<string, IssueGroup>();
    for (const issue of updateIssues) {
      // One card per source, whichever run reported each title.
      const key = `${issue.contentKind}:${issue.sourceId}:${issue.extensionName}`;
      const current = groups.get(key) ?? {
        id: key,
        sourceName: issue.sourceName || translate("libraryUpdate.unknownSource"),
        extensionName: issue.extensionName || issue.sourceName || translate("activity.unknownExtension"),
        count: 0,
        latestAt: 0,
        items: [] as LibraryUpdateIssue[],
      };
      current.count += issueAffectedCount(issue);
      current.latestAt = Math.max(current.latestAt, issue.createdAt);
      current.items.push(issue);
      groups.set(key, current);
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        all: group.items,
        items: [...group.items]
          .sort((left, right) => right.createdAt - left.createdAt || left.title.localeCompare(right.title))
          .slice(0, 5),
      }))
      .sort((left, right) => right.latestAt - left.latestAt || right.count - left.count)
      .slice(0, 40);
  });

  const systemEntries = $derived.by(() => {
    return [...systemNotifications]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 80);
  });

  const totalVisibleCount = $derived(updateEntries.length + issueGroups.length + sessions.length + systemEntries.length);

  function byDay<T>(items: T[], at: (item: T) => number) {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const label = dayLabel(at(item));
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(item);
    }
    return Array.from(map.entries()).map(([label, entries]) => ({ label, items: entries }));
  }

  const groups = $derived(byDay(sessions, (session) => session.readAt));
  const updateDays = $derived(byDay(updateEntries, (entry) => entry.readAt));

  function issueSummary(group: IssueGroup) {
    return group.count === 1
      ? translate("activity.issueGroupOne", { source: group.sourceName })
      : translate("activity.issueGroupMany", { count: group.count, source: group.sourceName });
  }

  function resume(session: Session) {
    if (session.kind === "novel" && session.novelId) {
      openNovel(session.novelId);
      return;
    }
    openMangaDetail({
      id:           session.mangaId,
      title:        session.mangaTitle,
      thumbnailUrl: session.thumbnailUrl,
      inLibrary:    false,
    } as any);
  }

  function openNovel(novelId: string) {
    const state = peekNovelLibraryState({
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    });
    const novel = state.entries.find((candidate) => candidate.id === novelId);
    if (novel) {
      // Like openMangaDetail, leave the activity panel so the detail is visible.
      closeActivityPanel();
      setActiveNovelDetail({
        novel: buildNovelDetailRecordFromLibrary(novel, getNovelLibraryChapters(state, novel.id)),
        inLibrary: true,
      });
    }
  }

  function openUpdate(entry: UpdateEntry) {
    if (entry.isNovel && entry.notification.novelId) {
      openNovel(entry.notification.novelId);
      return;
    }
    const manga = entry.manga ?? {
      id: entry.notification.mangaId ?? 0,
      title: entry.title,
      thumbnailUrl: entry.notification.thumbnailUrl,
      inLibrary: true,
    };
    openMangaDetail({
      ...manga,
      inLibrary: true,
    } as Manga);
  }

  function primaryIssue(group: IssueGroup): LibraryUpdateIssue | null {
    return group.items.find((issue) => issue.errorType === "source-challenge") ?? group.items[0] ?? null;
  }

  function isSourceChallengeGroup(group: IssueGroup): boolean {
    return group.items.some((issue) => issue.errorType === "source-challenge");
  }

  async function startFlareSolverr(event: MouseEvent) {
    event.stopPropagation();
    try {
      await startLocalFlareSolverrAndEnable();
      addToast({
        kind: "success",
        title: translate("ui_flaresolverrEnabled"),
        body: translate("ui_retryTheAffectedSourceWhenYouAreReady"),
      });
    } catch (error) {
      addToast({
        kind: "error",
        title: translate("ui_flaresolverrUnavailable"),
        body: error instanceof Error ? error.message : translate("ui_openSettingsToConfigureALocalDockerOr"),
        action: { label: translate("ui_openSettings"), run: () => setSettingsOpen(true) },
      });
    }
  }

  async function openIssueWebView(group: IssueGroup, event: MouseEvent) {
    event.stopPropagation();
    const issue = primaryIssue(group);
    if (!issue?.actionUrl) return;
    try {
      if (issue.contentKind === "manga") {
        await invoke("open_reader_webview", {
          url: toSuwayomiWebViewUrl(getServerUrl(), issue.actionUrl),
          title: translate("activity.challengeWindowTitle", { source: issue.sourceName }),
        });
        return;
      }
      await open(issue.actionUrl);
    } catch (error) {
      addToast({
        kind: "error",
        title: translate("ui_couldNotOpenChallenge"),
        body: error instanceof Error ? error.message : translate("ui_epigraphCouldNotOpenTheSourceChallengePage"),
      });
    }
  }

  async function retryIssueSource(group: IssueGroup, event: MouseEvent) {
    event.stopPropagation();
    const issue = primaryIssue(group);
    const sourceId = issue?.retrySourceId || issue?.sourceId;
    if (!issue || !sourceId) return;
    if (store.libraryUpdateInFlight) {
      addToast({
        kind: "info",
        title: translate("ui_libraryUpdateAlreadyRunning"),
        body: translate("ui_waitForTheActiveUpdateBeforeRetryingThis"),
        duration: 2400,
      });
      return;
    }
    setLibraryUpdateInFlight(true);
    try {
      if (issue.retryKind === "novels-source" || issue.contentKind === "novel") {
        const updatedAt = Date.now();
        const result = await refreshNovelLibraryFromSources({
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        }, {
          sourceIds: [sourceId],
          concurrency: 1,
          downloadNewChapters: store.settings.downloadNewNovelChapters,
          onlyOngoing: store.settings.onlyUpdateOngoingNovels,
          pauseMs: 800,
        });
        recordNovelUpdateNotifications(groupRefreshedNovelChaptersForNotifications(result.newChapterEntries), updatedAt);
        recordLibraryUpdateIssues(result.failures.map((failure) => ({
          runId: `books-source-retry:${updatedAt}:${sourceId}`,
          contentKind: "novel" as const,
          title: failure.title,
          itemId: failure.novelId,
          sourceId: failure.sourceId,
          sourceName: failure.sourceName,
          extensionName: failure.sourceName,
          message: failure.error,
          errorType: failure.errorType ?? "source-error" as const,
          actionUrl: failure.actionUrl,
          retrySourceId: failure.retrySourceId,
          retryKind: failure.retryKind,
          recoveryHint: failure.recoveryHint,
        })), updatedAt);
        addToast({
          kind: result.failed > 0 ? "info" : "success",
          title: result.failed > 0 ? translate("ui_sourceRetryFinishedWithIssues") : translate("ui_sourceRetryFinished"),
          body: translate("activity.novelRetryBody", {
            updated: result.updated,
            checked: result.checked,
            newChapters: result.newChapters > 0 ? translate("libraryUpdate.booksNewChaptersPart", { count: result.newChapters }) : "",
          }),
        });
        return;
      }

      // The retry runs the shared update queue, so its result ends the library update's toast.
      const result = await retryComicsLibrarySourceUpdate(sourceId);
      recordLibraryUpdateIssues(result.issues, result.updatedAt);
      if (result.cancelled) {
        finishLibraryUpdateToast({ kind: "info", body: translate("libraryUpdate.stoppedPlain") });
        return;
      }
      finishLibraryUpdateToast({
        kind: result.issues.length > 0 ? "info" : "success",
        title: result.issues.length > 0 ? translate("ui_sourceRetryFinishedWithIssues") : translate("ui_sourceRetryFinished"),
        body: translate("activity.comicsRetryBody", { count: result.changedMangaIds.length, source: issue.sourceName }),
      });
    } catch (error) {
      finishLibraryUpdateToast({
        kind: "error",
        title: translate("ui_couldNotRetrySource"),
        body: error instanceof Error ? error.message : translate("ui_epigraphCouldNotRetryThisSource"),
      });
    } finally {
      setLibraryUpdateInFlight(false);
    }
  }

  // Novel reads live in the novel library state, not in the comics history, so clear both.
  async function clearReadingHistory() {
    clearHistory();
    const scope = { profileId: store.runtimeResolvedLocalProfileId, serverUrl: store.runtimeServerUrl };
    const state = await loadNovelLibraryState(scope);
    if (state.history.length === 0) return;
    novelLibraryState = await saveNovelLibraryState({ ...state, history: [] }, scope);
  }

  function handleClear() {
    if (!confirmClear) { confirmClear = true; setTimeout(() => confirmClear = false, 3000); return; }
    if (activeTab === "all") {
      clearLibraryUpdateNotifications();
      void clearReadingHistory();
      clearSystemNotifications();
    } else if (activeTab === "updates") {
      clearLibraryUpdateNotifications();
    } else if (activeTab === "system") {
      clearSystemNotifications();
    } else {
      void clearReadingHistory();
    }
    confirmClear = false;
  }
</script>

<div class="activity-root">
  <header class="activity-head">
    <div class="title-stack">
      <span class="eyebrow">{$_("ui_notifications")}</span>
      <h2>{$_("ui_recentActivity")}</h2>
      <p>{$_("activity.retentionHint")}</p>
    </div>

    <div class="head-actions">
      <div class="filters" role="tablist" aria-label={$_("ui_notificationFilters")} bind:this={filtersEl}>
        <span class="filter-indicator" class:ready={indicator.ready} aria-hidden="true"
          style:width="{indicator.width}px" style:transform="translateX({indicator.x}px)"></span>
        <button class="filter" class:active={activeTab === "all"} data-tab="all" type="button" role="tab" aria-selected={activeTab === "all"} onclick={() => selectTab("all")}>
          {$_("downloads_filter_all")} <span class="filter-count">{totalVisibleCount}</span>
        </button>
        <button class="filter" class:active={activeTab === "updates"} data-tab="updates" type="button" role="tab" aria-selected={activeTab === "updates"} onclick={() => selectTab("updates")}>
          {$_("sources_filters_updates")} <span class="filter-count">{updateEntries.length + issueGroups.length}</span>
        </button>
        <button class="filter" class:active={activeTab === "history"} data-tab="history" type="button" role="tab" aria-selected={activeTab === "history"} onclick={() => selectTab("history")}>
          {$_("ui_history")} <span class="filter-count">{sessions.length}</span>
        </button>
        <button class="filter" class:active={activeTab === "system"} data-tab="system" type="button" role="tab" aria-selected={activeTab === "system"} onclick={() => selectTab("system")}>
          {$_("ui_system")} <span class="filter-count">{systemEntries.length}</span>
        </button>
      </div>

      {#if (activeTab === "all" && totalVisibleCount > 0) || (activeTab === "updates" && (updateEntries.length > 0 || issueGroups.length > 0)) || (activeTab === "history" && sessions.length > 0) || (activeTab === "system" && systemEntries.length > 0)}
        <button class="clear-btn" class:confirm={confirmClear} onclick={handleClear}
          title={confirmClear ? $_("activity.clearConfirmHint") : activeTab === "all" ? $_("activity.clearAll") : activeTab === "updates" ? $_("activity.clearUpdates") : activeTab === "system" ? $_("activity.clearSystem") : $_("activity.clearHistory")}>
          <Trash size={14} weight="light" />
          <span>{confirmClear ? $_("activity.confirm") : $_("activity.clear")}</span>
        </button>
      {/if}
    </div>
  </header>

  <main class="activity-body" bind:this={body}>
    {#key activeTab}
      <div class="activity-panel" in:panelIn={{ direction: tabDirection }}>
        {#if activeTab === "all" || activeTab === "updates"}
          <section class="activity-section">
            <div class="section-title">
              <span>{$_("sources_filters_updates")}</span>
              <small>{updateEntries.length + issueGroups.length}</small>
            </div>

            {#if updateEntries.length === 0 && issueGroups.length === 0}
              <p class="compact-empty">{$_("ui_noNewChapterUpdates")}</p>
            {:else}
              {#if issueGroups.length > 0}
                <div class="issue-list">
                  {#each issueGroups as group (group.id)}
                    <article class="issue-group event" animate:listFlip out:rowOut>
                      <div class="issue-marker"></div>
                      <div class="item-copy">
                        <span class="item-title">{group.extensionName}</span>
                        <span class="item-subtitle">{issueSummary(group)}</span>
                        <span class="issue-titles">
                          {group.items.map((issue) => `${issue.title}: ${issue.message}`).join(" | ")}
                        </span>
                        {#if isSourceChallengeGroup(group)}
                          <div class="issue-actions">
                            <button class="issue-action" type="button" onclick={startFlareSolverr}>{$_("ui_startFlaresolverr")}</button>
                            {#if primaryIssue(group)?.actionUrl}
                              <button class="issue-action" type="button" onclick={(event) => openIssueWebView(group, event)}>
                                {primaryIssue(group)?.contentKind === "manga" ? $_("ui_openWebview") : $_("ui_openSource")}
                              </button>
                            {/if}
                            <button class="issue-action" type="button" onclick={(event) => retryIssueSource(group, event)}>{$_("ui_retrySource")}</button>
                          </div>
                        {/if}
                      </div>
                      <div class="item-end">
                        <span class="item-time">{timeAgo(group.latestAt)}</span>
                        <button class="dismiss-btn" type="button" aria-label={$_("activity.dismiss")} title={$_("activity.dismiss")}
                          onclick={() => dismissLibraryUpdateIssues(group.all ?? group.items)}>
                          <X size={12} weight="bold" />
                        </button>
                      </div>
                    </article>
                  {/each}
                </div>
              {/if}
              {#each updateDays as day (day.label)}
                <div class="day-title day-title--sub"><span>{day.label}</span></div>
                <div class="event-list">
                  {#each day.items as entry (entry.id)}
                    <div class="activity-row" animate:listFlip out:rowOut>
                      <button class="activity-item with-thumb event" onclick={() => openUpdate(entry)}>
                        <div class="thumb-wrap">
                          <img src={resolveMangaCoverUrl(entry.manga ?? entry.notification.thumbnailUrl, { context: "activity", persistence: "persistent", cacheGeneration: store.libraryCoverCacheGeneration })} alt={entry.title} class="thumb" />
                          <span class="item-count">{entry.count}</span>
                        </div>
                        <div class="item-copy">
                          <span class="item-title">{entry.title}</span>
                          <span class="item-subtitle">{entry.subtitle} - {entry.source}</span>
                        </div>
                        <span class="item-time">{timeAgo(entry.readAt)}</span>
                        <span class="action-pill">{$_("ui_open")}</span>
                      </button>
                      <button class="dismiss-btn" type="button" aria-label={$_("activity.dismiss")} title={$_("activity.dismiss")}
                        onclick={() => dismissLibraryUpdateNotification(entry.notification)}>
                        <X size={12} weight="bold" />
                      </button>
                    </div>
                  {/each}
                </div>
              {/each}
            {/if}
          </section>
        {/if}

        {#if activeTab === "all"}
          <section class="activity-section">
            <div class="section-title">
              <span>{$_("ui_history")}</span>
              <small>{sessions.length}</small>
            </div>

            {#if sessions.length === 0}
              <p class="compact-empty">{$_("ui_noReadingHistoryYet")}</p>
            {:else}
              <div class="event-list">
                {#each sessions.slice(0, 8) as session (session.key)}
                  <button class="activity-item with-thumb event" onclick={() => resume(session)}>
                    <div class="thumb-wrap">
                      {#if session.thumbnailUrl}
                        <img src={resolveMangaCoverUrl(session.thumbnailUrl, { context: "activity", persistence: "persistent", cacheGeneration: store.libraryCoverCacheGeneration })} alt={session.mangaTitle} class="thumb" />
                      {:else}
                        <span class="thumb" aria-hidden="true"></span>
                      {/if}
                      {#if session.chapterCount > 1}
                        <span class="item-count">{session.chapterCount}</span>
                      {/if}
                    </div>
                    <div class="item-copy">
                      <span class="item-title">{session.mangaTitle}</span>
                      <span class="item-subtitle">{session.latestChapterName}</span>
                    </div>
                    <span class="item-time">{timeAgo(session.readAt)}</span>
                    <span class="action-pill"><Play size={10} weight="fill" /> {$_("home_continue_resume")}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </section>
        {:else if activeTab === "history"}
          {#if sessions.length === 0}
            <section class="activity-section">
              <div class="section-title">
                <span>{$_("ui_history")}</span>
                <small>0</small>
              </div>
              <div class="full-empty">
                <ClockCounterClockwise size={28} weight="light" />
                <p>{$_("ui_noReadingHistoryYet")}</p>
                <span>{$_("ui_chaptersYouReadWillAppearHere")}</span>
              </div>
            </section>
          {:else}
            {#each groups as { label, items }}
              <section class="activity-section">
                <div class="day-title">
                  <span>{label}</span>
                </div>
                <div class="event-list">
                  {#each items as session (session.key)}
                    <button class="activity-item with-thumb event" onclick={() => resume(session)}>
                      <div class="thumb-wrap">
                        {#if session.thumbnailUrl}
                          <img src={resolveMangaCoverUrl(session.thumbnailUrl, { context: "activity", persistence: "persistent", cacheGeneration: store.libraryCoverCacheGeneration })} alt={session.mangaTitle} class="thumb" />
                        {:else}
                          <span class="thumb" aria-hidden="true"></span>
                        {/if}
                        {#if session.chapterCount > 1}
                          <span class="item-count">{session.chapterCount}</span>
                        {/if}
                      </div>
                      <div class="item-copy">
                        <span class="item-title">{session.mangaTitle}</span>
                        <span class="item-subtitle">
                          {#if session.chapterCount > 1}
                            {session.firstChapterName}
                            <span class="chapter-arrow">-&gt;</span>
                            {session.latestChapterName}
                          {:else}
                            {session.latestChapterName}
                          {/if}
                        </span>
                      </div>
                      <span class="item-time">{timeAgo(session.readAt)}</span>
                      <span class="action-pill"><Play size={10} weight="fill" /> {$_("home_continue_resume")}</span>
                    </button>
                  {/each}
                </div>
              </section>
            {/each}
          {/if}
        {/if}

        {#if activeTab === "all" || activeTab === "system"}
          <section class="activity-section">
            <div class="section-title">
              <span>{$_("ui_system")}</span>
              <small>{systemEntries.length}</small>
            </div>

            {#if systemEntries.length === 0}
              <p class="compact-empty">{$_("ui_noSystemEvents")}</p>
            {:else}
              <div class="timeline">
                {#each systemEntries as entry (entry.id)}
                  <article class="system-item event" data-kind={entry.kind} animate:listFlip out:rowOut>
                    <span class="dot"></span>
                    <div class="item-copy">
                      <span class="item-title">{entry.title}</span>
                      {#if entry.body}<span class="item-subtitle">{entry.body}</span>{/if}
                    </div>
                    <div class="item-end">
                      <span class="item-time">{timeAgo(entry.createdAt)}</span>
                      <button class="dismiss-btn" type="button" aria-label={$_("activity.dismiss")} title={$_("activity.dismiss")}
                        onclick={() => dismissSystemNotification(entry)}>
                        <X size={12} weight="bold" />
                      </button>
                    </div>
                  </article>
                {/each}
              </div>
            {/if}
          </section>
        {/if}
      </div>
    {/key}
  </main>
</div>

<style>
  .activity-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    border: 1px solid var(--component-activity-center-border);
    border-radius: var(--component-activity-center-radius);
    background: var(--component-activity-center-bg);
    box-shadow: var(--component-activity-center-shadow);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }

  .activity-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: calc(20px * var(--component-activity-scale));
    padding: calc(28px * var(--component-activity-scale)) calc(28px * var(--component-activity-scale)) calc(22px * var(--component-activity-scale));
    border-bottom: 1px solid var(--component-activity-center-divider);
    flex-shrink: 0;
  }

  .title-stack {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .eyebrow {
    margin: 0 0 calc(10px * var(--component-activity-scale));
    color: var(--component-activity-center-accent);
    font-size: calc(12px * var(--component-activity-scale));
    font-weight: 850;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    color: var(--component-activity-center-text);
    font-size: clamp(calc(28px * var(--component-activity-scale)), 3vw, calc(38px * var(--component-activity-scale)));
    font-weight: 820;
    letter-spacing: -0.01em;
    line-height: 1;
  }

  p {
    margin: 0;
  }

  .title-stack p {
    max-width: calc(520px * var(--component-activity-scale));
    margin: calc(10px * var(--component-activity-scale)) 0 0;
    color: var(--component-activity-center-muted);
    font-size: calc(14px * var(--component-activity-scale));
    line-height: 1.55;
  }

  .head-actions {
    display: flex;
    align-items: center;
    gap: calc(10px * var(--component-activity-scale));
  }

  .clear-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: calc(7px * var(--component-activity-scale));
    min-width: calc(36px * var(--component-activity-scale));
    height: calc(34px * var(--component-activity-scale));
    padding: 0 calc(11px * var(--component-activity-scale));
    border: 1px solid var(--component-activity-center-border);
    border-radius: var(--radius-md);
    background: var(--component-activity-center-clear-bg);
    color: var(--component-activity-center-muted);
    cursor: pointer;
    font-size: calc(11.5px * var(--component-activity-scale));
    font-weight: 780;
    letter-spacing: 0;
    text-transform: none;
    transition: color var(--t-fast), background var(--t-fast), border-color var(--t-fast);
  }

  .clear-btn:hover,
  .clear-btn.confirm {
    color: var(--component-activity-center-clear-danger-fg);
    border-color: var(--component-activity-center-clear-danger-border);
    background: var(--component-activity-center-clear-danger-bg);
  }

  .filters {
    position: relative;
    display: flex;
    align-items: center;
    gap: calc(4px * var(--component-activity-scale));
    padding: calc(4px * var(--component-activity-scale));
    border: 0;
    border-radius: var(--radius-full);
    background: var(--component-activity-center-filters-bg);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .filters::-webkit-scrollbar {
    display: none;
  }

  /* The active tab's pill: one element that glides between tabs. Tabs come later in the DOM, so they paint above it. */
  .filter-indicator {
    position: absolute;
    top: calc(4px * var(--component-activity-scale));
    bottom: calc(4px * var(--component-activity-scale));
    left: 0;
    border-radius: var(--radius-full);
    background: var(--component-activity-center-accent-soft);
    box-shadow: var(--component-activity-center-filter-active-shadow);
    pointer-events: none;
  }

  .filter-indicator.ready {
    transition: transform 420ms cubic-bezier(.16, 1, .3, 1), width 420ms cubic-bezier(.16, 1, .3, 1);
  }

  .filter {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: calc(8px * var(--component-activity-scale));
    height: calc(34px * var(--component-activity-scale));
    padding: 0 calc(14px * var(--component-activity-scale));
    border: 0;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--component-activity-center-filter-fg);
    cursor: pointer;
    font-size: calc(12px * var(--component-activity-scale));
    font-weight: 850;
    letter-spacing: 0;
    text-transform: none;
    white-space: nowrap;
    transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
  }

  .filter:hover {
    color: var(--component-activity-center-filter-hover-fg);
    background: var(--component-activity-center-filter-hover-bg);
  }

  .filter.active,
  .filter.active:hover {
    background: transparent;
    color: var(--component-activity-center-text);
  }

  .filter-count {
    display: inline-grid;
    place-items: center;
    min-width: calc(18px * var(--component-activity-scale));
    height: calc(18px * var(--component-activity-scale));
    padding: 0 calc(6px * var(--component-activity-scale));
    border-radius: var(--radius-full);
    background: var(--component-activity-center-filter-count-bg);
    color: inherit;
    font-size: calc(10px * var(--component-activity-scale));
    line-height: 1;
  }

  .activity-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: calc(22px * var(--component-activity-scale)) calc(28px * var(--component-activity-scale)) calc(30px * var(--component-activity-scale));
  }

  .activity-section {
    margin: 0;
    padding: calc(20px * var(--component-activity-scale)) 0;
    border-top: 1px solid var(--component-activity-center-divider);
  }

  .activity-section:first-child {
    border-top: 0;
    padding-top: calc(4px * var(--component-activity-scale));
  }

  .section-title,
  .day-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    margin-bottom: calc(12px * var(--component-activity-scale));
    color: var(--component-activity-center-text);
    font-size: calc(13px * var(--component-activity-scale));
    font-weight: 850;
    letter-spacing: 0;
    text-transform: none;
  }

  .section-title small {
    min-width: calc(24px * var(--component-activity-scale));
    padding: 0;
    border: 0;
    border-radius: var(--component-activity-center-flat-radius);
    background: transparent;
    color: var(--component-activity-center-faint);
    font-size: calc(12px * var(--component-activity-scale));
    text-align: right;
  }

  .compact-empty {
    min-height: 0;
    color: var(--component-activity-center-faint);
    font-size: calc(14px * var(--component-activity-scale));
  }

  .full-empty {
    display: grid;
    place-items: center;
    gap: calc(8px * var(--component-activity-scale));
    min-height: calc(140px * var(--component-activity-scale));
    color: var(--component-activity-center-faint);
    text-align: center;
  }

  .full-empty :global(svg) {
    color: var(--component-activity-center-accent-border);
  }

  .full-empty p {
    color: var(--component-activity-center-text);
    font-size: calc(14px * var(--component-activity-scale));
    font-weight: 760;
  }

  .full-empty span {
    color: var(--component-activity-center-faint);
    font-size: calc(12px * var(--component-activity-scale));
  }

  .day-title--sub {
    margin: calc(10px * var(--component-activity-scale)) 0 calc(2px * var(--component-activity-scale));
    color: var(--component-activity-center-faint);
    font-size: calc(11.5px * var(--component-activity-scale));
    font-weight: 760;
  }

  .event-list {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .activity-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: calc(4px * var(--component-activity-scale));
  }

  .item-end {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: calc(6px * var(--component-activity-scale));
  }

  .dismiss-btn {
    display: inline-grid;
    place-items: center;
    width: calc(26px * var(--component-activity-scale));
    height: calc(26px * var(--component-activity-scale));
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--component-activity-center-faint);
    cursor: pointer;
    opacity: var(--component-activity-center-pill-hidden-opacity);
    transition: opacity var(--t-fast), color var(--t-fast), background var(--t-fast), border-color var(--t-fast);
  }

  .activity-row:hover .dismiss-btn,
  .system-item:hover .dismiss-btn,
  .issue-group:hover .dismiss-btn,
  .dismiss-btn:focus-visible {
    opacity: var(--component-activity-center-pill-visible-opacity);
  }

  .dismiss-btn:hover {
    color: var(--component-activity-center-clear-danger-fg);
    border-color: var(--component-activity-center-clear-danger-border);
    background: var(--component-activity-center-clear-danger-bg);
  }

  .issue-list {
    display: flex;
    flex-direction: column;
    gap: calc(8px * var(--component-activity-scale));
    margin-bottom: calc(10px * var(--component-activity-scale));
  }

  .activity-item,
  .system-item,
  .issue-group {
    width: 100%;
    display: grid;
    align-items: center;
    gap: calc(14px * var(--component-activity-scale));
    min-height: calc(56px * var(--component-activity-scale));
    padding: calc(12px * var(--component-activity-scale)) 0;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    text-align: left;
  }

  .activity-item {
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast);
  }

  .activity-item:hover {
    background: var(--component-activity-center-item-hover-bg);
    padding-left: calc(10px * var(--component-activity-scale));
    padding-right: calc(10px * var(--component-activity-scale));
  }

  .system-item {
    position: relative;
    grid-template-columns: calc(18px * var(--component-activity-scale)) minmax(0, 1fr) auto;
    align-items: start;
    min-height: 0;
    padding: calc(12px * var(--component-activity-scale)) 0;
  }

  .issue-group {
    grid-template-columns: calc(18px * var(--component-activity-scale)) minmax(0, 1fr) auto;
    min-height: 0;
    padding: calc(12px * var(--component-activity-scale));
    border: 1px solid var(--component-activity-center-issue-border);
    background: var(--component-activity-center-issue-bg);
  }

  .system-item + .system-item {
    border-top: 0;
  }

  .issue-marker {
    width: calc(8px * var(--component-activity-scale));
    height: calc(8px * var(--component-activity-scale));
    margin: calc(6px * var(--component-activity-scale)) auto 0;
    border-radius: var(--radius-full);
    background: var(--component-activity-center-danger);
    box-shadow: var(--component-activity-center-issue-marker-shadow);
  }

  .thumb-wrap {
    position: relative;
    flex-shrink: 0;
  }

  .thumb {
    display: block;
    width: calc(36px * var(--component-activity-scale));
    height: calc(52px * var(--component-activity-scale));
    border: 1px solid var(--component-activity-center-thumb-border);
    border-radius: var(--radius-sm);
    background: var(--component-activity-center-thumb-bg);
    object-fit: cover;
  }

  .item-count {
    position: absolute;
    right: -6px;
    bottom: -5px;
    min-width: calc(17px * var(--component-activity-scale));
    padding: calc(2px * var(--component-activity-scale)) calc(5px * var(--component-activity-scale));
    border: 1px solid var(--component-activity-center-count-border);
    border-radius: var(--radius-full);
    background: var(--component-activity-center-count-bg);
    color: var(--component-activity-center-count-fg);
    font-size: calc(9px * var(--component-activity-scale));
    font-weight: 900;
    line-height: 1;
    pointer-events: none;
    text-align: center;
  }

  .item-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: calc(5px * var(--component-activity-scale));
    overflow: hidden;
  }

  .item-title {
    color: var(--component-activity-center-title);
    overflow: hidden;
    font-size: calc(14px * var(--component-activity-scale));
    font-weight: 760;
    letter-spacing: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-subtitle {
    display: block;
    min-width: 0;
    margin-top: calc(1px * var(--component-activity-scale));
    color: var(--component-activity-center-subtle);
    overflow: hidden;
    font-size: calc(13px * var(--component-activity-scale));
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .issue-titles {
    display: block;
    color: var(--component-activity-center-faint);
    overflow: hidden;
    font-size: calc(12px * var(--component-activity-scale));
    line-height: 1.45;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .issue-actions {
    display: flex;
    flex-wrap: wrap;
    gap: calc(6px * var(--component-activity-scale));
    margin-top: calc(8px * var(--component-activity-scale));
  }

  .issue-action {
    border: 1px solid var(--component-activity-center-action-border);
    border-radius: var(--radius-full);
    background: var(--component-activity-center-action-bg);
    color: var(--component-activity-center-title);
    cursor: pointer;
    font-size: calc(11px * var(--component-activity-scale));
    font-weight: 760;
    letter-spacing: 0;
    padding: calc(5px * var(--component-activity-scale)) calc(9px * var(--component-activity-scale));
  }

  .issue-action:hover {
    border-color: var(--component-activity-center-action-hover-border);
    color: var(--component-activity-center-accent);
  }

  .chapter-arrow {
    color: var(--component-activity-center-chapter-fg);
  }

  .item-time {
    color: var(--component-activity-center-faint);
    font-size: calc(12px * var(--component-activity-scale));
    font-weight: 700;
    letter-spacing: 0;
    white-space: nowrap;
  }

  .action-pill {
    display: inline-flex;
    align-items: center;
    gap: calc(5px * var(--component-activity-scale));
    min-height: calc(26px * var(--component-activity-scale));
    padding: 0 calc(10px * var(--component-activity-scale));
    border: 1px solid var(--component-activity-center-pill-border);
    border-radius: var(--radius-sm);
    background: var(--component-activity-center-pill-bg);
    color: var(--component-activity-center-pill-fg);
    font-size: calc(11.5px * var(--component-activity-scale));
    font-weight: 820;
    letter-spacing: 0;
    opacity: var(--component-activity-center-pill-hidden-opacity);
    text-transform: none;
    transform: var(--component-activity-center-pill-hidden-transform);
    transition: var(--component-activity-center-pill-transition);
  }

  .activity-item:hover .action-pill {
    opacity: var(--component-activity-center-pill-visible-opacity);
    transform: var(--component-activity-center-pill-visible-transform);
  }

  .timeline {
    position: relative;
    display: grid;
    gap: 0;
  }

  .system-item:not(:last-child)::before {
    content: "";
    position: absolute;
    left: calc(5px * var(--component-activity-scale));
    top: calc(28px * var(--component-activity-scale));
    bottom: calc(-6px * var(--component-activity-scale));
    width: 1px;
    background: var(--component-activity-center-timeline-bg);
  }

  .dot {
    width: calc(11px * var(--component-activity-scale));
    height: calc(11px * var(--component-activity-scale));
    margin-top: calc(4px * var(--component-activity-scale));
    border: 2px solid var(--component-activity-center-dot-border);
    border-radius: var(--radius-full);
    background: var(--component-activity-center-accent);
    box-shadow: var(--component-activity-center-dot-shadow);
  }

  .system-item[data-kind="success"] .dot {
    background: var(--component-activity-center-accent);
  }

  .system-item[data-kind="error"] .dot {
    background: var(--component-activity-center-danger);
  }

  .system-item[data-kind="download"] .dot {
    background: var(--component-activity-center-download-dot-bg);
  }

  @media (max-width: 880px) {
    .activity-head {
      grid-template-columns: 1fr;
      align-items: start;
    }

    .head-actions {
      width: 100%;
    }

    .filters {
      width: 100%;
    }
  }

  @media (max-width: 620px) {
    .activity-head,
    .activity-body {
      padding-inline: calc(18px * var(--component-activity-scale));
    }

    .activity-item {
      grid-template-columns: auto minmax(0, 1fr) auto;
    }

    .system-item {
      grid-template-columns: calc(18px * var(--component-activity-scale)) minmax(0, 1fr);
    }

    .system-item .item-end {
      grid-column: 2;
      justify-self: start;
      flex-direction: row;
      align-items: center;
    }

    .action-pill {
      display: none;
    }
  }
</style>
