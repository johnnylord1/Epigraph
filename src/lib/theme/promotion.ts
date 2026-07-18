import {
  BUILTIN_THEME_IDS,
  HUD_THEME_TOKEN_KEYS,
  THEME_TOKEN_KEYS,
  getBuiltinThemeFallbackContract,
  type BuiltinThemeContract,
  type ThemeDocumentV5,
} from "./contract";
import { resolveThemeDocument, validateThemeDocument } from "./document";
import { HUD_RUNTIME_ACTIVE_TOKEN_KEYS } from "./hudOwnership";

export const THEME_PROMOTION_EVIDENCE_KEYS = [
  "library",
  "browse",
  "settings",
  "reader",
  "modal",
  "popover",
  "toast",
] as const;

export type ThemePromotionEvidenceKey = (typeof THEME_PROMOTION_EVIDENCE_KEYS)[number];

export interface ThemePromotionMetadata {
  id: string;
  label: string;
  description: string;
  swatches: readonly [string, string, string, string];
}

export type ThemePromotionEvidence = Record<ThemePromotionEvidenceKey, string>;

export interface ThemePromotionCandidate {
  document: ThemeDocumentV5;
  metadata: ThemePromotionMetadata;
  evidence: ThemePromotionEvidence;
}

export interface ThemePromotionPackage {
  schemaVersion: 1;
  metadata: ThemePromotionMetadata;
  document: ThemeDocumentV5;
  contract: BuiltinThemeContract;
  evidence: ThemePromotionEvidence;
}

export type ThemePromotionErrorCode =
  | "invalid-input"
  | "unknown-key"
  | "invalid-document"
  | "invalid-metadata"
  | "builtin-id-conflict"
  | "empty-theme"
  | "invalid-swatch"
  | "invalid-evidence"
  | "missing-evidence";

export interface ThemePromotionError {
  code: ThemePromotionErrorCode;
  path: string;
  message: string;
}

export type ThemePromotionResult =
  | { ok: true; package: ThemePromotionPackage; errors: [] }
  | { ok: false; errors: ThemePromotionError[] };

export interface ThemePromotionValidationOptions {
  evidenceExists?: (relativePath: string) => boolean;
}

const CANDIDATE_KEYS = new Set(["document", "metadata", "evidence"]);
const METADATA_KEYS = new Set(["id", "label", "description", "swatches"]);
const EVIDENCE_KEYS = new Set<string>(THEME_PROMOTION_EVIDENCE_KEYS);
const BUILTIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HEX_SWATCH_PATTERN = /^#[0-9a-f]{6}$/i;
const EVIDENCE_PATH_PATTERN = /^docs\/screenshots\/[A-Za-z0-9._/-]+\.png$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addError(
  errors: ThemePromotionError[],
  code: ThemePromotionErrorCode,
  path: string,
  message: string,
): void {
  errors.push({ code, path, message });
}

function validateKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  errors: ThemePromotionError[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addError(errors, "unknown-key", `${path}.${key}`, `Unknown key "${key}".`);
  }
}

function validateMetadata(
  value: unknown,
  resolvedValues: ReadonlySet<string>,
  errors: ThemePromotionError[],
): ThemePromotionMetadata | undefined {
  if (!isRecord(value)) {
    addError(errors, "invalid-metadata", "$.metadata", "Promotion metadata must be an object.");
    return undefined;
  }
  validateKnownKeys(value, METADATA_KEYS, "$.metadata", errors);

  if (typeof value.id !== "string" || !BUILTIN_ID_PATTERN.test(value.id)) {
    addError(errors, "invalid-metadata", "$.metadata.id", "Builtin id must be a lowercase kebab-case slug.");
  } else if ((BUILTIN_THEME_IDS as readonly string[]).includes(value.id)) {
    addError(errors, "builtin-id-conflict", "$.metadata.id", `Builtin id "${value.id}" is already registered.`);
  }
  if (
    typeof value.label !== "string"
    || value.label.trim() !== value.label
    || value.label.length === 0
    || value.label.length > 40
  ) {
    addError(errors, "invalid-metadata", "$.metadata.label", "Label must be trimmed and contain 1 to 40 characters.");
  }
  if (
    typeof value.description !== "string"
    || value.description.trim() !== value.description
    || value.description.length === 0
    || value.description.length > 120
  ) {
    addError(errors, "invalid-metadata", "$.metadata.description", "Description must be trimmed and contain 1 to 120 characters.");
  }

  if (!Array.isArray(value.swatches) || value.swatches.length !== 4) {
    addError(errors, "invalid-swatch", "$.metadata.swatches", "Exactly four static color swatches are required.");
  } else {
    for (const [index, swatch] of value.swatches.entries()) {
      if (typeof swatch !== "string" || !HEX_SWATCH_PATTERN.test(swatch)) {
        addError(errors, "invalid-swatch", `$.metadata.swatches[${index}]`, "Swatches must use six-digit hex colors.");
      } else if (!resolvedValues.has(swatch.toLowerCase())) {
        addError(errors, "invalid-swatch", `$.metadata.swatches[${index}]`, "Swatches must come from the resolved theme contract.");
      }
    }
    if (new Set(value.swatches.map((swatch) => String(swatch).toLowerCase())).size !== 4) {
      addError(errors, "invalid-swatch", "$.metadata.swatches", "Promotion swatches must be unique.");
    }
  }

  if (errors.some((error) => error.path.startsWith("$.metadata"))) return undefined;
  return {
    id: value.id as string,
    label: value.label as string,
    description: value.description as string,
    swatches: (value.swatches as string[]).map((swatch) => swatch.toLowerCase()) as unknown as ThemePromotionMetadata["swatches"],
  };
}

