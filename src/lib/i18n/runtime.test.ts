import { describe, expect, it } from "vitest";
import { resolveMessageLocale } from "./runtime";

describe("resolveMessageLocale", () => {
  it("uses exact catalogs before language fallbacks", () => {
    expect(resolveMessageLocale("pt-BR")).toBe("pt-BR");
    expect(resolveMessageLocale("en")).toBe("en");
  });

  it("falls back to a translated base language or English", () => {
    expect(resolveMessageLocale("pt-PT")).toBe("en");
    expect(resolveMessageLocale("ar-SA")).toBe("en");
  });
});
