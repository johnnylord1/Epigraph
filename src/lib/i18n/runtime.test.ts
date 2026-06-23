import { afterEach, describe, expect, it } from "vitest";
import { applyAppLanguage, resolveMessageLocale, translate } from "./runtime";
import { APP_LANGUAGE_OPTIONS } from "./languages";
import en from "../../../messages/en.json";
import ptBr from "../../../messages/pt-BR.json";
import es from "../../../messages/es.json";
import ja from "../../../messages/ja.json";
import zhCn from "../../../messages/zh-CN.json";

const catalogs = { en, "pt-BR": ptBr, es, ja, "zh-CN": zhCn };

afterEach(() => applyAppLanguage("en"));

function placeholders(value: string): string[] {
  return value.match(/\{[^{}]+\}/g) ?? [];
}

describe("resolveMessageLocale", () => {
  it("uses exact catalogs before language fallbacks", () => {
    expect(resolveMessageLocale("pt-BR")).toBe("pt-BR");
    expect(resolveMessageLocale("en")).toBe("en");
    expect(resolveMessageLocale("es")).toBe("es");
    expect(resolveMessageLocale("ja")).toBe("ja");
    expect(resolveMessageLocale("zh-CN")).toBe("zh-CN");
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

  it("only advertises languages with complete Paraglide catalogs", () => {
    expect(APP_LANGUAGE_OPTIONS.map((option) => option.code)).toEqual(["system", "en", "pt-BR", "es", "ja", "zh-CN"]);
  });

  it("keeps every catalog key and placeholder aligned with English", () => {
    const englishKeys = Object.keys(en);
    for (const catalog of Object.values(catalogs)) {
      expect(Object.keys(catalog)).toEqual(englishKeys);
      for (const key of englishKeys) {
        expect(placeholders(catalog[key as keyof typeof catalog])).toEqual(placeholders(en[key as keyof typeof en]));
      }
    }
  });

  it.each([
    ["en", "Library"],
    ["pt-BR", "Biblioteca"],
    ["es", "Biblioteca"],
    ["ja", "図書館"],
    ["zh-CN", "图书馆"],
  ])("renders a real %s translation", (locale, expected) => {
    applyAppLanguage(locale);
    expect(translate("shell.navigation.library")).toBe(expected);
  });
});
