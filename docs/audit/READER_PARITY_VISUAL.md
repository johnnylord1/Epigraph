# Reader parity and shared visual contract

This audit covers the local mobile readers only. Epigraph Core, Syncd, pairing and the desktop
application are intentionally excluded.

## Capability matrix

| Capability | Novel reader | EPUB reader | PDF reader | Shared contract |
| --- | --- | --- | --- | --- |
| Resume after process death | Yes, chapter/offset state | Yes, full Readium `Locator` JSON (CFI/context) plus normalized progress | Yes, page/offset locator | `ReaderLocator` is persisted before leaving the reader |
| Progress and history | Yes | Yes | Yes | The reader writes local state only; no sync mutation is generated |
| Chapter/document navigation | Chapter controls and previous/next | TOC and document navigation | Outline and page navigation | Every reader exposes a persistent position affordance |
| Search | Chapter/content search | Publication text search | Text-layer search with OCR fallback when recognition succeeds | Scanned PDFs without recognized text explicitly report that text is unavailable |
| Bookmarks | Chapter/position bookmarks | Locator bookmarks | Page/offset bookmarks | Same add/remove and restore semantics |
| Highlights/notes | Quote manager and selection actions | Readium selection and `Decoration` highlights | Text selection/highlight for text PDFs and OCR text when available | Unsupported PDF text layers fail with a clear message |
| TTS | Novel-specific foreground service with shared commands | Book-specific foreground service from the current locator | Same book service; OCR fallback when recognition succeeds | Services remain separate by domain while sharing playback semantics and never persist credentials |
| Offline content | Downloaded chapter | Imported private EPUB | Imported private PDF | Local bytes are resolved before remote sources |
| Reader settings | Typography, translation, find/replace, auto-scroll | Typography, margins, flow and theme options | Zoom, fit/reflow, orientation and layout options | Controls use the same rounded outlined action token as the comic reader |

## Intentional differences

Novel chapters can expose plugin-specific actions (translate, define, web search, auto-scroll and
find/replace) that do not have a portable equivalent in a PDF canvas. EPUB exposes Readium CFI and
publication metadata, while PDF exposes page/outline/password operations. These are additive
capabilities, not separate visual systems.

The remaining platform/document limitations are explicit rather than represented as false parity:

- Native PDF selection actions (define/translate/web search) remain limited by Android's platform text-action menu.
- OCR uses the bundled ML Kit Latin recognizer; pages in unsupported scripts or with poor scan quality may return no text.
- The novel TTS service and book TTS service are intentionally separate foreground services. Both keep playback alive when the reader task is removed; explicit stop, natural completion and force-stop still follow Android's normal process rules.
- PDF single-page and two-page modes render sequential bitmaps through the one Pdfium session. The page surface owns zoom/pan gestures but never opens a second PDF handle.

## Visual audit

The novel reader now resolves `colorSurface`, `colorSecondary`, `actionBarTintColor` and
`colorControlHighlight` from the same resource attributes used by the comic reader. Novel settings
buttons use `Widget.Tachiyomi.Button.ReaderOutlined`, matching the comic reader's 40dp target,
12dp radius, outline variant, secondary accent and ripple. The novel spinner uses the rounded ripple
surface, and the quote/find-replace Compose sheets use a 12dp rounded top edge, a visible drag handle
and the Material surface container.

Books and Comics are two modes of the same `LibraryController`, not separate navigation stacks. The
Books mode now consumes the same `LibraryCategoryAdapter`, `LibraryItem`/`LibraryHolder` lifecycle,
`manga_grid_item`/`manga_list_item` resources, filtering and selection callbacks used by Comics.
Novels remain Epigraph `LibraryMangaItem` rows; EPUB/PDF are `LibraryBookItem` rows that keep their
content-addressed local-file identity and reader-specific actions. This preserves the domain
difference without manufacturing manga records or maintaining a second library adapter. The toolbar
action stays visible and changes both title and icon so the transition is discoverable in both
directions. Book and novel cards keep the same cover geometry, outline treatment and touch targets;
import and file-management actions are secondary controls rather than a different card layout.

