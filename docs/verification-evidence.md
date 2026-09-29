# Verification evidence

Use a dated receipt for the exact source/artifact and scope you want to assess.
A historical test total, successful build, or preparation stage does not certify
the current application or an unexecuted user journey.

## Entry points

- `powershell -NoProfile -File scripts/verify-release.ps1 -ListStages` derives
  stage names and preparation/verification kinds from the actual runner calls.
- `scripts/verify-release.ps1 [-BuildReceipt <B1 receipt.json>]` runs declared
  gates under a supervisor. Without a supplied receipt it invokes the existing
  B1 candidate builder. It does not create a disposable Git worktree.
- Native viewport/navigation/local-data runners require `-BuildReceipt` (or
  `EPIGRAPH_BUILD_RECEIPT`). `-App` must match that receipt. Their narrow mock-Core
  journeys do not certify first-run, real backend health or authenticated services.
- `scripts/certify-suwayomi-release.mjs` records JAR preparation separately from
  executed schema/semantic/restart verification. It does not approve an update.
- `node --test scripts/verification-evidence.test.mjs` and
  `powershell -NoProfile -File scripts/test-verification-evidence.ps1` test the
  evidence mechanism with deliberate failures, not the full application matrix.

Local receipts default to `%LOCALAPPDATA%/Epigraph/verification/<UUID>/receipt.json`.
Override with `EPIGRAPH_VERIFICATION_ROOT`, outside the source tree. Output prints
the exact receipt path. Child receipts carry the parent verification ID; parents
record references, hashes, terminal state and outcome of available child receipts.
Detailed historical B1 evidence remains in [the B1 report](b1-ownership-verification.md).

## Version 1 common envelope

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `verificationId` | Contract version and unique immutable run identity |
| `receiptState` | `RUNNING`, `FINALIZED`, `INTERRUPTED` |
| `outcome` | `PASS`, `FAIL`, `PARTIAL`, `NOT_TESTED` |
| `startedAt`, `completedAt` | UTC timestamps; completion is null while running |
| `runner` | Harness name/hash where available, platform, Node version, parent ID |
| `repository` | Redacted canonical worktree label, exact-path digest, HEAD and dirty state |
| `tree` | Initial/final digest-only snapshots, capture status and comparison |
| `build` | Existing B1 receipt reference/hash, validation, build ID, HEAD and source fingerprint |
| `artifacts` | Exact desktop/Core redacted path references and B1 SHA-256; JAR hash/version where applicable |
| `backend` | Kind, availability, observed version/capabilities; null when not observed |
| `scope` | Exact declared journey/route and environment category |
| `stages` | ID/name/kind/required/condition, status, start/completion, exit code/reason |
| `failures`, `limitations` | Failure locations and explicit bounds on claims |
| `cleanup` | Separate status and attempts/errors; not a replacement for gate results |
| `diagnostics`, `children` | Sanitized relative references, digests and sizes/states |
| `retention` | Local policy and separate requested CI retention |

Stages use `PASS`, `FAIL`, `SKIPPED`, `NOT_APPLICABLE`, `NOT_RUN`.
Preparation has its own `kind`. Conditional stages stay visible with reasons;
unreached stages stay `NOT_RUN`. Stage failures cannot be rewritten as success.
Required skipped/unrun verification prevents overall PASS. Preparation alone
produces `NOT_TESTED`. Any recorded gate, cleanup or tree-comparison failure makes
the outcome FAIL, even if other stages pass.

## Receipt lifecycle and failure survival

The RUNNING receipt is created before gates. Each transition writes a new sibling
file, flushes it, then atomically renames it over the receipt. Readers reject PASS
on a non-FINALIZED receipt. Terminal receipts cannot be reopened for mutation.
Every rerun gets a fresh UUID; previous failures are not overwritten.

Failure information is checkpointed before disposable cleanup. Final tree capture
and cleanup status are recorded on both success and handled failure. The aggregate
supervisor finalizes an unexpectedly exited worker as INTERRUPTED and captures the
final tree. If both supervisor and worker are forcibly killed, the last RUNNING
checkpoint survives; it is **not completed PASS**. A final snapshot cannot be
promised after machine loss. Unavailable tree capture is recorded as failure, not
fabricated equality. Process inventory absence is not used as ownership evidence.

The evidence directory is separate from release scratch/profile directories.
Only bounded sanitized diagnostics enter it; arbitrary scratch directories,
profiles, screenshots, backups and raw logs are not automatically exported.
Existing optional detailed report locations remain references, not an excuse to
embed entire logs. Suwayomi default reports live with its unique receipt; explicit
`--artifact-dir` gets a distinct UUID subdirectory on each invocation.

## Verification-tree fingerprint policy

`git-index-and-nonignored-worktree-v1` is distinct from B1 `sourceFingerprint`:

- Includes HEAD; a digest of `git ls-files --stage -z` (staged modes/object IDs and
  conflict stages); a digest of porcelain status; and a canonical digest of all
  tracked plus nonignored untracked entries, including deletion state.
