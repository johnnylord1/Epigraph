import type { LibraryCardVM } from "../library/contracts";
import type { BooksLibrarySortMode } from "../library/booksSection";
import type { LibrarySortDir, BooksLibraryStatusFilter } from "../../store/state.svelte";
import type {
  PersistedNovelChapterEntry,
  PersistedNovelLibraryEntry,
} from "./domain";
import type { AethonNovelProgressEntry } from "../backup/novelsBackup";

export interface NovelShelfCard extends LibraryCardVM {
  novelId: string;
}

function getProgressByNovelId(progress: AethonNovelProgressEntry[]): ReadonlyMap<string, AethonNovelProgressEntry | undefined> {
  return new Map(progress.map((entry) => [entry.novelId, entry]));
}

function getReadCountsByNovelId(chapters: PersistedNovelChapterEntry[]): ReadonlyMap<string, { total: number; read: number }> {
  const counts = new Map<string, { total: number; read: number }>();
  for (const chapter of chapters) {
    const current = counts.get(chapter.novelId) ?? { total: 0, read: 0 };
    current.total += 1;
    if (!chapter.unread) current.read += 1;
    counts.set(chapter.novelId, current);
  }
  return counts;
}

function matchesStatus(
  entry: PersistedNovelLibraryEntry,
  statusFilter: BooksLibraryStatusFilter,
  readCounts: ReadonlyMap<string, { total: number; read: number }>,
  progressByNovelId: ReadonlyMap<string, AethonNovelProgressEntry | undefined>,
): boolean {
  if (statusFilter === "all") return true;
  const counts = readCounts.get(entry.id) ?? { total: entry.chapterCount, read: 0 };
  const progressPercent = progressByNovelId.get(entry.id)?.progressPercent ?? (
    counts.total > 0 ? counts.read / counts.total : 0
  );

  switch (statusFilter) {
    case "unopened":
      return progressPercent <= 0.001;
    case "in_progress":
      return progressPercent > 0.001 && progressPercent < 0.98;
    case "finished":
      return progressPercent >= 0.98;
    default:
      return true;
  }
}

function filterBySearch(entries: PersistedNovelLibraryEntry[], search: string): PersistedNovelLibraryEntry[] {
  const query = search.trim().toLowerCase();
  if (!query) return entries;

  return entries.filter((entry) => (
    entry.title.toLowerCase().includes(query)
    || (entry.author ?? "").toLowerCase().includes(query)
  ));
}

function sortEntries(
  entries: PersistedNovelLibraryEntry[],
  progressByNovelId: ReadonlyMap<string, AethonNovelProgressEntry | undefined>,
  sortMode: BooksLibrarySortMode,
  sortDir: LibrarySortDir,
): PersistedNovelLibraryEntry[] {
  return [...entries].sort((left, right) => {
    let cmp = 0;
    switch (sortMode) {
      case "az":
        cmp = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
        break;
      case "author":
        cmp = (left.author ?? "").localeCompare(right.author ?? "", undefined, { sensitivity: "base" });
        if (cmp === 0) cmp = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
        break;
      case "recentlyAdded":
        cmp = left.addedAt - right.addedAt;
        break;
      case "recentlyRead":
        cmp = (progressByNovelId.get(left.id)?.updatedAt ?? 0) - (progressByNovelId.get(right.id)?.updatedAt ?? 0);
        break;
      case "sectionCount":
        cmp = left.chapterCount - right.chapterCount;
        break;
    }
    return sortDir === "asc" ? cmp : -cmp;
  });
}

export function buildNovelLibraryCards(input: {
  entries: PersistedNovelLibraryEntry[];
  chapters: PersistedNovelChapterEntry[];
  progress: AethonNovelProgressEntry[];
  search: string;
  sortMode: BooksLibrarySortMode;
  sortDir: LibrarySortDir;
  statusFilter: BooksLibraryStatusFilter;
}): {
  entries: PersistedNovelLibraryEntry[];
  cards: NovelShelfCard[];
  emptyMessage: string;
} {
  const progressByNovelId = getProgressByNovelId(input.progress);
  const readCounts = getReadCountsByNovelId(input.chapters);
  const searched = filterBySearch(input.entries, input.search);
  const statusFiltered = searched.filter((entry) => matchesStatus(entry, input.statusFilter, readCounts, progressByNovelId));
  const sorted = sortEntries(statusFiltered, progressByNovelId, input.sortMode, input.sortDir);

  return {
    entries: sorted,
    cards: sorted.map((entry) => {
      const counts = readCounts.get(entry.id) ?? { total: entry.chapterCount, read: 0 };
      const progressPercent = progressByNovelId.get(entry.id)?.progressPercent ?? (
        counts.total > 0 ? counts.read / counts.total : 0
      );

      return {
        id: `novel-card:${entry.id}`,
        novelId: entry.id,
        title: entry.title,
        subtitle: entry.author ?? entry.source?.sourceName ?? entry.source?.pluginName ?? "Novel source",
        coverSrc: entry.coverUrl,
        coverFit: "cover",
        badges: [{ kind: "subtype", label: "Source" }],
        metaChips: [
          `${entry.chapterCount} chapters`,
          entry.source?.lang?.toUpperCase?.() ?? "LN",
        ],
        progress: entry.chapterCount > 0 ? {
          primaryLabel: `${counts.read} / ${counts.total || entry.chapterCount} read`,
          secondaryLabel: `${Math.round(progressPercent * 100)}%`,
          percent: progressPercent,
        } : null,
        selectable: false,
        selected: false,
      };
    }),
    emptyMessage: input.entries.length === 0
      ? "No source novels in this profile library yet."
      : "No source novels match the current search or filters.",
  };
}

