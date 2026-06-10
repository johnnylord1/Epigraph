<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowsClockwise, CaretDown, CaretUp, Funnel, GridFour, MagnifyingGlass, SortAscending } from "phosphor-svelte";
  import type { BooksTypeOptionVM, LibraryDisplaySettings, LibraryToolbarVM } from "../../lib/library/contracts";
  import BooksTypeSelector from "./BooksTypeSelector.svelte";
  import LibraryDisplayPopover from "./LibraryDisplayPopover.svelte";

  type Props = {
    toolbar: LibraryToolbarVM;
    displaySettings: LibraryDisplaySettings;
    sortDefaultMode: string;
    sortDefaultDir: "asc" | "desc";
    filterDefaultValue: string;
    showSearch?: boolean;
    showActions?: boolean;
    bookTypeOptions?: BooksTypeOptionVM[];
    sortLabel?: string;
    filterLabel?: string;
    onSearchChange?: (value: string) => void;
    onSortModeChange?: (mode: string) => void;
    onSortDirToggle?: () => void;
    onFilterChange?: (value: string) => void;
    onBookTypeChange?: (value: BooksTypeOptionVM["id"]) => void;
    onViewModeChange?: (mode: LibraryDisplaySettings["viewMode"]) => void;
    onPreferredColumnsChange?: (value: LibraryDisplaySettings["preferredColumns"]) => void;
    onShowProgressChange?: (value: boolean) => void;
    onShowOutlineChange?: (value: boolean) => void;
    onRefresh?: () => void;
    refreshPending?: boolean;
    refreshLabel?: string;
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
    showSearch = true,
    showActions = true,
    sortLabel = "Sort by",
    filterLabel = "Filter",
    onSearchChange = () => {},
    onSortModeChange = () => {},
    onSortDirToggle = () => {},
    onFilterChange = () => {},
    bookTypeOptions = [],
    onBookTypeChange = () => {},
    onViewModeChange = () => {},
    onPreferredColumnsChange = () => {},
    onShowProgressChange = () => {},
    onShowOutlineChange = () => {},
    onRefresh,
    refreshPending = false,
    refreshLabel = "Refresh library",
  }: Props = $props();

  let sortPanelOpen = $state(false);
  let filterPanelOpen = $state(false);
  let displayPanelOpen = $state(false);

  function openSortPanel() {
    sortPanelOpen = !sortPanelOpen;
    filterPanelOpen = false;
    displayPanelOpen = false;
  }

  function openFilterPanel() {
    filterPanelOpen = !filterPanelOpen;
    sortPanelOpen = false;
    displayPanelOpen = false;
  }

  function openDisplayPanel() {
    displayPanelOpen = !displayPanelOpen;
    sortPanelOpen = false;
    filterPanelOpen = false;
  }

  function syncSearchDim(active: boolean) {
    document.body.classList.toggle("aethon-library-search-engaged", active);
  }

  onMount(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        sortPanelOpen = false;
        filterPanelOpen = false;
        displayPanelOpen = false;
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
      if (displayPanelOpen && !target.closest(".display-panel-wrap, .display-panel")) {
        displayPanelOpen = false;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.body.classList.remove("aethon-library-search-engaged");
    };
  });
</script>

