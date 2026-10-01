import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "../../lib/i18n/runtime";
import type { Chapter, Manga } from "../../lib/types";

const { gqlMock, readyMock, fetchSourceChaptersMock } = vi.hoisted(() => ({
  gqlMock: vi.fn(),
  readyMock: vi.fn(async () => true),
  fetchSourceChaptersMock: vi.fn(async () => ({})),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("../../lib/client", () => ({
  gql: gqlMock,
  getServerUrl: () => "http://127.0.0.1:0",
  getServerAuthHeader: () => ({}),
  serverFileUrl: (url: string) => url,
  thumbUrl: (url: string) => url,
}));
// Each query is its own name, so the mock can answer per operation.
vi.mock("../../lib/queries", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../lib/queries");
  return Object.fromEntries(Object.keys(actual).map((name) => [name, name]));
});
vi.mock("../../lib/suwayomiReadiness", () => ({ waitForSuwayomiGraphqlReady: readyMock }));
vi.mock("../../lib/manga/runtime", () => ({ fetchSourceMangaChapters: fetchSourceChaptersMock }));
vi.mock("../../lib/manga/coverResolver", () => ({ resolveMangaCoverUrl: vi.fn(() => "") }));

import { store } from "../../store/state.svelte";
import SeriesDetail, { resetSeriesDetailCacheForTests } from "./SeriesDetail.svelte";

const MANGA = { id: 7, title: "Offline series", thumbnailUrl: "", inLibrary: true, chapterCount: 2, source: { id: "1", displayName: "Local" } } as unknown as Manga;

function chapter(id: number, name: string, isRead = false): Chapter {
  return { id, mangaId: 7, name, chapterNumber: id, sourceOrder: id, isRead, isDownloaded: false, isBookmarked: false, lastPageRead: 0, pageCount: 10, scanlator: null, uploadDate: "0" } as unknown as Chapter;
}

let suwayomiOnline = true;
let chapterList: Chapter[] = [];

function answer(query: string) {
  if (!suwayomiOnline) return Promise.reject(new Error("Failed to fetch"));
  switch (query) {
    case "GET_MANGA": return Promise.resolve({ manga: MANGA });
    case "GET_CHAPTERS": return Promise.resolve({ chapters: { nodes: chapterList } });
    case "GET_CATEGORIES": return Promise.resolve({ categories: { nodes: [] } });
    case "GET_DOWNLOAD_STATUS": return Promise.resolve({ downloadStatus: { state: "STOPPED", queue: [] } });
    default: return Promise.resolve({});
  }
}

describe("SeriesDetail while Suwayomi is unreachable", () => {
  beforeEach(() => {
    resetSeriesDetailCacheForTests();
    suwayomiOnline = true;
    chapterList = [chapter(1, "Arrival"), chapter(2, "Departure")];
    gqlMock.mockReset().mockImplementation((query: string) => answer(query));
    readyMock.mockReset().mockImplementation(async () => suwayomiOnline);
    store.activeChapter = null;
    store.activeManga = MANGA;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    store.activeManga = null;
  });

  test("coming back from the reader keeps the last known chapters and reloads them once Suwayomi answers", async () => {
    render(SeriesDetail);
    await screen.findByText("Arrival");
    cleanup();

    // The reader replaced the page; Suwayomi dropped out meanwhile and the reader marked chapter 1 as read.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    suwayomiOnline = false;
    render(SeriesDetail);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText("Arrival")).toBeTruthy();
    expect(screen.getByText("Departure")).toBeTruthy();
    expect(screen.getByText(/Showing the last chapters loaded/)).toBeTruthy();
    expect(screen.queryByText(/No chapters match/i)).toBeNull();

    // Still offline at the next check: nothing is thrown away.
    await vi.advanceTimersByTimeAsync(5000);
    expect(screen.getByText("Arrival")).toBeTruthy();
    expect(screen.getByText(/Showing the last chapters loaded/)).toBeTruthy();

    suwayomiOnline = true;
    chapterList = [chapter(1, "Arrival", true), chapter(2, "Departure"), chapter(3, "Return")];
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText("Return")).toBeTruthy());
    expect(screen.queryByText(/Showing the last chapters loaded/)).toBeNull();
  });

  test("with nothing loaded yet it offers a retry instead of an empty filter result, then recovers on its own", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    suwayomiOnline = false;
    render(SeriesDetail);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText(/Chapters could not be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/No chapters match/i)).toBeNull();

    suwayomiOnline = true;
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText("Arrival")).toBeTruthy());
  });

  test("stops checking once the page is closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    suwayomiOnline = false;
    render(SeriesDetail);
    await vi.advanceTimersByTimeAsync(0);
    cleanup();
    readyMock.mockClear();
    await vi.advanceTimersByTimeAsync(15000);
    expect(readyMock).not.toHaveBeenCalled();
  });
});

