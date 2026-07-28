import { beforeEach, describe, expect, it, vi } from "vitest";

const { httpFetch } = vi.hoisted(() => ({ httpFetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: httpFetch }));

import {
  createEmptyHardcoverState,
  isHardcoverRateLimitError,
  loadHardcoverState,
  saveHardcoverState,
  searchHardcoverBooks,
  upsertHardcoverUserBook,
  validateHardcoverToken,
} from "./hardcover";

const storage = new Map<string, string>();
const scope = { profileId: "main", serverUrl: "http://127.0.0.1:4567" };
const hardcoverBook = {
  id: 1435,
  title: "Lord of the Mysteries",
  authors: ["Cuttlefish"],
  genres: ["Fantasy"],
  tags: [],
  moods: [],
  coverUrl: null,
  description: null,
  releaseYear: null,
  rating: 4.5,
  ratingsCount: 10,
  slug: "lord-of-the-mysteries",
  url: "https://hardcover.app/books/lord-of-the-mysteries",
  workStatus: "Completed",
};

describe("Hardcover transport contracts", () => {
  beforeEach(() => {
    httpFetch.mockReset();
    storage.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
        clear: () => storage.clear(),
      },
    });
  });

  it("retries authorization with Bearer and validates the profile", async () => {
    httpFetch
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { me: [{ id: 7, username: "reader" }] } }), { status: 200 }));

    await expect(validateHardcoverToken("release-cert-token-a")).resolves.toEqual({ userId: 7, username: "reader" });
    expect(httpFetch).toHaveBeenCalledTimes(2);
    expect(httpFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer release-cert-token-a");
  });

  it("does not expose a rejected credential in errors", async () => {
    const secret = "release-cert-secret-token";
    httpFetch.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ message: `token=${secret}` }), { status: 403 }),
    ));

    let error: Error | null = null;
    try {
      await validateHardcoverToken(secret);
    } catch (reason) {
      error = reason instanceof Error ? reason : new Error(String(reason));
    }
    expect(error).not.toBeNull();
    expect(error!.message).toContain("HTTP 403");
    expect(error!.message).not.toContain(secret);
  });

  it("recognizes rate limiting and does not retry it as authorization", async () => {
    httpFetch.mockResolvedValueOnce(new Response(JSON.stringify({ message: "rate limit" }), { status: 429 }));
    const error = await validateHardcoverToken("release-cert-token-rate-limit").catch((reason) => reason);

    expect(isHardcoverRateLimitError(error)).toBe(true);
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it("returns a known cached search without another network request", async () => {
    const state = createEmptyHardcoverState(scope);
    saveHardcoverState({
      ...state,
      auth: { ...state.auth, connected: true, token: "cached-token" },
      searchCache: {
        "v11:default:cached title:8:1:::": [{
          id: 1,
          title: "Cached Title",
          authors: [],
          genres: [],
          tags: [],
          moods: [],
          coverUrl: null,
          description: null,
          releaseYear: null,
          rating: null,
          ratingsCount: null,
          slug: null,
          url: null,
          workStatus: null,
        }],
      },
    }, scope);

    await expect(searchHardcoverBooks(scope, "Cached Title")).resolves.toHaveLength(1);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it("creates a remote user book with the selected status before saving locally", async () => {
    const state = createEmptyHardcoverState(scope);
    saveHardcoverState({
      ...state,
      auth: { ...state.auth, connected: true, token: "write-token", userId: 7 },
    }, scope);
    httpFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { user_books: [] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { insert_user_book: { id: 55, error: null } },
      }), { status: 200 }));

    await expect(upsertHardcoverUserBook(scope, {
      book: hardcoverBook,
      sourceNovelId: "novel:lotm",
      status: "Currently Reading",
      rating: 4,
    })).resolves.toMatchObject({
      userBookId: 55,
      status: "Currently Reading",
      rating: 4,
    });

    const request = JSON.parse(String(httpFetch.mock.calls[1][1].body));
    expect(request.query).toContain("insert_user_book");
    expect(request.variables).toMatchObject({ bookId: 1435, statusId: 2, rating: 4 });
  });

  it("updates an existing remote user book instead of inserting a duplicate", async () => {
    const state = createEmptyHardcoverState(scope);
    saveHardcoverState({
      ...state,
      auth: { ...state.auth, connected: true, token: "update-token", userId: 7 },
      records: [{
        userBookId: 55,
        bookId: hardcoverBook.id,
        title: hardcoverBook.title,
        authors: hardcoverBook.authors,
        genres: hardcoverBook.genres,
        tags: [],
        moods: [],
        coverUrl: null,
        status: "Want to Read",
        workStatus: "Completed",
        rating: null,
        progress: null,
        remoteUrl: hardcoverBook.url,
        updatedAt: 1,
        sourceNovelId: "novel:lotm",
        sourceTitleKey: "novel:lord of the mysteries",
      }],
    }, scope);
    httpFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      data: { update_user_book: { id: 55, error: null } },
    }), { status: 200 }));

    await upsertHardcoverUserBook(scope, {
      book: hardcoverBook,
      sourceNovelId: "novel:lotm",
      status: "Read",
      rating: 5,
    });

    const request = JSON.parse(String(httpFetch.mock.calls[0][1].body));
    expect(request.query).toContain("update_user_book");
    expect(request.variables).toMatchObject({ id: 55, statusId: 3, rating: 5 });
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it("does not report a local tracking success when the remote write fails", async () => {
    const state = createEmptyHardcoverState(scope);
    saveHardcoverState({
      ...state,
      auth: { ...state.auth, connected: true, token: "failed-write-token", userId: 7 },
    }, scope);
    httpFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      errors: [{ message: "remote write failed" }],
    }), { status: 200 }));

    await expect(upsertHardcoverUserBook(scope, {
      book: hardcoverBook,
      sourceNovelId: "novel:lotm",
    })).rejects.toThrow("remote write failed");
    expect(loadHardcoverState(scope).records).toEqual([]);
  });
});
