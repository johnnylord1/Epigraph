# Epigraph Mobile baseline audit

Audit date: 2026-07-22

## Candidates

| Candidate | Result | Evidence |
|---|---|---|
| Hayai `v1.13.0`, `fb47f4c47088042e0b9d5beacbccd2d63a12541b` | No-go | `devDebug` cannot link because `ic_hayai_splash.xml` references missing `drawable/splash_icon`; novels/LNReader are absent; EPUB is image extraction only; PDF is absent. |
| Hayai `master`, `7637a259e185a0abb649bd102b891f7b030cee40` | No-go | `devDebug` fails on unresolved `locales_config`; upstream CI is red. |
| Last green upstream commit, `248146acfb87e97540d719f4a34bf1f362754882` | Conditional go | `assembleDevDebug`, `assembleStandardRelease`, and upstream unit-test gates passed locally; real onboarding and repository screens opened in an API 36.1 emulator. |

The selected baseline is `248146acfb87e97540d719f4a34bf1f362754882`. The checkout remains detached by user request. No branch or push is permitted.

## Toolchain observed

- Gradle 9.5.1
- Android Gradle Plugin and Kotlin versions pinned by the selected upstream commit
- Java target 17; local audit used Android Studio JBR 21
- compile SDK 37, target SDK 36, Epigraph min SDK 24 (upstream was 23)
- Android SDK platforms 31, 33, 34, 35, 36, and 37.0 were present/installed during the audit
- Only an API 36.1 emulator image was locally available

## Commands and results

| Command | Result |
|---|---|
| `gradlew tasks --all` on v1.13.0 | Passed |
| `gradlew assembleDevDebug` on v1.13.0 | Failed: missing splash resource |
| `gradlew assembleDevDebug` on current master | Failed: unresolved `locales_config` |
| `gradlew assembleDevDebug` on selected baseline | Passed in 3m36s after cache warm-up |
| `gradlew assembleStandardRelease testReleaseUnitTest testStandardReleaseUnitTest` | Passed in 7m01s; all reported tests passed |
| `gradlew verifySqlDelightMigration` on upstream baseline | Failed in migration 1; see `DATABASE.md` |
| `gradlew :data:verifySqlDelightMigration --rerun-tasks` after schema 38 | Passed in 43s against schema snapshots 36/37/38 |
| P0 unit tests + `assembleDevDebug` | Passed; 7/7 focused tests |
| `testStandardReleaseUnitTest assembleStandardRelease` after Epigraph identity/privacy changes | Passed in 4m19s |
| API 36.1 emulator install and launch | Passed using x86_64 `devDebug` |
| `testStandardReleaseUnitTest` after SAF/PDF/sync-routing foundation | Passed: 158/158 |
| `domain:testAndroidHostTest` | Passed: 49/49 |
| `data:testAndroidHostTest` | Passed: 12/12 |
| `lintDevDebug` | Passed in 5m55s with 0 errors, 583 warnings and 2 hints |
| Current `assembleDevDebug` | Passed; 98,093,878 bytes; SHA-256 `472B65BD89D5AF0F9FA9FA278348587681416CD76DF16DCBE25EFB53F46C2039` |
| Fresh install/current APK on API 36 emulator | Passed; explicit launcher alias opened onboarding, process remained alive, no fatal exception |
| Syncd v1 Android foundation focused tests | Passed: 47/47 app tests plus 13/13 data tests |
| Full regression after Syncd foundation | Passed: app 205/205, domain 49/49, data 13/13; migrations passed |
| Current `lintDevDebug` after Syncd foundation | Passed in 8m37s with 0 errors, 583 warnings and 2 hints |
| Current `assembleDevDebug assembleStandardRelease` | Passed in 3m42s; release artifacts are unsigned as expected without a repository keystore |
| Current universal debug APK | 98,093,879 bytes; SHA-256 `CEA02119D3F6D3FB059750A3E2CE77BB71340D6D4BC482AD2CE322FAC481F35D` |
| Current universal release APK | 63,810,191 bytes; unsigned; SHA-256 `406C2E1D6B5C8F1616E0DEA101DEC7A662249FADE7DC650EFDB08D66CD4D208F` |
| API 36 Syncd-foundation smoke | Fresh APK installed; cold launch reached Epigraph onboarding in 8.154s; PID remained alive; no fatal exception |
| Full regression after pinned pairing/replay/credentials | Passed: app 234/234, domain 49/49, data 13/13; migrations passed |
| `lintDevDebug` after pinned pairing/replay/credentials | Passed in 6m28s with 0 errors, 584 warnings and 2 hints |
| Rebuilt universal debug APK | 98,107,984 bytes; SHA-256 `1FF60410B0E04F341A74ECE155E18EE8A3C043387F89E7D74FD5806676384E52` |
| Rebuilt universal release APK | 63,810,191 bytes; unsigned; SHA-256 `EE00DD8FE170564252CB43699232C0F878F853450B23A075454B1107E36DDECB` |
| API 36 rebuilt-APK smoke | Fresh install; cold launch reached Epigraph onboarding in 10.205s; app PID remained alive; no fatal exception |

