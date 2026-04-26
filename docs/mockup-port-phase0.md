# Mockup Port Phase 0

## Scope

This document freezes the initial port contract for the approved 1:1 mockup migration.

Visual source of truth:
- `docs/mockups/aethon-selected-icon/splash-concept-a-v4-particles.html`
- `docs/mockups/stitch-nocturne-isolated/settings-v3.html`
- `docs/mockups/stitch-nocturne-isolated/library-archive-v3.html`
- `docs/mockups/stitch-nocturne-isolated/series-detail-v3.html`
- `docs/mockups/stitch-nocturne-isolated/reader-v3.html`

Behavioral source of truth:
- `src/store/state.svelte.ts`
- existing screen components and their live queries, handlers, stores, and Tauri integrations

Locked implementation order:
1. Splash
2. Settings
3. Library
4. Series Detail
5. Reader

## CSS Strategy Freeze

Shared mockup-derived structural styles live in:
- `src/styles/nocturne-port.css`

Rules:
- shared selectors must be intentionally namespaced under screen roots
- screen-local styles are allowed only for rules that are unique to a single screen
- global selectors are not allowed as patch shortcuts for screen-specific mistakes
- the imported mockup DOM remains the structural source of truth

Screen roots:
- `.aethon-port--splash`
- `.aethon-port--settings`
- `.aethon-port--library`
- `.aethon-port--series`
- `.aethon-port--reader`

## Screenshot Environment Freeze

Browser Mode environment is frozen to:
- browser: Chromium
- headless: `true`
- viewport: `1280x800`
- device pixel ratio: `1`
- reduced motion: `reduce`
- color scheme: `dark`
- deterministic font loading before capture

Current repo note:
- the installed Browser Mode stack is `vitest@2.1.8` and `@vitest/browser@2.1.8`
- this version exposes locator screenshots but does not expose the newer typed `toMatchScreenshot()` matcher contract found in later Vitest Browser releases
- parity work will still freeze the browser environment now, and screenshot matcher adoption will stay behind the current package boundary until the repo explicitly upgrades that stack

## Modal Primitive Decision

This port uses a custom modal shell, not native `<dialog>`.

Required modal behavior:
- background subtree becomes `inert`
- focus enters the modal on open
- focus is trapped while open
- `Escape` closes where appropriate
- opener focus returns on close
- no click-through
- no orphaned listeners

## HTML Validity Audit

Initial audit result:
- no compile-blocking browser-repaired structures were found in the top-level shells of the approved mockups during the first pass
- any minimum Svelte-specific fixes discovered during per-screen porting must be recorded in the visual exception table below

Rules:
- only the minimum structural fix is allowed
- visible output must stay unchanged

## Asset Freeze

Fonts and typography language:
- current app tokens remain authoritative for the runtime font stack
- mockup typography hierarchy, casing, and spacing remain visually authoritative

Frozen visual assets already selected:
- splash mark: `docs/mockups/aethon-selected-icon/package/splash/mark.png`
- structural design language from `docs/mockups/stitch-nocturne-isolated/nocturne-base.css`

Frozen visual language:
- radii: soft large-radius shells, rounded pills, rounded cards
- borders: soft low-contrast lines with lavender-tinted focus accents
- shadows: restrained depth, no bright bloom drift outside approved mockups
- motion: slow ambient movement, subtle shimmer, conservative shell transitions

## Binding Matrix

| Screen | Mockup Element | Svelte Target | Real Source of Truth | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| Splash | splash stage shell | `src/components/layout/SplashScreen.svelte` | splash props from `App.svelte` and `store.settings` | adapted | visual port, existing startup flow rebound |
| Splash | state dock | `src/components/layout/SplashScreen.svelte` | `mode`, `ringFull`, `failed`, `notConfigured`, `statusText` | real | keep live state announcements |
| Splash | pin state | `src/components/layout/SplashScreen.svelte` | `store.settings.appLockEnabled`, `store.settings.appLockPin` | real | visual shell from mockup, behavior from app |
| Settings | grouped rail | `src/components/settings/Settings.svelte` | runtime settings tab + existing actions | pending | mockup shell must stay literal |
| Settings | contextual subnav | `src/components/settings/Settings.svelte` | current tab state and handlers | pending | extra controls can stay inert if needed |
| Library | segmented header and toolbar | `src/components/pages/Library.svelte`, `src/components/library/LibraryToolbar.svelte` | library section, search, sort, filter, density, display state | pending | popover geometry must stay literal |
| Series Detail | hero and chapter shell | `src/components/pages/SeriesDetail.svelte` | manga, chapters, selection, downloads, filters | pending | chapter list must not be redesigned |
| Reader | chrome and modal shell | `src/components/reader/Reader.svelte` | reader engine, navigation, zoom, fit, bookmark, downloads | pending | control surface only; engine remains authoritative |

## Inert Control Table

| Screen | Control | Reason Inert | Future Hookup |
| --- | --- | --- | --- |
| Splash | none currently planned | n/a | n/a |

This table must grow per screen as inert controls are introduced.

## Visual Exception Table

| Screen | Deviation | Why Required | Impact |
| --- | --- | --- | --- |
| Splash | pending | only if Svelte-validity or real binding forces a minimal change | must be recorded during implementation |

## State Matrix

### Splash
- initial boot
- loading
- ready
- failure
- pin lock
- dismiss-ready / exit-ready

### Settings
- default group
- group switch
- contextual subnav switch
- long content
- action state
- modal/editor open

### Library
- comics
- books
- loading
- empty
- search active
- filtered empty
- sort active
- density/layout changes
- popover open/closed

### Series Detail
- loading
- sparse metadata
- chapter list loaded
- no chapters
- selection mode
- downloads visible
- filter/sort state

### Reader
- reading
- loading
- chapter changing
- overlay open
- overlay closed
- fallback action visible
- bookmark state
- download modal open
- direction/style/fit variants

## Test Matrix Freeze

### Cheap smoke
- `shell-jsdom` only for structure and logic smoke

### Authoritative parity gates
- Browser Mode under the frozen screenshot environment
- Tauri runtime sanity in the real app window

### Tauri runtime sanity checks
- overlays
- focus return
- keyboard flow
- window-level interactions
- Tauri command / plugin / IPC paths touched by the ported controls
- real webview console errors
- unhandled promise rejections
- new runtime warnings

### Svelte warning gate
- `pnpm exec svelte-check` must stay clean for every completed phase
- any new warning introduced by the port is a failure unless narrowly documented inline

## Phase Gates

No phase passes unless:
- structure/logic smoke passes
- Browser Mode parity checks pass within the frozen environment
- Tauri runtime sanity passes
- no new frontend runtime errors appear in the real Tauri window
- no new Svelte warnings are introduced
