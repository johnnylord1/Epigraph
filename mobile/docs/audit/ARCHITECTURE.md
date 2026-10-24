# Baseline architecture map

## Active Gradle modules

| Module | Responsibility |
|---|---|
| `app` | Android application, UI, readers, extensions, downloads, backup, trackers, and novel integration |
| `core:archive` | Archive and EPUB container primitives |
| `core:main` | Shared Android/network/platform helpers |
| `data` | SQLDelight database, repositories, and data adapters |
| `domain` | Domain models and repository contracts |
| `i18n` | Shared localized resources |
| `presentation:core` | Shared presentation components |
| `source:api` | Manga/source extension contracts |

`presentation:widget` exists but is not included in the build.

## Baseline flows

```text
Manga APK extension -> Source API -> repositories -> SQLDelight -> Library/Details -> Manga Reader
Novel repository -> JS plugin manager -> QuickJS bridge -> reused manga/chapter rows -> Novel Reader/TTS
Local EPUB -> Readium Publication -> EpubNavigatorFragment
Local PDF -> PdfiumPdfReaderAdapter -> sequential bitmap/reflow surfaces
Backup -> protobuf + gzip -> per-entity restore operations
```

## Shared library architecture

`LibraryController` is the single host for Comics, Novels and Books. Every surface is submitted
through the Comics library pipeline:

```text
LibraryController -> LibraryCategoryAdapter -> LibraryItem -> LibraryHolder -> manga_*_item
                         |                    |                 |
                         |                    |                 +-- grid/list preferences and selection
                         |                    +-- LibraryMangaItem (Comics + online Novels)
                         +----------------------- LibraryBookItem (local EPUB/PDF)
```

The domain remains explicit. Comics keep chapter/download/badge behavior, Novels keep their
`LibraryManga` identity and `ReaderActivity` route, and EPUB/PDF keep content-addressed private
files and relink/manage actions. `LibraryBookItem` does not create a synthetic manga record; it only
adapts local metadata to the same filtering, holder lifecycle, grid/list geometry, click and
long-press routing used by Comics.

## Implemented Epigraph foundation

- Protocol v2 contracts for four content types, stable bindings/locators and 18 sync commands.
- Schema 39 side tables for identity, categories, progress, outbox/inbox, receipts, tombstones, assets, aliases, paired-Core metadata and confirmed Core replica/checkpoint/Lamport state.
- `EpigraphMutationCoordinator.mutateLocalBatch` for transaction-coupled domain writes and ordered outbox commands.
- `EpigraphLibraryMutationRouter` as the first throwing, transaction-safe favorite/category write primitive.
- EPUB/PDF adapter/import contracts, streaming SHA-256, SAF private copy and defensive EPUB container/OPF/spine validation.
- Central book-reader router with a single Readium EPUB engine and a single Pdfium PDF engine, both with ephemeral password/locator handling.
- Novel HTML allowlist and restricted WebView boundary.
- Syncd v1 wire DTOs and capability gate, kept separate from the Android outbox/domain protocol v2.
- Real pairing state machine for desktop QR/codes, approval observation and final token exchange.
- Concrete HTTP/WebSocket pairing transport pinned to the exact leaf-certificate DER hash, retaining Android's hostname and certificate-validity checks.
- Android Keystore AES-GCM credential vault with authenticated versioned storage and atomic replacement for token rotation.
- HTTPS Core client for capabilities, snapshots, changes and flat mutations, with bearer tokens supplied per call and redirects disabled.
- Suwayomi authority boundary for comics: profile-scoped catalog pagination, authenticated cover references, typed mutation queue and confirmed server status.
- Ordered bootstrap stages for extension inventory/repositories (review-only), portable bindings, catalog materialization and Core replica replay; APK installation runs after the user taps "Install all", through the private installer (or Shizuku) with no prompt per APK.
- Core readiness is capability-gated by `suwayomi-confirmed-v1`; the mobile worker does not report a drained outbox while the desktop projection queue is pending or blocked.
- Incremental SSE decoder/replay policy with durable two-phase checkpoint advancement and snapshot fallback after replay expiry.
- Immutable Core asset transfer with resumable downloads, verified atomic publication and intentionally non-resumable whole-body uploads.
- Ordered bootstrap planner and per-mutation receipt policy for Syncd's non-atomic batches.
- Product DI binds the encrypted pairing store, pinned Core session transport, outbox drainer, WorkManager scheduler, SQLDelight replica store/applier and snapshot bootstrap.

## Target additions

```text
                           +----------------------+
Domain mutation ---------->| mutateLocalBatch      |----> Epigraph Sync Engine
                           +----------------------+             |
                                      |                        TLS/SSE/assets
                                      v                         |
Local SQLDelight replica <--------------------------------> Epigraph Core

Reader adapters:
  MangaReader (existing)
  NovelReader (stabilize existing)
  EpubNavigatorFragment (Readium 3.2.0)
  PdfiumPdfReaderAdapter + PdfPageView
```

The sync model preserves existing local integer IDs. Stable Epigraph identity, bindings, locators, devices, outbox/inbox, tombstones, checkpoints, asset manifests and confirmed Core records are side tables rather than a rewrite of upstream tables. Pairing, pinned transport, encrypted credentials, WorkManager, the v1 outbox adapter and transactional snapshot/inbox application are wired. Comics use the Suwayomi bridge as catalog authority; Core snapshot/replay carries confirmed complementary reader state and novels/books.

The Core now advertises the bounded Suwayomi catalog, extension inventory, typed command bridge and `GET /v1/sync/status` readiness endpoint independently from the generic GraphQL proxy. Catalog reconciliation is complete-set only after every page validates, while a failed or partial page preserves the last-known-good Library. Creation/renaming of new Suwayomi categories and tracker bindings remain explicit follow-up work; the mobile client does not claim those capabilities when absent from the negotiated Core.

The sync status also carries optional `comicLibraryRevision` and `comicExtensionsRevision` digests of the catalog fields the phone applies (unread and download counts excluded). `CoreCatalogRevisionGate` skips the extension inventory, portable manifest and catalog stages when the announced revision, and the local state it met (installed extensions, library signature, no unsettled comic work, a complete catalog stamp, a settled portable bootstrap), are unchanged since the last real apply and that apply is under 6 h old. The Core hides the revisions while a library change is projecting or blocked (pending progress does not hide them). A missing revision or a failed status read runs the stage but keeps the record, since a revision is a content digest; a stage that did not apply runs again; the Core replica, which carries progress, always runs. The record is a replaceable SharedPreferences cache, so no schema change is involved.

## Boundaries

- The PC is not a content proxy for normal manga/novel reading.
- The Core is needed for LAN synchronization and shared EPUB/PDF assets.
- Desktop UI stays untouched. Only a future invisible Rust bridge may be changed after handoff.
- SyncYomi is a behavioral reference only; GPL code is not copied into this Apache-2.0 fork.
