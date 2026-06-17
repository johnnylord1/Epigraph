<script lang="ts">
  import { closeActivityPanel, store } from "../../store/state.svelte";
  import RecentActivity from "./RecentActivity.svelte";

  function backLabel() {
    if (store.activityPanelReturnPage === "library") return "Back to Library";
    if (store.activityPanelReturnPage === "search") return "Back to Browse";
    if (store.activityPanelReturnPage === "downloads") return "Back to Downloads";
    if (store.activityPanelReturnPage === "settings") return "Back to Settings";
    return "Back to Home";
  }
</script>

<div class="activity-overlay" role="dialog" aria-label="Recent activity">
  <div class="activity-overlay__header">
    <button class="activity-overlay__back" type="button" onclick={closeActivityPanel}>
      <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
      {backLabel()}
    </button>
  </div>
  <div class="activity-overlay__content">
    <RecentActivity />
  </div>
</div>

<style>
  .activity-overlay {
    position: absolute;
    inset: 0;
    z-index: 42;
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    gap: calc(20px * var(--n-hud-scale));
    padding: calc((var(--n-topbar-height) + 24px) * var(--n-hud-scale)) calc(28px * var(--n-hud-scale)) calc(24px * var(--n-hud-scale));
    background:
      radial-gradient(circle at 20% 0%, rgba(155, 117, 255, 0.12), transparent 34%),
      rgba(13, 12, 15, 0.96);
    backdrop-filter: blur(18px);
    -webkit-app-region: no-drag;
  }

  .activity-overlay__header {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .activity-overlay__back {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border: 1px solid rgba(72, 69, 79, 0.14);
    border-radius: 999px;
    background: rgba(28, 27, 27, 0.45);
    color: rgba(202, 196, 208, 0.68);
    font-size: calc(11px * var(--n-hud-scale));
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: calc(10px * var(--n-hud-scale)) calc(16px * var(--n-hud-scale));
    cursor: pointer;
  }

  .activity-overlay__back:hover {
    color: var(--n-on-surface);
  }

  .activity-overlay__content {
    min-height: 0;
    overflow: hidden;
  }
</style>
