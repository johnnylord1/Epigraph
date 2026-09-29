import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import {
  normalizeNovelRepositoryUrl,
  type InstalledNovelPluginRecord,
  type NovelCatalogEntry,
  type NovelRepositoryRecord,
  type NovelTrustState,
} from "./contracts";
import {
  BUILTIN_LNREADER_REPOSITORY_URL,
  buildNovelRepositoryFetchHeaders,
  createNovelRepositoryRecord,
  extractNovelRepositoryRefreshMetadata,
  filterNovelCatalogEntriesByLanguage,
  parseNovelCatalogEntries,
} from "./repositories";
import { DEFAULT_LOCAL_PROFILE_ID, normalizeLocalProfileId, normalizeServerUrl } from "../localProfiles";

export const NOVEL_REPOSITORY_STATE_VERSION = 1;

export interface NovelRepositoryScopeInput {
  profileId?: string | null;
  serverUrl?: string | null;
}

export interface PersistedNovelRepositoryState {
  version: number;
  scopeKey: string;
  repositories: NovelRepositoryRecord[];
  catalogEntries: NovelCatalogEntry[];
  installedPlugins: InstalledNovelPluginRecord[];
  languageFilter: string[];
  updatedAtMs: number | null;
}

export interface NovelRepositoryRefreshResult {
  state: PersistedNovelRepositoryState;
  repository: NovelRepositoryRecord;
  status: "updated" | "not-modified" | "error";
  httpStatus: number | null;
  catalogCount: number;
  fetchedAtMs: number;
}

export type NovelRepositoryUiState =
  | "ready"
  | "untrusted"
  | "blocked"
  | "disabled"
  | "error"
  | "empty"
  | "stale";

interface PersistedNovelRepositoryStateShape {
  version?: unknown;
  scopeKey?: unknown;
  repositories?: unknown;
  catalogEntries?: unknown;
  installedPlugins?: unknown;
  languageFilter?: unknown;
  updatedAtMs?: unknown;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeNovelTrustState(value: unknown): NovelTrustState {
  return value === "trusted" || value === "blocked" ? value : "unknown";
}

function normalizeRepositoryRecord(value: unknown, fallbackProfileId: string): NovelRepositoryRecord | null {
  if (!value || typeof value !== "object") return null;

  const repository = value as Record<string, unknown>;
  const url = normalizeText(repository.url);
  if (!url) return null;

  const record = createNovelRepositoryRecord({
    profileId: normalizeText(repository.profileId) ?? fallbackProfileId,
    url,
    enabled: repository.enabled !== false,
    recommendedSeed: repository.recommendedSeed === true,
    trustState: normalizeNovelTrustState(repository.trustState),
    nowMs: typeof repository.lastFetchedAtMs === "number" ? repository.lastFetchedAtMs : undefined,
  });

  return {
    ...record,
    lastFetchedAtMs: typeof repository.lastFetchedAtMs === "number" ? repository.lastFetchedAtMs : null,
    lastSuccessAtMs: typeof repository.lastSuccessAtMs === "number" ? repository.lastSuccessAtMs : null,
    etag: normalizeText(repository.etag),
    lastModified: normalizeText(repository.lastModified),
    lastError: normalizeText(repository.lastError),
  };
}

function normalizeCatalogEntry(value: unknown): NovelCatalogEntry | null {
  if (!value || typeof value !== "object") return null;

  const entry = value as Record<string, unknown>;
  const repositoryId = normalizeText(entry.repositoryId);
  const pluginId = normalizeText(entry.pluginId);
  const name = normalizeText(entry.name);
  const site = normalizeText(entry.site);
  const lang = normalizeText(entry.lang);
  const version = normalizeText(entry.version);
  const artifactUrl = normalizeText(entry.artifactUrl);

  if (!repositoryId || !pluginId || !name || !site || !lang || !version || !artifactUrl) {
    return null;
  }

  return {
    repositoryId,
    pluginId,
    name,
    site,
    lang,
    version,
    artifactUrl,
    iconUrl: normalizeText(entry.iconUrl),
    customJsUrl: normalizeText(entry.customJsUrl),
    customCssUrl: normalizeText(entry.customCssUrl),
    manifestHash: normalizeText(entry.manifestHash),
    fetchedAtMs: typeof entry.fetchedAtMs === "number" ? entry.fetchedAtMs : Date.now(),
  };
}

function normalizeInstalledPluginRecord(value: unknown, fallbackProfileId: string): InstalledNovelPluginRecord | null {
  if (!value || typeof value !== "object") return null;

  const entry = value as Record<string, unknown>;
  const repositoryId = normalizeText(entry.repositoryId);
  const pluginId = normalizeText(entry.pluginId);
  const version = normalizeText(entry.version);
  const artifactPath = normalizeText(entry.artifactPath);

  if (!repositoryId || !pluginId || !version || !artifactPath) {
    return null;
  }

  return {
    profileId: normalizeText(entry.profileId) ?? fallbackProfileId,
    repositoryId,
    pluginId,
    version,
    enabled: entry.enabled !== false,
    disabledReason: normalizeText(entry.disabledReason),
    artifactPath,
    customJsPath: normalizeText(entry.customJsPath),
    customCssPath: normalizeText(entry.customCssPath),
    hasSettings: entry.hasSettings === true,
    installedAtMs: typeof entry.installedAtMs === "number" ? entry.installedAtMs : Date.now(),
    updatedAtMs: typeof entry.updatedAtMs === "number" ? entry.updatedAtMs : Date.now(),
  };
}

function normalizeLanguageFilter(values: readonly unknown[] | null | undefined): string[] {
  return [...new Set(
    (values ?? [])
      .map((value) => normalizeText(value))
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase()),
  )];
}

