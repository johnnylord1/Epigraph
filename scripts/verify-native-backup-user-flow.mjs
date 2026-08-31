import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Builder, By, Capabilities } from "selenium-webdriver";

function schemaField(name) {
  return { name, isDeprecated: false, args: [], type: { kind: "OBJECT", name: "String", ofType: null } };
}

function compatibleSchema() {
  const type = (name, fields) => ({ kind: "OBJECT", name, fields: fields.map(schemaField), inputFields: null, enumValues: null });
  const commonPreferences = ["key", "title", "summary", "enabled", "visible", "default", "currentValue"];
  return {
    queryType: { name: "Query" }, mutationType: { name: "Mutation" }, subscriptionType: null,
    types: [
      type("Query", ["aboutServer", "settings", "extensions", "sources", "source", "trackers"]),
      type("Mutation", ["fetchExtensions", "updateExtension", "fetchSourceManga", "fetchManga", "fetchChapters", "fetchChapterPages", "setSettings"]),
      type("ExtensionType", ["pkgName", "name", "lang", "versionName", "versionCode", "isInstalled", "isObsolete", "hasUpdate", "iconUrl", "repo", "apkName"]),
      type("SourceType", ["id", "name", "lang", "displayName", "iconUrl", "isNsfw", "supportsLatest", "isConfigurable", "extension", "preferences"]),
      type("CheckBoxPreference", commonPreferences),
      type("SwitchPreference", commonPreferences),
      type("ListPreference", [...commonPreferences, "entries", "entryValues"]),
      type("EditTextPreference", [...commonPreferences, "text", "dialogTitle", "dialogMessage"]),
      type("MultiSelectListPreference", [...commonPreferences, "entries", "entryValues", "values"]),
    ],
  };
}

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((value) => value.startsWith("--")).map((value) => {
    const separator = value.indexOf("=");
    return [value.slice(2, separator < 0 ? undefined : separator), separator < 0 ? "true" : value.slice(separator + 1)];
  }));
}

