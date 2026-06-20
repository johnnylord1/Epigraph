<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { BookOpen } from "phosphor-svelte";

  import { addToast, setActiveNovelDetail, store } from "../../store/state.svelte";
  import { _ } from "../../lib/i18n/runtime";
  import NovelSourceStatusDetails from "../novels/NovelSourceStatusDetails.svelte";
  import { createNovelLibraryId, type InstalledNovelSourceDescriptor, type NovelSourceSearchResult } from "../../lib/novels/domain";
  import { isNovelInLibrary, loadNovelLibraryState, peekNovelLibraryState } from "../../lib/novels/libraryState";
  import {
    getNovelSourceClassificationBadge,
    getNovelSourceClassificationRecord,
    getNovelSourceClassificationSummary,
    loadNovelSourceClassificationState,
    peekNovelSourceClassificationState,
    type PersistedNovelSourceClassificationState,
  } from "../../lib/novels/sourceClassificationState";
  import {
    browseInstalledNovelSource,
    loadTrustedInstalledNovelSources,
    readInstalledNovelDetails,
    searchInstalledNovelSource,
    shutdownInstalledNovelSourcesRuntime,
  } from "../../lib/novels/sources";
  import NocturneState from "../shared/NocturneState.svelte";

  let loadingSources = $state(true);
  let loadingResults = $state(false);
  let panelError = $state<string | null>(null);
  let sources = $state<InstalledNovelSourceDescriptor[]>([]);
  let sourceClassificationState = $state<PersistedNovelSourceClassificationState>(peekNovelSourceClassificationState({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  }));
  let activeSourceId = $state<string | null>(null);
  let lastLoadedScopeKey = $state<string | null>(null);
  let query = $state("");
  let submittedQuery = $state("");
  let results = $state<NovelSourceSearchResult[]>([]);
  let openingDetailPath = $state<string | null>(null);
  let libraryState = $state(peekNovelLibraryState({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  }));

  const scopeInput = $derived({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  });
  const activeSource = $derived(sources.find((entry) => entry.pluginId === activeSourceId) ?? null);
  const activeSourceClassification = $derived(activeSource ? getNovelSourceClassificationRecord(sourceClassificationState, activeSource.pluginId) : null);
  const activeSourceBadge = $derived(getNovelSourceClassificationBadge(activeSourceClassification));
  const sourceFailurePresentation = $derived.by(() => {
    if (!panelError) return null;

    switch (activeSourceClassification?.status) {
      case "blocked-by-site":
        return {
          title: $_("novelSources.errors.blockedTitle"),
          body: store.settings.flareSolverrEnabled
            ? $_("novelSources.errors.blockedFlareEnabled")
            : $_("novelSources.errors.blockedFlareDisabled"),
          primaryAction: null as "browse" | "retry-search" | null,
          secondaryAction: null as "browse" | "retry-search" | null,
        };
      case "runtime-gap":
        return {
          title: $_("novelSources.errors.runtimeGapTitle"),
          body: $_("novelSources.errors.runtimeGapBody"),
          primaryAction: null as "browse" | "retry-search" | null,
          secondaryAction: submittedQuery ? "retry-search" as const : null,
        };
      case "working-with-known-limitations":
        return {
          title: $_("novelSources.errors.partialTitle"),
          body: $_("novelSources.errors.partialBody"),
          primaryAction: "browse" as const,
          secondaryAction: submittedQuery ? "retry-search" as const : null,
        };
      case "pending":
        return {
          title: $_("novelSources.errors.pendingTitle"),
          body: $_("novelSources.errors.pendingBody"),
          primaryAction: null as "browse" | "retry-search" | null,
          secondaryAction: null as "browse" | "retry-search" | null,
        };
      default:
        return {
          title: $_("novelSources.errors.temporaryTitle"),
          body: submittedQuery ? $_("novelSources.errors.temporarySearchBody") : panelError,
          primaryAction: submittedQuery ? "retry-search" as const : "browse" as const,
          secondaryAction: submittedQuery ? "browse" as const : null,
        };
    }
  });

  function classificationForPlugin(pluginId: string) {
    return getNovelSourceClassificationRecord(sourceClassificationState, pluginId);
  }

  function badgeForPlugin(pluginId: string) {
    return getNovelSourceClassificationBadge(classificationForPlugin(pluginId));
  }

  function normalizeNovelSourceError(error: unknown, pluginId: string | null = activeSourceId): string {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    const classification = pluginId ? classificationForPlugin(pluginId) : null;
    const summary = getNovelSourceClassificationSummary(classification);

    if (
      lower.includes("cloudflare")
      || lower.includes("flaresolverr")
      || lower.includes("captcha")
      || lower.includes("anti-bot")
      || lower.includes("redirect")
      || lower.includes("challenge")
      || classification?.status === "blocked-by-site"
    ) {
      return summary ?? (store.settings.flareSolverrEnabled
        ? $_("novelSources.errors.blockedCurrentFlareEnabled")
        : $_("novelSources.errors.blockedFlareDisabled"));
    }

    if (classification?.status === "runtime-gap") {
      return summary ?? $_("novelSources.errors.runtimeGapSummary");
    }

    if (classification?.status === "working-with-known-limitations") {
      return summary ?? $_("novelSources.errors.partialSummary");
    }

    return message;
  }

  async function reloadSources() {
    loadingSources = true;
    panelError = null;
    try {
      const nextSources = await loadTrustedInstalledNovelSources(scopeInput);
      const nextActiveSourceId = nextSources.some((entry) => entry.pluginId === activeSourceId)
        ? activeSourceId
        : null;
      sources = nextSources;
      activeSourceId = nextActiveSourceId;
    } catch (error) {
      panelError = normalizeNovelSourceError(error, activeSourceId);
    } finally {
      loadingSources = false;
    }
  }

  async function runBrowse() {
    if (!activeSourceId) return;
    loadingResults = true;
    panelError = null;
    try {
      submittedQuery = "";
      results = await browseInstalledNovelSource(scopeInput, activeSourceId, 1);
    } catch (error) {
      panelError = normalizeNovelSourceError(error, activeSourceId);
      results = [];
    } finally {
      await shutdownInstalledNovelSourcesRuntime().catch(() => {});
      loadingResults = false;
    }
  }

  async function runSearch() {
    if (!activeSourceId || !query.trim()) return;
    loadingResults = true;
    panelError = null;
    try {
      submittedQuery = query.trim();
      results = await searchInstalledNovelSource(scopeInput, activeSourceId, submittedQuery, 1);
    } catch (error) {
      panelError = normalizeNovelSourceError(error, activeSourceId);
      results = [];
    } finally {
      await shutdownInstalledNovelSourcesRuntime().catch(() => {});
      loadingResults = false;
    }
  }

  async function openDetail(result: NovelSourceSearchResult) {
    if (!activeSourceId) return;
    panelError = null;
    openingDetailPath = result.path;
    try {
      await shutdownInstalledNovelSourcesRuntime().catch(() => {});
      const detail = await readInstalledNovelDetails(scopeInput, activeSourceId, result.path, {
        title: result.title,
        coverUrl: result.coverUrl,
      });
      setActiveNovelDetail({
        novel: detail,
        inLibrary: isNovelInLibrary(libraryState, detail.id),
      });
    } catch (error) {
      const message = normalizeNovelSourceError(error, activeSourceId);
      panelError = message;
      addToast({
        kind: "error",
        title: $_("novelSources.errors.openDetailTitle"),
        body: message,
      });
    } finally {
      openingDetailPath = null;
    }
  }

  $effect(() => {
    const scopeKey = `${store.runtimeResolvedLocalProfileId ?? ""}::${store.runtimeServerUrl ?? ""}`;
    if (scopeKey === lastLoadedScopeKey) return;
    lastLoadedScopeKey = scopeKey;
    untrack(() => {
      void loadNovelLibraryState(scopeInput).then((state) => {
        libraryState = state;
      });
      void loadNovelSourceClassificationState(scopeInput).then((state) => {
        sourceClassificationState = state;
      });
      void reloadSources();
    });
  });

  onDestroy(() => {
    void shutdownInstalledNovelSourcesRuntime();
  });
