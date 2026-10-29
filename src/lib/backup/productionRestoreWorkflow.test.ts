import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string) => command === "restore_session_admit" ? "fixture-session" : null }));
const f = vi.hoisted(() => ({
  calls: [] as string[], failNovel: false, backendOffline: false,
  novelReady: true,
  parseApp: null as null | (() => Promise<void>),
  mangaInspectFailures: 0,
  mangaUnknown: false,
  inventoryLoads: 0,
  mangaChoices: [] as Record<string, unknown>[],
  readinessChoices: [] as Record<string, unknown>[],
  blockMangaChoice: false,
  store: { runtimeResolvedLocalProfileId: "production-test", runtimeServerUrl: "http://localhost:4567", settings: { defaultLocalProfileId: "current", booksCategories: [], booksCategoryAssignments: {} }, async prepareBooksForRestore() {}, async persistRestoredBooks() {} },
  payloads: ["books", "novels", "app"],
  parityTitles: [] as { sourceId: string; url: string; hasCategories: boolean }[],
  parityCategoryIds: [0, 3], failCategoryAdd: false,
  wakes: [] as string[], holds: 0, holdsDuringSend: [] as number[],
}));
vi.mock("../serverLifecycle", () => ({
  ensureServerAwakeFor: async (reason: string) => { f.wakes.push(reason); return true; },
  holdServerAwake: () => { f.holds += 1; let held = true; return () => { if (held) f.holds -= 1; held = false; }; },
}));
vi.mock("../../store/state.svelte", () => ({
  store: f.store, DEFAULT_READING_STATS: {}, bumpContentSetupVersion() {}, setLibraryMangaSnapshot() {},
  replaceBooksState() { f.calls.push("books"); }, async flushBookLibraryPersistence() {},
  replaceAppReadingState() { throw Error("Uncommitted App publication"); }, persistRestoredAppReadingState() { f.calls.push("app"); },
  updateSettings(patch: object) { Object.assign(f.store.settings, patch); },
}));
vi.mock("../client", () => ({ gql: async (query: string, variables?: { mangaId?: number; addTo?: number[] }) => {
  if (f.backendOffline) throw Error("offline");
  if (query.includes("EpigraphRestoreParityTitles")) {
    f.calls.push("categories-read");
    return { mangas: { pageInfo: { hasNextPage: false }, nodes: [{ id: 7, sourceId: "1", url: "/kept", categories: { nodes: f.parityCategoryIds.map(id => ({ id })) } }] } };
  }
  if (query.includes("EpigraphRestoreParityCategories")) {
    f.calls.push(`categories-add:${variables?.mangaId}:${variables?.addTo}`);
    if (f.failCategoryAdd) throw Error("offline");
    return {};
  }
  return { trackers: { nodes: [] }, mangas: { nodes: [] } };
} }));
vi.mock("../reconciliation/readiness", () => ({ buildRestoreReadiness: (_analysis: unknown, choices: Record<string, unknown>) => {
  f.readinessChoices.push(structuredClone(choices)); return { blocksRestore: f.blockMangaChoice && Object.keys(choices).length > 0 };
} }));
vi.mock("./mangaRestoreAdapter", () => ({ restoreProductionManga: async (_file: File, mode: { observationOnly?: boolean }) => {
  f.calls.push(mode.observationOnly ? "manga-observe" : "manga-send");
  f.holdsDuringSend.push(f.holds);
  return f.mangaUnknown ? { status: "unknown", code: "SUBMISSION_UNCERTAIN" } : { status: "succeeded" };
} }));
vi.mock("../novels/libraryState", () => ({ loadNovelLibraryStateForRestore: async () => ({ entries: [] }) }));
vi.mock("./restoreAdapters", async original => ({ ...await original<typeof import("./restoreAdapters")>(), prepareProductionNovels: async () => { if (!f.novelReady) throw Error("RESTORE_WAITING_FOR_DEPENDENCIES"); }, restoreProductionNovels: async () => {
  f.calls.push("novels"); if (f.failNovel) throw Error("disk full"); return { mergeWarnings: [], summary: { restoredMetadataOnlyCount: 0 } };
} }));
vi.mock("../../components/settings/settingsStorageRuntime", () => ({ loadSettingsStorageRuntime: async () => ({
  loadSourceInventory: async () => { f.inventoryLoads++; if (f.mangaInspectFailures-- > 0) throw Error("temporary inventory failure"); return { repoUrls: [], inventory: [], availableExtensions: [] }; },
  parseMihonBackup: async () => ({ backupManga: [], backupSources: [], extensionStores: [] }),
  parseEpigraphMangaPayload: async () => ({ payloadBytes: new Uint8Array() }),
  extractEpigraphMangaPayloadFile: async () => new File(["embedded"], "embedded.tachibk"),
  analyzeBackupReconciliation: async () => ({ analysis: { needsReview: [], unresolved: [] } }),
  buildReconciledBackupFile: (_parsed: unknown, _analysis: unknown, choices: Record<string, unknown>) => {
    f.mangaChoices.push(structuredClone(choices)); return new File(["reconciled"], "reconciled.tachibk");
  },
  buildMangaRestoreParityInput: () => f.parityTitles,
  overlayEntryFromAnalysis: () => ({}), upsertOverlayEntry: async () => {},
  readOverlayFile: async () => ({}), loadNovelRepositoryState: async () => ({ repositories: [], installedPlugins: [], catalogEntries: [] }),
  buildEpigraphRestorePlan: async () => ({ containerIssues: [], payloads: f.payloads.map(kind => ({ kind, present: true, status: "restorable", selectedByDefault: kind !== "novels" || f.novelReady, canExecuteRestore: true, canRestoreNow: kind !== "novels" || f.novelReady, metadata: {} })) }),
  parseEpigraphBooksPayload: async () => ({}), parseEpigraphNovelsPayload: async () => ({}),
  parseEpigraphAppPayload: async () => { await f.parseApp?.(); return { profile: { version: 2, defaultLocalProfileId: "foreign", history: [], readLog: [], readingStats: {} } }; },
  restoreEpigraphBooksPayload: async () => ({ books: [], bookProgress: [], bookBookmarks: [], booksCategories: [], booksCategoryAssignments: {}, booksLibraryUi: {}, issues: [] }),
}) }));
import { createProductionRestoreWorkflow } from "./productionRestoreWorkflow";
import { createProductionFirstRunBackupWorkflow } from "./firstRunBackupWorkflow";
const backup = (content = "one", name = "backup.epigraphbk") => new File([new Uint8Array([0x50, 0x4b]), content], name, { lastModified: 1 });

