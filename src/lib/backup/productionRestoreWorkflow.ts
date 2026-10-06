import { prepareProductionNovels, restoreProductionNovels, preserveNovelCategoriesForBooksRestore } from "./restoreAdapters";
import { novelRestoreRuntimeState } from "./novelsRestoreProvisioning";
import { invoke } from "@tauri-apps/api/core";
import { gql } from "../client";
import { buildRestoreReadiness } from "../reconciliation/readiness";
import type { ParsedBackup, ReconciliationAnalysis, SourceInventoryEntry, AvailableExtensionEntry, NativeSourceRestoreChoice } from "../reconciliation/types";
import {
  DEFAULT_READING_STATS,
  bumpContentSetupVersion,
  replaceBooksState,
  setLibraryMangaSnapshot,
  store,
  persistRestoredAppReadingState,
  flushBookLibraryPersistence,
} from "../../store/state.svelte";
import {
  GET_LIBRARY,
  GET_TRACKERS,
} from "../startupQueries";
import type { Tracker } from "../types";
import { preflightEpigraphRestorePayloads } from "./epigraphRestorePreflight";
import { selectedExecutablePayloadKinds } from "./backupRollout";
import { createBackupWorkflow, type BackupInspection, type BackupWorkflowFile } from "./backupWorkflow";
import { loadSettingsStorageRuntime } from "../../components/settings/settingsStorageRuntime";

type MangaRestoreData = {
  parsed: ParsedBackup;
  analysis: ReconciliationAnalysis;
  inventory: SourceInventoryEntry[];
  availableExtensions: AvailableExtensionEntry[];
};

function isZipContainer(bytes: ArrayBuffer): boolean {
  const signature = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return signature[0] === 0x50 && signature[1] === 0x4b;
}

function countMetadata(plan: NonNullable<BackupInspection["plan"]>, key: string): number {
  return plan.payloads.reduce((sum, payload) => sum + (typeof payload.metadata[key] === "number" ? Number(payload.metadata[key]) : 0), 0);
}

async function loadNovelRuntimeState() {
  const runtime = await loadSettingsStorageRuntime();
  const state = await runtime.loadNovelRepositoryState({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  });
  return novelRestoreRuntimeState(state);
}

async function inspectManga(file: File): Promise<BackupInspection> {
  const runtime = await loadSettingsStorageRuntime();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const [inventory, trackers, overlay] = await Promise.all([
    runtime.loadSourceInventory(),
    gql<{ trackers: { nodes: Tracker[] } }>(GET_TRACKERS),
    runtime.readOverlayFile(),
  ]);
  const parsed = await runtime.parseMihonBackup(bytes, inventory.inventory);
  const { analysis } = await runtime.analyzeBackupReconciliation(
    bytes,
    inventory.inventory,
    trackers.trackers.nodes ?? [],
    overlay,
  );
  return {
    plan: null,
    restoreData: { parsed, analysis, inventory: inventory.inventory, availableExtensions: inventory.availableExtensions } satisfies MangaRestoreData,
    workCount: parsed.backupManga.length,
    chapterCount: parsed.backupManga.reduce((sum, manga) => sum + (manga.chapterCount ?? 0), 0),
    repositoryCount: parsed.extensionStores.length,
    // Sources of removed/browsed titles stay in backups; only library entries need an extension.
    extensionCount: new Set(parsed.backupManga.map((manga) => manga.sourceId)).size,
    conflictCount: analysis.needsReview.length,
    libraryKinds: ["manga"],
    needsSourceKinds: analysis.unresolved.length > 0 || analysis.needsReview.length > 0 ? ["manga"] : [],
  };
}

