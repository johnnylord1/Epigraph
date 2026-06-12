import type { Manga, Chapter, Category, Source } from "../lib/types";
import { cache, CACHE_GROUPS, CACHE_KEYS } from "../lib/cache";
import { DEFAULT_KEYBINDS, type Keybinds } from "../lib/keybinds";
import type {
  LocalProfileId,
  LocalProfileMeta,
  RuntimeProfileResolutionSource,
} from "../lib/localProfiles";
import { normalizeLocalProfileId, normalizeServerUrl } from "../lib/localProfiles";
import type { BookBookmarkEntry, BookEntry, BookProgress } from "../lib/books/types";
import { BookAssetResolver } from "../lib/books/assets";
import { reconcileBookIdentityState } from "../lib/books/identity";
import {
  canUseDesktopBookStorage,
  loadBookLibraryState,
  peekBookLibraryState,
  saveBookLibraryState,
} from "../lib/books/libraryState";
import {
  createBookBookmark,
  mergeBookProgress,
  normalizeBookBookmark,
  normalizeBookProgress,
} from "../lib/books/progress";
import { isCompletedCategory } from "../lib/library/categories";
import type { TrackerCompletionTracker } from "../lib/library/completion";
import type { LibraryPreferredGridColumns, LibraryViewMode } from "../lib/libraryDisplay";
import type { MangaReaderPreference } from "../lib/reader/scanlator";
import type { ActiveNovelDetailState, ActiveNovelReaderState } from "../lib/novels/domain";

export type LibraryUpdateIntensity = "eco" | "balanced" | "fast";

export type PageStyle        = "single" | "double" | "longstrip" | "fade";
export type FitMode          = "width" | "height" | "screen" | "original";
export type LibraryFilter    = "all" | "library" | "downloaded" | string;
export type LibrarySection   = "comics" | "books";
export type NavPage          = "home" | "library" | "search" | "downloads" | "settings";
export type SearchHubTab     = "keyword" | "browse" | "sources";
export type SearchBrowseTab  = "featured" | "tags";
export type SearchSourcesPane = "browse" | "extensions" | "novels";
export type ReadingDirection = "ltr" | "rtl";
export type ChapterSortDir   = "desc" | "asc";
export type ChapterSortMode  = "source" | "chapterNumber" | "uploadDate";
export type ProseReaderTheme =
  | "nocturne"
  | "dark"
  | "sepia"
  | "light"
  | "oled"
  | "slate"
  | "forest"
  | "nord"
  | "warm";
export type ProseReaderAlign = "left" | "justify";
export type PdfFitMode = "width" | "page" | "actual";

export type LibrarySortMode =
  | "az"
  | "unreadCount"
  | "totalChapters"
  | "recentlyAdded"
  | "recentlyRead"
  | "latestFetched"
  | "latestUploaded";

export type LibrarySortDir = "asc" | "desc";
export type LibraryBootstrapStatus = "idle" | "loading" | "ready" | "error";

export type LibraryStatusFilter =
  | "ALL"
  | "ONGOING"
  | "COMPLETED"
  | "CANCELLED"
  | "HIATUS"
  | "UNKNOWN";

export type BooksLibraryTypeFilter = "all" | "epub" | "pdf" | "sources";
export type BooksLibraryStatusFilter = "all" | "unopened" | "in_progress" | "finished";
export type RuntimeSettingsTab =
  | "general"
  | "appearance"
  | "reader"
  | "library"
  | "performance"
  | "keybinds"
  | "storage"
  | "folders"
  | "tracking"
  | "security"
  | "content"
  | "about"
  | "devtools";

export interface BooksCategory {
  id: string;
  name: string;
  order: number;
}

export interface BooksLibraryUiState {
  activeCategoryId: string | null;
  typeFilter: BooksLibraryTypeFilter;
  statusFilter: BooksLibraryStatusFilter;
  search: string;
  sortMode: "az" | "author" | "recentlyAdded" | "recentlyRead" | "sectionCount";
  sortDir: "asc" | "desc";
}

export interface BooksRestoreHydrationInput {
  books: BookEntry[];
  bookProgress: BookProgress[];
  bookBookmarks: BookBookmarkEntry[];
  booksCategories?: BooksCategory[];
  booksCategoryAssignments?: Record<string, string[]>;
  booksLibraryUi?: BooksLibraryUiState;
}
export type BuiltinTheme     = "dark" | "high-contrast" | "light" | "light-contrast" | "midnight" | "warm" | "nocturne";
export type Theme            = BuiltinTheme | string; // custom themes have string IDs like "custom:abc123"
export type ThemeMotionPreset = "minimal" | "soft" | "expressive";

export interface ThemeTokens {
  /* Backgrounds */
  "bg-void":    string;
  "bg-base":    string;
  "bg-surface": string;
  "bg-raised":  string;
  "bg-overlay": string;
  "bg-subtle":  string;
  /* Borders */
  "border-dim":    string;
  "border-base":   string;
  "border-strong": string;
  "border-focus":  string;
  /* Text */
  "text-primary":   string;
  "text-secondary": string;
  "text-muted":     string;
  "text-faint":     string;
  "text-disabled":  string;
  /* Accent */
  "accent":        string;
  "accent-dim":    string;
  "accent-muted":  string;
  "accent-fg":     string;
  "accent-bright": string;
  /* Semantic */
  "color-error":    string;
  "color-error-bg": string;
  "color-success":  string;
  "color-info":     string;
  "color-info-bg":  string;
}

export interface HudThemeTokens {
  "hud-control-height":        string;
  "hud-icon-button-size":      string;
  "hud-control-radius":        string;
  "hud-chip-radius":           string;
  "hud-popover-radius":        string;
  "hud-status-radius":         string;
  "hud-toast-radius":          string;
  "hud-chapter-row-radius":    string;
  "hud-surface-opacity":       string;
  "hud-sidebar-width":         string;
  "hud-toolbar-gap":           string;
  "hud-reader-chrome-opacity": string;
  "hud-selection-bg":          string;
  "hud-selection-border":      string;
  "hud-progress-height":       string;
}

export interface CustomTheme {
  id:           string; // "custom:abc123"
  name:         string;
  tokens:       ThemeTokens;
  version?:     1 | 2;
  hud?:         Partial<HudThemeTokens>;
  motion?:      ThemeMotionPreset;
  description?: string;
  preview?:     string;
}

export const DEFAULT_THEME_TOKENS: ThemeTokens = {
  "bg-void":    "#080808",
  "bg-base":    "#0c0c0c",
  "bg-surface": "#101010",
  "bg-raised":  "#151515",
  "bg-overlay": "#1a1a1a",
  "bg-subtle":  "#202020",
  "border-dim":    "#1c1c1c",
  "border-base":   "#242424",
  "border-strong": "#2e2e2e",
  "border-focus":  "#4a5c4a",
  "text-primary":   "#f0efec",
  "text-secondary": "#c8c6c0",
  "text-muted":     "#8a8880",
  "text-faint":     "#4e4d4a",
  "text-disabled":  "#2a2a28",
  "accent":        "#6b8f6b",
  "accent-dim":    "#2a3d2a",
  "accent-muted":  "#1a251a",
  "accent-fg":     "#a8c4a8",
  "accent-bright": "#8fb88f",
  "color-error":    "#c47a7a",
  "color-error-bg": "#1f1212",
  "color-success":  "#7aab7a",
  "color-info":     "#7a9ec4",
  "color-info-bg":  "#121a1f",
};

export const DEFAULT_HUD_THEME_TOKENS: HudThemeTokens = {
  "hud-control-height":        "30px",
  "hud-icon-button-size":      "30px",
  "hud-control-radius":        "5px",
  "hud-chip-radius":           "9999px",
  "hud-popover-radius":        "5px",
  "hud-status-radius":         "3px",
  "hud-toast-radius":          "7px",
  "hud-chapter-row-radius":    "5px",
  "hud-surface-opacity":       "1",
  "hud-sidebar-width":         "52px",
  "hud-toolbar-gap":           "8px",
  "hud-reader-chrome-opacity": "1",
  "hud-selection-bg":          "#1a251a",
  "hud-selection-border":      "#2a3d2a",
  "hud-progress-height":       "3px",
};

export const NOCTURNE_THEME_TOKENS: ThemeTokens = {
  "bg-void":    "#020205",
  "bg-base":    "#080813",
  "bg-surface": "#0d0d1b",
  "bg-raised":  "#141326",
  "bg-overlay": "#1b1930",
  "bg-subtle":  "#24213c",
  "border-dim":    "#19172a",
  "border-base":   "#28243f",
  "border-strong": "#393355",
  "border-focus":  "#8173d6",
  "text-primary":   "#f1eefc",
  "text-secondary": "#cfc8ec",
  "text-muted":     "#948bac",
  "text-faint":     "#5a536f",
  "text-disabled":  "#2d2a3b",
  "accent":        "#8f82e6",
  "accent-dim":    "#3a315f",
  "accent-muted":  "#211b3b",
  "accent-fg":     "#d7d0ff",
  "accent-bright": "#b8adff",
  "color-error":    "#cf8aa0",
  "color-error-bg": "#24121b",
  "color-success":  "#8acfa6",
  "color-info":     "#91a7e8",
  "color-info-bg":  "#12172c",
};

export const NOCTURNE_HUD_THEME_TOKENS: HudThemeTokens = {
  "hud-control-height":        "28px",
  "hud-icon-button-size":      "28px",
  "hud-control-radius":        "8px",
  "hud-chip-radius":           "9999px",
  "hud-popover-radius":        "12px",
  "hud-status-radius":         "9999px",
  "hud-toast-radius":          "12px",
  "hud-chapter-row-radius":    "9px",
  "hud-surface-opacity":       "0.96",
  "hud-sidebar-width":         "56px",
  "hud-toolbar-gap":           "6px",
  "hud-reader-chrome-opacity": "0.92",
  "hud-selection-bg":          "#211b3b",
  "hud-selection-border":      "#4c4078",
  "hud-progress-height":       "2px",
};

export const THEME_MOTION_VARS: Record<ThemeMotionPreset, Record<"--t-fast" | "--t-base" | "--t-slow", string>> = {
  minimal: {
    "--t-fast": "0.04s ease",
    "--t-base": "0.08s ease",
    "--t-slow": "0.14s ease",
  },
  soft: {
    "--t-fast": "0.08s ease",
    "--t-base": "0.14s ease",
    "--t-slow": "0.22s ease",
  },
  expressive: {
    "--t-fast": "0.12s cubic-bezier(0.16, 1, 0.3, 1)",
    "--t-base": "0.2s cubic-bezier(0.16, 1, 0.3, 1)",
    "--t-slow": "0.32s cubic-bezier(0.16, 1, 0.3, 1)",
  },
};


