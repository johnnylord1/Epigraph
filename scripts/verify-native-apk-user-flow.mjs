import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Builder, By, Capabilities } from "selenium-webdriver";

import {
  allocateLoopbackPort,
  serverConfig,
  startRuntime,
  stopRuntime,
  waitForHealth,
} from "./certify-suwayomi-release.mjs";

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((value) => value.startsWith("--")).map((value) => {
    const separator = value.indexOf("=");
    return [value.slice(2, separator < 0 ? undefined : separator), separator < 0 ? "true" : value.slice(separator + 1)];
  }));
}

async function waitFor(driver, predicate, message, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const body = await driver?.executeScript("return document.body?.innerText?.slice(-5000) ?? ''").catch(() => "");
  throw new Error(`${message}\n${body}`);
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

async function launchApp({ appPath, driverUrl, appData, webviewData, serverUrl }) {
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", {
    application: appPath,
    args: [
      "--webdriver-automation",
      `--local-app-data-dir=${appData}`,
      `--server-url=${serverUrl}`,
      "--profile-label=TEST",
      "--attach-only",
    ],
    webviewOptions: { userDataFolder: webviewData },
  });
  const driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await driver.manage().setTimeouts({ implicit: 0, pageLoad: 120_000, script: 120_000 });
  await waitFor(driver, () => driver.executeScript("return Boolean(window.__epigraphAudit)"), "Audit bridge did not become ready.");
  await callAudit(driver, "bypassFirstRun");
  await callAudit(driver, "bypassStartupSplash");
  return driver;
}

async function openSources(driver) {
  await driver.executeScript("document.querySelector('[data-nav-id=search]')?.click()");
  await waitFor(driver, () => driver.executeScript("return document.querySelectorAll('.browseSubtab').length >= 3"), "Browse did not render.");
  const clicked = await driver.executeScript(function openSourcesTab() {
    const target = [...document.querySelectorAll(".browseSubtab")].find((button) => /sources|fontes/i.test(button.textContent ?? ""));
    target?.click();
    return Boolean(target);
  });
  assert.equal(clicked, true, "The visible Sources tab was not found.");
  await waitFor(driver, () => driver.executeScript(function installApkVisible() {
    return [...document.querySelectorAll("button")].some((button) => /install\s+apk|instalar\s+apk/i.test(button.textContent ?? ""));
  }), "Sources did not show Install APK.");
}

async function openApkPanel(driver) {
  const clicked = await driver.executeScript(function openInstaller() {
    const target = [...document.querySelectorAll("button")].find((button) => (
      button.getClientRects().length > 0 && /install\s+apk|instalar\s+apk/i.test(button.textContent ?? "")
    ));
    target?.click();
    return Boolean(target);
  });
  assert.equal(clicked, true, "The visible Install APK action was not found.");
  await waitFor(driver, () => driver.executeScript("return Boolean(document.querySelector('.apkInstallDialog .apkFileInput'))"), "The APK installer did not open.");
}

async function addMangaRepository(driver, inputUrl, expectedUrl) {
  const clicked = await driver.executeScript(function openRepositories() {
    const target = [...document.querySelectorAll("button.headerAction")].find((button) => (
      button.getClientRects().length > 0
      && /manga repositories|repositórios de manga/i.test(button.textContent ?? "")
    ));
    target?.click();
    return Boolean(target);
  });
  assert.equal(clicked, true, "The visible manga repositories action was not found.");
  await waitFor(driver, () => driver.executeScript("return Boolean(document.querySelector('.novelRepoPanel .inlineForm input'))"), "The manga repositories panel did not open.");
  const input = driver.findElement(By.css(".novelRepoPanel .inlineForm input"));
  await input.sendKeys(inputUrl);
  const addClicked = await driver.executeScript(function addRepository() {
    const target = document.querySelector(".novelRepoPanel .inlineForm button");
    if (!(target instanceof HTMLButtonElement) || target.disabled) return false;
    target.click();
    return true;
  });
  assert.equal(addClicked, true, "The visible Add repository action was not available.");
  await waitFor(driver, () => driver.executeScript(function repositoryVisible(expected) {
    return [...document.querySelectorAll(".novelRepoPanel .repoRow strong")].some((element) => element.textContent?.trim() === expected);
  }, expectedUrl), `The repository was not saved as ${expectedUrl}.`, 300_000);
  assert.equal(await driver.executeScript("return Boolean(document.querySelector('.novelRepoPanel .n-state'))"), false, "The repository panel reported an error.");
  await driver.executeScript("document.querySelector('.novelRepoPanel .closeUtility')?.click()");
  await waitFor(driver, () => driver.executeScript("return !document.querySelector('.novelRepoPanel')"), "The repositories panel did not close.");
}

