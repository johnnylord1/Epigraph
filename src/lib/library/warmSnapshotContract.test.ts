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

  it("sizes genre chips to their label at one readable size instead of squeezing long genres", () => {
    const genreChipRule = librarySource.match(/\.library-genre-chip\s*\{(?<body>[\s\S]*?)\n\s*\}/)?.groups?.body ?? "";
    const labelRule = librarySource.match(/\.library-genre-chip__label\s*\{(?<body>[\s\S]*?)\n\s*\}/)?.groups?.body ?? "";

    expect(genreChipRule).toContain("flex: 0 0 auto;");
    expect(genreChipRule).not.toMatch(/cqw|width: var\(/);
    expect(librarySource).not.toMatch(/\.library-genre-chip\.fit-(?:sm|xs)/);
    expect(labelRule).toContain("text-overflow: ellipsis;");
    expect(librarySource).toContain('<span class="library-genre-chip__label">{genreDisplayLabel(chip.label, currentAppLocale())}</span>');
    expect(librarySource).toContain('title={`${genreDisplayLabel(chip.label, currentAppLocale())} (${chip.count})`}');
  });

  it("turns a vertical mouse wheel over the genre row into sideways scrolling until an end is reached", () => {
    const wheelStart = librarySource.indexOf("function handleGenreWheel(event: WheelEvent)");
    const wheel = librarySource.slice(wheelStart, librarySource.indexOf("\n  }", wheelStart));

    expect(librarySource).toMatch(/onscroll=\{updateGenreOverflow\}\s+onwheel=\{handleGenreWheel\}/);
    expect(wheel).toContain("Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;");
    expect(wheel).toContain("(delta > 0 && el.scrollLeft >= max - 1)) return;");
    expect(wheel).toContain("event.preventDefault();");
    expect(wheel).toContain("el.scrollLeft = Math.min(max, Math.max(0, el.scrollLeft + delta));");
  });
});
