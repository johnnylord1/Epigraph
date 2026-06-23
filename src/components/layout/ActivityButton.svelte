<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { onMount } from "svelte";
  import { openActivityPanel, store } from "../../store/state.svelte";

  const ACTIVITY_SEEN_STORAGE_KEY = "aethon.home.activity.lastSeenReadAt";
  const ACTIVITY_SEEN_EVENT = "aethon:activity-seen";

  let lastActivitySeenAt = $state(0);
  const historyEntries = $derived(store.history ?? []);
  const updateNotifications = $derived((store.libraryUpdateNotifications ?? []).filter((entry) => store.matchesRuntimeProfile(entry)));
  const updateIssues = $derived((store.libraryUpdateIssues ?? []).filter((entry) => store.matchesRuntimeProfile(entry)));
  const systemNotifications = $derived((store.systemNotifications ?? []).filter((entry) => store.matchesRuntimeProfile(entry)));
  const activitySeenStorageKey = $derived(`${ACTIVITY_SEEN_STORAGE_KEY}:${store.runtimeResolvedLocalProfileId ?? "pending"}`);

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
      localStorage.setItem(activitySeenStorageKey, String(latestActivityAt));
    } catch {
      // Some test/private contexts expose localStorage but reject access.
    }
    window.dispatchEvent(new CustomEvent<number>(ACTIVITY_SEEN_EVENT, { detail: latestActivityAt }));
  }

  function openActivity() {
    openActivityPanel(store.navPage);
    markActivitySeen();
  }

  onMount(() => {
    function syncActivitySeen(event: Event) {
      const seenAt = Number((event as CustomEvent<number>).detail);
      if (!Number.isFinite(seenAt)) return;
      lastActivitySeenAt = Math.max(lastActivitySeenAt, seenAt);
    }

    function syncActivitySeenFromStorage(event: StorageEvent) {
      if (event.key !== activitySeenStorageKey) return;
      const seenAt = Number(event.newValue ?? 0);
      if (!Number.isFinite(seenAt)) return;
      lastActivitySeenAt = Math.max(lastActivitySeenAt, seenAt);
    }

    try {
      const storedLastSeen = Number(localStorage.getItem(activitySeenStorageKey) ?? 0);
      lastActivitySeenAt = Number.isFinite(storedLastSeen) ? storedLastSeen : 0;
    } catch {
      lastActivitySeenAt = 0;
    }

    window.addEventListener(ACTIVITY_SEEN_EVENT, syncActivitySeen);
    window.addEventListener("storage", syncActivitySeenFromStorage);

    return () => {
      window.removeEventListener(ACTIVITY_SEEN_EVENT, syncActivitySeen);
      window.removeEventListener("storage", syncActivitySeenFromStorage);
    };
  });
</script>

<button
  class="n-icon-btn activity-btn"
  class:has-new-activity={newActivityCount > 0}
  type="button"
  title={$_("ui_recentActivity")}
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
    top: calc(2px * var(--n-hud-scale));
    right: calc(2px * var(--n-hud-scale));
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: calc(14px * var(--n-hud-scale));
    height: calc(14px * var(--n-hud-scale));
    padding: 0 calc(2px * var(--n-hud-scale));
    border: 0;
    border-radius: 999px;
    background: rgba(16, 14, 22, 0.88);
    color: #eadfff;
    text-shadow:
      0 0 calc(2px * var(--n-hud-scale)) rgba(218, 201, 255, 0.98),
      0 0 calc(7px * var(--n-hud-scale)) rgba(155, 117, 255, 0.72);
    font-family: var(--font-sans);
    font-size: calc(11px * var(--n-hud-scale));
    font-weight: 900;
    letter-spacing: 0;
    line-height: 1;
    pointer-events: none;
  }

  .activity-btn.has-new-activity .material-symbols-outlined {
    color: inherit;
    text-shadow: none;
    font-variation-settings: "FILL" 0, "wght" 400, "GRAD" 0, "opsz" 20;
  }
</style>
