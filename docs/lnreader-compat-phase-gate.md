# LNReader Compatibility Phase Gate

Status: `provisional pass`

Audit date: `2026-04-12`

Evidence note: the latest update is now a first bounded product slice, not just a runtime micro-slice. It proves one real end-to-end novels flow in the desktop app for one official LNReader source, but it still does not widen the compatibility claim into broad action parity across sources.

Latest implementation note on April 9, 2026: novels library state no longer depends on profile-scoped `localStorage` as the product persistence layer. The working `Books > Sources` novels slice now reads and writes a real profile-root desktop file at `...\\novels\\library-state.json`, while preserving the same add/remove/read/restart behavior already proven in the product flow. Legacy profile-scoped `localStorage` novels state is migrated into the desktop file on first load when present.

Latest implementation note on April 9, 2026: the unified backup/export/import pipeline now reads `books` and `novels` from their authoritative desktop state instead of mixed legacy store sources. `booksBackup.ts` now serializes the dedicated books library state, and `novelsBackup.ts` now serializes the profile-scoped novels desktop state plus the repository/plugin references needed to classify restore correctly.

Latest implementation note on April 9, 2026: local books are now fully library-state self-contained in desktop storage. Core local-books metadata, progress, bookmarks, categories, category assignments, and books-library UI state no longer depend on general `settings` persistence. A real desktop restart audit now proves a persisted local EPUB remains visible after restart and that `booksCategories`, `booksCategoryAssignments`, and `booksLibraryUi` are restored from `...\\books\\library-state.json`.

Latest implementation note on April 9, 2026: a first real novels product slice now works inside the app shell. Novels stay profile-scoped in their own state, but surface inside `Library > Books > Sources` as first-class library items. The end-to-end desktop acceptance flow that is now proven for one official source is:

- add/use the official LNReader repository in Settings
- install one working official extension in-app
- open `Browse > Sources > Novel Sources`
- search one source
- open details
- add the novel to library
- open the novel reader
- return to `Library > Books > Sources`
- restart the app and confirm the novel persists

Latest implementation note on April 9, 2026: profile-scoped plugin package storage and Settings actions for install, update, enable, disable, and remove were added on top of the existing repository slice. This improves the real app path toward usable extensions, but it is still treated as implementation groundwork rather than a new compatibility-proof milestone because source registration, browse flows, library wiring, and broader runtime execution coverage remain open.

Latest implementation note on April 9, 2026: migration now has an authoritative desktop-backed journal and undo safety net. Manga source migration no longer removes the original item silently; it records an applied migration journal entry, keeps an undo window through toast action, and can roll the migration back from the captured old/new state snapshots. Novel migration UI and state-transfer logic now use the same journal pattern and are enabled only for the current minimum LNReader `migration-safe` cohort.

Latest implementation note on April 9, 2026: manga mass migration now has a bounded product surface with the same safety model. The migration modal can switch between single-title and source-to-source batch preview, build a `ready / needs-review / blocked` preview, apply only `ready` items by default, preserve category membership during transfer, and undo the whole applied batch through one mass migration journal entry. This is currently proven by engine tests, unit tests, and build verification; it has not yet been promoted to a separate desktop-audited phase-gate milestone.

Latest implementation note on April 10, 2026: novels now have the same bounded batch migration shape on top of the migration-safe cohort. The novels migration modal can switch between single-title and source-to-source batch preview, build a `ready / needs-review / blocked` preview from the current novels library state, apply only `ready` items by default, and undo the whole applied batch through one novels migration journal entry. This remains implementation-proven by engine tests, unit tests, and build verification; it has not yet been promoted to a separate desktop-audited phase-gate milestone.

Latest implementation note on April 10, 2026: novel extension install/update now triggers automatic bounded source classification per plugin and per profile. The result is persisted in desktop storage, surfaced as consolidated UI badges, and reused by the novels migration gate. The automatic classifier now defaults to a generic language-aware smoke plus browse-seeded fallback before needing any source-specific override.

