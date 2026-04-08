export function toSuwayomiWebViewUrl(serverUrl: string, targetUrl: string, lang = "en"): string {
  const wrapper = new URL("/api/v1/webview", serverUrl);
  wrapper.searchParams.set("lang", lang);
  return `${wrapper.toString()}#${encodeURIComponent(targetUrl)}`;
}
