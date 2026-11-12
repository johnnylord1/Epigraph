import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Builder, By, Capabilities, until } from "selenium-webdriver";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const values = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, value = ""] = raw.slice(2).split("=", 2);
    values[key] = value;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(args["project-root"] || path.join(scriptDir, ".."));
const tmpRoot = path.resolve(
  args["tmp-root"] || path.join(projectRoot, "tmp", "syncd-native-two-instance-automation"),
);
const artifactsRoot = path.join(tmpRoot, "artifacts");
const progressLogPath = path.join(artifactsRoot, "progress.log");
const lastStepPath = path.join(artifactsRoot, "last-step.json");
const driverUrl = args["driver-url"] || "http://127.0.0.1:4554";
const appBasePath = path.resolve(
  args.app || path.join(projectRoot, "src-tauri", "target", "release", "epigraph.exe"),
);

const DEFAULT_TIMEOUT_MS = 120_000;
const SHORT_TIMEOUT_MS = 15_000;
const BOOTSTRAP_REACHABILITY_TIMEOUT_MS = 15_000;
const APP_BOOT_TIMEOUT_MS = 180_000;
const SCENARIO_STATUS_TIMEOUT_MS = 45_000;
let webviewLaunchGeneration = 0;
// Every profile this run started a desktop on. Each may leave a Core behind, because closing the app does not stop it.
const launchedProfiles = new Map();

