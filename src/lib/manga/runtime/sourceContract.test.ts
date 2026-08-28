import { describe, expect, test, vi } from "vitest";

import {
  CompatibilityProfileV21,
  CompatibilityProfileV23,
  type CompatibilityProfile,
} from "./compatibility";
import { runDeterministicSourceContract } from "./sourceContract";
import type {
  SourceRuntime,
  SourceSearchInput,
} from "./types";

const SOURCE = {
  id: "42",
  name: "Fixture",
  displayName: "Fixture (EN)",
  language: "en",
  iconUrl: null,
  isNsfw: false,
  supportsLatest: true,
  isConfigurable: false,
  extensionPackageName: "fixture.extension",
} as const;

const SEARCH_ITEM = {
  id: 7,
  sourceId: SOURCE.id,
  title: "Epigraph Certification",
  thumbnailUrl: null,
  inLibrary: false,
  status: "ONGOING",
  source: SOURCE,
} as const;

function profileFixtures(profile: CompatibilityProfile) {
  return {
    search: profile.operations.search.decode({
      fetchSourceManga: {
        mangas: [{
          id: SEARCH_ITEM.id,
          title: SEARCH_ITEM.title,
          thumbnailUrl: null,
          inLibrary: false,
          status: "ONGOING",
          source: {
            id: SOURCE.id,
            name: SOURCE.name,
            displayName: SOURCE.displayName,
            lang: SOURCE.language,
            iconUrl: null,
            isNsfw: false,
            supportsLatest: true,
            isConfigurable: false,
            extension: { pkgName: SOURCE.extensionPackageName },
          },
        }],
        hasNextPage: true,
      },
    }),
    details: profile.operations.details.decode({
      fetchManga: {
        manga: {
          id: SEARCH_ITEM.id,
          title: SEARCH_ITEM.title,
          thumbnailUrl: null,
          inLibrary: false,
          status: "ONGOING",
          description: "Deterministic fixture",
          author: "Epigraph",
          artist: null,
          genre: ["Certification"],
          realUrl: "/fixture",
          source: {
            id: SOURCE.id,
            name: SOURCE.name,
            displayName: SOURCE.displayName,
            lang: SOURCE.language,
            iconUrl: null,
            isNsfw: false,
            supportsLatest: true,
            isConfigurable: false,
            extension: { pkgName: SOURCE.extensionPackageName },
          },
        },
      },
    }),
    chapters: profile.operations.chapters.decode({
      fetchChapters: {
        chapters: [{
          id: 9,
          mangaId: SEARCH_ITEM.id,
          name: "Chapter 1",
          chapterNumber: 1,
          sourceOrder: 1,
          isRead: false,
          isDownloaded: false,
          isBookmarked: false,
          pageCount: 1,
          uploadDate: null,
          realUrl: "/fixture/chapter-1",
          lastPageRead: 0,
          scanlator: null,
        }],
      },
    }),
    pages: profile.operations.pages.decode({
      fetchChapterPages: {
        pages: ["http://127.0.0.1:9876/page-1.png"],
      },
    }),
  };
}

function fixtureRuntime(profile: CompatibilityProfile) {
  const fixtures = profileFixtures(profile);
  const signal = new AbortController().signal;
  const search = vi.fn(async (input: SourceSearchInput) => (
    input.page === 1
      ? fixtures.search
      : { items: [], hasNextPage: false }
  ));
  const runtime = {
    search,
    getDetails: vi.fn(async () => fixtures.details),
    getChapters: vi.fn(async () => fixtures.chapters),
    getPages: vi.fn(async () => fixtures.pages),
  } as unknown as SourceRuntime;
  return { runtime, search, signal };
}

describe.each([
  new CompatibilityProfileV21(),
  new CompatibilityProfileV23(),
])("deterministic source contract ($id)", (profile) => {
  test("preserves DTO identity, pagination and cancellation signals", async () => {
    const { runtime, search, signal } = fixtureRuntime(profile);

    await expect(runDeterministicSourceContract(runtime, {
      sourceId: SOURCE.id,
      query: SEARCH_ITEM.title,
      expectedTitle: SEARCH_ITEM.title,
      signal,
    })).resolves.toEqual({
      sourceId: SOURCE.id,
      mangaId: SEARCH_ITEM.id,
      chapterId: 9,
      pageCount: 1,
      paginationObserved: true,
    });
    expect(search).toHaveBeenNthCalledWith(1, expect.objectContaining({
      mode: "SEARCH",
      page: 1,
      signal,
    }));
    expect(search).toHaveBeenNthCalledWith(2, expect.objectContaining({
      mode: "SEARCH",
      page: 2,
      signal,
    }));
  });
});

test("rejects repeated identities across pages", async () => {
  const { runtime } = fixtureRuntime(new CompatibilityProfileV23());
  runtime.search = vi.fn(async () => profileFixtures(
    new CompatibilityProfileV23(),
  ).search);

  await expect(runDeterministicSourceContract(runtime, {
    sourceId: SOURCE.id,
    query: SEARCH_ITEM.title,
    expectedTitle: SEARCH_ITEM.title,
  })).rejects.toMatchObject({
    code: "RUNTIME_INCOMPATIBLE",
    details: { contractStage: "pagination" },
  });
});
