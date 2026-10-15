# Suwayomi Updater

## Scope

Epigraph updates only the Suwayomi runtime it can prove it owns. The updater never updates external servers, attach-only sessions, or a user-provided `serverBinary`.

The current flow is manual from Settings. There is no silent update, scheduler, background update, telemetry, or analytics.

## Architecture

- Rust command surface: `src-tauri/src/suwayomi_update.rs`.
- Frontend wrapper: `src/lib/suwayomiRuntimeUpdate.ts`.
- Settings UI: `src/components/settings/SuwayomiUpdatePanel.svelte`.
- Compatibility source: `src-tauri/resources/suwayomi-compatibility.json`.

The UI performs:

1. Runtime status.
2. Compatibility check.
3. Staging download.
4. Atomic install command.

The install command holds the native updater lock for snapshot, promotion, health check, and rollback.

## Ownership

Update is allowed only when all of these are true:

- The server URL is loopback.
- The local profile/root can be resolved by Epigraph.
- The session is not attach-only.
- `serverBinary` is empty.
- The owner file and spawn lock state prove Epigraph owns the Java process.
- The running Java process uses the bundled JAR or Epigraph-managed runtime JAR.

If ownership is not proven, status is `external`, `managed-user-binary`, or `unknown`, and update is blocked.

## Compatibility Manifest

The compatibility manifest is the only source of truth for installable versions. A release must be:

- in `allowedVersions`;
- not in `blockedVersions`;
- within `minSupportedVersion` and `maxTestedVersion`;
- a stable GitHub release, not draft or prerelease;
- published in `Suwayomi/Suwayomi-Server`;
- carrying the expected JAR asset and `Checksums.sha256`.

Schema 3 pins the exact SHA-256, compatibility profile, and certified runtime capabilities of every allowed JAR. During staging, Epigraph requires the checksum published by Suwayomi to match this certified hash before it downloads or promotes the runtime. Transactional extension updates additionally require the active JAR to match the allowlisted SHA and explicitly opt into that capability. A replaced release asset, checksum, or unknown future version therefore fails closed even when the version and asset name appear compatible.

Checksum validation is integrity only. If Suwayomi publishes a verifiable signature later, the updater should add signature verification before relaxing any rule.

Current compatibility decision:

- `v2.1.1867` remains the supported baseline.
- Fresh Windows release builds bundle the allowlisted `v2.3.2243` JAR with
  the previously certified Java 21 distribution. The local `tauri:build`
  command and Windows CI use `scripts/prepare-suwayomi-bundle.mjs`; the JAR
  and required Java files are SHA-256 pinned. Preparation is idempotent and
  repairs missing required Java files. It skips on non-Windows platforms,
  whose existing packaging flow remains separate.
- `v2.3.2243` is the maximum tested version after Windows x64/Java 21
  certification of H2 migration, Extension Stores, installed extension
  registration, restart and rollback on a disposable profile copy.
- `v2.2.2100` is explicitly blocked after a managed-runtime smoke run failed to become GraphQL-healthy. Tests may use an isolated allowlist fixture for update-flow coverage, but production must continue to follow the bundled manifest.

This packaging choice does not relax updater ownership, attach-only,
blocked-version, or integrity checks. The current release candidate still
requires the complete first-run and upgrade regression gates before release;
a successful bundle preparation is not release certification.

## Release Certification

New Suwayomi releases are evaluated through the manual `Certify Suwayomi Runtime` GitHub Actions workflow. The workflow runs independently on Windows and macOS and never changes the allowlist automatically.

Each runner:

1. resolves the exact stable release from `Suwayomi/Suwayomi-Server`;
2. downloads the expected JAR and `Checksums.sha256` from official HTTPS release URLs;
3. verifies the JAR checksum and its internal `Specification-Version`;
4. starts the JAR with Epigraph's headless memory/configuration profile in an isolated temporary root;
5. validates typename, Library, Sources, and Extensions GraphQL queries;
6. records a canonical, description-free schema hash and evaluates the required GraphQL fields as a semantic contract;
7. records observed capabilities and best-effort process memory, CPU, thread, and startup metrics;
8. stops and starts the same disposable root again, then requires the health contract and canonical schema to remain stable;
9. allocates a loopback port dynamically, proves that its listener belongs to the launched PID, and emits a redacted `certification-report.json` plus a non-promotable `compatibility-review.json`.

An allowlist update requires successful evidence from both platforms and manual review of the generated candidate. Local maintainers can exercise the same gate with:

```text
pnpm certify:suwayomi
```

The default manual SR1 target is fixed to `v2.3.2243`. Historical or additional releases can still be inspected explicitly:

```text
pnpm certify:suwayomi -- --version v2.1.1867
```

