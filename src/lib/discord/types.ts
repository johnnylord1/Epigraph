export const EPIGRAPH_DISCORD_APPLICATION_ID = "1522314876649996368";
// These keys must match the assets registered on the public Discord application.
export const EPIGRAPH_ICON_ASSET = "aethon_icon";
export const EPIGRAPH_LOGO_ASSET = "aethon_logo";
export const FALLBACK_COVER_ASSET = "fallback_cover";
export const PRIVATE_DETAILS = "Reading in Epigraph";
export const PROGRESS_UPDATE_INTERVAL_MS = 45_000;
export const NON_IMMEDIATE_UPDATE_INTERVAL_MS = 15_000;
export const EPIGRAPH_DISCORD_ACTIVITY_NAME = "Epigraph";
export const DISCORD_STATUS_DISPLAY_DETAILS = 2;

export type DiscordPresenceKind =
  | "navigation"
  | "reader"
  | "tts"
  | "downloads"
  | "migration"
  | "private";

export type DiscordPresenceReason =
  | "app-open"
  | "navigation"
  | "context-change"
  | "work-change"
  | "chapter-change"
  | "progress"
  | "tts-start"
  | "tts-stop"
  | "download-start"
  | "download-stop"
  | "migration-start"
  | "migration-stop"
  | "privacy-change";

export interface DiscordPrivacySettings {
  discordRpc: boolean;
  discordRpcShowTitle?: boolean;
  discordRpcShowCover?: boolean;
  discordRpcImproveCovers?: boolean;
  discordRpcShowProgress?: boolean;
  discordRpcPrivateMode?: boolean;
}

export interface DiscordButtonPayload {
  label: string;
  url: string;
}

export interface DiscordPresencePayload {
  kind: DiscordPresenceKind;
  details: string;
  activityName?: string;
  activityType?: number;
  statusDisplayType?: number;
  state?: string;
  stateWithoutProgress?: string;
  largeImage?: string;
  largeText?: string;
  smallImage?: string;
  smallText?: string;
  startTimestamp?: number;
  buttons?: DiscordButtonPayload[];
  progressBucket?: number;
}
