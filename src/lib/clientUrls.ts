import { getServerUrl } from "./startupClient";

export function serverFileUrl(path: string): string {
  if (!path) return getServerUrl();
  if (path.startsWith("http")) return path;
  return `${getServerUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function thumbUrl(path: string): string {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  return `${getServerUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
