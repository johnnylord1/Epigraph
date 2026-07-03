<script lang="ts">
  import type { Snippet } from "svelte";
  import type {
    LibraryDisplaySettings,
    LibraryCollectionsReorderApi,
    LibrarySectionKind,
    LibrarySectionTabVM,
    LibraryCollectionVM,
    LibraryToolbarVM,
    BooksTypeOptionVM,
  } from "../../lib/library/contracts";
  import LibraryCollectionsBar from "./LibraryCollectionsBar.svelte";
  import LibraryHeader from "./LibraryHeader.svelte";
  import LibraryToolbar from "./LibraryToolbar.svelte";

  type Props = {
    sectionTabs: LibrarySectionTabVM[];
    collections: LibraryCollectionVM[];
    toolbar: LibraryToolbarVM;
    displaySettings: LibraryDisplaySettings;
    branchesEnabled?: boolean;
    sortDefaultMode: string;
    sortDefaultDir: "asc" | "desc";
    filterDefaultValue: string;
    bookTypeOptions?: BooksTypeOptionVM[];
    sortLabel?: string;
    filterLabel?: string;
    collectionsReorderApi?: LibraryCollectionsReorderApi | null;
    headerControls?: Snippet;
    hero?: Snippet;
    onSectionChange?: (section: LibrarySectionKind) => void;
    onCollectionSelect?: (collectionId: string) => void;
    onSearchChange?: (value: string) => void;
    onSortModeChange?: (mode: string) => void;
    onSortDirToggle?: () => void;
    onFilterChange?: (value: string) => void;
    onBookTypeChange?: (value: BooksTypeOptionVM["id"]) => void;
    onViewModeChange?: (mode: LibraryDisplaySettings["viewMode"]) => void;
    onPreferredColumnsChange?: (value: LibraryDisplaySettings["preferredColumns"]) => void;
    onShowProgressChange?: (value: boolean) => void;
    onShowOutlineChange?: (value: boolean) => void;
    children?: Snippet;
  };

  let {
    sectionTabs,
    collections: collectionsVm,
    toolbar: toolbarVm,
    displaySettings,
    branchesEnabled = true,
    sortDefaultMode,
    sortDefaultDir,
    filterDefaultValue,
    bookTypeOptions = [],
    sortLabel = "Sort by",
    filterLabel = "Filter",
    collectionsReorderApi = null,
    headerControls,
    hero,
    onSectionChange = () => {},
    onCollectionSelect = () => {},
    onSearchChange = () => {},
    onSortModeChange = () => {},
    onSortDirToggle = () => {},
    onFilterChange = () => {},
    onBookTypeChange = () => {},
    onViewModeChange = () => {},
    onPreferredColumnsChange = () => {},
    onShowProgressChange = () => {},
    onShowOutlineChange = () => {},
    children,
  }: Props = $props();
</script>

