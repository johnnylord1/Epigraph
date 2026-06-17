import { describe, expect, it } from "vitest";

import { classifySourceAccessError } from "./sourceAccess";

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
  });
});
