import { invoke } from "@tauri-apps/api/core";
import { store, type BookmarkEntry, type HistoryEntry } from "../../store/state.svelte";

const MIRROR_KEY = "aethon-comic-reader-sync-v2";
const HISTORY_DEBOUNCE_MS = 250;
const LOCAL_PROFILE_KEY = "local";

export interface ComicHistoryPatch {
  historyId: string;
  comicId: string;
  chapterId: string;
  pageIndex: number;
  pageCount?: number | null;
  progressPercent: number;
  readAtMs: number;
  recordLamport?: number;
}

export interface ComicPageBookmarkPatch {
  bookmarkId: string;
  comicId: string;
  chapterId: string;
  pageIndex: number;
  pageCount?: number | null;
  label?: string | null;
  savedAtMs: number;
  recordLamport?: number;
}

export interface ComicReaderChangeEnvelope {
  serverVersion: number;
  scopeId: string;
  entityType: "comic.history" | "comic.page_bookmark";
  entityId: string;
  op: "merge" | "delete";
  lamport: number;
  patch?: Record<string, unknown> | null;
}

export interface ComicReaderSnapshotMarker {
  scopeId: string;
  snapshotVersion: number;
}

export interface SyncdComicReaderStateAppliedPayload {
  localProfileId: string;
  changes: ComicReaderChangeEnvelope[];
  authoritativeSnapshot?: ComicReaderSnapshotMarker | null;
}

interface ComicReaderMirror {
  histories: Record<string, ComicHistoryPatch>;
  bookmarks: Record<string, ComicPageBookmarkPatch>;
  tombstones: Record<string, number>;
  outbox: Record<string, PendingComicMutation>;
}

interface ComicReaderMirrorStore {
  profiles: Record<string, ComicReaderMirror>;
}

interface PendingComicMutation {
  entityType: ComicReaderChangeEnvelope["entityType"];
  entityId: string;
  op: ComicReaderChangeEnvelope["op"];
  patch: ComicHistoryPatch | ComicPageBookmarkPatch | null;
  serverFingerprint: string;
}

export interface RecordComicHistoryInput {
  profileId: string | null | undefined;
  serverKey: string;
  mangaId: number | string;
  chapterId: number | string;
  pageNumber: number;
  pageCount: number;
  readAtMs?: number;
}

export interface RecordComicBookmarkInput extends RecordComicHistoryInput {
  label?: string | null;
  savedAtMs?: number;
}

export interface DeleteComicBookmarkInput {
  profileId: string | null | undefined;
  serverKey: string;
  mangaId: number | string;
  chapterId: number | string;
  pageNumber: number;
  bookmarkId?: string | null;
}

export interface SyncedComicResumeInput {
  profileId: string | null | undefined;
  serverKey: string;
  mangaId: number | string;
  chapterId: number | string;
  pageCount?: number | null;
  localPageNumber?: number | null;
  localSavedAtMs?: number | null;
}

let historyTimer: ReturnType<typeof setTimeout> | null = null;

function emptyMirror(): ComicReaderMirror {
  return { histories: {}, bookmarks: {}, tombstones: {}, outbox: {} };
}

function loadMirrorStore(): ComicReaderMirrorStore {
  if (typeof localStorage === "undefined") return { profiles: {} };
  try {
    const parsed = JSON.parse(localStorage.getItem(MIRROR_KEY) ?? "null") as Partial<ComicReaderMirrorStore> | null;
    return { profiles: parsed?.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {} };
  } catch {
    return { profiles: {} };
  }
}

function profileKey(value: string | null | undefined): string {
  return normalizeProfileId(value) ?? LOCAL_PROFILE_KEY;
}

function loadMirror(profileId: string | null | undefined): ComicReaderMirror {
  const raw = loadMirrorStore().profiles[profileKey(profileId)];
  return {
    histories: raw?.histories && typeof raw.histories === "object" ? raw.histories : {},
    bookmarks: raw?.bookmarks && typeof raw.bookmarks === "object" ? raw.bookmarks : {},
    tombstones: raw?.tombstones && typeof raw.tombstones === "object" ? raw.tombstones : {},
    outbox: raw?.outbox && typeof raw.outbox === "object" ? raw.outbox : {},
  };
}

