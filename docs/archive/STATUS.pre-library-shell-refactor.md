# Status

## Current Phase
Phase 4B: Desktop Books domain + local EPUB ingest

## Completed Today
- Added a distinct local Books domain in desktop state with:
  - `BookEntry`
  - `BookProgress`
  - separate persisted `books` and `bookProgress` collections
- Implemented local EPUB parsing in `src/lib/books/epub.ts` using:
  - `JSZip`
  - `fast-xml-parser`
- EPUB ingest now extracts:
  - title
  - author
  - description
  - cover image when present
  - TOC from EPUB3 nav and classic NCX when available
  - spine fallback summary
- Added desktop-native Tauri commands to:
  - read selected files as base64
  - copy imported EPUBs into app-local storage
  - write extracted cover files into app-local storage
- Replaced the Books placeholder in Library with a real shelf component:
  - empty state
  - import action
  - grid of imported books
  - EPUB subtype badge
  - detail panel
  - minimal proof-path preview using EPUB.js
- Added parser tests for:
  - normal EPUB with metadata + cover
  - EPUB missing metadata
  - malformed EPUB failure
- Generated manual validation fixtures in:
  - `C:\Users\jhow-\Documents\Temp\aethon-books-validation`

## Validation
- `npm exec -- pnpm test -- src/lib/books/epub.test.ts` passed
- `npm exec -- pnpm build` passed
- desktop `cargo build --manifest-path src-tauri\Cargo.toml` passed
- Manual EPUB validation fixtures created:
  - `normal.epub`
  - `missing-metadata.epub`
  - `malformed.epub`
- A full real-window import/restart screenshot pass has not been completed yet in this doc update

## Last Completed Step
Implemented the desktop-only Books shelf and local EPUB ingest foundation without changing the comics pipeline.

## Exact Next Prompt
`Validate Phase 4B in the real desktop window: import the three EPUB fixtures, confirm Books persistence across restart, capture empty/imported/detail screenshots, and verify Comics behavior is unchanged.`

## Blockers
- The Books UI has not yet gone through a full desktop screenshot/import/restart validation pass.
- EPUB preview is intentionally minimal and should not be treated as the final book reader.

## Files/Directories That Must Not Be Touched Next
- `C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon-android-spike`

## Notes For Future Codex Sessions
- Preserve upstream license obligations and attribution.
- Keep milestones small and update `docs/STATUS.md` and `docs/DECISIONS.md` after each milestone.
- Prefer evidence from the real Tauri window over assumptions.
- Do not resume Android work on `main`; continue it only in `android-spike-blocked` until the isolated spike can fully load the app shell and complete real navigation validation.
- Treat this top section as the current working-tree truth; older dated entries below remain useful historical audit logs.
## 2026-04-02 - Desktop validation pass after Android rollback

Current focus:
- validate the restored desktop `main` line in the real Tauri window after isolating the blocked Android spike

What was validated on the restored desktop line:
- `pnpm build` passed
- desktop `cargo build --manifest-path src-tauri\Cargo.toml` passed
- the desktop app launched as `aethon`
- `Home` opened correctly
- `Browse` still exposed `Search / Catalog / Sources`
- `Catalog` still showed real feed labels/results and loaded real card grids
- `Sources` still loaded working sources and still exposed `Extensions & Repos`
- a real series-detail path opened from a working source
- `Settings` still used the grouped two-level navigation model

Confirmed findings from the real Tauri window:
- `Home` is the clearest current desktop UX weakness on a low-activity profile. It is functional, but too empty and passive compared with Browse.
- `Browse > Catalog` is still structurally correct and still loads cards immediately.
- `Browse > Sources` still works, but it also still shows the visibility-helper message that should live only in `Browse > Search`.
- the restored baseline shows the catalog feed label `All` again.
- the series-detail flow was confirmed from a real content path, but the reader transition itself was not conclusively validated in this pass.

