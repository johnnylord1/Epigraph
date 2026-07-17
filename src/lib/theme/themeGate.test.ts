import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveCssColor, type RgbaColor } from "../../test/themeColor";
import { themeProbeCss } from "../../test/themeProbe";
import { THEME_TOKEN_KEYS } from "./contract";

const ROOT = process.cwd();
const tokensCss = readFileSync(resolve(ROOT, "src/styles/tokens.css"), "utf8");
const nocturneCss = readFileSync(resolve(ROOT, "src/styles/nocturne-theme.css"), "utf8");
const nocturnePortCss = readFileSync(resolve(ROOT, "src/styles/nocturne-port.css"), "utf8");
const cssNamedColors = `
  aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
  blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk
  crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki
  darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
  darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue
  dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite
  gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
  lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
  lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen
  magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
  mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
  mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
  seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen
  steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen
`.trim().split(/\s+/).join("|");
const directColorPattern = new RegExp(
  `#[0-9a-f]{3,8}\\b|rgba?\\([^)]*\\)|hsla?\\([^)]*\\)|oklch\\([^)]*\\)|(?<![\\w-])(?:${cssNamedColors})(?![\\w-])`,
  "i",
);
const malformedSplitHexPattern = /#[0-9a-f]{3,7}\s+[a-f][0-9a-f]{0,4}\b/i;
const encodedHexPattern = /%(?:25)*23[0-9a-f]{3,8}\b/gi;
const encodedHexInventory = [
  "src/components/pages/Tracking.svelte:%23888",
  "src/components/pages/Tracking.svelte:%23888",
] as const;
const unreferencedLegacyNocturneTokens = [
  "--n-bg",
  "--n-bg-top",
  "--n-gradient-bg",
  "--n-line",
  "--n-line-strong",
  "--n-on-primary-container",
  "--n-outline-variant",
  "--n-popover-control-bg",
  "--n-popover-control-border",
  "--n-surface-container",
  "--n-surface-container-low",
] as const;
const selectorOnlyLegacyNocturneTokens = [
  "--n-surface-container-high",
  "--n-surface-container-highest",
  "--n-toolbar-cluster-padding",
  "--n-toolbar-cluster-radius",
  "--n-toolbar-divider-height",
  "--n-toolbar-icon-btn-size",
] as const;
const legacyNocturneTokens = [
  ...unreferencedLegacyNocturneTokens,
  ...selectorOnlyLegacyNocturneTokens,
] as const;
const legacyActivityTokens = [
  "--activity-panel",
  "--activity-panel-soft",
  "--activity-line",
  "--activity-line-soft",
  "--activity-text",
  "--activity-title",
  "--activity-muted",
  "--activity-subtle",
  "--activity-faint",
  "--activity-accent",
  "--activity-accent-soft",
  "--activity-accent-line",
  "--activity-danger",
] as const;
const compatibilityConsumerFiles = new Set([
  "src/styles/nocturne-port.css",
  "src/components/pages/Discover.svelte",
  "src/components/pages/Extensions.svelte",
  "src/components/shared/SourceBrowse.svelte",
  "src/components/shared/SourceList.svelte",
  "src/components/pages/NovelSources.svelte",
  "src/components/novels/NovelSourceCheckModal.svelte",
  "src/components/novels/NovelSourceStatusDetails.svelte",
  "src/components/settings/NovelRepositoriesPanel.svelte",
  "src/components/library/NovelsLibraryBody.svelte",
  "src/components/pages/Tracking.svelte",
  "src/components/pages/GenreDrillPage.svelte",
  "src/components/settings/SyncdConnectionPanel.svelte",
  "src/components/settings/SyncdSessionDetails.svelte",
  "src/lib/syncdQr.ts",
]);

interface CssDeclaration {
  name: string;
  value: string;
}

function declarations(source: string): CssDeclaration[] {
  return [...source.matchAll(/^\s*(--[\w-]+)\s*:\s*([\s\S]*?);/gm)].map(
    ([, name, value]) => ({ name, value: value.trim() }),
  );
}

