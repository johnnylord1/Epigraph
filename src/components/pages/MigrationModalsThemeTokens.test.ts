import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(__dirname, "../../..");

const MIGRATION_MODAL_FILES = [
  "src/components/pages/MigrateModal.svelte",
  "src/components/pages/NovelMigrateModal.svelte",
] as const;

const TOKEN_FILES = [
  "src/styles/tokens.css",
  "src/styles/nocturne-theme.css",
] as const;

function readRepoFile(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function styleBlock(source: string) {
  return source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
}

describe("individual migration modal theme tokens", () => {
  test("keeps migration modal styles free of direct visual values and Nocturne internals", () => {
    const directVisualPattern =
      /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(|backdrop-filter:\s*blur|box-shadow:\s*[^;]*rgba|z-index:\s*\d|opacity:\s*0\.\d|border-radius:\s*(?:\d|50%)|--n-/;

    const offenders = MIGRATION_MODAL_FILES.flatMap((file) =>
      styleBlock(readRepoFile(file))
        .split(/\r?\n/)
        .map((text, index) => ({ file, line: index + 1, text: text.trim() }))
        .filter(({ text }) => text.length > 0 && directVisualPattern.test(text)),
    );

    expect(offenders).toEqual([]);
  });

  test("defines all consumed migration modal tokens and consumes every new modal token", () => {
    const tokenSource = TOKEN_FILES.map(readRepoFile).join("\n");
    const componentSource = MIGRATION_MODAL_FILES.map(readRepoFile).join("\n");

    const definitions = new Set(
      [...tokenSource.matchAll(/(--component-(?:migration|migrate-modal|novel-migrate)-[\w-]+)\s*:/g)].map((match) => match[1]),
    );
    const consumed = new Set(
      [...componentSource.matchAll(/var\((--component-(?:migration|migrate-modal|novel-migrate)-[\w-]+)/g)].map((match) => match[1]),
    );

    const newMilestoneDefinitions = [...definitions].filter((token) =>
      token.startsWith("--component-migrate-modal-") || token.startsWith("--component-novel-migrate-"),
    );
    const unused = newMilestoneDefinitions.filter((token) => !consumed.has(token));
    const undefinedTokens = [...consumed].filter((token) => !definitions.has(token));

    expect(newMilestoneDefinitions.length).toBeGreaterThan(0);
    expect(unused, "all Marco 12 migration modal tokens should be consumed").toEqual([]);
    expect(undefinedTokens, "all consumed migration modal tokens should be defined").toEqual([]);
  });
});
