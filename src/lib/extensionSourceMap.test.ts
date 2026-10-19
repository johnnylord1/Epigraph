import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchRepoEntries, findMissingSourceExtensionSuggestions } from "./extensionSourceMap";
import type { Extension } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extension repository catalogs", () => {
  test("preserves all package alternatives instead of choosing the first source-name match", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(["a", "b"].map(pkg => ({ pkg, name: pkg, apk: `${pkg}.apk`, lang: "en", sources: [{ id: pkg, name: "Same name", lang: "en" }] }))), { status: 200 })));
    const result = await findMissingSourceExtensionSuggestions([{ id: "old", name: "Same name" }], ["https://repo.test/index.json"],
      ["a", "b"].map(pkgName => ({ pkgName, name: pkgName, lang: "en", isInstalled: false } as Extension)), "en");
    expect(result.suggestions.map(suggestion => suggestion.extension.pkgName)).toEqual(["a", "b"]);
    expect(result.suggestions.every(suggestion => suggestion.matchedBy === "source-name")).toBe(true);
  });
  test("reads the JSON companion for a v2 protobuf extension store", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      name: "Example extensions",
      extensionList: {
        extensions: [{
          name: "Example",
          packageName: "eu.kanade.tachiyomi.extension.en.example",
          resources: { apkUrl: "https://example.test/example.apk", iconUrl: "https://cdn.example.test/example.png" },
          sources: [{ id: "123", name: "Example Source", language: "en" }],
        }],
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRepoEntries([
      "https://raw.githubusercontent.com/owner/extensions/repo/index.pb",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/owner/extensions/repo/index.json",
    );
    expect(result.failedRepos).toEqual([]);
    expect(result.entries).toEqual([{
      name: "Example",
      pkg: "eu.kanade.tachiyomi.extension.en.example",
      apk: "https://example.test/example.apk",
      lang: "en",
      sources: [{ id: "123", name: "Example Source", lang: "en" }],
      icon: "https://cdn.example.test/example.png",
    }]);
  });
  test("resolves a github.com store URL to the raw catalog", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ pkg: "p", name: "P", apk: "p.apk", lang: "en", sources: [{ id: "1", name: "S", lang: "en" }] }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRepoEntries(["https://github.com/keiyoushi/extensions/raw/repo/index.pb"]);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json");
    expect(result.failedRepos).toEqual([]);
  });
  test("falls back to index.min.json for a repo.json store URL", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/index.json")) return new Response("Not Found", { status: 404 });
      return new Response(JSON.stringify([{ pkg: "p", name: "P", apk: "p.apk", lang: "en", sources: [{ id: "1", name: "S", lang: "en" }] }]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRepoEntries(["https://raw.githubusercontent.com/a/b/repo/repo.json"]);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://raw.githubusercontent.com/a/b/repo/index.json");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://raw.githubusercontent.com/a/b/repo/index.min.json");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].pkg).toBe("p");
    expect(result.failedRepos).toEqual([]);
  });
  test("reports a store whose catalogs are all missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404 })));

    const result = await fetchRepoEntries(["https://raw.githubusercontent.com/a/b/repo/index.json"]);

    expect(result.failedRepos).toEqual(["https://raw.githubusercontent.com/a/b/repo/index.json"]);
    expect(result.entries).toEqual([]);
  });
});
