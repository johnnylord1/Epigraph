import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { loadOfflineMangaChapter, revokeOfflineMangaPages } from "./offlineManga";

describe("offline manga release contract", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn((blob: Blob) => `blob:aethon-${blob.type}-${blob.size}`),
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
      "blob:aethon-image/jpeg-1",
      "blob:aethon-image/png-1",
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
});
