import { createComicLibraryCardId } from "./cardIdentity";
import type {
  ComicsLibraryActions,
  ComicsSectionVM,
  LibraryCardBadgeVM,
  LibraryCardVM,
  LibraryCollectionVM,
  LibraryFilterOptionVM,
  LibrarySectionKind,
  LibrarySortOptionVM,
} from "./contracts";
import {
  buildCompletedLibraryIds,
  isMangaPublicationCompleted,
  isSourceUnknownStatus,
} from "./completion";
import { getCategoryDisplayName, isCompletedCategory, normalizeCategories } from "./categories";
import { dedupeMangaById, shouldHideNsfw } from "../util";
import type { Category, Manga, Source } from "../types";
import type {
  LibraryFilter,
  LibrarySortDir,
  LibrarySortMode,
  LibraryStatusFilter,
} from "../../store/state.svelte";

export interface ComicsRecentlyReadEntry {
  mangaId: number;
  readAt: number;
}

export interface ComicsNsfwSettings {
  showNsfw: boolean;
  nsfwFilteredTags: string[];
  nsfwAllowedSourceIds: string[];
  nsfwBlockedSourceIds: string[];
  libraryCropCovers: boolean;
}

export interface BuildComicsSectionInput {
  librarySection: LibrarySectionKind;
  libraryFilter: LibraryFilter;
  profileLabel?: string | null;
  mangas: Manga[];
  categories: Category[];
  defaultCategoryId: number | null;
  hiddenCategoryIds: number[];
  search: string;
  sortMode: LibrarySortMode;
  sortDir: LibrarySortDir;
  statusFilter: LibraryStatusFilter;
  recentReads: ComicsRecentlyReadEntry[];
  trackedCompletedIds: Set<number>;
  trackedChapterTotalsByMangaId: Map<number, number>;
  settings: ComicsNsfwSettings;
  loading: boolean;
  error: string | null;
  selectedIds?: Set<number>;
  showBulkBar?: boolean;
  buildCards?: boolean;
}

export interface ComicsSectionState {
  visibleCategories: Category[];
  rawCategoryMangaMap: Map<number, Manga[]>;
  categoryMangaMap: Map<number, Manga[]>;
  counts: Record<string, number>;
  filteredManga: Manga[];
  vm: ComicsSectionVM;
}

export const COMICS_SORT_OPTIONS: LibrarySortOptionVM[] = [
  { id: "az", label: "A-Z" },
  { id: "unreadCount", label: "Unread chapters" },
  { id: "totalChapters", label: "Total chapters" },
  { id: "recentlyAdded", label: "Recently added" },
  { id: "recentlyRead", label: "Recently read" },
  { id: "latestFetched", label: "Latest fetched chapter" },
  { id: "latestUploaded", label: "Latest uploaded chapter" },
];

export const COMICS_STATUS_OPTIONS: LibraryFilterOptionVM[] = [
  { id: "ALL", label: "All statuses" },
  { id: "ONGOING", label: "Ongoing" },
  { id: "COMPLETED", label: "Completed" },
  { id: "CANCELLED", label: "Cancelled" },
  { id: "HIATUS", label: "Hiatus" },
  { id: "UNKNOWN", label: "Unknown" },
];

function normalizeCategoryNodes(nodes: Manga[] | undefined): Manga[] {
  return dedupeMangaById(nodes ?? []);
}

function buildSectionTabs(librarySection: LibrarySectionKind) {
  return [
    { id: "comics" as const, label: "Comics", icon: "stack" as const, active: librarySection === "comics" },
    { id: "books" as const, label: "Books", icon: "book" as const, active: librarySection === "books" },
  ];
}

export function buildVisibleComicsCategories(
  categories: Category[],
  defaultCategoryId: number | null,
  hiddenCategoryIds: number[],
): Category[] {
  return normalizeCategories(categories)
    .filter((category) => category.id !== 0 && !hiddenCategoryIds.includes(category.id))
    .sort((left, right) => {
      if (left.id === defaultCategoryId) return -1;
      if (right.id === defaultCategoryId) return 1;
      return left.order - right.order;
    });
}

