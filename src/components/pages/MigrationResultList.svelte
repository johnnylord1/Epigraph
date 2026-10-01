<script lang="ts" module>
  export interface MigrationResultOption {
    id: string;
    title: string;
    coverSrc: string | null;
    hint?: string;
    best?: boolean;
  }
</script>

<script lang="ts">
  import { ArrowRight, BookOpen, CircleNotch, MagnifyingGlass } from "phosphor-svelte";
  import { _ } from "../../lib/i18n/runtime";
  import NocturneState from "../shared/NocturneState.svelte";
  import { listFlip } from "../../lib/motion/motion";

  // The search step shared by every migration modal: one field (Enter searches again) and the
  // results, where one press opens the confirmation.
  interface Props {
    query: string;
    searching: boolean;
    results: MigrationResultOption[];
    pendingId?: string | null;
    error?: string | null;
    errorTitle?: string;
    emptyLabel?: string;
    placeholder?: string;
    onSearch: () => void;
    onPick: (id: string) => void;
  }

  let {
    query = $bindable(),
    searching,
    results,
    pendingId = null,
    error = null,
    errorTitle,
    emptyLabel,
    placeholder,
    onSearch,
    onPick,
  }: Props = $props();

  function markBrokenImage(event: Event) {
    (event.currentTarget as HTMLImageElement).dataset.broken = "true";
  }

  function focusOnMount(node: HTMLElement) {
    node.focus();
  }
</script>

<form class="mg-field" onsubmit={(event) => { event.preventDefault(); if (query.trim() && !searching) onSearch(); }}>
  <MagnifyingGlass size={16} weight="bold" />
  <input bind:value={query} placeholder={placeholder ?? $_("ui_searchTitle")} aria-label={placeholder ?? $_("ui_searchTitle")} use:focusOnMount />
  {#if searching}<CircleNotch size={15} weight="bold" class="anim-spin" />{/if}
</form>

{#if error}
  <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("ui_migration")} title={errorTitle ?? $_("ui_searchFailed")} body={error} />
{/if}

{#if searching}
  <div class="mg-list" aria-busy="true">
    {#each Array(4) as _}<div class="mg-skeleton"></div>{/each}
  </div>
{:else if results.length > 0}
  <div class="mg-list">
    {#each results as result, i (result.id)}
      <button
        animate:listFlip
        style:--mg-i={i}
        class="mg-row"
        class:is-best={result.best}
        type="button"
        data-migration-result
        disabled={pendingId !== null}
        onclick={() => onPick(result.id)}
      >
        <span class="mg-cover">
          {#if result.coverSrc}<img src={result.coverSrc} alt="" onerror={markBrokenImage} />{:else}<BookOpen size={18} weight="duotone" />{/if}
        </span>
        <span class="mg-row-copy">
          <strong title={result.title}>{result.title}</strong>
          {#if result.hint}<small>{result.hint}</small>{/if}
        </span>
        <span class="mg-row-end">
          {#if pendingId === result.id}<CircleNotch size={16} weight="bold" class="anim-spin" />{:else}<ArrowRight size={16} weight="bold" />{/if}
        </span>
      </button>
    {/each}
  </div>
{:else if !error}
  <div class="mg-empty">
    <span class="mg-mark"><MagnifyingGlass size={18} weight="duotone" /></span>
    <span>{emptyLabel ?? (query.trim() ? $_("ui_noResultsTryADifferentTitle") : $_("ui_enterATitleToSearch"))}</span>
  </div>
{/if}
