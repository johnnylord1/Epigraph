import type { BookEntry, BookProgress } from "../books/types";
import type { Manga } from "../types";
import type {
  InstalledNovelSourceDescriptor,
  NovelSourceSearchResult,
  PersistedNovelChapterEntry,
  PersistedNovelLibraryEntry,
} from "../novels/domain";
import type { RuntimeSettingsTab } from "../../store/state.svelte";

export type SearchContext = "home" | "library" | "browse" | "settings" | "downloads";
export type SearchLibrarySection = "comics" | "books";
export type SearchBrowseContentType = "manga" | "novels";
export type SearchBrowseSurface = "keyword" | "browse" | "sources";
export type SearchPage = SearchContext;

export type SearchResultType =
  | "comic"
  | "book"
  | "collection"
  | "browse-item"
  | "novel-library"
  | "novel-source"
  | "source"
  | "setting"
  | "settings-page"
  | "download"
  | "page"
  | "action";

export type SearchResultAction =
  | { kind: "navigate"; page: SearchPage; librarySection?: SearchLibrarySection; searchTab?: "keyword" | "browse" | "sources" }
  | { kind: "collection"; collectionId: string; librarySection: SearchLibrarySection }
  | { kind: "manga"; manga: Manga }
  | { kind: "book"; bookId: string }
  | { kind: "novel-library"; entry: PersistedNovelLibraryEntry; chapters: PersistedNovelChapterEntry[] }
  | { kind: "novel-source"; source: InstalledNovelSourceDescriptor; novel: NovelSourceSearchResult }
  | { kind: "setting"; tab: RuntimeSettingsTab; targetId?: string }
  | { kind: "download"; chapterId: number }
  | { kind: "browse"; query: string; contentType?: "manga" | "novels"; sourceId?: string };

export interface SearchResult {
  id: string;
  type: SearchResultType;
  title: string;
  description?: string;
  group: string;
  groupLabel: string;
  breadcrumb?: string;
  keywords?: string[];
  image?: string | null;
  metadata?: Record<string, string | number | boolean | null | undefined>;
  action: SearchResultAction;
  score?: number;
}

export interface SearchSettingsEntry {
  id: string;
  tab: RuntimeSettingsTab;
  group: string;
  groupLabel: string;
  title: string;
  description?: string;
  keywords?: string[];
  targetId?: string;
  value?: string;
}

export interface SearchDownloadEntry {
  chapterId: number;
  mangaTitle: string;
  chapterName: string;
  progress: number;
  status: string;
  image?: string | null;
}

export interface SearchPageEntry {
  id: string;
  title: string;
  description?: string;
  keywords?: string[];
  action: SearchResultAction;
}

export interface SearchCatalog {
  libraryManga?: Manga[];
  books?: BookEntry[];
  bookProgress?: BookProgress[];
  novels?: Array<{ entry: PersistedNovelLibraryEntry; chapters: PersistedNovelChapterEntry[] }>;
  collections?: Array<{ id: string; title: string; librarySection: SearchLibrarySection; description?: string }>;
  settings?: SearchSettingsEntry[];
  downloads?: SearchDownloadEntry[];
  pages?: SearchPageEntry[];
}

export interface SearchProviderInput {
  context: SearchContext;
  librarySection?: SearchLibrarySection;
  browseContentType?: SearchBrowseContentType;
  browseSurface?: SearchBrowseSurface;
  query: string;
  signal: AbortSignal;
}

export interface SearchProvider {
  id: string;
  contexts: readonly SearchContext[];
  remote?: boolean;
  search(input: SearchProviderInput): Promise<SearchResult[]> | SearchResult[];
}

export type BrowseSearchLoader = (query: string, signal: AbortSignal) => Promise<Manga[]>;
export interface BrowseNovelSearchEntry {
  source: InstalledNovelSourceDescriptor;
  novel: NovelSourceSearchResult;
}
export type BrowseNovelSearchLoader = (query: string, signal: AbortSignal) => Promise<BrowseNovelSearchEntry[]>;

export interface SearchOpenOptions {
  browseContentType?: SearchBrowseContentType;
  browseSurface?: SearchBrowseSurface;
}

export interface SearchState {
  context: SearchContext;
  query: string;
  localResults: SearchResult[];
  remoteResults: SearchResult[];
  loading: boolean;
  error: string | null;
}
