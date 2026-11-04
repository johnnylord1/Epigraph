import type { Manga } from "../types";

/**
 * The library with these works read again: updated where they stand, added at the end when new,
 * and gone when Suwayomi no longer has them in the library.
 */
export function patchLibraryWorks(current: Manga[], readIds: readonly number[], rows: readonly Manga[]): Manga[] {
  const read = new Set(readIds);
  const rowById = new Map(rows.filter((row) => row.inLibrary && read.has(row.id)).map((row) => [row.id, row]));
  const withRow = (row: Manga, known?: Manga): Manga => ({
    ...known,
    ...row,
    chapterCount: row.chapters?.totalCount ?? row.chapterCount ?? known?.chapterCount ?? 0,
  });
  const patched: Manga[] = [];
  for (const manga of current) {
    if (!read.has(manga.id)) {
      patched.push(manga);
      continue;
    }
    const row = rowById.get(manga.id);
    if (row) patched.push(withRow(row, manga));
    rowById.delete(manga.id);
  }
  for (const row of rowById.values()) patched.push(withRow(row));
  return patched;
}
