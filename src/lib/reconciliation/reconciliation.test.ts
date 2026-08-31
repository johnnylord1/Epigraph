import pako from "pako";
import protobuf from "protobufjs";
import { describe, expect, it } from "vitest";
import { BACKUP_TOP_LEVEL_MANGA_FIELD, BACKUP_TOP_LEVEL_SOURCES_FIELD, createReconciledBackupPayload, parseMihonBackup } from "../backup/mihonBackup";
import { MIHON_BACKUP_PROTO } from "../backup/mihonProto";
import { overlayEntryFromAnalysis } from "./analyze";
import { DEFAULT_CLUSTER_INFERENCE_CONFIG } from "./constants";
import { resolveExactCluster } from "./exact";
import { rankRepresentativeManga, scoreClusterCandidates, shouldAutoSelectCandidate } from "./inference";
import { buildRestoreReadiness } from "./readiness";
import { buildExcludedSourceIds, buildSourceMapping } from "./restore";
import type { AvailableExtensionEntry, ParsedBackup, ReconciliationAnalysis, ReconciliationCandidate, SourceInventoryEntry } from "./types";

const root = protobuf.parse(MIHON_BACKUP_PROTO).root;
const BackupType = root.lookupType("Backup");

function buildBackupFixture() {
  const payload = BackupType.encode({
    backupManga: [
      {
        source: "123",
        url: "/series/nano-machine",
        title: "Nano Machine",
        author: "Jeolmu Hyeonseong",
        artist: "Geumgang Bulgoe",
        chapters: [{ url: "/c1", name: "1", chapterNumber: 1 }],
        tracking: [{ syncId: 7 }],
      },
      {
        source: "999",
        url: "/series/comick-title",
        title: "Comick Title",
        author: "Author A",
        artist: "Artist A",
        chapters: [{ url: "/c1", name: "1", chapterNumber: 1 }, { url: "/c2", name: "2", chapterNumber: 2 }],
      },
    ],
    backupSources: [
      { name: "MangaDex", sourceId: "123" },
      { name: "Comick", sourceId: "999" },
    ],
  }).finish();
  return pako.gzip(payload);
}

function buildDuplicateBackupFixture() {
  const payload = BackupType.encode({
    backupManga: [
      {
        source: "6247824327199706550",
        url: "/manga/solo-max-level-newbie/#solo+max+level+newbie",
        title: "Solo Max-Level Newbie",
        author: "Maslow",
        artist: "Swingbat",
        categories: ["0", "1"],
        chapters: [
          { url: "/c1", name: "1", chapterNumber: 1, sourceOrder: "1" },
          { url: "/c2", name: "2", chapterNumber: 2, sourceOrder: "2" },
        ],
        history: [{ url: "/c2", lastRead: "100", readDuration: "10" }],
        tracking: [{ syncId: 2, title: "I'm the Max-Level Newbie", lastChapterRead: 2, totalChapters: 2 }],
      },
      {
        source: "6247824327199706550",
        url: "/manga/solo-max-level-newbie/#solo+max+level+newbie",
        title: "Solo Max-Level Newbie",
        author: "Maslow",
        artist: "Swingbat",
        categories: ["1", "2"],
        chapters: [
          { url: "/c2", name: "2", chapterNumber: 2, sourceOrder: "2", read: true, lastPageRead: "12" },
          { url: "/c3", name: "3", chapterNumber: 3, sourceOrder: "3" },
        ],
        history: [{ url: "/c3", lastRead: "200", readDuration: "20" }],
        tracking: [{ syncId: 2, title: "I'm the Max-Level Newbie", lastChapterRead: 3, totalChapters: 3 }],
      },
    ],
    backupSources: [
      { name: "Asura Scans", sourceId: "6247824327199706550" },
    ],
  }).finish();
  return pako.gzip(payload);
}

