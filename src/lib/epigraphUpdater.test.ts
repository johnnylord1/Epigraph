import { describe, expect, it } from "vitest";

import {
  compareEpigraphVersions,
  desktopReleaseNotes,
  isAuthorizedEpigraphUpdate,
  normalizeEpigraphVersion,
  sortEpigraphReleaseHistory,
  type EpigraphReleaseInfo,
} from "./epigraphUpdater";

const release = (tag_name: string): EpigraphReleaseInfo => ({
  tag_name,
  name: tag_name,
  body: "",
  published_at: "2026-07-21T00:00:00Z",
  html_url: `https://example.invalid/${tag_name}`,
});

describe("Epigraph updater release policy", () => {
  it("accepts only stable three-part semantic versions", () => {
    expect(normalizeEpigraphVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeEpigraphVersion("1.2.3")).toBe("1.2.3");
    expect(normalizeEpigraphVersion("1.2.3-beta.1")).toBeNull();
    expect(normalizeEpigraphVersion("latest")).toBeNull();
  });

  it("sorts stable release history newest first", () => {
    expect(sortEpigraphReleaseHistory([
      release("v1.2.0"),
      release("v2.0.0-beta.1"),
      release("v1.10.0"),
    ]).map((entry) => entry.tag_name)).toEqual(["v1.10.0", "v1.2.0"]);
    expect(compareEpigraphVersions("1.10.0", "1.2.0")).toBeGreaterThan(0);
  });

  it("authorizes native installation only for the signed endpoint version", () => {
    const status = {
      update_available: true,
      current_version: "1.0.0",
      version: "1.2.0",
      body: null,
      published_at: null,
    };

    expect(isAuthorizedEpigraphUpdate(release("v1.2.0"), status)).toBe(true);
    expect(isAuthorizedEpigraphUpdate(release("v1.1.0"), status)).toBe(false);
    expect(isAuthorizedEpigraphUpdate(release("v1.3.0"), { ...status, update_available: false })).toBe(false);
  });
});

describe("desktopReleaseNotes", () => {
  it("shows only the Windows part of notes that cover both apps", () => {
    const body = [
      "## Windows",
      "",
      "`Epigraph_0.0.5_x64-setup.exe` updates an existing install.",
      "",
      "### Fixed",
      "",
      "- Desktop fix.",
      "",
      "## Android 0.1.0-alpha.3",
      "",
      "### Fixed",
      "",
      "- Phone fix.",
    ].join("\r\n");

    expect(desktopReleaseNotes(body)).toBe(
      "`Epigraph_0.0.5_x64-setup.exe` updates an existing install.\n\n### Fixed\n\n- Desktop fix.",
    );
  });

  it("keeps a section that comes after the Android one", () => {
    expect(desktopReleaseNotes("## Android\n- Phone fix.\n## Windows\n- Desktop fix.")).toBe("- Desktop fix.");
  });

  it("shows notes without platform headings whole", () => {
    const body = "## Downloads\n\n- Installer.\n\n### Fixed\n\n- Desktop fix.";
    expect(desktopReleaseNotes(body)).toBe(body);
  });
});
