import pako from "pako";

/**
 * Shared library import link format (`epigraph-share-v1`), mirrored in Epigraph Mobile
 * (`epigraph.library.LibraryShareLink`).
 *
 * Small selections travel directly in the URL fragment (`d.<base64url(gzip(json))>`) so they
 * work offline and never expire. Larger selections embed the exact same `d.<...>` token inside a
 * standard PNG `tEXt` chunk (`epigraph-share`) of the already-hosted share card and use a short
 * pointer token (`l.<id>`, `c.<id>`, or `u.<sub>.<id>`).
 */

export const SHARE_PAGE_URL = "https://johnnylord1.github.io/Epigraph/share/";
export const SHARE_APP_SCHEME = "epigraph";
export const SHARE_APP_HOST = "import";
export const SHARE_PNG_CHUNK_KEYWORD = "epigraph-share";
export const SHARE_GITHUB_FALLBACK_URL = "https://github.com/johnnylord1/Epigraph/releases";

/** Keep inline URLs concise; larger selections switch to the short hosted-PNG pointer token. */
export const INLINE_TOKEN_PREFERRED_MAX = 800;
/** Hard safety cap for inline tokens accepted from external links. */
export const INLINE_TOKEN_HARD_MAX = 16384;
const MAX_DECOMPRESSED_BYTES = 1024 * 1024;
const MAX_MANIFEST_WORKS = 2000;
const MAX_MANIFEST_SOURCES = 500;

export interface ShareManifestSource {
  sourceId: string;
  name: string;
  lang?: string | null;
  pkgName?: string | null;
  repoUrl?: string | null;
}

export type ShareManifestWorkKind = "comic" | "book";

export interface ShareManifestWork {
  /** Empty string when the work is local and cannot be imported remotely. */
  sourceId: string;
  /** Source-relative manga URL (e.g. `/manga/solo-leveling`), empty for local works. */
  url: string;
  title: string;
  /** Optional public webpage URL (`http(s)://...`) for clicking the work on the web share page. */
  webUrl?: string | null;
  /** Optional public cover image URL (`https://...`) for rendering the work card on the web share page. */
  coverUrl?: string | null;
  /** Optional library section (`"comic"` or `"book"`) so mixed shares split Comics and Books. */
  kind?: ShareManifestWorkKind | null;
}

export interface ShareManifest {
  version: 1;
  sources: ShareManifestSource[];
  works: ShareManifestWork[];
}

export type ShareHostedKind =
  | "freeimage"
  | "kappa"
  | "pomf2"
  | "x0at"
  | "uguu"
  | "catbox"
  | "litterbox";

export type ShareLinkToken =
  | { kind: "inline"; token: string }
  | { kind: "hosted"; token: string; host: ShareHostedKind; url: string };

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const INLINE_TOKEN_RE = /^d\.([A-Za-z0-9_-]{8,16384})$/;
const EMBEDDED_TOKEN_RE = /^d\.([A-Za-z0-9_-]{8,1400000})$/;
const SIMPLE_HOST_TOKEN_RE = /^([lcikpa])\.([A-Za-z0-9_-]{1,64})$/;
const UGUU_HOST_TOKEN_RE = /^u\.([A-Za-z0-9]{1,16})\.([A-Za-z0-9_-]{1,64})$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function sanitizePublicRepoUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase();
    if (
      !host
      || host === "localhost"
      || host === "0.0.0.0"
      || host.endsWith(".local")
      || /^127\./.test(host)
      || /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      || host === "::1"
      || host.startsWith("[")
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function normalizeSourceId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^-?\d{1,20}$/.test(trimmed) ? trimmed : "";
}

function cleanText(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function sanitizePublicWebUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function normalizeWorkKind(value: unknown): ShareManifestWorkKind | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "b" || normalized === "book") return "book";
  if (normalized === "c" || normalized === "comic") return "comic";
  return null;
}