function saveMirror(profileId: string | null | undefined, mirror: ComicReaderMirror): void {
  if (typeof localStorage === "undefined") return;
  try {
    const state = loadMirrorStore();
    state.profiles[profileKey(profileId)] = mirror;
    localStorage.setItem(MIRROR_KEY, JSON.stringify(state));
  } catch {}
}

function finiteInteger(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function positivePageCount(value: number, pageIndex: number): number {
  return Math.max(pageIndex + 1, finiteInteger(value, pageIndex + 1), 1);
}

function normalizeProfileId(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function normalizeComponent(value: number | string, label: string): string {
  const normalized = String(value).trim();
  if (!normalized || normalized.includes("\0")) throw new Error(`${label} is invalid.`);
  return normalized;
}

/** Matches the canonical server key hashed by the Android comic reader. */
export function canonicalizeSuwayomiServerKey(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Suwayomi server key must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Suwayomi server key cannot contain user information.");
  }
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.search = "";
  parsed.hash = "";
  if ((parsed.protocol === "https:" && parsed.port === "443")
    || (parsed.protocol === "http:" && parsed.port === "80")) {
    parsed.port = "";
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = normalizedPath || "/";
  return parsed.pathname === "/" ? parsed.origin : parsed.toString().replace(/\/$/, "");
}

export async function sha256Utf8Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function comicServerFingerprint(
  profileId: string | null | undefined,
  serverKey: string,
  requireCoreIdentity = false,
): Promise<string> {
  const normalizedProfileId = normalizeProfileId(profileId);
  if (normalizedProfileId) {
    try {
      return await invoke<string>("syncd_get_comic_server_fingerprint", {
        profileId: normalizedProfileId,
      });
    } catch (error) {
      if (requireCoreIdentity) throw error;
    }
  }
  if (requireCoreIdentity) throw new Error("Paired Core comic identity is unavailable.");
  return sha256Utf8Hex(canonicalizeSuwayomiServerKey(serverKey));
}

export async function comicMediaKey(
  serverKey: string,
  mangaId: number | string,
  profileId?: string | null,
): Promise<string> {
  const fingerprint = await comicServerFingerprint(profileId, serverKey);
  return `suwayomi:${fingerprint}:manga:${normalizeComponent(mangaId, "mangaId")}`;
}

export function comicHistoryId(comicId: string): string {
  return `comic.history::${comicId}`;
}

/** Stable cross-platform ID for an explicit bookmark at one comic locator. */
export async function comicPageBookmarkId(
  comicId: string,
  chapterId: number | string,
  pageIndex: number,
): Promise<string> {
  const locator = JSON.stringify([comicId, normalizeComponent(chapterId, "chapterId"), pageIndex]);
  return `comic-page-${await sha256Utf8Hex(locator)}`;
}

function historyPatch(input: RecordComicHistoryInput, comicId: string, readAtMs: number): ComicHistoryPatch {
  const pageIndex = Math.max(0, finiteInteger(input.pageNumber, 1) - 1);
  const pageCount = positivePageCount(input.pageCount, pageIndex);
  return {
    historyId: comicHistoryId(comicId),
    comicId,
    chapterId: normalizeComponent(input.chapterId, "chapterId"),
    pageIndex,
    pageCount,
    progressPercent: Math.min(1, Math.max(0, (pageIndex + 1) / pageCount)),
    readAtMs: Math.max(0, finiteInteger(readAtMs, Date.now())),
  };
}

async function submitComicMutation(
  profileId: string,
  entityType: ComicReaderChangeEnvelope["entityType"],
  entityId: string,
  op: ComicReaderChangeEnvelope["op"],
  patch: ComicHistoryPatch | ComicPageBookmarkPatch | null,
): Promise<void> {
  await invoke("syncd_publish_comic_reader_mutation", {
    input: { profileId, entityType, entityId, op, patch },
  });
}

function mutationKey(mutation: Pick<PendingComicMutation, "entityType" | "entityId">): string {
  return `${mutation.entityType}:${mutation.entityId}`;
}

function enqueueMutation(profileId: string, mutation: PendingComicMutation): void {
  const mirror = loadMirror(profileId);
  mirror.outbox[mutationKey(mutation)] = mutation;
  saveMirror(profileId, mirror);
}

export async function flushPendingComicHistory(): Promise<void> {
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = null;
  }
  const state = loadMirrorStore();
  for (const profileId of Object.keys(state.profiles)) {
    if (profileId === LOCAL_PROFILE_KEY) continue;
    const mirror = loadMirror(profileId);
    for (const [key, mutation] of Object.entries(mirror.outbox)) {
      try {
        const currentFingerprint = await invoke<string>("syncd_get_comic_server_fingerprint", {
          profileId,
        });
        if (currentFingerprint !== mutation.serverFingerprint) {
          continue;
        }
        await submitComicMutation(
          profileId,
          mutation.entityType,
          mutation.entityId,
          mutation.op,
          mutation.patch,
        );
        const latest = loadMirror(profileId);
        if (JSON.stringify(latest.outbox[key]) === JSON.stringify(mutation)) {
          delete latest.outbox[key];
          saveMirror(profileId, latest);
        }
      } catch {
        // Durable outbox is retried on the next reader event/startup flush.
      }
    }
  }
}

export async function recordComicHistory(input: RecordComicHistoryInput): Promise<void> {
  const comicId = await comicMediaKey(input.serverKey, input.mangaId, input.profileId);
  const patch = historyPatch(input, comicId, input.readAtMs ?? Date.now());
  const profileId = normalizeProfileId(input.profileId);
  const mirror = loadMirror(profileId);
  mirror.histories[comicId] = patch;
  saveMirror(profileId, mirror);

  if (!profileId) return;
  enqueueMutation(profileId, {
    entityType: "comic.history",
    entityId: patch.historyId,
    op: "merge",
    patch,
    serverFingerprint: comicParts(comicId)?.fingerprint ?? "",
  });
  if (historyTimer) clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    historyTimer = null;
    void flushPendingComicHistory();
  }, HISTORY_DEBOUNCE_MS);
}

