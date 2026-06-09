<script lang="ts">
  import type { LibrarySourceMetricBannerVM } from "../../lib/library/contracts";

  type Props = {
    banner: LibrarySourceMetricBannerVM;
  };

  let { banner }: Props = $props();

  const flagText = $derived((banner.flagLabel || "SRC").slice(0, 3).toUpperCase());
  const label = $derived(
    `${flagText} source, ${banner.downloadedCount} downloaded chapters, ${banner.newCount} new chapters`,
  );
</script>

<div class="source-metric-banner" aria-label={label}>
  <span class="source-metric-banner__downloaded">{banner.downloadedCount}</span>
  <span class="source-metric-banner__new">{banner.newCount}</span>
  <span class="source-metric-banner__flag" aria-hidden="true">
    <span>{flagText}</span>
  </span>
</div>

<style>
  .source-metric-banner {
    --banner-h: calc(30px * var(--n-hud-scale, 1));
    --flag-size: calc(43px * var(--n-hud-scale, 1));
    --dark-w: calc(56px * var(--n-hud-scale, 1));
    --new-w: calc(50px * var(--n-hud-scale, 1));
    position: absolute;
    top: calc(8px * var(--n-hud-scale, 1));
    left: calc(-9px * var(--n-hud-scale, 1));
    width: calc(var(--flag-size) + var(--dark-w) + var(--new-w) - 8px);
    height: var(--flag-size);
    z-index: 4;
    pointer-events: none;
    filter: drop-shadow(0 8px 13px rgba(0, 0, 0, 0.48));
  }

  .source-metric-banner__downloaded,
  .source-metric-banner__new {
    position: absolute;
    top: calc((var(--flag-size) - var(--banner-h)) / 2);
    height: var(--banner-h);
    display: grid;
    place-items: center;
    font-family: var(--font-ui);
    font-size: calc(14px * var(--n-hud-scale, 1));
    font-weight: 800;
    line-height: 1;
    letter-spacing: 0;
    border: 1px solid color-mix(in srgb, var(--border-strong) 72%, transparent);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.08),
      inset 0 -1px 0 rgba(0, 0, 0, 0.36);
  }

  .source-metric-banner__downloaded {
    left: calc(var(--flag-size) - 10px);
    width: var(--dark-w);
    padding-left: calc(8px * var(--n-hud-scale, 1));
    color: var(--text-primary);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--bg-subtle) 82%, white 6%), var(--bg-raised)),
      var(--bg-raised);
    clip-path: polygon(0 0, 100% 0, calc(100% - 12px) 100%, 0 100%);
  }

  .source-metric-banner__new {
    left: calc(var(--flag-size) + var(--dark-w) - 20px);
    width: var(--new-w);
    padding-left: calc(6px * var(--n-hud-scale, 1));
    color: color-mix(in srgb, var(--bg-void) 78%, black);
    background:
      linear-gradient(180deg, var(--accent-bright), var(--accent)),
      var(--accent);
    border-color: color-mix(in srgb, var(--accent-bright) 52%, var(--border-strong));
    border-radius: 0 calc(15px * var(--n-hud-scale, 1)) calc(15px * var(--n-hud-scale, 1)) 0;
    clip-path: polygon(16px 0, 100% 0, 100% 100%, 0 100%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.22),
      inset 0 -1px 0 rgba(0, 0, 0, 0.2);
  }

  .source-metric-banner__flag {
    position: absolute;
    inset: 0 auto auto 0;
    width: var(--flag-size);
    height: var(--flag-size);
    display: grid;
    place-items: center;
    border-radius: 999px;
    color: var(--text-primary);
    background:
      linear-gradient(90deg, transparent 42%, rgba(240, 239, 236, 0.86) 42% 58%, transparent 58%),
      linear-gradient(0deg, transparent 42%, rgba(240, 239, 236, 0.86) 42% 58%, transparent 58%),
      linear-gradient(145deg, transparent 36%, rgba(143, 184, 143, 0.7) 36% 45%, transparent 45%),
      radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--bg-subtle) 78%, var(--accent-muted)), var(--bg-base) 72%);
    border: 1px solid color-mix(in srgb, var(--text-primary) 16%, var(--border-strong));
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--bg-void) 72%, transparent),
      inset 0 1px 0 rgba(255, 255, 255, 0.14),
      inset 0 -8px 16px rgba(0, 0, 0, 0.38);
  }

  .source-metric-banner__flag span {
    position: relative;
    display: grid;
    place-items: center;
    min-width: calc(18px * var(--n-hud-scale, 1));
    height: calc(14px * var(--n-hud-scale, 1));
    padding: 0 calc(3px * var(--n-hud-scale, 1));
    border-radius: 999px;
    background: rgba(8, 8, 8, 0.62);
    color: var(--accent-fg);
    font-family: var(--font-ui);
    font-size: calc(8px * var(--n-hud-scale, 1));
    font-weight: 800;
    line-height: 1;
    letter-spacing: 0;
  }
</style>
