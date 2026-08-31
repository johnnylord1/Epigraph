import JSZip from "jszip";
import {
  EPIGRAPH_BACKUP_PAYLOAD_REGISTRY,
  buildEpigraphBackupContainer,
  inspectEpigraphBackupContainer,
  type EpigraphBackupPayloadBuildInput,
  type EpigraphBackupPayloadManifest,
  type BuiltEpigraphBackupContainer,
  type InspectedEpigraphBackupContainer,
} from "./epigraphBackup";

export const EPIGRAPH_MANGA_PAYLOAD_FILE_PATH = "library.tachibk";

export interface ParsedEpigraphMangaPayload {
  inspection: InspectedEpigraphBackupContainer;
  payloadManifest: EpigraphBackupPayloadManifest;
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

export async function buildEpigraphMangaPayload(
  backupBytes: Uint8Array | ArrayBuffer,
  options: {
    sourceFilename?: string | null;
    metadata?: Record<string, unknown>;
    repositoryUrls?: string[];
  } = {},
): Promise<EpigraphBackupPayloadBuildInput> {
  const repositoryUrls = [...new Set(
    (options.repositoryUrls ?? [])
      .map((value) => value.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  )];
  return {
    kind: "manga",
    exportMode: "pipeline",
    restoreModesSupported: ["pipeline"],
    requiresRuntime: "suwayomi",
    requiresRepositories: repositoryUrls,
    portableByDefault: true,
    metadata: {
      schemaVersion: 1,
      embeddedFormat: "tachibk",
      sourceFilename: ensureTachibkFilename(options.sourceFilename),
      repositoryCount: repositoryUrls.length,
      ...options.metadata,
    },
    files: [
      {
        path: EPIGRAPH_MANGA_PAYLOAD_FILE_PATH,
        bytes: toUint8Array(backupBytes),
        contentType: "application/octet-stream",
        role: "backup",
      },
    ],
  };
}

export async function buildEpigraphMangaBackupContainer(
  backupBytes: Uint8Array | ArrayBuffer,
  options: {
    sourceFilename?: string | null;
    appVersion?: string | null;
    platform?: string | null;
    sourceProfileId?: string | null;
    metadata?: Record<string, unknown>;
    repositoryUrls?: string[];
  } = {},
): Promise<BuiltEpigraphBackupContainer> {
  const payload = await buildEpigraphMangaPayload(backupBytes, {
    sourceFilename: options.sourceFilename,
    metadata: options.metadata,
    repositoryUrls: options.repositoryUrls,
  });

  return buildEpigraphBackupContainer({
    appVersion: options.appVersion ?? null,
    platform: options.platform ?? null,
    sourceSurface: "desktop",
    sourceProfileId: options.sourceProfileId ?? null,
    payloads: [payload],
  });
}

export async function parseEpigraphMangaPayload(
  bytes: Uint8Array | ArrayBuffer,
): Promise<ParsedEpigraphMangaPayload> {
  const inspection = await inspectEpigraphBackupContainer(bytes);
  if (inspection.hasErrors) {
    throw new Error("Epigraph backup container failed inspection.");
  }

  const payloadManifest = inspection.payloadManifests.manga;
  if (!payloadManifest) {
    throw new Error("The selected Epigraph backup does not contain a manga payload.");
  }

  const registry = EPIGRAPH_BACKUP_PAYLOAD_REGISTRY.manga;
  const archivePath = `${registry.rootPath}/${EPIGRAPH_MANGA_PAYLOAD_FILE_PATH}`;
  const zip = await JSZip.loadAsync(toUint8Array(bytes));
  const file = zip.file(archivePath);
  if (!file) {
    throw new Error(`Manga payload is missing ${EPIGRAPH_MANGA_PAYLOAD_FILE_PATH}.`);
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

export async function extractEpigraphMangaPayloadFile(
  bytes: Uint8Array | ArrayBuffer,
): Promise<File> {
  const parsed = await parseEpigraphMangaPayload(bytes);
  const payloadBuffer = new Uint8Array(parsed.payloadBytes.byteLength);
  payloadBuffer.set(parsed.payloadBytes);
  return new File([payloadBuffer.buffer], parsed.payloadFilename, {
    type: "application/octet-stream",
  });
}