describe("backup parser", () => {
  it("counts only library favorites while preserving read entries outside the library", async () => {
    const payload = BackupType.encode({
      backupManga: [
        { source: "123", url: "/library", title: "Library title" },
        { source: "123", url: "/history-only", title: "History only", favorite: false },
      ],
    }).finish();

    const parsed = await parseMihonBackup(pako.gzip(payload), []);

    expect(parsed.backupManga.map((entry) => entry.title)).toEqual(["Library title"]);
    expect(parsed.mangaMessages).toHaveLength(2);
  });

  it("preserves J2K custom manga metadata when rebuilding a reconciled backup", async () => {
    const payload = BackupType.encode({
      backupManga: [{
        source: "123",
        url: "/library",
        title: "Original title",
        customTitle: "My title",
        customAuthor: "My author",
        customGenre: ["Custom"],
        customStatus: 2,
        memo: "{\"note\":\"keep me\"}",
      }],
    }).finish();
    const parsed = await parseMihonBackup(pako.gzip(payload), []);

    const rebuilt = createReconciledBackupPayload(parsed, {});
    const reparsed = await parseMihonBackup(rebuilt, []);

    expect(reparsed.mangaMessages[0]).toMatchObject({
      customTitle: "My title",
      customAuthor: "My author",
      customGenre: ["Custom"],
      customStatus: 2,
      memo: "{\"note\":\"keep me\"}",
    });
  });

  it("extracts reconciliation fields from a mihon-compatible backup", async () => {
    const inventory: SourceInventoryEntry[] = [
      {
        sourceId: "123",
        name: "MangaDex",
        lang: "en",
        displayName: "MangaDex",
        kind: "installed",
        extensionPkgName: null,
        extensionName: null,
        extensionInstalled: true,
      },
    ];
    const parsed = await parseMihonBackup(buildBackupFixture(), inventory);
    expect(parsed.backupSources).toEqual([
      { sourceId: "123", name: "MangaDex", lang: "en" },
      { sourceId: "999", name: "Comick", lang: null },
    ]);
    expect(parsed.backupManga[0].title).toBe("Nano Machine");
    expect(parsed.trackerIds).toEqual([7]);
  });

  it("stores lang as null when derivation is ambiguous", async () => {
    const inventory: SourceInventoryEntry[] = [
      {
        sourceId: "1",
        name: "Comick",
        lang: "en",
        displayName: "Comick EN",
        kind: "repo",
        extensionPkgName: "pkg1",
        extensionName: "Comick EN",
        extensionInstalled: false,
      },
      {
        sourceId: "2",
        name: "Comick",
        lang: "pt",
        displayName: "Comick PT",
        kind: "repo",
        extensionPkgName: "pkg2",
        extensionName: "Comick PT",
        extensionInstalled: false,
      },
    ];
    const parsed = await parseMihonBackup(buildBackupFixture(), inventory);
    expect(parsed.backupSources[1].lang).toBeNull();
  });

  it("preserves 64-bit source ids exactly without numeric rounding", async () => {
    const payload = BackupType.encode({
      backupManga: [
        {
          source: "2499283573021220255",
          url: "/title",
          title: "Exact Int64 Title",
          chapters: [],
        },
      ],
      backupSources: [
        { name: "MangaDex", sourceId: "2499283573021220255" },
      ],
    }).finish();

    const parsed = await parseMihonBackup(pako.gzip(payload), [
      {
        sourceId: "2499283573021220255",
        name: "MangaDex",
        lang: "en",
        displayName: "MangaDex (EN)",
        kind: "installed",
        extensionPkgName: null,
        extensionName: null,
        extensionInstalled: true,
      },
    ]);

    expect(parsed.backupSources[0].sourceId).toBe("2499283573021220255");
    expect(parsed.backupManga[0].sourceId).toBe("2499283573021220255");
  });
});