Ranked desktop problems:
1. Home first-touch / empty-state weakness on low-activity profiles
2. `Browse > Sources` still duplicates the source-visibility guidance that should remain in `Browse > Search`
3. Catalog feed-label polish regressed from `Popular` back to `All` on the restored baseline

Android status:
- Android remains isolated in the blocked spike branch/worktree
- no Android work was resumed on `main` during this validation pass

Recommended next implementation phase:
- desktop-only `Home first-touch / empty-state guidance` polish

Strict non-goals for the next phase:
- no Android work
- no Suwayomi/backend changes
- no reader behavior changes
- no source-browse rewrite
- no broad visual redesign

Exact next prompt:
- `Implement a desktop-only Home first-touch and empty-state guidance pass for Aethon, improve the value and direction of Home on low-activity profiles without changing reader behavior, Suwayomi integration, source-browse logic, or starting any Android work.`

## 2026-04-02 - Home first-touch and Browse cleanup pass

Current focus:
- improve desktop Home guidance for low-activity profiles
- fix the two low-risk Browse regressions confirmed after the Android rollback

What changed:
- Home now shows a lightweight first-touch guidance card when recent reading activity is empty
- the Home empty activity CTA now points to `Browse popular` instead of a vague `Start reading`
- `Browse > Catalog` now shows the user-facing feed label `Popular` instead of `All`
- `Browse > Sources` no longer shows the duplicate source-visibility guidance
- `Browse > Search` keeps the source-visibility guidance and now includes a working dismiss button
- dismissing the Search visibility message keeps it hidden for the rest of the current app session only

Validation:
- `pnpm build` passed
- desktop `cargo build --manifest-path src-tauri\Cargo.toml` passed
- desktop `tauri build --debug` rebuilt the desktop binary successfully; the command still ended with the expected signing-key warning after producing the debug app and bundle
- real Tauri window validation confirmed:
  - Home shows the new first-touch guidance on a low-activity profile
  - `Browse > Catalog` shows `Popular` and `Latest`
  - `Browse > Sources` no longer shows `Visible sources are filtered`
  - `Browse > Search` still shows the visibility message when relevant, includes `Dismiss`, and keeps it hidden after dismissal for the rest of the session

Last completed step:
- desktop-only Home first-touch guidance and Browse cleanup landed on the restored desktop line without resuming Android work

Exact next prompt:
- `Implement a discovery-only desktop audit for Aethon after the Home first-touch pass: use the real Tauri window to confirm the next evidence-based desktop issue across Home, Browse, Sources, Reader, and Settings before starting another implementation phase.`

## 2026-04-05 - Suwayomi backup and restore controls landed in desktop Settings

Current focus:
- expose the existing Suwayomi backup/restore pipeline directly in Aethon Desktop without inventing a second client backup system

What was confirmed before implementation:
- the connected Suwayomi GraphQL schema already exposes `createBackup`, `validateBackup`, `restoreBackup`, and `restoreStatus`
- `createBackup` returned a real `.tachibk` URL from the current server
- `validateBackup` accepted a real `.tachibk` file upload and reported missing sources/trackers correctly
- `restoreBackup` accepted a real `.tachibk` upload and returned a live restore id/status

What changed:
- `Settings > System > Storage` now includes a `Backup & Restore` section
- `Export backup` creates a Suwayomi backup and saves it into the local Downloads folder
- `Import backup` opens a file picker, validates the chosen backup, and restores it through the current server
- restore progress/state is surfaced from `restoreStatus`
- the implementation uses the server as the canonical source of truth, so shared Desktop/Mobile state still depends on both clients pointing to the same Suwayomi instance

Implementation details:
- GraphQL backup queries were added in `src/lib/queries.ts`
- multipart upload support was added in `src/lib/client.ts` for `Upload`-based GraphQL operations
- a native helper was added in `src-tauri/src/lib.rs` to save server-generated backup files into the user's Downloads folder

