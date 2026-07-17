import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const BUILTIN_THEME_IDS = [
  "nocturne",
  "dark",
  "amoled",
  "high-contrast",
  "light",
  "light-contrast",
  "midnight",
  "warm",
];

const CONTRAST_PAIRS = [
  ["text-primary/background", "--text-primary", "--color-background"],
  ["text-secondary/background", "--text-secondary", "--color-background"],
  ["text-primary/card", "--text-primary", "--component-card-bg"],
  ["button", "--component-button-fg", "--component-button-bg"],
  ["input", "--component-input-fg", "--component-input-bg"],
  ["toast", "--component-toast-title-fg", "--component-toast-bg"],
];

export function parseRuntimeAuditArgs(argv) {
  const options = {
    cdp: "http://127.0.0.1:9223",
    out: "docs/screenshots/marco53-runtime-audit",
    themes: [...BUILTIN_THEME_IDS],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--cdp") options.cdp = argv[++index];
    else if (value === "--out") options.out = argv[++index];
    else if (value === "--themes") {
      options.themes = argv[++index].split(",").map((theme) => theme.trim()).filter(Boolean);
    } else {
      throw new Error(`Unknown runtime audit argument: ${value}`);
    }
  }

  const unknownThemes = options.themes.filter((theme) => !BUILTIN_THEME_IDS.includes(theme));
  if (unknownThemes.length > 0) throw new Error(`Unknown builtin theme: ${unknownThemes.join(", ")}`);
  return options;
}

export function parseComputedColor(value) {
  const match = String(value).trim().match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
  if (!match) throw new Error(`Unsupported computed color: ${value}`);
  return {
    red: Number(match[1]),
    green: Number(match[2]),
    blue: Number(match[3]),
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function composite(foreground, background) {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 };
  return {
    red: (foreground.red * foreground.alpha + background.red * background.alpha * (1 - foreground.alpha)) / alpha,
    green: (foreground.green * foreground.alpha + background.green * background.alpha * (1 - foreground.alpha)) / alpha,
    blue: (foreground.blue * foreground.alpha + background.blue * background.alpha * (1 - foreground.alpha)) / alpha,
    alpha,
  };
}

function luminance(color) {
  const channel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue);
}

export function computedContrastRatio(foregroundValue, backgroundValue, canvasValue = "rgb(255, 255, 255)") {
  const canvas = composite(parseComputedColor(canvasValue), { red: 255, green: 255, blue: 255, alpha: 1 });
  const background = composite(parseComputedColor(backgroundValue), canvas);
  const foreground = composite(parseComputedColor(foregroundValue), background);
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function findAethonPage(browser) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  for (const page of pages) {
    if ((await page.title()).startsWith("Aethon")) return page;
  }
  throw new Error("Aethon WebView2 page was not found on the CDP endpoint.");
}

async function setRuntimeTheme(page, theme) {
  await page.evaluate((nextTheme) => {
    document.documentElement.setAttribute("data-theme", nextTheme);
    document.documentElement.removeAttribute("data-custom-theme");
  }, theme);
  await page.waitForTimeout(220);
}

async function readThemeEvidence(page, theme) {
  return page.evaluate(({ currentTheme, pairs }) => {
    const resolveColor = (token, property) => {
      const probe = document.createElement("span");
      probe.style[property] = `var(${token})`;
      probe.style.position = "fixed";
      probe.style.pointerEvents = "none";
      document.body.append(probe);
      const color = getComputedStyle(probe)[property];
      probe.remove();
      return color;
    };

    const focusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusStyle = focusTarget ? getComputedStyle(focusTarget) : null;
    return {
      theme: currentTheme,
      appliedTheme: document.documentElement.getAttribute("data-theme"),
      customTheme: document.documentElement.getAttribute("data-custom-theme"),
      pairs: pairs.map(([label, foreground, background]) => ({
        label,
        foreground: resolveColor(foreground, "color"),
        background: resolveColor(background, "backgroundColor"),
        canvas: resolveColor("--color-background", "backgroundColor"),
      })),
      focus: focusStyle ? {
        tag: focusTarget?.tagName ?? null,
        className: focusTarget?.className ?? null,
        outline: focusStyle.outline,
        outlineStyle: focusStyle.outlineStyle,
        outlineWidth: focusStyle.outlineWidth,
        boxShadow: focusStyle.boxShadow,
        borderColor: focusStyle.borderColor,
      } : null,
    };
  }, { currentTheme: theme, pairs: CONTRAST_PAIRS });
}

async function waitForPaint(page, delay = 500) {
  await page.mouse.move(1270, 790);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(delay);
}

