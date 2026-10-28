import path from "node:path";
import { tmpdir } from "node:os";
import { defineWorkspace } from "vitest/config";

const BROWSER_SCREENSHOT_BASE_DIR = path.resolve(
  "src/test/browser/__screenshots__/custom"
);
const BROWSER_TRANSIENT_SCREENSHOT_DIR = path.resolve(
  process.env.EPIGRAPH_BROWSER_SCREENSHOT_DIR
    || path.join(tmpdir(), "epigraph-vitest-browser", String(process.pid))
);
const BROWSER_UPDATE_SCREENSHOTS = process.env.EPIGRAPH_UPDATE_SCREENSHOTS === "1";
const browserApiPort = Number.parseInt(process.env.EPIGRAPH_VITEST_BROWSER_PORT || "0", 10);

if (!Number.isInteger(browserApiPort) || browserApiPort < 0 || browserApiPort > 65535) {
  throw new Error("EPIGRAPH_VITEST_BROWSER_PORT must be zero or a valid TCP port");
}

export default defineWorkspace([
  {
    extends: "./vite.config.ts",
    test: {
      name: "unit",
      environment: "node",
      setupFiles: ["src/test/messageCatalogs.ts"],
      include: [
        "src/lib/**/*.test.ts",
        "src/store/**/*.test.ts",
      ],
      exclude: [
        "src/lib/reader/tts.test.ts",
        "src/**/*.browser.test.ts",
      ],
    },
  },
  {
    extends: "./vite.config.ts",
    resolve: {
      conditions: ["browser"],
    },
    test: {
      name: "shell-jsdom",
      environment: "jsdom",
      setupFiles: ["src/test/messageCatalogs.ts"],
      include: [
        "src/components/library/LibraryShell.test.ts",
        "src/components/library/LibraryHeader.test.ts",
        "src/components/library/LibraryCollectionsBar.test.ts",
        "src/components/library/LibraryToolbar.test.ts",
        "src/components/library/LibraryCardGrid.test.ts",
        "src/components/library/LibraryThemeTokens.test.ts",
        "src/components/library/ComicsLibraryBody.test.ts",
        "src/components/layout/layoutThemeComponents.test.ts",
        "src/components/layout/ActivityCenterThemeTokens.test.ts",
        "src/components/layout/ActiveShellCompatibilityThemeTokens.test.ts",
        "src/AppThemeCompatibilityTokens.test.ts",
        "src/AppSyncdReplicationCatchUp.test.ts",
        "src/FirstRunGate.test.ts",
        "src/components/layout/SplashScreen.test.ts",
        "src/components/shared/baseThemeComponents.test.ts",
        "src/components/shared/NocturneStateThemeTokens.test.ts",
        "src/components/shared/NocturneState.test.ts",
        "src/components/shared/MangaPreviewThemeTokens.test.ts",
        "src/components/pages/Downloads.test.ts",
        "src/components/pages/DownloadsThemeTokens.test.ts",
        "src/components/search/SearchPalette.test.ts",
        "src/components/search/SearchPalette.behavior.test.ts",
        "src/components/pages/BrowseV3.test.ts",
        "src/components/pages/BrowseV3ThemeTokens.test.ts",
        "src/components/pages/HomeThemeTokens.test.ts",
        "src/components/pages/TasteInsightsThemeTokens.test.ts",
        "src/components/pages/MassMigrationThemeTokens.test.ts",
        "src/components/pages/MigrateModal.test.ts",
        "src/components/pages/MassMigrateModal.test.ts",
        "src/components/pages/NovelMigrateModal.test.ts",
        "src/components/pages/MigrationModalsAccessibility.test.ts",
        "src/components/pages/MigrationModalsThemeTokens.test.ts",
        "src/components/pages/SourcesThemeTokens.test.ts",
        "src/components/pages/SourcePreferences.test.ts",
        "src/components/shared/SeriesDetailV3Shell.test.ts",
        "src/components/shared/DetailSurfacesThemeTokens.test.ts",
        "src/components/shared/DetailDownloadMenu.test.ts",
        "src/components/pages/SeriesDetail.test.ts",
        "src/components/library/LibraryRefreshModal.test.ts",
        "src/components/settings/SyncdConnectionThemeTokens.test.ts",
        "src/components/settings/SyncdConnectionPanel.test.ts",
        "src/components/settings/ThemeEditorThemeTokens.test.ts",
        "src/components/settings/SettingsBrandCardThemeTokens.test.ts",
        "src/components/settings/SyncdSessionDetails.test.ts",
        "src/components/settings/SuwayomiUpdatePanel.test.ts",
        "src/components/settings/SuwayomiUpdateThemeTokens.test.ts",
        "src/components/settings/Settings.test.ts",
          "src/components/settings/RestoreNovelDependencies.test.ts",
          "src/components/settings/RestoreMangaDependencies.test.ts",
        "src/components/firstRun/FirstRun.test.ts",
        "src/components/firstRun/FirstRunBackupStep.test.ts",
        "src/components/firstRun/FirstRunSourcesStep.test.ts",
        "src/components/firstRun/FirstRunTrackersStep.test.ts",
        "src/components/firstRun/FirstRunDiscoverStep.test.ts",
        "src/components/firstRun/FirstRunSyncStep.test.ts",
        "src/components/reader/ReaderHud.test.ts",
        "src/components/reader/BookReader.test.ts",
        "src/components/reader/DetachedReaderApp.test.ts",
        "src/components/reader/ReaderCoreThemeTokens.test.ts",
        "src/components/reader/TtsControls.test.ts",
        "src/lib/reader/tts.test.ts",
      ],
    },
  },
  {
    extends: "./vite.config.ts",
    server: {
      fs: {
        allow: [BROWSER_TRANSIENT_SCREENSHOT_DIR],
      },
    },
    optimizeDeps: { include: ["@tauri-apps/api/path"] },
    define: {
      __EPIGRAPH_BROWSER_SCREENSHOT_DIR__: JSON.stringify(BROWSER_SCREENSHOT_BASE_DIR),
      __EPIGRAPH_BROWSER_ACTUAL_SCREENSHOT_DIR__: JSON.stringify(BROWSER_TRANSIENT_SCREENSHOT_DIR),
      __EPIGRAPH_BROWSER_UPDATE_SCREENSHOTS__: JSON.stringify(BROWSER_UPDATE_SCREENSHOTS),
    },
    test: {
      name: "browser-components",
      // Browser component files share the same app store and document. Running
      // them concurrently lets another file's cleanup reset an active reader or
      // Settings pane halfway through an assertion.
      fileParallelism: false,
      setupFiles: [
        "src/test/browser/setup.ts",
        "src/test/messageCatalogs.ts",
      ],
      include: [
        "src/components/layout/SplashScreen.browser.test.ts",
        "src/components/firstRun/FirstRun.browser.test.ts",
        "src/components/reader/Reader.browser.test.ts",
        "src/components/reader/NovelReader.browser.test.ts",
        "src/components/settings/Settings.browser.test.ts",
        "src/components/settings/SyncdLocalization.browser.test.ts",
        "src/components/library/LibraryCardGrid.test.ts",
        "src/components/library/ComicsLibraryBody.test.ts",
        "src/components/library/BooksLibraryBody.test.ts",
        "src/lib/theme/themeProbe.browser.test.ts",
        "src/lib/theme/hudRuntimeOwnership.browser.test.ts",
        "src/lib/theme/builtinThemeMatrix.browser.test.ts",
        "src/lib/theme/nocturnePortCompatibility.browser.test.ts",
        "src/components/shared/DetailDownloadMenu.browser.test.ts",
      ],
      browser: {
        enabled: true,
        name: "chromium",
        provider: "playwright",
        headless: true,
        api: {
          host: "127.0.0.1",
          port: browserApiPort,
          strictPort: browserApiPort !== 0,
        },
        viewport: {
          width: 1280,
          height: 800,
        },
        screenshotDirectory: BROWSER_TRANSIENT_SCREENSHOT_DIR,
        providerOptions: {
          context: {
            colorScheme: "dark",
            deviceScaleFactor: 1,
            reducedMotion: "reduce",
          },
        },
      },
    },
  },
]);
