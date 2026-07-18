import JSZip from "jszip";
import {
  AETHON_BACKUP_PAYLOAD_REGISTRY,
  buildAethonBackupContainer,
  inspectAethonBackupContainer,
  type AethonBackupPayloadBuildInput,
  type AethonBackupPayloadManifest,
  type BuiltAethonBackupContainer,
  type InspectedAethonBackupContainer,
} from "./aethonBackup";

export const AETHON_MANGA_PAYLOAD_FILE_PATH = "library.tachibk";

export interface ParsedAethonMangaPayload {
  inspection: InspectedAethonBackupContainer;
  payloadManifest: AethonBackupPayloadManifest;
  exportMode: "pipeline";
  payloadBytes: Uint8Array;
  payloadFilename: string;
}

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function fileNameFromPath(path: string | null | undefined, fallback = "manga-backup.tachibk"): string {
  const trimmed = typeof path === "string" ? path.trim() : "";
  if (!trimmed) return fallback;
  const normalized = trimmed.replace(/\\/g, "/");
  const lastSegment = normalized.split("/").filter(Boolean).pop() ?? "";
  return lastSegment || fallback;
}

function ensureTachibkFilename(filename: string | null | undefined): string {
  const base = fileNameFromPath(filename, "manga-backup.tachibk");
  return /\.tachibk$/i.test(base) ? base : `${base}.tachibk`;
}

export async function buildAethonMangaPayload(
  backupBytes: Uint8Array | ArrayBuffer,
  options: {
    sourceFilename?: string | null;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<AethonBackupPayloadBuildInput> {
  return {
    kind: "manga",
    exportMode: "pipeline",
    restoreModesSupported: ["pipeline"],
    requiresRuntime: "suwayomi",
    requiresRepositories: [],
    portableByDefault: true,
    metadata: {
      schemaVersion: 1,
      embeddedFormat: "tachibk",
      sourceFilename: ensureTachibkFilename(options.sourceFilename),
      ...options.metadata,
    },
    files: [
      {
        path: AETHON_MANGA_PAYLOAD_FILE_PATH,
        bytes: toUint8Array(backupBytes),
        contentType: "application/octet-stream",
        role: "backup",
      },
    ],
  };
}

export async function buildAethonMangaBackupContainer(
  backupBytes: Uint8Array | ArrayBuffer,
  options: {
    sourceFilename?: string | null;
    appVersion?: string | null;
    platform?: string | null;
    sourceProfileId?: string | null;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<BuiltAethonBackupContainer> {
  const payload = await buildAethonMangaPayload(backupBytes, {
    sourceFilename: options.sourceFilename,
    metadata: options.metadata,
  });

  return buildAethonBackupContainer({
    appVersion: options.appVersion ?? null,
    platform: options.platform ?? null,
    sourceSurface: "desktop",
    sourceProfileId: options.sourceProfileId ?? null,
    payloads: [payload],
  });
}

export async function parseAethonMangaPayload(
  bytes: Uint8Array | ArrayBuffer,
): Promise<ParsedAethonMangaPayload> {
  const inspection = await inspectAethonBackupContainer(bytes);
  if (inspection.hasErrors) {
    throw new Error("Aethon backup container failed inspection.");
  }

  const payloadManifest = inspection.payloadManifests.manga;
  if (!payloadManifest) {
    throw new Error("The selected Aethon backup does not contain a manga payload.");
  }

  const registry = AETHON_BACKUP_PAYLOAD_REGISTRY.manga;
  const archivePath = `${registry.rootPath}/${AETHON_MANGA_PAYLOAD_FILE_PATH}`;
  const zip = await JSZip.loadAsync(toUint8Array(bytes));
  const file = zip.file(archivePath);
  if (!file) {
    throw new Error(`Manga payload is missing ${AETHON_MANGA_PAYLOAD_FILE_PATH}.`);
  }

  const payloadBytes = await file.async("uint8array");
  const sourceFilename = ensureTachibkFilename(
    typeof payloadManifest.metadata?.sourceFilename === "string"
      ? payloadManifest.metadata.sourceFilename
      : null,
  );

  return {
    inspection,
    payloadManifest,
    exportMode: "pipeline",
    payloadBytes,
    payloadFilename: sourceFilename,
  };
}

export async function extractAethonMangaPayloadFile(
  bytes: Uint8Array | ArrayBuffer,
): Promise<File> {
  const parsed = await parseAethonMangaPayload(bytes);
  const payloadBuffer = new Uint8Array(parsed.payloadBytes.byteLength);
  payloadBuffer.set(parsed.payloadBytes);
  return new File([payloadBuffer.buffer], parsed.payloadFilename, {
    type: "application/octet-stream",
  });
}
