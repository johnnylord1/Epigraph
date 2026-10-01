import {
  getNovelSourceClassificationBaselineRecord,
  listNovelSourceClassificationBaseline,
  type NovelSourceClassificationStatus,
} from "./classificationModel";
import type { PersistedNovelSourceClassificationState } from "./sourceClassificationState";

export type NovelMigrationSafetyStatus = NovelSourceClassificationStatus;

export interface NovelMigrationSafetyRecord {
  pluginId: string;
  lang: string;
  status: NovelMigrationSafetyStatus;
  notes: string;
}

export function listNovelMigrationSafetyMatrix(): NovelMigrationSafetyRecord[] {
  return listNovelSourceClassificationBaseline();
}

export function getNovelMigrationSafetyRecord(
  pluginId: string,
  classificationState?: PersistedNovelSourceClassificationState | null,
): NovelMigrationSafetyRecord | null {
  const persisted = classificationState?.records.find((entry) => entry.pluginId === pluginId) ?? null;
  const baseline = getNovelSourceClassificationBaselineRecord(pluginId);

  if (persisted) {
    return {
      pluginId: persisted.pluginId,
      lang: persisted.lang ?? baseline?.lang ?? "unknown",
      status: persisted.status,
      notes: persisted.notes,
    };
  }

  return baseline;
}

/**
 * A source can take part in a migration once its install smoke passed plugin load, search, details
 * and chapter on this profile. That smoke already runs when a source is installed or updated, so
 * migration adds no second, fixed allow-list on top of it. Sources with known limitations
 * (mojibake, weak metadata) stay out: their titles and chapter names would feed the matcher.
 */
function isMigrationReady(status: NovelSourceClassificationStatus): boolean {
  return status === "migration-safe" || status === "working";
}

export function isNovelSourceMigrationSafe(
  pluginId: string,
  classificationState?: PersistedNovelSourceClassificationState | null,
): boolean {
  const record = getNovelMigrationSafetyRecord(pluginId, classificationState);
  return Boolean(record && isMigrationReady(record.status));
}

export function getNovelMigrationBlocker(
  pluginId: string,
  classificationState?: PersistedNovelSourceClassificationState | null,
): string | null {
  const persisted = classificationState?.records.find((entry) => entry.pluginId === pluginId) ?? null;
  if (classificationState && !persisted) {
    return "This source has not completed automatic classification for this profile yet.";
  }

  const record = getNovelMigrationSafetyRecord(pluginId, classificationState);
  if (!record) {
    return "This source has not been classified for migration safety yet.";
  }
  if (isMigrationReady(record.status)) {
    return null;
  }
  return record.notes;
}

export type NovelMigrationBlockerKind = "pending" | "unverified" | "site" | "limited";

/** Same decision as `getNovelMigrationBlocker`, as a kind the UI can translate. */
export function getNovelMigrationBlockerKind(
  pluginId: string,
  classificationState?: PersistedNovelSourceClassificationState | null,
): NovelMigrationBlockerKind | null {
  const persisted = classificationState?.records.find((entry) => entry.pluginId === pluginId) ?? null;
  if (classificationState && !persisted) return "pending";
  const record = getNovelMigrationSafetyRecord(pluginId, classificationState);
  if (!record) return "unverified";
  if (isMigrationReady(record.status)) return null;
  if (record.status === "pending") return "pending";
  if (record.status === "blocked-by-site") return "site";
  return "limited";
}
