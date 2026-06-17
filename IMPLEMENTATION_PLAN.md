# Aethon Stabilization Implementation Plan

This document is the current implementation checklist for the stabilization pass.
Treat the current working tree as the source of truth. Several features were implemented across Codex/Gemini chats and should now be hardened, audited, and committed by topic rather than rewritten from scratch.

---

## Current Status -- 2026-06-16

### Validation Snapshot

- `npm run test:unit` passed recently with the expanded stabilization suite.
- Targeted library/novel tests passed recently:
  - `src/lib/library/updateRuntime.test.ts`
  - `src/lib/library/comicsChapterSnapshot.test.ts`
  - `src/lib/novels/libraryRefresh.test.ts`
- Milestone 1 baseline was re-run after this plan update:
  - `npm run test:unit -- src/lib/library/updateRuntime.test.ts src/lib/library/comicsChapterSnapshot.test.ts src/lib/novels/libraryRefresh.test.ts` passed with 18 tests after the snapshot quota fix.
  - `npm run test:unit -- src/lib/library/updateRuntime.test.ts src/lib/library/comicsChapterSnapshot.test.ts src/store/navigation.test.ts` passed with 25 tests after the Recent Activity issue-count fix.
  - `npm run test:unit -- src/lib/library/updateRuntime.test.ts src/lib/library/comicsChapterSnapshot.test.ts src/lib/novels/libraryRefresh.test.ts src/store/navigation.test.ts` passed with 28 tests after the Update All timestamp fix.
  - `npm run build` passed after the snapshot quota, Recent Activity issue-count, and Books timestamp fixes.
- Latest focused validation after the cover, notification, and source-challenge changes:
  - `npm run test:unit -- src/store/navigation.test.ts` passed with 10 tests.
  - `npm run test:unit -- src/components/library/ComicsLibraryBody.test.ts src/lib/library/coverCache.test.ts src/lib/library/chapterCounts.test.ts src/lib/library/comicsChapterSnapshot.test.ts` passed with 17 tests.
  - Real desktop smoke verified the Library notification overlay opens/closes with `Back to Library` and keeps the Library behind it.
  - Real cover smoke verified a stale Library thumbnail can be replaced by the current Suwayomi cover generation for the tested MangaDex title.
- Latest phased-pass validation:
  - `npm run test:unit` passed with 83 files and 416 tests.
  - `npm run test:browser -- src/components/library/ComicsLibraryBody.test.ts src/components/library/LibraryCardGrid.test.ts src/components/library/BooksLibraryBody.test.ts` passed with 13 browser-component tests.
  - `npm run build` passed after the Library tab-preservation, cover retry, Browse fallback, Sources update-all, and ActivityButton hardening changes.
  - Deep visual smoke in the open desktop dev WebView covered Home, Recent Activity overlay, Browse Search, Browse Sources, Downloads, Settings, Library Comics scroll, Books tab, Comics tab return, and SeriesDetail from Library.
  - The smoke found Settings was functionally a primary page but could show Library keep-alive paint residue behind it. `Layout.svelte` now keeps Library mounted while setting inactive keep-alive paint to zero (`opacity: 0`, hidden visibility, contained paint), and Settings browser snapshots were updated to the corrected primary-page visual.
  - `npm run test:browser -- src/components/settings/Settings.browser.test.ts src/components/library/ComicsLibraryBody.test.ts` passed with 13 tests after the Settings visual isolation fix.
- Earlier Comics Library tab-switch audit:
  - `npm run test:unit -- src/components/library/ComicsLibraryBody.test.ts src/lib/library/coverCache.test.ts src/components/library/LibraryShell.test.ts` passed with 9 tests.
  - `npm run build` passed after active-state scroll guards.
  - Earlier real desktop smoke verified Comics -> Books -> Comics kept the same cover URLs and restored the Comics scroll position.
  - Follow-up WebView audit after the keep-alive work found the exact remaining tab-switch regression: `Comics -> scrollTop=9000 -> Books -> Comics` remounted the Comics body, reset `scrollTop` to `0`, and changed the visible cover URL prefix.
