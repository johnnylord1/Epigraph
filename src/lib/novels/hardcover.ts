import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { DEFAULT_LOCAL_PROFILE_ID, normalizeLocalProfileId, normalizeServerUrl } from "../localProfiles";
import { recommendationTitleKey } from "../recommendations";
import type { RecommendationCandidate, RecommendationProviderSignal, TasteProfileSeedItem } from "../recommendations";
import { normalizeScore } from "../recommendations/normalization";
import type { NovelRepositoryScopeInput } from "./repositoryState";

const HARDCOVER_GRAPHQL_URL = "https://api.hardcover.app/v1/graphql";
const HARDCOVER_STATE_VERSION = 1;
const HARDCOVER_STORAGE_KEY = "aethon-hardcover-tracking-state";
const HARDCOVER_RATING_MAX = 5;
const OPEN_LIBRARY_SEARCH_URL = "https://openlibrary.org/search.json";
const OPEN_LIBRARY_COVER_TIMEOUT_MS = 2500;
const HARDCOVER_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;

const openLibraryCoverCache = new Map<string, string | null>();
const hardcoverRateLimitUntilByToken = new Map<string, number>();

class HardcoverRateLimitError extends Error {
  constructor(message: string, readonly retryAtMs: number) {
    super(message);
    this.name = "HardcoverRateLimitError";
  }
}

function readBrowserStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeBrowserStorage(key: string, value: string): boolean {
  try {
    globalThis.localStorage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function notifyHardcoverStateChanged(scopeKey: string): void {
  try {
    globalThis.dispatchEvent?.(new CustomEvent("aethon-hardcover-state-changed", { detail: { scopeKey } }));
  } catch {}
}

export interface HardcoverAuthState {
  connected: boolean;
  token: string | null;
  username: string | null;
  userId: number | null;
  connectedAtMs: number | null;
  lastValidatedAtMs: number | null;
  lastError: string | null;
}

export interface HardcoverBookSearchResult {
  id: number;
  title: string;
  authors: string[];
  genres: string[];
  tags: string[];
  moods: string[];
  coverUrl: string | null;
  description: string | null;
  releaseYear: number | null;
  rating: number | null;
  ratingsCount: number | null;
  slug: string | null;
  url: string | null;
  workStatus: string | null;
}

export interface HardcoverNovelTrackRecord {
  bookId: number;
  title: string;
  authors: string[];
  genres: string[];
  tags: string[];
  moods: string[];
  coverUrl: string | null;
  status: string | null;
  workStatus: string | null;
  rating: number | null;
  progress: number | null;
  remoteUrl: string | null;
  updatedAt: number;
  sourceNovelId?: string | null;
  sourceTitleKey?: string | null;
}

export interface HardcoverTrackingState {
  version: number;
  scopeKey: string;
  auth: HardcoverAuthState;
  records: HardcoverNovelTrackRecord[];
  searchCache: Record<string, HardcoverBookSearchResult[]>;
  updatedAtMs: number | null;
}

interface HardcoverGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface RawHardcoverBook {
  id?: unknown;
  title?: unknown;
  subtitle?: unknown;
  slug?: unknown;
  cached_image_url?: unknown;
  cached_image?: unknown;
  image_url?: unknown;
  image?: unknown;
  cover_url?: unknown;
  cover?: unknown;
  assets?: unknown;
  isbns?: unknown;
  default_cover_edition?: {
    cached_image?: unknown;
    image?: unknown;
    isbn_10?: unknown;
    isbn_13?: unknown;
  } | null;
  author_names?: unknown;
  authors?: unknown;
  cached_contributors?: unknown;
  genres?: unknown;
  tags?: unknown;
  moods?: unknown;
  description?: unknown;
  description_html?: unknown;
  release_year?: unknown;
  publication_year?: unknown;
  pages?: unknown;
  rating?: unknown;
  average_rating?: unknown;
  ratings_count?: unknown;
  contributions?: Array<{
    author?: {
      name?: unknown;
    } | null;
  }> | null;
  book_authors?: Array<{
    author?: {
      name?: unknown;
    } | null;
  }> | null;
  book_status_id?: unknown;
  book_status?: {
    name?: unknown;
  } | null;
}

export interface HardcoverBookSearchOptions {
  fields?: string;
  weights?: string;
  sort?: string;
  cacheGroup?: string;
}

interface RawHardcoverUserBook {
  id?: unknown;
  status_id?: unknown;
  rating?: unknown;
  current_position?: unknown;
  updated_at?: unknown;
  book?: RawHardcoverBook | null;
  user_book_status?: {
    status?: unknown;
  } | null;
}

const emptyAuth = (): HardcoverAuthState => ({
  connected: false,
  token: null,
  username: null,
  userId: null,
  connectedAtMs: null,
  lastValidatedAtMs: null,
  lastError: null,
});

export function hardcoverScopeKey(scopeInput: NovelRepositoryScopeInput = {}): string {
  const profileId = normalizeLocalProfileId(scopeInput.profileId) ?? DEFAULT_LOCAL_PROFILE_ID;
  const serverUrl = normalizeServerUrl(scopeInput.serverUrl) ?? "";
  return `${profileId}:${serverUrl || "local"}`;
}

export function createEmptyHardcoverState(scopeInput: NovelRepositoryScopeInput = {}): HardcoverTrackingState {
  return {
    version: HARDCOVER_STATE_VERSION,
    scopeKey: hardcoverScopeKey(scopeInput),
    auth: emptyAuth(),
    records: [],
    searchCache: {},
    updatedAtMs: null,
  };
}

export function loadHardcoverState(scopeInput: NovelRepositoryScopeInput = {}): HardcoverTrackingState {
  const scopeKey = hardcoverScopeKey(scopeInput);
  const raw = readBrowserStorage(HARDCOVER_STORAGE_KEY);
  if (!raw) return createEmptyHardcoverState(scopeInput);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const stateByScope = parsed.scopes && typeof parsed.scopes === "object"
      ? parsed.scopes as Record<string, unknown>
      : {};
    return normalizeHardcoverState(stateByScope[scopeKey], scopeInput);
  } catch {
    return createEmptyHardcoverState(scopeInput);
  }
}

export function saveHardcoverState(
  state: HardcoverTrackingState,
  scopeInput: NovelRepositoryScopeInput = {},
): HardcoverTrackingState {
  const normalized = normalizeHardcoverState({
    ...state,
    scopeKey: hardcoverScopeKey(scopeInput),
    updatedAtMs: Date.now(),
  }, scopeInput);

  let parsed: { scopes: Record<string, unknown> } = { scopes: {} };
  const raw = readBrowserStorage(HARDCOVER_STORAGE_KEY);
  if (raw) {
    try {
      const existing = JSON.parse(raw) as Record<string, unknown>;
      parsed = {
        scopes: existing.scopes && typeof existing.scopes === "object"
          ? existing.scopes as Record<string, unknown>
          : {},
      };
    } catch {}
  }
  parsed.scopes[normalized.scopeKey] = normalized;
  writeBrowserStorage(HARDCOVER_STORAGE_KEY, JSON.stringify(parsed));
  notifyHardcoverStateChanged(normalized.scopeKey);
  return normalized;
}

export async function connectHardcover(
  scopeInput: NovelRepositoryScopeInput,
  token: string,
): Promise<HardcoverTrackingState> {
  const trimmed = normalizeHardcoverAuthToken(token);
  if (!trimmed) throw new Error("Hardcover API token is required.");
  const profile = await validateHardcoverToken(trimmed);
  const state = loadHardcoverState(scopeInput);
  return saveHardcoverState({
    ...state,
    auth: {
      connected: true,
      token: trimmed,
      userId: profile.userId,
      username: profile.username,
      connectedAtMs: state.auth.connectedAtMs ?? Date.now(),
      lastValidatedAtMs: Date.now(),
      lastError: null,
    },
  }, scopeInput);
}

export function disconnectHardcover(scopeInput: NovelRepositoryScopeInput): HardcoverTrackingState {
  const state = loadHardcoverState(scopeInput);
  return saveHardcoverState({
    ...state,
    auth: emptyAuth(),
    records: [],
    searchCache: {},
  }, scopeInput);
}

export function getHardcoverRateLimitRemainingMs(scopeInput: NovelRepositoryScopeInput): number {
  const token = loadHardcoverState(scopeInput).auth.token;
  if (!token) return 0;
  const throttleUntil = hardcoverRateLimitUntilByToken.get(hardcoverThrottleKey(token)) ?? 0;
  return Math.max(0, throttleUntil - Date.now());
}

export function isHardcoverRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error instanceof HardcoverRateLimitError || /http 429|throttled|rate limit/i.test(error.message);
}

