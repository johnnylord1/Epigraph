import {
  BUILTIN_THEME_IDS,
  HUD_THEME_TOKEN_KEYS,
  NOCTURNE_HUD_THEME_TOKENS,
  NOCTURNE_THEME_TOKENS,
  THEME_PRIMITIVE_TOKEN_KEYS,
  THEME_SEMANTIC_TOKEN_KEYS,
  THEME_TOKEN_KEYS,
  getBuiltinThemeFallbackContract,
  isBuiltinTheme,
  type BuiltinTheme,
  type CustomTheme,
  type HudThemeTokens,
  type LegacyCustomTheme,
  type ThemeDocumentV4,
  type ThemeMotionPreset,
  type ThemePrimitiveTokens,
  type ThemeSemanticTokens,
  type ThemeTokens,
} from "./contract";

export const THEME_DOCUMENT_VERSION = 4 as const;

export interface CreateThemeDocumentV4Input {
  id: string;
  name: string;
  base?: BuiltinTheme;
  tokens: ThemeTokens;
  hud?: Partial<HudThemeTokens>;
  motion: ThemeMotionPreset;
}

export type ThemeDocumentValidationErrorCode =
  | "invalid-type"
  | "missing-key"
  | "unknown-key"
  | "component-token"
  | "invalid-version"
  | "invalid-id"
  | "invalid-name"
  | "invalid-base"
  | "invalid-motion"
  | "invalid-value"
  | "css-rule"
  | "unsafe-url"
  | "injection-character"
  | "unknown-variable"
  | "invalid-hud-unit"
  | "variable-cycle";

export interface ThemeDocumentValidationError {
  code: ThemeDocumentValidationErrorCode;
  path: string;
  message: string;
}

export type ThemeDocumentValidationResult =
  | {
      valid: true;
      ok: true;
      value: ThemeDocumentV4;
      document: ThemeDocumentV4;
      errors: [];
    }
  | {
      valid: false;
      ok: false;
      errors: ThemeDocumentValidationError[];
    };

export type ThemeDocumentMigrationResult =
  | { ok: true; document: ThemeDocumentV4 }
  | { ok: false; error: string };

export class ThemeDocumentError extends Error {
  readonly errors: ThemeDocumentValidationError[];

  constructor(message: string, errors: ThemeDocumentValidationError[] = []) {
    super(message);
    this.name = "ThemeDocumentError";
    this.errors = errors;
  }
}

const MOTION_PRESETS = new Set<string>(["minimal", "soft", "expressive"]);
const PRIMITIVE_KEYS = new Set<string>(THEME_PRIMITIVE_TOKEN_KEYS);
const SEMANTIC_KEYS = new Set<string>(THEME_SEMANTIC_TOKEN_KEYS);
const THEME_KEYS = new Set<string>(THEME_TOKEN_KEYS);
const HUD_KEYS = new Set<string>(HUD_THEME_TOKEN_KEYS);

const V4_TOP_LEVEL_KEYS = new Set([
  "version",
  "id",
  "name",
  "base",
  "primitives",
  "semanticOverrides",
  "hud",
  "motion",
]);
const LEGACY_TOP_LEVEL_KEYS = new Set([
  "version",
  "id",
  "name",
  "tokens",
  "hud",
  "motion",
  "description",
  "preview",
]);
const CREATE_INPUT_KEYS = new Set(["id", "name", "base", "tokens", "hud", "motion"]);

const HUD_OPACITY_KEYS = new Set<keyof HudThemeTokens>([
  "hud-surface-opacity",
  "hud-reader-chrome-opacity",
]);
const HUD_COLOR_KEYS = new Set<keyof HudThemeTokens>([
  "hud-selection-bg",
  "hud-selection-border",
]);

