<script lang="ts" module>
  import type { MigrationResultOption } from "./MigrationResultList.svelte";

  export interface MigrationSourceGroup {
    id: string;
    name: string;
    iconSrc?: string | null;
    status: "searching" | "done" | "failed";
    results: MigrationResultOption[];
  }
</script>

<script lang="ts">
  import { ArrowRight, BookOpen, CircleNotch, MagnifyingGlass, Plugs } from "phosphor-svelte";
  import { _ } from "../../lib/i18n/runtime";
  import { formatAppList } from "../../lib/i18n/format";
  import { applyServiceIconFallback } from "../../lib/assets/serviceIconResolver";

  // The search step across every source: each source gets its own group the moment it answers,
  // while the ones still searching wait below. Sources with nothing to offer fold into one line.
  interface Props {
    query: string;
    groups: MigrationSourceGroup[];
    pendingId?: string | null;
    error?: string | null;
    placeholder?: string;
    onSearch: () => void;
    onPick: (groupId: string, resultId: string) => void;
  }

  let { query = $bindable(), groups, pendingId = null, error = null, placeholder, onSearch, onPick }: Props = $props();

  const withResults = $derived(groups.filter((group) => group.status === "done" && group.results.length > 0));
  const searchingGroups = $derived(groups.filter((group) => group.status === "searching"));
  const emptyNames = $derived(groups.filter((group) => group.status === "done" && group.results.length === 0).map((group) => group.name));
  const failedNames = $derived(groups.filter((group) => group.status === "failed").map((group) => group.name));
  const answered = $derived(groups.length - searchingGroups.length);
  const searching = $derived(searchingGroups.length > 0);

  function markBrokenImage(event: Event) {
    (event.currentTarget as HTMLImageElement).dataset.broken = "true";
  }

  function focusOnMount(node: HTMLElement) {
    node.focus();
  }
</script>

<form class="mg-field" onsubmit={(event) => { event.preventDefault(); if (query.trim()) onSearch(); }}>
  <MagnifyingGlass size={16} weight="bold" />
  <input bind:value={query} placeholder={placeholder ?? $_("ui_searchTitle")} aria-label={placeholder ?? $_("ui_searchTitle")} use:focusOnMount />
  {#if searching}<CircleNotch size={15} weight="bold" class="anim-spin" />{/if}
</form>

{#if groups.length > 0}
  <p class="mg-note" aria-live="polite">{$_("migrate.sourcesSearched", { values: { done: answered, total: groups.length } })}</p>
{/if}

{#if error}
  <p class="mg-note is-warn" role="alert">{error}</p>
{/if}

{#each withResults as group (group.id)}
  <section class="mg-group" aria-label={group.name} data-migration-source-group={group.id}>
    <h3 class="mg-group-head">
      <span class="mg-mark mg-mark--small">
        {#if group.iconSrc}<img src={group.iconSrc} alt="" onerror={(event) => applyServiceIconFallback(event, "source")} />{:else}<Plugs size={13} weight="duotone" />{/if}
      </span>
      <span>{group.name}</span>
    </h3>
    <div class="mg-list">
      {#each group.results as result, i (result.id)}
        <button
          style:--mg-i={i}
          class="mg-row"
          class:is-best={result.best}
          type="button"
          data-migration-result
          disabled={pendingId !== null}
          onclick={() => onPick(group.id, result.id)}
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
  </section>
{/each}

{#if searchingGroups.length > 0}
  <div class="mg-list" aria-busy="true">
    {#each searchingGroups as group (group.id)}
      <div class="mg-group-pending" data-migration-source-searching={group.id}>
        <span class="mg-mark mg-mark--small">
          {#if group.iconSrc}<img src={group.iconSrc} alt="" onerror={(event) => applyServiceIconFallback(event, "source")} />{:else}<Plugs size={13} weight="duotone" />{/if}
        </span>
        <span class="mg-group-pending-name">{group.name}</span>
        <span class="mg-group-pending-state"><CircleNotch size={13} weight="bold" class="anim-spin" /> {$_("ui_searching")}</span>
      </div>
    {/each}
  </div>
{/if}

{#if emptyNames.length > 0}
  <p class="mg-note">{$_("migrate.noResultsIn", { values: { sources: formatAppList(emptyNames) } })}</p>
{/if}
{#if failedNames.length > 0}
  <p class="mg-note is-warn">{$_("migrate.couldNotSearch", { values: { sources: formatAppList(failedNames) } })}</p>
{/if}
