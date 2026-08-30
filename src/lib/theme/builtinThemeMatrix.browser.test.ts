import { commands, page } from "@vitest/browser/context";
import { describe, expect, test } from "vitest";
import {
  BUILTIN_THEMES,
  BUILTIN_THEME_CONTRACTS,
  HUD_THEME_TOKEN_KEYS,
  THEME_MOTION_VARS,
  THEME_TOKEN_KEYS,
  type HudThemeTokens,
} from "./contract";
import {
  applyCustomTheme,
  clearCustomThemeProperties,
  getBuiltinExactThemePropertyNames,
} from "./provider";

type Rgba = [number, number, number, number];

const surfaceTokens = [
  "--color-background",
  "--color-card",
  "--color-modal",
  "--component-card-bg",
  "--component-menu-bg",
  "--component-button-bg",
  "--component-input-bg",
  "--component-toast-bg",
  "--component-settings-card-bg",
] as const;

const textPairs = [
  ["--text-primary", "--color-background"],
  ["--text-secondary", "--color-background"],
  ["--text-primary", "--color-card"],
  ["--text-primary", "--component-button-bg"],
  ["--component-input-fg", "--component-input-bg"],
  ["--component-toast-title-fg", "--component-toast-bg"],
] as const;

function parseRgba(value: string): Rgba {
  const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  const srgb = value.match(/^color\(srgb\s+([^)]*)\)$/i);
  if (srgb) {
    const parts = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number);
    return [parts[0] * 255, parts[1] * 255, parts[2] * 255, parts[3] ?? 1];
  }
  throw new Error(`Unsupported computed color: ${value}`);
}

