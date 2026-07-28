import { getServerAuthHeader, getServerUrl, gql } from "../client";
import { cache, CACHE_GROUPS, CACHE_KEYS } from "../cache";
import { GET_CATEGORIES_WITH_MANGA_IDS, GET_LIBRARY_UPDATE_STATUS, SET_LIBRARY_UPDATE_RULES, UPDATE_STOP } from "../queries";
import { fetchSourceMangaChapters } from "../manga/runtime";
import type { LibraryUpdateMangaPatch } from "../suwayomiUpdaterSubscription";
import { ensureServerAwakeFor, type ServerWakeReason } from "../serverLifecycle";
import { setLibraryMangaSnapshot, setLibraryUpdateProgress, store } from "../../store/state.svelte";
import type { Category, Chapter, Manga } from "../types";
import type { LibraryUpdateIssueErrorType, LibraryUpdateIssueKind } from "../../store/state.svelte";
import { classifySourceAccessError, sourceAccessErrorMessage } from "../sourceAccess";
import { mergeMangaCountsFromChapters } from "./chapterCounts";
import { translate } from "../i18n/runtime";
import { withSuwayomiOperationLease } from "../suwayomiUpdateLock.svelte";

export interface LibraryUpdateProgressNumbers {
  current: number;
  total: number;
  percent: number;
}

export interface SharedLibraryUpdateRunOptions {
  reason: Extract<ServerWakeReason, "manual-library-update" | "auto-library-update">;
  categories?: number[];
  sourceIds?: string[];
  timeoutMs?: number;
  liveRefreshIntervalMs?: number;
  onLiveRefresh?: () => Promise<void> | void;
}

export interface SharedLibraryUpdateRunResult {
  updatedAt: number;
  changedMangaIds: number[];
  jobsInfo: any | null;
  cancelled: boolean;
  issues: LibraryUpdateIssueInput[];
  preloadedChapters: Map<number, Chapter[]>;
}

export interface LibraryUpdateIssueInput {
  runId: string;
  contentKind: LibraryUpdateIssueKind;
  title: string;
  itemId: string;
  sourceId: string;
  sourceName: string;
  extensionName: string;
  message: string;
  errorType: LibraryUpdateIssueErrorType;
  actionUrl?: string;
  retrySourceId?: string;
  retryKind?: "comics-source" | "novels-source";
  recoveryHint?: "flaresolverr" | "webview" | "external-browser";
  affectedCount?: number;
}

let activeLibraryUpdateRun: Promise<SharedLibraryUpdateRunResult> | null = null;
let stopLibraryUpdateRun: Promise<boolean> | null = null;
let libraryUpdateStopRequested = false;