describe("exact reconciliation", () => {
  const cluster = {
    orphanSourceId: "123",
    sourceName: "MangaDex",
    sourceLang: "en" as string | null,
    mangas: [],
  };

  it("resolves by exact installed source id", () => {
    const inventory: SourceInventoryEntry[] = [
      {
        sourceId: "123",
        name: "MangaDex",
        lang: "en",
        displayName: "MangaDex",
        kind: "installed",
        extensionPkgName: null,
        extensionName: null,
        extensionInstalled: true,
      },
    ];
    const result = resolveExactCluster(cluster, inventory);
    expect(result.status).toBe("exact_resolved");
    expect(result.selectedCandidate?.reasonCode).toBe("installed-source-id");
  });

  it("resolves by exact repo source id", () => {
    const inventory: SourceInventoryEntry[] = [
      {
        sourceId: "123",
        name: "MangaDex",
        lang: "en",
        displayName: "MangaDex",
        kind: "repo",
        extensionPkgName: "pkg",
        extensionName: "MangaDex",
        extensionInstalled: false,
      },
    ];
    const result = resolveExactCluster(cluster, inventory);
    expect(result.selectedCandidate?.reasonCode).toBe("repo-source-id");
  });

  it("resolves by exact normalized source name plus lang", () => {
    const inventory: SourceInventoryEntry[] = [
      {
        sourceId: "321",
        name: "MangaDex",
        lang: "en",
        displayName: "MangaDex",
        kind: "installed",
        extensionPkgName: null,
        extensionName: null,
        extensionInstalled: true,
      },
    ];
    const result = resolveExactCluster({ ...cluster, orphanSourceId: "999" }, inventory);
    expect(result.selectedCandidate?.reasonCode).toBe("source-name-lang");
  });
});

describe("sampling and scoring", () => {
  it("prefers representative manga with richer metadata instead of first-in-cluster order", () => {
    const ranked = rankRepresentativeManga([
      { sourceId: "1", url: "", title: "Go", author: null, artist: null, chapterCount: null, thumbnailUrl: null },
      { sourceId: "1", url: "/series/swordmasters-youngest-son", title: "Swordmaster's Youngest Son", author: "Author", artist: "Artist", chapterCount: 120, thumbnailUrl: null },
    ]);
    expect(ranked[0].title).toBe("Swordmaster's Youngest Son");
  });

  it("auto-selects a high-confidence inferred candidate", () => {
    const candidates: ReconciliationCandidate[] = [
      {
        sourceId: "a",
        sourceName: "Comick",
        sourceLang: "en",
        displayName: "Comick",
        confidence: 0.93,
        reasonCode: "cluster-inference",
        evidenceSummary: "3 sampled manga pointed to Comick.",
        requiresInstall: false,
        extensionPkgName: null,
        extensionName: null,
        scoreBreakdown: {
          titleSimilarity: 0.97,
          authorSimilarity: 0.84,
          artistSimilarity: 0.8,
          chapterSimilarity: 0.9,
          slugSimilarity: 0.9,
          consistency: 1,
        },
      },
      {
        sourceId: "b",
        sourceName: "Mangakakalot",
        sourceLang: "en",
        displayName: "Mangakakalot",
        confidence: 0.71,
        reasonCode: "cluster-inference",
        evidenceSummary: "Weak secondary candidate.",
        requiresInstall: false,
        extensionPkgName: null,
        extensionName: null,
        scoreBreakdown: {
          titleSimilarity: 0.7,
          authorSimilarity: 0.6,
          artistSimilarity: 0.5,
          chapterSimilarity: 0.7,
          slugSimilarity: 0.6,
          consistency: 0.66,
        },
      },
    ];
    expect(shouldAutoSelectCandidate(candidates, 3, DEFAULT_CLUSTER_INFERENCE_CONFIG)?.sourceId).toBe("a");
  });

  it("keeps ambiguous candidates for manual review", () => {
    const candidates: ReconciliationCandidate[] = [
      {
        sourceId: "a",
        sourceName: "A",
        sourceLang: "en",
        displayName: "A",
        confidence: 0.84,
        reasonCode: "cluster-inference",
        evidenceSummary: "Candidate A",
        requiresInstall: false,
        extensionPkgName: null,
        extensionName: null,
        scoreBreakdown: { titleSimilarity: 0.8, authorSimilarity: 0.8, artistSimilarity: 0.8, chapterSimilarity: 0.8, slugSimilarity: 0.8, consistency: 1 },
      },
      {
        sourceId: "b",
        sourceName: "B",
        sourceLang: "en",
        displayName: "B",
        confidence: 0.78,
        reasonCode: "cluster-inference",
        evidenceSummary: "Candidate B",
        requiresInstall: false,
        extensionPkgName: null,
        extensionName: null,
        scoreBreakdown: { titleSimilarity: 0.79, authorSimilarity: 0.75, artistSimilarity: 0.7, chapterSimilarity: 0.74, slugSimilarity: 0.72, consistency: 1 },
      },
    ];
    expect(shouldAutoSelectCandidate(candidates, 3, DEFAULT_CLUSTER_INFERENCE_CONFIG)).toBeNull();
  });

  it("scores cluster candidates in descending order", () => {
    const ranked = scoreClusterCandidates([
      {
        entry: {
          sourceId: "a",
          name: "A",
          lang: "en",
          displayName: "A",
          kind: "installed",
          extensionPkgName: null,
          extensionName: null,
          extensionInstalled: true,
        },
        titleSimilarity: [0.95],
        authorSimilarity: [0.8],
        artistSimilarity: [0.8],
        chapterSimilarity: [0.9],
        slugSimilarity: [0.9],
        supportingTitles: ["Nano Machine"],
      },
      {
        entry: {
          sourceId: "b",
          name: "B",
          lang: "en",
          displayName: "B",
          kind: "installed",
          extensionPkgName: null,
          extensionName: null,
          extensionInstalled: true,
        },
        titleSimilarity: [0.7],
        authorSimilarity: [0.6],
        artistSimilarity: [0.6],
        chapterSimilarity: [0.7],
        slugSimilarity: [0.6],
        supportingTitles: ["Nano Machine"],
      },
    ] as never);
    expect(ranked[0].sourceId).toBe("a");
  });
});

