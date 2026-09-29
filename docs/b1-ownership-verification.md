# B1 ownership and lifecycle verification - 2026-09-06

**ORIGINAL_B1 = CLOSED.** The original audit objective is "Make launcher and cleanup ownership explicit." The later extended lifecycle goals remain separately incomplete; they do not reopen the original ownership objective. See the reconciliation below. This report distinguishes implemented controls from full application certification. B2–B12 have not been started. The previous phase report is preserved in the external B1 evidence directory; this report supersedes its now-stale lifecycle findings.

## Extended lifecycle ledger (historical scope, not original B1 acceptance)

| Original blocker | Implementation | Exact evidence | Current result |
| --- | --- | --- | --- |
| 1. Scoped graceful desktop shutdown | Exact run/nonce control; launch quiescence; retained runtime cleanup; native acknowledgement followed by same-object exit confirmation. | Final dev and release each: `results.json` (12 PASS), `interaction.json` (12 PASS); control tests (18); Rust control tests (4). | PASS for exercised desktop shutdown, including cancellation of an in-flight startup probe. Installer/update handoff is tracked under blocker 5. |
| 2. Run-host loss recovery | Existing named-job anchor; reopening plus same-handle process identity and membership validation. | Latest job fixture `epigraph-b1-job-a52418e2-1bc9-40ce-9dbc-86bb67210541`; actual dev/release paired run-host death and recovery. | PASS for anchored recovery; pre-anchor loss preserves/refuses. |
| 3. Dev/release artifact attestation | Private frozen builds; embedded build/source IDs; receipt desktop/Core hashes; locked binary validation. | Receipt tamper tests; paired actual dev/release candidates; latest dev candidate and final release retest below. | PASS on paired and final dev/release candidates. This does not certify an installer or B6 release evidence. |
| 4. Exact focus/CDP instance | Native run/nonce focus; connected pipe process identity; native one-use page challenge and document-bound mutation. | Paired fixtures each passed 13 interaction checks, including actual foreign-profile CDP rejection. Latest dev passed fresh/stale document and focus checks. | PASS for instance attribution. OS foreground success is not independently asserted; monitor evidence is the native API result and returned position. |
| 5. Safe legacy/recovery lifecycle | Preserve/refuse incomplete records; append-only completion receipts; fresh attested relaunch. Installer and persistent maintenance reject before unsafe transitions. | Actual rejection fixture: 4 PASS; latest dev relaunch PASS; installer preflight RED then 4 Rust tests PASS and actual refusal PASS. | PARTIAL: safe refusals are verified, but installer and persistent maintenance handoffs and old fault-helper migration remain incomplete. |
| 6. Full desktop/release lifecycle | Disposable profiles, receipt-bound candidates, native/CDP driver and retained Core observer. | Detailed 17-case matrix and final fixture evidence below. | PARTIAL: healthy Java, actual maintenance and real FlareSolverr verification remain incomplete. Extended lifecycle work remains incomplete. |

## Ownership guarantees

Before B1, `lib.rs` preferred a retained child but otherwise read `ServerOwner.java_pid`, found a process by PID through sysinfo, and called `process.kill()`. The fallback did not require run UUID plus full creation/executable/command identity; metadata could be removed without confirmed exit.

The current destructive Suwayomi path requires the retained spawn/run, exact profile/root/URL/port and owner scope, `spawned_by_app`, non-attach-only state, complete `ServerOwner.run_id` and `process_identity`, and unchanged raw owner bytes. Full Windows FILETIME must agree with its recorded seconds timestamp. Executable and parsed-command SHA-256 must match. Core additionally requires its in-memory spawned-run lease; reconstructed or disk-selected state grants no destructive authority.

Windows validation, termination and bounded wait use the SAME process handle/object. A saved PID never grants termination permission. Missing, stale, ambiguous, corrupt, unverifiable or inconsistent evidence rejects the operation. A query/open failure or unconfirmed exit preserves evidence. Core control validates its retained/original manifest, run UUID, full OS birth identity and pinned TLS identity, then requires a matching run/nonce acknowledgement and a wait on the validated process object. The entire Core request has an outer deadline.