<div class="root">
  {#if branchesEnabled}
    <svg class="branches" viewBox="0 0 400 600" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
      <g stroke="var(--accent)" stroke-width="0.6" fill="none" opacity="0.13">
        <path d="M380 600 C380 500 340 460 310 400 C280 340 300 280 270 220" />
        <path d="M270 220 C255 190 230 175 210 150" />
        <path d="M270 220 C290 195 310 185 330 165" />
        <path d="M310 400 C290 375 265 368 245 350" />
        <path d="M310 400 C330 370 355 362 370 340" />
        <path d="M210 150 C195 128 185 108 175 80" />
        <path d="M210 150 C225 130 240 122 258 105" />
        <path d="M245 350 C228 330 215 315 205 290" />
        <path d="M175 80  C168 60  162 42  158 20" />
        <path d="M175 80  C185 62  195 50  208 35" />
        <path d="M205 290 C196 268 190 250 186 225" />
        <path d="M258 105 C268 88  278 72  292 52" />
        <path class="anim-branch" d="M186 225 C180 205 176 185 174 160" />
        <path class="anim-branch" d="M292 52  C300 36  308 20  318 0" />
      </g>
    </svg>
  {/if}

  <LibraryHeader {sectionTabs} {onSectionChange}>
    {#snippet headerControls()}
      {@render headerControls?.()}
    {/snippet}
    {#snippet centerContent()}
      <LibraryToolbar
        toolbar={toolbarVm}
        {displaySettings}
        {sortDefaultMode}
        {sortDefaultDir}
        {filterDefaultValue}
        {bookTypeOptions}
        {sortLabel}
        {filterLabel}
        {onSearchChange}
        {onSortModeChange}
        {onSortDirToggle}
        {onFilterChange}
        {onBookTypeChange}
        {onViewModeChange}
        {onPreferredColumnsChange}
        {onShowProgressChange}
        {onShowOutlineChange}
        showActions={false}
      />
    {/snippet}
    {#if collectionsVm.length}
      {#snippet collections()}
        <LibraryCollectionsBar
          collections={collectionsVm}
          onSelect={onCollectionSelect}
          reorderApi={collectionsReorderApi}
        />
      {/snippet}
    {/if}
  </LibraryHeader>

  {#if hero}
    <div class="hero-slot">
      {@render hero?.()}
    </div>
  {/if}

  <div class="body-slot">
    {@render children?.()}
  </div>
</div>

<style>
  .root {
    --library-shell-padding-x: clamp(18px, 3.1vw, 40px);
    --library-hero-padding-top: clamp(10px, 1.25vw, 14px);
    --library-hero-stack-gap: clamp(10px, 1.25vw, 16px);
    --library-hero-top-gap: clamp(14px, 2.1vw, 32px);
    --library-collections-row-gap: clamp(12px, 1.7vw, 24px);
    --library-chip-stack-gap: clamp(6px, 0.8vw, 8px);
    --library-chip-gap: clamp(7px, 1vw, 12px);
    --library-system-chip-gap: clamp(5px, 0.7vw, 8px);
    --library-system-chip-indent: clamp(8px, 1.2vw, 18px);
    --library-chip-height: clamp(24px, 2.8vw, 32px);
    --library-chip-padding-x: clamp(10px, 1.4vw, 18px);
    --library-chip-font-size: clamp(9px, 1.02vw, 11px);
    --library-title-size: clamp(1.72rem, 4.6vw, 2.2rem);
    --library-grid-row-gap: clamp(26px, 4.2vw, 40px);
    --library-grid-column-gap: clamp(14px, 2.2vw, 24px);
    --library-grid-compact-row-gap: clamp(22px, 3.5vw, 32px);
    --library-grid-compact-column-gap: clamp(10px, 1.7vw, 18px);
    --library-content-padding-top: clamp(14px, 2.4vw, 20px);
    --library-content-padding-bottom: clamp(18px, 2.9vw, 24px);
    --library-toolbar-gap: calc(12px * var(--component-library-scale));
    --library-toolbar-cluster-gap: calc(8px * var(--component-library-scale));
    --library-toolbar-height: calc(44px * var(--component-library-scale));
    --library-icon-btn-size: calc(36px * var(--component-library-scale));
    --library-toolbar-icon-size: calc(15px * var(--component-library-scale));
    --library-card-min-grid: clamp(104px, 18vw, 140px);
    --library-card-max-grid: clamp(126px, 22vw, 180px);
    --library-card-min-compact: clamp(88px, 15vw, 116px);
    --library-card-max-compact: clamp(108px, 18vw, 150px);
    --library-card-cover-radius: clamp(10px, 1.8vw, 16px);
    --library-card-info-gap: clamp(4px, 0.8vw, 7px);
    --library-card-copy-margin-top: clamp(4px, 0.9vw, 8px);
    --library-card-title-font-size: clamp(10px, 1.45vw, var(--text-xs));
    --library-card-meta-font-size: clamp(7.5px, 1.1vw, 9px);
    --library-card-badge-height: clamp(16px, 2.4vw, 20px);
    --library-card-badge-padding-x: clamp(5px, 1vw, 7px);
    --library-card-badge-font-size: clamp(7px, 1vw, 9px);
    --library-card-badge-inset: clamp(5px, 1vw, 8px);
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: visible;
    animation: fadeIn 0.14s ease both;
  }

  .body-slot {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding-top: calc(12px * var(--component-library-scale));
  }

  .hero-slot {
    flex-shrink: 0;
  }

  .branches {
    position: absolute;
    top: 0;
    right: 0;
    width: 400px;
    height: 600px;
    pointer-events: none;
    z-index: var(--component-library-panel-hidden-z-index);
  }

  .branches :global(.anim-branch) {
    stroke-dasharray: 60;
    stroke-dashoffset: 60;
    animation: branchGrow 2.4s ease forwards;
  }

  @keyframes branchGrow {
    to { stroke-dashoffset: 0; }
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
