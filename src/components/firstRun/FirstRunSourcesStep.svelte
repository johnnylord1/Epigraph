<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { _ } from "../../lib/i18n/runtime";
  import { operationError, restoreNote } from "../../lib/i18n/operationPresentation";
  import { ArrowLeft, ArrowRight, ArrowClockwise, Check, DownloadSimple, Info, Link, MagnifyingGlass, Plus, WarningCircle } from "phosphor-svelte";
  import { arrive, findByData, flash, pulse } from "../../lib/motion/firstRunMotion";
  import FirstRunTitle from "./FirstRunTitle.svelte";
  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import {
    visibleFirstRunExtensions,
    type FirstRunRepository,
    type FirstRunSourceKind,
    type FirstRunSourcesWorkflow,
  } from "../../lib/setup/firstRunSourcesWorkflow";
  import { store, updateSettings } from "../../store/state.svelte";

  interface Props {
    workflow: FirstRunSourcesWorkflow;
    requiredKinds?: FirstRunSourceKind[];
    backupExtensionIds?: Record<string, readonly string[]>;
    onBack?: () => void;
    onContinue?: () => void;
  }

  let {
    workflow,
    requiredKinds = ["manga"],
    backupExtensionIds = {},
    onBack = () => {},
    onContinue = () => {},
  }: Props = $props();

  let kind = $state<FirstRunSourceKind>(untrack(() => requiredKinds[0] ?? "manga"));
  let url = $state("");
  let extensionQuery = $state("");
  let visibleCounts = $state<Record<string, number>>({});
  let repositories = $state<FirstRunRepository[]>(untrack(() => [...workflow.repositories]));
  let workflowVersion = $state(0);
  let working = $state(false);
  let loading = $state(true);
  let error = $state<{ cause: unknown; fallback: string } | null>(null);
  let warnings = $state<readonly string[]>([]);
  let ready = $derived.by(() => {
    workflowVersion;
    return requiredKinds.length === 0
      ? workflow.isReady()
      : requiredKinds.every((required) => workflow.isReady(required));
  });

  onMount(() => {
    let mounted = true;
    const unsubscribe = workflow.subscribe(() => {
      warnings = workflow.warnings;
      repositories = workflow.repositories.map((repository) => ({ ...repository, extensions: repository.extensions.map((extension) => ({ ...extension })) }));
      workflowVersion += 1;
    });
    void workflow.hydrate().catch((cause) => {
      if (mounted) error = { cause, fallback: "firstRun.sources.loadError" };
    }).finally(() => {
      if (mounted) loading = false;
    });
    return () => { mounted = false; unsubscribe(); };
  });

  async function refreshRepository(repository: FirstRunRepository) {
    if (working || loading) return;
    working = true;
    error = null;
    try {
      await workflow.refreshRepository(repository.id);
    } catch (cause) {
      error = { cause, fallback: "firstRun.sources.refreshError" };
    } finally {
      working = false;
    }
  }

  async function retryLoad() {
    if (working || loading) return;
    loading = true;
    error = null;
    try {
      await workflow.hydrate();
    } catch (cause) {
      error = { cause, fallback: "firstRun.sources.loadError" };
    } finally {
      loading = false;
    }
  }

  let urlMissing = $state(false);
  let repoField = $state<HTMLElement>();
  let segmented = $state<HTMLElement>();
  let indicator = $state({ left: 0, width: 0 });

  $effect(() => {
    kind;
    void tick().then(() => {
      const current = segmented?.querySelector<HTMLElement>('button[aria-pressed="true"]');
      if (current) indicator = { left: current.offsetLeft + 12, width: current.offsetWidth - 24 };
    });
  });

  async function addRepository() {
    if (working || loading) return;
    if (!url.trim()) {
      urlMissing = true;
      repoField?.classList.remove("shake");
      void repoField?.offsetWidth;
      repoField?.classList.add("shake");
      repoField?.querySelector("input")?.focus();
      return;
    }
    urlMissing = false;
    working = true;
    error = null;
    try {
      await workflow.addRepository(kind, url);
      repositories = [...workflow.repositories];
      workflowVersion += 1;
      url = "";
    } catch (cause) {
      error = { cause, fallback: "firstRun.sources.addError" };
    } finally {
      working = false;
    }
  }

  async function install(repository: FirstRunRepository, extensionId: string) {
    if (working || loading) return;
    working = true;
    error = null;
    try {
      await workflow.installExtension(repository.id, extensionId);
      void tick().then(() => flash(findByData(document, "extension", `${repository.id}:${extensionId}`)));
    } catch (cause) {
      error = { cause, fallback: "firstRun.sources.installError" };
    } finally {
      repositories = [...workflow.repositories];
      workflowVersion += 1;
      working = false;
    }
  }

  async function installAll(repository: FirstRunRepository) {
    const selectedIds = backupExtensionIds[repository.id] ?? [];
    if (working || loading || selectedIds.length === 0) return;
    working = true;
    error = null;
    try {
      await workflow.installAll(repository.id, selectedIds);
    } catch (cause) {
      error = { cause, fallback: "firstRun.sources.installAllError" };
    } finally {
      repositories = [...workflow.repositories];
      workflowVersion += 1;
      working = false;
    }
  }

  $effect(() => {
    if (ready) void tick().then(() => pulse(document.querySelector(".fr-sources-continue")));
  });

  function continueSetup() {
    if (!ready || working || loading) return;
    onContinue();
  }

  const showNsfw = $derived(store.settings.showNsfw === true);
  const hasNsfwExtensions = $derived(repositories.some((repository) => repository.extensions.some((extension) => extension.nsfw)));

  function filteredExtensions(repository: FirstRunRepository) {
    const query = extensionQuery.trim().toLowerCase();
    return visibleFirstRunExtensions(repository.extensions, showNsfw)
      .filter((extension) => !query || `${extension.name} ${extension.lang} ${extension.id}`.toLowerCase().includes(query));
  }

  function toggleNsfw() {
    updateSettings({ showNsfw: !showNsfw });
    visibleCounts = {};
  }