/** Builds a deduplicated v1 share manifest from selected library works. */
export function buildShareManifest(
  works: readonly {
    title: string;
    sourceId?: string | null;
    url?: string | null;
    sourceName?: string | null;
    sourceLang?: string | null;
    extensionPkgName?: string | null;
    repoUrl?: string | null;
    webUrl?: string | null;
    coverUrl?: string | null;
    kind?: ShareManifestWorkKind | null;
  }[],
): ShareManifest {
  const sources: ShareManifestSource[] = [];
  const sourceIndexById = new Map<string, number>();
  const manifestWorks: ShareManifestWork[] = [];

  for (const work of works.slice(0, MAX_MANIFEST_WORKS)) {
    const title = cleanText(work.title, 300);
    if (!title) continue;
    const sourceId = normalizeSourceId(work.sourceId);
    const url = typeof work.url === "string" ? work.url.trim().slice(0, 1024) : "";
    const isRemote = Boolean(sourceId && sourceId !== "0" && url);
    const webUrl = sanitizePublicWebUrl(work.webUrl);
    const coverUrl = sanitizePublicRepoUrl(work.coverUrl);
    const kind = normalizeWorkKind(work.kind);
    const extra: { webUrl?: string | null; coverUrl?: string | null; kind?: ShareManifestWorkKind | null } = {};
    if (webUrl) extra.webUrl = webUrl;
    if (coverUrl) extra.coverUrl = coverUrl;
    if (kind) extra.kind = kind;

    if (isRemote) {
      const existingIndex = sourceIndexById.get(sourceId);
      if (existingIndex === undefined) {
        if (sources.length < MAX_MANIFEST_SOURCES) {
          sourceIndexById.set(sourceId, sources.length);
          sources.push({
            sourceId,
            name: cleanText(work.sourceName, 120) || `Source ${sourceId}`,
            lang: cleanText(work.sourceLang, 16) || null,
            pkgName: cleanText(work.extensionPkgName, 160) || null,
            repoUrl: sanitizePublicRepoUrl(work.repoUrl),
          });
        }
      } else {
        const entry = sources[existingIndex]!;
        if (!entry.pkgName && work.extensionPkgName) entry.pkgName = cleanText(work.extensionPkgName, 160) || null;
        if (!entry.repoUrl && work.repoUrl) entry.repoUrl = sanitizePublicRepoUrl(work.repoUrl);
      }
      manifestWorks.push({ sourceId, url, title, ...extra });
    } else {
      manifestWorks.push({ sourceId: "", url: "", title, ...extra });
    }
  }

  return { version: 1, sources, works: manifestWorks };
}

/** Encodes a manifest into a compact `d.<base64url(gzip(json))>` token. */
export function encodeShareManifest(manifest: ShareManifest): string {
  const sourceIndex = new Map<string, number>();
  const wireSources = manifest.sources.slice(0, MAX_MANIFEST_SOURCES).map((source, index) => {
    sourceIndex.set(source.sourceId, index);
    const tuple: (string | null)[] = [source.sourceId, source.name];
    const lang = source.lang?.trim() || null;
    const pkg = source.pkgName?.trim() || null;
    const repo = sanitizePublicRepoUrl(source.repoUrl);
    if (lang || pkg || repo) tuple.push(lang);
    if (pkg || repo) tuple.push(pkg);
    if (repo) tuple.push(repo);
    return tuple;
  });

  const wireWorks = manifest.works.slice(0, MAX_MANIFEST_WORKS).map((work) => {
    const idx = work.sourceId && work.url ? (sourceIndex.get(work.sourceId) ?? -1) : -1;
    const tuple: (number | string | null)[] = [idx, idx >= 0 ? work.url : "", work.title];
    const webUrl = sanitizePublicWebUrl(work.webUrl);
    const coverUrl = sanitizePublicRepoUrl(work.coverUrl);
    const kind = normalizeWorkKind(work.kind);
    const wireKind = kind === "book" ? "b" : kind === "comic" ? "c" : null;
    if (webUrl || coverUrl || wireKind) tuple.push(webUrl);
    if (coverUrl || wireKind) tuple.push(coverUrl);
    if (wireKind) tuple.push(wireKind);
    return tuple;
  });

  const json = JSON.stringify({ v: 1, s: wireSources, w: wireWorks });
  const compressed = pako.gzip(TEXT_ENCODER.encode(json));
  return `d.${toBase64Url(compressed)}`;
}

