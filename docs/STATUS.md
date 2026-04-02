# Status

## Current Phase
Phase 4A: setup-state detection and unconfigured-state UX

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
- Reworked the roadmap numbering so completed cleanup subphases and later macro phases no longer collide.
- Added setup-state detection and guidance so Home, Search, and Extensions explain major unconfigured states without auto-configuring anything.
- Validated the new setup guidance in the real Tauri window for ready and no-repo scenarios, with offline behavior partially verified through the native desktop runtime.

## Last Completed Step
Phase 4A setup-state detection and unconfigured-state UX, including native-window validation of the new setup guidance.

## Deferred Phase
Phase 3D: risky identity audit for updater, platform identifiers, and app-data paths.

## Exact Next Prompt
Implement Phase 4B only: decide and scope whether Aethon should support one-click recommended repo setup, manual repo-entry UX improvements, or both, keep the phase tightly constrained, preserve Apache-2.0 attribution, and do not change reader behavior, Suwayomi integration, dependencies, or platform scope.

## Blockers
- Discord may still identify the app as `Moku` because the current Discord application ID and asset key remain upstream-controlled outside the repo.
- Platform identifiers and distribution wiring still use upstream `moku` values in places such as `identifier`, Flatpak app id/command, updater endpoints, and app-data paths.
- Higher-risk identity cleanup is still deferred because it could break updater, packaging, install paths, or local data continuity.
- Onboarding should not absorb updater, distribution identifier, or app-data migration work.
- Phase 4A intentionally does not add repos or install extensions automatically, so users still need a later setup action to apply a recommended repo.

## Files/Directories That Must Not Be Touched Next
- `src/lib/queries.ts`
- `src/components/reader/`
- `src/components/settings/`
- `src-tauri/src/`
- `src/lib/discord.ts`
- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.windows.conf.json`
- `dev.moku.app.yml`
- `packaging/`
- `src-tauri/binaries/`
- `src/lib/client.ts`

## Notes For Future Codex Sessions
- Preserve upstream license obligations and attribution.
- Keep milestones small and update `docs/STATUS.md` and `docs/DECISIONS.md` after each milestone.
- Do not start feature work until an explicit phase prompt approves it.
- Leave risky identifier renames, Discord app registration, and packaging behavior changes for a separate, explicit phase.
- Treat Phase 3D as documented and deferred, not as the next automatic implementation phase.
- Keep setup guidance explicit and non-destructive until a later phase approves repo seeding or other onboarding mutations.
- Use `npm exec pnpm` as the fallback local path when `pnpm` is not installed globally.
