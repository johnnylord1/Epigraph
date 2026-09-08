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

export const EPIGRAPH_NOVELS_PAYLOAD_FILE_PATH = "novels.json";

export type EpigraphNovelsExportMode = "repository-aware" | "metadata-only";
export type EpigraphNovelsRestoreOutcome =
  | "restored-usable"
  | "restored-needs-repository"
  | "restored-needs-plugin"
  | "restored-metadata-only";

export interface EpigraphNovelRepositoryReference {
  url: string;
  name?: string | null;
}

export interface EpigraphNovelPluginReference {
  id: string;
  name?: string | null;
  version?: string | null;
  repositoryUrl?: string | null;
}

export interface EpigraphNovelSourceIdentity {
  repositoryUrl: string | null;
  repositoryName?: string | null;
  pluginId: string | null;
  pluginName?: string | null;
  pluginVersion?: string | null;
  sourceId: string | null;
  sourceName?: string | null;
  lang?: string | null;
}

export interface EpigraphNovelEntry {
  id: string;
  title: string;
  path: string;
  author?: string | null;
  description?: string | null;
  coverUrl?: string | null;
  coverPath?: string | null;
  externalNovelId?: string | null;
  externalUrl?: string | null;
  status?: string | null;
  tags?: string[];
  source: EpigraphNovelSourceIdentity | null;
  addedAt: number;
  updatedAt: number;
}

export interface EpigraphNovelProgressEntry {
  novelId: string;
  chapterId?: string | null;
  chapterTitle?: string | null;
  progressPercent: number;
  locator?: string | null;
  updatedAt: number;
}

export interface EpigraphNovelBookmarkEntry {
  novelId: string;
  chapterId?: string | null;
  chapterTitle?: string | null;
  locator?: string | null;
  label?: string | null;
  savedAt: number;
}

export interface EpigraphNovelHistoryEntry {
  novelId: string;
  chapterId?: string | null;
  chapterTitle?: string | null;
  locator?: string | null;
  readAt: number;
}

export interface EpigraphNovelChapterEntry {
  id: string;
  novelId: string;
  path: string;
  title: string;
  order: number;
  releaseTime: number | null;
  unread: boolean;
  updatedAt?: number | null;
}

export interface EpigraphNovelsSnapshot {
  /** Parse diagnostics carried to presentation; never executed as restore state. */
  importIssues?: EpigraphNovelsRestoreIssue[];
  entries: EpigraphNovelEntry[];
  chapters: EpigraphNovelChapterEntry[];
  progress: EpigraphNovelProgressEntry[];
  bookmarks: EpigraphNovelBookmarkEntry[];
  history: EpigraphNovelHistoryEntry[];
  repositories?: EpigraphNovelRepositoryReference[];
  plugins?: EpigraphNovelPluginReference[];
}

interface NovelsPayloadFile {
  version: 1;
  exportMode: EpigraphNovelsExportMode;
  entries: EpigraphNovelEntry[];
  chapters: EpigraphNovelChapterEntry[];
  progress: EpigraphNovelProgressEntry[];
  bookmarks: EpigraphNovelBookmarkEntry[];
  history: EpigraphNovelHistoryEntry[];
  repositories: EpigraphNovelRepositoryReference[];
  plugins: EpigraphNovelPluginReference[];
}

export interface ParsedEpigraphNovelsPayload {
  inspection: InspectedEpigraphBackupContainer;
  payloadManifest: EpigraphBackupPayloadManifest;
  exportMode: EpigraphNovelsExportMode;
  snapshot: EpigraphNovelsSnapshot;
}

export interface EpigraphNovelRuntimeState {
  repositoryUrls: string[];
  installedPluginIds: string[];
  availableSourceIds: string[];
}

export interface EpigraphNovelRestoreClassification {
  novelId: string;
  title: string;
  outcome: EpigraphNovelsRestoreOutcome;
  requiredRepositoryUrl: string | null;
  requiredPluginId: string | null;
  requiredSourceId: string | null;
}

export type EpigraphNovelsRestoreIssueCode =
  | "missing-novels-payload"
  | "invalid-novels-payload"
  | "invalid-novel-identity"
  | "invalid-chapter-identity"
  | "missing-required-repository"
  | "missing-required-plugin"
  | "missing-required-source"
  | "metadata-only-novel";

