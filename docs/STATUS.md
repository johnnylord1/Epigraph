# Status

## Current Phase
Phase 1: safe rebrand

## Completed Today
- Cloned the upstream Moku repository into `Aethon`.
- Inspected the main repository areas without editing application source files.
- Created the initial project documentation scaffold.
- Applied a first-pass safe rebrand in approved visible surfaces only.

## Last Completed Step
Apply the Phase 1 safe rebrand and update the project documentation.

## Exact Next Prompt For Phase 2
Implement Phase 2 only: stabilize the desktop baseline with small, behavior-preserving fixes and validation improvements, avoid feature expansion, preserve Apache-2.0 attribution, and do not change reader architecture, integrations, dependencies, or platform scope.

## Blockers
- Upstream-facing identifiers, packaging names, updater endpoints, and release metadata still reference Moku and should only be revisited with an explicitly scoped packaging pass.

## Files/Directories That Must Not Be Touched Next
- `src/components/pages/`
- `src/lib/queries.ts`
- `src/store/`
- `src-tauri/src/`
- `src-tauri/tauri.windows.conf.json`
- `dev.moku.app.yml`
- `packaging/`

## Notes For Future Codex Sessions
- Preserve upstream license obligations and attribution.
- Keep milestones small and update `docs/STATUS.md` and `docs/DECISIONS.md` after each milestone.
- Do not start feature work until an explicit phase prompt approves it.
- Leave risky identifier renames and packaging behavior changes for a separate, explicit phase.