- File entries contribute SHA-256 of relative path, bytes and size. Only aggregate
  digests/counts are persisted. File bodies, raw Git patches, raw status, raw index
  and raw path inventories are never written to evidence.
- Includes tracked `.env`/credential-like files **only as digests**, never contents.
  Ignored untracked `.env`, build outputs, caches, logs and `.git` internals are
  excluded. Symlink targets are hashed without following them. Gitlink/index state
  is included; nested submodule contents are not recursively inventoried.
- Checks index/status/HEAD stability and file size/mtime around reads. Concurrent
  edits may make capture fail; it is not an atomic filesystem snapshot.

Raw canonical paths are used locally for B1 validation; published labels redact
the home directory and include a digest for exact identity. Digests are integrity
evidence, not encryption and not permission to publish source files. Never attach
the source manifest or candidate input contents as diagnostics.

Redaction covers structured secret/API-key fields, quoted assignments/JSON,
authorization/cookie headers, bearer values, private-key blocks and URL userinfo,
queries and fragments. Diagnostics are allowlisted summaries, not arbitrary file
uploads. No regex sanitizer can reliably recognize an unlabeled arbitrary secret;
callers must not supply secret-bearing bodies or environment dumps.

## Retention

**Local:** 30 days, 100 completed runs, 1 GiB managed total, 10 MiB per run.
Receipt maximum is 512 KiB; individual text diagnostics are bounded and report
truncation. Completed managed UUID directories are pruned oldest-first. Active or
unverifiable evidence is protected; exhausted protected capacity refuses new gates.
Only verified descendants of the configured evidence root are eligible for pruning.
Candidate binaries/private build caches are existing B1 outputs, not evidence-log
copies; this B6 retention policy does not silently delete those artifacts.

