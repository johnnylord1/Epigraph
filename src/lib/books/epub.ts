import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import type { ParsedBookCover, ParsedEpubBook, BookSpineItem, BookTocItem } from "./types";

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
});

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (value && typeof value === "object" && "#text" in value) {
    return textValue((value as Record<string, unknown>)["#text"]);
  }
  return null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    for (const entry of asArray(value)) {
      const text = textValue(entry);
      if (text) return text;
    }
  }
  return null;
}

function allText(...values: unknown[]): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const value of values) {
    for (const entry of asArray(value)) {
      const text = textValue(entry);
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      texts.push(text);
    }
  }
  return texts;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(0, idx + 1) : "";
}

function joinHref(baseDir: string, href: string): string {
  if (!href) return "";
  if (/^[a-z]+:/i.test(href)) return href;
  const normalizedBase = baseDir.replace(/\\/g, "/");
  return new URL(href, `https://local.epub/${normalizedBase}`).pathname.replace(/^\/+/, "");
}

function extFrom(mediaType: string, href: string): string {
  const byType: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  if (byType[mediaType]) return byType[mediaType];
  const match = href.match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() ?? "bin";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function walkTocItems(node: unknown, depth: number, out: BookTocItem[], baseDir: string) {
  for (const item of asArray(node as Record<string, unknown> | Record<string, unknown>[])) {
    if (!item || typeof item !== "object") continue;
    const label = firstText((item as any).a, (item as any).span, (item as any)["#text"]) ?? "Untitled";
    const rawHref = typeof (item as any).a?.href === "string" ? (item as any).a.href : "";
    const href = rawHref ? joinHref(baseDir, rawHref) : "";
    out.push({
      id: `${depth}:${out.length}:${href || label}`,
      label,
      href,
      depth,
    });
    const children = (item as any).ol?.li ?? (item as any).li;
    if (children) walkTocItems(children, depth + 1, out, baseDir);
  }
}

function parseNavToc(navText: string, baseDir: string): BookTocItem[] {
  try {
    const navDoc = xml.parse(navText);
    const navs = asArray(navDoc?.html?.body?.nav ?? navDoc?.body?.nav ?? navDoc?.nav);
    const tocNav = navs.find((nav: any) => {
      const epubType = `${nav?.type ?? nav?.["epub:type"] ?? ""}`.toLowerCase();
      const id = `${nav?.id ?? ""}`.toLowerCase();
      return epubType.includes("toc") || id === "toc";
    }) ?? navs[0];
    const items: BookTocItem[] = [];
    if (tocNav?.ol?.li) walkTocItems(tocNav.ol.li, 0, items, baseDir);
    return items;
  } catch {
    return [];
  }
}

function walkNcxPoints(node: unknown, depth: number, out: BookTocItem[], baseDir: string) {
  for (const point of asArray(node as Record<string, unknown> | Record<string, unknown>[])) {
    if (!point || typeof point !== "object") continue;
    const label = firstText((point as any).navLabel?.text, (point as any).text) ?? "Untitled";
    const rawHref = `${(point as any).content?.src ?? ""}`;
    const href = rawHref ? joinHref(baseDir, rawHref) : "";
    out.push({
      id: `${depth}:${out.length}:${href || label}`,
      label,
      href,
      depth,
    });
    const children = (point as any).navPoint;
    if (children) walkNcxPoints(children, depth + 1, out, baseDir);
  }
}

function parseNcxToc(ncxText: string, baseDir: string): BookTocItem[] {
  try {
    const ncxDoc = xml.parse(ncxText);
    const navMap = ncxDoc?.ncx?.navMap ?? ncxDoc?.navMap;
    const items: BookTocItem[] = [];
    if (navMap?.navPoint) walkNcxPoints(navMap.navPoint, 0, items, baseDir);
    return items;
  } catch {
    return [];
  }
}

export async function parseEpubArchive(buffer: ArrayBuffer, fallbackTitle: string): Promise<ParsedEpubBook> {
  const zip = await JSZip.loadAsync(buffer);
  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) throw new Error("Malformed EPUB: META-INF/container.xml is missing.");

  const containerText = await containerFile.async("string");
  const container = xml.parse(containerText);
  const rootfilePath = firstText(
    container?.container?.rootfiles?.rootfile?.["full-path"],
    container?.container?.rootfiles?.rootfile?.fullPath,
  );
  if (!rootfilePath) throw new Error("Malformed EPUB: package rootfile is missing.");

  const packageFile = zip.file(rootfilePath);
  if (!packageFile) throw new Error("Malformed EPUB: package document could not be found.");

  const packageText = await packageFile.async("string");
  const pkg = xml.parse(packageText)?.package;
  if (!pkg) throw new Error("Malformed EPUB: package document could not be parsed.");

  const opfDir = dirname(rootfilePath);
  const metadata = pkg.metadata ?? {};
  const manifestItems = asArray(pkg.manifest?.item);
  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
  for (const item of manifestItems) {
    const id = `${(item as any).id ?? ""}`;
    const href = joinHref(opfDir, `${(item as any).href ?? ""}`);
    manifest.set(id, {
      href,
      mediaType: `${(item as any)["media-type"] ?? (item as any).mediaType ?? ""}`.trim(),
      properties: `${(item as any).properties ?? ""}`.trim(),
    });
  }

  const spineRefs = asArray(pkg.spine?.itemref);
  const spine: BookSpineItem[] = spineRefs
    .map((ref, index) => {
      const item = manifest.get(`${(ref as any).idref ?? ""}`);
      if (!item) return null;
      return {
        id: `${(ref as any).idref ?? index}`,
        href: item.href,
        label: item.href.split("/").pop() ?? `Section ${index + 1}`,
      };
    })
    .filter((item): item is BookSpineItem => !!item);

  const navItem = manifestItems.find((item: any) => `${item.properties ?? ""}`.split(/\s+/).includes("nav"));
  const ncxId = `${pkg.spine?.toc ?? ""}`.trim();
  let toc: BookTocItem[] = [];
  if (navItem) {
    const navPath = joinHref(opfDir, `${(navItem as any).href ?? ""}`);
    const navFile = zip.file(navPath);
    if (navFile) {
      toc = parseNavToc(await navFile.async("string"), dirname(navPath));
    }
  }
  if (!toc.length && ncxId && manifest.has(ncxId)) {
    const ncxPath = manifest.get(ncxId)?.href ?? "";
    const ncxFile = zip.file(ncxPath);
    if (ncxFile) {
      toc = parseNcxToc(await ncxFile.async("string"), dirname(ncxPath));
    }
  }
  if (!toc.length) {
    toc = spine.map((item, index) => ({
      id: `spine:${index}`,
      label: item.label,
      href: item.href,
      depth: 0,
    }));
  }

  const coverId =
    asArray(metadata.meta).find((meta: any) => `${meta.name ?? ""}`.toLowerCase() === "cover")?.content ??
    manifestItems.find((item: any) => `${item.properties ?? ""}`.split(/\s+/).includes("cover-image"))?.id;

  let cover: ParsedBookCover | null = null;
  if (coverId && manifest.has(`${coverId}`)) {
    const coverItem = manifest.get(`${coverId}`)!;
    const coverFile = zip.file(coverItem.href);
    if (coverFile) {
      const bytes = await coverFile.async("uint8array");
      cover = {
        bytesBase64: bytesToBase64(bytes),
        ext: extFrom(coverItem.mediaType, coverItem.href),
        mediaType: coverItem.mediaType,
      };
    }
  }

  return {
    title: firstText(metadata.title, metadata["dc:title"]) ?? fallbackTitle,
    author: firstText(metadata.creator, metadata["dc:creator"]),
    description: firstText(metadata.description, metadata["dc:description"]),
    genres: allText(metadata.subject, metadata["dc:subject"]),
    toc,
    spine,
    cover,
  };
}