export interface HistoryEntry {
  mangaId:      number;
  mangaTitle:   string;
  thumbnailUrl: string;
  chapterId:    number;
  chapterName:  string;
  readAt:       number;
}

export interface BookmarkEntry {
  mangaId:      number;
  mangaTitle:   string;
  thumbnailUrl: string;
  chapterId:    number;
  chapterName:  string;
  pageNumber:   number;
  savedAt:      number;
  /** Optional user label, e.g. "before the fight scene" */
  label?:       string;
}

/**
 * ReadLogEntry — append-only record of every chapter-completion event.
 * Unlike HistoryEntry (which dedupes per chapter for the "continue" UI),
 * this log never overwrites existing entries. It is the source of truth
 * for all reading stats.
 */
export interface ReadLogEntry {
  mangaId:   number;
  chapterId: number;
  readAt:    number;
  /** Minutes spent on this chapter (estimated from page count or default). */
  minutes:   number;
}

export interface LibraryUpdateNotification {
  id: string;
  mangaId: number;
  mangaTitle: string;
  thumbnailUrl: string;
  sourceName: string;
  chapterDelta: number;
  previousChapterCount: number;
  nextChapterCount: number;
  createdAt: number;
}

export interface SystemNotification {
  id: string;
  kind: "success" | "error" | "info" | "download";
  title: string;
  body?: string;
  createdAt: number;
}

export interface ReadingStats {
  totalChaptersRead: number;
  totalMangaRead:    number;
  totalMinutesRead:  number;
  firstReadAt:       number;
  lastReadAt:        number;
  currentStreakDays: number;
  longestStreakDays: number;
  lastStreakDate:    string;
}

const AVG_MIN_PER_CHAPTER = 5; // fallback when no page count is available

export const DEFAULT_READING_STATS: ReadingStats = {
  totalChaptersRead: 0,
  totalMangaRead:    0,
  totalMinutesRead:  0,
  firstReadAt:       0,
  lastReadAt:        0,
  currentStreakDays: 0,
  longestStreakDays: 0,
  lastStreakDate:    "",
};

export interface Toast {
  id:        string;
  kind:      "success" | "error" | "info" | "download";
  title:     string;
  body?:     string;
  duration?: number;
  action?:   { label: string; run: () => void };
  updatedAt?: number;
}

export interface LibraryUpdateProgress {
  kind:      "download" | "success" | "error";
  title:     string;
  body:      string;
  active:    boolean;
  duration?: number;
  current?:  number;
  total?:    number;
  percent?:  number;
  updatedAt: number;
}

export interface ActiveDownload {
  chapterId: number;
  mangaId:   number;
  progress:  number;
  state?:    "QUEUED" | "DOWNLOADING" | "FINISHED" | "ERROR" | "PAUSED";
}

export interface PausedDownloadItem {
  chapterId: number;
  mangaId: number;
  progress: number;
  chapterName: string;
  pageCount: number;
  mangaTitle: string;
  thumbnailUrl: string;
  order: number;
}


export interface Settings {
  pageStyle:               PageStyle;
  readingDirection:        ReadingDirection;
  fitMode:                 FitMode;
  launchIntoLibrary:       boolean;
  /**
   * Reader zoom level — unitless float multiplier relative to the viewer
   * container width. 1.0 = image fills the viewer, 1.5 = 150%, 0.8 = 80%.
   * Replaces the old `maxPageWidth` pixel value.
   */
  readerZoom:              number;
  proseReaderFontSize:     number;
  proseReaderFontFamily:   string;
  proseReaderLineHeight:   number;
  proseReaderParagraphSpacing: number;
  proseReaderContentWidth: number;
  proseReaderTextColor:    string;
  proseReaderBackgroundColor: string;
  proseReaderTheme:        ProseReaderTheme;
  proseReaderTextAlign:    ProseReaderAlign;
  bookReaderFlow:          "paginated" | "scrolled";
  proseReaderFullWidth:    boolean;
  pdfFitMode:              PdfFitMode;
  pdfDarkMode:             boolean;
  pdfReflowMode:           boolean;
  pageGap:                 boolean;
  optimizeContrast:        boolean;
  offsetDoubleSpreads:     boolean;
  preloadPages:            number;
  autoMarkRead:            boolean;
  autoNextChapter:         boolean;
  libraryCropCovers:       boolean;
  libraryPageSize:         number;
  showNsfw:                boolean;
  filterBlockedTags:       boolean;
  discordRpc:              boolean;
  chapterSortDir:          ChapterSortDir;
  chapterSortMode:         ChapterSortMode;
  chapterPageSize:         number;
  readerBrightness:        number;
  /**
   * UI zoom level — unitless float multiplier applied on top of the
   * platform scale factor from the OS/monitor. 1.0 = no user adjustment.
   * Replaces the old `uiScale` percentage integer.
   */
  uiZoom:                  number;
  compactSidebar:          boolean;
  gpuAcceleration:         boolean;
  defaultLocalProfileId:   LocalProfileId;
  serverUrl:               string;
  serverBinary:            string;
  autoStartServer:         boolean;
  autoLibraryUpdatesEnabled: boolean;
  libraryUpdateIntervalHours: number;
  libraryUpdateIntensity:  LibraryUpdateIntensity;
  localServerStandbyEnabled: boolean;
  localServerStandbyIdleMin: number;
  lastLibraryUpdateAt?:    number;
  preferredExtensionLang:  string;
  keybinds:                Keybinds;
  idleTimeoutMin?:         number;
  splashCards?:            boolean;
  storageLimitGb:          number | null;
  markReadOnNext:          boolean;
  overlayBars:             boolean;
  readerDebounceMs:        number;
  autoBookmark:            boolean;
  theme:                   Theme;
  libraryBranches:         boolean;
  renderLimit:             number;
  heroSlots:               (number | null)[];
  mangaLinks:              Record<number, number[]>;
  novelLinks:              Record<string, string[]>;
  serverAuthUser:          string;
  serverAuthPass:          string;
  serverAuthEnabled:       boolean;
  socksProxyEnabled:       boolean;
  socksProxyHost:          string;
  socksProxyPort:          string;
  socksProxyVersion:       number;
  socksProxyUsername:      string;
  socksProxyPassword:      string;
  flareSolverrEnabled:     boolean;
  flareSolverrUrl:         string;
  flareSolverrTimeout:     number;
  flareSolverrSessionName: string;
  flareSolverrSessionTtl:  number;
  flareSolverrFallback:    boolean;
  flareSolverrLocalAutoStart: boolean;
  appLockEnabled:          boolean;
  appLockPin:              string;
  customThemes:            CustomTheme[];
  hiddenCategoryIds:       number[];
  /** Category ID that opens by default when the Library tab is first visited. null = no default (shows Saved). */
  defaultLibraryCategoryId: number | null;
  booksCategories:         BooksCategory[];
  booksCategoryAssignments: Record<string, string[]>;
  mangaReaderPrefs:        Record<string, MangaReaderPreference>;
  /**
   * Content filtering — managed via the Content tab in Settings.
   * adultContentTags:      internal adult/suggestive substrings used when showNsfw is disabled.
   * nsfwFilteredTags:      user-blocked substrings matched against genre tags (case-insensitive).
   * nsfwAllowedSourceIds:  sources explicitly permitted even though isNsfw = true.
   * nsfwBlockedSourceIds:  sources always blocked regardless of tag content.
   */
  adultContentTags:      string[];
  nsfwFilteredTags:      string[];
  nsfwAllowedSourceIds:  string[];
  nsfwBlockedSourceIds:  string[];
  /** Per-tab sort/filter state — keyed by libraryFilter value (e.g. "library", "downloaded", "42"). */
  libraryTabSort:   Record<string, { mode: LibrarySortMode; dir: LibrarySortDir }>;
  libraryTabStatus: Record<string, LibraryStatusFilter>;
  libraryViewMode:          LibraryViewMode;
  libraryPreferredGridColumns: LibraryPreferredGridColumns;
  libraryShowProgress:      boolean;
  libraryShowCardOutline:   boolean;
  defaultLibrarySection:    "last-used" | "comics" | "books";
  booksLibraryUi:   BooksLibraryUiState;
  // Legacy fields kept for migration reads only — never written after v3.
  /** @deprecated use readerZoom */
  maxPageWidth?:           number;
  /** @deprecated use uiZoom */
  uiScale?:                number;
  /** User-added extra directories to include when scanning storage usage. */
  extraScanDirs:           string[];
  /** Cached downloads path from Suwayomi, kept in sync on storage tab load. */
  serverDownloadsPath:     string;
  /** Cached local source path from Suwayomi, kept in sync on storage tab load. */
  serverLocalSourcePath:   string;
}


export const DEFAULT_SETTINGS: Settings = {
  pageStyle:              "longstrip",
  readingDirection:       "ltr",
  fitMode:                "width",
  launchIntoLibrary:      false,
  readerZoom:             1.0,
  proseReaderFontSize:    18,
  proseReaderFontFamily:  "Georgia, serif",
  proseReaderLineHeight:  1.75,
  proseReaderParagraphSpacing: 1.1,
  proseReaderContentWidth: 760,
  proseReaderTextColor:   "#ffffff",
  proseReaderBackgroundColor: "#131316",
  proseReaderTheme:       "nocturne",
  proseReaderTextAlign:   "left",
  bookReaderFlow:         "paginated",
  proseReaderFullWidth:   false,
  pdfFitMode:             "width",
  pdfDarkMode:            false,
  pdfReflowMode:          false,
  pageGap:                true,
  optimizeContrast:       false,
  offsetDoubleSpreads:    false,
  preloadPages:           3,
  autoMarkRead:           true,
  autoNextChapter:        true,
  libraryCropCovers:      true,
  libraryPageSize:        48,
  showNsfw:               false,
  filterBlockedTags:      true,
  discordRpc:             false,
  chapterSortDir:         "desc",
  chapterSortMode:        "source",
  chapterPageSize:        25,
  readerBrightness:       1.0,
  uiZoom:                 1.0,
  compactSidebar:         false,
  gpuAcceleration:        true,
  defaultLocalProfileId:  "main",
  serverUrl:              "http://127.0.0.1:4567",
  serverBinary:           "",
  autoStartServer:        true,
  autoLibraryUpdatesEnabled: true,
  libraryUpdateIntervalHours: 12,
  libraryUpdateIntensity: "balanced",
  localServerStandbyEnabled: true,
  localServerStandbyIdleMin: 10,
  lastLibraryUpdateAt:    undefined,
  preferredExtensionLang: "en",
  keybinds:               DEFAULT_KEYBINDS,
  idleTimeoutMin:         5,
  splashCards:            true,
  storageLimitGb:         null,
  markReadOnNext:         true,
  overlayBars:            false,
  readerDebounceMs:       120,
  autoBookmark:           true,
  theme:                  "nocturne",
  libraryBranches:        true,
  renderLimit:            48,
  heroSlots:              [null, null, null, null],
  mangaLinks:             {},
  novelLinks:             {},
  serverAuthUser:         "",
  serverAuthPass:         "",
  serverAuthEnabled:      false,
  socksProxyEnabled:      false,
  socksProxyHost:         "",
  socksProxyPort:         "1080",
  socksProxyVersion:      5,
  socksProxyUsername:     "",
  socksProxyPassword:     "",
  flareSolverrEnabled:    false,
  flareSolverrUrl:        "http://localhost:8191",
  flareSolverrTimeout:    60,
  flareSolverrSessionName: "moku",
  flareSolverrSessionTtl: 15,
  flareSolverrFallback:   false,
  flareSolverrLocalAutoStart: false,
  appLockEnabled:         false,
  appLockPin:             "",
  customThemes:           [],
  hiddenCategoryIds:      [],
  defaultLibraryCategoryId: null,
  booksCategories:         [],
  booksCategoryAssignments: {},
  mangaReaderPrefs:        {},
  adultContentTags:      ["adult", "mature", "hentai", "suggestive", "erotic", "pornograph", "18+", "smut", "lemon", "explicit", "sexual violence"],
  nsfwFilteredTags:      [],
  nsfwAllowedSourceIds:  [],
  nsfwBlockedSourceIds:  [],
  libraryTabSort:         {},
  libraryTabStatus:       {},
  libraryViewMode:        "grid",
  libraryPreferredGridColumns: "auto",
  libraryShowProgress:    true,
  libraryShowCardOutline: true,
  defaultLibrarySection:  "last-used",
  booksLibraryUi: {
    activeCategoryId: null,
    typeFilter: "all",
    statusFilter: "all",
    search: "",
    sortMode: "recentlyAdded",
    sortDir: "desc",
  },
  extraScanDirs:          [],
  serverDownloadsPath:    "",
  serverLocalSourcePath:  "",
};

