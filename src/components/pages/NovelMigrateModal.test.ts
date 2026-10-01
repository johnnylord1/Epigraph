import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ActiveNovelDetailState, InstalledNovelSourceDescriptor, NovelDetailRecord } from "../../lib/novels/domain";
import type { PersistedNovelSourceClassificationState } from "../../lib/novels/sourceClassificationState";

const {
  loadTrustedInstalledNovelSourcesMock,
  loadClassificationStateMock,
  classifyUnclassifiedNovelSourcesMock,
} = vi.hoisted(() => ({
  loadTrustedInstalledNovelSourcesMock: vi.fn(),
  loadClassificationStateMock: vi.fn(),
  classifyUnclassifiedNovelSourcesMock: vi.fn(),
}));

vi.mock("../../lib/novels/sources", () => ({
  loadTrustedInstalledNovelSources: loadTrustedInstalledNovelSourcesMock,
  readInstalledNovelDetails: vi.fn(),
  searchInstalledNovelSource: vi.fn(async () => []),
}));

vi.mock("../../lib/novels/sourceClassificationState", () => ({
  // A fresh profile: nothing classified yet when the modal first renders.
  peekNovelSourceClassificationState: () => ({ version: 1, scopeKey: "profile:main", updatedAtMs: null, records: [] }),
  loadNovelSourceClassificationState: loadClassificationStateMock,
}));

vi.mock("../../lib/novels/automaticClassification", () => ({
  classifyUnclassifiedNovelSources: classifyUnclassifiedNovelSourcesMock,
}));

vi.mock("../../lib/novels/libraryState", () => ({
  buildNovelDetailRecordFromLibrary: vi.fn(),
  getNovelLibraryChapters: vi.fn(),
  getNovelLibraryEntry: vi.fn(),
  loadNovelLibraryState: vi.fn(),
}));

vi.mock("../../lib/migration/novels", () => ({
  applyMassNovelMigrationWithJournal: vi.fn(),
  applyNovelMigrationWithJournal: vi.fn(),
  previewMassNovelMigration: vi.fn(),
  previewNovelMigration: vi.fn(),
  undoNovelMigration: vi.fn(),
}));

vi.mock("../../lib/migration/storeIdentity.svelte", () => ({
  createStoreMigrationIdentityBridge: vi.fn(),
}));

vi.mock("../../lib/discord", () => ({
  setMigrationPresence: vi.fn(),
}));

vi.mock("../../lib/assets/serviceIconResolver", () => ({
  applyServiceIconFallback: vi.fn(),
  resolveServiceIconUrl: vi.fn(() => ""),
}));

vi.mock("../../store/state.svelte", async () => {
  const actual = await vi.importActual<typeof import("../../store/state.svelte")>("../../store/state.svelte");
  return {
    ...actual,
    addToast: vi.fn(),
    store: {
      ...actual.store,
      runtimeResolvedLocalProfileId: "main",
      runtimeServerUrl: "http://127.0.0.1:4567",
    },
  };
});

import NovelMigrateModal from "./NovelMigrateModal.svelte";

function installed(pluginId: string, name: string, lang: string): InstalledNovelSourceDescriptor {
  return {
    pluginId,
    repositoryId: "repo-1",
    repositoryUrl: "https://example.invalid/plugins.min.json",
    trustState: "trusted",
    name,
    lang,
    site: `https://${pluginId}.example.invalid`,
    version: "1.0.0",
    iconUrl: null,
    artifactUrl: `https://example.invalid/${pluginId}.js`,
    artifactPath: `${pluginId}.js`,
    enabled: true,
  };
}

function classified(records: Array<{ pluginId: string; lang: string; status: PersistedNovelSourceClassificationState["records"][number]["status"] }>): PersistedNovelSourceClassificationState {
  return {
    version: 1,
    scopeKey: "profile:main",
    updatedAtMs: 1,
    records: records.map((record) => ({
      ...record,
      repositoryId: "repo-1",
      repositoryUrl: "https://example.invalid/plugins.min.json",
      version: "1.0.0",
      notes: "Automatic smoke passed.",
      baselineStatus: record.status,
      baselineNotes: null,
      issues: [],
      smoke: { pluginLoadConfirmed: true, searchConfirmed: true, detailsConfirmed: true, chapterConfirmed: true },
      filterKeys: [],
      pluginSettingsKeys: [],
      classifiedAtMs: 1,
    })),
  };
}

