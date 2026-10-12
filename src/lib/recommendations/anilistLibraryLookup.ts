import type { Manga } from "../types";
import type { NovelRepositoryScopeInput } from "../novels/repositoryState";
import { inferMangaRecommendationContentType } from "./adapters";
import type { AniListTitleMatchEntry } from "./anilistMedia";
import { splitCredits } from "./credits";
import {
  titleProviderChain,
  type HardcoverTitleSearch,
  type TitleProvider,
  type TitleProviderOutcome,
  type TitleProviderTracker,
} from "./titleProviders";

/**
 * Recognises library works in the background, so the recommendations already know every work's
 * genres and other names when the search page opens. Each work is looked up once: the first library
 * seen after app start queues every work not looked up yet, and later library changes queue only the
 * works that were added (removed works simply leave the queue).
 *
 * Comics and novels (books included) are looked up apart, each on its own trackers, so a comic never
 * takes a novel's place. Works go through the providers in order: a work one provider does not know
 * for certain moves on to the next. Every provider works through its own queue at its own pace, all
 * at once, so the misses of the first never wait for the whole library. A provider that stops
 * answering is skipped for the rest of the session; works only it could still recognise wait for the
 * next session (or a visit to the search page). A work no provider recognises for certain stays
 * pending, and nothing is ever tracked: tracking stays the user's choice.
 */

type LibraryWork = Pick<Manga, "id" | "title" | "genre"> & Partial<Pick<Manga, "source" | "author" | "artist">>;

/** A novel or book of the library. */
export interface LibraryNovelWork {
  /** Unique among novels and books ("novel:<id>", "book:<id>"). */
  key: string;
  title: string;
  author?: string | null;
  genres?: readonly string[] | null;
}

