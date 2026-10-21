<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    ArrowLeft,
    ArrowRight,
    BookOpenText,
    Books,
    Check,
    ImageSquare,
    MagnifyingGlass,
    Plus,
    WarningCircle,
  } from "phosphor-svelte";
  import { arrive, prefersReducedMotion, pulse } from "../../lib/motion/firstRunMotion";
  import FirstRunTitle from "./FirstRunTitle.svelte";

  import { _ } from "../../lib/i18n/runtime";
  import { operationError } from "../../lib/i18n/operationPresentation";
  import { resolveMangaCoverUrl } from "../../lib/manga/coverResolver";
  import { store } from "../../store/state.svelte";
  import {
    createProductionFirstRunDiscoveryWorkflow,
    type FirstRunDiscoveryWorkflow,
    type FirstRunWorkCard,
  } from "../../lib/setup/firstRunDiscoveryWorkflow";

  interface Props {
    workflow?: FirstRunDiscoveryWorkflow;
    onLibraryChange?: (hasLibrary: boolean) => void;
    onBack?: () => void;
    onContinue?: () => void;
  }

  let {
    workflow = createProductionFirstRunDiscoveryWorkflow(),
    onLibraryChange = () => {},
    onBack = () => {},
    onContinue = () => {},
  }: Props = $props();

  let query = $state("");
  let submittedQuery = $state("");
  let items = $state<readonly FirstRunWorkCard[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<{ cause: unknown; fallback: string } | null>(null);
  let failedSources = $state<readonly string[]>([]);
  let mounted = false;
  let addedCount = $derived(items.filter((item) => item.inLibrary).length);
  let counter = $state<HTMLElement>();
  let counterBump = $state(false);

  /* A small light travels from the cover to the counter, then the counter bumps. */
  function celebrateAdd(from: HTMLElement | null) {
    const bump = () => {
      counterBump = true;
      setTimeout(() => { counterBump = false; }, 240);
      if (addedCount === 1) pulse(document.querySelector(".fr-discover-finish"));
    };
    if (!from || !counter || prefersReducedMotion() || typeof from.animate !== "function") return bump();
    const start = from.getBoundingClientRect();
    const end = counter.getBoundingClientRect();
    const x0 = start.left + start.width / 2;
    const y0 = start.top + start.height / 2;
    const x1 = end.left + 20;
    const y1 = end.top + end.height / 2;
    const flyer = document.createElement("span");
    flyer.className = "discover-flyer";
    (from.closest(".first-run-shell") ?? document.body).append(flyer);
    flyer.animate([
      { transform: `translate(${x0}px,${y0}px) scale(1)` },
      { transform: `translate(${(x0 + x1) / 2}px,${Math.min(y0, y1) - 90}px) scale(1.3)`, offset: 0.5 },
      { transform: `translate(${x1}px,${y1}px) scale(.4)`, opacity: 0.3 },
    ], { duration: 700, easing: "cubic-bezier(.45,0,.25,1)", fill: "forwards" });
    setTimeout(() => { flyer.remove(); bump(); }, 680);
  }

  function syncState() {
    if (!mounted) return;
    items = workflow.items.map((item) => ({ ...item }));
    loading = workflow.loading;
    saving = workflow.saving;
    error = workflow.error ? { cause: workflow.error, fallback: "firstRun.discover.loadError" } : null;
    failedSources = [...workflow.failedSources];
  }

  /* A failed source is named, so a single broken site is not mistaken for the whole step failing. */
  function noticeText(t: typeof $_): string {
    if (failedSources.length && error?.fallback !== "firstRun.discover.addError") {
      return t("firstRun.discover.sourcesFailed", { sources: failedSources.join(", ") });
    }
    return error ? operationError(error.cause, error.fallback, t) : "";
  }

  async function loadPopular() {
    try { await workflow.loadPopular(); }
    catch (cause) { if (mounted) error = { cause, fallback: "firstRun.discover.loadError" }; }
  }

  async function submitSearch() {
    if (loading || saving) return;
    submittedQuery = query.trim();
    try { await workflow.search(submittedQuery); }
    catch (cause) { if (mounted) error = { cause, fallback: "firstRun.discover.searchError" }; }
  }

  async function retry() {
    if (submittedQuery) await submitSearch();
    else await loadPopular();
  }

  async function add(item: FirstRunWorkCard, button: HTMLElement | null = null) {
    if (item.inLibrary || item.status === "adding") return;
    try {
      const confirmed = await workflow.addToLibrary(item.id);
      if (!mounted || !confirmed) return;
      onLibraryChange(true);
      celebrateAdd(button);
    } catch (cause) {
      if (mounted) error = { cause, fallback: "firstRun.discover.addError" };
    }
  }

  function hideBrokenCover(event: Event) {
    (event.currentTarget as HTMLImageElement).hidden = true;
  }

  onMount(() => {
    mounted = true;
    const unsubscribe = workflow.subscribe(syncState);
    syncState();
    void loadPopular();
    return () => {
      mounted = false;
      unsubscribe();
    };
  });

  onDestroy(() => { void workflow.dispose(); });
</script>

<div class="discover-head" data-enter>
  <div>
    <FirstRunTitle text={$_("firstRun.discover.title")} />
    <p class="fr-lede">{$_("firstRun.discover.lede")}</p>
  </div>
  <span class="counter" class:is-empty={addedCount === 0} class:is-bumped={counterBump} bind:this={counter} aria-live="polite">
    <Books size={16} /><span class="counter-number">{addedCount}</span>{addedCount === 1 ? $_("firstRun.discover.addedOne") : $_("firstRun.discover.added")}
  </span>
</div>

<form class="discover-toolbar" data-enter onsubmit={(event) => { event.preventDefault(); void submitSearch(); }}>
  <label class="fr-field">
    <MagnifyingGlass size={16} />
    <input type="search" bind:value={query} aria-label={$_("firstRun.discover.searchLabel")} placeholder={$_("firstRun.discover.searchPlaceholder")} />
    <button class="fr-link" type="submit" disabled={loading || saving}>{$_("firstRun.discover.search")}</button>
  </label>
</form>

{#if error || failedSources.length}
  <div class="fr-error" role="alert">
    <WarningCircle size={18} />
    <span>{noticeText($_)}</span>
    <button class="fr-link" type="button" disabled={loading || saving} onclick={retry}>{$_("firstRun.discover.retry")}</button>
  </div>
{/if}

{#if loading && items.length === 0}
  <div class="work-grid" aria-live="polite" aria-busy="true">
    {#each Array(6) as _, index (index)}<div class="cover-skeleton fr-skeleton"></div>{/each}
    <span class="visually-hidden">{$_("firstRun.discover.loading")}</span>
  </div>
{:else if items.length === 0 && !error}
  <div class="fr-empty">{submittedQuery ? $_("firstRun.discover.noResults") : $_("firstRun.discover.empty")}</div>
{:else}
  <div class="work-grid" aria-live="polite">
    {#each items as item (item.id)}
      <article class="work-card" class:is-added={item.inLibrary} in:arrive>
        <div class="cover" class:novel={item.kind === "novel"}>
          {#if item.kind === "novel"}<BookOpenText size={31} />{:else}<ImageSquare size={31} />{/if}
          {#if item.coverUrl}
            {#key `${item.coverUrl}:${store.runtimeServerUrl}:${store.libraryCoverCacheGeneration}`}
              <img src={item.kind === "manga" ? resolveMangaCoverUrl(item.coverUrl, { context: "discover", cacheGeneration: store.libraryCoverCacheGeneration }) : item.coverUrl} alt="" loading="lazy" decoding="async" onerror={hideBrokenCover} />
            {/key}
          {/if}
          <span class="cover-shine" aria-hidden="true"></span>
          <span class="cover-ring" aria-hidden="true"></span>
          <button
            class="add"
            class:is-on={item.inLibrary}
            class:is-busy={item.status === "adding"}
            type="button"
            disabled={loading || saving || item.inLibrary || item.status === "adding"}
            aria-label={item.inLibrary ? $_("firstRun.discover.inLibraryNamed", { name: item.title }) : $_("firstRun.discover.addNamed", { name: item.title })}
            onclick={(event) => add(item, event.currentTarget)}
          >
            <span class="add-plus"><Plus size={16} weight="bold" /></span>
            <span class="add-check"><Check size={16} weight="bold" /></span>
          </button>
        </div>
        <div class="work-copy">
          <strong title={item.title}>{item.title}</strong>
          <small>{item.status === "adding" ? $_("firstRun.discover.adding") : item.sourceName}</small>
        </div>
      </article>
    {/each}
  </div>
{/if}

<div class="fr-footer">
  <button class="fr-btn" type="button" disabled={loading || saving} onclick={onBack}><ArrowLeft class="fr-arrow-back" size={16} /> {$_("firstRun.discover.back")}</button>
  <span class="fr-spacer"></span>
  <button class="fr-btn fr-btn--primary fr-discover-finish" type="button" disabled={saving} onclick={onContinue}>{$_("firstRun.discover.finish")} <ArrowRight class="fr-arrow-next" size={16} /></button>
</div>

<style>
  .discover-head { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
  .discover-head > div { flex: 1; min-width: 0; }
  .discover-head .fr-lede { margin-bottom: 16px; }
  .counter { height: 30px; margin-bottom: 18px; padding: 0 12px; display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; color: var(--color-success); background: color-mix(in srgb, var(--color-success) 12%, transparent); font-size: 12.5px; font-weight: 700; transition: transform .5s var(--fr-bounce), opacity .4s; }
  .counter.is-empty { opacity: .45; }
  .counter.is-bumped { transform: scale(1.14); }
  .counter-number { min-width: .7em; text-align: center; font-variant-numeric: tabular-nums; }
  .discover-toolbar { margin-bottom: 18px; }
  .work-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; }
  .cover-skeleton { height: auto; aspect-ratio: 3 / 4; margin: 0; }
  .work-card { position: relative; min-width: 0; }
  .cover { position: relative; aspect-ratio: 3 / 4; display: grid; place-items: center; overflow: hidden; border-radius: 12px; color: var(--text-muted); background: color-mix(in srgb, var(--accent-muted) 42%, var(--bg-raised)); box-shadow: 0 16px 30px -18px var(--fr-shadow); transition: transform .6s var(--fr-spring); }
  .cover.novel { background: color-mix(in srgb, var(--color-info-bg) 46%, var(--bg-raised)); }
  .work-card:hover .cover { transform: translateY(-6px) rotate(-1.2deg); }
  .cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .cover-shine { position: absolute; inset: 0; background: linear-gradient(120deg, transparent 35%, color-mix(in srgb, var(--text-primary) 16%, transparent) 50%, transparent 65%); transform: translateX(-100%); pointer-events: none; }
  .work-card:hover .cover-shine { transform: translateX(100%); transition: transform 1s var(--fr-out); }
  .cover-ring { position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 2px var(--color-success); opacity: 0; transition: opacity .35s; pointer-events: none; }
  .work-card.is-added .cover-ring { opacity: 1; }
  .add { position: absolute; top: 8px; right: 8px; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%; display: grid; place-items: center; color: var(--text-primary); background: color-mix(in srgb, var(--bg-base) 70%, transparent); backdrop-filter: blur(8px); cursor: pointer; transition: transform .55s var(--fr-bounce), background .35s, color .35s; }
  .add:hover:not(:disabled) { transform: scale(1.12); }
  .add:active:not(:disabled) { transform: scale(.9); }
  .add:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .add:disabled { cursor: default; }
  .add > span { position: absolute; display: grid; place-items: center; transition: transform .55s var(--fr-bounce), opacity .25s; }
  .add-check { opacity: 0; transform: scale(.2) rotate(-90deg); }
  .add.is-on { color: var(--color-on-accent-strong); background: var(--color-success); }
  .add.is-on .add-plus { opacity: 0; transform: scale(.2) rotate(90deg); }
  .add.is-on .add-check { opacity: 1; transform: none; }
  .add.is-busy .add-plus { animation: discover-spin .8s linear infinite; }
  .work-copy { display: grid; gap: 3px; margin-top: 9px; }
  .work-copy strong, .work-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .work-copy strong { color: var(--text-primary); font-size: 12.5px; font-weight: 650; }
  .work-copy small { color: var(--text-muted); font-size: 11px; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @keyframes discover-spin { to { transform: rotate(360deg); } }
  :global(.first-run-shell .discover-flyer) { position: fixed; left: 0; top: 0; z-index: 30; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; background: var(--color-success); box-shadow: 0 0 14px var(--color-success); pointer-events: none; }
  @media (max-width: 460px) {
    .work-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .fr-footer { flex-wrap: wrap; }
  }
</style>
