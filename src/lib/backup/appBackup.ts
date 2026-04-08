import JSZip from "jszip";
import {
  buildAethonBackupContainer,
  inspectAethonBackupContainer,
  type AethonBackupPayloadBuildInput,
  type AethonBackupPayloadManifest,
  type BuiltAethonBackupContainer,
  type InspectedAethonBackupContainer,
} from "./aethonBackup";
import { normalizeLocalProfileId, type LocalProfileId } from "../localProfiles";

export const AETHON_APP_PAYLOAD_FILE_PATH = "profile.json";

export interface AethonAppProfilePayload {
  version: 1;
  defaultLocalProfileId: LocalProfileId;
}

export interface ParsedAethonAppPayload {
  inspection: InspectedAethonBackupContainer;
  payloadManifest: AethonBackupPayloadManifest;
  profile: AethonAppProfilePayload;
}

function jsonBytes(input: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(input, null, 2)}\n`);
}

export function buildAethonAppPayload(input: {
  defaultLocalProfileId: LocalProfileId;
}): AethonBackupPayloadBuildInput {
  return {
    kind: "app",
    exportMode: "metadata-only",
    restoreModesSupported: ["metadata-only"],
    requiresRuntime: "aethon",
    requiresRepositories: [],
    portableByDefault: false,
    metadata: {
      schemaVersion: 1,
      portableMetadataOnly: true,
    },
    files: [
      {
        path: AETHON_APP_PAYLOAD_FILE_PATH,
        bytes: jsonBytes({
          version: 1,
          defaultLocalProfileId: input.defaultLocalProfileId,
        } satisfies AethonAppProfilePayload),
        contentType: "application/json",
        role: "profile",
      },
    ],
  };
}

export async function buildAethonAppBackupContainer(
  input: {
    defaultLocalProfileId: LocalProfileId;
    appVersion?: string | null;
    platform?: string | null;
    sourceProfileId?: string | null;
  },
): Promise<BuiltAethonBackupContainer> {
  return buildAethonBackupContainer({
    appVersion: input.appVersion ?? null,
    platform: input.platform ?? null,
    sourceSurface: "desktop",
    sourceProfileId: input.sourceProfileId ?? null,
    payloads: [
      buildAethonAppPayload({
        defaultLocalProfileId: input.defaultLocalProfileId,
      }),
    ],
  });
}

export async function parseAethonAppPayload(
  bytes: Uint8Array | ArrayBuffer,
): Promise<ParsedAethonAppPayload> {
  const inspection = await inspectAethonBackupContainer(bytes);
  if (inspection.hasErrors) {
    throw new Error("Aethon backup container failed inspection.");
  }

  const payloadManifest = inspection.payloadManifests.app;
  if (!payloadManifest) {
    throw new Error("The selected Aethon backup does not contain an app payload.");
  }

  const fileRecord = payloadManifest.files.find((file) => file.path === AETHON_APP_PAYLOAD_FILE_PATH);
  if (!fileRecord) {
    throw new Error("App payload is missing profile.json.");
  }

  const zip = await JSZip.loadAsync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const file = zip.file(`payloads/app/${AETHON_APP_PAYLOAD_FILE_PATH}`);
  if (!file) {
    throw new Error("App payload is missing profile.json.");
  }

  let parsed: AethonAppProfilePayload;
  try {
    parsed = JSON.parse(await file.async("text")) as AethonAppProfilePayload;
  } catch {
    throw new Error("App payload is not valid JSON.");
  }

  if (parsed.version !== 1) {
    throw new Error("App payload uses an unsupported schema version.");
  }

  const defaultLocalProfileId = normalizeLocalProfileId(parsed.defaultLocalProfileId);
  if (!defaultLocalProfileId) {
    throw new Error("App payload defaultLocalProfileId is invalid.");
  }

  return {
    inspection,
    payloadManifest,
    profile: {
      version: 1,
      defaultLocalProfileId,
    },
  };
}
