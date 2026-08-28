import {
  EPIGRAPH_DISCORD_ACTIVITY_NAME,
  EPIGRAPH_ICON_ASSET,
  DISCORD_STATUS_DISPLAY_DETAILS,
  FALLBACK_COVER_ASSET,
  PRIVATE_DETAILS,
  type DiscordPresencePayload,
  type DiscordPrivacySettings,
} from "./types";

function cloneFiltered(payload: DiscordPresencePayload): DiscordPresencePayload {
  return {
    kind: payload.kind,
    details: payload.details,
    activityName: EPIGRAPH_DISCORD_ACTIVITY_NAME,
    activityType: payload.activityType,
    statusDisplayType: payload.statusDisplayType,
    state: payload.state,
    stateWithoutProgress: payload.stateWithoutProgress,
    largeImage: payload.largeImage,
    largeText: payload.largeText,
    smallImage: payload.smallImage,
    smallText: payload.smallText,
    startTimestamp: payload.startTimestamp,
    buttons: payload.buttons?.map((button) => ({ ...button })),
    progressBucket: payload.progressBucket,
  };
}

function genericDetails(kind: DiscordPresencePayload["kind"]): string {
  if (kind === "tts") return "Listening in Epigraph";
  if (kind === "reader") return "Reading in Epigraph";
  return PRIVATE_DETAILS;
}

export function applyPrivacyFilter(
  payload: DiscordPresencePayload,
  settings: DiscordPrivacySettings,
): DiscordPresencePayload {
  if (settings.discordRpcPrivateMode) {
    return {
      kind: "private",
      details: PRIVATE_DETAILS,
      activityName: EPIGRAPH_DISCORD_ACTIVITY_NAME,
      statusDisplayType: payload.statusDisplayType ?? DISCORD_STATUS_DISPLAY_DETAILS,
      largeImage: EPIGRAPH_ICON_ASSET,
      largeText: "Epigraph",
      startTimestamp: payload.startTimestamp,
      buttons: payload.buttons?.map((button) => ({ ...button })),
    };
  }

  const filtered = cloneFiltered(payload);

  if (settings.discordRpcShowTitle === false && (filtered.kind === "reader" || filtered.kind === "tts")) {
    filtered.details = genericDetails(filtered.kind);
    filtered.largeText = "Epigraph";
  }

  if (settings.discordRpcShowProgress === false) {
    filtered.state = filtered.stateWithoutProgress;
    delete filtered.progressBucket;
  }
  delete filtered.stateWithoutProgress;

  if (settings.discordRpcShowCover === false && (filtered.kind === "reader" || filtered.kind === "tts")) {
    filtered.largeImage = FALLBACK_COVER_ASSET;
  }

  return filtered;
}
