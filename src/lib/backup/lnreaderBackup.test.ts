import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  buildLnReaderNovelsBackupZip,
  extractLnReaderBackupPluginIds,
  isLnReaderBackupZip,
  parseLnReaderNovelsBackup,
} from "./lnreaderBackup";
import type { EpigraphNovelsSnapshot } from "./novelsBackup";

const snapshot: EpigraphNovelsSnapshot = {
  entries: [{
    id: "novel-1",
    title: "Sample Novel",
    path: "/sample",
    author: "Author",
    description: "Description",
    coverUrl: "https://example.com/cover.jpg",
    status: "ONGOING",
    tags: ["Action", "Fantasy"],
    source: {
      repositoryUrl: "https://example.com/repo.json",
      pluginId: "app.lnreader.sources.sample",
      pluginName: "Sample",
      sourceId: "app.lnreader.sources.sample",
      sourceName: "Sample",
      lang: "en",
    },
    addedAt: 1,
    updatedAt: 2,
  }],
  chapters: [{
    id: "chapter-1",
    novelId: "novel-1",
    path: "/sample/1",
    title: "Chapter 1",
    order: 1,
    releaseTime: null,
    unread: false,
    updatedAt: 3,
  }],
  progress: [],
  bookmarks: [],
  history: [],
  repositories: [],
  plugins: [],
};

describe("LNReader backup compatibility", () => {
  it("exports and parses a LNReader-compatible zip", async () => {
    const bytes = await buildLnReaderNovelsBackupZip(snapshot);
    expect(await isLnReaderBackupZip(bytes)).toBe(true);

    const parsed = await parseLnReaderNovelsBackup(bytes);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.title).toBe("Sample Novel");
    expect(parsed.entries[0]?.source?.pluginId).toBe("app.lnreader.sources.sample");
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0]?.title).toBe("Chapter 1");
  });

  it("detects embedded LNReader plugin inventory without executing plugin code", async () => {
    const bytes = await buildLnReaderNovelsBackupZip(snapshot);
    const root = await JSZip.loadAsync(bytes);
    const download = new JSZip();
    download.file("Plugins/app.lnreader.sources.sample/index.js", "throw new Error('do not execute');");
    root.file("download.zip", await download.generateAsync({ type: "uint8array" }));
    const withPlugin = await root.generateAsync({ type: "uint8array" });

    expect(await extractLnReaderBackupPluginIds(withPlugin)).toEqual(["app.lnreader.sources.sample"]);

    const parsed = await parseLnReaderNovelsBackup(withPlugin);
    expect(parsed.plugins).toEqual([{
      id: "app.lnreader.sources.sample",
      name: "app.lnreader.sources.sample",
      version: null,
      repositoryUrl: null,
    }]);
  });

  it("ignores LNReader cache entries that are not saved in the library", async () => {
    const root = new JSZip();
    root.file("Version.json", JSON.stringify({ version: "test" }));
    root.file("NovelAndChapters/1.json", JSON.stringify({
      id: 1,
      pluginId: "illusia",
      path: "story/saved",
      name: "Saved novel",
      inLibrary: 1,
      chapters: [],
    }));
    root.file("NovelAndChapters/2.json", JSON.stringify({
      id: 2,
      pluginId: "illusia",
      path: "story/cache-only",
      name: "Cache-only novel",
      inLibrary: 0,
      chapters: [],
    }));

    const parsed = await parseLnReaderNovelsBackup(await root.generateAsync({ type: "uint8array" }));

    expect(parsed.entries.map((entry) => entry.title)).toEqual(["Saved novel"]);
  });

  it("uses embedded LNReader cover assets from download.zip", async () => {
    const root = new JSZip();
    const download = new JSZip();
    root.file("Version.json", JSON.stringify({ version: "test" }));
    root.file("NovelAndChapters/1.json", JSON.stringify({
      id: 1,
      pluginId: "illusia",
      path: "story/saved",
      name: "Saved novel",
      cover: "/Novels/illusia/1/cover.png?cache=1",
      inLibrary: 1,
      chapters: [],
    }));
    download.file("Novels/illusia/1/cover.png", new Uint8Array([137, 80, 78, 71]));
    root.file("download.zip", await download.generateAsync({ type: "uint8array" }));

    const parsed = await parseLnReaderNovelsBackup(await root.generateAsync({ type: "uint8array" }));

    expect(parsed.entries[0]?.coverUrl).toBe("data:image/png;base64,iVBORw==");
  });

  it("restores LNReader read progress, resume history, and chapter bookmarks", async () => {
    const root = new JSZip();
    root.file("Version.json", JSON.stringify({ version: "test" }));
    root.file("NovelAndChapters/1.json", JSON.stringify({
      id: 1,
      pluginId: "illusia",
      path: "story/progress",
      name: "Progress novel",
      inLibrary: 1,
      lastReadAt: "2026-06-22 21:38:17",
      chapters: [
        {
          id: 10,
          path: "chapter-1",
          name: "Chapter 1",
          unread: 0,
          bookmark: 0,
          page: "1",
          position: 0,
        },
        {
          id: 11,
          path: "chapter-2",
          name: "Chapter 2",
          unread: 0,
          bookmark: 1,
          progress: "p:45",
          position: 1,
        },
        {
          id: 12,
          path: "chapter-3",
          name: "Chapter 3",
          unread: 1,
          bookmark: 0,
          position: 2,
        },
      ],
    }));

    const parsed = await parseLnReaderNovelsBackup(await root.generateAsync({ type: "uint8array" }));
    const novelId = parsed.entries[0]?.id;

    expect(parsed.chapters.map((chapter) => chapter.unread)).toEqual([false, false, true]);
    expect(parsed.progress).toEqual([expect.objectContaining({
      novelId,
      chapterTitle: "Chapter 2",
      progressPercent: 2 / 3,
      locator: "p:45",
    })]);
    expect(parsed.history).toEqual([expect.objectContaining({
      novelId,
      chapterTitle: "Chapter 2",
      locator: "p:45",
    })]);
    expect(parsed.bookmarks).toEqual([expect.objectContaining({
      novelId,
      chapterTitle: "Chapter 2",
      locator: "p:45",
      label: "Chapter 2",
    })]);
  });
});
