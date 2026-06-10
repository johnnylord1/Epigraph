/// <reference types="@vitest/browser/matchers" />

import { cleanup, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getLocalProfileMeta } from "../../lib/localProfiles";
import { DEFAULT_SETTINGS, store } from "../../store/state.svelte";
import type { RuntimeSettingsTab } from "../../store/state.svelte";

const { invokeMock, tauriFetchMock, gqlMock, loadSettingsStorageRuntimeMock } = vi.hoisted(() => ({
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
    if (command === "get_flaresolverr_local_status") {
      return { installed: false, running: false, path: null, message: null };
    }
    if (command === "get_flaresolverr_docker_status") {
      return { installed: false, daemon: false, running: false, version: null, message: null };
    }
    return null;
  }),
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
    if (normalized.includes("sources")) {
      return {
        sources: {
          nodes: [
            {
              id: "mangadex-en",
              name: "MangaDex",
              lang: "en",
              displayName: "MangaDex EN",
              iconUrl: "/mock/mangadex.png",
              isNsfw: false,
            },
            {
              id: "mangadex-ptbr",
              name: "MangaDex",
              lang: "pt-br",
              displayName: "MangaDex PT-BR",
              iconUrl: "/mock/mangadex.png",
              isNsfw: false,
            },
          ],
        },
      };
    }
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
  listen: vi.fn(async () => () => {}),
  emitTo: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => {
  return {
    WebviewWindow: class MockBrowserWebviewWindow {
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
  };
});

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "4.2.0"),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: tauriFetchMock,
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(async () => {}),
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
    defaultLocalProfileId: "test",
    serverUrl: "http://127.0.0.1:4667",
    customThemes: [],
    booksCategories: [],
    booksCategoryAssignments: {},
  };
  store.navPage = "settings";
  store.lastPrimaryNavPage = "home";
  store.settingsOpen = true;
  store.runtimeSettingsTab = null;
  store.runtimeResolvedLocalProfileId = "test";
  store.runtimeResolvedLocalProfileMeta = getLocalProfileMeta("test");
  store.runtimeProfileResolutionSource = "settings-default";
  store.runtimeLaunchProfileOverride = null;
  store.runtimeIsOverrideSession = false;
  store.runtimeServerUrl = "http://127.0.0.1:4667";
  store.runtimeServerLabel = "TEST";
  store.categories = [];
}

function renderSettings(initialTab: RuntimeSettingsTab | null = null) {
  store.runtimeSettingsTab = initialTab;
  const appShell = document.createElement("div");
  appShell.id = "app-shell";
  appShell.style.width = "1280px";
  appShell.style.height = "800px";
  appShell.style.minHeight = "800px";
  appShell.style.background = "#0f0f11";
  appShell.style.overflow = "hidden";
  appShell.style.position = "relative";
  appShell.style.display = "flex";
  document.body.appendChild(appShell);

  render(Settings, {
    target: appShell,
    props: { onOpenThemeEditor: vi.fn() },
  });
}

async function expectSettingsScreenshot(name: string) {
  const root = document.querySelector(".settings-page.aethon-port--settings");
  if (!root) throw new Error("Settings shell root not found");
  await (
    expect(root) as unknown as {
      toMatchScreenshot: (screenshotName: string) => Promise<void>;
    }
  ).toMatchScreenshot(name);
}

describe("Settings (browser)", () => {
  beforeEach(() => {
    resetSettingsStore();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    invokeMock.mockClear();
    tauriFetchMock.mockClear();
    gqlMock.mockClear();
    loadSettingsStorageRuntimeMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  test("matches the imported shell in default App > General state", async () => {
    renderSettings();
    await expectSettingsScreenshot("settings-app-general");
  });

  test("matches the imported shell in Reader & Library > Reader state", async () => {
    renderSettings("reader");
    await expectSettingsScreenshot("settings-reader-library-reader");
  });

  test("matches the imported shell in Content & Integrations > Content state", async () => {
    renderSettings("content");
    await expectSettingsScreenshot("settings-content-integrations-content");
  });

  test("matches the imported shell in System > Storage state", async () => {
    renderSettings("storage");
    await expectSettingsScreenshot("settings-system-storage");
  });

  test("matches the imported shell in Advanced > About state", async () => {
    renderSettings("about");
    await expectSettingsScreenshot("settings-advanced-about");
  });
});
