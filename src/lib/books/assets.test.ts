import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockedReadFileAsArrayBuffer,
  mockedWriteBookCover,
  mockedCanRenderEmbeddedImage,
  mockedCanRenderBookCoverPath,
  mockedParseEpubArchive,
} = vi.hoisted(() => ({
  mockedReadFileAsArrayBuffer: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
  mockedWriteBookCover: vi.fn(async (bookId: string, _bytesBase64: string, ext: string) =>
    `C:\\books\\${bookId}.${ext}`,
  ),
  mockedCanRenderEmbeddedImage: vi.fn(async () => true),
  mockedCanRenderBookCoverPath: vi.fn(async () => true),
  mockedParseEpubArchive: vi.fn(async (_buffer: ArrayBuffer, fallbackTitle: string) => ({
    title: fallbackTitle,
    author: null,
    description: null,
    cover: {
      mediaType: "image/jpeg",
      ext: "jpg",
      bytesBase64: "Zm9vYmFyYmF6cXV4cXV1eA==Zm9vYmFyYmF6cXV4cXV1eA==",
    },
    toc: [],
    spine: [],
  })),
}));

vi.mock("./storage", () => ({
  filePathAsStableUrl: (filePath: string, protocol = "asset") =>
    `http://${protocol}.localhost/${encodeURIComponent(filePath)}`,
  dropCachedFileStableUrl: vi.fn(),
  isUsableBookCoverUrl: (coverUrl: string | null | undefined) =>
    typeof coverUrl === "string" && coverUrl.startsWith("data:image/") && coverUrl.length > 64,
  readFileAsArrayBuffer: mockedReadFileAsArrayBuffer,
  writeBookCover: mockedWriteBookCover,
  canRenderEmbeddedImage: mockedCanRenderEmbeddedImage,
  canRenderBookCoverPath: mockedCanRenderBookCoverPath,
}));

vi.mock("./epub", () => ({
  parseEpubArchive: mockedParseEpubArchive,
}));

import {
  BookAssetResolver,
  createImportedBookId,
  needsCanonicalBookMigration,
  toPersistedBookEntry,
} from "./assets";
import type { BookEntry } from "./types";

beforeEach(() => {
  mockedReadFileAsArrayBuffer.mockClear();
  mockedWriteBookCover.mockClear();
  mockedCanRenderEmbeddedImage.mockClear();
  mockedCanRenderEmbeddedImage.mockImplementation(async () => true);
  mockedCanRenderBookCoverPath.mockClear();
  mockedCanRenderBookCoverPath.mockImplementation(async () => true);
  mockedParseEpubArchive.mockClear();
  mockedParseEpubArchive.mockImplementation(async (_buffer: ArrayBuffer, fallbackTitle: string) => ({
    title: fallbackTitle,
    author: null,
    description: null,
    cover: {
      mediaType: "image/jpeg",
      ext: "jpg",
      bytesBase64: "Zm9vYmFyYmF6cXV4cXV1eA==Zm9vYmFyYmF6cXV4cXV1eA==",
    },
    toc: [],
    spine: [],
  }));
});

function makeBook(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    id: "book-1",
    title: "Example",
    author: null,
    description: null,
    coverPath: "C:\\books\\cover.jpg",
    subtype: "epub",
    createdAt: 0,
    updatedAt: 0,
    importPath: "C:\\books\\example.epub",
    assetPath: "C:\\books\\example.epub",
    assetFingerprint: "abc123",
    toc: [{ id: "t1", label: "Chapter 1", href: "OPS/ch1.xhtml", depth: 0 }],
    spine: [{ id: "s1", label: "ch1.xhtml", href: "OPS/ch1.xhtml" }],
    ...overrides,
  };
}

describe("createImportedBookId", () => {
  it("uses the full deterministic fingerprint in the imported book id", () => {
    expect(createImportedBookId("epub", "deadbeef")).toBe("epub-deadbeef");
  });
});

describe("BookAssetResolver.resolveCoverSrc", () => {
  it("uses the canonical book protocol URL instead of persisted visual state", () => {
    const src = BookAssetResolver.resolveCoverSrc(
      makeBook({
        updatedAt: 42,
        coverUrl: "data:image/jpeg;base64,Zm9vYmFyYmF6",
      }),
    );

    expect(src).toBe("http://book.localhost/C%3A%5Cbooks%5Ccover.jpg?v=42");
  });
});

describe("BookAssetResolver.resolvePreviewAsset", () => {
  it("returns the preview payload only through the canonical resolver contract", async () => {
    const payload = await BookAssetResolver.resolvePreviewAsset(
      makeBook({
        title: "Chrysalis",
        subtype: "epub",
        assetPath: "C:\\books\\chrysalis.epub",
      }),
    );

    expect(mockedReadFileAsArrayBuffer).toHaveBeenCalledWith("C:\\books\\chrysalis.epub");
    expect(payload.title).toBe("Chrysalis");
    expect(payload.subtype).toBe("epub");
    expect(payload.mimeType).toBe("application/epub+zip");
    expect(payload.bytes).toBeInstanceOf(ArrayBuffer);
  });
});