export async function validateHardcoverToken(token: string): Promise<{ userId: number | null; username: string | null }> {
  const normalizedToken = normalizeHardcoverAuthToken(token);
  const data = await hardcoverGraphql<{
    me?: { id?: unknown; username?: unknown } | Array<{ id?: unknown; username?: unknown }>;
  }>(normalizedToken, `
    query AethonHardcoverMe {
      me {
        id
        username
      }
    }
  `);
  const me = Array.isArray(data.me) ? data.me[0] : data.me ?? null;
  return {
    userId: coerceNumber(me?.id),
    username: normalizeText(me?.username),
  };
}

export async function searchHardcoverBooks(
  scopeInput: NovelRepositoryScopeInput,
  query: string,
  limit = 8,
  page = 1,
  options: HardcoverBookSearchOptions = {},
): Promise<HardcoverBookSearchResult[]> {
  const state = loadHardcoverState(scopeInput);
  const token = state.auth.token;
  if (!state.auth.connected || !token) return [];

  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const normalizedPage = Math.max(1, Math.floor(page));
  const normalizedFields = normalizeText(options.fields);
  const normalizedWeights = normalizeText(options.weights);
  const normalizedSort = normalizeText(options.sort);
  const cacheGroup = normalizeText(options.cacheGroup) ?? "default";
  const cacheKey = [
    "v11",
    cacheGroup,
    normalizedQuery.toLowerCase(),
    limit,
    normalizedPage,
    normalizedFields ?? "",
    normalizedWeights ?? "",
    normalizedSort ?? "",
  ].join(":");
  const cached = state.searchCache[cacheKey];
  if (cached) return cached;

  const data = await hardcoverGraphql<{
    search?: {
      results?: {
        hits?: Array<{ document?: RawHardcoverBook | null }>;
      };
    };
    books?: RawHardcoverBook[];
  }>(normalizeHardcoverAuthToken(token), `
    query AethonHardcoverSearch(
      $query: String!
      $limit: Int!
      $page: Int!
      $fields: String
      $weights: String
      $sort: String
    ) {
      search(
        query: $query
        query_type: "Book"
        per_page: $limit
        page: $page
        fields: $fields
        weights: $weights
        sort: $sort
      ) {
        results
      }
    }
  `, {
    query: normalizedQuery,
    limit,
    page: normalizedPage,
    fields: normalizedFields,
    weights: normalizedWeights,
    sort: normalizedSort,
  });

  const rawBooks = data.books
    ?? data.search?.results?.hits?.map((hit) => hit.document).filter((entry): entry is RawHardcoverBook => Boolean(entry))
    ?? [];
  const books = rawBooks
    .map(normalizeHardcoverBook)
    .filter((book): book is HardcoverBookSearchResult => Boolean(book))
    .slice(0, limit);
  const enrichedBooks = await enrichHardcoverBookResults(normalizeHardcoverAuthToken(token), books);

  saveHardcoverState({
    ...state,
    searchCache: {
      ...state.searchCache,
      [cacheKey]: enrichedBooks,
    },
  }, scopeInput);

  return enrichedBooks;
}

