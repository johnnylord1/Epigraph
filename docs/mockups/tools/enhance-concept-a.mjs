import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve("docs/mockups/aethon-selected-icon");
const input = path.join(root, "generated-assets", "concept-a-cutout-imgly.png");
const outDir = path.join(root, "generated-assets");

await mkdir(outDir, { recursive: true });

const base = sharp(input).ensureAlpha();
const metadata = await base.metadata();
const sourceSize = Math.max(metadata.width ?? 512, metadata.height ?? 512);
const targetSize = Math.max(1024, sourceSize * 2);

const enhanced = base
  .resize(targetSize, targetSize, {
    fit: "contain",
    kernel: sharp.kernel.lanczos3,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .modulate({
    brightness: 1.04,
    saturation: 1.08,
  })
  .linear(1.06, -4)
  .sharpen({
    sigma: 0.85,
    m1: 0.55,
    m2: 1.15,
    x1: 2,
    y2: 8,
    y3: 16,
  })
  .png({
    compressionLevel: 9,
    adaptiveFiltering: true,
    palette: false,
  });

await enhanced.toFile(path.join(outDir, "concept-a-enhanced-1024.png"));

const sizes = [512, 256, 128, 96, 67, 48, 32];
for (const size of sizes) {
  await sharp(path.join(outDir, "concept-a-enhanced-1024.png"))
    .resize(size, size, {
      fit: "contain",
      kernel: sharp.kernel.lanczos3,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({
      compressionLevel: 9,
      adaptiveFiltering: true,
      palette: false,
    })
    .toFile(path.join(outDir, `concept-a-enhanced-${size}.png`));
}

console.log(
  JSON.stringify(
    {
      input,
      sourceSize,
      targetSize,
      output: path.join(outDir, "concept-a-enhanced-1024.png"),
      sizes,
    },
    null,
    2,
  ),
);
