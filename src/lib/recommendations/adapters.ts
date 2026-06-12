import type { Manga, TrackRecord, TrackSearch } from "../types";
import type { BookEntry, BookProgress } from "../books/types";
import type { InstalledNovelSourceDescriptor, NovelSourceSearchResult, PersistedNovelLibraryEntry } from "../novels/domain";
import { normalizeLogCount, normalizeRank, normalizeRecency, normalizeScore } from "./normalization";
import { recommendationTitleKey } from "./identity";
import type {
  RecommendationCandidate,
  RecommendationContentType,
  RecommendationProviderSignal,
  RecommendationSafetyLevel,
  TasteProfileSeedItem,
} from "./types";

export interface MangaLibrarySeedOptions {
  trackRecordsByMangaId?: Map<number, TrackRecord[]>;
}

export interface MangaCandidateOptions {
  sourceId?: string | number | null;
  sourceName?: string | null;
  nowMs?: number;
  trackRecordsByMangaId?: Map<number, TrackRecord[]>;
  trackerNameById?: Map<number, string>;
  trackerIconById?: Map<number, string>;
}

export interface TrackerCandidateOptions {
  trackerNameById?: Map<number, string>;
  trackerIconById?: Map<number, string>;
}

export interface BookSeedOptions {
  progressByBookId?: Map<string, BookProgress>;
  tagsByBookId?: Map<string, string[]>;
}

export function mangaToTasteProfileSeed(
  manga: Manga,
  options: MangaLibrarySeedOptions = {},
): TasteProfileSeedItem {
  const records = options.trackRecordsByMangaId?.get(manga.id) ?? [];
  const bestRecord = records
    .filter((record) => Number.isFinite(record.score) && record.score > 0)
    .sort((a, b) => b.score - a.score)[0];

  return {
    id: `manga:${manga.id}`,
    title: manga.title,
    tags: manga.genre ?? [],
    contentType: inferMangaContentType(manga),
    sourceId: manga.source?.id ?? null,
    userRating: bestRecord?.score ?? null,
    userRatingMax: inferTrackRecordScoreMax(bestRecord),
    implicitWeight: manga.inLibrary ? inferMangaImplicitWeight(manga) : 0,
    status: mapMangaStatusToSeedStatus(manga.status),
  };
}

export function novelToTasteProfileSeed(novel: PersistedNovelLibraryEntry): TasteProfileSeedItem {
  return {
    id: `novel:${novel.id}`,
    title: novel.title,
    tags: novel.tags,
    contentType: "novel",
    sourceId: novel.source.id,
    implicitWeight: inferNovelImplicitWeight(novel),
    status: mapMangaStatusToSeedStatus(novel.status),
  };
}

export function bookToTasteProfileSeed(
  book: BookEntry,
  options: BookSeedOptions = {},
): TasteProfileSeedItem {
  const progress = options.progressByBookId?.get(book.id);
  return {
    id: `book:${book.id}`,
    title: book.title,
    tags: bookToRecommendationTags(book, options.tagsByBookId?.get(book.id)),
    contentType: "book",
    sourceId: book.subtype,
    implicitWeight: inferBookImplicitWeight(book, progress),
    status: progress && progress.progressPercent >= 0.98 ? "completed" : progress ? "reading" : "planning",
  };
}

export function mangaToRecommendationCandidate(
  manga: Manga,
  options: MangaCandidateOptions = {},
): RecommendationCandidate {
  const sourceId = String(options.sourceId ?? manga.source?.id ?? "source");
  const sourceName = options.sourceName ?? manga.source?.displayName ?? manga.source?.name ?? "Source";
  const records = options.trackRecordsByMangaId?.get(manga.id) ?? [];

  return {
    id: `manga:${manga.id}`,
    title: manga.title,
    coverUrl: manga.thumbnailUrl,
    tags: manga.genre ?? [],
    contentType: inferMangaContentType(manga),
    status: manga.status ?? null,
    inLibrary: manga.inLibrary,
    safety: inferSafetyLevel(manga.genre ?? []),
    updatedAtMs: null,
    providers: [
      {
        providerId: sourceId,
        providerName: sourceName,
        kind: "source",
        availability: normalizeScore(1, 1, 0.75),
      },
      ...records.map((record) => trackRecordToProviderSignal(record, options)),
    ],
  };
}

export function novelToRecommendationCandidate(novel: PersistedNovelLibraryEntry): RecommendationCandidate {
  return {
    id: `novel:${novel.id}`,
    title: novel.title,
    coverUrl: novel.coverUrl,
    tags: novel.tags,
    contentType: "novel",
    status: novel.status,
    inLibrary: true,
    safety: inferSafetyLevel(novel.tags),
    updatedAtMs: novel.updatedAt,
    providers: [
      {
        providerId: novel.source.id,
        providerName: novel.source.name,
        kind: "source",
        availability: normalizeScore(1, 1, 0.75),
        recency: normalizeRecency(novel.updatedAt, undefined, 21, 0.55),
      },
    ],
  };
}

