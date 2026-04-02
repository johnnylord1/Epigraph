# Status

## Current Phase
Phase 5A cleanup: isolate the blocked Android spike and restore the desktop-stable line

## Completed Today
- Confirmed the authoritative pre-Android checkpoint is `85059d5` (`chore: phase 5a checkpoint before android bootstrap spike`).
- Audited the Phase 5A Android spike and confirmed it only existed as local work on top of `85059d5`; there were no commits after that checkpoint on `main`.
- Preserved the blocked Android spike on the dedicated branch `android-spike-blocked`.
- Created the linked worktree `C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon-android-spike` to hold the blocked Android continuation safely outside the stable desktop line.
- Added a WIP preservation commit on the isolated branch: `2981caa` (`wip: preserve blocked android spike state`).
- Preserved additional generated Android/build artifacts physically in the isolated worktree even when some of them were impractical to index cleanly on Windows.
- Restored `main` back to the desktop-stable baseline from `85059d5`.
- Removed Android-spike-only local files from the stable worktree, including the generated Android project, Android fallback helper, emulator screenshot, Android logs, and extracted Android spike artifacts.
- Revalidated the restored desktop line after cleanup with a successful frontend build, Rust build, and desktop launch.

## Last Completed Step
Phase 5A cleanup: the blocked Android spike was isolated into `android-spike-blocked` / `C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon-android-spike`, and `main` was restored to the pre-Android desktop baseline from `85059d5`.

## Deferred Phase
Phase 3D: risky identity audit for updater, platform identifiers, and app-data paths.

## Exact Next Prompt
Implement a discovery-only desktop audit after the Android rollback: validate the restored Aethon desktop baseline in the real Tauri window, confirm that Browse, Sources, Reader, and Settings still behave as expected on `main`, and identify the next evidence-based desktop phase before returning any Android work from `android-spike-blocked`.

## Blockers
- The Android spike remains blocked because the generated Android app can build, install, and open its Activity, but the app shell still fails to load correctly in the emulator, preventing full real navigation validation.
- The spike proved partial viability only: Android toolchain bootstrap, APK build, install, and launch path were possible, but the shell/runtime was not stable enough to validate Home, Library, Browse, Sources, Reader, and Settings end-to-end.
- Because of that blocker, Android work was removed from `main` and isolated to `android-spike-blocked` until the shell-loading issue can be solved safely away from the desktop-stable line.
- Discord may still identify the app as `Moku` because the current Discord application ID and asset key remain upstream-controlled outside the repo.
- Platform identifiers and distribution wiring still use upstream `moku` values in places such as `identifier`, Flatpak app id/command, updater endpoints, and app-data paths.
- Higher-risk identity cleanup is still deferred because it could break updater, packaging, install paths, or local data continuity.

## Files/Directories That Must Not Be Touched Next
- `src/components/reader/`
- `src-tauri/src/`
- `src/lib/discord.ts`
- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.windows.conf.json`
- `dev.moku.app.yml`
- `packaging/`
- `src-tauri/binaries/`
- `C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon-android-spike`

## Notes For Future Codex Sessions
- Preserve upstream license obligations and attribution.
- Keep milestones small and update `docs/STATUS.md` and `docs/DECISIONS.md` after each milestone.
- Do not start feature work until an explicit phase prompt approves it.
- Treat Phase 3D as documented and deferred, not as the next automatic implementation phase.
- Keep onboarding actions explicit and user-triggered; do not silently seed repos or install extensions.
- Prefer evidence from the real Tauri window over assumptions from upstream Moku or generic onboarding patterns.
- Do not resume Android work on `main`; continue it only in `android-spike-blocked` until the isolated spike can fully load the app shell and complete real navigation validation.
- Treat `85059d5` as the authoritative pre-Android desktop rollback baseline for this cleanup.
