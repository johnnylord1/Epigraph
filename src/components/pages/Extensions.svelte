<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { onMount, untrack } from "svelte";
  import { MagnifyingGlass, ArrowsClockwise, Plus, CircleNotch, CaretRight, CaretDown, X, Check, GitBranch } from "phosphor-svelte";
  import { gql, gqlUpload } from "../../lib/client";
  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import { GET_EXTENSIONS, FETCH_EXTENSIONS, UPDATE_EXTENSION, INSTALL_EXTERNAL_EXTENSION, GET_SETTINGS, SET_EXTENSION_REPOS } from "../../lib/queries";
  import { store, addToast, bumpContentSetupVersion, setExtensionsPanelHint } from "../../store/state.svelte";
  import type { Extension } from "../../lib/types";
  import SetupStatusCard from "../shared/SetupStatusCard.svelte";
  import NocturneState from "../shared/NocturneState.svelte";
  import { detectSetupState, type SetupState } from "../../lib/setupState";
  import { ensureExtensionRepo, RECOMMENDED_EXTENSION_REPO } from "../../lib/defaultRepos";
  import { SERVER_READY_EVENT } from "../../lib/serverLifecycle";
  import { waitForSuwayomiGraphqlReady } from "../../lib/suwayomiReadiness";

  type Filter = "installed" | "available" | "updates" | "all";
  type Panel  = null | "apk" | "repos";

  function baseName(name: string): string { return name.replace(/\s*\([A-Z0-9-]{2,10}\)\s*$/, "").trim(); }

  let extensions: Extension[] = $state([]);
  let loading = $state(true);
  let refreshing = $state(false);
  let filter: Filter          = $state("installed");
  let search = $state("");
  let working = $state(new Set<string>());
  let expanded = $state(new Set<string>());
  let panel: Panel            = $state(null);
  let externalFile: File | null = $state(null);
  let externalFileInput: HTMLInputElement | null = $state(null);
  let installing = $state(false);
  let installError: string|null = $state(null);
  let installSuccess = $state(false);
  let repos: string[]         = $state([]);
  let reposLoading = $state(false);
  let newRepoUrl = $state("");
  let repoError: string|null  = $state(null);
  let savingRepos = $state(false);
  let setupState: SetupState | null = $state(null);
  let setupActionBusy = $state(false);
  let renderVisible = $state(0);
  let loadError: string | null = $state(null);
  let lastExtensions: Extension[] = $state([]);
  const renderLimit = 48;

  function browseAvailableExtensions() {
    filter = "available";
    panel = null;
  }

  async function refreshSetupState() {
    setupState = await detectSetupState(store.settings);
  }

  async function load() {
    try {
      const ready = await waitForSuwayomiGraphqlReady("extensions", { attempts: 6, delayMs: 800, timeoutMs: 5000 });
      if (!ready) throw new Error("Suwayomi is still starting. Try refreshing extensions again in a moment.");
      const d = await gql<{ extensions: { nodes: Extension[] } }>(GET_EXTENSIONS);
      extensions = d.extensions.nodes;
      lastExtensions = d.extensions.nodes;
      loadError = null;
    } catch (error) {
      console.error(error);
      loadError = error instanceof Error ? error.message : String(error);
      if (lastExtensions.length > 0) extensions = lastExtensions;
    } finally {
      await refreshSetupState();
    }
  }

  async function fetchFromRepo() {
    refreshing = true;
    try {
      const ready = await waitForSuwayomiGraphqlReady("extensions", { attempts: 6, delayMs: 800, timeoutMs: 5000 });
      if (!ready) throw new Error("Suwayomi is still starting. Try refreshing extensions again in a moment.");
      const d = await gql<{ fetchExtensions: { extensions: Extension[] } }>(FETCH_EXTENSIONS);
      extensions = d.fetchExtensions.extensions;
      lastExtensions = d.fetchExtensions.extensions;
      loadError = null;
    } catch (error) {
      console.error(error);
      loadError = error instanceof Error ? error.message : String(error);
      if (lastExtensions.length > 0) extensions = lastExtensions;
    } finally {
      refreshing = false;
      await refreshSetupState();
    }
  }

  async function loadRepos() {
    reposLoading = true;
    try { const d = await gql<{ settings: { extensionRepos: string[] } }>(GET_SETTINGS); repos = d.settings.extensionRepos ?? []; }
    catch (e) { console.error(e); } finally { reposLoading = false; refreshSetupState(); }
  }

  async function saveRepos(updated: string[]) {
    savingRepos = true;
    try {
      const d = await gql<{ setSettings: { settings: { extensionRepos: string[] } } }>(SET_EXTENSION_REPOS, { repos: updated });
      repos = d.setSettings.settings.extensionRepos;
      bumpContentSetupVersion();
    }
    catch (e: any) { repoError = e instanceof Error ? e.message : "Failed to save"; } finally { savingRepos = false; refreshSetupState(); }
  }

  async function addRecommendedRepo() {
    setupActionBusy = true;
    try {
      const result = await ensureExtensionRepo(RECOMMENDED_EXTENSION_REPO);
      addToast({
        kind: result.status === "added" ? "success" : "info",
        title: result.status === translate("ui_added") ? translate("ui_recommendedRepoAdded") : translate("ui_recommendedRepoAlreadyAdded"),
        body: result.status === translate("ui_added")
          ? `${result.repo.name} is ready. Browse Available and install your first extension.`
          : `${result.repo.name} is already configured. Browse Available and install your first extension.`,
      });
      filter = "available";
      panel = null;
      await loadRepos();
      await fetchFromRepo();
      await refreshSetupState();
    } catch (error) {
      addToast({
        kind: "error",
        title: translate("ui_couldNotAddTheRecommendedRepo"),
        body: error instanceof Error ? error.message : translate("ui_aethonCouldnTSaveTheRecommendedRepo"),
      });
    } finally {
      setupActionBusy = false;
    }
  }

  function addRepo() {
    const url = newRepoUrl.trim();
    if (!url) return;
    if (!url.startsWith("http://") && !url.startsWith("https://")) { repoError = "URL must start with http:// or https://"; return; }
    if (repos.includes(url)) { repoError = "Repo already added"; return; }
    repoError = null; newRepoUrl = "";
    saveRepos([...repos, url]);
  }

  function removeRepo(url: string) { saveRepos(repos.filter((r) => r !== url)); }

  async function mutate(fn: () => Promise<unknown>, pkgName: string, actionLabel = "Extension action") {
    working = new Set(working).add(pkgName);
    let ok = true;
    try {
      await fn();
      bumpContentSetupVersion();
    } catch (error) {
      ok = false;
      console.error(error);
      addToast({
        kind: "error",
        title: `${actionLabel} failed`,
        body: error instanceof Error ? error.message : String(error),
      });
    }
    await load();
    working.delete(pkgName); working = new Set(working);
    return ok;
  }

  async function installExtension(extension: Extension) {
    const firstInstallFlow = setupState?.kind === "no_installed_extensions";
    const didInstall = await mutate(() => gql(UPDATE_EXTENSION, { id: extension.pkgName, install: true }), extension.pkgName, `Install ${extension.name}`);
    if (!didInstall || !firstInstallFlow) return;

    filter = "installed";
    addToast({
      kind: "success",
      title: translate("ui_firstExtensionInstalled"),
      body: setupState?.kind === translate("ui_ready_75c05337")
        ? `${extension.name} is installed. You can head to Search or browse sources now.`
        : `${extension.name} is installed. If search is still empty, try another content extension or review available sources.`,
    });
  }

  async function installExternal() {
    const file = externalFile;
    if (!file) { installError = "Choose an .apk extension file first."; return; }
    if (!file.name.toLowerCase().endsWith(".apk")) { installError = "File must be an .apk extension package."; return; }
    installing = true; installError = null; installSuccess = false;
    try {
      await gqlUpload(
        INSTALL_EXTERNAL_EXTENSION,
        { extensionFile: null },
        { "variables.extensionFile": file },
      );
      installSuccess = true; clearExternalFile();
      bumpContentSetupVersion();
      await load();
      setTimeout(() => { panel = null; installSuccess = false; }, 1500);
    } catch (e: any) { installError = e instanceof Error ? e.message : "Install failed"; }
    finally { installing = false; }
  }

  function openPanel(p: Panel) {
    panel = panel === p ? null : p;
    installError = null; installSuccess = false; clearExternalFile();
    repoError = null; newRepoUrl = "";
    if (p === "repos") loadRepos();
  }

  async function updateExtension(extension: Extension) {
    return mutate(
      async () => {
        await gql(FETCH_EXTENSIONS, undefined, undefined, 60000);
        await gql(UPDATE_EXTENSION, { id: extension.pkgName, update: true }, undefined, 60000);
      },
      extension.pkgName,
      `Update ${extension.name}`,
    );
  }

  function selectExternalFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    externalFile = input.files?.[0] ?? null;
    installError = null;
    installSuccess = false;
  }

  function clearExternalFile() {
    externalFile = null;
    if (externalFileInput) externalFileInput.value = "";
  }

  $effect(() => {
    if (store.extensionsPanelHint !== "repos") return;
    untrack(() => openPanel("repos"));
    setExtensionsPanelHint(null);
  });

  $effect(() => { untrack(() => Promise.all([load(), refreshSetupState()]).finally(() => { loading = false; })); });

  onMount(() => {
    const handleServerReady = () => {
      void Promise.all([
        loadRepos(),
        load(),
        refreshSetupState(),
      ]).finally(() => {
        loading = false;
      });
    };
    window.addEventListener(SERVER_READY_EVENT, handleServerReady);
    return () => window.removeEventListener(SERVER_READY_EVENT, handleServerReady);
  });

  const filtered = $derived(extensions.filter((e) => {
    const q = search.toLowerCase();
    const matchSearch = e.name.toLowerCase().includes(q) || e.lang.toLowerCase().includes(q);
    const matchFilter = filter === "installed" ? e.isInstalled : filter === "available" ? !e.isInstalled : filter === "updates" ? e.hasUpdate : true;
    return matchSearch && matchFilter;
  }));

  const groups = $derived.by(() => {
    const map = new Map<string, Extension[]>();
    for (const ext of filtered) { const key = baseName(ext.name); if (!map.has(key)) map.set(key, []); map.get(key)!.push(ext); }
    const preferredLang = store.settings.preferredExtensionLang;
    return Array.from(map.entries()).map(([base, all]) => {
      const primary = all.find((v) => v.lang === preferredLang) ?? all.find((v) => v.lang === "en") ?? all[0];
      return { base, primary, variants: all.filter((v) => v.pkgName !== primary.pkgName) };
    });
  });
  const visibleGroups = $derived(groups.slice(0, renderVisible));
  const hasMore = $derived(groups.length > renderVisible);
  const remainingCount = $derived(Math.max(0, groups.length - renderVisible));
  const updateCount = $derived(extensions.filter((e) => e.hasUpdate).length);

  const FILTERS: { id: Filter; label: string }[] = $derived.by(() => [
    { id: "installed", label: $_("sources_status_installed") },
    { id: "available", label: $_("sources_status_available") },
    { id: "updates",   label: $_("sources_filters_updates") },
    { id: "all",       label: $_("downloads_filter_all") },
  ]);

  function toggleExpand(base: string) {
    const next = new Set(expanded);
    next.has(base) ? next.delete(base) : next.add(base);
    expanded = next;
  }

  function loadMore() {
    renderVisible = Math.min(groups.length, renderVisible + renderLimit);
  }

  $effect(() => {
    filter;
    search;
    loading;

    if (loading) {
      renderVisible = 0;
      return;
    }

    renderVisible = Math.min(renderLimit, groups.length);
  });

  $effect(() => {
    groups.length;
    if (renderVisible > groups.length) {
      renderVisible = groups.length;
    }
  });
