import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import {
  hasCompleteWindowsBundle,
  stageWindowsBundleFromArchive,
} from "./prepare-suwayomi-bundle.mjs";

async function fixtureArchive(root, { includeJar = true, includeJava = true } = {}) {
  const zip = new JSZip();
  const prefix = "Suwayomi-Server-v2.1.1867-windows-x64/";
  const jar = "fixture-jar";
  const java = "fixture-java";
  if (includeJar) zip.file(`${prefix}bin/Suwayomi-Server.jar`, jar);
  if (includeJava) zip.file(`${prefix}jre/bin/java.exe`, java);
  zip.file(`${prefix}jre/conf/security/java.security`, "archive-version");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const archivePath = path.join(root, "suwayomi.zip");
  await fs.writeFile(archivePath, bytes);
  return {
    archivePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    requiredFiles: [
      { path: "bin/Suwayomi-Server.jar", sha256: createHash("sha256").update(jar).digest("hex") },
      { path: "jre/bin/java.exe", sha256: createHash("sha256").update(java).digest("hex") },
    ],
  };
}

test("stages a pinned Windows bundle without overwriting tracked runtime files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epigraph-suwayomi-stage-"));
  const bundleRoot = path.join(root, "bundle");
  try {
    await fs.mkdir(path.join(bundleRoot, "jre", "conf", "security"), { recursive: true });
    const trackedFile = path.join(bundleRoot, "jre", "conf", "security", "java.security");
    await fs.writeFile(trackedFile, "checkout-version");
    const archive = await fixtureArchive(root);

    const result = await stageWindowsBundleFromArchive({ bundleRoot, ...archive });

    assert.equal(result.status, "staged");
    assert.equal(await fs.readFile(path.join(bundleRoot, "bin", "Suwayomi-Server.jar"), "utf8"), "fixture-jar");
    assert.equal(await fs.readFile(path.join(bundleRoot, "jre", "bin", "java.exe"), "utf8"), "fixture-java");
    assert.equal(await fs.readFile(trackedFile, "utf8"), "checkout-version");
    assert.equal(await hasCompleteWindowsBundle(bundleRoot, archive.requiredFiles), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("repairs stale required runtime files while preserving tracked configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epigraph-suwayomi-repair-"));
  const bundleRoot = path.join(root, "bundle");
  try {
    await fs.mkdir(path.join(bundleRoot, "bin"), { recursive: true });
    await fs.mkdir(path.join(bundleRoot, "jre", "bin"), { recursive: true });
    await fs.writeFile(path.join(bundleRoot, "bin", "Suwayomi-Server.jar"), "stale-jar");
    await fs.writeFile(path.join(bundleRoot, "jre", "bin", "java.exe"), "stale-java");
    const archive = await fixtureArchive(root);

    assert.equal(await hasCompleteWindowsBundle(bundleRoot, archive.requiredFiles), false);
    await stageWindowsBundleFromArchive({ bundleRoot, ...archive });

    assert.equal(await fs.readFile(path.join(bundleRoot, "bin", "Suwayomi-Server.jar"), "utf8"), "fixture-jar");
    assert.equal(await fs.readFile(path.join(bundleRoot, "jre", "bin", "java.exe"), "utf8"), "fixture-java");
    assert.equal(await hasCompleteWindowsBundle(bundleRoot, archive.requiredFiles), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects an archive whose SHA-256 does not match the pinned artifact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epigraph-suwayomi-hash-"));
  try {
    const archive = await fixtureArchive(root);
    await assert.rejects(
      stageWindowsBundleFromArchive({
        bundleRoot: path.join(root, "bundle"),
        archivePath: archive.archivePath,
        sha256: "0".repeat(64),
      }),
      /SHA-256 mismatch/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects an archive without the required JAR and Java runtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epigraph-suwayomi-layout-"));
  try {
    const archive = await fixtureArchive(root, { includeJava: false });
    await assert.rejects(
      stageWindowsBundleFromArchive({ bundleRoot: path.join(root, "bundle"), ...archive }),
      /jre\/bin\/java\.exe/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
