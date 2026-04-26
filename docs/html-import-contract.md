# Aethon Nocturne HTML Import Contract

## Purpose

This is the canonical implementation contract for every approved HTML-to-Svelte/Tauri import in Aethon.

- The approved HTML is the visual source of truth.
- The real app is the behavioral source of truth.
- `1:1` means the same visible output, the same shell hierarchy, and the same perceived behavior.
- `1:1` does **not** mean blindly copying the mockup's internal mechanics when a better technical solution preserves the exact same result.

Every imported screen must be judged on three axes:

1. `shell fidelity`
2. `interaction fidelity`
3. `runtime / performance budget`

## Official Nocturne Briefing

### Typography

- Section titles: `Manrope`, weight `800`, uppercase, `letter-spacing: 0.18em`
- Body labels: `Manrope`, weight `600`
- Hints and descriptions: `Manrope`, `11px`/`12px`, `rgba(202, 196, 208, 0.42)`

### Surfaces and cards

- Cards: `background: rgba(28, 27, 27, 0.6)`
- Card border: `1px solid rgba(72, 69, 79, 0.14)`
- Card radius: `18px`
- Glassmorphism is only allowed where the approved mockup explicitly uses it

### Controls

- Default button radius: `14px`
- Toggle switches must use a sliding thumb
- Toggle `on`: `var(--n-primary-container)`
- Toggle `off`: `rgba(148, 143, 154, 0.2)`
- Row hover for small settings rows: `rgba(184, 167, 234, 0.035)`

## Structural Rules

- Never remount the main shell of the screen.
- Rails, headers, body shells, cards, clusters, popovers, and overlays must preserve the geometry and perceived hierarchy of the approved HTML.
- If the mockup is one screen with internal panes, the port must remain one screen with internal panes.
- Do not convert a single-shell mockup into separate mounted views for convenience.

## Pane Rules

- Light panes may stay mounted.
- Heavy subtrees may use lazy mount only if all of the following remain faithful:
  - fixed shell
  - stable geometry
  - apparent transitions
  - visual and functional continuity
- Navigation panes, filters, subnav, and light content should remain mounted by default.
- Large lists, expensive data panes, rich previews, and complex editors may lazy mount if continuity is preserved.
- The shell must never jump, collapse, or feel like a different screen because a pane was lazily mounted.

## Lazy Continuity Rules

If a heavy pane uses lazy mount, every state needed for continuity must live above the removable subtree or be restored explicitly on remount.

This includes at minimum:

- relevant scroll position
- selection state
- filters
- expansion state
- toolbar context

Lazy mount must never create a perceptible "I lost my place" moment.
If continuity cannot be preserved confidently, do not lazy mount that pane.

## Fidelity Rules

- Prioritize visual and behavioral equivalence, not mechanical equivalence.
- Preserve classes, nesting, and DOM shape as closely as practical.
- Adapt only when needed for:
  - valid Svelte markup
  - accessibility
  - runtime performance
  - continuity preservation
- Do not sacrifice runtime health, accessibility, or maintainability for literalism when the final result would be identical.

## Motion and Interaction Rules

Every import must port three layers together:

1. visual shell
2. state model and hierarchy
3. motion / transitions / affordances

This includes:

- hover
- active
- press
- pane switching
- shimmer / slide / shell enter-exit
- overlay transitions

A button that looks correct but loses its interaction language is not a complete port.

If the mockup changes state inside one shell, the app must preserve that same model.

## Modal and Overlay Rules

Custom modal shells are allowed, but not mandatory.

Use whichever option preserves UX best for a given screen:

- native `<dialog>` when it reduces complexity and preserves focus, inert background, Escape handling, opener focus return, and the approved UX
- custom modal shell when geometry, stacking, anchoring, or motion require tighter control

The decision must be made screen by screen.

Any overlay implementation must guarantee:

- inert background
- correct focus entry
- no focus leak
- correct Escape behavior
- focus return to opener
- no click-through
- no layering conflicts

## Reader Rule

The imported Reader chrome must remain visually `1:1`.
The real reading engine remains authoritative.

Never break:

- real page rendering
- navigation
- zoom / fit / direction / style
- loading / fallback / webview behavior

In Reader, structural fidelity applies to the control surface, not to replacing the engine.

The Reader is a deliberate exception to the main app shell hierarchy:

