# Status

## Current Phase
- Shared Library shell and shared Library/Settings infrastructure: active path and effectively complete
- Books reader/runtime stabilization: complete and merge-ready
- Splash stabilization: complete
- Authenticated media path (`imageCache` + plugin HTTP + blob URL): complete and audited
- Reader scanlator preferences + Suwayomi WebView retry path: implemented
- FlareSolverr external assist + local process management + app-launch autostart: implemented and validated on the main `4667` flow
- Local Suwayomi spawn/ownership hardening: implemented on the active `TEST :4667` path and runtime-audited
- Local profile selection (`TEST` / `MAIN`) with next-launch semantics: implemented and runtime-audited
- Syncd desktop-to-desktop pairing and reconnect flow: complete, including native automated proof

## Cross-Chat Consolidated Snapshot
- Closed and aligned across the current desktop milestone:
  - shared Library shell + shared Library/Settings structure
  - Books reader/runtime stabilization
  - splash startup stabilization
  - authenticated media loading path
  - reader scanlator preference flow
  - Suwayomi WebView retry path
  - FlareSolverr local/external assist plus local process controls
  - local server ownership hardening and profile isolation
  - next-launch `Profile` selection for built-in `TEST` / `MAIN`
  - syncd desktop integration:
    - discovery
    - bootstrap
    - live pairing
    - local-only host approval/rejection
    - approved-session persistence
    - reconnect/revalidation
    - desktop QR render/save/import/decode
    - native two-instance automation proof
- Still intentionally open:
  - sandboxed recovery of the pre-corruption library data
  - optional FlareSolverr install/update UX
  - future product work that builds on top of the closed sync foundation

