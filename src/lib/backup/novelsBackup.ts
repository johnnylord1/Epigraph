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

export const AETHON_NOVELS_PAYLOAD_FILE_PATH = "novels.json";

export type AethonNovelsExportMode = "repository-aware" | "metadata-only";
export type AethonNovelsRestoreOutcome =
  | "restored-usable"
  | "restored-needs-repository"
  | "restored-needs-plugin"
  | "restored-metadata-only";

export interface AethonNovelRepositoryReference {
  url: string;
  name?: string | null;
}

export interface AethonNovelPluginReference {
  id: string;
  name?: string | null;
  version?: string | null;
  repositoryUrl?: string | null;
}

export interface AethonNovelSourceIdentity {
  repositoryUrl: string | null;
  repositoryName?: string | null;
  pluginId: string | null;
  pluginName?: string | null;
  pluginVersion?: string | null;
  sourceId: string | null;
  sourceName?: string | null;
  lang?: string | null;
}

export interface AethonNovelEntry {
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
  source: AethonNovelSourceIdentity | null;
  addedAt: number;
  updatedAt: number;
}

export interface AethonNovelProgressEntry {
  novelId: string;
  chapterId?: string | null;
  chapterTitle?: string | null;
  progressPercent: number;
  locator?: string | null;
  updatedAt: number;
}

export interface AethonNovelBookmarkEntry {
  novelId: string;
  chapterId?: string | null;
  chapterTitle?: string | null;
  locator?: string | null;
  label?: string | null;
  savedAt: number;
}

export interface AethonNovelHistoryEntry {
  novelId: string;
  chapterId?: string | null;
  chapterTitle?: string | null;
  locator?: string | null;
  readAt: number;
}

export interface AethonNovelChapterEntry {
  id: string;
  novelId: string;
  path: string;
  title: string;
  order: number;
  releaseTime: number | null;
  unread: boolean;
}

export interface AethonNovelsSnapshot {
  entries: AethonNovelEntry[];
  chapters: AethonNovelChapterEntry[];
  progress: AethonNovelProgressEntry[];
  bookmarks: AethonNovelBookmarkEntry[];
  history: AethonNovelHistoryEntry[];
  repositories?: AethonNovelRepositoryReference[];
  plugins?: AethonNovelPluginReference[];
}

interface NovelsPayloadFile {
  version: 1;
  exportMode: AethonNovelsExportMode;
  entries: AethonNovelEntry[];
  chapters: AethonNovelChapterEntry[];
  progress: AethonNovelProgressEntry[];
  bookmarks: AethonNovelBookmarkEntry[];
  history: AethonNovelHistoryEntry[];
  repositories: AethonNovelRepositoryReference[];
  plugins: AethonNovelPluginReference[];
}

export interface ParsedAethonNovelsPayload {
  inspection: InspectedAethonBackupContainer;
  payloadManifest: AethonBackupPayloadManifest;
  exportMode: AethonNovelsExportMode;
  snapshot: AethonNovelsSnapshot;
}

export interface AethonNovelRuntimeState {
  repositoryUrls: string[];
  installedPluginIds: string[];
  availableSourceIds: string[];
}

export interface AethonNovelRestoreClassification {
  novelId: string;
  title: string;
  outcome: AethonNovelsRestoreOutcome;
  requiredRepositoryUrl: string | null;
  requiredPluginId: string | null;
  requiredSourceId: string | null;
}

export type AethonNovelsRestoreIssueCode =
  | "missing-novels-payload"
  | "invalid-novels-payload"
  | "missing-required-repository"
  | "missing-required-plugin"
  | "missing-required-source"
  | "metadata-only-novel";

export interface AethonNovelsRestoreIssue {
  code: AethonNovelsRestoreIssueCode;
  message: string;
  novelId?: string;
}

