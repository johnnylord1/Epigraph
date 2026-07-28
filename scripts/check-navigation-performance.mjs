import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Builder, Capabilities } from "selenium-webdriver";

const projectRoot = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.resolve(
  process.env.AETHON_NAVIGATION_OUTPUT_DIR
    || path.join(projectRoot, "docs", "screenshots", "marco70-bundle-performance"),
);
const iterations = 5;
const searchCycles = 20;
const budgets = JSON.parse(await fs.readFile(path.join(projectRoot, "config", "release-navigation-budgets.json"), "utf8"));

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((value) => value.startsWith("--")).map((value) => {
    const separator = value.indexOf("=");
    return [value.slice(2, separator < 0 ? undefined : separator), separator < 0 ? "true" : value.slice(separator + 1)];
  }));
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function gitOutput(args) {
  try {
    return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function createFakeCore() {
  const server = http.createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
    if (request.method === "OPTIONS") return response.writeHead(204).end();
    if (request.url?.includes("healthz")) return response.writeHead(200).end("ok");
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      data: {
        mangas: {
          nodes: [{
            id: 1,
            title: "Automation title",
            thumbnailUrl: "",
            realUrl: "",
            inLibrary: true,
            downloadCount: 0,
            unreadCount: 0,
            chapters: { totalCount: 0 },
            status: "ONGOING",
            genre: ["Automation"],
            sourceId: 1,
            source: { id: 1, name: "automation", lang: "en", displayName: "Automation" },
          }],
        },
        categories: {
          nodes: [{
            id: 1,
            name: "Automation",
            order: 0,
            default: true,
            includeInUpdate: "INCLUDE",
            includeInDownload: "INCLUDE",
          }],
        },
        downloads: { nodes: [] },
        trackers: { nodes: [] },
        chapters: { nodes: [] },
        extensions: { nodes: [] },
        sources: { nodes: [] },
      },
    }));
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

async function waitUntil(check, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function callAudit(driver, method, ...args) {
  const result = await driver.executeAsyncScript(function auditCall(name, values, done) {
    const bridge = window.__aethonAudit;
    if (!bridge || typeof bridge[name] !== "function") return done({ error: `Missing audit method ${name}` });
    Promise.resolve(bridge[name](...values))
      .then((value) => done({ value }))
      .catch((error) => done({ error: error instanceof Error ? error.message : String(error) }));
  }, method, args);
  if (result?.error) throw new Error(result.error);
  return result?.value;
}

async function waitForAuditBridge(driver) {
  await waitUntil(
    () => driver.executeScript("return Boolean(window.__aethonAudit)").catch(() => false),
    "Aethon audit bridge did not become ready.",
    120_000,
  );
}

async function waitForLibrary(driver) {
  try {
    await waitUntil(
      () => driver.executeScript(function libraryReady() {
        const activePanel = document.querySelector(".library-section-panel.is-active");
        return Boolean(document.querySelector(".library-hero"))
          && Boolean(activePanel?.querySelector(".content"))
          && !activePanel?.querySelector(".grid-skeleton")
          && !document.querySelector(".page-loading");
      }),
      "Library did not finish rendering.",
    );
  } catch (error) {
    const evidence = await driver.executeScript(function libraryFailureEvidence() {
      return {
        navPage: window.__aethonAudit?.getState?.().navPage ?? null,
        activePage: document.querySelector(".page-keepalive.is-active")?.textContent?.trim().slice(0, 180) ?? null,
        heroCount: document.querySelectorAll(".library-hero").length,
        skeletonCount: document.querySelectorAll(".grid-skeleton").length,
        loadingText: document.querySelector(".page-loading")?.textContent?.trim() ?? null,
        bodyText: document.body.innerText.slice(0, 300),
      };
    });
    throw new Error(`${error instanceof Error ? error.message : String(error)} Evidence: ${JSON.stringify(evidence)}`);
  }
}

async function switchLibrarySection(driver, index, expected) {
  const startedAt = Date.now();
  const clicked = await driver.executeScript(function clickSection(targetIndex) {
    const buttons = [...document.querySelectorAll(".section-tabs .section-tab")];
    const target = buttons[targetIndex];
    if (!(target instanceof HTMLButtonElement)) return false;
    target.click();
    return true;
  }, index);
  assert.equal(clicked, true, `Missing ${expected} library section button.`);
  await waitUntil(
    () => driver.executeScript(function sectionReady(section) {
      const activePanel = document.querySelector(".library-section-panel.is-active");
      return document.querySelector(".section-tabs")?.getAttribute("data-active") === section
        && Boolean(activePanel?.querySelector(".content"))
        && !activePanel?.querySelector(".grid-skeleton");
    }, expected),
    `${expected} library section did not become active.`,
  );
  await driver.executeAsyncScript(function afterPaint(done) {
    requestAnimationFrame(() => requestAnimationFrame(done));
  });
  return Date.now() - startedAt;
}

async function collectViewportEvidence(driver) {
  return driver.executeScript(function viewportEvidence() {
    const shell = document.querySelector(".aethon-app-shell")?.getBoundingClientRect();
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      shell: shell ? { x: shell.x, y: shell.y, width: shell.width, height: shell.height } : null,
      loadingVisible: Boolean(document.querySelector(".page-loading")),
    };
  });
}

