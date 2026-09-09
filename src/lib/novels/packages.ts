import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import type { InstalledNovelPluginRecord, NovelCatalogEntry } from "./contracts";
import type { NovelRepositoryScopeInput, PersistedNovelRepositoryState } from "./repositoryState";
import { canInstallNovelRepository, deriveNovelCatalogPluginState } from "./repositories";

interface InstallNovelPluginInput {
  state: PersistedNovelRepositoryState;
  entry: NovelCatalogEntry;
  scopeInput?: NovelRepositoryScopeInput;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function encodeBytesAsBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    const maybeBuffer = (globalThis as {
      Buffer?: { from(input: Uint8Array): { toString(encoding: string): string } };
    }).Buffer;
    if (!maybeBuffer) {
      throw new Error("No base64 encoder is available in this runtime.");
    }
    return maybeBuffer.from(bytes).toString("base64");
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function extensionFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\.([a-z0-9]+)$/i);
    return match?.[1]?.toLowerCase() ?? fallback;
  } catch {
    return fallback;
  }
}

function pluginVersionRoot(root: string, entry: NovelCatalogEntry): string {
  return `${root}\\plugins\\${entry.pluginId}\\${entry.version}`;
}

function pluginSettingsRoot(root: string, entry: NovelCatalogEntry): string {
  return `${root}\\plugins\\${entry.pluginId}`;
}

async function resolveNovelStorageRoot(scopeInput: NovelRepositoryScopeInput = {}): Promise<string> {
  return invoke<string>("resolve_novel_storage_root", {
    profileId: scopeInput.profileId ?? null,
    serverUrl: scopeInput.serverUrl ?? null,
  });
}

async function writeBase64File(path: string, bytesBase64: string): Promise<string> {
  return invoke<string>("write_file_base64", {
    path,
    bytesBase64,
  });
}

async function fetchUrlAsBase64(url: string): Promise<string> {
  const response = await tauriFetch(url, {
    method: "GET",
    headers: {
      Accept: "*/*",
    },
  });
  if (!response.ok) {
    throw new Error(`Plugin asset fetch failed with HTTP ${response.status} for ${url}.`);
  }

  const buffer = await response.arrayBuffer();
  return encodeBytesAsBase64(new Uint8Array(buffer));
}

function upsertInstalledPlugin(
  state: PersistedNovelRepositoryState,
  record: InstalledNovelPluginRecord,
): PersistedNovelRepositoryState {
  const withoutExisting = state.installedPlugins.filter((entry) => entry.pluginId !== record.pluginId);
  return {
    ...state,
    installedPlugins: [...withoutExisting, record].sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
    updatedAtMs: Date.now(),
  };
}

export async function installNovelCatalogPlugin(input: InstallNovelPluginInput): Promise<PersistedNovelRepositoryState> {
  const repository = input.state.repositories.find((entry) => entry.id === input.entry.repositoryId);
  if (!repository) {
    throw new Error("Repository for this plugin is no longer available.");
  }
  if (!repository.enabled) {
    throw new Error("Enable the repository before installing its plugins.");
  }
  if (!canInstallNovelRepository(repository.trustState)) {
    throw new Error("Only trusted repositories can install plugins.");
  }

  if (input.state.installedPlugins.some((plugin) => (
    plugin.pluginId === input.entry.pluginId && plugin.repositoryId !== repository.id
  ))) {
    throw new Error("This plugin is already installed from another repository. Review the existing installation in Sources before replacing it.");
  }

  const storageRoot = await resolveNovelStorageRoot(input.scopeInput);
  const versionRoot = pluginVersionRoot(storageRoot, input.entry);
  const settingsRoot = pluginSettingsRoot(storageRoot, input.entry);

  const artifactExt = extensionFromUrl(input.entry.artifactUrl, "js");
  const artifactPath = await writeBase64File(
    `${versionRoot}\\index.${artifactExt}`,
    await fetchUrlAsBase64(input.entry.artifactUrl),
  );

  let customJsPath: string | null = null;
  if (input.entry.customJsUrl) {
    customJsPath = await writeBase64File(
      `${versionRoot}\\custom.${extensionFromUrl(input.entry.customJsUrl, "js")}`,
      await fetchUrlAsBase64(input.entry.customJsUrl),
    );
  }

  let customCssPath: string | null = null;
  if (input.entry.customCssUrl) {
    customCssPath = await writeBase64File(
      `${versionRoot}\\custom.${extensionFromUrl(input.entry.customCssUrl, "css")}`,
      await fetchUrlAsBase64(input.entry.customCssUrl),
    );
  }

  if (input.entry.iconUrl) {
    const iconExt = extensionFromUrl(input.entry.iconUrl, "png");
    await writeBase64File(
      `${versionRoot}\\icon.${iconExt}`,
      await fetchUrlAsBase64(input.entry.iconUrl),
    );
  }

  const settingsPath = `${settingsRoot}\\settings.json`;
  await writeBase64File(settingsPath, encodeBytesAsBase64(new TextEncoder().encode("{}")));

  return upsertInstalledPlugin(input.state, {
    profileId: repository.profileId,
    repositoryId: input.entry.repositoryId,
    pluginId: input.entry.pluginId,
    version: input.entry.version,
    enabled: true,
    disabledReason: null,
    artifactPath,
    customJsPath,
    customCssPath,
    hasSettings: true,
    installedAtMs: Date.now(),
    updatedAtMs: Date.now(),
  });
}

export function setInstalledNovelPluginEnabled(
  state: PersistedNovelRepositoryState,
  pluginId: string,
  enabled: boolean,
): PersistedNovelRepositoryState {
  return {
    ...state,
    installedPlugins: state.installedPlugins.map((entry) => (
      entry.pluginId === pluginId
        ? {
            ...entry,
            enabled,
            disabledReason: enabled ? null : "user-disabled",
            updatedAtMs: Date.now(),
          }
        : entry
    )),
    updatedAtMs: Date.now(),
  };
}

export async function removeInstalledNovelPlugin(
  state: PersistedNovelRepositoryState,
  pluginId: string,
  scopeInput?: NovelRepositoryScopeInput,
): Promise<PersistedNovelRepositoryState> {
  await invoke("remove_novel_plugin_installation", {
    pluginId,
    profileId: scopeInput?.profileId ?? null,
    serverUrl: scopeInput?.serverUrl ?? null,
  });

  return {
    ...state,
    installedPlugins: state.installedPlugins.filter((entry) => entry.pluginId !== pluginId),
    updatedAtMs: Date.now(),
  };
}

export function getInstalledNovelPlugin(
  state: PersistedNovelRepositoryState,
  pluginId: string,
): InstalledNovelPluginRecord | null {
  return state.installedPlugins.find((entry) => entry.pluginId === pluginId) ?? null;
}

export function getNovelCatalogEntryInstallState(
  state: PersistedNovelRepositoryState,
  entry: NovelCatalogEntry,
) {
  return deriveNovelCatalogPluginState(entry, getInstalledNovelPlugin(state, entry.pluginId));
}

export function getInstalledNovelSources(state: PersistedNovelRepositoryState): string[] {
  return state.installedPlugins
    .filter((entry) => entry.enabled)
    .map((entry) => entry.pluginId)
    .sort((left, right) => left.localeCompare(right));
}

export function getInstalledNovelArtifactPath(
  state: PersistedNovelRepositoryState,
  pluginId: string,
): string | null {
  return normalizeText(getInstalledNovelPlugin(state, pluginId)?.artifactPath);
}
