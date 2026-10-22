import { describe, expect, it } from "vitest";
import { encodeMihonImportBackup, parseMihonBackup, type MihonImportWork } from "./mihonBackup";

const work: MihonImportWork = {
  sourceId: "2499283573021220255",
  url: "/manga/a",
  title: "A",
  author: "Author",
  artist: null,
  genre: ["Action"],
  status: "COMPLETED",
  dateAdded: 1_700_000_000_000,
  chapters: [
    {
      url: "/c/1",
      name: "Chapter 1",
      scanlator: null,
      isRead: true,
      isBookmarked: false,
      lastPageRead: 0,
      fetchedAt: 1_700_000_001_000,
      uploadDate: 1_690_000_000_000,
      chapterNumber: 1.5,
      sourceOrder: 2,
    },
    {
      url: "/c/2",
      name: "Chapter 2",
      scanlator: "Team",
      isRead: false,
      isBookmarked: true,
      lastPageRead: 7,
      fetchedAt: 0,
      uploadDate: 0,
      chapterNumber: 2,
      sourceOrder: 1,
    },
  ],
};

describe("encodeMihonImportBackup", () => {
  it("writes a gzip backup with the works in the library and their chapter progress", async () => {
    const bytes = new Uint8Array(encodeMihonImportBackup([work]));
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);

    const parsed = await parseMihonBackup(bytes, []);
    expect(parsed.backupManga).toHaveLength(1);
    expect(parsed.backupManga[0]).toMatchObject({ sourceId: work.sourceId, url: "/manga/a", title: "A", author: "Author" });
    const manga = parsed.mangaMessages[0] as any;
    expect(manga.favorite).toBe(true);
    expect(manga.status).toBe(2);
    expect(manga.description ?? "").toBe("");
    expect(manga.thumbnailUrl ?? "").toBe("");
    expect(String(manga.dateAdded)).toBe("1700000000000");
    expect(manga.categories ?? []).toHaveLength(0);
    const [first, second] = manga.chapters;
    expect(first).toMatchObject({ url: "/c/1", read: true, chapterNumber: 1.5 });
    expect(String(first.dateFetch)).toBe("1700000001000");
    expect(String(first.sourceOrder)).toBe("2");
    expect(second).toMatchObject({ url: "/c/2", scanlator: "Team", bookmark: true });
    expect(String(second.lastPageRead)).toBe("7");
  });
});
