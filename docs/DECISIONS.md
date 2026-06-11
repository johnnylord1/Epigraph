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

## 2026-06-10 - Card overlay banner mockup exploration is initiated
- A visual proposal is created to add an overlay banner to cards displaying source language, downloaded chapters, and unread chapters.
- No code modification or implementation is performed, adhering to strict user constraints.
- Three variations (Reference replica, Glassmorphism/Frost, Minimalist with Icons) have been proposed in `banner_mockup_proposal.md`.
- Feedback loop refined the proposal: updated to use actual theme colors (Nocturne graphite and lavender) and showing the banner floating/overflowing outside the card boundaries, with separate isolated and on-card mockups.
- Second refinement loop: adapted the mockup to utilize the real card component structure of `LibraryCard.svelte` (2:3 aspect ratio, border-radius 16px, title/subtitle positioned beneath the cover wrap).
- Third refinement loop: adjusted the vertical position of the banner, shifting it higher so that the capsule pill sits almost entirely above the card's top edge, with only the bottom-most 20% overlapping the cover wrap, minimizing cover art obstruction and matching the reference.
- Fourth refinement loop: recreated the mockup using the exact card layout from the user screenshot (the manga card 'Dangerous Dungeon Escape', including the title and metadata formatting, the cover artwork, and the existing top-right 'CH 1' badge) to ensure a perfectly scaled, non-intrusive 20px capsule height that fits naturally and coexists with other overlay indicators.
- Fifth refinement loop: clarified that the new banner replaces the existing top-right badge (which is removed). Refined mockup scale to a micro-banner (height 14px, capsule width 32px, flag diameter 16px) to fit cleanly in a dense library grid context where cards are only 90-100px wide, avoiding visual clutter across a large catalog.

## 2026-06-10 - Card overlay banner implementation is finalized
- Extended `LibraryCardVM` in `contracts.ts` using the existing `sourceMetricBanner` property.
- Populated `sourceMetricBanner` in `buildComicsLibraryCardVm` (Comics) and `buildNovelLibraryCards` (Novels) with source language, downloaded count, and unread chapter counts.
- Updated `LibraryCard.svelte` template to display the new floating micro-banner (height 14px, width 42px) in grid views, and hide the old top-right badge if `sourceMetricBanner` is present.
- Built responsive sizing utilizing the shell's resolution variable `var(--n-hud-scale, 1)` to automatically scale all dimensions (margins, height, borders, font-size).
- Built theme-adaptive color styling using CSS custom properties (`var(--bg-subtle)`, `var(--text-primary)`, `var(--accent)`, `var(--bg-void)`) with a light-theme override utilizing `:global()`.
- Validated all Svelte component unit tests and production build.
- Fixed an overflow clipping issue: wrapped `cover-wrap` in a new `.card-cover-container` with `position: relative` and moved `.source-metric-banner` outside `.cover-wrap`. This bypasses `.cover-wrap`'s necessary `overflow: hidden` (which clips cover images to card border radius), allowing the banner to float and overflow freely as designed.

## 2026-06-10 - Card overlay banner proportions and flags refined
- Scaled up the micro-banner from 14px to a larger 22px height pill and 24px flag diameter to be proportional to the library cards.
- Fixed flag rendering on Windows: switched from native Unicode flag emojis (which render as text regional indicators like 'GB' or 'BR' on Windows) to a lightweight circular image overlay fetched from `flagcdn.com`, with a robust fallback to Svelte-rendered text/globe emojis for unrecognized/generic sources. Split regional subtags (e.g., pt-BR -> pt, en-US -> en) to ensure that regional source language codes correctly match their respective flags.
- Activated the source name fallback parameters inside the template so that sources missing a `lang` property but specifying `sourceName` (e.g., parenthetical '(EN)' or similar keywords) are correctly matched.
- Switched the unread count background from `--accent` to the app's neon purple CSS variables (`--n-primary-container`, falling back to `--accent-bright`) and corresponding high-contrast text (`--n-on-primary`, falling back to `var(--bg-void)`) for visual alignment with the Nocturne theme identity.

