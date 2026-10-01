import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "../tauri/invoke";

type OfflineMangaChapterInput = {
  downloadsPath: string;
  sourceName: string;
  mangaTitle: string;
  chapterName: string;
  scanlator?: string | null;
  /** The profile whose default downloads folder applies when `downloadsPath` is blank. */
  profileId?: string | null;
};

/** A downloaded chapter the app opened: only its pages are listed, each is read when the reader shows it. */
type OpenedOfflineChapter = { id: string; pages: number };

/** A detached reader window cannot run app commands, so the main window opens the chapter for it. The window
 * then reads the pages itself through the `offline-page` protocol, like the main window does. */
export interface OfflineMangaRelay {
  open(input: OfflineMangaChapterInput): Promise<unknown>;
}

let relay: OfflineMangaRelay | null = null;

export function setOfflineMangaRelay(next: OfflineMangaRelay | null) {
  relay = next;
}

function openChapter(input: OfflineMangaChapterInput) {
  return invoke<OpenedOfflineChapter | null>("open_downloaded_chapter", {
    downloadsPath: input.downloadsPath,
    sourceName: input.sourceName,
    mangaTitle: input.mangaTitle,
    chapterName: input.chapterName,
    scanlator: input.scanlator ?? null,
    profileId: input.profileId ?? null,
  });
}

function pageUrls(opened: unknown): string[] {
  if (opened == null) return [];
  const { id, pages } = opened as Partial<OpenedOfflineChapter>;
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id) || !Number.isSafeInteger(pages) || (pages as number) < 1) {
    throw new Error("Downloaded chapter could not be read.");
  }
  return Array.from({ length: pages as number }, (_, index) => convertFileSrc(`${id}/${index}`, "offline-page"));
}

/** Page URLs of a downloaded chapter, or none when it is not on disk. Opening reads no page. */
export async function loadOfflineMangaChapter(input: OfflineMangaChapterInput) {
  return pageUrls(relay ? await relay.open(input) : await openChapter(input));
}

/** Main window: opens a downloaded chapter for a detached reader window. */
export async function openOfflineMangaChapterForWindow(input: unknown) {
  const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const fields = ["downloadsPath", "sourceName", "mangaTitle", "chapterName"] as const;
  const optional = ["scanlator", "profileId"] as const;
  if (fields.some((field) => typeof record[field] !== "string") || optional.some((field) => record[field] != null && typeof record[field] !== "string")) {
    throw new Error("OFFLINE_CHAPTER_INVALID");
  }
  return openChapter({
    downloadsPath: record.downloadsPath as string,
    sourceName: record.sourceName as string,
    mangaTitle: record.mangaTitle as string,
    chapterName: record.chapterName as string,
    scanlator: (record.scanlator as string | null | undefined) ?? null,
    profileId: (record.profileId as string | null | undefined) ?? null,
  });
}