Suwayomi/Core owner JSON is retained. After confirmed exit only, a flushed receipt binds the exact old metadata bytes by SHA-256. A replacement record cannot inherit that proof. Desktop session JSON is retained; its append-only close receipt requires exact root exit, waits on observed owned descendants, and accounts for explicitly preserved services. Nonempty kernel accounting plus missing inventory cannot be accepted as completion. The receipt describes observed descendant confirmation, not permission to delete arbitrary session state. FlareSolverr retains its contained job and waits for zero active processes before its successful metadata cleanup; its real executable lifecycle is still unverified.

## Existing Windows job investigation

The persisted job name is exactly `Local\Epigraph-<canonical run UUID>`. Creation is atomic with the suspended root through the process job-list attribute. Startup kill-on-close is enabled before publication, then disabled before resume; no breakaway flags are enabled. Inspection after publication reports `flags=0`.

The actual default security descriptor grants job access to the creating user, SYSTEM and its logon SID (full SDDL retained in `job-recovery.log`). The implementation does not install a new ACL or treat access to a name as authority. The client checks exact run-derived name, retained process creation/executable identity and `IsProcessInJob` through that process handle.

The disposable test proved that surviving associated processes alone did NOT keep a reopenable named job after the run-host's last handle closed. With the application-side query anchor, reopening succeeded after host death. Nested children were validated through both inner and outer job objects, and exit was confirmed through retained handles. Therefore the smallest recovery addition retains the existing job, rather than introducing a separate ownership mechanism. Loss before the application establishes its anchor remains conservative preservation/refusal.

## Adversarial review disposition

Fixed during this closure pass:

- Ephemeral Core shutdown could re-read/select another manifest: it now retains the original manifest and captured birth and compares the single byte buffer used for control.
- Persistent Core readiness now compares the manifest against the birth captured at spawn and retains the child/evidence on mismatch.
- Core binary substitution: receipt includes Core SHA-256, app holds a read lock before any Core spawn, and candidate builds use private target outputs.
- Same source fingerprint could select a different compiled artifact for focus: exact artifact/build ID must also match, and reuse returns the native acknowledgement.
- An acknowledgement or empty inventory could be mistaken for completion: retained process waits and kernel job accounting are required; missing members reject completion.
- CDP element coordinate actions could cross navigation: guarded mutations run in the attested document context; screenshots are not written until post-capture document checks succeed.

Unresolved functional boundary: Core startup acquires the shared runtime-maintenance lease. An updater holding the exclusive lease cannot restart Core's Java supervisor for postcheck/rollback. Releasing exclusivity would reopen the foreign-start race. `stop_runtime_for_maintenance` therefore refuses persistent Core maintenance before stopping the process or promoting/removing profile data. This is explicitly incomplete and must not be represented as a successful maintenance handoff.

## Current test evidence

- PowerShell ownership decisions: **20 passed**.
- PowerShell disposable launcher integration: **21 passed**, latest fixture `epigraph-b1-89f2f000-6016-4954-aac1-ba3b56556028`.
- PowerShell connected control, artifact selection and job remainder rejection: **18 passed**, fixture `epigraph-b1-control-9a68e965-81ec-4126-a97e-0735faafe7c1`.
- Rust native control/protocol: **4 passed**, including replay/missing/stale/foreign evidence and launch-quiescence timeout.
- Rust Core lifecycle route/control tests: **6 passed**, including local authority, remote/paired rejection, run/nonce checks and first-request serialization. The subsequent shutdown-pending regression observed RED (missing API), then all 3 control/protocol tests passed after the API and probe-loop cancellation were added.
- Node build receipt test: **1 passed**, containing positive and source/profile/mode/schema/desktop/Core tampering assertions.
- Earlier retained Windows ownership suite: **4 passed**, including the 20-case rejection matrix, actual correct/wrong creation identity, termination failure and timeout; negative cases assert zero terminate calls.
- Earlier candidate attempts failed before desktop launch: native warning handling, missing bootstrap Core/resource staging, then nested resource copy into an existing skeleton. Corrected staging is now hash-checked before compilation. No failed candidate was accepted as a current artifact.

The existing listener on MAIN port 4567 is outside these disposable runs and must be preserved. Its presence limits certification of a fresh MAIN Java runtime; successful Core HTTP startup alone is not proof that Java started.

## Preservation