Validation:
- `pnpm build` passed
- desktop `cargo build --manifest-path src-tauri\\Cargo.toml` passed
- direct live validation against the running Suwayomi server confirmed:
  - `createBackup` succeeds
  - `validateBackup` succeeds with a real backup file
  - `restoreBackup` succeeds with a real backup file

Known limitations:
- the export destination is currently the local Downloads folder, not a user-selected save path
- restore completion currently reports server-side status and recommends restart/refresh rather than forcing a full client refresh

Exact next prompt:
- `Implement a desktop-only backup/restore polish pass for Aethon: add a clearer post-restore refresh flow, improve save-path ergonomics for exported backups if possible without broad plugin churn, and validate the Settings backup UI in the real Tauri window.`

## 2026-04-05 - Backup validation now suggests installable extensions for missing sources

Current focus:
- make backup import more actionable when `validateBackup` reports missing sources

What changed:
- backup validation now fetches the current extension catalog and tries to match reported `missingSources` to real installable extensions
- the matching layer now reads the configured extension repo indexes directly and uses `sources[].id` as the primary bridge between backup `missingSources` and installable extension packages
- when a reliable match is found, `Settings > System > Storage > Backup & Restore` shows an `Install` action directly in the validation result
- installation reuses the same Suwayomi extension mutation already used elsewhere in the app
- when no match is found, the validation UI now directs the user to `Browse > Sources > Extensions & Repos`

Validation target for this pass:
- `pnpm build`
- desktop `cargo build --manifest-path src-tauri\\Cargo.toml`
- real Tauri validation of the restore flow with a backup that reports missing sources

Known limitation:
- source-to-extension matching is intentionally conservative; if the current repos do not expose a trustworthy candidate, Aethon falls back to guiding the user to the extensions surface instead of guessing
- repos that fail to return a valid `index.min.json` are reported as lookup warnings and are skipped rather than blocking the whole restore flow

## 2026-04-05 - Reconciliation-first Mihon/J2K restore flow

Current focus:
- maximize automatic recovery of Mihon/J2K backups whose library entries still point at orphaned historical source ids

What changed:
- backup restore now starts with a local parse/reconciliation pass instead of treating the raw backup as the only restore input
- Aethon now parses Mihon-compatible `.tachibk` payloads locally and extracts:
  - backup sources
  - backup manga metadata
  - tracker ids
- exact reconciliation now resolves in this order:
  - installed source id
  - configured repo source id
  - normalized source name + lang
  - normalized source name when language is still unambiguous
- unresolved leftovers are grouped into orphan source clusters and run through a bounded inference pass with:
  - representative sampling that prefers richer metadata
  - request / cluster / full-pass time limits
  - in-session caching
  - strict auto-select thresholds
- accepted mappings are persisted in the app-local overlay file:
  - `%APPDATA%\\aethon\\backup-reconciliation-overlay.json`
- restore now uses one explicit path:
  - parse backup
  - reconcile locally
  - review ambiguous leftovers
  - generate a reconciled payload client-side
  - upload only that reconciled payload to Suwayomi
- the original backup file is never mutated in v1

Locked v1 limits:
- max sampled manga per cluster: `5`
- max candidates per manga search: `8`
- max retained candidates per cluster: `5`
- request timeout: `4000 ms`
- cluster timeout: `15000 ms`
- full inference timeout: `45000 ms`
- max cluster search errors: `3`
- high-confidence threshold: `0.88`
- minimum top-vs-second margin: `0.12`
- minimum consistent matches for auto-select: `2`

Files added for this phase:
- `src/lib/backup/mihonProto.ts`
- `src/lib/backup/mihonBackup.ts`
- `src/lib/reconciliation/types.ts`
- `src/lib/reconciliation/constants.ts`
- `src/lib/reconciliation/text.ts`
- `src/lib/reconciliation/sourceInventory.ts`
- `src/lib/reconciliation/exact.ts`
- `src/lib/reconciliation/inference.ts`
- `src/lib/reconciliation/analyze.ts`
- `src/lib/reconciliation/overlay.ts`
- `src/lib/reconciliation/restore.ts`
- `src/lib/reconciliation/reconciliation.test.ts`