const CUSTOM_THEME_ID_PATTERN = /^custom:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME_INJECTION_PATTERN = /[<>{}\u0000-\u001f\u007f]/;
const CSS_RULE_PATTERN = /[{}@]|\/\*|\*\//;
const CSS_URL_PATTERN = /url\s*\(/i;
const CSS_EXPRESSION_PATTERN = /(?:expression|-moz-binding)\s*\(/i;
const CSS_INJECTION_PATTERN = /[;:!<>"'`\\]|[\u0000-\u001f\u007f]/;
const CSS_VAR_START_PATTERN = /var\s*\(/gi;
const CSS_VAR_CALL_PATTERN = /var\s*\(([^()]*)\)/gi;
const CSS_VARIABLE_NAME_PATTERN = /^--[A-Za-z0-9_-]+$/;
const CSS_PIXEL_VALUE_PATTERN = /^(?:\d+(?:\.\d+)?|\.\d+)px$/;
const CSS_NUMBER_VALUE_PATTERN = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const CSS_COLOR_VALUE_PATTERN = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|oklch|color-mix)\(.+\)|var\(--[a-z0-9_-]+\)|transparent)$/i;

const KNOWN_CSS_VARIABLES = new Set<string>([
  ...THEME_TOKEN_KEYS.map((key) => `--${key}`),
  ...HUD_THEME_TOKEN_KEYS.map((key) => `--${key}`),
  "--t-fast",
  "--t-base",
  "--t-slow",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addError(
  errors: ThemeDocumentValidationError[],
  code: ThemeDocumentValidationErrorCode,
  path: string,
  message: string,
): void {
  errors.push({ code, path, message });
}

function validateKnownKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  path: string,
  errors: ThemeDocumentValidationError[],
): void {
  for (const key of Object.keys(value)) {
    if (allowedKeys.has(key)) continue;
    const isComponent = key.startsWith("component-") || key.startsWith("--component-");
    addError(
      errors,
      isComponent ? "component-token" : "unknown-key",
      `${path}.${key}`,
      isComponent ? "Component tokens cannot be customized." : `Unknown key "${key}".`,
    );
  }
}

function validateIdentity(
  value: Record<string, unknown>,
  errors: ThemeDocumentValidationError[],
  includeBase: boolean,
): void {
  if (typeof value.id !== "string" || !CUSTOM_THEME_ID_PATTERN.test(value.id)) {
    addError(errors, "invalid-id", "$.id", "Theme id must use a non-empty custom:<id> slug.");
  }
  if (
    typeof value.name !== "string"
    || value.name.length > 80
    || value.name.trim().length === 0
    || value.name !== value.name.trim()
    || NAME_INJECTION_PATTERN.test(value.name)
  ) {
    addError(errors, "invalid-name", "$.name", "Theme name must be a trimmed, injection-safe string of at most 80 characters.");
  }
  if (includeBase && (typeof value.base !== "string" || !isBuiltinTheme(value.base))) {
    addError(errors, "invalid-base", "$.base", `Theme base must be one of: ${BUILTIN_THEME_IDS.join(", ")}.`);
  }
}

function validateMotion(
  value: unknown,
  path: string,
  errors: ThemeDocumentValidationError[],
  optional: boolean,
): void {
  if (optional && value === undefined) return;
  if (typeof value !== "string" || !MOTION_PRESETS.has(value)) {
    addError(errors, "invalid-motion", path, "Unknown theme motion preset.");
  }
}

function hasBalancedParentheses(value: string): boolean {
  let depth = 0;
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function extractCssVariableReferences(
  value: string,
  path: string,
  errors: ThemeDocumentValidationError[],
): string[] {
  const starts = [...value.matchAll(CSS_VAR_START_PATTERN)];
  const calls = [...value.matchAll(CSS_VAR_CALL_PATTERN)];
  if (starts.length !== calls.length) {
    addError(errors, "invalid-value", path, "CSS variables must use var(--known-token) without fallbacks.");
    return [];
  }

  const references: string[] = [];
  for (const call of calls) {
    const reference = call[1].trim();
    if (!CSS_VARIABLE_NAME_PATTERN.test(reference)) {
      addError(errors, "invalid-value", path, "CSS variables must use var(--known-token) without fallbacks.");
      continue;
    }
    references.push(reference);
    if (reference.startsWith("--component-")) {
      addError(errors, "component-token", path, `Component variable "${reference}" is not allowed.`);
    } else if (!KNOWN_CSS_VARIABLES.has(reference)) {
      addError(errors, "unknown-variable", path, `Unknown CSS variable "${reference}".`);
    }
  }
  return references;
}

function validateCssValue(
  value: unknown,
  path: string,
  errors: ThemeDocumentValidationError[],
): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    addError(errors, "invalid-value", path, "Token values must be non-empty strings.");
    return [];
  }
  if (value !== value.trim() || !hasBalancedParentheses(value)) {
    addError(errors, "invalid-value", path, "Token values must be trimmed and have balanced parentheses.");
  }
  if (CSS_URL_PATTERN.test(value)) {
    addError(errors, "unsafe-url", path, "url() is not allowed in theme token values.");
  }
  if (CSS_RULE_PATTERN.test(value)) {
    addError(errors, "css-rule", path, "CSS rules, at-rules, and comments are not allowed.");
  }
  if (CSS_INJECTION_PATTERN.test(value) || CSS_EXPRESSION_PATTERN.test(value)) {
    addError(errors, "injection-character", path, "The token contains CSS injection characters or expressions.");
  }
  return extractCssVariableReferences(value, path, errors);
}

function validateThemeColorValue(
  value: unknown,
  path: string,
  errors: ThemeDocumentValidationError[],
): string[] {
  const references = validateCssValue(value, path, errors);
  if (typeof value === "string" && !CSS_COLOR_VALUE_PATTERN.test(value)) {
    addError(errors, "invalid-value", path, "Theme token values must be colors or references to known theme variables.");
  }
  return references;
}

export function isValidThemeTokenValue(value: string): boolean {
  const errors: ThemeDocumentValidationError[] = [];
  validateThemeColorValue(value, "$", errors);
  return errors.length === 0;
}

function validateTokenMap(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[],
  path: string,
  errors: ThemeDocumentValidationError[],
  graph: Map<string, string[]>,
): value is Record<string, string> {
  if (!isRecord(value)) {
    addError(errors, "invalid-type", path, "Expected an object of theme tokens.");
    return false;
  }

  validateKnownKeys(value, allowedKeys, path, errors);
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      addError(errors, "missing-key", `${path}.${key}`, `Missing required token "${key}".`);
    }
  }
  for (const [key, tokenValue] of Object.entries(value)) {
    if (!allowedKeys.has(key)) continue;
    graph.set(`--${key}`, validateThemeColorValue(tokenValue, `${path}.${key}`, errors));
  }
  return true;
}