- Latest Library navigation/performance implementation:
  - The Library page is now kept alive in `src/components/layout/Layout.svelte` through `libraryComponent` and `.page-keepalive`, so `Library -> Home/Browse/Downloads/Settings -> Library` no longer destroys and recreates the Library tree.
  - Inactive Library keep-alive nodes are now visually isolated with hidden visibility, zero opacity, disabled pointer events, and paint containment so primary pages such as Settings do not show Library content behind them.
  - The notification/Recent Activity overlay is now closed by primary navigation and Settings navigation in `src/store/state.svelte.ts`, preventing it from staying in front of other pages.
  - `src/components/library/VirtualLibraryCardGrid.svelte` is a local row virtualizer; it does not use `@tanstack/svelte-virtual`.
  - The current virtualized desktop window uses stable row/card keys, `itemCount`, `getItem(index)`, and `getItemId(index)`, with overscan tuned to keep about 110 Comics cards / 11 virtual rows mounted in the audited 1920x1009 WebView.
  - Comics and Books/Novels both use lazy card resolution through `VirtualLibraryCardGrid` instead of building full visible-card arrays for large shelves.
  - Books view keys are compact and no longer use a giant `map(...).join(",")` over all filtered novel IDs.
  - Library cache self-subscription was removed from `Library.svelte`; the previous cache write -> cache subscriber -> `loadData()` loop was the exact cause of the WebView becoming unresponsive and growing into multi-GB memory.
  - Comics card opening uses `openMangaDetail`, and real WebView inspection confirmed Library card clicks set `store.activeManga` and render `SeriesDetail` as a detail layer.
  - Update-runtime Library snapshot writes are batched in `src/lib/library/updateRuntime.ts` so progress and chapter-count updates do not continuously rewrite the Library cache during updates.
  - Books and Comics bodies now stay mounted inside `Library.svelte`; inactive bodies receive `active=false` so they stop scroll/prewarm work while hidden, but they keep their virtual rows, decoded covers, and scroll state.
  - Browse > Sources `Update all` now wakes Suwayomi before manga extension update batches and records per-extension operation errors instead of only logging failed items.
  - Comics cover recovery now ignores cached/session cover URLs during the single retry attempt, so a known-broken cached cover is not immediately reused before falling back to a stable placeholder.
  - Browse search library refresh now tolerates a missing Library snapshot and uses the normalized local snapshot fallback, avoiding `.map` crashes in sparse test/runtime state.
  - Focused validation after the navigation/performance fixes:
    - `npm run test:unit -- src/store/navigation.test.ts` passed with 11 tests.
    - `npm run build` passed after the Activity Overlay navigation fix.
    - `npm run build` passed after the Library keep-alive and virtual-grid buffer changes.
    - `vitest --project browser-components src/components/library/LibraryCardGrid.test.ts src/components/library/ComicsLibraryBody.test.ts` passed with 11 tests.
  - Real WebView audit verified `Library -> Home -> Library` preserved `scrollTop=9000`, the same 110 cards, 11 virtual rows, and 109 decoded images instead of remounting covers.
  - Latest WebView audit verified `Comics -> scrollTop=9000 -> Books -> Comics` preserves `scrollTop=9000`, keeps both tab bodies mounted, and returns with `sameVisibleImgPrefix=true`.
  - Latest targeted validation:
    - `vitest --project unit src/store/navigation.test.ts src/lib/library/virtualGrid.test.ts` passed with 15 tests.
    - `vitest --project browser-components src/components/library/LibraryCardGrid.test.ts src/components/library/ComicsLibraryBody.test.ts` passed with 11 tests.
    - `vitest --project unit src/lib/library/updateRuntime.test.ts src/lib/library/comicsChapterSnapshot.test.ts src/lib/novels/libraryRefresh.test.ts` passed with 18 tests.
    - `vitest --project unit src/lib/sourceAccess.test.ts src/lib/library/coverCache.test.ts src/lib/library/chapterCounts.test.ts src/lib/novels/pluginRuntime.test.ts` passed with 19 tests.
    - `vitest --project shell-jsdom src/components/reader/TtsControls.test.ts src/lib/reader/tts.test.ts` passed with 8 tests.
    - `vitest --project unit src/lib/books/pdfReflow.test.ts` passed with 9 tests.
    - `npm run build` passed after the Library tab-preservation change.
- `npm run build` passed recently.
- Settings browser screenshot drift was reviewed during the deep visual smoke, fixed as expected primary-page isolation, and the updated Settings browser snapshots now pass.
- Desktop dev/release auditing is still required after each remaining milestone before continuing to the next one.

### Already Implemented In The Working Tree

- Library update progress now uses shared helpers in `src/lib/library/updateRuntime.ts` for bounded progress, direct status polling, WebSocket progress patching, finalizing copy, complete copy, and stale-progress fallback.
- Comics manual update now uses a source-grouped update path based on `fetchChapters`, with update intensity support:
  - `fast`: up to 4 sources in parallel.
  - `balanced`: up to 2 sources in parallel.
  - `eco`: 1 source at a time.
  - Within each source, titles are checked sequentially.
- Comics update now has per-title timeouts, source failure classification, source-wide blockers, deferred items, and issue reporting.
- Persistent `libraryUpdateIssues` exists in the store and is rendered in Recent Activity as grouped update issues.
- Source-wide issues such as missing sources and disabled Cloudflare bypass are compacted so they do not spam hundreds of individual notifications.
- Shared source access classification exists in `src/lib/sourceAccess.ts` for Cloudflare, captcha, anti-bot, FlareSolverr, timeout, rate-limit, missing-source, network, and generic source failures.
- FlareSolverr integration exists in `src/lib/flaresolverr.ts` and the novel plugin runtime can use it as a source-challenge recovery path when configured.
- Source-challenge update issues now carry recovery metadata for affected source/title retry flows where the update runtime can provide it.
- Comics chapter update detection no longer relies only on `chapterCount`.
  - `src/lib/library/comicsChapterSnapshot.ts` stores a light chapter snapshot per profile/server.
  - Diff uses `chapter.id` first, with fallback identity support.
  - First snapshot seeding avoids generating fake historical notifications.
