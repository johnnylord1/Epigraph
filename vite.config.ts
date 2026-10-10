import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import path from "path";

function isKnownReleaseWarning(warning: { code?: string; id?: string; message?: string }) {
  const id = warning.id ?? "";
  const message = warning.message ?? "";
  if (warning.code === "EVAL" && id.includes("@protobufjs") && id.includes("inquire")) return true;
  if (
    message.includes("is dynamically imported by") &&
    message.includes("but also statically imported by") &&
    (
      message.includes("src/lib/books/libraryState.ts") ||
      message.includes("src/lib/client.ts") ||
      message.includes("src/lib/queries.ts") ||
      message.includes("src/lib/backup/novelsBackup.ts") ||
      message.includes("src/lib/novels/domain.ts") ||
      message.includes("src/lib/novels/libraryState.ts") ||
      message.includes("src/lib/novels/libraryRefresh.ts")
    )
  ) {
    return true;
  }
  return false;
}

export default defineConfig({
  plugins: [
    svelte(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
    }),
  ],
  clearScreen: false,
  resolve: {
    alias: {
      $store:      path.resolve("./src/store"),
      $components: path.resolve("./src/components"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  optimizeDeps: {
    // The novel runtime host window is the only page that loads the first five, and the book readers
    // load the rest lazily. Discovered late, they trigger a re-optimization that answers the pending
    // imports with 504s ("Failed to fetch dynamically imported module").
    include: [
      "@tauri-apps/api/webviewWindow",
      "cheerio",
      "htmlparser2",
      "@noble/ciphers/aes.js",
      "@noble/ciphers/utils.js",
      "epubjs",
      "jszip",
      "pdfjs-dist",
    ],
  },
  build: {
    target: ["es2021", "chrome100", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        if (isKnownReleaseWarning(warning)) return;
        defaultHandler(warning);
      },
      output: {
        manualChunks(id) {
          const normalizedId = id.replaceAll("\\", "/");
          if (normalizedId.includes("vite/preload-helper")) return "runtime-preload";
          // Messages are shared by the entry and by lazy chunks; left unassigned, Rollup pulls them into
          // whichever manual chunk imports them first, and the entry then statically imports that chunk.
          if (normalizedId.includes("/src/paraglide/") || normalizedId.includes("/src/lib/i18n/")) return "domain-i18n";
          if (
            normalizedId.includes("/src/lib/theme/")
            && /\/(contract|document|provider)\.ts$/.test(normalizedId)
          ) {
            return "domain-theme-core";
          }
          if (
            normalizedId.includes("/src/lib/books/") &&
            /\/(identity|isbn|libraryState|persisted|progress|summary)\.(ts|svelte\.ts)$/.test(normalizedId)
          ) {
            return "domain-books-core";
          }
          if (
            normalizedId.includes("/src/lib/books/") &&
            /\/(import|storage)\.(ts|svelte\.ts)$/.test(normalizedId)
          ) {
            return "domain-books-storage";
          }
          if (
            normalizedId.includes("/src/lib/books/") &&
            /\/(assets|epub|importFile|pdf|pdfReflow)\.(ts|svelte\.ts)$/.test(normalizedId)
          ) {
            return "domain-books-import";
          }
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("pdfjs-dist")) return "vendor-pdf";
          if (id.includes("epubjs") || id.includes("jszip") || id.includes("pako")) return "vendor-books";
          if (id.includes("@tauri-apps")) return "vendor-tauri";
          if (id.includes("phosphor-svelte")) return "vendor-icons";
          if (id.includes("cheerio") || id.includes("htmlparser2") || id.includes("fast-xml-parser")) return "vendor-parsers";
          if (id.includes("protobufjs") || id.includes("long")) return "vendor-graphql";
          return undefined;
        },
      },
    },
  },
});