Files updated for this phase:
- `package.json`
- `vite.config.ts`
- `src/lib/extensionSourceMap.ts`
- `src/components/settings/Settings.svelte`
- `src-tauri/src/lib.rs`

Validation:
- `pnpm test` passed
- `pnpm build` passed
- desktop `cargo build --manifest-path src-tauri\\Cargo.toml` passed
- real Tauri validation confirmed the new review UI renders inside `Settings > System > Storage > Backup & Restore`
- real validation with the current J2K backup showed all four review states:
  - exact matches
  - needs review
  - unresolved leftovers

## 2026-04-05 - End-to-end validation of the v1 reconciliation restore flow

Current focus:
- validate the implemented Mihon/J2K reconciliation engine against a disposable Suwayomi profile instead of the user's main server/library

Disposable validation environment:
- disposable Suwayomi profile/database root:
  - `C:/Users/jhow-/Documents/Temp/aethon-restore-validation/suwayomi-data-run4`
- disposable server port:
  - `4571`
- test-safe backup copy:
  - `C:/Users/jhow-/Documents/Temp/aethon-restore-validation/backup-under-test.tachibk`
- original backup kept untouched:
  - `C:/Users/jhow-/Downloads/eu.kanade.tachiyomi.j2k_2026-04-05_00-18.tachibk`
- app-local overlay path confirmed:
  - `%APPDATA%/aethon/backup-reconciliation-overlay.json`

Validation fixes applied during this pass:
- fixed Mihon/J2K `int64` source-id parsing precision so large source ids like MangaDex are not rounded
- hardened reconciled payload generation to merge duplicate manga snapshots before upload
- added integration coverage for overlay reuse against a disposable Suwayomi instance

Pre-restore reconciliation result on the current J2K backup:
- exact matches: `12`
- auto-reconciled: `0`
- needs review: `0`
- unresolved: `23`
- warnings: `1`
- current warning:
  - repo lookup failure for `https://raw.githubusercontent.com/ThePBone/tachiyomi-extensions-revived/repo/index.min.json` (`404`)

Real restore result against the disposable Suwayomi instance:
- the restore succeeded through the reconciled-payload path only
- the disposable server logged:
  - `restore(...): finished with state SUCCESS`
- post-restore inspection of the disposable database showed:
  - restored manga in library: `617`
  - restored categories: `4`
  - restored tracked manga: `363`
  - restored manga with linked `source`: `0`
  - restored manga without linked `source`: `617`

What this proves:
- local parse -> reconcile -> overlay -> reconciled payload -> real restore works end-to-end against a disposable Suwayomi target
- the original backup file remained unchanged
- overlay persistence works in the live desktop app
- overlay reuse works when the backup fingerprint and source-inventory fingerprint match

What the disposable restore exposed:
- `repo-source-id` exact matches are valid for reconciliation, but on a clean disposable server they still land as missing sources when the required extensions are not installed
- in other words, v1 can stabilize source ids and reduce ambiguity, but a clean Suwayomi profile still needs those extensions installed before restored entries gain live linked `source` objects
- this is now the main remaining limitation of v1, not payload generation

Overlay reuse evidence:
- first analysis artifact:
  - `C:/Users/jhow-/Documents/Temp/aethon-restore-validation/overlay-reuse-analysis-first.json`
- generated overlay artifact:
  - `C:/Users/jhow-/Documents/Temp/aethon-restore-validation/overlay-reuse-generated-overlay.json`
- second analysis artifact:
  - `C:/Users/jhow-/Documents/Temp/aethon-restore-validation/overlay-reuse-analysis-second.json`
- the second pass reused overlay-backed unresolved clusters instead of rerunning fresh inference work

Original-backup integrity evidence:
- SHA-256 before/after validation:
  - `A8907841B08338048F925B3AC012837AB273356DF7FA7A6485E137DAF159BFE1`

