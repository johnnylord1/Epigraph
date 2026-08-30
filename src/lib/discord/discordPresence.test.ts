import { describe, expect, test, vi } from "vitest";

vi.mock("tauri-plugin-drpc", () => ({
  start: vi.fn(),
  stop: vi.fn(),
  clearActivity: vi.fn(),
  setActivity: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("tauri-plugin-drpc/activity", () => {
  class Timestamps {
    constructor(public start: number, public end?: number) {}
  }
  class Assets {
    large_image?: string;
    large_text?: string;
    small_image?: string;
    small_text?: string;
    setLargeImage(value: string) { this.large_image = value; return this; }
    setLargeText(value: string) { this.large_text = value; return this; }
    setSmallImage(value: string) { this.small_image = value; return this; }
    setSmallText(value: string) { this.small_text = value; return this; }
  }
  class Button {
    constructor(public label: string, public url: string) {}
  }
  class Activity {
    type?: number;
    state?: string;
    details?: string;
    timestamps?: Timestamps;
    assets?: Assets;
    buttons?: Button[];
    setActivity(value: number) { this.type = value; return this; }
    setState(value: string) { this.state = value; return this; }
    setDetails(value: string) { this.details = value; return this; }
    setTimestamps(value: Timestamps) { this.timestamps = value; return this; }
    setAssets(value: Assets) { this.assets = value; return this; }
    setButton(value: Button[]) { this.buttons = value; return this; }
    toString() { return JSON.stringify(this); }
  }
  return { Activity, ActivityType: { Playing: 0, Listening: 2, Watching: 3 }, Assets, Button, Timestamps };
});

import { resolveDiscordCover } from "./coverResolver";
import { canRunDiscordCoverImprovement } from "./coverImprovementGate";
import { DiscordPresenceService, type DiscordPresenceDriver } from "./discordPresenceService";
import { mapGenericReadingPresence, mapNavigationPresence, mapReadingPresence, mapTtsPresence } from "./presenceStateMapper";
import { extractAniListMangaId, extractMyAnimeListMangaId } from "./trackerCoverResolver";
import {
  EPIGRAPH_DISCORD_ACTIVITY_NAME,
  EPIGRAPH_DISCORD_APPLICATION_ID,
  EPIGRAPH_ICON_ASSET,
  DISCORD_STATUS_DISPLAY_DETAILS,
  FALLBACK_COVER_ASSET,
  PRIVATE_DETAILS,
  PROGRESS_UPDATE_INTERVAL_MS,
  type DiscordPresencePayload,
  type DiscordPrivacySettings,
} from "./types";

function createDriver() {
  let now = 1_000;
  const sent: any[] = [];
  const driver: DiscordPresenceDriver = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    clearActivity: vi.fn(async () => {}),
    setActivity: vi.fn(async (activity: { toString(): string }) => {
      sent.push(JSON.parse(activity.toString()));
    }),
    now: () => now,
    sleep: vi.fn(async () => {}),
  };
  return {
    driver,
    sent,
    advance(ms: number) {
      now += ms;
    },
  };
}

function createScheduledDriver() {
  const base = createDriver();
  let scheduled: (() => void) | null = null;
  const driver: DiscordPresenceDriver = {
    ...base.driver,
    schedule: vi.fn((callback) => {
      scheduled = callback;
      return 1;
    }),
    cancelScheduled: vi.fn(() => {
      scheduled = null;
    }),
  };
  return {
    ...base,
    driver,
    runScheduled() {
      const callback = scheduled;
      scheduled = null;
      callback?.();
    },
  };
}

const enabledSettings: DiscordPrivacySettings = {
  discordRpc: true,
  discordRpcShowTitle: true,
  discordRpcShowCover: true,
  discordRpcImproveCovers: false,
  discordRpcShowProgress: true,
  discordRpcPrivateMode: false,
};

function progressPayload(bucket: number): DiscordPresencePayload {
  return {
    kind: "reader",
    details: "Reading Visible Title",
    state: `Chapter 1 - ${bucket}%`,
    stateWithoutProgress: "Chapter 1",
    largeImage: "https://example.com/cover.png",
    largeText: "Visible Title",
    smallImage: EPIGRAPH_ICON_ASSET,
    smallText: "Epigraph",
    progressBucket: bucket,
  };
}

describe("Discord Rich Presence", () => {
  test("uses the official Epigraph application id", async () => {
    const { driver } = createDriver();
    const service = new DiscordPresenceService(driver);

    await service.start();

    expect(driver.start).toHaveBeenCalledWith(EPIGRAPH_DISCORD_APPLICATION_ID);
    expect(EPIGRAPH_ICON_ASSET).toBe("aethon_icon");
  });

  test("reports an absent Discord client and recovers on a later start", async () => {
    const { driver, sent } = createDriver();
    vi.mocked(driver.start)
      .mockRejectedValueOnce(new Error("Discord client unavailable"))
      .mockResolvedValueOnce(undefined);
    const service = new DiscordPresenceService(driver);

    await service.start();
    expect(await service.setPresence(progressPayload(0), enabledSettings, "work-change")).toBe(false);
    expect(sent).toHaveLength(0);

    await service.start();
    expect(await service.setPresence(progressPayload(0), enabledSettings, "work-change")).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("reconnects automatically and publishes the presence requested while Discord was unavailable", async () => {
    const { driver, sent, runScheduled } = createScheduledDriver();
    vi.mocked(driver.start)
      .mockRejectedValueOnce(new Error("Discord client unavailable"))
      .mockResolvedValueOnce(undefined);
    const service = new DiscordPresenceService(driver);

    await service.start();
    expect(await service.setPresence(progressPayload(0), enabledSettings, "work-change")).toBe(false);
    expect(driver.schedule).toHaveBeenCalledTimes(1);

    runScheduled();
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(driver.start).toHaveBeenCalledTimes(2);
    expect(sent[0].details).toBe("Reading Visible Title");
  });

  test("does not reconnect an already healthy client when start is requested twice", async () => {
    const { driver } = createDriver();
    const service = new DiscordPresenceService(driver);

    await service.start();
    await service.start();

    expect(driver.start).toHaveBeenCalledTimes(1);
  });

  test("does not mark a failed activity update as sent and retries it after reconnecting", async () => {
    const { driver, sent, runScheduled } = createScheduledDriver();
    vi.mocked(driver.setActivity)
      .mockRejectedValueOnce(new Error("Discord pipe closed"))
      .mockImplementation(async (activity: { toString(): string }) => {
        sent.push(JSON.parse(activity.toString()));
      });
    const service = new DiscordPresenceService(driver);

    await service.start();
    expect(await service.setPresence(progressPayload(0), enabledSettings, "work-change")).toBe(false);

    runScheduled();
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(driver.start).toHaveBeenCalledTimes(2);
    expect(driver.setActivity).toHaveBeenCalledTimes(2);
  });

  test("clears the activity before stopping the RPC thread", async () => {
    const { driver } = createDriver();
    const service = new DiscordPresenceService(driver);

    await service.start();
    await service.stop();

    expect(driver.clearActivity).toHaveBeenCalledTimes(1);
    expect(driver.stop).toHaveBeenCalledTimes(1);
    expect(vi.mocked(driver.clearActivity).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(driver.stop).mock.invocationCallOrder[0]);
  });

  test("does not send presence when disabled while start is still pending", async () => {
    let releaseStart = () => {};
    const sent: any[] = [];
    const driver: DiscordPresenceDriver = {
      start: vi.fn(() => new Promise<void>((resolve) => {
        releaseStart = resolve;
      })),
      stop: vi.fn(async () => {}),
      clearActivity: vi.fn(async () => {}),
      setActivity: vi.fn(async (activity: { toString(): string }) => {
        sent.push(JSON.parse(activity.toString()));
      }),
      now: () => 1_000,
      sleep: vi.fn(async () => {}),
    };
    const service = new DiscordPresenceService(driver);

    const startPromise = service.start();
    const stopPromise = service.stop();
    const sentWhileDisabled = await service.setPresence(progressPayload(0), enabledSettings, "work-change");

    releaseStart();
    await Promise.all([startPromise, stopPromise]);

    expect(sentWhileDisabled).toBe(false);
    expect(sent).toHaveLength(0);
    expect(driver.clearActivity).toHaveBeenCalledTimes(1);
    expect(driver.stop).toHaveBeenCalledTimes(1);
  });

  test("filters private mode before dedup and send", async () => {
    const { driver, sent } = createDriver();
    const service = new DiscordPresenceService(driver);
    const privateSettings = { ...enabledSettings, discordRpcPrivateMode: true };

    await service.start();
    const first = await service.setPresence({
      kind: "reader",
      details: "Reading Very Private Manga",
      state: "Chapter 99 - 95%",
      largeImage: "https://example.com/private-cover.png",
      largeText: "Very Private Manga",
      smallImage: EPIGRAPH_ICON_ASSET,
      smallText: "Epigraph",
      progressBucket: 95,
    }, privateSettings, "work-change");
    const second = await service.setPresence({
      kind: "reader",
      details: "Reading Another Private Manga",
      state: "Chapter 1 - 5%",
      largeImage: "https://example.com/another-cover.png",
      largeText: "Another Private Manga",
      smallImage: EPIGRAPH_ICON_ASSET,
      smallText: "Epigraph",
      progressBucket: 5,
    }, privateSettings, "work-change");

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(sent).toHaveLength(1);
    const serialized = JSON.stringify(sent[0]);
    expect(serialized).not.toContain("Private Manga");
    expect(serialized).not.toContain("private-cover");
    expect(sent[0].details).toBe(PRIVATE_DETAILS);
    expect(sent[0].name).toBe(EPIGRAPH_DISCORD_ACTIVITY_NAME);
    expect(sent[0].status_display_type).toBe(DISCORD_STATUS_DISPLAY_DETAILS);
  });

  test("throttles progress updates to bucket movement and time", async () => {
    const { driver, sent, advance } = createDriver();
    const service = new DiscordPresenceService(driver);

    await service.start();
    expect(await service.setPresence(progressPayload(0), enabledSettings, "work-change")).toBe(true);
    expect(await service.setPresence(progressPayload(5), enabledSettings, "progress")).toBe(false);

    advance(PROGRESS_UPDATE_INTERVAL_MS);
    expect(await service.setPresence(progressPayload(5), enabledSettings, "progress")).toBe(true);
    expect(sent).toHaveLength(2);
  });

  test("resolves only public https covers", () => {
    expect(resolveDiscordCover("https://cdn.example.com/cover.png")).toBe("https://cdn.example.com/cover.png");
    expect(resolveDiscordCover("/api/v1/manga/1/thumbnail", "https://cdn.example.com/cover.png")).toBe("https://cdn.example.com/cover.png");
    expect(resolveDiscordCover("http://example.com/cover.png")).toBe(FALLBACK_COVER_ASSET);
    expect(resolveDiscordCover("data:image/png;base64,abc")).toBe(FALLBACK_COVER_ASSET);
    expect(resolveDiscordCover("blob:https://example.com/id")).toBe(FALLBACK_COVER_ASSET);
    expect(resolveDiscordCover("https://localhost/cover.png")).toBe(FALLBACK_COVER_ASSET);
    expect(resolveDiscordCover("https://192.168.1.5/cover.png")).toBe(FALLBACK_COVER_ASSET);
  });

  test("gates the future optimized cover pipeline behind every privacy option", () => {
    expect(canRunDiscordCoverImprovement(enabledSettings)).toBe(false);
    expect(canRunDiscordCoverImprovement({ ...enabledSettings, discordRpcImproveCovers: true })).toBe(true);
    expect(canRunDiscordCoverImprovement({ ...enabledSettings, discordRpc: false, discordRpcImproveCovers: true })).toBe(false);
    expect(canRunDiscordCoverImprovement({ ...enabledSettings, discordRpcPrivateMode: true, discordRpcImproveCovers: true })).toBe(false);
    expect(canRunDiscordCoverImprovement({ ...enabledSettings, discordRpcShowCover: false, discordRpcImproveCovers: true })).toBe(false);
  });

  test("maps reader payload with Epigraph assets and progress buckets", () => {
    const payload = mapReadingPresence(
      { id: 1, title: "A Manga", thumbnailUrl: "https://cdn.example.com/a.png" } as any,
      { id: 2, name: "Chapter 4", chapterNumber: 4 } as any,
      37,
    );

    expect(payload.details).toBe("Reading A Manga");
    expect(payload.activityName).toBe(EPIGRAPH_DISCORD_ACTIVITY_NAME);
    expect(payload.statusDisplayType).toBe(DISCORD_STATUS_DISPLAY_DETAILS);
    expect(payload.state).toBe("Chapter 4 - 35%");
    expect(payload.largeImage).toBe("https://cdn.example.com/a.png");
    expect(payload.smallImage).toBeUndefined();
  });

  test("uses a resolved public tracker cover before the local Suwayomi thumbnail", () => {
    const payload = mapReadingPresence(
      { id: 1, title: "A Manga", thumbnailUrl: "/api/v1/manga/1/thumbnail" } as any,
      { id: 2, name: "Chapter 4", chapterNumber: 4 } as any,
      37,
      "https://img.anili.st/media/1.jpg",
    );

    expect(payload.largeImage).toBe("https://img.anili.st/media/1.jpg");
  });

  test("maps generic reading payloads with optional public covers and progress", () => {
    const withCover = mapGenericReadingPresence("A Book", "Chapter 1", "https://cdn.example.com/book.jpg", 42);
    const withLocalCover = mapGenericReadingPresence("A Book", "Chapter 1", "file:///private/book.jpg");

    expect(withCover.details).toBe("Reading A Book");
    expect(withCover.activityName).toBe(EPIGRAPH_DISCORD_ACTIVITY_NAME);
    expect(withCover.statusDisplayType).toBe(DISCORD_STATUS_DISPLAY_DETAILS);
    expect(withCover.state).toBe("Chapter 1 - 40%");
    expect(withCover.stateWithoutProgress).toBe("Chapter 1");
    expect(withCover.progressBucket).toBe(40);
    expect(withCover.largeImage).toBe("https://cdn.example.com/book.jpg");
    expect(withCover.smallImage).toBeUndefined();
    expect(withLocalCover.largeImage).toBe(FALLBACK_COVER_ASSET);
  });

  test("allows context changes through the global throttle", async () => {
    const { driver, sent } = createDriver();
    const service = new DiscordPresenceService(driver);

    await service.start();
    expect(await service.setPresence(mapReadingPresence(
      { id: 1, title: "A Manga", thumbnailUrl: "/api/v1/manga/1/thumbnail" } as any,
      { id: 2, name: "Chapter 4", chapterNumber: 4 } as any,
      0,
    ), enabledSettings, "work-change")).toBe(true);
    expect(await service.setPresence(mapNavigationPresence("library"), enabledSettings, "context-change")).toBe(true);

    expect(sent).toHaveLength(2);
    expect(sent[1].details).toBe("Browsing Library");
  });

  test("preserves Watching activity type through the privacy pipeline", async () => {
    const { driver, sent } = createDriver();
    const service = new DiscordPresenceService(driver);

    await service.start();
    await service.setPresence(
      mapReadingPresence(
        { id: 1, title: "A Manga", thumbnailUrl: "/api/v1/manga/1/thumbnail" } as any,
        { id: 2, name: "Chapter 4", chapterNumber: 4 } as any,
        0,
      ),
      enabledSettings,
      "work-change",
    );

    expect(sent[0].type).toBe(3);
    expect(sent[0].name).toBe(EPIGRAPH_DISCORD_ACTIVITY_NAME);
    expect(sent[0].status_display_type).toBe(DISCORD_STATUS_DISPLAY_DETAILS);
  });

  test("clears stale reader activity before replacing the cover image", async () => {
    const { driver, sent } = createDriver();
    const service = new DiscordPresenceService(driver);
    const manga = { id: 1, title: "A Manga", thumbnailUrl: "/api/v1/manga/1/thumbnail" } as any;
    const chapter = { id: 2, name: "Chapter 4", chapterNumber: 4 } as any;

    await service.start();
    await service.setPresence(mapReadingPresence(manga, chapter, 0), enabledSettings, "work-change");
    await service.setPresence(
      mapReadingPresence(manga, chapter, 0, "https://cdn.example.com/a.png"),
      enabledSettings,
      "work-change",
    );

    expect(driver.clearActivity).toHaveBeenCalledTimes(1);
    expect(driver.sleep).toHaveBeenCalledWith(250);
    expect(sent).toHaveLength(2);
    expect(sent[0].assets.large_image).toBe(FALLBACK_COVER_ASSET);
    expect(sent[1].assets.large_image).toBe("https://cdn.example.com/a.png");
  });

  test("extracts supported tracker ids for external cover lookup", () => {
    expect(extractAniListMangaId("https://anilist.co/manga/123/A-Manga/")).toBe(123);
    expect(extractMyAnimeListMangaId("https://myanimelist.net/manga/456/A_Manga")).toBe(456);
    expect(extractAniListMangaId("https://example.com/manga/123")).toBeNull();
  });


  test("maps TTS payload as Listening", () => {
    const payload = mapTtsPresence("A Manga", "https://cdn.example.com/tts.jpg");

    expect(payload.details).toBe("Listening to A Manga");
    expect(payload.activityType).toBe(2);
    expect(payload.statusDisplayType).toBe(DISCORD_STATUS_DISPLAY_DETAILS);
    expect(payload.largeImage).toBe("https://cdn.example.com/tts.jpg");
  });
  test("uses the app icon as the large image without a small overlay outside reading", () => {
    const payload = mapNavigationPresence("settings");

    expect(payload.details).toBe("Customizing Epigraph");
    expect(payload.statusDisplayType).toBe(DISCORD_STATUS_DISPLAY_DETAILS);
    expect(payload.largeImage).toBe(EPIGRAPH_ICON_ASSET);
    expect(payload.smallImage).toBeUndefined();
  });
});