function validateHudMap(
  value: unknown,
  path: string,
  errors: ThemeDocumentValidationError[],
  graph: Map<string, string[]>,
): value is Partial<HudThemeTokens> {
  if (!isRecord(value)) {
    addError(errors, "invalid-type", path, "Expected an object of HUD tokens.");
    return false;
  }

  validateKnownKeys(value, HUD_KEYS, path, errors);
  for (const [key, tokenValue] of Object.entries(value)) {
    if (!HUD_KEYS.has(key)) continue;
    const hudKey = key as keyof HudThemeTokens;
    graph.set(`--${key}`, validateCssValue(tokenValue, `${path}.${key}`, errors));

    if (typeof tokenValue !== "string") continue;
    const numericValue = Number(tokenValue);
    if (
      HUD_OPACITY_KEYS.has(hudKey)
      && (!CSS_NUMBER_VALUE_PATTERN.test(tokenValue) || numericValue < 0 || numericValue > 1)
    ) {
      addError(errors, "invalid-hud-unit", `${path}.${key}`, "HUD opacity must be a unitless number from 0 to 1.");
    } else if (
      !HUD_OPACITY_KEYS.has(hudKey)
      && !HUD_COLOR_KEYS.has(hudKey)
      && !CSS_PIXEL_VALUE_PATTERN.test(tokenValue)
    ) {
      addError(errors, "invalid-hud-unit", `${path}.${key}`, "HUD dimensions must use a non-negative px value.");
    }
  }
  return true;
}

function validateCycles(
  graph: Map<string, string[]>,
  errors: ThemeDocumentValidationError[],
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (node: string): void => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const signature = [...new Set(cycle)].sort().join("|");
      if (!reported.has(signature)) {
        reported.add(signature);
        addError(errors, "variable-cycle", node, `CSS variable cycle detected: ${cycle.join(" -> ")}.`);
      }
      return;
    }

    visiting.add(node);
    stack.push(node);
    for (const dependency of graph.get(node) ?? []) {
      if (graph.has(dependency)) visit(dependency);
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of graph.keys()) visit(node);
}

