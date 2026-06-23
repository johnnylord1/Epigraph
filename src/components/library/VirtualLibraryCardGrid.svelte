<script lang="ts">
  import type { LibraryCardVM } from "../../lib/library/contracts";
  import type { LibraryViewMode } from "../../lib/libraryDisplay";
  import {
    estimateLibraryVirtualRowSize,
    virtualRowsToItemRange,
  } from "../../lib/library/virtualGrid";
  import LibraryCard from "./LibraryCard.svelte";
  import {
    DEFAULT_LIBRARY_MOTION_ENVIRONMENT,
    libraryMotionEnvironment,
    type LibraryMotionEnvironment,
  } from "../../lib/library/motionGate";
  import { onMount } from "svelte";

  type Props = {
    items?: LibraryCardVM[];
    itemCount?: number;
    getItem?: (index: number) => LibraryCardVM | null | undefined;
    getItemId?: (index: number) => string;
    viewMode?: LibraryViewMode;
    effectiveColumns?: number;
    scrollElement?: HTMLElement | null;
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
    onVisibleRangeChange?: (startIndex: number, endIndex: number) => void;
    virtualizeAfter?: number;
    active?: boolean;
    panelMotionEnabled?: boolean;
  };

  let {
    items = [],
    itemCount,
    getItem,
    getItemId,
    viewMode = "grid",
    effectiveColumns = 1,
    scrollElement = null,
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
    onVisibleRangeChange,
    virtualizeAfter = 1200,
    active = true,
    panelMotionEnabled = true,
  }: Props = $props();

  let motionEnvironment: LibraryMotionEnvironment = $state(DEFAULT_LIBRARY_MOTION_ENVIRONMENT);

  const safeColumns = $derived(viewMode === "list" ? 1 : Math.max(1, effectiveColumns || 1));
  const resolvedItemCount = $derived(itemCount ?? items.length);
  const shouldVirtualize = $derived(resolvedItemCount > virtualizeAfter);
  const virtualRowCount = $derived(Math.ceil(resolvedItemCount / safeColumns));
  const gridStyle = $derived(
    viewMode === "list"
      ? ""
      : `--library-columns:${safeColumns};`,
  );
  let viewportWidth = $state(0);
  const estimatedDynamicRowSize = $derived.by(() => {
    const estimateSize = estimateLibraryVirtualRowSize(viewMode);
    if (viewMode === "list") return estimateSize;
    const columns = Math.max(1, safeColumns);
    const columnGap = viewMode === "compact_grid" ? 18 : 24;
    const rowGap = viewMode === "compact_grid" ? 32 : 40;
    const usableWidth = Math.max(0, viewportWidth - columnGap * (columns - 1));
    const columnWidth = usableWidth > 0 ? usableWidth / columns : 148;
    const coverHeight = columnWidth * 1.5;
    const copyHeight = viewMode === "compact_grid" ? 38 : 66;
    return Math.max(estimateSize, Math.ceil(coverHeight + copyHeight + rowGap));
  });
  const rowSize = $derived(estimatedDynamicRowSize);
  const overscanRows = $derived(viewMode === "list" ? 5 : 4);
  let virtualGridEl: HTMLDivElement | null = $state(null);
  let viewportScrollTop = $state(0);
  let viewportClientHeight = $state(0);
  const layoutVersion = $derived(`${safeColumns}:${viewMode}`);

  const visibleStartRow = $derived(
    Math.max(0, Math.floor(viewportScrollTop / Math.max(1, rowSize)) - overscanRows),
  );
  const visibleEndRow = $derived(
    Math.min(
      virtualRowCount,
      visibleStartRow
        + Math.ceil(Math.max(viewportClientHeight, rowSize * 3) / Math.max(1, rowSize))
        + overscanRows * 2,
    ),
  );
  const renderedVirtualItems = $derived(
    Array.from({ length: Math.max(0, visibleEndRow - visibleStartRow) }, (_, offset) => {
      const rowIndex = visibleStartRow + offset;
      return {
        index: rowIndex,
        key: getVirtualRowKey(rowIndex),
        start: rowIndex * rowSize,
        size: rowSize,
        end: (rowIndex + 1) * rowSize,
        lane: 0,
      };
    }),
  );
  const totalSize = $derived(virtualRowCount * rowSize);

  onMount(() => libraryMotionEnvironment.subscribe((environment) => {
    motionEnvironment = environment;
  }));

  $effect(() => {
    const el = scrollElement;
    if (!active || !shouldVirtualize || !el) return;
    let syncFrame: number | null = null;
    let initialSyncFrame: number | null = null;

    const syncViewport = () => {
      const gridTop = virtualGridEl?.offsetTop ?? 0;
      viewportScrollTop = Math.max(0, el.scrollTop - gridTop);
      viewportClientHeight = el.clientHeight;
      viewportWidth = virtualGridEl?.clientWidth ?? el.clientWidth;
    };

    const scheduleViewportSync = () => {
      if (syncFrame !== null) return;
      syncFrame = requestAnimationFrame(() => {
        syncFrame = null;
        syncViewport();
      });
    };

    syncViewport();
    initialSyncFrame = requestAnimationFrame(() => {
      initialSyncFrame = null;
      syncViewport();
    });
    el.addEventListener("scroll", scheduleViewportSync, { passive: true });

    return () => {
      el.removeEventListener("scroll", scheduleViewportSync);
      if (syncFrame !== null) cancelAnimationFrame(syncFrame);
      if (initialSyncFrame !== null) cancelAnimationFrame(initialSyncFrame);
    };
  });

  $effect(() => {
    safeColumns;
    viewMode;
    showProgress;
    showOutline;
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const el = scrollElement;
      if (!el || !virtualGridEl) return;
      viewportScrollTop = Math.max(0, el.scrollTop - virtualGridEl.offsetTop);
      viewportClientHeight = el.clientHeight;
      viewportWidth = virtualGridEl.clientWidth || el.clientWidth;
    });
    return () => cancelAnimationFrame(frame);
  });

  $effect(() => {
    const el = virtualGridEl;
    if (!active || !el || typeof ResizeObserver === "undefined") return;
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = el.clientWidth;
      if (Math.abs(nextWidth - lastWidth) < 1) return;
      lastWidth = nextWidth;
      viewportWidth = nextWidth;
    });
    observer.observe(el);
    viewportWidth = el.clientWidth;
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!active || !onVisibleRangeChange) return;
    if (!shouldVirtualize) {
      onVisibleRangeChange(0, Math.min(resolvedItemCount, safeColumns * 8));
      return;
    }
    if (!renderedVirtualItems.length) {
      onVisibleRangeChange(0, Math.min(resolvedItemCount, safeColumns * 5));
      return;
    }

    const firstRow = renderedVirtualItems[0]!.index;
    const lastRow = renderedVirtualItems[renderedVirtualItems.length - 1]!.index;
    const range = virtualRowsToItemRange(firstRow, lastRow, safeColumns, resolvedItemCount);
    onVisibleRangeChange(range.startIndex, range.endIndex);
  });

  function resolveItem(index: number): LibraryCardVM | null {
    return getItem?.(index) ?? items[index] ?? null;
  }

  function resolveItemId(index: number): string {
    return getItemId?.(index) ?? items[index]?.id ?? String(index);
  }

  function getVirtualRowKey(rowIndex: number): string {
    const startIndex = rowIndex * safeColumns;
    const endIndex = Math.min(resolvedItemCount, startIndex + safeColumns);
    const ids: string[] = [];
    for (let index = startIndex; index < endIndex; index += 1) {
      ids.push(resolveItemId(index));
    }
    return ids.join("|") || String(rowIndex);
  }

  function getVirtualRowItems(rowIndex: number): LibraryCardVM[] {
    const startIndex = rowIndex * safeColumns;
    const endIndex = Math.min(resolvedItemCount, startIndex + safeColumns);
    const rowItems: LibraryCardVM[] = [];
    for (let index = startIndex; index < endIndex; index += 1) {
      const item = resolveItem(index);
      if (item) rowItems.push(item);
    }
    return rowItems;
  }

