<script lang="ts">
  import type { Snippet } from "svelte";
  import { X, CaretLeft, CaretRight, BookmarkSimple, SlidersHorizontal } from "phosphor-svelte";
  import { store } from "../../store/state.svelte";

  type Props = {
    title?: string;
    chapterTitle?: string;
    progressLabel?: string;
    sliderValue?: number;
    sliderMax?: number;
    sliderPct?: number;
    bookmarkPct?: number | null;
    isBookmarked?: boolean;
    prevDisabled?: boolean;
    nextDisabled?: boolean;
    uiVisible?: boolean;
    rtl?: boolean;
    onMouseMove?: (event: MouseEvent) => void;
    onclose?: () => void;
    onprev?: () => void;
    onnext?: () => void;
    onjump?: (val: number) => void;
    onbookmark?: () => void;
    settingsPopover?: Snippet;
    children?: Snippet;
  };

  let {
    title = "",
    chapterTitle = "",
    progressLabel = "",
    sliderValue = 1,
    sliderMax = 1,
    sliderPct = 0,
    bookmarkPct = null,
    isBookmarked = false,
    prevDisabled = false,
    nextDisabled = false,
    uiVisible = true,
    rtl = false,
    onMouseMove = () => {},
    onclose = () => {},
    onprev = () => {},
    onnext = () => {},
    onjump = () => {},
    onbookmark = () => {},
    settingsPopover,
    children,
    toolsOpen = $bindable(false),
  }: Props = $props();
</script>