const LEGACY_DEFAULT_BLOCKED_TAGS = [
  ["adult", "mature", "hentai", "ecchi", "erotic", "pornograph", "18+", "smut", "lemon", "explicit", "sexual violence"],
  ["adult", "mature", "hentai", "erotic", "pornograph", "18+", "smut", "lemon", "explicit", "sexual violence"],
];

function normalizeBlockedTags(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_SETTINGS.nsfwFilteredTags;
  const tags = value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  const legacy = LEGACY_DEFAULT_BLOCKED_TAGS.some((legacyTags) =>
    legacyTags.length === tags.length && legacyTags.every((tag, index) => tag === tags[index]),
  );
  return legacy ? [] : [...new Set(tags)];
}

function normalizeLibraryUpdateIntensity(value: unknown): LibraryUpdateIntensity {
  return value === "eco" || value === "fast" ? value : "balanced";
}

function cloneDefaultSettings(): Settings {
  if (typeof structuredClone === "function") {
    return structuredClone(DEFAULT_SETTINGS);
  }

  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings;
}

// ── Persistence ───────────────────────────────────────────────────────────────

const STORE_VERSION = 7;

// Fields reset to their DEFAULT_SETTINGS value on each version bump.
// Add a key here whenever its default changes meaning between releases.
const RESET_ON_UPGRADE: (keyof Settings)[] = [
  "serverBinary",
  "readerZoom",
  "uiZoom",
  "serverUrl",
];

function loadPersisted(): any {
  try {
    const raw = localStorage.getItem("moku-store");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readPersistedAppReadingSnapshot(): {
  history: HistoryEntry[];
  readLog: ReadLogEntry[];
  readingStats: ReadingStats;
} {
  const data = loadPersisted() ?? {};
  return {
    history: Array.isArray(data.history)
      ? data.history
      : [],
    readLog: Array.isArray(data.readLog)
      ? data.readLog
      : [],
    readingStats: mergeStats(data),
  };
}

function persist(patch: Record<string, unknown>) {
  try {
    const current = loadPersisted() ?? {};
    localStorage.setItem("moku-store", JSON.stringify({ ...current, ...patch }));
  } catch {}
}

const saved = (() => {
  const data = loadPersisted();
  if (!data) return null;
  if ((data.storeVersion ?? 1) < STORE_VERSION) {
    const resetPatch: Partial<Settings> = {};
    for (const key of RESET_ON_UPGRADE) {
      (resetPatch as any)[key] = (DEFAULT_SETTINGS as any)[key];
    }
    const migrated = {
      ...data,
      storeVersion: STORE_VERSION,
      settings: { ...data.settings, ...resetPatch },
    };
    try {
      localStorage.setItem("moku-store", JSON.stringify(migrated));
    } catch {}
    return migrated;
  }
  return data;
})();

function mergeSettings(saved: any): Settings {
  const savedBooksLibraryState = peekBookLibraryState();
  const savedMangaReaderPrefs = saved?.settings?.mangaReaderPrefs ?? {};
  const savedDefaultProfileId = normalizeLocalProfileId(saved?.settings?.defaultLocalProfileId);
  const savedServerUrl = normalizeServerUrl(saved?.settings?.serverUrl);
  const coercedDefaultProfileId = savedDefaultProfileId === "test" ? "main" : savedDefaultProfileId ?? DEFAULT_SETTINGS.defaultLocalProfileId;
  const coercedServerUrl = savedServerUrl === "http://127.0.0.1:4667" ? "http://127.0.0.1:4567" : savedServerUrl ?? DEFAULT_SETTINGS.serverUrl;
  const savedTheme = saved?.settings?.theme;
  const coercedTheme = savedTheme === undefined || savedTheme === "dark" ? DEFAULT_SETTINGS.theme : savedTheme;

  return {
    ...DEFAULT_SETTINGS,
    ...saved?.settings,
    keybinds:     { ...DEFAULT_KEYBINDS, ...saved?.settings?.keybinds },
    heroSlots:    saved?.settings?.heroSlots ?? [null, null, null, null],
    mangaLinks:   saved?.settings?.mangaLinks ?? {},
    novelLinks:   saved?.settings?.novelLinks ?? {},
    customThemes: saved?.settings?.customThemes ?? [],
    hiddenCategoryIds: saved?.settings?.hiddenCategoryIds ?? [],
    booksCategories: savedBooksLibraryState.booksCategories,
    booksCategoryAssignments: savedBooksLibraryState.booksCategoryAssignments,
    mangaReaderPrefs: typeof savedMangaReaderPrefs === "object" && savedMangaReaderPrefs
      ? Object.fromEntries(
          Object.entries(savedMangaReaderPrefs).map(([mangaId, value]) => {
            const preferredScanlator =
              typeof (value as MangaReaderPreference | null | undefined)?.preferredScanlator === "string"
                ? (value as MangaReaderPreference).preferredScanlator.trim()
                : "";
            const scanlatorFilter = Array.isArray((value as MangaReaderPreference | null | undefined)?.scanlatorFilter)
              ? [...new Set((value as MangaReaderPreference).scanlatorFilter.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()))]
              : [];
            return [mangaId, { preferredScanlator, scanlatorFilter }];
          }),
        )
      : {},
    libraryTabSort:    saved?.settings?.libraryTabSort    ?? {},
    libraryTabStatus:  saved?.settings?.libraryTabStatus  ?? {},
    booksLibraryUi: {
      ...savedBooksLibraryState.booksLibraryUi,
    },
    defaultLocalProfileId: coercedDefaultProfileId,
    serverUrl:             coercedServerUrl,
    theme:                 coercedTheme,
    launchIntoLibrary:    saved?.settings?.launchIntoLibrary ?? DEFAULT_SETTINGS.launchIntoLibrary,
    libraryUpdateIntensity: normalizeLibraryUpdateIntensity(saved?.settings?.libraryUpdateIntensity),
    filterBlockedTags:    saved?.settings?.filterBlockedTags ?? DEFAULT_SETTINGS.filterBlockedTags,
    adultContentTags:     saved?.settings?.adultContentTags     ?? DEFAULT_SETTINGS.adultContentTags,
    nsfwFilteredTags:     normalizeBlockedTags(saved?.settings?.nsfwFilteredTags),
    nsfwAllowedSourceIds: saved?.settings?.nsfwAllowedSourceIds ?? [],
    nsfwBlockedSourceIds: saved?.settings?.nsfwBlockedSourceIds ?? [],
  };
}

function sanitizeSettingsForPersistence(settings: Settings): Partial<Settings> {
  const next = { ...settings } as Partial<Settings>;
  delete next.booksCategories;
  delete next.booksCategoryAssignments;
  delete next.booksLibraryUi;
  return next;
}

function mergeStats(saved: any): ReadingStats {
  return { ...DEFAULT_READING_STATS, ...saved?.readingStats };
}

function normalizeLoadedHistoryEntry(entry: any): HistoryEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const mangaId = Number(entry.mangaId);
  const chapterId = Number(entry.chapterId);
  const readAt = Number(entry.readAt);
  if (!Number.isFinite(mangaId) || !Number.isFinite(chapterId) || !Number.isFinite(readAt)) return null;
  return {
    mangaId,
    mangaTitle: String(entry.mangaTitle ?? ""),
    thumbnailUrl: String(entry.thumbnailUrl ?? ""),
    chapterId,
    chapterName: String(entry.chapterName ?? ""),
    readAt,
  };
}

function normalizeLoadedReadLogEntry(entry: any): ReadLogEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const mangaId = Number(entry.mangaId);
  const chapterId = Number(entry.chapterId);
  const readAt = Number(entry.readAt);
  const minutes = Number(entry.minutes);
  if (!Number.isFinite(mangaId) || !Number.isFinite(chapterId) || !Number.isFinite(readAt) || !Number.isFinite(minutes)) return null;
  return {
    mangaId,
    chapterId,
    readAt,
    minutes,
  };
}

function normalizeLoadedLibraryUpdateNotification(entry: any): LibraryUpdateNotification | null {
  if (!entry || typeof entry !== "object") return null;
  const mangaId = Number(entry.mangaId);
  const chapterDelta = Number(entry.chapterDelta);
  const previousChapterCount = Number(entry.previousChapterCount);
  const nextChapterCount = Number(entry.nextChapterCount);
  const createdAt = Number(entry.createdAt);
  if (
    !Number.isFinite(mangaId)
    || !Number.isFinite(chapterDelta)
    || chapterDelta <= 0
    || !Number.isFinite(previousChapterCount)
    || !Number.isFinite(nextChapterCount)
    || !Number.isFinite(createdAt)
  ) return null;
  return {
    id: typeof entry.id === "string" && entry.id.trim()
      ? entry.id
      : `library-update:${mangaId}:${createdAt}`,
    mangaId,
    mangaTitle: String(entry.mangaTitle ?? ""),
    thumbnailUrl: String(entry.thumbnailUrl ?? ""),
    sourceName: String(entry.sourceName ?? "Library"),
    chapterDelta,
    previousChapterCount,
    nextChapterCount,
    createdAt,
  };
}

