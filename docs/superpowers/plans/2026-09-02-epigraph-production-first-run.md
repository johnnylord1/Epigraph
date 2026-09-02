# Epigraph Production First Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the approved first-run experience into the desktop app, execute setup through existing production surfaces, persist completion, and prevent the wizard from reopening after completion.

**Architecture:** Add a small, versioned first-run state machine to the existing persisted store. A focused Svelte wizard owns theme, routing, progress and completion while embedding the existing Syncd, Settings, Sources and Search components for real operations. Existing installations without first-run metadata are treated as already complete; only a clean store enters onboarding.

**Tech Stack:** Svelte 5, TypeScript, Vitest/jsdom, existing Epigraph theme tokens and production integrations.

**Spec:** `docs/design/first-run-experience-spec.md`

## Global Constraints

- Show onboarding only for a clean install; legacy persisted stores must not be interrupted.
- Persist every step and completion in `epigraph-store`.
- Completion must survive a second app launch.
- Use the existing theme registry, Syncd panel, backup restore, extension/source and tracking flows.
- Preserve the existing Nocturne token system, focus behavior and reduced-motion support.
- Do not alter unrelated startup, server lifecycle or profile behavior.

---

### Task 1: Persisted first-run contract

**Files:**
- Create: `src/lib/firstRun.ts`
- Create: `src/lib/firstRun.test.ts`
- Modify: `src/store/state.svelte.ts`

**Interfaces:**
- Produces: `FirstRunState`, `createFirstRunState()`, `normalizeFirstRunState(savedStore)`, store methods `setFirstRunStep`, `setFirstRunPath`, `completeFirstRun`.

- [ ] **Step 1: Write the failing tests** for clean install, legacy install, saved in-progress state, invalid state recovery, completion and second launch.
- [ ] **Step 2: Run** `pnpm test:unit -- src/lib/firstRun.test.ts` and confirm failure because the module does not exist.
- [ ] **Step 3: Implement the minimal pure state contract** and connect it to the existing root persistence effect.
- [ ] **Step 4: Run** `pnpm test:unit -- src/lib/firstRun.test.ts` and confirm all contract tests pass.

### Task 2: Production wizard and embedded setup surfaces

**Files:**
- Create: `src/components/firstRun/FirstRun.svelte`
- Create: `src/components/firstRun/FirstRun.test.ts`
- Modify: `src/components/settings/Settings.svelte`

**Interfaces:**
- Consumes: persisted first-run store actions and existing `SyncdConnectionPanel`, `SourcesView`, `Search`, and `Settings` production components.
- Produces: `onComplete` callback and an embedded Settings mode limited to backup or tracking.

- [ ] **Step 1: Write failing component tests** proving theme application, exclusive path routing, accessible progress, completion and resume from persisted step.
- [ ] **Step 2: Run** `pnpm test:unit -- src/components/firstRun/FirstRun.test.ts` and confirm the missing component failure.
- [ ] **Step 3: Implement the tokenized wizard shell** with the approved hierarchy, transitions, responsive layout and reduced-motion fallback.
- [ ] **Step 4: Add embedded Settings modes** that reuse the real backup restore and tracker login panes without showing the full settings navigation.
- [ ] **Step 5: Embed Syncd, Sources and Search** and keep advancement explicit so failed operations remain on the current task.
- [ ] **Step 6: Run** `pnpm test:unit -- src/components/firstRun/FirstRun.test.ts` and confirm the component tests pass.

### Task 3: Startup gate and second-use regression

**Files:**
- Modify: `src/App.svelte`
- Create: `src/FirstRunGate.test.ts`

**Interfaces:**
- Consumes: `store.firstRun.status` and lazy-loaded `FirstRun.svelte`.
- Produces: app startup branch that renders onboarding only when pending.

- [ ] **Step 1: Write a failing integration test** that mounts the startup gate with an empty store, completes onboarding, remounts with the persisted store and observes the normal application shell.
- [ ] **Step 2: Run** `pnpm test:unit -- src/FirstRunGate.test.ts` and confirm it fails before App owns the gate.
- [ ] **Step 3: Add a lazy first-run branch to App** after startup is healthy and before the normal layout.
- [ ] **Step 4: Run focused tests**, then `pnpm build`, `git diff --check`, and the relevant existing navigation/theme tests.
- [ ] **Step 5: Smoke test clean first launch and second launch** in the desktop/web runtime, checking console errors, keyboard focus and completion persistence.
- [ ] **Step 6: Review and commit only the first-run integration** with a descriptive feature commit.

## Self-review

- Spec coverage: clean install, legacy install, resume, completion, theme, sync, backup, sources/extensions, trackers and discovery each map to a task.
- Placeholder scan: no implementation placeholders remain; each task names concrete files, behavior and verification.
- Type consistency: the wizard and App consume the same `FirstRunState` stored by Task 1.