Latest implementation note on April 10, 2026: `syncd` replication now covers the authoritative desktop state for `books` and `novels`, plus the persisted novels source-classification state. This includes books entries/categories/assignments/library UI/progress/bookmarks and novels entries/chapters/history/progress/bookmarks/classification. The migration journal and plugin artifacts still remain intentionally out of sync scope.

Latest implementation note on April 12, 2026: the automatic novels source classifier now uses a multi-page browse-seeded fallback on top of the generic language-aware smoke bank and shared query normalization. This improved the real coverage window for pending sources without turning the workflow back into manual per-extension certification. In the latest probe round, `centralnovel` proved `search + details + chapter` through the current runtime boundary, while `betternovels` failed at DNS / site reachability and remains `blocked-by-site`.

Supplemental note on April 9, 2026: strictly ad-hoc live `searchNovels` probes were executed against the official `inkitt` and `archiveofourown` sources through the current plugin boundary. These probes are recorded as supplemental evidence only and do not upgrade the main gate beyond the claims listed below.

Supplemental note on April 9, 2026: the official Portuguese source `illusia` was exercised through the current plugin boundary on `search + details + chapter`. This closed a real runtime helper gap: some LNReader sources call `fetchApi(...).text()` directly instead of `fetchText()`, so the runtime now normalizes `Response.text()`/`Response.json()` through the same charset-aware decoding path. Saved code points confirm the source returns correct UTF-8 text such as `Êxodo` and `confiável`, even when shell output still renders mojibake.

Supplemental note on April 9, 2026: the official English source `royalroad` now also passes `search + details + chapter` through the current plugin boundary. Combined with `archiveofourown` and the Portuguese source `illusia`, this is enough to establish the current minimum LNReader `migration-safe` cohort used by the bounded novels migration flow. The official Portuguese source `lightnovelbrasil` no longer fails because of the runtime wrapper, but its live search path currently lands on a JS redirect / anti-bot challenge page, so it is tracked as `blocked-by-site` instead of `runtime-gap`.

## Scope covered

This gate covers the currently shipped LNReader desktop slice:

- Phase 0 architecture freeze and primary-source audit
- Phase 1 repository persistence, CRUD, refresh, trust state, and catalog filtering
- Phase 3 hidden runtime host lifecycle proof
- one bounded end-to-end novels product path in the real desktop app for one official source

## Proven in this slice

- exact primary sources for the LNReader contract and Tauri capability model are recorded in [lnreader-compat-plan.md](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\docs\lnreader-compat-plan.md)
- LNReader repositories are persisted profile-scoped and rendered in Settings
- repository CRUD, refresh metadata, trust state, and cached language filtering are live in the desktop app
- profile-scoped plugin package storage actions now exist in the Settings novels panel for:
  - install
  - update
  - enable
  - disable
  - remove
- installed plugin artifacts are now written under profile-scoped novels storage instead of being only contract-level records
- the hidden `novel-runtime-host` is a real Tauri runtime surface with a dedicated capability file at [novel-runtime-host.json](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src-tauri\capabilities\novel-runtime-host.json)
- the hidden host starts during the runtime smoke and is absent afterwards in the real desktop target history
- the hidden host teardown path is clean enough to prove:
  - frontend stop request
  - backend close path
  - listener cleanup
  - host reference disposal
  - no orphan hidden host target after smoke
- installed trusted novel plugins are now surfaced inside the app as usable novel sources under `Browse > Sources > Novel Sources`
- novels library state is now stored in a real profile-root desktop file instead of profile-scoped `localStorage`
- local books library state is now stored in a real desktop file instead of mixed `aethon-store` / general settings persistence
- the unified backup/export/import pipeline now reads `books` and `novels` from their authoritative desktop state files
- source migration now has a real authoritative journal path instead of silent destructive replace:
  - desktop-backed `migration-journal-state.json`
  - applied migration journal entries
  - undo window through toast action
  - rollback support for the current manga migration flow
