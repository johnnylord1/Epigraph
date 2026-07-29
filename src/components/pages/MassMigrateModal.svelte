<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    ArrowLeft,
    ArrowRight,
    Check,
    CircleNotch,
    DotsThreeVertical,
    MagnifyingGlass,
    Warning,
    X,
  } from "phosphor-svelte";
  import { _, translate } from "../../lib/i18n/runtime";
  import { gql } from "../../lib/client";
  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import { resolveMangaCoverUrl } from "../../lib/manga/coverResolver";
  import {
    fetchSourceMangaSearchWithFallback,
    isSourceMangaSearchUnavailableError,
    probeSourceMangaSearchCapability,
    type SourceMangaSearchCapability,
  } from "../../lib/manga/sourceSearch";
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
  import { setMigrationPresence } from "../../lib/discord";
  import { addToast, store } from "../../store/state.svelte";
  import type { Chapter, Manga, Source } from "../../lib/types";
  import type { ManagedExtension } from "../../lib/managedExtensions";
  import { createDialogFocusBoundary } from "../../lib/accessibility/dialogFocus";

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
  const storageVersion = 4;

  interface MassMigrationDraft {
    version: number;
    selectedIds: number[];
    runtimeStatuses: Array<[number, RuntimeStatus]>;
  }

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
  let manualSearchItemId: number | null = $state(null);
  let buildingPreview = $state(false);
  let applying = $state(false);
  let previewProgress = $state<{ stage: string; done: number; total: number } | null>(null);
  let activeActionsMenuId: number | null = $state(null);
  let pointerStartedOnOverlay = false;
  let restoredDraft: MassMigrationDraft | null = null;
  let targetSearchCapability = $state<SourceMangaSearchCapability | null>(null);
  let closeButtonEl: HTMLButtonElement | undefined = $state();
  let overlayEl: HTMLDivElement | undefined = $state();
  let modalEl: HTMLDivElement | undefined = $state();

  const dialogTitleId = "mass-migration-title";
  const dialogDescriptionId = "mass-migration-description";

  const preferredSourceLang = $derived(normalizeLang(store.settings.preferredExtensionLang || "en"));
  const installedExtensionPackages = $derived(new Set(installedExtensionPkgNames));
  const originSources = $derived.by(() => pickBestSourcesByExtension(
    sources.filter((source) => source.extension?.pkgName === extension.pkgName && isInstalledExtensionSource(source)),
    preferredSourceLang,
  ));
  const targetSources = $derived.by<Source[]>(() => {
    const origin = originSource;
    if (!origin) return [];
    const originPkg = sourcePackageName(origin);
    return pickBestSourcesByExtension(
      sources.filter((source) => (
        isInstalledExtensionSource(source)
        && source.id !== origin.id
        && sourcePackageName(source) !== originPkg
      )),
      preferredSourceLang,
      origin.lang,
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
  const selectedMigratableCount = $derived.by<number>(() => {
    const currentPreview = preview;
    return currentPreview
      ? currentPreview.items.filter((item) => selectedIds.has(item.currentManga.id) && canSelect(item)).length
      : 0;
  });
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
  const manualSearchItem = $derived.by(() => (
    manualSearchItemId === null ? null : preview?.items.find((item) => item.currentManga.id === manualSearchItemId) ?? null
  ));

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && activeActionsMenuId !== null) {
      activeActionsMenuId = null;
      return;
    }
    if (event.key === "Escape" && manualSearchItemId !== null) {
      closeManualSearch();
      return;
    }
    if (event.key === "Escape") onClose();
  }

  function handleOverlayPointerDown(event: PointerEvent) {
    pointerStartedOnOverlay = event.target === event.currentTarget;
  }

  function handleOverlayClick(event: MouseEvent) {
    if (pointerStartedOnOverlay && event.target === event.currentTarget) {
      onClose();
    }
    pointerStartedOnOverlay = false;
  }

  function stopModalPointerEvent(event: Event) {
    event.stopPropagation();
  }

  function storageKey(sourceFrom: string, sourceTo: string) {
    return `${storagePrefix}:${sourceFrom}:${sourceTo}`;
  }

  function safeLocalStorage(): Storage | null {
    try {
      return typeof window === "undefined" ? null : window.localStorage;
    } catch {
      return null;
    }
  }

  function cleanupLegacyDrafts() {
    const storage = safeLocalStorage();
    if (!storage) return;
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (!key?.startsWith(`${storagePrefix}:`)) continue;
      try {
        const parsed = JSON.parse(storage.getItem(key) ?? "{}") as { version?: number; preview?: unknown };
        if (parsed.version !== storageVersion || "preview" in parsed) {
          storage.removeItem(key);
        }
      } catch {
        storage.removeItem(key);
      }
    }
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
    const wake = ensureServerAwakeFor("browse", {
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

  function saveDraft(_nextPreview = preview, nextSelectedIds = selectedIds, nextStatuses = runtimeStatuses) {
    const storage = safeLocalStorage();
    if (!originSource || !targetSource || !storage) return;
    const persistentStatuses = [...nextStatuses.entries()].filter(([, status]) => (
      status === "migrated" || status === "copied" || status === "failed"
    ));
    const draft: MassMigrationDraft = {
      version: storageVersion,
      selectedIds: [...nextSelectedIds],
      runtimeStatuses: persistentStatuses,
    };
    try {
      storage.setItem(storageKey(originSource.id, targetSource.id), JSON.stringify(draft));
    } catch {
      // The migration itself is in-memory safe; draft persistence must never block the workflow.
    }
  }

  function loadDraft(sourceFrom: string, sourceTo: string): MassMigrationDraft | null {
    const storage = safeLocalStorage();
    if (!storage) return null;
    const key = storageKey(sourceFrom, sourceTo);
    const raw = storage.getItem(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<MassMigrationDraft> & { preview?: unknown };
      if (parsed.version !== storageVersion) {
        storage.removeItem(key);
        return null;
      }
      return {
        version: storageVersion,
        selectedIds: Array.isArray(parsed.selectedIds) ? parsed.selectedIds.filter((id) => Number.isFinite(id)) : [],
        runtimeStatuses: Array.isArray(parsed.runtimeStatuses)
          ? parsed.runtimeStatuses.filter((entry): entry is [number, RuntimeStatus] => (
            Array.isArray(entry)
            && Number.isFinite(entry[0])
            && (entry[1] === "migrated" || entry[1] === "copied" || entry[1] === "failed")
          ))
          : [],
      };
    } catch {
      storage.removeItem(key);
      return null;
    }
  }

  async function loadInitialState() {
    loading = true;
    error = null;
    try {
      await attemptWakeWithDeadline();
      const ready = await waitForSuwayomiGraphqlReady("sources", { attempts: 8, delayMs: 800, timeoutMs: 5000 });
      if (!ready) throw new Error(translate("massMigration.suwayomiStarting"));

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
    previewProgress = { stage: translate("massMigration.loadingChapters"), done, total: items.length };
    return mapLimited(items, 5, async (item) => {
      try {
        if (item.chapters.length > 0) return item;
        const chapters = await gql<{ chapters: { nodes: Chapter[] } }>(GET_CHAPTERS, { mangaId: item.manga.id }, undefined, 15000);
        return { manga: item.manga, chapters: chapters.chapters.nodes ?? [] };
      } finally {
        done += 1;
        previewProgress = { stage: translate("massMigration.loadingChapters"), done, total: items.length };
      }
    });
  }

  async function pickOrigin(source: Source) {
    originSource = source;
    targetSource = null;
    restoredDraft = null;
    targetSearchCapability = null;
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
    restoredDraft = loadDraft(originSource.id, source.id);
    targetSearchCapability = null;
    error = null;
    preview = null;
    selectedIds = new Set(restoredDraft?.selectedIds ?? []);
    runtimeStatuses = new Map(restoredDraft?.runtimeStatuses ?? []);
    runtimeErrors = new Map();
  }

  function sourceSearchCapabilityMessage(capability: SourceMangaSearchCapability, source = targetSource) {
    const name = source?.displayName ?? translate("massMigration.targetSource");
    if (capability.status === "ok") return "";
    if (capability.status === "unavailable") {
      return translate("massMigration.targetCannotSearch", { name });
    }
    if (isSourceMangaSearchUnavailableError(capability.message)) {
      return translate("massMigration.targetCannotSearch", { name });
    }
    return translate("massMigration.targetSearchFailed", { name, message: capability.message });
  }

  async function ensureTargetSearchCapability(items: Array<{ manga: Manga; chapters: Chapter[] }>) {
    if (!targetSource || items.length === 0) return true;
    if (targetSearchCapability?.status === "ok") return true;
    previewProgress = { stage: translate("massMigration.checkingTargetSource"), done: 0, total: 1 };
    const capability = await probeSourceMangaSearchCapability({
      sourceId: targetSource.id,
      query: items[0]?.manga.title ?? "test",
      timeoutMs: 9000,
    });
    targetSearchCapability = capability;
    if (capability.status === "ok") {
      return true;
    }
    error = sourceSearchCapabilityMessage(capability);
    return false;
  }

  async function buildPreview() {
    if (!originSource || !targetSource) return;
    buildingPreview = true;
    previewProgress = { stage: translate("massMigration.preparing"), done: 0, total: sourceItems.length };
    error = null;
    preview = null;
    selectedIds = new Set();
    const draft = restoredDraft ?? loadDraft(originSource.id, targetSource.id);
    runtimeStatuses = new Map(draft?.runtimeStatuses ?? []);
    runtimeErrors = new Map();
    try {
      const hydratedItems = await hydrateSourceItemChapters(sourceItems);
      sourceItems = hydratedItems;
      const canSearchTarget = await ensureTargetSearchCapability(hydratedItems);
      if (!canSearchTarget) return;
      previewProgress = { stage: translate("massMigration.searchingMatches"), done: 0, total: hydratedItems.length };
      const nextPreview = await previewMassMangaMigration({
        sourceFrom: originSource.id,
        sourceTo: targetSource.id,
        items: hydratedItems,
        onItemDone: (done, total) => {
          previewProgress = { stage: translate("massMigration.searchingMatches"), done, total };
        },
      });
      preview = nextPreview;
      const draftSelectedIds = new Set(draft?.selectedIds ?? []);
      selectedIds = new Set(nextPreview.items
        .filter((item) => (
          draftSelectedIds.size > 0
            ? draftSelectedIds.has(item.currentManga.id) && canSelectWithRuntime(item, runtimeStatuses)
            : item.status === "matched"
        ))
        .map((item) => item.currentManga.id));
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
    if (runtime === "excluded") return translate("massMigration.statusExcluded");
    if (runtime === "migrating") return translate("massMigration.statusMigrating");
    if (runtime === "migrated") return translate("massMigration.statusMigrated");
    if (runtime === "copied") return translate("massMigration.statusCopied");
    if (runtime === "failed") return translate("massMigration.statusFailed");
    if (item.status === "matched") return item.reasonCode === "manual_match" ? translate("massMigration.statusManualMatch") : translate("massMigration.statusReady");
    if (item.status === "needs_review") return translate("massMigration.statusNeedsReview");
    if (item.status === "no_match") return translate("massMigration.statusNoMatch");
    if (isSourceMangaSearchUnavailableError(item.reasonCode)) return translate("massMigration.statusSearchUnavailable");
    return translate("massMigration.statusSearchFailed");
  }

  function issueReasonLabel(item: MassMangaMigrationPreviewItem) {
    if (item.status !== "no_match" && item.status !== "search_failed") return "";
    if (item.reasonCode === "no_match_found") return translate("massMigration.noMatchingTitle");
    if (isSourceMangaSearchUnavailableError(item.reasonCode)) return translate("massMigration.targetCannotSearchNow", { name: targetSource?.displayName ?? translate("massMigration.targetSource") });
    if (item.reasonCode.startsWith("Timed out while searching")) return item.reasonCode;
    return item.reasonCode || translate("massMigration.itemSearchFailed");
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
      const canSearchTarget = await ensureTargetSearchCapability([{ manga: item.currentManga, chapters: item.currentChapters }]);
      if (!canSearchTarget) {
        const nextErrors = new Map(runtimeErrors);
        nextErrors.set(item.currentManga.id, error ?? translate("massMigration.targetSearchUnavailable", { name: targetSource.displayName }));
      runtimeErrors = nextErrors;
      activeActionsMenuId = null;
      return;
    }
    const nextErrors = new Map(runtimeErrors);
    nextErrors.delete(item.currentManga.id);
    runtimeErrors = nextErrors;
    const nextStatuses = new Map(runtimeStatuses);
    nextStatuses.delete(item.currentManga.id);
    runtimeStatuses = nextStatuses;
    if (manualSearchItemId === item.currentManga.id) manualSearchItemId = null;
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
    activeActionsMenuId = null;
    manualSearchItemId = item.currentManga.id;
    if (!manualQuery.has(item.currentManga.id)) {
      const next = new Map(manualQuery);
      next.set(item.currentManga.id, item.currentManga.title);
      manualQuery = next;
    }
    void searchManual(item);
  }

  function closeManualSearch() {
    manualSearchItemId = null;
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
      const nextErrors = new Map(runtimeErrors);
      nextErrors.delete(item.currentManga.id);
      runtimeErrors = nextErrors;
    } catch (searchError) {
      if (isSourceMangaSearchUnavailableError(searchError)) {
        targetSearchCapability = { status: "unavailable", message: searchError instanceof Error ? searchError.message : String(searchError) };
      }
      const nextErrors = new Map(runtimeErrors);
      nextErrors.set(item.currentManga.id, targetSearchCapability?.status === "unavailable" ? sourceSearchCapabilityMessage(targetSearchCapability) : searchError instanceof Error ? searchError.message : String(searchError));
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
    manualSearchItemId = null;
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
    void setMigrationPresence(true, store.settings, "library");
    activeActionsMenuId = null;
    runtimeStatuses = new Map([
      ...runtimeStatuses,
      ...[...selectedMigrationIds].map((id) => [id, "migrating"] satisfies [number, RuntimeStatus]),
    ]);
    try {
      const result = await applyMassMangaMigrationWithJournal({
        preview,
        selectedMangaIds: [...selectedMigrationIds],
        mode,
        profileId: store.runtimeResolvedLocalProfileId,
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
        safeLocalStorage()?.removeItem(completedDraftKey);
      }
      addToast({
        kind: result.failedItems.length ? "error" : "success",
        title: result.failedItems.length
          ? translate("massMigration.toastPartiallyComplete")
          : mode === "copy"
            ? translate("massMigration.toastCopyComplete")
            : translate("massMigration.toastMigrationComplete"),
        body: translate(mode === "copy" ? "massMigration.toastCopyBody" : "massMigration.toastMigrationBody", {
          count: result.migratedCount,
          target: targetSource.displayName,
          failed: result.failedItems.length,
        }),
        duration: result.journalEntryId ? 30000 : 9000,
        action: result.journalEntryId ? {
          label: translate("ui_undo"),
          run: () => {
            void undoMangaMigration(result.journalEntryId!).then(() => {
              safeLocalStorage()?.removeItem(completedDraftKey);
              addToast({
                kind: "info",
                title: mode === "copy" ? translate("massMigration.toastCopyUndone") : translate("ui_massMigrationUndone"),
                body: translate("massMigration.toastUndoBody", { count: result.migratedCount }),
              });
              onCompleted();
            }).catch((undoError) => {
              addToast({
                kind: "error",
                title: translate("ui_couldNotUndoMassMigration"),
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
      runtimeStatuses = new Map([
        ...runtimeStatuses,
        ...[...selectedMigrationIds].map((id) => [id, "failed"] satisfies [number, RuntimeStatus]),
      ]);
      const nextErrors = new Map(runtimeErrors);
      for (const id of selectedMigrationIds) nextErrors.set(id, message);
      runtimeErrors = nextErrors;
      saveDraft(preview, selectedIds, runtimeStatuses);
    } finally {
      void setMigrationPresence(false, store.settings, "library");
      applying = false;
      step = "review";
    }
  }

  $effect(() => {
    untrack(() => {
      cleanupLegacyDrafts();
      void loadInitialState();
    });
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

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={overlayEl} class="overlay" onpointerdown={handleOverlayPointerDown} onclick={handleOverlayClick}>
  <div
    bind:this={modalEl}
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby={dialogTitleId}
    aria-describedby={dialogDescriptionId}
    tabindex="-1"
    onpointerdown={stopModalPointerEvent}
    onclick={stopModalPointerEvent}
  >
    <header class="modalHeader">
      <div>
        <p>{$_("massMigration.title")}</p>
        <h2 id={dialogTitleId}>{extension.name}</h2>
        <span id={dialogDescriptionId} class="srOnly">{$_("massMigration.description")}</span>
      </div>
      <button bind:this={closeButtonEl} class="iconButton" type="button" onclick={onClose} aria-label={$_("massMigration.close")}>
        <X size={15} weight="bold" />
      </button>
    </header>

    <div class="steps" aria-label={$_("massMigration.steps")}>
      <span class:active={step === "origin"}>{$_("massMigration.stepOrigin")}</span>
      <span class:active={step === "target"}>{$_("massMigration.stepTarget")}</span>
      <span class:active={step === "review"}>{$_("massMigration.stepReview")}</span>
      <span class:active={step === "migrating"}>{$_("massMigration.stepMigrate")}</span>
    </div>

    {#if loading}
      <div class="center"><CircleNotch size={18} weight="bold" class="anim-spin" /></div>
    {:else if error && !preview && step !== "target"}
      <div class="center errorPanel">
        <Warning size={18} weight="bold" />
        <strong>{error}</strong>
        <button class="primaryButton" type="button" onclick={loadInitialState}>{$_("massMigration.retry")}</button>
      </div>
    {:else if step === "origin"}
      <section class="pane">
        <div class="paneIntro">
          <strong>{$_("massMigration.chooseSourceFrom", { values: { name: extension.name } })}</strong>
          <span>{$_("massMigration.installedSourcesForExtension", { values: { count: originSources.length } })}</span>
        </div>
        <div class="sourceList">
          {#if originSources.length === 0}
            <p class="emptyLine">{$_("massMigration.noLinkedInstalledSource")}</p>
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
          <span>{$_("massMigration.libraryTitlesCompared", { values: { count: sourceItems.length } })}</span>
        </div>
        <div class="sourceList">
          {#if targetSourceGroups.length === 0}
            <p class="emptyLine">{$_("massMigration.noAlternativeSource")}</p>
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
        {#if error}
          <p class="targetError"><Warning size={13} weight="bold" /> {error}</p>
        {/if}
        <footer class="modalFooter">
          <button class="secondaryButton" type="button" onclick={() => step = "origin"}>{$_("ui_back")}</button>
          <button class="primaryButton" type="button" disabled={!targetSource || sourceItems.length === 0 || buildingPreview} onclick={buildPreview}>
            {#if buildingPreview}<CircleNotch size={13} weight="bold" class="anim-spin" />{:else}<MagnifyingGlass size={13} weight="bold" />{/if}
            {#if buildingPreview && previewProgress}
              {previewProgress.stage} {previewProgress.done}/{previewProgress.total}
            {:else}
              {$_("massMigration.searchMatches")}
            {/if}
          </button>
        </footer>
      </section>
    {:else if preview}
      <section class="reviewPane">
        {#if manualSearchItem}
          <div class="manualSearchHeader">
            <button class="iconButton" type="button" onclick={closeManualSearch} aria-label={$_("massMigration.backToReview")}>
              <ArrowLeft size={15} weight="bold" />
            </button>
            <div>
              <span>{$_("massMigration.manualSearch")}</span>
              <strong>{manualSearchItem.currentManga.title}</strong>
            </div>
          </div>

          <div class="manualSearchTop">
            <input
              value={manualQuery.get(manualSearchItem.currentManga.id) ?? manualSearchItem.currentManga.title}
              oninput={(event) => setManualQuery(manualSearchItem.currentManga.id, (event.currentTarget as HTMLInputElement).value)}
              onkeydown={(event) => event.key === "Enter" && searchManual(manualSearchItem)}
              placeholder={$_("massMigration.searchTitleOnTarget")}
              aria-label={$_("massMigration.searchTitleOnTarget")}
            />
            <button class="primaryButton" type="button" disabled={manualSearching.has(manualSearchItem.currentManga.id)} onclick={() => searchManual(manualSearchItem)}>
              {#if manualSearching.has(manualSearchItem.currentManga.id)}
                <CircleNotch size={13} weight="bold" class="anim-spin" />
                {$_("ui_searching")}
              {:else}
                <MagnifyingGlass size={13} weight="bold" />
                {$_("novelSources_actions_search")}
              {/if}
            </button>
          </div>

          {#if runtimeErrors.get(manualSearchItem.currentManga.id)}
            <p class="errorLine"><Warning size={13} weight="bold" /> {runtimeErrors.get(manualSearchItem.currentManga.id)}</p>
          {/if}

          <div class="manualResultGrid">
            {#if manualSearching.has(manualSearchItem.currentManga.id)}
              <div class="manualEmpty">
                <CircleNotch size={18} weight="bold" class="anim-spin" />
                <span>{$_("massMigration.searchingTarget", { values: { name: targetSource?.displayName ?? $_("massMigration.targetSource") } })}</span>
              </div>
            {:else if manualResults.get(manualSearchItem.currentManga.id)?.length}
              {#each manualResults.get(manualSearchItem.currentManga.id) ?? [] as result}
                <button class="manualResultCard" type="button" onclick={() => chooseManualMatch(manualSearchItem, result)}>
                  <img class="cover" src={resolveMangaCoverUrl(result, { context: "migration", persistence: "memory" })} alt="" />
                  <span>{result.title}</span>
                  <small>{result.source?.displayName ?? targetSource?.displayName ?? $_("massMigration.targetSource")}</small>
                </button>
              {/each}
            {:else}
              <div class="manualEmpty">
                <MagnifyingGlass size={18} weight="bold" />
                <span>{$_("massMigration.noManualResults")}</span>
              </div>
            {/if}
          </div>

          <footer class="modalFooter">
            <button class="secondaryButton" type="button" onclick={closeManualSearch}>{$_("massMigration.backToReview")}</button>
          </footer>
        {:else}
        <div class="reviewToolbar">
          <div>
            <strong>{$_("massMigration.sourceToTarget", { values: { origin: originSource?.displayName, target: targetSource?.displayName } })}</strong>
            <span>{$_("massMigration.reviewCounts", { values: { ready: preview.readyCount, review: preview.needsReviewCount, attention: preview.blockedCount } })}</span>
          </div>
          <div class="toolbarActions">
            <input bind:value={searchFilter} placeholder={$_("massMigration.filterQueue")} aria-label={$_("massMigration.filterQueue")} />
            <button class="secondaryButton bulkSelectButton" type="button" onclick={toggleAllVisibleMatches} disabled={visibleSelectableIds.length === 0}>
              {allVisibleSelectableSelected ? $_("massMigration.deselectAll") : $_("massMigration.selectAllMatches")}
            </button>
          </div>
        </div>

        {#if error}
          <p class="errorLine"><Warning size={13} weight="bold" /> {error}</p>
        {/if}

        <div class="queueList">
          {#if visiblePreviewItems.length === 0}
            <p class="emptyLine">{$_("massMigration.noQueueMatches")}</p>
          {:else}
          {#each visiblePreviewItems as item}
            {@const runtime = runtimeStatuses.get(item.currentManga.id)}
            {@const match = item.match}
            {@const sourceLabel = item.currentManga.source?.displayName ?? originSource?.displayName ?? $_("massMigration.source")}
            {@const targetLabel = match?.manga.source?.displayName ?? targetSource?.displayName ?? $_("massMigration.targetSource")}
            {@const sourceStatus = item.currentManga.status ?? "UNKNOWN"}
            {@const targetStatus = match?.manga.status ?? "UNKNOWN"}
            {@const selected = selectedIds.has(item.currentManga.id)}
            <article class="queueItem" class:queueItemMuted={runtime === "excluded"} class:queueItemDone={runtime === "migrated" || runtime === "copied"}>
              <div class="queueMain">
                <div class="migrationPair">
                  <div class="miniManga libraryLikeCard">
                    <button
                      class="checkButton"
                      class:checkButtonSelected={selected || runtime === "migrated" || runtime === "copied"}
                      type="button"
                      disabled={!canSelect(item)}
                      onclick={(event) => toggleItem(item, event)}
                      aria-pressed={selected}
                      aria-label={$_("massMigration.selectTitle", { values: { title: item.currentManga.title } })}
                    >
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
                      <button
                        class="iconButton actionTrigger"
                        type="button"
                        onclick={() => toggleActionsMenu(item)}
                        aria-haspopup="menu"
                        aria-expanded={activeActionsMenuId === item.currentManga.id}
                        aria-label={$_("massMigration.actionsForTitle", { values: { title: item.currentManga.title } })}
                      >
                        <DotsThreeVertical size={19} weight="bold" />
                      </button>
                      {#if activeActionsMenuId === item.currentManga.id}
                        <div class="actionMenu" role="menu">
                          {#if canSelect(item)}
                            <button type="button" role="menuitem" onclick={() => applySelected("migrate", [item.currentManga.id])}>{$_("massMigration.migrateNow")}</button>
                            <button type="button" role="menuitem" onclick={() => applySelected("copy", [item.currentManga.id])}>{$_("massMigration.copyNow")}</button>
                          {/if}
                          <button type="button" role="menuitem" onclick={() => retryItem(item)}>{$_("massMigration.retry")}</button>
                          <button type="button" role="menuitem" onclick={() => openManualSearch(item)}>{$_("novelSources_actions_search")}</button>
                          <button type="button" role="menuitem" onclick={() => excludeItem(item)}>{$_("massMigration.exclude")}</button>
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
              </div>
            </article>
          {/each}
          {/if}
        </div>

        <footer class="modalFooter">
          <button class="secondaryButton" type="button" onclick={() => step = applying ? "review" : "target"}>{applying ? $_("massMigration.backToReview") : $_("ui_back")}</button>
          <button class="primaryButton" type="button" onclick={() => applySelected("migrate")} disabled={applying || selectedMigratableCount === 0}>
            {#if applying}<CircleNotch size={13} weight="bold" class="anim-spin" />{:else}<Check size={13} weight="bold" />{/if}
            {$_("massMigration.migrateSelected", { values: { count: selectedMigratableCount } })}
          </button>
        </footer>
        {/if}
      </section>
    {/if}
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; z-index: var(--component-migration-overlay-z-index); display: flex; align-items: center; justify-content: center; background: var(--component-migration-overlay-bg); backdrop-filter: var(--component-migration-overlay-blur); animation: fadeIn var(--component-migration-animation-fade) both; }
  .modal { width: min(800px, calc(100vw - 48px)); height: min(690px, calc(100vh - 64px)); display: flex; flex-direction: column; overflow: hidden; border-radius: var(--component-migration-modal-radius); border: 1px solid var(--component-migration-modal-border); background: var(--component-migration-modal-bg); box-shadow: var(--component-migration-modal-shadow); animation: scaleIn var(--component-migration-animation-scale) both; }
  .srOnly { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .modalHeader, .reviewToolbar, .manualSearchHeader, .manualSearchTop, .modalFooter, .sourceRow, .queueItem, .toolbarActions, .itemActions, .steps, .migrationPair { display: flex; align-items: center; }
  .modalHeader { justify-content: space-between; gap: 14px; padding: 15px 18px; border-bottom: 1px solid var(--component-migration-divider-strong); }
  .modalHeader p { margin: 0 0 2px; font-family: var(--font-ui); font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--component-migration-eyebrow-fg); }
  .modalHeader h2 { margin: 0; font-size: 13px; font-weight: 800; letter-spacing: 0.02em; color: var(--component-migration-title-fg); }
  .iconButton { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--component-migration-icon-radius); color: var(--component-migration-icon-fg); border: 1px solid var(--component-migration-icon-border); background: var(--component-migration-icon-bg); transition: color var(--component-migration-transition-fast), background var(--component-migration-transition-fast), transform var(--component-migration-transition-fast); }
  .iconButton:hover { color: var(--component-migration-icon-hover-fg); background: var(--component-migration-icon-hover-bg); }
  .iconButton:active { transform: scale(0.96); }
  .steps { gap: var(--sp-2); padding: 10px 18px; border-bottom: 1px solid var(--component-migration-divider-strong); }
  .steps span { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide); text-transform: uppercase; color: var(--component-migration-muted-fg); }
  .steps span.active { color: var(--component-migration-accent-fg); }
  .center { flex: 1; display: grid; place-items: center; gap: 12px; color: var(--component-migration-body-fg); text-align: center; }
  .errorPanel { padding: 40px; }
  .pane, .reviewPane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .paneIntro { display: grid; gap: 4px; padding: 14px 18px; color: var(--component-migration-body-fg); }
  .paneIntro strong, .reviewToolbar strong { color: var(--component-migration-strong-fg); }
  .paneIntro span, .reviewToolbar span { color: var(--component-migration-muted-fg); }
  .sourceList, .queueList { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 18px 18px; display: grid; align-content: start; gap: 6px; }
  .sourceGroup { display: grid; gap: 6px; }
  .sourceGroup > span { padding: 7px 4px 2px; font-size: 10px; font-weight: 800; text-transform: uppercase; color: var(--component-migration-eyebrow-fg); }
  .emptyLine { margin: 20px 4px; color: var(--component-migration-muted-fg); text-align: center; }
  .sourceRow { width: 100%; gap: 10px; text-align: left; padding: 10px; border-radius: var(--component-migration-row-radius); border: 1px solid var(--component-migration-row-border); background: var(--component-migration-row-bg); color: var(--component-migration-body-fg); }
  .sourceRow:hover, .sourceRow.selected { border-color: var(--component-migration-row-hover-border); background: var(--component-migration-row-hover-bg); }
  .sourceRow img { width: 28px; height: 28px; border-radius: var(--component-migration-source-icon-radius); object-fit: cover; }
  .sourceRow span { flex: 1; min-width: 0; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sourceRow small { color: var(--component-migration-muted-fg); }
  .reviewToolbar { justify-content: space-between; gap: 14px; padding: 12px 18px; border-bottom: 1px solid var(--component-migration-divider); }
  .reviewToolbar > div:first-child { display: grid; gap: 3px; }
  .toolbarActions { gap: 8px; }
  input { min-height: 32px; border-radius: var(--component-migration-input-radius); border: 1px solid var(--component-migration-input-border); background: var(--component-migration-input-bg); color: var(--component-migration-input-fg); padding: 0 10px; outline: none; }
  input:focus { border-color: var(--component-migration-input-focus-border); }
  input:focus-visible { box-shadow: var(--component-migration-focus-ring); }
  .queueItem { position: relative; display: block; padding: 12px; border-radius: var(--component-migration-item-radius); border: 1px solid var(--component-migration-item-border); background: var(--component-migration-item-bg); }
  .queueItemMuted { opacity: var(--component-migration-item-muted-opacity); }
  .queueItemDone { border-color: var(--component-migration-done-border); }
  .checkButton { position: absolute; left: 10px; top: 10px; z-index: var(--component-migration-select-z-index); display: grid; place-items: center; width: 34px; height: 34px; border-radius: var(--component-migration-select-radius); border: 1px solid var(--component-migration-select-border); color: var(--component-migration-select-fg); background: var(--component-migration-select-bg); box-shadow: var(--component-migration-select-shadow); backdrop-filter: var(--component-migration-select-blur); }
  .checkButton:hover:not(:disabled) { border-color: var(--component-migration-select-hover-border); background: var(--component-migration-select-hover-bg); box-shadow: var(--component-migration-select-hover-shadow); }
  .checkButtonSelected { color: var(--component-migration-select-active-fg); border-color: var(--component-migration-select-active-border); background: var(--component-migration-select-active-bg); box-shadow: var(--component-migration-select-active-shadow); }
  .checkButton:disabled { color: var(--component-migration-select-disabled-fg); border-color: var(--component-migration-select-disabled-border); background: var(--component-migration-select-disabled-bg); box-shadow: var(--component-migration-select-disabled-shadow); cursor: not-allowed; }
  .queueMain { flex: 1; min-width: 0; display: grid; gap: 7px; }
  .migrationPair { min-width: 0; width: 100%; display: grid; grid-template-columns: minmax(180px, 210px) 1fr 48px 1fr minmax(180px, 210px); align-items: start; gap: 0; }
  .miniManga { position: relative; min-width: 0; }
  .libraryLikeCard { width: min(210px, 100%); display: grid; align-content: start; gap: 8px; }
  .libraryLikeCard:first-child { grid-column: 1; justify-self: start; }
  .libraryLikeCard:last-child { grid-column: 5; justify-self: end; }
  .cardCopy { min-width: 0; display: grid; gap: 5px; }
  .cardCopy strong { color: var(--component-migration-strong-fg); font-size: 13px; line-height: 1.2; display: -webkit-box; line-clamp: 2; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .cardCopy span { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; font-family: var(--font-ui); font-size: 10px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; color: var(--component-migration-muted-fg); }
  .cardCopy b, .cardCopy em { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: normal; }
  .cardCopy b { flex: 1; }
  .cardCopy em { flex: 0 0 auto; color: var(--component-migration-body-fg); }
  .pairArrow {
    place-self: center;
    grid-column: 3;
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: var(--radius-full);
    color: var(--component-migration-accent-fg);
    background: var(--component-migration-pair-arrow-bg);
    border: 1px solid var(--component-migration-pair-arrow-border);
    box-shadow: var(--component-migration-pair-arrow-shadow);
  }
  .cover { width: 100%; aspect-ratio: 2 / 3; border-radius: var(--component-migration-cover-radius); object-fit: cover; background: var(--component-migration-cover-bg); border: 1px solid var(--component-migration-cover-border); }
  .noCover { display: grid; place-items: center; color: var(--component-migration-muted-fg); }
  .itemNote { color: var(--component-migration-muted-fg); font-size: 11px; }
  .itemError { color: var(--color-error); font-size: 11px; }
  .targetError { margin: 0 18px 10px; display: flex; align-items: center; gap: 7px; padding: 10px 11px; border-radius: var(--component-migration-input-radius); border: 1px solid var(--component-migration-error-border); background: var(--component-migration-error-bg); color: var(--component-migration-error-fg); font-size: 12px; line-height: 1.35; }
  .manualSearchHeader { gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--component-migration-divider); }
  .manualSearchHeader > div { min-width: 0; display: grid; gap: 2px; }
  .manualSearchHeader span { font-family: var(--font-ui); font-size: 10px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--component-migration-muted-fg); }
  .manualSearchHeader strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--component-migration-strong-fg); font-size: 15px; }
  .manualSearchTop { gap: 8px; padding: 12px 18px; border-bottom: 1px solid var(--component-migration-divider); }
  .manualSearchTop input { flex: 1; min-width: 0; }
  .manualResultGrid { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 18px 18px; display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); align-content: start; gap: 14px; }
  .manualResultCard { min-width: 0; display: grid; gap: 8px; text-align: left; padding: 0; border: 0; background: transparent; color: var(--component-migration-result-fg); }
  .manualResultCard .cover { transition: border-color var(--component-migration-transition-normal), box-shadow var(--component-migration-transition-normal), transform var(--component-migration-transition-normal); }
  .manualResultCard:hover .cover { transform: translateY(-1px); border-color: var(--component-migration-result-cover-hover-border); box-shadow: var(--component-migration-result-cover-hover-shadow); }
  .manualResultCard span { min-width: 0; color: var(--component-migration-strong-fg); font-size: 12px; font-weight: 850; line-height: 1.25; display: -webkit-box; line-clamp: 2; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .manualResultCard small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-ui); font-size: 10px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; color: var(--component-migration-muted-fg); }
  .manualEmpty { grid-column: 1 / -1; min-height: 220px; display: grid; place-items: center; align-content: center; gap: 10px; color: var(--component-migration-muted-fg); text-align: center; }
  .itemActions { position: absolute; right: 10px; top: 10px; z-index: var(--component-migration-select-z-index); }
  .actionTrigger { width: 34px; height: 34px; border-radius: var(--component-migration-select-radius); color: var(--component-migration-select-fg); border-color: var(--component-migration-select-border); background: var(--component-migration-select-bg); box-shadow: var(--component-migration-select-shadow); backdrop-filter: var(--component-migration-select-blur); }
  .actionTrigger:hover { border-color: var(--component-migration-select-hover-border); background: var(--component-migration-select-hover-bg); box-shadow: var(--component-migration-select-hover-shadow); }
  .actionMenu { position: absolute; right: 0; top: calc(100% + 6px); z-index: var(--component-migration-menu-z-index); min-width: 118px; display: grid; padding: 5px; border-radius: var(--component-migration-menu-radius); border: 1px solid var(--component-migration-menu-border); background: var(--component-migration-menu-bg); box-shadow: var(--component-migration-menu-shadow); }
  .actionMenu button { width: 100%; text-align: left; border: 0; border-radius: var(--component-migration-menu-item-radius); padding: 7px 9px; color: var(--component-migration-menu-item-fg); background: transparent; font-size: 12px; font-weight: 800; }
  .actionMenu button:hover { background: var(--component-migration-menu-item-hover-bg); color: var(--component-migration-accent-fg); }
  .modalFooter { justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--component-migration-divider); }
  .primaryButton, .secondaryButton { min-height: 32px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-radius: var(--radius-md); font-family: var(--font-ui); font-size: var(--text-xs); font-weight: 800; letter-spacing: var(--tracking-wide); }
  .primaryButton { color: var(--component-migration-primary-ink); background: var(--component-migration-primary-bg); border: 1px solid var(--component-migration-primary-border); padding: 0 14px; }
  .secondaryButton { color: var(--component-migration-secondary-fg); background: var(--component-migration-secondary-bg); border: 1px solid var(--component-migration-secondary-border); padding: 0 10px; }
  .bulkSelectButton { font-family: var(--font-ui); font-size: var(--text-xs); font-weight: 800; letter-spacing: var(--tracking-wide); text-transform: none; -webkit-font-smoothing: antialiased; }
  .primaryButton:disabled, .secondaryButton:disabled { opacity: var(--component-migration-disabled-opacity); }
  .iconButton:focus-visible, .sourceRow:focus-visible, .checkButton:focus-visible, .manualResultCard:focus-visible, .actionTrigger:focus-visible, .actionMenu button:focus-visible, .primaryButton:focus-visible, .secondaryButton:focus-visible { outline: 1px solid var(--component-migration-focus-border); outline-offset: 2px; border-color: var(--component-migration-focus-border); box-shadow: var(--component-migration-focus-ring); }
  .errorLine { display: flex; align-items: center; gap: 8px; margin: 10px 18px 0; color: var(--color-error); font-size: 12px; }
  @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
  @keyframes scaleIn { from { opacity: 0; transform: translateY(8px) scale(0.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
</style>
