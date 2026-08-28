import { thumbUrl } from "../client";

export type MangaCoverPersistence = "persistent" | "memory" | "none";

export type MangaCoverContext =
  | "activity"
  | "browse"
  | "detail"
  | "discover"
  | "downloads"
  | "home"
  | "library"
  | "migration"
  | "preview"
  | "source"
  | "tracking";

export type MangaCoverInput =
  | string
  | null
  | undefined
  | {
      thumbnailUrl?: string | null;
    };

export interface MangaCoverOptions {
  context?: MangaCoverContext;
  persistence?: MangaCoverPersistence;
  cacheGeneration?: number | string | null;
}

export interface ResolvedMangaCover {
  path: string;
  url: string;
  context: MangaCoverContext;
  persistence: MangaCoverPersistence;
}

export function mangaCoverPath(input: MangaCoverInput): string {
  const path = typeof input === "string" ? input : input?.thumbnailUrl;
  return typeof path === "string" ? path.trim() : "";
}

function appendCoverParams(url: string, options: MangaCoverOptions): string {
  const generation = `${options.cacheGeneration ?? ""}`.trim();
  if (!generation) return url;
  const params = [`epigraph_cover_generation=${encodeURIComponent(generation)}`];
  return `${url}${url.includes("?") ? "&" : "?"}${params.join("&")}`;
}

export function resolveMangaCover(input: MangaCoverInput, options: MangaCoverOptions = {}): ResolvedMangaCover | null {
  const path = mangaCoverPath(input);
  if (!path) return null;

  const context = options.context ?? "library";
  const persistence = options.persistence ?? (context === "browse" || context === "discover" || context === "source" ? "memory" : "persistent");
  const url = appendCoverParams(thumbUrl(path), options);

  return {
    path,
    url,
    context,
    persistence,
  };
}

export function resolveMangaCoverUrl(input: MangaCoverInput, options: MangaCoverOptions = {}): string {
  return resolveMangaCover(input, options)?.url ?? "";
}
