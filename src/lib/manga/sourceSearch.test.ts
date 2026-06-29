import { describe, expect, it } from "vitest";
import { isSourceMangaSearchUnavailableError } from "./sourceSearch";

describe("source manga search capability", () => {
  it("classifies extension search stubs as unavailable", () => {
    expect(isSourceMangaSearchUnavailableError(new Error("Stub!"))).toBe(true);
    expect(isSourceMangaSearchUnavailableError(new Error("UnsupportedOperationException"))).toBe(true);
    expect(isSourceMangaSearchUnavailableError(new Error("Source not installed: 123"))).toBe(true);
  });

  it("does not classify transient request failures as unavailable", () => {
    expect(isSourceMangaSearchUnavailableError(new Error("Failed to fetch"))).toBe(false);
    expect(isSourceMangaSearchUnavailableError(new Error("Suwayomi returned an empty GraphQL error."))).toBe(false);
  });
});
