import { describe, expect, it, vi } from "vitest";
import { resolveImportedBookFingerprint } from "./import";

describe("resolveImportedBookFingerprint", () => {
  it("hashes epub files through the native file path without loading bytes into JS", async () => {
    const computeFileSha256 = vi.fn(async () => "epub-native-hash");

    const result = await resolveImportedBookFingerprint("book.epub", "epub", {
      computeFileSha256,
    });

    expect(result).toEqual({
      buffer: null,
      assetFingerprint: "epub-native-hash",
    });
    expect(computeFileSha256).toHaveBeenCalledWith("book.epub");
  });

  it("hashes pdf files through the native file path without loading bytes into JS", async () => {
    const computeFileSha256 = vi.fn(async () => "pdf-native-hash");

    const result = await resolveImportedBookFingerprint("book.pdf", "pdf", {
      computeFileSha256,
    });

    expect(result).toEqual({
      buffer: null,
      assetFingerprint: "pdf-native-hash",
    });
    expect(computeFileSha256).toHaveBeenCalledWith("book.pdf");
  });
});