function updateRunId() {
  return `library-update:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

export function libraryUpdatePercent(current: number, total: number) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const boundedCurrent = Math.max(0, Math.min(total, current));
  if (boundedCurrent >= total) return 100;
  return Math.max(0, Math.min(99, Math.floor((boundedCurrent / total) * 100)));
}

export function libraryUpdateProgressNumbers(jobsInfo: any): LibraryUpdateProgressNumbers | undefined {
  const total = Number(jobsInfo?.totalJobs ?? 0);
  if (!Number.isFinite(total) || total <= 0) return undefined;
  const current = Math.max(0, Math.min(total, Number(jobsInfo?.finishedJobs ?? 0)));
  return {
    current,
    total,
    percent: jobsInfo?.isRunning && current >= total ? 99 : libraryUpdatePercent(current, total),
  };
}

function isLibraryUpdateComplete(jobsInfo: any): boolean {
  const total = Number(jobsInfo?.totalJobs ?? 0);
  const finished = Number(jobsInfo?.finishedJobs ?? 0);
  return !jobsInfo?.isRunning && total > 0 && finished >= total;
}

function isLibraryUpdateCancelled(jobsInfo: any): boolean {
  const total = Number(jobsInfo?.totalJobs ?? 0);
  const finished = Number(jobsInfo?.finishedJobs ?? 0);
  return !jobsInfo?.isRunning && total > 0 && finished > 0 && finished < total;
}

export function formatLibraryUpdateProgress(jobsInfo: any) {
  const finished = Number(jobsInfo?.finishedJobs ?? 0);
  const total = Number(jobsInfo?.totalJobs ?? 0);
  const skippedMangas = Number(jobsInfo?.skippedMangasCount ?? 0);
  if (total > 0) {
    const skipped = skippedMangas > 0 ? translate("libraryUpdate.skipped", { count: skippedMangas }) : "";
    if (finished <= 0 && jobsInfo?.isRunning) {
      return translate("libraryUpdate.starting", { total, skipped });
    }
    const current = Math.min(Math.max(0, finished), total);
    const percent = libraryUpdatePercent(current, total);
    if (jobsInfo?.isRunning && current >= total) {
      return translate("libraryUpdate.finalizing", { total, skipped });
    }
    if (!jobsInfo?.isRunning && current >= total) {
      return translate("libraryUpdate.checked", { total, skipped });
    }
    if (!jobsInfo?.isRunning && current < total) {
      return translate("libraryUpdate.stopped", { current, total, skipped });
    }
    return translate("libraryUpdate.checking", { current, total, percent, skipped });
  }
  if (jobsInfo?.isRunning) return translate("libraryUpdate.checkingServer");
  return translate("libraryUpdate.preparing");
}

export function formatLibraryUpdateFinalSummary(
  label: string,
  jobsInfo: any,
  issueCount = 0,
) {
  const total = Number(jobsInfo?.totalJobs ?? 0);
  const finished = Math.max(0, Math.min(total, Number(jobsInfo?.finishedJobs ?? 0)));
  const suffix = issueCount > 0
    ? ` with ${issueCount} issue${issueCount === 1 ? "" : "s"}`
    : "";

  if (total > 0) {
    if (finished >= total) return `${label} checked ${total}/${total} titles${suffix}.`;
    return `${label} stopped after ${finished}/${total} titles${suffix}.`;
  }

  return `${label} update finished${suffix}.`;
}

export function formatLibraryUpdateWaiting() {
  return "Waiting for Suwayomi progress.";
}

function sourceParallelism(reason: SharedLibraryUpdateRunOptions["reason"]) {
  if (reason === "auto-library-update") return 1;
  const intensity = store.settings.libraryUpdateIntensity ?? "fast";
  if (intensity === "eco") return 1;
  if (intensity === "balanced") return 2;
  return 4;
}

function perTitleTimeoutMs(reason: SharedLibraryUpdateRunOptions["reason"]) {
  if (reason === "auto-library-update") return 75_000;
  const intensity = store.settings.libraryUpdateIntensity ?? "fast";
  if (intensity === "eco") return 75_000;
  if (intensity === "balanced") return 60_000;
  return 45_000;
}

function sourceCircuitBreakerLimit(reason: SharedLibraryUpdateRunOptions["reason"]) {
  return reason === "auto-library-update" ? 3 : 5;
}

function classifyUpdateError(error: unknown): LibraryUpdateIssueErrorType {
  return classifySourceAccessError(error).errorType;
}

function errorMessage(error: unknown) {
  return sourceAccessErrorMessage(error);
}

function isSourceWideUpdateError(error: unknown) {
  return classifySourceAccessError(error).sourceWide;
}

function sourceKeyForManga(manga: Manga) {
  return String(manga.source?.id ?? manga.sourceId ?? "unknown");
}

function sourceNameForManga(manga: Manga) {
  return manga.source?.displayName || manga.source?.name || sourceKeyForManga(manga);
}

function actionUrlForMangas(mangas: Manga[]) {
  return mangas.find((manga) => typeof manga.realUrl === "string" && manga.realUrl.trim())?.realUrl?.trim();
}

function excludedMangaIdsFromCategories(categories = store.categories) {
  const excluded = new Set<number>();
  for (const category of categories) {
    if (String(category.includeInUpdate).toUpperCase() !== "EXCLUDE") continue;
    for (const manga of category.mangas?.nodes ?? []) {
      if (Number.isFinite(manga.id)) excluded.add(manga.id);
    }
  }
  return excluded;
}

function categoryFilterMangaIds(categoryIds?: number[], categories = store.categories) {
  if (!categoryIds?.length) return null;
  const allowed = new Set<number>();
  const categoryIdSet = new Set(categoryIds.map(Number).filter(Number.isFinite));
  for (const category of categories) {
    if (!categoryIdSet.has(category.id)) continue;
    for (const manga of category.mangas?.nodes ?? []) {
      if (Number.isFinite(manga.id)) allowed.add(manga.id);
    }
  }
  return allowed.size > 0 ? allowed : null;
}

async function loadUpdateCategoriesForRules(): Promise<Category[]> {
  try {
    const data = await gql<{ categories: { nodes: Category[] } }>(
      GET_CATEGORIES_WITH_MANGA_IDS,
      undefined,
      undefined,
      12_000,
    );
    return data.categories.nodes;
  } catch (error) {
    console.warn("Could not load category update rules with members; falling back to local category snapshot.", error);
    return store.categories;
  }
}

function eligibleLibraryManga(categoryIds: number[] | undefined, categories: Category[]) {
  const excluded = excludedMangaIdsFromCategories(categories);
  const allowed = categoryFilterMangaIds(categoryIds, categories);
  return store.libraryMangaSnapshot.filter((manga) => {
    if (!manga.inLibrary) return false;
    if (excluded.has(manga.id)) return false;
    if (allowed && !allowed.has(manga.id)) return false;
    return true;
  });
}

function sourceScopedManga(mangas: Manga[], sourceIds?: string[]) {
  if (!sourceIds?.length) return mangas;
  const allowed = new Set(sourceIds.map(String));
  return mangas.filter((manga) => allowed.has(sourceKeyForManga(manga)));
}

async function fetchChaptersForUpdate(manga: Manga, timeoutMs: number) {
  const data = await fetchSourceMangaChapters(
    { mangaId: manga.id, sourceId: manga.source?.id ?? manga.sourceId },
    AbortSignal.timeout(timeoutMs),
  );
  return data.fetchChapters.chapters ?? [];
}

async function runComicsSourceQueueUpdate(
  options: SharedLibraryUpdateRunOptions,
  runId: string,
): Promise<{
  changedMangaIds: number[];
  issues: LibraryUpdateIssueInput[];
  preloadedChapters: Map<number, Chapter[]>;
  jobsInfo: any;
}> {
  const updateCategories = await loadUpdateCategoriesForRules();
  const queue = sourceScopedManga(eligibleLibraryManga(options.categories, updateCategories), options.sourceIds);
  const total = queue.length;
  const preloadedChapters = new Map<number, Chapter[]>();
  const issues: LibraryUpdateIssueInput[] = [];
  const changedMangaIds = new Set<number>();
  const groups = new Map<string, Manga[]>();
  let finishedJobs = 0;
  let workingSnapshot = store.libraryMangaSnapshot;
  let pendingSnapshotCommit: Manga[] | null = null;
  let snapshotCommitTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSnapshotCommitAt = 0;
  let lastProgressPublishAt = 0;
  let lastProgressPercent = -1;

  for (const manga of queue.sort((left, right) => sourceNameForManga(left).localeCompare(sourceNameForManga(right)) || left.title.localeCompare(right.title))) {
    const key = sourceKeyForManga(manga);
    const current = groups.get(key) ?? [];
    current.push(manga);
    groups.set(key, current);
  }

  const sourceEntries = [...groups.entries()].map(([sourceId, mangas]) => ({
    sourceId,
    sourceName: sourceNameForManga(mangas[0]),
    mangas,
  }));

  const commitSnapshotNow = () => {
    if (snapshotCommitTimer) {
      clearTimeout(snapshotCommitTimer);
      snapshotCommitTimer = null;
    }
    if (!pendingSnapshotCommit) return;
    setLibraryMangaSnapshot(pendingSnapshotCommit);
    cache.set(CACHE_KEYS.LIBRARY, pendingSnapshotCommit, CACHE_GROUPS.LIBRARY);
    pendingSnapshotCommit = null;
    lastSnapshotCommitAt = Date.now();
  };

  const scheduleSnapshotCommit = (nextSnapshot: Manga[]) => {
    pendingSnapshotCommit = nextSnapshot;
    const elapsed = Date.now() - lastSnapshotCommitAt;
    if (elapsed >= 900) {
      commitSnapshotNow();
      return;
    }
    if (snapshotCommitTimer) return;
    snapshotCommitTimer = setTimeout(commitSnapshotNow, Math.max(120, 900 - elapsed));
  };

  const publishProgress = (currentTitle?: string, sourceName?: string, force = false) => {
    const jobsInfo = {
      isRunning: true,
      finishedJobs,
      totalJobs: total,
      skippedCategoriesCount: 0,
      skippedMangasCount: 0,
    };
    const percent = libraryUpdatePercent(finishedJobs, total);
    const now = Date.now();
    const shouldPublish = force
      || percent !== lastProgressPercent
      || now - lastProgressPublishAt >= 900
      || finishedJobs >= total;
    if (!shouldPublish) return jobsInfo;

    lastProgressPublishAt = now;
    lastProgressPercent = percent;
    const detail = currentTitle && sourceName ? ` - ${sourceName}: ${currentTitle}` : "";
    showLibraryUpdateProgress(
      total > 0
        ? `Checking titles ${Math.min(finishedJobs, total)}/${total} - ${percent}%${detail}.`
        : "No eligible comics titles to update.",
      0,
      total > 0 ? { current: Math.min(finishedJobs, total), total, percent } : undefined,
    );
    return jobsInfo;
  };

  publishProgress(undefined, undefined, true);

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(sourceParallelism(options.reason), sourceEntries.length || 1));
  const timeoutMs = perTitleTimeoutMs(options.reason);
  const breakerLimit = sourceCircuitBreakerLimit(options.reason);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < sourceEntries.length && !libraryUpdateStopRequested) {
      const group = sourceEntries[cursor++];
      let consecutiveFailures = 0;
      for (let index = 0; index < group.mangas.length; index += 1) {
        const manga = group.mangas[index];
        if (libraryUpdateStopRequested) break;
        publishProgress(manga.title, group.sourceName);
        try {
          const chapters = await fetchChaptersForUpdate(manga, timeoutMs);
          preloadedChapters.set(manga.id, chapters);
          consecutiveFailures = 0;
          let changed = false;
          const nextSnapshot = workingSnapshot.map((entry) => {
            if (entry.id !== manga.id) return entry;
            const next = mergeMangaCountsFromChapters(entry, chapters);
            changed = next !== entry;
            return next;
          });
          if (changed) {
            changedMangaIds.add(manga.id);
            workingSnapshot = nextSnapshot;
            scheduleSnapshotCommit(nextSnapshot);
          }
        } catch (error) {
          consecutiveFailures += 1;
          const message = errorMessage(error);
          const classification = classifySourceAccessError(error);
          const sourceWideError = isSourceWideUpdateError(error);
          if (sourceWideError) {
            const affectedTitles = group.mangas.length - index;
            const isChallenge = classification.errorType === "source-challenge";
            issues.push({
              runId,
              contentKind: "manga",
              title: group.sourceName,
              itemId: `source:${group.sourceId}`,
              sourceId: group.sourceId,
              sourceName: group.sourceName,
              extensionName: group.sourceName,
              message: isChallenge
                ? `${affectedTitles} title${affectedTitles === 1 ? "" : "s"} need source challenge recovery: ${message}`
                : `${affectedTitles} title${affectedTitles === 1 ? "" : "s"} could not refresh because this source is unavailable: ${message}`,
              errorType: classification.errorType,
              actionUrl: actionUrlForMangas(group.mangas.slice(index)),
              retrySourceId: group.sourceId,
              retryKind: "comics-source",
              recoveryHint: isChallenge ? "flaresolverr" : undefined,
              affectedCount: affectedTitles,
            });
            consecutiveFailures = breakerLimit;
            finishedJobs += affectedTitles;
            publishProgress(undefined, undefined, true);
            break;
          }
          issues.push({
            runId,
            contentKind: "manga",
            title: manga.title,
            itemId: String(manga.id),
            sourceId: group.sourceId,
            sourceName: group.sourceName,
            extensionName: group.sourceName,
            message,
            errorType: classifyUpdateError(error),
            retrySourceId: group.sourceId,
            retryKind: "comics-source",
          });
          if (consecutiveFailures >= breakerLimit) {
            const deferredCount = group.mangas.length - index - 1;
            if (deferredCount > 0) {
              issues.push({
                runId,
                contentKind: "manga",
                title: group.sourceName,
                itemId: `source:${group.sourceId}:deferred`,
                sourceId: group.sourceId,
                sourceName: group.sourceName,
                extensionName: group.sourceName,
                message: `${deferredCount} title${deferredCount === 1 ? "" : "s"} deferred after ${consecutiveFailures} consecutive failures.`,
                errorType: "deferred",
                retrySourceId: group.sourceId,
                retryKind: "comics-source",
                affectedCount: deferredCount,
              });
            }
            finishedJobs += group.mangas.length - index;
            publishProgress(undefined, undefined, true);
            break;
          }
        } finally {
          if (consecutiveFailures < breakerLimit) finishedJobs += 1;
          if (options.onLiveRefresh && finishedJobs % 16 === 0) {
            void Promise.resolve(options.onLiveRefresh()).catch((liveRefreshError) => {
              console.warn("Could not refresh Library during source queue update:", liveRefreshError);
            });
          }
          publishProgress();
        }
      }
    }
  }));
  commitSnapshotNow();

  const finalJobsInfo = {
    isRunning: false,
    finishedJobs: Math.min(finishedJobs, total),
    totalJobs: total,
    skippedCategoriesCount: 0,
    skippedMangasCount: 0,
  };
  showLibraryUpdateProgress(
    formatLibraryUpdateProgress(finalJobsInfo),
    1800,
    total > 0 ? { current: finalJobsInfo.finishedJobs, total, percent: 100 } : undefined,
  );

  return {
    changedMangaIds: [...changedMangaIds],
    issues,
    preloadedChapters,
    jobsInfo: finalJobsInfo,
  };
}

export function formatLibraryUpdateStalled(jobsInfo: any, stalledMs: number) {
  const total = Number(jobsInfo?.totalJobs ?? 0);
  const finished = Math.max(0, Math.min(total, Number(jobsInfo?.finishedJobs ?? 0)));
  const seconds = Math.max(10, Math.floor(stalledMs / 1000));
  if (total > 0) {
    return translate("libraryUpdate.stalled", { current: finished, total, seconds });
  }
  return translate("libraryUpdate.waitingSlow", { seconds });
}

export function showLibraryUpdateProgress(
  body: string,
  duration = 0,
  progress?: LibraryUpdateProgressNumbers,
) {
  const lowerBody = body.toLowerCase();
  setLibraryUpdateProgress({
    kind: lowerBody.includes("failed") ? "error" : lowerBody.includes("finished") || lowerBody.includes("complete") ? "success" : "download",
    title: translate("libraryUpdate.title"),
    body,
    active: duration === 0,
    duration,
    ...progress,
  });
}

export function applyLibraryUpdateMangaPatches(patches: LibraryUpdateMangaPatch[]) {
  if (!patches.length || store.libraryMangaSnapshot.length === 0) return [] as number[];
  const patchById = new Map<number, LibraryUpdateMangaPatch["manga"]>();
  for (const patch of patches) {
    const manga = patch.manga;
    if (!manga?.id) continue;
    patchById.set(Number(manga.id), manga);
  }
  if (!patchById.size) return [] as number[];

  const changedIds: number[] = [];
  const patched = store.libraryMangaSnapshot.map((manga) => {
    const patch = patchById.get(manga.id);
    if (!patch) return manga;
    changedIds.push(manga.id);
    const patchThumbnail = typeof patch.thumbnailUrl === "string" && patch.thumbnailUrl.trim()
      ? patch.thumbnailUrl
      : manga.thumbnailUrl;
    return {
      ...manga,
      title: patch.title ?? manga.title,
      thumbnailUrl: patchThumbnail,
      unreadCount: patch.unreadCount ?? manga.unreadCount,
      downloadCount: patch.downloadCount ?? manga.downloadCount,
      chapterCount: patch.chapters?.totalCount ?? manga.chapterCount,
    };
  });

  if (changedIds.length) {
    setLibraryMangaSnapshot(patched);
    cache.set(CACHE_KEYS.LIBRARY, patched, CACHE_GROUPS.LIBRARY);
  }
  return changedIds;
}

export async function fetchLibraryUpdateStatusDirect(timeoutMs = 3500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const auth = getServerAuthHeader();
  try {
    const response = await fetch(`${getServerUrl()}/api/graphql`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        ...(auth ? { Authorization: auth } : {}),
      },
      body: JSON.stringify({
        query: `
          query LibraryUpdateStatusLive {
            libraryUpdateStatus {
              jobsInfo {
                isRunning
                finishedJobs
                totalJobs
                skippedCategoriesCount
                skippedMangasCount
              }
            }
          }
        `,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Suwayomi HTTP ${response.status}`);
    const json = await response.json();
    if (json.errors?.length) throw new Error(json.errors[0]?.message ?? "Could not read library update status.");
    return json.data?.libraryUpdateStatus?.jobsInfo ?? null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function readLibraryUpdateStatusLive() {
  const directStatus = await fetchLibraryUpdateStatusDirect(2500).catch((directError) => {
    console.warn("Could not poll Library update status directly:", directError);
    return null;
  });
  if (directStatus) return directStatus;

  return gql<any>(GET_LIBRARY_UPDATE_STATUS, undefined, undefined, 2500)
    .then((status) => status?.libraryUpdateStatus?.jobsInfo ?? null)
    .catch((clientError) => {
      console.warn("Could not poll Library update status through app client:", clientError);
      return null;
    });
}

