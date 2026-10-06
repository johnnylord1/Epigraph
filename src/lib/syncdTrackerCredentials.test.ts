import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  accessTokenFromCallback,
  portableTrackerKey,
  publishTrackerLogin,
  publishTrackerLogout,
} from "./syncdTrackerCredentials";

describe("desktop tracker login bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("maps Suwayomi trackers to portable keys by name, then by fixed id", () => {
    expect(portableTrackerKey({ id: 2, name: "AniList" })).toBe("anilist");
    expect(portableTrackerKey({ id: 99, name: "MyAnimeList" })).toBe("myanimelist");
    expect(portableTrackerKey({ id: 7 })).toBe("mangaupdates");
    expect(portableTrackerKey({ id: 6, name: "Komga" })).toBeNull();
    expect(portableTrackerKey({ id: 42 })).toBeNull();
  });

  test("extracts only a well-formed access token from a normalized callback", () => {
    expect(accessTokenFromCallback("access_token=abc.DEF-123_~")).toBe("abc.DEF-123_~");
    expect(accessTokenFromCallback("https://suwayomi.org/tracker-oauth#access_token=tok&token_type=Bearer")).toBe("tok");
    expect(accessTokenFromCallback("code=abc")).toBeNull();
    expect(accessTokenFromCallback("access_token=bad%20token")).toBeNull();
    expect(accessTokenFromCallback("access_token=%E0%A4%A")).toBeNull();
  });

  test("publishes AniList logins and portable logouts, and nothing outside Tauri", () => {
    publishTrackerLogin({ id: 2, name: "AniList" }, "access_token=tok");
    publishTrackerLogout({ id: 2, name: "AniList" });
    expect(invokeMock).not.toHaveBeenCalled();

    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    publishTrackerLogin({ id: 2, name: "AniList" }, "access_token=tok");
    expect(invokeMock).toHaveBeenLastCalledWith("syncd_publish_tracker_login", {
      trackerKey: "anilist",
      accessToken: "tok",
    });
    publishTrackerLogin({ id: 1, name: "MyAnimeList" }, "code=abc");
    publishTrackerLogin({ id: 2, name: "AniList" }, "code=abc");
    expect(invokeMock).toHaveBeenCalledTimes(1);

    publishTrackerLogout({ id: 1, name: "MyAnimeList" });
    expect(invokeMock).toHaveBeenLastCalledWith("syncd_publish_tracker_logout", { trackerKey: "myanimelist" });
    publishTrackerLogout({ id: 6, name: "Komga" });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  test("swallows a Core that is away", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invokeMock.mockRejectedValue(new Error("no core"));
    expect(() => publishTrackerLogout({ id: 2, name: "AniList" })).not.toThrow();
    await Promise.resolve();
  });
});
