import type { Manga, Chapter } from "./types";
import { discordPresenceService } from "./discord/discordPresenceService";
import {
  mapDownloadsPresence,
  mapGenericReadingPresence,
  mapMigrationPresence,
  mapNavigationPresence,
  mapReadingPresence,
  mapSearchingPresence,
  mapTtsPresence,
} from "./discord/presenceStateMapper";
import type { DiscordPresenceReason, DiscordPrivacySettings } from "./discord/types";

function defaultSettings(settings?: Partial<DiscordPrivacySettings>): DiscordPrivacySettings {
  return {
    discordRpc: settings?.discordRpc ?? true,
    discordRpcShowTitle: settings?.discordRpcShowTitle ?? true,
    discordRpcShowCover: settings?.discordRpcShowCover ?? true,
    discordRpcImproveCovers: settings?.discordRpcImproveCovers ?? false,
    discordRpcShowProgress: settings?.discordRpcShowProgress ?? true,
    discordRpcPrivateMode: settings?.discordRpcPrivateMode ?? false,
  };
}

export async function initRpc(settings?: Partial<DiscordPrivacySettings>): Promise<void> {
  if (settings && !settings.discordRpc) return;
  await discordPresenceService.start();
}

export async function setReading(
  manga: Manga,
  chapter: Chapter,
  options: {
    progressPercent?: number;
    publicCoverUrl?: string | null;
    settings?: Partial<DiscordPrivacySettings>;
    reason?: DiscordPresenceReason;
  } = {},
): Promise<void> {
  await discordPresenceService.setPresence(
    mapReadingPresence(manga, chapter, options.progressPercent, options.publicCoverUrl),
    defaultSettings(options.settings),
    options.reason ?? "work-change",
  );
}

export async function setGenericReading(
  title: string,
  settings?: Partial<DiscordPrivacySettings>,
  reason: DiscordPresenceReason = "work-change",
  state?: string,
  publicCoverUrl?: string | null,
  progressPercent?: number,
): Promise<void> {
  await discordPresenceService.setPresence(
    mapGenericReadingPresence(title, state, publicCoverUrl, progressPercent),
    defaultSettings(settings),
    reason,
  );
}

export async function setNavigationPresence(
  navPage: string,
  settings?: Partial<DiscordPrivacySettings>,
  reason: DiscordPresenceReason = "navigation",
): Promise<void> {
  await discordPresenceService.setPresence(
    mapNavigationPresence(navPage),
    defaultSettings(settings),
    reason,
  );
}

export async function setSearchingPresence(settings?: Partial<DiscordPrivacySettings>): Promise<void> {
  await discordPresenceService.setPresence(
    mapSearchingPresence(),
    defaultSettings(settings),
    "navigation",
  );
}

export async function setDownloadPresence(
  activeCount: number,
  settings?: Partial<DiscordPrivacySettings>,
  reason: DiscordPresenceReason = activeCount > 0 ? "download-start" : "download-stop",
): Promise<void> {
  await discordPresenceService.setPresence(
    activeCount > 0 ? mapDownloadsPresence(activeCount) : mapNavigationPresence("downloads"),
    defaultSettings(settings),
    reason,
  );
}

export async function setTtsPresence(
  title: string,
  active: boolean,
  settings?: Partial<DiscordPrivacySettings>,
  publicCoverUrl?: string | null,
): Promise<void> {
  await discordPresenceService.setPresence(
    active ? mapTtsPresence(title, publicCoverUrl) : mapGenericReadingPresence(title, undefined, publicCoverUrl),
    defaultSettings(settings),
    active ? "tts-start" : "tts-stop",
  );
}

export async function setMigrationPresence(
  active: boolean,
  settings?: Partial<DiscordPrivacySettings>,
  fallbackNavPage = "library",
): Promise<void> {
  await discordPresenceService.setPresence(
    active ? mapMigrationPresence() : mapNavigationPresence(fallbackNavPage),
    defaultSettings(settings),
    active ? "migration-start" : "migration-stop",
  );
}

export async function setIdle(settings?: Partial<DiscordPrivacySettings>): Promise<void> {
  await setNavigationPresence("home", settings, "navigation");
}

export async function clearReading(): Promise<void> {
  await discordPresenceService.clear();
}

export async function destroyRpc(): Promise<void> {
  await discordPresenceService.stop();
}