function normalizeScopeInput(input: NovelRepositoryScopeInput): { profileId: string | null; serverUrl: string | null } {
  return {
    profileId: normalizeLocalProfileId(input.profileId),
    serverUrl: normalizeServerUrl(input.serverUrl),
  };
}

export function createEmptyNovelRepositoryState(scopeInput: NovelRepositoryScopeInput = {}): PersistedNovelRepositoryState {
  const normalized = normalizeScopeInput(scopeInput);
  const scopeKey = normalized.profileId
    ? `profile:${normalized.profileId}`
    : normalized.serverUrl
      ? `server:${encodeURIComponent(normalized.serverUrl)}`
      : `profile:${DEFAULT_LOCAL_PROFILE_ID}`;

  return {
    version: NOVEL_REPOSITORY_STATE_VERSION,
    scopeKey,
    repositories: [],
    catalogEntries: [],
    installedPlugins: [],
    languageFilter: [],
    updatedAtMs: null,
  };
}

export function normalizeNovelRepositoryState(
  value: unknown,
  scopeInput: NovelRepositoryScopeInput = {},
): PersistedNovelRepositoryState {
  const fallback = createEmptyNovelRepositoryState(scopeInput);
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const state = value as PersistedNovelRepositoryStateShape;
  const fallbackProfileId = normalizeScopeInput(scopeInput).profileId ?? fallback.scopeKey;

  return {
    version: typeof state.version === "number" ? state.version : NOVEL_REPOSITORY_STATE_VERSION,
    scopeKey: normalizeText(state.scopeKey) ?? fallback.scopeKey,
    repositories: Array.isArray(state.repositories)
      ? state.repositories
        .map((entry) => normalizeRepositoryRecord(entry, fallbackProfileId))
        .filter((entry): entry is NovelRepositoryRecord => Boolean(entry))
      : [],
    catalogEntries: Array.isArray(state.catalogEntries)
      ? state.catalogEntries
        .map((entry) => normalizeCatalogEntry(entry))
        .filter((entry): entry is NovelCatalogEntry => Boolean(entry))
      : [],
    installedPlugins: Array.isArray(state.installedPlugins)
      ? state.installedPlugins
        .map((entry) => normalizeInstalledPluginRecord(entry, fallbackProfileId))
        .filter((entry): entry is InstalledNovelPluginRecord => Boolean(entry))
      : [],
    languageFilter: normalizeLanguageFilter(Array.isArray(state.languageFilter) ? state.languageFilter : []),
    updatedAtMs: typeof state.updatedAtMs === "number" ? state.updatedAtMs : null,
  };
}

/**
 * The official LNReader feed is built in: every profile sees it, trusted and enabled, without
 * having to paste its URL. Users can still disable it; it is never removed. The record is added
 * in memory and persisted by the next save, so reading a state never writes to disk.
 */
export function withBuiltinNovelRepository(state: PersistedNovelRepositoryState): PersistedNovelRepositoryState {
  const normalizedUrl = normalizeNovelRepositoryUrl(BUILTIN_LNREADER_REPOSITORY_URL);
  const existing = state.repositories.find((repository) => repository.normalizedUrl === normalizedUrl);
  if (existing) {
    return existing.recommendedSeed
      ? state
      : replaceRepository(state, existing.id, (repository) => ({ ...repository, recommendedSeed: true }));
  }
  const scopedProfileId = state.scopeKey.startsWith("profile:") ? state.scopeKey.slice("profile:".length) : null;
  const withRepository = addNovelRepositoryToState(state, {
    profileId: scopedProfileId,
    url: BUILTIN_LNREADER_REPOSITORY_URL,
    recommendedSeed: true,
  });
  const added = withRepository.repositories.at(-1)!;
  return {
    ...withRepository,
    repositories: [added, ...withRepository.repositories.slice(0, -1)].map((repository) => (
      repository.id === added.id ? { ...repository, trustState: "trusted" as const, enabled: true } : repository
    )),
    updatedAtMs: state.updatedAtMs,
  };
}

