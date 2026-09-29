import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAppLanguage, translate } from "../../lib/i18n/runtime";
import { createFirstRunState } from "../../lib/firstRun";
import { bumpContentSetupVersion, DEFAULT_SETTINGS, store } from "../../store/state.svelte";
import { normalizeNovelLibraryState, resetNovelLibraryStateCacheForTests, saveNovelLibraryState } from "../../lib/novels/libraryState";
import * as novelLibrary from "../../lib/novels/libraryState";
import FirstRun from "./FirstRun.svelte";
import { createProductionFirstRunBackupWorkflow } from "../../lib/backup/firstRunBackupWorkflow";

vi.mock("../settings/SyncdConnectionPanel.svelte", () => import("../../test/fixtures/FirstRunSurface.svelte"));
vi.mock("../pages/SourcesView.svelte", () => import("../../test/fixtures/FirstRunSurface.svelte"));
vi.mock("../pages/Search.svelte", () => import("../../test/fixtures/FirstRunSurface.svelte"));
vi.mock("../../lib/tracking/firstRunTrackerWorkflow", () => ({
  createProductionFirstRunTrackerWorkflow: () => ({
    providers: [],
    load: async () => [],
    submitOAuth: vi.fn(),
    submitCredentials: vi.fn(),
    logout: vi.fn(),
    submitHardcover: vi.fn(),
    disconnectHardcover: vi.fn(),
  }),
}));
vi.mock("../../lib/setup/firstRunSourcesWorkflow", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/setup/firstRunSourcesWorkflow")>(),
  createProductionFirstRunSourcesWorkflow: () => {
    const repositories = [
      {
        id: "manga-repo", kind: "manga", url: "https://manga.test", name: "Comics repository",
        extensions: [{ id: "manga-ext", name: "Comics test extension", lang: "en", version: "1", iconUrl: null, installed: false, status: "idle" }],
      },
      {
        id: "novel-repo", kind: "novels", url: "https://novels.test", name: "Novels repository",
        extensions: [{ id: "novel-ext", name: "Novels test extension", lang: "en", version: "1", iconUrl: null, installed: false, status: "idle" }],
      },
    ];
    return {
      repositories,
      warnings: [],
      subscribe: (listener: () => void) => { listener(); return () => {}; },
      refreshRepository: vi.fn(),
      hydrate: async () => repositories,
      addRepository: vi.fn(),
      installExtension: async (repositoryId: string, extensionId: string) => {
        const extension = repositories.find((repository) => repository.id === repositoryId)?.extensions.find((entry) => entry.id === extensionId);
        if (extension) { extension.installed = true; extension.status = "installed"; }
      },
      installAll: vi.fn(),
      isReady: (kind?: string) => repositories.some((repository) => (!kind || repository.kind === kind) && repository.extensions.some((extension) => extension.installed)),
    };
  },
}));
vi.mock("../../lib/setup/firstRunDiscoveryWorkflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/setup/firstRunDiscoveryWorkflow")>();
  return {
    ...actual,
    createProductionFirstRunDiscoveryWorkflow: () => actual.createFirstRunDiscoveryWorkflow({
      loadMangaSources: async () => [{ id: "test", name: "Test source" }], loadNovelSources: async () => [],
      findManga: async () => [{ id: 11, title: "Available title", coverUrl: null, inLibrary: false }], findNovels: async () => [],
      addManga: vi.fn(), addNovel: vi.fn(),
    }),
  };
});
vi.mock("../../lib/backup/firstRunBackupWorkflow", () => ({
  createProductionFirstRunBackupWorkflow: vi.fn(() => ({
    inspectFiles: async (selected: File[], current: any[] = []) => [
      ...current,
      ...selected.map((file) => ({
        key: `${file.name}:${file.size}`,
        path: null,
        file,
        name: file.name,
        kind: "epigraph",
        status: "ready",
        error: null,
        restoreProgress: 0,
        plan: null,
        workCount: 2,
        chapterCount: 3,
        repositoryCount: 1,
        extensionCount: 2,
        conflictCount: 0,
        libraryKinds: ["manga", "novels"],
        needsSourceKinds: ["manga", "novels"],
      })),
    ],
    summarize: (files: any[]) => ({
      workCount: files.length * 2,
      chapterCount: files.length * 3,
      repositoryCount: files.length,
      extensionCount: files.length * 2,
      conflictCount: 0,
      libraryKinds: files.length ? ["manga", "novels"] : [],
      needsSourceKinds: files.length ? ["manga", "novels"] : [],
    }),
    restoreFiles: async (files: any[]) => { for (const file of files) file.restoreProgress = 1; },
    detach: vi.fn(),
    requestCancel: vi.fn(),
  })),
}));

