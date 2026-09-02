# Epigraph Functional First Run Mockup Plan

**Goal:** Demonstrate a first-run flow that performs useful setup through the real conceptual boundaries already present in Epigraph.

**Architecture:** A standalone interactive prototype imports the generated built-in theme tokens and uses a tested immutable state module. The prototype models theme selection, three exclusive entry paths, conditional discovery, and resumable progress without changing production behavior.

**Spec:** `docs/design/first-run-experience-spec.md`

## Implemented slices

1. Theme selection using all built-in Epigraph themes.
2. Entry routing between device sync, one-or-more backups, and clean manual setup.
3. Backup inspection/review that restores contained dependencies and skips manual repositories.
4. Manual repository URL entry with same-page catalog loading, extension details, and installation.
5. Search/popular discovery only for an empty library.
6. Deferred shell state that resumes the exact unfinished task.

## Verification

- Unit-test every state transition and branch with Node's test runner.
- Exercise sync, multi-backup, manual source, discovery, defer, and resume flows in a browser.
- Check the original brand asset and generated theme CSS load without console errors.
- Validate 720 px and 390 px layouts without horizontal overflow.
- Preserve focus movement, semantic progress, visible focus, and reduced-motion behavior.
