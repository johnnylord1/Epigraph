<script lang="ts">
  import { addToast } from "../../store/state.svelte";
  import {
    addNovelRepositoryToState,
    createEmptyNovelRepositoryState,
    deriveNovelRepositoryUiState,
    getVisibleNovelCatalogEntries,
    loadNovelRepositoryState,
    refreshAllNovelRepositories,
    refreshNovelRepositoryCatalog,
    removeNovelRepositoryFromState,
    saveNovelRepositoryState,
    setNovelRepositoryEnabled,
    setNovelRepositoryLanguageFilter,
    setNovelRepositoryTrustState,
    type PersistedNovelRepositoryState,
  } from "../../lib/novels/repositoryState";
  import {
    getInstalledNovelSources,
    getNovelCatalogEntryInstallState,
    installNovelCatalogPlugin,
    removeInstalledNovelPlugin,
    setInstalledNovelPluginEnabled,
  } from "../../lib/novels/packages";
  import { runNovelRuntimeSmokeTest, type NovelRuntimeSmokeResult } from "../../lib/novels/runtimeHost";
  import type { NovelCatalogEntry, NovelRepositoryRecord } from "../../lib/novels/contracts";
  import {
    getNovelSourceClassificationBadge,
    getNovelSourceClassificationRecord,
    loadNovelSourceClassificationState,
    removeNovelSourceClassificationRecord,
    saveNovelSourceClassificationState,
    type PersistedNovelSourceClassificationState,
  } from "../../lib/novels/sourceClassificationState";
  import {
    needsAutomaticNovelSourceClassification,
    hasReusableNovelSourceClassification,
    runAutomaticNovelSourceClassification,
    setQueuedNovelSourceClassification,
  } from "../../lib/novels/automaticClassification";
  import NovelSourceCheckModal, { type NovelSourceCheckStage } from "../novels/NovelSourceCheckModal.svelte";
  import NovelSourceStatusDetails from "../novels/NovelSourceStatusDetails.svelte";

  interface Props {
    profileId?: string | null;
    serverUrl?: string | null;
    scopeLabel: string;
  }

  const LNREADER_AUDITED_OFFICIAL_REPOSITORY_URL =
    "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json";
  const NOVEL_RUNTIME_SMOKE_SAFE_PLUGIN_IDS = ["69shu"] as const;

  let {
    profileId = null,
    serverUrl = null,
    scopeLabel,
  }: Props = $props();

  let repositoryState = $state<PersistedNovelRepositoryState>(
    createEmptyNovelRepositoryState({ profileId: null, serverUrl: null })
  );
  let loading = $state(true);
  let saving = $state(false);
  let panelError = $state<string | null>(null);
  let addRepositoryUrl = $state("");
  let languageFilterInput = $state("");
  let catalogSearchInput = $state("");
  let refreshingRepositoryId = $state<string | null>(null);
  let refreshingAll = $state(false);
  let smokingRepositoryId = $state<string | null>(null);
  let lastSmokeResult = $state<NovelRuntimeSmokeResult | null>(null);
  let sourceClassificationState = $state<PersistedNovelSourceClassificationState>({
    version: 1,
    scopeKey: "",
    records: [],
    updatedAtMs: null,
  });
  let lastLoadedScopeKey = $state<string | null>(null);
  let expandedRepositoryIds = $state<string[]>([]);
  let controlsOpen = $state(false);
  let retryingClassificationPluginId = $state<string | null>(null);
  const autoClassificationInFlight = new Set<string>();
  let pendingSourceCheckJobs = $state<SourceCheckJob[]>([]);
  let currentSourceCheckJob = $state<SourceCheckJob | null>(null);
  let sourceCheckRunning = $state(false);
  let sourceCheckModalState = $state<SourceCheckModalState | null>(null);

  type SourceCheckAction = "Install extension" | "Update extension" | "Retry check";

  interface SourceCheckJob {
    entry: NovelCatalogEntry;
    actionLabel: SourceCheckAction;
    runInstall: boolean;
  }

  interface SourceCheckModalState {
    pluginId: string;
    pluginName: string;
    actionLabel: SourceCheckAction;
    stage: NovelSourceCheckStage;
    record: import("../../lib/novels/sourceClassificationState").PersistedNovelSourceClassificationRecord | null;
    errorMessage: string | null;
    queueCount: number;
  }

  const visibleCatalogEntries = $derived.by(() => getVisibleNovelCatalogEntries(repositoryState));
  const installedSourceIds = $derived.by(() => getInstalledNovelSources(repositoryState));
  const scopeInput = $derived({
    profileId,
    serverUrl,
  });

  function syncLanguageFilterInput() {
    languageFilterInput = repositoryState.languageFilter.join(", ");
  }

  function fmtWhen(value: number | null): string {
    if (!value) return "Never";
    return new Date(value).toLocaleString();
  }

  function parseLanguageFilterInput(value: string): string[] {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function matchesCatalogSearch(entry: NovelCatalogEntry): boolean {
    const query = catalogSearchInput.trim().toLowerCase();
    if (!query) return true;

    return [entry.name, entry.pluginId, entry.site, entry.lang].some((value) =>
      value.toLowerCase().includes(query)
    );
  }

  function entriesForRepository(repositoryId: string) {
    const allEntries = getVisibleNovelCatalogEntries(repositoryState, repositoryId).filter(matchesCatalogSearch);
    return expandedRepositoryIds.includes(repositoryId) ? allEntries : allEntries.slice(0, 8);
  }

  function totalEntriesForRepository(repositoryId: string) {
    return getVisibleNovelCatalogEntries(repositoryState, repositoryId).filter(matchesCatalogSearch).length;
  }

  function isRepositoryCatalogOpen(repositoryId: string) {
    return expandedRepositoryIds.includes(repositoryId);
  }

  function toggleRepositoryCatalogExpansion(repositoryId: string) {
    expandedRepositoryIds = expandedRepositoryIds.includes(repositoryId)
      ? expandedRepositoryIds.filter((entry) => entry !== repositoryId)
      : [...expandedRepositoryIds, repositoryId];
  }

  function installStateForEntry(entry: NovelCatalogEntry) {
    return getNovelCatalogEntryInstallState(repositoryState, entry);
  }

  function classificationRecordForPlugin(pluginId: string) {
    return getNovelSourceClassificationRecord(sourceClassificationState, pluginId);
  }

  function classificationBadgeForPlugin(pluginId: string) {
    return getNovelSourceClassificationBadge(classificationRecordForPlugin(pluginId));
  }

  function classificationBusyForPlugin(pluginId: string) {
    return retryingClassificationPluginId === pluginId
      || (
        sourceCheckModalState?.pluginId === pluginId
        && (sourceCheckModalState.stage === "installing" || sourceCheckModalState.stage === "checking")
      );
  }

  function pickSmokeCatalogEntry(repositoryId: string) {
    const repositoryEntries = repositoryState.catalogEntries.filter((entry) => entry.repositoryId === repositoryId);
    for (const safePluginId of NOVEL_RUNTIME_SMOKE_SAFE_PLUGIN_IDS) {
      const match = repositoryEntries.find((entry) => entry.pluginId === safePluginId);
      if (match) {
        return match;
      }
    }

    return null;
  }

  async function loadState() {
    loading = true;
    panelError = null;
    try {
      repositoryState = await loadNovelRepositoryState(scopeInput);
      sourceClassificationState = await loadNovelSourceClassificationState(scopeInput);
      syncLanguageFilterInput();
    } catch (error) {
      panelError = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  async function persist(nextState: PersistedNovelRepositoryState) {
    saving = true;
    panelError = null;
    try {
      repositoryState = await saveNovelRepositoryState(nextState, scopeInput);
      syncLanguageFilterInput();
    } catch (error) {
      panelError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      saving = false;
    }
  }

  async function addRepository(url: string, recommendedSeed = false) {
    panelError = null;
    try {
      const nextState = addNovelRepositoryToState(repositoryState, {
        profileId: scopeInput.profileId,
        url,
        recommendedSeed,
      });
      await persist(nextState);
      addRepositoryUrl = "";
      addToast({
        kind: "success",
        title: "Novel repository saved",
        body: "The LNReader repository is now scoped to this profile.",
      });
    } catch (error) {
      panelError = error instanceof Error ? error.message : String(error);
    }
  }

  async function updateLanguageFilter() {
    try {
      await persist(setNovelRepositoryLanguageFilter(repositoryState, parseLanguageFilterInput(languageFilterInput)));
    } catch {}
  }

  async function refreshRepository(repository: NovelRepositoryRecord) {
    refreshingRepositoryId = repository.id;
    panelError = null;
    try {
      const result = await refreshNovelRepositoryCatalog(repositoryState, repository.id);
      await persist(result.state);
      addToast({
        kind: result.status === "error" ? "error" : "success",
        title: result.status === "not-modified" ? "Catalog already current" : "Novel catalog refreshed",
        body:
          result.status === "error"
            ? (result.repository.lastError ?? "Refresh failed.")
            : `${result.catalogCount} plugin entries available for ${repository.normalizedUrl}.`,
      });
    } catch (error) {
      panelError = error instanceof Error ? error.message : String(error);
    } finally {
      refreshingRepositoryId = null;
    }
  }

  async function refreshAllRepositories() {
    refreshingAll = true;
    panelError = null;
    try {
      const result = await refreshAllNovelRepositories(repositoryState);
      await persist(result.state);
      const failures = result.results.filter((entry) => entry.status === "error").length;
      addToast({
        kind: failures > 0 ? "info" : "success",
        title: failures > 0 ? "Refresh completed with warnings" : "All novel catalogs refreshed",
        body:
          failures > 0
            ? `${failures} repository refreshes failed. Their previous cache was kept.`
            : `${result.results.length} repositories refreshed.`,
      });
    } catch (error) {
      panelError = error instanceof Error ? error.message : String(error);
    } finally {
      refreshingAll = false;
    }
  }

  async function queueAutomaticClassificationForPlugin(entry: NovelCatalogEntry) {
    const queueKey = `${scopeInput.profileId ?? ""}::${scopeInput.serverUrl ?? ""}::${entry.pluginId}`;
    if (autoClassificationInFlight.has(queueKey)) {
      return classificationRecordForPlugin(entry.pluginId);
    }
    autoClassificationInFlight.add(queueKey);

    try {
      sourceClassificationState = await loadNovelSourceClassificationState(scopeInput);
      await setQueuedNovelSourceClassification(scopeInput, {
        pluginId: entry.pluginId,
        version: entry.version,
        repositoryId: entry.repositoryId,
        repositoryUrl: repositoryState.repositories.find((repository) => repository.id === entry.repositoryId)?.normalizedUrl ?? null,
        lang: entry.lang,
      });
      sourceClassificationState = await loadNovelSourceClassificationState(scopeInput);
      const record = await runAutomaticNovelSourceClassification(scopeInput, entry.pluginId);
      sourceClassificationState = await loadNovelSourceClassificationState(scopeInput);
      return record;
    } catch (error) {
      panelError = error instanceof Error ? error.message : String(error);
      sourceClassificationState = await loadNovelSourceClassificationState(scopeInput);
      throw error;
    } finally {
      autoClassificationInFlight.delete(queueKey);
    }
  }

  function updateSourceCheckQueueCount() {
    if (!sourceCheckModalState) return;
    sourceCheckModalState = {
      ...sourceCheckModalState,
      queueCount: pendingSourceCheckJobs.length,
    };
  }

  function enqueueSourceCheckJob(job: SourceCheckJob) {
    pendingSourceCheckJobs = [...pendingSourceCheckJobs, job];
    updateSourceCheckQueueCount();
    if (!currentSourceCheckJob && !sourceCheckRunning) {
      void startNextSourceCheckJob();
    }
  }

  async function startNextSourceCheckJob() {
    if (sourceCheckRunning || currentSourceCheckJob || pendingSourceCheckJobs.length === 0) return;

    const [job, ...rest] = pendingSourceCheckJobs;
    pendingSourceCheckJobs = rest;
    currentSourceCheckJob = job;
    sourceCheckRunning = true;
    sourceCheckModalState = {
      pluginId: job.entry.pluginId,
      pluginName: job.entry.name,
      actionLabel: job.actionLabel,
      stage: job.runInstall ? "installing" : "checking",
      record: null,
      errorMessage: null,
      queueCount: pendingSourceCheckJobs.length,
    };

    try {
      if (job.runInstall) {
        const nextState = await installNovelCatalogPlugin({
          state: repositoryState,
          entry: job.entry,
          scopeInput,
        });
        await persist(nextState);
      }

      sourceClassificationState = await loadNovelSourceClassificationState(scopeInput);
      if (job.runInstall && hasReusableNovelSourceClassification(sourceClassificationState, job.entry.pluginId, job.entry.version)) {
        const record = classificationRecordForPlugin(job.entry.pluginId);
        sourceCheckModalState = {
          ...sourceCheckModalState!,
          actionLabel: "Already checked",
          stage: "completed",
          record,
          errorMessage: null,
          queueCount: pendingSourceCheckJobs.length,
        };
        return;
      }

      sourceCheckModalState = {
        ...sourceCheckModalState!,
        stage: "checking",
      };

      const record = await queueAutomaticClassificationForPlugin(job.entry);
      sourceCheckModalState = {
        ...sourceCheckModalState!,
        stage: "completed",
        record,
        errorMessage: null,
        queueCount: pendingSourceCheckJobs.length,
      };
    } catch (error) {
      sourceCheckModalState = {
        ...sourceCheckModalState!,
        stage: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        queueCount: pendingSourceCheckJobs.length,
      };
    } finally {
      if (job.actionLabel === "Retry check") {
        retryingClassificationPluginId = null;
      }
      sourceCheckRunning = false;
    }
  }

  function closeSourceCheckModal() {
    if (sourceCheckRunning) return;
    currentSourceCheckJob = null;
    sourceCheckModalState = null;
    if (pendingSourceCheckJobs.length > 0) {
      void startNextSourceCheckJob();
    }
  }

  async function retrySourceCheckFromModal() {
    if (!currentSourceCheckJob || sourceCheckRunning) return;
    retryingClassificationPluginId = currentSourceCheckJob.entry.pluginId;
    sourceCheckRunning = true;
    sourceCheckModalState = {
      ...sourceCheckModalState!,
      stage: "checking",
      errorMessage: null,
    };
    try {
      const record = await queueAutomaticClassificationForPlugin(currentSourceCheckJob.entry);
      sourceCheckModalState = {
        ...sourceCheckModalState!,
        stage: "completed",
        record,
        errorMessage: null,
      };
    } catch (error) {
      sourceCheckModalState = {
        ...sourceCheckModalState!,
        stage: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      retryingClassificationPluginId = null;
      sourceCheckRunning = false;
    }
  }

  function installOrUpdateCatalogEntry(entry: NovelCatalogEntry) {
    panelError = null;
    enqueueSourceCheckJob({
      entry,
      actionLabel: installStateForEntry(entry).status === "update-available" ? "Update extension" : "Install extension",
      runInstall: true,
    });
  }

  function retryAutomaticClassification(entry: NovelCatalogEntry) {
    retryingClassificationPluginId = entry.pluginId;
    enqueueSourceCheckJob({
      entry,
      actionLabel: "Retry check",
      runInstall: false,
    });
  }

  async function setPluginEnabled(pluginId: string, enabled: boolean) {
    panelError = null;
    try {
      await persist(setInstalledNovelPluginEnabled(repositoryState, pluginId, enabled));
      addToast({
        kind: "success",
        title: enabled ? "Novel plugin enabled" : "Novel plugin disabled",
        body: `${pluginId} ${enabled ? "is now available in" : "was removed from"} Novel Sources for this profile.`,
      });
    } catch (error) {
      panelError = error instanceof Error ? error.message : String(error);
    }
  }

  async function removePlugin(pluginId: string) {
    panelError = null;
    try {
      const nextState = await removeInstalledNovelPlugin(repositoryState, pluginId, scopeInput);
      await persist(nextState);
      sourceClassificationState = await loadNovelSourceClassificationState(scopeInput).then((state) => (
        saveClassificationState(removeNovelSourceClassificationRecord(state, pluginId))
      ));
      addToast({
        kind: "success",
        title: "Novel plugin removed",
        body: `${pluginId} was removed from this profile-scoped novels storage.`,
      });
    } catch (error) {
      panelError = error instanceof Error ? error.message : String(error);
    }
  }

  async function runSmoke(repository: NovelRepositoryRecord) {
    const catalogEntry = pickSmokeCatalogEntry(repository.id);
    if (!catalogEntry) {
      panelError =
        "Refresh the official LNReader repository before running the runtime smoke test. This slice currently requires the audited 69shu plugin probe.";
      return;
    }
    if (repository.trustState !== "trusted" || !repository.enabled) {
      panelError = "Runtime smoke requires a trusted and enabled repository.";
      return;
    }

    smokingRepositoryId = repository.id;
    panelError = null;

    try {
      lastSmokeResult = await runNovelRuntimeSmokeTest({
        repository,
        catalogEntry,
      });
      addToast({
        kind: "success",
        title: "Novel runtime smoke passed",
        body: `${catalogEntry.pluginId} crossed the hidden host boundary, resolved novel details and one chapter, and shut down cleanly.`,
      });
    } catch (error) {
      panelError = error instanceof Error ? error.message : String(error);
      lastSmokeResult = null;
    } finally {
      smokingRepositoryId = null;
    }
  }

  async function saveClassificationState(nextState: PersistedNovelSourceClassificationState) {
    sourceClassificationState = await saveNovelSourceClassificationState(nextState, scopeInput);
    return sourceClassificationState;
  }

  $effect(() => {
    const scopeKey = `${scopeInput.profileId ?? ""}::${scopeInput.serverUrl ?? ""}`;
    if (scopeKey === lastLoadedScopeKey) return;
    lastLoadedScopeKey = scopeKey;
    repositoryState = createEmptyNovelRepositoryState(scopeInput);
    void loadState();
  });

  $effect(() => {
    if (repositoryState.repositories.length === 0) {
      controlsOpen = true;
    }
  });

  $effect(() => {
    if (loading) return;

    const trustedRepositories = new Map(
      repositoryState.repositories.map((repository) => [repository.id, repository] as const)
    );
    for (const plugin of repositoryState.installedPlugins) {
      const repository = trustedRepositories.get(plugin.repositoryId) ?? null;
      if (!needsAutomaticNovelSourceClassification(sourceClassificationState, plugin, repository)) {
        continue;
      }

      const catalogEntry = repositoryState.catalogEntries.find((entry) => (
        entry.pluginId === plugin.pluginId
        && entry.repositoryId === plugin.repositoryId
        && entry.version === plugin.version
      )) ?? repositoryState.catalogEntries.find((entry) => entry.pluginId === plugin.pluginId);

      if (!catalogEntry) continue;
      void queueAutomaticClassificationForPlugin(catalogEntry);
    }
  });
</script>

<div class="novel-repos-panel">
  <div class="novel-repos-hero">
    <div class="novel-repos-header">
      <div>
        <p class="settings-card__title">Novel sources</p>
        <p class="novel-repos-scope">
          Profile-scoped LNReader repositories for <strong>{scopeLabel}</strong>. Keep the shell minimal and only reveal repository management when you need it.
        </p>
      </div>
      <div class="novel-repos-header__actions">
        <button
          class="n-btn n-btn--sm n-btn-ghost"
          type="button"
          onclick={refreshAllRepositories}
          disabled={loading || refreshingAll || repositoryState.repositories.length === 0}
        >
          {refreshingAll ? "Refreshing..." : "Refresh all"}
        </button>
        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (controlsOpen = !controlsOpen)}>
          {controlsOpen ? "Hide controls" : "Manage repos"}
        </button>
      </div>
    </div>

    <div class="novel-repos-summary">
      <span class="novel-repos-summary__pill">{repositoryState.repositories.length} repositories</span>
      <span class="novel-repos-summary__pill">{visibleCatalogEntries.length} visible plugins</span>
      <span class="novel-repos-summary__pill">{installedSourceIds.length} installed</span>
      <span class="novel-repos-summary__pill">{repositoryState.catalogEntries.length} cached entries</span>
    </div>
  </div>

  {#if controlsOpen}
    <div class="novel-repos-controls novel-repos-controls--open">
      <div class="novel-repos-controls__grid">
        <div class="novel-repos-control-block">
          <span class="settings-mini-row__label">Repository feed</span>
          <span class="settings-mini-row__hint">Add a custom feed or seed the audited official index.</span>
          <div class="novel-repos-add">
            <input
              class="novel-repos-input"
              bind:value={addRepositoryUrl}
              placeholder={LNREADER_AUDITED_OFFICIAL_REPOSITORY_URL}
              spellcheck="false"
            />
            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => addRepository(addRepositoryUrl)} disabled={!addRepositoryUrl.trim() || saving}>
              Add repo
            </button>
            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => addRepository(LNREADER_AUDITED_OFFICIAL_REPOSITORY_URL, true)} disabled={saving}>
              Official
            </button>
          </div>
        </div>

        <div class="novel-repos-control-block">
          <span class="settings-mini-row__label">Filters</span>
          <span class="settings-mini-row__hint">Narrow the cached catalog without flooding the pane with admin UI.</span>
          <div class="novel-repos-filter-grid">
            <label class="novel-repos-field">
              <span>Language</span>
              <div class="novel-repos-filter-controls">
                <input class="novel-repos-input" bind:value={languageFilterInput} spellcheck="false" placeholder="en, pt-br" />
                <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={updateLanguageFilter} disabled={saving}>Apply</button>
              </div>
            </label>
            <label class="novel-repos-field">
              <span>Catalog search</span>
              <input class="novel-repos-input" bind:value={catalogSearchInput} spellcheck="false" placeholder="allnovel, archiveofourown, pt-br..." />
            </label>
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#if panelError}
    <p class="novel-repos-state novel-repos-state--error">{panelError}</p>
  {/if}

  {#if loading}
    <p class="novel-repos-state">Loading profile-scoped novel repositories…</p>
  {:else if repositoryState.repositories.length === 0}
    <p class="novel-repos-state">No LNReader repositories saved for this profile yet.</p>
  {:else}
    <div class="novel-repos-list">
      {#each repositoryState.repositories as repository (repository.id)}
        {@const uiState = deriveNovelRepositoryUiState(repository)}
        {@const repoEntries = entriesForRepository(repository.id)}
        {@const totalEntries = totalEntriesForRepository(repository.id)}
        {@const isCatalogOpen = isRepositoryCatalogOpen(repository.id)}
        <article class="novel-repo-card" data-repo-state={uiState}>
          <div class="novel-repo-card__header">
            <div class="novel-repo-card__identity">
              <div class="novel-repo-card__title-wrap">
                <span class="novel-repo-card__title">{repository.normalizedUrl}</span>
                <p class="novel-repo-card__summary">
                  {repository.enabled
                    ? "Enabled for this profile and ready to feed Novel Sources."
                    : "Saved locally but disabled until you want it active again."}
                </p>
                <div class="novel-repo-card__badges">
                  <span class="novel-repo-badge" data-variant={uiState}>{uiState}</span>
                  {#if repository.recommendedSeed}
                    <span class="novel-repo-badge" data-variant="seed">official seed</span>
                  {/if}
                  <span class="novel-repo-badge" data-variant={repository.trustState}>{repository.trustState}</span>
                </div>
              </div>
            </div>
            <div class="novel-repo-card__actions">
              <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => refreshRepository(repository)} disabled={refreshingRepositoryId === repository.id}>
                {refreshingRepositoryId === repository.id ? "Refreshing..." : "Refresh"}
              </button>
              <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => runSmoke(repository)} disabled={smokingRepositoryId === repository.id}>
                {smokingRepositoryId === repository.id ? "Running..." : "Smoke"}
              </button>
              <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => { void persist(setNovelRepositoryEnabled(repositoryState, repository.id, !repository.enabled)).catch(() => {}); }}>
                {repository.enabled ? "Disable" : "Enable"}
              </button>
              <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={() => { void persist(removeNovelRepositoryFromState(repositoryState, repository.id)).catch(() => {}); }}>
                Remove
              </button>
            </div>
          </div>

          <div class="novel-repo-card__metrics">
            <span>{totalEntries} plugins cached</span>
            <span>Last fetch {fmtWhen(repository.lastFetchedAtMs)}</span>
            <span>Last success {fmtWhen(repository.lastSuccessAtMs)}</span>
          </div>

          <div class="novel-repo-card__trust">
            <div class="novel-repo-card__trust-copy">
              <span class="settings-mini-row__label">Trust gate</span>
              <span class="settings-mini-row__hint">Cached feeds still need explicit trust before runtime execution is allowed.</span>
            </div>
            <div class="novel-repo-card__trust-buttons">
              <button class="content-action-btn" class:content-action-active-allow={repository.trustState === "unknown"} type="button" onclick={() => { void persist(setNovelRepositoryTrustState(repositoryState, repository.id, "unknown")).catch(() => {}); }}>Untrusted</button>
              <button class="content-action-btn" class:content-action-active-allow={repository.trustState === "trusted"} type="button" onclick={() => { void persist(setNovelRepositoryTrustState(repositoryState, repository.id, "trusted")).catch(() => {}); }}>Trusted</button>
              <button class="content-action-btn" class:content-action-active-block={repository.trustState === "blocked"} type="button" onclick={() => { void persist(setNovelRepositoryTrustState(repositoryState, repository.id, "blocked")).catch(() => {}); }}>Blocked</button>
            </div>
          </div>

          {#if repository.lastError}
            <p class="novel-repos-state novel-repos-state--error">{repository.lastError}</p>
          {/if}

          <div class="novel-repo-card__catalog-shell">
            <button class="novel-repo-card__catalog-toggle" type="button" onclick={() => toggleRepositoryCatalogExpansion(repository.id)}>
              <span>Catalog preview</span>
              <span>{isCatalogOpen ? "Hide" : `Show ${Math.min(totalEntries, 8)}${totalEntries > 8 ? "+" : ""}`}</span>
            </button>

            {#if isCatalogOpen}
              <div class="novel-repo-card__catalog novel-repo-card__catalog--open">
                {#if repoEntries.length === 0}
                  <p class="settings-mini-row__hint">No cached entries match the current language filter for this repository.</p>
                {:else}
                  <div class="novel-repo-entry-list">
                    {#each repoEntries as entry (entry.pluginId)}
                      {@const installState = installStateForEntry(entry)}
                      {@const classification = classificationRecordForPlugin(entry.pluginId)}
                      <div class="novel-repo-entry">
                        <div class="novel-repo-entry__copy">
                          <span class="novel-repo-entry__name">{entry.name}</span>
                          <span class="novel-repo-entry__meta">{entry.pluginId} · {entry.lang} · {entry.version}</span>
                        </div>
                        <div class="novel-repo-entry__actions">
                          <span class="novel-repo-badge" data-variant={installState.status}>{installState.status}</span>
                          {#if classification}
                            <NovelSourceStatusDetails
                              pluginName={entry.name}
                              record={classification}
                              badge={classificationBadgeForPlugin(entry.pluginId)}
                              contextLabel="Installed source status"
                              onRetryCheck={() => { void retryAutomaticClassification(entry); }}
                              retryBusy={classificationBusyForPlugin(entry.pluginId)}
                            />
                          {/if}
                          <span class="novel-repo-entry__site">{entry.site}</span>
                          {#if installState.status === "available" || installState.status === "update-available"}
                            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => installOrUpdateCatalogEntry(entry)} disabled={saving || classificationBusyForPlugin(entry.pluginId)}>
                              {installState.status === "update-available" ? "Update" : "Install"}
                            </button>
                          {:else if installState.status === "installed"}
                            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => setPluginEnabled(entry.pluginId, false)} disabled={saving}>
                              Disable
                            </button>
                            <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={() => removePlugin(entry.pluginId)} disabled={saving}>
                              Remove
                            </button>
                          {:else if installState.status === "disabled"}
                            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => setPluginEnabled(entry.pluginId, true)} disabled={saving}>
                              Enable
                            </button>
                            <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={() => removePlugin(entry.pluginId)} disabled={saving}>
                              Remove
                            </button>
                          {/if}
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}

  {#if lastSmokeResult}
    <div class="novel-smoke-result">
      <p class="settings-card__title">Runtime smoke result</p>
      <div class="novel-smoke-result__grid">
        <span>Plugin: {lastSmokeResult.pluginId}</span>
        <span>Startup: {lastSmokeResult.startupConfirmed ? "yes" : "no"}</span>
        <span>Shutdown: {lastSmokeResult.shutdownConfirmed ? "yes" : "no"}</span>
        <span>Details: {lastSmokeResult.detailsConfirmed ? "yes" : "no"}</span>
        <span>Chapter: {lastSmokeResult.chapterConfirmed ? "yes" : "no"}</span>
        <span>Summary present: {lastSmokeResult.detailsSummaryPresent ? "yes" : "no"}</span>
      </div>
    </div>
  {/if}

  {#if sourceCheckModalState}
    <NovelSourceCheckModal
      pluginName={sourceCheckModalState.pluginName}
      pluginId={sourceCheckModalState.pluginId}
      actionLabel={sourceCheckModalState.actionLabel}
      stage={sourceCheckModalState.stage}
      record={sourceCheckModalState.record}
      errorMessage={sourceCheckModalState.errorMessage}
      queueCount={sourceCheckModalState.queueCount}
      onClose={closeSourceCheckModal}
      onRetryCheck={() => { void retrySourceCheckFromModal(); }}
      retryBusy={sourceCheckRunning && sourceCheckModalState.actionLabel === "Retry check"}
    />
  {/if}
</div>

<style>
  .novel-repos-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .novel-repos-hero,
  .novel-repos-controls,
  .novel-repo-card,
  .novel-smoke-result {
    border: 1px solid rgba(72, 69, 79, 0.12);
    border-radius: 18px;
    background: rgba(21, 21, 25, 0.72);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
  }

  .novel-repos-hero,
  .novel-repos-controls,
  .novel-repo-card,
  .novel-smoke-result {
    padding: 16px;
  }

  .novel-repos-header,
  .novel-repos-header__actions,
  .novel-repo-card__header,
  .novel-repo-card__actions,
  .novel-repo-card__trust-buttons,
  .novel-repo-entry__actions,
  .novel-repos-add,
  .novel-repos-filter-controls {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .novel-repos-header,
  .novel-repo-card__header {
    justify-content: space-between;
  }

  .novel-repos-scope,
  .novel-repo-card__summary,
  .novel-repo-entry__meta,
  .novel-repo-entry__site,
  .novel-smoke-result__grid,
  .novel-repo-card__metrics {
    color: rgba(202, 196, 208, 0.42);
  }

  .novel-repos-scope {
    margin: 6px 0 0;
    max-width: 560px;
    font-size: 11px;
    line-height: 1.45;
  }

  .novel-repos-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 14px;
  }

  .novel-repos-summary__pill {
    display: inline-flex;
    align-items: center;
    min-height: 30px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid rgba(84, 68, 125, 0.22);
    background: linear-gradient(180deg, rgba(31, 28, 38, 0.96), rgba(20, 19, 27, 0.94));
    color: rgba(225, 219, 239, 0.76);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .novel-repos-controls__grid {
    display: grid;
    gap: 16px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .novel-repos-controls--open,
  .novel-repo-card__catalog--open {
    animation: novelReposFadeIn 180ms ease both;
  }

  .novel-repos-control-block {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .novel-repos-filter-grid {
    display: grid;
    gap: 12px;
  }

  .novel-repos-field {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: rgba(202, 196, 208, 0.34);
  }

  .novel-repos-input {
    width: 100%;
    min-width: 0;
    min-height: 38px;
    border-radius: 14px;
    border: 1px solid rgba(72, 69, 79, 0.16);
    background: rgba(17, 17, 22, 0.82);
    color: var(--n-on-surface);
    padding: 0 12px;
    font-size: 12px;
    font-weight: 600;
  }

  .novel-repos-input:focus {
    outline: none;
    border-color: rgba(184, 167, 234, 0.24);
    background: rgba(25, 23, 31, 0.94);
    box-shadow: 0 0 0 1px rgba(184, 167, 234, 0.08);
  }

  .novel-repos-state {
    margin: 0;
    padding: 12px 14px;
    border-radius: 16px;
    border: 1px solid rgba(72, 69, 79, 0.12);
    background: rgba(255, 255, 255, 0.02);
    color: rgba(202, 196, 208, 0.48);
    font-size: 12px;
    line-height: 1.45;
  }

  .novel-repos-state--error {
    color: var(--color-error);
    border-color: color-mix(in srgb, var(--color-error) 35%, rgba(72, 69, 79, 0.12));
    background: color-mix(in srgb, var(--color-error) 10%, rgba(255, 255, 255, 0.02));
  }

  .novel-repos-list {
    display: grid;
    gap: 14px;
  }

  .novel-repo-card__identity,
  .novel-repo-card__title-wrap,
  .novel-repo-card__trust-copy,
  .novel-repo-entry__copy {
    min-width: 0;
  }

  .novel-repo-card__title {
    display: block;
    font-size: 12px;
    font-weight: 700;
    color: var(--n-on-surface);
    overflow-wrap: anywhere;
  }

  .novel-repo-card__summary {
    margin: 5px 0 0;
    font-size: 11px;
    line-height: 1.45;
  }

  .novel-repo-card__badges {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }

  .novel-repo-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 24px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border: 1px solid rgba(72, 69, 79, 0.16);
    background: rgba(255, 255, 255, 0.02);
  }

  .novel-repo-badge[data-variant="ready"],
  .novel-repo-badge[data-variant="installed"],
  .novel-repo-badge[data-variant="trusted"],
  .novel-repo-badge[data-variant="migration-safe"],
  .novel-repo-badge[data-variant="working"],
  .novel-repo-badge[data-variant="success"],
  .novel-repo-badge[data-variant="info"] {
    color: rgba(225, 213, 255, 0.96);
    border-color: rgba(171, 142, 245, 0.28);
    background: rgba(103, 72, 182, 0.18);
  }

  .novel-repo-badge[data-variant="untrusted"],
  .novel-repo-badge[data-variant="update-available"],
  .novel-repo-badge[data-variant="unknown"],
  .novel-repo-badge[data-variant="working-with-known-limitations"],
  .novel-repo-badge[data-variant="warning"] {
    color: #f0c36a;
    border-color: color-mix(in oklab, #f0c36a 60%, var(--line-soft));
  }

  .novel-repo-badge[data-variant="blocked"],
  .novel-repo-badge[data-variant="error"],
  .novel-repo-badge[data-variant="blocked-by-site"],
  .novel-repo-badge[data-variant="runtime-gap"],
  .novel-repo-badge[data-variant="danger"] {
    color: var(--color-error);
    border-color: color-mix(in oklab, var(--color-error) 60%, var(--line-soft));
  }

  .novel-repo-badge[data-variant="disabled"],
  .novel-repo-badge[data-variant="available"],
  .novel-repo-badge[data-variant="stale"],
  .novel-repo-badge[data-variant="empty"],
  .novel-repo-badge[data-variant="seed"],
  .novel-repo-badge[data-variant="pending"],
  .novel-repo-badge[data-variant="muted"] {
    color: rgba(202, 196, 208, 0.56);
  }

  .novel-repo-card__metrics,
  .novel-smoke-result__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px;
    margin-top: 14px;
    font-size: 11px;
  }

  .novel-repo-card__trust {
    display: grid;
    gap: 12px;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.04);
  }

  .novel-repo-card__catalog-shell {
    margin-top: 14px;
  }

  .novel-repo-card__catalog-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    min-height: 36px;
    padding: 0 14px;
    border-radius: 14px;
    border: 1px solid rgba(72, 69, 79, 0.16);
    background: rgba(18, 18, 24, 0.8);
    color: rgba(224, 219, 236, 0.88);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    transition: border-color 160ms ease, background 160ms ease, transform 90ms ease;
  }

  .novel-repo-card__catalog-toggle:hover {
    border-color: rgba(171, 142, 245, 0.24);
    background: rgba(26, 24, 33, 0.92);
  }

  .novel-repo-card__catalog-toggle:active {
    transform: scale(0.985);
  }

  .novel-repo-card__catalog {
    margin-top: 12px;
  }

  @keyframes novelReposFadeIn {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .novel-repo-entry-list {
    display: grid;
    gap: 10px;
  }

  .novel-repo-entry {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px;
    border-radius: 14px;
    border: 1px solid rgba(72, 69, 79, 0.12);
    background: rgba(255, 255, 255, 0.02);
  }

  .novel-repo-entry__name {
    display: block;
    font-size: 12px;
    font-weight: 700;
    color: rgba(229, 226, 225, 0.92);
  }

  .novel-repo-entry__meta,
  .novel-repo-entry__site {
    display: block;
    font-size: 11px;
  }

  @media (max-width: 980px) {
    .novel-repos-controls__grid {
      grid-template-columns: 1fr;
    }

    .novel-repos-header,
    .novel-repo-card__header,
    .novel-repos-add,
    .novel-repo-card__actions,
    .novel-repo-entry {
      flex-direction: column;
      align-items: stretch;
    }

    .novel-repo-entry__actions,
    .novel-repos-filter-controls,
    .novel-repos-header__actions {
      flex-wrap: wrap;
      justify-content: flex-start;
    }
  }
</style>

