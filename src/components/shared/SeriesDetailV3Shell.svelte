<script lang="ts">
  import { _, translate } from "../../lib/i18n/runtime";
  import { onMount, type Snippet } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { ArrowLeft, BookOpen, Info } from "phosphor-svelte";
  import { SERVER_READY_EVENT } from "../../lib/serverLifecycle";
  import WindowControlsInline from "../layout/WindowControlsInline.svelte";

  type SeriesDetailMetric = {
    label: string;
    value: string;
  };

  type Props = {
    mediaKind: "manga" | "novel";
    title: string;
    subtitle?: string | null;
    coverUrl?: string | null;
    fallbackLabel?: string;
    statusLabel?: string | null;
    sourceLabel?: string | null;
    sourceLine?: string | null;
    languageLabel?: string | null;
    description?: string | null;
    tags?: string[];
    metrics?: SeriesDetailMetric[];
    progressLabel?: string | null;
    progressPercent?: number;
    detailsOpen?: boolean;
    loading?: boolean;
    emptyDetailsLabel?: string;
    onBack?: () => void;
    onTagClick?: (tag: string) => void;
    onDetailsToggle?: () => void;
    topbarActions?: Snippet;
    primaryAction?: Snippet;
    secondaryActions?: Snippet;
    utilityActions?: Snippet;
    detailsExtra?: Snippet;
    chapterControls?: Snippet;
    chapterList?: Snippet;
    chapterFooter?: Snippet;
  };

  let {
    mediaKind,
    title,
    subtitle = null,
    coverUrl = null,
    fallbackLabel = translate("home_metrics_series"),
    statusLabel = null,
    sourceLabel = null,
    sourceLine = null,
    languageLabel = null,
    description = null,
    tags = [],
    metrics = [],
    progressLabel = null,
    progressPercent = 0,
    detailsOpen = false,
    loading = false,
    emptyDetailsLabel = translate("detail_noExtraDetails"),
    onBack = () => {},
    onTagClick = () => {},
    onDetailsToggle = () => {},
    topbarActions,
    primaryAction,
    secondaryActions,
    utilityActions,
    detailsExtra,
    chapterControls,
    chapterList,
    chapterFooter,
  }: Props = $props();

  function hasRealText(value: string | null | undefined) {
    if (!value?.trim()) return false;
    return !/^(unknown|source|source novel|manga series|untitled)$/i.test(value.trim());
  }

  const interactiveSelector =
    "button, a, input, select, textarea, label, [role='button'], [role='menuitem'], [role='menuitemradio'], [contenteditable='true'], .n-icon-btn, [data-no-window-drag]";

  function handleTopbarPointerDown(event: PointerEvent) {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target.closest(interactiveSelector)) return;
    getCurrentWindow().startDragging().catch(() => {});
  }

  const clampedProgress = $derived(Math.max(0, Math.min(100, progressPercent)));
  let failedCoverUrl: string | null = $state(null);
  let lastResolvedCoverUrl: string | null = $state(null);
  const resolvedCoverUrl = $derived(coverUrl?.trim() || null);
  const canShowCover = $derived(Boolean(resolvedCoverUrl && failedCoverUrl !== resolvedCoverUrl));
  const visibleTags = $derived.by(() => {
    const values = [statusLabel, ...tags].filter((value): value is string => hasRealText(value));
    return [...new Set(values.map((value) => value.trim()))].slice(0, 12);
  });
  const titleText = $derived(title?.trim() || $_("ui_untitled"));
  const subtitleText = $derived(hasRealText(subtitle) ? subtitle!.trim() : null);
  const sourceNameText = $derived(hasRealText(sourceLabel) ? sourceLabel!.trim() : hasRealText(languageLabel) ? languageLabel!.trim() : null);
  const sourceLineText = $derived(hasRealText(sourceLine) ? sourceLine!.trim() : sourceNameText ? $_("detail_kindSourceLine", { kind: mediaKind === "novel" ? $_("ui_novel") : $_("ui_manga"), source: sourceNameText }) : null);

  $effect(() => {
    const current = resolvedCoverUrl;
    if (current === lastResolvedCoverUrl) return;
    lastResolvedCoverUrl = current;
    failedCoverUrl = null;
  });

  onMount(() => {
    const retryCover = () => {
      if (resolvedCoverUrl && failedCoverUrl === resolvedCoverUrl) failedCoverUrl = null;
    };
    window.addEventListener(SERVER_READY_EVENT, retryCover);
    return () => window.removeEventListener(SERVER_READY_EVENT, retryCover);
  });
</script>

