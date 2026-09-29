<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowsClockwise, CaretDown, CaretUp, Funnel, GridFour, SortAscending, UploadSimple } from "phosphor-svelte";
  import type { BooksTypeOptionVM, LibraryDisplaySettings, LibraryToolbarVM } from "../../lib/library/contracts";
  import { _ } from "../../lib/i18n/runtime";
  import BooksTypeSelector from "./BooksTypeSelector.svelte";
  import LibraryDisplayPopover from "./LibraryDisplayPopover.svelte";
  import {
    disengageSearch,
    engageSearch,
    openSearchPalette,
    setSearchQuery,
    store,
  } from "../../store/state.svelte";

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
    onImport?: () => void;
    importLabel?: string;
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
    refreshLabel = "",
    onImport,
    importLabel = "",
  }: Props = $props();

  let sortPanelOpen = $state(false);
  let filterPanelOpen = $state(false);
  let displayPanelOpen = $state(false);
  const effectiveRefreshLabel = $derived(refreshLabel || $_("library.toolbar.refresh"));

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

  $effect(() => {
    if (store.searchContext === "library" && toolbar.searchValue !== store.searchQuery) {
      onSearchChange(store.searchQuery);
    }
  });

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
      document.body.classList.remove("epigraph-library-search-engaged");
    };
  });
</script>

<div class="toolbar" class:toolbar--actions-only={!showSearch && showActions}>
  {#if showSearch}
    <div class="n-search library-search" data-component="search-bar">
      <span class="n-search__icon material-symbols-outlined" aria-hidden="true">search</span>
      <input
        class="n-search__input"
        role="combobox"
        aria-expanded={store.searchOpen}
        aria-controls="epigraph-search-results"
        aria-activedescendant={store.searchOpen ? store.searchActiveResultId ?? undefined : undefined}
        aria-autocomplete="list"
        placeholder={toolbar.searchPlaceholder}
        value={toolbar.searchValue}
        onfocus={engageSearch}
        onclick={engageSearch}
        onblur={disengageSearch}
        oninput={(event) => {
          const value = (event.currentTarget as HTMLInputElement).value;
          setSearchQuery(value);
          onSearchChange(value);
          if (value.trim()) openSearchPalette("library", value);
        }}
      />
    </div>
  {/if}

  {#if showActions}
    <div class="toolbar-cluster">
      {#if onImport}
        <button
          type="button"
          class="n-icon-btn library-toolbar-btn"
          title={importLabel}
          aria-label={importLabel}
          onclick={onImport}
        >
          <UploadSimple size={15} weight="bold" />
        </button>
      {/if}

      {#if onRefresh}
        <button
          type="button"
          class="n-icon-btn library-toolbar-btn"
          title={effectiveRefreshLabel}
          aria-label={effectiveRefreshLabel}
          aria-busy={refreshPending}
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
          title={$_("library.display.title")}
          onclick={openDisplayPanel}
        >
          <GridFour size={15} weight={displayPanelOpen ? "fill" : "bold"} />
        </button>
        {#if displayPanelOpen}
        <div class="dropdown-panel display-panel n-popover-surface n-popover-menu" role="menu">
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
          title={$_("library_sort")}
          onclick={openSortPanel}
        >
          <SortAscending size={15} weight={sortPanelOpen ? "fill" : "bold"} />
        </button>
        {#if sortPanelOpen}
        <div class="dropdown-panel sort-panel n-popover-surface n-popover-menu" role="menu">
          <p class="n-popover-label">{sortLabel}</p>
          {#each toolbar.sortOptions as option}
            <button
              type="button"
              class="n-popover-item"
              class:n-popover-item--active={toolbar.sortMode === option.id}
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
            class="n-popover-item dir-toggle"
            role="menuitem"
            onclick={onSortDirToggle}
          >
            {toolbar.sortDir === "asc" ? $_("library.sort.ascending") : $_("library.sort.descending")}
            {#if toolbar.sortDir === "asc"}
              <CaretUp size={11} weight="bold" />
            {:else}
              <CaretDown size={11} weight="bold" />
            {/if}
          </button>

          {#if bookTypeOptions.length}
            <div class="book-type-section">
              <p class="n-popover-label">{$_("library.books.type")}</p>
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
          <div class="dropdown-panel filter-panel n-popover-surface n-popover-menu" role="menu">
            <p class="n-popover-label">{filterLabel}</p>
            {#each toolbar.filterOptions as option}
              <button
                type="button"
                class="n-popover-item"
                class:n-popover-item--active={toolbar.filterValue === option.id}
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
    min-height: var(--library-toolbar-height, calc(44px * var(--component-library-scale)));
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
    z-index: var(--component-topbar-search-z-index);
  }

  .toolbar-cluster {
    grid-column: 3;
    justify-self: end;
    display: inline-flex;
    align-items: center;
    gap: var(--library-toolbar-cluster-gap, 8px);
    z-index: var(--component-library-header-z-index);
  }

  .display-panel-wrap,
  .sort-panel-wrap,
  .filter-panel-wrap {
    position: relative;
  }

  .library-toolbar-btn {
    width: var(--library-icon-btn-size, var(--hud-icon-button-size));
    height: var(--library-icon-btn-size, var(--hud-icon-button-size));
    flex-shrink: 0;
  }

  .library-toolbar-btn :global(svg) {
    width: var(--library-toolbar-icon-size, calc(15px * var(--component-library-scale)));
    height: var(--library-toolbar-icon-size, calc(15px * var(--component-library-scale)));
    -webkit-app-region: no-drag;
    pointer-events: none;
  }

  .library-toolbar-btn :global(*) {
    -webkit-app-region: no-drag;
  }

  .dropdown-panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: var(--component-library-dropdown-z-index);
    min-width: min(296px, calc(100vw - 32px));
  }

  .display-panel {
    min-width: min(320px, calc(100vw - 32px));
  }

  @media (max-width: 520px) {
    .toolbar,
    .toolbar--actions-only {
      justify-content: flex-start;
    }

    .toolbar-cluster {
      justify-self: start;
    }
  }

  .dir-toggle {
    color: var(--component-library-muted-fg);
    justify-content: flex-start;
    gap: 8px;
    border-top: 1px solid var(--component-library-toolbar-divider);
    border-radius: 0 0 var(--component-menu-radius) var(--component-menu-radius);
    margin-top: 2px;
    padding-top: 9px;
  }

  .book-type-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 4px 2px;
    margin-top: 6px;
    border-top: 1px solid var(--component-library-toolbar-divider);
  }

  .dropdown-panel :global(.n-popover-panel) {
    gap: 12px;
  }
</style>
