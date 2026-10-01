import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PersistedNovelSourceClassificationState } from "./sourceClassificationState";

const mocks = vi.hoisted(() => ({
  state: null as PersistedNovelSourceClassificationState | null,
  sources: [] as Array<Record<string, unknown>>,
  runtimeSummary: vi.fn(),
}));

vi.mock("./sourceClassificationState", async (importActual) => {
  const actual = await importActual<typeof import("./sourceClassificationState")>();
  return {
    ...actual,
    loadNovelSourceClassificationState: vi.fn(async () => mocks.state),
    saveNovelSourceClassificationState: vi.fn(async (next: PersistedNovelSourceClassificationState) => {
      mocks.state = next;
      return next;
    }),
  };
});

vi.mock("./sources", () => ({
  loadInstalledNovelSources: vi.fn(async () => mocks.sources),
  loadTrustedInstalledNovelSources: vi.fn(async () => mocks.sources),
  readInstalledNovelSourceRuntimeSummary: mocks.runtimeSummary,
  searchInstalledNovelSource: vi.fn(async () => []),
  readInstalledNovelDetails: vi.fn(),
  readInstalledNovelChapter: vi.fn(),
  browseInstalledNovelSource: vi.fn(async () => []),
}));

import { classifyUnclassifiedNovelSources } from "./automaticClassification";
import { getNovelSourceClassificationRecord, normalizeNovelSourceClassificationState } from "./sourceClassificationState";

function source(pluginId: string, version: string) {
  return { pluginId, version, enabled: true, trustState: "trusted", lang: "en", repositoryId: "repo", repositoryUrl: "https://example.invalid" };
}

describe("classifyUnclassifiedNovelSources", () => {
  beforeEach(() => {
    mocks.runtimeSummary.mockReset();
    mocks.runtimeSummary.mockRejectedValue(new Error("offline"));
    mocks.sources = [source("royalroad", "2.0.0"), source("archiveofourown", "1.0.0")];
    mocks.state = normalizeNovelSourceClassificationState({
      scopeKey: "profile:test",
      records: [{
        pluginId: "archiveofourown",
        repositoryId: "repo",
        repositoryUrl: "https://example.invalid",
        lang: "en",
        version: "1.0.0",
        status: "migration-safe",
        notes: "Automatic smoke passed.",
        issues: [],
        smoke: { pluginLoadConfirmed: true, searchConfirmed: true, detailsConfirmed: true, chapterConfirmed: true },
        classifiedAtMs: 1,
      }],
    });
  });

  it("runs the smoke only for installed sources without a record for their version", async () => {
    await expect(classifyUnclassifiedNovelSources({ profileId: "test" })).resolves.toBe(true);

    expect(mocks.runtimeSummary).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeSummary).toHaveBeenCalledWith({ profileId: "test" }, "royalroad");
    expect(getNovelSourceClassificationRecord(mocks.state!, "royalroad")).toMatchObject({ version: "2.0.0" });
    expect(getNovelSourceClassificationRecord(mocks.state!, "archiveofourown")).toMatchObject({ status: "migration-safe" });
  });

  it("shares one sweep between concurrent callers and does nothing once every source is recorded", async () => {
    const [first, second] = await Promise.all([
      classifyUnclassifiedNovelSources({ profileId: "test" }),
      classifyUnclassifiedNovelSources({ profileId: "test" }),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(mocks.runtimeSummary).toHaveBeenCalledTimes(1);

    await expect(classifyUnclassifiedNovelSources({ profileId: "test" })).resolves.toBe(false);
    expect(mocks.runtimeSummary).toHaveBeenCalledTimes(1);
  });
});
