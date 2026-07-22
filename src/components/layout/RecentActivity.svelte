<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-shell";
  import { ClockCounterClockwise, Trash, Play } from "phosphor-svelte";
  import { getServerUrl } from "../../lib/client";
  import { startLocalFlareSolverrAndEnable } from "../../lib/flaresolverr";
  import { retryComicsLibrarySourceUpdate } from "../../lib/library/updateRuntime";
  import { resolveMangaCoverUrl } from "../../lib/manga/coverResolver";
  import { groupRefreshedNovelChaptersForNotifications, refreshNovelLibraryFromSources } from "../../lib/novels/libraryRefresh";
  import {
    buildNovelDetailRecordFromLibrary,
    getNovelLibraryChapters,
    peekNovelLibraryState,
  } from "../../lib/novels/libraryState";
  import { toSuwayomiWebViewUrl } from "../../lib/suwayomiWebView";
  import {
    store,
    addToast,
    clearHistory,
    clearLibraryUpdateNotifications,
    clearSystemNotifications,
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

  let confirmClear = $state(false);
  let activeTab: ActivityTab = $state("all");

  function timeAgo(ts: number): string {
    const diff = Date.now() - ts, m = Math.floor(diff / 60000);
    if (m < 1)  return "Just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7)  return `${d}d ago`;
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function dayLabel(ts: number): string {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return "Today";
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return "Yesterday";
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  }

  function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : pluralLabel}`;
  }

  function issueAffectedCount(issue: LibraryUpdateIssue) {
    if (Number.isFinite(Number(issue.affectedCount))) {
      return Math.max(1, Math.floor(Number(issue.affectedCount)));
    }
    const match = issue.message.match(/\b(\d+)\s+titles?\b/i);
    if (match) return Math.max(1, Number(match[1]));
    return 1;
  }

  const SESSION_GAP_MS = 30 * 60 * 1000;

  interface Session {
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
  }

  type SystemEntry = SystemNotification;

  function buildSessions(entries: HistoryEntry[]): Session[] {
    if (!entries.length) return [];
    const sessions: Session[] = [];
    let i = 0;
    while (i < entries.length) {
      const anchor = entries[i];
      const group: HistoryEntry[] = [anchor];
      let j = i + 1;
      while (j < entries.length) {
        const next = entries[j];
        if (next.mangaId === anchor.mangaId && anchor.readAt - next.readAt <= SESSION_GAP_MS) {
          group.push(next); j++;
        } else break;
      }
      const latest = group[0], oldest = group[group.length - 1];
      sessions.push({
        mangaId:           latest.mangaId,
        mangaTitle:        latest.mangaTitle,
        thumbnailUrl:      latest.thumbnailUrl,
        latestChapterId:   latest.chapterId,
        latestChapterName: latest.chapterName,
        firstChapterName:  oldest.chapterName,
        chapterCount:      group.length,
        readAt:            latest.readAt,
      });
      i = j;
    }
    return sessions;
  }

  const sessions = $derived(buildSessions(store.history));
  const updateNotifications = $derived((store.libraryUpdateNotifications ?? []).filter((entry) => store.matchesRuntimeProfile(entry)));
  const updateIssues = $derived((store.libraryUpdateIssues ?? []).filter((entry) => store.matchesRuntimeProfile(entry)));
  const systemNotifications = $derived((store.systemNotifications ?? []).filter((entry) => store.matchesRuntimeProfile(entry)));

  const updateEntries = $derived.by(() => {
    const mangaById = new Map(store.libraryMangaSnapshot.map((manga) => [manga.id, manga]));
    return updateNotifications
      .map((notification): UpdateEntry => {
        const manga = typeof notification.mangaId === "number" ? mangaById.get(notification.mangaId) ?? null : null;
        const count = Math.max(1, Number(notification.chapterDelta ?? 1));
        const chapterText = notification.chapterTitles?.[0]
          ? `${notification.chapterTitles[0]}${count > 1 ? ` + ${count - 1} more` : ""}`
          : plural(count, "chapter");
        return {
          id: notification.id,
          notification,
          manga,
          isNovel: notification.kind === "novels",
          title: notification.mangaTitle || manga?.title || translate("downloads_unknownTitle"),
          subtitle: `${chapterText} added in the latest refresh`,
          count,
          source: notification.sourceName || manga?.source?.displayName || manga?.source?.name || "Library",
          readAt: notification.createdAt,
        };
      })
      .sort((left, right) => right.readAt - left.readAt || right.count - left.count || left.title.localeCompare(right.title))
      .slice(0, 80);
  });

  const issueGroups = $derived.by(() => {
    const groups = new Map<string, IssueGroup>();
    for (const issue of updateIssues) {
      const key = `${issue.runId}:${issue.contentKind}:${issue.sourceId}:${issue.extensionName}`;
      const current = groups.get(key) ?? {
        id: key,
        sourceName: issue.sourceName || "Unknown source",
        extensionName: issue.extensionName || issue.sourceName || "Unknown extension",
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
        items: group.items
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
  const groups = $derived.by(() => {
    const map = new Map<string, Session[]>();
    for (const s of sessions) {
      const l = dayLabel(s.readAt);
      if (!map.has(l)) map.set(l, []);
      map.get(l)!.push(s);
    }
    return Array.from(map.entries()).map(([label, items]) => ({ label, items }));
  });

  function resume(session: Session) {
    openMangaDetail({
      id:           session.mangaId,
      title:        session.mangaTitle,
      thumbnailUrl: session.thumbnailUrl,
      inLibrary:    false,
    } as any);
  }

  function openUpdate(entry: UpdateEntry) {
    if (entry.isNovel && entry.notification.novelId) {
      const state = peekNovelLibraryState({
        profileId: store.runtimeResolvedLocalProfileId,
        serverUrl: store.runtimeServerUrl,
      });
      const novel = state.entries.find((candidate) => candidate.id === entry.notification.novelId);
      if (novel) {
        setActiveNovelDetail({
          novel: buildNovelDetailRecordFromLibrary(novel, getNovelLibraryChapters(state, novel.id)),
          inLibrary: true,
        });
      }
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
          title: `Source challenge - ${issue.sourceName}`,
        });
        return;
      }
      await open(issue.actionUrl);
    } catch (error) {
      addToast({
        kind: "error",
        title: translate("ui_couldNotOpenChallenge"),
        body: error instanceof Error ? error.message : translate("ui_aethonCouldNotOpenTheSourceChallengePage"),
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
          body: `${result.updated}/${result.checked} novels refreshed${result.newChapters > 0 ? `, ${result.newChapters} new chapters` : ""}.`,
        });
        return;
      }

      const result = await retryComicsLibrarySourceUpdate(sourceId);
      recordLibraryUpdateIssues(result.issues, result.updatedAt);
      addToast({
        kind: result.issues.length > 0 ? "info" : "success",
        title: result.issues.length > 0 ? translate("ui_sourceRetryFinishedWithIssues") : translate("ui_sourceRetryFinished"),
        body: `${result.changedMangaIds.length} comics checked for ${issue.sourceName}.`,
      });
    } catch (error) {
      addToast({
        kind: "error",
        title: translate("ui_couldNotRetrySource"),
        body: error instanceof Error ? error.message : translate("ui_aethonCouldNotRetryThisSource"),
      });
    } finally {
      setLibraryUpdateInFlight(false);
    }
  }

  function handleClear() {
    if (!confirmClear) { confirmClear = true; setTimeout(() => confirmClear = false, 3000); return; }
    if (activeTab === "all") {
      clearLibraryUpdateNotifications();
      clearHistory();
      clearSystemNotifications();
    } else if (activeTab === "updates") {
      clearLibraryUpdateNotifications();
    } else if (activeTab === "system") {
      clearSystemNotifications();
    } else {
      clearHistory();
    }
    confirmClear = false;
  }
</script>

<div class="activity-root">
  <header class="activity-head">
    <div class="title-stack">
      <span class="eyebrow">{$_("ui_notifications")}</span>
      <h2>{$_("ui_recentActivity")}</h2>
      <p>{$_("ui_yourLatestReadingUpdateAndSystemEvents")}</p>
    </div>

    <div class="head-actions">
      <div class="filters" role="tablist" aria-label={$_("ui_notificationFilters")}>
        <button class="filter" class:active={activeTab === "all"} type="button" role="tab" aria-selected={activeTab === "all"} onclick={() => activeTab = "all"}>
          {$_("downloads_filter_all")} <span class="filter-count">{totalVisibleCount}</span>
        </button>
        <button class="filter" class:active={activeTab === "updates"} type="button" role="tab" aria-selected={activeTab === "updates"} onclick={() => activeTab = "updates"}>
          {$_("sources_filters_updates")} <span class="filter-count">{updateEntries.length + issueGroups.length}</span>
        </button>
        <button class="filter" class:active={activeTab === "history"} type="button" role="tab" aria-selected={activeTab === "history"} onclick={() => activeTab = "history"}>
          {$_("ui_history")} <span class="filter-count">{sessions.length}</span>
        </button>
        <button class="filter" class:active={activeTab === "system"} type="button" role="tab" aria-selected={activeTab === "system"} onclick={() => activeTab = "system"}>
          {$_("ui_system")} <span class="filter-count">{systemEntries.length}</span>
        </button>
      </div>

      {#if (activeTab === "all" && totalVisibleCount > 0) || (activeTab === "updates" && (updateEntries.length > 0 || issueGroups.length > 0)) || (activeTab === "history" && store.history.length > 0) || (activeTab === "system" && systemEntries.length > 0)}
        <button class="clear-btn" class:confirm={confirmClear} onclick={handleClear}
          title={confirmClear ? "Click again to confirm" : activeTab === "all" ? "Clear all notifications and history" : activeTab === "updates" ? "Clear update notifications" : activeTab === "system" ? "Clear system notifications" : "Clear history"}>
          <Trash size={14} weight="light" />
          <span>{confirmClear ? "Confirm" : "Clear"}</span>
        </button>
      {/if}
    </div>
  </header>

  <main class="activity-body">
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
                <article class="issue-group event">
                  <div class="issue-marker"></div>
                  <div class="item-copy">
                    <span class="item-title">{group.extensionName}</span>
                    <span class="item-subtitle">
                      {group.count} {$_("ui_title")}{group.count === 1 ? "" : "s"} {$_("ui_couldNotUpdateFrom")} {group.sourceName}.
                    </span>
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
                  <span class="item-time">{timeAgo(group.latestAt)}</span>
                </article>
              {/each}
            </div>
          {/if}
          <div class="event-list">
            {#each updateEntries as entry (entry.id)}
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
            {/each}
          </div>
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
            {#each sessions.slice(0, 8) as session (session.latestChapterId)}
              <button class="activity-item with-thumb event" onclick={() => resume(session)}>
                <div class="thumb-wrap">
                  <img src={resolveMangaCoverUrl(session.thumbnailUrl, { context: "activity", persistence: "persistent", cacheGeneration: store.libraryCoverCacheGeneration })} alt={session.mangaTitle} class="thumb" />
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
              {#each items as session (session.latestChapterId)}
                <button class="activity-item with-thumb event" onclick={() => resume(session)}>
                  <div class="thumb-wrap">
                    <img src={resolveMangaCoverUrl(session.thumbnailUrl, { context: "activity", persistence: "persistent", cacheGeneration: store.libraryCoverCacheGeneration })} alt={session.mangaTitle} class="thumb" />
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
              <article class="system-item event" data-kind={entry.kind}>
                <span class="dot"></span>
                <div class="item-copy">
                  <span class="item-title">{entry.title}</span>
                  {#if entry.body}<span class="item-subtitle">{entry.body}</span>{/if}
                </div>
                <span class="item-time">{timeAgo(entry.createdAt)}</span>
              </article>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
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
    font-size: calc(10px * var(--component-activity-scale));
    font-weight: 780;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    transition: color var(--t-fast), background var(--t-fast), border-color var(--t-fast);
  }

  .clear-btn:hover,
  .clear-btn.confirm {
    color: var(--component-activity-center-clear-danger-fg);
    border-color: var(--component-activity-center-clear-danger-border);
    background: var(--component-activity-center-clear-danger-bg);
  }

  .filters {
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

  .filter {
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
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
    transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
  }

  .filter:hover {
    color: var(--component-activity-center-filter-hover-fg);
    background: var(--component-activity-center-filter-hover-bg);
  }

  .filter.active {
    background: var(--component-activity-center-accent-soft);
    color: var(--component-activity-center-text);
    box-shadow: var(--component-activity-center-filter-active-shadow);
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
    letter-spacing: 0.11em;
    text-transform: uppercase;
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

  .event-list {
    display: flex;
    flex-direction: column;
    gap: 0;
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
    font-size: calc(10px * var(--component-activity-scale));
    font-weight: 820;
    letter-spacing: 0.08em;
    opacity: var(--component-activity-center-pill-hidden-opacity);
    text-transform: uppercase;
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

    .system-item .item-time {
      grid-column: 2;
      justify-self: start;
    }

    .action-pill {
      display: none;
    }
  }
</style>
