import { invoke } from "@tauri-apps/api/core";
import { Activity, ActivityType, Assets, Button, Timestamps } from "tauri-plugin-drpc/activity";
import { applyPrivacyFilter } from "./privacyFilter";
import {
  EPIGRAPH_DISCORD_APPLICATION_ID,
  NON_IMMEDIATE_UPDATE_INTERVAL_MS,
  PROGRESS_UPDATE_INTERVAL_MS,
  type DiscordPresencePayload,
  type DiscordPresenceReason,
  type DiscordPrivacySettings,
} from "./types";

export interface DiscordPresenceDriver {
  start(applicationId: string): Promise<void>;
  stop(): Promise<void>;
  clearActivity(): Promise<void>;
  setActivity(activity: Activity): Promise<void>;
  now(): number;
  sleep?(ms: number): Promise<void>;
}

const defaultDriver: DiscordPresenceDriver = {
  start: (applicationId: string) => invoke("discord_rpc_start", { applicationId }),
  stop: () => invoke("discord_rpc_stop"),
  clearActivity: () => invoke("discord_rpc_clear_activity"),
  setActivity: (activity: Activity) => invoke("discord_rpc_set_activity", { activityJson: activity.toString() }),
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
};

const CLEAR_FLUSH_DELAY_MS = 750;

const IMMEDIATE_REASONS = new Set<DiscordPresenceReason>([
  "app-open",
  "context-change",
  "work-change",
  "chapter-change",
  "tts-start",
  "tts-stop",
  "download-start",
  "download-stop",
  "migration-start",
  "migration-stop",
  "privacy-change",
]);

function stableSignature(payload: DiscordPresencePayload): string {
  return JSON.stringify({
    kind: payload.kind,
    activityName: payload.activityName,
    activityType: payload.activityType,
    statusDisplayType: payload.statusDisplayType,
    details: payload.details,
    state: payload.state,
    largeImage: payload.largeImage,
    largeText: payload.largeText,
    smallImage: payload.smallImage,
    smallText: payload.smallText,
    startTimestamp: payload.startTimestamp,
    buttons: payload.buttons,
  });
}

function toActivity(payload: DiscordPresencePayload): Activity {
  const assets = new Assets();
  if (payload.largeImage) assets.setLargeImage(payload.largeImage);
  if (payload.largeText) assets.setLargeText(payload.largeText);
  if (payload.smallImage) assets.setSmallImage(payload.smallImage);
  if (payload.smallText) assets.setSmallText(payload.smallText);

  const activity = new Activity()
    .setDetails(payload.details)
    .setAssets(assets);

  if (payload.state) activity.setState(payload.state);
  if (typeof payload.activityType === "number") activity.setActivity(payload.activityType as ActivityType);
  if (payload.startTimestamp) activity.setTimestamps(new Timestamps(payload.startTimestamp));
  if (payload.buttons?.length) {
    activity.setButton(payload.buttons.slice(0, 2).map((button) => new Button(button.label, button.url)));
  }

  const rawActivity = activity as unknown as {
    name?: string;
    status_display_type?: number;
  };
  if (payload.activityName) rawActivity.name = payload.activityName;
  if (typeof payload.statusDisplayType === "number") rawActivity.status_display_type = payload.statusDisplayType;

  return activity;
}

export class DiscordPresenceService {
  private sessionStart: number | null = null;
  private lastSentAt = 0;
  private lastSentSignature: string | null = null;
  private lastSentLargeImage: string | null = null;
  private lastProgressSentAt = 0;
  private lastProgressBucket: number | null = null;
  private desiredEnabled = false;
  private driverReady = false;
  private lifecycleGeneration = 0;
  private lifecycleQueue: Promise<void> = Promise.resolve();

  constructor(private readonly driver: DiscordPresenceDriver = defaultDriver) {}

  get startedAt(): number | null {
    return this.sessionStart;
  }

  async start(): Promise<void> {
    this.desiredEnabled = true;
    const generation = ++this.lifecycleGeneration;
    await this.enqueueLifecycle(async () => {
      if (!this.desiredEnabled || generation !== this.lifecycleGeneration) return;
      this.sessionStart = this.driver.now();
      this.lastSentAt = 0;
      this.lastSentSignature = null;
      this.lastProgressSentAt = 0;
      this.lastProgressBucket = null;
      this.driverReady = await this.driver.start(EPIGRAPH_DISCORD_APPLICATION_ID)
        .then(() => true)
        .catch(() => false);
    });
  }

  async stop(): Promise<void> {
    this.desiredEnabled = false;
    const generation = ++this.lifecycleGeneration;
    await this.enqueueLifecycle(async () => {
      await this.clearAndStop();
      if (generation === this.lifecycleGeneration) this.resetState();
    });
  }

  async clear(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      await this.driver.clearActivity().catch(() => {});
    });
  }

  private resetState(): void {
    this.sessionStart = null;
    this.lastSentAt = 0;
    this.lastSentSignature = null;
    this.lastSentLargeImage = null;
    this.lastProgressSentAt = 0;
    this.lastProgressBucket = null;
    this.driverReady = false;
  }

  private async clearAndStop(): Promise<void> {
    await this.driver.clearActivity().catch(() => {});
    await (this.driver.sleep?.(CLEAR_FLUSH_DELAY_MS) ?? Promise.resolve());
    await this.driver.stop().catch(() => {});
  }

  private enqueueLifecycle(task: () => Promise<void>): Promise<void> {
    const next = this.lifecycleQueue.then(task, task);
    this.lifecycleQueue = next.catch(() => {});
    return next;
  }

  async setPresence(
    rawPayload: DiscordPresencePayload,
    settings: DiscordPrivacySettings,
    reason: DiscordPresenceReason,
  ): Promise<boolean> {
    if (!settings.discordRpc || !this.desiredEnabled) return false;
    await this.lifecycleQueue;
    if (!settings.discordRpc || !this.desiredEnabled || !this.driverReady) return false;

    const now = this.driver.now();
    const filtered = applyPrivacyFilter(
      { ...rawPayload, startTimestamp: rawPayload.startTimestamp ?? this.sessionStart ?? now },
      settings,
    );

    if (reason === "progress") {
      if (typeof filtered.progressBucket !== "number") return false;
      if (this.lastProgressBucket === null) return false;
      const enoughMovement = Math.abs(filtered.progressBucket - this.lastProgressBucket) >= 5;
      const enoughTime = now - this.lastProgressSentAt >= PROGRESS_UPDATE_INTERVAL_MS;
      if (!enoughMovement || !enoughTime) return false;
    }

    const signature = stableSignature(filtered);
    if (signature === this.lastSentSignature) return false;

    const immediate = IMMEDIATE_REASONS.has(reason);
    if (!immediate && now - this.lastSentAt < NON_IMMEDIATE_UPDATE_INTERVAL_MS) return false;

    const largeImageChanged = this.lastSentLargeImage !== null
      && filtered.largeImage !== this.lastSentLargeImage;
    if (largeImageChanged && (filtered.kind === "reader" || filtered.kind === "tts")) {
      await this.driver.clearActivity().catch(() => {});
      await (this.driver.sleep?.(250) ?? Promise.resolve());
    }

    await this.driver.setActivity(toActivity(filtered)).catch(() => {});
    this.lastSentAt = now;
    this.lastSentSignature = signature;
    this.lastSentLargeImage = filtered.largeImage ?? null;
    if (typeof filtered.progressBucket === "number") {
      this.lastProgressBucket = filtered.progressBucket;
      this.lastProgressSentAt = now;
    }
    return true;
  }
}

export const discordPresenceService = new DiscordPresenceService();
