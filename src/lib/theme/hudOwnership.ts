import type { HudThemeTokens } from "./contract";

export const HUD_RUNTIME_ACTIVE_TOKEN_KEYS = [
  "hud-popover-radius",
  "hud-toast-radius",
  "hud-progress-height",
] as const satisfies readonly (keyof HudThemeTokens)[];

export const HUD_MASKED_FALLBACK_TOKEN_KEYS = [
  "hud-icon-button-size",
] as const satisfies readonly (keyof HudThemeTokens)[];

export const HUD_PREVIEW_ONLY_TOKEN_KEYS = [
  "hud-control-height",
  "hud-control-radius",
  "hud-status-radius",
  "hud-chapter-row-radius",
  "hud-surface-opacity",
  "hud-toolbar-gap",
  "hud-reader-chrome-opacity",
  "hud-selection-bg",
  "hud-selection-border",
] as const satisfies readonly (keyof HudThemeTokens)[];

export const HUD_CONTRACT_ONLY_TOKEN_KEYS = [
  "hud-chip-radius",
  "hud-sidebar-width",
] as const satisfies readonly (keyof HudThemeTokens)[];

export const HUD_LEGACY_TOKEN_KEYS = [
  ...HUD_PREVIEW_ONLY_TOKEN_KEYS,
  ...HUD_CONTRACT_ONLY_TOKEN_KEYS,
] as const satisfies readonly (keyof HudThemeTokens)[];