Branch `codex/theme-system-refactor`, HEAD `583af8dfab6170d6b1eaae3bce9be6ae93d8d0ed`. Fresh checks confirm HEAD and index unchanged. Of 71 originally pending files, only the narrowly authorized `src-tauri/src/lib.rs` changed; the other 70 retain their baseline hashes. All **13 OAuth added/replaced blocks remain verbatim**.

The original staged diff (empty), unstaged OAuth diff and full dirty `lib.rs` were recorded before B1. The closure phase has a separate staged/unstaged/tree/hash baseline. [Exact B1-only lib.rs hunks](b1-lib-ownership.diff) compare against the original dirty file and exclude the pre-existing OAuth work (currently 40 hunks). No staging, commits, push, stash, reset, restore or unrelated cleanup occurred.

## Exact files changed by B1


- `docs/b1-lib-ownership.diff`
- `docs/b1-ownership-verification.md`
- `docs/runtime-session-policy.md`
- `scripts/EpigraphOwnership.ps1`
- `scripts/EpigraphProcessNative.cs`
- `scripts/EpigraphSessionTools.ps1`
- `scripts/capture-syncd-sse.ps1`
- `scripts/launch-desktop-epigraph.ps1`
- `scripts/launch-latest-epigraph.ps1`
- `scripts/launch-main-epigraph.ps1`
- `scripts/launch-main-user-epigraph.ps1`
- `scripts/run-epigraph-session.ps1`
- `scripts/run-local-data-release-certification.ps1`
- `scripts/run-syncd-bootstrap-phase-gate.ps1`
- `scripts/run-syncd-desktop-two-instance-harness.ps1`
- `scripts/run-syncd-discovery-phase-gate.ps1`
- `scripts/run-syncd-lan-hardening.ps1`
- `scripts/run-syncd-live-pairing-phase-gate.ps1`
- `scripts/run-syncd-mutations-phase-gate.ps1`
- `scripts/run-syncd-native-two-instance-automation.mjs`
- `scripts/run-syncd-native-two-instance-automation.ps1`
- `scripts/run-syncd-pairing-phase-gate.ps1`
- `scripts/run-syncd-phase-gate.ps1`
- `scripts/run-theme-runtime-audit.ps1`
- `scripts/stop-epigraph-orphans.ps1`
- `scripts/test-epigraph-ownership.ps1`
- `scripts/test-epigraph-session-integration.ps1`
- `src-tauri/src/lib.rs`
- `src-tauri/src/process_ownership.rs`
- `src-tauri/src/suwayomi_runtime.rs`
- `src-tauri/src/suwayomi_update.rs`
- `src-tauri/src/syncd/suwayomi_process.rs`
- `src-tauri/src/syncd_sidecar.rs`
- `src-tauri/tests/process_ownership_standalone.rs`

Additional closure files:

- `src-tauri/src/session_control.rs`
- `src-tauri/src/session_control_protocol.rs`
- `src-tauri/src/syncd/app.rs`
- `src-tauri/src/syncd/lifecycle.rs`
- `src-tauri/src/syncd/runtime_manifest.rs`
- `src-tauri/build.rs`
- `scripts/build-epigraph-candidate.ps1`
- `scripts/epigraph-build-receipt.mjs`
- `scripts/epigraph-build-receipt.test.mjs`
- `scripts/epigraph-session-client.mjs`
- `scripts/test-epigraph-session-control.ps1`
- `scripts/test-epigraph-job-recovery.ps1`
- `scripts/certify-b1-lifecycle.ps1`
- `scripts/certify-b1-lifecycle.mjs`

## Latest actual application evidence

Fixture `epigraph-b1-desktop-2a5e82cf-e491-47cf-8a2a-ee60b3eac55f` successfully built both debug executables, published the receipt and launched the embedded-attested application. `results.json` records exact artifact acknowledgement, foreign profile/worktree shutdown rejection, retained run-host termination, application survival and reopened-job control. `interaction.json` records TEST URL/profile, persistent Core startup, native focus at (320,116), monitor placement at (1920,-26), guarded DOM access, stale-document refusal after reload and fresh native attestation.

