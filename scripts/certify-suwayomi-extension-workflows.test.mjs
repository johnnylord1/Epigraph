import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
  defaultBaselineJar,
  ensurePinnedFile,
  findGeneratedCanaryJar,
  startFixtureStoreServer,
  summarizeDeterministicWorkflow,
} from "./certify-suwayomi-extension-workflows.mjs";
import * as workflowCertification from "./certify-suwayomi-extension-workflows.mjs";

test("ignores a managed baseline whose checksum does not match the pinned policy", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "epigraph-baseline-selection-test-"));
  const baseline = path.join(root, "epigraph", "binaries", "suwayomi-bundle", "bin", "Suwayomi-Server.jar");
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousExplicitBaseline = process.env.EPIGRAPH_SUWAYOMI_BASELINE_JAR;
  try {
    await mkdir(path.dirname(baseline), { recursive: true });
    await writeFile(baseline, "not-the-pinned-baseline");
    process.env.LOCALAPPDATA = root;
    delete process.env.EPIGRAPH_SUWAYOMI_BASELINE_JAR;
    assert.equal(await defaultBaselineJar(), null);
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    if (previousExplicitBaseline === undefined) delete process.env.EPIGRAPH_SUWAYOMI_BASELINE_JAR;
    else process.env.EPIGRAPH_SUWAYOMI_BASELINE_JAR = previousExplicitBaseline;
    await rm(root, { recursive: true, force: true });
  }
});

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
  const root = await mkdtemp(path.join(tmpdir(), "epigraph-local-source-test-"));
  try {
    await createLocalSourceFixture(root);
    const details = JSON.parse(await readFile(path.join(root, "local", "Epigraph Certification", "details.json"), "utf8"));
    assert.equal(details.title, "Epigraph Certification");
    assert.equal(details.author, "Epigraph");
    assert.ok((await readFile(path.join(root, "local", "Epigraph Certification", "Chapter 01", "page01.png"))).length > 0);
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
    search: { fetchSourceManga: { mangas: [{ id: 10, title: "Epigraph Certification" }] } },
    details: { fetchManga: { manga: { id: 10, title: "Epigraph Certification", author: "Epigraph" } } },
    chapters: { fetchChapters: { chapters: [{ id: 20, mangaId: 10 }] } },
    pages: { fetchChapterPages: { pages: ["http://127.0.0.1/page"] } },
  });
  assert.deepEqual(summary.extension.sourceIds, ["7"]);
  assert.equal(summary.pageCount, 1);
});

test("compares restart workflow semantics without transient local database ids", () => {
  const snapshot = (mangaId, chapterId) => summarizeDeterministicWorkflow({
    inventory: {
      extensions: { nodes: [{ pkgName: STRUCTURAL_CANARY.packageName, versionCodeLong: 7, isInstalled: true }] },
      sources: { nodes: [
        { id: "0", name: "Local", extension: null },
        { id: "7", name: "Akuma", extension: { pkgName: STRUCTURAL_CANARY.packageName } },
      ] },
    },
    search: { fetchSourceManga: { mangas: [{ id: mangaId, title: "Epigraph Certification" }] } },
    details: { fetchManga: { manga: { id: mangaId, title: "Epigraph Certification", author: "Epigraph" } } },
    chapters: { fetchChapters: { chapters: [{ id: chapterId, mangaId, name: "Chapter 01", sourceOrder: 1, pageCount: 1 }] } },
    pages: { fetchChapterPages: { pages: ["http://127.0.0.1/page"] } },
  });

  assert.deepEqual(snapshot(10, 20), snapshot(42, 84));
});

test("waits for restart workflow indexing to converge on the candidate identity", async () => {
  assert.equal(typeof workflowCertification.waitForMatchingWorkflow, "function");
  if (typeof workflowCertification.waitForMatchingWorkflow !== "function") return;

  const expected = { localChapter: { pageCount: -1 }, pageCount: 1 };
  const observations = [
    { localChapter: { pageCount: 1 }, pageCount: 1 },
    expected,
  ];
  let attempts = 0;
  const actual = await workflowCertification.waitForMatchingWorkflow(
    expected,
    async () => observations[Math.min(attempts++, observations.length - 1)],
    { attempts: 3, intervalMs: 0 },
  );

  assert.deepEqual(actual, expected);
  assert.equal(attempts, 2);
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
  const root = await mkdtemp(path.join(tmpdir(), "epigraph-extension-store-test-"));
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

test("reuses only checksum-valid artifacts from a bounded harness cache", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "epigraph-artifact-cache-test-"));
  const cacheRoot = path.join(root, "cache");
  const artifact = Buffer.from("checksum-pinned fixture");
  const descriptor = {
    fileName: "fixture.jar",
    sha256: createHash("sha256").update(artifact).digest("hex"),
  };
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/java-archive" });
    response.end(artifact);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  descriptor.url = `http://127.0.0.1:${address.port}/fixture.jar`;
  const previousCache = process.env.EPIGRAPH_SUWAYOMI_ARTIFACT_CACHE;
  process.env.EPIGRAPH_SUWAYOMI_ARTIFACT_CACHE = cacheRoot;
  try {
    await mkdir(cacheRoot, { recursive: true });
    for (let index = 0; index < 10; index += 1) {
      await writeFile(path.join(cacheRoot, `shared-file-${index}.bin`), `external-${index}`);
    }
    const first = await ensurePinnedFile(null, root, descriptor);
    const second = await ensurePinnedFile(null, root, descriptor);
    assert.equal(first, second);
    assert.equal(requests, 1);
    assert.deepEqual(await readFile(second), artifact);

    await writeFile(second, "corrupt");
    const repaired = await ensurePinnedFile(null, root, descriptor);
    assert.equal(requests, 2);
    assert.deepEqual(await readFile(repaired), artifact);
    const remaining = await readdir(cacheRoot);
    assert.equal(remaining.filter((name) => name.startsWith("shared-file-")).length, 10);
  } finally {
    if (previousCache === undefined) delete process.env.EPIGRAPH_SUWAYOMI_ARTIFACT_CACHE;
    else process.env.EPIGRAPH_SUWAYOMI_ARTIFACT_CACHE = previousCache;
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts Suwayomi-generated JAR names after GraphQL identity was verified", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "epigraph-generated-jar-test-"));
  const extensions = path.join(root, "extensions");
  const bytes = Buffer.from("generated extension");
  try {
    await mkdir(extensions, { recursive: true });
    await writeFile(path.join(extensions, "generated-extension.jar"), bytes);
    const result = await findGeneratedCanaryJar(root);
    assert.equal(path.basename(result.path), "generated-extension.jar");
    assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
