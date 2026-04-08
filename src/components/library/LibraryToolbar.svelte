<script lang="ts">
  import { onMount } from "svelte";
  import { CaretDown, CaretUp, Funnel, MagnifyingGlass, SortAscending, SquaresFour } from "phosphor-svelte";
  import type { LibraryDisplaySettings, LibraryToolbarVM } from "../../lib/library/contracts";
  import LibraryDisplayPopover from "./LibraryDisplayPopover.svelte";

  type Props = {
    toolbar: LibraryToolbarVM;
    displaySettings: LibraryDisplaySettings;
    sortDefaultMode: string;
    sortDefaultDir: "asc" | "desc";
    filterDefaultValue: string;
    sortLabel?: string;
    filterLabel?: string;
    onSearchChange?: (value: string) => void;
    onSortModeChange?: (mode: string) => void;
    onSortDirToggle?: () => void;
    onFilterChange?: (value: string) => void;
    onViewModeChange?: (mode: LibraryDisplaySettings["viewMode"]) => void;
    onPreferredColumnsChange?: (value: LibraryDisplaySettings["preferredColumns"]) => void;
    onShowProgressChange?: (value: boolean) => void;
    onShowOutlineChange?: (value: boolean) => void;
  };

  let {
    toolbar,
    displaySettings = {
      viewMode: "grid",
      preferredColumns: "auto",
      showProgress: true,
      showOutline: true,
    },
    sortDefaultMode,
    sortDefaultDir,
    filterDefaultValue,
    sortLabel = "Sort by",
    filterLabel = "Filter",
    onSearchChange = () => {},
    onSortModeChange = () => {},
    onSortDirToggle = () => {},
    onFilterChange = () => {},
    onViewModeChange = () => {},
    onPreferredColumnsChange = () => {},
    onShowProgressChange = () => {},
    onShowOutlineChange = () => {},
  }: Props = $props();

  let sortPanelOpen = $state(false);
  let filterPanelOpen = $state(false);
  let viewPanelOpen = $state(false);

  const sortActive = $derived(toolbar.sortMode !== sortDefaultMode || toolbar.sortDir !== sortDefaultDir);
  const filterActive = $derived(toolbar.filterValue !== filterDefaultValue);
  const viewActive = $derived(
    displaySettings.viewMode !== "grid"
    || displaySettings.preferredColumns !== "auto"
    || !displaySettings.showProgress
    || !displaySettings.showOutline,
  );

  function openSortPanel() {
    sortPanelOpen = !sortPanelOpen;
    filterPanelOpen = false;
    viewPanelOpen = false;
  }

  function openFilterPanel() {
    filterPanelOpen = !filterPanelOpen;
    sortPanelOpen = false;
    viewPanelOpen = false;
  }

  function openViewPanel() {
    viewPanelOpen = !viewPanelOpen;
    sortPanelOpen = false;
    filterPanelOpen = false;
  }

  onMount(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        sortPanelOpen = false;
        filterPanelOpen = false;
        viewPanelOpen = false;
      }
    }

    function onMouseDown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (sortPanelOpen && !target.closest(".sort-panel-wrap, .sort-panel")) {
        sortPanelOpen = false;
      }
      if (filterPanelOpen && !target.closest(".filter-panel-wrap, .filter-panel")) {
        filterPanelOpen = false;
      }
      if (viewPanelOpen && !target.closest(".view-panel-wrap, .view-panel")) {
        viewPanelOpen = false;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown, true);
    };
  });
</script>

