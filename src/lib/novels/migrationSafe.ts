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

export function isNovelSourceMigrationSafe(
  pluginId: string,
  classificationState?: PersistedNovelSourceClassificationState | null,
): boolean {
  if (!classificationState) {
    return getNovelSourceClassificationBaselineRecord(pluginId)?.status === "migration-safe";
  }
  return getNovelMigrationSafetyRecord(pluginId, classificationState)?.status === "migration-safe";
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
  if (record.status === "migration-safe") {
    return null;
  }
  return record.notes;
}

export function hasMinimumNovelMigrationSafeCohort(
  classificationState?: PersistedNovelSourceClassificationState | null,
): boolean {
  const records = classificationState
    ? classificationState.records.filter((entry) => entry.status === "migration-safe").map((entry) => ({
        lang: entry.lang ?? getNovelSourceClassificationBaselineRecord(entry.pluginId)?.lang ?? "unknown",
      }))
    : listNovelSourceClassificationBaseline().filter((entry) => entry.status === "migration-safe");
  const english = records.filter((entry) => entry.lang === "en").length;
  const portuguese = records.filter((entry) => entry.lang === "pt").length;
  return english >= 2 && portuguese >= 1;
}