export interface RestoredAethonNovelsSnapshot extends AethonNovelsSnapshot {
  exportMode: AethonNovelsExportMode;
  classifications: AethonNovelRestoreClassification[];
  issues: AethonNovelsRestoreIssue[];
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

function normalizeRepository(record: AethonNovelRepositoryReference): AethonNovelRepositoryReference {
  const url = normalizeUrl(record?.url);
  if (!url) {
    throw new Error("Novel repository references must include a URL.");
  }

  return {
    url,
    name: normalizeText(record?.name),
  };
}

function normalizePlugin(record: AethonNovelPluginReference): AethonNovelPluginReference {
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

function normalizeSourceIdentity(source: AethonNovelSourceIdentity | null | undefined): AethonNovelSourceIdentity | null {
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

function normalizeEntry(entry: AethonNovelEntry, index: number): AethonNovelEntry {
  const id = normalizeText(entry?.id) ?? `novel-${index + 1}`;
  const title = normalizeText(entry?.title) ?? `Novel ${index + 1}`;
  const path = normalizeText(entry?.path) ?? normalizeText(entry?.externalUrl) ?? `/${id}`;

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
    addedAt: typeof entry?.addedAt === "number" ? entry.addedAt : Date.now(),
    updatedAt: typeof entry?.updatedAt === "number" ? entry.updatedAt : Date.now(),
  };
}

function normalizeProgress(entry: AethonNovelProgressEntry): AethonNovelProgressEntry {
  return {
    novelId: normalizeText(entry?.novelId) ?? "",
    chapterId: normalizeText(entry?.chapterId),
    chapterTitle: normalizeText(entry?.chapterTitle),
    progressPercent: typeof entry?.progressPercent === "number"
      ? Math.max(0, Math.min(1, entry.progressPercent))
      : 0,
    locator: normalizeText(entry?.locator),
    updatedAt: typeof entry?.updatedAt === "number" ? entry.updatedAt : Date.now(),
  };
}

function normalizeBookmark(entry: AethonNovelBookmarkEntry): AethonNovelBookmarkEntry {
  return {
    novelId: normalizeText(entry?.novelId) ?? "",
    chapterId: normalizeText(entry?.chapterId),
    chapterTitle: normalizeText(entry?.chapterTitle),
    locator: normalizeText(entry?.locator),
    label: normalizeText(entry?.label),
    savedAt: typeof entry?.savedAt === "number" ? entry.savedAt : Date.now(),
  };
}

function normalizeHistoryEntry(entry: AethonNovelHistoryEntry): AethonNovelHistoryEntry {
  return {
    novelId: normalizeText(entry?.novelId) ?? "",
    chapterId: normalizeText(entry?.chapterId),
    chapterTitle: normalizeText(entry?.chapterTitle),
    locator: normalizeText(entry?.locator),
    readAt: typeof entry?.readAt === "number" ? entry.readAt : Date.now(),
  };
}

function normalizeChapterEntry(entry: AethonNovelChapterEntry): AethonNovelChapterEntry {
  return {
    id: normalizeText(entry?.id) ?? "",
    novelId: normalizeText(entry?.novelId) ?? "",
    path: normalizeText(entry?.path) ?? "",
    title: normalizeText(entry?.title) ?? "",
    order: typeof entry?.order === "number" ? entry.order : 0,
    releaseTime: typeof entry?.releaseTime === "number" ? entry.releaseTime : null,
    unread: entry?.unread !== false,
  };
}

export function normalizeAethonNovelsSnapshot(snapshot: AethonNovelsSnapshot): AethonNovelsSnapshot {
  return {
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

function collectRequiredRepositories(snapshot: AethonNovelsSnapshot): string[] {
  return uniqueStrings([
    ...snapshot.repositories?.map((repository) => repository.url) ?? [],
    ...snapshot.plugins?.map((plugin) => plugin.repositoryUrl ?? null) ?? [],
    ...snapshot.entries.map((entry) => entry.source?.repositoryUrl ?? null),
  ].map((value) => normalizeUrl(value)));
}

function toPayloadFile(snapshot: AethonNovelsSnapshot, exportMode: AethonNovelsExportMode): NovelsPayloadFile {
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

export async function buildAethonNovelsPayload(
  snapshot: AethonNovelsSnapshot,
  options: {
    exportMode?: AethonNovelsExportMode;
  } = {},
): Promise<AethonBackupPayloadBuildInput> {
  const exportMode = options.exportMode ?? "repository-aware";
  const normalizedSnapshot = normalizeAethonNovelsSnapshot(snapshot);
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
        path: AETHON_NOVELS_PAYLOAD_FILE_PATH,
        bytes: jsonBytes(toPayloadFile(normalizedSnapshot, exportMode)),
        contentType: "application/json",
        role: "library",
      },
    ],
  };
}

export async function buildAethonNovelsBackupContainer(
  snapshot: AethonNovelsSnapshot,
  options: {
    exportMode?: AethonNovelsExportMode;
    appVersion?: string | null;
    platform?: string | null;
    sourceProfileId?: string | null;
  } = {},
): Promise<BuiltAethonBackupContainer> {
  const payload = await buildAethonNovelsPayload(snapshot, {
    exportMode: options.exportMode,
  });

  return buildAethonBackupContainer({
    appVersion: options.appVersion ?? null,
    platform: options.platform ?? null,
    sourceSurface: "desktop",
    sourceProfileId: options.sourceProfileId ?? null,
    payloads: [payload],
  });
}

export async function parseAethonNovelsPayload(
  bytes: Uint8Array | ArrayBuffer,
): Promise<ParsedAethonNovelsPayload> {
  const inspection = await inspectAethonBackupContainer(bytes);
  if (inspection.hasErrors) {
    throw new Error("Aethon backup container failed inspection.");
  }

  const payloadManifest = inspection.payloadManifests.novels;
  if (!payloadManifest) {
    throw new Error("The selected Aethon backup does not contain a novels payload.");
  }

  const registry = AETHON_BACKUP_PAYLOAD_REGISTRY.novels;
  const archivePath = `${registry.rootPath}/${AETHON_NOVELS_PAYLOAD_FILE_PATH}`;
  const zip = await JSZip.loadAsync(toUint8Array(bytes));
  const file = zip.file(archivePath);
  if (!file) {
    throw new Error(`Novels payload is missing ${AETHON_NOVELS_PAYLOAD_FILE_PATH}.`);
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
    snapshot: normalizeAethonNovelsSnapshot({
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
  entry: AethonNovelEntry,
  runtime: AethonNovelRuntimeState,
): AethonNovelRestoreClassification {
  const repositorySet = new Set(runtime.repositoryUrls.map((value) => normalizeUrl(value)).filter((value): value is string => Boolean(value)));
  const pluginSet = new Set(runtime.installedPluginIds.map((value) => normalizeText(value)).filter((value): value is string => Boolean(value)));
  const sourceSet = new Set(runtime.availableSourceIds.map((value) => normalizeText(value)).filter((value): value is string => Boolean(value)));

  const requiredRepositoryUrl = normalizeUrl(entry.source?.repositoryUrl);
  const requiredPluginId = normalizeText(entry.source?.pluginId);
  const requiredSourceId = normalizeText(entry.source?.sourceId);

  let outcome: AethonNovelsRestoreOutcome = "restored-usable";

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

export function classifyAethonNovelsSnapshot(
  snapshot: AethonNovelsSnapshot,
  exportMode: AethonNovelsExportMode,
  runtime: AethonNovelRuntimeState,
): RestoredAethonNovelsSnapshot {
  const normalizedSnapshot = normalizeAethonNovelsSnapshot(snapshot);
  const classifications = normalizedSnapshot.entries.map((entry) => classifyNovelEntry(entry, runtime));
  const issues: AethonNovelsRestoreIssue[] = [];

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

export async function restoreAethonNovelsPayload(
  bytes: Uint8Array | ArrayBuffer,
  runtime: AethonNovelRuntimeState,
): Promise<RestoredAethonNovelsSnapshot> {
  const parsed = await parseAethonNovelsPayload(bytes);
  return classifyAethonNovelsSnapshot(parsed.snapshot, parsed.exportMode, runtime);
}
