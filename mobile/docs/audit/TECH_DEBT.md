# Prioritized technical debt

## P0 before Epigraph feature work

1. **Complete:** upstream Firebase/Analytics/Crashlytics configuration and mapping upload removed; a pre-build regression gate rejects reintroduction.
2. **Complete:** SQLDelight migration verification passes; `.github/workflows/android_ci.yml` runs it with the unit tests, lint and `assembleDevDebug` on Linux.
3. **Complete:** download finalization cannot report success after failed rename/validation, with rollback and focused tests.
4. **Partial:** history restore is idempotent and scoped by manga + chapter URL; whole-restore transaction/resume remains P1.
5. **Complete foundation:** `ContentType`, Epigraph identity/source bindings, `ReaderLocator`, and 18-command protocol v2 are implemented; later protocol changes must be additive.
6. **Complete:** min SDK is 24; API 24 install, onboarding, library and CBZ/EPUB/PDF reader smoke passed on an emulator.

## P1 before four-reader milestone

1. Add uniqueness/preflight rules without losing legacy duplicates.
2. **Complete:** allowlist sanitization, WebView network/file/navigation blocking and `NovelRemoteImageBroker` (HTTPS only, public-only DNS, no cookies/cache, raster types, 8 MiB limit, deadlines, cancellation) for novel images. EPUB keeps remote images off.
3. **Complete:** QuickJS initialization/operation/chapter deadlines, plugin-code/result budgets, a 128 MiB heap limit, cancellation, and `NovelNetworkPolicy` host checks with private-address and DNS-rebinding blocking on every redirect hop.
4. **Partial:** SAF private copy, adapter/import contracts, EPUB structural validation and PDF controller exist; import UI and real EPUB/PDF engines remain.
5. **Partial:** restore bounds the file and decompression to 256 MiB; automatic backups are written as `.part`, validated, renamed, then rotated; credentials never enter or leave a backup (`BackupSecretPolicy`). Pre-analysis, dependency reports, a transactional/resumable restore and EPUB/PDF bytes in backups remain (the restore writes through many repositories, so a single transaction needs a staged-import design rather than a wrapper).
6. Move large-library filtering/search/ordering into indexed SQL.

## P2 before sync release

1. **Partial:** schema 39, transaction-coupled ordered outbox, Core-v1 adapter/drainer and confirmed replica exist; legacy table projection and remaining mutation families remain.
2. **Partial:** secure pairing/token storage, TLS fingerprint pinning, WorkManager, replay policy, snapshots, receipts, tombstones and resumable downloads are implemented; a long-lived SSE service remains.
3. Add real LAN pairing, two-device convergence and offline tests against a running Core.
4. Add category scopes and explicit content types to Epigraph backup.

## Known integration hazards

- Existing Epigraph repositories often catch exceptions and return `false`; sync must use throwing SQL writers inside `EpigraphMutationCoordinator` or atomicity is illusory.
- EPUB textual reading still needs import UI, publication projection, engine, CFI, TOC, search, highlights and TTS.
- PDF still needs the licensed engine integration, password handling, outline/search/selection overlays (text selection/OCR) and progress UI.
- Manga download process-death tests are still missing; today the atomic finalizer tests and the `_tmp` exclusion on read cover it indirectly.
- Library search stays fuzzy (upstream `FuzzyMatcher`, 70% threshold); an exact-match mode would need a preference.

## P3 cleanup

- Replace mutable CI action tags with SHAs.
- Add dependency verification/locking and repository content filters.
- Remove debug launcher ambiguity caused by LeakCanary.
- Make builds reproducible by replacing wall-clock `BUILD_TIME`.
- **Done:** permissions audited; `UPDATE_PACKAGES_WITHOUT_USER_ACTION` removed and extension updates always use the visible Package Installer; Android auto backup disabled (`allowBackup=false` plus extraction rules).
