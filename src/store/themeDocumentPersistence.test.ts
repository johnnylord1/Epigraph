import { afterEach, describe, expect, test, vi } from "vitest";
import type { ThemeDocumentV5 } from "../lib/theme/contract";
import { saveCustomTheme, store } from "./state.svelte";

const document: ThemeDocumentV5 = {
  version: 5,
  id: "custom:persistence-test",
  name: "Persistence Test",
  base: "nocturne",
  primitives: { accent: "#abcdef" },
  semanticOverrides: {},
  hud: {},
  motion: "soft",
};

describe("custom theme persistence", () => {
  const initialSettings = store.settings;

  afterEach(() => {
    store.settings = initialSettings;
    vi.unstubAllGlobals();
  });

  test("does not replace the in-memory document when persistence fails", () => {
    const before = store.settings;
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => { throw new Error("quota exceeded"); },
    });

    expect(saveCustomTheme(document, true)).toBe(false);
    expect(store.settings).toBe(before);
    expect(store.settings.customThemes.some((theme) => theme.id === document.id)).toBe(false);
  });

  test("persists V5 before activating it in memory", () => {
    let persisted = "";
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: (_key: string, value: string) => { persisted = value; },
    });

    expect(saveCustomTheme(document, true)).toBe(true);
    expect(store.settings.theme).toBe(document.id);
    expect(store.settings.customThemes.find((theme) => theme.id === document.id)).toEqual(document);
    const written = JSON.parse(persisted);
    expect(written.settings.theme).toBe(document.id);
    expect(written.settings.customThemes.find((theme: ThemeDocumentV5) => theme.id === document.id)).toEqual(document);
  });
});