- manga mass migration now has a bounded source-to-source path:
  - `ready / needs-review / blocked` preview
  - apply `ready` by default
  - category membership carried to the migrated source
  - whole-batch undo through one journal entry
  - the existing manga migration modal now exposes this batch preview path in the product UI
- the current desktop migration path preserves the existing novels product flow:
  - `Library > Books > Sources`
  - add/remove from library
  - chapter baseline
  - progress baseline
  - history baseline
  - persistence after restart
- the current desktop migration path preserves the existing local books flow:
  - imported EPUB/PDF assets remain user-owned files copied into the existing books asset root
  - library metadata, progress, bookmarks, categories, assignments, and UI state persist in `...\\books\\library-state.json`
  - the same local book remains visible after restart
- one official source is now product-real end-to-end in the desktop app:
  - plugin: `archiveofourown`
  - search query: `manacled`
  - details screen opens from source search
  - `Add to Library` persists the novel into the profile-scoped novels library state
  - the novel appears in `Library > Books > Sources`
  - `Read novel` opens the novel reader
  - chapter baseline, progress baseline, and history baseline are persisted
  - the same library item remains visible after restart
- one trusted official LNReader plugin `details` call is proven in the real desktop app:
  - plugin: `69shu`
  - path: `/book/6644`
  - result name resolves with code points `6df1 6d77 4f59 70ec`
  - chapter count: `854`
  - summary present: `yes`
- one trusted official LNReader plugin `parseChapter` call is now also proven in the real desktop app:
  - plugin: `69shu`
  - chapter path: `/read/6644/3007932.html`
  - content length: `3006`
  - readable HTML preview returned: `yes`
- controlled plugin-load failure still surfaces as a source/runtime boundary error instead of crashing the app
- the shared migration/reconciliation contracts now include content-aware types for `manga` and `novel`
- novel source inventory now has a content-aware path alongside the existing manga-first source inventory
- novels migration UI exists in the product surface and is now enabled for the current minimum `migration-safe` cohort:
  - `archiveofourown`
  - `royalroad`
  - `illusia`
- the novels migration flow keeps the original item behind the journal/tombstone safety net instead of doing silent destructive replace
- novels mass migration now has a bounded source-to-source product path:
  - `ready / needs-review / blocked` preview
  - apply `ready` by default
  - whole-batch undo through one novels journal entry
  - target sources are still restricted to the persisted `migration-safe` cohort
- novel extension install/update now triggers automatic bounded source classification:
  - plugin load
  - search
  - details
  - chapter
  - durable per-plugin/profile result in desktop storage
  - consolidated UI status badges reusing:
    - `migration-safe`
    - `working`
    - `working-with-known-limitations`
    - `blocked-by-site`
    - `runtime-gap`
    - `pending`
- the novels migration gate now reads from the saved automatic classification state instead of baseline-only source labels
- the automatic classifier no longer depends on a source-specific recipe as the default path:
  - generic language-aware search bank
  - shared search fallback normalization
  - browse-seeded retry using titles from the source itself
- `syncd` replication now covers the authoritative desktop-backed state for:
  - `books`
    - entries
    - categories
    - category assignments
    - library UI
    - progress
    - bookmarks
  - `novels`
    - entries
    - chapters metadata
    - history
    - progress
    - bookmarks
    - source classification state
- novels now reload both library state and saved source classification state after remote replay instead of only bumping generic content state
- the novels runtime helper surface now mirrors the upstream LNReader contract much more closely for final generated plugin artifacts:
  - upstream multisrc is still treated as build-time only
  - no multisrc-specific runtime system was added in Aethon
  - `@libs/aes` now resolves with upstream-style `gcm`
  - `@libs/utils` now resolves with upstream-style `utf8ToBytes` and `bytesToUtf8`
  - `@libs/fetch` now includes upstream-relevant `fetchApi`, `fetchText`, `fetchJson`, and `fetchProto` helpers with runtime default headers
  - `@libs/storage` now includes upstream-relevant `storage`, `localStorage`, and `sessionStorage` helpers
  - filter types now align to upstream values:
    - `Text`
    - `Picker`
    - `Checkbox`
    - `Switch`
    - `XCheckbox`
  - the runtime boundary now identifies `PluginBase` versus `PagePlugin` explicitly from the final plugin artifact
  - the hidden capability-scoped runtime host now implements the already-whitelisted `source.popular`, `source.search`, and `source.chapter` actions in addition to the earlier settings/filter/details cases