function validateEvidence(
  value: unknown,
  evidenceExists: ((relativePath: string) => boolean) | undefined,
  errors: ThemePromotionError[],
): ThemePromotionEvidence | undefined {
  if (!isRecord(value)) {
    addError(errors, "invalid-evidence", "$.evidence", "Promotion evidence must be an object.");
    return undefined;
  }
  validateKnownKeys(value, EVIDENCE_KEYS, "$.evidence", errors);
  const result = {} as ThemePromotionEvidence;
  const seen = new Set<string>();

  for (const key of THEME_PROMOTION_EVIDENCE_KEYS) {
    const raw = value[key];
    if (typeof raw !== "string") {
      addError(errors, "missing-evidence", `$.evidence.${key}`, `A ${key} screenshot is required.`);
      continue;
    }
    const path = raw.replaceAll("\\", "/");
    if (
      !EVIDENCE_PATH_PATTERN.test(path)
      || path.includes("../")
      || path.includes("//")
      || path.startsWith("/")
    ) {
      addError(errors, "invalid-evidence", `$.evidence.${key}`, "Evidence must be a repository-relative PNG under docs/screenshots/.");
      continue;
    }
    if (seen.has(path)) {
      addError(errors, "invalid-evidence", `$.evidence.${key}`, "Each required surface needs a distinct screenshot.");
      continue;
    }
    if (evidenceExists && !evidenceExists(path)) {
      addError(errors, "missing-evidence", `$.evidence.${key}`, `Screenshot does not exist: ${path}.`);
      continue;
    }
    seen.add(path);
    result[key] = path;
  }

  if (errors.some((error) => error.path.startsWith("$.evidence"))) return undefined;
  return result;
}

function hasResolvedDifference(
  document: ThemeDocumentV5,
  resolved: Pick<BuiltinThemeContract, "tokens" | "hud">,
): boolean {
  const base = getBuiltinThemeFallbackContract(document.base);
  return document.motion !== base.motion
    || THEME_TOKEN_KEYS.some((token) => resolved.tokens[token] !== base.tokens[token])
    || HUD_RUNTIME_ACTIVE_TOKEN_KEYS.some((token) => resolved.hud[token] !== base.hud[token]);
}

export function validateThemePromotionCandidate(
  input: unknown,
  options: ThemePromotionValidationOptions = {},
): ThemePromotionResult {
  const errors: ThemePromotionError[] = [];
  if (!isRecord(input)) {
    addError(errors, "invalid-input", "$", "Theme promotion candidate must be an object.");
    return { ok: false, errors };
  }
  validateKnownKeys(input, CANDIDATE_KEYS, "$", errors);

  const documentValidation = validateThemeDocument(input.document);
  if (!documentValidation.valid) {
    for (const error of documentValidation.errors) {
      addError(errors, "invalid-document", `$.document${error.path.slice(1)}`, error.message);
    }
    return { ok: false, errors };
  }
  const document = documentValidation.document;
  const resolved = resolveThemeDocument(document);
  if (!hasResolvedDifference(document, resolved)) {
    addError(errors, "empty-theme", "$.document", "A promotion candidate must differ from its builtin base.");
  }

  const resolvedValues = new Set(Object.values(resolved.tokens).map((value) => value.toLowerCase()));
  const metadata = validateMetadata(input.metadata, resolvedValues, errors);
  const evidence = validateEvidence(input.evidence, options.evidenceExists, errors);

  if (Object.keys(resolved.tokens).length !== THEME_TOKEN_KEYS.length) {
    addError(errors, "invalid-document", "$.document", "Resolved theme token contract is incomplete.");
  }
  if (Object.keys(resolved.hud).length !== HUD_THEME_TOKEN_KEYS.length) {
    addError(errors, "invalid-document", "$.document.hud", "Resolved HUD token contract is incomplete.");
  }
  if (errors.length > 0 || !metadata || !evidence) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    package: {
      schemaVersion: 1,
      metadata,
      document,
      contract: { tokens: resolved.tokens, hud: resolved.hud, motion: document.motion },
      evidence,
    },
  };
}