## Milestone Status
- **Splash Screen Port (`SplashScreen.svelte`)**: COMPLETED. Full Nocturne aesthetics and state machine restored. Tests pass.
- **Settings Screen Shell (`Settings.svelte`)**: COMPLETED. Global `n-shell`, topbar, sidebar, and Svelte component `<style>` block correctly implement Nocturne tokens.
- **Settings Screen Panes**: COMPLETED. Mapped all DOM structures and categories to modern Nocturne layout.
- **Theme Editor Color Picker Patch**: COMPLETED. Embedded transparent native color selector pickers inside visual color swatches for both token colors and HUD colors in `ThemeEditor.svelte`, ensuring picking colors visually updates the swatch background and hex text inputs reactively in real-time.
- **Card/Thumbnail Information Overlay Banner**: COMPLETED. Consolidated overlay banner implemented in Svelte/CSS, fully responsive and dynamically adaptive to all themes. Updated to use CSS Container Queries (`cqw` units) so the banner dimensions scale dynamically relative to the card size. Resolved the resolver relation bug of Suwayomi by fetching the active sources list in parallel and resolving `sourceId` on the frontend layer. Refined the horizontal width of the flag (`width: 20cqw` and `height: 13cqw`), added a slanted diagonal `/` right-edge transition parallel to the unread count transition, flattened the left side of the pill when the flag is present, rounded both sides of the flag in flag-only state, mathematically aligned the visible widths of the downloaded and unread counts, and visually centered the count numbers perfectly inside them. Standardized overlay banner CSS rules globally in `nocturne-port.css` and replaced search recommendation text badges with the new floating banner layout showing tracker logo flag icons (AniList, MyAnimeList, Hardcover, Kitsu, MangaUpdates, Bangumi) and ratings. Resolved banner clipping on the search page by removing `overflow: hidden` from the search recommendation `.n-library-card` button and adding responsive headroom padding-top (`12px`) and padding-left (`8px`) to `.searchRecommendationRow`. Polished flag proportions and tracker icon sizes: expanded the flag section size to `20cqw` width and `13cqw` height, adding custom paddings to keep tracker icons at full scale without clipping, and forcing `object-fit: contain` on SVG tracker logos while keeping `object-fit: cover` for flagcdn country images. Increased frosted glass transparency (`0.65` opacity in dark mode, `0.75` in light mode) for improved aesthetics. Unit tests and production build validated successfully, and resolved flag display on Windows by adding an `onerror` fallback that replaces broken images with native text flags/emojis. Fixed a spacing overlap bug in the Library and filtered search views where flags would overlap the unread count when downloaded chapters were 0 by updating the left padding of the sole-pill unread badge to `8.5cqw` to align properly with container query measurements. Also resolved banner clipping issues on Library cards by removing `content-visibility: auto` and `contain-intrinsic-size` from `.card.n-library-card` in `LibraryCard.svelte` to prevent layout and paint containment from clipping the absolute positioned overhanging status banners.
- **Unified Capsule Reader & Settings Sync**: COMPLETED. Refactored all reader screens (Manga/Comic, EPUB/PDF, Web Novel) to share a bottom floating capsule pill bar and centered settings popover layout matching mockup. Mapped all reader configuration options to Svelte reactive bindings, added hex swatches, and synced all defaults in Settings > Reader tab. Refined backgrounds to a pure desaturated black/grey scale void gradient (`#0a0a0c` to `#050506`) with a very subtle radial highlight (`rgba(255, 255, 255, 0.015)`). Unified Settings popover and download modal backgrounds to identical, slightly lighter grey colors (`#242428` / `rgba(36, 36, 40, 0.96)`) with matching borders (`#42424b`). Enhanced the visual contrast of all interactive panel controls (buttons, selectors, dropdowns, switches, and page steppers) by giving them distinct borders (`rgba(255, 255, 255, 0.18)`) and backgrounds (`rgba(255, 255, 255, 0.08)`) to clearly separate them from the panel backgrounds. Restyled the download manager modal (`Reader.svelte`) to match the exact compact button dimensions, border-radii (`8px`), padding, and font sizes of the settings popover, replacing the large light buttons with clean dark contrast cards (`rgba(0, 0, 0, 0.2)`) and matching borders. Hardened manga page loading by introducing a 4-second timeout safeguard inside `measureAspect` in `Reader.svelte` to prevent layout freezes/infinite spinner hangs when media fetches stall. Bound settingsPopover toolsOpen state dynamically to avoid autohide conflicts on all readers, resolving the unclickable popover controls bug in the dev application. Verified clean production build and 339 passing unit tests. Compacted the settings popover to a subtle `300px` width, simplified labels to normal case, and softened font-weight to `500` (Medium). Replaced neon active toggle styling with desaturated white translucent accents. Resolved authenticated book/chapter fetch failures on Suwayomi instances by propagating authentication headers to the `epubjs` and `pdfjs` loaders. Increased the default `fetchWithTimeout` safeguard to `60s` in `src/lib/imageCache.ts` to prevent premature aborts during large book file downloads. Repositioned the popover above the capsule bar by increasing bottom offset to `76px` (leaving a clean `8px` gap). Softened the popover background to standard Nocturne graphite (`rgba(26, 26, 30, 0.97)`), made the outer border desaturated (`rgba(255, 255, 255, 0.05)`), and made the inner dividers (`rgba(255, 255, 255, 0.025)`) and control borders (`rgba(255, 255, 255, 0.05)`) extremely faint. Aligned settings popover horizontally to open to the right of the settings button on widescreen desktop viewports (`min-width: 1120px`, using `left: calc(50% + 290px)`) and to the right edge of the screen on mobile/narrow viewports (`right: 16px`), keeping centered metadata (title/chapter label) fully visible. Unified bottom capsule bar background to match the popover panels' graphite theme (`rgba(26, 26, 30, 0.97)`), softened its border to `1px solid rgba(255, 255, 255, 0.05)`, and expanded its size (width to `min(680px, calc(100% - 32px))`, height to `52px`, button size to `36px`, and progress label font size to `11px` with `50px` min-width). Added a global, persisted brightness control (`readerBrightness` from 20% to 100%) applied via CSS filter to the reader viewports while maintaining HUD overlay controls at full brightness for optimal accessibility. Integrated a draggable range input slider inside the bottom capsule bar for quick brightness adjustments. Symmetrically rearranged capsule controls, keeping disabled buttons visible (dimming opacity to 0.35). Combined width stepper and full width toggle into one row in Book and Novel settings, extending maximum content width limit to `1600px`. Added slate, forest, nord, and warm theme presets and imported EB Garamond, Lora, and Literata serif typefaces for novels/books.
- **Taste Insights Modal & Recommendation Analytics (`TasteInsightsModal.svelte` / `BrowseV3.svelte`)**: COMPLETED. Mapped a high-fidelity interactive taste profile analytics dashboard overlay. Calculates tag/genre affinities dynamically (supporting positive preference gauges and negative avoidance signals), content format preferences match percentages, average scoring factors (personal affinity, consensus score, trending velocity, and novelty), and available extensions coverage with direct navigation actions. Fully integrated into `BrowseV3.svelte` and bound to the `View full insights` recommendation sidebar button. Aggregates all library entries (mangas, novels, books) unconditionally to render unified profile analytics. Applies hybrid classification (dedicated manhwa/manhua sources mapped directly; general aggregators resolved strictly by work properties like title, description, and genres). Synchronized all card covers inside `BrowseV3.svelte` to match the redesigned `.source-metric-banner` badge layout. Verified with passing tests and successful production build compile.