## 2026-06-10 - Card overlay banner dynamic scaling and backend bug bypass implemented
- Extended `Manga` model in `types.ts` to include `sourceId`.
- Updated `GET_LIBRARY` query in `queries.ts` to fetch `sourceId` on manga nodes.
- Updated `Library.svelte` to fetch the available sources list (`GET_SOURCES`) in parallel with the library nodes, storing the list in the component state.
- Updated card VM builder `buildComicsLibraryCardVm` to resolve null `source` relation by looking up the `sourceId` in the loaded sources list.
- Re-architected `.source-metric-banner` styling in `LibraryCard.svelte` using CSS Container Queries. Set `container-type: inline-size` on `.card-cover-container` and redefined all banner size dimensions (height, width, font-size, padding, margins, borders, clip-path) in container-query width (`cqw`) units. This ensures that the banner dynamically and linearly scales proportional to the card's width across all layout densities and window resizes.
- Implemented state-based rendering and layout adjustments on the banner:
  - *Unread-only*: Shows flag + neon purple pill (symmetrical paddings, clip-path disabled via `.pill-only`).
  - *Downloaded-only*: Shows flag + neutral pill (symmetrical paddings via `.pill-only`).
  - *Flag-only*: Shows only the language flag (pill hidden).
  - *No counts & No flag*: Banner is hidden completely.

## 2026-06-10 - Card overlay banner flag size, shape, and transition refinements
- Decreased the horizontal size of the flag (`width: 16cqw` vs original `18cqw`), maintaining the rounded left side pill shape (`border-top-left-radius: 9999px; border-bottom-left-radius: 9999px;`).
- Added a slanted diagonal `/` transition on the flag's right edge (`clip-path: polygon(0 0, 100% 0, calc(100% - 2cqw) 100%, 0 100%)`). This slant runs parallel to the `2cqw` diagonal transition between downloaded and unread counts.
- Flattened the left side of the metrics pill (`border-top-left-radius: 0; border-bottom-left-radius: 0;` via `.has-flag`) when the flag is present, preventing any rounded corners from peaking out.
- Kept the flag-only state fully rounded (`border-radius: 9999px; margin-right: 0; clip-path: none;` via `.flag-only`) when no counts are rendered.
- Scaled up the overall banner height from `12cqw` to `14cqw` to increase visibility.
- Mathematically aligned the visible widths of both chapter count sections to exactly `13cqw` each, ensuring they look identical in size on screen. To achieve this, the padding configurations account for both the 3.5cqw average flag overlap on the left and the 2cqw unread slant overlap on the right (`padding-left: 8.5cqw` / `padding-right: 7cqw` for downloaded with flag, and `padding-left: 6cqw` / `padding-right: 5cqw` for unread), resulting in perfect visual centering and identical spacing on both counts.

## 2026-06-10 - Card overlay banner style standardized and integrated into search recommendations
- Standardized the floating `.source-metric-banner` styling as a global theme standard in `src/styles/nocturne-port.css`.
- Replaced the text-based tracker score badges on search recommendation cards in `browse > search` with the floating overlay banner layout.
- Designed inline SVG icon flags for AniList, MyAnimeList, and Hardcover trackers to serve as the visual trigger on the left side of the banner, transitioning slantedly into the rating score pill on the right.
- Cleaned up obsolete helper functions like `recommendationBadge` and unused CSS selectors like `.searchTrackerBadge` from `BrowseV3.svelte`.
- Fixed layout clipping of absolute-positioned banners by removing `overflow: hidden` from the search recommendation `.n-library-card` buttons and adding responsive headroom (`padding-top: 12px`, `padding-left: 8px`) to `.searchRecommendationRow` to allow the banner to overflow outside card bounds cleanly.
- Switched the AniList icon to the official "AL" brand logo using separate multi-color paths (white A shape and `#02a9ff` blue L shape) over a dark `#0b1622` background.
- Resolved background color leaks around inline SVGs by removing hardcoded `<rect>` background layers from the SVGs and dynamically setting matching brand background colors on the `.source-metric-flag` wrapper element.
- Added an inline SVG golden star rating icon (`#ffb800`, sized `7.6cqw` matching the text size) next to the rating score inside the recommendation note pill.
- Aligned the rating score and golden star perfectly by wrapping the score in `.source-metric-score-val` (flex container) and using a `1.2cqw` gap for unified spacing and symmetry.
- Reduced the vertical height of both the flag and the pill to a slimmer `12cqw` baseline, adjusting overlaps, paddings, and font sizes to ensure perfect proportions.

## 2026-06-10 - Tracker rating banner flag size, icon scale, and transparency adjustments
- Expanded the width of `.source-metric-flag` from `16cqw` to `20cqw` and height from `12cqw` to `13cqw` to increase the size of the flag section in the pill, providing a roomy area for the tracker icons.
- Applied `box-sizing: border-box` and added custom padding (`1.5cqw 5cqw 1.5cqw 3cqw`) to center tracker SVG icons while keeping them at their original/large visual scale without clipping.
- Directed inline SVGs to use `object-fit: contain !important` to guarantee icons are never clipped or distorted by the slanted edge, while preserving `object-fit: cover` for country flags.
- Adjusted the left padding of `.source-metric-downloaded.has-flag` to `6.5cqw` to align with the new `-5cqw` flag overlap margin, preventing any text overlap.
- Increased the transparency of the frosted glass background to `0.65` in dark mode (`rgba(245, 243, 255, 0.65)`) and `0.75` in light mode (`rgba(15, 12, 30, 0.75)`) as requested.

