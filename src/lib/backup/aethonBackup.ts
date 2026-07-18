import JSZip from "jszip";

export const AETHON_BACKUP_EXTENSION = ".aethonbk";
export const AETHON_BACKUP_FORMAT = "aethon-backup";
export const AETHON_BACKUP_CONTAINER_VERSION = 1 as const;
export const AETHON_BACKUP_MANIFEST_PATH = "manifest.json";
export const AETHON_BACKUP_CHECKSUMS_PATH = "checksums/sha256.json";
export const AETHON_BACKUP_MIME = "application/vnd.aethon.backup+zip";

export type AethonBackupKnownPayloadKind = "manga" | "novels" | "books" | "app";
export type AethonBackupSurface = "desktop" | "mobile" | "unknown";
export type AethonBackupIssueLevel = "warning" | "error";
export type AethonBackupRestoreMode = string;

export interface AethonBackupPayloadCompatibility {
  restoreModesSupported: AethonBackupRestoreMode[];
  requiresRuntime: string | null;
  requiresRepositories: string[];
  portableByDefault: boolean;
}

export interface AethonBackupPayloadRegistryEntry {
  kind: AethonBackupKnownPayloadKind;
  label: string;
  currentVersion: number;
  manifestPath: string;
  rootPath: string;
  compatibility: AethonBackupPayloadCompatibility;
}

export const AETHON_BACKUP_PAYLOAD_REGISTRY: Record<AethonBackupKnownPayloadKind, AethonBackupPayloadRegistryEntry> = {
  manga: {
    kind: "manga",
    label: "Manga",
    currentVersion: 1,
    manifestPath: "payloads/manga/manifest.json",
    rootPath: "payloads/manga",
    compatibility: {
      restoreModesSupported: ["pipeline"],
      requiresRuntime: "suwayomi",
      requiresRepositories: [],
      portableByDefault: true,
    },
  },
  novels: {
    kind: "novels",
    label: "Novels",
    currentVersion: 1,
    manifestPath: "payloads/novels/manifest.json",
    rootPath: "payloads/novels",
    compatibility: {
      restoreModesSupported: ["repository-aware", "metadata-only"],
      requiresRuntime: "novels",
      requiresRepositories: ["novel-sources"],
      portableByDefault: true,
    },
  },
  books: {
    kind: "books",
    label: "Books",
    currentVersion: 1,
    manifestPath: "payloads/books/manifest.json",
    rootPath: "payloads/books",
    compatibility: {
      restoreModesSupported: ["full", "metadata-only"],
      requiresRuntime: "books",
      requiresRepositories: [],
      portableByDefault: true,
    },
  },
  app: {
    kind: "app",
    label: "App",
    currentVersion: 1,
    manifestPath: "payloads/app/manifest.json",
    rootPath: "payloads/app",
    compatibility: {
      restoreModesSupported: ["metadata-only"],
      requiresRuntime: "aethon",
      requiresRepositories: [],
      portableByDefault: false,
    },
  },
};

export interface AethonBackupPayloadFileBuildInput {
  path: string;
  bytes: Uint8Array | ArrayBuffer | string;
  contentType?: string | null;
  role?: string | null;
}

export interface AethonBackupPayloadBuildInput {
  kind: AethonBackupKnownPayloadKind;
  payloadVersion?: number;
  exportMode?: string | null;
  metadata?: Record<string, unknown>;
  files?: AethonBackupPayloadFileBuildInput[];
  restoreModesSupported?: AethonBackupRestoreMode[];
  requiresRuntime?: string | null;
  requiresRepositories?: string[];
  portableByDefault?: boolean;
}

export interface AethonBackupBuildInput {
  createdAt?: string;
  appVersion?: string | null;
  platform?: string | null;
  sourceSurface?: AethonBackupSurface;
  sourceProfileId?: string | null;
  payloads: AethonBackupPayloadBuildInput[];
}

export interface AethonBackupPayloadFileEntry {
  path: string;
  sizeBytes: number;
  checksumSha256: string;
  contentType: string | null;
  role: string | null;
}

export interface AethonBackupPayloadManifest {
  kind: string;
  payloadVersion: number;
  createdAt: string;
  exportMode: string | null;
  restoreModesSupported: AethonBackupRestoreMode[];
  requiresRuntime: string | null;
  requiresRepositories: string[];
  portableByDefault: boolean;
  metadata: Record<string, unknown>;
  files: AethonBackupPayloadFileEntry[];
}

