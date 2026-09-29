# First Run Mockup Production Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the full production pages currently embedded in first run with the approved first-run mockup while preserving the existing backup, source, tracker, sync, and Library services.

**Architecture:** `FirstRun.svelte` remains the persisted route/state coordinator but renders focused first-run step components. Headless controllers expose the already-existing production operations to both Settings/Browse and first run; no backup parser, repository client, extension installer, tracker backend, or Library is duplicated. Each visual step follows `docs/mockups/epigraph-first-run.html` and uses the Nocturne tokens already shipped by the app.

**Tech Stack:** Svelte 5, TypeScript, Vitest browser/jsdom, Tauri v2, existing Epigraph backup and Suwayomi runtimes.

**Spec:** `docs/design/first-run-experience-spec.md`

## Global Constraints

- The approved prototype is the visual and interaction reference.
- Never render `Settings`, `SourcesView`, `Search`, or `BrowseV3` as a child page of first run.
- Reuse existing domain operations; do not create alternate parsers, catalogs, installers, trackers, or Library stores.
- Every user action must persist or fail atomically through the same production service used outside first run.
- A repository is written only after the user submits it; an extension is installed only after its visible action.
- A backup is inspected before any profile write and a failed restore leaves no partial state.
- Preserve the clean-install gate, legacy-install compatibility, resume, focus, reduced motion, and 800 × 600 native minimum.
- Work in red/green slices and visually certify each slice before starting the next.

---

### Task 1: First-run shell and route contract

**Files:**
- Modify: `src/components/firstRun/FirstRun.svelte`
- Create: `src/components/firstRun/FirstRunShell.svelte`
- Modify: `src/components/firstRun/FirstRun.test.ts`
- Modify: `src/components/firstRun/FirstRun.browser.test.ts`

**Interfaces:**
- Consumes: `FirstRunState`, `setFirstRunStep()`, `setFirstRunPath()`, `completeFirstRunState()`.
- Produces: `FirstRunShell` with the approved titlebar/progress chrome and one content snippet. `FirstRun.svelte` retains title/content/footer markup because it owns route transitions and focus; page height is bounded to the app viewport.

- [ ] **Step 1: Write failing browser assertions** that the shell has exactly one titlebar/progress surface, uses the refined centered 760 px work area, and exposes no nested Settings/Browse topbar, app rail, or duplicate window controls at 1280 × 800 and 800 × 600.
- [ ] **Step 2: Run** `pnpm test:browser src/components/firstRun/FirstRun.browser.test.ts` and preserve the failure against the embedded-page implementation.
- [ ] **Step 3: Implement the shell** from the prototype:

```ts
type FirstRunShellProps = {
  progress: readonly ProgressItem[];
  activeProgressIndex: number;
  subtitle: string;
  progressLabel: string;
  children: Snippet;
};
```

- [ ] **Step 4: Render theme and entry through the shell** without changing their persisted state transitions.
- [ ] **Step 5: Run focused unit/browser tests and inspect both viewport sizes** before proceeding.

### Task 2: Shared backup workflow controller

**Files:**
- Create: `src/lib/backup/backupWorkflow.ts`
- Create: `src/lib/backup/backupWorkflow.test.ts`
- Modify: `src/components/settings/Settings.svelte`
- Modify: `src/components/settings/settingsStorageRuntime.ts`

**Interfaces:**
- Produces:

```ts
type BackupWorkflowFile = {
  path: string;
  name: string;
  kind: BackupImportKind;
  status: "inspecting" | "ready" | "invalid";
  plan: EpigraphRestorePlan | null;
  error: string | null;
};

type BackupWorkflowSummary = {
  workCount: number;
  repositoryCount: number;
  extensionCount: number;
  conflictCount: number;
  libraryKinds: Array<"manga" | "books" | "novels" | "app">;
  needsSourceKinds: Array<"manga" | "novels">;
};
```

