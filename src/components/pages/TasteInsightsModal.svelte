<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import type { TasteProfile, RecommendationItem } from "../../lib/recommendations/types";
  import { X, Info, BookOpen, Sparkle, Star } from "phosphor-svelte";
  import { setNavPage } from "../../store/state.svelte";

  let { profile, items, contentType, onClose } = $props<{
    profile: TasteProfile;
    items: RecommendationItem[];
    contentType: "manga" | "novels";
    onClose: () => void;
  }>();

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
        const name = format === "novel" ? "Web Novel" : format === "manga" ? "Manga" : format === "manhwa" ? "Manhwa" : format === "manhua" ? "Manhua" : format === "book" ? "E-Book" : format.charAt(0).toUpperCase() + format.slice(1);
        return {
          name,
          weight: Math.round(normalized * 100),
          rawWeight,
          label: normalized > 0.5 ? "Primary Focus" : normalized > 0.15 ? "Secondary" : "Unexplored"
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
          { name: "Royal Road", detail: "Unlocks 15 recommended LN titles", pkg: "ext.royalroad" },
          { name: "Scribble Hub", detail: "Unlocks 8 recommended LN titles", pkg: "ext.scribblehub" },
          { name: "NovelFull", detail: "Unlocks 5 recommended LN titles", pkg: "ext.novelfull" }
        ]
      : [
          { name: "MangaDex", detail: "Unlocks 24 recommended manga titles", pkg: "ext.mangadex" },
          { name: "Asura Scans", detail: "Unlocks 12 recommended manga titles", pkg: "ext.asura" },
          { name: "MangaLife", detail: "Unlocks 9 recommended manga titles", pkg: "ext.mangalife" }
        ]
  );

  function goToExtensions() {
    setNavPage("extensions");
    onClose();
  }
</script>

