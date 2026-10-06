import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  accessTokenFromCallback,
  completeEpigraphMyAnimeListLogin,
  epigraphMyAnimeListAuthUrl,
  isEpigraphMyAnimeListCallback,
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

describe("Epigraph MyAnimeList login", () => {
  const authUrl = "https://myanimelist.net/v1/oauth2/authorize?client_id=epigraph";

  beforeEach(() => {
    invokeMock.mockReset();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("starts through Core only for MyAnimeList, falling back without Core", async () => {
    invokeMock.mockResolvedValue(authUrl);
    expect(await epigraphMyAnimeListAuthUrl({ id: 1, name: "MyAnimeList" })).toBe(authUrl);
    expect(await epigraphMyAnimeListAuthUrl({ id: 2, name: "AniList" })).toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith("syncd_start_myanimelist_login");

    invokeMock.mockResolvedValue(null);
    expect(await epigraphMyAnimeListAuthUrl({ id: 1, name: "MyAnimeList" })).toBeNull();
    invokeMock.mockRejectedValue(new Error("no core"));
    expect(await epigraphMyAnimeListAuthUrl({ id: 1, name: "MyAnimeList" })).toBeNull();
  });

  test("recognizes only the Epigraph redirect with a code", () => {
    expect(isEpigraphMyAnimeListCallback(" epigraph://myanimelist-auth?code=abc&state=s ")).toBe(true);
    expect(isEpigraphMyAnimeListCallback("epigraph://myanimelist-auth?state=s&code=abc")).toBe(true);
    expect(isEpigraphMyAnimeListCallback("epigraph://myanimelist-auth?error=access_denied")).toBe(false);
    expect(isEpigraphMyAnimeListCallback("https://suwayomi.org/tracker-oauth?code=abc")).toBe(false);
    expect(isEpigraphMyAnimeListCallback("abc")).toBe(false);
  });

  test("waits for Suwayomi to report the login after Core stored it", async () => {
    invokeMock.mockResolvedValue(true);
    const answers = [() => Promise.reject(new Error("restarting")), async () => false, async () => true];
    const waits: number[] = [];
    const confirmed = await completeEpigraphMyAnimeListLogin(
      "epigraph://myanimelist-auth?code=abc&state=s",
      () => answers.shift()!(),
      async (ms) => { waits.push(ms); },
    );
    expect(confirmed).toBe(true);
    expect(waits).toHaveLength(2);
    expect(invokeMock).toHaveBeenLastCalledWith("syncd_complete_myanimelist_login", {
      callbackUrl: "epigraph://myanimelist-auth?code=abc&state=s",
    });
  });

  test("fails without Core and gives up when Suwayomi never confirms", async () => {
    invokeMock.mockResolvedValue(false);
    await expect(completeEpigraphMyAnimeListLogin("epigraph://myanimelist-auth?code=a", async () => true)).rejects.toThrow();
    invokeMock.mockResolvedValue(true);
    expect(await completeEpigraphMyAnimeListLogin("epigraph://myanimelist-auth?code=a", async () => false, async () => {})).toBe(false);
  });
});
