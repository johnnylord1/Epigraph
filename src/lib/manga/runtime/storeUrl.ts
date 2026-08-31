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

function githubRepositoryIndexUrl(url: URL): string | null {
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repository, marker, branch, ...rest] = parts;
  if (!owner || !repository) return null;
  const usesV2Store = owner.toLowerCase() === "keiyoushi" && repository.toLowerCase() === "extensions";
  const indexName = usesV2Store ? "index.pb" : "index.min.json";

  if (parts.length === 2) {
    return `https://raw.githubusercontent.com/${owner}/${repository}/repo/${indexName}`;
  }
  if ((marker === "tree" || marker === "blob") && branch && rest.length === 0) {
    return `https://raw.githubusercontent.com/${owner}/${repository}/${branch}/${indexName}`;
  }
  if ((marker === "blob" || marker === "raw") && branch && rest.length > 0 && /index(?:\.min)?\.(?:json|pb)$/i.test(rest.at(-1) ?? "")) {
    const resolvedPath = usesV2Store && /index\.min\.json$/i.test(rest.at(-1) ?? "")
      ? [...rest.slice(0, -1), "index.pb"]
      : rest;
    return `https://raw.githubusercontent.com/${owner}/${repository}/${branch}/${resolvedPath.join("/")}`;
  }
  return null;
}

export function resolveExtensionStoreInputUrl(value: string): string {
  const canonical = canonicalizeExtensionStoreUrl(value);
  const parsed = new URL(canonical);
  if (
    parsed.hostname.toLowerCase() === "raw.githubusercontent.com"
    && parsed.pathname.toLowerCase() === "/keiyoushi/extensions/repo/index.min.json"
  ) {
    parsed.pathname = "/keiyoushi/extensions/repo/index.pb";
    return canonicalizeExtensionStoreUrl(parsed.toString());
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return canonical;

  const resolved = githubRepositoryIndexUrl(parsed);
  if (resolved) return canonicalizeExtensionStoreUrl(resolved);
  throw new SourceRuntimeError(
    "CONFIGURATION_REQUIRED",
    "Use the GitHub repository root or a direct index.pb/index.json/index.min.json URL.",
  );
}
