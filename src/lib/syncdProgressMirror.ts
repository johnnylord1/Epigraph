import { invoke } from "@tauri-apps/api/core";

/** Edits within this window share one request; Core also spaces requested mirror ticks. */
export const PROGRESS_MIRROR_DEBOUNCE_MS = 750;
/** Core rejects larger lists; past this the title ids alone still trigger a rescan. */
const MAX_IDS_PER_REQUEST = 1_000;

let pendingMangaIds = new Set<number>();
let pendingChapterIds = new Set<number>();
let pendingCatalog = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Mutation fields that change only reading progress, downloads, trackers or source browsing. Any other
 * mutation may change what paired devices apply from the catalog. Mirrors Core's `catalog_revision`.
 */
const CATALOG_NEUTRAL_MUTATIONS = new Set([
  "updateChapter",
  "updateChapters",
  "fetchChapterPages",
  "setChapterMeta",
  "deleteChapterMeta",
  "enqueueChapterDownload",
  "enqueueChapterDownloads",
  "dequeueChapterDownload",
  "dequeueChapterDownloads",
  "reorderChapterDownload",
  "startDownloader",
  "stopDownloader",
  "clearDownloader",
  "deleteDownloadedChapter",
  "deleteDownloadedChapters",
  "bindTrack",
  "updateTrack",
  "unbindTrack",
  "trackProgress",
  "fetchTrack",
  "loginTrackerOAuth",
  "loginTrackerCredentials",
  "logoutTracker",
  "fetchSourceManga",
]);

/** Field names selected at the top of a GraphQL operation, aliases resolved. */
function topLevelFields(document: string): string[] {
  const fields: string[] = [];
  let braces = 0;
  let parens = 0;
  for (let index = 0; index < document.length; index += 1) {
    const ch = document[index];
    if (ch === "#") {
      const end = document.indexOf("\n", index);
      index = end < 0 ? document.length : end;
    } else if (ch === '"') {
      for (index += 1; index < document.length && document[index] !== '"'; index += 1) {
        if (document[index] === "\\") index += 1;
      }
    } else if (ch === "{") braces += 1;
    else if (ch === "}") braces = Math.max(0, braces - 1);
    else if (ch === "(") parens += 1;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    else if (braces === 1 && parens === 0) {
      if (ch === ":") fields.pop();
      else if (/[A-Za-z_]/.test(ch)) {
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(document.slice(index))![0];
        fields.push(name);
        index += name.length - 1;
      }
    }
  }
  return fields;
}

/** Whether a Suwayomi mutation may change the library, categories or extensions; unknown fields count. */
export function mutationMayChangeCatalog(document: string): boolean {
  const fields = topLevelFields(document);
  return fields.length === 0 || fields.some((field) => !CATALOG_NEUTRAL_MUTATIONS.has(field));
}

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
  void invoke("syncd_request_progress_mirror", { mangaIds, chapterIds, catalog }).catch(() => {});
  // A profile joined to another desktop sends the edit there too.
  window.dispatchEvent?.(new Event("epigraph-comic-local-edit"));
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
 * Asks Core to mirror Suwayomi categories and title assignments soon, after this window changed the library,
 * its categories or extensions. Core also drops the catalog revision paired devices compare against until
 * that tick reads the change.
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
