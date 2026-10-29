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
  import { ArrowRight, BookOpen, CircleNotch, DotsThreeVertical, MagnifyingGlass, Plugs } from "phosphor-svelte";
  import { _ } from "../../lib/i18n/runtime";
  import { formatAppList } from "../../lib/i18n/format";
  import { applyServiceIconFallback } from "../../lib/assets/serviceIconResolver";
  import { popIn, popOut } from "../../lib/motion/motion";
  import { floatMenu } from "./migrationMenu";

  // The search step across every source: each source gets one line the moment it answers, the
  // source on the left and its closest title on the right, like the mass migration queue. The other
  // titles wait in the line's menu, while the sources still searching wait below. Sources with
  // nothing to offer fold into one line.
  interface Props {
    query: string;
    groups: MigrationSourceGroup[];
    pendingId?: string | null;
    error?: string | null;
    placeholder?: string;
    onSearch: () => void;
    onPick: (groupId: string, resultId: string) => void;
    onShowAll: (groupId: string) => void;
  }

  let { query = $bindable(), groups, pendingId = null, error = null, placeholder, onSearch, onPick, onShowAll }: Props = $props();

  // The menu lists this many other titles; a source with more offers its full list instead.
  const MENU_ALTERNATIVES = 5;
  let openMenuId: string | null = $state(null);

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

  function closeMenu() {
    openMenuId = null;
  }

  function pickFromMenu(groupId: string, resultId: string) {
    openMenuId = null;
    onPick(groupId, resultId);
  }

  function showAllFromMenu(groupId: string) {
    openMenuId = null;
    onShowAll(groupId);
  }

  function closeMenuOnEscape(event: KeyboardEvent) {
    if (event.key !== "Escape" || openMenuId === null) return;
    // Escape closes the menu first; the dialog only closes on the next one.
    event.stopPropagation();
    const wrap = event.currentTarget as HTMLElement;
    openMenuId = null;
    wrap.querySelector<HTMLElement>(".mg-icon-btn")?.focus();
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

<div class="mg-list">
  {#each withResults as group, i (group.id)}
    {@const best = group.results[0]}
    {@const alternatives = group.results.slice(1, 1 + MENU_ALTERNATIVES)}
    {@const pending = pendingId !== null && group.results.some((result) => result.id === pendingId)}
    <section style:--mg-i={i} class="mg-group mg-source-match" aria-label={group.name} data-migration-source-group={group.id}>
      <span class="mg-side">
        <span class="mg-mark">
          {#if group.iconSrc}<img src={group.iconSrc} alt="" onerror={(event) => applyServiceIconFallback(event, "source")} />{:else}<Plugs size={16} weight="duotone" />{/if}
        </span>
        <span class="mg-row-copy">
          <strong title={group.name}>{group.name}</strong>
          {#if group.results.length > 1}<small>{$_("migrate.resultCount", { count: group.results.length })}</small>{/if}
        </span>
      </span>
      <span class="mg-queue-arrow" aria-hidden="true"><ArrowRight size={14} weight="bold" /></span>
      <button
        class="mg-row"
        class:is-best={best.best}
        type="button"
        data-migration-result
        disabled={pendingId !== null}
        onclick={() => onPick(group.id, best.id)}
      >
        <span class="mg-cover">
          {#if best.coverSrc}<img src={best.coverSrc} alt="" onerror={markBrokenImage} />{:else}<BookOpen size={18} weight="duotone" />{/if}
        </span>
        <span class="mg-row-copy">
          <strong title={best.title}>{best.title}</strong>
          {#if best.hint}<small>{best.hint}</small>{/if}
        </span>
        <span class="mg-row-end">
          {#if pending}<CircleNotch size={16} weight="bold" class="anim-spin" />{:else}<ArrowRight size={16} weight="bold" />{/if}
        </span>
      </button>
      {#if group.results.length > 1}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="mg-menu-wrap" onkeydown={closeMenuOnEscape}>
          <button
            class="mg-icon-btn"
            type="button"
            disabled={pendingId !== null}
            onclick={() => { openMenuId = openMenuId === group.id ? null : group.id; }}
            aria-haspopup="menu"
            aria-expanded={openMenuId === group.id}
            aria-label={$_("migrate.moreMatchesFor", { source: group.name })}
          >
            <DotsThreeVertical size={18} weight="bold" />
          </button>
          {#if openMenuId === group.id}
            <div class="mg-menu mg-menu--matches" role="menu" use:floatMenu={closeMenu} in:popIn out:popOut>
              {#each alternatives as result (result.id)}
                <button type="button" role="menuitem" data-migration-alternative={result.id} onclick={() => pickFromMenu(group.id, result.id)}>
                  <span class="mg-menu-title" title={result.title}>{result.title}</span>
                  {#if result.hint}<small>{result.hint}</small>{/if}
                </button>
              {/each}
              {#if group.results.length > 1 + MENU_ALTERNATIVES}
                <button type="button" role="menuitem" class="mg-menu-more" onclick={() => showAllFromMenu(group.id)}>{$_("migrate.showAllResults", { count: group.results.length })}</button>
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        <span class="mg-menu-wrap" aria-hidden="true"></span>
      {/if}
    </section>
  {/each}
</div>

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