async function verifySearchDim(driver) {
  const durations = [];
  let focusEvidence = null;
  for (let cycle = 0; cycle < searchCycles; cycle += 1) {
    const startedAt = Date.now();
    const focused = await driver.executeScript(function focusLibrarySearch() {
      const input = document.querySelector(".library-search .n-search__input");
      if (!(input instanceof HTMLInputElement)) return false;
      input.focus();
      return document.activeElement === input;
    });
    assert.equal(focused, true, `Search input was not focusable on cycle ${cycle + 1}.`);
    await waitUntil(
      () => driver.executeScript(function searchDimEngaged() {
        const dim = document.querySelector(".aethon-search-dim-layer");
        return document.body.classList.contains("aethon-search-engaged")
          && Number(dim ? getComputedStyle(dim).opacity : 0) >= 0.95;
      }),
      `Search dim did not engage on cycle ${cycle + 1}.`,
    );
    if (!focusEvidence) {
      focusEvidence = await driver.executeScript(function searchEvidence() {
        const dim = document.querySelector(".aethon-search-dim-layer");
        const search = document.querySelector(".library-search");
        const input = document.querySelector(".library-search .n-search__input");
        const dimStyle = dim ? getComputedStyle(dim) : null;
        const searchStyle = search ? getComputedStyle(search) : null;
        const inputStyle = input ? getComputedStyle(input) : null;
        return {
          dimOpacity: Number(dimStyle?.opacity ?? 0),
          dimZIndex: Number(dimStyle?.zIndex ?? 0),
          searchZIndex: Number(searchStyle?.zIndex ?? 0),
          inputBackground: inputStyle?.backgroundColor ?? null,
          inputColor: inputStyle?.color ?? null,
        };
      });
    }
    await driver.executeScript("document.querySelector('.library-search .n-search__input')?.blur()");
    await waitUntil(
      () => driver.executeScript(function dimCleared() {
        const dim = document.querySelector(".aethon-search-dim-layer");
        return !document.body.classList.contains("aethon-search-engaged")
          && Number(dim ? getComputedStyle(dim).opacity : 0) === 0;
      }),
      `Search dim remained after blur on cycle ${cycle + 1}.`,
    );
    durations.push(Date.now() - startedAt);
  }
  assert(focusEvidence && focusEvidence.dimOpacity > 0, "Search dim remained transparent while engaged.");
  assert(focusEvidence.searchZIndex > focusEvidence.dimZIndex, "Search control was not above the dim layer.");
  return { durations, focusEvidence };
}