function componentDeclarations(source: string) {
  return declarations(source).filter(
    ({ name }) => name.startsWith("--component-") && !name.startsWith("--component-syncd-"),
  );
}

function references(value: string) {
  return [...value.matchAll(/var\((--[\w-]+)(\s*,)?/g)].map((match) => ({
    name: match[1],
    hasFallback: Boolean(match[2]),
  }));
}

function declarationMap(...sources: string[]) {
  const result = new Map<string, string>();
  for (const source of sources) {
    for (const { name, value } of declarations(source)) result.set(name, value);
  }
  return result;
}

function cssBlock(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing CSS block ${selector}`);
  const bodyStart = source.indexOf("{", start) + 1;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index);
  }
  throw new Error(`Unclosed CSS block ${selector}`);
}

function reachesAny(
  name: string,
  roots: ReadonlySet<string>,
  definitions: ReadonlyMap<string, string>,
  seen = new Set<string>(),
): boolean {
  if (roots.has(name)) return true;
  if (seen.has(name)) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(name);
  return references(definitions.get(name) ?? "").some(({ name: reference }) =>
    reachesAny(reference, roots, definitions, nextSeen),
  );
}

function sourceCorpus(path: string): string {
  return readdirSync(resolve(ROOT, path), { withFileTypes: true })
    .flatMap((entry) => {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) return sourceCorpus(child);
      if (!/\.(?:css|svelte|ts)$/.test(entry.name) || entry.name.endsWith(".test.ts")) return [];
      return readFileSync(resolve(ROOT, child), "utf8");
    })
    .join("\n");
}

function sourceFiles(path: string): string[] {
  return readdirSync(resolve(ROOT, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(child);
    if (!/\.(?:css|svelte|ts)$/.test(entry.name) || entry.name.endsWith(".test.ts")) return [];
    return [child];
  });
}

function withoutDefinitions(source: string, token: string): string {
  return source.replace(new RegExp(`${token}\\s*:[^;]+;`, "g"), "");
}

function composite(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  return [
    (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
    alpha,
  ];
}

function luminance(color: RgbaColor) {
  const [red, green, blue] = color.slice(0, 3).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(source: string, foregroundToken: string, backgroundToken: string) {
  const canvas = resolveCssColor(source, "--color-background");
  const background = composite(resolveCssColor(source, backgroundToken), canvas);
  const foreground = composite(resolveCssColor(source, foregroundToken), background);
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

describe("final derived theme gate", () => {
  test("limits exact semantic sources to the builtin Nocturne document", () => {
    const selector = '[data-theme="nocturne"]:not([data-custom-theme]) {';
    const selectorStart = nocturneCss.indexOf(selector);
    const selectorEnd = nocturneCss.indexOf("\n}", selectorStart);
    const builtinBlock = nocturneCss.slice(selectorStart, selectorEnd);
    const outsideBuiltin = `${nocturneCss.slice(0, selectorStart)}${nocturneCss.slice(selectorEnd + 2)}`;
    const exactSources = declarations(builtinBlock).filter(
      ({ name, value }) => name.startsWith("--color-") && name.endsWith("-source") && directColorPattern.test(value),
    );
    const fallbackDefinitions = new Set(declarations(tokensCss).map(({ name }) => name));
    const corpus = `${tokensCss}\n${nocturneCss}\n${nocturnePortCss}`;
    const missingFallback = exactSources
      .filter(({ name }) => !fallbackDefinitions.has(name))
      .map(({ name }) => name);
    const unreferenced = exactSources
      .filter(({ name }) => !withoutDefinitions(corpus, name).includes(`var(${name}`))
      .map(({ name }) => name);
    const leaked = declarations(outsideBuiltin)
      .filter(
        ({ name, value }) => name.startsWith("--color-") && name.endsWith("-source") && directColorPattern.test(value),
      )
      .map(({ name, value }) => `${name}: ${value}`);

    expect(selectorStart).toBeGreaterThan(-1);
    expect(selectorEnd).toBeGreaterThan(selectorStart);
    expect(exactSources).toHaveLength(238);
    expect(builtinBlock).toContain("--color-on-accent-strong: #352660;");
    expect(outsideBuiltin).not.toMatch(/--color-on-accent-strong\s*:/);
    expect(new Set(exactSources.map(({ name }) => name)).size).toBe(238);
    expect(missingFallback).toEqual([]);
    expect(unreferenced).toEqual([]);
    expect(leaked).toEqual([]);
  });

  test("limits exact derived semantic colors to the builtin Nocturne document", () => {
    const selector = '[data-theme="nocturne"]:not([data-custom-theme]) {';
    const selectorStart = nocturneCss.indexOf(selector);
    const selectorEnd = nocturneCss.indexOf("\n}", selectorStart);
    const builtinBlock = nocturneCss.slice(selectorStart, selectorEnd);
    const outsideBuiltin = `${nocturneCss.slice(0, selectorStart)}${nocturneCss.slice(selectorEnd + 2)}`;
    const editable = new Set(THEME_TOKEN_KEYS.map((name) => `--${name}`));
    const exactRoles = declarations(builtinBlock).filter(
      ({ name, value }) =>
        name.startsWith("--color-") && !name.endsWith("-source") && directColorPattern.test(value),
    );
    const fallbackDefinitions = new Set(declarations(tokensCss).map(({ name }) => name));
    const missingFallback = exactRoles
      .filter(({ name }) => !fallbackDefinitions.has(name))
      .map(({ name }) => name);
    const leaked = declarations(outsideBuiltin)
      .filter(
        ({ name, value }) =>
          name.startsWith("--color-") &&
          !name.endsWith("-source") &&
          !editable.has(name) &&
          directColorPattern.test(value),
      )
      .map(({ name, value }) => `${name}: ${value}`);

    expect(exactRoles).toHaveLength(57);
    expect(new Set(exactRoles.map(({ name }) => name)).size).toBe(57);
    expect(missingFallback).toEqual([]);
    expect(leaked).toEqual([]);
  });

  test("keeps every non-Syncd component token free of direct colors", () => {
    const offenders = componentDeclarations(`${tokensCss}\n${nocturneCss}`)
      .filter(({ value }) => directColorPattern.test(value))
      .map(({ name, value }) => `${name}: ${value}`);

    expect(offenders).toEqual([]);
  });

  test("rejects malformed split hex colors in theme declarations", () => {
    const offenders = declarations(`${tokensCss}\n${nocturneCss}`)
      .filter(({ value }) => malformedSplitHexPattern.test(value))
      .map(({ name, value }) => `${name}: ${value}`);

    expect(offenders).toEqual([]);
  });

  test("keeps percent-encoded embedded colors in an explicit migration inventory", () => {
    const occurrences = sourceFiles("src").flatMap((path) =>
      Array.from(readFileSync(resolve(ROOT, path), "utf8").matchAll(encodedHexPattern), (match) =>
        `${path}:${match[0].toLowerCase()}`,
      ),
    ).sort();

    expect(occurrences).toEqual([...encodedHexInventory].sort());
  });

  test("classifies every component color dependency in the custom Nocturne cascade", () => {
    const definitions = declarationMap(
      cssBlock(tokensCss, ":root"),
      cssBlock(nocturneCss, '[data-theme="nocturne"]'),
      cssBlock(tokensCss, ":where(.book-viewer, .novel-viewer)"),
      cssBlock(nocturneCss, '[data-theme="nocturne"] :where(.book-viewer, .novel-viewer)'),
      cssBlock(nocturneCss, ":root"),
    );
    const editableRoots = new Set(THEME_TOKEN_KEYS.map((name) => `--${name}`));
    const absoluteRoots = new Set([
      "--primitive-absolute-black",
      "--primitive-absolute-white",
    ]);
    const runtimeRoots = new Set([
      "--prose-bg",
      "--prose-page-bg",
      "--prose-text",
      "--reader-accent",
    ]);
    const colorName = /(?:^|-)(?:bg|fg|color|background|border|shadow|fill|accent|surface|overlay|ink|gradient)(?:-|$)/i;
    const geometryName = /(?:^|-)(?:radius|width|height|size|gap|padding|margin|z-index|blur|font|letter|line-height|opacity|duration|transition|transform)(?:-|$)/i;
    const visualValue = /color-mix\(|gradient\(|var\(--(?:color|bg|text|accent|border|shadow|component-[\w-]*(?:bg|fg|color|background|border|shadow|fill|accent|surface|overlay|ink|gradient))|\btransparent\b/i;
    const componentColors = [...definitions]
      .filter(
        ([name, value]) =>
          name.startsWith("--component-") &&
          !name.startsWith("--component-syncd-") &&
          !geometryName.test(name) &&
          (colorName.test(name) || visualValue.test(value)),
      );
    const editable = componentColors.filter(([name]) => reachesAny(name, editableRoots, definitions));
    const absolute = componentColors.filter(([name]) => reachesAny(name, absoluteRoots, definitions));
    const runtime = componentColors.filter(([name]) => reachesAny(name, runtimeRoots, definitions));
    const neutral = componentColors.filter(
      ([name, value]) =>
        !reachesAny(name, editableRoots, definitions) &&
        !reachesAny(name, absoluteRoots, definitions) &&
        !reachesAny(name, runtimeRoots, definitions) &&
        /^(?:transparent|none|0(?:\s+0){0,3}|\d+(?:\.\d+)?(?:px|rem|em)\s+solid\s+transparent)$/i.test(value.trim()),
    );
    const mixedEditableAbsolute = editable.filter(([name]) =>
      reachesAny(name, absoluteRoots, definitions),
    );
    const absoluteOnly = absolute.filter(
      ([name]) =>
        !reachesAny(name, editableRoots, definitions) &&
        !reachesAny(name, runtimeRoots, definitions),
    );
    const classified = new Set(
      [...editable, ...absolute, ...runtime, ...neutral].map(([name]) => name),
    );
    const unresolved = componentColors
      .filter(([name]) => !classified.has(name))
      .map(([name, value]) => `${name}: ${value}`);

    expect({
      componentColors: componentColors.length,
      editable: editable.length,
      absolute: absolute.length,
      absoluteOnly: absoluteOnly.length,
      mixedEditableAbsolute: mixedEditableAbsolute.length,
      runtime: runtime.length,
      neutral: neutral.length,
    }).toEqual({
      componentColors: 1463,
      editable: 1452,
      absolute: 290,
      absoluteOnly: 0,
      mixedEditableAbsolute: 290,
      runtime: 9,
      neutral: 11,
    });
    expect(unresolved).toEqual([]);
  });

  test("keeps representative surface tokens connected to real consumers", () => {
    const definitions = declarationMap(tokensCss, nocturneCss);
    const consumed = new Set(
      references(`${sourceCorpus("src/components")}\n${nocturnePortCss}`).map(({ name }) => name),
    );
    const representativeSurfaces = [
      "--component-menu-bg",
      "--component-sidebar-bg",
      "--component-settings-card-bg",
      "--component-detail-layer-bg",
      "--component-home-card-bg",
      "--component-activity-center-bg",
      "--component-downloads-summary-bg",
      "--component-library-card-list-bg",
      "--component-browse-searchbar-background",
      "--component-sources-root-bg",
      "--component-reader-bg",
      "--component-migration-modal-bg",
      "--component-updater-status-bg",
    ];
    const disconnected = representativeSurfaces.filter((name) =>
      !consumed.has(name) &&
      ![...consumed].some((root) => reachesAny(root, new Set([name]), definitions)),
    );

    expect(disconnected).toEqual([]);
  });

  test("resolves component aliases independently in fallback and Nocturne layers", () => {
    const fallbackDefinitions = new Set(declarations(tokensCss).map(({ name }) => name));
    const nocturneDefinitions = new Set(
      declarations(`${tokensCss}\n${nocturneCss}`).map(({ name }) => name),
    );
    const fallbackMissing = componentDeclarations(tokensCss).flatMap(({ name, value }) =>
      references(value)
        .filter((reference) => !reference.hasFallback && !fallbackDefinitions.has(reference.name))
        .map((reference) => `${name} -> ${reference.name}`),
    );
    const nocturneMissing = componentDeclarations(nocturneCss).flatMap(({ name, value }) =>
      references(value)
        .filter((reference) => !reference.hasFallback && !nocturneDefinitions.has(reference.name))
        .map((reference) => `${name} -> ${reference.name}`),
    );

    expect(fallbackMissing).toEqual([]);
    expect(nocturneMissing).toEqual([]);
  });

  test("preserves the audited compatibility bridge and Legacy inventories", () => {
    const source = sourceCorpus("src");
    const nocturneTokens = new Set(
      declarations(nocturneCss)
        .map(({ name }) => name)
        .filter((name) => name.startsWith("--n-")),
    );
    const compatibilityBridges = [...nocturneTokens].filter(
      (token) => !legacyNocturneTokens.includes(token as (typeof legacyNocturneTokens)[number]),
    );

    expect(nocturneTokens.size).toBe(62);
    expect(compatibilityBridges).toHaveLength(45);
    expect(legacyNocturneTokens).toHaveLength(17);
    expect(legacyActivityTokens).toHaveLength(13);

    for (const token of [...unreferencedLegacyNocturneTokens, ...legacyActivityTokens]) {
      expect(nocturneCss, `${token} must remain defined`).toMatch(new RegExp(`${token}\\s*:`));
      expect(withoutDefinitions(source, token), `${token} gained an active reference`).not.toMatch(
        new RegExp(`${token}(?![A-Za-z0-9_-])`),
      );
    }

    for (const token of selectorOnlyLegacyNocturneTokens) {
      expect(nocturneCss, `${token} must remain defined`).toMatch(new RegExp(`${token}\\s*:`));
      expect(nocturnePortCss, `${token} must remain attached to its Legacy selector`).toContain(`var(${token})`);
    }
  });

  test("keeps active non-Syncd production consumers independent from --n-*", () => {
    const activeSources = sourceFiles("src")
      .filter((path) => !compatibilityConsumerFiles.has(path))
      .filter((path) => !path.endsWith("src/styles/tokens.css") && !path.endsWith("src/styles/nocturne-theme.css"))
      .map((path) => readFileSync(resolve(ROOT, path), "utf8"));
    const activeThemeDefinitions = `${tokensCss}\n${nocturneCss}`
      .replace(/^\s*--(?:n|activity)-[\w-]+\s*:\s*[\s\S]*?;/gm, "")
      .replace(/^\s*--component-syncd-[\w-]+\s*:\s*[\s\S]*?;/gm, "");
    const references = `${activeSources.join("\n")}\n${activeThemeDefinitions}`
      .match(/var\(--n-[\w-]+/g) ?? [];

    expect(references).toEqual([]);
  });

  test.each([
    ["red", true],
    ["linear-gradient(red, transparent)", true],
    ["1px solid rebeccapurple", true],
    ["transparent", false],
    ["currentColor", false],
    ["var(--red)", false],
  ])("classifies direct named color syntax in %s", (value, expected) => {
    expect(directColorPattern.test(value)).toBe(expected);
  });

  test.each([
    ["primary text", "--text-primary", "--color-background"],
    ["secondary text", "--text-secondary", "--color-background"],
    ["tertiary text", "--text-tertiary", "--color-background"],
    ["button text", "--component-button-fg", "--component-button-bg"],
    ["input text", "--component-input-fg", "--component-input-bg"],
    ["Reader muted text", "--component-reader-muted-fg", "--component-reader-panel-bg"],
    ["Migration eyebrow", "--component-migration-eyebrow-fg", "--component-migration-modal-bg"],
    ["Migration muted text", "--component-migration-muted-fg", "--component-migration-modal-bg"],
    ["Novel field label", "--component-novel-repositories-field-color", "--component-novel-repositories-input-background"],
    ["Novel muted text", "--component-novel-repositories-muted-color", "--component-novel-repositories-surface-background"],
    ["Novel muted badge", "--component-novel-repositories-badge-muted-color", "--component-novel-repositories-badge-background"],
  ])("keeps %s at WCAG AA in Nocturne and the theme probe", (_label, foreground, background) => {
    const nocturneSource = `${tokensCss}\n${nocturneCss}`;
    const probeSource = `${tokensCss}\n:root {\n${themeProbeCss()}\n}`;

    expect(contrast(nocturneSource, foreground, background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(probeSource, foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});