export function buildRawCategoryMangaMap(categories: Category[]): Map<number, Manga[]> {
  const map = new Map<number, Manga[]>();
  for (const category of normalizeCategories(categories)) {
    map.set(category.id, normalizeCategoryNodes(category.mangas?.nodes));
  }
  return map;
}

export function buildCanonicalCategoryMangaMap(
  mangas: Manga[],
  rawCategoryMangaMap: Map<number, Manga[]>,
  completedLibraryIds: Set<number>,
  completedCategoryId: number | null,
): Map<number, Manga[]> {
  const canonicalById = new Map<number, Manga>();
  for (const manga of mangas) canonicalById.set(manga.id, manga);

  const map = new Map<number, Manga[]>();
  for (const [categoryId, nodes] of rawCategoryMangaMap) {
    map.set(
      categoryId,
      dedupeMangaById(
        nodes
          .map((manga) => canonicalById.get(manga.id) ?? (manga.inLibrary === false || !manga.title ? null : manga))
          .filter((manga): manga is Manga => Boolean(manga)),
      ),
    );
  }

  if (completedCategoryId !== null) {
    map.set(
      completedCategoryId,
      dedupeMangaById([
        ...mangas.filter((manga) => completedLibraryIds.has(manga.id)),
        ...(map.get(completedCategoryId) ?? []),
      ]),
    );
  }

  return map;
}

export function buildFilteredComics(input: BuildComicsSectionInput, categoryMangaMap: Map<number, Manga[]>): Manga[] {
  const query = input.search.trim().toLowerCase();
  let items: Manga[];

  if (input.libraryFilter === "library") {
    items = input.mangas;
  } else if (input.libraryFilter === "downloaded") {
    items = input.mangas.filter((manga) => (manga.downloadCount ?? 0) > 0);
  } else {
    items = categoryMangaMap.get(Number(input.libraryFilter)) ?? [];
  }

  items = items.filter((manga) => !shouldHideNsfw(manga, input.settings));

  if (query) {
    items = items.filter((manga) => manga.title.toLowerCase().includes(query));
  }

  if (input.statusFilter !== "ALL") {
    items = items.filter((manga) => {
      if (input.statusFilter === "COMPLETED") {
        return isMangaPublicationCompleted(manga, input.trackedCompletedIds);
      }

      const status = manga.status?.toUpperCase().replace(/\s+/g, "_") ?? "UNKNOWN";
      return status === input.statusFilter;
    });
  }

  const recentlyReadMap = new Map<number, number>();
  if (input.sortMode === "recentlyRead") {
    for (const entry of input.recentReads) {
      if (!recentlyReadMap.has(entry.mangaId)) {
        recentlyReadMap.set(entry.mangaId, entry.readAt);
      }
    }
  }

  return [...items].sort((left, right) => {
    if (input.sortMode === "unreadCount") {
      const leftHasUnread = (left.unreadCount ?? 0) > 0;
      const rightHasUnread = (right.unreadCount ?? 0) > 0;
      if (leftHasUnread !== rightHasUnread) return leftHasUnread ? -1 : 1;
    }

    let cmp = 0;
    switch (input.sortMode) {
      case "az":
        cmp = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
        break;
      case "unreadCount":
        cmp = (left.unreadCount ?? 0) - (right.unreadCount ?? 0);
        break;
      case "totalChapters":
        cmp = (left.chapterCount ?? 0) - (right.chapterCount ?? 0);
        break;
      case "recentlyAdded":
      case "latestFetched":
      case "latestUploaded":
        cmp = left.id - right.id;
        break;
      case "recentlyRead":
        cmp = (recentlyReadMap.get(left.id) ?? 0) - (recentlyReadMap.get(right.id) ?? 0);
        break;
    }

    return input.sortDir === "asc" ? cmp : -cmp;
  });
}

