import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");
const messageRoot = join(process.cwd(), "messages");
const productionExtensions = /\.(svelte|ts|js)$/;
const testFile = /(?:\.test|\.browser\.test)\.(?:svelte|ts|js)$/;
const allowedLiteralFeedback = new Set(["Hardcover", "Suwayomi"]);
const unaccentedPortugueseWords = [
  "acao", "acoes", "atencao", "autorizacao", "capitulo", "capitulos",
  "configuracao", "configuracoes", "conexao", "conteudo", "diagnostico",
  "dialogo", "disponivel", "disponiveis", "estao", "extensao", "extensoes",
  "genero", "generos", "inacessivel", "indisponivel", "indisponiveis",
  "inicializacao", "inicio", "instalacao", "nao", "pagina", "paginas",
  "possivel", "preferencia", "preferencias", "proximo", "proximos",
  "redefinicao", "replicacao", "repositorio", "repositorios", "requisicao",
  "sincronizacao", "temporaria", "temporario", "titulo", "titulos", "traducao",
  "validacao", "verificacao", "visualizacao", "voce", "confiavel", "confiaveis",
];
const unaccentedSpanishWords = [
  "aqui", "asignacion", "atencion", "autenticacion", "categorias", "configuracion",
  "diagnosticos", "edicion", "entregandola", "instalara", "limites",
  "navegacion", "ningun", "organizacion", "paginas", "presentacion", "restauracion",
  "sincronizacion", "traves", "ubicacion",
];

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

  it("keeps localized values normalized and placeholders aligned", () => {
    const catalogs = messageCatalogs();
    const english = catalogs.find((catalog) => catalog.locale === "en")?.messages ?? {};
    const placeholderPattern = /\{[^{}]+\}/g;
    const errors: string[] = [];

    for (const catalog of catalogs) {
      for (const [key, value] of Object.entries(catalog.messages)) {
        if (!value.trim()) errors.push(`${catalog.locale}:empty:${key}`);
        if (value !== value.normalize("NFC")) errors.push(`${catalog.locale}:non-nfc:${key}`);
        const expected = (english[key]?.match(placeholderPattern) ?? []).sort();
        const actual = (value.match(placeholderPattern) ?? []).sort();
        if (actual.join("|") !== expected.join("|")) {
          errors.push(`${catalog.locale}:placeholders:${key}`);
        }
      }
    }

    expect(errors).toEqual([]);
  });

  it("does not ship replacement-character corruption in localized copy", () => {
    const corrupted: string[] = [];

    for (const catalog of messageCatalogs()) {
      for (const [key, value] of Object.entries(catalog.messages)) {
        if (value.includes("\uFFFD") || /\?{2,}/.test(value)) {
          corrupted.push(`${catalog.locale}:${key}: ${value}`);
        }
      }
    }

    expect(corrupted).toEqual([]);
  });

  it("does not ship common ASCII transliterations in Brazilian Portuguese", () => {
    const portuguese = messageCatalogs().find((catalog) => catalog.locale === "pt-BR")?.messages ?? {};
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])(?:${unaccentedPortugueseWords.join("|")})(?![\\p{L}\\p{N}_])`,
      "iu",
    );
    const invalid = Object.entries(portuguese)
      .filter(([, value]) => pattern.test(value))
      .map(([key, value]) => `${key}: ${value}`);

    expect(invalid).toEqual([]);
  });

  it("does not ship common ASCII transliterations in Spanish", () => {
    const spanish = messageCatalogs().find((catalog) => catalog.locale === "es")?.messages ?? {};
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])(?:${unaccentedSpanishWords.join("|")})(?![\\p{L}\\p{N}_])`,
      "iu",
    );
    const invalid = Object.entries(spanish)
      .filter(([, value]) => pattern.test(value))
      .map(([key, value]) => `${key}: ${value}`);

    expect(invalid).toEqual([]);
  });

  it("routes state and toast feedback copy through the translation catalogs", () => {
    const violations: string[] = [];
    const literalStateProp = /\b(?:eyebrow|title|body|detail)="([^"{}]+)"/g;
    const literalToastCopy = /\b(?:title|body):\s*"([^"{}]+)"/g;

    for (const file of sourceFiles(sourceRoot).filter((entry) => entry.endsWith(".svelte"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(literalStateProp)) {
        if (!source.slice(Math.max(0, match.index - 400), match.index).includes("<NocturneState")) continue;
        if (allowedLiteralFeedback.has(match[1])) continue;
        violations.push(`${relative(process.cwd(), file)}:state:${match[1]}`);
      }
      for (const match of source.matchAll(literalToastCopy)) {
        const prefix = source.slice(Math.max(0, match.index - 500), match.index);
        if (!prefix.includes("addToast(")) continue;
        violations.push(`${relative(process.cwd(), file)}:toast:${match[1]}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
