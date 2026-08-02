import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");
const messageRoot = join(process.cwd(), "messages");
const productionExtensions = /\.(svelte|ts|js)$/;
const testFile = /(?:\.test|\.browser\.test)\.(?:svelte|ts|js)$/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "paraglide") return [];
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return productionExtensions.test(entry.name) && !testFile.test(entry.name) ? [file] : [];
  });
}

function staticMessageReferences(): Map<string, string[]> {
  const references = new Map<string, string[]>();
  const patterns = [
    /\$_\(\s*["']([^"']+)["']/g,
    /\btranslate\(\s*["']([^"']+)["']/g,
  ];

  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const id = match[1];
        const locations = references.get(id) ?? [];
        locations.push(relative(process.cwd(), file));
        references.set(id, locations);
      }
    }
  }

  return references;
}

function messageCatalogs(): Array<{ locale: string; messages: Record<string, string> }> {
  return readdirSync(messageRoot)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      locale: file.slice(0, -5),
      messages: JSON.parse(readFileSync(join(messageRoot, file), "utf8")) as Record<string, string>,
    }));
}

describe("translation catalog contract", () => {
  it("contains every statically referenced production message in every catalog", () => {
    const catalogs = messageCatalogs();
    const references = staticMessageReferences();
    const missing: string[] = [];

    for (const [id, files] of references) {
      const key = id.replaceAll(".", "_");
      for (const catalog of catalogs) {
        if (!(key in catalog.messages)) {
          missing.push(`${catalog.locale}:${id} (${files.join(", ")})`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("keeps every catalog aligned with the same message key set", () => {
    const catalogs = messageCatalogs();
    const baseline = new Set(Object.keys(catalogs[0]?.messages ?? {}));
    const differences = catalogs.slice(1).flatMap((catalog) => {
      const keys = new Set(Object.keys(catalog.messages));
      return [
        ...[...baseline].filter((key) => !keys.has(key)).map((key) => `${catalog.locale}:missing:${key}`),
        ...[...keys].filter((key) => !baseline.has(key)).map((key) => `${catalog.locale}:extra:${key}`),
      ];
    });

    expect(differences).toEqual([]);
  });
});
