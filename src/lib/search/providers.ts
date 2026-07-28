import type { BookEntry } from "../books/types";
import type { BookProgress } from "../books/types";
import { hasBookLocalAsset } from "../books/availability";
import { translate } from "../i18n/runtime";
import type { Manga } from "../types";
import { rankSearchResults } from "./ranking";
import { normalizeSearchText } from "./normalize";
import type { BrowseNovelSearchEntry, BrowseNovelSearchLoader, BrowseSearchLoader, SearchCatalog, SearchContext, SearchDownloadEntry, SearchPageEntry, SearchProvider, SearchResult } from "./types";

function mangaResult(manga: Manga): SearchResult {
  const source = manga.source?.displayName?.trim() || translate("ui_source");
  const libraryLabel = translate("library.eyebrow");
  return {
    id: `manga:${manga.id}`,
    type: "comic",
    title: manga.title,
    description: manga.author ?? manga.status ?? undefined,
    group: "library",
    groupLabel: libraryLabel,
    breadcrumb: `${libraryLabel} > ${translate("common.comics")}`,
    keywords: [...(manga.genre ?? []), manga.source?.displayName ?? ""],
    image: manga.thumbnailUrl,
    metadata: {
      source,
      status: formatWorkStatus(manga.status),
      unread: manga.unreadCount,
      chapters: manga.chapterCount,
    },
    action: { kind: "manga", manga },
  };
}

