import { createFirstRunState, FIRST_RUN_STORAGE_KEY } from "./firstRun";

/** What an install holds; every count must be known for it to be judged clean. */
export interface CleanInstallProbe {
  countComics(): Promise<number>;
  countBooks(): Promise<number>;
  countNovels(): Promise<number>;
  /** Extension repositories the user added and extensions installed, comics and novels. */
  countSourceSetup(): Promise<number>;
}

/**
 * True when the app holds nothing at all: no works in the library and no sources set up, as
 * after its data was cleared. Anything that cannot be read counts as not clean, so a server
 * that is still starting or unreachable never sends a user with a library back to setup.
 */
export async function isCleanInstall(probe: CleanInstallProbe): Promise<boolean> {
  try {
    const counts = await Promise.all([
      probe.countComics(),
      probe.countBooks(),
      probe.countNovels(),
      probe.countSourceSetup(),
    ]);
    return counts.every((count) => count === 0);
  } catch {
    return false;
  }
}

/** Starts setup over: the next read of the marker reports first run as pending. */
export function reopenFirstRun(storage: Pick<Storage, "setItem">): void {
  storage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify(createFirstRunState()));
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
