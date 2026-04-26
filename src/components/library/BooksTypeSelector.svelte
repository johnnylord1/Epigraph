<script lang="ts">
  import type { BooksTypeOptionVM } from "../../lib/library/contracts";

  type Props = {
    options: BooksTypeOptionVM[];
    onSelect?: (id: BooksTypeOptionVM["id"]) => void;
  };

  let {
    options,
    onSelect = () => {},
  }: Props = $props();
</script>

<div class="books-type-selector" aria-label="Books type">
  {#each options as option}
    <button
      type="button"
      class="n-chip books-type-btn"
      class:is-active={option.active}
      aria-pressed={option.active}
      onclick={() => onSelect(option.id)}
    >
      <span class="books-type-label">{option.label}</span>
      <span class="books-type-count">{option.count}</span>
    </button>
  {/each}
</div>

<style>
  .books-type-selector {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    align-self: flex-start;
  }

  .books-type-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 30px;
    padding: 0 12px;
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    cursor: pointer;
  }

  .books-type-count {
    color: inherit;
    opacity: 0.7;
    font-size: 10px;
    font-weight: 800;
  }
</style>
