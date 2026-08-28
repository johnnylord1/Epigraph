import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  EPIGRAPH_BACKUP_CHECKSUMS_PATH,
  EPIGRAPH_BACKUP_CONTAINER_VERSION,
  EPIGRAPH_BACKUP_EXTENSION,
  EPIGRAPH_BACKUP_FORMAT,
  EPIGRAPH_BACKUP_MANIFEST_PATH,
  EPIGRAPH_BACKUP_PAYLOAD_REGISTRY,
  buildEpigraphBackupContainer,
  buildEpigraphBackupFilename,
  inspectEpigraphBackupContainer,
} from "./epigraphBackup";

describe("epigraph unified backup container", () => {
  it("builds a canonical .epigraphbk container with manifest, payload registry, and checksums", async () => {
    const built = await buildEpigraphBackupContainer({
      appVersion: "0.0.1",
      platform: "windows",
      sourceSurface: "desktop",
      sourceProfileId: "test",
      payloads: [
        {
          kind: "books",
          exportMode: "full",
          metadata: { includesFiles: true },
          files: [
            {
              path: "library.json",
              bytes: JSON.stringify({ books: [{ id: "book-1", title: "Alpha" }] }),
              contentType: "application/json",
              role: "library",
            },
            {
              path: "files/book-1.epub",
              bytes: "EPUB-BYTES",
              contentType: "application/epub+zip",
              role: "asset",
            },
          ],
        },
        {
          kind: "app",
          metadata: { profileId: "test" },
          files: [
            {
              path: "profile.json",
              bytes: JSON.stringify({ profileId: "test" }),
              contentType: "application/json",
              role: "profile",
            },
          ],
        },
      ],
    });

    expect(built.filename.endsWith(EPIGRAPH_BACKUP_EXTENSION)).toBe(true);
    expect(built.manifest.format).toBe(EPIGRAPH_BACKUP_FORMAT);
    expect(built.manifest.formatVersion).toBe(EPIGRAPH_BACKUP_CONTAINER_VERSION);
    expect(built.manifest.payloads.map((payload) => payload.kind)).toEqual(["books", "app"]);
    expect(built.manifest.payloads[0].manifestPath).toBe(EPIGRAPH_BACKUP_PAYLOAD_REGISTRY.books.manifestPath);
    expect(built.checksums.entries[EPIGRAPH_BACKUP_MANIFEST_PATH]).toBeTypeOf("string");
    expect(built.checksums.entries[EPIGRAPH_BACKUP_CHECKSUMS_PATH]).toBeUndefined();

    const inspected = await inspectEpigraphBackupContainer(built.bytes);

    expect(inspected.hasErrors).toBe(false);
    expect(inspected.issues).toEqual([]);
    expect(inspected.manifest?.source.profileId).toBe("test");
    expect(inspected.payloadManifests.books?.exportMode).toBe("full");
    expect(inspected.payloadManifests.books?.files.map((file) => file.path)).toEqual([
      "library.json",
      "files/book-1.epub",
    ]);
  });

  it("supports subsystem-only containers without forcing every payload family", async () => {
    const built = await buildEpigraphBackupContainer({
      payloads: [
        {
          kind: "manga",
          files: [
            {
              path: "library.tachibk",
              bytes: "RAW-MANGA-BACKUP",
              role: "backup",
            },
          ],
        },
      ],
    });

    expect(built.manifest.payloads).toHaveLength(1);
    expect(built.manifest.payloads[0].kind).toBe("manga");

    const inspected = await inspectEpigraphBackupContainer(built.bytes);
    expect(inspected.hasErrors).toBe(false);
    expect(inspected.payloadManifests.manga?.files[0]?.path).toBe("library.tachibk");
  });

  it("warns on a future payload version without breaking container inspection", async () => {
    const built = await buildEpigraphBackupContainer({
      payloads: [
        {
          kind: "novels",
          payloadVersion: 99,
          files: [{ path: "novels.json", bytes: "{}" }],
        },
      ],
    });

    const inspected = await inspectEpigraphBackupContainer(built.bytes);
    expect(inspected.hasErrors).toBe(false);
    expect(inspected.issues).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "unsupported-payload-version",
        payloadKind: "novels",
      }),
    ]);
  });

  it("detects checksum mismatches in packaged files", async () => {
    const built = await buildEpigraphBackupContainer({
      payloads: [
        {
          kind: "books",
          files: [{ path: "library.json", bytes: '{"books":[]}' }],
        },
      ],
    });

    const zip = await JSZip.loadAsync(built.bytes);
    zip.file("payloads/books/library.json", '{"books":[{"id":"mutated"}]}');
    const mutated = await zip.generateAsync({ type: "uint8array" });

    const inspected = await inspectEpigraphBackupContainer(mutated);
    expect(inspected.hasErrors).toBe(true);
    expect(inspected.issues).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "checksum-mismatch",
        path: "payloads/books/library.json",
      }),
    );
  });

  it("builds a stable default filename", () => {
    const filename = buildEpigraphBackupFilename(new Date("2026-04-08T12:00:00.000Z"));
    expect(filename).toBe("epigraph-backup-2026-04-08.epigraphbk");
  });

  it("imports the legacy Aethon container format without rewriting its payload contract", async () => {
    const zip = new JSZip();
    const manifest = {
      format: "aethon-backup",
      formatVersion: 1,
      createdAt: "2026-04-08T12:00:00.000Z",
      packaging: "zip",
      checksumsPath: "checksums/sha256.json",
      createdBy: { app: "Aethon", version: "0.9.0", platform: "windows" },
      source: { surface: "desktop", profileId: "main" },
      payloads: [],
    };
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
    const digest = await crypto.subtle.digest("SHA-256", manifestBytes);
    const checksum = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    zip.file("manifest.json", manifestBytes);
    zip.file("checksums/sha256.json", JSON.stringify({ algorithm: "sha256", entries: { "manifest.json": checksum } }));

    const inspected = await inspectEpigraphBackupContainer(await zip.generateAsync({ type: "uint8array" }));

    expect(inspected.hasErrors).toBe(false);
    expect(inspected.manifest?.format).toBe("aethon-backup");
    expect(inspected.manifest?.createdBy.app).toBe("Aethon");
  });
});
