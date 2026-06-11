import { filePathAsStableUrl, writeBookCover } from "./storage";
import type { BookSectionSummaryItem } from "./types";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

const PDF_COVER_WIDTH = 360;
const PDF_COVER_QUALITY = 0.88;

export type PdfDocumentInit = {
  url: string;
  disableWorker: boolean;
  disableRange: boolean;
  disableStream: boolean;
  disableAutoFetch: boolean;
  httpHeaders?: Record<string, string>;
};

type PdfJsLike = {
  GlobalWorkerOptions?: {
    workerSrc?: string;
  };
};

type OutlineItem = {
  title?: string | null;
  dest?: unknown;
  items?: OutlineItem[];
};

type PdfImportDeps = {
  loadPdfDocument: (sourceUrl: string) => Promise<any>;
  renderPdfCoverBase64: (documentRef: any) => Promise<string | null>;
  resolveAssetUrl: (assetPath: string) => string;
  writeBookCover: typeof writeBookCover;
};

export type ImportedPdfBookData = {
  title: string;
  author: string | null;
  description: string | null;
  pageCount: number;
  coverPath: string | null;
  sectionsSummary: BookSectionSummaryItem[];
  sectionCount: number;
  tocCount: number;
  spineCount: number;
};

const defaultDeps: PdfImportDeps = {
  async loadPdfDocument(sourceUrl: string) {
    const pdfjsLib = await import("pdfjs-dist");
    configurePdfJsWorker(pdfjsLib);
    return pdfjsLib.getDocument(createPdfDocumentInit(sourceUrl)).promise;
  },
  async renderPdfCoverBase64(documentRef: any) {
    if (typeof document === "undefined") return null;

    const page = await documentRef.getPage(1);
    const firstViewport = page.getViewport({ scale: 1 });
    const scale = firstViewport.width > 0 ? PDF_COVER_WIDTH / firstViewport.width : 1;
    const viewport = page.getViewport({ scale: Math.max(0.1, scale) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    await page.render({
      canvasContext: ctx,
      viewport,
    }).promise;

    const dataUrl = canvas.toDataURL("image/jpeg", PDF_COVER_QUALITY);
    const prefix = "data:image/jpeg;base64,";
    if (!dataUrl.startsWith(prefix)) return null;
    return dataUrl.slice(prefix.length);
  },
  resolveAssetUrl(assetPath: string) {
    return filePathAsStableUrl(assetPath, "book");
  },
  writeBookCover,
};

export function createPdfDocumentInit(sourceUrl: string, authHeader?: string | null): PdfDocumentInit {
  const init: PdfDocumentInit = {
    url: sourceUrl,
    disableWorker: true,
    disableRange: false,
    disableStream: false,
    disableAutoFetch: false,
  };

  if (authHeader) {
    init.httpHeaders = {
      Authorization: authHeader,
    };
  }

  return init;
}

export function configurePdfJsWorker(pdfjsLib: PdfJsLike): void {
  if (!pdfjsLib.GlobalWorkerOptions) return;
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
  }
}

function readOptionalText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = readOptionalText(entry);
      if (normalized) return normalized;
    }
  }

  if (value && typeof value === "object") {
    const languageValues = Object.values(value as Record<string, unknown>);
    for (const entry of languageValues) {
      const normalized = readOptionalText(entry);
      if (normalized) return normalized;
    }
  }

  return null;
}

function readMetadataValue(metadata: any, key: string): string | null {
  try {
    return readOptionalText(metadata?.get?.(key));
  } catch {
    return null;
  }
}

function prettifyPdfOutlineLabel(label: unknown, pageNumber: number) {
  return readOptionalText(label) ?? `Page ${pageNumber}`;
}

export function createPdfPageHref(pageNumber: number): string {
  return `page:${pageNumber}`;
}