export async function waitForLibraryUpdateToSettle(
  initialJobsInfo: any = null,
  timeoutMs = 8 * 60 * 1000,
  onProgress?: (jobsInfo: any) => void,
  onWaiting?: (elapsedMs: number) => void,
) {
  const startedAt = Date.now();
  let observedRunning = Boolean(initialJobsInfo?.isRunning);
  let observedJobs = Number(initialJobsInfo?.totalJobs ?? 0) > 0 || Number(initialJobsInfo?.finishedJobs ?? 0) > 0;

  while (Date.now() - startedAt < timeoutMs) {
    const jobsInfo = await readLibraryUpdateStatusLive();
    const hasMeaningfulJobs = Number(jobsInfo?.totalJobs ?? 0) > 0 || Number(jobsInfo?.finishedJobs ?? 0) > 0;
    if (jobsInfo) {
      observedRunning ||= Boolean(jobsInfo.isRunning);
      observedJobs ||= hasMeaningfulJobs;
      if (jobsInfo.isRunning || hasMeaningfulJobs) {
        onProgress?.(jobsInfo);
      }
    } else {
      onWaiting?.(Date.now() - startedAt);
    }

    if (!jobsInfo?.isRunning && (observedRunning || observedJobs)) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return jobsInfo ?? initialJobsInfo ?? null;
    }
    if (!jobsInfo?.isRunning && Date.now() - startedAt > 5000) return jobsInfo ?? initialJobsInfo ?? null;
    await new Promise<void>((resolve) => setTimeout(resolve, jobsInfo?.isRunning ? 2500 : 500));
  }

  return null;
}