</script>

<div class="splitRoot">
  <div class="splitSidebar">
    {#if loadingSources}
      <div class="splitEmpty">
        <NocturneState layout="compact" tone="info" icon="retry" eyebrow={$_("novelSources.eyebrow")} title={$_("novelSources.loading.sources")} />
      </div>
    {:else if sources.length === 0}
      <div class="splitEmpty">
        <NocturneState
          layout="compact"
          tone="info"
          icon="plug"
          eyebrow={$_("novelSources.eyebrow")}
          title={$_("novelSources.empty.noTrustedTitle")}
          body={$_("novelSources.empty.noTrustedBody")}
        />
      </div>
    {:else}
      <div class="splitList">
        {#each sources as source (source.pluginId)}
          {@const sourceClassification = classificationForPlugin(source.pluginId)}
          {@const sourceBadge = badgeForPlugin(source.pluginId)}
          <div class="splitItemRow" class:splitItemActive={source.pluginId === activeSourceId}>
            <button
              type="button"
              class="splitItem"
              onclick={() => {
                activeSourceId = source.pluginId;
                results = [];
                submittedQuery = "";
                panelError = null;
              }}
            >
              <span class="splitItemLabel">{source.name}</span>
              <span class="splitItemMeta">{source.lang.toUpperCase()}</span>
            </button>
            <NovelSourceStatusDetails
              pluginName={source.name}
              record={sourceClassification}
              badge={sourceBadge}
              contextLabel={$_("novelSources.sourceStatus")}
            />
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="splitContent">
    {#if !activeSource}
      <div class="empty">
        <NocturneState
          layout="center"
          tone="info"
          icon="books"
          eyebrow={$_("novelSources.eyebrow")}
          title={$_("novelSources.empty.browseSourceTitle")}
          body={$_("novelSources.empty.browseSourceBody")}
        />
      </div>
    {:else}
      <div class="splitContentHeader">
        <div class="splitSourceTitle">
          <span class="splitContentTitle">{activeSource.name}</span>
          <span class="sourceLang">{activeSource.lang.toUpperCase()}</span>
          <NovelSourceStatusDetails
            pluginName={activeSource.name}
            record={activeSourceClassification}
            badge={activeSourceBadge}
            contextLabel={$_("novelSources.sourceStatus")}
          />
        </div>
        <button class="mini-btn mini-btnGhost" type="button" onclick={reloadSources} disabled={loadingSources}>
          {$_("novelSources.actions.reload")}
        </button>
      </div>

      <div class="sourceBrowseBar">
        <div class="searchBar" style="flex:1">
          <span class="searchGlyph" aria-hidden="true">search</span>
          <input
            bind:value={query}
            class="searchInput"
            placeholder={$_("novelSources.search.placeholder", { source: activeSource.name })}
            onkeydown={(event) => event.key === "Enter" && runSearch()}
          />
          {#if query}
            <button class="clearBtn" type="button" onclick={() => { query = ""; submittedQuery = ""; results = []; panelError = null; }}>&times;</button>
          {/if}
        </div>
        <button class="showMoreBtn" type="button" onclick={runBrowse} disabled={loadingResults}>{$_("novelSources.actions.browse")}</button>
        <button class="searchBtn" type="button" onclick={runSearch} disabled={loadingResults || !query.trim()}>{$_("novelSources.actions.search")}</button>
      </div>

      {#if panelError}
        <div class="splitEmpty splitEmptyError splitEmptyError--nocturne">
          <NocturneState
            layout="compact"
            tone="danger"
            icon="warning"
            eyebrow={$_("novelSources.errors.requestEyebrow")}
            title={sourceFailurePresentation?.title ?? $_("novelSources.errors.requestFailedTitle")}
            body={sourceFailurePresentation?.body ?? panelError}
            actions={[
              ...(sourceFailurePresentation?.primaryAction === "browse" ? [{ label: $_("novelSources.actions.browseInstead"), kind: "primary" as const, icon: "books" as const, disabled: loadingResults, onClick: runBrowse }] : []),
              ...(sourceFailurePresentation?.primaryAction === "retry-search" ? [{ label: $_("novelSources.actions.retrySearch"), kind: "primary" as const, icon: "retry" as const, disabled: loadingResults || !submittedQuery, onClick: runSearch }] : []),
              ...(sourceFailurePresentation?.secondaryAction === "browse" ? [{ label: $_("novelSources.actions.browseInstead"), kind: "secondary" as const, icon: "books" as const, disabled: loadingResults, onClick: runBrowse }] : []),
              ...(sourceFailurePresentation?.secondaryAction === "retry-search" ? [{ label: $_("novelSources.actions.retrySearch"), kind: "secondary" as const, icon: "retry" as const, disabled: loadingResults || !submittedQuery, onClick: runSearch }] : []),
            ]}
          />
          <NovelSourceStatusDetails
            pluginName={activeSource.name}
            record={activeSourceClassification}
            badge={activeSourceBadge}
            contextLabel={$_("novelSources.sourceStatus")}
          />
        </div>
      {:else if openingDetailPath}
        <div class="splitEmpty">
          <NocturneState layout="compact" tone="info" icon="books" eyebrow={$_("novelSources.eyebrow")} title={$_("novelSources.loading.openingDetails")} />
        </div>
      {/if}

      {#if loadingResults}
        <div class="splitEmpty">
          <NocturneState layout="center" tone="info" icon="retry" eyebrow={$_("novelSources.eyebrow")} title={$_("novelSources.loading.titles")} />
        </div>
      {:else if results.length > 0}
        <div class="tagGrid">
          {#each results as result (result.path)}
            <button class="card" type="button" disabled={openingDetailPath !== null} onclick={() => openDetail(result)}>
              <div class="coverWrap">
                {#if result.coverUrl}
                  <img src={result.coverUrl} alt={result.title} class="cover" loading="lazy" />
                {:else}
                  <div class="coverFallback"><BookOpen size={28} weight="duotone" /></div>
                {/if}
                {#if isNovelInLibrary(libraryState, createNovelLibraryId(result.sourceId, result.path))}
                  <span class="inLibBadge">{$_("novelSources.status.saved")}</span>
                {/if}
              </div>
              <p class="cardTitle">{result.title}</p>
              {#if openingDetailPath === result.path}
                <span class="sourceLang">{$_("novelSources.loading.opening")}</span>
              {/if}
            </button>
          {/each}
        </div>
      {:else}
        <div class="empty">
          <NocturneState
            layout="center"
            tone="info"
            icon="search"
            eyebrow={$_("novelSources.eyebrow")}
            title={submittedQuery ? $_("novelSources.empty.noResults", { query: submittedQuery }) : $_("novelSources.empty.browseOrSearchTitle")}
            body={submittedQuery
              ? $_("novelSources.empty.noResultsBody")
              : $_("novelSources.empty.browseOrSearchBody")}
          />
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .splitRoot {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .splitSidebar {
    width: 250px;
    flex-shrink: 0;
    border-right: 1px solid var(--border-dim);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .splitContentHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--border-dim);
  }

  .splitContent {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .splitContentHeader,
  .sourceBrowseBar,
  .splitSourceTitle {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

  .splitContentHeader {
    justify-content: space-between;
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--border-dim);
  }

  .splitSourceTitle {
    min-width: 0;
    flex-wrap: wrap;
  }

  .sourceBrowseBar {
    padding: var(--sp-2) var(--sp-4);
    border-bottom: 1px solid var(--border-dim);
  }

  .searchBar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex: 1;
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
    border-radius: var(--radius-md);
    padding: 0 var(--sp-3);
  }

  .searchGlyph {
    font-family: "Material Symbols Outlined", sans-serif;
    font-size: 15px;
    color: var(--text-faint);
    user-select: none;
    flex-shrink: 0;
  }

  .searchInput {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-size: var(--text-sm);
    padding: 8px 0;
  }

  .splitList {
    flex: 1;
    overflow-y: auto;
    padding: var(--sp-2);
  }

  .splitItemRow {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
  }

  .splitItem {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex: 1;
    min-width: 0;
    padding: 9px var(--sp-3);
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    background: none;
    text-align: left;
    transition: background var(--t-base), border-color var(--t-base);
  }

  .splitItem:hover {
    background: var(--bg-raised);
    border-color: var(--border-dim);
  }

  .splitItemActive {
    background: var(--accent-muted);
    border-color: var(--accent-dim);
  }

  .splitItemLabel,
  .splitContentTitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .splitItemLabel {
    flex: 1;
    min-width: 0;
  }

  .splitItemMeta {
    flex-shrink: 0;
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    color: var(--text-faint);
    text-transform: uppercase;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    text-align: left;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  .card:hover .cover {
    filter: brightness(1.06);
  }

  .card:hover .cardTitle {
    color: var(--text-primary);
  }

  .coverWrap {
    position: relative;
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
    transform: translateZ(0);
  }

  .cover,
  .coverFallback {
    width: 100%;
    height: 100%;
  }

  .cover {
    object-fit: cover;
    transition: filter var(--t-base);
    will-change: filter;
  }

  .coverFallback,
  .splitEmpty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
  }

  .coverFallback,
  .splitEmpty {
    flex-direction: column;
    gap: var(--sp-2);
  }

  .splitEmpty {
    flex: 1;
    text-align: center;
    padding: var(--sp-5);
  }

  .cardTitle,
  .sourceLang,
  .inLibBadge {
    font-family: var(--font-ui);
  }

  .cardTitle {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: var(--leading-snug);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    transition: color var(--t-base);
  }

  .splitEmptyError {
    color: var(--color-error);
    align-items: flex-start;
    justify-content: flex-start;
    text-align: left;
  }

  .clearBtn,
  .mini-btn,
  .searchBtn,
  .showMoreBtn,
  .splitItem,
  .card {
    cursor: pointer;
  }

  .searchBtn,
  .showMoreBtn,
  .mini-btn {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    padding: 6px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
    color: var(--text-muted);
  }

  .searchBtn {
    background: var(--accent-muted);
    color: var(--accent-fg);
    border-color: var(--accent-dim);
  }

  .mini-btnGhost {
    background: transparent;
  }

  .searchBtn:hover:not(:disabled),
  .showMoreBtn:hover:not(:disabled),
  .mini-btn:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--border-strong);
    background: var(--bg-raised);
  }

  .searchBtn:disabled,
  .showMoreBtn:disabled,
  .mini-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .inLibBadge {
    position: absolute;
    bottom: var(--sp-1);
    right: var(--sp-1);
    background: var(--accent-dim);
    color: var(--accent-fg);
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
