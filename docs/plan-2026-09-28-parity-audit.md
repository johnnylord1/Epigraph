# Plan: detail parity, downloads, migration, reader options, Settings (2026-09-28)

Scope requested: make the book and novel detail pages look like the manga detail page, audit the work and
chapter download flows, check migration and mass migration (and their modals), keep reader options per
reader (manga, novel, book), and map, test and polish every Settings tab. Everything is verified in a
disposable profile (`%TEMP%\ep-tour`) with a test build.

## 1. Detail pages (manga / novel / book)

All three already use `components/shared/SeriesDetailV3Shell.svelte`; the differences come from where
they are mounted and from what each page puts in the shell's snippets.

| Difference | Cause | Fix |
| --- | --- | --- |
| Novel detail has no app sidebar | `App.svelte` renders `NovelDetail` itself, outside `Layout` | Mount it from `Layout`'s detail layer like `SeriesDetail` and `BookDetail` |
| Novel has no topbar actions | No `topbarActions` snippet | Add open-in-browser (when the source gives a URL) and refresh-chapters |
| Chapter rows: novel/book show coloured "Atual / Com marcador / Não lidos" text tags | Different row markup | Use the manga row: secondary title, one neutral meta line (current/bookmark), the progress line |
| Status column differs | Novel/book show only a reading-state icon | Same three slots as manga: read check, main state, action |
| Book metrics say "Lidos" | Different metric | Chapters / Unread / Bookmarks, like the other two |

## 2. Download flows

- Manga: enqueue one / several / range / unread / all, delete one / all, Downloads page queue, pause/resume.
  Audit in the app with the disposable Suwayomi.
- Novel: the "Download" menu only exported an HTML file to the OS Downloads folder while showing
  "0 / N downloaded" and a disabled "Delete all downloads". The reader already caches chapters for offline
  reading (`lib/novels/offlineChapters.ts`). Make the menu save chapters to that offline cache, show real
  downloaded counts per chapter and in the metrics, allow deleting them, and keep HTML export as its own
  item. New Rust commands list and delete a novel's cached chapter files (hash-named, validated).
- Fix pluralisation in the menu ("5 novo", "109 restante").

## 3. Migration and mass migration

- Manga migrate modal: Escape does not close it; check each step (choose source, search, confirm).
- Novel migrate: the blocker tooltip is an untranslated English sentence.
- Mass migration (Explore → Sources → extension settings): capture, compare with the app's modal style,
  and fix what does not match.
- Redesign (follow-up request): the three migration modals share `src/components/pages/migrationModal.css`
  (`mg-` classes, first-run language: icon stepper, filled fields with an accent underline, quiet rows, one
  primary action). Fixed height with only the body scrolling. Manga: source filter and language picker,
  match percentage, compare cards and metrics. Novel: single/mass segmented control and mass review rows.
  Mass: grouped target sources, preview progress bar, compact queue rows with a check, status pill and menu.
  Unused migration tokens (and 19 Nocturne primitives only they consumed) were removed; the theme
  inventory tests were updated to the new exact counts.
- Motion and sizing (follow-up request): the modal height follows its content up to the old fixed height,
  gliding between sizes (`glideHeight` in `src/lib/motion/motion.ts`); each step and body view enters with
  a blur rise, rows and queue cards stagger in and slide to their new place when a filter changes them
  (`listFlip`), the mass action menu pops (and reserves room below a short queue so the dialog grows to
  show it), and check marks pop when selected. Reduced motion turns all of
  it off.
- Search: erasing the query in the page search bar used to close the palette and drop the dim, which then
  faded back in on the next keystroke. It now keeps the search engaged, like Escape does.
- Installing extensions failed with "Suwayomi unavailable" because the owner check read an empty command
  line; the check now refreshes the process command line it inspects.

## 4. Reader options per reader

Shared today: `readerBrightness` (all three), `proseReader*` (novel and book), `readerZoom` (manga and
book). Split into per-reader keys, seeded from the current values on first load so nobody loses a
setting: manga/novel/book brightness, novel/book prose settings, manga/book zoom. Settings → Reader gets
one section per reader. Keybinds and Discord stay app-wide.

## 5. Settings audit (13 tabs)

Findings from the screenshots in the disposable app:

- English strings: "6 entries saved…", "1 entries", "48 items", keybind action names, PDF fit "width".
- "Proxy MEIAS": SOCKS was translated literally.
- General: Discord options live under "Inicialização" and stay enabled when Discord is off.
- Performance: "Barra lateral compacta" sits under Diagnostics.
- Appearance: theme preview cards render blank.
- Security: FlareSolverr local/Docker, proxy, PIN, server auth — test each in the app.

Each option is exercised in the app; broken ones are fixed and the layout issues above are polished.

## Verification

Focused tests per change, full Vitest, svelte-check, cargo tests for the new commands, a test build and an
E2E pass in the disposable profile with screenshots.
