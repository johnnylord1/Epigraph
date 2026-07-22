<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import {
    ArrowRight,
    BookOpen,
    Check,
    CircleNotch,
    MagnifyingGlass,
    StackSimple,
    Warning,
    X,
  } from "phosphor-svelte";
  import { onMount } from "svelte";

  import { addToast, store } from "../../store/state.svelte";
  import type { ActiveNovelDetailState, InstalledNovelSourceDescriptor, NovelDetailRecord, NovelSourceSearchResult } from "../../lib/novels/domain";
  import {
    loadTrustedInstalledNovelSources,
    readInstalledNovelDetails,
    searchInstalledNovelSource,
  } from "../../lib/novels/sources";
  import {
    buildNovelDetailRecordFromLibrary,
    getNovelLibraryChapters,
    getNovelLibraryEntry,
    loadNovelLibraryState,
  } from "../../lib/novels/libraryState";
  import {
    applyMassNovelMigrationWithJournal,
    applyNovelMigrationWithJournal,
    previewMassNovelMigration,
    previewNovelMigration,
    undoNovelMigration,
    type MassNovelMigrationPreview,
    type NovelMigrationPreview,
  } from "../../lib/migration/novels";
  import { setMigrationPresence } from "../../lib/discord";
  import { loadNovelSourceClassificationState, peekNovelSourceClassificationState, type PersistedNovelSourceClassificationState } from "../../lib/novels/sourceClassificationState";
  import NocturneState from "../shared/NocturneState.svelte";
  import { getNovelMigrationBlocker, hasMinimumNovelMigrationSafeCohort, isNovelSourceMigrationSafe } from "../../lib/novels/migrationSafe";
  import { createDialogFocusBoundary } from "../../lib/accessibility/dialogFocus";

  interface Props {
    active: ActiveNovelDetailState;
    onClose: () => void;
    onMigrated: (next: ActiveNovelDetailState) => void;
  }

  let { active, onClose, onMigrated }: Props = $props();

  type MigrationMode = "single" | "mass";
  type Step = "source" | "search" | "confirm" | "mass-preview";

  let mode = $state<MigrationMode>("single");
  let step = $state<Step>("source");
  let loadingSources = $state(true);
  let searching = $state(false);
  let migrating = $state(false);
  let massPreviewLoading = $state(false);
  let error = $state<string | null>(null);
  let sources = $state<InstalledNovelSourceDescriptor[]>([]);
  let sourceClassificationState = $state<PersistedNovelSourceClassificationState>(peekNovelSourceClassificationState({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  }));
  let selectedSource = $state<InstalledNovelSourceDescriptor | null>(null);
  let query = $state("");
  let results = $state<NovelSourceSearchResult[]>([]);
  let selectedTarget = $state<NovelDetailRecord | null>(null);
  let preview = $state<NovelMigrationPreview | null>(null);
  let massPreview = $state<MassNovelMigrationPreview | null>(null);
  let massSelectedIds = $state<Set<string>>(new Set());
  let overlayEl: HTMLDivElement | undefined = $state();
  let modalEl: HTMLDivElement | undefined = $state();
  let closeButtonEl: HTMLButtonElement | undefined = $state();

  const scopeInput = $derived({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  });
  const migrationCohortReady = $derived(hasMinimumNovelMigrationSafeCohort(sourceClassificationState));
  const cohortBlocker = $derived.by(() => {
    if (!migrationCohortReady) {
      return "Novel migration stays disabled until a small migration-safe LNReader cohort is fully proven on search, details, and chapter.";
    }
    return null;
  });

  async function reloadSources() {
    loadingSources = true;
    error = null;
    try {
      const installed = await loadTrustedInstalledNovelSources(scopeInput);
      sources = installed.filter((source) => (
        source.pluginId !== active.novel.sourceId
        && isNovelSourceMigrationSafe(source.pluginId, sourceClassificationState)
      ));
      selectedSource = sources[0] ?? null;
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : String(loadError);
    } finally {
      loadingSources = false;
    }
  }

  function setMode(nextMode: MigrationMode) {
    mode = nextMode;
    step = "source";
    error = null;
    results = [];
    selectedTarget = null;
    preview = null;
    massPreview = null;
    massSelectedIds = new Set();
    query = active.novel.title;
  }

  async function runSearch() {
    if (!selectedSource || !query.trim()) return;
    searching = true;
    error = null;
    results = [];
    try {
      results = await searchInstalledNovelSource(scopeInput, selectedSource.pluginId, query.trim(), 1);
      step = "search";
    } catch (searchError) {
      error = searchError instanceof Error ? searchError.message : String(searchError);
    } finally {
      searching = false;
    }
  }

  async function pickResult(result: NovelSourceSearchResult) {
    if (!selectedSource) return;
    error = null;
    try {
      const detail = await readInstalledNovelDetails(scopeInput, selectedSource.pluginId, result.path, {
        title: result.title,
        coverUrl: result.coverUrl,
      });
      selectedTarget = detail;
      preview = await previewNovelMigration({
        scopeInput,
        currentNovelId: active.novel.id,
        targetDetail: detail,
      });
      step = "confirm";
    } catch (detailError) {
      error = detailError instanceof Error ? detailError.message : String(detailError);
    }
  }

  async function buildMassPreview() {
    if (!selectedSource) return;
    massPreviewLoading = true;
    error = null;
    massPreview = null;
    massSelectedIds = new Set();
    try {
      const state = await loadNovelLibraryState(scopeInput);
      const novelIds = state.entries
        .filter((entry) => (entry.source?.sourceId ?? entry.source?.pluginId) === active.novel.sourceId)
        .map((entry) => entry.id);

      const nextPreview = await previewMassNovelMigration({
        scopeInput,
        sourceFrom: active.novel.sourceId,
        sourceTo: selectedSource.pluginId,
        novelIds,
      });

      massPreview = nextPreview;
      massSelectedIds = new Set(
        nextPreview.items
          .filter((item) => item.status === "ready")
          .map((item) => item.currentNovelId),
      );
      step = "mass-preview";
    } catch (previewError) {
      error = previewError instanceof Error ? previewError.message : String(previewError);
    } finally {
      massPreviewLoading = false;
    }
  }

  function toggleMassSelection(novelId: string) {
    const next = new Set(massSelectedIds);
    if (next.has(novelId)) next.delete(novelId);
    else next.add(novelId);
    massSelectedIds = next;
  }

  async function applyMigration() {
    if (!selectedTarget) return;
    migrating = true;
    error = null;
    void setMigrationPresence(true, store.settings, "library");
    try {
      const result = await applyNovelMigrationWithJournal({
        scopeInput,
        currentNovelId: active.novel.id,
        targetDetail: selectedTarget,
      });

      addToast({
        kind: "success",
        title: translate("ui_novelMigrated"),
        body: `${active.novel.title} moved to ${selectedSource?.name ?? translate("ui_theNewSource")}.`,
        duration: 7000,
        action: {
          label: translate("ui_undo"),
          run: () => {
            void undoNovelMigration({
              scopeInput,
              journalEntryId: result.journalEntryId,
            }).then(async (state) => {
              const restoredEntry = getNovelLibraryEntry(state, active.novel.id);
              const restoredChapters = getNovelLibraryChapters(state, active.novel.id);
              if (!restoredEntry) {
                throw new Error("The original novel could not be restored.");
              }
              onMigrated({
                novel: buildNovelDetailRecordFromLibrary(restoredEntry, restoredChapters),
                inLibrary: true,
              });
              addToast({
                kind: "info",
                title: translate("ui_migrationUndone"),
                body: active.novel.title,
              });
            }).catch((undoError) => {
              addToast({
                kind: "error",
                title: translate("ui_couldNotUndoMigration"),
                body: undoError instanceof Error ? undoError.message : String(undoError),
              });
            });
          },
        },
      });

      onMigrated({
        novel: selectedTarget,
        inLibrary: true,
      });
    } catch (migrationError) {
      error = migrationError instanceof Error ? migrationError.message : String(migrationError);
      migrating = false;
    } finally {
      void setMigrationPresence(false, store.settings, "library");
    }
  }

  async function applyMassMigration() {
    if (!massPreview) return;
    migrating = true;
    error = null;
    void setMigrationPresence(true, store.settings, "library");
    try {
      const result = await applyMassNovelMigrationWithJournal({
        scopeInput,
        preview: massPreview,
        selectedNovelIds: [...massSelectedIds],
      });

      addToast({
        kind: "success",
        title: translate("ui_massMigrationApplied"),
        body: `${result.migratedCount} novel${result.migratedCount !== 1 ? "s" : ""} moved to ${selectedSource?.name ?? translate("ui_theNewSource")}.`,
        duration: 9000,
        action: {
          label: translate("ui_undo"),
          run: () => {
            void undoNovelMigration({
              scopeInput,
              journalEntryId: result.journalEntryId,
            }).then((state) => {
              const restoredEntry = getNovelLibraryEntry(state, active.novel.id);
              const restoredChapters = getNovelLibraryChapters(state, active.novel.id);
              if (restoredEntry) {
                onMigrated({
                  novel: buildNovelDetailRecordFromLibrary(restoredEntry, restoredChapters),
                  inLibrary: true,
                });
              } else {
                onClose();
              }
              addToast({
                kind: "info",
                title: translate("ui_massMigrationUndone"),
                body: `${result.migratedCount} novel${result.migratedCount !== 1 ? "s" : ""}`,
              });
            }).catch((undoError) => {
              addToast({
                kind: "error",
                title: translate("ui_couldNotUndoMassMigration"),
                body: undoError instanceof Error ? undoError.message : String(undoError),
              });
            });
          },
        },
      });

      const currentItem = massPreview.items.find((item) => (
        item.currentNovelId === active.novel.id
        && item.match
        && massSelectedIds.has(item.currentNovelId)
      ));
      if (currentItem?.match) {
        onMigrated({
          novel: currentItem.match.detail,
          inLibrary: true,
        });
      } else {
        onClose();
      }
    } catch (massError) {
      error = massError instanceof Error ? massError.message : String(massError);
      migrating = false;
    } finally {
      void setMigrationPresence(false, store.settings, "library");
    }
  }

  $effect(() => {
    void loadNovelSourceClassificationState(scopeInput).then((state) => {
      sourceClassificationState = state;
    });
  });

  $effect(() => {
    sourceClassificationState.updatedAtMs;
    void reloadSources();
  });

  $effect(() => {
    if (step === "source") {
      query = active.novel.title;
    }
  });

  onMount(() => {
    if (!overlayEl || !modalEl) return;
    return createDialogFocusBoundary({
      dialog: modalEl,
      isolationRoot: overlayEl,
      initialFocus: closeButtonEl,
    });
  });
