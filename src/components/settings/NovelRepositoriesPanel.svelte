<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
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
  import NocturneState from "../shared/NocturneState.svelte";

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
        title: translate("ui_novelRepositorySaved"),
        body: translate("ui_theLnreaderRepositoryIsNowScopedToThis"),
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
        title: result.status === translate("ui_notModified") ? translate("ui_catalogAlreadyCurrent") : translate("ui_novelCatalogRefreshed"),
        body:
          result.status === translate("ui_error")
            ? (result.repository.lastError ?? translate("ui_refreshFailed_0a5e2c85"))
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
        title: failures > 0 ? translate("ui_refreshCompletedWithWarnings") : translate("ui_allNovelCatalogsRefreshed"),
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
          actionLabel: translate("ui_alreadyChecked"),
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
      actionLabel: installStateForEntry(entry).status === translate("ui_updateAvailable") ? translate("ui_updateExtension") : translate("ui_installExtension"),
      runInstall: true,
    });
  }

  function retryAutomaticClassification(entry: NovelCatalogEntry) {
    retryingClassificationPluginId = entry.pluginId;
    enqueueSourceCheckJob({
      entry,
      actionLabel: translate("ui_retryCheck"),
      runInstall: false,
    });
  }

  async function setPluginEnabled(pluginId: string, enabled: boolean) {
    panelError = null;
    try {
      await persist(setInstalledNovelPluginEnabled(repositoryState, pluginId, enabled));
      addToast({
        kind: "success",
        title: enabled ? translate("ui_novelPluginEnabled") : translate("ui_novelPluginDisabled"),
        body: `${pluginId} ${enabled ? translate("ui_isNowAvailableIn") : translate("ui_wasRemovedFrom")} Novel Sources for this profile.`,
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
        title: translate("ui_novelPluginRemoved"),
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
        title: translate("ui_novelRuntimeSmokePassed"),
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
        <p class="settings-card__title">{$_("novelSources_eyebrow")}</p>
        <p class="novel-repos-scope">
          {$_("ui_profileScopedLnreaderRepositoriesFor")} <strong>{scopeLabel}</strong>{$_("ui_keepTheShellMinimalAndOnlyRevealRepository")}
        </p>
      </div>
      <div class="novel-repos-header__actions">
        <button
          class="n-btn n-btn--sm n-btn-ghost"
          type="button"
          onclick={refreshAllRepositories}
          disabled={loading || refreshingAll || repositoryState.repositories.length === 0}
        >
          {refreshingAll ? "Refreshing..." : $_("ui_refreshAll")}
        </button>
        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (controlsOpen = !controlsOpen)}>
          {controlsOpen ? $_("ui_hideControls") : $_("sources_repositories_manageManga")}
        </button>
      </div>
    </div>

    <div class="novel-repos-summary">
      <span class="novel-repos-summary__pill">{repositoryState.repositories.length} {$_("ui_repositories")}</span>
      <span class="novel-repos-summary__pill">{visibleCatalogEntries.length} {$_("ui_visiblePlugins")}</span>
      <span class="novel-repos-summary__pill">{installedSourceIds.length} {$_("ui_installed")}</span>
      <span class="novel-repos-summary__pill">{repositoryState.catalogEntries.length} {$_("ui_cachedEntries")}</span>
    </div>
  </div>

  {#if controlsOpen}
    <div class="novel-repos-controls novel-repos-controls--open">
      <div class="novel-repos-controls__grid">
        <div class="novel-repos-control-block">
          <span class="settings-mini-row__label">{$_("ui_repositoryFeed")}</span>
          <span class="settings-mini-row__hint">{$_("ui_addACustomFeedOrSeedTheAudited")}</span>
          <div class="novel-repos-add">
            <input
              class="novel-repos-input"
              bind:value={addRepositoryUrl}
              placeholder={LNREADER_AUDITED_OFFICIAL_REPOSITORY_URL}
              spellcheck="false"
            />
            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => addRepository(addRepositoryUrl)} disabled={!addRepositoryUrl.trim() || saving}>
              {$_("ui_addRepo")}
            </button>
            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => addRepository(LNREADER_AUDITED_OFFICIAL_REPOSITORY_URL, true)} disabled={saving}>
              {$_("sources_actions_official")}
            </button>
          </div>
        </div>

        <div class="novel-repos-control-block">
          <span class="settings-mini-row__label">{$_("ui_filters")}</span>
          <span class="settings-mini-row__hint">{$_("ui_narrowTheCachedCatalogWithoutFloodingThePane")}</span>
          <div class="novel-repos-filter-grid">
            <label class="novel-repos-field">
              <span>{$_("sources_table_language")}</span>
              <div class="novel-repos-filter-controls">
                <input class="novel-repos-input" bind:value={languageFilterInput} spellcheck="false" placeholder={$_("ui_enPtBr")} />
                <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={updateLanguageFilter} disabled={saving}>{$_("ui_apply")}</button>
              </div>
            </label>
            <label class="novel-repos-field">
              <span>{$_("ui_catalogSearch")}</span>
              <input class="novel-repos-input" bind:value={catalogSearchInput} spellcheck="false" placeholder={$_("ui_allnovelArchiveofourownPtBr")} />
            </label>
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#if panelError}
    <NocturneState
      layout="compact"
      tone="danger"
      icon="warning"
      eyebrow="Novel repositories"
      title={$_("ui_couldNotUpdateRepositorySettings")}
      body={panelError}
    />
  {/if}

  {#if loading}
    <NocturneState layout="compact" tone="info" icon="retry" eyebrow="Novel repositories" title={$_("ui_loadingRepositories")} body="Loading profile-scoped novel repositories..." />
  {:else if repositoryState.repositories.length === 0}
    <NocturneState layout="compact" tone="info" icon="folder" eyebrow="Novel repositories" title={$_("ui_noRepositoriesSaved")} body="No LNReader repositories are saved for this profile yet." />
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
                    ? $_("ui_enabledForThisProfileAndReadyToFeed")
                    : $_("ui_savedLocallyButDisabledUntilYouWantIt")}
                </p>
                <div class="novel-repo-card__badges">
                  <span class="novel-repo-badge" data-variant={uiState}>{uiState}</span>
                  {#if repository.recommendedSeed}
                    <span class="novel-repo-badge" data-variant="seed">{$_("ui_officialSeed")}</span>
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
                {$_("sources_actions_remove")}
              </button>
            </div>
          </div>

          <div class="novel-repo-card__metrics">
            <span>{totalEntries} {$_("ui_pluginsCached")}</span>
            <span>{$_("ui_lastFetch")} {fmtWhen(repository.lastFetchedAtMs)}</span>
            <span>{$_("ui_lastSuccess")} {fmtWhen(repository.lastSuccessAtMs)}</span>
          </div>

          <div class="novel-repo-card__trust">
            <div class="novel-repo-card__trust-copy">
              <span class="settings-mini-row__label">{$_("ui_trustGate")}</span>
              <span class="settings-mini-row__hint">{$_("ui_cachedFeedsStillNeedExplicitTrustBeforeRuntime")}</span>
            </div>
            <div class="novel-repo-card__trust-buttons">
              <button class="content-action-btn" class:content-action-active-allow={repository.trustState === "unknown"} type="button" onclick={() => { void persist(setNovelRepositoryTrustState(repositoryState, repository.id, "unknown")).catch(() => {}); }}>{$_("ui_untrusted")}</button>
              <button class="content-action-btn" class:content-action-active-allow={repository.trustState === "trusted"} type="button" onclick={() => { void persist(setNovelRepositoryTrustState(repositoryState, repository.id, "trusted")).catch(() => {}); }}>{$_("ui_trusted")}</button>
              <button class="content-action-btn" class:content-action-active-block={repository.trustState === "blocked"} type="button" onclick={() => { void persist(setNovelRepositoryTrustState(repositoryState, repository.id, "blocked")).catch(() => {}); }}>{$_("ui_blocked_99613c74")}</button>
            </div>
          </div>

          {#if repository.lastError}
            <NocturneState layout="compact" tone="warning" icon="warning" eyebrow="Repository" title={$_("ui_lastRefreshFailed")} body={repository.lastError} />
          {/if}

          <div class="novel-repo-card__catalog-shell">
            <button class="novel-repo-card__catalog-toggle" type="button" onclick={() => toggleRepositoryCatalogExpansion(repository.id)}>
              <span>{$_("ui_catalogPreview")}</span>
              <span>{isCatalogOpen ? "Hide" : `Show ${Math.min(totalEntries, 8)}${totalEntries > 8 ? "+" : ""}`}</span>
            </button>

            {#if isCatalogOpen}
              <div class="novel-repo-card__catalog novel-repo-card__catalog--open">
                {#if repoEntries.length === 0}
                  <p class="settings-mini-row__hint">{$_("ui_noCachedEntriesMatchTheCurrentLanguageFilter")}</p>
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
                              {$_("sources_actions_disable")}
                            </button>
                            <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={() => removePlugin(entry.pluginId)} disabled={saving}>
                              {$_("sources_actions_remove")}
                            </button>
                          {:else if installState.status === "disabled"}
                            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => setPluginEnabled(entry.pluginId, true)} disabled={saving}>
                              {$_("sources_actions_enable")}
                            </button>
                            <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={() => removePlugin(entry.pluginId)} disabled={saving}>
                              {$_("sources_actions_remove")}
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
      <p class="settings-card__title">{$_("ui_runtimeSmokeResult")}</p>
      <div class="novel-smoke-result__grid">
        <span>{$_("ui_plugin")} {lastSmokeResult.pluginId}</span>
        <span>{$_("ui_startup")} {lastSmokeResult.startupConfirmed ? "yes" : "no"}</span>
        <span>{$_("ui_shutdown")} {lastSmokeResult.shutdownConfirmed ? "yes" : "no"}</span>
        <span>{$_("ui_details")} {lastSmokeResult.detailsConfirmed ? "yes" : "no"}</span>
        <span>{$_("ui_chapter")} {lastSmokeResult.chapterConfirmed ? "yes" : "no"}</span>
        <span>{$_("ui_summaryPresent")} {lastSmokeResult.detailsSummaryPresent ? "yes" : "no"}</span>
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
    gap: var(--component-novel-repositories-panel-gap);
  }

  .novel-repos-hero,
  .novel-repos-controls,
  .novel-repo-card,
  .novel-smoke-result {
    border: var(--component-novel-repositories-surface-border);
    border-radius: var(--component-novel-repositories-surface-radius);
    background: var(--component-novel-repositories-surface-background);
    box-shadow: var(--component-novel-repositories-surface-shadow);
  }

  .novel-repos-hero,
  .novel-repos-controls,
  .novel-repo-card,
  .novel-smoke-result {
    padding: var(--component-novel-repositories-surface-padding);
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
    gap: var(--component-novel-repositories-control-gap);
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
    color: var(--component-novel-repositories-muted-color);
  }

  .novel-repos-scope {
    margin: var(--component-novel-repositories-scope-margin);
    max-width: var(--component-novel-repositories-scope-max-width);
    font-size: var(--component-novel-repositories-scope-font-size);
    line-height: var(--component-novel-repositories-scope-line-height);
  }

  .novel-repos-summary {
    display: flex;
    flex-wrap: wrap;
    gap: var(--component-novel-repositories-summary-gap);
    margin-top: var(--component-novel-repositories-summary-margin-top);
  }

  .novel-repos-summary__pill {
    display: inline-flex;
    align-items: center;
    min-height: var(--component-novel-repositories-summary-pill-min-height);
    padding: var(--component-novel-repositories-summary-pill-padding);
    border-radius: var(--component-novel-repositories-pill-radius);
    border: var(--component-novel-repositories-summary-pill-border);
    background: var(--component-novel-repositories-summary-pill-background);
    color: var(--component-novel-repositories-summary-pill-color);
    font-size: var(--component-novel-repositories-label-font-size);
    font-weight: var(--component-novel-repositories-strong-font-weight);
    letter-spacing: var(--component-novel-repositories-label-letter-spacing);
    text-transform: uppercase;
  }

  .novel-repos-controls__grid {
    display: grid;
    gap: var(--component-novel-repositories-controls-grid-gap);
    grid-template-columns: var(--component-novel-repositories-controls-grid-template);
  }

  .novel-repos-controls--open,
  .novel-repo-card__catalog--open {
    animation: novelReposFadeIn var(--component-novel-repositories-motion-enter) var(--component-novel-repositories-motion-easing) both;
  }

  .novel-repos-control-block {
    display: flex;
    flex-direction: column;
    gap: var(--component-novel-repositories-control-block-gap);
  }

  .novel-repos-filter-grid {
    display: grid;
    gap: var(--component-novel-repositories-filter-grid-gap);
  }

  .novel-repos-field {
    display: flex;
    flex-direction: column;
    gap: var(--component-novel-repositories-field-gap);
    min-width: 0;
    font-size: var(--component-novel-repositories-field-font-size);
    font-weight: var(--component-novel-repositories-strong-font-weight);
    letter-spacing: var(--component-novel-repositories-field-letter-spacing);
    text-transform: uppercase;
    color: var(--component-novel-repositories-field-color);
  }

  .novel-repos-input {
    width: 100%;
    min-width: 0;
    min-height: var(--component-novel-repositories-input-min-height);
    border-radius: var(--component-novel-repositories-control-radius);
    border: var(--component-novel-repositories-input-border);
    background: var(--component-novel-repositories-input-background);
    color: var(--component-novel-repositories-text-color);
    padding: var(--component-novel-repositories-input-padding);
    font-size: var(--component-novel-repositories-body-font-size);
    font-weight: var(--component-novel-repositories-body-font-weight);
  }

  .novel-repos-input:focus {
    outline: none;
    border-color: var(--component-novel-repositories-input-focus-border-color);
    background: var(--component-novel-repositories-input-focus-background);
    box-shadow: var(--component-novel-repositories-input-focus-shadow);
  }

  .novel-repos-list {
    display: grid;
    gap: var(--component-novel-repositories-list-gap);
  }

  .novel-repo-card__identity,
  .novel-repo-card__title-wrap,
  .novel-repo-card__trust-copy,
  .novel-repo-entry__copy {
    min-width: 0;
  }

  .novel-repo-card__title {
    display: block;
    font-size: var(--component-novel-repositories-body-font-size);
    font-weight: var(--component-novel-repositories-title-font-weight);
    color: var(--component-novel-repositories-text-color);
    overflow-wrap: anywhere;
  }

  .novel-repo-card__summary {
    margin: var(--component-novel-repositories-card-summary-margin);
    font-size: var(--component-novel-repositories-scope-font-size);
    line-height: var(--component-novel-repositories-scope-line-height);
  }

  .novel-repo-card__badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--component-novel-repositories-badges-gap);
    margin-top: var(--component-novel-repositories-badges-margin-top);
  }

  .novel-repo-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--component-novel-repositories-badge-gap);
    min-height: var(--component-novel-repositories-badge-min-height);
    padding: var(--component-novel-repositories-badge-padding);
    border-radius: var(--component-novel-repositories-pill-radius);
    font-size: var(--component-novel-repositories-label-font-size);
    font-weight: var(--component-novel-repositories-strong-font-weight);
    letter-spacing: var(--component-novel-repositories-label-letter-spacing);
    text-transform: uppercase;
    border: var(--component-novel-repositories-badge-border);
    background: var(--component-novel-repositories-badge-background);
  }

  .novel-repo-badge[data-variant="ready"],
  .novel-repo-badge[data-variant="installed"],
  .novel-repo-badge[data-variant="trusted"],
  .novel-repo-badge[data-variant="migration-safe"],
  .novel-repo-badge[data-variant="working"],
  .novel-repo-badge[data-variant="success"],
  .novel-repo-badge[data-variant="info"] {
    color: var(--component-novel-repositories-badge-success-color);
    border-color: var(--component-novel-repositories-badge-success-border-color);
    background: var(--component-novel-repositories-badge-success-background);
  }

  .novel-repo-badge[data-variant="untrusted"],
  .novel-repo-badge[data-variant="update-available"],
  .novel-repo-badge[data-variant="unknown"],
  .novel-repo-badge[data-variant="working-with-known-limitations"],
  .novel-repo-badge[data-variant="warning"] {
    color: var(--component-novel-repositories-badge-warning-color);
    border-color: var(--component-novel-repositories-badge-warning-border-color);
  }

  .novel-repo-badge[data-variant="blocked"],
  .novel-repo-badge[data-variant="error"],
  .novel-repo-badge[data-variant="blocked-by-site"],
  .novel-repo-badge[data-variant="runtime-gap"],
  .novel-repo-badge[data-variant="danger"] {
    color: var(--color-error);
    border-color: var(--component-novel-repositories-badge-danger-border-color);
  }

  .novel-repo-badge[data-variant="disabled"],
  .novel-repo-badge[data-variant="available"],
  .novel-repo-badge[data-variant="stale"],
  .novel-repo-badge[data-variant="empty"],
  .novel-repo-badge[data-variant="seed"],
  .novel-repo-badge[data-variant="pending"],
  .novel-repo-badge[data-variant="muted"] {
    color: var(--component-novel-repositories-badge-muted-color);
  }

  .novel-repo-card__metrics,
  .novel-smoke-result__grid {
    display: grid;
    grid-template-columns: var(--component-novel-repositories-metrics-grid-template);
    gap: var(--component-novel-repositories-metrics-gap);
    margin-top: var(--component-novel-repositories-section-margin-top);
    font-size: var(--component-novel-repositories-scope-font-size);
  }

  .novel-repo-card__trust {
    display: grid;
    gap: var(--component-novel-repositories-trust-gap);
    margin-top: var(--component-novel-repositories-section-margin-top);
    padding-top: var(--component-novel-repositories-section-padding-top);
    border-top: var(--component-novel-repositories-trust-border-top);
  }

  .novel-repo-card__catalog-shell {
    margin-top: var(--component-novel-repositories-section-margin-top);
  }

  .novel-repo-card__catalog-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--component-novel-repositories-catalog-toggle-gap);
    width: 100%;
    min-height: var(--component-novel-repositories-catalog-toggle-min-height);
    padding: var(--component-novel-repositories-catalog-toggle-padding);
    border-radius: var(--component-novel-repositories-control-radius);
    border: var(--component-novel-repositories-catalog-toggle-border);
    background: var(--component-novel-repositories-catalog-toggle-background);
    color: var(--component-novel-repositories-catalog-toggle-color);
    font-size: var(--component-novel-repositories-scope-font-size);
    font-weight: var(--component-novel-repositories-strong-font-weight);
    letter-spacing: var(--component-novel-repositories-label-letter-spacing);
    text-transform: uppercase;
    transition: border-color var(--component-novel-repositories-motion-normal) var(--component-novel-repositories-motion-easing), background var(--component-novel-repositories-motion-normal) var(--component-novel-repositories-motion-easing), transform var(--component-novel-repositories-motion-fast) var(--component-novel-repositories-motion-easing);
  }

  .novel-repo-card__catalog-toggle:hover {
    border-color: var(--component-novel-repositories-catalog-toggle-hover-border-color);
    background: var(--component-novel-repositories-catalog-toggle-hover-background);
  }

  .novel-repo-card__catalog-toggle:active {
    transform: var(--component-novel-repositories-catalog-toggle-active-transform);
  }

  .novel-repo-card__catalog {
    margin-top: var(--component-novel-repositories-catalog-margin-top);
  }

  @keyframes novelReposFadeIn {
    from {
      opacity: var(--component-novel-repositories-keyframes-fade-in-from-opacity);
      transform: var(--component-novel-repositories-keyframes-fade-in-from-transform);
    }
    to {
      opacity: var(--component-novel-repositories-keyframes-fade-in-to-opacity);
      transform: var(--component-novel-repositories-keyframes-fade-in-to-transform);
    }
  }

  .novel-repo-entry-list {
    display: grid;
    gap: var(--component-novel-repositories-entry-list-gap);
  }

  .novel-repo-entry {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--component-novel-repositories-entry-gap);
    padding: var(--component-novel-repositories-entry-padding);
    border-radius: var(--component-novel-repositories-control-radius);
    border: var(--component-novel-repositories-entry-border);
    background: var(--component-novel-repositories-entry-background);
  }

  .novel-repo-entry__name {
    display: block;
    font-size: var(--component-novel-repositories-body-font-size);
    font-weight: var(--component-novel-repositories-title-font-weight);
    color: var(--component-novel-repositories-entry-name-color);
  }

  .novel-repo-entry__meta,
  .novel-repo-entry__site {
    display: block;
    font-size: var(--component-novel-repositories-scope-font-size);
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

