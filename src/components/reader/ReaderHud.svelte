<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import type { Snippet } from "svelte";
  import { CaretLeft, CaretRight, BookmarkSimple, PictureInPicture, SlidersHorizontal, Sun } from "phosphor-svelte";
  import { store, updateSettings } from "../../store/state.svelte";
  import { READER_BRIGHTNESS_SETTING_KEY, type ReaderKind } from "../../lib/reader/readerSettingsScope";

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
    /** Selects which reader's brightness this HUD reads and writes. */
    readerKind?: ReaderKind;
    onMouseMove?: (event: MouseEvent) => void;
    onHudMouseEnter?: () => void;
    onHudMouseLeave?: () => void;
    onclose?: () => void;
    onprev?: () => void;
    onnext?: () => void;
    onjump?: (val: number) => void;
    onbookmark?: () => void;
    /** Moves this reader into its own window; the button is shown only when set. */
    ondetach?: () => void;
    toolsOpen?: boolean;
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
    readerKind = "manga",
    onMouseMove = () => {},
    onHudMouseEnter = () => {},
    onHudMouseLeave = () => {},
    onclose = () => {},
    onprev = () => {},
    onnext = () => {},
    onjump = () => {},
    onbookmark = () => {},
    ondetach,
    settingsPopover,
    children,
    toolsOpen = $bindable(false),
  }: Props = $props();

  let brightnessOpen = $state(false);
  const brightnessKey = $derived(READER_BRIGHTNESS_SETTING_KEY[readerKind]);
  const brightness = $derived(store.settings[brightnessKey] ?? 1.0);
  let manualHudVisible: boolean | null = $state(null);
  const effectiveHudVisible = $derived(manualHudVisible ?? uiVisible);

  function toggleHudFromViewport(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const interactive = target.closest("button, input, select, a, .reader-capsule-bar, .reader-settings-popover, .reader-brightness-popover, .reader-back-link");
    if (interactive) {
      return;
    }
    manualHudVisible = !effectiveHudVisible;
    if (manualHudVisible === false) {
      toolsOpen = false;
      brightnessOpen = false;
    }
  }

  function scrollsWithKeyboard(target: EventTarget | null, surface: EventTarget | null) {
    for (let element = target instanceof HTMLElement ? target : null; element && element !== surface; element = element.parentElement) {
      if (element.scrollHeight > element.clientHeight && /(auto|scroll)/.test(getComputedStyle(element).overflowY)) return true;
    }
    return false;
  }

  function toggleHudFromKeyboard(event: KeyboardEvent) {
    if (event.key !== "Enter" && event.key !== " ") return;
    // Space pressed in a scrolling chapter scrolls it instead of toggling the bar.
    if (event.key === " " && scrollsWithKeyboard(event.target, event.currentTarget)) return;
    event.preventDefault();
    manualHudVisible = !effectiveHudVisible;
    if (manualHudVisible === false) {
      toolsOpen = false;
      brightnessOpen = false;
    }
  }
</script>

