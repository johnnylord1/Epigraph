<script lang="ts">
  import type { Snippet } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { ArrowLeft, BookOpen, Info } from "phosphor-svelte";

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
    fallbackLabel = "Series",
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
    emptyDetailsLabel = "No extra details available.",
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
  const visibleTags = $derived.by(() => {
    const values = [statusLabel, ...tags].filter((value): value is string => hasRealText(value));
    return [...new Set(values.map((value) => value.trim()))].slice(0, 12);
  });
  const titleText = $derived(title?.trim() || "Untitled");
  const subtitleText = $derived(hasRealText(subtitle) ? subtitle!.trim() : null);
  const sourceNameText = $derived(hasRealText(sourceLabel) ? sourceLabel!.trim() : hasRealText(languageLabel) ? languageLabel!.trim() : null);
  const sourceLineText = $derived(hasRealText(sourceLine) ? sourceLine!.trim() : sourceNameText ? `${mediaKind === "novel" ? "Novel" : "Manga"} - ${sourceNameText}` : null);
</script>

<div class="series-v3-root" data-media-kind={mediaKind}>
  <!-- svelte-ignore a11y_no_static_element_interactions: desktop window drag must start from empty detail topbar regions. -->
  <header class="n-topbar" data-tauri-drag-region onpointerdown={handleTopbarPointerDown}>
    <div class="n-topbar-left">
      <button class="n-icon-btn" type="button" title="Back" onclick={onBack}>
        <ArrowLeft size={17} weight="light" />
      </button>
      <div class="crumbs">
        <span>Library</span>
        <span class="crumb-sep">/</span>
        <strong>{titleText}</strong>
      </div>
    </div>
    <div class="n-topbar-right">
      {@render topbarActions?.()}
    </div>
  </header>

  <div class="scroll-surface">
    <section class="hero">
      {#if coverUrl}
        <div class="hero-backdrop" style={`background-image: url("${coverUrl}")`}></div>
      {:else}
        <div class="hero-backdrop hero-backdrop--empty"></div>
      {/if}

      <div class="hero-content">
        <div class="cover-frame">
          {#if coverUrl}
            <img class="cover" src={coverUrl} alt={titleText} loading="eager" decoding="async" />
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
        <button class="details-toggle" type="button" class:is-open={detailsOpen} onclick={onDetailsToggle} title="Series details" aria-label="Series details">
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
          <span class="detail-label">Synopsis</span>
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
    --series-bg: #131313;
    --series-bg-top: #15151a;
    --series-surface-lowest: #0e0e0e;
    --series-surface-low: #1c1b1b;
    --series-surface: #201f1f;
    --series-surface-high: #2a2a2a;
    --series-outline: #48454f;
    --series-text: #e5e2e1;
    --series-muted: #cac4d0;
    --series-muted-soft: rgba(202, 196, 208, 0.62);
    --series-muted-faint: rgba(202, 196, 208, 0.42);
    --series-primary: #d3c4ff;
    --series-primary-strong: #d3c4ff;
    --series-primary-container: #b8a7ea;
    --series-on-primary: #352660;
    --series-primary-soft: rgba(184, 167, 234, 0.12);
    --series-primary-border: rgba(184, 167, 234, 0.34);
    --series-line: rgba(72, 69, 79, 0.18);
    color: var(--series-text);
    font-family: "Manrope", "Inter", system-ui, sans-serif;
    background:
      radial-gradient(circle at 52% 0%, rgba(184, 167, 234, 0.08), transparent 34%),
      linear-gradient(180deg, var(--series-bg-top) 0%, var(--series-bg) 100%);
    animation: fadeIn 0.14s ease both;
  }

  .n-topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: var(--n-topbar-height, 56px);
    padding: 0 28px;
    border-bottom: 1px solid transparent;
    border-image: linear-gradient(90deg, transparent 5%, rgba(184, 167, 234, 0.08) 50%, transparent 95%) 1;
    background: rgba(19, 19, 26, 0.78);
    backdrop-filter: blur(32px) saturate(140%);
    box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.02), 0 2px 12px rgba(0, 0, 0, 0.15);
    -webkit-app-region: drag;
  }

  .n-topbar::before {
    position: absolute;
    inset: 0;
    content: "";
    pointer-events: none;
    background: radial-gradient(circle at 50% 0%, rgba(184, 167, 234, 0.08), transparent 38%);
  }

  .n-topbar > * {
    position: relative;
    z-index: 1;
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
    width: calc(40px * var(--n-hud-scale, 1)) !important;
    height: calc(40px * var(--n-hud-scale, 1));
    min-height: calc(40px * var(--n-hud-scale, 1));
    padding: 0 !important;
    border-radius: calc(10px * var(--n-hud-scale, 1)) !important;
  }

  .series-v3-root .n-topbar-right :global(.series-icon svg) {
    width: calc(18px * var(--n-hud-scale, 1));
    height: calc(18px * var(--n-hud-scale, 1));
  }

  .n-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 8px;
    color: var(--series-muted-soft);
    background: transparent;
    cursor: pointer;
    transition: color 140ms ease, border-color 140ms ease, background 140ms ease, transform 160ms ease, box-shadow 160ms ease;
    -webkit-app-region: no-drag;
  }

  .n-icon-btn:hover {
    color: var(--series-text);
    background: rgba(255, 255, 255, 0.08);
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
    opacity: 0.45;
  }

  .scroll-surface {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    background:
      radial-gradient(circle at 14% 4%, rgba(184, 167, 234, 0.055), transparent 30%),
      linear-gradient(180deg, #121115 0%, #0f0f11 42%, #0d0d0f 100%);
  }

  .hero {
    position: relative;
    overflow: hidden;
    padding: 28px 40px 24px;
    background:
      radial-gradient(circle at 12% 10%, rgba(184, 167, 234, 0.08), transparent 32%),
      linear-gradient(180deg, rgba(18, 17, 21, 0.96) 0%, rgba(13, 13, 15, 0.96) 100%);
    box-shadow: inset 0 -1px 0 rgba(202, 196, 208, 0.035);
  }

  .hero-backdrop {
    position: absolute;
    inset: 0;
    z-index: 0;
    background-position: center 20%;
    background-size: cover;
    opacity: 0.58;
    filter: blur(52px) brightness(0.42) saturate(1.15);
    transform: scale(1.25);
  }

  .hero-backdrop::after {
    position: absolute;
    inset: 0;
    content: "";
    background:
      radial-gradient(circle at 18% 16%, rgba(211, 196, 255, 0.16), transparent 28%),
      linear-gradient(90deg, rgba(14, 14, 17, 0.2) 0%, rgba(14, 14, 17, 0.66) 44%, rgba(14, 14, 17, 0.92) 100%),
      linear-gradient(180deg, rgba(14, 14, 17, 0.16), rgba(14, 14, 17, 0.86));
  }

  .hero-backdrop--empty {
    background:
      radial-gradient(circle at 25% 20%, rgba(211, 196, 255, 0.18), transparent 32%),
      linear-gradient(135deg, #1b1a20, #111);
    filter: none;
    transform: none;
  }

  .hero-content {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: 176px minmax(0, 1fr);
    gap: 32px;
    align-items: flex-start;
    max-width: 980px;
  }

  .cover-frame {
    aspect-ratio: 2 / 3;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 14px;
    background: var(--series-surface);
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.46);
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
    text-transform: uppercase;
    letter-spacing: 0.12em;
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
    letter-spacing: 0.16em;
    line-height: 1;
    text-transform: uppercase;
  }

  .tag {
    border: 1px solid rgba(72, 69, 79, 0.28);
    border-radius: 999px;
    background: rgba(28, 27, 27, 0.68);
    color: rgba(229, 226, 225, 0.72);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
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
    border-radius: 0;
    background: transparent;
  }

  .metric + .metric {
    padding-left: 18px;
    border-left: 1px solid rgba(255, 255, 255, 0.1);
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
    border-radius: 999px;
    background: rgba(148, 143, 154, 0.18);
  }

  .progress-fill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--series-primary-strong), #8f7ee0);
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
    background:
      radial-gradient(circle at 12% 0%, rgba(184, 167, 234, 0.035), transparent 30%),
      linear-gradient(180deg, rgba(18, 17, 21, 0.76), rgba(15, 15, 17, 0.88));
    box-shadow:
      inset 0 1px 0 rgba(202, 196, 208, 0.028),
      inset 0 -1px 0 rgba(202, 196, 208, 0.02);
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
    width: calc(40px * var(--n-hud-scale, 1));
    height: calc(40px * var(--n-hud-scale, 1));
    padding: 0;
    border: 0;
    border-radius: 12px;
    color: var(--series-muted-soft);
    background: transparent;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    transition: color 150ms ease, border-color 150ms ease, background 150ms ease, transform 150ms ease, box-shadow 150ms ease;
  }

  .series-v3-root .action-band :global(.series-action),
  .series-v3-root .action-band :global(.series-utility) {
    min-height: calc(36px * var(--n-hud-scale, 1));
    padding-inline: calc(14px * var(--n-hud-scale, 1));
    font-size: calc(11px * var(--n-hud-scale, 1));
  }

  .series-v3-root .action-band :global(.series-action.series-icon-action),
  .series-v3-root .action-band :global(.series-utility.series-icon-action) {
    width: calc(40px * var(--n-hud-scale, 1)) !important;
    height: calc(40px * var(--n-hud-scale, 1));
    min-height: calc(40px * var(--n-hud-scale, 1));
  }

  .action-band :global(svg),
  .details-toggle :global(svg) {
    width: calc(18px * var(--n-hud-scale, 1));
    height: calc(18px * var(--n-hud-scale, 1));
  }

  .details-toggle:hover,
  .details-toggle.is-open {
    color: var(--series-primary-strong);
    background: rgba(184, 167, 234, 0.1);
    transform: translateY(-1px);
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.22);
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
    border-bottom: 1px solid rgba(72, 69, 79, 0.14);
    background: linear-gradient(180deg, rgba(28, 27, 27, 0.58), rgba(19, 19, 19, 0.32));
  }

  .detail-card {
    min-width: 0;
    padding: 15px 16px;
    border: 1px solid rgba(72, 69, 79, 0.18);
    border-radius: 14px;
    background: rgba(28, 27, 27, 0.58);
  }

  .detail-card p {
    margin: 0;
    color: rgba(229, 226, 225, 0.78);
    font-size: 14px;
    line-height: 1.62;
  }

  .chapters-panel {
    position: relative;
    min-height: 360px;
    overflow: visible;
    background:
      radial-gradient(circle at 14% 0%, rgba(184, 167, 234, 0.035), transparent 32%),
      linear-gradient(180deg, rgba(17, 17, 20, 0.86) 0%, rgba(14, 14, 16, 0.96) 42%, rgba(13, 13, 15, 0.98) 100%);
    box-shadow:
      inset 0 1px 0 rgba(202, 196, 208, 0.025),
      inset 0 18px 36px rgba(0, 0, 0, 0.08);
  }

  .chapters-panel::before {
    position: absolute;
    inset: 0;
    pointer-events: none;
    content: "";
    background:
      linear-gradient(90deg, transparent 0%, rgba(202, 196, 208, 0.018) 48%, transparent 100%),
      radial-gradient(circle at 78% 18%, rgba(184, 167, 234, 0.025), transparent 28%);
  }

  .chapters-panel > * {
    position: relative;
    z-index: 1;
  }

  .chapter-toolbar {
    position: relative;
    z-index: 8;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 10px 40px 12px;
    border-bottom: 0;
    background: transparent;
    box-shadow: inset 0 -1px 0 rgba(202, 196, 208, 0.018);
  }

  .chapter-body {
    position: relative;
    z-index: 1;
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
    border-radius: 8px !important;
    color: var(--series-muted);
    background: transparent;
    box-shadow: none;
    font: 700 11px/1 "Manrope", "Inter", system-ui, sans-serif;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    white-space: nowrap;
    cursor: pointer;
    transform: translateY(0) scale(1);
    transition:
      background 150ms ease,
      border-color 150ms ease,
      color 150ms ease,
      opacity 150ms ease,
      transform 150ms ease,
      box-shadow 150ms ease;
  }

  .series-v3-root :global(.read-btn.v3-primary),
  .series-v3-root :global(.series-primary) {
    min-width: 186px;
    min-height: 40px;
    padding: 0 20px;
    border-radius: 12px !important;
    color: var(--series-on-primary) !important;
    border-color: transparent !important;
    background: linear-gradient(135deg, var(--series-primary-container) 0%, var(--series-primary) 100%) !important;
    box-shadow: 0 4px 14px rgba(184, 167, 234, 0.15);
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
    border-radius: 8px !important;
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--series-muted);
    border-color: transparent;
    background: transparent;
  }

  .series-v3-root :global(.static-control) {
    background: rgba(14, 14, 14, 0.5);
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
    border-radius: 12px !important;
    background: transparent;
  }

  .series-v3-root :global(.series-action.series-icon-action.active),
  .series-v3-root :global(.series-utility.series-icon-action.active),
  .series-v3-root :global(.series-icon.series-icon-action.active),
  .series-v3-root :global(.icon-btn.v3-icon-action.active) {
    color: var(--series-primary-container);
    background: rgba(184, 167, 234, 0.1);
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
    background: rgba(184, 167, 234, 0.05);
    opacity: 1;
    transform: translateY(0);
    box-shadow: none;
  }

  .series-v3-root :global(.read-btn.v3-primary:hover:not(:disabled)),
  .series-v3-root :global(.series-primary:hover:not(:disabled)) {
    color: var(--series-on-primary) !important;
    border-color: transparent !important;
    background: linear-gradient(135deg, #c1b1ef 0%, #dfd5ff 100%) !important;
    box-shadow: 0 12px 26px rgba(184, 167, 234, 0.16);
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
    outline: 2px solid rgba(200, 187, 255, 0.68);
    outline-offset: 2px;
  }

  .series-v3-root :global(button:disabled) {
    cursor: default;
    opacity: 0.44;
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
    border: 1px solid rgba(72, 69, 79, 0.35);
    border-radius: 999px;
    background: rgba(14, 14, 14, 0.34);
    overflow: hidden;
  }

  .series-v3-root :global(.view-segmented::before) {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 30px;
    height: 28px;
    border-radius: 999px;
    content: "";
    background: var(--series-primary);
    box-shadow: 0 4px 14px rgba(184, 167, 234, 0.25);
    transform: translateX(0);
    transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .series-v3-root :global(.view-segmented:has(.series-icon:nth-child(2).active)::before) {
    transform: translateX(30px);
  }

  .series-v3-root :global(.view-segmented .series-icon) {
    position: relative;
    z-index: 1;
    width: 30px !important;
    min-width: 30px !important;
    height: 28px !important;
    min-height: 28px !important;
    flex: 0 0 30px;
    padding: 0 !important;
    border: 0;
    border-radius: 999px !important;
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
  .series-v3-root :global(.fp-menu),
  .series-v3-root :global(.dl-dropdown) {
    position: absolute;
    z-index: 120;
    top: calc(100% + 8px);
    min-width: 210px;
    padding: 8px;
    border: 1px solid rgba(92, 88, 103, 0.42);
    border-radius: 14px;
    background: rgba(21, 20, 25, 0.98);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.025),
      0 16px 40px rgba(0, 0, 0, 0.42);
    backdrop-filter: blur(18px) saturate(120%);
    animation: v3PopoverIn 140ms ease both;
    transform-origin: top left;
  }

  .series-v3-root :global(.sort-menu),
  .series-v3-root :global(.fp-menu) {
    left: 0;
  }

  .series-v3-root :global(.dl-dropdown) {
    right: 0;
    width: min(318px, calc(100vw - 32px));
    min-width: 0;
    transform-origin: top right;
  }

  .series-v3-root :global(.sort-section-label) {
    padding: 8px 10px 6px;
    color: var(--series-muted-faint);
    font: 800 9px/1 "Manrope", "Inter", system-ui, sans-serif;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .series-v3-root :global(.sort-divider) {
    height: 1px;
    margin: 6px 2px;
    background: rgba(202, 196, 208, 0.08);
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
    border-radius: 8px;
    color: var(--series-muted);
    background: transparent;
    font: 700 11px/1 "Manrope", "Inter", system-ui, sans-serif;
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
    border-radius: 8px;
    color: var(--series-muted);
    background: transparent;
    font: 800 11px/1 "Manrope", "Inter", system-ui, sans-serif;
    text-align: left;
    cursor: pointer;
    transition: transform 150ms ease, background 150ms ease, color 150ms ease;
  }

  .series-v3-root :global(.fp-item:hover),
  .series-v3-root :global(.fp-item-active),
  .series-v3-root :global(.fp-new:hover) {
    color: var(--series-text);
    background: rgba(201, 181, 255, 0.12);
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
    font-size: 10px;
    text-transform: uppercase;
  }

  .series-v3-root :global(.fp-div) {
    height: 1px;
    margin: 6px 2px;
    background: rgba(202, 196, 208, 0.08);
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
    border: 1px solid rgba(92, 88, 103, 0.5);
    border-radius: 8px;
    color: var(--series-text);
    background: rgba(10, 10, 13, 0.62);
    font: 700 11px/1 "Manrope", "Inter", system-ui, sans-serif;
    outline: none;
  }

  .series-v3-root :global(.fp-input:focus) {
    border-color: rgba(201, 181, 255, 0.45);
    box-shadow: 0 0 0 3px rgba(201, 181, 255, 0.08);
  }

  .series-v3-root :global(.fp-confirm),
  .series-v3-root :global(.fp-cancel) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 34px;
    min-width: 34px;
    padding: 0 10px;
    border: 1px solid rgba(92, 88, 103, 0.48);
    border-radius: 8px;
    color: var(--series-muted);
    background: rgba(255, 255, 255, 0.025);
    font: 800 10px/1 "Manrope", "Inter", system-ui, sans-serif;
    cursor: pointer;
    transition: transform 150ms ease, background 150ms ease, color 150ms ease;
  }

  .series-v3-root :global(.fp-confirm:hover:not(:disabled)),
  .series-v3-root :global(.fp-cancel:hover) {
    color: var(--series-text);
    background: rgba(201, 181, 255, 0.12);
  }

  .series-v3-root :global(.fp-confirm:disabled) {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .series-v3-root :global(.sort-option:hover),
  .series-v3-root :global(.sort-option.active) {
    color: var(--series-text);
    background: rgba(201, 181, 255, 0.12);
  }

  @keyframes v3PopoverIn {
    from { opacity: 0; transform: translateY(-4px) scale(0.985); }
    to { opacity: 1; transform: translateY(0) scale(1); }
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
    border-bottom: 1px solid rgba(202, 196, 208, 0.035) !important;
    border-radius: 8px !important;
    color: var(--series-text) !important;
    background: transparent !important;
    text-align: left !important;
    box-shadow: none !important;
    cursor: pointer;
  }

  .series-v3-root :global(.v3-ch-row:hover) {
    background: rgba(184, 167, 234, 0.04) !important;
  }

  .series-v3-root :global(.v3-ch-row.read) {
    opacity: 0.38;
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
    color: rgba(202, 196, 208, 0.54);
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
    border-radius: 8px;
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
    border-radius: 999px;
    color: var(--series-muted-soft);
    background: rgba(255, 255, 255, 0.035);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .series-v3-root :global(.status-pill.is-current),
  .series-v3-root :global(.status-pill.is-unread),
  .series-v3-root :global(.read-icon),
  .series-v3-root :global(.enqueue-icon) {
    color: var(--series-primary-strong);
  }

  .series-v3-root :global(.unread-icon) {
    color: var(--series-muted-soft);
    opacity: 0.72;
  }

  .series-v3-root :global(.chapter-progress) {
    width: min(200px, 100%);
    height: 2px;
    margin-top: 6px;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(148, 143, 154, 0.16);
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
    border-radius: 12px;
    border: 1px solid rgba(202, 196, 208, 0.06);
    background: rgba(28, 27, 27, 0.34);
    text-align: left;
    transition: background 150ms ease, border-color 150ms ease, transform 150ms ease;
  }

  .series-v3-root :global(.grid-cell:hover) {
    border-color: rgba(184, 167, 234, 0.22);
    background: rgba(184, 167, 234, 0.055);
  }

  .series-v3-root :global(.grid-cell.read) {
    opacity: 0.46;
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
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
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
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .series-v3-root :global(.detail-key) {
    color: var(--series-muted-soft);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .series-v3-root :global(.detail-val) {
    min-width: 0;
    color: var(--series-text);
    font-size: 13px;
    text-align: right;
  }

  .skeleton-title,
  .skeleton-line {
    border-radius: 999px;
    background: linear-gradient(90deg, rgba(255,255,255,0.08), rgba(255,255,255,0.16), rgba(255,255,255,0.08));
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
