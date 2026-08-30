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
  { id: "dark", label: "Dark", description: "Near-black neutral graphite", swatches: ["#080809", "#0e0e11", "#9f8ed9", "#e9e7ed"] },
  { id: "amoled", label: "AMOLED", description: "True black with neutral dark-gray layers", swatches: ["#000000", "#000000", "#a88bd8", "#eeeeee"] },
  { id: "high-contrast", label: "High Contrast", description: "Dark surfaces with explicit boundaries", swatches: ["#070707", "#141414", "#b49cf0", "#ffffff"] },
  { id: "light", label: "Light", description: "Cool off-white with restrained violet", swatches: ["#f3f2f5", "#ffffff", "#6750a4", "#242127"] },
  { id: "light-contrast", label: "Light Contrast", description: "Cool light surfaces with stronger boundaries", swatches: ["#eceaf0", "#ffffff", "#4f378b", "#17141b"] },
  { id: "midnight", label: "Midnight", description: "Blue-black with muted periwinkle", swatches: ["#0c0f1a", "#161b2d", "#92a3dc", "#eceef8"] },
  { id: "warm", label: "Warm", description: "Deep umber with muted amber", swatches: ["#12100d", "#1e1a14", "#c9a45f", "#f0e9dd"] },
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
  "bg-void": "#040405", "bg-base": "#080809", "bg-surface": "#0b0b0d", "bg-raised": "#0e0e11", "bg-overlay": "#111115", "bg-subtle": "#15151a",
  "border-dim": "#111114", "border-base": "#1b1b20", "border-strong": "#29292f", "border-focus": "#8373c2",
  "text-primary": "#e9e7ed", "text-secondary": "#c3bfc9", "text-muted": "#89838f", "text-faint": "#59545f", "text-disabled": "#3a363f", "text-tertiary": "#89838f", "text-inverse": "#060607",
  "accent": "#9f8ed9", "accent-dim": "#493e63", "accent-muted": "rgba(159, 142, 217, 0.11)", "accent-fg": "#d9d1f2", "accent-bright": "#b4a6e3",
  "color-error": "#c47a7a", "color-error-bg": "#1f1212", "color-success": "#7aab7a", "color-success-bg": "rgba(122, 171, 122, 0.12)",
  "color-warning": "#c0a66a", "color-warning-bg": "rgba(192, 166, 106, 0.12)", "color-danger": "#c47a7a", "color-danger-bg": "#1f1212",
  "color-info": "#7a9ec4", "color-info-bg": "#0d1418", "color-background": "#080809", "color-background-void": "#040405",
  "color-surface": "#0b0b0d", "color-surface-secondary": "#15151a", "color-elevated": "#0e0e11", "color-card": "#0e0e11",
  "color-modal": "#111115", "color-popover": "#111115", "color-menu": "#111115", "color-overlay": "rgba(0, 0, 0, 0.8)",
  "color-border": "#1b1b20", "color-outline": "#8373c2", "color-divider": "#111114", "color-accent": "#9f8ed9", "color-accent-muted": "rgba(159, 142, 217, 0.11)",
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
  "hud-control-height": "28px", "hud-icon-button-size": "28px", "hud-control-radius": "8px", "hud-chip-radius": "9999px",
  "hud-popover-radius": "12px", "hud-status-radius": "9999px", "hud-toast-radius": "12px", "hud-chapter-row-radius": "9px",
  "hud-surface-opacity": "0.96", "hud-sidebar-width": "56px", "hud-toolbar-gap": "6px", "hud-reader-chrome-opacity": "0.92",
  "hud-selection-bg": "rgba(159, 142, 217, 0.11)", "hud-selection-border": "#493e63", "hud-progress-height": "2px",
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
  "bg-void": "#000000", "bg-base": "#070707", "bg-surface": "#0d0d0d", "bg-raised": "#141414", "bg-overlay": "#1b1b1b", "bg-subtle": "#222222",
  "border-dim": "#292929", "border-base": "#404040", "border-strong": "#666666", "border-focus": "#b49cf0",
  "text-primary": "#ffffff", "text-secondary": "#ebe8ef", "text-muted": "#bbb6c1", "text-faint": "#817b88", "text-disabled": "#55505a",
  "accent": "#b49cf0", "accent-dim": "#604f89", "accent-muted": "rgba(180, 156, 240, 0.18)", "accent-fg": "#f3edff", "accent-bright": "#d1c0fa",
});

const AMOLED_THEME_TOKENS = deriveBuiltinThemeTokens({
  "bg-void": "#000000", "bg-base": "#000000", "bg-surface": "#000000", "bg-raised": "#000000", "bg-overlay": "#070707", "bg-subtle": "#0d0d0d",
  "border-dim": "#101010", "border-base": "#1a1a1a", "border-strong": "#292929", "border-focus": "#9b83d6",
  "text-primary": "#eeeeee", "text-secondary": "#c7c7c7", "text-muted": "#808080", "text-faint": "#505050", "text-disabled": "#333333",
  "accent": "#a88bd8", "accent-dim": "#4a3b60", "accent-muted": "rgba(168, 139, 216, 0.12)", "accent-fg": "#dfd3f2", "accent-bright": "#c0a7e5",
  "color-overlay": "rgba(0, 0, 0, 0.86)",
});

