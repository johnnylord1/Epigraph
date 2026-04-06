import type { Tracker } from "./types";

export function trackerOAuthResponseType(tracker: Tracker | null | undefined): "token" | "code" {
  if (tracker?.authUrl?.includes("response_type=token")) return "token";
  return "code";
}

export function trackerOAuthParamName(tracker: Tracker | null | undefined): "access_token" | "code" {
  return trackerOAuthResponseType(tracker) === "token" ? "access_token" : "code";
}

export function trackerOAuthExample(tracker: Tracker | null | undefined): string {
  return trackerOAuthParamName(tracker) === "access_token"
    ? "https://suwayomi.org/tracker-oauth#access_token=..."
    : "https://suwayomi.org/tracker-oauth?code=...";
}

export function trackerOAuthShortHint(tracker: Tracker | null | undefined): string {
  return trackerOAuthParamName(tracker) === "access_token"
    ? "Paste the redirected URL, the #access_token fragment, or just the access token."
    : "Paste the redirected URL, the ?code query, or just the authorization code.";
}

function hasOAuthParam(text: string, key: string): boolean {
  return new RegExp(`(?:^|[?#&])${key}=`, "i").test(text);
}

function extractOAuthValue(rawInput: string, key: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const fromSearch = url.searchParams.get(key);
    if (fromSearch) return fromSearch;

    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    const fromHash = hashParams.get(key);
    if (fromHash) return fromHash;
  } catch {}

  const directParams = new URLSearchParams(trimmed.replace(/^[?#]/, ""));
  const directValue = directParams.get(key);
  if (directValue) return directValue;

  const match = trimmed.match(new RegExp(`(?:^|[?#&])${key}=([^&#]+)`, "i"));
  if (match?.[1]) return match[1];

  return null;
}

export function normalizeTrackerOAuthInput(tracker: Tracker | null | undefined, rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return "";

  const key = trackerOAuthParamName(tracker);
  const extracted = extractOAuthValue(trimmed, key);
  if (extracted) return `${key}=${extracted}`;

  const withoutPrefix = trimmed.replace(/^[?#]/, "");
  if (hasOAuthParam(withoutPrefix, key)) {
    const extractedWithoutPrefix = extractOAuthValue(withoutPrefix, key);
    if (extractedWithoutPrefix) return `${key}=${extractedWithoutPrefix}`;
  }

  const rawValue = withoutPrefix
    .replace(/^Bearer\s+/i, "")
    .replace(new RegExp(`^${key}=`, "i"), "")
    .trim();

  if (rawValue && !/[?&#]/.test(rawValue) && !/^[a-z]+:\/\//i.test(rawValue)) {
    return `${key}=${rawValue}`;
  }

  return trimmed;
}
