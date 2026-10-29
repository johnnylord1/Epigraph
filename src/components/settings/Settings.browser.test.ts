/// <reference types="@vitest/browser/matchers" />

import { cleanup, render, waitFor } from "@testing-library/svelte";
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
        path: "C:/Epigraph",
      };
    }
    if (command === "get_default_downloads_path") return "C:/Epigraph/Downloads";
    if (command === "list_releases") {
      return [{
        tag_name: "v4.2.0",
        name: "Epigraph 4.2.0",
        body: "Stable release.",
        published_at: "2026-07-21T00:00:00Z",
        html_url: "https://github.com/johnnylord1/Epigraph/releases/tag/v4.2.0",
      }];
    }
    if (command === "check_epigraph_update") {
      return { update_available: false, current_version: "4.2.0", version: null, body: null, published_at: null };
    }
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
    embedMihonExtensionStores: vi.fn((bytes) => bytes),
    buildEpigraphBackupContainer: vi.fn(async () => ({ bytes: new Uint8Array() })),
    buildEpigraphRestorePlan: vi.fn(async () => ({ payloads: [], summary: { summaryLabel: "", summaryBody: "" }, containerIssues: [], executionBlockedReason: null })),
    buildEpigraphAppPayload: vi.fn(() => ({})),
    parseEpigraphAppPayload: vi.fn(async () => ({})),
    buildEpigraphBooksSnapshotFromLibraryState: vi.fn((state) => state),
    buildEpigraphBooksPayload: vi.fn(async () => ({})),
    parseEpigraphBooksPayload: vi.fn(async () => ({ library: { books: [] } })),
    restoreEpigraphBooksPayload: vi.fn(async () => ({ books: [], bookProgress: [], bookBookmarks: [], booksCategories: [], booksCategoryAssignments: {}, issues: [], exportMode: "full" })),
    extractEpigraphMangaPayloadFile: vi.fn(async () => new File([], "backup.tachibk")),
    parseEpigraphMangaPayload: vi.fn(async () => ({ payloadManifest: { requiresRepositories: [] } })),
    buildEpigraphMangaPayload: vi.fn(async () => ({})),
    buildEpigraphNovelsPayload: vi.fn(async () => ({})),
    parseEpigraphNovelsPayload: vi.fn(async () => ({ snapshot: { entries: [], chapters: [], repositories: [], plugins: [] } })),
    restoreEpigraphNovelsPayload: vi.fn(async () => ({ summary: { totalEntries: 0, restoredMetadataOnlyCount: 0, restoredUsableCount: 0 } })),
    buildLnReaderNovelsBackupZip: vi.fn(async () => new Uint8Array()),
    restoreLnReaderNovelsBackup: vi.fn(async () => ({ summary: { totalEntries: 0, restoredMetadataOnlyCount: 0, restoredUsableCount: 0, restoredNeedsRepositoryCount: 0, restoredNeedsPluginCount: 0 } })),
    parseLnReaderNovelsBackup: vi.fn(async () => ({ entries: [], chapters: [], repositories: [], plugins: [] })),
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
    analyzeBackupReconciliation: vi.fn(async () => ({ analysis: { needsReview: [], unresolved: [], warnings: [] } })),
    overlayEntryFromAnalysis: vi.fn(() => ({})),
    buildReconciledBackupFile: vi.fn(() => new File([], "reconciled.tachibk")),
    buildMangaRestoreParityInput: vi.fn(() => []),
    readFileAsArrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    loadNovelRepositoryState: vi.fn(async () => ({ repositories: [], installedPlugins: [], catalogEntries: [] })),
    saveNovelRepositoryState: vi.fn(async (state) => state),
    installNovelCatalogPlugin: vi.fn(async ({ state }) => state),
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
  getServerUrl: vi.fn(() => "http://127.0.0.1:4667"),
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

function renderSettings(initialTab: RuntimeSettingsTab | null = null, width = 1280) {
  store.runtimeSettingsTab = initialTab;
  const appShell = document.createElement("div");
  appShell.id = "app-shell";
  appShell.style.width = width.toString() + "px";
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

async function expectSettingsScreenshot(name: string, heading: string) {
  await waitFor(() => {
    const title = document.querySelector<HTMLElement>(".settings-pane-header__title");
    expect(title?.textContent?.trim()).toBe(heading);
  });
  const root = document.querySelector(".settings-page.epigraph-port--settings");
  if (!root) throw new Error("Settings shell root not found");
  await (
    expect(root) as unknown as {
      toMatchEpigraphScreenshot: (screenshotName: string) => Promise<void>;
    }
  ).toMatchEpigraphScreenshot(name);
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
    await expectSettingsScreenshot("settings-app-general", "General");
  });

  test("keeps the profile creation row readable in a narrow app window", () => {
    renderSettings(null, 800);
    const row = document.querySelector<HTMLElement>('[data-testid="create-local-profile"]');
    const body = row?.querySelector<HTMLElement>(".settings-mini-row__body");

    expect(row).toBeTruthy();
    expect(body).toBeTruthy();
    expect(getComputedStyle(row!).flexDirection).toBe("column");
    expect(body!.getBoundingClientRect().width).toBeGreaterThan(200);
  });

  test("matches the imported shell in Reader & Library > Reader state", async () => {
    renderSettings("reader");
    await expectSettingsScreenshot("settings-reader-library-reader", "Reader");
  });

  test("matches the imported shell in Content & Integrations > Content state", async () => {
    renderSettings("content");
    await expectSettingsScreenshot("settings-content-integrations-content", "Content");
  });

  test("matches the imported shell in System > Storage state", async () => {
    renderSettings("storage");
    await expectSettingsScreenshot("settings-system-storage", "Storage");
  });

  test("matches the imported shell in Advanced > About state", async () => {
    renderSettings("about");
    await expectSettingsScreenshot("settings-advanced-about", "About");
  });

  test("fits the theme preview covers inside the preview strip", () => {
    renderSettings("appearance");
    const preview = document.querySelector<HTMLElement>(".settings-theme-preview")!.getBoundingClientRect();
    const tiles = [...document.querySelectorAll<HTMLElement>(".settings-theme-preview__tile")];

    expect(tiles).toHaveLength(6);
    for (const tile of tiles) {
      const box = tile.getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(preview.top);
      expect(box.bottom).toBeLessThanOrEqual(preview.bottom);
      expect(box.height).toBeGreaterThan(box.width);
    }
  });

  test("counts only library titles in each comics folder", async () => {
    // A Mihon backup keeps folder links for titles removed from the library; Suwayomi restores those links too.
    store.categories = [{
      id: 1,
      name: "Lendo",
      order: 1,
      default: false,
      includeInUpdate: "UNSET",
      includeInDownload: "UNSET",
      mangas: { nodes: [{ id: 10, inLibrary: true }, { id: 11, inLibrary: false }, { id: 12, inLibrary: false }] },
    }] as unknown as typeof store.categories;
    renderSettings("folders");
    document.querySelector<HTMLElement>('[data-settings-pane="categories"] .settings-card__stack .n-btn')!.click();

    await waitFor(() => {
      const row = [...document.querySelectorAll<HTMLElement>(".settings-mini-row--category")]
        .find((entry) => entry.querySelector(".settings-mini-row__label")?.textContent === "Lendo");
      expect(row?.querySelector(".settings-mini-row__hint")?.textContent).toBe("1 manga");
    });
  });
});
