<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { BookOpen } from "phosphor-svelte";

  import { addToast, setActiveNovelDetail, store } from "../../store/state.svelte";
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
          title: "Source blocked",
          body: "This site is rejecting automated requests right now.",
          primaryAction: null as "browse" | "retry-search" | null,
          secondaryAction: null as "browse" | "retry-search" | null,
        };
      case "runtime-gap":
        return {
          title: "Source not fully supported",
          body: "This extension needs runtime behavior Aethon does not fully cover yet.",
          primaryAction: null as "browse" | "retry-search" | null,
          secondaryAction: submittedQuery ? "retry-search" as const : null,
        };
      case "working-with-known-limitations":
        return {
          title: "Partial source",
          body: "Try Browse or a shorter search term.",
          primaryAction: "browse" as const,
          secondaryAction: submittedQuery ? "retry-search" as const : null,
        };
      case "pending":
        return {
          title: "Source still being checked",
          body: "The automatic source check has not finished yet.",
          primaryAction: null as "browse" | "retry-search" | null,
          secondaryAction: null as "browse" | "retry-search" | null,
        };
      default:
        return {
          title: "Temporary source failure",
          body: submittedQuery ? "Try the search again or switch to Browse for this source." : panelError,
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
      || lower.includes("anti-bot")
      || lower.includes("redirect")
      || lower.includes("challenge")
      || classification?.status === "blocked-by-site"
    ) {
      return summary ?? "This source is currently blocked by its own site behavior, such as redirect or anti-bot protection.";
    }

    if (classification?.status === "runtime-gap") {
      return summary ?? "This source still depends on runtime features that Aethon does not fully cover yet.";
    }

    if (classification?.status === "working-with-known-limitations") {
      return summary ?? "This source works with known limitations. Try Browse or a shorter search query.";
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
        title: "Could not open novel details",
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
      <div class="splitLoading">Loading sources...</div>
    {:else if sources.length === 0}
      <div class="splitEmpty">Install and trust at least one LNReader novel extension in Settings first.</div>
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
              contextLabel="Source status"
            />
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="splitContent">
    {#if !activeSource}
      <div class="empty">
        <BookOpen size={32} weight="duotone" />
        <p class="emptyText">Browse a source</p>
        <p class="emptyHint">Select a source to see its popular titles, or search within it.</p>
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
            contextLabel="Source status"
          />
        </div>
        <button class="mini-btn mini-btnGhost" type="button" onclick={reloadSources} disabled={loadingSources}>
          Reload
        </button>
      </div>

      <div class="sourceBrowseBar">
        <div class="searchBar" style="flex:1">
          <span class="searchGlyph" aria-hidden="true">search</span>
          <input
            bind:value={query}
            class="searchInput"
            placeholder={`Search ${activeSource.name}...`}
            onkeydown={(event) => event.key === "Enter" && runSearch()}
          />
          {#if query}
            <button class="clearBtn" type="button" onclick={() => { query = ""; submittedQuery = ""; results = []; panelError = null; }}>&times;</button>
          {/if}
        </div>
        <button class="showMoreBtn" type="button" onclick={runBrowse} disabled={loadingResults}>Browse</button>
        <button class="searchBtn" type="button" onclick={runSearch} disabled={loadingResults || !query.trim()}>Search</button>
      </div>

      {#if panelError}
        <div class="splitEmpty splitEmptyError">
          <strong>{sourceFailurePresentation?.title ?? "Source request failed"}</strong>
          <span>{sourceFailurePresentation?.body ?? panelError}</span>
          <div class="splitErrorActions">
            {#if sourceFailurePresentation?.primaryAction === "browse"}
              <button class="mini-btn" type="button" onclick={runBrowse} disabled={loadingResults}>Browse instead</button>
            {:else if sourceFailurePresentation?.primaryAction === "retry-search"}
              <button class="mini-btn" type="button" onclick={runSearch} disabled={loadingResults || !submittedQuery}>Retry search</button>
            {/if}
            {#if sourceFailurePresentation?.secondaryAction === "browse"}
              <button class="mini-btn" type="button" onclick={runBrowse} disabled={loadingResults}>Browse instead</button>
            {:else if sourceFailurePresentation?.secondaryAction === "retry-search"}
              <button class="mini-btn" type="button" onclick={runSearch} disabled={loadingResults || !submittedQuery}>Retry search</button>
            {/if}
          </div>
          <NovelSourceStatusDetails
            pluginName={activeSource.name}
            record={activeSourceClassification}
            badge={activeSourceBadge}
            contextLabel="Source status"
          />
        </div>
      {:else if openingDetailPath}
        <div class="splitLoading">Opening novel details...</div>
      {/if}

      {#if loadingResults}
        <div class="splitLoading">Loading...</div>
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
                  <span class="inLibBadge">Saved</span>
                {/if}
              </div>
              <p class="cardTitle">{result.title}</p>
              {#if openingDetailPath === result.path}
                <span class="sourceLang">Opening...</span>
              {/if}
            </button>
          {/each}
        </div>
      {:else}
        <div class="empty">
          <p class="emptyText">
            {submittedQuery ? `No results for "${submittedQuery}"` : "Browse or search this source"}
          </p>
          <p class="emptyHint">
            {submittedQuery
              ? "This source may search better with shorter terms, fewer spaces, or no accents. Aethon already retries normalized variations automatically."
              : "Use Browse for popular titles or Search for a specific novel."}
          </p>
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
  .splitSourceTitle,
  .splitErrorActions {
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
  .splitLoading,
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

  .splitLoading,
  .splitEmpty {
    flex: 1;
    text-align: center;
    padding: var(--sp-5);
  }

  .cardTitle,
  .emptyText,
  .emptyHint,
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

  .splitLoading,
  .splitEmptyError {
    color: var(--color-error);
    align-items: flex-start;
    justify-content: flex-start;
    text-align: left;
  }

  .splitErrorActions {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
    margin-top: var(--sp-1);
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
