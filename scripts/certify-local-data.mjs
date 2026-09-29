import { verifyJourney, cleanupAttempt, recordJourneyFailure } from './verification-evidence.mjs';
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Builder, Capabilities } from "selenium-webdriver";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const DEFAULT_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const values = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const separator = raw.indexOf("=");
    values[raw.slice(2, separator < 0 ? undefined : separator)] = separator < 0 ? "true" : raw.slice(separator + 1);
  }
  return values;
}

function normalizeBookState(value) {
  const state = value?.state ?? value;
  return {
    books: [...(state?.books ?? [])].map((book) => ({
      id: book.id,
      title: book.title,
      subtype: book.subtype,
      assetFingerprint: book.assetFingerprint ?? null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    progress: [...(state?.bookProgress ?? [])].map((entry) => ({
      bookId: entry.bookId,
      progressPercent: entry.progressPercent,
    })).sort((left, right) => left.bookId.localeCompare(right.bookId)),
    bookmarks: [...(state?.bookBookmarks ?? [])].map((entry) => ({
      bookId: entry.bookId,
      label: entry.label,
      progressPercent: entry.progressPercent,
    })).sort((left, right) => left.bookId.localeCompare(right.bookId)),
    categories: [...(state?.booksCategories ?? [])].map((entry) => ({ id: entry.id, name: entry.name })),
    assignments: state?.booksCategoryAssignments ?? {},
  };
}

async function waitFor(check, message, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${message}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function createFakeCore() {
  const server = http.createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.url?.includes("healthz")) {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    const data = {
      mangas: { nodes: [] },
      categories: { nodes: [] },
      downloads: { nodes: [] },
      trackers: { nodes: [] },
      chapters: { nodes: [] },
      extensions: { nodes: [] },
    };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function emitFixtures(directory) {
  const env = { ...process.env, EPIGRAPH_BOOKS_PHASE2B_OUTPUT_DIR: directory };
  await execFileAsync(process.execPath, [
    path.join(projectRoot, "node_modules", "vitest", "vitest.mjs"),
    "run", "--project", "unit", "src/lib/backup/booksBackup.test.ts",
    "src/lib/reader/offlineManga.release.test.ts", "--maxWorkers=1", "--minWorkers=1", "--reporter=basic",
  ], { cwd: projectRoot, env, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
}

async function callAudit(driver, method, ...args) {
  const result = await driver.executeAsyncScript(function auditCall(name, values, done) {
    const bridge = window.__epigraphAudit;
    if (!bridge || typeof bridge[name] !== "function") {
      done({ error: `Audit method ${name} is unavailable.` });
      return;
    }
    Promise.resolve(bridge[name](...values))
      .then((value) => done({ value }))
      .catch((error) => done({ error: error instanceof Error ? error.message : String(error) }));
  }, method, args);
  if (result?.error) throw new Error(result.error);
  return result?.value;
}

async function waitForAuditSurface(driver, predicate, selector, message) {
  return waitFor(async () => {
    const state = await callAudit(driver, "getState");
    const surfaceReady = await driver.executeScript(
      "return Boolean(document.querySelector(arguments[0]))",
      selector,
    );
    return predicate(state) && surfaceReady;
  }, message);
}

async function waitForStableBookState(driver) {
  const notBefore = Date.now() + 1_500;
  let previous = null;
  let stablePolls = 0;
  return waitFor(async () => {
    const state = normalizeBookState(await callAudit(driver, "readBookLibraryPersistence"));
    const serialized = JSON.stringify(state);
    stablePolls = serialized === previous ? stablePolls + 1 : 0;
    previous = serialized;
    return Date.now() >= notBefore && stablePolls >= 2 ? state : null;
  }, "Book persistence did not stabilize after opening the readers");
}

async function launchDesktop({ appPath, driverUrl, profileRoot, serverUrl, name }) {
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", {
    application: appPath,
    args: [
      "--webdriver-automation",
      `--local-app-data-dir=${profileRoot}`,
      `--server-url=${serverUrl}`,
      "--profile-label=TEST",
      "--audit-open=books",
    ],
    webviewOptions: {
      userDataFolder: path.join(profileRoot, "WebView2Automation", name),
      additionalBrowserArguments: ["--remote-debugging-port=0"],
    },
  });
  const driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  const windowX = Number(process.env.EPIGRAPH_WEBDRIVER_WINDOW_X);
  const windowY = Number(process.env.EPIGRAPH_WEBDRIVER_WINDOW_Y);
  const windowWidth = Number(process.env.EPIGRAPH_WEBDRIVER_WINDOW_WIDTH || 1280);
  const windowHeight = Number(process.env.EPIGRAPH_WEBDRIVER_WINDOW_HEIGHT || 800);
  if ([windowX, windowY, windowWidth, windowHeight].every(Number.isFinite)) {
    await driver.manage().window().setRect({
      x: windowX,
      y: windowY,
      width: windowWidth,
      height: windowHeight,
    });
  }
  await driver.manage().setTimeouts({ implicit: 0, pageLoad: DEFAULT_TIMEOUT_MS, script: DEFAULT_TIMEOUT_MS });
  await waitFor(
    () => driver.executeScript("return Boolean(window.__epigraphAudit)"),
    `Audit bridge did not become ready for ${name}`,
  );
  await callAudit(driver, "bypassFirstRun");
  await callAudit(driver, "bypassStartupSplash");
  await callAudit(driver, "openBooksLibrary");
  return driver;
}

async function closeDriver(driver) {
  if (!driver) return;
  await driver.quit();
}

async function removeWithRetries(target) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (attempt === 12) {
        process.stderr.write(`Cleanup deferred for ${path.basename(target)}: ${error instanceof Error ? error.message : String(error)}\n`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return false;
}

async function main(evidence) {
  const args = parseArgs(process.argv.slice(2));
  const runId = `release-data-${Date.now()}-${process.pid}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${runId}-`));
  const fixtures = path.join(root, "fixtures");
  const profileA = path.join(root, "profile-a");
  const profileB = path.join(root, "profile-b");
  const backupPath = path.join(root, "books-release.epigraphbk");
  const corruptedPath = path.join(root, "books-release-corrupted.epigraphbk");
  const appPath = path.resolve(args.app || path.join(projectRoot, "src-tauri", "target", "release", "epigraph.exe"));
  const driverUrl = args["driver-url"] || "http://127.0.0.1:4554";
  const keepArtifacts = args["keep-artifacts"] === "true";
  let fakeCore;
  let driver;

  try {
    await fs.mkdir(fixtures, { recursive: true });
    await emitFixtures(fixtures);
    fakeCore = await createFakeCore();

    driver = await launchDesktop({ appPath, driverUrl, profileRoot: profileA, serverUrl: fakeCore.url, name: "profile-a-import" });
    const epub = await callAudit(driver, "importBookFromPath", path.join(fixtures, "books-roundtrip-source-epub.epub"));
    const pdf = await callAudit(driver, "importBookFromPath", path.join(fixtures, "books-roundtrip-source-pdf.pdf"));
    assert.equal(epub.subtype, "epub");
    assert.equal(pdf.subtype, "pdf");
    await callAudit(driver, "setBookReadingState", { bookId: epub.id, progressPercent: 0.42, bookmarkLabel: "EPUB release bookmark" });
    await callAudit(driver, "setBookReadingState", { bookId: pdf.id, progressPercent: 0.5, bookmarkLabel: "PDF release bookmark" });

    await callAudit(driver, "openFirstBook", epub.id);
    await waitForAuditSurface(
      driver,
      (state) => state.activeBookId === epub.id && state.activeBookReaderId === null,
      ".series-v3-root",
      "EPUB Book Detail did not render",
    );
    await driver.takeScreenshot().then((image) => fs.writeFile(path.join(root, "profile-a-epub-detail.png"), image, "base64"));

    await callAudit(driver, "openFirstBookReader", epub.id);
    await waitForAuditSurface(
      driver,
      (state) => state.activeBookReaderId === epub.id,
      ".book-viewer .epub-host",
      "EPUB Reader did not render",
    );
    await driver.takeScreenshot().then((image) => fs.writeFile(path.join(root, "profile-a-epub-reader.png"), image, "base64"));

    await callAudit(driver, "openFirstBookReader", pdf.id);
    await waitForAuditSurface(
      driver,
      (state) => state.activeBookReaderId === pdf.id,
      ".book-viewer.pdf canvas",
      "PDF Reader did not render",
    );
    await driver.takeScreenshot().then((image) => fs.writeFile(path.join(root, "profile-a-pdf-reader.png"), image, "base64"));

    const stateA = await waitForStableBookState(driver);
    assert.equal(stateA.books.length, 2);
    assert.equal(stateA.progress.length, 2);
    assert.equal(stateA.bookmarks.length, 2);
    assert(stateA.categories.some((entry) => entry.name === "Audit Shelf"));
    const exported = await callAudit(driver, "exportBooksBackupToPath", backupPath);
    assert.equal(exported.bookCount, 2);
    assert.match(exported.sha256, /^[a-f0-9]{64}$/);
    await driver.takeScreenshot().then((image) => fs.writeFile(path.join(root, "profile-a-books.png"), image, "base64"));
    await closeDriver(driver);
    driver = null;

    driver = await launchDesktop({ appPath, driverUrl, profileRoot: profileA, serverUrl: fakeCore.url, name: "profile-a-restart" });
    assert.deepEqual(normalizeBookState(await callAudit(driver, "readBookLibraryPersistence")), stateA);
    await closeDriver(driver);
    driver = null;

    driver = await launchDesktop({ appPath, driverUrl, profileRoot: profileB, serverUrl: fakeCore.url, name: "profile-b-restore" });
    const restored = await callAudit(driver, "restoreBooksBackupFromPath", backupPath);
    assert.equal(restored.issueCount, 0);
    const stateB = normalizeBookState(await callAudit(driver, "readBookLibraryPersistence"));
    assert.deepEqual(stateB, stateA);

    const corrupted = await fs.readFile(backupPath);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    await fs.writeFile(corruptedPath, corrupted);
    await assert.rejects(() => callAudit(driver, "restoreBooksBackupFromPath", corruptedPath));
    assert.deepEqual(normalizeBookState(await callAudit(driver, "readBookLibraryPersistence")), stateB);
    await driver.takeScreenshot().then((image) => fs.writeFile(path.join(root, "profile-b-restored.png"), image, "base64"));

    evidence.diagnostic("completed books assertions", { subtypes: stateB.books.map(entry => entry.subtype), progressCount: stateB.progress.length, bookmarkCount: stateB.bookmarks.length, corruptedRestoreRejected: true });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      books: stateB.books.map((entry) => entry.subtype),
      progressCount: stateB.progress.length,
      bookmarkCount: stateB.bookmarks.length,
      corruptedRestoreRejected: true,
    }, null, 2)}\n`);
  } catch (error) {
    recordJourneyFailure(evidence, error);
    throw error;
  } finally {
    await cleanupAttempt(evidence, "WebDriver session", async () => { await driver?.quit(); });
    await cleanupAttempt(evidence, "mock Core", async () => { await fakeCore?.close(); });
    if (!keepArtifacts) await cleanupAttempt(evidence, "disposable profile", async () => { if (!await removeWithRetries(root)) throw new Error("Disposable profile cleanup deferred"); });
    else process.stdout.write(`Artifacts retained at ${root}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyJourney("certify-local-data.mjs", ["Books EPUB/PDF import, local persistence, restart, backup export/restore and corrupted backup rejection; mock Core; first-run bypassed"], main).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { normalizeBookState };
