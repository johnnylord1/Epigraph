import pako from "pako";
import Long from "long";
import protobuf from "protobufjs";
import { MIHON_BACKUP_PROTO } from "./mihonProto";
import { normalizeMihonMemoFields } from "./mihonMemo";
import type { ParsedBackup, ParsedBackupExtensionStore, ParsedBackupManga, ParsedBackupSource, SourceInventoryEntry } from "../reconciliation/types";

protobuf.util.Long = Long;
protobuf.configure();

const root = protobuf.parse(MIHON_BACKUP_PROTO).root;
const BackupMangaType = root.lookupType("BackupManga");
const BackupSourceType = root.lookupType("BackupSource");
const BackupExtensionStoreType = root.lookupType("BackupExtensionStore");
const unknownWireFields = Symbol("unknownBackupWireFields");

// protobufjs discards unrecognized fields. Keep those wire chunks on every nested
// message so changing a source never strips metadata from a newer app or fork.
function decodePreservingUnknown(type: protobuf.Type, bytes: Uint8Array): any {
  const message = type.decode(bytes) as any;
  const reader = protobuf.Reader.create(bytes);
  const repeatedIndexes = new Map<number, number>();
  const unknown: Uint8Array[] = [];
  while (reader.pos < reader.len) {
    const start = reader.pos;
    const tag = reader.uint32();
    const field = type.fieldsById[tag >>> 3]?.resolve();
    if (field?.resolvedType instanceof protobuf.Type && (tag & 7) === 2) {
      const child = decodePreservingUnknown(field.resolvedType, reader.bytes());
      if (field.repeated) {
        const index = repeatedIndexes.get(field.id) ?? 0;
        message[field.name][index] = child;
        repeatedIndexes.set(field.id, index + 1);
      } else {
        message[field.name] = child;
      }
    } else {
      reader.skipType(tag & 7);
      if (!field) unknown.push(bytes.subarray(start, reader.pos));
    }
  }
  message[unknownWireFields] = unknown;
  return message;
}

function encodePreservingUnknown(type: protobuf.Type, message: any): Uint8Array {
  const bytes = type.encode(message).finish();
  const reader = protobuf.Reader.create(bytes);
  const chunks: Uint8Array[] = [];
  const repeatedIndexes = new Map<number, number>();
  while (reader.pos < reader.len) {
    const start = reader.pos;
    const tag = reader.uint32();
    const field = type.fieldsById[tag >>> 3]?.resolve();
    if (field?.resolvedType instanceof protobuf.Type && (tag & 7) === 2) {
      reader.bytes();
      const index = repeatedIndexes.get(field.id) ?? 0;
      repeatedIndexes.set(field.id, index + 1);
      const child = field.repeated ? message[field.name][index] : message[field.name];
      chunks.push(encodeFieldChunk(field.id, encodePreservingUnknown(field.resolvedType, child)));
    } else {
      reader.skipType(tag & 7);
      chunks.push(bytes.subarray(start, reader.pos));
    }
  }
  return concatChunks([...chunks, ...(message[unknownWireFields] ?? [])]);
}

function mergedUnknownFields(left: any, right: any): Uint8Array[] {
  return [...(left?.[unknownWireFields] ?? []), ...(right?.[unknownWireFields] ?? [])];
}

const GZIP_MAGIC_1 = 0x1f;
const GZIP_MAGIC_2 = 0x8b;

export const BACKUP_TOP_LEVEL_MANGA_FIELD = 1;
export const BACKUP_TOP_LEVEL_SOURCES_FIELD = 101;
export const BACKUP_TOP_LEVEL_PREFERENCES_FIELD = 104;
export const BACKUP_TOP_LEVEL_EXTENSION_STORES_FIELD = 106;

function toUint8Array(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function int64ToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value).toString() : "";
  if (typeof value === "bigint") return value.toString();
  if (Long.isLong(value)) return value.toString();
  if (typeof value === "object" && "toString" in (value as object)) {
    const text = String(value);
    return text === "[object Object]" ? "" : text;
  }
  return "";
}

