import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAethonBackupContainer, inspectAethonBackupContainer } from "./aethonBackup";
import {
  AETHON_NOVELS_PAYLOAD_FILE_PATH,
  buildAethonNovelsBackupContainer,
  buildAethonNovelsPayload,
  parseAethonNovelsPayload,
  restoreAethonNovelsPayload,
  type AethonNovelsSnapshot,
} from "./novelsBackup";

const SAMPLE_NOVELS_SNAPSHOT: AethonNovelsSnapshot = {
  entries: [
    {
      id: "novel-1",
      title: "Realm of Sand",
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
    const built = await buildAethonNovelsBackupContainer(SAMPLE_NOVELS_SNAPSHOT, {
      appVersion: "0.6.9",
      platform: "windows",
      sourceProfileId: "main",
    });

    const inspected = await inspectAethonBackupContainer(built.bytes);
    expect(inspected.hasErrors).toBe(false);
    expect(inspected.payloadManifests.novels).toEqual(
      expect.objectContaining({
        exportMode: "repository-aware",
        requiresRuntime: "novels",
        portableByDefault: true,
        requiresRepositories: ["https://plugins.example.com/index.json"],
      }),
    );

    const parsed = await parseAethonNovelsPayload(built.bytes);
    expect(parsed.payloadManifest.files).toEqual([
      expect.objectContaining({
        path: AETHON_NOVELS_PAYLOAD_FILE_PATH,
        role: "library",
      }),
    ]);
    expect(parsed.snapshot.entries[0]?.source?.pluginId).toBe("app.lnreader.sources.example");
    expect(parsed.snapshot.progress[0]?.progressPercent).toBe(0.65);
  });

  it("supports subsystem-only and mixed containers while keeping novels payload separated", async () => {
    const novelsPayload = await buildAethonNovelsPayload(SAMPLE_NOVELS_SNAPSHOT);
    const built = await buildAethonBackupContainer({
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

    const inspected = await inspectAethonBackupContainer(built.bytes);
    expect(inspected.hasErrors).toBe(false);
    expect(inspected.manifest?.payloads.map((payload) => payload.kind)).toEqual(["novels", "books"]);

    const parsed = await parseAethonNovelsPayload(built.bytes);
    expect(parsed.snapshot.entries).toHaveLength(1);
    expect(inspected.payloadManifests.books?.files[0]?.path).toBe("library.json");
  });

  it("classifies repository, plugin, and metadata-only restore outcomes safely", async () => {
    const built = await buildAethonNovelsBackupContainer({
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

    const restored = await restoreAethonNovelsPayload(built.bytes, {
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
    const built = await buildAethonBackupContainer({
      payloads: [
        {
          kind: "novels",
          payloadVersion: 99,
          files: [{ path: AETHON_NOVELS_PAYLOAD_FILE_PATH, bytes: JSON.stringify({ version: 1, entries: [] }) }],
        },
      ],
    });

    const inspected = await inspectAethonBackupContainer(built.bytes);
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
    const outputDir = process.env.AETHON_NOVELS_PHASE4_OUTPUT_DIR?.trim();
    if (!outputDir) {
      expect(true).toBe(true);
      return;
    }

    const presentRepo = process.env.AETHON_NOVELS_PHASE4_PRESENT_REPO?.trim() || "https://plugins.example.com/index.json";
    const presentPlugin = process.env.AETHON_NOVELS_PHASE4_PRESENT_PLUGIN?.trim() || "app.lnreader.sources.example";
    const presentSource = process.env.AETHON_NOVELS_PHASE4_PRESENT_SOURCE?.trim() || "example-source";

    const baseEntry = {
      ...SAMPLE_NOVELS_SNAPSHOT.entries[0],
      source: {
        ...SAMPLE_NOVELS_SNAPSHOT.entries[0].source!,
        repositoryUrl: presentRepo,
        pluginId: presentPlugin,
        sourceId: presentSource,
      },
    };

    const usable = await buildAethonNovelsBackupContainer({
      ...SAMPLE_NOVELS_SNAPSHOT,
      entries: [{ ...baseEntry, id: "usable-1", title: "Usable Novel" }],
      repositories: [{ url: presentRepo, name: "Audit Repo" }],
      plugins: [{ id: presentPlugin, name: "Audit Plugin", repositoryUrl: presentRepo }],
    });

    const missingRepository = await buildAethonNovelsBackupContainer({
      ...SAMPLE_NOVELS_SNAPSHOT,
      entries: [{
        ...baseEntry,
        id: "missing-repo-1",
        title: "Needs Repository",
        source: { ...baseEntry.source!, repositoryUrl: "https://missing.repo.invalid/index.json" },
      }],
      repositories: [{ url: "https://missing.repo.invalid/index.json", name: "Missing Repo" }],
    });

    const missingPlugin = await buildAethonNovelsBackupContainer({
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
    await fs.writeFile(path.join(outputDir, "novels-usable.aethonbk"), Buffer.from(usable.bytes));
    await fs.writeFile(path.join(outputDir, "novels-needs-repository.aethonbk"), Buffer.from(missingRepository.bytes));
    await fs.writeFile(path.join(outputDir, "novels-needs-plugin.aethonbk"), Buffer.from(missingPlugin.bytes));

    const parsed = await parseAethonNovelsPayload(usable.bytes);
    expect(parsed.snapshot.entries[0]?.source?.pluginId).toBe(presentPlugin);
  });
});