That run FAILED overall: the application refused graceful shutdown because a Java startup health loop was still in flight. Its runtime log records 90 probes over 231720 ms before the existing ownership-validated failed-start cleanup. A successful startup *request* therefore did not prove a healthy JVM. The new loop checks shutdown-pending and routes through that same retained-run cleanup, without granting new authority. Subsequent paired candidates and the final dev candidate passed shutdown after this cancellation change. No later absence from inventory is treated as that failed run's certified desktop exit.

The release attempt `epigraph-b1-desktop-075be524-cbc8-45ce-aa35-70eda9d87f52` failed on the earlier nested bundle-copy bug. A later dev attempt exposed Tauri replacing the target-side sidecar copy while the wrapper held a read lock. The wrapper now locks the freshly compiled staged SOURCE copy, which Tauri reads, and retains it through receipt publication. Subsequent private dev/release builds passed; neither earlier failure is counted as release verification.

## Final static and focused checks

On the current shutdown-cancellation code, `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets --jobs 1` passed (existing Core dead-code warnings only). `test-epigraph-session-control.ps1` passed 18 checks again, fixture `epigraph-b1-control-5b37bf48-76b5-434c-aaa4-f13d5109ee84`. The complete named-job test passed again, fixture `epigraph-b1-job-a52418e2-1bc9-40ce-9dbc-86bb67210541`. PowerShell AST and Node syntax checks passed. Current preservation evidence is `%TEMP%\epigraph-b1-closure\preservation-current.json`.

The current call-site search finds no PID-only termination in the changed B1 Rust/native/launcher paths. `TerminateProcess` calls target either the same validated handle or the retained spawn object; FlareSolverr uses its retained job. The legacy helper named `Stop-ProcessByPathPattern` only detects residue and throws. These results do not certify unmodified external scripts or the unavailable real FlareSolverr executable.

Current dev fixture `epigraph-b1-desktop-e3cd2b8e-ba3a-4dd6-aebb-b6306630d959` also passed four actual-app rejection checks (`actual-rejections.json`): wrong creation identity, missing control version, missing run ID and malformed record. Each used a separate diagnostic copy, retained it, left the original session bytes unchanged, and successfully re-attested the still-running original application after rejection.

## Final actual lifecycle evidence and remaining gaps

Final dev fixture: `%TEMP%\epigraph-b1-desktop-230c382c-a35f-4be8-a330-19e9b8e3b446`. `results.json` contains 12 PASS and `interaction.json` contains 12 PASS, including installer refusal before the updater plugin can perform its implicit process exit. `core-lifecycle-evidence.json` contains 3 PASS: Core survives the confirmed desktop exit, survives a fresh same-profile run, and exits through its own full-identity/run/TLS/nonce shutdown contract with retained-handle confirmation. `interrupted-launch.json` confirms the actual receipt-verified executable was suspended, never resumed, and aborted/waited through retained process objects.

Paired actual dev/release fixtures `epigraph-b1-desktop-e3cd2b8e-ba3a-4dd6-aebb-b6306630d959` and `epigraph-b1-desktop-fe47cf20-7c98-480b-b4df-0b03b9a9efb4` each contain 10 lifecycle PASS and 13 interaction PASS. Both applications ran concurrently with different profiles and each rejected the other's native/CDP authority. Those receipts precede the final installer refusal change and are retained as evidence for that tested revision, not reused as current launch authority.

