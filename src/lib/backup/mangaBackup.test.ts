import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEpigraphBackupContainer, inspectEpigraphBackupContainer } from "./epigraphBackup";
import {
  EPIGRAPH_MANGA_PAYLOAD_FILE_PATH,
  buildEpigraphMangaBackupContainer,
  buildEpigraphMangaPayload,
  extractEpigraphMangaPayloadFile,
  parseEpigraphMangaPayload,
} from "./mangaBackup";

const SAMPLE_TACHIBK_BYTES = new TextEncoder().encode("RAW-TACHIBK-BYTES");

describe("manga backup payload", () => {
  it("embeds a native tachibk payload without rewriting it into a synthetic schema", async () => {
    const built = await buildEpigraphMangaBackupContainer(SAMPLE_TACHIBK_BYTES, {
      sourceFilename: "library-export.tachibk",
      appVersion: "0.6.9",
      platform: "windows",
      sourceProfileId: "test",
      metadata: {
        mangaCount: 12,
      },
    });

    const inspected = await inspectEpigraphBackupContainer(built.bytes);
    expect(inspected.hasErrors).toBe(false);
    expect(inspected.payloadManifests.manga).toEqual(
      expect.objectContaining({
        exportMode: "pipeline",
        requiresRuntime: "suwayomi",
        portableByDefault: true,
      }),
    );

    const parsed = await parseEpigraphMangaPayload(built.bytes);
    expect(parsed.payloadFilename).toBe("library-export.tachibk");
    expect(parsed.payloadBytes).toEqual(SAMPLE_TACHIBK_BYTES);
    expect(parsed.payloadManifest.files).toEqual([
      expect.objectContaining({
        path: EPIGRAPH_MANGA_PAYLOAD_FILE_PATH,
        role: "backup",
      }),
    ]);
  });

  it("supports mixed unified containers where manga remains a separate payload beside books", async () => {
    const mangaPayload = await buildEpigraphMangaPayload(SAMPLE_TACHIBK_BYTES, {
      sourceFilename: "mixed-export.tachibk",
    });
    const built = await buildEpigraphBackupContainer({
      payloads: [
        mangaPayload,
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
    expect(inspected.manifest?.payloads.map((payload) => payload.kind)).toEqual(["manga", "books"]);

    const parsed = await parseEpigraphMangaPayload(built.bytes);
    expect(parsed.payloadBytes).toEqual(SAMPLE_TACHIBK_BYTES);
    expect(inspected.payloadManifests.books?.files[0]?.path).toBe("library.json");
  });

  it("extracts a restore-ready File that keeps the tachibk extension", async () => {
    const built = await buildEpigraphMangaBackupContainer(SAMPLE_TACHIBK_BYTES, {
      sourceFilename: "phase3-audit",
    });

    const file = await extractEpigraphMangaPayloadFile(built.bytes);
    expect(file.name).toBe("phase3-audit.tachibk");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(SAMPLE_TACHIBK_BYTES);
  });

  it("can emit a real manga .epigraphbk artifact for monitor-3 audit when env vars are provided", async () => {
    const sourcePath = process.env.EPIGRAPH_MANGA_PHASE3_SOURCE_TACHIBK_PATH?.trim();
    const outputDir = process.env.EPIGRAPH_MANGA_PHASE3_OUTPUT_DIR?.trim();

    if (!sourcePath || !outputDir) {
      expect(true).toBe(true);
      return;
    }

    const sourceBytes = await fs.readFile(sourcePath);
    const built = await buildEpigraphMangaBackupContainer(sourceBytes, {
      sourceFilename: path.basename(sourcePath),
      appVersion: "0.6.9",
      platform: "windows",
      sourceProfileId: "test",
      metadata: {
        auditSourcePath: sourcePath,
      },
    });

    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "manga-unified.epigraphbk"), Buffer.from(built.bytes));
    await fs.writeFile(path.join(outputDir, "manga-unified-source.tachibk"), sourceBytes);

    const parsed = await parseEpigraphMangaPayload(built.bytes);
    expect(parsed.payloadBytes.byteLength).toBe(sourceBytes.byteLength);
  });
});
