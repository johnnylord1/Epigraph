<script lang="ts">
  import { X, FloppyDisk, UploadSimple, DownloadSimple, ArrowLeft, Trash } from "phosphor-svelte";
  import {
    store, updateSettings, saveCustomTheme, deleteCustomTheme,
    type CustomTheme,
    type HudThemeTokens,
    type ThemeMotionPreset,
    type ThemeTokens,
    DEFAULT_HUD_THEME_TOKENS,
    DEFAULT_THEME_TOKENS,
    NOCTURNE_HUD_THEME_TOKENS,
    NOCTURNE_THEME_TOKENS,
    THEME_MOTION_VARS,
  } from "../../store/state.svelte";

  interface Props {
    editingId?: string | null;
    onClose: () => void;
  }

  let { editingId = $bindable(null), onClose }: Props = $props();
  type EditorTab = "colors" | "hud";

  // ── Token group definitions ───────────────────────────────────────────────

  const TOKEN_GROUPS: { label: string; tokens: (keyof ThemeTokens)[] }[] = [
    {
      label: "Backgrounds",
      tokens: ["bg-void", "bg-base", "bg-surface", "bg-raised", "bg-overlay", "bg-subtle"],
    },
    {
      label: "Borders",
      tokens: ["border-dim", "border-base", "border-strong", "border-focus"],
    },
    {
      label: "Text",
      tokens: ["text-primary", "text-secondary", "text-muted", "text-faint", "text-disabled"],
    },
    {
      label: "Accent",
      tokens: ["accent", "accent-dim", "accent-muted", "accent-fg", "accent-bright"],
    },
    {
      label: "Semantic",
      tokens: ["color-error", "color-error-bg", "color-success", "color-info", "color-info-bg"],
    },
  ];

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
    "accent":        "Accent",
    "accent-dim":    "Accent dim",
    "accent-muted":  "Accent muted",
    "accent-fg":     "Accent foreground",
    "accent-bright": "Accent bright",
    "color-error":    "Error",
    "color-error-bg": "Error background",
    "color-success":  "Success",
    "color-info":     "Info",
    "color-info-bg":  "Info background",
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
  }[] = [
    {
      id: "default",
      label: "Default HUD",
      description: "Matches the current compact Aethon shell",
      hud: DEFAULT_HUD_THEME_TOKENS,
      motion: "soft",
    },
    {
      id: "nocturne",
      label: "Nocturne HUD",
      description: "Compact lunar controls for the new identity",
      hud: NOCTURNE_HUD_THEME_TOKENS,
      tokens: NOCTURNE_THEME_TOKENS,
      motion: "soft",
    },
  ];

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

  function loadInitial(): { name: string; tokens: ThemeTokens; hud: HudThemeTokens; motion: ThemeMotionPreset } {
    if (editingId) {
      const existing = store.settings.customThemes.find(t => t.id === editingId);
      if (existing) {
        return {
          name: existing.name,
          tokens: { ...DEFAULT_THEME_TOKENS, ...existing.tokens },
          hud: { ...DEFAULT_HUD_THEME_TOKENS, ...(existing.hud ?? {}) },
          motion: existing.motion ?? "soft",
        };
      }
    }
    return {
      name: "My Theme",
      tokens: { ...DEFAULT_THEME_TOKENS },
      hud: { ...DEFAULT_HUD_THEME_TOKENS },
      motion: "soft",
    };
  }

  const initial = loadInitial();
  let themeName: string   = $state(initial.name);
  let tokens: ThemeTokens = $state(initial.tokens);
  let hud: HudThemeTokens = $state(initial.hud);
  let motion: ThemeMotionPreset = $state(initial.motion);
  let editorTab: EditorTab = $state("colors");
  let saveStatus: "idle" | "saved" = $state("idle");
  let importError: string | null   = $state(null);

  // ── CSS vars helper ───────────────────────────────────────────────────────
  function toCssVars(t: ThemeTokens, h: HudThemeTokens = hud, m: ThemeMotionPreset = motion): string {
    return [
      ...Object.entries(t).map(([k, v]) => `--${k}: ${v};`),
      ...Object.entries(h).map(([k, v]) => `--${k}: ${v};`),
      ...Object.entries(THEME_MOTION_VARS[m] ?? {}).map(([k, v]) => `${k}: ${v};`),
      "--sidebar-width: var(--hud-sidebar-width);",
    ].join(" ");
  }

  function parseHudNumber(token: keyof HudThemeTokens): number {
    return Number.parseFloat(String(hud[token]).replace("px", "")) || Number.parseFloat(DEFAULT_HUD_THEME_TOKENS[token]) || 0;
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
    const theme: CustomTheme = { id, name, tokens: { ...tokens }, hud: { ...hud }, motion, version: 2 };
    saveCustomTheme(theme);
    updateSettings({ theme: id });
    editingId = id;
    saveStatus = "saved";
    setTimeout(() => (saveStatus = "idle"), 1800);
  }

  function handleDelete() {
    if (!editingId) { onClose(); return; }
    if (!confirm(`Delete theme "${themeName}"? This cannot be undone.`)) return;
    deleteCustomTheme(editingId);
    onClose();
  }

  function handleExport() {
    const data: CustomTheme = {
      id:     editingId ?? "custom:export",
      name:   themeName.trim() || "Untitled Theme",
      tokens: { ...tokens },
      hud:    { ...hud },
      motion,
      version: 2,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${data.name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-theme.json`;
    a.click();
    URL.revokeObjectURL(url);
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
        const data = JSON.parse(text);
        if (!data.tokens || typeof data.tokens !== "object") throw new Error("Invalid theme file — missing tokens");
        if (typeof data.name === "string") themeName = data.name;
        tokens      = { ...DEFAULT_THEME_TOKENS, ...data.tokens };
        hud         = { ...DEFAULT_HUD_THEME_TOKENS, ...(data.hud ?? {}) };
        motion      = (data.motion === "minimal" || data.motion === "soft" || data.motion === "expressive") ? data.motion : "soft";
        importError = null;
      } catch (e: any) {
        importError = e.message ?? "Could not parse theme file";
        setTimeout(() => (importError = null), 3000);
      }
    };
    inp.click();
  }

  function resetToDefaults() {
    tokens = { ...DEFAULT_THEME_TOKENS };
    hud = { ...DEFAULT_HUD_THEME_TOKENS };
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
    aria-label="Theme editor"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
  >

    <!-- ── Header ──────────────────────────────────────────────────────── -->
    <header class="te-header">
      <div class="te-header-left">
        <button class="te-icon-btn" onclick={onClose} title="Close editor">
          <ArrowLeft size={14} weight="bold" />
        </button>
        <input
          bind:value={themeName}
          class="te-name-input"
          placeholder="Theme name"
          maxlength={40}
          spellcheck={false}
        />
      </div>

      <div class="te-header-actions">
        {#if importError}
          <span class="te-import-err">{importError}</span>
        {/if}
        <button class="te-action-btn" onclick={handleImport} title="Import from JSON">
          <UploadSimple size={13} />
          <span>Import</span>
        </button>
        <button class="te-action-btn" onclick={handleExport} title="Export as JSON">
          <DownloadSimple size={13} />
          <span>Export</span>
        </button>
        <button class="te-action-btn te-ghost" onclick={resetToDefaults} title="Reset all to dark defaults">
          Reset
        </button>
        {#if editingId}
          <button class="te-action-btn te-danger" onclick={handleDelete} title="Delete theme">
            <Trash size={13} />
          </button>
        {/if}
        <button class="te-save-btn" class:saved={saveStatus === "saved"} onclick={handleSave}>
          <FloppyDisk size={13} />
          <span>{saveStatus === "saved" ? "Saved!" : "Save Theme"}</span>
        </button>
        <button class="te-icon-btn" onclick={onClose} title="Close">
          <X size={14} weight="bold" />
        </button>
      </div>
    </header>

    <!-- ── Body ───────────────────────────────────────────────────────── -->
    <div class="te-body">

      <!-- Left: live preview -->
      <aside class="te-preview-pane">
        <div class="te-pane-label">Live Preview</div>

        <!--
          FIX 1: toCssVars scoped only to this element, so only the
          preview UI sees the draft tokens — not the editor shell.
        -->
        <div class="te-preview-ui" style={toCssVars(tokens)}>
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
                <div class="prv-bar" style="width:52px;background:var(--text-secondary);opacity:0.45"></div>
                <div class="prv-bar" style="width:18px;background:var(--accent)"></div>
              </div>
              <div class="prv-toolbar">
                <span class="prv-control active">Sort</span>
                <span class="prv-control">Filter</span>
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
                <span class="prv-status-pill">READING</span>
                <span class="prv-progress-track"><span></span></span>
              </div>
              <div class="prv-toast">
                <div class="prv-toast-dot"></div>
                <div class="prv-toast-lines">
                  <div class="prv-bar" style="width:80%;background:var(--text-secondary)"></div>
                  <div class="prv-bar" style="width:55%;background:var(--text-faint);margin-top:3px"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Swatch strip — scoped to draft tokens too -->
        <div class="te-swatches" style={toCssVars(tokens)}>
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
          <button class:active={editorTab === "colors"} onclick={() => (editorTab = "colors")}>Colors</button>
          <button class:active={editorTab === "hud"} onclick={() => (editorTab = "hud")}>HUD</button>
        </div>

        {#if editorTab === "colors"}
          {#each TOKEN_GROUPS as group}
            <div class="te-group">
              <div class="te-group-label">{group.label}</div>
              <div class="te-token-list">
                {#each group.tokens as token}
                  <div class="te-token-row">
                    <span class="te-color-swatch" style="background: {tokens[token]}"></span>
                    <span class="te-token-name">{TOKEN_LABELS[token]}</span>
                    <span class="te-token-key">{token}</span>
                    <input
                      type="text"
                      class="te-hex-input"
                      value={tokens[token]}
                      spellcheck={false}
                      oninput={(e) => {
                        const v = (e.target as HTMLInputElement).value.trim();
                        if (/^#[0-9a-fA-F]{3,8}$/.test(v)) tokens = { ...tokens, [token]: v };
                      }}
                      onblur={(e) => {
                        const v = (e.target as HTMLInputElement).value.trim();
                        if (!/^#[0-9a-fA-F]{3,8}$/.test(v)) {
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
            <div class="te-group-label">HUD preset</div>
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
            <div class="te-group-label">Motion</div>
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
            <div class="te-group-label">HUD geometry</div>
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
            <div class="te-group-label">HUD colors</div>
            <div class="te-token-list">
              {#each ["hud-selection-bg", "hud-selection-border"] as token}
                <div class="te-token-row">
                  <span class="te-color-swatch" style="background: {hud[token as keyof HudThemeTokens]}"></span>
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
    background: rgba(0, 0, 0, 0.72);
    z-index: 200;
    /* FIX 2: center the modal instead of stretch */
    display: flex; align-items: center; justify-content: center;
    animation: teBackdropIn 0.14s ease both;
  }
  @keyframes teBackdropIn { from { opacity: 0; } to { opacity: 1; } }

  /* ── Shell ────────────────────────────────────────────────────────────────── */
  .te-shell {
    /* FIX 2: constrained dimensions so it doesn't fill the screen */
    width: calc(100% - 48px);
    max-width: 1100px;
    height: calc(100% - 48px);
    max-height: 760px;
    display: flex; flex-direction: column;
    background: var(--bg-base);
    border: 1px solid var(--border-base);
    border-radius: 10px;
    animation: teShellIn 0.2s cubic-bezier(0.22, 1, 0.36, 1) both;
    overflow: hidden;
  }
  @keyframes teShellIn {
    from { transform: translateY(10px) scale(0.99); opacity: 0; }
    to   { transform: translateY(0) scale(1);       opacity: 1; }
  }

  /* ── Header ───────────────────────────────────────────────────────────────── */
  .te-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 0 16px; height: 46px;
    border-bottom: 1px solid var(--border-dim);
    background: var(--bg-surface);
    flex-shrink: 0;
  }

  .te-header-left {
    display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;
  }

  .te-icon-btn {
    display: flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border-radius: 5px;
    color: var(--text-muted);
    transition: color 0.1s, background 0.1s;
    flex-shrink: 0;
  }
  .te-icon-btn:hover { color: var(--text-primary); background: var(--bg-overlay); }

  .te-name-input {
    flex: 1; min-width: 0;
    background: none; border: none; outline: none;
    font-family: var(--font-sans); font-size: 13px; font-weight: 500;
    color: var(--text-primary);
    border-bottom: 1px solid transparent;
    padding: 3px 0;
    transition: border-color 0.12s;
  }
  .te-name-input:focus { border-color: var(--border-focus); }
  .te-name-input::placeholder { color: var(--text-faint); }

  .te-header-actions {
    display: flex; align-items: center; gap: 6px; flex-shrink: 0;
  }

  .te-import-err {
    font-family: var(--font-ui); font-size: 11px; letter-spacing: 0.04em;
    color: var(--color-error); flex-shrink: 0;
  }

  .te-action-btn {
    display: flex; align-items: center; gap: 5px;
    font-family: var(--font-ui); font-size: 11px; letter-spacing: 0.06em;
    padding: 4px 10px; border-radius: 4px;
    border: 1px solid var(--border-dim);
    background: none; color: var(--text-muted);
    cursor: pointer; flex-shrink: 0;
    transition: color 0.1s, border-color 0.1s, background 0.1s;
  }
  .te-action-btn:hover { color: var(--text-secondary); border-color: var(--border-strong); }

  .te-ghost { border-color: transparent; }
  .te-ghost:hover { border-color: var(--border-dim); }

  .te-danger { color: var(--color-error); border-color: transparent; }
  .te-danger:hover { background: var(--color-error-bg); border-color: var(--color-error); }

  .te-save-btn {
    display: flex; align-items: center; gap: 5px;
    font-family: var(--font-ui); font-size: 11px; letter-spacing: 0.06em;
    padding: 5px 14px; border-radius: 4px;
    border: 1px solid var(--accent-dim);
    background: var(--accent-muted); color: var(--accent-fg);
    cursor: pointer; flex-shrink: 0;
    transition: filter 0.1s, background 0.12s;
  }
  .te-save-btn:hover { filter: brightness(1.12); }
  .te-save-btn.saved { background: var(--accent-dim); border-color: var(--accent); }

  /* ── Body ─────────────────────────────────────────────────────────────────── */
  .te-body { flex: 1; overflow: hidden; display: flex; min-height: 0; }

  /* ── Preview pane ─────────────────────────────────────────────────────────── */
  .te-preview-pane {
    width: 260px; flex-shrink: 0;
    border-right: 1px solid var(--border-dim);
    background: var(--bg-void);
    display: flex; flex-direction: column;
    padding: 16px; gap: 12px;
  }

  .te-pane-label {
    font-family: var(--font-ui); font-size: 10px;
    letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--text-faint);
    flex-shrink: 0;
  }

  /* te-preview-ui receives draft CSS vars via inline style */
  .te-preview-ui {
    flex: 1; min-height: 0;
    border-radius: 8px; overflow: hidden;
    border: 1px solid var(--border-base);
    display: flex; background: var(--bg-void);
  }

  /* Sidebar strip */
  .prv-sidebar {
    width: 34px; flex-shrink: 0;
    background: var(--bg-surface);
    border-right: 1px solid var(--border-dim);
    display: flex; flex-direction: column;
    align-items: center; padding: 12px 0; gap: 9px;
  }
  .prv-sb-dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: var(--text-faint); opacity: 0.4;
    transition: background 0.15s, opacity 0.15s;
  }
  .prv-sb-dot.active { background: var(--accent); opacity: 1; }

  .prv-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

  .prv-titlebar {
    height: 26px; flex-shrink: 0;
    background: var(--bg-raised);
    border-bottom: 1px solid var(--border-dim);
    display: flex; align-items: center; padding: 0 8px; gap: 7px;
  }
  .prv-win-dots { display: flex; gap: 4px; }
  .prv-win-dots span { width: 6px; height: 6px; border-radius: 50%; background: var(--border-strong); }
  .prv-win-title { font-family: var(--font-ui); font-size: 9px; letter-spacing: 0.1em; color: var(--text-faint); }

  .prv-content {
    flex: 1; overflow: hidden;
    padding: 8px; display: flex; flex-direction: column; gap: 7px;
    background: var(--bg-base);
  }

  .prv-row { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .prv-bar { height: 3px; border-radius: 2px; }

  .prv-toolbar {
    display: flex; align-items: center; gap: var(--hud-toolbar-gap);
    flex-shrink: 0;
  }
  .prv-control {
    display: inline-flex; align-items: center; justify-content: center;
    height: var(--hud-control-height);
    padding: 0 9px;
    border-radius: var(--hud-control-radius);
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
    color: var(--text-faint);
    font-family: var(--font-ui);
    font-size: 8px;
    letter-spacing: 0.08em;
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
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
  }

  .prv-popover {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 78px;
    padding: 6px;
    border: 1px solid var(--border-base);
    border-radius: var(--hud-popover-radius);
    background: color-mix(in srgb, var(--bg-overlay) calc(var(--hud-surface-opacity) * 100%), transparent);
  }
  .prv-popover-row {
    height: 5px;
    width: 100%;
    border-radius: var(--hud-control-radius);
    background: var(--text-faint);
    opacity: 0.55;
  }
  .prv-popover-row.short { width: 62%; }
  .prv-popover-row.active { background: var(--accent-fg); opacity: 0.9; }

  .prv-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; flex-shrink: 0;
  }
  .prv-card {
    border-radius: 4px; border: 1px solid var(--border-dim);
    background: var(--bg-raised); overflow: hidden;
    transition: border-color 0.15s;
  }
  .prv-card.active-card { border-color: var(--accent); }
  .prv-cover { height: 34px; background: var(--bg-overlay); }
  .prv-card-line { height: 3px; margin: 4px 4px; border-radius: 2px; background: var(--text-faint); opacity: 0.5; }

  .prv-reader {
    flex: 1; min-height: 0;
    border-radius: 4px; border: 1px solid var(--border-dim);
    background: var(--bg-overlay);
    display: flex; align-items: center; justify-content: center;
    position: relative;
    overflow: hidden;
  }
  .prv-page { width: 68%; height: 86%; background: var(--bg-subtle); border-radius: 2px; }
  .prv-reader-chrome {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: var(--hud-control-height);
    background: color-mix(in srgb, var(--bg-void) calc(var(--hud-reader-chrome-opacity) * 100%), transparent);
    border-bottom: 1px solid var(--border-dim);
  }
  .prv-reader-chrome.bottom {
    top: auto;
    bottom: 0;
    border-top: 1px solid var(--border-dim);
    border-bottom: none;
  }

  .prv-chapter-row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px;
    border-radius: var(--hud-chapter-row-radius);
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
  }
  .prv-status-pill {
    font-family: var(--font-ui);
    font-size: 7px;
    letter-spacing: 0.09em;
    color: var(--accent-fg);
    border: 1px solid var(--hud-selection-border);
    border-radius: var(--hud-status-radius);
    background: var(--hud-selection-bg);
    padding: 2px 5px;
  }
  .prv-progress-track {
    flex: 1;
    height: var(--hud-progress-height);
    border-radius: var(--radius-full);
    background: var(--border-strong);
    overflow: hidden;
  }
  .prv-progress-track span {
    display: block;
    height: 100%;
    width: 58%;
    background: var(--accent-fg);
  }

  .prv-toast {
    flex-shrink: 0;
    display: flex; align-items: center; gap: 6px;
    padding: 6px 8px; border-radius: var(--hud-toast-radius);
    background: var(--bg-overlay); border: 1px solid var(--accent-dim);
  }
  .prv-toast-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
  .prv-toast-lines { flex: 1; }

  /* Swatch strip */
  .te-swatches { display: flex; gap: 5px; flex-wrap: wrap; flex-shrink: 0; }
  .te-swatch {
    width: 22px; height: 22px; border-radius: 4px;
    border: 1px solid rgba(255,255,255,0.07);
    flex-shrink: 0; cursor: default;
  }

  /* ── Editor pane ──────────────────────────────────────────────────────────── */
  .te-editor-pane {
    flex: 1; overflow-y: auto;
    padding: 16px 20px;
    display: flex; flex-direction: column; gap: 22px;
  }
  .te-editor-pane::-webkit-scrollbar { width: 4px; }
  .te-editor-pane::-webkit-scrollbar-track { background: transparent; }
  .te-editor-pane::-webkit-scrollbar-thumb {
    background: var(--border-strong); border-radius: 9999px;
  }

  .te-editor-tabs {
    display: flex;
    gap: 6px;
    padding: 3px;
    border: 1px solid var(--border-dim);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    width: fit-content;
  }
  .te-editor-tabs button,
  .te-motion-btn {
    font-family: var(--font-ui);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: 5px 11px;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
  }
  .te-editor-tabs button:hover,
  .te-motion-btn:hover {
    color: var(--text-secondary);
    border-color: var(--border-dim);
  }
  .te-editor-tabs button.active,
  .te-motion-btn.active {
    color: var(--accent-fg);
    border-color: var(--accent-dim);
    background: var(--accent-muted);
  }

  .te-group { display: flex; flex-direction: column; gap: 2px; }

  .te-preset-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .te-preset-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-start;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
    text-align: left;
    transition: border-color 0.12s, background 0.12s;
  }
  .te-preset-card:hover {
    border-color: var(--accent-dim);
    background: var(--accent-muted);
  }
  .te-preset-title {
    font-size: 12px;
    color: var(--text-secondary);
    font-weight: var(--weight-medium);
  }
  .te-preset-desc {
    font-family: var(--font-ui);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--text-faint);
    line-height: 1.4;
  }

  .te-motion-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .te-group-label {
    font-family: var(--font-ui); font-size: 10px;
    letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--text-faint);
    padding-bottom: 7px; margin-bottom: 4px;
    border-bottom: 1px solid var(--border-dim);
  }

  .te-token-list { display: flex; flex-direction: column; gap: 1px; }

  .te-token-row {
    display: flex; align-items: center; gap: 10px;
    padding: 5px 8px; border-radius: 5px;
    transition: background 0.1s;
  }
  .te-token-row:hover { background: var(--bg-raised); }
  .te-slider-row { gap: 8px; }

  .te-color-swatch {
    width: 16px; height: 16px; border-radius: 4px;
    flex-shrink: 0;
    border: 1px solid rgba(255,255,255,0.12);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.2);
  }
  .te-shape-swatch {
    background: var(--accent-muted);
    border-color: var(--accent-dim);
  }

  .te-token-name {
    flex: 1; font-size: 12px; color: var(--text-secondary);
  }

  .te-token-key {
    font-family: var(--font-ui); font-size: 10px;
    letter-spacing: 0.05em; color: var(--text-faint);
    flex-shrink: 0; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 160px;
  }

  .te-hex-input {
    width: 82px; flex-shrink: 0;
    font-family: var(--font-ui); font-size: 11px; letter-spacing: 0.05em;
    color: var(--text-muted);
    background: var(--bg-overlay);
    border: 1px solid var(--border-dim);
    border-radius: 3px; padding: 3px 7px;
    outline: none;
    transition: border-color 0.1s, color 0.1s;
  }
  .te-hex-input:focus { border-color: var(--border-focus); color: var(--text-primary); }

  .te-range-input {
    width: 120px;
    flex-shrink: 0;
  }
  .te-slider-value {
    width: 54px;
    flex-shrink: 0;
    font-family: var(--font-ui);
    font-size: 10px;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    text-align: right;
  }

</style>
