import type { Manga } from "../types";
import { inferMangaRecommendationContentType } from "./adapters";
import { matchAniListTitles, pendingAniListTitleCount, type AniListTitleMatchEntry } from "./anilistMedia";

/**
 * Matches library works to AniList in the background from app start, so the recommendations already
 * know every work's genres and other names when the search page opens. Titles go ten per request, two
 * requests per batch, a batch every 20s: under a quarter of AniList's per-minute allowance. A batch
 * that makes no progress (rate limit, AniList down) waits longer before the next one.
 */

type LibraryWork = Pick<Manga, "id" | "title" | "genre"> & Partial<Pick<Manga, "source">>;
type EntriesLoader = () => Promise<AniListTitleMatchEntry[]>;

export const ANILIST_LIBRARY_LOOKUP_FIRST_DELAY_MS = 45_000;
export const ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS = 10_000;
const BATCH_DELAY_MS = 20_000;
const REQUESTS_PER_BATCH = 2;
const MAX_BACKOFF_MS = 10 * 60_000;
const MAX_IDLE_BATCHES = 5;

const ANILIST_TRACKED_WORKS = `
  query AniListTrackedWorks {
    trackers { nodes { name trackRecords { nodes { manga { id } } } } }
  }
`;

let loadEntries: EntriesLoader | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let changedWhileRunning = false;
let backoffMs = BATCH_DELAY_MS;
let idleBatches = 0;

/**
 * Library works worth looking up, the ones with fewest genres first since they gain the most. Works
 * with an AniList tracker entry already have their AniList id and are left out.
 */
export function aniListLibraryLookupEntries(
  works: readonly LibraryWork[],
  aniListTrackedIds: ReadonlySet<number> = new Set(),
): AniListTitleMatchEntry[] {
  return works
    .filter((work) => work.title?.trim() && !aniListTrackedIds.has(work.id))
    .map((work) => {
      const genres = (work.genre ?? []).filter((genre) => genre.trim());
      const type = inferMangaRecommendationContentType(work as Manga);
      const country = type === "manhwa" ? "KR" : type === "manhua" ? "CN" : null;
      return { key: String(work.id), title: work.title, genres, country };
    })
    .sort((a, b) => a.genres.length - b.genres.length);
}

/** Library works with an AniList tracker entry. */
export async function aniListTrackedMangaIds(): Promise<Set<number>> {
  const { gql } = await import("../startupClient");
  const data = await gql<{
    trackers?: { nodes?: Array<{ name?: string | null; trackRecords?: { nodes?: Array<{ manga?: { id?: number } | null }> } | null }> };
  }>(ANILIST_TRACKED_WORKS);
  const ids = new Set<number>();
  for (const tracker of data.trackers?.nodes ?? []) {
    if (!String(tracker.name ?? "").toLowerCase().includes("anilist")) continue;
    for (const record of tracker.trackRecords?.nodes ?? []) {
      if (typeof record.manga?.id === "number") ids.add(record.manga.id);
    }
  }
  return ids;
}

/** Looks up the works `getWorks` returns at each batch, so library changes are picked up. */
export function scheduleLibraryAniListLookup(getWorks: () => readonly LibraryWork[], delayMs?: number) {
  scheduleAniListLibraryLookup(async () => {
    const works = getWorks();
    return works.length > 0 ? aniListLibraryLookupEntries(works, await aniListTrackedMangaIds()) : [];
  }, delayMs);
}

/**
 * Starts (or re-targets) the background lookup. While a run is active the next batch simply uses the
 * new loader; otherwise the first batch waits `delayMs`.
 */
export function scheduleAniListLibraryLookup(loader: EntriesLoader, delayMs = ANILIST_LIBRARY_LOOKUP_FIRST_DELAY_MS) {
  loadEntries = loader;
  idleBatches = 0;
  if (running) changedWhileRunning = true;
  if (running || timer !== undefined) return;
  backoffMs = BATCH_DELAY_MS;
  timer = setTimeout(runBatch, delayMs);
}

export function stopAniListLibraryLookup() {
  clearTimeout(timer);
  timer = undefined;
  loadEntries = null;
}

async function runBatch() {
  timer = undefined;
  const loader = loadEntries;
  if (!loader) return;
  running = true;
  changedWhileRunning = false;
  let next: number | null = null;
  try {
    const entries = await loader();
    const titles = entries.map((entry) => entry.title);
    const before = pendingAniListTitleCount(titles);
    if (before > 0) {
      await matchAniListTitles(entries, { maxRequests: REQUESTS_PER_BATCH });
      const after = pendingAniListTitleCount(titles);
      if (after < before) {
        backoffMs = BATCH_DELAY_MS;
        idleBatches = 0;
      } else {
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        idleBatches += 1;
      }
      if (after > 0 && idleBatches < MAX_IDLE_BATCHES) next = backoffMs;
    }
  } catch {
    // Library or tracker list unavailable (server starting): try again later.
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    idleBatches += 1;
    if (idleBatches < MAX_IDLE_BATCHES) next = backoffMs;
  } finally {
    running = false;
  }
  if (next === null && changedWhileRunning) next = ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS;
  if (next !== null && loadEntries) timer = setTimeout(runBatch, next);
}