| Required actual case | Status | Exact evidence / limitation |
| --- | --- | --- |
| 1. Cold launch | PASS | Final dev/release results. |
| 2. Exact artifact | PASS | Embedded identity acknowledgement and receipt binary hashes on both build modes. |
| 3. Exact profile | PASS | Native launch target TEST/MAIN URL in interaction JSON. |
| 4. Concurrent worktree/profile | PASS | Paired actual profiles; foreign record rejected on each real page. Different-worktree shutdown is separately rejected. |
| 5. Exact focus | PASS | Run/nonce native focus acknowledgement; no external HWND fallback. Foreground state itself not independently measured. |
| 6. Exact CDP | PASS | Native proof, guarded document operation, stale-document rejection and fresh attestation. |
| 7. Persistent Core | PASS for final dev/release | Three retained-handle observer checks; release observer confirmed survival; its completion failure is reconciled separately below. This is not Java health certification. |
| 8. Graceful close | PASS | Same-object root wait and native completion receipt. |
| 9. Owned descendants | PASS for observed owned descendants | Retained waits plus kernel job accounting; explicitly preserved Core is separately observed. |
| 10. Relaunch | PASS for final dev/release | Fresh UUID in same disposable profile, exact acknowledgement, confirmed second exit. |
| 11. Interrupted launch | PASS for final dev/release | Actual binary, suspended before publication/resume, retained-object abort and wait. |
| 12. Published run-host death | PASS | Host-only retained-object termination, application survival, existing-job reopening and control. |
| 13. Stale ownership | PASS | Wrong creation identity actual-app rejection; original session bytes unchanged, app re-attested. |
| 14. Legacy/ambiguous | PARTIAL | Actual malformed/missing-field records preserved and rejected; focused ambiguity tests pass. Old fault-helper workflows still conservatively refuse. |
| 15. Update/reset B1 lifecycle | PARTIAL | Unsafe implicit installer exit and persistent-maintenance transition refuse before action. Owner-scoped handoffs are not implemented or certified. |
| 16. Monitor placement | PASS for native API result | Actual acknowledged position (1920,-26); no independent visual/foreground assertion. |
| 17. Real disposable FlareSolverr | NOT TESTED | Executable unavailable; retained-job focused tests do not substitute for a real lifecycle. |

The final all-target Cargo check passed after the installer guard. Existing Core dead-code warnings remain. Native installer preflight tests first failed for the missing guard, then all 4 control tests passed. No installation was attempted. The guard intentionally blocks installation until a graceful, attested handoff exists: the current updater plugin otherwise launches the installer and calls `std::process::exit(0)` outside the ownership exit gate.

The healthy JVM lifecycle remains unverified: the dev runtime startup request did not establish API health, while MAIN port 4567 belongs to an unowned listener and was preserved. No B2 runtime fix was introduced. Persistent update/reset needs a lease-preserving handoff between the exclusive maintenance owner and Core startup; releasing the lease to bypass the deadlock would permit foreign startup and is not acceptable.

## Required rejection-path mapping

`src-tauri/tests/process_ownership_standalone.rs` exercised these cases before enabling the destructive contract; its four tests passed. The rejection matrix asserts zero terminate calls. Failure/timeout cases permit a termination attempt only after positive ownership validation and assert that cleanup is not confirmed.

| Requested case | Evidence | Result |
| --- | --- | --- |
| Correct PID and correct creation | Positive fake contract and real Windows child retained-object test | PASS |
| Correct PID, wrong creation | Matrix and real Windows child rejection | PASS; zero foreign termination |
| Reused PID | Same PID with changed full creation identity | PASS; zero termination |
| Missing process identity | Matrix | PASS; zero termination |
| Missing run ID | Matrix; actual desktop diagnostic copy | PASS; zero termination |
| Stale record | Raw-record consistency rejection | PASS; zero termination |
| Malformed record | Malformed run/schema and actual malformed session copy | PASS; zero termination |
| Disappears during validation | Identity-query error path | PASS; zero termination |
| Cannot open/query | Query-denied matrix and real invalid-handle open | PASS; zero termination |
| Ambiguous evidence | Inconsistent/raw-record and scope rejection | PASS; zero termination |
| Termination failure | Validated fake object refuses termination | PASS; cleanup unconfirmed and evidence retained |
| Termination timeout | Validated object termination request followed by wait timeout | PASS; cleanup unconfirmed and evidence retained |

Failure/timeout simulation proves control-flow behavior; it is not a claim that an arbitrary real foreign process was forcibly terminated during testing.

### Final release result and observer limitation

Final release fixture `%TEMP%\epigraph-b1-desktop-a7ab0f27-0e25-45c9-925c-0d83835f0545` completed successfully: **12 lifecycle PASS, 12 interaction PASS**, including installer refusal, same-profile fresh run and both confirmed desktop exits. `interrupted-launch.json` also records the receipt-verified actual release executable aborted before publication/resume, using retained process objects.

Its Core observer recorded **2 PASS and 1 FAIL**: retained-object checks proved Core survived desktop close and relaunch, but the external helper reported completion unconfirmed. The release Core is built with `windows_subsystem = "windows"`; the helper invoked it with PowerShell `&` and checked `$LASTEXITCODE` without an explicit process wait. This is a likely harness timing/exit-code defect; it was not rerun and its FAIL remains intact.

