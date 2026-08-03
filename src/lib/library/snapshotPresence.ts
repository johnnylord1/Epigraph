import { normalizeLocalProfileId, normalizeServerUrl } from "../localProfiles";

export const LIBRARY_SNAPSHOT_KEY = "aethon-library-snapshots";

export interface LibrarySnapshotScope {
  profileId?: string | null;
  serverUrl?: string | null;
}

interface StorageLike {
  getItem(key: string): string | null;
}

function storageOrNull(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function librarySnapshotScopeKey(scope: LibrarySnapshotScope = {}) {
  const profileId = normalizeLocalProfileId(scope.profileId) ?? "default";
  const serverUrl = normalizeServerUrl(scope.serverUrl) ?? "unknown";
  return `${profileId}::${serverUrl}`;
}

function hasUsableRecord(value: unknown, idKey: string, textKey: string) {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Number.isFinite(Number(record[idKey]))
    && typeof record[textKey] === "string"
    && record[textKey].trim().length > 0;
}

export function hasLibrarySnapshot(scope: LibrarySnapshotScope = {}) {
  const storage = storageOrNull();
  if (!storage) return false;

  try {
    const raw = storage.getItem(LIBRARY_SNAPSHOT_KEY);
    if (!raw) return false;
    const snapshots = JSON.parse(raw) as Record<string, unknown>;
    if (!snapshots || typeof snapshots !== "object") return false;

    const snapshot = snapshots[librarySnapshotScopeKey(scope)];
    if (!snapshot || typeof snapshot !== "object") return false;
    const record = snapshot as Record<string, unknown>;
    const mangas = Array.isArray(record.mangas) ? record.mangas : [];
    const categories = Array.isArray(record.categories) ? record.categories : [];
    return mangas.some((manga) => hasUsableRecord(manga, "id", "title"))
      || categories.some((category) => hasUsableRecord(category, "id", "name"));
  } catch {
    return false;
  }
}