export async function recordComicPageBookmark(input: RecordComicBookmarkInput): Promise<string> {
  const comicId = await comicMediaKey(input.serverKey, input.mangaId, input.profileId);
  const base = historyPatch(input, comicId, input.savedAtMs ?? Date.now());
  const bookmarkId = await comicPageBookmarkId(comicId, base.chapterId, base.pageIndex);
  const patch: ComicPageBookmarkPatch = {
    bookmarkId,
    comicId,
    chapterId: base.chapterId,
    pageIndex: base.pageIndex,
    pageCount: base.pageCount,
    label: input.label ?? null,
    savedAtMs: Math.max(0, finiteInteger(input.savedAtMs ?? Date.now(), Date.now())),
  };
  const profileId = normalizeProfileId(input.profileId);
  const mirror = loadMirror(profileId);
  mirror.bookmarks[bookmarkId] = patch;
  delete mirror.tombstones[bookmarkId];
  saveMirror(profileId, mirror);
  store.bookmarks = store.bookmarks.map((bookmark) => (
    bookmark.mangaId === Number(input.mangaId)
      && bookmark.chapterId === Number(input.chapterId)
      && bookmark.pageNumber === input.pageNumber
      ? { ...bookmark, syncEntityId: bookmarkId, syncProfileId: profileId ?? undefined }
      : bookmark
  ));

  if (profileId) {
    enqueueMutation(profileId, {
      entityType: "comic.page_bookmark",
      entityId: bookmarkId,
      op: "merge",
      patch,
      serverFingerprint: comicParts(comicId)?.fingerprint ?? "",
    });
    void flushPendingComicHistory();
  }
  return bookmarkId;
}

