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
      : `--library-columns:${Math.max(1, effectiveColumns)};`,
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
    grid-template-columns: repeat(var(--library-columns, 1), minmax(0, 1fr));
    gap: var(--sp-4);
    align-items: start;
  }

  .grid-compact {
    gap: var(--sp-3);
  }

  .grid-list {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--sp-3);
  }
</style>
