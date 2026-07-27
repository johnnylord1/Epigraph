import { describe, expect, test } from "vitest";

import { createExtensionProvenance } from "./provenance";
import type { ExtensionRef, ExtensionStore, RuntimeInfo } from "./types";

const extension: ExtensionRef = {
  packageName: "eu.kanade.tachiyomi.extension.en.demo",
  name: "Demo",
  language: "en",
  versionName: "1.2.3",
  versionCode: "123",
  isInstalled: true,
  isObsolete: false,
  hasUpdate: false,
  iconUrl: null,
  storeId: "https://example.test/store.json",
  apkName: null,
  apkUrl: null,
  jarUrl: "https://example.test/demo.jar",
};

const store: ExtensionStore = {
  id: "https://example.test/store.json",
  name: "Example Store",
  indexUrl: "https://example.test/store.json",
  badgeLabel: null,
  signingFingerprint: "declared-only",
  contactWebsite: null,
  contactDiscord: null,
  extensionListUrl: null,
  isLegacy: false,
};

const runtime: RuntimeInfo = {
  name: "Suwayomi",
  version: "v2.3.2243",
  revision: "2243",
  buildType: "Stable",
  buildTime: null,
  profileId: "suwayomi-v23",
  schemaHash: "schema",
  compatible: true,
};

describe("extension provenance", () => {
  test("records declared store metadata without claiming artifact verification", () => {
    expect(createExtensionProvenance(extension, { store, runtime })).toEqual({
      packageName: extension.packageName,
      versionCode: "123",
      versionName: "1.2.3",
      storeId: store.id,
      storeUrl: store.indexUrl,
      artifactType: "jar",
      artifactDigest: null,
      declaredSigningFingerprint: "declared-only",
      observedSigningFingerprint: null,
      verificationMethod: "NONE",
      trustAnchor: "Example Store",
      runtimeVersion: "v2.3.2243",
    });
  });
});