Independent reconciliation found `server.owner.6b012096b0731345ac1d25149111915e4eb270b5cbfb10ce0f6ca0a8a60cf87b.stopped` exactly byte-equal to the original manifest and correctly named by its SHA-256. The candidate Core client emits this receipt only after matching run/nonce/TLS identity, waiting on its validated process handle, and rechecking original bytes. `core-completion-reconciliation.json` records that PASS. This is positive completion evidence, not an inference from missing PID inventory. It does not erase the external observer failure or turn the full lifecycle matrix into a pass.

Both final candidate build/certification processes and both observers have finished. No force cleanup was substituted for the failed observer. Those functional handoffs, real runtime coverage, legacy harness migration and verification limitations remain follow-up work outside original B1 closure.

## Original audit reconciliation — 2026-09-06

**ORIGINAL_B1 = CLOSED.** Original objective: **Make launcher and cleanup ownership explicit.** This determination uses the ten original acceptance criteria below, independently of the later six-blocker/17-case extended lifecycle ledger. The historical failures above remain evidence; safe refusal of a broader functional workflow is not a foreign-process ownership failure.

### Original acceptance evidence

All ten original criteria have passing executed evidence. Paths below are relative to this repository unless prefixed by `%TEMP%`.

| Original criterion | Current implementation | Executed evidence | Result |
| --- | --- | --- | --- |
| Owned session/build/profile identity | `EpigraphOwnership.ps1`, `EpigraphSessionTools.ps1`, receipt validation and `session_control.rs`: canonical worktree, profile scope, run UUID, source/build UUID and actual desktop/Core hashes. | Final dev `epigraph-b1-desktop-230c382c-a35f-4be8-a330-19e9b8e3b446` and release `epigraph-b1-desktop-a7ab0f27-0e25-45c9-925c-0d83835f0545`: each 12 desktop + 12 interaction PASS. Fresh control suite rejects same-source/different-artifact selection. | PASS |
| Read-only inspection | `Get-EpigraphOwnedInspection` classifies without destructive action; `stop-epigraph-orphans.ps1` requires explicit `-Stop` and exact run for destruction. | Fresh `epigraph-b1-inspection-8d4e2076-4b12-4121-8f69-e03eb5ded248/inspection-result.json`: metadata byte hashes unchanged and retained process still live after inspection. | PASS |
| No port/name-only ownership | Names/ports only discover candidates or conservatively exclude them. Native destruction requires validated process identity and membership; Rust requires retained run and complete identity. | Fresh 20-decision suite rejects three listener ports and unverifiable evidence; 4-test Rust suite includes wrong executable/command, missing identity, query denial and zero termination assertions. | PASS |
| Unrelated listeners preserved | No port-clearing fallback; occupied unowned endpoint refuses. | Fresh 21-check integration fixture `epigraph-b1-ccbee2dc-68f4-4c29-9e9e-ba1302d9ab0b` connected successfully to unrelated listeners 1420/4667/9223 after cleanup. Real MAIN candidate preserved the unowned 4567 listener. | PASS |
| PID reuse rejected | Full creation FILETIME and executable identity are checked through the candidate handle; Rust also validates parsed-command hash and run contract. | Fresh Rust 4 tests: wrong birth on real Windows child rejected; correct birth stops only retained child. Twenty-vector rejection matrix includes reused PID and asserts zero terminate calls. Fresh integration rejects same PID with stale creation. | PASS |
| Other worktrees/profiles preserved | Request scope must match canonical project/profile/run/build; ambiguous matches refuse. | Fresh integration proves foreign-profile and foreign-worktree processes survive owned-run cleanup. Paired actual dev/release `e3cd2b8e...` / `fe47cf20...` each reject the other profile's CDP authority; actual foreign-worktree shutdown requests reject. | PASS |
| Interrupted launch safe | Atomic suspended creation in job, startup-only kill-on-close before publication; retained object confirmation; published descendants require positive ownership. | Fresh integration: pre-publication capability loss confirms root exit and owned descendants survive interrupted root then clean safely. Both final actual binaries have `interrupted-launch.json` PASS. | PASS |
| Persistent/attach-only Core preserved | Persistent service trees are excluded from launcher force cleanup; attached/discovered state grants no destructive lease. Persistent desktop shutdown detaches. | Fresh integration proves fake persistent Core and descendant survive; fresh Rust matrix rejects attach-only and discovered Core with zero terminate calls. Final actual Core observer records survival across desktop close/relaunch in dev and release. | PASS |
| Requested instance selected | Explicit run/profile/worktree/artifact selection; ambiguity refuses; native run/nonce focus and document challenge, no arbitrary HWND authority. | Fresh 20-decision suite selects requested of two valid runs; fresh 18-control suite rejects foreign pipe server, ambiguous candidate and wrong artifact while preserving processes. Paired actual profile/CDP checks pass. | PASS |
| Cleanup only positively owned processes | Same process object through validation, termination and bounded wait; unchanged metadata rechecked; timeout/failure retains evidence. Unknown is never owned. | Fresh 4 Rust tests cover 20 rejection vectors plus termination failure/timeout; fresh 18-control suite rejects missing inventory/kernel count and reused identity. Actual desktop close receipts confirm root and observed owned descendants. | PASS |

