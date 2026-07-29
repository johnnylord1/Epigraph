import { describe, expect, it } from "vitest";
import {
  buildMangaDownloadedAssetManifest,
  copyVerifiedNovelOfflineAssets,
  type NovelOfflineAssetCachePort,
  type NovelOfflineAssetInspection,
  type OfflineAssetReference,
  type ProvenOfflineAssetPair,
} from "./offlineAssets";

function reference(
  sourceId: string,
  titleId: string,
  chapterId: string,
  chapterPath: string | null,
): OfflineAssetReference {
  return { sourceId, titleId, chapterId, chapterPath };
}

function pair(id = "1"): ProvenOfflineAssetPair {
  return {
    source: reference("source-old", "novel-old", `chapter-old-${id}`, `/old/${id}`),
    target: reference("source-new", "novel-new", `chapter-new-${id}`, `/new/${id}`),
  };
}

function key(referenceValue: OfflineAssetReference): string {
  return [
    referenceValue.sourceId,
    referenceValue.titleId,
    referenceValue.chapterId,
    referenceValue.chapterPath,
  ].join("\0");
}

function memoryPort(
  initial: Array<[OfflineAssetReference, NovelOfflineAssetInspection]> = [],
): {
  port: NovelOfflineAssetCachePort;
  storage: Map<string, NovelOfflineAssetInspection>;
} {
  const storage = new Map(
    initial.map(([referenceValue, inspection]) => [
      key(referenceValue),
      {
        bytes: Uint8Array.from(inspection.bytes),
        valid: inspection.valid,
      },
    ]),
  );

  return {
    storage,
    port: {
      async inspect(referenceValue) {
        const inspection = storage.get(key(referenceValue));
        return inspection
          ? {
              bytes: Uint8Array.from(inspection.bytes),
              valid: inspection.valid,
            }
          : null;
      },
      async write(referenceValue, bytes) {
        storage.set(key(referenceValue), {
          bytes: Uint8Array.from(bytes),
          valid: true,
        });
      },
    },
  };
}

describe("offline migration assets", () => {
  it("copies valid novel content and verifies the persisted bytes", async () => {
    const provenPair = pair();
    const sourceBytes = new TextEncoder().encode("<p>Chapter content</p>");
    const { port, storage } = memoryPort([
      [provenPair.source, { bytes: sourceBytes, valid: true }],
    ]);

    const [entry] = await copyVerifiedNovelOfflineAssets([provenPair], port);

    expect(entry).toMatchObject({
      version: 1,
      kind: "novel",
      size: sourceBytes.byteLength,
      integrity: "verified",
      status: "copied",
      sourcePreserved: true,
    });
    expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(storage.get(key(provenPair.target))?.bytes).toEqual(sourceBytes);
  });

  it("keeps a missing novel source pending without writing a target", async () => {
    const provenPair = pair();
    const { port, storage } = memoryPort();

    const [entry] = await copyVerifiedNovelOfflineAssets([provenPair], port);

    expect(entry).toMatchObject({
      sha256: null,
      size: null,
      integrity: "not_observed",
      status: "pending",
      sourcePreserved: true,
    });
    expect(storage.has(key(provenPair.target))).toBe(false);
  });

  it("marks a copy corrupt when target verification differs from source", async () => {
    const provenPair = pair();
    const sourceBytes = new TextEncoder().encode("<p>Expected</p>");
    const { port, storage } = memoryPort([
      [provenPair.source, { bytes: sourceBytes, valid: true }],
    ]);
    const corruptingPort: NovelOfflineAssetCachePort = {
      inspect: port.inspect,
      async write(referenceValue) {
        storage.set(key(referenceValue), {
          bytes: new TextEncoder().encode("<p>Corrupt</p>"),
          valid: true,
        });
      },
    };

    const [entry] = await copyVerifiedNovelOfflineAssets([provenPair], corruptingPort);

    expect(entry).toMatchObject({
      integrity: "corrupt",
      status: "pending",
      sourcePreserved: true,
    });
  });

  it("does not overwrite a different valid target asset", async () => {
    const provenPair = pair();
    const sourceBytes = new TextEncoder().encode("<p>Source edition</p>");
    const targetBytes = new TextEncoder().encode("<p>Target edition</p>");
    const { port, storage } = memoryPort([
      [provenPair.source, { bytes: sourceBytes, valid: true }],
      [provenPair.target, { bytes: targetBytes, valid: true }],
    ]);

    const [entry] = await copyVerifiedNovelOfflineAssets([provenPair], port);

    expect(entry).toMatchObject({
      integrity: "verified",
      status: "pending",
      sourcePreserved: true,
    });
    expect(storage.get(key(provenPair.target))?.bytes).toEqual(targetBytes);
  });

  it("never removes or changes the source while copying", async () => {
    const provenPair = pair();
    const sourceBytes = new TextEncoder().encode("<p>Preserve me</p>");
    const { port, storage } = memoryPort([
      [provenPair.source, { bytes: sourceBytes, valid: true }],
    ]);

    await copyVerifiedNovelOfflineAssets([provenPair], port);

    expect(storage.get(key(provenPair.source))).toEqual({
      bytes: sourceBytes,
      valid: true,
    });
  });

  it("keeps downloaded manga origins preserved and targets pending", () => {
    const provenPair: ProvenOfflineAssetPair = {
      source: reference("manga-source-old", "manga-old", "101", null),
      target: reference("manga-source-new", "manga-new", "901", null),
    };

    expect(buildMangaDownloadedAssetManifest([provenPair])).toEqual([{
      version: 1,
      kind: "manga",
      source: provenPair.source,
      target: provenPair.target,
      sha256: null,
      size: null,
      integrity: "not_observed",
      status: "pending",
      sourcePreserved: true,
    }]);
  });
});