function encodeInt64(value: string): Long {
  return Long.fromString(value || "0", false);
}

function toLong(value: unknown): Long {
  return Long.fromString(int64ToString(value) || "0", false);
}

function maxLong(a: unknown, b: unknown): Long {
  const left = toLong(a);
  const right = toLong(b);
  return left.greaterThan(right) ? left : right;
}

function minPositiveLong(a: unknown, b: unknown): Long {
  const left = toLong(a);
  const right = toLong(b);
  const zero = Long.fromInt(0, false);
  if (left.lessThanOrEqual(zero)) return right;
  if (right.lessThanOrEqual(zero)) return left;
  return left.lessThan(right) ? left : right;
}

function preferTruthy<T>(left: T | null | undefined, right: T | null | undefined): T | null | undefined {
  return left || right;
}

function preferLongerString(left: unknown, right: unknown): string {
  const a = typeof left === "string" ? left : "";
  const b = typeof right === "string" ? right : "";
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function uniqueInt64(values: unknown[]): Long[] {
  return [...new Set(values.map((value) => int64ToString(value)).filter(Boolean))].map((value) => encodeInt64(value));
}

function chapterKey(chapter: any): string {
  return [
    chapter?.url ?? "",
    chapter?.name ?? "",
    String(chapter?.chapterNumber ?? ""),
    int64ToString(chapter?.sourceOrder),
  ].join("|");
}

function trackingKey(tracking: any): string {
  return [
    String(tracking?.syncId ?? ""),
    int64ToString(tracking?.mediaId),
    tracking?.trackingUrl ?? "",
  ].join("|");
}

function historyKey(history: any): string {
  return history?.url ?? "";
}

function mergeChapter(left: any, right: any): any {
  return {
    ...left,
    ...right,
    [unknownWireFields]: mergedUnknownFields(left, right),
    url: preferLongerString(left?.url, right?.url),
    name: preferLongerString(left?.name, right?.name),
    scanlator: preferLongerString(left?.scanlator, right?.scanlator),
    read: Boolean(left?.read || right?.read),
    bookmark: Boolean(left?.bookmark || right?.bookmark),
    lastPageRead: maxLong(left?.lastPageRead, right?.lastPageRead),
    dateFetch: maxLong(left?.dateFetch, right?.dateFetch),
    dateUpload: maxLong(left?.dateUpload, right?.dateUpload),
    chapterNumber: Math.max(Number(left?.chapterNumber ?? 0), Number(right?.chapterNumber ?? 0)),
    sourceOrder: maxLong(left?.sourceOrder, right?.sourceOrder),
    lastModifiedAt: maxLong(left?.lastModifiedAt, right?.lastModifiedAt),
    version: maxLong(left?.version, right?.version),
  };
}

function mergeTracking(left: any, right: any): any {
  return {
    ...left,
    ...right,
    [unknownWireFields]: mergedUnknownFields(left, right),
    syncId: Number(preferTruthy(left?.syncId, right?.syncId) ?? 0),
    libraryId: maxLong(left?.libraryId, right?.libraryId),
    mediaIdInt: Number(preferTruthy(left?.mediaIdInt, right?.mediaIdInt) ?? 0),
    trackingUrl: preferLongerString(left?.trackingUrl, right?.trackingUrl),
    title: preferLongerString(left?.title, right?.title),
    lastChapterRead: Math.max(Number(left?.lastChapterRead ?? 0), Number(right?.lastChapterRead ?? 0)),
    totalChapters: Math.max(Number(left?.totalChapters ?? 0), Number(right?.totalChapters ?? 0)),
    score: Math.max(Number(left?.score ?? 0), Number(right?.score ?? 0)),
    status: Math.max(Number(left?.status ?? 0), Number(right?.status ?? 0)),
    startedReadingDate: minPositiveLong(left?.startedReadingDate, right?.startedReadingDate),
    finishedReadingDate: maxLong(left?.finishedReadingDate, right?.finishedReadingDate),
    private: Boolean(left?.private || right?.private),
    mediaId: maxLong(left?.mediaId, right?.mediaId),
  };
}

function mergeHistory(left: any, right: any): any {
  return {
    ...left,
    ...right,
    [unknownWireFields]: mergedUnknownFields(left, right),
    url: preferLongerString(left?.url, right?.url),
    lastRead: maxLong(left?.lastRead, right?.lastRead),
    readDuration: maxLong(left?.readDuration, right?.readDuration),
  };
}

function mergeRepeatedObjects(items: any[], keyFn: (value: any) => string, mergeFn: (left: any, right: any) => any): any[] {
  const merged = new Map<string, any>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    merged.set(key, merged.has(key) ? mergeFn(merged.get(key), item) : item);
  }
  return [...merged.values()];
}