- [ ] **Step 1: Write failing controller tests** for multiple files, mixed formats, invalid-file isolation, deterministic summary, no writes during inspection, and idempotent re-selection.
- [ ] **Step 2: Run the tests and confirm the missing controller failure.**
- [ ] **Step 3: Extract orchestration from Settings** while keeping the existing parsers, preflight, reconciliation, dependency preview, and restore executors unchanged.
- [ ] **Step 4: Make Settings consume the controller** and run its existing backup tests to prove no regression.
- [ ] **Step 5: Run backup unit/contract suites** before exposing the controller to first run.

### Task 3: Dedicated backup selection and review steps

**Files:**
- Create: `src/components/firstRun/FirstRunBackupStep.svelte`
- Create: `src/components/firstRun/FirstRunBackupStep.test.ts`
- Modify: `src/components/firstRun/FirstRun.svelte`
- Modify: `messages/en.json`, `messages/pt-BR.json`, `messages/es.json`, `messages/ja.json`, `messages/zh-CN.json`

**Interfaces:**
- Consumes: `BackupWorkflowFile[]`, `BackupWorkflowSummary`, `selectFiles()`, `removeFile()`, `restore()`.
- Produces: `onRestored({ hasLibrary, needsSourceKinds, sourceTypes })`.

- [ ] **Step 1: Write a failing real-component test** for the prototype’s “Selecione os backups” and “Revise a importação” states, including file icons, counts, removable rows, expandable merge decisions, progress, retry, and disabled action rules.
- [ ] **Step 2: Verify red against the current embedded Settings panel.**
- [ ] **Step 3: Implement the two focused states** with the prototype hierarchy and current theme tokens.
- [ ] **Step 4: Connect the native multi-file picker and shared controller**; do not route to Settings.
- [ ] **Step 5: Test clean, mixed, corrupt, duplicate, interrupted, and successful restore states; visually certify before Task 4.**

### Task 4: Dedicated repositories and extensions step

**Files:**
- Create: `src/lib/setup/firstRunSourcesWorkflow.ts`
- Create: `src/lib/setup/firstRunSourcesWorkflow.test.ts`
- Create: `src/components/firstRun/FirstRunSourcesStep.svelte`
- Create: `src/components/firstRun/FirstRunSourcesStep.test.ts`
- Modify: `src/components/firstRun/FirstRun.svelte`

**Interfaces:**
- Consumes existing `getManagedSourceRuntime()`, `resolveExtensionStoreInputUrl()`, novel repository state, and extension/package installers.
- Produces:

```ts
type FirstRunRepository = {
  id: string;
  kind: "manga" | "novels";
  url: string;
  status: "loading" | "ready" | "error";
  extensions: FirstRunExtension[];
  error: string | null;
};
```

- [ ] **Step 1: Write failing tests** for explicit URL submission, duplicate rejection, error/retry, source-kind persistence, backup-filtered extensions, single/bulk installation, and readiness.
- [ ] **Step 2: Implement the headless adapter using existing runtimes.**
- [ ] **Step 3: Implement the prototype’s compact repository form and extension rows**, including icons, language, state, details, and progress.
- [ ] **Step 4: Remove first-run rendering of `SourcesView`; retain normal Browse > Sources behavior unchanged.**
- [ ] **Step 5: Certify a real repository and extension in a disposable native profile before Task 5.**

### Task 5: Dedicated tracker step

**Files:**
- Create: `src/components/firstRun/FirstRunTrackersStep.svelte`
- Create: `src/components/firstRun/FirstRunTrackersStep.test.ts`
- Create: `src/lib/tracking/firstRunTrackerWorkflow.ts`
- Modify: `src/components/firstRun/FirstRun.svelte`

**Interfaces:**
- Consumes the same tracker queries and Hardcover operations used by Settings.
- Produces per-provider idle/connecting/connected/error state and optional continuation.

- [ ] **Step 1: Write failing tests** for seven services, login action routing, error/retry, skip, and no automated authentication.
- [ ] **Step 2: Implement the shared tracker adapter and compact prototype rows.**
- [ ] **Step 3: Remove first-run rendering of `Settings firstRunPane="tracking"`.**
- [ ] **Step 4: Run Settings tracker regressions and visually certify the step before Task 6.**

### Task 6: Dedicated Library discovery step

