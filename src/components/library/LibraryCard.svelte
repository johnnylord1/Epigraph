<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { BookOpen, Books, CheckSquare, Stack } from "phosphor-svelte";
  import { requiresAuthenticatedMediaFetch, resolvedImage } from "../../lib/imageCache";
  import type { LibraryCardVM } from "../../lib/library/contracts";
  import {
    canRunLibraryMotion,
    DEFAULT_LIBRARY_MOTION_ENVIRONMENT,
    type LibraryMotionEnvironment,
  } from "../../lib/library/motionGate";
  import { observeLibraryCardVisibility } from "../../lib/library/visibilityRegistry";

  type Props = {
    vm: LibraryCardVM;
    viewMode?: "grid" | "compact_grid" | "list";
    showProgress?: boolean;
    showOutline?: boolean;
    showSelectableState?: boolean;
    onOpen?: (id: string, event: MouseEvent | KeyboardEvent) => void;
    onContextMenu?: (id: string, event: MouseEvent) => void;
    onPointerDown?: (id: string, event: PointerEvent) => void;
    onPointerUp?: (id: string, event: PointerEvent) => void;
    onPointerLeave?: (id: string, event: PointerEvent) => void;
    onCoverLoad?: (id: string) => void;
    onCoverError?: (id: string) => void;
    coverLoading?: "lazy" | "eager";
    panelActive?: boolean;
    scrollElement?: HTMLElement | null;
    motionEnvironment?: LibraryMotionEnvironment;
    panelMotionEnabled?: boolean;
  };

  let {
    vm,
    viewMode = "grid",
    showProgress = true,
    showOutline = true,
    showSelectableState = false,
    onOpen = () => {},
    onContextMenu,
    onPointerDown,
    onPointerUp,
    onPointerLeave,
    onCoverLoad,
    onCoverError,
    coverLoading = "lazy",
    panelActive = true,
    scrollElement = null,
    motionEnvironment = DEFAULT_LIBRARY_MOTION_ENVIRONMENT,
    panelMotionEnabled = true,
  }: Props = $props();
  let cardElement: HTMLButtonElement | null = $state(null);
  let cardActuallyVisible = $state(false);
  let suppressNextClick = false;
  let flagImageFailed = $state(false);
  const coverNeedsResolvedImage = $derived(requiresAuthenticatedMediaFetch(vm.coverSrc));
  const liquidMotionAllowed = $derived(canRunLibraryMotion({
    ...motionEnvironment,
    motionEnabled: motionEnvironment.motionEnabled && panelMotionEnabled,
    panelActive,
    cardActuallyVisible,
  }));

  $effect(() => {
    const node = cardElement;
    const container = scrollElement;
    if (!node || !container || !panelActive) {
      cardActuallyVisible = false;
      return;
    }

    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    let fallbackTimer: number | null = null;

    const syncGeometryVisibility = () => {
      cardActuallyVisible = isCardInsideScrollViewport(node, container);
    };

    const unsubscribe = observeLibraryCardVisibility(node, (visible) => {
      cardActuallyVisible = visible && isCardInsideScrollViewport(node, container, true);
    }, container);

    syncGeometryVisibility();
    firstFrame = requestAnimationFrame(() => {
      firstFrame = null;
      syncGeometryVisibility();
      secondFrame = requestAnimationFrame(() => {
        secondFrame = null;
        syncGeometryVisibility();
      });
    });
    fallbackTimer = window.setTimeout(() => {
      fallbackTimer = null;
      syncGeometryVisibility();
    }, 120);

    return () => {
      unsubscribe();
      if (firstFrame !== null) cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
    };
  });

  $effect(() => {
    if (vm.sourceMetricBanner) {
      vm.sourceMetricBanner.flagLabel;
      vm.sourceMetricBanner.sourceName;
    }
    flagImageFailed = false;
  });

  const showOverlayBadges = $derived(viewMode !== "list");
  const primaryGridBadge = $derived(
    viewMode !== "list"
      ? (vm.primaryGridBadge !== undefined
        ? vm.primaryGridBadge
        : (vm.sourceMetricBanner
          ? null
          : (vm.badges.find((badge) => badge.kind === "unread")
            ?? vm.badges.find((badge) => badge.kind === "status")
            ?? vm.badges.find((badge) => badge.kind === "download")
            ?? null)))
      : null,
  );
  const hasFlag = $derived(
    vm.sourceMetricBanner
      ? Boolean(getCountryCode(vm.sourceMetricBanner.flagLabel, vm.sourceMetricBanner.sourceName)) ||
        getLanguageFlag(vm.sourceMetricBanner.flagLabel, vm.sourceMetricBanner.sourceName) !== "🌐"
      : false
  );
  const topLeftBadges = $derived(
    showOverlayBadges && viewMode === "list"
      ? (vm.listTopLeftBadges ?? vm.badges
          .filter((badge) => badge.kind === "unread" || badge.kind === "download")
          .sort((left) => (left.kind === "unread" ? -1 : 1)))
      : [],
  );
  const topRightBadges = $derived(
    showOverlayBadges && viewMode === "list"
      ? (vm.listTopRightBadges ?? vm.badges.filter((badge) => badge.kind === "status"))
      : [],
  );
  const bottomLeftBadges = $derived(
    showOverlayBadges && viewMode === "list" ? (vm.listBottomLeftBadges ?? vm.badges.filter((badge) => badge.kind === "subtype")) : [],
  );
  const displayedGridBadge = $derived(primaryGridBadge);

  function formatGridStateLabel(label: string, _kind: string): string {
    return label;
  }

  function visibleGridStatusLabel(label: string | undefined): string | null {
    const normalized = label?.trim();
    if (!normalized) return null;
    return normalized;
  }

  function toCoverProgressWidth(percent: number | null | undefined): number {
    if (typeof percent !== "number" || !Number.isFinite(percent)) return 0;
    return Math.max(0, Math.min(100, percent * 100));
  }

  function isCardInsideScrollViewport(node: HTMLElement, container: HTMLElement, allowLayoutless = false): boolean {
    const rect = node.getBoundingClientRect();
    const root = container.getBoundingClientRect();
    if (allowLayoutless
      && rect.width === 0
      && rect.height === 0
      && root.width === 0
      && root.height === 0) {
      return true;
    }
    return rect.bottom > root.top
      && rect.top < root.bottom
      && rect.right > root.left
      && rect.left < root.right
      && rect.width > 0
      && rect.height > 0;
  }

  function getLanguageFlag(lang: string | null | undefined, sourceName?: string | null): string {
    let normalized = (lang ?? "").trim().toLowerCase();

    // Defensive fallback using sourceName keywords (e.g. Asura Scans (EN), Union Mangas)
    if (!normalized && sourceName) {
      const nameLower = sourceName.toLowerCase();
      if (nameLower.includes("(en)") || nameLower.includes("english")) {
        normalized = "en";
      } else if (nameLower.includes("(pt") || nameLower.includes("portugue") || nameLower.includes("union") || nameLower.includes("mangaschan")) {
        normalized = "pt";
      } else if (nameLower.includes("(ja)") || nameLower.includes("japanese")) {
        normalized = "ja";
      } else if (nameLower.includes("(ko)") || nameLower.includes("korean")) {
        normalized = "ko";
      } else if (nameLower.includes("(es)") || nameLower.includes("spanish")) {
        normalized = "es";
      } else if (nameLower.includes("(zh)") || nameLower.includes("chinese")) {
        normalized = "zh";
      }
    }

    if (!normalized) return "🌐";

    if (normalized.startsWith("pt") || normalized.includes("portug") || normalized === "po" || normalized === "por") {
      return "🇧🇷";
    }
    if (normalized.startsWith("en") || normalized.includes("english") || normalized === "gb") {
      return "🇬🇧";
    }
    if (normalized.startsWith("ja") || normalized.includes("japan") || normalized.includes("日本語")) {
      return "🇯🇵";
    }
    if (normalized.startsWith("ko") || normalized.includes("korean") || normalized.includes("한국어")) {
      return "🇰🇷";
    }
    if (normalized.startsWith("es") || normalized.includes("spani") || normalized.includes("españ") || normalized.includes("espan")) {
      return "🇪🇸";
    }
    if (normalized.startsWith("zh") || normalized.includes("chin") || normalized.includes("中文")) {
      return "🇨🇳";
    }
    if (normalized.startsWith("fr") || normalized.includes("frenc") || normalized.includes("franç") || normalized.includes("franc")) {
      return "🇫🇷";
    }

    // Split regional subtags (e.g., pt-br -> pt, en-us -> en)
    const baseLang = normalized.split(/[-_]/)[0];
    return baseLang ? baseLang.substring(0, 2).toUpperCase() : "🌐";
  }

  function getCountryCode(lang: string | null | undefined, sourceName?: string | null): string | null {
    let normalized = (lang ?? "").trim().toLowerCase();

    // Defensive fallback using sourceName keywords (e.g. Asura Scans (EN), Union Mangas)
    if (!normalized && sourceName) {
      const nameLower = sourceName.toLowerCase();
      if (nameLower.includes("(en)") || nameLower.includes("english")) {
        normalized = "en";
      } else if (nameLower.includes("(pt") || nameLower.includes("portugue") || nameLower.includes("union") || nameLower.includes("mangaschan")) {
        normalized = "pt";
      } else if (nameLower.includes("(ja)") || nameLower.includes("japanese")) {
        normalized = "ja";
      } else if (nameLower.includes("(ko)") || nameLower.includes("korean")) {
        normalized = "ko";
      } else if (nameLower.includes("(es)") || nameLower.includes("spanish")) {
        normalized = "es";
      } else if (nameLower.includes("(zh)") || nameLower.includes("chinese")) {
        normalized = "zh";
      }
    }

    if (!normalized) return null;

    if (normalized.startsWith("pt") || normalized.includes("portug") || normalized === "po" || normalized === "por") {
      return "br";
    }
    if (normalized.startsWith("en") || normalized.includes("english") || normalized === "gb") {
      return "gb";
    }
    if (normalized.startsWith("ja") || normalized.includes("japan") || normalized.includes("日本語")) {
      return "jp";
    }
    if (normalized.startsWith("ko") || normalized.includes("korean") || normalized.includes("한국어")) {
      return "kr";
    }
    if (normalized.startsWith("es") || normalized.includes("spani") || normalized.includes("españ") || normalized.includes("espan")) {
      return "es";
    }
    if (normalized.startsWith("zh") || normalized.includes("chin") || normalized.includes("中文")) {
      return "cn";
    }
    if (normalized.startsWith("fr") || normalized.includes("frenc") || normalized.includes("franç") || normalized.includes("franc")) {
      return "fr";
    }

    // Split regional subtags (e.g., pt-br -> pt, en-us -> en)
    const baseLang = normalized.split(/[-_]/)[0];
    // If the base language is a 2-character code, use it. Otherwise return null.
    return baseLang.length === 2 ? baseLang : null;
  }
