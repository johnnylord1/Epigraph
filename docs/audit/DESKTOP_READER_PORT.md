# Desktop reader audit and mobile port

Date: 2026-08-08

This document records a read-only audit of the reader in the separate desktop
workspace. Desktop files were not modified. The mobile implementation lives only in this repository and keeps
the Epigraph visual system unchanged.

## Capability matrix

| Capability | Desktop reference | Epigraph Mobile status |
| --- | --- | --- |
| Shared reader chrome | `src/components/reader/ReaderHud.svelte` | Ported to the local EPUB/PDF reader with previous/next navigation, progress label and seek bar. |
| EPUB search and TOC | `src/components/reader/BookReader.svelte` | Readium publication search/TOC through the canonical `EpubNavigatorFragment`; no ZIP/WebView renderer remains. |
| EPUB scroll/paginated flow | `BookReader.svelte` (`bookReaderFlow`) | Submitted through Readium `EpubPreferences` (`scroll`/paginated). |
| EPUB typography | `BookReader.svelte` (`proseReader*`) | Font size, line height, family, alignment, spacing and margins are submitted through Readium preferences. |
| EPUB themes | `BookReader.svelte` (`proseReaderTheme`) | Reader-local Readium themes remain separate from the global app theme. |
| EPUB selection/highlights | `BookReader.svelte`, `ReaderHud.svelte` | Readium selection returns a full locator; persisted highlights are rendered as Readium `Decoration`s. |
| PDF fit/night/horizontal | `BookReader.svelte` (`pdfFitMode`, `pdfDarkMode`) | Pdfium adapter renders single/sequential two-page bitmaps with zoom/pan and text reflow; no second file-opening viewer exists. |
| PDF outline/search/password | `BookReader.svelte` | Available through the PDF adapter and local reader actions. |
| PDF selection/highlights | `BookReader.svelte` | Reflow text is selectable and can be highlighted; visual canvas selection overlays remain engine work. |
| TTS | `TtsControls.svelte`, `src/lib/reader/tts.ts` | Novel and book foreground services remain separate, share playback semantics, and expose rate/pitch/voice/media controls after task removal. |
| Novel reader | `NovelReader.svelte`, `NovelTts*` | Existing Epigraph novel reader already has chapter navigation, style controls, selection actions, auto-scroll, offline sanitization and background TTS. No desktop code was copied into it. |

## Porting rules

1. Only behavior and data contracts are ported. Svelte components, CSS,
   desktop stores and desktop dependencies are not copied into Android.
2. Reader preferences remain local to the mobile reader and are not written to
   Syncd, Epigraph Core or any synchronization outbox.
3. Readium owns EPUB resource loading and navigation. Android stores the full locator JSON and
   uses the private publication asset; the desktop DOM is not copied into the app.
4. Unsupported desktop-only behavior is documented as pending instead of being simulated: PDF
   canvas text selection remains a separate text/reflow surface, while Readium owns EPUB selection.

## Verification

- `:app:testDevDebugUnitTest`
- `:app:compileDevDebugKotlin`
- `:app:assembleDevDebug`
- API 36 emulator smoke: Books/Novels library, EPUB reader actions/settings,
  PDF reader actions/settings/reflow and no fatal exception in logcat.
