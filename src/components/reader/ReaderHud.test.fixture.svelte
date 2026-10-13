<script lang="ts">
  import ReaderHud, { type ReaderHudZoom } from "./ReaderHud.svelte";

  type Props = {
    domain: "comics" | "books";
    uiVisible?: boolean;
    isBookmarked?: boolean;
    ondetach?: () => void;
    zoom?: ReaderHudZoom;
  };

  let { domain, uiVisible = true, isBookmarked = false, ondetach, zoom }: Props = $props();
</script>

<ReaderHud
  title={`${domain} title`}
  chapterTitle={`${domain} chapter`}
  progressLabel={`${domain} progress`}
  sliderValue={5}
  sliderMax={10}
  sliderPct={50}
  {isBookmarked}
  {uiVisible}
  {ondetach}
  {zoom}
>
  <div data-testid="hud-content">{domain} content</div>
  {#snippet settingsPopover()}
    <div data-testid="hud-settings-popover">settings content</div>
  {/snippet}
</ReaderHud>