describe("SeriesDetail deleting downloaded chapters", () => {
  beforeEach(() => {
    resetSeriesDetailCacheForTests();
    suwayomiOnline = true;
    chapterList = [{ ...chapter(1, "Arrival"), isDownloaded: true }, chapter(2, "Departure")];
    gqlMock.mockReset().mockImplementation((query: string) => answer(query));
    readyMock.mockReset().mockImplementation(async () => suwayomiOnline);
    store.activeChapter = null;
    store.activeManga = MANGA;
    store.toasts = [];
  });
  afterEach(() => {
    cleanup();
    store.activeManga = null;
    store.toasts = [];
  });

  test("keeps a chapter it could not delete and says so", async () => {
    gqlMock.mockImplementation((query: string) => query === "DELETE_DOWNLOADED_CHAPTERS"
      ? Promise.reject(new Error("Suwayomi HTTP 500"))
      : answer(query));
    render(SeriesDetail);
    await fireEvent.click(await screen.findByTitle("Delete download"));

    await waitFor(() => expect(store.toasts.map(({ kind, title, body }) => ({ kind, title, body }))).toEqual([
      { kind: "error", title: "Could not delete the downloads", body: "Suwayomi HTTP 500" },
    ]));
    expect(screen.getByTitle("Delete download")).toBeTruthy();
  });

  test("confirms a deleted chapter", async () => {
    render(SeriesDetail);
    await fireEvent.click(await screen.findByTitle("Delete download"));

    await waitFor(() => expect(store.toasts.map(({ kind, title, body }) => ({ kind, title, body }))).toEqual([
      { kind: "info", title: "Downloads deleted", body: "Arrival" },
    ]));
    expect(gqlMock).toHaveBeenCalledWith("DELETE_DOWNLOADED_CHAPTERS", { ids: [1] });
    expect(screen.queryByTitle("Delete download")).toBeNull();
  });

  test("updates the Library card's download count after deleting a chapter", async () => {
    chapterList = [{ ...chapter(1, "Arrival"), isDownloaded: true }, { ...chapter(2, "Departure"), isDownloaded: true }];
    const previousSnapshot = store.libraryMangaSnapshot;
    store.libraryMangaSnapshot = [{ ...MANGA, downloadCount: 2 }];
    try {
      render(SeriesDetail);
      const arrival = (await screen.findByText("Arrival")).closest(".ch-row") as HTMLElement;
      await fireEvent.click(within(arrival).getByTitle("Delete download"));

      await waitFor(() => expect(store.libraryMangaSnapshot.find((entry) => entry.id === MANGA.id)?.downloadCount).toBe(1));
    } finally {
      store.libraryMangaSnapshot = previousSnapshot;
    }
  });

  test("starts a selection from a chapter's menu and deletes the selected downloads", async () => {
    chapterList = [{ ...chapter(1, "Arrival"), isDownloaded: true }, { ...chapter(2, "Departure"), isDownloaded: true }];
    render(SeriesDetail);
    for (const name of ["Arrival", "Departure"]) {
      await fireEvent.contextMenu((await screen.findByText(name)).closest(".ch-row")!);
      await fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "Select" }));
    }
    expect(screen.getByText("2 selected")).toBeTruthy();

    await fireEvent.click(screen.getByTitle("Delete selected downloads"));

    await waitFor(() => expect(store.toasts.map(({ kind, title, body }) => ({ kind, title, body }))).toEqual([
      { kind: "info", title: "Downloads deleted", body: "Offline series" },
    ]));
    expect(gqlMock).toHaveBeenCalledWith("DELETE_DOWNLOADED_CHAPTERS", { ids: [1, 2] });
    expect(screen.queryByTitle("Delete download")).toBeNull();
  });
});

