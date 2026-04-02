# Post-Extension Audit

## Confirmed Current Flow
- The current desktop profile has repositories configured and multiple content extensions installed.
- Search opens without a setup banner.
- Search currently reports `4 sources · 1 language` on the active profile.
- The `Sources` tab lists four usable sources on that profile: `Webtoons.com`, `Asura Scans`, `Flame Comics`, and `WebNovel`.
- Selecting `Webtoons.com` in the real Tauri window loads popular titles and shows `30 results`.

## Confirmed Blocker
- Installed content extensions and usable visible sources are not the same thing on the current profile.
- The profile has more installed content extensions than the four sources shown in Search because current content filters hide part of the installed source set.
- Search does not currently explain that mismatch clearly enough.

## Non-Blockers / Disproved Assumptions
- Repo setup is not the next blocker on the current profile.
- First extension installation is not the next blocker on the current profile.
- Source browsing is not broken on the current profile; it can load titles in the real app window.

## Still Uncertain
- Native automation did not conclusively prove whether keyword search itself is broken or whether the harness input path was insufficient.
- The next phase should not assume generic keyword-search failure until that is reproduced more tightly.

## Recommendation
- Phase 4D should focus on source visibility clarity in Search:
  - explain why installed extensions do not always appear as usable sources
  - show when current content filters hide installed sources
  - keep the scope on explanation and discoverability before broader search redesign
