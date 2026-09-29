import {
  normalizeNovelRepositoryUrl,
  type InstalledNovelPluginRecord,
  type NovelCatalogEntry,
  type NovelRepositoryRecord,
  type NovelTrustState,
} from "./contracts";

export const LNREADER_REPOSITORY_MANIFEST_BASENAME = "plugins.min.json";

/** LNReader has a single official plugin feed; Epigraph ships it as a built-in repository. */
export const BUILTIN_LNREADER_REPOSITORY_URL =
  "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json";

export type NovelCatalogPluginStatus =
  | "available"
  | "installed"
  | "disabled"
  | "update-available";

export interface CreateNovelRepositoryRecordInput {
  profileId: string;
  url: string;
  trustState?: NovelTrustState;
  enabled?: boolean;
  recommendedSeed?: boolean;
  nowMs?: number;
}

export interface NovelRepositoryUrlValidationResult {
  ok: boolean;
  normalizedUrl: string | null;
  reason: string | null;
}

export interface NovelCatalogRefreshMetadata {
  etag: string | null;
  lastModified: string | null;
}

export interface DerivedNovelCatalogPluginState {
  pluginId: string;
  repositoryId: string;
  status: NovelCatalogPluginStatus;
  availableVersion: string;
  installedVersion: string | null;
  enabled: boolean;
}

