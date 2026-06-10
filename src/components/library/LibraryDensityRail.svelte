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
    gap: 9px;
    width: 100%;
    min-width: 0;
  }

  .density-wrap-disabled {
    opacity: 0.5;
  }

  .density-range {
    appearance: none;
    width: calc(100% - 14px);
    margin: 0 7px;
    height: 3px;
    border-radius: 0;
    background:
      linear-gradient(90deg, var(--n-primary-container) 0 0) 0 0 / calc(var(--density-value, 0) * 20%) 100% no-repeat,
      rgba(255, 255, 255, 0.09);
    outline: none;
    cursor: pointer;
  }

  .density-range::-webkit-slider-thumb {
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 999px;
    background: rgba(218, 207, 255, 0.95);
    border: 2px solid rgba(24, 22, 31, 0.95);
    box-shadow: 0 0 0 1px rgba(184, 167, 234, 0.2);
    transition: transform 140ms ease, box-shadow 140ms ease;
  }

  .density-range::-webkit-slider-thumb:hover {
    transform: scale(1.06);
    box-shadow: 0 0 0 3px rgba(184, 167, 234, 0.12);
  }

  .density-range::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 999px;
    background: rgba(218, 207, 255, 0.95);
    border: 2px solid rgba(24, 22, 31, 0.95);
    box-shadow: 0 0 0 1px rgba(184, 167, 234, 0.2);
  }

  .density-range::-moz-range-track {
    height: 3px;
    border-radius: 0;
    background: rgba(255, 255, 255, 0.09);
  }

  .density-labels {
    display: flex;
    justify-content: space-between;
    gap: 4px;
    padding: 0 2px;
    font-family: var(--font-sans);
    font-size: 10.5px;
    color: rgba(229, 226, 225, 0.32);
    letter-spacing: 0.08em;
    font-weight: 720;
    text-transform: uppercase;
  }

  .density-labels span {
    text-align: center;
    opacity: 0.55;
  }

  .density-labels span.active {
    opacity: 1;
    color: rgba(218, 207, 255, 0.76);
  }
</style>
