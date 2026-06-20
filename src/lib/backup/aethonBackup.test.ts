import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  AETHON_BACKUP_CHECKSUMS_PATH,
  AETHON_BACKUP_CONTAINER_VERSION,
  AETHON_BACKUP_EXTENSION,
  AETHON_BACKUP_FORMAT,
  AETHON_BACKUP_MANIFEST_PATH,
  AETHON_BACKUP_PAYLOAD_REGISTRY,
  buildAethonBackupContainer,
  buildAethonBackupFilename,
  inspectAethonBackupContainer,
} from "./aethonBackup";

describe("aethon unified backup container", () => {
  it("builds a canonical .aethonbk container with manifest, payload registry, and checksums", async () => {
    const built = await buildAethonBackupContainer({
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

    expect(built.filename.endsWith(AETHON_BACKUP_EXTENSION)).toBe(true);
    expect(built.manifest.format).toBe(AETHON_BACKUP_FORMAT);
    expect(built.manifest.formatVersion).toBe(AETHON_BACKUP_CONTAINER_VERSION);
    expect(built.manifest.payloads.map((payload) => payload.kind)).toEqual(["books", "app"]);
    expect(built.manifest.payloads[0].manifestPath).toBe(AETHON_BACKUP_PAYLOAD_REGISTRY.books.manifestPath);
    expect(built.checksums.entries[AETHON_BACKUP_MANIFEST_PATH]).toBeTypeOf("string");
    expect(built.checksums.entries[AETHON_BACKUP_CHECKSUMS_PATH]).toBeUndefined();

    const inspected = await inspectAethonBackupContainer(built.bytes);

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
    const built = await buildAethonBackupContainer({
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

    const inspected = await inspectAethonBackupContainer(built.bytes);
    expect(inspected.hasErrors).toBe(false);
    expect(inspected.payloadManifests.manga?.files[0]?.path).toBe("library.tachibk");
  });

  it("warns on a future payload version without breaking container inspection", async () => {
    const built = await buildAethonBackupContainer({
      payloads: [
        {
          kind: "novels",
          payloadVersion: 99,
          files: [{ path: "novels.json", bytes: "{}" }],
        },
      ],
    });

    const inspected = await inspectAethonBackupContainer(built.bytes);
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
    const built = await buildAethonBackupContainer({
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

    const inspected = await inspectAethonBackupContainer(mutated);
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
    const filename = buildAethonBackupFilename(new Date("2026-04-08T12:00:00.000Z"));
    expect(filename).toBe("aethon-backup-2026-04-08.aethonbk");
  });
});