<div class="toolbar">
  <div class="search-wrap">
    <MagnifyingGlass size={13} class="search-icon" weight="light" />
    <input
      class="search"
      placeholder={toolbar.searchPlaceholder}
      value={toolbar.searchValue}
      oninput={(event) => onSearchChange((event.currentTarget as HTMLInputElement).value)}
    />
  </div>

  <div class="sort-panel-wrap">
    <button
      type="button"
      class="icon-btn"
      class:icon-btn-active={sortActive}
      title="Sort"
      onclick={openSortPanel}
    >
      <SortAscending size={15} weight="bold" />
    </button>
    {#if sortPanelOpen}
      <div class="dropdown-panel sort-panel" role="menu">
        <p class="panel-label">{sortLabel}</p>
        {#each toolbar.sortOptions as option}
          <button
            type="button"
            class="panel-item"
            class:panel-item-active={toolbar.sortMode === option.id}
            role="menuitem"
            onclick={() => {
              onSortModeChange(option.id);
              sortPanelOpen = false;
            }}
          >
            {option.label}
            {#if toolbar.sortMode === option.id}
              {#if toolbar.sortDir === "asc"}
                <CaretUp size={11} weight="bold" />
              {:else}
                <CaretDown size={11} weight="bold" />
              {/if}
            {/if}
          </button>
        {/each}
        <button
          type="button"
          class="panel-item dir-toggle"
          role="menuitem"
          onclick={onSortDirToggle}
        >
          {toolbar.sortDir === "asc" ? "Ascending" : "Descending"}
          {#if toolbar.sortDir === "asc"}
            <CaretUp size={11} weight="bold" />
          {:else}
            <CaretDown size={11} weight="bold" />
          {/if}
        </button>
      </div>
    {/if}
  </div>

  <div class="filter-panel-wrap">
    <button
      type="button"
      class="icon-btn"
      class:icon-btn-active={filterActive}
      title={filterLabel}
      onclick={openFilterPanel}
    >
      <Funnel size={15} weight={filterActive ? "fill" : "bold"} />
    </button>
    {#if filterPanelOpen}
      <div class="dropdown-panel filter-panel" role="menu">
        <p class="panel-label">{filterLabel}</p>
        {#each toolbar.filterOptions as option}
          <button
            type="button"
            class="panel-item"
            class:panel-item-active={toolbar.filterValue === option.id}
            role="menuitem"
            onclick={() => {
              onFilterChange(option.id);
              filterPanelOpen = false;
            }}
          >
            {option.label}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="view-panel-wrap">
    <button
      type="button"
      class="icon-btn"
      class:icon-btn-active={viewActive}
      title="View"
      onclick={openViewPanel}
    >
      <SquaresFour size={15} weight={viewActive ? "fill" : "bold"} />
    </button>
    {#if viewPanelOpen}
      <div class="dropdown-panel view-panel">
        <LibraryDisplayPopover
          settings={displaySettings}
          {onViewModeChange}
          {onPreferredColumnsChange}
          {onShowProgressChange}
          {onShowOutlineChange}
        />
      </div>
    {/if}
  </div>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--hud-toolbar-gap);
  }

  .search-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .search-wrap :global(.search-icon) {
    position: absolute;
    left: 10px;
    color: var(--text-faint);
    pointer-events: none;
  }

  .search {
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
    border-radius: var(--hud-control-radius);
    min-height: var(--hud-control-height);
    padding: 5px 10px 5px 28px;
    color: var(--text-primary);
    font-size: var(--text-sm);
    width: 180px;
    outline: none;
    transition: border-color var(--t-base);
  }

  .search::placeholder {
    color: var(--text-faint);
  }

  .search:focus {
    border-color: var(--border-strong);
  }

  .sort-panel-wrap,
  .filter-panel-wrap,
  .view-panel-wrap {
    position: relative;
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--hud-icon-button-size);
    height: var(--hud-icon-button-size);
    border-radius: var(--hud-control-radius);
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
    color: var(--text-faint);
    cursor: pointer;
    flex-shrink: 0;
    transition: color var(--t-base), border-color var(--t-base), background var(--t-base);
  }

  .icon-btn:hover {
    color: var(--text-primary);
    border-color: var(--border-strong);
  }

  .icon-btn-active {
    color: var(--accent-fg);
    border-color: var(--accent-dim);
    background: var(--accent-muted);
  }

  .dropdown-panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 10;
    min-width: 220px;
    background: var(--bg-overlay, #1a1a1a);
    border: 1px solid var(--border-base);
    border-radius: var(--hud-popover-radius);
    padding: 6px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.3);
    animation: fadeIn var(--t-fast) both;
  }

  .view-panel {
    min-width: 340px;
  }

  .panel-label {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
    color: var(--text-faint);
    padding: 4px 8px 8px;
  }

  .panel-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 7px 10px;
    border-radius: var(--hud-control-radius);
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    cursor: pointer;
    text-align: left;
    transition: background var(--t-base), color var(--t-base);
    gap: var(--sp-2);
  }

  .panel-item:hover {
    background: var(--bg-subtle, #202020);
    color: var(--text-primary);
  }

  .panel-item-active {
    color: var(--accent-fg);
    background: var(--hud-selection-bg);
    outline: 1px solid var(--hud-selection-border);
    font-weight: var(--weight-medium, 500);
  }

  .panel-item-active:hover {
    background: var(--accent-dim);
  }

  .dir-toggle {
    color: var(--text-secondary);
    justify-content: flex-start;
    gap: var(--sp-2);
    border-top: 1px solid var(--border-dim);
    border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    margin-top: 2px;
    padding-top: 9px;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
