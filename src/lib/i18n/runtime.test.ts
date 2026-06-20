import { describe, expect, it } from "vitest";
import { applyAppLanguage, resolveMessageLocale, translate } from "./runtime";

describe("resolveMessageLocale", () => {
  it("uses exact catalogs before language fallbacks", () => {
    expect(resolveMessageLocale("pt-BR")).toBe("pt-BR");
    expect(resolveMessageLocale("en")).toBe("en");
  });

  it("falls back to a translated base language or English", () => {
    expect(resolveMessageLocale("pt-PT")).toBe("en");
    expect(resolveMessageLocale("ar-SA")).toBe("en");
  });

  it("supports the app's direct interpolation argument shape", () => {
    applyAppLanguage("en");
    expect(translate("sources.count.extension", { count: 1 })).toBe("1 extension");
    expect(translate("sources.actions.updateAllCount", { count: 3 })).toBe("Update all (3)");
  });
});