const active: ActiveNovelDetailState = {
  inLibrary: true,
  novel: {
    id: "novel-1",
    sourceId: "centralnovel",
    title: "Eighty Six",
    path: "/novel/86",
    coverUrl: null,
    author: null,
    description: null,
    status: null,
    tags: [],
    chapterCount: 12,
    chapters: [],
    source: { sourceName: "Central Novel" },
  } as unknown as NovelDetailRecord,
};

describe("NovelMigrateModal", () => {
  beforeEach(() => {
    loadTrustedInstalledNovelSourcesMock.mockReset();
    loadClassificationStateMock.mockReset();
    classifyUnclassifiedNovelSourcesMock.mockReset();
    classifyUnclassifiedNovelSourcesMock.mockResolvedValue(false);
  });

  afterEach(() => cleanup());

  test("offers every installed source that passed its install smoke, without a cohort gate", async () => {
    loadTrustedInstalledNovelSourcesMock.mockResolvedValue([
      installed("centralnovel", "Central Novel", "pt"),
      installed("royalroad", "Royal Road", "en"),
      installed("novelbin", "NovelBin", "en"),
      installed("inkitt", "Inkitt", "en"),
      installed("lightnovelbrasil", "Light Novel Brasil", "pt"),
    ]);
    loadClassificationStateMock.mockResolvedValue(classified([
      { pluginId: "centralnovel", lang: "pt", status: "working" },
      { pluginId: "royalroad", lang: "en", status: "migration-safe" },
      { pluginId: "novelbin", lang: "en", status: "working" },
      { pluginId: "inkitt", lang: "en", status: "working-with-known-limitations" },
      { pluginId: "lightnovelbrasil", lang: "pt", status: "blocked-by-site" },
    ]));

    render(NovelMigrateModal, { props: { active, onClose: vi.fn(), onMigrated: vi.fn() } });

    await waitFor(() => {
      expect(screen.getByText("Royal Road")).toBeTruthy();
    });
    expect(screen.getByText("NovelBin")).toBeTruthy();
    expect(screen.queryByText(/stays disabled until a group of LNReader sources/i)).toBeNull();
    // The current source, sources with known limitations and site-blocked sources are never targets.
    expect(screen.queryByRole("button", { name: /Central Novel/ })).toBeNull();
    expect(screen.queryByText("Inkitt")).toBeNull();
    expect(screen.queryByText("Light Novel Brasil")).toBeNull();
  });

  test("keeps loading while sources are checked, then says where to install one", async () => {
    let finishClassification: (wrote: boolean) => void = () => {};
    classifyUnclassifiedNovelSourcesMock.mockReturnValue(new Promise<boolean>((resolve) => { finishClassification = resolve; }));
    loadTrustedInstalledNovelSourcesMock.mockResolvedValue([installed("centralnovel", "Central Novel", "pt")]);
    loadClassificationStateMock.mockResolvedValue(classified([{ pluginId: "centralnovel", lang: "pt", status: "working" }]));

    const { container } = render(NovelMigrateModal, { props: { active, onClose: vi.fn(), onMigrated: vi.fn() } });

    await waitFor(() => {
      expect(loadTrustedInstalledNovelSourcesMock).toHaveBeenCalled();
    });
    expect(container.querySelector('.mg-list[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText(/Install one in Novel sources/i)).toBeNull();

    finishClassification(false);

    await waitFor(() => {
      expect(screen.getByText("No installed novel source can receive the migration yet. Install one in Novel sources.")).toBeTruthy();
    });
    expect(container.querySelector('.mg-list[aria-busy="true"]')).toBeNull();
  });
});
