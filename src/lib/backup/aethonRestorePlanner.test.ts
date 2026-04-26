import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildAethonBackupContainer } from "./aethonBackup";
import { buildAethonAppPayload } from "./appBackup";
import { buildAethonBooksPayload, type AethonBooksSnapshot } from "./booksBackup";
import { buildAethonMangaPayload } from "./mangaBackup";
import { buildAethonNovelsPayload, type AethonNovelsSnapshot } from "./novelsBackup";
import {
  buildAethonRestorePlan,
  type AethonRestorePlannerRuntime,
} from "./aethonRestorePlanner";

const SAMPLE_MANGA_BYTES = new TextEncoder().encode("PHASE5-MANGA-BACKUP");

const SAMPLE_BOOKS_SNAPSHOT: AethonBooksSnapshot = {
  books: [
    {
      id: "book-1",
      assetFingerprint: "fingerprint-1",
      title: "Book One",
      author: "Author One",
      description: "Planner fixture",
      coverPath: "C:/covers/book-1.png",
      subtype: "epub",
      pageCount: null,
      createdAt: 1,
      updatedAt: 2,
      importPath: "C:/books/book-1.epub",
      assetPath: "C:/books/book-1.epub",
      tocCount: 1,
      spineCount: 1,
      sectionsSummary: [{ id: "s-1", label: "Chapter 1", href: "chapter-1.xhtml", depth: 0 }],
      sectionCount: 1,
    },
  ],
  bookProgress: [
    {
      bookId: "book-1",
      location: "epubcfi(/6/2!/4/2/2)",
      href: "chapter-1.xhtml",
      progressPercent: 0.5,
      lastReadAt: 100,
      sectionLabel: "Chapter 1",
      renderer: "epub",
      pageIndex: null,
      totalPages: null,
    },
  ],
  bookBookmarks: [
    {
      bookId: "book-1",
      location: "epubcfi(/6/2!/4/2/2)",
      href: "chapter-1.xhtml",
      pageIndex: null,
      progressPercent: 0.5,
      label: "Resume",
      savedAt: 101,
    },
  ],
  booksCategories: [
    { id: "favorites", name: "Favorites", order: 1 },
  ],
  booksCategoryAssignments: {
    "book-1": ["favorites"],
  },
};

const SAMPLE_NOVELS_SNAPSHOT: AethonNovelsSnapshot = {
  entries: [
    {
      id: "novel-1",
      title: "Novel One",
      path: "/works/1",
      source: {
        repositoryUrl: "https://plugins.example.com/index.json",
        pluginId: "app.lnreader.sources.example",
        sourceId: "example-source",
      },
      addedAt: 1,
      updatedAt: 2,
    },
  ],
  chapters: [
    {
      id: "chapter-1",
      novelId: "novel-1",
      path: "/works/1/chapters/1",
      title: "Chapter 1",
      order: 1,
      releaseTime: null,
      unread: true,
    },
  ],
  progress: [],
  bookmarks: [],
  history: [],
  repositories: [
    { url: "https://plugins.example.com/index.json", name: "Example Repo" },
  ],
  plugins: [
    { id: "app.lnreader.sources.example", repositoryUrl: "https://plugins.example.com/index.json" },
  ],
};

const PLANNER_RUNTIME: AethonRestorePlannerRuntime = {
  manga: {
    supported: true,
    inventory: [],
    availableExtensions: [],
    trackers: [],
    overlay: { version: 1, entries: {} },
  },
  books: {
    supported: true,
  },
  novels: {
    supported: true,
    repositoryUrls: ["https://plugins.example.com/index.json"],
    installedPluginIds: ["app.lnreader.sources.example"],
    availableSourceIds: ["example-source"],
  },
  app: {
    supported: true,
  },
};

async function buildBooksPayload(exportMode: "full" | "metadata-only" = "full") {
  return buildAethonBooksPayload(
    SAMPLE_BOOKS_SNAPSHOT,
    { exportMode },
    {
      readBinaryFile: async (filePath: string) =>
        new TextEncoder().encode(filePath.endsWith(".epub") ? "EPUB-BYTES" : "PNG-BYTES").buffer,
      writeManagedBookAsset: async () => "",
      writeManagedBookCover: async () => "",
    },
  );
}