- Comics chapter snapshots are compacted before persistence and storage quota failures no longer abort Library update reconciliation.
- Comics chapter counts now avoid regressing when partial source responses return stale/lower counts during update.
- Library update notifications for Comics are generated from real chapter diff data when possible.
- Books/Novels refresh is now closer to the LNReader model:
  - saved novel entries are refreshed through installed novel sources;
  - chapters are diffed by `path`;
  - progress/bookmarks/history are preserved through ID remapping;
  - `updatedAt` is recorded only for newly discovered chapters;
  - failures are returned for Recent Activity.
- Books update now updates `settings.lastLibraryUpdateAt`, including when it runs as the second half of Update All Libraries.
- Library update modal now exposes scoped actions:
  - update current Comics library;
  - update current Books library;
  - update all libraries.
- Settings includes Library update controls, including auto-update settings, standby settings, novel update options, and update intensity.
- Categories/folders support update-exclusion semantics for update filtering.
- Library card cover handling has dedicated cache/failure modules:
  - `src/lib/library/coverCache.ts`
  - cover failure tests exist and were adjusted.
- Cover cache generation is now part of the cached cover identity, so a Library update can request a fresh authenticated Suwayomi thumbnail instead of reusing the previous blob.
- Library card cover loading guards against stale async cache responses overwriting a newer cover after pagination/tab/update churn.
- SeriesDetail syncs fresher manga/chapter metadata back into the Library store, and Library update actions bump cover generations for Comics and Books when refreshed metadata includes thumbnails.
- Cover identity and recovery versions are wired through Library/LibraryCard so broken covers can fall back instead of retrying endlessly.
- Comics cover retry now bypasses cached/session cover URLs after a cover error; the first recovery uses the direct thumbnail URL with a retry marker, and a second failure stays on the placeholder until the URL/recovery generation changes.
- Browse/Sources includes fixes for extension loading, reduced duplicate setup messaging, recommendation throttling/cooldown, and transient recommendation cleanup.
- Local Suwayomi launch uses the current safer runtime profile, including `-noverify` compatibility and the restored `-Xmx512m` ceiling after lower caps proved unstable.
- Aethon now centralizes more server/update control instead of relying on Suwayomi automatic updates alone.
- Idle mode trims runtime memory and reduces expensive decorative motion/filter work.
- Recent Activity was redesigned into a lighter activity page focused on real notifications/events instead of placeholder progress stats.
- Notification badge behavior was refined so unread counts sit on the bell without expanding the topbar button.
- The notification bell is now a shared topbar control used by Home, Library, Browse, Downloads, and Settings.
- Recent Activity now opens through a global overlay with contextual back labels such as `Back to Library`, `Back to Browse`, `Back to Downloads`, and `Back to Settings`.
- Primary navigation now closes the global Recent Activity overlay, so the notification page does not remain in front after switching sidebar pages.
- The Recent Activity `All` tab has a clear action that clears update notifications/issues, history entries, and system notifications.
- Recent Activity issue groups now use compacted affected-title counts when the update runtime reports source-wide blockers.
- Library page keep-alive is implemented in `Layout.svelte`; the Library component remains mounted when navigating away to other primary pages.
- `VirtualLibraryCardGrid.svelte` supports lazy `itemCount`/`getItem`/`getItemId` rendering and bounded virtual rows for both Comics and Books.
- Comics Library card opening uses `openMangaDetail`, so SeriesDetail routing receives full manga detail state from Library cards.
- Books Library card resolution is lazy for books and novels, including stable cover reveal after local/source cover decoding.
- `Library.svelte` no longer subscribes to the same `CACHE_KEYS.LIBRARY` key that `loadData()` writes, avoiding the previous self-triggered cache reload loop.
- Library snapshot commits during Comics update are throttled/batched in `updateRuntime.ts`, reducing cache-write churn while updates are running.
- Nocturne theme tokens and UI surface styling were partially centralized and applied to popovers/panels.
- PDF Reflow Mode is partially implemented in `BookReader.svelte`:
  - persisted `pdfReflowMode` setting;
  - `pdf.reflow.ready` runtime stage;
  - page-level PDF.js text extraction;
  - reflow DOM rendering;
  - `src/lib/books/pdfReflow.test.ts`.
- TTS is partially implemented:
  - `src/lib/reader/tts.ts`;
  - shared `TtsControls.svelte`;
  - NovelReader and EPUB providers;
  - cleanup on reader close/unmount/pagehide;
  - tests.
- Source metric banners, flags, and responsive Library cards were heavily reworked and documented in `docs/DECISIONS.md`.
- Browse/Search/Discover cards now share more of the Library cover/banner presentation model.

### Important Current Findings

- Cloudflare/source-challenge handling is implemented for the shared classifier, FlareSolverr bridge, update issue grouping, and retry metadata, but it still needs broader real-source auditing.
  - Reader still has an interactive Comics/Suwayomi fallback path that can open the Suwayomi WebView for challenge/captcha flows.
  - Automatic/manual Library update should now treat errors such as `Cloudflare bypass currently disabled` as source-level recovery issues instead of hundreds of title-level bugs.
  - The tested FlareSolverr path worked for one protected source flow; it is not a universal bypass and must be verified against both Suwayomi and LNReader-style sources.
- Some sources are inherently slow or broken.
  - The Fast source queue should report these clearly and avoid wasting the entire update on a broken source.
  - The current circuit/deferred behavior exists but still needs desktop audit under real library conditions.