function composite(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  return [
    (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
    alpha,
  ];
}

function luminance(color: Rgba): number {
  const [red, green, blue] = color.slice(0, 3).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(foreground: Rgba, background: Rgba): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function computedTokenColor(token: string, property: "color" | "backgroundColor"): Rgba {
  const probe = document.createElement("div");
  probe.style[property] = `var(${token})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe)[property];
  probe.remove();
  return parseRgba(value);
}

function isPainted(token: string): boolean {
  const probe = document.createElement("div");
  probe.style.background = `var(${token})`;
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const painted = style.backgroundImage !== "none"
    || (style.backgroundColor !== "" && style.backgroundColor !== "rgba(0, 0, 0, 0)");
  probe.remove();
  return painted;
}

function computedPaint(token: string): string {
  const probe = document.createElement("div");
  probe.style.background = `var(${token})`;
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const value = `${style.backgroundColor}|${style.backgroundImage}`;
  probe.remove();
  return value;
}

function normalizedColor(value: string): string {
  const probe = document.createElement("div");
  probe.style.color = value;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed;
}

const hudColorTokens = new Set<keyof HudThemeTokens>([
  "hud-selection-bg",
  "hud-selection-border",
]);
const hudOpacityTokens = new Set<keyof HudThemeTokens>([
  "hud-surface-opacity",
  "hud-reader-chrome-opacity",
]);

function normalizedHudValue(token: keyof HudThemeTokens, value: string): string {
  const probe = document.createElement("div");
  if (hudColorTokens.has(token)) probe.style.color = value;
  else if (hudOpacityTokens.has(token)) probe.style.opacity = value;
  else probe.style.width = value;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe);
  const result = hudColorTokens.has(token)
    ? computed.color
    : hudOpacityTokens.has(token)
      ? computed.opacity
      : computed.width;
  probe.remove();
  return result;
}

describe("builtin theme matrix", () => {
  test("keeps empty custom V5 documents computed-equivalent to every builtin base", async () => {
    const root = document.documentElement;

    try {
      for (const theme of BUILTIN_THEMES) {
        clearCustomThemeProperties(root);
        root.dataset.theme = theme.id;
        await new Promise(requestAnimationFrame);
        const exactProperties = getBuiltinExactThemePropertyNames(root);
        const builtinExact = new Map(exactProperties.map((token) => [token, getComputedStyle(root).getPropertyValue(token).trim()]));
        const builtinSurfaces = new Map(surfaceTokens.map((token) => [token, computedPaint(token)]));

        expect(applyCustomTheme(root, {
          version: 5,
          id: `custom:empty-${theme.id}`,
          name: `Empty ${theme.label}`,
          base: theme.id,
          primitives: {},
          motion: BUILTIN_THEME_CONTRACTS[theme.id].motion,
        })).toBe(true);
        await new Promise(requestAnimationFrame);

        for (const [token, value] of builtinExact) {
          expect(getComputedStyle(root).getPropertyValue(token).trim(), `${theme.id} ${token}`).toBe(value);
        }
        for (const [token, value] of builtinSurfaces) {
          expect(computedPaint(token), `${theme.id} ${token}`).toBe(value);
        }
      }
    } finally {
      clearCustomThemeProperties(root);
    }
  });

  test("matches every authored builtin contract to the computed CSS cascade", async () => {
    const root = document.documentElement;

    for (const theme of BUILTIN_THEMES) {
      root.dataset.theme = theme.id;
      root.removeAttribute("data-custom-theme");
      await new Promise(requestAnimationFrame);
      const contract = BUILTIN_THEME_CONTRACTS[theme.id];

      for (const token of THEME_TOKEN_KEYS) {
        expect(
          normalizedColor(`var(--${token})`),
          `${theme.id} --${token}`,
        ).toBe(normalizedColor(contract.tokens[token]));
      }
      for (const token of HUD_THEME_TOKEN_KEYS) {
        expect(
          normalizedHudValue(token, `var(--${token})`),
          `${theme.id} --${token}`,
        ).toBe(normalizedHudValue(token, contract.hud[token]));
      }
      const rootStyle = getComputedStyle(root);
      for (const [property, value] of Object.entries(THEME_MOTION_VARS[contract.motion])) {
        expect(rootStyle.getPropertyValue(property).trim(), `${theme.id} ${property}`).toBe(value);
      }
    }
  });

  test("resolves representative surfaces and AA text pairs for every registered builtin", async () => {
    const root = document.documentElement;

    for (const theme of BUILTIN_THEMES) {
      root.dataset.theme = theme.id;
      root.removeAttribute("data-custom-theme");
      await new Promise(requestAnimationFrame);

      for (const token of surfaceTokens) {
        expect(isPainted(token), `${theme.id} ${token} should paint`).toBe(true);
      }

      for (const [foregroundToken, backgroundToken] of textPairs) {
        const canvas = computedTokenColor("--color-background", "backgroundColor");
        const background = composite(computedTokenColor(backgroundToken, "backgroundColor"), canvas);
        const foreground = composite(computedTokenColor(foregroundToken, "color"), background);
        expect(
          contrast(foreground, background),
          `${theme.id} ${foregroundToken} on ${backgroundToken} should meet WCAG AA`,
        ).toBeGreaterThanOrEqual(4.5);
      }

      if (theme.id === "amoled") {
        const background = computedTokenColor("--color-background", "backgroundColor");
        const controlBorder = computedTokenColor("--color-border", "backgroundColor");
        const focusBorder = computedTokenColor("--color-outline", "backgroundColor");
        expect(contrast(controlBorder, background), "AMOLED quiet control boundaries").toBeLessThan(2);
        expect(contrast(focusBorder, background), "AMOLED visible focus").toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("captures browser evidence for every registered builtin surface palette", async () => {
    for (const theme of BUILTIN_THEMES) {
      document.body.innerHTML = "";
      document.documentElement.dataset.theme = theme.id;
      document.documentElement.removeAttribute("data-custom-theme");

      const frame = document.createElement("section");
      frame.setAttribute("aria-label", `${theme.label} builtin theme sample`);
      frame.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 14px;
        width: 960px;
        min-height: 520px;
        padding: 24px;
        color: var(--text-primary);
        background: var(--color-background);
        font: 13px/1.4 system-ui, sans-serif;
      `;
      frame.innerHTML = `
        <header style="display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid var(--color-divider)">
          <div><strong style="display:block;font-size:18px">${theme.label}</strong><span style="color:var(--text-muted)">${theme.description}</span></div>
          <nav style="display:flex;gap:6px"><span style="padding:6px 10px;border-radius:var(--hud-control-radius);background:var(--hud-selection-bg);color:var(--accent-fg)">Biblioteca</span><span style="padding:6px 10px;color:var(--text-muted)">Descobrir</span></nav>
        </header>
        <div style="display:grid;grid-template-columns:1.35fr .65fr;gap:14px;flex:1">
          <main style="display:grid;align-content:start;gap:12px">
            <label style="height:var(--hud-control-height);display:flex;align-items:center;gap:8px;padding:0 11px;border:1px solid var(--component-input-border);border-radius:var(--hud-control-radius);background:var(--component-input-bg);color:var(--text-muted)">⌕ <span>Buscar na biblioteca</span></label>
            <article style="padding:14px;border:1px solid var(--component-card-border);border-radius:var(--radius-card);background:var(--component-card-bg);box-shadow:var(--component-card-shadow)">
              <div style="display:flex;justify-content:space-between;align-items:start;gap:12px"><div><strong style="font-size:15px">Coleção recente</strong><p style="margin:4px 0 0;color:var(--text-muted)">Superfície elevada sem competir com o conteúdo.</p></div><span style="color:var(--accent-fg)">12 itens</span></div>
              <div style="display:flex;gap:8px;margin-top:14px"><button style="height:var(--hud-control-height);padding:0 12px;border:1px solid var(--component-button-border);border-radius:var(--hud-control-radius);background:var(--component-button-bg);color:var(--text-primary)">Abrir</button><button style="height:var(--hud-control-height);padding:0 12px;border:1px solid var(--color-outline);border-radius:var(--hud-control-radius);background:var(--hud-selection-bg);color:var(--accent-fg);box-shadow:var(--shadow-focus)">Em foco</button><button disabled style="height:var(--hud-control-height);padding:0 12px;border:1px solid var(--component-button-border);border-radius:var(--hud-control-radius);background:var(--component-button-bg);color:var(--text-disabled)">Indisponível</button></div>
            </article>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
              <div style="padding:10px;border-left:2px solid var(--color-success);background:var(--color-success-bg)"><strong>Sucesso</strong><div style="color:var(--text-muted)">Sincronizado</div></div>
              <div style="padding:10px;border-left:2px solid var(--color-warning);background:var(--color-warning-bg)"><strong>Aviso</strong><div style="color:var(--text-muted)">Atenção</div></div>
              <div style="padding:10px;border-left:2px solid var(--color-danger);background:var(--color-danger-bg)"><strong>Erro</strong><div style="color:var(--text-muted)">Falhou</div></div>
              <div style="padding:10px;border-left:2px solid var(--color-info);background:var(--color-info-bg)"><strong>Info</strong><div style="color:var(--text-muted)">Atualizado</div></div>
            </div>
          </main>
          <aside style="display:grid;align-content:start;gap:12px">
            <section style="padding:12px;border:1px solid var(--component-menu-border);border-radius:var(--component-menu-radius);background:var(--component-menu-bg);box-shadow:var(--component-menu-shadow)"><strong>Ordenar por</strong><div style="margin-top:8px;padding:7px 8px;border-radius:var(--hud-control-radius);background:var(--hud-selection-bg);color:var(--accent-fg)">Mais recentes</div><div style="padding:7px 8px;color:var(--text-secondary)">Título</div><div style="padding:7px 8px;color:var(--text-secondary)">Progresso</div></section>
            <section style="padding:12px;border:1px solid var(--component-modal-border);border-radius:var(--component-modal-radius);background:var(--component-modal-bg);box-shadow:var(--component-modal-shadow)"><strong>Confirmar ação</strong><p style="margin:5px 0 10px;color:var(--text-muted)">Exemplo compacto de modal.</p><button style="height:var(--hud-control-height);padding:0 11px;border:1px solid var(--component-button-border);border-radius:var(--hud-control-radius);background:var(--component-button-bg);color:var(--text-primary)">Confirmar</button></section>
          </aside>
        </div>
        <div style="height:var(--hud-progress-height);border-radius:9999px;background:var(--bg-subtle);overflow:hidden"><div style="width:62%;height:100%;background:var(--accent)"></div></div>
        <div style="display:flex;align-items:center;gap:10px;min-height:58px;padding:10px 12px;border:1px solid var(--component-toast-border);border-radius:var(--component-toast-radius);background:var(--component-toast-bg);box-shadow:var(--component-toast-shadow)"><span style="color:var(--color-success)">✓</span><div><strong style="display:block">Biblioteca atualizada</strong><span style="color:var(--text-muted)">As informações foram sincronizadas.</span></div></div>
      `;
      document.body.appendChild(frame);
      await new Promise(requestAnimationFrame);
      const screenshot = await page.screenshot({ base64: true });
      await commands.writeFile(
        `../../../docs/screenshots/marco44-builtin-matrix/${theme.id}.png`,
        screenshot.base64,
        "base64",
      );
    }
    expect(BUILTIN_THEMES).toHaveLength(8);
  });
});
