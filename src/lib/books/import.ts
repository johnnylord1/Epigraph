import { computeFileSha256 } from "./storage";
import type { BookSubtype } from "./types";

type ImportFingerprintDeps = {
  computeFileSha256: typeof computeFileSha256;
};

const defaultDeps: ImportFingerprintDeps = {
  computeFileSha256,
};

export async function resolveImportedBookFingerprint(
  sourcePath: string,
  subtype: BookSubtype,
  deps: ImportFingerprintDeps = defaultDeps,
): Promise<{ buffer: ArrayBuffer | null; assetFingerprint: string }> {
  return {
    buffer: null,
    assetFingerprint: await deps.computeFileSha256(sourcePath),
  };
}
