import JSZip from "jszip";
import { createNovelLibraryId } from "../novels/domain";
import {
  classifyEpigraphNovelsSnapshot,
  normalizeEpigraphNovelsSnapshot,
  type EpigraphNovelRuntimeState,
  type EpigraphNovelsSnapshot,
  type RestoredEpigraphNovelsSnapshot,
} from "./novelsBackup";

const VERSION_FILE = "Version.json";
const CATEGORY_FILE = "Category.json";
const SETTING_FILE = "Setting.json";
const NOVEL_DIR = "NovelAndChapters";
const DOWNLOAD_ZIP = "download.zip";
const DATA_ZIP = "data.zip";

interface LnReaderPluginMetadata {
  id: string;
  name: string;
  lang: string | null;
  version: string | null;
  artifactUrl: string | null;
  repositoryUrl: string | null;
}

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function stableNovelId(pluginId: string, path: string, fallback: number): string {
  return createNovelLibraryId(pluginId, path);
}

function numberFromEpigraphId(id: string, fallback: number): number {
  const raw = Number.parseInt(id.replace(/\D+/g, "").slice(-9), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function isLnReaderLibraryNovel(record: Record<string, any>): boolean {
  if (!("inLibrary" in record)) return true;
  return record.inLibrary === true || record.inLibrary === 1 || record.inLibrary === "1";
}

function isLnReaderTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function isLnReaderFalsey(value: unknown): boolean {
  return value === false || value === 0 || value === "0";
}

function parseLnReaderDate(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;

  const normalized = raw.replace(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/,
    "$1-$2-$3T$4:$5:$6",
  );
  const normalizedParsed = Date.parse(normalized);
  return Number.isFinite(normalizedParsed) ? normalizedParsed : null;
}

function parseLnReaderChapterProgress(value: unknown): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value.trim().replace(/^[^\d.-]+/, ""))
      : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.max(0, Math.min(1, numeric / 100));
}

function lnReaderScrollLocator(chapterId: string, progress: number): string {
  return `scroll:${encodeURIComponent(chapterId)}:${Math.max(0, Math.min(1, progress)).toFixed(6)}`;
}

