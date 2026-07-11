<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { onMount } from "svelte";
  import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

  let win = $state<Window | null>(null);

  onMount(() => {
    try {
      win = getCurrentWindow();
    } catch (error) {
      win = null;
    }
  });

  async function minimizeWindow() {
    if (!win) return;
    await win.minimize().catch(() => {});
  }

  async function toggleMaximizeWindow() {
    if (!win) return;
    await win.toggleMaximize().catch(() => {});
  }

  async function closeWindow() {
    if (!win) return;
    await win.close().catch(() => {});
  }
</script>

<div class="window-controls-inline" aria-label={$_("ui_windowControls")}>
  <button type="button" class="window-controls-inline__btn" onclick={minimizeWindow} title={$_("ui_minimize")} aria-label={$_("ui_minimize")}>
    <span class="material-symbols-outlined" aria-hidden="true">remove</span>
  </button>

  <button type="button" class="window-controls-inline__btn" onclick={toggleMaximizeWindow} title={$_("ui_maximize")} aria-label={$_("ui_maximize")}>
    <span class="material-symbols-outlined" aria-hidden="true">crop_square</span>
  </button>

  <button
    type="button"
    class="window-controls-inline__btn window-controls-inline__btn--close"
    onclick={closeWindow}
    title={$_("ui_close_bbfa773e")}
    aria-label={$_("ui_close_bbfa773e")}
  >
    <span class="material-symbols-outlined" aria-hidden="true">close</span>
  </button>
</div>

<style>
  .window-controls-inline {
    display: inline-flex;
    align-items: center;
    gap: var(--component-window-inline-gap);
    -webkit-app-region: no-drag;
  }

  .window-controls-inline__btn {
    width: var(--component-window-inline-button-size);
    height: var(--component-window-inline-button-size);
    min-width: var(--component-window-inline-button-size);
    padding: 0;
    line-height: 0;
    border: none;
    border-radius: var(--component-window-inline-button-radius);
    background: transparent;
    color: var(--component-window-control-fg);
    cursor: pointer;
    -webkit-app-region: no-drag;
    transition: var(--component-window-inline-button-transition);
  }

  .window-controls-inline__btn:hover {
    color: var(--component-window-control-fg-hover);
    background: var(--component-window-control-bg-hover);
  }

  .window-controls-inline__btn:active {
    transform: var(--component-window-inline-button-active-transform);
  }

  .window-controls-inline__btn:focus-visible {
    outline: none;
    box-shadow: var(--component-window-inline-focus-ring);
  }

  .window-controls-inline__btn .material-symbols-outlined {
    font-size: var(--component-window-inline-icon-size);
    line-height: 1;
  }

  .window-controls-inline__btn--close:hover {
    color: var(--component-window-control-close-fg-hover);
    background: var(--component-window-control-close-bg-hover);
  }
</style>
