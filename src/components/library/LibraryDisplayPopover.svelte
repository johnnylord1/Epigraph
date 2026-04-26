<script lang="ts">
  import type { LibraryDisplaySettings } from "../../lib/library/contracts";
  import type { LibraryPreferredGridColumns, LibraryViewMode } from "../../lib/libraryDisplay";
  import LibraryDensityRail from "./LibraryDensityRail.svelte";

  type Props = {
    settings: LibraryDisplaySettings;
    panel?: "density" | "layout" | "all";
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
    panel = "density",
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
  {#if panel === "density"}
    <section class="n-popover-panel is-open">
      <div class="n-popover-head">
        <div>
          <p class="n-popover-title">Items per row</p>
          <p class="n-popover-note">Compact grid density for the cover wall.</p>
        </div>
        <span class="n-popover-meta">{densityLabel}</span>
      </div>
      <LibraryDensityRail
        value={settings.preferredColumns}
        disabled={settings.viewMode === "list"}
        onSelect={onPreferredColumnsChange}
      />
    </section>
  {:else if panel === "layout"}
    <section class="n-popover-panel is-open">
      <div class="n-popover-head">
        <div>
          <p class="n-popover-title">Layout</p>
          <p class="n-popover-note">Visual mode and metadata overlays.</p>
        </div>
        <span class="n-popover-meta">
          {settings.viewMode === "compact_grid" ? "Compact grid" : settings.viewMode === "list" ? "List" : "Grid"}
        </span>
      </div>

      <div class="n-inline-segmented" role="group" aria-label="Layout mode">
        {#each VIEW_OPTIONS as option}
          <button
            type="button"
            class="n-inline-segment"
            class:is-selected={settings.viewMode === option.id}
            onclick={() => onViewModeChange(option.id)}
          >
            {option.label === "Compact grid" ? "Compact" : option.label}
          </button>
        {/each}
      </div>

      <div class="n-toggle-row">
        <span class="n-toggle-label">Show progress</span>
      <div class="n-mini-switch" data-toggle="progress">
        <button type="button" class:is-selected={settings.showProgress} onclick={() => onShowProgressChange(true)}>On</button>
        <button type="button" class:is-selected={!settings.showProgress} onclick={() => onShowProgressChange(false)}>Off</button>
      </div>
      </div>

      <div class="n-toggle-row">
        <span class="n-toggle-label">Show outlines</span>
        <div class="n-mini-switch" data-toggle="outline">
          <button type="button" class:is-selected={settings.showOutline} onclick={() => onShowOutlineChange(true)}>On</button>
          <button type="button" class:is-selected={!settings.showOutline} onclick={() => onShowOutlineChange(false)}>Off</button>
        </div>
      </div>
    </section>
  {:else}
    <section class="n-popover-panel is-open">
      <div class="n-popover-head">
        <div>
          <p class="n-popover-title">Items per row</p>
          <p class="n-popover-note">Compact grid density for the cover wall.</p>
        </div>
        <span class="n-popover-meta">{densityLabel}</span>
      </div>
      <LibraryDensityRail
        value={settings.preferredColumns}
        disabled={settings.viewMode === "list"}
        onSelect={onPreferredColumnsChange}
      />
    </section>

    <section class="n-popover-panel is-open">
      <div class="n-popover-head">
        <div>
          <p class="n-popover-title">Layout</p>
          <p class="n-popover-note">Visual mode and metadata overlays.</p>
        </div>
        <span class="n-popover-meta">
          {settings.viewMode === "compact_grid" ? "Compact grid" : settings.viewMode === "list" ? "List" : "Grid"}
        </span>
      </div>

      <div class="n-inline-segmented" role="group" aria-label="Layout mode">
        {#each VIEW_OPTIONS as option}
          <button
            type="button"
            class="n-inline-segment"
            class:is-selected={settings.viewMode === option.id}
            onclick={() => onViewModeChange(option.id)}
          >
            {option.label === "Compact grid" ? "Compact" : option.label}
          </button>
        {/each}
      </div>

      <div class="n-toggle-row">
        <span class="n-toggle-label">Show progress</span>
        <div class="n-mini-switch" data-toggle="progress">
          <button type="button" class:is-selected={settings.showProgress} onclick={() => onShowProgressChange(true)}>On</button>
          <button type="button" class:is-selected={!settings.showProgress} onclick={() => onShowProgressChange(false)}>Off</button>
        </div>
      </div>

      <div class="n-toggle-row">
        <span class="n-toggle-label">Show outlines</span>
        <div class="n-mini-switch" data-toggle="outline">
          <button type="button" class:is-selected={settings.showOutline} onclick={() => onShowOutlineChange(true)}>On</button>
          <button type="button" class:is-selected={!settings.showOutline} onclick={() => onShowOutlineChange(false)}>Off</button>
        </div>
      </div>
    </section>
  {/if}
</div>

<style>
  .display-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 352px;
  }

  .n-popover-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 2px 2px 0;
  }

  .n-popover-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .n-popover-title {
    margin: 0;
    font-family: var(--font-ui);
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: rgba(202, 196, 208, 0.44);
  }

  .n-popover-note {
    margin: 2px 0 0;
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0;
    color: rgba(202, 196, 208, 0.62);
  }

  .n-popover-meta {
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(211, 196, 255, 0.88);
    white-space: nowrap;
  }

  .n-inline-segmented {
    align-self: flex-start;
  }

  .n-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .n-toggle-label {
    font-family: var(--font-ui);
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(202, 196, 208, 0.52);
  }

  .n-mini-switch {
    display: inline-flex;
    gap: 4px;
    padding: 4px;
    border-radius: 9999px;
    background: rgba(36, 33, 43, 0.58);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.04);
  }

  .n-mini-switch button {
    min-width: 32px;
    min-height: 30px;
    padding: 0 12px;
    border-radius: 9999px;
    border: none;
    background: transparent;
    color: var(--n-on-surface-variant);
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
    transition:
      background 160ms ease,
      color 160ms ease,
      box-shadow 160ms ease,
      transform 160ms ease;
  }

  .n-mini-switch button:hover:not(.is-selected) {
    color: #fff;
    background: rgba(255, 255, 255, 0.05);
  }

  .n-mini-switch button.is-selected {
    color: var(--n-on-primary);
    background: var(--n-gradient-primary);
    box-shadow: 0 6px 16px rgba(184, 167, 234, 0.24);
  }

  .n-mini-switch button.is-selected:hover {
    transform: translateY(-1px);
  }
</style>