function testId(id) {
  return By.css(`[data-testid="${id}"]`);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function step(message) {
  process.stdout.write(`${message}\n`);
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    fsSync.mkdirSync(artifactsRoot, { recursive: true });
    fsSync.appendFileSync(progressLogPath, line, "utf8");
    fsSync.writeFileSync(lastStepPath, `${JSON.stringify({ timestamp, message }, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort logging only.
  }
}

async function waitForCondition(check, timeout, message) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) {
        return result;
      }
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (lastError instanceof Error && lastError.message) {
    throw new Error(`${message} (${lastError.message})`);
  }
  throw new Error(message);
}

async function launchDesktop(name, options) {
  step(`launchDesktop(${name}): starting`);
  launchedProfiles.set(options.localAppDataDir, { ...options, name });
  const launchArgs = [
    "--webdriver-automation",
    `--local-app-data-dir=${options.localAppDataDir}`,
    `--syncd-port=${options.syncdPort}`,
    `--server-url=http://127.0.0.1:${options.localServerPort}`,
    "--profile-label=TEST",
  ];
  if (options.bootstrapTtlSeconds) {
    launchArgs.push(`--syncd-bootstrap-ttl-seconds=${options.bootstrapTtlSeconds}`);
  }

  let driver = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    webviewLaunchGeneration += 1;
    const capabilities = new Capabilities();
    capabilities.setBrowserName("wry");
    capabilities.set("tauri:options", {
      application: appBasePath,
      args: launchArgs,
      webviewOptions: {
        userDataFolder: path.join(
          options.localAppDataDir,
          "WebView2Automation",
          `${name}-${webviewLaunchGeneration}`,
        ),
        additionalBrowserArguments: ["--remote-debugging-port=0"],
      },
    });

    step(`launchDesktop(${name}): building webdriver session (attempt ${attempt})`);
    try {
      driver = await new Builder()
        .usingServer(driverUrl)
        .withCapabilities(capabilities)
        .build();
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      const message = error instanceof Error ? error.message : String(error);
      step(`launchDesktop(${name}): session launch failed, retrying with a clean WebView2 profile (${message})`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  if (!driver) throw new Error(`launchDesktop(${name}) did not create a webdriver session.`);

  step(`launchDesktop(${name}): webdriver session ready`);
  await driver.manage().setTimeouts({
    implicit: 0,
    pageLoad: DEFAULT_TIMEOUT_MS,
    script: DEFAULT_TIMEOUT_MS,
  });

  step(`launchDesktop(${name}): waiting for audit shell`);
  await waitForCondition(
    () => driver.executeScript("return Boolean(window.__epigraphAudit);"),
    APP_BOOT_TIMEOUT_MS,
    `launchDesktop(${name}): the audit bridge did not appear.`,
  );
  // These profiles are new, so the app would otherwise stay on first-run setup.
  await callAudit({ driver }, "bypassFirstRun");
  await callAudit({ driver }, "bypassStartupSplash");
  await waitForAuditShellReady(driver, APP_BOOT_TIMEOUT_MS, name);
  step(`launchDesktop(${name}): audit shell ready`);
  await openSecuritySettings(driver, DEFAULT_TIMEOUT_MS);
  step(`launchDesktop(${name}): security settings open`);
  await clickTestId(driver, "settings-security-syncd-manage", DEFAULT_TIMEOUT_MS);
  step(`launchDesktop(${name}): syncd manage clicked`);
  await waitForTestId(driver, "syncd-panel-grid", DEFAULT_TIMEOUT_MS);
  step(`launchDesktop(${name}): syncd panel visible`);
  await waitForPanelSubscriptionsReady(driver, DEFAULT_TIMEOUT_MS);
  step(`launchDesktop(${name}): subscriptions ready`);
  return {
    ...options,
    name,
    driver,
  };
}

async function closeDesktop(instance) {
  if (!instance?.driver) return;
  try {
    await instance.driver.quit();
  } catch {
    // Ignore teardown noise.
  } finally {
    instance.driver = null;
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
}

async function restartDesktop(instance, overrides = {}) {
  const next = {
    ...instance,
    ...overrides,
  };
  await closeDesktop(instance);
  delete next.driver;
  return launchDesktop(next.name, next);
}

function coreDataDir(instance) {
  return path.join(instance.localAppDataDir, "Epigraph", "syncd");
}

// Observation only: the manifest says which Core run is current, it never authorizes stopping one.
async function readCoreRun(instance) {
  const raw = await fs.readFile(path.join(coreDataDir(instance), "runtime.json"), "utf8");
  const { pid, serverId, runId } = JSON.parse(raw);
  return { pid, serverId, runId };
}

// Stops the Core of this harness's own profile through its authenticated shutdown, which verifies the
// process identity and also stops a Core kept alive by a connected device. Stopping none is not an error.
async function shutdownOwnCore(instance) {
  await execFileAsync(
    path.join(path.dirname(appBasePath), "epigraph-syncd.exe"),
    ["shutdown", "--data-dir", coreDataDir(instance), "--timeout-seconds", "30"],
    { windowsHide: true },
  );
}

async function replaceSyncdDaemon(instance) {
  const previous = await readCoreRun(instance);
  await shutdownOwnCore(instance);
  // The open Sync panel asks for the Core every 2 s, and that request starts a new one.
  const next = await waitForCondition(
    async () => {
      const current = await readCoreRun(instance).catch(() => null);
      return current && current.runId !== previous.runId ? current : null;
    },
    SCENARIO_STATUS_TIMEOUT_MS,
    `${instance.name}: the desktop did not start a new Core after the previous one stopped.`,
  );
  return { previous, next };
}

async function waitForBootstrapPayloadReachable(
  origin,
  sessionId,
  timeout = BOOTSTRAP_REACHABILITY_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeout;
  const endpoint = `${origin}/v1/bootstrap/session/${sessionId}`;

  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(
        "curl.exe",
        ["-k", "-sS", "-m", "10", "-w", "\n%{http_code}", endpoint],
        {
          windowsHide: true,
        },
      );
      const trimmed = stdout.trimEnd();
      const splitIndex = trimmed.lastIndexOf("\n");
      if (splitIndex < 0) {
        throw new Error("Missing HTTP status line.");
      }
      const body = trimmed.slice(0, splitIndex);
      const status = trimmed.slice(splitIndex + 1).trim();
      if (status !== "200") {
        throw new Error(`Unexpected HTTP ${status}.`);
      }
      const payload = JSON.parse(body);
      if (payload.pairingSessionId !== sessionId) {
        throw new Error("Bootstrap payload session id did not match.");
      }
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  throw new Error(`Timed out waiting for bootstrap session ${sessionId} to become publicly reachable at ${origin}.`);
}

// Status values are rendered hidden and are never "visible", so only actions and inputs wait for visibility.
async function locateTestId(driver, id, timeout = DEFAULT_TIMEOUT_MS) {
  const locator = testId(id);
  await driver.wait(until.elementLocated(locator), timeout, `Timed out waiting for ${id}.`);
  return driver.findElement(locator);
}

async function waitForTestId(driver, id, timeout = DEFAULT_TIMEOUT_MS) {
  const element = await locateTestId(driver, id, timeout);
  await driver.wait(until.elementIsVisible(element), timeout).catch(() => element);
  return element;
}

async function maybeFind(driver, id) {
  const elements = await driver.findElements(testId(id));
  return elements[0] ?? null;
}

// One script per attempt: the panel re-renders while it polls, so a held element could go stale before the click.
async function clickSelector(driver, selector, timeout, label) {
  await waitForCondition(
    () => driver.executeScript(
      `
        const element = document.querySelector(arguments[0]);
        if (!element || element.disabled) return false;
        element.scrollIntoView({ block: "center", inline: "center" });
        element.click();
        return true;
      `,
      selector,
    ),
    timeout,
    `Timed out clicking ${label}.`,
  );
}

async function clickTestId(driver, id, timeout = DEFAULT_TIMEOUT_MS) {
  await clickSelector(driver, `[data-testid="${id}"]`, timeout, id);
}

async function waitForAuditShellReady(driver, timeout = DEFAULT_TIMEOUT_MS, label = "app") {
  const deadline = Date.now() + timeout;
  let lastHeartbeatAt = 0;
  let lastState = null;

  while (Date.now() < deadline) {
    try {
      lastState = await driver.executeScript(`
        const audit = window.__epigraphAudit;
        const state = audit?.getState?.() ?? null;
        return {
          hasAudit: !!audit,
          hasGetState: !!audit?.getState,
          splashVisible: state?.splashVisible ?? null,
          settingsOpen: state?.settingsOpen ?? null,
          navPage: state?.navPage ?? null,
          title: document.title,
          readyState: document.readyState,
          href: location.href,
          bodyText: document.body?.innerText?.slice(0, 500) ?? "",
        };
      `);

      if (lastState?.hasAudit && lastState?.hasGetState && lastState?.splashVisible === false) {
        return;
      }

      if (Date.now() - lastHeartbeatAt >= 10_000) {
        lastHeartbeatAt = Date.now();
        step(
          `waitForAuditShellReady(${label}): hasAudit=${lastState?.hasAudit ?? false} splashVisible=${String(lastState?.splashVisible)} readyState=${lastState?.readyState ?? "unknown"} navPage=${lastState?.navPage ?? "unknown"}`,
        );
      }
    } catch (error) {
      lastState = {
        error: error instanceof Error ? error.message : String(error),
      };
      if (Date.now() - lastHeartbeatAt >= 10_000) {
        lastHeartbeatAt = Date.now();
        step(`waitForAuditShellReady(${label}): script probe failed (${lastState.error})`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await snapshotJson(`audit-shell-timeout-${label}`, {
    label,
    timeoutMs: timeout,
    state: lastState,
  });
  try {
    const image = await driver.takeScreenshot();
    await fs.writeFile(
      path.join(artifactsRoot, `audit-shell-timeout-${label}.png`),
      Buffer.from(image, "base64"),
    );
  } catch {
    // Best-effort timeout artifact only.
  }

  throw new Error(`Timed out waiting for the Epigraph shell to become automation-ready (${label}).`);
}

async function waitForPanelSubscriptionsReady(driver, timeout = DEFAULT_TIMEOUT_MS) {
  try {
    await waitForCondition(
      () => driver.executeScript(
        `return document.querySelector('[data-testid="syncd-panel-grid"]')?.getAttribute('data-panel-ready') === 'ready';`,
      ),
      timeout,
      "Timed out waiting for the syncd panel subscriptions to become ready.",
    );
  } catch (error) {
    const panelError = await readOptionalText(driver, "syncd-panel-error");
    throw panelError
      ? new Error(`Syncd panel reported an error before subscriptions were ready: ${panelError}`)
      : error;
  }
}

// "Done" exists only in the details view and "Connection details" only outside it.
async function showPairingView(instance, timeout = DEFAULT_TIMEOUT_MS) {
  if (await maybeFind(instance.driver, "syncd-modal-pairing")) {
    await clickTestId(instance.driver, "syncd-modal-pairing", timeout);
  }
  await locateTestId(instance.driver, "syncd-modal-details", timeout);
}

async function showDetailsView(instance, timeout = DEFAULT_TIMEOUT_MS) {
  if (await maybeFind(instance.driver, "syncd-modal-details")) {
    await clickTestId(instance.driver, "syncd-modal-details", timeout);
  }
  await locateTestId(instance.driver, "syncd-modal-pairing", timeout);
}

// The tabs have no test id: the first creates a QR, the second uses the QR of another desktop.
async function selectPairingTab(instance, index, timeout = DEFAULT_TIMEOUT_MS) {
  await showPairingView(instance, timeout);
  await waitForCondition(
    () => instance.driver.executeScript(
      `
        const tab = document.querySelectorAll('[data-testid="syncd-pairing-view"] .syncd-tabs button')[arguments[0]];
        if (!tab) return false;
        if (tab.getAttribute("aria-pressed") === "true") return true;
        tab.click();
        return false;
      `,
      index,
    ),
    timeout,
    `${instance.name}: the pairing tabs did not appear. Is this desktop already connected or waiting?`,
  );
}

async function openJoinOptions(instance, timeout = DEFAULT_TIMEOUT_MS) {
  await selectPairingTab(instance, 1, timeout);
  const disclosure = await locateTestId(instance.driver, "syncd-modal-options", timeout);
  if ((await disclosure.getAttribute("aria-expanded")) !== "true") {
    await clickTestId(instance.driver, "syncd-modal-options", timeout);
  }
  await locateTestId(instance.driver, "syncd-manual-origin", timeout);
}

async function openSecuritySettings(driver, timeout = DEFAULT_TIMEOUT_MS) {
  let lastOpenRequestAt = 0;
  await driver.wait(async () => {
    try {
      const now = Date.now();
      const shouldRequestOpen = now - lastOpenRequestAt >= 2_000;
      const ready = await driver.executeScript(`
        const audit = window.__epigraphAudit;
        if (!audit?.openSettings || !audit?.getState) return false;
        if (arguments[0]) audit.openSettings("security");
        const pane = document.querySelector('[data-settings-pane="security"]');
        return audit.getState().settingsOpen === true
          && !!document.querySelector(".settings-page")
          && !!pane
          && !pane.hidden;
      `, shouldRequestOpen);
      if (shouldRequestOpen) lastOpenRequestAt = now;
      return ready;
    } catch {
      return false;
    }
  }, timeout, "Timed out waiting for the mounted Security settings surface.");
}

async function setInputValue(driver, id, value) {
  const element = await waitForTestId(driver, id);
  await driver.executeScript(
    `
      const element = arguments[0];
      const value = arguments[1];
      element.focus();
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    `,
    element,
    value,
  );
}

async function callAudit(instance, method, ...args) {
  const result = await instance.driver.executeAsyncScript(
    `
      const method = arguments[0];
      const params = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
      const done = arguments[arguments.length - 1];
      Promise.resolve()
        .then(() => {
          const audit = window.__epigraphAudit;
          if (!audit || typeof audit[method] !== "function") {
            throw new Error(\`Audit method \${method} is not available.\`);
          }
          return audit[method](...params);
        })
        .then((value) => done({ ok: true, value }))
        .catch((error) => {
          done({
            ok: false,
            error: error instanceof Error ? (error.stack || error.message || error.name) : String(error),
          });
        });
    `,
    method,
    ...args,
  );

  if (!result?.ok) {
    throw new Error(result?.error || `Audit call ${method} failed.`);
  }
  return result.value;
}

// Reads the attribute anew each time: each pairing stage renders its own status node.
async function waitForStatus(driver, id, expected, timeout = DEFAULT_TIMEOUT_MS) {
  const normalizedExpected = String(expected).trim().toLowerCase().replaceAll(" ", "_");
  let lastStatus = null;
  try {
    await waitForCondition(async () => {
      lastStatus = await driver.executeScript(
        `return document.querySelector(arguments[0])?.getAttribute("data-status") ?? null;`,
        `[data-testid="${id}"]`,
      );
      return lastStatus === normalizedExpected;
    }, timeout, `Timed out waiting for ${id} status to equal ${normalizedExpected}`);
  } catch (error) {
    throw new Error(`${error.message}; last seen: ${lastStatus ?? "not rendered"}.`);
  }
}

async function saveScreenshot(instance, name) {
  const image = await instance.driver.takeScreenshot();
  const filePath = path.join(artifactsRoot, `${name}.png`);
  await fs.writeFile(filePath, Buffer.from(image, "base64"));
  return filePath;
}

async function snapshotJson(name, payload) {
  const filePath = path.join(artifactsRoot, `${name}.json`);
  await writeJson(filePath, payload);
  return filePath;
}

async function readOptionalText(driver, id) {
  const element = await maybeFind(driver, id).catch(() => null);
  if (!element) return "";
  return String(await driver.executeScript("return arguments[0].textContent;", element).catch(() => "")).trim();
}

async function readOptionalValue(driver, id) {
  const element = await maybeFind(driver, id).catch(() => null);
  if (!element) return "";
  return String(await driver.executeScript("return arguments[0].value;", element).catch(() => ""));
}

async function captureHostDiagnostics(host, name) {
  const payload = {
    hostStatus: await readOptionalText(host.driver, "syncd-host-status"),
    hostStatusLive: await readOptionalText(host.driver, "syncd-host-status-live"),
    hostStartStage: await readOptionalText(host.driver, "syncd-host-start-stage"),
    panelError: await readOptionalText(host.driver, "syncd-panel-error"),
    hostError: await readOptionalText(host.driver, "syncd-host-error"),
    hostCardText: await readOptionalText(host.driver, "syncd-host-card"),
    hasQrImage: Boolean(await maybeFind(host.driver, "syncd-host-qr-image").catch(() => null)),
    auditState: await host.driver
      .executeScript("return window.__epigraphAudit?.getState?.() ?? null;")
      .catch(() => null),
    auditPanelDiagnostics: await callAudit(host, "getSyncdPanelDiagnostics").catch(() => null),
    instance: {
      name: host.name,
      localAppDataDir: host.localAppDataDir,
      syncdPort: host.syncdPort,
      localServerPort: host.localServerPort,
    },
  };

  await snapshotJson(name, payload);
  await saveScreenshot(host, name);
}

async function captureJoinerDiagnostics(joiner, name) {
  const payload = {
    connectStatus: await readOptionalText(joiner.driver, "syncd-connect-status"),
    connectError: await readOptionalText(joiner.driver, "syncd-connect-error"),
    panelError: await readOptionalText(joiner.driver, "syncd-panel-error"),
    manualOrigin: await readOptionalValue(joiner.driver, "syncd-manual-origin"),
    bootstrapBundleLength: (await readOptionalValue(joiner.driver, "syncd-bootstrap-bundle-input")).length,
    peerCount: await joiner.driver.findElements(testId("syncd-peer-item")).then((elements) => elements.length).catch(() => null),
    panelReady: await joiner.driver
      .executeScript("return document.querySelector('[data-testid=\"syncd-panel-grid\"]')?.getAttribute('data-panel-ready') ?? null;")
      .catch(() => null),
    optionsText: await readOptionalText(joiner.driver, "syncd-options-view"),
    auditState: await joiner.driver
      .executeScript("return window.__epigraphAudit?.getState?.() ?? null;")
      .catch(() => null),
    auditPanelDiagnostics: await callAudit(joiner, "getSyncdPanelDiagnostics").catch(() => null),
    instance: {
      name: joiner.name,
      localAppDataDir: joiner.localAppDataDir,
      syncdPort: joiner.syncdPort,
      localServerPort: joiner.localServerPort,
    },
  };

  await snapshotJson(name, payload);
  await saveScreenshot(joiner, name);
}

async function captureFailureView(instance) {
  await snapshotJson(`failure-view-${instance.name}`, {
    hostStatus: await readOptionalText(instance.driver, "syncd-host-status-live"),
    connectStatus: await readOptionalText(instance.driver, "syncd-connect-status"),
    panelError: await readOptionalText(instance.driver, "syncd-panel-error"),
    persistedSessions: await instance.driver
      .findElements(testId("syncd-persisted-session-item"))
      .then((elements) => elements.length)
      .catch(() => null),
    pairingViews: await instance.driver.executeScript(
      `return [...document.querySelectorAll('[data-testid="syncd-pairing-view"]')].map((view) => ({
        hidden: view.hidden,
        tabs: [...view.querySelectorAll('.syncd-tabs button')].map((tab) => tab.getAttribute('aria-pressed')),
        hasQr: Boolean(view.querySelector('[data-testid="syncd-host-qr-surface"]')),
      }));`,
    ).catch(() => null),
    auditState: await instance.driver
      .executeScript("return window.__epigraphAudit?.getState?.() ?? null;")
      .catch(() => null),
  });
  await saveScreenshot(instance, `failure-view-${instance.name}`);
}

// Only the desktop under test: this machine may also announce a real Core, on another port.
async function selectDiscoveredPeer(joiner, host, timeout = DEFAULT_TIMEOUT_MS) {
  await openJoinOptions(joiner, timeout);
  await waitForCondition(async () => {
    const picked = await joiner.driver.executeScript(
      `
        const item = [...document.querySelectorAll('[data-testid="syncd-peer-item"]')]
          .find((candidate) => candidate.textContent.includes(arguments[0]));
        const button = item?.querySelector('[data-testid="syncd-peer-use-origin"]');
        if (button) {
          button.click();
          return true;
        }
        document.querySelector('[data-testid="syncd-connect-refresh-peers"]')?.click();
        return false;
      `,
      `:${host.syncdPort}`,
    );
    if (!picked) await joiner.driver.sleep(1_000);
    return picked;
  }, timeout, `${joiner.name} did not discover ${host.name} on the local network.`);
  await waitForCondition(
    async () => (await readOptionalValue(joiner.driver, "syncd-manual-origin")).includes(`:${host.syncdPort}`),
    SHORT_TIMEOUT_MS,
    "Choosing the discovered desktop did not fill in its address.",
  );
}

// The QR is what the panel offers: the raw package is only reachable through the clipboard, which belongs to the user.
async function readHostQr(host, timeout = DEFAULT_TIMEOUT_MS) {
  return waitForCondition(
    () => host.driver.executeScript(`
      const image = document.querySelector('[data-testid="syncd-host-qr-image"]');
      if (!image?.src?.startsWith("data:image/png;base64,")) return null;
      return { sessionId: image.dataset.sessionId, origin: image.dataset.origin, qrDataUrl: image.src };
    `),
    timeout,
    `${host.name}: the pairing QR did not appear.`,
  );
}

async function startHostPairing(host, screenshotName) {
  let state = null;
  try {
    await selectPairingTab(host, 0);
    await clickTestId(host.driver, "syncd-host-start");
    await waitForStatus(host.driver, "syncd-host-status-live", "pending");
    state = await readHostQr(host);
  } catch (error) {
    await captureHostDiagnostics(host, screenshotName || "host-bootstrap-readiness-failure");
    throw error;
  }
  if (screenshotName) {
    await saveScreenshot(host, screenshotName);
  }
  return state;
}

async function writeQrToFile(qrDataUrl, filePath) {
  await fs.writeFile(filePath, Buffer.from(qrDataUrl.replace(/^data:image\/png;base64,/i, ""), "base64"));
}

async function waitForLoadedBundle(joiner, sessionId) {
  return waitForCondition(async () => {
    const value = await readOptionalValue(joiner.driver, "syncd-bootstrap-bundle-input");
    return value.includes(sessionId) ? value : null;
  }, SHORT_TIMEOUT_MS, "The pairing package was not loaded from the QR.");
}

// method: "qr-event" (image handed to the panel), "qr-file" (image file the user picks) or "paste" (text typed in).
async function connectJoiner(joiner, hostState, { method, manualOrigin }) {
  await openJoinOptions(joiner);
  if (manualOrigin !== undefined) {
    await setInputValue(joiner.driver, "syncd-manual-origin", manualOrigin);
  }
  await setInputValue(joiner.driver, "syncd-bootstrap-bundle-input", "");

  if (method === "qr-file") {
    const qrPath = path.join(artifactsRoot, `${joiner.name}-${hostState.sessionId}-qr.png`);
    await writeQrToFile(hostState.qrDataUrl, qrPath);
    const input = await locateTestId(joiner.driver, "syncd-qr-file-input");
    await joiner.driver.executeScript(
      `
        arguments[0].style.display = "block";
        arguments[0].style.position = "static";
        arguments[0].style.opacity = "1";
        arguments[0].style.visibility = "visible";
      `,
      input,
    );
    await input.sendKeys(qrPath);
  } else {
    await joiner.driver.executeScript(
      `window.dispatchEvent(new CustomEvent("epigraph:syncd-import-qr-data-url", { detail: arguments[0] }));`,
      hostState.qrDataUrl,
    );
  }
  const bundleRaw = await waitForLoadedBundle(joiner, hostState.sessionId);

  if (method === "paste") {
    await setInputValue(joiner.driver, "syncd-bootstrap-bundle-input", "");
    await setInputValue(joiner.driver, "syncd-bootstrap-bundle-input", bundleRaw);
    await waitForLoadedBundle(joiner, hostState.sessionId);
  }
  await clickTestId(joiner.driver, "syncd-connect-submit");
}

async function waitForConnectStatus(joiner, status, timeout = DEFAULT_TIMEOUT_MS, diagnosticsName = null) {
  try {
    await waitForStatus(joiner.driver, "syncd-connect-status", status, timeout);
  } catch (error) {
    if (diagnosticsName) {
      await captureJoinerDiagnostics(joiner, diagnosticsName);
    }
    throw error;
  }
}

async function waitForPersistedSessionCount(joiner, expectedCount, timeout = DEFAULT_TIMEOUT_MS) {
  await joiner.driver.wait(async () => {
    const items = await joiner.driver.findElements(testId("syncd-persisted-session-item"));
    return items.length === expectedCount;
  }, timeout, `Timed out waiting for ${expectedCount} persisted session(s).`);
}

async function waitForPersistedSessionOrigin(instance, canonicalOrigin, timeout = DEFAULT_TIMEOUT_MS) {
  return waitForCondition(async () => {
    const persisted = await readPersistedState(instance).catch(() => null);
    return persisted?.sessions?.find((session) => session.canonicalOrigin === canonicalOrigin) ?? null;
  }, timeout, `Timed out waiting for persisted Syncd session ${canonicalOrigin}.`);
}

async function readPersistedState(instance) {
  const statePath = path.join(
    instance.localAppDataDir,
    "Epigraph",
    "syncd-desktop",
    "syncd-desktop-state.json",
  );
  const raw = await fs.readFile(statePath, "utf8");
  return JSON.parse(raw);
}

async function invokeCommand(instance, command, args) {
  const result = await instance.driver.executeAsyncScript(
    `
      const [command, args, done] = arguments;
      window.__TAURI_INTERNALS__.invoke(command, args)
        .then((value) => done({ ok: true, value }))
        .catch((error) => done({ ok: false, error: String(error) }));
    `,
    command,
    args,
  );
  if (!result?.ok) {
    throw new Error(result?.error || `Command ${command} failed.`);
  }
  return result.value;
}

// Replication reads and writes only the main book library, whatever profile the app runs
// (book_library_write_notifies_replication in lib.rs). These instances stay on the TEST profile because
// a MAIN one would make each Core use the port of the user's own Suwayomi, so the book steps go straight
// to that library.
async function readMainBookLibrary(instance) {
  const raw = await invokeCommand(instance, "read_book_library_state", { profileId: "main" });
  return raw
    ? JSON.parse(raw)
    : {
        version: 1,
        books: [],
        bookProgress: [],
        bookBookmarks: [],
        booksCategories: [],
        booksCategoryAssignments: {},
        booksLibraryUi: {
          activeCategoryId: null,
          typeFilter: "all",
          statusFilter: "all",
          search: "",
          sortMode: "recentlyAdded",
          sortDir: "desc",
        },
        updatedAtMs: null,
      };
}

async function readBookPersistence(instance) {
  return { state: await readMainBookLibrary(instance) };
}

async function readNovelPersistence(instance) {
  return callAudit(instance, "readNovelLibraryPersistence");
}

// A book syncs by the hash of its file, and each desktop keeps its own local id for it: the one that
// imported it picks one, and the others receive `epub:sha256:<hash>`. Every desktop imports these same
// bytes, so they all hold one work.
const AUDIT_BOOK_BYTES = Buffer.from("Epigraph sync automation book fixture.\n", "utf8");
const AUDIT_BOOK_FINGERPRINT = createHash("sha256").update(AUDIT_BOOK_BYTES).digest("hex");
const AUDIT_BOOK_CANONICAL_ID = `epub:sha256:${AUDIT_BOOK_FINGERPRINT}`;

function auditBookCopies(state) {
  return (state?.books ?? []).filter((entry) => entry.assetFingerprint === AUDIT_BOOK_FINGERPRINT);
}

function auditBookIds(state) {
  return new Set([AUDIT_BOOK_CANONICAL_ID, ...auditBookCopies(state).map((entry) => entry.id)]);
}

async function mutateBookFixture(instance, { mode, marker, progressPercent }) {
  const now = Date.now();
  const state = await readMainBookLibrary(instance);
  let bookId = auditBookCopies(state)[0]?.id ?? null;
  if (!bookId) {
    bookId = `audit-sync-book-${instance.name}`;
    const assetPath = path.join(instance.localAppDataDir, "audit-sync-book.epub");
    await fs.writeFile(assetPath, AUDIT_BOOK_BYTES);
    state.books.push({
      id: bookId,
      title: "Audit Sync Book",
      author: "Epigraph",
      description: "Automation-only sync replication fixture.",
      coverPath: null,
      subtype: "epub",
      createdAt: now,
      updatedAt: now,
      importPath: assetPath,
      assetPath,
      assetFingerprint: AUDIT_BOOK_FINGERPRINT,
      mimeType: "application/epub+zip",
      byteSize: AUDIT_BOOK_BYTES.length,
      sectionCount: 1,
    });
  }
  const bookmarkLabel = `Audit bookmark ${marker}`;
  if (mode === "progress") {
    state.bookProgress = state.bookProgress.filter((entry) => entry.bookId !== bookId);
    state.bookProgress.push({
      bookId,
      location: `audit-progress-${marker}`,
      href: `/audit/${marker}`,
      progressPercent,
      lastReadAt: now,
      pageIndex: 1,
      totalPages: 10,
      sectionLabel: `Audit ${marker}`,
      renderer: "epub",
    });
  } else {
    state.bookBookmarks = state.bookBookmarks.filter(
      (entry) => !(entry.bookId === bookId && entry.location === "audit-sync-bookmark"),
    );
    state.bookBookmarks.push({
      bookId,
      location: "audit-sync-bookmark",
      href: `/audit/bookmark/${marker}`,
      pageIndex: 1,
      progressPercent,
      label: bookmarkLabel,
      savedAt: now,
    });
  }
  state.updatedAtMs = now;
  await invokeCommand(instance, "write_book_library_state", {
    contents: JSON.stringify(state, null, 2),
    profileId: "main",
  });
  return { bookId, progressPercent, bookmarkLabel };
}

async function assertSingleAuditBook(instance) {
  const { state } = await readBookPersistence(instance);
  const copies = auditBookCopies(state).length;
  const ids = auditBookIds(state);
  const positions = (state?.bookProgress ?? []).filter((entry) => ids.has(entry.bookId)).length;
  if (copies !== 1 || positions !== 1) {
    throw new Error(`${instance.name} holds ${copies} copies of the book and ${positions} reading positions.`);
  }
}

async function mutateNovelFixture(instance, input) {
  return callAudit(instance, "mutateSyncdAuditNovelFixture", input);
}

async function waitForBookProgress(instance, minimumProgress, timeout = DEFAULT_TIMEOUT_MS) {
  try {
    return await waitForCondition(async () => {
      const persistence = await readBookPersistence(instance);
      const ids = auditBookIds(persistence?.state);
      const entry = persistence?.state?.bookProgress?.find?.((candidate) => ids.has(candidate.bookId)) ?? null;
      if (entry && Number(entry.progressPercent ?? 0) >= minimumProgress) {
        return { persistence, entry };
      }
      return null;
    }, timeout, `Timed out waiting for book progress >= ${minimumProgress}.`);
  } catch (error) {
    await snapshotJson(`book-progress-timeout-${instance.name}`, {
      fingerprint: AUDIT_BOOK_FINGERPRINT,
      minimumProgress,
      persistence: await readBookPersistence(instance).catch((readError) => ({
        readError: readError instanceof Error ? readError.message : String(readError),
      })),
    });
    throw error;
  }
}

async function waitForBookBookmark(instance, expectedLabel, timeout = DEFAULT_TIMEOUT_MS) {
  try {
    return await waitForCondition(async () => {
      const persistence = await readBookPersistence(instance);
      const ids = auditBookIds(persistence?.state);
      const entry = persistence?.state?.bookBookmarks?.find?.(
        (candidate) => ids.has(candidate.bookId) && candidate.label === expectedLabel,
      ) ?? null;
      if (entry) {
        return { persistence, entry };
      }
      return null;
    }, timeout, `Timed out waiting for book bookmark ${expectedLabel}.`);
  } catch (error) {
    await snapshotJson(`book-bookmark-timeout-${instance.name}`, {
      fingerprint: AUDIT_BOOK_FINGERPRINT,
      expectedLabel,
      persistence: await readBookPersistence(instance).catch((readError) => ({
        readError: readError instanceof Error ? readError.message : String(readError),
      })),
    });
    throw error;
  }
}

// A novel received through sync keeps a local id derived from its identity until its plugin is
// installed, so each desktop can use a different id for the same work: find it by its path.
const AUDIT_NOVEL_PATH = "/audit-sync-novel";

function auditNovelIds(persistence) {
  const entries = persistence?.state?.entries ?? [];
  return entries.filter((entry) => entry.path === AUDIT_NOVEL_PATH).map((entry) => entry.id);
}

function auditNovelProgress(persistence) {
  const ids = auditNovelIds(persistence);
  const progress = persistence?.state?.progress ?? [];
  return progress
    .filter((entry) => ids.includes(entry.novelId))
    .reduce((best, entry) => (
      !best || Number(entry.progressPercent ?? 0) > Number(best.progressPercent ?? 0) ? entry : best
    ), null);
}

async function assertSingleAuditNovel(instance) {
  const ids = auditNovelIds(await readNovelPersistence(instance));
  if (ids.length !== 1) {
    throw new Error(`Expected one copy of the synced novel on ${instance.name}, found ${ids.length}.`);
  }
}

async function waitForNovelProgress(instance, minimumProgress, timeout = DEFAULT_TIMEOUT_MS) {
  try {
    return await waitForCondition(async () => {
      const persistence = await readNovelPersistence(instance);
      const entry = auditNovelProgress(persistence);
      if (entry && Number(entry.progressPercent ?? 0) >= minimumProgress) {
        return { persistence, entry };
      }
      return null;
    }, timeout, `Timed out waiting for novel progress >= ${minimumProgress} on ${instance.name}.`);
  } catch (error) {
    await snapshotJson(`novel-progress-timeout-${instance.name}`, {
      minimumProgress,
      persistence: await readNovelPersistence(instance).catch((readError) => ({
        readError: readError instanceof Error ? readError.message : String(readError),
      })),
    });
    throw error;
  }
}

async function waitForNovelBookmark(instance, expectedLabel, timeout = DEFAULT_TIMEOUT_MS) {
  try {
    return await waitForCondition(async () => {
      const persistence = await readNovelPersistence(instance);
      const ids = auditNovelIds(persistence);
      const entry = persistence?.state?.bookmarks?.find?.(
        (candidate) => ids.includes(candidate.novelId) && candidate.label === expectedLabel,
      ) ?? null;
      if (entry) {
        return { persistence, entry };
      }
      return null;
    }, timeout, `Timed out waiting for novel bookmark ${expectedLabel}.`);
  } catch (error) {
    await snapshotJson(`novel-bookmark-timeout-${instance.name}`, {
      expectedLabel,
      persistence: await readNovelPersistence(instance).catch((readError) => ({
        readError: readError instanceof Error ? readError.message : String(readError),
      })),
    });
    throw error;
  }
}

async function waitForNovelBookmarkRemoved(instance, label, timeout = DEFAULT_TIMEOUT_MS) {
  await waitForCondition(async () => {
    const persistence = await readNovelPersistence(instance);
    const stillThere = persistence?.state?.bookmarks?.some?.((candidate) => candidate.label === label);
    return stillThere ? null : true;
  }, timeout, `Timed out waiting for novel bookmark ${label} to leave ${instance.name}.`);
}

// A bookmark only shows in the reader when it names the chapter this desktop holds.
function assertNovelBookmarkPlaced(instance, { persistence, entry }) {
  const chapters = persistence?.state?.chapters ?? [];
  const placed = chapters.some((chapter) => chapter.id === entry.chapterId && chapter.novelId === entry.novelId);
  if (!placed) {
    throw new Error(`Novel bookmark ${entry.label} on ${instance.name} does not name a local chapter.`);
  }
}

async function captureSessionDetails(instance, name) {
  await showDetailsView(instance);
  const screenshot = await saveScreenshot(instance, name);
  await showPairingView(instance);
  return screenshot;
}

// Disconnect removes the saved session and is the way back to the start of pairing. It has no test id.
async function disconnectSession(instance, timeout = DEFAULT_TIMEOUT_MS) {
  await showDetailsView(instance, timeout);
  await clickSelector(
    instance.driver,
    ".syncd-modal__footer button.syncd-btn:not(.syncd-btn--danger):not(.syncd-btn--primary):not([data-testid])",
    timeout,
    "Disconnect",
  );
  await waitForCondition(async () => {
    const persisted = await readPersistedState(instance).catch(() => null);
    return persisted && (persisted.sessions?.length ?? 0) === 0;
  }, SCENARIO_STATUS_TIMEOUT_MS, `${instance.name} kept its saved session after Disconnect.`);
  await showPairingView(instance, timeout);
  await waitForCondition(
    async () => !(await maybeFind(instance.driver, "syncd-replication-status")),
    SCENARIO_STATUS_TIMEOUT_MS,
    `${instance.name} still showed the connected screen after Disconnect.`,
  );
}

async function decideHost(host, decision) {
  await clickTestId(host.driver, decision === "approve" ? "syncd-host-approve" : "syncd-host-reject");
}

// After a decision or an expiry the spent code is no longer shown: the host returns to the start of pairing.
async function waitForHostBackToStart(host, timeout = SCENARIO_STATUS_TIMEOUT_MS) {
  await waitForCondition(
    async () => !(await maybeFind(host.driver, "syncd-host-status-live"))
      && Boolean(await maybeFind(host.driver, "syncd-host-start")),
    timeout,
    `${host.name} did not return to the start of pairing.`,
  );
}

async function revalidateSessions(joiner) {
  await showDetailsView(joiner);
  await clickTestId(joiner.driver, "syncd-revalidate-sessions");
}

// The panel no longer shows this per session. The file also holds the access token: read the status, never log the file.
async function waitForPersistedStatus(instance, expected, timeout = DEFAULT_TIMEOUT_MS) {
  let lastStatus = null;
  try {
    await waitForCondition(async () => {
      const persisted = await readPersistedState(instance).catch(() => null);
      lastStatus = persisted?.sessions?.[0]?.lastKnownStatus ?? null;
      return String(lastStatus).toLowerCase() === expected;
    }, timeout, `Timed out waiting for the saved session status ${expected}`);
  } catch (error) {
    throw new Error(`${error.message}; last seen: ${lastStatus ?? "none"}.`);
  }
}

async function waitForReplicationStatus(instance, expected, timeout = DEFAULT_TIMEOUT_MS) {
  await showPairingView(instance, timeout);
  await waitForStatus(instance.driver, "syncd-replication-status", expected, timeout);
}

async function assertNovelProgressReaches(source, target, marker, progressPercent) {
  const mutation = await mutateNovelFixture(source, { mode: "progress", marker, progressPercent });
  await waitForNovelProgress(target, progressPercent, DEFAULT_TIMEOUT_MS);
  return mutation;
}

async function runScenario() {
  await ensureDir(artifactsRoot);
  step("Native two-instance automation: scenario runner starting");

  const report = {
    startedAt: new Date().toISOString(),
    appBasePath,
    driverUrl,
    scenarios: [],
  };

  let host = null;
  let joiner = null;
  let expiryHost = null;
  let hostAlt = null;

  try {
    host = await launchDesktop("host", {
      localAppDataDir: path.join(tmpRoot, "host", "LocalAppData"),
      syncdPort: 4877,
      localServerPort: 4668,
      bootstrapTtlSeconds: 900,
    });

    step("Host smoke: bootstrap readiness");
    const smokeHostState = await startHostPairing(host, "host-smoke-pending");
    await waitForBootstrapPayloadReachable(smokeHostState.origin, smokeHostState.sessionId);
    report.hostSmoke = {
      hostOrigin: smokeHostState.origin,
      screenshot: path.join(artifactsRoot, "host-smoke-pending.png"),
    };

    joiner = await launchDesktop("joiner", {
      localAppDataDir: path.join(tmpRoot, "joiner", "LocalAppData"),
      syncdPort: 4977,
      localServerPort: 4768,
    });

    step("Scenario 1: discovery on the local network + approval + replication");
    // Read again: the QR renews itself if the wait for the second desktop outlived it.
    const hostState = await readHostQr(host);
    await selectDiscoveredPeer(joiner, host);
    step("  - joiner selected the discovered host");
    await saveScreenshot(joiner, "scenario1-joiner-options");
    await connectJoiner(joiner, hostState, { method: "qr-event" });
    step("  - joiner submitted the pairing package");
    try {
      await waitForStatus(host.driver, "syncd-host-status-live", "claimed", SCENARIO_STATUS_TIMEOUT_MS);
    } catch (error) {
      await captureHostDiagnostics(host, "scenario1-host-claimed-timeout");
      throw error;
    }
    step("  - host observed claimed");
    await waitForConnectStatus(joiner, "Claimed", SCENARIO_STATUS_TIMEOUT_MS, "scenario1-joiner-claimed-timeout");
    step("  - joiner observed claimed");
    const daemonReplacement = await replaceSyncdDaemon(host);
    step(`  - host Syncd daemon replaced (${daemonReplacement.previous.pid} -> ${daemonReplacement.next.pid})`);
    await waitForStatus(host.driver, "syncd-host-status-live", "claimed", SCENARIO_STATUS_TIMEOUT_MS);
    step("  - host pairing listener recovered after daemon replacement");
    await decideHost(host, "approve");
    step("  - host approved");
    try {
      await waitForHostBackToStart(host);
    } catch (error) {
      await captureHostDiagnostics(host, "scenario1-host-approved-timeout");
      throw error;
    }
    step("  - host closed the spent pairing");
    await waitForPersistedSessionOrigin(joiner, hostState.origin, SCENARIO_STATUS_TIMEOUT_MS);
    step("  - joiner persisted the approved host origin");
    await waitForPersistedSessionCount(joiner, 1);
    step("  - joiner persisted approved session");
    await waitForReplicationStatus(joiner, "Live", DEFAULT_TIMEOUT_MS);
    step("  - replication reached live");
    const hostNovelProgress = await assertNovelProgressReaches(host, joiner, "host-progress-1", 0.42);
    step("  - host novel progress replicated to joiner");

    const hostNovelBookmark = await mutateNovelFixture(host, {
      mode: "bookmark",
      marker: "host-bookmark-1",
      progressPercent: 0.42,
    });
    assertNovelBookmarkPlaced(joiner, await waitForNovelBookmark(joiner, hostNovelBookmark.bookmarkLabel, DEFAULT_TIMEOUT_MS));
    step("  - host novel bookmark replicated to joiner");

    // Every fixture writes the same novel and the waits accept "at least": values only go up, so each wait proves a new arrival.
    const joinerNovelProgress = await assertNovelProgressReaches(joiner, host, "joiner-progress-1", 0.5);
    step("  - joiner novel progress replicated back to host");

    const joinerNovelBookmark = await mutateNovelFixture(joiner, {
      mode: "bookmark",
      marker: "joiner-bookmark-1",
    });
    assertNovelBookmarkPlaced(host, await waitForNovelBookmark(host, joinerNovelBookmark.bookmarkLabel, DEFAULT_TIMEOUT_MS));
    step("  - joiner novel bookmark replicated back to host");

    await mutateNovelFixture(joiner, { mode: "clear_bookmarks" });
    await waitForNovelBookmarkRemoved(host, joinerNovelBookmark.bookmarkLabel);
    step("  - bookmark removed on the joiner left the host");

    const hostSecondBookmark = await mutateNovelFixture(host, {
      mode: "bookmark",
      marker: "host-bookmark-2",
    });
    assertNovelBookmarkPlaced(joiner, await waitForNovelBookmark(joiner, hostSecondBookmark.bookmarkLabel, DEFAULT_TIMEOUT_MS));
    await mutateNovelFixture(host, { mode: "clear_bookmarks" });
    await waitForNovelBookmarkRemoved(joiner, hostSecondBookmark.bookmarkLabel);
    step("  - bookmark removed on the host left the joiner");

    await assertSingleAuditNovel(host);
    await assertSingleAuditNovel(joiner);
    step("  - both desktops keep one copy of the novel");

    const hostBookProgress = await mutateBookFixture(host, {
      mode: "progress",
      marker: "host-book-progress-1",
      progressPercent: 0.33,
    });
    await waitForBookProgress(joiner, hostBookProgress.progressPercent, DEFAULT_TIMEOUT_MS);
    step("  - host book progress replicated to joiner");

    const joinerBookProgress = await mutateBookFixture(joiner, {
      mode: "progress",
      marker: "joiner-book-progress-1",
      progressPercent: 0.66,
    });
    await waitForBookProgress(host, joinerBookProgress.progressPercent, DEFAULT_TIMEOUT_MS);
    step("  - joiner book progress replicated back to host");

    const hostBookBookmark = await mutateBookFixture(host, {
      mode: "bookmark",
      marker: "host-book-bookmark-1",
      progressPercent: 0.66,
    });
    await waitForBookBookmark(joiner, hostBookBookmark.bookmarkLabel, DEFAULT_TIMEOUT_MS);
    step("  - host book bookmark replicated to joiner");

    await assertSingleAuditBook(host);
    await assertSingleAuditBook(joiner);
    step("  - both desktops keep one copy of the book and one reading position");

    report.scenarios.push({
      name: "discovery-approval-replication",
      hostOrigin: hostState.origin,
      daemonReplacement,
      replicated: {
        hostNovelId: hostNovelProgress.novelId,
        joinerNovelId: joinerNovelProgress.novelId,
      },
      details: await captureSessionDetails(joiner, "scenario1-joiner-details"),
      screenshot: await saveScreenshot(joiner, "scenario1-joiner-connected"),
    });

    step("Scenario 2: restart joiner + saved session + pause/resume/reconnect");
    joiner = await restartDesktop(joiner);
    await waitForPersistedSessionCount(joiner, 1);
    await waitForPersistedStatus(joiner, "connected");
    await waitForReplicationStatus(joiner, "Live", DEFAULT_TIMEOUT_MS);
    step("  - saved session came back live");
    await clickTestId(joiner.driver, "syncd-replication-toggle");
    await waitForReplicationStatus(joiner, "Paused", DEFAULT_TIMEOUT_MS);
    step("  - replication paused");
    await mutateNovelFixture(host, {
      mode: "progress",
      marker: "host-progress-while-paused",
      progressPercent: 0.55,
    });
    await joiner.driver.sleep(5_000);
    const pausedProgress = auditNovelProgress(await readNovelPersistence(joiner));
    if (Number(pausedProgress?.progressPercent ?? 0) >= 0.55) {
      throw new Error("Replication kept applying changes while paused.");
    }
    step("  - nothing arrived while paused");
    await clickTestId(joiner.driver, "syncd-replication-toggle");
    await waitForReplicationStatus(joiner, "Live", DEFAULT_TIMEOUT_MS);
    await waitForNovelProgress(joiner, 0.55, DEFAULT_TIMEOUT_MS);
    step("  - replication resumed and caught up with what changed while paused");
    await clickTestId(joiner.driver, "syncd-replication-reconnect");
    await waitForReplicationStatus(joiner, "Live", DEFAULT_TIMEOUT_MS);
    step("  - replication reconnected");
    report.scenarios.push({
      name: "restart-pause-resume-reconnect",
      screenshot: await saveScreenshot(joiner, "scenario2-joiner-restarted"),
    });

    step("Scenario 3: disconnect + pair with another desktop");
    await disconnectSession(joiner);
    step("  - joiner disconnected and returned to the start of pairing");
    hostAlt = await launchDesktop("host-alt", {
      localAppDataDir: path.join(tmpRoot, "host-alt", "LocalAppData"),
      syncdPort: 5177,
      localServerPort: 4968,
      bootstrapTtlSeconds: 900,
    });
    const altHostState = await startHostPairing(hostAlt, "scenario3-host-alt-pending");
    await connectJoiner(joiner, altHostState, { method: "qr-event", manualOrigin: altHostState.origin });
    await waitForStatus(hostAlt.driver, "syncd-host-status-live", "claimed");
    await waitForConnectStatus(joiner, "Claimed", DEFAULT_TIMEOUT_MS, "scenario3-joiner-claimed-timeout");
    await decideHost(hostAlt, "approve");
    await waitForHostBackToStart(hostAlt);
    await waitForPersistedSessionOrigin(joiner, altHostState.origin, DEFAULT_TIMEOUT_MS);
    await waitForPersistedSessionCount(joiner, 1);
    await waitForReplicationStatus(joiner, "Live", DEFAULT_TIMEOUT_MS);
    step("  - joiner live with the second desktop");
    await assertNovelProgressReaches(hostAlt, joiner, "alt-progress-1", 0.77);
    step("  - second desktop's progress replicated to joiner");
    await assertNovelProgressReaches(joiner, hostAlt, "joiner-to-alt-progress-1", 0.88);
    step("  - joiner's progress replicated to the second desktop");
    report.scenarios.push({
      name: "disconnect-and-pair-another-desktop",
      activeOrigin: altHostState.origin,
      screenshot: await saveScreenshot(joiner, "scenario3-joiner-second-desktop"),
    });

    step("Scenario 4: unreachable remote on revalidation");
    // In this order: while the desktop is open, its Sync panel would start the Core again.
    await closeDesktop(hostAlt);
    await shutdownOwnCore(hostAlt);
    hostAlt = null;
    await revalidateSessions(joiner);
    await waitForPersistedStatus(joiner, "unreachable");
    report.scenarios.push({
      name: "unreachable-revalidation",
      screenshot: await saveScreenshot(joiner, "scenario4-joiner-unreachable"),
    });
    await showPairingView(joiner);
    await disconnectSession(joiner);
    step("  - a desktop that went away can still be disconnected");

    step("Scenario 5: typed address + pasted package + rejection");
    const manualHostState = await startHostPairing(host, "scenario5-host-pending");
    await connectJoiner(joiner, manualHostState, { method: "paste", manualOrigin: manualHostState.origin });
    await waitForStatus(host.driver, "syncd-host-status-live", "claimed");
    await waitForConnectStatus(joiner, "Claimed", DEFAULT_TIMEOUT_MS, "scenario5-joiner-claimed-timeout");
    await decideHost(host, "reject");
    await waitForHostBackToStart(host);
    await waitForConnectStatus(joiner, "Rejected", DEFAULT_TIMEOUT_MS, "scenario5-joiner-rejected-timeout");
    await waitForPersistedSessionCount(joiner, 0);
    report.scenarios.push({
      name: "manual-origin-rejection",
      screenshot: await saveScreenshot(joiner, "scenario5-joiner-rejected"),
    });

    step("Scenario 6: QR image file + approval");
    const qrHostState = await startHostPairing(host, "scenario6-host-pending");
    await waitForBootstrapPayloadReachable(qrHostState.origin, qrHostState.sessionId);
    await connectJoiner(joiner, qrHostState, { method: "qr-file", manualOrigin: "" });
    await waitForConnectStatus(joiner, "Claimed", DEFAULT_TIMEOUT_MS, "scenario6-joiner-claimed-timeout");
    try {
      await waitForStatus(host.driver, "syncd-host-status-live", "claimed");
    } catch (error) {
      await captureHostDiagnostics(host, "scenario6-host-claimed-timeout");
      throw error;
    }
    await decideHost(host, "approve");
    await waitForHostBackToStart(host);
    await waitForPersistedSessionOrigin(joiner, qrHostState.origin, DEFAULT_TIMEOUT_MS);
    await waitForReplicationStatus(joiner, "Live", DEFAULT_TIMEOUT_MS);
    await assertNovelProgressReaches(host, joiner, "host-progress-after-repair", 0.95);
    step("  - pairing the same desktop again replicates");
    report.scenarios.push({
      name: "qr-file-approval",
      screenshot: await saveScreenshot(joiner, "scenario6-joiner-connected-qr"),
    });
    await disconnectSession(joiner);

    step("Scenario 7: expiry after live claim");
    expiryHost = await launchDesktop("host-expiry", {
      localAppDataDir: path.join(tmpRoot, "host-expiry", "LocalAppData"),
      syncdPort: 5077,
      localServerPort: 4868,
      bootstrapTtlSeconds: 15,
    });
    const expiryHostState = await startHostPairing(expiryHost, "scenario7-host-pending");
    await connectJoiner(joiner, expiryHostState, { method: "qr-event", manualOrigin: expiryHostState.origin });
    await waitForStatus(expiryHost.driver, "syncd-host-status-live", "claimed");
    await waitForConnectStatus(joiner, "Claimed", DEFAULT_TIMEOUT_MS, "scenario7-joiner-claimed-timeout");
    await waitForHostBackToStart(expiryHost, SCENARIO_STATUS_TIMEOUT_MS);
    await waitForConnectStatus(joiner, "Expired", SCENARIO_STATUS_TIMEOUT_MS, "scenario7-joiner-expired-timeout");
    await waitForPersistedSessionCount(joiner, 0);
    report.scenarios.push({
      name: "expiry",
      screenshot: await saveScreenshot(joiner, "scenario7-joiner-expired"),
    });

    report.finishedAt = new Date().toISOString();
    report.status = "pass";
    await snapshotJson("syncd-native-two-instance-report", report);
    return report;
  } catch (error) {
    // What each desktop was showing when the run stopped: nothing can be asked of them after the teardown.
    for (const instance of [host, joiner, hostAlt, expiryHost]) {
      if (instance?.driver) {
        await captureFailureView(instance).catch(() => {});
      }
    }
    throw error;
  } finally {
    await closeDesktop(hostAlt);
    await closeDesktop(expiryHost);
    await closeDesktop(host);
    await closeDesktop(joiner);
    for (const profile of launchedProfiles.values()) {
      await shutdownOwnCore(profile).catch((error) => {
        step(`${profile.name}: its Core did not confirm it stopped (${error instanceof Error ? error.message : String(error)})`);
      });
    }
  }
}

runScenario()
  .then(async (report) => {
    step(`Native two-instance automation passed: ${report.scenarios.length} scenarios.`);
  })
  .catch(async (error) => {
    const failure = {
      status: "fail",
      failedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? null : null,
    };
    await snapshotJson("syncd-native-two-instance-failure", failure);
    process.stderr.write(`${failure.message}\n`);
    process.exitCode = 1;
  });