async function inspectEpigraph(file: File): Promise<BackupInspection> {
  const runtime = await loadSettingsStorageRuntime();
  const bytes = await file.arrayBuffer();
  if (!isZipContainer(bytes)) return inspectManga(file);
  // A missing Manga backend must not disable local-domain inspection.
  const [mangaContext, novels] = await Promise.all([
    Promise.all([runtime.loadSourceInventory(), gql<{ trackers: { nodes: Tracker[] } }>(GET_TRACKERS), runtime.readOverlayFile()])
      .then(([inventory, trackers, overlay]) => ({ supported: true, repositoryUrls: inventory.repoUrls,
        inventory: inventory.inventory, availableExtensions: inventory.availableExtensions, trackers: trackers.trackers.nodes ?? [], overlay }))
      .catch(() => undefined),
    loadNovelRuntimeState().catch(() => undefined),
  ]);
  const plan = await runtime.buildEpigraphRestorePlan(bytes, {
    activeProfileId: store.runtimeResolvedLocalProfileId,
    manga: mangaContext,
    books: { supported: true },
    novels: novels ? { ...novels, supported: true } : { supported: false },
    app: { supported: true },
  });
  if (plan.containerIssues.length > 0 && plan.payloads.length === 0) {
    throw new Error(plan.containerIssues.map((issue) => issue.message).join(" "));
  }
  const libraryKinds = plan.payloads
    .map((payload) => payload.kind)
    .filter((kind): kind is "manga" | "books" | "novels" | "app" => ["manga", "books", "novels", "app"].includes(kind));
  const manga = plan.payloads.find((payload) => payload.kind === "manga");
  const novelsPlan = plan.payloads.find((payload) => payload.kind === "novels");
  const repositoryCount = [
    ...((manga?.metadata.missingRepositories as string[] | undefined) ?? []),
    ...((novelsPlan?.metadata.missingRepositories as string[] | undefined) ?? []),
  ].length;
  return {
    plan,
    restoreData: bytes,
    workCount: countMetadata(plan, "mangaCount") + countMetadata(plan, "bookCount") + countMetadata(plan, "entryCount"),
    chapterCount: countMetadata(plan, "chapterCount"),
    repositoryCount,
    extensionCount: countMetadata(plan, "restoredNeedsPluginCount") + ((manga?.metadata.installableExtensions as string[] | undefined)?.length ?? 0),
    conflictCount: countMetadata(plan, "needsReview"),
    libraryKinds,
    needsSourceKinds: [
      ...(libraryKinds.includes("manga") && (repositoryCount > 0 || countMetadata(plan, "unresolved") > 0) ? ["manga" as const] : []),
      ...(libraryKinds.includes("novels") && (repositoryCount > 0 || countMetadata(plan, "restoredNeedsPluginCount") > 0) ? ["novels" as const] : []),
    ],
  };
}

async function inspectLnReader(file: File): Promise<BackupInspection> {
  const runtime = await loadSettingsStorageRuntime();
  const bytes = await file.arrayBuffer();
  if (!(await runtime.isLnReaderBackupZip(bytes))) throw new Error("This ZIP is not a supported LNReader backup.");
  const snapshot = await runtime.parseLnReaderNovelsBackup(bytes);
  return {
    plan: null,
    restoreData: bytes,
    workCount: snapshot.entries.length,
    chapterCount: snapshot.chapters.length,
    repositoryCount: snapshot.repositories?.length ?? 0,
    extensionCount: snapshot.plugins?.length ?? 0,
    conflictCount: 0,
    libraryKinds: ["novels"],
    needsSourceKinds: (snapshot.repositories?.length ?? 0) > 0 || (snapshot.plugins?.length ?? 0) > 0 ? ["novels"] : [],
  };
}

async function refreshMangaLibrary(assertTarget = () => {}) {
  const result = await gql<{ mangas: { nodes: any[] } }>(GET_LIBRARY);
  assertTarget();
  setLibraryMangaSnapshot((result.mangas.nodes ?? []).map((manga) => ({
    ...manga,
    chapterCount: manga.chapters?.totalCount ?? manga.chapterCount ?? 0,
  })));
}

async function restoreManga(file: File, data: MangaRestoreData, choices: Record<string, NativeSourceRestoreChoice>, observationOnly = false, assertTarget = () => {}) {
  const { runtime, reconciled, restoreProductionManga } = await (async () => {
    const runtime = await loadSettingsStorageRuntime();
    assertTarget();
    const readiness = buildRestoreReadiness(data.analysis, choices, data.inventory, data.availableExtensions);
    if (readiness.blocksRestore) throw new Error("RESTORE_WAITING_FOR_DEPENDENCIES");
    const reconciled = runtime.buildReconciledBackupFile(data.parsed, data.analysis, choices, file.name);
    const { restoreProductionManga } = await import("./mangaRestoreAdapter");
    assertTarget();
    return { runtime, reconciled, restoreProductionManga };
  })().catch(error => { throw mangaPreparationError(error, observationOnly); });
  const result = await restoreProductionManga(reconciled, { observationOnly, assertTarget });
  if (result.status !== "succeeded") throw Object.assign(new Error(result.code), { provenNotAccepted: result.provenNotAccepted, externalTerminal: result.code === "BACKEND_RESTORE_FAILURE" });
  try {
    assertTarget();
    await runtime.upsertOverlayEntry(runtime.overlayEntryFromAnalysis(data.analysis));
    assertTarget();
    await refreshMangaLibrary(assertTarget);
    return [];
  } catch {
    return ["MANGA_RESTORED_LOCAL_REFRESH_FAILED"];
  }
}

