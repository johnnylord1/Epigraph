import { getManagedSourceRuntime } from "./manga/runtime";
import type { ExtensionRef, SourceRef } from "./manga/runtime";
import { shouldHideSource } from "./util";
import { translate } from "./i18n/runtime";

const NON_CONTENT_EXTENSION_PKG_NAMES = new Set([
  "eu.kanade.tachiyomi.extension.all.tachidesk",
]);

export type SetupStateKind =
  | "server_offline"
  | "server_initializing"
  | "no_extension_repos"
  | "no_installed_extensions"
  | "no_usable_sources"
  | "ready";

export type SetupSurface = "home" | "search" | "extensions";
export type SetupActionKind =
  | "add_recommended_repo"
  | "add_manually"
  | "browse_available_extensions"
  | "open_extensions"
  | "open_repo_manager"
  | "retry_connection";

export interface SetupState {
  kind: SetupStateKind;
  extensionRepoCount: number | null;
  installedExtensionCount: number | null;
  installedContentExtensionCount: number | null;
  installedHelperExtensionCount: number | null;
  totalSourceCount: number | null;
  usableSourceCount: number | null;
  hiddenSourceCount: number | null;
  errorMessage?: string | null;
}

export interface SetupStatePresentation {
  title: string;
  body: string;
  actions: { kind: SetupActionKind; label: string }[];
}

type SetupSettings = {
  showNsfw: boolean;
  nsfwAllowedSourceIds: string[];
  nsfwBlockedSourceIds: string[];
};

function isContentExtension(extension: Pick<ExtensionRef, "packageName">): boolean {
  return !NON_CONTENT_EXTENSION_PKG_NAMES.has(extension.packageName);
}

function sourceVisibilityShape(source: SourceRef) {
  return {
    id: source.id,
    name: source.name,
    lang: source.language,
    displayName: source.displayName,
    iconUrl: source.iconUrl ?? "",
    isNsfw: source.isNsfw,
  };
}

export function isSuwayomiSchemaInitializingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /JdbcSQLSyntaxErrorException/i.test(message)
    && /Table\s+"(?:MANGA|SOURCE|EXTENSION|TRACKRECORD)"\s+not\s+found/i.test(message);
}

export async function detectSetupState(
  settings: SetupSettings,
  signal?: AbortSignal,
): Promise<SetupState> {
  try {
    const runtime = await getManagedSourceRuntime();
    const [stores, extensions, sources] = await Promise.all([
      runtime.listStores(signal),
      runtime.listExtensions(signal),
      runtime.listSources(signal),
    ]);

    const extensionRepoCount = stores.length;
    const installedExtensions = extensions.filter((ext) => ext.isInstalled);
    const installedContentExtensions = installedExtensions.filter(isContentExtension);
    const installedHelperExtensions = installedExtensions.filter((ext) => !isContentExtension(ext));
    const installedExtensionCount = installedExtensions.length;
    const installedContentExtensionCount = installedContentExtensions.length;
    const installedHelperExtensionCount = installedHelperExtensions.length;
    const allSources = sources.filter((src) => src.id !== "0");
    const usableSources = allSources.filter(
      (src) => !shouldHideSource(sourceVisibilityShape(src), settings),
    );
    const totalSourceCount = allSources.length;
    const usableSourceCount = usableSources.length;
    const hiddenSourceCount = totalSourceCount - usableSourceCount;

    let kind: SetupStateKind = "ready";
    if (extensionRepoCount === 0) kind = "no_extension_repos";
    else if (installedContentExtensionCount === 0) kind = "no_installed_extensions";
    // If sources exist but are currently hidden by content filters, the app is
    // configured; that is a visibility issue, not an onboarding/setup failure.
    else if (totalSourceCount === 0) kind = "no_usable_sources";

    return {
      kind,
      extensionRepoCount,
      installedExtensionCount,
      installedContentExtensionCount,
      installedHelperExtensionCount,
      totalSourceCount,
      usableSourceCount,
      hiddenSourceCount,
      errorMessage: null,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isSuwayomiSchemaInitializingError(error)) {
      return {
        kind: "server_initializing",
        extensionRepoCount: null,
        installedExtensionCount: null,
        installedContentExtensionCount: null,
        installedHelperExtensionCount: null,
        totalSourceCount: null,
        usableSourceCount: null,
        hiddenSourceCount: null,
        errorMessage: null,
      };
    }
    return {
      kind: "server_offline",
      extensionRepoCount: null,
      installedExtensionCount: null,
      installedContentExtensionCount: null,
      installedHelperExtensionCount: null,
      totalSourceCount: null,
      usableSourceCount: null,
      hiddenSourceCount: null,
      errorMessage: error instanceof Error ? error.message : "Unable to reach Suwayomi.",
    };
  }
}

type SetupTranslate = (id: string, values?: Record<string, unknown>) => string;

export function getSetupStatePresentation(
  state: SetupState,
  surface: SetupSurface,
  t: SetupTranslate = translate,
): SetupStatePresentation {
  switch (state.kind) {
    case "server_offline":
      return {
        title: t(surface === "home" ? "setup.serverOfflineHomeTitle" : "setup.serverOfflineTitle"),
        body: t("setup.serverOfflineBody"),
        actions: [{ kind: "retry_connection", label: t("setup.retryConnection") }],
      };
    case "server_initializing":
      return {
        title: t("setup.initializingTitle"),
        body: t("setup.initializingBody"),
        actions: [{ kind: "retry_connection", label: t("setup.retry") }],
      };
    case "no_extension_repos":
      return {
        title: t(surface === "extensions" ? "setup.noReposExtensionsTitle" : "setup.noReposTitle"),
        body: t("setup.noReposBody"),
        actions: [
          { kind: "add_recommended_repo", label: t("setup.addRecommendedRepo") },
          { kind: surface === "extensions" ? "open_repo_manager" : "add_manually", label: t("setup.addManually") },
        ],
      };
    case "no_installed_extensions":
      {
        const helperHint = state.installedHelperExtensionCount && state.installedHelperExtensionCount > 0
          ? ` ${t("setup.helperHint")}`
          : "";
      return {
        title: t(surface === "extensions" ? "setup.noExtensionsExtensionsTitle" : "setup.noExtensionsTitle"),
        body: `${t("setup.noExtensionsBody")}${helperHint}`,
        actions: surface === "extensions"
          ? [{ kind: "browse_available_extensions", label: t("setup.browseAvailableExtensions") }]
          : [{ kind: "open_extensions", label: t("setup.browseExtensions") }],
      };
      }
    case "no_usable_sources": {
      const filterHint = state.hiddenSourceCount && state.hiddenSourceCount > 0
        ? ` ${t("setup.filterHint")}`
        : "";
      return {
        title: t(surface === "search" ? "setup.noSourcesSearchTitle" : "setup.noSourcesTitle"),
        body: `${t("setup.noSourcesBody")}${filterHint}`,
        actions: surface === "extensions"
          ? [{ kind: "browse_available_extensions", label: t("setup.browseAvailableExtensions") }]
          : [{ kind: "open_extensions", label: t("setup.openExtensions") }],
      };
    }
    case "ready":
    default:
      return {
        title: t("setup.completeTitle"),
        body: t("setup.completeBody"),
        actions: [],
      };
  }
}
