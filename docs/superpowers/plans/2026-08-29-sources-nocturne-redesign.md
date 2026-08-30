# Sources Nocturne Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved full-area Browse > Sources mockup and restyle the selected-extension panel to the same compact Nocturne visual language.

**Architecture:** Preserve `SourcesView.svelte` as the owner of extension loading, filters, operations, repositories, and selected-extension state. Recompose its markup into a page header, compact list workspace, overview rail, dedicated updates state, and full-height layout; keep `ExtensionSettingsPanel.svelte` as the inline contextual pane and expose the existing remove operation through its action list.

**Tech Stack:** Svelte 5, TypeScript, Vitest, Testing Library, Phosphor Svelte, existing `--component-sources-*` tokens.

**Spec:** `docs/mockups/browse-sources-redesign.html`

## Global Constraints

- Desktop Nocturne theme only for the approved visual reference; consume component tokens and introduce no raw colors.
- Preserve all existing manga and novel extension operations, repositories, preferences, compatibility checks, migration, loading, empty, and error states.
- Preserve current translations and use existing localized strings for visible labels.
- Match the mockup's full usable width and height, compact type and icons, flat rows, overview rail, updates state, and inline extension details.
- Preserve unrelated dirty-worktree changes.

---

### Task 1: Lock the redesigned Sources behavior with failing tests

**Files:**
- Modify: `src/components/pages/BrowseV3.test.ts`
- Modify: `src/components/pages/SourcesThemeTokens.test.ts`

**Interfaces:**
- Consumes: existing Browse Sources fixtures and `SourcesView.svelte` behavior.
- Produces: DOM contracts `data-sources-workspace`, `data-sources-overview`, `data-sources-updates-view`, and a panel-owned remove action.

- [ ] **Step 1: Add a failing workspace-state test**

Add a test that opens Sources, asserts the overview rail is present, activates Updates, asserts the dedicated update view replaces the overview, then returns to Installed.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test:unit -- src/components/pages/BrowseV3.test.ts --maxWorkers=1 --minWorkers=1`

Expected: FAIL because the workspace data contracts and dedicated update view do not exist.

- [ ] **Step 3: Add a failing selected-extension action test**

Open MangaDex, assert the inline settings pane is present, trigger its Remove action, and expect the existing uninstall runtime call.

- [ ] **Step 4: Run the focused test and verify RED**

Run the same focused test command.

Expected: FAIL because removal is still owned only by the list row.

### Task 2: Implement the full-area Sources workspace

**Files:**
- Modify: `src/components/pages/SourcesView.svelte`

**Interfaces:**
- Consumes: `filter`, `updateCount`, `filtered`, existing operation functions, and localized strings.
- Produces: compact list rows, overview actions, dedicated update layout, full-height geometry, and the settings-panel remove callback.

- [ ] **Step 1: Recompose header and toolbar**

Keep repository/APK controls in the page header and move filters/search into the list toolbar.

- [ ] **Step 2: Add overview and update states**

Show the overview rail only when no extension is selected and the active filter is not Updates. Render Updates as a full-width state using real extension data and existing update actions.

- [ ] **Step 3: Flatten extension rows**

Remove the table header, package/repository/status capsules, and installed-row removal button. Keep icon, name, language, state icon, variants, and required install/update actions.

- [ ] **Step 4: Apply the full-area Nocturne layout**

Use the existing Sources tokens for all colors and surfaces. Fill the available height, keep compact typography/icons, and preserve responsive fallbacks.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm test:unit -- src/components/pages/BrowseV3.test.ts src/components/pages/SourcesThemeTokens.test.ts --maxWorkers=1 --minWorkers=1`

Expected: PASS.

### Task 3: Redesign the extension settings pane

**Files:**
- Modify: `src/components/pages/ExtensionSettingsPanel.svelte`
- Modify: `src/components/pages/SourcesView.svelte`
- Modify: `src/components/pages/SourcePreferences.test.ts`

**Interfaces:**
- Consumes: `ManagedExtension`, compatibility and preference contracts, `onMassMigration`, `onCheckCompatibility`, and new `onRemove` callback.
- Produces: flat identity header, language/version facts, compact preferences, action rows, collapsed technical details, and removal from the pane.

- [ ] **Step 1: Add the typed remove callback**

Extend the panel props with `onRemove(extension)` and pass the existing Sources removal operation.

- [ ] **Step 2: Recompose panel markup**

Keep identity and facts visible; move package/artifact metadata into progressive disclosure; present migration, compatibility, and removal as flat action rows.

- [ ] **Step 3: Flatten panel styles**

Remove pill metadata and nested card styling, retain focus states, scroll behavior, small-screen sheet behavior, and token-only colors.

- [ ] **Step 4: Run preference and Browse tests**

Run: `pnpm test:unit -- src/components/pages/SourcePreferences.test.ts src/components/pages/BrowseV3.test.ts src/components/pages/SourcesThemeTokens.test.ts --maxWorkers=1 --minWorkers=1`

Expected: PASS.

### Task 4: Visual and production verification

**Files:**
- Update generated screenshots only when they are explicit test artifacts expected by the repository.

**Interfaces:**
- Consumes: production Sources page and approved mockup.
- Produces: test, build, and rendered visual evidence.

- [ ] **Step 1: Run Svelte validation**

Run: `pnpm exec svelte-check --tsconfig ./tsconfig.json`

- [ ] **Step 2: Run focused tests**

Run the focused Sources and Browse test command from Task 3.

- [ ] **Step 3: Build production frontend**

Run: `pnpm build`

- [ ] **Step 4: Render and inspect Sources states**

Capture installed, updates, and selected-extension states at 1280x800. Compare geometry, density, icons, token colors, and panel alignment against `docs/screenshots/browse-sources-full-area.png` and `docs/screenshots/browse-sources-updates-full-area.png`.

- [ ] **Step 5: Check diff hygiene**

Run: `git diff --check` and review only the touched Sources files plus the plan.

- [ ] **Step 6: Commit the verified implementation**

Stage only the Sources implementation, tests, required translations/tokens if any, the approved mockup, final evidence, and this plan. Commit with `feat: align Sources with compact Nocturne workspace`.