**Files:**
- Create: `src/lib/setup/firstRunDiscoveryWorkflow.ts`
- Create: `src/lib/setup/firstRunDiscoveryWorkflow.test.ts`
- Create: `src/components/firstRun/FirstRunDiscoverStep.svelte`
- Create: `src/components/firstRun/FirstRunDiscoverStep.test.ts`
- Modify: `src/components/firstRun/FirstRun.svelte`
- Modify: `src/components/pages/SeriesDetail.svelte`

**Interfaces:**
- Reuses existing Browse search/popular queries and Library mutation.
- Produces compact `FirstRunWorkCard[]` and `addToLibrary(work)`.

- [ ] **Step 1: Write failing tests** for installed-source popular results, named search, empty/error/loading states, direct add, mutation failure rollback, and immediate `libraryMangaSnapshot` refresh.
- [ ] **Step 2: Implement the headless adapter and compact four-card/two-card responsive grid from the prototype.**
- [ ] **Step 3: Remove first-run rendering of `Search`/`BrowseV3`.**
- [ ] **Step 4: Fix the shared Library mutation path only if the failing test reproduces stale snapshot behavior.**
- [ ] **Step 5: Visually add one real work, prove Finish cannot be bypassed while empty, then finish and relaunch to the normal Library.**

### Task 7: Sync, completion, and full certification

**Files:**
- Create: `src/components/firstRun/FirstRunSyncStep.svelte`
- Create: `src/components/firstRun/FirstRunCompleteStep.svelte`
- Modify: `src/components/firstRun/FirstRun.svelte`
- Modify: `docs/bug-report.md`

**Interfaces:**
- Reuses existing Syncd session operations and existing first-run persisted completion contract.

- [ ] **Step 1: Replace the embedded Syncd panel with the prototype’s focused host/connect states while keeping Syncd as authority.**
- [ ] **Step 2: Render the prototype completion summary from real results.**
- [ ] **Step 3: Run full Vitest, browser, Svelte, Rust, source contracts, backup/APK certifications, and `git diff --check`.**
- [ ] **Step 4: Build a clean native candidate and repeat first run visually at 1280 × 800 and 800 × 600.**
- [ ] **Step 5: Continue the already-approved complete user-flow matrix only after first run passes; update docs, request final review, commit, and produce the release build only when every acceptance gate passes.**

## Self-review

- Spec coverage: theme, exclusive entry paths, sync, multi-backup inspection/review, repositories, extensions, trackers, discovery, resume, completion, accessibility, and failure states each map to a task.
- Placeholder scan: no deferred implementation placeholders are used; every task names files, interfaces, red tests, production behavior, and verification.
- Type consistency: first-run components consume shared headless workflows; Settings/Browse remain normal page consumers of the same domain services.
- Scope: this plan changes first-run composition, not parser formats, updater policy, reader behavior, or normal-page visual design.

## Execution checkpoint — 2026-09-03 (not release certification)

At this earlier checkpoint, the dedicated backup, sources, and tracker surfaces were in the working tree, discovery still embedded Search, and sync used the embedded connection panel. See the later checkpoint below for discovery changes. This milestone is **not complete** and must not be committed/released as certified.

Corrections verified by focused red/green tests:

- Source hydration waits before writes; installation state publishes during the request; failed installs remain retryable.
- Failed novel catalog refreshes are not saved as successful additions. Manga catalog refresh can reuse a repository written by an earlier failed attempt.
- Novel plugin identity includes its repository and trust/enabled state. Re-enabling an installed plugin uses the existing state setter instead of reinstalling and resetting its files/settings.
- Manga installs revalidate their currently resolved repository before writing.
- Source catalogs are searchable and initially render 12 extensions per repository. Bulk actions require explicit backup extension IDs; they must not install an entire unfiltered catalog.
- Trackers and Hardcover load independently. Confirmed login/logout is distinguished from a failed list refresh, and stale list responses cannot overwrite newer authentication state.
- Native OAuth capture has request-correlated callbacks and per-session window labels, with cleanup on cancellation/unmount. The optional callback field preserves the existing Settings consumer.
- Dedicated step headings share the shell hierarchy and receive keyboard focus.

