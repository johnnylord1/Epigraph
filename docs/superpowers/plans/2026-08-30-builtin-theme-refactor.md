# Built-in Theme Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every built-in Epigraph theme use the coherent Nocturne material hierarchy while preserving a distinct, accessible palette for each theme.

**Architecture:** Keep `contract.ts` as the authored source for primitive, semantic, HUD, and motion values. Generate built-in CSS from that contract, then tune the shared component fallback layer so non-Nocturne themes use the same restrained material grammar as Nocturne. Protect the result with numeric palette invariants and browser-computed component evidence.

**Tech Stack:** Svelte 5, TypeScript, CSS custom properties, Vitest unit/jsdom/browser projects, Playwright browser provider, Vite.

**Spec:** `docs/superpowers/specs/2026-08-30-builtin-theme-refactor.md`

## Global Constraints

- Preserve the exact Nocturne authored palette and its computed component output.
- Preserve all built-in IDs, settings persistence, custom theme V5 documents, routes, labels, and component markup.
- Keep built-in theme values in `src/lib/theme/contract.ts`; never hand-edit `src/styles/builtin-themes.generated.css`.
- Keep component colors semantic; no new direct hex, rgb, hsl, or named colors in component tokens.
- AMOLED primary surfaces remain true black and normal border contrast remains below 2:1.
- Body text and interactive labels meet WCAG AA, with at least 4.5:1 contrast.
- No new dependency.
- The worktree already contains user changes. Do not commit or stage files unless the user explicitly requests it; use focused diffs and test checkpoints instead.

---

### Task 1: Add measurable theme-quality invariants

**Files:**
- Create: `src/lib/theme/paletteQuality.ts`
- Create: `src/lib/theme/paletteQuality.test.ts`
- Modify: `vitest.workspace.ts`

**Interfaces:**
- Produces: `parseThemeColor(value: string): Rgba`, `relativeLuminance(value: string): number`, and `contrastRatio(foreground: string, background: string): number`.
- Consumes: `BUILTIN_THEME_CONTRACTS`, `BUILTIN_THEME_IDS`, and `ThemeTokens` from `src/lib/theme/contract.ts`.

- [ ] **Step 1: Add the focused test to the unit project include list**

Add `src/lib/theme/paletteQuality.test.ts` beside the existing theme contract tests in `vitest.workspace.ts`.

- [ ] **Step 2: Write failing palette hierarchy tests**

Create tests that enforce these exact behaviors:

```ts
test.each(["nocturne", "dark", "amoled", "high-contrast", "midnight", "warm"] as const)(
  "%s keeps dark surfaces ordered",
  (id) => {
    const tokens = BUILTIN_THEME_CONTRACTS[id].tokens;
    expect(relativeLuminance(tokens["bg-base"])).toBeLessThanOrEqual(relativeLuminance(tokens["bg-surface"]));
    expect(relativeLuminance(tokens["bg-surface"])).toBeLessThanOrEqual(relativeLuminance(tokens["bg-raised"]));
    expect(relativeLuminance(tokens["bg-raised"])).toBeLessThanOrEqual(relativeLuminance(tokens["bg-overlay"]));
  },
);

test("AMOLED uses subtle normal boundaries and visible focus", () => {
  const tokens = BUILTIN_THEME_CONTRACTS.amoled.tokens;
  expect(contrastRatio(tokens["border-base"], tokens["bg-base"])).toBeLessThan(2);
  expect(contrastRatio(tokens["border-focus"], tokens["bg-base"])).toBeGreaterThanOrEqual(3);
});

test.each(BUILTIN_THEME_IDS)("%s keeps text readable on core surfaces", (id) => {
  const tokens = BUILTIN_THEME_CONTRACTS[id].tokens;
  for (const surface of ["color-background", "color-card", "color-modal", "color-popover"] as const) {
    expect(contrastRatio(tokens["text-primary"], tokens[surface])).toBeGreaterThanOrEqual(4.5);
  }
});
```

