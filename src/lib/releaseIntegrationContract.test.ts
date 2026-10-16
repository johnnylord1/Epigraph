import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");

describe("external integration release contracts", () => {
  it("uses the signed updater endpoint as the only update authority", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json"));
    const app = read("src/App.svelte");
    const settings = read("src/components/settings/Settings.svelte");
    const rust = read("src-tauri/src/lib.rs");

    expect(config.plugins.updater.pubkey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(config.plugins.updater.endpoints).toEqual([
      "https://github.com/johnnylord1/Epigraph/releases/latest/download/latest.json",
    ]);
    expect(app).toContain('invoke<EpigraphUpdateStatus>("check_epigraph_update")');
    expect(app).not.toContain('invoke<Array<{ tag_name: string; html_url: string }>>("list_releases")');
    expect(settings).toContain("isAuthorizedEpigraphUpdate(release, updateCheck)");
    expect(settings).toContain("expectedVersion: updateCheck?.version ?? release.tag_name");
    expect(rust).toContain("Signed update check timed out after 10 seconds.");
    expect(rust).toContain("The signed updater endpoint no longer offers the selected version.");
  });

  it("keeps Suwayomi certification on allowlist, checksum and rollback contracts", () => {
    const updater = read("src-tauri/src/suwayomi_update.rs");
    expect(updater).toContain("certified_release_checksum");
    expect(updater).toContain("roll_back_runtime_attempt");
    expect(updater).toContain("The previous Suwayomi runtime was restored.");
    expect(updater).toContain("Target Suwayomi version is not in Epigraph's allowlist.");
  });

  it("does not add real integration credentials to fixtures", () => {
    const fixtures = [
      read("src/lib/trackerOAuth.test.ts"),
      read("src/lib/novels/hardcoverTransport.test.ts"),
      read("src/lib/flaresolverr.test.ts"),
      read("src/lib/discord/discordPresence.test.ts"),
    ].join("\n");
    expect(fixtures).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    expect(fixtures).not.toMatch(/(?:sk|pk)_(?:live|prod)_[A-Za-z0-9]{16,}/);
  });
});
