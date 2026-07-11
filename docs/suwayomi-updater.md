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

Checksum validation is integrity only. If Suwayomi publishes a verifiable signature later, the updater should add signature verification before relaxing any rule.

Current compatibility decision:

- `v2.1.1867` remains the supported and tested baseline.
- `v2.2.2100` is explicitly blocked after a managed-runtime smoke run failed to become GraphQL-healthy. Tests may use an isolated allowlist fixture for update-flow coverage, but production must continue to follow the bundled manifest.

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

## Limitations

- No automatic update scheduling.
- No background download.
- No signature verification yet.
- No deep data reconciliation after update; health checks validate availability and schema shape.
- The old snapshot and promotion commands remain available for diagnostics, but production UI uses the atomic install command.
