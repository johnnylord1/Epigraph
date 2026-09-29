import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NovelDetailRecord, PersistedNovelLibraryState } from "./domain";

const { readDetailsMock, loadStateMock, saveStateMock } = vi.hoisted(() => ({
  readDetailsMock: vi.fn(),
  loadStateMock: vi.fn(),
  saveStateMock: vi.fn(),
}));

vi.mock("./sources", () => ({
  readInstalledNovelDetails: readDetailsMock,
  readInstalledNovelChapter: vi.fn(),
}));

vi.mock("./libraryState", () => ({
  loadNovelLibraryState: loadStateMock,
  saveNovelLibraryState: saveStateMock,
}));

import { refreshNovelDetailFromSource } from "./libraryRefresh";

const scope = { profileId: "main", serverUrl: "http://127.0.0.1:4567" };
const source = { repositoryUrl: null, pluginId: "src", sourceId: "src", sourceName: "Source" };

function detail(chapterPaths: string[]): NovelDetailRecord {
  return {
    id: "novel:src:%2Fn",
    sourceId: "src",
    title: "Novel",
    path: "/n",
    coverUrl: null,
    author: null,
    description: null,
    status: null,
    tags: [],
    chapterCount: chapterPaths.length,
    chapters: chapterPaths.map((path, order) => ({
      id: `c:${path}`,
      novelId: "novel:src:%2Fn",
      path,
      title: path,
      order,
      releaseTime: null,
      unread: true,
    })),
    source,
  };
}

function libraryState(): PersistedNovelLibraryState {
  return {
    version: 1,
    scopeKey: "scope",
    entries: [{
      id: "novel:src:%2Fn",
      title: "Novel",
      author: null,
      description: null,
      coverUrl: null,
      path: "/n",
      status: null,
      tags: [],
      source,
      chapterCount: 1,
      addedAt: 1,
      updatedAt: 1,
    }],
    chapters: [{ id: "c:/1", novelId: "novel:src:%2Fn", path: "/1", title: "/1", order: 0, releaseTime: null, unread: false }],
    progress: [],
    bookmarks: [],
    history: [],
    updatedAtMs: 1,
  };
}

describe("refreshNovelDetailFromSource", () => {
  beforeEach(() => {
    readDetailsMock.mockReset();
    loadStateMock.mockReset();
    saveStateMock.mockReset();
    saveStateMock.mockImplementation((state: PersistedNovelLibraryState) => Promise.resolve(state));
  });

  it("merges new chapters into a library novel without losing read state", async () => {
    readDetailsMock.mockResolvedValue(detail(["/1", "/2"]));
    loadStateMock.mockResolvedValue(libraryState());

    const result = await refreshNovelDetailFromSource(scope, detail(["/1"]), true);

    expect(readDetailsMock).toHaveBeenCalledWith(scope, "src", "/n", { title: "Novel", coverUrl: null });
    expect(result.newChapters).toBe(1);
    expect(saveStateMock).toHaveBeenCalledTimes(1);
    expect(result.state?.chapters.map((chapter) => [chapter.path, chapter.unread])).toEqual([["/1", false], ["/2", true]]);
  });

  it("does not touch the library for a novel outside it", async () => {
    readDetailsMock.mockResolvedValue(detail(["/1", "/2"]));

    const result = await refreshNovelDetailFromSource(scope, detail(["/1"]), false);

    expect(result).toMatchObject({ state: null, newChapters: 0 });
    expect(result.detail.chapters).toHaveLength(2);
    expect(loadStateMock).not.toHaveBeenCalled();
    expect(saveStateMock).not.toHaveBeenCalled();
  });

  it("leaves the library unchanged when the source fails", async () => {
    readDetailsMock.mockRejectedValue(new Error("source offline"));

    await expect(refreshNovelDetailFromSource(scope, detail(["/1"]), true)).rejects.toThrow("source offline");
    expect(saveStateMock).not.toHaveBeenCalled();
  });
});