- Real desktop Comics update smoke completed after the snapshot quota fix.
  - The previous failure was `Failed to execute 'setItem' on 'Storage': Setting the value of 'aethon-comics-chapter-snapshots' exceeded the quota.`
  - After compaction, the snapshot shrank from about 2.7 MB to about 1.15 MB and the update completed with an actionable issues summary instead of failing.
  - The run found 8 new chapter notifications and 12 current update issues across 7 sources.
  - Comix was classified as `source-challenge` with FlareSolverr recovery metadata.
- Real desktop Books update smoke completed successfully with `1/1 source novels refreshed`.
- Real desktop Update All Libraries smoke completed:
  - Comics ran first from the Books tab and completed with `10 titles could not update across 6 sources`.
  - Books ran afterward and recorded `Books library refreshed with warnings`.
  - Repeated click during Update All reported `Library update already running` and did not start a duplicate job.
- The known Comics Library cover regression was fixed with cover generation keys, SeriesDetail-to-Library sync, and stale async response guards.
  - Comics/Books tab switching uses session cover memory and active-state guards to avoid resetting shared scroll state.
  - Current rendering keeps both Books and Comics bodies mounted; inactive bodies receive `active=false`, preserving tab scroll/cover state while suppressing hidden scroll/prewarm work.
  - This still needs broader Books/novel cover stress testing during pagination, tab switching, and Library update.
  - The tested MangaDex title now resolves the newer SeriesDetail cover in Library after refresh.
- Library scroll/page switching now uses keep-alive plus bounded virtual rows.
  - The old `Load more`/sentinel model accumulated mounted cards after long scrolls.
  - The first aggressive virtual window prevented the freeze but made covers enter too late during scroll.
  - The current tuned window mounts about 110 Comics cards / 11 rows in the audited desktop WebView, preserving scroll/page return state without remounting covers.
  - Tradeoff: keeping Library alive intentionally retains decoded cover memory while the user visits Home/Browse/Downloads/Settings.
  - Remaining risk is tuning under larger real libraries and slower disks/network caches, especially Books/Novel source covers.
- Comics and Books update flows are now more similar at the orchestration level, but they use different canonical backends:
  - Comics: Suwayomi and `fetchChapters`.
  - Books/Novels: LNReader-style local runtime/source plugins.
- The Reader HUD visual redesign is explicitly out of scope for this pass unless a functional bug requires a small fix.

### Still Pending / Known Risk

- The Fast Comics update path must be audited against the real desktop dev app:
  - titles updated in the latest smoke and produced real chapter notifications;
  - failures classified correctly for the observed missing-source, source-challenge, timeout, and generic source errors;
  - Recent Activity issue groups were actionable for the observed Comix source challenge;
  - CPU/Java load still needs a release/no-watch measurement.
- Update toast can still show confusing states near completion or while waiting on slow sources; it needs real-run validation.
- Manual, automatic, and "Update All Libraries" need stress testing:
  - repeated clicks;
  - mixed Comics/Books update clicks;
  - cancel/close modal behavior;
  - navigation during update.
- Library/Home/Browse/Sources must be checked after update to verify they all reflect updated data.
- Cloudflare challenge handling needs broader real-source validation:
  - verify source challenge detection for multiple Comics and Books sources;
  - verify source-level actions are useful;
  - verify Suwayomi WebView fallback still writes usable Comics cookies;
  - verify retry only affects the blocked source/titles.
- Comics cover fallback is unit/browser tested for one controlled retry and then a stable placeholder until URL/manual recovery changes.
- Books/Novels source covers still need the same stress audit as Comics where applicable, without duplicating Suwayomi-specific cache assumptions.
- Library keep-alive/virtualization needs a release/no-watch smoke:
  - confirm `Library -> Home/Browse/Downloads/Settings -> Library` preserves scroll and mounted covers;
  - confirm long scroll does not accumulate unbounded DOM nodes;
  - confirm retained decoded cover memory stays acceptable after visiting all major pages.
- Books/Comics tab switching is fixed for the current real dev data and now keeps both tab bodies mounted. It still needs a larger Books/Novel shelf smoke later because current real Books data is too small to prove large-shelf behavior.
- The Activity/notification overlay close-on-navigation is implemented, unit-tested, and checked in the real dev WebView after reload.
- Browse > Sources extension install/search/update/remove still needs a final desktop audit against a live Suwayomi instance; code audit confirmed manga and novel flows remain separate, and `Update all` now wakes the manga server before batch updates.
- PDF Reflow needs release QA, memory trimming for retained reflow pages, and a clear policy for PDF TTS.
- TTS still needs real release audio QA, stable voice/rate persistence, and native OS voice discovery only if WebView voices remain insufficient.
- Downloads/data paths, release-data isolation, bulk actions, and fullscreen escape still need final hardening.
- Settings browser screenshot drift was fixed and updated snapshots pass; continue to treat future screenshot drift as a review gate.

---

## Implementation Rules

