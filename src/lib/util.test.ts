import { describe, expect, it } from "vitest";
import type { Source } from "./types";
import { dedupeSources, preferredSourceLanguage } from "./util";

const source = (id: string, name: string, lang: string): Source => ({
  id,
  name,
  lang,
  displayName: `${name} (${lang})`,
  iconUrl: "",
  isNsfw: false,
});

describe("dedupeSources", () => {
  const sources = [
    source("mp-en", "MANGA Plus", "en"),
    source("mp-es", "MANGA Plus", "es"),
    source("mp-pt", "MANGA Plus", "pt-BR"),
    source("other", "Other", "en"),
  ];

  it("keeps one source per extension", () => {
    expect(dedupeSources(sources, "en").map((entry) => entry.id)).toEqual(["mp-en", "other"]);
  });

  it("matches a regional variant by its base language", () => {
    expect(dedupeSources(sources, "pt").map((entry) => entry.id)).toEqual(["mp-pt", "other"]);
    expect(dedupeSources(sources, "pt-BR").map((entry) => entry.id)).toEqual(["mp-pt", "other"]);
  });
});

describe("preferredSourceLanguage", () => {
  it("lets the app language decide while the setting keeps its default", () => {
    expect(preferredSourceLanguage("en", "pt-BR")).toBe("pt-BR");
    expect(preferredSourceLanguage("", "pt-BR")).toBe("pt-BR");
    expect(preferredSourceLanguage("en", null)).toBe("en");
  });

  it("keeps a language the reader picked", () => {
    expect(preferredSourceLanguage("ja", "pt-BR")).toBe("ja");
  });
});
