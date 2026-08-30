# Toast Production Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved Nocturne toast mockup in the production `Toaster` while preserving every existing toast behavior and the library-update progress treatment.

**Architecture:** Keep the existing Svelte toast state, timers, actions, announcement roles, and library progress data flow. Replace only the presentation layer with the mockup's tokenized frame, semantic Phosphor-compatible icons, fixed toast geometry, aligned copy/actions, animated border glow, and inline library progress track.

**Tech Stack:** Svelte 5, TypeScript, CSS custom-property tokens, Vitest, Testing Library for Svelte, Playwright screenshots.

**Spec:** `docs/mockups/toast-redesign.html` and `docs/screenshots/toast-redesign-mockup.png`

## Global Constraints

- Use the Nocturne token stack for colors, typography, spacing, geometry, motion, and progress values.
- Preserve `success`, `error`, `info`, and `download` semantics, regular toast actions, multi-actions, dismissal, timers, and `libraryUpdateProgress`.
- Preserve localized runtime copy; do not add hardcoded production user-facing strings.
- Keep every production toast at the standardized mockup height and width without clipping descriptions, actions, or progress content.
- Do not stage unrelated worktree edits or generated debug screenshots unless explicitly required by this feature.

### Task 1: Lock the approved geometry and semantic icon contract with tests

**Files:**
- Modify: `src/components/shared/baseThemeComponents.test.ts`
- Modify: `src/styles/tokens.css`

- [ ] **Step 1: Write failing assertions** for the production toast height token, animated frame pseudo-elements, semantic regular icon paths, aligned action geometry, and library progress structure.
- [ ] **Step 2: Run the focused test** with `pnpm exec vitest run --project shell-jsdom src/components/shared/baseThemeComponents.test.ts` and confirm it fails because production still uses the old toast presentation.

### Task 2: Implement the mockup in the production Toaster

**Files:**
- Modify: `src/components/layout/Toaster.svelte`
- Modify: `src/styles/tokens.css`
- Modify: `src/styles/nocturne-theme.css`

- [ ] **Step 1: Add the shared standardized toast-height token with a safe base value and Nocturne value.
- [ ] **Step 2: Replace line-icon paths with the same regular semantic glyph paths used by the approved mockup.
- [ ] **Step 3: Apply the mockup's fixed geometry, aligned copy/action column, dark Nocturne surface mask, clipped one-pixel semantic rail, animated conic glow, and reduced-motion fallback.
- [ ] **Step 4: Keep the existing Svelte data flow and localization, including the library title, body, progress track/fill, and stop action.
- [ ] **Step 5: Run the focused test again and confirm it passes.

### Task 3: Render and compare the production component

**Files:**
- Create: `docs/screenshots/toaster-production-validation.png` (generated evidence only; do not commit unless the repository tracks validation captures)

- [ ] **Step 1: Run the Svelte component test suite for toast behavior and token contracts.
- [ ] **Step 2: Run the app build/type checks.
- [ ] **Step 3: Use Playwright to render the real app toast stack or the approved mockup fixture and verify every card is the same size, aligned, and free of border leakage.

### Task 4: Audit the complete worktree and commit only verified scope

**Files:**
- Review: all modified and untracked files reported by `git status --short`

- [ ] **Step 1: Inspect the staged diff, secrets, and unrelated artifacts.
- [ ] **Step 2: Run the required full verification commands and record exit codes.
- [ ] **Step 3: Stage only the production toast implementation, its tests/tokens, and intentionally tracked documentation.
- [ ] **Step 4: Commit with `feat: ship standardized nocturne toasts` after all checks pass.
