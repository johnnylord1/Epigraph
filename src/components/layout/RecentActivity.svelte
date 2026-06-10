<script lang="ts">
  import { ClockCounterClockwise, Trash, Play } from "phosphor-svelte";
  import { thumbUrl } from "../../lib/client";
  import { store, clearHistory, setActiveManga } from "../../store/state.svelte";
  import type { Manga } from "../../lib/types";
  import type { HistoryEntry, LibraryUpdateNotification } from "../../store/state.svelte";

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

  function formatReadTime(m: number): string {
    if (m < 1)  return "< 1 min";
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r === 0 ? `${h}h` : `${h}h ${r}m`;
  }

  function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : pluralLabel}`;
  }

  const SESSION_GAP_MS = 30 * 60 * 1000;

  interface Session {
    mangaId:           number;
    mangaTitle:        string;
    thumbnailUrl:      string;
    latestChapterId:   number;
    latestChapterName: string;
    latestPageNumber:  number;
    firstChapterName:  string;
    chapterCount:      number;
    readAt:            number;
  }

  interface UpdateEntry {
    id: string;
    notification: LibraryUpdateNotification;
    manga: Manga | null;
    title: string;
    subtitle: string;
    count: number;
    source: string;
    readAt: number;
  }

  interface SystemEntry {
    id: string;
    kind: "success" | "error" | "info" | "download";
    title: string;
    body: string;
    readAt: number;
  }

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
        latestPageNumber:  latest.pageNumber,
        firstChapterName:  oldest.chapterName,
        chapterCount:      group.length,
        readAt:            latest.readAt,
      });
      i = j;
    }
    return sessions;
  }

  const sessions = $derived(buildSessions(store.history));

  const updateEntries = $derived.by(() => {
    const mangaById = new Map(store.libraryMangaSnapshot.map((manga) => [manga.id, manga]));
    return store.libraryUpdateNotifications
      .map((notification): UpdateEntry => {
        const manga = mangaById.get(notification.mangaId) ?? null;
        const count = Math.max(1, Number(notification.chapterDelta ?? 1));
        return {
          id: notification.id,
          notification,
          manga,
          title: notification.mangaTitle || manga?.title || "Unknown title",
          subtitle: `${plural(count, "chapter")} added in the latest refresh`,
          count,
          source: notification.sourceName || manga?.source?.displayName || manga?.source?.name || "Library",
          readAt: notification.createdAt,
        };
      })
      .sort((left, right) => right.readAt - left.readAt || right.count - left.count || left.title.localeCompare(right.title))
      .slice(0, 80);
  });

  const systemEntries = $derived.by(() => {
    const entries: SystemEntry[] = store.toasts
      .map((toast): SystemEntry => ({
        id: `toast:${toast.id}`,
        kind: toast.kind,
        title: toast.title,
        body: toast.body ?? "",
        readAt: toast.updatedAt ?? Date.now(),
      }))
      .sort((left, right) => right.readAt - left.readAt);

    const lastSync = store.settings.lastLibraryUpdateAt;
    if (lastSync) {
      entries.push({
        id: "system:last-library-update",
        kind: "success",
        title: "Library sync completed",
        body: `Automatic updates every ${store.settings.libraryUpdateIntervalHours ?? 12}h.`,
        readAt: lastSync,
      });
    }

    entries.push({
      id: "system:auto-updates",
      kind: store.settings.autoLibraryUpdatesEnabled ? "success" : "info",
      title: store.settings.autoLibraryUpdatesEnabled ? "Automatic library updates enabled" : "Automatic library updates disabled",
      body: store.settings.autoLibraryUpdatesEnabled
        ? `Next checks use the ${store.settings.libraryUpdateIntervalHours ?? 12}h interval.`
        : "Manual refresh is still available from Library.",
      readAt: lastSync ?? Date.now(),
    });

    entries.push({
      id: "system:standby",
      kind: store.settings.localServerStandbyEnabled ? "info" : "download",
      title: store.settings.localServerStandbyEnabled ? "Local server standby is active" : "Local server standby is disabled",
      body: store.settings.localServerStandbyEnabled
        ? `Server can sleep after ${store.settings.localServerStandbyIdleMin ?? 10} min idle.`
        : "The embedded server will stay awake while the app is open.",
      readAt: lastSync ?? Date.now(),
    });

    return entries.sort((left, right) => right.readAt - left.readAt).slice(0, 40);
  });

  const totalVisibleCount = $derived(updateEntries.length + sessions.length + systemEntries.length);
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
    setActiveManga({
      id:           session.mangaId,
      title:        session.mangaTitle,
      thumbnailUrl: session.thumbnailUrl,
      inLibrary:    false,
    } as any);
  }

  function openUpdate(entry: UpdateEntry) {
    const manga = entry.manga ?? {
      id: entry.notification.mangaId,
      title: entry.title,
      thumbnailUrl: entry.notification.thumbnailUrl,
      inLibrary: true,
    };
    setActiveManga({
      ...manga,
      inLibrary: true,
    } as Manga);
  }

  function handleClear() {
    if (!confirmClear) { confirmClear = true; setTimeout(() => confirmClear = false, 3000); return; }
    clearHistory(); confirmClear = false;
  }
</script>

<div class="activity-root">
  <header class="activity-head">
    <div class="title-stack">
      <span class="eyebrow">Notifications</span>
      <h2>Recent activity</h2>
      <p>Your latest reading, update, and system events.</p>
    </div>

    <div class="head-actions">
      <div class="filters" role="tablist" aria-label="Notification filters">
        <button class="filter" class:active={activeTab === "all"} type="button" role="tab" aria-selected={activeTab === "all"} onclick={() => activeTab = "all"}>
          All <span class="filter-count">{totalVisibleCount}</span>
        </button>
        <button class="filter" class:active={activeTab === "updates"} type="button" role="tab" aria-selected={activeTab === "updates"} onclick={() => activeTab = "updates"}>
          Updates <span class="filter-count">{updateEntries.length}</span>
        </button>
        <button class="filter" class:active={activeTab === "history"} type="button" role="tab" aria-selected={activeTab === "history"} onclick={() => activeTab = "history"}>
          History <span class="filter-count">{sessions.length}</span>
        </button>
        <button class="filter" class:active={activeTab === "system"} type="button" role="tab" aria-selected={activeTab === "system"} onclick={() => activeTab = "system"}>
          System <span class="filter-count">{systemEntries.length}</span>
        </button>
      </div>

      {#if activeTab === "history" && store.history.length > 0}
        <button class="clear-btn" class:confirm={confirmClear} onclick={handleClear}
          title={confirmClear ? "Click again to confirm" : "Clear history"}>
          <Trash size={14} weight="light" />
          <span>{confirmClear ? "Confirm" : "Clear"}</span>
        </button>
      {/if}
    </div>
  </header>

  {#if store.readingStats.totalChaptersRead > 0}
    <section class="summary" aria-label="Reading summary">
      <div class="chip">
        <span>{store.readingStats.currentStreakDays}</span>
        day streak
      </div>
      <div class="chip">
        <span>{store.readingStats.totalChaptersRead}</span>
        {store.readingStats.totalChaptersRead === 1 ? "chapter" : "chapters"}
      </div>
      <div class="chip">
        <span>{formatReadTime(store.readingStats.totalMinutesRead)}</span>
        read time
      </div>
      <div class="chip">
        <span>{store.readingStats.totalMangaRead}</span>
        {store.readingStats.totalMangaRead === 1 ? "series" : "series"}
      </div>
      <div class="chip">
        Best streak:
        <span>{store.readingStats.longestStreakDays}d</span>
      </div>
    </section>
  {/if}

  <main class="activity-body">
    {#if activeTab === "all" || activeTab === "updates"}
      <section class="activity-section">
        <div class="section-title">
          <span>Updates</span>
          <small>{updateEntries.length}</small>
        </div>

        {#if updateEntries.length === 0}
          <p class="compact-empty">No new chapter updates.</p>
        {:else}
          <div class="event-list">
            {#each updateEntries as entry (entry.id)}
              <button class="activity-item with-thumb event" onclick={() => openUpdate(entry)}>
                <div class="thumb-wrap">
                  <img src={thumbUrl(entry.manga?.thumbnailUrl ?? entry.notification.thumbnailUrl)} alt={entry.title} class="thumb" />
                  <span class="item-count">{entry.count}</span>
                </div>
                <div class="item-copy">
                  <span class="item-title">{entry.title}</span>
                  <span class="item-subtitle">{entry.subtitle} - {entry.source}</span>
                </div>
                <span class="item-time">{timeAgo(entry.readAt)}</span>
                <span class="action-pill">Open</span>
              </button>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    {#if activeTab === "all"}
      <section class="activity-section">
        <div class="section-title">
          <span>History</span>
          <small>{sessions.length}</small>
        </div>

        {#if sessions.length === 0}
          <p class="compact-empty">No reading history yet.</p>
        {:else}
          <div class="event-list">
            {#each sessions.slice(0, 8) as session (session.latestChapterId)}
              <button class="activity-item with-thumb event" onclick={() => resume(session)}>
                <div class="thumb-wrap">
                  <img src={thumbUrl(session.thumbnailUrl)} alt={session.mangaTitle} class="thumb" />
                  {#if session.chapterCount > 1}
                    <span class="item-count">{session.chapterCount}</span>
                  {/if}
                </div>
                <div class="item-copy">
                  <span class="item-title">{session.mangaTitle}</span>
                  <span class="item-subtitle">{session.latestChapterName}</span>
                </div>
                <span class="item-time">{timeAgo(session.readAt)}</span>
                <span class="action-pill"><Play size={10} weight="fill" /> Resume</span>
              </button>
            {/each}
          </div>
        {/if}
      </section>
    {:else if activeTab === "history"}
      {#if sessions.length === 0}
        <section class="activity-section">
          <div class="section-title">
            <span>History</span>
            <small>0</small>
          </div>
          <div class="full-empty">
            <ClockCounterClockwise size={28} weight="light" />
            <p>No reading history yet.</p>
            <span>Chapters you read will appear here.</span>
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
                    <img src={thumbUrl(session.thumbnailUrl)} alt={session.mangaTitle} class="thumb" />
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
                        {#if session.latestPageNumber > 1}
                          <span class="chapter-page">p.{session.latestPageNumber}</span>
                        {/if}
                      {/if}
                    </span>
                  </div>
                  <span class="item-time">{timeAgo(session.readAt)}</span>
                  <span class="action-pill"><Play size={10} weight="fill" /> Resume</span>
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
          <span>System</span>
          <small>{systemEntries.length}</small>
        </div>

        {#if systemEntries.length === 0}
          <p class="compact-empty">No system events.</p>
        {:else}
          <div class="timeline">
            {#each systemEntries as entry (entry.id)}
              <article class="system-item event" data-kind={entry.kind}>
                <span class="dot"></span>
                <div class="item-copy">
                  <span class="item-title">{entry.title}</span>
                  {#if entry.body}<span class="item-subtitle">{entry.body}</span>{/if}
                </div>
                <span class="item-time">{timeAgo(entry.readAt)}</span>
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
    border: 1px solid var(--activity-line);
    border-radius: calc(18px * var(--n-hud-scale));
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.025), transparent 180px),
      var(--activity-panel);
    box-shadow: 0 24px 58px rgba(0, 0, 0, 0.32);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }

  .activity-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: calc(20px * var(--n-hud-scale));
    padding: calc(28px * var(--n-hud-scale)) calc(28px * var(--n-hud-scale)) calc(22px * var(--n-hud-scale));
    border-bottom: 1px solid var(--activity-line-soft);
    flex-shrink: 0;
  }

  .title-stack {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .eyebrow {
    margin: 0 0 calc(10px * var(--n-hud-scale));
    color: var(--activity-accent);
    font-size: calc(12px * var(--n-hud-scale));
    font-weight: 850;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    color: var(--activity-text);
    font-size: clamp(calc(28px * var(--n-hud-scale)), 3vw, calc(38px * var(--n-hud-scale)));
    font-weight: 820;
    letter-spacing: -0.01em;
    line-height: 1;
  }

  p {
    margin: 0;
  }

  .title-stack p {
    max-width: calc(520px * var(--n-hud-scale));
    margin: calc(10px * var(--n-hud-scale)) 0 0;
    color: var(--activity-muted);
    font-size: calc(14px * var(--n-hud-scale));
    line-height: 1.55;
  }

  .head-actions {
    display: flex;
    align-items: center;
    gap: calc(10px * var(--n-hud-scale));
  }

  .clear-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: calc(7px * var(--n-hud-scale));
    min-width: calc(36px * var(--n-hud-scale));
    height: calc(34px * var(--n-hud-scale));
    padding: 0 calc(11px * var(--n-hud-scale));
    border: 1px solid var(--activity-line);
    border-radius: calc(12px * var(--n-hud-scale));
    background: rgba(18, 18, 24, 0.72);
    color: var(--activity-muted);
    cursor: pointer;
    font-size: calc(10px * var(--n-hud-scale));
    font-weight: 780;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    transition: color var(--t-fast), background var(--t-fast), border-color var(--t-fast);
  }

  .clear-btn:hover,
  .clear-btn.confirm {
    color: #f1c1ce;
    border-color: rgba(241, 193, 206, 0.22);
    background: rgba(104, 38, 57, 0.18);
  }

  .filters {
    display: flex;
    align-items: center;
    gap: calc(4px * var(--n-hud-scale));
    padding: calc(4px * var(--n-hud-scale));
    border: 0;
    border-radius: 999px;
    background: rgba(10, 10, 14, 0.66);
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
    gap: calc(8px * var(--n-hud-scale));
    height: calc(34px * var(--n-hud-scale));
    padding: 0 calc(14px * var(--n-hud-scale));
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: rgba(211, 205, 221, 0.46);
    cursor: pointer;
    font-size: calc(12px * var(--n-hud-scale));
    font-weight: 850;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
    transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
  }

  .filter:hover {
    color: rgba(235, 230, 241, 0.86);
    background: rgba(191, 170, 248, 0.045);
  }

  .filter.active {
    background: var(--activity-accent-soft);
    color: var(--activity-text);
    box-shadow: inset 0 0 0 1px var(--activity-accent-line);
  }

  .filter-count {
    display: inline-grid;
    place-items: center;
    min-width: calc(18px * var(--n-hud-scale));
    height: calc(18px * var(--n-hud-scale));
    padding: 0 calc(6px * var(--n-hud-scale));
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    color: inherit;
    font-size: calc(10px * var(--n-hud-scale));
    line-height: 1;
  }

  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: calc(10px * var(--n-hud-scale));
    padding: calc(18px * var(--n-hud-scale)) calc(28px * var(--n-hud-scale)) calc(8px * var(--n-hud-scale));
    flex-shrink: 0;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: calc(8px * var(--n-hud-scale));
    min-height: calc(34px * var(--n-hud-scale));
    padding: 0 calc(12px * var(--n-hud-scale));
    border-radius: 999px;
    background: var(--activity-panel-soft);
    color: var(--activity-text);
    font-size: calc(13px * var(--n-hud-scale));
    font-weight: 700;
  }

  .chip span {
    color: var(--activity-accent);
    font-weight: 850;
  }

  .activity-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: calc(22px * var(--n-hud-scale)) calc(28px * var(--n-hud-scale)) calc(30px * var(--n-hud-scale));
  }

  .activity-section {
    margin: 0;
    padding: calc(20px * var(--n-hud-scale)) 0;
    border-top: 1px solid var(--activity-line-soft);
  }

  .activity-section:first-child {
    border-top: 0;
    padding-top: calc(4px * var(--n-hud-scale));
  }

  .section-title,
  .day-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    margin-bottom: calc(12px * var(--n-hud-scale));
    color: var(--activity-text);
    font-size: calc(13px * var(--n-hud-scale));
    font-weight: 850;
    letter-spacing: 0.11em;
    text-transform: uppercase;
  }

  .section-title small {
    min-width: calc(24px * var(--n-hud-scale));
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--activity-faint);
    font-size: calc(12px * var(--n-hud-scale));
    text-align: right;
  }

  .compact-empty {
    min-height: 0;
    color: var(--activity-faint);
    font-size: calc(14px * var(--n-hud-scale));
  }

  .full-empty {
    display: grid;
    place-items: center;
    gap: calc(8px * var(--n-hud-scale));
    min-height: calc(140px * var(--n-hud-scale));
    color: var(--activity-faint);
    text-align: center;
  }

  .full-empty :global(svg) {
    color: var(--activity-accent-line);
  }

  .full-empty p {
    color: var(--activity-text);
    font-size: calc(14px * var(--n-hud-scale));
    font-weight: 760;
  }

  .full-empty span {
    color: var(--activity-faint);
    font-size: calc(12px * var(--n-hud-scale));
  }

  .event-list {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .activity-item,
  .system-item {
    width: 100%;
    display: grid;
    align-items: center;
    gap: calc(14px * var(--n-hud-scale));
    min-height: calc(56px * var(--n-hud-scale));
    padding: calc(12px * var(--n-hud-scale)) 0;
    border: 0;
    border-radius: calc(10px * var(--n-hud-scale));
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
    background: rgba(255, 255, 255, 0.035);
    padding-left: calc(10px * var(--n-hud-scale));
    padding-right: calc(10px * var(--n-hud-scale));
  }

  .system-item {
    position: relative;
    grid-template-columns: calc(18px * var(--n-hud-scale)) minmax(0, 1fr) auto;
    align-items: start;
    min-height: 0;
    padding: calc(12px * var(--n-hud-scale)) 0;
  }

  .system-item + .system-item {
    border-top: 0;
  }

  .thumb-wrap {
    position: relative;
    flex-shrink: 0;
  }

  .thumb {
    display: block;
    width: calc(36px * var(--n-hud-scale));
    height: calc(52px * var(--n-hud-scale));
    border: 1px solid rgba(255, 255, 255, 0.075);
    border-radius: calc(7px * var(--n-hud-scale));
    background: rgba(14, 14, 18, 0.9);
    object-fit: cover;
  }

  .item-count {
    position: absolute;
    right: -6px;
    bottom: -5px;
    min-width: calc(17px * var(--n-hud-scale));
    padding: calc(2px * var(--n-hud-scale)) calc(5px * var(--n-hud-scale));
    border: 1px solid rgba(191, 170, 248, 0.28);
    border-radius: 999px;
    background: rgba(68, 50, 112, 0.82);
    color: rgba(248, 244, 255, 0.94);
    font-size: calc(9px * var(--n-hud-scale));
    font-weight: 900;
    line-height: 1;
    pointer-events: none;
    text-align: center;
  }

  .item-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: calc(5px * var(--n-hud-scale));
    overflow: hidden;
  }

  .item-title {
    color: var(--activity-title);
    overflow: hidden;
    font-size: calc(14px * var(--n-hud-scale));
    font-weight: 760;
    letter-spacing: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-subtitle {
    display: block;
    min-width: 0;
    margin-top: calc(1px * var(--n-hud-scale));
    color: var(--activity-subtle);
    overflow: hidden;
    font-size: calc(13px * var(--n-hud-scale));
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chapter-arrow,
  .chapter-page {
    color: rgba(176, 170, 184, 0.58);
  }

  .item-time {
    color: var(--activity-faint);
    font-size: calc(12px * var(--n-hud-scale));
    font-weight: 700;
    letter-spacing: 0;
    white-space: nowrap;
  }

  .action-pill {
    display: inline-flex;
    align-items: center;
    gap: calc(5px * var(--n-hud-scale));
    min-height: calc(26px * var(--n-hud-scale));
    padding: 0 calc(10px * var(--n-hud-scale));
    border: 1px solid rgba(191, 170, 248, 0.14);
    border-radius: calc(8px * var(--n-hud-scale));
    background: rgba(191, 170, 248, 0.06);
    color: rgba(226, 216, 255, 0.84);
    font-size: calc(10px * var(--n-hud-scale));
    font-weight: 820;
    letter-spacing: 0.08em;
    opacity: 0;
    text-transform: uppercase;
    transform: translateX(4px);
    transition: opacity var(--t-base), transform var(--t-base);
  }

  .activity-item:hover .action-pill {
    opacity: 1;
    transform: translateX(0);
  }

  .timeline {
    position: relative;
    display: grid;
    gap: 0;
  }

  .system-item:not(:last-child)::before {
    content: "";
    position: absolute;
    left: calc(5px * var(--n-hud-scale));
    top: calc(28px * var(--n-hud-scale));
    bottom: calc(-6px * var(--n-hud-scale));
    width: 1px;
    background: rgba(197, 176, 255, 0.13);
  }

  .dot {
    width: calc(11px * var(--n-hud-scale));
    height: calc(11px * var(--n-hud-scale));
    margin-top: calc(4px * var(--n-hud-scale));
    border: 2px solid rgba(18, 17, 22, 1);
    border-radius: 999px;
    background: var(--activity-accent);
    box-shadow: 0 0 0 1px rgba(197, 176, 255, 0.24);
  }

  .system-item[data-kind="success"] .dot {
    background: var(--activity-accent);
  }

  .system-item[data-kind="error"] .dot {
    background: var(--activity-danger);
  }

  .system-item[data-kind="download"] .dot {
    background: rgba(204, 198, 216, 0.62);
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
    .summary,
    .activity-body {
      padding-inline: calc(18px * var(--n-hud-scale));
    }

    .activity-item {
      grid-template-columns: auto minmax(0, 1fr) auto;
    }

    .system-item {
      grid-template-columns: calc(18px * var(--n-hud-scale)) minmax(0, 1fr);
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
