export interface ReflowedPage {
  pageNumber: number;
  elements: ReflowedElement[];
}

export type ReflowedElement =
  | { type: "paragraph"; text: string }
  | { type: "image"; objectId: string; width: number; height: number }
  | { type: "heading"; text: string; level: number };

export interface PdfTextItemLike {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  fontName?: string;
  hasEOL?: boolean;
}

export interface PdfViewportLike {
  width: number;
  height: number;
}

export interface PdfOperatorListLike {
  fnArray: number[];
  argsArray: unknown[][];
}

export interface PdfImageCandidate {
  objectId: string;
  width: number;
  height: number;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  operatorIndex?: number;
}

export interface PdfReflowOptions {
  repeatedMarkers?: Set<string> | string[];
  headerFooterBandRatio?: number;
  removeDecorativeBackgrounds?: boolean;
}

type NormalizedTextItem = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
};

type TextLine = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
};

type PdfOperatorIds = {
  save?: number;
  restore?: number;
  transform?: number;
  paintImageXObject?: number;
  paintInlineImageXObject?: number;
  paintImageXObjectRepeat?: number;
  paintImageMaskXObject?: number;
  paintImageMaskXObjectRepeat?: number;
  paintJpegXObject?: number;
};

const DEFAULT_HEADER_FOOTER_BAND_RATIO = 0.09;
const MIN_IMAGE_EDGE = 40;
const MAX_BACKGROUND_AREA_RATIO = 0.9;
const MIN_ILLUSTRATION_AREA_RATIO = 0.15;
const MAX_ILLUSTRATION_AREA_RATIO = 0.85;

type TransformMatrix = [number, number, number, number, number, number];

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeMarker(value: string): string {
  return normalizeText(value).toLowerCase();
}

function median(values: number[], fallback: number): number {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return fallback;
  return sorted[Math.floor(sorted.length / 2)] ?? fallback;
}

function getFontSize(item: PdfTextItemLike): number {
  const transform = item.transform ?? [];
  const verticalScale = Math.hypot(Number(transform[2] ?? 0), Number(transform[3] ?? 0));
  const directHeight = Number(item.height ?? 0);
  return Math.max(1, directHeight || verticalScale || 12);
}

function toPositionedTextItems(items: PdfTextItemLike[]): NormalizedTextItem[] {
  return items
    .map((item) => {
      const text = normalizeText(item.str);
      const transform = item.transform ?? [];
      const fontSize = getFontSize(item);
      const x = Number(transform[4] ?? 0);
      const y = Number(transform[5] ?? 0);
      return {
        text,
        x,
        y,
        width: Math.max(1, Number(item.width ?? text.length * fontSize * 0.5)),
        height: Math.max(1, Number(item.height ?? fontSize)),
        fontSize,
      };
    })
    .filter((item) => item.text.length > 0 && Number.isFinite(item.x) && Number.isFinite(item.y))
    .sort((left, right) => right.y - left.y || left.x - right.x);
}

