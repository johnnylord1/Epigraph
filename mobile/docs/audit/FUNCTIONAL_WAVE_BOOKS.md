# Functional wave - unified library and local readers

Date: 2026-08-08

## Scope

This wave changes only the Android application. It does not change the desktop repository, the
Epigraph Core/Syncd protocol, pairing, outbox behavior, or global theme assets.

## Delivered

- EPUB/PDF import through the Storage Access Framework.
- Preview before publication with detected type, byte size, SHA-256, and duplicate detection.
- Private content-addressed storage using a staged `.part` file, `fsync`, validation, and atomic
  finalization.
- SQLDelight tables for local books, progress, bookmarks, highlights, and category assignments.
- Idempotent re-import by SHA-256 and safe removal ordering.
- Books entry in the Library toolbar and Settings, using the existing Epigraph chrome.
- EPUB structural validation plus Readium 3.2.0 parser validation.
- PDF reader adapter backed by Ahmer Pdfium 1.9.2 with the app-owned bitmap/reflow surface.
- Reader actions for search, table of contents, bookmarks, and text-to-speech.
- Persisted highlights are reapplied to the reader, listed with bookmarks, and can be created from
  selected EPUB ranges, selectable PDF reflow text, or the explicit page-selection surface.
- EPUB offline HTML sanitization, local progress tracking, and process-restart restoration.
- EPUB uses the Readium 3.2.0 publication and `EpubNavigatorFragment` as its only renderer;
  full locator JSON (including CFI/context), pagination/scroll preferences, TOC, search and
  decorations are restored through that navigator.
- PDF pages are rendered sequentially from the one Pdfium session; the page surface never opens a
  second PDF handle, avoiding the previous controller/viewer split.
- Automatic cleanup of abandoned unpublished import parts older than 24 hours.
- Missing-file detection after restore or storage loss, with SHA-256-verified relinking through SAF.
- Backward-compatible backup field for EPUB/PDF metadata, progress, bookmarks, highlights, and
  category names. Private bytes remain outside the backup by design.
- A unified Books & Novels surface embedded in the existing Library controller. It joins favorite
  LNReader novels with local EPUB/PDF entries, supports title/author search and All/Novels/EPUB/PDF
  filters, and opens each item through its existing reader without creating synthetic manga rows.
  The surface is revealed below the expanded app bar and suppresses the manga-only empty overlay,
  so import/search/card taps remain usable even when the comic library is empty or still loading.
- Reader preferences kept outside the theme system: EPUB font scale, line height, family,
  alignment, paragraph spacing, content width, document-local themes and scroll/paginated flow;
  PDF night mode, width/height/both/actual fit, selectable text reflow and horizontal paging; and
  persisted TTS rate, pitch and voice with EPUB active-segment highlighting.
  The local reader now has a desktop-style previous/next HUD and a seek bar for both PDF pages and
  EPUB global progression. PDF page changes continue to save progress immediately as well as on
  lifecycle pause.

## Feature mapping used for this wave

The reference set was used as a capability checklist, not as a code dependency:

| Capability | Moon+ Reader Pro reference | LNReader reference | Epigraph status |
| --- | --- | --- | --- |
| One shelf/library for multiple written formats | Local formats, shelf, tags and search | Library, categories and history | Delivered: one Library surface for novels, EPUB and PDF |
| EPUB typography | Font scale, line spacing, themes | Font family, size and line height | Delivered: per-device scale, line height, family, alignment, paragraph spacing and content width; document-local themes do not touch the app theme |
| PDF ergonomics | Night mode, fit/dual-page, smooth paging | N/A | Delivered: width/height/both/actual fit, night mode, selectable reflow text, horizontal paging, and previous/next/page seek HUD; dual-page remains engine work |
| Search and contents | Search, TOC and footnotes | Search, chapter navigation and filters | Delivered for EPUB/PDF; novel search/chapter flow already exists |
| Offline reading | Local files and downloads | Chapter downloads and offline reading | Delivered for imported EPUB/PDF and existing novel downloads |
| TTS | TTS with speed, voice and hardware controls | TTS and reader settings | Delivered for local text with persisted rate, pitch, voice selection and paragraph navigation; novel TTS remains in the existing reader |
| Selection/highlights/notes | Highlight, annotation, dictionary and translation | Text selection and custom CSS/reader controls | Delivered for EPUB ranges and PDF reflow/page selection; native PDF canvas overlays and dictionary/translation remain pending |
| Backup and reading position | Cloud backup/sync | Backup/restore and reading positions | Delivered locally through Epigraph metadata backup; private bytes remain opt-in future work |

