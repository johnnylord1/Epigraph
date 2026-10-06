import { cacheLibraryCoverFromServer, getCachedLibraryCoverUrl } from "./coverCache";
import type { Manga } from "../types";

type CoverCacheScope = Parameters<typeof getCachedLibraryCoverUrl>[0];

const WORKERS = 2;
const PAUSE_MS = 150;
const warmedScopes = new Set<string>();

/**
 * Fetches every library cover once per session, not only the cards scrolled into view. Fetching
 * through the server also fills the server's thumbnail cache, which is the only place paired
 * phones read covers from, so titles never opened on the desktop get covers there too.
 */
export async function warmAllLibraryCovers(scope: CoverCacheScope, mangas: readonly Manga[]): Promise<number> {
  const scopeKey = `${scope.profileId ?? ""}::${scope.serverUrl ?? ""}::${scope.coverCacheGeneration ?? ""}`;
  if (warmedScopes.has(scopeKey)) return 0;
  warmedScopes.add(scopeKey);
  const queue = mangas.filter((manga) => manga.thumbnailUrl);
  let next = 0;
  let fetched = 0;
  const worker = async () => {
    while (next < queue.length) {
      const manga = queue[next++];
      if (await getCachedLibraryCoverUrl(scope, manga)) continue;
      if (await cacheLibraryCoverFromServer(scope, manga)) fetched += 1;
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, queue.length) }, worker));
  return fetched;
}
