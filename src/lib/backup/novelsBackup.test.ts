import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEpigraphBackupContainer, inspectEpigraphBackupContainer } from "./epigraphBackup";
import {
  EPIGRAPH_NOVELS_PAYLOAD_FILE_PATH,
  buildEpigraphNovelsBackupContainer,
  buildEpigraphNovelsPayload,
  parseEpigraphNovelsPayload,
  normalizeEpigraphNovelsSnapshot,
  restoreEpigraphNovelsPayload,
  type EpigraphNovelsSnapshot,
} from "./novelsBackup";

it("does not manufacture path identity or fresh reading clocks from incomplete backup state", () => {
  const parsed = normalizeEpigraphNovelsSnapshot({
    entries: [{ id: "backup-local-7", title: "Novel", source: { pluginId: "provider" } }],
    chapters: [],
    progress: [{ novelId: "backup-local-7", progressPercent: 0.8 }],
    bookmarks: [{ novelId: "backup-local-7" }],
    history: [{ novelId: "backup-local-7" }],
  } as unknown as EpigraphNovelsSnapshot);
  expect(parsed.entries[0].path).toBe("");
  expect(parsed.progress[0].updatedAt).toBe(0);
  expect(parsed.bookmarks[0].savedAt).toBe(0);
  expect(parsed.history[0].readAt).toBe(0);
});

const SAMPLE_NOVELS_SNAPSHOT: EpigraphNovelsSnapshot = {
  entries: [
    {
      id: "novel-1",
      title: "Realm of Sand",
      path: "/novels/realm-of-sand",
      author: "A. Author",
      description: "A portable novel payload fixture.",
      coverUrl: "https://example.com/realm.jpg",
      externalNovelId: "remote-1",
      externalUrl: "https://example.com/realm",
      status: "ONGOING",
      tags: ["fantasy", "adventure"],
      source: {
        repositoryUrl: "https://plugins.example.com/index.json",
        repositoryName: "Example Repo",
        pluginId: "app.lnreader.sources.example",
        pluginName: "Example Source",
        pluginVersion: "1.2.3",
        sourceId: "example-source",
        sourceName: "Example Source",
        lang: "en",
      },
      addedAt: 1712000000000,
      updatedAt: 1712001000000,
    },
  ],
  chapters: [
    {
      id: "chapter-7",
      novelId: "novel-1",
      path: "/novels/realm-of-sand/chapter-7",
      title: "A Door Opens",
      order: 7,
      releaseTime: 1712001900000,
      unread: false,
    },
  ],
  progress: [
    {
      novelId: "novel-1",
      chapterId: "chapter-7",
      chapterTitle: "A Door Opens",
      progressPercent: 0.65,
      locator: "chapter-7#p14",
      updatedAt: 1712002000000,
    },
  ],
  bookmarks: [
    {
      novelId: "novel-1",
      chapterId: "chapter-7",
      chapterTitle: "A Door Opens",
      locator: "chapter-7#p10",
      label: "Checkpoint",
      savedAt: 1712002100000,
    },
  ],
  history: [
    {
      novelId: "novel-1",
      chapterId: "chapter-7",
      chapterTitle: "A Door Opens",
      locator: "chapter-7#p14",
      readAt: 1712002200000,
    },
  ],
  repositories: [
    {
      url: "https://plugins.example.com/index.json",
      name: "Example Repo",
    },
  ],
  plugins: [
    {
      id: "app.lnreader.sources.example",
      name: "Example Source",
      version: "1.2.3",
      repositoryUrl: "https://plugins.example.com/index.json",
    },
  ],
};