## Verification

- `:data:verifySqlDelightMigration`: passed.
- `:data:testAndroidHostTest --tests epigraph.books.LocalBooksSchemaTest`: passed.
- `:app:compileDevDebugKotlin`: passed after reader restore and large-EPUB changes.
- `:app:compileDevDebugKotlin`: passed after the unified Library surface and reader preference
  controls were added.
- `:app:testDevDebugUnitTest`: passed, including EPUB/PDF readers, import, backup, Core and
  Suwayomi regression tests.
- `:app:assembleDevDebug`: passed; final APK is available at
  `app/build/outputs/apk/dev/debug/app-dev-universal-debug.apk`.
- Emulator API 36 flow: Library -> Books -> SAF imported `Chrysalis.epub` and
  `Nubank_2026-05-10.pdf`, verified both private SHA-256 copies, opened both readers, searched the
  PDF and EPUB, navigated EPUB Contents, saved a bookmark, and restored progress after a process
  restart. The final APK was reinstalled and launched on the visible `Epigraph_Test_API36` AVD.
- Final APK smoke on `Epigraph_Test_API36`: opened the unified Books & Novels page, confirmed both
  persisted local files and All/Novels/EPUB/PDF filters, opened EPUB and PDF readers, and verified
  the EPUB typography/line-spacing and PDF night/fit/horizontal settings dialogs without a crash.
- Fresh API 36 smoke after the reader/HUD port: completed storage setup, opened Books & Novels with
  an empty comic library, imported a valid EPUB and a 6,710-page PDF through SAF, opened both
  readers, verified the EPUB and PDF settings menus, confirmed Previous/Next and PDF page 2
  navigation, and found no app fatal exception in logcat. An intentionally malformed EPUB was
  rejected with the expected mimetype validation message.
- Reader completion smoke on API 36: exercised PDF fit-mode/reflow settings and confirmed the
  selectable reflow page rendered its text layer; reopened the EPUB reader with JavaScript locked
  to the local sanitized document, verified EPUB typography settings and no fatal exception.
- Desktop reader audit and port matrix: `docs/audit/DESKTOP_READER_PORT.md`; desktop files were
  read only and remain unchanged.
- `:app:lintDevDebug` completes through Gradle with `0 errors`, `641 warnings` and `2 hints`; no
  baseline, warning suppression or check-only shortcut was added. The report is at
  `app/build/reports/lint-results-devDebug.html`.

## Known remaining work

- The Readium navigator owns EPUB pagination, scroll, search, selection and decorations. External
  navigation is blocked by the local reader host; OCR/DRM remain outside this wave.
- PDF text/search/highlight actions are exposed by the adapter and reader action layer. Reflow text
  and the explicit page-selection surface support durable highlights; native selection overlays on
  the rendered PDF canvas and OCR for scanned pages are not part of this wave.
- Novel and local-book TTS remain separate foreground services but share playback semantics and
  both survive removal of the reader task; explicit stop and natural completion still terminate
  playback.
- Backup does not include private EPUB/PDF bytes yet; restore recreates a missing-file entry and
  the user must relink the original file. A future opt-in archive can add bytes without changing
  the metadata field.

## Scope boundary

No Syncd/Core, pairing, outbox, desktop, or global-theme files were changed by this functional
work.
