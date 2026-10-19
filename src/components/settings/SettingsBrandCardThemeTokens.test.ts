import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (file: string) => readFileSync(file, "utf8");

describe("Settings brand card typography", () => {
  it("sets the wordmark and edition through theme tokens", () => {
    const styles = read("src/styles/nocturne-port.css");
    const baseTokens = read("src/styles/tokens.css");
    const nocturneTokens = read("src/styles/nocturne-theme.css");
    const titleRule = styles.match(/\.settings-brand-card__title\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    const metaRule = styles.match(/\.settings-brand-card__meta\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    const actionRule = styles.match(/(?:^|\n)\.epigraph-port--settings \.settings-rail-action\s*\{([\s\S]*?)\}/)?.[1] ?? "";

    const editionRule = styles.match(/\.settings-brand-card__edition\s*\{([\s\S]*?)\}/)?.[1] ?? "";

    expect(titleRule).toContain("var(--component-settings-brand-title-font-family)");
    expect(titleRule).toContain("var(--component-settings-brand-title-font-size)");
    expect(editionRule).toContain("var(--component-settings-brand-edition-font-size)");
    expect(editionRule).toContain("var(--component-settings-brand-edition-fg)");
    expect(titleRule).toContain("var(--component-settings-brand-title-font-weight)");
    expect(titleRule).not.toContain('"Outfit"');
    expect(metaRule).toContain("var(--component-settings-brand-meta-font-size)");
    expect(actionRule).toContain("var(--component-settings-brand-action-font-size)");
    expect(actionRule).not.toContain("text-transform: uppercase");

    for (const token of [
      "--component-settings-brand-title-font-family",
      "--component-settings-brand-title-font-size",
      "--component-settings-brand-edition-font-size",
      "--component-settings-brand-edition-fg",
      "--component-settings-brand-title-font-weight",
      "--component-settings-brand-title-fg",
      "--component-settings-brand-meta-font-size",
      "--component-settings-brand-meta-fg",
      "--component-settings-brand-action-font-size",
      "--component-settings-brand-action-font-weight",
    ]) {
      expect(baseTokens).toContain(`${token}:`);
      expect(nocturneTokens).toContain(`${token}:`);
    }
  });
});
