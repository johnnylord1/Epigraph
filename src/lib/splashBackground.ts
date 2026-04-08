export interface CardDef {
  cx: number;
  w: number;
  h: number;
  lines: number;
  alpha: number;
  speed: number;
  cycleSec: number;
  phase: number;
  travel: number;
  yStart: number;
  angleStart: number;
  tilt: number;
}

export interface CardTrig {
  cosA: number;
  sinA: number;
  tiltRad: number;
}

export interface CardStamp {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

export interface SplashRenderAssets {
  key: string;
  cssW: number;
  cssH: number;
  dpr: number;
  cards: CardDef[];
  trigs: CardTrig[];
  stamps: CardStamp[];
  vignette: HTMLCanvasElement;
}

const LAYER_CFG = [
  { wMin: 26, wMax: 40, speedMin: 30, speedMax: 50, alpha: 0.22 },
  { wMin: 38, wMax: 56, speedMin: 52, speedMax: 80, alpha: 0.35 },
  { wMin: 54, wMax: 76, speedMin: 85, speedMax: 120, alpha: 0.50 },
] as const;

const BUF = 80;
const COLS = 14;
const STAMP_PAD = 6;

const renderAssetCache = new Map<string, SplashRenderAssets>();

function hash(n: number): number {
  let x = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return ((x ^ (x >>> 16)) >>> 0) / 0xffffffff;
}

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

export function createSplashRenderKey(cssW: number, cssH: number, dpr: number): string {
  return `${cssW}x${cssH}@${dpr}`;
}

export function getCachedSplashRenderAssets(key: string): SplashRenderAssets | null {
  return renderAssetCache.get(key) ?? null;
}

export function setCachedSplashRenderAssets(key: string, assets: SplashRenderAssets): void {
  renderAssetCache.set(key, assets);
}

export function buildSplashCards(vw: number, vh: number): { cards: CardDef[]; trigs: CardTrig[] } {
  const cards: CardDef[] = [];
  const laneW = vw / COLS;

  for (let layer = 0; layer < 3; layer++) {
    const cfg = LAYER_CFG[layer];
    for (let col = 0; col < COLS; col++) {
      const seed = col * 31 + layer * 97 + 7;
      const w = cfg.wMin + hash(seed + 1) * (cfg.wMax - cfg.wMin);
      const h = w * 1.44;
      const speed = cfg.speedMin + hash(seed + 5) * (cfg.speedMax - cfg.speedMin);
      const travel = vh + h + BUF;

      cards.push({
        cx: (col + 0.5) * laneW + (hash(seed + 2) * 2 - 1) * Math.max(0, (laneW - w) / 2 - 2),
        w,
        h,
        lines: 1 + Math.floor(hash(seed + 7) * 3),
        alpha: cfg.alpha,
        speed,
        cycleSec: travel / speed,
        phase: ((col / COLS) + hash(seed + 6) * 0.6 + layer * 0.23) % 1,
        travel,
        yStart: vh + h / 2 + BUF / 2,
        angleStart: hash(seed + 3) * 50 - 25,
        tilt: (hash(seed + 4) * 2 - 1) * 18,
      });
    }
  }

  const trigs: CardTrig[] = cards.map((card) => ({
    cosA: Math.cos(card.angleStart * (Math.PI / 180)),
    sinA: Math.sin(card.angleStart * (Math.PI / 180)),
    tiltRad: card.tilt * (Math.PI / 180),
  }));

  return { cards, trigs };
}

export function buildSplashStamp(card: CardDef, dpr: number): CardStamp {
  const width = Math.ceil(card.w + STAMP_PAD * 2);
  const height = Math.ceil(card.h + STAMP_PAD * 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not acquire splash stamp context.");
  }

  ctx.scale(dpr, dpr);

  const x0 = STAMP_PAD;
  const y0 = STAMP_PAD;
  const coverH = (card.w * 0.72) * 1.05;
  const lineY0 = y0 + 3 + coverH + 5;

  ctx.fillStyle = "rgba(0,0,0,0.5)";
  rrect(ctx, x0 + 2, y0 + 2, card.w, card.h, 4);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.07)";
  rrect(ctx, x0, y0, card.w, card.h, 4);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 1.2;
  rrect(ctx, x0, y0, card.w, card.h, 4);
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.15)";
  rrect(ctx, x0 + 3, y0 + 3, card.w - 6, coverH, 3);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.08)";
  rrect(ctx, x0 + 3, y0 + 3, (card.w - 6) * 0.45, coverH, 3);
  ctx.fill();

  for (let lineIndex = 0; lineIndex < card.lines; lineIndex++) {
    ctx.fillStyle = lineIndex === 0 ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.20)";
    ctx.fillRect(
      x0 + 4,
      lineY0 + lineIndex * 8,
      (card.w - 8) * (lineIndex === 0 ? 0.78 : 0.52),
      lineIndex === 0 ? 3 : 2,
    );
  }

  return { canvas, width, height };
}

export function buildSplashVignette(vw: number, vh: number, dpr: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vw * dpr);
  canvas.height = Math.round(vh * dpr);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not acquire splash vignette context.");
  }

  ctx.scale(dpr, dpr);

  const gradient = ctx.createRadialGradient(vw / 2, vh / 2, 0, vw / 2, vh / 2, Math.max(vw, vh) * 0.65);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.4, "rgba(0,0,0,0)");
  gradient.addColorStop(0.7, "rgba(0,0,0,0.25)");
  gradient.addColorStop(1, "rgba(0,0,0,0.65)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, vw, vh);

  return canvas;
}

export const SPLASH_STAMP_BATCH_SIZE = COLS;
