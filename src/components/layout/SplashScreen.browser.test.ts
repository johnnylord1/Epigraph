/// <reference types="@vitest/browser/matchers" />

import { page } from "@vitest/browser/context";
import { render } from "@testing-library/svelte";
import { afterEach, describe, expect, test } from "vitest";
import { setAnimationPreference } from "../../lib/motion/motion";
import SplashScreen from "./SplashScreen.svelte";

function starPositions() {
  return [...document.querySelectorAll<HTMLElement>(".orbit-star, .ambient-star")].map((star) => star.style.cssText).join("|");
}

describe("SplashScreen (browser)", () => {
  afterEach(() => setAnimationPreference(null));

  test("keeps the starfield still when animations are turned off", async () => {
    setAnimationPreference(false);
    render(SplashScreen, { props: { mode: "loading", statusText: "Loading", showCards: true } });
    await expect.poll(() => document.querySelectorAll(".orbit-star").length).toBeGreaterThan(0);
    const before = starPositions();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(starPositions()).toBe(before);
  });

  test("moves the starfield when animations are on", async () => {
    setAnimationPreference(true);
    render(SplashScreen, { props: { mode: "loading", statusText: "Loading", showCards: true } });
    await expect.poll(() => document.querySelectorAll(".orbit-star").length).toBeGreaterThan(0);
    const before = starPositions();
    await expect.poll(starPositions, { timeout: 2000 }).not.toBe(before);
  });

  test("renders the approved splash shell in loading state", async () => {
    render(SplashScreen, {
      props: {
        mode: "loading",
        statusText: "Initializing profile",
        showCards: true,
      },
    });

    const loadingValue = document.querySelector(".state.loading .state-value");

    expect(loadingValue).toBeTruthy();
    await expect.element(page.elementLocator(loadingValue!)).toBeVisible();
    expect(document.querySelector(".state-dock")).toBeTruthy();
    expect(document.querySelector(".brand-mark")).toBeTruthy();
  });

  test("keeps the default palette whatever theme is active", async () => {
    const root = document.documentElement;
    const previousTheme = root.dataset.theme;
    root.dataset.theme = "light";
    root.style.setProperty("--component-splash-ink-source", "rgb(1, 2, 3)");
    root.style.setProperty("--component-splash-background-base-source", "rgb(250, 250, 250)");
    root.style.setProperty("--color-highlight-source", "rgb(4, 5, 6)");
    try {
      render(SplashScreen, { props: { mode: "loading", statusText: "Loading", showCards: false } });
      const stage = document.querySelector<HTMLElement>(".epigraph-port--splash");
      expect(stage).toBeTruthy();
      const style = getComputedStyle(stage!);
      expect(style.getPropertyValue("--component-splash-ink-source").trim()).toBe("#efeaff");
      expect(style.getPropertyValue("--color-highlight-source").trim()).toBe("#ffffff");
      expect(style.getPropertyValue("--component-splash-background-base-source").trim()).toBe("#030306");
    } finally {
      root.style.removeProperty("--component-splash-ink-source");
      root.style.removeProperty("--component-splash-background-base-source");
      root.style.removeProperty("--color-highlight-source");
      if (previousTheme === undefined) delete root.dataset.theme;
      else root.dataset.theme = previousTheme;
    }
  });

  test("renders the error shell with visible runtime actions", async () => {
    render(SplashScreen, {
      props: {
        mode: "loading",
        failed: true,
        failureTitle: "Could not reach server",
        failureDetail: "Epigraph couldn't reach the selected local profile.",
        showCards: false,
      },
    });

    await expect.element(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Enter app" })).toBeVisible();
  });

  test("renders the not-configured failsafe without changing its visual contract", async () => {
    render(SplashScreen, {
      props: {
        mode: "loading",
        notConfigured: true,
        failureTitle: "Server not configured",
        failureDetail: "Choose a profile before retrying.",
        showCards: false,
      },
    });

    await expect.element(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Enter app" })).toBeVisible();
  });
});
