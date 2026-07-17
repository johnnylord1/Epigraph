import path from "node:path";
import { defineWorkspace } from "vitest/config";

const BROWSER_SCREENSHOT_BASE_DIR = path.resolve(
  "src/test/browser/__screenshots__/custom"
);

export default defineWorkspace([
  {
    extends: "./vite.config.ts",
    test: {
      name: "unit",
      environment: "node",
      include: [
        "src/lib/**/*.test.ts",
        "src/store/**/*.test.ts",
      ],
      exclude: [
        "src/lib/reader/tts.test.ts",
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
        "src/components/layout/SplashScreen.test.ts",
        "src/components/shared/baseThemeComponents.test.ts",
        "src/components/shared/NocturneStateThemeTokens.test.ts",
        "src/components/shared/MangaPreviewThemeTokens.test.ts",
        "src/components/novels/NovelSourceStatusDetails.test.ts",
        "src/components/pages/Downloads.test.ts",
        "src/components/pages/DownloadsThemeTokens.test.ts",
        "src/components/pages/BrowseV3.test.ts",
        "src/components/pages/BrowseV3ThemeTokens.test.ts",
        "src/components/pages/HomeThemeTokens.test.ts",
        "src/components/pages/TasteInsightsThemeTokens.test.ts",
        "src/components/pages/MassMigrationThemeTokens.test.ts",
        "src/components/pages/MigrateModal.test.ts",
        "src/components/pages/MigrationModalsThemeTokens.test.ts",
        "src/components/pages/NovelSources.test.ts",
        "src/components/pages/SourcesThemeTokens.test.ts",
        "src/components/shared/SeriesDetailV3Shell.test.ts",
        "src/components/shared/DetailSurfacesThemeTokens.test.ts",
        "src/components/settings/SyncdConnectionThemeTokens.test.ts",
        "src/components/settings/ThemeEditorThemeTokens.test.ts",
        "src/components/settings/SyncdSessionDetails.test.ts",
        "src/components/settings/NovelRepositoriesPanel.test.ts",
        "src/components/settings/NovelRepositoriesThemeTokens.test.ts",
        "src/components/settings/SuwayomiUpdatePanel.test.ts",
        "src/components/settings/SuwayomiUpdateThemeTokens.test.ts",
        "src/components/settings/Settings.test.ts",
        "src/components/reader/ReaderHud.test.ts",
        "src/components/reader/ReaderCoreThemeTokens.test.ts",
        "src/components/reader/TtsControls.test.ts",
        "src/lib/reader/tts.test.ts",
      ],
    },
  },
  {
    extends: "./vite.config.ts",
    define: {
      __AETHON_BROWSER_SCREENSHOT_DIR__: JSON.stringify(BROWSER_SCREENSHOT_BASE_DIR),
    },
    test: {
      name: "browser-components",
      setupFiles: [
        "src/test/browser/setup.ts",
      ],
      include: [
        "src/components/layout/SplashScreen.browser.test.ts",
        "src/components/settings/Settings.browser.test.ts",
        "src/components/library/LibraryCardGrid.test.ts",
        "src/components/library/ComicsLibraryBody.test.ts",
        "src/components/library/BooksLibraryBody.test.ts",
        "src/lib/theme/themeProbe.browser.test.ts",
        "src/lib/theme/hudRuntimeOwnership.browser.test.ts",
        "src/lib/theme/builtinThemeMatrix.browser.test.ts",
        "src/lib/theme/nocturnePortCompatibility.browser.test.ts",
      ],
      browser: {
        enabled: true,
        name: "chromium",
        provider: "playwright",
        headless: true,
        viewport: {
          width: 1280,
          height: 800,
        },
        screenshotDirectory: "src/test/browser/__screenshots__",
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
