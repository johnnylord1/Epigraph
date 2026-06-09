import { normalizeLocalProfileId, normalizeServerUrl } from "../localProfiles";
import type { Category, Manga } from "../types";

const LIBRARY_SNAPSHOT_KEY = "aethon-library-snapshots";
const LIBRARY_SNAPSHOT_VERSION = 1 as const;

export interface LibrarySnapshotScope {
  profileId?: string | null;
  serverUrl?: string | null;
}

export interface PersistedLibrarySnapshot {
  version: typeof LIBRARY_SNAPSHOT_VERSION;
  scopeKey: string;
  mangas: Manga[];
  categories: Category[];
  categoryMembers: Record<string, number[]>;
  trackingSummary: unknown[];
  updatedAt: number;
}

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

export function librarySnapshotScopeKey(scope: LibrarySnapshotScope = {}) {
  const profileId = normalizeLocalProfileId(scope.profileId) ?? "default";
  const serverUrl = normalizeServerUrl(scope.serverUrl) ?? "unknown";
  return `${profileId}::${serverUrl}`;
}

function normalizeNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeManga(value: unknown): Manga | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = normalizeNumber(record.id);
  const title = normalizeString(record.title);
  if (id === null || !title) return null;
  const sourceValue = record.source;
  const sourceRecord = sourceValue && typeof sourceValue === "object"
    ? sourceValue as Record<string, unknown>
    : null;

  return {
    id,
    title,
    thumbnailUrl: normalizeString(record.thumbnailUrl) ?? "",
    inLibrary: record.inLibrary !== false,
    downloadCount: normalizeNumber(record.downloadCount) ?? undefined,
    unreadCount: normalizeNumber(record.unreadCount) ?? undefined,
    chapterCount: normalizeNumber(record.chapterCount) ?? undefined,
    status: normalizeString(record.status),
    genre: Array.isArray(record.genre)
      ? record.genre.filter((entry): entry is string => typeof entry === "string")
      : [],
    source: sourceRecord
      ? {
          id: String(sourceRecord.id ?? ""),
          name: normalizeString(sourceRecord.name) ?? "",
          lang: normalizeString(sourceRecord.lang),
          displayName: normalizeString(sourceRecord.displayName) ?? normalizeString(sourceRecord.name) ?? "",
        }
      : null,
  };
}

function normalizeCategory(value: unknown): Category | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = normalizeNumber(record.id);
  const name = normalizeString(record.name);
  if (id === null || !name) return null;
  const nodes = record.mangas && typeof record.mangas === "object" && Array.isArray((record.mangas as any).nodes)
    ? (record.mangas as any).nodes.map((manga: unknown) => normalizeManga(manga)).filter(Boolean) as Manga[]
    : undefined;

  return {
    id,
    name,
    order: normalizeNumber(record.order) ?? 0,
    default: record.default === true,
    includeInUpdate: normalizeString(record.includeInUpdate) ?? "GLOBAL",
    includeInDownload: normalizeString(record.includeInDownload) ?? "GLOBAL",
    ...(nodes ? { mangas: { nodes } } : {}),
  };
}

function normalizeCategoryMembers(value: unknown): Record<string, number[]> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([categoryId, ids]) => [
      String(categoryId),
      Array.isArray(ids)
        ? [...new Set(ids.map(normalizeNumber).filter((id): id is number => id !== null))]
        : [],
    ]),
  );
}

export function buildCategoryMembers(categories: Category[]): Record<string, number[]> {
  return Object.fromEntries(
    categories
      .filter((category) => category.mangas?.nodes)
      .map((category) => [
        String(category.id),
        [...new Set((category.mangas?.nodes ?? []).map((manga) => manga.id))],
      ]),
  );
}

export function normalizeLibrarySnapshot(
  value: unknown,
  scope: LibrarySnapshotScope = {},
): PersistedLibrarySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const scopeKey = normalizeString(record.scopeKey) ?? librarySnapshotScopeKey(scope);
  const mangas = Array.isArray(record.mangas)
    ? record.mangas.map(normalizeManga).filter((manga): manga is Manga => Boolean(manga))
    : [];
  const categories = Array.isArray(record.categories)
    ? record.categories.map(normalizeCategory).filter((category): category is Category => Boolean(category))
    : [];
  const updatedAt = normalizeNumber(record.updatedAt);
  if (!mangas.length && !categories.length) return null;

  return {
    version: LIBRARY_SNAPSHOT_VERSION,
    scopeKey,
    mangas,
    categories,
    categoryMembers: normalizeCategoryMembers(record.categoryMembers),
    trackingSummary: Array.isArray(record.trackingSummary) ? record.trackingSummary : [],
    updatedAt: updatedAt ?? Date.now(),
  };
}

function readSnapshotMap(storage = storageOrNull()): Record<string, PersistedLibrarySnapshot> {
  if (!storage) return {};
  const raw = storage.getItem(LIBRARY_SNAPSHOT_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([scopeKey, snapshot]) => [scopeKey, normalizeLibrarySnapshot(snapshot, {})])
        .filter((entry): entry is [string, PersistedLibrarySnapshot] => Boolean(entry[1])),
    );
  } catch {
    return {};
  }
}

function writeSnapshotMap(next: Record<string, PersistedLibrarySnapshot>, storage = storageOrNull()) {
  if (!storage) return;
  storage.setItem(LIBRARY_SNAPSHOT_KEY, JSON.stringify(next));
}

export function loadLibrarySnapshot(scope: LibrarySnapshotScope = {}): PersistedLibrarySnapshot | null {
  const scopeKey = librarySnapshotScopeKey(scope);
  return readSnapshotMap()[scopeKey] ?? null;
}

export function hasLibrarySnapshot(scope: LibrarySnapshotScope = {}) {
  return Boolean(loadLibrarySnapshot(scope));
}

export function saveLibrarySnapshot(
  scope: LibrarySnapshotScope,
  snapshot: Pick<PersistedLibrarySnapshot, "mangas" | "categories" | "trackingSummary"> & {
    categoryMembers?: Record<string, number[]>;
    updatedAt?: number;
  },
) {
  const scopeKey = librarySnapshotScopeKey(scope);
  const nextSnapshot: PersistedLibrarySnapshot = {
    version: LIBRARY_SNAPSHOT_VERSION,
    scopeKey,
    mangas: snapshot.mangas,
    categories: snapshot.categories,
    categoryMembers: snapshot.categoryMembers ?? buildCategoryMembers(snapshot.categories),
    trackingSummary: snapshot.trackingSummary,
    updatedAt: snapshot.updatedAt ?? Date.now(),
  };
  const next = {
    ...readSnapshotMap(),
    [scopeKey]: nextSnapshot,
  };
  writeSnapshotMap(next);
  return nextSnapshot;
}
