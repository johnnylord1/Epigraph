import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DIRECT_INSTALL_CANARY,
  STRUCTURAL_CANARY,
  WORKFLOW_BASELINE,
  WORKFLOW_CANDIDATE,
  assertNoStructuralRuntimeErrors,
  createLocalSourceFixture,
  startFixtureStoreServer,
  summarizeDeterministicWorkflow,
} from "./certify-suwayomi-extension-workflows.mjs";

test("pins the exact runtime and structural extension canary", () => {
  assert.equal(WORKFLOW_BASELINE.version, "v2.1.1867");
  assert.match(WORKFLOW_BASELINE.sha256, /^[a-f0-9]{64}$/);
  assert.equal(WORKFLOW_CANDIDATE.version, "v2.3.2243");
  assert.match(WORKFLOW_CANDIDATE.sha256, /^[a-f0-9]{64}$/);
  assert.equal(STRUCTURAL_CANARY.packageName, "eu.kanade.tachiyomi.extension.all.akuma");
  assert.match(STRUCTURAL_CANARY.sha256, /^[a-f0-9]{64}$/);
  assert.equal(DIRECT_INSTALL_CANARY.versionCode, "10");
  assert.match(DIRECT_INSTALL_CANARY.sha256, /^[a-f0-9]{64}$/);
  assert.match(DIRECT_INSTALL_CANARY.url, new RegExp(DIRECT_INSTALL_CANARY.storeCommit));
  assert.match(DIRECT_INSTALL_CANARY.fileName, /\.jar$/);
});

test("rejects structural runtime and extension ABI errors", () => {
  assert.throws(() => assertNoStructuralRuntimeErrors(["java.lang.LinkageError: incompatible"]));
  assert.throws(() => assertNoStructuralRuntimeErrors(["Value cannot be cast to okhttp3.Interceptor"]));
  assert.throws(() => assertNoStructuralRuntimeErrors(["Object does not implement kotlin.jvm.functions.Function0"]));
  assert.doesNotThrow(() => assertNoStructuralRuntimeErrors(["HTTP 403 from an external source"]));
});

test("creates deterministic Local Source files without user data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aethon-local-source-test-"));
  try {
    await createLocalSourceFixture(root);
    const details = JSON.parse(await readFile(path.join(root, "local", "Aethon Certification", "details.json"), "utf8"));
    assert.equal(details.title, "Aethon Certification");
    assert.equal(details.author, "Aethon");
    assert.ok((await readFile(path.join(root, "local", "Aethon Certification", "Chapter 01", "page01.png"))).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires extension registration and the complete local content workflow", () => {
  const summary = summarizeDeterministicWorkflow({
    inventory: {
      extensions: { nodes: [{ pkgName: STRUCTURAL_CANARY.packageName, versionCodeLong: 7, isInstalled: true }] },
      sources: { nodes: [
        { id: "0", name: "Local", extension: null },
        { id: "7", name: "Akuma", extension: { pkgName: STRUCTURAL_CANARY.packageName } },
      ] },
    },
    search: { fetchSourceManga: { mangas: [{ id: 10, title: "Aethon Certification" }] } },
    details: { fetchManga: { manga: { id: 10, title: "Aethon Certification", author: "Aethon" } } },
    chapters: { fetchChapters: { chapters: [{ id: 20, mangaId: 10 }] } },
    pages: { fetchChapterPages: { pages: ["http://127.0.0.1/page"] } },
  });
  assert.deepEqual(summary.extension.sourceIds, ["7"]);
  assert.equal(summary.pageCount, 1);
});

test("keeps structural and content fixtures inside official Suwayomi mechanisms", async () => {
  const source = await readFile(
    new URL("./certify-suwayomi-extension-workflows.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /structuralFixtureProvider: "SUWAYOMI_EXTENSION_MANAGER"/);
  assert.match(source, /contentFixtureProvider: "SUWAYOMI_LOCAL_SOURCE"/);
  assert.doesNotMatch(source, /puppeteer|playwright|cheerio|htmlparser2/);
});

test("serves a deterministic V23 store and exact JAR from loopback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aethon-extension-store-test-"));
  const artifactPath = path.join(root, "fixture.jar");
  await writeFile(artifactPath, Buffer.from("fixture"));
  const store = await startFixtureStoreServer(artifactPath, DIRECT_INSTALL_CANARY);
  try {
    const index = await (await fetch(store.indexUrl)).json();
    const extension = index.extensionList.extensions[0];
    assert.equal(extension.packageName, DIRECT_INSTALL_CANARY.packageName);
    assert.equal(extension.resources.jarUrl, store.jarUrl);
    assert.equal(Buffer.from(await (await fetch(store.jarUrl)).arrayBuffer()).toString(), "fixture");
    assert.ok(store.indexUrl.startsWith("http://127.0.0.1:"));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
