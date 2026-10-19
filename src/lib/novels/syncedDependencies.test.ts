import { describe, expect, it } from "vitest";
import type { InstalledNovelPluginRecord, NovelRepositoryRecord } from "./contracts";
import type { PersistedNovelRepositoryState } from "./repositoryState";
import type { SyncdNovelDependencyDeclaration } from "../syncdDesktop";
import {
  SYNCED_DEPENDENCY_RETRY_MS,
  applySyncedNovelDependencyRemovals,
  missingSyncedNovelDependencies,
  recentSyncedDependencyAttempts,
} from "./syncedDependencies";

const OFFICIAL = "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json";
const OTHER = "https://example.com/someone/plugins.min.json";

function repository(url: string, patch: Partial<NovelRepositoryRecord> = {}): NovelRepositoryRecord {
  return {
    id: `repo-${url}`, profileId: "default", url, normalizedUrl: url, recommendedSeed: false,
    trustState: "trusted", enabled: true, lastFetchedAtMs: null, lastSuccessAtMs: null,
    etag: null, lastModified: null, lastError: null, ...patch,
  };
}

function installed(pluginId: string, repositoryId: string): InstalledNovelPluginRecord {
  return {
    profileId: "default", repositoryId, pluginId, version: "1.0.0", enabled: true, disabledReason: null,
    artifactPath: "x", customJsPath: null, customCssPath: null, hasSettings: false, installedAtMs: 1, updatedAtMs: 1,
  };
}

function state(repositories: NovelRepositoryRecord[], installedPlugins: InstalledNovelPluginRecord[] = []): PersistedNovelRepositoryState {
  return { version: 1, scopeKey: "profile:default", repositories, catalogEntries: [], installedPlugins, languageFilter: [], updatedAtMs: null };
}

const declared = (url: string, id = `id:${url}`, enabled = true): SyncdNovelDependencyDeclaration =>
  ({ kind: "repository", repositoryId: id, canonicalUrl: url, enabled });
const plugin = (pluginId: string, repositoryId: string, enabled = true): SyncdNovelDependencyDeclaration =>
  ({ kind: "plugin", repositoryId, pluginId, version: "2.0.0", enabled });

describe("missingSyncedNovelDependencies", () => {
  it("adds a repository the phone declared and installs its plugins from it", () => {
    const plan = missingSyncedNovelDependencies(
      [declared(OTHER), plugin("someone.source", `id:${OTHER}`)],
      state([repository(OFFICIAL)]),
    );
    expect(plan.repositories).toEqual([{ url: OTHER }]);
    expect(plan.plugins).toEqual([{ id: "someone.source", repositoryUrl: OTHER }]);
    expect(plan.approvals).toEqual({ repositoryUrls: [OTHER], plugins: { "someone.source": OTHER } });
  });

  it("uses the local copy of a repository already configured here", () => {
    const local = OFFICIAL.replace("LNReader", "lnreader");
    const plan = missingSyncedNovelDependencies(
      [declared(OFFICIAL), plugin("novelbin", `id:${OFFICIAL}`)],
      state([repository(local)]),
    );
    expect(plan.plugins).toEqual([{ id: "novelbin", repositoryUrl: local }]);
    expect(plan.approvals.repositoryUrls).toEqual([local]);
  });

  it("does nothing when everything declared is already here", () => {
    const local = repository(OFFICIAL);
    const plan = missingSyncedNovelDependencies(
      [declared(OFFICIAL), plugin("novelbin", `id:${OFFICIAL}`)],
      state([local], [installed("novelbin", local.id)]),
    );
    expect(plan).toEqual({ repositories: [], plugins: [], approvals: { repositoryUrls: [], plugins: {} }, attemptKeys: [] });
  });

  it("keeps the local choice for a disabled, untrusted or blocked repository", () => {
    for (const patch of [{ enabled: false }, { trustState: "unknown" as const }, { trustState: "blocked" as const }]) {
      const plan = missingSyncedNovelDependencies(
        [declared(OTHER), plugin("someone.source", `id:${OTHER}`)],
        state([repository(OTHER, patch)]),
      );
      expect(plan.attemptKeys).toEqual([]);
    }
  });

  it("ignores disabled declarations, orphan plugins and plugins claimed by two repositories", () => {
    const plan = missingSyncedNovelDependencies(
      [
        declared(OTHER, "a", false), plugin("from.disabled", "a"),
        plugin("orphan", "missing"),
        declared(OFFICIAL, "b"), plugin("dropped", "b", false),
        declared("https://example.org/plugins.min.json", "c"), plugin("twice", "b"), plugin("twice", "c"),
      ],
      state([repository(OFFICIAL), repository("https://example.org/plugins.min.json")]),
    );
    expect(plan.plugins).toEqual([]);
    expect(plan.repositories).toEqual([]);
  });

  it("does not retry what an earlier pass already attempted", () => {
    const declarations = [declared(OTHER), plugin("someone.source", `id:${OTHER}`)];
    const first = missingSyncedNovelDependencies(declarations, state([]));
    expect(first.attemptKeys).toHaveLength(2);
    const second = missingSyncedNovelDependencies(declarations, state([]), new Set(first.attemptKeys));
    expect(second.attemptKeys).toEqual([]);
    expect(second.plugins).toEqual([]);
  });
});

describe("recentSyncedDependencyAttempts", () => {
  it("tries a failed install again once the retry window passes", () => {
    const attempts = new Map([["a", 1_000], ["b", 1_000 + SYNCED_DEPENDENCY_RETRY_MS]]);
    expect(recentSyncedDependencyAttempts(attempts, 1_000 + SYNCED_DEPENDENCY_RETRY_MS)).toEqual(new Set(["b"]));
    expect([...attempts.keys()]).toEqual(["b"]);
  });
});

describe("applySyncedNovelDependencyRemovals", () => {
  const operations = {
    removePlugin: async (current: PersistedNovelRepositoryState, pluginId: string) =>
      ({ ...current, installedPlugins: current.installedPlugins.filter((entry) => entry.pluginId !== pluginId) }),
    removeRepository: (current: PersistedNovelRepositoryState, repositoryId: string) =>
      ({ ...current, repositories: current.repositories.filter((entry) => entry.id !== repositoryId) }),
  };

  it("removes what the other device deleted and skips what is already gone", async () => {
    const local = repository(OTHER);
    const result = await applySyncedNovelDependencyRemovals(
      state([local, repository(OFFICIAL)], [installed("someone.source", local.id)]),
      [
        { kind: "plugin", pluginId: "someone.source" },
        { kind: "plugin", pluginId: "missing" },
        { kind: "repository", localRepositoryId: local.id },
        { kind: "repository", localRepositoryId: "missing" },
      ],
      operations,
    );
    expect(result.removed).toBe(2);
    expect(result.state.installedPlugins).toEqual([]);
    expect(result.state.repositories.map((entry) => entry.url)).toEqual([OFFICIAL]);
  });

  it("does not count a repository the state keeps", async () => {
    const builtin = state([repository(OFFICIAL)]);
    const result = await applySyncedNovelDependencyRemovals(
      builtin,
      [{ kind: "repository", localRepositoryId: `repo-${OFFICIAL}` }],
      { ...operations, removeRepository: (current) => current },
    );
    expect(result).toEqual({ state: builtin, removed: 0 });
  });
});