## Current Epigraph Core integration wave

The following results supersede the older rows above for the current detached checkout:

| Gate | Result |
|---|---|
| Full app regression (`testStandardReleaseUnitTest`) | Passed: 283/283 tests |
| Domain host tests | Passed: 49/49 tests |
| Data host tests | Passed: 17/17 tests |
| SQLDelight migration verification | Passed through schema 39 (`36.sqm`, `37.sqm`, `38.sqm`) |
| `lintDevDebug` | Passed: 0 errors, 585 warnings, 2 hints |
| Current universal debug APK | 97,481,313 bytes; SHA-256 `A295EC27558A747463A7B64F96B2AC363B33284BB266A2B5AD3DD4BEDBBD49EB` |
| Current universal release APK | 64,134,926 bytes; unsigned; SHA-256 `80EC50E394E46E46032CB90716B4FA33B4B8CA343A7D9A941666B1D7D0970A79` |
| API 36.1 user-flow smoke | Latest APK installed after DI/replay changes; launcher resumed, PID stayed alive, and logcat showed no fatal exception. Earlier flow also covered onboarding, SAF, Library/Recents/Browse, Core settings, invalid bundle rejection and QR scanner launch |

The mobile side now has the Core-v1 outbox adapter and drainer, WorkManager scheduling, encrypted credentials, pinned HTTP/WebSocket transport, SQLDelight schema 39 confirmed-replica tables, Lamport clock, idempotent inbox/checkpoint handling, and cursor-aware replica synchronization. A scope uses `/v1/changes` from its durable cursor and falls back to `/v1/snapshot` only for first bootstrap or replay-window expiry. The worker reports `outbox_drained`; it never labels a replica as fully synchronized while pending work or a replica error remains.

The live emulator profile is not a clean two-device certification, so QR approval and symmetric-difference acceptance are not claimed here. The current Core bridge is nevertheless covered by deterministic runtime gates: capabilities, pairing/replay, catalog pagination, typed Suwayomi mutations, server projection readiness, reconnect and fingerprint stability all pass. The mobile worker stages extension inventory as review-only, materializes the complete Suwayomi catalog before applying the Core replica, and refuses to report a drained state while the desktop projection queue is pending or blocked. A physical two-device run with a real profile remains the release gate for end-to-end proof; category creation/rename/delete and tracker binding are not advertised as complete capabilities.

## Emulator smoke

Validated through user-visible interactions:

1. Fresh install and explicit launcher activity.
2. Theme selection with the Epigraph-branded package.
3. Library layout selection.
4. Storage Access Framework approval of the `EpigraphMobile` folder.
5. Android "install unknown apps", notification, and background execution permission screens.
6. Completion of onboarding.
7. Library, Recents, and Browse navigation.
8. Manga and Novel source tabs.
9. Manga and Novel repository surfaces.
10. Package identity `app.epigraph.mobile.debug`, label `Epigraph Debug`, and version `0.1.0-alpha.1` verified from the built APK/device.
11. Process remained alive and no fatal exception was found in the inspected logcat window.

The generic `monkey` launcher selected LeakCanary rather than the application alias, so smoke automation must launch `MainActivityDefaultDummy` explicitly until the debug manifest is hardened.