function copyKnownValues<Key extends string>(
  source: Record<string, unknown>,
  keys: readonly Key[],
): Partial<Record<Key, string>> {
  const result: Partial<Record<Key, string>> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function copyDifferences<Key extends string>(
  source: Record<string, unknown>,
  base: Record<Key, string>,
  keys: readonly Key[],
): Partial<Record<Key, string>> {
  const result: Partial<Record<Key, string>> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value !== base[key]) result[key] = value;
  }
  return result;
}

function canonicalizeV4(value: Record<string, unknown>): ThemeDocumentV4 {
  const document: ThemeDocumentV4 = {
    version: THEME_DOCUMENT_VERSION,
    id: value.id as `custom:${string}`,
    name: value.name as string,
    base: value.base as BuiltinTheme,
    primitives: copyKnownValues(
      value.primitives as Record<string, unknown>,
      THEME_PRIMITIVE_TOKEN_KEYS,
    ) as ThemePrimitiveTokens,
    motion: value.motion as ThemeMotionPreset,
  };
  if (value.semanticOverrides !== undefined) {
    document.semanticOverrides = copyKnownValues(
      value.semanticOverrides as Record<string, unknown>,
      THEME_SEMANTIC_TOKEN_KEYS,
    ) as Partial<ThemeSemanticTokens>;
  }
  if (value.hud !== undefined) {
    document.hud = copyKnownValues(
      value.hud as Record<string, unknown>,
      HUD_THEME_TOKEN_KEYS,
    ) as Partial<HudThemeTokens>;
  }
  return document;
}

export function validateThemeDocument(input: unknown): ThemeDocumentValidationResult {
  const errors: ThemeDocumentValidationError[] = [];
  const graph = new Map<string, string[]>();
  if (!isRecord(input)) {
    addError(errors, "invalid-type", "$", "Theme document must be an object.");
    return { valid: false, ok: false, errors };
  }

  validateKnownKeys(input, V4_TOP_LEVEL_KEYS, "$", errors);
  if (input.version !== THEME_DOCUMENT_VERSION) {
    addError(errors, "invalid-version", "$.version", "Theme document version must be 4.");
  }
  validateIdentity(input, errors, true);
  validateMotion(input.motion, "$.motion", errors, false);
  validateTokenMap(input.primitives, PRIMITIVE_KEYS, [], "$.primitives", errors, graph);
  if (input.semanticOverrides !== undefined) {
    validateTokenMap(input.semanticOverrides, SEMANTIC_KEYS, [], "$.semanticOverrides", errors, graph);
  }
  if (input.hud !== undefined) validateHudMap(input.hud, "$.hud", errors, graph);
  validateCycles(graph, errors);

  if (errors.length > 0) return { valid: false, ok: false, errors };
  const document = canonicalizeV4(input);
  return { valid: true, ok: true, value: document, document, errors: [] };
}

export function isThemeDocumentV4(input: unknown): input is ThemeDocumentV4 {
  return validateThemeDocument(input).valid;
}

export function assertThemeDocumentV4(input: unknown): asserts input is ThemeDocumentV4 {
  const result = validateThemeDocument(input);
  if (!result.valid) throw new ThemeDocumentError("Invalid ThemeDocumentV4.", result.errors);
}