<div class="toolbar" class:toolbar--actions-only={!showSearch && showActions}>
  {#if showSearch}
    <div class="n-search library-search" data-component="search-bar">
      <MagnifyingGlass size={13} class="n-search__icon" weight="light" />
      <input
        class="n-search__input"
        placeholder={toolbar.searchPlaceholder}
        value={toolbar.searchValue}
        oninput={(event) => onSearchChange((event.currentTarget as HTMLInputElement).value)}
        onfocus={() => syncSearchDim(true)}
        onblur={() => syncSearchDim(false)}
      />
    </div>
  {/if}

  {#if showActions}
    <div class="toolbar-cluster">
      {#if onRefresh}
        <button
          type="button"
          class="n-icon-btn library-toolbar-btn"
          title={refreshLabel}
          aria-label={refreshLabel}
          disabled={refreshPending}
          onclick={onRefresh}
        >
          <ArrowsClockwise size={15} weight="bold" class={refreshPending ? "anim-spin" : ""} />
        </button>
      {/if}

      <div class="display-panel-wrap">
        <button
          type="button"
          class="n-icon-btn library-toolbar-btn"
          class:is-active={displayPanelOpen}
          title="Display"
          onclick={openDisplayPanel}
        >
          <GridFour size={15} weight={displayPanelOpen ? "fill" : "bold"} />
        </button>
        {#if displayPanelOpen}
        <div class="dropdown-panel display-panel" role="menu">
            <LibraryDisplayPopover
              settings={displaySettings}
              panel="all"
              {onViewModeChange}
              {onPreferredColumnsChange}
              {onShowProgressChange}
              {onShowOutlineChange}
            />
          </div>
        {/if}
      </div>

      <div class="sort-panel-wrap">
        <button
          type="button"
          class="n-icon-btn library-toolbar-btn"
          class:is-active={sortPanelOpen}
          title="Sort"
          onclick={openSortPanel}
        >
          <SortAscending size={15} weight={sortPanelOpen ? "fill" : "bold"} />
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

          {#if bookTypeOptions.length}
            <div class="book-type-section">
              <p class="panel-label">Book type</p>
              <BooksTypeSelector options={bookTypeOptions} onSelect={onBookTypeChange} />
            </div>
          {/if}
        </div>
        {/if}
      </div>

      <div class="filter-panel-wrap">
        <button
          type="button"
          class="n-icon-btn library-toolbar-btn"
          class:is-active={filterPanelOpen}
          title={filterLabel}
          onclick={openFilterPanel}
        >
          <Funnel size={15} weight={filterPanelOpen ? "fill" : "bold"} />
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
    </div>
  {/if}
</div>

<style>
  .toolbar {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: var(--library-toolbar-gap, 12px);
    width: 100%;
    min-width: 0;
    min-height: var(--library-toolbar-height, calc(44px * var(--n-hud-scale)));
  }

  .toolbar--actions-only {
    display: flex;
    justify-content: flex-end;
    grid-template-columns: none;
    min-height: auto;
  }

  .library-search {
    grid-column: 2;
    justify-self: center;
    flex-shrink: 0;
    z-index: 62;
  }

  .toolbar-cluster {
    grid-column: 3;
    justify-self: end;
    display: inline-flex;
    align-items: center;
    gap: var(--library-toolbar-cluster-gap, 8px);
    z-index: 30;
  }

  .display-panel-wrap,
  .sort-panel-wrap,
  .filter-panel-wrap {
    position: relative;
  }

  .library-toolbar-btn {
    width: var(--library-icon-btn-size, var(--n-icon-btn-size));
    height: var(--library-icon-btn-size, var(--n-icon-btn-size));
    flex-shrink: 0;
  }

  .dropdown-panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 10;
    min-width: min(296px, calc(100vw - 32px));
    background: rgba(36, 33, 43, 0.88);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(202, 196, 208, 0.08);
    border-radius: 18px;
    padding: 8px;
    box-shadow:
      0 18px 42px rgba(0, 0, 0, 0.42),
      0 2px 8px rgba(0, 0, 0, 0.22),
      inset 0 1px 0 rgba(255, 255, 255, 0.02);
    animation: fadeIn 160ms cubic-bezier(0.18, 0.92, 0.2, 1) both;
  }

  .display-panel {
    min-width: min(352px, calc(100vw - 32px));
  }

  @media (max-width: 720px) {
    .toolbar,
    .toolbar--actions-only {
      justify-content: flex-start;
    }

    .toolbar-cluster {
      justify-self: start;
    }
  }

  .panel-label {
    font-family: var(--font-ui);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: rgba(202, 196, 208, 0.42);
    padding: 4px 8px 6px;
  }

  .panel-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 10px;
    border-radius: 12px;
    border: none;
    background: transparent;
    color: rgba(233, 229, 239, 0.9);
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    transition:
      background 140ms ease,
      color 140ms ease,
      transform 140ms ease,
      box-shadow 140ms ease;
    gap: 8px;
  }

  .panel-item:hover {
    background: rgba(184, 167, 234, 0.08);
    color: var(--n-on-surface);
    transform: translateY(-1px);
  }

  .panel-item-active {
    color: var(--n-on-primary);
    background: var(--n-gradient-primary);
    outline: 1px solid rgba(184, 167, 234, 0.24);
    font-weight: 700;
    box-shadow: 0 4px 14px rgba(184, 167, 234, 0.2);
  }

  .panel-item-active:hover {
    background: var(--n-gradient-primary);
  }

  .dir-toggle {
    color: var(--n-on-surface-variant);
    justify-content: flex-start;
    gap: 8px;
    border-top: 1px solid rgba(202, 196, 208, 0.08);
    border-radius: 0 0 10px 10px;
    margin-top: 2px;
    padding-top: 9px;
  }

  .book-type-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 4px 2px;
    margin-top: 6px;
    border-top: 1px solid rgba(202, 196, 208, 0.08);
  }

  .dropdown-panel :global(.n-popover-panel) {
    gap: 12px;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
