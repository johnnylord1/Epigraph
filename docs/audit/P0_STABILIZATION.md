# P0 stabilization record

Date: 2026-07-22

## Identity and privacy

- Public application ID: `app.epigraph.mobile` (`.debug` for the debug build).
- Product version reset to `0.1.0-alpha.1`, version code 1.
- Display labels changed to Epigraph for standard, debug, beta, and nightly variants.
- Epigraph desktop mark ported to Android vector/adaptive/monochrome resources.
- Minimum Android version raised to API 24.
- Upstream app updater disabled until Epigraph has its own signed update feed.
- Firebase Analytics, Crashlytics, Google Services, upstream `google-services.json`,
  mapping upload, remote log writer, setting, and ProGuard rules removed.
- `verifyNoUpstreamTelemetry` runs before every app build and is compatible with
  Gradle configuration cache.

## Data integrity

- Migration 1 uses the function spelling accepted by SQLDelight 2.3.2.
- Migration 9 creates non-null category ordering with an empty default.
- Migration 36 repairs legacy rows that already contain null category ordering.
- Schema snapshots 36/37/38/39 and migration verification pass.
- History restore is scoped to the current work, merges duplicate backup entries,
  and writes only the missing read-duration delta.

## Offline download integrity

- Directory, novel, and CBZ finalization checks rename results.
- Final destinations are resolved and validated before cache/status publication.
- Temporary data is preserved on failure and post-rename validation attempts rollback.
- CBZ page directories are deleted only after a non-empty archive is materialized.

## Contracts and reader security

- `ContentType`, stable Epigraph identities, source bindings and manga/novel/EPUB/PDF locators are implemented.
- Sync protocol v2 defines 18 explicitly named commands for library, categories, chapter state, history, tracking, dependency inventory, assets, aliases and deletes.
- Novel content is allowlist-sanitized before rendering; its WebView blocks remote network/file access, mixed content and navigation.
- EPUB import validation now verifies ZIP bounds, secure XML, container rootfile, EPUB 2/3 OPF, manifest and non-empty spine.
- SAF imports are copied to a bounded `.part`, fsynced, revalidated and atomically renamed into content-addressed private storage.
- PDF now has a dependency-neutral controller for lifecycle, progress, ephemeral passwords, outline, search, highlights and selection.
- The first library/favorite/category mutation path is atomic with its ordered outbox commands, though UI/DI wiring is still pending.
- Android now distinguishes the local domain protocol v2 from the existing legacy-compatible Syncd HTTP wire protocol v1.
- Syncd v1 capabilities, snapshots, changes, flat mutation requests/results and structured errors have exact serializable DTOs.
- Pairing validates the real desktop QR bundle, requires a LAN HTTPS origin and DER-certificate SHA-256, serializes rotating-token claims, and implements `claim -> desktop approval -> final claim` without fake success.
- The concrete pairing transport performs the real HTTP claim and secure WebSocket approval flow with an exact SHA-256 pin of the leaf certificate DER, normal hostname/validity checks, bounded responses and cancellation.
- Approved credentials are encrypted with Android Keystore AES-256/GCM, stored below `noBackupFilesDir`, and replaced through `.part`, `fsync` and an atomic rename; token rotations keep the same `tokenId` without exposing token values in logs.
- Core HTTP calls use exact version/auth headers, reject insecure origins and never retain the bearer token; redirects are disabled to prevent token forwarding.
- Incremental SSE replay handles fragmented/CRLF frames, validates event IDs, preserves filtered-scope gaps, converts replay expiry into a full snapshot and advances the durable cursor only after database acknowledgement.
- Asset downloads resume through a single `Range`, then verify size/SHA-256 and atomically publish. Uploads are deliberately whole-body because current Syncd does not support resumable PUT.
- Bootstrap work is dependency-ordered and entities absent from Core capabilities remain blocked in the outbox instead of being acknowledged.
- SQLDelight schema 39 adds the confirmed Core replica, tombstone, inbox, checkpoint and Lamport tables. Authoritative snapshots replace only the confirmed scope and preserve the local outbox.
- WorkManager now runs a network-constrained Core pass at startup, after pairing and periodically. It drains supported v1 mutations and applies a complete snapshot for every granted scope.
- After the first snapshot, each scope replays `/v1/changes` from its durable checkpoint and requests a new authoritative snapshot only when syncd reports `REPLAY_WINDOW_EXPIRED`.
- Pairing UI is wired to the encrypted credential vault and does not claim a saved credential is verified until a Core request succeeds in the current process.

## Evidence

- Standard release app unit suite: 283/283 passed across the current suites.
- Domain contract suite: 49/49 passed.
- Data/coordinator/replica suite: 17/17 passed.
- Debug APK assembled successfully; SHA-256 is recorded in `BASELINE.md`.
- Latest `lintDevDebug`: 0 errors (585 warnings and 2 hints remain).
- No Crashlytics or Google Services Gradle task exists.
- API 36.1 emulator onboarding completed through the same screens a user sees:
  theme, library layout, SAF, extension installation permission, notifications,
  background execution, Library, Manga/Novel Browse.
- Inspected logcat contained no fatal app exception.
- The current rebuilt APK was also fresh-installed after the foundation changes and opened the real onboarding screen with no fatal exception.
- The APK containing pinned pairing, encrypted credentials and replay foundations was fresh-installed on API 36; its 10.205s cold launch reached the real Epigraph onboarding, the process remained alive and logcat contained no fatal exception.
- The latest APK also opened Settings > Epigraph Core, rejected an invalid pasted bundle, requested camera permission for the QR scanner and launched the JourneyApps capture activity. No Core process was available for a real approval or sync exchange.

## Remaining Gate 0 work

- Install an API 24 emulator image and repeat install/onboarding/reader smoke.
- Add the same gates to a clean Linux CI environment.
- Implement actual EPUB/PDF readers and route every production mutation family through the sync coordinator.
- Add a long-lived/reconnectable SSE service or an equivalent foreground sync policy; the current worker is snapshot + outbox and is not a five-second live-sync guarantee.
- Project confirmed Core records into Epigraph's existing manga/novel/book tables without echoing remote writes into the outbox.
- Run real LAN pairing and two-device convergence against the Epigraph Core/syncd executable.
- Add/advertise the Core bridge entities for comic catalog, repositories, extensions, categories, chapter state and tracking; the current Core supports only comic history/page bookmarks.
