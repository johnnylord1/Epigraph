import { describe, expect, it } from "vitest";
import { resolveMessageLocale } from "./runtime";

describe("resolveMessageLocale", () => {
  it("uses exact catalogs before language fallbacks", () => {
    expect(resolveMessageLocale("pt-BR")).toBe("pt-BR");
    expect(resolveMessageLocale("zh-CN")).toBe("zh-CN");
  });

  it("falls back to a translated base language or English", () => {
    expect(resolveMessageLocale("fr-CA")).toBe("fr");
    expect(resolveMessageLocale("ar-SA")).toBe("en");
  });
});
