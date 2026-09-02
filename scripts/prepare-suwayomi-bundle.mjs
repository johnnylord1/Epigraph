import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import JSZip from "jszip";

export const WINDOWS_SUWAYOMI_BUNDLE = Object.freeze({
  version: "v2.1.1867",
  url: "https://github.com/Suwayomi/Suwayomi-Server/releases/download/v2.1.1867/Suwayomi-Server-v2.1.1867-windows-x64.zip",
  sha256: "ab6687d278e0dd0984f67abbc853511a7e764f84b126a35d09bfd9b0307321ff",
  requiredFiles: Object.freeze([
    Object.freeze({
      path: "bin/Suwayomi-Server.jar",
      sha256: "51e307c2581e4e1a002991ab3e3a77503c8b074c42695987a984a7382d0ac5af",
    }),
    Object.freeze({
      path: "jre/bin/java.exe",
      sha256: "8853c818fd84d27656b4ce1cc97371e9542e83540899b000a91b0770be40421b",
    }),
  ]),
});

async function isNonEmptyFile(filePath) {
  return fsp.stat(filePath).then((entry) => entry.isFile() && entry.size > 0).catch(() => false);
}

export async function hasCompleteWindowsBundle(
  bundleRoot,
  requiredFiles = WINDOWS_SUWAYOMI_BUNDLE.requiredFiles,
) {
  return (await Promise.all(requiredFiles.map(({ path: relativePath, sha256 }) => (
    fileMatchesHash(path.join(bundleRoot, ...relativePath.split("/")), sha256)
  )))).every(Boolean);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function fileMatchesHash(filePath, expectedHash) {
  return await isNonEmptyFile(filePath) && await sha256File(filePath) === expectedHash.toLowerCase();
}

function bundlePrefix(zip, requiredFiles) {
  const requiredPaths = requiredFiles.map(({ path: requiredPath }) => requiredPath);
  const matches = requiredPaths.map((requiredPath) => (
    Object.values(zip.files).find((entry) => !entry.dir && entry.name.endsWith(requiredPath))
  ));
  for (let index = 0; index < matches.length; index += 1) {
    if (!matches[index]) throw new Error(`Suwayomi archive is missing ${requiredPaths[index]}`);
  }
  const prefixes = matches.map((entry, index) => entry.name.slice(0, -requiredPaths[index].length));
  if (!prefixes.every((prefix) => prefix === prefixes[0])) {
    throw new Error("Suwayomi archive JAR and Java runtime do not share the same bundle root");
  }
  return prefixes[0];
}

export async function stageWindowsBundleFromArchive({
  bundleRoot,
  archivePath,
  sha256,
  requiredFiles = WINDOWS_SUWAYOMI_BUNDLE.requiredFiles,
}) {
  const actualHash = await sha256File(archivePath);
  if (actualHash.toLowerCase() !== sha256.toLowerCase()) {
    throw new Error(`Suwayomi archive SHA-256 mismatch: expected ${sha256}, received ${actualHash}`);
  }

  const zip = await JSZip.loadAsync(await fsp.readFile(archivePath));
  const prefix = bundlePrefix(zip, requiredFiles);
  const requiredHashes = new Map(requiredFiles.map((entry) => [entry.path, entry.sha256]));
  let copiedFiles = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !entry.name.startsWith(prefix)) continue;
    const relativePath = entry.name.slice(prefix.length);
    if (!relativePath || path.posix.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
      throw new Error(`Unsafe Suwayomi archive path: ${entry.name}`);
    }
    const destination = path.join(bundleRoot, ...relativePath.split("/"));
    const requiredHash = requiredHashes.get(relativePath);
    if (requiredHash ? await fileMatchesHash(destination, requiredHash) : await isNonEmptyFile(destination)) {
      continue;
    }
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, await entry.async("nodebuffer"));
    copiedFiles += 1;
  }

  if (!await hasCompleteWindowsBundle(bundleRoot, requiredFiles)) {
    throw new Error("Suwayomi archive staging did not produce bin/Suwayomi-Server.jar and jre/bin/java.exe");
  }
  return { status: "staged", copiedFiles };
}

async function downloadPinnedArchive(url, destination) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download the pinned Suwayomi bundle (${response.status} ${response.statusText})`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: "wx" }));
}

export async function ensureWindowsSuwayomiBundle({
  bundleRoot,
  archivePath,
  artifact = WINDOWS_SUWAYOMI_BUNDLE,
} = {}) {
  if (!bundleRoot) throw new Error("bundleRoot is required");
  if (await hasCompleteWindowsBundle(bundleRoot, artifact.requiredFiles)) {
    return { status: "present", copiedFiles: 0 };
  }

  let temporaryRoot;
  let resolvedArchive = archivePath;
  try {
    if (!resolvedArchive) {
      temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "epigraph-suwayomi-bundle-"));
      resolvedArchive = path.join(temporaryRoot, `Suwayomi-Server-${artifact.version}-windows-x64.zip`);
      await downloadPinnedArchive(artifact.url, resolvedArchive);
    }
    return await stageWindowsBundleFromArchive({
      bundleRoot,
      archivePath: resolvedArchive,
      sha256: artifact.sha256,
      requiredFiles: artifact.requiredFiles,
    });
  } finally {
    if (temporaryRoot) await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("The bundled Suwayomi Windows runtime can only be prepared on Windows");
  }
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const bundleRoot = path.join(projectRoot, "src-tauri", "binaries", "suwayomi-bundle");
  const result = await ensureWindowsSuwayomiBundle({ bundleRoot });
  process.stdout.write(`Suwayomi ${WINDOWS_SUWAYOMI_BUNDLE.version} bundle ${result.status} (${result.copiedFiles} files copied).\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
