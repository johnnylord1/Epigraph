<script lang="ts">
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
  import { loadNovelSourceClassificationState, peekNovelSourceClassificationState, type PersistedNovelSourceClassificationState } from "../../lib/novels/sourceClassificationState";
  import NocturneState from "../shared/NocturneState.svelte";
  import { getNovelMigrationBlocker, hasMinimumNovelMigrationSafeCohort, isNovelSourceMigrationSafe } from "../../lib/novels/migrationSafe";

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
    try {
      const result = await applyNovelMigrationWithJournal({
        scopeInput,
        currentNovelId: active.novel.id,
        targetDetail: selectedTarget,
      });

      addToast({
        kind: "success",
        title: "Novel migrated",
        body: `${active.novel.title} moved to ${selectedSource?.name ?? "the new source"}.`,
        duration: 7000,
        action: {
          label: "Undo",
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
                title: "Migration undone",
                body: active.novel.title,
              });
            }).catch((undoError) => {
              addToast({
                kind: "error",
                title: "Could not undo migration",
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
    }
  }

  async function applyMassMigration() {
    if (!massPreview) return;
    migrating = true;
    error = null;
    try {
      const result = await applyMassNovelMigrationWithJournal({
        scopeInput,
        preview: massPreview,
        selectedNovelIds: [...massSelectedIds],
      });

      addToast({
        kind: "success",
        title: "Mass migration applied",
        body: `${result.migratedCount} novel${result.migratedCount !== 1 ? "s" : ""} moved to ${selectedSource?.name ?? "the new source"}.`,
        duration: 9000,
        action: {
          label: "Undo",
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
                title: "Mass migration undone",
                body: `${result.migratedCount} novel${result.migratedCount !== 1 ? "s" : ""}`,
              });
            }).catch((undoError) => {
              addToast({
                kind: "error",
                title: "Could not undo mass migration",
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
</script>

<div class="overlay">
  <button class="backdrop" type="button" aria-label="Close migration modal" onclick={onClose}></button>
  <div class="modal" role="dialog" aria-modal="true" aria-label="Migrate novel">
    <div class="modal-header">
      <div class="modal-title">
        <span class="modal-title-label">Migrate novel</span>
        <span class="modal-title-name">{active.novel.title}</span>
      </div>
      <button class="close-btn" type="button" onclick={onClose}><X size={14} weight="light" /></button>
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
            Single
          </button>
          <button class="mode-tab" class:mode-tab-active={mode === "mass"} type="button" onclick={() => setMode("mass")}>
            <StackSimple size={12} weight="bold" />
            Mass
          </button>
        </div>

        {#if step === "source"}
          <div class="section">
            {#if mode === "single"}
              <div class="search-bar">
                <input
                  bind:value={query}
                  class="search-input"
                  placeholder="Search title..."
                  onkeydown={(event) => event.key === "Enter" && runSearch()}
                />
                <button class="search-btn" type="button" disabled={searching || !selectedSource || !query.trim()} onclick={runSearch}>
                  {#if searching}
                    <CircleNotch size={13} weight="light" class="anim-spin" />
                  {:else}
                    <MagnifyingGlass size={12} weight="bold" />
                  {/if}
                  Search
                </button>
              </div>
            {:else}
              <div class="notice inline">
                <StackSimple size={14} weight="light" />
                <span>This previews all library novels from the current source into one migration-safe target source, then applies only the ready matches by default.</span>
              </div>
            {/if}

            {#if loadingSources}
              <div class="centered"><CircleNotch size={16} weight="light" class="anim-spin" /></div>
            {:else if sources.length === 0}
              <div class="notice">
                <Warning size={14} weight="light" />
                <span>No installed trusted novel source is marked migration-safe yet.</span>
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
                    Preview mass migration
                  </button>
                </div>
              {/if}
            {/if}
          </div>
        {:else if step === "search"}
          <div class="section">
            <button class="back-btn" type="button" onclick={() => step = "source"}>Back</button>
            {#if error}
              <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Migration" title="Search failed" body={error} />
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
            <button class="back-btn" type="button" onclick={() => step = "source"} disabled={migrating}>Back</button>
            <div class="stats">
              <div class="stat-row"><span>Ready</span><strong>{massPreview.readyCount}</strong></div>
              <div class="stat-row"><span>Needs review</span><strong>{massPreview.needsReviewCount}</strong></div>
              <div class="stat-row"><span>Blocked</span><strong>{massPreview.blockedCount}</strong></div>
              <div class="stat-row"><span>Selected to apply</span><strong>{massSelectedIds.size}</strong></div>
            </div>
            {#if error}
              <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Migration" title="Mass migration failed" body={error} />
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
                        {Math.round(item.match.similarity * 100)}% match
                      {:else}
                        {" · "}
                        {item.reasonCode}
                      {/if}
                    </span>
                    {#if item.preview}
                      <span class="source-meta">
                        {item.preview.matchedChapterCount} matched chapters · {item.preview.transferredReadCount} read carried · {item.preview.transferredBookmarkCount} bookmarks carried
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
                Apply ready items
              </button>
            </div>
          </div>
        {:else if selectedTarget && preview}
          <div class="section confirm">
            <button class="back-btn" type="button" onclick={() => step = "search"} disabled={migrating}>Back</button>
            <div class="compare">
              <div class="compare-card">
                <span class="source-name">{active.novel.title}</span>
                <span class="source-meta">{active.novel.source.sourceName ?? active.novel.source.pluginName ?? "Current source"}</span>
              </div>
              <ArrowRight size={16} weight="light" />
              <div class="compare-card">
                <span class="source-name">{selectedTarget.title}</span>
                <span class="source-meta">{selectedSource?.name ?? "Target source"}</span>
              </div>
            </div>
            <div class="stats">
              <div class="stat-row"><span>Title confidence</span><strong>{Math.round(preview.confidence * 100)}%</strong></div>
              <div class="stat-row"><span>Matched chapters</span><strong>{preview.matchedChapterCount}</strong></div>
              <div class="stat-row"><span>Read state transferred</span><strong>{preview.transferredReadCount}</strong></div>
              <div class="stat-row"><span>Bookmarks transferred</span><strong>{preview.transferredBookmarkCount}</strong></div>
              <div class="stat-row"><span>Chapter diff</span><strong>{preview.chapterDiff > 0 ? `+${preview.chapterDiff}` : preview.chapterDiff}</strong></div>
            </div>
            {#if preview.confidence < 0.5}
              <NocturneState layout="compact" tone="warning" icon="warning" eyebrow="Migration" title="Low-confidence match" body="Review carefully before replacing the source." />
            {/if}
            <div class="notice inline">
              <Check size={14} weight="light" />
              <span>The old novel will be replace-hidden through the migration journal, and Undo stays available for a short window.</span>
            </div>
            {#if error}
              <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Migration" title="Migration failed" body={error} />
            {/if}
            <div class="actions-row">
              <button class="search-btn primary" type="button" disabled={migrating} onclick={applyMigration}>
                {#if migrating}
                  <CircleNotch size={13} weight="light" class="anim-spin" />
                {:else}
                  <Check size={12} weight="bold" />
                {/if}
                Migrate
              </button>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 220; }
  .backdrop { position: absolute; inset: 0; border: none; background: rgba(0, 0, 0, 0.68); backdrop-filter: blur(14px) saturate(118%); cursor: pointer; }
  .modal { position: relative; width: 640px; max-height: 82vh; display: flex; flex-direction: column; overflow: hidden; border: 1px solid rgba(92, 88, 103, 0.42); border-radius: 18px; background: rgba(21, 20, 25, 0.98); box-shadow: inset 0 1px 0 rgba(255,255,255,0.025), 0 28px 80px rgba(0, 0, 0, 0.54); z-index: 1; animation: scaleIn 0.16s ease both; }
  .modal-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 15px 18px; border-bottom: 1px solid rgba(92, 88, 103, 0.34); }
  .modal-title { display: flex; flex-direction: column; gap: 2px; }
  .modal-title-label { font-family: "Manrope", "Inter", system-ui, sans-serif; font-size: 9px; color: rgba(202, 196, 208, 0.48); letter-spacing: 0.14em; text-transform: uppercase; }
  .modal-title-name { font-size: 13px; font-weight: 800; color: #e8e4eb; letter-spacing: 0.02em; }
  .close-btn { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 10px; color: rgba(202, 196, 208, 0.74); background: rgba(255,255,255,0.018); border: 1px solid rgba(92, 88, 103, 0.42); cursor: pointer; transition: color 140ms ease, background 140ms ease, transform 140ms ease; }
  .close-btn:hover { color: #e8e4eb; background: rgba(201, 181, 255, 0.1); }
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
      linear-gradient(135deg, rgba(184, 167, 234, 0.09), rgba(184, 167, 234, 0.025)),
      var(--bg-elevated);
    border: 1px solid rgba(184, 167, 234, 0.14);
    border-radius: var(--radius-md);
    color: var(--text-muted);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025);
  }
  .notice.inline {
    border-color: var(--border-dim);
  }
  .search-bar { display: flex; align-items: center; gap: var(--sp-2); }
  .search-input { flex: 1; min-height: 34px; padding: 0 var(--sp-3); border: 1px solid var(--border-dim); border-radius: var(--radius-md); background: var(--bg-raised); color: var(--text-primary); }
  .source-list, .results { display: flex; flex-direction: column; gap: 6px; overflow: auto; }
  .source-row, .result-row, .search-btn, .back-btn, .mass-check { cursor: pointer; }
  .source-row, .result-row { display: flex; align-items: center; gap: var(--sp-3); width: 100%; padding: 10px var(--sp-3); text-align: left; border-radius: var(--radius-md); border: 1px solid transparent; background: none; }
  .source-row:hover, .result-row:hover { background: rgba(184, 167, 234, 0.08); border-color: rgba(184, 167, 234, 0.14); }
  .source-row-active { background: rgba(184, 167, 234, 0.12); border-color: rgba(184, 167, 234, 0.18); }
  .result-row-ready { border-color: color-mix(in srgb, var(--color-success) 18%, var(--border-dim)); }
  .result-row-blocked { border-color: color-mix(in srgb, var(--color-error) 18%, var(--border-dim)); }
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
  .mass-check:disabled { opacity: 0.35; cursor: default; }
  .compare { display: flex; align-items: center; justify-content: center; gap: var(--sp-3); }
  .compare-card { flex: 1; padding: var(--sp-3); border-radius: var(--radius-md); border: 1px solid var(--border-dim); background: var(--bg-raised); }
  @keyframes scaleIn { from { opacity: 0; transform: translateY(8px) scale(0.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
</style>