async function verifyMangaRepository(driver, expectedUrl) {
  const clicked = await driver.executeScript(function openRepositories() {
    const target = [...document.querySelectorAll("button.headerAction")].find((button) => (
      button.getClientRects().length > 0
      && /manga repositories|repositórios de manga/i.test(button.textContent ?? "")
    ));
    target?.click();
    return Boolean(target);
  });
  assert.equal(clicked, true, "The visible manga repositories action was not found after restart.");
  await waitFor(driver, () => driver.executeScript(function repositoryVisible(expected) {
    return [...document.querySelectorAll(".novelRepoPanel .repoRow strong")].some((element) => element.textContent?.trim() === expected);
  }, expectedUrl), "The manga repository did not persist after restart.");
  await driver.executeScript("document.querySelector('.novelRepoPanel .closeUtility')?.click()");
}

async function selectApk(driver, filePath) {
  await driver.executeScript("const input=document.querySelector('.apkFileInput'); input.style.display='block'; input.style.position='fixed'; input.style.left='16px'; input.style.bottom='16px'; input.style.opacity='1';");
  await driver.findElement(By.css(".apkFileInput")).sendKeys(filePath);
  await waitFor(driver, () => driver.executeScript(function selected(name) {
    return document.querySelector(".apkFileCopy strong")?.textContent?.trim() === name;
  }, path.basename(filePath)), `The APK picker did not show ${path.basename(filePath)}.`);
  await driver.executeScript("document.querySelector('.apkFileInput').style.display='none'");
}

async function clickInstall(driver) {
  const clicked = await driver.executeScript(function install() {
    const target = document.querySelector(".apkInstallButton");
    if (!(target instanceof HTMLButtonElement) || target.disabled) return false;
    target.click();
    return true;
  });
  assert.equal(clicked, true, "The visible APK install button was not available.");
}

async function installValidApk(driver, filePath) {
  await openApkPanel(driver);
  await selectApk(driver, filePath);
  await clickInstall(driver);
  await waitFor(driver, () => driver.executeScript("return Boolean(document.querySelector('.apkInstallButton.success')) || !document.querySelector('.apkInstallDialog')"), "The valid APK did not finish installing.", 300_000);
  await waitFor(driver, () => driver.executeScript("return !document.querySelector('.apkInstallDialog')"), "The successful APK dialog did not close.");
}

async function rejectInvalidApk(driver, filePath) {
  await openApkPanel(driver);
  await selectApk(driver, filePath);
  await clickInstall(driver);
  await waitFor(driver, () => driver.executeScript("return Boolean(document.querySelector('.apkInstallDialog .n-state'))"), `Invalid APK ${path.basename(filePath)} was not rejected.`);
  const message = await driver.executeScript("return document.querySelector('.apkInstallDialog .n-state')?.innerText ?? ''");
  assert(message.trim(), "The invalid APK error message was empty.");
  await driver.executeScript("document.querySelector('.apkInstallDialog [aria-label]')?.click()");
  await waitFor(driver, () => driver.executeScript("return !document.querySelector('.apkInstallDialog')"), "The invalid APK dialog did not close.");
  return message;
}

