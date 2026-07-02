<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { onMount } from "svelte";
  import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

  let win = $state<Window | null>(null);

  onMount(() => {
    try {
      win = getCurrentWindow();
    } catch (error) {
      console.error("TitleBar failed to acquire current window", error);
      win = null;
    }
  });

  async function minimizeWindow() {
    if (!win) return;
    await win.minimize();
  }

  async function toggleMaximizeWindow() {
    if (!win) return;
    await win.toggleMaximize();
  }

  async function closeWindow() {
    if (!win) return;
    await win.close();
  }
</script>

<div class="window-controls" aria-label={$_("ui_windowControls")}>
  <button type="button" class="window-btn" onclick={minimizeWindow} title={$_("ui_minimize")} aria-label={$_("ui_minimize")}>
    <svg width="10" height="1" viewBox="0 0 10 1" aria-hidden="true">
      <line x1="0" y1="0.5" x2="10" y2="0.5" stroke="currentColor" stroke-width="1.5" />
    </svg>
  </button>

  <button type="button" class="window-btn" onclick={toggleMaximizeWindow} title={$_("ui_maximize")} aria-label={$_("ui_maximize")}>
    <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
      <rect x="0.75" y="0.75" width="7.5" height="7.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  </button>

  <button type="button" class="window-btn window-btn--close" onclick={closeWindow} title={$_("ui_close_bbfa773e")} aria-label={$_("ui_close_bbfa773e")}>
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  </button>
</div>

<style>
  .window-controls {
    position: fixed;
    top: 8px;
    right: 12px;
    z-index: var(--component-window-controls-z-index);
    display: flex;
    align-items: center;
    gap: 6px;
    pointer-events: auto;
    -webkit-app-region: no-drag;
  }

  .window-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 28px;
    border-radius: 10px;
    border: 1px solid var(--component-window-control-border);
    background: var(--component-window-control-bg);
    color: var(--component-window-control-fg);
    box-shadow: var(--component-window-control-shadow);
    transition:
      transform 140ms ease,
      background 160ms ease,
      border-color 160ms ease,
      color 160ms ease,
      box-shadow 160ms ease;
    backdrop-filter: var(--component-window-control-blur);
    -webkit-app-region: no-drag;
  }

  .window-btn:hover {
    transform: translateY(-1px);
    color: var(--component-window-control-fg-hover);
    border-color: var(--component-window-control-border-hover);
    background: var(--component-window-control-bg-hover);
    box-shadow: var(--component-window-control-shadow-hover);
  }

  .window-btn:active {
    transform: translateY(0) scale(0.96);
    background: var(--component-window-control-bg-active);
  }

  .window-btn--close:hover {
    color: var(--component-window-control-close-fg-hover);
    border-color: var(--component-window-control-close-border-hover);
    background: var(--component-window-control-close-bg-hover);
  }
</style>