function buildComicsCollections(
  input: BuildComicsSectionInput,
  visibleCategories: Category[],
  counts: Record<string, number>,
): LibraryCollectionVM[] {
  return [
    {
      id: "library",
      label: "Saved",
      count: counts.library ?? 0,
      icon: "books",
      active: input.libraryFilter === "library",
      reorderable: false,
      isDefault: false,
    },
    {
      id: "downloaded",
      label: "Downloaded",
      count: counts.downloaded ?? 0,
      icon: "download",
      active: input.libraryFilter === "downloaded",
      reorderable: false,
      isDefault: false,
    },
    ...visibleCategories.map((category) => ({
      id: String(category.id),
      label: getCategoryDisplayName(category),
      count: counts[String(category.id)] ?? 0,
      icon: "folder" as const,
      active: input.libraryFilter === String(category.id),
      reorderable: true,
      isDefault: (input.defaultCategoryId ?? null) === category.id,
    })),
  ];
}

function buildComicsEmptyMessage(libraryFilter: LibraryFilter, profileLabel?: string | null, mangaCount = 0): string {
  if (libraryFilter === "library") {
    if (mangaCount === 0 && profileLabel) {
      return `This ${profileLabel} profile is empty — browse sources to add manga.`;
    }
    return "No manga saved to library — browse sources to add some.";
  }
  if (libraryFilter === "downloaded") {
    return "No downloaded manga.";
  }
  return "No manga in this folder yet. Right-click manga anywhere to assign them.";
}

function formatSourceStatusLabel(status: string | null | undefined): string | null {
  const normalized = status?.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || isSourceUnknownStatus(normalized)) return null;
  const token = normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (token === "COMPLETED" || token === "COMPLETE") return "Completed";
  if (token === "CANCELLED" || token === "CANCELED") return "Cancelled";
  if (token === "HIATUS") return "Hiatus";
  if (token === "ONGOING") return "Ongoing";
  return null;
}

export function buildComicsWorkStatusLabel(
  manga: Pick<Manga, "id" | "status">,
  trackedCompletedIds: ReadonlySet<number> = new Set(),
  _trackedChapterTotalsByMangaId: ReadonlyMap<number, number> = new Map(),
): string {
  const publicationStatus = formatSourceStatusLabel(manga.status);
  if (publicationStatus === "Completed" && trackedCompletedIds.has(manga.id)) return "Finished";
  if (publicationStatus) return publicationStatus;

  return "Unknown";
}

export const buildComicsReadingStateLabel = buildComicsWorkStatusLabel;

function normalizeSourceLanguage(lang: string | null | undefined, sourceName?: string | null): string {
  let normalized = (lang ?? "").trim().toLowerCase();
  if (!normalized && sourceName) {
    const nameLower = sourceName.toLowerCase();
    if (nameLower.includes("(en)") || nameLower.includes("english")) normalized = "en";
    else if (nameLower.includes("(pt") || nameLower.includes("portugue") || nameLower.includes("union") || nameLower.includes("mangaschan")) normalized = "pt";
    else if (nameLower.includes("(ja)") || nameLower.includes("japanese")) normalized = "ja";
    else if (nameLower.includes("(ko)") || nameLower.includes("korean")) normalized = "ko";
    else if (nameLower.includes("(es)") || nameLower.includes("spanish")) normalized = "es";
    else if (nameLower.includes("(zh)") || nameLower.includes("chinese")) normalized = "zh";
  }
  return normalized;
}

export function getLibrarySourceFlagText(lang: string | null | undefined, sourceName?: string | null): string {
  const normalized = normalizeSourceLanguage(lang, sourceName);
  if (!normalized) return "🌐";
  if (normalized.startsWith("pt") || normalized.includes("portug") || normalized === "po" || normalized === "por") return "🇧🇷";
  if (normalized.startsWith("en") || normalized.includes("english") || normalized === "gb") return "🇬🇧";
  if (normalized.startsWith("ja") || normalized.includes("japan") || normalized.includes("日本語")) return "🇯🇵";
  if (normalized.startsWith("ko") || normalized.includes("korean") || normalized.includes("한국어")) return "🇰🇷";
  if (normalized.startsWith("es") || normalized.includes("spani") || normalized.includes("españ") || normalized.includes("espan")) return "🇪🇸";
  if (normalized.startsWith("zh") || normalized.includes("chin") || normalized.includes("中文")) return "🇨🇳";
  if (normalized.startsWith("fr") || normalized.includes("frenc") || normalized.includes("franç") || normalized.includes("franc")) return "🇫🇷";
  const baseLang = normalized.split(/[-_]/)[0];
  return baseLang ? baseLang.substring(0, 2).toUpperCase() : "🌐";
}

