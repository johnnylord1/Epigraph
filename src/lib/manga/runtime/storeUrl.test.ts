import { describe, expect, test } from "vitest";
import {
  canonicalizeExtensionStoreUrl,
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
