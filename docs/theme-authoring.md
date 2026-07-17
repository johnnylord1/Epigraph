# Theme Authoring

## Contract

Aethon theme authoring follows one dependency direction:

```text
Primitive tokens
    -> Semantic tokens
        -> Component tokens
```

`ThemeDocumentV5` is the persisted and exported authoring format. It contains only:

```ts
interface ThemeDocumentV5 {
  version: 5;
  id: `custom:${string}`;
  name: string;
  base: BuiltinTheme;
  primitives: ThemePrimitiveTokens;
  semanticOverrides?: Partial<ThemeSemanticTokens>;
  hud?: Partial<HudThemeTokens>;
  motion: ThemeMotionPreset;
}
```

Primitive and semantic maps are sparse. Primitive changes automatically update linked semantic roles. A semantic value is persisted only when it deliberately differs from that derivation. Values equal to the selected base are omitted when the document is saved or exported. Component tokens are never authored, persisted, imported, exported, or promoted. They remain derived by the shared design system.

Every registered built-in has one complete authoring contract in
`BUILTIN_THEME_CONTRACTS`: 50 theme colors, 15 HUD values, and one motion
preset. Document creation, resolution, reset, and export read this registry;
they do not infer a base contract from the currently active DOM. A browser gate
compares every registry value with the real computed CSS cascade for all
registered built-ins.

Shadow and highlight tint are semantic roles (`color-shadow-source` and
`color-highlight-source`). Authors may override their color, while elevation
geometry, alpha and component composition remain owned by the shared design
system. This keeps shadows responsive to a palette without exposing component
tokens or duplicating theme CSS.

## Official Flow

The supported workflow is:

```text
ThemeEditor -> export -> validation -> promotion
```

1. Open Settings > Appearance > Custom theme editor.
2. Choose colors in the primitive groups.
3. Use Semantic for deliberate role overrides only.
4. Adjust HUD geometry, HUD colors, and motion when needed.
5. Verify the live preview and save the custom theme.
6. Export the V5 JSON document.
7. Run the authoring and visual gates before proposing promotion.

The machine-checkable candidate format and command are documented in
`docs/theme-promotion.md`. Package generation validates the candidate but never
registers or activates it.

When the editor is opened for a new theme, it starts from the active built-in
theme. Editing or importing an existing document preserves its declared
`base`. Reset restores that base contract rather than silently switching the
document to Nocturne.

The ThemeEditor is the official UI. Editing component CSS is not part of theme authoring.

## Import And Compatibility

- V1, V2, V3, and V4 documents are accepted and migrated in memory.
- Legacy documents remain unchanged in storage until the user explicitly saves.
- V4 migration materializes semantic overrides only where necessary to preserve its previous resolved appearance.
- An explicit save writes V5 first and activates it only after persistence succeeds.
- V5 import is validated before it reaches the preview.
- Invalid imports do not modify the active theme or stored documents.

Validation rejects unknown keys, component tokens, CSS rules, `url()`, comments, injection characters, unknown variable references, variable cycles, invalid color expressions, and invalid HUD units.

## Promotion Checklist

A future built-in theme requires only:

1. A valid V5 theme document.
2. Registry metadata: stable id, label, description, and four representative swatches.
3. A complete registry contract matching the built-in CSS cascade.
4. Nocturne-comparable screenshots for Library, Browse, Settings, Reader, modal, popover, and toast.
5. WCAG AA evidence for the required text and control pairs.
6. Green contract, browser, build, and whitespace gates.

No component CSS should be added for a theme. If a proposed palette cannot render an active component through the existing primitive and semantic contract, the missing semantic role must be added to the shared design system first and validated for every theme.

## Required Checks

```powershell
pnpm test:unit -- src/lib/theme/authoringGate.test.ts src/lib/theme/document.test.ts src/lib/theme/provider.test.ts src/lib/theme/themeGate.test.ts
pnpm exec vitest run --project browser-components src/lib/theme/themeProbe.browser.test.ts
pnpm theme:validate-promotion -- path/to/candidate.json
pnpm build
git diff --check
```

The synthetic theme probe is test-only. It proves that active surfaces respond to the contract and must not be registered as a user-selectable theme.

## Scope Boundaries

- Keep the `--n-*` compatibility layer until its separate removal audit is complete.
- Keep Legacy components and aliases documented; do not activate or delete them as part of theme authoring.
- Syncd remains outside this consolidation plan.
- Preserve layout, behavior, data, and domain logic while adding or validating themes.
