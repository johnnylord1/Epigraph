import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { BookEntry } from "./types";

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

function mimeFromPath(path: string): string {
  const match = path.match(/\.([a-z0-9]+)$/i);
  const ext = match?.[1]?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

const objectUrlCache = new Map<string, string>();
const dataUrlCache = new Map<string, string>();
const fileSrcCache = new Map<string, string>();

export function isUsableBookCoverUrl(coverUrl: string | null | undefined): boolean {
  return typeof coverUrl === "string" && coverUrl.startsWith("data:image/") && coverUrl.length > 64;
}

export function needsBookCoverUrlBackfill(
  book: Pick<BookEntry, "coverPath" | "coverUrl">,
): boolean {
  if (!book.coverPath) return false;
  return !isUsableBookCoverUrl(book.coverUrl);
}

export async function readFileAsBase64(path: string): Promise<string> {
  return invoke<string>("read_file_base64", { path });
}

export async function readFileAsArrayBuffer(path: string): Promise<ArrayBuffer> {
  const base64 = await readFileAsBase64(path);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return bytes.buffer;
}

export async function computeFileSha256(path: string): Promise<string> {
  return invoke<string>("compute_file_sha256", { path });
}

export async function readFileAsDataUrl(path: string): Promise<string> {
  const cached = dataUrlCache.get(path);
  if (cached) return cached;
  const base64 = await readFileAsBase64(path);
  const dataUrl = `data:${mimeFromPath(path)};base64,${base64}`;
  dataUrlCache.set(path, dataUrl);
  return dataUrl;
}

export async function canRenderEmbeddedImage(
  bytesBase64: string,
  mediaType: string,
): Promise<boolean> {
  if (!bytesBase64 || bytesBase64.length < 32) return false;

  if (typeof Image === "undefined") {
    return bytesBase64.length >= 128;
  }

  return new Promise<boolean>((resolve) => {
    const image = new Image();
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      image.onload = null;
      image.onerror = null;
      image.src = "";
      resolve(result);
    };

    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = `data:${mediaType};base64,${bytesBase64}`;
  });
}

export async function canRenderBookCoverPath(path: string): Promise<boolean> {
  try {
    const base64 = await readFileAsBase64(path);
    return canRenderEmbeddedImage(base64, mimeFromPath(path));
  } catch {
    return false;
  }
}

export async function readFileAsObjectUrl(path: string): Promise<string> {
  const cached = objectUrlCache.get(path);
  if (cached) return cached;

  const buffer = await readFileAsArrayBuffer(path);
  const objectUrl = URL.createObjectURL(new Blob([buffer], { type: mimeFromPath(path) }));
  objectUrlCache.set(path, objectUrl);
  return objectUrl;
}

export function filePathAsStableUrl(path: string, protocol = "asset"): string {
  const cacheKey = `${protocol}:${path}`;
  const cached = fileSrcCache.get(cacheKey);
  if (cached) return cached;
  const url = convertFileSrc(path, protocol);
  fileSrcCache.set(cacheKey, url);
  return url;
}

export function revokeCachedFileObjectUrl(path: string | null | undefined) {
  if (!path) return;
  const cached = objectUrlCache.get(path);
  if (!cached) return;
  URL.revokeObjectURL(cached);
  objectUrlCache.delete(path);
}

export function dropCachedFileDataUrl(path: string | null | undefined) {
  if (!path) return;
  dataUrlCache.delete(path);
}

export function dropCachedFileStableUrl(path: string | null | undefined, protocol = "asset") {
  if (!path) return;
  fileSrcCache.delete(`${protocol}:${path}`);
}

export async function copyImportedBook(sourcePath: string, bookId: string): Promise<string> {
  return invoke<string>("copy_book_import", { sourcePath, bookId });
}

export async function writeBookAsset(bookId: string, bytesBase64: string, ext: string): Promise<string> {
  return invoke<string>("write_book_asset", { bookId, bytesBase64, ext });
}

export async function writeBookCover(bookId: string, bytesBase64: string, ext: string): Promise<string> {
  return invoke<string>("write_book_cover", { bookId, bytesBase64, ext });
}

export async function removeBookAssets(assetPath: string | null | undefined, coverPath: string | null | undefined): Promise<void> {
  revokeCachedFileObjectUrl(assetPath);
  revokeCachedFileObjectUrl(coverPath);
  dropCachedFileDataUrl(assetPath);
  dropCachedFileDataUrl(coverPath);
  dropCachedFileStableUrl(assetPath);
  dropCachedFileStableUrl(coverPath);
  dropCachedFileStableUrl(assetPath, "book");
  dropCachedFileStableUrl(coverPath, "book");
  return invoke("remove_book_assets", {
    assetPath: assetPath ?? null,
    coverPath: coverPath ?? null,
  });
}