function mangaDeps(options: {
  needsReview?: number;
  requiresInstall?: number;
  unavailable?: number;
  unresolved?: number;
  warnings?: number;
} = {}) {
  return {
    analyzeManga: async () => ({
      parsedBackup: {
        bytes: SAMPLE_MANGA_BYTES,
        wasGzipped: false,
        backupSources: [{ sourceId: "1", name: "Source One", lang: "en" }],
        backupManga: [{ sourceId: "1", url: "/title-1", title: "Title One", author: null, artist: null, chapterCount: 10, thumbnailUrl: null }],
        trackerIds: [],
        mangaMessages: [],
        sourceMessages: [],
        preservedTopLevelChunks: [],
      },
      analysis: {
        backupFingerprint: "backup",
        sourceInventoryFingerprint: "inventory",
        exactMatches: [],
        autoReconciled: [],
        needsReview: Array.from({ length: options.needsReview ?? 0 }, (_, index) => ({
          orphanSourceId: `review-${index}`,
          sourceName: "Needs Review",
          sourceLang: "en",
          status: "needs_review" as const,
          sampleManga: [],
          selectedCandidate: null,
          candidates: [],
        })),
        unresolved: Array.from({ length: options.unresolved ?? 0 }, (_, index) => ({
          orphanSourceId: `unresolved-${index}`,
          sourceName: "Unresolved",
          sourceLang: "en",
          status: "unresolved" as const,
          sampleManga: [],
          selectedCandidate: null,
          candidates: [],
        })),
        warnings: Array.from({ length: options.warnings ?? 0 }, (_, index) => ({
          kind: "cluster_inference_failed" as const,
          message: `warning-${index}`,
        })),
      },
      readiness: {
        items: [],
        readyNow: [],
        requiresInstall: [],
        unavailable: [],
        unresolved: [],
        installableExtensions: [],
        readyNowCount: 0,
        requiresInstallCount: options.requiresInstall ?? 0,
        unavailableCount: options.unavailable ?? 0,
        unresolvedCount: options.unresolved ?? 0,
        blocksRestore: (options.requiresInstall ?? 0) > 0 || (options.unavailable ?? 0) > 0,
      },
    }),
  };
}