export interface AniListLibraryLookupProgress {
  /** "running" while works are looked up, "done" once all are, "paused" when providers stopped answering. */
  phase: "running" | "done" | "paused";
  /** Works this run looks up. */
  total: number;
  remaining: number;
  matched: number;
  /** Works only likely recognised: they stay pending until the user picks the work. */
  uncertain: number;
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
const HARDCOVER_RESULTS_PER_TITLE = 5;
const HARDCOVER_RATE_LIMIT_RETRY_MS = 30_000;

const LOOKUP_TRACKERS = `
  query LibraryLookupTrackers {
    trackers { nodes { id name isLoggedIn trackRecords { nodes { manga { id } } } } }
    mangas(condition: { inLibrary: true }) { nodes { id author artist } }
  }
`;

interface ActiveWork<W> { work: W; entry: AniListTitleMatchEntry; stage: number }
interface ProviderHealth { busy: boolean; nextAt: number; failures: number; down: boolean }
interface LookupPlan<W> { chain: TitleProvider[]; entries(works: W[]): AniListTitleMatchEntry[] }
interface LookupTrackers { trackers: TitleProviderTracker[]; aniListTrackedIds: Set<number>; credits: Map<number, string[]> }

interface LibraryLookup<W> {
  sync(works: readonly W[], onProgress?: AniListLibraryLookupListener): void;
  resume(): void;
  stop(): void;
}

/**
 * One background lookup: a queue of works keyed by `keyOf`, looked up through the chain `prepare`
 * builds when a run starts.
 */
function createLibraryLookup<W>(keyOf: (work: W) => string, prepare: () => Promise<LookupPlan<W>>): LibraryLookup<W> {
  // Works waiting for a run, and the keys seen so far (null before the first library).
  const queue = new Map<string, W>();
  let seenKeys: Set<string> | null = null;
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
  const active = new Map<string, ActiveWork<W>>();
  const blocked = new Map<string, W>();
  let run: { total: number; matched: number; uncertain: number; missed: number; announced: boolean; reportedAt: number } | null = null;

  function sync(works: readonly W[], onProgress?: AniListLibraryLookupListener) {
    if (onProgress) listener = onProgress;
    if (works.length === 0) return;
    const firstSync = seenKeys === null;
    const keys = new Set(works.map(keyOf));
    for (const map of [queue, active, blocked]) {
      for (const key of map.keys()) {
        if (!keys.has(key)) map.delete(key);
      }
    }
    let added = 0;
    for (const work of works) {
      const key = keyOf(work);
      if (seenKeys?.has(key)) continue;
      queue.set(key, work);
      added += 1;
    }
    seenKeys = keys;
    if (added > 0) scheduleStart(firstSync ? ANILIST_LIBRARY_LOOKUP_FIRST_DELAY_MS : ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS);
    else if (run) pump();
  }

  function resume() {
    if (blocked.size === 0 && queue.size === 0) return;
    for (const [key, work] of blocked) queue.set(key, work);
    blocked.clear();
    for (const [id, state] of health) {
      if (state.down) health.delete(id);
    }
    startFailures = 0;
    scheduleStart(ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS);
  }

  function stop() {
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
    seenKeys = null;
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
    let plan: LookupPlan<W>;
    try {
      plan = await prepare();
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
    if (plan.chain.map((provider) => provider.id).join() !== chain.map((provider) => provider.id).join()) {
      chain = plan.chain;
      for (const work of active.values()) settle(work);
    }

    const works = new Map(queue);
    queue.clear();
    let added = 0;
    for (const entry of plan.entries([...works.values()])) {
      const work = works.get(entry.key);
      if (!work || active.has(entry.key)) continue;
      const lookup: ActiveWork<W> = { work, entry, stage: 0 };
      // Works every provider already answered about leave without a request or a count.
      const result = advance(lookup);
      if (result === "waiting") {
        active.set(entry.key, lookup);
        added += 1;
      } else if (result === "blocked") {
        blocked.set(entry.key, work);
      }
    }
    if (added > 0) {
      run ??= { total: 0, matched: 0, uncertain: 0, missed: 0, announced: false, reportedAt: 0 };
      run.total += added;
      if (!run.announced) {
        run.announced = true;
        report("running", true);
      }
    }
    pump();
  }

  /**
   * Moves a work to the first provider that has not answered about it and is answering. A provider
   * that only knows a work the title might name does not stop the search: the next may know it for
   * certain. "blocked" when only providers that are down are left to ask: the work waits for them
   * rather than counting as a miss.
   */
  function advance(work: ActiveWork<W>): "matched" | "uncertain" | "missed" | "waiting" | "blocked" {
    let skippedDown = false;
    let uncertain = false;
    for (let index = 0; index < chain.length; index += 1) {
      const status = chain[index].status(work.entry);
      if (status === "matched") return "matched";
      if (status === "missed") continue;
      if (status === "uncertain") {
        uncertain = true;
        continue;
      }
      if (healthOf(chain[index].id).down) {
        skippedDown = true;
        continue;
      }
      work.stage = index;
      return "waiting";
    }
    if (skippedDown) return "blocked";
    return uncertain ? "uncertain" : "missed";
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
      const batch: ActiveWork<W>[] = [];
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

  async function lookUp(provider: TitleProvider, state: ProviderHealth, batch: ActiveWork<W>[]) {
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

  function settle(work: ActiveWork<W>) {
    const key = work.entry.key;
    if (active.get(key) !== work || !run) return;
    const result = advance(work);
    if (result === "waiting") return;
    active.delete(key);
    if (result === "matched") run.matched += 1;
    else if (result === "uncertain") run.uncertain += 1;
    else if (result === "missed") run.missed += 1;
    else blocked.set(key, work.work);
  }

  function report(phase: AniListLibraryLookupProgress["phase"], force = false) {
    if (!run?.announced) return;
    const now = Date.now();
    if (!force && phase === "running" && now - run.reportedAt < PROGRESS_REPORT_MS) return;
    run.reportedAt = now;
    const remaining = phase === "running" ? active.size : phase === "paused" ? blocked.size : 0;
    listener?.({ phase, total: run.total, remaining, matched: run.matched, uncertain: run.uncertain, missed: run.missed });
  }

  function finishRun() {
    report(blocked.size > 0 ? "paused" : "done", true);
    run = null;
  }

  return { sync, resume, stop };
}

/**
 * Library works worth looking up, the ones with fewest genres first since they gain the most. Works
 * with an AniList or MyAnimeList tracker entry are known by that entry and are left out.
 */
export function aniListLibraryLookupEntries(
  works: readonly LibraryWork[],
  aniListTrackedIds: ReadonlySet<number> = new Set(),
  credits: ReadonlyMap<number, readonly string[]> = new Map(),
): AniListTitleMatchEntry[] {
  return works
    .filter((work) => work.title?.trim() && !aniListTrackedIds.has(work.id))
    .map((work) => {
      const genres = (work.genre ?? []).filter((genre) => genre.trim());
      const type = inferMangaRecommendationContentType(work as Manga);
      const country = type === "manhwa" ? "KR" : type === "manhua" ? "CN" : null;
      const workCredits = credits.get(work.id) ?? splitCredits([work.author, work.artist]);
      return {
        key: String(work.id),
        title: work.title,
        genres,
        country,
        ...(workCredits.length > 0 ? { credits: [...workCredits] } : {}),
      };
    })
    .sort((a, b) => a.genres.length - b.genres.length);
}

/** Library novels and books worth looking up, as prose works, the ones with fewest genres first. */
export function novelLibraryLookupEntries(works: readonly LibraryNovelWork[]): AniListTitleMatchEntry[] {
  return works
    .filter((work) => work.key && work.title?.trim())
    .map((work) => {
      const genres = (work.genres ?? []).filter((genre) => genre.trim());
      const credits = splitCredits(work.author);
      return {
        key: work.key,
        title: work.title,
        genres,
        country: null,
        medium: "novel" as const,
        ...(credits.length > 0 ? { credits } : {}),
      };
    })
    .sort((a, b) => a.genres.length - b.genres.length);
}

/**
 * The Suwayomi trackers (for the provider chain), the library works with an AniList or MyAnimeList
 * entry (AniList knows MyAnimeList ids, so either names the work for certain) and who
 * made each library work (the library list leaves that out).
 */
async function lookupTrackers(): Promise<LookupTrackers> {
  const { gql } = await import("../startupClient");
  const data = await gql<{
    trackers?: {
      nodes?: Array<TitleProviderTracker & { trackRecords?: { nodes?: Array<{ manga?: { id?: number } | null }> } | null }>;
    };
    mangas?: { nodes?: Array<{ id?: number; author?: string | null; artist?: string | null }> } | null;
  }>(LOOKUP_TRACKERS);
  const trackers: TitleProviderTracker[] = [];
  const aniListTrackedIds = new Set<number>();
  for (const tracker of data.trackers?.nodes ?? []) {
    trackers.push({ id: tracker.id, name: String(tracker.name ?? ""), isLoggedIn: tracker.isLoggedIn });
    const name = String(tracker.name ?? "").toLowerCase();
    if (!name.includes("anilist") && !name.includes("myanimelist") && name !== "mal") continue;
    for (const record of tracker.trackRecords?.nodes ?? []) {
      if (typeof record.manga?.id === "number") aniListTrackedIds.add(record.manga.id);
    }
  }
  const credits = new Map<number, string[]>();
  for (const manga of data.mangas?.nodes ?? []) {
    if (typeof manga.id !== "number") continue;
    const names = splitCredits([manga.author, manga.artist]);
    if (names.length > 0) credits.set(manga.id, names);
  }
  return { trackers, aniListTrackedIds, credits };
}

const comicLookup = createLibraryLookup<LibraryWork>(
  (work) => String(work.id),
  async () => {
    const trackers = await lookupTrackers();
    return {
      chain: titleProviderChain(trackers.trackers),
      entries: (works) => aniListLibraryLookupEntries(works, trackers.aniListTrackedIds, trackers.credits),
    };
  },
);

/** Hardcover search through the user's own connection, null when Hardcover is not connected. */
async function hardcoverTitleSearch(scope: NovelRepositoryScopeInput): Promise<HardcoverTitleSearch | null> {
  const hardcover = await import("../novels/hardcover");
  if (!hardcover.loadHardcoverState(scope).auth.connected) return null;
  return {
    search: (query) => hardcover.searchHardcoverBooks(scope, query, HARDCOVER_RESULTS_PER_TITLE, 1, { cacheGroup: "library-lookup" }),
    retryAfterMs: (error) => hardcover.isHardcoverRateLimitError(error)
      ? Math.max(hardcover.getHardcoverRateLimitRemainingMs(scope), HARDCOVER_RATE_LIMIT_RETRY_MS)
      : null,
  };
}

let novelScope: NovelRepositoryScopeInput = {};
const novelLookup = createLibraryLookup<LibraryNovelWork>(
  (work) => work.key,
  async () => {
    const hardcover = await hardcoverTitleSearch(novelScope);
    return {
      chain: titleProviderChain([], { hardcover }, "novel"),
      entries: novelLibraryLookupEntries,
    };
  },
);

/**
 * Follows the comic library: queues the works not seen before and drops the removed ones. Works
 * already looked up in an earlier session leave the queue without a request.
 */
export function syncLibraryAniListLookup(works: readonly LibraryWork[], onProgress?: AniListLibraryLookupListener) {
  comicLookup.sync(works, onProgress);
}

/**
 * Follows the novels and books of the library, the same way, on the novel trackers: Kitsu's public
 * novel catalogue, which needs no account, and Hardcover (the novel section's tracker) while the user
 * has it connected.
 */
export function syncLibraryNovelLookup(
  works: readonly LibraryNovelWork[],
  scope: NovelRepositoryScopeInput,
  onProgress?: AniListLibraryLookupListener,
) {
  novelScope = scope;
  novelLookup.sync(works, onProgress);
}

/** Asks the providers that stopped answering again, for the works that wait for them. */
export function resumeLibraryAniListLookup() {
  comicLookup.resume();
  novelLookup.resume();
}

export function stopAniListLibraryLookup() {
  comicLookup.stop();
  novelLookup.stop();
}
