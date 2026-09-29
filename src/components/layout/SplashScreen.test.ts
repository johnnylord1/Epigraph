import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tick } from "svelte";
import { applyAppLanguage, translate } from "../../lib/i18n/runtime";
import SplashScreen from "./SplashScreen.svelte";
import { store } from "../../store/state.svelte";

describe("SplashScreen", () => {
  test("localizes default loading and failure announcements when the locale changes", async () => {
    applyAppLanguage("pt-BR");
    const { container, rerender } = render(SplashScreen, { props: { showCards: false } });
    expect(container.textContent).toContain(translate("startup_initializing"));
    expect(container.textContent).not.toContain("Initializing profile");
    applyAppLanguage("ja"); await tick();
    expect(container.textContent).toContain(translate("startup_initializing"));
    await rerender({ failed: true, notConfigured: true, showCards: false });
    expect(screen.getByRole("alert").textContent).toContain(translate("startup_notConfigured"));
  });
  beforeEach(() => {
    vi.useFakeTimers();
    store.settings = {
      ...store.settings,
      appLockEnabled: false,
      appLockPin: "",
    };
  });

  afterEach(() => {
    cleanup();
    applyAppLanguage("en");
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    store.settings = {
      ...store.settings,
      appLockEnabled: false,
      appLockPin: "",
    };
  });

  test("ringFull without app lock exits after the short dwell and the dissolve handoff", async () => {
    const onReady = vi.fn();

    render(SplashScreen, {
      props: {
        mode: "loading",
        ringFull: true,
        showCards: false,
        onReady,
      },
    });

    await vi.advanceTimersByTimeAsync(799);
    expect(onReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  test("showCards=false skips the decorative starfield layers", () => {
    const { container } = render(SplashScreen, {
      props: {
        mode: "loading",
        showCards: false,
      },
    });

    expect(container.querySelector(".manual-starfield")).toBeNull();
    expect(container.querySelector(".orbit-layer")).toBeNull();
  });

  test("lock-enabled flow reveals the unlock path instead of auto-exiting", async () => {
    const onReady = vi.fn();
    store.settings = {
      ...store.settings,
      appLockEnabled: true,
      appLockPin: "1234",
    };

    render(SplashScreen, {
      props: {
        mode: "loading",
        ringFull: true,
        showCards: false,
        onReady,
      },
    });

    await vi.advanceTimersByTimeAsync(399);
    expect(onReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getByRole("button", { name: /submit pin/i })).toBeTruthy();
    expect(onReady).not.toHaveBeenCalled();
  });

  test("failure state exposes retry and bypass actions with alert semantics", () => {
    render(SplashScreen, {
      props: {
        mode: "loading",
        failed: true,
        failureTitle: "Could not reach server",
        failureDetail: "Epigraph couldn't reach the selected local profile.",
        showCards: false,
      },
    });

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /enter app/i })).toBeTruthy();
  });
});
