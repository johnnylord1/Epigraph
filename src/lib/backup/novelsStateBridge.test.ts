import { describe, expect, it } from "vitest";
import { applyRestoredNovelsSnapshotToLibraryState, buildAethonNovelsSnapshotFromAuthoritativeState } from "./novelsStateBridge";

describe("novels backup state bridge", () => {
  it("builds a repository-aware novels snapshot from authoritative desktop state", () => {
    const snapshot = buildAethonNovelsSnapshotFromAuthoritativeState({
      libraryState: {
        entries: [{
          id: "novel:ao3:%2Fworks%2F1",
          title: "MANACLED",
          author: "senlinyu",
          description: null,
          coverUrl: null,
          path: "/works/1",
          status: "ONGOING",
          tags: ["drama"],
          source: {
            repositoryUrl: "https://plugins.example.com/plugins.min.json",
            repositoryName: "Official",
            pluginId: "archiveofourown",
            pluginName: "Archive Of Our Own",
            pluginVersion: "1.0.0",
            sourceId: "archiveofourown",
            sourceName: "Archive Of Our Own",
            lang: "en",
          },
          chapterCount: 1,
          addedAt: 1,
          updatedAt: 2,
        }],
        chapters: [{
          id: "chapter:1",
          novelId: "novel:ao3:%2Fworks%2F1",
          path: "/works/1/chapters/1",
          title: "Chapter 1",
          order: 1,
          releaseTime: null,
          unread: true,
        }],
        progress: [],
        bookmarks: [],
        history: [],
      },
      repositoryState: {
        repositories: [{
          id: "repo-1",
          profileId: "test",
          url: "https://plugins.example.com/plugins.min.json",
          normalizedUrl: "https://plugins.example.com/plugins.min.json",
          recommendedSeed: false,
          trustState: "trusted",
          enabled: true,
          lastFetchedAtMs: null,
          lastSuccessAtMs: null,
          etag: null,
          lastModified: null,
          lastError: null,
        }],
        installedPlugins: [{
          profileId: "test",
          repositoryId: "repo-1",
          pluginId: "archiveofourown",
          version: "1.0.0",
          enabled: true,
          disabledReason: null,
          artifactPath: "C:/profiles/test/novels/plugins/archiveofourown/index.js",
          customJsPath: null,
          customCssPath: null,
          hasSettings: false,
          installedAtMs: 1,
          updatedAtMs: 2,
        }],
      },
    });

    expect(snapshot.entries[0]).toEqual(expect.objectContaining({
      title: "MANACLED",
      path: "/works/1",
    }));
    expect(snapshot.chapters[0]).toEqual(expect.objectContaining({
      path: "/works/1/chapters/1",
      unread: true,
    }));
    expect(snapshot.repositories).toEqual([
      expect.objectContaining({ url: "https://plugins.example.com/plugins.min.json" }),
    ]);
    expect(snapshot.plugins).toEqual([
      expect.objectContaining({ id: "archiveofourown", repositoryUrl: "https://plugins.example.com/plugins.min.json" }),
    ]);
  });

  it("applies a restored novels snapshot back into authoritative library state", () => {
    const nextState = applyRestoredNovelsSnapshotToLibraryState({
      currentState: {
        version: 1,
        scopeKey: "profile:test",
        entries: [],
        chapters: [],
        progress: [],
        bookmarks: [],
        history: [],
        updatedAtMs: null,
      },
      restored: {
        exportMode: "repository-aware",
        entries: [{
          id: "novel:ao3:%2Fworks%2F1",
          title: "MANACLED",
          path: "/works/1",
          author: "senlinyu",
          description: null,
          coverUrl: null,
          coverPath: null,
          externalNovelId: null,
          externalUrl: null,
          status: "ONGOING",
          tags: ["drama"],
          source: {
            repositoryUrl: "https://plugins.example.com/plugins.min.json",
            repositoryName: "Official",
            pluginId: "archiveofourown",
            pluginName: "Archive Of Our Own",
            pluginVersion: "1.0.0",
            sourceId: "archiveofourown",
            sourceName: "Archive Of Our Own",
            lang: "en",
          },
          addedAt: 1,
          updatedAt: 2,
        }],
        chapters: [{
          id: "chapter:1",
          novelId: "novel:ao3:%2Fworks%2F1",
          path: "/works/1/chapters/1",
          title: "Chapter 1",
          order: 1,
          releaseTime: null,
          unread: false,
        }],
        progress: [],
        bookmarks: [],
        history: [],
        repositories: [],
        plugins: [],
        classifications: [],
        issues: [],
        summary: {
          totalEntries: 1,
          restoredUsableCount: 1,
          restoredNeedsRepositoryCount: 0,
          restoredNeedsPluginCount: 0,
          restoredMetadataOnlyCount: 0,
        },
      },
    });

    expect(nextState.scopeKey).toBe("profile:test");
    expect(nextState.entries[0]).toEqual(expect.objectContaining({
      title: "MANACLED",
      path: "/works/1",
      chapterCount: 1,
    }));
    expect(nextState.chapters[0]).toEqual(expect.objectContaining({
      path: "/works/1/chapters/1",
      unread: false,
    }));
  });
});