export function getLibrarySourceCountryCode(lang: string | null | undefined, sourceName?: string | null): string | null {
  const normalized = normalizeSourceLanguage(lang, sourceName);
  if (!normalized) return null;
  if (normalized.startsWith("pt") || normalized.includes("portug") || normalized === "po" || normalized === "por") return "br";
  if (normalized.startsWith("en") || normalized.includes("english") || normalized === "gb") return "gb";
  if (normalized.startsWith("ja") || normalized.includes("japan") || normalized.includes("日本語")) return "jp";
  if (normalized.startsWith("ko") || normalized.includes("korean") || normalized.includes("한국어")) return "kr";
  if (normalized.startsWith("es") || normalized.includes("spani") || normalized.includes("españ") || normalized.includes("espan")) return "es";
  if (normalized.startsWith("zh") || normalized.includes("chin") || normalized.includes("中文")) return "cn";
  if (normalized.startsWith("fr") || normalized.includes("frenc") || normalized.includes("franç") || normalized.includes("franc")) return "fr";
  const baseLang = normalized.split(/[-_]/)[0];
  return baseLang.length === 2 ? baseLang : null;
}

function buildPrimaryGridBadge(badges: readonly LibraryCardBadgeVM[], hasSourceMetricBanner: boolean): LibraryCardBadgeVM | null {
  if (hasSourceMetricBanner) return null;
  return badges.find((badge) => badge.kind === "unread")
    ?? badges.find((badge) => badge.kind === "status")
    ?? badges.find((badge) => badge.kind === "download")
    ?? null;
}

function buildComicsLibraryCardSignature(
  manga: Manga,
  options: {
    cropCovers: boolean;
    selectedIds?: ReadonlySet<number>;
    trackedCompletedIds?: ReadonlySet<number>;
    trackedChapterTotalsByMangaId?: ReadonlyMap<number, number>;
    coverSrcOverride?: string | null;
    sourcesById?: ReadonlyMap<string, Source>;
  },
): string {
  const source = resolveComicsSource(manga, options.sourcesById);
  const hasCoverOverride = Object.prototype.hasOwnProperty.call(options, "coverSrcOverride");
  const coverSrc = hasCoverOverride ? options.coverSrcOverride : manga.thumbnailUrl ?? null;
  const chapterCount = Math.max(0, manga.chapterCount ?? 0);
  const unreadCount = Math.max(0, manga.unreadCount ?? 0);
  const downloadCount = Math.max(0, manga.downloadCount ?? 0);
  const trackedTotal = options.trackedChapterTotalsByMangaId?.get(manga.id) ?? "";
  return [
    manga.id,
    manga.title,
    manga.author ?? "",
    coverSrc ?? "",
    options.cropCovers ? "cover" : "contain",
    unreadCount,
    downloadCount,
    chapterCount,
    manga.status ?? "",
    source?.id ?? "",
    source?.displayName ?? "",
    source?.name ?? "",
    source?.lang ?? "",
    options.trackedCompletedIds?.has(manga.id) ? "finished" : "",
    trackedTotal,
    options.selectedIds?.has(manga.id) ? "selected" : "",
  ].join("\u001f");
}

function resolveComicsSource(
  manga: Manga,
  sourcesById?: ReadonlyMap<string, Source>,
): Pick<Source, "id" | "name" | "lang" | "displayName"> | undefined {
  if (manga.source) return manga.source;
  if (!manga.sourceId || !sourcesById) return undefined;
  const found = sourcesById.get(String(manga.sourceId));
  if (!found) return undefined;
  return {
    id: found.id,
    name: found.name,
    lang: found.lang,
    displayName: found.displayName,
  };
}

