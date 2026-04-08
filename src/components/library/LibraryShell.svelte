<script lang="ts">
  import type { Snippet } from "svelte";
  import type {
    LibraryDisplaySettings,
    LibraryCollectionsReorderApi,
    LibrarySectionKind,
    LibrarySectionTabVM,
    LibraryCollectionVM,
    LibraryToolbarVM,
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
    sortLabel?: string;
    filterLabel?: string;
    collectionsReorderApi?: LibraryCollectionsReorderApi | null;
    headerControls?: Snippet;
    onSectionChange?: (section: LibrarySectionKind) => void;
    onCollectionSelect?: (collectionId: string) => void;
    onSearchChange?: (value: string) => void;
    onSortModeChange?: (mode: string) => void;
    onSortDirToggle?: () => void;
    onFilterChange?: (value: string) => void;
    onViewModeChange?: (mode: LibraryDisplaySettings["viewMode"]) => void;
    onPreferredColumnsChange?: (value: LibraryDisplaySettings["preferredColumns"]) => void;
    onShowProgressChange?: (value: boolean) => void;
    onShowOutlineChange?: (value: boolean) => void;
    children?: Snippet;
  };

  let {
    sectionTabs,
    collections,
    toolbar,
    displaySettings,
    branchesEnabled = true,
    sortDefaultMode,
    sortDefaultDir,
    filterDefaultValue,
    sortLabel = "Sort by",
    filterLabel = "Filter",
    collectionsReorderApi = null,
    headerControls,
    onSectionChange = () => {},
    onCollectionSelect = () => {},
    onSearchChange = () => {},
    onSortModeChange = () => {},
    onSortDirToggle = () => {},
    onFilterChange = () => {},
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
    {#snippet collections()}
      {#if collections.length}
        <LibraryCollectionsBar
          {collections}
          onSelect={onCollectionSelect}
          reorderApi={collectionsReorderApi}
        />
      {/if}
    {/snippet}
    {#snippet toolbar()}
      <LibraryToolbar
        {toolbar}
        {displaySettings}
        {sortDefaultMode}
        {sortDefaultDir}
        {filterDefaultValue}
        {sortLabel}
        {filterLabel}
        {onSearchChange}
        {onSortModeChange}
        {onSortDirToggle}
        {onFilterChange}
        {onViewModeChange}
        {onPreferredColumnsChange}
        {onShowProgressChange}
        {onShowOutlineChange}
      />
    {/snippet}
  </LibraryHeader>

  <div class="body-slot">
    {@render children?.()}
  </div>
</div>

<style>
  .root {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: visible;
    animation: fadeIn 0.14s ease both;
  }

  .body-slot {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .branches {
    position: absolute;
    top: 0;
    right: 0;
    width: 400px;
    height: 600px;
    pointer-events: none;
    z-index: 0;
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
