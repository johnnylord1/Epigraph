import { describe, expect, it } from "vitest";

import {
  normalizeTrackerOAuthInput,
  trackerOAuthParamName,
  trackerOAuthResponseType,
} from "./trackerOAuth";
import {
  BIND_TRACK,
  FETCH_TRACK,
  LOGIN_TRACKER_CREDENTIALS,
  LOGIN_TRACKER_OAUTH,
  LOGOUT_TRACKER,
  UNBIND_TRACK,
  UPDATE_TRACK,
} from "./queries";
import type { Tracker } from "./types";

const tracker = (authUrl: string | null): Tracker => ({ id: 1, name: "Test", authUrl } as Tracker);

describe("tracker integration contracts", () => {
  it("normalizes code and implicit-token callbacks without retaining the full URL", () => {
    const codeTracker = tracker("https://tracker.invalid/oauth?response_type=code");
    const tokenTracker = tracker("https://tracker.invalid/oauth?response_type=token");

    expect(normalizeTrackerOAuthInput(codeTracker, "https://suwayomi.org/callback?code=abc123&state=private"))
      .toBe("code=abc123");
    expect(normalizeTrackerOAuthInput(tokenTracker, "https://suwayomi.org/callback#access_token=token123&state=private"))
      .toBe("access_token=token123");
    expect(trackerOAuthResponseType(tokenTracker)).toBe("token");
    expect(trackerOAuthParamName(codeTracker)).toBe("code");
  });

  it("preserves raw values but rejects unrelated callback URLs", () => {
    const codeTracker = tracker("https://tracker.invalid/oauth");
    expect(normalizeTrackerOAuthInput(codeTracker, "Bearer direct-code")).toBe("code=direct-code");
    expect(normalizeTrackerOAuthInput(codeTracker, "https://example.invalid/callback?error=denied"))
      .toBe("");
  });

  it("keeps login, retry/update and unlink operations on the existing GraphQL contract", () => {
    expect(LOGIN_TRACKER_OAUTH).toContain("loginTrackerOAuth");
    expect(LOGIN_TRACKER_OAUTH).toContain("$callbackUrl: String!");
    expect(LOGIN_TRACKER_CREDENTIALS).toContain("loginTrackerCredentials");
    expect(LOGIN_TRACKER_CREDENTIALS).toContain("$password: String!");
    expect(LOGOUT_TRACKER).toContain("logoutTracker");
    expect(BIND_TRACK).toContain("bindTrack");
    expect(FETCH_TRACK).toContain("fetchTrack");
    expect(UPDATE_TRACK).toContain("updateTrack");
    expect(UNBIND_TRACK).toContain("unbindTrack");
  });
});
