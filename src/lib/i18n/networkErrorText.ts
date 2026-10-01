import { translate } from "./runtime";

// A request that never reached its server fails with the WebView's own English wording, not the app language.
const RAW_NETWORK_FAILURES = new Set([
  "failed to fetch",
  "networkerror when attempting to fetch resource.",
  "load failed",
  "network request failed",
]);

export function readableErrorText(text: string): string {
  // String(error) of a rejected fetch keeps its constructor name: "TypeError: Failed to fetch".
  const message = text.trim().toLowerCase().replace(/^typeerror:\s*/, "");
  return RAW_NETWORK_FAILURES.has(message) ? translate("outcomes.network") : text;
}
