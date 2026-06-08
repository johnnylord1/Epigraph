import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";

export default defineConfig({
  plugins: [svelte()],
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
