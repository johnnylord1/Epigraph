import { describe, expect, it } from "vitest";
import { applyRestoredNovelsSnapshotToLibraryState, buildEpigraphNovelsSnapshotFromAuthoritativeState, mergeRestoredNovelsSnapshot, mergeNovelCategories } from "./novelsStateBridge";
import type { PersistedNovelLibraryState } from "../novels/domain";
import type { RestoredEpigraphNovelsSnapshot } from "./novelsBackup";

function mergeFixture() {
  const source = { pluginId: "provider", sourceId: "provider", repositoryUrl: null };
  const current: PersistedNovelLibraryState = {
    version: 1, scopeKey: "profile:test", updatedAtMs: 200,
    entries: [{ id: "destination", path: "/novel", source, title: "Current", author: null, description: null, coverUrl: null, status: null, tags: [], chapterCount: 2, addedAt: 1, updatedAt: 200 }],
    chapters: [
      { id: "destination-c1", novelId: "destination", path: "/one", title: "One", order: 0, releaseTime: null, unread: false },
      { id: "destination-c2", novelId: "destination", path: "/two", title: "Two", order: 1, releaseTime: null, unread: true },
    ],
    progress: [{ novelId: "destination", chapterId: "destination-c1", progressPercent: 0.4, locator: "scroll:destination-c1:0.800000", updatedAt: 200 }],
    bookmarks: [{ novelId: "destination", chapterId: "destination-c1", locator: "destination-c1", savedAt: 200 }],
    history: [{ novelId: "destination", chapterId: "destination-c1", readAt: 200 }],
  };
  const restored: RestoredEpigraphNovelsSnapshot = {
    entries: [{ ...current.entries[0], id: "backup-9", title: "Old", updatedAt: 100 }],
    chapters: [{ ...current.chapters[0], id: "backup-c9", novelId: "backup-9", unread: true, updatedAt: 9999 }],
    progress: [{ novelId: "backup-9", chapterId: "backup-c9", progressPercent: 0.1, locator: "scroll:backup-c9:0.100000", updatedAt: 100 }],
    bookmarks: [], history: [], exportMode: "metadata-only", classifications: [], issues: [],
    summary: { totalEntries: 1, restoredUsableCount: 0, restoredNeedsRepositoryCount: 0, restoredNeedsPluginCount: 0, restoredMetadataOnlyCount: 1 },
  };
  return { current, restored, run: () => applyRestoredNovelsSnapshotToLibraryState({ currentState: current, restored }) };
}

