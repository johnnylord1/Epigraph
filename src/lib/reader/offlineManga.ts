import { invoke } from "@tauri-apps/api/core";
import JSZip from "jszip";

type OfflineMangaChapterInput = {
  downloadsPath: string;
  sourceName: string;
  mangaTitle: string;
  chapterName: string;
  scanlator?: string | null;
};

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

export async function loadOfflineMangaChapter(input: OfflineMangaChapterInput) {
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
  const urls: string[] = [];
  for (const entry of entries) {
    const bytes = await entry.async("uint8array");
    urls.push(URL.createObjectURL(new Blob([bytes], { type: imageMimeType(entry.name) })));
  }
  return urls;
}

export function revokeOfflineMangaPages(urls: string[]) {
  for (const url of urls) URL.revokeObjectURL(url);
}
