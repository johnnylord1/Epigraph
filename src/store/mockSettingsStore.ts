import { get, writable } from "svelte/store";
import type { ManagedExtension } from "../lib/managedExtensions";

export interface MockExtensionSettings {
  isEnabled: boolean;
  syncInterval: "manual" | "hourly" | "daily" | "weekly";
  languagePref: string;
  autoUpdate: boolean;
  credentials: {
    username: string;
    token: string;
  };
  updatedAt: string;
  extensionVersion: string;
}

export type MockExtensionSettingsPatch = Partial<
  Omit<MockExtensionSettings, "credentials">
> & {
  credentials?: Partial<MockExtensionSettings["credentials"]>;
};

type MockExtensionSettingsState = Record<string, MockExtensionSettings>;

const STORAGE_KEY = "aethon:mock-extension-settings:v1";

function createDefaultConfig(extension?: Pick<ManagedExtension, "lang" | "versionName">): MockExtensionSettings {
  return {
    isEnabled: true,
    syncInterval: "daily",
    languagePref: extension?.lang ?? "en",
    autoUpdate: true,
    credentials: {
      username: "",
      token: "",
    },
    updatedAt: new Date().toISOString(),
    extensionVersion: extension?.versionName ?? "",
  };
}

function loadInitialState(): MockExtensionSettingsState {
  if (typeof sessionStorage === "undefined") return {};

  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as MockExtensionSettingsState : {};
  } catch {
    return {};
  }
}

function persist(state: MockExtensionSettingsState) {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function mergeConfig(
  current: MockExtensionSettings,
  patch: MockExtensionSettingsPatch,
): MockExtensionSettings {
  return {
    ...current,
    ...patch,
    credentials: {
      ...current.credentials,
      ...(patch.credentials ?? {}),
    },
    updatedAt: new Date().toISOString(),
  };
}

const internal = writable<MockExtensionSettingsState>(loadInitialState());

internal.subscribe(persist);

function ensureConfig(pkgName: string, extension?: Pick<ManagedExtension, "lang" | "versionName">): MockExtensionSettings {
  const state = get(internal);
  const current = state[pkgName];
  if (current) return current;

  const created = createDefaultConfig(extension);
  internal.update((next) => ({ ...next, [pkgName]: created }));
  return created;
}

export const mockSettingsStore = {
  subscribe: internal.subscribe,
  getConfig(pkgName: string, extension?: Pick<ManagedExtension, "lang" | "versionName">): MockExtensionSettings {
    return ensureConfig(pkgName, extension);
  },
  updateConfig(pkgName: string, patch: MockExtensionSettingsPatch): void {
    internal.update((state) => {
      const current = state[pkgName] ?? createDefaultConfig();
      return {
        ...state,
        [pkgName]: mergeConfig(current, patch),
      };
    });
  },
  refreshConfig(pkgName: string, extension: Pick<ManagedExtension, "lang" | "versionName">): void {
    internal.update((state) => {
      const current = state[pkgName] ?? createDefaultConfig(extension);
      return {
        ...state,
        [pkgName]: {
          ...current,
          languagePref: current.languagePref || extension.lang,
          extensionVersion: extension.versionName,
          updatedAt: new Date().toISOString(),
        },
      };
    });
  },
};
