# Feature inventory at selected baseline

| Capability | State | Gate implication |
|---|---|---|
| Manga extensions and browse | Complete baseline | Preserve and test |
| Manga reader modes, dual page, RTL/LTR, webtoon | Complete baseline | Preserve and test |
| Manga progress/resume | Complete baseline | Add stable sync locator |
| Manga downloads | Stabilized foundation | Atomic finalization and focused integrity tests implemented; full offline matrix remains |
| Novel repositories/plugins | Present | Stabilize and secure |
| LNReader compatibility | Partial | Representative fixtures only; do not certify every external plugin |
| Novel reader/TTS | Canonical reader present | `ReaderActivity` routes novels only to `NovelWebViewViewer`; foreground TTS survives task removal; representative plugin/security coverage remains |
| Books library surface | Implemented in the shared Comics architecture | Books mode is hosted by `LibraryController` and uses `LibraryCategoryAdapter`, `LibraryItem`/`LibraryHolder`, the same manga grid/list resources, filtering/selection lifecycle and grid-size preferences. Novels remain `LibraryMangaItem`; EPUB/PDF use `LibraryBookItem` with private content-addressed files and reader-specific actions. |
| EPUB validation/private import | Implemented | SAF stream is copied, fsynced, validated and atomically published in private storage; Readium 3.2.0 opens the same private asset |
| EPUB TOC/CFI/search/highlights/TTS | Implemented through Readium | `EpubNavigatorFragment` is the only renderer; full locator JSON, TOC/search, selection and Readium decorations are persisted locally |
| PDF contracts/import/reader | Implemented through Pdfium | `BookReaderRouter -> PdfiumPdfReaderAdapter` owns validation, password, text/outline/search/highlights and sequential bitmap rendering; no parallel controller/viewer path |
| J2K backup/restore | Partial | Idempotency and transaction fixes required |
| Epigraph identity/sync | Client foundation integrated | Transaction-coupled outbox, pinned pairing, encrypted credentials, WorkManager, snapshot replica and v1 adapter are present; projection and real convergence remain |
| Core pairing/snapshot/assets | Partial Android client | Pairing UI/transport and snapshot/assets contracts are present; a running Core is still required for E2E certification |
| Tracking | Present for existing media | Add field-level sync semantics |

## Reader security finding

The v1.13.0 QuickJS wrapper was only a generic evaluator. The selected baseline contains real novel/plugin work, but it is not equivalent to the target sandbox contract. Novel HTML now passes through an allowlist and the WebView blocks remote subresources, files, mixed content and navigation. Remote novel images are intentionally discarded until a permission-aware broker exists. QuickJS deadlines, memory/network budgets, cancellation and SSRF protection remain open.

## Download P0

The manga downloader now retains temporary data on failure, verifies the final destination/page set, and only then publishes downloaded state. Full emulator and process-death coverage is still required.
