import type { Manga, TrackRecord, TrackSearch } from "../types";
import type { BookEntry, BookProgress } from "../books/types";
import type { InstalledNovelSourceDescriptor, NovelSourceSearchResult, PersistedNovelLibraryEntry } from "../novels/domain";
import { normalizeLogCount, normalizeRank, normalizeRecency, normalizeScore } from "./normalization";
import { comicOriginForRecords, comicTypeFromCountry, type ComicOriginsByTrackerEntry } from "./comicOrigin";
import { aniListAlternativeTitles, withAniListGenres, type AniListMediaProfile } from "./anilistMedia";
import { recommendationCandidateIdentityKeys } from "./identity";
import type {
  RecommendationCandidate,
  RecommendationContentType,
  RecommendationProviderSignal,
  RecommendationSafetyLevel,
  TasteProfileSeedItem,
} from "./types";

export interface MangaLibrarySeedOptions {
  trackRecordsByMangaId?: Map<number, TrackRecord[]>;
  /** trackerId -> status value -> tracker status name ("Dropped", "Plan to Read", ...). */
  trackerStatusNamesById?: Map<number, Map<number, string>>;
  comicOrigins?: ComicOriginsByTrackerEntry;
  /** AniList profile per manga id, from its AniList entry or a careful title match. */
  aniListByMangaId?: ReadonlyMap<number, AniListMediaProfile>;
}

export interface MangaCandidateOptions {
  sourceId?: string | number | null;
  sourceName?: string | null;
  nowMs?: number;
  trackRecordsByMangaId?: Map<number, TrackRecord[]>;
  trackerNameById?: Map<number, string>;
  trackerIconById?: Map<number, string>;
  comicOrigins?: ComicOriginsByTrackerEntry;
  aniListByMangaId?: ReadonlyMap<number, AniListMediaProfile>;
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
  const statusRecord = bestRecord ?? records[0];
  const aniList = options.aniListByMangaId?.get(manga.id);

  return {
    id: `manga:${manga.id}`,
    title: manga.title,
    // Many sources list no genres; AniList's fill the gap so the work still shapes the profile.
    tags: withAniListGenres(manga.genre, aniList),
    contentType: comicOriginForRecords(records, options.comicOrigins)
      ?? comicTypeFromCountry(aniList?.country)
      ?? inferMangaContentType(manga),
    sourceId: manga.source?.id ?? null,
    userRating: bestRecord?.score ?? null,
    userRatingMax: inferTrackRecordScoreMax(bestRecord),
    implicitWeight: manga.inLibrary ? inferMangaImplicitWeight(manga) : 0,
    // The publication status ("ONGOING", "COMPLETED") says nothing about the
    // reader; only a tracker record knows whether they dropped or finished it.
    status: statusRecord
      ? trackRecordSeedStatus(
        statusRecord,
        options.trackerStatusNamesById?.get(statusRecord.trackerId)?.get(statusRecord.status),
      )
      : "unknown",
  };
}