async function extensionInventory(endpoint, packageName) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "query EpigraphApkFlowInventory { extensions { nodes { pkgName versionName versionCodeLong isInstalled } } sources { nodes { id extension { pkgName } } } }" }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) throw new Error(`Could not inspect extension inventory: ${JSON.stringify(payload.errors ?? response.status)}`);
  return {
    extensions: payload.data.extensions.nodes.filter((entry) => entry.pkgName === packageName),
    sources: payload.data.sources.nodes.filter((entry) => entry.extension?.pkgName === packageName),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appPath = path.resolve(args.app || "src-tauri/target/release/epigraph.exe");
  const jarPath = path.resolve(args["suwayomi-jar"] || "");
  const validApk = path.resolve(args.apk || "");
  const ordinaryApk = path.resolve(args["ordinary-apk"] || "");
  const driverUrl = args["driver-url"] || "http://127.0.0.1:4554";
  const packageName = args.package || "eu.kanade.tachiyomi.extension.all.akuma";
  const repositoryInput = args.repository || "https://github.com/keiyoushi/extensions";
  const expectedRepository = args["expected-repository"] || "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb";
  for (const [label, filePath] of [["app", appPath], ["Suwayomi JAR", jarPath], ["extension APK", validApk], ["ordinary APK", ordinaryApk]]) {
    assert(filePath && await fs.stat(filePath).then((entry) => entry.isFile()).catch(() => false), `${label} file does not exist.`);
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epigraph-apk-flow-"));
  const appData = path.join(root, "LocalAppData", "Epigraph");
  const webviewData = path.join(root, "WebView2Automation");
  const runtimeRoot = path.join(root, "Suwayomi");
  const truncatedApk = path.join(root, "truncated.apk");
  const renamedZipApk = path.join(root, "renamed-zip.apk");
  const evidencePath = path.join(os.tmpdir(), `epigraph-apk-flow-${Date.now()}.png`);
  await fs.mkdir(appData, { recursive: true });
  await fs.mkdir(runtimeRoot, { recursive: true });
  await fs.writeFile(truncatedApk, (await fs.readFile(validApk)).subarray(0, 128));
  await fs.writeFile(renamedZipApk, Buffer.from("504b0304140000000000", "hex"));
  const port = await allocateLoopbackPort();
  await fs.writeFile(path.join(runtimeRoot, "server.conf"), serverConfig(port));
  const endpoint = `http://127.0.0.1:${port}/api/graphql`;
  const serverUrl = `http://127.0.0.1:${port}`;
  let runtime = startRuntime(args.java || "java", jarPath, runtimeRoot);
  let driver;
  try {
    await waitForHealth(endpoint, runtime, 180_000);
    driver = await launchApp({ appPath, driverUrl, appData, webviewData, serverUrl });
    await openSources(driver);
    await addMangaRepository(driver, repositoryInput, expectedRepository);
    await installValidApk(driver, validApk);
    let inventory = await extensionInventory(endpoint, packageName);
    assert.equal(inventory.extensions.length, 1, "The valid APK did not register exactly one extension.");
    assert.equal(inventory.extensions[0].isInstalled, true, "The valid APK was not installed.");
    assert(inventory.sources.length > 0, "The valid APK registered no sources.");

    await installValidApk(driver, validApk);
    inventory = await extensionInventory(endpoint, packageName);
    assert.equal(inventory.extensions.length, 1, "Reinstalling the APK created a duplicate extension.");
    const stableSourceIds = inventory.sources.map((entry) => entry.id).sort();

    const errors = [];
    for (const invalidPath of [ordinaryApk, truncatedApk, renamedZipApk]) {
      errors.push(await rejectInvalidApk(driver, invalidPath));
      const afterRejection = await extensionInventory(endpoint, packageName);
      assert.equal(afterRejection.extensions.length, 1, "An invalid APK changed the extension inventory.");
      assert.deepEqual(afterRejection.sources.map((entry) => entry.id).sort(), stableSourceIds, "An invalid APK changed the source inventory.");
    }
    await driver.quit();
    driver = null;
    await stopRuntime(runtime.child, port);
    runtime = startRuntime(args.java || "java", jarPath, runtimeRoot);
    await waitForHealth(endpoint, runtime, 180_000);
    const afterRestart = await extensionInventory(endpoint, packageName);
    assert.equal(afterRestart.extensions.length, 1, "The extension was lost after restart.");
    assert.deepEqual(afterRestart.sources.map((entry) => entry.id).sort(), stableSourceIds, "Extension sources changed after restart.");

    driver = await launchApp({ appPath, driverUrl, appData, webviewData, serverUrl });
    await openSources(driver);
    await verifyMangaRepository(driver, expectedRepository);
    await waitFor(driver, () => driver.executeScript("return /Akuma/i.test(document.body.innerText)"), "The restarted app did not show Akuma in Sources.");
    await fs.writeFile(evidencePath, await driver.takeScreenshot(), "base64");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      packageName,
      versionName: afterRestart.extensions[0].versionName,
      sourceCount: afterRestart.sources.length,
      duplicateCount: afterRestart.extensions.length,
      rejectedFiles: [path.basename(ordinaryApk), path.basename(truncatedApk), path.basename(renamedZipApk)],
      rejectionMessages: errors,
      restartStable: true,
      repositoryInput,
      storedRepository: expectedRepository,
      isolatedProfile: true,
      evidencePath,
    }, null, 2)}\n`);
  } finally {
    await driver?.quit().catch(() => {});
    await stopRuntime(runtime.child, port).catch(() => {});
    await fs.rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