async function buildUnknownPayloadContainer() {
  const built = await buildAethonBackupContainer({
    payloads: [await buildBooksPayload("full")],
  });
  const zip = await JSZip.loadAsync(built.bytes);
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
  manifest.payloads[0].kind = "mystery";
  manifest.payloads[0].payloadRoot = "payloads/mystery";
  manifest.payloads[0].manifestPath = "payloads/mystery/manifest.json";
  zip.file("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return zip.generateAsync({ type: "uint8array" });
}

describe("aethon restore planner", () => {
  it("builds a mixed restore plan with explicit statuses, booleans, and top-level skipped app payload", async () => {
    const built = await buildAethonBackupContainer({
      payloads: [
        await buildAethonMangaPayload(SAMPLE_MANGA_BYTES),
        await buildAethonNovelsPayload(SAMPLE_NOVELS_SNAPSHOT),
        await buildBooksPayload("full"),
      ],
    });

    const plan = await buildAethonRestorePlan(built.bytes, PLANNER_RUNTIME, {}, mangaDeps());

    expect(plan.defaultTarget).toBe("sandbox-profile");
    expect(plan.recommendedSelection).toEqual(["manga", "novels", "books"]);
    expect(plan.payloads.map((payload) => [payload.kind, payload.status, payload.canRestoreNow, payload.needsUserAction])).toEqual([
      ["manga", "restorable", true, false],
      ["novels", "restorable", true, false],
      ["books", "restorable", true, false],
    ]);
    expect(plan.topLevelSkipped).toEqual([
      expect.objectContaining({
        kind: "app",
        status: "skipped",
        reason: "optional-payload-omitted",
      }),
    ]);
    expect(plan.payloads.find((payload) => payload.kind === "app")).toBeUndefined();
  });

  it.each([
    [{ needsReview: 1 }, "blocked", false, true, "manga-needs-review"],
    [{ requiresInstall: 1 }, "blocked", false, true, "manga-requires-install"],
    [{ unavailable: 1 }, "blocked", false, true, "manga-unavailable-source"],
    [{ unresolved: 1 }, "warning-only", true, false, "manga-unresolved-source"],
    [{ warnings: 1 }, "warning-only", true, false, "non-blocking-warning"],
  ])("maps manga planner outcomes mechanically: %j", async (options, status, canRestoreNow, needsUserAction, reasonCode) => {
    const built = await buildAethonBackupContainer({
      payloads: [await buildAethonMangaPayload(SAMPLE_MANGA_BYTES)],
    });

    const plan = await buildAethonRestorePlan(built.bytes, PLANNER_RUNTIME, {}, mangaDeps(options));
    const manga = plan.payloads[0];

    expect(manga.kind).toBe("manga");
    expect(manga.status).toBe(status);
    expect(manga.canRestoreNow).toBe(canRestoreNow);
    expect(manga.needsUserAction).toBe(needsUserAction);
    expect([...(manga.reasons ?? []), ...(manga.warnings ?? [])].some((entry) => entry.code === reasonCode)).toBe(true);
  });

  it("marks books metadata-only payloads as warning-only and keeps them selected by default", async () => {
    const built = await buildAethonBackupContainer({
      payloads: [await buildBooksPayload("metadata-only")],
    });

    const plan = await buildAethonRestorePlan(built.bytes, PLANNER_RUNTIME);
    const books = plan.payloads[0];

    expect(books.kind).toBe("books");
    expect(books.status).toBe("warning-only");
    expect(books.selectedByDefault).toBe(true);
    expect(books.canRestoreNow).toBe(true);
    expect(books.needsUserAction).toBe(false);
    expect(books.warnings).toContainEqual(expect.objectContaining({ code: "metadata-only-limitation" }));
  });

  it("marks missing full books assets as blocked", async () => {
    const built = await buildAethonBackupContainer({
      payloads: [await buildBooksPayload("full")],
    });
    const zip = await JSZip.loadAsync(built.bytes);
    zip.remove("payloads/books/files/book-1.epub");
    const mutated = await zip.generateAsync({ type: "uint8array" });

    const plan = await buildAethonRestorePlan(mutated, PLANNER_RUNTIME);
    const books = plan.payloads[0];

    expect(books.status).toBe("blocked");
    expect(books.canRestoreNow).toBe(false);
    expect(books.needsUserAction).toBe(true);
  });

  it("marks novels missing repositories or plugins as blocked and metadata-only entries as warning-only", async () => {
    const missingRepoBuilt = await buildAethonBackupContainer({
      payloads: [await buildAethonNovelsPayload({
        ...SAMPLE_NOVELS_SNAPSHOT,
        entries: [{
          ...SAMPLE_NOVELS_SNAPSHOT.entries[0],
          source: {
            repositoryUrl: "https://plugins.missing.invalid/index.json",
            pluginId: "app.lnreader.sources.example",
            sourceId: "example-source",
          },
        }],
      })],
    });

    const missingRepoPlan = await buildAethonRestorePlan(missingRepoBuilt.bytes, PLANNER_RUNTIME);
    expect(missingRepoPlan.payloads[0]).toEqual(
      expect.objectContaining({
        status: "blocked",
        canRestoreNow: false,
        needsUserAction: true,
      }),
    );

    const metadataOnlyBuilt = await buildAethonBackupContainer({
      payloads: [await buildAethonNovelsPayload({
        ...SAMPLE_NOVELS_SNAPSHOT,
        entries: [{
          ...SAMPLE_NOVELS_SNAPSHOT.entries[0],
          id: "metadata-only",
          source: null,
        }],
      })],
    });

    const metadataOnlyPlan = await buildAethonRestorePlan(metadataOnlyBuilt.bytes, PLANNER_RUNTIME);
    expect(metadataOnlyPlan.payloads[0]).toEqual(
      expect.objectContaining({
        status: "warning-only",
        canRestoreNow: true,
        needsUserAction: false,
      }),
    );
  });

  it("keeps a valid minimal app payload executable as warning-only portable metadata", async () => {
    const built = await buildAethonBackupContainer({
      payloads: [buildAethonAppPayload({ defaultLocalProfileId: "main" })],
    });

    const plan = await buildAethonRestorePlan(built.bytes, PLANNER_RUNTIME);
    const app = plan.payloads[0];

    expect(app.kind).toBe("app");
    expect(app.status).toBe("warning-only");
    expect(app.canExecuteRestore).toBe(true);
    expect(app.canRestoreNow).toBe(true);
    expect(app.needsUserAction).toBe(false);
    expect(app.selectedByDefault).toBe(true);
    expect(app.warnings).toContainEqual(expect.objectContaining({ code: "portable-metadata-only" }));
  });

  it("surfaces unsupported payload versions and unknown payload kinds safely", async () => {
    const unsupportedVersion = await buildAethonBackupContainer({
      payloads: [
        {
          kind: "novels",
          payloadVersion: 99,
          files: [{ path: "novels.json", bytes: JSON.stringify({ version: 1, entries: [] }) }],
        },
      ],
    });

    const unsupportedPlan = await buildAethonRestorePlan(unsupportedVersion.bytes, PLANNER_RUNTIME);
    expect(unsupportedPlan.payloads[0]).toEqual(
      expect.objectContaining({
        kind: "novels",
        status: "unsupported",
        canRestoreNow: false,
        needsUserAction: false,
      }),
    );

    const unknownPlan = await buildAethonRestorePlan(await buildUnknownPayloadContainer(), PLANNER_RUNTIME);
    expect(unknownPlan.payloads[0]).toEqual(
      expect.objectContaining({
        kind: "mystery",
        status: "unsupported",
      }),
    );
  });

  it("can emit real phase-5 audit artifacts when env vars are provided", async () => {
    const outputDir = process.env.AETHON_PHASE5_OUTPUT_DIR?.trim();
    const sourceTachibkPath = process.env.AETHON_MANGA_PHASE3_SOURCE_TACHIBK_PATH?.trim();
    if (!outputDir || !sourceTachibkPath) {
      expect(true).toBe(true);
      return;
    }

    const presentRepo = process.env.AETHON_NOVELS_PHASE4_PRESENT_REPO?.trim() || "https://plugins.example.com/index.json";
    const presentPlugin = process.env.AETHON_NOVELS_PHASE4_PRESENT_PLUGIN?.trim() || "app.lnreader.sources.example";
    const presentSource = process.env.AETHON_NOVELS_PHASE4_PRESENT_SOURCE?.trim() || "example-source";
    const sourceBytes = await fs.readFile(sourceTachibkPath);
    const booksPayload = await buildBooksPayload("full");
    const mangaPayload = await buildAethonMangaPayload(sourceBytes, {
      sourceFilename: path.basename(sourceTachibkPath),
    });
    const novelsPayload = await buildAethonNovelsPayload({
      ...SAMPLE_NOVELS_SNAPSHOT,
      entries: [{
        ...SAMPLE_NOVELS_SNAPSHOT.entries[0],
        source: {
          repositoryUrl: presentRepo,
          pluginId: presentPlugin,
          sourceId: presentSource,
        },
      }],
      repositories: [{ url: presentRepo, name: "Audit Repo" }],
      plugins: [{ id: presentPlugin, repositoryUrl: presentRepo }],
    });
    const appPayload = buildAethonAppPayload({ defaultLocalProfileId: "test" });

    const booksManga = await buildAethonBackupContainer({
      payloads: [mangaPayload, booksPayload],
    });
    const mangaNovels = await buildAethonBackupContainer({
      payloads: [mangaPayload, novelsPayload],
    });
    const booksNovels = await buildAethonBackupContainer({
      payloads: [novelsPayload, booksPayload],
    });
    const unsupported = await buildAethonBackupContainer({
      payloads: [
        booksPayload,
        {
          kind: "novels",
          payloadVersion: 99,
          files: [{ path: "novels.json", bytes: JSON.stringify({ version: 1, entries: [] }) }],
        },
      ],
    });
    const appPresent = await buildAethonBackupContainer({
      payloads: [booksPayload, appPayload],
    });

    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "phase5-books-manga.aethonbk"), Buffer.from(booksManga.bytes));
    await fs.writeFile(path.join(outputDir, "phase5-manga-novels.aethonbk"), Buffer.from(mangaNovels.bytes));
    await fs.writeFile(path.join(outputDir, "phase5-books-novels.aethonbk"), Buffer.from(booksNovels.bytes));
    await fs.writeFile(path.join(outputDir, "phase5-unsupported-version.aethonbk"), Buffer.from(unsupported.bytes));
    await fs.writeFile(path.join(outputDir, "phase5-app-present.aethonbk"), Buffer.from(appPresent.bytes));

    expect((await fs.stat(path.join(outputDir, "phase5-books-manga.aethonbk"))).size).toBeGreaterThan(0);
  });
});
