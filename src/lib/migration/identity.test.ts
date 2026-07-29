import { describe, expect, it } from "vitest";
import {
  migrationIdentityMatchesSlice,
  prepareMangaIdentityMigration,
  prepareNovelIdentityMigration,
  restoreMigrationIdentitySlice,
  type MigrationIdentitySettings,
} from "./identity";

function settings(): MigrationIdentitySettings {
  return {
    mangaLinks: {
      1: [3],
      2: [4],
      3: [1],
      4: [2],
    },
    novelLinks: {
      old: ["related"],
      target: ["edition"],
      related: ["old"],
      edition: ["target"],
    },
    booksCategoryAssignments: {
      old: ["favorites", "reading"],
      target: ["reading", "translated"],
    },
  };
}

describe("migration local identity", () => {
  it("moves symmetric manga links and can restore the previous slice", () => {
    const current = settings();
    const prepared = prepareMangaIdentityMigration({
      current,
      sourceMangaId: 1,
      targetMangaId: 2,
      mode: "migrate",
    });

    expect(prepared.next.mangaLinks[1]).toBeUndefined();
    expect(prepared.next.mangaLinks[2]).toEqual(expect.arrayContaining([3, 4]));
    expect(prepared.next.mangaLinks[3]).toContain(2);
    expect(prepared.next.mangaLinks[3]).not.toContain(1);
    expect(migrationIdentityMatchesSlice(prepared.next, prepared.applied)).toBe(true);
    expect(restoreMigrationIdentitySlice(prepared.next, prepared.previous).mangaLinks)
      .toEqual(current.mangaLinks);
  });

  it("copies manga links without removing the source relationships", () => {
    const prepared = prepareMangaIdentityMigration({
      current: settings(),
      sourceMangaId: 1,
      targetMangaId: 2,
      mode: "copy",
    });

    expect(prepared.next.mangaLinks[1]).toEqual(expect.arrayContaining([2, 3]));
    expect(prepared.next.mangaLinks[2]).toEqual(expect.arrayContaining([1, 3, 4]));
    expect(prepared.next.mangaLinks[3]).toEqual(expect.arrayContaining([1, 2]));
  });

  it("moves novel links and unions folders without losing target assignments", () => {
    const current = settings();
    const prepared = prepareNovelIdentityMigration({
      current,
      sourceNovelId: "old",
      targetNovelId: "target",
    });

    expect(prepared.next.novelLinks.old).toBeUndefined();
    expect(prepared.next.novelLinks.target).toEqual(expect.arrayContaining(["related", "edition"]));
    expect(prepared.next.novelLinks.related).toContain("target");
    expect(prepared.next.booksCategoryAssignments.old).toBeUndefined();
    expect(prepared.next.booksCategoryAssignments.target).toEqual([
      "reading",
      "translated",
      "favorites",
    ]);
    expect(restoreMigrationIdentitySlice(prepared.next, prepared.previous))
      .toEqual(current);
  });

  it("detects a changed value inside an affected identity map", () => {
    const prepared = prepareNovelIdentityMigration({
      current: settings(),
      sourceNovelId: "old",
      targetNovelId: "target",
    });
    const changed = {
      ...prepared.next,
      novelLinks: {
        ...prepared.next.novelLinks,
        target: ["different"],
      },
    };

    expect(migrationIdentityMatchesSlice(changed, prepared.applied)).toBe(false);
  });
});
