import markUrl from "../../assets/epigraph-splash-mark.png";
import outfitMediumUrl from "../../assets/fonts/outfit-medium.ttf?url";
import outfitSemiboldUrl from "../../assets/fonts/outfit-semibold.ttf?url";
import { cacheLibraryCoverFromServer, getCachedLibraryCoverUrl } from "./coverCache";
import { resolveMangaCoverUrl } from "../manga/coverResolver";
import { shareCollageLayout } from "./sharePayload";
import type { Manga } from "../types";

type CoverScope = Parameters<typeof getCachedLibraryCoverUrl>[0];

export interface ShareImageWork {
  title: string;
  cover: ImageBitmap | null;
}

export interface ShareImageOptions {
  /** The header's count, such as "12 works". */
  countLabel: (count: number) => string;
  /** The text of the last cell when some works do not fit, such as "+12 more". */
  moreLabel: (count: number) => string;
}

/**
 * The Epigraph share card. Epigraph Mobile draws the same card in
 * `epigraph.library.LibraryShareCard`; keep the two in step when changing a value here.
 *
 * Sizes are in card units: the card is drawn at 1x to 2x of them so a small selection is
 * still sharp in a chat preview. The palette is the Nocturne theme, the mark is the app's
 * drop (`epigraph-splash-mark.png`, the same file in both apps) and the type is Outfit,
 * bundled in both apps so the card looks the same offline.
 */
export const SHARE_CARD = {
  padding: 40,
  headerHeight: 84,
  markHeight: 40,
  markGap: 14,
  dividerY: 62,
  cellWidth: 200,
  coverHeight: 300,
  titleGap: 12,
  titleLine: 21,
  titleLines: 2,
  gapX: 24,
  gapY: 28,
  radius: 12,
  minContentWidth: 440,
  minImageWidth: 960,
  maxScale: 2,
  font: {
    wordmark: { weight: 600, size: 30 },
    count: { weight: 500, size: 16 },
    title: { weight: 500, size: 15 },
    more: { weight: 600, size: 28 },
    initial: { weight: 600, size: 72 },
  },
  colors: {
    background: "#0b0a0e",
    glow: "rgba(159, 142, 217, 0.20)",
    glowFaint: "rgba(159, 142, 217, 0.07)",
    divider: "rgba(180, 166, 227, 0.16)",
    coverEdge: "rgba(255, 255, 255, 0.07)",
    placeholder: "#1a1820",
    placeholderInk: "#4f4a5a",
    moreFill: "rgba(159, 142, 217, 0.12)",
    accent: "#b4a6e3",
    title: "#e9e7ed",
    muted: "#89838f",
  },
  /** The visible part of the 1024x1024 mark image. */
  markSource: { x: 330, y: 214, width: 364, height: 579 },
} as const;

const CELL_HEIGHT = SHARE_CARD.coverHeight + SHARE_CARD.titleGap + SHARE_CARD.titleLine * SHARE_CARD.titleLines;
const COVER_LOAD_CONCURRENCY = 6;
const COVER_LOAD_TIMEOUT_MS = 4000;
const SHARE_FONT = "Epigraph Share Outfit";
const FONT_STACK = `"${SHARE_FONT}", Outfit, Manrope, system-ui, sans-serif`;

function withCoverTimeout(
  load: (signal: AbortSignal) => Promise<ImageBitmap | null>,
  signal?: AbortSignal,
): Promise<ImageBitmap | null> {
  const controller = new AbortController();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (bitmap: ImageBitmap | null) => {
      if (settled) {
        bitmap?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      resolve(bitmap);
    };
    const cancel = () => {
      controller.abort();
      finish(null);
    };
    const timer = setTimeout(cancel, COVER_LOAD_TIMEOUT_MS);
    signal?.addEventListener("abort", cancel, { once: true });
    load(controller.signal).then(finish, () => finish(null));
  });
}

/** Reads a library cover from the on-disk cache, caching it first when it is not there yet. */
export async function loadShareCover(manga: Manga, scope: CoverScope, signal?: AbortSignal): Promise<ImageBitmap | null> {
  if (!manga.thumbnailUrl || signal?.aborted) return null;
  const bitmap = await withCoverTimeout(async (coverSignal) => {
    if (manga.id <= 0) {
      return loadBitmap(manga.thumbnailUrl, coverSignal);
    }
    const cached = await getCachedLibraryCoverUrl(scope, manga).catch(() => null);
    if (coverSignal.aborted) return null;
    const url = cached ?? await cacheLibraryCoverFromServer(scope, manga).catch(() => null);
    if (coverSignal.aborted) return null;
    const bitmap = url ? await loadBitmap(url, coverSignal).catch(() => null) : null;
    if (bitmap || coverSignal.aborted) return bitmap;
    const directUrl = resolveMangaCoverUrl(manga, { cacheGeneration: scope.coverCacheGeneration });
    return directUrl && directUrl !== url ? loadBitmap(directUrl, coverSignal) : null;
  }, signal);
  if (signal?.aborted) {
    bitmap?.close();
    return null;
  }
  return bitmap;
}

