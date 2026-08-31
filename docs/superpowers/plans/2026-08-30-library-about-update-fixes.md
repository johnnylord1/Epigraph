# Library, Activity, and Update Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a coherent Library experience, keep update actions visible on About, and prevent blocked Suwayomi runtimes from entering the install flow.

**Architecture:** Preserve the existing Svelte 5 Nocturne shell and correct behavior at its current ownership boundaries. Library view-models continue to own collection semantics, shared `NocturneState` owns empty-state presentation, Settings owns Epigraph release disclosure, and the Suwayomi panel treats runtime authorization as an invariant across every state transition.

**Tech Stack:** Svelte 5, TypeScript, Vitest, Testing Library, Tauri v2, CSS custom-property theme tokens.

**Spec:** User request in the current Codex task, supported by the two attached screenshots.

## Global Constraints

- Preserve the current Nocturne visual language and existing app navigation.
- Keep Comics and Books as separate domains.
- Base Library collections are Saved, Downloaded, and Finished; custom collections remain available after them.
- Both Library sections use the same `NocturneState` empty-state pattern and true flex centering.
- Books and Comics both report the header total as `{count} Titles`.
- A blocked Suwayomi runtime must remain unable to download or install after any manual or cached update check.
- Preserve all unrelated dirty-worktree changes.

---

### Task 1: Activity overlay stacking regression

**Files:**
- Modify: `src/components/layout/ActivityCenterThemeTokens.test.ts`
- Modify: `src/styles/nocturne-theme.css`

**Interfaces:**
- Consumes: `--component-activity-overlay-z-index`, `--component-library-header-z-index`.
- Produces: an Activity overlay layer that paints above Library header and hero content.

- [ ] Add a failing token-contract test proving the Activity overlay layer is higher than the Library header layer.
- [ ] Run the focused test and confirm the stacking assertion fails against `42 < 50`.
- [ ] Raise the Activity overlay token to the existing modal layer without changing unrelated z-indexes.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Library collection, copy, and empty-state parity

**Files:**
- Modify: `src/lib/library/comicsSection.test.ts`
- Modify: `src/lib/library/comicsSection.ts`
- Modify: `src/components/library/ComicsLibraryBody.test.ts`
- Modify: `src/components/library/ComicsLibraryBody.svelte`
- Modify: `src/components/pages/Library.svelte`

**Interfaces:**
- Consumes: existing Saved/Downloaded/Completed category data and `NocturneState`.
- Produces: Saved, Downloaded, Finished base collections; shared empty-state structure; `{count} Titles` copy for both sections.

- [ ] Add failing tests for stable base collection ordering and Comics empty-state structure.
- [ ] Run focused tests and confirm the missing Finished/base-state behavior and raw Comics message fail.
- [ ] Make Completed/Finished a non-reorderable base collection while leaving custom categories reorderable.
- [ ] Render Comics empty content through the same centered `NocturneState` pattern used by Books.
- [ ] Switch the Books header count to the existing `library.count.titles` message.
- [ ] Re-run focused Library tests and confirm they pass.

### Task 3: Persistent Epigraph update action on About

**Files:**
- Modify: `src/components/settings/Settings.test.ts`
- Modify: `src/components/settings/Settings.svelte`

**Interfaces:**
- Consumes: signed `EpigraphUpdateStatus` and matching release history entry.
- Produces: a compact update-available status and action that remain visible when release history is hidden.

- [ ] Add a failing Settings test that checks an available release, opens history, hides it, and still finds the update action.
- [ ] Run the focused test and confirm the action disappears with the history.
- [ ] Derive the authorized available release and render its status/action outside the collapsible history surface.
- [ ] Keep the history disclosure limited to changelog browsing.
- [ ] Re-run the focused Settings test and confirm it passes.

### Task 4: Suwayomi blocked-update invariant

**Files:**
- Modify: `src/components/settings/SuwayomiUpdatePanel.test.ts`
- Modify: `src/components/settings/SuwayomiUpdatePanel.svelte`

**Interfaces:**
- Consumes: runtime `updateAllowed`, runtime `blockReason`, and update-check `updateAllowed`.
- Produces: Download and Install controls that cannot be enabled unless both runtime and check authorize the update.

- [ ] Add a failing regression test that seeds a blocked runtime plus an update-available check result.
- [ ] Run the focused test and confirm Download becomes enabled or the blocked state is overwritten.
- [ ] Centralize the permission invariant and apply it in check-result transitions, download, and install guards.
- [ ] Re-run the updater tests and confirm the bypass is closed.

### Task 5: Integrated verification and review

**Files:**
- Review all modified files above.

**Interfaces:**
- Consumes: all task outputs.
- Produces: verified frontend behavior with no unrelated modifications.

- [ ] Run all focused tests for Activity, Library, Settings, and Suwayomi updater.
- [ ] Run `pnpm build`.
- [ ] Run `git diff --check` and inspect the final scoped diff.
- [ ] Run the design pre-flight for theme, copy, centering, empty/error states, and button accessibility.
- [ ] Request an independent code review and resolve Critical or Important findings.
