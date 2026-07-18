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
  args.app || path.join(projectRoot, "src-tauri", "target", "release", "aethon.exe"),
);

const DEFAULT_TIMEOUT_MS = 120_000;
const SHORT_TIMEOUT_MS = 15_000;
const BOOTSTRAP_REACHABILITY_TIMEOUT_MS = 15_000;
const APP_BOOT_TIMEOUT_MS = 180_000;
const SCENARIO_STATUS_TIMEOUT_MS = 45_000;

function normalizeVisibleText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

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

async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value, "utf8");
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

  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", {
    application: appBasePath,
    args: launchArgs,
    webviewOptions: {
      userDataFolder: path.join(options.localAppDataDir, "WebView2Automation"),
      additionalBrowserArguments: ["--remote-debugging-port=0"],
    },
  });

  step(`launchDesktop(${name}): building webdriver session`);
  const driver = await new Builder()
    .usingServer(driverUrl)
    .withCapabilities(capabilities)
    .build();

  step(`launchDesktop(${name}): webdriver session ready`);
  await driver.manage().setTimeouts({
    implicit: 0,
    pageLoad: DEFAULT_TIMEOUT_MS,
    script: DEFAULT_TIMEOUT_MS,
  });

  step(`launchDesktop(${name}): waiting for audit shell`);
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

