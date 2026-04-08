# Decisions

## 2026-04-06 - Shared Library shell remains callback-driven and store-free
- `LibraryShell`, `LibraryHeader`, `LibraryCollectionsBar`, `LibraryToolbar`, `LibraryCardGrid`, and `LibraryCard` are shared structural primitives only.
- Shared shell components do not import the Library store directly.
- New shared components use explicit callback props instead of introducing new custom dispatcher patterns.

## 2026-04-06 - Shared card activation is button-based and keyboard-explicit
- The shared card surface is an explicit button target.
- Card open must work via click, Enter, and Space.
- Keyboard activation is handled in the shared card layer while domain actions remain in Comics and Books bodies.

## 2026-04-06 - Books UI state persists under a dedicated settings subtree
- Books Library UI state lives under `settings.booksLibraryUi`.
- Books categories use separate persisted state:
  - `settings.booksCategories`
  - `settings.booksCategoryAssignments`
- Comics and Books do not share live category persistence.

## 2026-04-06 - Library orchestration is centralized and the old Books shelf is retired
- `src/components/pages/Library.svelte` orchestrates shared shell + domain bodies instead of rendering the old monolithic inline layout.
- `src/components/library/ComicsLibraryBody.svelte` owns Comics-specific interactions.
- `src/components/library/BooksLibraryBody.svelte` owns Books-specific interactions.
- The legacy `src/components/books/BookShelf.svelte` is retired from the active path.

## 2026-04-07 - Authenticated media keeps one plain URL path and one explicit auth path
- `thumbUrl(path)` remains the canonical plain media URL helper.
- Authenticated media is resolved only through `src/lib/imageCache.ts`.
- The auth-on path uses `@tauri-apps/plugin-http` plus blob URLs and inflight dedupe.
- Credentials must never be embedded in media URLs.

## 2026-04-07 - Splash startup mounts the shell behind the overlay
- The app shell mounts before the startup splash finishes exiting.
- Splash background assets are built through a deferred/cached renderer path.
- The logical stamp-size fix stays in place to avoid the old DPI explosion bug.

## 2026-04-07 - Suwayomi WebView is preferred over Aethon WebView for source challenge flows
- Source-challenge / site-login flows should use the Suwayomi WebView route so cookies land in the Suwayomi cookie jar.
- Reader retry after closing that WebView is part of the desktop flow.
- Attempts to aggressively restyle/clean the Suwayomi WebView wrapper from Aethon were reverted because they made interaction fragile.

## 2026-04-07 - FlareSolverr stays external or locally managed, not bundled
- The current supported path is external/local FlareSolverr, configured from Aethon and consumed by Suwayomi.
- Local process management from Aethon is allowed.
- Docker-managed FlareSolverr is optional and secondary.
- Bundling FlareSolverr directly into Aethon is explicitly deferred.

## 2026-04-07 - Cloudflare download validation is closed against the main 4667 flow
- Real source downloads must be validated on the main `4667` server, not only inferred from config or sidecar code paths.
- The validated regression case is `Manganato (EN)` / `+99 Reinforced Wooden Stick` (`mangaId: 145`).
- A dedicated monitor 3 app instance (`target-monitor3-audit`, profile `MON3AUDIT`) is the preferred runtime audit harness so user-facing windows and other agents are not disturbed.
- The compact FlareSolverr panel now supports local `Start`, `Stop`, `Start on app launch`, `Open folder`, and `View logs`.

## 2026-04-07 - Parallel sync research remains out of the runtime merge target
- Parallel agent work around sync / Suwayomi backend architecture is treated as research only for now.
- No runtime/server implementation should claim that track is merged until it lands as concrete repo changes.

## 2026-04-07 - Local server ownership is Java-owned, atomically published, and audit targets are attach-only
- The local server owner record is `server.owner.json`, written atomically through a temp file + replace.
- A local server is reusable only when all of these are true:
  - the expected Java process is still alive
  - that Java process still carries the expected `rootDir`
  - the expected local port answers a short probe
- Malformed or partial owner files are treated as stale and removed before reuse/spawn decisions.
- Audit/sidecar targets are attach-only by code and must never call the local spawn path.
- Closing normal or audit app windows must not kill the local Suwayomi server automatically.

## 2026-04-07 - Profile selection is next-launch only and override sessions stay session-local
- The user-facing concept is `Profile`, backed by the built-in local profiles `TEST` and `MAIN`.
- The persisted selector key is `settings.defaultLocalProfileId`.
- Explicit launch overrides such as `--main`, `--test`, attach-only, and audit targets affect only the current session.
- Launch overrides must never rewrite the persisted default profile.
- Settings must show all three of these separately when relevant:
  - current runtime profile
  - whether the current session is override-driven
  - the persisted next-launch default profile
- The first shipped profile-selection flow is intentionally restart-based:
  - user picks the next-launch default in Settings
  - current session remains on its current server/profile
  - next normal app start resolves the selected profile
- Healthy-but-empty profiles are a valid success state and must not be rendered as startup failure.

## 2026-04-08 - Cross-chat closure is tracked by repo state, not by thread boundaries
- We treat a workstream as closed only when the repo, tests, runtime audit, and docs all agree.
- Parallel or separate chat threads do not create separate truth sources; the repo-level docs are the consolidation layer.
- The currently closed desktop streams are:
  - shared Library shell / shared Settings structure
  - Books reader/runtime stabilization
  - splash stabilization
  - authenticated media loading
  - scanlator preference flow
  - FlareSolverr local management + validated Cloudflare download path
  - local server ownership/profile hardening
  - next-launch-only built-in profile selection

## 2026-04-08 - Books reader/runtime stabilization is closed unless new evidence appears
- `BookReader` and `BookDetail` share the same Books runtime contract for local EPUB/PDF reading.
- The hardened `book` protocol path is the supported runtime path for Books assets.
- EPUB startup must stay non-blocking with `locations.generate(...)` running after initial display.
- EPUB saved progress follows a strict precedence rule:
  - precise location state is stronger than fallback section state
  - weaker fallback state must never overwrite stronger precise state during normal use
- Persisted state shown in `BookDetail` must stay consistent with the best state written by `BookReader`.
- Remaining very-large-EPUB progress-label roughness is non-blocking polish only and does not reopen the stabilization track.