export function novelToTasteProfileSeed(novel: PersistedNovelLibraryEntry): TasteProfileSeedItem {
  return {
    id: `novel:${novel.id}`,
    title: novel.title,
    tags: novel.tags,
    contentType: "novel",
    sourceId: novel.source.sourceId ?? novel.source.pluginId,
    implicitWeight: inferNovelImplicitWeight(novel),
    status: "unknown",
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
  const aniList = options.aniListByMangaId?.get(manga.id);
  const tags = withAniListGenres(manga.genre, aniList);
  const alternativeTitles = aniListAlternativeTitles(manga.title, aniList);

  return {
    id: `manga:${manga.id}`,
    title: manga.title,
    ...(alternativeTitles.length > 0 ? { alternativeTitles } : {}),
    coverUrl: manga.thumbnailUrl,
    tags,
    contentType: comicOriginForRecords(records, options.comicOrigins)
      ?? comicTypeFromCountry(aniList?.country)
      ?? inferMangaContentType(manga),
    status: manga.status ?? null,
    inLibrary: manga.inLibrary,
    safety: inferSafetyLevel(tags),
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
  const providerId = novel.source.sourceId ?? novel.source.pluginId ?? "novel-source";
  const providerName = novel.source.sourceName ?? novel.source.pluginName ?? providerId;
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
        providerId,
        providerName,
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
  const records: Array<{
    candidate: RecommendationCandidate;
    identityKeys: Set<string>;
    active: boolean;
  }> = [];
  const identityToRecord = new Map<string, number>();

  for (const candidate of candidates) {
    const incoming = cloneRecommendationCandidate(candidate);
    const matchingRecords = new Set<number>();
    for (const key of recommendationCandidateIdentityKeys(incoming)) {
      const recordIndex = identityToRecord.get(key);
      if (recordIndex !== undefined && records[recordIndex]?.active) {
        matchingRecords.add(recordIndex);
      }
    }

    if (matchingRecords.size === 0) {
      const recordIndex = records.length;
      const identityKeys = new Set(recommendationCandidateIdentityKeys(incoming));
      records.push({ candidate: incoming, identityKeys, active: true });
      for (const key of identityKeys) identityToRecord.set(key, recordIndex);
      continue;
    }

    const targetIndex = Math.min(...matchingRecords);
    let mergedCandidate = records[targetIndex].candidate;
    for (const recordIndex of [...matchingRecords].sort((a, b) => a - b)) {
      if (recordIndex === targetIndex) continue;
      mergedCandidate = mergeCandidateValues(mergedCandidate, records[recordIndex].candidate);
      records[recordIndex].active = false;
    }
    mergedCandidate = mergeCandidateValues(mergedCandidate, incoming);

    // Only the merged records' own keys can point at them; scanning the whole map here made the
    // merge quadratic on large libraries.
    for (const recordIndex of matchingRecords) {
      for (const key of records[recordIndex].identityKeys) {
        const owner = identityToRecord.get(key);
        if (owner !== undefined && matchingRecords.has(owner)) identityToRecord.delete(key);
      }
    }

    const identityKeys = new Set(recommendationCandidateIdentityKeys(mergedCandidate));
    records[targetIndex] = { candidate: mergedCandidate, identityKeys, active: true };
    for (const key of identityKeys) identityToRecord.set(key, targetIndex);
  }

  return records.filter((record) => record.active).map((record) => record.candidate);
}

function cloneRecommendationCandidate(candidate: RecommendationCandidate): RecommendationCandidate {
  return {
    ...candidate,
    tags: [...candidate.tags],
    alternativeTitles: candidate.alternativeTitles ? [...candidate.alternativeTitles] : undefined,
    providers: [...candidate.providers],
  };
}

function mergeCandidateValues(
  existing: RecommendationCandidate,
  candidate: RecommendationCandidate,
): RecommendationCandidate {
  return {
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
  };
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
  const providerKey = (provider: RecommendationProviderSignal) => [
    provider.kind,
    provider.providerId,
    provider.kind === "tracker" ? (provider.remoteId ?? "") : "",
  ].join(":");
  const byId = new Map(current.map((provider) => [providerKey(provider), provider]));
  for (const provider of incoming) {
    const key = providerKey(provider);
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
  return inferMangaRecommendationContentType(manga);
}

const MANHWA_SOURCE_MARKERS = ["asura", "flame", "reaper", "void scans"];
const COMIC_AGGREGATOR_MARKERS = ["mangakakalot", "manganato", "mangadex", "mangalife"];
const MANHWA_MARKER_PATTERN = /\b(manhwa|korean|webtoons?)\b/;
const MANHUA_MARKER_PATTERN = /\b(manhua|chinese)\b/;
const MANHWA_GENRES = new Set(["murim"]);
const MANHUA_GENRES = new Set(["cultivation", "wuxia", "xianxia", "xuanhuan"]);
// Tropes common in Korean web novels/comics, but also used by Japanese isekai.
// They only tip the balance as explicit genre tags and when several co-occur.
const MANHWA_TROPE_GENRES = new Set([
  "regression",
  "necromancer",
  "dungeon",
  "system",
  "level up",
  "hunter",
  "hunters",
  "tower",
  "gate",
  "gates",
  "ranker",
  "player",
  "constellation",
]);

/**
 * Classifies a comic as manga/manhwa/manhua from source, explicit markers and
 * genre tags. Synopsis text is ignored on purpose: words like "system",
 * "player" or "gate" appear in ordinary descriptions and used to mislabel
 * Japanese series as manhwa.
 */
export function inferMangaRecommendationContentType(
  manga: Manga | null | undefined,
  fallbackTitle = "",
): RecommendationContentType {
  const sourceName = (manga?.source?.displayName || manga?.source?.name || "").toLowerCase();
  if (MANHWA_SOURCE_MARKERS.some((marker) => sourceName.includes(marker))) return "manhwa";

  const genres = (manga?.genre ?? []).map((genre) => genre.trim().toLowerCase()).filter(Boolean);
  const markerText = [fallbackTitle, manga?.title ?? "", ...genres].join(" ").toLowerCase();

  if (MANHWA_MARKER_PATTERN.test(markerText)) return "manhwa";
  if (MANHUA_MARKER_PATTERN.test(markerText)) return "manhua";
  if (genres.some((genre) => MANHWA_GENRES.has(genre))) return "manhwa";
  if (genres.some((genre) => MANHUA_GENRES.has(genre))) return "manhua";
  if (genres.filter((genre) => MANHWA_TROPE_GENRES.has(genre)).length >= 2) return "manhwa";

  // Fallback to source language if available and source is not a general aggregator
  const isAggregator = COMIC_AGGREGATOR_MARKERS.some((marker) => sourceName.includes(marker));
  if (!isAggregator) {
    const sourceLangType = inferComicTypeFromLanguage(manga?.source?.lang);
    if (sourceLangType) return sourceLangType;
  }

  return "manga";
}

/**
 * Reading status of a tracker record. Tracker status values differ per
 * service, so the status name (from the tracker's status list) is preferred;
 * progress is only a fallback when the name is unknown.
 */
export function trackRecordSeedStatus(
  record: Pick<TrackRecord, "lastChapterRead" | "totalChapters" | "finishDate">,
  statusName?: string | null,
): TasteProfileSeedItem["status"] {
  const normalizedName = statusName?.trim().toLowerCase() ?? "";
  if (/drop|unfinished|abandon/.test(normalizedName)) return "dropped";
  if (/plan|wish|want/.test(normalizedName)) return "planning";
  if (/complet|finished/.test(normalizedName)) return "completed";
  if (/reading|watching|current|rereading|repeating/.test(normalizedName)) return "reading";

  if (hasTrackRecordDate(record.finishDate)) return "completed";
  if (record.totalChapters > 0 && record.lastChapterRead >= record.totalChapters) return "completed";
  if (record.lastChapterRead > 0) return "reading";
  return "planning";
}

/**
 * Tracker history seeds that add something beyond the library. One tracker entry is often bound to
 * several local copies of the same work (other sources, migration leftovers); counting each copy let
 * that history outweigh the library several times over. Entries already bound to a library work are
 * counted through that work, and every other entry counts once.
 */
export function trackerSeedsOutsideLibrary<T extends TasteProfileSeedItem & { libraryMangaId?: number }>(
  seeds: readonly T[],
  libraryMangaIds: ReadonlySet<number>,
): T[] {
  const libraryEntryIds = new Set(seeds
    .filter((seed) => seed.libraryMangaId !== undefined && libraryMangaIds.has(seed.libraryMangaId))
    .map((seed) => seed.id));
  const seen = new Set<string>();
  return seeds.filter((seed) => {
    if (libraryEntryIds.has(seed.id) || seen.has(seed.id)) return false;
    seen.add(seed.id);
    return true;
  });
}

function hasTrackRecordDate(value: string | null | undefined): boolean {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized === "0") return false;
  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) return numeric > 0;
  return Number.isFinite(Date.parse(normalized));
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
