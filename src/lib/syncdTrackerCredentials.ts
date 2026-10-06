import { invoke } from "@tauri-apps/api/core";

/** Suwayomi's fixed tracker ids and the portable keys paired devices use for them. */
const PORTABLE_TRACKER_KEYS: Readonly<Record<number, string>> = {
  1: "myanimelist",
  2: "anilist",
  3: "kitsu",
  4: "shikimori",
  5: "bangumi",
  7: "mangaupdates",
};
const PORTABLE_KEYS = new Set(Object.values(PORTABLE_TRACKER_KEYS));

/** The portable tracker key for a Suwayomi tracker, preferring its name over its id. */
export function portableTrackerKey(tracker: { id: number; name?: string | null }): string | null {
  const byName = (tracker.name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (PORTABLE_KEYS.has(byName)) return byName;
  return PORTABLE_TRACKER_KEYS[tracker.id] ?? null;
}

/** The access token inside a normalized `access_token=...` OAuth callback, or null. */
export function accessTokenFromCallback(callbackUrl: string): string | null {
  const match = callbackUrl.match(/(?:^|[?#&])access_token=([^&#]+)/);
  if (!match?.[1]) return null;
  let token: string;
  try {
    token = decodeURIComponent(match[1]).trim();
  } catch {
    return null;
  }
  return /^[A-Za-z0-9\-_.~+/=]{1,8192}$/.test(token) ? token : null;
}

function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Shares a desktop tracker login with paired devices through the running Core. Only AniList logins have a
 * portable shape; other trackers stay a per-device login. Best effort: a Core that is away or older is not an
 * error, and the token is never logged.
 */
export function publishTrackerLogin(tracker: { id: number; name?: string | null }, callbackUrl: string) {
  if (!inTauri() || portableTrackerKey(tracker) !== "anilist") return;
  const accessToken = accessTokenFromCallback(callbackUrl);
  if (!accessToken) return;
  void invoke("syncd_publish_tracker_login", { trackerKey: "anilist", accessToken }).catch(() => {});
}

/** Shares a confirmed desktop tracker logout with paired devices through the running Core. Best effort. */
export function publishTrackerLogout(tracker: { id: number; name?: string | null }) {
  if (!inTauri()) return;
  const trackerKey = portableTrackerKey(tracker);
  if (!trackerKey) return;
  void invoke("syncd_publish_tracker_logout", { trackerKey }).catch(() => {});
}
