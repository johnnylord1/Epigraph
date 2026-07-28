import { normalizeSearchText } from "./normalize";
import { rankSearchResults } from "./ranking";
import type { SearchBrowseContentType, SearchBrowseSurface, SearchContext, SearchLibrarySection, SearchProvider, SearchResult } from "./types";

export interface SearchControllerOptions {
  remoteMinLength?: number;
  cacheSize?: number;
}

export class SearchController {
  private readonly providers: SearchProvider[];
  private readonly remoteMinLength: number;
  private readonly cacheSize: number;
  private readonly cache = new Map<string, SearchResult[]>();
  private requestId = 0;
  private activeAbort: AbortController | null = null;

  constructor(providers: SearchProvider[], options: SearchControllerOptions = {}) {
    this.providers = providers;
    this.remoteMinLength = options.remoteMinLength ?? 2;
    this.cacheSize = options.cacheSize ?? 32;
  }

  cancel() {
    this.requestId += 1;
    this.activeAbort?.abort();
    this.activeAbort = null;
  }

  searchLocal(
    context: SearchContext,
    query: string,
    librarySection?: SearchLibrarySection,
    browseContentType?: SearchBrowseContentType,
    browseSurface?: SearchBrowseSurface,
  ): SearchResult[] {
    const normalized = normalizeSearchText(query);
    if (!normalized) return [];
    const results = this.providers
      .filter((provider) => !provider.remote && provider.contexts.includes(context))
      .flatMap((provider) => {
        const result = provider.search({ context, librarySection, browseContentType, browseSurface, query: normalized, signal: new AbortController().signal });
        if (result instanceof Promise) return [];
        return result;
      });
    return rankSearchResults(results, normalized, context);
  }

  async searchRemote(
    context: SearchContext,
    query: string,
    librarySection?: SearchLibrarySection,
    browseContentType?: SearchBrowseContentType,
    browseSurface?: SearchBrowseSurface,
  ): Promise<SearchResult[]> {
    const normalized = normalizeSearchText(query);
    if (normalized.length < this.remoteMinLength) return [];
    const cacheKey = `${context}:${librarySection ?? ""}:${browseContentType ?? ""}:${browseSurface ?? ""}:${normalized}`;
    this.cancel();
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const id = this.requestId;
    const controller = new AbortController();
    this.activeAbort = controller;
    try {
      const results = (await Promise.all(
        this.providers
          .filter((provider) => provider.remote && provider.contexts.includes(context))
          .map((provider) => provider.search({ context, librarySection, browseContentType, browseSurface, query: normalized, signal: controller.signal })),
      )).flat();
      if (id !== this.requestId || controller.signal.aborted) return [];
      const ranked = rankSearchResults(results, normalized, context);
      this.cache.set(cacheKey, ranked);
      while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
      return ranked;
    } finally {
      if (this.activeAbort === controller) this.activeAbort = null;
    }
  }
}
