import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ details: null as any }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => "" }));
vi.mock("./runtimeSession", () => ({
  NovelRuntimeSession: class { invoke = async () => structuredClone(f.details); },
}));
vi.mock("./repositoryState", () => ({
  loadNovelRepositoryState: async () => ({
    repositories: [{ id: "owner", normalizedUrl: "https://owner.test", enabled: true, trustState: "trusted" }],
    installedPlugins: [{ pluginId: "one", repositoryId: "owner", version: "1", enabled: true, disabledReason: null, artifactPath: "one.js" }],
    catalogEntries: [{ pluginId: "one", repositoryId: "owner", version: "1", name: "One", artifactUrl: "https://owner.test/one.js" }],
  }),
}));
import { readInstalledNovelDetails } from "./sources";
import { translate } from "../i18n/runtime";

const empty = { name: null, novelPath: "story/gone", author: null, cover: null, summary: null, status: null, tags: [], chapterCount: null, chapters: [] };
beforeEach(() => { f.details = structuredClone(empty); });

describe("installed Novel source details", () => {
  it("reports a removed source page as a failure instead of an empty novel", async () => {
    await expect(readInstalledNovelDetails({}, "one", "story/gone", { title: "Saved title", coverUrl: "data:image/png;base64,AA" }))
      .rejects.toThrow(translate("novelSources_errors_novelRemovedFromSource"));
  });
  it("keeps the saved title when the source lists chapters without a name", async () => {
    f.details.chapters = [{ path: "story/gone/1", title: "Chapter 1", releaseTime: null }];
    const detail = await readInstalledNovelDetails({}, "one", "story/gone", { title: "Saved title" });
    expect(detail).toMatchObject({ title: "Saved title", chapterCount: 1 });
  });
});
