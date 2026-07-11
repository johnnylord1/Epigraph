import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockedReadFileAsArrayBuffer,
  mockedComputeFileSha256,
  mockedWriteBookCover,
  mockedCanRenderEmbeddedImage,
  mockedCanRenderBookCoverPath,
  mockedParseEpubArchive,
  mockedExtractPdfBookData,
} = vi.hoisted(() => ({
  mockedReadFileAsArrayBuffer: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
  mockedComputeFileSha256: vi.fn(async () => "native-file-hash"),
  mockedWriteBookCover: vi.fn(async (bookId: string, _bytesBase64: string, ext: string) =>
    `C:\\books\\${bookId}.${ext}`,
  ),
  mockedCanRenderEmbeddedImage: vi.fn(async () => true),
  mockedCanRenderBookCoverPath: vi.fn(async () => true),
  mockedParseEpubArchive: vi.fn(async (_buffer: ArrayBuffer, fallbackTitle: string) => ({
    title: fallbackTitle,
    author: null,
    description: null,
    genres: ["Fantasy", "Adventure"],
    isbns: ["9780306406157"],
    cover: {
      mediaType: "image/jpeg",
      ext: "jpg",
      bytesBase64: "Zm9vYmFyYmF6cXV4cXV1eA==Zm9vYmFyYmF6cXV4cXV1eA==",
    },
    toc: [],
    spine: [],
  })),
  mockedExtractPdfBookData: vi.fn(async (_assetPath: string, _bookId: string, fallbackTitle: string) => ({
    title: fallbackTitle,
    author: "PDF Author",
    description: "PDF Description",
    pageCount: 8,
    coverPath: "C:\\books\\pdf-cover.jpg",
    sectionsSummary: [{ id: "pdf-outline:1:1", label: "Intro", href: "page:1", depth: 0 }],
    sectionCount: 1,
    tocCount: 1,
    spineCount: 0,
    isbns: ["9780306406157"],
  })),
}));

vi.mock("./storage", () => ({
  filePathAsStableUrl: (filePath: string, protocol = "asset") =>
    `http://${protocol}.localhost/${encodeURIComponent(filePath)}`,
  dropCachedFileStableUrl: vi.fn(),
  isUsableBookCoverUrl: (coverUrl: string | null | undefined) =>
    typeof coverUrl === "string" && coverUrl.startsWith("data:image/") && coverUrl.length > 64,
  readFileAsArrayBuffer: mockedReadFileAsArrayBuffer,
  computeFileSha256: mockedComputeFileSha256,
  writeBookCover: mockedWriteBookCover,
  canRenderEmbeddedImage: mockedCanRenderEmbeddedImage,
  canRenderBookCoverPath: mockedCanRenderBookCoverPath,
}));

vi.mock("./epub", () => ({
  parseEpubArchive: mockedParseEpubArchive,
}));

vi.mock("./pdf", () => ({
  extractPdfBookData: mockedExtractPdfBookData,
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
  mockedComputeFileSha256.mockClear();
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
    genres: ["Fantasy", "Adventure"],
    isbns: ["9780306406157"],
    cover: {
      mediaType: "image/jpeg",
      ext: "jpg",
      bytesBase64: "Zm9vYmFyYmF6cXV4cXV1eA==Zm9vYmFyYmF6cXV4cXV1eA==",
    },
    toc: [],
    spine: [],
  }));
  mockedExtractPdfBookData.mockClear();
  mockedExtractPdfBookData.mockImplementation(async (_assetPath: string, _bookId: string, fallbackTitle: string) => ({
    title: fallbackTitle,
    author: "PDF Author",
    description: "PDF Description",
    pageCount: 8,
    coverPath: "C:\\books\\pdf-cover.jpg",
    sectionsSummary: [{ id: "pdf-outline:1:1", label: "Intro", href: "page:1", depth: 0 }],
    sectionCount: 1,
    tocCount: 1,
    spineCount: 0,
    isbns: ["9780306406157"],
  }));
});

