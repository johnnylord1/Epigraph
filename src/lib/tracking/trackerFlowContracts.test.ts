import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readProjectFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(relativePath), "utf8");
}

describe("tracker UI flow contracts", () => {
  it("keeps tracker loading bounded and exposes an explicit retry", () => {
    const settings = readProjectFile("src/components/settings/Settings.svelte");

    expect(settings).toContain("trackersLoadAttempted");
    expect(settings).toContain("!trackersLoadAttempted && !trackersLoading");
    expect(settings).toContain('label: $_("library_error_retry")');
    expect(settings).toContain('"tracker-oauth-window-state"');
    expect(settings).toContain("oauthWindowStateUnlisten");
  });

  it("invalidates stale Hardcover searches", () => {
    const panel = readProjectFile("src/components/shared/NovelTrackingPanel.svelte");

    expect(panel).toContain("let searchRequestId = 0");
    expect(panel).toContain("const requestId = ++searchRequestId");
    expect(panel).toContain("if (requestId !== searchRequestId) return");
  });

  it("binds Suwayomi search results only to the tracker that produced them", () => {
    const panel = readProjectFile("src/components/shared/TrackingPanel.svelte");

    expect(panel).toContain("const requestId = ++searchRequestId");
    expect(panel).toContain("activeTab !== trackerId");
    expect(panel).toContain("activeTab !== result.trackerId");
    expect(panel).toContain("const trackerId = result.trackerId");
  });

  it("refreshes NovelReader cover resolution after Hardcover state changes", () => {
    const reader = readProjectFile("src/components/reader/NovelReader.svelte");

    expect(reader).toContain('"aethon-hardcover-state-changed"');
    expect(reader).toContain("hardcoverStateVersion += 1");
    expect(reader).toContain("hardcoverStateVersion,");
  });
});
