import { thumbUrl } from "../client";

export type ServiceIconKind = "extension" | "service" | "source" | "tracker";

export type ServiceIconInput =
  | string
  | null
  | undefined
  | {
      icon?: string | null;
      iconUrl?: string | null;
    };

export interface ServiceIconOptions {
  kind?: ServiceIconKind;
  fallback?: boolean;
}

const resolvedIconUrls = new Map<string, string>();
const fallbackUrls = new Map<ServiceIconKind, string>();

export function serviceIconPath(input: ServiceIconInput): string {
  if (typeof input === "string") return input.trim();
  const path = input?.iconUrl ?? input?.icon ?? "";
  return typeof path === "string" ? path.trim() : "";
}

function fallbackGlyph(kind: ServiceIconKind): string {
  if (kind === "tracker") return "T";
  if (kind === "extension") return "E";
  if (kind === "source") return "S";
  return "A";
}

function isBundledAppAsset(path: string): boolean {
  return path.startsWith("data:")
    || path.startsWith("blob:")
    || path.startsWith("asset:")
    || path.startsWith("/assets/")
    || path.startsWith("/src/assets/");
}

export function serviceIconFallbackUrl(kind: ServiceIconKind = "service"): string {
  const cached = fallbackUrls.get(kind);
  if (cached) return cached;

  const glyph = fallbackGlyph(kind);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="16" fill="#16131d"/>
    <rect x="1" y="1" width="62" height="62" rx="15" fill="none" stroke="#2d2639" stroke-width="2"/>
    <text x="32" y="39" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="24" font-weight="800" fill="#c8adff">${glyph}</text>
  </svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  fallbackUrls.set(kind, url);
  return url;
}

export function resolveServiceIconUrl(input: ServiceIconInput, options: ServiceIconOptions = {}): string {
  const kind = options.kind ?? "service";
  const path = serviceIconPath(input);
  if (!path) return options.fallback === false ? "" : serviceIconFallbackUrl(kind);

  const cacheKey = `${kind}::${path}`;
  const cached = resolvedIconUrls.get(cacheKey);
  if (cached) return cached;

  const url = isBundledAppAsset(path) ? path : thumbUrl(path);
  resolvedIconUrls.set(cacheKey, url);
  return url;
}

export function applyServiceIconFallback(event: Event, kind: ServiceIconKind = "service") {
  const target = event.currentTarget;
  if (!target || typeof target !== "object" || !("src" in target)) return;
  const image = target as HTMLImageElement;
  const fallback = serviceIconFallbackUrl(kind);
  if (image.src === fallback) return;
  image.dataset.epigraphIconFailed = "true";
  image.src = fallback;
}
