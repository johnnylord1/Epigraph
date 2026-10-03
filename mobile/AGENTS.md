# Epigraph Mobile contributor rules

## Scope

- This repository contains the Android application only.
- Do not modify the separate desktop workspace from this Android workspace.
- Do not reintroduce Sorayomi code or artifacts.
- Preserve the J2K-lineage interaction model. The product identity is Epigraph Mobile: first-party Kotlin code lives under `epigraph.*` (including `epigraph.novel.*`, formerly `hayai.novel.*`). Upstream packages (`eu.kanade.tachiyomi`, `yokai`, `exh`) stay because extensions and upstream merges depend on them. Legacy `hayai`/`aethon` names remain only where they are compatibility contracts (tables, keys, wire identifiers, URL schemes, OAuth client IDs) or lineage/licensing attribution.
- The Android product is installed as `app.epigraph.mobile`, alongside (not over) the previous package. Android private app sandboxes are isolated: users must export a backup from the previous installation and import it in Epigraph, or explicitly select a shared storage directory. Do not claim that an APK update can read the previous private sandbox automatically.
- New backups use `.epigraphbk`; restore/import must continue accepting supported legacy containers, `.tachibk`, `.proto.gz`, and the existing JSON formats. Persisted SQLDelight table names, migration filenames, preference keys, and wire identifiers are compatibility contracts.

## Git safety

- Work in detached HEAD unless the user explicitly changes this rule.
- Do not create branches and do not push to `upstream`.
- Never commit keystores, tokens, cookies, Firebase credentials, local SDK paths, generated APKs, or emulator data.
- Keep upstream provenance in `docs/audit/BASELINE.md` current when changing the pinned commit.

## Build gates

- Supported minimum is Android API 24 for Epigraph, even if upstream currently declares API 23.
- Use Java 17 in CI. JBR 21 is accepted only as a documented local fallback.
- Every database change needs a numbered SQLDelight migration, an upgrade fixture, schema verification, and a rollback note.
- Every domain mutation that syncs must write its outbox command in the same database transaction.
- `assembleDevDebug`, `assembleStandardRelease`, unit tests, lint, migration verification, and emulator smoke are release gates.

## Product invariants

- Public Android application ID: `app.epigraph.mobile`.
- Content types: manga, novel, EPUB, and PDF.
- Local IDs are preserved; Epigraph identity is added through side tables.
- Manga and novel chapters are not copied between devices by default. EPUB/PDF assets use immutable SHA-256 identities and download on demand.
- Android APK extensions always require the visible Package Installer flow.
- Cookies, sessions, passwords, and other secrets never enter backup or sync.
- Exception (tracker sync v1, user-approved): tracker logins/tokens may travel only as `tracker.credential` over the paired, certificate-pinned Core session, and only when the Core advertises `supportsTrackerCredentialsV1`. They are sealed with the Android Keystore in `noBackupFilesDir`, never enter backup, snapshots, change feeds, or logs, and are wiped on unpair. See `docs/audit/TRACKER_SYNC_CONTRACT.md`.
- The UI must never report `synced` while the outbox has pending commands.

## Security

- Do not ship upstream Firebase/Crashlytics configuration.
- Remote novel HTML must be sanitized with an allowlist and rendered without a privileged JavaScript bridge.
- Network access for novel plugins must go through an audited broker with host permissions, private-address blocking, deadlines, response limits, and cancellation.
- Downloads and backups publish only after verified atomic finalization.