</script>

<div bind:this={overlayEl} class="overlay">
  <button class="backdrop" type="button" aria-label={$_("ui_closeMigrationModal")} onclick={onClose}></button>
  <div bind:this={modalEl} class="modal" role="dialog" aria-modal="true" aria-label={$_("ui_migrateNovel")} tabindex="-1">
    <div class="modal-header">
      <div class="modal-title">
        <span class="modal-title-label">{$_("ui_migrateNovel")}</span>
        <span class="modal-title-name">{active.novel.title}</span>
      </div>
      <button bind:this={closeButtonEl} class="close-btn" type="button" onclick={onClose} aria-label={$_("ui_closeMigrationModal")}><X size={14} weight="light" /></button>
    </div>

    {#if cohortBlocker}
      <div class="notice">
        <Warning size={14} weight="light" />
        <span>{cohortBlocker}</span>
      </div>
    {:else}
      <div class="body">
        <div class="mode-tabs">
          <button class="mode-tab" class:mode-tab-active={mode === "single"} type="button" onclick={() => setMode("single")}>
            {$_("ui_single")}
          </button>
          <button class="mode-tab" class:mode-tab-active={mode === "mass"} type="button" onclick={() => setMode("mass")}>
            <StackSimple size={12} weight="bold" />
            {$_("ui_mass")}
          </button>
        </div>

        {#if step === "source"}
          <div class="section">
            {#if mode === "single"}
              <div class="search-bar">
                <input
                  bind:value={query}
                  class="search-input"
                  placeholder={$_("ui_searchTitle_276e2d1e")}
                  onkeydown={(event) => event.key === "Enter" && runSearch()}
                />
                <button class="search-btn" type="button" disabled={searching || !selectedSource || !query.trim()} onclick={runSearch}>
                  {#if searching}
                    <CircleNotch size={13} weight="light" class="anim-spin" />
                  {:else}
                    <MagnifyingGlass size={12} weight="bold" />
                  {/if}
                  {$_("novelSources_actions_search")}
                </button>
              </div>
            {:else}
              <div class="notice inline">
                <StackSimple size={14} weight="light" />
                <span>{$_("ui_thisPreviewsAllLibraryNovelsFromTheCurrent")}</span>
              </div>
            {/if}

            {#if loadingSources}
              <div class="centered"><CircleNotch size={16} weight="light" class="anim-spin" /></div>
            {:else if sources.length === 0}
              <div class="notice">
                <Warning size={14} weight="light" />
                <span>{$_("ui_noInstalledTrustedNovelSourceIsMarkedMigration")}</span>
              </div>
            {:else}
              <div class="source-list">
                {#each sources as source (source.pluginId)}
                  <button
                    class="source-row"
                    class:source-row-active={selectedSource?.pluginId === source.pluginId}
                    type="button"
                    onclick={() => selectedSource = source}
                  >
                    <div class="source-info">
                      <span class="source-name">{source.name}</span>
                      <span class="source-meta">{source.lang.toUpperCase()}</span>
                    </div>
                    <ArrowRight size={13} weight="light" />
                  </button>
                {/each}
              </div>
              {#if mode === "mass" && selectedSource}
                <div class="actions-row">
                  <button class="search-btn primary" type="button" disabled={massPreviewLoading} onclick={buildMassPreview}>
                    {#if massPreviewLoading}
                      <CircleNotch size={13} weight="light" class="anim-spin" />
                    {:else}
                      <StackSimple size={13} weight="bold" />
                    {/if}
                    {$_("ui_previewMassMigration")}
                  </button>
                </div>
              {/if}
            {/if}
          </div>
        {:else if step === "search"}
          <div class="section">
            <button class="back-btn" type="button" onclick={() => step = "source"}>{$_("ui_back")}</button>
            {#if error}
              <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Migration" title={$_("ui_searchFailed")} body={error} />
            {/if}
            <div class="results">
              {#each results as result (result.path)}
                <button class="result-row" type="button" onclick={() => pickResult(result)}>
                  <div class="result-cover">
                    {#if result.coverUrl}
                      <img src={result.coverUrl} alt={result.title} />
                    {:else}
                      <div class="cover-fallback"><BookOpen size={22} weight="duotone" /></div>
                    {/if}
                  </div>
                  <div class="result-info">
                    <span class="result-title">{result.title}</span>
                    <span class="source-meta">{result.path}</span>
                  </div>
                  <ArrowRight size={13} weight="light" />
                </button>
              {/each}
            </div>
          </div>
        {:else if step === "mass-preview" && massPreview}
          <div class="section">
            <button class="back-btn" type="button" onclick={() => step = "source"} disabled={migrating}>{$_("ui_back")}</button>
            <div class="stats">
              <div class="stat-row"><span>{$_("ui_ready")}</span><strong>{massPreview.readyCount}</strong></div>
              <div class="stat-row"><span>{$_("ui_needsReview_33a506cf")}</span><strong>{massPreview.needsReviewCount}</strong></div>
              <div class="stat-row"><span>{$_("ui_blocked_99613c74")}</span><strong>{massPreview.blockedCount}</strong></div>
              <div class="stat-row"><span>{$_("ui_selectedToApply")}</span><strong>{massSelectedIds.size}</strong></div>
            </div>
            {#if error}
              <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Migration" title={$_("ui_massMigrationFailed")} body={error} />
            {/if}
            <div class="results">
              {#each massPreview.items as item (item.currentNovelId)}
                <div class="result-row" class:result-row-ready={item.status === "ready"} class:result-row-blocked={item.status === "blocked"}>
                  <button
                    class="mass-check"
                    type="button"
                    disabled={item.status !== "ready"}
                    onclick={() => toggleMassSelection(item.currentNovelId)}
                  >
                    {#if massSelectedIds.has(item.currentNovelId)}<Check size={12} weight="bold" />{/if}
                  </button>
                  <div class="result-info">
                    <span class="result-title">{item.currentTitle}</span>
                    <span class="source-meta">
                      {item.status}
                      {#if item.match}
                        {" · "}
                        {item.match.detail.title}
                        {" · "}
                        {Math.round(item.match.similarity * 100)}{$_("ui_match")}{:else}
                        {" · "}
                        {item.reasonCode}
                      {/if}
                    </span>
                    {#if item.preview}
                      <span class="source-meta">
                        {item.preview.matchedChapterCount} {$_("ui_matchedChapters")} {item.preview.transferredReadCount} {$_("ui_readCarried")} {item.preview.transferredBookmarkCount} {$_("ui_bookmarksCarried")}
                      </span>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
            <div class="actions-row">
              <button class="search-btn primary" type="button" disabled={migrating || massSelectedIds.size === 0} onclick={applyMassMigration}>
                {#if migrating}
                  <CircleNotch size={13} weight="light" class="anim-spin" />
                {:else}
                  <StackSimple size={13} weight="bold" />
                {/if}
                {$_("ui_applyReadyItems")}
              </button>
            </div>
          </div>
        {:else if selectedTarget && preview}
          <div class="section confirm">
            <button class="back-btn" type="button" onclick={() => step = "search"} disabled={migrating}>{$_("ui_back")}</button>
            <div class="compare">
              <div class="compare-card">
                <span class="source-name">{active.novel.title}</span>
                <span class="source-meta">{active.novel.source.sourceName ?? active.novel.source.pluginName ?? $_("ui_currentSource")}</span>
              </div>
              <ArrowRight size={16} weight="light" />
              <div class="compare-card">
                <span class="source-name">{selectedTarget.title}</span>
                <span class="source-meta">{selectedSource?.name ?? $_("ui_targetSource")}</span>
              </div>
            </div>
            <div class="stats">
              <div class="stat-row"><span>{$_("ui_titleConfidence")}</span><strong>{Math.round(preview.confidence * 100)}%</strong></div>
              <div class="stat-row"><span>{$_("ui_matchedChapters_ff5d3901")}</span><strong>{preview.matchedChapterCount}</strong></div>
              <div class="stat-row"><span>{$_("ui_readStateTransferred")}</span><strong>{preview.transferredReadCount}</strong></div>
              <div class="stat-row"><span>{$_("ui_bookmarksTransferred")}</span><strong>{preview.transferredBookmarkCount}</strong></div>
              <div class="stat-row"><span>{$_("ui_chapterDiff")}</span><strong>{preview.chapterDiff > 0 ? `+${preview.chapterDiff}` : preview.chapterDiff}</strong></div>
            </div>
            {#if preview.confidence < 0.5}
              <NocturneState layout="compact" tone="warning" icon="warning" eyebrow="Migration" title={$_("ui_lowConfidenceMatch")} body="Review carefully before replacing the source." />
            {/if}
            <div class="notice inline">
              <Check size={14} weight="light" />
              <span>{$_("ui_theOldNovelWillBeReplaceHiddenThrough")}</span>
            </div>
            {#if error}
              <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Migration" title={$_("ui_migrationFailed")} body={error} />
            {/if}
            <div class="actions-row">
              <button class="search-btn primary" type="button" disabled={migrating} onclick={applyMigration}>
                {#if migrating}
                  <CircleNotch size={13} weight="light" class="anim-spin" />
                {:else}
                  <Check size={12} weight="bold" />
                {/if}
                {$_("detail_actions_migrate")}
              </button>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: var(--component-migration-overlay-z-index); }
  .backdrop { position: absolute; inset: 0; border: none; background: var(--component-migration-overlay-bg); backdrop-filter: var(--component-migration-overlay-blur); cursor: pointer; }
  .modal { position: relative; width: var(--component-novel-migrate-modal-width); max-height: var(--component-novel-migrate-modal-max-height); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--component-migration-modal-border); border-radius: var(--component-migration-modal-radius); background: var(--component-migration-modal-bg); box-shadow: var(--component-migration-modal-shadow); z-index: var(--component-novel-migrate-modal-z-index); animation: scaleIn var(--component-migration-animation-scale) both; }
  .modal-header { display: flex; align-items: flex-start; justify-content: space-between; padding: var(--component-migrate-modal-header-padding); border-bottom: 1px solid var(--component-migration-divider-strong); }
  .modal-title { display: flex; flex-direction: column; gap: 2px; }
  .modal-title-label { font-family: var(--font-ui); font-size: var(--component-migrate-modal-eyebrow-font-size); color: var(--component-migration-eyebrow-fg); letter-spacing: var(--component-migrate-modal-eyebrow-letter-spacing); text-transform: uppercase; }
  .modal-title-name { font-size: var(--component-migrate-modal-title-font-size); font-weight: var(--weight-bold); color: var(--component-migration-title-fg); letter-spacing: var(--component-migrate-modal-title-letter-spacing); }
  .close-btn { display: flex; align-items: center; justify-content: center; width: var(--component-migrate-modal-icon-size); height: var(--component-migrate-modal-icon-size); border-radius: var(--component-migration-icon-radius); color: var(--component-migration-icon-fg); background: var(--component-migration-icon-bg); border: 1px solid var(--component-migration-icon-border); cursor: pointer; transition: color var(--component-migration-transition-fast), background var(--component-migration-transition-fast), transform var(--component-migration-transition-fast); }
  .close-btn:hover { color: var(--component-migration-icon-hover-fg); background: var(--component-migration-icon-hover-bg); }
  .close-btn:active { transform: scale(0.96); }
  .body { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); overflow: auto; }
  .section { display: flex; flex-direction: column; gap: var(--sp-3); }
  .mode-tabs { display: flex; gap: 4px; }
  .mode-tab { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 var(--sp-3); border-radius: var(--radius-md); border: 1px solid var(--border-dim); background: none; color: var(--text-muted); font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); cursor: pointer; }
  .mode-tab-active { background: var(--accent-muted); border-color: var(--accent-dim); color: var(--accent-fg); }
  .notice {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-4);
    background:
      var(--component-novel-migrate-notice-layer),
      var(--bg-elevated);
    border: 1px solid var(--component-novel-migrate-notice-border);
    border-radius: var(--radius-md);
    color: var(--text-muted);
    box-shadow: var(--component-novel-migrate-notice-shadow);
  }
  .notice.inline {
    border-color: var(--border-dim);
  }
  .search-bar { display: flex; align-items: center; gap: var(--sp-2); }
  .search-input { flex: 1; min-height: 34px; padding: 0 var(--sp-3); border: 1px solid var(--border-dim); border-radius: var(--radius-md); background: var(--bg-raised); color: var(--text-primary); }
  .source-list, .results { display: flex; flex-direction: column; gap: 6px; overflow: auto; }
  .source-row, .result-row, .search-btn, .back-btn, .mass-check { cursor: pointer; }
  .source-row, .result-row { display: flex; align-items: center; gap: var(--sp-3); width: 100%; padding: 10px var(--sp-3); text-align: left; border-radius: var(--radius-md); border: 1px solid transparent; background: none; }
  .source-row:hover, .result-row:hover { background: var(--component-migration-row-hover-bg); border-color: var(--component-migration-row-hover-border); }
  .source-row-active { background: var(--component-migrate-modal-row-active-bg); border-color: var(--component-migrate-modal-row-active-border); }
  .result-row-ready { border-color: var(--component-novel-migrate-ready-border); }
  .result-row-blocked { border-color: var(--component-novel-migrate-blocked-border); }
  .source-info, .result-info, .compare-card { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .source-name, .result-title { color: var(--text-secondary); font-size: var(--text-sm); font-weight: var(--weight-medium); }
  .source-meta { color: var(--text-faint); font-size: var(--text-2xs); font-family: var(--font-ui); letter-spacing: var(--tracking-wide); }
  .search-btn, .back-btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-2); min-height: 34px; padding: 0 var(--sp-3); border-radius: var(--radius-md); border: 1px solid var(--border-dim); background: var(--bg-raised); color: var(--text-muted); font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); }
  .search-btn.primary { background: var(--accent-muted); border-color: var(--accent-dim); color: var(--accent-fg); }
  .actions-row { display: flex; justify-content: flex-end; gap: var(--sp-2); }
  .stats { display: flex; flex-direction: column; gap: 6px; padding: var(--sp-3); border: 1px solid var(--border-dim); border-radius: var(--radius-md); background: var(--bg-raised); }
  .stat-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); font-size: var(--text-xs); color: var(--text-muted); }
  .result-cover { width: 42px; height: 60px; border: 1px solid var(--border-dim); border-radius: var(--radius-sm); overflow: hidden; background: var(--bg-raised); flex-shrink: 0; }
  .result-cover img { width: 100%; height: 100%; object-fit: cover; }
  .cover-fallback, .centered { display: flex; align-items: center; justify-content: center; }
  .cover-fallback { width: 100%; height: 100%; color: var(--text-faint); }
  .centered { min-height: 120px; color: var(--text-faint); }
  .mass-check { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: var(--radius-sm); border: 1px solid var(--border-dim); background: var(--bg-raised); color: var(--accent-fg); flex-shrink: 0; }
  .mass-check:disabled { opacity: var(--component-novel-migrate-disabled-opacity); cursor: default; }
  .compare { display: flex; align-items: center; justify-content: center; gap: var(--sp-3); }
  .compare-card { flex: 1; padding: var(--sp-3); border-radius: var(--radius-md); border: 1px solid var(--border-dim); background: var(--bg-raised); }
  @keyframes scaleIn { from { opacity: 0; transform: translateY(8px) scale(0.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
</style>
