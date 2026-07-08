<script lang="ts">
  import type { Snippet } from "svelte";
  import type { LibrarySectionKind, LibrarySectionTabVM } from "../../lib/library/contracts";
  import AppTopbar from "../layout/AppTopbar.svelte";
  import ActivityButton from "../layout/ActivityButton.svelte";
  import WindowControlsInline from "../layout/WindowControlsInline.svelte";

  type Props = {
    heading?: string;
    sectionTabs: LibrarySectionTabVM[];
    headerControls?: Snippet;
    centerContent?: Snippet;
    collections?: Snippet;
    children?: Snippet;
    onSectionChange?: (section: LibrarySectionKind) => void;
  };

  let {
    heading = "Library",
    sectionTabs,
    headerControls,
    centerContent,
    collections,
    children,
    onSectionChange = () => {},
  }: Props = $props();
</script>

<div class="header">
  <AppTopbar className="library-header-topbar">
    {#snippet left()}
      <div class="header-left">
      <nav class="n-segmented section-tabs" aria-label={`${heading} sections`} data-active={sectionTabs.find((tab) => tab.active)?.id ?? "comics"}>
        <span class="n-segmented__thumb" aria-hidden="true"></span>
        {#each sectionTabs as tab}
          <button
            type="button"
            class="n-segmented__btn section-tab"
            class:is-active={tab.active}
            onclick={() => onSectionChange(tab.id)}
            aria-pressed={tab.active}
          >
            {tab.label}
          </button>
        {/each}
      </nav>
      {@render headerControls?.()}
      </div>
    {/snippet}
    {#snippet center()}
      <div class="header-center">
        {@render centerContent?.()}
      </div>
    {/snippet}
    {#snippet right()}
      <div class="header-right">
      <ActivityButton />
      <WindowControlsInline />
      </div>
    {/snippet}
  </AppTopbar>
  {#if collections}
    <div class="header-bottom">
      {@render collections?.()}
    </div>
  {/if}
  {@render children?.()}
</div>

<style>
  .header {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    flex-shrink: 0;
    padding-top: var(--component-library-topbar-height);
  }

  .header :global(.library-header-topbar) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: calc(16px * var(--component-library-scale));
  }

  .header-left,
  .header-right,
  .header-center,
  .header-bottom {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
    min-width: 0;
    flex-wrap: nowrap;
    -webkit-app-region: drag;
  }

  .header-right {
    justify-content: flex-end;
    z-index: var(--component-library-control-z-index);
  }

  .header-center {
    justify-content: center;
    width: 100%;
  }

  .header-bottom {
    min-height: 0;
    padding: 0 28px calc(22px * var(--component-library-scale));
    margin-bottom: calc(2px * var(--component-library-scale));
    display: flex;
    align-items: center;
    width: 100%;
    min-width: 0;
  }

  .header :global(button),
  .header :global(input),
  .header :global(select),
  .header :global(textarea),
  .header :global(a),
  .header :global([role="button"]),
  .header :global([role="menu"]),
  .header :global(.n-popover-surface) {
    -webkit-app-region: no-drag;
  }

  .header :global(button *),
  .header :global(a *),
  .header :global([role="button"] *) {
    -webkit-app-region: no-drag;
  }
</style>