function mangaPreparationError(error: unknown, observationOnly: boolean) {
  // This boundary has not called the adapter. It cannot clear earlier uncertainty.
  return observationOnly ? error : Object.assign(new Error(error instanceof Error ? error.message : "RESTORE_PREPARATION_FAILED"), { provenNotAccepted: true });
}

type ProductionRestoreOptions = {
  selection?: Record<string, boolean>;
  mangaChoices?: Record<string, NativeSourceRestoreChoice>;
};

export function createProductionRestoreWorkflow(options: ProductionRestoreOptions = {}) {
  const frozenTarget = JSON.stringify([store.runtimeResolvedLocalProfileId, store.runtimeServerUrl]);
  const assertTarget = () => {
    if (JSON.stringify([store.runtimeResolvedLocalProfileId, store.runtimeServerUrl]) !== frozenTarget) throw Error("RESTORE_TARGET_CHANGED");
  };
  const selection = options.selection ? { ...options.selection } : undefined;
  const choices = Object.fromEntries(Object.entries(options.mangaChoices ?? {}).map(([id, choice]) => [id, { ...choice }]));
  const inputChoices = new Map<string, Record<string, NativeSourceRestoreChoice>>();
  const choicesFor = (entry: BackupWorkflowFile) => inputChoices.get(entry.key) ?? choices;
  const selectedKinds = (entry: BackupWorkflowFile) => entry.plan
    ? entry.plan.payloads.filter(payload => payload.present && (selection
      ? selection[payload.kind] ?? payload.selectedByDefault
      : entry.libraryKinds.some(kind => kind === payload.kind))).map(payload => payload.kind)
    : entry.libraryKinds;
  const warnings: Record<string, string[]> = {};
  async function restoreDomain(entry: BackupWorkflowFile, kind: string, observationOnly = false) {
    const runtime = await loadSettingsStorageRuntime().then(runtime => { assertTarget(); return runtime; })
      .catch(error => { throw kind === "manga" ? mangaPreparationError(error, observationOnly) : error; });
    const bytes = entry.restoreData as ArrayBuffer;
    const id = `${entry.key}:${kind}`;
    if (kind === "manga") {
      const { file, inspected } = await (async () => {
        const file = entry.plan ? await runtime.extractEpigraphMangaPayloadFile(bytes) : entry.file;
        const inspected = await inspectManga(file);
        assertTarget();
        return { file, inspected };
      })().catch(error => { throw mangaPreparationError(error, observationOnly); });
      warnings[id] = await restoreManga(file, inspected.restoreData as MangaRestoreData, choicesFor(entry), observationOnly, assertTarget);
    } else if (kind === "novels") {
      const restored = await restoreProductionNovels(bytes, entry.kind === "novels-lnreader" ? "lnreader" : "epigraph", assertTarget);
      warnings[id] = [...(restored.mergeWarnings ?? []).map(w => w.code),
        ...(restored.issues ?? []).map(issue => issue.code),
        ...(restored.summary.restoredMetadataOnlyCount ? ["NOVEL_METADATA_ONLY"] : [])];
    } else if (kind === "books") {
      await store.prepareBooksForRestore();
      assertTarget();
      const { loadNovelLibraryStateForRestore } = await import("../novels/libraryState");
      assertTarget();
      const scope = { profileId: store.runtimeResolvedLocalProfileId, serverUrl: store.runtimeServerUrl };
      const novels = await loadNovelLibraryStateForRestore(scope);
      const restored = await runtime.restoreEpigraphBooksPayload(bytes);
      if (scope.profileId !== store.runtimeResolvedLocalProfileId || scope.serverUrl !== store.runtimeServerUrl) throw Error("RESTORE_TARGET_CHANGED");
      if (store.activeBookReaderId) throw Error("RESTORE_BOOK_READER_ACTIVE");
      replaceBooksState(preserveNovelCategoriesForBooksRestore({ categories: store.settings.booksCategories,
        assignments: store.settings.booksCategoryAssignments }, restored, novels.entries.map(novel => novel.id)));
      await store.persistRestoredBooks();
      warnings[id] = restored.issues.map(issue => issue.message);
    } else if (kind === "app") {
      const restored = await runtime.parseEpigraphAppPayload(new Uint8Array(bytes));
      assertTarget();
      // Profile preferences cannot redirect the operation which is applying them.
      if (restored.profile.version >= 2) {
        persistRestoredAppReadingState({ history: restored.profile.history, readLog: restored.profile.readLog, readingStats: restored.profile.readingStats });
      } else warnings[id] = ["APP_BACKUP_HAS_NO_READING_STATE"];
    } else throw Error("RESTORE_DOMAIN_UNSUPPORTED");
  }
  const workflow = createBackupWorkflow({
    target: () => JSON.stringify([store.runtimeResolvedLocalProfileId, store.runtimeServerUrl]),
    admit: async () => {
      const token = await invoke<string>("restore_session_admit", { profileId: store.runtimeResolvedLocalProfileId });
      if (typeof token !== "string" || !token) throw Error("RESTORE_SESSION_UNAVAILABLE");
      return async () => { await invoke("restore_session_release", { token }); };
    },
    ready: async files => {
      for (const entry of files) {
        if (selectedKinds(entry).includes("novels")) await prepareProductionNovels(entry.restoreData as ArrayBuffer, entry.kind === "novels-lnreader" ? "lnreader" : "epigraph", assertTarget);
        if (selectedKinds(entry).includes("manga")) {
          const runtime = await loadSettingsStorageRuntime();
          assertTarget();
          const file = entry.plan ? await runtime.extractEpigraphMangaPayloadFile(entry.restoreData as ArrayBuffer) : entry.file;
          const current = await inspectManga(file);
          assertTarget();
          const data = current.restoreData as MangaRestoreData;
          if (buildRestoreReadiness(data.analysis, choicesFor(entry), data.inventory, data.availableExtensions).blocksRestore) return false;
        }
        if (entry.plan) {
          const kinds = selectedKinds(entry);
          const current = await inspectEpigraph(entry.file);
          assertTarget();
          if (!kinds.length || !current.plan || kinds.some(kind => {
            const payload = current.plan!.payloads.find(p => p.kind === kind);
            return !payload?.canRestoreNow || !payload.canExecuteRestore;
          })) return false;
          const runtime = await loadSettingsStorageRuntime();
          await preflightEpigraphRestorePayloads(entry.restoreData as ArrayBuffer, kinds, {
            parseManga: runtime.parseEpigraphMangaPayload, parseNativeManga: runtime.parseMihonBackup,
            parseBooks: runtime.parseEpigraphBooksPayload, parseNovels: runtime.parseEpigraphNovelsPayload, parseApp: runtime.parseEpigraphAppPayload,
          });
        }
      }
      return true;
    },
    inspect: async (file, kind) => kind === "manga" ? inspectManga(file) : kind === "novels-lnreader" ? inspectLnReader(file) : inspectEpigraph(file),
    restore: async () => { throw Error("RESTORE_DOMAIN_PLAN_REQUIRED"); },
    invocations: (entry, onProgress) => {
      const kinds = selectedKinds(entry);
      const executeDomain = async (kind: string, observationOnly = false) => {
        await restoreDomain(entry, kind, observationOnly);
        const completed = Object.entries(workflow.snapshot().units).filter(([id, status]) => id.startsWith(`${entry.key}:`) && status === "succeeded").length;
        onProgress((completed + 1) / kinds.length);
      };
      return (["manga", "books", "novels", "app"] as const).filter(kind => kinds.includes(kind)).map(kind => ({
        id: `${entry.key}:${kind}`, domain: kind,
        ...(kind === "manga" ? { reconcile: () => executeDomain(kind, true) } : {}),
        execute: () => executeDomain(kind),
      }));
    },
  });
  return Object.assign(workflow, {
    warnings: () => structuredClone(warnings),
    setMangaChoices(next: Record<string, NativeSourceRestoreChoice>, inputKey?: string) {
      assertTarget();
      const state = workflow.snapshot();
      if (state.running || Object.values(state.units).some(status => status !== "pending")) throw Error("RESTORE_CHOICES_FROZEN");
      if (inputKey !== undefined) {
        inputChoices.set(inputKey, Object.fromEntries(Object.entries(next).map(([id, choice]) => [id, { ...choice }])));
        return;
      }
      for (const id of Object.keys(choices)) delete choices[id];
      for (const [id, choice] of Object.entries(next)) choices[id] = { ...choice };
    },
  });
}
