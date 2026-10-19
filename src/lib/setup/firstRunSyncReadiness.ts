import type { SyncdReplicationSnapshot } from "../syncdDesktop";
import {
  bumpContentSetupVersion,
  replaceBooksState,
  setLibraryMangaSnapshot,
  setSearchNovelLibrarySnapshot,
  store,
} from "../../store/state.svelte";
import { reloadBookLibraryState } from "../books/libraryState";
import { reloadNovelLibraryState } from "../novels/libraryState";

/** Pairing and persisted Live state are not evidence of a remote bootstrap. */
export function firstRunSyncReadinessKey(profileId: string | null, snapshot: SyncdReplicationSnapshot | null): string | null {
  if (!profileId || !snapshot || snapshot.localProfileId !== profileId
    || !snapshot.activeSessionKey || snapshot.paused || snapshot.lastError
    || snapshot.replicationStatus !== "live"
    || !Number.isSafeInteger(snapshot.remoteBootstrapGeneration)
    || (snapshot.remoteBootstrapGeneration ?? 0) <= 0) return null;
  // Progress checkpoints are expected to advance while the UI reads the domain stores.
  // They are evidence of replication progress, not a replacement of the attested worker.
  return JSON.stringify([profileId, snapshot.activeSessionKey, snapshot.remoteBootstrapGeneration]);
}

/** Read through the existing domain stores; never import or write remote data here. */
export async function refreshFirstRunSyncLibrary(
  profileId: string,
  stillCurrent: () => boolean,
  options: { requiresMangaRefresh?: boolean } = {},
): Promise<void> {
  const serverUrl = store.runtimeServerUrl;
  const assertCurrent = () => {
    if (!stillCurrent() || profileId !== (store.runtimeResolvedLocalProfileId ?? store.settings.defaultLocalProfileId)
      || serverUrl !== store.runtimeServerUrl) throw Error("RESTORE_TARGET_CHANGED");
  };
  assertCurrent();
  const scope = { profileId };
  const books = await reloadBookLibraryState(scope, { strict: true });
  assertCurrent();
  const novels = await reloadNovelLibraryState(scope, { strict: true });
  assertCurrent();
  const requiresMangaRefresh = options.requiresMangaRefresh ?? true;
  const manga = requiresMangaRefresh ? await (async () => {
    // A fresh install reaches this step before anything has started Suwayomi.
    const { ensureServerAwakeFor } = await import("../serverLifecycle");
    await ensureServerAwakeFor("startup", {
      serverUrl,
      binary: store.settings.serverBinary,
      updateIntensity: store.settings.libraryUpdateIntensity,
      profileId,
      profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? store.runtimeServerLabel,
    });
    assertCurrent();
    const { gql } = await import("../client");
    const { GET_LIBRARY } = await import("../queries");
    return gql<{ mangas: { nodes: import("../types").Manga[] } }>(GET_LIBRARY);
  })() : null;
  assertCurrent();
  if (requiresMangaRefresh && !Array.isArray(manga?.mangas?.nodes)) throw Error("SYNC_LIBRARY_REFRESH_FAILED");
  replaceBooksState(books);
  setSearchNovelLibrarySnapshot(novels.entries, novels.chapters);
  if (manga) {
    setLibraryMangaSnapshot(manga.mangas.nodes.map(entry => ({ ...entry,
      chapterCount: (entry as typeof entry & { chapters?: { totalCount?: number } }).chapters?.totalCount ?? entry.chapterCount ?? 0,
    })));
  }
  bumpContentSetupVersion();
}