API 24 and 29 emulator images were not installed because the machine currently has only the API 36.1 AVD. Those matrix rows remain open.

## Baseline decision

Epigraph Mobile remains a conditional foundation built on Hayai. The mobile Core client foundation is integrated and regression-tested, but the gate is not an end-to-end sync approval until a running Core/syncd instance is used to certify pairing, replay, bidirectional mutations, replica projection, assets, and two-device convergence. The checkout remains detached and the desktop worktree was not modified.

## Unpaired catalog retention gate (2026-08-10)

The real emulator profile contained 631 persisted Core comics, four user
categories, one extension inventory record and three local books. The catalog
was not empty after unpairing; it was unusable because all Core rows were still
marked uninitialized and no authenticated cover had been materialized into the
library cache.

The current correction treats complete catalog rows as last-known-good local
metadata, migrates existing Core rows through schema 45, skips automatic Core
hydration while unpaired and warms confirmed covers in bounded batches while
paired. Focused catalog, source, projection, pairing, cover-cache and book-asset
tests passed. SQLDelight migration verification and the schema 44 to 45 behavior
test also passed. The updated APK/profile smoke is recorded only after the new
build is installed; until then, live cover backfill remains an open runtime
evidence rather than a claimed result.

## Current validation rerun (2026-08-20)

The gates below were rerun after the Core sidecar shutdown hardening and the
phase-gate fail-fast changes:

| Gate | Result |
|---|---|
| `:app:testDevDebugUnitTest` | Passed: 450 tests, 0 failures, 0 errors, 0 skipped |
| `:app:lintDevDebug` | Passed through Gradle; 0 errors |
| `:app:assembleDevDebug` | Passed; universal debug APK 175,587,294 bytes; SHA-256 `D258F5DA8332796A895D34567303DE0200059FFF462F9335FB3461149CA8F25B` |
| `:app:connectedDevDebugAndroidTest` | Passed against both API 36 AVDs (`Epigraph_Test_API36_Large`, `Epigraph_Test_API36_Large_B`) |
| API 36 large-device smoke | APK installed/launched on both AVDs; processes remained alive; no fatal exception, SIGSEGV or ANR; `/data` has 16 GB per device |

The desktop phase gate was rebuilt with an isolated Cargo target and passed
runtime, pairing, replay, bootstrap, mutation, discovery, reconnect and
fingerprint checks. The phase-gate app and ephemeral Core sidecar now shut down
together; the validation ended with no residual Epigraph, Syncd, Suwayomi or Java
process. This is still not a claim of two-device data convergence with a
populated Suwayomi profile: that final gate requires a real paired Core and
user-approved extension/source actions.

## Current validation rerun after official category projections (2026-08-20)

The bridge now maps existing Suwayomi categories to the official GraphQL
operations for rename, order and delete. Each operation is confirmed by a
read-back from the catalog; local-only categories are not assigned invented
Suwayomi IDs. Category order is validated as the official 1-based positive
position. Migration `0022_extend_suwayomi_category_projection_operations.sql`
expands the projection queue check without changing older rows.

| Gate | Result |
|---|---|
| Desktop Rust unit/integration suite | Passed: 437 tests, 0 failures |
| Targeted category projection integration test | Passed after migration 0022 |
| Mobile Suwayomi drainer tests | Passed: 5/5 |
| `:app:testDevDebugUnitTest` | Passed: 450 tests, 0 failures |
| `:data:verifyCommonMainDatabaseMigration` | Passed |
| `:app:lintDevDebug` | Passed through Gradle; 0 errors |
| `:app:assembleDevDebug` | Passed in 10m06s; universal debug APK 175,587,294 bytes; SHA-256 `D258F5DA8332796A895D34567303DE0200059FFF462F9335FB3461149CA8F25B` |
| `:app:connectedDevDebugAndroidTest` | Passed on `emulator-5556` and `emulator-5558` (API 36) |
| Fresh install/launch of rebuilt APK | Passed on both AVDs; app PIDs remained alive and no fatal exception was observed |
| Real two-device Core pairing/bootstrap | Passed: both AVDs paired through the user-facing QR/code approval flow with TLS pinning |
| Core-originated convergence | Passed: both replicas contained the same 3 identities, 10 replica records, category, EPUB CFI progress `0.42` and bookmark |

