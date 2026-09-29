import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROSE_READER_SETTING_KEYS,
  READER_BRIGHTNESS_SETTING_KEY,
  seedSplitReaderSettings,
} from "./readerSettingsScope";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("per-reader settings", () => {
  it("seeds book and novel keys from the old shared values without overwriting", () => {
    const legacy = {
      readerZoom: 0.6,
      readerBrightness: 0.4,
      proseReaderFontSize: 22,
      proseReaderTheme: "sepia",
      proseReaderFullWidth: true,
    };
    const seeded = seedSplitReaderSettings(legacy) as Record<string, unknown>;
    expect(seeded).toMatchObject({
      bookReaderZoom: 0.6,
      novelReaderBrightness: 0.4,
      bookReaderBrightness: 0.4,
      bookProseReaderFontSize: 22,
      bookProseReaderTheme: "sepia",
      bookProseReaderFullWidth: true,
    });
    expect(legacy).not.toHaveProperty("bookReaderZoom");

    const alreadySplit = { readerBrightness: 0.4, novelReaderBrightness: 0.9, bookReaderBrightness: 0.7 };
    expect(seedSplitReaderSettings(alreadySplit)).toBe(alreadySplit);
  });

  it("gives every reader its own brightness and prose keys", () => {
    expect(new Set(Object.values(READER_BRIGHTNESS_SETTING_KEY)).size).toBe(3);
    const novelKeys = Object.values(PROSE_READER_SETTING_KEYS.novel);
    const bookKeys = Object.values(PROSE_READER_SETTING_KEYS.book);
    expect(novelKeys.filter((key) => bookKeys.includes(key as never))).toEqual([]);
  });

  it("keeps each reader on its own settings", () => {
    const book = source("src/components/reader/BookReader.svelte");
    expect(book).not.toMatch(/\bproseReader(FontSize|FontFamily|LineHeight|ParagraphSpacing|ContentWidth|TextColor|BackgroundColor|Theme|TextAlign|FullWidth)\b/);
    expect(book).not.toMatch(/\breaderZoom\b/);
    expect(book).toContain('readerKind="book"');

    const novel = source("src/components/reader/NovelReader.svelte");
    expect(novel).not.toMatch(/\bbookProseReader\w+/);
    expect(novel).toContain('readerKind="novel"');

    const manga = source("src/components/reader/Reader.svelte");
    expect(manga).not.toMatch(/\b(bookReaderZoom|bookProseReader\w+|proseReader\w+)\b/);
    expect(manga).toContain('readerKind="manga"');

    const hud = source("src/components/reader/ReaderHud.svelte");
    expect(hud).not.toContain("store.settings.readerBrightness");
    expect(hud).toContain("READER_BRIGHTNESS_SETTING_KEY[readerKind]");
  });

  it("persists the split keys per profile", () => {
    const state = source("src/store/state.svelte.ts");
    for (const key of [
      "bookReaderZoom",
      "novelReaderBrightness",
      "bookReaderBrightness",
      ...Object.values(PROSE_READER_SETTING_KEYS.book),
    ]) {
      expect(state).toContain(`  "${key}",`);
    }
    expect(state).toContain("...seedSplitReaderSettings(saved?.settings ?? {})");
  });
});
