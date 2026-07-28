import type { Manga } from "../types";
import { resolveSearchResultsWithFallback } from "../search/queryFallback";
import { searchSourceManga } from "./runtime";

export type SourceMangaSearchCapability =
  | { status: "ok" }
  | { status: "unavailable"; message: string }
  | { status: "transient_error"; message: string };

function sourceSearchErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isSourceMangaSearchUnavailableError(error: unknown) {
  const message = sourceSearchErrorMessage(error);
  return /Stub!|UnsupportedOperationException|not implemented|Source not installed|does not support search|search unavailable/i.test(message);
}

export async function fetchSourceMangaSearchWithFallback(input: {
  sourceId: string;
  query: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<Manga[]> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 18000;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", abortFromParent, { once: true });

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    return await resolveSearchResultsWithFallback(input.query, async (attemptTerm) => {
      const result = await searchSourceManga(
        { source: input.sourceId, type: "SEARCH", page: 1, query: attemptTerm },
        controller.signal,
      );
      return result.fetchSourceManga.mangas ?? [];
    });
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    input.signal?.removeEventListener("abort", abortFromParent);
  }
}

export async function probeSourceMangaSearchCapability(input: {
  sourceId: string;
  query: string;
  timeoutMs?: number;
}): Promise<SourceMangaSearchCapability> {
  try {
    await fetchSourceMangaSearchWithFallback({
      sourceId: input.sourceId,
      query: input.query,
      timeoutMs: input.timeoutMs ?? 8000,
    });
    return { status: "ok" };
  } catch (error) {
    const message = sourceSearchErrorMessage(error);
    if (isSourceMangaSearchUnavailableError(error)) {
      return { status: "unavailable", message };
    }
    return { status: "transient_error", message };
  }
}