## Current Blockers
- Download UX is cleaner, but source-side failures can still happen independently of Aethon
- The current FlareSolverr block does not yet include a full in-app install/update pipeline
- Recovery of the pre-corruption library data is still pending and remains deliberately separate from runtime hardening
- Books reader/runtime has no current merge blocker; the remaining very-large-EPUB progress-label roughness is polish only

## Latest Validation Snapshot
- Passed recently:
  - `npm run test:unit`
  - `npm run test:browser`
  - `npm run build`
  - `cargo build --manifest-path src-tauri\\Cargo.toml --target-dir src-tauri\\target-user-test`
- Runtime audits completed for:
  - Books reader/runtime stabilization:
    - shared Books runtime contract between `BookReader` and `BookDetail`
    - hardened `book` protocol path remains healthy for EPUB and PDF
    - EPUB no longer blocks initial load on `locations.generate(...)`
    - precise-vs-fallback progress precedence validated
    - reopen/restart/hydration behavior validated
    - `BookReader -> BookDetail` persisted-state consistency validated
    - no blocking UX confusion remained after staged EPUB readiness audits
  - startup splash stability and exit sequencing
  - authenticated cover/page loading with Basic Auth enabled on a sidecar server
  - scanlator preference flow in `SeriesDetail`
  - FlareSolverr local `Start` / `Stop` / `Start on app launch`
  - real Cloudflare-protected download on `4667` with local FlareSolverr enabled
  - local server ownership hardening on `TEST :4667`:
    - atomic owner publish
    - malformed/partial owner cleanup
    - attach-only audit targets do not spawn
    - reuse requires live Java + matching rootDir + healthy probe
    - closing audit windows no longer kills the local server
  - local profile selection runtime:
    - canonical built-in local profiles: `TEST :4667` and `MAIN :4567`
    - persisted default profile is separate from session-only launch overrides
    - Settings shows:
      - current session profile
      - whether the session is override-driven
      - next-launch default profile
    - clean `--main` override session kept `Next launch default: TEST`
    - next normal launch returned to `TEST :4667`
    - clean `MAIN :4567` boot showed a healthy empty-profile success state instead of a startup failure
    - final monitor 3 audit with a clean temporary WebView profile confirmed:
      - `Current session: MAIN (launch override)`
      - `Next launch default: TEST`
      - restart-based profile selection is behaving as designed
