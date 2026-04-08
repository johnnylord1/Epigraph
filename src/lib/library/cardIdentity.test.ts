import { describe, expect, it } from "vitest";
import {
  createBookLibraryCardId,
  createComicLibraryCardId,
  isBookLibraryCardId,
  isComicLibraryCardId,
} from "./cardIdentity";

describe("cardIdentity", () => {
  it("creates stable comics ids from canonical manga identity", () => {
    expect(createComicLibraryCardId(42)).toBe("comic:42");
    expect(createComicLibraryCardId(42)).toBe(createComicLibraryCardId(42));
    expect(isComicLibraryCardId(createComicLibraryCardId(42))).toBe(true);
    expect(isBookLibraryCardId(createComicLibraryCardId(42))).toBe(false);
  });

  it("creates stable books ids from canonical local book identity", () => {
    expect(createBookLibraryCardId("epub-abc")).toBe("book:epub-abc");
    expect(createBookLibraryCardId("epub-abc")).toBe(createBookLibraryCardId("epub-abc"));
    expect(isBookLibraryCardId(createBookLibraryCardId("epub-abc"))).toBe(true);
    expect(isComicLibraryCardId(createBookLibraryCardId("epub-abc"))).toBe(false);
  });
});
