import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve("docs/mockups/aethon-selected-icon");
const input = path.join(root, "generated-assets", "concept-a-cutout-imgly.png");
const outDir = path.join(root, "generated-assets");

await mkdir(outDir, { recursive: true });

const sizes = [512, 256, 128, 96, 67, 48, 32];

// Keep the original 1024px cutout as the master. The previous pass upscaled too far,
// which made the icon feel blurrier. This pass avoids hallucinating resolution.
await sharp(input)
  .ensureAlpha()
  .modulate({
    brightness: 1.02,
    saturation: 1.04,
  })
  .linear(1.045, -3)
  .sharpen({
    sigma: 0.55,
    m1: 0.35,
    m2: 0.72,
    x1: 2,
    y2: 6,
    y3: 12,
  })
  .png({
    compressionLevel: 9,
    adaptiveFiltering: true,
    palette: false,
  })
  .toFile(path.join(outDir, "concept-a-enhanced-v2-1024.png"));

for (const size of sizes) {
  await sharp(path.join(outDir, "concept-a-enhanced-v2-1024.png"))
    .resize(size, size, {
      fit: "contain",
      kernel: sharp.kernel.lanczos3,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .sharpen({
      sigma: size <= 96 ? 0.42 : 0.35,
      m1: 0.22,
      m2: size <= 96 ? 0.62 : 0.45,
      x1: 2,
      y2: 5,
      y3: 10,
    })
    .png({
      compressionLevel: 9,
      adaptiveFiltering: true,
      palette: false,
    })
    .toFile(path.join(outDir, `concept-a-enhanced-v2-${size}.png`));
}

console.log(
  JSON.stringify(
    {
      input,
      output: path.join(outDir, "concept-a-enhanced-v2-1024.png"),
      sizes,
    },
    null,
    2,
  ),
);
