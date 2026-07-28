import type { Chapter, Manga } from "../../types";
import { getManagedSourceRuntime } from "./managed";
import type {
  SourceChapter,
  SourceItemDetails,
  SourceSearchInput,
  SourceSearchItem,
} from "./types";

export interface SourceMangaSearchVariables {
  source: string;
  type: SourceSearchInput["mode"];
  page: number;
  query?: string | null;
}

function toMangaSource(source: SourceSearchItem["source"]): Manga["source"] {
  if (!source) return null;
  return {
    id: source.id,
    name: source.name,
    lang: source.language,
    displayName: source.displayName,
  };
}

function toManga(item: SourceSearchItem): Manga {
  return {
    id: item.id,
    sourceId: item.sourceId,
    title: item.title,
    thumbnailUrl: item.thumbnailUrl ?? "",
    inLibrary: item.inLibrary,
    status: item.status,
    source: toMangaSource(item.source),
  };
}

function toMangaDetails(item: SourceItemDetails): Manga {
  return {
    ...toManga(item),
    description: item.description,
    author: item.author,
    artist: item.artist,
    genre: [...item.genres],
    realUrl: item.realUrl,
  };
}

function toChapter(item: SourceChapter): Chapter {
  return {
    id: item.id,
    mangaId: item.mangaId,
    name: item.name,
    chapterNumber: item.chapterNumber,
    sourceOrder: item.sourceOrder,
    isRead: item.isRead,
    isDownloaded: item.isDownloaded,
    isBookmarked: item.isBookmarked,
    pageCount: item.pageCount,
    uploadDate: item.uploadDate,
    realUrl: item.realUrl,
    lastPageRead: item.lastPageRead,
    scanlator: item.scanlator,
  };
}

export async function searchSourceManga(
  input: SourceMangaSearchVariables,
  signal?: AbortSignal,
): Promise<{ fetchSourceManga: { mangas: Manga[]; hasNextPage: boolean } }> {
  const runtime = await getManagedSourceRuntime();
  const result = await runtime.search({
    sourceId: input.source,
    mode: input.type,
    page: input.page,
    ...(input.query == null ? {} : { query: input.query }),
    signal,
  });
  return {
    fetchSourceManga: {
      mangas: result.items.map(toManga),
      hasNextPage: result.hasNextPage,
    },
  };
}

export async function fetchSourceMangaDetails(
  input: { id: number; sourceId?: string | null },
  signal?: AbortSignal,
): Promise<{ fetchManga: { manga: Manga } }> {
  const runtime = await getManagedSourceRuntime();
  const manga = await runtime.getDetails(
    { id: input.id, sourceId: input.sourceId ?? "" },
    signal,
  );
  return { fetchManga: { manga: toMangaDetails(manga) } };
}

export async function fetchSourceMangaChapters(
  input: { mangaId: number; sourceId?: string | null },
  signal?: AbortSignal,
): Promise<{ fetchChapters: { chapters: Chapter[] } }> {
  const runtime = await getManagedSourceRuntime();
  const chapters = await runtime.getChapters(
    { id: input.mangaId, sourceId: input.sourceId ?? "" },
    signal,
  );
  return { fetchChapters: { chapters: chapters.map(toChapter) } };
}

export async function fetchSourceChapterPages(
  input: { chapterId: number; mangaId?: number },
  signal?: AbortSignal,
): Promise<{ fetchChapterPages: { pages: string[] } }> {
  const runtime = await getManagedSourceRuntime();
  const pages = await runtime.getPages(
    { id: input.chapterId, mangaId: input.mangaId ?? 0 },
    signal,
  );
  return {
    fetchChapterPages: {
      pages: [...pages]
        .sort((left, right) => left.index - right.index)
        .map((page) => page.url),
    },
  };
}
