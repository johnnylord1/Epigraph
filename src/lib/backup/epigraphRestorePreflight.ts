import type { EpigraphBackupKnownPayloadKind } from "./epigraphBackup";

export type EpigraphRestorePreflightDeps = {
  parseManga: (bytes: Uint8Array | ArrayBuffer) => Promise<{ payloadBytes: Uint8Array }>;
  parseNativeManga: (bytes: Uint8Array | ArrayBuffer, inventory: never[]) => Promise<unknown>;
  parseBooks: (bytes: Uint8Array | ArrayBuffer) => Promise<unknown>;
  parseNovels: (bytes: Uint8Array | ArrayBuffer) => Promise<unknown>;
  parseApp: (bytes: Uint8Array | ArrayBuffer) => Promise<unknown>;
};

export async function preflightEpigraphRestorePayloads(
  bytes: Uint8Array | ArrayBuffer,
  selectedKinds: readonly (EpigraphBackupKnownPayloadKind | string)[],
  deps: EpigraphRestorePreflightDeps,
): Promise<Partial<Record<EpigraphBackupKnownPayloadKind, unknown>>> {
  const parsed: Partial<Record<EpigraphBackupKnownPayloadKind, unknown>> = {};

  for (const kind of ["manga", "books", "novels", "app"] as const) {
    if (!selectedKinds.includes(kind)) continue;

    if (kind === "manga") {
      const manga = await deps.parseManga(bytes);
      await deps.parseNativeManga(manga.payloadBytes, []);
      parsed.manga = manga;
    } else if (kind === "books") {
      parsed.books = await deps.parseBooks(bytes);
    } else if (kind === "novels") {
      parsed.novels = await deps.parseNovels(bytes);
    } else {
      parsed.app = await deps.parseApp(bytes);
    }
  }

  return parsed;
}
