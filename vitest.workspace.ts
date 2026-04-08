import { defineWorkspace } from "vitest/config";

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
        "src/components/layout/SplashScreen.test.ts",
        "src/components/reader/ReaderHud.test.ts",
      ],
    },
  },
  {
    extends: "./vite.config.ts",
    test: {
      name: "browser-components",
      include: [
        "src/components/library/LibraryCardGrid.test.ts",
        "src/components/library/ComicsLibraryBody.test.ts",
        "src/components/library/BooksLibraryBody.test.ts",
      ],
      browser: {
        enabled: true,
        name: "chromium",
        provider: "playwright",
        headless: true,
      },
    },
  },
]);