export function novelSourceResultToRecommendationCandidate(
  result: NovelSourceSearchResult,
  source: InstalledNovelSourceDescriptor | undefined,
): RecommendationCandidate {
  const providerId = source?.pluginId ?? result.sourceId;
  const providerName = source?.name ?? result.sourceId;
  const ratingMax = result.ratingMax && result.ratingMax > 0 ? result.ratingMax : null;
  const sourceScore = ratingMax
    ? normalizeScore(result.rating ?? null, ratingMax, 0.72)
    : undefined;
  return {
    id: `novel-source:${result.sourceId}:${encodeURIComponent(result.path)}`,
    title: result.title,
    coverUrl: result.coverUrl,
    tags: ["novel", "webnovel", source?.lang ?? ""].filter(Boolean),
    contentType: "novel",
    status: null,
    inLibrary: false,
    safety: "safe",
    providers: [
      {
        providerId,
        providerName,
        kind: "source",
        availability: normalizeScore(1, 1, 0.82),
        score: sourceScore,
        popularity: sourceScore ?? { value: 0.58, confidence: 0.36, method: "novel-source-result" },
        trending: { value: 0.22, confidence: 0.28, method: "novel-source-result" },
        recency: { value: 0.24, confidence: 0.3, method: "novel-source-result" },
      },
    ],
  };
}

export function bookToRecommendationCandidate(book: BookEntry): RecommendationCandidate {
  return {
    id: `book:${book.id}`,
    title: book.title,
    coverUrl: book.coverPath,
    tags: bookToRecommendationTags(book),
    contentType: "book",
    status: book.subtype,
    inLibrary: true,
    safety: "safe",
    updatedAtMs: book.updatedAt,
    publishedAtMs: book.createdAt,
    providers: [
      {
        providerId: `local-${book.subtype}`,
        providerName: `${book.subtype.toUpperCase()} library`,
        kind: "source",
        availability: normalizeScore(1, 1, 0.8),
        recency: normalizeRecency(book.updatedAt, undefined, 45, 0.35),
      },
    ],
  };
}

export function trackerSearchToRecommendationCandidate(
  result: TrackSearch,
  options: TrackerCandidateOptions = {},
): RecommendationCandidate {
  const trackerId = String(result.trackerId);
  const trackerName = options.trackerNameById?.get(result.trackerId) ?? `Tracker ${trackerId}`;
  const iconKey = options.trackerIconById?.get(result.trackerId) ?? inferTrackerIconKey(trackerName);

  return {
    id: `tracker:${trackerId}:${result.remoteId}`,
    title: result.title,
    coverUrl: result.coverUrl,
    tags: inferTagsFromTrackerSearch(result),
    contentType: inferTrackerContentType(result),
    status: result.publishingStatus,
    providers: [
      {
        providerId: trackerId,
        providerName: trackerName,
        kind: "tracker",
        remoteId: result.remoteId,
        iconKey,
        score: normalizeScore(result.score ?? null, result.scoreMax ?? 100, result.score == null ? 0 : 0.78),
        popularity: normalizeLogCount(result.popularity ?? null, 1_000_000, 0.62),
        trending: normalizeLogCount(result.trending ?? null, 500_000, 0.68),
        recency: normalizeRecency(result.startDate, undefined, 365, 0.35),
      },
    ],
  };
}

function trackRecordToProviderSignal(
  record: TrackRecord,
  options: MangaCandidateOptions,
): RecommendationProviderSignal {
  const providerName = options.trackerNameById?.get(record.trackerId) ?? `Tracker ${record.trackerId}`;
  const iconKey = options.trackerIconById?.get(record.trackerId) ?? inferTrackerIconKey(providerName);
  const scoreMax = inferTrackRecordScoreMax(record) ?? 10;
  return {
    providerId: String(record.trackerId),
    providerName,
    kind: "tracker",
    remoteId: record.remoteId,
    iconKey,
    score: normalizeScore(record.score, scoreMax, 0.9),
    recency: normalizeRecency(record.finishDate ?? record.startDate, options.nowMs, 365, 0.35),
  };
}

