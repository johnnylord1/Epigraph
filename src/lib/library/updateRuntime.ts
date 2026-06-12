import { getServerAuthHeader, getServerUrl, gql } from "../client";
import { cache, CACHE_GROUPS, CACHE_KEYS } from "../cache";
import { GET_LIBRARY_UPDATE_STATUS, SET_LIBRARY_UPDATE_RULES, UPDATE_LIBRARY } from "../queries";
import {
  subscribeLibraryUpdateStatus,
  type LibraryUpdateMangaPatch,
  type LibraryUpdateSubscription,
} from "../suwayomiUpdaterSubscription";
import { ensureServerAwakeFor, type ServerWakeReason } from "../serverLifecycle";
import { setLibraryMangaSnapshot, setLibraryUpdateProgress, store } from "../../store/state.svelte";

export interface LibraryUpdateProgressNumbers {
  current: number;
  total: number;
  percent: number;
}

export interface SharedLibraryUpdateRunOptions {
  reason: Extract<ServerWakeReason, "manual-library-update" | "auto-library-update">;
  categories?: number[];
  timeoutMs?: number;
  liveRefreshIntervalMs?: number;
  onLiveRefresh?: () => Promise<void> | void;
}

export interface SharedLibraryUpdateRunResult {
  updatedAt: number;
  changedMangaIds: number[];
  jobsInfo: any | null;
}

let activeLibraryUpdateRun: Promise<SharedLibraryUpdateRunResult> | null = null;

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

export function formatLibraryUpdateProgress(jobsInfo: any) {
  const finished = Number(jobsInfo?.finishedJobs ?? 0);
  const total = Number(jobsInfo?.totalJobs ?? 0);
  const skippedMangas = Number(jobsInfo?.skippedMangasCount ?? 0);
  if (total > 0) {
    const skipped = skippedMangas > 0 ? `, ${skippedMangas} skipped by folder rules` : "";
    if (finished <= 0 && jobsInfo?.isRunning) {
      return `Starting update for ${total} titles${skipped}.`;
    }
    const current = Math.min(Math.max(0, finished), total);
    const percent = libraryUpdatePercent(current, total);
    if (jobsInfo?.isRunning && current >= total) {
      return `Finalizing update for ${total} titles${skipped}.`;
    }
    if (!jobsInfo?.isRunning && current >= total) {
      return `Checked ${total}/${total} titles - complete${skipped}.`;
    }
    return `Checking titles ${current}/${total} - ${percent}%${skipped}.`;
  }
  if (jobsInfo?.isRunning) return "Suwayomi is checking your library.";
  return "Preparing library update.";
}

export function formatLibraryUpdateWaiting() {
  return "Waiting for Suwayomi progress.";
}

export function showLibraryUpdateProgress(
  body: string,
  duration = 0,
  progress?: LibraryUpdateProgressNumbers,
) {
  const lowerBody = body.toLowerCase();
  setLibraryUpdateProgress({
    kind: lowerBody.includes("failed") ? "error" : lowerBody.includes("finished") || lowerBody.includes("complete") ? "success" : "download",
    title: "Library update",
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
    return {
      ...manga,
      title: patch.title ?? manga.title,
      thumbnailUrl: patch.thumbnailUrl ?? manga.thumbnailUrl,
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
    await new Promise((resolve) => setTimeout(jobsInfo?.isRunning ? 2500 : 500));
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

export function runSharedLibraryUpdate(options: SharedLibraryUpdateRunOptions) {
  if (activeLibraryUpdateRun) return activeLibraryUpdateRun;

  activeLibraryUpdateRun = (async () => {
    let progressSubscription: LibraryUpdateSubscription | null = null;
    const changedMangaIds = new Set<number>();
    let lastLiveRefreshAt = 0;

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
      });
      if (!awake) throw new Error("Suwayomi is not reachable.");

      showLibraryUpdateProgress("Applying Aethon update rules.");
      await ensureAethonLibraryUpdateRules();
      showLibraryUpdateProgress("Suwayomi is checking your library.");

      progressSubscription = subscribeLibraryUpdateStatus(
        (event) => {
          const complete = isLibraryUpdateComplete(event.jobsInfo);
          showLibraryUpdateProgress(
            formatLibraryUpdateProgress(event.jobsInfo),
            complete ? 1800 : 0,
            libraryUpdateProgressNumbers(event.jobsInfo),
          );
          for (const mangaId of applyLibraryUpdateMangaPatches(event.mangaUpdates)) {
            changedMangaIds.add(mangaId);
          }
        },
        (subscriptionError) => {
          console.warn("Could not receive live Library update progress:", subscriptionError);
        },
      );

      const updateResult = await gql<any>(UPDATE_LIBRARY, { categories: options.categories });
      const initialJobsInfo = updateResult?.updateLibrary?.updateStatus?.jobsInfo;
      const jobsInfo = await waitForLibraryUpdateToSettle(
        initialJobsInfo,
        options.timeoutMs ?? 8 * 60 * 1000,
        (progressJobsInfo) => {
          const complete = isLibraryUpdateComplete(progressJobsInfo);
          showLibraryUpdateProgress(
            formatLibraryUpdateProgress(progressJobsInfo),
            complete ? 1800 : 0,
            libraryUpdateProgressNumbers(progressJobsInfo),
          );
          if (!progressJobsInfo?.isRunning || !options.onLiveRefresh) return;
          const now = Date.now();
          const refreshInterval = Math.max(1000, options.liveRefreshIntervalMs ?? 5000);
          if (now - lastLiveRefreshAt < refreshInterval) return;
          lastLiveRefreshAt = now;
          void Promise.resolve(options.onLiveRefresh()).catch((liveRefreshError) => {
            console.warn("Could not refresh Library during update:", liveRefreshError);
          });
        },
        () => {
          showLibraryUpdateProgress(formatLibraryUpdateWaiting());
        },
      );

      const updatedAt = Date.now();
      return {
        updatedAt,
        changedMangaIds: Array.from(changedMangaIds),
        jobsInfo,
      };
    } finally {
      progressSubscription?.close();
      activeLibraryUpdateRun = null;
    }
  })();

  return activeLibraryUpdateRun;
}
