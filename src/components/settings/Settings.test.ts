import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, store } from "../../store/state.svelte";

const {
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
} = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string) => {
    if (command === "get_storage_info") {
      return {
        manga_bytes: 32_000_000,
        total_bytes: 256_000_000,
        free_bytes: 128_000_000,
        path: "C:/Aethon",
      };
    }
    if (command === "get_default_downloads_path") return "C:/Aethon/Downloads";
    if (command === "restart_app") return null;
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
    parseMihonBackup: vi.fn(async () => ({ trackerIds: [] })),
    buildAethonBackupContainer: vi.fn(async () => ({ bytes: new Uint8Array() })),
    buildAethonRestorePlan: vi.fn(async () => ({ payloads: [], summary: { summaryLabel: "", summaryBody: "" }, containerIssues: [], executionBlockedReason: null })),
    buildAethonAppPayload: vi.fn(() => ({})),
    parseAethonAppPayload: vi.fn(async () => ({})),
    buildAethonBooksSnapshotFromLibraryState: vi.fn((state) => state),
    buildAethonBooksPayload: vi.fn(async () => ({})),
    restoreAethonBooksPayload: vi.fn(async () => ({ books: [], bookProgress: [], bookBookmarks: [], booksCategories: [], booksCategoryAssignments: {}, issues: [], exportMode: "full" })),
    extractAethonMangaPayloadFile: vi.fn(async () => new File([], "backup.tachibk")),
    buildAethonMangaPayload: vi.fn(async () => ({})),
    buildAethonNovelsPayload: vi.fn(async () => ({})),
    restoreAethonNovelsPayload: vi.fn(async () => ({ summary: { totalEntries: 0, restoredMetadataOnlyCount: 0, restoredUsableCount: 0 } })),
    buildAethonNovelsSnapshotFromAuthoritativeState: vi.fn((input) => input.libraryState),
    applyRestoredNovelsSnapshotToLibraryState: vi.fn(({ currentState }) => currentState),
    loadBookLibraryState: vi.fn(async () => ({ books: [], bookProgress: [], bookBookmarks: [], booksCategories: [], booksCategoryAssignments: {}, booksLibraryUi: { activeCategoryId: null, typeFilter: "all", statusFilter: "all", search: "", sortMode: "recentlyAdded", sortDir: "desc" } })),
    loadNovelLibraryState: vi.fn(async () => ({ entries: [], chapters: [], progress: [], bookmarks: [], history: [], scopeKey: "profile:test", version: 1 })),
    saveNovelLibraryState: vi.fn(async (state) => state),
    loadNovelsProfileSnapshot: vi.fn(() => ({})),
    applyRestoredNovelsProfileSnapshot: vi.fn(),
    loadSourceInventory: vi.fn(async () => ({ inventory: [], availableExtensions: [], repoUrls: [], warnings: [] })),
    readOverlayFile: vi.fn(async () => []),
    upsertOverlayEntry: vi.fn(async () => {}),
    analyzeBackupReconciliation: vi.fn(async () => ({ analysis: { needsReview: [], unresolved: [], warnings: [] } })),
    overlayEntryFromAnalysis: vi.fn(() => ({})),
    buildReconciledBackupFile: vi.fn(() => new File([], "reconciled.tachibk")),
    readFileAsArrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    loadNovelRepositoryState: vi.fn(async () => ({ repositories: [], installedPlugins: [], catalogEntries: [] })),
  })),
  gqlMock: vi.fn(async (query: string) => {
    const normalized = String(query).toLowerCase();
    if (normalized.includes("sources")) return { sources: { nodes: [] } };
    if (normalized.includes("extensions")) return { extensions: { nodes: [] } };
    if (normalized.includes("trackers")) return { trackers: { nodes: [] } };
    if (normalized.includes("settings")) {
      return { settings: { downloadsPath: "C:/Aethon/Downloads", localSourcePath: "" } };
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
}));

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
  SETTINGS_AETHON_BACKUP_EXTENSION: ".aethonbk",
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

function renderSettings() {
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
    props: { onOpenThemeEditor },
  });

  return { ...result, appShell, opener, onOpenThemeEditor };
}

describe("Settings", () => {
  beforeEach(() => {
    resetSettingsStore();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
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

    expect(container.querySelector(".settings-page.aethon-port--settings")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Settings groups" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reader & Library" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close settings" })).toBeNull();
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

  test("rebinds the appearance pane theme editor affordances and help action", async () => {
    const { onOpenThemeEditor } = renderSettings();

    await fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();

    await fireEvent.click(screen.getByTitle("Create a custom theme"));
    expect(onOpenThemeEditor).toHaveBeenCalledWith(null);

    await fireEvent.click(screen.getByRole("button", { name: "Open about settings" }));
    expect(screen.getByRole("heading", { name: "About" })).toBeTruthy();
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

  test("renders density as a discrete slider-family control with fixed steps", async () => {
    renderSettings();

    await fireEvent.click(screen.getByRole("button", { name: "Reader & Library" }));
    await fireEvent.click(screen.getByRole("button", { name: "Library" }));

    const densitySlider = screen.getByRole("slider", { name: "Preferred items per row" });
    expect(densitySlider).toBeTruthy();
    expect(densitySlider.className).toContain("settings-density-slider__range");
    expect(densitySlider.getAttribute("min")).toBe("0");
    expect(densitySlider.getAttribute("max")).toBe("9");
    expect(densitySlider.getAttribute("step")).toBe("1");

    await fireEvent.input(densitySlider, { currentTarget: { value: "1" }, target: { value: "1" } });
    expect(store.settings.libraryPreferredGridColumns).toBe(4);

    await fireEvent.input(densitySlider, { currentTarget: { value: "5" }, target: { value: "5" } });
    expect(store.settings.libraryPreferredGridColumns).toBe(8);

    expect(screen.getByText("8")).toBeTruthy();
  });
});