export async function ensureAethonLibraryUpdateRules() {
  await gql(SET_LIBRARY_UPDATE_RULES, {
    excludeCompleted: false,
    excludeEntryWithUnreadChapters: false,
    excludeNotStarted: false,
    excludeUnreadChapters: false,
  }).catch((error) => {
    console.warn("Could not update Suwayomi library update rules:", error);
  });
}

export function isSharedLibraryUpdateRunning() {
  return Boolean(activeLibraryUpdateRun);
}

export async function clearStaleLibraryUpdateInFlight() {
  if (!store.libraryUpdateInFlight && !store.libraryUpdateProgress?.active) return false;

  const jobsInfo = await readLibraryUpdateStatusLive();
  if (!jobsInfo || jobsInfo.isRunning) return false;

  const total = Number(jobsInfo.totalJobs ?? 0);
  const finished = Number(jobsInfo.finishedJobs ?? 0);
  if (total > 0 && finished < total) return false;

  store.setLibraryUpdateInFlight(false);
  showLibraryUpdateProgress(
    total > 0 ? formatLibraryUpdateProgress(jobsInfo) : "Library update complete.",
    1800,
    libraryUpdateProgressNumbers(jobsInfo),
  );
  return true;
}

export function stopSharedLibraryUpdate() {
  if (stopLibraryUpdateRun) return stopLibraryUpdateRun;

  stopLibraryUpdateRun = (async () => {
    libraryUpdateStopRequested = true;
    showLibraryUpdateProgress("Stopping library update.");
    await gql(UPDATE_STOP).catch((error) => {
      console.warn("Could not send Suwayomi batch stop request; local source queue stop was still requested.", error);
    });
    if (activeLibraryUpdateRun) {
      showLibraryUpdateProgress("Stop requested. Finishing the current title before stopping.");
      return true;
    }
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const jobsInfo = await readLibraryUpdateStatusLive();
      if (jobsInfo && !jobsInfo.isRunning) {
        showLibraryUpdateProgress(
          Number(jobsInfo.totalJobs ?? 0) > 0 ? formatLibraryUpdateProgress(jobsInfo) : "Library update stopped.",
          1800,
          libraryUpdateProgressNumbers(jobsInfo),
        );
        return true;
      }
      if (jobsInfo) {
        showLibraryUpdateProgress(
          `Stopping library update - checked ${Number(jobsInfo.finishedJobs ?? 0)}/${Number(jobsInfo.totalJobs ?? 0)} titles.`,
          0,
          libraryUpdateProgressNumbers(jobsInfo),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    showLibraryUpdateProgress("Stop requested. Waiting for Suwayomi to settle.");
    return false;
  })()
    .catch((error) => {
      console.warn("Could not stop Library update:", error);
      showLibraryUpdateProgress("Could not stop library update.", 2200);
      return false;
    })
    .finally(() => {
      stopLibraryUpdateRun = null;
    });

  return stopLibraryUpdateRun;
}

export function runSharedLibraryUpdate(options: SharedLibraryUpdateRunOptions) {
  if (activeLibraryUpdateRun) return activeLibraryUpdateRun;

  activeLibraryUpdateRun = withSuwayomiOperationLease("library-update", async () => {
    const runId = updateRunId();

    try {
      showLibraryUpdateProgress(
        options.reason === "auto-library-update"
          ? "Automatic library update is starting."
          : "Waking Suwayomi and preparing update.",
      );
      const awake = await ensureServerAwakeFor(options.reason, {
        serverUrl: store.runtimeServerUrl,
        binary: store.settings.serverBinary,
        updateIntensity: store.settings.libraryUpdateIntensity,
        profileId: store.runtimeResolvedLocalProfileId,
        profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? store.runtimeServerLabel,
      });
      if (!awake) throw new Error("Suwayomi is not reachable.");

      showLibraryUpdateProgress("Applying Aethon update rules.");
      await ensureAethonLibraryUpdateRules();
      showLibraryUpdateProgress("Suwayomi is checking your library.");

      const sourceQueueResult = await runComicsSourceQueueUpdate(options, runId);
      return {
        updatedAt: Date.now(),
        changedMangaIds: sourceQueueResult.changedMangaIds,
        jobsInfo: sourceQueueResult.jobsInfo,
        cancelled: libraryUpdateStopRequested,
        issues: sourceQueueResult.issues,
        preloadedChapters: sourceQueueResult.preloadedChapters,
      };
    } finally {
      libraryUpdateStopRequested = false;
      activeLibraryUpdateRun = null;
    }
  });

  return activeLibraryUpdateRun;
}

export function retryComicsLibrarySourceUpdate(
  sourceId: string,
  options: Omit<SharedLibraryUpdateRunOptions, "reason" | "sourceIds"> & {
    reason?: SharedLibraryUpdateRunOptions["reason"];
  } = {},
) {
  return runSharedLibraryUpdate({
    ...options,
    reason: options.reason ?? "manual-library-update",
    sourceIds: [sourceId],
  });
}
