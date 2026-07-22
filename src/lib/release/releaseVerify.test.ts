import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");

describe("release verification orchestration", () => {
  test("runs blocking gates serially with bounded workers", () => {
    const packageJson = JSON.parse(read("package.json"));
    const script = read("scripts/verify-release.ps1");

    expect(packageJson.scripts["release:verify"]).toContain("verify-release.ps1");
    expect(script).toContain('$env:CARGO_BUILD_JOBS = "1"');
    expect(script).toContain('$env:CI = "true"');
    expect(script).toContain("--maxWorkers=1 --minWorkers=1");
    expect(script).toContain("--test-threads=1");
    expect(script).toContain("cargo test --locked");
    expect(script).toContain('AETHON_SKIP_SUWAYOMI_CERTIFICATION = "1"');
    expect(script).not.toContain("Start-Job");
    expect(script).not.toContain("ForEach-Object -Parallel");
  });

  test("builds once before every native certification and leaves no repo artifacts", () => {
    const script = read("scripts/verify-release.ps1");
    const tauriBuild = script.indexOf('Invoke-ReleaseStep "Tauri automation build"');
    const dataGate = script.indexOf('Invoke-ReleaseStep "Local data round trips"');
    const viewportGate = script.indexOf('Invoke-ReleaseStep "Native viewport smoke"');
    const navigationGate = script.indexOf('Invoke-ReleaseStep "Native navigation budgets"');

    expect(tauriBuild).toBeGreaterThan(0);
    expect(dataGate).toBeGreaterThan(tauriBuild);
    expect(viewportGate).toBeGreaterThan(dataGate);
    expect(navigationGate).toBeGreaterThan(viewportGate);
    expect(script).toContain("AETHON_NATIVE_SMOKE_OUTPUT_DIR");
    expect(script).toContain("AETHON_NAVIGATION_OUTPUT_DIR");
    expect(script).toContain("AETHON_BROWSER_SCREENSHOT_DIR");
    expect(script).toContain("Get-WorktreeFingerprint");
    expect(script).toContain("git diff --cached --check");
    expect(script).toContain("Release verification changed the worktree");
  });

  test("requires reviewed visual baselines and keeps diagnostics outside the repository", () => {
    const setup = read("src/test/browser/setup.ts");
    const workspace = read("vitest.workspace.ts");

    expect(setup).toContain("__AETHON_BROWSER_UPDATE_SCREENSHOTS__");
    expect(setup).toContain("Missing reviewed screenshot baseline");
    expect(setup).toContain("SCREENSHOT_ACTUAL_DIR");
    expect(workspace).toContain("AETHON_BROWSER_SCREENSHOT_DIR");
    expect(workspace).toContain("AETHON_UPDATE_SCREENSHOTS");
  });
});