describe("novels backup payload", () => {
  it("embeds a first-class novels payload with repository-aware compatibility metadata", async () => {
    const built = await buildEpigraphNovelsBackupContainer(SAMPLE_NOVELS_SNAPSHOT, {
      appVersion: "0.6.9",
      platform: "windows",
      sourceProfileId: "main",
    });

    const inspected = await inspectEpigraphBackupContainer(built.bytes);
    expect(inspected.hasErrors).toBe(false);
    expect(inspected.payloadManifests.novels).toEqual(
      expect.objectContaining({
        exportMode: "repository-aware",
        requiresRuntime: "novels",
        portableByDefault: true,
        requiresRepositories: ["https://plugins.example.com/index.json"],
      }),
    );

    const parsed = await parseEpigraphNovelsPayload(built.bytes);
    expect(parsed.payloadManifest.files).toEqual([
      expect.objectContaining({
        path: EPIGRAPH_NOVELS_PAYLOAD_FILE_PATH,
        role: "library",
      }),
    ]);
    expect(parsed.snapshot.entries[0]?.source?.pluginId).toBe("app.lnreader.sources.example");
    expect(parsed.snapshot.entries[0]?.path).toBe("/novels/realm-of-sand");
    expect(parsed.snapshot.chapters[0]?.path).toBe("/novels/realm-of-sand/chapter-7");
    expect(parsed.snapshot.progress[0]?.progressPercent).toBe(0.65);
  });

  it("supports subsystem-only and mixed containers while keeping novels payload separated", async () => {
    const novelsPayload = await buildEpigraphNovelsPayload(SAMPLE_NOVELS_SNAPSHOT);
    const built = await buildEpigraphBackupContainer({
      payloads: [
        novelsPayload,
        {
          kind: "books",
          exportMode: "full",
          files: [
            {
              path: "library.json",
              bytes: JSON.stringify({ books: [{ id: "book-1", title: "Alpha" }] }),
              contentType: "application/json",
              role: "library",
            },
          ],
        },
      ],
    });

    const inspected = await inspectEpigraphBackupContainer(built.bytes);
    expect(inspected.hasErrors).toBe(false);
    expect(inspected.manifest?.payloads.map((payload) => payload.kind)).toEqual(["novels", "books"]);

    const parsed = await parseEpigraphNovelsPayload(built.bytes);
    expect(parsed.snapshot.entries).toHaveLength(1);
    expect(inspected.payloadManifests.books?.files[0]?.path).toBe("library.json");
  });

  it("classifies repository, plugin, and metadata-only restore outcomes safely", async () => {
    const built = await buildEpigraphNovelsBackupContainer({
      ...SAMPLE_NOVELS_SNAPSHOT,
      entries: [
        ...SAMPLE_NOVELS_SNAPSHOT.entries,
        {
          ...SAMPLE_NOVELS_SNAPSHOT.entries[0],
          id: "novel-2",
          title: "Needs Repo",
          source: {
            ...SAMPLE_NOVELS_SNAPSHOT.entries[0].source!,
            repositoryUrl: "https://plugins.missing.invalid/index.json",
          },
        },
        {
          ...SAMPLE_NOVELS_SNAPSHOT.entries[0],
          id: "novel-3",
          title: "Needs Plugin",
          source: {
            ...SAMPLE_NOVELS_SNAPSHOT.entries[0].source!,
            pluginId: "app.lnreader.sources.missing",
            sourceId: "missing-source",
          },
        },
        {
          ...SAMPLE_NOVELS_SNAPSHOT.entries[0],
          id: "novel-4",
          title: "Metadata Only",
          source: null,
        },
      ],
    });

    const restored = await restoreEpigraphNovelsPayload(built.bytes, {
      repositoryUrls: ["https://plugins.example.com/index.json"],
      installedPluginIds: ["app.lnreader.sources.example"],
      availableSourceIds: ["example-source"],
    });

    expect(restored.summary).toEqual({
      totalEntries: 4,
      restoredUsableCount: 1,
      restoredNeedsRepositoryCount: 1,
      restoredNeedsPluginCount: 1,
      restoredMetadataOnlyCount: 1,
    });
    expect(restored.classifications).toEqual([
      expect.objectContaining({ novelId: "novel-1", outcome: "restored-usable" }),
      expect.objectContaining({ novelId: "novel-2", outcome: "restored-needs-repository" }),
      expect.objectContaining({ novelId: "novel-3", outcome: "restored-needs-plugin" }),
      expect.objectContaining({ novelId: "novel-4", outcome: "restored-metadata-only" }),
    ]);
  });

  it("warns on unsupported novels payload versions without breaking container inspection", async () => {
    const built = await buildEpigraphBackupContainer({
      payloads: [
        {
          kind: "novels",
          payloadVersion: 99,
          files: [{ path: EPIGRAPH_NOVELS_PAYLOAD_FILE_PATH, bytes: JSON.stringify({ version: 1, entries: [] }) }],
        },
      ],
    });

    const inspected = await inspectEpigraphBackupContainer(built.bytes);
    expect(inspected.hasErrors).toBe(false);
    expect(inspected.issues).toContainEqual(
      expect.objectContaining({
        level: "warning",
        code: "unsupported-payload-version",
        payloadKind: "novels",
      }),
    );
  });

  it("can emit real novels audit artifacts when env vars are provided", async () => {
    const outputDir = process.env.EPIGRAPH_NOVELS_PHASE4_OUTPUT_DIR?.trim();
    if (!outputDir) {
      expect(true).toBe(true);
      return;
    }

    const presentRepo = process.env.EPIGRAPH_NOVELS_PHASE4_PRESENT_REPO?.trim() || "https://plugins.example.com/index.json";
    const presentPlugin = process.env.EPIGRAPH_NOVELS_PHASE4_PRESENT_PLUGIN?.trim() || "app.lnreader.sources.example";
    const presentSource = process.env.EPIGRAPH_NOVELS_PHASE4_PRESENT_SOURCE?.trim() || "example-source";

    const baseEntry = {
      ...SAMPLE_NOVELS_SNAPSHOT.entries[0],
      source: {
        ...SAMPLE_NOVELS_SNAPSHOT.entries[0].source!,
        repositoryUrl: presentRepo,
        pluginId: presentPlugin,
        sourceId: presentSource,
      },
    };

    const usable = await buildEpigraphNovelsBackupContainer({
      ...SAMPLE_NOVELS_SNAPSHOT,
      entries: [{ ...baseEntry, id: "usable-1", title: "Usable Novel" }],
      repositories: [{ url: presentRepo, name: "Audit Repo" }],
      plugins: [{ id: presentPlugin, name: "Audit Plugin", repositoryUrl: presentRepo }],
    });

    const missingRepository = await buildEpigraphNovelsBackupContainer({
      ...SAMPLE_NOVELS_SNAPSHOT,
      entries: [{
        ...baseEntry,
        id: "missing-repo-1",
        title: "Needs Repository",
        source: { ...baseEntry.source!, repositoryUrl: "https://missing.repo.invalid/index.json" },
      }],
      repositories: [{ url: "https://missing.repo.invalid/index.json", name: "Missing Repo" }],
    });

    const missingPlugin = await buildEpigraphNovelsBackupContainer({
      ...SAMPLE_NOVELS_SNAPSHOT,
      entries: [{
        ...baseEntry,
        id: "missing-plugin-1",
        title: "Needs Plugin",
        source: {
          ...baseEntry.source!,
          pluginId: "app.lnreader.sources.missing",
          sourceId: "missing-source",
        },
      }],
      repositories: [{ url: presentRepo, name: "Audit Repo" }],
      plugins: [{ id: "app.lnreader.sources.missing", name: "Missing Plugin", repositoryUrl: presentRepo }],
    });

    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "novels-usable.epigraphbk"), Buffer.from(usable.bytes));
    await fs.writeFile(path.join(outputDir, "novels-needs-repository.epigraphbk"), Buffer.from(missingRepository.bytes));
    await fs.writeFile(path.join(outputDir, "novels-needs-plugin.epigraphbk"), Buffer.from(missingPlugin.bytes));

    const parsed = await parseEpigraphNovelsPayload(usable.bytes);
    expect(parsed.snapshot.entries[0]?.source?.pluginId).toBe(presentPlugin);
  });
});