Validation artifacts:
- reconciliation review UI:
  - `C:/Users/jhow-/Documents/Temp/aethon-restore-validation/reconciliation-review-after-int64-dedupe.png`
- successful disposable restore result:
  - `C:/Users/jhow-/Documents/Temp/aethon-restore-validation/restore-success-disposable.png`
- overlay file used by the live app:
  - `%APPDATA%/aethon/backup-reconciliation-overlay.json`
- post-restore disposable inspection:
  - `C:/Users/jhow-/Documents/Temp/aethon-restore-validation/post-restore-check-run4.json`

False positives / suspicious remaps:
- no high-confidence auto-remaps were applied in this backup during the disposable validation run
- no ambiguous leftovers were silently forced
- the main observed gap is not a false-positive remap; it is that exact repo-backed mappings still require extension installation on a clean target server

Explicit remaining limitations:
- a second restore into the same disposable database can fail on duplicate category names; reuse validation must use a fresh disposable profile or a pure reconciliation rerun, not a second import into the same already-restored database
- v1 does not automatically install required extensions before restore
- because of that, a clean Suwayomi target can restore manga/category/tracker metadata successfully while still reporting missing sources until those extensions are installed
  - warnings

Required scenario coverage:
- exact sourceId match:
  - covered by `src/lib/reconciliation/reconciliation.test.ts`
- stub/orphan source with successful high-confidence auto-remap:
  - covered by `src/lib/reconciliation/reconciliation.test.ts`
- ambiguous case that falls back to manual review:
  - covered by `src/lib/reconciliation/reconciliation.test.ts`
  - also visible in the real Tauri review flow with `MangaDex` and `Webtoons.com`
- restore using persisted mapping overlay:
  - covered by overlay + reconciled-payload unit tests
  - the live UI path was validated up to review/selection without forcing a real restore into the current user library

Screenshots saved from the real Tauri restore flow:
- `C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/reconciliation-review.png`
- `C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/reconciliation-review-selections.png`

Known limits still present in v1:
- this is not a generic backup editor
- there is no reconciled-backup export yet
- inference intentionally stops early on noisy/slow clusters instead of overreaching
- repo failures are surfaced as warnings and can reduce automatic recovery breadth

## 2026-04-05 - Restore readiness gate and local runtime hardening validation

Current focus:
- harden the validated reconciliation restore flow so the desktop app does not treat `repo-source-id` matches as effectively ready when the target server still lacks the required extensions
- validate that profile-scoped local Suwayomi spawning stays single-server even with multiple Aethon instances

Disposable validation environments:
- clean disposable Suwayomi target:
  - root: `C:/Users/jhow-/Documents/Temp/aethon-hardening-validation/suwayomi-clean`
  - port: `4572`
- prepared disposable Suwayomi target:
  - root: `C:/Users/jhow-/Documents/Temp/aethon-hardening-validation/suwayomi-prepared`
  - port: `4573`
- test-safe backup copy:
  - `C:/Users/jhow-/Documents/Temp/aethon-restore-validation/backup-under-test.tachibk`
- original backup kept untouched:
  - `C:/Users/jhow-/Downloads/eu.kanade.tachiyomi.j2k_2026-04-05_00-18.tachibk`
- app-local overlay path confirmed:
  - `%APPDATA%/aethon/backup-reconciliation-overlay.json`

Desktop hardening added in this phase:
- reconciliation preflight now classifies each selected source mapping as:
  - `ready_now`
  - `requires_install`
  - `unavailable`
  - `unresolved`
- `requiresInstall` is now a first-class restore concept in the UI
- final restore is gated when selected mappings still need extension installation on the current target server
- the Backup & Restore UI now shows a restore-readiness summary before the final restore action
- when a safe install path exists, the UI offers install-first actions instead of pretending the target is ready
- local server spawn logic now logs:
  - lock acquired
  - stale lock detected
  - lock denied
  - spawn skipped because another profile owner is already active
