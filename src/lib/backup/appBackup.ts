import JSZip from "jszip";
import {
  buildEpigraphBackupContainer,
  inspectEpigraphBackupContainer,
  type EpigraphBackupPayloadBuildInput,
  type EpigraphBackupPayloadManifest,
  type BuiltEpigraphBackupContainer,
  type InspectedEpigraphBackupContainer,
} from "./epigraphBackup";
import { normalizeLocalProfileId, type LocalProfileId } from "../localProfiles";

export const EPIGRAPH_APP_PAYLOAD_FILE_PATH = "profile.json";

export interface EpigraphAppHistoryEntry {
  mangaId: number;
  mangaTitle: string;
  thumbnailUrl: string;
  chapterId: number;
  chapterName: string;
  readAt: number;
}

export interface EpigraphAppReadLogEntry {
  mangaId: number;
  chapterId: number;
  readAt: number;
  minutes: number;
}

export interface EpigraphAppReadingStats {
  totalChaptersRead: number;
  totalMangaRead: number;
  totalMinutesRead: number;
  firstReadAt: number;
  lastReadAt: number;
  currentStreakDays: number;
  longestStreakDays: number;
  lastStreakDate: string;
}

export interface EpigraphAppProfilePayload {
  version: 1 | 2;
  defaultLocalProfileId: LocalProfileId;
  history?: EpigraphAppHistoryEntry[];
  readLog?: EpigraphAppReadLogEntry[];
  readingStats?: EpigraphAppReadingStats;
}

export interface ParsedEpigraphAppPayload {
  inspection: InspectedEpigraphBackupContainer;
  payloadManifest: EpigraphBackupPayloadManifest;
  profile: EpigraphAppProfilePayload;
}

