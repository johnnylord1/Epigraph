import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DownloadStatus } from "../../lib/types";
import "../../lib/i18n/runtime";

const { gqlMock, openPathMock, resetFixture } = vi.hoisted(() => {
  const createFixture = (): DownloadStatus => ({
    state: "STARTED",
    queue: [
      {
        progress: 0.42,
        state: "DOWNLOADING",
        chapter: {
          id: 327,
          name: "Chapter 327",
          pageCount: 20,
          mangaId: 1,
          manga: {
            id: 1,
            title: "Vagabond",
            thumbnailUrl: "/covers/vagabond.png",
          },
        },
      },
      {
        progress: 0,
        state: "QUEUED",
        chapter: {
          id: 191,
          name: "Chapter 191",
          pageCount: 18,
          mangaId: 2,
          manga: {
            id: 2,
            title: "Vinland Saga",
            thumbnailUrl: "/covers/vinland.png",
          },
        },
      },
      {
        progress: 0.12,
        state: "ERROR",
        chapter: {
          id: 404,
          name: "Chapter 404",
          pageCount: 16,
          mangaId: 4,
          manga: {
            id: 4,
            title: "Berserk",
            thumbnailUrl: "/covers/berserk.png",
          },
        },
      },
      {
        progress: 1,
        state: "FINISHED",
        chapter: {
          id: 21,
          name: "Chapter 21",
          pageCount: 12,
          mangaId: 5,
          manga: {
            id: 5,
            title: "Akira",
            thumbnailUrl: "/covers/akira.png",
          },
        },
      },
    ],
  });

  let fixture: DownloadStatus = createFixture();

  const gqlMock = vi.fn(async (query: string, variables?: { chapterId?: number; to?: number }) => {
    const normalized = String(query).toLowerCase();

    if (normalized.includes("getdownloadstatus")) {
      return { downloadStatus: structuredClone(fixture) };
    }

    if (normalized.includes("getdownloadspath")) {
      return { settings: { downloadsPath: "C:/Downloads" } };
    }

    if (normalized.includes("startdownloader")) {
      fixture.state = "STARTED";
      return { startDownloader: { downloadStatus: structuredClone(fixture) } };
    }

    if (normalized.includes("stopdownloader")) {
      fixture.state = "STOPPED";
      return { stopDownloader: { downloadStatus: structuredClone(fixture) } };
    }

    if (normalized.includes("dequeuechapterdownload")) {
      fixture.queue = fixture.queue.filter((item) => item.chapter.id !== variables?.chapterId);
      return { dequeueChapterDownload: { downloadStatus: { state: fixture.state } } };
    }

    if (normalized.includes("cleardownloader")) {
      fixture.queue = fixture.queue.filter((item) => item.state !== "FINISHED");
      return { clearDownloader: { downloadStatus: structuredClone(fixture) } };
    }

    if (normalized.includes("enqueuechapterdownload")) {
      if (variables?.chapterId === 327) {
        fixture.queue.unshift({
          progress: 0.42,
          state: "QUEUED",
          chapter: {
            id: 327,
            name: "Chapter 327",
            pageCount: 20,
            mangaId: 1,
            manga: {
              id: 1,
              title: "Vagabond",
              thumbnailUrl: "/covers/vagabond.png",
            },
          },
        });
      }
      return { enqueueChapterDownload: { downloadStatus: structuredClone(fixture) } };
    }

    if (normalized.includes("reorderchapterdownload")) {
      const currentIndex = fixture.queue.findIndex((item) => item.chapter.id === variables?.chapterId);
      if (currentIndex > 0) {
        const reordered = [...fixture.queue];
        const [selected] = reordered.splice(currentIndex, 1);
        reordered.splice(variables?.to ?? 0, 0, selected);
        fixture.queue = reordered;
      }
      return { reorderChapterDownload: { downloadStatus: structuredClone(fixture) } };
    }

    return {};
  });

  const resetFixture = () => {
    fixture = createFixture();
  };

  return { gqlMock, openPathMock: vi.fn(async () => {}), resetFixture };
});

vi.mock("../../lib/client", () => ({
  gql: gqlMock,
  thumbUrl: vi.fn((path: string) => path),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "get_storage_info") {
      return {
        manga_bytes: 123456789,
        total_bytes: 2000000000,
        free_bytes: 987654321,
        path: "C:/Downloads",
      };
    }
    return null;
  }),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: openPathMock,
}));