export function parsePdfPageHref(href: string | null | undefined): number | null {
  if (typeof href !== "string") return null;
  const match = href.match(/^page:(\d+)$/i);
  if (!match) return null;
  const pageNumber = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

export function resolvePdfSectionLabel(
  sectionsSummary: BookSectionSummaryItem[] | null | undefined,
  pageNumber: number,
): string {
  if (!Array.isArray(sectionsSummary) || !sectionsSummary.length) {
    return `Page ${pageNumber}`;
  }

  let bestMatch: BookSectionSummaryItem | null = null;
  let bestPage = 0;
  for (const item of sectionsSummary) {
    const sectionPage = parsePdfPageHref(item.href);
    if (!sectionPage || sectionPage > pageNumber) continue;
    if (!bestMatch || sectionPage >= bestPage) {
      bestMatch = item;
      bestPage = sectionPage;
    }
  }

  return bestMatch?.label ?? `Page ${pageNumber}`;
}

async function resolveOutlineDestinationPage(
  documentRef: any,
  destination: unknown,
): Promise<number | null> {
  let explicitDestination = destination;

  if (typeof destination === "string") {
    explicitDestination = await documentRef.getDestination(destination);
  }

  if (!Array.isArray(explicitDestination) || !explicitDestination.length) {
    return null;
  }

  const target = explicitDestination[0];

  if (typeof target === "number" && Number.isFinite(target)) {
    return target + 1;
  }

  if (!target) return null;

  try {
    const pageIndex = await documentRef.getPageIndex(target);
    if (typeof pageIndex === "number" && Number.isFinite(pageIndex) && pageIndex >= 0) {
      return pageIndex + 1;
    }
  } catch {}

  return null;
}

async function flattenOutline(
  documentRef: any,
  items: OutlineItem[],
  depth = 0,
  sections: BookSectionSummaryItem[] = [],
  seen = new Set<string>(),
): Promise<BookSectionSummaryItem[]> {
  for (const item of items) {
    const pageNumber = await resolveOutlineDestinationPage(documentRef, item.dest).catch(() => null);
    if (pageNumber) {
      const label = prettifyPdfOutlineLabel(item.title, pageNumber);
      const key = `${pageNumber}:${label.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        sections.push({
          id: `pdf-outline:${sections.length + 1}:${pageNumber}`,
          label,
          href: createPdfPageHref(pageNumber),
          depth,
        });
      }
    }

    if (Array.isArray(item.items) && item.items.length) {
      await flattenOutline(documentRef, item.items, depth + 1, sections, seen);
    }
  }

  return sections.sort((left, right) => {
    const leftPage = parsePdfPageHref(left.href) ?? 0;
    const rightPage = parsePdfPageHref(right.href) ?? 0;
    if (leftPage !== rightPage) return leftPage - rightPage;
    return left.depth - right.depth;
  });
}

export async function extractPdfBookData(
  assetPath: string,
  bookId: string,
  fallbackTitle: string,
  deps: PdfImportDeps = defaultDeps,
): Promise<ImportedPdfBookData> {
  const sourceUrl = deps.resolveAssetUrl(assetPath);
  const documentRef = await deps.loadPdfDocument(sourceUrl);

  try {
    const [metadataResult, outlineItems, coverBytesBase64] = await Promise.all([
      documentRef.getMetadata().catch(() => null),
      documentRef.getOutline().catch(() => null),
      deps.renderPdfCoverBase64(documentRef).catch(() => null),
    ]);

    const info = metadataResult?.info ?? {};
    const metadata = metadataResult?.metadata;
    const sectionsSummary = await flattenOutline(documentRef, Array.isArray(outlineItems) ? outlineItems : []);

    let coverPath: string | null = null;
    if (coverBytesBase64) {
      try {
        coverPath = await deps.writeBookCover(bookId, coverBytesBase64, "jpg");
      } catch {
        coverPath = null;
      }
    }

    return {
      title:
        readOptionalText(info?.Title)
        ?? readMetadataValue(metadata, "dc:title")
        ?? fallbackTitle,
      author:
        readOptionalText(info?.Author)
        ?? readMetadataValue(metadata, "dc:creator"),
      description:
        readOptionalText(info?.Subject)
        ?? readMetadataValue(metadata, "dc:description"),
      pageCount: Math.max(1, Number(documentRef.numPages) || 1),
      coverPath,
      sectionsSummary,
      sectionCount: sectionsSummary.length,
      tocCount: sectionsSummary.length,
      spineCount: 0,
    };
  } finally {
    try {
      await documentRef.destroy?.();
    } catch {}
  }
}