</script>

<button
  bind:this={cardElement}
  type="button"
  class="card"
  class:n-library-card={viewMode !== "list"}
  class:card-compact={viewMode === "compact_grid"}
  class:card-list={viewMode === "list"}
  class:card-outline-off={!showOutline}
  data-card-id={vm.id}
  class:card-selected={vm.selected}
  class:card-selectable={vm.selectable}
  class:library-motion-running={liquidMotionAllowed}
  disabled={vm.disabled}
  onclick={(event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    onOpen(vm.id, event);
  }}
  onkeydown={(event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      suppressNextClick = true;
      onOpen(vm.id, event);
    }
  }}
  oncontextmenu={onContextMenu ? ((event) => onContextMenu(vm.id, event)) : undefined}
  onpointerdown={onPointerDown ? ((event) => onPointerDown(vm.id, event)) : undefined}
  onpointerup={onPointerUp ? ((event) => onPointerUp(vm.id, event)) : undefined}
  onpointerleave={onPointerLeave ? ((event) => onPointerLeave(vm.id, event)) : undefined}
  aria-label={vm.title}
>
  <div class="card-cover-container">
    <div class="cover-wrap" class:n-library-card__cover={viewMode !== "list"}>
      {#if vm.coverSrc}
        {#if coverNeedsResolvedImage}
          <img
            class="cover"
            use:resolvedImage={vm.coverSrc}
            alt={vm.title}
            width="420"
            height="630"
            style={`object-fit:${vm.coverFit};`}
            loading={coverLoading}
            decoding="async"
            draggable="false"
            onload={onCoverLoad ? (() => onCoverLoad(vm.id)) : undefined}
            onerror={onCoverError ? (() => onCoverError(vm.id)) : undefined}
          />
        {:else}
          <img
            class="cover"
            src={vm.coverSrc}
            alt={vm.title}
            width="420"
            height="630"
            style={`object-fit:${vm.coverFit};`}
            loading={coverLoading}
            decoding="async"
            draggable="false"
            onload={onCoverLoad ? (() => onCoverLoad(vm.id)) : undefined}
            onerror={onCoverError ? (() => onCoverError(vm.id)) : undefined}
          />
        {/if}
      {:else}
        <div class="cover-fallback" aria-hidden="true">
          {#if vm.selectable}
            <Stack size={28} weight="duotone" />
          {:else}
            <BookOpen size={28} weight="duotone" />
          {/if}
        </div>
      {/if}

      {#if viewMode !== "list" && displayedGridBadge}
        <span class="n-library-card__badge">{formatGridStateLabel(displayedGridBadge.label, displayedGridBadge.kind)}</span>
      {/if}
      {#if topLeftBadges.length}
        <div class="badge-cluster badge-cluster-top-left">
          {#each topLeftBadges as badge, index (badge.kind + badge.label + index)}
            <span class={`badge badge-${badge.kind} n-library-card__badge`}>{formatGridStateLabel(badge.label, badge.kind)}</span>
          {/each}
        </div>
      {/if}
      {#if topRightBadges.length}
        <div class="badge-cluster badge-cluster-top-right">
          {#each topRightBadges as badge, index (badge.kind + badge.label + index)}
            <span class={`badge badge-${badge.kind} n-library-card__badge`}>{formatGridStateLabel(badge.label, badge.kind)}</span>
          {/each}
        </div>
      {/if}
      {#if bottomLeftBadges.length}
        <div class="badge-cluster badge-cluster-bottom-left">
          {#each bottomLeftBadges as badge, index (badge.kind + badge.label + index)}
            <span class={`badge badge-${badge.kind} n-library-card__badge`}>{formatGridStateLabel(badge.label, badge.kind)}</span>
          {/each}
        </div>
      {/if}

      {#if viewMode === "grid" && showProgress && vm.progress}
        {@const coverProgressWidth = toCoverProgressWidth(vm.progress.percent)}
        <div class="cover-progress-track" aria-label={vm.progress.primaryLabel}>
          <div
            class="cover-progress-fill anim-liquid-progress"
            class:has-visible-progress={coverProgressWidth > 0}
            style={`--cover-progress-width:${coverProgressWidth}%;`}
          ></div>
        </div>
      {/if}

      {#if showSelectableState && vm.selectable}
        <div class="select-overlay" aria-hidden="true">
          <div class="select-check" class:checked={vm.selected}>
            {#if vm.selected}
              <CheckSquare size={20} weight="fill" />
            {:else}
              <div class="select-check-empty"></div>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    {#if viewMode !== "list" && vm.sourceMetricBanner && (vm.sourceMetricBanner.newCount > 0 || vm.sourceMetricBanner.downloadedCount > 0 || (viewMode === "grid" && hasFlag))}
      <div class="source-metric-banner" class:source-metric-banner-compact={viewMode === "compact_grid"} aria-label={$_("ui_sourceInfoFlagDownloadedUnread")}>
        {#if viewMode === "grid" && hasFlag}
          <span
            class="source-metric-flag"
            class:flag-only={!(vm.sourceMetricBanner.downloadedCount > 0 || vm.sourceMetricBanner.newCount > 0)}
            aria-label={$_("ui_sourceLanguage")}
          >
            {#if getCountryCode(vm.sourceMetricBanner.flagLabel, vm.sourceMetricBanner.sourceName) && !flagImageFailed}
              <img
                class="source-metric-flag-img"
                src="https://flagcdn.com/w160/{getCountryCode(vm.sourceMetricBanner.flagLabel, vm.sourceMetricBanner.sourceName)}.png"
                srcset={`https://flagcdn.com/w80/${getCountryCode(vm.sourceMetricBanner.flagLabel, vm.sourceMetricBanner.sourceName)}.png 1x, https://flagcdn.com/w160/${getCountryCode(vm.sourceMetricBanner.flagLabel, vm.sourceMetricBanner.sourceName)}.png 2x, https://flagcdn.com/w320/${getCountryCode(vm.sourceMetricBanner.flagLabel, vm.sourceMetricBanner.sourceName)}.png 4x`}
                alt={vm.sourceMetricBanner.flagLabel}
                loading="lazy"
                decoding="async"
                draggable="false"
                onerror={() => {
                  flagImageFailed = true;
                }}
              />
            {:else}
              {getLanguageFlag(vm.sourceMetricBanner.flagLabel, vm.sourceMetricBanner.sourceName)}
            {/if}
          </span>
        {/if}

        {#if vm.sourceMetricBanner.downloadedCount > 0 || vm.sourceMetricBanner.newCount > 0}
          <div class="source-metric-pill" class:has-flag={viewMode === "grid" && hasFlag}>
            {#if vm.sourceMetricBanner.downloadedCount > 0}
              <span
                class="source-metric-downloaded"
                class:pill-only={vm.sourceMetricBanner.newCount === 0}
                class:has-flag={viewMode === "grid" && hasFlag}
                aria-label={$_("ui_downloadedChapters")}
              >
                <span class="source-metric-value">{vm.sourceMetricBanner.downloadedCount}</span>
              </span>
            {/if}
            {#if vm.sourceMetricBanner.newCount > 0}
              <span
                class="source-metric-unread"
                class:pill-only={vm.sourceMetricBanner.downloadedCount === 0}
                class:has-flag={viewMode === "grid" && hasFlag}
                aria-label={$_("library_sort_unreadChapters")}
              >
                <span class="source-metric-value">{vm.sourceMetricBanner.newCount}</span>
              </span>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="card-copy" class:n-library-card__info={viewMode !== "list"}>
    <p class="title" class:n-library-card__title={viewMode !== "list"}>{vm.title}</p>
    {#if viewMode === "grid"}
      <div class="n-library-card__meta" aria-hidden={!vm.subtitle && !vm.progress?.primaryLabel}>
        {#if vm.subtitle}
          <span class="n-library-card__author">{vm.subtitle}</span>
        {/if}
        {#if visibleGridStatusLabel(vm.metaChips[0])}
          <span class="n-library-card__vol">{visibleGridStatusLabel(vm.metaChips[0])}</span>
        {/if}
      </div>
    {:else if viewMode === "list" && vm.subtitle}
      <p class="subtitle">{vm.subtitle}</p>
    {/if}
    {#if viewMode === "list" && vm.badges.length}
      <div class="meta-row">
        {#each vm.badges as badge, index (badge.kind + badge.label + index)}
          <span class={`meta-chip meta-chip-badge meta-chip-${badge.kind}`}>{badge.label}</span>
        {/each}
      </div>
    {/if}
    {#if viewMode === "list" && vm.metaChips.length}
      <div class="meta-row">
        {#each vm.metaChips as chip}
          <span class="meta-chip">{chip}</span>
        {/each}
      </div>
    {/if}
    {#if viewMode === "list" && showProgress && vm.progress}
      <div class="progress-block">
        <span class="progress-primary">{vm.progress.primaryLabel}</span>
        {#if vm.progress.secondaryLabel}
          <span class="progress-secondary">{vm.progress.secondaryLabel}</span>
        {/if}
        {#if typeof vm.progress.percent === "number"}
          <div class="progress-track" aria-hidden="true">
            <div class="progress-fill" style={`width:${Math.max(0, Math.min(100, vm.progress.percent * 100))}%;`}></div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</button>

<style>
  .card {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
    display: flex;
    flex-direction: column;
    min-width: 0;
    color: inherit;
    border-radius: var(--radius-lg);
    transition: background var(--t-base), border-color var(--t-base);
  }

  .card.n-library-card {
    gap: var(--library-card-info-gap, calc(7px * var(--n-hud-scale, 1)));
    border-radius: 0;
    transition: transform 160ms ease, filter 160ms ease;
    contain: layout style;
  }

  .card.n-library-card:hover {
    transform: translateY(-2px);
  }

  .card-list {
    display: grid;
    grid-template-columns: calc(76px * var(--n-hud-scale, 1)) minmax(0, 1fr);
    gap: calc(16px * var(--n-hud-scale, 1));
    align-items: center;
    min-height: calc(122px * var(--n-hud-scale, 1));
    padding: calc(10px * var(--n-hud-scale, 1));
    border: 1px solid var(--border-dim);
    background: color-mix(in srgb, var(--bg-raised) 76%, transparent);
  }

  .card-compact {
    gap: calc(6px * var(--n-hud-scale, 1));
  }

  .card:hover .cover {
    filter: brightness(1.07);
  }

  .card.n-library-card:hover .cover {
    filter: brightness(1.06) saturate(1.04);
  }

  :global(.library-scroll-active) .card.n-library-card,
  :global(.library-scroll-active) .cover {
    transition: none;
  }

  :global(.library-scroll-active) .card.n-library-card:hover {
    transform: none;
  }

  :global(.library-scroll-active) .card:hover .cover,
  :global(.library-scroll-active) .card.n-library-card:hover .cover {
    filter: none;
  }

  .card-list:hover {
    background: color-mix(in srgb, var(--bg-raised) 92%, transparent);
    border-color: var(--border-strong);
  }

  .card:hover .title {
    color: var(--text-primary);
  }

  .card:focus-visible {
    outline: none;
  }

  .card:focus-visible .cover-wrap {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .card.card-selected .cover-wrap {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-md);
  }

  .card.card-list.card-selected {
    border-color: var(--accent-dim);
    background: color-mix(in srgb, var(--accent-muted) 68%, transparent);
  }

  .card.card-selected .title {
    color: var(--accent-fg);
  }

  .cover-wrap {
    position: relative;
    aspect-ratio: 2 / 3;
    container-type: inline-size;
    overflow: hidden;
    border-radius: var(--radius-md);
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .cover-wrap.n-library-card__cover {
    border-radius: var(--library-card-cover-radius, calc(16px * var(--n-hud-scale, 1)));
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(218, 207, 255, 0.16);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.08),
      0 2px 8px rgba(0, 0, 0, 0.24);
  }

  .card-list .cover-wrap {
    aspect-ratio: 2 / 3;
    align-self: stretch;
  }

  .card-outline-off .cover-wrap {
    border-color: transparent;
    box-shadow: none;
  }

  .card-outline-off.card-list {
    border-color: transparent;
    background: color-mix(in srgb, var(--bg-raised) 55%, transparent);
  }

  .card-outline-off.card-list:hover {
    background: color-mix(in srgb, var(--bg-raised) 88%, transparent);
  }

  .cover {
    width: 100%;
    height: 100%;
    transition: filter var(--t-base);
    display: block;
    background: var(--bg-raised);
  }

  .cover-fallback {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    background: linear-gradient(180deg, color-mix(in srgb, var(--bg-raised) 88%, white 12%), var(--bg-base));
  }

  .badge-cluster {
    position: absolute;
    display: flex;
    gap: 4px;
    z-index: 2;
    pointer-events: none;
  }

  .badge-cluster-top-left {
    top: var(--sp-1);
    left: var(--sp-1);
  }

  .badge-cluster-top-right {
    top: var(--sp-1);
    right: var(--sp-1);
  }

  .badge-cluster-bottom-left {
    bottom: var(--sp-1);
    left: var(--sp-1);
  }

  .badge {
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: bold;
    border-radius: var(--radius-sm);
  }

  .badge.n-library-card__badge {
    min-width: auto;
    min-height: var(--library-card-badge-height, calc(20px * var(--n-hud-scale, 1)));
    height: var(--library-card-badge-height, calc(20px * var(--n-hud-scale, 1)));
    padding: 0 var(--library-card-badge-padding-x, calc(7px * var(--n-hud-scale, 1)));
    border-radius: 9999px;
    background: rgba(36, 33, 43, 0.9);
    border: 1px solid rgba(184, 167, 234, 0.12);
    color: var(--n-primary, var(--accent-fg));
    font-family: var(--font-ui);
    font-size: var(--library-card-badge-font-size, 9px);
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    box-shadow: 0 8px 16px rgba(0, 0, 0, 0.18);
  }

  .n-library-card__cover > .n-library-card__badge {
    position: absolute;
    top: var(--library-card-badge-inset, var(--sp-2));
    right: var(--library-card-badge-inset, var(--sp-2));
    display: inline-flex;
    align-items: center;
    min-height: var(--library-card-badge-height, calc(20px * var(--n-hud-scale, 1)));
    padding: 0 var(--library-card-badge-padding-x, calc(7px * var(--n-hud-scale, 1)));
    border-radius: 9999px;
    background: rgba(36, 33, 43, 0.9);
    border: 1px solid rgba(184, 167, 234, 0.12);
    color: var(--n-primary, var(--accent-fg));
    font-family: var(--font-ui);
    font-size: var(--library-card-badge-font-size, 9px);
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    box-shadow: 0 8px 16px rgba(0, 0, 0, 0.18);
  }

  .badge-unread {
    background: color-mix(in srgb, var(--accent-muted) 32%, var(--bg-void));
    color: color-mix(in srgb, var(--accent-fg) 78%, var(--text-primary));
    border: 1px solid color-mix(in srgb, var(--accent-dim) 52%, var(--border-strong));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 8%, transparent);
  }

  .badge-download {
    background: color-mix(in srgb, var(--accent) 42%, var(--bg-void));
    color: var(--accent-fg);
    border: 1px solid var(--accent-dim);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent);
  }

  .badge-subtype {
    background: var(--bg-void);
    color: var(--text-primary);
    border: 1px solid var(--border-strong);
  }

  .badge-status {
    background: var(--accent-muted);
    color: var(--accent-fg);
    border: 1px solid var(--accent-dim);
  }

  .select-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.18);
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    padding: 6px;
    pointer-events: none;
  }

  .select-check {
    color: var(--text-faint);
    opacity: 0.7;
    transition: color var(--t-base), opacity var(--t-base);
  }

  .select-check.checked {
    color: var(--accent-fg);
    opacity: 1;
  }

  .select-check-empty {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    border: 2px solid var(--text-faint);
    background: rgba(0, 0, 0, 0.3);
  }

  .cover-progress-track {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 2;
    height: var(
      --library-card-progress-height,
      clamp(calc(3.5px * var(--n-hud-scale, 1)), 3.2cqw, calc(6px * var(--n-hud-scale, 1)))
    );
    border-radius: 0 0 inherit inherit;
    background: rgba(36, 33, 43, 0.72);
    overflow: hidden;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.08),
      0 -1px 0 rgba(255, 255, 255, 0.16);
    pointer-events: none;
  }

  .cover-progress-track::after {
    content: none;
  }

  .cover-progress-fill {
    display: block;
    position: relative;
    z-index: 1;
    width: var(--cover-progress-width, 0%);
    max-width: 100%;
    height: 100%;
    min-width: 0;
    overflow: hidden;
    border-radius: 0 999px 999px 0;
    background: linear-gradient(90deg, #8f7bd5 0%, #a996e8 55%, #b9a8ef 100%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.24),
      0 0 0 1px rgba(184, 167, 234, 0.2);
    clip-path: polygon(0 0, calc(100% - 3px) 0, 100% 20%, calc(100% - 1px) 48%, 100% 76%, calc(100% - 3px) 100%, 0 100%);
    transition: width 220ms cubic-bezier(0.2, 0.78, 0.24, 1);
  }

  .cover-progress-fill.has-visible-progress {
    min-width: max(calc(5px * var(--n-hud-scale, 1)), 3.2cqw);
  }

  .cover-progress-fill::before,
  .cover-progress-fill::after {
    content: "";
    position: absolute;
    pointer-events: none;
  }

  .cover-progress-fill::before {
    inset: 0 -132px 0 0;
    background-image:
      radial-gradient(circle at 18px 70%, rgba(255, 255, 255, 0.56) 0 1px, transparent 1.35px),
      radial-gradient(circle at 56px 38%, rgba(255, 255, 255, 0.36) 0 0.8px, transparent 1.2px),
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 132 12' preserveAspectRatio='none'%3E%3Cpath d='M0 5 C16 1 28 1 44 5 S72 9 88 5 S116 1 132 5 V12 H0 Z' fill='%23d8ccff'/%3E%3C/svg%3E");
    background-repeat: repeat-x;
    background-size: 74px 12px, 96px 12px, 132px 100%;
    background-position: 0 0, 0 0, 0 0;
    opacity: 0.6;
    animation: coverProgressLiquidFlow 6.8s steps(96, end) infinite;
    animation-play-state: paused;
  }

  .card.library-motion-running .cover-progress-fill::before {
    animation-play-state: running;
  }

  .cover-progress-fill::after {
    inset: 0;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.22), transparent 52%),
      linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.18) 58%, transparent 100%);
    opacity: 0.72;
  }

  @keyframes coverProgressLiquidFlow {
    from { background-position: 0 0, 0 0, 0 0; }
    to { background-position: -132px 0, -132px 0, -132px 0; }
  }

  :global([data-aethon-idle="true"]) .cover-progress-fill,
  :global([data-aethon-idle="true"]) .cover-progress-fill::before,
  :global([data-aethon-idle="true"]) .cover-progress-fill::after {
    animation-play-state: paused !important;
  }

  :global(.source-metric-banner.source-metric-banner-compact) {
    top: -4.5cqw;
    left: -4.5cqw;
  }

  .card-copy {
    display: flex;
    flex-direction: column;
    gap: var(--library-card-copy-gap, var(--sp-1));
    margin-top: var(--library-card-copy-margin-top, var(--sp-2));
    min-width: 0;
  }

  .card-copy.n-library-card__info {
    gap: var(--library-card-meta-gap, 3px);
    margin-top: 0;
  }

  .card-list .card-copy {
    margin-top: 0;
    justify-content: center;
    gap: var(--sp-2);
  }

  .card-compact .card-copy {
    margin-top: 0;
    gap: 0;
  }

  .title {
    min-height: calc(var(--leading-snug) * 2em);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: var(--leading-snug);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    transition: color var(--t-base);
  }

  .title.n-library-card__title {
    min-height: calc(var(--leading-snug) * 2em);
    color: rgba(255, 255, 255, 0.92);
    font-size: var(--library-card-title-font-size, var(--text-xs));
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.7);
  }

  .card-list .title {
    min-height: 0;
    -webkit-line-clamp: 1;
  }

  .card-compact .title {
    font-size: var(--library-card-title-font-size, var(--text-xs));
    min-height: calc(var(--leading-snug) * 2em);
  }

  .subtitle {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wide);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .subtitle.n-library-card__author {
    font-size: var(--library-card-meta-font-size, 9px);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.45);
  }

  .n-library-card__meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    min-width: 0;
  }

  .n-library-card__author,
  .n-library-card__vol {
    font-family: var(--font-ui);
    font-size: var(--library-card-meta-font-size, 9px);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.45);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .n-library-card__vol {
    color: rgba(255, 255, 255, 0.7);
    flex-shrink: 0;
  }

  .card-compact .subtitle,
  .card-compact .progress-primary {
    font-size: var(--text-2xs);
  }

  .meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .meta-chip {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wide);
    padding: 2px 6px;
    border: 1px solid var(--border-dim);
    border-radius: var(--radius-sm);
    background: var(--bg-raised);
  }

  .meta-chip-badge {
    background: color-mix(in srgb, var(--bg-base) 82%, transparent);
  }

  .meta-chip-subtype {
    color: var(--text-primary);
  }

  .meta-chip-status,
  .meta-chip-download {
    color: var(--accent-fg);
    border-color: var(--accent-dim);
    background: color-mix(in srgb, var(--accent-muted) 80%, transparent);
  }

  .meta-chip-unread {
    color: color-mix(in srgb, var(--accent-fg) 78%, var(--text-primary));
    border-color: color-mix(in srgb, var(--accent-dim) 52%, var(--border-strong));
    background: color-mix(in srgb, var(--accent-muted) 40%, var(--bg-raised));
  }

  .progress-block {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .progress-primary {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .progress-secondary {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wide);
  }

  .progress-track {
    width: 100%;
    height: 4px;
    border-radius: 999px;
    background: var(--bg-raised);
    overflow: hidden;
    border: 1px solid var(--border-dim);
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
  }
</style>
