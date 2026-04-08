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

<div class="type-selector" aria-label="Books type">
  {#each options as option}
    <button
      type="button"
      class="type-btn"
      class:type-btn-active={option.active}
      aria-pressed={option.active}
      onclick={() => onSelect(option.id)}
    >
      <span>{option.label}</span>
      <span class="type-count">{option.count}</span>
    </button>
  {/each}
</div>

<style>
  .type-selector {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
  }

  .type-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-faint);
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    cursor: pointer;
    transition: color var(--t-base), background var(--t-base), border-color var(--t-base);
  }

  .type-btn:hover {
    color: var(--text-muted);
  }

  .type-btn-active {
    color: var(--accent-fg);
    border-color: var(--accent-dim);
    background: var(--accent-muted);
  }

  .type-count {
    color: inherit;
    opacity: 0.7;
    font-size: var(--text-2xs);
  }
</style>
