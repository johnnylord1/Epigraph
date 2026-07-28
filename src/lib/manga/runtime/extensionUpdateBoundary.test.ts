import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("transactional extension update boundary", () => {
  test("active Sources UI cannot activate updates through the direct runtime mutation", () => {
    const source = readFileSync(resolve("src/components/pages/SourcesView.svelte"), "utf8");
    expect(source).toContain("runTransactionalExtensionUpdates");
    expect(source).not.toMatch(/runtime\.updateExtension\s*\(/);
  });

  test("native coordinator uses the official exact-artifact Suwayomi mutation", () => {
    const source = readFileSync(resolve("src-tauri/src/suwayomi_update.rs"), "utf8");
    expect(source).toContain("installExternalExtension");
    expect(source).toContain("certify_suwayomi_extension_update_batch");
    expect(source).not.toMatch(/(?:classloader|apk\s*[-=]>\s*jar)/i);
  });
});
