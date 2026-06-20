import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { inspectAethonBackupContainer } from "./aethonBackup";
import {
  buildAethonBooksBackupContainer,
  restoreAethonBooksPayload,
  type AethonBooksSnapshot,
} from "./booksBackup";

const sampleSnapshot: AethonBooksSnapshot = {
  books: [
    {
      id: "epub-alpha",
      assetFingerprint: "fingerprint-alpha",
      title: "Alpha",
      author: "Author A",
      description: "A portable EPUB",
      coverPath: "C:/books/covers/alpha.jpg",
      subtype: "epub",
      pageCount: null,
      createdAt: 100,
      updatedAt: 200,
      importPath: "C:/downloads/alpha.epub",
      assetPath: "C:/books/assets/alpha.epub",
      tocCount: 4,
      spineCount: 4,
      sectionsSummary: [{ id: "s-1", label: "Chapter 1", href: "chapter-1.xhtml", depth: 0 }],
      sectionCount: 1,
    },
  ],
  bookProgress: [
    {
      bookId: "epub-alpha",
      location: "epubcfi(/6/2[cover]!/4/2/2)",
      href: "chapter-1.xhtml",
      progressPercent: 0.42,
      lastReadAt: 500,
      sectionLabel: "Chapter 1",
      renderer: "epub",
      pageIndex: null,
      totalPages: null,
    },
  ],
  bookBookmarks: [
    {
      bookId: "epub-alpha",
      location: "epubcfi(/6/2[cover]!/4/2/2)",
      href: "chapter-1.xhtml",
      pageIndex: null,
      progressPercent: 0.42,
      label: "Resume",
      savedAt: 600,
    },
  ],
  booksCategories: [
    { id: "favorites", name: "Favorites", order: 1 },
  ],
  booksCategoryAssignments: {
    "epub-alpha": ["favorites"],
  },
  booksLibraryUi: {
    activeCategoryId: "favorites",
    typeFilter: "epub",
    statusFilter: "in_progress",
    search: "alpha",
    sortMode: "recentlyRead",
    sortDir: "asc",
  },
};

const SAMPLE_COVER_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="480" viewBox="0 0 320 480">
  <rect width="320" height="480" fill="#1a4f8b"/>
  <rect x="20" y="20" width="280" height="440" rx="20" fill="#7fd7ff"/>
  <text x="160" y="170" text-anchor="middle" font-family="Arial" font-size="34" fill="#08263d">AETHON</text>
  <text x="160" y="240" text-anchor="middle" font-family="Arial" font-size="24" fill="#0d3555">Books Restore</text>
  <text x="160" y="300" text-anchor="middle" font-family="Arial" font-size="20" fill="#0d3555">Phase 2B</text>