export function buildComicsLibraryCardVm(
  manga: Manga,
  options: {
    cropCovers: boolean;
    selectedIds?: ReadonlySet<number>;
    trackedCompletedIds?: ReadonlySet<number>;
    trackedChapterTotalsByMangaId?: ReadonlyMap<number, number>;
    sources?: Source[];
    sourcesById?: ReadonlyMap<string, Source>;
    coverSrcOverride?: string | null;
  },
): LibraryCardVM {
  const unreadCount = Math.max(0, manga.unreadCount ?? 0);
  const chapterCount = Math.max(0, manga.chapterCount ?? 0);
  const readCount = chapterCount > 0 ? Math.max(0, chapterCount - unreadCount) : 0;
  const hasCoverOverride = Object.prototype.hasOwnProperty.call(options, "coverSrcOverride");

  const sourcesById = options.sourcesById
    ?? (options.sources ? new Map(options.sources.map((source) => [String(source.id), source])) : undefined);
  const resolvedSource = resolveComicsSource(manga, sourcesById);
  const badges: LibraryCardBadgeVM[] = [
    ...(unreadCount > 0 ? [{
      kind: "unread" as const,
      label: `CH ${unreadCount}`,
    }] : []),
    ...((manga.downloadCount ?? 0) > 0 && unreadCount === 0 ? [{
      kind: "download" as const,
      label: "Local",
    }] : []),
  ];
  const sourceName = resolvedSource?.displayName ?? resolvedSource?.name ?? null;
  const countryCode = getLibrarySourceCountryCode(resolvedSource?.lang, sourceName);
  const flagText = getLibrarySourceFlagText(resolvedSource?.lang, sourceName);
  const hasFlag = Boolean(countryCode) || flagText !== "🌐";
  const hasSourceMetricBanner = true;

  return {
    id: createComicLibraryCardId(manga.id),
    title: manga.title,
    subtitle: manga.author ?? resolvedSource?.displayName ?? resolvedSource?.name ?? "",
    coverSrc: hasCoverOverride ? options.coverSrcOverride ?? null : manga.thumbnailUrl ?? null,
    coverFit: options.cropCovers ? "cover" as const : "contain" as const,
    badges,
    metaChips: [
      buildComicsWorkStatusLabel(
        manga,
        options.trackedCompletedIds,
        options.trackedChapterTotalsByMangaId,
      ),
    ],
    progress: {
      primaryLabel: String(readCount),
      secondaryLabel: chapterCount > 0 ? `/ ${chapterCount} chapters` : undefined,
      percent: chapterCount > 0 ? Math.max(0, Math.min(1, readCount / chapterCount)) : undefined,
    },
    selectable: true,
    selected: options.selectedIds?.has(manga.id) ?? false,
    disabled: false,
    sourceMetricBanner: {
      flagLabel: resolvedSource?.lang ?? "",
      downloadedCount: Math.max(0, manga.downloadCount ?? 0),
      newCount: unreadCount,
      sourceName,
      countryCode,
      flagText,
      hasFlag,
    },
    primaryGridBadge: buildPrimaryGridBadge(badges, hasSourceMetricBanner),
    listTopLeftBadges: badges
      .filter((badge) => badge.kind === "unread" || badge.kind === "download")
      .sort((left) => (left.kind === "unread" ? -1 : 1)),
    listTopRightBadges: badges.filter((badge) => badge.kind === "status"),
    listBottomLeftBadges: badges.filter((badge) => badge.kind === "subtype"),
  };
}

export interface ComicsLibraryCardVmCache {
  get: (
    manga: Manga,
    options: {
      cropCovers: boolean;
      selectedIds?: ReadonlySet<number>;
      trackedCompletedIds?: ReadonlySet<number>;
      trackedChapterTotalsByMangaId?: ReadonlyMap<number, number>;
      sourcesById?: ReadonlyMap<string, Source>;
      coverSrcOverride?: string | null;
    },
  ) => LibraryCardVM;
  prune: (liveMangaIds: readonly number[]) => void;
  clear: () => void;
}