async function killListeningProcessOnPort(port) {
  if (!port) return;

  const script = `
    $listenerPids = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
    if (-not $listenerPids) { exit 0 }
    foreach ($listenerPid in $listenerPids) {
      taskkill /PID $listenerPid /F /T | Out-Null
    }
  `;

  try {
    await execFileAsync("powershell", ["-NoProfile", "-Command", script], {
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to kill listener on port ${port}: ${message}`);
  }
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

async function waitForTestId(driver, id, timeout = DEFAULT_TIMEOUT_MS) {
  const locator = testId(id);
  await driver.wait(until.elementLocated(locator), timeout, `Timed out waiting for ${id}.`);
  const element = await driver.findElement(locator);
  await driver.wait(until.elementIsVisible(element), timeout).catch(() => element);
  return element;
}

async function maybeFind(driver, id) {
  const elements = await driver.findElements(testId(id));
  return elements[0] ?? null;
}

async function clickTestId(driver, id, timeout = DEFAULT_TIMEOUT_MS) {
  const element = await waitForTestId(driver, id, timeout);
  await driver.executeScript(
    "arguments[0].scrollIntoView({ block: 'center', inline: 'center' });",
    element,
  );
  await driver.wait(until.elementIsEnabled(element), timeout);
  await driver.executeScript("arguments[0].click();", element);
}

async function waitForAuditShellReady(driver, timeout = DEFAULT_TIMEOUT_MS, label = "app") {
  const deadline = Date.now() + timeout;
  let lastHeartbeatAt = 0;
  let lastState = null;

  while (Date.now() < deadline) {
    try {
      lastState = await driver.executeScript(`
        const audit = window.__aethonAudit;
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

  throw new Error(`Timed out waiting for the Aethon shell to become automation-ready (${label}).`);
}

async function waitForPanelSubscriptionsReady(driver, timeout = DEFAULT_TIMEOUT_MS) {
  await waitForTestId(driver, "syncd-host-start", timeout);
  await driver.wait(
    until.elementLocated(testId("syncd-connect-refresh-peers")),
    timeout,
    "Timed out locating the Syncd options controls.",
  );

  try {
    await driver.wait(async () => {
      try {
        return await driver.executeScript(`
          const panel = document.querySelector('[data-testid="syncd-panel-grid"]');
          return panel?.getAttribute('data-panel-ready') === 'ready';
        `);
      } catch {
        return false;
      }
    }, SHORT_TIMEOUT_MS, "Timed out waiting for the syncd panel subscriptions to become ready.");
  } catch {
    const panelError = await readOptionalText(driver, "syncd-panel-error");
    if (panelError) {
      throw new Error(`Syncd panel reported an error before subscriptions were ready: ${panelError}`);
    }
  }
}

async function openSyncdModalView(instance, view, timeout = DEFAULT_TIMEOUT_MS) {
  const trigger = await waitForTestId(instance.driver, `syncd-modal-${view}`, timeout);
  if ((await trigger.getAttribute("aria-pressed")) !== "true") {
    await instance.driver.executeScript("arguments[0].click();", trigger);
  }
  await instance.driver.wait(
    async () => (await trigger.getAttribute("aria-pressed")) === "true",
    timeout,
    `Timed out opening the Syncd ${view} view.`,
  );
}

async function openSecuritySettings(driver, timeout = DEFAULT_TIMEOUT_MS) {
  await driver.executeScript(`
    if (!window.__aethonAudit?.openSettings) {
      throw new Error("Aethon audit bridge is not available.");
    }
    window.__aethonAudit.openSettings("security");
  `);

  await driver.wait(async () => {
    try {
      return await driver.executeScript(`
        return !!window.__aethonAudit?.getState
          && window.__aethonAudit.getState().navPage === "settings"
          && window.__aethonAudit.getState().settingsOpen === true;
      `);
    } catch {
      return false;
    }
  }, timeout, "Timed out waiting for Security settings to open.");
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
          const audit = window.__aethonAudit;
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

async function getText(driver, id, timeout = DEFAULT_TIMEOUT_MS) {
  const element = await waitForTestId(driver, id, timeout);
  return (await element.getText()).trim();
}

async function getValue(driver, id, timeout = DEFAULT_TIMEOUT_MS) {
  const locator = testId(id);
  await driver.wait(until.elementLocated(locator), timeout, `Timed out waiting for ${id}.`);
  const element = await driver.findElement(locator);
  return driver.executeScript("return arguments[0].value;", element);
}

async function waitForText(driver, id, expected, timeout = DEFAULT_TIMEOUT_MS) {
  const normalizedExpected = normalizeVisibleText(expected);
  await driver.wait(async () => {
    const text = await getText(driver, id, SHORT_TIMEOUT_MS).catch(() => "");
    return normalizeVisibleText(text) === normalizedExpected;
  }, timeout, `Timed out waiting for ${id} to equal ${expected}.`);
}

async function waitForNonEmptyValue(driver, id, timeout = DEFAULT_TIMEOUT_MS) {
  await driver.wait(async () => {
    const value = await getValue(driver, id, SHORT_TIMEOUT_MS).catch(() => "");
    return typeof value === "string" && value.trim().length > 0;
  }, timeout, `Timed out waiting for ${id} to become non-empty.`);
}

async function waitForValueContaining(driver, id, expectedFragment, timeout = DEFAULT_TIMEOUT_MS) {
  await driver.wait(async () => {
    const value = await getValue(driver, id, SHORT_TIMEOUT_MS).catch(() => "");
    return typeof value === "string" && value.includes(expectedFragment);
  }, timeout, `Timed out waiting for ${id} to contain ${expectedFragment}.`);
}

async function waitForValueEquals(driver, id, expectedValue, timeout = DEFAULT_TIMEOUT_MS) {
  await driver.wait(async () => {
    const value = await getValue(driver, id, SHORT_TIMEOUT_MS).catch(() => "");
    return value === expectedValue;
  }, timeout, `Timed out waiting for ${id} to equal the expected value.`);
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
  try {
    return await getText(driver, id, SHORT_TIMEOUT_MS);
  } catch {
    return "";
  }
}

async function readOptionalValue(driver, id) {
  try {
    return await getValue(driver, id, SHORT_TIMEOUT_MS);
  } catch {
    return "";
  }
}

async function captureHostDiagnostics(host, name) {
  const hostCardText = await host.driver
    .findElements(testId("syncd-host-card"))
    .then(async (elements) => {
      if (!elements.length) return "";
      return host.driver.executeScript("return arguments[0].innerText;", elements[0]);
    })
    .catch(() => "");

  const payload = {
    hostStatus: await readOptionalText(host.driver, "syncd-host-status"),
    hostStatusLive: await readOptionalText(host.driver, "syncd-host-status-live"),
    hostStartStage: await readOptionalText(host.driver, "syncd-host-start-stage"),
    panelError: await readOptionalText(host.driver, "syncd-panel-error"),
    hostError: await readOptionalText(host.driver, "syncd-host-error"),
    hostCardText,
    bootstrapBundleLength: (await readOptionalValue(host.driver, "syncd-bootstrap-bundle-host")).length,
    auditState: await host.driver
      .executeScript("return window.__aethonAudit?.getState?.() ?? null;")
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
  const connectCardText = await joiner.driver
    .findElements(testId("syncd-connect-card"))
    .then(async (elements) => {
      if (!elements.length) return "";
      return joiner.driver.executeScript("return arguments[0].innerText;", elements[0]);
    })
    .catch(() => "");

  const connectStateText = await joiner.driver
    .findElements(testId("syncd-connect-state"))
    .then(async (elements) => {
      if (!elements.length) return "";
      return joiner.driver.executeScript("return arguments[0].innerText;", elements[0]);
    })
    .catch(() => "");

  const payload = {
    connectStatus: await readOptionalText(joiner.driver, "syncd-connect-status"),
    connectError: await readOptionalText(joiner.driver, "syncd-connect-error"),
    panelError: await readOptionalText(joiner.driver, "syncd-panel-error"),
    manualOrigin: await readOptionalValue(joiner.driver, "syncd-manual-origin"),
    bootstrapBundleLength: (await readOptionalValue(joiner.driver, "syncd-bootstrap-bundle-input")).length,
    refreshPeersDisabled: await joiner.driver
      .findElements(testId("syncd-connect-refresh-peers"))
      .then(async (elements) => {
        if (!elements.length) return null;
        return joiner.driver.executeScript(
          "return !!arguments[0].disabled || arguments[0].getAttribute('aria-disabled') === 'true';",
          elements[0],
        );
      })
      .catch(() => null),
    connectSubmitDisabled: await joiner.driver
      .findElements(testId("syncd-connect-submit"))
      .then(async (elements) => {
        if (!elements.length) return null;
        return joiner.driver.executeScript(
          "return !!arguments[0].disabled || arguments[0].getAttribute('aria-disabled') === 'true';",
          elements[0],
        );
      })
      .catch(() => null),
    peerCount: await joiner.driver.findElements(testId("syncd-peer-item")).then((elements) => elements.length).catch(() => null),
    panelReady: await joiner.driver
      .executeScript("return document.querySelector('[data-testid=\"syncd-panel-grid\"]')?.getAttribute('data-panel-ready') ?? null;")
      .catch(() => null),
    connectCardText,
    connectStateText,
    auditState: await joiner.driver
      .executeScript("return window.__aethonAudit?.getState?.() ?? null;")
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

async function waitForPeerCount(instance, minimum, timeout = DEFAULT_TIMEOUT_MS) {
  await openSyncdModalView(instance, "options", timeout);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const items = await instance.driver.findElements(testId("syncd-peer-item"));
    if (items.length >= minimum) {
      return items;
    }
    await clickTestId(instance.driver, "syncd-connect-refresh-peers").catch(() => {});
    await instance.driver.sleep(1_000);
  }
  throw new Error(`Timed out waiting for ${minimum} discovered peer(s).`);
}

async function readHostState(host) {
  const bundleRaw = await getValue(host.driver, "syncd-bootstrap-bundle-host");
  const bundle = JSON.parse(bundleRaw);
  return {
    status: await getText(host.driver, "syncd-host-status-live"),
    bundle,
    bootstrapBundleRaw: bundleRaw,
    advertisedOrigin: bundle.syncdBaseUrl,
  };
}

async function startHostPairing(host, screenshotName) {
  await clickTestId(host.driver, "syncd-host-start");
  try {
    await waitForNonEmptyValue(host.driver, "syncd-bootstrap-bundle-host");
    await waitForText(host.driver, "syncd-host-status-live", "Pending");
  } catch (error) {
    await captureHostDiagnostics(host, screenshotName || "host-bootstrap-readiness-failure");
    throw error;
  }
  if (screenshotName) {
    await saveScreenshot(host, screenshotName);
  }
  const state = await readHostState(host);
  host.currentBootstrapSessionId = state.bundle.pairingSessionId;
  host.currentAdvertisedOrigin = state.bundle.syncdBaseUrl;
  return state;
}

async function connectJoiner(joiner, { bundleRaw, manualOrigin = null, useQrPath = null, useQrDataUrl = null }) {
  await openSyncdModalView(joiner, "options");
  if (manualOrigin !== null) {
    await setInputValue(joiner.driver, "syncd-manual-origin", manualOrigin);
  } else {
    await setInputValue(joiner.driver, "syncd-manual-origin", "");
  }

  if (useQrDataUrl) {
    await setInputValue(joiner.driver, "syncd-bootstrap-bundle-input", "");
    await joiner.driver.executeScript(
      `
        window.dispatchEvent(
          new CustomEvent("aethon:syncd-import-qr-data-url", {
            detail: arguments[0],
          }),
        );
      `,
      useQrDataUrl,
    );
    await waitForValueEquals(joiner.driver, "syncd-bootstrap-bundle-input", bundleRaw, SHORT_TIMEOUT_MS);
    await joiner.driver.sleep(500);
  } else if (useQrPath) {
    await setInputValue(joiner.driver, "syncd-bootstrap-bundle-input", "");
    const input = await waitForTestId(joiner.driver, "syncd-qr-file-input");
    await joiner.driver.executeScript(
      `
        arguments[0].style.display = "block";
        arguments[0].style.position = "static";
        arguments[0].style.opacity = "1";
        arguments[0].style.visibility = "visible";
      `,
      input,
    );
    await input.sendKeys(useQrPath);
    await joiner.driver.executeScript(
      `
        arguments[0].dispatchEvent(new Event("input", { bubbles: true }));
        arguments[0].dispatchEvent(new Event("change", { bubbles: true }));
      `,
      input,
    );
    await waitForValueEquals(joiner.driver, "syncd-bootstrap-bundle-input", bundleRaw, SHORT_TIMEOUT_MS);
    await joiner.driver.sleep(500);
  } else {
    await setInputValue(joiner.driver, "syncd-bootstrap-bundle-input", bundleRaw);
    await waitForValueEquals(joiner.driver, "syncd-bootstrap-bundle-input", bundleRaw);
  }

  const importedBundle = await getValue(joiner.driver, "syncd-bootstrap-bundle-input");
  await clickTestId(joiner.driver, "syncd-connect-submit");
  return {
    importedBundle,
    manualOrigin: await readOptionalValue(joiner.driver, "syncd-manual-origin"),
  };
}

async function waitForConnectStatus(joiner, status, timeout = DEFAULT_TIMEOUT_MS, diagnosticsName = null) {
  try {
    await waitForText(joiner.driver, "syncd-connect-status", status, timeout);
  } catch (error) {
    if (diagnosticsName) {
      await captureJoinerDiagnostics(joiner, diagnosticsName);
    }
    throw error;
  }
  return {
    status: await getText(joiner.driver, "syncd-connect-status"),
    remoteOrigin: await joiner.driver
      .findElement(testId("syncd-connect-state"))
      .then((element) => joiner.driver.executeScript("return arguments[0].innerText;", element)),
  };
}

async function waitForPersistedSessionCount(joiner, expectedCount, timeout = DEFAULT_TIMEOUT_MS) {
  await joiner.driver.wait(async () => {
    const items = await joiner.driver.findElements(testId("syncd-persisted-session-item"));
    return items.length >= expectedCount;
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
    "Aethon",
    "syncd-desktop",
    "syncd-desktop-state.json",
  );
  const raw = await fs.readFile(statePath, "utf8");
  return JSON.parse(raw);
}

async function readBookPersistence(instance) {
  return callAudit(instance, "readBookLibraryPersistence");
}

async function readNovelPersistence(instance) {
  return callAudit(instance, "readNovelLibraryPersistence");
}

async function mutateBookFixture(instance, input) {
  return callAudit(instance, "mutateSyncdAuditBookFixture", input);
}

async function mutateNovelFixture(instance, input) {
  return callAudit(instance, "mutateSyncdAuditNovelFixture", input);
}

async function waitForBookProgress(instance, bookId, minimumProgress, timeout = DEFAULT_TIMEOUT_MS) {
  try {
    return await waitForCondition(async () => {
      const persistence = await readBookPersistence(instance);
      const entry = persistence?.state?.bookProgress?.find?.((candidate) => candidate.bookId === bookId) ?? null;
      if (entry && Number(entry.progressPercent ?? 0) >= minimumProgress) {
        return { persistence, entry };
      }
      return null;
    }, timeout, `Timed out waiting for book progress ${bookId} >= ${minimumProgress}.`);
  } catch (error) {
    await snapshotJson(`book-progress-timeout-${instance.name}`, {
      bookId,
      minimumProgress,
      persistence: await readBookPersistence(instance).catch((readError) => ({
        readError: readError instanceof Error ? readError.message : String(readError),
      })),
    });
    throw error;
  }
}

async function waitForBookBookmark(instance, bookId, expectedLabel, timeout = DEFAULT_TIMEOUT_MS) {
  try {
    return await waitForCondition(async () => {
      const persistence = await readBookPersistence(instance);
      const entry = persistence?.state?.bookBookmarks?.find?.(
        (candidate) => candidate.bookId === bookId && candidate.label === expectedLabel,
      ) ?? null;
      if (entry) {
        return { persistence, entry };
      }
      return null;
    }, timeout, `Timed out waiting for book bookmark ${expectedLabel}.`);
  } catch (error) {
    await snapshotJson(`book-bookmark-timeout-${instance.name}`, {
      bookId,
      expectedLabel,
      persistence: await readBookPersistence(instance).catch((readError) => ({
        readError: readError instanceof Error ? readError.message : String(readError),
      })),
    });
    throw error;
  }
}

async function waitForNovelProgress(instance, novelId, minimumProgress, timeout = DEFAULT_TIMEOUT_MS) {
  try {
    return await waitForCondition(async () => {
      const persistence = await readNovelPersistence(instance);
      const entry = persistence?.state?.progress?.find?.((candidate) => candidate.novelId === novelId) ?? null;
      if (entry && Number(entry.progressPercent ?? 0) >= minimumProgress) {
        return { persistence, entry };
      }
      return null;
    }, timeout, `Timed out waiting for novel progress ${novelId} >= ${minimumProgress}.`);
  } catch (error) {
    await snapshotJson(`novel-progress-timeout-${instance.name}`, {
      novelId,
      minimumProgress,
      persistence: await readNovelPersistence(instance).catch((readError) => ({
        readError: readError instanceof Error ? readError.message : String(readError),
      })),
    });
    throw error;
  }
}

async function waitForNovelBookmark(instance, novelId, expectedLabel, timeout = DEFAULT_TIMEOUT_MS) {
  try {
    return await waitForCondition(async () => {
      const persistence = await readNovelPersistence(instance);
      const entry = persistence?.state?.bookmarks?.find?.(
        (candidate) => candidate.novelId === novelId && candidate.label === expectedLabel,
      ) ?? null;
      if (entry) {
        return { persistence, entry };
      }
      return null;
    }, timeout, `Timed out waiting for novel bookmark ${expectedLabel}.`);
  } catch (error) {
    await snapshotJson(`novel-bookmark-timeout-${instance.name}`, {
      novelId,
      expectedLabel,
      persistence: await readNovelPersistence(instance).catch((readError) => ({
        readError: readError instanceof Error ? readError.message : String(readError),
      })),
    });
    throw error;
  }
}

function sessionActionSelector(testIdValue, sessionKey) {
  const escaped = String(sessionKey).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return By.css(`[data-testid="${testIdValue}"][data-session-key="${escaped}"]`);
}

function sessionRowSelector(sessionKey) {
  const escaped = String(sessionKey).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return By.css(`[data-testid="syncd-persisted-session-item"][data-session-key="${escaped}"]`);
}

async function clickSessionAction(instance, testIdValue, sessionKey, timeout = DEFAULT_TIMEOUT_MS) {
  await openSyncdModalView(instance, "details", timeout);
  const locator = sessionActionSelector(testIdValue, sessionKey);
  const rowLocator = sessionRowSelector(sessionKey);
  await instance.driver.wait(until.elementLocated(rowLocator), timeout, `Timed out waiting for session row ${sessionKey}.`);
  const row = await instance.driver.findElement(rowLocator);
  const existingActions = await instance.driver.findElements(locator);
  if (existingActions.length === 0) {
    const trigger = await row.findElement(By.css(".syncd-session-trigger"));
    await instance.driver.executeScript(
      "arguments[0].scrollIntoView({ block: 'center', inline: 'center' });",
      trigger,
    );
    await instance.driver.wait(until.elementIsEnabled(trigger), timeout);
    await instance.driver.executeScript("arguments[0].click();", trigger);
  }
  await instance.driver.wait(until.elementLocated(locator), timeout, `Timed out waiting for ${testIdValue} on ${sessionKey}.`);
  const element = await instance.driver.findElement(locator);
  await instance.driver.executeScript(
    "arguments[0].scrollIntoView({ block: 'center', inline: 'center' });",
    element,
  );
  await instance.driver.wait(until.elementIsEnabled(element), timeout);
  await instance.driver.executeScript("arguments[0].click();", element);
}

async function openSessionPopover(instance, sessionKey, timeout = DEFAULT_TIMEOUT_MS) {
  await openSyncdModalView(instance, "details", timeout);
  const rowLocator = sessionRowSelector(sessionKey);
  await instance.driver.wait(until.elementLocated(rowLocator), timeout, `Timed out waiting for session row ${sessionKey}.`);
  const row = await instance.driver.findElement(rowLocator);
  const trigger = await row.findElement(By.css(".syncd-session-trigger"));
  await instance.driver.executeScript(
    "arguments[0].scrollIntoView({ block: 'center', inline: 'center' });",
    trigger,
  );
  await instance.driver.wait(until.elementIsEnabled(trigger), timeout);
  const popoverId = await trigger.getAttribute("aria-controls");
  if (!popoverId) {
    throw new Error(`Session trigger ${sessionKey} does not expose aria-controls.`);
  }
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await instance.driver.executeScript("arguments[0].click();", trigger);
  }
  const popover = await instance.driver.wait(
    until.elementLocated(By.id(popoverId)),
    timeout,
    `Timed out waiting for session popover ${sessionKey}.`,
  );
  await instance.driver.wait(until.elementIsVisible(popover), timeout);
  return { row, trigger, popover };
}

async function captureSessionVisualState(instance, name, sessionKey) {
  const { row, trigger, popover } = await openSessionPopover(instance, sessionKey);
  const computed = await instance.driver.executeScript(
    `
      const readRect = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
        };
      };
      const readStyle = (element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          borderColor: style.borderColor,
          borderRadius: style.borderRadius,
          boxShadow: style.boxShadow,
          backdropFilter: style.backdropFilter,
          color: style.color,
          opacity: style.opacity,
          zIndex: style.zIndex,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          padding: style.padding,
          gap: style.gap,
          width: style.width,
          height: style.height,
        };
      };
      const rootStyle = getComputedStyle(document.documentElement);
      const syncdTokens = {};
      for (let index = 0; index < rootStyle.length; index += 1) {
        const name = rootStyle.item(index);
        if (name.startsWith('--component-syncd-')) {
          syncdTokens[name] = rootStyle.getPropertyValue(name).trim();
        }
      }
      const actions = [...arguments[2].querySelectorAll('button')].map((button) => ({
        testId: button.getAttribute('data-testid'),
        label: button.textContent?.trim() ?? '',
        disabled: button.disabled || button.getAttribute('aria-disabled') === 'true',
      }));
      return {
        viewport: { width: innerWidth, height: innerHeight },
        semanticTokens: {
          '--text-primary': rootStyle.getPropertyValue('--text-primary').trim(),
        },
        row: { rect: readRect(arguments[0]), style: readStyle(arguments[0]) },
        trigger: {
          rect: readRect(arguments[1]),
          style: readStyle(arguments[1]),
          ariaExpanded: arguments[1].getAttribute('aria-expanded'),
        },
        popover: { rect: readRect(arguments[2]), style: readStyle(arguments[2]) },
        actions,
        syncdTokens,
      };
    `,
    row,
    trigger,
    popover,
  );
  const screenshot = await saveScreenshot(instance, name);
  const computedStyles = await snapshotJson(`${name}-computed`, computed);
  const close = await popover.findElement(By.css(".syncd-session-popover__close"));
  await instance.driver.executeScript("arguments[0].click();", close);
  await instance.driver.wait(async () => (await trigger.getAttribute("aria-expanded")) === "false", SHORT_TIMEOUT_MS);
  return { screenshot, computedStyles };
}

async function extractQrToFile(host, filePath) {
  const image = await waitForTestId(host.driver, "syncd-host-qr-image");
  await host.driver.wait(async () => {
    try {
      const sessionId = await image.getAttribute("data-session-id");
      const origin = await image.getAttribute("data-origin");
      return sessionId === host.currentBootstrapSessionId
        && origin === host.currentAdvertisedOrigin;
    } catch {
      return false;
    }
  }, DEFAULT_TIMEOUT_MS, "Timed out waiting for the rendered host QR image to match the active bootstrap session.");
  const dataUrl = await host.driver.executeScript("return arguments[0].src;", image);
  const match = /^data:image\/png;base64,(.+)$/i.exec(dataUrl);
  if (!match) {
    throw new Error("Host QR image was not a PNG data URL.");
  }
  await fs.writeFile(filePath, Buffer.from(match[1], "base64"));
  return dataUrl;
}

async function useFirstPeerOrigin(joiner) {
  const peers = await waitForPeerCount(joiner, 1);
  const button = await peers[0].findElement(testId("syncd-peer-use-origin"));
  await joiner.driver.executeScript("arguments[0].click();", button);
}

async function decideHost(host, decision) {
  await clickTestId(host.driver, decision === "approve" ? "syncd-host-approve" : "syncd-host-reject");
}

async function revalidateSessions(joiner) {
  await openSyncdModalView(joiner, "options");
  await clickTestId(joiner.driver, "syncd-revalidate-sessions");
}

async function waitForPersistedStatusText(joiner, expected, timeout = DEFAULT_TIMEOUT_MS) {
  await openSyncdModalView(joiner, "details", timeout);
  const normalizedExpected = normalizeVisibleText(expected);
  await joiner.driver.wait(async () => {
    const items = await joiner.driver.findElements(testId("syncd-persisted-session-item"));
    if (!items.length) return false;
    const text = await items[0].getText();
    return normalizeVisibleText(text).includes(normalizedExpected);
  }, timeout, `Timed out waiting for persisted session status ${expected}.`);
}

async function waitForReplicationStatus(instance, expected, timeout = DEFAULT_TIMEOUT_MS) {
  await openSyncdModalView(instance, "pairing", timeout);
  await waitForText(instance.driver, "syncd-replication-status", expected, timeout);
}

async function waitForActiveSessionKey(instance, expectedSessionKey, timeout = DEFAULT_TIMEOUT_MS) {
  await openSyncdModalView(instance, "pairing", timeout);
  await waitForValueContaining(instance.driver, "syncd-replication-active-session", expectedSessionKey, timeout)
    .catch(async () => {
      await instance.driver.wait(async () => {
        const text = await getText(instance.driver, "syncd-replication-active-session", SHORT_TIMEOUT_MS).catch(() => "");
        return text === expectedSessionKey;
      }, timeout, `Timed out waiting for active replication session ${expectedSessionKey}.`);
    });
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
    report.hostSmoke = {
      hostOrigin: smokeHostState.bundle.syncdBaseUrl,
      screenshot: path.join(artifactsRoot, "host-smoke-pending.png"),
    };

    joiner = await launchDesktop("joiner", {
      localAppDataDir: path.join(tmpRoot, "joiner", "LocalAppData"),
      syncdPort: 4977,
      localServerPort: 4768,
    });

    step("Scenario 1: host-ready launch + mDNS discovery + approval + replication");
    // The two WebView subscription waits can outlive the short-lived smoke
    // package. Refresh only after both desktops are ready for the scenario.
    const hostState = await startHostPairing(host, "scenario1-host-pending");
    step("  - host pairing is pending");
    try {
      await openSyncdModalView(joiner, "options");
      await clickTestId(joiner.driver, "syncd-connect-refresh-peers");
    } catch (error) {
      await captureJoinerDiagnostics(joiner, "scenario1-joiner-refresh-timeout");
      throw error;
    }
    step("  - joiner refresh requested");
    await useFirstPeerOrigin(joiner);
    step("  - joiner selected first discovered origin");
    await saveScreenshot(joiner, "scenario1-joiner-options");
    await connectJoiner(joiner, { bundleRaw: hostState.bootstrapBundleRaw });
    step("  - joiner submitted bootstrap bundle");
    try {
      await waitForText(host.driver, "syncd-host-status-live", "Claimed", SCENARIO_STATUS_TIMEOUT_MS);
    } catch (error) {
      await captureHostDiagnostics(host, "scenario1-host-claimed-timeout");
      throw error;
    }
    step("  - host observed claimed");
    await waitForConnectStatus(joiner, "Claimed", SCENARIO_STATUS_TIMEOUT_MS, "scenario1-joiner-claimed-timeout");
    step("  - joiner observed claimed");
    await decideHost(host, "approve");
    step("  - host approved");
    try {
      await waitForText(host.driver, "syncd-host-status-live", "Approved", SCENARIO_STATUS_TIMEOUT_MS);
    } catch (error) {
      await captureHostDiagnostics(host, "scenario1-host-approved-timeout");
      throw error;
    }
    step("  - host observed approved");
    await waitForPersistedSessionOrigin(joiner, hostState.bundle.syncdBaseUrl, SCENARIO_STATUS_TIMEOUT_MS);
    step("  - joiner persisted the approved host origin");
    await waitForPersistedSessionCount(joiner, 1);
    step("  - joiner persisted approved session");
    await waitForReplicationStatus(joiner, "Live", DEFAULT_TIMEOUT_MS);
    await waitForReplicationStatus(host, "Live", DEFAULT_TIMEOUT_MS);
    step("  - replication reached live on both host and joiner");
    const hostNovelProgress = await mutateNovelFixture(host, {
      mode: "progress",
      marker: "host-progress-1",
      progressPercent: 0.42,
    });
    await waitForNovelProgress(joiner, hostNovelProgress.novelId, 0.42, DEFAULT_TIMEOUT_MS);
    step("  - host novel progress replicated to joiner");

    const hostNovelBookmark = await mutateNovelFixture(host, {
      mode: "bookmark",
      marker: "host-bookmark-1",
      progressPercent: 0.42,
    });
    await snapshotJson("scenario1-host-novel-bookmark-local", {
      mutationResult: hostNovelBookmark,
      persistence: await readNovelPersistence(host).catch((error) => ({
        readError: error instanceof Error ? error.message : String(error),
      })),
    });
    await waitForNovelBookmark(joiner, hostNovelBookmark.novelId, hostNovelBookmark.bookmarkLabel, DEFAULT_TIMEOUT_MS);
    step("  - host novel bookmark replicated to joiner");

    const joinerNovelProgress = await mutateNovelFixture(joiner, {
      mode: "progress",
      marker: "joiner-progress-1",
      progressPercent: 1,
    });
    await waitForNovelProgress(host, joinerNovelProgress.novelId, 1, DEFAULT_TIMEOUT_MS);
    step("  - joiner novel progress replicated back to host");

    const joinerNovelBookmark = await mutateNovelFixture(joiner, {
      mode: "bookmark",
      marker: "joiner-bookmark-1",
    });
    await waitForNovelBookmark(host, joinerNovelBookmark.novelId, joinerNovelBookmark.bookmarkLabel, DEFAULT_TIMEOUT_MS);
    step("  - joiner novel bookmark replicated back to host");

    const persistedAfterApprove = await readPersistedState(joiner);
    const approvedSession = persistedAfterApprove.sessions[0];
    if (!approvedSession) {
      throw new Error("Approved Syncd session was not available for visual validation.");
    }
    const connectedVisual = await captureSessionVisualState(
      joiner,
      "scenario1-joiner-connected-popover",
      approvedSession.sessionKey,
    );
    report.scenarios.push({
      name: "mdns-discovery-approval-replication",
      hostOrigin: hostState.bundle.syncdBaseUrl,
      persistedSessions: persistedAfterApprove.sessions.length,
      replicated: {
        hostNovelId: hostNovelProgress.novelId,
        joinerNovelId: joinerNovelProgress.novelId,
      },
      visual: connectedVisual,
      screenshot: await saveScreenshot(joiner, "scenario1-joiner-connected"),
    });

    step("Scenario 2: restart joiner + persisted session revalidation + pause/resume");
    joiner = await restartDesktop(joiner);
    await waitForPersistedSessionCount(joiner, 1);
    await waitForPersistedStatusText(joiner, "Connected");
    await waitForReplicationStatus(joiner, "Live", DEFAULT_TIMEOUT_MS);
    const persistedAfterRestart = await readPersistedState(joiner);
    const restartedSession = persistedAfterRestart.sessions[0];
    if (!restartedSession) {
      throw new Error("Persisted Syncd session was not available after restart.");
    }
    const restartVisual = await captureSessionVisualState(
      joiner,
      "scenario2-joiner-restarted-live-popover",
      restartedSession.sessionKey,
    );
    await openSyncdModalView(joiner, "pairing");
    await clickTestId(joiner.driver, "syncd-replication-toggle");
    await waitForReplicationStatus(joiner, "Paused", DEFAULT_TIMEOUT_MS);
    const pausedVisual = await captureSessionVisualState(
      joiner,
      "scenario2-joiner-paused-popover",
      restartedSession.sessionKey,
    );
    step("  - replication paused");
    await openSyncdModalView(joiner, "pairing");
    await clickTestId(joiner.driver, "syncd-replication-toggle");
    await waitForReplicationStatus(joiner, "Live", DEFAULT_TIMEOUT_MS);
    const resumedVisual = await captureSessionVisualState(
      joiner,
      "scenario2-joiner-resumed-popover",
      restartedSession.sessionKey,
    );
    step("  - replication resumed");
    await openSyncdModalView(joiner, "pairing");
    await clickTestId(joiner.driver, "syncd-replication-reconnect");
    await waitForReplicationStatus(joiner, "Live", DEFAULT_TIMEOUT_MS);
    const reconnectedVisual = await captureSessionVisualState(
      joiner,
      "scenario2-joiner-reconnected-popover",
      restartedSession.sessionKey,
    );
    step("  - replication reconnected");
    report.scenarios.push({
      name: "restart-revalidation-pause-resume",
      visual: { restartVisual, pausedVisual, resumedVisual, reconnectedVisual },
      screenshot: await saveScreenshot(joiner, "scenario2-joiner-restarted"),
    });

    step("Scenario 3: second approved session + set active + forget inactive");
    hostAlt = await launchDesktop("host-alt", {
      localAppDataDir: path.join(tmpRoot, "host-alt", "LocalAppData"),
      syncdPort: 5177,
      localServerPort: 4968,
      bootstrapTtlSeconds: 900,
    });
    const altHostState = await startHostPairing(hostAlt, "scenario3-host-alt-pending");
    await connectJoiner(joiner, {
      bundleRaw: altHostState.bootstrapBundleRaw,
      manualOrigin: altHostState.bundle.syncdBaseUrl,
    });
    await waitForText(hostAlt.driver, "syncd-host-status-live", "Claimed");
    await waitForConnectStatus(joiner, "Claimed", DEFAULT_TIMEOUT_MS, "scenario3-joiner-claimed-timeout");
    await decideHost(hostAlt, "approve");
    await waitForText(hostAlt.driver, "syncd-host-status-live", "Approved");
    await waitForPersistedSessionOrigin(joiner, altHostState.bundle.syncdBaseUrl, DEFAULT_TIMEOUT_MS);
    await waitForPersistedSessionCount(joiner, 2);
    const persistedWithAlt = await readPersistedState(joiner);
    const originalSession = persistedWithAlt.sessions.find((session) => session.canonicalOrigin === hostState.bundle.syncdBaseUrl);
    const altSession = persistedWithAlt.sessions.find((session) => session.canonicalOrigin === altHostState.bundle.syncdBaseUrl);
    if (!originalSession || !altSession) {
      throw new Error("Could not identify both persisted sync sessions after the second approval.");
    }
    const originalActiveVisual = await captureSessionVisualState(
      joiner,
      "scenario3-original-active-popover",
      originalSession.sessionKey,
    );
    const altInactiveVisual = await captureSessionVisualState(
      joiner,
      "scenario3-alt-inactive-popover",
      altSession.sessionKey,
    );
    await clickSessionAction(joiner, "syncd-session-set-active", altSession.sessionKey);
    await waitForActiveSessionKey(joiner, altSession.sessionKey, DEFAULT_TIMEOUT_MS);
    await waitForReplicationStatus(joiner, "Live", DEFAULT_TIMEOUT_MS);
    step("  - second session became active");
    const altActiveVisual = await captureSessionVisualState(
      joiner,
      "scenario3-alt-active-popover",
      altSession.sessionKey,
    );
    const originalInactiveVisual = await captureSessionVisualState(
      joiner,
      "scenario3-original-inactive-popover",
      originalSession.sessionKey,
    );
    await clickSessionAction(joiner, "syncd-session-forget", originalSession.sessionKey);
    await waitForPersistedSessionCount(joiner, 1);
    step("  - inactive original session forgotten");
    report.scenarios.push({
      name: "session-management-active-switch",
      activeOrigin: altHostState.bundle.syncdBaseUrl,
      visual: { originalActiveVisual, altInactiveVisual, altActiveVisual, originalInactiveVisual },
      screenshot: await saveScreenshot(joiner, "scenario3-joiner-session-management"),
    });

    step("Scenario 4: manual origin fallback + rejection");
    const manualHostState = await startHostPairing(hostAlt, "scenario4-host-pending");
    await connectJoiner(joiner, {
      bundleRaw: manualHostState.bootstrapBundleRaw,
      manualOrigin: manualHostState.bundle.syncdBaseUrl,
    });
    await waitForText(hostAlt.driver, "syncd-host-status-live", "Claimed");
    await waitForConnectStatus(joiner, "Claimed", DEFAULT_TIMEOUT_MS, "scenario4-joiner-claimed-timeout");
    await decideHost(hostAlt, "reject");
    await waitForText(hostAlt.driver, "syncd-host-status-live", "Rejected");
    await waitForConnectStatus(joiner, "Rejected", DEFAULT_TIMEOUT_MS, "scenario4-joiner-rejected-timeout");
    report.scenarios.push({
      name: "manual-origin-rejection",
      screenshot: await saveScreenshot(joiner, "scenario4-joiner-rejected"),
    });

    step("Scenario 5: unreachable remote on revalidation");
    await killListeningProcessOnPort(hostAlt.syncdPort);
    await closeDesktop(hostAlt);
    hostAlt = null;
    await revalidateSessions(joiner);
    await waitForPersistedStatusText(joiner, "Unreachable");
    report.scenarios.push({
      name: "unreachable-revalidation",
      screenshot: await saveScreenshot(joiner, "scenario5-joiner-unreachable"),
    });

    step("Scenario 6: expiry after live claim");
    expiryHost = await launchDesktop("host-expiry", {
      localAppDataDir: path.join(tmpRoot, "host-expiry", "LocalAppData"),
      syncdPort: 5077,
      localServerPort: 4868,
      bootstrapTtlSeconds: 8,
    });
    const expiryHostState = await startHostPairing(expiryHost, "scenario6-host-pending");
    await connectJoiner(joiner, {
      bundleRaw: expiryHostState.bootstrapBundleRaw,
      manualOrigin: expiryHostState.bundle.syncdBaseUrl,
    });
    await waitForText(expiryHost.driver, "syncd-host-status-live", "Claimed");
    await waitForConnectStatus(joiner, "Claimed", DEFAULT_TIMEOUT_MS, "scenario6-joiner-claimed-timeout");
    await waitForText(expiryHost.driver, "syncd-host-status-live", "Expired", 30_000);
    await waitForConnectStatus(joiner, "Expired", 30_000, "scenario6-joiner-expired-timeout");
    report.scenarios.push({
      name: "expiry",
      screenshot: await saveScreenshot(joiner, "scenario6-joiner-expired"),
    });
    await closeDesktop(expiryHost);
    expiryHost = null;

    step("Scenario 7: QR import path + approval");
    await closeDesktop(host);
    host = await launchDesktop("host-qr", {
      localAppDataDir: path.join(tmpRoot, "host-qr", "LocalAppData"),
      syncdPort: 5277,
      localServerPort: 5068,
      bootstrapTtlSeconds: 900,
    });
    const qrHostState = await startHostPairing(host, "scenario7-host-pending");
    await snapshotJson("scenario7-host-bootstrap", {
      sessionId: qrHostState.bundle.pairingSessionId,
      origin: qrHostState.bundle.syncdBaseUrl,
      bundleRaw: qrHostState.bootstrapBundleRaw,
      advertisedOrigin: qrHostState.advertisedOrigin,
    });
    await waitForBootstrapPayloadReachable(
      qrHostState.bundle.syncdBaseUrl,
      qrHostState.bundle.pairingSessionId,
      BOOTSTRAP_REACHABILITY_TIMEOUT_MS,
    );
    const qrPath = path.join(artifactsRoot, "scenario7-bootstrap-qr.png");
    const qrDataUrl = await extractQrToFile(host, qrPath);
    const scenario7Connect = await connectJoiner(joiner, {
      bundleRaw: qrHostState.bootstrapBundleRaw,
      manualOrigin: "",
      useQrDataUrl: qrDataUrl,
    });
    await snapshotJson("scenario7-joiner-qr-import", {
      sessionId: qrHostState.bundle.pairingSessionId,
      origin: qrHostState.bundle.syncdBaseUrl,
      qrPath,
      importedBundleMatches: scenario7Connect.importedBundle === qrHostState.bootstrapBundleRaw,
      importedBundle: scenario7Connect.importedBundle,
      manualOrigin: scenario7Connect.manualOrigin,
    });
    await waitForConnectStatus(joiner, "Claimed", DEFAULT_TIMEOUT_MS, "scenario7-joiner-claimed-timeout");
    try {
      await waitForText(host.driver, "syncd-host-status-live", "Claimed");
    } catch (error) {
      await captureHostDiagnostics(host, "scenario7-host-claimed-timeout");
      throw error;
    }
    await decideHost(host, "approve");
    await waitForText(host.driver, "syncd-host-status-live", "Approved");
    await waitForPersistedSessionOrigin(joiner, qrHostState.bundle.syncdBaseUrl, DEFAULT_TIMEOUT_MS);
    const persistedAfterQr = await readPersistedState(joiner);
    const qrSession = persistedAfterQr.sessions.find(
      (session) => session.canonicalOrigin === qrHostState.bundle.syncdBaseUrl,
    );
    if (!qrSession) {
      throw new Error("QR-approved Syncd session was not available for visual validation.");
    }
    const qrVisual = await captureSessionVisualState(
      joiner,
      "scenario7-joiner-connected-qr-popover",
      qrSession.sessionKey,
    );
    report.scenarios.push({
      name: "qr-approval",
      qrPath,
      visual: qrVisual,
      screenshot: await saveScreenshot(joiner, "scenario7-joiner-connected-qr"),
    });

    report.finishedAt = new Date().toISOString();
    report.status = "pass";
    await snapshotJson("syncd-native-two-instance-report", report);
    return report;
  } finally {
    await closeDesktop(hostAlt);
    await closeDesktop(expiryHost);
    await closeDesktop(host);
    await closeDesktop(joiner);
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
