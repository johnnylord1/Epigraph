<script lang="ts">
  import type { LibraryDisplaySettings } from "../../lib/library/contracts";
  import type { LibraryPreferredGridColumns, LibraryViewMode } from "../../lib/libraryDisplay";
  import { _ } from "../../lib/i18n/runtime";
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
    { id: "grid", label: "library.display.grid" },
    { id: "compact_grid", label: "library.display.compactGrid" },
    { id: "list", label: "library.display.list" },
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
    settings.preferredColumns === "auto" ? $_("library.display.auto") : String(settings.preferredColumns),
  );
  const viewModeLabel = $derived(
    settings.viewMode === "compact_grid"
      ? $_("library.display.compactGrid")
      : settings.viewMode === "list"
        ? $_("library.display.list")
        : $_("library.display.grid"),
  );
</script>

  <div class="display-panel" role="menu" aria-label={$_("library.display.viewSettings")}>
  {#if panel === "density"}
    <section class="n-popover-panel is-open">
      <div class="n-popover-head">
        <div>
          <p class="n-popover-title">{$_("library.display.itemsPerRow")}</p>
          <p class="n-popover-note">{$_("library.display.itemsPerRowHint")}</p>
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
          <p class="n-popover-title">{$_("library.display.layout")}</p>
          <p class="n-popover-note">{$_("library.display.layoutHint")}</p>
        </div>
        <span class="n-popover-meta">{viewModeLabel}</span>
      </div>

      <div class="n-mini-switch n-layout-switch" role="group" aria-label={$_("library.display.layoutMode")}>
        {#each VIEW_OPTIONS as option}
          <button
            type="button"
            class:is-selected={settings.viewMode === option.id}
            onclick={() => onViewModeChange(option.id)}
          >
            {option.id === "compact_grid" ? $_("library.display.compact") : $_(option.label)}
          </button>
        {/each}
      </div>

      <div class="n-toggle-row">
        <span class="n-toggle-label">{$_("library.display.showProgress")}</span>
      <div class="n-mini-switch" data-toggle="progress">
        <button type="button" class:is-selected={settings.showProgress} onclick={() => onShowProgressChange(true)}>{$_("common.on")}</button>
        <button type="button" class:is-selected={!settings.showProgress} onclick={() => onShowProgressChange(false)}>{$_("common.off")}</button>
      </div>
      </div>

      <div class="n-toggle-row">
        <span class="n-toggle-label">{$_("library.display.showOutlines")}</span>
        <div class="n-mini-switch" data-toggle="outline">
          <button type="button" class:is-selected={settings.showOutline} onclick={() => onShowOutlineChange(true)}>{$_("common.on")}</button>
          <button type="button" class:is-selected={!settings.showOutline} onclick={() => onShowOutlineChange(false)}>{$_("common.off")}</button>
        </div>
      </div>
    </section>
  {:else}
    <section class="n-popover-panel is-open">
      <div class="n-popover-head">
        <div>
          <p class="n-popover-title">{$_("library.display.itemsPerRow")}</p>
          <p class="n-popover-note">{$_("library.display.itemsPerRowHint")}</p>
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
          <p class="n-popover-title">{$_("library.display.layout")}</p>
          <p class="n-popover-note">{$_("library.display.layoutHint")}</p>
        </div>
        <span class="n-popover-meta">{viewModeLabel}</span>
      </div>

      <div class="n-mini-switch n-layout-switch" role="group" aria-label={$_("library.display.layoutMode")}>
        {#each VIEW_OPTIONS as option}
          <button
            type="button"
            class:is-selected={settings.viewMode === option.id}
            onclick={() => onViewModeChange(option.id)}
          >
            {option.id === "compact_grid" ? $_("library.display.compact") : $_(option.label)}
          </button>
        {/each}
      </div>

      <div class="n-toggle-row">
        <span class="n-toggle-label">{$_("library.display.showProgress")}</span>
        <div class="n-mini-switch" data-toggle="progress">
          <button type="button" class:is-selected={settings.showProgress} onclick={() => onShowProgressChange(true)}>{$_("common.on")}</button>
          <button type="button" class:is-selected={!settings.showProgress} onclick={() => onShowProgressChange(false)}>{$_("common.off")}</button>
        </div>
      </div>

      <div class="n-toggle-row">
        <span class="n-toggle-label">{$_("library.display.showOutlines")}</span>
        <div class="n-mini-switch" data-toggle="outline">
          <button type="button" class:is-selected={settings.showOutline} onclick={() => onShowOutlineChange(true)}>{$_("common.on")}</button>
          <button type="button" class:is-selected={!settings.showOutline} onclick={() => onShowOutlineChange(false)}>{$_("common.off")}</button>
        </div>
      </div>
    </section>
  {/if}
</div>

<style>
  .display-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: min(304px, calc(100vw - 40px));
    min-width: 0;
  }

  .n-popover-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 0;
  }

  .n-popover-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .n-popover-title {
    margin: 0;
    font-family: var(--font-sans);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--n-popover-label);
  }

  .n-popover-note {
    margin: 2px 0 0;
    font-family: var(--font-sans);
    font-size: 12.5px;
    font-weight: 680;
    letter-spacing: 0;
    color: var(--n-popover-text);
  }

  .n-popover-meta {
    font-family: var(--font-sans);
    font-size: 10.5px;
    font-weight: 720;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--n-popover-meta);
    white-space: nowrap;
  }

  .n-layout-switch {
    align-self: flex-start;
    width: 100%;
  }

  .n-layout-switch button {
    flex: 1 1 0;
  }

  .n-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .n-toggle-label {
    font-family: var(--font-sans);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: rgba(207, 199, 226, 0.62);
  }

  .n-mini-switch {
    display: inline-flex;
    gap: 4px;
    padding: 4px;
    border-radius: 9999px;
    background: var(--n-popover-control-bg);
    border: 1px solid var(--n-popover-control-border);
  }

  .n-mini-switch button {
    min-width: 32px;
    min-height: 28px;
    padding: 0 12px;
    border-radius: 9999px;
    border: none;
    background: transparent;
    color: var(--n-popover-text);
    font-family: var(--font-sans);
    font-size: 11.5px;
    font-weight: 720;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    transition:
      background 160ms ease,
      color 160ms ease,
      box-shadow 160ms ease,
      transform 160ms ease;
  }

  .n-mini-switch button:hover:not(.is-selected) {
    color: var(--n-popover-text-strong);
    background: var(--n-popover-item-hover);
  }

  .n-mini-switch button.is-selected {
    color: var(--n-on-primary);
    background: var(--n-gradient-primary);
    box-shadow: 0 6px 16px rgba(184, 167, 234, 0.2);
  }

  .n-mini-switch button.is-selected:hover {
    transform: translateY(-1px);
  }
</style>
