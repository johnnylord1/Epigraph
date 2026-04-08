<script lang="ts">
  import { BookOpen, Books, DownloadSimple, FileText, Folder, Stack, Star } from "phosphor-svelte";
  import type { LibraryCollectionVM, LibraryCollectionsReorderApi } from "../../lib/library/contracts";

  type Props = {
    collections: LibraryCollectionVM[];
    onSelect?: (collectionId: string) => void;
    reorderApi?: LibraryCollectionsReorderApi | null;
  };

  let {
    collections,
    onSelect = () => {},
    reorderApi = null,
  }: Props = $props();
</script>

<div class="tabs collections-bar" aria-label="Collections">
  {#each collections as collection, index}
    {#if reorderApi && reorderApi.activeId && reorderApi.insertIndex === index}
      <div class="tab-insert-bar" aria-hidden="true"></div>
    {/if}
    <button
      type="button"
      class="tab"
      class:active={collection.active}
      class:tab-dragging={reorderApi?.activeId === collection.id}
      class:tab-drop-target={reorderApi?.targetId === collection.id}
      class:tab-default={collection.isDefault}
      draggable={collection.reorderable && !!reorderApi}
      onclick={() => onSelect(collection.id)}
      ondragstart={reorderApi && collection.reorderable ? ((event) => reorderApi.onDragStart(collection.id, event)) : undefined}
      ondragover={reorderApi && collection.reorderable ? ((event) => reorderApi.onDragOver(collection.id, index, event)) : undefined}
      ondragleave={reorderApi && collection.reorderable ? ((event) => reorderApi.onDragLeave(collection.id, event)) : undefined}
      ondrop={reorderApi && collection.reorderable ? ((event) => reorderApi.onDrop(collection.id, index, event)) : undefined}
      ondragend={reorderApi && collection.reorderable ? ((event) => reorderApi.onDragEnd(event)) : undefined}
    >
      {#if collection.icon === "books"}
        <Books size={11} weight="bold" />
      {:else if collection.icon === "download"}
        <DownloadSimple size={11} weight="bold" />
      {:else if collection.icon === "folder"}
        {#if collection.isDefault}
          <Star size={11} weight="fill" style="color:var(--accent-fg)" />
        {:else}
          <Folder size={11} weight="bold" />
        {/if}
      {:else if collection.icon === "file"}
        <FileText size={11} weight="bold" />
      {:else if collection.icon === "book"}
        <BookOpen size={11} weight="bold" />
      {:else}
        <Stack size={11} weight="bold" />
      {/if}
      {collection.label}
      <span class="tab-count">{collection.count}</span>
    </button>
  {/each}
  {#if reorderApi && reorderApi.activeId && reorderApi.insertIndex === collections.length}
    <div class="tab-insert-bar" aria-hidden="true"></div>
  {/if}
</div>

<style>
  .collections-bar {
    display: flex;
    gap: 2px;
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
    border-radius: var(--radius-md);
    padding: 2px;
    flex-wrap: wrap;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    color: var(--text-faint);
    white-space: nowrap;
    transition: background var(--t-base), color var(--t-base), border-color var(--t-base), opacity var(--t-base);
    background: transparent;
    border: 1px solid transparent;
    cursor: pointer;
  }

  .tab:hover {
    color: var(--text-muted);
  }

  .tab.active {
    background: var(--accent-muted);
    color: var(--accent-fg);
    border-color: var(--accent-dim);
  }

  .tab-default {
    color: var(--text-muted);
  }

  .tab-dragging {
    opacity: 0.4;
    cursor: grabbing;
  }

  .tab-drop-target {
    background: var(--accent-muted) !important;
    color: var(--accent-fg) !important;
    outline: 1px dashed var(--accent);
  }

  .tab-count {
    font-size: var(--text-2xs);
    opacity: 0.6;
  }

  .tab-insert-bar {
    width: 2px;
    height: 22px;
    background: var(--accent);
    border-radius: 2px;
    flex-shrink: 0;
    box-shadow: 0 0 6px var(--accent);
    pointer-events: none;
    align-self: center;
  }
</style>
