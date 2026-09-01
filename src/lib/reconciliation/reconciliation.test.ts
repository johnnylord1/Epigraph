import pako from "pako";
import protobuf from "protobufjs";
import { describe, expect, it } from "vitest";
import { BACKUP_TOP_LEVEL_MANGA_FIELD, BACKUP_TOP_LEVEL_SOURCES_FIELD, createReconciledBackupPayload, embedMihonExtensionStores, parseMihonBackup } from "../backup/mihonBackup";
import { MIHON_BACKUP_PROTO } from "../backup/mihonProto";
import { overlayEntryFromAnalysis } from "./analyze";
import { DEFAULT_CLUSTER_INFERENCE_CONFIG } from "./constants";
import { resolveExactCluster } from "./exact";
import { rankRepresentativeManga, scoreClusterCandidates, shouldAutoSelectCandidate } from "./inference";
import { buildRestoreReadiness } from "./readiness";
import { buildExcludedSourceIds, buildSourceMapping } from "./restore";
import type { AvailableExtensionEntry, NativeSourceRestoreChoice, ParsedBackup, ReconciliationAnalysis, ReconciliationCandidate, SourceInventoryEntry } from "./types";

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
  it("does not mutate unknown source fields when reconciling the same parsed backup twice", async () => {
    const extended = protobuf.parse(MIHON_BACKUP_PROTO.replace("message BackupSource {", "message BackupSource { repeated string futureSource = 2001;")).root.lookupType("Backup");
    const parsed = await parseMihonBackup(extended.encode({ backupSources: [
      { sourceId: "123", name: "Original", futureSource: ["A"] },
      { sourceId: "123", name: "Original", futureSource: ["B"] },
    ] }).finish(), []);
    const first = createReconciledBackupPayload(parsed, {});
    const second = createReconciledBackupPayload(parsed, {});
    expect(extended.toObject(extended.decode(first)).backupSources[0].futureSource).toEqual(["A", "B"]);
    expect(second).toEqual(first);
  });

  it.each([false, true])("preserves unknown nested fork metadata, including explicit remapping: %s", async (remap) => {
    const extended = protobuf.parse(MIHON_BACKUP_PROTO
      .replace("message BackupManga {", "message BackupManga { string futureManga = 2001;")
      .replace("message BackupChapter {", "message BackupChapter { string futureChapter = 2001;")
      .replace("message BackupTracking {", "message BackupTracking { string futureTracking = 2001;")
      .replace("message BackupHistory {", "message BackupHistory { string futureHistory = 2001;")
      .replace("message BackupSource {", "message BackupSource { string futureSource = 2001;")
    ).root.lookupType("Backup");
    const bytes = extended.encode({
      backupManga: [{ source: "123", url: "/title", title: "Title", futureManga: "manga",
        chapters: [{ url: "/1", lastPageRead: "4", futureChapter: "chapter" }],
        tracking: [{ syncId: 1, futureTracking: "tracker" }],
        history: [{ url: "/1", futureHistory: "history" }],
      }],
      backupSources: [{ sourceId: "123", name: "Original", futureSource: "source" }],
    }).finish();
    const parsed = await parseMihonBackup(bytes, []);
    const restored = extended.toObject(extended.decode(createReconciledBackupPayload(parsed,
      remap ? { "123": { sourceId: "456", name: "Destination" } } : {},
    )), { longs: String });
    expect(restored.backupManga[0]).toMatchObject({ source: remap ? "456" : "123", futureManga: "manga",
      chapters: [{ lastPageRead: "4", futureChapter: "chapter" }],
      tracking: [{ futureTracking: "tracker" }], history: [{ futureHistory: "history" }],
    });
    expect(restored.backupSources[0]).toMatchObject({ futureSource: "source" });
  });

  it("exposes official extension stores and preserves their metadata during reconciliation", async () => {
    const storeRoot = protobuf.parse(`
      syntax = "proto3";
      message BackupExtensionStore {
        string indexUrl = 1;
        string name = 2;
        string badgeLabel = 3;
        string contactWebsite = 4;
        string signingKey = 5;
      }
    `).root;
    const StoreType = storeRoot.lookupType("BackupExtensionStore");
    const storeChunk = protobuf.Writer.create()
      .uint32((106 << 3) | 2)
      .bytes(StoreType.encode({
        indexUrl: "https://example.test/index.min.json",
        name: "Example extensions",
        badgeLabel: "Trusted",
        signingKey: "sha256:abc",
        contactWebsite: "https://example.test",
      }).finish())
      .finish();
    const mangaChunk = BackupType.encode({
      backupManga: [{ source: "123", url: "/library", title: "Library title" }],
    }).finish();
    const payload = new Uint8Array(mangaChunk.length + storeChunk.length);
    payload.set(mangaChunk);
    payload.set(storeChunk, mangaChunk.length);

    const parsed = await parseMihonBackup(pako.gzip(payload), []);

    expect(parsed.extensionStores).toEqual([{
      indexUrl: "https://example.test/index.min.json",
      name: "Example extensions",
      badgeLabel: "Trusted",
      signingKey: "sha256:abc",
      contactWebsite: "https://example.test",
    }]);

    const reparsed = await parseMihonBackup(createReconciledBackupPayload(parsed, {}), []);
    expect(reparsed.extensionStores).toEqual(parsed.extensionStores);
  });

  it("embeds configured repositories in a native manga export without duplicating existing stores", async () => {
    const payload = pako.gzip(BackupType.encode({
      backupManga: [{ source: "123", url: "/library", title: "Library title" }],
    }).finish());
    const enriched = embedMihonExtensionStores(payload, [
      { indexUrl: "https://example.test/index.min.json", name: "Example" },
      { indexUrl: "https://example.test/index.min.json/", name: "Duplicate" },
    ]);

    const parsed = await parseMihonBackup(enriched, []);
    expect(parsed.extensionStores).toEqual([expect.objectContaining({ indexUrl: "https://example.test/index.min.json", name: "Example" })]);
    expect(parsed.backupManga).toHaveLength(1);
  });

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
    const j2kType = protobuf.parse(MIHON_BACKUP_PROTO
      .replace("  string memo = 112;\n", "")
      .replace("message BackupManga {", "message BackupManga { string memo = 112;"),
    ).root.lookupType("Backup");
    const payload = j2kType.encode({
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
    const rebuiltMessage = j2kType.toObject(j2kType.decode(pako.ungzip(rebuilt)));

    expect(rebuiltMessage.backupManga[0]).toMatchObject({
      customTitle: "My title",
      customAuthor: "My author",
      customGenre: ["Custom"],
      customStatus: 2,
      memo: "{\"note\":\"keep me\"}",
    });
  });

  it("preserves Mihon and Yokai byte memos plus fork chapter fields byte-for-byte", async () => {
    const forkType = protobuf.parse(MIHON_BACKUP_PROTO
      .replace("  string memo = 112;\n", "")
      .replace("message BackupManga {", "message BackupManga { bytes memo = 112;")
      .replace("message BackupChapter {", "message BackupChapter { bytes memo = 13; int32 pagesLeft = 800;"),
    ).root.lookupType("Backup");
    const mangaMemo = Uint8Array.from([0xff, 0x00, 0x80, 0x7b, 0x7d]);
    const chapterMemo = Uint8Array.from([0xfe, 0x81, 0x00, 0x41]);
    const payload = forkType.encode({
      backupManga: [{
        source: "123",
        url: "/library",
        title: "Library title",
        memo: mangaMemo,
        chapters: [{ url: "/chapter-1", name: "Chapter 1", memo: chapterMemo, pagesLeft: 17 }],
      }],
    }).finish();

    const parsed = await parseMihonBackup(payload, []);
    const rebuilt = createReconciledBackupPayload(parsed, {});
    const decoded = forkType.toObject(forkType.decode(rebuilt), { bytes: Array });

    expect(decoded.backupManga[0].memo).toEqual([...mangaMemo]);
    expect(decoded.backupManga[0].chapters[0]).toMatchObject({
      memo: [...chapterMemo],
      pagesLeft: 17,
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
    const mapping = buildSourceMapping(analysis, {
      "999": { mode: "map", sourceId: "321", name: "Comick", lang: "en" },
    });
    expect(mapping["999"].sourceId).toBe("321");
  });

  it("preserves unresolved sources unless the user explicitly skips them", () => {
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

    expect(buildExcludedSourceIds(analysis, {})).toEqual([]);
    expect(buildExcludedSourceIds(analysis, {
      "111": { mode: "skip" },
      "222": { mode: "preserve" },
    })).toEqual(["111"]);
    expect(buildExcludedSourceIds(analysis, {
      "111": { mode: "map", sourceId: "333", name: "Mapped source", lang: "en" },
      "222": { mode: "skip" },
    })).toEqual(["222"]);
  });

  it("only remaps a source after an explicit map choice", () => {
    const candidate: ReconciliationCandidate = {
      sourceId: "333",
      sourceName: "Mapped source",
      sourceLang: "en",
      displayName: "Mapped source",
      confidence: 0.99,
      reasonCode: "cluster-inference",
      evidenceSummary: "high confidence",
      requiresInstall: false,
      extensionPkgName: null,
      extensionName: null,
    };
    const analysis: ReconciliationAnalysis = {
      backupFingerprint: "backup",
      sourceInventoryFingerprint: "inventory",
      exactMatches: [],
      autoReconciled: [{
        orphanSourceId: "111",
        sourceName: "Old source",
        sourceLang: "en",
        status: "auto_reconciled",
        sampleManga: [],
        selectedCandidate: candidate,
        candidates: [candidate],
      }],
      needsReview: [],
      unresolved: [],
      warnings: [],
    };
    const choices: Record<string, NativeSourceRestoreChoice> = {
      "111": { mode: "map", sourceId: "333", name: "Mapped source", lang: "en" },
    };

    expect(buildSourceMapping(analysis, {})).toEqual({});
    expect(buildSourceMapping(analysis, choices)).toEqual({
      "111": { sourceId: "333", name: "Mapped source", lang: "en" },
    });
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
          orphanSourceId: "123",
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
          orphanSourceId: "321",
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

    const selected = buildRestoreReadiness(analysis, {
      "3": { mode: "map", sourceId: "321", name: "Comick", lang: "en" },
    }, [], availableExtensions);
    expect(selected.requiresInstallCount).toBe(1);
  });

  it.each(["auto_reconciled", "exact_resolved"] as const)("requires consent even for a same-name match with a different source ID: %s", (status) => {
    const candidate: ReconciliationCandidate = {
      sourceId: "321",
      sourceName: "Comick",
      sourceLang: "en",
      displayName: "Comick",
      confidence: 0.98,
      reasonCode: "cluster-inference",
      evidenceSummary: "high confidence",
      requiresInstall: true,
      extensionPkgName: "pkg1",
      extensionName: "Tachiyomi: Comick",
    };
    const analysis: ReconciliationAnalysis = {
      backupFingerprint: "backup",
      sourceInventoryFingerprint: "inventory",
      exactMatches: [],
      autoReconciled: [{
        orphanSourceId: "4",
        sourceName: "Comick",
        sourceLang: "en",
        status,
        sampleManga: [],
        selectedCandidate: candidate,
        candidates: [candidate],
      }],
      needsReview: [],
      unresolved: [],
      warnings: [],
    };

    expect(buildRestoreReadiness(analysis, {}, [], availableExtensions).requiresInstallCount).toBe(0);
    expect(buildRestoreReadiness(analysis, {
      "4": { mode: "map", sourceId: "321", name: "Comick", lang: "en" },
    }, [], availableExtensions).requiresInstallCount).toBe(1);
  });
});
