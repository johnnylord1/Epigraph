import { describe, expect, it } from "vitest";

import {
  getNovelMigrationBlocker,
  getNovelMigrationBlockerKind,
  getNovelMigrationSafetyRecord,
  isNovelSourceMigrationSafe,
} from "./migrationSafe";
import type { PersistedNovelSourceClassificationState } from "./sourceClassificationState";

describe("novel migration-safe cohort", () => {
  it("marks the current proven cohort as migration-safe", () => {
    expect(getNovelMigrationSafetyRecord("archiveofourown")?.status).toBe("migration-safe");
    expect(getNovelMigrationSafetyRecord("royalroad")?.status).toBe("migration-safe");
    expect(getNovelMigrationSafetyRecord("illusia")?.status).toBe("migration-safe");
  });

  it("removes blockers for safe sources", () => {
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
    expect(getNovelMigrationBlockerKind("inkitt")).toBe("limited");
    expect(isNovelSourceMigrationSafe("scribblehub")).toBe(false);
    expect(getNovelMigrationBlockerKind("scribblehub")).toBe("pending");
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
    expect(getNovelMigrationSafetyRecord("archiveofourown", state)?.notes).toMatch(/Automatic smoke passed/i);
  });

  it("accepts any source whose install smoke passed, without a second migration allow-list", () => {
    const record = (pluginId: string, status: PersistedNovelSourceClassificationState["records"][number]["status"]) => ({
      pluginId,
      repositoryId: "repo-1",
      repositoryUrl: "https://example.invalid/plugins.min.json",
      lang: "en",
      version: "1.0.0",
      status,
      notes: `${pluginId} smoke notes`,
      baselineStatus: null,
      baselineNotes: null,
      issues: [],
      smoke: {
        pluginLoadConfirmed: true,
        searchConfirmed: true,
        detailsConfirmed: true,
        chapterConfirmed: status !== "pending",
      },
      filterKeys: [],
      pluginSettingsKeys: [],
      classifiedAtMs: 1,
    });
    const state: PersistedNovelSourceClassificationState = {
      version: 1,
      scopeKey: "profile:test",
      updatedAtMs: 1,
      records: [
        record("novelbin", "working"),
        record("centralnovel", "working"),
        record("mojibake-source", "working-with-known-limitations"),
        record("redirecting-source", "blocked-by-site"),
        record("half-smoked-source", "pending"),
        record("runtime-source", "runtime-gap"),
      ],
    };

    // A source outside the historical matrix that passed plugin load, search, details and chapter.
    expect(isNovelSourceMigrationSafe("novelbin", state)).toBe(true);
    expect(getNovelMigrationBlocker("novelbin", state)).toBeNull();
    expect(getNovelMigrationBlockerKind("novelbin", state)).toBeNull();
    expect(isNovelSourceMigrationSafe("centralnovel", state)).toBe(true);
    expect(isNovelSourceMigrationSafe("centralnovel")).toBe(true);

    expect(isNovelSourceMigrationSafe("mojibake-source", state)).toBe(false);
    expect(getNovelMigrationBlocker("mojibake-source", state)).toBe("mojibake-source smoke notes");
    expect(getNovelMigrationBlockerKind("mojibake-source", state)).toBe("limited");
    expect(isNovelSourceMigrationSafe("redirecting-source", state)).toBe(false);
    expect(getNovelMigrationBlockerKind("redirecting-source", state)).toBe("site");
    expect(isNovelSourceMigrationSafe("half-smoked-source", state)).toBe(false);
    expect(getNovelMigrationBlockerKind("half-smoked-source", state)).toBe("pending");
    expect(isNovelSourceMigrationSafe("runtime-source", state)).toBe(false);
    expect(getNovelMigrationBlockerKind("runtime-source", state)).toBe("limited");
  });

  it("falls back to the source matrix before this profile's own smoke has run", () => {
    const freshProfile: PersistedNovelSourceClassificationState = {
      version: 1,
      scopeKey: "profile:fresh",
      updatedAtMs: null,
      records: [],
    };

    expect(isNovelSourceMigrationSafe("royalroad", freshProfile)).toBe(true);
    expect(isNovelSourceMigrationSafe("centralnovel", freshProfile)).toBe(true);
    expect(isNovelSourceMigrationSafe("inkitt", freshProfile)).toBe(false);
    expect(isNovelSourceMigrationSafe("lightnovelbrasil", freshProfile)).toBe(false);
    expect(isNovelSourceMigrationSafe("not-a-known-plugin", freshProfile)).toBe(false);
  });
});