async function createFakeCore() {
  const server = http.createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
    if (request.method === "OPTIONS") return response.writeHead(204).end();
    if (request.url?.includes("healthz")) return response.writeHead(200).end("ok");
    let body = "";
    for await (const chunk of request) body += chunk;
    if (body.includes("__schema")) {
      return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { __schema: compatibleSchema() } }));
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      data: {
        mangas: { nodes: [] }, categories: { nodes: [] }, downloads: { nodes: [] },
        trackers: { nodes: [] }, chapters: { nodes: [] }, extensions: { nodes: [] },
        fetchExtensions: { extensions: [] },
        sources: { nodes: [] },
        settings: { extensionRepos: [], downloadsPath: "", localSourcePath: "" },
        aboutServer: { version: "v2.1.1867", revision: "test" },
      },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(4667, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function waitFor(driver, predicate, message, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(message);
}

async function callAudit(driver, method, ...args) {
  const result = await driver.executeAsyncScript(function auditCall(name, values, done) {
    const bridge = window.__epigraphAudit;
    if (!bridge || typeof bridge[name] !== "function") return done({ error: `Missing audit method ${name}` });
    Promise.resolve(bridge[name](...values)).then((value) => done({ value })).catch((error) => done({ error: String(error) }));
  }, method, args);
  if (result?.error) throw new Error(result.error);
  return result?.value;
}

async function clickText(driver, selector, text) {
  const clicked = await driver.executeScript(function clickMatching(css, expected) {
    const element = [...document.querySelectorAll(css)].find((candidate) => candidate.textContent?.trim() === expected);
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  }, selector, text);
  assert.equal(clicked, true, `Could not click ${text}`);
}

async function clickAnyText(driver, selector, texts) {
  const clicked = await driver.executeScript(function clickMatching(css, expected) {
    const element = [...document.querySelectorAll(css)].find((candidate) => {
      const actual = candidate.textContent?.trim() ?? "";
      return expected.some((label) => actual.includes(label));
    });
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  }, selector, texts);
  assert.equal(clicked, true, `Could not click any of: ${texts.join(", ")}`);
}

async function findFile(root, filename) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(resolved, filename);
      if (nested) return nested;
    } else if (entry.name === filename) {
      return resolved;
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backupPath = path.resolve(args.backup || process.env.EPIGRAPH_NATIVE_BACKUP || "");
  assert(backupPath && await fs.stat(backupPath).then((entry) => entry.isFile()).catch(() => false), "Pass --backup=<path> or EPIGRAPH_NATIVE_BACKUP.");
  const appPath = path.resolve(args.app);
  const profileRoot = process.env.EPIGRAPH_NATIVE_PROFILE_ROOT
    ? path.resolve(process.env.EPIGRAPH_NATIVE_PROFILE_ROOT)
    : await fs.mkdtemp(path.join(os.tmpdir(), "epigraph-backup-flow-"));
  await fs.mkdir(profileRoot, { recursive: true });
  const evidencePath = path.join(os.tmpdir(), `epigraph-backup-flow-${Date.now()}.png`);
  const automationAppData = path.join(profileRoot, "LocalAppData", "Epigraph");
  await fs.mkdir(automationAppData, { recursive: true });
  const fakeCore = await createFakeCore();
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", {
    application: appPath,
    args: ["--webdriver-automation", "--test", `--local-app-data-dir=${automationAppData}`],
    webviewOptions: { userDataFolder: path.join(profileRoot, "WebView2Automation") },
  });

  let driver;
  try {
    driver = await new Builder().usingServer(args["driver-url"]).withCapabilities(capabilities).build();
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 120_000, script: 120_000 });
    await waitFor(driver, () => driver.executeScript("return Boolean(window.__epigraphAudit)"), "Audit bridge did not become ready.");
    await callAudit(driver, "bypassStartupSplash");
    await callAudit(driver, "openSettings");
    await waitFor(driver, () => driver.executeScript("return Boolean(document.querySelector('.settings-page'))"), "Settings did not render.");
    await driver.executeScript("document.querySelector('[data-settings-group=system]')?.click()");
    await clickAnyText(driver, ".settings-subnav-btn", ["Storage", "Armazenamento"]);
    await clickAnyText(driver, "button", ["Restore backup", "Restaurar backup"]);
    await waitFor(driver, () => driver.executeScript("return Boolean(document.querySelector('input[type=file]'))"), "Restore file input did not render.");

    await driver.executeScript("const input=document.querySelector('input[type=file]'); input.style.display='block'; input.style.position='fixed'; input.style.left='16px'; input.style.bottom='16px';");
    await driver.findElement(By.css("input[type=file]")).sendKeys(backupPath);
    if (!backupPath.toLowerCase().endsWith(".zip")) {
      try {
        await waitFor(driver, () => driver.executeScript("return document.querySelector('[data-backup-title-count]')?.innerText.trim().startsWith('686 ')"), "The J2K backup did not show its 686 library titles.");
      } catch (error) {
        const body = await driver.executeScript("return document.body.innerText.slice(-5000)");
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${body}`);
      }
      await driver.executeScript("document.querySelector('input[type=file]').style.display='none'");
      await fs.writeFile(evidencePath, await driver.takeScreenshot(), "base64");
      process.stdout.write(`${JSON.stringify({ ok: true, backupPath, isolatedProfile: true, inspectedLibraryTitles: 686, evidencePath }, null, 2)}\n`);
      return;
    }
    await waitFor(driver, () => driver.executeScript("return document.body.innerText.includes('LNReader ZIP')"), "LNReader format was not detected.");
    await driver.executeScript("document.querySelector('input[type=file]').style.display='none'");
    const confirmation = await driver.executeScript(function confirmRestore() {
      const switches = [...document.querySelectorAll("[role=switch]")].map((element) => ({
        label: element.getAttribute("aria-label"),
        checked: element.getAttribute("aria-checked"),
        visible: element.getClientRects().length > 0,
      }));
      const target = [...document.querySelectorAll("[role=switch]")].find((element) => (
        element.getClientRects().length > 0
        && /confirm|confirmar/i.test(element.getAttribute("aria-label") ?? "")
      ));
      target?.click();
      return { switches, clicked: Boolean(target), body: document.body.innerText.slice(-3000) };
    });
    assert.equal(confirmation.clicked, true, "The visible current-profile confirmation was not found.");
    await waitFor(driver, () => driver.executeScript("return [...document.querySelectorAll('button')].some((button) => !button.disabled && /LNReader/i.test(button.innerText))"), "Restore confirmation did not enable the action.");
    await clickAnyText(driver, "button", ["LNReader novels restore", "Restaurar novels do LNReader"]);
    await waitFor(driver, () => driver.executeScript("return document.body.innerText.includes('novel entries restored')"), "LNReader restore did not finish.", 300_000);
    await fs.writeFile(evidencePath, await driver.takeScreenshot(), "base64");

    const resultText = await driver.executeScript("return document.body.innerText");
    assert.match(resultText, /9 novel entries restored/);
    const repositoryStatePath = await findFile(profileRoot, "repositories-state.json");
    const libraryStatePath = await findFile(profileRoot, "library-state.json");
    assert(repositoryStatePath, "The restore did not persist novel repository state.");
    assert(libraryStatePath, "The restore did not persist novel library state.");
    const repositoryState = JSON.parse(await fs.readFile(repositoryStatePath, "utf8"));
    const libraryState = JSON.parse(await fs.readFile(libraryStatePath, "utf8"));
    assert.equal(repositoryState.repositories.length, 2, "Expected both LNReader repositories.");
    assert.equal(repositoryState.installedPlugins.length, 19, "Expected all LNReader plugins to be installed.");
    assert.equal(libraryState.entries.length, 9, "Expected all LNReader library entries.");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      backupPath,
      isolatedProfile: true,
      restoredEntries: libraryState.entries.length,
      repositories: repositoryState.repositories.length,
      installedPlugins: repositoryState.installedPlugins.length,
      evidencePath,
    }, null, 2)}\n`);
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
