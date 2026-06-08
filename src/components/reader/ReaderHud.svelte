<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    overlayBars?: boolean;
    uiVisible?: boolean;
    onMouseMove?: (event: MouseEvent) => void;
    topbarLeft?: Snippet;
    topbarRight?: Snippet;
    sidePanel?: Snippet;
    bottombar?: Snippet;
    children?: Snippet;
  };

  let {
    overlayBars = false,
    uiVisible = true,
    onMouseMove = () => {},
    topbarLeft,
    topbarRight,
    sidePanel,
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
  {@render sidePanel?.()}

  <div class="bottombar" class:hidden={!uiVisible}>
    {@render bottombar?.()}
  </div>
</div>

<style>
  .root {
    --reader-void: var(--n-background, #131313);
    --reader-panel: rgba(20, 19, 38, 0.92);
    --reader-panel-soft: rgba(255, 255, 255, 0.02);
    --reader-line: rgba(202, 196, 208, 0.08);
    --reader-line-strong: rgba(184, 167, 234, 0.16);
    --reader-text: var(--n-on-surface, #f1eefc);
    --reader-muted: rgba(207, 200, 236, 0.74);
    --reader-faint: rgba(148, 139, 172, 0.62);
    --reader-accent: var(--n-primary, #b8a7ea);
    --reader-accent-2: var(--accent-bright, #b8adff);
    --reader-active-ink: #211b3b;
    position: fixed;
    inset: 0;
    z-index: var(--z-reader);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background:
      var(--n-gradient-bg, linear-gradient(180deg, #15151a 0%, #131313 100%)),
      var(--reader-void);
    color: var(--reader-text);
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    transform: translateZ(0);
  }

  .root::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      linear-gradient(90deg, rgba(255, 255, 255, 0.018), transparent 18%, transparent 82%, rgba(255, 255, 255, 0.012)),
      repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.01) 0 1px, transparent 1px 9px);
    opacity: 0.22;
  }

  .overlay-bars .topbar {
    position: absolute;
    top: 14px;
    left: 16px;
    right: 16px;
    z-index: 40;
    margin: 0;
  }

  .overlay-bars .bottombar {
    position: absolute;
    bottom: 14px;
    left: 16px;
    right: 16px;
    z-index: 40;
    margin: 0;
  }

  .overlay-bars :global(.viewer) {
    height: 100%;
  }

  .topbar,
  .bottombar {
    border: 0;
    background:
      linear-gradient(180deg, rgba(19, 19, 19, 0.72), rgba(19, 19, 19, 0.48)),
      rgba(20, 19, 30, 0.42);
    box-shadow: none;
    backdrop-filter: blur(24px) saturate(160%);
    position: relative;
    z-index: 3;
    transition: opacity 220ms ease, transform 220ms ease;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 56px;
    height: 56px;
    margin: 0;
    padding: 0 18px;
    border-bottom: 1px solid var(--reader-line);
    border-radius: 0;
  }

  .bottombar {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 54px;
    height: 54px;
    margin: 0;
    padding: 8px 16px;
    border-top: 1px solid var(--reader-line);
    border-radius: 0;
  }

  .topbar.hidden,
  .bottombar.hidden {
    opacity: 0;
    pointer-events: none;
    transform: translateY(-4px);
  }

  .bottombar.hidden {
    transform: translateY(4px);
  }

  .topbar-left,
  .topbar-right {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .topbar-left,
  .topbar-right,
  .topbar :global(.mode-extras) {
    gap: 5px;
  }

  .topbar-left {
    overflow: hidden;
  }

  .topbar-right {
    justify-content: flex-end;
  }

  .topbar :global(.icon-btn),
  .topbar :global(.mode-btn),
  .bottombar :global(.nav-btn) {
    color: var(--reader-muted);
    border: 1px solid rgba(202, 196, 208, 0.06);
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(255, 255, 255, 0.01)),
      rgba(255, 255, 255, 0.018);
    box-shadow: none;
    transition:
      color 150ms ease,
      background 150ms ease,
      border-color 150ms ease,
      transform 150ms ease,
      box-shadow 150ms ease;
  }

  .topbar :global(.icon-btn),
  .bottombar :global(.nav-btn) {
    display: inline-grid;
    place-items: center;
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 10px;
  }

  .topbar :global(.mode-btn) {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 30px;
    padding: 0 10px;
    flex-shrink: 0;
    border-radius: 10px;
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    font-size: 10px;
    font-weight: 850;
    letter-spacing: 0.065em;
  }

  .topbar :global(.mode-status) {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 30px;
    padding: 0 10px;
    flex-shrink: 0;
    border: 1px solid rgba(202, 196, 208, 0.06);
    border-radius: 10px;
    color: var(--reader-faint);
    background: rgba(255, 255, 255, 0.018);
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    font-size: 10px;
    font-weight: 850;
    letter-spacing: 0.065em;
  }

  .topbar :global(.icon-btn:hover:not(:disabled)),
  .topbar :global(.mode-btn:hover:not(:disabled)),
  .bottombar :global(.nav-btn:hover:not(:disabled)) {
    color: var(--reader-text);
    border-color: var(--reader-line-strong);
    background:
      linear-gradient(180deg, rgba(184, 167, 234, 0.11), rgba(184, 167, 234, 0.04)),
      rgba(184, 167, 234, 0.035);
    transform: translateY(-1px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.05),
      0 4px 12px rgba(0, 0, 0, 0.12);
  }

  .topbar :global(.icon-btn.active),
  .topbar :global(.mode-btn.active) {
    color: var(--reader-text);
    color: var(--reader-accent);
    border-color: rgba(184, 167, 234, 0.16);
    background: rgba(184, 167, 234, 0.1);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.06),
      0 8px 18px rgba(0, 0, 0, 0.18);
  }

  .topbar :global(button:disabled),
  .bottombar :global(button:disabled) {
    opacity: 0.22;
    cursor: default;
  }

  .topbar :global(.ch-label) {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin-left: 5px;
    overflow: hidden;
    color: var(--reader-faint);
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    font-size: 11px;
    font-weight: 750;
    letter-spacing: 0.045em;
    white-space: nowrap;
  }

  .topbar :global(.reader-title) {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-left: 5px;
  }

  .topbar :global(.reader-title strong) {
    max-width: 520px;
    overflow: hidden;
    color: var(--reader-text);
    font-size: 13px;
    font-weight: 850;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: 0;
  }

  .topbar :global(.reader-title span) {
    overflow: hidden;
    color: var(--reader-faint);
    font-size: 10px;
    font-weight: 750;
    letter-spacing: 0.045em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .topbar :global(.ch-title) {
    max-width: 520px;
    overflow: hidden;
    color: var(--reader-text);
    font-size: 13px;
    font-weight: 850;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: 0;
  }

  .topbar :global(.ch-sep),
  .topbar :global(.page-label),
  .topbar :global(.reader-progress-text) {
    color: var(--reader-faint);
  }

  .topbar :global(.page-label) {
    display: none;
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    font-size: 10px;
    font-weight: 750;
    letter-spacing: 0.045em;
    white-space: nowrap;
  }

  .topbar :global(.top-sep) {
    width: 1px;
    height: 18px;
    margin: 0 4px;
    background: var(--reader-line);
  }

  .topbar :global(.zoom-wrap) {
    position: relative;
    flex-shrink: 0;
  }

  .topbar :global(.zoom-inline) {
    display: flex;
    align-items: center;
    gap: 1px;
    overflow: hidden;
    border: 1px solid rgba(202, 196, 208, 0.06);
    border-radius: 10px;
    background: var(--reader-panel-soft);
  }

  .topbar :global(.zoom-step-btn),
  .topbar :global(.zoom-pct-btn) {
    height: 28px;
    color: var(--reader-muted);
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    font-size: 10px;
    font-weight: 850;
    letter-spacing: 0.045em;
  }

  .topbar :global(.zoom-step-btn) {
    width: 26px;
  }

  .topbar :global(.zoom-pct-btn) {
    min-width: 42px;
    padding: 0 8px;
    border-inline: 1px solid var(--reader-line);
  }

  .topbar :global(.zoom-popover) {
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    z-index: 100;
    min-width: 168px;
    translate: -50% 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--reader-line-strong);
    border-radius: 12px;
    background: rgba(20, 19, 38, 0.96);
    box-shadow: 0 20px 56px rgba(0, 0, 0, 0.48);
    animation: readerHudScaleIn 160ms ease both;
  }

  .topbar :global(.zoom-slider) {
    width: 100%;
    height: 4px;
    appearance: none;
    -webkit-appearance: none;
    border-radius: 999px;
    background: rgba(212, 204, 230, 0.12);
  }

  .topbar :global(.zoom-slider::-webkit-slider-thumb) {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 999px;
    background: var(--reader-accent);
  }

  .topbar :global(.zoom-reset) {
    min-height: 28px;
    border: 1px solid rgba(202, 196, 208, 0.06);
    border-radius: 10px;
    color: var(--reader-muted);
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    font-size: 10px;
    font-weight: 850;
    letter-spacing: 0.045em;
  }

  :global(.reader-tools-panel) {
    position: absolute;
    top: 72px;
    right: 20px;
    z-index: 12;
    width: min(236px, calc(100vw - 40px));
    padding: 14px;
    border: 1px solid var(--reader-line-strong);
    border-radius: 16px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.008)),
      rgba(20, 19, 38, 0.94);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.04),
      0 24px 72px rgba(0, 0, 0, 0.54);
    backdrop-filter: blur(28px) saturate(165%);
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    animation: readerToolsIn 180ms ease both;
  }

  :global(.reader-tools-panel__header) {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 3px 8px;
    align-items: center;
    padding: 0 0 8px;
  }

  :global(.reader-tools-panel__eyebrow) {
    grid-column: 1;
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--reader-accent);
  }

  :global(.reader-tools-panel__header strong) {
    grid-column: 1;
    font-size: 12px;
    color: var(--reader-text);
  }

  :global(.reader-tools-panel__close) {
    grid-column: 2;
    grid-row: 1 / span 2;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--reader-line);
    border-radius: 10px;
    color: var(--reader-muted);
    background: rgba(255, 255, 255, 0.018);
    transition: color 180ms ease, border-color 180ms ease, background 180ms ease;
  }

  :global(.reader-tools-panel__close:hover) {
    color: var(--reader-text);
    border-color: var(--reader-line-strong);
    background: rgba(201, 181, 255, 0.08);
  }

  :global(.reader-tools-segment) {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 3px;
    padding: 4px;
    border: 1px solid rgba(212, 204, 230, 0.075);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.018);
  }

  :global(.reader-tools-segment button),
  :global(.reader-tools-list button) {
    min-height: 28px;
    border-radius: 10px;
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.05em;
    color: var(--reader-muted);
    transition: background 180ms ease, color 180ms ease, transform 180ms ease;
  }

  :global(.reader-tools-segment button.active) {
    color: var(--reader-text);
    color: var(--reader-accent);
    background: rgba(184, 167, 234, 0.1);
  }

  :global(.reader-tools-segment button:disabled),
  :global(.reader-tools-list button:disabled) {
    opacity: 0.32;
    cursor: default;
  }

  :global(.reader-tools-segment button:not(.active):hover),
  :global(.reader-tools-list button:hover:not(:disabled)) {
    color: var(--reader-text);
    background: rgba(184, 167, 234, 0.06);
  }

  :global(.reader-tools-list) {
    margin: 8px 0 0;
  }

  :global(.reader-tools-list div) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 38px;
    border-top: 1px solid var(--reader-line);
  }

  :global(.reader-tools-list dt) {
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.05em;
    color: var(--reader-faint);
  }

  :global(.reader-tools-list dd) {
    margin: 0;
    color: var(--reader-muted);
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    font-size: 10px;
    font-weight: 800;
    text-align: right;
  }

  :global(.reader-tools-list dd > button) {
    padding: 0 8px;
    color: var(--reader-text);
  }

  :global(.reader-tools-select),
  :global(.reader-tools-number),
  :global(.reader-tools-color) {
    max-width: 112px;
    min-height: 28px;
    border: 1px solid var(--reader-line);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.018);
    color: var(--reader-text);
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.03em;
  }

  :global(.reader-tools-select) {
    padding: 0 7px;
  }

  :global(.reader-tools-number) {
    width: 58px;
    padding: 0 6px;
    text-align: right;
  }

  :global(.reader-tools-color) {
    width: 44px;
    padding: 3px;
    cursor: pointer;
  }

  :global(.reader-tools-zoom) {
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .bottombar :global(.progress-block) {
    flex: 1;
    min-width: 0;
  }

  .bottombar :global(.progress-meta) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 7px;
  }

  .bottombar :global(.progress-meta span) {
    color: var(--reader-faint);
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    font-size: 10px;
    font-weight: 750;
    letter-spacing: 0.045em;
  }

  .bottombar :global(.progress-meta strong) {
    color: var(--reader-accent);
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    font-size: 12px;
    font-weight: 850;
  }

  .bottombar :global(.slider-wrap) {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
    height: 12px;
    cursor: pointer;
  }

  .bottombar :global(.slider-track-bg) {
    position: absolute;
    left: 0;
    right: 0;
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(212, 204, 230, 0.12);
  }

  .bottombar :global(.slider-fill) {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--reader-accent), var(--reader-accent-2));
  }

  .bottombar :global(.slider-input) {
    position: absolute;
    inset: 0;
    z-index: 2;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  .bottombar :global(.slider-checkpoint) {
    position: absolute;
    top: 50%;
    z-index: 1;
    width: 4px;
    height: 12px;
    border-radius: 999px;
    transform: translate(-50%, -50%);
    background: rgba(199, 178, 255, 0.38);
    pointer-events: none;
  }

  .bottombar :global(.bookmark-checkpoint) {
    background: var(--reader-accent);
  }

  .bottombar :global(.slider-tooltip) {
    position: absolute;
    bottom: calc(100% + 2px);
    z-index: 10;
    transform: translateX(-50%);
    padding: 2px 6px;
    border: 1px solid var(--reader-line);
    border-radius: 999px;
    background: rgba(15, 14, 21, 0.96);
    color: var(--reader-muted);
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    font-size: 10px;
    letter-spacing: 0.045em;
    white-space: nowrap;
    pointer-events: none;
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

  @media (max-width: 1180px) {
  }

  @media (max-width: 720px) {
    .topbar,
    .bottombar {
      margin-inline: 0;
      border-radius: 0;
    }

    .topbar :global(.mode-label),
    .topbar :global(.ch-sep),
    .topbar :global(.page-label) {
      display: none;
    }

    .topbar :global(.mode-btn) {
      min-width: 32px;
      padding: 0 8px;
    }
  }
</style>