export async function getHardcoverUserBooks(
  scopeInput: NovelRepositoryScopeInput,
): Promise<HardcoverNovelTrackRecord[]> {
  const state = loadHardcoverState(scopeInput);
  const token = state.auth.token;
  if (!state.auth.connected || !token) return state.records;
  const normalizedToken = normalizeHardcoverAuthToken(token);
  const userId = state.auth.userId ?? (await validateHardcoverToken(normalizedToken)).userId;
  if (!userId) return state.records;

  const data = await hardcoverGraphql<{
    user_books?: RawHardcoverUserBook[];
  }>(normalizedToken, `
    query AethonHardcoverUserBooks($userId: Int!) {
      user_books(
        where: { user_id: { _eq: $userId } }
        distinct_on: book_id
        limit: 250
        order_by: [{ book_id: asc }, { updated_at: desc }]
      ) {
        id
        status_id
        rating
        updated_at
        user_book_status { status }
        book {
          id
          title
          slug
          cached_image
          rating
          ratings_count
          book_status_id
          book_status { name }
          contributions { author { name } }
        }
      }
    }
  `, { userId });
  const records = (data.user_books ?? [])
    .map(normalizeHardcoverUserBook)
    .filter((record): record is HardcoverNovelTrackRecord => Boolean(record));
  const mergedRecords = mergeHardcoverTrackRecords(state.records, records);
  const enrichedRecords = await enrichHardcoverTrackRecords(normalizedToken, mergedRecords);
  return saveHardcoverState({ ...state, records: enrichedRecords }, scopeInput).records;
}

export async function upsertHardcoverUserBook(
  scopeInput: NovelRepositoryScopeInput,
  input: {
    book: HardcoverBookSearchResult;
    sourceNovelId?: string | null;
    status?: string | null;
    rating?: number | null;
    progress?: number | null;
  },
): Promise<HardcoverNovelTrackRecord> {
  const state = loadHardcoverState(scopeInput);
  const token = state.auth.token;
  if (!state.auth.connected || !token) throw new Error("Connect Hardcover in Settings first.");

  const now = Date.now();
  const localRecord: HardcoverNovelTrackRecord = {
    bookId: input.book.id,
    title: input.book.title,
    authors: input.book.authors,
    genres: input.book.genres,
    tags: input.book.tags,
    moods: input.book.moods,
    coverUrl: input.book.coverUrl,
    status: input.status ?? "Want to Read",
    workStatus: input.book.workStatus,
    rating: input.rating ?? input.book.rating,
    progress: input.progress ?? null,
    remoteUrl: input.book.url,
    updatedAt: now,
    sourceNovelId: input.sourceNovelId ?? null,
    sourceTitleKey: recommendationTitleKey(input.book.title, "novel"),
  };

  await tryWriteHardcoverUserBook(normalizeHardcoverAuthToken(token), localRecord).catch((error) => {
    console.warn("Hardcover write failed; keeping local tracking record.", error);
  });

  const records = [
    localRecord,
    ...state.records.filter((record) => record.bookId !== localRecord.bookId && record.sourceNovelId !== localRecord.sourceNovelId),
  ];
  return saveHardcoverState({ ...state, records }, scopeInput).records[0];
}

export function unlinkHardcoverRecord(
  scopeInput: NovelRepositoryScopeInput,
  sourceNovelId: string | null | undefined,
  bookId: number | null | undefined,
): HardcoverTrackingState {
  const state = loadHardcoverState(scopeInput);
  return saveHardcoverState({
    ...state,
    records: state.records.filter((record) =>
      (sourceNovelId ? record.sourceNovelId !== sourceNovelId : true)
      && (bookId ? record.bookId !== bookId : true),
    ),
  }, scopeInput);
}

export function findHardcoverRecordForNovel(
  records: HardcoverNovelTrackRecord[],
  input: { novelId?: string | null; title?: string | null },
): HardcoverNovelTrackRecord | null {
  if (input.novelId) {
    const exact = records.find((record) => record.sourceNovelId === input.novelId);
    if (exact) return exact;
  }
  const titleKey = input.title ? recommendationTitleKey(input.title, "novel") : null;
  if (!titleKey) return null;
  return records.find((record) => record.sourceTitleKey === titleKey || recommendationTitleKey(record.title, "novel") === titleKey) ?? null;
}