- the focused novels/runtime suites pass after this alignment work
- the full `npm run test:unit` suite is green in the current workspace after this update

## Upstream gap closure in this micro-slice

Closed:

- upstream multisrc was confirmed as build-time generation only, and Aethon still targets the final generated plugin artifact from `plugins.min.json`
- missing helper aliases `@libs/aes` and `@libs/utils`
- incomplete `@libs/storage` shape versus upstream
- incomplete filter enum/value alignment versus upstream heavy filter shapes
- missing explicit `PluginBase` versus `PagePlugin` detection in the runtime boundary
- runtime host action gaps where `source.popular`, `source.search`, and `source.chapter` were whitelisted but not implemented

Still open:

- no broader proof yet that `popularNovels` works across live official sources
- no broader proof yet that `searchNovels` works across live official sources beyond the supplemental probes already recorded
- no broader proof yet that `parseChapter` works across live official sources beyond the trusted `69shu` smoke
- no broader proof yet for `PagePlugin.parsePage` execution in the desktop runtime
- no broader proof yet for full plugin install/update/remove lifecycle
- no broader proof yet that many installed plugins are user-ready across different source families
- no broader proof yet for reader integration
- no broader proof yet beyond the current minimum LNReader `migration-safe` cohort:
  - `archiveofourown`
  - `royalroad`
  - `illusia`
- no broader proof yet that novels migration is safe outside that cohort
- no separate desktop-audited proof yet for the novels mass migration UI path
- no separate desktop-audited proof yet for the manga mass migration UI path
- no sync scope yet for:
  - migration journal / tombstones
  - plugin artifacts
  - chapter content
  - local EPUB/PDF files

## Still provisional

- no claim yet for `popularNovels`
- no general claim yet for `searchNovels` across the runtime or across multiple sources
- no general claim yet for `parseChapter` across the runtime or across multiple sources
- no claim yet for full LNReader action compatibility across multiple sources
- no claim yet for broad charset-correct text decoding across non-UTF-8 sources
- no claim yet for plugin install/update/remove lifecycle
- no claim yet that installed novel plugins are broadly user-ready extensions in the same sense as the existing manga extension surface
- no claim yet for reader parity
- no claim yet for full syncd parity beyond the currently replicated authoritative state slices
- no claim yet for full plugin contract parity just because the helper surface is closer to upstream
- no claim yet that novels migration is user-available outside the required migration-safe cohort
- no claim yet for mass migration parity with Tachiyomi-style source-to-source flows

## Files proving this gate

Docs:

- [lnreader-compat-plan.md](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\docs\lnreader-compat-plan.md)
- [reader-ux-contract.md](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\docs\reader-ux-contract.md)
- [novel-runtime-syncd-integration.md](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\docs\novel-runtime-syncd-integration.md)
- [lnreader-source-compatibility-matrix.md](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\docs\lnreader-source-compatibility-matrix.md)

Repository/runtime implementation:

