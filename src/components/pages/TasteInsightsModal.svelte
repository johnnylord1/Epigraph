<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { fade, fly } from "svelte/transition";
  import { onMount } from "svelte";
  import type { TasteProfile, RecommendationItem } from "../../lib/recommendations/types";
  import { X, Info, BookOpen, Sparkle, Star } from "phosphor-svelte";
  import { openSearchSources } from "../../store/state.svelte";

  let { profile, items, contentType, onClose } = $props<{
    profile: TasteProfile;
    items: RecommendationItem[];
    contentType: "manga" | "novels";
    onClose: () => void;
  }>();

  let backdropElement: HTMLDivElement;
  let surfaceElement: HTMLDivElement;

  const FOCUSABLE_SELECTOR = [
    "button:not([disabled])",
    "a[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  function focusableElements() {
    return Array.from(surfaceElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  }

  onMount(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inertedSiblings: HTMLElement[] = [];
    let branch: HTMLElement = backdropElement;

    while (branch.parentElement) {
      const parent = branch.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === branch || !(sibling instanceof HTMLElement) || sibling.inert) continue;
        sibling.inert = true;
        inertedSiblings.push(sibling);
      }
      branch = parent;
      if (parent === document.body) break;
    }

    const initialFocusTimer = window.setTimeout(() => {
      (focusableElements()[0] ?? surfaceElement).focus({ preventScroll: true });
    });

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        surfaceElement.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !surfaceElement.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !surfaceElement.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }

    document.addEventListener("keydown", handleKeydown, true);
    return () => {
      window.clearTimeout(initialFocusTimer);
      document.removeEventListener("keydown", handleKeydown, true);
      for (const sibling of inertedSiblings) sibling.inert = false;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  });

  // Extract all tag weights sorted descending
  const tagAffinities = $derived.by(() => {
    return [...profile.tagWeights.entries()]
      .map(([name, weight]) => ({ name, weight }))
      .sort((a, b) => b.weight - a.weight);
  });

  // Extract content format weights normalized relative to the maximum weight
  const formats = $derived.by(() => {
    const maxWeight = Math.max(0.0001, ...profile.contentTypeWeights.values());
    return [...profile.contentTypeWeights.entries()]
      .map(([format, weight]) => {
        const rawWeight = weight;
        const normalized = Math.max(0, Math.min(1, weight / maxWeight));
        const formatKeys: Record<string, string> = { novel: "taste_formatWebNovel", manga: "taste_formatManga", manhwa: "taste_formatManhwa", manhua: "taste_formatManhua", book: "taste_formatEbook" };
        const name = formatKeys[format] ? translate(formatKeys[format]) : format.charAt(0).toUpperCase() + format.slice(1);
        return {
          name,
          weight: Math.round(normalized * 100),
          rawWeight,
          label: normalized > 0.5 ? translate("ui_primaryFocus") : normalized > 0.15 ? translate("ui_secondary") : translate("ui_unexplored")
        };
      })
      .sort((a, b) => b.rawWeight - a.rawWeight);
  });

  // Calculate dynamic breakdown averages across recommended items
  const averages = $derived.by(() => {
    if (!items.length) {
      return { personal: 0, similarity: 0, consensus: 0, trending: 0, recency: 0, availability: 0, novelty: 0 };
    }
    let personal = 0, similarity = 0, consensus = 0, trending = 0, recency = 0, availability = 0, novelty = 0;
    for (const item of items) {
      personal += item.breakdown.personalRatingAffinity;
      similarity += item.breakdown.contentSimilarity;
      consensus += item.breakdown.trackerConsensus;
      trending += item.breakdown.trendingVelocity;
      recency += item.breakdown.recency;
      availability += item.breakdown.sourceAvailability;
      novelty += item.breakdown.novelty;
    }
    const len = items.length;
    return {
      personal: Math.round((personal / len) * 100),
      similarity: Math.round((similarity / len) * 100),
      consensus: Math.round((consensus / len) * 100),
      trending: Math.round((trending / len) * 100),
      recency: Math.round((recency / len) * 100),
      availability: Math.round((availability / len) * 100),
      novelty: Math.round((novelty / len) * 100),
    };
  });

  // Extension Recommendations
  const recommendedExtensions = $derived(
    contentType === "novels"
      ? [
          { name: "Royal Road", detail: translate("ui_unlocks15RecommendedLnTitles"), pkg: "ext.royalroad" },
          { name: "Scribble Hub", detail: translate("ui_unlocks8RecommendedLnTitles"), pkg: "ext.scribblehub" },
          { name: "NovelFull", detail: translate("ui_unlocks5RecommendedLnTitles"), pkg: "ext.novelfull" }
        ]
      : [
          { name: "MangaDex", detail: translate("ui_unlocks24RecommendedMangaTitles"), pkg: "ext.mangadex" },
          { name: "Asura Scans", detail: translate("ui_unlocks12RecommendedMangaTitles"), pkg: "ext.asura" },
          { name: "MangaLife", detail: translate("ui_unlocks9RecommendedMangaTitles"), pkg: "ext.mangalife" }
        ]
  );

  function goToExtensions() {
    openSearchSources("extensions");
    onClose();
  }