export function mergeRecommendationCandidates(
  candidates: RecommendationCandidate[],
): RecommendationCandidate[] {
  const merged = new Map<string, RecommendationCandidate>();
  for (const candidate of candidates) {
    const key = canonicalCandidateKey(candidate);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, cloneRecommendationCandidate(candidate));
      continue;
    }

    merged.set(key, {
      ...existing,
      providers: mergeProviders(existing.providers, candidate.providers),
      tags: [...new Set([...existing.tags, ...candidate.tags])],
      inLibrary: existing.inLibrary || candidate.inLibrary,
      coverUrl: chooseCoverUrl(existing.coverUrl, candidate.coverUrl),
      alternativeTitles: mergeAlternativeTitles(existing, candidate),
      contentType: chooseContentType(existing, candidate),
      status: existing.status || candidate.status,
      updatedAtMs: Math.max(existing.updatedAtMs ?? 0, candidate.updatedAtMs ?? 0) || existing.updatedAtMs,
      publishedAtMs: existing.publishedAtMs ?? candidate.publishedAtMs,
    });
  }

  return [...merged.values()];
}

function cloneRecommendationCandidate(candidate: RecommendationCandidate): RecommendationCandidate {
  return {
    ...candidate,
    tags: [...candidate.tags],
    alternativeTitles: candidate.alternativeTitles ? [...candidate.alternativeTitles] : undefined,
    providers: [...candidate.providers],
  };
}

function canonicalCandidateKey(candidate: RecommendationCandidate): string {
  return recommendationTitleKey(candidate.title, candidate.contentType);
}

function chooseCoverUrl(current: string | null | undefined, incoming: string | null | undefined): string | null | undefined {
  if (current?.trim()) return current;
  if (incoming?.trim()) return incoming;
  return current ?? incoming;
}

function chooseContentType(
  existing: RecommendationCandidate,
  candidate: RecommendationCandidate,
): RecommendationContentType {
  if (existing.contentType === candidate.contentType) return existing.contentType;
  const existingComic = isComicContentType(existing.contentType);
  const incomingComic = isComicContentType(candidate.contentType);
  if (existingComic && incomingComic) {
    if (existing.contentType === "manga" && candidate.contentType !== "manga") return candidate.contentType;
    return existing.contentType;
  }
  if (existing.contentType === "book" && candidate.contentType === "novel") return candidate.contentType;
  return existing.contentType;
}

function isComicContentType(contentType: RecommendationContentType): boolean {
  return contentType === "manga" || contentType === "manhwa" || contentType === "manhua";
}

function mergeAlternativeTitles(
  existing: RecommendationCandidate,
  candidate: RecommendationCandidate,
): string[] | undefined {
  const titles = [
    ...(existing.alternativeTitles ?? []),
    ...(candidate.alternativeTitles ?? []),
    existing.title,
    candidate.title,
  ].map((title) => title.trim()).filter(Boolean);
  const unique = [...new Set(titles)].filter((title) => title !== existing.title);
  return unique.length > 0 ? unique : undefined;
}

function mergeProviders(
  current: RecommendationProviderSignal[],
  incoming: RecommendationProviderSignal[],
): RecommendationProviderSignal[] {
  const byId = new Map(current.map((provider) => [`${provider.kind}:${provider.providerId}`, provider]));
  for (const provider of incoming) {
    const key = `${provider.kind}:${provider.providerId}`;
    const existing = byId.get(key);
    byId.set(key, existing ? mergeProviderSignal(existing, provider) : provider);
  }
  return [...byId.values()];
}

function mergeProviderSignal(
  existing: RecommendationProviderSignal,
  incoming: RecommendationProviderSignal,
): RecommendationProviderSignal {
  return {
    ...existing,
    ...incoming,
    remoteId: existing.remoteId ?? incoming.remoteId,
    iconKey: existing.iconKey ?? incoming.iconKey,
    score: strongestMetric(existing.score, incoming.score),
    popularity: strongestMetric(existing.popularity, incoming.popularity),
    trending: strongestMetric(existing.trending, incoming.trending),
    recency: strongestMetric(existing.recency, incoming.recency),
    availability: strongestMetric(existing.availability, incoming.availability),
    activity: strongestMetric(existing.activity, incoming.activity),
  };
}

function strongestMetric<T extends RecommendationProviderSignal["score"]>(current: T, incoming: T): T {
  if (!current) return incoming;
  if (!incoming) return current;
  const currentPower = current.value * current.confidence;
  const incomingPower = incoming.value * incoming.confidence;
  return incomingPower > currentPower ? incoming : current;
}

