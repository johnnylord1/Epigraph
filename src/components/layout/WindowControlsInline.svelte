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
    gap: calc(4px * var(--n-hud-scale));
    -webkit-app-region: no-drag;
  }

  .window-controls-inline__btn {
    width: calc(24px * var(--n-hud-scale));
    height: calc(24px * var(--n-hud-scale));
    min-width: calc(24px * var(--n-hud-scale));
    padding: 0;
    line-height: 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: rgba(202, 196, 208, 0.66);
    cursor: pointer;
    -webkit-app-region: no-drag;
    transition:
      background 140ms ease,
      color 140ms ease,
      transform 90ms ease;
  }

  .window-controls-inline__btn:hover {
    color: var(--n-on-surface);
    background: rgba(255, 255, 255, 0.035);
  }

  .window-controls-inline__btn:active {
    transform: scale(0.92);
  }

  .window-controls-inline__btn .material-symbols-outlined {
    font-size: calc(11px * var(--n-hud-scale));
    line-height: 1;
  }

  .window-controls-inline__btn--close:hover {
    color: var(--n-on-surface);
    background: rgba(196, 122, 122, 0.1);
  }
</style>
