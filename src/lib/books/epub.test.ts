import { describe, expect, it } from "vitest";
import { parseEpubArchive } from "./epub";

async function buildEpub(options?: {
  title?: string;
  author?: string | null;
  description?: string | null;
  withCover?: boolean;
  withNav?: boolean;
  chapterCount?: number;
}) {
  const { default: JSZip } = await import("jszip");
  const {
    title = "Sample Book",
    author = "Sample Author",
    description = "Sample description",
    withCover = true,
    withNav = true,
    chapterCount = 2,
  } = options ?? {};

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
      <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles>
          <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/>
        </rootfiles>
      </container>`,
  );

  const chapterIds = Array.from({ length: chapterCount }, (_, index) => `chapter-${index + 1}`);
  for (const [index, chapterId] of chapterIds.entries()) {
    zip.file(
      `OPS/${chapterId}.xhtml`,
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${index + 1}</h1><p>Chapter ${index + 1}</p></body></html>`,
    );
  }
  if (withNav) {
    const navItems = chapterIds
      .map((chapterId, index) => `<li><a href="${chapterId}.xhtml">Chapter ${index + 1}</a></li>`)
      .join("");
    zip.file(
      "OPS/nav.xhtml",
      `<?xml version="1.0"?>
      <html xmlns="http://www.w3.org/1999/xhtml">
        <body>
          <nav epub:type="toc" id="toc">
            <ol>
              ${navItems}
            </ol>
          </nav>
        </body>
      </html>`,
    );
  }

  if (withCover) {
    zip.file("OPS/cover.jpg", Uint8Array.from([255, 216, 255, 217]));
  }

  zip.file(
    "OPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
      <package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>${title}</dc:title>
          ${author ? `<dc:creator>${author}</dc:creator>` : ""}
          ${description ? `<dc:description>${description}</dc:description>` : ""}
          ${withCover ? `<meta name="cover" content="cover-image"/>` : ""}
        </metadata>
        <manifest>
          ${withNav ? `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` : ""}
          ${chapterIds
            .map((chapterId) => `<item id="${chapterId}" href="${chapterId}.xhtml" media-type="application/xhtml+xml"/>`)
            .join("\n")}
          ${withCover ? `<item id="cover-image" href="cover.jpg" media-type="image/jpeg"/>` : ""}
        </manifest>
        <spine>
          ${chapterIds.map((chapterId) => `<itemref idref="${chapterId}"/>`).join("\n")}
        </spine>
      </package>`,
  );

  return zip.generateAsync({ type: "arraybuffer" });
}

describe("parseEpubArchive", () => {
  it("extracts metadata, cover, and toc from a normal epub", async () => {
    const buffer = await buildEpub();
    const parsed = await parseEpubArchive(buffer, "Fallback");

    expect(parsed.title).toBe("Sample Book");
    expect(parsed.author).toBe("Sample Author");
    expect(parsed.description).toBe("Sample description");
    expect(parsed.cover?.ext).toBe("jpg");
    expect(parsed.toc.map(item => item.label)).toEqual(["Chapter 1", "Chapter 2"]);
    expect(parsed.spine).toHaveLength(2);
  });

  it("falls back cleanly when metadata is missing", async () => {
    const buffer = await buildEpub({
      title: "",
      author: null,
      description: null,
      withCover: false,
      withNav: false,
    });
    const parsed = await parseEpubArchive(buffer, "Fallback Title");

    expect(parsed.title).toBe("Fallback Title");
    expect(parsed.author).toBeNull();
    expect(parsed.description).toBeNull();
    expect(parsed.cover).toBeNull();
    expect(parsed.toc).toHaveLength(2);
    expect(parsed.toc[0]?.label).toContain("chapter-1.xhtml");
  });

  it("keeps the full spine when TOC metadata is missing", async () => {
    const buffer = await buildEpub({
      withNav: false,
      chapterCount: 80,
    });
    const parsed = await parseEpubArchive(buffer, "Fallback Title");

    expect(parsed.spine).toHaveLength(80);
    expect(parsed.toc).toHaveLength(80);
    expect(parsed.toc.at(-1)?.label).toContain("chapter-80.xhtml");
  });

  it("fails cleanly on malformed epub files", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("OPS/content.opf", "<package/>");
    const buffer = await zip.generateAsync({ type: "arraybuffer" });

    await expect(parseEpubArchive(buffer, "Broken")).rejects.toThrow(/container\.xml/i);
  });
});
