import { createFirstRunState, FIRST_RUN_STORAGE_KEY } from "./firstRun";

/** Profiles seen holding works or sources since setup was last completed. */
export const FIRST_RUN_CONTENT_PROFILES_KEY = "epigraph-first-run-content-profiles";
const MAX_CONTENT_PROFILES = 32;

export type InstallContent = "empty" | "content" | "unknown";

/** What an install holds; every count must be known for it to be judged empty. */
export interface CleanInstallProbe {
  countComics(): Promise<number>;
  countBooks(): Promise<number>;
  countNovels(): Promise<number>;
  /** Extension repositories the user added and extensions installed, comics and novels. */
  countSourceSetup(): Promise<number>;
}

/**
 * "empty" when the app holds nothing at all: no works in the library and no sources set up, as
 * after its data was cleared. "content" as soon as any count is above zero. Anything else is
 * "unknown", so a server that is still starting or unreachable never sends a user back to setup.
 */
export async function readInstallContent(probe: CleanInstallProbe): Promise<InstallContent> {
  const counts = await Promise.allSettled([
    probe.countComics(),
    probe.countBooks(),
    probe.countNovels(),
    probe.countSourceSetup(),
  ]);
  if (counts.some((count) => count.status === "fulfilled" && count.value > 0)) return "content";
  return counts.every((count) => count.status === "fulfilled") ? "empty" : "unknown";
}

function readContentProfiles(storage: Pick<Storage, "getItem">): string[] {
  try {
    const value = JSON.parse(storage.getItem(FIRST_RUN_CONTENT_PROFILES_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** Remembers that the profile held works or sources after setup was completed. */
export function rememberProfileContent(storage: Pick<Storage, "getItem" | "setItem">, profileId: string): void {
  const profiles = readContentProfiles(storage);
  if (profiles.includes(profileId)) return;
  storage.setItem(FIRST_RUN_CONTENT_PROFILES_KEY, JSON.stringify([...profiles, profileId].slice(-MAX_CONTENT_PROFILES)));
}

/**
 * Whether an empty profile should send the user back to setup: only when it held something since
 * setup was completed, as when its data was cleared. A setup finished on an empty app, or an app
 * emptied by the user before it was ever seen full, opens normally instead of repeating setup.
 */
export function shouldReopenEmptyProfile(storage: Pick<Storage, "getItem">, profileId: string): boolean {
  return readContentProfiles(storage).includes(profileId);
}

/** Starts setup over: the next read of the marker reports first run as pending. */
export function reopenFirstRun(storage: Pick<Storage, "setItem" | "removeItem">): void {
  storage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify(createFirstRunState()));
  // Content counts again only once setup is done, so an empty app cannot reopen it in a loop.
  storage.removeItem(FIRST_RUN_CONTENT_PROFILES_KEY);
}

export function createProductionCleanInstallProbe(scope: { profileId: string; serverUrl: string }): CleanInstallProbe {
  return {
    async countComics() {
      const [{ waitForSuwayomiGraphqlReady }, { gql }, { GET_LIBRARY }] = await Promise.all([
        import("./suwayomiReadiness"),
        import("./startupClient"),
        import("./startupQueries"),
      ]);
      await waitForSuwayomiGraphqlReady("graphql", { attempts: 40, delayMs: 1000, timeoutMs: 5000 });
      const data = await gql<{ mangas: { nodes: unknown[] } }>(GET_LIBRARY, undefined, undefined, 12000);
      return data.mangas.nodes.length;
    },
    async countBooks() {
      const { loadBookLibraryState } = await import("./books/libraryState");
      return (await loadBookLibraryState({ profileId: scope.profileId })).books.length;
    },
    async countNovels() {
      const { loadNovelLibraryState } = await import("./novels/libraryState");
      return (await loadNovelLibraryState(scope)).entries.length;
    },
    async countSourceSetup() {
      const [{ waitForSuwayomiGraphqlReady }, { getManagedSourceRuntime }, novels] = await Promise.all([
        import("./suwayomiReadiness"),
        import("./manga/runtime"),
        import("./novels/repositoryState"),
      ]);
      await waitForSuwayomiGraphqlReady("extensions", { attempts: 40, delayMs: 1000, timeoutMs: 5000 });
      const runtime = await getManagedSourceRuntime();
      const [stores, extensions, novelState] = await Promise.all([
        runtime.listStores(),
        runtime.listExtensions(),
        novels.loadNovelRepositoryState(scope),
      ]);
      // The built-in novel repository is there from the start, so it is not a choice the user made.
      const novelRepositories = novelState.repositories.filter((repository) => !novels.isBuiltinNovelRepository(repository));
      return stores.length
        + extensions.filter((extension) => extension.isInstalled).length
        + novelRepositories.length
        + novelState.installedPlugins.length;
    },
  };
}
