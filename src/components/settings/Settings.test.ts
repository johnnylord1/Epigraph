import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyAppLanguage, translate } from "../../lib/i18n/runtime";
import type { Tracker } from "../../lib/types";
import { DEFAULT_SETTINGS, store } from "../../store/state.svelte";

const {
  epigraphUpdateFixture,
  invokeMock,
  listenMock,
  emitToMock,
  getVersionMock,
  openUrlMock,
  openDialogMock,
  saveDialogMock,
  tauriFetchMock,
  gqlMock,
  loadSettingsStorageRuntimeMock,
  restoreProductionNovelsMock,
  productionWorkflowMock,
} = vi.hoisted(() => {
  const epigraphUpdateFixture = {
    releases: [{
      tag_name: "v4.2.0",
      name: "Epigraph 4.2.0",
      body: "Stable release.",
      published_at: "2026-07-21T00:00:00Z",
      html_url: "https://github.com/johnnylord1/Epigraph/releases/tag/v4.2.0",
    }],
    status: {
      update_available: false,
      current_version: "4.2.0",
      version: null as string | null,
      body: null as string | null,
      published_at: null as string | null,
    },
  };

  return {
    restoreProductionNovelsMock: vi.fn(),
    productionWorkflowMock: vi.fn(),
    epigraphUpdateFixture,
    invokeMock: vi.fn(async (command: string, _args?: Record<string, any>) => {
    if (command === "restore_session_admit") return "settings-fixture-session";
    if (command === "get_storage_info") {
      return {
        manga_bytes: 32_000_000,
        total_bytes: 256_000_000,
        free_bytes: 128_000_000,
        path: "C:/Epigraph",
      };
    }
    if (command === "get_default_downloads_path") return "C:/Epigraph/Downloads";
    if (command === "list_releases") {
      return epigraphUpdateFixture.releases;
    }
    if (command === "check_epigraph_update") {
      return epigraphUpdateFixture.status;
    }
    if (command === "restart_app") return null;
    if (command === "get_suwayomi_runtime_status") {
      return {
        mode: "managed-bundled",
        version: "v2.1.1867",
        jarVersion: null,
        jarPath: "C:/Epigraph/Suwayomi-Server.jar",
        profileId: "main",
        rootDir: "C:/Epigraph/epigraph-main",
        serverUrl: "http://127.0.0.1:4567",
        updateAllowed: true,
        blockReason: null,
      };
    }
    if (command === "check_suwayomi_runtime_update") {
      return {
        status: "updateAvailable",
        currentVersion: "v2.1.1867",
        latestCompatibleVersion: "v2.2.2100",
        releaseTag: "v2.2.2100",
        releaseUrl: "https://github.com/Suwayomi/Suwayomi-Server/releases/tag/v2.2.2100",
        updateAllowed: true,
        blockReason: null,
        notes: "Tested by Epigraph.",
        releaseNotes: "Release notes.",
      };
    }
    if (command === "get_flaresolverr_local_status") {
      return { installed: false, running: false, path: null, message: null };
    }
    if (command === "get_flaresolverr_docker_status") {
      return { installed: false, daemon: false, running: false, version: null, message: null };
    }
    return null;
    }),
    listenMock: vi.fn(async () => () => {}),
    emitToMock: vi.fn(async () => {}),
    getVersionMock: vi.fn(async () => "4.2.0"),
    openUrlMock: vi.fn(async () => {}),
    openDialogMock: vi.fn(async () => null),
    saveDialogMock: vi.fn(async () => null),
    tauriFetchMock: vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    })),
    loadSettingsStorageRuntimeMock: vi.fn(async () => ({
    parseMihonBackup: vi.fn(async (): Promise<{ trackerIds: number[]; backupSources?: unknown[]; backupManga?: unknown[]; extensionStores?: unknown[] }> => ({ trackerIds: [] })),
    embedMihonExtensionStores: vi.fn((bytes) => bytes),
    buildEpigraphBackupContainer: vi.fn(async () => ({ bytes: new Uint8Array() })),
    buildEpigraphRestorePlan: vi.fn(async () => ({ payloads: [], summary: { summaryLabel: "", summaryBody: "" }, containerIssues: [], executionBlockedReason: null })),
    buildEpigraphAppPayload: vi.fn(() => ({})),
    parseEpigraphAppPayload: vi.fn(async () => ({})),
    buildEpigraphBooksSnapshotFromLibraryState: vi.fn((state) => state),
    buildEpigraphBooksPayload: vi.fn(async () => ({})),
    parseEpigraphBooksPayload: vi.fn(async () => ({ library: { books: [] } })),
    restoreEpigraphBooksPayload: vi.fn(async () => ({ books: [], bookProgress: [], bookBookmarks: [], booksCategories: [], booksCategoryAssignments: {}, booksLibraryUi: { activeCategoryId: null, typeFilter: "all", statusFilter: "all", search: "", sortMode: "recentlyAdded", sortDir: "desc" }, issues: [], exportMode: "full" })),
    extractEpigraphMangaPayloadFile: vi.fn(async () => new File([], "backup.tachibk")),
    parseEpigraphMangaPayload: vi.fn(async () => ({ payloadManifest: { requiresRepositories: [] } })),
    buildEpigraphMangaPayload: vi.fn(async () => ({})),
    buildEpigraphNovelsPayload: vi.fn(async () => ({})),
    parseEpigraphNovelsPayload: vi.fn(async () => ({ snapshot: { entries: [], chapters: [], repositories: [], plugins: [] } })),
    restoreEpigraphNovelsPayload: vi.fn(async () => ({ summary: { totalEntries: 0, restoredMetadataOnlyCount: 0, restoredUsableCount: 0 } })),
    buildLnReaderNovelsBackupZip: vi.fn(async () => new Uint8Array()),
    restoreLnReaderNovelsBackup: vi.fn(async () => ({ summary: { totalEntries: 0, restoredMetadataOnlyCount: 0, restoredUsableCount: 0, restoredNeedsRepositoryCount: 0, restoredNeedsPluginCount: 0 } })),
    parseLnReaderNovelsBackup: vi.fn(async () => ({
      entries: [] as Array<{ id: string }>,
      chapters: [] as Array<{ id: string }>,
      repositories: [] as Array<{ url: string; name: string }>,
      plugins: [] as Array<{ id: string; name: string }>,
    })),
    isLnReaderBackupZip: vi.fn(async () => true),
    extractLnReaderBackupPluginIds: vi.fn(async () => []),
    normalizeNativeMangaBackupBytes: vi.fn((bytes) => bytes),
    buildEpigraphNovelsSnapshotFromAuthoritativeState: vi.fn((input) => input.libraryState),
    applyRestoredNovelsSnapshotToLibraryState: vi.fn(({ currentState }) => currentState),
    loadBookLibraryState: vi.fn(async () => ({ books: [], bookProgress: [], bookBookmarks: [], booksCategories: [], booksCategoryAssignments: {}, booksLibraryUi: { activeCategoryId: null, typeFilter: "all", statusFilter: "all", search: "", sortMode: "recentlyAdded", sortDir: "desc" } })),
    loadNovelLibraryState: vi.fn(async () => ({ entries: [], chapters: [], progress: [], bookmarks: [], history: [], scopeKey: "profile:test", version: 1 })),
    saveNovelLibraryState: vi.fn(async (state) => state),
    loadNovelsProfileSnapshot: vi.fn(() => ({})),
    applyRestoredNovelsProfileSnapshot: vi.fn(),
    loadSourceInventory: vi.fn(async () => ({ inventory: [], availableExtensions: [], repoUrls: [], warnings: [] })),
    readOverlayFile: vi.fn(async () => []),
    upsertOverlayEntry: vi.fn(async () => {}),
    analyzeBackupReconciliation: vi.fn(async (): Promise<{ analysis: { exactMatches?: unknown[]; autoReconciled?: unknown[]; needsReview: unknown[]; unresolved: unknown[]; warnings: unknown[] } }> => ({ analysis: { needsReview: [], unresolved: [], warnings: [] } })),
    overlayEntryFromAnalysis: vi.fn(() => ({})),
    buildReconciledBackupFile: vi.fn(() => new File([], "reconciled.tachibk")),
    readFileAsArrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    loadNovelRepositoryState: vi.fn(async () => ({ repositories: [], installedPlugins: [], catalogEntries: [] })),
    saveNovelRepositoryState: vi.fn(async (state) => state),
    addNovelRepositoryToState: vi.fn((state) => state),
    setNovelRepositoryTrustState: vi.fn((state) => state),
    refreshNovelRepositoryCatalog: vi.fn(async (state, repositoryId) => ({
      status: "success",
      state,
      repository: state.repositories.find((entry: { id: string }) => entry.id === repositoryId) ?? { lastError: null },
    })),
    installNovelCatalogPlugin: vi.fn(async ({ state }) => state),
    provisionEpigraphNovelDependencies: vi.fn(async ({ state }) => ({
      state,
      addedRepositories: 0,
      installedPlugins: 0,
      warnings: [],
    })),
  })),
  gqlMock: vi.fn(async (query: string, _variables?: unknown) => {
    const normalized = String(query).toLowerCase();
    if (normalized.includes("sources")) return { sources: { nodes: [] } };
    if (normalized.includes("extensions")) return { extensions: { nodes: [] } };
    if (normalized.includes("trackers")) return { trackers: { nodes: [] as Tracker[] } };
    if (normalized.includes("settings")) {
      return { settings: { downloadsPath: "C:/Epigraph/Downloads", localSourcePath: "" } };
    }
    if (normalized.includes("serversecurity")) {
      return {
        serverSecurity: {
          authMode: "NONE",
          authUsername: "",
          authPassword: "",
          socksProxyEnabled: false,
          socksProxyHost: "",
          socksProxyPort: "",
          socksProxyVersion: 5,
          socksProxyUsername: "",
          socksProxyPassword: "",
          flareSolverrEnabled: false,
          flareSolverrUrl: "",
          flareSolverrTimeout: 60000,
          flareSolverrSessionName: "",
          flareSolverrSessionTtl: 15,
          flareSolverrAsResponseFallback: false,
        },
      };
    }
    return {};
  }),
  };
});

