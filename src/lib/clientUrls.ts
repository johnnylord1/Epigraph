import { getServerUrl } from "./startupClient";

/* Covers restored from a backup can be inline data or blob URLs, which must not get the server prefix. */
const ABSOLUTE_URL = /^(https?:|data:|blob:|asset:)/i;

export function serverFileUrl(path: string): string {
  if (!path) return getServerUrl();
  if (ABSOLUTE_URL.test(path)) return path;
  return `${getServerUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function thumbUrl(path: string): string {
  if (!path) return "";
  if (ABSOLUTE_URL.test(path)) return path;
  return `${getServerUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