/** Decodes a `d.<base64url(gzip(json))>` inline token back into a validated manifest. */
export function decodeShareManifest(token: string): ShareManifest | null {
  const match = EMBEDDED_TOKEN_RE.exec(token.trim());
  if (!match) return null;
  const compressed = fromBase64Url(match[1]!);
  if (!compressed || compressed.length === 0) return null;

  let serialized: string;
  try {
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let inflatedSize = 0;
    const inflater = new pako.Inflate();
    inflater.onData = (chunk) => {
      inflatedSize += chunk.length;
      if (inflatedSize > MAX_DECOMPRESSED_BYTES) throw new RangeError("Shared list is too large");
      parts.push(decoder.decode(chunk, { stream: true }));
    };
    if (!inflater.push(compressed, true) || !inflatedSize) return null;
    serialized = parts.join("") + decoder.decode();
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as { v?: unknown; s?: unknown; w?: unknown };
  if (obj.v !== 1 || !Array.isArray(obj.s) || !Array.isArray(obj.w)) return null;

  const sources: ShareManifestSource[] = [];
  for (const raw of obj.s.slice(0, MAX_MANIFEST_SOURCES)) {
    if (!Array.isArray(raw)) return null;
    const sourceId = normalizeSourceId(raw[0]);
    const name = cleanText(raw[1], 120);
    if (!sourceId || !name) return null;
    sources.push({
      sourceId,
      name,
      lang: cleanText(raw[2], 16) || null,
      pkgName: cleanText(raw[3], 160) || null,
      repoUrl: sanitizePublicRepoUrl(typeof raw[4] === "string" ? raw[4] : null),
    });
  }

  const works: ShareManifestWork[] = [];
  for (const raw of obj.w.slice(0, MAX_MANIFEST_WORKS)) {
    if (!Array.isArray(raw)) return null;
    const sourceIdx = typeof raw[0] === "number" && Number.isInteger(raw[0]) ? raw[0] : -1;
    const url = typeof raw[1] === "string" ? raw[1].trim().slice(0, 1024) : "";
    const title = cleanText(raw[2], 300);
    if (!title) continue;
    const webUrl = sanitizePublicWebUrl(typeof raw[3] === "string" ? raw[3] : null);
    const coverUrl = sanitizePublicRepoUrl(typeof raw[4] === "string" ? raw[4] : null);
    const kind = normalizeWorkKind(raw[5]);
    const extra: { webUrl?: string | null; coverUrl?: string | null; kind?: ShareManifestWorkKind | null } = {};
    if (webUrl) extra.webUrl = webUrl;
    if (coverUrl) extra.coverUrl = coverUrl;
    if (kind) extra.kind = kind;
    if (sourceIdx >= 0 && sourceIdx < sources.length && url) {
      works.push({ sourceId: sources[sourceIdx]!.sourceId, url, title, ...extra });
    } else {
      works.push({ sourceId: "", url: "", title, ...extra });
    }
  }

  if (works.length === 0) return null;
  return { version: 1, sources, works };
}

/** Converts a hosted card URL from our allowlisted hosts into a short pointer token. */
export function hostedUrlToShareToken(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return null;
    }
    if (parsed.hostname === "pomf2.lain.la") {
      const pomfMatch = /^\/f\/([A-Za-z0-9_-]{1,64})\.png$/.exec(parsed.pathname);
      return pomfMatch ? `p.${pomfMatch[1]!}` : null;
    }
    const match = /^\/([A-Za-z0-9_-]{1,64})\.png$/.exec(parsed.pathname);
    if (!match) return null;
    const id = match[1]!;
    if (parsed.hostname === "iili.io") return `i.${id}`;
    if (parsed.hostname === "kappa.lol") return `k.${id}`;
    if (parsed.hostname === "x0.at") return `a.${id}`;
    if (parsed.hostname === "litter.catbox.moe") return `l.${id}`;
    if (parsed.hostname === "files.catbox.moe") return `c.${id}`;
    const uguuSub = parsed.hostname.endsWith(".uguu.se") ? parsed.hostname.slice(0, -".uguu.se".length) : "";
    if (uguuSub && /^[A-Za-z0-9]{1,16}$/.test(uguuSub)) return `u.${uguuSub}.${id}`;
    return null;
  } catch {
    return null;
  }
}

