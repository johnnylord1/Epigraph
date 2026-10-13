# Changelog

All notable user-facing changes to Epigraph are documented here.

## [Unreleased]

## [0.0.6] - 2026-10-12

### Changed

- Discover recommendations follow the library: rows are ordered by the reader's profile and ratings, keep the share of manga, manhwa and manhua the library has, and fill "outside your usual reads" with the genres read least.
- Recommendation rows are fed from the installed sources' genre lists and keep loading more titles while scrolling.
- Library works are recognised on AniList, Kitsu and Hardcover in the background, with a progress notice, also when a novel is listed under a translated title or only its author matches. Only certain matches are used, and the author and studio count as evidence.
- Novels are recommended from Kitsu without a tracker account and ranked exactly like comics; tracked novels and book genres shape them, and novel sources are searched for the reader's genres.
- Switching pages, and between Comics and Books in the Library, fades the old view out over the new one instead of fading through the background. The Comics/Books switch and the sidebar answer on press.
- App buttons no longer lean toward the cursor.

### Fixed

- Opening a novel recommended only by Kitsu finds it through a title search.
- The library analysis no longer comes back stuck at the same count.
- Slow Jikan answers no longer delay Search.
- Page switches no longer stall on Home, Library and Explore, the Library hero is no longer blank, and the sidebar no longer highlights two destinations.

## [0.0.5] - 2026-10-10

### Changed

- The release history in Settings → About lists only the Windows changes.

### Fixed

- Buttons in the Library no longer stop responding after switching pages. The window is still moved from the empty part of the top bar, and a double click there maximizes it.
- Library covers keep their size when the page opens instead of growing into place.
- A mouse click on a library card right after opening it with Enter is no longer ignored.
- Opening an EPUB saves the position once, instead of several times while the book is laid out.

## [0.0.4] - 2026-10-10

### Changed

- Development builds show "DEV" in the window title and a badge in the corner, so they are never mistaken for the installed app.

### Fixed

- The "Because you like" and "Near your taste" rows on Discover fill in for readers of novels, whose sources list titles without genres, and novel details are given enough time to load their tags.
- A book changed on the phone is no longer reverted by the desktop when the desktop saves its books right before reloading them.
- Books no longer sync again every few seconds while the app is in use when nothing about them changed.
- Books imported or read on the desktop while a sync download is running are no longer lost when the download finishes.

## [0.0.3] - 2026-10-09

### Fixed

- Reading progress synced from the phone shows up on the desktop right away, also when it arrives while Home is open.
- Picking a chapter from a book's contents opens that chapter, even when a more precise position was saved further ahead.
- Book progress counts only the chapters behind the current one as read, and synced EPUBs list their chapters again.
- The PDF reader no longer draws two pages over each other when pages are turned quickly.
- Books synced from the Core keep their ISBNs, genres and metadata, so they are not reprocessed and synced again on every start.
- A finished manga chapter opens from the first page, like Mihon.
- Genre chips and tags from sources appear in the app language, and the novel reader text alignment is translated.
- The reading week on Home and in History counts chapters and minutes from the whole history.
- The app starts in the saved language without flashing English first.
- Replacing a data file on Windows retries briefly when an antivirus or another write still holds it.
- Pairing a phone no longer expires while it is still downloading a large library.

## [0.0.2] - 2026-10-09

### Added

- The manga, novel and book readers can open in their own window from the reader bar, so the app stays usable while reading and several chapters, of the same work or different ones, can be open at once.
- Books can be imported from a file picker in the books library toolbar, in addition to drag and drop.
- Reader windows open on the monitor that shows the main window, or at the size and position the last one was left at.
- FlareSolverr can be started from a novel reader window when its source asks for it.
- Novel chapters can be downloaded for offline reading from the novel page, with real downloaded counts and a way to delete them; HTML export is its own menu item.
- Manga, novel and book readers keep their own brightness, zoom and text settings, and Settings → Reader has a section for each.
- An imported book can be continued as a novel: its page has a "To novel" action that finds it in a novel source, adds the novel to the library and resumes at the chapter that matches the book position, while the book stays in the library.

### Changed

- Development builds keep their data, browser profile and sync Core apart from an installed release, and the sync Core no longer uses a Suwayomi server that belongs to another data folder.
- The manga, novel and mass migration windows were redesigned to match the first-run screens: a step bar with icons, a filter and language picker for sources, a match percentage for each result, a side-by-side comparison before moving, and one main action in the footer.
- Migration windows grow and shrink smoothly with their content, and steps, rows and cards animate in and move into place when a filter changes the list.
- The mass migration cards no longer sit inside a tinted strip, and their three-dot menu floats over the window instead of making it taller.
- The sync panel in Settings follows the layout of the other windows, without boxed sections or pills.
- Bookmarked chapters on manga, novel and book pages show only a bookmark icon next to the chapter title.
- Home sizes "Continue reading" to the titles in progress, shows real read counts and progress, lists each title once in recent updates with how many more chapters were read, links to all sources and offers to connect a tracker instead of listing every disconnected one.
- A library search or filter that matches nothing says so and offers to clear it, and books show "In progress" or "Not started" instead of "Completed" while unread.

### Fixed

- The PDF reader and the translations for languages not in use are no longer loaded while the app starts.
- Arrow keys, fullscreen and the other manga reader shortcuts work again after clicking the page.
- A novel chapter can be scrolled with Page Down, the arrow keys and Space as soon as it opens, in the main window or its own window.
- Space scrolls a long-strip manga chapter without also showing or hiding the reader bar.
- Entering or leaving fullscreen, or resizing the window, keeps a long-strip manga chapter on the same page, and the page counter stays right.
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
