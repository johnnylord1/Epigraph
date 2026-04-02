# Status

## Current Phase
Phase 4G: Browse/Catalog discovery cleanup

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
- Consolidated first-level discovery navigation under Search in the real desktop app.
- Moved the old Discover/catalog surface to `Search > Browse > Featured`.
- Moved tag discovery to `Search > Browse > Tags`.
- Moved extensions and repository management under `Search > Sources`.
- Removed History and Tracking from the first-level rail while preserving History in Home and Tracking in Settings.
- Reworked Settings into a two-stage navigation model where App, Reading, Library, Content & Integrations, System, and Advanced are the primary left-side buttons.
- Moved each group's sub-options into a compact in-content selector instead of a second full-height column so the settings hierarchy is clearer without crushing the actual panel content.
- Relabeled `Folders` to `Categories` in the user-facing Settings UI and grouped it with Library.
- Kept Tracking in Settings and regrouped it under Content & Integrations.
- Validated the new Settings IA in the real Tauri window without changing any settings behavior.
- Renamed the user-facing discovery rail label from `Search` to `Browse` while keeping the internal nav ids stable.
- Replaced the user-facing `Featured` and `Tags` split with a single `Catalog` surface under `Browse`.
- Reused the old tag-driven discovery surface as the Catalog base and embedded the old `All` discovery grid so cards still appear immediately.
- Added left-side `Feed / Type` and `Genres / Tags` filter groups inside Catalog.
- Kept only `All` active in `Feed / Type`; other feed options are visibly deferred until proven by local code.
- Validated the new Browse/Catalog structure in the real Tauri window, including `Browse > Search`, `Browse > Catalog`, `Browse > Sources`, and `Extensions & Repos`.

## Last Completed Step
Phase 4G Browse/Catalog discovery cleanup, focused on making `Browse` the user-facing discovery destination, collapsing `Featured` plus `Tags` into `Catalog`, reusing the old tag-based surface as the implementation base, and keeping only proven feed options active without changing backend discovery behavior.

## Deferred Phase
Phase 3D: risky identity audit for updater, platform identifiers, and app-data paths.

## Exact Next Prompt
Implement a discovery-only phase after Phase 4G: audit the real Home, Browse, Sources, and Settings flows in Aethon to confirm the next UX problem before any visual cleanup or Android bootstrap, use the real Tauri window as the primary target, preserve Apache-2.0 attribution, and do not change reader behavior, Suwayomi integration, dependencies, or platform scope.

## Blockers
- Discord may still identify the app as `Moku` because the current Discord application ID and asset key remain upstream-controlled outside the repo.
- Platform identifiers and distribution wiring still use upstream `moku` values in places such as `identifier`, Flatpak app id/command, updater endpoints, and app-data paths.
- Higher-risk identity cleanup is still deferred because it could break updater, packaging, install paths, or local data continuity.
- The current configured profile still shows fewer visible sources than installed content extensions because current content visibility and language constraints hide part of the installed source set.
- Catalog feed options beyond `All` are still intentionally deferred because the local codebase did not prove real support for distinct `Popular`, `Latest`, `Trending`, `New`, or `Completed` discovery feeds in this fork.
- The packaged Tauri validation path required a fresh `tauri build --debug` artifact because an older debug runtime was stale; future native validation should prefer a fresh built artifact when shell changes do not appear in the window.
- Android bootstrap is still intentionally deferred until the desktop UX hierarchy is no longer the dominant product pain point.

## Files/Directories That Must Not Be Touched Next
- `src/components/reader/`
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
- Treat the new Search hub as the single exposed discovery surface; do not reintroduce duplicate rail destinations for Discover, History, Extensions, or Tracking without a new audited phase.
- Treat the new two-stage Settings IA as the baseline; keep the secondary navigation compact inside the content area, and do not flatten it again or rename `Categories` back to `Folders` without a new product decision.
- Treat `Browse` as the single user-facing discovery destination; do not reintroduce separate visible `Featured` or `Tags` discovery tabs without a new audited product decision.
- Keep feed-state messaging honest inside Catalog: only activate feed options that are proven by local code in this fork.
