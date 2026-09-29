# Changelog

All notable user-facing changes to Epigraph are documented here.

## [Unreleased]

### Added

- The manga, novel and book readers can open in their own window from the reader bar, so the app stays usable while reading and several chapters, of the same work or different ones, can be open at once.
- Books can be imported from a file picker in the books library toolbar, in addition to drag and drop.
- Reader windows open on the monitor that shows the main window.
- Novel chapters can be downloaded for offline reading from the novel page, with real downloaded counts and a way to delete them; HTML export is its own menu item.
- Manga, novel and book readers keep their own brightness, zoom and text settings, and Settings → Reader has a section for each.

### Changed

- The manga, novel and mass migration windows were redesigned to match the first-run screens: a step bar with icons, a filter and language picker for sources, a match percentage for each result, a side-by-side comparison before moving, and one main action in the footer.
- Migration windows grow and shrink smoothly with their content, and steps, rows and cards animate in and move into place when a filter changes the list.

### Fixed

- Arrow keys, fullscreen and the other manga reader shortcuts work again after clicking the page.
- A novel chapter can be scrolled with Page Down, the arrow keys and Space as soon as it opens, in the main window or its own window.
- Space scrolls a long-strip manga chapter without also showing or hiding the reader bar.
- Reopening an EPUB, or moving it to its own window, no longer goes back a page each time.
- Sync no longer misses changes made between reconnecting and resuming the live stream, or chapter progress mirrored from Suwayomi.
- Editing books in a second local profile no longer overwrites the main profile's book library.
- Pairing sessions, exports and novel classification state are saved atomically, so an interrupted write cannot erase them.
- Waiting for the Suwayomi runtime now times out and retries instead of hanging on an unresponsive server.
- Changes made while the sync Core is unreachable or the session has expired are kept and sent once it answers again, instead of being dropped.
- Erasing the text in a page search bar no longer makes the background dim flash out and back in.
- Installing an extension no longer fails with "Suwayomi unavailable" when the app manages its own server.
- A stopped sync Core is shown as offline instead of degraded, and a paired computer's other addresses are tried when one refuses the connection.
- Concurrent sync writes wait for each other instead of failing with "database is locked".
- Sync certificates, Core runtime state and sync state are saved correctly in folders with paths longer than 260 characters.
- Profiles are shown as Default, Test or Custom instead of internal names, and the Japanese and Chinese profile wording is consistent.
- Restore summaries, restore notices and extension compatibility stages follow the app language.
- Novel and book pages match the manga page: the novel page keeps the app sidebar and has the same top actions, chapter rows, status column and metrics.
- Migration windows cannot be closed while a migration is running, and the manga migration window closes with Escape otherwise.
- Discord options are grouped under the Discord switch and disabled while it is off.
- Turning FlareSolverr on or off from the Security list is saved right away and undone if the server refuses it.
- The PIN lock explains when it is on but has no PIN yet.
- Settings rows that did nothing were removed, and counts and keybind names are translated.

### Security

- Removing a device or one of its sync scopes now stops its open live stream immediately.
- Novel source plugins and external login or reader pages can no longer call desktop application commands.
- A tracker login started in Settings can only be completed by the login window it opened.
- Removed an unused command that could write a file into Downloads.

## [0.0.1] - 2026-08-30

### Added

- Desktop library for comics, novels, EPUB and PDF content.
- Managed source and extension browsing backed by Suwayomi.
- Syncd desktop pairing with localized connection status and device context.
- Discord Rich Presence with privacy controls for titles, covers and reading progress.
- Built-in Nocturne, AMOLED, Dark, Midnight, Light, Warm and high-contrast themes, plus custom theme persistence.

### Changed

- Redesigned source browsing, extension details, pairing, toast and status surfaces around the shared theme tokens.
- Standardized typography, alignment, feedback icons and notification sizing across the desktop interface.
- Completed translations for English, Brazilian Portuguese, Spanish, Japanese and Simplified Chinese.

### Fixed

- Rich Presence now reconnects after Discord restarts and retries activity updates without overriding an active reader session.
- Source and repository counts now reflect runtime state instead of stale recommendation totals.
- Extension installation, APK selection, migration and update controls follow the active theme and preserve readable interaction states.
- Syncd startup, pairing and replication recover safely across daemon restarts.
- Release certification now waits for source indexing to converge before comparing workflow identity.

### Security

- Rotated the updater signing identity before publication.
- Audited the repository and release diff for embedded credentials and sensitive files.