## 2026-06-10 - Unified Capsule Reader HUD and Global Settings Sync
- Standardized all desktop readers (Manga, EPUB, PDF, Web Novel) to share a single base structure in `ReaderHud.svelte` featuring a bottom floating capsule bar (`#0d0d1b` background, `94%` opacity, `#393355` border) and centered metadata floating slightly above the capsule.
- Embedded reader-specific preferences within a Svelte-snippet floating popover card positioned above the capsule.
- Isolated reader styling entirely inside Svelte components instead of modifying the global `nocturne-port.css` stylesheet, avoiding global namespace pollution and improving style encapsulation.
- Synchronized all reader preferences (page style, reading direction, preloading, prose typography, custom palettes, and PDF settings) to be reactive with both the active popover controls and the global `Settings > Reader` view defaults.

## 2026-06-10 - Reader HUD mockup visual alignment and load stabilization
- Refined `ReaderHud.svelte` styling to match the mockup 1:1:
  - Root background set to a desaturated dark slate gradient (`#181824` to `#101016`) with a subtle radial lavender highlight (`rgba(143, 130, 230, 0.08)`).
  - Capsule bar background set to `#13131c` with a `#393355` border, and compacted to `width: min(480px, calc(100% - 32px))` to make it sleek.
  - Capsule buttons modified to use fully transparent backgrounds and borderless designs by default, showing soft background overlays (`rgba(255, 255, 255, 0.05)`) only on hover and active states.
- Restored and validated the full `ReaderHud` integration in `Reader.svelte` (Manga) after previous git checkout discards.
- Hardened manga loading by adding a 4-second timeout safeguard in `measureAspect` within `Reader.svelte` to resolve image aspect ratio checks and prevent layout freezes/infinite spinner hangs when Tauri HTTP fetches stall.

## 2026-06-10 - Reader HUD toolsOpen and auto-hide timer synchronized
- Integrated the internal `toolsOpen` state of `ReaderHud` as a Svelte 5 bindable prop to allow parent components (`Reader`, `BookReader`, `NovelReader`) to dynamically monitor its open state.
- Modified the parent auto-hide `showUi()` timer to immediately return and bypass HUD scheduling while the settings popover is open.
- Introduced a reactive `$effect` in parents to immediately reveal the HUD and clear any pending timers when the popover opens, and schedule standard auto-hide timers when it is closed. This prevents the settings popover from fading out and becoming unclickable during active user interaction.

## 2026-06-10 - Reader HUD panel backgrounds unified and contrast enhanced
- Refined the reader void background to a pure desaturated black/grey scale gradient (`#0a0a0c` to `#050506`, with radial highlight `rgba(255, 255, 255, 0.015)`) across Comics, Book, and Novel reader viewports to eliminate purple/violet tints.
- Unified the background and border styling for both the settings popover and the download modal to matching grey colors (`#242428` / `rgba(36, 36, 40, 0.96)` background, `#42424b` border) which are identical and slightly lighter than before.
- Enhanced the visual contrast of all interactive panel controls (segmented switches, action buttons, dropdown selects, page steppers, and list options) in relation to the panels and HUD by applying distinct borders (`rgba(255, 255, 255, 0.18)`) and backgrounds (`rgba(255, 255, 255, 0.08)` or `rgba(0, 0, 0, 0.24)` / active `rgba(143, 130, 230, 0.35)`) to clearly separate them.
- Restyled the download manager modal in `Reader.svelte` to match the exact compact button dimensions, border-radii (`8px`), padding, and smaller font parameters of the settings popover, replacing the large light buttons with clean dark contrast cards (`rgba(0, 0, 0, 0.2)`) and matching borders.

## 2026-06-11 - Robust source flag image loading fallback implemented
- Implemented image load error (`onerror`) handling on the source language flag `<img>` inside `LibraryCard.svelte`.
- If the flag image fails to load (due to lack of internet connection, offline development, or domain blocking), Svelte immediately catches the error, updates local component state, and gracefully falls back to displaying the native Unicode text/emoji flag (`getLanguageFlag`).
- On Windows systems, this gracefully displays the fallback text regional indicators (like "BR", "PT", "GB") instead of rendering a broken image icon with raw alt text like "PO", ensuring visual integrity and clean rendering under any network conditions.