export function mergeHardcoverTrackRecords(
  existingRecords: readonly HardcoverNovelTrackRecord[],
  remoteRecords: readonly HardcoverNovelTrackRecord[],
): HardcoverNovelTrackRecord[] {
  const existingByBookId = new Map(existingRecords.map((record) => [record.bookId, record]));
  const remoteBookIds = new Set<number>();
  const merged = remoteRecords.map((remote) => {
    remoteBookIds.add(remote.bookId);
    const existing = existingByBookId.get(remote.bookId);
    if (!existing) return remote;
    return {
      ...remote,
      genres: remote.genres.length ? remote.genres : existing.genres,
      tags: remote.tags.length ? remote.tags : existing.tags,
      moods: remote.moods.length ? remote.moods : existing.moods,
      coverUrl: remote.coverUrl ?? existing.coverUrl,
      workStatus: remote.workStatus ?? existing.workStatus,
      sourceNovelId: existing.sourceNovelId ?? remote.sourceNovelId ?? null,
      sourceTitleKey: existing.sourceTitleKey ?? remote.sourceTitleKey ?? recommendationTitleKey(remote.title, "novel"),
    };
  });

  const linkedLocalOnly = existingRecords.filter((record) => record.sourceNovelId && !remoteBookIds.has(record.bookId));
  return [...merged, ...linkedLocalOnly];
}

export function matchHardcoverBook(
  title: string,
  results: HardcoverBookSearchResult[],
): HardcoverBookSearchResult | null {
  const target = tokenizeTitle(title);
  if (target.length === 0) return null;
  let best: { book: HardcoverBookSearchResult; score: number } | null = null;
  for (const book of results) {
    const score = titleSimilarity(target, tokenizeTitle(book.title));
    if (!best || score > best.score) best = { book, score };
  }
  return best && best.score >= 0.72 ? best.book : null;
}

export function hardcoverRecordToRecommendationCandidate(record: HardcoverNovelTrackRecord): RecommendationCandidate {
  return {
    id: `hardcover:${record.bookId}`,
    title: record.title,
    coverUrl: record.coverUrl,
    tags: mergeStringLists(["novel", "book", "hardcover"], record.genres, record.tags, record.moods),
    contentType: "novel",
    status: record.status,
    inLibrary: true,
    safety: "safe",
    updatedAtMs: record.updatedAt,
    providers: [hardcoverRecordToProvider(record)],
  };
}

export function hardcoverRecordToTasteProfileSeed(record: HardcoverNovelTrackRecord): TasteProfileSeedItem {
  return {
    id: `hardcover:${record.bookId}`,
    title: record.title,
    tags: mergeStringLists(["novel", "book"], record.genres, record.tags, record.moods),
    contentType: "novel",
    sourceId: "hardcover",
    userRating: record.rating,
    userRatingMax: HARDCOVER_RATING_MAX,
    implicitWeight: record.rating ? null : 0.45,
    status: mapHardcoverStatusToSeedStatus(record.status),
  };
}

export function hardcoverBookToProvider(book: HardcoverBookSearchResult): RecommendationProviderSignal {
  return {
    providerId: "hardcover",
    providerName: "Hardcover",
    kind: "tracker",
    remoteId: String(book.id),
    iconKey: "HC",
    score: normalizeScore(book.rating ?? null, HARDCOVER_RATING_MAX, book.rating == null ? 0 : 0.84),
  };
}

function hardcoverRecordToProvider(record: HardcoverNovelTrackRecord): RecommendationProviderSignal {
  return {
    providerId: "hardcover",
    providerName: "Hardcover",
    kind: "tracker",
    remoteId: String(record.bookId),
    iconKey: "HC",
    score: normalizeScore(record.rating ?? null, HARDCOVER_RATING_MAX, record.rating == null ? 0 : 0.9),
  };
}

function normalizeHardcoverState(value: unknown, scopeInput: NovelRepositoryScopeInput): HardcoverTrackingState {
  const fallback = createEmptyHardcoverState(scopeInput);
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const authRecord = record.auth && typeof record.auth === "object" ? record.auth as Record<string, unknown> : {};
  return {
    version: HARDCOVER_STATE_VERSION,
    scopeKey: hardcoverScopeKey(scopeInput),
    auth: {
      connected: authRecord.connected === true && Boolean(normalizeText(authRecord.token)),
      token: normalizeText(authRecord.token),
      username: normalizeText(authRecord.username),
      userId: coerceNumber(authRecord.userId),
      connectedAtMs: coerceNumber(authRecord.connectedAtMs),
      lastValidatedAtMs: coerceNumber(authRecord.lastValidatedAtMs),
      lastError: normalizeText(authRecord.lastError),
    },
    records: Array.isArray(record.records)
      ? record.records.map(normalizeHardcoverTrackRecord).filter((entry): entry is HardcoverNovelTrackRecord => Boolean(entry))
      : [],
    searchCache: normalizeSearchCache(record.searchCache),
    updatedAtMs: coerceNumber(record.updatedAtMs),
  };
}

function normalizeSearchCache(value: unknown): Record<string, HardcoverBookSearchResult[]> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, HardcoverBookSearchResult[]> = {};
  for (const [key, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) continue;
    out[key] = entries.map(normalizeHardcoverBook).filter((entry): entry is HardcoverBookSearchResult => Boolean(entry));
  }
  return out;
}