- Dedicated monitor 3 audit harness:
  - dedicated binary target: `src-tauri\\target-monitor3-audit`
  - dedicated profile label: `MON3AUDIT`
  - visual evidence captured from a separate app instance, not the main user window
- Real Cloudflare validation case:
  - source: `Manganato (EN)`
  - manga: `+99 Reinforced Wooden Stick` (`mangaId: 145`)
  - validated downloads:
    - `Chapter 188` (`236832`)
    - `Chapter 189` (`236833`)
    - `Chapter 187` (`236831`)
    - `Chapter 186` (`236830`)
  - all completed with `isDownloaded = true` on the main `4667` server after FlareSolverr was enabled
- Current local runtime baseline:
  - main test server: `http://127.0.0.1:4667`
  - local FlareSolverr: `http://localhost:8191`
- Current ownership baseline:
  - `server.owner.json` now tracks the Java owner for the local profile instead of treating the app PID as the source of truth
  - audit/sidecar targets must attach to an existing server and do not auto-start one
- Current profile-selection baseline:
  - persisted selector key: `settings.defaultLocalProfileId`
  - runtime-only metadata distinguishes:
    - resolved current profile
    - session override state
    - next-launch default profile
- Current Books-reader closure baseline:
  - fresh final audit evidence lives under `tmp/`:
    - `final-epub-open-smoke.log`
    - `final-epub-reopen-before-ready.log`
    - `final-epub-precise-restart.log`
    - `final-detail-reader-detail.log`
    - `final-pdf-open-resume.log`
  - remaining roughness is limited to non-blocking progress-label polish on very large EPUBs
- Syncd closure baseline:
  - discovery stack closed
  - advertised/effective origin resolution closed
  - mDNS provider closed
  - manual origin fallback closed
  - bootstrap session flow closed
  - live pairing status flow closed
  - local-only host approval/rejection route closed
  - desktop-owned sync client in `src-tauri` closed
  - Settings > Security host/connect UI closed
  - approved-session local persistence closed
  - reconnect/revalidation on restart closed
  - desktop QR render/save/import/decode closed
  - native two-instance automation closed with six passing scenarios
  - no further syncd backend surface should be added unless a reproduced product bug proves a real missing backend step

## Parallel Agent Notes
- I did not find separate repo artifacts or standalone code/doc commits attributable to other subagents in the workspace
- Historical parallel-agent sync research is now superseded by the closed syncd implementation and native proof

## 2026-06-11 Runtime Performance Baseline
- Dev desktop measurement after the stabilization/refactor pass:
  - total Aethon working set: ~1.37 GB
  - Java/Suwayomi working set: ~559 MB with `-Xms96m -Xmx320m -XX:+UseG1GC`
  - WebView renderer working set: ~336 MB
  - WebView GPU process working set: ~257 MB
  - Rust shell working set: ~43 MB
- Idle CPU over a 60s sample is low:
  - total: ~0.4% of one core
  - Java/Suwayomi: ~0.3% of one core
  - WebView browser: ~0.1% of one core
- Frontend heap after explicit Chromium GC:
  - used JS heap: ~80 MB
  - DOM elements: ~298
  - running animations: 0
  - image cache entries: 0
- Conclusion:
  - current high RAM in dev is not primarily live JavaScript object retention
  - remaining large buckets are native Java/Suwayomi, WebView renderer, and WebView GPU memory
  - next aggressive reductions should be measured in release before changing GPU flags or server lifecycle defaults

## 2026-06-11 Stabilization Final Audit
- Automated verification:
  - `npm run test:unit`: 69 files passed, 334 tests passed
  - `npm run test:browser`: 5 files passed, 14 tests passed
  - `npm run build`: passed