<div class="series-v3-root" data-media-kind={mediaKind}>
  <!-- svelte-ignore a11y_no_static_element_interactions: desktop window drag must start from empty detail topbar regions. -->
  <header class="n-topbar" data-tauri-drag-region onpointerdown={handleTopbarPointerDown}>
    <div class="n-topbar-left">
      <button class="n-icon-btn" type="button" title={$_("ui_back")} onclick={onBack}>
        <ArrowLeft size={17} weight="light" />
      </button>
      <div class="crumbs">
        <span>{$_("library_error_eyebrow")}</span>
        <span class="crumb-sep">/</span>
        <strong>{titleText}</strong>
      </div>
    </div>
    <div class="n-topbar-right">
      {@render topbarActions?.()}
      <WindowControlsInline />
    </div>
  </header>

  <div class="scroll-surface">
    <section class="hero">
      {#if canShowCover}
        <div class="hero-backdrop" style={`background-image: url("${resolvedCoverUrl}")`}></div>
      {:else}
        <div class="hero-backdrop hero-backdrop--empty"></div>
      {/if}

      <div class="hero-content">
        <div class="cover-frame">
          {#if canShowCover}
            <img
              class="cover"
              src={resolvedCoverUrl}
              alt={titleText}
              loading="eager"
              decoding="async"
              onerror={() => { failedCoverUrl = resolvedCoverUrl; }}
            />
          {:else}
            <div class="cover-fallback">
              <BookOpen size={38} weight="duotone" />
              <span>{fallbackLabel}</span>
            </div>
          {/if}
        </div>

        <div class="hero-meta">
          {#if sourceLineText}
            <p class="source-line">{sourceLineText}</p>
          {/if}

          {#if loading}
            <div class="skeleton-title"></div>
            <div class="skeleton-line"></div>
          {:else}
            <h1>{titleText}</h1>
            {#if subtitleText}
              <p class="subtitle">{subtitleText}</p>
            {/if}
          {/if}

          {#if visibleTags.length}
            <div class="tags">
              {#each visibleTags as tag, index}
                <button class="tag" class:tag-strong={index === 0} type="button" onclick={() => onTagClick(tag)}>{tag}</button>
              {/each}
            </div>
          {/if}

          {#if description}
            <p class="description">{description}</p>
          {/if}

          <div class="metric-strip">
            {#each metrics as metric}
              <div class="metric">
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
              </div>
            {/each}
          </div>

          {#if progressLabel}
            <div class="progress-block" aria-label={progressLabel}>
              <div class="progress-head">
                <span>{progressLabel}</span>
                <strong>{Math.round(clampedProgress)}%</strong>
              </div>
              <div class="progress-track">
                <div class="progress-fill" style={`width: ${clampedProgress}%`}></div>
              </div>
            </div>
          {/if}
        </div>
      </div>
    </section>

    <section class="action-band">
      <div class="action-left">
        <div class="primary-slot">
          {@render primaryAction?.()}
        </div>
        <div class="secondary-slot">
          {@render secondaryActions?.()}
        </div>
        <button class="details-toggle" type="button" class:is-open={detailsOpen} onclick={onDetailsToggle} title={$_("ui_seriesDetails")} aria-label={$_("ui_seriesDetails")}>
          <Info size={16} weight={detailsOpen ? "fill" : "light"} />
        </button>
      </div>
      <div class="utility-slot">
        {@render utilityActions?.()}
      </div>
    </section>

    {#if detailsOpen}
      <section class="details-drawer">
        <div class="detail-card detail-card-main">
          <span class="detail-label">{$_("ui_synopsis")}</span>
          <p>{description || emptyDetailsLabel}</p>
        </div>
        <div class="detail-card">
          {@render detailsExtra?.()}
        </div>
      </section>
    {/if}

    <section class="chapters-panel">
      <div class="chapter-toolbar">
        {@render chapterControls?.()}
      </div>
      <div class="chapter-body">
        {@render chapterList?.()}
      </div>
      {@render chapterFooter?.()}
    </section>
  </div>
</div>

<style>
  .series-v3-root {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    --series-bg: var(--component-detail-bg);
    --series-bg-top: var(--component-detail-bg-top);
    --series-surface-lowest: var(--component-detail-surface-lowest);
    --series-surface-low: var(--component-detail-surface-low);
    --series-surface: var(--component-detail-surface);
    --series-surface-high: var(--component-detail-surface-high);
    --series-outline: var(--component-detail-outline);
    --series-text: var(--component-detail-text);
    --series-muted: var(--component-detail-muted);
    --series-muted-soft: var(--component-detail-muted-soft);
    --series-muted-faint: var(--component-detail-muted-faint);
    --series-primary: var(--component-detail-primary);
    --series-primary-strong: var(--component-detail-primary-strong);
    --series-primary-container: var(--component-detail-primary-container);
    --series-on-primary: var(--component-detail-on-primary);
    --series-primary-soft: var(--component-detail-primary-soft);
    --series-primary-border: var(--component-detail-primary-border);
    --series-line: var(--component-detail-line);
    color: var(--series-text);
    font-family: var(--component-detail-series-v3-root-font-family);
    background: var(--component-detail-series-v3-root-background);
    animation: fadeIn 0.14s ease both;
  }

  .n-topbar {
    position: sticky;
    top: 0;
    z-index: var(--component-detail-n-topbar-z-index);
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: var(--component-detail-topbar-height);
    padding: 0 28px;
    border-bottom: 1px solid transparent;
    border-image: var(--component-detail-n-topbar-border-image);
    background: var(--component-detail-n-topbar-background);
    backdrop-filter: var(--component-detail-n-topbar-blur);
    box-shadow: var(--component-detail-n-topbar-box-shadow);
    -webkit-app-region: drag;
  }

  .n-topbar::before {
    position: absolute;
    inset: 0;
    content: "";
    pointer-events: none;
    background: var(--component-detail-n-topbar-background-2);
  }

  .n-topbar > * {
    position: relative;
    z-index: var(--component-detail-n-topbar-z-index-2);
  }

  .n-topbar-left,
  .n-topbar-right,
  .crumbs {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .n-topbar-right {
    justify-content: flex-end;
    gap: 6px;
  }

  .series-v3-root .n-topbar-right :global(.series-icon) {
    width: var(--component-detail-hud-control-size) !important;
    height: var(--component-detail-hud-control-size);
    min-height: var(--component-detail-hud-control-size);
    padding: 0 !important;
    border-radius: var(--component-detail-series-v3-root-n-topbar-right-series-icon-border-radius) !important;
  }

  .series-v3-root .n-topbar-right :global(.series-icon svg) {
    width: var(--component-detail-hud-icon-size);
    height: var(--component-detail-hud-icon-size);
  }

  .n-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: var(--component-detail-n-icon-btn-border-radius);
    color: var(--series-muted-soft);
    background: transparent;
    cursor: pointer;
    transition: color 140ms ease, border-color 140ms ease, background 140ms ease, transform 160ms ease, box-shadow 160ms ease;
    -webkit-app-region: no-drag;
  }

  .n-icon-btn:hover {
    color: var(--series-text);
    background: var(--component-detail-n-icon-btn-background);
    transform: none;
    box-shadow: none;
  }

  .n-icon-btn:active {
    transform: translateY(0) scale(0.96);
  }

  .crumbs {
    max-width: min(52vw, 560px);
    color: var(--series-muted-soft);
    font-size: 13px;
    letter-spacing: 0.02em;
  }

  .crumbs strong {
    min-width: 0;
    overflow: hidden;
    color: var(--series-text);
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .crumb-sep {
    opacity: var(--component-detail-crumb-sep-opacity);
  }

  .scroll-surface {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    background: var(--component-detail-scroll-surface-background);
  }

  .hero {
    position: relative;
    overflow: hidden;
    padding: 28px 40px 24px;
    background: var(--component-detail-hero-background);
    box-shadow: var(--component-detail-hero-box-shadow);
  }

  .hero-backdrop {
    position: absolute;
    inset: 0;
    z-index: var(--component-detail-hero-backdrop-z-index);
    background-position: center 20%;
    background-size: cover;
    opacity: var(--component-detail-hero-backdrop-opacity);
    filter: blur(52px) brightness(0.42) saturate(1.15);
    transform: scale(1.25);
  }

  .hero-backdrop::after {
    position: absolute;
    inset: 0;
    content: "";
    background: var(--component-detail-hero-backdrop-background);
  }

  .hero-backdrop--empty {
    background: var(--component-detail-hero-backdrop-empty-background);
    filter: none;
    transform: none;
  }

  .hero-content {
    position: relative;
    z-index: var(--component-detail-hero-content-z-index);
    display: grid;
    grid-template-columns: 176px minmax(0, 1fr);
    gap: 32px;
    align-items: flex-start;
    max-width: 980px;
  }

  .cover-frame {
    aspect-ratio: 2 / 3;
    overflow: hidden;
    border: var(--component-detail-cover-frame-border);
    border-radius: var(--component-detail-cover-frame-border-radius);
    background: var(--series-surface);
    box-shadow: var(--component-detail-cover-frame-box-shadow);
  }

  .cover,
  .cover-fallback {
    width: 100%;
    height: 100%;
  }

  .cover {
    display: block;
    object-fit: cover;
  }

  .cover-fallback {
    display: grid;
    place-items: center;
    align-content: center;
    gap: 8px;
    color: var(--series-muted-soft);
    font-size: 13px;
    text-transform: none;
    letter-spacing: 0;
  }

  .hero-meta {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    padding-bottom: 2px;
  }

  .source-line,
  .tags,
  .metric-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
  }

  .source-line {
    margin: 0 0 2px;
    color: var(--series-primary-strong);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0;
    line-height: 1;
    text-transform: none;
  }

  .tag {
    border: var(--component-detail-tag-border);
    border-radius: var(--component-detail-tag-border-radius);
    background: var(--component-detail-tag-background);
    color: var(--component-detail-tag-color);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: none;
  }

  .tag {
    padding: 5px 10px;
    cursor: pointer;
  }

  .tag:hover {
    color: var(--series-text);
    border-color: var(--series-primary-border);
  }

  .tag-strong {
    color: var(--series-primary-strong);
    border-color: var(--series-primary-border);
    background: var(--series-primary-soft);
  }

  h1 {
    margin: 2px 0 0;
    color: var(--series-text);
    font-size: clamp(30px, 3.2vw, 35px);
    font-weight: 800;
    line-height: 1.08;
    letter-spacing: 0;
    overflow-wrap: anywhere;
  }

  .subtitle,
  .description {
    margin: 0;
    color: var(--series-muted-soft);
    line-height: 1.55;
  }

  .subtitle {
    font-size: 15px;
  }

  .description {
    max-width: 680px;
    display: -webkit-box;
    overflow: hidden;
    font-size: 13px;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }

  .metric-strip {
    align-items: center;
    gap: 0;
  }

  .metric {
    min-width: 0;
    padding: 0 18px 0 0;
    border: 0;
    border-radius: var(--component-detail-metric-border-radius);
    background: transparent;
  }

  .metric + .metric {
    padding-left: 18px;
    border-left: var(--component-detail-metric-metric-border-left);
  }

  .metric span,
  .detail-label {
    display: block;
    margin-bottom: 4px;
    color: var(--series-muted-faint);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  .metric strong {
    color: var(--series-text);
    font-size: 15px;
    font-weight: 800;
  }

  .progress-block {
    width: min(420px, 100%);
    margin-top: 2px;
  }

  .progress-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
    color: var(--series-muted-soft);
    font-size: 12px;
    letter-spacing: 0.04em;
  }

  .progress-head strong {
    color: var(--series-primary-strong);
  }

  .progress-track {
    height: 4px;
    overflow: hidden;
    border-radius: var(--component-detail-progress-track-border-radius);
    background: var(--component-detail-progress-track-background);
  }

  .progress-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--component-detail-progress-fill-background);
  }

  .action-band {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    padding: 12px 40px;
    border-top: 0;
    border-bottom: 0;
    background: var(--component-detail-action-band-background);
    box-shadow: var(--component-detail-action-band-box-shadow);
  }

  .action-left,
  .primary-slot,
  .secondary-slot,
  .utility-slot {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .action-left {
    gap: 10px;
  }

  .details-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--component-detail-hud-control-size);
    height: var(--component-detail-hud-control-size);
    padding: 0;
    border: 0;
    border-radius: var(--component-detail-details-toggle-border-radius);
    color: var(--series-muted-soft);
    background: transparent;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    transition: color 150ms ease, border-color 150ms ease, background 150ms ease, transform 150ms ease, box-shadow 150ms ease;
  }

  .series-v3-root .action-band :global(.series-action),
  .series-v3-root .action-band :global(.series-utility) {
    min-height: var(--component-detail-hud-action-min-height);
    padding-inline: var(--component-detail-hud-action-padding-inline);
    font-size: var(--component-detail-hud-action-font-size);
  }

  .series-v3-root .action-band :global(.series-action.series-icon-action),
  .series-v3-root .action-band :global(.series-utility.series-icon-action) {
    width: var(--component-detail-hud-control-size) !important;
    height: var(--component-detail-hud-control-size);
    min-height: var(--component-detail-hud-control-size);
  }

  .action-band :global(svg),
  .details-toggle :global(svg) {
    width: var(--component-detail-hud-icon-size);
    height: var(--component-detail-hud-icon-size);
  }

  .details-toggle:hover,
  .details-toggle.is-open {
    color: var(--series-primary-strong);
    background: var(--component-detail-details-toggle-is-open-background);
    transform: translateY(-1px);
    box-shadow: var(--component-detail-details-toggle-is-open-box-shadow);
  }

  .details-toggle:active {
    transform: translateY(0) scale(0.97);
    box-shadow: none;
  }

  .details-drawer {
    display: grid;
    grid-template-columns: minmax(0, 1.3fr) minmax(260px, 0.7fr);
    gap: 18px;
    padding: 18px 40px;
    border-bottom: var(--component-detail-details-drawer-border-bottom);
    background: var(--component-detail-details-drawer-background);
  }

  .detail-card {
    min-width: 0;
    padding: 15px 16px;
    border: var(--component-detail-detail-card-border);
    border-radius: var(--component-detail-detail-card-border-radius);
    background: var(--component-detail-detail-card-background);
  }

  .detail-card p {
    margin: 0;
    color: var(--component-detail-detail-card-p-color);
    font-size: 14px;
    line-height: 1.62;
  }

  .chapters-panel {
    position: relative;
    min-height: 360px;
    overflow: visible;
    background: var(--component-detail-chapters-panel-background);
    box-shadow: var(--component-detail-chapters-panel-box-shadow);
  }

  .chapters-panel::before {
    position: absolute;
    inset: 0;
    pointer-events: none;
    content: "";
    background: var(--component-detail-chapters-panel-background-2);
  }

  .chapters-panel > * {
    position: relative;
    z-index: var(--component-detail-chapters-panel-z-index);
  }

  .chapter-toolbar {
    position: relative;
    z-index: var(--component-detail-chapter-toolbar-z-index);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 10px 40px 12px;
    border-bottom: 0;
    background: transparent;
    box-shadow: var(--component-detail-chapter-toolbar-box-shadow);
  }

  .chapter-body {
    position: relative;
    z-index: var(--component-detail-chapter-body-z-index);
    min-height: 260px;
    background: transparent;
  }

  .series-v3-root :global(.read-btn.v3-primary),
  .series-v3-root :global(.series-primary),
  .series-v3-root :global(.library-btn.v3-action),
  .series-v3-root :global(.series-action),
  .series-v3-root :global(.utility-btn.v3-action),
  .series-v3-root :global(.series-utility),
  .series-v3-root :global(.icon-btn),
  .series-v3-root :global(.series-icon),
  .series-v3-root :global(.sort-btn),
  .series-v3-root :global(.series-toolbar-btn),
  .series-v3-root :global(.sel-action-btn),
  .series-v3-root :global(.series-select-btn),
  .series-v3-root :global(.series-page-btn),
  .series-v3-root :global(.page-btn) {
    display: inline-flex !important;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: auto !important;
    min-width: 0;
    min-height: 32px;
    padding: 0 12px;
    border: 0;
    border-radius: var(--component-detail-series-v3-root-page-btn-border-radius) !important;
    color: var(--series-muted);
    background: transparent;
    box-shadow: none;
    font: var(--component-detail-series-v3-root-page-btn-font);
    letter-spacing: 0;
    text-transform: none;
    white-space: nowrap;
    cursor: pointer;
    transform: translateY(0) scale(1);
    transition:
      background 220ms ease,
      border-color 220ms ease,
      color 220ms ease,
      opacity 220ms ease,
      transform 450ms var(--ui-spring),
      box-shadow 220ms ease;
  }

  .series-v3-root :global(.read-btn.v3-primary),
  .series-v3-root :global(.series-primary) {
    min-width: 186px;
    min-height: 40px;
    padding: 0 20px;
    border-radius: var(--component-detail-series-v3-root-series-primary-border-radius) !important;
    color: var(--series-on-primary) !important;
    border-color: transparent !important;
    background: var(--component-detail-series-v3-root-series-primary-background) !important;
    box-shadow: var(--component-detail-series-v3-root-series-primary-box-shadow);
    font-size: 12px;
  }

  .series-v3-root :global(.library-btn.v3-action.active),
  .series-v3-root :global(.series-action.active),
  .series-v3-root :global(.utility-btn.v3-action.active),
  .series-v3-root :global(.series-utility.active),
  .series-v3-root :global(.icon-btn.active),
  .series-v3-root :global(.series-icon.active),
  .series-v3-root :global(.series-toolbar-btn.active),
  .series-v3-root :global(.sort-btn-active) {
    color: var(--series-primary);
    border-color: var(--series-primary-border);
    background: var(--series-primary-soft);
  }

  .series-v3-root :global(.series-utility:not(.series-icon-action)),
  .series-v3-root :global(.series-action:not(.series-icon-action)),
  .series-v3-root :global(.series-select-btn),
  .series-v3-root :global(.series-page-btn) {
    background: transparent;
    border-color: transparent;
  }

  .series-v3-root :global(.series-toolbar-btn) {
    min-height: 32px;
    padding: 0 12px;
    border-radius: var(--component-detail-series-v3-root-series-toolbar-btn-border-radius) !important;
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--series-muted);
    border-color: transparent;
    background: transparent;
  }

  .series-v3-root :global(.static-control) {
    background: var(--component-detail-series-v3-root-static-control-background);
  }

  .series-v3-root :global(.library-btn.v3-action.v3-icon-action),
  .series-v3-root :global(.series-action.series-icon-action),
  .series-v3-root :global(.utility-btn.v3-action.v3-icon-action),
  .series-v3-root :global(.series-utility.series-icon-action),
  .series-v3-root :global(.series-icon.series-icon-action),
  .series-v3-root :global(.icon-btn.v3-icon-action) {
    width: 40px !important;
    height: 40px;
    min-height: 40px;
    padding: 0 !important;
    border-radius: var(--component-detail-series-v3-root-icon-btn-v3-icon-action-border-radius) !important;
    background: transparent;
  }

  .series-v3-root :global(.series-action.series-icon-action.active),
  .series-v3-root :global(.series-utility.series-icon-action.active),
  .series-v3-root :global(.series-icon.series-icon-action.active),
  .series-v3-root :global(.icon-btn.v3-icon-action.active) {
    color: var(--series-primary-container);
    background: var(--component-detail-icon-btn-v3-icon-action-active-background);
  }

  .series-v3-root :global(.read-btn.v3-primary:hover:not(:disabled)),
  .series-v3-root :global(.series-primary:hover:not(:disabled)),
  .series-v3-root :global(.library-btn.v3-action:hover:not(:disabled)),
  .series-v3-root :global(.series-action:hover:not(:disabled)),
  .series-v3-root :global(.utility-btn.v3-action:hover:not(:disabled)),
  .series-v3-root :global(.series-utility:hover:not(:disabled)),
  .series-v3-root :global(.icon-btn:hover:not(:disabled)),
  .series-v3-root :global(.series-icon:hover:not(:disabled)),
  .series-v3-root :global(.sort-btn:hover:not(:disabled)),
  .series-v3-root :global(.series-toolbar-btn:hover:not(:disabled)),
  .series-v3-root :global(.series-select-btn:hover:not(:disabled)),
  .series-v3-root :global(.page-btn:hover:not(:disabled)) {
    color: var(--series-text);
    border-color: transparent;
    background: var(--component-detail-series-v3-root-page-btn-background);
    opacity: var(--component-detail-series-v3-root-page-btn-opacity);
    transform: translateY(0);
    box-shadow: none;
  }

  .series-v3-root :global(.read-btn.v3-primary:hover:not(:disabled)),
  .series-v3-root :global(.series-primary:hover:not(:disabled)) {
    color: var(--series-on-primary) !important;
    border-color: transparent !important;
    background: var(--component-detail-series-v3-root-series-primary-background-2) !important;
    box-shadow: var(--component-detail-series-v3-root-series-primary-box-shadow-2);
  }

  .series-v3-root :global(.read-btn.v3-primary:active:not(:disabled)),
  .series-v3-root :global(.series-primary:active:not(:disabled)),
  .series-v3-root :global(.library-btn.v3-action:active:not(:disabled)),
  .series-v3-root :global(.series-action:active:not(:disabled)),
  .series-v3-root :global(.utility-btn.v3-action:active:not(:disabled)),
  .series-v3-root :global(.series-utility:active:not(:disabled)),
  .series-v3-root :global(.icon-btn:active:not(:disabled)),
  .series-v3-root :global(.series-icon:active:not(:disabled)),
  .series-v3-root :global(.sort-btn:active:not(:disabled)),
  .series-v3-root :global(.series-toolbar-btn:active:not(:disabled)),
  .series-v3-root :global(.series-select-btn:active:not(:disabled)),
  .series-v3-root :global(.page-btn:active:not(:disabled)),
  .series-v3-root :global(.series-page-btn:active:not(:disabled)) {
    transform: translateY(0) scale(0.97);
    box-shadow: none;
  }

  .series-v3-root :global(.series-primary:focus-visible),
  .series-v3-root :global(.series-action:focus-visible),
  .series-v3-root :global(.series-utility:focus-visible),
  .series-v3-root :global(.series-icon:focus-visible),
  .series-v3-root :global(.series-toolbar-btn:focus-visible),
  .series-v3-root :global(.series-select-btn:focus-visible),
  .series-v3-root :global(.series-page-btn:focus-visible),
  .details-toggle:focus-visible,
  .n-icon-btn:focus-visible {
    outline: var(--component-detail-n-icon-btn-outline);
    outline-offset: 2px;
  }

  .series-v3-root :global(button:disabled) {
    cursor: default;
    opacity: var(--component-detail-series-v3-root-button-opacity);
  }

  .series-v3-root :global(.icon-btn),
  .series-v3-root :global(.series-icon),
  .series-v3-root :global(.sel-action-btn),
  .series-v3-root :global(.series-select-btn) {
    width: 34px;
    padding: 0;
  }

  .series-v3-root :global(.list-header-left),
  .series-v3-root :global(.list-header-right) {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex-wrap: wrap;
  }

  .series-v3-root :global(.list-header-right) {
    justify-content: center;
    margin-left: auto;
    margin-right: 16px;
    width: 88px;
    flex: 0 0 88px;
  }

  .series-v3-root :global(.list-label) {
    color: var(--series-text);
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .series-v3-root :global(.list-count),
  .series-v3-root :global(.sort-meta),
  .series-v3-root :global(.control-kicker),
  .series-v3-root :global(.sel-count) {
    color: var(--series-muted-soft);
    font-size: 12px;
    letter-spacing: 0.02em;
  }

  .series-v3-root :global(.control-kicker) {
    color: var(--series-primary-strong);
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .series-v3-root :global(.view-segmented) {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 0;
    width: auto;
    height: 34px;
    padding: 3px;
    border: var(--component-detail-series-v3-root-view-segmented-border);
    border-radius: var(--component-detail-series-v3-root-view-segmented-border-radius);
    background: var(--component-detail-series-v3-root-view-segmented-background);
    overflow: hidden;
  }

  .series-v3-root :global(.view-segmented::before) {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 30px;
    height: 28px;
    border-radius: var(--component-detail-series-v3-root-view-segmented-border-radius);
    content: "";
    background: var(--series-primary);
    box-shadow: var(--component-detail-series-v3-root-view-segmented-box-shadow);
    transform: translateX(0);
    transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .series-v3-root :global(.view-segmented:has(.series-icon:nth-child(2).active)::before) {
    transform: translateX(30px);
  }

  .series-v3-root :global(.view-segmented .series-icon) {
    position: relative;
    z-index: var(--component-detail-series-v3-root-view-segmented-series-icon-z-index);
    width: 30px !important;
    min-width: 30px !important;
    height: 28px !important;
    min-height: 28px !important;
    flex: 0 0 30px;
    padding: 0 !important;
    border: 0;
    border-radius: var(--component-detail-series-v3-root-view-segmented-series-icon-border-radius) !important;
    background: transparent;
    box-shadow: none;
  }

  .series-v3-root :global(.view-segmented .series-icon.active) {
    color: var(--series-on-primary);
    background: transparent;
  }

  .series-v3-root :global(.view-segmented .series-icon:hover:not(:disabled)) {
    color: var(--series-text);
    border-color: transparent;
    background: transparent;
    transform: none;
    box-shadow: none;
  }

  .series-v3-root :global(.view-segmented .series-icon.active:hover:not(:disabled)) {
    color: var(--series-on-primary);
    background: transparent;
  }

  .series-v3-root :global(.static-control) {
    cursor: default;
  }

  .series-v3-root :global(.static-control:hover) {
    transform: none;
    box-shadow: none;
  }

  .series-v3-root :global(.sort-wrap),
  .series-v3-root :global(.fp-wrap),
  .series-v3-root :global(.dl-wrap) {
    position: relative;
  }

  .series-v3-root :global(.sort-menu),
  .series-v3-root :global(.fp-menu) {
    position: absolute;
    z-index: var(--component-detail-series-v3-root-dl-dropdown-z-index);
    top: calc(100% + 8px);
    min-width: 210px;
    padding: 8px;
    border: var(--component-detail-series-v3-root-dl-dropdown-border);
    border-radius: var(--component-detail-series-v3-root-dl-dropdown-border-radius);
    background: var(--component-detail-series-v3-root-dl-dropdown-background);
    box-shadow: var(--component-detail-series-v3-root-dl-dropdown-box-shadow);
    backdrop-filter: var(--component-detail-popover-blur);
    animation: v3PopoverIn 140ms ease both;
    transform-origin: top left;
  }

  .series-v3-root :global(.sort-menu),
  .series-v3-root :global(.fp-menu) {
    left: 0;
  }

  .series-v3-root :global(.sort-section-label) {
    padding: 8px 10px 6px;
    color: var(--series-muted-faint);
    font: var(--component-detail-series-v3-root-sort-section-label-font);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .series-v3-root :global(.sort-divider) {
    height: 1px;
    margin: 6px 2px;
    background: var(--component-detail-series-v3-root-sort-divider-background);
  }

  .series-v3-root :global(.sort-option) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    min-height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--component-detail-series-v3-root-sort-option-border-radius);
    color: var(--series-muted);
    background: transparent;
    font: var(--component-detail-series-v3-root-sort-option-font);
    text-align: left;
    cursor: pointer;
  }

  .series-v3-root :global(.fp-item),
  .series-v3-root :global(.fp-new) {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 34px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--component-detail-series-v3-root-fp-new-border-radius);
    color: var(--series-muted);
    background: transparent;
    font: var(--component-detail-series-v3-root-fp-new-font);
    text-align: left;
    cursor: pointer;
    transition: transform 150ms ease, background 150ms ease, color 150ms ease;
  }

  .series-v3-root :global(.fp-item:hover),
  .series-v3-root :global(.fp-item-active),
  .series-v3-root :global(.fp-new:hover) {
    color: var(--series-text);
    background: var(--component-detail-series-v3-root-fp-new-background);
  }

  .series-v3-root :global(.fp-item:active),
  .series-v3-root :global(.fp-new:active) {
    transform: scale(0.985);
  }

  .series-v3-root :global(.fp-check) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    color: var(--series-primary-strong);
    font-size: 11.5px;
    text-transform: none;
  }

  .series-v3-root :global(.fp-div) {
    height: 1px;
    margin: 6px 2px;
    background: var(--component-detail-series-v3-root-fp-div-background);
  }

  .series-v3-root :global(.fp-create) {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .series-v3-root :global(.fp-input) {
    min-width: 0;
    flex: 1;
    height: 34px;
    padding: 0 10px;
    border: var(--component-detail-series-v3-root-fp-input-border);
    border-radius: var(--component-detail-series-v3-root-fp-input-border-radius);
    color: var(--series-text);
    background: var(--component-detail-series-v3-root-fp-input-background);
    font: var(--component-detail-series-v3-root-fp-input-font);
    outline: none;
  }

  .series-v3-root :global(.fp-input:focus) {
    border-color: var(--component-detail-series-v3-root-fp-input-border-color);
    box-shadow: var(--component-detail-series-v3-root-fp-input-box-shadow);
  }

  .series-v3-root :global(.fp-confirm),
  .series-v3-root :global(.fp-cancel) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 34px;
    min-width: 34px;
    padding: 0 10px;
    border: var(--component-detail-series-v3-root-fp-cancel-border);
    border-radius: var(--component-detail-series-v3-root-fp-cancel-border-radius);
    color: var(--series-muted);
    background: var(--component-detail-series-v3-root-fp-cancel-background);
    font: var(--component-detail-series-v3-root-fp-cancel-font);
    cursor: pointer;
    transition: transform 150ms ease, background 150ms ease, color 150ms ease;
  }

  .series-v3-root :global(.fp-confirm:hover:not(:disabled)),
  .series-v3-root :global(.fp-cancel:hover) {
    color: var(--series-text);
    background: var(--component-detail-series-v3-root-fp-cancel-background-2);
  }

  .series-v3-root :global(.fp-confirm:disabled) {
    cursor: not-allowed;
    opacity: var(--component-detail-series-v3-root-fp-confirm-opacity);
  }

  .series-v3-root :global(.sort-option:hover),
  .series-v3-root :global(.sort-option.active) {
    color: var(--series-text);
    background: var(--component-detail-series-v3-root-sort-option-active-background);
  }

  @keyframes v3PopoverIn {
    from { opacity: var(--component-detail-keyframes-v3popoverin-from-opacity); transform: translateY(-4px) scale(0.985); }
    to { opacity: var(--component-detail-to-opacity); transform: translateY(0) scale(1); }
  }

  .series-v3-root :global(.v3-ch-list) {
    display: block;
    width: 100%;
    min-height: 0;
    padding: 0 40px;
  }

  .series-v3-root :global(.v3-ch-row) {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) minmax(120px, 180px) 120px 88px !important;
    align-items: center !important;
    gap: 16px !important;
    width: 100% !important;
    min-height: 56px !important;
    padding: 13px 16px !important;
    border: 0 !important;
    border-bottom: var(--component-detail-series-v3-root-v3-ch-row-border-bottom) !important;
    border-radius: var(--component-detail-series-v3-root-v3-ch-row-border-radius) !important;
    color: var(--series-text) !important;
    background: transparent !important;
    text-align: left !important;
    box-shadow: none !important;
    cursor: pointer;
  }

  .series-v3-root :global(.v3-ch-row:hover) {
    background: var(--component-detail-series-v3-root-v3-ch-row-background) !important;
  }

  .series-v3-root :global(.v3-ch-row.read) {
    opacity: var(--component-detail-series-v3-root-v3-ch-row-read-opacity);
  }

  .series-v3-root :global(.v3-ch-row:not(.read) .ch-name),
  .series-v3-root :global(.ch-name-active) {
    color: var(--series-primary-strong);
  }

  .series-v3-root :global(.v3-ch-row.ch-selected) {
    background: var(--series-primary-soft);
  }

  .series-v3-root :global(.ch-left) {
    min-width: 0;
  }

  .series-v3-root :global(.chapter-table-header) {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) minmax(120px, 180px) 120px 88px !important;
    gap: 16px !important;
    padding: 10px 16px !important;
    border-bottom: 0 !important;
    color: var(--series-muted-faint);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .series-v3-root :global(.ch-name) {
    display: block;
    overflow: hidden;
    color: var(--series-text);
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Title line of a chapter row: the name ellipsizes and a bookmark glyph, when the chapter has
     one, sits right after it in the accent colour — no label, the tooltip carries the word. */
  .series-v3-root :global(.ch-title) {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .series-v3-root :global(.ch-title .ch-name) {
    min-width: 0;
  }

  .series-v3-root :global(.ch-bookmark) {
    flex: none;
    display: inline-grid;
    place-items: center;
    color: var(--series-primary-strong);
  }

  .series-v3-root :global(.ch-meta) {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 5px;
    color: var(--series-muted-soft);
    font-size: 11px;
    letter-spacing: 0.08em;
  }

  .series-v3-root :global(.ch-meta-item) {
    color: inherit;
  }

  .series-v3-root :global(.ch-meta-item.current),
  .series-v3-root :global(.ch-meta-item.bookmarked),
  .series-v3-root :global(.ch-meta-item.unread) {
    color: var(--series-primary-strong);
  }

  .series-v3-root :global(.ch-provider),
  .series-v3-root :global(.ch-date),
  .series-v3-root :global(.ch-status) {
    display: inline-flex !important;
    align-items: center !important;
    min-width: 0;
    color: var(--component-detail-series-v3-root-ch-status-color);
    font-size: 12px;
    letter-spacing: 0.01em;
  }

  .series-v3-root :global(.ch-provider),
  .series-v3-root :global(.ch-date) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .series-v3-root :global(.ch-status),
  .series-v3-root :global(.ch-right) {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 0;
  }

  .series-v3-root :global(.ch-status) {
    display: grid !important;
    grid-template-columns: 22px 30px 22px;
    justify-content: center !important;
    column-gap: 4px;
    width: 88px;
    justify-self: center;
  }

  .series-v3-root :global(.chapter-table-header span:last-child) {
    width: 88px;
    justify-self: center;
    text-align: center;
  }

  .series-v3-root :global(.ch-status-read),
  .series-v3-root :global(.ch-status-main),
  .series-v3-root :global(.ch-status-action) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
  }

  .series-v3-root :global(.ch-check),
  .series-v3-root :global(.dl-btn) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: var(--component-detail-series-v3-root-dl-btn-border-radius);
    color: var(--series-muted-soft);
    background: transparent;
  }

  .series-v3-root :global(.ch-check:not(.ch-check-visible)) {
    display: none;
  }

  .series-v3-root :global(.status-pill) {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 0 8px;
    border-radius: var(--component-detail-series-v3-root-status-pill-border-radius);
    color: var(--series-muted-soft);
    background: var(--component-detail-series-v3-root-status-pill-background);
    font-size: 11.5px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: none;
  }

  .series-v3-root :global(.status-pill.is-current),
  .series-v3-root :global(.status-pill.is-unread),
  .series-v3-root :global(.read-icon),
  .series-v3-root :global(.enqueue-icon) {
    color: var(--series-primary-strong);
  }

  .series-v3-root :global(.unread-icon) {
    color: var(--series-muted-soft);
    opacity: var(--component-detail-series-v3-root-unread-icon-opacity);
  }

  .series-v3-root :global(.chapter-progress) {
    width: min(200px, 100%);
    height: 2px;
    margin-top: 6px;
    overflow: hidden;
    border-radius: var(--component-detail-series-v3-root-chapter-progress-border-radius);
    background: var(--component-detail-series-v3-root-chapter-progress-background);
  }

  /* An unstarted chapter shows no empty track; the status column already says it is unread. */
  .series-v3-root :global(.chapter-progress.is-empty) {
    visibility: hidden;
  }

  .series-v3-root :global(.chapter-progress__fill) {
    height: 100%;
    background: var(--series-primary-strong);
  }

  .series-v3-root :global(.v3-ch-grid) {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
    gap: 10px;
    padding: 20px 40px;
  }

  .series-v3-root :global(.grid-cell) {
    position: relative;
    display: flex;
    min-height: 74px;
    flex-direction: column;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 12px;
    border-radius: var(--component-detail-series-v3-root-grid-cell-border-radius);
    border: var(--component-detail-series-v3-root-grid-cell-border);
    background: var(--component-detail-series-v3-root-grid-cell-background);
    text-align: left;
    transition: background 150ms ease, border-color 150ms ease, transform 150ms ease;
  }

  .series-v3-root :global(.grid-cell:hover) {
    border-color: var(--component-detail-series-v3-root-grid-cell-border-color);
    background: var(--component-detail-series-v3-root-grid-cell-background-2);
  }

  .series-v3-root :global(.grid-cell.read) {
    opacity: var(--component-detail-series-v3-root-grid-cell-read-opacity);
  }

  .series-v3-root :global(.grid-cell-title) {
    max-width: 100%;
    overflow: hidden;
    color: var(--series-text);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .series-v3-root :global(.grid-cell-sub) {
    color: var(--series-muted-faint);
    font-size: 11.5px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: none;
  }

  .series-v3-root :global(.pagination-bottom.v3-pagination) {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 16px 40px 24px;
  }

  .series-v3-root :global(.page-num) {
    color: var(--series-muted-soft);
    font-size: 12px;
    min-width: 52px;
    text-align: center;
  }

  .series-v3-root :global(.empty-state) {
    padding: 44px 40px;
    color: var(--series-muted-soft);
    font-size: 14px;
  }

  .series-v3-root :global(.detail-row) {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 8px 0;
    border-bottom: var(--component-detail-series-v3-root-detail-row-border-bottom);
  }

  .series-v3-root :global(.detail-key) {
    color: var(--series-muted-soft);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: none;
  }

  .series-v3-root :global(.detail-val) {
    min-width: 0;
    color: var(--series-text);
    font-size: 13px;
    text-align: right;
  }

  .skeleton-title,
  .skeleton-line {
    border-radius: var(--component-detail-skeleton-line-border-radius);
    background: var(--component-detail-skeleton-line-background);
    background-size: 220% 100%;
    animation: shimmer 1.2s ease infinite;
  }

  .skeleton-title {
    width: min(560px, 86%);
    height: 44px;
  }

  .skeleton-line {
    width: min(360px, 62%);
    height: 14px;
  }

  @media (max-width: 860px) {
    .n-topbar,
    .hero,
    .action-band,
    .details-drawer,
    .chapter-toolbar {
      padding-left: 20px;
      padding-right: 20px;
    }

    .hero-content {
      grid-template-columns: 118px minmax(0, 1fr);
      gap: 18px;
      align-items: center;
    }

    h1 {
      font-size: 32px;
    }

    .description {
      line-clamp: 2;
      -webkit-line-clamp: 2;
    }

    .details-drawer {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 620px) {
    .crumbs span {
      display: none;
    }

    .hero-content {
      grid-template-columns: 1fr;
      align-items: start;
    }

    .cover-frame {
      width: 132px;
    }

    .details-toggle {
      margin-left: 0;
    }
  }

  @keyframes shimmer {
    from { background-position: 120% 0; }
    to { background-position: -120% 0; }
  }
</style>