export function normalizeHardcoverBook(value: unknown): HardcoverBookSearchResult | null {
  if (!value || typeof value !== "object") return null;
  const record = value as RawHardcoverBook & Record<string, unknown>;
  const id = coerceNumber(record.id);
  const title = normalizeText(record.title);
  if (!id || !title) return null;
  const slug = normalizeText(record.slug);
  return {
    id,
    title,
    authors: extractAuthors(record),
    genres: extractStringList(record.genres),
    tags: extractStringList(record.tags),
    moods: extractStringList(record.moods),
    coverUrl: extractCoverUrl(record),
    description: normalizeDescription(record.description_html ?? record.description),
    releaseYear: coerceNumber(record.release_year ?? record.publication_year),
    rating: coerceNumber(record.rating ?? record.average_rating),
    ratingsCount: coerceNumber(record.ratings_count),
    slug,
    url: slug ? `https://hardcover.app/books/${slug}` : `https://hardcover.app/books/${id}`,
    workStatus: normalizeHardcoverWorkStatus(normalizeText(record.book_status?.name))
      ?? normalizeHardcoverBookStatusId(coerceNumber(record.book_status_id)),
  };
}

function normalizeHardcoverUserBook(value: unknown): HardcoverNovelTrackRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as RawHardcoverUserBook & Record<string, unknown>;
  const book = normalizeHardcoverBook(record.book);
  if (!book) return null;
  return {
    bookId: book.id,
    title: book.title,
    authors: book.authors,
    genres: book.genres,
    tags: book.tags,
    moods: book.moods,
    coverUrl: book.coverUrl,
    status: normalizeText(record.user_book_status?.status) ?? normalizeHardcoverStatusId(coerceNumber(record.status_id)),
    workStatus: book.workStatus,
    rating: coerceNumber(record.rating) ?? book.rating,
    progress: coerceNumber(record.current_position),
    remoteUrl: book.url,
    updatedAt: Date.parse(normalizeText(record.updated_at) ?? "") || Date.now(),
    sourceNovelId: normalizeText(record.sourceNovelId),
    sourceTitleKey: recommendationTitleKey(book.title, "novel"),
  };
}

async function enrichHardcoverBookResults(
  token: string,
  books: HardcoverBookSearchResult[],
): Promise<HardcoverBookSearchResult[]> {
  const ids = [...new Set(books.map((book) => book.id).filter(Boolean))];
  if (!ids.length) return books;

  try {
    const data = await hardcoverGraphql<{
      books?: RawHardcoverBook[];
    }>(token, `
      query AethonHardcoverBookDetails($ids: [Int!]!) {
        books(where: { id: { _in: $ids } }) {
          id
          title
          subtitle
          slug
          cached_image
          description
          release_year
          rating
          ratings_count
          book_status_id
          book_status { name }
          contributions {
            author { name }
          }
        }
      }
    `, { ids });

    const detailsById = new Map(
      (data.books ?? [])
        .map(normalizeHardcoverBook)
        .filter((book): book is HardcoverBookSearchResult => Boolean(book))
        .map((book) => [book.id, book]),
    );

    let merged = books.map((book) => mergeHardcoverBookResult(book, detailsById.get(book.id)));
    const missingCoverIds = merged
      .filter((book) => !book.coverUrl)
      .map((book) => book.id)
      .filter(Boolean);

    if (missingCoverIds.length) {
      const coverPatches = await fetchHardcoverCoverPatches(token, missingCoverIds);
      if (coverPatches.size) {
        merged = merged.map((book) => {
          const coverUrl = coverPatches.get(book.id);
          return coverUrl ? { ...book, coverUrl } : book;
        });
      }
    }

    const stillMissingCovers = merged.filter((book) => !book.coverUrl);
    if (stillMissingCovers.length) {
      const openLibraryPatches = await fetchOpenLibraryCoverPatches(stillMissingCovers);
      if (openLibraryPatches.size) {
        merged = merged.map((book) => {
          const coverUrl = openLibraryPatches.get(book.id);
          return coverUrl ? { ...book, coverUrl } : book;
        });
      }
    }

    return merged;
  } catch (error) {
    console.warn("[Hardcover] Could not enrich book search results", error);
    const openLibraryPatches = await fetchOpenLibraryCoverPatches(books.filter((book) => !book.coverUrl));
    if (!openLibraryPatches.size) return books;
    return books.map((book) => {
      const coverUrl = openLibraryPatches.get(book.id);
      return coverUrl ? { ...book, coverUrl } : book;
    });
  }
}

async function fetchHardcoverCoverPatches(token: string, ids: number[]): Promise<Map<number, string>> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return new Map();

  const queries = [
    `
      query AethonHardcoverBookCoverUrls($ids: [Int!]!) {
        books(where: { id: { _in: $ids } }) {
          id
          cached_image_url
          image_url
          cover_url
        }
      }
    `,
    `
      query AethonHardcoverBookDefaultCoverEdition($ids: [Int!]!) {
        books(where: { id: { _in: $ids } }) {
          id
          default_cover_edition {
            image
            isbn_10
            isbn_13
          }
        }
      }
    `,
    `
      query AethonHardcoverBookCoverObjects($ids: [Int!]!) {
        books(where: { id: { _in: $ids } }) {
          id
          image { url }
        }
      }
    `,
    `
      query AethonHardcoverBookCoverScalars($ids: [Int!]!) {
        books(where: { id: { _in: $ids } }) {
          id
          cached_image
          image
          cover
        }
      }
    `,
  ];

  for (const query of queries) {
    try {
      const data = await hardcoverGraphql<{ books?: RawHardcoverBook[] }>(token, query, { ids: uniqueIds });
      const patches = new Map<number, string>();
      for (const record of data.books ?? []) {
        const id = coerceNumber(record.id);
        const coverUrl = extractCoverUrl(record as RawHardcoverBook & Record<string, unknown>);
        if (id && coverUrl) patches.set(id, coverUrl);
      }
      if (patches.size) return patches;
    } catch {
      // Hardcover's schema has changed these fields before; keep search results usable.
    }
  }

  return new Map();
}

