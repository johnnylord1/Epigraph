import { describe, expect, test } from "vitest";

import { CompatibilityProfileV21, CompatibilityProfileV23 } from "./compatibility";

describe("Suwayomi compatibility profiles", () => {
  test("maps legacy extension repositories without pretending they are verified stores", () => {
    const profile = new CompatibilityProfileV21();
    const stores = profile.operations.listStores.decode({
      settings: {
        extensionRepos: ["https://example.test/repo/index.min.json"],
      },
    });

    expect(stores).toEqual([
      {
        id: "https://example.test/repo/index.min.json",
        name: "https://example.test/repo/index.min.json",
        indexUrl: "https://example.test/repo/index.min.json",
        badgeLabel: null,
        signingFingerprint: null,
        contactWebsite: null,
        contactDiscord: null,
        extensionListUrl: null,
        isLegacy: true,
      },
    ]);
    expect(profile.contract.requiredQueries).toContain("settings");
    expect(profile.contract.requiredQueries).not.toContain("extensionStores");
  });

  test("maps v23 stores and preserves the declared signing fingerprint", () => {
    const profile = new CompatibilityProfileV23();
    const stores = profile.operations.listStores.decode({
      extensionStores: {
        nodes: [
          {
            name: "Keiyoushi",
            badgeLabel: "Recommended",
            signingKey: "declared-key",
            contactWebsite: "https://keiyoushi.github.io",
            contactDiscord: null,
            indexUrl: "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
            isLegacy: false,
            extensionListUrl: "https://example.test/extensions.json",
          },
        ],
      },
    });

    expect(stores[0]).toMatchObject({
      name: "Keiyoushi",
      signingFingerprint: "declared-key",
      isLegacy: false,
    });
    expect(profile.contract.requiredQueries).toContain("extensionStores");
    expect(profile.contract.optionalCapabilities).toContain("directJarInstall");
  });

  test("keeps schema differences inside profile operations", () => {
    const v21 = new CompatibilityProfileV21();
    const v23 = new CompatibilityProfileV23();

    expect(v21.operations.listExtensions.document).toContain("versionCode");
    expect(v21.operations.listExtensions.document).not.toContain("versionCodeLong");
    expect(v23.operations.listExtensions.document).toContain("versionCodeLong");
    expect(v23.operations.listExtensions.document).toContain("jarUrl");

    const extensions = v23.operations.listExtensions.decode({
      extensions: {
        nodes: [
          {
            pkgName: "eu.kanade.tachiyomi.extension.en.demo",
            name: "Demo",
            lang: "en",
            versionName: "1.0.0",
            versionCodeLong: "100",
            isInstalled: true,
            isObsolete: false,
            hasUpdate: false,
            iconUrl: "/api/v1/extension/icon/demo",
            storeIndexUrl: "https://example.test/store.json",
            apkName: null,
            apkUrl: null,
            jarUrl: "https://example.test/demo.jar",
          },
        ],
      },
    });

    expect(extensions[0]).toMatchObject({
      packageName: "eu.kanade.tachiyomi.extension.en.demo",
      versionCode: "100",
      storeId: "https://example.test/store.json",
      jarUrl: "https://example.test/demo.jar",
    });
  });

  test("requires every extension, source, and store field selected by profile operations", () => {
    const v21 = new CompatibilityProfileV21();
    const v23 = new CompatibilityProfileV23();

    expect(v21.contract.requiredFields.ExtensionType).toEqual(expect.arrayContaining([
      "iconUrl",
      "repo",
      "apkName",
    ]));
    expect(v23.contract.requiredFields.ExtensionType).toEqual(expect.arrayContaining([
      "iconUrl",
      "storeIndexUrl",
      "apkName",
      "apkUrl",
      "jarUrl",
    ]));
    expect(v23.contract.requiredFields.ExtensionStoreType).toEqual(expect.arrayContaining([
      "badgeLabel",
      "contactWebsite",
      "contactDiscord",
      "extensionListUrl",
    ]));
    for (const profile of [v21, v23]) {
      expect(profile.contract.requiredFields.SourceType).toEqual(expect.arrayContaining([
        "supportsLatest",
        "isConfigurable",
        "extension",
      ]));
    }
  });

  test("preserves unknown future preference types as read-only presentation data", () => {
    const profile = new CompatibilityProfileV23();
    const preferences = profile.operations.sourcePreferences.decode({
      source: {
        preferences: [{
          __typename: "FuturePreference",
        }],
      },
    });

    expect(preferences).toEqual([{
      type: "UnsupportedPreference",
      upstreamType: "FuturePreference",
      key: "position:0",
      title: "position:0",
      summary: null,
      enabled: true,
      visible: true,
    }]);
  });
});
