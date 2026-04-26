import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { inspectAethonBackupContainer } from "./aethonBackup";
import {
  AETHON_APP_PAYLOAD_FILE_PATH,
  buildAethonAppBackupContainer,
  buildAethonAppPayload,
} from "./appBackup";

describe("app backup payload", () => {
  it("builds a portable app payload with reading state for Home restore", async () => {
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
        exportMode: "full",
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

  it("persists reading state in app backups so Home can restore from backup", async () => {
    const built = await buildAethonAppBackupContainer({
      defaultLocalProfileId: "main",
      history: [
        {
          mangaId: 1,
          mangaTitle: "Alpha",
          thumbnailUrl: "https://example.com/a.png",
          chapterId: 10,
          chapterName: "Chapter 10",
          readAt: 100,
        },
      ],
      readLog: [
        {
          mangaId: 1,
          chapterId: 10,
          readAt: 100,
          minutes: 12,
        },
      ],
      readingStats: {
        totalChaptersRead: 1,
        totalMangaRead: 1,
        totalMinutesRead: 12,
        firstReadAt: 100,
        lastReadAt: 100,
        currentStreakDays: 1,
        longestStreakDays: 1,
        lastStreakDate: "2026-04-17",
      },
    });

    const inspected = await inspectAethonBackupContainer(built.bytes);
    const appFile = inspected.payloadManifests.app?.files.find((file) => file.path === AETHON_APP_PAYLOAD_FILE_PATH);
    expect(appFile).toEqual(expect.objectContaining({ path: AETHON_APP_PAYLOAD_FILE_PATH }));
    const zip = await JSZip.loadAsync(built.bytes);
    const parsed = JSON.parse(await zip.file("payloads/app/profile.json")!.async("text")) as { version: number; history: unknown[]; readLog: unknown[]; readingStats: { totalChaptersRead: number } };
    expect(parsed.version).toBe(2);
    expect(parsed.history).toHaveLength(1);
    expect(parsed.readLog).toHaveLength(1);
    expect(parsed.readingStats.totalChaptersRead).toBe(1);
  });

  it("keeps the app payload builder independent so it can be used in mixed containers later", async () => {
    const payload = buildAethonAppPayload({
      defaultLocalProfileId: "main",
    });

    expect(payload.kind).toBe("app");
    expect(payload.restoreModesSupported).toEqual(["full", "metadata-only"]);
    expect(payload.files?.[0]?.path).toBe(AETHON_APP_PAYLOAD_FILE_PATH);
    expect(new TextDecoder().decode(payload.files?.[0]?.bytes as Uint8Array)).toContain("defaultLocalProfileId");
  });
});