export function isBuiltinNovelRepository(repository: Pick<NovelRepositoryRecord, "normalizedUrl">): boolean {
  return repository.normalizedUrl === normalizeNovelRepositoryUrl(BUILTIN_LNREADER_REPOSITORY_URL);
}

export async function loadNovelRepositoryState(scopeInput: NovelRepositoryScopeInput = {}): Promise<PersistedNovelRepositoryState> {
  const normalized = normalizeScopeInput(scopeInput);
  const raw = await invoke<string | null>("read_novel_repository_state", {
    profileId: normalized.profileId,
    serverUrl: normalized.serverUrl,
  });

  if (!raw) {
    return withBuiltinNovelRepository(createEmptyNovelRepositoryState(normalized));
  }

  try {
    return withBuiltinNovelRepository(normalizeNovelRepositoryState(JSON.parse(raw), normalized));
  } catch {
    return withBuiltinNovelRepository(createEmptyNovelRepositoryState(normalized));
  }
}

export async function saveNovelRepositoryState(
  state: PersistedNovelRepositoryState,
  scopeInput: NovelRepositoryScopeInput = {},
): Promise<PersistedNovelRepositoryState> {
  const normalized = normalizeNovelRepositoryState({
    ...state,
    updatedAtMs: Date.now(),
  }, scopeInput);

  const scope = normalizeScopeInput(scopeInput);
  await invoke("write_novel_repository_state", {
    contents: JSON.stringify(normalized, null, 2),
    profileId: scope.profileId,
    serverUrl: scope.serverUrl,
  });

  return normalized;
}

function replaceRepository(
  state: PersistedNovelRepositoryState,
  repositoryId: string,
  updater: (repository: NovelRepositoryRecord) => NovelRepositoryRecord,
): PersistedNovelRepositoryState {
  return {
    ...state,
    repositories: state.repositories.map((repository) => (
      repository.id === repositoryId ? updater(repository) : repository
    )),
    updatedAtMs: Date.now(),
  };
}

export function addNovelRepositoryToState(
  state: PersistedNovelRepositoryState,
  input: Omit<Parameters<typeof createNovelRepositoryRecord>[0], "profileId"> & { profileId?: string | null },
): PersistedNovelRepositoryState {
  const normalizedUrl = normalizeNovelRepositoryUrl(input.url);
  if (state.repositories.some((repository) => repository.normalizedUrl === normalizedUrl)) {
    throw new Error("This LNReader repository is already saved for the active profile.");
  }

  const profileId = normalizeLocalProfileId(input.profileId)
    ?? state.repositories[0]?.profileId
    ?? state.scopeKey;

  const nextRepository = createNovelRepositoryRecord({
    ...input,
    profileId,
  });

  return {
    ...state,
    repositories: [...state.repositories, nextRepository],
    updatedAtMs: Date.now(),
  };
}

export function removeNovelRepositoryFromState(
  state: PersistedNovelRepositoryState,
  repositoryId: string,
): PersistedNovelRepositoryState {
  if (state.repositories.some((repository) => repository.id === repositoryId && isBuiltinNovelRepository(repository))) {
    return state;
  }
  return {
    ...state,
    repositories: state.repositories.filter((repository) => repository.id !== repositoryId),
    catalogEntries: state.catalogEntries.filter((entry) => entry.repositoryId !== repositoryId),
    installedPlugins: state.installedPlugins.filter((entry) => entry.repositoryId !== repositoryId),
    updatedAtMs: Date.now(),
  };
}

export function setNovelRepositoryTrustState(
  state: PersistedNovelRepositoryState,
  repositoryId: string,
  trustState: NovelTrustState,
): PersistedNovelRepositoryState {
  return replaceRepository(state, repositoryId, (repository) => ({
    ...repository,
    trustState,
  }));
}

export function setNovelRepositoryEnabled(
  state: PersistedNovelRepositoryState,
  repositoryId: string,
  enabled: boolean,
): PersistedNovelRepositoryState {
  return replaceRepository(state, repositoryId, (repository) => ({
    ...repository,
    enabled,
  }));
}

export function setNovelRepositoryLanguageFilter(
  state: PersistedNovelRepositoryState,
  languages: readonly string[],
): PersistedNovelRepositoryState {
  return {
    ...state,
    languageFilter: normalizeLanguageFilter(languages),
    updatedAtMs: Date.now(),
  };
}

