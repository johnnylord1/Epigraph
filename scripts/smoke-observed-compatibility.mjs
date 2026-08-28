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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appPath = path.resolve(args.app);
  const driverUrl = args["driver-url"];
  const serverUrl = args["server-url"] || "http://127.0.0.1:4567";
  const outputDirectory = path.resolve(
    args.out || path.join(projectRoot, "docs", "screenshots", "marco72b2-compatibility"),
  );
  const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), "epigraph-compatibility-smoke-"));
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", {
    application: appPath,
    args: [
      "--webdriver-automation",
      `--local-app-data-dir=${profileRoot}`,
      `--server-url=${serverUrl}`,
      "--profile-label=COMPATIBILITY-SMOKE",
    ],
    webviewOptions: {
      userDataFolder: path.join(profileRoot, "WebView2Automation"),
      additionalBrowserArguments: ["--remote-debugging-port=0"],
    },
  });

  let driver;
  try {
    await fs.mkdir(outputDirectory, { recursive: true });
    driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 120_000, script: 120_000 });
    await driver.manage().window().setRect({ width: 1280, height: 800, x: 0, y: 0 });
    await driver.wait(async () => driver.executeScript(
      "return Boolean(window.__epigraphAudit)",
    ).catch(() => false), 120_000);
    await driver.executeScript("window.__epigraphAudit.bypassStartupSplash()");
    await driver.wait(async () => driver.executeScript(() => {
      if (document.querySelector(".browseSubtabs")) return true;
      document.querySelector('[data-nav-id="search"]')?.click();
      return false;
    }).catch(() => false), 60_000);
    const sourceTabClicked = await driver.executeScript(() => {
      const sourceTab = document.querySelector(".browseSubtabs .browseSubtab:nth-child(3)");
      if (!(sourceTab instanceof HTMLButtonElement)) return false;
      sourceTab.click();
      return true;
    });
    assert.equal(sourceTabClicked, true, "Active Browse source tab was not found.");
    await driver.wait(until.elementLocated(By.css(".sourcesRoot")), 30_000);
    const card = await driver.wait(until.elementLocated(By.css(".extensionCard")), 45_000);
    await card.click();
    await driver.wait(until.elementLocated(By.css(".settingsPanel")), 15_000);
    await driver.executeAsyncScript((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 500)));
    });
    await fs.writeFile(
      path.join(outputDirectory, "before-observed-report.png"),
      await driver.takeScreenshot(),
      "base64",
    );

    await driver.executeScript(() => {
      const details = document.querySelector("details.compatibilitySection");
      if (details instanceof HTMLDetailsElement) details.open = true;
      const checkButton = [...document.querySelectorAll(".compatibilityProbeButton")]
        .find((button) => button instanceof HTMLButtonElement && !button.disabled);
      if (!(checkButton instanceof HTMLButtonElement)) {
        throw new Error("Compatibility probe action is not available.");
      }
      checkButton.click();
    });
    await driver.wait(async () => driver.executeScript(
      "return Boolean(document.querySelector('details.compatibilitySection'))"
        + " && ![...document.querySelectorAll('.compatibilityProbeButton')]"
        + ".some((button) => button.textContent?.includes('Checking'))",
    ), 45_000);
    await driver.executeScript(() => {
      const details = document.querySelector("details.compatibilitySection");
      if (details instanceof HTMLDetailsElement) {
        details.open = true;
        details.scrollIntoView({ block: "nearest" });
      }
    });
    await driver.executeAsyncScript((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 500)));
    });
    const report = await driver.executeScript(() => {
      const panel = document.querySelector(".settingsPanel");
      const details = document.querySelector("details.compatibilitySection");
      const panelRect = panel?.getBoundingClientRect();
      const detailsRect = details?.getBoundingClientRect();
      return {
        aggregate: details?.querySelector("summary strong")?.textContent?.trim() ?? null,
        stageCount: details?.querySelectorAll(".compatibilityStages > div").length ?? 0,
        panelWithinViewport: Boolean(panelRect
          && panelRect.left >= 0
          && panelRect.right <= window.innerWidth
          && panelRect.top >= 0
          && panelRect.bottom <= window.innerHeight),
        detailsWidth: detailsRect?.width ?? 0,
        horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
        bodyClasses: document.body.className,
        activeElement: document.activeElement instanceof HTMLElement
          ? `${document.activeElement.tagName}.${document.activeElement.className}`
          : null,
        coveringLayers: [...document.querySelectorAll("body *")].filter((element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.position === "fixed"
            && style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width >= window.innerWidth * 0.8
            && rect.height >= window.innerHeight * 0.8;
        }).map((element) => ({
          className: element.className,
          zIndex: getComputedStyle(element).zIndex,
          pointerEvents: getComputedStyle(element).pointerEvents,
          opacity: getComputedStyle(element).opacity,
          background: getComputedStyle(element).backgroundColor,
        })),
      };
    });
    assert(report.aggregate, "Observed report summary was not rendered.");
    assert(report.stageCount >= 3, "Observed report did not expose its stages.");
    assert.equal(report.panelWithinViewport, true, "Sources settings panel escaped the viewport.");
    assert(report.detailsWidth > 0, "Observed report details have no visible width.");
    assert(report.horizontalOverflow <= 1, "Observed report introduced horizontal overflow.");
    await fs.writeFile(
      path.join(outputDirectory, "after-observed-report.png"),
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
