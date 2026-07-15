export const BUILTIN_THEME_IDS = [
  "nocturne",
  "dark",
  "high-contrast",
  "light",
  "light-contrast",
  "midnight",
  "warm",
] as const;

export type BuiltinTheme = (typeof BUILTIN_THEME_IDS)[number];
export type Theme = BuiltinTheme | string;
export type ThemeMotionPreset = "minimal" | "soft" | "expressive";

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

export type CustomTheme = LegacyCustomTheme | ThemeDocumentV4;

export interface BuiltinThemeMetadata {
  id: BuiltinTheme;
  label: string;
  description: string;
  swatches: readonly [string, string, string, string];
}

export const BUILTIN_THEMES: readonly BuiltinThemeMetadata[] = [
  { id: "nocturne", label: "Nocturne", description: "Default lunar graphite HUD", swatches: ["#080813", "#0d0d1b", "#8f82e6", "#f1eefc"] },
  { id: "dark", label: "Dark", description: "Classic near-black", swatches: ["#101010", "#151515", "#a8c4a8", "#f0efec"] },
  { id: "high-contrast", label: "High Contrast", description: "Darker base, sharper text", swatches: ["#080808", "#111111", "#bcd8bc", "#ffffff"] },
  { id: "light", label: "Light", description: "Warm off-white", swatches: ["#f4f2ee", "#faf8f4", "#2a5a2a", "#1a1916"] },
  { id: "light-contrast", label: "Light Contrast", description: "Light with maximum contrast", swatches: ["#ece8e2", "#f5f2ec", "#183818", "#080806"] },
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
] as const satisfies readonly (keyof ThemeSemanticTokens)[];

export const HUD_THEME_TOKEN_KEYS = [
  "hud-control-height", "hud-icon-button-size", "hud-control-radius", "hud-chip-radius",
  "hud-popover-radius", "hud-status-radius", "hud-toast-radius", "hud-chapter-row-radius",
  "hud-surface-opacity", "hud-sidebar-width", "hud-toolbar-gap", "hud-reader-chrome-opacity",
  "hud-selection-bg", "hud-selection-border", "hud-progress-height",
] as const satisfies readonly (keyof HudThemeTokens)[];

export const DEFAULT_THEME_TOKENS: ThemeTokens = {
  "bg-void": "#080808", "bg-base": "#0c0c0c", "bg-surface": "#101010", "bg-raised": "#151515", "bg-overlay": "#1a1a1a", "bg-subtle": "#202020",
  "border-dim": "#1c1c1c", "border-base": "#242424", "border-strong": "#2e2e2e", "border-focus": "#4a5c4a",
  "text-primary": "#f0efec", "text-secondary": "#c8c6c0", "text-muted": "#8a8880", "text-faint": "#4e4d4a", "text-disabled": "#2a2a28", "text-tertiary": "#8a8880", "text-inverse": "#080808",
  "accent": "#6b8f6b", "accent-dim": "#2a3d2a", "accent-muted": "#1a251a", "accent-fg": "#a8c4a8", "accent-bright": "#8fb88f",
  "color-error": "#c47a7a", "color-error-bg": "#1f1212", "color-success": "#7aab7a", "color-success-bg": "rgba(122, 171, 122, 0.12)",
  "color-warning": "#c0a66a", "color-warning-bg": "rgba(192, 166, 106, 0.12)", "color-danger": "#c47a7a", "color-danger-bg": "#1f1212",
  "color-info": "#7a9ec4", "color-info-bg": "#121a1f", "color-background": "#0c0c0c", "color-background-void": "#080808",
  "color-surface": "#101010", "color-surface-secondary": "#202020", "color-elevated": "#151515", "color-card": "#151515",
  "color-modal": "#1a1a1a", "color-popover": "#1a1a1a", "color-menu": "#1a1a1a", "color-overlay": "rgba(0, 0, 0, 0.64)",
  "color-border": "#242424", "color-outline": "#4a5c4a", "color-divider": "#1c1c1c", "color-accent": "#6b8f6b", "color-accent-muted": "#1a251a",
};

export const DEFAULT_HUD_THEME_TOKENS: HudThemeTokens = {
  "hud-control-height": "30px", "hud-icon-button-size": "30px", "hud-control-radius": "5px", "hud-chip-radius": "9999px",
  "hud-popover-radius": "5px", "hud-status-radius": "3px", "hud-toast-radius": "7px", "hud-chapter-row-radius": "5px",
  "hud-surface-opacity": "1", "hud-sidebar-width": "52px", "hud-toolbar-gap": "8px", "hud-reader-chrome-opacity": "1",
  "hud-selection-bg": "#1a251a", "hud-selection-border": "#2a3d2a", "hud-progress-height": "3px",
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
};

export const NOCTURNE_HUD_THEME_TOKENS: HudThemeTokens = {
  "hud-control-height": "28px", "hud-icon-button-size": "28px", "hud-control-radius": "8px", "hud-chip-radius": "9999px",
  "hud-popover-radius": "12px", "hud-status-radius": "9999px", "hud-toast-radius": "12px", "hud-chapter-row-radius": "9px",
  "hud-surface-opacity": "0.96", "hud-sidebar-width": "56px", "hud-toolbar-gap": "6px", "hud-reader-chrome-opacity": "0.92",
  "hud-selection-bg": "#211b3b", "hud-selection-border": "#4c4078", "hud-progress-height": "2px",
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