async function fetchOpenLibraryCoverPatches(
  books: HardcoverBookSearchResult[],
): Promise<Map<number, string>> {
  const patches = new Map<number, string>();
  const queue = [...books];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const book = queue.shift();
      if (!book) continue;
      const coverUrl = await findOpenLibraryCover(book);
      if (coverUrl) patches.set(book.id, coverUrl);
    }
  });
  await Promise.all(workers);
  return patches;
}

async function enrichHardcoverTrackRecords(
  token: string,
  records: HardcoverNovelTrackRecord[],
): Promise<HardcoverNovelTrackRecord[]> {
  const missingCoverIds = records
    .filter((record) => !record.coverUrl)
    .map((record) => record.bookId)
    .filter(Boolean);
  if (!missingCoverIds.length) return records;

  const hardcoverPatches = await fetchHardcoverCoverPatches(token, missingCoverIds);
  let enriched = records.map((record) => {
    const coverUrl = hardcoverPatches.get(record.bookId);
    return coverUrl ? { ...record, coverUrl } : record;
  });

  const stillMissing = enriched.filter((record) => !record.coverUrl);
  if (!stillMissing.length) return enriched;

  const openLibraryPatches = await fetchOpenLibraryCoverPatches(stillMissing.map(hardcoverRecordToBookSearchResult));
  if (!openLibraryPatches.size) return enriched;
  enriched = enriched.map((record) => {
    const coverUrl = openLibraryPatches.get(record.bookId);
    return coverUrl ? { ...record, coverUrl } : record;
  });
  return enriched;
}

function hardcoverRecordToBookSearchResult(record: HardcoverNovelTrackRecord): HardcoverBookSearchResult {
  return {
    id: record.bookId,
    title: record.title,
    authors: record.authors,
    genres: record.genres,
    tags: record.tags,
    moods: record.moods,
    coverUrl: record.coverUrl,
    description: null,
    releaseYear: null,
    rating: record.rating,
    ratingsCount: null,
    slug: null,
    url: record.remoteUrl,
    workStatus: record.workStatus,
  };
}

function mergeHardcoverBookResult(
  base: HardcoverBookSearchResult,
  detail: HardcoverBookSearchResult | undefined,
): HardcoverBookSearchResult {
  if (!detail) return base;
  return {
    ...base,
    title: detail.title || base.title,
    authors: detail.authors.length ? detail.authors : base.authors,
    genres: detail.genres.length ? detail.genres : base.genres,
    tags: detail.tags.length ? detail.tags : base.tags,
    moods: detail.moods.length ? detail.moods : base.moods,
    coverUrl: detail.coverUrl ?? base.coverUrl,
    description: detail.description ?? base.description,
    releaseYear: detail.releaseYear ?? base.releaseYear,
    rating: detail.rating ?? base.rating,
    ratingsCount: detail.ratingsCount ?? base.ratingsCount,
    slug: detail.slug ?? base.slug,
    url: detail.url ?? base.url,
    workStatus: detail.workStatus ?? base.workStatus,
  };
}

function normalizeHardcoverTrackRecord(value: unknown): HardcoverNovelTrackRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const bookId = coerceNumber(record.bookId);
  const title = normalizeText(record.title);
  if (!bookId || !title) return null;
  return {
    bookId,
    title,
    authors: Array.isArray(record.authors)
      ? record.authors.map(normalizeText).filter((entry): entry is string => Boolean(entry))
      : [],
    genres: Array.isArray(record.genres)
      ? record.genres.map(normalizeText).filter((entry): entry is string => Boolean(entry))
      : [],
    tags: Array.isArray(record.tags)
      ? record.tags.map(normalizeText).filter((entry): entry is string => Boolean(entry))
      : [],
    moods: Array.isArray(record.moods)
      ? record.moods.map(normalizeText).filter((entry): entry is string => Boolean(entry))
      : [],
    coverUrl: normalizeText(record.coverUrl),
    status: normalizeText(record.status),
    workStatus: normalizeHardcoverWorkStatus(normalizeText(record.workStatus)),
    rating: coerceNumber(record.rating),
    progress: coerceNumber(record.progress),
    remoteUrl: normalizeText(record.remoteUrl),
    updatedAt: coerceNumber(record.updatedAt) ?? Date.now(),
    sourceNovelId: normalizeText(record.sourceNovelId),
    sourceTitleKey: normalizeText(record.sourceTitleKey) ?? (title ? recommendationTitleKey(title, "novel") : null),
  };
}

async function hardcoverGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const authToken = normalizeHardcoverAuthToken(token);
  if (!authToken) throw new Error("Hardcover API key is required.");
  const throttleKey = hardcoverThrottleKey(authToken);
  const throttleUntil = hardcoverRateLimitUntilByToken.get(throttleKey) ?? 0;
  if (throttleUntil > Date.now()) {
    throw new HardcoverRateLimitError("Hardcover is temporarily rate limited; using cached data.", throttleUntil);
  }

  const attempts = [authToken, `Bearer ${authToken}`];
  let lastError: Error | null = null;
  for (const authorization of attempts) {
    try {
      return await sendHardcoverGraphql<T>(authorization, query, variables);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (isHardcoverRateLimitError(lastError)) {
        rememberHardcoverRateLimit(authToken, lastError);
        throw lastError;
      }
      if (!isHardcoverAuthorizationError(lastError)) break;
    }
  }
  throw lastError ?? new Error("Hardcover request failed.");
}

