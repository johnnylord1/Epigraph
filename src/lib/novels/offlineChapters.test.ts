import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/path", () => ({
  join: (...parts: string[]) => Promise.resolve(parts.join("/")),
}));

import {
  loadCachedNovelChapter,
  saveCachedNovelChapter,
} from "./offlineChapters";

describe("novel offline chapter cache", () => {
  beforeEach(() => {
    invokeMock.mockReset();
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
        return Promise.resolve("C:/Aethon/novels");
      }
      if (command === "write_file_base64") {
        expect(args.path).toContain("C:/Aethon/novels/chapters/");
        savedBase64 = args.bytesBase64;
        return Promise.resolve(args.path);
      }
      if (command === "read_file_base64") {
        expect(args.path).toContain("C:/Aethon/novels/chapters/");
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
});
