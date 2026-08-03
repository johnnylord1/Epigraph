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
    expect(script).toContain("verify-source-runtime.ps1 -SkipProjectGates");
    expect(script).not.toContain("verify-source-runtime.ps1 -ContractOnly");
    expect(script).toContain("Remove-Item Env:AETHON_SUWAYOMI_LIVE_ENDPOINT");
    expect(script).toContain("Remove-Item Env:AETHON_RELEASE_SMOKE_LIVE");
    expect(script).not.toContain("Start-Job");
    expect(script).not.toContain("ForEach-Object -Parallel");
  });

  test("runs the deterministic source workflow without duplicating project-wide gates", () => {
    const releaseScript = read("scripts/verify-release.ps1");
    const sourceScript = read("scripts/verify-source-runtime.ps1");
    const sourceGate = releaseScript.indexOf('Invoke-ReleaseStep "Source runtime compatibility"');
    const integrationsGate = releaseScript.indexOf('Invoke-ReleaseStep "External integration contracts"');

    expect(sourceGate).toBeGreaterThan(0);
    expect(integrationsGate).toBeGreaterThan(sourceGate);
    expect(sourceScript).toContain('Invoke-SourceRuntimeStep "Deterministic extension and Local Source workflow"');
    expect(sourceScript).toContain("certify-suwayomi-extension-workflows.mjs");
    expect(sourceScript).toContain("if (-not $SkipProjectGates)");
    expect(sourceScript).toContain("ContractOnly and SkipProjectGates cannot be combined");
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
    expect(read("scripts/run-native-viewport-smoke.ps1")).toContain("[switch]$ShowWindow");
    expect(read("scripts/run-native-viewport-smoke.ps1")).toContain('$env:AETHON_WEBDRIVER_WINDOW_X = "1980"');
    expect(read("scripts/run-native-viewport-smoke.ps1")).toContain("CreateNoWindow = $true");
    expect(read("scripts/run-native-viewport-smoke.ps1")).toContain("UseShellExecute = $false");
    expect(script).toContain('$env:AETHON_WEBDRIVER_WINDOW_X = "1980"');
    expect(script).toContain('$env:AETHON_WEBDRIVER_WINDOW_Y = "80"');
    expect(script).toContain("Remove-Item Env:AETHON_WEBDRIVER_SHOW_WINDOW");
    expect(script).not.toContain("Get-FreeLoopbackPort");
    expect(script).toContain('Invoke-ReleaseStep "Browser component tests"');
    expect(script).not.toContain("MaxAttempts");
    expect(script).not.toContain("retrying once");
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
    expect(workspace).toContain('host: "127.0.0.1"');
    expect(workspace).toContain("AETHON_VITEST_BROWSER_PORT");
    expect(workspace).toContain('AETHON_VITEST_BROWSER_PORT || "0"');
    expect(workspace).toContain("strictPort: browserApiPort !== 0");
  });

  test("keeps WebView2 stable-frame timing diagnostic while app-owned budgets remain blocking", () => {
    const navigationScript = read("scripts/check-navigation-performance.mjs");
    const interactiveReadyGate = navigationScript.slice(
      navigationScript.indexOf("interactiveReadyP50Ms"),
      navigationScript.indexOf("const appOwnedP95Ms"),
    );

    expect(interactiveReadyGate).toContain("blocking: false");
    expect(navigationScript).toContain("warmCachedAppOwnedP95MaxMs");
  });

  test("keeps native automation hidden until it is explicitly shown after positioning", () => {
    const automationConfig = JSON.parse(read("src-tauri/tauri.automation.conf.json"));
    const rust = read("src-tauri/src/lib.rs");
    const mainWindow = automationConfig.app.windows.find((window: { label?: string }) => window.label === "main");

    expect(mainWindow?.visible).toBe(false);
    expect(mainWindow?.center).toBe(false);
    expect(rust).toContain("configure_webdriver_window(app.handle());");
    expect(rust).toContain("AETHON_WEBDRIVER_WINDOW_X");
    expect(rust).toContain("AETHON_WEBDRIVER_SHOW_WINDOW");
    expect(rust.indexOf("set_position")).toBeLessThan(rust.indexOf("window.show()"));
  });
});
