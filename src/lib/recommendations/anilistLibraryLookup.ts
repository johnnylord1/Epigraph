import type { Manga } from "../types";
import { inferMangaRecommendationContentType } from "./adapters";
import type { AniListTitleMatchEntry } from "./anilistMedia";
import { titleProviderChain, type TitleProvider, type TitleProviderOutcome, type TitleProviderTracker } from "./titleProviders";

/**
 * Recognises library works in the background, so the recommendations already know every work's
 * genres and other names when the search page opens. Each work is looked up once: the first library
 * seen after app start queues every work not looked up yet, and later library changes queue only the
 * works that were added (removed works simply leave the queue).
 *
 * Works go through the providers in order (AniList, Kitsu, MyAnimeList, other logged-in trackers):
 * a work one provider does not know moves on to the next. Every provider works through its own queue
 * at its own pace, all at once, so the misses of the first never wait for the whole library. A
 * provider that stops answering is skipped for the rest of the session; works only it could still
 * recognise wait for the next session (or a visit to the search page).
 */

type LibraryWork = Pick<Manga, "id" | "title" | "genre"> & Partial<Pick<Manga, "source">>;

export interface AniListLibraryLookupProgress {
  /** "running" while works are looked up, "done" once all are, "paused" when providers stopped answering. */
  phase: "running" | "done" | "paused";
  /** Works this run looks up. */
  total: number;
  remaining: number;
  matched: number;
  missed: number;
}

export type AniListLibraryLookupListener = (progress: AniListLibraryLookupProgress) => void;

export const ANILIST_LIBRARY_LOOKUP_FIRST_DELAY_MS = 15_000;
export const ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS = 5_000;
const START_RETRY_MS = 20_000;
const MAX_START_FAILURES = 5;
const PROVIDER_RETRY_MS = 5_000;
const MAX_PROVIDER_FAILURES = 3;
const PROGRESS_REPORT_MS = 1_000;

const LOOKUP_TRACKERS = `
  query LibraryLookupTrackers {
    trackers { nodes { id name isLoggedIn trackRecords { nodes { manga { id } } } } }
  }
`;


interface ActiveWork { work: LibraryWork; entry: AniListTitleMatchEntry; stage: number }
interface ProviderHealth { busy: boolean; nextAt: number; failures: number; down: boolean }
interface LookupTrackers { trackers: TitleProviderTracker[]; aniListTrackedIds: Set<number> }

// Works waiting for a run, by library id, and the library ids seen so far (null before the first).
const queue = new Map<number, LibraryWork>();
let seenWorkIds: Set<number> | null = null;
let listener: AniListLibraryLookupListener | null = null;
let startTimer: ReturnType<typeof setTimeout> | undefined;
let pumpTimer: ReturnType<typeof setTimeout> | undefined;
let starting = false;
let startFailures = 0;
// Bumped by stop, so answers to requests sent before it are ignored.
let generation = 0;
let chain: TitleProvider[] = [];
const health = new Map<string, ProviderHealth>();
// Works being looked up, each at the provider it waits for, and works waiting for a provider that is down.
const active = new Map<number, ActiveWork>();
const blocked = new Map<number, LibraryWork>();
let run: { total: number; matched: number; missed: number; announced: boolean; reportedAt: number } | null = null;

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

/** The Suwayomi trackers (for the provider chain) and the library works with an AniList entry. */
async function lookupTrackers(): Promise<LookupTrackers> {
  const { gql } = await import("../startupClient");
  const data = await gql<{
    trackers?: {
      nodes?: Array<TitleProviderTracker & { trackRecords?: { nodes?: Array<{ manga?: { id?: number } | null }> } | null }>;
    };
  }>(LOOKUP_TRACKERS);
  const trackers: TitleProviderTracker[] = [];
  const aniListTrackedIds = new Set<number>();
  for (const tracker of data.trackers?.nodes ?? []) {
    trackers.push({ id: tracker.id, name: String(tracker.name ?? ""), isLoggedIn: tracker.isLoggedIn });
    if (!String(tracker.name ?? "").toLowerCase().includes("anilist")) continue;
    for (const record of tracker.trackRecords?.nodes ?? []) {
      if (typeof record.manga?.id === "number") aniListTrackedIds.add(record.manga.id);
    }
  }
  return { trackers, aniListTrackedIds };
}

