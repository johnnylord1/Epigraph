import type {
  EpigraphNovelBookmarkEntry,
  EpigraphNovelHistoryEntry,
  EpigraphNovelProgressEntry,
  EpigraphNovelSourceIdentity,
} from "../backup/novelsBackup";
import type { NovelTrustState } from "./contracts";

export interface InstalledNovelSourceDescriptor {
  pluginId: string;
  repositoryId: string;
  repositoryUrl: string;
  trustState: NovelTrustState;
  name: string;
  lang: string;
  site: string;
  version: string;
  iconUrl: string | null;
  artifactUrl: string;
  artifactPath: string;
  enabled: boolean;
}

export interface NovelSourceSearchResult {
  sourceId: string;
  title: string;
  path: string;
  coverUrl: string | null;
  rating?: number | null;
  ratingMax?: number | null;
  ratingLabel?: string | null;
}

export interface NovelDetailChapter {
  id: string;
  novelId: string;
  path: string;
  title: string;
  order: number;
  releaseTime: number | null;
  unread: boolean;
}

export interface NovelDetailRecord {
  id: string;
  sourceId: string;
  title: string;
  path: string;
  coverUrl: string | null;
  author: string | null;
  description: string | null;
  status: string | null;
  tags: string[];
  chapterCount: number;
  chapters: NovelDetailChapter[];
  source: EpigraphNovelSourceIdentity;
}

export interface PersistedNovelLibraryEntry {
  id: string;
  title: string;
  author: string | null;
  description: string | null;
  coverUrl: string | null;
  path: string;
  status: string | null;
  tags: string[];
  source: EpigraphNovelSourceIdentity;
  chapterCount: number;
  addedAt: number;
  updatedAt: number;
  /** Arrived through sync and not yet listed from its plugin here, so only some chapters are known. */
  chaptersPending?: boolean;
}

export interface PersistedNovelChapterEntry {
  id: string;
  novelId: string;
  path: string;
  title: string;
  order: number;
  releaseTime: number | null;
  unread: boolean;
  updatedAt?: number | null;
}

export interface PersistedNovelLibraryState {
  version: 1;
  scopeKey: string;
  entries: PersistedNovelLibraryEntry[];
  chapters: PersistedNovelChapterEntry[];
  progress: EpigraphNovelProgressEntry[];
  bookmarks: EpigraphNovelBookmarkEntry[];
  history: EpigraphNovelHistoryEntry[];
  updatedAtMs: number | null;
}

export interface ActiveNovelDetailState {
  novel: NovelDetailRecord;
  inLibrary: boolean;
  /** True when the record is remote metadata without an installed reading source. */
  metadataOnly?: boolean;
}

export interface ActiveNovelReaderState {
  novelId: string;
  chapterId: string;
  chapterPath: string;
  chapterTitle: string;
  sourceId: string;
}

export function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeNovelCoverUrl(value: unknown): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (/^(?:about:blank|javascript:|data:text\/html)/i.test(normalized)) return null;
  return normalized;
}

export function normalizeStringArray(values: readonly unknown[] | null | undefined): string[] {
  return [...new Set(
    (values ?? [])
      .map((value) => normalizeText(value))
      .filter((value): value is string => Boolean(value)),
  )];
}

export function createNovelLibraryId(sourceId: string, novelPath: string): string {
  return `novel:${sourceId}:${encodeURIComponent(novelPath)}`;
}

export function createNovelChapterId(novelId: string, chapterPath: string): string {
  return `chapter:${novelId}:${encodeURIComponent(chapterPath)}`;
}
