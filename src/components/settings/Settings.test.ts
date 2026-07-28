import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Tracker } from "../../lib/types";
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
    if (command === "list_releases") {
      return [{
        tag_name: "v4.2.0",
        name: "Aethon 4.2.0",
        body: "Stable release.",
        published_at: "2026-07-21T00:00:00Z",
        html_url: "https://github.com/johnnylord1/Aethon/releases/tag/v4.2.0",
      }];
    }
    if (command === "check_aethon_update") {
      return { update_available: false, current_version: "4.2.0", version: null, body: null, published_at: null };
    }
    if (command === "restart_app") return null;
    if (command === "get_suwayomi_runtime_status") {
      return {
        mode: "managed-bundled",
        version: "v2.1.1867",
        jarVersion: null,
        jarPath: "C:/Aethon/Suwayomi-Server.jar",
        profileId: "main",
        rootDir: "C:/Aethon/aethon-main",
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
        notes: "Tested by Aethon.",
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
    buildLnReaderNovelsBackupZip: vi.fn(async () => new Uint8Array()),
    restoreLnReaderNovelsBackup: vi.fn(async () => ({ summary: { totalEntries: 0, restoredMetadataOnlyCount: 0, restoredUsableCount: 0, restoredNeedsRepositoryCount: 0, restoredNeedsPluginCount: 0 } })),
    isLnReaderBackupZip: vi.fn(async () => true),
    extractLnReaderBackupPluginIds: vi.fn(async () => []),
    normalizeNativeMangaBackupBytes: vi.fn((bytes) => bytes),
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
    saveNovelRepositoryState: vi.fn(async (state) => state),
    installNovelCatalogPlugin: vi.fn(async ({ state }) => state),
  })),
  gqlMock: vi.fn(async (query: string) => {
    const normalized = String(query).toLowerCase();
    if (normalized.includes("sources")) return { sources: { nodes: [] } };
    if (normalized.includes("extensions")) return { extensions: { nodes: [] } };
    if (normalized.includes("trackers")) return { trackers: { nodes: [] as Tracker[] } };
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
      expect(screen.getByText("Tracker service unavailable")).toBeTruthy();
    });
    expect(trackerRequests).toBe(1);

    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(screen.getByText("MyAnimeList")).toBeTruthy();
    });
    expect(trackerRequests).toBe(2);
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

    const toggle = screen.getByRole("switch", { name: "Improve Discord cover framing" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await fireEvent.click(toggle);

    expect(store.settings.discordRpcImproveCovers).toBe(true);
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

    const resetButton = screen.getByRole("button", { name: "Reset data" });
    await fireEvent.click(resetButton);
    expect(screen.getByText("Click Reset data again to permanently remove this profile workspace data.")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("reset_local_profile_data", { profileId: "main" });
    });
  });
});