function makeBook(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    id: "book-1",
    title: "Example",
    author: null,
    description: null,
    genres: ["Fantasy"],
    metadataBackfillVersion: 2,
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

describe("BookAssetResolver.resolvePdfSourceUrl", () => {
  it("uses the canonical book protocol URL for reader loading", () => {
    const src = BookAssetResolver.resolvePdfSourceUrl(
      makeBook({
        subtype: "pdf",
        updatedAt: 99,
        assetPath: "C:\\books\\example.pdf",
      }),
    );

    expect(src).toBe("http://book.localhost/C%3A%5Cbooks%5Cexample.pdf?v=99");
  });
});

describe("BookAssetResolver.resolveEpubSourceUrl", () => {
  it("uses the canonical book protocol URL for epub reader loading", () => {
    const src = BookAssetResolver.resolveEpubSourceUrl(
      makeBook({
        subtype: "epub",
        updatedAt: 99,
        assetPath: "C:\\books\\example.epub",
      }),
    );

    expect(src).toBe("http://book.localhost/C%3A%5Cbooks%5Cexample.epub?v=99");
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

  it("requires migration for canonical EPUBs that still need metadata backfill", () => {
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
          genres: [],
          metadataBackfillVersion: undefined,
        }),
      ),
    ).toBe(true);
  });

  it("does not retry EPUB metadata backfill once metadata was scanned", () => {
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
          genres: [],
          metadataBackfillVersion: 2,
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

  it("requires migration for PDFs that still lack stored page metadata", () => {
    expect(
      needsCanonicalBookMigration(
        makeBook({
          subtype: "pdf",
          coverPath: null,
          coverUrl: undefined,
          toc: undefined,
          spine: undefined,
          sectionsSummary: [],
          sectionCount: 0,
          tocCount: 0,
          spineCount: 0,
          pageCount: undefined,
        }),
      ),
    ).toBe(true);
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

  it("persists pdf pageCount alongside canonical book data", () => {
    const persisted = toPersistedBookEntry(
      makeBook({
        subtype: "pdf",
        coverPath: "C:\\books\\cover.jpg",
        coverUrl: undefined,
        toc: undefined,
        spine: undefined,
        sectionsSummary: [],
        sectionCount: 0,
        tocCount: 0,
        spineCount: 0,
        pageCount: 22,
      }),
    );

    expect(persisted.pageCount).toBe(22);
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

  it("backfills EPUB genres without changing already canonical visual fields", async () => {
    const patch = await BookAssetResolver.ensureCanonicalBookEntry(
      makeBook({
        coverPath: "C:\\books\\cover.jpg",
        coverUrl: undefined,
        toc: undefined,
        spine: undefined,
        sectionsSummary: [{ id: "s1", label: "Chapter 1", href: "OPS/ch1.xhtml", depth: 0 }],
        sectionCount: 1,
        tocCount: 1,
        spineCount: 1,
        genres: [],
        metadataBackfillVersion: undefined,
      }),
    );

    expect(mockedReadFileAsArrayBuffer).toHaveBeenCalledWith("C:\\books\\example.epub");
    expect(mockedParseEpubArchive).toHaveBeenCalledOnce();
    expect(mockedWriteBookCover).not.toHaveBeenCalled();
    expect(patch).toEqual({
      genres: ["Fantasy", "Adventure"],
      isbns: ["9780306406157"],
      metadataBackfillVersion: 2,
    });
  });

  it("migrates a legacy local book into the canonical asset model in one pass", async () => {
    const patch = await BookAssetResolver.ensureCanonicalBookEntry(
      makeBook({
        assetFingerprint: undefined,
        genres: [],
        metadataBackfillVersion: undefined,
        coverPath: null,
        coverUrl: "data:image/jpeg;base64,Zm9vYmFyYmF6cXV4cXV1eA==Zm9vYmFyYmF6cXV4cXV1eA==",
      }),
    );

    expect(mockedReadFileAsArrayBuffer).toHaveBeenCalledWith("C:\\books\\example.epub");
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
      genres: ["Fantasy", "Adventure"],
      isbns: ["9780306406157"],
      metadataBackfillVersion: 2,
    });
    expect(mockedComputeFileSha256).toHaveBeenCalledWith("C:\\books\\example.epub");
    expect(patch?.assetFingerprint).toBe("native-file-hash");
    expect(patch?.sectionsSummary).toHaveLength(1);
  });

  it("backfills canonical pdf metadata, cover, pages, and outline", async () => {
    const patch = await BookAssetResolver.ensureCanonicalBookEntry(
      makeBook({
        subtype: "pdf",
        title: "Plain PDF",
        coverPath: null,
        coverUrl: undefined,
        toc: undefined,
        spine: undefined,
        sectionsSummary: [],
        sectionCount: 0,
        tocCount: 0,
        spineCount: 0,
        pageCount: undefined,
        assetPath: "C:\\books\\plain.pdf",
      }),
    );

    expect(mockedExtractPdfBookData).toHaveBeenCalledWith(
      "C:\\books\\plain.pdf",
      "book-1",
      "Plain PDF",
    );
    expect(patch).toMatchObject({
      author: "PDF Author",
      description: "PDF Description",
      coverPath: "C:\\books\\pdf-cover.jpg",
      pageCount: 8,
      sectionCount: 1,
      tocCount: 1,
      spineCount: 0,
    });
  });
});