async function sendHardcoverGraphql<T>(
  authorization: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await tauriFetch(HARDCOVER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
      "User-Agent": "Aethon/0.0.1 Hardcover Novel Tracking",
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await response.text();
  if (!response.ok) {
    if (response.status === 429) {
      throw new HardcoverRateLimitError(`Hardcover rejected the request (HTTP 429). ${summarizeHardcoverResponse(body)}`, Date.now() + HARDCOVER_RATE_LIMIT_COOLDOWN_MS);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Hardcover rejected the API key (HTTP ${response.status}).`);
    }
    throw new Error(`Hardcover request failed (HTTP ${response.status}). ${summarizeHardcoverResponse(body)}`);
  }

  let json: HardcoverGraphqlResponse<T>;
  try {
    json = JSON.parse(body) as HardcoverGraphqlResponse<T>;
  } catch {
    throw new Error(`Hardcover returned an invalid response. ${summarizeHardcoverResponse(body)}`);
  }

  if (json.errors?.length) throw new Error(json.errors[0]?.message ?? "Hardcover GraphQL error");
  if (!json.data) throw new Error("Hardcover response did not include data.");
  return json.data;
}

function hardcoverThrottleKey(token: string): string {
  return normalizeHardcoverAuthToken(token).slice(0, 24);
}

function rememberHardcoverRateLimit(token: string, error: Error): void {
  const retryAtMs = error instanceof HardcoverRateLimitError
    ? error.retryAtMs
    : Date.now() + HARDCOVER_RATE_LIMIT_COOLDOWN_MS;
  hardcoverRateLimitUntilByToken.set(hardcoverThrottleKey(token), retryAtMs);
}

function isHardcoverAuthorizationError(error: Error): boolean {
  return /authorization|authentication|jwt|token|api key|http 40[13]/i.test(error.message);
}

function summarizeHardcoverResponse(body: string): string {
  const trimmed = body
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/((?:api[_ -]?key|token|authorization)[\s\"']*[:=][\s\"']*)[^\s,\"'}]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as { errors?: Array<{ message?: string }>; message?: string };
    const message = parsed.errors?.[0]?.message ?? parsed.message;
    if (message) return message.slice(0, 220);
  } catch {}
  return trimmed.slice(0, 220);
}

async function tryWriteHardcoverUserBook(token: string, record: HardcoverNovelTrackRecord): Promise<void> {
  await hardcoverGraphql(token, `
    mutation AethonHardcoverInsertUserBook($bookId: Int!, $rating: numeric) {
      insert_user_book(object: { book_id: $bookId, rating: $rating }) {
        id
      }
    }
  `, {
    bookId: record.bookId,
    rating: record.rating,
  });
}

function extractAuthors(record: RawHardcoverBook): string[] {
  const authorNames = Array.isArray(record.author_names)
    ? record.author_names
    : typeof record.author_names === "string"
      ? record.author_names.split(",")
      : [];
  const authors = Array.isArray(record.authors)
    ? record.authors.map(extractAuthorName)
    : typeof record.authors === "string"
      ? record.authors.split(",")
      : [];
  const cachedContributors = Array.isArray(record.cached_contributors)
    ? record.cached_contributors.map(extractAuthorName)
    : typeof record.cached_contributors === "string"
      ? record.cached_contributors.split(",")
      : [];
  const contributions = record.contributions ?? record.book_authors ?? [];
  return [...new Set(
    [
      ...authorNames,
      ...authors,
      ...cachedContributors,
      ...contributions.map((entry) => entry?.author?.name),
    ]
      .map(normalizeText)
      .filter((entry): entry is string => Boolean(entry)),
  )];
}

function extractAuthorName(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return record.name ?? (record.author && typeof record.author === "object"
    ? (record.author as Record<string, unknown>).name
    : null);
}

function extractStringList(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  const text = normalizeText(value);
  if (text) {
    const parsed = text.trim().startsWith("[")
      ? safeJsonParse(text)
      : null;
    if (parsed) return extractStringList(parsed, depth + 1);
    return text.split(",").map(normalizeText).filter((entry): entry is string => Boolean(entry));
  }
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((entry) => extractStringList(entry, depth + 1)))];
  }
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return extractStringList(
    record.name
      ?? record.tag
      ?? record.title
      ?? record.genre
      ?? record.mood
      ?? record.label,
    depth + 1,
  );
}

function mergeStringLists(...lists: Array<string[] | null | undefined>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const text = normalizeText(item);
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(text);
    }
  }
  return merged;
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractCoverUrl(record: RawHardcoverBook & Record<string, unknown>): string | null {
  return extractImageUrl(record.cached_image_url)
    ?? extractImageUrl(record.image_url)
    ?? extractImageUrl(record.cover_url)
    ?? extractImageUrl(record.cached_image)
    ?? extractImageUrl(record.image)
    ?? extractImageUrl(record.default_cover_edition?.cached_image)
    ?? extractImageUrl(record.default_cover_edition?.image)
    ?? extractImageUrl(record.cover)
    ?? extractImageUrl(record.assets)
    ?? extractIsbnCoverUrl(record.isbns)
    ?? extractIsbnCoverUrl(record.default_cover_edition?.isbn_13)
    ?? extractIsbnCoverUrl(record.default_cover_edition?.isbn_10);
}

function extractImageUrl(value: unknown, depth = 0): string | null {
  if (depth > 3 || value == null) return null;
  const text = normalizeText(value);
  if (text) {
    const directUrl = normalizeImageUrl(text);
    if (directUrl) return directUrl;

    const parsed = safeJsonParse(text);
    if (parsed) {
      const parsedUrl = extractImageUrl(parsed, depth + 1);
      if (parsedUrl) return parsedUrl;
    }

    const embeddedUrl = text.match(/https?:\/\/[^\s"'<>\\)]+/i)?.[0]
      ?? text.match(/\/\/[^\s"'<>\\)]+/i)?.[0];
    if (embeddedUrl) return normalizeImageUrl(embeddedUrl);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = extractImageUrl(entry, depth + 1);
      if (url) return url;
    }
    return null;
  }

  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const preferredKeys = [
    "url",
    "cached_image_url",
    "image_url",
    "imageUrl",
    "cover_url",
    "coverUrl",
    "cdn_url",
    "original_url",
    "large_url",
    "medium_url",
    "small_url",
    "thumbnail_url",
    "src",
    "path",
    "original",
    "default",
    "large",
    "medium",
    "small",
    "thumb",
    "thumbnail",
    "poster",
    "webp",
    "jpg",
  ];
  for (const key of preferredKeys) {
    const url = extractImageUrl(record[key], depth + 1);
    if (url) return url;
  }
  return null;
}

function normalizeImageUrl(value: string): string | null {
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://hardcover.app${value}`;
  return null;
}

function extractIsbnCoverUrl(value: unknown): string | null {
  const isbn = extractStringList(value)
    .map((entry) => entry.replace(/[^0-9Xx]/g, "").toUpperCase())
    .find((entry) => entry.length === 10 || entry.length === 13);
  return isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false` : null;
}

async function findOpenLibraryCover(book: HardcoverBookSearchResult): Promise<string | null> {
  const cacheKey = [
    book.title.toLowerCase(),
    book.authors.slice(0, 2).join("|").toLowerCase(),
  ].join("::");
  if (openLibraryCoverCache.has(cacheKey)) return openLibraryCoverCache.get(cacheKey) ?? null;

  const params = new URLSearchParams({
    title: book.title,
    limit: "5",
    fields: "cover_i,isbn,title,author_name",
  });
  if (book.authors[0]) params.set("author", book.authors[0]);

  const ctrl = new AbortController();
  const timeout = globalThis.setTimeout(() => ctrl.abort(), OPEN_LIBRARY_COVER_TIMEOUT_MS);
  try {
    const response = await tauriFetch(`${OPEN_LIBRARY_SEARCH_URL}?${params.toString()}`, { signal: ctrl.signal });
    if (!response.ok) {
      openLibraryCoverCache.set(cacheKey, null);
      return null;
    }
    const data = await response.json() as {
      docs?: Array<{
        cover_i?: unknown;
        isbn?: unknown;
      }>;
    };
    for (const doc of data.docs ?? []) {
      const isbnCover = extractIsbnCoverUrl(doc.isbn);
      if (isbnCover) {
        openLibraryCoverCache.set(cacheKey, isbnCover);
        return isbnCover;
      }
      const coverId = coerceNumber(doc.cover_i);
      if (coverId) {
        const coverUrl = `https://covers.openlibrary.org/b/id/${coverId}-L.jpg?default=false`;
        openLibraryCoverCache.set(cacheKey, coverUrl);
        return coverUrl;
      }
    }
  } catch {
    // Cover fallback is best-effort; recommendation cards still render without it.
  } finally {
    globalThis.clearTimeout(timeout);
  }

  openLibraryCoverCache.set(cacheKey, null);
  return null;
}

