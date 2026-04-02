# Status

## Current Phase
Phase 3A: low-risk audit fixes

## Completed Today
- Cloned the upstream Moku repository into `Aethon`.
- Inspected the main repository areas without editing application source files.
- Created the initial project documentation scaffold.
- Applied a first-pass safe rebrand in approved visible surfaces only.
- Validated the frontend desktop baseline with `npm exec pnpm` and documented the exact local dev path.
- Fixed the Settings modal so sidebar navigation closes it instead of leaving it over the next route.
- Aligned the native runtime window title with `Aethon` after confirming config-level title sources were already correct.

## Last Completed Step
Apply the two low-risk audit fixes and verify them in the real desktop app.

## Exact Next Prompt
Implement Phase 3B only: prepare a first-run desktop onboarding plan for Aethon based on the audit findings, keep it strictly scoped to discovery and UX planning, preserve Apache-2.0 attribution, and do not change reader behavior, integrations, dependencies, or platform scope.

## Blockers
- Fresh profiles still start without extension repositories seeded by default, which limits first-run source availability until repos are added.
- Cookie/WebView-dependent extensions are still limited by unimplemented desktop-client auth flows.
- FlareSolverr-dependent sources still require the external FlareSolverr service when those sources are used.

## Files/Directories That Must Not Be Touched Next
- `src/components/reader/`
- `src/components/pages/`
- `src/lib/queries.ts`
- `src-tauri/src/`
- `src-tauri/tauri.windows.conf.json`
- `dev.moku.app.yml`
- `packaging/`
- `src-tauri/binaries/`
- `src/store/`

## Notes For Future Codex Sessions
- Preserve upstream license obligations and attribution.
- Keep milestones small and update `docs/STATUS.md` and `docs/DECISIONS.md` after each milestone.
- Do not start feature work until an explicit phase prompt approves it.
- Leave risky identifier renames and packaging behavior changes for a separate, explicit phase.
- Use `npm exec pnpm` as the fallback local path when `pnpm` is not installed globally.