<div class="root" role="presentation" onmousemove={onMouseMove}>
  <!-- Main Reading Viewport Content -->
  <div class="reader-viewport-wrapper" style="filter: brightness({store.settings.readerBrightness ?? 1.0});">
    {@render children?.()}
  </div>

  <!-- Floating UI HUD Overlay -->
  <div class="reader-hud-overlay" class:hidden={!uiVisible}>
    <!-- Series / Chapter Title Metadata (Centered above capsule) -->
    {#if title || chapterTitle}
      <div class="reader-metadata-title">
        <span class="series-title">{title}</span>
        {#if title && chapterTitle}
          <span class="metadata-sep">—</span>
        {/if}
        <span class="chapter-title">{chapterTitle}</span>
      </div>
    {/if}

    <!-- Configuration Popover Card (Centered above capsule) -->
    {#if toolsOpen && settingsPopover}
      <div class="reader-settings-popover">
        {@render settingsPopover()}
      </div>
    {/if}

    <!-- Bottom Unified Capsule Bar -->
    <div class="reader-capsule-bar">
      <!-- 1. Close/Exit -->
      <button class="capsule-btn" onclick={onclose} title="Close reader">
        <X size={17} weight="regular" />
      </button>

      <!-- 2. Page Indicator -->
      <span class="capsule-progress-label">{progressLabel}</span>

      <!-- 3. Sleek Progress Seekbar -->
      <div class="capsule-slider-wrap">
        <div class="capsule-slider-track">
          <div class="capsule-slider-fill" style="width: {rtl ? 100 - sliderPct : sliderPct}%"></div>
        </div>
        {#if bookmarkPct !== null && bookmarkPct !== undefined}
          <div class="capsule-slider-checkpoint" style="left: {rtl ? 100 - bookmarkPct : bookmarkPct}%"></div>
        {/if}
        <input
          type="range"
          class="capsule-slider-input"
          min={1}
          max={sliderMax}
          step={1}
          value={sliderValue}
          dir={rtl ? "rtl" : "ltr"}
          oninput={(event) => onjump(Number(event.currentTarget.value))}
          aria-label="Seek page/chapter"
        />
      </div>

      <!-- 4. Navigation Arrows -->
      <button class="capsule-btn" onclick={onprev} disabled={prevDisabled} title="Previous">
        <CaretLeft size={16} weight="regular" />
      </button>
      <button class="capsule-btn" onclick={onnext} disabled={nextDisabled} title="Next">
        <CaretRight size={16} weight="regular" />
      </button>

      <!-- 5. Bookmark Toggle -->
      <button class="capsule-btn" class:active={isBookmarked} onclick={onbookmark} title="Bookmark">
        <BookmarkSimple size={17} weight={isBookmarked ? "fill" : "regular"} />
      </button>

      <!-- 6. Settings Cog -->
      <button class="capsule-btn" class:active={toolsOpen} onclick={() => toolsOpen = !toolsOpen} title="Settings">
        <SlidersHorizontal size={17} weight="regular" />
      </button>
    </div>
  </div>
</div>

<style>
  .root {
    --reader-void: #050505;
    --reader-panel: #131316;
    --reader-line: #282830;
    --reader-line-strong: #383842;
    --reader-text: #f5f4fa;
    --reader-muted: #b9b5cc;
    --reader-faint: #918da5;
    --reader-accent: #8f82e6;
    --reader-accent-dim: #2c2547;
    --reader-accent-bright: #ab9fff;
    position: fixed;
    inset: 0;
    z-index: var(--z-reader);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: radial-gradient(circle at top center, rgba(255, 255, 255, 0.015), transparent 45%), linear-gradient(180deg, #0a0a0c 0%, #050506 100%);
    color: var(--reader-text);
    font-family: Manrope, Inter, "Segoe UI", sans-serif;
    transform: translateZ(0);
  }

  .reader-viewport-wrapper {
    flex: 1;
    min-height: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .reader-hud-overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: center;
    padding-bottom: 24px;
    transition: opacity 220ms ease;
  }

  .reader-hud-overlay.hidden {
    opacity: 0;
    pointer-events: none;
  }

  /* Series / Chapter Title Overlay (Centered above capsule) */
  .reader-metadata-title {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    background: rgba(10, 10, 14, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 9999px;
    padding: 6px 14px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--reader-faint);
    box-shadow: 
      0 4px 16px rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(8px);
  }

  .reader-metadata-title .series-title {
    color: var(--reader-muted);
  }

  .reader-metadata-title .chapter-title {
    color: var(--reader-text);
    font-weight: 600;
  }

  .reader-metadata-title .metadata-sep {
    color: rgba(255, 255, 255, 0.2);
  }

  /* Unified Bottom Capsule Bar */
  .reader-capsule-bar {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 12px;
    width: min(600px, calc(100% - 32px));
    height: 52px;
    background: rgba(26, 26, 30, 0.97);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 9999px;
    padding: 0 12px;
    box-shadow:
      0 12px 32px rgba(0, 0, 0, 0.5),
      inset 0 1px 0 rgba(255, 255, 255, 0.03);
    backdrop-filter: blur(20px) saturate(140%);
  }

  /* Capsule Buttons */
  .capsule-btn {
    display: inline-grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 9999px;
    color: var(--reader-muted);
    background: rgba(255, 255, 255, 0.02);
    cursor: pointer;
    flex-shrink: 0;
    transition:
      color 150ms ease,
      border-color 150ms ease,
      background 150ms ease,
      transform 150ms ease;
  }

  .capsule-btn:hover:not(:disabled) {
    color: var(--reader-text);
    border-color: rgba(255, 255, 255, 0.15);
    background: rgba(255, 255, 255, 0.06);
    transform: translateY(-1px);
  }

  .capsule-btn.active {
    color: var(--reader-text);
    background: var(--reader-line-strong);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .capsule-btn:disabled {
    opacity: 0.22;
    cursor: default;
    border-color: transparent;
  }

  /* Progress Label */
  .capsule-progress-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--reader-muted);
    letter-spacing: 0.05em;
    min-width: 50px;
    text-align: center;
    white-space: nowrap;
  }

  /* Sleek Progress Seekbar */
  .capsule-slider-wrap {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
    height: 100%;
    cursor: pointer;
  }

  .capsule-slider-track {
    position: absolute;
    left: 0;
    right: 0;
    height: 4px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    overflow: hidden;
  }

  .capsule-slider-fill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--reader-accent), var(--reader-accent-bright));
  }

  .capsule-slider-input {
    position: absolute;
    inset: 0;
    z-index: 2;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  .capsule-slider-checkpoint {
    position: absolute;
    top: 50%;
    z-index: 1;
    width: 4px;
    height: 12px;
    border-radius: 999px;
    transform: translate(-50%, -50%);
    background: var(--reader-accent-bright);
    pointer-events: none;
  }

  /* Configuration Popover Card */
  .reader-settings-popover {
    pointer-events: auto;
    position: absolute;
    bottom: 76px;
    right: 16px;
    z-index: 100;
    width: min(270px, calc(100vw - 32px));
    max-height: calc(100vh - 120px);
    overflow-y: auto;
    background: rgba(26, 26, 30, 0.97);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 12px;
    padding: 10px 12px;
    box-shadow:
      0 12px 32px rgba(0, 0, 0, 0.5),
      inset 0 1px 0 rgba(255, 255, 255, 0.02);
    backdrop-filter: blur(20px) saturate(140%);
    animation: popoverIn 180ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @media (min-width: 1040px) {
    .reader-settings-popover {
      right: auto;
      left: calc(50% + 250px);
    }
  }

  @keyframes popoverIn {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  /* Universal Popover styling details for slots */
  .reader-settings-popover :global(dl) {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .reader-settings-popover :global(dl > div) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 24px;
    border-top: 1px solid rgba(255, 255, 255, 0.025);
    padding-top: 6px;
  }

  .reader-settings-popover :global(dl > div:first-child) {
    border-top: 0;
    padding-top: 0;
  }

  .reader-settings-popover :global(dt) {
    font-size: 10px;
    font-weight: 500;
    color: var(--reader-muted);
    letter-spacing: 0.02em;
  }

  .reader-settings-popover :global(dd) {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .reader-settings-popover :global(.popover-segmented) {
    display: flex;
    background: rgba(0, 0, 0, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 5px;
    padding: 1.5px;
    overflow: hidden;
  }

  .reader-settings-popover :global(.popover-segment) {
    border: 0;
    background: transparent;
    color: var(--reader-muted);
    font-size: 9.5px;
    font-weight: 500;
    padding: 3px 6px;
    border-radius: 3px;
    cursor: pointer;
    transition: color 150ms, background 150ms;
  }

  .reader-settings-popover :global(.popover-segment:hover) {
    color: var(--reader-text);
    background: rgba(255, 255, 255, 0.06);
  }

  .reader-settings-popover :global(.popover-segment.active) {
    color: var(--reader-text);
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .reader-settings-popover :global(.popover-btn) {
    border: 1px solid rgba(255, 255, 255, 0.05);
    background: rgba(0, 0, 0, 0.45);
    color: var(--reader-text);
    font-size: 9.5px;
    font-weight: 500;
    padding: 3px 6px;
    border-radius: 4px;
    cursor: pointer;
    transition: color 150ms, border-color 150ms, background 150ms;
  }

  .reader-settings-popover :global(.popover-btn:hover:not(:disabled)) {
    color: var(--reader-text);
    border-color: rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.06);
  }

  .reader-settings-popover :global(.popover-btn:disabled) {
    opacity: 0.3;
    cursor: default;
  }

  .reader-settings-popover :global(.popover-select) {
    border: 1px solid rgba(255, 255, 255, 0.05);
    background: rgba(0, 0, 0, 0.45);
    color: var(--reader-text);
    font-size: 9.5px;
    font-weight: 500;
    padding: 3px 5px;
    border-radius: 4px;
    outline: none;
    max-width: 130px;
  }

  .reader-settings-popover :global(.popover-stepper) {
    display: flex;
    align-items: center;
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 4px;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.45);
  }

  .reader-settings-popover :global(.popover-step-btn) {
    border: 0;
    background: rgba(255, 255, 255, 0.03);
    color: var(--reader-text);
    width: 20px;
    height: 20px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    display: grid;
    place-items: center;
  }

  .reader-settings-popover :global(.popover-step-btn:hover:not(:disabled)) {
    background: rgba(255, 255, 255, 0.06);
    color: var(--reader-text);
  }

  .reader-settings-popover :global(.popover-step-btn:disabled) {
    opacity: 0.25;
  }

  .reader-settings-popover :global(.popover-step-val) {
    font-size: 9.5px;
    font-weight: 500;
    color: var(--reader-text);
    min-width: 36px;
    text-align: center;
    border-inline: 1px solid rgba(255, 255, 255, 0.05);
    line-height: 20px;
  }

  .reader-settings-popover :global(.popover-color-swatches) {
    display: flex;
    gap: 5px;
  }

  .reader-settings-popover :global(.popover-swatch) {
    width: 16px;
    height: 16px;
    border-radius: 9999px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    cursor: pointer;
    padding: 0;
    transition: transform 120ms;
  }

  .reader-settings-popover :global(.popover-swatch:hover) {
    transform: scale(1.2);
  }

  .reader-settings-popover :global(.popover-swatch.active) {
    border: 2px solid rgba(255, 255, 255, 0.6);
    transform: scale(1.15);
  }

  .reader-settings-popover :global(.popover-color-picker) {
    width: 18px;
    height: 18px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    padding: 0;
    background: transparent;
    cursor: pointer;
    border-radius: 9999px;
    overflow: hidden;
  }

  .reader-settings-popover :global(.popover-toggle) {
    width: 28px;
    height: 15px;
    border-radius: 9999px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: rgba(0, 0, 0, 0.45);
    position: relative;
    cursor: pointer;
    padding: 0;
    transition: background-color 150ms, border-color 150ms;
  }

  .reader-settings-popover :global(.popover-toggle::after) {
    content: "";
    position: absolute;
    top: 1.5px;
    left: 1.5px;
    width: 10px;
    height: 10px;
    border-radius: 9999px;
    background: var(--reader-muted);
    transition: transform 150ms, background-color 150ms;
  }

  .reader-settings-popover :global(.popover-toggle.active) {
    background-color: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.3);
  }

  .reader-settings-popover :global(.popover-toggle.active::after) {
    transform: translateX(13px);
    background-color: rgba(255, 255, 255, 0.85);
  }
</style>