function transformScaleX(transform) {
  if (!transform || transform === "none") return 1;
  const match = /^matrix\(([^,]+)/.exec(transform);
  return match ? Number(match[1]) : Number.NaN;
}

async function verifyToastAnimation(driver) {
  await callAudit(driver, "showPerformanceToast");
  await waitUntil(
    () => driver.executeScript("return Boolean(document.querySelector('.toast-life'))"),
    "Performance toast did not render.",
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    await waitUntil(
      () => driver.executeScript(function toastVisible() {
        const toast = document.querySelector(".toast:not(.toast-persistent)");
        const rect = toast?.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0 && Number(getComputedStyle(toast).opacity) >= 0.95);
      }),
      "Performance toast remained visually hidden.",
      1_500,
    );
  } catch (error) {
    const evidence = await driver.executeScript(function hiddenToastEvidence() {
      const toast = document.querySelector(".toast:not(.toast-persistent)");
      const style = toast ? getComputedStyle(toast) : null;
      const rect = toast?.getBoundingClientRect();
      return {
        exists: Boolean(toast),
        opacity: style?.opacity ?? null,
        animationName: style?.animationName ?? null,
        playState: style?.animationPlayState ?? null,
        rect: rect ? { width: rect.width, height: rect.height } : null,
      };
    });
    throw new Error(`${error instanceof Error ? error.message : String(error)} Evidence: ${JSON.stringify(evidence)}`);
  }
  const first = await driver.executeScript(function toastEvidence() {
    const bar = document.querySelector(".toast-life");
    const style = bar ? getComputedStyle(bar) : null;
    return { transform: style?.transform ?? null, animationName: style?.animationName ?? null, playState: style?.animationPlayState ?? null };
  });
  await new Promise((resolve) => setTimeout(resolve, 650));
  const second = await driver.executeScript(function toastEvidence() {
    const bar = document.querySelector(".toast-life");
    const style = bar ? getComputedStyle(bar) : null;
    return { transform: style?.transform ?? null, animationName: style?.animationName ?? null, playState: style?.animationPlayState ?? null };
  });
  assert(first.animationName?.endsWith("toastLife"), "Toast lifetime animation was not applied.");
  assert.equal(first.playState, "running", "Toast lifetime animation was paused.");
  assert.equal(second.playState, "running", "Toast lifetime animation stopped early.");
  assert(transformScaleX(second.transform) < transformScaleX(first.transform), "Toast lifetime bar did not advance.");
  return { first, second };
}

