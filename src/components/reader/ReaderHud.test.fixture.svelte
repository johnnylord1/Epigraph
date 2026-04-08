<script lang="ts">
  import ReaderHud from "./ReaderHud.svelte";

  type Props = {
    domain: "comics" | "books";
    uiVisible?: boolean;
  };

  let { domain, uiVisible = true }: Props = $props();
</script>

<ReaderHud {uiVisible}>
  {#snippet topbarLeft()}
    <span data-testid="hud-title">{domain} title</span>
  {/snippet}

  {#snippet topbarRight()}
    <button class="icon-btn" data-testid="hud-action">{domain} action</button>
  {/snippet}

  <div data-testid="hud-content">{domain} content</div>

  {#snippet bottombar()}
    <button class="nav-btn">Prev</button>
    <div class="slider-wrap">
      <input class="slider-input" type="range" min="1" max="10" value="5" aria-label="{domain} progress" />
    </div>
    <button class="nav-btn">Next</button>
  {/snippet}
</ReaderHud>
