import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../../store/state.svelte";
import {
  applySyncedComicReaderChanges,
  canonicalizeSuwayomiServerKey,
  comicHistoryId,
  comicMediaKey,
  comicPageBookmarkId,
} from "./comicReaderStateBridge";

const pairedFingerprint = "c47cc567e6c7ed7481dca23ed601f99a0d5f3beaa10b3cadae703c09505ed63f";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "syncd_get_comic_server_fingerprint") return pairedFingerprint;
    throw new Error(`Unexpected command: ${command}`);
  }),
}));

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  store.history = [];
  store.bookmarks = [];
});

describe("comic reader Core identity", () => {
  it("canonicalizes equivalent Suwayomi origins before hashing", async () => {
    expect(canonicalizeSuwayomiServerKey("HTTP://Example.COM:80/api/"))
      .toBe("http://example.com/api");
    await expect(comicMediaKey("HTTP://Example.COM:80/api/", 42))
      .resolves.toBe(await comicMediaKey("http://example.com/api", "42"));
  });

  it("creates deterministic cross-platform history and page bookmark ids", async () => {
    const comicId = await comicMediaKey("https://reader.example:443/", 7);
    expect(comicHistoryId(comicId)).toBe(`comic.history::${comicId}`);
    await expect(comicPageBookmarkId(comicId, 11, 3))
      .resolves.toBe(await comicPageBookmarkId(comicId, "11", 3));
    await expect(comicPageBookmarkId(comicId, 11, 4))
      .resolves.not.toBe(await comicPageBookmarkId(comicId, 11, 3));
  });

  it("materializes an empty authoritative snapshot as a real profile reset", async () => {
    store.history = [{
      mangaId: 7,
      mangaTitle: "Synced",
      thumbnailUrl: "",
      chapterId: 11,
      chapterName: "Chapter",
      readAt: 1,
      syncComicId: `suwayomi:${pairedFingerprint}:manga:7`,
      syncProfileId: "local-a",
    }];
    store.bookmarks = [{
      mangaId: 7,
      mangaTitle: "Synced",
      thumbnailUrl: "",
      chapterId: 11,
      chapterName: "Chapter",
      pageNumber: 3,
      savedAt: 1,
      syncEntityId: "comic-page-existing",
      syncProfileId: "local-a",
    }];

    await expect(applySyncedComicReaderChanges(
      "local-a",
      "https://reader.invalid",
      [],
      { scopeId: "comics:profile:remote-a", snapshotVersion: 42 },
    )).resolves.toBe(42);
    expect(store.history).toEqual([]);
    expect(store.bookmarks).toEqual([]);
  });
});