- [ ] **Step 3: Run the test and confirm the current AMOLED contract fails**

Run:

```powershell
pnpm exec vitest run --project unit src/lib/theme/paletteQuality.test.ts --maxWorkers=1 --minWorkers=1 --reporter=verbose
```

Expected: failure on AMOLED `border-base` contrast and any newly exposed light/status hierarchy violation.

- [ ] **Step 4: Implement the color metrics helper**

Support six-digit hex, three-digit hex, `rgb()`, and `rgba()`. Composite translucent foregrounds over the supplied background before contrast calculation. Throw a descriptive error for unsupported values so invalid theme contracts fail loudly.

- [ ] **Step 5: Run the focused test again**

Expected: parser tests pass while palette assertions remain red until Task 2.

---

### Task 2: Re-author the seven non-Nocturne palettes and HUD defaults

**Files:**
- Modify: `src/lib/theme/contract.ts`
- Modify: `src/lib/theme/contract.test.ts`
- Modify: `src/lib/theme/paletteQuality.test.ts`
- Generate: `src/styles/builtin-themes.generated.css`

**Interfaces:**
- Consumes: the metrics from Task 1.
- Produces: complete `BuiltinThemeContract` entries for all eight built-ins with modern HUD geometry.

- [ ] **Step 1: Freeze Nocturne in a regression assertion**

Add an explicit snapshot object for `NOCTURNE_THEME_TOKENS` and `NOCTURNE_HUD_THEME_TOKENS`. The test must compare every token, not only a subset, so the reference palette cannot drift during this refactor.

- [ ] **Step 2: Add failing HUD shape assertions**

For every built-in, assert:

```ts
expect(contract.hud).toMatchObject({
  "hud-control-height": "28px",
  "hud-icon-button-size": "28px",
  "hud-control-radius": "8px",
  "hud-popover-radius": "12px",
  "hud-status-radius": "9999px",
  "hud-toast-radius": "12px",
  "hud-chapter-row-radius": "9px",
  "hud-progress-height": "2px",
});
```

- [ ] **Step 3: Replace the non-Nocturne primitive ladders**

Use close, ordered surface steps for Dark, Midnight, and Warm; true black primary surfaces for AMOLED; soft off-white steps for Light; and stronger but selective boundaries for both contrast themes. Keep one accent family per theme and provide explicit semantic status foreground/background values for Light, Light Contrast, Midnight, and Warm instead of inheriting Dark defaults.

- [ ] **Step 4: Make modern HUD geometry the shared fallback**

Set `DEFAULT_HUD_THEME_TOKENS` to the Nocturne geometry values. Keep selection background and border derived from each theme's accent via `deriveBuiltinHudThemeTokens()`.

- [ ] **Step 5: Update metadata swatches and descriptions**

Every four-color swatch must come from its resolved contract and represent canvas, raised surface, accent, and primary text. Remove descriptions such as “neon violet” where the new theme intentionally uses a restrained accent.

- [ ] **Step 6: Generate the CSS**

Run:

```powershell
pnpm theme:generate-builtins
pnpm theme:check-builtins
```

Expected: the generated file changes deterministically and the check exits 0.

- [ ] **Step 7: Run contract and quality tests**

Run:

```powershell
pnpm exec vitest run --project unit src/lib/theme/contract.test.ts src/lib/theme/paletteQuality.test.ts src/lib/theme/builtinCss.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
```

Expected: all tests pass.

---

### Task 3: Promote the restrained material grammar to shared component fallbacks

**Files:**
- Modify: `src/styles/tokens.css`
- Modify: `src/lib/theme/componentColorDerivation.test.ts`
- Modify: `src/lib/theme/themeInventory.test.ts` only if the intentional token inventory count changes
- Modify: `src/lib/theme/themeGate.test.ts`

**Interfaces:**
- Consumes: primitive and semantic tokens from Task 2.
- Produces: coherent shared component roles for cards, menus, popovers, modals, buttons, inputs, toasts, status messages, navigation, Settings, Library, Browse, Sources, Downloads, and Reader chrome.