interface RawNovelCatalogEntry {
  id?: unknown;
  name?: unknown;
  site?: unknown;
  lang?: unknown;
  version?: unknown;
  url?: unknown;
  iconUrl?: unknown;
  icon?: unknown;
  customJS?: unknown;
  customCss?: unknown;
  customCSS?: unknown;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function createRepositoryId(normalizedUrl: string): string {
  return `novel-repo:${encodeURIComponent(normalizedUrl)}`;
}

function normalizeLanguageCode(value: string): string {
  return value.trim().toLowerCase();
}

export function validateNovelRepositoryUrl(url: string): NovelRepositoryUrlValidationResult {
  const normalizedUrl = normalizeNovelRepositoryUrl(url);
  if (!normalizedUrl) {
    return {
      ok: false,
      normalizedUrl: null,
      reason: "Repository URL is required.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    return {
      ok: false,
      normalizedUrl: null,
      reason: "Repository URL must be a valid absolute URL.",
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      normalizedUrl: null,
      reason: "Repository URL must use http or https.",
    };
  }

  if (!parsed.pathname.toLowerCase().endsWith(`/${LNREADER_REPOSITORY_MANIFEST_BASENAME}`)
    && parsed.pathname.toLowerCase() !== `/${LNREADER_REPOSITORY_MANIFEST_BASENAME}`) {
    return {
      ok: false,
      normalizedUrl: null,
      reason: `Repository URL must point to ${LNREADER_REPOSITORY_MANIFEST_BASENAME}.`,
    };
  }

  parsed.hash = "";
  return {
    ok: true,
    normalizedUrl: normalizeNovelRepositoryUrl(parsed.toString()),
    reason: null,
  };
}

export function resolveNovelRepositoryInputUrl(value: string): string {
  const direct = validateNovelRepositoryUrl(value);
  if (direct.ok && direct.normalizedUrl) return direct.normalizedUrl;

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(direct.reason ?? "Repository URL must be a valid absolute URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(direct.reason ?? "Repository URL must use https.");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const host = parsed.hostname.toLowerCase();
  if (host === "raw.githubusercontent.com" && parts.length >= 5) {
    const [owner, repository] = parts;
    const sourceMarker = parts.indexOf(".js", 2);
    if (repository.toLowerCase() === "lnreader-plugins" && sourceMarker > 2) {
      const branch = parts.slice(2, sourceMarker).join("/");
      return `https://raw.githubusercontent.com/${owner}/${repository}/${branch}/.dist/${LNREADER_REPOSITORY_MANIFEST_BASENAME}`;
    }
  }

  if (host === "github.com" && parts.length >= 2) {
    const [owner, repository, marker, ...rest] = parts;
    if (repository.toLowerCase() === "lnreader-plugins") {
      const branch = parts.length === 2
        ? "plugins/v3.0.0"
        : marker === "tree" && rest.length > 0
          ? rest.join("/")
          : null;
      if (branch) {
        return `https://raw.githubusercontent.com/${owner}/${repository}/${branch}/.dist/${LNREADER_REPOSITORY_MANIFEST_BASENAME}`;
      }
    }
  }

  throw new Error(direct.reason ?? `Repository URL must point to ${LNREADER_REPOSITORY_MANIFEST_BASENAME}.`);
}

export function createNovelRepositoryRecord(input: CreateNovelRepositoryRecordInput): NovelRepositoryRecord {
  const validation = validateNovelRepositoryUrl(input.url);
  if (!validation.ok || !validation.normalizedUrl) {
    throw new Error(validation.reason ?? "Invalid LNReader repository URL.");
  }

  const nowMs = input.nowMs ?? Date.now();

  return {
    id: createRepositoryId(validation.normalizedUrl),
    profileId: input.profileId.trim(),
    url: input.url.trim(),
    normalizedUrl: validation.normalizedUrl,
    recommendedSeed: input.recommendedSeed === true,
    trustState: input.trustState ?? "unknown",
    enabled: input.enabled !== false,
    lastFetchedAtMs: null,
    lastSuccessAtMs: null,
    etag: null,
    lastModified: null,
    lastError: null,
  };
}

export function buildNovelRepositoryFetchHeaders(repository: Pick<NovelRepositoryRecord, "etag" | "lastModified">): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (repository.etag) {
    headers["If-None-Match"] = repository.etag;
  }

  if (repository.lastModified) {
    headers["If-Modified-Since"] = repository.lastModified;
  }

  return headers;
}

export function extractNovelRepositoryRefreshMetadata(headers: Headers | Record<string, string | null | undefined>): NovelCatalogRefreshMetadata {
  const readHeader = (name: string): string | null => {
    if (headers instanceof Headers) {
      return headers.get(name);
    }

    const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
    const value = match?.[1];
    return typeof value === "string" && value.trim() ? value : null;
  };

  return {
    etag: readHeader("etag"),
    lastModified: readHeader("last-modified"),
  };
}

export function parseNovelCatalogEntries(
  manifest: unknown,
  input: { repositoryId: string; fetchedAtMs?: number },
): NovelCatalogEntry[] {
  if (!Array.isArray(manifest)) {
    throw new Error("LNReader repository manifest must be an array.");
  }

  const fetchedAtMs = input.fetchedAtMs ?? Date.now();

  return manifest.flatMap((entry) => {
    const item = entry as RawNovelCatalogEntry | null;
    const pluginId = normalizeText(item?.id);
    const name = normalizeText(item?.name);
    const site = normalizeText(item?.site);
    const lang = normalizeText(item?.lang);
    const version = normalizeText(item?.version);
    const artifactUrl = normalizeText(item?.url);

    if (!pluginId || !name || !site || !lang || !version || !artifactUrl) {
      return [];
    }

    return [{
      repositoryId: input.repositoryId,
      pluginId,
      name,
      site,
      lang,
      version,
      artifactUrl,
      iconUrl: normalizeText(item?.iconUrl) ?? normalizeText(item?.icon),
      customJsUrl: normalizeText(item?.customJS),
      customCssUrl: normalizeText(item?.customCSS) ?? normalizeText(item?.customCss),
      manifestHash: null,
      fetchedAtMs,
    } satisfies NovelCatalogEntry];
  });
}

export function filterNovelCatalogEntriesByLanguage(
  entries: readonly NovelCatalogEntry[],
  languages: readonly string[],
): NovelCatalogEntry[] {
  const normalizedLanguages = [...new Set(
    languages
      .map((entry) => normalizeText(entry))
      .filter((entry): entry is string => Boolean(entry))
      .map((entry) => normalizeLanguageCode(entry)),
  )];

  if (normalizedLanguages.length === 0) {
    return [...entries];
  }

  return entries.filter((entry) => normalizedLanguages.includes(normalizeLanguageCode(entry.lang)));
}

export function deriveNovelCatalogPluginState(
  entry: NovelCatalogEntry,
  installedPlugin: Pick<InstalledNovelPluginRecord, "version" | "enabled"> | null | undefined,
): DerivedNovelCatalogPluginState {
  const installedVersion = installedPlugin?.version ?? null;
  const enabled = installedPlugin?.enabled !== false;

  let status: NovelCatalogPluginStatus = "available";
  if (installedPlugin) {
    if (!installedPlugin.enabled) {
      status = "disabled";
    } else if (installedPlugin.version !== entry.version) {
      status = "update-available";
    } else {
      status = "installed";
    }
  }

  return {
    pluginId: entry.pluginId,
    repositoryId: entry.repositoryId,
    status,
    availableVersion: entry.version,
    installedVersion,
    enabled,
  };
}

export function canInstallNovelRepository(trustState: NovelTrustState): boolean {
  return trustState === "trusted";
}

export function canExecuteNovelPlugin(trustState: NovelTrustState, enabled: boolean): boolean {
  return enabled && canInstallNovelRepository(trustState);
}
