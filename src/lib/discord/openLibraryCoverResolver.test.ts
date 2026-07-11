import { describe, expect, it, vi } from "vitest";

import {
  createOpenLibraryBookDiscordTrackerKey,
  resolveOpenLibraryBookDiscordCover,
} from "./openLibraryCoverResolver";

function response(docs: unknown[]) {
  return {
    ok: true,
    json: vi.fn(async () => ({ docs })),
  } as unknown as Response;
}

describe("OpenLibrary Discord cover resolver", () => {
  it("prefers a matching ISBN and returns a public cover URL", async () => {
    const fetchImpl = vi.fn(async () => response([{
      title: "Different edition title",
      isbn: ["9780306406157"],
      cover_i: 12345,
    }])) as any;

    await expect(resolveOpenLibraryBookDiscordCover({
      title: "Local title",
      author: null,
      isbns: ["978-0-306-40615-7"],
    }, fetchImpl)).resolves.toBe("https://covers.openlibrary.org/b/id/12345-L.jpg?default=false");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("isbn=9780306406157");
  });

  it("accepts an exact title and author match without an ISBN", async () => {
    const fetchImpl = vi.fn(async () => response([{
      title: "Book of the Dead",
      author_name: ["RinoZ"],
      cover_i: 67890,
    }])) as any;

    await expect(resolveOpenLibraryBookDiscordCover({
      title: "Book of the Dead",
      author: "RinoZ",
      isbns: [],
    }, fetchImpl)).resolves.toBe("https://covers.openlibrary.org/b/id/67890-L.jpg?default=false");
  });

  it("rejects title-only ambiguity and mismatched authors", async () => {
    const ambiguousFetch = vi.fn(async () => response([
      { title: "Common Name", author_name: ["One"], cover_i: 1 },
      { title: "Common Name", author_name: ["Two"], cover_i: 2 },
    ])) as any;
    await expect(resolveOpenLibraryBookDiscordCover({
      title: "Common Name",
      author: null,
      isbns: [],
    }, ambiguousFetch)).resolves.toBeNull();

    const wrongAuthorFetch = vi.fn(async () => response([
      { title: "Common Name", author_name: ["Other Author"], cover_i: 1 },
    ])) as any;
    await expect(resolveOpenLibraryBookDiscordCover({
      title: "Common Name",
      author: "Expected Author",
      isbns: [],
    }, wrongAuthorFetch)).resolves.toBeNull();
  });

  it("builds a deterministic lookup key without depending on local paths", () => {
    const key = createOpenLibraryBookDiscordTrackerKey({
      title: "  Álgebra  ",
      author: "Author",
      isbns: ["9780306406157"],
    });
    expect(key).toBe("openlibrary-book-v1:9780306406157:algebra:author");
    expect(key).not.toContain("C:\\");
  });
});
