import { describe, expect, it, vi } from "vitest";
import { preflightEpigraphRestorePayloads } from "./epigraphRestorePreflight";

describe("Epigraph restore preflight", () => {
  it("validates every selected payload before returning any restore input", async () => {
    const calls: string[] = [];
    const deps = {
      parseManga: vi.fn(async () => {
        calls.push("manga-container");
        return { payloadBytes: new Uint8Array([1, 2, 3]) };
      }),
      parseNativeManga: vi.fn(async () => {
        calls.push("manga-native");
        return { backupManga: [] };
      }),
      parseBooks: vi.fn(async () => {
        calls.push("books");
        throw new Error("invalid books payload");
      }),
      parseNovels: vi.fn(async () => {
        calls.push("novels");
        return { snapshot: {} };
      }),
      parseApp: vi.fn(async () => {
        calls.push("app");
        return { profile: {} };
      }),
    };

    await expect(preflightEpigraphRestorePayloads(
      new Uint8Array([9]),
      ["manga", "books", "novels", "app"],
      deps,
    )).rejects.toThrow("invalid books payload");

    expect(calls).toEqual(["manga-container", "manga-native", "books"]);
    expect(deps.parseNovels).not.toHaveBeenCalled();
    expect(deps.parseApp).not.toHaveBeenCalled();
  });

  it("returns validated payloads for the restore phase without invoking writers", async () => {
    const parsed = {
      manga: { payloadBytes: new Uint8Array([1]) },
      books: { library: { books: [] } },
      novels: { snapshot: { entries: [] } },
      app: { profile: { version: 2 } },
    };
    const deps = {
      parseManga: vi.fn(async () => parsed.manga),
      parseNativeManga: vi.fn(async () => ({ backupManga: [] })),
      parseBooks: vi.fn(async () => parsed.books),
      parseNovels: vi.fn(async () => parsed.novels),
      parseApp: vi.fn(async () => parsed.app),
    };

    const result = await preflightEpigraphRestorePayloads(
      new Uint8Array([9]),
      ["manga", "books", "novels", "app"],
      deps,
    );

    expect(result).toEqual(parsed);
  });
});