export async function deleteComicPageBookmark(input: DeleteComicBookmarkInput): Promise<void> {
  const comicId = await comicMediaKey(input.serverKey, input.mangaId, input.profileId);
  const pageIndex = Math.max(0, finiteInteger(input.pageNumber, 1) - 1);
  const bookmarkId = input.bookmarkId?.trim()
    || await comicPageBookmarkId(comicId, input.chapterId, pageIndex);
  const profileId = normalizeProfileId(input.profileId);
  const mirror = loadMirror(profileId);
  delete mirror.bookmarks[bookmarkId];
  mirror.tombstones[bookmarkId] = Date.now();
  saveMirror(profileId, mirror);
  if (profileId) {
    enqueueMutation(profileId, {
      entityType: "comic.page_bookmark",
      entityId: bookmarkId,
      op: "delete",
      patch: null,
      serverFingerprint: comicParts(comicId)?.fingerprint ?? "",
    });
    void flushPendingComicHistory();
  }
}

export async function resolveSyncedComicResumePage(input: SyncedComicResumeInput): Promise<number | null> {
  const comicId = await comicMediaKey(input.serverKey, input.mangaId, input.profileId);
  const history = loadMirror(input.profileId).histories[comicId];
  const localPage = Math.max(0, finiteInteger(input.localPageNumber ?? 0));
  if (!history || history.chapterId !== String(input.chapterId)) {
    return localPage > 0 ? localPage : null;
  }
  const maxPage = Math.max(1, finiteInteger(input.pageCount ?? history.pageCount ?? 1, 1));
  const corePage = history.pageIndex + 1;
  return Math.max(1, Math.min(maxPage, Math.max(localPage, corePage)));
}

function comicParts(comicId: string): { fingerprint: string; mangaId: number } | null {
  const match = /^suwayomi:([a-f0-9]{64}):manga:(.+)$/.exec(comicId);
  if (!match) return null;
  const mangaId = Number(match[2]);
  return Number.isFinite(mangaId) ? { fingerprint: match[1], mangaId } : null;
}

function parseHistoryPatch(value: Record<string, unknown> | null | undefined): ComicHistoryPatch | null {
  if (!value || typeof value.historyId !== "string" || typeof value.comicId !== "string"
    || typeof value.chapterId !== "string" || typeof value.pageIndex !== "number"
    || typeof value.progressPercent !== "number" || typeof value.readAtMs !== "number") return null;
  return value as unknown as ComicHistoryPatch;
}

function parseBookmarkPatch(value: Record<string, unknown> | null | undefined): ComicPageBookmarkPatch | null {
  if (!value || typeof value.bookmarkId !== "string" || typeof value.comicId !== "string"
    || typeof value.chapterId !== "string" || typeof value.pageIndex !== "number"
    || typeof value.savedAtMs !== "number") return null;
  return value as unknown as ComicPageBookmarkPatch;
}

function mangaMetadata(mangaId: number, profileId: string) {
  const manga = store.activeManga?.id === mangaId
    ? store.activeManga
    : store.libraryMangaSnapshot.find((candidate) => candidate.id === mangaId);
  const history = store.history.find((entry) => (
    entry.mangaId === mangaId
    && (!entry.syncProfileId || entry.syncProfileId === profileId)
  ));
  const bookmark = store.bookmarks.find((entry) => (
    entry.mangaId === mangaId
    && (!entry.syncProfileId || entry.syncProfileId === profileId)
  ));
  return {
    title: manga?.title ?? history?.mangaTitle ?? bookmark?.mangaTitle ?? "",
    thumbnailUrl: manga?.thumbnailUrl ?? history?.thumbnailUrl ?? bookmark?.thumbnailUrl ?? "",
  };
}

function chapterMetadata(mangaId: number, chapterId: number, profileId: string) {
  const chapter = store.activeManga?.id === mangaId
    ? store.activeChapterList.find((candidate) => candidate.id === chapterId)
    : null;
  const history = store.history.find((entry) => (
    entry.mangaId === mangaId
    && entry.chapterId === chapterId
    && (!entry.syncProfileId || entry.syncProfileId === profileId)
  ));
  const bookmark = store.bookmarks.find((entry) => (
    entry.mangaId === mangaId
    && entry.chapterId === chapterId
    && (!entry.syncProfileId || entry.syncProfileId === profileId)
  ));
  return chapter?.name ?? history?.chapterName ?? bookmark?.chapterName ?? "";
}