Executed checks at this checkpoint:

- Focused workflow/component tests: **38 passed** across six files.
- Browser shell/focus tests: **6 passed**, including the source pagination/session-correlation candidate. Startup changes made after this run still require revalidation.
- Rust library suite: **474 passed, 1 ignored** in the ordinary suite. The ignored live Discord test was then run explicitly against the running desktop client and passed.
- Frontend production build passed. Existing Syncd unused-CSS and bundle-size warnings remain.
- Typecheck previously reported **0 errors, 54 existing Syncd CSS warnings**; rerun after the latest additions is still required.

Remaining gates include the independent follow-up review, full frontend suite, fresh native visual verification, localization, the unfinished plan tasks, and the broader clean-profile backup/APK/reader regression matrix. No commit, installer publication, or full-functionality claim has been made.

### Additional regression findings and Discord check

- The full frontend suite initially reported one failure: the startup journey still expected the old SourcesView fixture. The test now drives the dedicated source workflow, asserts that Continue is locked until installation, and explicitly skips optional trackers. Its focused rerun passed.
- A discarded pre-login tracker response could still overwrite Home's shared cache. A production-adapter regression reproduced the failure; removing the read adapter's unconditional cache publication made it pass. Login/logout still invalidate the cache.
- Native testing found an interrupted-first-launch case: settings could be persisted before Layout registered the pending setup, making the next launch resemble a legacy install. The new startup regression covers enrollment before Layout and keeps legacy installations unchanged. Native revalidation of the fix is pending.
- Native inspection also found Nocturne replacing the intended initial Light theme during profile preparation. Startup now initializes the pending setup's missing theme before scoped settings are captured. Explicit saved choices are preserved; the corrected candidate still needs native revalidation.
- Discord focused tests: **59 passed** in five files (presence lifecycle, private mode, disabled state, reconnect, progress throttling, public cover resolution).
- Live Discord IPC: **1 passed**, with explicit client acknowledgement of both the temporary test activity and its removal. The smoke test now checks these acknowledgements and attempts connection cleanup before reporting a failure; it does not print account payloads.
- This Discord evidence does **not** yet certify the visible Settings toggles, all three real readers, app restart, or the activity card rendered by Discord. Those remain part of the clean-profile visual journey after the first-run gates.
- Visual harness prerequisite: the installed WebView2 was 152.0.4191.53 while the existing driver was 150. A matching Microsoft-signed driver was downloaded only into the disposable test directory; the system driver and normal profiles were not changed.

### Discord visual acceptance matrix (added at the user's request)

Keep Epigraph in its disposable profile. Do not sign in, sign out, change privacy settings, or terminate the user's Discord client. Only a temporary Epigraph test activity is authorized.

- [ ] Finish the first-run gates using visible controls; confirm Discord presence defaults to disabled.
- [ ] Enable Discord Rich Presence through Settings and observe navigation activity in Discord.
- [ ] Read a test manga, book, and novel; compare the displayed title/chapter/progress to the reader, allowing the existing progress throttle.
- [ ] Enable private mode through Settings; confirm title, cover, and chapter/progress are absent from subsequent activity.
- [ ] Toggle title, cover, and progress visibility individually and confirm the corresponding data is omitted.
- [ ] Navigate away from the reader and verify that stale reading activity is replaced.
- [ ] Disable presence and close/reopen Epigraph; confirm activity removal and persistence of the disabled preference.
- [ ] With presence enabled, close Epigraph and verify activity removal. Do not simulate a disconnected Discord client by terminating the user's process; lifecycle failures are covered by the deterministic service tests until a separate Discord test environment is available.

The live IPC test is supervised in its own test-binary child with a 15-second deadline, since the underlying library's synchronous pipe reads cannot be cancelled by a Tokio timeout. Only that owned test process is terminated on timeout. The supervised variant's final live rerun passed with the desktop client confirming publication and removal (one logical test; both child and supervising parent exited successfully).

### Resource constraint — 2026-09-03

At the user's request, run at most one heavy build or suite at a time, with low process priority and at most two test workers (prefer one). Do not change unrelated applications or global machine settings.