/**
 * Follows the library: queues the works not seen before and drops the removed ones. Works already
 * looked up in an earlier session leave the queue without a request.
 */
export function syncLibraryAniListLookup(works: readonly LibraryWork[], onProgress?: AniListLibraryLookupListener) {
  if (onProgress) listener = onProgress;
  if (works.length === 0) return;
  const firstSync = seenWorkIds === null;
  const ids = new Set(works.map((work) => work.id));
  for (const map of [queue, active, blocked]) {
    for (const id of map.keys()) {
      if (!ids.has(id)) map.delete(id);
    }
  }
  let added = 0;
  for (const work of works) {
    if (seenWorkIds?.has(work.id)) continue;
    queue.set(work.id, work);
    added += 1;
  }
  seenWorkIds = ids;
  if (added > 0) scheduleStart(firstSync ? ANILIST_LIBRARY_LOOKUP_FIRST_DELAY_MS : ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS);
  else if (run) pump();
}

/** Asks the providers that stopped answering again, for the works that wait for them. */
export function resumeLibraryAniListLookup() {
  if (blocked.size === 0 && queue.size === 0) return;
  for (const [id, work] of blocked) queue.set(id, work);
  blocked.clear();
  for (const [id, state] of health) {
    if (state.down) health.delete(id);
  }
  startFailures = 0;
  scheduleStart(ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS);
}

export function stopAniListLibraryLookup() {
  generation += 1;
  clearTimeout(startTimer);
  clearTimeout(pumpTimer);
  startTimer = undefined;
  pumpTimer = undefined;
  starting = false;
  startFailures = 0;
  queue.clear();
  active.clear();
  blocked.clear();
  health.clear();
  chain = [];
  seenWorkIds = null;
  listener = null;
  run = null;
}

function scheduleStart(delayMs: number) {
  if (starting || startTimer !== undefined) return;
  startTimer = setTimeout(() => void startRun(), delayMs);
}

/** Moves the queued works into the run, at the first provider still to be asked about each. */
async function startRun() {
  startTimer = undefined;
  if (queue.size === 0) return;
  starting = true;
  const startedGeneration = generation;
  let trackers: LookupTrackers;
  try {
    trackers = await lookupTrackers();
  } catch {
    // Suwayomi not ready (app starting): try again later, then wait for the next library change.
    if (startedGeneration !== generation) return;
    starting = false;
    startFailures += 1;
    if (startFailures < MAX_START_FAILURES) scheduleStart(START_RETRY_MS * startFailures);
    return;
  }
  if (startedGeneration !== generation) return;
  starting = false;
  startFailures = 0;
  // The chain follows the trackers the user is logged in to; providers already running keep their pace.
  const nextChain = titleProviderChain(trackers.trackers);
  if (nextChain.map((provider) => provider.id).join() !== chain.map((provider) => provider.id).join()) {
    chain = nextChain;
    for (const work of active.values()) settle(work);
  }

  const works = new Map(queue);
  queue.clear();
  const entries = aniListLibraryLookupEntries([...works.values()], trackers.aniListTrackedIds);
  let added = 0;
  for (const entry of entries) {
    const id = Number(entry.key);
    if (active.has(id)) continue;
    const work: ActiveWork = { work: works.get(id)!, entry, stage: 0 };
    // Works every provider already answered about leave without a request or a count.
    const result = advance(work);
    if (result === "waiting") {
      active.set(id, work);
      added += 1;
    } else if (result === "blocked") {
      blocked.set(id, works.get(id)!);
    }
  }
  if (added > 0) {
    run ??= { total: 0, matched: 0, missed: 0, announced: false, reportedAt: 0 };
    run.total += added;
    if (!run.announced) {
      run.announced = true;
      report("running", true);
    }
  }
  pump();
}