</script>

{#if shouldVirtualize}
  <div
    class="virtual-grid"
    class:grid-compact={viewMode === "compact_grid"}
    class:grid-list={viewMode === "list"}
    bind:this={virtualGridEl}
    style={`height:${totalSize}px;`}
  >
    {#each renderedVirtualItems as virtualRow (`${layoutVersion}:${virtualRow.key}`)}
      {@const rowItems = getVirtualRowItems(virtualRow.index)}
      {#if rowItems.length}
        <div
          class="virtual-row"
          data-index={virtualRow.index}
          style={`transform:translateY(${virtualRow.start}px);`}
        >
          <div class="grid" class:grid-compact={viewMode === "compact_grid"} class:grid-list={viewMode === "list"} style={gridStyle}>
            {#each rowItems as vm (vm.id)}
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
                panelActive={active}
                {scrollElement}
                {motionEnvironment}
                {panelMotionEnabled}
              />
            {/each}
          </div>
        </div>
      {/if}
    {/each}
  </div>
{:else}
  <div class="grid persistent-grid" class:grid-compact={viewMode === "compact_grid"} class:grid-list={viewMode === "list"} style={gridStyle}>
    {#each Array.from({ length: resolvedItemCount }, (_, index) => index) as index (resolveItemId(index))}
      {@const vm = resolveItem(index)}
      {#if vm}
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
          panelActive={active}
          {scrollElement}
          {motionEnvironment}
          {panelMotionEnabled}
        />
      {/if}
    {/each}
  </div>
{/if}

<style>
  .virtual-grid {
    position: relative;
    z-index: 1;
    isolation: isolate;
    width: 100%;
    min-height: 1px;
    contain: layout style;
  }

  .virtual-row {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    padding-bottom: var(--library-grid-row-gap, 40px);
    overflow: visible;
    contain: layout style;
    will-change: transform;
  }

  .virtual-grid.grid-compact .virtual-row {
    padding-bottom: var(--library-grid-compact-row-gap, 32px);
  }

  .virtual-grid.grid-list .virtual-row {
    padding-bottom: 12px;
  }

  .grid {
    position: relative;
    z-index: 1;
    isolation: isolate;
    display: grid;
    grid-template-columns: repeat(var(--library-columns, 1), minmax(0, 1fr));
    gap: 0 var(--library-grid-column-gap, 24px);
    align-items: start;
    justify-content: stretch;
    overflow: visible;
  }

  .persistent-grid {
    gap: var(--library-grid-row-gap, 40px) var(--library-grid-column-gap, 24px);
  }

  .grid-compact {
    gap: 0 var(--library-grid-compact-column-gap, 18px);
  }

  .persistent-grid.grid-compact {
    gap: var(--library-grid-compact-row-gap, 32px) var(--library-grid-compact-column-gap, 18px);
  }

  .grid-list {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }

  .persistent-grid.grid-list {
    gap: 12px;
  }
</style>
