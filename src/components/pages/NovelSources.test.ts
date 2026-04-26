import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  loadTrustedInstalledNovelSourcesMock,
  loadNovelSourceClassificationStateMock,
  loadNovelLibraryStateMock,
} = vi.hoisted(() => ({
  loadTrustedInstalledNovelSourcesMock: vi.fn(async () => [
    {
      pluginId: "royalroad",
      repositoryId: "repo-1",
      repositoryUrl: "https://example.invalid",
      trustState: "trusted",
      name: "Royal Road",
      lang: "en",
      site: "royalroad.com",
      version: "1.0.0",
      iconUrl: null,
      artifactUrl: "https://example.invalid/royalroad.apk",
      artifactPath: "/royalroad.apk",
      enabled: true,
    },
  ]),
  loadNovelSourceClassificationStateMock: vi.fn(async () => ({
    version: 1,
    scopeKey: "profile:main",
    updatedAtMs: Date.now(),
    records: [
      {
        pluginId: "royalroad",
        repositoryId: "repo-1",
        repositoryUrl: "https://example.invalid",
        lang: "en",
        version: "1.0.0",
        status: "pending",
        notes: "Waiting for the next automatic source check.",
        baselineStatus: "pending",
        baselineNotes: "Priority English cohort target.",
        issues: [
          {
            code: "automatic-smoke-queued",
            message: "Automatic source check is queued and still waiting for the bounded smoke recipe.",
            severity: "info",
          },
        ],
        smoke: {
          pluginLoadConfirmed: false,
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
  loadNovelLibraryStateMock: vi.fn(async () => ({
    entries: [],
    chapters: [],
    progress: [],
    bookmarks: [],
    history: [],
    scopeKey: "profile:main",
    version: 1,
    updatedAtMs: null,
  })),
}));

vi.mock("../../store/state.svelte", async () => {
  const actual = await vi.importActual<typeof import("../../store/state.svelte")>("../../store/state.svelte");
  return {
    ...actual,
    addToast: vi.fn(),
    setActiveNovelDetail: vi.fn(),
    store: {
      ...actual.store,
      runtimeResolvedLocalProfileId: "main",
      runtimeServerUrl: "http://127.0.0.1:4567",
    },
  };
});

vi.mock("../../lib/novels/libraryState", () => ({
  isNovelInLibrary: vi.fn(() => false),
  loadNovelLibraryState: loadNovelLibraryStateMock,
  peekNovelLibraryState: vi.fn(() => ({
    entries: [],
    chapters: [],
    progress: [],
    bookmarks: [],
    history: [],
    scopeKey: "profile:main",
    version: 1,
    updatedAtMs: null,
  })),
}));

vi.mock("../../lib/novels/sourceClassificationState", async () => {
  const actual = await vi.importActual<typeof import("../../lib/novels/sourceClassificationState")>("../../lib/novels/sourceClassificationState");
  return {
    ...actual,
    loadNovelSourceClassificationState: loadNovelSourceClassificationStateMock,
    peekNovelSourceClassificationState: vi.fn(() => ({
      version: 1,
      scopeKey: "profile:main",
      updatedAtMs: null,
      records: [],
    })),
  };
});

vi.mock("../../lib/novels/sources", () => ({
  browseInstalledNovelSource: vi.fn(async () => []),
  loadTrustedInstalledNovelSources: loadTrustedInstalledNovelSourcesMock,
  readInstalledNovelDetails: vi.fn(),
  shutdownInstalledNovelSourcesRuntime: vi.fn(async () => {}),
  searchInstalledNovelSource: vi.fn(async () => []),
}));

vi.mock("../../lib/novels/domain", async () => {
  const actual = await vi.importActual<typeof import("../../lib/novels/domain")>("../../lib/novels/domain");
  return {
    ...actual,
  };
});

import NovelSources from "./NovelSources.svelte";

describe("NovelSources", () => {
  beforeEach(() => {
    loadTrustedInstalledNovelSourcesMock.mockClear();
    loadNovelSourceClassificationStateMock.mockClear();
    loadNovelLibraryStateMock.mockClear();
  });

  afterEach(() => cleanup());

  test("renders compact source status details without relying on title text", async () => {
    render(NovelSources);

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Show status details for Royal Road" }).length).toBe(1);
    });

    const trigger = screen.getAllByRole("button", { name: "Show status details for Royal Road" })[0];
    const statusShell = trigger.closest('[role="group"]');
    expect(statusShell).toBeTruthy();
    expect(screen.queryByText("Pending smoke")).toBeNull();
    expect(screen.getByText("Browse a source")).toBeTruthy();

    await fireEvent.mouseEnter(statusShell!);

    const dialog = await screen.findByRole("dialog", { name: "Pending smoke" });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText("Still checking")).toBeTruthy();
  });
});
