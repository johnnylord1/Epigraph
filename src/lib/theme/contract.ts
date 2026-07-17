export const BUILTIN_THEME_IDS = [
  "nocturne",
  "dark",
  "amoled",
  "high-contrast",
  "light",
  "light-contrast",
  "midnight",
  "warm",
] as const;

export type BuiltinTheme = (typeof BUILTIN_THEME_IDS)[number];
export type Theme = BuiltinTheme | string;
export type ThemeMotionPreset = "minimal" | "soft" | "expressive";
export const DEFAULT_BUILTIN_THEME_ID: BuiltinTheme = "nocturne";

export interface ThemeTokens {
  "bg-void": string;
  "bg-base": string;
  "bg-surface": string;
  "bg-raised": string;
  "bg-overlay": string;
  "bg-subtle": string;
  "border-dim": string;
  "border-base": string;
  "border-strong": string;
  "border-focus": string;
  "text-primary": string;
  "text-secondary": string;
  "text-muted": string;
  "text-faint": string;
  "text-disabled": string;
  "text-tertiary": string;
  "text-inverse": string;
  "accent": string;
  "accent-dim": string;
  "accent-muted": string;
  "accent-fg": string;
  "accent-bright": string;
  "color-error": string;
  "color-error-bg": string;
  "color-success": string;
  "color-success-bg": string;
  "color-warning": string;
  "color-warning-bg": string;
  "color-danger": string;
  "color-danger-bg": string;
  "color-info": string;
  "color-info-bg": string;
  "color-background": string;
  "color-background-void": string;
  "color-surface": string;
  "color-surface-secondary": string;
  "color-elevated": string;
  "color-card": string;
  "color-modal": string;
  "color-popover": string;
  "color-menu": string;
  "color-overlay": string;
  "color-border": string;
  "color-outline": string;
  "color-divider": string;
  "color-accent": string;
  "color-accent-muted": string;
  "color-shadow-source": string;
  "color-highlight-source": string;
}

export interface HudThemeTokens {
  "hud-control-height": string;
  "hud-icon-button-size": string;
  "hud-control-radius": string;
  "hud-chip-radius": string;
  "hud-popover-radius": string;
  "hud-status-radius": string;
  "hud-toast-radius": string;
  "hud-chapter-row-radius": string;
  "hud-surface-opacity": string;
  "hud-sidebar-width": string;
  "hud-toolbar-gap": string;
  "hud-reader-chrome-opacity": string;
  "hud-selection-bg": string;
  "hud-selection-border": string;
  "hud-progress-height": string;
}

export interface LegacyCustomTheme {
  id: string;
  name: string;
  tokens: ThemeTokens;
  version?: 1 | 2 | 3;
  hud?: Partial<HudThemeTokens>;
  motion?: ThemeMotionPreset;
  description?: string;
  preview?: string;
}

export type ThemePrimitiveTokens = Partial<Pick<ThemeTokens,
  | "bg-void" | "bg-base" | "bg-surface" | "bg-raised" | "bg-overlay" | "bg-subtle"
  | "border-dim" | "border-base" | "border-strong" | "border-focus"
  | "text-primary" | "text-secondary" | "text-muted" | "text-faint" | "text-disabled" | "text-tertiary" | "text-inverse"
  | "accent" | "accent-dim" | "accent-muted" | "accent-fg" | "accent-bright"
>>;

export type ThemeSemanticTokens = Pick<ThemeTokens,
  | "color-error" | "color-error-bg" | "color-success" | "color-success-bg"
  | "color-warning" | "color-warning-bg" | "color-danger" | "color-danger-bg"
  | "color-info" | "color-info-bg" | "color-background" | "color-background-void"
  | "color-surface" | "color-surface-secondary" | "color-elevated" | "color-card"
  | "color-modal" | "color-popover" | "color-menu" | "color-overlay"
  | "color-border" | "color-outline" | "color-divider" | "color-accent" | "color-accent-muted"
  | "color-shadow-source" | "color-highlight-source"