The two-device run used an isolated Core and a temporary profile. It seeded
books, novels and comics through the Core API and verified the complete local
replica on both devices. The isolated profile did not contain a running
Suwayomi instance, so catalog/portable-manifest requests correctly returned
`503` and remained retryable; no false "ready" state was reported. The
remaining populated-profile gate was then executed separately below. The
isolated Core, temporary profile, pairing bundles and logs were removed after
the run; no Epigraph/Syncd process or listener remains.

The desktop web layer was also rechecked after the bridge change: `pnpm
test:unit` passed with 190 files, 1,138 tests passed and one explicitly skipped
live-contract test; `pnpm build` completed successfully. The only build warning
is the existing Rollup notice about chunks larger than 500 kB.

## Populated Suwayomi category bridge gate (2026-08-20)

The final authority-side gate was run with the bundled Suwayomi runtime and a
fresh disposable `rootDir`; the user's profile was never opened. A temporary
Core instance exposed the authenticated `/v1/suwayomi/commands` route and the
test first created two categories directly in the isolated Suwayomi database
to obtain real server IDs. The Core then executed `UpdateCategory`,
`UpdateCategoryOrder` (positive 1-based position), and `DeleteCategory`. Every
step was read back both from Suwayomi GraphQL and from the Core categories
catalog endpoint.

```text
Core: 47773 (TLS), Suwayomi: 4567 (loopback), scope: comics:profile:main
Initial categories: 1 (the default category)
Created server IDs: 1 and 2
Rename: ID 1 -> "Epigraph E2E Alpha Renamed"      PASS
Reorder: ID 1 -> position 2; ID 2 -> position 1  PASS
Delete: ID 2 absent from GraphQL and Core catalog PASS
Cleanup: disposable rootDir removed; no process or listener remained
```

This closes the populated-Suwayomi category mutation gate. Creation remains
server-authoritative: the bridge does not invent IDs for a new category; an
ID must be allocated by Suwayomi before rename/order/delete projection.

## Release artifact validation (2026-08-28)

The current source still passes the previously recorded migration, host-test,
unit-test and Gradle-integrated lint gates (0 fatal lint errors). A production
variant was packaged as an unsigned APK because this checkout intentionally
does not contain a release keystore. For device testing, the `standardLocal`
variant was rebuilt with the production package id and the Android debug key:

| Artifact | Result |
|---|---|
| `app-standard-universal-local.apk` | 172,322,997 bytes; SHA-256 `76ce6c051c9591e431dc67de969fa912ff66f039ba253e5a42ebb233654e79cc`; APK Signature Scheme v2 valid |
| package/minimum/target | `app.epigraph.mobile`, minSdk 24, targetSdk 36 |
| `app-standard-universal-release-unsigned.apk` | Release/minified artifact remains unsigned until the project keystore is supplied |

The first internal packaging attempt was deliberately capped at 2 GB and
failed with Kotlin `OutOfMemoryError`; it was retried at 4 GB with one worker
and completed successfully. All Gradle processes were stopped after the build.
API 24/29 emulator rows and a fresh physical two-device run remain open for
the release gate; the deterministic two-device Core run above is retained as
the current evidence.

## API matrix rerun (2026-08-28)

The API 29 row was rerun against the current checkout with a clean emulator:

| Gate | Result |
|---|---|
| `:app:connectedDevDebugAndroidTest` on `Epigraph_API29` (SDK 29) | Passed: 2/2 instrumented tests; Gradle build successful in 5m20s |
| API 24 x86_64 AVD boot | Blocked before `system_server`; emulator 36.1.9 reported missing OpenGL emulation symbols |
| API 24 x86 AVD boot | Blocked by the same pre-app system boot failure |

No Aethon process ran on API 24, so this is an emulator/image compatibility
limitation rather than an application failure. The API 24 gate remains open
and requires an older compatible emulator or a physical API 24 device. Both
temporary AVDs were stopped after the run; no emulator, Gradle or QEMU process
remains active.
