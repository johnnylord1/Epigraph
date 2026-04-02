# Status

## Current Phase
Phase 3C: Discord and distribution identity cleanup

## Completed Today
- Cloned the upstream Moku repository into `Aethon`.
- Inspected the main repository areas without editing application source files.
- Created the initial project documentation scaffold.
- Applied a first-pass safe rebrand in approved visible surfaces only.
- Validated the frontend desktop baseline with `npm exec pnpm` and documented the exact local dev path.
- Fixed the Settings modal so sidebar navigation closes it instead of leaving it over the next route.
- Aligned the native runtime window title with `Aethon` after confirming config-level title sources were already correct.
- Renamed the Rust package/bin runtime target from `moku` to `aethon`.
- Replaced remaining safe `Moku` labels in Discord activity text with `Aethon`.
- Updated safe Linux/AppStream packaging metadata text from `Moku` to `Aethon`.
- Confirmed Discord application identity still depends on the upstream external app ID and asset registration.

## Last Completed Step
Clean up the remaining safe Discord and distribution identity surfaces and verify the desktop runtime still launches as `aethon.exe`.

## Exact Next Prompt
Implement Phase 3D only: audit the remaining risky identity surfaces for Aethon updater, platform identifiers, and app-data paths, keep it strictly analysis-only, preserve Apache-2.0 attribution, and do not change reader behavior, integrations, dependencies, or platform scope.

## Blockers
- Discord may still identify the app as `Moku` because the current Discord application ID and asset key remain upstream-controlled outside the repo.
- Platform identifiers and distribution wiring still use upstream `moku` values in places such as `identifier`, Flatpak app id/command, updater endpoints, and app-data paths.
- Higher-risk identity cleanup is still deferred because it could break updater, packaging, install paths, or local data continuity.

## Files/Directories That Must Not Be Touched Next
- `src/components/pages/`
- `src/lib/queries.ts`
- `src/components/reader/`
- `src-tauri/src/lib.rs`
- `src/lib/discord.ts`
- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.windows.conf.json`
- `dev.moku.app.yml`
- `packaging/`
- `src-tauri/binaries/`
- `src/store/`

## Notes For Future Codex Sessions
- Preserve upstream license obligations and attribution.
- Keep milestones small and update `docs/STATUS.md` and `docs/DECISIONS.md` after each milestone.
- Do not start feature work until an explicit phase prompt approves it.
- Leave risky identifier renames, Discord app registration, and packaging behavior changes for a separate, explicit phase.
- Use `npm exec pnpm` as the fallback local path when `pnpm` is not installed globally.
