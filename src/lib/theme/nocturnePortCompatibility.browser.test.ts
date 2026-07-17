import { describe, expect, test } from "vitest";

function painted(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.backgroundImage !== "none"
    || (style.backgroundColor !== "" && style.backgroundColor !== "rgba(0, 0, 0, 0)");
}

describe("Nocturne port computed compatibility", () => {
  test("resolves every active port host in the final cascade", async () => {
    const splash = document.createElement("div");
    splash.className = "aethon-port--splash";

    const shell = document.createElement("div");
    shell.className = "aethon-app-shell";
    const sidebar = document.createElement("nav");
    sidebar.className = "n-sidebar";
    shell.appendChild(sidebar);

    const settings = document.createElement("main");
    settings.className = "aethon-port--settings settings-page";
    const settingsCard = document.createElement("section");
    settingsCard.className = "settings-card";
    settings.appendChild(settingsCard);

    const metric = document.createElement("div");
    metric.className = "source-metric-pill";

    document.body.append(splash, shell, settings, metric);
    await new Promise(requestAnimationFrame);

    expect(getComputedStyle(splash).getPropertyValue("--splash-ink").trim()).not.toBe("");
    expect(painted(splash)).toBe(true);
    expect(painted(sidebar)).toBe(true);
    expect(getComputedStyle(settingsCard).getPropertyValue("--settings-card-radius").trim()).not.toBe("");
    expect(painted(settingsCard)).toBe(true);
    expect(painted(metric)).toBe(true);
  });

  test("keeps canonical shell geometry pixel-equivalent to Legacy bridges", async () => {
    const root = document.documentElement;
    const previousScale = root.style.getPropertyValue("--hud-scale");
    const canonicalSearch = document.createElement("div");
    const legacySearch = document.createElement("div");
    const canonicalSidebar = document.createElement("div");
    const legacySidebar = document.createElement("div");

    canonicalSearch.style.width = "var(--shell-search-width-focus)";
    legacySearch.style.width = "var(--n-search-width-focus)";
    canonicalSidebar.style.width = "var(--shell-sidebar-rail-width)";
    legacySidebar.style.width = "var(--n-sidebar-rail-width)";
    document.body.append(canonicalSearch, legacySearch, canonicalSidebar, legacySidebar);

    try {
      root.style.setProperty("--hud-scale", "0.8");
      await new Promise(requestAnimationFrame);

      const canonicalSearchWidth = getComputedStyle(canonicalSearch).width;
      const canonicalSidebarWidth = getComputedStyle(canonicalSidebar).width;

      expect(getComputedStyle(legacySearch).width).toBe(canonicalSearchWidth);
      expect(getComputedStyle(legacySidebar).width).toBe(canonicalSidebarWidth);
      expect(Number.parseFloat(canonicalSearchWidth)).toBeCloseTo(304, 1);
      expect(Number.parseFloat(canonicalSidebarWidth)).toBeCloseTo(49.6, 1);
    } finally {
      if (previousScale) root.style.setProperty("--hud-scale", previousScale);
      else root.style.removeProperty("--hud-scale");
      canonicalSearch.remove();
      legacySearch.remove();
      canonicalSidebar.remove();
      legacySidebar.remove();
    }
  });
});