export function createComicsLibraryCardVmCache(): ComicsLibraryCardVmCache {
  const cache = new Map<number, { signature: string; vm: LibraryCardVM }>();

  return {
    get(manga, options) {
      const signature = buildComicsLibraryCardSignature(manga, options);
      const cached = cache.get(manga.id);
      if (cached?.signature === signature) return cached.vm;

      const vm = buildComicsLibraryCardVm(manga, options);
      cache.set(manga.id, { signature, vm });
      return vm;
    },
    prune(liveMangaIds) {
      const live = new Set(liveMangaIds);
      for (const id of cache.keys()) {
        if (!live.has(id)) cache.delete(id);
      }
    },
    clear() {
      cache.clear();
    },
  };
}

function buildComicsCardVms(
  mangas: Manga[],
  cropCovers: boolean,
  selectedIds: Set<number>,
  trackedCompletedIds: ReadonlySet<number>,
  trackedChapterTotalsByMangaId: ReadonlyMap<number, number>,
) {
  return mangas.map((manga) => buildComicsLibraryCardVm(manga, {
    cropCovers,
    selectedIds,
    trackedCompletedIds,
    trackedChapterTotalsByMangaId,
  }));
}

export function buildComicsSectionState(input: BuildComicsSectionInput): ComicsSectionState {
  const visibleCategories = buildVisibleComicsCategories(
    input.categories,
    input.defaultCategoryId,
    input.hiddenCategoryIds,
  );
  const rawCategoryMangaMap = buildRawCategoryMangaMap(input.categories);
  const completedCategory = normalizeCategories(input.categories).find(isCompletedCategory) ?? null;
  const completedLibraryIds = buildCompletedLibraryIds(
    input.mangas,
    completedCategory ? rawCategoryMangaMap.get(completedCategory.id) ?? [] : [],
    input.trackedCompletedIds,
    input.trackedChapterTotalsByMangaId,
  );
  const categoryMangaMap = buildCanonicalCategoryMangaMap(
    input.mangas,
    rawCategoryMangaMap,
    completedLibraryIds,
    completedCategory?.id ?? null,
  );
  const filteredManga = buildFilteredComics(input, categoryMangaMap);
  const counts: Record<string, number> = {
    library: input.mangas.length,
    downloaded: input.mangas.filter((manga) => (manga.downloadCount ?? 0) > 0).length,
  };

  for (const category of visibleCategories) {
    counts[String(category.id)] = (categoryMangaMap.get(category.id) ?? []).length;
  }

  const selectedIds = input.selectedIds ?? new Set<number>();
  const vm: ComicsSectionVM = {
    kind: "comics",
    sectionTabs: buildSectionTabs(input.librarySection),
    collections: buildComicsCollections(input, visibleCategories, counts),
    toolbar: {
      searchValue: input.search,
      searchPlaceholder: "Search comics...",
      sortMode: input.sortMode,
      sortDir: input.sortDir,
      sortOptions: COMICS_SORT_OPTIONS,
      filterValue: input.statusFilter,
      filterOptions: COMICS_STATUS_OPTIONS,
    },
    loading: input.loading,
    error: input.error,
    emptyMessage: buildComicsEmptyMessage(input.libraryFilter, input.profileLabel, input.mangas.length),
    cards: input.buildCards === false
      ? []
      : buildComicsCardVms(
          filteredManga,
          input.settings.libraryCropCovers,
          selectedIds,
          input.trackedCompletedIds,
          input.trackedChapterTotalsByMangaId,
        ),
    selectionEnabled: true,
    selectedIds,
    showBulkBar: input.showBulkBar ?? false,
  };

  return {
    visibleCategories,
    rawCategoryMangaMap,
    categoryMangaMap,
    counts,
    filteredManga,
    vm,
  };
}

export function buildComicsSectionVM(input: BuildComicsSectionInput): ComicsSectionVM {
  return buildComicsSectionState(input).vm;
}

export function createComicsLibraryActions(actions: ComicsLibraryActions): ComicsLibraryActions {
  return actions;
}