The full frontend rerun was deliberately interrupted to reduce load, so it has no passing final result. The concurrent browser rerun timed out during initial navigation before executing any tests and also is not a passing result. Repeat both sequentially after the native build. The disposable Suwayomi was stopped while not needed. The remaining native build was set to BelowNormal priority and restricted to two logical processors; approximately 4 GB of system memory became available after stopping the parallel work.

The resource-limited native build subsequently passed (`release`, automation configuration, no installer). Candidate SHA-256: `F37687CCB6FD5889D3435F9FA5BF1A9C70F74E01BC60DDEEEE3D9AB3F29801BD`. This is the working-tree candidate based on `583af8dfab6170d6b1eaae3bce9be6ae93d8d0ed`, **not** a clean committed release or completed native certification. Startup-focused rerun: **39 passed** across five files. All previously listed uncompleted gates remain open.

### Discovery and profile-isolation checkpoint — 2026-09-03

The working tree now renders a dedicated discovery step instead of Search/Browse. It reuses existing manga/novel source services and Library persistence. Backup, source, tracker, and discovery strings were migrated to the five existing message catalogs. Sync and completion remain unfinished; the earlier native binary predates these changes.

Focused red/green regressions cover serialized novel writes, duplicate submissions, error retry, mixed-domain results, blocked/adult source filtering, resolved/retryable manga covers, stale profile acknowledgements, queued-search cancellation, draining active work before disposal, shared runtime ownership, and returning to discovery after Back. Each mounted discovery step owns a fresh workflow. Runtime coordination wraps the existing novel host; it does not create another host or source implementation.

The GraphQL client now captures connection URL, credentials, and local profile before awaiting the mutation lease. It rejects a changed context before dispatch, for JSON mutations and uploads, rather than sending an old identifier to a new profile. Four regressions reproduced the previous behavior before the fix.

Latest focused run: **57 passed across eight files** (`client`, `runtimeHost`, `runtimeSession`, discovery workflow/production/component, `FirstRun`, and `FirstRunGate`). One worker, BelowNormal priority, two logical processors, no parallel build. Independent read-only review found no remaining concrete blocker in these changed paths. Other novel consumers retain request-level protection but do not yet hold whole-operation runtime leases.

The browser run reproduced an incorrect four-column grid at 800 × 600; matching the mockup's 900px breakpoint corrected it. The rerun passed **9/9 browser component scenarios**, including visible-control add/finish actions at 1280 × 800 and 800 × 600. Screenshots were inspected. This uses deterministic source fixtures, not real native sources. `svelte-check --threshold error` reported **0 errors, 54 existing warnings in SyncdConnectionPanel**. `git diff --check` passed (line-ending notices only).

This is not native certification: a fresh native candidate build, real-source journey, Sync/completion work, full regression matrix, and release gates are still pending. No new commit or release was produced.

### Native discovery findings — 2026-09-04

The next automation candidate built successfully with SHA-256 `F440053E477BA86C04DC52A7D6885F9D71F38A4462B4DB6DA705FD7E2621DB13`. In a disposable profile, visible controls confirmed the initial Light theme, the fresh-data path, manual addition of the official LNReader repository (278 catalog entries), installation of Illusia 1.0.2, and optional tracker navigation. Persisted repository state confirmed one installed plugin belonging to that repository. No titles had been added yet.

Discovery failed: popular loading timed out and a subsequent visible search reported a source challenge. Inspection found valid Illusia HTML containing Cloudflare's background detection script. The novel runtime classified script URLs as challenge text. A focused regression failed with the same error, then passed after excluding scripts/styles from text classification while retaining challenge-form detection. Runtime and source-access tests: **24 passed across two files**. This is a shared novel fetch fix and still requires fresh native verification of browse, details, and chapter retrieval.

The Sources placeholder now follows the selected app language, and its empty message waits until loading finishes. Focused Sources component tests: **5 passed**. These changes and the challenge fix postdate the candidate above; its screenshots cannot certify the updated code. A replacement automation build is underway. Completion, clean-profile round trips, reader/Discord visual checks, final commit, and release remain open.