describe("needsCanonicalBookMigration", () => {
  it("requires migration for legacy visual or raw structural fields", () => {
    expect(
      needsCanonicalBookMigration(
        makeBook({
          assetFingerprint: undefined,
          coverPath: null,
          coverUrl: "data:image/jpeg;base64,Zm9vYmFyYmF6cXV4cXV1eA==Zm9vYmFyYmF6cXV4cXV1eA==",
        }),
      ),
    ).toBe(true);
  });

  it("treats a canonical local book as already migrated", () => {
    expect(
      needsCanonicalBookMigration(
        makeBook({
          coverUrl: undefined,
          toc: undefined,
          spine: undefined,
          sectionsSummary: [{ id: "s1", label: "Chapter 1", href: "OPS/ch1.xhtml", depth: 0 }],
          sectionCount: 1,
          tocCount: 1,
          spineCount: 1,
        }),
      ),
    ).toBe(false);
  });

  it("treats an EPUB without a valid coverPath as canonical once legacy visual state is gone", () => {
    expect(
      needsCanonicalBookMigration(
        makeBook({
          coverPath: null,
          coverUrl: undefined,
          toc: undefined,
          spine: undefined,
          sectionsSummary: [{ id: "s1", label: "Chapter 1", href: "OPS/ch1.xhtml", depth: 0 }],
          sectionCount: 1,
          tocCount: 1,
          spineCount: 1,
        }),
      ),
    ).toBe(false);
  });
});

describe("toPersistedBookEntry", () => {
  it("drops legacy visual and raw structural fields once canonical assets exist", () => {
    const persisted = toPersistedBookEntry(
      makeBook({
        coverUrl: "data:image/jpeg;base64,Zm9vYmFyYmF6cXV4cXV1eA==",
      }),
    );

    expect(persisted.coverUrl).toBeUndefined();
    expect(persisted.toc).toBeUndefined();
    expect(persisted.spine).toBeUndefined();
    expect(persisted.sectionCount).toBe(1);
    expect(persisted.sectionsSummary).toHaveLength(1);
    expect(persisted.tocCount).toBe(1);
    expect(persisted.spineCount).toBe(1);
  });

  it("keeps legacy coverUrl only while coverPath has not been migrated yet", () => {
    const persisted = toPersistedBookEntry(
      makeBook({
        coverPath: null,
        coverUrl: "data:image/jpeg;base64,Zm9vYmFyYmF6cXV4cXV1eA==Zm9vYmFyYmF6cXV4cXV1eA==",
      }),
    );

    expect(persisted.coverUrl).toContain("data:image/jpeg;base64,");
    expect(persisted.toc).toBeUndefined();
    expect(persisted.spine).toBeUndefined();
  });
});

describe("BookAssetResolver.ensureCanonicalBookEntry", () => {
  it("restores a missing EPUB coverPath from the canonical asset when the embedded cover is valid", async () => {
    const patch = await BookAssetResolver.ensureCanonicalBookEntry(
      makeBook({
        assetFingerprint: undefined,
        coverPath: null,
        coverUrl: undefined,
      }),
    );

    expect(mockedParseEpubArchive).toHaveBeenCalled();
    expect(mockedWriteBookCover).toHaveBeenCalledWith(
      "book-1",
      "Zm9vYmFyYmF6cXV4cXV1eA==Zm9vYmFyYmF6cXV4cXV1eA==",
      "jpg",
    );
    expect(patch).toMatchObject({
      coverPath: "C:\\books\\book-1.jpg",
    });
  });

  it("migrates a legacy local book into the canonical asset model in one pass", async () => {
    const patch = await BookAssetResolver.ensureCanonicalBookEntry(
      makeBook({
        assetFingerprint: undefined,
        coverPath: null,
        coverUrl: "data:image/jpeg;base64,Zm9vYmFyYmF6cXV4cXV1eA==Zm9vYmFyYmF6cXV4cXV1eA==",
      }),
    );

    expect(mockedReadFileAsArrayBuffer).toHaveBeenCalled();
    expect(mockedWriteBookCover).toHaveBeenCalledWith(
      "book-1",
      "Zm9vYmFyYmF6cXV4cXV1eA==Zm9vYmFyYmF6cXV4cXV1eA==",
      "jpg",
    );
    expect(patch).toMatchObject({
      coverPath: "C:\\books\\book-1.jpg",
      coverUrl: undefined,
      toc: undefined,
      spine: undefined,
      sectionCount: 1,
      tocCount: 1,
      spineCount: 1,
    });
    expect(patch?.assetFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(patch?.sectionsSummary).toHaveLength(1);
  });
});