/**
 * Moves a work to the first provider that has not answered about it and is answering. "blocked" when
 * only providers that are down are left to ask: the work waits for them rather than counting as a miss.
 */
function advance(work: ActiveWork): "matched" | "missed" | "waiting" | "blocked" {
  let skippedDown = false;
  for (let index = 0; index < chain.length; index += 1) {
    const status = chain[index].status(work.entry);
    if (status === "matched") return "matched";
    if (status === "missed") continue;
    if (healthOf(chain[index].id).down) {
      skippedDown = true;
      continue;
    }
    work.stage = index;
    return "waiting";
  }
  return skippedDown ? "blocked" : "missed";
}

function healthOf(id: string): ProviderHealth {
  let state = health.get(id);
  if (!state) {
    state = { busy: false, nextAt: 0, failures: 0, down: false };
    health.set(id, state);
  }
  return state;
}

/** Sends a request to every provider that is free, due and has works waiting for it. */
function pump() {
  clearTimeout(pumpTimer);
  pumpTimer = undefined;
  const now = Date.now();
  let wakeAt = Infinity;
  let busy = false;
  chain.forEach((provider, index) => {
    const state = healthOf(provider.id);
    if (state.busy) busy = true;
    if (state.busy || state.down) return;
    const batch: ActiveWork[] = [];
    for (const work of active.values()) {
      if (work.stage !== index) continue;
      batch.push(work);
      if (batch.length >= provider.batchSize) break;
    }
    if (batch.length === 0) return;
    if (now < state.nextAt) {
      wakeAt = Math.min(wakeAt, state.nextAt);
      return;
    }
    busy = true;
    void lookUp(provider, state, batch);
  });
  if (wakeAt < Infinity) pumpTimer = setTimeout(pump, wakeAt - now);
  else if (!busy && active.size === 0 && run) finishRun();
}

async function lookUp(provider: TitleProvider, state: ProviderHealth, batch: ActiveWork[]) {
  const startedGeneration = generation;
  state.busy = true;
  let outcome: TitleProviderOutcome;
  try {
    outcome = await provider.lookUp(batch.map((work) => work.entry));
  } catch {
    outcome = { ok: false };
  }
  if (startedGeneration !== generation) return;
  state.busy = false;
  if (outcome.ok) {
    state.failures = 0;
    state.nextAt = Date.now() + (outcome.nextDelayMs ?? provider.intervalMs);
  } else {
    state.failures += 1;
    state.down = state.failures >= MAX_PROVIDER_FAILURES;
    state.nextAt = Date.now() + Math.max(outcome.retryAfterMs ?? 0, PROVIDER_RETRY_MS * 2 ** (state.failures - 1));
  }
  // A provider that is down hands every work waiting for it to the next one.
  const moved = state.down ? [...active.values()].filter((work) => chain[work.stage]?.id === provider.id) : batch;
  for (const work of moved) settle(work);
  report("running");
  pump();
}

function settle(work: ActiveWork) {
  const id = Number(work.entry.key);
  if (active.get(id) !== work || !run) return;
  const result = advance(work);
  if (result === "waiting") return;
  active.delete(id);
  if (result === "matched") run.matched += 1;
  else if (result === "missed") run.missed += 1;
  else blocked.set(id, work.work);
}

function report(phase: AniListLibraryLookupProgress["phase"], force = false) {
  if (!run?.announced) return;
  const now = Date.now();
  if (!force && phase === "running" && now - run.reportedAt < PROGRESS_REPORT_MS) return;
  run.reportedAt = now;
  const remaining = phase === "running" ? active.size : phase === "paused" ? blocked.size : 0;
  listener?.({ phase, total: run.total, remaining, matched: run.matched, missed: run.missed });
}

function finishRun() {
  report(blocked.size > 0 ? "paused" : "done", true);
  run = null;
}