Certification never edits `src-tauri/resources/suwayomi-compatibility.json`. Passing evidence is necessary but not sufficient to permit a production update.

The SR1 baseline uses a new empty profile under the operating system temporary directory. It does not inspect, copy, or modify the user's managed Suwayomi profile. The report stores only release metadata, payload shapes, canonical schema evidence, observed capability field paths, timing, and process counters. Runtime output is redacted for disposable roots, user-home paths, URL credentials, authorization values, cookies, passwords, secrets, and tokens before it is written.

This baseline is process isolation by disposable profile only. It verifies an official checksum, an empty generated profile, process/port ownership, restart stability, and the V23 semantic contract. It does not produce an allowlist entry and must not be treated as promotion evidence. The AppContainer experiment was retired because the official Suwayomi/JCEF runtime could not initialize reliably there; promotion remains blocked on the supervised SR7 data, extension, ownership, and rollback gates.

The current fixed-target and SR7 migration evidence is recorded in [`suwayomi-certification-baseline-v2.3.2243.md`](./suwayomi-certification-baseline-v2.3.2243.md).

The deterministic source-runtime release gate is available as:

```text
pnpm release:certify-source-runtime
```

It runs serially with one Vitest worker, one Cargo job and one Rust test thread.
It covers certification contracts, V21/V23 adapters, structural extension
health, the complete Rust suite, Svelte diagnostics, the frontend build,
whitespace, and residual candidate cleanup. `release:verify` reuses its
contract-only mode because the global gate already runs Cargo, Svelte and build.

## Directories

Managed runtime data lives under app data:

```text
suwayomi-runtime/
  runtime-state.json          confirmed, previousConfirmed, pending
  extension-update-journal.json  only while an extension batch is unsettled
  update.lock                 cross-process maintenance lease
  versions/
    <version>/
      Suwayomi-Server.jar
  staging/
    <version>/
      Suwayomi-Server.jar
      staging-manifest.json
```

`runtime-state.json` is replaced atomically and is the only record of which
runtime runs: the desktop spawn, the Core supervisor and the runtime status all
resolve the JAR through it. A pending runtime starts only for its own profile
while that profile is under maintenance; every other start uses the confirmed
runtime, or the bundled JAR when none is confirmed. The legacy `current/` and
`previous/` layout is migrated into `versions/` by the next update.

Snapshots live inside the Suwayomi profile root:

```text
epigraph-update-snapshots/
  snapshot-<timestamp>-<uuid>/
    snapshot-manifest.json
    server.conf
    database.mv.db
    database.trace.db
    server.owner.json
```

## Snapshot

Snapshot uses an allowlist and records SHA-256 for every copied file. It excludes downloads, imports, cache, covers, thumbnails, books, and migration journals.

The updater stops the owned runtime, proves that its loopback port is released
and opens the H2 files exclusively before planning or copying the snapshot. It
then checks disk space. Temporary snapshot directories are finalized by rename
within the same parent. Partial snapshots are not considered valid. Any failure
before publication restarts the previous runtime.

Before taking a snapshot, the updater prunes the profile's older ones: each is a
full copy of the database. It keeps the newest finished snapshot and any snapshot
a `pending` runtime attempt or an extension batch journal points at, removes
partial `.tmp-` copies, and leaves directories with other names alone.

## Staging

The updater downloads only the allowlisted JAR and `Checksums.sha256`. The JAR is streamed to `.part`, hashed while streaming, then renamed into the temporary staging directory only after the hash matches.

Staging validation checks:

- expected asset name;
- SHA-256;
- readable ZIP/JAR;
- manifest exists;
- detected JAR version matches the expected version;
- file size is plausible.

Invalid staging is removed and never promoted.

## Promotion And Rollback

Promotion validates staging, stops only the Epigraph-managed runtime, publishes
the staged JAR to `versions/<version>` and records it as `pending` in
`runtime-state.json`, the last step before the profile changes. It then restarts
the profile on the pending runtime, checks it, and commits with one atomic
replace of the state (`pending` becomes `confirmed`, the old one
`previousConfirmed`). Runtimes nothing points at are collected afterwards.

When promoting to V23 or newer, Epigraph migrates the allowlisted legacy
`server.extensionRepos` value into `server.extensionStores`, deduplicates the
URLs and publishes `server.conf` atomically. The pre-promotion snapshot includes
the original configuration, so any parse, write, startup or health failure
restores the previous runtime and configuration together.

Rollback runs if promotion, restart, process stability, or health check fails. Rollback is complete only after:

- the pending runtime is stopped;
- snapshot files are restored and rehashed;
- `pending` is cleared, so the confirmed runtime is selected again;
- the previous runtime starts;
- the previous process remains alive through the stability window.
- Library, Sources and Extensions GraphQL checks pass on the restored runtime.

