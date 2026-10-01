import { describe, expect, it } from "vitest";
import type { Manga, TrackRecord, TrackSearch } from "../types";
import type { BookEntry, BookProgress } from "../books/types";
import {
  bookToRecommendationCandidate,
  bookToTasteProfileSeed,
  mangaToRecommendationCandidate,
  mangaToTasteProfileSeed,
  mergeRecommendationCandidates,
  novelSourceResultToRecommendationCandidate,
  trackRecordSeedStatus,
  trackerSearchToRecommendationCandidate,
} from ".";

describe("recommendation adapters", () => {
  it("converts manga library entries into taste profile seeds", () => {
    const manga = createManga({
      id: 42,
      title: "Dungeon Monarch",
      genre: ["Action", "Dungeon", "Manhwa"],
      unreadCount: 5,
      source: {
        id: "flame",
        name: "Flame Comics",
        displayName: "Flame Comics",
      },
    });

    const seed = mangaToTasteProfileSeed(manga);

    expect(seed.id).toBe("manga:42");
    expect(seed.tags).toEqual(["Action", "Dungeon", "Manhwa"]);
    expect(seed.contentType).toBe("manhwa");
    expect(seed.sourceId).toBe("flame");
    expect(seed.implicitWeight).toBeGreaterThan(0.4);
  });

  it("uses genre heuristics when inferring comic format", () => {
    const seed = mangaToTasteProfileSeed(createManga({
      id: 43,
      title: "Regression Tower",
      genre: ["Action", "Fantasy", "Webtoon"],
      source: {
        id: "any-source",
        name: "Any Source",
        displayName: "Any Source",
      },
    }));

    expect(seed.contentType).toBe("manhwa");
  });

  it("uses title heuristics when genre metadata does not name the comic format", () => {
    const koreanSeed = mangaToTasteProfileSeed(createManga({
      id: 44,
      title: "Tower Returner (Korean)",
      source: {
        id: "source-ko",
        name: "Generic Source",
        displayName: "Generic Source",
      },
    }));
    const chineseSeed = mangaToTasteProfileSeed(createManga({
      id: 45,
      title: "Cultivation Archive (Chinese)",
      source: {
        id: "source-cn",
        name: "Generic Source",
        displayName: "Generic Source",
      },
    }));

    expect(koreanSeed.contentType).toBe("manhwa");
    expect(chineseSeed.contentType).toBe("manhua");
  });

  it("keeps source hits as source-backed candidates", () => {
    const candidate = mangaToRecommendationCandidate(createManga({
      id: 7,
      title: "Ecchi Adventure",
      genre: ["Adventure", "Ecchi"],
      source: {
        id: "asura",
        name: "Asura Scans",
        displayName: "Asura Scans",
      },
    }));

    expect(candidate.id).toBe("manga:7");
    expect(candidate.safety).toBe("suggestive");
    expect(candidate.providers[0]?.kind).toBe("source");
    expect(candidate.providers[0]?.providerName).toBe("Asura Scans");
    expect(candidate.providers[0]?.activity).toBeUndefined();
  });

  it("converts tracker search results without assuming a provider-specific score system", () => {
    const result: TrackSearch = {
      id: 1,
      trackerId: 2,
      remoteId: "remote-1",
      title: "A Tracker Manga",
      coverUrl: "https://example.com/cover.jpg",
      summary: null,
      publishingStatus: "RELEASING",
      publishingType: "MANHWA",
      startDate: "2026-01-01",
      totalChapters: 12,
      trackingUrl: "https://example.com/title",
    };

    const candidate = trackerSearchToRecommendationCandidate(result, {
      trackerNameById: new Map([[2, "AniList"]]),
    });

    expect(candidate.id).toBe("tracker:2:remote-1");
    expect(candidate.contentType).toBe("manhwa");
    expect(candidate.providers[0]?.kind).toBe("tracker");
    expect(candidate.providers[0]?.iconKey).toBe("anilist");
  });

  it("merges matching tracker and source candidates into a single recommendation", () => {
    const sourceCandidate = mangaToRecommendationCandidate(createManga({
      id: 9,
      title: "Shared Title!",
      genre: ["Action"],
    }));
    const trackerCandidate = trackerSearchToRecommendationCandidate({
      id: 1,
      trackerId: 3,
      remoteId: "shared",
      title: "shared title",
      coverUrl: null,
      summary: null,
      publishingStatus: "RELEASING",
      publishingType: "MANGA",
      startDate: null,
      totalChapters: 0,
      trackingUrl: null,
    });

    const merged = mergeRecommendationCandidates([sourceCandidate, trackerCandidate]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.providers.map((provider) => provider.kind).sort()).toEqual(["source", "tracker"]);
  });

  it("keeps tracker-specific comic format when merging generic source hits", () => {
    const sourceCandidate = mangaToRecommendationCandidate(createManga({
      id: 9,
      title: "Shared Title!",
      genre: ["Action"],
      source: {
        id: "comick",
        name: "Comick",
        displayName: "Comick",
      },
    }));
    const trackerCandidate = trackerSearchToRecommendationCandidate({
      id: 1,
      trackerId: 3,
      remoteId: "shared",
      title: "shared title",
      coverUrl: null,
      summary: null,
      publishingStatus: "RELEASING",
      publishingType: "MANHWA",
      startDate: null,
      totalChapters: 0,
      trackingUrl: null,
    });

    const merged = mergeRecommendationCandidates([sourceCandidate, trackerCandidate]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.contentType).toBe("manhwa");
  });

  it("merges candidates when a provider title matches an alternative title", () => {
    const sourceCandidate = {
      ...mangaToRecommendationCandidate(createManga({
        id: 12,
        title: "Solo Leveling",
        genre: ["Action", "Fantasy"],
      })),
      alternativeTitles: ["I Alone Level Up"],
    };
    const trackerCandidate = trackerSearchToRecommendationCandidate({
      id: 1,
      trackerId: 3,
      remoteId: "solo-leveling",
      title: "I Alone Level Up",
      coverUrl: null,
      summary: null,
      publishingStatus: "FINISHED",
      publishingType: "MANHWA",
      startDate: null,
      totalChapters: 0,
      trackingUrl: null,
    });

    const merged = mergeRecommendationCandidates([sourceCandidate, trackerCandidate]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("Solo Leveling");
    expect(merged[0]?.alternativeTitles).toContain("I Alone Level Up");
    expect(merged[0]?.providers.map((provider) => provider.kind).sort()).toEqual(["source", "tracker"]);
  });

  it("preserves real provider recency when duplicate source hits are merged", () => {
    const sourceCandidate = mangaToRecommendationCandidate(createManga({
      id: 9,
      title: "Shared Title!",
      genre: ["Action"],
      source: {
        id: "flame",
        name: "Flame Comics",
        displayName: "Flame Comics",
      },
    }));
    const latestCandidate = {
      ...sourceCandidate,
      providers: sourceCandidate.providers.map((provider) => ({
        ...provider,
        recency: { value: 1, confidence: 0.72, method: "source-latest-feed" },
      })),
    };

    const merged = mergeRecommendationCandidates([sourceCandidate, latestCandidate]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.providers[0]?.recency?.method).toBe("source-latest-feed");
  });

  it("converts local books into prose recommendations without needing a tracker", () => {
    const book = createBook({
      id: "epub-1",
      title: "The Purple Archive",
      author: "Ada Reader",
      subtype: "epub",
      sectionCount: 42,
    });
    const progress: BookProgress = {
      bookId: "epub-1",
      location: null,
      href: null,
      progressPercent: 0.5,
      lastReadAt: Date.now(),
      renderer: "epub",
    };

    const seed = bookToTasteProfileSeed(book, {
      progressByBookId: new Map([["epub-1", progress]]),
    });
    const candidate = bookToRecommendationCandidate(book);

    expect(seed.contentType).toBe("book");
    expect(seed.tags).toContain("epub");
    expect(seed.status).toBe("reading");
    expect(candidate.providers[0]?.kind).toBe("source");
    expect(candidate.tags).toContain("book");
    expect(candidate.tags).not.toContain("author:Ada Reader");
  });

  it("converts LNReader source results into source-backed novel candidates", () => {
    const candidate = novelSourceResultToRecommendationCandidate({
      sourceId: "ln-central",
      title: "The Archive Reader",
      path: "/novel/archive-reader",
      coverUrl: "https://example.com/novel.jpg",
      rating: 4.5,
      ratingMax: 5,
    }, {
      pluginId: "ln-central",
      repositoryId: "repo",
      repositoryUrl: "https://repo.example",
      trustState: "trusted",
      name: "Central Novels",
      lang: "en",
      site: "https://central.example",
      version: "1.0.0",
      iconUrl: null,
      artifactUrl: "https://repo.example/plugin.js",
      artifactPath: "plugin.js",
      enabled: true,
    });

    expect(candidate.id).toBe("novel-source:ln-central:%2Fnovel%2Farchive-reader");
    expect(candidate.contentType).toBe("novel");
    expect(candidate.inLibrary).toBe(false);
    expect(candidate.providers[0]?.kind).toBe("source");
    expect(candidate.providers[0]?.providerName).toBe("Central Novels");
    expect(candidate.providers[0]?.score?.value).toBe(0.9);
    expect(candidate.providers[0]?.activity).toBeUndefined();
  });

  it("does not read the comic format out of ordinary synopsis words", () => {
    const seed = mangaToTasteProfileSeed(createManga({
      id: 46,
      title: "Detective Investigates the Ecosystem",
      description: "A player joins the school system and passes through the gate of a hunter's tower.",
      genre: ["Mystery", "School Life"],
      source: {
        id: "source-generic",
        name: "Generic Source",
        displayName: "Generic Source",
      },
    }));

    expect(seed.contentType).toBe("manga");
  });

  it("needs several manhwa tropes as genre tags before inferring manhwa", () => {
    const singleTrope = mangaToTasteProfileSeed(createManga({
      id: 47,
      title: "Isekai Dungeon Diary",
      genre: ["Fantasy", "Dungeon"],
      source: { id: "source-a", name: "Generic Source", displayName: "Generic Source" },
    }));
    const tropeStack = mangaToTasteProfileSeed(createManga({
      id: 48,
      title: "Returned Ranker",
      genre: ["Action", "Regression", "Tower", "Hunter"],
      source: { id: "source-b", name: "Generic Source", displayName: "Generic Source" },
    }));

    expect(singleTrope.contentType).toBe("manga");
    expect(tropeStack.contentType).toBe("manhwa");
  });

  it("takes the library seed reading status from the tracker, not the publication status", () => {
    const manga = createManga({
      id: 49,
      title: "Finished Series",
      status: "COMPLETED",
      genre: ["Drama"],
    });
    const record = createTrackRecord({ id: 1, trackerId: 2, status: 4, score: 3, lastChapterRead: 12 });

    const untracked = mangaToTasteProfileSeed(manga);
    const dropped = mangaToTasteProfileSeed(manga, {
      trackRecordsByMangaId: new Map([[49, [record]]]),
      trackerStatusNamesById: new Map([[2, new Map([[4, "Dropped"]])]]),
    });

    expect(untracked.status).toBe("unknown");
    expect(dropped.status).toBe("dropped");
  });

  it("maps tracker status names and ignores empty finish dates", () => {
    const inProgress = createTrackRecord({ lastChapterRead: 30, totalChapters: 100, finishDate: "0" });

    expect(trackRecordSeedStatus(inProgress, "Plan to Read")).toBe("planning");
    expect(trackRecordSeedStatus(inProgress, "Dropped")).toBe("dropped");
    expect(trackRecordSeedStatus(inProgress, "Completed")).toBe("completed");
    expect(trackRecordSeedStatus(inProgress)).toBe("reading");
    expect(trackRecordSeedStatus({ ...inProgress, finishDate: "1767225600000" })).toBe("completed");
    expect(trackRecordSeedStatus({ ...inProgress, lastChapterRead: 0 })).toBe("planning");
  });
});

function createManga(patch: Partial<Manga>): Manga {
  return {
    id: 1,
    title: "Title",
    thumbnailUrl: "",
    inLibrary: true,
    genre: [],
    source: null,
    ...patch,
  };
}

function createBook(patch: Partial<BookEntry>): BookEntry {
  return {
    id: "book-1",
    title: "Book",
    author: null,
    description: null,
    coverPath: null,
    subtype: "epub",
    createdAt: 0,
    updatedAt: 0,
    importPath: "book.epub",
    assetPath: "book.epub",
    sectionCount: 0,
    ...patch,
  };
}

function createTrackRecord(patch: Partial<TrackRecord>): TrackRecord {
  return {
    id: 1,
    trackerId: 1,
    remoteId: "remote-1",
    title: "Tracked",
    status: 1,
    score: 0,
    displayScore: "",
    lastChapterRead: 0,
    totalChapters: 0,
    remoteUrl: null,
    startDate: null,
    finishDate: null,
    private: false,
    ...patch,
  };
}
