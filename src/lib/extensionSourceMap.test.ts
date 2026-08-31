import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchRepoEntries } from "./extensionSourceMap";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extension repository catalogs", () => {
  test("reads the JSON companion for a v2 protobuf extension store", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      name: "Example extensions",
      extensionList: {
        extensions: [{
          name: "Example",
          packageName: "eu.kanade.tachiyomi.extension.en.example",
          resources: { apkUrl: "https://example.test/example.apk" },
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
    }]);
  });
});