<div class="root" role="presentation" onmousemove={onMouseMove}>
  <!-- Main Reading Viewport Content -->
  <div
    class="reader-viewport-wrapper"
    style="filter: brightness({brightness});"
    role="button"
    tabindex="-1"
    data-reader-surface
    onclick={toggleHudFromViewport}
    onkeydown={toggleHudFromKeyboard}
  >
    {@render children?.()}
  </div>

  <!-- Floating UI HUD Overlay -->
  <div class="reader-hud-overlay" class:hidden={!effectiveHudVisible}>
    <button class="reader-back-link" onclick={onclose} title={$_("ui_back")}>
      <span class="reader-back-icon" aria-hidden="true">
        <CaretLeft size={14} weight="bold" />
      </span>
      <span>{$_("ui_back")}</span>
    </button>

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
      <div class="reader-settings-popover" role="presentation" onmouseenter={onHudMouseEnter} onmouseleave={onHudMouseLeave}>
        {@render settingsPopover()}
      </div>
    {/if}

    <!-- Brightness Popover Card (Floating above capsule) -->
    {#if brightnessOpen}
      <div class="reader-brightness-popover" role="presentation" onmouseenter={onHudMouseEnter} onmouseleave={onHudMouseLeave}>
        <Sun size={15} weight="regular" style="color: var(--reader-muted);" />
        <input
          type="range"
          class="popover-brightness-input"
          min={0.2}
          max={1.0}
          step={0.05}
          value={brightness}
          oninput={(event) => updateSettings({ [brightnessKey]: Number(event.currentTarget.value) })}
          aria-label={$_("ui_adjustBrightness")}
        />
        <span class="brightness-val-text">{Math.round(brightness * 100)}%</span>
      </div>
    {/if}

    <!-- Bottom Unified Capsule Bar -->
    <div class="reader-capsule-bar" role="presentation" onmouseenter={onHudMouseEnter} onmouseleave={onHudMouseLeave}>
      <!-- 1. Bookmark Toggle -->
      <button class="capsule-btn" class:active={isBookmarked} onclick={onbookmark} title={$_("bookDetail_filter_bookmark")}>
        <BookmarkSimple size={17} weight={isBookmarked ? "fill" : "regular"} />
      </button>

      <!-- 2. Prev Navigation -->
      <button class="capsule-btn" onclick={onprev} disabled={prevDisabled} title={$_("ui_previous")}>
        <CaretLeft size={16} weight="regular" />
      </button>

      <!-- 3. Page Indicator -->
      <span class="capsule-progress-label">{progressLabel}</span>

      <!-- 4. Sleek Progress Seekbar -->
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
          aria-label={$_("ui_seekPageChapter")}
        />
      </div>

      <!-- 5. Next Navigation -->
      <button class="capsule-btn" onclick={onnext} disabled={nextDisabled} title={$_("library_pagination_next")}>
        <CaretRight size={16} weight="regular" />
      </button>

      <!-- 6. Brightness Toggle -->
      <button
        class="capsule-btn"
        class:active={brightnessOpen}
        onclick={() => { brightnessOpen = !brightnessOpen; toolsOpen = false; }}
        title={$_("ui_brightness")}
      >
        <Sun size={17} weight="regular" />
      </button>

      <!-- 7. Settings Cog -->
      <button class="capsule-btn" class:active={toolsOpen} onclick={() => { toolsOpen = !toolsOpen; brightnessOpen = false; }} title={$_("shell_navigation_settings")}>
        <SlidersHorizontal size={17} weight="regular" />
      </button>

      {#if ondetach}
        <!-- 8. Open in a new window -->
        <button class="capsule-btn" onclick={ondetach} title={$_("reader_detach")} aria-label={$_("reader_detach")}>
          <PictureInPicture size={17} weight="regular" />
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .root {
    --reader-void: var(--component-reader-bg);
    --reader-panel: var(--component-reader-panel-bg);
    --reader-panel-hover: var(--component-reader-panel-hover-bg);
    --reader-line: var(--component-reader-border);
    --reader-line-hover: var(--component-reader-border-hover);
    --reader-line-strong: var(--component-reader-panel-strong-bg);
    --reader-line-active: var(--component-reader-border-active);
    --reader-divider: var(--component-reader-divider);
    --reader-text: var(--component-reader-fg);
    --reader-muted: var(--component-reader-muted-fg);
    --reader-faint: var(--component-reader-faint-fg);
    --reader-accent: var(--component-reader-accent-fg);
    --reader-accent-dim: var(--component-reader-accent-muted-bg);
    --reader-accent-bright: var(--component-reader-accent-strong-fg);
    --reader-control-bg: var(--component-reader-control-bg);
    --reader-control-hover-bg: var(--component-reader-control-hover-bg);
    --reader-control-active-bg: var(--component-reader-control-active-bg);
    --reader-track-bg: var(--component-reader-control-track-bg);
    --reader-track-hover-bg: var(--component-reader-control-track-hover-bg);
    --reader-shadow: var(--component-reader-shadow);
    --reader-shadow-compact: var(--component-reader-shadow-compact);
    --reader-inset-highlight: var(--component-reader-inset-highlight);
    --reader-control-shadow: var(--component-reader-control-shadow);
    --reader-blur: var(--component-reader-blur);
    --reader-popover-blur: var(--component-reader-popover-blur);
    --reader-focus-ring: var(--component-reader-focus-ring);
    position: fixed;
    inset: 0;
    z-index: var(--z-reader);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--component-reader-bg-layer);
    color: var(--reader-text);
    font-family: var(--component-reader-font);
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
    z-index: var(--component-reader-chrome-z-index);
    pointer-events: none;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: center;
    padding-bottom: var(--component-reader-overlay-padding-bottom);
    transition: opacity var(--component-reader-transition-fast);
  }

  .reader-hud-overlay.hidden {
    opacity: var(--component-reader-hidden-opacity);
    pointer-events: none;
  }

  .reader-back-link {
    pointer-events: auto;
    position: absolute;
    top: 34px;
    left: 54px;
    display: inline-flex;
    align-items: center;
    gap: 9px;
    border: 1px solid var(--reader-line);
    border-radius: var(--component-reader-pill-radius);
    background: var(--reader-panel);
    color: var(--reader-muted);
    font-family: var(--component-reader-font);
    font-size: 13px;
    font-weight: 650;
    letter-spacing: 0.01em;
    padding: 7px 14px 7px 8px;
    cursor: pointer;
    box-shadow:
      var(--reader-shadow),
      var(--reader-inset-highlight);
    backdrop-filter: var(--reader-blur);
    transition:
      color var(--component-reader-transition-fast),
      background var(--component-reader-transition-fast),
      transform var(--component-reader-transition-fast),
      border-color var(--component-reader-transition-fast);
  }

  .reader-back-link:hover {
    color: var(--reader-text);
    border-color: var(--reader-line-hover);
    background: var(--reader-panel-hover);
    transform: translateX(-1px);
  }

  .reader-back-link:focus-visible,
  .capsule-btn:focus-visible,
  .popover-brightness-input:focus-visible,
  .reader-settings-popover :global(button:focus-visible),
  .reader-settings-popover :global(select:focus-visible),
  .reader-settings-popover :global(input:focus-visible) {
    outline: 0;
    box-shadow: var(--reader-focus-ring);
  }

  .reader-back-link:hover .reader-back-icon {
    color: var(--reader-text);
    border-color: var(--reader-line-hover);
    background: var(--reader-control-hover-bg);
  }

  .reader-back-icon {
    color: var(--reader-muted);
    display: inline-grid;
    place-items: center;
    width: var(--component-reader-icon-button-size);
    height: var(--component-reader-icon-button-size);
    border: 1px solid var(--reader-line);
    border-radius: var(--component-reader-control-radius);
    background: var(--reader-control-bg);
    line-height: 1;
    transition:
      color var(--component-reader-transition-fast),
      background var(--component-reader-transition-fast),
      border-color var(--component-reader-transition-fast);
  }

  /* Series / Chapter Title Overlay (Centered above capsule) */
  .reader-metadata-title {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    background: var(--reader-panel);
    border: 1px solid var(--reader-line);
    border-radius: var(--component-reader-pill-radius);
    padding: 6px 14px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--reader-faint);
    box-shadow: var(--reader-shadow-compact);
    backdrop-filter: var(--reader-popover-blur);
  }

  .reader-metadata-title .series-title {
    color: var(--reader-muted);
  }

  .reader-metadata-title .chapter-title {
    color: var(--reader-text);
    font-weight: 600;
  }

  .reader-metadata-title .metadata-sep {
    color: var(--reader-line-active);
  }

  /* Unified Bottom Capsule Bar */

  .reader-capsule-bar {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: var(--component-reader-capsule-gap);
    width: min(var(--component-reader-capsule-width), calc(100% - 32px));
    height: var(--component-reader-capsule-height);
    background: var(--reader-panel);
    border: 1px solid var(--reader-line);
    border-radius: var(--component-reader-pill-radius);
    padding: 0 var(--component-reader-capsule-padding-x);
    box-shadow:
      var(--reader-shadow),
      var(--reader-inset-highlight);
    backdrop-filter: var(--reader-blur);
  }

  /* Capsule Buttons */
  .capsule-btn {
    display: inline-grid;
    place-items: center;
    width: var(--component-reader-button-size);
    height: var(--component-reader-button-size);
    border: 1px solid var(--reader-line);
    border-radius: var(--component-reader-control-radius);
    color: var(--reader-muted);
    background: var(--reader-control-bg);
    cursor: pointer;
    flex-shrink: 0;
    transition:
      color var(--component-reader-transition-fast),
      border-color var(--component-reader-transition-fast),
      background var(--component-reader-transition-fast),
      transform var(--component-reader-transition-fast);
  }

  .capsule-btn:hover:not(:disabled) {
    color: var(--reader-text);
    border-color: var(--reader-line-hover);
    background: var(--reader-control-hover-bg);
    transform: translateY(-1px);
  }

  .capsule-btn.active {
    color: var(--reader-text);
    background: var(--reader-control-active-bg);
    border-color: var(--reader-line-active);
  }

  .capsule-btn:disabled {
    opacity: var(--component-reader-disabled-opacity);
    cursor: default;
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

  /* Brightness Popover (Floating above capsule) */
  .reader-brightness-popover {
    pointer-events: auto;
    position: absolute;
    bottom: 76px;
    right: 16px;
    z-index: var(--component-reader-popover-z-index);
    width: 180px;
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--reader-panel);
    border: 1px solid var(--reader-line);
    border-radius: var(--component-reader-pill-radius);
    padding: 8px 12px;
    box-shadow:
      var(--reader-shadow),
      var(--reader-inset-highlight);
    backdrop-filter: var(--reader-popover-blur);
    animation: popoverIn var(--component-reader-transition-popover) both;
  }

  @media (min-width: 1120px) {
    .reader-brightness-popover {
      right: auto;
      left: calc(50% + 160px);
    }
  }

  .popover-brightness-input {
    flex: 1;
    height: var(--component-reader-range-track-height);
    border-radius: var(--component-reader-pill-radius);
    background: var(--reader-track-bg);
    outline: none;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
    transition: background var(--component-reader-transition-fast);
  }

  .popover-brightness-input:hover {
    background: var(--reader-track-hover-bg);
  }

  .popover-brightness-input::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: var(--component-reader-range-thumb-size);
    height: var(--component-reader-range-thumb-size);
    border-radius: var(--component-reader-control-radius);
    background: var(--reader-text);
    cursor: pointer;
    box-shadow: var(--reader-control-shadow);
    transition: transform var(--component-reader-transition-fast);
  }

  .popover-brightness-input::-webkit-slider-thumb:hover {
    transform: scale(1.25);
  }

  .brightness-val-text {
    font-size: 11px;
    font-weight: 600;
    color: var(--reader-text);
    min-width: 32px;
    text-align: right;
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
    height: var(--component-reader-range-track-height);
    border-radius: var(--component-reader-pill-radius);
    background: var(--reader-divider);
    overflow: hidden;
  }

  .capsule-slider-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--component-reader-accent-gradient);
  }

  .capsule-slider-input {
    position: absolute;
    inset: 0;
    z-index: var(--component-reader-slider-input-z-index);
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  .capsule-slider-checkpoint {
    position: absolute;
    top: 50%;
    z-index: var(--component-reader-slider-checkpoint-z-index);
    width: var(--component-reader-checkpoint-width);
    height: var(--component-reader-checkpoint-height);
    border-radius: var(--component-reader-pill-radius);
    transform: translate(-50%, -50%);
    background: var(--reader-accent-bright);
    pointer-events: none;
  }

  /* Configuration Popover Card */
  .reader-settings-popover {
    pointer-events: auto;
    position: absolute;
    bottom: 88px;
    right: 22px;
    z-index: var(--component-reader-popover-z-index);
    width: min(276px, calc(100vw - 32px));
    max-height: calc(100vh - 120px);
    overflow-y: auto;
    background: var(--reader-panel);
    border: 1px solid var(--reader-line);
    border-radius: var(--component-reader-popover-radius);
    padding: 10px 12px;
    box-shadow:
      var(--reader-shadow),
      var(--reader-inset-highlight);
    backdrop-filter: var(--reader-blur);
    animation: popoverIn var(--component-reader-transition-popover) both;
  }

  @media (min-width: 1120px) {
    .reader-settings-popover {
      right: auto;
      left: calc(50% + 258px);
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
    gap: 8px;
  }

  .reader-settings-popover :global(dl > div) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 28px;
    border-top: 1px solid var(--reader-divider);
    padding-top: 8px;
  }

  .reader-settings-popover :global(dl > div:first-child) {
    border-top: 0;
    padding-top: 0;
  }

  .reader-settings-popover :global(dt) {
    font-size: 12px;
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
    background: var(--reader-control-bg);
    border: 1px solid var(--reader-line);
    border-radius: var(--component-reader-toggle-radius);
    padding: 1.5px;
    overflow: hidden;
  }

  .reader-settings-popover :global(.popover-segment) {
    border: 0;
    background: transparent;
    color: var(--reader-muted);
    font-size: 11px;
    font-weight: 500;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition:
      color var(--component-reader-transition-fast),
      background var(--component-reader-transition-fast);
  }

  .reader-settings-popover :global(.popover-segment:hover) {
    color: var(--reader-text);
    background: var(--reader-control-hover-bg);
  }

  .reader-settings-popover :global(.popover-segment.active) {
    color: var(--reader-text);
    background: var(--reader-control-active-bg);
    border: 1px solid var(--reader-line-active);
  }

  .reader-settings-popover :global(.popover-btn) {
    border: 1px solid var(--reader-line);
    background: var(--reader-control-bg);
    color: var(--reader-text);
    font-size: 11px;
    font-weight: 500;
    padding: 4px 8px;
    border-radius: var(--component-reader-toggle-radius);
    cursor: pointer;
    transition:
      color var(--component-reader-transition-fast),
      border-color var(--component-reader-transition-fast),
      background var(--component-reader-transition-fast);
  }

  .reader-settings-popover :global(.popover-btn:hover:not(:disabled)) {
    color: var(--reader-text);
    border-color: var(--reader-line-hover);
    background: var(--reader-control-hover-bg);
  }

  .reader-settings-popover :global(.popover-btn.active) {
    border-color: var(--reader-accent);
    background: var(--reader-accent-dim);
    color: var(--reader-accent-bright);
  }

  .reader-settings-popover :global(.popover-btn:disabled) {
    opacity: 0.3;
    cursor: default;
  }

  .reader-settings-popover :global(.popover-select) {
    border: 1px solid var(--reader-line);
    background: var(--reader-control-bg);
    color: var(--reader-text);
    font-size: 11px;
    font-weight: 500;
    padding: 4px 6px;
    border-radius: var(--component-reader-toggle-radius);
    outline: none;
    max-width: 140px;
  }

  .reader-settings-popover :global(.popover-stepper) {
    display: flex;
    align-items: center;
    border: 1px solid var(--reader-line);
    border-radius: var(--component-reader-toggle-radius);
    overflow: hidden;
    background: var(--reader-control-bg);
  }

  .reader-settings-popover :global(.popover-step-btn) {
    border: 0;
    background: var(--reader-control-bg);
    color: var(--reader-text);
    width: 24px;
    height: 24px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    display: grid;
    place-items: center;
  }

  .reader-settings-popover :global(.popover-step-btn:hover:not(:disabled)) {
    background: var(--reader-control-hover-bg);
    color: var(--reader-text);
  }

  .reader-settings-popover :global(.popover-step-btn:disabled) {
    opacity: 0.25;
  }

  .reader-settings-popover :global(.popover-step-val) {
    font-size: 11px;
    font-weight: 500;
    color: var(--reader-text);
    min-width: 44px;
    text-align: center;
    border-inline: 1px solid var(--reader-line);
    line-height: 24px;
  }

  .reader-settings-popover :global(.popover-color-swatches) {
    display: flex;
    gap: 5px;
  }

  .reader-settings-popover :global(.popover-swatch) {
    width: 18px;
    height: 18px;
    border-radius: var(--component-reader-control-radius);
    border: 1px solid var(--reader-line-hover);
    cursor: pointer;
    padding: 0;
    transition: transform 120ms;
  }

  .reader-settings-popover :global(.popover-swatch:hover) {
    transform: scale(1.2);
  }

  .reader-settings-popover :global(.popover-swatch.active) {
    border: 2px solid var(--reader-text);
    transform: scale(1.15);
  }

  .reader-settings-popover :global(.popover-color-picker) {
    width: 20px;
    height: 20px;
    border: 1px solid var(--reader-line-active);
    padding: 0;
    background: transparent;
    cursor: pointer;
    border-radius: var(--component-reader-control-radius);
    overflow: hidden;
  }

  .reader-settings-popover :global(.popover-toggle) {
    width: 32px;
    height: 18px;
    border-radius: var(--component-reader-control-radius);
    border: 1px solid var(--reader-line-active);
    background: var(--reader-control-bg);
    position: relative;
    cursor: pointer;
    padding: 0;
    transition:
      background-color var(--component-reader-transition-fast),
      border-color var(--component-reader-transition-fast);
  }

  .reader-settings-popover :global(.popover-toggle::after) {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: var(--component-reader-control-radius);
    background: var(--reader-muted);
    transition:
      transform var(--component-reader-transition-fast),
      background-color var(--component-reader-transition-fast);
  }

  .reader-settings-popover :global(.popover-toggle.active) {
    background-color: var(--reader-control-active-bg);
    border-color: var(--reader-line-active);
  }

  .reader-settings-popover :global(.popover-toggle.active::after) {
    transform: translateX(14px);
    background-color: var(--reader-text);
  }

  .reader-settings-popover :global(.popover-tts-row) {
    cursor: pointer;
    transition:
      background var(--component-reader-transition-fast),
      color var(--component-reader-transition-fast);
    border-radius: var(--component-reader-toggle-radius);
    padding: 5px 7px;
    margin: 0 -7px;
  }

  .reader-settings-popover :global(.popover-tts-row dt) {
    color: var(--reader-text);
  }

  .reader-settings-popover :global(.popover-tts-row dd) {
    color: var(--reader-muted);
    font-size: 12px;
    font-weight: 500;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    justify-items: end;
    align-items: center;
    column-gap: 6px;
    min-width: 118px;
    text-align: right;
  }

  .reader-settings-popover :global(.popover-tts-row:hover) {
    background: var(--reader-control-hover-bg);
  }

  .reader-settings-popover :global(.popover-chevron) {
    color: var(--reader-accent-bright);
    font-size: 11px;
    font-weight: 800;
    line-height: 1;
  }

  .reader-settings-popover :global(.popover-tts-row:focus-visible) {
    outline: 0;
    box-shadow: var(--reader-focus-ring);
    outline-offset: 2px;
  }
</style>
