# Runtime Session Policy

This document defines the approved entry points for opening Epigraph during manual verification, UI audits, and Syncd protocol gates.

## B1 ownership reconciliation (2026-09-06)

ORIGINAL_B1 is CLOSED against the audit objective: make launcher and cleanup
ownership explicit. Extended lifecycle work is tracked separately in
[the audit backlog](project-audit-backlog.md). The restrictions below continue
to supersede older blanket cleanup instructions.

- The four managed launcher scripts use a canonical project path, profile scope,
  worktree/build fingerprint, fresh run UUID and a Windows job created atomically
  with the suspended launch process. Process creation identity is full FILETIME.
- Existing windows are eligible only when exactly one belongs to the requested
  scope. Missing, ambiguous or foreign evidence is preserved. Occupied development
  ports cause a bounded refusal, never listener termination.
- `stop-epigraph-orphans.ps1` inspects by default. Destruction requires
  `-RunId <exact-recorded-UUID> -Stop`. It does not sweep unrelated runs.
- Each destructive action validates job membership, executable path and creation
  identity, terminates, and waits on the same Windows process handle. Session
  evidence remains on disk after cleanup, including failures and timeouts.
- Desktop cleanup uses an exact-run application request and nonce acknowledgement,
  then waits on the same validated process object and observed owned descendants.
  Persistent Core, Java and descendants of excluded services are not force targets.
  Unknown membership or unconfirmed completion retains session evidence.
- The hidden run host and managed application retain the existing named job.
  Recovery requires reopening that job plus exact creation/executable/run agreement
  and membership checked through the retained process handle. A job name alone is
  insufficient; loss before the application's anchor is established may still refuse.
- Managed launch requires a receipt binding frozen source, canonical worktree,
  profile, HEAD, build UUID and desktop/Core SHA-256 hashes. A candidate target is
  written by one build at a time and receipts hash candidate-local copies (see
  Candidate builds). Focus uses native application control; CDP requires a one-use native
  document challenge after connecting, not merely listener ownership.
- Runtime `ServerOwner` records reuse `runId` and `processIdentity`, adding a full
  Windows creation timestamp and explicit spawn provenance. Disk metadata alone
  grants no termination rights. Desktop requires its retained child/run; Core
  requires its retained run/process lease. Owner JSON is retained; a byte-bound
  confirmation receipt is written only after confirmed exit. Partial/stale owner
  records and startup locks without a completion proof are preserved.
- Legacy gates that only saved PIDs or used port/path sweeps now refuse those
  operations. Gates holding their actual spawned `Process` object use that
  retained handle. These restrictions do not certify all legacy scenarios.

See [the B1 verification report](b1-ownership-verification.md) for exact changes,
original acceptance evidence and separately classified follow-up work.

## Goals

- avoid orphaned `epigraph`, `node`, `cargo`, and sidecar processes
- avoid opening the wrong gate for the wrong purpose
- keep normal desktop launches silent
- keep Syncd test flows isolated from the normal desktop session

## Development and stable data

- Debug builds (`pnpm tauri:dev`, `tauri:dev:gate`, the `dev` desktop launcher) keep app data, the WebView profile and Suwayomi folders under `%LOCALAPPDATA%\Epigraph-dev` (override with `EPIGRAPH_DEV_DATA_DIR`) and run the sync Core on port 4787 instead of 4777 and Suwayomi MAIN/TEST on 4577/4677 instead of 4567/4667.
- `--local-app-data-dir`, `EPIGRAPH_SYNCD_PORT`, `EPIGRAPH_LOCAL_SERVER_*_PORT`, `WEBVIEW2_USER_DATA_FOLDER` and explicit `EPIGRAPH_LOCAL_SERVER_*_ROOT` values still win, so gates and disposable profiles keep their own folders.
- Release builds are unchanged and use the normal application data folders.
- The Core only attaches to or proxies a Suwayomi server whose root is inside its own data folder, so a development Core never touches an installed release's server. The development window also uses its own Suwayomi ports, so it can run beside the installed app without attaching to its server.

## Approved Entry Points

### Normal desktop UI verification

Use one of these only:

- Desktop shortcut: `C:\Users\jhow-\Desktop\Epigraph.lnk`
- Launcher script: `scripts/launch-desktop-epigraph.ps1`
- Managed theme audit: `pnpm theme:audit-runtime`

These are the only approved entry points for:

- checking current UI work
- visual audits
- interaction audits
- manual Settings / Home / Library / Search verification

They are designed to:

- focus an existing Epigraph window if one already exists
- preserve other runs and refuse ambiguous relaunches
- open silently without a visible console window in the normal desktop path

Do not open raw `tauri:dev:gate` for routine manual UI inspection.