<div class="insights-backdrop" transition:fade onclick={onClose} role="presentation">
  <div class="insights-surface" transition:fly={{ y: 20, duration: 200 }} onclick={(e) => e.stopPropagation()} role="presentation">
    <header class="insights-header">
      <div class="insights-header-text">
        <h2>Taste Insights & Analytics</h2>
        <p class="subtitle">Built from {profile.seedCount} entries in your library</p>
      </div>
      <button class="insights-close-btn" onclick={onClose} aria-label="Close Insights">
        <X size={22} weight="bold" />
      </button>
    </header>

    <div class="insights-content">
      <!-- Grid layout -->
      <div class="insights-grid">
        
        <!-- Genre Affinity Chart -->
        <section class="insights-card">
          <div class="insights-section-title">
            <Sparkle size={16} weight="fill" style="color: var(--accent-bright, #9c27b0)" />
            <h3>Top Genre & Tag Affinities</h3>
          </div>
          <p class="section-desc">Relative preference strength calculated from your reading list ratings and completion rates.</p>
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
              <p class="empty-state">No tags found. Add more ratings to warm up your profile.</p>
            {/if}
          </div>
        </section>

        <!-- Preferred Mediums -->
        <section class="insights-card">
          <div class="insights-section-title">
            <BookOpen size={16} weight="fill" style="color: var(--accent-bright, #9c27b0)" />
            <h3>Format Preferences</h3>
          </div>
          <p class="section-desc">Format match percentages mapped across catalog results.</p>
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
            <Info size={16} weight="fill" style="color: var(--accent-bright, #9c27b0)" />
            <h3>Recommendation Score Breakdown</h3>
          </div>
          <p class="section-desc">Average factor weight distributions across your current recommended picks.</p>
          <div class="breakdown-grid">
            <div class="breakdown-item">
              <span class="breakdown-label">Personal Affinity</span>
              <div class="breakdown-metric">
                <div class="metric-circle-container">
                  <span class="metric-number">{averages.personal}%</span>
                </div>
                <p>Matches rated title tags</p>
              </div>
            </div>
            <div class="breakdown-item">
              <span class="breakdown-label">Consensus Score</span>
              <div class="breakdown-metric">
                <div class="metric-circle-container">
                  <span class="metric-number">{averages.consensus}%</span>
                </div>
                <p>Tracker review consensus</p>
              </div>
            </div>
            <div class="breakdown-item">
              <span class="breakdown-label">Trending Velocity</span>
              <div class="breakdown-metric">
                <div class="metric-circle-container">
                  <span class="metric-number">{averages.trending}%</span>
                </div>
                <p>Global interest momentum</p>
              </div>
            </div>
            <div class="breakdown-item">
              <span class="breakdown-label">Novelty / Freshness</span>
              <div class="breakdown-metric">
                <div class="metric-circle-container">
                  <span class="metric-number">{averages.novelty}%</span>
                </div>
                <p>Discover diversity variance</p>
              </div>
            </div>
          </div>
        </section>

        <!-- Extensions Recommendations -->
        <section class="insights-card insights-card--span">
          <div class="insights-section-title">
            <Star size={16} weight="fill" style="color: var(--accent-bright, #9c27b0)" />
            <h3>Recommended Extensions</h3>
          </div>
          <p class="section-desc">Unlock more recommendation picks by installing these content plugins.</p>
          <div class="ext-rec-list">
            {#each recommendedExtensions as ext}
              <div class="ext-rec-row">
                <div class="ext-rec-info">
                  <span class="ext-rec-name">{ext.name}</span>
                  <span class="ext-rec-detail">{ext.detail}</span>
                </div>
                <button class="ext-rec-btn" onclick={goToExtensions}>
                  Browse Extensions
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
    background: rgba(10, 10, 12, 0.82);
    backdrop-filter: blur(12px);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
  }

  .insights-surface {
    background: linear-gradient(180deg, rgba(27, 25, 36, 0.98) 0%, rgba(16, 16, 22, 0.99) 100%);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 20px;
    width: 100%;
    max-width: 980px;
    max-height: 92vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    box-shadow:
      0 32px 80px rgba(0, 0, 0, 0.65),
      inset 0 1px 0 rgba(255, 255, 255, 0.03);
    font-family: var(--font-sans, sans-serif);
    -webkit-font-smoothing: antialiased;
    color: var(--n-on-surface, #ffffff);
  }

  .insights-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 28px 32px 22px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }

  .insights-header-text h2 {
    font-size: 24px;
    font-weight: 800;
    color: rgba(255, 255, 255, 0.96);
    margin: 0 0 6px;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }

  .insights-header-text .subtitle {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-faint, rgba(255, 255, 255, 0.45));
    margin: 0;
  }

  .insights-close-btn {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.5);
    border-radius: 50%;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .insights-close-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.16);
    color: rgba(255, 255, 255, 0.9);
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
    background: rgba(255, 255, 255, 0.015);
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: 16px;
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
    color: rgba(255, 255, 255, 0.92);
    margin: 0;
  }

  .section-desc {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.44);
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
    color: rgba(255, 255, 255, 0.78);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: 0.02em;
  }

  .affinity-track {
    flex: 1;
    height: 10px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 99px;
    overflow: hidden;
    position: relative;
  }

  .affinity-fill {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    border-radius: 99px;
    background: linear-gradient(90deg, rgba(156, 39, 176, 0.5), rgba(156, 39, 176, 0.9));
  }

  .affinity-fill.is-negative {
    background: linear-gradient(90deg, rgba(244, 67, 54, 0.5), rgba(244, 67, 54, 0.9));
  }

  .affinity-val {
    font-size: 12.5px;
    font-weight: 750;
    width: 58px;
    text-align: right;
    color: var(--accent-bright, #ba68c8);
  }

  .affinity-val.is-negative {
    color: #e57373;
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
    color: rgba(255, 255, 255, 0.9);
  }

  .format-badge {
    font-size: 10.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.05);
    color: rgba(255, 255, 255, 0.38);
  }

  .format-badge.is-active {
    background: rgba(156, 39, 176, 0.1);
    border-color: rgba(156, 39, 176, 0.25);
    color: #ce93d8;
  }

  .format-gauge {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .format-gauge-fill {
    flex: 1;
    height: 10px;
    background: var(--accent-bright, #ba68c8);
    border-radius: 99px;
    opacity: 0.85;
  }

  .format-val {
    font-size: 13px;
    font-weight: 750;
    color: rgba(255, 255, 255, 0.9);
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
    background: rgba(255, 255, 255, 0.01);
    border: 1px solid rgba(255, 255, 255, 0.03);
    border-radius: 12px;
    padding: 18px 14px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .breakdown-label {
    font-size: 11px;
    font-weight: 750;
    color: rgba(255, 255, 255, 0.55);
    margin-bottom: 14px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .metric-circle-container {
    background: rgba(156, 39, 176, 0.06);
    border: 1px solid rgba(156, 39, 176, 0.16);
    border-radius: 50%;
    width: 62px;
    height: 62px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 14px;
    box-shadow: 0 0 12px rgba(156, 39, 176, 0.05);
  }

  .metric-number {
    font-size: 16px;
    font-weight: 850;
    color: #e1bee7;
  }

  .breakdown-metric {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .breakdown-metric p {
    font-size: 11.5px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.44);
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
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: 12px;
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
    color: rgba(255, 255, 255, 0.94);
  }

  .ext-rec-detail {
    font-size: 11.5px;
    color: rgba(255, 255, 255, 0.44);
  }

  .ext-rec-btn {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.82);
    font-size: 12px;
    font-weight: 650;
    padding: 8px 18px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 150ms ease;
    white-space: nowrap;
  }

  .ext-rec-btn:hover {
    background: rgba(156, 39, 176, 0.12);
    border-color: rgba(156, 39, 176, 0.35);
    color: #f3e5f5;
  }

  .empty-state {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.38);
    text-align: center;
    margin: 16px 0;
  }
</style>