function applyHistoryToStore(profileId: string, patch: ComicHistoryPatch): void {
  const parts = comicParts(patch.comicId);
  const chapterId = Number(patch.chapterId);
  if (!parts || !Number.isFinite(chapterId)) return;
  const metadata = mangaMetadata(parts.mangaId, profileId);
  if (!metadata.title) return;
  const entry: HistoryEntry = {
    mangaId: parts.mangaId,
    mangaTitle: metadata.title,
    thumbnailUrl: metadata.thumbnailUrl,
    chapterId,
    chapterName: chapterMetadata(parts.mangaId, chapterId, profileId),
    readAt: patch.readAtMs,
    pageNumber: patch.pageIndex + 1,
    pageCount: patch.pageCount ?? undefined,
    syncComicId: patch.comicId,
    syncProfileId: profileId,
  };
  store.history = [
    entry,
    ...store.history.filter((current) => !(
      current.mangaId === entry.mangaId
      && (!current.syncProfileId || current.syncProfileId === profileId)
    )),
  ].slice(0, 300);
}

function applyBookmarkToStore(profileId: string, patch: ComicPageBookmarkPatch): void {
  const parts = comicParts(patch.comicId);
  const chapterId = Number(patch.chapterId);
  if (!parts || !Number.isFinite(chapterId)) return;
  const metadata = mangaMetadata(parts.mangaId, profileId);
  if (!metadata.title) return;
  const entry: BookmarkEntry = {
    mangaId: parts.mangaId,
    mangaTitle: metadata.title,
    thumbnailUrl: metadata.thumbnailUrl,
    chapterId,
    chapterName: chapterMetadata(parts.mangaId, chapterId, profileId),
    pageNumber: patch.pageIndex + 1,
    savedAt: patch.savedAtMs,
    label: patch.label ?? undefined,
    syncEntityId: patch.bookmarkId,
    syncProfileId: profileId,
  };
  store.bookmarks = [
    entry,
    ...store.bookmarks.filter((current) => (
      (current.syncProfileId && current.syncProfileId !== profileId)
      || (
        current.syncEntityId !== entry.syncEntityId
        && !(
          current.mangaId === entry.mangaId
          && current.chapterId === entry.chapterId
          && current.pageNumber === entry.pageNumber
        )
      )
    )),
  ].slice(0, 200);
}