Fresh commands: `powershell -NoProfile -File scripts/test-epigraph-ownership.ps1` (20 PASS); `powershell -NoProfile -File scripts/test-epigraph-session-integration.ps1` (21 PASS); `powershell -NoProfile -File scripts/test-epigraph-session-control.ps1` (18 PASS, fixture `epigraph-b1-control-adb126fa-0c9c-4b13-889e-ba75df33854f`); `rustc --edition=2021 --test src-tauri/tests/process_ownership_standalone.rs` followed by the resulting test executable (4 PASS).

### Job Object discrepancy resolved: namespace lifetime versus object lifetime

No job architecture change was made. The diagnostic used a temporary instrumented copy of the actual `EpigraphProcessNative.cs` launch implementation, retaining its suspended atomic job assignment and publication/resume flags. The instrumentation captured last-error values immediately and added read-only queries. It never installed an application anchor. Its controller retained only the candidate process handle between probes; temporary query handles were closed before host death.

Evidence: `%TEMP%\epigraph-b1-no-anchor-eed92266-eb7e-4078-a628-4cca699bbd5e/result.json`; diagnostic source/driver under `%TEMP%\epigraph-b1-reconcile`. OS: Windows NT 10.0.26200.0.

| Requested observation | Recorded result |
| --- | --- |
| Exact persisted job name | `Local\Epigraph-f30b03ff-42f7-41d3-9126-bebad5aaa17b` |
| CreateJobObject result / GetLastError | Non-null / 0 |
| OpenJobObject before death / GetLastError | Non-null / 0 |
| LimitFlags immediately before death | 0; kill-on-close and breakaway flags absent |
| Active process count before death | 2; successful kernel accounting query |
| Candidate identity | PID 23736; full FILETIME `134331405396291017`; `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`; parent PID 24888 |
| IsProcessInJob before death | API success, membership true; last-error 0 |
| Host termination | `StopRetained`: TerminateProcess on the retained spawned host handle followed by bounded exit confirmation |
| OpenJobObject immediately after death | NULL; GetLastError 2 (`ERROR_FILE_NOT_FOUND`) |
| Associated candidate after death | Still alive through retained process handle; same creation/executable identity |
| IsProcessInJob after reopening | Not callable for the original job because reopening failed. Post-failure query fields are unavailable, not evidence of zero active processes. |
| Additional name-lifetime probe | CreateJobObject with the SAME name succeeds, last-error 0 (not already-exists); new job active count 0; candidate IsProcessInJob returns false while candidate remains alive. New empty job closed without touching candidate. |
| Candidate completion | Natural exit confirmed through retained OS object; no candidate PID termination |

Microsoft's [Job Objects documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) describes when the job object itself is destroyed. Its [Object Manager lifetime documentation](https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/life-cycle-of-an-object) separately states that a temporary object's name is removed when its handle count reaches zero, while pointer references can keep the object alive. [ZwMakeTemporaryObject](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/nf-wdm-zwmaketemporaryobject) documents the same name-removal rule.

