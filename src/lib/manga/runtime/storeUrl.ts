import { SourceRuntimeError } from "./errors";

export function canonicalizeExtensionStoreUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    if (url.username || url.password) throw new Error("credentials are not allowed");
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch (cause) {
    throw new SourceRuntimeError(
      "CONFIGURATION_REQUIRED",
      "Extension store URL must use credential-free http:// or https://.",
      { cause },
    );
  }
}