function validateLegacyThemeDocument(input: unknown): ThemeDocumentValidationError[] {
  const errors: ThemeDocumentValidationError[] = [];
  const graph = new Map<string, string[]>();
  if (!isRecord(input)) {
    addError(errors, "invalid-type", "$", "Legacy theme document must be an object.");
    return errors;
  }

  validateKnownKeys(input, LEGACY_TOP_LEVEL_KEYS, "$", errors);
  const version = input.version ?? 1;
  if (version !== 1 && version !== 2 && version !== 3) {
    addError(errors, "invalid-version", "$.version", "Legacy theme document version must be 1, 2, or 3.");
  }
  validateIdentity(input, errors, false);
  validateTokenMap(input.tokens, THEME_KEYS, [], "$.tokens", errors, graph);
  if (input.hud !== undefined) validateHudMap(input.hud, "$.hud", errors, graph);
  validateMotion(input.motion, "$.motion", errors, true);
  if (input.description !== undefined && typeof input.description !== "string") {
    addError(errors, "invalid-type", "$.description", "Legacy description must be a string.");
  }
  if (input.preview !== undefined && typeof input.preview !== "string") {
    addError(errors, "invalid-type", "$.preview", "Legacy preview must be a string.");
  }
  validateCycles(graph, errors);
  return errors;
}

function errorMessage(errors: ThemeDocumentValidationError[]): string {
  return errors.map((error) => `${error.path}: ${error.message}`).join(" ");
}

export function migrateThemeDocument(input: unknown): ThemeDocumentMigrationResult {
  if (isRecord(input) && input.version === THEME_DOCUMENT_VERSION) {
    const validation = validateThemeDocument(input);
    return validation.valid
      ? { ok: true, document: validation.document }
      : { ok: false, error: errorMessage(validation.errors) };
  }

  const errors = validateLegacyThemeDocument(input);
  if (errors.length > 0 || !isRecord(input) || !isRecord(input.tokens)) {
    return { ok: false, error: errorMessage(errors) || "Invalid legacy theme document." };
  }

  const primitives = copyDifferences(
    input.tokens,
    NOCTURNE_THEME_TOKENS,
    THEME_PRIMITIVE_TOKEN_KEYS,
  ) as ThemePrimitiveTokens;
  const semanticOverrides = copyDifferences(
    input.tokens,
    NOCTURNE_THEME_TOKENS,
    THEME_SEMANTIC_TOKEN_KEYS,
  ) as Partial<ThemeSemanticTokens>;
  const hud = copyDifferences(
    (input.hud as Record<string, unknown> | undefined) ?? {},
    NOCTURNE_HUD_THEME_TOKENS,
    HUD_THEME_TOKEN_KEYS,
  ) as Partial<HudThemeTokens>;
  const candidate: ThemeDocumentV4 = {
    version: THEME_DOCUMENT_VERSION,
    id: input.id as `custom:${string}`,
    name: input.name as string,
    base: "nocturne",
    primitives,
    motion: (input.motion ?? "soft") as ThemeMotionPreset,
  };
  if (Object.keys(semanticOverrides).length > 0) candidate.semanticOverrides = semanticOverrides;
  if (Object.keys(hud).length > 0) candidate.hud = hud;

  const validation = validateThemeDocument(candidate);
  return validation.valid
    ? { ok: true, document: validation.document }
    : { ok: false, error: errorMessage(validation.errors) };
}