function normalizeLoadedSystemNotification(entry: any): SystemNotification | null {
  if (!entry || typeof entry !== "object") return null;
  const createdAt = Number(entry.createdAt);
  if (!Number.isFinite(createdAt)) return null;
  const kind = entry.kind === "success" || entry.kind === "error" || entry.kind === "download" ? entry.kind : "info";
  const title = String(entry.title ?? "").trim();
  if (!title) return null;
  return {
    id: typeof entry.id === "string" && entry.id.trim()
      ? entry.id
      : `system:${createdAt}:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    kind,
    title,
    body: typeof entry.body === "string" && entry.body.trim() ? entry.body : undefined,
    createdAt,
  };
}

function buildLibraryUpdateNotifications(
  before: Manga[],
  after: Manga[],
  createdAt = Date.now(),
): LibraryUpdateNotification[] {
  const beforeById = new Map(before.map((manga) => [manga.id, manga]));
  return after
    .map((manga) => {
      const previous = beforeById.get(manga.id);
      if (!previous) return null;
      const previousChapterCount = Math.max(0, Number(previous.chapterCount ?? 0));
      const nextChapterCount = Math.max(0, Number(manga.chapterCount ?? 0));
      const chapterDelta = nextChapterCount - previousChapterCount;
      if (chapterDelta <= 0) return null;
      const sourceName = manga.source?.displayName || manga.source?.name || "Library";
      return {
        id: `library-update:${manga.id}:${createdAt}:${previousChapterCount}:${nextChapterCount}`,
        mangaId: manga.id,
        mangaTitle: manga.title,
        thumbnailUrl: manga.thumbnailUrl ?? "",
        sourceName,
        chapterDelta,
        previousChapterCount,
        nextChapterCount,
        createdAt,
      };
    })
    .filter((entry): entry is LibraryUpdateNotification => Boolean(entry))
    .sort((left, right) => right.chapterDelta - left.chapterDelta || left.mangaTitle.localeCompare(right.mangaTitle));
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const genId = () => Math.random().toString(36).slice(2, 10);

function normalizeNavPage(savedNavPage: unknown): NavPage {
  if (savedNavPage === "library" || savedNavPage === "search" || savedNavPage === "downloads" || savedNavPage === "settings") return savedNavPage;
  if (savedNavPage === "explore" || savedNavPage === "extensions" || savedNavPage === "sources") return "search";
  return "home";
}

function normalizePrimaryNavPage(savedNavPage: unknown): Exclude<NavPage, "settings"> {
  const normalized = normalizeNavPage(savedNavPage);
  return normalized === "settings" ? "home" : normalized;
}

function clearSearchEngagedBodyClasses() {
  if (typeof document === "undefined") return;
  document.body.classList.remove(
    "aethon-settings-search-engaged",
    "aethon-home-search-engaged",
    "aethon-library-search-engaged",
    "aethon-browse-search-engaged",
    "aethon-downloads-search-engaged",
  );
}

function normalizeLibrarySection(savedLibrarySection: unknown): LibrarySection {
  return savedLibrarySection === "books" ? "books" : "comics";
}

function normalizeLoadedBook(book: any): BookEntry {
  return {
    id: String(book?.id ?? ""),
    assetFingerprint: typeof book?.assetFingerprint === "string" ? book.assetFingerprint : undefined,
    title: String(book?.title ?? "Imported book"),
    author: typeof book?.author === "string" ? book.author : null,
    description: typeof book?.description === "string" ? book.description : null,
    coverPath: typeof book?.coverPath === "string" ? book.coverPath : null,
    coverUrl: typeof book?.coverUrl === "string" ? book.coverUrl : undefined,
    subtype: book?.subtype === "pdf" ? "pdf" : "epub",
    pageCount: typeof book?.pageCount === "number" ? book.pageCount : null,
    createdAt: typeof book?.createdAt === "number" ? book.createdAt : 0,
    updatedAt: typeof book?.updatedAt === "number" ? book.updatedAt : 0,
    importPath: typeof book?.importPath === "string" ? book.importPath : "",
    assetPath: typeof book?.assetPath === "string" ? book.assetPath : "",
    toc: Array.isArray(book?.toc) ? book.toc : undefined,
    spine: Array.isArray(book?.spine) ? book.spine : undefined,
    tocCount: typeof book?.tocCount === "number" ? book.tocCount : undefined,
    spineCount: typeof book?.spineCount === "number" ? book.spineCount : undefined,
    sectionsSummary: Array.isArray(book?.sectionsSummary) ? book.sectionsSummary : undefined,
    sectionCount: typeof book?.sectionCount === "number" ? book.sectionCount : undefined,
  };
}

function normalizeLoadedBookProgress(progress: any): BookProgress {
  return normalizeBookProgress(progress);
}

function normalizeLoadedBookBookmark(bookmark: any): BookBookmarkEntry {
  return normalizeBookBookmark(bookmark);
}

const savedBookLibraryState = peekBookLibraryState();
const reconciledSavedBooks = reconcileBookIdentityState(
  savedBookLibraryState.books.map(normalizeLoadedBook),
  savedBookLibraryState.bookProgress.map(normalizeLoadedBookProgress),
);

// ── Store ─────────────────────────────────────────────────────────────────────

class Store {
  private navigationListeners = new Set<() => void>();
  navPage:           NavPage          = $state(normalizeNavPage(saved?.navPage));
  lastPrimaryNavPage: Exclude<NavPage, "settings"> = $state(normalizePrimaryNavPage(saved?.navPage));
  librarySection:    LibrarySection   = $state(normalizeLibrarySection(saved?.librarySection));
  libraryFilter:     LibraryFilter    = $state("library");
  history:           HistoryEntry[]   = $state(saved?.history       ?? []);
  libraryUpdateNotifications: LibraryUpdateNotification[] = $state(
    Array.isArray(saved?.libraryUpdateNotifications)
      ? saved.libraryUpdateNotifications
          .map(normalizeLoadedLibraryUpdateNotification)
          .filter((entry: LibraryUpdateNotification | null): entry is LibraryUpdateNotification => Boolean(entry))
      : [],
  );
  systemNotifications: SystemNotification[] = $state(
    Array.isArray(saved?.systemNotifications)
      ? saved.systemNotifications
          .map(normalizeLoadedSystemNotification)
          .filter((entry: SystemNotification | null): entry is SystemNotification => Boolean(entry))
      : [],
  );
  books:             BookEntry[]      = $state(reconciledSavedBooks.books);
  bookProgress:      BookProgress[]   = $state(reconciledSavedBooks.bookProgress);
  bookBookmarks:     BookBookmarkEntry[] = $state(savedBookLibraryState.bookBookmarks.map(normalizeLoadedBookBookmark));
  /**
   * readLog — append-only, never deduped. Every chapter completion/progress
   * event lands here. This is the authoritative source for all reading stats.
   * Capped at 5 000 entries; oldest are trimmed first.
   */
  readLog:           ReadLogEntry[]   = $state(saved?.readLog       ?? []);
  /**
   * bookmarks — user-placed markers at a specific page in a chapter.
   * Capped at 200 entries; oldest are trimmed first when the cap is hit.
   */
  bookmarks:         BookmarkEntry[]  = $state(saved?.bookmarks     ?? []);
  readingStats:      ReadingStats     = $state(mergeStats(saved));
  settings:          Settings         = $state(mergeSettings(saved));

  /**
   * Bumped each time the reader closes. Home.svelte watches this to know
   * when to re-fetch library data and refresh the hero section.
   */
  readerSessionId:   number           = $state(0);

  genreFilter:       string           = $state("");
  searchPrefill:     string           = $state("");
  activeManga:       Manga | null     = $state(null);
  activeBookId:      string | null    = $state(null);
  activeBookReaderId:string | null    = $state(null);
  activeNovelDetail: ActiveNovelDetailState | null = $state(null);
  activeNovelReader: ActiveNovelReaderState | null = $state(null);
  previewManga:      Manga | null     = $state(null);
  activeSource:      Source | null    = $state(null);
  pageUrls:          string[]         = $state([]);
  pageNumber:        number           = $state(1);
  libraryTagFilter:  string[]         = $state([]);
  settingsOpen:      boolean          = $state(normalizeNavPage(saved?.navPage) === "settings");
  runtimeSettingsTab: RuntimeSettingsTab | null = $state(null);
  homePanelHint:     "history" | null = $state(null);
  searchTabHint:     SearchHubTab | null = $state(null);
  searchBrowseHint:  SearchBrowseTab | null = $state(null);
  searchSourcesPaneHint: SearchSourcesPane | null = $state(null);
  searchVisibilityDismissed: boolean  = $state(false);
  extensionsPanelHint: "repos" | null = $state(null);
  contentSetupVersion: number         = $state(0);
  libraryScrollTop:  number           = $state(0);
  libraryVisibleCount: number         = $state(0);
  libraryReturnToMangaId: number | null = $state(null);
  activeDownloads:   ActiveDownload[] = $state([]);
  pausedDownloads:   PausedDownloadItem[] = $state([]);
  toasts:            Toast[]          = $state([]);
  libraryUpdateProgress: LibraryUpdateProgress | null = $state(null);
  libraryUpdateInFlight: boolean = $state(false);
  libraryCoverCacheGeneration: number = $state(0);
  activeChapter:     Chapter | null   = $state(null);
  activeChapterList: Chapter[]        = $state([]);
  // UI-only: synced from Tauri window events in App.svelte. Not persisted.
  isFullscreen:      boolean          = $state(false);
  runtimeResolvedLocalProfileId: LocalProfileId | null = $state(null);
  runtimeResolvedLocalProfileMeta: LocalProfileMeta | null = $state(null);
  runtimeProfileResolutionSource: RuntimeProfileResolutionSource | null = $state(null);
  runtimeLaunchProfileOverride: LocalProfileId | null = $state(null);
  runtimeIsOverrideSession: boolean = $state(false);
  runtimeServerUrl:  string | null    = $state(null);
  runtimeServerLabel:string | null    = $state(null);
  private bookCanonicalMigrationTask: Promise<number> | null = null;
  private bookCanonicalMigrationQueued = false;
  private booksStateHydrated = !canUseDesktopBookStorage();
  booksLibraryHydrated: boolean = $state(!canUseDesktopBookStorage());
  private booksStatePersistQueued = false;
  private booksStatePersistRunning = false;

  // ── Shared category list ──────────────────────────────────────────────────
  // Single source of truth for the category list, shared between Library and
  // Settings. Library owns fetching; Settings reads and mutates in-place.
  // No pub/sub or guard flags needed — both components share this $state ref.
  categories: Category[] = $state([]);
  libraryMangaSnapshot: Manga[] = $state([]);
  libraryBootstrapStatus: LibraryBootstrapStatus = $state("idle");
  libraryBootstrapScopeKey: string | null = $state(null);
  libraryTrackingSummarySnapshot: TrackerCompletionTracker[] = $state([]);

  // ── Discover session cache ────────────────────────────────────────────────
  // Survives navigation within a session but is never persisted to localStorage.
  // Key format: "<sourceId>|<type>|<genre>" or "local|<genre>"
  discoverCache:      Map<string, Manga[]> = $state(new Map());
  discoverLibraryIds: Set<number>          = $state(new Set());
  discoverSrcOffset:  number               = $state(0);

  constructor() {
    $effect.root(() => {
      $effect(() => { persist({ storeVersion:  STORE_VERSION            }); });
        $effect(() => { persist({ navPage:       this.navPage       }); });
        $effect(() => { persist({ librarySection: this.librarySection }); });
        $effect(() => { persist({ libraryFilter: this.libraryFilter }); });
        $effect(() => { persist({ history:       this.history       }); });
        $effect(() => { persist({ libraryUpdateNotifications: this.libraryUpdateNotifications }); });
        $effect(() => { persist({ systemNotifications: this.systemNotifications }); });
        $effect(() => { persist({ readLog:       this.readLog       }); });
      $effect(() => { persist({ bookmarks:     this.bookmarks     }); });
      $effect(() => { persist({ readingStats:  this.readingStats  }); });
      $effect(() => { persist({ settings:      sanitizeSettingsForPersistence(this.settings) }); });
      $effect(() => {
        this.books;
        this.bookProgress;
        this.bookBookmarks;
        this.settings.booksCategories;
        this.settings.booksCategoryAssignments;
        this.settings.booksLibraryUi;
        this.queuePersistBooksLibraryState();
      });
    });

    void this.hydrateBookLibraryState();
    this.queueCanonicalBookMigration();
  }

  subscribeNavigation(listener: () => void) {
    this.navigationListeners.add(listener);
    return () => {
      this.navigationListeners.delete(listener);
    };
  }

  private emitNavigationChange() {
    for (const listener of this.navigationListeners) {
      try {
        listener();
      } catch (error) {
        console.error("navigation listener failed:", error);
      }
    }
  }

  private async hydrateBookLibraryState() {
    try {
      const snapshot = await loadBookLibraryState();
      const validBookIds = new Set(snapshot.books.map((book) => book.id));

      this.books = snapshot.books;
      this.bookProgress = snapshot.bookProgress;
      this.bookBookmarks = snapshot.bookBookmarks.filter((bookmark) => validBookIds.has(bookmark.bookId));
      this.settings = {
        ...this.settings,
        booksCategories: snapshot.booksCategories,
        booksCategoryAssignments: snapshot.booksCategoryAssignments,
        booksLibraryUi: snapshot.booksLibraryUi,
      };

      if (this.activeBookId && !validBookIds.has(this.activeBookId)) {
        this.activeBookId = null;
      }
      if (this.activeBookReaderId && !validBookIds.has(this.activeBookReaderId)) {
        this.activeBookReaderId = null;
      }
    } finally {
      this.booksStateHydrated = true;
      this.booksLibraryHydrated = true;
      this.queueCanonicalBookMigration();
    }
  }

  private queuePersistBooksLibraryState() {
    if (!this.booksStateHydrated) return;
    this.booksStatePersistQueued = true;
    if (this.booksStatePersistRunning) return;

    queueMicrotask(() => {
      void this.flushPersistBooksLibraryState();
    });
  }

  private async flushPersistBooksLibraryState() {
    if (this.booksStatePersistRunning) return;
    this.booksStatePersistRunning = true;

    try {
      while (this.booksStatePersistQueued) {
        this.booksStatePersistQueued = false;
        await saveBookLibraryState({
          version: 1 as const,
          books: this.books.map(BookAssetResolver.toPersistedBookEntry),
          bookProgress: this.bookProgress,
          bookBookmarks: this.bookBookmarks,
          booksCategories: this.settings.booksCategories,
          booksCategoryAssignments: this.settings.booksCategoryAssignments,
          booksLibraryUi: this.settings.booksLibraryUi,
          updatedAtMs: Date.now(),
        });
      }
    } finally {
      this.booksStatePersistRunning = false;
    }
  }

  queueCanonicalBookMigration() {
    if (this.bookCanonicalMigrationQueued) return;
    this.bookCanonicalMigrationQueued = true;

    queueMicrotask(() => {
      this.bookCanonicalMigrationQueued = false;
      void this.migrateBooksToCanonical();
    });
  }

  async migrateBooksToCanonical(): Promise<number> {
    if (this.bookCanonicalMigrationTask) return this.bookCanonicalMigrationTask;

    const task = (async () => {
      const pendingIds = this.books
        .filter((book) => BookAssetResolver.needsCanonicalBookMigration(book))
        .map((book) => book.id);

      if (!pendingIds.length) return 0;

      let migratedCount = 0;

      for (const bookId of pendingIds) {
        const current = this.books.find((book) => book.id === bookId);
        if (!current) continue;

        try {
          const patch = await BookAssetResolver.ensureCanonicalBookEntry(current);
          if (!patch) continue;
          this.upsertBook({ ...current, ...patch } satisfies BookEntry);
          migratedCount += 1;
        } catch (error) {
          console.error("Failed to canonicalize imported book", current.id, error);
        }
      }

      return migratedCount;
    })().finally(() => {
      this.bookCanonicalMigrationTask = null;
    });

    this.bookCanonicalMigrationTask = task;
    return task;
  }

  openReader(chapter: Chapter, chapterList: Chapter[], manga?: Manga | null) {
    // Always set activeManga when provided so the Reader has full manga
    // context for Discord RPC (setReading) and any other manga-aware logic.
    // Callers that already set store.activeManga directly may omit this arg.
    if (manga) this.activeManga = manga;
    const resolvedManga = manga ?? this.activeManga;
    if (resolvedManga && resolvedManga.id === chapter.mangaId) {
      this.addHistory({
        mangaId: resolvedManga.id,
        mangaTitle: resolvedManga.title,
        thumbnailUrl: resolvedManga.thumbnailUrl,
        chapterId: chapter.id,
        chapterName: chapter.name,
        readAt: Date.now(),
      }, false);
    }
    this.activeChapter     = chapter;
    this.activeChapterList = chapterList;
    this.pageUrls          = [];
    this.pageNumber        = 1;
    this.readerSessionId  += 1;
  }

  closeReader() {
    // Null activeChapter FIRST so the history $effect in Reader can't fire
    // one last time with stale chapter + pageNumber=1, overwriting the real
    // last-read position with page 1.
    this.activeChapter     = null;
    this.activeChapterList = [];
    this.pageUrls          = [];
    this.pageNumber        = 1;
    this.readerSessionId  += 1;   // signals Home to refresh
  }

  openBookReader(bookId: string) {
    this.activeBookReaderId = bookId;
    this.activeChapter      = null;
    this.activeChapterList  = [];
    this.pageUrls           = [];
    this.pageNumber         = 1;
  }

  closeBookReader() {
    this.activeBookReaderId = null;
    this.readerSessionId   += 1;
  }

  /**
   * Record a reading event.
   *
   * @param entry     - The history entry for the "continue reading" UI.
   * @param completed - True when the chapter was fully read (triggers stat
   *                    accrual). False for mid-chapter progress updates.
   * @param minutes   - Actual minutes to credit; defaults to AVG_MIN_PER_CHAPTER.
   */
  addHistory(entry: HistoryEntry, completed = false, minutes = AVG_MIN_PER_CHAPTER) {
    // ── 1. Update the deduped "continue reading" history ──────────────────
    // Always keep the latest position for each chapter at the top.
    if (this.history[0]?.chapterId === entry.chapterId) {
      this.history[0] = { ...this.history[0], readAt: entry.readAt };
    } else {
      this.history = [entry, ...this.history.filter(x => x.chapterId !== entry.chapterId)].slice(0, 300);
    }

    // ── 2. Append to the read log (only on completion) ────────────────────
    // This is append-only — every completed chapter read lands here,
    // including re-reads. We cap at 5 000 to keep storage bounded.
    if (completed) {
      const logEntry: ReadLogEntry = {
        mangaId:   entry.mangaId,
        chapterId: entry.chapterId,
        readAt:    entry.readAt,
        minutes,
      };
      this.readLog = [...this.readLog, logEntry].slice(-5000);
    }

    // ── 3. Recompute stats from the read log ──────────────────────────────
    // Use the log as ground truth so stats are always accurate even after
    // history is cleared or entries are back-filled.
    const log = completed
      ? [...this.readLog] // already updated above
      : this.readLog;

    const uniqueChapters = new Set(log.map(e => e.chapterId));
    const uniqueManga    = new Set(log.map(e => e.mangaId));
    const totalMinutes   = log.reduce((sum, e) => sum + e.minutes, 0);

    const today = todayStr();
    let { currentStreakDays, longestStreakDays, lastStreakDate } = this.readingStats;
    if (lastStreakDate !== today) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
      currentStreakDays = lastStreakDate === yStr ? currentStreakDays + 1 : 1;
      longestStreakDays = Math.max(longestStreakDays, currentStreakDays);
      lastStreakDate    = today;
    }

      this.readingStats = {
        totalChaptersRead: uniqueChapters.size,
        totalMangaRead:    uniqueManga.size,
        totalMinutesRead:  totalMinutes,
        firstReadAt:       this.readingStats.firstReadAt === 0 ? entry.readAt : this.readingStats.firstReadAt,
        lastReadAt:        entry.readAt,
        currentStreakDays,
        longestStreakDays,
        lastStreakDate,
      };
      bumpContentSetupVersion();
    }

  /**
   * Add or update a bookmark for the given chapter/page. Only one bookmark
   * per chapter is kept — adding a second one replaces the first.
   */
  addBookmark(entry: Omit<BookmarkEntry, "savedAt">, label?: string) {
    const bookmark: BookmarkEntry = { ...entry, savedAt: Date.now(), label };
    this.bookmarks = [
      bookmark,
      // Keep bookmarks from other manga only — one bookmark per manga at a time
      ...this.bookmarks.filter(b => b.mangaId !== entry.mangaId),
    ].slice(0, 200);
  }

  removeBookmark(chapterId: number) {
    this.bookmarks = this.bookmarks.filter(b => b.chapterId !== chapterId);
  }

  clearBookmarks() {
    this.bookmarks = [];
  }

  getBookmark(chapterId: number): BookmarkEntry | undefined {
    return this.bookmarks.find(b => b.chapterId === chapterId);
  }

  clearHistory()                        { this.history = []; this.readLog = []; bumpContentSetupVersion(); }
  clearLibraryUpdateNotifications()     { this.libraryUpdateNotifications = []; }
  clearSystemNotifications()            { this.systemNotifications = []; }
  addSystemNotification(entry: Omit<SystemNotification, "id" | "createdAt"> & { id?: string; createdAt?: number }) {
    const createdAt = Number(entry.createdAt ?? Date.now());
    const stableId = entry.id
      ?? `system:${createdAt}:${entry.kind}:${entry.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    const notification: SystemNotification = {
      id: stableId,
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      createdAt,
    };
    this.systemNotifications = [
      notification,
      ...this.systemNotifications.filter((current) => current.id !== stableId),
    ]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 200);
    return notification;
  }
  recordLibraryUpdateNotifications(before: Manga[], after: Manga[], createdAt = Date.now()) {
    const entries = buildLibraryUpdateNotifications(before, after, createdAt);
    if (!entries.length) return [];
    const existingKeys = new Set(this.libraryUpdateNotifications.map((entry) => entry.id));
    const nextEntries = entries.filter((entry) => !existingKeys.has(entry.id));
    if (!nextEntries.length) return [];
    this.libraryUpdateNotifications = [...nextEntries, ...this.libraryUpdateNotifications].slice(0, 200);
    return nextEntries;
  }
  clearHistoryForManga(mangaId: number) {
    this.history = this.history.filter(x => x.mangaId !== mangaId);
    this.readLog  = this.readLog.filter(x => x.mangaId !== mangaId);
    // Recompute stats after removal
    const uniqueChapters = new Set(this.readLog.map(e => e.chapterId));
    const uniqueManga    = new Set(this.readLog.map(e => e.mangaId));
    const totalMinutes   = this.readLog.reduce((sum, e) => sum + e.minutes, 0);
      this.readingStats = {
        ...this.readingStats,
        totalChaptersRead: uniqueChapters.size,
        totalMangaRead:    uniqueManga.size,
        totalMinutesRead:  totalMinutes,
      };
      bumpContentSetupVersion();
    }

  upsertBook(entry: BookEntry) {
    const currentBooks = this.books.filter(book => book.id !== entry.id);
    const reconciled = reconcileBookIdentityState([entry, ...currentBooks], this.bookProgress);
    this.books = reconciled.books;
    this.bookProgress = reconciled.bookProgress;
    if (this.activeBookId) {
      this.activeBookId = reconciled.idRemap.get(this.activeBookId) ?? this.activeBookId;
    }
    this.queueCanonicalBookMigration();
  }

  removeBook(bookId: string) {
    this.books = this.books.filter(book => book.id !== bookId);
    this.bookProgress = this.bookProgress.filter(progress => progress.bookId !== bookId);
    this.bookBookmarks = this.bookBookmarks.filter(bookmark => bookmark.bookId !== bookId);
  }

  setBookProgress(next: BookProgress) {
      const idx = this.bookProgress.findIndex(progress => progress.bookId === next.bookId);
      if (idx >= 0) {
        const progress = [...this.bookProgress];
        progress[idx] = mergeBookProgress(progress[idx], next);
        this.bookProgress = progress;
        bumpContentSetupVersion();
        return;
      }
      this.bookProgress = [...this.bookProgress, normalizeBookProgress(next)];
      bumpContentSetupVersion();
    }

  getBookProgress(bookId: string): BookProgress | undefined {
    return this.bookProgress.find(progress => progress.bookId === bookId);
  }

  addBookBookmark(entry: Omit<BookBookmarkEntry, "savedAt">, label?: string) {
    const bookmark = createBookBookmark(entry, label);
    this.bookBookmarks = [
      bookmark,
      ...this.bookBookmarks.filter((candidate) => candidate.bookId !== entry.bookId),
    ].slice(0, 200);
  }

  removeBookBookmark(bookId: string) {
    this.bookBookmarks = this.bookBookmarks.filter((bookmark) => bookmark.bookId !== bookId);
  }

  replaceBooksState(snapshot: BooksRestoreHydrationInput) {
    const reconciled = reconcileBookIdentityState(
      snapshot.books.map((book) => normalizeLoadedBook(book)),
      snapshot.bookProgress.map((progress) => normalizeLoadedBookProgress(progress)),
    );
    const validBookIds = new Set(reconciled.books.map((book) => book.id));

    this.books = reconciled.books;
    this.bookProgress = reconciled.bookProgress;
    this.bookBookmarks = snapshot.bookBookmarks
      .map((bookmark) => normalizeLoadedBookBookmark(bookmark))
      .filter((bookmark) => validBookIds.has(bookmark.bookId));
    this.settings = {
      ...this.settings,
      booksCategories: Array.isArray(snapshot.booksCategories)
        ? snapshot.booksCategories.map((category) => ({
            id: String(category?.id ?? ""),
            name: String(category?.name ?? ""),
            order: typeof category?.order === "number" ? category.order : 0,
          }))
        : [],
      booksCategoryAssignments: snapshot.booksCategoryAssignments && typeof snapshot.booksCategoryAssignments === "object"
        ? Object.fromEntries(
            Object.entries(snapshot.booksCategoryAssignments).map(([bookId, categoryIds]) => [
              String(bookId),
              Array.isArray(categoryIds)
                ? categoryIds.map((categoryId) => String(categoryId))
                : [],
            ]),
          )
        : {},
      booksLibraryUi: snapshot.booksLibraryUi && typeof snapshot.booksLibraryUi === "object"
        ? {
            activeCategoryId: typeof snapshot.booksLibraryUi.activeCategoryId === "string"
              ? snapshot.booksLibraryUi.activeCategoryId
              : null,
            typeFilter: snapshot.booksLibraryUi.typeFilter === "epub" || snapshot.booksLibraryUi.typeFilter === "pdf"
              ? snapshot.booksLibraryUi.typeFilter
              : "all",
            statusFilter: snapshot.booksLibraryUi.statusFilter === "unopened" || snapshot.booksLibraryUi.statusFilter === "in_progress" || snapshot.booksLibraryUi.statusFilter === "finished"
              ? snapshot.booksLibraryUi.statusFilter
              : "all",
            search: typeof snapshot.booksLibraryUi.search === "string" ? snapshot.booksLibraryUi.search : "",
            sortMode: snapshot.booksLibraryUi.sortMode === "az"
              || snapshot.booksLibraryUi.sortMode === "author"
              || snapshot.booksLibraryUi.sortMode === "recentlyAdded"
              || snapshot.booksLibraryUi.sortMode === "recentlyRead"
              || snapshot.booksLibraryUi.sortMode === "sectionCount"
              ? snapshot.booksLibraryUi.sortMode
              : "recentlyAdded",
            sortDir: snapshot.booksLibraryUi.sortDir === "asc" ? "asc" : "desc",
          }
        : this.settings.booksLibraryUi,
    };

    if (this.activeBookId && !validBookIds.has(this.activeBookId)) {
      this.activeBookId = null;
    }
    if (this.activeBookReaderId && !validBookIds.has(this.activeBookReaderId)) {
      this.activeBookReaderId = null;
    }

    this.queueCanonicalBookMigration();
  }

  replaceAppReadingState(snapshot: {
    history?: HistoryEntry[];
    readLog?: ReadLogEntry[];
    readingStats?: ReadingStats;
  }) {
    this.history = Array.isArray(snapshot.history)
      ? snapshot.history
          .map((entry) => normalizeLoadedHistoryEntry(entry))
          .filter((entry): entry is HistoryEntry => Boolean(entry))
          .sort((left, right) => right.readAt - left.readAt)
          .slice(0, 300)
      : [];
    this.readLog = Array.isArray(snapshot.readLog)
      ? snapshot.readLog
          .map((entry) => normalizeLoadedReadLogEntry(entry))
          .filter((entry): entry is ReadLogEntry => Boolean(entry))
          .sort((left, right) => left.readAt - right.readAt)
          .slice(-5000)
      : [];
    this.readingStats = mergeStats({ readingStats: snapshot.readingStats ?? DEFAULT_READING_STATS });
    bumpContentSetupVersion();
  }

  wipeAllData() {
    this.history      = [];
    this.books        = [];
    this.bookProgress = [];
    this.bookBookmarks = [];
    this.readLog      = [];
    this.readingStats = { ...DEFAULT_READING_STATS };
    this.settings     = { ...this.settings, heroSlots: [null, null, null, null], mangaLinks: {}, novelLinks: {} };
  }


  linkManga(idA: number, idB: number) {
    if (idA === idB) return;
    const links = { ...this.settings.mangaLinks };
    links[idA]  = [...new Set([...(links[idA] ?? []), idB])];
    links[idB]  = [...new Set([...(links[idB] ?? []), idA])];
    this.settings = { ...this.settings, mangaLinks: links };
  }

  unlinkManga(idA: number, idB: number) {
    const links = { ...this.settings.mangaLinks };
    links[idA]  = (links[idA] ?? []).filter(id => id !== idB);
    links[idB]  = (links[idB] ?? []).filter(id => id !== idA);
    if (!links[idA].length) delete links[idA];
    if (!links[idB].length) delete links[idB];
    this.settings = { ...this.settings, mangaLinks: links };
  }

  getLinkedMangaIds(mangaId: number): number[]  { return this.settings.mangaLinks[mangaId] ?? []; }

  setHeroSlot(index: 1 | 2 | 3, mangaId: number | null) {
    const slots = [...(this.settings.heroSlots ?? [null, null, null, null])];
    slots[index] = mangaId;
    this.settings = { ...this.settings, heroSlots: slots };
  }

  addToast(toast: Omit<Toast, "id"> & { id?: string }) {
    const body = toast.body ?? "";
    const isDownloadLike = toast.kind === "download" || /download/i.test(toast.title);
    const existing = this.toasts.find(t =>
      t.id === toast.id
      || (
        t.kind === toast.kind
        && t.title === toast.title
        && (isDownloadLike || (t.body ?? "") === body)
      ),
    );
    const id = toast.id ?? existing?.id ?? Math.random().toString(36).slice(2);
    const next = { ...existing, ...toast, id, updatedAt: Date.now() };
    this.toasts = [...this.toasts.filter(t => t.id !== id), next].slice(-5);
    return id;
  }

  dismissToast(id: string)                      { this.toasts = this.toasts.filter(x => x.id !== id); }
  setLibraryUpdateProgress(progress: Omit<LibraryUpdateProgress, "updatedAt"> | null) {
    this.libraryUpdateProgress = progress ? { ...progress, updatedAt: Date.now() } : null;
  }
  setLibraryUpdateInFlight(next: boolean)      { this.libraryUpdateInFlight = next; }
  bumpLibraryCoverCacheGeneration()            { this.libraryCoverCacheGeneration += 1; }
  setCategories(cats: Category[])              {
    this.categories = cats;
    cache.set(CACHE_KEYS.CATEGORIES, cats, CACHE_GROUPS.LIBRARY);
  }
  setLibraryMangaSnapshot(next: Manga[])       { this.libraryMangaSnapshot = next; }
  setLibraryBootstrap(status: LibraryBootstrapStatus, scopeKey: string | null, trackingSummary: TrackerCompletionTracker[] | null = null) {
    this.libraryBootstrapStatus = status;
    this.libraryBootstrapScopeKey = scopeKey;
    if (trackingSummary !== null) this.libraryTrackingSummarySnapshot = trackingSummary;
  }
  setLibraryTrackingSummarySnapshot(next: TrackerCompletionTracker[]) {
    this.libraryTrackingSummarySnapshot = next;
    cache.set(CACHE_KEYS.LIBRARY_TRACKING_SUMMARY, next, CACHE_GROUPS.LIBRARY);
  }
  setActiveDownloads(next: ActiveDownload[])     { this.activeDownloads  = next; bumpContentSetupVersion(); }
  setPausedDownloads(next: PausedDownloadItem[]) { this.pausedDownloads = next; }
  clearActiveDetailState() {
    this.activeManga = null;
    this.activeBookId = null;
    this.activeBookReaderId = null;
    this.activeNovelDetail = null;
    this.activeNovelReader = null;
    this.activeChapter = null;
    this.activeChapterList = [];
    this.activeSource = null;
  }
  preparePrimaryNavigation(next: NavPage) {
    if (next !== "settings") this.lastPrimaryNavPage = next;
    clearSearchEngagedBodyClasses();
    this.clearActiveDetailState();
    this.homePanelHint = null;
  }
  setNavPage(next: NavPage) {
    this.preparePrimaryNavigation(next);
    this.navPage = next;
    this.settingsOpen = next === "settings";
    this.emitNavigationChange();
  }

  closeNovelReader() {
    this.activeNovelReader = null;
  }
  setHomePanelHint(next: "history" | null)      { this.homePanelHint    = next; }
  setSearchTabHint(next: SearchHubTab | null)   { this.searchTabHint    = next; }
  setSearchBrowseHint(next: SearchBrowseTab | null) { this.searchBrowseHint = next; }
  setSearchSourcesPaneHint(next: SearchSourcesPane | null) { this.searchSourcesPaneHint = next; }
  setSearchVisibilityDismissed(next: boolean)   { this.searchVisibilityDismissed = next; }
  bumpContentSetupVersion()                     { this.contentSetupVersion += 1; }
  setLibraryScrollTop(next: number)            { this.libraryScrollTop = next; }
  setLibraryVisibleCount(next: number)         { this.libraryVisibleCount = next; }
  setLibraryReturnToMangaId(next: number | null) { this.libraryReturnToMangaId = next; }
  setLibrarySection(next: LibrarySection)      {
    this.librarySection = next;
    if (next === "books") this.activeManga = null;
    else {
      this.activeBookId = null;
      this.activeBookReaderId = null;
      this.activeNovelDetail = null;
      this.activeNovelReader = null;
    }
  }
  setLibraryFilter(next: LibraryFilter)          { this.libraryFilter    = next; }
  setGenreFilter(next: string)                   { this.genreFilter      = next; }
  setSearchPrefill(next: string)                 { this.searchPrefill    = next; }
  setActiveManga(next: Manga | null)             {
    this.activeManga = next;
    if (next) {
      this.activeBookId = null;
      this.activeBookReaderId = null;
      this.activeNovelDetail = null;
      this.activeNovelReader = null;
    }
  }
  setActiveBookId(next: string | null)           {
    this.activeBookId = next;
    if (next) {
      this.activeManga = null;
      this.activeNovelDetail = null;
      this.activeNovelReader = null;
    }
  }
  setActiveNovelDetail(next: ActiveNovelDetailState | null) {
    this.activeNovelDetail = next;
    if (next) {
      this.activeManga = null;
      this.activeBookId = null;
    }
  }
  setActiveNovelReader(next: ActiveNovelReaderState | null) {
    this.activeNovelReader = next;
    if (next) {
      this.activeManga = null;
      this.activeBookId = null;
      this.activeBookReaderId = null;
    }
  }
  setPreviewManga(next: Manga | null)            { this.previewManga     = next; }
  setActiveSource(next: Source | null)           { this.activeSource     = next; }
  setPageUrls(next: string[])                    { this.pageUrls         = next; }
  setPageNumber(next: number)                    { this.pageNumber       = next; }
  setLibraryTagFilter(next: string[])            { this.libraryTagFilter = next; }
  setSettingsOpen(next: boolean) {
    if (next) {
      if (this.navPage !== "settings") this.lastPrimaryNavPage = this.navPage;
      clearSearchEngagedBodyClasses();
      this.clearActiveDetailState();
      this.homePanelHint = null;
      this.navPage = "settings";
      this.settingsOpen = true;
      this.emitNavigationChange();
      return;
    }

    this.settingsOpen = false;
    if (this.navPage === "settings") this.navPage = this.lastPrimaryNavPage;
    this.emitNavigationChange();
  }
  setRuntimeSettingsTab(next: RuntimeSettingsTab | null) { this.runtimeSettingsTab = next; }
  setExtensionsPanelHint(next: "repos" | null)   { this.extensionsPanelHint = next; }
  updateSettings(patch: Partial<Settings>)       { this.settings = { ...this.settings, ...patch }; }
  resetSettings()                                { this.settings = cloneDefaultSettings(); }
  resetKeybinds()                                { this.settings = { ...this.settings, keybinds: DEFAULT_KEYBINDS }; }


  saveCustomTheme(theme: CustomTheme) {
    const existing = this.settings.customThemes.findIndex(t => t.id === theme.id);
    const next = existing >= 0
      ? this.settings.customThemes.map((t, i) => i === existing ? theme : t)
      : [...this.settings.customThemes, theme];
    this.settings = { ...this.settings, customThemes: next };
  }

  deleteCustomTheme(id: string) {
    const next = this.settings.customThemes.filter(t => t.id !== id);
    const wasActive = this.settings.theme === id;
    this.settings = { ...this.settings, customThemes: next, theme: wasActive ? "nocturne" : this.settings.theme };
  }

  /**
   * Auto-assign or remove the "Completed" category for a manga based on
   * whether all chapters are read. Pass the `gql` executor to avoid a
   * circular import between state.svelte.ts and client.ts.
   *
   * Call after any batch mark-read/unread operation.
   */
  async checkAndMarkCompleted(
    mangaId:    number,
    chaps:      Chapter[],
    categories: Category[],
    gqlFn:      (query: string, vars: Record<string, unknown>) => Promise<unknown>,
    UPDATE_MANGA_CATEGORIES: string,
    UPDATE_MANGA?: string,
  ): Promise<void> {
    if (!chaps.length) return;
    const allRead   = chaps.every(c => c.isRead);
    const unreadCount = chaps.reduce((count, chapter) => count + (chapter.isRead ? 0 : 1), 0);
    const chapterCount = chaps.length;
    const completed = categories.find(isCompletedCategory) ?? null;
    const currentSnapshot =
      this.activeManga?.id === mangaId
        ? this.activeManga
        : this.libraryMangaSnapshot.find((manga) => manga.id === mangaId)
          ?? null;
    const currentCompletedCategory =
      completed
        ? this.categories.find((category) => category.id === completed.id) ?? null
        : null;
    const currentlyInCompleted = Boolean(
      currentCompletedCategory?.mangas?.nodes?.some((manga) => manga.id === mangaId)
    );
    const snapshotNeedsUpdate = Boolean(
      !currentSnapshot
      || currentSnapshot.unreadCount !== unreadCount
      || currentSnapshot.chapterCount !== chapterCount
      || (allRead && !currentSnapshot.inLibrary)
    );
    const completedNeedsUpdate = Boolean(completed && currentlyInCompleted !== allRead);

    if (!snapshotNeedsUpdate && !completedNeedsUpdate) return;

    if (completed) {
      if (allRead) {
        await gqlFn(UPDATE_MANGA_CATEGORIES, { mangaId, addTo: [completed.id], removeFrom: [] }).catch(console.error);
        // Ensure the manga is in the library so it shows up in the Saved tab
        if (UPDATE_MANGA) {
          await gqlFn(UPDATE_MANGA, { id: mangaId, inLibrary: true }).catch(console.error);
        }
      } else {
        await gqlFn(UPDATE_MANGA_CATEGORIES, { mangaId, addTo: [], removeFrom: [completed.id] }).catch(console.error);
      }
    }

    const patchMangaSnapshot = <T extends Manga>(manga: T): T => ({
      ...manga,
      unreadCount,
      chapterCount,
      inLibrary: allRead ? true : manga.inLibrary,
    });

    cache.update<Manga[]>(CACHE_KEYS.LIBRARY, (prev) =>
      prev.map((manga) =>
        manga.id === mangaId ? patchMangaSnapshot(manga) : manga
      )
    );
    this.libraryMangaSnapshot = this.libraryMangaSnapshot.map((manga) =>
      manga.id === mangaId ? patchMangaSnapshot(manga) : manga
    );

    const currentManga =
      this.activeManga?.id === mangaId
        ? patchMangaSnapshot(this.activeManga)
        : null;

    if (currentManga) this.activeManga = currentManga;

    const nextCategories = this.categories.map((category) => {
      const existingNodes = category.mangas?.nodes ?? [];
      const hasManga = existingNodes.some((manga) => manga.id === mangaId);

      if (!hasManga && category.id !== completed?.id) {
        return {
          ...category,
          mangas: { nodes: existingNodes },
        };
      }

      if (category.id !== completed?.id) {
        return {
          ...category,
          mangas: {
            nodes: existingNodes.map((manga) =>
              manga.id === mangaId ? patchMangaSnapshot(manga) : manga,
            ),
          },
        };
      }

      const withoutManga = existingNodes.filter((manga) => manga.id !== mangaId);

      if (!allRead) {
        return {
          ...category,
          mangas: { nodes: withoutManga },
        };
      }

      const sourceManga =
        currentManga
        ?? existingNodes.find((manga) => manga.id === mangaId)
        ?? null;

      if (!sourceManga) {
        return {
          ...category,
          mangas: { nodes: withoutManga },
        };
      }

      return {
        ...category,
        mangas: {
          nodes: [
            ...withoutManga,
            patchMangaSnapshot({ ...sourceManga, inLibrary: true }),
          ],
        },
      };
    });
    this.categories = nextCategories;
    cache.set(CACHE_KEYS.CATEGORIES, nextCategories, CACHE_GROUPS.LIBRARY);
  }

  toggleHiddenCategory(id: number) {
    const ids = this.settings.hiddenCategoryIds ?? [];
    const next = ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
    this.settings = { ...this.settings, hiddenCategoryIds: next };
  }

  clearDiscoverCache() {
    this.discoverCache      = new Map();
    this.discoverLibraryIds = new Set();
    this.discoverSrcOffset++;
  }

  openSearchKeyword() {
    this.preparePrimaryNavigation("search");
    this.navPage = "search";
    this.settingsOpen = false;
    this.searchTabHint = "keyword";
    this.searchBrowseHint = null;
    this.searchSourcesPaneHint = null;
    this.emitNavigationChange();
  }

  openSearchBrowseFeatured(genre?: string | null) {
    this.preparePrimaryNavigation("search");
    this.navPage = "search";
    this.settingsOpen = false;
    this.searchTabHint = "browse";
    this.searchBrowseHint = "featured";
    this.searchSourcesPaneHint = null;
    if (genre) this.genreFilter = genre;
    this.emitNavigationChange();
  }

  openSearchBrowseTags() {
    this.preparePrimaryNavigation("search");
    this.navPage = "search";
    this.settingsOpen = false;
    this.searchTabHint = "browse";
    this.searchBrowseHint = "tags";
    this.searchSourcesPaneHint = null;
    this.emitNavigationChange();
  }

  openSearchSources(panel: SearchSourcesPane = "browse", repoPanel: "repos" | null = null) {
    this.preparePrimaryNavigation("search");
    this.navPage = "search";
    this.settingsOpen = false;
    this.searchTabHint = "sources";
    this.searchBrowseHint = null;
    this.searchSourcesPaneHint = panel;
    this.extensionsPanelHint = repoPanel;
    this.emitNavigationChange();
  }

  openHomeDashboard() {
    this.preparePrimaryNavigation("home");
    this.navPage = "home";
    this.settingsOpen = false;
    this.homePanelHint = null;
    this.genreFilter = "";
    this.libraryFilter = "library";
    this.emitNavigationChange();
  }

  openHomeHistory() {
    this.preparePrimaryNavigation("home");
    this.navPage = "home";
    this.settingsOpen = false;
    this.homePanelHint = "history";
    this.emitNavigationChange();
  }
}

