<script lang="ts">
  /** Step heading that rises word by word; screen readers get the plain sentence. */
  let { text, level = 1 }: { text: string; level?: 1 | 2 } = $props();
  const words = $derived(text.split(/\s+/).filter(Boolean));
</script>

<svelte:element this={`h${level}`} class="fr-title" tabindex="-1" data-enter aria-label={text}>
  {#each words as word, index (index)}<span class="fr-word" aria-hidden="true"><span>{word}</span></span>{#if index < words.length - 1}{" "}{/if}{/each}
</svelte:element>

<style>
  .fr-title { outline: none; }
  .fr-word { display: inline-block; overflow: hidden; vertical-align: top; padding-bottom: .1em; margin-bottom: -.1em; }
  .fr-word > span { display: inline-block; }
</style>
