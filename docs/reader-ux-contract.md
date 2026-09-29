# Reader UX Contract

## Summary

Epigraph will expose one shared reader product surface for:
- plugin-based novel text
- EPUB
- PDF

The UX contract is shared.
The rendering engines and content adapters remain separate.

This document freezes what "shared reader" means in Epigraph and what it does not mean.

## Shared shell

The shared reader shell grows from the existing reader chrome in:
- [ReaderHud.svelte](../src/components/reader/ReaderHud.svelte)
- [BookReader.svelte](../src/components/reader/BookReader.svelte)

The shell owns:
- top bar
- bottom bar
- settings drawer
- immersive mode
- progress display
- navigation shell
- bookmarks and history shell

The shell does not own:
- plugin execution
- EPUB parsing internals
- PDF rendering internals

## Preference groups

### Universal

- theme or palette
- immersive mode
- progress indicator
- UI chrome visibility
- reading direction where applicable
- chapter or section navigation UI
- bookmarks and history shell

### Text reflow only

Applies to:
- plugin novel text
- EPUB

Settings:
- font family
- font size
- line height
- text align
- paragraph spacing
- horizontal padding

### PDF only

Settings:
- zoom
- page fit mode
- thumbnails or bookmarks panel
- continuous page scroll vs paged mode where supported

## Capability model

Each reader adapter must declare capabilities explicitly.

Unsupported settings must be:
- hidden
- or disabled with clear reasoning

The UI must never fake parity by showing a setting the current adapter cannot honor.

## Adapter rules

### NovelHtmlAdapter

- consumes chapter HTML or text from the novels plugin runtime
- sanitizes and normalizes content
- tracks chapter-based progress
- tracks chapter-based bookmarks

### EpubAdapter

- consumes EPUB structure and content
- preserves precise EPUB progress
- reuses shared text-reflow preferences where compatible

### PdfAdapter

- consumes PDF pages and page model
- preserves page-based progress
- maps only universal and PDF-specific controls

## Hard rules

- plugin novels must not be forced through the EPUB parser pipeline
- PDF must not be collapsed into a fake text reader just to share code
- one shell may serve many adapters, but each adapter keeps its own content semantics

## Persistence rules

Reader preference persistence must separate:
- universal preferences
- text-reflow preferences
- PDF preferences

Capability selection happens at runtime per adapter.

## Current status

Reviewed on `2026-07-28`.

- Novel prose, EPUB, PDF, and manga keep separate rendering and progress
  semantics behind the current reader surfaces.
- Universal, reflow, and PDF-specific preferences are persisted separately;
  unsupported controls remain capability-dependent.
- Import/restart, progress, bookmark, backup/restore, offline, viewport, and
  token contracts have deterministic coverage.
- Accessible manga/fullscreen with a real catalog and a manual screen-reader
  audit remain conditional validations.
- Manga, novel and book readers can run in detached windows (2026-09-27). A
  detached window keeps the same shell, preferences, keyboard commands and
  progress semantics; the main window stays the only persister. See the
  [audit notes](audit-2026-09-26.md#detached-reader-windows-2026-09-27).

The target is parity of UX contract, not foreign implementation coupling.
