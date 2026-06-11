import type { Manga } from "../types";

const failedCoverKeys = new Set<string>();

export function createLibraryCoverStateKey(
  manga: Pick<Manga, "id" | "thumbnailUrl" | "title" | "source">,
  scopeKey = "",
): string {
  const sourceId = typeof manga.source?.id === "string" ? manga.source.id : "";
  return [
    scopeKey,
    manga.id,
    sourceId,
    manga.thumbnailUrl ?? "",
    typeof manga.title === "string" ? manga.title.trim().toLowerCase() : "",
  ].join("::");
}

export function hasLibraryCoverFailed(key: string): boolean {
  return failedCoverKeys.has(key);
}

export function markLibraryCoverFailed(key: string): void {
  failedCoverKeys.add(key);
}

export function clearLibraryCoverFailed(key: string): void {
  failedCoverKeys.delete(key);
}

