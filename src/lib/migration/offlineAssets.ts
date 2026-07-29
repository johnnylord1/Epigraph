import type {
  OfflineAssetKind,
  OfflineAssetManifestEntry,
  OfflineAssetReference,
} from "./types";

export type {
  OfflineAssetManifestEntry,
  OfflineAssetReference,
} from "./types";

export interface ProvenOfflineAssetPair {
  source: OfflineAssetReference;
  target: OfflineAssetReference;
}

export interface NovelOfflineAssetInspection {
  bytes: Uint8Array;
  valid: boolean;
}

export interface NovelOfflineAssetCachePort {
  inspect(reference: OfflineAssetReference): Promise<NovelOfflineAssetInspection | null>;
  write(reference: OfflineAssetReference, bytes: Uint8Array): Promise<void>;
}

function manifestEntry(
  kind: OfflineAssetKind,
  pair: ProvenOfflineAssetPair,
  input: Pick<
    OfflineAssetManifestEntry,
    "sha256" | "size" | "integrity" | "status"
  >,
): OfflineAssetManifestEntry {
  return {
    version: 1,
    kind,
    source: { ...pair.source },
    target: { ...pair.target },
    sha256: input.sha256,
    size: input.size,
    integrity: input.integrity,
    status: input.status,
    sourcePreserved: true,
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifiedAsset(
  inspection: NovelOfflineAssetInspection,
): Promise<{ bytes: Uint8Array; sha256: string; size: number } | null> {
  if (!inspection.valid || inspection.bytes.byteLength === 0) return null;
  const bytes = Uint8Array.from(inspection.bytes);
  return {
    bytes,
    sha256: await sha256Hex(bytes),
    size: bytes.byteLength,
  };
}

export function buildMangaDownloadedAssetManifest(
  provenDownloadedPairs: readonly ProvenOfflineAssetPair[],
): OfflineAssetManifestEntry[] {
  return provenDownloadedPairs.map((pair) => manifestEntry("manga", pair, {
    sha256: null,
    size: null,
    integrity: "not_observed",
    status: "pending",
  }));
}

export async function copyVerifiedNovelOfflineAssets(
  provenPairs: readonly ProvenOfflineAssetPair[],
  port: NovelOfflineAssetCachePort,
): Promise<OfflineAssetManifestEntry[]> {
  const entries: OfflineAssetManifestEntry[] = [];

  for (const pair of provenPairs) {
    let sourceInspection: NovelOfflineAssetInspection | null;
    try {
      sourceInspection = await port.inspect(pair.source);
    } catch {
      entries.push(manifestEntry("novel", pair, {
        sha256: null,
        size: null,
        integrity: "not_observed",
        status: "pending",
      }));
      continue;
    }

    if (!sourceInspection) {
      entries.push(manifestEntry("novel", pair, {
        sha256: null,
        size: null,
        integrity: "not_observed",
        status: "pending",
      }));
      continue;
    }

    const sourceAsset = await verifiedAsset(sourceInspection);
    if (!sourceAsset) {
      entries.push(manifestEntry("novel", pair, {
        sha256: null,
        size: sourceInspection.bytes.byteLength,
        integrity: "corrupt",
        status: "pending",
      }));
      continue;
    }

    let existingTarget: NovelOfflineAssetInspection | null;
    try {
      existingTarget = await port.inspect(pair.target);
    } catch {
      entries.push(manifestEntry("novel", pair, {
        sha256: sourceAsset.sha256,
        size: sourceAsset.size,
        integrity: "not_observed",
        status: "pending",
      }));
      continue;
    }

    if (existingTarget) {
      const existingAsset = await verifiedAsset(existingTarget);
      if (
        existingAsset
        && existingAsset.sha256 === sourceAsset.sha256
        && existingAsset.size === sourceAsset.size
        && bytesEqual(existingAsset.bytes, sourceAsset.bytes)
      ) {
        entries.push(manifestEntry("novel", pair, {
          sha256: sourceAsset.sha256,
          size: sourceAsset.size,
          integrity: "verified",
          status: "already_present",
        }));
        continue;
      }
      if (existingAsset) {
        entries.push(manifestEntry("novel", pair, {
          sha256: sourceAsset.sha256,
          size: sourceAsset.size,
          integrity: "verified",
          status: "pending",
        }));
        continue;
      }
    }

    try {
      await port.write(pair.target, Uint8Array.from(sourceAsset.bytes));
    } catch {
      entries.push(manifestEntry("novel", pair, {
        sha256: sourceAsset.sha256,
        size: sourceAsset.size,
        integrity: "not_observed",
        status: "pending",
      }));
      continue;
    }

    let copiedInspection: NovelOfflineAssetInspection | null;
    try {
      copiedInspection = await port.inspect(pair.target);
    } catch {
      copiedInspection = null;
    }
    const copiedAsset = copiedInspection
      ? await verifiedAsset(copiedInspection)
      : null;

    const copyVerified = copiedAsset
      && copiedAsset.sha256 === sourceAsset.sha256
      && copiedAsset.size === sourceAsset.size
      && bytesEqual(copiedAsset.bytes, sourceAsset.bytes);

    entries.push(manifestEntry("novel", pair, {
      sha256: sourceAsset.sha256,
      size: sourceAsset.size,
      integrity: copyVerified ? "verified" : "corrupt",
      status: copyVerified ? "copied" : "pending",
    }));
  }

  return entries;
}