EPUB preferences are submitted through Readium's `EpubPreferences` API; no custom HTML/CSS renderer
or ZIP/WebView session remains. PDF spread pages are presented through the same reader chrome as
single-page mode; only the bitmap surface differs to keep Pdfium access sequential.

### HUD accent and PDF modes

All three reader families derive the HUD accent (seek-bar thumb, active page, selected tabs) from
the app theme's `colorSecondary` through `ReaderThemeColors.themedAccent`. On paper and sepia
surfaces the accent is blended toward the text colour until it reaches 3:1 contrast, so it keeps
its hue instead of collapsing to black. `LocalBookReaderActivity` applies the user's app theme
before `super.onCreate`, which the EPUB/PDF reader previously skipped (the HUD fell back to the
default blue).

The PDF reader mirrors the desktop's two modes, page and reflow (`pdfReflowMode`). Page mode adds
single-page paging (horizontal or vertical swipe) and a two-page spread; the spread takes priority
over the paging direction. Single-page mode letterboxes with the page colour (white, or black in
night mode), like the spread, instead of black bands. The settings sheet keeps layout options
(fit, reflow, paging direction, spread) under Pages and input options (volume keys, vertical bar)
under Navigation, matching the comic reader where "Paged" is a Navigation choice.

## Verification status

- Resource merge and Kotlin compilation: `:app:processDevDebugResources` and
  `:app:compileDevDebugKotlin` pass in the final build.
- APK packaging: `:app:assembleDevDebug` passes and the resulting APK was installed on the API 36
  emulator.
- Unit tests: `:app:testDevDebugUnitTest` completed with 335/335 tests passing. The
  `SuwayomiCatalogSyncTest` cases ran normally (including the snapshot/retry diagnostics); no sync
  tests were filtered, removed or changed by this reader cycle.
- SQLDelight: `:data:verifySqlDelightMigration` passes.
- Lint: Gradle-integrated `:app:lintDevDebug` now completes with `0 errors`, `641 warnings` and
  `2 hints`. The only configuration error was the ignored Windows `local.properties` SDK path;
  it was corrected with an escaped drive-letter separator. No baseline, warning suppression or
  check-only shortcut was added. The existing report is at
  `app/build/reports/lint-results-devDebug.html`; a post-change rerun exceeded five minutes in
  the legacy UAST analysis before producing a new report, so it is recorded as inconclusive for
  this small library-surface change.
- Emulator smoke (API 36): the current APK launches without a fatal exception; the shared Library
  surface opens Books & Novels, switches back to Comics, and exposes EPUB/PDF filters/import. Books
  renders the same manga grid cards (and follows the same list/grid preference) instead of the old
  custom vertical rows. A real PDF imported through Android's document picker appeared as a
  `LibraryBookItem` card with the same grid geometry and opened through `LocalBookReaderActivity`. An
  existing private EPUB opened through the Readium navigator (TOC and search dialogs were exercised).
  An existing private PDF opened through the Pdfium adapter, advanced from page 1 to page 2, and
  exposed bookmark/annotation/selection/TTS/settings actions. Clean logcat showed no Java crash,
  SIGSEGV or fatal Pdfium signal during either reader run. The PDF activity was also closed from
  the reader; the native teardown returned to Library without a crash after making PdfiumCore the
  sole owner of page/document cleanup.
- Accent/PDF-mode pass (2026-09-29): `:app:testDevDebugUnitTest`, `:data:testAndroidHostTest`,
  `:data:verifySqlDelightMigration` and `:app:lintDevDebug` pass (653 tests, 0 failures; lint 0 errors).
  On the API 36 emulator the PDF opened in spread, single-page vertical paging and sepia reflow, EPUB
  rendered with the themed HUD, and every settings screen opened without a fatal exception.
- Current universal debug APK SHA-256: `14FEF7557220DAA4CA5347342CE1CD58F66A86DA5474CE9A97C2534482FA23F8`.
- This reader change set does not modify desktop, Syncd, Epigraph Core, pairing or theme sources.