export interface EpigraphNovelsRestoreIssue {
  code: EpigraphNovelsRestoreIssueCode;
  message: string;
  novelId?: string;
}

export interface RestoredEpigraphNovelsSnapshot extends EpigraphNovelsSnapshot {
  exportMode: EpigraphNovelsExportMode;
  classifications: EpigraphNovelRestoreClassification[];
  issues: EpigraphNovelsRestoreIssue[];
  summary: {
    totalEntries: number;
    restoredUsableCount: number;
    restoredNeedsRepositoryCount: number;
    restoredNeedsPluginCount: number;
    restoredMetadataOnlyCount: number;
  };
}

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function jsonBytes(input: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(input, null, 2)}\n`);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeUrl(value: unknown): string | null {
  const trimmed = normalizeText(value);
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => normalizeText(value)).filter((value): value is string => Boolean(value)))];
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return uniqueStrings(tags as Array<string | null | undefined>);
}

function normalizeRepository(record: EpigraphNovelRepositoryReference): EpigraphNovelRepositoryReference {
  const url = normalizeUrl(record?.url);
  if (!url) {
    throw new Error("Novel repository references must include a URL.");
  }

  return {
    url,
    name: normalizeText(record?.name),
  };
}

function normalizePlugin(record: EpigraphNovelPluginReference): EpigraphNovelPluginReference {
  const id = normalizeText(record?.id);
  if (!id) {
    throw new Error("Novel plugin references must include an id.");
  }

  return {
    id,
    name: normalizeText(record?.name),
    version: normalizeText(record?.version),
    repositoryUrl: normalizeUrl(record?.repositoryUrl),
  };
}

function normalizeSourceIdentity(source: EpigraphNovelSourceIdentity | null | undefined): EpigraphNovelSourceIdentity | null {
  if (!source) return null;

  const repositoryUrl = normalizeUrl(source.repositoryUrl);
  const pluginId = normalizeText(source.pluginId);
  const sourceId = normalizeText(source.sourceId);

  if (!repositoryUrl && !pluginId && !sourceId) {
    return null;
  }

  return {
    repositoryUrl,
    repositoryName: normalizeText(source.repositoryName),
    pluginId,
    pluginName: normalizeText(source.pluginName),
    pluginVersion: normalizeText(source.pluginVersion),
    sourceId,
    sourceName: normalizeText(source.sourceName),
    lang: normalizeText(source.lang),
  };
}

function normalizeEntry(entry: EpigraphNovelEntry, index: number): EpigraphNovelEntry {
  const id = normalizeText(entry?.id) ?? `novel-${index + 1}`;
  const title = normalizeText(entry?.title) ?? `Novel ${index + 1}`;
  const path = normalizeText(entry?.path) ?? "";

  return {
    id,
    title,
    path,
    author: normalizeText(entry?.author),
    description: normalizeText(entry?.description),
    coverUrl: normalizeText(entry?.coverUrl),
    coverPath: normalizeText(entry?.coverPath),
    externalNovelId: normalizeText(entry?.externalNovelId),
    externalUrl: normalizeText(entry?.externalUrl),
    status: normalizeText(entry?.status),
    tags: normalizeTags(entry?.tags),
    source: normalizeSourceIdentity(entry?.source),
    addedAt: Number.isSafeInteger(entry?.addedAt) && entry.addedAt > 0 ? entry.addedAt : 0,
    updatedAt: Number.isSafeInteger(entry?.updatedAt) && entry.updatedAt > 0 ? entry.updatedAt : 0,
  };
}

function normalizeProgress(entry: EpigraphNovelProgressEntry): EpigraphNovelProgressEntry {
  return {
    novelId: normalizeText(entry?.novelId) ?? "",
    chapterId: normalizeText(entry?.chapterId),
    chapterTitle: normalizeText(entry?.chapterTitle),
    progressPercent: typeof entry?.progressPercent === "number"
      ? Math.max(0, Math.min(1, entry.progressPercent))
      : 0,
    locator: normalizeText(entry?.locator),
    updatedAt: Number.isSafeInteger(entry?.updatedAt) && entry.updatedAt > 0 ? entry.updatedAt : 0,
  };
}

function normalizeBookmark(entry: EpigraphNovelBookmarkEntry): EpigraphNovelBookmarkEntry {
  return {
    novelId: normalizeText(entry?.novelId) ?? "",
    chapterId: normalizeText(entry?.chapterId),
    chapterTitle: normalizeText(entry?.chapterTitle),
    locator: normalizeText(entry?.locator),
    label: normalizeText(entry?.label),
    savedAt: Number.isSafeInteger(entry?.savedAt) && entry.savedAt > 0 ? entry.savedAt : 0,
  };
}

function normalizeHistoryEntry(entry: EpigraphNovelHistoryEntry): EpigraphNovelHistoryEntry {
  return {
    novelId: normalizeText(entry?.novelId) ?? "",
    chapterId: normalizeText(entry?.chapterId),
    chapterTitle: normalizeText(entry?.chapterTitle),
    locator: normalizeText(entry?.locator),
    readAt: Number.isSafeInteger(entry?.readAt) && entry.readAt > 0 ? entry.readAt : 0,
  };
}

function normalizeChapterEntry(entry: EpigraphNovelChapterEntry): EpigraphNovelChapterEntry {
  return {
    id: normalizeText(entry?.id) ?? "",
    novelId: normalizeText(entry?.novelId) ?? "",
    path: normalizeText(entry?.path) ?? "",
    title: normalizeText(entry?.title) ?? "",
    order: typeof entry?.order === "number" ? entry.order : 0,
    releaseTime: typeof entry?.releaseTime === "number" ? entry.releaseTime : null,
    unread: entry?.unread !== false,
    updatedAt: typeof entry?.updatedAt === "number" ? entry.updatedAt : null,
  };
}

export function normalizeEpigraphNovelsSnapshot(snapshot: EpigraphNovelsSnapshot): EpigraphNovelsSnapshot {
  return {
    ...(snapshot.importIssues?.length ? { importIssues: snapshot.importIssues.map(issue => ({ ...issue })) } : {}),
    entries: Array.isArray(snapshot.entries) ? snapshot.entries.map((entry, index) => normalizeEntry(entry, index)) : [],
    chapters: Array.isArray(snapshot.chapters)
      ? snapshot.chapters
        .map((entry) => normalizeChapterEntry(entry))
        .filter((entry) => entry.id && entry.novelId && entry.path && entry.title)
      : [],
    progress: Array.isArray(snapshot.progress)
      ? snapshot.progress.map((entry) => normalizeProgress(entry)).filter((entry) => entry.novelId)
      : [],
    bookmarks: Array.isArray(snapshot.bookmarks)
      ? snapshot.bookmarks.map((entry) => normalizeBookmark(entry)).filter((entry) => entry.novelId)
      : [],
    history: Array.isArray(snapshot.history)
      ? snapshot.history.map((entry) => normalizeHistoryEntry(entry)).filter((entry) => entry.novelId)
      : [],
    repositories: Array.isArray(snapshot.repositories)
      ? snapshot.repositories.map((entry) => normalizeRepository(entry))
      : [],
    plugins: Array.isArray(snapshot.plugins)
      ? snapshot.plugins.map((entry) => normalizePlugin(entry))
      : [],
  };
}

function collectRequiredRepositories(snapshot: EpigraphNovelsSnapshot): string[] {
  return uniqueStrings([
    ...snapshot.repositories?.map((repository) => repository.url) ?? [],
    ...snapshot.plugins?.map((plugin) => plugin.repositoryUrl ?? null) ?? [],
    ...snapshot.entries.map((entry) => entry.source?.repositoryUrl ?? null),
  ].map((value) => normalizeUrl(value)));
}

function toPayloadFile(snapshot: EpigraphNovelsSnapshot, exportMode: EpigraphNovelsExportMode): NovelsPayloadFile {
  return {
    version: 1,
    exportMode,
    entries: snapshot.entries,
    chapters: snapshot.chapters,
    progress: snapshot.progress,
    bookmarks: snapshot.bookmarks,
    history: snapshot.history,
    repositories: snapshot.repositories ?? [],
    plugins: snapshot.plugins ?? [],
  };
}

export async function buildEpigraphNovelsPayload(
  snapshot: EpigraphNovelsSnapshot,
  options: {
    exportMode?: EpigraphNovelsExportMode;
  } = {},
): Promise<EpigraphBackupPayloadBuildInput> {
  const exportMode = options.exportMode ?? "repository-aware";
  const normalizedSnapshot = normalizeEpigraphNovelsSnapshot(snapshot);
  const requiredRepositories = collectRequiredRepositories(normalizedSnapshot);

  return {
    kind: "novels",
    exportMode,
    restoreModesSupported: ["repository-aware", "metadata-only"],
    requiresRuntime: "novels",
    requiresRepositories: requiredRepositories,
    portableByDefault: true,
      metadata: {
      schemaVersion: 1,
      entryCount: normalizedSnapshot.entries.length,
      chapterCount: normalizedSnapshot.chapters.length,
      progressCount: normalizedSnapshot.progress.length,
      bookmarkCount: normalizedSnapshot.bookmarks.length,
      historyCount: normalizedSnapshot.history.length,
      repositoryCount: normalizedSnapshot.repositories?.length ?? 0,
      pluginCount: normalizedSnapshot.plugins?.length ?? 0,
      includesPluginBinaries: false,
    },
    files: [
      {
        path: EPIGRAPH_NOVELS_PAYLOAD_FILE_PATH,
        bytes: jsonBytes(toPayloadFile(normalizedSnapshot, exportMode)),
        contentType: "application/json",
        role: "library",
      },
    ],
  };
}

export async function buildEpigraphNovelsBackupContainer(
  snapshot: EpigraphNovelsSnapshot,
  options: {
    exportMode?: EpigraphNovelsExportMode;
    appVersion?: string | null;
    platform?: string | null;
    sourceProfileId?: string | null;
  } = {},
): Promise<BuiltEpigraphBackupContainer> {
  const payload = await buildEpigraphNovelsPayload(snapshot, {
    exportMode: options.exportMode,
  });

  return buildEpigraphBackupContainer({
    appVersion: options.appVersion ?? null,
    platform: options.platform ?? null,
    sourceSurface: "desktop",
    sourceProfileId: options.sourceProfileId ?? null,
    payloads: [payload],
  });
}

export async function parseEpigraphNovelsPayload(
  bytes: Uint8Array | ArrayBuffer,
): Promise<ParsedEpigraphNovelsPayload> {
  const inspection = await inspectEpigraphBackupContainer(bytes);
  if (inspection.hasErrors) {
    throw new Error("Epigraph backup container failed inspection.");
  }

  const payloadManifest = inspection.payloadManifests.novels;
  if (!payloadManifest) {
    throw new Error("The selected Epigraph backup does not contain a novels payload.");
  }

  const registry = EPIGRAPH_BACKUP_PAYLOAD_REGISTRY.novels;
  const archivePath = `${registry.rootPath}/${EPIGRAPH_NOVELS_PAYLOAD_FILE_PATH}`;
  const zip = await JSZip.loadAsync(toUint8Array(bytes));
  const file = zip.file(archivePath);
  if (!file) {
    throw new Error(`Novels payload is missing ${EPIGRAPH_NOVELS_PAYLOAD_FILE_PATH}.`);
  }

  let parsed: NovelsPayloadFile;
  try {
    parsed = JSON.parse(await file.async("text")) as NovelsPayloadFile;
  } catch {
    throw new Error("Novels payload is not valid JSON.");
  }

  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error("Novels payload uses an unsupported schema version.");
  }

  return {
    inspection,
    payloadManifest,
    exportMode: parsed.exportMode === "metadata-only" ? "metadata-only" : "repository-aware",
    snapshot: normalizeEpigraphNovelsSnapshot({
      entries: parsed.entries,
      chapters: Array.isArray(parsed.chapters) ? parsed.chapters : [],
      progress: Array.isArray(parsed.progress) ? parsed.progress : [],
      bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      repositories: Array.isArray(parsed.repositories) ? parsed.repositories : [],
      plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [],
    }),
  };
}

function classifyNovelEntry(
  entry: EpigraphNovelEntry,
  runtime: EpigraphNovelRuntimeState,
): EpigraphNovelRestoreClassification {
  const repositorySet = new Set(runtime.repositoryUrls.map((value) => normalizeUrl(value)).filter((value): value is string => Boolean(value)));
  const pluginSet = new Set(runtime.installedPluginIds.map((value) => normalizeText(value)).filter((value): value is string => Boolean(value)));
  const sourceSet = new Set(runtime.availableSourceIds.map((value) => normalizeText(value)).filter((value): value is string => Boolean(value)));

  const requiredRepositoryUrl = normalizeUrl(entry.source?.repositoryUrl);
  const requiredPluginId = normalizeText(entry.source?.pluginId);
  const requiredSourceId = normalizeText(entry.source?.sourceId);

  let outcome: EpigraphNovelsRestoreOutcome = "restored-usable";

  if (!requiredRepositoryUrl && !requiredPluginId && !requiredSourceId) {
    outcome = "restored-metadata-only";
  } else if (requiredRepositoryUrl && !repositorySet.has(requiredRepositoryUrl)) {
    outcome = "restored-needs-repository";
  } else if (
    (requiredPluginId && !pluginSet.has(requiredPluginId))
    || (requiredSourceId && !sourceSet.has(requiredSourceId))
  ) {
    outcome = "restored-needs-plugin";
  }

  return {
    novelId: entry.id,
    title: entry.title,
    outcome,
    requiredRepositoryUrl,
    requiredPluginId,
    requiredSourceId,
  };
}

export function classifyEpigraphNovelsSnapshot(
  snapshot: EpigraphNovelsSnapshot,
  exportMode: EpigraphNovelsExportMode,
  runtime: EpigraphNovelRuntimeState,
): RestoredEpigraphNovelsSnapshot {
  const normalizedSnapshot = normalizeEpigraphNovelsSnapshot(snapshot);
  const classifications = normalizedSnapshot.entries.map((entry) => classifyNovelEntry(entry, runtime));
  const issues: EpigraphNovelsRestoreIssue[] = [...(normalizedSnapshot.importIssues ?? [])];

  for (const item of classifications) {
    if (item.outcome === "restored-needs-repository") {
      issues.push({
        code: "missing-required-repository",
        novelId: item.novelId,
        message: `Novel "${item.title}" requires repository ${item.requiredRepositoryUrl}.`,
      });
    } else if (item.outcome === "restored-needs-plugin") {
      issues.push({
        code: item.requiredSourceId ? "missing-required-source" : "missing-required-plugin",
        novelId: item.novelId,
        message: item.requiredSourceId
          ? `Novel "${item.title}" requires source ${item.requiredSourceId}.`
          : `Novel "${item.title}" requires plugin ${item.requiredPluginId}.`,
      });
    } else if (item.outcome === "restored-metadata-only") {
      issues.push({
        code: "metadata-only-novel",
        novelId: item.novelId,
        message: `Novel "${item.title}" restored as metadata-only.`,
      });
    }
  }

  return {
    ...normalizedSnapshot,
    exportMode,
    classifications,
    issues,
    summary: {
      totalEntries: normalizedSnapshot.entries.length,
      restoredUsableCount: classifications.filter((item) => item.outcome === "restored-usable").length,
      restoredNeedsRepositoryCount: classifications.filter((item) => item.outcome === "restored-needs-repository").length,
      restoredNeedsPluginCount: classifications.filter((item) => item.outcome === "restored-needs-plugin").length,
      restoredMetadataOnlyCount: classifications.filter((item) => item.outcome === "restored-metadata-only").length,
    },
  };
}

export async function restoreEpigraphNovelsPayload(
  bytes: Uint8Array | ArrayBuffer,
  runtime: EpigraphNovelRuntimeState,
): Promise<RestoredEpigraphNovelsSnapshot> {
  const parsed = await parseEpigraphNovelsPayload(bytes);
  return classifyEpigraphNovelsSnapshot(parsed.snapshot, parsed.exportMode, runtime);
}
