<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    className?: string;
    left?: Snippet;
    center?: Snippet;
    right?: Snippet;
  };

  let {
    className = "",
    left,
    center,
    right,
  }: Props = $props();
</script>

<header class={`n-topbar ${className}`.trim()}>
  <div class="n-topbar__left">
    {@render left?.()}
  </div>
  <div class="n-topbar__center">
    {@render center?.()}
  </div>
  <div class="n-topbar__right">
    {@render right?.()}
  </div>
</header>