Independent review identified a localized Turnstile regression in the initial detector adjustment. A test reproduced blocked HTML reaching the chapter parser; structural `.cf-turnstile` recognition corrected it. The final focused rerun passed **26 tests across two files**, including valid HTML with external/inline scripts and CSS, one-fetch behavior, localized challenge forms, and FlareSolverr recovery. Follow-up review found no additional introduced blocker. The previous broad matching of challenge words in legitimate content and optional Turnstile widgets remains a known limitation; this checkpoint does not claim universal source compatibility.

### Native reading and completion checkpoint — 2026-09-04

The intermediate automation build succeeded with SHA-256 `6DEBC21CB98A3052594791328D1828BA6F542AB6F62FA3A91F9FC3F999A6C2E2`. It includes the initial background-script detection fix, but predates the final structural Turnstile refinement and the corrections below. It is **not a release candidate certified against all current changes**.

Using visible controls in the same disposable profile (no normal-profile data):

- First run resumed at discovery, preserving Light theme, the official repository, and the installed Illusia plugin.
- Popular discovery returned eight real novels with covers. Adding Lorde dos Mistérios persisted one Library entry and 1,437 chapters; completion became available after the save.
- Opening chapter 1 left all chapters unread and created no reading progress. Scrolling to 40%, closing, and reopening restored `scrollTop=2628` of 6570, with zero read chapters.
- Scrolling past 95% marked only chapter 1 read. Opening chapter 2 at the top did not mark it read or create a new history entry. Scrolling chapter 2 to approximately 40% stored overall progress `(1 + 0.400050) / 1437`, with one read chapter and two history entries.
- After exiting and restarting the disposable app, Library displayed 1,436 unread chapters. Continue chapter 2 restored `scrollTop=3192` of 7979. This verifies app restart for this native novel journey, not backup restore or every reader mode.

Native testing also found two defects: completion opened empty Comics despite the novel-only Library, and NovelReader rendered white text over a light panel. The latter was a CSS-variable scope error: the prose color tokens were resolved on the viewer while only its child article supplied the palette. NovelReader now supplies those colors on the viewer, matching BookReader without replacing the shared token system.

Completion now chooses the populated section and preserves the selected section in mixed libraries. Independent review caught an asynchronous mixed manga/novel edge case; completion now waits for the novel Library check, keeps failures blocked with retry, and ignores completion events while blocked. Pending-read and failure/retry tests cover that behavior.

Focused verification after these corrections: **25 tests passed** (`FirstRun` and reader token contracts), and **14 browser tests passed** (first-run layouts at 1280 × 800 and 800 × 600, novel palette changes across three app themes, custom colors, and existing novel progress failure/loading regressions). All three palette scenarios and the incorrect destination cases failed before their respective fixes. Independent follow-up review found no additional concrete blocker in these two adjustments. The test app and its owned Suwayomi process were stopped to free memory; its disposable data remains available for the next candidate.

These source changes still require native revalidation in a new build. Sync/completion mockup work, the full backup/APK/export/regression matrix, Discord's visual journey, final commit, and release remain open. No full-functionality or release certification is implied by this checkpoint.

Typecheck after this block reported **0 errors and 54 existing Syncd CSS warnings**. A replacement native automation build is being generated with one Cargo job, BelowNormal priority, and two logical processors; the disposable native app and its server remain stopped during compilation.

### Sync review findings awaiting reproduction

Read-only review of the remaining embedded sync path identified these specific gaps; they are **not yet fixed or runtime-certified**:

- `pairingStage` treats any `connect.status === "connected"` or any active replication session key as connected. Readiness therefore does not distinguish replaying, offline, paused, or reauthentication states from a completed initial sync.
- Pairing/desktop snapshots are not consistently filtered by the selected local profile, and pending catalog/replication reads can publish results after a profile change. The embedded component is reused across that change.
- Disconnect removes a catalog entry without immediately invalidating the cached connected state used by first-run readiness.
- The sync step routes through trackers rather than deciding summary versus discovery after the initial replication and local Library refresh finish.

