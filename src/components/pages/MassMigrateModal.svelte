<script lang="ts">
  import { untrack } from "svelte";
  import {
    ArrowRight,
    Check,
    CircleNotch,
    DotsThreeVertical,
    MagnifyingGlass,
    Warning,
    X,
  } from "phosphor-svelte";
  import { gql } from "../../lib/client";
  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import { resolveMangaCoverUrl } from "../../lib/manga/coverResolver";
  import { fetchSourceMangaSearchWithFallback } from "../../lib/manga/sourceSearch";
  import {
    GET_CHAPTERS,
    GET_LIBRARY,
    GET_SOURCES_WITH_EXTENSIONS,
  } from "../../lib/queries";
  import {
    applyMassMangaMigrationWithJournal,
    buildMangaMigrationMatch,
    previewMassMangaMigration,
    undoMangaMigration,
    updateMassMangaMigrationPreviewItem,
    type MassMangaMigrationPreview,
    type MassMangaMigrationPreviewItem,
  } from "../../lib/migration/manga";
  import { ensureServerAwakeFor } from "../../lib/serverLifecycle";
  import { waitForSuwayomiGraphqlReady } from "../../lib/suwayomiReadiness";
  import { addToast, store } from "../../store/state.svelte";
  import type { Chapter, Manga, Source } from "../../lib/types";
  import type { ManagedExtension } from "../../lib/managedExtensions";

  interface Props {
    extension: ManagedExtension;
    installedExtensionPkgNames?: string[];
    onClose: () => void;
    onCompleted?: () => void;
  }

  let { extension, installedExtensionPkgNames = [], onClose, onCompleted = () => {} }: Props = $props();

  type Step = "origin" | "target" | "review" | "migrating";
  type RuntimeStatus = "excluded" | "migrating" | "migrated" | "copied" | "failed";

  const storagePrefix = "aethon-manga-mass-migration";
  const storageVersion = 3;

  let step: Step = $state("origin");
  let loading = $state(true);
  let error: string | null = $state(null);
  let sources: Source[] = $state([]);
  let originSource: Source | null = $state(null);
  let targetSource: Source | null = $state(null);
  let sourceItems: Array<{ manga: Manga; chapters: Chapter[] }> = $state([]);
  let preview: MassMangaMigrationPreview | null = $state(null);
  let selectedIds = $state<Set<number>>(new Set());
  let runtimeStatuses = $state(new Map<number, RuntimeStatus>());
  let runtimeErrors = $state(new Map<number, string>());
  let searchFilter = $state("");
  let manualQuery = $state(new Map<number, string>());
  let manualSearching = $state(new Set<number>());
  let manualResults = $state(new Map<number, Manga[]>());
  let buildingPreview = $state(false);
  let applying = $state(false);
  let previewProgress = $state<{ stage: string; done: number; total: number } | null>(null);
  let activeActionsMenuId: number | null = $state(null);
  let manualSearchOpen = $state(new Set<number>());

  const preferredSourceLang = $derived(normalizeLang(store.settings.preferredExtensionLang || "en"));
  const installedExtensionPackages = $derived(new Set(installedExtensionPkgNames));
  const originSources = $derived.by(() => pickBestSourcesByExtension(
    sources.filter((source) => source.extension?.pkgName === extension.pkgName && isInstalledExtensionSource(source)),
    preferredSourceLang,
  ));
  const targetSources = $derived.by(() => {
    if (!originSource) return [];
    const originPkg = sourcePackageName(originSource);
    return pickBestSourcesByExtension(
      sources.filter((source) => (
        isInstalledExtensionSource(source)
        && source.id !== originSource.id
        && sourcePackageName(source) !== originPkg
      )),
      preferredSourceLang,
      originSource.lang,
    );
  });
  const targetSourceGroups = $derived.by(() => {
    const groups = new Map<string, { name: string; sources: Source[] }>();
    for (const source of targetSources) {
      const key = sourcePackageName(source);
      const current = groups.get(key) ?? {
        name: source.extension?.name ?? source.displayName,
        sources: [],
      };
      current.sources.push(source);
      groups.set(key, current);
    }
    return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name));
  });
  const selectedMigratableCount = $derived(
    preview?.items.filter((item) => selectedIds.has(item.currentManga.id) && canSelect(item)).length ?? 0,
  );
  const visiblePreviewItems = $derived.by(() => {
    const query = searchFilter.trim().toLowerCase();
    const items = preview?.items ?? [];
    if (!query) return items;
    return items.filter((item) => (
      item.currentManga.title.toLowerCase().includes(query)
      || item.match?.manga.title.toLowerCase().includes(query)
      || item.reasonCode.toLowerCase().includes(query)
    ));
  });
  const visibleSelectableIds = $derived(
    visiblePreviewItems.filter((item) => canSelect(item)).map((item) => item.currentManga.id),
  );
  const allVisibleSelectableSelected = $derived(
    visibleSelectableIds.length > 0 && visibleSelectableIds.every((id) => selectedIds.has(id)),
  );

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && activeActionsMenuId !== null) {
      activeActionsMenuId = null;
      return;
    }
    if (event.key === "Escape") onClose();
  }

  function storageKey(sourceFrom: string, sourceTo: string) {
    return `${storagePrefix}:${sourceFrom}:${sourceTo}`;
  }

  function normalizeLang(lang?: string | null) {
    return (lang ?? "").trim().toLowerCase();
  }

  function sourcePackageName(source: Source) {
    return source.extension?.pkgName ?? "";
  }

  function isInstalledExtensionSource(source: Source) {
    const pkgName = sourcePackageName(source);
    return source.id !== "0"
      && pkgName.length > 0
      && (installedExtensionPackages.size === 0 || installedExtensionPackages.has(pkgName));
  }

  function languageRank(source: Source, preferredLang: string, originLang?: string | null) {
    const lang = normalizeLang(source.lang);
    const preferred = normalizeLang(preferredLang);
    const origin = normalizeLang(originLang);
    if (preferred && lang === preferred) return 0;
    if (origin && lang === origin) return 1;
    if (preferred.includes("-") && lang === preferred.split("-")[0]) return 2;
    if (origin.includes("-") && lang === origin.split("-")[0]) return 3;
    if (lang === "en") return 4;
    if (lang === "all") return 5;
    return 20;
  }

  function compareSourcePreference(left: Source, right: Source, preferredLang: string, originLang?: string | null) {
    const rankDelta = languageRank(left, preferredLang, originLang) - languageRank(right, preferredLang, originLang);
    if (rankDelta !== 0) return rankDelta;
    const leftExtensionLang = normalizeLang(left.extension?.lang);
    const rightExtensionLang = normalizeLang(right.extension?.lang);
    const preferred = normalizeLang(preferredLang);
    if (leftExtensionLang === preferred && rightExtensionLang !== preferred) return -1;
    if (rightExtensionLang === preferred && leftExtensionLang !== preferred) return 1;
    return left.displayName.localeCompare(right.displayName) || normalizeLang(left.lang).localeCompare(normalizeLang(right.lang));
  }

  function pickBestSourcesByExtension(sourceList: Source[], preferredLang: string, originLang?: string | null) {
    const byPackage = new Map<string, Source[]>();
    for (const source of sourceList) {
      const pkgName = sourcePackageName(source);
      if (!pkgName) continue;
      const group = byPackage.get(pkgName) ?? [];
      group.push(source);
      byPackage.set(pkgName, group);
    }
    return [...byPackage.values()]
      .map((group) => [...group].sort((left, right) => compareSourcePreference(left, right, preferredLang, originLang))[0])
      .filter((source): source is Source => Boolean(source))
      .sort((left, right) => (left.extension?.name ?? left.displayName).localeCompare(right.extension?.name ?? right.displayName));
  }

  async function attemptWakeWithDeadline(timeoutMs = 3500) {
    const wake = ensureServerAwakeFor("sources", {
      serverUrl: store.runtimeServerUrl ?? store.settings.serverUrl,
      binary: store.settings.serverBinary,
      updateIntensity: store.settings.libraryUpdateIntensity,
      profileId: store.runtimeResolvedLocalProfileId,
      profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? store.runtimeServerLabel,
    }).catch(() => false);
    let timeoutId: number | undefined;
    const deadline = new Promise<boolean>((resolve) => {
      timeoutId = window.setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      await Promise.race([wake, deadline]);
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }
  }

  async function mapLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await run(items[currentIndex]!);
      }
    });
    await Promise.all(workers);
    return results;
  }

  function saveDraft(nextPreview = preview, _nextSelectedIds = selectedIds, nextStatuses = runtimeStatuses) {
    if (!originSource || !targetSource || !nextPreview || typeof localStorage === "undefined") return;
    const persistentStatuses = [...nextStatuses.entries()].filter(([, status]) => (
      status === "migrated" || status === "copied" || status === "failed"
    ));
    localStorage.setItem(storageKey(originSource.id, targetSource.id), JSON.stringify({
      version: storageVersion,
      preview: nextPreview,
      runtimeStatuses: persistentStatuses,
    }));
  }

  function restoreDraft(sourceFrom: string, sourceTo: string) {
    if (typeof localStorage === "undefined") return false;
    const raw = localStorage.getItem(storageKey(sourceFrom, sourceTo));
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw) as {
        version?: number;
        preview?: MassMangaMigrationPreview;
        selectedIds?: number[];
        runtimeStatuses?: Array<[number, RuntimeStatus]>;
      };
      if (parsed.version !== storageVersion || !parsed.preview) return false;
      preview = parsed.preview;
      runtimeStatuses = new Map((parsed.runtimeStatuses ?? []).filter(([, status]) => status === "migrated" || status === "copied" || status === "failed"));
      selectedIds = new Set(parsed.preview.items.filter((item) => canSelectWithRuntime(item, runtimeStatuses)).map((item) => item.currentManga.id));
      step = "review";
      return true;
    } catch {
      return false;
    }
  }

  async function loadInitialState() {
    loading = true;
    error = null;
    try {
      await attemptWakeWithDeadline();
      const ready = await waitForSuwayomiGraphqlReady("sources", { attempts: 8, delayMs: 800, timeoutMs: 5000 });
      if (!ready) throw new Error("Suwayomi is still starting. Try mass migration again in a moment.");

      const data = await gql<{ sources: { nodes: Source[] } }>(GET_SOURCES_WITH_EXTENSIONS, undefined, undefined, 15000);
      const nextSources = data.sources.nodes ?? [];
      sources = nextSources;
      const matchingSources = pickBestSourcesByExtension(
        nextSources.filter((source) => source.extension?.pkgName === extension.pkgName && isInstalledExtensionSource(source)),
        preferredSourceLang,
      );
      if (matchingSources.length === 1) {
        originSource = matchingSources[0];
        step = "target";
        await loadSourceLibrary(matchingSources[0]);
      }
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : String(loadError);
    } finally {
      loading = false;
    }
  }

  async function loadSourceLibrary(source: Source) {
    const library = await gql<{ mangas: { nodes: Manga[] } }>(GET_LIBRARY, undefined, undefined, 20000);
    const mangas = (library.mangas.nodes ?? []).filter((manga) => (
      manga.inLibrary
      && (manga.source?.id === source.id || manga.sourceId === source.id)
    ));
    sourceItems = mangas.map((manga) => ({ manga, chapters: [] }));
  }

  async function hydrateSourceItemChapters(items: Array<{ manga: Manga; chapters: Chapter[] }>) {
    let done = 0;
    previewProgress = { stage: "Loading chapters", done, total: items.length };
    return mapLimited(items, 5, async (item) => {
      try {
        if (item.chapters.length > 0) return item;
        const chapters = await gql<{ chapters: { nodes: Chapter[] } }>(GET_CHAPTERS, { mangaId: item.manga.id }, undefined, 15000);
        return { manga: item.manga, chapters: chapters.chapters.nodes ?? [] };
      } finally {
        done += 1;
        previewProgress = { stage: "Loading chapters", done, total: items.length };
      }
    });
  }

  async function pickOrigin(source: Source) {
    originSource = source;
    targetSource = null;
    preview = null;
    selectedIds = new Set();
    runtimeStatuses = new Map();
    runtimeErrors = new Map();
    error = null;
    step = "target";
    loading = true;
    try {
      await loadSourceLibrary(source);
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : String(loadError);
    } finally {
      loading = false;
    }
  }

  function pickTarget(source: Source) {
    if (!originSource) return;
    targetSource = source;
    error = null;
    preview = null;
    selectedIds = new Set();
    runtimeStatuses = new Map();
    runtimeErrors = new Map();
    restoreDraft(originSource.id, source.id);
  }

  async function buildPreview() {
    if (!originSource || !targetSource) return;
    buildingPreview = true;
    previewProgress = { stage: "Preparing", done: 0, total: sourceItems.length };
    error = null;
    preview = null;
    selectedIds = new Set();
    runtimeStatuses = new Map();
    runtimeErrors = new Map();
    try {
      const hydratedItems = await hydrateSourceItemChapters(sourceItems);
      sourceItems = hydratedItems;
      previewProgress = { stage: "Searching matches", done: 0, total: hydratedItems.length };
      const nextPreview = await previewMassMangaMigration({
        sourceFrom: originSource.id,
        sourceTo: targetSource.id,
        items: hydratedItems,
        onItemDone: (done, total) => {
          previewProgress = { stage: "Searching matches", done, total };
        },
      });
      preview = nextPreview;
      selectedIds = new Set(
        nextPreview.items
          .filter((item) => item.status === "matched")
          .map((item) => item.currentManga.id),
      );
      step = "review";
      saveDraft(nextPreview, selectedIds, runtimeStatuses);
    } catch (previewError) {
      error = previewError instanceof Error ? previewError.message : String(previewError);
    } finally {
      buildingPreview = false;
      previewProgress = null;
    }
  }

  function statusLabel(item: MassMangaMigrationPreviewItem) {
    const runtime = runtimeStatuses.get(item.currentManga.id);
    if (runtime === "excluded") return "Excluded";
    if (runtime === "migrating") return "Migrating";
    if (runtime === "migrated") return "Migrated";
    if (runtime === "copied") return "Copied";
    if (runtime === "failed") return "Failed";
    if (item.status === "matched") return item.reasonCode === "manual_match" ? "Manual match" : "Ready";
    if (item.status === "needs_review") return "Needs review";
    if (item.status === "no_match") return "No match";
    if (item.reasonCode === "Stub!") return "Search unavailable";
    return "Search failed";
  }

  function issueReasonLabel(item: MassMangaMigrationPreviewItem) {
    if (item.status !== "no_match" && item.status !== "search_failed") return "";
    if (item.reasonCode === "no_match_found") return "No matching title found on this source.";
    if (item.reasonCode === "Stub!") return `${targetSource?.displayName ?? "Target source"} cannot search titles through Suwayomi right now.`;
    if (item.reasonCode.startsWith("Timed out while searching")) return item.reasonCode;
    return item.reasonCode || "This item could not be searched automatically.";
  }

  function isItemSelected(item: MassMangaMigrationPreviewItem) {
    return selectedIds.has(item.currentManga.id);
  }

  function canSelect(item: MassMangaMigrationPreviewItem) {
    return canSelectWithRuntime(item, runtimeStatuses);
  }

  function canSelectWithRuntime(item: MassMangaMigrationPreviewItem, statuses: Map<number, RuntimeStatus>) {
    const runtime = statuses.get(item.currentManga.id);
    return Boolean(item.match)
      && item.status !== "no_match"
      && item.status !== "search_failed"
      && runtime !== "migrated"
      && runtime !== "copied"
      && runtime !== "excluded";
  }

  function toggleItem(item: MassMangaMigrationPreviewItem, event?: MouseEvent) {
    event?.stopPropagation();
    if (!canSelect(item)) return;
    const next = new Set(selectedIds);
    if (next.has(item.currentManga.id)) next.delete(item.currentManga.id);
    else next.add(item.currentManga.id);
    selectedIds = next;
    saveDraft(preview, next, runtimeStatuses);
  }

  function excludeItem(item: MassMangaMigrationPreviewItem) {
    const nextStatuses = new Map(runtimeStatuses);
    nextStatuses.set(item.currentManga.id, "excluded");
    runtimeStatuses = nextStatuses;
    const nextSelected = new Set(selectedIds);
    nextSelected.delete(item.currentManga.id);
    selectedIds = nextSelected;
    activeActionsMenuId = null;
    saveDraft(preview, nextSelected, nextStatuses);
  }

  function toggleAllVisibleMatches() {
    if (!preview) return;
    const next = new Set(selectedIds);
    if (allVisibleSelectableSelected) {
      for (const id of visibleSelectableIds) next.delete(id);
    } else {
      for (const id of visibleSelectableIds) next.add(id);
    }
    selectedIds = next;
    saveDraft(preview, next, runtimeStatuses);
  }

  async function retryItem(item: MassMangaMigrationPreviewItem) {
    if (!originSource || !targetSource || !preview) return;
    const nextErrors = new Map(runtimeErrors);
    nextErrors.delete(item.currentManga.id);
    runtimeErrors = nextErrors;
    const nextStatuses = new Map(runtimeStatuses);
    nextStatuses.delete(item.currentManga.id);
    runtimeStatuses = nextStatuses;
    const singlePreview = await previewMassMangaMigration({
      sourceFrom: originSource.id,
      sourceTo: targetSource.id,
      items: [{ manga: item.currentManga, chapters: item.currentChapters }],
    });
    const replacement = singlePreview.items[0];
    const nextPreview = {
      ...preview,
      items: preview.items.map((entry) => entry.currentManga.id === item.currentManga.id ? replacement : entry),
    };
    nextPreview.readyCount = nextPreview.items.filter((entry) => entry.status === "matched").length;
    nextPreview.needsReviewCount = nextPreview.items.filter((entry) => entry.status === "needs_review").length;
    nextPreview.blockedCount = nextPreview.items.filter((entry) => entry.status === "no_match" || entry.status === "search_failed").length;
    preview = nextPreview;
    if (replacement.status === "matched") {
      selectedIds = new Set([...selectedIds, replacement.currentManga.id]);
    }
    activeActionsMenuId = null;
    saveDraft(preview, selectedIds, nextStatuses);
  }

  function toggleActionsMenu(item: MassMangaMigrationPreviewItem) {
    activeActionsMenuId = activeActionsMenuId === item.currentManga.id ? null : item.currentManga.id;
  }

  function openManualSearch(item: MassMangaMigrationPreviewItem) {
    const next = new Set(manualSearchOpen);
    next.add(item.currentManga.id);
    manualSearchOpen = next;
    activeActionsMenuId = null;
  }

  function setManualQuery(mangaId: number, value: string) {
    const next = new Map(manualQuery);
    next.set(mangaId, value);
    manualQuery = next;
  }

  async function searchManual(item: MassMangaMigrationPreviewItem) {
    if (!targetSource) return;
    const query = (manualQuery.get(item.currentManga.id) ?? item.currentManga.title).trim();
    if (!query) return;
    const searching = new Set(manualSearching);
    searching.add(item.currentManga.id);
    manualSearching = searching;
    try {
      const results = await fetchSourceMangaSearchWithFallback({ sourceId: targetSource.id, query });
      const next = new Map(manualResults);
      next.set(item.currentManga.id, results);
      manualResults = next;
    } catch (searchError) {
      const nextErrors = new Map(runtimeErrors);
      nextErrors.set(item.currentManga.id, searchError instanceof Error ? searchError.message : String(searchError));
      runtimeErrors = nextErrors;
    } finally {
      const nextSearching = new Set(manualSearching);
      nextSearching.delete(item.currentManga.id);
      manualSearching = nextSearching;
    }
  }

  async function chooseManualMatch(item: MassMangaMigrationPreviewItem, manga: Manga) {
    if (!preview) return;
    const match = await buildMangaMigrationMatch(item.currentManga, manga);
    const nextPreview = updateMassMangaMigrationPreviewItem(preview, item.currentManga.id, match);
    preview = nextPreview;
    selectedIds = new Set([...selectedIds, item.currentManga.id]);
    const nextStatuses = new Map(runtimeStatuses);
    nextStatuses.delete(item.currentManga.id);
    runtimeStatuses = nextStatuses;
    const nextManualOpen = new Set(manualSearchOpen);
    nextManualOpen.delete(item.currentManga.id);
    manualSearchOpen = nextManualOpen;
    saveDraft(nextPreview, selectedIds, nextStatuses);
  }

  async function applySelected(mode: "migrate" | "copy" = "migrate", explicitIds?: number[]) {
    if (!preview || !targetSource) return;
    const selectedMigrationIds = new Set(
      preview.items
        .filter((item) => (explicitIds ? explicitIds.includes(item.currentManga.id) : selectedIds.has(item.currentManga.id)) && canSelect(item))
        .map((item) => item.currentManga.id),
    );
    if (selectedMigrationIds.size === 0) return;
    applying = true;
    step = "migrating";
    error = null;
    activeActionsMenuId = null;
    runtimeStatuses = new Map([...runtimeStatuses, ...[...selectedMigrationIds].map((id) => [id, "migrating" as const])]);
    try {
      const result = await applyMassMangaMigrationWithJournal({
        preview,
        selectedMangaIds: [...selectedMigrationIds],
        mode,
      });
      const completedDraftKey = storageKey(preview.sourceFrom, preview.sourceTo);
      runtimeStatuses = new Map([
        ...runtimeStatuses,
        ...result.migratedSourceMangaIds.map((id) => [id, mode === "copy" ? "copied" as const : "migrated" as const] satisfies [number, RuntimeStatus]),
        ...result.failedItems.map(({ mangaId }) => [mangaId, "failed" as const] satisfies [number, RuntimeStatus]),
      ]);
      const nextErrors = new Map(runtimeErrors);
      for (const failedItem of result.failedItems) nextErrors.set(failedItem.mangaId, failedItem.message);
      runtimeErrors = nextErrors;
      saveDraft(preview, selectedIds, runtimeStatuses);
      if (result.migratedCount > 0 && result.failedItems.length === 0) {
        localStorage.removeItem(completedDraftKey);
      }
      addToast({
        kind: result.failedItems.length ? "error" : "success",
        title: result.failedItems.length ? "Mass migration partially complete" : mode === "copy" ? "Mass copy complete" : "Mass migration complete",
        body: `${result.migratedCount} ${mode === "copy" ? "copied" : "moved"} to ${targetSource.displayName}; ${result.failedItems.length} failed.`,
        duration: result.journalEntryId ? 30000 : 9000,
        action: result.journalEntryId ? {
          label: "Undo",
          run: () => {
            void undoMangaMigration(result.journalEntryId!).then(() => {
              localStorage.removeItem(completedDraftKey);
              addToast({ kind: "info", title: mode === "copy" ? "Mass copy undone" : "Mass migration undone", body: `${result.migratedCount} title${result.migratedCount === 1 ? "" : "s"}` });
              onCompleted();
            }).catch((undoError) => {
              addToast({
                kind: "error",
                title: "Could not undo mass migration",
                body: undoError instanceof Error ? undoError.message : String(undoError),
              });
            });
          },
        } : undefined,
      });
      if (result.migratedCount > 0 && result.failedItems.length === 0) onCompleted();
    } catch (migrationError) {
      const message = migrationError instanceof Error ? migrationError.message : String(migrationError);
      error = message;
      runtimeStatuses = new Map([...runtimeStatuses, ...[...selectedMigrationIds].map((id) => [id, "failed" as const])]);
      const nextErrors = new Map(runtimeErrors);
      for (const id of selectedMigrationIds) nextErrors.set(id, message);
      runtimeErrors = nextErrors;
      saveDraft(preview, selectedIds, runtimeStatuses);
    } finally {
      applying = false;
      step = "review";
    }
  }

  $effect(() => {
    untrack(() => { void loadInitialState(); });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" onclick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
  <div class="modal">
    <header class="modalHeader">
      <div>
        <p>Mass migration</p>
        <h2>{extension.name}</h2>
      </div>
      <button class="iconButton" type="button" onclick={onClose} aria-label="Close mass migration">
        <X size={15} weight="bold" />
      </button>
    </header>

    <div class="steps" aria-label="Migration steps">
      <span class:active={step === "origin"}>Origin</span>
      <span class:active={step === "target"}>Target</span>
      <span class:active={step === "review"}>Review</span>
      <span class:active={step === "migrating"}>Migrate</span>
    </div>

    {#if loading}
      <div class="center"><CircleNotch size={18} weight="bold" class="anim-spin" /></div>
    {:else if error && !preview}
      <div class="center errorPanel">
        <Warning size={18} weight="bold" />
        <strong>{error}</strong>
        <button class="primaryButton" type="button" onclick={loadInitialState}>Retry</button>
      </div>
    {:else if step === "origin"}
      <section class="pane">
        <div class="paneIntro">
          <strong>Choose source from {extension.name}</strong>
          <span>{originSources.length} source{originSources.length === 1 ? "" : "s"} installed for this extension.</span>
        </div>
        <div class="sourceList">
          {#if originSources.length === 0}
            <p class="emptyLine">No installed source is linked to this extension.</p>
          {:else}
            {#each originSources as source}
              <button class="sourceRow" type="button" onclick={() => pickOrigin(source)}>
                <img src={resolveServiceIconUrl(source, { kind: "source" })} alt="" onerror={(event) => applyServiceIconFallback(event, "source")} />
                <span>{source.displayName}</span>
                <small>{source.lang.toUpperCase()}</small>
                <ArrowRight size={14} weight="bold" />
              </button>
            {/each}
          {/if}
        </div>
      </section>
    {:else if step === "target"}
      <section class="pane">
        <div class="paneIntro">
          <strong>{originSource?.displayName ?? extension.name}</strong>
          <span>{sourceItems.length} library title{sourceItems.length === 1 ? "" : "s"} will be compared with the target source.</span>
        </div>
        <div class="sourceList">
          {#if targetSourceGroups.length === 0}
            <p class="emptyLine">No alternative installed source is available.</p>
          {:else}
            {#each targetSourceGroups as group}
              <div class="sourceGroup">
                <span>{group.name}</span>
                {#each group.sources as source}
                  <button class="sourceRow" class:selected={targetSource?.id === source.id} type="button" onclick={() => pickTarget(source)}>
                    <img src={resolveServiceIconUrl(source, { kind: "source" })} alt="" onerror={(event) => applyServiceIconFallback(event, "source")} />
                    <span>{source.displayName}</span>
                    <small>{source.lang.toUpperCase()}</small>
                    <ArrowRight size={14} weight="bold" />
                  </button>
                {/each}
              </div>
            {/each}
          {/if}
        </div>
        <footer class="modalFooter">
          <button class="secondaryButton" type="button" onclick={() => step = "origin"}>Back</button>
          <button class="primaryButton" type="button" disabled={!targetSource || sourceItems.length === 0 || buildingPreview} onclick={buildPreview}>
            {#if buildingPreview}<CircleNotch size={13} weight="bold" class="anim-spin" />{:else}<MagnifyingGlass size={13} weight="bold" />{/if}
            {#if buildingPreview && previewProgress}
              {previewProgress.stage} {previewProgress.done}/{previewProgress.total}
            {:else}
              Search matches
            {/if}
          </button>
        </footer>
      </section>
    {:else if preview}
      <section class="reviewPane">
        <div class="reviewToolbar">
          <div>
            <strong>{originSource?.displayName} to {targetSource?.displayName}</strong>
            <span>{preview.readyCount} ready, {preview.needsReviewCount} needs review, {preview.blockedCount} need attention</span>
          </div>
          <div class="toolbarActions">
            <input bind:value={searchFilter} placeholder="Filter queue..." />
            <button class="secondaryButton bulkSelectButton" type="button" onclick={toggleAllVisibleMatches} disabled={visibleSelectableIds.length === 0}>
              {allVisibleSelectableSelected ? "Deselect all" : "Select all matches"}
            </button>
          </div>
        </div>

        {#if error}
          <p class="errorLine"><Warning size={13} weight="bold" /> {error}</p>
        {/if}

        <div class="queueList">
          {#each visiblePreviewItems as item}
            {@const runtime = runtimeStatuses.get(item.currentManga.id)}
            {@const match = item.match}
            {@const sourceLabel = item.currentManga.source?.displayName ?? originSource?.displayName ?? "Source"}
            {@const targetLabel = match?.manga.source?.displayName ?? targetSource?.displayName ?? "Target"}
            {@const sourceStatus = item.currentManga.status ?? "UNKNOWN"}
            {@const targetStatus = match?.manga.status ?? "UNKNOWN"}
            {@const selected = selectedIds.has(item.currentManga.id)}
            <article class="queueItem" class:queueItemMuted={runtime === "excluded"} class:queueItemDone={runtime === "migrated" || runtime === "copied"}>
              <div class="queueMain">
                <div class="migrationPair">
                  <div class="miniManga libraryLikeCard">
                    <button class="checkButton" class:checkButtonSelected={selected || runtime === "migrated" || runtime === "copied"} type="button" disabled={!canSelect(item)} onclick={(event) => toggleItem(item, event)} aria-label={`Select ${item.currentManga.title}`}>
                      {#if runtime === "migrated" || runtime === "copied"}<Check size={15} weight="bold" />{:else if selected}<Check size={15} weight="bold" />{/if}
                    </button>
                    <img class="cover" src={resolveMangaCoverUrl(item.currentManga, { context: "migration", persistence: "memory" })} alt="" />
                    <div class="cardCopy">
                      <strong>{item.currentManga.title}</strong>
                      <span><b>{sourceLabel}</b><em>{sourceStatus}</em></span>
                    </div>
                  </div>
                  <span class="pairArrow"><ArrowRight size={28} weight="bold" /></span>
                  <div class="miniManga libraryLikeCard">
                    {#if match}
                      <img class="cover" src={resolveMangaCoverUrl(match.manga, { context: "migration", persistence: "memory" })} alt="" />
                    {:else}
                      <div class="cover noCover"><Warning size={16} weight="bold" /></div>
                    {/if}
                    <div class="cardCopy">
                      <strong>{match?.manga.title ?? statusLabel(item)}</strong>
                      <span><b>{targetLabel}</b><em>{targetStatus}</em></span>
                    </div>
                    <div class="itemActions">
                      <button class="iconButton actionTrigger" type="button" onclick={() => toggleActionsMenu(item)} aria-label={`Actions for ${item.currentManga.title}`}>
                        <DotsThreeVertical size={19} weight="bold" />
                      </button>
                      {#if activeActionsMenuId === item.currentManga.id}
                        <div class="actionMenu">
                          {#if canSelect(item)}
                            <button type="button" onclick={() => applySelected("migrate", [item.currentManga.id])}>Migrate now</button>
                            <button type="button" onclick={() => applySelected("copy", [item.currentManga.id])}>Copy now</button>
                          {/if}
                          <button type="button" onclick={() => retryItem(item)}>Retry</button>
                          <button type="button" onclick={() => openManualSearch(item)}>Search</button>
                          <button type="button" onclick={() => excludeItem(item)}>Exclude</button>
                        </div>
                      {/if}
                    </div>
                  </div>
                </div>
                {#if issueReasonLabel(item)}
                  <small class="itemNote">{issueReasonLabel(item)}</small>
                {/if}
                {#if runtimeErrors.get(item.currentManga.id)}
                  <small class="itemError">{runtimeErrors.get(item.currentManga.id)}</small>
                {/if}
                {#if manualSearchOpen.has(item.currentManga.id)}
                  <div class="manualSearch">
                    <input
                      value={manualQuery.get(item.currentManga.id) ?? item.currentManga.title}
                      oninput={(event) => setManualQuery(item.currentManga.id, (event.currentTarget as HTMLInputElement).value)}
                      onkeydown={(event) => event.key === "Enter" && searchManual(item)}
                      placeholder="Search manually..."
                    />
                    <button class="secondaryButton" type="button" disabled={manualSearching.has(item.currentManga.id)} onclick={() => searchManual(item)}>
                      {manualSearching.has(item.currentManga.id) ? "Searching..." : "Search"}
                    </button>
                  </div>
                  {#if manualResults.get(item.currentManga.id)?.length}
                    <div class="manualResults">
                      {#each manualResults.get(item.currentManga.id) ?? [] as result}
                        <button type="button" onclick={() => chooseManualMatch(item, result)}>
                          {result.title}
                        </button>
                      {/each}
                    </div>
                  {/if}
                {/if}
              </div>
            </article>
          {/each}
        </div>

        <footer class="modalFooter">
          <button class="secondaryButton" type="button" onclick={() => step = applying ? "review" : "target"}>{applying ? "Back to review" : "Back"}</button>
          <button class="primaryButton" type="button" onclick={() => applySelected("migrate")} disabled={applying || selectedMigratableCount === 0}>
            {#if applying}<CircleNotch size={13} weight="bold" class="anim-spin" />{:else}<Check size={13} weight="bold" />{/if}
            Migrate selected ({selectedMigratableCount})
          </button>
        </footer>
      </section>
    {/if}
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; z-index: 230; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.68); backdrop-filter: blur(14px); }
  .modal { width: min(800px, calc(100vw - 48px)); height: min(690px, calc(100vh - 64px)); display: flex; flex-direction: column; overflow: hidden; border-radius: 16px; border: 1px solid rgba(255,255,255,0.08); background: rgba(18, 17, 22, 0.98); box-shadow: 0 24px 80px rgba(0,0,0,0.48); }
  .modalHeader, .reviewToolbar, .modalFooter, .sourceRow, .queueItem, .toolbarActions, .manualSearch, .manualResults, .itemActions, .steps, .migrationPair { display: flex; align-items: center; }
  .modalHeader { justify-content: space-between; gap: 14px; padding: 14px 18px; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .modalHeader p { margin: 0 0 2px; font-family: var(--font-ui); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(202,196,208,0.54); }
  .modalHeader h2 { margin: 0; font-size: 17px; color: rgba(244,241,243,0.94); }
  .iconButton { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; color: rgba(229,226,225,0.68); border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03); }
  .steps { gap: 8px; padding: 9px 18px; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .steps span { font-family: var(--font-ui); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(202,196,208,0.38); }
  .steps span.active { color: var(--accent-fg); }
  .center { flex: 1; display: grid; place-items: center; gap: 12px; color: rgba(229,226,225,0.72); text-align: center; }
  .errorPanel { padding: 40px; }
  .pane, .reviewPane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .paneIntro { display: grid; gap: 4px; padding: 14px 18px; color: rgba(229,226,225,0.78); }
  .paneIntro strong, .reviewToolbar strong { color: rgba(244,241,243,0.92); }
  .paneIntro span, .reviewToolbar span { color: rgba(202,196,208,0.58); }
  .sourceList, .queueList { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 18px 18px; display: grid; align-content: start; gap: 6px; }
  .sourceGroup { display: grid; gap: 6px; }
  .sourceGroup > span { padding: 7px 4px 2px; font-size: 10px; font-weight: 800; text-transform: uppercase; color: rgba(202,196,208,0.46); }
  .emptyLine { margin: 20px 4px; color: rgba(202,196,208,0.58); text-align: center; }
  .sourceRow { width: 100%; gap: 10px; text-align: left; padding: 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.025); color: rgba(229,226,225,0.82); }
  .sourceRow:hover, .sourceRow.selected { border-color: rgba(184,167,234,0.26); background: rgba(184,167,234,0.08); }
  .sourceRow img { width: 28px; height: 28px; border-radius: 8px; object-fit: cover; }
  .sourceRow span { flex: 1; min-width: 0; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sourceRow small { color: rgba(202,196,208,0.52); }
  .reviewToolbar { justify-content: space-between; gap: 14px; padding: 12px 18px; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .reviewToolbar > div:first-child { display: grid; gap: 3px; }
  .toolbarActions { gap: 8px; }
  input { min-height: 32px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.08); background: rgba(7,7,11,0.44); color: rgba(244,241,243,0.9); padding: 0 10px; outline: none; }
  input:focus { border-color: rgba(184,167,234,0.34); }
  .queueItem { position: relative; display: block; padding: 12px; border-radius: 11px; border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.022); }
  .queueItemMuted { opacity: 0.48; }
  .queueItemDone { border-color: color-mix(in srgb, var(--color-success) 24%, rgba(255,255,255,0.06)); }
  .checkButton { position: absolute; left: 10px; top: 10px; z-index: 2; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 11px; border: 1px solid rgba(199,181,255,0.54); color: rgba(235,229,255,0.96); background: linear-gradient(135deg, rgba(25,20,37,0.86), rgba(70,55,105,0.58)); box-shadow: 0 0 0 1px rgba(0,0,0,0.36), 0 0 22px rgba(151,126,225,0.3), inset 0 1px 0 rgba(255,255,255,0.12); backdrop-filter: blur(14px) saturate(1.12); }
  .checkButton:hover:not(:disabled) { border-color: rgba(222,211,255,0.78); background: linear-gradient(135deg, rgba(33,26,49,0.92), rgba(91,72,135,0.68)); box-shadow: 0 0 0 1px rgba(0,0,0,0.42), 0 0 28px rgba(171,148,238,0.42), inset 0 1px 0 rgba(255,255,255,0.16); }
  .checkButtonSelected { color: #f3efff; border-color: rgba(231,222,255,0.9); background: linear-gradient(135deg, rgba(69,52,109,0.96), rgba(156,130,232,0.74)); box-shadow: 0 0 0 1px rgba(0,0,0,0.45), 0 0 30px rgba(184,167,234,0.56), inset 0 1px 0 rgba(255,255,255,0.22); }
  .checkButton:disabled { color: rgba(210,202,224,0.6); border-color: rgba(199,181,255,0.3); background: linear-gradient(135deg, rgba(24,20,34,0.72), rgba(58,48,76,0.42)); box-shadow: 0 0 0 1px rgba(0,0,0,0.24), 0 0 14px rgba(151,126,225,0.14); cursor: not-allowed; }
  .queueMain { flex: 1; min-width: 0; display: grid; gap: 7px; }
  .migrationPair { min-width: 0; width: 100%; display: grid; grid-template-columns: minmax(180px, 210px) 1fr 48px 1fr minmax(180px, 210px); align-items: start; gap: 0; }
  .miniManga { position: relative; min-width: 0; }
  .libraryLikeCard { width: min(210px, 100%); display: grid; align-content: start; gap: 8px; }
  .libraryLikeCard:first-child { grid-column: 1; justify-self: start; }
  .libraryLikeCard:last-child { grid-column: 5; justify-self: end; }
  .cardCopy { min-width: 0; display: grid; gap: 5px; }
  .cardCopy strong { color: rgba(244,241,243,0.92); font-size: 13px; line-height: 1.2; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .cardCopy span { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; font-family: var(--font-ui); font-size: 10px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; color: rgba(202,196,208,0.58); }
  .cardCopy b, .cardCopy em { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: normal; }
  .cardCopy b { flex: 1; }
  .cardCopy em { flex: 0 0 auto; color: rgba(202,196,208,0.72); }
  .pairArrow {
    place-self: center;
    grid-column: 3;
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 999px;
    color: var(--accent-fg);
    background: radial-gradient(circle, rgba(196,177,255,0.2) 0%, rgba(184,167,234,0.1) 58%, rgba(184,167,234,0.03) 100%);
    border: 1px solid rgba(184,167,234,0.22);
    box-shadow: 0 0 24px rgba(184,167,234,0.28), inset 0 0 14px rgba(184,167,234,0.08);
  }
  .cover { width: 100%; aspect-ratio: 2 / 3; border-radius: 9px; object-fit: cover; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); }
  .noCover { display: grid; place-items: center; color: rgba(202,196,208,0.52); }
  .itemNote { color: rgba(202,196,208,0.56); font-size: 11px; }
  .itemError { color: var(--color-error); font-size: 11px; }
  .manualSearch { gap: 8px; margin-top: 1px; }
  .manualSearch input { flex: 1; }
  .manualResults { gap: 6px; flex-wrap: wrap; }
  .manualResults button { border-radius: 999px; border: 1px solid rgba(184,167,234,0.2); background: rgba(184,167,234,0.08); color: var(--accent-fg); padding: 4px 9px; font-size: 11px; }
  .itemActions { position: absolute; right: 10px; top: 10px; z-index: 2; }
  .actionTrigger { width: 34px; height: 34px; border-radius: 11px; color: rgba(235,229,255,0.96); border-color: rgba(199,181,255,0.54); background: linear-gradient(135deg, rgba(25,20,37,0.86), rgba(70,55,105,0.58)); box-shadow: 0 0 0 1px rgba(0,0,0,0.36), 0 0 22px rgba(151,126,225,0.3), inset 0 1px 0 rgba(255,255,255,0.12); backdrop-filter: blur(14px) saturate(1.12); }
  .actionTrigger:hover { border-color: rgba(222,211,255,0.78); background: linear-gradient(135deg, rgba(33,26,49,0.92), rgba(91,72,135,0.68)); box-shadow: 0 0 0 1px rgba(0,0,0,0.42), 0 0 28px rgba(171,148,238,0.42), inset 0 1px 0 rgba(255,255,255,0.16); }
  .actionMenu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 3; min-width: 118px; display: grid; padding: 5px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.09); background: rgba(21,20,26,0.98); box-shadow: 0 14px 36px rgba(0,0,0,0.42); }
  .actionMenu button { width: 100%; text-align: left; border: 0; border-radius: 8px; padding: 7px 9px; color: rgba(229,226,225,0.78); background: transparent; font-size: 12px; font-weight: 800; }
  .actionMenu button:hover { background: rgba(184,167,234,0.1); color: var(--accent-fg); }
  .modalFooter { justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid rgba(255,255,255,0.06); }
  .primaryButton, .secondaryButton { min-height: 32px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-radius: 10px; font-family: var(--font-ui); font-size: 12px; font-weight: 800; }
  .primaryButton { color: #211933; background: var(--n-primary); border: 1px solid rgba(255,255,255,0.14); padding: 0 14px; }
  .secondaryButton { color: rgba(229,226,225,0.7); background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.075); padding: 0 10px; }
  .bulkSelectButton { font-family: "Manrope", "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 12px; font-weight: 800; letter-spacing: 0.01em; text-transform: none; -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
  .primaryButton:disabled, .secondaryButton:disabled { opacity: 0.45; }
  .errorLine { display: flex; align-items: center; gap: 8px; margin: 10px 18px 0; color: var(--color-error); font-size: 12px; }
</style>