async function restoreRuntime(page, snapshot) {
  await page.evaluate(({ theme, customTheme }) => {
    if (theme === null) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    if (customTheme === null) document.documentElement.removeAttribute("data-custom-theme");
    else document.documentElement.setAttribute("data-custom-theme", customTheme);
  }, snapshot.themeAttributes);

  const audit = await page.evaluate(() => Boolean(globalThis.__aethonAudit));
  if (!audit) return;
  const currentState = await page.evaluate(() => globalThis.__aethonAudit.getState());
  const auditOpenedReader = !snapshot.state.activeBookReaderId
    && !snapshot.state.activeChapterId
    && (currentState.activeBookReaderId || currentState.activeChapterId);
  if (auditOpenedReader) {
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => {
      const state = globalThis.__aethonAudit.getState();
      return !state.activeBookReaderId && !state.activeChapterId;
    }, undefined, { timeout: 5_000 });
  }
  if (snapshot.state.activeBookReaderId) {
    await page.evaluate((id) => globalThis.__aethonAudit.openFirstBookReader(id), snapshot.state.activeBookReaderId);
    return;
  }
  if (snapshot.state.activeChapterId) {
    await page.evaluate(({ mangaId, chapterId }) => globalThis.__aethonAudit.openFirstReader(mangaId, chapterId), {
      mangaId: snapshot.state.activeMangaId,
      chapterId: snapshot.state.activeChapterId,
    });
    return;
  }
  if (snapshot.state.settingsOpen || snapshot.state.navPage === "settings") {
    await page.evaluate(() => globalThis.__aethonAudit.openSettings());
  } else if (snapshot.state.navPage === "library") {
    if (snapshot.state.librarySection === "books") await page.evaluate(() => globalThis.__aethonAudit.openBooksLibrary());
    else await page.evaluate(() => globalThis.__aethonAudit.openLibrary());
  } else {
    const navLabel = { home: "Home", search: "Browse", downloads: "Downloads" }[snapshot.state.navPage];
    if (navLabel) await page.getByRole("button", { name: navLabel, exact: true }).click();
  }
}

