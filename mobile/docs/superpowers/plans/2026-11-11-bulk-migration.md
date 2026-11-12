# Bulk migration and library report implementation plan

> Execute inline, task by task, using failing regression tests before implementation.

**Goal:** Make automatic/manual migration searches consistent and allow migrating only titles in the current update-report tab.

**Architecture:** Share bounded, ranked catalogue search through SmartSearchEngine. Keep the existing Conductor/Voyager source-selection and migration flows. Derive migration IDs from the report and verify current library membership.

**Tech Stack:** Kotlin, coroutines, JUnit Jupiter, existing Material3 components.

**Spec:** User request of 2026-11-11: unreliable automatic/manual matching (including Bleach and Mangakakalot); migration entry point in update error/skipped report.

## Constraints

- Android only; detached HEAD; preserve pre-existing local changes.
- Existing Koin, Voyager and SQLDelight stack; no database changes.
- Module-scoped Gradle checks; JBR 21 local fallback; no release or push.

## Task 1: Catalogue search regression and fix

Files: `SmartSearchEngine.kt`, `TitleMatcher.kt`, their tests, migration controllers/presenter, global-search presenter hook.

- [x] Add fake-catalogue cases: strict keyword queries, exact match after page one, transient failure for Bleach, cancellation, unrelated results and ranking.
- [x] Run `:app:testDevDebugUnitTest --tests '*SmartSearchEngineTest' --tests '*TitleMatcherTest'`; confirm new regressions fail.
- [x] Extend query fallbacks, bounded pagination and transient-error retry. Reuse ranked candidates for manual migration; use original title for automatic migration. Keep unrelated titles below the automatic acceptance threshold.
- [x] Distinguish search failure from no alternatives in the migration row.
- [x] Repeat targeted tests and review cancellation, source exclusions and UI updates.

## Task 2: Migrate report entries

Files: report-target helper/test, `LibraryUpdateReportScreenModel.kt`, `LibraryUpdateReportScreen.kt`, base/pt-rBR resources.

- [x] Test unique positive report IDs, exclusion of removed library entries, and separation of errors/skipped tabs.
- [x] Run the new tests and confirm missing functionality fails.
- [x] Resolve targets using current library membership and expose a labeled button for the current tab. Open `PreMigrationController.create(ids)` to select destinations before any migration.
- [x] Repeat targeted tests; confirm empty/legacy reports cannot start an empty migration.

## Task 3: Verification

- [x] Run the relevant migration/report tests and module compilation/lint checks.
- [x] Validate report navigation, tab-specific IDs, empty state and migration search on an API 36 emulator using ADB, preserving existing device data.
- [x] Review the diff; report evidence and any checks blocked by environment or external catalogue availability.

## Verification record

- Initial search regression run: 18 tests, 5 failures reproducing the missing behaviors.
- Initial report-target run: 21 tests, 2 expected failures before implementing target selection.
- Review regressions: 3 failures reproduced (unsafe keyword match, discarded manual candidates after a later-page error or timeout); all corrected. Independent read-only review found no remaining concrete issues.
- Latest targeted unit-test results: 34 tests, zero failures or errors; covers search, matching, migration flags, source selection, migration adapter and report targets.
- `:app:lintDevDebug` passed with zero errors before the final catalogue-title persistence correction. The final correction passed the focused tests and `:app:assembleDevLocal`.
- API 36 emulator with an isolated `devLocal` install verified that the Errors tab started a single migration from three report entries, omitting a duplicate and a removed title. The Skipped tab started a migration only for Naruto. The report stayed open when no eligible works remained.
- Mangakakalot 1.6.24 found Bleach automatically from a work with a custom display title. Manual search ranked Bleach before Bleach (Colored). The initial search took longer while the source presented a Cloudflare challenge.
- Emulator migration exposed an existing overwrite of the destination catalogue title by the display title. A failing adapter test reproduced it. After the correction, an emulator database check confirmed that only Bleach migrated and that its catalogue title and custom display title stayed separate. The isolated test database and report were restored afterward.
