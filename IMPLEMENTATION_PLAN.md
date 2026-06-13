# Aethon Stabilization Implementation Plan

This document is the current implementation checklist for the stabilization pass.
Treat the current working tree as the source of truth. Several features were implemented across Codex/Gemini chats and should now be hardened, audited, and committed by topic rather than rewritten from scratch.

---

## Current Status -- 2026-06-13

### Validation Snapshot

- `npm run test:unit` passed recently with the expanded stabilization suite.
- Targeted library/novel tests passed recently:
  - `src/lib/library/updateRuntime.test.ts`
  - `src/lib/library/comicsChapterSnapshot.test.ts`
  - `src/lib/novels/libraryRefresh.test.ts`
- `npm run build` passed recently.
- `npm run test:browser` still has known Settings screenshot drift, while the Library Comics/Books browser coverage passed in the latest audit.
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
- Comics chapter update detection no longer relies only on `chapterCount`.
  - `src/lib/library/comicsChapterSnapshot.ts` stores a light chapter snapshot per profile/server.
  - Diff uses `chapter.id` first, with fallback identity support.
  - First snapshot seeding avoids generating fake historical notifications.
- Library update notifications for Comics are generated from real chapter diff data when possible.
- Books/Novels refresh is now closer to the LNReader model:
  - saved novel entries are refreshed through installed novel sources;
  - chapters are diffed by `path`;
  - progress/bookmarks/history are preserved through ID remapping;
  - `updatedAt` is recorded only for newly discovered chapters;
  - failures are returned for Recent Activity.
- Library update modal now exposes scoped actions:
  - update current Comics library;
  - update current Books library;
  - update all libraries.
- Settings includes Library update controls, including auto-update settings, standby settings, novel update options, and update intensity.
- Categories/folders support update-exclusion semantics for update filtering.
- Library card cover handling has dedicated cache/failure modules:
  - `src/lib/library/coverCache.ts`
  - cover failure tests exist and were adjusted.
- Cover identity and recovery versions have been partially wired through Library/LibraryCard so broken covers can fall back instead of retrying endlessly.
- Browse/Sources includes fixes for extension loading, reduced duplicate setup messaging, recommendation throttling/cooldown, and transient recommendation cleanup.
- Local Suwayomi launch uses the current safer runtime profile, including `-noverify` compatibility and the restored `-Xmx512m` ceiling after lower caps proved unstable.
- Aethon now centralizes more server/update control instead of relying on Suwayomi automatic updates alone.
- Idle mode trims runtime memory and reduces expensive decorative motion/filter work.
- Recent Activity was redesigned into a lighter activity page focused on real notifications/events instead of placeholder progress stats.
- Notification badge behavior was refined so unread counts sit on the bell without expanding the topbar button.
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

- Cloudflare bypass is not fully working for Library update.
  - Reader has an interactive fallback path that can open the Suwayomi WebView for challenge/captcha flows.
  - Automatic/manual Library update through `fetchChapters` still receives errors such as `Cloudflare bypass currently disabled` from Suwayomi for some sources.
  - This should be handled as "source challenge required" or "source unavailable", not as hundreds of title-level bugs.
- Some sources are inherently slow or broken.
  - The Fast source queue should report these clearly and avoid wasting the entire update on a broken source.
  - The current circuit/deferred behavior exists but still needs desktop audit under real library conditions.
- Library cover flicker is improved but not fully proven.
  - The user still observed covers breaking when switching Library pages/tabs during update, including Books/novel source covers.
  - This remains a high-priority audit item.
- Comics and Books update flows are now more similar at the orchestration level, but they use different canonical backends:
  - Comics: Suwayomi and `fetchChapters`.
  - Books/Novels: LNReader-style local runtime/source plugins.
- The Reader HUD visual redesign is explicitly out of scope for this pass unless a functional bug requires a small fix.

### Still Pending / Known Risk

- The Fast Comics update path must be audited against the real desktop dev app:
  - whether titles truly update;
  - whether failures are classified correctly;
  - whether Recent Activity issue groups are actionable;
  - whether CPU/Java load remains acceptable.
- Update toast can still show confusing states near completion or while waiting on slow sources; it needs real-run validation.
- Manual, automatic, and "Update All Libraries" need stress testing:
  - repeated clicks;
  - mixed Comics/Books update clicks;
  - cancel/close modal behavior;
  - navigation during update.
- Library/Home/Browse/Sources must be checked after update to verify they all reflect updated data.
- Cloudflare challenge handling needs a product flow:
  - detect source challenge;
  - show source-level action;
  - open Suwayomi WebView;
  - retry only affected source/titles.
- Cover fallback should be verified so failed covers get one controlled retry and then a stable placeholder until URL/manual recovery changes.
- Books/Novels source covers need the same stable failure behavior as Comics where applicable, without duplicating Suwayomi-specific cache assumptions.
- Browse > Sources extension install/search still needs a final desktop audit after recent changes.
- PDF Reflow needs release QA, memory trimming for retained reflow pages, and a clear policy for PDF TTS.
- TTS still needs real release audio QA, stable voice/rate persistence, and native OS voice discovery only if WebView voices remain insufficient.
- Downloads/data paths, release-data isolation, bulk actions, and fullscreen escape still need final hardening.
- Settings browser screenshot drift must be reviewed and either accepted intentionally or fixed.

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

### Goal

Cloudflare-protected sources should produce clear source-level guidance instead of noisy title-level failures.

### Work

- Keep detecting errors such as `Cloudflare bypass currently disabled`.
- Classify these as source challenge/unavailable issues, not generic per-title failures.
- Add a source-level user flow:
  - Recent Activity or Sources shows the affected source;
  - user can open the Suwayomi WebView for that source/challenge;
  - after closing WebView, retry only affected source/titles.
- Do not claim automatic Cloudflare bypass works until verified on real protected sources.
- Keep Reader interactive fallback separate from Library update automation.

### Verification

- Mangakakalot/Comix-style Cloudflare errors compact to one actionable source group.
- Opening the source WebView does not break Reader or Sources.
- Retrying a source after WebView only retries relevant titles.

### Suggested Commit

`fix: surface source challenge recovery`

---

## Milestone 3: Cover Cache And Stable Placeholder

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
- Review Settings browser screenshot drift and decide whether updated screenshots are intentional.

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

1. Home -> Notifications -> Library -> Browse -> Sources -> Downloads -> Settings.
2. Manual Comics update with live progress.
3. Manual Books update with live progress.
4. Update All Libraries.
5. Repeated/mixed update clicks and modal close/cancel behavior.
6. Auto update lock behavior.
7. Library covers during tab/page switching and during update.
8. Manga Reader, EPUB Reader, PDF Reflow, NovelReader, and TTS.
9. Release/no-watch memory and CPU measurement after update and idle.

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
