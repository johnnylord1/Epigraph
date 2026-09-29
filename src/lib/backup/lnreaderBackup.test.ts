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
  it("maps category database references through imported stable Novel identities", async () => {
    const zip = new JSZip();
    zip.file("Version.json", "{}");
    zip.file("NovelAndChapters/7.json", JSON.stringify({ id: 7, pluginId: "provider", path: "/valid", chapters: [] }));
    zip.file("Category.json", JSON.stringify([{ id: 4, name: "Favorites", sort: 2, novelIds: [7, 999] }]));
    const parsed = await parseLnReaderNovelsBackup(await zip.generateAsync({ type: "uint8array" }));
    expect(parsed.categories).toEqual([{ id: "4", name: "Favorites", order: 2, novelIds: [parsed.entries[0].id] }]);
    expect(parsed.importIssues?.map(issue => issue.code)).toContain("unresolved-category-novel");
  });
  it.each([null, 3, "invalid", []])("isolates a malformed novel from a valid neighbor: %j", async malformed => {
    const zip = new JSZip();
    zip.file("Version.json", "{}");
    zip.file("NovelAndChapters/1.json", JSON.stringify(malformed));
    zip.file("NovelAndChapters/2.json", JSON.stringify({ id: 2, pluginId: "provider", path: "/valid", chapters: [] }));
    const parsed = await parseLnReaderNovelsBackup(await zip.generateAsync({ type: "uint8array" }));
    expect(parsed.entries.map(entry => entry.path)).toEqual(["/valid"]);
    expect(parsed.importIssues).toHaveLength(1);
  });
  it("skips missing stable identities with warnings instead of importing database IDs as paths", async () => {
    const zip = new JSZip();
    zip.file("Version.json", "{}");
    const novels = [
      { id: 1, pluginId: "provider", path: "/valid", chapters: [{ id: 9 }, { id: 10, path: "/valid/chapter" }] },
      { id: 2, path: "/missing-provider", chapters: [] },
      { id: 3, pluginId: "provider", chapters: [] },
    ];
    novels.forEach(novel => zip.file(`NovelAndChapters/${novel.id}.json`, JSON.stringify(novel)));
    const parsed = await parseLnReaderNovelsBackup(await zip.generateAsync({ type: "uint8array" }));
    expect(parsed.entries.map(entry => entry.path)).toEqual(["/valid"]);
    expect(parsed.chapters.map(chapter => chapter.path)).toEqual(["/valid/chapter"]);
    expect(parsed.importIssues?.map(issue => issue.code).sort()).toEqual([
      "invalid-chapter-identity", "invalid-novel-identity", "invalid-novel-identity",
    ]);
  });
  it("does not collapse distinct provider paths through lossy import IDs", async () => {
    const zip = new JSZip();
    zip.file("Version.json", "{}");
    for (const [id, path] of [[1, "/a.b"], [2, "/a-b"]]) zip.file(`NovelAndChapters/${id}.json`, JSON.stringify({ id, pluginId: "provider", path, name: "Novel", chapters: [] }));
    const parsed = await parseLnReaderNovelsBackup(await zip.generateAsync({ type: "uint8array" }));
    expect(new Set(parsed.entries.map(entry => entry.id)).size).toBe(2);
  });
  it("does not invent fresh progress evidence from absent dates or source updates", async () => {
    const zip = new JSZip();
    zip.file("Version.json", "{}");
    zip.file("NovelAndChapters/1.json", JSON.stringify({ id: 1, pluginId: "provider", path: "/novel", name: "Novel", chapters: [{ id: 2, path: "/chapter", name: "Chapter", unread: false, progress: 50, updatedTime: "2026-09-01T00:00:00Z" }] }));
    const parsed = await parseLnReaderNovelsBackup(await zip.generateAsync({ type: "uint8array" }));
    expect(parsed.progress[0].updatedAt).toBe(0);
  });
  it.each([true, false])("keeps the saved LAST_READ_PREFIX locator even outside the chapter list: %s", async (listed) => {
    const root = new JSZip();
    const saved = { id: 12, novelId: 1, path: "chapter-saved", name: "Saved chapter", unread: true, position: 12, progress: 1, readTime: "2026-08-21 10:00:00" };
    root.file("Version.json", "{}");
    root.file("Setting.json", JSON.stringify({ LAST_READ_PREFIX_illusia_story: JSON.stringify(saved) }));
    root.file("NovelAndChapters/1.json", JSON.stringify({
      id: 1, pluginId: "illusia", path: "story", name: "Novel", inLibrary: 1,
      chapters: [{ id: 1, path: "chapter-first", unread: false, position: 0, readTime: "2026-08-20 10:00:00" },
        ...(listed ? [{ ...saved, progress: null, readTime: null }] : [])],
    }));
    const parsed = await parseLnReaderNovelsBackup(await root.generateAsync({ type: "uint8array" }));
    expect(parsed.chapters).toHaveLength(listed ? 2 : 1);
    const chapterId = `${parsed.entries[0].id}:chapter:chapter-saved`;
    expect(parsed.progress[0]).toMatchObject({ chapterId, chapterTitle: "Saved chapter", locator: `scroll:${encodeURIComponent(chapterId)}:0.010000` });
    if (listed) expect(parsed.progress[0].progressPercent).toBeCloseTo(1.01 / 2);
  });

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

  it("restores installed plugin metadata and derives LNReader repository manifests", async () => {
    const root = new JSZip();
    const download = new JSZip();
    const officialArtifact = "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.js/src/plugins/portuguese/illusia.js";
    const communityArtifact = "https://raw.githubusercontent.com/johnnylord1/lnreader-plugins/plugins/v3.0.0/.js/src/plugins/portuguese/mahoureader.js";
    root.file("Version.json", JSON.stringify({ version: "3.0.0" }));
    root.file("Setting.json", JSON.stringify({
      INSTALL_PLUGINS: JSON.stringify([
        {
          id: "illusia",
          name: "Illusia",
          lang: "Português",
          version: "1.0.2",
          url: officialArtifact,
        },
        {
          id: "mahoureader",
          name: "Mahou Reader",
          lang: "Português",
          version: "1.0.1",
          url: communityArtifact,
        },
      ]),
    }));
    root.file("NovelAndChapters/1.json", JSON.stringify({
      id: 1,
      pluginId: "illusia",
      path: "story/saved",
      name: "Saved novel",
      inLibrary: 1,
      chapters: [],
    }));
    download.file("Plugins/illusia/index.js", "export default {};");
    download.file("Plugins/mahoureader/index.js", "export default {};");
    root.file("download.zip", await download.generateAsync({ type: "uint8array" }));

    const parsed = await parseLnReaderNovelsBackup(await root.generateAsync({ type: "uint8array" }));

    expect(parsed.repositories).toEqual([
      { url: "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json", name: "LNReader plugins" },
      { url: "https://raw.githubusercontent.com/johnnylord1/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json", name: "johnnylord1 plugins" },
    ]);
    expect(parsed.plugins).toEqual([
      {
        id: "illusia",
        name: "Illusia",
        version: "1.0.2",
        repositoryUrl: "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json",
      },
      {
        id: "mahoureader",
        name: "Mahou Reader",
        version: "1.0.1",
        repositoryUrl: "https://raw.githubusercontent.com/johnnylord1/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json",
      },
    ]);
    expect(parsed.entries[0]?.source).toEqual(expect.objectContaining({
      repositoryUrl: "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json",
      pluginName: "Illusia",
      pluginVersion: "1.0.2",
      lang: "Português",
    }));
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

  it("converts LNReader partial chapter progress into a resumable scroll locator", async () => {
    const root = new JSZip();
    root.file("Version.json", JSON.stringify({ version: "test" }));
    root.file("NovelAndChapters/1.json", JSON.stringify({
      id: 1,
      pluginId: "illusia",
      path: "story/partial",
      name: "Partial novel",
      inLibrary: 1,
      chapters: [
        { id: 10, path: "chapter-1", name: "Chapter 1", unread: 0, position: 0, readTime: "2026-01-01 10:00:00" },
        { id: 11, path: "chapter-2", name: "Chapter 2", unread: 1, position: 1, progress: 40, readTime: "2026-01-02 10:00:00" },
        { id: 12, path: "chapter-3", name: "Chapter 3", unread: 1, position: 2 },
      ],
    }));

    const parsed = await parseLnReaderNovelsBackup(await root.generateAsync({ type: "uint8array" }));
    const chapterId = parsed.chapters[1]!.id;

    expect(parsed.progress).toEqual([expect.objectContaining({
      chapterId,
      progressPercent: (1 + 0.4) / 3,
      locator: `scroll:${encodeURIComponent(chapterId)}:0.400000`,
    })]);
    expect(parsed.chapters[1]?.unread).toBe(true);
  });
});