/** Applies remote records directly; it intentionally never calls a publisher. */
export async function applySyncedComicReaderChanges(
  profileId: string,
  serverKey: string,
  changes: ComicReaderChangeEnvelope[],
  authoritativeSnapshot?: ComicReaderSnapshotMarker | null,
): Promise<number | null> {
  const expectedFingerprint = await comicServerFingerprint(profileId, serverKey, true);
  const mirror = loadMirror(profileId);
  let changed = false;
  let throughServerVersion: number | null = null;

  if (authoritativeSnapshot) {
    if (!/^comics:profile:[^\0]+$/.test(authoritativeSnapshot.scopeId)
      || !Number.isSafeInteger(authoritativeSnapshot.snapshotVersion)
      || authoritativeSnapshot.snapshotVersion < 0) {
      throw new Error("Invalid authoritative comic snapshot marker.");
    }
    if (changes.some((change) => (
      change.scopeId !== authoritativeSnapshot.scopeId
      || change.serverVersion > authoritativeSnapshot.snapshotVersion
    ))) {
      throw new Error("Comic snapshot contents do not match its authoritative marker.");
    }

    // A snapshot replaces the synchronized mirror for this local profile, even
    // when it contains no entities. Local pending writes remain durable and are
    // retried after the reset.
    mirror.histories = {};
    mirror.bookmarks = {};
    mirror.tombstones = {};
    store.history = store.history.filter((entry) => !(
      entry.syncProfileId === profileId
      || (!entry.syncProfileId && Boolean(entry.syncComicId))
    ));
    store.bookmarks = store.bookmarks.filter((entry) => !(
      entry.syncProfileId === profileId
      || (!entry.syncProfileId && Boolean(entry.syncEntityId))
    ));
    changed = true;
    throughServerVersion = authoritativeSnapshot.snapshotVersion;
  }

  for (const change of [...changes].sort((left, right) => left.serverVersion - right.serverVersion)) {
    if (!/^comics:profile:[^\0]+$/.test(change.scopeId)) {
      throw new Error("Invalid comic reader change scope.");
    }
    if (change.entityType === "comic.history") {
      if (change.op === "delete") {
        const comicId = change.entityId.startsWith("comic.history::")
          ? change.entityId.slice("comic.history::".length)
          : null;
        if (!comicId || comicParts(comicId)?.fingerprint !== expectedFingerprint) {
          throw new Error("comic.history delete does not match the paired Core identity.");
        }
        if ((mirror.tombstones[change.entityId] ?? -1) > change.lamport) {
          throughServerVersion = change.serverVersion;
          continue;
        }
        delete mirror.histories[comicId];
        mirror.tombstones[change.entityId] = change.lamport;
        const mangaId = comicParts(comicId)?.mangaId;
        if (mangaId != null) store.history = store.history.filter((entry) => !(
          entry.mangaId === mangaId
          && (!entry.syncProfileId || entry.syncProfileId === profileId)
        ));
        changed = true;
        throughServerVersion = change.serverVersion;
        continue;
      }
      const patch = parseHistoryPatch(change.patch);
      if (!patch || comicParts(patch.comicId)?.fingerprint !== expectedFingerprint) {
        throw new Error("Invalid comic.history change for the paired Core identity.");
      }
      if ((mirror.tombstones[change.entityId] ?? -1) >= change.lamport) {
        throughServerVersion = change.serverVersion;
        continue;
      }
      const current = mirror.histories[patch.comicId];
      if (current?.recordLamport != null && current.recordLamport > change.lamport) {
        throughServerVersion = change.serverVersion;
        continue;
      }
      const next = { ...patch, recordLamport: change.lamport };
      mirror.histories[patch.comicId] = next;
      delete mirror.tombstones[change.entityId];
      applyHistoryToStore(profileId, next);
      changed = true;
      throughServerVersion = change.serverVersion;
      continue;
    }

    if (change.op === "delete") {
      const current = mirror.bookmarks[change.entityId];
      if (current && comicParts(current.comicId)?.fingerprint !== expectedFingerprint) {
        throw new Error("comic.page_bookmark delete does not match the paired Core identity.");
      }
      if ((mirror.tombstones[change.entityId] ?? -1) > change.lamport) {
        throughServerVersion = change.serverVersion;
        continue;
      }
      delete mirror.bookmarks[change.entityId];
      mirror.tombstones[change.entityId] = change.lamport;
      store.bookmarks = store.bookmarks.filter((entry) => !(
        entry.syncEntityId === change.entityId
        && (!entry.syncProfileId || entry.syncProfileId === profileId)
      ));
      changed = true;
      throughServerVersion = change.serverVersion;
      continue;
    }
    const patch = parseBookmarkPatch(change.patch);
    if (!patch || comicParts(patch.comicId)?.fingerprint !== expectedFingerprint) {
      throw new Error("Invalid comic.page_bookmark change for the paired Core identity.");
    }
    if ((mirror.tombstones[change.entityId] ?? -1) >= change.lamport) {
      throughServerVersion = change.serverVersion;
      continue;
    }
    const current = mirror.bookmarks[patch.bookmarkId];
    if (current?.recordLamport != null && current.recordLamport > change.lamport) {
      throughServerVersion = change.serverVersion;
      continue;
    }
    const next = { ...patch, recordLamport: change.lamport };
    mirror.bookmarks[patch.bookmarkId] = next;
    delete mirror.tombstones[change.entityId];
    applyBookmarkToStore(profileId, next);
    changed = true;
    throughServerVersion = change.serverVersion;
  }
  if (changed) {
    saveMirror(profileId, mirror);
    store.bumpContentSetupVersion();
  }
  if (authoritativeSnapshot) {
    return Math.max(authoritativeSnapshot.snapshotVersion, throughServerVersion ?? 0);
  }
  return throughServerVersion;
}