async function createSession(driverUrl, appPath, fakeCoreUrl, profileRoot) {
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", {
    application: appPath,
    args: [
      "--webdriver-automation",
      `--local-app-data-dir=${profileRoot}`,
      `--server-url=${fakeCoreUrl}`,
      "--profile-label=MAIN",
    ],
    webviewOptions: {
      userDataFolder: path.join(profileRoot, "WebView2Automation"),
      additionalBrowserArguments: ["--remote-debugging-port=0"],
    },
  });
  return new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appPath = path.resolve(args.app || path.join(projectRoot, "src-tauri", "target", "release", "aethon.exe"));
  const driverUrl = args["driver-url"];
  assert(driverUrl, "--driver-url is required.");
  await fs.access(appPath);
  const buildIdentity = {
    app: path.relative(projectRoot, appPath).replaceAll("\\", "/"),
    sha256: await sha256File(appPath),
    commit: gitOutput(["rev-parse", "HEAD"]),
    dirty: Boolean(gitOutput(["status", "--porcelain"])),
  };
  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(outputDirectory, { recursive: true });

  const fakeCore = await createFakeCore();
  const startupDurations = [];
  const librarySectionDurations = [];
  let searchReport = null;
  let toastReport = null;
  let viewportBefore = null;
  let viewportAfter = null;

  try {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), `aethon-navigation-${Date.now()}-${iteration}-`));
      let driver;
      try {
        const startupStartedAt = Date.now();
        driver = await createSession(driverUrl, appPath, fakeCore.url, profileRoot);
        await driver.manage().setTimeouts({ implicit: 0, pageLoad: 120_000, script: 120_000 });
        await waitForAuditBridge(driver);
        await waitUntil(async () => {
          const state = await callAudit(driver, "getState");
          return Boolean(state?.profileId && state?.serverUrl);
        }, "Aethon launch target did not become ready.", 120_000);
        await callAudit(driver, "bypassStartupSplash");
        await waitUntil(async () => {
          const state = await callAudit(driver, "getState");
          const shellRendered = await driver.executeScript("return Boolean(document.querySelector('#app-shell .n-sidebar')) && !document.querySelector('.page-loading')");
          return state?.shellReady === true && shellRendered;
        }, "Aethon shell did not become ready.", 120_000);
        startupDurations.push(Date.now() - startupStartedAt);
        await callAudit(driver, "prepareLibrary");
        await callAudit(driver, "openLibrary");
        await waitForLibrary(driver);
        viewportBefore ??= await collectViewportEvidence(driver);

        librarySectionDurations.push(await switchLibrarySection(driver, 1, "books"));
        await waitForLibrary(driver);
        librarySectionDurations.push(await switchLibrarySection(driver, 0, "comics"));
        await waitForLibrary(driver);

        if (iteration === 0) {
          const imageComics = await driver.takeScreenshot();
          await fs.writeFile(path.join(outputDirectory, "library-comics.png"), imageComics, "base64");
          await switchLibrarySection(driver, 1, "books");
          await waitForLibrary(driver);
          await new Promise((resolve) => setTimeout(resolve, 300));
          const imageBooks = await driver.takeScreenshot();
          await fs.writeFile(path.join(outputDirectory, "library-books.png"), imageBooks, "base64");

          await driver.executeScript("document.querySelector('[data-nav-id=\"home\"]')?.click()");
          await waitUntil(() => driver.executeScript("return Boolean(document.querySelector('.home-dashboard, .home-history-view'))"), "Home did not render.");
          await callAudit(driver, "openLibrary");
          await waitForLibrary(driver);
          searchReport = await verifySearchDim(driver);
          await driver.executeScript("document.querySelector('.library-search .n-search__input')?.focus()");
          await waitUntil(() => driver.executeScript(function searchDimEngaged() {
            const dim = document.querySelector(".aethon-search-dim-layer");
            return document.body.classList.contains("aethon-search-engaged")
              && Number(dim ? getComputedStyle(dim).opacity : 0) >= 0.95;
          }), "Search did not re-engage for screenshot.");
          const imageSearch = await driver.takeScreenshot();
          await fs.writeFile(path.join(outputDirectory, "search-dim-focused.png"), imageSearch, "base64");
          await driver.executeScript("document.querySelector('.library-search .n-search__input')?.blur()");

          await waitUntil(
            () => driver.executeScript("return document.querySelector('#app-shell')?.classList.contains('aethon-motion-idle')"),
            "Aethon did not enter motion-idle state.",
            10_000,
          );
          toastReport = await verifyToastAnimation(driver);
          const imageToast = await driver.takeScreenshot();
          await fs.writeFile(path.join(outputDirectory, "toast-loading-bar.png"), imageToast, "base64");
        }
        viewportAfter = await collectViewportEvidence(driver);
      } finally {
        await driver?.quit().catch(() => {});
        await fs.rm(profileRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
  } finally {
    await fakeCore.close().catch(() => {});
  }

  assert.equal(viewportAfter?.loadingVisible, false, "A lazy-loading placeholder remained visible.");
  assert((viewportAfter?.scrollWidth ?? 0) <= (viewportAfter?.width ?? 0) + 1, "Lazy loading introduced horizontal overflow.");
  for (const key of ["x", "y", "width", "height"]) {
    assert(Math.abs((viewportAfter?.shell?.[key] ?? 0) - (viewportBefore?.shell?.[key] ?? 0)) <= 1, `Shell ${key} shifted during lazy navigation.`);
  }
  const measuredMedians = {
    startupMedianMs: median(startupDurations),
    librarySectionMedianMs: median(librarySectionDurations),
    searchCycleMedianMs: median(searchReport?.durations ?? []),
  };
  const budgetChecks = Object.fromEntries(Object.entries(measuredMedians).map(([key, actualMs]) => {
    const baselineMs = budgets.baseline[key];
    const maxMs = baselineMs * (1 + budgets.maxMedianRegressionPercent / 100);
    return [key, { actualMs, baselineMs, maxMs: Number(maxMs.toFixed(2)), passed: actualMs <= maxMs }];
  }));
  const failures = Object.entries(budgetChecks)
    .filter(([, check]) => !check.passed)
    .map(([key, check]) => `${key} ${check.actualMs}ms > ${check.maxMs}ms`);
  const report = {
    version: 1,
    environment: "Tauri v2 / WebView2 / disposable profile / fake local Core",
    build: buildIdentity,
    visualLimitations: [
      "The timing baseline was established after the Marco 70 implementation and is intended to block future regressions; earlier releases did not expose equivalent native timing telemetry.",
    ],
    iterations,
    startup: { samplesMs: startupDurations, medianMs: measuredMedians.startupMedianMs },
    librarySection: { samplesMs: librarySectionDurations, medianMs: measuredMedians.librarySectionMedianMs },
    search: {
      cycles: searchCycles,
      samplesMs: searchReport?.durations ?? [],
      medianMs: measuredMedians.searchCycleMedianMs,
      focusEvidence: searchReport?.focusEvidence ?? null,
      residualDim: false,
    },
    toast: toastReport,
    viewport: { before: viewportBefore, after: viewportAfter },
    budgets: { ...budgets, checks: budgetChecks, failures },
  };
  await fs.writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  assert.deepEqual(failures, [], `Navigation performance budgets failed: ${failures.join(", ")}`);
  process.stdout.write(`${JSON.stringify({ ok: true, outputDirectory, ...report }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
