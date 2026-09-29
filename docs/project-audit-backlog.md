# Project audit backlog

This records verified status against the original audit objectives. Historical
checkpoints below retain their original scope and do not certify later changes.

| Item | Original objective | Status | Evidence |
| --- | --- | --- | --- |
| B1 | Make launcher and cleanup ownership explicit. | **CLOSED — ORIGINAL_B1** (2026-09-06) | [Ten-criterion reconciliation, diagnostics and executed tests](b1-ownership-verification.md#original-audit-reconciliation--2026-09-06) |
| B6 | Make verification evidence durable, artifact-specific, reproducible and truthful about tested scope. | **CLOSED — ORIGINAL_B6** (2026-09-06) | [Dated focused certification and contract](verification-evidence.md#b6-focused-certification--2026-09-06) |
| B2 | Share restore orchestration and define recovery. | **CLOSED — ORIGINAL_B2** (2026-09-09) | Nineteen-criterion reconciliation below; final execution receipt `e0c2f1ce`, separate manual acceptance receipt `e9ae573e`. Closure applies to the verified working tree, not a clean committed release. |
| B3 | Resolve restore dependencies with explicit provenance, approval and shared readiness. | **CLOSED — B3 dependency contract** (2026-09-10) | Ten-criterion reconciliation below; execution receipt `acb12db8`, separate manual acceptance receipt `29c701ea`. Verified working-tree scope; no live installation or release certification claim. |
| B5 | Localized typed outcomes. | **CLOSED — ORIGINAL_B5** (2026-09-12) | Execution receipt `4912ee56`; separate acceptance receipt `b2d5878b` FINALIZED/PASS. Selective commit `ade1ddeae`; mixed UI hunks remain in the verified working tree. |
| B4 | Native clean-user acceptance. | **CLOSED — ORIGINAL_B4** (2026-09-19) | Final disposable current-tree journey `e4f41d83` is FINALIZED/PASS: Fresh, Backup and Sync completion plus restart all pass; cleanup and verification-tree preservation pass. |

The [2026-09-26 technical audit](audit-2026-09-26.md) is outside the B1-B12
numbering. It records its own fixed defects (A-01..A-08) and remaining issues
and does not reopen any closed item above.

## B5 current plan and read-only reconciliation — 2026-09-10

User accepted B3; B1, ORIGINAL_B2, B3 and ORIGINAL_B6 stay CLOSED. Starting HEAD
is `5103fb57e`; the original staged diff (21 paths) remains byte-identical. External
baseline `epigraph-b5-baseline-LGY6qW` records HEAD, staged/unstaged diffs, current
file digests and copies of relevant mixed files before B5 edits.

The dated original audit reconciliation names B5 **Localized typed outcomes**:
catalog coverage was already substantial, but raw exceptions, a literal restored
heading and First Run copy tables bypassed the intended localization boundary.
The following operational acceptance mapping uses that finding and the user's
current restore/runtime/setup/error scope; it is not a new app-wide translation
or domain-recovery architecture.

| Original concern / acceptance | Current implementation | Classification |
| --- | --- | --- |
| One existing catalog architecture | Paraglide, `src/lib/i18n/runtime.ts`, five `messages/*.json` files and catalog/placeholder tests exist. | KEEP / already implemented |
| Restored heading and ordinary setup labels | `FirstRun.svelte` uses `ui_backupRestored` for the status line, but its sibling heading remained literal. Dedicated steps and shared B3 panels mostly use catalog keys. | OPEN at baseline; heading confirmed during final delta review |
| First Run copy tables | `COPY` and two language-indexed accessibility labels remain inside `FirstRun.svelte`. | OPEN: move existing translations into the current catalogs |
| Typed restore outcomes | Settings renders planner summaries, reason messages, reconciliation warnings and result details directly; First Run renders file errors and operation warning codes. | OPEN: localize presentation from typed code/status with safe contextual fallback |
| Setup/dependency errors | Sources, discovery, trackers and B3 panels display `.message` before their translated fallback. | OPEN: use the same catalog-backed error presentation boundary |
| Runtime startup and announcements | App's primary startup labels already use catalogs. Two native error catches publish raw messages; SplashScreen defaults, Ready/PIN/retry announcements are English. | OPEN: localize fallback/announcements and native error presentation |
| Five-language parity and locale changes | Catalog key/placeholder contracts exist; affected dynamic error/outcome paths lack focused locale evidence. | OPEN verification |

Execution plan (inline, existing dirty checkout; no broad formatting):

1. Add failing code/status/error presentation tests for all five locales, unknown
   exceptions, wrapped transport causes and warnings. Implement a small presentation
   helper under `src/lib/i18n/` using existing `translate`; keep original error
   objects/codes and domain results unchanged. No second localization system.
2. Move only First Run's existing copy tables into the five catalogs, preserving
   wording; wire setup/dependency error displays and restore warning/result displays
   to typed presentation. Add focused screen tests for Portuguese errors and locale
   changes; preserve all unrelated Settings/First Run/OAuth/theme hunks.
3. Localize SplashScreen defaults/live announcements and the two raw App startup
   error publications. Verify runtime screen behavior without changing launch,
   cleanup, process ownership or restore execution.
4. Run catalog/unit/affected screen/build regressions and B6 evidence. Review the
   complete B5 delta against its external baseline, independently reconcile each
   acceptance criterion, and selectively commit only attributable verified hunks.
   Record closure only after evidence supports every criterion, then enter the next
   existing roadmap item (B4 native clean-user acceptance) by current-tree review.

Source scope: `src/lib/i18n/`, `messages/{en,pt-BR,es,ja,zh-CN}.json`,
`src/components/firstRun/`, shared restore dependency panels, restore/runtime error
presentation in `Settings.svelte`, `SplashScreen.svelte` and the two App startup
catch blocks, plus the embedded `SyncdConnectionPanel.svelte` error boundary; only narrowly necessary typed warning adapters if the UI currently
receives text without a code. Tests and this canonical checkpoint accompany them.
Raw diagnostic logs, filenames, user/source content, product names, protocol codes
and external repository URLs are not translations; they must not be used as primary
error copy or have their identity rewritten.

## B5 implementation checkpoint — 2026-09-12

Implementation is complete pending final regression evidence and acceptance. A
small `operationPresentation.ts` translates known code/status outcomes through the
existing catalog. UI error descriptors retain their original cause and catalog
fallback until render, so existing errors follow language changes. Unknown native
text is not used as primary copy. No error-message substring inference is used.

First Run's existing wording moved to the five catalogs; its restored heading and
setup accessibility labels now use them. Settings' planner/results, dependency
warnings, runtime/storage errors and the embedded Sync error boundary use localized
presentation. The existing Settings completion-status contract is unchanged;
`outcome` selects an unresolved label without turning uncertainty into success.
Manga dependency inspection retains existing warning kinds rather than stripping
them. Domain execution, submission, admission, OAuth, ownership and persistence
paths retain their prior behavior.

Executed intermediate evidence `dfc7d768-4b7d-4c31-b247-7ad9dbae74ca`:
342 unit tests PASS, two fixture-generation tests SKIPPED; 77 screen tests PASS;
frontend build PASS; 13 B6 contract tests PASS; whitespace PASS. Its receipt is
FINALIZED/PARTIAL because manual acceptance was deliberately NOT_RUN. This is
intermediate evidence: subsequent reviewed fixes cover the sibling restored
heading, typed Novel warning rendering, and reactive native startup errors.
The final run will receive a new identity; this receipt will not be overwritten.
Independent read-only review found no remaining concrete B5 blocker after those
corrections; the reviewer did not execute tests.

The B5 baseline comparison still shows only scoped paths changed and the original
21-path staged diff byte-identical. Selective commits will exclude mixed shared
files and pre-existing untracked B2/B3 implementations when their B5 hunks cannot
be committed coherently without absorbing that earlier work. Those full working
files and their baseline-relative B5 patches remain intact and reviewable.

## ORIGINAL_B5 closure — 2026-09-12

**ORIGINAL_B5 = CLOSED.** B1, ORIGINAL_B2, B3 and ORIGINAL_B6 remain CLOSED.
This closes the original localized-outcome finding for the verified working tree;
it is not a clean-tree release or native clean-user certification.

| Original criterion | Implementation and exact executed evidence | Result |
| --- | --- | --- |
| Reuse the existing localization architecture | Paraglide/runtime unchanged; 63 additive keys in each existing catalog. `catalogContract.test.ts` (7), `runtime.test.ts` (11), `syncdTranslations.test.ts` (5), and dynamic-key coverage in `operationPresentation.test.ts`. All original catalog values are unchanged. | PASS |
| Remove the literal restored heading and First Run copy tables | Shell texts/accessibility labels moved to catalogs; restored heading uses `ui_backupRestored`. `FirstRun.test.ts` (21) includes Portuguese/Spanish heading and navigation; `FirstRunGate.test.ts` (2) preserves completion/restart routing. | PASS |
| Present typed restore outcomes in the user's language | `operationPresentation.test.ts` (16): five locales, wrapped causes, actual emitted reader/corrupt/uncertain/cancelled codes, raw-error refusal, counts and locale changes. Settings plan/results and First Run file errors/warnings use this boundary; domain execution remains unchanged. | PASS |
| Localize setup/dependency/error surfaces | `FirstRunBackupStep.test.ts` (7), SourcesStep (5), TrackersStep (4), DiscoverStep (4), Manga dependency (1), Novel dependency (2); warning-code rendering, explicit approval, retry/cancel/detach and no automatic advance are retained. | PASS |
| Localize runtime/startup and existing errors reactively | Settings (18), SyncdConnectionPanel (9), SplashScreen (5). Settings errors update after locale changes; Novel warnings update to Japanese; Splash defaults/live announcements use catalogs. App native catches retain causes and translate at render. Final frontend build includes these paths. | PASS |
| Preserve prior work and use truthful evidence | 343 unit PASS, 2 fixture-generation tests SKIPPED; 78 screen PASS; frontend build PASS; 13 B6 tests PASS; whitespace PASS. Independent delta review found no remaining blocker or accidental execution change. Hash checks and byte-identical 21-path staged diff PASS. | PASS |

Final execution receipt:
`%LOCALAPPDATA%/Epigraph/verification/4912ee56-21c3-419c-b366-72478bd917c0/receipt.json`.
It is FINALIZED/PARTIAL solely because its separate manual acceptance stage was
NOT_RUN. Initial/final verification-tree digests match. Its build stage is the
frontend build, with existing CSS/chunk warnings; no native executable was launched.

Separate manual acceptance receipt:
`%LOCALAPPDATA%/Epigraph/verification/b2d5878b-0822-4898-8306-592a04ae8998/receipt.json`
is **FINALIZED/PASS**. It verifies each executed gate, diagnostic hashes,
post-commit working-file fingerprint, preservation checks and the six criteria
above. It records that its acceptance review did not perform a new application run.
The intermediate `dfc7d768` receipt remains intact. Original failing evidence was
the Portuguese BackupStep test displaying raw English; its final counterpart passes.
Five later screen failures expected the old text; expectations now assert catalog
messages while retaining their original behavioral assertions.

Selective commit `ade1ddeae` (`fix(i18n): localize operation outcomes and startup
announcements`) contains only the following attributable files/hunks:

- `messages/en.json` — only the 63 B5 additions; prior pending translations excluded.
- `messages/es.json` — only the 63 B5 additions; prior pending translations excluded.
- `messages/ja.json` — only the 63 B5 additions; prior pending translations excluded.
- `messages/pt-BR.json` — only the 63 B5 additions; prior pending translations excluded.
- `messages/zh-CN.json` — only the 63 B5 additions; prior pending translations excluded.
- `src/components/layout/SplashScreen.svelte`.
- `src/components/layout/SplashScreen.test.ts`.
- `src/lib/i18n/operationPresentation.ts`.
- `src/lib/i18n/operationPresentation.test.ts`.

The following B5 files remain pending because they share pre-existing staged,
unstaged or untracked work. Their complete files were preserved; only the B5
presentation changes were added, and no earlier implementation was absorbed into
the selective commit:

- `docs/project-audit-backlog.md`
- `src/components/firstRun/FirstRunBackupStep.svelte`
- `src/components/firstRun/FirstRunBackupStep.test.ts`
- `src/components/firstRun/FirstRunDiscoverStep.svelte`
- `src/components/firstRun/FirstRunDiscoverStep.test.ts`
- `src/components/firstRun/FirstRunSourcesStep.svelte`
- `src/components/firstRun/FirstRunTrackersStep.svelte`
- `src/components/settings/RestoreMangaDependencies.svelte`
- `src/components/settings/RestoreNovelDependencies.svelte`
- `src/components/settings/RestoreNovelDependencies.test.ts`
- `src/lib/backup/mangaRestoreDependencies.ts`
- `src/App.svelte`
- `src/components/firstRun/FirstRun.svelte`
- `src/components/firstRun/FirstRun.test.ts`
- `src/components/settings/Settings.svelte`
- `src/components/settings/Settings.test.ts`
- `src/components/settings/SyncdConnectionPanel.svelte`

The external `epigraph-b5-baseline-LGY6qW` baseline and final baseline-relative
patches preserve a reviewable boundary. Every baseline file outside the declared
B5 scope is hash-identical; the existing native `lib.rs`, B1/B6 implementation and
restore transport/persistence code are unchanged. OAuth control/session behavior
is intact; the scoped Settings/First Run OAuth error presentation now uses catalogs.
Raw technical diagnostics, user/source content, paths, URLs and product names
remain data and are excluded from the primary-copy localization criterion.

## B4 current-tree reconciliation and next plan — 2026-09-12

**ORIGINAL_B4 remains OPEN.** Entered at `ade1ddeae`, with the prior staged work
preserved. The original dated reconciliation requires complete fresh/backup/sync
journeys against the final native candidate and explicit sync-readiness evidence.
It also says to retain the existing bypass-based regression harnesses.

| Current evidence or path | Classification / remaining gap |
| --- | --- |
| Dedicated First Run screens and shared B2/B3 coordinator | Implemented; current component regressions passed during B5. Native end-to-end acceptance still required. |
| Historical native layout/theme/backup-selection checkpoints in the 2026-09-02 correction plan | Valid dated evidence for their named artifacts and scope. They did not import a backup or certify full clean-user completion. |
| `smoke-native-viewports.mjs`, `certify-local-data.mjs`, `verify-native-backup-user-flow.mjs` | Explicitly bypass First Run. Preserve them as post-setup regression gates; they cannot close B4 onboarding acceptance. |
| `FirstRun.browser.test.ts` | Useful browser/layout fixtures with mocked native and backend integrations; not native acceptance. |
| Sync completion signal | Current `pairingStage` accepts connected status or an active session key; `onReadyChange` publishes that state. The overview separately recognizes paused replication. Initial synchronization/library refresh readiness needs a focused negative test and current protocol trace before any fix. This is B4 evidence work, not a reason to reopen B1/B2/B3/B6. |
| Candidate ownership and evidence | Reuse B1 `build-epigraph-candidate.ps1`/session attestation and B6 receipts. B5's frontend build is not a new native binary receipt. |

Next bounded execution sequence:

1. Freeze a B4 external baseline and trace actual sync readiness, including paired
   but paused/replaying/error states. Add a focused failing test for any confirmed
   premature Continue signal; retain the existing protocol and domain authority.
2. Define a separate disposable clean-user journey that does not call
   `bypassFirstRun`, seed a completion marker, or operate on normal user profiles.
   Reconcile dirty harness/UI files before narrowly necessary changes.
3. Build and attest the exact current candidate through B1, then verify fresh,
   backup and sync paths through their visible controls, completion and restart.
   Reuse shared restore fixtures/contracts; record actual backend kind/availability.
4. Preserve failure evidence before owned cleanup, run relevant regressions, and
   reconcile each original B4 criterion. Do not reinterpret a layout sample,
   paired-session token, mocked backend or bypass-based gate as full acceptance.

B4 implementation scope (reconciled against external baseline
`epigraph-b4-baseline-bk9z0qop`): SyncdConnectionPanel and its tests;
`syncdDesktop.ts`; a focused First Run sync-readiness/library refresh module and
unit tests; `syncd_replication.rs` for a runtime-only, current-remote-worker
bootstrap acknowledgement (persisted Live is insufficient after restart).
The panel will await current-profile library hydration before publishing ready.
Books/Novels libraryState readers also receive a narrow strict reload option,
reusing B2 validated readers so an IPC/corrupt-data fallback cannot count as a
successful empty-library refresh. Existing non-strict callers are unchanged.
Pairing presentation and domain replication semantics remain separate. Empty
remote libraries are valid; paused/replaying/error/stale/host-only states are not
proof of remote import. The old native bypass harnesses will remain intact.
A separate B1-attested disposable acceptance harness and B6 receipts will record
fresh, backup and sync journeys, followed by completion/restart evidence.
Native candidate receipt `23b505f0-3e9e-45e6-be16-697735839d4b` then failed
the Core binary build: desktop-only restore commands were included by shared
maintenance. The narrow integration fix moves only that module declaration to
desktop `lib.rs`, updates its registration/import paths and exact child-test
selector in `restore_commands.rs`, and removes the shared declaration in
`suwayomi_maintenance.rs`. No restore/ownership/OAuth behavior changes. All three
files matched the external B4 baseline before editing; their unrelated hunks
remain preserved. Library tests alone did not exercise this binary target.
No closure or native acceptance is claimed at this checkpoint.

## B4 native / First Run chrome checkpoint — 2026-09-13

The desktop-only command module relocation passed seven native command tests
(receipt `4d18eabe`); the isolated current Core + desktop build and B1 artifact
attestation passed (`f614e319`, FINALIZED/PARTIAL: journeys separate).
Readiness evidence remains `198cdc3a`: 67 units, 42 screens, frontend build and
one native readiness test passed; `7bfa081b` also passed Settings and all 40
native replication tests. These scopes do not certify a complete native journey.

Native attempt `88e18565` passed clean fresh entry, actual repository/plugin
installation, discovery/add, persisted visible Novel library, completion and
restart. Backup entry passed; its import step timed out. Sync was NOT_RUN.
Both owned instances exited with B1-confirmed cleanup. Earlier failed build and
harness receipts remain preserved; none is reclassified as acceptance.

The user then explicitly requested a full-window First Run layout, aligned
minimize/maximize/close controls, and theme colors consistent with the app before
resuming B4. External baseline `epigraph-b4-chrome-baseline-20260913` preserves
all previous hunks. This supersedes the old 760px/compact-column visual criterion,
not the dedicated-step architecture or readiness/execution contracts.

Narrow additional scope: FirstRunShell, FirstRun's presentation CSS and browser
tests, Tracker layout, Discover grid density, and an opt-in titlebar variant of
WindowControlsInline. Existing inline callers retain their prior appearance.
The shell uses the app/background and topbar tokens; the content/progress grids
share the full workspace gutter and actions use the available vertical space.
Six focused browser assertions failed before the fix. Final verification and
native visual acceptance follow; B4 remains OPEN until backup and sync pass.

## B4 sync hydration continuation — 2026-09-18

The First Run visual slice is now compact, full-window and uses the existing
theme contracts for palette previews. Focused browser coverage for the affected
First Run and Sync surfaces remains green; the visual changes do not replace the
native acceptance requirement.

The current B4 implementation also narrows initial Sync hydration to the data
that the selected remote scopes require. Books and Novels are read through the
strict, profile-scoped persistence readers. The Manga GraphQL refresh is only
requested when a Comics scope checkpoint or applied Comics scope is present;
Novel source-classification metadata is not a prerequisite for the library shown
by First Run. The readiness identity is the selected profile, active session and
runtime bootstrap generation. Advancing replication timestamps/checkpoints do
not restart an in-flight hydration, while a session or worker generation change
still invalidates it. These are B4-specific readiness changes; B1 ownership,
restore execution and B6 evidence contracts were not broadened.

Focused verification after the latest changes:

- `firstRunSyncReadiness.test.ts`: **24 PASS**.
- `SyncdConnectionPanel.test.ts` and `FirstRun.test.ts`: **43 PASS**; the
  expected simulated unavailable-read warning remains part of the retry test.
- Frontend production build: **PASS**, with the existing Syncd unused-selector,
  circular-chunk and large-chunk warnings.
- Candidate 11 build/attestation receipt
  `5d049aa1-19ad-4c11-b13f-87ace7917976`: **FINALIZED/PARTIAL** because journeys
  are a separate stage; desktop/Core artifacts are recorded in the receipt.
- Disposable native journey receipt
  `db8d47f2-1a74-48b9-9393-00ed39e9607c`: **FINALIZED/FAIL**. Attestation,
  Fresh start/completion/restart and Backup start/completion/restart are PASS.
  Sync start is PASS; Sync completion timed out while the page remained in
  `Carregando...`, and Sync restart is therefore NOT_RUN.
- During that failed Sync stage, the persisted replication state was `live`,
  had a current remote bootstrap generation, had a Novels checkpoint and no
  error; direct diagnostic reads of the Books and Novels stores resolved. This
  proves the failure is in the UI hydration/readiness completion boundary, not
  evidence that a foreign process or wrong instance was terminated.
- The receipt's initial and final verification-tree fingerprints match, and
  exact-run cleanup for Sync, Backup and Fresh is PASS. The unrelated process
  occupying the default Suwayomi port was preserved by B1 fail-closed behavior.

The remaining B4 work is to identify and fix the still-pending active Sync
hydration boundary, add a regression that proves a live current bootstrap can
unlock Continue after the store reads resolve, and rerun the complete current
candidate journey through Sync restart. B4 is not closed; no B7-B12 work has
started.

## ORIGINAL_B4 closure reconciliation — 2026-09-19

**ORIGINAL_B4 = CLOSED.** The final current-tree candidate was built and
attested with build receipt `eb9c41c2-7d76-4fbb-8e20-bdf611674629`
(FINALIZED/PARTIAL because the journey is a separate stage). The disposable
journey receipt is `e4f41d83-0b20-48c7-80ab-95403ea251f5` (FINALIZED/PASS).
It records HEAD `ade1ddeae14b5bd6efa7e4ff867e15c2dc11330c`, a dirty tree, and
the exact candidate-16 desktop/Core artifacts.

| Original B4 criterion | Evidence | Result |
| --- | --- | --- |
| Clean First Run entry without bypassing the setup flow | `fresh-start`, `fresh-complete`, `fresh-restart` in `e4f41d83` | PASS |
| Backup selection/import, visible completion and persisted restart | `backup-start`, `backup-complete`, `backup-restart`; diagnostics contain `Audit EPUB` and `Audit PDF` | PASS |
| Sync pairing uses a current live worker/bootstrap, not a stale session alone | `sync-start`; `sync-current-remote-ready` reports `live`, generation `2`, no error | PASS |
| Sync strict Books/Novels hydration unlocks completion | `sync-complete`; `sync-library` diagnostic contains `B4 First Title` | PASS |
| Completion survives a fresh owned restart for Sync | `sync-restart`; the same persisted novel library is visible | PASS |
| Exact-run cleanup and evidence preservation | Cleanup is PASS for Fresh/Backup/Sync; initial and final tree digests both `300635286e6d9cdc1e18d9e20348aed72d86c7c5ad85165b442dce87daa810c1` | PASS |

The implementation fixes two concrete current-tree defects discovered during
the failed attempts: the Sync hydration fence no longer invalidates a live
attempt when an unrelated replication event refreshes the snapshot, and native
incremental/authoritative Novel state now initializes missing `version` and
`profile:<local-profile>` metadata before strict persistence reads. Focused
regressions cover the fence (`SyncdConnectionPanel.test.ts`, 22 PASS) and the
native metadata paths (Rust targeted tests PASS). The existing First Run and
readiness suites remain green, and the candidate build includes the same
working-tree state.

The final receipt does not certify a release matrix or start B7-B12. No named
B7-B12 item is defined in this backlog, so the next roadmap action is a new
read-only reconciliation only after a concrete item is selected; no follow-up
implementation is inferred from B4 closure.

## B2 current checkpoint — 2026-09-07

Verified commits: `d59a797` introduces conservative Novel identity/merge
(22 focused unit tests); `0c6e5ab` adds the reader persistence barrier
(15 browser tests, native persistence mocked). Receipt
`e2687ef7-65fd-4d34-9d21-47bea3473276` is FINALIZED/PARTIAL:
reader tests PASS, production cutover NOT_RUN. Neither slice closes B2.

The approved architecture is a flat SharedRestoreCoordinator for content hashes,
target freeze, readiness, conflicting-restore exclusion, domain ordering,
completion tracking and shared results. Domain services own persistence.
Suwayomi owns Manga restore (`sourceId + manga URL`); its potentially accepted
submission needs a narrow durable intent/reference and bounded observation.
LNReader supplies Novel/plugin identity (`pluginId + novelPath`) and backup
concepts. Epigraph deliberately adds an identity-aware, Mihon-inspired Novel
merge that preserves destination-only chapters and conservatively protects
reading state: **EPIGRAPH_PRODUCT_EXTENSION**, not LNReader snapshot semantics.
B3 owns dependency discovery/install/remapping, preserving distinct Manga APK
and Novel plugin graphs. Universal Saga, compensation, per-object exactly-once
and universal local UNKNOWN are excluded from original B2.

Additional verified commits: `cc2bca8` wires the current mounted reader capability
(3 unit and 16 browser tests); `f5e69ae` adds the flat coordinator (13 focused
tests). The 2026-09-08 receipt `cda82f54-03cb-47c6-adaf-58ee1d0c2023` is
FINALIZED/PARTIAL: coordinator, native restore and atomic library persistence
checks passed; full original-B2 production acceptance was NOT_RUN. Its initial
and final verification-tree fingerprints agree. This receipt predates subsequent
Novel parser corrections and does not certify those later edits.

The working tree now contains the shared production factory and Settings/First
Run delegation, but that cutover remains under final acceptance review.
The 2026-09-08 receipt `9957dbd5-0a3d-4f42-8211-9472d807fa13` is
FINALIZED/PARTIAL: 240 unit tests passed (2 existing fixture skips), 22 Settings/
First Run step tests passed, 17 real-browser reader component tests passed,
28 native restore tests passed, and the frontend build passed. Initial and final
tree fingerprints agree. Backend/IPC fixtures were used; this is not a live
Suwayomi restore or desktop artifact certification.

This checkpoint includes strict local persistence, Novel category remapping,
native restore-session exclusion, cancellation/detach presentation, operation
target checks after asynchronous preparation, refreshed dependency readiness,
and preservation of empty destination categories. Commit `1bac2a7` separately
records coordinator cancellation/completion and admission lifetime changes;
the original staged diff was verified byte-for-byte unchanged.

Later focused tests cover failed input persistence before Manga submission,
corrupt-history refusal, observation-only reconciliation of a validated pristine
journal, retained terminal observations after backend status expiry, backend
generation rejection, and progress after successful reconciliation. These later
edits are not covered by receipt `9957dbd5`; their final evidence and the full
original-B2 acceptance mapping remain outstanding. Parent First Run integration
is also being checked. No B2 closure or B3 start is asserted here.

Interrupted local restore uses explicit, domain-native merge/upsert retry rather
than global rollback. Missing or unreadable external submission history is never
treated as proof that sending again is safe; preserve/refuse and diagnose.

### Original B2 acceptance reconciliation — 2026-09-08

The following is the original, simplified restore contract. It does not certify
installer handoff, every external plugin, a healthy Java environment, or global
atomicity across domains. Production cutover is present in the working tree;
unrelated pre-existing untracked First Run work is not swept into B2 commits.

| Original criterion | Implementation and executed evidence | Result |
| --- | --- | --- |
| One coordinator for Settings and First Run | Both call `backupWorkflow.restoreFiles`; the First Run factory is an alias of `createProductionRestoreWorkflow`. Production parity and 44 screen/startup tests passed. | PASS |
| No separate active executor | Active-path search and independent review found no legacy Settings/First Run execution path. Compatibility storage facade and factory alias only. | PASS |
| Reuse domain semantics | Flat file/domain invocations; adapters own commits. Local domains do not invoke the durable attempt engine. Production ordering/retry tests passed. | PASS |
| Manga delegates to Suwayomi | `restoreTransport.ts` issues multipart GraphQL `restoreBackup`; runtime tests checkpoint intent before the single send. | PASS |
| Stable Manga identity | Existing Mihon parser/reconciliation preserves provider source ID and manga URL; Epigraph does not perform catalog/chapter upserts. Manga format/bridge tests passed. | PASS |
| LNReader-derived Novel domain | Parser, provider model and local library service feed the conservative merge. LNReader parser and adapter tests passed. | PASS |
| Stable Novel identity | `pluginId + path`, chapter path under the restored Novel. Merge tests cover same path under different plugins. | PASS |
| Local IDs are not portable identity | Destination IDs retained; backup IDs mapped for chapter/progress/category relations. Collision and locator/category-remap tests passed. | PASS |
| Appropriate Books/App persistence | Content-keyed Book assets, strict awaited library persistence; App writes selected reading state before publication and preserves unrelated settings. Asset collision, quota, malformed-state and publication-order tests passed. | PASS |
| No active-operation completion replay | Coordinator retains succeeded units; original A-success/B-uncertain regression passed. | PASS |
| Content identity | SHA-256 plus byte size. Original changed-bytes/same-metadata and renamed-identical-content regressions passed. | PASS |
| No blind ambiguous Manga replay | Durable intent/reference, validated journal, observation-only reconciliation. Lost-response, missing-history, corrupt-history and one-send tests passed. | PASS |
| No invented outcome from status loss | Null/timeout stays unknown; generation changes refuse; durably acknowledged terminal observations survive TTL only under matching attribution/generation. Runtime tests passed. | PASS |
| Conflicting restore excluded | In-process target guard plus native OS file lock. Native child-process test proves exclusion and release; unrelated Manga input stays blocked without inheriting false submission evidence. | PASS |
| Truthful partial results/warnings | Succeeded units survive later failure; local failures remain failed; cancellation is not success. Settings results and First Run warning acknowledgement/progress tests passed. | PASS |
| Equivalent screen semantics | Shared factory, plan, readiness, order, retry and results; production parity plus both presentation tests passed. | PASS |
| Safe local interruption policy | New local operation may retry explicit domain merge/replacement with stable asset keys; successful active units are skipped. Corrupt destination refuses, including an existing empty Novel file. | PASS |
| UNKNOWN limited to ambiguous external work | Flat coordinator assigns unknown only to Manga; Books/Novels/App acknowledge ordinary local success/failure. Unknown input protection survives detach. Tests passed. | PASS |
| Truthful B6 verification | Receipts preserve separate stage results, mocked backend scope and missing full-closure stages. Receipt `618456a2-a2bd-4ea2-9916-f80dcdc6b505` covers 247 unit tests, 44 screen tests and build; final narrow validation follows the empty-file correction. | PASS |

Novel policy is deliberate: **LNREADER_PATTERN** supplies provider/path identity
and local-ID remapping; **MIHON_PATTERN** inspires identity-aware merging;
**EPIGRAPH_PRODUCT_EXTENSION** preserves current-only chapters and local user state.
Overlapping read/unread state stays local when no reliable user-action clock
orders the values; bookmarks are unioned. Progress uses a strictly newer,
attributable reading timestamp, not maximum percentage or a source-update clock.
Unknown/tied clocks preserve local progress and warn. Existing structural values
are retained and missing metadata filled. Category memberships are unioned using
destination IDs. These rules are covered by `novelsStateBridge.test.ts`.

**SUWAYOMI_PATTERN** supplies the actual Manga merge and ephemeral restore status.
**EPIGRAPH_REQUIRED_EXTENSION** supplies single-submit ambiguity protection,
content identity, target freeze and conflicting-restore admission. The v1 durable
envelope remains confined to Manga; unused generic fields do not authorize local
per-object journals, Saga, compensation, global rollback or universal writer locks.
**EXISTING_EPIGRAPH_BEHAVIOR** supplies Books/App storage; there is no new Moku
domain authority. Automatic adoption of missing/corrupt history is deliberately
unsupported: preserve evidence and refuse, rather than invent a successful or
safe-to-replay mutation.

The final execution receipt `e0c2f1ce-1f40-47f9-84b2-1d3a1228ee14` is
FINALIZED/PARTIAL: **261 unit tests PASS**, **44 screen tests PASS**, frontend
build PASS, and identical initial/final tree fingerprints. Two existing backup
fixture tests remain skipped. Its declared manual closure stage is NOT_RUN;
that historical receipt has not been rewritten to imply otherwise.

The separate `e9ae573e-c9b5-478f-b5fd-93edac30a3ad` receipt is FINALIZED/PASS
for **manual acceptance review and evidence integrity only**. It verifies the
execution receipt against the same current tree, confirms staged preservation,
and records the independently reviewed nineteen-criterion acceptance. It does
not claim a new native/browser test run, live backend restore, desktop binary
attestation or release certification. Earlier native/browser evidence retains
the scope and dates recorded above. **ORIGINAL_B2 = CLOSED.** B1 and B6 remain
closed; optional universal recovery machinery is not required.

The last production correction makes implicit Restore all include present
supported domains, so unresolved dependencies refuse execution instead of
silently omitting a domain. Explicit Settings exclusions remain honored.
The representative planner mock first exposed two failures; all ten production
workflow tests now pass. Commit `27df9bbf` also records corrupt-destination
preservation and isolation of unrelated Manga reconciliation evidence.

The dirty-state audit preserves earlier theme, First Run, OAuth, runtime and B6
work independently. B2 commits use an isolated index and selective mixed-file
content; the original 21-path staged diff remains unchanged. Ambiguous unfinished
foundation work is not included merely to clean the working tree.

### B3 initial reconciliation — 2026-09-09

Read-only follow-up has begun; no B3 implementation or closure is claimed.
`src/lib/reconciliation/readiness.ts` already distinguishes ready, installable,
unavailable and unresolved Manga sources using source IDs and APK packages.
`src/lib/setup/firstRunSourcesWorkflow.ts` already supplies repository refresh
and explicit install/enable actions. These are reuse candidates, not a reason
to create another restore executor.

`src/lib/backup/dependencyPreview.ts` carries repository URLs and plugin IDs;
`src/lib/backup/restoreAdapters.ts` now refuses unresolved Novel requirements
without installing them. `epigraphRestorePlanner.ts` still contains presentation
claims that dependencies will be installed, which must be reconciled with the
actual explicit installation flow during B3. Inspect those existing paths and
their pending user changes before implementation.

Preserve two graphs: Manga repository → APK package → sourceId → manga URL;
Novels repository → PluginItem/pluginId → novelPath. Existing Novel
`availableSourceIds` uses plugin IDs and does not justify another source entity.
B3 owns provenance, discovery, ambiguity, installation and remapping; B2 keeps
shared readiness and refuses unresolved requirements.

B3 execution order: first align the Novel payload planner with the shared
readiness refusal (`epigraphRestorePlanner.ts` and its tests); then reconcile
repository/plugin candidate identity and explicit installation with the existing
Sources services before connecting dependency actions to both restore surfaces.
For the first change, a missing repository/plugin must yield `blocked`,
`canRestoreNow=false`, and an actionable reason; metadata-only remains a warning.
Test the refusal first, implement only planner status/reason changes, rerun planner
and production parity tests, then commit only these initially clean planner files.
No source installation or restore mutation runs during these tests. Later B3
scope is determined from actual resolver gaps, not from a new transaction model.

First B3 slice implemented in `86cb61a14`: the Novel planner now blocks missing
dependencies and reports reasons without promising automatic provisioning.
Metadata-only restore remains warning-only; refreshed plugin registry and
availability make the plan ready again. A failing regression was observed before
the correction. Receipt `c76838af-4162-4437-abb2-a0b41edc0eff` is
FINALIZED/PARTIAL: 263 unit tests and 44 screen tests PASS, frontend build PASS,
two existing fixture skips, matching initial/final tree fingerprints. Full B3
acceptance is NOT_RUN; no live repository installation or backend restore was
performed. Build retains existing CSS/chunk warnings. The exact two initially
clean planner files were committed using an isolated index; the original staged
diff remains byte-for-byte unchanged. This shared backlog remains uncommitted
with its pre-existing audit history.

Next resolver boundary: `novelsRestoreProvisioning.ts` is not called by the active
restore executor (only retained through the compatibility runtime export). It
automatically trusts backup repositories and uses the first catalog match when
repository provenance is absent. Do not reconnect it unchanged. Reuse the existing
repository/package services only after explicit trust/selection and unambiguous
plugin provenance; preserve unknown origin as unresolved. Settings' Manga
installation path also needs reconciliation with the existing managed Sources
workflow and a refreshed inventory before declaring availability. **B3 remains
OPEN.** B1, ORIGINAL_B2 and ORIGINAL_B6 remain CLOSED.

Next B3 implementation slice: enforce the existing First Run cross-repository
plugin refusal inside the shared `novels/packages.ts` installer used by Sources
and its bulk update path. Initially clean scope: `packages.ts` and
`packages.test.ts`. Regression tests must prove enabled and disabled existing
plugins are preserved with zero network/native writes when another repository
offers the same plugin ID. Validate before storage resolution or fetch; retain
same-repository installation. No automatic replacement or new UI/executor is
introduced. Run package, Sources-workflow and backup regression tests, then build
and commit only this slice with the original staged diff preserved.

This slice is verified and committed as `198ad1a3a`. Both new rejection tests
failed before implementation and now prove zero network/native calls and an
unchanged input state for enabled/disabled plugins from another repository.
Same-repository reinstall remains permitted. Receipt
`3397809b-93d3-4469-9827-2f5e08b39532` is FINALIZED/PARTIAL: 31 focused unit
tests, 44 screen tests and frontend build PASS; initial/final tree fingerprints
agree. Full B3 acceptance remains NOT_RUN, and no real plugin download/install
was performed. Existing build CSS/chunk warnings remain. Only the two initially
clean package files entered the commit; original staged changes stayed identical.
Remaining B3 work includes candidate ambiguity before first install, explicit
repository consent/provenance, availability after installation and shared restore
dependency actions. This guard uses the supplied repository-state snapshot; it
does not claim cross-process installer serialization or resolve stale snapshots.

B3 continuation: replace implicit trust in `novelsRestoreProvisioning.ts` with
explicit repository approvals and per-plugin repository selection. Preserve
conflicting backup provenance instead of letting registry order pick a winner;
refuse ambiguous catalog candidates and cross-origin replacements. No approval
must cause zero provisioning operations. Existing success fixtures must explicitly
authorize their repository/plugin operations. After this contract passes, expose
read-only dependency plans and explicit actions to the production restore UIs;
the coordinator itself remains a restore executor, not an installer.

B3 dependency checkpoint (2026-09-09): both restore surfaces now expose shared
Novel dependency approval; First Run and Settings also expose the same Manga
dependency review. Settings' previous direct extension mutation handler now only
opens that review. Preparation holds a profile admission through fresh inspection,
validates package/repository attribution, and never equates install acknowledgement
with source availability. Missing remap candidates refuse execution; package
alternatives are retained instead of choosing the first match (`5acf8c66a`).
Novel preparation refuses conflicting origins, stale catalogs after refresh failure,
and reinstalling an existing disabled plugin. Installed Novel source descriptors no
longer borrow metadata from another repository or report a catalog version as the
installed version. Existing repository/plugin enablement and trust govern readiness.

Receipt `c295ef49-28f2-411b-99b0-c8b95288364a` remains FINALIZED/FAIL:
305 unit tests PASS, two existing fixture tests skipped, frontend build PASS,
46 screen tests PASS and one LNReader selection screen timeout at five seconds.
Initial/final tree fingerprints match. The failing screen passed separately without
code, assertion or timeout changes (one selected test, 16 excluded). Subsequent
Settings Manga integration passed its focused screen test and the shared Manga
component test; a fresh combined receipt follows. The attempted independent review
could not run because the reviewer reached its usage limit; it is not a PASS.

B3 remains OPEN. Remaining acceptance work must verify production dependency
factory target changes and source-install attribution through both UI entry points,
review shared-file preservation, and collect final evidence. No real plugin install,
backend restore, native lifecycle or release certification is claimed here. Disabled
or conflicting Novel installations are preserved for explicit reconciliation in
Sources; automatic cross-origin replacement is intentionally refused.

### B3 dependency acceptance — 2026-09-10

The dependency contract is complete in the verified working tree. Manga retains
repository → APK package → sourceId → manga URL; Novels retains repository →
pluginId → novelPath. Missing or conflicting dependencies may safely remain
unresolved, with an explicit refusal or preservation choice. This does not promise
that an arbitrary external repository/plugin is available or works correctly.

| Criterion | Implementation and executed evidence | Result |
| --- | --- | --- |
| Domain identity and provenance | `novelsRestoreProvisioning.test.ts`, `packages.test.ts`, `mangaRestoreDependencies.test.ts`: owning repository/package/plugin identities remain distinct; foreign homonyms do not replace installed plugins. | PASS |
| Read-only inspection and explicit consent | `restoreDependencies.test.ts`, `mangaRestoreDependencies.test.ts`, both shared component tests: inspection does not provision; preparation requires copied explicit approvals. | PASS |
| Ambiguity and existing-state preservation | Provisioning/package/session tests reject ambiguous or changed origins; disabled and conflicting installed plugins remain intact. | PASS |
| Fresh availability | Failed catalog refresh cannot authorize stale installation; post-install inspection does not equate acknowledgement with a usable source. `sources.test.ts` checks owning metadata and installed version. | PASS |
| Explicit, content-scoped mapping | Reconciliation tests reject absent mapped targets. `productionRestoreWorkflow.test.ts` and `FirstRunBackupStep.test.ts` prove a choice for backup A cannot affect B. Original IDs remain the default; choices freeze during execution. | PASS |
| Shared Settings/First Run integration | Both surfaces use the shared dependency components/sessions and restore coordinator. Settings' former direct extension mutation now opens explicit review. Settings and First Run screen tests pass. | PASS |
| Readiness parity | Native and Epigraph-contained Manga both use fresh inspection and the selected input's choices before unit creation. `restoreAdaptersProduction.test.ts` also preserves metadata-only Novel behavior without accepting missing used plugins. | PASS |
| Target freeze and exclusion | Production factory tests reject target changes; real adapter/transport tests prove zero mutation sends after changes during admission or headers. Installation, repository addition and catalog refresh carry the same final guard. Session tests retain exclusion while pending. | PASS |
| Detach and truthful results | Screen/session tests preserve active preparation on detach and report warnings/refusals. Planner tests reject promises of automatic installation. | PASS |
| Existing restore and evidence guarantees | The full backup test directory passes, including completion/retry and content-identity regressions. Thirteen evidence-contract tests pass; B1/B6 implementation is unchanged by this checkpoint. | PASS |

The independent read-only review found two defects: cross-file Manga choices and
target validation before awaited transport admission/credentials. Tests reproduced
both before correction. The reviewer then confirmed both fixes and the final
native/Epigraph readiness/message changes, with no remaining concrete blocker in
this dependency scope. The reviewer did not run tests.

Execution receipt `acb12db8-cebf-43d8-8fa9-798750f3013b` is FINALIZED/PARTIAL:
410 unit tests PASS, 49 screen tests PASS, frontend build PASS, 13 evidence tests
PASS, and whitespace check PASS. Two fixture-generation tests and one opt-in live
contract were skipped. Initial/final verification-tree fingerprints match. Its
manual acceptance stage was deliberately NOT_RUN; the receipt is not rewritten.
Separate receipt `29c701ea-a2ac-4d2a-9ba0-37417b4c9aca` is FINALIZED/PASS for
manual acceptance, executed-receipt/diagnostic integrity, unchanged source contents
after commits, and preservation checks. It does not rerun or relabel the tests.
Both receipts precede this documentation-only closure record.

Commits `d8ddb5c91` (final send-boundary guard) and `5103fb57e` (truthful Manga
dependency messages) contain only initially clean, independently reviewable files.
The original 21 staged paths remain byte-for-byte identical. All five translation
files retain their complete previous content after removing only the 16 new B3
keys. Diffs against the external pre-B3 snapshots preserve unrelated Settings,
First Run, OAuth and theme work. Mixed/untracked integrations remain in the working
tree; this closure does not certify a clean checkout or packaged release.

Files changed in this final review checkpoint:

- `src/lib/manga/runtime/{adapter.ts,adapter.test.ts,transport.ts,transport.test.ts,types.ts}`.
- `src/lib/backup/{productionRestoreWorkflow.ts,productionRestoreWorkflow.test.ts,mangaRestoreDependencies.ts,restoreDependenciesProduction.test.ts,epigraphRestorePlanner.ts,epigraphRestorePlanner.test.ts}`.
- `src/components/firstRun/{FirstRunBackupStep.svelte,FirstRunBackupStep.test.ts}` and `src/components/settings/RestoreMangaDependencies.svelte`.
- This existing backlog document. Verification runners, baselines and receipts remain outside the repository.

Live plugin download/install, backend restore, desktop lifecycle and release
artifact certification were not executed in this B3 gate. Existing CSS/chunk build
warnings remain. These limits do not imply an ownership defect or an automatic
dependency resolution guarantee. B1, ORIGINAL_B2 and ORIGINAL_B6 remain CLOSED;
no B4/B5/B7-B12 implementation was started.

All ten original ownership criteria have passing evidence. No open original
criterion or known foreign-process/wrong-instance ownership safety defect was
identified in the reviewed B1 paths. The safe named-job anchor and all fail-closed
ownership checks remain in place.

The later extended lifecycle goals are separate follow-ups, not reasons to keep
original B1 open:

| Destination | Remaining work | Current behavior |
| --- | --- | --- |
| UPDATER_HANDOFF | Graceful, attested installer/relaunch handoff | Refuses before unsafe updater exit. |
| PERSISTENT_MAINTENANCE | Owner-scoped maintenance lease transfer and restart/postcheck/rollback | Refuses before destructive maintenance. |
| RUNTIME_HEALTH | Healthy Java readiness and runtime/environment diagnosis | Preserves unowned listeners. |
| B6_RELEASE_EVIDENCE | Broad packaged release/installer certification | Minimal actual-binary ownership attestation is already verified. |
| FLARESOLVERR_ACCEPTANCE | Real executable availability and disposable full lifecycle | Retained-job ownership remains; real executable not tested. |
| LEGACY_TEST_HARNESS | Migrate old fault/two-instance helpers to exact-run control | Unsafe legacy operations refuse. |
| OPTIONAL_HARDENING | Automatic legacy adoption, evidence rotation, independent OS focus/placement assertions | Conservative preservation/refusal and exact target attribution already hold. |

The release observer's premature exit-code check was corrected in the external
verification harness. Its failed completion step passed on the actual release
Core with bounded CLI wait, retained process-object exit confirmation and a
byte-bound receipt. Earlier failed attempts remain preserved in the evidence.

No follow-up functionality or B2 work was started during this reconciliation.

B6 closure is supported by 25 Node tests and 19 PowerShell checks, including real
release-runner control flow with substituted disposable gates, actual locked-file
cleanup failure, interrupted workers and native rejection before launch. Receipt
`cf95729f-eff8-47bb-9d9a-de51654a1157` is FINALIZED/PASS. It certifies the evidence
mechanism only; no full application matrix or remote CI run is claimed.