function mergeDuplicateMangaMessages(messages: any[]): any[] {
  const merged = new Map<string, any>();

  for (const message of messages) {
    const key = [
      int64ToString(message?.source),
      message?.url ?? "",
      message?.title ?? "",
    ].join("|");

    if (!merged.has(key)) {
      merged.set(key, {
        ...message,
        genre: Array.isArray(message?.genre) ? [...message.genre] : [],
        categories: Array.isArray(message?.categories) ? [...message.categories] : [],
        chapters: Array.isArray(message?.chapters) ? [...message.chapters] : [],
        tracking: Array.isArray(message?.tracking) ? [...message.tracking] : [],
        history: Array.isArray(message?.history) ? [...message.history] : [],
        excludedScanlators: Array.isArray(message?.excludedScanlators) ? [...message.excludedScanlators] : [],
      });
      continue;
    }

    const current = merged.get(key);
    merged.set(key, {
      ...current,
      ...message,
      [unknownWireFields]: mergedUnknownFields(current, message),
      source: current.source,
      url: preferLongerString(current.url, message?.url),
      title: preferLongerString(current.title, message?.title),
      artist: preferLongerString(current.artist, message?.artist),
      author: preferLongerString(current.author, message?.author),
      description: preferLongerString(current.description, message?.description),
      thumbnailUrl: preferLongerString(current.thumbnailUrl, message?.thumbnailUrl),
      genre: uniqueStrings([...(current.genre ?? []), ...(message?.genre ?? [])]),
      status: Math.max(Number(current.status ?? 0), Number(message?.status ?? 0)),
      dateAdded: minPositiveLong(current.dateAdded, message?.dateAdded),
      viewer: Number(preferTruthy(current.viewer, message?.viewer) ?? 0),
      chapters: mergeRepeatedObjects([...(current.chapters ?? []), ...(message?.chapters ?? [])], chapterKey, mergeChapter),
      categories: uniqueInt64([...(current.categories ?? []), ...(message?.categories ?? [])]),
      tracking: mergeRepeatedObjects([...(current.tracking ?? []), ...(message?.tracking ?? [])], trackingKey, mergeTracking),
      favorite: Boolean(current.favorite || message?.favorite),
      chapterFlags: Number(preferTruthy(current.chapterFlags, message?.chapterFlags) ?? 0),
      viewer_flags: Number(preferTruthy(current.viewer_flags, message?.viewer_flags) ?? 0),
      history: mergeRepeatedObjects([...(current.history ?? []), ...(message?.history ?? [])], historyKey, mergeHistory),
      updateStrategy: Number(preferTruthy(current.updateStrategy, message?.updateStrategy) ?? 0),
      lastModifiedAt: maxLong(current.lastModifiedAt, message?.lastModifiedAt),
      favoriteModifiedAt: maxLong(current.favoriteModifiedAt, message?.favoriteModifiedAt),
      excludedScanlators: uniqueStrings([...(current.excludedScanlators ?? []), ...(message?.excludedScanlators ?? [])]),
      version: maxLong(current.version, message?.version),
      notes: preferLongerString(current.notes, message?.notes),
      initialized: Boolean(current.initialized || message?.initialized),
    });
  }

  return [...merged.values()];
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function maybeJsonBackup(bytes: Uint8Array): boolean {
  const first = bytes[0];
  return first === 0x7b;
}

function deriveLangForSource(
  sourceId: string,
  name: string,
  inventory: SourceInventoryEntry[],
): string | null {
  const exactIdMatches = inventory.filter((entry) => entry.sourceId === sourceId);
  if (exactIdMatches.length === 1) return exactIdMatches[0].lang;

  const normalized = normalizeName(name);
  if (!normalized || /^\d+$/.test(normalized)) return null;

  const nameMatches = inventory.filter((entry) => normalizeName(entry.name) === normalized);
  const langs = [...new Set(nameMatches.map((entry) => entry.lang))];
  return langs.length === 1 ? langs[0] : null;
}

function extractDelimitedMessage(reader: protobuf.Reader): Uint8Array {
  const length = reader.uint32();
  const start = reader.pos;
  const end = start + length;
  const bytes = reader.buf.subarray(start, end);
  reader.pos = end;
  return bytes;
}

function parseTopLevelChunks(bytes: Uint8Array): {
  mangaMessages: unknown[];
  sourceMessages: unknown[];
  extensionStoreMessages: unknown[];
  preservedTopLevelChunks: Uint8Array[];
} {
  const reader = protobuf.Reader.create(bytes);
  const mangaMessages: unknown[] = [];
  const sourceMessages: unknown[] = [];
  const extensionStoreMessages: unknown[] = [];
  const preservedTopLevelChunks: Uint8Array[] = [];
  const preferenceRepoUrls: string[] = [];

  while (reader.pos < reader.len) {
    const start = reader.pos;
    const tag = reader.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;

    if (wireType === 2 && fieldNo === BACKUP_TOP_LEVEL_MANGA_FIELD) {
      const chunk = extractDelimitedMessage(reader);
      const decoded = decodePreservingUnknown(BackupMangaType, chunk);
      // Tachiyomi/J2K declares favorite with a Kotlin default of true. kotlinx.serialization
      // omits that field for library entries and writes an explicit false for optional
      // read-history entries, while protobufjs' proto3 default is false for both cases.
      if (!Object.prototype.hasOwnProperty.call(decoded, "favorite")) decoded.favorite = true;
      mangaMessages.push(decoded);
      continue;
    }

    if (wireType === 2 && fieldNo === BACKUP_TOP_LEVEL_SOURCES_FIELD) {
      const chunk = extractDelimitedMessage(reader);
      sourceMessages.push(decodePreservingUnknown(BackupSourceType, chunk));
      continue;
    }

    if (wireType === 2 && fieldNo === BACKUP_TOP_LEVEL_EXTENSION_STORES_FIELD) {
      const chunk = extractDelimitedMessage(reader);
      extensionStoreMessages.push(BackupExtensionStoreType.decode(chunk));
      preservedTopLevelChunks.push(bytes.subarray(start, reader.pos));
      continue;
    }

    if (wireType === 2 && fieldNo === BACKUP_TOP_LEVEL_PREFERENCES_FIELD) {
      const chunk = extractDelimitedMessage(reader);
      preferenceRepoUrls.push(...extensionReposFromPreference(chunk));
      preservedTopLevelChunks.push(bytes.subarray(start, reader.pos));
      continue;
    }

    reader.skipType(wireType);
    preservedTopLevelChunks.push(bytes.subarray(start, reader.pos));
  }

  // Yokai, J2K and pre-1.0 Mihon keep repositories only in the `extension_repos` app
  // preference. Promote them to native store entries so review and restore see them.
  const knownStores = new Set(
    (extensionStoreMessages as any[])
      .map((store) => normalizedStoreUrl(typeof store?.indexUrl === "string" ? store.indexUrl : ""))
      .filter(Boolean),
  );
  for (const rawUrl of preferenceRepoUrls) {
    const indexUrl = normalizedStoreUrl(rawUrl);
    if (!/^https?:\/\//i.test(indexUrl) || knownStores.has(indexUrl)) continue;
    knownStores.add(indexUrl);
    const store = { indexUrl, name: storeNameFromUrl(indexUrl) };
    extensionStoreMessages.push(store);
    preservedTopLevelChunks.push(
      encodeFieldChunk(BACKUP_TOP_LEVEL_EXTENSION_STORES_FIELD, BackupExtensionStoreType.encode(store).finish()),
    );
  }

  return { mangaMessages, sourceMessages, extensionStoreMessages, preservedTopLevelChunks };
}

/** Reads the repository URLs of an `extension_repos` BackupPreference; any other preference yields none. */
function extensionReposFromPreference(chunk: Uint8Array): string[] {
  const fields = readLengthDelimitedFields(chunk);
  const key = fields.get(1)?.[0];
  const wrapper = fields.get(2)?.[0];
  if (!key || !wrapper || decodeUtf8(key) !== "extension_repos") return [];
  // kotlinx.serialization writes the polymorphic value as { 1: class name, 2: value message }.
  const value = readLengthDelimitedFields(wrapper);
  const type = value.get(1)?.[0];
  const set = value.get(2)?.[0];
  if (!type || !set || !decodeUtf8(type).endsWith("StringSetPreferenceValue")) return [];
  return (readLengthDelimitedFields(set).get(1) ?? []).map(decodeUtf8);
}

function readLengthDelimitedFields(bytes: Uint8Array): Map<number, Uint8Array[]> {
  const fields = new Map<number, Uint8Array[]>();
  const reader = protobuf.Reader.create(bytes);
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if ((tag & 7) !== 2) {
      reader.skipType(tag & 7);
      continue;
    }
    const values = fields.get(tag >>> 3) ?? [];
    values.push(extractDelimitedMessage(reader));
    fields.set(tag >>> 3, values);
  }
  return fields;
}

/** `https://raw.githubusercontent.com/keiyoushi/extensions/repo` → `keiyoushi`. */
function storeNameFromUrl(indexUrl: string): string {
  try {
    const url = new URL(indexUrl);
    return url.pathname.split("/").filter(Boolean)[0] || url.hostname;
  } catch {
    return "Extension repository";
  }
}

function toParsedBackupManga(message: any): ParsedBackupManga {
  return {
    sourceId: int64ToString(message.source),
    url: message.url ?? "",
    title: message.title ?? "",
    author: message.author || null,
    artist: message.artist || null,
    chapterCount: Array.isArray(message.chapters) ? message.chapters.length : null,
    thumbnailUrl: message.thumbnailUrl || null,
  };
}

function toParsedBackupSources(messages: any[], inventory: SourceInventoryEntry[]): ParsedBackupSource[] {
  return messages.map((message) => {
    const sourceId = int64ToString(message.sourceId);
    const name = message.name ?? "";
    return {
      sourceId,
      name,
      lang: deriveLangForSource(sourceId, name, inventory),
    };
  });
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function toParsedExtensionStores(messages: any[]): ParsedBackupExtensionStore[] {
  return messages
    .map((message) => ({
      indexUrl: typeof message?.indexUrl === "string" ? message.indexUrl.trim() : "",
      name: typeof message?.name === "string" ? message.name.trim() : "",
      badgeLabel: optionalString(message?.badgeLabel),
      signingKey: optionalString(message?.signingKey),
      contactWebsite: optionalString(message?.contactWebsite),
    }))
    .filter((store) => store.indexUrl.length > 0);
}

function encodeFieldChunk(fieldNo: number, messageBytes: Uint8Array): Uint8Array {
  return protobuf.Writer.create()
    .uint32((fieldNo << 3) | 2)
    .bytes(messageBytes)
    .finish();
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function normalizedStoreUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function embedMihonExtensionStores(
  fileBytes: ArrayBuffer | Uint8Array,
  stores: readonly ParsedBackupExtensionStore[],
): Uint8Array {
  const originalBytes = toUint8Array(fileBytes);
  const wasGzipped = originalBytes[0] === GZIP_MAGIC_1 && originalBytes[1] === GZIP_MAGIC_2;
  const decodedBytes = wasGzipped ? pako.ungzip(originalBytes) : originalBytes;
  const parsed = parseTopLevelChunks(decodedBytes);
  const existing = new Set(
    (parsed.extensionStoreMessages as any[])
      .map((store) => normalizedStoreUrl(typeof store?.indexUrl === "string" ? store.indexUrl : ""))
      .filter(Boolean),
  );
  const additions: Uint8Array[] = [];
  for (const store of stores) {
    const indexUrl = normalizedStoreUrl(store.indexUrl);
    if (!indexUrl || existing.has(indexUrl)) continue;
    existing.add(indexUrl);
    const message = BackupExtensionStoreType.encode({
      indexUrl,
      name: store.name.trim() || "Extension repository",
      badgeLabel: store.badgeLabel ?? "",
      signingKey: store.signingKey ?? "",
      contactWebsite: store.contactWebsite ?? "",
    }).finish();
    additions.push(encodeFieldChunk(BACKUP_TOP_LEVEL_EXTENSION_STORES_FIELD, message));
  }
  if (additions.length === 0) return originalBytes;
  const enriched = concatChunks([decodedBytes, ...additions]);
  return wasGzipped ? pako.gzip(enriched) : enriched;
}

export async function fingerprintBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", copyBytesToArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintText(input: string): Promise<string> {
  return fingerprintBytes(new TextEncoder().encode(input));
}

export async function parseMihonBackup(
  fileBytes: ArrayBuffer | Uint8Array,
  inventory: SourceInventoryEntry[],
): Promise<ParsedBackup> {
  const originalBytes = toUint8Array(fileBytes);
  if (maybeJsonBackup(originalBytes)) {
    throw new Error("JSON backups are not supported by this restore flow");
  }

  const wasGzipped = originalBytes[0] === GZIP_MAGIC_1 && originalBytes[1] === GZIP_MAGIC_2;
  const decodedBytes = wasGzipped ? pako.ungzip(originalBytes) : originalBytes;
  const { mangaMessages, sourceMessages, extensionStoreMessages, preservedTopLevelChunks } = parseTopLevelChunks(decodedBytes);

  const backupManga = mangaMessages
    .filter((message: any) => message.favorite !== false)
    .map((message) => toParsedBackupManga(message));
  const backupSources = toParsedBackupSources(sourceMessages as any[], inventory);
  const extensionStores = toParsedExtensionStores(extensionStoreMessages as any[]);
  const trackerIds = [
    ...new Set(
      mangaMessages
        .flatMap((message: any) => Array.isArray(message.tracking) ? message.tracking : [])
        .map((tracking: any) => Number(tracking?.syncId))
        .filter((syncId) => Number.isFinite(syncId) && syncId > 0),
    ),
  ];

  return {
    bytes: decodedBytes,
    wasGzipped,
    backupSources,
    backupManga,
    extensionStores,
    trackerIds,
    mangaMessages,
    sourceMessages,
    preservedTopLevelChunks,
  };
}

/** The titles exactly as the reconciled backup sends them to Suwayomi. */
export function reconciledMangaMessages(
  parsedBackup: ParsedBackup,
  sourceMapping: Record<string, { sourceId: string; name: string; lang?: string | null }>,
  excludedSourceIds: string[] = [],
): any[] {
  const excluded = new Set(excludedSourceIds);
  return mergeDuplicateMangaMessages(
    parsedBackup.mangaMessages
      .filter((message: any) => !excluded.has(int64ToString(message.source)))
      .map((message: any) => {
      const currentSourceId = int64ToString(message.source);
      const replacement = sourceMapping[currentSourceId];
      if (!replacement) return message;
      return {
        ...message,
        source: encodeInt64(replacement.sourceId),
      };
      }),
  );
}

export function createReconciledBackupPayload(
  parsedBackup: ParsedBackup,
  sourceMapping: Record<string, { sourceId: string; name: string; lang?: string | null }>,
  excludedSourceIds: string[] = [],
): Uint8Array {
  const excluded = new Set(excludedSourceIds);
  const patchedMangaMessages = reconciledMangaMessages(parsedBackup, sourceMapping, excludedSourceIds);

  const patchedSourceMessages = parsedBackup.sourceMessages
    .filter((message: any) => !excluded.has(int64ToString(message.sourceId)))
    .map((message: any) => {
      const currentSourceId = int64ToString(message.sourceId);
      const replacement = sourceMapping[currentSourceId];
      if (!replacement) return message;
      return {
        ...message,
        sourceId: encodeInt64(replacement.sourceId),
        name: replacement.name,
      };
    })
    .reduce<any[]>((deduped, message: any) => {
      const key = `${int64ToString(message.sourceId)}:${message.name ?? ""}`;
      const existing = deduped.find((entry) => `${int64ToString(entry.sourceId)}:${entry.name ?? ""}` === key);
      if (existing) {
        existing[unknownWireFields] = mergedUnknownFields(existing, message);
        return deduped;
      }
      deduped.push({ ...message });
      return deduped;
    }, []);

  const encodedChunks = [
    ...patchedMangaMessages.map((message) =>
      encodeFieldChunk(BACKUP_TOP_LEVEL_MANGA_FIELD, encodePreservingUnknown(BackupMangaType, message)),
    ),
    ...parsedBackup.preservedTopLevelChunks,
    ...patchedSourceMessages.map((message) =>
      encodeFieldChunk(BACKUP_TOP_LEVEL_SOURCES_FIELD, encodePreservingUnknown(BackupSourceType, message)),
    ),
  ];

  const payload = normalizeMihonMemoFields(concatChunks(encodedChunks));
  return parsedBackup.wasGzipped ? pako.gzip(payload) : payload;
}

export function decodedBackupDebugString(parsedBackup: ParsedBackup): string {
  return decodeUtf8(parsedBackup.bytes);
}

/** A work and its chapters as another desktop's Suwayomi lists them, times in milliseconds. */
export interface MihonImportWork {
  sourceId: string;
  url: string;
  title: string;
  author: string | null;
  artist: string | null;
  genre: string[];
  status: string | null;
  dateAdded: number;
  chapters: MihonImportChapter[];
}

export interface MihonImportChapter {
  url: string;
  name: string;
  scanlator: string | null;
  isRead: boolean;
  isBookmarked: boolean;
  lastPageRead: number;
  fetchedAt: number;
  uploadDate: number;
  chapterNumber: number;
  sourceOrder: number;
}

/** Mihon's `MangaStatus` numbers for Suwayomi's status names. */
const MIHON_MANGA_STATUS: Record<string, number> = {
  UNKNOWN: 0,
  ONGOING: 1,
  COMPLETED: 2,
  LICENSED: 3,
  PUBLISHING_FINISHED: 4,
  CANCELLED: 5,
  ON_HIATUS: 6,
};

function nonNegativeLong(value: number): Long {
  return Long.fromNumber(Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0, false);
}

/**
 * A gzip backup holding only these works and their chapters, in the library and in no category.
 * It has no description or cover, so Suwayomi fetches both from the source when a work is shown.
 */
export function encodeMihonImportBackup(works: readonly MihonImportWork[]): ArrayBuffer {
  const chunks = works.map((work) => {
    const manga = BackupMangaType.fromObject({
      source: encodeInt64(work.sourceId),
      url: work.url,
      title: work.title,
      artist: work.artist ?? "",
      author: work.author ?? "",
      genre: work.genre,
      status: MIHON_MANGA_STATUS[work.status ?? ""] ?? 0,
      dateAdded: nonNegativeLong(work.dateAdded),
      favorite: true,
      chapters: work.chapters.map((chapter) => ({
        url: chapter.url,
        name: chapter.name,
        scanlator: chapter.scanlator ?? "",
        read: chapter.isRead,
        bookmark: chapter.isBookmarked,
        lastPageRead: nonNegativeLong(chapter.lastPageRead),
        dateFetch: nonNegativeLong(chapter.fetchedAt),
        dateUpload: nonNegativeLong(chapter.uploadDate),
        chapterNumber: chapter.chapterNumber,
        sourceOrder: nonNegativeLong(chapter.sourceOrder),
      })),
    });
    return encodeFieldChunk(BACKUP_TOP_LEVEL_MANGA_FIELD, BackupMangaType.encode(manga).finish());
  });
  return copyBytesToArrayBuffer(pako.gzip(concatChunks(chunks)));
}
