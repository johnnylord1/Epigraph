<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { ArrowLeft, ArrowRight, BookOpen, Check, CircleNotch, DotsThreeVertical, MagnifyingGlass, X } from "phosphor-svelte";
  import { _, translate } from "../../lib/i18n/runtime";
  import { readableErrorText } from "../../lib/i18n/networkErrorText";
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
  import { createStoreMigrationIdentityBridge } from "../../lib/migration/storeIdentity.svelte";
  import NocturneState from "../shared/NocturneState.svelte";
  import MigrationSourcePicker from "./MigrationSourcePicker.svelte";
  import MigrationResultList from "./MigrationResultList.svelte";
  import { enterOnMount, glideHeight, listFlip, popIn, popOut } from "../../lib/motion/motion";
  import "./migrationModal.css";

  interface Props {
    extension: ManagedExtension;
    installedExtensionPkgNames?: string[];
    onClose: () => void;
    onCompleted?: () => void;
  }

  let { extension, installedExtensionPkgNames = [], onClose, onCompleted = () => {} }: Props = $props();

  type Step = "origin" | "target" | "review" | "migrating";
  type RuntimeStatus = "excluded" | "migrating" | "migrated" | "copied" | "failed";

  const storagePrefix = "epigraph-manga-mass-migration";
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
  // The query typed in the open manual search; saved per work when the search runs.
  let manualSearchText = $state("");
  let manualSearching = $state(new Set<number>());
  let manualResults = $state(new Map<number, Manga[]>());
  let manualSearchItemId: number | null = $state(null);
  let buildingPreview = $state(false);
  let applying = $state(false);
  let previewProgress = $state<{ stage: string; done: number; total: number } | null>(null);
  // Matches as each search ends, so the queue fills in live before the whole preview is ready.
  let liveResults = $state(new Map<number, MassMangaMigrationPreviewItem>());
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
  const selectedMigratableCount = $derived.by<number>(() => {
    const currentPreview = preview;
    return currentPreview
      ? currentPreview.items.filter((item) => selectedIds.has(item.currentManga.id) && canSelect(item)).length
      : 0;
  });
  // One candidate per work: while the preview builds, every work is listed at once and its match
  // (item) stays null until that work's search ends.
  const reviewItems = $derived.by<Array<{ manga: Manga; item: MassMangaMigrationPreviewItem | null }>>(() => {
    if (preview) return preview.items.map((item) => ({ manga: item.currentManga, item }));
    if (!buildingPreview) return [];
    return sourceItems.map(({ manga }) => ({ manga, item: liveResults.get(manga.id) ?? null }));
  });
  const visibleReviewItems = $derived.by(() => {
    const query = searchFilter.trim().toLowerCase();
    if (!query) return reviewItems;
    return reviewItems.filter(({ manga, item }) => (
      manga.title.toLowerCase().includes(query)
      || item?.match?.manga.title.toLowerCase().includes(query)
      || item?.reasonCode.toLowerCase().includes(query)
    ));
  });
  const visibleSelectableIds = $derived(
    buildingPreview ? [] : visibleReviewItems.flatMap(({ item }) => (item && canSelect(item) ? [item.currentManga.id] : [])),
  );
  const allVisibleSelectableSelected = $derived(
    visibleSelectableIds.length > 0 && visibleSelectableIds.every((id) => selectedIds.has(id)),
  );
  const manualSearchItem = $derived.by(() => (
    manualSearchItemId === null ? null : preview?.items.find((item) => item.currentManga.id === manualSearchItemId) ?? null
  ));

  const originOptions = $derived(originSources.map((source) => ({
    id: source.id,
    name: source.displayName,
    iconSrc: resolveServiceIconUrl(source, { kind: "source" }),
  })));
  const targetOptions = $derived(targetSources.map((source) => ({
    id: source.id,
    name: source.displayName,
    iconSrc: resolveServiceIconUrl(source, { kind: "source" }),
  })));
  const QUEUE_FILTER_FROM = 8;
  const showQueueFilter = $derived.by(() => reviewItems.length > QUEUE_FILTER_FROM || searchFilter.length > 0);
  const headerSubtitle = $derived.by(() => {
    if (manualSearchItem) return manualSearchItem.currentManga.title;
    if (step === "target") return originSource?.displayName ?? "";
    if (originSource && targetSource && step !== "origin") {
      return $_("massMigration.sourceToTarget", { values: { origin: originSource.displayName, target: targetSource.displayName } });
    }
    return "";
  });
  // Each body view gets its own entrance, so switching steps reads as a page turn rather than a swap.
  const bodyView = $derived.by(() => {
    if (loading) return "loading";
    if (error && !preview && step !== "target") return "error";
    // The queue shows up as soon as the preview starts, and stays put when it finishes.
    if (buildingPreview) return "review";
    if (step === "origin" || step === "target") return step;
    if (preview) return manualSearchItem ? "manual" : "review";
    return "none";
  });

  function statusTone(item: MassMangaMigrationPreviewItem): string {
    const runtime = runtimeStatuses.get(item.currentManga.id);
    if (runtime === "migrated" || runtime === "copied") return "mg-pill--good";
    if (runtime === "failed") return "mg-pill--bad";
    if (runtime === "excluded") return "";
    if (runtime === "migrating") return "mg-pill--accent";
    if (item.status === "matched") return "mg-pill--good";
    if (item.status === "needs_review") return "mg-pill--warn";
    return "mg-pill--bad";
  }

  function chapterCountLabel(count: number | null | undefined) {
    return count ? translate("detail.chapterCount", { count }) : "";
  }

  function markBrokenImage(event: Event) {
    (event.currentTarget as HTMLImageElement).dataset.broken = "true";
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && activeActionsMenuId !== null) {
      activeActionsMenuId = null;
      return;
    }
    if (event.key === "Escape" && manualSearchItemId !== null) {
      closeManualSearch();
      return;
    }
    if (event.key === "Escape" && !applying) onClose();
  }

  function handleOverlayPointerDown(event: PointerEvent) {
    pointerStartedOnOverlay = event.target === event.currentTarget;
  }

  function handleOverlayClick(event: MouseEvent) {
    if (pointerStartedOnOverlay && event.target === event.currentTarget && !applying) {
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

  // One press on a target source builds the review straight away.
  function chooseTarget(id: string) {
    const source = targetSources.find((candidate) => candidate.id === id);
    if (!source || buildingPreview) return;
    pickTarget(source);
    void buildPreview();
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
    liveResults = new Map();
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
        onItemDone: (done, total, result) => {
          previewProgress = { stage: translate("massMigration.searchingMatches"), done, total };
          liveResults = new Map(liveResults).set(result.currentManga.id, result);
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
      liveResults = new Map();
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
    manualSearchText = manualQuery.get(item.currentManga.id) ?? item.currentManga.title;
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
      const identityBridge = createStoreMigrationIdentityBridge(
        store.runtimeResolvedLocalProfileId ?? store.settings.defaultLocalProfileId,
      );
      const result = await applyMassMangaMigrationWithJournal({
        preview,
        selectedMangaIds: [...selectedMigrationIds],
        mode,
        profileId: store.runtimeResolvedLocalProfileId,
        identityBridge,
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
            void undoMangaMigration(result.journalEntryId!, identityBridge).then(() => {
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
<div bind:this={overlayEl} class="mg-overlay" onpointerdown={handleOverlayPointerDown} onclick={handleOverlayClick}>
  <div
    bind:this={modalEl}
    class="mg-modal mg-modal--wide"
    role="dialog"
    aria-modal="true"
    aria-labelledby={dialogTitleId}
    aria-describedby={dialogDescriptionId}
    tabindex="-1"
    onpointerdown={stopModalPointerEvent}
    onclick={stopModalPointerEvent}
    use:glideHeight
  >
    <header class="mg-header">
      <span class="mg-mark"><img src={resolveServiceIconUrl(originSource ?? extension, { kind: "source" })} alt="" onerror={(event) => applyServiceIconFallback(event, "source")} /></span>
      <div class="mg-heading">
        <h2 class="mg-title" id={dialogTitleId}>{extension.name}</h2>
        <p class="mg-subtitle">{headerSubtitle || $_("massMigration.title")}</p>
        <span id={dialogDescriptionId} class="mg-sr-only">{$_("massMigration.description")}</span>
      </div>
      <button bind:this={closeButtonEl} class="mg-close" type="button" onclick={onClose} disabled={applying} aria-label={$_("massMigration.close")}>
        <X size={16} weight="bold" />
      </button>
    </header>

    <div class="mg-body">
      {#key bodyView}<div class="mg-step" use:enterOnMount={{ y: 10, blur: 4, duration: 560 }}>
      {#if loading}
        <div class="mg-list" aria-busy="true">
          {#each Array(5) as _, i (i)}<div class="mg-skeleton"></div>{/each}
        </div>
      {:else if error && !preview && step !== "target"}
        <NocturneState
          layout="compact"
          tone="danger"
          icon="warning"
          eyebrow={$_("massMigration.title")}
          title={$_("ui_massMigrationFailed")}
          body={error}
          actions={[{ label: $_("massMigration.retry"), kind: "primary", icon: "retry", onClick: loadInitialState }]}
        />
      {:else if step === "origin"}
        <MigrationSourcePicker
          sources={originOptions}
          emptyLabel={$_("massMigration.noLinkedInstalledSource")}
          onPick={(id) => { const source = originSources.find((candidate) => candidate.id === id); if (source) void pickOrigin(source); }}
        />
      {:else if step === "target" && !buildingPreview}
        {#if error}
          <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("massMigration.targetSource")} title={$_("ui_searchFailed")} body={error} />
        {/if}
        <MigrationSourcePicker
          sources={targetOptions}
          emptyLabel={$_("massMigration.noAlternativeSource")}
          onPick={chooseTarget}
        />
      {:else if preview && manualSearchItem}
        {@const item = manualSearchItem}
        <MigrationResultList
          bind:query={manualSearchText}
          searching={manualSearching.has(item.currentManga.id)}
          results={(manualResults.get(item.currentManga.id) ?? []).map((result) => ({
            id: String(result.id),
            title: result.title,
            coverSrc: resolveMangaCoverUrl(result, { context: "migration", persistence: "memory" }),
          }))}
          error={runtimeErrors.get(item.currentManga.id) ?? null}
          emptyLabel={$_("massMigration.noManualResults")}
          placeholder={$_("massMigration.searchTitleOnTarget")}
          onSearch={() => { setManualQuery(item.currentManga.id, manualSearchText); void searchManual(item); }}
          onPick={(id) => { const result = manualResults.get(item.currentManga.id)?.find((candidate) => String(candidate.id) === id); if (result) void chooseManualMatch(item, result); }}
        />
      {:else if preview || buildingPreview}
        <div class="mg-toolbar">
          {#if showQueueFilter}
            <label class="mg-field">
              <MagnifyingGlass size={16} weight="bold" />
              <input bind:value={searchFilter} placeholder={$_("massMigration.filterQueue")} aria-label={$_("massMigration.filterQueue")} />
            </label>
          {:else}
            <span class="mg-spacer"></span>
          {/if}
          {#if buildingPreview}
            <span class="mg-live-status" aria-live="polite">
              <CircleNotch size={14} weight="bold" class="anim-spin" />
              <span>{previewProgress?.stage ?? $_("massMigration.searchMatches")}</span>
              {#if previewProgress}<span class="mg-live-count">{previewProgress.done}/{previewProgress.total}</span>{/if}
            </span>
          {:else}
            <button class="mg-btn" type="button" onclick={toggleAllVisibleMatches} disabled={visibleSelectableIds.length === 0}>
              {allVisibleSelectableSelected ? $_("massMigration.deselectAll") : $_("massMigration.selectAllMatches")}
            </button>
          {/if}
        </div>

        {#if error}
          <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("massMigration.title")} title={$_("ui_massMigrationFailed")} body={error} />
        {/if}

        {#if visibleReviewItems.length === 0}
          <div class="mg-empty">{$_("massMigration.noQueueMatches")}</div>
        {:else}
          <div class="mg-queue" aria-busy={buildingPreview}>
            {#each visibleReviewItems as entry, i (entry.manga.id)}
              {@const item = entry.item}
              {@const runtime = runtimeStatuses.get(entry.manga.id)}
              {@const match = item?.match ?? null}
              {@const selected = selectedIds.has(entry.manga.id)}
              {@const done = runtime === "migrated" || runtime === "copied"}
              <article
                animate:listFlip
                style:--mg-i={i}
                class="mg-queue-item"
                class:is-selected={selected}
                class:is-muted={runtime === "excluded"}
                class:is-pending={!item}
                data-migration-candidate={entry.manga.id}
              >
                <button
                  class="mg-check"
                  class:is-checked={selected || done}
                  type="button"
                  disabled={!item || buildingPreview || !canSelect(item)}
                  onclick={(event) => { if (item) toggleItem(item, event); }}
                  aria-pressed={selected}
                  aria-label={$_("massMigration.selectTitle", { values: { title: entry.manga.title } })}
                >
                  {#if selected || done}<Check size={13} weight="bold" />{/if}
                </button>
                <span class="mg-side">
                  <span class="mg-cover">
                    <img src={resolveMangaCoverUrl(entry.manga, { context: "migration", persistence: "memory" })} alt="" onerror={markBrokenImage} />
                  </span>
                  <span class="mg-row-copy">
                    <strong title={entry.manga.title}>{entry.manga.title}</strong>
                    <small>{[originSource?.displayName, chapterCountLabel(item?.currentChapters.length || entry.manga.chapters?.totalCount)].filter(Boolean).join(" · ")}</small>
                  </span>
                </span>
                <span class="mg-queue-arrow" aria-hidden="true"><ArrowRight size={14} weight="bold" /></span>
                <span class="mg-side mg-side--target">
                  {#if !item}
                    <span class="mg-cover mg-cover--pending"><CircleNotch size={14} weight="bold" class="anim-spin" /></span>
                    <span class="mg-row-copy">
                      <strong class="is-quiet">{$_("ui_searching")}</strong>
                      <small>{targetSource?.displayName ?? ""}</small>
                    </span>
                  {:else if match}
                    <span class="mg-cover">
                      <img src={resolveMangaCoverUrl(match.manga, { context: "migration", persistence: "memory" })} alt="" onerror={markBrokenImage} />
                    </span>
                    <span class="mg-row-copy">
                      <strong title={match.manga.title}>{match.manga.title}</strong>
                      <small>{[targetSource?.displayName, chapterCountLabel(match.chapters.length)].filter(Boolean).join(" · ")}</small>
                    </span>
                  {:else}
                    <span class="mg-cover"><BookOpen size={16} weight="duotone" /></span>
                    <span class="mg-row-copy">
                      <strong class="is-quiet" title={issueReasonLabel(item)}>{issueReasonLabel(item) || statusLabel(item)}</strong>
                      <small>{targetSource?.displayName ?? ""}</small>
                    </span>
                  {/if}
                </span>
                {#if item}
                  <span class="mg-pill {statusTone(item)}">{statusLabel(item)}</span>
                {:else}
                  <span class="mg-pill">{$_("ui_searching")}</span>
                {/if}
                {#if preview && item}
                  <div class="mg-menu-wrap">
                    <button
                      class="mg-icon-btn"
                      type="button"
                      onclick={() => toggleActionsMenu(item)}
                      aria-haspopup="menu"
                      aria-expanded={activeActionsMenuId === item.currentManga.id}
                      aria-label={$_("massMigration.actionsForTitle", { values: { title: item.currentManga.title } })}
                    >
                      <DotsThreeVertical size={18} weight="bold" />
                    </button>
                    {#if activeActionsMenuId === item.currentManga.id}
                      <div class="mg-menu" role="menu" use:floatMenu={() => { activeActionsMenuId = null; }} in:popIn out:popOut>
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
                {:else}
                  <span class="mg-menu-wrap" aria-hidden="true"></span>
                {/if}
                {#if runtimeErrors.get(entry.manga.id)}
                  <small class="mg-queue-note is-error">{readableErrorText(runtimeErrors.get(entry.manga.id) ?? "")}</small>
                {/if}
              </article>
            {/each}
          </div>
        {/if}
      {/if}
      </div>{/key}
    </div>

    <footer class="mg-footer">
      {#if loading || (error && !preview && step !== "target") || step === "origin"}
        <span class="mg-spacer"></span>
        <button class="mg-btn" type="button" onclick={onClose}>{$_("ui_cancel")}</button>
      {:else if step === "target" && !buildingPreview}
        <button class="mg-btn" type="button" onclick={() => step = "origin"}><ArrowLeft size={15} weight="bold" class="mg-arrow-back" /> {$_("ui_back")}</button>
        <span class="mg-spacer"></span>
      {:else if preview && manualSearchItem}
        <button class="mg-btn" type="button" onclick={closeManualSearch}><ArrowLeft size={15} weight="bold" class="mg-arrow-back" /> {$_("massMigration.backToReview")}</button>
        <span class="mg-spacer"></span>
      {:else if preview || buildingPreview}
        <button class="mg-btn" type="button" onclick={() => step = applying ? "review" : "target"} disabled={buildingPreview}><ArrowLeft size={15} weight="bold" class="mg-arrow-back" /> {applying ? $_("massMigration.backToReview") : $_("ui_back")}</button>
        <span class="mg-spacer"></span>
        <button class="mg-btn mg-btn--primary" type="button" onclick={() => applySelected("migrate")} disabled={applying || buildingPreview || selectedMigratableCount === 0}>
          {#if applying}<CircleNotch size={15} weight="bold" class="anim-spin" />{/if}
          {$_("massMigration.migrateSelected", { values: { count: selectedMigratableCount } })}
        </button>
      {/if}
    </footer>
  </div>
</div>
