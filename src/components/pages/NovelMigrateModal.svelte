<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { ArrowLeft, ArrowRight, BookOpen, Check, CircleNotch, StackSimple, X } from "phosphor-svelte";
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
  import { classifyUnclassifiedNovelSources } from "../../lib/novels/automaticClassification";
  import { loadNovelSourceClassificationState, peekNovelSourceClassificationState, type PersistedNovelSourceClassificationState } from "../../lib/novels/sourceClassificationState";
  import NocturneState from "../shared/NocturneState.svelte";
  import { isNovelSourceMigrationSafe } from "../../lib/novels/migrationSafe";
  import { createDialogFocusBoundary } from "../../lib/accessibility/dialogFocus";
  import { createStoreMigrationIdentityBridge } from "../../lib/migration/storeIdentity.svelte";
  import MigrationSourcePicker from "./MigrationSourcePicker.svelte";
  import MigrationResultList from "./MigrationResultList.svelte";
  import MigrationConfirm from "./MigrationConfirm.svelte";
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
  let classifying = $state(true);
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

  const currentSourceName = $derived(active.novel.source.sourceName ?? active.novel.source.pluginName ?? translate("ui_currentSource"));
  const sourceOptions = $derived(sources.map((source) => ({ id: source.pluginId, name: source.name })));
  const resultOptions = $derived(results.map((result) => ({ id: result.path, title: result.title, coverSrc: result.coverUrl })));

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

  function markBrokenImage(event: Event) {
    (event.currentTarget as HTMLImageElement).dataset.broken = "true";
  }

  const scopeInput = $derived({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
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
    } catch (searchError) {
      error = searchError instanceof Error ? searchError.message : String(searchError);
    } finally {
      searching = false;
    }
  }

  // One press on a source moves on: a single migration searches it for this title, a mass one
  // builds the preview of every library novel from the current source.
  function pickSource(pluginId: string) {
    const source = sources.find((candidate) => candidate.pluginId === pluginId);
    if (!source) return;
    selectedSource = source;
    error = null;
    if (mode === "mass") {
      void buildMassPreview();
      return;
    }
    query = active.novel.title;
    step = "search";
    void runSearch();
  }

  async function pickResult(path: string) {
    const result = results.find((candidate) => candidate.path === path);
    if (!result || !selectedSource || pickingPath !== null) return;
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
    const scope = scopeInput;
    void loadNovelSourceClassificationState(scope).then((state) => {
      sourceClassificationState = state;
    });
    // Targets still being checked join the list as soon as their smoke finishes; until then an
    // empty list keeps loading instead of claiming there is nothing to migrate to.
    classifying = true;
    void classifyUnclassifiedNovelSources(scope)
      .then((wrote) => (wrote ? loadNovelSourceClassificationState(scope) : null))
      .then((state) => { if (state) sourceClassificationState = state; })
      .catch(() => {})
      .finally(() => { classifying = false; });
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
        <h2 class="mg-title" title={active.novel.title}>{active.novel.title}</h2>
        <p class="mg-subtitle">{step === "source" || !selectedSource ? $_("migrate.fromSource", { source: currentSourceName, count: active.novel.chapterCount }) : selectedSource.name}</p>
      </div>
      <button bind:this={closeButtonEl} class="mg-close" type="button" onclick={onClose} disabled={migrating} aria-label={$_("ui_closeMigrationModal")}><X size={16} weight="bold" /></button>
    </header>

    <div class="mg-body">
      {#key step}<div class="mg-step" use:enterOnMount={{ y: 10, blur: 4, duration: 560 }}>
      {#if step === "source"}
        <div class="mg-segmented" role="group" aria-label={$_("ui_migrateNovel")}>
          <button type="button" aria-pressed={mode === "single"} disabled={massPreviewLoading} onclick={() => setMode("single")}><BookOpen size={14} weight="bold" /> {$_("ui_single")}</button>
          <button type="button" aria-pressed={mode === "mass"} disabled={massPreviewLoading} onclick={() => setMode("mass")}><StackSimple size={14} weight="bold" /> {$_("ui_mass")}</button>
        </div>
        <MigrationSourcePicker
          sources={sourceOptions}
          loading={loadingSources || (classifying && sourceOptions.length === 0)}
          pendingId={massPreviewLoading ? selectedSource?.pluginId ?? null : null}
          emptyLabel={$_("novelMigrate.noSafeTarget")}
          onPick={pickSource}
        />
        {#if error}
          <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("ui_migration")} title={mode === "mass" ? $_("ui_massMigrationFailed") : $_("ui_searchFailed")} body={error} />
        {/if}

      {:else if step === "search"}
        <MigrationResultList
          bind:query
          {searching}
          results={resultOptions}
          pendingId={pickingPath}
          {error}
          placeholder={$_("ui_searchTitle_276e2d1e")}
          onSearch={runSearch}
          onPick={pickResult}
        />

      {:else if step === "mass-preview" && massPreview}
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
              type="button"
              role="checkbox"
              aria-checked={selected}
              disabled={item.status !== "ready" || migrating}
              onclick={() => toggleMassSelection(item.currentNovelId)}
            >
              <span class="mg-check" class:is-checked={selected} aria-hidden="true">{#if selected}<Check size={13} weight="bold" />{/if}</span>
              <span class="mg-row-copy">
                <strong title={item.currentTitle}>{item.currentTitle}</strong>
                <small>
                  {#if item.match}
                    <span title={item.match.detail.title}>→ {item.match.detail.title} · {Math.round(item.match.similarity * 100)}%</span>
                  {:else}
                    <span>{item.reasonCode}</span>
                  {/if}
                </small>
              </span>
              <span class="mg-pill {statusTone(item.status)}">{statusLabel(item.status)}</span>
            </button>
          {/each}
        </div>

      {:else if selectedTarget && preview}
        <MigrationConfirm
          from={{ title: active.novel.title, caption: currentSourceName, coverSrc: active.novel.coverUrl }}
          to={{ title: selectedTarget.title, caption: selectedSource?.name ?? $_("ui_targetSource"), coverSrc: selectedTarget.coverUrl }}
          warning={preview.confidence < 0.5 ? `${$_("ui_lowConfidenceMatch")}. ${$_("feedback.reviewMigration")}` : null}
          note={$_("ui_theOldNovelWillBeReplaceHiddenThrough")}
          {error}
        >
          {#snippet summary()}{$_("novelMigrate.itemCarry", { chapters: preview?.matchedChapterCount ?? 0, read: preview?.transferredReadCount ?? 0, bookmarks: preview?.transferredBookmarkCount ?? 0 })}{/snippet}
        </MigrationConfirm>
      {/if}
      </div>{/key}
    </div>

    <footer class="mg-footer">
      {#if step === "source"}
        <span class="mg-spacer"></span>
        <button class="mg-btn" type="button" onclick={onClose}>{$_("ui_cancel")}</button>
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