export function importThemeDocument(serialized: string): ThemeDocumentMigrationResult {
  if (typeof serialized !== "string") {
    return { ok: false, error: "Serialized theme document must be a string." };
  }
  try {
    return migrateThemeDocument(JSON.parse(serialized) as unknown);
  } catch (error) {
    return {
      ok: false,
      error: `Theme document is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function validateCreateInput(input: unknown): ThemeDocumentValidationError[] {
  const errors: ThemeDocumentValidationError[] = [];
  const graph = new Map<string, string[]>();
  if (!isRecord(input)) {
    addError(errors, "invalid-type", "$", "Theme creation input must be an object.");
    return errors;
  }

  validateKnownKeys(input, CREATE_INPUT_KEYS, "$", errors);
  validateIdentity({ ...input, base: input.base ?? "nocturne" }, errors, true);
  validateMotion(input.motion, "$.motion", errors, false);
  validateTokenMap(input.tokens, THEME_KEYS, THEME_TOKEN_KEYS, "$.tokens", errors, graph);
  if (input.hud !== undefined) validateHudMap(input.hud, "$.hud", errors, graph);
  validateCycles(graph, errors);
  return errors;
}

export function createThemeDocumentV4(
  input: CreateThemeDocumentV4Input,
  baseTokens?: ThemeTokens,
  baseHud?: HudThemeTokens,
): ThemeDocumentV4 {
  const inputErrors = validateCreateInput(input);
  if (inputErrors.length > 0) {
    throw new ThemeDocumentError("Invalid theme creation input.", inputErrors);
  }

  const baseContract = getBuiltinThemeFallbackContract(input.base ?? "nocturne");
  const resolvedBaseTokens = baseTokens ?? baseContract.tokens;
  const resolvedBaseHud = baseHud ?? baseContract.hud;
  const source = input.tokens as unknown as Record<string, unknown>;
  const primitives = copyDifferences(
    source,
    resolvedBaseTokens,
    THEME_PRIMITIVE_TOKEN_KEYS,
  ) as ThemePrimitiveTokens;
  const semanticOverrides = copyDifferences(
    source,
    resolvedBaseTokens,
    THEME_SEMANTIC_TOKEN_KEYS,
  ) as Partial<ThemeSemanticTokens>;
  const hud = copyDifferences(
    (input.hud as Record<string, unknown> | undefined) ?? {},
    resolvedBaseHud,
    HUD_THEME_TOKEN_KEYS,
  ) as Partial<HudThemeTokens>;
  const document: ThemeDocumentV4 = {
    version: THEME_DOCUMENT_VERSION,
    id: input.id as `custom:${string}`,
    name: input.name,
    base: input.base ?? "nocturne",
    primitives,
    motion: input.motion,
  };
  if (Object.keys(semanticOverrides).length > 0) document.semanticOverrides = semanticOverrides;
  if (Object.keys(hud).length > 0) document.hud = hud;

  const validation = validateThemeDocument(document);
  if (!validation.valid) {
    throw new ThemeDocumentError("Created ThemeDocumentV4 is invalid.", validation.errors);
  }
  return validation.document;
}

export function resolveThemeDocument(
  document: ThemeDocumentV4,
  baseTokens?: ThemeTokens,
  baseHud?: HudThemeTokens,
): { tokens: ThemeTokens; hud: HudThemeTokens } {
  const validation = validateThemeDocument(document);
  if (!validation.valid) throw new ThemeDocumentError("Invalid ThemeDocumentV4.", validation.errors);
  const baseContract = getBuiltinThemeFallbackContract(validation.document.base);
  const resolvedBaseTokens = baseTokens ?? baseContract.tokens;
  const resolvedBaseHud = baseHud ?? baseContract.hud;

  return {
    tokens: {
      ...resolvedBaseTokens,
      ...validation.document.primitives,
      ...(validation.document.semanticOverrides ?? {}),
    },
    hud: {
      ...resolvedBaseHud,
      ...(validation.document.hud ?? {}),
    },
  };
}

export function customThemeToThemeDocument(theme: CustomTheme): ThemeDocumentV4 {
  const result = migrateThemeDocument(theme);
  if (!result.ok) throw new ThemeDocumentError(result.error);
  return result.document;
}

export function themeDocumentToCustomTheme(document: ThemeDocumentV4): LegacyCustomTheme {
  const resolved = resolveThemeDocument(document);
  return {
    version: 3,
    id: document.id,
    name: document.name,
    tokens: resolved.tokens,
    hud: resolved.hud,
    motion: document.motion,
  };
}

export const themeDocumentFromCustomTheme = customThemeToThemeDocument;
export const themeDocumentToLegacyCustomTheme = themeDocumentToCustomTheme;

export function parseThemeDocument(serialized: string): ThemeDocumentV4 {
  const result = importThemeDocument(serialized);
  if (!result.ok) throw new ThemeDocumentError(result.error);
  return result.document;
}

export function serializeThemeDocument(document: ThemeDocumentV4, space = 2): string {
  const validation = validateThemeDocument(document);
  if (!validation.valid) throw new ThemeDocumentError("Invalid ThemeDocumentV4.", validation.errors);
  const indentation = Number.isInteger(space) ? Math.min(10, Math.max(0, space)) : 2;
  return JSON.stringify(validation.document, null, indentation);
}

export function roundTripThemeDocument(document: ThemeDocumentV4): ThemeDocumentV4 {
  return parseThemeDocument(serializeThemeDocument(document));
}
