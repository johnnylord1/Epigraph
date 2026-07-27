import type { Extension } from "./types";
import { createExtensionProvenance, type ExtensionProvenance, type ExtensionRef } from "./manga/runtime";
import type { InstalledNovelSourceDescriptor } from "./novels/domain";
import type { NovelCatalogEntry } from "./novels/contracts";
import type { NovelCatalogPluginStatus } from "./novels/repositories";

export type ManagedExtensionKind = "manga" | "novels";

export interface ManagedExtension {
  apkName: string;
  pkgName: string;
  name: string;
  lang: string;
  versionName: string;
  versionCode?: number;
  isInstalled: boolean;
  isObsolete: boolean;
  hasUpdate: boolean;
  iconUrl: string | null;
  kind: ManagedExtensionKind;
  repo?: string | null;
  repositoryUrl?: string;
  site?: string;
  novelPluginId?: string;
  novelRepositoryId?: string;
  novelStatus?: NovelCatalogPluginStatus;
  provenance?: ExtensionProvenance;
}

export function toManagedMangaExtension(extension: Extension): ManagedExtension {
  return {
    ...extension,
    kind: "manga",
  };
}

export function toManagedMangaRuntimeExtension(extension: ExtensionRef): ManagedExtension {
  const parsedVersionCode = Number(extension.versionCode);
  return {
    apkName: extension.apkName ?? extension.packageName,
    pkgName: extension.packageName,
    name: extension.name,
    lang: extension.language,
    versionName: extension.versionName,
    versionCode: Number.isSafeInteger(parsedVersionCode) ? parsedVersionCode : undefined,
    isInstalled: extension.isInstalled,
    isObsolete: extension.isObsolete,
    hasUpdate: extension.hasUpdate,
    iconUrl: extension.iconUrl,
    kind: "manga",
    repo: extension.storeId,
    provenance: createExtensionProvenance(extension),
  };
}

export function toManagedNovelSource(source: InstalledNovelSourceDescriptor): ManagedExtension {
  return {
    apkName: source.artifactUrl || source.artifactPath || source.pluginId,
    pkgName: `novel:${source.pluginId}`,
    name: source.name,
    lang: source.lang,
    versionName: source.version,
    isInstalled: true,
    isObsolete: false,
    hasUpdate: false,
    iconUrl: source.iconUrl,
    kind: "novels",
    repositoryUrl: source.repositoryUrl,
    site: source.site,
    novelPluginId: source.pluginId,
    novelRepositoryId: source.repositoryId,
    novelStatus: "installed",
  };
}

export function toManagedNovelCatalogEntry(
  entry: NovelCatalogEntry,
  status: NovelCatalogPluginStatus,
): ManagedExtension {
  return {
    apkName: entry.artifactUrl,
    pkgName: `novel:${entry.pluginId}`,
    name: entry.name,
    lang: entry.lang,
    versionName: entry.version,
    isInstalled: status !== "available",
    isObsolete: false,
    hasUpdate: status === "update-available",
    iconUrl: entry.iconUrl,
    kind: "novels",
    site: entry.site,
    novelPluginId: entry.pluginId,
    novelRepositoryId: entry.repositoryId,
    novelStatus: status,
  };
}
