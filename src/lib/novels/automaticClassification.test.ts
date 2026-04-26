import { describe, expect, it } from "vitest";

import {
  buildAutomaticSearchTerms,
  hasReusableNovelSourceClassification,
  needsAutomaticNovelSourceClassification,
} from "./automaticClassification";
import { normalizeNovelSourceClassificationState } from "./sourceClassificationState";

describe("automatic novel source classification queueing", () => {
  it("requests auto classification when a trusted installed plugin has no saved result", () => {
    const state = normalizeNovelSourceClassificationState({
      scopeKey: "profile:test",
      records: [],
    });

    expect(needsAutomaticNovelSourceClassification(
      state,
      { pluginId: "royalroad", version: "1.0.0", enabled: true },
      { trustState: "trusted", enabled: true },
    )).toBe(true);
  });

  it("does not requeue auto classification when the saved version already matches", () => {
    const state = normalizeNovelSourceClassificationState({
      scopeKey: "profile:test",
      records: [
        {
          pluginId: "royalroad",
          repositoryId: "repo-1",
          repositoryUrl: "https://example.invalid",
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
    });

    expect(needsAutomaticNovelSourceClassification(
      state,
      { pluginId: "royalroad", version: "1.0.0", enabled: true },
      { trustState: "trusted", enabled: true },
    )).toBe(false);
  });

  it("reuses a definitive saved classification for the same plugin version", () => {
    const state = normalizeNovelSourceClassificationState({
      scopeKey: "profile:test",
      records: [
        {
          pluginId: "royalroad",
          repositoryId: "repo-1",
          repositoryUrl: "https://example.invalid",
          lang: "en",
          version: "1.0.0",
          status: "working",
          notes: "Automatic smoke passed.",
          baselineStatus: "working",
          baselineNotes: "Baseline working.",
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
    });

    expect(hasReusableNovelSourceClassification(state, "royalroad", "1.0.0")).toBe(true);
    expect(hasReusableNovelSourceClassification(state, "royalroad", "1.0.1")).toBe(false);
  });

  it("falls back to a generic search bank when no source-specific recipe exists", () => {
    expect(buildAutomaticSearchTerms({
      lang: "en",
      recipeTerms: null,
    })).toContain("shadow slave");
    expect(buildAutomaticSearchTerms({
      lang: "en",
      recipeTerms: null,
    })).toContain("lord of the mysteries");

    expect(buildAutomaticSearchTerms({
      lang: "pt-br",
      recipeTerms: null,
    })).toContain("overlord");
    expect(buildAutomaticSearchTerms({
      lang: "pt-br",
      recipeTerms: null,
    })).toContain("exodo");

    const withOverride = buildAutomaticSearchTerms({
      lang: "en",
      recipeTerms: ["manacled"],
    });
    expect(withOverride[0]).toBe("manacled");
    expect(withOverride).toContain("shadow slave");
  });

  it("can extend the automatic search bank with browse-seeded titles", () => {
    const terms = buildAutomaticSearchTerms({
      lang: "pt-br",
      recipeTerms: ["overlord"],
      browseSeedTitles: ["A Casa das Sombras", "Êxodo"],
    });

    expect(terms[0]).toBe("overlord");
    expect(terms).toContain("A Casa das Sombras");
    expect(terms).toContain("Êxodo");
    expect(terms).toContain("shadow slave");
  });
});