export async function runThemeRuntimeAudit(options) {
  const outputDirectory = path.resolve(options.out);
  await mkdir(outputDirectory, { recursive: true });
  const browser = await chromium.connectOverCDP(options.cdp);
  const page = await findAethonPage(browser);
  await page.bringToFront();

  const snapshot = await page.evaluate(() => ({
    state: globalThis.__aethonAudit?.getState?.() ?? null,
    themeAttributes: {
      theme: document.documentElement.getAttribute("data-theme"),
      customTheme: document.documentElement.getAttribute("data-custom-theme"),
    },
  }));
  if (!snapshot.state) throw new Error("Aethon audit bridge is unavailable.");
  if (snapshot.themeAttributes.customTheme) {
    throw new Error("Runtime matrix requires a builtin theme; deactivate the custom theme before running it.");
  }

  const report = {
    schemaVersion: 1,
    cdp: options.cdp,
    viewport: await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
    surfaces: [],
    limitations: [],
    themes: [],
  };
  const capture = async (name) => {
    await waitForPaint(page);
    const file = `${name}.png`;
    await page.screenshot({ path: path.join(outputDirectory, file), fullPage: true });
    report.surfaces.push(file);
  };
  const captureIfVisible = async (name, selector) => {
    const target = page.locator(selector).first();
    if (!(await target.isVisible().catch(() => false))) {
      report.limitations.push(`${name}: ${selector} was not available in the real runtime state.`);
      return false;
    }
    await capture(name);
    return true;
  };

  try {
    await setRuntimeTheme(page, "nocturne");
    await page.evaluate(() => globalThis.__aethonAudit.openBooksLibrary());
    await page.locator(".n-library-card").first().waitFor({ state: "visible", timeout: 20_000 });
    await capture("nocturne-library-books");

    await page.locator(".n-library-card").first().click({ button: "right" });
    await page.locator(".menu").waitFor({ state: "visible", timeout: 5_000 });
    await capture("nocturne-context-menu");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Browse", exact: true }).click();
    await page.locator(".browseSubtab").first().waitFor({ state: "visible", timeout: 25_000 });
    await page.locator(".browseSubtab").nth(0).click();
    await capture("nocturne-browse-search");
    await page.locator(".browseSubtab").nth(1).click();
    await capture("nocturne-browse-discover");
    await page.locator(".browseSubtab").nth(2).click();
    await page.locator(".sourcesRoot").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForFunction(() => {
      const root = document.querySelector(".sourcesRoot");
      return Boolean(root?.querySelector(".extensionCard, .emptyState--panel"));
    }, undefined, { timeout: 25_000 }).catch(() => {
      report.limitations.push("nocturne-browse-sources: captured the real loading state because the source inventory did not settle within 25 seconds.");
    });
    await capture("nocturne-browse-sources");

    const sourceUtility = page.locator(".sourcesRoot .sourceTools .iconBtn").first();
    if (await sourceUtility.isVisible().catch(() => false)) {
      await sourceUtility.click();
      await captureIfVisible("nocturne-source-overlay", ".repoOverlay");
      await page.keyboard.press("Escape");
    } else {
      report.limitations.push("nocturne-source-overlay: no real repository action was available.");
    }

    await page.getByRole("button", { name: "Downloads", exact: true }).click();
    await page.locator(".aethon-port--downloads").waitFor({ state: "visible", timeout: 20_000 });
    await capture("nocturne-downloads");

    await page.evaluate(() => globalThis.__aethonAudit.openSettings());
    await page.locator(".settings-page").waitFor({ state: "visible", timeout: 25_000 });
    await capture("nocturne-settings");

    for (const theme of options.themes) {
      await setRuntimeTheme(page, theme);
      await page.evaluate(() => {
        document.body.tabIndex = -1;
        document.body.focus();
      });
      await page.keyboard.press("Tab");
      await page.evaluate(() => document.body.removeAttribute("tabindex"));
      const evidence = await readThemeEvidence(page, theme);
      evidence.pairs = evidence.pairs.map((pair) => ({
        ...pair,
        ratio: Number(computedContrastRatio(pair.foreground, pair.background, pair.canvas).toFixed(3)),
      }));
      const failingPairs = evidence.pairs.filter(({ ratio }) => ratio < 4.5);
      if (failingPairs.length > 0) {
        throw new Error(`${theme} failed WCAG AA: ${failingPairs.map(({ label, ratio }) => `${label}=${ratio}`).join(", ")}`);
      }
      const focusVisible = evidence.focus
        && ((evidence.focus.outlineStyle !== "none" && Number.parseFloat(evidence.focus.outlineWidth) > 0)
          || evidence.focus.boxShadow !== "none");
      if (!focusVisible) throw new Error(`${theme} did not expose a visible keyboard focus indicator.`);
      report.themes.push(evidence);
      await capture(`theme-${theme}-settings`);
    }

    await setRuntimeTheme(page, "nocturne");
    const pdfId = await page.evaluate(async () => {
      await globalThis.__aethonAudit.openFirstPdfBook();
      return globalThis.__aethonAudit.getState().activeBookId;
    });
    if (pdfId) {
      await page.evaluate((id) => globalThis.__aethonAudit.openFirstBookReader(id), pdfId);
      await page.locator(".reader-viewport-wrapper").waitFor({ state: "visible", timeout: 25_000 });
      await page.waitForFunction(() => {
        const viewport = document.querySelector(".reader-viewport-wrapper");
        return Boolean(viewport)
          && !document.body.innerText.includes("Waiting for reflow")
          && !viewport.querySelector(".anim-spin");
      }, undefined, { timeout: 30_000 }).catch(() => {
        report.limitations.push("nocturne-reader-pdf-hud: captured the real loading state because PDF reflow did not settle within 30 seconds.");
      });
      const hud = page.locator(".reader-hud-overlay");
      if (await hud.evaluate((element) => element.classList.contains("hidden")).catch(() => false)) {
        await page.locator(".reader-viewport-wrapper").click({ position: { x: 600, y: 300 } });
      }
      await capture("nocturne-reader-pdf-hud");
    } else {
      report.limitations.push("nocturne-reader-pdf-hud: no real PDF book was available.");
    }

    if (await page.locator(".toast").first().isVisible().catch(() => false)) {
      await capture("nocturne-toast-runtime");
    } else {
      report.limitations.push("nocturne-toast-runtime: no real toast event was active; no synthetic toast was created.");
    }
  } finally {
    await restoreRuntime(page, snapshot).catch((error) => {
      report.limitations.push(`restore: ${error instanceof Error ? error.message : String(error)}`);
    });
    await browser.close();
  }

  await writeFile(path.join(outputDirectory, "runtime-audit.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function main() {
  const options = parseRuntimeAuditArgs(process.argv.slice(2));
  const report = await runThemeRuntimeAudit(options);
  process.stdout.write(`${JSON.stringify({
    surfaces: report.surfaces.length,
    themes: report.themes.length,
    limitations: report.limitations,
  }, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
