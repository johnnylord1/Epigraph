import { beforeEach, describe, expect, it, vi } from "vitest";

const { httpFetch } = vi.hoisted(() => ({ httpFetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: httpFetch }));

import {
  createEmptyHardcoverState,
  isHardcoverRateLimitError,
  saveHardcoverState,
  searchHardcoverBooks,
  validateHardcoverToken,
} from "./hardcover";

const storage = new Map<string, string>();
const scope = { profileId: "main", serverUrl: "http://127.0.0.1:4567" };

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
});
