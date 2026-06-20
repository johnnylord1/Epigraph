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
    include: ["@tauri-apps/api/webviewWindow"],
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