1. Investigate the current implementation before each edit. Do not overwrite recent work from other chats.
2. Prefer one source of truth for shared state: Library, Home, SeriesDetail, Downloads, Reader, update toast, and notifications must converge after updates.
3. Avoid parallel read-modify-write mutations on shared Svelte state; batch or serialize state writes.
4. Downloads are user data, not cache. Cache cleanup must never delete downloaded chapters, imports, history, or library data.
5. Use current Nocturne tokens and existing component patterns. No broad redesign unless the milestone is explicitly visual.
6. Add diagnostics for unclear behavior instead of guessing.
7. Do not redesign the Reader HUD visuals in this pass. Functional fixes are allowed; visual redesign is not.
8. Keep Comics and Books update behavior conceptually aligned, but respect their different sources of truth.

---

## Milestone 0: Checkpoint And Baseline

### Goal

Save the current valid working-tree state and establish a clear baseline before more changes.

### Work

- Review `git status --short` and group changes by theme.
- Run or confirm:
  - `npm run test:unit`
  - `npm run build`
  - targeted Library/Novel tests
- Check the known `npm run test:browser` Settings screenshot drift.
- If the app is functional, commit the current completed work as a checkpoint before deeper changes.

### Verification

- App opens in desktop dev.
- Home, Library, Browse, Sources, Downloads, Settings open.
- Working tree state is documented before further edits.

### Suggested Commit

`chore: checkpoint current stabilization work`

---

## Milestone 1: Audit And Harden Library Update Runtime

### Status

Next active milestone. The runtime has many of the required mechanics already implemented, but this is the gate that still needs a real desktop audit across manual Comics, manual Books, Update All, repeated clicks, navigation during update, FlareSolverr/source-challenge events, and live Library card refresh.

### Goal

Manual, automatic, Comics, Books, and "Update All Libraries" must have predictable locking, progress, completion, and data refresh behavior.

### Work

- Audit the current `updateRuntime.ts` Fast source queue in desktop dev.
- Confirm the global update lock behavior:
  - manual update starts immediately if no update is active;
  - auto update never starts while manual/update-all is active;
  - repeated clicks attach to or report the active update instead of starting another job.
- Confirm scoped update actions:
  - Update Comics library updates only Comics;
  - Update Books library updates only Books/Novels;
  - Update All Libraries runs Comics then Books/Novels.
- Confirm update exclusions:
  - only folders/categories with `includeInUpdate = false` should skip their titles;
  - Saved/Downloaded/Finished membership should not skip a title by itself.
- Harden toast final states:
  - no freeze at 90/99/100%;
  - slow-source wait text is temporary and replaced by progress/final summary;
  - complete toast closes or settles consistently.
- Verify Library/Home cards update without opening SeriesDetail.
- Keep real cancellation only if backend support exists. Do not fake stop behavior.

### Verification

- Manual Comics update shows live progress and final success/issues.
- Manual Books update shows live progress and final success/issues.
- Update All Libraries runs both paths and reports both results clearly.
- Repeated/mixed clicks do not start duplicate jobs.
- Library cards update live.
- Recent Activity receives real chapter updates and issue groups.

### Tests

```bash
npm run test:unit -- src/lib/library/updateRuntime.test.ts src/lib/library/comicsChapterSnapshot.test.ts src/lib/novels/libraryRefresh.test.ts
npm run build
```

### Suggested Commit

`fix: harden library update runtime`

---

## Milestone 2: Cloudflare And Source-Challenge Flow

### Status

Mostly implemented. The shared classifier, FlareSolverr bridge, source-level issue grouping, and recovery metadata exist. Remaining work is real-source auditing across Suwayomi and LNReader-style sources, plus any small fixes found while validating retry/recovery actions.

### Goal

Cloudflare-protected Comics/Suwayomi and Books/LNReader sources should produce clear source-level recovery instead of noisy title-level failures. FlareSolverr is the primary automated recovery path when configured; interactive WebView recovery remains the Comics/Suwayomi fallback because those cookies must land in the Suwayomi cookie jar.

### Work

- Add one shared source-access classifier for Cloudflare, captcha, anti-bot, FlareSolverr, timeout, rate-limit, missing-source, network, and generic source errors.
- Persist source-level recovery metadata in `libraryUpdateIssues`:
  - `source-challenge`;
  - optional challenge/action URL;
  - retry source id;
  - retry kind for Comics or Books;
  - recovery hint such as FlareSolverr or WebView.
- Comics/Suwayomi:
  - keep detecting `Cloudflare bypass currently disabled`;
  - classify it as `source-challenge`;
  - compact it to one source issue;
  - include a source/tile URL when available;
  - expose source retry that updates only affected Comics titles;
  - use Suwayomi WebView for interactive challenge/cookie recovery.
- Books/LNReader:
  - add FlareSolverr fallback in the LNReader plugin fetch boundary;
  - classify source challenge failures as source-level update issues;
  - group Books updates by source and stop wasting the queue on a blocked source;
  - expose retry for affected novel sources only.
- FlareSolverr:
  - reuse existing local/Docker/custom configuration;
  - make contextual recovery actions able to start/test/enable it;
  - keep auto-update non-interactive.
- Do not claim universal automatic bypass. Some sources may still require waiting, migration, or manual external browser checks.

### Verification

- Comics Cloudflare errors compact to one actionable source group.
- Books/LNReader anti-bot errors compact to one actionable source group.
- FlareSolverr can be started/enabled from a source challenge action.
- Live FlareSolverr smoke already succeeded for one protected source path; repeat this against additional Comics and Books sources before closing the milestone.
- Opening the Comics source WebView does not break Reader or Sources.
- Retrying a source only retries relevant Comics titles or Books novels.
- Auto-update records recovery issues but never opens a WebView/challenge window.

