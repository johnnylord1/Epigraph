# Theme Promotion

## Purpose

The promotion gate converts one exported `ThemeDocumentV5` plus metadata and
real visual evidence into a deterministic review package. It validates a
future built-in theme without registering it, changing component CSS, or
modifying user data.

Promotion remains an explicit code review step. The command never edits
`BUILTIN_THEMES`, `BUILTIN_THEME_CONTRACTS`, theme CSS, or the active theme.

## Candidate Format

Create a repository-local JSON file with this shape:

```json
{
  "document": {
    "version": 5,
    "id": "custom:example",
    "name": "Example",
    "base": "nocturne",
    "primitives": {},
    "motion": "soft"
  },
  "metadata": {
    "id": "example",
    "label": "Example",
    "description": "Short description for the built-in theme picker.",
    "swatches": ["#111111", "#222222", "#eeeeee", "#888888"]
  },
  "evidence": {
    "library": "docs/screenshots/example/library.png",
    "browse": "docs/screenshots/example/browse.png",
    "settings": "docs/screenshots/example/settings.png",
    "reader": "docs/screenshots/example/reader.png",
    "modal": "docs/screenshots/example/modal.png",
    "popover": "docs/screenshots/example/popover.png",
    "toast": "docs/screenshots/example/toast.png"
  }
}
```

Rules:

- `document` must already be V5 and must differ from its declared base.
- The future built-in id must be lowercase kebab-case and must not already be registered.
- Four unique six-digit hex swatches are required and must come from the resolved theme contract.
- All seven evidence paths must be distinct repository-relative PNG files under `docs/screenshots/`.
- Component tokens, CSS rules, unknown variables, unsafe values, invalid HUD units, and cycles remain forbidden by the V5 validator.

## Validation

Validate and print the package:

```powershell
pnpm theme:validate-promotion -- path/to/candidate.json
```

Validate and write a review package:

```powershell
pnpm theme:validate-promotion -- path/to/candidate.json --out path/to/package.json
```

The generated package contains:

- schema version;
- normalized metadata;
- canonical sparse V5 authoring document;
- complete resolved ThemeTokens, HudThemeTokens, and motion contract;
- normalized evidence paths.

The package is review input, not a runtime theme. Do not commit generated
packages unless a promotion review explicitly requests one.

## Promotion Review

Before registering a future built-in:

1. Run the promotion command and review the complete resolved contract.
2. Run unit, browser, WCAG AA, build, and whitespace gates.
3. Compare every submitted screenshot with the Nocturne reference surfaces.
4. Confirm no component CSS or component token is introduced.
5. Add registry metadata and the reviewed contract in one selective change.
6. Verify computed CSS parity before making the theme selectable.

If a surface cannot respond through primitive or semantic tokens, stop the
promotion. Add the missing shared semantic role and validate every existing
built-in before retrying.
