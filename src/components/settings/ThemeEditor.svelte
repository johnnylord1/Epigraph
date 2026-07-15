<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { X, FloppyDisk, UploadSimple, DownloadSimple, ArrowLeft, Trash } from "phosphor-svelte";
  import {
    store, saveCustomTheme, deleteCustomTheme,
    type HudThemeTokens,
    type ThemeMotionPreset,
    type ThemeTokens,
    DEFAULT_HUD_THEME_TOKENS,
    NOCTURNE_HUD_THEME_TOKENS,
    NOCTURNE_THEME_TOKENS,
  } from "../../store/state.svelte";
  import {
    createThemeDocumentV4,
    importThemeDocument,
    isValidThemeTokenValue,
    migrateThemeDocument,
    resolveThemeDocument,
    serializeThemeDocument,
  } from "../../lib/theme/document";
  import { applyThemeContract, readBuiltinThemeContract } from "../../lib/theme/provider";
  import type { BuiltinTheme } from "../../lib/theme/contract";

  interface Props {
    editingId?: string | null;
    onClose: () => void;
  }

  let { editingId = $bindable(null), onClose }: Props = $props();
  type EditorTab = "colors" | "hud";

  // ── Token group definitions ───────────────────────────────────────────────

  const TOKEN_GROUPS: { label: string; tokens: (keyof ThemeTokens)[] }[] = $derived.by(() => [
    {
      label: $_("ui_backgrounds"),
      tokens: ["bg-void", "bg-base", "bg-surface", "bg-raised", "bg-overlay", "bg-subtle"],
    },
    {
      label: $_("ui_borders"),
      tokens: ["border-dim", "border-base", "border-strong", "border-focus"],
    },
    {
      label: $_("ui_text"),
      tokens: ["text-primary", "text-secondary", "text-tertiary", "text-muted", "text-faint", "text-disabled", "text-inverse"],
    },
    {
      label: $_("ui_accent"),
      tokens: ["accent", "accent-dim", "accent-muted", "accent-fg", "accent-bright"],
    },
    {
      label: $_("ui_semantic"),
      tokens: [
        "color-background",
        "color-background-void",
        "color-surface",
        "color-surface-secondary",
        "color-elevated",
        "color-card",
        "color-modal",
        "color-popover",
        "color-menu",
        "color-overlay",
        "color-border",
        "color-outline",
        "color-divider",
        "color-accent",
        "color-accent-muted",
        "color-error",
        "color-error-bg",
        "color-danger",
        "color-danger-bg",
        "color-success",
        "color-success-bg",
        "color-warning",
        "color-warning-bg",
        "color-info",
        "color-info-bg",
        "color-shadow-source",
        "color-highlight-source",
      ],
    },
  ]);

  const TOKEN_LABELS: Record<keyof ThemeTokens, string> = {
    "bg-void":    "Void (deepest bg)",
    "bg-base":    "Base",
    "bg-surface": "Surface",
    "bg-raised":  "Raised",
    "bg-overlay": "Overlay",
    "bg-subtle":  "Subtle",
    "border-dim":    "Dim border",
    "border-base":   "Base border",
    "border-strong": "Strong border",
    "border-focus":  "Focus ring",
    "text-primary":   "Primary text",
    "text-secondary": "Secondary text",
    "text-muted":     "Muted text",
    "text-faint":     "Faint text",
    "text-disabled":  "Disabled text",
    "text-tertiary":  "Tertiary text",
    "text-inverse":   "Inverse text",
    "accent":        "Accent",
    "accent-dim":    "Accent dim",
    "accent-muted":  "Accent muted",
    "accent-fg":     "Accent foreground",
    "accent-bright": "Accent bright",
    "color-error":    "Error",
    "color-error-bg": "Error background",
    "color-danger":   "Danger",
    "color-danger-bg": "Danger background",
    "color-success":  "Success",
    "color-success-bg": "Success background",
    "color-warning": "Warning",
    "color-warning-bg": "Warning background",
    "color-info":     "Info",
    "color-info-bg":  "Info background",
    "color-background": "Background",
    "color-background-void": "Void background",
    "color-surface": "Surface",
    "color-surface-secondary": "Secondary surface",
    "color-elevated": "Elevated surface",
    "color-card": "Card surface",
    "color-modal": "Modal surface",
    "color-popover": "Popover surface",
    "color-menu": "Menu surface",
    "color-overlay": "Overlay",
    "color-border": "Border",
    "color-outline": "Outline",
    "color-divider": "Divider",
    "color-accent": "Semantic accent",
    "color-accent-muted": "Muted semantic accent",
    "color-shadow-source": "Shadow source",
    "color-highlight-source": "Highlight source",
  };

  const HUD_TOKEN_LABELS: Record<keyof HudThemeTokens, string> = {
    "hud-control-height":        "Control height",
    "hud-icon-button-size":      "Icon button size",
    "hud-control-radius":        "Control radius",
    "hud-chip-radius":           "Chip radius",
    "hud-popover-radius":        "Popover radius",
    "hud-status-radius":         "Status radius",
    "hud-toast-radius":          "Toast radius",
    "hud-chapter-row-radius":    "Chapter row radius",
    "hud-surface-opacity":       "Surface opacity",
    "hud-sidebar-width":         "Sidebar width",
    "hud-toolbar-gap":           "Toolbar gap",
    "hud-reader-chrome-opacity": "Reader chrome opacity",
    "hud-selection-bg":          "Selection background",
    "hud-selection-border":      "Selection border",
    "hud-progress-height":       "Progress height",
  };

  const HUD_PRESETS: {
    id: "default" | "nocturne";
    label: string;
    description: string;
    hud: HudThemeTokens;
    tokens?: ThemeTokens;
    motion: ThemeMotionPreset;
  }[] = $derived.by(() => [
    {
      id: "default",
      label: $_("ui_defaultHud"),
      description: $_("ui_matchesTheCurrentCompactAethonShell"),
      hud: DEFAULT_HUD_THEME_TOKENS,
      motion: "soft",
    },
    {
      id: "nocturne",
      label: $_("ui_nocturneHud"),
      description: $_("ui_compactLunarControlsForTheNewIdentity"),
      hud: NOCTURNE_HUD_THEME_TOKENS,
      tokens: NOCTURNE_THEME_TOKENS,
      motion: "soft",
    },
  ]);

  const HUD_SLIDER_TOKENS: {
    token: keyof HudThemeTokens;
    min: number;
    max: number;
    step: number;
    unit: "px" | "";
  }[] = [
    { token: "hud-control-height", min: 24, max: 38, step: 1, unit: "px" },
    { token: "hud-icon-button-size", min: 24, max: 38, step: 1, unit: "px" },
    { token: "hud-control-radius", min: 2, max: 16, step: 1, unit: "px" },
    { token: "hud-popover-radius", min: 4, max: 20, step: 1, unit: "px" },
    { token: "hud-sidebar-width", min: 48, max: 72, step: 1, unit: "px" },
    { token: "hud-toolbar-gap", min: 4, max: 16, step: 1, unit: "px" },
    { token: "hud-reader-chrome-opacity", min: 0.72, max: 1, step: 0.01, unit: "" },
    { token: "hud-progress-height", min: 2, max: 8, step: 1, unit: "px" },
  ];

  // ── State ─────────────────────────────────────────────────────────────────

  function loadInitial(): { name: string; base: BuiltinTheme; tokens: ThemeTokens; hud: HudThemeTokens; motion: ThemeMotionPreset } {
    if (editingId) {
      const existing = store.settings.customThemes.find(t => t.id === editingId);
      if (existing) {
        const migrated = migrateThemeDocument(existing);
        if (migrated.ok) {
          const baseContract = readBuiltinThemeContract(migrated.document.base);
          const resolved = resolveThemeDocument(migrated.document, baseContract.tokens, baseContract.hud);
          return {
            name: migrated.document.name,
            base: migrated.document.base,
            tokens: resolved.tokens,
            hud: resolved.hud,
            motion: migrated.document.motion,
          };
        }
      }
    }
    return {
      name: "My Theme",
      base: "nocturne",
      tokens: { ...NOCTURNE_THEME_TOKENS },
      hud: { ...NOCTURNE_HUD_THEME_TOKENS },
      motion: "soft",
    };
  }

  const initial = loadInitial();
  let themeName: string   = $state(initial.name);
  let base: BuiltinTheme  = $state(initial.base);
  let tokens: ThemeTokens = $state(initial.tokens);
  let hud: HudThemeTokens = $state(initial.hud);
  let motion: ThemeMotionPreset = $state(initial.motion);
  let editorTab: EditorTab = $state("colors");
  let saveStatus: "idle" | "saved" = $state("idle");
  let importError: string | null   = $state(null);

  function toValidColorPickerValue(v: string): string {
    if (!v || typeof v !== "string") return "#000000";
    let clean = v.trim();
    if (!clean.startsWith("#")) return "#000000";
    if (clean.length === 4) {
      return `#${clean[1]}${clean[1]}${clean[2]}${clean[2]}${clean[3]}${clean[3]}`.toLowerCase();
    }
    if (clean.length === 7) {
      return clean.toLowerCase();
    }
    if (clean.length === 9) {
      return clean.slice(0, 7).toLowerCase();
    }
    return "#000000";
  }

  // ── CSS vars helper ───────────────────────────────────────────────────────
  function themePreview(
    node: HTMLElement,
    draft: { tokens: ThemeTokens; hud: HudThemeTokens; motion: ThemeMotionPreset },
  ) {
    applyThemeContract(node, draft.tokens, draft.hud, draft.motion);
    return {
      update(next: { tokens: ThemeTokens; hud: HudThemeTokens; motion: ThemeMotionPreset }) {
        applyThemeContract(node, next.tokens, next.hud, next.motion);
      },
    };
  }

  function parseHudNumber(token: keyof HudThemeTokens): number {
    return Number.parseFloat(String(hud[token]).replace("px", "")) || Number.parseFloat(NOCTURNE_HUD_THEME_TOKENS[token]) || 0;
  }

  function setHudNumeric(token: keyof HudThemeTokens, value: number, unit: "px" | "") {
    hud = { ...hud, [token]: unit ? `${value}${unit}` : String(value) };
  }

  function applyHudPreset(id: "default" | "nocturne") {
    const preset = HUD_PRESETS.find((entry) => entry.id === id);
    if (!preset) return;
    hud = { ...preset.hud };
    motion = preset.motion;
    if (preset.tokens) tokens = { ...preset.tokens };
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  function handleSave() {
    const name = themeName.trim() || "Untitled Theme";
    const id   = editingId ?? `custom:${Math.random().toString(36).slice(2, 10)}`;
    try {
      const baseContract = readBuiltinThemeContract(base);
      const theme = createThemeDocumentV4(
        { id, name, base, tokens: { ...tokens }, hud: { ...hud }, motion },
        baseContract.tokens,
        baseContract.hud,
      );
      if (!saveCustomTheme(theme, true)) throw new Error("Could not persist the theme. Your previous document was preserved.");
      editingId = id;
      importError = null;
      saveStatus = "saved";
      setTimeout(() => (saveStatus = "idle"), 1800);
    } catch (error) {
      importError = error instanceof Error ? error.message : "Could not save the theme";
      setTimeout(() => (importError = null), 4000);
    }
  }

  function handleDelete() {
    if (!editingId) { onClose(); return; }
    if (!confirm(`Delete theme "${themeName}"? This cannot be undone.`)) return;
    deleteCustomTheme(editingId);
    onClose();
  }

  function handleExport() {
    try {
      const baseContract = readBuiltinThemeContract(base);
      const data = createThemeDocumentV4(
        {
          id: editingId ?? "custom:export",
          name: themeName.trim() || "Untitled Theme",
          base,
          tokens: { ...tokens },
          hud: { ...hud },
          motion,
        },
        baseContract.tokens,
        baseContract.hud,
      );
      const blob = new Blob([serializeThemeDocument(data)], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${data.name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-theme.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      importError = error instanceof Error ? error.message : "Could not export the theme";
      setTimeout(() => (importError = null), 4000);
    }
  }

  function handleImport() {
    const inp    = document.createElement("input");
    inp.type     = "file";
    inp.accept   = ".json";
    inp.onchange = async () => {
      const file = inp.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const imported = importThemeDocument(text);
        if (!imported.ok) throw new Error(imported.error);
        const baseContract = readBuiltinThemeContract(imported.document.base);
        const resolved = resolveThemeDocument(imported.document, baseContract.tokens, baseContract.hud);
        themeName   = imported.document.name;
        base        = imported.document.base;
        tokens      = resolved.tokens;
        hud         = resolved.hud;
        motion      = imported.document.motion;
        importError = null;
      } catch (e: any) {
        importError = e.message ?? "Could not parse theme file";
        setTimeout(() => (importError = null), 3000);
      }
    };
    inp.click();
  }

  function resetToDefaults() {
    base = "nocturne";
    tokens = { ...NOCTURNE_THEME_TOKENS };
    hud = { ...NOCTURNE_HUD_THEME_TOKENS };
    motion = "soft";
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- ── Main editor ────────────────────────────────────────────────────────────── -->
<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="te-backdrop" onclick={onClose} role="presentation">
  <div
    class="te-shell"
    role="dialog"
    aria-label={$_("ui_themeEditor")}
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
  >

    <!-- ── Header ──────────────────────────────────────────────────────── -->
    <header class="te-header">
      <div class="te-header-left">
        <button class="te-icon-btn" onclick={onClose} title={$_("ui_closeEditor")}>
          <ArrowLeft size={14} weight="bold" />
        </button>
        <input
          bind:value={themeName}
          class="te-name-input"
          placeholder={$_("ui_themeName")}
          maxlength={40}
          spellcheck={false}
        />
      </div>

      <div class="te-header-actions">
        {#if importError}
          <span class="te-import-err">{importError}</span>
        {/if}
        <button class="te-action-btn" onclick={handleImport} title={$_("ui_importFromJson")}>
          <UploadSimple size={13} />
          <span>{$_("ui_import")}</span>
        </button>
        <button class="te-action-btn" onclick={handleExport} title={$_("ui_exportAsJson")}>
          <DownloadSimple size={13} />
          <span>{$_("ui_export")}</span>
        </button>
        <button class="te-action-btn te-ghost" onclick={resetToDefaults} title={$_("ui_resetAllToNocturneDefaults")}>
          {$_("ui_reset")}
        </button>
        {#if editingId}
          <button class="te-action-btn te-danger" onclick={handleDelete} title={$_("ui_deleteTheme")}>
            <Trash size={13} />
          </button>
        {/if}
        <button class="te-save-btn" class:saved={saveStatus === "saved"} onclick={handleSave}>
          <FloppyDisk size={13} />
          <span>{saveStatus === "saved" ? "Saved!" : $_("ui_saveTheme")}</span>
        </button>
        <button class="te-icon-btn" onclick={onClose} title={$_("ui_close_bbfa773e")}>
          <X size={14} weight="bold" />
        </button>
      </div>
    </header>

    <!-- ── Body ───────────────────────────────────────────────────────── -->
    <div class="te-body">

      <!-- Left: live preview -->
      <aside class="te-preview-pane">
        <div class="te-pane-label">{$_("ui_livePreview")}</div>

        <div class="te-preview-ui" use:themePreview={{ tokens, hud, motion }}>
          <!-- Sidebar -->
          <div class="prv-sidebar">
            {#each [true, false, false, false] as active}
              <div class="prv-sb-dot" class:active></div>
            {/each}
          </div>
          <!-- Main -->
          <div class="prv-main">
            <div class="prv-titlebar">
              <div class="prv-win-dots">
                <span></span><span></span><span></span>
              </div>
              <div class="prv-win-title">Aethon</div>
            </div>
            <div class="prv-content">
              <div class="prv-row">
                <div class="prv-bar prv-bar--primary"></div>
                <div class="prv-bar prv-bar--accent"></div>
              </div>
              <div class="prv-toolbar">
                <span class="prv-control active">{$_("library_sort")}</span>
                <span class="prv-control">{$_("library_filter")}</span>
                <span class="prv-icon-control"></span>
              </div>
              <div class="prv-popover">
                <span class="prv-popover-row active"></span>
                <span class="prv-popover-row"></span>
                <span class="prv-popover-row short"></span>
              </div>
              <div class="prv-grid">
                {#each Array(6) as _, i}
                  <div class="prv-card" class:active-card={i === 0}>
                    <div class="prv-cover"></div>
                    <div class="prv-card-line"></div>
                  </div>
                {/each}
              </div>
              <div class="prv-reader">
                <div class="prv-reader-chrome"></div>
                <div class="prv-page"></div>
                <div class="prv-reader-chrome bottom"></div>
              </div>
              <div class="prv-chapter-row">
                <span class="prv-status-pill">{$_("ui_reading_f09e6eca")}</span>
                <span class="prv-progress-track"><span></span></span>
              </div>
              <div class="prv-toast">
                <div class="prv-toast-dot"></div>
                <div class="prv-toast-lines">
                  <div class="prv-bar prv-bar--toast-primary"></div>
                  <div class="prv-bar prv-bar--toast-secondary"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Swatch strip — scoped to draft tokens too -->
        <div class="te-swatches" use:themePreview={{ tokens, hud, motion }}>
          {#each [
            ["bg-base","bg-base"],["bg-surface","bg-surface"],
            ["accent","accent"],["accent-fg","accent-fg"],
            ["text-primary","text-primary"],["text-muted","text-muted"],
            ["color-error","color-error"],
          ] as [varName, label]}
            <div
              class="te-swatch"
              style="background: var(--{varName})"
              title={label}
            ></div>
          {/each}
        </div>
      </aside>

      <!-- Right: token editor -->
      <div class="te-editor-pane">
        <div class="te-editor-tabs">
          <button class:active={editorTab === "colors"} onclick={() => (editorTab = "colors")}>{$_("ui_colors")}</button>
          <button class:active={editorTab === "hud"} onclick={() => (editorTab = "hud")}>{$_("ui_hud")}</button>
        </div>

        {#if editorTab === "colors"}
          {#each TOKEN_GROUPS as group}
            <div class="te-group">
              <div class="te-group-label">{group.label}</div>
              <div class="te-token-list">
                {#each group.tokens as token}
                  <div class="te-token-row">
                    <span class="te-color-swatch" style="background: {tokens[token]};">
                      <input
                        type="color"
                        value={toValidColorPickerValue(tokens[token])}
                        oninput={(e) => {
                          const v = (e.target as HTMLInputElement).value;
                          tokens = { ...tokens, [token]: v };
                        }}
                        class="te-color-picker-input"
                        title={$_("ui_chooseColorVisually")}
                      />
                    </span>
                    <span class="te-token-name">{TOKEN_LABELS[token]}</span>
                    <span class="te-token-key">{token}</span>
                    <input
                      type="text"
                      class="te-hex-input"
                      value={tokens[token]}
                      spellcheck={false}
                      oninput={(e) => {
                        const v = (e.target as HTMLInputElement).value.trim();
                        if (isValidThemeTokenValue(v)) tokens = { ...tokens, [token]: v };
                      }}
                      onblur={(e) => {
                        const v = (e.target as HTMLInputElement).value.trim();
                        if (!isValidThemeTokenValue(v)) {
                          (e.target as HTMLInputElement).value = tokens[token];
                        }
                      }}
                    />
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        {:else}
          <div class="te-group">
            <div class="te-group-label">{$_("ui_hudPreset")}</div>
            <div class="te-preset-grid">
              {#each HUD_PRESETS as preset}
                <button class="te-preset-card" onclick={() => applyHudPreset(preset.id)}>
                  <span class="te-preset-title">{preset.label}</span>
                  <span class="te-preset-desc">{preset.description}</span>
                </button>
              {/each}
            </div>
          </div>

          <div class="te-group">
            <div class="te-group-label">{$_("ui_motion")}</div>
            <div class="te-motion-row">
              {#each ["minimal", "soft", "expressive"] as option}
                <button
                  class="te-motion-btn"
                  class:active={motion === option}
                  onclick={() => (motion = option as ThemeMotionPreset)}
                >
                  {option}
                </button>
              {/each}
            </div>
          </div>

          <div class="te-group">
            <div class="te-group-label">{$_("ui_hudGeometry")}</div>
            <div class="te-token-list">
              {#each HUD_SLIDER_TOKENS as item}
                <div class="te-token-row te-slider-row">
                  <span class="te-color-swatch te-shape-swatch" style="border-radius: {hud[item.token]}"></span>
                  <span class="te-token-name">{HUD_TOKEN_LABELS[item.token]}</span>
                  <span class="te-token-key">{item.token}</span>
                  <input
                    type="range"
                    class="te-range-input"
                    min={item.min}
                    max={item.max}
                    step={item.step}
                    value={parseHudNumber(item.token)}
                    oninput={(e) => setHudNumeric(item.token, Number((e.target as HTMLInputElement).value), item.unit)}
                  />
                  <span class="te-slider-value">{hud[item.token]}</span>
                </div>
              {/each}
            </div>
          </div>

          <div class="te-group">
            <div class="te-group-label">{$_("ui_hudColors")}</div>
            <div class="te-token-list">
              {#each ["hud-selection-bg", "hud-selection-border"] as token}
                <div class="te-token-row">
                  <span class="te-color-swatch" style="background: {hud[token as keyof HudThemeTokens]};">
                    <input
                      type="color"
                      value={toValidColorPickerValue(hud[token as keyof HudThemeTokens])}
                      oninput={(e) => {
                        const v = (e.target as HTMLInputElement).value;
                        hud = { ...hud, [token]: v };
                      }}
                      class="te-color-picker-input"
                      title={$_("ui_chooseColorVisually")}
                    />
                  </span>
                  <span class="te-token-name">{HUD_TOKEN_LABELS[token as keyof HudThemeTokens]}</span>
                  <span class="te-token-key">{token}</span>
                  <input
                    type="text"
                    class="te-hex-input"
                    value={hud[token as keyof HudThemeTokens]}
                    spellcheck={false}
                    oninput={(e) => {
                      const v = (e.target as HTMLInputElement).value.trim();
                      if (/^#[0-9a-fA-F]{3,8}$/.test(v)) hud = { ...hud, [token]: v };
                    }}
                  />
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>

    </div>
  </div>
</div>

<style>
  /* ── Backdrop ─────────────────────────────────────────────────────────────── */
  .te-backdrop {
    position: fixed; inset: 0;
    background: var(--component-theme-editor-backdrop-bg);
    z-index: var(--component-theme-editor-backdrop-z-index);
    /* FIX 2: center the modal instead of stretch */
    display: flex; align-items: center; justify-content: center;
    animation: teBackdropIn var(--component-theme-editor-backdrop-animation) both;
  }
  @keyframes teBackdropIn { from { opacity: 0; } to { opacity: 1; } }

  /* ── Shell ────────────────────────────────────────────────────────────────── */
  .te-shell {
    /* FIX 2: constrained dimensions so it doesn't fill the screen */
    width: var(--component-theme-editor-shell-width);
    max-width: var(--component-theme-editor-shell-max-width);
    height: var(--component-theme-editor-shell-height);
    max-height: var(--component-theme-editor-shell-max-height);
    display: flex; flex-direction: column;
    background: var(--component-theme-editor-shell-bg);
    border: 1px solid var(--component-theme-editor-shell-border);
    border-radius: var(--component-theme-editor-shell-radius);
    animation: teShellIn var(--component-theme-editor-shell-animation) both;
    overflow: hidden;
  }
  @keyframes teShellIn {
    from { transform: translateY(10px) scale(0.99); opacity: 0; }
    to   { transform: translateY(0) scale(1);       opacity: 1; }
  }

  /* ── Header ───────────────────────────────────────────────────────────────── */
  .te-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: var(--component-theme-editor-header-gap);
    padding: var(--component-theme-editor-header-padding);
    height: var(--component-theme-editor-header-height);
    border-bottom: 1px solid var(--component-theme-editor-header-border);
    background: var(--component-theme-editor-header-bg);
    flex-shrink: 0;
  }

  .te-header-left {
    display: flex; align-items: center; gap: var(--component-theme-editor-header-left-gap); flex: 1; min-width: 0;
  }

  .te-icon-btn {
    display: flex; align-items: center; justify-content: center;
    width: var(--component-theme-editor-icon-button-size);
    height: var(--component-theme-editor-icon-button-size);
    border-radius: var(--component-theme-editor-icon-button-radius);
    color: var(--component-theme-editor-icon-button-fg);
    transition:
      color var(--component-theme-editor-transition-fast),
      background var(--component-theme-editor-transition-fast);
    flex-shrink: 0;
  }
  .te-icon-btn:hover {
    color: var(--component-theme-editor-icon-button-hover-fg);
    background: var(--component-theme-editor-icon-button-hover-bg);
  }

  .te-name-input {
    flex: 1; min-width: 0;
    background: none; border: none; outline: none;
    font-family: var(--component-theme-editor-input-font);
    font-size: var(--component-theme-editor-input-font-size);
    font-weight: var(--component-theme-editor-input-font-weight);
    color: var(--component-theme-editor-input-fg);
    border-bottom: 1px solid transparent;
    padding: var(--component-theme-editor-name-input-padding);
    transition: border-color var(--component-theme-editor-transition-fast);
  }
  .te-name-input:focus { border-color: var(--component-theme-editor-input-focus-border); }
  .te-name-input::placeholder { color: var(--component-theme-editor-input-placeholder-fg); }

  .te-header-actions {
    display: flex; align-items: center; gap: var(--component-theme-editor-header-actions-gap); flex-shrink: 0;
  }

  .te-import-err {
    font-family: var(--component-theme-editor-label-font);
    font-size: var(--component-theme-editor-tab-font-size);
    letter-spacing: var(--component-theme-editor-preset-desc-letter-spacing);
    color: var(--component-theme-editor-status-error-fg);
    flex-shrink: 0;
  }

  .te-action-btn {
    display: flex; align-items: center; gap: var(--component-theme-editor-action-gap);
    font-family: var(--component-theme-editor-label-font);
    font-size: var(--component-theme-editor-tab-font-size);
    letter-spacing: var(--component-theme-editor-tab-letter-spacing);
    padding: var(--component-theme-editor-action-padding);
    border-radius: var(--component-theme-editor-action-radius);
    border: 1px solid var(--component-theme-editor-action-border);
    background: none;
    color: var(--component-theme-editor-action-fg);
    cursor: pointer; flex-shrink: 0;
    transition:
      color var(--component-theme-editor-transition-fast),
      border-color var(--component-theme-editor-transition-fast),
      background var(--component-theme-editor-transition-fast);
  }
  .te-action-btn:hover {
    color: var(--component-theme-editor-action-hover-fg);
    border-color: var(--component-theme-editor-action-hover-border);
  }

  .te-ghost { border-color: transparent; }
  .te-ghost:hover { border-color: var(--component-theme-editor-action-border); }

  .te-danger { color: var(--component-theme-editor-danger-fg); border-color: transparent; }
  .te-danger:hover {
    background: var(--component-theme-editor-danger-bg);
    border-color: var(--component-theme-editor-danger-fg);
  }

  .te-save-btn {
    display: flex; align-items: center; gap: var(--component-theme-editor-action-gap);
    font-family: var(--component-theme-editor-label-font);
    font-size: var(--component-theme-editor-tab-font-size);
    letter-spacing: var(--component-theme-editor-tab-letter-spacing);
    padding: var(--component-theme-editor-save-padding);
    border-radius: var(--component-theme-editor-action-radius);
    border: 1px solid var(--component-theme-editor-save-border);
    background: var(--component-theme-editor-save-bg);
    color: var(--component-theme-editor-save-fg);
    cursor: pointer; flex-shrink: 0;
    transition:
      filter var(--component-theme-editor-transition-fast),
      background var(--component-theme-editor-transition-fast);
  }
  .te-save-btn:hover { filter: var(--component-theme-editor-save-hover-filter); }
  .te-save-btn.saved {
    background: var(--component-theme-editor-save-saved-bg);
    border-color: var(--component-theme-editor-save-saved-border);
  }

  /* ── Body ─────────────────────────────────────────────────────────────────── */
  .te-body {
    flex: 1;
    overflow: hidden;
    display: flex;
    min-height: 0;
    background: var(--component-theme-editor-body-bg);
  }

  /* ── Preview pane ─────────────────────────────────────────────────────────── */
  .te-preview-pane {
    width: var(--component-theme-editor-preview-pane-width);
    flex-shrink: 0;
    border-right: 1px solid var(--component-theme-editor-preview-pane-border);
    background: var(--component-theme-editor-preview-pane-bg);
    display: flex; flex-direction: column;
    padding: var(--component-theme-editor-preview-pane-padding);
    gap: var(--component-theme-editor-preview-pane-gap);
  }

  .te-pane-label {
    font-family: var(--component-theme-editor-label-font);
    font-size: var(--component-theme-editor-label-font-size);
    letter-spacing: var(--component-theme-editor-label-letter-spacing);
    text-transform: uppercase;
    color: var(--component-theme-editor-label-fg);
    flex-shrink: 0;
  }

  /* te-preview-ui receives draft CSS vars via inline style */
  .te-preview-ui {
    flex: 1; min-height: 0;
    border-radius: var(--component-theme-editor-preview-radius);
    overflow: hidden;
    border: 1px solid var(--component-theme-editor-preview-border);
    display: flex;
    background: var(--component-theme-editor-preview-bg);
  }

  /* Sidebar strip */
  .prv-sidebar {
    width: var(--component-theme-editor-preview-sidebar-width);
    flex-shrink: 0;
    background: var(--component-theme-editor-preview-sidebar-bg);
    border-right: 1px solid var(--component-theme-editor-preview-pane-border);
    display: flex; flex-direction: column;
    align-items: center;
    padding: var(--component-theme-editor-preview-sidebar-padding);
    gap: var(--component-theme-editor-preview-sidebar-gap);
  }
  .prv-sb-dot {
    width: var(--component-theme-editor-preview-dot-size);
    height: var(--component-theme-editor-preview-dot-size);
    border-radius: var(--component-theme-editor-preview-dot-radius);
    background: var(--component-theme-editor-preview-dot-bg);
    opacity: var(--component-theme-editor-preview-dot-opacity);
    transition:
      background var(--component-theme-editor-transition-fast),
      opacity var(--component-theme-editor-transition-fast);
  }
  .prv-sb-dot.active {
    background: var(--component-theme-editor-preview-dot-active-bg);
    opacity: var(--component-theme-editor-preview-dot-active-opacity);
  }

  .prv-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

  .prv-titlebar {
    height: var(--component-theme-editor-preview-titlebar-height);
    flex-shrink: 0;
    background: var(--component-theme-editor-preview-titlebar-bg);
    border-bottom: 1px solid var(--component-theme-editor-preview-pane-border);
    display: flex;
    align-items: center;
    padding: var(--component-theme-editor-preview-titlebar-padding);
    gap: var(--component-theme-editor-preview-titlebar-gap);
  }
  .prv-win-dots { display: flex; gap: var(--component-theme-editor-preview-grid-gap); }
  .prv-win-dots span {
    width: var(--component-theme-editor-preview-window-dot-size);
    height: var(--component-theme-editor-preview-window-dot-size);
    border-radius: var(--component-theme-editor-preview-window-dot-radius);
    background: var(--component-theme-editor-preview-window-dot-bg);
  }
  .prv-win-title {
    font-family: var(--component-theme-editor-label-font);
    font-size: var(--component-theme-editor-preview-title-font-size);
    letter-spacing: var(--component-theme-editor-label-letter-spacing);
    color: var(--component-theme-editor-label-fg);
  }

  .prv-content {
    flex: 1; overflow: hidden;
    padding: var(--component-theme-editor-preview-content-padding);
    display: flex;
    flex-direction: column;
    gap: var(--component-theme-editor-preview-content-gap);
    background: var(--component-theme-editor-preview-content-bg);
  }

  .prv-row {
    display: flex;
    align-items: center;
    gap: var(--component-theme-editor-preview-row-gap);
    flex-shrink: 0;
  }
  .prv-bar {
    height: var(--component-theme-editor-preview-bar-height);
    border-radius: var(--component-theme-editor-preview-bar-radius);
  }
  .prv-bar--primary {
    width: var(--component-theme-editor-preview-bar-primary-width);
    background: var(--component-theme-editor-preview-bar-primary-bg);
    opacity: var(--component-theme-editor-preview-bar-muted-opacity);
  }
  .prv-bar--accent {
    width: var(--component-theme-editor-preview-bar-secondary-width);
    background: var(--component-theme-editor-preview-bar-secondary-bg);
  }
  .prv-bar--toast-primary {
    width: var(--component-theme-editor-preview-toast-line-primary-width);
    background: var(--component-theme-editor-preview-bar-primary-bg);
  }
  .prv-bar--toast-secondary {
    width: var(--component-theme-editor-preview-toast-line-secondary-width);
    margin-top: var(--component-theme-editor-preview-toast-line-secondary-margin-top);
    background: var(--component-theme-editor-preview-popover-row-bg);
  }

  .prv-toolbar {
    display: flex; align-items: center; gap: var(--hud-toolbar-gap);
    flex-shrink: 0;
  }
  .prv-control {
    display: inline-flex; align-items: center; justify-content: center;
    height: var(--hud-control-height);
    padding: 0 var(--component-theme-editor-preview-toolbar-padding-x);
    border-radius: var(--hud-control-radius);
    border: 1px solid var(--component-theme-editor-preview-control-border);
    background: var(--component-theme-editor-preview-control-bg);
    color: var(--component-theme-editor-preview-control-fg);
    font-family: var(--component-theme-editor-label-font);
    font-size: var(--component-theme-editor-preview-control-font-size);
    letter-spacing: var(--component-theme-editor-preview-control-letter-spacing);
    text-transform: uppercase;
  }
  .prv-control.active {
    border-color: var(--hud-selection-border);
    background: var(--hud-selection-bg);
    color: var(--accent-fg);
  }
  .prv-icon-control {
    width: var(--hud-icon-button-size);
    height: var(--hud-icon-button-size);
    border-radius: var(--hud-control-radius);
    border: 1px solid var(--component-theme-editor-preview-control-border);
    background: var(--component-theme-editor-preview-control-bg);
  }

  .prv-popover {
    display: flex;
    flex-direction: column;
    gap: var(--component-theme-editor-preview-popover-gap);
    width: var(--component-theme-editor-preview-popover-width);
    padding: var(--component-theme-editor-preview-popover-padding);
    border: 1px solid var(--component-theme-editor-preview-popover-border);
    border-radius: var(--hud-popover-radius);
    background: var(--component-theme-editor-preview-popover-bg);
    box-shadow: var(--component-theme-editor-preview-popover-shadow);
  }
  .prv-popover-row {
    height: var(--component-theme-editor-preview-popover-row-height);
    width: 100%;
    border-radius: var(--hud-control-radius);
    background: var(--component-theme-editor-preview-popover-row-bg);
    opacity: var(--component-theme-editor-preview-popover-row-opacity);
  }
  .prv-popover-row.short { width: var(--component-theme-editor-preview-popover-row-short-width); }
  .prv-popover-row.active {
    background: var(--component-theme-editor-preview-popover-row-active-bg);
    opacity: var(--component-theme-editor-preview-popover-row-active-opacity);
  }

  .prv-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--component-theme-editor-preview-grid-gap);
    flex-shrink: 0;
  }
  .prv-card {
    border-radius: var(--component-theme-editor-preview-card-radius);
    border: 1px solid var(--component-theme-editor-preview-card-border);
    background: var(--component-theme-editor-preview-card-bg);
    overflow: hidden;
    transition: border-color var(--component-theme-editor-transition-fast);
  }
  .prv-card.active-card { border-color: var(--component-theme-editor-preview-card-active-border); }
  .prv-cover {
    height: var(--component-theme-editor-preview-cover-height);
    background: var(--component-theme-editor-preview-cover-bg);
  }
  .prv-card-line {
    height: var(--component-theme-editor-preview-card-line-height);
    margin: var(--component-theme-editor-preview-card-line-margin);
    border-radius: var(--component-theme-editor-preview-bar-radius);
    background: var(--component-theme-editor-preview-card-line-bg);
    opacity: var(--component-theme-editor-preview-card-line-opacity);
  }

  .prv-reader {
    flex: 1; min-height: 0;
    border-radius: var(--component-theme-editor-preview-reader-radius);
    border: 1px solid var(--component-theme-editor-preview-reader-border);
    background: var(--component-theme-editor-preview-reader-bg);
    display: flex; align-items: center; justify-content: center;
    position: relative;
    overflow: hidden;
  }
  .prv-page {
    width: var(--component-theme-editor-preview-page-width);
    height: var(--component-theme-editor-preview-page-height);
    background: var(--component-theme-editor-preview-page-bg);
    border-radius: var(--component-theme-editor-preview-page-radius);
  }
  .prv-reader-chrome {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: var(--hud-control-height);
    background: var(--component-theme-editor-preview-reader-chrome-bg);
    border-bottom: 1px solid var(--component-theme-editor-preview-pane-border);
  }
  .prv-reader-chrome.bottom {
    top: auto;
    bottom: 0;
    border-top: 1px solid var(--component-theme-editor-preview-pane-border);
    border-bottom: none;
  }

  .prv-chapter-row {
    display: flex;
    align-items: center;
    gap: var(--component-theme-editor-preview-chapter-gap);
    padding: var(--component-theme-editor-preview-chapter-padding);
    border-radius: var(--hud-chapter-row-radius);
    border: 1px solid var(--component-theme-editor-preview-card-border);
    background: var(--component-theme-editor-preview-card-bg);
  }
  .prv-status-pill {
    font-family: var(--component-theme-editor-label-font);
    font-size: var(--component-theme-editor-preview-control-font-size);
    letter-spacing: var(--component-theme-editor-status-pill-letter-spacing);
    color: var(--accent-fg);
    border: 1px solid var(--hud-selection-border);
    border-radius: var(--hud-status-radius);
    background: var(--hud-selection-bg);
    padding: var(--component-theme-editor-status-pill-padding);
  }
  .prv-progress-track {
    flex: 1;
    height: var(--hud-progress-height);
    border-radius: var(--radius-full);
    background: var(--component-theme-editor-preview-progress-bg);
    overflow: hidden;
  }
  .prv-progress-track span {
    display: block;
    height: 100%;
    width: var(--component-theme-editor-preview-progress-fill-width);
    background: var(--component-theme-editor-preview-progress-fill-bg);
  }

  .prv-toast {
    flex-shrink: 0;
    display: flex; align-items: center; gap: var(--component-theme-editor-preview-toast-gap);
    padding: var(--component-theme-editor-preview-toast-padding);
    border-radius: var(--hud-toast-radius);
    background: var(--component-theme-editor-preview-toast-bg);
    border: 1px solid var(--component-theme-editor-preview-toast-border);
  }
  .prv-toast-dot {
    width: var(--component-theme-editor-preview-toast-dot-size);
    height: var(--component-theme-editor-preview-toast-dot-size);
    border-radius: var(--radius-full);
    background: var(--component-theme-editor-preview-toast-dot-bg);
    flex-shrink: 0;
  }
  .prv-toast-lines { flex: 1; }

  /* Swatch strip */
  .te-swatches {
    display: flex;
    gap: var(--component-theme-editor-swatch-gap);
    flex-wrap: wrap;
    flex-shrink: 0;
  }
  .te-swatch {
    width: var(--component-theme-editor-swatch-size);
    height: var(--component-theme-editor-swatch-size);
    border-radius: var(--component-theme-editor-swatch-radius);
    border: 1px solid var(--component-theme-editor-swatch-border);
    flex-shrink: 0; cursor: default;
  }

  /* ── Editor pane ──────────────────────────────────────────────────────────── */
  .te-editor-pane {
    flex: 1; overflow-y: auto;
    padding: var(--component-theme-editor-editor-padding);
    display: flex;
    flex-direction: column;
    gap: var(--component-theme-editor-editor-gap);
  }
  .te-editor-pane::-webkit-scrollbar { width: var(--component-theme-editor-scrollbar-width); }
  .te-editor-pane::-webkit-scrollbar-track { background: transparent; }
  .te-editor-pane::-webkit-scrollbar-thumb {
    background: var(--component-theme-editor-scrollbar-thumb-bg);
    border-radius: var(--radius-full);
  }

  .te-editor-tabs {
    display: flex;
    gap: var(--component-theme-editor-tabs-gap);
    padding: var(--component-theme-editor-tabs-padding);
    border: 1px solid var(--component-theme-editor-tabs-border);
    border-radius: var(--component-theme-editor-tabs-radius);
    background: var(--component-theme-editor-tabs-bg);
    width: fit-content;
  }
  .te-editor-tabs button,
  .te-motion-btn {
    font-family: var(--component-theme-editor-label-font);
    font-size: var(--component-theme-editor-tab-font-size);
    letter-spacing: var(--component-theme-editor-tab-letter-spacing);
    text-transform: uppercase;
    color: var(--component-theme-editor-tab-fg);
    border: 1px solid var(--component-theme-editor-tab-border);
    border-radius: var(--component-theme-editor-tab-radius);
    padding: var(--component-theme-editor-tab-padding);
    transition:
      color var(--component-theme-editor-transition-fast),
      border-color var(--component-theme-editor-transition-fast),
      background var(--component-theme-editor-transition-fast);
  }
  .te-editor-tabs button:hover,
  .te-motion-btn:hover {
    color: var(--component-theme-editor-tab-hover-fg);
    border-color: var(--component-theme-editor-tab-hover-border);
  }
  .te-editor-tabs button.active,
  .te-motion-btn.active {
    color: var(--component-theme-editor-tab-active-fg);
    border-color: var(--component-theme-editor-tab-active-border);
    background: var(--component-theme-editor-tab-active-bg);
  }

  .te-group {
    display: flex;
    flex-direction: column;
    gap: var(--component-theme-editor-group-gap);
  }

  .te-preset-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--component-theme-editor-preset-grid-gap);
  }
  .te-preset-card {
    display: flex;
    flex-direction: column;
    gap: var(--component-theme-editor-preset-card-gap);
    align-items: flex-start;
    padding: var(--component-theme-editor-preset-card-padding);
    border-radius: var(--component-theme-editor-preset-card-radius);
    border: 1px solid var(--component-theme-editor-preset-card-border);
    background: var(--component-theme-editor-preset-card-bg);
    text-align: left;
    transition:
      border-color var(--component-theme-editor-transition-normal),
      background var(--component-theme-editor-transition-normal);
  }
  .te-preset-card:hover {
    border-color: var(--component-theme-editor-preset-card-hover-border);
    background: var(--component-theme-editor-preset-card-hover-bg);
  }
  .te-preset-title {
    font-size: var(--component-theme-editor-preset-title-font-size);
    color: var(--component-theme-editor-preset-title-fg);
    font-weight: var(--component-theme-editor-preset-title-weight);
  }
  .te-preset-desc {
    font-family: var(--component-theme-editor-label-font);
    font-size: var(--component-theme-editor-preset-desc-font-size);
    letter-spacing: var(--component-theme-editor-preset-desc-letter-spacing);
    color: var(--component-theme-editor-preset-desc-fg);
    line-height: var(--component-theme-editor-preset-desc-line-height);
  }

  .te-motion-row {
    display: flex;
    align-items: center;
    gap: var(--component-theme-editor-motion-row-gap);
    flex-wrap: wrap;
  }

  .te-group-label {
    font-family: var(--component-theme-editor-label-font);
    font-size: var(--component-theme-editor-label-font-size);
    letter-spacing: var(--component-theme-editor-label-letter-spacing);
    text-transform: uppercase;
    color: var(--component-theme-editor-label-fg);
    padding-bottom: var(--component-theme-editor-group-label-padding-bottom);
    margin-bottom: var(--component-theme-editor-group-label-margin-bottom);
    border-bottom: 1px solid var(--component-theme-editor-group-label-border);
  }

  .te-token-list {
    display: flex;
    flex-direction: column;
    gap: var(--component-theme-editor-token-list-gap);
  }

  .te-token-row {
    display: flex;
    align-items: center;
    gap: var(--component-theme-editor-token-row-gap);
    padding: var(--component-theme-editor-token-row-padding);
    border-radius: var(--component-theme-editor-token-row-radius);
    transition: background var(--component-theme-editor-transition-fast);
  }
  .te-token-row:hover { background: var(--component-theme-editor-token-row-hover-bg); }
  .te-slider-row { gap: var(--component-theme-editor-slider-row-gap); }

  .te-color-swatch {
    width: var(--component-theme-editor-color-swatch-size);
    height: var(--component-theme-editor-color-swatch-size);
    border-radius: var(--component-theme-editor-color-swatch-radius);
    flex-shrink: 0;
    border: 1px solid var(--component-theme-editor-color-swatch-border);
    box-shadow: var(--component-theme-editor-color-swatch-shadow);
    position: relative;
    cursor: pointer;
  }
  .te-color-picker-input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: var(--component-theme-editor-hidden-opacity);
    cursor: pointer;
    padding: 0;
    border: 0;
  }
  .te-shape-swatch {
    background: var(--component-theme-editor-shape-swatch-bg);
    border-color: var(--component-theme-editor-shape-swatch-border);
  }

  .te-token-name {
    flex: 1;
    font-size: var(--component-theme-editor-token-name-font-size);
    color: var(--component-theme-editor-token-name-fg);
  }

  .te-token-key {
    font-family: var(--component-theme-editor-label-font);
    font-size: var(--component-theme-editor-token-key-font-size);
    letter-spacing: var(--component-theme-editor-token-key-letter-spacing);
    color: var(--component-theme-editor-token-key-fg);
    flex-shrink: 0; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: var(--component-theme-editor-token-key-max-width);
  }

  .te-hex-input {
    width: var(--component-theme-editor-hex-input-width);
    flex-shrink: 0;
    font-family: var(--component-theme-editor-label-font);
    font-size: var(--component-theme-editor-hex-input-font-size);
    letter-spacing: var(--component-theme-editor-hex-input-letter-spacing);
    color: var(--component-theme-editor-hex-input-fg);
    background: var(--component-theme-editor-hex-input-bg);
    border: 1px solid var(--component-theme-editor-hex-input-border);
    border-radius: var(--component-theme-editor-hex-input-radius);
    padding: var(--component-theme-editor-hex-input-padding);
    outline: none;
    transition:
      border-color var(--component-theme-editor-transition-fast),
      color var(--component-theme-editor-transition-fast);
  }
  .te-hex-input:focus {
    border-color: var(--component-theme-editor-input-focus-border);
    color: var(--component-theme-editor-hex-input-focus-fg);
  }

  .te-range-input {
    width: var(--component-theme-editor-range-width);
    flex-shrink: 0;
  }
  .te-slider-value {
    width: var(--component-theme-editor-slider-value-width);
    flex-shrink: 0;
    font-family: var(--component-theme-editor-label-font);
    font-size: var(--component-theme-editor-slider-value-font-size);
    letter-spacing: var(--component-theme-editor-slider-value-letter-spacing);
    color: var(--component-theme-editor-slider-value-fg);
    text-align: right;
  }

</style>
