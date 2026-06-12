import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";

import type { NovelRepositoryScopeInput } from "./repositoryState";

export interface CachedNovelChapter {
  version: 1;
  sourceId: string;
  novelId: string | null;
  chapterId: string | null;
  chapterPath: string;
  chapterTitle: string | null;
  content: string;
  savedAt: number;
}

export interface SaveNovelChapterCacheInput {
  sourceId: string;
  novelId?: string | null;
  chapterId?: string | null;
  chapterPath: string;
  chapterTitle?: string | null;
  content: string;
}

function canUseDesktopStorage(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function encodeBase64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Utf8(input: string): string {
  const binary = atob(input);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function resolveNovelChapterCachePath(
  scopeInput: NovelRepositoryScopeInput,
  sourceId: string,
  chapterPath: string,
): Promise<string | null> {
  if (!canUseDesktopStorage()) return null;
  const root = await invoke<string>("resolve_novel_storage_root", {
    profileId: scopeInput.profileId ?? null,
    serverUrl: scopeInput.serverUrl ?? null,
  });
  return join(root, "chapters", stableHash(sourceId), `${stableHash(chapterPath)}.json`);
}

function normalizeCachedNovelChapter(value: unknown): CachedNovelChapter | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const sourceId = typeof record.sourceId === "string" ? record.sourceId : "";
  const chapterPath = typeof record.chapterPath === "string" ? record.chapterPath : "";
  const content = typeof record.content === "string" ? record.content : "";
  if (!sourceId || !chapterPath || !content) return null;
  return {
    version: 1,
    sourceId,
    novelId: typeof record.novelId === "string" ? record.novelId : null,
    chapterId: typeof record.chapterId === "string" ? record.chapterId : null,
    chapterPath,
    chapterTitle: typeof record.chapterTitle === "string" ? record.chapterTitle : null,
    content,
    savedAt: typeof record.savedAt === "number" ? record.savedAt : Date.now(),
  };
}

export async function loadCachedNovelChapter(
  scopeInput: NovelRepositoryScopeInput,
  sourceId: string,
  chapterPath: string,
): Promise<CachedNovelChapter | null> {
  const path = await resolveNovelChapterCachePath(scopeInput, sourceId, chapterPath);
  if (!path) return null;
  try {
    const base64 = await invoke<string>("read_file_base64", { path });
    return normalizeCachedNovelChapter(JSON.parse(decodeBase64Utf8(base64)));
  } catch {
    return null;
  }
}

export async function saveCachedNovelChapter(
  scopeInput: NovelRepositoryScopeInput,
  input: SaveNovelChapterCacheInput,
): Promise<CachedNovelChapter | null> {
  if (!input.sourceId || !input.chapterPath || !input.content.trim()) return null;
  const path = await resolveNovelChapterCachePath(scopeInput, input.sourceId, input.chapterPath);
  if (!path) return null;
  const payload: CachedNovelChapter = {
    version: 1,
    sourceId: input.sourceId,
    novelId: input.novelId ?? null,
    chapterId: input.chapterId ?? null,
    chapterPath: input.chapterPath,
    chapterTitle: input.chapterTitle ?? null,
    content: input.content,
    savedAt: Date.now(),
  };
  await invoke("write_file_base64", {
    path,
    bytesBase64: encodeBase64Utf8(JSON.stringify(payload)),
  });
  return payload;
}
