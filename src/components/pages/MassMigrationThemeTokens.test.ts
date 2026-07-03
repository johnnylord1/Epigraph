import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ACTIVE_MASS_MIGRATION_FILES = [
  "src/components/pages/MassMigrateModal.svelte",
] as const;

const TOKEN_SOURCE_FILES = [
  "src/styles/tokens.css",
  "src/styles/nocturne-theme.css",
] as const;

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("Mass Migration theme token contract", () => {
  it("keeps the active Mass Migration modal free of direct visual values and Nocturne internals", () => {
    const directVisualPattern =
      /(?<!\{)#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(|backdrop-filter:\s*blur|box-shadow:\s*[^;]*rgba|z-index:\s*\d|opacity:\s*0\.\d|border-radius:\s*\d/i;
    const nocturneInternalPrefix = "--" + "n-";
    const violations = ACTIVE_MASS_MIGRATION_FILES.flatMap((file) =>
      read(file)
        .split(/\r?\n/)
        .map((line, index) => ({ file, line: index + 1, text: line }))
        .filter(({ text }) => directVisualPattern.test(text) || text.includes(nocturneInternalPrefix)),
    );

    expect(violations).toEqual([]);
  });

  it("consumes every component Mass Migration token defined for the milestone", () => {
    const definitions = new Set<string>();
    for (const file of TOKEN_SOURCE_FILES) {
      const contents = read(file);
      for (const match of contents.matchAll(/--component-migration-[A-Za-z0-9_-]+\s*:/g)) {
        definitions.add(match[0].slice(0, -1).trim());
      }
    }

    const componentContents = ACTIVE_MASS_MIGRATION_FILES.map(read).join("\n");
    const unused = [...definitions].filter((token) => {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(`var\\(${escaped}(?:[,)]|\\s)`).test(componentContents);
    });

    expect(unused).toEqual([]);
  });
});
