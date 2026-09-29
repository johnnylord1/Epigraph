// Detached reader windows talk to the main window through Tauri events. Tauri delivers every event to any
// webview listening on the "Any" target, including the novel runtime host that runs plugin code, so each
// message is sealed with AES-GCM under a key that only the main window and that reader window know. The
// key travels in the URL fragment of the window the main window creates, never through an event.

export const DETACHED_READER_LABEL_PREFIX = "detached-reader-";
export const DETACHED_READER_QUERY = "detachedReader";
export const DETACHED_READER_TO_MAIN_EVENT = "detached-reader:to-main";
export const DETACHED_READER_TO_READER_EVENT = "detached-reader:to-reader";

export type DetachedChannelDirection = "to-main" | "to-reader";

export interface SealedDetachedMessage {
  label: string;
  iv: string;
  data: string;
}

type LocationLike = Pick<Location, "search" | "hash">;

export function isDetachedReaderWindow(location: LocationLike | undefined = globalThis.location): boolean {
  if (!location) return false;
  try {
    return new URLSearchParams(location.search).has(DETACHED_READER_QUERY);
  } catch {
    return false;
  }
}

export function readDetachedReaderSecret(location: LocationLike | undefined = globalThis.location): string | null {
  const hash = location?.hash?.replace(/^#/, "") ?? "";
  const secret = new URLSearchParams(hash).get("k");
  return secret && /^[A-Za-z0-9_-]{43}$/.test(secret) ? secret : null;
}

export function isDetachedReaderLabel(label: unknown): label is string {
  return typeof label === "string" && /^detached-reader-[a-z0-9]{1,32}$/.test(label);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function createDetachedChannelKey(): Promise<{ key: CryptoKey; secret: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return { key: await importKey(raw), secret: toBase64Url(raw) };
}

export function importDetachedChannelKey(secret: string): Promise<CryptoKey> {
  return importKey(fromBase64Url(secret));
}

function associatedData(direction: DetachedChannelDirection, label: string) {
  return new TextEncoder().encode(`${direction}:${label}`);
}

export async function sealDetachedMessage(
  key: CryptoKey,
  direction: DetachedChannelDirection,
  label: string,
  message: unknown,
): Promise<SealedDetachedMessage> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(message));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: associatedData(direction, label) }, key, plain);
  return { label, iv: toBase64Url(iv), data: toBase64Url(new Uint8Array(cipher)) };
}

/** Throws when the message was not sealed with this key, for this label and direction. */
export async function openDetachedMessage<T>(
  key: CryptoKey,
  direction: DetachedChannelDirection,
  sealed: SealedDetachedMessage,
): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(sealed.iv), additionalData: associatedData(direction, sealed.label) },
    key,
    fromBase64Url(sealed.data),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export function isSealedDetachedMessage(value: unknown): value is SealedDetachedMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return isDetachedReaderLabel(candidate.label) && typeof candidate.iv === "string" && typeof candidate.data === "string";
}

/** Messages a reader window sends; every one carries a sequence number so a replay is refused. */
export type DetachedToMainMessage =
  | { seq: number; kind: "hello"; id: number }
  | { seq: number; kind: "invoke"; id: number; cmd: string; args: unknown }
  | { seq: number; kind: "store"; id?: number; method: string; args: unknown[] };

export type DetachedToReaderMessage =
  | { kind: "result"; id: number; ok: true; value: unknown }
  | { kind: "result"; id: number; ok: false; error: string };

/** Application commands a detached reader may run through the main window. All of them only read, except the
 * Suwayomi operation lease every GraphQL mutation holds, which the main window tracks per reader window. */
export const DETACHED_READER_RELAYED_COMMANDS: ReadonlySet<string> = new Set([
  "read_book_library_state",
  "read_novel_library_state",
  "read_file_base64",
  "get_cached_library_cover",
  "read_extension_compatibility_state",
  "record_media_audit_event",
  "get_suwayomi_update_lock_status",
  "begin_suwayomi_runtime_operation",
  "end_suwayomi_runtime_operation",
]);

/** Store changes a detached reader hands to the main window, which owns persistence. */
export const DETACHED_READER_STORE_METHODS: ReadonlySet<string> = new Set([
  "addHistory",
  "addBookmark",
  "removeBookmark",
  "updateSettings",
  "setBookProgress",
  "addBookBookmark",
  "removeBookBookmark",
  "flushBookLibraryPersistence",
  "checkAndMarkCompleted",
  "setSettingsOpen",
  "mangaProgressSaved",
  "fetchChapterPages",
  "openOfflineMangaChapter",
  "readOfflineMangaPage",
  "loadNovelChapter",
  "saveNovelReaderChanges",
]);

/** Page URLs the main window already fetched for the chapter it hands over, or null when they are not plain
 * http(s) URLs. Suwayomi holds a second page-list request for a chapter while it still downloads that chapter's
 * pages, so the new window reuses the list instead of asking again. */
export function readDetachedPageUrls(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  for (const url of value) {
    if (typeof url !== "string" || url.length > 4096) return null;
    try {
      const { protocol } = new URL(url);
      if (protocol !== "http:" && protocol !== "https:") return null;
    } catch {
      return null;
    }
  }
  return [...value];
}

/** JSON turns a trailing `undefined` into `null`, which would defeat default parameters on the other side. */
export function trimTrailingUndefined(args: unknown[]): unknown[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end -= 1;
  return args.slice(0, end);
}