>;

export interface ThemeDocumentV4 {
  version: 4;
  id: `custom:${string}`;
  name: string;
  base: BuiltinTheme;
  primitives: ThemePrimitiveTokens;
  semanticOverrides?: Partial<ThemeSemanticTokens>;
  hud?: Partial<HudThemeTokens>;
  motion: ThemeMotionPreset;
}

export interface ThemeDocumentV5 {
  version: 5;
  id: `custom:${string}`;
  name: string;
  base: BuiltinTheme;
  primitives: ThemePrimitiveTokens;
  semanticOverrides?: Partial<ThemeSemanticTokens>;
  hud?: Partial<HudThemeTokens>;
  motion: ThemeMotionPreset;
}

export type CustomTheme = LegacyCustomTheme | ThemeDocumentV4 | ThemeDocumentV5;

export interface BuiltinThemeMetadata {
  id: BuiltinTheme;
  label: string;
  description: string;
  swatches: readonly [string, string, string, string];
}

export const BUILTIN_THEMES: readonly BuiltinThemeMetadata[] = [
  { id: "nocturne", label: "Nocturne", description: "Default lunar graphite HUD", swatches: ["#080813", "#0d0d1b", "#8f82e6", "#f1eefc"] },
  { id: "dark", label: "Dark", description: "Neutral graphite with neon violet accents", swatches: ["#0a0a0b", "#17171a", "#9d7cff", "#f2eff7"] },
  { id: "amoled", label: "AMOLED", description: "True black with neon violet accents", swatches: ["#000000", "#000000", "#b36dff", "#f7f2ff"] },
  { id: "high-contrast", label: "High Contrast", description: "True black, sharper text and violet focus", swatches: ["#080808", "#111111", "#b89cff", "#ffffff"] },
  { id: "light", label: "Light", description: "Warm off-white with violet accents", swatches: ["#f4f2ee", "#faf8f4", "#6d3bd1", "#1a1916"] },
  { id: "light-contrast", label: "Light Contrast", description: "Light with maximum contrast and violet focus", swatches: ["#ece8e2", "#f5f2ec", "#4d158f", "#080806"] },
  { id: "midnight", label: "Midnight", description: "Deep blue-black tint", swatches: ["#0c1020", "#101428", "#a8b4e8", "#eeeef8"] },
  { id: "warm", label: "Warm", description: "Amber and sepia tones", swatches: ["#16130c", "#1c1810", "#e0b860", "#f5f0e0"] },
] as const;

export const THEME_TOKEN_KEYS = [
  "bg-void", "bg-base", "bg-surface", "bg-raised", "bg-overlay", "bg-subtle",
  "border-dim", "border-base", "border-strong", "border-focus",
  "text-primary", "text-secondary", "text-muted", "text-faint", "text-disabled", "text-tertiary", "text-inverse",
  "accent", "accent-dim", "accent-muted", "accent-fg", "accent-bright",
  "color-error", "color-error-bg", "color-success", "color-success-bg", "color-warning", "color-warning-bg",
  "color-danger", "color-danger-bg", "color-info", "color-info-bg", "color-background", "color-background-void",
  "color-surface", "color-surface-secondary", "color-elevated", "color-card", "color-modal", "color-popover",
  "color-menu", "color-overlay", "color-border", "color-outline", "color-divider", "color-accent", "color-accent-muted",
  "color-shadow-source", "color-highlight-source",
] as const satisfies readonly (keyof ThemeTokens)[];

export const THEME_PRIMITIVE_TOKEN_KEYS = [
  "bg-void", "bg-base", "bg-surface", "bg-raised", "bg-overlay", "bg-subtle",
  "border-dim", "border-base", "border-strong", "border-focus",
  "text-primary", "text-secondary", "text-muted", "text-faint", "text-disabled", "text-tertiary", "text-inverse",
  "accent", "accent-dim", "accent-muted", "accent-fg", "accent-bright",
] as const satisfies readonly (keyof ThemePrimitiveTokens)[];

