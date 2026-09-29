<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import {
    ArrowLeft,
    ArrowRight,
    ArrowsLeftRight,
    BookOpen,
    Check,
    CircleNotch,
    ListChecks,
    MagnifyingGlass,
    Plugs,
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
  import { createStoreMigrationIdentityBridge } from "../../lib/migration/storeIdentity.svelte";
  import { enterOnMount, glideHeight, listFlip } from "../../lib/motion/motion";
  import "./migrationModal.css";

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
  let pickingPath = $state<string | null>(null);

  const modeSteps = $derived<Step[]>(mode === "mass" ? ["source", "mass-preview"] : ["source", "search", "confirm"]);
  const visibleStep = $derived<Step>(step === "mass-preview" && !massPreview ? "source" : step);
  const stepIdx = $derived(Math.max(0, modeSteps.indexOf(visibleStep)));
  const currentSourceName = $derived(active.novel.source.sourceName ?? active.novel.source.pluginName ?? translate("ui_currentSource"));

  function stepLabel(value: Step): string {
    if (value === "source") return translate("ui_pickSource");
    if (value === "search") return translate("migrate.stepSearch");
    if (value === "mass-preview") return translate("massMigration.stepReview");
    return translate("migrate.stepConfirm");
  }

  function statusLabel(status: string): string {
    if (status === "ready") return translate("ui_ready");
    if (status === "blocked") return translate("ui_blocked_99613c74");
    return translate("ui_needsReview_33a506cf");
  }

  function statusTone(status: string): string {
    if (status === "ready") return "mg-pill--good";
    if (status === "blocked") return "mg-pill--bad";
    return "mg-pill--warn";
  }

  const languageNames = (() => {
    try { return new Intl.DisplayNames([document.documentElement.lang || "en"], { type: "language" }); }
    catch { return null; }
  })();
  function languageLabel(lang: string): string {
    try { return languageNames?.of(lang) ?? lang.toUpperCase(); }
    catch { return lang.toUpperCase(); }
  }

  function markBrokenImage(event: Event) {
    (event.currentTarget as HTMLImageElement).dataset.broken = "true";
  }

  const scopeInput = $derived({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  });
  const migrationCohortReady = $derived(hasMinimumNovelMigrationSafeCohort(sourceClassificationState));
  const cohortBlocker = $derived.by(() => {
    if (!migrationCohortReady) {
      return translate("novelMigrate.cohortBlocked");
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
    if (!selectedSource || pickingPath !== null) return;
    error = null;
    pickingPath = result.path;
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
    } finally {
      pickingPath = null;
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
      const identityBridge = createStoreMigrationIdentityBridge(
        store.runtimeResolvedLocalProfileId ?? store.settings.defaultLocalProfileId,
      );
      const result = await applyNovelMigrationWithJournal({
        scopeInput,
        currentNovelId: active.novel.id,
        targetDetail: selectedTarget,
        identityBridge,
      });

      addToast({
        kind: "success",
        title: translate("ui_novelMigrated"),
        body: translate("migrate.movedTo", { title: active.novel.title, source: selectedSource?.name ?? translate("ui_theNewSource") }),
        duration: 7000,
        action: {
          label: translate("ui_undo"),
          run: () => {
            void undoNovelMigration({
              scopeInput,
              journalEntryId: result.journalEntryId,
              identityBridge,
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
      const identityBridge = createStoreMigrationIdentityBridge(
        store.runtimeResolvedLocalProfileId ?? store.settings.defaultLocalProfileId,
      );
      const result = await applyMassNovelMigrationWithJournal({
        scopeInput,
        preview: massPreview,
        selectedNovelIds: [...massSelectedIds],
        identityBridge,
      });

      addToast({
        kind: "success",
        title: translate("ui_massMigrationApplied"),
        body: translate("novelMigrate.movedMany", { count: result.migratedCount, source: selectedSource?.name ?? translate("ui_theNewSource") }),
        duration: 9000,
        action: {
          label: translate("ui_undo"),
          run: () => {
            void undoNovelMigration({
              scopeInput,
              journalEntryId: result.journalEntryId,
              identityBridge,
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

  // Escape closes like the manga migration modal, but never while a migration is being written.
  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && !migrating) onClose();
  }

  onMount(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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

<div bind:this={overlayEl} class="mg-overlay">
  <button class="mg-backdrop" type="button" aria-label={$_("ui_closeMigrationModal")} disabled={migrating} onclick={onClose}></button>
  <div bind:this={modalEl} class="mg-modal mg-modal--novel" role="dialog" aria-modal="true" aria-label={$_("ui_migrateNovel")} tabindex="-1" use:glideHeight>
    <header class="mg-header">
      <span class="mg-header-cover">
        {#if active.novel.coverUrl}<img src={active.novel.coverUrl} alt="" onerror={markBrokenImage} />{/if}
      </span>
      <div class="mg-heading">
        <p class="mg-eyebrow">{$_("ui_migrateNovel")}</p>
        <h2 class="mg-title" title={active.novel.title}>{active.novel.title}</h2>
        <p class="mg-subtitle">{$_("migrate.fromSource", { source: currentSourceName, count: active.novel.chapterCount })}</p>
      </div>
      <button bind:this={closeButtonEl} class="mg-close" type="button" onclick={onClose} disabled={migrating} aria-label={$_("ui_closeMigrationModal")}><X size={16} weight="bold" /></button>
    </header>

    {#if !cohortBlocker}
      <nav class="mg-steps" aria-label={$_("ui_migrateNovel")}>
        <ol>
          {#each modeSteps as st, i}
            <li class:is-complete={i < stepIdx} aria-current={visibleStep === st ? "step" : undefined}>
              <span class="mg-step-chip">
                <span class="mg-step-icon" aria-hidden="true">
                  {#if i < stepIdx}<Check size={15} weight="bold" />{:else if st === "source"}<Plugs size={16} weight="duotone" />{:else if st === "search"}<MagnifyingGlass size={16} weight="duotone" />{:else if st === "mass-preview"}<ListChecks size={16} weight="duotone" />{:else}<ArrowsLeftRight size={16} weight="duotone" />{/if}
                </span>
                <span>{stepLabel(st)}</span>
              </span>
              {#if i < modeSteps.length - 1}<span class="mg-step-line" aria-hidden="true"><i></i></span>{/if}
            </li>
          {/each}
        </ol>
      </nav>
    {/if}

    <div class="mg-body">
      {#key cohortBlocker ? "blocked" : step}<div class="mg-step" use:enterOnMount={{ y: 10, blur: 4, duration: 560 }}>
      {#if cohortBlocker}
        <NocturneState layout="compact" tone="warning" icon="warning" eyebrow={$_("ui_migration")} title={$_("ui_warning")} body={cohortBlocker} />
      {:else if step === "source"}
        <div class="mg-segmented" role="group" aria-label={$_("ui_migrateNovel")}>
          <button type="button" aria-pressed={mode === "single"} onclick={() => setMode("single")}><BookOpen size={14} weight="bold" /> {$_("ui_single")}</button>
          <button type="button" aria-pressed={mode === "mass"} onclick={() => setMode("mass")}><StackSimple size={14} weight="bold" /> {$_("ui_mass")}</button>
        </div>

        {#if mode === "single"}
          <p class="mg-lede">{$_("migrate.sourceLede")}</p>
          <label class="mg-field">
            <MagnifyingGlass size={16} weight="bold" />
            <input
              bind:value={query}
              placeholder={$_("ui_searchTitle_276e2d1e")}
              aria-label={$_("ui_searchTitle_276e2d1e")}
              onkeydown={(event) => event.key === "Enter" && runSearch()}
            />
          </label>
        {:else}
          <p class="mg-lede">{$_("ui_thisPreviewsAllLibraryNovelsFromTheCurrent")}</p>
        {/if}

        {#if loadingSources}
          <div class="mg-list" aria-busy="true">
            {#each Array(4) as _}<div class="mg-skeleton"></div>{/each}
          </div>
        {:else if sources.length === 0}
          <NocturneState layout="compact" tone="warning" icon="warning" eyebrow={$_("ui_migration")} title={$_("ui_warning")} body={$_("ui_noInstalledTrustedNovelSourceIsMarkedMigration")} />
        {:else}
          <p class="mg-section-label">{$_("migrate.sourceCount", { count: sources.length })}</p>
          <div class="mg-list" role="radiogroup" aria-label={$_("ui_targetSource")}>
            {#each sources as source, i (source.pluginId)}
              <button
                animate:listFlip
                style:--mg-i={i}
                class="mg-row"
                class:is-selected={selectedSource?.pluginId === source.pluginId}
                type="button"
                role="radio"
                aria-checked={selectedSource?.pluginId === source.pluginId}
                data-migration-source
                onclick={() => selectedSource = source}
              >
                <span class="mg-mark"><BookOpen size={17} weight="duotone" /></span>
                <span class="mg-row-copy">
                  <strong>{source.name}</strong>
                  <small>{languageLabel(source.lang)}</small>
                </span>
                <span class="mg-row-end">{#if selectedSource?.pluginId === source.pluginId}<Check size={16} weight="bold" />{/if}</span>
              </button>
            {/each}
          </div>
        {/if}

        {#if massPreviewLoading}
          <div class="mg-progress" aria-live="polite">
            <div class="mg-progress-head"><span>{$_("ui_previewMassMigration")}</span><CircleNotch size={14} weight="bold" class="anim-spin" /></div>
          </div>
        {/if}
        {#if error}
          <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("ui_migration")} title={mode === "mass" ? $_("ui_massMigrationFailed") : $_("ui_searchFailed")} body={error} />
        {/if}

      {:else if step === "search"}
        {#if selectedSource}
          <div class="mg-context">
            <span class="mg-mark"><BookOpen size={15} weight="duotone" /></span>
            <span class="mg-row-copy">
              <strong>{selectedSource.name}</strong>
              <small>{languageLabel(selectedSource.lang)}</small>
            </span>
            <button class="mg-btn mg-btn--small" type="button" onclick={() => step = "source"}>{$_("ui_change")}</button>
          </div>
        {/if}
        <form class="mg-field" onsubmit={(event) => { event.preventDefault(); void runSearch(); }}>
          <MagnifyingGlass size={16} weight="bold" />
          <input bind:value={query} placeholder={$_("ui_searchTitle_276e2d1e")} aria-label={$_("ui_searchTitle_276e2d1e")} />
          <button class="mg-btn mg-btn--primary mg-btn--small" type="submit" disabled={searching || !selectedSource || !query.trim()}>
            {#if searching}<CircleNotch size={14} weight="bold" class="anim-spin" />{/if}
            {$_("novelSources_actions_search")}
          </button>
        </form>
        {#if error}
          <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("ui_migration")} title={$_("ui_searchFailed")} body={error} />
        {/if}
        {#if searching}
          <div class="mg-list" aria-busy="true">
            {#each Array(4) as _}<div class="mg-skeleton"></div>{/each}
          </div>
        {:else if results.length > 0}
          <p class="mg-section-label">{$_("migrate.resultCount", { count: results.length })}</p>
          <div class="mg-list">
            {#each results as result, i (result.path)}
              <button class="mg-row" animate:listFlip style:--mg-i={i} type="button" data-migration-result disabled={pickingPath !== null} onclick={() => pickResult(result)}>
                <span class="mg-cover">
                  {#if result.coverUrl}<img src={result.coverUrl} alt="" onerror={markBrokenImage} />{:else}<BookOpen size={18} weight="duotone" />{/if}
                </span>
                <span class="mg-row-copy">
                  <strong title={result.title}>{result.title}</strong>
                  <small title={result.path}>{result.path}</small>
                </span>
                <span class="mg-row-end">
                  {#if pickingPath === result.path}<CircleNotch size={16} weight="bold" class="anim-spin" />{:else}<ArrowRight size={16} weight="bold" />{/if}
                </span>
              </button>
            {/each}
          </div>
        {:else if !error}
          <div class="mg-empty">
            <span class="mg-mark"><MagnifyingGlass size={18} weight="duotone" /></span>
            <span>{$_("ui_noResultsTryADifferentTitle")}</span>
          </div>
        {/if}

      {:else if step === "mass-preview" && massPreview}
        <div class="mg-metrics">
          <div class="mg-metric"><span>{$_("ui_ready")}</span><strong class="is-good">{massPreview.readyCount}</strong></div>
          <div class="mg-metric"><span>{$_("ui_needsReview_33a506cf")}</span><strong class:is-warn={massPreview.needsReviewCount > 0}>{massPreview.needsReviewCount}</strong></div>
          <div class="mg-metric"><span>{$_("ui_blocked_99613c74")}</span><strong class:is-bad={massPreview.blockedCount > 0}>{massPreview.blockedCount}</strong></div>
          <div class="mg-metric"><span>{$_("ui_selectedToApply")}</span><strong>{massSelectedIds.size}</strong></div>
        </div>
        {#if error}
          <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("ui_migration")} title={$_("ui_massMigrationFailed")} body={error} />
        {/if}
        <div class="mg-list">
          {#each massPreview.items as item, i (item.currentNovelId)}
            {@const selected = massSelectedIds.has(item.currentNovelId)}
            <button
              animate:listFlip
              style:--mg-i={i}
              class="mg-row"
              class:is-selected={selected}
              type="button"
              role="checkbox"
              aria-checked={selected}
              disabled={item.status !== "ready" || migrating}
              onclick={() => toggleMassSelection(item.currentNovelId)}
            >
              <span class="mg-mark">{#if selected}<Check size={16} weight="bold" />{:else}<BookOpen size={16} weight="duotone" />{/if}</span>
              <span class="mg-row-copy">
                <strong title={item.currentTitle}>{item.currentTitle}</strong>
                <small>
                  {#if item.match}
                    <ArrowRight size={11} weight="bold" />
                    <span title={item.match.detail.title}>{item.match.detail.title}</span>
                    <span>· {$_("migrate.matchPercent", { percent: Math.round(item.match.similarity * 100) })}</span>
                  {:else}
                    <span>{item.reasonCode}</span>
                  {/if}
                </small>
                {#if item.preview}
                  <small>{$_("novelMigrate.itemCarry", { chapters: item.preview.matchedChapterCount, read: item.preview.transferredReadCount, bookmarks: item.preview.transferredBookmarkCount })}</small>
                {/if}
              </span>
              <span class="mg-pill {statusTone(item.status)}">{statusLabel(item.status)}</span>
            </button>
          {/each}
        </div>

      {:else if selectedTarget && preview}
        <p class="mg-lede">{$_("migrate.confirmLede")}</p>
        <div class="mg-compare">
          <div class="mg-compare-card">
            <span class="mg-cover">
              {#if active.novel.coverUrl}<img src={active.novel.coverUrl} alt="" onerror={markBrokenImage} />{:else}<BookOpen size={18} weight="duotone" />{/if}
            </span>
            <span class="mg-row-copy">
              <span class="mg-pill">{$_("bookDetail_filter_current")}</span>
              <strong title={active.novel.title}>{active.novel.title}</strong>
              <small>{currentSourceName}</small>
            </span>
          </div>
          <span class="mg-compare-arrow" aria-hidden="true"><ArrowRight size={16} weight="bold" /></span>
          <div class="mg-compare-card is-new">
            <span class="mg-cover">
              {#if selectedTarget.coverUrl}<img src={selectedTarget.coverUrl} alt="" onerror={markBrokenImage} />{:else}<BookOpen size={18} weight="duotone" />{/if}
            </span>
            <span class="mg-row-copy">
              <span class="mg-pill mg-pill--accent">{$_("ui_new")}</span>
              <strong title={selectedTarget.title}>{selectedTarget.title}</strong>
              <small>{selectedSource?.name ?? $_("ui_targetSource")}</small>
            </span>
          </div>
        </div>
        <div class="mg-metrics">
          <div class="mg-metric">
            <span>{$_("ui_titleConfidence")}</span>
            <strong class:is-good={preview.confidence > 0.7} class:is-warn={preview.confidence > 0.4 && preview.confidence <= 0.7} class:is-bad={preview.confidence <= 0.4}>{Math.round(preview.confidence * 100)}%</strong>
          </div>
          <div class="mg-metric">
            <span>{$_("ui_matchedChapters_ff5d3901")}</span>
            <strong>{preview.matchedChapterCount}</strong>
            {#if preview.chapterDiff !== 0}<small>{preview.chapterDiff > 0 ? `+${preview.chapterDiff}` : preview.chapterDiff} {$_("ui_vsCurrent")}</small>{/if}
          </div>
          <div class="mg-metric"><span>{$_("ui_readStateTransferred")}</span><strong>{preview.transferredReadCount}</strong><small>{$_("ui_chapters")}</small></div>
          <div class="mg-metric"><span>{$_("ui_bookmarksTransferred")}</span><strong>{preview.transferredBookmarkCount}</strong></div>
        </div>
        {#if preview.confidence < 0.5}
          <NocturneState layout="compact" tone="warning" icon="warning" eyebrow={$_("ui_migration")} title={$_("ui_lowConfidenceMatch")} body={$_("feedback.reviewMigration")} />
        {/if}
        <p class="mg-note"><Warning size={12} weight="bold" /> {$_("ui_theOldNovelWillBeReplaceHiddenThrough")}</p>
        {#if error}
          <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("ui_migration")} title={$_("ui_migrationFailed")} body={error} />
        {/if}
      {/if}
      </div>{/key}
    </div>

    <footer class="mg-footer">
      {#if cohortBlocker}
        <span class="mg-spacer"></span>
        <button class="mg-btn" type="button" onclick={onClose}>{$_("ui_cancel")}</button>
      {:else if step === "source"}
        <button class="mg-btn" type="button" onclick={onClose}>{$_("ui_cancel")}</button>
        <span class="mg-spacer"></span>
        {#if mode === "single"}
          <button class="mg-btn mg-btn--primary" type="button" disabled={searching || !selectedSource || !query.trim()} onclick={runSearch}>
            {#if searching}<CircleNotch size={15} weight="bold" class="anim-spin" />{/if}
            {$_("novelSources_actions_search")} <ArrowRight size={15} weight="bold" class="mg-arrow-next" />
          </button>
        {:else}
          <button class="mg-btn mg-btn--primary" type="button" disabled={massPreviewLoading || !selectedSource} onclick={buildMassPreview}>
            {#if massPreviewLoading}<CircleNotch size={15} weight="bold" class="anim-spin" />{/if}
            {$_("ui_previewMassMigration")} <ArrowRight size={15} weight="bold" class="mg-arrow-next" />
          </button>
        {/if}
      {:else if step === "search"}
        <button class="mg-btn" type="button" onclick={() => step = "source"} disabled={pickingPath !== null}><ArrowLeft size={15} weight="bold" class="mg-arrow-back" /> {$_("ui_back")}</button>
        <span class="mg-spacer"></span>
      {:else if step === "mass-preview"}
        <button class="mg-btn" type="button" onclick={() => step = "source"} disabled={migrating}><ArrowLeft size={15} weight="bold" class="mg-arrow-back" /> {$_("ui_back")}</button>
        <span class="mg-spacer"></span>
        <button class="mg-btn mg-btn--primary" type="button" disabled={migrating || massSelectedIds.size === 0} onclick={applyMassMigration}>
          {#if migrating}<CircleNotch size={15} weight="bold" class="anim-spin" />{/if}
          {$_("ui_applyReadyItems")} ({massSelectedIds.size})
        </button>
      {:else}
        <button class="mg-btn" type="button" onclick={() => step = "search"} disabled={migrating}><ArrowLeft size={15} weight="bold" class="mg-arrow-back" /> {$_("ui_back")}</button>
        <span class="mg-spacer"></span>
        <button class="mg-btn mg-btn--primary" type="button" disabled={migrating} onclick={applyMigration}>
          {#if migrating}
            <CircleNotch size={15} weight="bold" class="anim-spin" /> {$_("ui_migrating")}
          {:else}
            {$_("detail_actions_migrate")} <ArrowRight size={15} weight="bold" class="mg-arrow-next" />
          {/if}
        </button>
      {/if}
    </footer>
  </div>
</div>