function jsonBytes(input: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(input, null, 2)}\n`);
}

function normalizeHistoryEntry(entry: unknown): EpigraphAppHistoryEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const mangaId = Number(record.mangaId);
  const chapterId = Number(record.chapterId);
  const readAt = Number(record.readAt);
  if (!Number.isFinite(mangaId) || !Number.isFinite(chapterId) || !Number.isFinite(readAt)) return null;
  return {
    mangaId,
    mangaTitle: String(record.mangaTitle ?? ""),
    thumbnailUrl: String(record.thumbnailUrl ?? ""),
    chapterId,
    chapterName: String(record.chapterName ?? ""),
    readAt,
  };
}

function normalizeReadLogEntry(entry: unknown): EpigraphAppReadLogEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const mangaId = Number(record.mangaId);
  const chapterId = Number(record.chapterId);
  const readAt = Number(record.readAt);
  const minutes = Number(record.minutes);
  if (!Number.isFinite(mangaId) || !Number.isFinite(chapterId) || !Number.isFinite(readAt) || !Number.isFinite(minutes)) return null;
  return {
    mangaId,
    chapterId,
    readAt,
    minutes,
  };
}

function normalizeReadingStats(value: unknown): EpigraphAppReadingStats {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    totalChaptersRead: Number(record.totalChaptersRead ?? 0) || 0,
    totalMangaRead: Number(record.totalMangaRead ?? 0) || 0,
    totalMinutesRead: Number(record.totalMinutesRead ?? 0) || 0,
    firstReadAt: Number(record.firstReadAt ?? 0) || 0,
    lastReadAt: Number(record.lastReadAt ?? 0) || 0,
    currentStreakDays: Number(record.currentStreakDays ?? 0) || 0,
    longestStreakDays: Number(record.longestStreakDays ?? 0) || 0,
    lastStreakDate: typeof record.lastStreakDate === "string" ? record.lastStreakDate : "",
  };
}

export function buildEpigraphAppPayload(input: {
  defaultLocalProfileId: LocalProfileId;
  history?: EpigraphAppHistoryEntry[];
  readLog?: EpigraphAppReadLogEntry[];
  readingStats?: EpigraphAppReadingStats;
}): EpigraphBackupPayloadBuildInput {
  return {
    kind: "app",
    exportMode: "full",
    restoreModesSupported: ["full", "metadata-only"],
    requiresRuntime: "epigraph",
    requiresRepositories: [],
    portableByDefault: false,
    metadata: {
      schemaVersion: 2,
      portableMetadataOnly: false,
    },
    files: [
      {
        path: EPIGRAPH_APP_PAYLOAD_FILE_PATH,
        bytes: jsonBytes({
          version: 2,
          defaultLocalProfileId: input.defaultLocalProfileId,
          history: Array.isArray(input.history) ? input.history : [],
          readLog: Array.isArray(input.readLog) ? input.readLog : [],
          readingStats: normalizeReadingStats(input.readingStats),
        } satisfies EpigraphAppProfilePayload),
        contentType: "application/json",
        role: "profile",
      },
    ],
  };
}

export async function buildEpigraphAppBackupContainer(
  input: {
    defaultLocalProfileId: LocalProfileId;
    appVersion?: string | null;
    platform?: string | null;
    sourceProfileId?: string | null;
    history?: EpigraphAppHistoryEntry[];
    readLog?: EpigraphAppReadLogEntry[];
    readingStats?: EpigraphAppReadingStats;
  },
): Promise<BuiltEpigraphBackupContainer> {
  return buildEpigraphBackupContainer({
    appVersion: input.appVersion ?? null,
    platform: input.platform ?? null,
    sourceSurface: "desktop",
    sourceProfileId: input.sourceProfileId ?? null,
    payloads: [
      buildEpigraphAppPayload({
        defaultLocalProfileId: input.defaultLocalProfileId,
        history: input.history,
        readLog: input.readLog,
        readingStats: input.readingStats,
      }),
    ],
  });
}

export async function parseEpigraphAppPayload(
  bytes: Uint8Array | ArrayBuffer,
): Promise<ParsedEpigraphAppPayload> {
  const inspection = await inspectEpigraphBackupContainer(bytes);
  if (inspection.hasErrors) {
    throw new Error("Epigraph backup container failed inspection.");
  }

  const payloadManifest = inspection.payloadManifests.app;
  if (!payloadManifest) {
    throw new Error("The selected Epigraph backup does not contain an app payload.");
  }

  const fileRecord = payloadManifest.files.find((file) => file.path === EPIGRAPH_APP_PAYLOAD_FILE_PATH);
  if (!fileRecord) {
    throw new Error("App payload is missing profile.json.");
  }

  const zip = await JSZip.loadAsync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const file = zip.file(`payloads/app/${EPIGRAPH_APP_PAYLOAD_FILE_PATH}`);
  if (!file) {
    throw new Error("App payload is missing profile.json.");
  }

  let parsed: EpigraphAppProfilePayload;
  try {
    parsed = JSON.parse(await file.async("text")) as EpigraphAppProfilePayload;
  } catch {
    throw new Error("App payload is not valid JSON.");
  }

  if (parsed.version !== 1 && parsed.version !== 2) {
    throw new Error("App payload uses an unsupported schema version.");
  }

  const defaultLocalProfileId = normalizeLocalProfileId(parsed.defaultLocalProfileId);
  if (!defaultLocalProfileId) {
    throw new Error("App payload defaultLocalProfileId is invalid.");
  }

  return {
    inspection,
    payloadManifest,
    profile: {
      version: parsed.version,
      defaultLocalProfileId,
      history: parsed.version >= 2 && Array.isArray(parsed.history)
        ? parsed.history.map((entry) => normalizeHistoryEntry(entry)).filter((entry): entry is EpigraphAppHistoryEntry => Boolean(entry))
        : undefined,
      readLog: parsed.version >= 2 && Array.isArray(parsed.readLog)
        ? parsed.readLog.map((entry) => normalizeReadLogEntry(entry)).filter((entry): entry is EpigraphAppReadLogEntry => Boolean(entry))
        : undefined,
      readingStats: parsed.version >= 2 ? normalizeReadingStats(parsed.readingStats) : undefined,
    },
  };
}
