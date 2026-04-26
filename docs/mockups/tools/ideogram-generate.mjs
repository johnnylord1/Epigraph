import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultPrompt = [
  "Premium app icon concept for a desktop manga and novel reader named Aethon.",
  "Single central hollow teardrop contour mark, the inner cutout is also a teardrop shape.",
  "Shape should feel more straight, symmetric, sharp and intentional than a generic water drop, with a subtle left-drift posture.",
  "Mystical nocturnal identity, quiet lunar lavender and graphite palette.",
  "Subtle laminated glass or moonlit metal edge, refined but not glossy, not artificial, not 3D, not toy-like.",
  "Minimal strong silhouette, readable at 32px, centered composition, no text, no letters, no book illustration, no green, no copper, no red, no orange.",
].join(" ");

const defaultNegativePrompt = [
  "cartoon, childish, mascot, clipart, stock droplet, water logo, flame logo, leaf logo, literal book, letters, typography, text, monogram,",
  "overly glossy, plastic, chrome, 3d render, gemstone, noisy details, busy background, green, orange, red, copper, gold",
].join(" ");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function usage() {
  return `Usage:
  $env:IDEOGRAM_API_KEY="your_key"
  node docs/mockups/tools/ideogram-generate.mjs [options]

Options:
  --prompt "text"             Prompt to send. Defaults to Aethon hollow drop prompt.
  --negative "text"           Negative prompt. Defaults to app-icon exclusions.
  --num 4                     Number of images, 1-8. Defaults to 4.
  --speed DEFAULT             FLASH, TURBO, DEFAULT, or QUALITY. Defaults to DEFAULT.
  --aspect 1x1                Aspect ratio. Defaults to 1x1.
  --solid-background          Use normal generation instead of transparent background.
  --out "path"                Output folder. Defaults to docs/mockups/output/ideogram/<timestamp>.
  --help                      Show this message.
`;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const apiKey = process.env.IDEOGRAM_API_KEY;
if (!apiKey) {
  console.error("Missing IDEOGRAM_API_KEY.\n");
  console.error(usage());
  process.exit(1);
}

const prompt = String(args.prompt || defaultPrompt);
const negativePrompt = String(args.negative || defaultNegativePrompt);
const numImages = Math.max(1, Math.min(Number(args.num || 4), 8));
const renderingSpeed = String(args.speed || "DEFAULT").toUpperCase();
const aspectRatio = String(args.aspect || "1x1");
const transparent = !args["solid-background"];
const endpoint = transparent
  ? "https://api.ideogram.ai/v1/ideogram-v3/generate-transparent"
  : "https://api.ideogram.ai/v1/ideogram-v3/generate";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.resolve(
  args.out ||
    path.join(__dirname, "..", "output", "ideogram", `aethon-hollow-drop-${stamp}`),
);

await mkdir(outputDir, { recursive: true });

const body = new FormData();
body.set("prompt", prompt);
body.set("negative_prompt", negativePrompt);
body.set("num_images", String(numImages));
body.set("rendering_speed", renderingSpeed);
body.set("aspect_ratio", aspectRatio);
body.set("magic_prompt", "AUTO");

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Api-Key": apiKey,
  },
  body,
});

const responseText = await response.text();
let payload;
try {
  payload = JSON.parse(responseText);
} catch {
  payload = { raw: responseText };
}

await writeFile(
  path.join(outputDir, "ideogram-response.json"),
  JSON.stringify(
    {
      endpoint,
      transparent,
      request: {
        prompt,
        negative_prompt: negativePrompt,
        num_images: numImages,
        rendering_speed: renderingSpeed,
        aspect_ratio: aspectRatio,
        magic_prompt: "AUTO",
      },
      response: payload,
    },
    null,
    2,
  ),
);

if (!response.ok) {
  console.error(`Ideogram request failed: HTTP ${response.status}`);
  console.error(responseText);
  console.error(`Saved response to ${path.join(outputDir, "ideogram-response.json")}`);
  process.exit(1);
}

const generated = [];
for (const [index, item] of (payload.data || []).entries()) {
  const imageResponse = await fetch(item.url);
  if (!imageResponse.ok) {
    generated.push({ index, ok: false, status: imageResponse.status, url: item.url });
    continue;
  }
  const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
  const filePath = path.join(outputDir, `concept-${String(index + 1).padStart(2, "0")}.png`);
  await writeFile(filePath, imageBytes);
  generated.push({ index, ok: true, filePath, seed: item.seed, resolution: item.resolution });
}

console.log(
  JSON.stringify(
    {
      outputDir,
      transparent,
      generated,
      metadataPath: path.join(outputDir, "ideogram-response.json"),
    },
    null,
    2,
  ),
);