- [NovelRepositoriesPanel.svelte](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\components\settings\NovelRepositoriesPanel.svelte)
- [repositoryState.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\repositoryState.ts)
- [repositories.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\repositories.ts)
- [runtimeHost.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\runtimeHost.ts)
- [pluginRuntime.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\pluginRuntime.ts)
- [packages.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\packages.ts)
- [sources.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\sources.ts)
- [migrationSafe.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\migrationSafe.ts)
- [booksBackup.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\backup\booksBackup.ts)
- [novelsBackup.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\backup\novelsBackup.ts)
- [novelsStateBridge.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\backup\novelsStateBridge.ts)
- [importFile.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\books\importFile.ts)
- [libraryState.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\books\libraryState.ts)
- [libraryState.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\libraryState.ts)
- [libraryShelf.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\libraryShelf.ts)
- [domain.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\domain.ts)
- [types.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\migration\types.ts)
- [journalState.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\migration\journalState.ts)
- [manga.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\migration\manga.ts)
- [novels.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\migration\novels.ts)
- [NovelRuntimeHost.svelte](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\components\novels\NovelRuntimeHost.svelte)
- [NovelSources.svelte](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\components\pages\NovelSources.svelte)
- [NovelDetail.svelte](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\components\pages\NovelDetail.svelte)
- [NovelMigrateModal.svelte](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\components\pages\NovelMigrateModal.svelte)
- [MigrateModal.svelte](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\components\pages\MigrateModal.svelte)
- [NovelReader.svelte](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\components\reader\NovelReader.svelte)
- [NovelsLibraryBody.svelte](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\components\library\NovelsLibraryBody.svelte)
- [Library.svelte](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\components\pages\Library.svelte)
- [App.svelte](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\App.svelte)
- [novel-runtime-host.json](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src-tauri\capabilities\novel-runtime-host.json)
- [lib.rs](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src-tauri\src\lib.rs)
- [package.json](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\package.json)

Tests:

- [pluginRuntime.test.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\pluginRuntime.test.ts)
- [runtimeHost.test.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\runtimeHost.test.ts)
- [repositories.test.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\repositories.test.ts)
- [packages.test.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\packages.test.ts)
- [journalState.test.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\migration\journalState.test.ts)
- [booksBackup.test.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\backup\booksBackup.test.ts)
- [novelsBackup.test.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\backup\novelsBackup.test.ts)
- [novelsStateBridge.test.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\backup\novelsStateBridge.test.ts)
- [libraryState.test.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\books\libraryState.test.ts)
- [libraryState.test.ts](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src\lib\novels\libraryState.test.ts)

Runtime evidence:

- [runtime-lifecycle-audit.json](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\tmp\lnreader-runtime-audit-lifecycle\runtime-lifecycle-audit.json)
- [runtime-lifecycle-audit.png](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\tmp\lnreader-runtime-audit-lifecycle\runtime-lifecycle-audit.png)
- [live-search-probe.json](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\tmp\lnreader-live-search-probe\live-search-probe.json)
- [ao3-live-search-probe.json](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\tmp\lnreader-live-search-probe\ao3-live-search-probe.json)
- [acceptance-flow.json](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\tmp\novels-product-acceptance\acceptance-flow.json)
- [acceptance-flow.png](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\tmp\novels-product-acceptance\acceptance-flow.png)
- [persistence-check.json](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\tmp\novels-product-acceptance\persistence-check.json)
- [persistence-check.png](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\tmp\novels-product-acceptance\persistence-check.png)
- [books-persistence-check.json](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\tmp\books-storage-audit\books-persistence-check.json)
- [books-persistence-check.png](C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\tmp\books-storage-audit\books-persistence-check.png)

## Evidence summary

The real desktop audit on April 9, 2026 proved:

- `hostSeenDuringSmoke = true`
- `hostPresentBeforeSmoke = false`
- `hostPresentAfterSmoke = false`
- `shutdownConfirmed = true`
- `detailsConfirmed = true`
- `chapterConfirmed = true`
- trusted source smoke returned a valid `details` payload for `69shu`
- trusted source smoke returned a valid `parseChapter` payload for the first chapter path resolved from the same `69shu` details payload
- the persisted runtime evidence records the returned title with code points `6df1 6d77 4f59 70ec`
- the persisted runtime evidence records:
  - `chapterPath = /read/6644/3007932.html`
  - `chapterLength = 3006`
  - a readable HTML preview snippet
