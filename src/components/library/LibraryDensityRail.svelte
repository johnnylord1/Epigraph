<script lang="ts">
  import type { LibraryPreferredGridColumns } from "../../lib/libraryDisplay";

  type Props = {
    value: LibraryPreferredGridColumns;
    disabled?: boolean;
    onSelect?: (value: LibraryPreferredGridColumns) => void;
  };

  const DENSITY_OPTIONS: LibraryPreferredGridColumns[] = ["auto", 4, 5, 6, 7, 8, 9, 10, 11, 12];

  let {
    value,
    disabled = false,
    onSelect = () => {},
  }: Props = $props();

  function labelFor(option: LibraryPreferredGridColumns): string {
    return option === "auto" ? "Auto" : String(option);
  }
</script>

<div class="density-rail" class:density-rail-disabled={disabled}>
  {#each DENSITY_OPTIONS as option}
    <button
      type="button"
      class="density-chip"
      class:density-chip-active={value === option}
      disabled={disabled}
      onclick={() => onSelect(option)}
    >
      {labelFor(option)}
    </button>
  {/each}
</div>

<style>
  .density-rail {
    display: flex;
    gap: var(--sp-2);
    overflow-x: auto;
    padding-bottom: 2px;
    scrollbar-width: none;
    scroll-snap-type: x mandatory;
  }

  .density-rail::-webkit-scrollbar {
    display: none;
  }

  .density-rail-disabled {
    opacity: 0.5;
  }

  .density-chip {
    flex: 0 0 auto;
    scroll-snap-align: start;
    min-width: 42px;
    padding: 6px 10px;
    border-radius: var(--hud-chip-radius);
    border: 1px solid var(--border-dim);
    background: var(--bg-base);
    color: var(--text-faint);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    cursor: pointer;
    transition: color var(--t-base), background var(--t-base), border-color var(--t-base), transform var(--t-base);
  }

  .density-chip:hover:not(:disabled) {
    color: var(--text-secondary);
    border-color: var(--border-strong);
    transform: translateY(-1px);
  }

  .density-chip:disabled {
    cursor: default;
  }

  .density-chip-active {
    color: var(--accent-fg);
    border-color: var(--accent-dim);
    background: var(--hud-selection-bg);
  }
</style>
