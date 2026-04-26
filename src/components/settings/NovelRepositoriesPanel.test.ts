import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  loadNovelRepositoryStateMock,
  loadNovelSourceClassificationStateMock,
  installNovelCatalogPluginMock,
  runAutomaticNovelSourceClassificationMock,
} = vi.hoisted(() => ({
  loadNovelRepositoryStateMock: vi.fn(async () => ({
    version: 1,
    scopeKey: "profile:main",
    updatedAtMs: null,
    repositories: [
      {
        id: "repo-1",
        normalizedUrl: "https://example.invalid/plugins.json",
        trustState: "trusted",
        enabled: true,
        addedAtMs: Date.now(),
        refreshedAtMs: Date.now(),
        lastError: null,
      },
    ],
    installedPlugins: [],
    catalogEntries: [
      {
        pluginId: "scribblehub",
        repositoryId: "repo-1",
        name: "ScribbleHub",
        lang: "en",
        version: "1.0.0",
        site: "scribblehub.com",
        artifactUrl: "https://example.invalid/scribblehub.apk",
        artifactPath: "/scribblehub.apk",
      },
    ],
    languageFilter: [],
  })),
  loadNovelSourceClassificationStateMock: vi.fn(async () => ({
    version: 1,
    scopeKey: "profile:main",
    updatedAtMs: Date.now(),
    records: [
      {
        pluginId: "scribblehub",
        repositoryId: "repo-1",
        repositoryUrl: "https://example.invalid/plugins.json",
        lang: "en",
        version: "1.0.0",
        status: "runtime-gap",
        notes: "This source still depends on runtime features that Aethon does not fully cover yet.",
        baselineStatus: "pending",
        baselineNotes: "Priority English cohort target.",
        issues: [
          {
            code: "runtime-helper-mismatch",
            message: "The current runtime helper surface is still incomplete for this source.",
            severity: "warning",
          },
        ],
        smoke: {
          pluginLoadConfirmed: true,
          searchConfirmed: false,
          detailsConfirmed: false,
          chapterConfirmed: false,
        },
        filterKeys: [],
        pluginSettingsKeys: [],
        classifiedAtMs: Date.now(),
      },
    ],
  })),
  installNovelCatalogPluginMock: vi.fn(async ({ state }) => state),
  runAutomaticNovelSourceClassificationMock: vi.fn(async () => {}),
}));

vi.mock("../../store/state.svelte", () => ({
  addToast: vi.fn(),
}));

vi.mock("../../lib/novels/repositoryState", () => ({
  addNovelRepositoryToState: vi.fn((state) => state),
  createEmptyNovelRepositoryState: vi.fn(() => ({
    version: 1,
    scopeKey: "profile:main",
    updatedAtMs: null,
    repositories: [],
    installedPlugins: [],
    catalogEntries: [],
    languageFilter: [],
  })),
  deriveNovelRepositoryUiState: vi.fn(() => ({ hasRepositories: true })),
  getVisibleNovelCatalogEntries: vi.fn((state, repositoryId) =>
    state.catalogEntries.filter((entry: { repositoryId: string }) => !repositoryId || entry.repositoryId === repositoryId)),
  loadNovelRepositoryState: loadNovelRepositoryStateMock,
  refreshAllNovelRepositories: vi.fn(async (state) => state),
  refreshNovelRepositoryCatalog: vi.fn(async (state) => state),
  removeNovelRepositoryFromState: vi.fn((state) => state),
  saveNovelRepositoryState: vi.fn(async (state) => state),
  setNovelRepositoryEnabled: vi.fn((state) => state),
  setNovelRepositoryLanguageFilter: vi.fn((state) => state),
  setNovelRepositoryTrustState: vi.fn((state) => state),
}));

vi.mock("../../lib/novels/packages", () => ({
  getInstalledNovelSources: vi.fn(() => []),
  getNovelCatalogEntryInstallState: vi.fn(() => ({ status: "available" })),
  installNovelCatalogPlugin: installNovelCatalogPluginMock,
  removeInstalledNovelPlugin: vi.fn(async (state) => state),
  setInstalledNovelPluginEnabled: vi.fn((state) => state),
}));

vi.mock("../../lib/novels/runtimeHost", () => ({
  runNovelRuntimeSmokeTest: vi.fn(),
}));

vi.mock("../../lib/novels/sourceClassificationState", async () => {
  const actual = await vi.importActual<typeof import("../../lib/novels/sourceClassificationState")>("../../lib/novels/sourceClassificationState");
  return {
    ...actual,
    loadNovelSourceClassificationState: loadNovelSourceClassificationStateMock,
    saveNovelSourceClassificationState: vi.fn(async (state) => state),
  };
});

vi.mock("../../lib/novels/automaticClassification", () => ({
  needsAutomaticNovelSourceClassification: vi.fn(() => false),
  runAutomaticNovelSourceClassification: runAutomaticNovelSourceClassificationMock,
  setQueuedNovelSourceClassification: vi.fn(async () => {}),
}));

import NovelRepositoriesPanel from "./NovelRepositoriesPanel.svelte";

describe("NovelRepositoriesPanel", () => {
  beforeEach(() => {
    loadNovelRepositoryStateMock.mockClear();
    loadNovelSourceClassificationStateMock.mockClear();
    runAutomaticNovelSourceClassificationMock.mockClear();
  });

  afterEach(() => cleanup());

  test("renders compact classification details and retries from the popover", async () => {
    render(NovelRepositoriesPanel, {
      props: {
        profileId: "main",
        serverUrl: "http://127.0.0.1:4567",
        scopeLabel: "Main profile",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Catalog preview")).toBeTruthy();
    });

    await fireEvent.click(screen.getByRole("button", { name: /Show 1/i }));
    const trigger = screen.getByRole("button", { name: "Show status details for ScribbleHub" });
    const statusShell = trigger.closest('[role="group"]');
    expect(statusShell).toBeTruthy();
    await fireEvent.mouseEnter(statusShell!);

    const dialog = await screen.findByRole("dialog", { name: "Runtime gap" });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText("Primary reason")).toBeTruthy();

    await fireEvent.click(within(dialog).getByRole("button", { name: "Retry check" }));
    await waitFor(() => {
      expect(runAutomaticNovelSourceClassificationMock).toHaveBeenCalledWith(
        { profileId: "main", serverUrl: "http://127.0.0.1:4567" },
        "scribblehub",
      );
    });
  });

  test("reuses a saved definitive classification when installing the same plugin version", async () => {
    render(NovelRepositoriesPanel, {
      props: {
        profileId: "main",
        serverUrl: "http://127.0.0.1:4567",
        scopeLabel: "Main profile",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Catalog preview")).toBeTruthy();
    });

    await fireEvent.click(screen.getByRole("button", { name: /Show 1/i }));
    await screen.findByRole("button", { name: "Show status details for ScribbleHub" });
    await fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => {
      expect(installNovelCatalogPluginMock).toHaveBeenCalled();
    });
    expect(installNovelCatalogPluginMock).toHaveBeenCalled();
    expect(runAutomaticNovelSourceClassificationMock).not.toHaveBeenCalled();
  });
});
