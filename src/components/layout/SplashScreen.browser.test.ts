/// <reference types="@vitest/browser/matchers" />

import { page } from "@vitest/browser/context";
import { render } from "@testing-library/svelte";
import { describe, expect, test } from "vitest";
import SplashScreen from "./SplashScreen.svelte";

describe("SplashScreen (browser)", () => {
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
