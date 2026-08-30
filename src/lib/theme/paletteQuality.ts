export type Rgba = readonly [red: number, green: number, blue: number, alpha: number];

const clampByte = (value: number): number => Math.min(255, Math.max(0, value));
const clampAlpha = (value: number): number => Math.min(1, Math.max(0, value));

export function parseThemeColor(value: string): Rgba {
  const input = value.trim();
  const shortHex = /^#([\da-f])([\da-f])([\da-f])$/i.exec(input);
  if (shortHex) {
    return [
      Number.parseInt(shortHex[1] + shortHex[1], 16),
      Number.parseInt(shortHex[2] + shortHex[2], 16),
      Number.parseInt(shortHex[3] + shortHex[3], 16),
      1,
    ];
  }

  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(input);
  if (hex) {
    return [
      Number.parseInt(hex[1], 16),
      Number.parseInt(hex[2], 16),
      Number.parseInt(hex[3], 16),
      1,
    ];
  }

  const functional = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(input);
  if (functional) {
    return [
      clampByte(Number(functional[1])),
      clampByte(Number(functional[2])),
      clampByte(Number(functional[3])),
      functional[4] === undefined ? 1 : clampAlpha(Number(functional[4])),
    ];
  }

  throw new Error(`Unsupported theme color: ${value}`);
}

function composite(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha === 0) return [0, 0, 0, 0];

  return [
    (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
    alpha,
  ];
}

function channelLuminance(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function rgbaLuminance(color: Rgba): number {
  return 0.2126 * channelLuminance(color[0])
    + 0.7152 * channelLuminance(color[1])
    + 0.0722 * channelLuminance(color[2]);
}

export function relativeLuminance(value: string): number {
  return rgbaLuminance(parseThemeColor(value));
}

export function contrastRatio(foreground: string, background: string): number {
  const backgroundColor = parseThemeColor(background);
  const foregroundColor = composite(parseThemeColor(foreground), backgroundColor);
  const foregroundLuminance = rgbaLuminance(foregroundColor);
  const backgroundLuminance = rgbaLuminance(backgroundColor);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}
