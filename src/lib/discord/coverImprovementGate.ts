import type { DiscordPrivacySettings } from "./types";

export function canResolveDiscordCover(settings: Partial<DiscordPrivacySettings> | null | undefined): boolean {
  return settings?.discordRpc === true
    && settings.discordRpcPrivateMode !== true
    && settings.discordRpcShowCover !== false;
}

export function canRunDiscordCoverImprovement(settings: Partial<DiscordPrivacySettings> | null | undefined): boolean {
  return canResolveDiscordCover(settings)
    && settings.discordRpcImproveCovers === true;
}