The dedicated first-run sync composition must retain the existing `syncdDesktop.ts` commands, pairing approval, real bootstrap/QR handling, profile-scoped session catalog/replication snapshots, domain permissions, and App reconciliation. The prototype's short pairing code is illustrative; it must not be implemented as a new unsupported transport. Follow the existing bootstrap input and QR-image decoding contract. Unmounting the step must release listeners without disconnecting a persisted user session.

### Native palette verification and visual audit - 2026-09-04

The automation binary `D9EB050970B2D05AC5D97B47F8347FA2326290DA565C3AE0E3B02651BA6F366A` built successfully. In the disposable novel profile, visible controls verified the corrected dark prose palette, a switch to Sepia without changing progress/history, and restoration of the second chapter's scroll position. Scrolling and leaving the reader within 205 ms also flushed the newer position, before the normal debounce elapsed. This is limited native reader evidence, not the complete reader/backup matrix.

The next clean profile reached backup selection through the first-run controls, but no backup was selected or restored. The user then rejected the first-run visual alignment. Backup testing was paused to audit the rendered native surface against the design spec, approved HTML/CSS mockup, and the existing Library appearance. The earlier no-overflow assertions were insufficient to certify visual consistency.

Design direction: preserve the Nocturne product identity and central setup composition; variance 5, motion 3, density 3. Taste informed the preservation audit, not a new marketing-page layout. The existing Manrope font was loaded correctly. Confirmed defects were:

- At 1280 x 800, progress content started at x=316 while the page started at x=260. At 800 x 600, their left edges differed by 20 px. Progress and content now share the same gutter/width contract.
- Theme previews used stale metadata swatches. First run now derives the displayed palette from the existing built-in theme contracts; selecting all eight themes is compared against the rendered CSS palette.
- Fixed control typography ignored the app resolution scale, and primary actions used inverse text instead of the app's on-accent token. The five dedicated steps now use the existing action/text tokens for these controls.
- The titlebar subtitle, tracker rows, upload surface, and backup summary had reintroduced presentation removed by the approved mockup. Those surfaces were adjusted without changing their workflows. Trackers use a 640 px column aligned with the common content edge.
- Narrow layouts removed progress labels from the accessibility tree. The labels now remain available to assistive technology while visually hidden.

Regression evidence: five initial visual tests failed before the first corrections; the additional semantic-color, tracker-width, narrow-label, titlebar, and summary checks also reproduced their respective defects before correction. One backup-layout test initially asserted a chapter count that is not shown in the summary; its expectation was corrected and the actual background defect reproduced before implementation. The combined focused run passed **58 tests across six files**, including **23 browser scenarios** and the existing first-run/backup/sources/trackers/discovery component tests. Independent read-only review found no introduced blocker in this visual slice. Browser screenshots were inspected at 1280 x 800 and 800 x 600.

The test app and its owned Suwayomi process were closed to free memory. Numerical contrast verification, typecheck, and a new automation binary are being run serially with one worker/job and limited CPU. The updated native visual inspection is pending. Sync/completion fidelity, full clean-profile regressions, commit, and release remain unapproved; none of the focused evidence above certifies those remaining gates.

### Native scrollbar regression - 2026-09-04

The next automation binary (`B67122C82818628F3C49295E2E0C55248DEF275538FFD5D4BA6150EC37EF02A9`) built successfully. A fresh disposable profile verified Light as the initial theme, matching progress/content edges at 1280 x 800, switching to the real Nocturne palette, and reaching the dedicated backup selection through visible controls. No backup was selected or restored. At 800 x 600, the theme choices remained reachable by scrolling, but the native WebView2 scrollbar revealed a further 4 px difference between the progress and content widths. The earlier headless browser checks used overlay scrollbars and missed this case.

Two new regressions explicitly reserve scrollbar space. They failed with a 2 px edge displacement at 1280 x 600 and a 4 px displacement at 800 x 600. The page now measures its central column against the existing shell container; the scrollbar occupies the outer gutter without changing the column or creating horizontal scrolling. The existing scroller and navigation remain intact. Independent read-only review found no concrete introduced overlay regression.

