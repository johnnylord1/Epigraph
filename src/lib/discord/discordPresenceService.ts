import { invoke } from "../tauri/invoke";
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
  schedule?(callback: () => void, ms: number): unknown;
  cancelScheduled?(handle: unknown): void;
}

const defaultDriver: DiscordPresenceDriver = {
  start: (applicationId: string) => invoke("discord_rpc_start", { applicationId }),
  stop: () => invoke("discord_rpc_stop"),
  clearActivity: () => invoke("discord_rpc_clear_activity"),
  setActivity: (activity: Activity) => invoke("discord_rpc_set_activity", { activityJson: activity.toString() }),
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
  schedule: (callback: () => void, ms: number) => globalThis.setTimeout(callback, ms),
  cancelScheduled: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const CLEAR_FLUSH_DELAY_MS = 750;
const RECONNECT_INTERVAL_MS = 15_000;

interface PendingPresence {
  payload: DiscordPresencePayload;
  settings: DiscordPrivacySettings;
  reason: DiscordPresenceReason;
}

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
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private connectionAttempt: Promise<boolean> | null = null;
  private reconnectHandle: unknown | null = null;
  private pendingPresence: PendingPresence | null = null;

  constructor(private readonly driver: DiscordPresenceDriver = defaultDriver) {}

  get startedAt(): number | null {
    return this.sessionStart;
  }

  async start(): Promise<boolean> {
    this.desiredEnabled = true;
    if (this.driverReady) return true;
    if (this.connectionAttempt) return this.connectionAttempt;

    const attempt = this.connect();
    this.connectionAttempt = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connectionAttempt === attempt) this.connectionAttempt = null;
    }
  }

  async stop(): Promise<void> {
    this.desiredEnabled = false;
    this.cancelReconnect();
    this.pendingPresence = null;
    await this.enqueueLifecycle(async () => {
      await this.clearAndStop();
      this.resetState();
    });
  }

  async clear(): Promise<void> {
    this.pendingPresence = null;
    await this.enqueueLifecycle(async () => {
      await this.driver.clearActivity().catch(() => {});
      this.lastSentSignature = null;
      this.lastSentLargeImage = null;
    });
  }

  private async connect(): Promise<boolean> {
    let connected = false;
    await this.enqueueLifecycle(async () => {
      if (!this.desiredEnabled || this.driverReady) {
        connected = this.driverReady;
        return;
      }
      this.sessionStart ??= this.driver.now();
      connected = await this.driver.start(EPIGRAPH_DISCORD_APPLICATION_ID)
        .then(() => true)
        .catch(() => false);
      if (!this.desiredEnabled) {
        if (connected) await this.driver.stop().catch(() => {});
        connected = false;
        return;
      }
      this.driverReady = connected;
      if (connected) {
        this.cancelReconnect();
        this.lastSentAt = 0;
        this.lastSentSignature = null;
        this.lastSentLargeImage = null;
        this.lastProgressSentAt = 0;
        this.lastProgressBucket = null;
      } else {
        this.scheduleReconnect();
      }
    });

    if (connected && this.pendingPresence) {
      const pending = this.pendingPresence;
      await this.setPresence(pending.payload, pending.settings, pending.reason);
    }
    return connected;
  }

  private scheduleReconnect(): void {
    if (!this.desiredEnabled || this.reconnectHandle !== null || !this.driver.schedule) return;
    this.reconnectHandle = this.driver.schedule(() => {
      this.reconnectHandle = null;
      if (this.desiredEnabled) void this.start();
    }, RECONNECT_INTERVAL_MS);
  }

  private cancelReconnect(): void {
    if (this.reconnectHandle === null) return;
    this.driver.cancelScheduled?.(this.reconnectHandle);
    this.reconnectHandle = null;
  }

  private resetState(): void {
    this.sessionStart = null;
    this.lastSentAt = 0;
    this.lastSentSignature = null;
    this.lastSentLargeImage = null;
    this.lastProgressSentAt = 0;
    this.lastProgressBucket = null;
    this.driverReady = false;
    this.connectionAttempt = null;
    this.reconnectHandle = null;
    this.pendingPresence = null;
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
    const pending: PendingPresence = { payload: rawPayload, settings, reason };
    this.pendingPresence = pending;
    await this.lifecycleQueue;
    if (!settings.discordRpc || !this.desiredEnabled) return false;
    if (!this.driverReady) {
      this.scheduleReconnect();
      return false;
    }

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

    try {
      await this.driver.setActivity(toActivity(filtered));
    } catch {
      this.driverReady = false;
      this.scheduleReconnect();
      return false;
    }
    this.lastSentAt = now;
    this.lastSentSignature = signature;
    this.lastSentLargeImage = filtered.largeImage ?? null;
    if (typeof filtered.progressBucket === "number") {
      this.lastProgressBucket = filtered.progressBucket;
      this.lastProgressSentAt = now;
    }
    if (this.pendingPresence === pending) this.pendingPresence = null;
    return true;
  }
}

export const discordPresenceService = new DiscordPresenceService();