export function getVisibleNovelCatalogEntries(
  state: PersistedNovelRepositoryState,
  repositoryId?: string | null,
): NovelCatalogEntry[] {
  const filteredByRepository = repositoryId
    ? state.catalogEntries.filter((entry) => entry.repositoryId === repositoryId)
    : state.catalogEntries;

  return filterNovelCatalogEntriesByLanguage(
    filteredByRepository.slice().sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      return byName !== 0 ? byName : left.pluginId.localeCompare(right.pluginId);
    }),
    state.languageFilter,
  );
}

export function deriveNovelRepositoryUiState(
  repository: NovelRepositoryRecord,
  nowMs = Date.now(),
): NovelRepositoryUiState {
  if (!repository.enabled) return "disabled";
  if (repository.trustState === "blocked") return "blocked";
  if (repository.lastError) return "error";
  if (repository.trustState !== "trusted") return "untrusted";
  if (!repository.lastSuccessAtMs) return "empty";
  if (nowMs - repository.lastSuccessAtMs > 7 * 24 * 60 * 60 * 1000) return "stale";
  return "ready";
}

export async function refreshNovelRepositoryCatalog(
  state: PersistedNovelRepositoryState,
  repositoryId: string,
): Promise<NovelRepositoryRefreshResult> {
  const repository = state.repositories.find((entry) => entry.id === repositoryId);
  if (!repository) {
    throw new Error("LNReader repository not found.");
  }

  const fetchedAtMs = Date.now();
  const requestHeaders = buildNovelRepositoryFetchHeaders(repository);

  try {
    const response = await tauriFetch(repository.normalizedUrl, {
      method: "GET",
      headers: requestHeaders,
    });

    const metadata = extractNovelRepositoryRefreshMetadata(response.headers as Headers);

    if (response.status === 304) {
      const nextState = replaceRepository(state, repositoryId, (current) => ({
        ...current,
        lastFetchedAtMs: fetchedAtMs,
        lastSuccessAtMs: fetchedAtMs,
        etag: metadata.etag ?? current.etag,
        lastModified: metadata.lastModified ?? current.lastModified,
        lastError: null,
      }));

      const nextRepository = nextState.repositories.find((entry) => entry.id === repositoryId) ?? repository;
      return {
        state: nextState,
        repository: nextRepository,
        status: "not-modified",
        httpStatus: 304,
        catalogCount: state.catalogEntries.filter((entry) => entry.repositoryId === repositoryId).length,
        fetchedAtMs,
      };
    }

    if (!response.ok) {
      throw new Error(`Repository refresh failed with HTTP ${response.status}.`);
    }

    const manifest = await response.json();
    const entries = parseNovelCatalogEntries(manifest, {
      repositoryId,
      fetchedAtMs,
    });

    const nextState = replaceRepository({
      ...state,
      catalogEntries: [
        ...state.catalogEntries.filter((entry) => entry.repositoryId !== repositoryId),
        ...entries,
      ],
    }, repositoryId, (current) => ({
      ...current,
      lastFetchedAtMs: fetchedAtMs,
      lastSuccessAtMs: fetchedAtMs,
      etag: metadata.etag ?? current.etag,
      lastModified: metadata.lastModified ?? current.lastModified,
      lastError: null,
    }));

    const nextRepository = nextState.repositories.find((entry) => entry.id === repositoryId) ?? repository;
    return {
      state: nextState,
      repository: nextRepository,
      status: "updated",
      httpStatus: response.status,
      catalogCount: entries.length,
      fetchedAtMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown LNReader repository refresh error.";
    const nextState = replaceRepository(state, repositoryId, (current) => ({
      ...current,
      lastFetchedAtMs: fetchedAtMs,
      lastError: message,
    }));
    const nextRepository = nextState.repositories.find((entry) => entry.id === repositoryId) ?? repository;
    return {
      state: nextState,
      repository: nextRepository,
      status: "error",
      httpStatus: null,
      catalogCount: state.catalogEntries.filter((entry) => entry.repositoryId === repositoryId).length,
      fetchedAtMs,
    };
  }
}

export async function refreshAllNovelRepositories(
  state: PersistedNovelRepositoryState,
): Promise<{ state: PersistedNovelRepositoryState; results: NovelRepositoryRefreshResult[] }> {
  let nextState = state;
  const results: NovelRepositoryRefreshResult[] = [];

  for (const repository of state.repositories) {
    const result = await refreshNovelRepositoryCatalog(nextState, repository.id);
    nextState = result.state;
    results.push(result);
  }

  return { state: nextState, results };
}