function mimeTypeFromPath(path: string): string {
  const normalized = path.toLowerCase().split(/[?#]/, 1)[0] ?? "";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function normalizeBackupAssetPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").split(/[?#]/, 1)[0] ?? "";
}

async function coverDataUrlFromBackup(downloadZip: JSZip | null, coverPath: string | null): Promise<string | null> {
  if (!downloadZip || !coverPath) return coverPath;
  const normalized = normalizeBackupAssetPath(coverPath);
  const file = normalized ? downloadZip.file(normalized) : null;
  if (!file) return coverPath;
  const base64 = await file.async("base64");
  return `data:${mimeTypeFromPath(normalized)};base64,${base64}`;
}

export async function buildLnReaderNovelsBackupZip(snapshot: EpigraphNovelsSnapshot): Promise<Uint8Array> {
  const normalized = normalizeEpigraphNovelsSnapshot(snapshot);
  const root = new JSZip();
  const download = new JSZip();

  root.file(VERSION_FILE, JSON.stringify({ version: "0.0.1-epigraph" }, null, 2));
  root.file(CATEGORY_FILE, JSON.stringify([], null, 2));
  root.file(SETTING_FILE, JSON.stringify({}, null, 2));
  root.file(DOWNLOAD_ZIP, await download.generateAsync({ type: "uint8array" }));

  const chapterByNovelId = new Map<string, typeof normalized.chapters>();
  for (const chapter of normalized.chapters) {
    const current = chapterByNovelId.get(chapter.novelId) ?? [];
    current.push(chapter);
    chapterByNovelId.set(chapter.novelId, current);
  }

  normalized.entries.forEach((entry, index) => {
    const numericId = numberFromEpigraphId(entry.id, index + 1);
    const pluginId = entry.source?.pluginId ?? entry.source?.sourceId ?? "epigraph";
    const novel = {
      id: numericId,
      path: entry.path,
      pluginId,
      name: entry.title,
      cover: entry.coverUrl ?? entry.coverPath ?? null,
      summary: entry.description ?? null,
      author: entry.author ?? null,
      artist: null,
      status: entry.status ?? null,
      genres: entry.tags?.join(", ") ?? null,
      inLibrary: true,
      isLocal: false,
      totalPages: null,
      chapters: (chapterByNovelId.get(entry.id) ?? []).map((chapter, chapterIndex) => ({
        id: numberFromEpigraphId(chapter.id, chapterIndex + 1),
        novelId: numericId,
        path: chapter.path,
        name: chapter.title,
        releaseTime: chapter.releaseTime ? new Date(chapter.releaseTime).toISOString() : null,
        readTime: chapter.unread ? null : new Date(chapter.updatedAt ?? Date.now()).toISOString(),
        bookmark: false,
        unread: chapter.unread,
        isDownloaded: false,
        updatedTime: chapter.updatedAt ? new Date(chapter.updatedAt).toISOString() : null,
        chapterNumber: chapter.order,
        page: null,
        progress: null,
        position: chapter.order,
      })),
    };
    root.file(`${NOVEL_DIR}/${numericId}.json`, JSON.stringify(novel, null, 2));
  });

  return root.generateAsync({ type: "uint8array" });
}

async function openLnReaderDataZip(bytes: Uint8Array | ArrayBuffer): Promise<JSZip> {
  const outer = await JSZip.loadAsync(toUint8Array(bytes));
  const dataZip = outer.file(DATA_ZIP);
  if (!dataZip) return outer;
  return JSZip.loadAsync(await dataZip.async("uint8array"));
}

function pluginIdFromDownloadPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const match = normalized.match(/^Plugins\/([^/]+)\/index\.js$/i);
  return normalizeText(match?.[1]);
}

async function openLnReaderDownloadZip(zip: JSZip): Promise<JSZip | null> {
  const downloadZip = zip.file(DOWNLOAD_ZIP);
  if (!downloadZip) return null;
  return JSZip.loadAsync(await downloadZip.async("uint8array"));
}

function parseLnReaderSettingList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const parsed = safeJsonParse<unknown>(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function deriveLnReaderRepositoryUrl(artifactUrl: string | null): string | null {
  if (!artifactUrl) return null;
  try {
    const parsed = new URL(artifactUrl);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "raw.githubusercontent.com") return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    const [owner, repository] = segments;
    const buildDirectoryIndex = segments.indexOf(".js", 2);
    const branch = buildDirectoryIndex > 2 ? segments.slice(2, buildDirectoryIndex).join("/") : null;
    if (!owner || repository?.toLowerCase() !== "lnreader-plugins" || !branch) return null;
    return `https://raw.githubusercontent.com/${owner}/${repository}/${branch}/.dist/plugins.min.json`;
  } catch {
    return null;
  }
}

function toLnReaderPluginMetadata(value: unknown): LnReaderPluginMetadata | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = normalizeText(raw.id);
  if (!id) return null;
  const artifactUrl = normalizeText(raw.url);
  return {
    id,
    name: normalizeText(raw.name) ?? id,
    lang: normalizeText(raw.lang),
    version: normalizeText(raw.version),
    artifactUrl,
    repositoryUrl: deriveLnReaderRepositoryUrl(artifactUrl),
  };
}

async function readLnReaderPluginMetadata(zip: JSZip, embeddedPluginIds: readonly string[]): Promise<Map<string, LnReaderPluginMetadata>> {
  const settingsFile = zip.file(SETTING_FILE);
  if (!settingsFile) return new Map();
  const settings = safeJsonParse<Record<string, unknown>>(await settingsFile.async("text"), {});
  const available = parseLnReaderSettingList(settings.AVAILABLE_PLUGINS)
    .map(toLnReaderPluginMetadata)
    .filter((entry): entry is LnReaderPluginMetadata => Boolean(entry));
  const installed = parseLnReaderSettingList(settings.INSTALL_PLUGINS)
    .map(toLnReaderPluginMetadata)
    .filter((entry): entry is LnReaderPluginMetadata => Boolean(entry));
  const availableById = new Map(available.map((entry) => [entry.id, entry] as const));
  const installedById = new Map(installed.map((entry) => [entry.id, entry] as const));
  const pluginIds = [...new Set([...embeddedPluginIds, ...installedById.keys()])];
  return new Map(pluginIds.flatMap((pluginId) => {
    const metadata = installedById.get(pluginId) ?? availableById.get(pluginId);
    return metadata ? [[pluginId, metadata] as const] : [];
  }));
}

