import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAppLanguage, BOOT_MESSAGE_LOCALE_KEY } from "./runtime";

describe("boot screen locale", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    applyAppLanguage("en");
  });

  it("remembers the applied message locale for the boot screen", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      setItem: (key: string, value: string) => stored.set(key, value),
      getItem: (key: string) => stored.get(key) ?? null,
    });

    applyAppLanguage("pt-BR");
    expect(stored.get(BOOT_MESSAGE_LOCALE_KEY)).toBe("pt-BR");
    applyAppLanguage("ja");
    expect(stored.get(BOOT_MESSAGE_LOCALE_KEY)).toBe("ja");
  });

  it("keeps working when storage throws", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => { throw new Error("blocked"); },
    });
    expect(() => applyAppLanguage("es")).not.toThrow();
  });

  it("keeps the boot screen text in index.html in line with the catalogs", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain(`localStorage.getItem("${BOOT_MESSAGE_LOCALE_KEY}")`);
    for (const locale of ["pt-BR", "es", "ja", "zh-CN"]) {
      const catalog = JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as Record<string, string>;
      expect(html, locale).toContain(`: "${catalog.startup_initializing}"`);
    }
  });
});
