import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import {
  WINDOWS_SUWAYOMI_BUNDLE,
  ensureWindowsSuwayomiBundle,
  hasCompleteWindowsBundle,
  stageWindowsBundleFromArchive,
} from "./prepare-suwayomi-bundle.mjs";

test("fresh Windows installs bundle an allowlisted runtime with Extension Store support", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("../src-tauri/resources/suwayomi-compatibility.json", import.meta.url), "utf8"));
  const jar = WINDOWS_SUWAYOMI_BUNDLE.requiredFiles.find(({ path }) => path === "bin/Suwayomi-Server.jar");
  const certified = manifest.allowedVersions.find(({ sha256 }) => sha256 === jar.sha256);
  assert.ok(certified, "The shipped JAR must be allowlisted by exact digest");
  assert.equal(certified.compatibilityProfile, "V23", "First-run repositories require Extension Store support");
  assert.equal(manifest.blockedVersions.some(({ version }) => version === certified.version), false);
});

for (const existingBundle of [false, true]) test(`${existingBundle ? "upgrades" : "creates"} the bundled JAR with certified Java and remains idempotent`, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epigraph-suwayomi-upgrade-"));
  const bundleRoot = path.join(root, "bundle");
  try {
    const archive = await fixtureArchive(root);
    if (existingBundle) await stageWindowsBundleFromArchive({ bundleRoot, ...archive });
    const runtimeBytes = Buffer.from("certified-store-capable-jar");
    const runtimeHash = createHash("sha256").update(runtimeBytes).digest("hex");
    const java = archive.requiredFiles[1];
    const artifact = {
      version: "fixture-modern",
      url: "https://example.test/certified-java.zip",
      sha256: archive.sha256,
      archiveRequiredFiles: archive.requiredFiles,
      runtimeJar: { url: "https://example.test/modern.jar", sha256: runtimeHash },
      requiredFiles: [{ path: "bin/Suwayomi-Server.jar", sha256: runtimeHash }, java],
    };
    t.mock.method(globalThis, "fetch", async (url) => {
      assert.equal(url, "https://example.test/modern.jar");
      return new Response(runtimeBytes);
    });
    await ensureWindowsSuwayomiBundle({ bundleRoot, archivePath: archive.archivePath, artifact });
    assert.equal(await fs.readFile(path.join(bundleRoot, "bin/Suwayomi-Server.jar"), "utf8"), "certified-store-capable-jar");
    assert.equal(await fs.readFile(path.join(bundleRoot, "jre/bin/java.exe"), "utf8"), "fixture-java");
    assert.equal(await hasCompleteWindowsBundle(bundleRoot, artifact.requiredFiles), true);
    t.mock.method(globalThis, "fetch", async () => { throw new Error("A complete bundle must not download again"); });
    assert.equal((await ensureWindowsSuwayomiBundle({ bundleRoot, artifact })).status, "present");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects a replaced runtime JAR before changing the existing bundle", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epigraph-suwayomi-upgrade-hash-"));
  const bundleRoot = path.join(root, "bundle");
  try {
    const archive = await fixtureArchive(root);
    await stageWindowsBundleFromArchive({ bundleRoot, ...archive });
    const artifact = {
      version: "fixture-modern", url: "https://example.test/java.zip", sha256: archive.sha256,
      archiveRequiredFiles: archive.requiredFiles,
      runtimeJar: { url: "https://example.test/modern.jar", sha256: "0".repeat(64) },
      requiredFiles: [{ path: "bin/Suwayomi-Server.jar", sha256: "0".repeat(64) }, archive.requiredFiles[1]],
    };
    t.mock.method(globalThis, "fetch", async () => new Response("wrong-jar"));
    await assert.rejects(ensureWindowsSuwayomiBundle({ bundleRoot, archivePath: archive.archivePath, artifact }), /runtime JAR SHA-256 mismatch/);
    assert.equal(await fs.readFile(path.join(bundleRoot, "bin/Suwayomi-Server.jar"), "utf8"), "fixture-jar");
    assert.equal(await hasCompleteWindowsBundle(bundleRoot, archive.requiredFiles), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("repairs missing Java modules before reporting an upgraded bundle as complete", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epigraph-suwayomi-java-repair-"));
  const bundleRoot = path.join(root, "bundle");
  try {
    const archive = await fixtureArchive(root);
    await fs.mkdir(path.join(bundleRoot, "jre/bin"), { recursive: true });
    await fs.writeFile(path.join(bundleRoot, "jre/bin/java.exe"), "fixture-java");
    const runtimeBytes = Buffer.from("certified-store-capable-jar");
    const runtimeHash = createHash("sha256").update(runtimeBytes).digest("hex");
    const artifact = {
      version: "fixture-modern", url: "https://example.test/java.zip", sha256: archive.sha256,
      archiveRequiredFiles: archive.requiredFiles,
      runtimeJar: { url: "https://example.test/modern.jar", sha256: runtimeHash },
      requiredFiles: [
        { path: "bin/Suwayomi-Server.jar", sha256: runtimeHash }, archive.requiredFiles[1],
        { path: "jre/lib/modules", sha256: createHash("sha256").update("fixture-modules").digest("hex") },
      ],
    };
    t.mock.method(globalThis, "fetch", async () => new Response(runtimeBytes));
    await ensureWindowsSuwayomiBundle({ bundleRoot, archivePath: archive.archivePath, artifact });
    assert.equal(await fs.readFile(path.join(bundleRoot, "jre/lib/modules"), "utf8"), "fixture-modules");
    assert.equal(await hasCompleteWindowsBundle(bundleRoot, artifact.requiredFiles), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixtureArchive(root, { includeJar = true, includeJava = true } = {}) {
  const zip = new JSZip();
  const prefix = "Suwayomi-Server-v2.1.1867-windows-x64/";
  const jar = "fixture-jar";
  const java = "fixture-java";
  if (includeJar) zip.file(`${prefix}bin/Suwayomi-Server.jar`, jar);
  if (includeJava) zip.file(`${prefix}jre/bin/java.exe`, java);
  zip.file(`${prefix}jre/lib/modules`, "fixture-modules");
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