function lnReaderRepositoryName(repositoryUrl: string): string {
  try {
    const owner = new URL(repositoryUrl).pathname.split("/").filter(Boolean)[0] ?? "LNReader";
    return owner.toLowerCase() === "lnreader" ? "LNReader plugins" : `${owner} plugins`;
  } catch {
    return "LNReader plugins";
  }
}

export async function extractLnReaderBackupPluginIds(bytes: Uint8Array | ArrayBuffer): Promise<string[]> {
  const zip = await openLnReaderDataZip(bytes);
  const downloadZip = await openLnReaderDownloadZip(zip);
  if (!downloadZip) return [];

  return [...new Set(Object.keys(downloadZip.files)
    .map((path) => pluginIdFromDownloadPath(path))
    .filter((pluginId): pluginId is string => Boolean(pluginId))
    .sort((left, right) => left.localeCompare(right)))];
}

export async function isLnReaderBackupZip(bytes: Uint8Array | ArrayBuffer): Promise<boolean> {
  try {
    const zip = await openLnReaderDataZip(bytes);
    const hasVersion = Boolean(zip.file(VERSION_FILE));
    const hasNovelDir = Object.keys(zip.files).some((path) => path.startsWith(`${NOVEL_DIR}/`) && path.endsWith(".json"));
    return hasVersion && hasNovelDir;
  } catch {
    return false;
  }
}

