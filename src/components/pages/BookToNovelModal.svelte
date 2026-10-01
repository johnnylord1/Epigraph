<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { ArrowLeft, ArrowRight, CircleNotch, X } from "phosphor-svelte";
  import { onMount } from "svelte";

  import { addToast, bumpContentSetupVersion, setActiveNovelDetail, store } from "../../store/state.svelte";
  import type { BookEntry, BookProgress } from "../../lib/books/types";
  import type { InstalledNovelSourceDescriptor, NovelDetailRecord, NovelSourceSearchResult } from "../../lib/novels/domain";
  import { loadTrustedInstalledNovelSources, readInstalledNovelDetails, searchInstalledNovelSource } from "../../lib/novels/sources";
  import { loadNovelLibraryState } from "../../lib/novels/libraryState";
  import { copyBookToNovelLibrary, previewBookToNovel, type BookToNovelPreview } from "../../lib/migration/bookToNovel";
  import { classifyUnclassifiedNovelSources } from "../../lib/novels/automaticClassification";
  import { loadNovelSourceClassificationState, peekNovelSourceClassificationState, type PersistedNovelSourceClassificationState } from "../../lib/novels/sourceClassificationState";
  import { isNovelSourceMigrationSafe } from "../../lib/novels/migrationSafe";
  import NocturneState from "../shared/NocturneState.svelte";
  import { createDialogFocusBoundary } from "../../lib/accessibility/dialogFocus";
  import MigrationSourcePicker from "./MigrationSourcePicker.svelte";
  import MigrationResultList from "./MigrationResultList.svelte";
  import MigrationConfirm from "./MigrationConfirm.svelte";
  import { enterOnMount, glideHeight } from "../../lib/motion/motion";
  import "./migrationModal.css";

  interface Props {
    book: BookEntry;
    progress: BookProgress | null;
    coverSrc: string | null;
    onClose: () => void;
  }

  let { book, progress, coverSrc, onClose }: Props = $props();

  type Step = "source" | "search" | "confirm";

  let step = $state<Step>("source");
  let loadingSources = $state(true);
  let classifying = $state(true);
  let searching = $state(false);
  let applying = $state(false);
  let error = $state<string | null>(null);
  let sources = $state<InstalledNovelSourceDescriptor[]>([]);
  let sourceClassificationState = $state<PersistedNovelSourceClassificationState>(peekNovelSourceClassificationState({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  }));
  let selectedSource = $state<InstalledNovelSourceDescriptor | null>(null);
  let query = $state(untrackedTitle());
  let results = $state<NovelSourceSearchResult[]>([]);
  let selectedTarget = $state<NovelDetailRecord | null>(null);
  let preview = $state<BookToNovelPreview | null>(null);
  let pickingPath = $state<string | null>(null);
  let overlayEl: HTMLDivElement | undefined = $state();
  let modalEl: HTMLDivElement | undefined = $state();
  let closeButtonEl: HTMLButtonElement | undefined = $state();

  function untrackedTitle() {
    return book.title;
  }

  const scopeInput = $derived({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  });
  const sourceOptions = $derived(sources.map((source) => ({ id: source.pluginId, name: source.name })));
  const resultOptions = $derived(results.map((result) => ({ id: result.path, title: result.title, coverSrc: result.coverUrl })));
  const confirmWarning = $derived.by(() => {
    if (!preview) return null;
    if (preview.confidence < 0.5) return `${translate("ui_lowConfidenceMatch")}. ${translate("bookToNovel_lowConfidenceBody")}`;
    if (preview.keepsExistingProgress) return translate("bookToNovel_keepsProgress");
    return null;
  });

  function markBrokenImage(event: Event) {
    (event.currentTarget as HTMLImageElement).dataset.broken = "true";
  }

  function errorText(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }

  async function reloadSources() {
    loadingSources = true;
    error = null;
    try {
      const installed = await loadTrustedInstalledNovelSources(scopeInput);
      sources = installed.filter((source) => isNovelSourceMigrationSafe(source.pluginId, sourceClassificationState));
    } catch (loadError) {
      error = errorText(loadError);
    } finally {
      loadingSources = false;
    }
  }

  async function runSearch() {
    if (!selectedSource || !query.trim()) return;
    searching = true;
    error = null;
    results = [];
    try {
      results = await searchInstalledNovelSource(scopeInput, selectedSource.pluginId, query.trim(), 1);
    } catch (searchError) {
      error = errorText(searchError);
    } finally {
      searching = false;
    }
  }

  // One press on a source moves on and searches it for the book title.
  function pickSource(pluginId: string) {
    const source = sources.find((candidate) => candidate.pluginId === pluginId);
    if (!source) return;
    selectedSource = source;
    query = book.title;
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
      const state = await loadNovelLibraryState(scopeInput);
      selectedTarget = detail;
      preview = previewBookToNovel({ bookTitle: book.title, progress, target: detail, state });
      step = "confirm";
    } catch (detailError) {
      error = errorText(detailError);
    } finally {
      pickingPath = null;
    }
  }

  async function apply() {
    if (!selectedTarget) return;
    const target = selectedTarget;
    applying = true;
    error = null;
    try {
      await copyBookToNovelLibrary({ scopeInput, progress, target });
      bumpContentSetupVersion();
      addToast({
        kind: "success",
        title: translate("bookToNovel_done"),
        body: target.title,
        duration: 7000,
        action: {
          label: translate("bookToNovel_open"),
          run: () => setActiveNovelDetail({ novel: target, inLibrary: true }),
        },
      });
      onClose();
    } catch (applyError) {
      error = errorText(applyError);
      applying = false;
    }
  }

  $effect(() => {
    const scope = scopeInput;
    void loadNovelSourceClassificationState(scope).then((state) => {
      sourceClassificationState = state;
    });
    // Same as the novel migration: an empty list keeps loading while installed sources are checked.
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

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && !applying) onClose();
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
  <button class="mg-backdrop" type="button" aria-label={$_("ui_closeMigrationModal")} disabled={applying} onclick={onClose}></button>
  <div bind:this={modalEl} class="mg-modal mg-modal--novel" role="dialog" aria-modal="true" aria-label={$_("bookToNovel_eyebrow")} tabindex="-1" data-book-to-novel use:glideHeight>
    <header class="mg-header">
      <span class="mg-header-cover">
        {#if coverSrc}<img src={coverSrc} alt="" onerror={markBrokenImage} />{/if}
      </span>
      <div class="mg-heading">
        <h2 class="mg-title" title={book.title}>{book.title}</h2>
        <p class="mg-subtitle">{step === "source" || !selectedSource ? $_("bookToNovel_subtitle") : selectedSource.name}</p>
      </div>
      <button bind:this={closeButtonEl} class="mg-close" type="button" onclick={onClose} disabled={applying} aria-label={$_("ui_closeMigrationModal")}><X size={16} weight="bold" /></button>
    </header>

    <div class="mg-body">
      {#key step}<div class="mg-step" use:enterOnMount={{ y: 10, blur: 4, duration: 560 }}>
      {#if step === "source"}
        <MigrationSourcePicker
          sources={sourceOptions}
          loading={loadingSources || (classifying && sourceOptions.length === 0)}
          emptyLabel={$_("novelMigrate.noSafeTarget")}
          onPick={pickSource}
        />
        {#if error}
          <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("ui_migration")} title={$_("ui_searchFailed")} body={error} />
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

      {:else if selectedTarget && preview}
        <MigrationConfirm
          from={{ title: book.title, caption: book.author ?? book.subtype.toUpperCase(), coverSrc }}
          to={{
            title: selectedTarget.title,
            caption: preview.alreadyInLibrary ? `${selectedSource?.name ?? $_("ui_targetSource")} · ${$_("bookToNovel_alreadyInLibrary")}` : selectedSource?.name ?? $_("ui_targetSource"),
            coverSrc: selectedTarget.coverUrl,
          }}
          warning={confirmWarning}
          note={$_("bookToNovel_bookKept")}
          {error}
          errorTitle={$_("bookToNovel_failed")}
        >
          {#snippet summary()}
            <span data-book-to-novel-landing title={preview?.match.chapter?.title}>{preview?.match.chapter && !preview.keepsExistingProgress
              ? $_("bookToNovel_resumeSummary", { chapter: preview.match.chapter.title, read: preview.readCount })
              : $_("bookToNovel_fromStart")}</span>
          {/snippet}
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
      {:else}
        <button class="mg-btn" type="button" onclick={() => step = "search"} disabled={applying}><ArrowLeft size={15} weight="bold" class="mg-arrow-back" /> {$_("ui_back")}</button>
        <span class="mg-spacer"></span>
        <button class="mg-btn mg-btn--primary" type="button" disabled={applying} onclick={apply} data-book-to-novel-apply>
          {#if applying}
            <CircleNotch size={15} weight="bold" class="anim-spin" /> {$_("bookToNovel_adding")}
          {:else}
            {$_("bookToNovel_apply")} <ArrowRight size={15} weight="bold" class="mg-arrow-next" />
          {/if}
        </button>
      {/if}
    </footer>
  </div>
</div>
