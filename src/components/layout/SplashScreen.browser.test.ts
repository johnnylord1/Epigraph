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

  test("renders the error shell with visible runtime actions", async () => {
    render(SplashScreen, {
      props: {
        mode: "loading",
        failed: true,
        failureTitle: "Could not reach server",
        failureDetail: "Aethon couldn't reach the selected local profile.",
        showCards: false,
      },
    });

    await expect.element(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Enter app" })).toBeVisible();
  });
});
