# Suwayomi Updater

## Scope

Aethon updates only the Suwayomi runtime it can prove it owns. The updater never updates external servers, attach-only sessions, or a user-provided `serverBinary`.

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
- The local profile/root can be resolved by Aethon.
- The session is not attach-only.
- `serverBinary` is empty.
- The owner file and spawn lock state prove Aethon owns the Java process.
- The running Java process uses the bundled JAR or Aethon-managed runtime JAR.

If ownership is not proven, status is `external`, `managed-user-binary`, or `unknown`, and update is blocked.

## Compatibility Manifest

The compatibility manifest is the only source of truth for installable versions. A release must be:

- in `allowedVersions`;
- not in `blockedVersions`;
- within `minSupportedVersion` and `maxTestedVersion`;
- a stable GitHub release, not draft or prerelease;
- published in `Suwayomi/Suwayomi-Server`;
- carrying the expected JAR asset and `Checksums.sha256`.

Schema 2 pins the exact SHA-256 of every allowed JAR. During staging, Aethon requires the checksum published by Suwayomi to match this certified hash before it downloads or promotes the runtime. A replaced release asset or checksum therefore fails closed even when the version and asset name remain unchanged.

Checksum validation is integrity only. If Suwayomi publishes a verifiable signature later, the updater should add signature verification before relaxing any rule.

Current compatibility decision:

- `v2.1.1867` remains the supported and tested baseline.
- `v2.2.2100` is explicitly blocked after a managed-runtime smoke run failed to become GraphQL-healthy. Tests may use an isolated allowlist fixture for update-flow coverage, but production must continue to follow the bundled manifest.

## Release Certification

New Suwayomi releases are evaluated through the manual `Certify Suwayomi Runtime` GitHub Actions workflow. The workflow runs independently on Windows and macOS and never changes the allowlist automatically.

Each runner:

1. resolves the exact stable release from `Suwayomi/Suwayomi-Server`;
2. downloads the expected JAR and `Checksums.sha256` from official HTTPS release URLs;
3. verifies the JAR checksum and its internal `Specification-Version`;
4. starts the JAR with Aethon's headless memory/configuration profile in an isolated temporary root;
5. validates typename, Library, Sources, and Extensions GraphQL queries;
6. records a canonical, description-free schema hash and evaluates the required GraphQL fields as a semantic contract;
7. records observed capabilities and best-effort process memory, CPU, thread, and startup metrics;
8. stops and starts the same disposable root again, then requires the health contract and canonical schema to remain stable;
9. emits a redacted `certification-report.json` and a review-only `allowlist-candidate.json` as CI artifacts.

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

This baseline is process isolation by disposable profile only. AppContainer, ACL, Job Object, outbound-network enforcement, copied-profile migration, and transactional promotion remain later runtime-supervisor gates and must not be inferred from an SR1 pass.

The current fixed-target evidence is recorded in [`suwayomi-certification-baseline-v2.3.2243.md`](./suwayomi-certification-baseline-v2.3.2243.md).

## Directories

Managed runtime data lives under app data:

```text
suwayomi-runtime/
  current/
    Suwayomi-Server.jar
  previous/
    Suwayomi-Server.jar
  staging/
    <version>/
      Suwayomi-Server.jar
      staging-manifest.json
```

Snapshots live inside the Suwayomi profile root:

```text
aethon-update-snapshots/
  snapshot-<timestamp>-<uuid>/
    snapshot-manifest.json
    server.conf
    database.mv.db
    database.trace.db
    server.owner.json
```

## Snapshot

Snapshot uses an allowlist and records SHA-256 for every copied file. It excludes downloads, imports, cache, covers, thumbnails, books, and migration journals.

The updater checks disk space before stopping the runtime. Temporary snapshot directories are finalized by rename within the same parent. Partial snapshots are not considered valid.

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

Promotion validates staging, stops only the Aethon-managed runtime, moves `current` to `previous`, then moves staging to `current`. Existing `previous` is kept as a temporary backup until success.

Rollback runs if promotion, restart, process stability, or health check fails. Rollback is complete only after:

- failed `current` is removed;
- `previous` is restored to `current`;
- snapshot files are restored and rehashed;
- the previous runtime starts;
- the previous process remains alive through the stability window.

On the next managed startup, Aethon prefers `suwayomi-runtime/current/Suwayomi-Server.jar` when it exists and otherwise falls back to the bundled JAR. Windows uses the bundled `javaw.exe` when available so the managed server remains background-only.

The managed-current selection path was smoke-tested with a copied baseline JAR: the process command line selected `current/Suwayomi-Server.jar`, ownership was published, and the Library, Sources, and Extensions GraphQL health query completed without errors.

## Health Check

Startup alone is not success. After promotion the updater validates GraphQL:

- `__typename`;
- Library connection via `library: mangas(condition: { inLibrary: true }, first: 1)`;
- Sources connection;
- Extensions connection.

The check validates payload shape and absence of GraphQL errors. It does not require identical Library counts immediately after startup.

The readiness window is intentionally longer than a normal launch because a promoted server can run database or extension migrations before GraphQL becomes stable. If verification still fails, Aethon writes an internal diagnostic report under:

```text
suwayomi-runtime/
  diagnostics/
    health-<version>-<timestamp>.json
```

The report records each attempted GraphQL check, duration and sanitized error, but never stores authorization headers. This is for maintenance/debugging only; the user-facing flow remains simple.

## Logs And Errors

Native updater commands log start, success/failure, duration, and sanitized failure reason using the `aethon-suwayomi-update` prefix.

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

Promotion or health-check failures are normalized in the Settings UI to explain only the outcome: Aethon could not verify the downloaded update and kept the current runtime. If automatic rollback itself fails, the UI asks the user to restart Aethon before retrying. Query names, migration details and diagnostic paths remain in logs/diagnostic files so regular users do not need to understand the internal certification process.

## Limitations

- No automatic update scheduling.
- No background download.
- No signature verification yet.
- No deep data reconciliation after update; health checks validate availability and schema shape.
- The old snapshot and promotion commands remain available for diagnostics, but production UI uses the atomic install command.
