<script lang="ts">
  import type { LibraryCardVM } from "../../lib/library/contracts";
  import LibraryCard from "./LibraryCard.svelte";

  /**
   * Shared grid invariant:
   * - render identity is always vm.id
   * - vm.id must be stable across filtering, sorting, and tab switches
   */
  type Props = {
    items: LibraryCardVM[];
    viewMode?: "grid" | "compact_grid" | "list";
    effectiveColumns?: number;
    showProgress?: boolean;
    showOutline?: boolean;
    showSelectableState?: boolean;
    onOpen?: (id: string, event: MouseEvent | KeyboardEvent) => void;
    onContextMenu?: (id: string, event: MouseEvent) => void;
    onPointerDown?: (id: string, event: PointerEvent) => void;
    onPointerUp?: (id: string, event: PointerEvent) => void;
    onPointerLeave?: (id: string, event: PointerEvent) => void;
    onCoverLoad?: (id: string) => void;
    onCoverError?: (id: string) => void;
  };

  let {
    items,
    viewMode = "grid",
    effectiveColumns = 1,
    showProgress = true,
    showOutline = true,
    showSelectableState = false,
    onOpen = () => {},
    onContextMenu,
    onPointerDown,
    onPointerUp,
    onPointerLeave,
    onCoverLoad,
    onCoverError,
  }: Props = $props();

  const gridStyle = $derived(
    viewMode === "list"
      ? ""
      : [
          `--library-columns:${Math.max(1, effectiveColumns)};`,
          `--library-card-min:${viewMode === "compact_grid" ? "var(--library-card-min-compact, 104px)" : "var(--library-card-min-grid, 120px)"};`,
          `--library-card-max:${viewMode === "compact_grid" ? "var(--library-card-max-compact, 150px)" : "var(--library-card-max-grid, 180px)"};`,
        ].join(""),
  );
</script>

<div class="grid" class:grid-compact={viewMode === "compact_grid"} class:grid-list={viewMode === "list"} style={gridStyle}>
  {#each items as vm (vm.id)}
    <LibraryCard
      {vm}
      {viewMode}
      {showProgress}
      {showOutline}
      {showSelectableState}
      {onOpen}
      {onContextMenu}
      {onPointerDown}
      {onPointerUp}
      {onPointerLeave}
      {onCoverLoad}
      {onCoverError}
    />
  {/each}
</div>

<style>
  .grid {
    position: relative;
    z-index: 1;
    isolation: isolate;
    display: grid;
    grid-template-columns: repeat(var(--library-columns, 1), minmax(var(--library-card-min, 120px), var(--library-card-max, 1fr)));
    gap: var(--library-grid-row-gap, 40px) var(--library-grid-column-gap, 24px);
    align-items: start;
    justify-content: start;
  }

  .grid-compact {
    gap: var(--library-grid-compact-row-gap, 32px) var(--library-grid-compact-column-gap, 18px);
  }

  .grid-list {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
</style>
