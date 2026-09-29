<script lang="ts">
  import ReaderHud from "./ReaderHud.svelte";

  type Props = {
    domain: "comics" | "books";
    uiVisible?: boolean;
    isBookmarked?: boolean;
    ondetach?: () => void;
  };

  let { domain, uiVisible = true, isBookmarked = false, ondetach }: Props = $props();
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
>
  <div data-testid="hud-content">{domain} content</div>
  {#snippet settingsPopover()}
    <div data-testid="hud-settings-popover">settings content</div>
  {/snippet}
</ReaderHud>