vi.mock("../../store/state.svelte", async () => {
  const actual = await vi.importActual<typeof import("../../store/state.svelte")>("../../store/state.svelte");
  return {
    ...actual,
    setActiveDownloads: vi.fn(),
  };
});

import { invoke } from "@tauri-apps/api/core";
import Downloads from "./Downloads.svelte";
import { setNovelDownload, setPausedDownloads, store } from "../../store/state.svelte";
import { createCatalogProvider } from "../../lib/search/providers";

describe("Downloads", () => {
  beforeEach(() => {
    store.closeSearchPalette(false);
    gqlMock.mockClear();
    resetFixture();
    setPausedDownloads([]);
    store.pausedDownloads = [];
  });

  afterEach(() => {
    store.closeSearchPalette(false);
    cleanup();
    document.body.innerHTML = "";
    document.body.className = "";
  });

  test("renders the imported downloads shell with real queue data", async () => {
    const { container } = render(Downloads);

    await waitFor(() => {
      expect(screen.getByText("Vagabond")).toBeTruthy();
    });

    expect(container.querySelector(".epigraph-port--downloads")).toBeTruthy();
    expect(screen.getByText("Vagabond")).toBeTruthy();
    expect(screen.getByText("Vinland Saga")).toBeTruthy();
    expect(screen.getByText("4 Items")).toBeTruthy();
  });

  test("filters the queue locally through the topbar search", async () => {
    render(Downloads);

    await waitFor(() => {
      expect(screen.getByText("Vagabond")).toBeTruthy();
    });

    const input = screen.getByPlaceholderText("Search downloads...");
    await fireEvent.input(input, { target: { value: "vinland" } });

    expect(screen.queryByText("Vagabond")).toBeNull();
    expect(screen.getByText("Vinland Saga")).toBeTruthy();
    expect(store.searchOpen).toBe(true);
    expect(store.searchContext).toBe("downloads");
  });

  test("filters the queue locally through the downloads filter menu", async () => {
    render(Downloads);

    await waitFor(() => {
      expect(screen.getByText("Vagabond")).toBeTruthy();
    });

    await fireEvent.click(screen.getByRole("button", { name: "Filter downloads" }));
    await fireEvent.click(screen.getByRole("menuitemradio", { name: /Failed/ }));

    expect(screen.queryByText("Vagabond")).toBeNull();
    expect(screen.queryByText("Vinland Saga")).toBeNull();
    expect(screen.getByText("Berserk")).toBeTruthy();
  });

  test("keeps downloads interactive without a blocking overlay", async () => {
    const { container } = render(Downloads);

    await waitFor(() => {
      expect(screen.getByText("Vagabond")).toBeTruthy();
    });

    expect(document.body.className).not.toContain("epigraph-downloads-search-engaged");
    expect(container.querySelector(".downloads-search-overlay")).toBeNull();
    expect(screen.getByRole("button", { name: "Home" })).toBeTruthy();
  });

  test("connects pause all, resume all, and row remove to the real mutations", async () => {
    render(Downloads);

    await waitFor(() => {
      expect(screen.getByText("Vagabond")).toBeTruthy();
    });

    await fireEvent.click(screen.getByRole("button", { name: "Pause All" }));
    expect(
      gqlMock.mock.calls.some(([query]) => String(query).includes("mutation StopDownloader")),
    ).toBe(true);

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Resume" }).length).toBeGreaterThan(0);
    });

    await fireEvent.click(screen.getByRole("button", { name: "Resume All" }));
    expect(
      gqlMock.mock.calls.some(([query]) => String(query).includes("mutation StartDownloader")),
    ).toBe(true);

    await fireEvent.click(screen.getAllByRole("button", { name: "Remove download" })[0]);
    expect(
      gqlMock.mock.calls.some(([query, variables]) =>
        String(query).includes("mutation DequeueDownload") && variables?.chapterId === 327),
    ).toBe(true);
  });

  test("connects queued row action to reorderChapterDownload", async () => {
    render(Downloads);

    await waitFor(() => {
      expect(screen.getByText("Vinland Saga")).toBeTruthy();
    });

    const row = screen.getByText("Vinland Saga").closest<HTMLElement>(".dl-row");
    expect(row).toBeTruthy();
    await fireEvent.click(within(row!).getByRole("button", { name: "Move to top" }));

    expect(
      gqlMock.mock.calls.some(([query, variables]) =>
        String(query).includes("mutation ReorderDownload") &&
        variables?.chapterId === 191 &&
        variables?.to === 0),
    ).toBe(true);
  });

  test("pauses and resumes an item through dequeue + enqueue", async () => {
    render(Downloads);

    await waitFor(() => {
      expect(screen.getByText("Vagabond")).toBeTruthy();
    });

    const row = screen.getByText("Vagabond").closest<HTMLElement>(".dl-row");
    expect(row).toBeTruthy();

    await fireEvent.click(within(row!).getByRole("button", { name: "Pause" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    });

    expect(
      gqlMock.mock.calls.some(([query, variables]) =>
        String(query).includes("mutation DequeueDownload") && variables?.chapterId === 327),
    ).toBe(true);

    const pausedRow = screen.getByText("Vagabond").closest<HTMLElement>(".dl-row");
    expect(pausedRow).toBeTruthy();
    await fireEvent.click(within(pausedRow!).getByRole("button", { name: "Resume" }));

    expect(
      gqlMock.mock.calls.some(([query, variables]) =>
        String(query).includes("mutation EnqueueDownload") && variables?.chapterId === 327),
    ).toBe(true);
  });

  test("resume all reenqueues paused row items before restarting the downloader", async () => {
    render(Downloads);

    await waitFor(() => {
      expect(screen.getByText("Vagabond")).toBeTruthy();
    });

    const row = screen.getByText("Vagabond").closest<HTMLElement>(".dl-row");
    expect(row).toBeTruthy();
    await fireEvent.click(within(row!).getByRole("button", { name: "Pause" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Resume All" })).toBeTruthy();
    });

    gqlMock.mockClear();
    await fireEvent.click(screen.getByRole("button", { name: "Resume All" }));

    expect(
      gqlMock.mock.calls.some(([query, variables]) =>
        String(query).includes("mutation EnqueueDownload") && variables?.chapterId === 327),
    ).toBe(true);
    expect(
      gqlMock.mock.calls.some(([query]) => String(query).includes("mutation StartDownloader")),
    ).toBe(true);
  });

  test("connects downloads more options to queue actions", async () => {
    render(Downloads);

    await waitFor(() => {
      expect(screen.getByText("Akira")).toBeTruthy();
    });

    await fireEvent.click(screen.getByRole("button", { name: "More download options" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /Clear finished/ }));
    expect(
      gqlMock.mock.calls.some(([query]) => String(query).includes("mutation ClearDownloader")),
    ).toBe(true);

    await waitFor(() => {
      expect(screen.queryByText("Akira")).toBeNull();
    });

    await fireEvent.click(screen.getByRole("button", { name: "More download options" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /Retry failed/ }));
    expect(
      gqlMock.mock.calls.some(([query, variables]) =>
        String(query).includes("mutation EnqueueDownload") && variables?.chapterId === 404),
    ).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: "More download options" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /Open downloads folder/ }));
    expect(openPathMock).toHaveBeenCalledWith("C:/Downloads");
  });

  test("measures the downloads folder again once a running download leaves the queue", async () => {
    const storageReads = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "get_storage_info").length;
    const base = gqlMock.getMockImplementation()!;
    vi.mocked(invoke).mockClear();
    render(Downloads);
    await screen.findByText("Chapter 327");
    await waitFor(() => expect(storageReads()).toBe(1));

    gqlMock.mockImplementation(async (query, variables) => {
      const result = await base(query, variables);
      if (String(query).toLowerCase().includes("getdownloadstatus")) {
        const { downloadStatus } = result as { downloadStatus: DownloadStatus };
        downloadStatus.queue = downloadStatus.queue.filter((item) => item.chapter.id !== 327);
      }
      return result;
    });
    try {
      await waitFor(() => expect(storageReads()).toBe(2), { timeout: 5000 });
    } finally {
      gqlMock.mockImplementation(base);
    }
  });

  test("measures the downloads folder of the profile that is running", async () => {
    const previousProfileId = store.runtimeResolvedLocalProfileId;
    store.runtimeResolvedLocalProfileId = "profile-a";
    try {
      render(Downloads);
      await waitFor(() => {
        expect(vi.mocked(invoke)).toHaveBeenCalledWith("get_storage_info", { downloadsPath: "C:/Downloads", profileId: "profile-a" });
      });
    } finally {
      store.runtimeResolvedLocalProfileId = previousProfileId;
    }
  });

  test("lists a novel being saved for offline reading next to the manga queue, and drops it once saved", async () => {
    const base = gqlMock.getMockImplementation()!;
    gqlMock.mockImplementation(async (query: string, variables?: { chapterId?: number; to?: number }) => {
      if (String(query).toLowerCase().includes("getdownloadstatus")) return { downloadStatus: { state: "STOPPED", queue: [] } };
      return base(query, variables);
    });
    setNovelDownload("novel-1", { novelId: "novel-1", title: "Lord of Mysteries", coverUrl: null, pendingIds: ["c2", "c3"], done: 1, total: 3 });
    try {
      const { container } = render(Downloads);

      const row = await waitFor(() => {
        const found = container.querySelector<HTMLElement>('[data-download-novel-id="novel-1"]');
        expect(found).toBeTruthy();
        return found!;
      });
      expect(within(row).getByText("Lord of Mysteries")).toBeTruthy();
      expect(within(row).getByText("Saving 1 / 3")).toBeTruthy();
      expect(row.querySelector<HTMLElement>(".dl-progress__fill")!.style.width).toBe("33%");
      expect(container.querySelector(".downloads-empty")).toBeNull();

      setNovelDownload("novel-1", null);
      await waitFor(() => expect(container.querySelector('[data-download-novel-id="novel-1"]')).toBeNull());
      expect(container.querySelector(".downloads-empty")).toBeTruthy();
    } finally {
      setNovelDownload("novel-1", null);
      gqlMock.mockImplementation(base);
    }
  });
  test("applies the topbar search and the downloads filter to a novel being saved too", async () => {
    setNovelDownload("novel-1", { novelId: "novel-1", title: "Lord of Mysteries", coverUrl: null, pendingIds: ["c2", "c3"], done: 1, total: 3 });
    try {
      const { container } = render(Downloads);
      await waitFor(() => expect(screen.getByText("Vagabond")).toBeTruthy());
      const novelRow = () => container.querySelector('[data-download-novel-id="novel-1"]');
      expect(novelRow()).toBeTruthy();

      const input = screen.getByPlaceholderText("Search downloads...");
      await fireEvent.input(input, { target: { value: "vinland" } });
      expect(novelRow()).toBeNull();
      expect(screen.getByText("Vinland Saga")).toBeTruthy();
      await fireEvent.input(input, { target: { value: "mysteries" } });
      expect(novelRow()).toBeTruthy();
      expect(screen.queryByText("Vinland Saga")).toBeNull();
      expect(container.querySelector(".downloads-empty")).toBeNull();
      await fireEvent.input(input, { target: { value: "nothing like this" } });
      expect(novelRow()).toBeNull();
      expect(screen.getByText("No downloads match this search.")).toBeTruthy();
      await fireEvent.input(input, { target: { value: "" } });
      store.closeSearchPalette(false);

      await fireEvent.click(screen.getByRole("button", { name: "Filter downloads" }));
      expect(screen.getByRole("menuitemradio", { name: /All/ }).textContent).toContain("5");
      expect(screen.getByRole("menuitemradio", { name: /Active/ }).textContent).toContain("2");
      await fireEvent.click(screen.getByRole("menuitemradio", { name: /Failed/ }));
      expect(novelRow()).toBeNull();
      expect(screen.getByText("Berserk")).toBeTruthy();

      await fireEvent.click(screen.getByRole("button", { name: "Filter downloads" }));
      await fireEvent.click(screen.getByRole("menuitemradio", { name: /Active/ }));
      expect(novelRow()).toBeTruthy();
      expect(screen.getByText("Vagabond")).toBeTruthy();
      expect(screen.queryByText("Berserk")).toBeNull();
    } finally {
      setNovelDownload("novel-1", null);
    }
  });
  test("offers a novel being saved in the downloads search palette, pointing at its row", async () => {
    setNovelDownload("novel-1", { novelId: "novel-1", title: "Lord of Mysteries", coverUrl: null, pendingIds: ["c2", "c3"], done: 1, total: 3 });
    try {
      render(Downloads);
      await waitFor(() => expect(screen.getByText("Vagabond")).toBeTruthy());

      const results = await createCatalogProvider({ downloads: store.searchDownloads })
        .search({ context: "downloads", query: "mysteries", signal: new AbortController().signal });
      expect(results.map(({ title, description, action }) => ({ title, description, action }))).toEqual([
        { title: "Lord of Mysteries", description: "Saving 1 / 3", action: { kind: "download", novelId: "novel-1" } },
      ]);
    } finally {
      setNovelDownload("novel-1", null);
    }
  });
});
