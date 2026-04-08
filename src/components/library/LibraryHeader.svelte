<script lang="ts">
  import type { Snippet } from "svelte";
  import { BookOpen, Stack } from "phosphor-svelte";
  import type { LibrarySectionKind, LibrarySectionTabVM } from "../../lib/library/contracts";

  type Props = {
    heading?: string;
    sectionTabs: LibrarySectionTabVM[];
    headerControls?: Snippet;
    collections?: Snippet;
    toolbar?: Snippet;
    onSectionChange?: (section: LibrarySectionKind) => void;
  };

  let {
    heading = "Library",
    sectionTabs,
    headerControls,
    collections,
    toolbar,
    onSectionChange = () => {},
  }: Props = $props();
</script>

<div class="header">
  <div class="header-top">
    <div class="header-left">
      <span class="heading">{heading}</span>
      <div class="tabs section-tabs" aria-label={`${heading} sections`}>
        {#each sectionTabs as tab}
          <button
            type="button"
            class="tab section-tab"
            class:active={tab.active}
            onclick={() => onSectionChange(tab.id)}
            aria-pressed={tab.active}
          >
            {#if tab.icon === "stack"}
              <Stack size={11} weight="bold" />
            {:else}
              <BookOpen size={11} weight="bold" />
            {/if}
            {tab.label}
          </button>
        {/each}
      </div>
      {@render headerControls?.()}
    </div>
    <div class="header-right">
      {@render toolbar?.()}
    </div>
  </div>
  {#if collections}
    <div class="header-bottom">
      {@render collections?.()}
    </div>
  {/if}
</div>

<style>
  .header {
    position: relative;
    z-index: 4;
    display: flex;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding: var(--sp-4) var(--sp-6);
    border-bottom: 1px solid var(--border-dim);
    gap: var(--sp-3);
    flex-shrink: 0;
  }

  .header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-4);
    flex-wrap: wrap;
  }

  .header-left,
  .header-right,
  .header-bottom {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    flex-wrap: wrap;
  }

  .header-right {
    justify-content: flex-end;
    margin-left: auto;
  }

  .header-bottom {
    min-height: 0;
  }

  .heading {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .tabs {
    display: flex;
    gap: 2px;
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
    border-radius: var(--radius-md);
    padding: 2px;
  }

  .section-tabs {
    background: var(--bg-overlay);
    border-color: var(--border-base);
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
    transition: background var(--t-base), color var(--t-base), border-color var(--t-base);
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
</style>
