import { describe, expect, it } from "vitest";

import {
  getNovelMigrationBlocker,
  getNovelMigrationBlockerKind,
  getNovelMigrationSafetyRecord,
  hasMinimumNovelMigrationSafeCohort,
  isNovelSourceMigrationSafe,
} from "./migrationSafe";
import type { PersistedNovelSourceClassificationState } from "./sourceClassificationState";

describe("novel migration-safe cohort", () => {
  it("marks the current proven cohort as migration-safe", () => {
    expect(getNovelMigrationSafetyRecord("archiveofourown")?.status).toBe("migration-safe");
    expect(getNovelMigrationSafetyRecord("royalroad")?.status).toBe("migration-safe");
    expect(getNovelMigrationSafetyRecord("illusia")?.status).toBe("migration-safe");
  });

  it("reports the minimum cohort as ready and removes blockers for safe sources", () => {
    expect(hasMinimumNovelMigrationSafeCohort()).toBe(true);
    expect(isNovelSourceMigrationSafe("archiveofourown")).toBe(true);
    expect(isNovelSourceMigrationSafe("royalroad")).toBe(true);
    expect(isNovelSourceMigrationSafe("illusia")).toBe(true);
    expect(getNovelMigrationBlocker("illusia")).toBeNull();
    expect(getNovelMigrationBlockerKind("illusia")).toBeNull();
  });

  it("keeps blocked or limited sources out of the migration-safe cohort", () => {
    expect(isNovelSourceMigrationSafe("lightnovelbrasil")).toBe(false);
    expect(getNovelMigrationBlocker("lightnovelbrasil")).toMatch(/redirect|anti-bot/i);
    expect(getNovelMigrationBlockerKind("lightnovelbrasil")).toBe("site");
    expect(getNovelMigrationBlockerKind("not-a-known-plugin")).toBe("unverified");
    expect(isNovelSourceMigrationSafe("inkitt")).toBe(false);
  });

  it("reads persisted automatic classification state for migration gating", () => {
    const state: PersistedNovelSourceClassificationState = {
      version: 1,
      scopeKey: "profile:test",
      updatedAtMs: Date.now(),
      records: [
        {
          pluginId: "archiveofourown",
          repositoryId: "repo-1",
          repositoryUrl: "https://example.invalid/plugins.min.json",
          lang: "en",
          version: "1.0.0",
          status: "migration-safe",
          notes: "Automatic smoke passed.",
          baselineStatus: "migration-safe",
          baselineNotes: "Baseline safe.",
          issues: [],
          smoke: {
            pluginLoadConfirmed: true,
            searchConfirmed: true,
            detailsConfirmed: true,
            chapterConfirmed: true,
          },
          filterKeys: [],
          pluginSettingsKeys: [],
          classifiedAtMs: Date.now(),
        },
      ],
    };

    expect(isNovelSourceMigrationSafe("archiveofourown", state)).toBe(true);
    expect(getNovelMigrationBlocker("illusia", state)).toMatch(/automatic classification/i);
    expect(getNovelMigrationBlockerKind("illusia", state)).toBe("pending");
    expect(getNovelMigrationBlockerKind("archiveofourown", state)).toBeNull();
    expect(hasMinimumNovelMigrationSafeCohort(state)).toBe(false);
    expect(getNovelMigrationSafetyRecord("archiveofourown", state)?.notes).toMatch(/Automatic smoke passed/i);
  });
});