</script>

<FirstRunTitle text={$_("firstRun.sources.title")} />
<p class="fr-lede" data-enter>{$_("firstRun.sources.lede")}</p>
{#if requiredKinds.length > 1}
  <div class="fr-notice" data-enter><Info size={18} /><span>{$_("firstRun.sources.mixedBackup")}</span></div>
{/if}

<div class="repo-entry" data-enter>
  <div class="fr-segmented" bind:this={segmented} role="group" aria-label={$_("firstRun.sources.type")}>
    <button type="button" aria-pressed={kind === "manga"} disabled={working || loading} onclick={() => (kind = "manga")}>{$_("firstRun.sources.comics")}</button>
    <button type="button" aria-pressed={kind === "novels"} disabled={working || loading} onclick={() => (kind = "novels")}>{$_("firstRun.sources.novels")}</button>
    <span class="fr-segmented-indicator" style:left={`${indicator.left}px`} style:width={`${indicator.width}px`}></span>
  </div>
  <label class="fr-field repo-field" class:is-invalid={urlMissing} bind:this={repoField}>
    <Link size={16} />
    <input bind:value={url} aria-label={$_("firstRun.sources.url")} placeholder={$_("firstRun.sources.urlPlaceholder")} disabled={working || loading} oninput={() => (urlMissing = false)} onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addRepository(); } }} />
    <button class="fr-link" type="button" disabled={working || loading} onclick={addRepository}>
      {#if working && url.trim()}<span class="fr-dots"><i></i><i></i><i></i></span>{:else}<Plus size={14} />{/if}{$_("firstRun.sources.add")}
    </button>
  </label>
</div>
<div class="fr-field-error" class:is-visible={urlMissing} role="alert">{urlMissing ? $_("firstRun.sources.urlRequired") : ""}</div>

{#if error}<div class="fr-error" role="alert"><WarningCircle size={18} /><span>{operationError(error.cause, error.fallback, $_)}</span><button class="fr-link" type="button" disabled={working || loading} onclick={retryLoad}>{$_("firstRun.sources.reload")}</button></div>{/if}
{#each warnings as warning}<div class="fr-notice" role="status"><Info size={18} /><span>{restoreNote(warning, $_)}</span><button class="fr-link" type="button" disabled={working || loading} onclick={retryLoad}>{$_("firstRun.sources.retry")}</button></div>{/each}

{#if repositories.length > 0 || hasNsfwExtensions}
  <div class="catalog-tools" data-enter>
    {#if repositories.length > 0}
      <label class="fr-field extension-search"><MagnifyingGlass size={16} /><input type="search" value={extensionQuery} aria-label={$_("firstRun.sources.search")} placeholder={$_("firstRun.sources.searchPlaceholder")} oninput={(event) => { extensionQuery = event.currentTarget.value; visibleCounts = {}; }} /></label>
    {/if}
    {#if hasNsfwExtensions}
      <button class="fr-switch nsfw-toggle" type="button" role="switch" aria-checked={showNsfw} aria-label={$_("firstRun.sources.showNsfw")} title={$_("firstRun.sources.showNsfwHint")} disabled={working} onclick={toggleNsfw}>
        <span>{$_("firstRun.sources.showNsfwShort")}</span><span class="fr-switch-track"><span class="fr-switch-knob"></span></span>
      </button>
    {/if}
  </div>
{/if}

<div class="repository-list" aria-live="polite">
  {#if loading}
    <div class="fr-skeleton"></div><div class="fr-skeleton" style:opacity=".75"></div><div class="fr-skeleton" style:opacity=".5"></div>
  {/if}
  {#each repositories as repository (`${repository.kind}:${repository.id}`)}
    {@const filtered = filteredExtensions(repository)}
    {@const visibleCount = visibleCounts[repository.id] ?? 12}
    <section class="repository" in:arrive>
      <header>
        <strong>{repository.name}</strong>
        {#if repository.builtin}<span class="builtin-chip">{$_("firstRun.sources.builtinChip")}</span>{/if}
        <small>{$_("firstRun.sources.extensionCount", { kind: repository.kind === "manga" ? $_("firstRun.sources.comics") : $_("firstRun.sources.novels"), count: visibleFirstRunExtensions(repository.extensions, showNsfw).length })}</small>
        <span class="fr-spacer"></span>
        {#if (backupExtensionIds[repository.id]?.length ?? 0) > 0 && repository.extensions.some((extension) => !extension.installed && backupExtensionIds[repository.id].includes(extension.id))}
          <button class="fr-link" type="button" disabled={working} onclick={() => installAll(repository)}><DownloadSimple size={15} /> {$_("firstRun.sources.installAll")}</button>
        {/if}
        <button class="fr-link fr-link--quiet" type="button" disabled={working || loading} aria-label={$_("firstRun.sources.refresh", { name: repository.name })} onclick={() => refreshRepository(repository)}><ArrowClockwise size={15} /></button>
      </header>
      <div class="extension-list">
        {#each filtered.slice(0, visibleCount) as extension (extension.id)}
          <div class="fr-row extension" data-extension={`${repository.id}:${extension.id}`}>
            <span class="fr-mark">
              <img src={resolveServiceIconUrl(extension.iconUrl, { kind: "extension" })} alt="" onerror={(event) => applyServiceIconFallback(event, "extension")} />
            </span>
            <span class="fr-row-copy"><strong>{extension.name}{#if extension.nsfw}<em class="nsfw-badge">{$_("firstRun.sources.nsfwBadge")}</em>{/if}</strong><small>{extension.lang} · v{extension.version}</small>{#if extension.error}<small class="extension-error">{operationError(extension.error, "firstRun.sources.installError", $_)}</small>{/if}</span>
            {#if extension.installed}
              <span class="install is-done" in:arrive><Check size={14} weight="bold" /> {$_("firstRun.sources.installed")}</span>
            {:else}
              <button class="install" class:is-busy={extension.status === "installing"} type="button" disabled={working || loading || extension.status === "installing"} aria-label={$_(extension.action === "enable" ? "firstRun.sources.enableNamed" : "firstRun.sources.installNamed", { name: extension.name })} onclick={() => install(repository, extension.id)}>
                <span class="install-label">{$_(extension.action === "enable" ? "firstRun.sources.enable" : "firstRun.sources.install")}</span>
                <span class="install-ring" aria-hidden="true"></span>
                {#if extension.status === "installing"}<span class="visually-hidden">{$_(extension.action === "enable" ? "firstRun.sources.enabling" : "firstRun.sources.installing")}</span>{/if}
              </button>
            {/if}
          </div>
        {:else}
          <div class="fr-empty">{$_(extensionQuery.trim() ? "firstRun.sources.noMatch" : "firstRun.sources.noCompatible")}</div>
        {/each}
        {#if filtered.length > visibleCount}
          <button class="fr-link show-more" type="button" onclick={() => { visibleCounts[repository.id] = visibleCount + 12; }}>{$_("firstRun.sources.showMore", { count: filtered.length - visibleCount })}</button>
        {/if}
      </div>
    </section>
  {:else}
    {#if !loading}<div class="fr-empty">{$_("firstRun.sources.empty")}</div>{/if}
  {/each}
</div>

<div class="fr-footer">
  <button class="fr-btn" type="button" disabled={working || loading} onclick={() => { if (!working && !loading) onBack(); }}><ArrowLeft class="fr-arrow-back" size={16} /> {$_("firstRun.sources.back")}</button>
  <span class="fr-spacer"></span>
  <button class="fr-btn fr-btn--primary fr-sources-continue" type="button" disabled={!ready || working || loading} onclick={continueSetup}>{$_("firstRun.sources.continue")} <ArrowRight class="fr-arrow-next" size={16} /></button>
</div>

<style>
  .repo-entry { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .repo-field { flex: 1 1 320px; }
  .catalog-tools { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 10px; }
  .extension-search { flex: 1 1 280px; }
  .nsfw-badge { margin-left: 6px; padding: 2px 6px; border-radius: 6px; color: var(--color-danger); background: color-mix(in srgb, var(--color-danger) 12%, transparent); font-size: 10px; font-style: normal; font-weight: 800; }
  .repository-list { display: grid; gap: 10px; margin-top: 12px; }
  .repository header { display: flex; align-items: center; gap: 10px; padding: 12px 8px 6px; }
  .repository header strong { color: var(--text-primary); font-size: 14px; font-weight: 750; }
  .repository header small { color: var(--text-muted); font-size: 12px; }
  .builtin-chip { padding: 3px 8px; border-radius: 7px; color: var(--accent-fg); background: var(--accent-muted); font-size: 11px; font-weight: 700; }
  .extension-list { display: grid; }
  .extension-error { color: var(--color-danger) !important; }
  .show-more { justify-self: center; margin-top: 6px; }
  /* The install control collapses into a progress ring and settles as an "installed" pill. */
  .install { position: relative; flex: none; width: 96px; height: 32px; padding: 0; border: 0; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; overflow: hidden; color: var(--accent-fg); background: transparent; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; transition: width .5s var(--fr-spring), background .35s, color .35s; }
  .install:hover:not(:disabled) { background: var(--accent-muted); }
  .install:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .install:disabled:not(.is-busy) { opacity: .45; cursor: not-allowed; }
  .install-label { transition: opacity .2s, transform .35s var(--fr-out); }
  .install-ring { position: absolute; width: 22px; height: 22px; border-radius: 50%; border: 2.5px solid var(--fr-line); border-top-color: var(--accent); opacity: 0; transition: opacity .25s; }
  .install.is-busy { width: 32px; cursor: progress; }
  .install.is-busy .install-label { opacity: 0; transform: scale(.6); }
  .install.is-busy .install-ring { opacity: 1; animation: sources-spin .8s linear infinite; }
  .install.is-done { width: auto; padding: 0 12px; color: var(--color-success); background: color-mix(in srgb, var(--color-success) 15%, transparent); cursor: default; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @keyframes sources-spin { to { transform: rotate(360deg); } }
  @media (max-width: 560px) {
    .fr-footer { flex-wrap: wrap; }
  }
</style>