export interface AethonBackupManifestPayloadEntry {
  kind: string;
  payloadVersion: number;
  payloadRoot: string;
  manifestPath: string;
  checksumPath: string;
  exportMode: string | null;
  fileCount: number;
  restoreModesSupported: AethonBackupRestoreMode[];
  requiresRuntime: string | null;
  requiresRepositories: string[];
  portableByDefault: boolean;
}

export interface AethonBackupManifest {
  format: typeof AETHON_BACKUP_FORMAT;
  formatVersion: typeof AETHON_BACKUP_CONTAINER_VERSION;
  createdAt: string;
  packaging: "zip";
  checksumsPath: typeof AETHON_BACKUP_CHECKSUMS_PATH;
  createdBy: {
    app: "Aethon";
    version: string | null;
    platform: string | null;
  };
  source: {
    surface: AethonBackupSurface;
    profileId: string | null;
  };
  payloads: AethonBackupManifestPayloadEntry[];
}

export interface AethonBackupChecksumsFile {
  algorithm: "sha256";
  entries: Record<string, string>;
}

export interface BuiltAethonBackupContainer {
  bytes: Uint8Array;
  filename: string;
  mimeType: typeof AETHON_BACKUP_MIME;
  manifest: AethonBackupManifest;
  checksums: AethonBackupChecksumsFile;
  payloadManifests: Record<string, AethonBackupPayloadManifest>;
}

export interface AethonBackupIssue {
  level: AethonBackupIssueLevel;
  code:
    | "missing-manifest"
    | "invalid-manifest"
    | "missing-checksums"
    | "invalid-checksums"
    | "unsupported-container-version"
    | "unknown-payload-kind"
    | "unsupported-payload-version"
    | "missing-payload-manifest"
    | "invalid-payload-manifest"
    | "missing-payload-file"
    | "checksum-missing"
    | "checksum-mismatch";
  message: string;
  path?: string;
  payloadKind?: string;
}

export interface InspectedAethonBackupContainer {
  manifest: AethonBackupManifest | null;
  checksums: AethonBackupChecksumsFile | null;
  payloadManifests: Record<string, AethonBackupPayloadManifest>;
  issues: AethonBackupIssue[];
  hasErrors: boolean;
}

const PAYLOAD_KIND_ORDER: AethonBackupKnownPayloadKind[] = ["manga", "novels", "books", "app"];

function toUint8Array(bytes: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new TextEncoder().encode(bytes);
}

function toJsonBytes(input: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(input, null, 2)}\n`);
}

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", copyBytesToArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeRelativeArchivePath(raw: string): string {
  const normalized = raw.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!normalized) {
    throw new Error("Backup payload file path cannot be empty.");
  }

  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Backup payload file path is unsafe: ${raw}`);
  }

  return parts.join("/");
}

function payloadRegistryEntry(kind: AethonBackupKnownPayloadKind): AethonBackupPayloadRegistryEntry {
  return AETHON_BACKUP_PAYLOAD_REGISTRY[kind];
}

function resolvePayloadCompatibility(
  payload: AethonBackupPayloadBuildInput,
  registry: AethonBackupPayloadRegistryEntry,
): AethonBackupPayloadCompatibility {
  return {
    restoreModesSupported: payload.restoreModesSupported?.length
      ? [...new Set(payload.restoreModesSupported)]
      : registry.compatibility.restoreModesSupported,
    requiresRuntime: payload.requiresRuntime ?? registry.compatibility.requiresRuntime,
    requiresRepositories: payload.requiresRepositories?.length
      ? [...new Set(payload.requiresRepositories)]
      : registry.compatibility.requiresRepositories,
    portableByDefault: payload.portableByDefault ?? registry.compatibility.portableByDefault,
  };
}

function sortPayloads(payloads: AethonBackupPayloadBuildInput[]): AethonBackupPayloadBuildInput[] {
  return [...payloads].sort(
    (left, right) => PAYLOAD_KIND_ORDER.indexOf(left.kind) - PAYLOAD_KIND_ORDER.indexOf(right.kind),
  );
}

export function buildAethonBackupFilename(date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10);
  return `aethon-backup-${stamp}${AETHON_BACKUP_EXTENSION}`;
}