function inferMangaContentType(manga: Manga): RecommendationContentType {
  const sourceName = (manga.source?.displayName || manga.source?.name || "").toLowerCase();
  const haystack = [
    manga.title,
    manga.description ?? "",
    ...(manga.genre ?? []),
  ].join(" ").toLowerCase();

  // Dedicated manhwa/manhua sources
  if (
    sourceName.includes("asura")
    || sourceName.includes("flame")
    || sourceName.includes("reaper")
    || sourceName.includes("void scans")
  ) {
    return "manhwa";
  }

  // Work properties classification
  if (
    haystack.includes("manhwa")
    || haystack.includes("korean")
    || haystack.includes("webtoon")
    || haystack.includes("regression")
    || haystack.includes("murim")
    || haystack.includes("necromancer")
    || haystack.includes("dungeon")
    || haystack.includes("system")
    || haystack.includes("level up")
    || haystack.includes("hunter")
    || haystack.includes("tower")
    || haystack.includes("gate")
    || haystack.includes("ranker")
    || haystack.includes("player")
    || haystack.includes("constellation")
  ) return "manhwa";

  if (
    haystack.includes("manhua")
    || haystack.includes("chinese")
    || haystack.includes("cultivation")
    || haystack.includes("wuxia")
    || haystack.includes("xianxia")
    || haystack.includes("xuanhuan")
  ) return "manhua";

  // Fallback to source language if available and source is not a general aggregator
  const isAggregator = sourceName.includes("mangakakalot")
    || sourceName.includes("manganato")
    || sourceName.includes("mangadex")
    || sourceName.includes("mangalife");
  if (!isAggregator) {
    const sourceLangType = inferComicTypeFromLanguage(manga.source?.lang);
    if (sourceLangType) return sourceLangType;
  }

  return "manga";
}

function inferComicTypeFromLanguage(language: string | null | undefined): RecommendationContentType | null {
  const normalized = language?.trim().toLowerCase().replace("_", "-") ?? "";
  if (!normalized) return null;
  if (normalized === "kr" || normalized === "ko" || normalized.startsWith("ko-") || normalized.includes("korean")) {
    return "manhwa";
  }
  if (
    normalized === "cn"
    || normalized === "zh"
    || normalized.startsWith("zh-")
    || normalized.includes("chinese")
  ) {
    return "manhua";
  }
  if (normalized === "jp" || normalized === "ja" || normalized.startsWith("ja-") || normalized.includes("japanese")) {
    return "manga";
  }
  return null;
}

function inferTrackerContentType(result: TrackSearch): RecommendationContentType {
  const type = result.publishingType?.toLowerCase() ?? "";
  const title = result.title.toLowerCase();
  if (type.includes("manhwa") || title.includes("manhwa")) return "manhwa";
  if (type.includes("manhua") || title.includes("manhua")) return "manhua";
  if (type.includes("novel")) return "novel";
  return "manga";
}

function inferTagsFromTrackerSearch(result: TrackSearch): string[] {
  const tags = [...(result.genres ?? []), result.publishingType, result.publishingStatus]
    .filter((value): value is string => Boolean(value?.trim()));
  return [...new Set(tags)];
}

function inferMangaImplicitWeight(manga: Manga): number {
  if ((manga.unreadCount ?? 0) > 0) return 0.55;
  if ((manga.downloadCount ?? 0) > 0) return 0.65;
  return 0.4;
}

function inferNovelImplicitWeight(novel: PersistedNovelLibraryEntry): number {
  if (novel.chapterCount > 30) return 0.55;
  return 0.4;
}

function inferBookImplicitWeight(book: BookEntry, progress: BookProgress | undefined): number {
  if (!progress) return 0.3;
  if (progress.progressPercent >= 0.98) return 0.75;
  if (progress.progressPercent >= 0.25) return 0.6;
  return 0.45;
}

function bookToRecommendationTags(book: BookEntry, explicitTags: string[] = []): string[] {
  const tags = explicitTags.length > 0 ? explicitTags : [];
  return [...new Set([...tags, "book", book.subtype])];
}

function inferTrackRecordScoreMax(record: TrackRecord | undefined): number | null {
  if (!record) return null;
  if (record.score > 10) return 100;
  return 10;
}

function mapMangaStatusToSeedStatus(status: string | null | undefined): TasteProfileSeedItem["status"] {
  const normalized = status?.toLowerCase() ?? "";
  if (normalized.includes("complete") || normalized.includes("finished")) return "completed";
  if (normalized.includes("drop")) return "dropped";
  if (normalized.includes("plan")) return "planning";
  if (normalized.includes("read") || normalized.includes("ongoing")) return "reading";
  return "unknown";
}

function inferSafetyLevel(tags: string[]): RecommendationSafetyLevel {
  const normalized = tags.map((tag) => tag.toLowerCase());
  if (normalized.some((tag) => tag.includes("hentai") || tag.includes("porn"))) return "explicit";
  if (normalized.some((tag) => tag.includes("adult") || tag.includes("mature"))) return "adult";
  if (normalized.some((tag) => tag.includes("suggestive") || tag.includes("ecchi"))) return "suggestive";
  return "safe";
}

function inferTrackerIconKey(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes("anilist")) return "anilist";
  if (normalized.includes("myanimelist") || normalized === "mal") return "myanimelist";
  if (normalized.includes("kitsu")) return "kitsu";
  if (normalized.includes("bangumi")) return "bangumi";
  if (normalized.includes("mangaupdates")) return "mangaupdates";
  if (normalized.includes("hardcover")) return "hardcover";
  return "tracker";
}
