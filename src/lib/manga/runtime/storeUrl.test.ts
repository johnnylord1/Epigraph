import { describe, expect, test } from "vitest";
import {
  canonicalizeExtensionStoreUrl,
  extensionStoreBaseUrl,
  extensionStoreKey,
  extensionStoreIndexCandidates,
  resolveExtensionStoreInputUrl,
} from "./storeUrl";

describe("extension store URL canonicalization", () => {
  test("normalizes only proven URL equivalences", () => {
    expect(canonicalizeExtensionStoreUrl(" HTTPS://EXAMPLE.COM:443/repo/ "))
      .toBe("https://example.com/repo");
    expect(canonicalizeExtensionStoreUrl("https://example.com/repo#diagnostic"))
      .toBe("https://example.com/repo");
  });

  test("preserves distinct paths and query values", () => {
    expect(canonicalizeExtensionStoreUrl("https://example.com/repo?a=1"))
      .not.toBe(canonicalizeExtensionStoreUrl("https://example.com/repo?a=2"));
    expect(canonicalizeExtensionStoreUrl("https://example.com/repo-a"))
      .not.toBe(canonicalizeExtensionStoreUrl("https://example.com/repo-b"));
  });

  test("rejects credentials and non-http protocols", () => {
    expect(() => canonicalizeExtensionStoreUrl("https://user:secret@example.com/repo"))
      .toThrow(/credential-free/);
    expect(() => canonicalizeExtensionStoreUrl("file:///repo"))
      .toThrow(/credential-free/);
  });

  test("turns a GitHub extension repository page into its compatible raw index", () => {
    expect(resolveExtensionStoreInputUrl("https://github.com/keiyoushi/extensions"))
      .toBe("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb");
    expect(resolveExtensionStoreInputUrl("https://github.com/keiyoushi/extensions/tree/repo"))
      .toBe("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb");
    expect(resolveExtensionStoreInputUrl("https://github.com/keiyoushi/extensions/raw/repo/index.pb"))
      .toBe("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb");
    expect(resolveExtensionStoreInputUrl("https://github.com/keiyoushi/extensions/blob/repo/index.min.json"))
      .toBe("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb");
    expect(resolveExtensionStoreInputUrl("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json"))
      .toBe("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb");
  });

  test("keeps direct index URLs and rejects unrelated GitHub pages", () => {
    expect(resolveExtensionStoreInputUrl("https://example.com/extensions/index.min.json"))
      .toBe("https://example.com/extensions/index.min.json");
    expect(() => resolveExtensionStoreInputUrl("https://github.com/keiyoushi/extensions/issues"))
      .toThrow(/repository root or a direct index/i);
  });
});

describe("backup repository URLs", () => {
  test("expands a bare base URL into index file candidates", () => {
    expect(extensionStoreIndexCandidates("https://raw.githubusercontent.com/a/b/repo"))
      .toEqual(["https://raw.githubusercontent.com/a/b/repo/index.min.json", "https://raw.githubusercontent.com/a/b/repo/index.pb"]);
  });

  test("expands a non-GitHub host base URL", () => {
    expect(extensionStoreIndexCandidates("https://repo.example.org/mihon/"))
      .toEqual(["https://repo.example.org/mihon/index.min.json", "https://repo.example.org/mihon/index.pb"]);
  });

  test("keeps a URL that already names an index file", () => {
    expect(extensionStoreIndexCandidates("https://repo.example.org/x/index.pb"))
      .toEqual(["https://repo.example.org/x/index.pb"]);
  });

  test("baseUrl matches across index file names", () => {
    expect(extensionStoreBaseUrl("https://raw.githubusercontent.com/a/b/repo/index.pb"))
      .toBe(extensionStoreBaseUrl("https://raw.githubusercontent.com/a/b/repo/"));
  });

  test("a GitHub owner and repository match ignoring case, the branch does not", () => {
    const key = extensionStoreKey("https://raw.githubusercontent.com/keiyoushi/extensions/repo");
    expect(extensionStoreKey("https://github.com/Keiyoushi/Extensions/raw/repo/index.pb")).toBe(key);
    expect(extensionStoreKey("HTTPS://Raw.GitHubUserContent.com/KEIYOUSHI/extensions/repo/")).toBe(key);
    expect(extensionStoreKey("https://raw.githubusercontent.com/keiyoushi/extensions/Repo")).not.toBe(key);
    expect(extensionStoreKey("https://repo.example.org/Mihon/")).toBe("https://repo.example.org/Mihon");
  });
});