- earlier mojibake seen in shell output was a terminal inspection artifact, not a failure in the saved UTF-8 runtime evidence
- the first bounded product acceptance flow on April 9, 2026 proved:
  - source: `archiveofourown`
  - query: `manacled`
  - `detailOpened = true`
  - `addedToLibrary = true`
  - `readerOpened = true`
  - `libraryCardVisible = true`
  - `persistedAfterRestart = true`
  - `storageRoot = C:\\Users\\jhow-\\AppData\\Roaming\\aethon\\novels`
  - persisted state now comes from `library-state.json`, not `aethon-novels-library-state`
  - the saved profile-scoped novels state contains:
    - one library entry
    - four persisted chapter records
    - one persisted progress record
    - one persisted history record
- the local books desktop audit on April 9, 2026 proved:
  - `storageRoot = C:\\Users\\jhow-\\AppData\\Roaming\\aethon\\books`
  - `expectedTitle = Aethon Storage Audit`
  - `persistedAfterRestart = true`
  - `categoryAssignmentConfirmed = true`
  - `uiFilterConfirmed = true`
  - `uiSearchConfirmed = true`
  - the saved books desktop state contains:
    - one persisted local EPUB entry
    - one persisted books category named `Audit Shelf`
    - one persisted category assignment for the imported EPUB
    - `booksLibraryUi.typeFilter = epub`
    - `booksLibraryUi.search = Aethon Storage Audit`

Supplemental ad-hoc probe on April 9, 2026 observed:

- official source: `inkitt`
- plugin artifact resolved from the official LNReader repository
- source loaded through the current plugin boundary
- one live `searchNovels("shadow", 1)` call returned a valid structured array
- saved evidence recorded `resultCount = 10`
- this supplemental probe does not upgrade the main gate to broader `searchNovels` compatibility
- the saved first result still includes mojibake in `The Obsidianâ€™s Shadow`, so broad charset coverage remains explicitly unproven
- official source: `archiveofourown`
- plugin artifact resolved from the official LNReader repository
- source loaded through the current plugin boundary
- one live `searchNovels("manacled", 1)` call returned a valid structured array
- saved evidence recorded `resultCount = 20`
- this second supplemental probe suggests the current search boundary is not only `inkitt`-specific, but it still does not upgrade the main gate to general `searchNovels` compatibility
- official source: `illusia`
- plugin artifact resolved from the official LNReader repository
- source loaded through the current plugin boundary
- one live `searchNovels("o", 1)` call returned a valid structured array
- one live `parseNovel("story/exodo")` call returned a valid details payload with one chapter
- one live `parseChapter("story/exodo/o-homem-mais-confiavel-da-lua")` call returned valid HTML content
- saved code points confirm the runtime now preserves `Êxodo` and `confiável` correctly after normalizing the `fetchApi(...).text()` response path
- this supplemental probe establishes the current Portuguese side of the minimum `migration-safe` cohort, but it still does not upgrade the main gate to broad Portuguese-source compatibility
- official source: `royalroad`
- plugin artifact resolved from the official LNReader repository
- source loaded through the current plugin boundary
- one live `searchNovels("mother of learning", 1)` call returned a valid structured array
- one live `parseNovel("fiction/21220")` call returned a valid details payload with 109 chapters
- one live `parseChapter("fiction/21220/chapter/301778")` call returned valid HTML content
- this supplemental probe establishes the second English slot of the current `migration-safe` cohort, but it still does not upgrade the main gate to broad English-source compatibility
- official source: `lightnovelbrasil`
- the runtime wrapper gap around `Response` branding is now closed
- live source search still returns a JS redirect / anti-bot challenge page instead of structured results
- this source is therefore currently classified as `blocked-by-site`, not `runtime-gap`

## Why this is still only provisional

This slice now proves more than repository/runtime groundwork: it proves one real vertical novels flow in the product for one official source. It is still only provisional because that proof is intentionally narrow and does not yet establish broad compatibility across source families, broad action parity, reader parity, or syncd integration.
