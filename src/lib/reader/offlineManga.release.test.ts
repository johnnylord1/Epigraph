import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  loadOfflineMangaChapter,
  openOfflineMangaChapterForWindow,
  readOfflineMangaPageForWindow,
  revokeOfflineMangaPages,
  setOfflineMangaRelay,
} from "./offlineManga";

const INPUT = {
  downloadsPath: "C:/isolated/downloads",
  sourceName: "Audit Source",
  mangaTitle: "Audit Manga",
  chapterName: "Chapter 1",
};

async function archive() {
  const zip = new JSZip();
  zip.file("10.png", new Uint8Array([10, 11]));
  zip.file("2.jpg", new Uint8Array([2]));
  return Buffer.from(await zip.generateAsync({ type: "uint8array" })).toString("base64");
}

describe("offline manga release contract", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn((blob: Blob) => `blob:epigraph-${blob.type}-${blob.size}`),
      revokeObjectURL: vi.fn(),
    });
  });

  it("loads downloaded archive pages in natural order without a server response", async () => {
    const zip = new JSZip();
    zip.file("10.png", new Uint8Array([10]));
    zip.file("2.jpg", new Uint8Array([2]));
    zip.file("notes.txt", "ignored");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    invokeMock.mockResolvedValue(Buffer.from(bytes).toString("base64"));

    const urls = await loadOfflineMangaChapter({
      downloadsPath: "C:/isolated/downloads",
      sourceName: "Audit Source",
      mangaTitle: "Audit Manga",
      chapterName: "Chapter 1",
    });

    expect(invokeMock).toHaveBeenCalledWith("read_downloaded_chapter_archive", expect.objectContaining({
      scanlator: null,
    }));
    expect(urls).toEqual([
      "blob:epigraph-image/jpeg-1",
      "blob:epigraph-image/png-1",
    ]);

    revokeOfflineMangaPages(urls);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("returns an empty page list when no downloaded archive exists", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(loadOfflineMangaChapter({
      downloadsPath: "C:/isolated/downloads",
      sourceName: "Audit Source",
      mangaTitle: "Audit Manga",
      chapterName: "Chapter 1",
    })).resolves.toEqual([]);
  });

  it("hands a detached window one page at a time and forgets each page it took", async () => {
    invokeMock.mockResolvedValue(await archive());
    const opened = await openOfflineMangaChapterForWindow({ ...INPUT, scanlator: null });
    expect(opened).toEqual({ id: expect.any(String), types: ["image/jpeg", "image/png"] });
    // The window runs in another webview; the relay stands in for the sealed channel.
    setOfflineMangaRelay({
      open: async () => opened,
      page: async (id, index) => readOfflineMangaPageForWindow(id, index),
    });
    try {
      expect(await loadOfflineMangaChapter(INPUT)).toEqual(["blob:epigraph-image/jpeg-1", "blob:epigraph-image/png-2"]);
    } finally {
      setOfflineMangaRelay(null);
    }
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(() => readOfflineMangaPageForWindow(opened!.id, 0)).toThrow("OFFLINE_CHAPTER_EXPIRED");
  });

  it("refuses bad requests from a window and frees pages it already made when a later page fails", async () => {
    await expect(openOfflineMangaChapterForWindow({ ...INPUT, chapterName: 4 })).rejects.toThrow("OFFLINE_CHAPTER_INVALID");
    invokeMock.mockResolvedValue(await archive());
    const opened = await openOfflineMangaChapterForWindow(INPUT);
    expect(() => readOfflineMangaPageForWindow(opened!.id, 5)).toThrow("OFFLINE_CHAPTER_PAGE_INVALID");
    readOfflineMangaPageForWindow(opened!.id, 0);
    expect(() => readOfflineMangaPageForWindow(opened!.id, 0)).toThrow("OFFLINE_CHAPTER_PAGE_INVALID");

    setOfflineMangaRelay({
      open: async () => ({ id: "x", types: ["image/png", "image/png"] }),
      page: async (_id, index) => {
        if (index === 1) throw new Error("DETACHED_READER_MAIN_WINDOW_UNAVAILABLE");
        return Buffer.from([1]).toString("base64");
      },
    });
    try {
      await expect(loadOfflineMangaChapter(INPUT)).rejects.toThrow("DETACHED_READER_MAIN_WINDOW_UNAVAILABLE");
    } finally {
      setOfflineMangaRelay(null);
    }
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:epigraph-image/png-1");
  });
});