/** Converts a validated pointer token back to its allowlisted HTTPS PNG URL. */
export function shareTokenToHostedUrl(token: string): { host: ShareHostedKind; url: string } | null {
  const trimmed = token.trim();
  const simple = SIMPLE_HOST_TOKEN_RE.exec(trimmed);
  if (simple) {
    const prefix = simple[1]!;
    const id = simple[2]!;
    switch (prefix) {
      case "i":
        return { host: "freeimage", url: `https://iili.io/${id}.png` };
      case "k":
        return { host: "kappa", url: `https://kappa.lol/${id}.png` };
      case "p":
        return { host: "pomf2", url: `https://pomf2.lain.la/f/${id}.png` };
      case "a":
        return { host: "x0at", url: `https://x0.at/${id}.png` };
      case "l":
        return { host: "litterbox", url: `https://litter.catbox.moe/${id}.png` };
      case "c":
        return { host: "catbox", url: `https://files.catbox.moe/${id}.png` };
    }
  }
  const uguu = UGUU_HOST_TOKEN_RE.exec(trimmed);
  if (uguu) {
    return { host: "uguu", url: `https://${uguu[1]}.uguu.se/${uguu[2]}.png` };
  }
  return null;
}

/** Parses any supported share token, GitHub Pages share URL, or `epigraph://import` deep link. */
export function parseIncomingImportLink(raw: string): ShareLinkToken | null {
  const input = raw.trim();
  if (!input) return null;
  let token = input;

  if (input.startsWith(`${SHARE_APP_SCHEME}://`)) {
    try {
      const parsed = new URL(input);
      if (parsed.hostname !== SHARE_APP_HOST) return null;
      token = (parsed.searchParams.get("p") ?? parsed.hash.slice(1).split("&")[0] ?? "").trim();
    } catch {
      return null;
    }
  } else if (input.startsWith("https://")) {
    try {
      const parsed = new URL(input);
      const expected = new URL(SHARE_PAGE_URL);
      if (parsed.origin !== expected.origin || !parsed.pathname.startsWith(expected.pathname)) return null;
      token = (parsed.hash.slice(1).split("&")[0] || parsed.searchParams.get("p") || "").trim();
    } catch {
      return null;
    }
  } else {
    token = token.split("&")[0]!.trim();
  }

  if (INLINE_TOKEN_RE.test(token)) {
    return { kind: "inline", token };
  }
  const hosted = shareTokenToHostedUrl(token);
  if (hosted) {
    return { kind: "hosted", token, host: hosted.host, url: hosted.url };
  }
  return null;
}

export function buildShareWebUrl(
  token: string,
  hostedImageUrl?: string | null,
  options?: { viewOnly?: boolean },
): string {
  const params: string[] = [token];
  const imgToken = token.startsWith("d.") ? hostedUrlToShareToken(hostedImageUrl) : null;
  if (imgToken) params.push(`img=${imgToken}`);
  if (options?.viewOnly) params.push("view=1");
  return `${SHARE_PAGE_URL}#${params.join("&")}`;
}

