import { gql } from "./client";
import { GET_EXTENSIONS, GET_SETTINGS, GET_SOURCES } from "./queries";
import type { Extension, Source } from "./types";
import { shouldHideSource } from "./util";

export type SetupStateKind =
  | "server_offline"
  | "no_extension_repos"
  | "no_installed_extensions"
  | "no_usable_sources"
  | "ready";

export type SetupSurface = "home" | "search" | "extensions";
export type SetupActionKind = "open_extensions" | "open_repo_manager" | "retry_connection";

export interface SetupState {
  kind: SetupStateKind;
  extensionRepoCount: number | null;
  installedExtensionCount: number | null;
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

export async function detectSetupState(settings: SetupSettings): Promise<SetupState> {
  try {
    const [settingsData, extensionsData, sourcesData] = await Promise.all([
      gql<{ settings: { extensionRepos: string[] } }>(GET_SETTINGS),
      gql<{ extensions: { nodes: Extension[] } }>(GET_EXTENSIONS),
      gql<{ sources: { nodes: Source[] } }>(GET_SOURCES),
    ]);

    const extensionRepoCount = settingsData.settings.extensionRepos?.length ?? 0;
    const installedExtensionCount = extensionsData.extensions.nodes.filter((ext) => ext.isInstalled).length;
    const allSources = sourcesData.sources.nodes.filter((src) => src.id !== "0");
    const usableSources = allSources.filter((src) => !shouldHideSource(src, settings));
    const totalSourceCount = allSources.length;
    const usableSourceCount = usableSources.length;
    const hiddenSourceCount = totalSourceCount - usableSourceCount;

    let kind: SetupStateKind = "ready";
    if (extensionRepoCount === 0) kind = "no_extension_repos";
    else if (installedExtensionCount === 0) kind = "no_installed_extensions";
    else if (usableSourceCount === 0) kind = "no_usable_sources";

    return {
      kind,
      extensionRepoCount,
      installedExtensionCount,
      totalSourceCount,
      usableSourceCount,
      hiddenSourceCount,
      errorMessage: null,
    };
  } catch (error) {
    return {
      kind: "server_offline",
      extensionRepoCount: null,
      installedExtensionCount: null,
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
    case "no_extension_repos":
      return {
        title: surface === "extensions" ? "Add an extension repository first" : "Extensions can't appear until a repository is added",
        body: "Suwayomi is connected, but the extension repository list is empty. Add at least one repository before looking for extensions or sources.",
        actions: surface === "extensions"
          ? [{ kind: "open_repo_manager", label: "Open Repo Manager" }]
          : [{ kind: "open_extensions", label: "Open Extensions" }],
      };
    case "no_installed_extensions":
      return {
        title: surface === "extensions" ? "Install your first extension" : "Aethon still needs an installed extension",
        body: "Repositories are configured, but no extension is installed yet. Install one extension before search and browsing will feel useful.",
        actions: surface === "extensions" ? [] : [{ kind: "open_extensions", label: "Open Extensions" }],
      };
    case "no_usable_sources": {
      const filterHint = state.hiddenSourceCount && state.hiddenSourceCount > 0
        ? " Current content filters may also be hiding all available sources."
        : "";
      return {
        title: surface === "search" ? "Search isn't ready to use yet" : "No usable sources are available yet",
        body: `Aethon can see installed extensions, but there are still no usable sources for browsing or search.${filterHint}`,
        actions: surface === "extensions" ? [] : [{ kind: "open_extensions", label: "Open Extensions" }],
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