- [ ] **Step 1: Capture Nocturne computed values before shared fallback changes**

Extend the browser probe inventory to capture core Nocturne values for card, modal, menu, button, input, toast, Settings card, Library list card, Browse search, Sources surface, and Reader chrome. These values become the preservation baseline.

- [ ] **Step 2: Add failing fallback material assertions**

Assert that the shared layer:

- derives normal borders from `border-base` or `border-strong` at restrained opacity;
- reserves `color-outline` for focus and selected states;
- derives button and input surfaces from the local surface ladder;
- uses HUD radii for popovers, toasts, status blocks, and chapter rows;
- contains no direct visual colors in migrated component families.

- [ ] **Step 3: Recalibrate the core component aliases**

Change generic card, modal, popover, menu, button, input, and toast aliases so normal boundaries are subtle. Do not copy Nocturne hex values. Use `var()` and `color-mix()` against theme-owned primitives and semantic tokens.

Representative target form:

```css
--component-card-bg: var(--color-card);
--component-card-border: color-mix(in srgb, var(--border-strong) 24%, transparent);
--component-button-bg: color-mix(in srgb, var(--bg-raised) 94%, var(--bg-base));
--component-button-bg-hover: color-mix(in srgb, var(--accent-bright) 8%, var(--bg-overlay));
--component-button-border: color-mix(in srgb, var(--border-strong) 28%, transparent);
--component-input-bg: color-mix(in srgb, var(--bg-raised) 88%, var(--bg-base));
--component-input-border: color-mix(in srgb, var(--border-strong) 30%, transparent);
```

The final percentages may be adjusted only when the browser-computed contrast tests show that a theme misses its hierarchy target.

- [ ] **Step 4: Recalibrate page-family fallbacks**

Audit the active families listed by `themeInventory.test.ts`. Replace fallback roles that use large percentages of `text-secondary`, `color-highlight-source`, or `bg-subtle` as a surface when that creates pale blocks in Dark or outlines in AMOLED. Keep semantic state colors intact.

- [ ] **Step 5: Run the component token gates**

Run:

```powershell
pnpm exec vitest run --project unit src/lib/theme/componentColorDerivation.test.ts src/lib/theme/themeInventory.test.ts src/lib/theme/themeGate.test.ts src/lib/theme/directVisualValuesGate.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
```

Expected: no direct component colors, no unresolved component token, no Nocturne-only token, and no unexplained inventory change.

---

### Task 4: Expand browser-computed theme evidence

**Files:**
- Modify: `src/lib/theme/builtinThemeMatrix.browser.test.ts`
- Modify: `src/test/themeProbe.ts` only if a new semantic probe token is required
- Update: `docs/screenshots/marco44-builtin-matrix/*.png`

**Interfaces:**
- Consumes: final contracts and shared material roles from Tasks 2 and 3.
- Produces: computed contrast checks and one deterministic evidence image per built-in.

- [ ] **Step 1: Replace the simple swatch grid with a component specimen**

The specimen must render:

- application canvas and top bar;
- card and list row;
- primary, secondary, hover, disabled, and focused buttons;
- input and search field;
- menu/popover;
- modal surface;
- success, warning, danger, and information messages;
- toast;
- selected navigation item and progress indicator.

Use only existing CSS custom properties. The specimen is test markup, not production UI.

- [ ] **Step 2: Add computed hierarchy assertions**

For every built-in, check body text and control label contrast at 4.5:1. For AMOLED, check normal boundaries below 2:1 and focus above 3:1. For Light and Light Contrast, assert button/input surfaces differ perceptibly from their immediate parent without becoming darker than the page text hierarchy.

- [ ] **Step 3: Verify empty custom themes remain identical to built-ins**

Retain the current V5 equivalence test and extend it to the new specimen token list.

- [ ] **Step 4: Run the browser matrix**

Run:

```powershell
pnpm exec vitest run --project browser-components src/lib/theme/builtinThemeMatrix.browser.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
```

Expected: eight themes pass and eight evidence PNGs are refreshed.

- [ ] **Step 5: Inspect all eight images at original resolution**

Reject and retune any theme with:

- a pale block that does not communicate elevation;
- a dark control that visually disappears into its parent;
- a full outline around every AMOLED region;
- status colors that resemble the accent instead of their semantic meaning;
- a selected state with unreadable text;
- geometry that differs from Nocturne without an accessibility reason.

---

### Task 5: Validate Settings previews and custom theme compatibility

**Files:**
- Modify: `src/components/settings/ThemeEditorThemeTokens.test.ts`
- Modify: `src/lib/theme/provider.test.ts`
- Modify: `src/lib/theme/document.test.ts` only if a failing compatibility case exposes a real migration issue

**Interfaces:**
- Consumes: built-in metadata, contracts, generated CSS, and shared component fallbacks.
- Produces: stable custom theme inheritance and accurate built-in previews.

- [ ] **Step 1: Test Settings uses the updated registry swatches**

Assert that every displayed built-in is sourced from `BUILTIN_THEMES` and that no local duplicate palette exists in `Settings.svelte` or `ThemeEditor.svelte`.

- [ ] **Step 2: Test V4/V5 and empty V5 compatibility**

For every built-in base, migrate a V4 document and resolve an empty V5 document. Assert all primitive, semantic, HUD, and motion fields resolve and no inline property from the previously active theme leaks into the next theme.

- [ ] **Step 3: Run compatibility tests**

Run:

```powershell
pnpm exec vitest run --project unit src/lib/theme/provider.test.ts src/lib/theme/document.test.ts src/components/settings/ThemeEditorThemeTokens.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
```

Expected: all compatibility tests pass without schema changes.

---

### Task 6: Final theme certification

**Files:**
- Verify only; do not add generated build output.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verification evidence for handoff.

- [ ] **Step 1: Run all theme unit and jsdom tests**

```powershell
pnpm test:unit -- src/lib/theme src/components/settings/ThemeEditorThemeTokens.test.ts
```

- [ ] **Step 2: Run the browser theme suite**

```powershell
pnpm exec vitest run --project browser-components src/lib/theme/builtinThemeMatrix.browser.test.ts src/lib/theme/themeProbe.browser.test.ts src/lib/theme/nocturnePortCompatibility.browser.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
```

- [ ] **Step 3: Run the runtime audit and generated CSS check**

```powershell
pnpm theme:check-builtins
pnpm theme:test-runtime-audit
pnpm theme:audit-runtime
```

- [ ] **Step 4: Run Svelte diagnostics and production build**

```powershell
pnpm exec svelte-check --tsconfig ./tsconfig.json
pnpm build
```

- [ ] **Step 5: Check the diff**

```powershell
git diff --check
git diff -- src/lib/theme src/styles/tokens.css src/styles/builtin-themes.generated.css src/components/settings/ThemeEditorThemeTokens.test.ts vitest.workspace.ts
```

Confirm that unrelated dirty files were not altered by this refactor.

- [ ] **Step 6: Perform manual desktop smoke checks**

Open Home, Library, Browse, Sources, Downloads, Settings, a modal, a popover, a toast, and Reader chrome in all eight built-ins. Verify normal, hover, active, focus, disabled, error, warning, success, and loading states at the supported minimum desktop viewport.

## Plan self-review

- Spec coverage: all seven incorrect built-ins, shared component material, Nocturne preservation, custom themes, Settings previews, generated CSS, accessibility, and visual evidence have explicit tasks.
- Placeholder scan: no deferred implementation placeholder remains.
- Interface consistency: palette metrics are introduced in Task 1 and consumed by Tasks 2 and 4; contracts are authored in Task 2 and consumed by all later tasks; generated CSS is always produced by the existing script.
- Scope boundary: reader content themes, routes, component markup, custom document schema, and Nocturne palette remain unchanged.
