import JSZip from "jszip";
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
  const key = `${pluginId}:${path}`.replace(/[^a-zA-Z0-9:_/-]+/g, "-").replace(/-+/g, "-");
  return key.length > 1 ? `lnreader:${key}` : `lnreader:${fallback}`;
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
  const pluginIds = await extractLnReaderBackupPluginIds(bytes);
  const entries = Object.keys(zip.files)
    .filter((path) => path.startsWith(`${NOVEL_DIR}/`) && path.endsWith(".json") && !zip.files[path].dir)
    .sort();

  if (entries.length === 0) {
    throw new Error("LNReader backup does not contain NovelAndChapters entries.");
  }

  const rawNovels = await Promise.all(entries.map(async (path, index) => {
    const file = zip.file(path);
    const raw = file ? safeJsonParse<Record<string, any>>(await file.async("text"), {}) : {};
    if (!isLnReaderLibraryNovel(raw)) return null;
    const pluginId = normalizeText(raw.pluginId) ?? "lnreader";
    const novelPath = normalizeText(raw.path) ?? `/${raw.id ?? index + 1}`;
    const novelId = stableNovelId(pluginId, novelPath, index + 1);
    const title = normalizeText(raw.name) ?? normalizeText(raw.title) ?? `Novel ${index + 1}`;
    const coverUrl = await coverDataUrlFromBackup(downloadZip, normalizeText(raw.cover));
    const tags = typeof raw.genres === "string"
      ? raw.genres.split(",").map((tag: string) => tag.trim()).filter(Boolean)
      : [];
    const rawChapters = Array.isArray(raw.chapters) ? raw.chapters : [];
    const mappedChapters = rawChapters.map((chapter: any, chapterIndex: number) => {
      const chapterPath = normalizeText(chapter.path) ?? `/${chapter.id ?? chapterIndex + 1}`;
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
    const readChapters = mappedChapters.filter((chapter) => !chapter.unread);
    const lastReadChapter = readChapters
      .slice()
      .sort((left, right) => {
        const leftReadAt = parseLnReaderDate(left.raw.readTime) ?? 0;
        const rightReadAt = parseLnReaderDate(right.raw.readTime) ?? 0;
        if (leftReadAt !== rightReadAt) return rightReadAt - leftReadAt;
        return right.order - left.order;
      })[0] ?? null;
    const updatedAt = parseLnReaderDate(raw.lastReadAt) ?? parseLnReaderDate(lastReadChapter?.raw?.readTime) ?? Date.now();
    const progressPercent = mappedChapters.length > 0 ? readChapters.length / mappedChapters.length : 0;

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
          repositoryUrl: null,
          pluginId,
          pluginName: pluginId,
          pluginVersion: null,
          sourceId: pluginId,
          sourceName: pluginId,
          lang: null,
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
          locator: normalizeText(lastReadChapter.raw.progress)
            ?? normalizeText(lastReadChapter.raw.page)
            ?? lastReadChapter.id,
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
          locator: normalizeText(lastReadChapter.raw.progress)
            ?? normalizeText(lastReadChapter.raw.page)
            ?? lastReadChapter.id,
          readAt: updatedAt,
        }]
        : [],
    };
  }));
  const novels = rawNovels.filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (novels.length === 0) {
    throw new Error("LNReader backup does not contain saved library novels.");
  }

  return normalizeEpigraphNovelsSnapshot({
    entries: novels.map((item) => item.entry),
    chapters: novels.flatMap((item) => item.chapters),
    progress: novels.flatMap((item) => item.progress),
    bookmarks: novels.flatMap((item) => item.bookmarks),
    history: novels.flatMap((item) => item.history),
    repositories: [],
    plugins: pluginIds.map((pluginId) => ({
      id: pluginId,
      name: pluginId,
      version: null,
      repositoryUrl: null,
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
