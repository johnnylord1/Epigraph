import type { Chapter, Manga } from "../types";
import { resolveDiscordCover } from "./coverResolver";
import {
  EPIGRAPH_DISCORD_ACTIVITY_NAME,
  EPIGRAPH_ICON_ASSET,
  DISCORD_STATUS_DISPLAY_DETAILS,
  type DiscordButtonPayload,
  type DiscordPresencePayload,
} from "./types";

const DEFAULT_EPIGRAPH_GITHUB_REPO = "johnnylord1/Epigraph";
const EPIGRAPH_GITHUB_REPO = (import.meta.env.VITE_EPIGRAPH_GITHUB_REPO ?? "").trim() || DEFAULT_EPIGRAPH_GITHUB_REPO;
const EPIGRAPH_GITHUB_URL = `https://github.com/${EPIGRAPH_GITHUB_REPO}`;

export const DISCORD_BUTTONS: DiscordButtonPayload[] = [
  { label: "GitHub", url: EPIGRAPH_GITHUB_URL },
];

export function truncatePresenceText(value: string, max = 128): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

export function formatChapter(chapter: Pick<Chapter, "chapterNumber" | "name">): string {
  const n = chapter.chapterNumber;
  if (Number.isFinite(n)) return `Chapter ${Number.isInteger(n) ? n : n.toFixed(1)}`;
  return truncatePresenceText(chapter.name || "Chapter");
}

export function quantizeProgress(progressPercent: number | null | undefined): number | undefined {
  if (typeof progressPercent !== "number" || !Number.isFinite(progressPercent)) return undefined;
  const clamped = Math.max(0, Math.min(100, progressPercent));
  return Math.round(clamped / 5) * 5;
}

function basePayload(kind: DiscordPresencePayload["kind"], details: string): DiscordPresencePayload {
  return {
    kind,
    details,
    activityName: EPIGRAPH_DISCORD_ACTIVITY_NAME,
    statusDisplayType: DISCORD_STATUS_DISPLAY_DETAILS,
    largeImage: EPIGRAPH_ICON_ASSET,
    largeText: "Epigraph",
    buttons: DISCORD_BUTTONS,
  };
}

export function mapNavigationPresence(navPage: string): DiscordPresencePayload {
  if (navPage === "library") return basePayload("navigation", "Browsing Library");
  if (navPage === "search") return basePayload("navigation", "Discovering manga");
  if (navPage === "downloads") return basePayload("downloads", "Downloading chapters");
  if (navPage === "settings") return basePayload("navigation", "Customizing Epigraph");
  return basePayload("navigation", "Exploring Epigraph");
}

export function mapSearchingPresence(): DiscordPresencePayload {
  return basePayload("navigation", "Searching sources");
}

export function mapReadingPresence(
  manga: Manga,
  chapter: Chapter,
  progressPercent?: number,
  publicCoverUrl?: string | null,
): DiscordPresencePayload {
  const chapterLabel = formatChapter(chapter);
  const progressBucket = quantizeProgress(progressPercent);
  const state = progressBucket === undefined ? chapterLabel : `${chapterLabel} - ${progressBucket}%`;
  return {
    ...basePayload("reader", `Reading ${truncatePresenceText(manga.title, 120)}`),
    activityType: 3,
    state,
    stateWithoutProgress: chapterLabel,
    largeImage: resolveDiscordCover(
      publicCoverUrl,
      (manga as Manga & { discordCoverUrl?: string | null; coverUrl?: string | null }).discordCoverUrl,
      (manga as Manga & { discordCoverUrl?: string | null; coverUrl?: string | null }).coverUrl,
      manga.thumbnailUrl,
    ),
    largeText: truncatePresenceText(manga.title),
    progressBucket,
  };
}

export function mapGenericReadingPresence(
  title: string,
  state?: string,
  publicCoverUrl?: string | null,
  progressPercent?: number,
): DiscordPresencePayload {
  const progressBucket = quantizeProgress(progressPercent);
  const stateWithProgress = progressBucket === undefined
    ? state
    : state
      ? `${state} - ${progressBucket}%`
      : `${progressBucket}%`;
  return {
    ...basePayload("reader", `Reading ${truncatePresenceText(title, 120)}`),
    activityType: 3,
    state: stateWithProgress,
    stateWithoutProgress: state,
    largeImage: resolveDiscordCover(publicCoverUrl),
    largeText: truncatePresenceText(title),
    progressBucket,
  };
}

export function mapTtsPresence(title: string, publicCoverUrl?: string | null): DiscordPresencePayload {
  return {
    ...basePayload("tts", `Listening to ${truncatePresenceText(title, 116)}`),
    activityType: 2,
    state: "Text-to-Speech",
    largeImage: resolveDiscordCover(publicCoverUrl),
    largeText: truncatePresenceText(title),
  };
}

export function mapDownloadsPresence(activeCount: number): DiscordPresencePayload {
  return {
    ...basePayload("downloads", "Downloading chapters"),
    state: activeCount > 0 ? `${activeCount} active` : undefined,
  };
}

export function mapMigrationPresence(): DiscordPresencePayload {
  return basePayload("migration", "Migrating library");
}
