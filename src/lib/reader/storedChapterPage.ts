import { invoke } from "../tauri/invoke";

/** The reader waits at most this long for Core before it opens the chapter at the first page. */
export const STORED_CHAPTER_PAGE_TIMEOUT_MS = 1_200;

/**
 * The zero-based page Core keeps for a chapter Suwayomi shows as unopened, or 0. Suwayomi drops a page another
 * device restored while it does not know the chapter's page count, and Core keeps that page until a reader opens
 * the chapter. Runs alongside the page fetch; a Core that is away, older or slow is not an error.
 */
export async function storedChapterPage(chapterId: number, timeoutMs = STORED_CHAPTER_PAGE_TIMEOUT_MS): Promise<number> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return 0;
  if (!Number.isSafeInteger(chapterId) || chapterId <= 0) return 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const pages = await Promise.race([
      invoke<Record<string, unknown>>("syncd_stored_chapter_pages", { chapterIds: [chapterId] }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    const page = pages?.[String(chapterId)];
    return typeof page === "number" && Number.isSafeInteger(page) && page > 0 ? page : 0;
  } catch {
    return 0;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
