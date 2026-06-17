<script lang="ts">
  import { onMount } from "svelte";
  import { openActivityPanel, store } from "../../store/state.svelte";

  const ACTIVITY_SEEN_STORAGE_KEY = "aethon.home.activity.lastSeenReadAt";

  let lastActivitySeenAt = $state(0);
  const historyEntries = $derived(store.history ?? []);
  const updateNotifications = $derived(store.libraryUpdateNotifications ?? []);
  const updateIssues = $derived(store.libraryUpdateIssues ?? []);
  const systemNotifications = $derived(store.systemNotifications ?? []);

  const latestActivityAt = $derived(Math.max(
    historyEntries.reduce((latest, entry) => Math.max(latest, Number(entry.readAt) || 0), 0),
    updateNotifications.reduce((latest, entry) => Math.max(latest, Number(entry.createdAt) || 0), 0),
    updateIssues.reduce((latest, entry) => Math.max(latest, Number(entry.createdAt) || 0), 0),
    systemNotifications.reduce((latest, entry) => Math.max(latest, Number(entry.createdAt) || 0), 0),
  ));
  const newLibraryUpdateIssueGroupCount = $derived.by(() => {
    const groups = new Set<string>();
    for (const issue of updateIssues) {
      if ((Number(issue.createdAt) || 0) <= lastActivitySeenAt) continue;
      groups.add(`${issue.runId}:${issue.contentKind}:${issue.sourceId}:${issue.extensionName}`);
    }
    return groups.size;
  });
  const newActivityCount = $derived(
    historyEntries.filter((entry) => (Number(entry.readAt) || 0) > lastActivitySeenAt).length
    + updateNotifications.filter((entry) => (Number(entry.createdAt) || 0) > lastActivitySeenAt).length
    + newLibraryUpdateIssueGroupCount
    + systemNotifications.filter((entry) => (Number(entry.createdAt) || 0) > lastActivitySeenAt).length
  );
  const newActivityBadge = $derived(newActivityCount > 99 ? "99+" : String(newActivityCount));

  function markActivitySeen() {
    if (latestActivityAt <= 0) return;
    lastActivitySeenAt = latestActivityAt;
    try {
      localStorage.setItem(ACTIVITY_SEEN_STORAGE_KEY, String(latestActivityAt));
    } catch {
      // Some test/private contexts expose localStorage but reject access.
    }
  }

  function openActivity() {
    openActivityPanel(store.navPage);
    markActivitySeen();
  }

  onMount(() => {
    try {
      const storedLastSeen = Number(localStorage.getItem(ACTIVITY_SEEN_STORAGE_KEY) ?? 0);
      lastActivitySeenAt = Number.isFinite(storedLastSeen) ? storedLastSeen : 0;
    } catch {
      lastActivitySeenAt = 0;
    }
  });
</script>

<button
  class="n-icon-btn activity-btn"
  class:has-new-activity={newActivityCount > 0}
  type="button"
  title="Recent activity"
  aria-label={newActivityCount > 0 ? `Recent activity, ${newActivityCount} new` : "Recent activity"}
  onclick={openActivity}
>
  <span class="material-symbols-outlined" aria-hidden="true">notifications</span>
  {#if newActivityCount > 0}
    <span class="activity-badge" aria-hidden="true">{newActivityBadge}</span>
  {/if}
</button>

<style>
  .activity-btn {
    position: relative;
    width: calc(38px * var(--n-hud-scale));
    min-width: calc(38px * var(--n-hud-scale));
    padding-inline: 0;
  }

  .activity-badge {
    position: absolute;
    top: calc(6px * var(--n-hud-scale));
    right: calc(7px * var(--n-hud-scale));
    display: block;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: #c9adff;
    text-shadow:
      0 0 calc(7px * var(--n-hud-scale)) rgba(190, 164, 255, 0.95),
      0 0 calc(14px * var(--n-hud-scale)) rgba(155, 117, 255, 0.58);
    font-family: var(--font-sans);
    font-size: calc(13px * var(--n-hud-scale));
    font-weight: 900;
    letter-spacing: 0;
    line-height: 1;
    pointer-events: none;
  }

  .activity-btn.has-new-activity .material-symbols-outlined {
    color: #c9adff;
    text-shadow:
      0 0 calc(8px * var(--n-hud-scale)) rgba(190, 164, 255, 0.95),
      0 0 calc(18px * var(--n-hud-scale)) rgba(155, 117, 255, 0.64);
    font-variation-settings: "FILL" 0, "wght" 500, "GRAD" 0, "opsz" 20;
  }
</style>