export const store = new Store();

// ── Function re-exports — zero call-site changes for actions ──────────────────

export function openReader(chapter: Chapter, chapterList: Chapter[], manga?: Manga | null) { store.openReader(chapter, chapterList, manga); }
export function closeReader()                                            { store.closeReader(); }
export function addHistory(entry: HistoryEntry, completed?: boolean, minutes?: number) { store.addHistory(entry, completed, minutes); }
export function recordLibraryUpdateNotifications(before: Manga[], after: Manga[], createdAt?: number) { return store.recordLibraryUpdateNotifications(before, after, createdAt); }
export function clearLibraryUpdateNotifications()                         { store.clearLibraryUpdateNotifications(); }
export function addSystemNotification(entry: Omit<SystemNotification, "id" | "createdAt"> & { id?: string; createdAt?: number }) {
  return store.addSystemNotification(entry);
}
export function clearSystemNotifications()                                { store.clearSystemNotifications(); }
export function clearHistory()                                           { store.clearHistory(); }
export function clearHistoryForManga(mangaId: number)                    { store.clearHistoryForManga(mangaId); }
export function upsertBook(entry: BookEntry)                             { store.upsertBook(entry); }
export function removeBook(bookId: string)                              { store.removeBook(bookId); }
export function setBookProgress(next: BookProgress)                     { store.setBookProgress(next); }
export function getBookProgress(bookId: string)                         { return store.getBookProgress(bookId); }
export function addBookBookmark(entry: Omit<BookBookmarkEntry, "savedAt">, label?: string) { store.addBookBookmark(entry, label); }
export function removeBookBookmark(bookId: string)                      { store.removeBookBookmark(bookId); }
export function replaceBooksState(snapshot: BooksRestoreHydrationInput) { store.replaceBooksState(snapshot); }
export function replaceAppReadingState(snapshot: {
  history?: HistoryEntry[];
  readLog?: ReadLogEntry[];
  readingStats?: ReadingStats;
}) {
  store.replaceAppReadingState(snapshot);
}
export function refreshAppReadingStateFromPersistence() {
  store.replaceAppReadingState(readPersistedAppReadingSnapshot());
}
export function wipeAllData()                                            { store.wipeAllData(); }
export function linkManga(idA: number, idB: number)                      { store.linkManga(idA, idB); }
export function unlinkManga(idA: number, idB: number)                    { store.unlinkManga(idA, idB); }
export function getLinkedMangaIds(mangaId: number)                       { return store.getLinkedMangaIds(mangaId); }
export function setHeroSlot(i: 1|2|3, mangaId: number | null)            { store.setHeroSlot(i, mangaId); }
export function addToast(toast: Omit<Toast, "id"> & { id?: string })     { return store.addToast(toast); }
export function dismissToast(id: string)                                 { store.dismissToast(id); }
export function setLibraryUpdateProgress(progress: Omit<LibraryUpdateProgress, "updatedAt"> | null) { store.setLibraryUpdateProgress(progress); }
export function setLibraryUpdateInFlight(next: boolean) { store.setLibraryUpdateInFlight(next); }
export function bumpLibraryCoverCacheGeneration() { store.bumpLibraryCoverCacheGeneration(); }
export function setCategories(cats: Category[])                           { store.setCategories(cats); }
export function setLibraryMangaSnapshot(next: Manga[])                    { store.setLibraryMangaSnapshot(next); }
export function setLibraryBootstrap(status: LibraryBootstrapStatus, scopeKey: string | null, trackingSummary: TrackerCompletionTracker[] | null = null) {
  store.setLibraryBootstrap(status, scopeKey, trackingSummary);
}
export function setLibraryTrackingSummarySnapshot(next: TrackerCompletionTracker[]) {
  store.setLibraryTrackingSummarySnapshot(next);
}
export function setActiveDownloads(next: ActiveDownload[])               { store.setActiveDownloads(next); }
export function setPausedDownloads(next: PausedDownloadItem[])           { store.setPausedDownloads(next); }
export function setNavPage(next: NavPage)                                { store.setNavPage(next); }
export function setLibrarySection(next: LibrarySection)                  { store.setLibrarySection(next); }
export function setLibraryFilter(next: LibraryFilter)                    { store.setLibraryFilter(next); }
export function setGenreFilter(next: string)                             { store.setGenreFilter(next); }
export function setSearchPrefill(next: string)                           { store.setSearchPrefill(next); }
export function setActiveManga(next: Manga | null)                       { store.setActiveManga(next); }
export function setActiveBookId(next: string | null)                     { store.setActiveBookId(next); }
export function openBookReader(bookId: string)                           { store.openBookReader(bookId); }
export function closeBookReader()                                        { store.closeBookReader(); }
export function setActiveNovelDetail(next: ActiveNovelDetailState | null) { store.setActiveNovelDetail(next); }
export function setActiveNovelReader(next: ActiveNovelReaderState | null) { store.setActiveNovelReader(next); }
export function closeNovelReader()                                       { store.closeNovelReader(); }
export function setPreviewManga(next: Manga | null)                      { store.setPreviewManga(next); }
export function setActiveSource(next: Source | null)                     { store.setActiveSource(next); }
export function setPageUrls(next: string[])                              { store.setPageUrls(next); }
export function setPageNumber(next: number)                              { store.setPageNumber(next); }
export function setLibraryTagFilter(next: string[])                      { store.setLibraryTagFilter(next); }
export function setSettingsOpen(next: boolean)                           { store.setSettingsOpen(next); }
export function setRuntimeSettingsTab(next: RuntimeSettingsTab | null)   { store.setRuntimeSettingsTab(next); }
export function setHomePanelHint(next: "history" | null)                 { store.setHomePanelHint(next); }
export function setSearchTabHint(next: SearchHubTab | null)              { store.setSearchTabHint(next); }
export function setSearchBrowseHint(next: SearchBrowseTab | null)        { store.setSearchBrowseHint(next); }
export function setSearchSourcesPaneHint(next: SearchSourcesPane | null) { store.setSearchSourcesPaneHint(next); }
export function setSearchVisibilityDismissed(next: boolean)              { store.setSearchVisibilityDismissed(next); }
export function bumpContentSetupVersion()                                { store.bumpContentSetupVersion(); }
export function setLibraryScrollTop(next: number)                        { store.setLibraryScrollTop(next); }
export function setLibraryVisibleCount(next: number)                     { store.setLibraryVisibleCount(next); }
export function setLibraryReturnToMangaId(next: number | null)           { store.setLibraryReturnToMangaId(next); }
export function setExtensionsPanelHint(next: "repos" | null)             { store.setExtensionsPanelHint(next); }
export function updateSettings(patch: Partial<Settings>)                 { store.updateSettings(patch); }
export function resetSettings()                                          { store.resetSettings(); }
export function resetKeybinds()                                          { store.resetKeybinds(); }
export function clearDiscoverCache()                                       { store.clearDiscoverCache(); }
export function addBookmark(entry: Omit<BookmarkEntry, "savedAt">, label?: string) { store.addBookmark(entry, label); }
export function removeBookmark(chapterId: number)                            { store.removeBookmark(chapterId); }
export function clearBookmarks()                                             { store.clearBookmarks(); }
export function getBookmark(chapterId: number)                               { return store.getBookmark(chapterId); }
export function toggleHiddenCategory(id: number)                           { store.toggleHiddenCategory(id); }
export function saveCustomTheme(theme: CustomTheme)                        { store.saveCustomTheme(theme); }
export function deleteCustomTheme(id: string)                              { store.deleteCustomTheme(id); }
export function openSearchKeyword()                                      { store.openSearchKeyword(); }
export function openSearchBrowseFeatured(genre?: string | null)          { store.openSearchBrowseFeatured(genre); }
export function openSearchBrowseTags()                                   { store.openSearchBrowseTags(); }
export function openSearchSources(panel?: SearchSourcesPane, repoPanel?: "repos" | null) { store.openSearchSources(panel, repoPanel); }
export function openHomeDashboard()                                      { store.openHomeDashboard(); }
export function openHomeHistory()                                        { store.openHomeHistory(); }
export async function checkAndMarkCompleted(
  mangaId:    number,
  chaps:      Chapter[],
  categories: Category[] = store.categories,
  gqlFn?:      (query: string, vars: Record<string, unknown>) => Promise<unknown>,
  UPDATE_MANGA_CATEGORIES?: string,
  UPDATE_MANGA?: string,
): Promise<void> {
  if (!gqlFn || !UPDATE_MANGA_CATEGORIES) {
    const [{ gql }, queries] = await Promise.all([
      import("../lib/client"),
      import("../lib/queries"),
    ]);
    gqlFn = gql;
    UPDATE_MANGA_CATEGORIES = queries.UPDATE_MANGA_CATEGORIES;
    UPDATE_MANGA ??= queries.UPDATE_MANGA;
  }

  return store.checkAndMarkCompleted(mangaId, chaps, categories, gqlFn, UPDATE_MANGA_CATEGORIES, UPDATE_MANGA);
}