export async function buildAethonBackupContainer(input: AethonBackupBuildInput): Promise<BuiltAethonBackupContainer> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const zip = new JSZip();
  const checksums: Record<string, string> = {};
  const payloadDescriptors: AethonBackupManifestPayloadEntry[] = [];
  const payloadManifests: Record<string, AethonBackupPayloadManifest> = {};

  for (const payload of sortPayloads(input.payloads)) {
    const registry = payloadRegistryEntry(payload.kind);
    const payloadVersion = payload.payloadVersion ?? registry.currentVersion;
    const compatibility = resolvePayloadCompatibility(payload, registry);
    const files = payload.files ?? [];
    const fileEntries: AethonBackupPayloadFileEntry[] = [];

    for (const file of files) {
      const relativePath = normalizeRelativeArchivePath(file.path);
      const archivePath = `${registry.rootPath}/${relativePath}`;
      const fileBytes = toUint8Array(file.bytes);
      const checksumSha256 = await sha256Hex(fileBytes);
      zip.file(archivePath, fileBytes);
      checksums[archivePath] = checksumSha256;
      fileEntries.push({
        path: relativePath,
        sizeBytes: fileBytes.byteLength,
        checksumSha256,
        contentType: file.contentType ?? null,
        role: file.role ?? null,
      });
    }

    const payloadManifest: AethonBackupPayloadManifest = {
      kind: payload.kind,
      payloadVersion,
      createdAt,
      exportMode: payload.exportMode ?? null,
      restoreModesSupported: compatibility.restoreModesSupported,
      requiresRuntime: compatibility.requiresRuntime,
      requiresRepositories: compatibility.requiresRepositories,
      portableByDefault: compatibility.portableByDefault,
      metadata: { ...(payload.metadata ?? {}) },
      files: fileEntries,
    };

    const payloadManifestBytes = toJsonBytes(payloadManifest);
    zip.file(registry.manifestPath, payloadManifestBytes);
    checksums[registry.manifestPath] = await sha256Hex(payloadManifestBytes);
    payloadManifests[payload.kind] = payloadManifest;

    payloadDescriptors.push({
      kind: payload.kind,
      payloadVersion,
      payloadRoot: registry.rootPath,
      manifestPath: registry.manifestPath,
      checksumPath: registry.manifestPath,
      exportMode: payloadManifest.exportMode,
      fileCount: fileEntries.length,
      restoreModesSupported: compatibility.restoreModesSupported,
      requiresRuntime: compatibility.requiresRuntime,
      requiresRepositories: compatibility.requiresRepositories,
      portableByDefault: compatibility.portableByDefault,
    });
  }

  const manifest: AethonBackupManifest = {
    format: AETHON_BACKUP_FORMAT,
    formatVersion: AETHON_BACKUP_CONTAINER_VERSION,
    createdAt,
    packaging: "zip",
    checksumsPath: AETHON_BACKUP_CHECKSUMS_PATH,
    createdBy: {
      app: "Aethon",
      version: input.appVersion ?? null,
      platform: input.platform ?? null,
    },
    source: {
      surface: input.sourceSurface ?? "desktop",
      profileId: input.sourceProfileId ?? null,
    },
    payloads: payloadDescriptors,
  };

  const manifestBytes = toJsonBytes(manifest);
  zip.file(AETHON_BACKUP_MANIFEST_PATH, manifestBytes);
  checksums[AETHON_BACKUP_MANIFEST_PATH] = await sha256Hex(manifestBytes);

  const checksumsFile: AethonBackupChecksumsFile = {
    algorithm: "sha256",
    entries: Object.fromEntries(
      Object.entries(checksums).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
  zip.file(AETHON_BACKUP_CHECKSUMS_PATH, toJsonBytes(checksumsFile));

  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return {
    bytes,
    filename: buildAethonBackupFilename(new Date(createdAt)),
    mimeType: AETHON_BACKUP_MIME,
    manifest,
    checksums: checksumsFile,
    payloadManifests,
  };
}

function pushIssue(
  issues: AethonBackupIssue[],
  issue: AethonBackupIssue,
) {
  issues.push(issue);
}

async function readJsonFile<T>(zip: JSZip, path: string): Promise<T | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  const text = await entry.async("text");
  return JSON.parse(text) as T;
}

