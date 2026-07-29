import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Builder, By, Capabilities, until } from "selenium-webdriver";

const projectRoot = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((value) => value.startsWith("--")).map((value) => {
    const separator = value.indexOf("=");
    return [
      value.slice(2, separator < 0 ? undefined : separator),
      separator < 0 ? "true" : value.slice(separator + 1),
    ];
  }));
}

async function settle(driver, delayMs = 350) {
  await driver.executeAsyncScript((delay, done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, delay)));
  }, delayMs);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appPath = path.resolve(args.app);
  const driverUrl = args["driver-url"];
  const serverUrl = args["server-url"] || "http://127.0.0.1:4567";
  const outputDirectory = path.resolve(
    args.out || path.join(projectRoot, "docs", "screenshots", "marco72c-preferences"),
  );
  const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethon-preferences-smoke-"));
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", {
    application: appPath,
    args: [
      "--webdriver-automation",
      `--local-app-data-dir=${profileRoot}`,
      `--server-url=${serverUrl}`,
      "--profile-label=PREFERENCES-SMOKE",
    ],
    webviewOptions: {
      userDataFolder: path.join(profileRoot, "WebView2Automation"),
      additionalBrowserArguments: ["--remote-debugging-port=0"],
    },
  });

  let driver;
  try {
    const step = (message) => process.stdout.write(`[source-preferences] ${message}\n`);
    await fs.mkdir(outputDirectory, { recursive: true });
    step("starting WebDriver session");
    driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 120_000, script: 120_000 });
    await driver.manage().window().setRect({ width: 1280, height: 800, x: 0, y: 0 });
    await driver.wait(
      async () => driver.executeScript("return Boolean(window.__aethonAudit)").catch(() => false),
      120_000,
    );
    step("automation audit bridge ready");
    await driver.executeScript("window.__aethonAudit.bypassStartupSplash()");
    await settle(driver, 1_000);
    const startupState = await driver.executeScript(
      "return window.__aethonAudit.getState()",
    );
    step(`startup state ${JSON.stringify(startupState)}`);
    const startupDom = await driver.executeScript(() => ({
      bodyClass: document.body.className,
      navIds: [...document.querySelectorAll("[data-nav-id]")]
        .map((element) => element.getAttribute("data-nav-id")),
      text: document.body.innerText.slice(0, 240),
    }));
    step(`startup DOM ${JSON.stringify(startupDom)}`);
    await driver.executeScript(() => {
      window.__sourcePreferenceSmokeErrors = [];
      window.addEventListener("error", (event) => {
        window.__sourcePreferenceSmokeErrors.push(
          event.error?.stack || event.error?.message || event.message || "window error",
        );
      });
      window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason;
        window.__sourcePreferenceSmokeErrors.push(
          reason?.stack || reason?.message || String(reason),
        );
      });
    });
    const searchNavigation = await driver.wait(
      until.elementLocated(By.css('[data-nav-id="search"]')),
      30_000,
    );
    await searchNavigation.click();
    await driver.wait(async () => driver.executeScript(
      "return window.__aethonAudit.getState().navPage === 'search'",
    ).catch(() => false), 30_000);
    await settle(driver, 5_000);
    const searchDom = await driver.executeScript(() => ({
      state: window.__aethonAudit.getState(),
      browseSubtabs: Boolean(document.querySelector(".browseSubtabs")),
      pageState: document.querySelector(".main > .page-state")?.textContent?.trim() ?? null,
      mainChildren: [...document.querySelectorAll(".main > *")].map((element) => element.className),
      errors: window.__sourcePreferenceSmokeErrors ?? [],
      resources: performance.getEntriesByType("resource")
        .map((entry) => ({ name: entry.name, duration: entry.duration }))
        .filter((entry) => /Search|Browse|Sources/i.test(entry.name)),
      text: document.body.innerText.slice(0, 320),
    }));
    step(`search DOM ${JSON.stringify(searchDom)}`);
    if (!searchDom.browseSubtabs) {
      throw new Error(`Browse failed to render: ${JSON.stringify(searchDom)}`);
    }
    step("Browse shell ready");
    const sourceTabClicked = await driver.executeScript(() => {
      const sourceTab = document.querySelector(".browseSubtabs .browseSubtab:nth-child(3)");
      if (!(sourceTab instanceof HTMLButtonElement)) return false;
      sourceTab.click();
      return true;
    });
    assert.equal(sourceTabClicked, true, "Active Browse source tab was not found.");
    await driver.wait(until.elementLocated(By.css(".sourcesRoot")), 30_000);
    await driver.wait(until.elementLocated(By.css(".extensionCard")), 45_000);
    step("Sources catalog ready");

    const preferredNames = ["Comick", "MangaDex", "Asura", "MangaClash"];
    let openedWithPreferences = false;
    for (const name of preferredNames) {
      const clicked = await driver.executeScript((preferredName) => {
        const card = [...document.querySelectorAll(".extensionCard")]
          .find((item) => item.textContent?.toLowerCase().includes(preferredName.toLowerCase()));
        if (!(card instanceof HTMLElement)) return false;
        card.click();
        return true;
      }, name);
      if (!clicked) continue;
      await driver.wait(until.elementLocated(By.css(".settingsPanel")), 15_000);
      await driver.wait(async () => driver.executeScript(
        "return !document.querySelector('.preferenceSpinner')",
      ), 30_000);
      openedWithPreferences = await driver.executeScript(
        "return Boolean(document.querySelector('.preferenceRow'))",
      );
      if (openedWithPreferences) break;
      await driver.executeScript("document.querySelector('.closeBtn')?.click()");
      await driver.wait(until.stalenessOf(await driver.findElement(By.css(".settingsPanel"))), 10_000)
        .catch(() => {});
    }
    assert.equal(openedWithPreferences, true, "No installed extension exposed official preferences.");
    step("official preferences rendered");
    await driver.executeScript(() => {
      const panel = document.querySelector(".settingsPanel");
      const section = [...document.querySelectorAll(".settingsSection")]
        .find((item) => item.querySelector(".sectionTitle")?.textContent?.includes("Source preferences"));
      if (panel instanceof HTMLElement && section instanceof HTMLElement) {
        panel.scrollTop = Math.max(0, section.offsetTop - 8);
      }
    });
    await settle(driver);

    const report = await driver.executeScript(() => {
      const panel = document.querySelector(".settingsPanel");
      const panelRect = panel?.getBoundingClientRect();
      const controls = [...document.querySelectorAll(".preferenceRow input, .preferenceRow select")];
      return {
        panelWithinViewport: Boolean(panelRect
          && panelRect.left >= 0
          && panelRect.right <= window.innerWidth
          && panelRect.top >= 0
          && panelRect.bottom <= window.innerHeight),
        preferenceGroupCount: document.querySelectorAll(".preferenceGroup").length,
        preferenceRowCount: document.querySelectorAll(".preferenceRow").length,
        availableSourceCount: document.querySelectorAll(".preferenceSourcePicker option").length || 1,
        editableControlCount: controls.filter((control) => !control.disabled).length,
        fakeCredentialFields: [...document.querySelectorAll("input")]
          .filter((input) => input.type === "password").length,
        fakeRuntimeCopyPresent: /sync interval|mock local state|optional token/i.test(
          panel?.textContent ?? "",
        ),
        horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
        sourcePreferenceHeading: [...document.querySelectorAll(".sectionTitle > span")]
          .some((element) => element.textContent?.trim() === "Source preferences"),
      };
    });
    assert.equal(report.panelWithinViewport, true, "Source preference panel escaped the viewport.");
    assert(report.preferenceGroupCount > 0, "No source preference group was rendered.");
    assert(report.preferenceRowCount > 0, "No source preference row was rendered.");
    assert(report.preferenceGroupCount <= 1, "Inactive source groups were rendered eagerly.");
    assert(report.preferenceRowCount <= 40, "The active source rendered an excessive preference DOM.");
    assert.equal(report.fakeCredentialFields, 0, "The legacy fake credential control is still present.");
    assert.equal(report.fakeRuntimeCopyPresent, false, "The legacy fake runtime settings are still present.");
    assert.equal(report.sourcePreferenceHeading, true, "The official preference section is missing.");
    assert(report.horizontalOverflow <= 1, "Source preferences introduced horizontal overflow.");

    await fs.writeFile(
      path.join(outputDirectory, "after-manga-preferences.png"),
      await driver.takeScreenshot(),
      "base64",
    );
    await fs.writeFile(
      path.join(outputDirectory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`${JSON.stringify({ ok: true, outputDirectory, report }, null, 2)}\n`);
  } finally {
    await driver?.quit().catch(() => {});
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await fs.rm(profileRoot, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
