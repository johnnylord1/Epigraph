export const IMAGE_CACHE_MAX_ENTRIES = 240;
export const IMAGE_CACHE_MAX_BYTES = 192 * 1024 * 1024;

export type ImageCacheStats = {
  entryCount: number;
  inflightCount: number;
  totalCachedBytes: number;
  activeLeaseCount: number;
  maxEntries: number;
  maxBytes: number;
};

let readStats = (): ImageCacheStats => ({
  entryCount: 0,
  inflightCount: 0,
  totalCachedBytes: 0,
  activeLeaseCount: 0,
  maxEntries: IMAGE_CACHE_MAX_ENTRIES,
  maxBytes: IMAGE_CACHE_MAX_BYTES,
});
let trimLoadedCache = (_forceAll: boolean): void => {};

export function registerImageCacheStatsReader(reader: () => ImageCacheStats): void {
  readStats = reader;
}

export function registerImageCacheTrim(trim: (forceAll: boolean) => void): void {
  trimLoadedCache = trim;
}

export function trimImageCacheIfLoaded(forceAll = false): void {
  trimLoadedCache(forceAll);
}

export function getImageCacheStats(): ImageCacheStats {
  return readStats();
}