vi.mock("../../lib/backup/restoreAdapters", () => ({ prepareProductionNovels: async () => {}, restoreProductionNovels: restoreProductionNovelsMock }));
vi.mock("../../lib/backup/productionRestoreWorkflow", async original => {
  const actual = await original<typeof import("../../lib/backup/productionRestoreWorkflow")>();
  productionWorkflowMock.mockImplementation(actual.createProductionRestoreWorkflow);
  return { ...actual, createProductionRestoreWorkflow: productionWorkflowMock };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  convertFileSrc: vi.fn((path: string) => path),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
  emitTo: emitToMock,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class MockJsdomWebviewWindow {
    label: string;

    constructor(label: string) {
      this.label = label;
    }

    static async getByLabel(_label: string) {
      return null;
    }

    async destroy() {
      return;
    }

    async once() {
      return () => {};
    }
  },
  getCurrentWebviewWindow: vi.fn(() => ({ label: "main" })),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: getVersionMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openDialogMock,
  save: saveDialogMock,
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: tauriFetchMock,
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: openUrlMock,
}));

vi.mock("../../lib/client", () => ({
  gql: gqlMock,
  gqlUpload: vi.fn(async () => ({})),
  thumbUrl: vi.fn((path: string) => path),
  getServerAuthHeader: vi.fn(() => null),
  serverFileUrl: vi.fn((path: string) => path),
}));

