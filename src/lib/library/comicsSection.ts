import { createComicLibraryCardId } from "./cardIdentity";
import type {
  ComicsLibraryActions,
  ComicsSectionVM,
  LibraryCollectionVM,
  LibraryFilterOptionVM,
  LibrarySectionKind,
  LibrarySortOptionVM,
} from "./contracts";
import {
  buildCompletedLibraryIds,
  isMangaFinishedReading,
  isMangaPublicationCompleted,
  isSourceUnknownStatus,
} from "./completion";
import { getCategoryDisplayName, isCompletedCategory, normalizeCategories } from "./categories";
import { dedupeMangaById, shouldHideNsfw } from "../util";
import type { Category, Manga } from "../types";
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
  return dedupeMangaById((nodes ?? []).filter((manga) => manga.inLibrary));
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
      dedupeMangaById(nodes.map((manga) => canonicalById.get(manga.id) ?? manga)),
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
  return normalized.toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

export function buildComicsReadingStateLabel(
  manga: Pick<Manga, "id" | "status" | "chapterCount" | "unreadCount">,
  trackedCompletedIds: ReadonlySet<number> = new Set(),
  trackedChapterTotalsByMangaId: ReadonlyMap<number, number> = new Map(),
): string {
  if (isMangaFinishedReading(manga, trackedCompletedIds, trackedChapterTotalsByMangaId)) return "Finished";

  const publicationStatus = formatSourceStatusLabel(manga.status);
  if (publicationStatus) return publicationStatus;

  if ((manga.unreadCount ?? 0) > 0) return "Reading";
  if ((manga.chapterCount ?? 0) > 0) return "Up to date";
  return "Plan to read";
}

export function buildComicsLibraryCardVm(
  manga: Manga,
  options: {
    cropCovers: boolean;
    selectedIds?: ReadonlySet<number>;
    trackedCompletedIds?: ReadonlySet<number>;
    trackedChapterTotalsByMangaId?: ReadonlyMap<number, number>;
  },
) {
  const unreadCount = Math.max(0, manga.unreadCount ?? 0);
  const chapterCount = Math.max(0, manga.chapterCount ?? 0);
  const readCount = chapterCount > 0 ? Math.max(0, chapterCount - unreadCount) : 0;

  return {
    id: createComicLibraryCardId(manga.id),
    title: manga.title,
    subtitle: manga.author ?? manga.source?.displayName ?? manga.source?.name ?? "",
    coverSrc: manga.thumbnailUrl ?? null,
    coverFit: options.cropCovers ? "cover" as const : "contain" as const,
    badges: [
      ...(unreadCount > 0 ? [{
        kind: "unread" as const,
        label: `CH ${unreadCount}`,
      }] : []),
      ...((manga.downloadCount ?? 0) > 0 && unreadCount === 0 ? [{
        kind: "download" as const,
        label: "Local",
      }] : []),
    ],
    metaChips: [
      buildComicsReadingStateLabel(
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
