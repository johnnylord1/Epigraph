import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