### Suggested Commit

`fix: surface source challenge recovery`

---

## Milestone 3: Cover Cache And Stable Placeholder

### Status

Core Comics regression fixed and smoke-tested for the reported stale MangaDex cover case. Remaining work is stress auditing Books/Novels, Browse, pagination, and update-time tab switching.

### Goal

Broken covers must stop flickering across Library pagination, tab changes, updates, and Books/novel sources.

### Work

- Audit current cover identity usage in:
  - Home;
  - Library Comics;
  - Library Books;
  - Browse Search/Discover;
  - SeriesDetail.
- Define one shared cover flow:
  - resolve canonical remote/local URL;
  - use cache where appropriate;
  - track failure by stable identity;
  - show stable placeholder after controlled retry;
  - retry only on explicit refresh, URL change, or recovery version bump.
- Keep Suwayomi-authenticated cover caching for Comics.
- Avoid forcing novel/source covers into Suwayomi-specific cache if they are direct source/plugin URLs.
- Fix page/tab switching during updates so cards do not lose valid cover state.

### Verification

- Good Comics covers stay stable during update and tab/page switching.
- Reported stale MangaDex Library cover updates to the same current generation used by SeriesDetail.
- Broken Comics covers show stable placeholder.
- Good Books/Novel covers stay stable during tab/page switching.
- Broken Books/Novel covers show stable placeholder.
- Browse covers still load directly from sources/search results.

### Tests

```bash
npm run test:unit -- src/lib/library/coverCache.test.ts
npm run build
```

### Suggested Commit

`fix: stabilize cover rendering across library pages`

---

## Milestone 4: Recent Activity As Real Persistent Events

### Status

Implemented for the current topbar/overlay request. The shared notification button is present on Home, Library, Browse, Downloads, and Settings; the overlay has contextual back labels; primary sidebar/settings navigation closes the overlay; and the All tab can clear all current activity buckets. Remaining work is persistence/reopen audit and update-event validation during real update runs.

### Goal

Recent Activity should show persistent real events: new chapters, update issues, reading history, and system events.

### Work

- Confirm update events persist until manual clear.
- Confirm Updates shows:
  - Comics chapters added by chapter snapshot diff;
  - Novel chapters added by `path` diff;
  - update issues grouped by source/extension.
- Confirm System shows summaries, not duplicate error spam.
- Confirm the badge counts new update events/issues without expanding the bell button.
- Add a clear manual action that intentionally clears update notifications/issues.

### Verification

- After an update with new chapters, Updates contains those chapters.
- After an update with source failures, Updates contains grouped issues.
- The notification bell opens Recent Activity from Home, Library, Browse, Downloads, and Settings.
- The overlay back button returns to the tab that opened it instead of saying only `Back to Home`.
- Switching through the primary sidebar while the overlay is open closes the overlay instead of leaving it in front of the new page.
- The All tab clear action removes all visible activity buckets.
- Events persist after navigation/reopening the page.
- Manual clear removes them.

### Suggested Commit

`fix: persist recent activity update events`

---

## Milestone 5: Browse/Sources Extension Management

### Goal

Browse > Sources must search, install, update, and remove extensions with clear feedback. Browse > Novels must remain independent and unbroken.

### Work

- Keep initial Sources load on cached `GET_EXTENSIONS`; use `FETCH_EXTENSIONS` only for explicit refresh.
- Ensure install/update/remove set per-item working state and operation error state.
- Ensure manga `Update all` wakes Suwayomi before the batch and records per-extension operation errors.
- Show one setup/unreachable warning, not duplicate warnings.
- Confirm search uses the effective topbar/local search term for installed and available extensions.
- Keep novel plugin install flow separate from Suwayomi extension install flow.
- Verify installed manga extensions actually render after Suwayomi is reachable.

### Verification

- Search installed/available extensions.
- Install an available manga extension and see installed state update.
- Update an extension with `hasUpdate`.
- Remove an installed extension safely.
- Browse > Novels still loads and installs novel plugins.

### Suggested Commit

`fix: stabilize source extension management`

---

## Milestone 6: Readers, PDF Reflow, And TTS

### Goal

Reader controls, PDF Reflow, and TTS should be stable, optional where appropriate, and tested in the real desktop runtime.

### Work

- Keep PDF Reflow opt-in with `pdfReflowMode = false` by default.
- Cap or trim retained `reflowedPages` so large PDFs do not retain unlimited extracted page data.
- Verify reflow scroll/location mapping and PDF runtime stages.
- Keep TTS in the reader settings subpanel.
- Do not apply the Reader HUD visual redesign in this milestone.
- Persist TTS rate and selected voice only after confirming release WebView exposes stable `voiceURI` values.
- If Web Speech exposes too few/no voices in release, add a native provider path instead of pretending unavailable voices exist.
- Decide PDF TTS policy:
  - if using reflow text, expose PDF TTS only when reflow extraction is ready;
  - otherwise keep PDF TTS disabled and document it as pending.

### Verification

