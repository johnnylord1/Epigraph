import { describe, expect, test } from "vitest";
import { canonicalizeExtensionStoreUrl } from "./storeUrl";

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
});
