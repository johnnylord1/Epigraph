<script lang="ts" module>
  export interface MigrationSourceOption {
    id: string;
    name: string;
    iconSrc?: string | null;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { ArrowRight, CircleNotch, MagnifyingGlass, Plugs } from "phosphor-svelte";
  import { _ } from "../../lib/i18n/runtime";
  import { applyServiceIconFallback } from "../../lib/assets/serviceIconResolver";
  import { listFlip } from "../../lib/motion/motion";

  // The source step shared by every migration modal: a plain list of sources where one press moves
  // on. The filter only appears once the list is long enough to need it.
  interface Props {
    sources: MigrationSourceOption[];
    loading?: boolean;
    pendingId?: string | null;
    disabled?: boolean;
    emptyLabel: string;
    onPick: (id: string) => void;
    tools?: Snippet;
  }

  let { sources, loading = false, pendingId = null, disabled = false, emptyLabel, onPick, tools }: Props = $props();

  const FILTER_FROM = 8;
  let filter = $state("");
  const showFilter = $derived(sources.length > FILTER_FROM || filter.length > 0);
  const visible = $derived.by(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? sources.filter((source) => source.name.toLowerCase().includes(needle)) : sources;
  });
</script>

{#if loading}
  <div class="mg-list" aria-busy="true">
    {#each Array(5) as _}<div class="mg-skeleton"></div>{/each}
  </div>
{:else if sources.length === 0}
  <div class="mg-empty"><span class="mg-mark"><Plugs size={18} weight="duotone" /></span><span>{emptyLabel}</span></div>
{:else}
  {#if showFilter || tools}
    <div class="mg-toolbar">
      {#if showFilter}
        <label class="mg-field">
          <MagnifyingGlass size={16} weight="bold" />
          <input bind:value={filter} placeholder={$_("migrate.filterSources")} aria-label={$_("migrate.filterSources")} />
        </label>
      {/if}
      {@render tools?.()}
    </div>
  {/if}
  {#if visible.length === 0}
    <div class="mg-empty">{$_("migrate.noSourceMatches")}</div>
  {:else}
    <div class="mg-list">
      {#each visible as source, i (source.id)}
        <button
          animate:listFlip
          style:--mg-i={i}
          class="mg-row"
          class:is-selected={pendingId === source.id}
          type="button"
          data-migration-source
          disabled={disabled || pendingId !== null}
          onclick={() => onPick(source.id)}
        >
          <span class="mg-mark">
            {#if source.iconSrc}<img src={source.iconSrc} alt="" onerror={(event) => applyServiceIconFallback(event, "source")} />{:else}<Plugs size={17} weight="duotone" />{/if}
          </span>
          <span class="mg-row-copy"><strong>{source.name}</strong></span>
          <span class="mg-row-end">
            {#if pendingId === source.id}<CircleNotch size={16} weight="bold" class="anim-spin" />{:else}<ArrowRight size={16} weight="bold" />{/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
{/if}