- Desktop dev smoke after restart:
  - Home, Library, Browse, Downloads, Settings, Recent Activity, and Library return navigation all changed on the first click
  - Library rendered 48 visible cards and 96 images in the tested viewport with 0 broken images
  - Manga Reader opened from Home resume/detail flow, loaded 32 images, and exited cleanly with Escape
  - BookReader opened from Home resume after a dev-server restart; the earlier `504 Outdated Optimize Dep` was confirmed as stale Vite optimized dependency state
  - Browse > Novels loaded 62 LNReader recommendations after candidate/rating preparation, with 0 broken images and no UI errors
- Remaining non-blocking observations:
  - EPUB content can log sandboxed `about:srcdoc` script-block messages, which is expected because the reader blocks book-embedded scripts
  - Browse manga recommendation loading can still warn when a Cloudflare-protected source blocks a request; fallback behavior remains active
  - Build still reports existing Vite dynamic/static import chunk warnings for shared modules

## 2026-06-12 Reader HUD, Settings, and Taste Insights Refactor Final Audit
- HUD/Reader changes:
  - Draggable brightness popup works dynamically via clickable Sun icon in capsule bar.
  - TTS horizontal floating bar successfully retired and refactored into a dedicated settings sub-panel inside the settings popover (with full playback controls, speed slider, voice select, status, and back button).
  - Fully integrated EPUB TTS provider binding inside BookReader.svelte, syncing active section content and relocation hooks with the speech controller.
  - Sync and labels in BookReader are aligned to match NovelReader options (themes, fonts, combined width stepper + full toggle, max 1600px width).
  - Corrected theme/color bugs: reader defaults now resolve to white text on graphite dark mode background.
  - Configured Vitest workspaces to exclude JSDOM tests from the Node unit test project, fixing test runner execution conflicts.
- Taste Insights changes:
  - Mapped a high-fidelity interactive taste profile analytics dashboard overlay in `TasteInsightsModal.svelte`.
  - Normalizes content format weights relative to the maximum content type weight (resulting in correct match percentages like `100%` instead of cumulative weight overflows like `148848%`).
  - Expanded the modal window size (`max-width: 980px`, `max-height: 92vh`) and scaled up all text sizes, progress tracks, circles, and gaps to ensure a spacious dashboard layout that fits standard viewports without scrolling.
  - Bound the modal to the `View full insights` button in `BrowseV3.svelte`.
  - Aligned the Recommendation Score Breakdown circles horizontally by adding `display: flex; flex-direction: column; align-items: center;` to the `.breakdown-metric` style rule.
  - Corrected format preferences counts/percentages by removing general manga aggregators `mangakakalot` and `manganato` from the Korean `manhwa` heuristic keyword classifiers inside `adapters.ts` and `BrowseV3.svelte` (migrated the heuristic test to use the actual manhwa scanlator `Asura Scans`).
- Browse Switch Label changes:
  - Renamed the Browse content type switch buttons from "Manga/Novels" to "Comics/Books" inside `BrowseV3.svelte` to match the Library tab's section nomenclature.
  - Updated all query assertions inside `BrowseV3.test.ts` to expect "Comics" and "Books" role buttons.
- Discover Sidebar & Setup Status Card changes:
  - Compressed the Discover tab filters sidebar (`.catalogSidebar` / `.splitSidebar`) dimensions: reduced margin-bottoms, gaps, paddings, option checkmark sizes, search inputs, select dropdown rows, and status buttons to fit the filter configuration and genre tag list in standard viewports without vertical scrolling.
  - Configured the Suwayomi offline setup status card container (`.setup-banner` and `.setupWrap`) to float on top of the page content via `position: fixed`, centering it horizontally at `top: 68px` with `pointer-events: none` (allowing clicks to pass through transparent regions) and `pointer-events: auto` on the inner card. This prevents the server error card from shifting/pushing layout components downwards across the Browse, Extensions, and Sources pages.

## Reference Docs
- Historical refactor detail: [`docs/LIBRARY_SHARED_SHELL_REFACTOR.md`](docs/LIBRARY_SHARED_SHELL_REFACTOR.md)