</script>

<div
  class="insights-backdrop"
  bind:this={backdropElement}
  transition:fade
  onclick={(event) => event.target === event.currentTarget && onClose()}
  role="presentation"
>
  <div
    class="insights-surface"
    bind:this={surfaceElement}
    transition:fly={{ y: 20, duration: 200 }}
    role="dialog"
    aria-modal="true"
    aria-labelledby="taste-insights-title"
    aria-describedby="taste-insights-subtitle"
    tabindex="-1"
  >
    <header class="insights-header">
      <div class="insights-header-text">
        <h2 id="taste-insights-title">{$_("ui_tasteInsightsAnalytics")}</h2>
        <p id="taste-insights-subtitle" class="subtitle">{$_("ui_builtFrom")} {profile.seedCount} {$_("ui_entriesInYourLibrary")}</p>
      </div>
      <button class="insights-close-btn" onclick={onClose} aria-label={$_("ui_closeInsights")}>
        <X size={22} weight="bold" />
      </button>
    </header>

    <div class="insights-content">
      <!-- Grid layout -->
      <div class="insights-grid">
        
        <!-- Genre Affinity Chart -->
        <section class="insights-card">
          <div class="insights-section-title">
            <Sparkle size={16} weight="fill" style="color: var(--component-taste-insights-accent)" />
            <h3>{$_("ui_topGenreTagAffinities")}</h3>
          </div>
          <p class="section-desc">{$_("ui_relativePreferenceStrengthCalculatedFromYourReadingList")}</p>
          <div class="affinity-list">
            {#if tagAffinities.length > 0}
              {#each tagAffinities.slice(0, 8) as tag}
                <div class="affinity-row">
                  <span class="affinity-tag">{tag.name.toUpperCase()}</span>
                  <div class="affinity-track">
                    <span 
                      class="affinity-fill" 
                      class:is-negative={tag.weight < 0}
                      style="width: {Math.min(100, Math.abs(tag.weight) * 60)}%"
                    ></span>
                  </div>
                  <span class="affinity-val" class:is-negative={tag.weight < 0}>
                    {tag.weight > 0 ? "+" : ""}{tag.weight.toFixed(2)}
                  </span>
                </div>
              {/each}
            {:else}
              <p class="empty-state">{$_("ui_noTagsFoundAddMoreRatingsToWarm")}</p>
            {/if}
          </div>
        </section>

        <!-- Preferred Mediums -->
        <section class="insights-card">
          <div class="insights-section-title">
            <BookOpen size={16} weight="fill" style="color: var(--component-taste-insights-accent)" />
            <h3>{$_("ui_formatPreferences")}</h3>
          </div>
          <p class="section-desc">{$_("ui_formatMatchPercentagesMappedAcrossCatalogResults")}</p>
          <div class="format-list">
            {#each formats as fmt}
              <div class="format-row">
                <div class="format-info">
                  <span class="format-name">{fmt.name}</span>
                  <span class="format-badge" class:is-active={fmt.rawWeight > 0.15}>{fmt.label}</span>
                </div>
                <div class="format-gauge">
                  <div class="format-gauge-fill" style="width: {Math.max(0, fmt.weight)}%"></div>
                  <span class="format-val">{fmt.weight}%</span>
                </div>
              </div>
            {/each}
          </div>
        </section>

        <!-- Recommendation Weights -->
        <section class="insights-card insights-card--span">
          <div class="insights-section-title">
            <Info size={16} weight="fill" style="color: var(--component-taste-insights-accent)" />
            <h3>{$_("ui_recommendationScoreBreakdown")}</h3>
          </div>
          <p class="section-desc">{$_("ui_averageFactorWeightDistributionsAcrossYourCurrentRecommended")}</p>
          <div class="breakdown-grid">
            <div class="breakdown-item">
              <span class="breakdown-label">{$_("ui_personalAffinity")}</span>
              <div class="breakdown-metric">
                <div class="metric-circle-container">
                  <span class="metric-number">{averages.personal}%</span>
                </div>
                <p>{$_("ui_matchesRatedTitleTags")}</p>
              </div>
            </div>
            <div class="breakdown-item">
              <span class="breakdown-label">{$_("ui_consensusScore")}</span>
              <div class="breakdown-metric">
                <div class="metric-circle-container">
                  <span class="metric-number">{averages.consensus}%</span>
                </div>
                <p>{$_("ui_trackerReviewConsensus")}</p>
              </div>
            </div>
            <div class="breakdown-item">
              <span class="breakdown-label">{$_("ui_trendingVelocity")}</span>
              <div class="breakdown-metric">
                <div class="metric-circle-container">
                  <span class="metric-number">{averages.trending}%</span>
                </div>
                <p>{$_("ui_globalInterestMomentum")}</p>
              </div>
            </div>
            <div class="breakdown-item">
              <span class="breakdown-label">{$_("ui_noveltyFreshness")}</span>
              <div class="breakdown-metric">
                <div class="metric-circle-container">
                  <span class="metric-number">{averages.novelty}%</span>
                </div>
                <p>{$_("ui_discoverDiversityVariance")}</p>
              </div>
            </div>
          </div>
        </section>

        <!-- Extensions Recommendations -->
        <section class="insights-card insights-card--span">
          <div class="insights-section-title">
            <Star size={16} weight="fill" style="color: var(--component-taste-insights-accent)" />
            <h3>{$_("ui_recommendedExtensions")}</h3>
          </div>
          <p class="section-desc">{$_("ui_unlockMoreRecommendationPicksByInstallingTheseContent")}</p>
          <div class="ext-rec-list">
            {#each recommendedExtensions as ext}
              <div class="ext-rec-row">
                <div class="ext-rec-info">
                  <span class="ext-rec-name">{ext.name}</span>
                  <span class="ext-rec-detail">{ext.detail}</span>
                </div>
                <button class="ext-rec-btn" onclick={goToExtensions}>
                  {$_("ui_browseExtensions")}
                </button>
              </div>
            {/each}
          </div>
        </section>

      </div>
    </div>
  </div>
</div>

<style>
  .insights-backdrop {
    position: fixed;
    inset: 0;
    background: var(--component-taste-insights-backdrop-bg);
    backdrop-filter: var(--component-taste-insights-backdrop-blur);
    z-index: var(--component-taste-insights-z-index);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
  }

  .insights-surface {
    background: var(--component-taste-insights-surface-bg);
    border: 1px solid var(--component-taste-insights-surface-border);
    border-radius: var(--component-taste-insights-surface-radius);
    width: 100%;
    max-width: 980px;
    max-height: 92vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    box-shadow: var(--component-taste-insights-surface-shadow);
    font-family: var(--font-sans, sans-serif);
    -webkit-font-smoothing: antialiased;
    color: var(--component-taste-insights-fg);
  }

  .insights-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 28px 32px 22px;
    border-bottom: 1px solid var(--component-taste-insights-divider);
  }

  .insights-header-text h2 {
    font-size: 24px;
    font-weight: 800;
    color: var(--component-taste-insights-title-fg);
    margin: 0 0 6px;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }

  .insights-header-text .subtitle {
    font-size: 13px;
    font-weight: 500;
    color: var(--component-taste-insights-muted-fg);
    margin: 0;
  }

  .insights-close-btn {
    background: var(--component-taste-insights-close-bg);
    border: 1px solid var(--component-taste-insights-close-border);
    color: var(--component-taste-insights-close-fg);
    border-radius: var(--component-taste-insights-close-radius);
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: var(--component-taste-insights-control-transition);
  }

  .insights-close-btn:hover {
    background: var(--component-taste-insights-close-hover-bg);
    border-color: var(--component-taste-insights-close-hover-border);
    color: var(--component-taste-insights-close-hover-fg);
  }

  .insights-close-btn:focus-visible,
  .ext-rec-btn:focus-visible {
    outline: none;
    box-shadow: var(--component-taste-insights-focus-ring);
  }

  .insights-content {
    padding: 32px;
    overflow-y: auto;
    flex: 1;
  }

  .insights-grid {
    display: grid;
    grid-template-columns: 1.15fr 1fr;
    gap: 28px;
  }

  @media (max-width: 768px) {
    .insights-grid {
      grid-template-columns: 1fr;
      gap: 20px;
    }
    .insights-card--span {
      grid-column: span 1 !important;
    }
  }

  .insights-card {
    background: var(--component-taste-insights-card-bg);
    border: 1px solid var(--component-taste-insights-card-border);
    border-radius: var(--component-taste-insights-card-radius);
    padding: 24px;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }

  .insights-card--span {
    grid-column: span 2;
  }

  .insights-section-title {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
  }

  .insights-section-title h3 {
    font-size: 17px;
    font-weight: 750;
    color: var(--component-taste-insights-title-fg);
    margin: 0;
  }

  .section-desc {
    font-size: 12px;
    color: var(--component-taste-insights-muted-fg);
    margin: 0 0 20px;
    line-height: 1.4;
  }

  /* Genre affinities */
  .affinity-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 1;
    justify-content: center;
  }

  .affinity-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }

  .affinity-tag {
    font-size: 11px;
    font-weight: 750;
    width: 108px;
    color: var(--component-taste-insights-button-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: 0.02em;
  }

  .affinity-track {
    flex: 1;
    height: 10px;
    background: var(--component-taste-insights-track-bg);
    border-radius: var(--component-taste-insights-track-radius);
    overflow: hidden;
    position: relative;
  }

  .affinity-fill {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    border-radius: var(--component-taste-insights-track-radius);
    background: var(--component-taste-insights-positive-fill);
  }

  .affinity-fill.is-negative {
    background: var(--component-taste-insights-negative-fill);
  }

  .affinity-val {
    font-size: 12.5px;
    font-weight: 750;
    width: 58px;
    text-align: right;
    color: var(--component-taste-insights-accent);
  }

  .affinity-val.is-negative {
    color: var(--component-taste-insights-danger);
  }

  /* FormatPreferences */
  .format-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
    justify-content: center;
    flex: 1;
  }

  .format-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .format-info {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .format-name {
    font-size: 13.5px;
    font-weight: 750;
    color: var(--component-taste-insights-title-fg);
  }

  .format-badge {
    font-size: 10.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: var(--component-taste-insights-badge-radius);
    background: var(--component-taste-insights-badge-bg);
    border: 1px solid var(--component-taste-insights-badge-border);
    color: var(--component-taste-insights-badge-fg);
  }

  .format-badge.is-active {
    background: var(--component-taste-insights-badge-active-bg);
    border-color: var(--component-taste-insights-badge-active-border);
    color: var(--component-taste-insights-badge-active-fg);
  }

  .format-gauge {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .format-gauge-fill {
    flex: 1;
    height: 10px;
    background: var(--component-taste-insights-accent);
    border-radius: var(--component-taste-insights-track-radius);
    opacity: var(--component-taste-insights-gauge-opacity);
  }

  .format-val {
    font-size: 13px;
    font-weight: 750;
    color: var(--component-taste-insights-title-fg);
    width: 44px;
    text-align: right;
  }

  /* Recommendation Breakdown */
  .breakdown-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 22px;
  }

  @media (max-width: 600px) {
    .breakdown-grid {
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
  }

  .breakdown-item {
    background: var(--component-taste-insights-card-bg);
    border: 1px solid var(--component-taste-insights-card-border);
    border-radius: var(--component-taste-insights-row-radius);
    padding: 18px 14px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .breakdown-label {
    font-size: 11px;
    font-weight: 750;
    color: var(--component-taste-insights-muted-fg);
    margin-bottom: 14px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .metric-circle-container {
    background: var(--component-taste-insights-metric-bg);
    border: 1px solid var(--component-taste-insights-metric-border);
    border-radius: var(--component-taste-insights-metric-radius);
    width: 62px;
    height: 62px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 14px;
    box-shadow: var(--component-taste-insights-metric-shadow);
  }

  .metric-number {
    font-size: 16px;
    font-weight: 850;
    color: var(--component-taste-insights-accent);
  }

  .breakdown-metric {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .breakdown-metric p {
    font-size: 11.5px;
    font-weight: 500;
    color: var(--component-taste-insights-muted-fg);
    margin: 0;
    line-height: 1.35;
  }

  /* Extensions recommended list */
  .ext-rec-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .ext-rec-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    background: var(--component-taste-insights-row-bg);
    border: 1px solid var(--component-taste-insights-row-border);
    border-radius: var(--component-taste-insights-row-radius);
    gap: 18px;
  }

  .ext-rec-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .ext-rec-name {
    font-size: 14px;
    font-weight: 750;
    color: var(--component-taste-insights-title-fg);
  }

  .ext-rec-detail {
    font-size: 11.5px;
    color: var(--component-taste-insights-muted-fg);
  }

  .ext-rec-btn {
    background: var(--component-taste-insights-button-bg);
    border: 1px solid var(--component-taste-insights-button-border);
    color: var(--component-taste-insights-button-fg);
    font-size: 12px;
    font-weight: 650;
    padding: 8px 18px;
    border-radius: var(--component-taste-insights-button-radius);
    cursor: pointer;
    transition: var(--component-taste-insights-control-transition);
    white-space: nowrap;
  }

  .ext-rec-btn:hover {
    background: var(--component-taste-insights-button-hover-bg);
    border-color: var(--component-taste-insights-button-hover-border);
    color: var(--component-taste-insights-button-hover-fg);
  }

  .empty-state {
    font-size: 12px;
    color: var(--component-taste-insights-muted-fg);
    text-align: center;
    margin: 16px 0;
  }
</style>
