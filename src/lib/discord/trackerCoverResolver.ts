import { gql } from "../client";
import type { BookEntry } from "../books/types";
import { findHardcoverRecordForNovel, loadHardcoverState } from "../novels/hardcover";
import type { NovelRepositoryScopeInput } from "../novels/repositoryState";
import { GET_MANGA_TRACK_RECORDS } from "../queries";
import type { TrackRecord } from "../types";
import { isDiscordPublicImageUrl } from "./coverResolver";

const COVER_LOOKUP_TIMEOUT_MS = 5_000;
const MAIN_HARDCOVER_SCOPE: NovelRepositoryScopeInput = {
  profileId: "main",
  serverUrl: "http://127.0.0.1:4567",
};

interface MangaTrackRecordsResponse {
  manga: {
    trackRecords?: {
      nodes?: MangaTrackRecord[];
    } | null;
  } | null;
}

type MangaTrackerProviderKey = "anilist" | "myanimelist" | "kitsu" | "bangumi" | "mangaupdates";

type MangaTrackRecord = TrackRecord & {
  tracker?: {
    id?: number | null;
    name?: string | null;
    icon?: string | null;
  } | null;
};

interface MangaTrackerCoverProvider {
  key: MangaTrackerProviderKey;
  knownTrackerIds: number[];
  names: RegExp[];
  domains: RegExp[];
  extractId(value: string | null | undefined): number | null;
  fetchCover(id: number): Promise<string | null>;
}

function createTimeoutSignal(timeoutMs = COVER_LOOKUP_TIMEOUT_MS): { signal: AbortSignal; cancel(): void } {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel() {
      globalThis.clearTimeout(timeout);
    },
  };
}

function isMainOrUnsetProfile(profileId: string | null | undefined): boolean {
  return !profileId || profileId === "main";
}

