import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "vite";

const budgets = JSON.parse(readFileSync(new URL("../config/release-bundle-budgets.json", import.meta.url), "utf8"));
const result = await build({
  logLevel: "silent",
  build: {
    write: false,
    reportCompressedSize: false,
  },
});

const outputs = Array.isArray(result) ? result.flatMap((entry) => entry.output) : result.output;
const chunks = outputs.filter((entry) => entry.type === "chunk");
const assets = outputs.filter((entry) => entry.type === "asset");
const entry = chunks.find((chunk) => chunk.isEntry);
if (!entry) throw new Error("Vite did not produce an entry chunk.");

const bytes = (value) => Buffer.byteLength(value);
const chunkMetrics = chunks.map((chunk) => ({
  fileName: chunk.fileName,
  name: chunk.name,
  isEntry: chunk.isEntry,
  minifiedBytes: bytes(chunk.code),
  gzipBytes: gzipSync(chunk.code, { level: 9 }).byteLength,
})).sort((left, right) => right.minifiedBytes - left.minifiedBytes);
const cssMetrics = assets
  .filter((asset) => asset.fileName.endsWith(".css"))
  .map((asset) => ({ fileName: asset.fileName, bytes: bytes(asset.source) }))
  .sort((left, right) => right.bytes - left.bytes);
const entryMetric = chunkMetrics.find((chunk) => chunk.fileName === entry.fileName);
const chunksByFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
const initialChunkNames = new Set();
function collectStaticImports(fileName) {
  if (initialChunkNames.has(fileName)) return;
  const chunk = chunksByFileName.get(fileName);
  if (!chunk) return;
  initialChunkNames.add(fileName);
  for (const importedFileName of chunk.imports) collectStaticImports(importedFileName);
}
collectStaticImports(entry.fileName);
const initialChunks = chunkMetrics.filter((chunk) => initialChunkNames.has(chunk.fileName));
const initialPayload = {
  minifiedBytes: initialChunks.reduce((sum, chunk) => sum + chunk.minifiedBytes, 0),
  gzipBytes: initialChunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
  chunks: initialChunks.map((chunk) => chunk.fileName).sort(),
};
const totalCssBytes = cssMetrics.reduce((sum, asset) => sum + asset.bytes, 0);
const failures = [];
const entryReductionPercent = (
  (budgets.baseline.entryMinifiedBytes - entryMetric.minifiedBytes)
  / budgets.baseline.entryMinifiedBytes
) * 100;

if (entryReductionPercent < budgets.baseline.minimumReductionPercent) {
  failures.push(
    `entry reduction ${entryReductionPercent.toFixed(2)}% < ${budgets.baseline.minimumReductionPercent}%`,
  );
}
if (entryMetric.minifiedBytes > budgets.entry.maxMinifiedBytes) {
  failures.push(`entry minified ${entryMetric.minifiedBytes} > ${budgets.entry.maxMinifiedBytes}`);
}
if (entryMetric.gzipBytes > budgets.entry.maxGzipBytes) {
  failures.push(`entry gzip ${entryMetric.gzipBytes} > ${budgets.entry.maxGzipBytes}`);
}
for (const forbiddenImport of budgets.forbiddenInitialImports) {
  if (initialPayload.chunks.some((fileName) => fileName.includes(forbiddenImport))) {
    failures.push(`initial payload statically imports ${forbiddenImport}`);
  }
}
if (budgets.initialPayload?.maxMinifiedBytes && initialPayload.minifiedBytes > budgets.initialPayload.maxMinifiedBytes) {
  failures.push(`initial payload minified ${initialPayload.minifiedBytes} > ${budgets.initialPayload.maxMinifiedBytes}`);
}
if (budgets.initialPayload?.maxGzipBytes && initialPayload.gzipBytes > budgets.initialPayload.maxGzipBytes) {
  failures.push(`initial payload gzip ${initialPayload.gzipBytes} > ${budgets.initialPayload.maxGzipBytes}`);
}
for (const chunk of chunkMetrics) {
  if (chunk.isEntry || chunk.minifiedBytes <= budgets.commonChunkMaxBytes) continue;
  if (budgets.allowlistedOversize.some((name) => chunk.name.includes(name) || chunk.fileName.includes(name))) continue;
  failures.push(`${chunk.fileName} minified ${chunk.minifiedBytes} > ${budgets.commonChunkMaxBytes}`);
}
if (totalCssBytes > budgets.css.maxBytes) {
  failures.push(`total CSS ${totalCssBytes} > ${budgets.css.maxBytes}`);
}

const largestEntryModules = Object.entries(entry.modules)
  .map(([id, metric]) => ({
    id: relative(process.cwd(), id).replaceAll("\\", "/"),
    bytes: metric.renderedLength ?? 0,
  }))
  .sort((left, right) => right.bytes - left.bytes)
  .slice(0, 20);
process.stdout.write(`${JSON.stringify({
  entry: entryMetric,
  entryReductionPercent: Number(entryReductionPercent.toFixed(2)),
  entryImports: entry.imports,
  entryDynamicImports: entry.dynamicImports,
  initialPayload,
  largestChunks: chunkMetrics.slice(0, 12),
  css: { totalBytes: totalCssBytes, assets: cssMetrics.slice(0, 5) },
  largestEntryModules,
  failures,
}, null, 2)}\n`);

if (failures.length > 0) process.exitCode = 1;
