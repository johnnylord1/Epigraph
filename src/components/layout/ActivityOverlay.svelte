<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { closeActivityPanel, store } from "../../store/state.svelte";
  import RecentActivity from "./RecentActivity.svelte";
  import { enterViewOnMount } from "../../lib/motion/motion";

  function backLabel() {
    if (store.activityPanelReturnPage === "library") return $_("home.activity.backToLibrary");
    if (store.activityPanelReturnPage === "search") return $_("home.activity.backToBrowse");
    if (store.activityPanelReturnPage === "downloads") return $_("home.activity.backToDownloads");
    if (store.activityPanelReturnPage === "settings") return $_("home.activity.backToSettings");
    return $_("home.activity.backToHome");
  }
</script>

<div class="activity-overlay" role="dialog" aria-label={$_("ui_recentActivity")} use:enterViewOnMount>
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
    z-index: var(--component-activity-overlay-z-index);
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    gap: var(--component-activity-overlay-gap);
    padding: var(--component-activity-overlay-padding);
    background: var(--component-activity-overlay-bg);
    backdrop-filter: var(--component-activity-overlay-blur);
    animation: fadeIn 220ms ease both;
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
    gap: var(--component-activity-overlay-back-gap);
    border: 1px solid var(--component-activity-overlay-back-border);
    border-radius: var(--component-activity-overlay-back-radius);
    background: var(--component-activity-overlay-back-bg);
    color: var(--component-activity-overlay-back-fg);
    font-size: var(--component-activity-overlay-back-font-size);
    letter-spacing: var(--component-activity-overlay-back-letter-spacing);
    text-transform: none;
    padding: var(--component-activity-overlay-back-padding);
    cursor: pointer;
  }

  .activity-overlay__back:hover {
    color: var(--component-activity-overlay-back-hover-fg);
  }

  .activity-overlay__content {
    min-height: 0;
    overflow: hidden;
  }
</style>
