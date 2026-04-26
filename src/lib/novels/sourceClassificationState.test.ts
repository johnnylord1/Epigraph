import { describe, expect, it } from "vitest";

import {
  getNovelSourceClassificationBadge,
  getNovelSourceClassificationDetailPresentation,
  getNovelSourceClassificationRecord,
  normalizeNovelSourceClassificationState,
  removeNovelSourceClassificationRecord,
  upsertNovelSourceClassificationRecord,
} from "./sourceClassificationState";

describe("novel source classification state", () => {
  it("normalizes persisted records and keeps smoke flags", () => {
    const state = normalizeNovelSourceClassificationState({
      scopeKey: "profile:test",
      records: [
        {
          pluginId: "royalroad",
          status: "migration-safe",
          notes: "Automatic smoke passed.",
          smoke: {
            pluginLoadConfirmed: true,
            searchConfirmed: true,
            detailsConfirmed: true,
            chapterConfirmed: true,
          },
          issues: [
            {
              code: "charset-suspect",
              message: "Test warning",
              severity: "warning",
            },
          ],
        },
      ],
    });

    expect(state.records).toHaveLength(1);
    expect(state.records[0]?.smoke.chapterConfirmed).toBe(true);
    expect(state.records[0]?.issues[0]?.code).toBe("charset-suspect");
  });

  it("upserts and removes plugin records by plugin id", () => {
    const initial = normalizeNovelSourceClassificationState({
      scopeKey: "profile:test",
      records: [],
    });
    const next = upsertNovelSourceClassificationRecord(initial, {
      pluginId: "illusia",
      repositoryId: "repo-1",
      repositoryUrl: "https://example.invalid",
      lang: "pt",
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
    });

    expect(getNovelSourceClassificationRecord(next, "illusia")?.status).toBe("migration-safe");
    expect(removeNovelSourceClassificationRecord(next, "illusia").records).toHaveLength(0);
  });

  it("builds transient pending detail presentation with retry recommendation", () => {
    const presentation = getNovelSourceClassificationDetailPresentation({
      pluginId: "scribblehub",
      repositoryId: "repo-1",
      repositoryUrl: "https://example.invalid",
      lang: "en",
      version: "1.0.0",
      status: "pending",
      notes: "Waiting for the next automatic source check.",
      baselineStatus: "pending",
      baselineNotes: "Priority English cohort target.",
      issues: [
        {
          code: "automatic-smoke-queued",
          message: "Automatic source check is queued and still waiting for the bounded smoke recipe.",
          severity: "info",
        },
      ],
      smoke: {
        pluginLoadConfirmed: false,
        searchConfirmed: false,
        detailsConfirmed: false,
        chapterConfirmed: false,
      },
      filterKeys: [],
      pluginSettingsKeys: [],
      classifiedAtMs: Date.now(),
    });

    expect(presentation.longLabel).toBe("Pending smoke");
    expect(presentation.summary).toBe("Automatic source check is still pending.");
    expect(presentation.isTransient).toBe(true);
    expect(presentation.canRetryCheck).toBe(true);
    expect(presentation.primaryReason).toBeNull();
  });

  it("hides retry recommendation for migration-safe and working states", () => {
    const baseRecord = {
      pluginId: "scribblehub",
      repositoryId: "repo-1",
      repositoryUrl: "https://example.invalid",
      lang: "en",
      version: "1.0.0",
      notes: "Automatic smoke passed.",
      baselineStatus: "migration-safe" as const,
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
    };

    const migrationSafe = getNovelSourceClassificationDetailPresentation({
      ...baseRecord,
      pluginId: "royalroad",
      status: "migration-safe",
    });

    const working = getNovelSourceClassificationDetailPresentation({
      ...baseRecord,
      pluginId: "archiveofourown",
      status: "working",
      notes: "Source works.",
      baselineStatus: "working" as const,
      baselineNotes: "Baseline working.",
    });

    expect(migrationSafe.canRetryCheck).toBe(false);
    expect(working.canRetryCheck).toBe(false);
    expect(getNovelSourceClassificationBadge({
      ...baseRecord,
      pluginId: "illusia",
      status: "migration-safe",
    }).shortLabel).toBe("Safe");
    expect(getNovelSourceClassificationBadge({
      ...baseRecord,
      pluginId: "scribblehub",
      status: "runtime-gap",
    }).shortLabel).toBe("Gap");
  });

  it("surfaces the first primary reason for blocked sources and falls back safely for null", () => {
    const blocked = getNovelSourceClassificationDetailPresentation({
      pluginId: "lightnovelbrasil",
      repositoryId: "repo-1",
      repositoryUrl: "https://example.invalid",
      lang: "pt",
      version: "1.0.0",
      status: "blocked-by-site",
      notes: "Live search lands on anti-bot HTML.",
      baselineStatus: "blocked-by-site",
      baselineNotes: "Blocked by site.",
      issues: [
        {
          code: "anti-bot-redirect",
          message: "The site redirects to an anti-bot challenge instead of returning structured search results.",
          severity: "error",
        },
      ],
      smoke: {
        pluginLoadConfirmed: true,
        searchConfirmed: false,
        detailsConfirmed: false,
        chapterConfirmed: false,
      },
      filterKeys: [],
      pluginSettingsKeys: [],
      classifiedAtMs: Date.now(),
    });
    const missing = getNovelSourceClassificationDetailPresentation(null);

    expect(blocked.primaryReason).toContain("anti-bot");
    expect(blocked.canRetryCheck).toBe(true);
    expect(missing.summary).toBe("Automatic source check is still pending.");
    expect(missing.canRetryCheck).toBe(false);
  });
});
