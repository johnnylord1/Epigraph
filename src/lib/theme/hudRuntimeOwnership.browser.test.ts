import { describe, expect, test } from "vitest";
import {
  HUD_MASKED_FALLBACK_TOKEN_KEYS,
  HUD_RUNTIME_ACTIVE_TOKEN_KEYS,
} from "./hudOwnership";

type CssProperty = "borderRadius" | "height" | "width";

function computedValue(variable: string, property: CssProperty): string {
  const probe = document.createElement("div");
  probe.style[property] = `var(${variable})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe)[property];
  probe.remove();
  return value;
}

describe("HUD runtime ownership", () => {
  test("changes every runtime-active HUD surface through its component alias", async () => {
    const root = document.documentElement;
    const cases = [
      ["--hud-popover-radius", "--component-reader-popover-radius", "borderRadius", "19px"],
      ["--hud-toast-radius", "--component-toast-radius", "borderRadius", "21px"],
      ["--hud-progress-height", "--component-reader-range-track-height", "height", "7px"],
    ] as const;

    expect(cases.map(([token]) => token.slice(2))).toEqual([...HUD_RUNTIME_ACTIVE_TOKEN_KEYS]);
    for (const [token, component, property, next] of cases) {
      const previousInline = root.style.getPropertyValue(token);
      const before = computedValue(component, property);
      try {
        root.style.setProperty(token, next);
        await new Promise(requestAnimationFrame);
        expect(computedValue(component, property), component).toBe(next);
        expect(computedValue(component, property), component).not.toBe(before);
      } finally {
        if (previousInline) root.style.setProperty(token, previousInline);
        else root.style.removeProperty(token);
      }
    }
  });

  test("proves the icon authoring token is masked by the active Library override", async () => {
    const root = document.documentElement;
    const previousInline = root.style.getPropertyValue("--hud-icon-button-size");
    const probe = document.createElement("div");
    probe.style.setProperty("--library-icon-btn-size", "31px");
    probe.style.width = "var(--library-icon-btn-size, var(--hud-icon-button-size))";
    document.body.appendChild(probe);

    try {
      expect(HUD_MASKED_FALLBACK_TOKEN_KEYS).toEqual(["hud-icon-button-size"]);
      expect(getComputedStyle(probe).width).toBe("31px");
      root.style.setProperty("--hud-icon-button-size", "47px");
      await new Promise(requestAnimationFrame);
      expect(getComputedStyle(probe).width).toBe("31px");
      probe.style.removeProperty("--library-icon-btn-size");
      expect(getComputedStyle(probe).width).toBe("47px");
    } finally {
      probe.remove();
      if (previousInline) root.style.setProperty("--hud-icon-button-size", previousInline);
      else root.style.removeProperty("--hud-icon-button-size");
    }
  });
});
