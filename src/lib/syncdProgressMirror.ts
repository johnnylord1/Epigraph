import { invoke } from "@tauri-apps/api/core";

/** Edits within this window share one request; Core also spaces requested mirror ticks. */
export const PROGRESS_MIRROR_DEBOUNCE_MS = 750;
/** Core rejects larger lists; past this the title ids alone still trigger a rescan. */
const MAX_IDS_PER_REQUEST = 1_000;

let pendingMangaIds = new Set<number>();
let pendingChapterIds = new Set<number>();
let pendingCatalog = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function addIds(target: Set<number>, ids: readonly number[] | undefined) {
  for (const id of ids ?? []) {
    if (Number.isSafeInteger(id) && id > 0 && target.size < MAX_IDS_PER_REQUEST) target.add(id);
  }
}

function flush() {
  timer = null;
  const mangaIds = [...pendingMangaIds];
  const chapterIds = [...pendingChapterIds];
  pendingMangaIds = new Set();
  pendingChapterIds = new Set();
  const catalog = pendingCatalog;
  pendingCatalog = false;
  if (!mangaIds.length && !chapterIds.length && !catalog) return;
  // The periodic mirror tick is the fallback, so a Core that is away or older is not an error here.
  void invoke("syncd_request_progress_mirror", { mangaIds, chapterIds }).catch(() => {});
}

/**
 * Asks Core to mirror Suwayomi reading progress soon, after this window changed chapter read, page or bookmark
 * state, so paired devices see the edit without waiting for the periodic mirror. Only pass chapters this window
 * actually wrote: Core treats them as desktop edits made now. Main window only; detached windows cannot invoke it.
 */
export function requestProgressMirror(edit: { mangaIds?: readonly number[]; chapterIds?: readonly number[] }) {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  addIds(pendingMangaIds, edit.mangaIds);
  addIds(pendingChapterIds, edit.chapterIds);
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flush, PROGRESS_MIRROR_DEBOUNCE_MS);
}

/**
 * Asks Core to mirror Suwayomi categories and title assignments soon, after this window created, renamed,
 * reordered or deleted a category or changed a title's categories. The same Core tick mirrors them.
 */
export function requestCatalogMirror() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  pendingCatalog = true;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flush, PROGRESS_MIRROR_DEBOUNCE_MS);
}

export function resetProgressMirrorRequestsForTests() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pendingMangaIds = new Set();
  pendingChapterIds = new Set();
  pendingCatalog = false;
}
