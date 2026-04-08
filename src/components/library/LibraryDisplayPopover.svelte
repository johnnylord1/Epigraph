<script lang="ts">
  import type { LibraryDisplaySettings } from "../../lib/library/contracts";
  import type { LibraryPreferredGridColumns, LibraryViewMode } from "../../lib/libraryDisplay";
  import LibraryDensityRail from "./LibraryDensityRail.svelte";

  type Props = {
    settings: LibraryDisplaySettings;
    onViewModeChange?: (mode: LibraryViewMode) => void;
    onPreferredColumnsChange?: (value: LibraryPreferredGridColumns) => void;
    onShowProgressChange?: (value: boolean) => void;
    onShowOutlineChange?: (value: boolean) => void;
  };

  const VIEW_OPTIONS: { id: LibraryViewMode; label: string }[] = [
    { id: "grid", label: "Grid" },
    { id: "compact_grid", label: "Compact grid" },
    { id: "list", label: "List" },
  ];

  let {
    settings,
    onViewModeChange = () => {},
    onPreferredColumnsChange = () => {},
    onShowProgressChange = () => {},
    onShowOutlineChange = () => {},
  }: Props = $props();

  const densityLabel = $derived(
    settings.preferredColumns === "auto" ? "Auto" : String(settings.preferredColumns),
  );
</script>

<div class="display-panel" role="menu" aria-label="View settings">
  <section class="section">
    <p class="section-label">Layout</p>
    <div class="segmented">
      {#each VIEW_OPTIONS as option}
        <button
          type="button"
          class="segment"
          class:segment-active={settings.viewMode === option.id}
          onclick={() => onViewModeChange(option.id)}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </section>

  <section class="section">
    <div class="section-head">
      <p class="section-label">Items per row</p>
      <span class="section-value">{densityLabel}</span>
    </div>
    <LibraryDensityRail
      value={settings.preferredColumns}
      disabled={settings.viewMode === "list"}
      onSelect={onPreferredColumnsChange}
    />
    {#if settings.viewMode === "list"}
      <p class="section-note">Ignored in list mode</p>
    {/if}
  </section>

  <section class="section">
    <p class="section-label">Show progress</p>
    <div class="segmented">
      <button
        type="button"
        class="segment"
        class:segment-active={settings.showProgress}
        onclick={() => onShowProgressChange(true)}
      >
        On
      </button>
      <button
        type="button"
        class="segment"
        class:segment-active={!settings.showProgress}
        onclick={() => onShowProgressChange(false)}
      >
        Off
      </button>
    </div>
  </section>

  <section class="section">
    <p class="section-label">Show outlines</p>
    <div class="segmented">
      <button
        type="button"
        class="segment"
        class:segment-active={settings.showOutline}
        onclick={() => onShowOutlineChange(true)}
      >
        On
      </button>
      <button
        type="button"
        class="segment"
        class:segment-active={!settings.showOutline}
        onclick={() => onShowOutlineChange(false)}
      >
        Off
      </button>
    </div>
  </section>
</div>

<style>
  .display-panel {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    min-width: 320px;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
  }

  .section-label,
  .section-value,
  .section-note {
    font-family: var(--font-ui);
    letter-spacing: var(--tracking-wide);
  }

  .section-label {
    font-size: var(--text-2xs);
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .section-value {
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .section-note {
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }

  .segmented {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }

  .segment {
    padding: 6px 10px;
    border-radius: var(--hud-chip-radius);
    border: 1px solid var(--border-dim);
    background: var(--bg-base);
    color: var(--text-faint);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    cursor: pointer;
    transition: color var(--t-base), background var(--t-base), border-color var(--t-base);
  }

  .segment:hover {
    color: var(--text-secondary);
    border-color: var(--border-strong);
  }

  .segment-active {
    color: var(--accent-fg);
    border-color: var(--accent-dim);
    background: var(--hud-selection-bg);
  }
</style>