The updated browser file passed **25 tests**, including the reserved-scrollbar cases, numerical primary-action contrast of at least 4.5:1 in all eight built-in themes, and the earlier focused visual checks. Typecheck after this CSS change reported **0 errors, 54 existing Syncd warnings**. A replacement native build and visual verification of this final scrollbar adjustment are pending. The disposable native app and its owned server are stopped during compilation; one Cargo job, BelowNormal priority, and two logical processors remain the resource limits.

### Final native alignment checkpoint - 2026-09-04

The replacement automation executable built successfully: SHA-256 `9A83501521A7C8FA89F5A70F30AE55A1715B6904575603EF2C3FFE1977E710A0`. Frontend production compilation and Tauri release compilation passed. This is a working-tree automation build without an installer, not a certified final release.

In a newly created profile (`epigraph-first-run-grid-W0YzYh` under the system temporary directory), the native journey used visible controls to select Nocturne, scroll, continue to the origin choices, open backup selection, and return twice to theme selection. No backup was imported, no extension installed, and no normal-profile data was used.

- At 1280 x 800, progress and content both span x=260..1020 in Light and Nocturne.
- At 800 x 600, both span x=40..760 with WebView2's real vertical scrollbar. The scrollport has clientWidth=796 and scrollWidth=796: no horizontal overflow.
- Scrolling reaches Continue at y=530..568. Clicking it opens the origin choices normally.
- Backup selection uses its dedicated surface, with no embedded Settings/Browse page. Review import remains disabled without a file. The heading receives focus; Back returns to the origin choices and then to the theme heading, preserving Nocturne.
- Screenshots of both themes at 1280 x 800, the narrow theme page before/after scrolling, and backup selection at 800 x 600 were visually inspected. Evidence is retained in that disposable directory.

The native app was closed through its titlebar control and its owned Suwayomi child was stopped. Focused visual alignment is verified; Sync/completion composition, full backup/APK/reader/tracker/Discord journeys, full-suite gates, commit, and release remain open. The existing 54 Syncd CSS warnings and four Rust dead-code warnings are not resolved by this visual change.

### Current B4 native lifecycle checkpoint — 2026-09-18

The current First Run presentation is now full-window, uses the existing theme
contracts for palette previews, keeps the titlebar controls aligned, and uses a
smaller density tuned for the desktop surface. Those changes are covered by the
focused browser suites but remain subordinate to the native lifecycle gate.

The active B4 readiness implementation reads strict Books and Novels state for
the selected profile before publishing Sync readiness. A Manga GraphQL refresh
is conditional on an applied Comics scope, and Novel source-classification
metadata is not part of the First Run library hydration prerequisite. The
readiness key is stable across advancing replication checkpoints and still
changes for a new session or runtime bootstrap generation.

Candidate 11 was built and attested, then exercised in a disposable profile.
Fresh and Backup both passed clean entry, visible completion and restart. Sync
entered the live paired state and applied the Novels checkpoint, but the page
remained in its loading state until the bounded condition timed out. The B6
receipt `db8d47f2-1a74-48b9-9393-00ed39e9607c` is FINALIZED/FAIL, with matching
initial/final tree fingerprints and PASS exact-run cleanup. Direct bounded reads
of the strict Books and Novels stores resolved during the failed stage, so the
remaining defect is at the active UI hydration/readiness completion boundary.

B4 remains OPEN. The next implementation slice must add an executable regression
for the pending-to-ready transition, preserve profile/session/generation fencing,
and rerun the complete native journey through Sync restart before any closure
claim. B1, ORIGINAL_B2, B3, B5 and ORIGINAL_B6 remain closed; B7-B12 remain
untouched.

### ORIGINAL_B4 closure checkpoint — 2026-09-19

The final disposable native receipt `e4f41d83-0b20-48c7-80ab-95403ea251f5`
is FINALIZED/PASS for the current dirty working tree. Fresh, Backup and Sync
all complete through their visible First Run controls and survive a fresh
owned restart. The Sync completion boundary is now fenced against unrelated
replication updates, and native Novel state fills missing strict profile
metadata before persistence reads. Cleanup and initial/final verification-tree
comparison pass. ORIGINAL_B4 is closed; this checkpoint does not certify a
release and does not begin B7-B12.