</svg>`;

async function buildSampleEpub(title = "Phase 2B EPUB"): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles>
        <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/>
      </rootfiles>
    </container>`,
  );
  zip.file(
    "OPS/chapter-1.xhtml",
    `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${title}</h1><p>Chapter one.</p></body></html>`,
  );
  zip.file(
    "OPS/chapter-2.xhtml",
    `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${title}</h1><p>Chapter two.</p></body></html>`,
  );
  zip.file(
    "OPS/nav.xhtml",
    `<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml">
      <body>
        <nav epub:type="toc" id="toc">
          <ol>
            <li><a href="chapter-1.xhtml">Chapter 1</a></li>
            <li><a href="chapter-2.xhtml">Chapter 2</a></li>
          </ol>
        </nav>
      </body>
    </html>`,
  );
  zip.file(
    "OPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
    <package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>${title}</dc:title>
        <dc:creator>Aethon Tester</dc:creator>
        <dc:description>Restored EPUB sample</dc:description>
      </metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>
        <item id="chapter-2" href="chapter-2.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine>
        <itemref idref="chapter-1"/>
        <itemref idref="chapter-2"/>
      </spine>
    </package>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

function buildSamplePdf(text = "Phase 2B PDF"): Uint8Array {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT\n/F1 18 Tf\n50 100 Td\n(${escaped}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new TextEncoder().encode(pdf);
}

async function createRoundTripFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aethon-books-roundtrip-"));
  const epubPath = path.join(root, "sample.epub");
  const pdfPath = path.join(root, "sample.pdf");
  const coverPath = path.join(root, "cover.svg");

  await fs.writeFile(epubPath, await buildSampleEpub());
  await fs.writeFile(pdfPath, buildSamplePdf());
  await fs.writeFile(coverPath, SAMPLE_COVER_SVG);

  const snapshot: AethonBooksSnapshot = {
    books: [
      {
        id: "audit-epub",
        assetFingerprint: "audit-epub-fingerprint",
        title: "Audit EPUB",
        author: "Audit Author",
        description: "Round-trip EPUB sample",
        coverPath,
        subtype: "epub",
        pageCount: null,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_100_000,
        importPath: epubPath,
        assetPath: epubPath,
        tocCount: 2,
        spineCount: 2,
        sectionsSummary: [
          { id: "audit-epub:s1", label: "Chapter 1", href: "chapter-1.xhtml", depth: 0 },
          { id: "audit-epub:s2", label: "Chapter 2", href: "chapter-2.xhtml", depth: 0 },
        ],
        sectionCount: 2,
      },
      {
        id: "audit-pdf",
        assetFingerprint: "audit-pdf-fingerprint",
        title: "Audit PDF",
        author: "Audit PDF Author",
        description: "Round-trip PDF sample",
        coverPath,
        subtype: "pdf",
        pageCount: 1,
        createdAt: 1_700_000_200_000,
        updatedAt: 1_700_000_300_000,
        importPath: pdfPath,
        assetPath: pdfPath,
        tocCount: 1,
        spineCount: 0,
        sectionsSummary: [
          { id: "audit-pdf:p1", label: "Page 1", href: "page:1", depth: 0 },
        ],
        sectionCount: 1,
      },
    ],
    bookProgress: [
      {
        bookId: "audit-epub",
        location: "epubcfi(/6/2!/4/2/2)",
        href: "chapter-2.xhtml",
        progressPercent: 0.66,
        lastReadAt: 1_700_000_500_000,
        sectionLabel: "Chapter 2",
        renderer: "epub",
        pageIndex: null,
        totalPages: null,
      },
      {
        bookId: "audit-pdf",
        location: null,
        href: null,
        progressPercent: 1,
        lastReadAt: 1_700_000_600_000,
        sectionLabel: "Page 1",
        renderer: "pdf",
        pageIndex: 1,
        totalPages: 1,
      },
    ],
    bookBookmarks: [
      {
        bookId: "audit-epub",
        location: "epubcfi(/6/2!/4/2/2)",
        href: "chapter-2.xhtml",
        pageIndex: null,
        progressPercent: 0.66,
        label: "Resume EPUB",
        savedAt: 1_700_000_700_000,
      },
      {
        bookId: "audit-pdf",
        location: null,
        href: null,
        pageIndex: 1,
        progressPercent: 1,
        label: "Resume PDF",
        savedAt: 1_700_000_800_000,
      },
    ],
    booksCategories: [
      { id: "favorites", name: "Favorites", order: 1 },
    ],
    booksCategoryAssignments: {
      "audit-epub": ["favorites"],
      "audit-pdf": ["favorites"],
    },
  };

  return {
    root,
    epubPath,
    pdfPath,
    coverPath,
    snapshot,
  };
}

describe("books backup payload", () => {
  it("builds a full books .aethonbk container with portable files and manifests", async () => {
    const readBinaryFile = vi.fn(async (path: string) => {
      if (path.endsWith(".epub")) return new TextEncoder().encode("EPUB-BYTES").buffer;
      if (path.endsWith(".jpg")) return new TextEncoder().encode("JPEG-BYTES").buffer;
      throw new Error(`Unexpected path ${path}`);
    });

    const built = await buildAethonBooksBackupContainer(
      sampleSnapshot,
      { exportMode: "full", appVersion: "0.0.1", platform: "windows", sourceProfileId: "main" },
      {
        readBinaryFile,
        writeManagedBookAsset: vi.fn(),
        writeManagedBookCover: vi.fn(),
      },
    );

    expect(readBinaryFile).toHaveBeenCalledTimes(2);
    expect(built.manifest.payloads).toHaveLength(1);
    expect(built.manifest.payloads[0]).toEqual(
      expect.objectContaining({
        kind: "books",
        exportMode: "full",
        requiresRuntime: "books",
        portableByDefault: true,
        restoreModesSupported: ["full", "metadata-only"],
      }),
    );

    const inspected = await inspectAethonBackupContainer(built.bytes);
    expect(inspected.hasErrors).toBe(false);
    expect(inspected.payloadManifests.books).toEqual(
      expect.objectContaining({
        exportMode: "full",
        requiresRuntime: "books",
        portableByDefault: true,
      }),
    );

    const zip = await JSZip.loadAsync(built.bytes);
    expect(await zip.file("payloads/books/library.json")?.async("text")).toContain("\"title\": \"Alpha\"");
    expect(await zip.file("payloads/books/files/epub-alpha.epub")?.async("text")).toBe("EPUB-BYTES");
    expect(await zip.file("payloads/books/covers/epub-alpha.jpg")?.async("text")).toBe("JPEG-BYTES");
  });

  it("restores a full books payload into managed storage paths", async () => {
    const built = await buildAethonBooksBackupContainer(
      sampleSnapshot,
      { exportMode: "full" },
      {
        readBinaryFile: vi.fn(async (path: string) =>
          new TextEncoder().encode(path.endsWith(".epub") ? "EPUB-BYTES" : "JPEG-BYTES").buffer),
        writeManagedBookAsset: vi.fn(),
        writeManagedBookCover: vi.fn(),
      },
    );

    const writeManagedBookAsset = vi.fn(async (bookId: string, _base64: string, ext: string) =>
      `C:/managed/books/${bookId}.${ext}`);
    const writeManagedBookCover = vi.fn(async (bookId: string, _base64: string, ext: string) =>
      `C:/managed/books/covers/${bookId}.${ext}`);

    const restored = await restoreAethonBooksPayload(built.bytes, {
      readBinaryFile: vi.fn(),
      writeManagedBookAsset,
      writeManagedBookCover,
    });

    expect(restored.exportMode).toBe("full");
    expect(restored.issues).toEqual([]);
    expect(restored.books[0]).toEqual(
      expect.objectContaining({
        id: "epub-alpha",
        assetPath: "C:/managed/books/epub-alpha.epub",
        importPath: "C:/managed/books/epub-alpha.epub",
        coverPath: "C:/managed/books/covers/epub-alpha.jpg",
      }),
    );
    expect(restored.bookProgress[0]?.bookId).toBe("epub-alpha");
    expect(restored.bookBookmarks[0]?.bookId).toBe("epub-alpha");
    expect(restored.booksCategoryAssignments["epub-alpha"]).toEqual(["favorites"]);
    expect(restored.booksLibraryUi).toEqual(sampleSnapshot.booksLibraryUi);
    expect(writeManagedBookAsset).toHaveBeenCalledTimes(1);
    expect(writeManagedBookCover).toHaveBeenCalledTimes(1);
  });

  it("restores metadata-only books payload with explicit issues instead of pretending files exist", async () => {
    const built = await buildAethonBooksBackupContainer(
      sampleSnapshot,
      { exportMode: "metadata-only" },
      {
        readBinaryFile: vi.fn(),
        writeManagedBookAsset: vi.fn(),
        writeManagedBookCover: vi.fn(),
      },
    );

    const restored = await restoreAethonBooksPayload(built.bytes, {
      readBinaryFile: vi.fn(),
      writeManagedBookAsset: vi.fn(),
      writeManagedBookCover: vi.fn(),
    });

    expect(restored.exportMode).toBe("metadata-only");
    expect(restored.books[0]).toEqual(
      expect.objectContaining({
        assetPath: "",
        importPath: "",
        coverPath: null,
      }),
    );
    expect(restored.issues).toContainEqual(
      expect.objectContaining({
        code: "metadata-only-book",
        bookId: "epub-alpha",
      }),
    );
  });

  it("round-trips real EPUB and PDF assets and can emit audit artifacts", async () => {
    const fixture = await createRoundTripFixture();
    const readBinaryFile = async (filePath: string) => {
      const bytes = await fs.readFile(filePath);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    };
    const full = await buildAethonBooksBackupContainer(
      fixture.snapshot,
      { exportMode: "full", appVersion: "0.6.8", platform: "windows", sourceProfileId: "main" },
      { readBinaryFile },
    );
    const metadataOnly = await buildAethonBooksBackupContainer(
      fixture.snapshot,
      { exportMode: "metadata-only", appVersion: "0.6.8", platform: "windows", sourceProfileId: "main" },
      { readBinaryFile },
    );

    const managedRoot = path.join(fixture.root, "managed");
    const restored = await restoreAethonBooksPayload(full.bytes, {
      writeManagedBookAsset: vi.fn(async (bookId: string, base64: string, ext: string) => {
        const dest = path.join(managedRoot, `${bookId}.${ext}`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, Buffer.from(base64, "base64"));
        return dest;
      }),
      writeManagedBookCover: vi.fn(async (bookId: string, base64: string, ext: string) => {
        const dest = path.join(managedRoot, "covers", `${bookId}.${ext}`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, Buffer.from(base64, "base64"));
        return dest;
      }),
    });

    expect(restored.issues).toEqual([]);
    expect(restored.books.map((book) => book.id).sort()).toEqual(["audit-epub", "audit-pdf"]);
    expect(restored.books.find((book) => book.id === "audit-epub")?.assetPath).not.toBe(fixture.epubPath);
    expect(restored.books.find((book) => book.id === "audit-pdf")?.assetPath).not.toBe(fixture.pdfPath);
    expect(await fs.readFile(restored.books[0].assetPath)).toBeTruthy();
    expect(await fs.readFile(restored.books[1].assetPath)).toBeTruthy();
    expect(restored.bookProgress.map((entry) => entry.bookId).sort()).toEqual(["audit-epub", "audit-pdf"]);
    expect(restored.bookBookmarks.map((entry) => entry.bookId).sort()).toEqual(["audit-epub", "audit-pdf"]);

    const outputDir = process.env.AETHON_BOOKS_PHASE2B_OUTPUT_DIR?.trim();
    if (outputDir) {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, "books-roundtrip-full.aethonbk"), Buffer.from(full.bytes));
      await fs.writeFile(path.join(outputDir, "books-roundtrip-metadata-only.aethonbk"), Buffer.from(metadataOnly.bytes));
      await fs.writeFile(path.join(outputDir, "books-roundtrip-source-epub.epub"), Buffer.from(await fs.readFile(fixture.epubPath)));
      await fs.writeFile(path.join(outputDir, "books-roundtrip-source-pdf.pdf"), Buffer.from(await fs.readFile(fixture.pdfPath)));
    }
  });
});