describe("identity-aware Novel merge", () => {
  it("reports preserved user-state conflicts and isolates malformed chapter groups", () => {
    const f = mergeFixture();
    expect(mergeRestoredNovelsSnapshot({ currentState: f.current, restored: f.restored }).warnings).toContainEqual({ novelId: "backup-9", field: "unread:/one", code: "CURRENT_STATE_PRESERVED" });
    f.restored.chapters.push({ ...f.restored.chapters[0], id: "duplicate" });
    const next = mergeRestoredNovelsSnapshot({ currentState: f.current, restored: f.restored });
    expect(next.state).toEqual(f.current);
    expect(next.novelIdMap.size).toBe(0);
  });
  it("maps categories by destination identity and unions memberships without toggling", () => {
    const input = {
      categories: [{ id: "local-category", name: "Favorites", order: 2, includeInUpdate: "UNSET" as const }],
      assignments: { "unrelated-book": ["local-category"], destination: ["local-category"] },
      backupCategories: [{ id: "backup-category", name: "Favorites", order: 1, novelIds: ["backup-9"] }, { id: "new", name: "Reading", order: 2, novelIds: ["backup-9", "broken"] }],
      novelIdMap: new Map([["backup-9", "destination"]]),
    };
    const next = mergeNovelCategories(input);
    expect(next.categories).toHaveLength(2);
    expect(next.assignments["unrelated-book"]).toEqual(["local-category"]);
    expect(next.assignments.destination).toHaveLength(2);
    expect(next.assignments.broken).toBeUndefined();
    const retry = mergeNovelCategories({ ...input, categories: next.categories, assignments: next.assignments });
    expect(retry.categories).toEqual(next.categories);
    expect(retry.assignments).toEqual(next.assignments);
  });
  it("reuses destination IDs and preserves current-only chapters and bookmarks", () => {
    const f = mergeFixture(), next = f.run();
    expect(next.entries.map(x => x.id)).toEqual(["destination"]);
    expect(next.chapters.map(x => x.id)).toEqual(["destination-c1", "destination-c2"]);
    expect(next.bookmarks).toEqual(f.current.bookmarks);
  });
  it("does not regress reading state using an older backup or a source-update timestamp", () => {
    const f = mergeFixture(), next = f.run();
    expect(next.chapters[0].unread).toBe(false);
    expect(next.progress).toEqual(f.current.progress);
  });
  it("accepts newer attributable progress and remaps encoded locators", () => {
    const f = mergeFixture();
    f.restored.progress[0].updatedAt = 300;
    expect(f.run().progress[0]).toMatchObject({ novelId: "destination", chapterId: "destination-c1", locator: "scroll:destination-c1:0.100000", updatedAt: 300 });
  });
  it("keeps progress with an opaque foreign locator and opens the chapter from its start", () => {
    const f = mergeFixture();
    f.restored.progress[0] = { ...f.restored.progress[0], locator: "1", updatedAt: 300 };
    const merged = mergeRestoredNovelsSnapshot({ currentState: f.current, restored: f.restored });
    expect(merged.warnings.map(w => w.code)).not.toContain("LOCATOR_REMAP_UNSUPPORTED");
    expect(merged.state.progress[0]).toMatchObject({ chapterId: "destination-c1", locator: "destination-c1", progressPercent: 0.1, updatedAt: 300 });
  });
  it("keeps current progress when ordering is missing or tied", () => {
    for (const timestamp of [0, 200, NaN]) {
      const f = mergeFixture();
      f.restored.progress[0].updatedAt = timestamp;
      expect(f.run().progress).toEqual(f.current.progress);
    }
  });
  it("keeps identical paths in different plugins separate despite colliding backup IDs", () => {
    const f = mergeFixture();
    f.restored.entries[0].source = { pluginId: "other", sourceId: "other", repositoryUrl: null };
    f.restored.entries[0].id = "destination";
    f.restored.chapters = []; f.restored.progress = [];
    const next = f.run();
    expect(next.entries).toHaveLength(2);
    expect(new Set(next.entries.map(x => x.id)).size).toBe(2);
    expect(next.chapters).toEqual(f.current.chapters);
  });
  it("inserts missing chapters and is stable on retry", () => {
    const f = mergeFixture();
    f.restored.chapters.push({ ...f.restored.chapters[0], id: "backup-c10", path: "/three", order: 2 });
    const next = f.run();
    const retry = applyRestoredNovelsSnapshotToLibraryState({ currentState: next, restored: f.restored });
    expect(next.chapters.map(x => x.path)).toEqual(["/one", "/two", "/three"]);
    expect(retry.entries).toEqual(next.entries);
    expect(retry.chapters).toEqual(next.chapters);
    expect(retry.progress).toEqual(next.progress);
  });
  it("preserves the destination when one incoming Novel has no stable identity", () => {
    const f = mergeFixture();
    f.restored.entries.push({ ...f.restored.entries[0], id: "broken", source: null });
    expect(f.run().entries.map(x => x.id)).toEqual(["destination"]);
  });
});

describe("novels backup state bridge", () => {
  it("builds a repository-aware novels snapshot from authoritative desktop state", () => {
    const snapshot = buildEpigraphNovelsSnapshotFromAuthoritativeState({
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
