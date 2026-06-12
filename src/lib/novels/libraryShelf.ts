import type { LibraryCardVM } from "../library/contracts";
import type { BooksLibrarySortMode } from "../library/booksSection";
import type { LibrarySortDir, BooksLibraryStatusFilter } from "../../store/state.svelte";
import type {
  PersistedNovelChapterEntry,
  PersistedNovelLibraryEntry,
} from "./domain";
import type { AethonNovelProgressEntry } from "../backup/novelsBackup";
import type { HardcoverNovelTrackRecord } from "./hardcover";

export interface NovelShelfCard extends LibraryCardVM {
  novelId: string;
}

function formatNovelSourceStatus(status: string | null | undefined): string | null {
  const normalized = status?.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.toLowerCase() === "unknown") return null;
  const token = normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (token === "FINISHED" || token === "COMPLETED" || token === "COMPLETE") return "Completed";
  if (token === "CANCELLED" || token === "CANCELED") return "Cancelled";
  if (token === "HIATUS") return "Hiatus";
  if (token === "ONGOING") return "Ongoing";
  return null;
}

function buildNovelWorkStatusLabel(
  entry: PersistedNovelLibraryEntry,
  hardcoverRecord: HardcoverNovelTrackRecord | undefined,
  isReadFinished: boolean,
): string {
  const trackerStatus = formatNovelSourceStatus(hardcoverRecord?.workStatus);
  if (trackerStatus) return trackerStatus === "Completed" && isReadFinished ? "Finished" : trackerStatus;

  const sourceStatus = formatNovelSourceStatus(entry.status);
  if (sourceStatus) return sourceStatus === "Completed" && isReadFinished ? "Finished" : sourceStatus;
  return "Unknown";
}

function getHardcoverRecordByNovelId(
  records: readonly HardcoverNovelTrackRecord[] | undefined,
): ReadonlyMap<string, HardcoverNovelTrackRecord> {
  const byNovelId = new Map<string, HardcoverNovelTrackRecord>();
  for (const record of records ?? []) {
    if (!record.sourceNovelId) continue;
    byNovelId.set(record.sourceNovelId, record);
  }
  return byNovelId;
}

function buildNovelSourceLabel(entry: PersistedNovelLibraryEntry): string {
  return entry.source?.sourceName ?? entry.source?.pluginName ?? "Source";
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
  hardcoverRecords?: readonly HardcoverNovelTrackRecord[];
}): {
  entries: PersistedNovelLibraryEntry[];
  cards: NovelShelfCard[];
  emptyMessage: string;
} {
  const progressByNovelId = getProgressByNovelId(input.progress);
  const readCounts = getReadCountsByNovelId(input.chapters);
  const hardcoverRecordByNovelId = getHardcoverRecordByNovelId(input.hardcoverRecords);
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
      const chapterCount = Math.max(0, counts.total || entry.chapterCount);
      const readCount = Math.max(0, Math.min(chapterCount, counts.read));
      const unreadCount = Math.max(0, chapterCount - readCount);

      return {
        id: `novel-card:${entry.id}`,
        novelId: entry.id,
        title: entry.title,
        subtitle: buildNovelSourceLabel(entry),
        coverSrc: entry.coverUrl,
        coverFit: "cover",
        badges: [],
        metaChips: [
          buildNovelWorkStatusLabel(entry, hardcoverRecordByNovelId.get(entry.id), progressPercent >= 0.98),
        ],
        progress: chapterCount > 0 ? {
          primaryLabel: String(readCount),
          secondaryLabel: `/ ${chapterCount} chapters`,
          percent: progressPercent,
        } : null,
        selectable: false,
        selected: false,
        sourceMetricBanner: {
          flagLabel: entry.source?.lang ?? "",
          downloadedCount: 0,
          newCount: unreadCount,
          sourceName: entry.source?.sourceName ?? entry.source?.pluginName ?? null,
        },
      };
    }),
    emptyMessage: input.entries.length === 0
      ? "No source novels in this profile library yet."
      : "No source novels match the current search or filters.",
  };
}
