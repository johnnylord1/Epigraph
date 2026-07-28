import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { serverConfig } from "./certify-suwayomi-release.mjs";
import {
  assertExtensionCanaries,
  assertStoreMigration,
  copyAllowlistedProfile,
  summarizeRuntimeState,
} from "./certify-suwayomi-migration.mjs";

function commonState() {
  return {
    data: {
      library: { nodes: [{ id: 7, sourceId: "2", inLibrary: true, downloadCount: 1, unreadCount: 3 }] },
      chapters: {
        nodes: [{ id: 9, mangaId: 7, isRead: true, isDownloaded: false, isBookmarked: true, lastPageRead: 4 }],
      },
      categories: {
        nodes: [{ id: 1, order: 0, default: true, includeInUpdate: true, includeInDownload: false, mangas: { nodes: [{ id: 7 }] } }],
      },
      sources: { nodes: [{ id: "2", lang: "en", extension: { pkgName: "ext" } }] },
    },
  };
}

test("normalizes V21 and V23 runtime state without leaking store URLs", () => {
  const v21 = summarizeRuntimeState(commonState(), {
    data: {
      extensions: { nodes: [{ pkgName: "ext", versionCode: 12, isInstalled: true, isObsolete: false, hasUpdate: false }] },
      settings: { extensionRepos: ["https://store.example/index.json"] },
    },
  }, "v21");
  const v23 = summarizeRuntimeState(commonState(), {
    data: {
      extensions: { nodes: [{ pkgName: "ext", versionCodeLong: "12", isInstalled: true, isObsolete: false, hasUpdate: false }] },
      extensionStores: { nodes: [{ indexUrl: "https://store.example/index.json", isLegacy: true }] },
    },
  }, "v23");

  assert.equal(v21.sha256, v23.sha256);
  assert.deepEqual(v21.counts, v23.counts);
  assert.equal(v21.storeUrlHashes[0], v23.storeUrlHashes[0]);
  assert.deepEqual(v23.extensionCanary.unloadedContentPackageHashes, []);
  assert.equal(JSON.stringify(v23).includes("store.example"), false);
});

test("accepts the canonical V23 store while preserving the V21 rollback repository", () => {
  const legacyHash = "0b3332b732a3ca14028fbb9e15c8329e865fb12231c9d399ba586aa8ef9a11af";
  const canonicalHash = "55a857183dc6d7695cf564099c70904e3d1589df09e9e9c2871d0a6d197ca93b";
  assert.doesNotThrow(() => assertStoreMigration({
    baseline: { storeUrlHashes: [legacyHash] },
    candidate: { storeUrlHashes: [canonicalHash] },
    restart: { storeUrlHashes: [canonicalHash] },
    rollback: { storeUrlHashes: [legacyHash] },
  }));
  assert.throws(() => assertStoreMigration({
    baseline: { storeUrlHashes: [legacyHash] },
    candidate: { storeUrlHashes: [legacyHash] },
    restart: { storeUrlHashes: [legacyHash] },
    rollback: { storeUrlHashes: [legacyHash] },
  }), /did not canonicalize/);
});

test("requires installed content extension canaries to register sources in every phase", () => {
  const healthy = {
    extensionCanary: {
      installedPackageHashes: ["installed"],
      loadedPackageHashes: ["loaded"],
      unloadedContentPackageHashes: [],
    },
  };
  assert.doesNotThrow(() => assertExtensionCanaries({
    baseline: healthy,
    candidate: healthy,
    restart: healthy,
    rollback: healthy,
  }));
  assert.throws(() => assertExtensionCanaries({
    baseline: healthy,
    candidate: {
      extensionCanary: {
        installedPackageHashes: ["installed"],
        loadedPackageHashes: [],
        unloadedContentPackageHashes: ["installed"],
      },
    },
    restart: healthy,
    rollback: healthy,
  }), /without registered sources/);
});

test("copies only the H2 database, extensions, and settings trees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aethon-migration-copy-test-"));
  try {
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await mkdir(path.join(source, "extensions"), { recursive: true });
    await mkdir(path.join(source, "settings"), { recursive: true });
    await mkdir(path.join(source, "downloads"), { recursive: true });
    await writeFile(path.join(source, "database.mv.db"), "db");
    await writeFile(path.join(source, "server.conf"), "secret");
    await writeFile(path.join(source, "extensions", "canary.jar"), "extension");
    await writeFile(path.join(source, "settings", "prefs.json"), "settings");
    await writeFile(path.join(source, "downloads", "page.jpg"), "content");

    await copyAllowlistedProfile(source, destination);

    assert.equal(await readFile(path.join(destination, "database.mv.db"), "utf8"), "db");
    assert.equal(await readFile(path.join(destination, "extensions", "canary.jar"), "utf8"), "extension");
    assert.equal(await readFile(path.join(destination, "settings", "prefs.json"), "utf8"), "settings");
    await assert.rejects(readFile(path.join(destination, "server.conf")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(destination, "downloads", "page.jpg")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generates a candidate config with only explicitly supplied stores", () => {
  const config = serverConfig(4567, { extensionRepos: ["https://store.example/index.json"] });
  assert.match(config, /server\.ip = "127\.0\.0\.1"/);
  assert.match(config, /server\.port = 4567/);
  assert.match(config, /server\.kcefEnabled = false/);
  assert.match(config, /server\.extensionRepos = \["https:\/\/store\.example\/index\.json"\]/);
  assert.doesNotMatch(config, /server\.extensionStores/);
  const v23Config = serverConfig(4568, { extensionStores: ["https://store.example/index.json"] });
  assert.match(v23Config, /server\.extensionStores = \["https:\/\/store\.example\/index\.json"\]/);
  assert.doesNotMatch(v23Config, /server\.extensionRepos/);
  assert.doesNotMatch(config, /password|proxy|downloadsPath|backupPath/i);
});

test("pins the SR7 candidate as the exact maximum tested runtime", async () => {
  const manifest = JSON.parse(await readFile(
    path.resolve("src-tauri/resources/suwayomi-compatibility.json"),
    "utf8",
  ));
  const candidate = manifest.allowedVersions.find((entry) => entry.version === "v2.3.2243");
  assert.equal(manifest.maxTestedVersion, "v2.3.2243");
  assert.deepEqual(candidate, {
    version: "v2.3.2243",
    asset: "Suwayomi-Server-v2.3.2243.jar",
    sha256: "821141b32e170d4a02d3cbdfed577ed8f07bd22383ff5f4132ebb5ae40e98dd5",
    notes: "Certified on Windows x64 with Java 21, disposable H2 migration, Extension Stores, installed extension canaries, restart, and rollback.",
  });
  assert.ok(manifest.blockedVersions.some((entry) => entry.version === "v2.2.2100"));
});