beforeEach(() => { f.calls = []; f.failNovel = false; f.backendOffline = false; f.novelReady = true; f.parseApp = null; f.mangaInspectFailures = 0; f.store.runtimeResolvedLocalProfileId = "production-test"; f.payloads = ["books", "novels", "app"]; f.parityTitles = []; f.parityCategoryIds = [0, 3]; f.failCategoryAdd = false; f.store.runtimeServerUrl = "http://localhost:4567"; f.store.settings.defaultLocalProfileId = "current"; f.wakes = []; f.holds = 0; f.holdsDuringSend = []; });
describe("active production restore contract", () => {
  it.each(["native", "epigraph"])("refuses an unavailable explicit Manga mapping during %s readiness", async format => {
    f.blockMangaChoice = true; f.payloads = ["manga"];
    try {
      const workflow = createProductionRestoreWorkflow();
      const files = await workflow.inspectFiles([format === "native" ? new File(["source"], "source.tachibk") : backup()]);
      workflow.setMangaChoices({ old: { mode: "map", sourceId: "missing", name: "Missing", lang: "en" } }, files[0].key);
      await expect(workflow.restoreFiles(files)).rejects.toThrow("RESTORE_WAITING_FOR_DEPENDENCIES");
      expect(workflow.snapshot().units).toEqual({});
      expect(f.calls).toEqual([]);
    } finally { f.blockMangaChoice = false; }
  });
  it("keeps library categories that the backup does not bring, as Mihon does", async () => {
    f.parityTitles = [{ sourceId: "1", url: "/kept", hasCategories: false }];
    const workflow = createProductionRestoreWorkflow();
    const files = await workflow.inspectFiles([new File(["source"], "source.tachibk")]);
    await workflow.restoreFiles(files);
    expect(f.calls).toEqual(["categories-read", "manga-send", "categories-add:7:3"]);
  });
  it("adds kept categories back on the next restore even when the server came back on another port", async () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); } });
    try {
      f.parityTitles = [{ sourceId: "1", url: "/kept", hasCategories: false }];
      f.failCategoryAdd = true;
      let workflow = createProductionRestoreWorkflow();
      await workflow.restoreFiles(await workflow.inspectFiles([new File(["source"], "source.tachibk")]));
      expect(workflow.warnings()).toEqual({ [Object.keys(workflow.warnings())[0]]: ["MANGA_RESTORE_CATEGORIES_NOT_KEPT"] });

      // The app restarted: the server listens on a new port and the restore had already cleared the title.
      f.store.runtimeServerUrl = "http://localhost:4610"; f.parityCategoryIds = []; f.failCategoryAdd = false; f.calls = [];
      workflow = createProductionRestoreWorkflow();
      await workflow.restoreFiles(await workflow.inspectFiles([new File(["source"], "source.tachibk")]));
      expect(f.calls).toEqual(["categories-read", "manga-send", "categories-add:7:3"]);
      expect(saved.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
  it("scopes reviewed Manga choices to the backup content in a multi-file First Run", async () => {
    f.mangaChoices = []; f.readinessChoices = [];
    const workflow = createProductionFirstRunBackupWorkflow();
    const files = await workflow.inspectFiles([new File(["a"], "a.tachibk"), new File(["b"], "b.tachibk")]);
    workflow.setMangaChoices({ old: { mode: "skip" } }, files[0].key);
    await workflow.restoreFiles(files);
    expect(f.mangaChoices).toEqual([{ old: { mode: "skip" } }, {}]);
    expect(f.readinessChoices.slice(0, 2)).toEqual([{ old: { mode: "skip" } }, {}]);
  });
  it("permits Manga choices before mutation and freezes them once work completed", async () => {
    const workflow = createProductionRestoreWorkflow();
    workflow.setMangaChoices({ old: { mode: "preserve" } });
    const files = await workflow.inspectFiles([new File(["choice"], "choice.tachibk")]);
    await workflow.restoreFiles(files);
    expect(() => workflow.setMangaChoices({ old: { mode: "skip" } })).toThrow("RESTORE_CHOICES_FROZEN");
  });
  it("refreshes standalone Manga inventory at readiness rather than trusting inspection", async () => {
    const workflow = createProductionRestoreWorkflow();
    const files = await workflow.inspectFiles([new File(["fresh"], "fresh.tachibk")]);
    const afterInspection = f.inventoryLoads;
    await workflow.restoreFiles(files);
    expect(f.inventoryLoads).toBeGreaterThan(afterInspection + 1);
  });
  it("honors an explicit domain exclusion while implicit Restore all refuses missing dependencies", async () => {
    f.novelReady = false;
    const all = createProductionFirstRunBackupWorkflow();
    const files = await all.inspectFiles([backup()]);
    await expect(all.restoreFiles(files)).rejects.toThrow("RESTORE_WAITING_FOR_DEPENDENCIES");
    expect(f.calls).toEqual([]);
    const selected = createProductionRestoreWorkflow({ selection: { books: true, app: true, novels: false } });
    await selected.restoreFiles(await selected.inspectFiles([backup()]));
    expect(f.calls).toEqual(["books", "app"]);
  });
  it("updates file progress after observation resolves an uncertain Manga result", async () => {
    const workflow = createProductionRestoreWorkflow();
    const files = await workflow.inspectFiles([new File(["observe"], "observe.tachibk")]);
    f.mangaUnknown = true;
    try { await expect(workflow.restoreFiles(files)).rejects.toThrow("SUBMISSION_UNCERTAIN"); }
    finally { f.mangaUnknown = false; }
    await workflow.restoreFiles(files);
    expect(f.calls).toEqual(["manga-send", "manga-observe"]);
    expect(files[0].restoreProgress).toBe(1);
  });
  it("rechecks readiness after dependencies resolve without changing the selected domain plan", async () => {
    f.payloads = ["novels"]; f.novelReady = false;
    const workflow = createProductionRestoreWorkflow({ selection: { novels: true } });
    const files = await workflow.inspectFiles([backup()]);
    expect(files[0].plan?.payloads[0].canRestoreNow).toBe(false);
    await expect(workflow.restoreFiles(files)).rejects.toThrow("RESTORE_WAITING_FOR_DEPENDENCIES");
    f.novelReady = true;
    await workflow.restoreFiles(files);
    expect(f.calls).toEqual(["novels"]);
  });
  it("retries a Manga preparation failure without fabricating a possibly accepted submission", async () => {
    const workflow = createProductionRestoreWorkflow();
    const files = await workflow.inspectFiles([new File(["manga"], "manga.tachibk")]);
    f.mangaInspectFailures = 1;
    await expect(workflow.restoreFiles(files)).rejects.toThrow("temporary inventory failure");
    // Fresh inventory now fails in readiness, before a domain invocation exists.
    expect(Object.values(workflow.snapshot().units)).toEqual([]);
    expect(f.calls).toEqual([]);
    await workflow.restoreFiles(files);
    expect(f.calls).toEqual(["manga-send"]);
  });
  it("refuses an App commit when its target changes during the domain parse", async () => {
    f.payloads = ["app"];
    let parses = 0;
    f.parseApp = async () => { if (++parses === 2) f.store.runtimeResolvedLocalProfileId = "different-profile"; };
    const workflow = createProductionRestoreWorkflow();
    const files = await workflow.inspectFiles([backup()]);
    await expect(workflow.restoreFiles(files)).rejects.toThrow("RESTORE_TARGET_CHANGED");
    expect(f.calls).toEqual([]);
  });
  it("collects unresolved Novel readiness before any selected domain mutates", async () => {
    f.novelReady = false;
    const workflow = createProductionRestoreWorkflow(); const files = await workflow.inspectFiles([backup()]);
    await expect(workflow.restoreFiles(files)).rejects.toThrow("RESTORE_WAITING_FOR_DEPENDENCIES");
    expect(f.calls).toEqual([]);
  });
  it("freezes plain choices from reactive UI objects without retaining their proxies", () => {
    const choices = new Proxy({}, {});
    expect(() => createProductionRestoreWorkflow({ mangaChoices: choices, selection: new Proxy({ app: true }, {}) })).not.toThrow();
  });
  it("retries only the failed domain inside a unified file and never retargets the profile", async () => {
    const workflow = createProductionRestoreWorkflow();
    const files = await workflow.inspectFiles([backup()]);
    f.failNovel = true;
    await expect(workflow.restoreFiles(files)).rejects.toThrow("disk full");
    f.failNovel = false;
    await workflow.restoreFiles(files);
    expect(f.calls).toEqual(["books", "novels", "app", "novels"]);
    expect(f.store.settings.defaultLocalProfileId).toBe("current");
  });
  it("Settings and First Run share the factory and produce identical content/domain plans", async () => {
    expect(createProductionFirstRunBackupWorkflow).toBe(createProductionRestoreWorkflow);
    const settings = createProductionRestoreWorkflow(), firstRun = createProductionFirstRunBackupWorkflow();
    const a = await settings.inspectFiles([backup()]), b = await firstRun.inspectFiles([backup("one", "renamed.epigraphbk")]);
    expect(a[0].key).toBe(b[0].key);
    await settings.restoreFiles(a); const first = [...f.calls]; f.calls = [];
    await firstRun.restoreFiles(b);
    expect(f.calls).toEqual(first);
    expect(settings.snapshot().units).toEqual(firstRun.snapshot().units);
    const changed = await settings.inspectFiles([backup("two")], a);
    expect(changed).toHaveLength(2);
  });
  it("wakes a server put in standby before reading Manga and keeps it awake until the restore ends", async () => {
    const workflow = createProductionRestoreWorkflow();
    const files = await workflow.inspectFiles([new File(["source"], "source.tachibk")]);
    expect(f.wakes).toEqual(["backup-restore"]);
    await workflow.restoreFiles(files);
    expect(f.holdsDuringSend).toEqual([1]);
    expect(f.holds).toBe(0);
    f.failNovel = true; f.payloads = ["novels"];
    const failing = createProductionRestoreWorkflow({ selection: { app: false, manga: false, books: false, novels: true } });
    await failing.restoreFiles(await failing.inspectFiles([backup("failing")])).catch(() => {});
    expect(f.calls).toContain("novels");
    expect(f.holds).toBe(0);
  });
  it("local-only inspection and execution do not require an available Manga server", async () => {
    f.backendOffline = true; f.payloads = ["app"];
    const workflow = createProductionRestoreWorkflow({ selection: { app: true, manga: false, books: false, novels: false } });
    const files = await workflow.inspectFiles([backup()]);
    expect(files[0].status).toBe("ready");
    await workflow.restoreFiles(files);
    expect(f.calls).toEqual(["app"]);
  });
});
