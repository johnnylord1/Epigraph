import type {
  ExtensionProvenance,
  ExtensionRef,
  ExtensionStore,
  RuntimeInfo,
} from "./types";

export function createExtensionProvenance(
  extension: ExtensionRef,
  options: {
    runtime?: RuntimeInfo | null;
    store?: ExtensionStore | null;
  } = {},
): ExtensionProvenance {
  const store = options.store ?? null;
  const artifactType = extension.jarUrl ? "jar" : extension.apkUrl ? "apk" : null;
  return {
    packageName: extension.packageName,
    versionCode: extension.versionCode,
    versionName: extension.versionName,
    storeId: extension.storeId,
    storeUrl: store?.indexUrl ?? extension.storeId,
    artifactType,
    artifactDigest: null,
    declaredSigningFingerprint: store?.signingFingerprint ?? null,
    observedSigningFingerprint: null,
    verificationMethod: "NONE",
    trustAnchor: store?.name ?? null,
    runtimeVersion: options.runtime?.version ?? null,
  };
}