const LIGHT_THEME_TOKENS = deriveBuiltinThemeTokens({
  "bg-void": "#e9e8ec", "bg-base": "#f3f2f5", "bg-surface": "#f8f7fa", "bg-raised": "#ffffff", "bg-overlay": "#ffffff", "bg-subtle": "#efedf2",
  "border-dim": "#e3e0e7", "border-base": "#d4d0da", "border-strong": "#bcb6c4", "border-focus": "#6750a4",
  "text-primary": "#242127", "text-secondary": "#454048", "text-muted": "#6d6671", "text-faint": "#9b949f", "text-disabled": "#c4bec8",
  "accent": "#6750a4", "accent-dim": "#c7b8e8", "accent-muted": "rgba(103, 80, 164, 0.10)", "accent-fg": "#4c3588", "accent-bright": "#7962b7",
  "color-error": "#9f3447", "color-error-bg": "#f8e9ed", "color-success": "#356b4c", "color-success-bg": "#e8f3ec",
  "color-warning": "#7b5d24", "color-warning-bg": "#f5efe1", "color-danger": "#9f3447", "color-danger-bg": "#f8e9ed",
  "color-info": "#3e5f91", "color-info-bg": "#e9eef7", "color-overlay": "rgba(21, 17, 28, 0.36)",
});

const LIGHT_CONTRAST_THEME_TOKENS = deriveBuiltinThemeTokens({
  "bg-void": "#dfdce4", "bg-base": "#eceaf0", "bg-surface": "#f5f3f7", "bg-raised": "#ffffff", "bg-overlay": "#ffffff", "bg-subtle": "#e7e4eb",
  "border-dim": "#d1ccd7", "border-base": "#aaa3b2", "border-strong": "#756e7d", "border-focus": "#4f378b",
  "text-primary": "#17141b", "text-secondary": "#302b35", "text-muted": "#544d5b", "text-faint": "#7c7484", "text-disabled": "#aaa3b2",
  "accent": "#4f378b", "accent-dim": "#bba9df", "accent-muted": "rgba(79, 55, 139, 0.13)", "accent-fg": "#372363", "accent-bright": "#62499d",
  "color-error": "#871f35", "color-error-bg": "#f6e2e7", "color-success": "#245c3d", "color-success-bg": "#e0efe6",
  "color-warning": "#694b13", "color-warning-bg": "#f4ead5", "color-danger": "#871f35", "color-danger-bg": "#f6e2e7",
  "color-info": "#2d5184", "color-info-bg": "#e2e9f4", "color-overlay": "rgba(16, 12, 22, 0.42)",
});

const MIDNIGHT_THEME_TOKENS = deriveBuiltinThemeTokens({
  "bg-void": "#070912", "bg-base": "#0c0f1a", "bg-surface": "#111524", "bg-raised": "#161b2d", "bg-overlay": "#1c2237", "bg-subtle": "#222a42",
  "border-dim": "#1b2134", "border-base": "#293149", "border-strong": "#3b4663", "border-focus": "#8294d1",
  "text-primary": "#eceef8", "text-secondary": "#c4c9dc", "text-muted": "#8790aa", "text-faint": "#555e76", "text-disabled": "#343c52",
  "accent": "#92a3dc", "accent-dim": "#3d496d", "accent-muted": "rgba(146, 163, 220, 0.12)", "accent-fg": "#d8def5", "accent-bright": "#aab8e7",
  "color-error": "#d2879e", "color-error-bg": "#25141e", "color-success": "#79b59a", "color-success-bg": "rgba(121, 181, 154, 0.12)",
  "color-warning": "#c6ae78", "color-warning-bg": "rgba(198, 174, 120, 0.12)", "color-danger": "#d2879e", "color-danger-bg": "#25141e",
  "color-info": "#88a7df", "color-info-bg": "#151d35",
});

const WARM_THEME_TOKENS = deriveBuiltinThemeTokens({
  "bg-void": "#0c0a08", "bg-base": "#12100d", "bg-surface": "#181510", "bg-raised": "#1e1a14", "bg-overlay": "#252019", "bg-subtle": "#2b261e",
  "border-dim": "#211d17", "border-base": "#302a20", "border-strong": "#463c2c", "border-focus": "#aa8951",
  "text-primary": "#f0e9dd", "text-secondary": "#d2c7b6", "text-muted": "#928674", "text-faint": "#5f5547", "text-disabled": "#3d352a",
  "accent": "#c9a45f", "accent-dim": "#5e4927", "accent-muted": "rgba(201, 164, 95, 0.12)", "accent-fg": "#ead4a8", "accent-bright": "#dab975",
  "color-error": "#c98278", "color-error-bg": "#241613", "color-success": "#8eaa78", "color-success-bg": "rgba(142, 170, 120, 0.12)",
  "color-warning": "#d0ad69", "color-warning-bg": "rgba(208, 173, 105, 0.12)", "color-danger": "#c98278", "color-danger-bg": "#241613",
  "color-info": "#839eb6", "color-info-bg": "#151d23",
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
