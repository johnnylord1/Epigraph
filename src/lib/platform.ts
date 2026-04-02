import { platform } from "@tauri-apps/plugin-os";

export const platformName = platform();
export const isAndroid = platformName === "android";
export const isMobile = isAndroid || platformName === "ios";

const DEFAULT_SERVER_URL = "http://127.0.0.1:4567";

function trimServerUrl(url: string | null | undefined): string {
  return typeof url === "string" && url.trim() ? url.replace(/\/$/, "") : DEFAULT_SERVER_URL;
}

export function getEffectiveServerUrl(rawUrl: string | null | undefined): string {
  const base = trimServerUrl(rawUrl);
  if (!isAndroid) return base;

  try {
    const url = new URL(base);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      url.hostname = "10.0.2.2";
      return url.toString().replace(/\/$/, "");
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return base;
  }
}

