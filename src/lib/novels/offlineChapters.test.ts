import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, readChapterMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  readChapterMock: vi.fn(),
}));

vi.mock("./sources", () => ({
  readInstalledNovelChapter: readChapterMock,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/path", () => ({
  join: (...parts: string[]) => Promise.resolve(parts.join("/")),
}));

import {
  deleteCachedNovelChapters,
  downloadNovelChaptersForOffline,
  listCachedNovelChapterKeys,
  loadCachedNovelChapter,
  novelChapterCacheKey,
  saveCachedNovelChapter,
} from "./offlineChapters";

const scope = { profileId: "main", serverUrl: "http://127.0.0.1:4567" };

describe("novel offline chapter cache", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    readChapterMock.mockReset();
    Object.defineProperty(globalThis, "window", {
      value: { __TAURI_INTERNALS__: {} },
      configurable: true,
      writable: true,
    });
  });

  it("writes and reads chapter content under the profile novel storage root", async () => {
    let savedBase64 = "";
    invokeMock.mockImplementation((command: string, args: any) => {
      if (command === "resolve_novel_storage_root") {
        expect(args).toEqual({ profileId: "main", serverUrl: "http://127.0.0.1:4567" });
        return Promise.resolve("C:/Epigraph/novels");
      }
      if (command === "write_file_base64") {
        expect(args.path).toContain("C:/Epigraph/novels/chapters/");
        savedBase64 = args.bytesBase64;
        return Promise.resolve(args.path);
      }
      if (command === "read_file_base64") {
        expect(args.path).toContain("C:/Epigraph/novels/chapters/");
        return Promise.resolve(savedBase64);
      }
      return Promise.reject(new Error(`Unexpected command ${command}`));
    });

    await saveCachedNovelChapter({
      profileId: "main",
      serverUrl: "http://127.0.0.1:4567",
    }, {
      sourceId: "source",
      novelId: "novel:source:%2Fnovel",
      chapterId: "chapter:1",
      chapterPath: "/novel/chapter-1",
      chapterTitle: "Chapter 1",
      content: "<p>Hello</p>",
    });

    const cached = await loadCachedNovelChapter({
      profileId: "main",
      serverUrl: "http://127.0.0.1:4567",
    }, "source", "/novel/chapter-1");

    expect(cached).toMatchObject({
      sourceId: "source",
      novelId: "novel:source:%2Fnovel",
      chapterId: "chapter:1",
      chapterPath: "/novel/chapter-1",
      chapterTitle: "Chapter 1",
      content: "<p>Hello</p>",
    });
  });

  it("lists and deletes the saved chapters of a source by their stable keys", async () => {
    invokeMock.mockImplementation((command: string, args: any) => {
      if (command === "list_novel_cached_chapters") return Promise.resolve([novelChapterCacheKey("/c1"), "other"]);
      if (command === "delete_novel_cached_chapters") return Promise.resolve(args.chapterHashes.length);
      return Promise.reject(new Error(`Unexpected command ${command}`));
    });

    const keys = await listCachedNovelChapterKeys(scope, "source");
    expect(keys.has(novelChapterCacheKey("/c1"))).toBe(true);
    expect(keys.has(novelChapterCacheKey("/c2"))).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("list_novel_cached_chapters", expect.objectContaining({ profileId: "main", serverUrl: scope.serverUrl }));
    const sourceHash = invokeMock.mock.calls[0][1].sourceHash;
    expect(sourceHash).toMatch(/^[0-9a-z]{1,16}$/);

    await expect(deleteCachedNovelChapters(scope, "source", ["/c1", "/c1", "/c2"])).resolves.toBe(2);
    expect(invokeMock).toHaveBeenLastCalledWith("delete_novel_cached_chapters", {
      ...scope,
      sourceHash,
      chapterHashes: [novelChapterCacheKey("/c1"), novelChapterCacheKey("/c2")],
    });
    await expect(deleteCachedNovelChapters(scope, "source", [])).resolves.toBe(0);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("downloads only chapters not saved yet and keeps going after a failure", async () => {
    const written: string[] = [];
    invokeMock.mockImplementation((command: string, args: any) => {
      if (command === "list_novel_cached_chapters") return Promise.resolve([novelChapterCacheKey("/c1")]);
      if (command === "resolve_novel_storage_root") return Promise.resolve("C:/Epigraph/novels");
      if (command === "write_file_base64") {
        written.push(args.path);
        return Promise.resolve(args.path);
      }
      return Promise.reject(new Error(`Unexpected command ${command}`));
    });
    readChapterMock.mockImplementation((_scope: unknown, _source: string, path: string) =>
      path === "/c2" ? Promise.reject(new Error("offline")) : Promise.resolve({ content: `<p>${path}</p>` }));
    const progress: Array<[string, boolean]> = [];

    const result = await downloadNovelChaptersForOffline(scope, {
      sourceId: "source",
      novelId: "novel",
      chapters: [
        { id: "1", path: "/c1", title: "One" },
        { id: "2", path: "/c2", title: "Two" },
        { id: "3", path: "/c3", title: null },
      ],
    }, (id, ok) => progress.push([id, ok]));

    expect(result).toEqual({ saved: ["3"], failed: ["2"] });
    expect(progress).toEqual([["2", false], ["3", true]]);
    expect(readChapterMock).toHaveBeenCalledTimes(2);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(`${novelChapterCacheKey("/c3")}.json`);
  });
});