describe("overlay and reconciled payload", () => {
  it("persists accepted mappings in the overlay record", () => {
    const analysis: ReconciliationAnalysis = {
      backupFingerprint: "backup",
      sourceInventoryFingerprint: "inventory",
      exactMatches: [],
      autoReconciled: [],
      needsReview: [
        {
          orphanSourceId: "999",
          sourceName: "Comick",
          sourceLang: null,
          status: "needs_review",
          sampleManga: [],
          selectedCandidate: null,
          candidates: [
            {
              sourceId: "321",
              sourceName: "Comick",
              sourceLang: "en",
              displayName: "Comick",
              confidence: 0.91,
              reasonCode: "cluster-inference",
              evidenceSummary: "good",
              requiresInstall: false,
              extensionPkgName: null,
              extensionName: null,
            },
          ],
        },
      ],
      unresolved: [],
      warnings: [],
    };
    const overlay = overlayEntryFromAnalysis(analysis);
    expect(overlay.clusters["999"].candidates[0].sourceId).toBe("321");
  });

  it("builds source mapping from persisted review selections", () => {
    const analysis: ReconciliationAnalysis = {
      backupFingerprint: "backup",
      sourceInventoryFingerprint: "inventory",
      exactMatches: [],
      autoReconciled: [],
      needsReview: [
        {
          orphanSourceId: "999",
          sourceName: "Comick",
          sourceLang: null,
          status: "needs_review",
          sampleManga: [],
          selectedCandidate: null,
          candidates: [
            {
              sourceId: "321",
              sourceName: "Comick",
              sourceLang: "en",
              displayName: "Comick",
              confidence: 0.91,
              reasonCode: "cluster-inference",
              evidenceSummary: "good",
              requiresInstall: false,
              extensionPkgName: null,
              extensionName: null,
            },
          ],
        },
      ],
      unresolved: [],
      warnings: [],
    };
    const mapping = buildSourceMapping(analysis, { "999": "321" });
    expect(mapping["999"].sourceId).toBe("321");
  });

  it("excludes unresolved and skipped source clusters from the restore payload path", () => {
    const analysis: ReconciliationAnalysis = {
      backupFingerprint: "backup",
      sourceInventoryFingerprint: "inventory",
      exactMatches: [],
      autoReconciled: [],
      needsReview: [
        {
          orphanSourceId: "111",
          sourceName: "Ambiguous",
          sourceLang: null,
          status: "needs_review",
          sampleManga: [],
          selectedCandidate: null,
          candidates: [],
        },
      ],
      unresolved: [
        {
          orphanSourceId: "222",
          sourceName: "Unresolved",
          sourceLang: null,
          status: "unresolved",
          sampleManga: [],
          selectedCandidate: null,
          candidates: [],
        },
      ],
      warnings: [],
    };

    expect(buildExcludedSourceIds(analysis, {})).toEqual(["222", "111"]);
    expect(buildExcludedSourceIds(analysis, { "111": "skip" })).toEqual(["222", "111"]);
    expect(buildExcludedSourceIds(analysis, { "111": "333" })).toEqual(["222"]);
  });

  it("creates a reconciled payload in memory without mutating the original backup bytes", async () => {
    const inventory: SourceInventoryEntry[] = [
      {
        sourceId: "123",
        name: "MangaDex",
        lang: "en",
        displayName: "MangaDex",
        kind: "installed",
        extensionPkgName: null,
        extensionName: null,
        extensionInstalled: true,
      },
      {
        sourceId: "321",
        name: "Comick",
        lang: "en",
        displayName: "Comick",
        kind: "installed",
        extensionPkgName: null,
        extensionName: null,
        extensionInstalled: true,
      },
    ];
    const originalBytes = buildBackupFixture();
    const parsed = await parseMihonBackup(originalBytes, inventory);
    const originalDecoded = new Uint8Array(parsed.bytes);
    const payload = createReconciledBackupPayload(parsed as ParsedBackup, {
      "999": { sourceId: "321", name: "Comick", lang: "en" },
    });
    const reparsed = await parseMihonBackup(payload, inventory);
    expect(reparsed.backupManga[1].sourceId).toBe("321");
    expect(Array.from(parsed.bytes)).toEqual(Array.from(originalDecoded));
  });

  it("deduplicates repeated manga snapshots in the reconciled payload before restore", async () => {
    const inventory: SourceInventoryEntry[] = [
      {
        sourceId: "6247824327199706550",
        name: "Asura Scans",
        lang: "en",
        displayName: "Asura Scans (EN)",
        kind: "installed",
        extensionPkgName: null,
        extensionName: null,
        extensionInstalled: true,
      },
    ];

    const parsed = await parseMihonBackup(buildDuplicateBackupFixture(), inventory);
    expect(parsed.backupManga).toHaveLength(2);

    const reconciled = createReconciledBackupPayload(parsed, {});
    const reparsed = await parseMihonBackup(reconciled, inventory);

    expect(reparsed.backupManga).toHaveLength(1);
    expect(reparsed.backupManga[0].title).toBe("Solo Max-Level Newbie");

    const decoded = pako.ungzip(reconciled);
    const reader = protobuf.Reader.create(decoded);
    const mangaMessages: any[] = [];
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      const fieldNo = tag >>> 3;
      const wireType = tag & 7;
      if (wireType === 2 && fieldNo === BACKUP_TOP_LEVEL_MANGA_FIELD) {
        const len = reader.uint32();
        const start = reader.pos;
        const end = start + len;
        mangaMessages.push(root.lookupType("BackupManga").decode(reader.buf.subarray(start, end)));
        reader.pos = end;
        continue;
      }
      reader.skipType(wireType);
    }

    expect(mangaMessages).toHaveLength(1);
    expect(mangaMessages[0].chapters).toHaveLength(3);
    expect(mangaMessages[0].categories.map((value: any) => value.toString()).sort()).toEqual(["0", "1", "2"]);
    expect(mangaMessages[0].tracking[0].lastChapterRead).toBe(3);
  });

  it("omits unresolved source clusters from the uploaded reconciled payload", async () => {
    const inventory: SourceInventoryEntry[] = [
      {
        sourceId: "123",
        name: "MangaDex",
        lang: "en",
        displayName: "MangaDex",
        kind: "installed",
        extensionPkgName: null,
        extensionName: null,
        extensionInstalled: true,
      },
    ];

    const originalBytes = buildBackupFixture();
    const parsed = await parseMihonBackup(originalBytes, inventory);
    const payload = createReconciledBackupPayload(parsed, {}, ["999"]);
    const reparsed = await parseMihonBackup(payload, inventory);

    expect(reparsed.backupManga).toHaveLength(1);
    expect(reparsed.backupManga[0].title).toBe("Nano Machine");
    expect(reparsed.backupSources).toHaveLength(1);
    expect(reparsed.backupSources[0].sourceId).toBe("123");
  });
});