describe("SeriesDetail reading progress", () => {
  beforeEach(() => {
    resetSeriesDetailCacheForTests();
    suwayomiOnline = true;
    // Suwayomi keeps the index of the last page read, so 4 is the fifth page.
    chapterList = [chapter(1, "Arrival", true), { ...chapter(2, "Departure"), lastPageRead: 4 }];
    gqlMock.mockReset().mockImplementation((query: string) => answer(query));
    readyMock.mockReset().mockImplementation(async () => suwayomiOnline);
    store.activeChapter = null;
    store.activeManga = MANGA;
  });
  afterEach(() => {
    cleanup();
    store.activeManga = null;
  });

  test("counts the page a chapter stopped at from one, like the reader does", async () => {
    render(SeriesDetail);

    expect(await screen.findByRole("button", { name: "Continue Ch.2 p.5" })).toBeTruthy();
    expect(screen.getByText("Page 5")).toBeTruthy();
  });

  test("reads the chapters again when a reader window of its own closes", async () => {
    chapterList = [chapter(1, "Arrival", true), chapter(2, "Departure")];
    render(SeriesDetail);
    expect(await screen.findByRole("button", { name: "Continue Ch.2" })).toBeTruthy();

    // The window saved its progress to Suwayomi before closing; this page never saw the reader.
    chapterList = [chapter(1, "Arrival", true), { ...chapter(2, "Departure"), lastPageRead: 4 }];
    store.noteDetachedReaderClosed();

    expect(await screen.findByRole("button", { name: "Continue Ch.2 p.5" })).toBeTruthy();
    expect(screen.getByText("Page 5")).toBeTruthy();
  });
});

describe("SeriesDetail linking the same series", () => {
  const OTHER = { id: 8, title: "Same series elsewhere", thumbnailUrl: "", inLibrary: true } as unknown as Manga;
  const UNRELATED = { id: 9, title: "Unrelated", thumbnailUrl: "", inLibrary: true } as unknown as Manga;
  let libraryOnline = true;

  beforeEach(() => {
    resetSeriesDetailCacheForTests();
    suwayomiOnline = true;
    libraryOnline = true;
    chapterList = [chapter(1, "Arrival")];
    gqlMock.mockReset().mockImplementation((query: string) => {
      if (query !== "GET_ALL_MANGA") return answer(query);
      if (!libraryOnline) return Promise.reject(new Error("Failed to fetch"));
      return Promise.resolve({ mangas: { nodes: [MANGA, OTHER, UNRELATED] } });
    });
    readyMock.mockReset().mockImplementation(async () => suwayomiOnline);
    store.activeChapter = null;
    store.activeManga = MANGA;
    store.settings = { ...store.settings, mangaLinks: {} };
  });
  afterEach(() => {
    cleanup();
    store.activeManga = null;
    store.settings = { ...store.settings, mangaLinks: {} };
  });

  test("links and unlinks another entry both ways", async () => {
    render(SeriesDetail);
    await fireEvent.click(await screen.findByRole("button", { name: /^Link$/ }));

    const dialog = await screen.findByRole("dialog", { name: /Link as same series/i });
    const other = await within(dialog).findByRole("button", { name: /Same series elsewhere/ });
    expect(within(dialog).queryByRole("button", { name: /Offline series/ })).toBeNull();
    expect(other.getAttribute("aria-pressed")).toBe("false");

    await fireEvent.click(other);
    expect(store.settings.mangaLinks).toEqual({ 7: [8], 8: [7] });
    expect(other.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^Link \(1\)$/ })).toBeTruthy();

    await fireEvent.click(within(dialog).getByRole("button", { name: /Same series elsewhere/ }));
    expect(store.settings.mangaLinks).toEqual({});
    expect(screen.getByRole("button", { name: /^Link$/ })).toBeTruthy();
  });

  test("a library that could not be loaded offers a retry instead of an empty result", async () => {
    libraryOnline = false;
    render(SeriesDetail);
    await fireEvent.click(await screen.findByRole("button", { name: /^Link$/ }));

    const dialog = await screen.findByRole("dialog", { name: /Link as same series/i });
    await within(dialog).findByText("Could not reach Suwayomi");
    expect(within(dialog).queryByText(/No matching series/i)).toBeNull();

    libraryOnline = true;
    await fireEvent.click(within(dialog).getByRole("button", { name: /Retry/ }));
    expect(await within(dialog).findByRole("button", { name: /Same series elsewhere/ })).toBeTruthy();
  });
});
