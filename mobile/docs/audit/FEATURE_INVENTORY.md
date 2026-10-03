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
| J2K backup/restore | Partial | Size limits, verified `.part` finalization for automatic backups and a no-secrets policy are in place; a transactional/resumable restore and EPUB/PDF bytes remain |
| Epigraph identity/sync | Client foundation integrated | Transaction-coupled outbox, pinned pairing, encrypted credentials, WorkManager, snapshot replica and v1 adapter are present; projection and real convergence remain |
| Core pairing/snapshot/assets | Partial Android client | Pairing UI/transport and snapshot/assets contracts are present; a running Core is still required for E2E certification |
| Tracking | Synced records and paired credentials | Tracking records travel through the outbox and replica (`comic.tracking`, `novel.tracking`); tracker tokens travel only over the paired session and are Keystore-sealed; backup carries records without tokens. See `TRACKER_SYNC_CONTRACT.md` |
| Library-based recommendations | Implemented (Browse "For you") | `DiscoverRecommendationLoader` builds a taste profile from library entries, tracker status and books, ranks candidates from the most-used library sources and AniList trending, skips titles already known, marks NSFW-extension results as adult (hidden unless NSFW sources are shown) and removes repeats across sections; the desktop Discover page is the reference |

## Reader security finding

The v1.13.0 QuickJS wrapper was only a generic evaluator. The selected baseline contains real novel/plugin work, but it is not equivalent to the target sandbox contract. Novel HTML now passes through an allowlist and the WebView blocks remote subresources, files, mixed content and navigation. Remote novel images reach the WebView only through `NovelRemoteImageBroker` (the sanitizer rewrites HTTPS sources to a private scheme), and "block media" still blocks them. QuickJS has deadlines, code/result/heap budgets, cancellation, and brokered network access with SSRF and DNS-rebinding protection.

## Download P0

The manga downloader now retains temporary data on failure, verifies the final destination/page set, and only then publishes downloaded state. Process-death coverage on a device is still open (P2).