Nothing is renamed in place, so an interrupted promotion leaves at most a
`pending` record and a changed profile; the confirmed runtime is still installed.

## Interrupted Updates

An update holds the exclusive runtime lease from the snapshot until it commits
or rolls back. Work it leaves behind once that lease is free was abandoned by a
dead process: a `pending` runtime attempt, or an extension batch journal in
`SNAPSHOT_CREATED`, `CERTIFYING`, `ACTIVATING` or `ROLLBACK_RUNNING`.

- **Main profile.** The persistent Core undoes it on its own, even if no app
  opens again. Each supervisor tick checks for abandoned work; when the lease is
  free it takes it for recovery, reads the state again, stops the main server
  (proving it is the one it started), restores the snapshot, clears `pending` or
  marks the batch `ROLLED_BACK`, and starts the confirmed runtime.
- **Other profiles.** Their servers end with the desktop, so the desktop undoes
  the work before it starts that profile again, or before the next update.
- **Writes in between.** While a profile has abandoned work, the desktop and the
  Core's Suwayomi proxy refuse mutations for it with a retryable maintenance
  error, since the restore would drop them. Reads stay available.
- **Settled batches.** A `COMMITTED` or `ROLLED_BACK` batch only leaves its
  staging profile behind; the next batch removes it and starts. A batch is never
  restored twice: recovery reads the journal again under the lease.
- **Unusable snapshots.** A snapshot that is missing, fails its hashes or
  belongs to another profile can never be restored. The attempt is cleared (and
  recorded under `diagnostics/`) or the batch marked rolled back anyway, so the
  profile is never kept offline for good; a copy that fails (a file in use) is
  retried instead.

## Maintenance Mutation Policy

Maintenance drains active Suwayomi operations before stopping the runtime and
holds an exclusive cross-process lease until promotion or rollback has been
revalidated. New UI mutations and remote Syncd Suwayomi-proxy mutations are
rejected with a retryable maintenance result before Epigraph accepts or forwards
them. Reads cached outside Suwayomi and Core/Syncd replication remain available.

Epigraph intentionally does not persist arbitrary GraphQL requests as an outbox:
many Suwayomi mutations do not expose an idempotency key, so replaying them
could duplicate downloads or destructive actions. Mutations already accepted
by Core remain in Core's durable state and are not interpreted as deletions
while Suwayomi is unavailable. Maintenance ends only after the selected runtime
has passed its final health check. Core projections that failed because the
runtime was down are due again as soon as the maintenance lease is released, so
progress written on another device during an update reaches Suwayomi right
after it instead of after a backoff that grew with the update.

On the next managed startup, Epigraph starts the runtime `runtime-state.json`
confirms and otherwise falls back to the bundled JAR. Windows uses the bundled
`javaw.exe` when available so the managed server remains background-only.

## Health Check

Startup alone is not success. After promotion the updater validates GraphQL:

- `__typename`;
- Library connection via `library: mangas(condition: { inLibrary: true }, first: 1)`;
- Sources connection;
- Extensions connection.

The check validates payload shape and absence of GraphQL errors. It does not require identical Library counts immediately after startup.

The readiness window is intentionally longer than a normal launch because a promoted server can run database or extension migrations before GraphQL becomes stable. If verification still fails, Epigraph writes an internal diagnostic report under:

```text
suwayomi-runtime/
  diagnostics/
    health-<version>-<timestamp>.json
```

The report records each attempted GraphQL check, duration and sanitized error, but never stores authorization headers. This is for maintenance/debugging only; the user-facing flow remains simple.

## Logs And Errors

Native updater commands log start, success/failure, duration, and sanitized failure reason using the `epigraph-suwayomi-update` prefix.

Command errors are categorized:

- `OwnershipError`
- `CompatibilityError`
- `DownloadError`
- `ChecksumError`
- `SnapshotError`
- `PromotionError`
- `RollbackError`
- `HealthCheckError`

The UI strips these prefixes for friendly user-facing messages.

Promotion or health-check failures are normalized in the Settings UI to explain only the outcome: Epigraph could not verify the downloaded update and kept the current runtime. If automatic rollback itself fails, the UI asks the user to restart Epigraph before retrying. Query names, migration details and diagnostic paths remain in logs/diagnostic files so regular users do not need to understand the internal certification process.

## Limitations

- No automatic update scheduling.
- No background download.
- No signature verification yet.
- The production post-update health check validates availability and schema
  shape. Deep H2/state reconciliation is performed by the release certification
  gate, not on every user update.
- Website reachability, anti-bot challenges, authentication and JCEF behavior
  remain source-specific diagnostics and are not implied by runtime allowlisting.
- The old snapshot and promotion commands remain available for diagnostics, but production UI uses the atomic install command.
