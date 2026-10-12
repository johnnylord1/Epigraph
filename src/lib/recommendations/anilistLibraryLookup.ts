import type { Manga } from "../types";
import { inferMangaRecommendationContentType } from "./adapters";
import { isAniListTitlePending, matchAniListTitles, type AniListTitleMatchEntry } from "./anilistMedia";

/**
 * Matches library works to AniList in the background, so the recommendations already know every
 * work's genres and other names when the search page opens. Each work is looked up once: the first
 * library seen after app start queues every work not looked up yet, and later library changes queue
 * only the works that were added (removed works simply leave the queue). Titles go ten per request,
 * two requests per batch, a batch every 20s: under a quarter of AniList's per-minute allowance. A
 * batch that makes no progress (rate limit, AniList down) waits longer before the next one.
 */

type LibraryWork = Pick<Manga, "id" | "title" | "genre"> & Partial<Pick<Manga, "source">>;

export interface AniListLibraryLookupProgress {
  /** "running" while works are looked up, "done" once all are, "paused" when AniList stopped answering. */
  phase: "running" | "done" | "paused";
  /** Works this run looks up. */
  total: number;
  remaining: number;
  matched: number;
  missed: number;
}

export type AniListLibraryLookupListener = (progress: AniListLibraryLookupProgress) => void;

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

// Works waiting for a lookup, by library id, and the library ids seen so far (null before the first).
const queue = new Map<number, LibraryWork>();
let seenWorkIds: Set<number> | null = null;
let listener: AniListLibraryLookupListener | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let backoffMs = BATCH_DELAY_MS;
let idleBatches = 0;
// The current run: its AniList-tracked works (fetched once per run) and what it has done so far.
let trackedIds: Set<number> | null = null;
let run: { total: number; matched: number; missed: number; announced: boolean } | null = null;

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

/**
 * Follows the library: queues the works not seen before and drops the removed ones. Works already
 * looked up in an earlier session leave the queue at the first batch without a request.
 */
export function syncLibraryAniListLookup(works: readonly LibraryWork[], onProgress?: AniListLibraryLookupListener) {
  if (onProgress) listener = onProgress;
  if (works.length === 0) return;
  const firstSync = seenWorkIds === null;
  const ids = new Set(works.map((work) => work.id));
  for (const id of queue.keys()) {
    if (!ids.has(id)) queue.delete(id);
  }
  let added = 0;
  for (const work of works) {
    if (seenWorkIds?.has(work.id)) continue;
    queue.set(work.id, work);
    added += 1;
  }
  seenWorkIds = ids;
  if (added > 0) schedule(firstSync ? ANILIST_LIBRARY_LOOKUP_FIRST_DELAY_MS : ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS);
}

/** Restarts a lookup that paused after AniList stopped answering. */
export function resumeLibraryAniListLookup() {
  if (queue.size > 0) schedule(ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS);
}

export function stopAniListLibraryLookup() {
  clearTimeout(timer);
  timer = undefined;
  queue.clear();
  seenWorkIds = null;
  listener = null;
  trackedIds = null;
  run = null;
}

function schedule(delayMs: number) {
  idleBatches = 0;
  if (running || timer !== undefined) return;
  backoffMs = BATCH_DELAY_MS;
  timer = setTimeout(runBatch, delayMs);
}

function report(phase: AniListLibraryLookupProgress["phase"], remaining: number) {
  if (!run) return;
  listener?.({ phase, total: run.total, remaining, matched: run.matched, missed: run.missed });
}

function finishRun(phase: "done" | "paused", remaining: number) {
  if (run?.announced) report(phase, remaining);
  run = null;
  trackedIds = null;
}

async function runBatch() {
  timer = undefined;
  running = true;
  let next: number | null = null;
  try {
    // Works known from earlier lookups leave the queue without a request; the tracker list is only
    // read when something is left to look up.
    let pending = aniListLibraryLookupEntries([...queue.values()]).filter((entry) => isAniListTitlePending(entry.title));
    if (pending.length > 0) {
      trackedIds ??= await aniListTrackedMangaIds();
      const tracked = trackedIds;
      pending = pending.filter((entry) => !tracked.has(Number(entry.key)));
    }
    const pendingKeys = new Set(pending.map((entry) => entry.key));
    for (const id of [...queue.keys()]) {
      if (!pendingKeys.has(String(id))) queue.delete(id);
    }
    if (pending.length === 0) {
      finishRun("done", 0);
    } else {
      run ??= { total: pending.length, matched: 0, missed: 0, announced: false };
      run.total = Math.max(run.total, run.matched + run.missed + pending.length);
      if (!run.announced) {
        run.announced = true;
        report("running", pending.length);
      }
      const matches = await matchAniListTitles(pending, { maxRequests: REQUESTS_PER_BATCH });
      let resolved = 0;
      for (const entry of pending) {
        if (isAniListTitlePending(entry.title)) continue;
        queue.delete(Number(entry.key));
        resolved += 1;
        if (matches.has(entry.key)) run.matched += 1;
        else run.missed += 1;
      }
      const remaining = pending.length - resolved;
      if (resolved > 0) {
        backoffMs = BATCH_DELAY_MS;
        idleBatches = 0;
      } else {
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        idleBatches += 1;
      }
      if (remaining === 0) finishRun("done", 0);
      else if (idleBatches >= MAX_IDLE_BATCHES) finishRun("paused", remaining);
      else {
        report("running", remaining);
        next = backoffMs;
      }
    }
  } catch {
    // Library or tracker list unavailable (server starting): try again later.
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    idleBatches += 1;
    if (idleBatches < MAX_IDLE_BATCHES) next = backoffMs;
    else finishRun("paused", queue.size);
  } finally {
    running = false;
  }
  // Works added while this batch ran wait for the next one.
  if (next === null && queue.size > 0 && idleBatches < MAX_IDLE_BATCHES) next = ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS;
  if (next !== null) timer = setTimeout(runBatch, next);
}
