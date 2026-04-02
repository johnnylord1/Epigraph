# Status

## Current Phase
Phase 2: desktop validation baseline

## Completed Today
- Cloned the upstream Moku repository into `Aethon`.
- Inspected the main repository areas without editing application source files.
- Created the initial project documentation scaffold.
- Applied a first-pass safe rebrand in approved visible surfaces only.
- Validated the frontend desktop baseline with `npm exec pnpm` and documented the exact local dev path.

## Last Completed Step
Validate the desktop baseline, document the exact commands, and record the remaining native prerequisites.

## Exact Next Prompt For Phase 3
Implement Phase 3 only: investigate and bootstrap the minimum viable Android foundation for Aethon, keep it strictly exploratory and reversible, preserve Apache-2.0 attribution, and do not change desktop reader behavior, integrations, dependencies, or product scope.

## Blockers
- Native desktop boot is still blocked in this environment because `rustup`/`rustc`/`cargo` are not installed.
- Native desktop boot is still blocked in this environment because Visual Studio Build Tools with MSVC + Windows SDK are not installed.
- Microsoft Edge WebView2 is an explicit Windows prerequisite; it is present in this environment, but must still be verified on any other machine before running `tauri:dev`.

## Files/Directories That Must Not Be Touched Next
- `src/components/pages/`
- `src/lib/queries.ts`
- `src/store/`
- `src-tauri/src/`
- `src/components/reader/`
- `src-tauri/tauri.windows.conf.json`
- `dev.moku.app.yml`
- `packaging/`
- `src-tauri/binaries/`

## Notes For Future Codex Sessions
- Preserve upstream license obligations and attribution.
- Keep milestones small and update `docs/STATUS.md` and `docs/DECISIONS.md` after each milestone.
- Do not start feature work until an explicit phase prompt approves it.
- Leave risky identifier renames and packaging behavior changes for a separate, explicit phase.
- Use `npm exec pnpm` as the fallback local path when `pnpm` is not installed globally.
