import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");

describe("release bundle architecture", () => {
  test("keeps optional application surfaces behind dynamic imports", () => {
    const app = read("src/App.svelte");

    for (const modulePath of [
      "./components/layout/Layout.svelte",
      "./components/layout/Toaster.svelte",
      "./components/reader/Reader.svelte",
      "./lib/discord",
      "./lib/syncdDesktop",
    ]) {
      expect(app).not.toMatch(new RegExp(`import\\s+(?!type\\b)[^;]+from\\s+[\"']${modulePath.replaceAll(".", "\\.")}[\"']`));
      expect(app).toContain(`import("${modulePath}")`);
    }

    expect(app).not.toContain('import("./lib/imageCache")');
    expect(app).toContain("trimImageCacheIfLoaded(false)");
    expect(app).toContain("scheduleLazyComponentRetry(key)");
    expect(app).toContain("lazyRetryEpoch += 1");
    expect(app).toContain("if (retryCount > 4) return");
    expect(app).toContain("prepareLibrary: async () =>");
    expect(app).toContain(":not(.toast-life)");
    expect(app).toContain(".aethon-app-shell .toast.toast.toast.toast *)");
  });

  test("retries navigation chunks without unhandled preload failures", () => {
    const layout = read("src/components/layout/Layout.svelte");
    const navigationGate = read("scripts/check-navigation-performance.mjs");
    const nativeRunner = read("scripts/run-native-viewport-smoke.ps1");

    expect(layout).toContain("Library preload did not complete; navigation will retry it.");
    expect(layout).toContain("Home preload did not complete; navigation will retry it.");
    expect(layout).toContain("activityOverlayError");
    expect(navigationGate).toContain('activePanel?.querySelector(".grid-skeleton")');
    expect(navigationGate).toContain("firstStableFrameAt = performance.now()");
    expect(navigationGate).toContain("requestAnimationFrame(finish)");
    expect(navigationGate).toContain("sha256: await sha256File(appPath)");
    expect(nativeRunner).toContain("Automation build is older than");
    expect(nativeRunner).toContain("if ($completed)");
    expect(nativeRunner).toContain("WaitForExit(5000)");
    expect(nativeRunner).toContain('AddDays(-3)');
  });

  test("keeps book parsers out of synchronous store persistence", () => {
    const state = read("src/store/state.svelte.ts");
    const libraryState = read("src/lib/books/libraryState.ts");

    expect(state).not.toContain('from "../lib/books/assets"');
    expect(state).toContain('import("../lib/books/assets")');
    expect(libraryState).not.toContain('from "./assets"');
    expect(libraryState).toContain('from "./persisted"');
  });

  test("loads the managed source runtime only when lifecycle state changes", () => {
    const lifecycle = read("src/lib/serverLifecycle.ts");

    expect(lifecycle).not.toMatch(/import\s+\{\s*resetManagedSourceRuntime\s*\}\s+from/);
    expect(lifecycle).toContain('import("./manga/runtime/managed")');
    expect(lifecycle).toContain("await resetManagedSourceRuntimeCache()");
  });

  test("keeps heavy book vendors forbidden from initial imports", () => {
    const budgets = JSON.parse(read("config/release-bundle-budgets.json"));
    const vite = read("vite.config.ts");

    expect(budgets.baseline.minimumReductionPercent).toBe(15);
    expect(budgets.forbiddenInitialImports).toEqual([
      "vendor-books",
      "vendor-parsers",
      "vendor-pdf",
    ]);
    expect(vite).toContain('return "runtime-preload"');
    expect(vite).toContain('return "domain-theme-core"');
    expect(vite).toContain('return "domain-books-storage"');
    expect(vite).toContain('return "domain-books-import"');
    expect(vite).toContain('return "domain-books-core"');
  });
});
