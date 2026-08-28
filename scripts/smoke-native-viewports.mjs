import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Builder, Capabilities } from "selenium-webdriver";

const projectRoot = path.resolve(import.meta.dirname, "..");
const viewports = [
  { width: 1280, height: 800 },
  { width: 800, height: 600 },
];

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((value) => value.startsWith("--")).map((value) => {
    const separator = value.indexOf("=");
    return [value.slice(2, separator < 0 ? undefined : separator), separator < 0 ? "true" : value.slice(separator + 1)];
  }));
}

async function createFakeCore() {
  const server = http.createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
    if (request.method === "OPTIONS") return response.writeHead(204).end();
    if (request.url?.includes("healthz")) return response.writeHead(200).end("ok");
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      data: {
        mangas: { nodes: [] },
        categories: { nodes: [] },
        downloads: { nodes: [] },
        trackers: { nodes: [] },
        chapters: { nodes: [] },
        extensions: { nodes: [] },
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

async function callAudit(driver, method, ...args) {
  const result = await driver.executeAsyncScript(function auditCall(name, values, done) {
    const bridge = window.__epigraphAudit;
    if (!bridge || typeof bridge[name] !== "function") return done({ error: `Missing audit method ${name}` });
    Promise.resolve(bridge[name](...values))
      .then((value) => done({ value }))
      .catch((error) => done({ error: error instanceof Error ? error.message : String(error) }));
  }, method, args);
  if (result?.error) throw new Error(result.error);
  return result?.value;
}

async function waitForAuditBridge(driver) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await driver.executeScript("return Boolean(window.__epigraphAudit)").catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Epigraph audit bridge did not become ready.");
}

async function waitForSurface(driver, selector, name, blockedSelector = null) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = await driver.executeScript(
      "return Boolean(document.querySelector(arguments[0])) && (!arguments[1] || !document.querySelector(arguments[1]))",
      selector,
      blockedSelector,
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${name} did not finish rendering.`);
}

async function assertViewport(driver, surface, viewport) {
  await driver.actions().sendKeys("\uE004").perform();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const evidence = await driver.executeScript(function collectEvidence() {
    const active = document.activeElement;
    const activeRect = active instanceof HTMLElement ? active.getBoundingClientRect() : null;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      activeTag: active?.tagName ?? null,
      activeVisible: Boolean(activeRect && activeRect.width > 0 && activeRect.height > 0),
    };
  });
  assert(evidence.innerWidth <= viewport.width && evidence.innerWidth >= viewport.width - 40, `${surface}: unexpected native width ${evidence.innerWidth}`);
  assert(evidence.innerHeight <= viewport.height && evidence.innerHeight >= viewport.height - 80, `${surface}: unexpected native height ${evidence.innerHeight}`);
  assert(evidence.scrollWidth <= evidence.innerWidth + 1, `${surface}: horizontal clipping ${evidence.scrollWidth}/${evidence.innerWidth}`);
  assert.notEqual(evidence.activeTag, "BODY", `${surface}: Tab did not reach an interactive control`);
  assert.equal(evidence.activeVisible, true, `${surface}: focused control is not visible`);
  return evidence;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appPath = path.resolve(args.app || path.join(projectRoot, "src-tauri", "target", "release", "epigraph.exe"));
  const outputDirectory = path.resolve(args.out || path.join(projectRoot, "docs", "screenshots", "marco67-native-viewports"));
  const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), `epigraph-native-viewport-${Date.now()}-`));
  const fakeCore = await createFakeCore();
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", {
    application: appPath,
    args: [
      "--webdriver-automation",
      `--local-app-data-dir=${profileRoot}`,
      `--server-url=${fakeCore.url}`,
      "--profile-label=TEST",
    ],
    webviewOptions: {
      userDataFolder: path.join(profileRoot, "WebView2Automation"),
      additionalBrowserArguments: ["--remote-debugging-port=0"],
    },
  });

  let driver;
  try {
    await fs.mkdir(outputDirectory, { recursive: true });
    driver = await new Builder().usingServer(args["driver-url"]).withCapabilities(capabilities).build();
    const windowX = Number(process.env.EPIGRAPH_WEBDRIVER_WINDOW_X);
    const windowY = Number(process.env.EPIGRAPH_WEBDRIVER_WINDOW_Y);
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 120_000, script: 120_000 });
    await waitForAuditBridge(driver);
    await callAudit(driver, "bypassStartupSplash");

    const surfaces = [
      { name: "home", selector: ".home-dashboard, .home-history-view", open: () => driver.executeScript("document.querySelector('.n-sidebar__nav button')?.click()") },
      { name: "library", selector: ".library-hero", blockedSelector: ".grid-skeleton", open: () => callAudit(driver, "openLibrary") },
      { name: "settings", selector: ".settings-page", open: () => callAudit(driver, "openSettings") },
    ];
    const report = [];
    for (const viewport of viewports) {
      await driver.manage().window().setRect({
        width: viewport.width,
        height: viewport.height,
        x: Number.isFinite(windowX) ? windowX : 0,
        y: Number.isFinite(windowY) ? windowY : 0,
      });
      for (const surface of surfaces) {
        await surface.open();
        await waitForSurface(driver, surface.selector, surface.name, surface.blockedSelector);
        await new Promise((resolve) => setTimeout(resolve, 250));
        report.push({ surface: surface.name, viewport, ...(await assertViewport(driver, surface.name, viewport)) });
        const image = await driver.takeScreenshot();
        await fs.writeFile(path.join(outputDirectory, `${surface.name}-${viewport.width}x${viewport.height}.png`), image, "base64");
      }
    }
    await fs.writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, checks: report.length, outputDirectory }, null, 2)}\n`);
  } finally {
    await driver?.quit().catch(() => {});
    await fakeCore.close().catch(() => {});
    await fs.rm(profileRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
