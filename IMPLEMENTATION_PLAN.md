# Aethon Stabilization Implementation Plan

This document is the current implementation checklist for the stabilization pass. Treat the current working tree as the source of truth; several items below are already partially implemented and should be hardened rather than rewritten.

---

## Current Status -- 2026-06-12

### Already implemented in the working tree

- Library update progress now uses shared helpers in `src/lib/library/updateRuntime.ts` for bounded progress, finalizing copy, complete copy, direct status polling, WebSocket progress patches, and Aethon update-rule normalization.
- Library cards already use dedicated cover cache/failure modules: `coverCache.ts` and `coverFailure.ts`.
- Browse/Sources already includes the recent fixes for extension loading, reduced duplicate setup messaging, recommendation throttling/cooldown, and transient recommendation cleanup.
- Local Suwayomi launch uses the current safer runtime profile, including `-noverify` compatibility and the restored `-Xmx512m` ceiling after lower caps proved unstable.
- Idle mode already trims runtime memory and reduces expensive decorative motion/filter work.
- PDF Reflow Mode is partially implemented in `BookReader.svelte` with the persisted `pdfReflowMode` setting, `pdf.reflow.ready` runtime stage, page-level PDF.js text extraction, reflow DOM rendering, and `src/lib/books/pdfReflow.test.ts`.
- The TTS system is partially implemented with `src/lib/reader/tts.ts`, shared `TtsControls.svelte`, NovelReader/EPUB providers, cleanup on reader close/unmount/pagehide, and tests.

### Still pending / known risk

- Manual and automatic Library update flows still have duplicated orchestration and should converge on a single runtime path.
- Library bulk callbacks exist at the body component level but must be wired through the page-level state mutations.
- Cover fallback should be verified so failed covers get one controlled retry and then a stable placeholder until URL/manual recovery changes.
- PDF Reflow needs release QA, memory trimming for retained reflow pages, and a clear policy for whether PDF TTS is exposed from reflow text.
- TTS still needs real release audio QA, stable voice/rate persistence, and native OS voice discovery only if WebView voices remain insufficient.
- Downloads/data paths, release-data isolation, bulk actions, and fullscreen escape still need final hardening.

---

## Implementation Rules

1. Investigate the current implementation before each edit. Do not overwrite recent work from other chats.
2. Prefer one source of truth for shared state: Library, Home, SeriesDetail, Downloads, Reader, update toast, and notifications must converge after updates.
3. Avoid parallel read-modify-write mutations on shared Svelte state; batch or serialize state writes.
4. Downloads are user data, not cache. Cache cleanup must never delete downloaded chapters, imports, history, or library data.
5. Use current Nocturne tokens and existing component patterns. No broad redesign in this stabilization pass.
6. Add diagnostics for unclear behavior instead of guessing.

---

## Milestone 1: Library Update Runtime and Live Sync

### Goal

Manual and automatic library updates must use one shared progress/sync contract. The toast must never freeze at stale text, and Library/Home/SeriesDetail should converge without requiring the user to open each title.

### Work

- Remove duplicated progress/status helpers from page/app code and use `updateRuntime.ts` everywhere.
- Keep one global update lock through `store.libraryUpdateInFlight`.
- Manual update:
  - starts immediately if no update is active;
  - if another update is active, attaches to/show the active progress instead of starting another job;
  - cancellation is only implemented if Suwayomi exposes a real stop mutation. If no backend stop exists, do not fake cancellation.
- Automatic update:
  - never starts while manual update or another auto update is active;
  - uses the same progress toast, polling fallback, WebSocket patching, final snapshot reload, and notification path.
- Patch Library cards live with `applyLibraryUpdateMangaPatches`.
- Reload snapshot and reconcile chapter counts at the end of the job.
- Only categories/folders with `includeInUpdate = false` should be skipped by Suwayomi.

### Verification

- Manual update shows live progress and final success/error.
- Auto update does not duplicate manual update.
- Library cards update without opening SeriesDetail.
- New chapter notifications persist.
- `npm run test:unit -- src/lib/library/updateRuntime.test.ts`

---

## Milestone 2: Cover Cache and Stable Placeholder

### Goal

Broken covers must stop flickering. Good covers should continue loading from stable local cache when possible.

### Work

