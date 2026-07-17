import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  NOCTURNE_HUD_THEME_TOKENS,
  NOCTURNE_THEME_TOKENS,
  type ThemeDocumentV5,
} from "./contract";
import { createThemeDocumentV5 } from "./document";
import { validateThemePromotionFile } from "./promotion.node";
import {
  THEME_PROMOTION_EVIDENCE_KEYS,
  validateThemePromotionCandidate,
  type ThemePromotionCandidate,
  type ThemePromotionEvidence,
} from "./promotion";

const evidence = Object.fromEntries(
  THEME_PROMOTION_EVIDENCE_KEYS.map((key) => [key, `docs/screenshots/promotion/${key}.png`]),
) as ThemePromotionEvidence;

function document(): ThemeDocumentV5 {
  return createThemeDocumentV5({
    id: "custom:promotion-probe",
    name: "Promotion probe",
    base: "nocturne",
    tokens: {
      ...NOCTURNE_THEME_TOKENS,
      accent: "#123456",
      "color-accent": "#123456",
    },
    hud: NOCTURNE_HUD_THEME_TOKENS,
    motion: "soft",
  });
}

function candidate(overrides: Partial<ThemePromotionCandidate> = {}): ThemePromotionCandidate {
  return {
    document: document(),
    metadata: {
      id: "promotion-probe",
      label: "Promotion Probe",
      description: "Synthetic candidate used only by the promotion contract tests.",
      swatches: ["#123456", "#131313", "#1c1b1b", "#e5e2e1"],
    },
    evidence,
    ...overrides,
  };
}

describe("theme promotion pipeline", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("creates a deterministic complete package without registering a theme", () => {
    const result = validateThemePromotionCandidate(candidate(), { evidenceExists: () => true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package).toMatchObject({
      schemaVersion: 1,
      metadata: { id: "promotion-probe" },
      document: { version: 5, id: "custom:promotion-probe" },
      contract: {
        tokens: { accent: "#123456", "color-accent": "#123456" },
        hud: NOCTURNE_HUD_THEME_TOKENS,
        motion: "soft",
      },
    });
    expect(Object.keys(result.package.evidence)).toEqual([...THEME_PROMOTION_EVIDENCE_KEYS]);
  });

  test("rejects legacy documents and candidates identical to their base", () => {
    const legacy = { ...document(), version: 4 };
    const empty = createThemeDocumentV5({
      id: "custom:empty",
      name: "Empty",
      base: "nocturne",
      tokens: NOCTURNE_THEME_TOKENS,
      hud: NOCTURNE_HUD_THEME_TOKENS,
      motion: "soft",
    });
    const redundant = {
      ...empty,
      primitives: { "bg-base": NOCTURNE_THEME_TOKENS["bg-base"] },
    };

    expect(validateThemePromotionCandidate({ ...candidate(), document: legacy })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "invalid-document" })]),
    });
    expect(validateThemePromotionCandidate(candidate({ document: empty }))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "empty-theme" })]),
    });
    expect(validateThemePromotionCandidate(candidate({ document: redundant }))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "empty-theme" })]),
    });
  });

  test("rejects registered ids, arbitrary swatches, duplicate evidence, and missing files", () => {
    const invalid = candidate({
      metadata: {
        id: "nocturne",
        label: "Nocturne collision",
        description: "Must not replace an existing builtin through the promotion pipeline.",
        swatches: ["#abcdef", "#abcdef", "#131313", "#1c1b1b"],
      },
      evidence: { ...evidence, toast: evidence.modal },
    });
    const result = validateThemePromotionCandidate(invalid, {
      evidenceExists: (path) => !path.endsWith("reader.png"),
    });

    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "builtin-id-conflict" }),
        expect.objectContaining({ code: "invalid-swatch" }),
        expect.objectContaining({ code: "invalid-evidence" }),
        expect.objectContaining({ code: "missing-evidence" }),
      ]),
    });
  });

  test("loads a repository-local candidate and verifies real evidence files", () => {
    const root = process.cwd();
    const directory = mkdtempSync(join(root, "docs", "screenshots", ".promotion-test-"));
    temporaryDirectories.push(directory);
    const screenshotDirectory = join(directory, "promotion");
    mkdirSync(screenshotDirectory, { recursive: true });
    const localEvidence = Object.fromEntries(
      THEME_PROMOTION_EVIDENCE_KEYS.map((key) => {
        const path = join(screenshotDirectory, `${key}.png`);
        writeFileSync(path, "test-only");
        return [key, relative(root, path).replaceAll("\\", "/")];
      }),
    ) as ThemePromotionEvidence;
    const candidatePath = join(directory, "candidate.json");
    writeFileSync(candidatePath, JSON.stringify(candidate({ evidence: localEvidence })));

    const result = validateThemePromotionFile(relative(root, candidatePath), root);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.package.metadata.id).toBe("promotion-probe");
  });
});
