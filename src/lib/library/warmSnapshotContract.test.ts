import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../App.svelte", import.meta.url), "utf8");
const librarySource = readFileSync(new URL("../../components/pages/Library.svelte", import.meta.url), "utf8");

describe("Library warm snapshot reconciliation", () => {
  it("does not let persisted categories bypass the live profile fetch", () => {
    const hydrationStart = appSource.indexOf("setCategories(attachKnownCategoryMembers(");
    const hydrationEnd = appSource.indexOf("setLibraryTrackingSummarySnapshot", hydrationStart);
    const hydration = appSource.slice(hydrationStart, hydrationEnd);

    expect(hydrationStart).toBeGreaterThanOrEqual(0);
    expect(hydrationEnd).toBeGreaterThan(hydrationStart);
    expect(hydration).toContain("setCategories(attachKnownCategoryMembers(");
    expect(hydration).toContain("cache.clear(CACHE_KEYS.CATEGORIES)");
  });

  it("renders the genre divider only when user folders precede it", () => {
    expect(librarySource).toMatch(
      /\{#if activeGenreChips\.length\}\s+\{#if heroUserCollections\.length\}\s+<div class="chip-divider"/,
    );
  });

  it("does not animate genre chip typography when switching library sections", () => {
    const genreChipRule = librarySource.match(/\.library-genre-chip\s*\{(?<body>[\s\S]*?)\n\s*\}/)?.groups?.body ?? "";

    expect(genreChipRule).toContain(
      "transition-property: background-color, border-color, color, box-shadow, transform, opacity;",
    );
    expect(genreChipRule).not.toMatch(/transition(?:-property)?:\s*all/);
  });
});