function normalizeDescription(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  const stripped = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return stripped ? stripped : null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeHardcoverAuthToken(value: unknown): string {
  if (typeof value !== "string") return "";
  let token = value.trim();
  token = token.replace(/^authorization\s*:\s*/i, "").trim();
  token = token.replace(/^bearer\s+/i, "").trim();
  return token;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeHardcoverStatusId(statusId: number | null): string | null {
  switch (statusId) {
    case 1: return "Want to Read";
    case 2: return "Currently Reading";
    case 3: return "Read";
    case 4: return "Did Not Finish";
    default: return null;
  }
}

function normalizeHardcoverWorkStatus(status: string | null | undefined): string | null {
  const normalized = status?.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.toLowerCase() === "unknown") return null;
  const token = normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (token === "FINISHED" || token === "COMPLETED" || token === "COMPLETE") return "Completed";
  if (token === "CANCELLED" || token === "CANCELED") return "Cancelled";
  if (token === "HIATUS") return "Hiatus";
  if (token === "ONGOING") return "Ongoing";
  return null;
}

function normalizeHardcoverBookStatusId(statusId: number | null): string | null {
  switch (statusId) {
    case 1: return "Unknown";
    case 2: return "Ongoing";
    case 3: return "Completed";
    case 4: return "Hiatus";
    case 5: return "Cancelled";
    default: return null;
  }
}

function mapHardcoverStatusToSeedStatus(status: string | null | undefined): TasteProfileSeedItem["status"] {
  const normalized = status?.toLowerCase() ?? "";
  if (normalized.includes("read") && !normalized.includes("want") && !normalized.includes("current")) return "completed";
  if (normalized.includes("current")) return "reading";
  if (normalized.includes("finish") || normalized.includes("drop")) return "dropped";
  if (normalized.includes("want")) return "planning";
  return "unknown";
}

function tokenizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1);
}

function titleSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const shared = left.filter((token) => rightSet.has(token)).length;
  const coverage = shared / Math.max(left.length, right.length);
  const containment = shared / Math.min(left.length, right.length);
  return (coverage * 0.65) + (containment * 0.35);
}