**CI:** workflows request at most 30 days from `actions/upload-artifact`, capped to
the runner's `GITHUB_RETENTION_DAYS` when lower, and write `ci-retention.json`. They use
run ID/attempt in artifact names with `if: always()`. Repository/organization limits
govern the effective GitHub expiration independently of local retention. If those
settings require another maximum, use GitHub's reported expiration as authority;
it does not change a test outcome. [GitHub retention documentation](https://docs.github.com/en/actions/tutorials/store-and-share-data).
Remote workflow execution is not implied by local fixture success.

## Current verification record

See the dated B6 entry in [the project audit backlog](project-audit-backlog.md).
Historical roadmap/bug-report results remain specific to their dates and commits.
No receipt from a fixture or an older candidate asserts that current HEAD passes
the full application acceptance matrix.

## B4 current native lifecycle evidence — 2026-09-18

The current B4 candidate was built and attested from the dirty working tree in
`5d049aa1-19ad-4c11-b13f-87ace7917976` (candidate 11). The disposable journey
receipt is `db8d47f2-1a74-48b9-9393-00ed39e9607c`. It is FINALIZED/FAIL, retained
as truthful evidence rather than converted into a partial pass:

| Stage | Result |
| --- | --- |
| Candidate attestation | PASS |
| Fresh clean entry, completion and restart | PASS |
| Backup entry, completion and restart | PASS |
| Sync clean entry | PASS |
| Sync visible completion | FAIL — the page remained in the initial hydration loading state until the bounded journey condition timed out |
| Sync restart | NOT_RUN because Sync completion did not pass |
| Exact-run cleanup for all started instances | PASS |
| Initial/final verification-tree comparison | PASS |

The recorded Sync state was `live` with a current remote bootstrap generation,
no replication error and a Novels scope checkpoint. A bounded diagnostic read of
the strict Books and Novels stores resolved during the same run. This narrows the
remaining B4 defect to the active UI hydration/readiness completion boundary;
it does not authorize treating a live session alone as setup completion. The
existing B1-owned process guard preserved an unrelated process on the default
Suwayomi port, and no ownership or wrong-instance safety regression was found.

This receipt does not close B4, certify a release, or change the scope of the
closed B1/B2/B3/B5/B6 items.

## ORIGINAL_B4 final native lifecycle evidence — 2026-09-19

Candidate build receipt `eb9c41c2-7d76-4fbb-8e20-bdf611674629` attests the
candidate-16 desktop/Core pair from the current dirty working tree. The
separate disposable journey receipt `e4f41d83-0b20-48c7-80ab-95403ea251f5`
is **FINALIZED/PASS**. It runs the real clean First Run flow with isolated
Fresh, Backup and Sync roles; no bypass, seeded completion marker or normal
user profile is used.

All required journey stages passed: Fresh start/completion/restart, Backup
start/import/completion/restart, Sync pairing/current remote bootstrap,
strict library hydration/completion and Sync restart. The Sync diagnostic
records `replicationStatus=live`, bootstrap generation `2`, no error, and the
persisted `B4 First Title` library entry. Exact-run cleanup passed for all
three roles. Initial/final verification-tree digests match, so the dirty
working tree and unrelated processes were preserved.

The focused UI regression suite records 22 Syncd panel tests PASS, including
an in-flight hydration that survives an unrelated replication update. The
native targeted tests record PASS for both authoritative empty-snapshot metadata
initialization and incremental Novel metadata initialization/preservation.
The candidate build also completed with the existing non-blocking CSS/chunk
warnings. This closes ORIGINAL_B4's native clean-user acceptance scope; it is
not a broad release certification and does not start B7-B12.

## B6 focused certification — 2026-09-06

**ORIGINAL_B6 = CLOSED.** Final focused run: `cf95729f-eff8-47bb-9d9a-de51654a1157`,
08:06:42–08:07:34 UTC, HEAD `583af8dfab6170d6b1eaae3bce9be6ae93d8d0ed` with a dirty
tree. Receipt: `%LOCALAPPDATA%/Epigraph/verification/cf95729f-eff8-47bb-9d9a-de51654a1157/receipt.json`.
Its state/outcome are **FINALIZED/PASS** and initial/final verification-tree digest
is `33ff963905d996b20f80f7926d35d3fd540b4041ce75be06dab8d005f84147f6`.
This documentation/backlog closure note was added afterward; the receipt describes
that exact tested snapshot, not a floating assertion about every later tree edit.

Executed commands:

- `node --test scripts/verification-evidence.test.mjs scripts/epigraph-build-receipt.test.mjs scripts/certify-suwayomi-release.test.mjs scripts/certify-local-data.test.mjs`: **25 PASS**.
- `powershell -NoProfile -File scripts/test-verification-evidence.ps1`: **19 PASS**;
  detailed fixtures at `%TEMP%/epigraph-b6-powershell-41a999b3-f3aa-4066-b9e2-5bbac2a13851`.
- PowerShell AST, JavaScript syntax, both workflow YAML parses and `git diff --check`: PASS.

| Required deliberate case | Executed evidence | Result |
| --- | --- | --- |
| Successful verification | RUNNING-before-gates test; actual release supervisor/runner with harmless gate substitutions | PASS |
| Intentional gate failure | Failing substituted gate; later gates NOT_RUN; finalized failure survives cleanup | PASS |
| Dirty tree | Staged, unstaged and untracked digest changes distinguished; unchanged dirty snapshot can pass | PASS |
| Stale executable | B1 validator rejects modified executable bytes | PASS |
| Mismatched build receipt | B1 validator rejects foreign profile; native wrappers reject missing receipt before launch | PASS |
| Cleanup failure | Injected failure and actual Windows locked-file removal failure; gates preserved, overall FAIL | PASS |
| Skipped/conditional stage | Explicit SKIPPED/NOT_APPLICABLE reasons; preparation alone NOT_TESTED | PASS |
| Secrets/redaction | Bearer, quoted JSON/assignments, API keys, cookie/auth/private-key fields, key blocks and URL credentials/query/fragment | PASS |
| Interrupted runner | Deliberately killed Node worker; unfinalized PowerShell worker becomes INTERRUPTED with final tree; nonfinal PASS reader rejection | PASS |
| Rerun after failure | Fresh UUID/path; original failure unchanged | PASS |

Additional tests prove assertion failure persistence **before cleanup**, no secret
file contents/path inventory in tree fingerprints, ignored secret exclusion,
changed-tree failure despite a passing gate, bounded diagnostics and protection
of active receipts during local pruning.

The reviewer found quoted-JSON redaction and pre-cleanup persistence gaps; both
received failing regressions and fixes. Review stopped at the reviewer's usage
limit, so this is not represented as a completed independent full review. The
final focused suites and static checks above were executed after those fixes.

No live application acceptance matrix, installer, Java-health investigation,
FlareSolverr lifecycle or remote GitHub Actions run was performed for B6. The CI
retention configuration was checked locally; effective remote artifact expiration
will be determined by GitHub when those workflows execute.

### Exact B6 file scope

New files:

- `scripts/verification-evidence.mjs`
- `scripts/verification-evidence.test.mjs`
- `scripts/VerificationEvidence.ps1`
- `scripts/test-verification-evidence.ps1`
- `.github/workflows/verify-evidence.yml`
- `docs/verification-evidence.md`

Modified files:

- `scripts/verify-release.ps1`
- `scripts/run-native-viewport-smoke.ps1`
- `scripts/run-local-data-release-certification.ps1`
- `scripts/smoke-native-viewports.mjs`
- `scripts/check-navigation-performance.mjs`
- `scripts/certify-local-data.mjs`
- `scripts/certify-integration-contracts.mjs`
- `scripts/certify-suwayomi-release.mjs`
- `.github/workflows/certify-suwayomi.yml`
- `docs/roadmap.md`
- `docs/bug-report.md`
- `docs/project-audit-backlog.md`

Existing dirty added/replaced hunks in the three staged native JS files, the B1
local-data PowerShell cleanup and the first-run bug-report block remain verbatim.
HEAD/index are unchanged. All other baseline files retain their hashes. B1 build
receipt/session identity modules, application Rust/Svelte, OAuth work, and the
dirty Windows bundle workflow were not edited. Git commits used by the tests are
confined to new disposable fixture repositories; the project was never staged,
committed, reset, restored or stashed.
