<script lang="ts">
  import { onMount } from "svelte";
  import { BookOpen } from "phosphor-svelte";
  import { computeLibraryLayout, type LibraryPreferredGridColumns, type LibraryViewMode } from "../../lib/libraryDisplay";
  import type { NovelShelfCard } from "../../lib/novels/libraryShelf";
  import LibraryCardGrid from "./LibraryCardGrid.svelte";

  type Props = {
    cards: NovelShelfCard[];
    emptyMessage: string;
    viewMode: LibraryViewMode;
    preferredColumns: LibraryPreferredGridColumns;
    showProgress: boolean;
    showOutline: boolean;
    onOpenNovel?: (novelId: string) => void;
  };

  let {
    cards,
    emptyMessage,
    viewMode = "grid",
    preferredColumns = "auto",
    showProgress = true,
    showOutline = true,
    onOpenNovel = () => {},
  }: Props = $props();

  let contentEl: HTMLDivElement | null = $state(null);
  let contentWidth = $state(0);

  const layout = $derived(
    computeLibraryLayout({
      availableWidth: contentWidth,
      preferredColumns,
      mode: viewMode,
    }),
  );

  onMount(() => {
    let resizeObserver: ResizeObserver | null = null;
    queueMicrotask(() => {
      if (!contentEl) return;
      contentWidth = contentEl.clientWidth;
      resizeObserver = new ResizeObserver((entries) => {
        contentWidth = entries[0]?.contentRect.width ?? contentEl?.clientWidth ?? 0;
      });
      resizeObserver.observe(contentEl);
    });

    return () => resizeObserver?.disconnect();
  });
</script>

<div class="content" bind:this={contentEl}>
  {#if cards.length === 0}
    <div class="center novels-empty">
      <BookOpen size={28} weight="duotone" />
      <span>{emptyMessage}</span>
    </div>
  {:else}
    <LibraryCardGrid
      items={cards}
      {viewMode}
      effectiveColumns={layout.effectiveColumns}
      {showProgress}
      {showOutline}
      onOpen={(cardId) => {
        const card = cards.find((entry) => entry.id === cardId);
        if (card) onOpenNovel(card.novelId);
      }}
    />
  {/if}
</div>

<style>
  .content {
    position: relative;
    flex: 1;
    overflow-y: auto;
    padding: var(--sp-5) var(--sp-6) var(--sp-6);
    min-height: 0;
  }

  .center {
    position: relative;
    z-index: 1;
    min-height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-3);
    text-align: center;
    color: var(--text-muted);
  }

  .novels-empty {
    font-size: var(--text-sm);
    line-height: var(--leading-base);
  }
</style>