- Manga Reader page/chapter navigation works.
- NovelReader TTS plays/stops and highlights.
- EPUB TTS plays/stops and highlights.
- PDF Reflow toggles, renders, scrolls, and does not balloon memory.
- Release app audio QA confirms actual speech output.

### Tests

```bash
npm run test -- --project shell-jsdom src/components/reader/TtsControls.test.ts src/lib/reader/tts.test.ts src/lib/books/pdfReflow.test.ts
npm run build
```

### Suggested Commit

`fix: harden reader reflow and tts`

---

## Milestone 7: Downloads, Data Paths, And Release Isolation

### Goal

Downloaded chapters must be reliable user data, and release builds must not ship developer data.

### Work

- Trace the full download flow from enqueue to file write, DB/local metadata, Downloads UI, and Reader offline loading.
- Centralize mutable data paths under the OS user-data/profile directory.
- Keep downloads/imports/history/library separate from cache.
- Add diagnostics for user data path, downloads path, cache path, and release profile.
- Add/keep release preflight checks that fail if user data is packaged.

### Verification

- Download one chapter and multiple chapters.
- Restart and verify downloaded state persists.
- Open downloaded chapter offline.
- Clear cache and verify downloads/history/imports/library remain.

### Suggested Commit

`fix: harden downloads and user data paths`

---

## Milestone 8: Bulk Actions And Fullscreen

### Goal

Bulk Library actions must not lose state through last-write-wins races, and fullscreen must always have a global escape path.

### Work

- Wire bulk remove/move props from `Library.svelte` into Library body components.
- Use `Promise.allSettled` for server mutations only where safe, then do one client-side state update.
- Reload categories once after a bulk category operation.
- Add global fullscreen Escape handling outside Reader.
- Add a visible exit-fullscreen control when fullscreen is active.
- Guard `f`/Escape keybinds while typing in inputs/contenteditable elements.

### Verification

- Bulk remove 5+ titles removes all selected titles in one visible update.
- Bulk move/toggle 5+ titles updates the selected folder membership correctly.
- Escape exits fullscreen on Reader and non-reader pages.
- Typing `f` in search/input does not toggle fullscreen.

### Suggested Commit

`fix: protect library bulk actions and fullscreen`

---

## Milestone 9: Theme, Responsiveness, And UI Consistency

### Goal

Nocturne UI surfaces should be consistent without broad unrelated redesign.

### Work

- Keep the centralized Nocturne tokens as the source of truth.
- Standardize popovers, menus, tabs, switches, panels, and modal density.
- Keep the Library update modal visually aligned with existing popovers/panels.
- Keep Library responsive behavior predictable:
  - auto density;
  - 4 to 10 items per row;
  - cards fill available width without large empty gaps;
  - hierarchy positions should not jump when resizing.
- Settings browser screenshot drift was reviewed during deep visual smoke; the updated snapshots are intentional after isolating Settings as a primary page.

### Verification

- Home, Library, Browse, Downloads, Settings, and Recent Activity look coherent.
- Popovers and update modal use the same palette/font/density.
- Library cards resize without leaving avoidable gaps.
- No Reader HUD visual redesign sneaks in.

### Suggested Commit

`style: standardize nocturne surfaces`

---

## Milestone 10: Performance And Runtime Footprint

### Goal

Reduce real desktop runtime overhead without sacrificing the current UX.

### Work

- Measure dev and release/no-watch separately.
- Keep Java/Suwayomi CPU high only during intentional update work.
- Confirm standby after update when eligible.
- Confirm Home/Library remain useful from snapshot while Suwayomi sleeps.
- Keep WebView/GPU changes evidence-based; do not disable GPU without proof.
- Trim caches and transient Browse state only when safe.

### Verification

- CPU idle returns near zero after update/idle.
- Java RAM drops when standby stops Suwayomi.
- WebView memory does not grow indefinitely after navigating all major pages.
- Browse, Library, Reader remain responsive.

### Suggested Commit

`perf: reduce desktop runtime overhead`

---

## Milestone 10.1: Library Cover Scroll Performance

### Goal

Keep desktop Library scrolling smooth with 600+ Comics/Books entries while avoiding both extremes:

- full persistent mounting of hundreds of cover cards;
- overly small virtualization windows that reveal/decode covers during the user's scroll.

### Completed

- Audited the real Tauri WebView with CDP while scrolling Library Comics.
- Confirmed badges/flags were not the main bottleneck.
- Confirmed the original bottleneck was oversized covers rendered in small cards:
  - old source covers reached 2k-4k+ edges and multi-megapixel paints;
  - hiding cover images removed almost all scroll jank.
- Added Rust-side library cover thumbnailing:
  - cache writes resize covers to max edge 420px;
  - cached output uses JPEG quality 82;
  - old full-size cache is bypassed via `thumb-v2-edge420` cache variant.
- Changed Comics Library card rendering so it does not paint original source cover URLs as a fallback.
- Added idle prewarm for local thumbnails:
  - visible range is prioritized;
  - normal-size libraries prewarm the rest in the background;
  - prewarm pauses while the user scrolls;
  - cover URL state updates are batched and delayed until scroll is idle;
  - images are pre-decoded before replacing placeholders.
