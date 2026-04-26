# Aethon Mockup V2 Implementation Prompt for Antigravity Gemini 3.1

## Role

You are refining the **true V2 HTML mockups** for Aethon, a desktop manga and novel reader app.

Your task is **not** to redesign the app and **not** to implement anything in the real app.

Your task is only to:

- work on the **V2 mockup HTML files**
- add missing buttons, controls, options, menus, and secondary actions that already exist in the real app
- adapt those controls so they fit the existing V2 mockup design
- if a control already exists, verify whether it is in the correct place
- if a control exists but is misplaced, reposition it
- if a control does not exist, create it inside the HTML/CSS/JS mockup

Do **not** treat older non-V2 mockups as relevant. They are not the source of truth for this task.

## Important Clarification

Only the mockup files with **`v2` in the filename** are the real targets.

These are the true mockups to work on:

- `library-archive-v2.html`
- `home-v2.html`
- `browse-v2.html`
- `series-detail-v2.html`
- `reader-v2.html`
- `downloads-v2.html`
- `settings-v2.html`

Folder:

`C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\docs\mockups\stitch-nocturne-isolated\`

Ignore the older non-V2 HTML files unless you need them only for comparison.

## Objective

Use the current **V2 mockups** as the visual base and make them functionally closer to the real app by implementing the real controls inside the mockups.

Focus on **buttons, options, popovers, controls, menus, selectors, and toolbar logic**.

Do not rewrite the page structure unless a control is clearly in the wrong place.

Preserve as much of the current V2 visual work as possible.

## Hard Rules

- Do **not** modify the real app.
- Do **not** edit files outside `docs/mockups/stitch-nocturne-isolated`.
- Do **not** redesign the whole page.
- Do **not** replace the existing V2 visual identity.
- Do **not** invent new product features.
- Do **not** remove any control that exists in the real app.
- If a control from the real app is missing in the V2 mockup, create it.
- If a control already exists in the V2 mockup, verify whether it is placed correctly.
- If a control is misplaced, move it.
- Keep the work focused on **implementing and adapting controls**, not on rebuilding layouts from zero.
- Preserve the current mockup hierarchy unless the real app hierarchy is clearly better.
- Use simple HTML/CSS/JS solutions.

## Scope

This task is only about implementing the **real app's buttons/options/controls** in the **V2 mockups**.

This is **not** a request to:

- recreate the real app
- port to Svelte
- port to Tauri
- change app code
- redesign every page from scratch
- rebuild the overall mockup system

## Source of Truth

The functional truth must come from the real app.

Use these real app files as reference for what controls and options should exist:

- `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src\App.svelte`
- `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src\components\layout\Sidebar.svelte`
- `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src\components\pages\Home.svelte`
- `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src\components\pages\Library.svelte`
- `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src\components\library\LibraryToolbar.svelte`
- `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src\components\library\LibraryDisplayPopover.svelte`
- `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src\components\library\BooksTypeSelector.svelte`
- `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src\components\pages\Search.svelte`
- `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src\components\pages\SeriesDetail.svelte`
- `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src\components\reader\Reader.svelte`
- `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src\components\pages\BookDetail.svelte`
- `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src\components\reader\BookReader.svelte`
- `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src\components\pages\Downloads.svelte`
- `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src\components\settings\Settings.svelte`

## Implementation Strategy

Implement in phases.

Do not try to fix every page at once.

### Phase 1: Library V2

Target:

- `library-archive-v2.html`

Goal:

- implement and adapt the missing library controls
- preserve the current V2 look as much as possible
- focus on toolbar controls, popovers, selectors, and options

### Phase 2: Series Detail V2

Target:

- `series-detail-v2.html`

Goal:

- implement and adapt the missing series-detail controls
- focus on action buttons, chapter controls, sort/view/download logic, and selection controls

### Phase 3: Reader V2

Target:

- `reader-v2.html`

Goal:

- implement and adapt the missing reader controls
- focus on top bar, bottom bar, zoom, fit, reading direction, page style, bookmark, progress, and download-related controls

### Phase 4: Remaining V2 Pages

Targets:

- `home-v2.html`
- `browse-v2.html`
- `downloads-v2.html`
- `settings-v2.html`

Goal:

- add and adapt missing controls from the app
- improve placement conservatively

## Functional Inventory to Implement or Verify

### Library V2

Ensure the V2 library mockup contains or correctly places:

- `Comics / Books`
- search
- sort mode
- sort direction
- filter
- layout / view
- density / items per row
- `show progress`
- `show outlines`
- books type selector

### Series Detail V2

Ensure the V2 series-detail mockup contains or correctly places:

- back
- continue / read
- in-library toggle
- details
- tracking
- link / migrate
- folder / category picker
- sort mode
- sort direction
- scanlator filter
- list / grid
- refresh
- download actions
- chapter selection bar
- chapter context actions
- pagination
- jump / range controls

### Reader V2

Ensure the V2 reader mockup contains or correctly places:

- close
- previous chapter
- next chapter
- fit mode
- zoom out
- zoom popover
- zoom in
- reset zoom
- reading direction
- page style
- offset double spreads
- page gap
- auto next
- mark on next
- bookmark
- page slider / progress
- download modal trigger
- chapter webview fallback

### Home V2

Ensure the V2 home mockup contains or correctly places:

- hero resume
- hero navigation
- pinned slots
- picker modal
- browse shortcut
- source shortcut
- library shortcut
- recent activity shortcuts
- history shortcuts

### Browse V2

Ensure the V2 browse mockup contains or correctly places:

- `Keyword / Browse / Source`
- `Featured / Tag`
- `Browse / Extensions`
- query
- advanced
- languages
- tags
- AND / OR
- popular / latest

### Downloads V2

Ensure the V2 downloads mockup contains or correctly places:

- pause / resume
- clear queue
- remove queued item

### Settings V2

Ensure the V2 settings mockup contains or correctly places:

- left nav sections
- toggles
- selects
- theme controls
- categories controls
- tracking auth controls
- storage / backup controls
- security / proxy / FlareSolverr controls
- content filters
- updates / dev tools

## Hierarchy Guidance

The current app hierarchy is already decent.

Analyze it and improve only if clearly beneficial.

What that means:

- keep primary actions visible
- group related actions together
- move only clearly secondary actions into menus or popovers when needed
- avoid hiding important actions
- avoid overcomplicating toolbars
- avoid turning the mockups into a redesign exercise

## Design Guidance

Preserve the current V2 visual direction:

- desktop-first
- current Nocturne styling
- conservative refinement
- subtle motion
- no overdesign
- no heavy sci-fi treatment
- no generic glassmorphism replacement

When adding missing controls:

- adapt them to the existing V2 style
- do not add controls that look visually foreign to the page
- do not rebuild components unnecessarily if the existing styling can be extended

## Acceptance Criteria

The work is correct only if:

- only `*v2.html` mockups are treated as the real targets
- the implementation stays inside the mockup folder
- missing real-app controls are added to the V2 mockups
- existing controls are checked and repositioned if necessary
- visual identity stays aligned with the current V2 mockups
- hierarchy is improved conservatively
- no real app code is modified

## Output Format

After finishing each phase, report:

1. **Preserved**
   - what was intentionally kept

2. **Added**
   - what controls/options/buttons were added

3. **Moved**
   - what controls were repositioned

4. **Adjusted**
   - what was adapted visually to match the V2 mockup style

5. **Unresolved**
   - what still needs manual review

## Final Reminder

Only implement the real app's buttons, options, and controls in the **V2 HTML mockups**.

Do not treat the older non-V2 mockups as the real target.

Do not work on the app itself.

Focus on:

- implementing missing controls
- verifying existing controls
- repositioning controls when necessary
- adapting them to the current V2 design
