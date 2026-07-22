export type NovelTrustState = "unknown" | "trusted" | "blocked";

export interface NovelRepositoryRecord {
  id: string;
  profileId: string;
  url: string;
  normalizedUrl: string;
  recommendedSeed: boolean;
  trustState: NovelTrustState;
  enabled: boolean;
  lastFetchedAtMs: number | null;
  lastSuccessAtMs: number | null;
  etag: string | null;
  lastModified: string | null;
  lastError: string | null;
}

export interface NovelCatalogEntry {
  repositoryId: string;
  pluginId: string;
  name: string;
  site: string;
  lang: string;
  version: string;
  artifactUrl: string;
  iconUrl: string | null;
  customJsUrl: string | null;
  customCssUrl: string | null;
  manifestHash: string | null;
  fetchedAtMs: number;
}

export interface InstalledNovelPluginRecord {
  profileId: string;
  repositoryId: string;
  pluginId: string;
  version: string;
  enabled: boolean;
  disabledReason: string | null;
  artifactPath: string;
  customJsPath: string | null;
  customCssPath: string | null;
  hasSettings: boolean;
  installedAtMs: number;
  updatedAtMs: number;
}

export interface NovelSourceSnapshotRepository {
  url: string;
}

export interface NovelSourceSnapshotPlugin {
  pluginId: string;
  version: string | null;
  repositoryUrl: string | null;
  enabled: boolean;
  trustState: NovelTrustState;
}

export interface NovelSourceSnapshotWhitelistedSettingKey {
  pluginId: string;
  key: string;
}

export interface NovelSourceSnapshot {
  repositories: NovelSourceSnapshotRepository[];
  installedPlugins: NovelSourceSnapshotPlugin[];
  availableSourceIds: string[];
  whitelistedPluginSettingKeys: NovelSourceSnapshotWhitelistedSettingKey[];
}

export interface NovelSourceSnapshotWhitelist {
  entries: NovelSourceSnapshotWhitelistedSettingKey[];
}

export type NovelRuntimeHostKind = "tauri-webview-window";

export type NovelRuntimeInvokeAction =
  | "source.popular"
  | "source.search"
  | "source.details"
  | "source.chapter"
  | "source.filters.read"
  | "source.settings.read"
  | "source.resolve-url";

export interface NovelRuntimeHostAdapter {
  kind: NovelRuntimeHostKind;
  start(): Promise<void>;
  stop(): Promise<void>;
  invoke<TPayload = unknown, TResult = unknown>(action: NovelRuntimeInvokeAction, payload: TPayload): Promise<TResult>;
  cancel(requestId: string): Promise<void>;
  health(): Promise<{ ok: boolean; hostKind: NovelRuntimeHostKind }>;
}

export interface NovelRuntimeCapabilityProfile {
  hostKind: NovelRuntimeHostKind;
  invokeWhitelist: readonly NovelRuntimeInvokeAction[];
  supportsCancel: boolean;
  supportsHealth: boolean;
}

export const NOVEL_RUNTIME_ALLOWED_ACTIONS = [
  "source.popular",
  "source.search",
  "source.details",
  "source.chapter",
  "source.filters.read",
  "source.settings.read",
  "source.resolve-url",
] as const satisfies readonly NovelRuntimeInvokeAction[];

export const NOVEL_SOURCE_SNAPSHOT_DENYLIST = [
  "cookies",
  "tokens",
  "credentials",
  "webStorage",
  "secret",
] as const;

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeNovelRepositoryUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function isNovelRuntimeActionWhitelisted(action: string): action is NovelRuntimeInvokeAction {
  return (NOVEL_RUNTIME_ALLOWED_ACTIONS as readonly string[]).includes(action);
}

export function createDefaultNovelRuntimeCapabilityProfile(): NovelRuntimeCapabilityProfile {
  return {
    hostKind: "tauri-webview-window",
    invokeWhitelist: NOVEL_RUNTIME_ALLOWED_ACTIONS,
    supportsCancel: true,
    supportsHealth: true,
  };
}

export function sanitizeNovelSourceSnapshotForSync(input: {
  repositories?: Array<{ url?: string | null } | null> | null;
  installedPlugins?: Array<{
    pluginId?: string | null;
    version?: string | null;
    repositoryUrl?: string | null;
    enabled?: boolean | null;
    trustState?: NovelTrustState | null;
  } | null> | null;
  availableSourceIds?: Array<string | null | undefined> | null;
  pluginSettings?: Record<string, Record<string, unknown>> | null;
}, whitelist: NovelSourceSnapshotWhitelist): NovelSourceSnapshot {
  const whitelistKeys = new Set(
    whitelist.entries
      .map((entry) => {
        const pluginId = normalizeText(entry.pluginId);
        const key = normalizeText(entry.key);
        return pluginId && key ? `${pluginId}::${key}` : null;
      })
      .filter((entry): entry is string => Boolean(entry)),
  );

  const repositories = (input.repositories ?? [])
    .map((entry) => normalizeText(entry?.url))
    .filter((url): url is string => Boolean(url))
    .map((url) => ({ url: normalizeNovelRepositoryUrl(url) }));

  const installedPlugins = (input.installedPlugins ?? [])
    .map((entry) => {
      const pluginId = normalizeText(entry?.pluginId);
      if (!pluginId) {
        return null;
      }

      return {
        pluginId,
        version: normalizeText(entry?.version),
        repositoryUrl: normalizeText(entry?.repositoryUrl)
          ? normalizeNovelRepositoryUrl(entry!.repositoryUrl as string)
          : null,
        enabled: entry?.enabled !== false,
        trustState: entry?.trustState === "trusted" || entry?.trustState === "blocked"
          ? entry.trustState
          : "unknown",
      } satisfies NovelSourceSnapshotPlugin;
    })
    .filter((entry): entry is NovelSourceSnapshotPlugin => Boolean(entry));

  const availableSourceIds = [...new Set(
    (input.availableSourceIds ?? [])
      .map((entry) => normalizeText(entry))
      .filter((entry): entry is string => Boolean(entry)),
  )];

  const whitelistedPluginSettingKeys: NovelSourceSnapshotWhitelistedSettingKey[] = [];
  for (const [pluginId, settings] of Object.entries(input.pluginSettings ?? {})) {
    const normalizedPluginId = normalizeText(pluginId);
    if (!normalizedPluginId || !settings || typeof settings !== "object") {
      continue;
    }

    for (const key of Object.keys(settings)) {
      const normalizedKey = normalizeText(key);
      if (!normalizedKey) {
        continue;
      }

      if (!whitelistKeys.has(`${normalizedPluginId}::${normalizedKey}`)) {
        continue;
      }

      whitelistedPluginSettingKeys.push({
        pluginId: normalizedPluginId,
        key: normalizedKey,
      });
    }
  }

  return {
    repositories,
    installedPlugins,
    availableSourceIds,
    whitelistedPluginSettingKeys,
  };
}
