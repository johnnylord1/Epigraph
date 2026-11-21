import { invoke } from "@tauri-apps/api/core";

import { normalizeLocalProfileId, normalizeServerUrl } from "../localProfiles";
import type { NovelRepositoryScopeInput } from "./repositoryState";

/**
 * LNReader plugin settings (`pluginSettings`): the options a plugin declares for its own screen, as
 * `{ key: { label, value, type?, options? } }`. A missing or unknown type is a text field, as in
 * LNReader and the Android app. The chosen values live in a per-profile local file and are handed
 * to the plugin as its `storage` seed, so `storage.get(key)` returns them. Sync can rewrite that
 * file with a choice made on another device, so it is read again each time instead of cached.
 */
export type NovelPluginSettingType = "Switch" | "Select" | "CheckboxGroup" | "Text";

export interface NovelPluginSettingOption {
  value: string;
  label: string;
}

export interface NovelPluginSetting {
  key: string;
  label: string;
  type: NovelPluginSettingType;
  defaultValue: unknown;
  options: NovelPluginSettingOption[];
}

export type NovelPluginSettingValues = Record<string, unknown>;

interface PersistedNovelPluginSettings {
  version: 1;
  plugins: Record<string, NovelPluginSettingValues>;
}

export const NOVEL_PLUGIN_TEXT_SETTING_MAX_LENGTH = 4096;
const MAX_SETTINGS_PER_PLUGIN = 64;
const MAX_OPTIONS_PER_SETTING = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingType(raw: unknown): NovelPluginSettingType {
  return raw === "Switch" || raw === "Select" || raw === "CheckboxGroup" ? raw : "Text";
}

/** Reads a plugin's declared settings; malformed entries are skipped instead of failing the screen. */
export function parseNovelPluginSettings(raw: unknown): NovelPluginSetting[] {
  if (!isRecord(raw)) return [];
  const settings: NovelPluginSetting[] = [];
  for (const [key, entry] of Object.entries(raw)) {
    if (!key.trim() || !isRecord(entry) || settings.length >= MAX_SETTINGS_PER_PLUGIN) continue;
    const options = (Array.isArray(entry.options) ? entry.options : [])
      .slice(0, MAX_OPTIONS_PER_SETTING)
      .flatMap((option): NovelPluginSettingOption[] => {
        if (!isRecord(option) || option.value === undefined || option.value === null) return [];
        const value = String(option.value);
        const label = typeof option.label === "string" && option.label.trim() ? option.label : value;
        return [{ value, label }];
      });
    settings.push({
      key,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label : key,
      type: settingType(entry.type),
      defaultValue: entry.value,
      options,
    });
  }
  return settings;
}

/**
 * Returns the value to store for a setting, or `undefined` when the value does not fit what the
 * plugin declares (a choice it does not offer, a wrong shape or an oversized text).
 */
export function coerceNovelPluginSettingValue(setting: NovelPluginSetting, value: unknown): unknown {
  switch (setting.type) {
    case "Switch":
      return typeof value === "boolean" ? value : undefined;
    case "Select":
      return typeof value === "string" && setting.options.some((option) => option.value === value)
        ? value
        : undefined;
    case "CheckboxGroup": {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
      const offered = new Set(setting.options.map((option) => option.value));
      if (!value.every((entry) => offered.has(entry))) return undefined;
      return [...new Set(value)];
    }
    case "Text":
      return typeof value === "string" && value.length <= NOVEL_PLUGIN_TEXT_SETTING_MAX_LENGTH
        ? value
        : undefined;
  }
}

/** The value a setting shows: the stored one when it still fits, otherwise the plugin's default. */
export function currentNovelPluginSettingValue(
  setting: NovelPluginSetting,
  stored: NovelPluginSettingValues,
): unknown {
  if (Object.prototype.hasOwnProperty.call(stored, setting.key)) {
    const value = coerceNovelPluginSettingValue(setting, stored[setting.key]);
    if (value !== undefined) return value;
  }
  if (setting.type === "Switch") return setting.defaultValue === true;
  if (setting.type === "CheckboxGroup") {
    return Array.isArray(setting.defaultValue) ? setting.defaultValue.map(String) : [];
  }
  if (setting.defaultValue === undefined || setting.defaultValue === null) return "";
  return String(setting.defaultValue);
}

function normalizePersisted(raw: unknown): PersistedNovelPluginSettings {
  const plugins: Record<string, NovelPluginSettingValues> = {};
  if (isRecord(raw) && isRecord(raw.plugins)) {
    for (const [pluginId, values] of Object.entries(raw.plugins)) {
      if (pluginId.trim() && isRecord(values)) plugins[pluginId] = { ...values };
    }
  }
  return { version: 1, plugins };
}

function scopeArgs(scopeInput: NovelRepositoryScopeInput) {
  return {
    profileId: normalizeLocalProfileId(scopeInput.profileId),
    serverUrl: normalizeServerUrl(scopeInput.serverUrl),
  };
}

let writeQueue: Promise<unknown> = Promise.resolve();

async function readPersisted(scopeInput: NovelRepositoryScopeInput): Promise<PersistedNovelPluginSettings> {
  const raw = await invoke<string | null>("read_novel_plugin_settings", scopeArgs(scopeInput));
  if (!raw) return normalizePersisted(null);
  try {
    return normalizePersisted(JSON.parse(raw));
  } catch {
    return normalizePersisted(null);
  }
}

/** The values the user chose for one plugin; empty when none were saved or the file cannot be read. */
export async function loadNovelPluginSettingValues(
  scopeInput: NovelRepositoryScopeInput,
  pluginId: string,
): Promise<NovelPluginSettingValues> {
  try {
    const persisted = await readPersisted(scopeInput);
    return { ...(persisted.plugins[pluginId] ?? {}) };
  } catch {
    return {};
  }
}

/**
 * Saves one setting after checking it against the plugin's declaration. Writes run one at a time
 * and each reads the file first, so neither a quick second change nor a value sync just wrote is
 * overwritten.
 */
export function saveNovelPluginSettingValue(
  scopeInput: NovelRepositoryScopeInput,
  pluginId: string,
  setting: NovelPluginSetting,
  value: unknown,
): Promise<NovelPluginSettingValues> {
  const accepted = coerceNovelPluginSettingValue(setting, value);
  if (accepted === undefined) {
    return Promise.reject(new Error(`Invalid value for plugin setting ${setting.key}.`));
  }
  const run = writeQueue.then(async () => {
    const current = await readPersisted(scopeInput).catch(() => normalizePersisted(null));
    const next: PersistedNovelPluginSettings = {
      version: 1,
      plugins: {
        ...current.plugins,
        [pluginId]: { ...(current.plugins[pluginId] ?? {}), [setting.key]: accepted },
      },
    };
    await invoke("write_novel_plugin_settings", {
      contents: JSON.stringify(next, null, 2),
      ...scopeArgs(scopeInput),
    });
    return { ...next.plugins[pluginId] };
  });
  writeQueue = run.catch(() => undefined);
  return run;
}

/** Test hook: start each case with an empty write queue. */
export function resetNovelPluginSettingsCacheForTests(): void {
  writeQueue = Promise.resolve();
}
