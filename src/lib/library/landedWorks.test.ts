import { describe, expect, it } from "vitest";
import { patchLibraryWorks } from "./landedWorks";
import type { Manga } from "../types";

const work = (id: number, extra: Partial<Manga> = {}) =>
  ({ id, title: `Work ${id}`, inLibrary: true, chapterCount: 1, ...extra }) as Manga;

describe("patchLibraryWorks", () => {
  it("updates a work where it stands and leaves the others alone", () => {
    const first = work(1);
    const third = work(3);
    const patched = patchLibraryWorks([first, work(2), third], [2], [
      work(2, { unreadCount: 7, chapters: { totalCount: 40 } } as Partial<Manga>),
    ]);
    expect(patched.map((manga) => manga.id)).toEqual([1, 2, 3]);
    expect(patched[1]).toMatchObject({ unreadCount: 7, chapterCount: 40 });
    expect(patched[0]).toBe(first);
    expect(patched[2]).toBe(third);
  });

  it("adds a work the library did not have", () => {
    const patched = patchLibraryWorks([work(1)], [9], [work(9, { chapters: { totalCount: 3 } } as Partial<Manga>)]);
    expect(patched.map((manga) => manga.id)).toEqual([1, 9]);
    expect(patched[1].chapterCount).toBe(3);
  });

  it("removes a work that left the library or no longer exists", () => {
    const patched = patchLibraryWorks([work(1), work(2), work(3)], [1, 2], [work(1, { inLibrary: false })]);
    expect(patched.map((manga) => manga.id)).toEqual([3]);
  });

  it("does not add a work outside the library or one nobody asked about", () => {
    const patched = patchLibraryWorks([work(1)], [5], [work(5, { inLibrary: false }), work(6)]);
    expect(patched.map((manga) => manga.id)).toEqual([1]);
  });

  it("keeps what only the library knew when the read does not bring it", () => {
    const patched = patchLibraryWorks([work(1, { chapterCount: 12, unreadCount: 4 })], [1], [work(1, { chapterCount: undefined })]);
    expect(patched[0].chapterCount).toBe(12);
    expect(patched[0].unreadCount).toBe(4);
  });

  it("fills in a new work's chapter count as zero when nothing says otherwise", () => {
    const patched = patchLibraryWorks([], [1], [work(1, { chapterCount: undefined })]);
    expect(patched).toHaveLength(1);
    expect(patched[0].chapterCount).toBe(0);
  });
});