export const THEME_SEMANTIC_TOKEN_KEYS = [
  "color-error", "color-error-bg", "color-success", "color-success-bg", "color-warning", "color-warning-bg",
  "color-danger", "color-danger-bg", "color-info", "color-info-bg", "color-background", "color-background-void",
  "color-surface", "color-surface-secondary", "color-elevated", "color-card", "color-modal", "color-popover",
  "color-menu", "color-overlay", "color-border", "color-outline", "color-divider", "color-accent", "color-accent-muted",
  "color-shadow-source", "color-highlight-source",
] as const satisfies readonly (keyof ThemeSemanticTokens)[];

export const HUD_THEME_TOKEN_KEYS = [
  "hud-control-height", "hud-icon-button-size", "hud-control-radius", "hud-chip-radius",
  "hud-popover-radius", "hud-status-radius", "hud-toast-radius", "hud-chapter-row-radius",
  "hud-surface-opacity", "hud-sidebar-width", "hud-toolbar-gap", "hud-reader-chrome-opacity",
  "hud-selection-bg", "hud-selection-border", "hud-progress-height",
] as const satisfies readonly (keyof HudThemeTokens)[];

export const DEFAULT_THEME_TOKENS: ThemeTokens = {
  "bg-void": "#050505", "bg-base": "#0a0a0b", "bg-surface": "#111113", "bg-raised": "#17171a", "bg-overlay": "#1d1d21", "bg-subtle": "#242429",
  "border-dim": "#1d1d22", "border-base": "#292930", "border-strong": "#3b3a45", "border-focus": "#9d7cff",
  "text-primary": "#f2eff7", "text-secondary": "#cbc6d2", "text-muted": "#918a9c", "text-faint": "#55505e", "text-disabled": "#302d36", "text-tertiary": "#918a9c", "text-inverse": "#050505",
  "accent": "#9d7cff", "accent-dim": "#4d357f", "accent-muted": "rgba(157, 124, 255, 0.14)", "accent-fg": "#efe9ff", "accent-bright": "#b79cff",
  "color-error": "#c47a7a", "color-error-bg": "#1f1212", "color-success": "#7aab7a", "color-success-bg": "rgba(122, 171, 122, 0.12)",
  "color-warning": "#c0a66a", "color-warning-bg": "rgba(192, 166, 106, 0.12)", "color-danger": "#c47a7a", "color-danger-bg": "#1f1212",
  "color-info": "#7a9ec4", "color-info-bg": "#121a1f", "color-background": "#0a0a0b", "color-background-void": "#050505",
  "color-surface": "#111113", "color-surface-secondary": "#242429", "color-elevated": "#17171a", "color-card": "#17171a",
  "color-modal": "#1d1d21", "color-popover": "#1d1d21", "color-menu": "#1d1d21", "color-overlay": "rgba(0, 0, 0, 0.68)",
  "color-border": "#292930", "color-outline": "#9d7cff", "color-divider": "#1d1d22", "color-accent": "#9d7cff", "color-accent-muted": "rgba(157, 124, 255, 0.14)",
  "color-shadow-source": "#000000", "color-highlight-source": "#ffffff",
};

export const THEME_PRIMITIVE_DERIVATIONS = {
  "text-tertiary": "text-muted",
  "text-inverse": "bg-void",
} as const satisfies Partial<Record<keyof ThemePrimitiveTokens, keyof ThemeTokens>>;

export const THEME_SEMANTIC_DERIVATIONS = {
  "color-background": "bg-base",
  "color-background-void": "bg-void",
  "color-surface": "bg-surface",
  "color-surface-secondary": "bg-subtle",
  "color-elevated": "bg-raised",
  "color-card": "bg-raised",
  "color-modal": "bg-overlay",
  "color-popover": "bg-overlay",
  "color-menu": "bg-overlay",
  "color-border": "border-base",
  "color-outline": "border-focus",
  "color-divider": "border-dim",
  "color-accent": "accent",
  "color-accent-muted": "accent-muted",
} as const satisfies Partial<Record<keyof ThemeSemanticTokens, keyof ThemePrimitiveTokens>>;