function isLoopbackServerUrl(serverUrl: string | null | undefined): boolean {
  if (!serverUrl) return true;
  try {
    const host = new URL(serverUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function hardcoverLookupScopes(scopeInput: NovelRepositoryScopeInput = {}): NovelRepositoryScopeInput[] {
  const scopes = [scopeInput];
  if (
    isMainOrUnsetProfile(scopeInput.profileId)
    && isLoopbackServerUrl(scopeInput.serverUrl)
    && scopeInput.serverUrl !== MAIN_HARDCOVER_SCOPE.serverUrl
  ) {
    scopes.push(MAIN_HARDCOVER_SCOPE);
  }
  return scopes;
}

function toPositiveInteger(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeTrackerText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function extractAniListMangaId(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /(?:^|\/\/)(?:www\.)?anilist\.co\/manga\/(\d+)/i.exec(value);
  return match ? Number(match[1]) : null;
}

export function extractMyAnimeListMangaId(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /(?:^|\/\/)(?:www\.)?myanimelist\.net\/manga\/(\d+)/i.exec(value);
  return match ? Number(match[1]) : null;
}

export function extractKitsuMangaId(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /(?:^|\/\/)(?:www\.)?kitsu\.(?:io|app)\/manga\/(\d+)/i.exec(value);
  return match ? Number(match[1]) : null;
}

export function extractBangumiSubjectId(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /(?:^|\/\/)(?:www\.)?(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/(\d+)/i.exec(value);
  return match ? Number(match[1]) : null;
}

export function extractMangaUpdatesSeriesId(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /(?:^|\/\/)(?:www\.)?mangaupdates\.com\/series\/(\d+)(?:[/?#]|$)/i.exec(value);
  return match ? Number(match[1]) : null;
}

const MANGA_TRACKER_COVER_PROVIDERS: MangaTrackerCoverProvider[] = [
  {
    key: "anilist",
    knownTrackerIds: [2],
    names: [/anilist/i],
    domains: [/anilist\.co/i],
    extractId: extractAniListMangaId,
    fetchCover: fetchAniListCover,
  },
  {
    key: "myanimelist",
    knownTrackerIds: [1],
    names: [/myanimelist/i, /\bmal\b/i],
    domains: [/myanimelist\.net/i],
    extractId: extractMyAnimeListMangaId,
    fetchCover: fetchMyAnimeListCover,
  },
  {
    key: "kitsu",
    knownTrackerIds: [3],
    names: [/kitsu/i],
    domains: [/kitsu\.(?:io|app)/i],
    extractId: extractKitsuMangaId,
    fetchCover: fetchKitsuCover,
  },
  {
    key: "bangumi",
    knownTrackerIds: [5],
    names: [/bangumi/i, /\bbgm\b/i],
    domains: [/(?:^|\.)bgm\.tv/i, /bangumi\.tv/i, /chii\.in/i],
    extractId: extractBangumiSubjectId,
    fetchCover: fetchBangumiCover,
  },
  {
    key: "mangaupdates",
    knownTrackerIds: [7],
    names: [/mangaupdates/i, /bakaupdates/i],
    domains: [/mangaupdates\.com/i],
    extractId: extractMangaUpdatesSeriesId,
    fetchCover: fetchMangaUpdatesCover,
  },
];

function trackerProviderMetadata(record: Pick<MangaTrackRecord, "trackerId" | "tracker">): {
  id: number | null;
  name: string;
  icon: string;
} {
  return {
    id: record.tracker?.id ?? record.trackerId ?? null,
    name: normalizeTrackerText(record.tracker?.name),
    icon: normalizeTrackerText(record.tracker?.icon),
  };
}

export function inferMangaTrackerCoverProvider(record: Pick<MangaTrackRecord, "trackerId" | "remoteUrl" | "tracker">): MangaTrackerProviderKey | null {
  const remoteUrl = record.remoteUrl ?? "";
  const fromUrl = MANGA_TRACKER_COVER_PROVIDERS.find((provider) =>
    provider.domains.some((domain) => domain.test(remoteUrl)));
  if (fromUrl) return fromUrl.key;

  const metadata = trackerProviderMetadata(record);
  const fromText = MANGA_TRACKER_COVER_PROVIDERS.find((provider) =>
    provider.names.some((pattern) => pattern.test(metadata.name) || pattern.test(metadata.icon)));
  if (fromText) return fromText.key;

  const fromKnownId = MANGA_TRACKER_COVER_PROVIDERS.find((provider) =>
    metadata.id !== null && provider.knownTrackerIds.includes(metadata.id));
  return fromKnownId?.key ?? null;
}

function providerForKey(key: MangaTrackerProviderKey | null): MangaTrackerCoverProvider | null {
  return MANGA_TRACKER_COVER_PROVIDERS.find((provider) => provider.key === key) ?? null;
}

function inferProviderMangaId(record: Pick<MangaTrackRecord, "trackerId" | "remoteId" | "remoteUrl" | "tracker">): number | null {
  const provider = providerForKey(inferMangaTrackerCoverProvider(record));
  if (!provider) return null;
  return provider.extractId(record.remoteUrl) ?? toPositiveInteger(record.remoteId);
}

export function inferAniListMangaId(record: Pick<MangaTrackRecord, "trackerId" | "remoteId" | "remoteUrl" | "tracker">): number | null {
  const provider = providerForKey(inferMangaTrackerCoverProvider(record));
  if (provider?.key !== "anilist") return null;
  return provider.extractId(record.remoteUrl) ?? toPositiveInteger(record.remoteId);
}

export function inferMyAnimeListMangaId(record: Pick<MangaTrackRecord, "trackerId" | "remoteId" | "remoteUrl" | "tracker">): number | null {
  const provider = providerForKey(inferMangaTrackerCoverProvider(record));
  if (provider?.key !== "myanimelist") return null;
  return provider.extractId(record.remoteUrl) ?? toPositiveInteger(record.remoteId);
}

async function fetchAniListCover(id: number): Promise<string | null> {
  const timeout = createTimeoutSignal();
  try {
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query: `
          query AethonDiscordCover($id: Int!) {
            Media(id: $id, type: MANGA) {
              coverImage {
                extraLarge
                large
              }
            }
          }
        `,
        variables: { id },
      }),
      signal: timeout.signal,
    });
    if (!response.ok) return null;
    const json = await response.json() as {
      data?: { Media?: { coverImage?: { extraLarge?: string | null; large?: string | null } | null } | null };
    };
    const cover = json.data?.Media?.coverImage?.extraLarge ?? json.data?.Media?.coverImage?.large ?? null;
    return isDiscordPublicImageUrl(cover) ? cover : null;
  } catch {
    return null;
  } finally {
    timeout.cancel();
  }
}

async function fetchMyAnimeListCover(id: number): Promise<string | null> {
  const timeout = createTimeoutSignal();
  try {
    const response = await fetch(`https://api.jikan.moe/v4/manga/${id}/full`, {
      headers: { Accept: "application/json" },
      signal: timeout.signal,
    });
    if (!response.ok) return null;
    const json = await response.json() as {
      data?: {
        images?: {
          webp?: { large_image_url?: string | null; image_url?: string | null };
          jpg?: { large_image_url?: string | null; image_url?: string | null };
        } | null;
      } | null;
    };
    const cover = json.data?.images?.webp?.large_image_url
      ?? json.data?.images?.jpg?.large_image_url
      ?? json.data?.images?.webp?.image_url
      ?? json.data?.images?.jpg?.image_url
      ?? null;
    return isDiscordPublicImageUrl(cover) ? cover : null;
  } catch {
    return null;
  } finally {
    timeout.cancel();
  }
}

async function fetchKitsuCover(id: number): Promise<string | null> {
  const timeout = createTimeoutSignal();
  try {
    const response = await fetch(`https://kitsu.io/api/edge/manga/${id}`, {
      headers: { Accept: "application/vnd.api+json" },
      signal: timeout.signal,
    });
    if (!response.ok) return null;
    const json = await response.json() as {
      data?: {
        attributes?: {
          posterImage?: {
            original?: string | null;
            large?: string | null;
            medium?: string | null;
            small?: string | null;
          } | null;
        } | null;
      } | null;
    };
    const cover = json.data?.attributes?.posterImage?.original
      ?? json.data?.attributes?.posterImage?.large
      ?? json.data?.attributes?.posterImage?.medium
      ?? json.data?.attributes?.posterImage?.small
      ?? null;
    return isDiscordPublicImageUrl(cover) ? cover : null;
  } catch {
    return null;
  } finally {
    timeout.cancel();
  }
}

async function fetchBangumiCover(id: number): Promise<string | null> {
  const url = `https://api.bgm.tv/v0/subjects/${id}/image?type=large`;
  const timeout = createTimeoutSignal();
  try {
    const response = await fetch(url, {
      headers: { Accept: "image/*" },
      signal: timeout.signal,
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.toLowerCase().startsWith("image/") && isDiscordPublicImageUrl(response.url)
      ? response.url
      : null;
  } catch {
    return null;
  } finally {
    timeout.cancel();
  }
}

async function fetchMangaUpdatesCover(id: number): Promise<string | null> {
  const timeout = createTimeoutSignal();
  try {
    const response = await fetch(`https://api.mangaupdates.com/v1/series/${id}`, {
      headers: { Accept: "application/json" },
      signal: timeout.signal,
    });
    if (!response.ok) return null;
    const json = await response.json() as {
      image?: {
        url?: {
          original?: string | null;
          thumb?: string | null;
        } | null;
      } | null;
    };
    const cover = json.image?.url?.original ?? json.image?.url?.thumb ?? null;
    return isDiscordPublicImageUrl(cover) ? cover : null;
  } catch {
    return null;
  } finally {
    timeout.cancel();
  }
}

export async function resolveTrackedMangaDiscordCover(mangaId: number): Promise<string | null> {
  const timeout = createTimeoutSignal();
  try {
    const data = await gql<MangaTrackRecordsResponse>(
      GET_MANGA_TRACK_RECORDS,
      { mangaId },
      timeout.signal,
      COVER_LOOKUP_TIMEOUT_MS,
    );
    const records = data.manga?.trackRecords?.nodes ?? [];
    for (const record of records) {
      const provider = providerForKey(inferMangaTrackerCoverProvider(record));
      const remoteId = provider ? inferProviderMangaId(record) : null;
      if (!provider || !remoteId) continue;

      const cover = await provider.fetchCover(remoteId);
      if (cover) return cover;
    }
  } catch {
    return null;
  } finally {
    timeout.cancel();
  }

  return null;
}

export function resolveHardcoverNovelDiscordCover(input: {
  novelId?: string | null;
  title?: string | null;
  scopeInput?: NovelRepositoryScopeInput;
}): string | null {
  for (const scopeInput of hardcoverLookupScopes(input.scopeInput ?? {})) {
    try {
      const state = loadHardcoverState(scopeInput);
      const record = findHardcoverRecordForNovel(state.records, {
        novelId: input.novelId,
        title: input.title,
      });
      if (isDiscordPublicImageUrl(record?.coverUrl)) return record.coverUrl;
    } catch {}
  }
  return null;
}

export function resolveHardcoverBookDiscordCover(input: {
  book: Pick<BookEntry, "id" | "hardcoverBookId" | "hardcoverCoverUrl">;
  scopeInput?: NovelRepositoryScopeInput;
}): string | null {
  const linkedCover = input.book.hardcoverCoverUrl;
  if (isDiscordPublicImageUrl(linkedCover)) return linkedCover;

  for (const scopeInput of hardcoverLookupScopes(input.scopeInput ?? {})) {
    try {
      const state = loadHardcoverState(scopeInput);
      const linkedRecord = state.records.find((entry) => entry.sourceNovelId === input.book.id);
      if (isDiscordPublicImageUrl(linkedRecord?.coverUrl)) return linkedRecord.coverUrl;

      const hardcoverBookId = typeof input.book.hardcoverBookId === "number" && Number.isFinite(input.book.hardcoverBookId)
        ? Math.trunc(input.book.hardcoverBookId)
        : null;
      if (!hardcoverBookId || hardcoverBookId <= 0) continue;

      const record = state.records.find((entry) => entry.bookId === hardcoverBookId);
      if (isDiscordPublicImageUrl(record?.coverUrl)) return record.coverUrl;

      for (const entries of Object.values(state.searchCache)) {
        const cached = entries.find((entry) => entry.id === hardcoverBookId);
        if (isDiscordPublicImageUrl(cached?.coverUrl)) return cached.coverUrl;
      }
    } catch {}
  }

  return null;
}

export function createHardcoverBookDiscordTrackerKey(input: {
  book: Pick<BookEntry, "id" | "hardcoverBookId" | "hardcoverCoverUrl">;
  scopeInput?: NovelRepositoryScopeInput;
}): string {
  const base = [
    "hardcover-book",
    input.book.hardcoverBookId ?? "",
    input.book.hardcoverCoverUrl ?? "",
  ];

  for (const scopeInput of hardcoverLookupScopes(input.scopeInput ?? {})) {
    try {
      const state = loadHardcoverState(scopeInput);
      const linkedRecord = state.records.find((entry) => entry.sourceNovelId === input.book.id);
      if (linkedRecord) {
        return [
          ...base,
          "scope",
          state.scopeKey,
          "sourceNovelId",
          linkedRecord.bookId,
          linkedRecord.updatedAt,
          linkedRecord.coverUrl ?? "",
        ].join(":");
      }

      const hardcoverBookId = typeof input.book.hardcoverBookId === "number" && Number.isFinite(input.book.hardcoverBookId)
        ? Math.trunc(input.book.hardcoverBookId)
        : null;
      if (hardcoverBookId && hardcoverBookId > 0) {
        const record = state.records.find((entry) => entry.bookId === hardcoverBookId);
        if (record) {
          return [
            ...base,
            "scope",
            state.scopeKey,
            "bookId",
            record.bookId,
            record.updatedAt,
            record.coverUrl ?? "",
          ].join(":");
        }
      }
    } catch {}
  }

  return [...base, "none"].join(":");
}
