import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import es from "../../../messages/es.json";
import ja from "../../../messages/ja.json";
import ptBr from "../../../messages/pt-BR.json";
import zhCn from "../../../messages/zh-CN.json";

const syncdSources = [
  "src/components/settings/SyncdConnectionPanel.svelte",
  "src/components/settings/SyncdSessionDetails.svelte",
];
const syncdSettingsLauncherKeys = [
  "settings_inline_desktopSyncPairingHint",
  "settings_inline_desktopSyncTrustHint",
  "common_close",
  "ui_manage",
];

const localizedCatalogs = { es, ja, "pt-BR": ptBr, "zh-CN": zhCn } as const;
const englishCatalog = en as Record<string, string>;

// The manual-origin example is intentionally language-neutral and appears
// only inside the advanced Options view.
const englishCopyAllowlist = new Set([
  "ui_https1921681254777",
  "syncd_modal_host",
  "syncd_status_offline",
]);
const internalDetailAllowlist = new Set(["ui_https1921681254777"]);
const preservedTechnicalTerms = ["Epigraph", "QR", "TLS", "mDNS", "URL", "ID", "TTL"];
const internalDetailPattern = /(?:https?:\/\/|127\.0\.0\.1|localhost|serverId|profileId|pairingSessionId|tlsCertSha256|bootstrapBundle)/i;

function placeholders(value: string): string[] {
  return value.match(/\{[^{}]+\}/g) ?? [];
}

function activeSyncdMessageKeys(): string[] {
  const source = syncdSources
    .map((file) => readFileSync(resolve(file), "utf8"))
    .join("\n");
  const literalKeys = [...source.matchAll(/\$_\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
  const dynamicStatusKeys = Object.keys(englishCatalog).filter((key) => key.startsWith("syncd_status_"));

  return [...new Set([
    ...literalKeys,
    ...syncdSettingsLauncherKeys,
    ...dynamicStatusKeys,
  ])].sort();
}

describe("active Syncd translations", () => {
  it("derives the active message contract from the rendered Syncd surfaces", () => {
    const keys = activeSyncdMessageKeys();

    const settingsSource = readFileSync(resolve("src/components/settings/Settings.svelte"), "utf8");

    expect(keys).toHaveLength(116);
    expect(keys).toContain("settings_inline_desktopSyncPairing");
    expect(keys).toContain("settings_inline_connecting");
    expect(keys).toContain("syncd_status_tls_mismatch");
    for (const key of syncdSettingsLauncherKeys) {
      expect(settingsSource).toContain(`\"${key}\"`);
    }
  });

  it("keeps keys and placeholders aligned in every localized catalog", () => {
    for (const [locale, catalog] of Object.entries(localizedCatalogs)) {
      for (const key of activeSyncdMessageKeys()) {
        const localized = (catalog as Record<string, string>)[key];
        expect(localized, `${locale}:${key}`).toBeTypeOf("string");
        expect(placeholders(localized), `${locale}:${key}`).toEqual(placeholders(englishCatalog[key]));
      }
    }
  });

  it("does not ship complete English copies outside the narrow allowlist", () => {
    for (const [locale, catalog] of Object.entries(localizedCatalogs)) {
      for (const key of activeSyncdMessageKeys()) {
        if (englishCopyAllowlist.has(key)) continue;
        expect((catalog as Record<string, string>)[key], `${locale}:${key}`).not.toBe(englishCatalog[key]);
      }
    }
  });

  it("preserves technical terms that are part of the source message", () => {
    for (const [locale, catalog] of Object.entries(localizedCatalogs)) {
      for (const key of activeSyncdMessageKeys()) {
        for (const term of preservedTechnicalTerms) {
          if (!englishCatalog[key].includes(term)) continue;
          expect((catalog as Record<string, string>)[key], `${locale}:${key}`).toContain(term);
        }
      }
    }
  });

  it("does not expose internal identifiers or endpoints as ordinary localized copy", () => {
    for (const [locale, catalog] of Object.entries(localizedCatalogs)) {
      for (const key of activeSyncdMessageKeys()) {
        if (internalDetailAllowlist.has(key)) continue;
        expect((catalog as Record<string, string>)[key], `${locale}:${key}`).not.toMatch(internalDetailPattern);
      }
    }
  });
});