vi.mock("./settingsStorageRuntime", () => ({
  SETTINGS_EPIGRAPH_BACKUP_EXTENSION: ".epigraphbk",
  loadSettingsStorageRuntime: loadSettingsStorageRuntimeMock,
}));

import Settings from "./Settings.svelte";

function resetSettingsStore() {
  store.settings = {
    ...DEFAULT_SETTINGS,
    customThemes: [],
    booksCategories: [],
    booksCategoryAssignments: {},
  };
  store.navPage = "settings";
  store.lastPrimaryNavPage = "home";
  store.settingsOpen = true;
  store.runtimeSettingsTab = null;
  store.categories = [];
}

function renderSettings(props: Record<string, unknown> = {}) {
  const appShell = document.createElement("div");
  appShell.id = "app-shell";

  const opener = document.createElement("button");
  opener.type = "button";
  opener.textContent = "Open settings";

  appShell.append(opener);
  document.body.appendChild(appShell);
  opener.focus();

  const onOpenThemeEditor = vi.fn();
  const result = render(Settings, {
    target: appShell,
    props: { onOpenThemeEditor, ...props },
  });

  return { ...result, appShell, opener, onOpenThemeEditor };
}

describe("Settings", () => {
  beforeEach(() => {
    resetSettingsStore();
    epigraphUpdateFixture.releases = [{
      tag_name: "v4.2.0",
      name: "Epigraph 4.2.0",
      body: "Stable release.",
      published_at: "2026-07-21T00:00:00Z",
      html_url: "https://github.com/johnnylord1/Epigraph/releases/tag/v4.2.0",
    }];
    epigraphUpdateFixture.status = {
      update_available: false,
      current_version: "4.2.0",
      version: null,
      body: null,
      published_at: null,
    };
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    invokeMock.mockClear();
    listenMock.mockClear();
    emitToMock.mockClear();
    getVersionMock.mockClear();
    openUrlMock.mockClear();
    openDialogMock.mockClear();
    saveDialogMock.mockClear();
    tauriFetchMock.mockClear();
    gqlMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  test("renders the approved grouped rails as a page-level shell without a redundant close button", async () => {
    const { container } = renderSettings();

    expect(container.querySelector(".settings-page.epigraph-port--settings")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Settings groups" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reader & Library" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close settings" })).toBeNull();
  });

  test("keeps the available Epigraph update action visible when release history is hidden", async () => {
    epigraphUpdateFixture.releases = [
      {
        tag_name: "v4.3.0",
        name: "Epigraph 4.3.0",
        body: "New reader fixes.",
        published_at: "2026-08-30T00:00:00Z",
        html_url: "https://github.com/johnnylord1/Epigraph/releases/tag/v4.3.0",
      },
      ...epigraphUpdateFixture.releases,
    ];
    epigraphUpdateFixture.status = {
      update_available: true,
      current_version: "4.2.0",
      version: "4.3.0",
      body: "New reader fixes.",
      published_at: "2026-08-30T00:00:00Z",
    };

    renderSettings();
    await fireEvent.click(screen.getByRole("button", { name: "Open about settings" }));

    const availableUpdate = await screen.findByTestId("epigraph-update-available");
    expect(within(availableUpdate).getByText("v4.3.0 available")).toBeTruthy();
    expect(within(availableUpdate).getByRole("button")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    const releaseHistory = screen.getByTestId("epigraph-release-history");
    expect(within(releaseHistory).queryByRole("button", { name: "Install" })).toBeNull();
    expect(within(releaseHistory).queryByRole("button", { name: "View" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Hide" }));

    expect(screen.getByTestId("epigraph-update-available")).toBeTruthy();
  });

  test("switches groups and contextual tabs without changing the imported shell", async () => {
    const { container } = renderSettings();

    const generalPane = container.querySelector<HTMLElement>('[data-settings-pane="general"]');
    const appearancePane = container.querySelector<HTMLElement>('[data-settings-pane="appearance"]');
    const trackingPane = container.querySelector<HTMLElement>('[data-settings-pane="tracking"]');

    expect(generalPane).toBeTruthy();
    expect(appearancePane).toBeTruthy();
    expect(trackingPane).toBeTruthy();
    expect(generalPane?.hidden).toBe(false);
    expect(appearancePane?.hidden).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: "Content & Integrations" }));
    expect(screen.getByRole("heading", { name: "Content" })).toBeTruthy();
    expect(trackingPane?.hidden).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: "Tracking" }));
    expect(screen.getByRole("heading", { name: "Tracking" })).toBeTruthy();
    expect(trackingPane?.hidden).toBe(false);
    expect(generalPane?.hidden).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: "System" }));
    expect(screen.getByRole("heading", { name: "Storage" })).toBeTruthy();
  });

  test("keeps heavy storage and tracking subtrees lazy until their panes are visited", async () => {
    renderSettings();

    expect(screen.queryByText("Usage")).toBeNull();
    expect(screen.queryByText("Connected services")).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "System" }));
    expect(screen.getByText("Usage")).toBeTruthy();
    expect(screen.queryByText("Connected services")).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "Content & Integrations" }));
    expect(screen.queryByText("Connected services")).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "Tracking" }));
    expect(screen.getByText("Connected services")).toBeTruthy();
  });

  test("renders tracker services and their actions when embedded in first-run setup", async () => {
    const { container } = renderSettings({ firstRunPane: "tracking" });

    expect(await screen.findByText("Connected services")).toBeTruthy();
    expect(await screen.findByAltText("Hardcover")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Login" })).toBeTruthy();
    expect(container.querySelector<HTMLElement>('[data-settings-pane="tracking"]')?.hidden).toBe(false);
    expect(screen.queryByRole("navigation", { name: "Settings groups" })).toBeNull();
  });

  test("flushes and exports books from the active runtime profile", async () => {
    const runtime = await loadSettingsStorageRuntimeMock();
    loadSettingsStorageRuntimeMock.mockClear();
    loadSettingsStorageRuntimeMock.mockResolvedValue(runtime);
    const flushSpy = vi.spyOn(store, "flushBookLibraryPersistence").mockResolvedValue();
    store.runtimeResolvedLocalProfileId = "test";

    renderSettings();
    await fireEvent.click(screen.getByRole("button", { name: "System" }));
    await fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    await fireEvent.click(screen.getByRole("button", { name: "Books only" }));
    await fireEvent.click(screen.getByRole("button", { name: "Export backup" }));

    await waitFor(() => {
      expect(flushSpy).toHaveBeenCalledTimes(1);
      expect(runtime.loadBookLibraryState).toHaveBeenCalledWith({ profileId: "test" });
    });
    flushSpy.mockRestore();
  });

  test("uses bundled branding for the native Hardcover tracker", async () => {
    renderSettings();
    await fireEvent.click(screen.getByRole("button", { name: "Content & Integrations" }));
    await fireEvent.click(screen.getByRole("button", { name: "Tracking" }));

    await waitFor(() => expect(screen.getByAltText("Hardcover")).toBeTruthy());
    const hardcoverLogo = screen.getByAltText("Hardcover") as HTMLImageElement;
    expect(hardcoverLogo.src).not.toContain("hardcover.app/favicon");
  });

  test("stops after a failed tracker load and retries only when requested", async () => {
    const originalImplementation = gqlMock.getMockImplementation();
    let trackerRequests = 0;
    gqlMock.mockImplementation(async (query: string) => {
      const normalized = String(query).toLowerCase();
      if (normalized.includes("query gettrackers")) {
        trackerRequests += 1;
        if (trackerRequests === 1) throw new Error("Tracker service unavailable");
        return {
          trackers: {
            nodes: [{
              id: 1,
              name: "MyAnimeList",
              icon: "",
              isLoggedIn: true,
              authUrl: null,
              supportsPrivateTracking: false,
              scores: [],
              statuses: [],
            }],
          },
        };
      }
      return originalImplementation!(query);
    });

    renderSettings();
    await fireEvent.click(screen.getByRole("button", { name: "Content & Integrations" }));
    await fireEvent.click(screen.getByRole("button", { name: "Tracking" }));

    await waitFor(() => {
      expect(screen.getByText(translate("firstRun.trackers.loadError"))).toBeTruthy();
    });
    expect(trackerRequests).toBe(1);
    applyAppLanguage("pt-BR");
    await waitFor(() => expect(screen.getByText(translate("firstRun.trackers.loadError"))).toBeTruthy());
    expect(screen.queryByText("Tracker service unavailable")).toBeNull();
    applyAppLanguage("en");
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());

    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(screen.getByText("MyAnimeList")).toBeTruthy();
    });
    expect(trackerRequests).toBe(2);
    gqlMock.mockImplementation(originalImplementation!);
  });

  test("completes tracker OAuth only from the login window it opened", async () => {
    const originalImplementation = gqlMock.getMockImplementation();
    const logins: unknown[] = [];
    gqlMock.mockImplementation(async (query: string, variables?: unknown) => {
      const normalized = String(query).toLowerCase();
      if (normalized.includes("query gettrackers")) {
        return {
          trackers: {
            nodes: [{
              id: 2,
              name: "AniList",
              icon: "",
              isLoggedIn: false,
              authUrl: "https://anilist.test/oauth?response_type=token",
              supportsPrivateTracking: false,
              scores: [],
              statuses: [],
            }],
          },
        };
      }
      if (normalized.includes("mutation logintrackeroauth")) logins.push(variables);
      return originalImplementation!(query);
    });
    const listeners = new Map<string, (event: { payload: unknown }) => unknown>();
    listenMock.mockImplementation((async (name: string, handler: (event: { payload: unknown }) => unknown) => {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    }) as any);

    renderSettings();
    await fireEvent.click(screen.getByRole("button", { name: "Content & Integrations" }));
    await fireEvent.click(screen.getByRole("button", { name: "Tracking" }));
    const aniListRow = (await screen.findByAltText("AniList")).closest<HTMLElement>(".settings-row")!;
    await fireEvent.click(within(aniListRow).getByRole("button", { name: "Login" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("open_tracker_oauth_window", { url: "https://anilist.test/oauth?response_type=token", sessionId: expect.any(String) }));
    const sessionId = invokeMock.mock.calls.find(([command]) => command === "open_tracker_oauth_window")![1]!.sessionId;
    const callback = listeners.get("tracker-oauth-callback")!;
    await callback({ payload: { url: "https://suwayomi.org/tracker-oauth#access_token=forged" } });
    await callback({ payload: { url: "https://suwayomi.org/tracker-oauth#access_token=forged", sessionId: "other-window" } });
    expect(logins).toEqual([]);

    await callback({ payload: { url: "https://suwayomi.org/tracker-oauth#access_token=real", sessionId } });
    await waitFor(() => expect(logins).toEqual([{ trackerId: 2, callbackUrl: "access_token=real" }]));
    listenMock.mockImplementation(async () => () => {});
    gqlMock.mockImplementation(originalImplementation!);
  });

  test("toggles storage expansion panels from their own buttons", async () => {
    renderSettings();

    await fireEvent.click(screen.getByRole("button", { name: "System" }));

    expect(screen.queryByText("Path editor")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Edit paths" }));
    expect(screen.getByText("Path editor")).toBeTruthy();
    await fireEvent.click(screen.getAllByRole("button", { name: "Close" }).find((button) => button.textContent?.trim() === "Close")!);
    expect(screen.queryByText("Path editor")).toBeNull();

    expect(screen.queryByText("Usage guardrails")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: /limit$/i }));
    expect(screen.getByText("Usage guardrails")).toBeTruthy();
    await fireEvent.click(screen.getAllByRole("button", { name: "Close" }).find((button) => button.textContent?.trim() === "Close")!);
    expect(screen.queryByText("Usage guardrails")).toBeNull();

    expect(screen.queryByText("Export")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    expect(screen.getByText("Export")).toBeTruthy();
    await fireEvent.click(screen.getAllByRole("button", { name: "Close" }).find((button) => button.textContent?.trim() === "Close")!);
    expect(screen.queryByText("Export")).toBeNull();
  });

  test("refuses a downloads folder inside the current one before the server switches to it", async () => {
    const baseInvoke = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((async (command: string, args?: Record<string, any>) => {
      if (command === "check_path_exists") return true;
      if (command === "check_downloads_move") {
        if (String(args?.dst).startsWith("C:/Epigraph/Downloads/mangas")) throw "DOWNLOADS_PATH_NESTED";
        return null;
      }
      return baseInvoke(command, args);
    }) as typeof baseInvoke);
    try {
      renderSettings();
      await fireEvent.click(screen.getByRole("button", { name: "System" }));
      await fireEvent.click(screen.getByRole("button", { name: "Edit paths" }));
      const input = await screen.findByDisplayValue("C:/Epigraph/Downloads");
      const saves = () => gqlMock.mock.calls.filter(([, variables]) => (variables as { path?: string } | undefined)?.path !== undefined);

      await fireEvent.input(input, { target: { value: "C:/Epigraph/Downloads/mangas/moved" } });
      await fireEvent.keyDown(input, { key: "Enter" });
      expect(await screen.findByText(translate("outcomes.downloadsPathNested"))).toBeTruthy();
      expect(invokeMock).toHaveBeenCalledWith("check_downloads_move", { src: "C:/Epigraph/Downloads", dst: "C:/Epigraph/Downloads/mangas/moved" });
      expect(saves()).toEqual([]);
      expect(screen.queryByText("Migration")).toBeNull();

      await fireEvent.input(input, { target: { value: "D:/Library" } });
      await fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(saves().map(([, variables]) => variables)).toEqual([{ path: "D:/Library" }]));
      expect(await screen.findByText("C:/Epigraph/Downloads → D:/Library")).toBeTruthy();
    } finally {
      invokeMock.mockImplementation(baseInvoke);
    }
  });

  test("the folder picker opens the path editor to show a refused folder or the offer to move the files", async () => {
    const baseInvoke = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((async (command: string, args?: Record<string, any>) => {
      if (command === "check_path_exists") return true;
      if (command === "check_downloads_move") {
        if (String(args?.dst).startsWith("C:/Epigraph/Downloads/mangas")) throw "DOWNLOADS_PATH_NESTED";
        return null;
      }
      return baseInvoke(command, args);
    }) as typeof baseInvoke);
    try {
      renderSettings();
      await fireEvent.click(screen.getByRole("button", { name: "System" }));
      const saves = () => gqlMock.mock.calls.filter(([, variables]) => (variables as { path?: string } | undefined)?.path !== undefined);
      expect(screen.queryByText("Path editor")).toBeNull();

      openDialogMock.mockResolvedValueOnce("C:/Epigraph/Downloads/mangas/moved" as never);
      await fireEvent.click(screen.getAllByRole("button", { name: "Browse" })[0]);
      expect(await screen.findByText(translate("outcomes.downloadsPathNested"))).toBeTruthy();
      expect(screen.getByText("Path editor")).toBeTruthy();
      expect(saves()).toEqual([]);
      // The summary keeps naming the folder in use, not the refused one.
      expect(screen.queryByText("C:/Epigraph/Downloads/mangas/moved")).toBeNull();

      await fireEvent.click(screen.getAllByRole("button", { name: "Close" }).find((button) => button.textContent?.trim() === "Close")!);
      expect(screen.queryByText("Path editor")).toBeNull();
      openDialogMock.mockResolvedValueOnce("D:/Library" as never);
      await fireEvent.click(screen.getAllByRole("button", { name: "Browse" })[0]);
      await waitFor(() => expect(saves().map(([, variables]) => variables)).toEqual([{ path: "D:/Library" }]));
      expect(await screen.findByText("C:/Epigraph/Downloads → D:/Library")).toBeTruthy();
      expect(screen.getByText("Path editor")).toBeTruthy();
    } finally {
      invokeMock.mockImplementation(baseInvoke);
    }
  });

  test("presents a backup audit as a simple visual restore summary", async () => {
    store.runtimeSettingsTab = "storage";
    renderSettings({
      backupAuditPlan: {
        payloads: [{
          kind: "manga",
          present: true,
          status: "warning-only",
          defaultRestoreMode: "full",
          availableRestoreModes: ["full"],
          summaryLabel: "Extension repositories will be restored first",
          reasons: [],
          warnings: [{ code: "missing-required-repository", message: "One repository will be added." }],
          metadata: { mangaCount: 24 },
          selectedByDefault: true,
          canRestoreNow: true,
          needsUserAction: false,
          canExecuteRestore: true,
        }],
        topLevelSkipped: [],
        containerIssues: [],
        recommendedSelection: ["manga"],
        defaultTarget: "sandbox-profile",
        canProceedWithRecommendedSelection: true,
        hasBlockedPayloads: false,
        hasUnsupportedPayloads: false,
        executionBlockedReason: null,
        summary: { summaryLabel: "Ready", summaryBody: "Choose what you want to restore." },
      },
    });

    await waitFor(() => expect(document.querySelector("[data-backup-review]")).toBeTruthy());
    expect(screen.getByText("24 titles")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Selected" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Info").closest("details")?.hasAttribute("open")).toBe(false);
  });

  test("recognizes an LNReader ZIP selected through the restore file input", async () => {
    const storageRuntime = await loadSettingsStorageRuntimeMock();
    storageRuntime.parseLnReaderNovelsBackup.mockResolvedValue({
      entries: Array.from({ length: 9 }, (_, index) => ({ id: `novel-${index}` })),
      chapters: Array.from({ length: 6936 }, (_, index) => ({ id: `chapter-${index}` })),
      repositories: [
        { url: "https://repo-one.example/plugins.min.json", name: "Repository one" },
        { url: "https://repo-two.example/plugins.min.json", name: "Repository two" },
      ],
      plugins: Array.from({ length: 19 }, (_, index) => ({ id: `plugin-${index}`, name: `Plugin ${index}` })),
    });
    loadSettingsStorageRuntimeMock.mockResolvedValue(storageRuntime);
    store.runtimeSettingsTab = "storage";
    store.runtimeResolvedLocalProfileId = "test";
    const { container } = renderSettings();

    await fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).toBeTruthy();

    const backup = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "lnreader_backup.zip", {
      type: "application/zip",
    });
    await fireEvent.change(input!, { target: { files: [backup] } });

    await waitFor(() => expect(screen.getByText(/Detected format: LNReader ZIP/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Review Novel dependencies" })).toBeTruthy();
    await waitFor(() => {
      const preview = container.querySelector("[data-backup-dependencies]");
      expect(preview?.textContent).toContain("9 titles");
      expect(preview?.textContent).toContain("6936 chapters");
      expect(preview?.textContent).toContain("2 repositories");
      expect(preview?.textContent).toContain("19 extensions");
    });
    await fireEvent.click(screen.getByRole("switch", { name: "Confirm current profile restore" }));
    expect(screen.getByRole("button", { name: "LNReader novels restore" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "Review & approve" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "LNReader novels restore" }).hasAttribute("disabled")).toBe(false));

    let rejectRestore!: (error: Error) => void;
    restoreProductionNovelsMock.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectRestore = reject;
    }));
    const restoreButton = screen.getByRole("button", { name: "LNReader novels restore" });
    await fireEvent.click(restoreButton);
    await waitFor(() => expect(productionWorkflowMock).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".backup-progress")?.textContent).toMatch(/Restoring/i));
    expect(restoreButton.hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(rejectRestore).toBeTypeOf("function"));
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(productionWorkflowMock.mock.results.at(-1)?.value.snapshot().cancelled).toBe(true);
    rejectRestore(new Error("Repository is temporarily unavailable. Please retry."));
    await waitFor(() => expect(screen.getByText(translate("firstRun.backup.restoreError"))).toBeTruthy());
    expect(container.querySelector(".backup-progress")).toBeNull();
    expect(screen.getByRole("button", { name: "LNReader novels restore" }).hasAttribute("disabled")).toBe(false);
    // About ten role queries over the whole Settings page take 3-4 s alone and more under full-suite load.
  }, 15_000);

  test("offers the shared Manga dependency review after selecting a native backup", async () => {
    const runtime = await loadSettingsStorageRuntimeMock();
    runtime.parseMihonBackup.mockResolvedValue({ trackerIds: [], backupSources: [], backupManga: [], extensionStores: [] });
    runtime.analyzeBackupReconciliation.mockResolvedValue({ analysis: { exactMatches: [], autoReconciled: [], needsReview: [], unresolved: [], warnings: [] } });
    loadSettingsStorageRuntimeMock.mockResolvedValue(runtime);
    store.runtimeSettingsTab = "storage"; store.runtimeResolvedLocalProfileId = "test";
    const { container } = renderSettings();
    await fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await fireEvent.change(input, { target: { files: [new File(["fixture"], "backup.tachibk")] } });
    expect(await screen.findByRole("button", { name: "Review Manga dependencies" })).toBeTruthy();
    expect(gqlMock.mock.calls.some(([query]) => /updateExtension/i.test(String(query)))).toBe(false);
  });

  test("rebinds the appearance pane theme editor affordances and help action", async () => {
    const { onOpenThemeEditor } = renderSettings();

    await fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();

    await fireEvent.click(screen.getByTitle("Create a custom theme"));
    expect(onOpenThemeEditor).toHaveBeenCalledWith(null);

    await fireEvent.click(screen.getByRole("button", { name: "Open about settings" }));
    expect(screen.getByRole("heading", { name: "About" })).toBeTruthy();
  });

  test("switches the OLED control to the AMOLED builtin and restores the previous theme", async () => {
    store.settings.theme = "dark";
    renderSettings();
    await fireEvent.click(screen.getByRole("button", { name: "Appearance" }));

    const oled = screen.getByRole("switch", { name: "OLED dark mode" });
    expect(oled.getAttribute("aria-checked")).toBe("false");

    await fireEvent.click(oled);
    expect(store.settings.theme).toBe("amoled");
    expect(oled.getAttribute("aria-checked")).toBe("true");

    await fireEvent.click(oled);
    expect(store.settings.theme).toBe("dark");
    expect(oled.getAttribute("aria-checked")).toBe("false");
  });

  test("keeps section search out of the pane header and resets all settings from the dedicated advanced card", async () => {
    renderSettings();

    expect(screen.queryByRole("button", { name: "Section search" })).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    await fireEvent.click(screen.getByRole("button", { name: "Dev Tools" }));

    store.settings.discordRpc = true;
    expect(store.settings.discordRpc).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: "Reset all settings" }));

    expect(store.settings.discordRpc).toBe(DEFAULT_SETTINGS.discordRpc);
    expect(store.settings.theme).toBe("nocturne");
    expect(screen.getByText("Reset settings")).toBeTruthy();
  });

  test("keeps optimized Discord covers opt-in by default", async () => {
    renderSettings();

    expect(DEFAULT_SETTINGS.discordRpcImproveCovers).toBe(false);
    expect(store.settings.discordRpcImproveCovers).toBe(false);

    const toggle = screen.getByRole("switch", { name: "Improve Discord cover framing" }) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(true);

    await fireEvent.click(screen.getByRole("switch", { name: "Discord Rich Presence" }));
    expect(store.settings.discordRpc).toBe(true);
    await waitFor(() => expect(toggle.disabled).toBe(false));

    await fireEvent.click(toggle);

    expect(store.settings.discordRpcImproveCovers).toBe(true);
  });

  test("saves the FlareSolverr switch immediately and reverts it when the server refuses", async () => {
    const originalImplementation = gqlMock.getMockImplementation();
    let refuse = false;
    gqlMock.mockImplementation(async (query: string, variables?: unknown) => {
      if (String(query).includes("SetFlareSolverr")) {
        if (refuse) throw new Error("server offline");
        return {};
      }
      if (String(query).includes("GetServerSecurity")) {
        const settings = {
          authMode: "NONE", authUsername: "",
          socksProxyEnabled: false, socksProxyHost: "", socksProxyPort: "", socksProxyVersion: 5, socksProxyUsername: "",
          flareSolverrEnabled: false, flareSolverrUrl: "http://localhost:8191", flareSolverrTimeout: 60,
          flareSolverrSessionName: "epigraph", flareSolverrSessionTtl: 15, flareSolverrAsResponseFallback: false,
        };
        return { settings } as unknown as Awaited<ReturnType<typeof originalImplementation & {}>>;
      }
      return originalImplementation!(query, variables);
    });
    try {
      renderSettings();
      await fireEvent.click(screen.getByRole("button", { name: "System" }));
      await fireEvent.click(screen.getByRole("button", { name: "Security" }));

      const [toggle] = screen.getAllByRole("switch", { name: "Enable FlareSolverr" });
      expect(toggle.getAttribute("aria-checked")).toBe("false");

      await fireEvent.click(toggle);
      await waitFor(() => expect(store.settings.flareSolverrEnabled).toBe(true));
      expect(gqlMock).toHaveBeenCalledWith(
        expect.stringContaining("SetFlareSolverr"),
        expect.objectContaining({ flareSolverrEnabled: true }),
      );
      expect(toggle.getAttribute("aria-checked")).toBe("true");

      refuse = true;
      await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
      await fireEvent.click(toggle);
      await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
      expect(store.settings.flareSolverrEnabled).toBe(true);
      expect(gqlMock).toHaveBeenLastCalledWith(
        expect.stringContaining("SetFlareSolverr"),
        expect.objectContaining({ flareSolverrEnabled: false }),
      );
    } finally {
      gqlMock.mockImplementation(originalImplementation!);
    }
  });

  test("renders density as a discrete slider-family control with fixed steps", async () => {
    renderSettings();

    await fireEvent.click(screen.getByRole("button", { name: "Reader & Library" }));
    await fireEvent.click(screen.getByRole("button", { name: "Library" }));

    const densitySlider = screen.getByRole("slider", { name: "Preferred items per row" });
    expect(densitySlider).toBeTruthy();
    expect(densitySlider.className).toContain("settings-density-slider__range");
    expect(densitySlider.getAttribute("min")).toBe("0");
    expect(densitySlider.getAttribute("max")).toBe("7");
    expect(densitySlider.getAttribute("step")).toBe("1");

    await fireEvent.input(densitySlider, { currentTarget: { value: "1" }, target: { value: "1" } });
    expect(store.settings.libraryPreferredGridColumns).toBe(4);

    await fireEvent.input(densitySlider, { currentTarget: { value: "5" }, target: { value: "5" } });
    expect(store.settings.libraryPreferredGridColumns).toBe(8);

    expect(screen.getByText("8")).toBeTruthy();
  });

  test("allows resetting the main profile workspace data", async () => {
    renderSettings();

    // The built-in profile is shown by its translated name, not its internal MAIN label.
    const profileSelect = document.querySelector<HTMLElement>("#general-profile .select-btn");
    expect(profileSelect?.textContent?.trim()).toBe("Default");
    await fireEvent.click(profileSelect!);
    expect(screen.getByRole("button", { name: "Default :4567" })).toBeTruthy();
    expect(screen.queryByText(/MAIN/)).toBeNull();

    const resetButton = screen.getByRole("button", { name: "Reset data" });
    await fireEvent.click(resetButton);
    expect(screen.getByText("Click Reset data again to permanently remove this profile workspace data.")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("reset_local_profile_data", { profileId: "main" });
    });
  });
});