- shutdown no longer broad-kills unrelated `java.exe` processes; it only kills the child this app instance actually spawned

Validation result on the clean disposable target (`4572`):
- restore readiness summary:
  - `ready_now`: `0`
  - `requires_install`: `12`
  - `unavailable`: `0`
  - `unresolved`: `23`
- the UI correctly blocked final restore and explicitly explained why
- the app no longer implied that a clean target would yield a fully usable restored library just because repo-backed exact matches existed

Validation result on the prepared disposable target (`4573`):
- required extensions were preinstalled on the disposable target
- restore readiness summary:
  - `ready_now`: `12`
  - `requires_install`: `0`
  - `unavailable`: `0`
  - `unresolved`: `6`
- ambiguous leftovers required an explicit decision and were not auto-forced
- after explicitly choosing `Skip remap` for the ambiguous leftovers, the reconciled restore path executed against the prepared target
- post-restore disposable inspection showed:
  - restored manga in library: `617`
  - restored categories: `6`
  - restored tracked manga: `363`
  - restored manga with linked `source`: `617`
  - restored manga without linked `source`: `0`

What this proves:
- the readiness gate now tells the truth about target usability before restore
- a clean target with missing extensions is blocked or routed toward install-first action instead of being misrepresented as ready
- a prepared target with the required extensions installed yields actually linked, usable restored sources where expected
- the original backup file remained unchanged throughout the hardening validation

Local runtime / server.lock validation:
- multiple desktop `aethon.exe` instances were launched against the canonical `%APPDATA%/aethon` profile
- only one Java/Suwayomi process remained active for that profile at a time
- second-instance launches logged:
  - `found stale server.lock from dead pid 7040`
  - `spawn skipped because a Java/Suwayomi process already owns this profile`
- closing the secondary desktop instance did not kill the shared Java/Suwayomi process
- no duplicate Java process was observed for the same profile during the validation run

Runtime safety evidence:
- lock snapshot:
  - `C:/Users/jhow-/Documents/Temp/aethon-hardening-validation/server-lock-evidence.txt`
- spawn log tail:
  - `C:/Users/jhow-/Documents/Temp/aethon-hardening-validation/aethon-spawn-tail.txt`
- runtime process snapshot:
  - `C:/Users/jhow-/Documents/Temp/aethon-hardening-validation/runtime-processes.json`

UI / validation artifacts:
- missing-extension readiness gate:
  - `C:/Users/jhow-/Documents/Temp/aethon-hardening-validation/restore-readiness-clean.png`
- prepared-target readiness state:
  - `C:/Users/jhow-/Documents/Temp/aethon-hardening-validation/restore-readiness-prepared.png`
- prepared-target restore execution state:
  - `C:/Users/jhow-/Documents/Temp/aethon-hardening-validation/restore-prepared-in-progress.png`
- prepared-target post-restore inspection:
  - `C:/Users/jhow-/Documents/Temp/aethon-hardening-validation/post-restore-check-prepared-live.json`

Backup integrity evidence:
- original and test-copy SHA-256 remained:
  - `A8907841B08338048F925B3AC012837AB273356DF7FA7A6485E137DAF159BFE1`

Explicit remaining limitations:
- the profile-level spawn guard is effective, but the `server.lock` file can still remain stale and point at a dead Aethon PID while runtime safety is actually being enforced by the secondary `existing Java owns this profile` check
- the prepared-target restore UI remained in `Restoring...` progress state longer than the server-side post-restore inspection needed, so the strongest completion evidence in this pass is the disposable server state rather than a final client-side success toast
- unresolved orphan sources still remain untouched by design when no safe reconciliation exists

Merge-readiness verdict:
- merge-ready for the desktop hardening goal
- the readiness gate closes the most misleading restore gap
- the profile-scoped single-spawn protection is effective and auditable
- the stale-lock metadata issue remains a small follow-up hardening item, not a blocker for this phase