</script>

<div class="root">
  <div class="header">
    <h1 class="heading">{$_("ui_extensions")}</h1>
    <div class="tabs">
      {#each FILTERS as f}
        <button class="tab" class:active={filter === f.id} onclick={() => filter = f.id}>
          {f.id === "updates" && updateCount > 0 ? `Updates (${updateCount})` : f.label}
        </button>
      {/each}
    </div>
    <div class="header-right">
      <div class="search-wrap">
        <MagnifyingGlass size={12} class="search-icon" weight="light" />
        <input class="search" placeholder={$_("novelSources_actions_search")} bind:value={search} />
      </div>
      <button class="icon-btn" class:active={panel === "repos"} onclick={() => openPanel("repos")} title={$_("sources_repositories_manageManga")}>
        <GitBranch size={14} weight="light" />
      </button>
      <button class="icon-btn" class:active={panel === "apk"} onclick={() => openPanel("apk")} title={$_("ui_installFromApkUrl")}>
        <Plus size={14} weight="light" />
      </button>
      <button class="icon-btn" onclick={fetchFromRepo} disabled={refreshing} title={$_("ui_refreshRepo")}>
        <ArrowsClockwise size={14} weight="light" class={refreshing ? "anim-spin" : ""} />
      </button>
    </div>
  </div>

  {#if setupState && setupState.kind !== "ready"}
    <div class="setup-banner">
      <SetupStatusCard
        state={setupState}
        surface="extensions"
        actionBusy={setupActionBusy || savingRepos || refreshing}
        onAddRecommendedRepo={addRecommendedRepo}
        onAddManually={() => openPanel("repos")}
        onBrowseAvailableExtensions={browseAvailableExtensions}
        onOpenRepoManager={() => openPanel("repos")}
        onRetry={refreshSetupState}
      />
    </div>
  {/if}

  {#if panel === "apk"}
    <div class="ext-panel">
      <div class="panel-header">
        <span class="panel-title">{$_("ui_installFromApkUrl")}</span>
        <button class="icon-btn" onclick={() => openPanel("apk")}><X size={14} weight="light" /></button>
      </div>
      <div class="ext-row">
        <input class="ext-input" class:error={installError} type="file" accept=".apk,application/vnd.android.package-archive"
          bind:this={externalFileInput}
          disabled={installing}
          onchange={selectExternalFile}
          use:focusOnMount />
        <button class="install-btn" class:success={installSuccess} onclick={installExternal} disabled={installing}>
          {#if installing}<CircleNotch size={13} weight="light" class="anim-spin" />
          {:else if installSuccess}<Check size={13} weight="bold" /> {$_("sources_actions_done")}{:else}{$_("sources_actions_install")}{/if}
        </button>
      </div>
      {#if installError}
        <NocturneState
          layout="compact"
          tone="danger"
          icon="info"
          eyebrow="Install"
          title={$_("ui_couldNotInstallExtension")}
          body={installError}
        />
      {/if}
    </div>
  {/if}

  {#if panel === "repos"}
    <div class="ext-panel">
      <div class="panel-header">
        <span class="panel-title">{$_("ui_extensionRepositories")}</span>
        <button class="icon-btn" onclick={() => panel = null}><X size={14} weight="light" /></button>
      </div>
      {#if reposLoading}
        <NocturneState layout="compact" tone="info" icon="retry" eyebrow="Repositories" title={$_("ui_loadingRepositories")} />
      {:else}
        {#if repos.length === 0}
          <NocturneState layout="compact" tone="info" icon="folder" eyebrow="Repositories" title={$_("sources_repositories_emptyTitle")} body="Add a repository URL before extensions can appear here." />
        {:else}
          <div class="repo-list">
            {#each repos as url}
              <div class="repo-row">
                <span class="repo-url">{url}</span>
                <button class="repo-remove" onclick={() => removeRepo(url)} disabled={savingRepos} title={$_("ui_removeRepo")}>
                  {#if savingRepos}<CircleNotch size={12} weight="light" class="anim-spin" />{:else}<X size={12} weight="bold" />{/if}
                </button>
              </div>
            {/each}
          </div>
        {/if}
        <div class="ext-row" style="margin-top:var(--sp-2)">
          <input class="ext-input" class:error={repoError} placeholder={$_("ui_httpsExampleComIndexMinJson")}
            bind:value={newRepoUrl} disabled={savingRepos}
            oninput={() => repoError = null}
            onkeydown={(e) => e.key === "Enter" && !savingRepos && addRepo()} />
          <button class="install-btn" onclick={addRepo} disabled={savingRepos || !newRepoUrl.trim()}>
            {#if savingRepos}<CircleNotch size={13} weight="light" class="anim-spin" />{:else}{$_("detail_folders_add")}{/if}
          </button>
        </div>
        {#if repoError}
          <NocturneState
            layout="compact"
            tone="danger"
            icon="info"
            eyebrow="Repository"
            title={$_("ui_couldNotSaveRepository")}
            body={repoError}
          />
        {/if}
      {/if}
    </div>
  {/if}



  {#if loading}
    <div class="empty">
      <NocturneState layout="center" tone="info" icon="retry" eyebrow="Extensions" title={$_("ui_loadingExtensions")} />
    </div>
  {:else if loadError && groups.length === 0}
    <div class="empty">
      <NocturneState
        layout="center"
        tone="warning"
        icon="retry"
        eyebrow="Suwayomi"
        title="Suwayomi is still reconnecting"
        body={loadError}
        actions={[{
          label: $_("sources_actions_refresh"),
          kind: "primary",
          icon: "retry",
          onClick: () => {
            loading = true;
            void load().finally(() => { loading = false; });
          },
        }]}
      />
    </div>
  {:else if groups.length === 0}
    <div class="empty">
      <NocturneState
        layout="center"
        tone={setupState?.kind === "server_offline" ? "danger" : "info"}
        icon={setupState?.kind === "server_offline" ? "plug" : "search"}
        eyebrow="Extensions"
        title={setupState?.kind === "server_offline"
          ? "Suwayomi is offline"
          : setupState?.kind === "no_extension_repos"
            ? "No extension repository"
            : setupState?.kind === "no_installed_extensions" && filter === "installed"
              ? "No extensions installed"
              : setupState?.kind === "no_usable_sources"
                ? "No usable sources"
                : "No extensions found"}
        body={setupState?.kind === "server_offline"
          ? "Start or reconnect Suwayomi to load extensions."
          : setupState?.kind === "no_extension_repos"
            ? "Add an extension repository to start listing available extensions."
            : setupState?.kind === "no_installed_extensions" && filter === "installed"
              ? "Switch to Available and install one to unlock sources and search."
              : setupState?.kind === "no_usable_sources"
                ? "Extensions are present, but Aethon still has no source available for this view."
                : "Try another filter or refresh the extension list."}
      />
    </div>
  {:else}
    <div class="list">
      {#each visibleGroups as { base, primary, variants }}
        {@const isExpanded = expanded.has(base)}
        {@const hasVariants = variants.length > 0}
        <div class="group">
          <div class="row">
            <img src={resolveServiceIconUrl(primary.iconUrl, { kind: "extension" })} alt={primary.name} class="icon" loading="lazy" decoding="async" fetchpriority="low" onerror={(e) => applyServiceIconFallback(e, "extension")} />
            <div class="info">
              <span class="name">{base}</span>
              <span class="meta"><span class="lang-tag">{primary.lang.toUpperCase()}</span> v{primary.versionName}</span>
            </div>
            {#if working.has(primary.pkgName)}
              <CircleNotch size={14} weight="light" class="anim-spin" style="color:var(--text-faint)" />
            {:else if primary.hasUpdate}
              <div class="row-actions">
                <button class="action-btn" onclick={() => updateExtension(primary)}>{$_("sources_actions_update")}</button>
                <button class="action-btn-dim" onclick={() => mutate(() => gql(UPDATE_EXTENSION, { id: primary.pkgName, uninstall: true }), primary.pkgName, `Remove ${primary.name}`)}>{$_("sources_actions_remove")}</button>
              </div>
            {:else if primary.isInstalled}
              <button class="action-btn-dim" onclick={() => mutate(() => gql(UPDATE_EXTENSION, { id: primary.pkgName, uninstall: true }), primary.pkgName, `Remove ${primary.name}`)}>{$_("sources_actions_remove")}</button>
            {:else}
              <button class="action-btn" onclick={() => installExtension(primary)}>{$_("sources_actions_install")}</button>
            {/if}
            {#if hasVariants}
              <button class="expand-btn" onclick={() => toggleExpand(base)} title="{variants.length + 1} languages">
                {#if isExpanded}<CaretDown size={12} weight="light" />{:else}<CaretRight size={12} weight="light" />{/if}
                <span class="expand-count">{variants.length + 1}</span>
              </button>
            {/if}
          </div>
          {#if isExpanded && hasVariants}
            <div class="variants">
              {#each variants as v}
                <div class="variant-row">
                  <span class="lang-tag">{v.lang.toUpperCase()}</span>
                  <span class="variant-name">{v.name}</span>
                  <span class="variant-version">v{v.versionName}</span>
                  {#if v.hasUpdate}<span class="update-badge-small">↑</span>{/if}
                  <div class="variant-actions">
                    {#if working.has(v.pkgName)}
                      <CircleNotch size={14} weight="light" class="anim-spin" style="color:var(--text-faint)" />
                    {:else if v.hasUpdate}
                      <button class="action-btn" onclick={() => updateExtension(v)}>{$_("sources_actions_update")}</button>
                    {:else if v.isInstalled}
                      <button class="action-btn-dim" onclick={() => mutate(() => gql(UPDATE_EXTENSION, { id: v.pkgName, uninstall: true }), v.pkgName, `Remove ${v.name}`)}>{$_("sources_actions_remove")}</button>
                    {:else}
                      <button class="action-btn" onclick={() => installExtension(v)}>{$_("sources_actions_install")}</button>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
      {#if hasMore}
        <div class="load-more-row">
          <button type="button" class="load-more-btn" onclick={loadMore}>
            {$_("downloads_filter_show")} {Math.min(remainingCount, renderLimit)} {$_("ui_more")}
            <span class="load-more-count">({remainingCount} {$_("ui_remaining")}</span>
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>


<style>
  .root { display: flex; flex-direction: column; height: 100%; overflow: hidden; animation: fadeIn 0.14s ease both; }
  .header { display: flex; align-items: center; gap: var(--sp-4); padding: var(--sp-4) var(--sp-6); border-bottom: 1px solid var(--border-dim); flex-shrink: 0; }
  .setup-banner {
    position: fixed;
    top: 68px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    width: min(1000px, calc(100% - 48px));
    padding: 0;
    pointer-events: none;
    flex-shrink: 0;
  }
  .setup-banner :global(.n-state) {
    width: 100%;
    margin: 0;
    pointer-events: auto;
  }
  .header-right { display: flex; align-items: center; gap: var(--sp-2); margin-left: auto; }
  .heading { font-family: var(--font-ui); font-size: var(--text-xs); font-weight: var(--weight-normal); color: var(--text-faint); letter-spacing: var(--tracking-wider); text-transform: uppercase; }
  .header-actions { display: flex; gap: var(--sp-1); }
  .icon-btn { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--radius-md); color: var(--text-muted); transition: color var(--t-base), background var(--t-base); }
  .icon-btn:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-raised); }
  .icon-btn:disabled { opacity: 0.4; }
  .icon-btn.active { color: var(--accent-fg); background: var(--accent-muted); }
  .ext-panel { display: flex; flex-direction: column; gap: var(--sp-2); padding: 0 var(--sp-6) var(--sp-3); flex-shrink: 0; animation: fadeIn 0.1s ease both; }
  .panel-header { display: flex; align-items: center; justify-content: space-between; }
  .panel-title { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-muted); letter-spacing: var(--tracking-wide); }
  .ext-row { display: flex; gap: var(--sp-2); }
  .ext-input { flex: 1; background: var(--bg-raised); border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: 6px var(--sp-3); color: var(--text-primary); font-size: var(--text-sm); outline: none; transition: border-color var(--t-base); }
  .ext-input:focus { border-color: var(--border-focus); }
  .ext-input:disabled { opacity: 0.5; }
  .ext-input.error { border-color: var(--color-error) !important; }
  .install-btn { display: flex; align-items: center; gap: var(--sp-1); font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 6px 14px; border-radius: var(--radius-md); background: var(--accent-muted); color: var(--accent-fg); border: 1px solid var(--accent-dim); cursor: pointer; flex-shrink: 0; transition: filter var(--t-base), opacity var(--t-base); white-space: nowrap; }
  .install-btn:hover:not(:disabled) { filter: brightness(1.1); }
  .install-btn:disabled { opacity: 0.5; cursor: default; }
  .install-btn.success { background: rgba(107,143,107,0.2); border-color: var(--accent-fg); color: var(--accent-fg); }
  .repo-loading { display: flex; align-items: center; justify-content: center; padding: var(--sp-3); }
  .repo-list { display: flex; flex-direction: column; gap: 2px; }
  .repo-row { display: flex; align-items: center; gap: var(--sp-2); padding: 5px var(--sp-2); border-radius: var(--radius-md); background: var(--bg-raised); border: 1px solid var(--border-dim); }
  .repo-url { flex: 1; font-size: var(--text-2xs); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .repo-remove { display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: var(--radius-sm); color: var(--text-faint); flex-shrink: 0; transition: color var(--t-base), background var(--t-base); }
  .repo-remove:hover:not(:disabled) { color: var(--color-error); background: var(--bg-overlay); }

  .tabs { display: flex; gap: 2px; background: var(--bg-raised); border: 1px solid var(--border-dim); border-radius: var(--radius-md); padding: 2px; }
  .tab { display: flex; align-items: center; gap: 5px; font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide); text-transform: uppercase; padding: 4px 10px; border-radius: var(--radius-sm); color: var(--text-faint); white-space: nowrap; transition: background var(--t-base), color var(--t-base); }
  .tab:hover { color: var(--text-muted); }
  .tab.active { background: var(--accent-muted); color: var(--accent-fg); border: 1px solid var(--accent-dim); }
  .search-wrap { position: relative; display: flex; align-items: center; }
  .search-wrap :global(.search-icon) { position: absolute; left: 9px; color: var(--text-faint); pointer-events: none; }
  .search { background: var(--bg-raised); border: 1px solid var(--border-dim); border-radius: var(--radius-md); padding: 5px 10px 5px 26px; color: var(--text-primary); font-size: var(--text-sm); width: 160px; outline: none; transition: border-color var(--t-base); }
  .search::placeholder { color: var(--text-faint); }
  .search:focus { border-color: var(--border-strong); }
  .list { flex: 1; overflow-y: auto; padding: 0 var(--sp-4) var(--sp-4); display: flex; flex-direction: column; gap: 1px; }
  .group { display: flex; flex-direction: column; }
  .row { display: flex; align-items: center; gap: var(--sp-3); padding: 8px var(--sp-3); border-radius: var(--radius-md); border: 1px solid transparent; transition: background var(--t-fast), border-color var(--t-fast); }
  .row:hover { background: var(--bg-raised); border-color: var(--border-dim); }
  .icon { width: 32px; height: 32px; border-radius: var(--radius-md); object-fit: cover; flex-shrink: 0; background: var(--bg-raised); }
  .icon { contain: paint; }
  .info { flex: 1; display: flex; flex-direction: column; gap: 2px; overflow: hidden; min-width: 0; }
  .name { font-size: var(--text-base); font-weight: var(--weight-medium); color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { display: flex; align-items: center; gap: var(--sp-2); font-family: var(--font-ui); font-size: var(--text-2xs); color: var(--text-faint); letter-spacing: var(--tracking-wide); }
  .lang-tag { background: var(--bg-overlay); border: 1px solid var(--border-dim); border-radius: var(--radius-sm); padding: 1px 5px; font-family: var(--font-ui); font-size: var(--text-2xs); color: var(--text-muted); letter-spacing: var(--tracking-wider); }
  .update-badge-small { font-family: var(--font-ui); font-size: var(--text-2xs); color: var(--accent-fg); flex-shrink: 0; }
  .row-actions { display: flex; gap: var(--sp-1); flex-shrink: 0; }
  .action-btn { font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 4px 10px; border-radius: var(--radius-md); background: var(--accent-muted); color: var(--accent-fg); border: 1px solid var(--accent-dim); cursor: pointer; flex-shrink: 0; transition: filter var(--t-base); }
  .action-btn:hover { filter: brightness(1.1); }
  .action-btn-dim { font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 4px 10px; border-radius: var(--radius-md); background: none; color: var(--text-faint); border: 1px solid var(--border-dim); cursor: pointer; flex-shrink: 0; transition: color var(--t-base), border-color var(--t-base); }
  .action-btn-dim:hover { color: var(--color-error); border-color: var(--color-error); }
  .expand-btn { display: flex; align-items: center; gap: 3px; padding: 4px 6px; border-radius: var(--radius-sm); color: var(--text-faint); flex-shrink: 0; transition: color var(--t-base), background var(--t-base); }
  .expand-btn:hover { color: var(--text-muted); background: var(--bg-overlay); }
  .expand-count { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide); }
  .variants { display: flex; flex-direction: column; gap: 1px; margin: 1px 0 2px calc(32px + var(--sp-3) + var(--sp-3)); padding-left: var(--sp-3); border-left: 1px solid var(--border-dim); animation: fadeIn 0.1s ease both; }
  .variant-row { display: flex; align-items: center; gap: var(--sp-2); padding: 5px var(--sp-2); border-radius: var(--radius-md); transition: background var(--t-fast); }
  .variant-row:hover { background: var(--bg-raised); }
  .variant-name { flex: 1; font-size: var(--text-sm); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .variant-version { font-family: var(--font-ui); font-size: var(--text-2xs); color: var(--text-faint); letter-spacing: var(--tracking-wide); flex-shrink: 0; }
  .variant-actions { flex-shrink: 0; }
  .empty { display: flex; align-items: center; justify-content: center; flex: 1; min-height: 220px; color: var(--text-faint); }
  .load-more-row {
    display: flex;
    justify-content: center;
    padding: var(--sp-4) 0 var(--sp-2);
  }
  .load-more-btn {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    padding: 6px 16px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
    color: var(--text-muted);
    cursor: pointer;
    transition: color var(--t-base), border-color var(--t-base), background var(--t-base);
  }
  .load-more-btn:hover {
    color: var(--accent-fg);
    border-color: var(--accent-dim);
    background: var(--accent-muted);
  }
  .load-more-count {
    color: var(--text-faint);
    font-size: var(--text-2xs);
  }

  .root {
    border-radius: calc(24px * var(--n-hud-scale));
    border: 1px solid rgba(255, 255, 255, 0.055);
    background:
      radial-gradient(circle at 16% 0%, rgba(184, 167, 234, 0.055), transparent 34%),
      rgba(18, 18, 22, 0.7);
  }
  .header {
    min-height: calc(58px * var(--n-hud-scale));
    padding: calc(12px * var(--n-hud-scale)) calc(16px * var(--n-hud-scale));
    border-bottom-color: rgba(255, 255, 255, 0.045);
  }
  .heading {
    font-size: calc(10px * var(--n-hud-scale));
    color: rgba(229, 226, 225, 0.46);
  }
  .tabs {
    border-color: rgba(255, 255, 255, 0.055);
    background: rgba(255, 255, 255, 0.025);
  }
  .tab.active {
    background: rgba(184, 167, 234, 0.18);
    border-color: rgba(184, 167, 234, 0.2);
    color: var(--accent-fg);
  }
  .search {
    height: calc(30px * var(--n-hud-scale));
    border-color: rgba(255, 255, 255, 0.055);
    background: rgba(27, 25, 34, 0.7);
  }
  .icon-btn {
    border: 1px solid rgba(255, 255, 255, 0.045);
    background: rgba(255, 255, 255, 0.018);
  }
  .icon-btn:hover:not(:disabled),
  .icon-btn.active {
    background: rgba(184, 167, 234, 0.12);
    border-color: rgba(184, 167, 234, 0.16);
  }
  .list {
    gap: calc(6px * var(--n-hud-scale));
    padding: calc(14px * var(--n-hud-scale)) calc(16px * var(--n-hud-scale)) calc(18px * var(--n-hud-scale));
  }
  .group {
    border: 1px solid rgba(255, 255, 255, 0.045);
    border-radius: calc(16px * var(--n-hud-scale));
    background: rgba(255, 255, 255, 0.018);
    overflow: hidden;
  }
  .row {
    min-height: calc(52px * var(--n-hud-scale));
    padding: calc(8px * var(--n-hud-scale)) calc(12px * var(--n-hud-scale));
  }
  .row:hover {
    background: rgba(184, 167, 234, 0.055);
    border-color: transparent;
  }
  .icon {
    width: calc(28px * var(--n-hud-scale));
    height: calc(28px * var(--n-hud-scale));
    border-radius: calc(8px * var(--n-hud-scale));
  }
  .name {
    font-size: calc(12px * var(--n-hud-scale));
  }
  .action-btn,
  .action-btn-dim,
  .install-btn {
    min-height: calc(28px * var(--n-hud-scale));
    border-radius: calc(10px * var(--n-hud-scale));
  }
  .ext-panel {
    margin: calc(10px * var(--n-hud-scale)) calc(16px * var(--n-hud-scale)) 0;
    padding: calc(12px * var(--n-hud-scale));
    border: 1px solid rgba(255, 255, 255, 0.055);
    border-radius: calc(16px * var(--n-hud-scale));
    background: rgba(255, 255, 255, 0.018);
  }
</style>

<script context="module" lang="ts">
  function focusOnMount(node: HTMLElement) { node.focus(); }
</script>
