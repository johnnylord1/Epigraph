import { describe, expect, it } from "vitest";
import { inspectAethonBackupContainer } from "./aethonBackup";
import {
  AETHON_APP_PAYLOAD_FILE_PATH,
  buildAethonAppBackupContainer,
  buildAethonAppPayload,
} from "./appBackup";

describe("app backup payload", () => {
  it("builds a minimal portable app payload without turning into a full settings dump", async () => {
    const built = await buildAethonAppBackupContainer({
      defaultLocalProfileId: "test",
      appVersion: "0.7.0",
      platform: "windows",
      sourceProfileId: "main",
    });

    const inspected = await inspectAethonBackupContainer(built.bytes);
    expect(inspected.hasErrors).toBe(false);
    expect(inspected.payloadManifests.app).toEqual(
      expect.objectContaining({
        exportMode: "metadata-only",
        requiresRuntime: "aethon",
        portableByDefault: false,
      }),
    );
    expect(inspected.payloadManifests.app?.files).toEqual([
      expect.objectContaining({
        path: AETHON_APP_PAYLOAD_FILE_PATH,
        role: "profile",
      }),
    ]);
  });

  it("keeps the app payload builder independent so it can be used in mixed containers later", async () => {
    const payload = buildAethonAppPayload({
      defaultLocalProfileId: "main",
    });

    expect(payload.kind).toBe("app");
    expect(payload.restoreModesSupported).toEqual(["metadata-only"]);
    expect(payload.files?.[0]?.path).toBe(AETHON_APP_PAYLOAD_FILE_PATH);
    expect(new TextDecoder().decode(payload.files?.[0]?.bytes as Uint8Array)).toContain("defaultLocalProfileId");
  });
});