describe("restore readiness", () => {
  const availableExtensions: AvailableExtensionEntry[] = [
    {
      apkName: "pkg1.apk",
      pkgName: "pkg1",
      name: "Tachiyomi: Comick",
      lang: "en",
      versionName: "1.0.0",
      isInstalled: false,
      isObsolete: false,
      hasUpdate: false,
      iconUrl: "",
      repoSources: [],
    },
  ];

  it("treats installed targets as ready now", () => {
    const analysis: ReconciliationAnalysis = {
      backupFingerprint: "backup",
      sourceInventoryFingerprint: "inventory",
      exactMatches: [
        {
          orphanSourceId: "1",
          sourceName: "MangaDex",
          sourceLang: "en",
          status: "exact_resolved",
          sampleManga: [],
          selectedCandidate: {
            sourceId: "123",
            sourceName: "MangaDex",
            sourceLang: "en",
            displayName: "MangaDex",
            confidence: 1,
            reasonCode: "installed-source-id",
            evidenceSummary: "installed",
            requiresInstall: false,
            extensionPkgName: null,
            extensionName: null,
          },
          candidates: [],
        },
      ],
      autoReconciled: [],
      needsReview: [],
      unresolved: [],
      warnings: [],
    };

    const readiness = buildRestoreReadiness(analysis, {}, [
      {
        sourceId: "123",
        name: "MangaDex",
        lang: "en",
        displayName: "MangaDex",
        kind: "installed",
        extensionPkgName: null,
        extensionName: null,
        extensionInstalled: true,
      },
    ], []);

    expect(readiness.readyNowCount).toBe(1);
    expect(readiness.blocksRestore).toBe(false);
  });

  it("gates restore when a reconciled target still requires extension install", () => {
    const analysis: ReconciliationAnalysis = {
      backupFingerprint: "backup",
      sourceInventoryFingerprint: "inventory",
      exactMatches: [
        {
          orphanSourceId: "2",
          sourceName: "Comick",
          sourceLang: "en",
          status: "exact_resolved",
          sampleManga: [],
          selectedCandidate: {
            sourceId: "321",
            sourceName: "Comick",
            sourceLang: "en",
            displayName: "Comick",
            confidence: 1,
            reasonCode: "repo-source-id",
            evidenceSummary: "repo",
            requiresInstall: true,
            extensionPkgName: "pkg1",
            extensionName: "Tachiyomi: Comick",
          },
          candidates: [],
        },
      ],
      autoReconciled: [],
      needsReview: [],
      unresolved: [],
      warnings: [],
    };

    const readiness = buildRestoreReadiness(analysis, {}, [], availableExtensions);
    expect(readiness.requiresInstallCount).toBe(1);
    expect(readiness.installableExtensions).toHaveLength(1);
    expect(readiness.blocksRestore).toBe(true);
  });

  it("keeps ambiguous leftovers unresolved until the user explicitly chooses", () => {
    const analysis: ReconciliationAnalysis = {
      backupFingerprint: "backup",
      sourceInventoryFingerprint: "inventory",
      exactMatches: [],
      autoReconciled: [],
      needsReview: [
        {
          orphanSourceId: "3",
          sourceName: "Ambiguous",
          sourceLang: "en",
          status: "needs_review",
          sampleManga: [],
          selectedCandidate: null,
          candidates: [
            {
              sourceId: "321",
              sourceName: "Comick",
              sourceLang: "en",
              displayName: "Comick",
              confidence: 0.9,
              reasonCode: "cluster-inference",
              evidenceSummary: "candidate",
              requiresInstall: true,
              extensionPkgName: "pkg1",
              extensionName: "Tachiyomi: Comick",
            },
          ],
        },
      ],
      unresolved: [],
      warnings: [],
    };

    const readiness = buildRestoreReadiness(analysis, {}, [], availableExtensions);
    expect(readiness.unresolvedCount).toBe(1);
    expect(readiness.requiresInstallCount).toBe(0);

    const selected = buildRestoreReadiness(analysis, { "3": "321" }, [], availableExtensions);
    expect(selected.requiresInstallCount).toBe(1);
  });
});