export const THEME_SEMANTIC_DEPENDENCIES = {
  "color-danger": "color-error",
  "color-danger-bg": "color-error-bg",
} as const satisfies Partial<Record<keyof ThemeSemanticTokens, keyof ThemeSemanticTokens>>;

function hasOwnToken(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function resolveThemeTokenLayers(
  base: ThemeTokens,
  primitives: ThemePrimitiveTokens = {},
  semanticOverrides: Partial<ThemeSemanticTokens> = {},
): ThemeTokens {
  const resolved: ThemeTokens = { ...base, ...primitives };

  for (const [target, source] of Object.entries(THEME_PRIMITIVE_DERIVATIONS) as [keyof ThemePrimitiveTokens, keyof ThemeTokens][]) {
    if (hasOwnToken(primitives, target)) continue;
    if (hasOwnToken(primitives, source)) resolved[target] = resolved[source];
  }
  for (const [target, source] of Object.entries(THEME_SEMANTIC_DERIVATIONS) as [keyof ThemeSemanticTokens, keyof ThemePrimitiveTokens][]) {
    if (hasOwnToken(primitives, source)) resolved[target] = resolved[source];
  }

  Object.assign(resolved, semanticOverrides);

  for (const [target, source] of Object.entries(THEME_SEMANTIC_DEPENDENCIES) as [keyof ThemeSemanticTokens, keyof ThemeSemanticTokens][]) {
    if (hasOwnToken(semanticOverrides, target)) continue;
    if (hasOwnToken(semanticOverrides, source)) resolved[target] = resolved[source];
  }
  return resolved;
}

function deriveBuiltinThemeTokens(overrides: Partial<ThemeTokens>): ThemeTokens {
  const primitives = Object.fromEntries(
    THEME_PRIMITIVE_TOKEN_KEYS
      .filter((key) => hasOwnToken(overrides, key))
      .map((key) => [key, overrides[key]]),
  ) as ThemePrimitiveTokens;
  const semanticOverrides = Object.fromEntries(
    THEME_SEMANTIC_TOKEN_KEYS
      .filter((key) => hasOwnToken(overrides, key))
      .map((key) => [key, overrides[key]]),
  ) as Partial<ThemeSemanticTokens>;
  return resolveThemeTokenLayers(DEFAULT_THEME_TOKENS, primitives, semanticOverrides);
}

export const DEFAULT_HUD_THEME_TOKENS: HudThemeTokens = {
  "hud-control-height": "30px", "hud-icon-button-size": "30px", "hud-control-radius": "5px", "hud-chip-radius": "9999px",
  "hud-popover-radius": "5px", "hud-status-radius": "3px", "hud-toast-radius": "7px", "hud-chapter-row-radius": "5px",
  "hud-surface-opacity": "1", "hud-sidebar-width": "52px", "hud-toolbar-gap": "8px", "hud-reader-chrome-opacity": "1",
  "hud-selection-bg": "rgba(157, 124, 255, 0.14)", "hud-selection-border": "#4d357f", "hud-progress-height": "3px",
};

export const NOCTURNE_THEME_TOKENS: ThemeTokens = {
  "bg-void": "#08080b", "bg-base": "#131313", "bg-surface": "#1c1b1b", "bg-raised": "#201f1f", "bg-overlay": "#2a2a2a", "bg-subtle": "#353534",
  "border-dim": "#1b1a20", "border-base": "#2a2733", "border-strong": "#48454f", "border-focus": "#8173d6",
  "text-primary": "#e5e2e1", "text-secondary": "#cac4d0", "text-muted": "rgba(202, 196, 208, 0.62)", "text-faint": "rgba(202, 196, 208, 0.38)",
  "text-disabled": "rgba(202, 196, 208, 0.24)", "text-tertiary": "rgba(202, 196, 208, 0.62)", "text-inverse": "#08080b",
  "accent": "#d3c4ff", "accent-dim": "#4f4279", "accent-muted": "rgba(184, 167, 234, 0.12)", "accent-fg": "#d7d0ff", "accent-bright": "#b8a7ea",
  "color-error": "#cf8aa0", "color-error-bg": "#24121b", "color-success": "#8acfa6", "color-success-bg": "rgba(138, 207, 166, 0.12)",
  "color-warning": "#d6c09a", "color-warning-bg": "rgba(214, 192, 154, 0.12)", "color-danger": "#cf8aa0", "color-danger-bg": "#24121b",
  "color-info": "#91a7e8", "color-info-bg": "#12172c", "color-background": "#131313", "color-background-void": "#08080b",
  "color-surface": "#1c1b1b", "color-surface-secondary": "#353534", "color-elevated": "#201f1f", "color-card": "#201f1f",
  "color-modal": "#2a2a2a", "color-popover": "#2a2a2a", "color-menu": "#2a2a2a", "color-overlay": "rgba(0, 0, 0, 0.68)",
  "color-border": "#2a2733", "color-outline": "#8173d6", "color-divider": "#1b1a20", "color-accent": "#d3c4ff", "color-accent-muted": "rgba(184, 167, 234, 0.12)",
  "color-shadow-source": "#000000", "color-highlight-source": "#ffffff",
};

export const NOCTURNE_HUD_THEME_TOKENS: HudThemeTokens = {
  "hud-control-height": "28px", "hud-icon-button-size": "28px", "hud-control-radius": "8px", "hud-chip-radius": "9999px",
  "hud-popover-radius": "12px", "hud-status-radius": "9999px", "hud-toast-radius": "12px", "hud-chapter-row-radius": "9px",
  "hud-surface-opacity": "0.96", "hud-sidebar-width": "56px", "hud-toolbar-gap": "6px", "hud-reader-chrome-opacity": "0.92",
  "hud-selection-bg": "#211b3b", "hud-selection-border": "#4c4078", "hud-progress-height": "2px",
};

function deriveBuiltinHudThemeTokens(tokens: ThemeTokens): HudThemeTokens {
  return {
    ...DEFAULT_HUD_THEME_TOKENS,
    "hud-selection-bg": tokens["accent-muted"],
    "hud-selection-border": tokens["accent-dim"],
  };
}

export interface BuiltinThemeContract {
  tokens: ThemeTokens;
  hud: HudThemeTokens;
  motion: ThemeMotionPreset;
}

const HIGH_CONTRAST_THEME_TOKENS = deriveBuiltinThemeTokens({
  "bg-void": "#000000", "bg-base": "#080808", "bg-surface": "#0d0d0d", "bg-raised": "#111111", "bg-overlay": "#171717", "bg-subtle": "#1e1e1e",
  "border-dim": "#252525", "border-base": "#303030", "border-strong": "#3e3e3e", "border-focus": "#a986ff",
  "text-primary": "#ffffff", "text-secondary": "#e8e6e0", "text-muted": "#b0aea8", "text-faint": "#6e6c68", "text-disabled": "#303030",
  "accent": "#b89cff", "accent-dim": "#5b3f91", "accent-muted": "#2a1f3f", "accent-fg": "#f0e9ff", "accent-bright": "#d0beff",
});

const AMOLED_THEME_TOKENS = deriveBuiltinThemeTokens({
  "bg-void": "#000000", "bg-base": "#000000", "bg-surface": "#000000", "bg-raised": "#000000", "bg-overlay": "#08080c", "bg-subtle": "#111117",
  "border-dim": "#242424", "border-base": "#5a5a5a", "border-strong": "#737373", "border-focus": "#b36dff",
  "text-primary": "#f7f2ff", "text-secondary": "#d8cfe4", "text-muted": "#9f94ad", "text-faint": "#7d7487", "text-disabled": "#51485b",
  "accent": "#b36dff", "accent-dim": "#623595", "accent-muted": "#241334", "accent-fg": "#f5e9ff", "accent-bright": "#d09cff",
  "color-overlay": "rgba(0, 0, 0, 0.82)",
});

const LIGHT_THEME_TOKENS = deriveBuiltinThemeTokens({
  "bg-void": "#e8e6e2", "bg-base": "#eeece8", "bg-surface": "#f4f2ee", "bg-raised": "#faf8f4", "bg-overlay": "#ffffff", "bg-subtle": "#f0ede8",
  "border-dim": "#dedad4", "border-base": "#d0ccc6", "border-strong": "#bbb6ae", "border-focus": "#7845dc",
  "text-primary": "#1a1916", "text-secondary": "#2e2c28", "text-muted": "#5a5750", "text-faint": "#9a9890", "text-disabled": "#c8c4bc",
  "accent": "#6d3bd1", "accent-dim": "#d9c9fa", "accent-muted": "#eee7ff", "accent-fg": "#4e1aa8", "accent-bright": "#7c45e8",
  "color-error": "#a03030", "color-error-bg": "#fce8e8", "color-success": "#2a6a2a", "color-info": "#2a4a7a", "color-info-bg": "#e8eef8",
});

const LIGHT_CONTRAST_THEME_TOKENS = deriveBuiltinThemeTokens({
  "bg-void": "#d8d4ce", "bg-base": "#e2deda", "bg-surface": "#ece8e2", "bg-raised": "#f5f2ec", "bg-overlay": "#ffffff", "bg-subtle": "#e4e0d8",
  "border-dim": "#c4c0b8", "border-base": "#b0aca4", "border-strong": "#989490", "border-focus": "#57209c",
  "text-primary": "#080806", "text-secondary": "#181612", "text-muted": "#38342e", "text-faint": "#706c64", "text-disabled": "#b0aca4",
  "accent": "#4d158f", "accent-dim": "#cbb2ef", "accent-muted": "#dfd0f6", "accent-fg": "#351061", "accent-bright": "#5b1eaa",
  "color-error": "#8a1a1a", "color-error-bg": "#f8e0e0",
});

const MIDNIGHT_THEME_TOKENS = deriveBuiltinThemeTokens({
  "bg-void": "#050810", "bg-base": "#080c18", "bg-surface": "#0c1020", "bg-raised": "#101428", "bg-overlay": "#151a30", "bg-subtle": "#1a2038",
  "border-dim": "#1a2035", "border-base": "#222840", "border-strong": "#2c3450", "border-focus": "#4a5c8a",
  "text-primary": "#eeeef8", "text-secondary": "#c0c4d8", "text-muted": "#808498", "text-faint": "#404860", "text-disabled": "#202840",
  "accent": "#6a7ab8", "accent-dim": "#252d50", "accent-muted": "#181e38", "accent-fg": "#a8b4e8", "accent-bright": "#8896d0",
});

const WARM_THEME_TOKENS = deriveBuiltinThemeTokens({
  "bg-void": "#0c0a06", "bg-base": "#100e08", "bg-surface": "#16130c", "bg-raised": "#1c1810", "bg-overlay": "#221e14", "bg-subtle": "#28241a",
  "border-dim": "#201c10", "border-base": "#2c2818", "border-strong": "#3a3420", "border-focus": "#6a5a30",
  "text-primary": "#f5f0e0", "text-secondary": "#d8d0b0", "text-muted": "#988c60", "text-faint": "#584e30", "text-disabled": "#302a18",
  "accent": "#c0902a", "accent-dim": "#3a2c10", "accent-muted": "#261e0c", "accent-fg": "#e0b860", "accent-bright": "#d0a040",
});

export const BUILTIN_THEME_CONTRACTS: Readonly<Record<BuiltinTheme, BuiltinThemeContract>> = {
  nocturne: { tokens: NOCTURNE_THEME_TOKENS, hud: NOCTURNE_HUD_THEME_TOKENS, motion: "soft" },
  dark: { tokens: DEFAULT_THEME_TOKENS, hud: DEFAULT_HUD_THEME_TOKENS, motion: "soft" },
  amoled: { tokens: AMOLED_THEME_TOKENS, hud: deriveBuiltinHudThemeTokens(AMOLED_THEME_TOKENS), motion: "soft" },
  "high-contrast": { tokens: HIGH_CONTRAST_THEME_TOKENS, hud: deriveBuiltinHudThemeTokens(HIGH_CONTRAST_THEME_TOKENS), motion: "soft" },
  light: { tokens: LIGHT_THEME_TOKENS, hud: deriveBuiltinHudThemeTokens(LIGHT_THEME_TOKENS), motion: "soft" },
  "light-contrast": { tokens: LIGHT_CONTRAST_THEME_TOKENS, hud: deriveBuiltinHudThemeTokens(LIGHT_CONTRAST_THEME_TOKENS), motion: "soft" },
  midnight: { tokens: MIDNIGHT_THEME_TOKENS, hud: deriveBuiltinHudThemeTokens(MIDNIGHT_THEME_TOKENS), motion: "soft" },
  warm: { tokens: WARM_THEME_TOKENS, hud: deriveBuiltinHudThemeTokens(WARM_THEME_TOKENS), motion: "soft" },
};

export const THEME_MOTION_PROPERTY_KEYS = [
  "--motion-duration-fast",
  "--motion-duration-normal",
  "--motion-duration-slow",
  "--motion-easing-standard",
  "--motion-easing-emphasized",
] as const;

export type ThemeMotionProperty = (typeof THEME_MOTION_PROPERTY_KEYS)[number];

export const THEME_MOTION_VARS: Record<ThemeMotionPreset, Record<ThemeMotionProperty, string>> = {
  minimal: {
    "--motion-duration-fast": "40ms",
    "--motion-duration-normal": "80ms",
    "--motion-duration-slow": "140ms",
    "--motion-easing-standard": "ease",
    "--motion-easing-emphasized": "ease",
  },
  soft: {
    "--motion-duration-fast": "80ms",
    "--motion-duration-normal": "140ms",
    "--motion-duration-slow": "220ms",
    "--motion-easing-standard": "ease",
    "--motion-easing-emphasized": "cubic-bezier(0.16, 1, 0.3, 1)",
  },
  expressive: {
    "--motion-duration-fast": "120ms",
    "--motion-duration-normal": "200ms",
    "--motion-duration-slow": "320ms",
    "--motion-easing-standard": "cubic-bezier(0.16, 1, 0.3, 1)",
    "--motion-easing-emphasized": "cubic-bezier(0.16, 1, 0.3, 1)",
  },
};

export function isBuiltinTheme(value: string): value is BuiltinTheme {
  return (BUILTIN_THEME_IDS as readonly string[]).includes(value);
}

export function getBuiltinThemeMetadata(id: string): BuiltinThemeMetadata | undefined {
  return BUILTIN_THEMES.find((theme) => theme.id === id);
}

export function getBuiltinThemeFallbackContract(
  base: BuiltinTheme,
): BuiltinThemeContract {
  return BUILTIN_THEME_CONTRACTS[base];
}

export function normalizeThemeSelection(
  value: unknown,
  customThemes: readonly Pick<CustomTheme, "id">[] = [],
): Theme {
  if (typeof value !== "string") return DEFAULT_BUILTIN_THEME_ID;
  const id = value.trim();
  if (isBuiltinTheme(id)) return id;
  if (id.startsWith("custom:") && customThemes.some((theme) => theme.id === id)) return id;
  return DEFAULT_BUILTIN_THEME_ID;
}