describe("FirstRun", () => {
  it("localizes the restored heading, navigation and setup labels without inline copy tables", async () => {
    applyAppLanguage("pt-BR");
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "backup", path: "backup", backupRestored: true, backupNeedsSources: false } } });
    expect(screen.getByRole("heading", { name: translate("ui_backupRestored") })).toBeTruthy();
    expect(screen.getByRole("button", { name: translate("firstRun.shell.continue") })).toBeTruthy();
    expect(screen.queryByText("Backups restored.")).toBeNull();
    applyAppLanguage("es");
    await waitFor(() => expect(screen.getByRole("heading", { name: translate("ui_backupRestored") })).toBeTruthy());
    expect(screen.getByRole("button", { name: translate("firstRun.shell.continue") })).toBeTruthy();
  });
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    });
    store.settings = structuredClone(DEFAULT_SETTINGS);
    store.libraryMangaSnapshot = [];
    store.books = [];
    store.librarySection = "comics";
    store.searchNovelLibraryEntries = [];
    store.runtimeResolvedLocalProfileId = "main";
    store.runtimeServerUrl = "http://localhost:4567";
    vi.mocked(createProductionFirstRunBackupWorkflow).mockClear();
    resetNovelLibraryStateCacheForTests();
  });

  afterEach(() => { cleanup(); applyAppLanguage("en"); vi.restoreAllMocks(); });

  it("waits for the runtime target before creating the backup operation and retains it afterward", async () => {
    store.runtimeResolvedLocalProfileId = null;
    store.runtimeServerUrl = null;
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "backup", path: "backup" } } });
    expect(createProductionFirstRunBackupWorkflow).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Review import" })).toBeNull();

    store.runtimeResolvedLocalProfileId = "main";
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(createProductionFirstRunBackupWorkflow).not.toHaveBeenCalled();
    store.runtimeServerUrl = "http://localhost:4567";
    await waitFor(() => expect(screen.getByRole("button", { name: "Review import" })).toBeTruthy());
    expect(createProductionFirstRunBackupWorkflow).toHaveBeenCalledTimes(1);

    store.runtimeResolvedLocalProfileId = "another-profile";
    store.runtimeServerUrl = "http://localhost:6789";
    await fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await fireEvent.click(screen.getByRole("button", { name: "Restore backups" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Review import" })).toBeTruthy());
    // The existing operation must retain its frozen target/replay protection.
    expect(createProductionFirstRunBackupWorkflow).toHaveBeenCalledTimes(1);
  });

  it("does not create a restore operation while choosing appearance or an entry path", async () => {
    render(FirstRun);
    expect(createProductionFirstRunBackupWorkflow).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(createProductionFirstRunBackupWorkflow).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Restore backups" }));
    await waitFor(() => expect(createProductionFirstRunBackupWorkflow).toHaveBeenCalledTimes(1));
  });

  it("applies a selected built-in theme and advances with accessible progress", async () => {
    render(FirstRun);

    expect(store.settings.theme).toBe("light");
    await fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(store.settings.theme).toBe("light");
    expect(screen.getByText("Appearance").closest("li")?.getAttribute("aria-current")).toBe("step");

    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "How do you want to begin?" })).toBeTruthy();
  });

  it("keeps an appearance choice when the app closes before Continue", async () => {
    render(FirstRun);
    await fireEvent.click(screen.getByRole("button", { name: "Nocturne" }));
    cleanup();
    render(FirstRun);
    expect(store.settings.theme).toBe("nocturne");
  });

  it("routes each entry choice into the real setup task", async () => {
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "entry" } } });

    await fireEvent.click(screen.getByRole("button", { name: "Set up from scratch" }));
    expect(screen.getByRole("heading", { name: "Add repositories" })).toBeTruthy();
  });

  it("resumes the exact persisted task", () => {
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "trackers", path: "backup" } } });

    expect(screen.getByRole("heading", { name: "Would you like to connect a tracker?" })).toBeTruthy();
    expect(screen.getByText("Trackers").closest("li")?.getAttribute("aria-current")).toBe("step");
  });

  it("returns backup users to restore after repository setup", async () => {
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "sources", path: "backup" } } });

    await waitFor(() => expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Select your backups." })).toBeTruthy();
  });

  it("does not equate visiting repositories with completing a backup restore", async () => {
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "backup", path: "backup" } } });

    const reviewButton = screen.getByRole("button", { name: "Review import" });
    expect(reviewButton.hasAttribute("disabled")).toBe(true);
    await fireEvent.click(reviewButton);
    expect(screen.getByRole("heading", { name: "Select your backups." })).toBeTruthy();
  });

  it("does not complete without a library title", async () => {
    const onComplete = vi.fn();
    render(FirstRun, { props: { onComplete, initialState: { ...createFirstRunState(), step: "complete", path: "sync" } } });

    const openLibrary = screen.getByRole("button", { name: "Open library" });
    expect(openLibrary.hasAttribute("disabled")).toBe(true);
    await fireEvent.click(openLibrary);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("persists completion after a title exists", async () => {
    const onComplete = vi.fn();
    store.books = [{ id: "book-1" } as (typeof store.books)[number]];
    render(FirstRun, { props: { onComplete, initialState: { ...createFirstRunState(), step: "complete", path: "fresh" } } });

    await waitFor(() => expect(screen.getByRole("button", { name: "Open library" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: "Open library" }));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem("epigraph-first-run") ?? "{}").status).toBe("complete");
    expect(store.navPage).toBe("library");
    expect(store.librarySection).toBe("books");
  });

  it("opens Comics when only comics exist and the previous section was Books", async () => {
    store.librarySection = "books";
    store.libraryMangaSnapshot = [{ id: 1 } as (typeof store.libraryMangaSnapshot)[number]];
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "complete", path: "fresh" } } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Open library" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: "Open library" }));
    expect(store.librarySection).toBe("comics");
  });

  it.each(["comics", "books"] as const)("keeps the populated %s section in a mixed library", async (section) => {
    store.librarySection = section;
    store.books = [{ id: "book-1" } as (typeof store.books)[number]];
    store.libraryMangaSnapshot = [{ id: 1 } as (typeof store.libraryMangaSnapshot)[number]];
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "complete", path: "backup" } } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Open library" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: "Open library" }));
    expect(store.librarySection).toBe(section);
  });

  it("waits for novels before choosing the destination in a mixed library", async () => {
    await saveNovelLibraryState(normalizeNovelLibraryState({ entries: [
      { id: "novel-1", title: "First novel", path: "/novel/1", source: {} },
    ] }), { profileId: "main" });
    const loaded = await novelLibrary.loadNovelLibraryState({ profileId: "main" });
    let resolveLoad!: (state: typeof loaded) => void;
    vi.spyOn(novelLibrary, "loadNovelLibraryState").mockImplementation(() => new Promise((resolve) => { resolveLoad = resolve; }));
    store.librarySection = "books";
    store.libraryMangaSnapshot = [{ id: 1 } as (typeof store.libraryMangaSnapshot)[number]];
    const onComplete = vi.fn();
    render(FirstRun, { props: { onComplete, initialState: { ...createFirstRunState(), step: "complete", path: "backup" } } });
    const open = screen.getByRole("button", { name: "Open library" });
    expect(open.hasAttribute("disabled")).toBe(true);
    await fireEvent.click(open);
    expect(onComplete).not.toHaveBeenCalled();
    resolveLoad(loaded);
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    await fireEvent.click(open);
    expect(store.librarySection).toBe("books");
  });

  it("keeps completion locked after a failed library check and allows retry", async () => {
    vi.spyOn(novelLibrary, "loadNovelLibraryState").mockRejectedValueOnce(new Error("Read unavailable"));
    store.books = [{ id: "book-1" } as (typeof store.books)[number]];
    const onComplete = vi.fn();
    render(FirstRun, { props: { onComplete, initialState: { ...createFirstRunState(), step: "complete", path: "backup" } } });
    await screen.findByRole("alert");
    const open = screen.getByRole("button", { name: "Open library" });
    expect(open.hasAttribute("disabled")).toBe(true);
    await fireEvent.click(open);
    expect(onComplete).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    await fireEvent.click(open);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(store.librarySection).toBe("books");
  });

  it("keeps the existing pairing options for sync and waits for their connection callback", async () => {
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "sync", path: "sync" } } });
    await fireEvent.click(await screen.findByRole("button", { name: "Other ways to connect" }));
    const connect = await screen.findByRole("button", { name: "Connect test device" });
    expect(screen.getByTestId("first-run-surface").getAttribute("data-profile-id")).toBe("main");
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.click(connect);
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps the selected backup while repositories are configured", async () => {
    const { container } = render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "backup", path: "backup" } } });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await fireEvent.change(input, { target: { files: [new File(["data"], "test.epigraphbk")] } });
    await fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    await fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
    expect(screen.getByRole("heading", { name: "Add repositories" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.click(await screen.findByRole("button", { name: "Install Novels test extension" }));
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.click(await screen.findByRole("button", { name: "Install Comics test extension" }));
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
  });

  it("does not require extensions after restoring only local books", async () => {
    localStorage.setItem("epigraph-first-run", JSON.stringify({
      ...createFirstRunState(), step: "backup", path: "backup",
      backupRestored: true, backupNeedsSources: false,
    }));
    render(FirstRun);
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Would you like to connect a tracker?" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: translate("ui_backupRestored") })).toBeTruthy();
  });

  it("unlocks discovery when a novel is saved before Library has ever mounted", async () => {
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "discover", path: "fresh" } } });
    expect(screen.getByRole("button", { name: "Finish setup" }).hasAttribute("disabled")).toBe(true);
    await saveNovelLibraryState(normalizeNovelLibraryState({ entries: [
      { id: "novel-1", title: "First novel", path: "/novel/1", source: {} },
    ] }), { profileId: "main" });
    bumpContentSetupVersion();
    expect(store.searchNovelLibraryEntries).toEqual([]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Finish setup" }).hasAttribute("disabled")).toBe(false));
    cleanup();
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "complete", path: "backup" } } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Open library" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: "Open library" }));
    expect(store.librarySection).toBe("books");
  });

  it("can search again after leaving and returning to discovery", async () => {
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "discover", path: "fresh" } } });
    await screen.findByText("Available title");
    await fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Continue without a tracker" }));
    await screen.findByText("Available title");
    await fireEvent.click(screen.getByRole("button", { name: "Add Available title" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Finish setup" }).hasAttribute("disabled")).toBe(false));
  });

  it("requires both source domains after a mixed restore", async () => {
    render(FirstRun, { props: { initialState: {
      ...createFirstRunState(), step: "sources", path: "backup", backupRestored: true,
      backupSourceTypes: ["manga", "novels"],
    } } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(await screen.findByRole("button", { name: "Install Comics test extension" }));
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "Install Novels test extension" }));
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
  });

  it("locks discovery again when changing from a populated profile to an empty one", async () => {
    await saveNovelLibraryState(normalizeNovelLibraryState({ entries: [
      { id: "novel-1", title: "First novel", path: "/novel/1", source: {} },
    ] }), { profileId: "main" });
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "discover", path: "fresh" } } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Finish setup" }).hasAttribute("disabled")).toBe(false));
    store.runtimeResolvedLocalProfileId = "new-empty-profile";
    await waitFor(() => expect(screen.getByRole("button", { name: "Finish setup" }).hasAttribute("disabled")).toBe(true));
  });
});
