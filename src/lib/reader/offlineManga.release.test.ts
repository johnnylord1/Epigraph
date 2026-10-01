import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  convertFileSrc: (path: string, protocol: string) => `http://${protocol}.localhost/${encodeURIComponent(path)}`,
}));

import {
  loadOfflineMangaChapter,
  openOfflineMangaChapterForWindow,
  setOfflineMangaRelay,
} from "./offlineManga";

const INPUT = {
  downloadsPath: "C:/isolated/downloads",
  sourceName: "Audit Source",
  mangaTitle: "Audit Manga",
  chapterName: "Chapter 1",
};
const ID = "0123456789abcdef0123456789abcdef";
const PAGES = [
  `http://offline-page.localhost/${ID}%2F0`,
  `http://offline-page.localhost/${ID}%2F1`,
  `http://offline-page.localhost/${ID}%2F2`,
];

describe("offline manga release contract", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("opens a downloaded chapter as one address per page, reading no page up front", async () => {
    invokeMock.mockResolvedValue({ id: ID, pages: 3 });

    await expect(loadOfflineMangaChapter(INPUT)).resolves.toEqual(PAGES);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("open_downloaded_chapter", { ...INPUT, scanlator: null, profileId: null });
  });

  it("returns an empty page list when no downloaded archive exists", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(loadOfflineMangaChapter(INPUT)).resolves.toEqual([]);
  });

  it("refuses an answer that does not name a chapter and its pages", async () => {
    for (const answer of [{ id: "../books", pages: 2 }, { id: ID, pages: 0 }, { id: ID, pages: 1.5 }, { pages: 2 }]) {
      invokeMock.mockResolvedValueOnce(answer);
      await expect(loadOfflineMangaChapter(INPUT)).rejects.toThrow("Downloaded chapter could not be read.");
    }
  });

  it("lets a detached window read the pages itself once the main window opened the chapter", async () => {
    invokeMock.mockResolvedValue({ id: ID, pages: 3 });
    const opened = await openOfflineMangaChapterForWindow({ ...INPUT, scanlator: null, profileId: "profile-a" });
    // A blank downloads path resolves inside the profile the reading window belongs to.
    expect(invokeMock).toHaveBeenCalledWith("open_downloaded_chapter", { ...INPUT, scanlator: null, profileId: "profile-a" });
    // The window runs in another webview; the relay stands in for the sealed channel.
    const open = vi.fn(async () => opened);
    setOfflineMangaRelay({ open });
    try {
      await expect(loadOfflineMangaChapter(INPUT)).resolves.toEqual(PAGES);
    } finally {
      setOfflineMangaRelay(null);
    }
    expect(open).toHaveBeenCalledWith(INPUT);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("refuses bad requests from a window", async () => {
    await expect(openOfflineMangaChapterForWindow({ ...INPUT, chapterName: 4 })).rejects.toThrow("OFFLINE_CHAPTER_INVALID");
    await expect(openOfflineMangaChapterForWindow({ ...INPUT, profileId: 7 })).rejects.toThrow("OFFLINE_CHAPTER_INVALID");
    await expect(openOfflineMangaChapterForWindow(null)).rejects.toThrow("OFFLINE_CHAPTER_INVALID");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