- Applied the same decode/idle/batched-cover reveal model to Books/Novels:
  - local book and novel covers are kept out of cards until decoded;
  - covers are revealed in stable batches after scroll idle;
  - the path is ready for larger Books/Novel libraries even though the current smoke data only has a few entries.
- Retained badge overlay behavior and avoided `contain: paint` on cards.
- Replaced incremental "load more" accumulation with `VirtualLibraryCardGrid.svelte`.
- Tuned the current desktop virtual window to keep enough rows ahead/behind the viewport for smoother scroll:
  - grid mode overscan is 4 rows;
  - list mode overscan is 5 rows;
  - viewport floor is 3 estimated rows;
  - audited Comics WebView mounted about 110 cards / 11 virtual rows.
- Books/Novels now resolve cards lazily through `getItem(index)` instead of prebuilding the full mixed card list.
- Library page keep-alive now preserves mounted cards, decoded images, and scroll position across primary page navigation.

### Real WebView Results

- Before thumbnail cache: scroll had repeated long tasks and frame spikes from full-size cover painting.
- After thumbnail cache but before warm-up completed: scroll base improved, but new covers entering/decoding still caused occasional spikes.
- Earlier persistent-grid warm-up smoke showed smooth post-warm scrolling but mounted 600+ cards, which was too much retained DOM for broader navigation.
- Current keep-alive/virtual-grid smoke after reload:
  - `Library -> Home -> Library` preserved `scrollTop=9000`;
  - the same 110 cards, 11 virtual rows, and 109 images remained mounted;
  - covers did not remount on primary page return;
  - renderer CPU stabilized after image decode; retained memory increased as expected because decoded Library covers intentionally remain alive.

### Remaining Work

- Run release/no-watch smoke after a clean app restart, not only HMR/dev WebView:
  - long Comics scroll;
  - Books/Novels scroll with a larger shelf;
  - Comics -> Books -> Comics tab switching;
  - Library -> Home/Browse/Downloads/Settings -> Library;
  - SeriesDetail open/back from Library.
- Track WebView memory after visiting all major pages with Library kept alive. The expected tradeoff is higher retained memory than remounting, but it must not grow indefinitely.
- Consider a small Library status/progress affordance for first-time thumbnail warm-up if placeholders appearing during the first pass feels too abrupt.
- Revisit overscan if users still see cover reveal lag while scrolling, but avoid returning to 600+ mounted cards by default.

### Verification

- `vitest --project browser-components src/components/library/LibraryCardGrid.test.ts src/components/library/ComicsLibraryBody.test.ts`
- `npm run test:unit -- src/store/navigation.test.ts`
- `cargo check`
- `npm run build`
- Manual CDP/WebView smoke on Library Comics: page keep-alive, tab switching, cold-ish warm-up pass, and post-warm scroll pass.
- Manual CDP/WebView smoke on Library Books with a larger shelf when available.

### Suggested Commit

`perf: keep library mounted with bounded virtual rows`

---

## Final Test Plan

Run after each relevant milestone:

```bash
npm run test:unit
npm run test:browser
npm run build
cargo test local_server_java_args_enable_extension_bytecode_compatibility
```

Targeted tests for update/reader work:

```bash
npm run test:unit -- src/lib/library/updateRuntime.test.ts src/lib/library/comicsChapterSnapshot.test.ts src/lib/novels/libraryRefresh.test.ts src/lib/library/coverCache.test.ts
npm run test -- --project shell-jsdom src/components/reader/TtsControls.test.ts src/lib/reader/tts.test.ts src/lib/books/pdfReflow.test.ts
```

Manual desktop smoke:

1. Home -> notification overlay -> Library -> Browse -> Downloads -> Settings; confirm each topbar bell opens Recent Activity, the back label matches the opening tab, and sidebar/settings navigation closes the overlay instead of leaving it in front.
2. Manual Comics update with live progress, source-challenge grouping, FlareSolverr/WebView recovery actions where applicable, and Library cover refresh.
3. Manual Books update with live progress, LNReader-style source-challenge grouping, FlareSolverr recovery where applicable, and Library cover refresh.
4. Update All Libraries; confirm Comics and Books run in order and final copy reports both paths clearly.
5. Repeated/mixed update clicks and modal close/cancel behavior.
6. Auto update lock behavior.
7. Library covers during tab/page switching and during update, including Books/Novel source covers.
8. Browse -> Sources extension install/search, source detail, and retry/recommendation cleanup.
9. Manga Reader, EPUB Reader, PDF Reflow, NovelReader, and TTS.
10. Release/no-watch memory and CPU measurement after update and idle.

---

## Commit Strategy

- Commit by milestone after tests/smoke pass.
- Preserve all current working-tree changes from other chats as valid app state.
- Prefer these commit topics:
  - `docs: update stabilization implementation plan`
  - `chore: checkpoint current stabilization work`
  - `fix: harden library update runtime`
  - `fix: surface source challenge recovery`
  - `fix: stabilize cover rendering across library pages`
  - `fix: persist recent activity update events`
  - `fix: stabilize source extension management`
  - `fix: harden reader reflow and tts`
  - `fix: harden downloads and user data paths`
  - `fix: protect library bulk actions and fullscreen`
  - `style: standardize nocturne surfaces`
  - `perf: reduce desktop runtime overhead`
  - `perf: keep library mounted with bounded virtual rows`
