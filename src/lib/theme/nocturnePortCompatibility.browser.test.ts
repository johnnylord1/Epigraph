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
});