export async function loadShareCovers(
  mangas: readonly Manga[],
  scope: CoverScope,
  signal?: AbortSignal,
): Promise<(ImageBitmap | null)[]> {
  const covers: (ImageBitmap | null)[] = new Array(mangas.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < mangas.length && !signal?.aborted) {
      const index = next;
      next += 1;
      covers[index] = await loadShareCover(mangas[index], scope, signal);
    }
  }
  await Promise.all(Array.from({ length: Math.min(COVER_LOAD_CONCURRENCY, mangas.length) }, worker));
  return covers;
}

async function loadBitmap(url: string, signal?: AbortSignal) {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) return null;
  return await createImageBitmap(await response.blob());
}

let brandAssets: Promise<ImageBitmap | null> | null = null;

/** Loads the bundled Outfit faces and the mark once; the card falls back to the app font without them. */
function loadBrandAssets() {
  brandAssets ??= (async () => {
    try {
      const faces = [
        new FontFace(SHARE_FONT, `url("${outfitMediumUrl}")`, { weight: "500" }),
        new FontFace(SHARE_FONT, `url("${outfitSemiboldUrl}")`, { weight: "600" }),
      ];
      await Promise.all(faces.map((face) => face.load()));
      for (const face of faces) document.fonts.add(face);
    } catch {
      // The font stack falls back to Outfit or Manrope from the app styles.
    }
    try {
      return await loadBitmap(markUrl);
    } catch {
      return null;
    }
  })();
  return brandAssets;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

/** Fills the cell with the cover, cropped from its center like the library cards. */
function drawCover(ctx: CanvasRenderingContext2D, cover: ImageBitmap, x: number, y: number) {
  const { cellWidth, coverHeight } = SHARE_CARD;
  const scale = Math.max(cellWidth / cover.width, coverHeight / cover.height);
  const sourceWidth = cellWidth / scale;
  const sourceHeight = coverHeight / scale;
  const sourceX = (cover.width - sourceWidth) / 2;
  const sourceY = (cover.height - sourceHeight) / 2;
  ctx.drawImage(cover, sourceX, sourceY, sourceWidth, sourceHeight, x, y, cellWidth, coverHeight);
}

function fitLine(ctx: CanvasRenderingContext2D, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  let end = text.length;
  while (end > 0 && ctx.measureText(`${text.slice(0, end).trimEnd()}…`).width > width) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/** Breaks the title into at most two lines, ending the last one with an ellipsis when it is cut. */
export function wrapShareTitle(ctx: CanvasRenderingContext2D, title: string, width: number, maxLines: number = SHARE_CARD.titleLines) {
  const words = title.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[][] = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (current && ctx.measureText([...current, word].join(" ")).width <= width) current.push(word);
    else lines.push([word]);
  }
  const kept = lines.slice(0, maxLines - 1).map((line) => line.join(" "));
  const rest = lines.slice(maxLines - 1).flat().join(" ");
  if (rest) kept.push(rest);
  return kept.map((line) => fitLine(ctx, line, width));
}

function font(spec: { weight: number; size: number }) {
  return `${spec.weight} ${spec.size}px ${FONT_STACK}`;
}

function drawBackground(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const { colors } = SHARE_CARD;
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);
  const reach = Math.max(width, height);
  const glow = ctx.createRadialGradient(width * 0.12, 0, 0, width * 0.12, 0, reach * 0.85);
  glow.addColorStop(0, colors.glow);
  glow.addColorStop(1, "rgba(159, 142, 217, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
  const faint = ctx.createRadialGradient(width, height, 0, width, height, reach * 0.6);
  faint.addColorStop(0, colors.glowFaint);
  faint.addColorStop(1, "rgba(159, 142, 217, 0)");
  ctx.fillStyle = faint;
  ctx.fillRect(0, 0, width, height);
}

function drawHeader(ctx: CanvasRenderingContext2D, mark: ImageBitmap | null, width: number, countLabel: string) {
  const { padding, markHeight, markGap, dividerY, colors, markSource } = SHARE_CARD;
  const rowCenter = padding + markHeight / 2;
  let textX = padding;
  if (mark) {
    const markWidth = (markSource.width / markSource.height) * markHeight;
    ctx.drawImage(mark, markSource.x, markSource.y, markSource.width, markSource.height, padding, padding, markWidth, markHeight);
    textX += markWidth + markGap;
  }

  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = colors.title;
  ctx.font = font(SHARE_CARD.font.wordmark);
  ctx.fillText("Epigraph", textX, rowCenter);
  const wordmarkEnd = textX + ctx.measureText("Epigraph").width;

  ctx.textAlign = "right";
  ctx.fillStyle = colors.muted;
  ctx.font = font(SHARE_CARD.font.count);
  ctx.fillText(fitLine(ctx, countLabel, Math.max(0, width - padding - wordmarkEnd - 24)), width - padding, rowCenter);

  ctx.fillStyle = colors.divider;
  ctx.fillRect(padding, padding + dividerY, width - padding * 2, 1);
}

/** Draws the Epigraph share card: the brand header, then the covers and names of the works. */
export async function renderShareImage(works: readonly ShareImageWork[], options: ShareImageOptions): Promise<Blob> {
  const layout = shareCollageLayout(works.length);
  if (layout.covers === 0 && layout.overflow === 0) throw new Error("Nothing to draw");
  const mark = await loadBrandAssets();
  await document.fonts?.ready;

  const { padding, headerHeight, cellWidth, coverHeight, titleGap, titleLine, gapX, gapY, radius, colors } = SHARE_CARD;
  const gridWidth = layout.columns * cellWidth + (layout.columns - 1) * gapX;
  const gridHeight = layout.rows * CELL_HEIGHT + (layout.rows - 1) * gapY;
  const baseWidth = padding * 2 + Math.max(gridWidth, SHARE_CARD.minContentWidth);
  const baseHeight = padding * 2 + headerHeight + gridHeight;
  const scale = Math.min(SHARE_CARD.maxScale, Math.max(1, SHARE_CARD.minImageWidth / baseWidth));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(baseWidth * scale);
  canvas.height = Math.round(baseHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable");
  ctx.scale(scale, scale);
  ctx.imageSmoothingQuality = "high";

  drawBackground(ctx, baseWidth, baseHeight);
  drawHeader(ctx, mark, baseWidth, options.countLabel(works.length));

  const gridX = (baseWidth - gridWidth) / 2;
  const gridY = padding + headerHeight;
  const cellX = (cell: number) => gridX + (cell % layout.columns) * (cellWidth + gapX);
  const cellY = (cell: number) => gridY + Math.floor(cell / layout.columns) * (CELL_HEIGHT + gapY);

  for (let cell = 0; cell < layout.covers; cell += 1) {
    const work = works[cell];
    const x = cellX(cell);
    const y = cellY(cell);
    ctx.save();
    roundedRect(ctx, x, y, cellWidth, coverHeight, radius);
    ctx.clip();
    ctx.fillStyle = colors.placeholder;
    ctx.fillRect(x, y, cellWidth, coverHeight);
    if (work.cover) {
      drawCover(ctx, work.cover, x, y);
    } else {
      ctx.fillStyle = colors.placeholderInk;
      ctx.font = font(SHARE_CARD.font.initial);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(Array.from(work.title.trim())[0]?.toUpperCase() ?? "?", x + cellWidth / 2, y + coverHeight / 2);
    }
    ctx.restore();
    ctx.strokeStyle = colors.coverEdge;
    ctx.lineWidth = 1;
    roundedRect(ctx, x + 0.5, y + 0.5, cellWidth - 1, coverHeight - 1, radius);
    ctx.stroke();

    ctx.fillStyle = colors.title;
    ctx.font = font(SHARE_CARD.font.title);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    wrapShareTitle(ctx, work.title, cellWidth).forEach((line, lineIndex) => {
      ctx.fillText(line, x, y + coverHeight + titleGap + lineIndex * titleLine);
    });
  }

  if (layout.overflow > 0) {
    const x = cellX(layout.covers);
    const y = cellY(layout.covers);
    ctx.fillStyle = colors.moreFill;
    roundedRect(ctx, x, y, cellWidth, coverHeight, radius);
    ctx.fill();
    ctx.fillStyle = colors.accent;
    ctx.font = font(SHARE_CARD.font.more);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(fitLine(ctx, options.moreLabel(layout.overflow), cellWidth - 24), x + cellWidth / 2, y + coverHeight / 2);
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Image encoding failed"))), "image/png");
  });
}
