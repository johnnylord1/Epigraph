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
  import { prefersReducedMotion } from "../../lib/motion/motion";
  import { cubicOut } from "svelte/easing";
  import type { TransitionConfig } from "svelte/transition";
  import { onMount } from "svelte";

  /**
   * One positioned layer per card, keyed by the card id. A filter or a sort only changes each card's
   * position, so the cards that stay glide to their new place, new ones fade in and removed ones fade
   * out, instead of every row being torn down and rebuilt. Above `virtualizeAfter` only the cards near
   * the viewport are rendered; below it every card is.
   */
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

  let gridEl: HTMLDivElement | null = $state(null);
  let gapProbe: HTMLSpanElement | null = $state(null);
  let viewportWidth = $state(0);
  let columnGapPx = $state(0);
  let rowGapPx = $state(0);
  let measuredItemHeight = $state(0);
  let viewportScrollTop = $state(0);
  let viewportClientHeight = $state(0);

  const fallbackColumnGap = $derived(viewMode === "compact_grid" ? 18 : 24);
  const fallbackRowGap = $derived(viewMode === "list" ? 12 : viewMode === "compact_grid" ? 32 : 40);
  const columnGap = $derived(viewMode === "list" ? 0 : columnGapPx || fallbackColumnGap);
  const rowGap = $derived(viewMode === "list" ? 12 : rowGapPx || fallbackRowGap);
  const columnWidth = $derived.by(() => {
    const usable = Math.max(0, viewportWidth - columnGap * (safeColumns - 1));
    return usable > 0 ? usable / safeColumns : 148;
  });
  const estimatedItemHeight = $derived.by(() => {
    if (viewMode === "list") return estimateLibraryVirtualRowSize(viewMode) - 12;
    const copyHeight = viewMode === "compact_grid" ? 38 : 66;
    return Math.max(
      estimateLibraryVirtualRowSize(viewMode) - fallbackRowGap,
      Math.ceil(columnWidth * 1.5 + copyHeight),
    );
  });
  const rowSize = $derived(Math.max(1, (measuredItemHeight || estimatedItemHeight) + rowGap));
  const totalSize = $derived(Math.max(0, virtualRowCount * rowSize - rowGap));
  const overscanRows = $derived(viewMode === "list" ? 5 : 4);

  const visibleStartRow = $derived(
    shouldVirtualize
      ? Math.max(0, Math.floor(viewportScrollTop / rowSize) - overscanRows)
      : 0,
  );
  const visibleEndRow = $derived(
    shouldVirtualize
      ? Math.min(
          virtualRowCount,
          visibleStartRow
            + Math.ceil(Math.max(viewportClientHeight, rowSize * 3) / rowSize)
            + overscanRows * 2,
        )
      : virtualRowCount,
  );
  const renderedItems = $derived.by(() => {
    const start = visibleStartRow * safeColumns;
    const end = Math.min(resolvedItemCount, visibleEndRow * safeColumns);
    const rendered: Array<{ index: number; vm: LibraryCardVM }> = [];
    for (let index = start; index < end; index += 1) {
      const vm = resolveItem(index);
      if (vm) rendered.push({ index, vm });
    }
    return rendered;
  });

  // Identity of the list as a whole (order included). It changes on a filter, sort or new data,
  // never on scroll or resize, so only those changes animate.
  const listFingerprint = $derived.by(() => {
    let hash = resolvedItemCount;
    for (let index = 0; index < resolvedItemCount; index += 1) {
      const id = resolveItemId(index);
      for (let char = 0; char < id.length; char += 1) {
        hash = (Math.imul(hash, 31) + id.charCodeAt(char)) | 0;
      }
      hash = (Math.imul(hash, 31) + index) | 0;
    }
    return hash;
  });

  let reflowing = $state(false);
  let reflowTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFingerprint: number | null = null;
  let lastColumns = 0;
  // Read by the intro/outro functions when an item enters or leaves; deliberately not reactive.
  let animateMembership = false;
  const REFLOW_MS = 420;

  // Runs before the DOM update, so the transition is in place before the cards get their new
  // positions and before entering/leaving cards run their intro/outro.
  $effect.pre(() => {
    const fingerprint = listFingerprint;
    const columns = safeColumns;
    const changed = lastFingerprint !== null && fingerprint !== lastFingerprint && columns === lastColumns;
    lastFingerprint = fingerprint;
    lastColumns = columns;
    if (!changed || !active || !motionAllowed()) return;
    animateMembership = true;
    reflowing = true;
    if (reflowTimer) clearTimeout(reflowTimer);
    reflowTimer = setTimeout(() => {
      reflowTimer = null;
      reflowing = false;
      animateMembership = false;
    }, REFLOW_MS);
  });

  function motionAllowed() {
    return motionEnvironment.motionEnabled && !prefersReducedMotion();
  }

  function cardEnter(_node: Element, { index }: { index: number }): TransitionConfig {
    if (!animateMembership) return { duration: 0 };
    const order = Math.max(0, index - visibleStartRow * safeColumns);
    return {
      delay: Math.min(order, 12) * 18,
      duration: 260,
      easing: cubicOut,
      css: (t) => `opacity:${t};scale:${0.94 + 0.06 * t}`,
    };
  }

  function cardExit(_node: Element): TransitionConfig {
    if (!animateMembership) return { duration: 0 };
    return {
      duration: 160,
      easing: cubicOut,
      css: (t) => `opacity:${t};scale:${0.96 + 0.04 * t}`,
    };
  }

  onMount(() => {
    const unsubscribe = libraryMotionEnvironment.subscribe((environment) => {
      motionEnvironment = environment;
    });
    return () => {
      unsubscribe();
      if (reflowTimer) clearTimeout(reflowTimer);
    };
  });

  // Width of the grid and the real gap sizes (theme tokens with clamp() resolve only in layout).
  $effect(() => {
    const el = gridEl;
    if (!active || !el) return;
    const read = () => {
      const width = el.clientWidth;
      if (width > 0 && Math.abs(width - viewportWidth) >= 1) viewportWidth = width;
      if (gapProbe) {
        if (gapProbe.offsetWidth > 0) columnGapPx = gapProbe.offsetWidth;
        if (gapProbe.offsetHeight > 0) rowGapPx = gapProbe.offsetHeight;
      }
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  });

  // One card's real height drives the row size; all cards share the same shape.
  $effect(() => {
    const el = gridEl;
    const firstId = renderedItems[0]?.vm.id;
    if (!active || !el || !firstId || typeof ResizeObserver === "undefined") return;
    const first = el.querySelector<HTMLElement>(":scope > .grid-item > *");
    if (!first) return;
    const observer = new ResizeObserver(() => {
      const height = first.offsetHeight;
      if (height > 0 && Math.abs(height - measuredItemHeight) >= 1) measuredItemHeight = height;
    });
    observer.observe(first);
    return () => observer.disconnect();
  });

  $effect(() => {
    const el = scrollElement;
    if (!active || !shouldVirtualize || !el) return;
    let syncFrame: number | null = null;

    const syncViewport = () => {
      const gridTop = gridEl?.offsetTop ?? 0;
      viewportScrollTop = Math.max(0, el.scrollTop - gridTop);
      viewportClientHeight = el.clientHeight;
    };
    const scheduleViewportSync = () => {
      if (syncFrame !== null) return;
      syncFrame = requestAnimationFrame(() => {
        syncFrame = null;
        syncViewport();
      });
    };

    syncViewport();
    el.addEventListener("scroll", scheduleViewportSync, { passive: true });
    return () => {
      el.removeEventListener("scroll", scheduleViewportSync);
      if (syncFrame !== null) cancelAnimationFrame(syncFrame);
    };
  });

  $effect(() => {
    if (!active || !onVisibleRangeChange) return;
    if (!shouldVirtualize) {
      onVisibleRangeChange(0, Math.min(resolvedItemCount, safeColumns * 8));
      return;
    }
    const range = virtualRowsToItemRange(
      visibleStartRow,
      Math.max(visibleStartRow, visibleEndRow - 1),
      safeColumns,
      resolvedItemCount,
    );
    onVisibleRangeChange(range.startIndex, range.endIndex);
  });

  function resolveItem(index: number): LibraryCardVM | null {
    return getItem?.(index) ?? items[index] ?? null;
  }

  function resolveItemId(index: number): string {
    return getItemId?.(index) ?? items[index]?.id ?? String(index);
  }

  function itemStyle(index: number): string {
    const row = Math.floor(index / safeColumns);
    const column = index % safeColumns;
    const x = column * (columnWidth + columnGap);
    const y = row * rowSize;
    return `width:${columnWidth}px;transform:translate3d(${x}px,${y}px,0);`;
  }
</script>

<div
  class="virtual-grid"
  class:is-windowed={shouldVirtualize}
  class:is-reflowing={reflowing}
  class:grid-compact={viewMode === "compact_grid"}
  class:grid-list={viewMode === "list"}
  bind:this={gridEl}
  style={`height:${totalSize}px;`}
>
  <span class="gap-probe" aria-hidden="true" bind:this={gapProbe}></span>
  {#each renderedItems as item (item.vm.id)}
    <div
      class="grid-item"
      data-index={item.index}
      style={itemStyle(item.index)}
      in:cardEnter={{ index: item.index }}
      out:cardExit
    >
      <LibraryCard
        vm={item.vm}
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
    </div>
  {/each}
</div>

<style>
  .virtual-grid {
    position: relative;
    z-index: var(--component-library-panel-z-index);
    isolation: isolate;
    width: 100%;
    min-height: 1px;
    contain: layout style;
  }

  .gap-probe {
    position: absolute;
    top: 0;
    left: 0;
    width: var(--library-grid-column-gap, 24px);
    height: var(--library-grid-row-gap, 40px);
    visibility: hidden;
    pointer-events: none;
  }

  .virtual-grid.grid-compact .gap-probe {
    width: var(--library-grid-compact-column-gap, 18px);
    height: var(--library-grid-compact-row-gap, 32px);
  }

  .grid-item {
    position: absolute;
    top: 0;
    left: 0;
    min-width: 0;
    will-change: transform;
  }

  .grid-item > :global(*) {
    width: 100%;
  }

  /* Only while a filter or sort settles: cards that stay glide to their new slot. */
  .virtual-grid.is-reflowing .grid-item {
    transition: transform 360ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
</style>
