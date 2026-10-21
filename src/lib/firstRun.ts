export const FIRST_RUN_VERSION = 1;
export const FIRST_RUN_STORAGE_KEY = "epigraph-first-run";
export const FIRST_RUN_COMPLETED_EVENT = "epigraph:first-run-completed";
/** Setup was started over from inside the app (Settings); the shell shows it at once. */
export const FIRST_RUN_REOPENED_EVENT = "epigraph:first-run-reopened";
export type FirstRunStep = "theme" | "entry" | "sync" | "backup" | "sources" | "trackers" | "discover" | "complete";
export type FirstRunPath = "sync" | "backup" | "fresh";

export interface FirstRunState {
  version: typeof FIRST_RUN_VERSION;
  status: "pending" | "complete";
  step: FirstRunStep;
  path: FirstRunPath | null;
  backupRestored?: true;
  backupNeedsSources?: boolean;
  backupSourceTypes?: Array<"manga" | "novels">;
  sourceContentType?: "manga" | "novels";
  /** Setup was started over from Settings: the user can leave it and keep the app as it was. */
  cancellable?: true;
}

export interface FirstRunReadiness {
  syncConnected: boolean;
  backupRestored: boolean;
  sourcesConfigured: boolean;
  hasLibraryContent: boolean;
}

export interface FirstRunSourceSetupSnapshot {
  repositoryCount: number;
  installedCount: number;
  loading: boolean;
  hasError: boolean;
}

export interface FirstRunBackupReadiness {
  ready: boolean;
  hasSelection: boolean;
  contentType: "manga" | "novels";
  requiresSources?: boolean;
  sourceTypes?: Array<"manga" | "novels">;
}

const STEPS: FirstRunStep[] = ["theme", "entry", "sync", "backup", "sources", "trackers", "discover", "complete"];
const PATHS: FirstRunPath[] = ["sync", "backup", "fresh"];

export function shouldStartFirstRun(marker: string | null, hasExistingStore: boolean): boolean {
  if (!marker) return !hasExistingStore;
  try {
    return JSON.parse(marker)?.status !== "complete";
  } catch {
    return true;
  }
}

/** Setup is still open: the shell waits for it, and so does background library work. */
export function readFirstRunPending(hasExistingStore: boolean): boolean {
  try {
    return shouldStartFirstRun(localStorage.getItem(FIRST_RUN_STORAGE_KEY), hasExistingStore);
  } catch {
    return false;
  }
}

/** Setup the user started over from Settings: it opens as asked, even on an app that holds data. */
export function readFirstRunReopenedByUser(): boolean {
  try {
    return JSON.parse(localStorage.getItem(FIRST_RUN_STORAGE_KEY) ?? "null")?.cancellable === true;
  } catch {
    return false;
  }
}

export function createFirstRunState(): FirstRunState {
  return {
    version: FIRST_RUN_VERSION,
    status: "pending",
    step: "theme",
    path: null,
  };
}

export function normalizeFirstRunState(savedStore: unknown): FirstRunState {
  if (!savedStore || typeof savedStore !== "object") return createFirstRunState();

  const root = savedStore as { firstRun?: Partial<FirstRunState> };
  if (!("firstRun" in root)) {
    return {
      version: FIRST_RUN_VERSION,
      status: "complete",
      step: "complete",
      path: null,
    };
  }

  const candidate = root.firstRun;
  if (!candidate || typeof candidate !== "object") return createFirstRunState();
  if (candidate.version !== FIRST_RUN_VERSION) return createFirstRunState();

  const path = PATHS.includes(candidate.path as FirstRunPath)
    ? candidate.path as FirstRunPath
    : null;
  if (candidate.status === "complete") {
    return { version: FIRST_RUN_VERSION, status: "complete", step: "complete", path };
  }
  if (candidate.status !== "pending" || !STEPS.includes(candidate.step as FirstRunStep)) {
    return createFirstRunState();
  }

  const step = candidate.step as FirstRunStep;
  const invalidPath = (step === "sync" && path !== "sync")
    || (step === "backup" && path !== "backup")
    || (step === "sources" && path !== "fresh" && path !== "backup")
    || (["trackers", "discover", "complete"].includes(step) && path === null);
  const cancellable = candidate.cancellable === true ? { cancellable: true as const } : {};
  if (invalidPath) return { ...createFirstRunState(), step: "entry", ...cancellable };

  return {
    version: FIRST_RUN_VERSION,
    status: "pending",
    step,
    path,
    ...(candidate.backupRestored === true ? { backupRestored: true as const } : {}),
    ...(typeof candidate.backupNeedsSources === "boolean" ? { backupNeedsSources: candidate.backupNeedsSources } : {}),
    ...(Array.isArray(candidate.backupSourceTypes) && candidate.backupSourceTypes.length > 0
      && candidate.backupSourceTypes.every((type) => type === "manga" || type === "novels")
      ? { backupSourceTypes: [...new Set(candidate.backupSourceTypes)] } : {}),
    ...(candidate.sourceContentType === "manga" || candidate.sourceContentType === "novels"
      ? { sourceContentType: candidate.sourceContentType } : {}),
    ...cancellable,
  };
}

export function updateFirstRunState(
  current: FirstRunState,
  patch: Partial<Pick<FirstRunState, "step" | "path" | "backupRestored" | "backupNeedsSources" | "backupSourceTypes" | "sourceContentType">>,
): FirstRunState {
  if (current.status === "complete") return current;
  return { ...current, ...patch };
}

export function completeFirstRunState(current: FirstRunState): FirstRunState {
  const { cancellable: _cancellable, ...rest } = current;
  return {
    ...rest,
    version: FIRST_RUN_VERSION,
    status: "complete",
    step: "complete",
  };
}

export function canAdvanceFirstRun(
  state: FirstRunState,
  readiness: FirstRunReadiness,
): boolean {
  switch (state.step) {
    case "sync":
      return readiness.syncConnected;
    case "backup":
      return readiness.backupRestored || state.backupRestored === true;
    case "sources":
      return (state.path === "backup" && !state.backupRestored) || readiness.sourcesConfigured;
    case "discover":
    case "complete":
      return readiness.hasLibraryContent;
    default:
      return true;
  }
}

export function isFirstRunSourceSetupReady(snapshot: FirstRunSourceSetupSnapshot): boolean {
  return !snapshot.loading
    && !snapshot.hasError
    && snapshot.repositoryCount > 0
    && snapshot.installedCount > 0;
}

export function isFirstRunBackupRestoreComplete(
  results: ReadonlyArray<{ status: "success" | "warning" | "failed" | "skipped" }> | null,
): boolean {
  if (!results?.some((result) => result.status === "success" || result.status === "warning")) return false;
  return results.every((result) => result.status !== "failed");
}

export function writeCompletedFirstRunMarker(
  storage: Pick<Storage, "getItem" | "setItem">,
): FirstRunState {
  let current = createFirstRunState();
  const marker = storage.getItem(FIRST_RUN_STORAGE_KEY);
  if (marker) {
    try { current = normalizeFirstRunState({ firstRun: JSON.parse(marker) }); } catch {}
  }
  const completed = completeFirstRunState(current);
  storage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify(completed));
  return completed;
}
