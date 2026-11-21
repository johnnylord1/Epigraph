import { describe, expect, test } from "vitest";
import { notFoundWorkTitle, notFoundWorkViews } from "./syncdNotFoundWorks";

describe("works this computer could not find", () => {
  test("are titled from the last segment of the source's key", () => {
    expect(notFoundWorkTitle("/series/return-of-the-apocalypse-class-death-knight")).toBe("Return of the apocalypse class death knight");
    expect(notFoundWorkTitle("/manga/what-happens-inside-the-dungeon/")).toBe("What happens inside the dungeon");
    expect(notFoundWorkTitle("/manga/some_title?id=3")).toBe("Some title");
  });

  test("drop the id segments sources add to keep keys unique", () => {
    expect(notFoundWorkTitle("/e13w8-shadow-slave")).toBe("Shadow slave");
    expect(notFoundWorkTitle("/series/solo-leveling-a1b2c3d4")).toBe("Solo leveling");
    expect(notFoundWorkTitle("/title/12345")).toBe("12345");
  });

  test("keep the raw key when it has no readable segment", () => {
    expect(notFoundWorkTitle("/")).toBe("/");
    expect(notFoundWorkTitle("x9")).toBe("X9");
  });

  test("name the installed source, or none when this computer lacks it", () => {
    const views = notFoundWorkViews(
      [
        { sourceId: "6247824327199706550", mangaKey: "/series/a-title", changes: 3 },
        { sourceId: "7537715367149829912", mangaKey: "/e13w8-shadow-slave", changes: 1 },
      ],
      new Map([["6247824327199706550", "Asura Scans (EN)"]]),
    );
    expect(views).toEqual([
      { key: "6247824327199706550:/series/a-title", title: "A title", sourceName: "Asura Scans (EN)", changes: 3 },
      { key: "7537715367149829912:/e13w8-shadow-slave", title: "Shadow slave", sourceName: null, changes: 1 },
    ]);
  });
});
