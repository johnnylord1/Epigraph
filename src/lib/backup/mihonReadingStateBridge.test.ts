import { describe, expect, it } from "vitest";
import pako from "pako";
import protobuf from "protobufjs";
import { parseMihonBackup } from "./mihonBackup";
import { extractMihonReadingStateForSync } from "./mihonReadingStateBridge";
import { MIHON_BACKUP_PROTO } from "./mihonProto";

const root = protobuf.parse(MIHON_BACKUP_PROTO).root;
const BackupType = root.lookupType("Backup");

describe("mihon reading state bridge", () => {
  it("extracts progress and bookmarks from Mihon/Tachiyomi chapter state", () => {
    const result = extractMihonReadingStateForSync({
      mangaMessages: [
        {
          source: "123",
          url: "/series/nano-machine",
          title: "Nano Machine",
          chapters: [
            {
              url: "/chapter-1",
              name: "Chapter 1",
              chapterNumber: 1,
              sourceOrder: "2",
              lastPageRead: "17",
              read: false,
              bookmark: true,
              lastModifiedAt: "1700000000000",
            },
            {
              url: "/chapter-2",
              name: "Chapter 2",
              chapterNumber: 2,
              sourceOrder: "1",
              lastPageRead: "0",
              bookmark: false,
            },
          ],
        },
      ],
    });

    expect(result.warnings).toEqual([]);
    expect(result.progress).toEqual([
      expect.objectContaining({
        entityId: "mihon:123:/series/nano-machine:chapter:/chapter-1:progress",
        sourceId: "123",
        mangaUrl: "/series/nano-machine",
        mangaTitle: "Nano Machine",
        chapterUrl: "/chapter-1",
        chapterName: "Chapter 1",
        chapterNumber: 1,
        lastPageRead: 17,
        read: false,
        lastModifiedAtMs: 1700000000000,
      }),
    ]);
    expect(result.bookmarks).toEqual([
      expect.objectContaining({
        entityId: "mihon:123:/series/nano-machine:chapter:/chapter-1:bookmark",
        chapterUrl: "/chapter-1",
        bookmarked: true,
      }),
    ]);
  });

  it("dedupes equivalent chapter state deterministically", () => {
    const result = extractMihonReadingStateForSync({
      mangaMessages: [
        {
          source: "999",
          url: "/manga/solo",
          title: "Solo",
          chapters: [
            {
              url: "/c2",
              name: "Chapter 2",
              chapterNumber: 2,
              lastPageRead: "4",
              bookmark: true,
              lastModifiedAt: "100",
            },
            {
              url: "/c2",
              name: "Chapter 2",
              chapterNumber: 2,
              lastPageRead: "12",
              bookmark: true,
              lastModifiedAt: "200",
            },
          ],
        },
      ],
    });

    expect(result.progress).toHaveLength(1);
    expect(result.progress[0]).toEqual(expect.objectContaining({
      entityId: "mihon:999:/manga/solo:chapter:/c2:progress",
      lastPageRead: 12,
      lastModifiedAtMs: 200,
    }));
    expect(result.bookmarks).toHaveLength(1);
    expect(result.bookmarks[0]).toEqual(expect.objectContaining({
      entityId: "mihon:999:/manga/solo:chapter:/c2:bookmark",
      lastModifiedAtMs: 200,
    }));
  });

  it("uses fallback chapter identity fields when chapter url is missing", () => {
    const result = extractMihonReadingStateForSync({
      mangaMessages: [
        {
          source: "123",
          url: "/series/fallback",
          title: "Fallback",
          chapters: [
            {
              name: "Special Chapter",
              chapterNumber: 9.5,
              lastPageRead: 3,
            },
            {
              chapterNumber: 10,
              bookmark: true,
            },
          ],
        },
      ],
    });

    expect(result.warnings).toEqual([]);
    expect(result.progress[0]?.entityId).toBe("mihon:123:/series/fallback:chapter:special chapter:progress");
    expect(result.bookmarks[0]?.entityId).toBe("mihon:123:/series/fallback:chapter:10:bookmark");
  });

  it("warns without emitting state for missing manga or chapter identity", () => {
    const result = extractMihonReadingStateForSync({
      mangaMessages: [
        {
          source: "",
          url: "",
          title: "No Identity",
          chapters: [{ url: "/c1", lastPageRead: 1 }],
        },
        {
          source: "123",
          url: "/series/no-chapter-id",
          title: "No Chapter ID",
          chapters: [{ lastPageRead: 8, bookmark: true }],
        },
      ],
    });

    expect(result.progress).toEqual([]);
    expect(result.bookmarks).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ kind: "missing-manga-identity", mangaTitle: "No Identity" }),
      expect.objectContaining({ kind: "missing-chapter-identity", mangaTitle: "No Chapter ID" }),
    ]);
  });

  it("works from the existing Mihon backup parser output", async () => {
    const payload = BackupType.encode({
      backupManga: [
        {
          source: "2499283573021220255",
          url: "/title/from-backup",
          title: "From Backup",
          chapters: [
            {
              url: "/chapter-7",
              name: "Chapter 7",
              chapterNumber: 7,
              lastPageRead: "21",
              bookmark: true,
              lastModifiedAt: "1710000000000",
            },
          ],
        },
      ],
      backupSources: [
        { name: "MangaDex", sourceId: "2499283573021220255" },
      ],
    }).finish();

    const parsed = await parseMihonBackup(pako.gzip(payload), [
      {
        sourceId: "2499283573021220255",
        name: "MangaDex",
        lang: "en",
        displayName: "MangaDex",
        kind: "installed",
        extensionPkgName: null,
        extensionName: null,
        extensionInstalled: true,
      },
    ]);
    const result = extractMihonReadingStateForSync(parsed);

    expect(result.progress[0]).toEqual(expect.objectContaining({
      entityId: "mihon:2499283573021220255:/title/from-backup:chapter:/chapter-7:progress",
      lastPageRead: 21,
    }));
    expect(result.bookmarks[0]).toEqual(expect.objectContaining({
      entityId: "mihon:2499283573021220255:/title/from-backup:chapter:/chapter-7:bookmark",
    }));
  });
});