### Managed cleanup

Use:

- `scripts/stop-epigraph-orphans.ps1`

This is the approved cleanup path when:

- a prior dev gate is stuck
- a Syncd gate left processes behind
- a release/build audit was interrupted
- the machine is lagging because old Epigraph sessions were not cleaned up

### Syncd phase gates

Use the `run-syncd-*.ps1` scripts only for the specific protocol/runtime contract they were created to verify.

They are not approved as the default way to open the app for manual UI work.

Examples:

- `run-syncd-bootstrap-phase-gate.ps1`: bootstrap payload / claim verification
- `run-syncd-phase-gate.ps1`: runtime/auth/replay contract verification
- `run-syncd-desktop-two-instance-harness.ps1`: explicit two-instance desktop pairing flows
- `run-syncd-native-two-instance-automation.ps1`: automated native two-instance runs

### Browser and component tests

These are not desktop app launchers:

- `npm test -- --project shell-jsdom ...`
- `npm test -- --project browser-components ...`

They are test runners only.

Do not use them as substitutes for the normal desktop launcher.

## Candidate builds

Managed launches build an attested candidate with `scripts/build-epigraph-candidate.ps1`
under `%LOCALAPPDATA%\Epigraph\candidates\<build UUID>`.

- Compiled dependencies are reused through one cargo target per worktree
  (`%LOCALAPPDATA%\Epigraph\build-cache\<worktree hash>\target`). A build writes to it
  only while holding its exclusive OS-held lease, from the first cargo call until the
  desktop and Core binaries are copied and hashed into the candidate folder. Another
  build of the same worktree waits (bounded; after 90 minutes it compiles in the
  candidate's private `target`). The cache is never moved or copied: Tauri build
  outputs embed absolute target paths. For the same reason `-SeedTargetDirectory` is
  obsolete and ignored: a copied target would read, and depend on, its source target.
- The receipt hashes the desktop and Core copies inside the candidate folder, and the
  desktop copy must embed the build UUID and source fingerprint of this snapshot.
- `cargo --jobs` defaults to the logical CPU count, capped at one job per 2 GiB of RAM.
  Set `EPIGRAPH_BUILD_JOBS=1` (or pass `-Jobs 1`) on low-memory machines.
- Native build output is kept in the candidate's `build.log`.
- Retention runs after every build and keeps the three newest receipted candidates.
  It removes older candidates, failed builds older than 24 hours and interrupted
  removals only when no process image runs from them, their build lock is free, and
  they are not the `EPIGRAPH_CANDIDATE_RECEIPT` candidate. It removes build caches whose worktree no
  longer exists or that went unused for 30 days, but never a leased cache.

## Hard Rules

- Do not use a Syncd gate to inspect ordinary UI work.
- Do not use the two-instance harness unless the test really requires two desktop instances.
- Do not open raw `tauri:dev` or raw `tauri:dev:gate` for ordinary manual UI checks when the managed launcher exists.
- Do not keep multiple gate families alive at the same time unless the test explicitly requires it.
- Before switching gate families, inspect recorded runs and stop only the explicitly selected owned run when its lifecycle supports safe cleanup.

## Session Model

There are three supported session categories:

1. normal desktop UI session
2. Syncd phase-gate session
3. Syncd multi-instance harness session

Each category must be treated as separate.

The normal desktop launcher does not acquire termination authority over test sessions merely by discovering them.

## Agent Guidance

When an agent needs to open the app:

- use the normal launcher for manual UI inspection
- use a Syncd gate only when the task is explicitly about Syncd protocol/runtime verification
- reconcile and clean only the specific owned run before starting another gate family
- do not leave build/test sessions running after the task no longer needs them

## Conservative reconciliation

Missing, malformed, legacy or incomplete run/owner records are diagnostic evidence,
not permission to terminate or overwrite a running process. Preserve the records
and processes, close the identified application through its own normal controls,
and retain OS completion evidence if available. If completion cannot be proved,
leave that ownership state untouched and use a fresh isolated profile/session for
new verification. Never remove metadata to make a launcher accept an unknown run.

Managed application restart currently requires acknowledged graceful close followed
by a fresh attested launch. Persistent Core update/reset automation refuses until
an owner-scoped maintenance lease handoff is implemented: releasing the exclusive
lease to allow a restart would reopen a startup race. This refusal is a documented
incomplete persistent-maintenance lifecycle, outside original B1 closure. The original profile and metadata remain.

Native installer requests currently fail before invoking the updater plugin. Its implicit process exit would bypass the owned shutdown gate; installation requires a future graceful, attested handoff. This conservative refusal is an incomplete updater handoff, not a verified installation path.
