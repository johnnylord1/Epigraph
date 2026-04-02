# Status

## Current Phase
Phase 4D: source visibility clarity in Search

## Completed Today
- Repo foundation, safe visible rebrand, desktop validation, and low-risk audit fixes remain complete.
- Runtime identity cleanup and safe metadata cleanup remain complete.
- Setup-state detection, repo onboarding, and extension onboarding remain complete.
- Audited the real post-extension flow in the Tauri desktop app before defining the next product phase.
- Confirmed that source browsing works on the current configured profile.
- Confirmed that the next evidence-based UX gap is source visibility clarity, not repo setup or extension setup.
- Added Search guidance that explains why installed content extensions can outnumber currently visible sources.
- Added next-step CTAs that point users to review visibility constraints or open the Sources tab without changing repo or extension setup.
- Validated the new visibility guidance in the real Tauri window while keeping a working source browse flow intact.

## Last Completed Step
Phase 4D source visibility clarity in Search, focused on explaining filter-driven mismatches between installed extensions and visible sources.

## Deferred Phase
Phase 3D: risky identity audit for updater, platform identifiers, and app-data paths.

## Exact Next Prompt
Implement the next small product phase only after a real-window audit confirms the next blocker in Aethon, prefer HUD/navigation cleanup or a smaller follow-up Search polish only if the issue is reproduced concretely, preserve Apache-2.0 attribution, and do not change reader behavior, Suwayomi integration, dependencies, or platform scope.

## Blockers
- Discord may still identify the app as `Moku` because the current Discord application ID and asset key remain upstream-controlled outside the repo.
- Platform identifiers and distribution wiring still use upstream `moku` values in places such as `identifier`, Flatpak app id/command, updater endpoints, and app-data paths.
- Higher-risk identity cleanup is still deferred because it could break updater, packaging, install paths, or local data continuity.
- The current configured profile shows fewer usable sources than installed content extensions because current content filters hide part of the installed source set.
- Keyword-search automation in the native harness was inconclusive, so the team should not assume keyword search is broken without a tighter reproduction.

## Files/Directories That Must Not Be Touched Next
- `src/components/reader/`
- `src/components/settings/`
- `src-tauri/src/`
- `src/lib/discord.ts`
- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.windows.conf.json`
- `dev.moku.app.yml`
- `packaging/`
- `src-tauri/binaries/`

## Notes For Future Codex Sessions
- Preserve upstream license obligations and attribution.
- Keep milestones small and update `docs/STATUS.md` and `docs/DECISIONS.md` after each milestone.
- Do not start feature work until an explicit phase prompt approves it.
- Treat Phase 3D as documented and deferred, not as the next automatic implementation phase.
- Keep onboarding actions explicit and user-triggered; do not silently seed repos or install extensions.
- Prefer evidence from the real Tauri window over assumptions from upstream Moku or generic onboarding patterns.
- Treat Search visibility guidance as explanatory only; do not broaden it into a generic search rewrite without a new audited prompt.
