import { describe, expect, test } from "vitest";
import { buildShareText, escapeShareTitle, shareableUrl, shareCollageLayout } from "./sharePayload";

describe("library share list", () => {
  test("links each title to its page without chat previews", () => {
    expect(buildShareText([
      { title: "One Piece", url: "https://example.com/manga/one-piece" },
      { title: "Berserk", url: "https://example.com/manga/berserk?id=2" },
    ])).toBe([
      "- [One Piece](<https://example.com/manga/one-piece>)",
      "- [Berserk](<https://example.com/manga/berserk?id=2>)",
    ].join("\n"));
  });

  test("keeps works without a web address as plain titles", () => {
    expect(buildShareText([
      { title: "Local work", url: null },
      { title: "Core work", url: "/manga/12" },
      { title: "Script", url: "javascript:alert(1)" },
    ])).toBe("- Local work\n- Core work\n- Script");
  });

  test("escapes titles that would break the link", () => {
    expect(escapeShareTitle("  [Oshi no Ko]  *Season* 2 ")).toBe("\\[Oshi no Ko\\] \\*Season\\* 2");
    expect(buildShareText([{ title: "   ", url: "https://example.com" }])).toBe("");
  });

  test("accepts only http and https addresses", () => {
    expect(shareableUrl(" https://example.com/a b ")).toBe("https://example.com/a%20b");
    expect(shareableUrl("http://example.com")).toBe("http://example.com/");
    expect(shareableUrl("file:///C:/x")).toBeNull();
    expect(shareableUrl("")).toBeNull();
  });
});

describe("library share image layout", () => {
  test("places a few works in one row", () => {
    expect(shareCollageLayout(1)).toEqual({ columns: 1, rows: 1, covers: 1, overflow: 0 });
    expect(shareCollageLayout(3)).toEqual({ columns: 3, rows: 1, covers: 3, overflow: 0 });
    expect(shareCollageLayout(4)).toEqual({ columns: 4, rows: 1, covers: 4, overflow: 0 });
  });

  test("forms a landscape grid for larger selections", () => {
    expect(shareCollageLayout(6)).toMatchObject({ columns: 3, rows: 2 });
    expect(shareCollageLayout(8)).toMatchObject({ columns: 4, rows: 2 });
    const layout = shareCollageLayout(20);
    expect(layout.columns * layout.rows).toBeGreaterThanOrEqual(20);
    expect(layout.columns).toBeLessThanOrEqual(8);
  });

  test("keeps the last cell for the count of works left out", () => {
    expect(shareCollageLayout(100, 40)).toEqual({ columns: 8, rows: 5, covers: 39, overflow: 61 });
    expect(shareCollageLayout(0)).toEqual({ columns: 0, rows: 0, covers: 0, overflow: 0 });
  });
});
