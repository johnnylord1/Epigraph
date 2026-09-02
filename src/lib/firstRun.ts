export const FIRST_RUN_VERSION = 1;
export type FirstRunStep = "theme" | "entry" | "sync" | "backup" | "sources" | "trackers" | "discover" | "complete";
export type FirstRunPath = "sync" | "backup" | "fresh";

export interface FirstRunState {
  version: typeof FIRST_RUN_VERSION;
  status: "pending" | "complete";
  step: FirstRunStep;
  path: FirstRunPath | null;
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

  return {
    version: FIRST_RUN_VERSION,
    status: "pending",
    step: candidate.step as FirstRunStep,
    path,
  };
}

export function updateFirstRunState(
  current: FirstRunState,
  patch: Partial<Pick<FirstRunState, "step" | "path">>,
): FirstRunState {
  if (current.status === "complete") return current;
  return { ...current, ...patch };
}

export function completeFirstRunState(current: FirstRunState): FirstRunState {
  return {
    ...current,
    version: FIRST_RUN_VERSION,
    status: "complete",
    step: "complete",
  };
}