export async function parseLnReaderNovelsBackup(bytes: Uint8Array | ArrayBuffer): Promise<EpigraphNovelsSnapshot> {
  const zip = await openLnReaderDataZip(bytes);
  const downloadZip = await openLnReaderDownloadZip(zip);
  const embeddedPluginIds = await extractLnReaderBackupPluginIds(bytes);
  const pluginMetadata = await readLnReaderPluginMetadata(zip, embeddedPluginIds);
  const settingsFile = zip.file(SETTING_FILE);
  const settings = settingsFile ? safeJsonParse<Record<string, unknown>>(await settingsFile.async("text"), {}) : {};
  const pluginIds = [...new Set([...embeddedPluginIds, ...pluginMetadata.keys()])].sort((left, right) => left.localeCompare(right));
  const entries = Object.keys(zip.files)
    .filter((path) => path.startsWith(`${NOVEL_DIR}/`) && path.endsWith(".json") && !zip.files[path].dir)
    .sort();

  if (entries.length === 0) {
    throw new Error("LNReader backup does not contain NovelAndChapters entries.");
  }

  const importIssues: NonNullable<EpigraphNovelsSnapshot["importIssues"]> = [];
  const rawNovels = await Promise.all(entries.map(async (path, index) => {
    const file = zip.file(path);
    const raw = file ? safeJsonParse<Record<string, any>>(await file.async("text"), {}) : {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      importIssues.push({ code: "invalid-novel-identity", message: "Skipped a malformed novel record." });
      return null;
    }
    if (!isLnReaderLibraryNovel(raw)) return null;
    const pluginId = normalizeText(raw.pluginId);
    const novelPath = normalizeText(raw.path);
    if (!pluginId || !novelPath) {
      importIssues.push({ code: "invalid-novel-identity", message: "Skipped a novel without pluginId and path." });
      return null;
    }
    const plugin = pluginMetadata.get(pluginId) ?? null;
    const novelId = stableNovelId(pluginId, novelPath, index + 1);
    const title = normalizeText(raw.name) ?? normalizeText(raw.title) ?? `Novel ${index + 1}`;
    const coverUrl = await coverDataUrlFromBackup(downloadZip, normalizeText(raw.cover));
    const tags = typeof raw.genres === "string"
      ? raw.genres.split(",").map((tag: string) => tag.trim()).filter(Boolean)
      : [];
    const rawChapters = Array.isArray(raw.chapters) ? raw.chapters : [];
    const mappedChapters = rawChapters.flatMap((chapter: any, chapterIndex: number) => {
      const chapterPath = normalizeText(chapter?.path);
      if (!chapterPath) {
        importIssues.push({ code: "invalid-chapter-identity", novelId, message: "Skipped a chapter without a stable path." });
        return [];
      }
      return {
        id: `${novelId}:chapter:${chapterPath}`,
        novelId,
        path: chapterPath,
        title: normalizeText(chapter.name) ?? normalizeText(chapter.title) ?? `Chapter ${chapterIndex + 1}`,
        order: typeof chapter.position === "number" ? chapter.position : chapterIndex,
        releaseTime: parseLnReaderDate(chapter.releaseTime),
        unread: !isLnReaderFalsey(chapter.unread),
        updatedAt: parseLnReaderDate(chapter.updatedTime ?? chapter.readTime),
        raw: chapter,
      };
    });
    const savedValue = settings[`LAST_READ_PREFIX_${pluginId}_${novelPath}`];
    const savedChapter = typeof savedValue === "string"
      ? safeJsonParse<Record<string, any> | null>(savedValue, null)
      : savedValue && typeof savedValue === "object" ? savedValue as Record<string, any> : null;
    const savedPath = normalizeText(savedChapter?.path);
    const savedMatchesNovel = savedChapter?.novelId == null || String(savedChapter.novelId) === String(raw.id);
    const savedResume = savedPath && savedMatchesNovel ? {
      id: `${novelId}:chapter:${savedPath}`,
      title: normalizeText(savedChapter?.name) ?? "Saved chapter",
      order: Number(savedChapter?.position ?? 0),
      unread: !isLnReaderFalsey(savedChapter?.unread),
      raw: savedChapter!,
    } : null;
    const lastReadChapter = savedResume ?? mappedChapters
      .filter((chapter) => !chapter.unread || parseLnReaderChapterProgress(chapter.raw.progress) > 0)
      .slice()
      .sort((left, right) => {
        const leftReadAt = parseLnReaderDate(left.raw.readTime) ?? 0;
        const rightReadAt = parseLnReaderDate(right.raw.readTime) ?? 0;
        if (leftReadAt !== rightReadAt) return rightReadAt - leftReadAt;
        return right.order - left.order;
      })[0] ?? null;
    // Import time and source-update time are not reading-event evidence.
    // Zero retains the existing numeric wire shape while meaning "not known".
    const updatedAt = parseLnReaderDate(lastReadChapter?.raw?.readTime) ?? 0;
    const chapterProgress = lastReadChapter
      ? (lastReadChapter.unread ? parseLnReaderChapterProgress(lastReadChapter.raw.progress) : 1)
      : 0;
    const chapterIndex = lastReadChapter
      ? mappedChapters.findIndex((chapter) => chapter.id === lastReadChapter.id)
      : -1;
    const progressPercent = mappedChapters.length > 0 && chapterIndex >= 0
      ? (chapterIndex + chapterProgress) / mappedChapters.length
      // A saved chapter can be absent from the exported catalog. Keep its exact
      // locator without inventing catalog entries or declaring completion.
      : 0;
    const lastReadLocator = lastReadChapter
      ? lastReadChapter.unread && chapterProgress > 0
        ? lnReaderScrollLocator(lastReadChapter.id, chapterProgress)
        : normalizeText(lastReadChapter.raw.progress)
          ?? normalizeText(lastReadChapter.raw.page)
          ?? lastReadChapter.id
      : null;

    return {
      entry: {
        id: novelId,
        title,
        path: novelPath,
        author: normalizeText(raw.author),
        description: normalizeText(raw.summary),
        coverUrl,
        coverPath: null,
        externalNovelId: raw.id == null ? null : String(raw.id),
        externalUrl: null,
        status: normalizeText(raw.status),
        tags,
        source: {
          repositoryUrl: plugin?.repositoryUrl ?? null,
          pluginId,
          pluginName: plugin?.name ?? pluginId,
          pluginVersion: plugin?.version ?? null,
          sourceId: pluginId,
          sourceName: plugin?.name ?? pluginId,
          lang: plugin?.lang ?? null,
        },
        addedAt: Date.now(),
        updatedAt,
      },
      chapters: mappedChapters.map(({ raw: _raw, ...chapter }) => chapter),
      progress: lastReadChapter
        ? [{
          novelId,
          chapterId: lastReadChapter.id,
          chapterTitle: lastReadChapter.title,
          progressPercent,
          locator: lastReadLocator!,
          updatedAt,
        }]
        : [],
      bookmarks: mappedChapters
        .filter((chapter) => isLnReaderTruthy(chapter.raw.bookmark))
        .map((chapter) => ({
          novelId,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          locator: normalizeText(chapter.raw.progress) ?? normalizeText(chapter.raw.page) ?? chapter.id,
          label: chapter.title,
          savedAt: parseLnReaderDate(chapter.raw.readTime) ?? updatedAt,
        })),
      history: lastReadChapter
        ? [{
          novelId,
          chapterId: lastReadChapter.id,
          chapterTitle: lastReadChapter.title,
          locator: lastReadLocator!,
          readAt: updatedAt,
        }]
        : [],
    };
  }));
  const novels = rawNovels.filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (novels.length === 0) {
    throw new Error("LNReader backup does not contain saved library novels.");
  }

  const categories: NonNullable<EpigraphNovelsSnapshot["categories"]> = [];
  const categoryFile = zip.file(CATEGORY_FILE);
  if (categoryFile) {
    const rawCategories: unknown = safeJsonParse(await categoryFile.async("text"), null);
    if (!Array.isArray(rawCategories)) importIssues.push({ code: "invalid-category", message: "Category section is malformed." });
    else for (const category of rawCategories) {
      if (!category || typeof category !== "object" || !normalizeText(category.name)
        || !["string", "number"].includes(typeof category.id) || !Array.isArray(category.novelIds)) {
        importIssues.push({ code: "invalid-category", message: "Skipped a malformed category." }); continue;
      }
      const novelIds: string[] = [];
      for (const backupId of category.novelIds) {
        const matches = novels.filter(novel => novel.entry.externalNovelId === String(backupId));
        if (matches.length === 1) novelIds.push(matches[0].entry.id);
        else importIssues.push({ code: "unresolved-category-novel", message: "Preserved destination memberships because a backup Novel reference is unresolved." });
      }
      categories.push({ id: String(category.id), name: category.name.trim(), order: Number.isFinite(category.sort) ? category.sort : 0, novelIds: [...new Set(novelIds)] });
    }
  }

  return normalizeEpigraphNovelsSnapshot({
    categories,
    importIssues,
    entries: novels.map((item) => item.entry),
    chapters: novels.flatMap((item) => item.chapters),
    progress: novels.flatMap((item) => item.progress),
    bookmarks: novels.flatMap((item) => item.bookmarks),
    history: novels.flatMap((item) => item.history),
    repositories: [...new Set([...pluginMetadata.values()]
      .map((plugin) => plugin.repositoryUrl)
      .filter((url): url is string => Boolean(url)))]
      .map((url) => ({ url, name: lnReaderRepositoryName(url) })),
    plugins: pluginIds.map((pluginId) => ({
      id: pluginId,
      name: pluginMetadata.get(pluginId)?.name ?? pluginId,
      version: pluginMetadata.get(pluginId)?.version ?? null,
      repositoryUrl: pluginMetadata.get(pluginId)?.repositoryUrl ?? null,
    })),
  });
}

export async function restoreLnReaderNovelsBackup(
  bytes: Uint8Array | ArrayBuffer,
  runtime: EpigraphNovelRuntimeState,
): Promise<RestoredEpigraphNovelsSnapshot> {
  const snapshot = await parseLnReaderNovelsBackup(bytes);
  return classifyEpigraphNovelsSnapshot(snapshot, "repository-aware", runtime);
}
