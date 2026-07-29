import { describe, expect, it } from "vitest";

import { classifySourceAccessError, isConfirmedAntibotChallengeMessage } from "./sourceAccess";

describe("source access classification", () => {
  it("classifies Cloudflare and anti-bot failures as source challenge", () => {
    expect(classifySourceAccessError(new Error("Cloudflare bypass currently disabled"))).toMatchObject({
      errorType: "source-challenge",
      sourceWide: true,
      recoveryHint: "flaresolverr",
    });
    expect(classifySourceAccessError("anti-bot challenge page returned")).toMatchObject({
      errorType: "source-challenge",
      sourceWide: true,
    });
    expect(classifySourceAccessError("Just a moment... Checking your browser before accessing the source")).toMatchObject({
      errorType: "source-challenge",
      sourceWide: true,
      recoveryHint: "flaresolverr",
    });
    expect(classifySourceAccessError("DDoS-Guard: attention required, access denied")).toMatchObject({
      errorType: "source-challenge",
      sourceWide: true,
      recoveryHint: "flaresolverr",
    });
  });

  it("keeps missing source and timeout distinct", () => {
    expect(classifySourceAccessError("Source not installed")).toMatchObject({
      errorType: "missing-source",
      sourceWide: true,
    });
    expect(classifySourceAccessError("Request timed out")).toMatchObject({
      errorType: "timeout",
      sourceWide: false,
    });
    expect(classifySourceAccessError("HTTP 403 Forbidden")).toMatchObject({
      errorType: "source-error",
      sourceWide: false,
    });
  });

  it.each([
    "java.lang.AbstractMethodError: parse response",
    "JsonDecodingException: missing field",
    "Source is obsolete and operation is not implemented",
    "Parser found no element in HTML document",
    "HTTP 404 source removed",
    "HTTP 401 login required",
    "ECONNREFUSED source.example",
  ])("does not suggest FlareSolverr for non-antibot failures: %s", (message) => {
    expect(isConfirmedAntibotChallengeMessage(message)).toBe(false);
  });

  it("keeps shared LNReader challenge detection while exposing a stricter manga gate", () => {
    expect(classifySourceAccessError("Access denied by source protection")).toMatchObject({
      errorType: "source-challenge",
      recoveryHint: "flaresolverr",
    });
    expect(isConfirmedAntibotChallengeMessage("Access denied by source protection")).toBe(false);
    expect(isConfirmedAntibotChallengeMessage("Failed to parse HTML: Just a moment - Cloudflare challenge")).toBe(true);
    expect(isConfirmedAntibotChallengeMessage("FlareSolverr request failed with HTTP 500")).toBe(false);
  });
});