- Keep cover identity keyed by profile/server/manga/source/thumbnail URL.
- On image failure:
  - clear the unstable cached URL for that key;
  - wake Suwayomi once for recovery;
  - mark the cover as failed;
  - render the placeholder stably.
- Permit exactly one recovery retry when URL/recovery version changes.
- Do not keep appending retry query params indefinitely.

### Verification

- Good covers load and remain stable while scrolling.
- Broken covers show placeholder without repeated flashing.
- Manual refresh or URL change can retry.
- Add/adjust cover failure tests if behavior is extracted further.

---

## Milestone 3: Browse/Sources Extension Management

### Goal

Browse > Sources must search, install, update, and remove extensions with clear feedback. Browse > Novels must remain independent and unbroken.

### Work

- Keep initial Sources load on cached `GET_EXTENSIONS`; use `FETCH_EXTENSIONS` only for explicit refresh.
- Ensure install/update/remove set per-item working state and operation error state.
- Show one setup/unreachable warning, not duplicate warnings.
- Confirm search uses the effective topbar/local search term for installed and available extensions.
- Keep novel plugin install flow separate from Suwayomi extension install flow.

### Verification

- Search installed/available extensions.
- Install an available extension and see installed state update.
- Update an extension with `hasUpdate`.
- Browse > Novels still loads and installs novel plugins.

---

## Milestone 4: Readers, PDF Reflow, and TTS

### Goal

Reader controls, PDF Reflow, and TTS should be stable, optional where appropriate, and tested in the real desktop runtime.

### Work

- Keep PDF Reflow opt-in with `pdfReflowMode = false` by default.
- Cap or trim retained `reflowedPages` so large PDFs do not retain unlimited extracted page data.
- Verify reflow scroll/location mapping and PDF runtime stages.
- Keep TTS in the reader settings subpanel, not the old floating horizontal bar.
- Persist TTS rate and selected voice only after confirming release WebView exposes stable `voiceURI` values.
- If Web Speech exposes too few/no voices in release, add a native provider path instead of pretending unavailable voices exist.
- Decide PDF TTS policy:
  - if using reflow text, expose PDF TTS only when reflow extraction is ready;
  - otherwise keep PDF TTS disabled and document it as pending.

### Verification

- NovelReader TTS plays/stops and highlights.
- EPUB TTS plays/stops and highlights.
- PDF Reflow toggles, renders, scrolls, and does not balloon memory.
- Release app audio QA confirms actual speech output.
- `npm run test -- --project shell-jsdom src/components/reader/TtsControls.test.ts src/lib/reader/tts.test.ts src/lib/books/pdfReflow.test.ts`

---

## Milestone 5: Downloads, Data Paths, and Release Isolation

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

---

## Milestone 6: Bulk Actions and Fullscreen

### Goal

Bulk Library actions must not lose state through last-write-wins races, and fullscreen must always have a global escape path.

### Work

- Wire bulk remove/move props from `Library.svelte` into `ComicsLibraryBody.svelte`.
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

---

## Final Test Plan

Run after each relevant milestone:

```bash
npm run test:unit -- src/lib/library/updateRuntime.test.ts
npm run test -- --project shell-jsdom src/components/reader/TtsControls.test.ts src/lib/reader/tts.test.ts src/lib/books/pdfReflow.test.ts
npm run test:browser
npm run build
cargo test local_server_java_args_enable_extension_bytecode_compatibility
```

Manual desktop smoke:

1. Home -> Notifications -> Library -> Browse -> Sources -> Downloads -> Settings.
2. Manual Library update with live progress.
3. Auto update lock behavior.
4. Library covers, including broken-cover placeholder behavior.
5. Manga Reader, EPUB Reader, PDF Reflow, NovelReader, and TTS.
6. Release/no-watch memory and CPU measurement after update and idle.

---

## Commit Strategy

- Commit by milestone after tests/smoke pass.
- Preserve all current working-tree changes from other chats as valid app state.
- Suggested commit messages:
  - `docs: update stabilization implementation plan`
  - `fix: unify library update runtime paths`
  - `fix: stabilize library cover fallback`
  - `fix: harden source extension management`
  - `fix: harden reader reflow and tts`
  - `fix: protect library bulk actions and fullscreen`