function formatWorkStatus(status: string | null | undefined): string {
  const normalized = status?.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return translate("library.status.unknown");
  const statusKey = normalized.toLowerCase().replace(/\s+/g, "_");
  const translatedStatus = {
    ongoing: "library.status.ongoing",
    completed: "library.status.completed",
    finished: "library.collections.finished",
    cancelled: "library.status.cancelled",
    hiatus: "library.status.hiatus",
    unknown: "library.status.unknown",
  }[statusKey];
  if (translatedStatus) return translate(translatedStatus);
  return normalized
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function bookResult(book: BookEntry, progress?: BookProgress): SearchResult {
  const hasLocalAsset = hasBookLocalAsset(book);
  const libraryLabel = translate("library.eyebrow");
  const booksLabel = translate("common.books");
  return {
    id: `book:${book.id}`,
    type: "book",
    title: book.title,
    description: book.author ?? book.description ?? undefined,
    group: "books",
    groupLabel: booksLabel,
    breadcrumb: `${libraryLabel} > ${booksLabel}`,
    keywords: book.genres ?? [],
    image: book.coverPath ?? book.hardcoverCoverUrl ?? book.coverUrl,
    metadata: {
      source: book.subtype.toUpperCase(),
      status: !hasLocalAsset
        ? translate("bookDetail.fileMissing")
        : (progress?.progressPercent ?? 0) >= 0.98
          ? translate("library.collections.finished")
          : translate("library.status.completed"),
      sections: book.sectionCount ?? book.tocCount ?? book.spineCount,
    },
    action: { kind: "book", bookId: book.id },
  };
}

function novelLibraryResult(entry: NonNullable<SearchCatalog["novels"]>[number]): SearchResult {
  const sourceName = entry.entry.source.sourceName
    ?? entry.entry.source.pluginName
    ?? entry.entry.source.sourceId
    ?? translate("novelSources.eyebrow");
  const libraryLabel = translate("library.eyebrow");
  const booksLabel = translate("common.books");
  return {
    id: `novel-library:${entry.entry.id}`,
    type: "novel-library",
    title: entry.entry.title,
    description: entry.entry.author ?? sourceName,
    group: "books",
    groupLabel: booksLabel,
    breadcrumb: `${libraryLabel} > ${booksLabel}`,
    keywords: [...entry.entry.tags, sourceName],
    image: entry.entry.coverUrl,
    metadata: {
      chapters: entry.entry.chapterCount,
      source: sourceName,
      status: formatWorkStatus(entry.entry.status),
    },
    action: { kind: "novel-library", entry: entry.entry, chapters: entry.chapters },
  };
}

function catalogResult(entry: SearchPageEntry): SearchResult {
  return {
    id: entry.id,
    type: "page",
    title: entry.title,
    description: entry.description,
    group: "actions",
    groupLabel: translate("sources.table.actions"),
    keywords: entry.keywords,
    action: entry.action,
  };
}

function downloadResult(entry: SearchDownloadEntry): SearchResult {
  const downloadsLabel = translate("downloads.eyebrow");
  return {
    id: `download:${entry.chapterId}`,
    type: "download",
    title: entry.mangaTitle,
    description: entry.chapterName,
    group: "downloads",
    groupLabel: downloadsLabel,
    breadcrumb: `${downloadsLabel} > ${entry.status}`,
    image: entry.image,
    metadata: { progress: Math.round(entry.progress * 100), status: entry.status },
    action: { kind: "download", chapterId: entry.chapterId },
  };
}

export function createCatalogProvider(catalogOrLoader: SearchCatalog | (() => SearchCatalog)): SearchProvider {
  return {
    id: "catalog",
    contexts: ["home", "library", "settings", "downloads"],
    search: ({ context, librarySection, query }) => {
      const catalog = typeof catalogOrLoader === "function" ? catalogOrLoader() : catalogOrLoader;
      const all: SearchResult[] = [];
      if (context === "home" || (context === "library" && librarySection !== "books")) {
        all.push(...(catalog.libraryManga ?? []).map(mangaResult));
      }
      if (context === "home" || (context === "library" && librarySection !== "comics")) {
        const progressByBookId = new Map(
          (catalog.bookProgress ?? []).map((progress) => [progress.bookId, progress]),
        );
        all.push(...(catalog.books ?? []).map((book) => bookResult(book, progressByBookId.get(book.id))));
        all.push(...(catalog.novels ?? []).map(novelLibraryResult));
      }
      if (context === "home" || context === "library") {
        all.push(...(catalog.collections ?? [])
          .filter((entry) => context === "home" || entry.librarySection === (librarySection ?? "comics"))
          .map((entry) => ({
          id: `collection:${entry.librarySection}:${entry.id}`,
          type: "collection" as const,
          title: entry.title,
          description: entry.description,
          group: "collections",
          groupLabel: translate("ui_collections"),
          action: { kind: "collection" as const, collectionId: entry.id, librarySection: entry.librarySection },
        })));
      }
      if (context === "home" || context === "settings") {
        all.push(...(catalog.settings ?? []).map((entry) => ({
          id: `setting:${entry.id}`,
          type: "setting" as const,
          title: entry.title,
          description: entry.description,
          group: "settings",
          groupLabel: entry.groupLabel,
          breadcrumb: `${translate("shell.navigation.settings")} > ${entry.groupLabel}`,
          keywords: entry.keywords,
          metadata: { value: entry.value },
          action: { kind: "setting" as const, tab: entry.tab, targetId: entry.targetId },
        })));
      }
      if (context === "home" || context === "downloads") all.push(...(catalog.downloads ?? []).map(downloadResult));
      if (context === "home") all.push(...(catalog.pages ?? []).map(catalogResult));
      return rankSearchResults(all, normalizeSearchText(query), context);
    },
  };
}

export function createStaticBrowseProvider(entries: SearchResult[] = []): SearchProvider {
  return {
    id: "browse-static",
    contexts: ["browse", "home"],
    remote: true,
    search: ({ context, query }) => rankSearchResults(entries, query, context),
  };
}

export function createBrowseRemoteProvider(load: BrowseSearchLoader): SearchProvider {
  return {
    id: "browse-remote",
    contexts: ["home", "browse"],
    remote: true,
    search: async ({ context, browseContentType, browseSurface, query, signal }) => {
      if (context === "browse" && (browseContentType === "novels" || browseSurface !== "keyword")) return [];
      const mangas = await load(query, signal);
      return mangas.map(createBrowseResult);
    },
  };
}

export function createBrowseNovelRemoteProvider(load: BrowseNovelSearchLoader): SearchProvider {
  return {
    id: "browse-novels-remote",
    contexts: ["browse"],
    remote: true,
    search: async ({ browseContentType, browseSurface, query, signal }) => {
      if (browseContentType !== "novels" || browseSurface !== "keyword") return [];
      const entries = await load(query, signal);
      return entries.map(createBrowseNovelResult);
    },
  };
}

export function createMangaResult(manga: Manga): SearchResult {
  return mangaResult(manga);
}

export function createBookResult(book: BookEntry): SearchResult {
  return bookResult(book);
}

export function createBrowseResult(manga: Manga): SearchResult {
  const browseLabel = translate("browse.search.resultsTitle");
  return {
    ...mangaResult(manga),
    id: `browse:${manga.id}:${manga.sourceId ?? "unknown"}`,
    type: "browse-item",
    group: "browse",
    groupLabel: browseLabel,
    breadcrumb: manga.source?.displayName ? `${browseLabel} > ${manga.source.displayName}` : browseLabel,
  };
}

export function createBrowseNovelResult({ source, novel }: BrowseNovelSearchEntry): SearchResult {
  const browseLabel = translate("browse.search.resultsTitle");
  return {
    id: `browse-novel:${source.pluginId}:${novel.path}`,
    type: "novel-source",
    title: novel.title,
    description: source.name,
    group: "browse",
    groupLabel: browseLabel,
    breadcrumb: `${browseLabel} > ${source.name}`,
    keywords: [source.name, source.lang],
    image: novel.coverUrl,
    metadata: { source: source.name, status: translate("library.status.unknown"), rating: novel.ratingLabel },
    action: { kind: "novel-source", source, novel },
  };
}
