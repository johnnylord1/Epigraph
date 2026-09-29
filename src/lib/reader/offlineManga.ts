import { invoke } from "../tauri/invoke";
import JSZip from "jszip";

type OfflineMangaChapterInput = {
  downloadsPath: string;
  sourceName: string;
  mangaTitle: string;
  chapterName: string;
  scanlator?: string | null;
};

/** A detached reader window reads downloaded chapters through the main window, one page per message, instead
 * of receiving the whole archive as a single base64 message. */
export interface OfflineMangaRelay {
  open(input: OfflineMangaChapterInput): Promise<unknown>;
  page(id: string, index: number): Promise<unknown>;
}

let relay: OfflineMangaRelay | null = null;

export function setOfflineMangaRelay(next: OfflineMangaRelay | null) {
  relay = next;
}

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function naturalPageOrder(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function imageMimeType(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "avif") return "image/avif";
  return "image/jpeg";
}

async function readOfflineMangaPages(input: OfflineMangaChapterInput) {
  const archive = await invoke<string | null>("read_downloaded_chapter_archive", {
    downloadsPath: input.downloadsPath,
    sourceName: input.sourceName,
    mangaTitle: input.mangaTitle,
    chapterName: input.chapterName,
    scanlator: input.scanlator ?? null,
  });
  if (!archive) return [];

  const zip = await JSZip.loadAsync(decodeBase64(archive));
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && /\.(avif|gif|jpe?g|png|webp)$/i.test(entry.name))
    .sort((left, right) => naturalPageOrder(left.name, right.name));
  const pages: Array<{ type: string; bytes: Uint8Array }> = [];
  for (const entry of entries) pages.push({ type: imageMimeType(entry.name), bytes: await entry.async("uint8array") });
  return pages;
}

function pageUrl(type: string, bytes: Uint8Array) {
  return URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type }));
}

async function loadRelayedChapter(link: OfflineMangaRelay, input: OfflineMangaChapterInput) {
  const opened = await link.open(input) as { id?: unknown; types?: unknown } | null;
  if (!opened) return [];
  const { id, types } = opened;
  if (typeof id !== "string" || !Array.isArray(types) || types.some((type) => typeof type !== "string")) {
    throw new Error("Downloaded chapter could not be read.");
  }
  const urls: string[] = [];
  try {
    for (let index = 0; index < types.length; index += 1) {
      const page = await link.page(id, index);
      if (typeof page !== "string") throw new Error("Downloaded chapter could not be read.");
      urls.push(pageUrl(types[index], decodeBase64(page)));
    }
  } catch (error) {
    revokeOfflineMangaPages(urls);
    throw error;
  }
  return urls;
}

export async function loadOfflineMangaChapter(input: OfflineMangaChapterInput) {
  if (relay) return loadRelayedChapter(relay, input);
  return (await readOfflineMangaPages(input)).map((page) => pageUrl(page.type, page.bytes));
}

const HANDOVER_TTL_MS = 120_000;
const handovers = new Map<string, { pages: Array<Uint8Array | null>; timer: ReturnType<typeof setTimeout> }>();

function expireHandover(id: string) {
  const handover = handovers.get(id);
  if (handover) clearTimeout(handover.timer);
  handovers.delete(id);
}

/** Main window: reads a downloaded chapter for a detached reader window, which then takes it page by page. */
export async function openOfflineMangaChapterForWindow(input: unknown) {
  const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const fields = ["downloadsPath", "sourceName", "mangaTitle", "chapterName"] as const;
  if (fields.some((field) => typeof record[field] !== "string") || (record.scanlator != null && typeof record.scanlator !== "string")) {
    throw new Error("OFFLINE_CHAPTER_INVALID");
  }
  const pages = await readOfflineMangaPages({
    downloadsPath: record.downloadsPath as string,
    sourceName: record.sourceName as string,
    mangaTitle: record.mangaTitle as string,
    chapterName: record.chapterName as string,
    scanlator: (record.scanlator as string | null | undefined) ?? null,
  });
  if (pages.length === 0) return null;
  const id = crypto.randomUUID();
  // A window that closes midway never asks for the rest, so the pages it left behind expire.
  handovers.set(id, { pages: pages.map((page) => page.bytes), timer: setTimeout(() => expireHandover(id), HANDOVER_TTL_MS) });
  return { id, types: pages.map((page) => page.type) };
}

/** Main window: hands over one page and forgets it; the chapter is dropped once every page was taken. */
export function readOfflineMangaPageForWindow(id: unknown, index: unknown) {
  const handover = typeof id === "string" ? handovers.get(id) : undefined;
  if (!handover) throw new Error("OFFLINE_CHAPTER_EXPIRED");
  const bytes = Number.isSafeInteger(index) ? handover.pages[index as number] : undefined;
  if (!bytes) throw new Error("OFFLINE_CHAPTER_PAGE_INVALID");
  handover.pages[index as number] = null;
  if (handover.pages.every((page) => page === null)) expireHandover(id as string);
  return encodeBase64(bytes);
}

export function revokeOfflineMangaPages(urls: string[]) {
  for (const url of urls) URL.revokeObjectURL(url);
}