/**
 * Picks the best share link token: inline whenever it stays compact (never expires and works
 * offline), or the short hosted-PNG pointer token for large folders.
 */
export function chooseShareLinkToken(inlineToken: string | null, hostedImageUrl?: string | null): string | null {
  if (!inlineToken || !EMBEDDED_TOKEN_RE.test(inlineToken)) return null;
  if (inlineToken.length <= INLINE_TOKEN_PREFERRED_MAX) return inlineToken;
  const hosted = hostedUrlToShareToken(hostedImageUrl);
  if (hosted) return hosted;
  if (inlineToken.length <= INLINE_TOKEN_HARD_MAX) return inlineToken;
  return null;
}

// ── PNG tEXt chunk embedding & reading ───────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(parts: readonly Uint8Array[]): number {
  let c = 0xffffffff;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      c = CRC_TABLE[(c ^ part[i]!) & 0xff]! ^ (c >>> 8);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 33) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

/** Inserts a standard PNG `tEXt` chunk (`epigraph-share\0<token>`) immediately before `IEND`. */
export function embedShareTokenInPng(pngBytes: Uint8Array, inlineToken: string): Uint8Array {
  if (!hasPngSignature(pngBytes) || !EMBEDDED_TOKEN_RE.test(inlineToken)) return pngBytes;
  const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  let offset = 8;
  let iendOffset = -1;
  while (offset + 12 <= pngBytes.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(
      pngBytes[offset + 4]!,
      pngBytes[offset + 5]!,
      pngBytes[offset + 6]!,
      pngBytes[offset + 7]!,
    );
    const next = offset + 12 + length;
    if (next > pngBytes.length) return pngBytes;
    if (type === "IEND") {
      iendOffset = offset;
      break;
    }
    offset = next;
  }
  if (iendOffset < 0) return pngBytes;

  const typeBytes = TEXT_ENCODER.encode("tEXt");
  const keywordBytes = TEXT_ENCODER.encode(SHARE_PNG_CHUNK_KEYWORD);
  const valueBytes = TEXT_ENCODER.encode(inlineToken);
  const data = new Uint8Array(keywordBytes.length + 1 + valueBytes.length);
  data.set(keywordBytes, 0);
  data[keywordBytes.length] = 0;
  data.set(valueBytes, keywordBytes.length + 1);

  const chunk = new Uint8Array(12 + data.length);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, data.length, false);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  chunkView.setUint32(8 + data.length, crc32([typeBytes, data]), false);

  const output = new Uint8Array(pngBytes.length + chunk.length);
  output.set(pngBytes.subarray(0, iendOffset), 0);
  output.set(chunk, iendOffset);
  output.set(pngBytes.subarray(iendOffset), iendOffset + chunk.length);
  return output;
}

/** Reads the `epigraph-share` `tEXt` chunk from a PNG buffer, returning its inline token. */
export function extractShareTokenFromPng(pngBytes: Uint8Array): string | null {
  if (!hasPngSignature(pngBytes)) return null;
  const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  let offset = 8;
  while (offset + 12 <= pngBytes.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(
      pngBytes[offset + 4]!,
      pngBytes[offset + 5]!,
      pngBytes[offset + 6]!,
      pngBytes[offset + 7]!,
    );
    const next = offset + 12 + length;
    if (next > pngBytes.length) return null;
    if (type === "tEXt") {
      const data = pngBytes.subarray(offset + 8, offset + 8 + length);
      const separator = data.indexOf(0);
      if (separator > 0) {
        const keyword = TEXT_DECODER.decode(data.subarray(0, separator));
        if (keyword === SHARE_PNG_CHUNK_KEYWORD) {
          const token = TEXT_DECODER.decode(data.subarray(separator + 1)).trim();
          return EMBEDDED_TOKEN_RE.test(token) ? token : null;
        }
      }
    }
    if (type === "IEND") break;
    offset = next;
  }
  return null;
}
