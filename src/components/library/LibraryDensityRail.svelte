<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import type { LibraryPreferredGridColumns } from "../../lib/libraryDisplay";

  type Props = {
    value: LibraryPreferredGridColumns;
    disabled?: boolean;
    onSelect?: (value: LibraryPreferredGridColumns) => void;
  };

  const DENSITY_OPTIONS: LibraryPreferredGridColumns[] = ["auto", 4, 5, 6, 7, 8, 9, 10];

  let {
    value,
    disabled = false,
    onSelect = () => {},
  }: Props = $props();

  const valueIndex = $derived(Math.max(0, DENSITY_OPTIONS.indexOf(value)));
  const densityProgress = $derived(
    DENSITY_OPTIONS.length > 1
      ? (valueIndex / (DENSITY_OPTIONS.length - 1)) * 100
      : 0,
  );

  function labelFor(option: LibraryPreferredGridColumns): string {
    return option === "auto" ? $_("library.display.auto") : String(option);
  }
</script>

<div class="density-wrap" class:density-wrap-disabled={disabled} style={"--density-progress:" + densityProgress + "%;"}>
  <div class="density-control">
    <input
      class="density-range"
      type="range"
      min="0"
      max={DENSITY_OPTIONS.length - 1}
      step="1"
      value={valueIndex}
      disabled={disabled}
      aria-label={$_("library.display.itemsPerRow")}
      oninput={(event) => {
        const nextIndex = Number((event.currentTarget as HTMLInputElement).value);
        onSelect(DENSITY_OPTIONS[Math.max(0, Math.min(DENSITY_OPTIONS.length - 1, nextIndex))]);
      }}
    />
    <div class="density-track" aria-hidden="true">
      <span class="density-fill"></span>
      <span class="density-thumb"></span>
    </div>
  </div>

  <div class="density-labels" aria-hidden="true">
    {#each DENSITY_OPTIONS as option, index}
    <span
      class:active={valueIndex === index}
      style={`--density-label-position:${(index / (DENSITY_OPTIONS.length - 1)) * 100}%;`}
    >{labelFor(option)}</span>
    {/each}
  </div>
</div>

<style>
  .density-wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    min-width: 0;
  }

  .density-wrap-disabled {
    opacity: 0.5;
  }

  .density-control {
    position: relative;
    width: 100%;
    height: calc(18px * var(--component-library-scale, 1));
    min-width: 0;
  }

  .density-range {
    position: absolute;
    z-index: var(--component-library-control-z-index);
    inset: 0;
    appearance: none;
    width: 100%;
    height: 100%;
    margin: 0;
    background: transparent;
    outline: none;
    opacity: 0;
    cursor: pointer;
  }

  .density-track {
    position: absolute;
    z-index: var(--component-library-panel-z-index);
    top: 50%;
    left: calc(7px * var(--component-library-scale, 1));
    right: calc(7px * var(--component-library-scale, 1));
    height: calc(5px * var(--component-library-scale, 1));
    border-radius: var(--radius-full);
    background: var(--component-library-density-track-bg);
    transform: translateY(-50%);
    overflow: visible;
  }

  .density-fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--density-progress, 0%);
    border-radius: inherit;
    background: var(--component-library-density-fill-bg);
    box-shadow: var(--component-library-density-fill-shadow);
    transition: width 260ms cubic-bezier(0.2, 0.9, 0.22, 1);
  }

  .density-thumb {
    position: absolute;
    top: 50%;
    left: var(--density-progress, 0%);
    width: calc(16px * var(--component-library-scale, 1));
    height: calc(16px * var(--component-library-scale, 1));
    border-radius: var(--radius-full);
    background: var(--component-library-density-thumb-bg);
    border: 2px solid var(--component-library-density-thumb-border);
    box-shadow: var(--component-library-density-thumb-shadow);
    transform: translate(-50%, -50%);
    transition:
      left 260ms cubic-bezier(0.2, 0.9, 0.22, 1),
      box-shadow 140ms ease;
  }

  .density-control:hover .density-thumb,
  .density-control:focus-within .density-thumb {
    box-shadow: var(--component-library-density-thumb-hover-shadow);
  }

  .density-labels {
    position: relative;
    width: calc(100% - calc(14px * var(--component-library-scale, 1)));
    height: 12px;
    margin: 0 calc(7px * var(--component-library-scale, 1));
    padding: 0;
    font-family: var(--font-sans);
    font-size: 10px;
    color: var(--component-library-density-label-fg);
    letter-spacing: 0.055em;
    font-weight: 600;
    text-transform: uppercase;
  }

  .density-labels span {
    position: absolute;
    top: 0;
    left: var(--density-label-position, 0%);
    text-align: center;
    opacity: 0.55;
    transform: translateX(-50%);
    white-space: nowrap;
  }

  .density-labels span.active {
    opacity: 1;
    color: var(--component-library-density-label-active-fg);
  }

  @media (prefers-reduced-motion: reduce) {
    .density-fill,
    .density-thumb {
      transition-duration: 1ms;
    }
  }
</style>