function mergeRunText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  if (left.endsWith("-")) return `${left.slice(0, -1)}${right}`;
  if (/[\s([{/"']$/.test(left) || /^[,.;:!?%)\]}]/.test(right)) return `${left}${right}`;
  return `${left} ${right}`;
}

export function clusterPdfTextLines(items: PdfTextItemLike[]): TextLine[] {
  const positioned = toPositionedTextItems(items);
  const lines: TextLine[] = [];

  for (const item of positioned) {
    const line = lines.find((candidate) => (
      Math.abs(candidate.y - item.y) <= Math.max(candidate.fontSize, item.fontSize) * 0.45
    ));

    if (!line) {
      lines.push({ ...item });
      continue;
    }

    const right = Math.max(line.x + line.width, item.x + item.width);
    const bottom = Math.min(line.y - line.height, item.y - item.height);
    line.text = mergeRunText(line.text, item.text);
    line.x = Math.min(line.x, item.x);
    line.y = Math.max(line.y, item.y);
    line.width = right - line.x;
    line.height = Math.max(line.height, line.y - bottom);
    line.fontSize = Math.max(line.fontSize, item.fontSize);
  }

  return lines
    .map((line) => ({ ...line, text: normalizeText(line.text) }))
    .filter((line) => line.text.length > 0)
    .sort((left, right) => right.y - left.y || left.x - right.x);
}

function isHeaderFooterLine(
  line: TextLine,
  viewport: PdfViewportLike,
  repeatedMarkers: Set<string>,
  bandRatio: number,
): boolean {
  const topBand = viewport.height * (1 - bandRatio);
  const bottomBand = viewport.height * bandRatio;
  const inOuterBand = line.y >= topBand || line.y <= bottomBand;
  if (!inOuterBand) return false;

  const marker = normalizeMarker(line.text);
  if (/^(?:page\s*)?\d+(?:\s*[-/]\s*\d+)?$/i.test(line.text)) return true;
  if (repeatedMarkers.has(marker)) return true;
  if (line.y >= topBand && line.x >= viewport.width * 0.45 && line.text.length <= 40) return true;
  return line.text.length <= 4 && !/[a-z]{3,}/i.test(line.text);
}

function isLikelyHeading(line: TextLine, bodyFontSize: number): boolean {
  if (line.text.length > 96) return false;
  if (line.fontSize >= bodyFontSize * 1.35) return true;
  return line.fontSize >= bodyFontSize * 1.15 && /^[A-Z0-9 .:'"-]+$/.test(line.text) && /[A-Z]/.test(line.text);
}

function createHeading(line: TextLine, bodyFontSize: number): ReflowedElement {
  return {
    type: "heading",
    text: line.text,
    level: line.fontSize >= bodyFontSize * 1.65 ? 1 : 2,
  };
}

export function assemblePdfTextElements(
  items: PdfTextItemLike[],
  viewport: PdfViewportLike,
  options: PdfReflowOptions = {},
): ReflowedElement[] {
  const repeatedMarkers = new Set(
    Array.from(options.repeatedMarkers ?? []).map((marker) => normalizeMarker(marker)),
  );
  const bandRatio = options.headerFooterBandRatio ?? DEFAULT_HEADER_FOOTER_BAND_RATIO;
  const lines = clusterPdfTextLines(items)
    .filter((line) => !isHeaderFooterLine(line, viewport, repeatedMarkers, bandRatio));
  const bodyFontSize = median(lines.map((line) => line.fontSize), 12);
  const elements: ReflowedElement[] = [];
  let paragraphLines: TextLine[] = [];

  function flushParagraph() {
    if (!paragraphLines.length) return;
    const text = paragraphLines.reduce((current, line) => mergeRunText(current, line.text), "");
    if (text) elements.push({ type: "paragraph", text });
    paragraphLines = [];
  }

  for (const line of lines) {
    if (isLikelyHeading(line, bodyFontSize)) {
      flushParagraph();
      elements.push(createHeading(line, bodyFontSize));
      continue;
    }

    const previous = paragraphLines[paragraphLines.length - 1];
    if (previous) {
      const gap = previous.y - line.y;
      const expectedLineHeight = Math.max(previous.fontSize, line.fontSize) * 2;
      if (gap > expectedLineHeight) {
        flushParagraph();
      }
    }
    paragraphLines.push(line);
  }
  flushParagraph();

  return elements;
}

export function classifyPdfImage(
  image: PdfImageCandidate,
  viewport: PdfViewportLike,
): "background" | "decorative" | "illustration" | "ignored" {
  if (image.width < MIN_IMAGE_EDGE || image.height < MIN_IMAGE_EDGE) return "decorative";
  const pageArea = Math.max(1, viewport.width * viewport.height);
  const ratio = (image.width * image.height) / pageArea;
  if (ratio > MAX_BACKGROUND_AREA_RATIO) return "background";
  if (ratio >= MIN_ILLUSTRATION_AREA_RATIO && ratio <= MAX_ILLUSTRATION_AREA_RATIO) {
    return "illustration";
  }
  return "ignored";
}

export function shouldRetainImageWithText(
  image: PdfImageCandidate,
  viewport: PdfViewportLike,
  textElementCount: number,
  removeDecorativeBackgrounds = true,
): boolean {
  const pageArea = Math.max(1, viewport.width * viewport.height);
  const ratio = (image.width * image.height) / pageArea;
  const spansMostWidth = image.width >= viewport.width * 0.85;
  const spansMostHeight = image.height >= viewport.height * 0.85;
  const partialPageWash = (
    ratio >= 0.45
    && ratio <= 0.78
    && ((spansMostWidth && image.height <= viewport.height * 0.72)
      || (spansMostHeight && image.width <= viewport.width * 0.75))
  );
  if (removeDecorativeBackgrounds && partialPageWash) return false;
  if (textElementCount <= 0) return true;
  if (removeDecorativeBackgrounds && ratio >= 0.45 && spansMostWidth) return false;
  if (textElementCount < 8) return true;
  return !(ratio >= 0.5 && spansMostWidth);
}

function readImageDataDimensions(value: unknown): { width: number; height: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const width = Number(record.width);
  const height = Number(record.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }
  const bitmap = record.bitmap as Record<string, unknown> | undefined;
  const bitmapWidth = Number(bitmap?.width);
  const bitmapHeight = Number(bitmap?.height);
  if (Number.isFinite(bitmapWidth) && Number.isFinite(bitmapHeight) && bitmapWidth > 0 && bitmapHeight > 0) {
    return { width: bitmapWidth, height: bitmapHeight };
  }
  return null;
}

function multiplyTransform(left: TransformMatrix, right: TransformMatrix): TransformMatrix {
  const [a, b, c, d, e, f] = left;
  const [g, h, i, j, k, l] = right;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}

function readTransformMatrix(value: unknown): TransformMatrix | null {
  if (!Array.isArray(value) || value.length < 6) return null;
  const matrix = value.slice(0, 6).map(Number);
  if (matrix.every((entry) => Number.isFinite(entry))) return matrix as TransformMatrix;
  return null;
}

function getImageDisplaySize(transform: TransformMatrix, fallbackWidth: number, fallbackHeight: number): {
  width: number;
  height: number;
} {
  const width = Math.hypot(transform[0], transform[1]);
  const height = Math.hypot(transform[2], transform[3]);
  return {
    width: Number.isFinite(width) && width > 0 ? width : fallbackWidth,
    height: Number.isFinite(height) && height > 0 ? height : fallbackHeight,
  };
}

export function collectPdfImageCandidates(
  operatorList: PdfOperatorListLike,
  viewport: PdfViewportLike,
  ops: PdfOperatorIds = {},
): PdfImageCandidate[] {
  const imageOps = new Set([
    ops.paintImageXObject,
    ops.paintImageXObjectRepeat,
    ops.paintJpegXObject,
  ].filter((op): op is number => typeof op === "number"));
  const inlineImageOps = new Set([
    ops.paintInlineImageXObject,
  ].filter((op): op is number => typeof op === "number"));
  const maskOps = new Set([
    ops.paintImageMaskXObject,
    ops.paintImageMaskXObjectRepeat,
  ].filter((op): op is number => typeof op === "number"));
  const candidates: PdfImageCandidate[] = [];
  const transformStack: TransformMatrix[] = [];
  let currentTransform: TransformMatrix = [1, 0, 0, 1, 0, 0];

  operatorList.fnArray.forEach((fn, index) => {
    if (fn === ops.save) {
      transformStack.push([...currentTransform] as TransformMatrix);
      return;
    }
    if (fn === ops.restore) {
      currentTransform = transformStack.pop() ?? [1, 0, 0, 1, 0, 0];
      return;
    }
    if (fn === ops.transform) {
      const matrix = readTransformMatrix(operatorList.argsArray[index]);
      if (matrix) currentTransform = multiplyTransform(currentTransform, matrix);
      return;
    }

    if (maskOps.has(fn)) return;
    const args = operatorList.argsArray[index] ?? [];
    const firstArg = args[0];

    if (imageOps.has(fn) && typeof firstArg === "string") {
      const intrinsicWidth = Number(args[1]);
      const intrinsicHeight = Number(args[2]);
      const fallbackWidth = Number.isFinite(intrinsicWidth) && intrinsicWidth > 0 ? intrinsicWidth : viewport.width * 0.5;
      const fallbackHeight = Number.isFinite(intrinsicHeight) && intrinsicHeight > 0 ? intrinsicHeight : viewport.height * 0.5;
      const displaySize = getImageDisplaySize(currentTransform, fallbackWidth, fallbackHeight);
      candidates.push({
        objectId: firstArg,
        width: displaySize.width,
        height: displaySize.height,
        intrinsicWidth: fallbackWidth,
        intrinsicHeight: fallbackHeight,
        operatorIndex: index,
      });
      return;
    }

    if (inlineImageOps.has(fn)) {
      const dimensions = readImageDataDimensions(firstArg);
      if (!dimensions) return;
      const displaySize = getImageDisplaySize(currentTransform, dimensions.width, dimensions.height);
      candidates.push({
        objectId: `inline:${index}`,
        width: displaySize.width,
        height: displaySize.height,
        intrinsicWidth: dimensions.width,
        intrinsicHeight: dimensions.height,
        operatorIndex: index,
      });
    }
  });

  return candidates.filter((candidate) => {
    const classification = classifyPdfImage(candidate, viewport);
    return classification === "illustration" || classification === "background";
  });
}

function getOps(pdfjsLib: unknown): PdfOperatorIds {
  const ops = (pdfjsLib as { OPS?: PdfOperatorIds } | null)?.OPS;
  return ops ?? {};
}

function resolvePdfObject(page: any, objectId: string): Promise<unknown> {
  if (!page?.objs || objectId.startsWith("inline:")) return Promise.resolve(null);
  if (page.objs.has?.(objectId)) {
    try {
      return Promise.resolve(page.objs.get(objectId));
    } catch {}
  }
  return new Promise((resolve) => {
    try {
      page.objs.get(objectId, resolve);
    } catch {
      resolve(null);
    }
  });
}

export async function extractReflowedPage(
  page: any,
  pageNumber: number,
  pdfjsLib?: unknown,
  options: PdfReflowOptions = {},
): Promise<ReflowedPage> {
  const viewport = page.getViewport({ scale: 1 });
  const [textContent, operatorList] = await Promise.all([
    page.getTextContent(),
    page.getOperatorList().catch(() => ({ fnArray: [], argsArray: [] })),
  ]);
  const textElements = assemblePdfTextElements(textContent.items ?? [], viewport, options);
  const imageCandidates = collectPdfImageCandidates(operatorList, viewport, getOps(pdfjsLib));
  const contentImages = imageCandidates.filter((candidate) => (
    shouldRetainImageWithText(
      candidate,
      viewport,
      textElements.length,
      options.removeDecorativeBackgrounds ?? true,
    )
  ));
  const images = await Promise.all(contentImages.map(async (candidate) => {
    const data = await resolvePdfObject(page, candidate.objectId);
    const dimensions = readImageDataDimensions(data) ?? candidate;
    return {
      type: "image" as const,
      objectId: candidate.objectId,
      width: candidate.width,
      height: candidate.height,
      intrinsicWidth: dimensions.width,
      intrinsicHeight: dimensions.height,
    };
  }));

  return {
    pageNumber,
    elements: [
      ...textElements,
      ...images,
    ],
  };
}

export function getReflowElementKey(pageNumber: number, elementIndex = 0): string {
  return `pdf-page:${Math.max(1, Math.floor(pageNumber))}:element:${Math.max(0, Math.floor(elementIndex))}`;
}

export function resolvePageFromReflowElementKey(key: string | null | undefined): number | null {
  if (typeof key !== "string") return null;
  const match = key.match(/^pdf-page:(\d+):element:\d+$/);
  if (!match) return null;
  const pageNumber = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

export function resolveReflowElementKeyForPage(pages: ReflowedPage[], pageNumber: number): string | null {
  const page = pages.find((entry) => entry.pageNumber === pageNumber);
  if (!page) return null;
  const index = page.elements.findIndex((element) => (
    element.type === "paragraph" || element.type === "heading"
  ));
  return getReflowElementKey(pageNumber, Math.max(0, index));
}

export function pruneReflowedPages(
  pages: ReflowedPage[],
  centerPage: number,
  radius = 4,
): ReflowedPage[] {
  const center = Math.max(1, Math.floor(centerPage));
  const safeRadius = Math.max(0, Math.floor(radius));
  const start = center - safeRadius;
  const end = center + safeRadius;
  return pages
    .filter((page) => page.pageNumber >= start && page.pageNumber <= end)
    .sort((left, right) => left.pageNumber - right.pageNumber);
}
