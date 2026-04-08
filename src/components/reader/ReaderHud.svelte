<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    overlayBars?: boolean;
    uiVisible?: boolean;
    onMouseMove?: (event: MouseEvent) => void;
    topbarLeft?: Snippet;
    topbarRight?: Snippet;
    bottombar?: Snippet;
    children?: Snippet;
  };

  let {
    overlayBars = false,
    uiVisible = true,
    onMouseMove = () => {},
    topbarLeft,
    topbarRight,
    bottombar,
    children,
  }: Props = $props();
</script>

<div class="root" class:overlay-bars={overlayBars} role="presentation" onmousemove={onMouseMove}>
  <div class="topbar" class:hidden={!uiVisible}>
    <div class="topbar-left">
      {@render topbarLeft?.()}
    </div>
    <div class="topbar-right">
      {@render topbarRight?.()}
    </div>
  </div>

  {@render children?.()}

  <div class="bottombar" class:hidden={!uiVisible}>
    {@render bottombar?.()}
  </div>
</div>

<style>
  .root {
    position: fixed;
    inset: 0;
    background: #000;
    display: flex;
    flex-direction: column;
    z-index: var(--z-reader);
    transform: translateZ(0);
    will-change: transform;
  }

  .overlay-bars {
    position: fixed;
  }

  .overlay-bars .topbar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 10;
  }

  .overlay-bars .bottombar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 10;
  }

  .overlay-bars :global(.viewer) {
    height: 100%;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--hud-toolbar-gap);
    padding: 0 var(--sp-3);
    height: calc(var(--hud-control-height) + 10px);
    background: color-mix(in srgb, var(--bg-void) calc(var(--hud-reader-chrome-opacity) * 100%), transparent);
    border-bottom: 1px solid var(--border-dim);
    flex-shrink: 0;
    position: relative;
    z-index: 2;
    transition: opacity var(--t-slow);
  }

  .topbar.hidden,
  .bottombar.hidden {
    opacity: 0;
    pointer-events: none;
  }

  .topbar-left {
    display: flex;
    align-items: center;
    gap: var(--hud-toolbar-gap);
    min-width: 0;
    flex: 1;
    overflow: hidden;
  }

  .topbar-right {
    display: flex;
    align-items: center;
    gap: var(--hud-toolbar-gap);
    flex-shrink: 0;
  }

  .topbar :global(.mode-extras) {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    min-width: 0;
  }

  :global(.reader-hud-icon-btn),
  .topbar :global(.icon-btn) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--hud-icon-button-size);
    height: var(--hud-icon-button-size);
    border-radius: var(--hud-control-radius);
    color: var(--text-muted);
    flex-shrink: 0;
    transition: color var(--t-base), background var(--t-base);
  }

  :global(.reader-hud-icon-btn:hover:not(:disabled)),
  .topbar :global(.icon-btn:hover:not(:disabled)) {
    color: var(--text-primary);
    background: var(--bg-raised);
  }

  :global(.reader-hud-icon-btn:disabled),
  .topbar :global(.icon-btn:disabled) {
    opacity: 0.2;
    cursor: default;
  }

  :global(.reader-hud-icon-btn.active),
  .topbar :global(.icon-btn.active) {
    color: var(--accent-fg);
  }

  .topbar :global(.ch-label) {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .topbar :global(.ch-title) {
    color: var(--text-secondary);
    font-weight: var(--weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .topbar :global(.ch-sep) {
    color: var(--text-faint);
    flex-shrink: 0;
  }

  .topbar :global(.page-label) {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-muted);
    letter-spacing: var(--tracking-wide);
    flex-shrink: 0;
  }

  .topbar :global(.top-sep) {
    width: 1px;
    height: 16px;
    background: var(--border-dim);
    flex-shrink: 0;
    margin: 0 var(--sp-1);
  }

  :global(.reader-hud-mode-btn),
  .topbar :global(.mode-btn) {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: var(--hud-control-height);
    padding: 4px var(--sp-2);
    border-radius: var(--hud-control-radius);
    color: var(--text-muted);
    flex-shrink: 0;
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    transition: color var(--t-base), background var(--t-base);
  }

  :global(.reader-hud-mode-btn:hover),
  .topbar :global(.mode-btn:hover) {
    color: var(--text-primary);
    background: var(--bg-raised);
  }

  :global(.reader-hud-mode-btn.active),
  .topbar :global(.mode-btn.active) {
    color: var(--accent-fg);
    background: var(--hud-selection-bg);
  }

  :global(.reader-hud-mode-label),
  .topbar :global(.mode-label) {
    text-transform: capitalize;
  }

  .topbar :global(.zoom-wrap) {
    position: relative;
    flex-shrink: 0;
  }

  .topbar :global(.zoom-inline) {
    display: flex;
    align-items: center;
    gap: 1px;
    background: var(--bg-overlay);
    border: 1px solid var(--border-base);
    border-radius: var(--hud-control-radius);
    overflow: hidden;
  }

  .topbar :global(.zoom-step-btn) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 24px;
    color: var(--text-muted);
    transition: color var(--t-base), background var(--t-base);
  }

  .topbar :global(.zoom-step-btn:hover:not(:disabled)) {
    color: var(--text-primary);
    background: var(--bg-raised);
  }

  .topbar :global(.zoom-step-btn:disabled) {
    opacity: 0.25;
    cursor: default;
  }

  .topbar :global(.zoom-pct-btn) {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    color: var(--text-secondary);
    padding: 0 var(--sp-2);
    height: 24px;
    min-width: 38px;
    text-align: center;
    transition: color var(--t-base), background var(--t-base);
    border-left: 1px solid var(--border-dim);
    border-right: 1px solid var(--border-dim);
  }

  .topbar :global(.zoom-pct-btn:hover) {
    color: var(--text-primary);
    background: var(--bg-raised);
  }

  .topbar :global(.zoom-popover) {
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    translate: -50% 0;
    background: var(--bg-raised);
    border: 1px solid var(--border-base);
    border-radius: var(--hud-popover-radius);
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    z-index: 100;
    min-width: 180px;
    animation: readerHudScaleIn var(--t-fast) both;
    transform-origin: top center;
  }

  .topbar :global(.zoom-slider-row) {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

  .topbar :global(.zoom-slider) {
    flex: 1;
    height: var(--hud-progress-height);
    appearance: none;
    -webkit-appearance: none;
    background: var(--border-strong);
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }

  .topbar :global(.zoom-slider::-webkit-slider-thumb) {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent-fg);
    cursor: pointer;
  }

  .topbar :global(.zoom-reset) {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-muted);
    letter-spacing: var(--tracking-wide);
    padding: 3px var(--sp-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-dim);
    transition: color var(--t-base), background var(--t-base), border-color var(--t-base);
  }

  .topbar :global(.zoom-reset:hover:not(:disabled)) {
    color: var(--text-primary);
    background: var(--bg-overlay);
    border-color: var(--border-strong);
  }

  .topbar :global(.zoom-reset:disabled) {
    opacity: 0.3;
    cursor: default;
  }

  .bottombar {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-3);
    border-top: 1px solid var(--border-dim);
    background: color-mix(in srgb, var(--bg-void) calc(var(--hud-reader-chrome-opacity) * 100%), transparent);
    flex-shrink: 0;
    transition: opacity var(--t-slow);
  }

  .bottombar :global(.nav-btn) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: calc(var(--hud-icon-button-size) + 4px);
    height: calc(var(--hud-icon-button-size) + 4px);
    flex-shrink: 0;
    border-radius: var(--hud-control-radius);
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    transition: background var(--t-base), color var(--t-base);
  }

  .bottombar :global(.nav-btn:hover:not(:disabled)) {
    background: var(--bg-raised);
    color: var(--text-primary);
  }

  .bottombar :global(.nav-btn:disabled) {
    opacity: 0.25;
    cursor: default;
  }

  .bottombar :global(.slider-wrap) {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
    height: 34px;
    cursor: pointer;
  }

  .bottombar :global(.slider-track-bg) {
    position: absolute;
    left: 0;
    right: 0;
    height: var(--hud-progress-height);
    background: var(--border-strong);
    border-radius: 2px;
    overflow: hidden;
    pointer-events: none;
  }

  .bottombar :global(.slider-fill) {
    height: 100%;
    background: var(--accent-fg);
    border-radius: 2px;
    transition: width 0.05s linear;
  }

  .bottombar :global(.slider-input) {
    position: absolute;
    left: 0;
    right: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
    margin: 0;
    z-index: 2;
  }

  .bottombar :global(.slider-checkpoint) {
    position: absolute;
    top: 50%;
    width: 4px;
    height: 10px;
    border-radius: 2px;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 1;
  }

  .bottombar :global(.bookmark-checkpoint) {
    background: var(--accent-fg);
    opacity: 0.7;
  }

  .bottombar :global(.slider-tooltip) {
    position: absolute;
    bottom: calc(100% + 2px);
    transform: translateX(-50%);
    background: var(--bg-raised);
    border: 1px solid var(--border-base);
    border-radius: var(--hud-status-radius);
    padding: 2px 6px;
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--text-secondary);
    white-space: nowrap;
    pointer-events: none;
    z-index: 10;
    letter-spacing: var(--tracking-wide);
  }

  .bottombar :global(.slider-wrap:hover .slider-track-bg),
  .bottombar :global(.slider-wrap.dragging .slider-track-bg) {
    height: 5px;
  }

  @keyframes readerHudScaleIn {
    from {
      opacity: 0;
      transform: scale(0.97);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
</style>
