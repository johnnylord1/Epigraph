import { gql } from "./client";
import { GET_EXTENSIONS, GET_SETTINGS, GET_SOURCES } from "./queries";
import type { Extension, Source } from "./types";
import { shouldHideSource } from "./util";

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

function isContentExtension(extension: Pick<Extension, "pkgName">): boolean {
  return !NON_CONTENT_EXTENSION_PKG_NAMES.has(extension.pkgName);
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
    const [settingsData, extensionsData, sourcesData] = await Promise.all([
      gql<{ settings: { extensionRepos: string[] } }>(GET_SETTINGS, undefined, signal),
      gql<{ extensions: { nodes: Extension[] } }>(GET_EXTENSIONS, undefined, signal),
      gql<{ sources: { nodes: Source[] } }>(GET_SOURCES, undefined, signal),
    ]);

    const extensionRepoCount = settingsData.settings.extensionRepos?.length ?? 0;
    const installedExtensions = extensionsData.extensions.nodes.filter((ext) => ext.isInstalled);
    const installedContentExtensions = installedExtensions.filter(isContentExtension);
    const installedHelperExtensions = installedExtensions.filter((ext) => !isContentExtension(ext));
    const installedExtensionCount = installedExtensions.length;
    const installedContentExtensionCount = installedContentExtensions.length;
    const installedHelperExtensionCount = installedHelperExtensions.length;
    const allSources = sourcesData.sources.nodes.filter((src) => src.id !== "0");
    const usableSources = allSources.filter((src) => !shouldHideSource(src, settings));
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

export function getSetupStatePresentation(state: SetupState, surface: SetupSurface): SetupStatePresentation {
  switch (state.kind) {
    case "server_offline":
      return {
        title: surface === "home" ? "Aethon can't reach Suwayomi yet" : "Suwayomi isn't reachable right now",
        body: "The app is running, but the server is unavailable, so extensions, sources, and search can't load yet.",
        actions: [{ kind: "retry_connection", label: "Retry connection" }],
      };
    case "server_initializing":
      return {
        title: "Suwayomi is preparing this profile",
        body: "The local server is running, but its database is not ready yet. Wait a moment, then retry loading sources.",
        actions: [{ kind: "retry_connection", label: "Retry" }],
      };
    case "no_extension_repos":
      return {
        title: surface === "extensions" ? "Add an extension repository first" : "Extensions can't appear until a repository is added",
        body: "Suwayomi is connected, but the extension repository list is empty. Add at least one repository before looking for extensions or sources.",
        actions: [
          { kind: "add_recommended_repo", label: "Add recommended repo" },
          { kind: surface === "extensions" ? "open_repo_manager" : "add_manually", label: "Add manually" },
        ],
      };
    case "no_installed_extensions":
      {
        const helperHint = state.installedHelperExtensionCount && state.installedHelperExtensionCount > 0
          ? " Helper extensions like the Suwayomi bridge do not unlock content browsing on their own."
          : "";
      return {
        title: surface === "extensions" ? "Install your first content extension" : "Aethon still needs a content extension",
        body: `A repository is configured, but there is still no installed content extension. Install one extension before search and browsing will feel useful.${helperHint}`,
        actions: surface === "extensions"
          ? [{ kind: "browse_available_extensions", label: "Browse available extensions" }]
          : [{ kind: "open_extensions", label: "Browse extensions" }],
      };
      }
    case "no_usable_sources": {
      const filterHint = state.hiddenSourceCount && state.hiddenSourceCount > 0
        ? " Current content filters may also be hiding all available sources."
        : "";
      return {
        title: surface === "search" ? "Search isn't ready to use yet" : "No usable sources are available yet",
        body: `Aethon can see installed extensions, but there are still no usable sources for browsing or search.${filterHint}`,
        actions: surface === "extensions"
          ? [{ kind: "browse_available_extensions", label: "Browse available extensions" }]
          : [{ kind: "open_extensions", label: "Open Extensions" }],
      };
    }
    case "ready":
    default:
      return {
        title: "Setup complete",
        body: "Aethon is configured enough for normal use.",
        actions: [],
      };
  }
}