export async function inspectAethonBackupContainer(
  bytes: Uint8Array | ArrayBuffer,
): Promise<InspectedAethonBackupContainer> {
  const zip = await JSZip.loadAsync(toUint8Array(bytes));
  const issues: AethonBackupIssue[] = [];
  const payloadManifests: Record<string, AethonBackupPayloadManifest> = {};

  const manifestEntry = zip.file(AETHON_BACKUP_MANIFEST_PATH);
  if (!manifestEntry) {
    return {
      manifest: null,
      checksums: null,
      payloadManifests,
      issues: [{
        level: "error",
        code: "missing-manifest",
        message: "The Aethon backup container is missing manifest.json.",
        path: AETHON_BACKUP_MANIFEST_PATH,
      }],
      hasErrors: true,
    };
  }

  let manifest: AethonBackupManifest | null = null;
  let checksums: AethonBackupChecksumsFile | null = null;

  try {
    manifest = await readJsonFile<AethonBackupManifest>(zip, AETHON_BACKUP_MANIFEST_PATH);
  } catch (error) {
    pushIssue(issues, {
      level: "error",
      code: "invalid-manifest",
      message: error instanceof Error ? error.message : "manifest.json is not valid JSON.",
      path: AETHON_BACKUP_MANIFEST_PATH,
    });
  }

  try {
    checksums = await readJsonFile<AethonBackupChecksumsFile>(zip, AETHON_BACKUP_CHECKSUMS_PATH);
    if (!checksums) {
      pushIssue(issues, {
        level: "error",
        code: "missing-checksums",
        message: "The Aethon backup container is missing checksums/sha256.json.",
        path: AETHON_BACKUP_CHECKSUMS_PATH,
      });
    }
  } catch (error) {
    pushIssue(issues, {
      level: "error",
      code: "invalid-checksums",
      message: error instanceof Error ? error.message : "checksums/sha256.json is not valid JSON.",
      path: AETHON_BACKUP_CHECKSUMS_PATH,
    });
  }

  if (manifest && manifest.formatVersion !== AETHON_BACKUP_CONTAINER_VERSION) {
    pushIssue(issues, {
      level: "error",
      code: "unsupported-container-version",
      message: `Unsupported Aethon backup container version: ${manifest.formatVersion}.`,
      path: AETHON_BACKUP_MANIFEST_PATH,
    });
  }

  if (manifest) {
    for (const payload of manifest.payloads) {
      const registry = (AETHON_BACKUP_PAYLOAD_REGISTRY as Record<string, AethonBackupPayloadRegistryEntry | undefined>)[payload.kind];
      if (!registry) {
        pushIssue(issues, {
          level: "warning",
          code: "unknown-payload-kind",
          message: `Unknown payload kind "${payload.kind}" is present in the backup container.`,
          payloadKind: payload.kind,
          path: payload.manifestPath,
        });
        continue;
      }

      if (payload.payloadVersion > registry.currentVersion) {
        pushIssue(issues, {
          level: "warning",
          code: "unsupported-payload-version",
          message: `Payload "${payload.kind}" uses unsupported version ${payload.payloadVersion}.`,
          payloadKind: payload.kind,
          path: payload.manifestPath,
        });
      }

      const payloadManifestEntry = zip.file(payload.manifestPath);
      if (!payloadManifestEntry) {
        pushIssue(issues, {
          level: "error",
          code: "missing-payload-manifest",
          message: `Payload manifest is missing for "${payload.kind}".`,
          payloadKind: payload.kind,
          path: payload.manifestPath,
        });
        continue;
      }

      try {
        const payloadManifest = await readJsonFile<AethonBackupPayloadManifest>(zip, payload.manifestPath);
        if (!payloadManifest) {
          pushIssue(issues, {
            level: "error",
            code: "missing-payload-manifest",
            message: `Payload manifest is missing for "${payload.kind}".`,
            payloadKind: payload.kind,
            path: payload.manifestPath,
          });
          continue;
        }

        payloadManifests[payload.kind] = payloadManifest;

        for (const file of payloadManifest.files) {
          const archivePath = `${payload.payloadRoot}/${normalizeRelativeArchivePath(file.path)}`;
          if (!zip.file(archivePath)) {
            pushIssue(issues, {
              level: "error",
              code: "missing-payload-file",
              message: `Payload file "${archivePath}" is missing from the container.`,
              payloadKind: payload.kind,
              path: archivePath,
            });
          }
        }
      } catch (error) {
        pushIssue(issues, {
          level: "error",
          code: "invalid-payload-manifest",
          message: error instanceof Error ? error.message : `Payload manifest is invalid for "${payload.kind}".`,
          payloadKind: payload.kind,
          path: payload.manifestPath,
        });
      }
    }
  }

  if (checksums?.entries) {
    for (const [path, expectedSha] of Object.entries(checksums.entries)) {
      const entry = zip.file(path);
      if (!entry) {
        pushIssue(issues, {
          level: "error",
          code: "checksum-missing",
          message: `Checksum entry points to a missing file: ${path}.`,
          path,
        });
        continue;
      }

      const actualSha = await sha256Hex(await entry.async("uint8array"));
      if (actualSha !== expectedSha) {
        pushIssue(issues, {
          level: "error",
          code: "checksum-mismatch",
          message: `Checksum mismatch for ${path}.`,
          path,
        });
      }
    }
  }

  return {
    manifest,
    checksums,
    payloadManifests,
    issues,
    hasErrors: issues.some((issue) => issue.level === "error"),
  };
}
