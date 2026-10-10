import {
  DEFAULT_LOCAL_PROFILE_ID,
  normalizeLocalProfileId,
  normalizeServerUrl,
  type LocalProfileId,
} from "../localProfiles";
import {
  normalizeEpigraphNovelsSnapshot,
  type EpigraphNovelsSnapshot,
  type RestoredEpigraphNovelsSnapshot,
} from "./novelsBackup";

const NOVELS_PROFILE_STATE_KEY = "epigraph-novels-profile-state";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function storageOrNull(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function resolveNovelsProfileScope(input: {
  profileId?: LocalProfileId | null;
  serverUrl?: string | null;
}): string {
  const profileId = normalizeLocalProfileId(input.profileId);
  if (profileId) return `profile:${profileId}`;
  const serverUrl = normalizeServerUrl(input.serverUrl);
  if (serverUrl) return `server:${encodeURIComponent(serverUrl)}`;
  return `profile:${DEFAULT_LOCAL_PROFILE_ID}`;
}

function readStateMap(storage = storageOrNull()): Record<string, EpigraphNovelsSnapshot> {
  if (!storage) return {};
  const raw = storage.getItem(NOVELS_PROFILE_STATE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, EpigraphNovelsSnapshot>;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([scope, snapshot]) => [scope, normalizeEpigraphNovelsSnapshot(snapshot)]),
    );
  } catch {
    return {};
  }
}

function writeStateMap(next: Record<string, EpigraphNovelsSnapshot>, storage = storageOrNull()): void {
  if (!storage) return;
  storage.setItem(NOVELS_PROFILE_STATE_KEY, JSON.stringify(next));
}

export function loadNovelsProfileSnapshot(
  scope: string,
  storage = storageOrNull(),
): EpigraphNovelsSnapshot {
  const map = readStateMap(storage);
  return normalizeEpigraphNovelsSnapshot(map[scope] ?? {
    entries: [],
    chapters: [],
    progress: [],
    bookmarks: [],
    history: [],
    repositories: [],
    plugins: [],
  });
}

export function saveNovelsProfileSnapshot(
  scope: string,
  snapshot: EpigraphNovelsSnapshot,
  storage = storageOrNull(),
): EpigraphNovelsSnapshot {
  const normalized = normalizeEpigraphNovelsSnapshot(snapshot);
  const next = readStateMap(storage);
  next[scope] = normalized;
  writeStateMap(next, storage);
  return normalized;
}

export function applyRestoredNovelsProfileSnapshot(
  scope: string,
  restored: RestoredEpigraphNovelsSnapshot,
  storage = storageOrNull(),
): EpigraphNovelsSnapshot {
  if (restored.summary.restoredNeedsRepositoryCount > 0 || restored.summary.restoredNeedsPluginCount > 0) {
    throw new Error("Blocked novels payloads cannot be applied until repositories and plugins are available.");
  }

  return saveNovelsProfileSnapshot(scope, {
    entries: restored.entries,
    chapters: restored.chapters,
    progress: restored.progress,
    bookmarks: restored.bookmarks,
    history: restored.history,
    repositories: restored.repositories,
    plugins: restored.plugins,
  }, storage);
}
