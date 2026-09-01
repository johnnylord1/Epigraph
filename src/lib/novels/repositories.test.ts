import { describe, expect, it } from "vitest";

import {
  buildNovelRepositoryFetchHeaders,
  canExecuteNovelPlugin,
  canInstallNovelRepository,
  createNovelRepositoryRecord,
  deriveNovelCatalogPluginState,
  extractNovelRepositoryRefreshMetadata,
  filterNovelCatalogEntriesByLanguage,
  parseNovelCatalogEntries,
  resolveNovelRepositoryInputUrl,
  validateNovelRepositoryUrl,
} from "./repositories";

describe("novel repository services", () => {
  it("accepts only http(s) plugins.min.json repository URLs", () => {
    expect(validateNovelRepositoryUrl("https://example.com/plugins.min.json")).toEqual({
      ok: true,
      normalizedUrl: "https://example.com/plugins.min.json",
      reason: null,
    });

    expect(validateNovelRepositoryUrl("http://10.0.2.2:3000/.dist/plugins.min.json#ignored")).toEqual({
      ok: true,
      normalizedUrl: "http://10.0.2.2:3000/.dist/plugins.min.json",
      reason: null,
    });

    expect(validateNovelRepositoryUrl("ftp://example.com/plugins.min.json").ok).toBe(false);
    expect(validateNovelRepositoryUrl("https://example.com/plugins.json").ok).toBe(false);
  });

  it("resolves the LNReader GitHub links users actually copy", () => {
    expect(resolveNovelRepositoryInputUrl("https://github.com/lnreader/lnreader-plugins"))
      .toBe("https://raw.githubusercontent.com/lnreader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json");
    expect(resolveNovelRepositoryInputUrl("https://github.com/johnnylord1/lnreader-plugins/tree/plugins/v3.0.0"))
      .toBe("https://raw.githubusercontent.com/johnnylord1/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json");
    expect(resolveNovelRepositoryInputUrl("https://raw.githubusercontent.com/johnnylord1/lnreader-plugins/plugins/v3.0.0/.js/src/plugins/portuguese/mahoureader.js"))
      .toBe("https://raw.githubusercontent.com/johnnylord1/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json");
    expect(resolveNovelRepositoryInputUrl("https://plugins.example.com/plugins.min.json"))
      .toBe("https://plugins.example.com/plugins.min.json");
  });

  it("creates normalized repository records without trusted-by-default behavior", () => {
    const record = createNovelRepositoryRecord({
      profileId: "test",
      url: " https://plugins.example.com/plugins.min.json/ ",
      recommendedSeed: true,
    });

    expect(record).toMatchObject({
      profileId: "test",
      normalizedUrl: "https://plugins.example.com/plugins.min.json",
      trustState: "unknown",
      enabled: true,
      recommendedSeed: true,
    });
    expect(record.id).toContain("novel-repo:");
  });

  it("builds conditional refresh headers from repository cache metadata", () => {
    expect(buildNovelRepositoryFetchHeaders({
      etag: "\"abc\"",
      lastModified: "Wed, 08 Apr 2026 12:00:00 GMT",
    })).toEqual({
      Accept: "application/json",
      "If-None-Match": "\"abc\"",
      "If-Modified-Since": "Wed, 08 Apr 2026 12:00:00 GMT",
    });
  });

  it("extracts etag and last-modified metadata from a refresh response", () => {
    const metadata = extractNovelRepositoryRefreshMetadata({
      ETag: "\"etag-value\"",
      "Last-Modified": "Wed, 08 Apr 2026 12:00:00 GMT",
    });

    expect(metadata).toEqual({
      etag: "\"etag-value\"",
      lastModified: "Wed, 08 Apr 2026 12:00:00 GMT",
    });
  });

  it("parses LNReader catalog entries and skips malformed items", () => {
    const entries = parseNovelCatalogEntries([
      {
        id: "plugin.one",
        name: "Plugin One",
        site: "Example",
        lang: "en",
        version: "1.0.0",
        url: "https://example.com/plugin.one.js",
        iconUrl: "https://example.com/plugin.one.png",
        customJS: "https://example.com/plugin.one.custom.js",
        customCSS: "https://example.com/plugin.one.css",
      },
      {
        id: "broken",
        name: "Broken",
        site: "Example",
        lang: "pt-br",
      },
    ], {
      repositoryId: "repo-1",
      fetchedAtMs: 123,
    });

    expect(entries).toEqual([{
      repositoryId: "repo-1",
      pluginId: "plugin.one",
      name: "Plugin One",
      site: "Example",
      lang: "en",
      version: "1.0.0",
      artifactUrl: "https://example.com/plugin.one.js",
      iconUrl: "https://example.com/plugin.one.png",
      customJsUrl: "https://example.com/plugin.one.custom.js",
      customCssUrl: "https://example.com/plugin.one.css",
      manifestHash: null,
      fetchedAtMs: 123,
    }]);
  });

  it("preserves unicode catalog metadata without lossy normalization", () => {
    const [entry] = parseNovelCatalogEntries([{
      id: "69shu",
      name: "69\u4e66\u5427",
      site: "https://www.69shu.xyz",
      lang: "\u4e2d\u6587, \u6c49\u8bed, \u6f22\u8a9e",
      version: "0.2.2",
      url: "https://example.com/69shu.js",
    }], { repositoryId: "repo-1", fetchedAtMs: 123 });

    expect(entry).toMatchObject({
      pluginId: "69shu",
      name: "69\u4e66\u5427",
      lang: "\u4e2d\u6587, \u6c49\u8bed, \u6f22\u8a9e",
    });
  });

  it("filters catalog entries by normalized language code", () => {
    const entries = parseNovelCatalogEntries([
      {
        id: "plugin.one",
        name: "Plugin One",
        site: "Example",
        lang: "en",
        version: "1.0.0",
        url: "https://example.com/plugin.one.js",
      },
      {
        id: "plugin.two",
        name: "Plugin Two",
        site: "Example",
        lang: "pt-BR",
        version: "1.0.0",
        url: "https://example.com/plugin.two.js",
      },
    ], { repositoryId: "repo-1", fetchedAtMs: 123 });

    expect(filterNovelCatalogEntriesByLanguage(entries, ["PT-br"])).toEqual([
      expect.objectContaining({ pluginId: "plugin.two" }),
    ]);
  });

  it("derives available, installed, disabled, and update states", () => {
    const [entry] = parseNovelCatalogEntries([{
      id: "plugin.one",
      name: "Plugin One",
      site: "Example",
      lang: "en",
      version: "2.0.0",
      url: "https://example.com/plugin.one.js",
    }], { repositoryId: "repo-1", fetchedAtMs: 123 });

    expect(deriveNovelCatalogPluginState(entry, null)).toMatchObject({ status: "available" });
    expect(deriveNovelCatalogPluginState(entry, { version: "2.0.0", enabled: true })).toMatchObject({ status: "installed" });
    expect(deriveNovelCatalogPluginState(entry, { version: "1.0.0", enabled: true })).toMatchObject({ status: "update-available" });
    expect(deriveNovelCatalogPluginState(entry, { version: "2.0.0", enabled: false })).toMatchObject({ status: "disabled" });
  });

  it("keeps trust explicit for install and runtime execution", () => {
    expect(canInstallNovelRepository("unknown")).toBe(false);
    expect(canInstallNovelRepository("trusted")).toBe(true);
    expect(canExecuteNovelPlugin("trusted", true)).toBe(true);
    expect(canExecuteNovelPlugin("trusted", false)).toBe(false);
    expect(canExecuteNovelPlugin("unknown", true)).toBe(false);
  });
});
