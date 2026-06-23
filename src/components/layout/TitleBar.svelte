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
    z-index: 3000;
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
    border: 1px solid rgba(184, 167, 234, 0.12);
    background: rgba(26, 24, 34, 0.88);
    color: rgba(239, 234, 255, 0.68);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.04),
      0 6px 16px rgba(0, 0, 0, 0.24);
    transition:
      transform 140ms ease,
      background 160ms ease,
      border-color 160ms ease,
      color 160ms ease,
      box-shadow 160ms ease;
    backdrop-filter: blur(22px) saturate(140%);
    -webkit-app-region: no-drag;
  }

  .window-btn:hover {
    transform: translateY(-1px);
    color: rgba(248, 244, 255, 0.92);
    border-color: rgba(184, 167, 234, 0.24);
    background: rgba(34, 31, 44, 0.94);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.06),
      0 10px 24px rgba(0, 0, 0, 0.3);
  }

  .window-btn:active {
    transform: translateY(0) scale(0.96);
    background: rgba(20, 18, 28, 0.96);
  }

  .window-btn--close:hover {
    color: #fff;
    border-color: rgba(229, 70, 99, 0.5);
    background: rgba(184, 48, 74, 0.92);
  }
</style>