The experiment is consistent with both rules: the old job remains referenced by associated processes but loses its namespace entry at last-handle close. A fresh job can reuse that name and does not contain the old candidate. The previous report was imprecise if read as claiming the old job object had been destroyed. Name unavailability does not establish object destruction. The existing application query anchor preserves the name's availability, and recovery still requires full identity plus membership. **Anchor retained unchanged.**

### Release Core observer correction and rerun

The original observer used PowerShell `&` followed immediately by `$LASTEXITCODE`. A Windows GUI-subsystem probe reproduced the defect: invocation returned in 39 ms for a program that sleeps 1800 ms, leaving the previous exit code 91. Explicitly retaining and waiting for that CLI process returned its actual exit code 23. Evidence: `%TEMP%\epigraph-b1-reconcile/observer-wait-regression-confirmed.json`.

Only the external observer harness was corrected: hidden `ProcessStartInfo` invocation, bounded 45000 ms CLI wait, then that process's ExitCode, followed by a 5000 ms wait on the already-validated Core object. No application lifecycle code changed. An optional runtime-fixture path permits retaining separate rerun evidence. Diff: `%TEMP%\epigraph-b1-reconcile/observer-harness.diff`.

The failed completion step was rerun against the actual hash-locked release Core binary in a fresh disposable Core fixture. **3 PASS** in `%TEMP%\epigraph-b1-core-observer-52848c06-1d0b-4c5d-a689-753762fe5048/results.json`: CLI exit 0 after bounded wait; same validated Core object confirms exit (run `7f5b8ad9-eb00-4b49-9e7d-c20ffac33195`, FILETIME `134331410560344872`); original manifest retained and byte-bound completion receipt verified (SHA-256 `47404efd696fc63021f1a8fa366284a4ca75a85dbca05ae840c03cb5ad6ed16f`). This reruns the failed observer completion step, not a claim to have rerun every desktop/release case.

Intermediate attempts remain intact: a different-profile receipt reuse refused before launch; a full-driver rerun passed 12 desktop cases but the observer missed a live root observation and refused identity validation. Its later Core completion was not certified and its metadata remains. Those failures were not rewritten to PASS. The focused fresh Core rerun avoids replacing or adopting that incomplete state.

### Remaining work by destination

| Currently open extended item | Destination | Ownership implication |
| --- | --- | --- |
| Installer graceful exit and artifact-bound installation/relaunch handoff | UPDATER_HANDOFF | Currently refuses before invoking updater's implicit exit. Functional gap, no foreign-process authority. |
| Owner-scoped Core lease transfer for update/reset/restart/postcheck/rollback | PERSISTENT_MAINTENANCE | Currently refuses before destructive maintenance. Releasing the lease to bypass the conflict is not allowed. |
| Healthy Java startup, readiness and MAIN occupied-port environment | RUNTIME_HEALTH | Unowned listener preserved. A healthy JVM is not required to prove safe launcher refusal/cleanup. |
| Packaged installer, broad release matrix and release evidence system | B6_RELEASE_EVIDENCE | Minimal actual-binary attestation already passes original B1. |
| Real FlareSolverr availability and full executable lifecycle | FLARESOLVERR_ACCEPTANCE | Retained-job ownership contract remains; absent executable does not grant foreign termination. |
| Old two-instance/fault helpers migrated to owned protocols | LEGACY_TEST_HARNESS | Unsafe helpers already refuse. Their usability is separate from ownership safety. |
| Automatic adoption of legacy/corrupt state | OPTIONAL_HARDENING | Not required. Diagnose/preserve/refuse and fresh complete state is the accepted outcome. |
| Independent OS foreground/visual placement assertions | OPTIONAL_HARDENING | Exact native request target already proven; this measures UI action success. |
| Archive/rotation policy for retained evidence | OPTIONAL_HARDENING | Retention currently favors diagnosis; no deletion authority inferred. |
| Original ownership criteria | ORIGINAL_B1_REQUIRED — all satisfied | No open original criterion or known foreign-process/wrong-instance ownership defect identified. |

No reclassified functionality was implemented. No B2 work started. Backlog status is recorded in [project audit backlog](project-audit-backlog.md). Closure is a finding about the reviewed and executed B1 paths, not a proof about arbitrary external scripts.
