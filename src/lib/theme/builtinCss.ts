import {
  BUILTIN_THEMES,
  BUILTIN_THEME_CONTRACTS,
  HUD_THEME_TOKEN_KEYS,
  THEME_MOTION_PROPERTY_KEYS,
  THEME_MOTION_VARS,
  THEME_TOKEN_KEYS,
} from "./contract";

export const BUILTIN_THEME_CSS_HEADER =
  "/* Generated from src/lib/theme/contract.ts. Run pnpm theme:generate-builtins. */";

export function renderBuiltinThemesCss(): string {
  const blocks = BUILTIN_THEMES.map(({ id }) => {
    const contract = BUILTIN_THEME_CONTRACTS[id];
    const declarations = [
      ...THEME_TOKEN_KEYS.map((key) => `  --${key}: ${contract.tokens[key]};`),
      ...HUD_THEME_TOKEN_KEYS.map((key) => `  --${key}: ${contract.hud[key]};`),
      ...THEME_MOTION_PROPERTY_KEYS.map(
        (key) => `  ${key}: ${THEME_MOTION_VARS[contract.motion][key]};`,
      ),
    ];
    return [`[data-theme="${id}"] {`, ...declarations, "}"].join("\n");
  });

  return `${BUILTIN_THEME_CSS_HEADER}\n\n${blocks.join("\n\n")}\n`;
}