- `Home`, `Library`, `Search`, `Downloads`, and `Settings` belong to the shared main shell
- `Reader` remains visually and structurally detached from that shell

## Namespacing and CSS Discipline

- Every new style must be scoped under the imported screen root
- Example: `.aethon-port--settings .my-element`
- Never patch global selectors like `button`, `input`, or `div` directly
- Never use broad global selectors to fix a screen-specific mistake
- Do not mix legacy and Nocturne styling in the same component unless that part of the component has not been ported yet

## Logic Preservation Rules

- Existing Svelte state, bindings, store usage, effects, and backend hooks must be moved into the new HTML structure
- Never delete a backend function, persistence flow, or state field without remapping it into the new UI
- The real app logic must remain authoritative even when the markup is fully replaced
- No public API changes are allowed unless explicitly approved
- No global store shape changes are allowed unless explicitly approved

## Inert Control Rules

UI affordances that exist in the mockup but have no real logic yet must:

- stay visible when needed for fidelity
- be marked with `data-inert-control`
- optionally expose `aria-disabled`
- never trigger side effects
- never partially mutate app state
- never silently call broken logic

## Do Not Do This

- Do not remount the main shell for a simple pane switch
- Do not treat one-shell HTML as a set of unrelated mounted views
- Do not use generic colors like pure red, blue, or black when curated Nocturne values exist
- Do not delete and recreate files casually when shell replacement is enough
- Do not patch old CSS with new tokens before the relevant screen phase is actually being ported
- Do not ignore desktop resizing behavior; layouts must still degrade cleanly in smaller windows

## Screen Strategy

### Single-shell screens with internal panes

Examples:

- Settings
- future screens with left rail + subnav + content pane

Rules:

- one stable shell
- sibling panes in the same screen context
- buttons only switch active state
- light panes mounted
- heavy panes may lazy mount only if continuity is preserved

Current Settings policy:

- Always mounted: `general`, `appearance`, `keybinds`, `reader`, `library`, `categories`, `content`, `performance`, `security`, `about`, `devtools`
- Lazy subtree only: `tracking`, `storage`
- Any lazy `tracking` or `storage` subtree must keep scroll, selection, filters, expansion state, and toolbar context above the removable subtree or restore them explicitly on remount

### Toolbar + content + popover screens

Examples:

- Library
- Browse

Rules:

- stable toolbar and content shell
- popovers preserve the mockup's geometry
- filters, density, and layout remain internal screen state
- do not replace custom popover shells with generic dropdowns

### Hero + functional list screens

Examples:

- Series Detail
- future Novel Detail

Rules:

- hero and action rail stay fixed
- list shell stays in the same screen
- selection, bulk actions, and filters stay inside the imported hierarchy
- large lists may lazy hydrate only if perceived continuity is preserved

### Boot or dominant overlay screens

Example:

- Splash

Rules:

- first paint must match the imported shell
- no legacy frame leak
- port the motion engine faithfully in effect, not only in DOM
- real app states and live regions must remain correct

### High-sensitivity runtime screens

Example:

- Reader

Rules:

- preserve shell and chrome
- keep the engine untouched except where the visual shell must bind to it
- overlays, sliders, modals, and controls must respect the mockup
- simplification is allowed only when the final result and behavior are equivalent

## Required Pre-Import Audit

Before importing any new HTML screen:

1. audit the HTML and identify the screen type
2. map the mockup state model
3. decide:
   - mounted panes vs lazy panes
   - `<dialog>` vs custom modal shell
   - literal motion port vs equivalent motion adaptation
4. freeze the screen contract before coding

## Milestone Audit Protocol

For every milestone inside a ported screen:

1. map all existing functions, state, and persistence flows from the old markup
2. replace the relevant HTML with the Nocturne equivalent
3. compare the running app visually with the approved mockup
4. verify the new control changes real Svelte state correctly
5. verify the change persists through the real app/backend path when applicable

## Acceptance Gates

Every imported screen must pass:

1. structure / behavior smoke
2. Browser Mode parity
3. Tauri runtime sanity
4. fidelity review across:
   - shell fidelity
   - interaction fidelity
   - runtime / performance budget
5. lazy continuity checks when lazy mount is used

The screen is not complete unless:

- shell fidelity is preserved
- interaction fidelity is preserved
- runtime is clean
- no new warnings are introduced
- any lazy mount preserves continuity perceptibly
