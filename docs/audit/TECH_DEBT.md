# Prioritized technical debt

## P0 before Epigraph feature work

1. **Complete:** upstream Firebase/Analytics/Crashlytics configuration and mapping upload removed; a pre-build regression gate rejects reintroduction.
2. **Complete on Windows:** SQLDelight migration verification passes with schema snapshots 36/37/38/39; Linux CI remains to be added.
3. **Complete:** download finalization cannot report success after failed rename/validation, with rollback and focused tests.
4. **Partial:** history restore is idempotent and scoped by manga + chapter URL; whole-restore transaction/resume remains P1.
5. **Complete foundation:** `ContentType`, Epigraph identity/source bindings, `ReaderLocator`, and 18-command protocol v2 are implemented; later protocol changes must be additive.
6. **Partial:** min SDK is 24; API 24 install/start remains open because that emulator image is not installed.

## P1 before four-reader milestone

1. Add uniqueness/preflight rules without losing legacy duplicates.
2. **Partial:** allowlist sanitization and WebView network/file/navigation blocking are implemented; a secure broker for remote images remains.
3. Add QuickJS operation deadlines, response/memory budgets, cancellation, host permissions, and SSRF protection.
4. **Partial:** SAF private copy, adapter/import contracts, EPUB structural validation and PDF controller exist; import UI and real EPUB/PDF engines remain.
5. Add backup size limits, atomic output, pre-analysis, and dependency reports.
6. Move large-library filtering/search/ordering into indexed SQL.

## P2 before sync release

1. **Partial:** schema 39, transaction-coupled ordered outbox, Core-v1 adapter/drainer and confirmed replica exist; legacy table projection and remaining mutation families remain.
2. **Partial:** secure pairing/token storage, TLS fingerprint pinning, WorkManager, replay policy, snapshots, receipts, tombstones and resumable downloads are implemented; a long-lived SSE service remains.
3. Add real LAN pairing, two-device convergence and offline tests against a running Core.
4. Add category scopes and explicit content types to Epigraph backup.

## Known integration hazards

- Existing Epigraph repositories often catch exceptions and return `false`; sync must use throwing SQL writers inside `EpigraphMutationCoordinator` or atomicity is illusory.
- EPUB textual reading still needs import UI, publication projection, engine, CFI, TOC, search, highlights and TTS.
- PDF still needs the licensed engine integration, password handling, outline/search/selection overlays and progress UI.

## P3 cleanup

- Replace mutable CI action tags with SHAs.
- Add dependency verification/locking and repository content filters.
- Remove debug launcher ambiguity caused by LeakCanary.
- Make builds reproducible by replacing wall-clock `BUILD_TIME`.
- Audit broad package/install/cleartext permissions before public distribution.
