import { describe, expect, it } from "vitest";

import {
  buildCompletedLibraryIds,
  collectTrackedChapterTotalsByMangaId,
  collectTrackedCompletedMangaIds,
  hasSatisfiedTrackedChapterTotal,
  isLibraryReadCompleted,
  isMangaFinishedReading,
  isMangaPublicationCompleted,
  isSourceCompletedStatus,
  isTrackerCompletedStatusName,
} from "./completion";

describe("completion helpers", () => {
  it("treats both completed and complete as completed source statuses", () => {
    expect(isSourceCompletedStatus("COMPLETED")).toBe(true);
    expect(isSourceCompletedStatus("Complete")).toBe(true);
    expect(isSourceCompletedStatus("Ongoing")).toBe(false);
  });

  it("recognizes completed tracker labels across trackers", () => {
    expect(isTrackerCompletedStatusName("Completed")).toBe(true);
    expect(isTrackerCompletedStatusName("Complete List")).toBe(true);
    expect(isTrackerCompletedStatusName("Reading")).toBe(false);
  });

  it("collects only in-library manga ids with tracker completed statuses", () => {
    const ids = collectTrackedCompletedMangaIds([
      {
        isLoggedIn: true,
        statuses: [
          { value: 1, name: "Reading" },
          { value: 2, name: "Completed" },
        ],
        trackRecords: {
          nodes: [
            { status: 2, manga: { id: 10, inLibrary: true } },
            { status: 1, manga: { id: 11, inLibrary: true } },
            { status: 2, manga: { id: 12, inLibrary: false } },
          ],
        },
      },
      {
        isLoggedIn: true,
        statuses: [
          { value: 4, name: "Complete List" },
        ],
        trackRecords: {
          nodes: [
            { status: 4, manga: { id: 13, inLibrary: true } },
          ],
        },
      },
    ]);

    expect([...ids].sort((a, b) => a - b)).toEqual([10, 13]);
  });

  it("tracks the highest known tracker chapter total per manga", () => {
    const totals = collectTrackedChapterTotalsByMangaId([
      {
        isLoggedIn: true,
        statuses: [],
        trackRecords: {
          nodes: [
            { status: 2, totalChapters: 20, manga: { id: 10, inLibrary: true } },
            { status: 2, totalChapters: 25, manga: { id: 10, inLibrary: true } },
            { status: 2, totalChapters: 12, manga: { id: 11, inLibrary: false } },
          ],
        },
      },
    ]);

    expect(totals.get(10)).toBe(25);
    expect(totals.has(11)).toBe(false);
  });

  it("treats publication completion as source or tracking driven only", () => {
    expect(
      isMangaPublicationCompleted(
        { id: 1, status: "Completed" },
        new Set(),
      ),
    ).toBe(true);

    expect(
      isMangaPublicationCompleted(
        { id: 2, status: "Ongoing" },
        new Set([2]),
      ),
    ).toBe(true);

    expect(
      isMangaPublicationCompleted(
        { id: 3, status: "Unknown" },
        new Set(),
      ),
    ).toBe(false);
  });

  it("requires library completion plus source or tracking confirmation", () => {
    expect(isLibraryReadCompleted({ chapterCount: 12, unreadCount: 0 })).toBe(true);

    expect(
      isMangaFinishedReading(
        { id: 1, status: "Completed", chapterCount: 12, unreadCount: 0 },
        new Set(),
      ),
    ).toBe(true);

    expect(
      isMangaFinishedReading(
        { id: 2, status: "Completed", chapterCount: 12, unreadCount: 4 },
        new Set(),
      ),
    ).toBe(false);

    expect(
      isMangaFinishedReading(
        { id: 3, status: "Ongoing", chapterCount: 12, unreadCount: 4 },
        new Set([3]),
      ),
    ).toBe(false);

    expect(
      isMangaFinishedReading(
        { id: 4, status: "Ongoing", chapterCount: 12, unreadCount: 0 },
        new Set([4]),
      ),
    ).toBe(true);

    expect(
      isMangaFinishedReading(
        { id: 5, status: "Unknown", chapterCount: 12, unreadCount: 0 },
        new Set([5]),
      ),
    ).toBe(true);

    expect(
      isMangaFinishedReading(
        { id: 6, status: "Unknown", chapterCount: 12, unreadCount: 0 },
        new Set(),
      ),
    ).toBe(false);

    expect(
      isMangaFinishedReading(
        { id: 7, status: "Completed", chapterCount: 20, unreadCount: 0 },
        new Set(),
        new Map([[7, 25]]),
      ),
    ).toBe(false);

    expect(
      hasSatisfiedTrackedChapterTotal(
        { id: 8, chapterCount: 20 },
        new Map([[8, 20]]),
      ),
    ).toBe(true);
  });

  it("builds completed ids from category membership plus source/read/tracking signals", () => {
    const ids = buildCompletedLibraryIds(
      [
        {
          id: 1,
          title: "Read Complete",
          thumbnailUrl: "",
          inLibrary: true,
          chapterCount: 5,
          unreadCount: 0,
          status: "Ongoing",
        },
        {
          id: 2,
          title: "Source Complete",
          thumbnailUrl: "",
          inLibrary: true,
          chapterCount: 5,
          unreadCount: 0,
          status: "Completed",
        },
        {
          id: 3,
          title: "Tracking Complete",
          thumbnailUrl: "",
          inLibrary: true,
          chapterCount: 5,
          unreadCount: 0,
          status: "Ongoing",
        },
        {
          id: 4,
          title: "Already Categorized",
          thumbnailUrl: "",
          inLibrary: true,
          chapterCount: 5,
          unreadCount: 0,
          status: "Unknown",
        },
      ],
      [
        {
          id: 4,
          title: "Already Categorized",
          thumbnailUrl: "",
          inLibrary: true,
        },
      ],
      new Set([3]),
      new Map([
        [2, 5],
        [3, 5],
        [4, 6],
      ]),
    );

    expect([...ids].sort((a, b) => a - b)).toEqual([2, 3]);
  });
});
