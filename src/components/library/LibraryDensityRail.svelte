<script lang="ts">
  import type { LibraryPreferredGridColumns } from "../../lib/libraryDisplay";

  type Props = {
    value: LibraryPreferredGridColumns;
    disabled?: boolean;
    onSelect?: (value: LibraryPreferredGridColumns) => void;
  };

  const DENSITY_OPTIONS: LibraryPreferredGridColumns[] = ["auto", 2, 3, 4, 5, 6];

  let {
    value,
    disabled = false,
    onSelect = () => {},
  }: Props = $props();

  const valueIndex = $derived(Math.max(0, DENSITY_OPTIONS.indexOf(value)));

  function labelFor(option: LibraryPreferredGridColumns): string {
    return option === "auto" ? "Auto" : String(option);
  }
</script>

<div class="density-wrap" class:density-wrap-disabled={disabled} style={`--density-value:${valueIndex};`}>
  <input
    class="density-range"
    type="range"
    min="0"
    max={DENSITY_OPTIONS.length - 1}
    step="1"
    value={valueIndex}
    disabled={disabled}
    oninput={(event) => {
      const nextIndex = Number((event.currentTarget as HTMLInputElement).value);
      onSelect(DENSITY_OPTIONS[Math.max(0, Math.min(DENSITY_OPTIONS.length - 1, nextIndex))]);
    }}
  />

  <div class="density-labels" aria-hidden="true">
    {#each DENSITY_OPTIONS as option, index}
    <span class:active={valueIndex === index}>{labelFor(option)}</span>
    {/each}
  </div>
</div>

<style>
  .density-wrap {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
    min-width: 0;
  }

  .density-wrap-disabled {
    opacity: 0.5;
  }

  .density-range {
    appearance: none;
    width: 100%;
    height: 5px;
    border-radius: 999px;
    background:
      linear-gradient(90deg, var(--n-primary-container) 0 0) 0 0 / calc(var(--density-value, 0) * 20%) 100% no-repeat,
      rgba(255, 255, 255, 0.08);
    outline: none;
    cursor: pointer;
  }

  .density-range::-webkit-slider-thumb {
    appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    background: var(--n-gradient-primary);
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 6px 18px rgba(184, 167, 234, 0.42);
    transition: transform 140ms ease, box-shadow 140ms ease;
  }

  .density-range::-webkit-slider-thumb:hover {
    transform: scale(1.08);
    box-shadow: 0 8px 22px rgba(184, 167, 234, 0.55);
  }

  .density-range::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border-radius: 999px;
    background: var(--n-gradient-primary);
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 6px 18px rgba(184, 167, 234, 0.42);
  }

  .density-range::-moz-range-track {
    height: 5px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
  }

  .density-labels {
    display: flex;
    justify-content: space-between;
    gap: 4px;
    padding: 0 2px;
    font-family: var(--font-ui);
    font-size: 10px;
    color: rgba(172, 165, 189, 0.5);
    letter-spacing: 0.08em;
    font-weight: 800;
    text-transform: uppercase;
  }

  .density-labels span {
    text-align: center;
    opacity: 0.55;
  }

  .density-labels span.active {
    opacity: 1;
    color: var(--n-primary);
    text-shadow: 0 0 10px rgba(184, 167, 234, 0.18);
  }
</style>
