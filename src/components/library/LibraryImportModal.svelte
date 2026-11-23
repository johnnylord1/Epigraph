<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import {
    ArrowRight,
    BookOpen,
    CaretDown,
    Check,
    CircleNotch,
    DotsThreeVertical,
    DownloadSimple,
    Folder,
    MagnifyingGlass,
    Plugs,
    TrayArrowDown,
    X,
  } from "phosphor-svelte";
  import { onMount } from "svelte";
  import { createDialogFocusBoundary } from "../../lib/accessibility/dialogFocus";
  import { resolveMangaCoverUrl } from "../../lib/manga/coverResolver";
  import { enterOnMount, glideHeight, popIn, popOut } from "../../lib/motion/motion";
  import { store } from "../../store/state.svelte";
  import {
    analyzeShareImport,
    applyShareImport,
    installShareImportExtension,
    resolveIncomingShareManifest,
    searchAllMissingWorksInInstalledSources,
    searchWorkInInstalledSources,
    type ShareImportExtensionItem,
    type ShareImportPlan,
    type ShareImportWorkRow,
  } from "../../lib/library/shareImport";
  import { floatMenu } from "../pages/migrationMenu";
  import "../pages/migrationModal.css";

  interface Props {
    rawLink: string;
    onClose: () => void;
    onImported?: (addedCount: number) => void;
  }

  let { rawLink, onClose, onImported }: Props = $props();

  const FILTER_FROM = 8;

  let overlayEl = $state<HTMLDivElement | null>(null);
  let modalEl = $state<HTMLDivElement | null>(null);
  let closeButtonEl = $state<HTMLButtonElement | null>(null);
  let folderPickerButton = $state<HTMLButtonElement | null>(null);

  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let plan = $state<ShareImportPlan | null>(null);
  let works = $state<ShareImportWorkRow[]>([]);
  let extensions = $state<ShareImportExtensionItem[]>([]);
  let installingSourceIds = $state(new Set<string>());
  let extensionErrors = $state(new Map<string, string>());
  let batchSearching = $state(false);
  let importing = $state(false);
  let importError = $state<string | null>(null);
  let folderPickerOpen = $state(false);
  let selectedExtraCategoryIds = $state<number[]>([]);
  let searchFilter = $state("");
  let openMenuWorkKey = $state<string | null>(null);

  const controller = new AbortController();

  const missingExtensions = $derived(extensions.filter((ext) => ext.status !== "installed"));
  const installableMissingExtensions = $derived(
    missingExtensions.filter((ext) => ext.status === "available" || ext.status === "needs_repo"),
  );
  const installedSources = $derived(plan?.installedSources ?? []);
  const categories = $derived((plan?.categories ?? []).filter((category) => category.id > 0));
  const defaultCategoryId = $derived(
    categories.find((category) => category.id === store.settings.defaultLibraryCategoryId)?.id ?? null,
  );
  const extraCategories = $derived(categories.filter((category) => category.id !== defaultCategoryId));
  const selectedExtraCategories = $derived(
    extraCategories.filter((category) => selectedExtraCategoryIds.includes(category.id)),
  );

  const alreadyOwnedCount = $derived(
    works.filter((work) => work.alreadyInLibrary || work.ownedInOtherSource !== null).length,
  );
  const selectableWorks = $derived(
    works.filter(
      (work) => !work.isLocal && !work.alreadyInLibrary && (work.extensionStatus === "installed" || work.chosenAlternative !== null),
    ),
  );
  const selectedCount = $derived(selectableWorks.filter((work) => work.selected).length);
  const missingSourceWorksCount = $derived(
    works.filter(
      (work) => !work.isLocal && !work.alreadyInLibrary && !work.ownedInOtherSource && work.extensionStatus !== "installed" && !work.chosenAlternative,
    ).length,
  );
  const showFilter = $derived(works.length > FILTER_FROM || searchFilter.length > 0);
  const visibleWorks = $derived.by(() => {
    const needle = searchFilter.trim().toLowerCase();
    if (!needle) return works;
    return works.filter(
      (work) =>
        work.title.toLowerCase().includes(needle)
        || work.sourceName.toLowerCase().includes(needle)
        || (work.chosenAlternative?.sourceName.toLowerCase().includes(needle) ?? false)
        || (work.ownedInOtherSource?.sourceName.toLowerCase().includes(needle) ?? false),
    );
  });

  function isWorkReady(work: ShareImportWorkRow): boolean {
    return !work.isLocal && !work.alreadyInLibrary && (work.extensionStatus === "installed" || work.chosenAlternative !== null);
  }

  function coverUrlFor(mangaId?: number | null, thumbnailUrl?: string | null): string | null {
    if (!thumbnailUrl && !mangaId) return null;
    const resolved = resolveMangaCoverUrl(
      { id: mangaId ?? 0, thumbnailUrl: thumbnailUrl ?? "" },
      { context: "migration", persistence: "memory" },
    );
    return resolved || null;
  }

  function markBrokenImage(event: Event) {
    (event.currentTarget as HTMLImageElement).dataset.broken = "true";
  }

  function onKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    if (folderPickerOpen) {
      folderPickerOpen = false;
      folderPickerButton?.focus();
      return;
    }
    if (openMenuWorkKey !== null) {
      openMenuWorkKey = null;
      return;
    }
    if (!importing) onClose();
  }

  $effect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function hydratePlan(keepAlternatives = false) {
    const previousByKey = new Map(works.map((work) => [work.key, work] as const));
    const manifest = plan?.manifest ?? (await resolveIncomingShareManifest(rawLink));
    const next = await analyzeShareImport(manifest);
    if (controller.signal.aborted) return;

    plan = next;
    extensions = next.extensions;
    works = next.works.map((work) => {
      if (!keepAlternatives) return work;
      const previous = previousByKey.get(work.key);
      if (!previous) return work;
      const becameInstalled = work.extensionStatus === "installed" && previous.extensionStatus !== "installed";
      return {
        ...work,
        candidates: previous.candidates,
        searchDone: previous.searchDone,
        chosenAlternative: work.extensionStatus === "installed" ? null : previous.chosenAlternative,
        selected: becameInstalled ? (!work.alreadyInLibrary && !work.ownedInOtherSource && !work.isLocal) : previous.selected,
      };
    });
  }

  onMount(() => {
    void (async () => {
      try {
        await hydratePlan(false);
      } catch {
        if (!controller.signal.aborted) loadError = $_("library.import.loadFailed");
      } finally {
        if (!controller.signal.aborted) loading = false;
      }
    })();

    const releaseFocus = overlayEl && modalEl
      ? createDialogFocusBoundary({ dialog: modalEl, isolationRoot: overlayEl, initialFocus: closeButtonEl })
      : undefined;

    return () => {
      controller.abort();
      releaseFocus?.();
    };
  });

  function setWorkSelected(key: string, selected: boolean) {
    openMenuWorkKey = null;
    works = works.map((work) => (work.key === key && isWorkReady(work) ? { ...work, selected } : work));
  }

  async function installOneExtension(ext: ShareImportExtensionItem) {
    if (installingSourceIds.has(ext.sourceId) || importing) return;
    const nextInstalling = new Set(installingSourceIds);
    nextInstalling.add(ext.sourceId);
    installingSourceIds = nextInstalling;

    const nextErrors = new Map(extensionErrors);
    nextErrors.delete(ext.sourceId);
    extensionErrors = nextErrors;

    try {
      const outcome = await installShareImportExtension(ext);
      if (!outcome.installed) {
        const failed = new Map(extensionErrors);
        failed.set(ext.sourceId, $_("library.import.extensionInstallFailed"));
        extensionErrors = failed;
        return;
      }
      await hydratePlan(true);
    } catch {
      const failed = new Map(extensionErrors);
      failed.set(ext.sourceId, $_("library.import.extensionInstallFailed"));
      extensionErrors = failed;
    } finally {
      const done = new Set(installingSourceIds);
      done.delete(ext.sourceId);
      installingSourceIds = done;
    }
  }

  async function installAllMissingExtensions() {
    for (const ext of installableMissingExtensions) {
      if (controller.signal.aborted) return;
      await installOneExtension(ext);
    }
  }

  async function searchOneWork(target: ShareImportWorkRow) {
    if (target.searching || batchSearching || installedSources.length === 0 || importing) return;
    works = works.map((work) => (work.key === target.key ? { ...work, searching: true } : work));
    try {
      const candidates = await searchWorkInInstalledSources(target.title, installedSources, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      works = works.map((work) => (
        work.key === target.key
          ? {
            ...work,
            searching: false,
            searchDone: true,
            candidates,
            chosenAlternative: work.chosenAlternative ?? (isWorkReady(work) ? null : candidates[0] ?? null),
            selected: work.selected || (!isWorkReady(work) && !work.ownedInOtherSource && candidates.length > 0),
          }
          : work
      ));
    } catch {
      if (!controller.signal.aborted) {
        works = works.map((work) => (work.key === target.key ? { ...work, searching: false, searchDone: true } : work));
      }
    }
  }

  async function searchAllMissing() {
    if (batchSearching || installedSources.length === 0 || importing) return;
    openMenuWorkKey = null;
    batchSearching = true;
    try {
      await searchAllMissingWorksInInstalledSources(
        works,
        installedSources,
        (workKey, state) => {
          works = works.map((work) => {
            if (work.key !== workKey) return work;
            if (state.searching) return { ...work, searching: true };
            const candidates = state.candidates ?? [];
            const top = candidates[0] ?? null;
            return {
              ...work,
              searching: false,
              searchDone: true,
              candidates,
              chosenAlternative: top,
              selected: top !== null ? true : work.selected,
            };
          });
        },
        { signal: controller.signal },
      );
    } finally {
      if (!controller.signal.aborted) batchSearching = false;
    }
  }

  function pickAlternative(workKey: string, mangaId: number | null, selectOriginal = false) {
    openMenuWorkKey = null;
    works = works.map((work) => {
      if (work.key !== workKey) return work;
      if (mangaId === null) return { ...work, chosenAlternative: null, selected: selectOriginal };
      const match = work.candidates.find((candidate) => candidate.mangaId === mangaId) ?? null;
      return { ...work, chosenAlternative: match, selected: match !== null };
    });
  }

  function closeMenuOnEscape(event: KeyboardEvent) {
    if (event.key !== "Escape" || openMenuWorkKey === null) return;
    event.stopPropagation();
    const wrap = event.currentTarget as HTMLElement;
    openMenuWorkKey = null;
    wrap.querySelector<HTMLElement>(".mg-icon-btn")?.focus();
  }

  async function confirmImport() {
    if (importing || selectedCount === 0) return;
    folderPickerOpen = false;
    importing = true;
    importError = null;
    try {
      const categoryIds = selectedExtraCategories.map((category) => category.id);
      if (defaultCategoryId !== null) categoryIds.unshift(defaultCategoryId);
      const result = await applyShareImport(works, categoryIds);
      if (controller.signal.aborted) return;
      onImported?.(result.added);
      onClose();
    } catch {
      if (!controller.signal.aborted) importError = $_("library.import.importFailed");
    } finally {
      if (!controller.signal.aborted) importing = false;
    }
  }
</script>

<div bind:this={overlayEl} class="mg-overlay" data-library-import>
  <button
    class="mg-backdrop"
    type="button"
    aria-label={$_("common.close")}
    disabled={importing}
    onclick={() => { if (!importing) onClose(); }}
  ></button>
  <div
    bind:this={modalEl}
    class="mg-modal import-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="library-import-title"
    tabindex="-1"
    use:glideHeight
  >
    <header class="mg-header">
      <span class="mg-mark" aria-hidden="true">
        <TrayArrowDown size={18} weight="duotone" />
      </span>
      <div class="mg-heading">
        <h2 id="library-import-title" class="mg-title">{$_("library.import.title")}</h2>
        {#if !loading && !loadError}
          <p class="mg-subtitle">
            {$_("library.import.summary", { total: works.length, owned: alreadyOwnedCount })}
          </p>
        {/if}
      </div>
      <button
        bind:this={closeButtonEl}
        class="mg-close"
        type="button"
        onclick={onClose}
        disabled={importing}
        aria-label={$_("common.close")}
      >
        <X size={16} weight="bold" />
      </button>
    </header>

    <div class="mg-body">
      <div class="mg-step" use:enterOnMount={{ y: 8, blur: 3, duration: 420 }}>
        {#if loading}
          <div class="mg-list" aria-busy="true">
            {#each Array(4) as _, i (i)}
              <div class="mg-skeleton"></div>
            {/each}
          </div>
        {:else if loadError}
          <div class="mg-empty">
            <p class="mg-note is-warn" role="alert">{loadError}</p>
          </div>
        {:else}
          {#if missingExtensions.length > 0}
            <div class="mg-list mg-list--lead" aria-label={$_("library.import.extensionsHeading")}>
              {#if installedSources.length > 0 && missingSourceWorksCount > 0}
                <button
                  type="button"
                  class="mg-row mg-row--lead"
                  onclick={searchAllMissing}
                  disabled={batchSearching || importing}
                >
                  <span class="mg-mark">
                    {#if batchSearching}
                      <CircleNotch size={16} weight="bold" class="anim-spin" />
                    {:else}
                      <MagnifyingGlass size={16} weight="bold" />
                    {/if}
                  </span>
                  <span class="mg-row-copy">
                    <strong>{batchSearching ? $_("library.import.searchingAll") : $_("library.import.searchAllInstalled")}</strong>
                    <small>{$_("library.import.extensionsHeading")}</small>
                  </span>
                  <span class="mg-row-end" aria-hidden="true">
                    {#if batchSearching}
                      <CircleNotch size={16} weight="bold" class="anim-spin" />
                    {:else}
                      <ArrowRight size={16} weight="bold" />
                    {/if}
                  </span>
                </button>
              {/if}

              <div class="import-section-bar">
                <span class="import-section-label">{$_("library.import.extensionsHeading")}</span>
                {#if installableMissingExtensions.length > 1}
                  <button
                    type="button"
                    class="mg-btn import-quiet-btn"
                    onclick={installAllMissingExtensions}
                    disabled={installingSourceIds.size > 0 || importing}
                  >
                    <DownloadSimple size={14} weight="bold" />
                    {$_("library.import.installAllExtensions")}
                  </button>
                {/if}
              </div>

              {#each missingExtensions as ext, i (ext.sourceId)}
                {@const busy = installingSourceIds.has(ext.sourceId)}
                <div class="import-row" style:--mg-i={i}>
                  <span class="mg-mark" aria-hidden="true">
                    <Plugs size={16} weight="duotone" />
                  </span>
                  <span class="mg-row-copy">
                    <strong>{ext.extensionName || ext.sourceName}</strong>
                    {#if extensionErrors.has(ext.sourceId)}
                      <small class="import-err">{extensionErrors.get(ext.sourceId)}</small>
                    {:else if ext.status === "needs_repo"}
                      <small>{$_("library.import.repoAutoNotice", { repo: ext.repoLabel || ext.repoUrl || "" })}</small>
                    {:else if ext.status === "available"}
                      <small>{$_("library.import.extensionAvailable")}</small>
                    {:else}
                      <small>{$_("library.import.extensionUnavailable")}</small>
                    {/if}
                  </span>
                  {#if ext.status === "available" || ext.status === "needs_repo"}
                    <button
                      type="button"
                      class="mg-btn import-quiet-btn"
                      onclick={() => installOneExtension(ext)}
                      disabled={busy || importing}
                    >
                      {#if busy}
                        <CircleNotch size={14} weight="bold" class="anim-spin" />
                        {$_("library.import.installing")}
                      {:else}
                        <DownloadSimple size={14} weight="bold" />
                        {ext.status === "needs_repo"
                          ? $_("library.import.addRepoAndInstall")
                          : $_("library.import.installExtension")}
                      {/if}
                    </button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          <div class="mg-toolbar">
            {#if showFilter}
              <label class="mg-field">
                <MagnifyingGlass size={16} weight="bold" />
                <input
                  bind:value={searchFilter}
                  placeholder={$_("library.import.worksHeading")}
                  aria-label={$_("library.import.worksHeading")}
                />
              </label>
            {:else}
              <span class="import-section-label">{$_("library.import.worksHeading")}</span>
              <span class="mg-spacer"></span>
            {/if}
          </div>

          <div class="mg-queue">
            {#each visibleWorks as work, i (work.key)}
              {@const ready = isWorkReady(work)}
              {@const muted = work.alreadyInLibrary || work.isLocal}
              {@const skipped = ready && !work.selected}
              {@const hasActions = !muted && (ready || installedSources.length > 0)}
              {@const owned = work.ownedInOtherSource}
              {@const originalCover = coverUrlFor(work.existingMangaId, work.thumbnailUrl)}
              {@const alternative = work.chosenAlternative}
              {@const targetTitle = alternative?.title ?? work.title}
              <article
                class="mg-queue-item import-work has-comparison"
                class:is-muted={muted}
                class:is-pending={work.searching}
                style:--mg-i={i}
              >
                {#snippet thumbnail(url: string | null)}
                  <span class="mg-cover">
                    <BookOpen size={16} weight="duotone" />
                    {#if url}
                      {#key url}
                        <img src={url} alt="" loading="lazy" onerror={markBrokenImage} />
                      {/key}
                    {/if}
                  </span>
                {/snippet}

                {#if !work.alreadyInLibrary && !owned}
                  <span class="mg-side">
                    <span class="mg-cover" aria-hidden="true"></span>
                    <span class="mg-pill import-pill-muted">{$_("library.import.notInLibrary")}</span>
                  </span>
                {:else}
                  <span class="mg-side">
                    {@render thumbnail(owned ? coverUrlFor(owned.mangaId, owned.thumbnailUrl) : originalCover)}
                    <span class="mg-row-copy">
                      <strong title={owned?.title ?? work.title}>{owned?.title ?? work.title}</strong>
                      <small>{owned?.sourceName ?? work.sourceName}</small>
                      <span class="mg-pill" class:import-pill-muted={!owned} class:mg-pill--warn={Boolean(owned)}>
                        {$_("library.import.alreadyInLibrary")}
                      </span>
                    </span>
                  </span>
                {/if}

                <span class="mg-queue-arrow" aria-hidden="true">
                  <ArrowRight size={14} weight="bold" />
                </span>

                <span class="mg-side mg-side--target" class:is-dim={muted || skipped}>
                  {@render thumbnail(alternative ? coverUrlFor(alternative.mangaId, alternative.thumbnailUrl) : originalCover)}
                  <span class="mg-row-copy">
                    <strong class:is-quiet={muted || skipped} title={targetTitle}>{targetTitle}</strong>
                    {#if !work.isLocal}<small>{alternative?.sourceName ?? work.sourceName}</small>{/if}
                    {#if work.alreadyInLibrary}
                      <span class="mg-pill import-pill-muted">{$_("library.import.alreadyInLibrary")}</span>
                    {:else if work.isLocal}
                      <span class="mg-pill import-pill-muted">{$_("library.import.localUnavailable")}</span>
                    {:else if work.searching}
                      <span class="mg-pill">
                        <CircleNotch size={12} weight="bold" class="anim-spin" />
                        {$_("library.import.searchingOne")}
                      </span>
                    {:else if ready && work.selected}
                      <span class="mg-pill mg-pill--good">{$_("library.import.ready")}</span>
                    {:else if ready}
                      <span class="mg-pill import-pill-muted">{$_("library.import.skipWork")}</span>
                    {:else}
                      <span class="mg-pill mg-pill--warn">
                        {work.searchDone ? $_("library.import.notFoundInstalled") : $_("library.import.missingExtension")}
                      </span>
                    {/if}
                  </span>
                </span>

                {#if hasActions}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div class="mg-menu-wrap" onkeydown={closeMenuOnEscape}>
                      <button
                        type="button"
                        class="mg-icon-btn"
                        onclick={() => {
                          folderPickerOpen = false;
                          openMenuWorkKey = openMenuWorkKey === work.key ? null : work.key;
                        }}
                        disabled={importing || work.searching || batchSearching}
                        aria-haspopup="menu"
                        aria-expanded={openMenuWorkKey === work.key}
                        aria-label={$_("massMigration.actionsForTitle", { values: { title: work.title } })}
                      >
                        <DotsThreeVertical size={18} weight="bold" />
                      </button>
                      {#if openMenuWorkKey === work.key}
                        <div
                          class="mg-menu import-menu"
                          role="menu"
                          use:floatMenu={() => { openMenuWorkKey = null; }}
                          in:popIn
                          out:popOut
                        >
                          {#if ready && !work.selected}
                            <button
                              type="button"
                              role="menuitem"
                              onclick={() => setWorkSelected(work.key, true)}
                            >
                              <span>{$_("library.import.usingSource", { source: alternative?.sourceName ?? work.sourceName })}</span>
                            </button>
                          {/if}
                          {#if installedSources.length > 0}
                            <button
                              type="button"
                              role="menuitem"
                              disabled={work.searching}
                              onclick={() => {
                                openMenuWorkKey = null;
                                void searchOneWork(work);
                              }}
                            >
                              {$_(work.searchDone ? "massMigration.retry" : "library.import.searchInstalled")}
                            </button>
                          {/if}
                          {#if work.chosenAlternative && work.extensionStatus === "installed"}
                            <button type="button" role="menuitem" onclick={() => pickAlternative(work.key, null, true)}>
                              <span>{work.sourceName} — {work.title}</span>
                            </button>
                          {/if}
                          {#if work.selected}
                            <button
                              type="button"
                              role="menuitem"
                              onclick={() => setWorkSelected(work.key, false)}
                            >
                              {$_("library.import.skipWork")}
                            </button>
                          {/if}
                          {#each work.candidates as candidate (candidate.mangaId)}
                            <button
                              type="button"
                              role="menuitem"
                              class:is-active={work.selected && work.chosenAlternative?.mangaId === candidate.mangaId}
                              onclick={() => pickAlternative(work.key, candidate.mangaId)}
                            >
                              <span>{candidate.sourceName} — {candidate.title}</span>
                              {#if work.selected && work.chosenAlternative?.mangaId === candidate.mangaId}
                                <Check size={13} weight="bold" />
                              {/if}
                            </button>
                          {/each}
                        </div>
                      {/if}
                    </div>
                {/if}
              </article>
            {/each}
          </div>

          {#if importError}
            <p class="mg-note is-warn" role="alert">{importError}</p>
          {/if}
        {/if}
      </div>
    </div>

    <footer class="mg-footer">
      {#if !loading && !loadError && extraCategories.length > 0}
        <div class="mg-menu-wrap">
          <button
            bind:this={folderPickerButton}
            class="mg-btn import-folder-trigger"
            type="button"
            aria-expanded={folderPickerOpen}
            aria-controls={folderPickerOpen ? "library-import-extra-folders" : undefined}
            onclick={() => {
              openMenuWorkKey = null;
              folderPickerOpen = !folderPickerOpen;
            }}
            disabled={importing}
          >
            <Folder size={13} weight="bold" aria-hidden="true" />
            <span>
              {$_("library.import.extraFolders") + (selectedExtraCategories.length ? ` (${selectedExtraCategories.length})` : "")}
            </span>
            <CaretDown size={10} weight="bold" aria-hidden="true" />
          </button>
          {#if folderPickerOpen}
            <div
              id="library-import-extra-folders"
              class="mg-menu import-folder-options"
              role="group"
              aria-label={$_("library.import.extraFolders")}
              use:floatMenu={() => { folderPickerOpen = false; }}
            >
              {#each extraCategories as category (category.id)}
                <label class="import-folder-option">
                  <input type="checkbox" value={category.id} bind:group={selectedExtraCategoryIds} />
                  <span>{category.name}</span>
                </label>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <button type="button" class="mg-btn" onclick={onClose} disabled={importing}>
          {$_("common.close")}
        </button>
      {/if}
      <span class="mg-spacer"></span>
      <button
        type="button"
        class="mg-btn mg-btn--primary"
        onclick={confirmImport}
        disabled={loading || Boolean(loadError) || importing || selectedCount === 0}
      >
        {#if importing}
          <CircleNotch size={15} weight="bold" class="anim-spin" />
        {/if}
        {importing
          ? $_("library.import.importing")
          : selectedCount === 1
            ? $_("library.import.addOne")
            : $_("library.import.addMany", { count: selectedCount })}
      </button>
    </footer>
  </div>
</div>

<style>
  .import-modal .mg-header {
    padding: 14px 16px 10px;
  }

  .import-modal .mg-body {
    gap: 8px;
    padding: 10px 16px;
  }

  .import-modal .mg-footer {
    padding: 10px 16px 12px;
  }

  .import-work {
    --component-migration-queue-cover-width: 48px;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) 32px;
    gap: 8px;
    padding-block: 4px;
  }

  .import-work.is-muted {
    opacity: 1;
  }

  .import-work .mg-side--target.is-dim {
    opacity: 0.55;
  }

  .mg-cover > :global(svg),
  .mg-cover > img {
    grid-area: 1 / 1;
  }

  .import-work .mg-row-copy strong {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    white-space: normal;
  }

  .import-work .mg-pill {
    min-height: 0;
    white-space: normal;
  }

  @media (max-width: 640px) {
    .import-work {
      grid-template-columns: minmax(0, 1fr) 32px;
    }

    .import-work .mg-menu-wrap,
    .import-work .mg-icon-btn {
      grid-column: 2;
      grid-row: 1;
    }
  }

  .import-section-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 8px 0;
  }

  .import-section-label {
    color: var(--component-migration-muted-fg);
    font-size: var(--text-xs);
    font-weight: 650;
  }

  .import-quiet-btn {
    min-height: 30px;
    padding: 0 10px;
    font-size: var(--text-xs);
  }

  .import-row {
    width: 100%;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px;
    border-radius: var(--component-migration-row-radius);
    background: transparent;
    transition: background var(--component-migration-transition-fast);
    animation: mg-item-in var(--component-migration-animation-scale) backwards;
    animation-delay: calc(min(var(--mg-i, 0), 12) * 24ms);
  }

  .import-row:hover {
    background: var(--component-migration-surface);
  }

  .import-row .mg-row-copy small {
    white-space: normal;
  }

  .import-err {
    color: var(--component-migration-bad-fg);
  }

  .import-pill-muted {
    color: var(--component-migration-muted-fg);
    font-weight: 550;
  }

  .import-folder-trigger {
    width: 160px;
    min-height: 30px;
    justify-content: flex-start;
    gap: 6px;
    padding: 0 8px;
    background: var(--component-migration-surface);
    font-size: var(--text-xs);
  }

  .import-folder-trigger span {
    flex: 1;
    text-align: left;
  }

  .import-folder-options {
    width: 160px;
    max-height: min(184px, 40vh);
    overflow-y: auto;
  }

  .import-folder-option {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 26px;
    padding: 4px 6px;
    border-radius: var(--component-migration-menu-item-radius);
    color: var(--component-migration-menu-item-fg);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
    cursor: pointer;
  }

  .import-folder-option:hover,
  .import-folder-option:focus-within {
    background: var(--component-migration-menu-item-hover-bg);
  }

  .import-folder-option input {
    flex: none;
    width: 13px;
    height: 13px;
    accent-color: var(--component-migration-primary-bg);
  }

  .import-menu {
    min-width: 220px;
    max-width: 320px;
    max-height: min(320px, 40vh);
    overflow-y: auto;
  }

  .import-menu button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .import-menu button span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .import-menu button.is-active {
    color: var(--component-migration-accent-fg);
  }
</style>
