# Aethon Stabilization Implementation Plan

This document is the current implementation checklist for the stabilization pass.
Treat the current working tree as the source of truth. Several features were implemented across Codex/Gemini chats and should now be hardened, audited, and committed by topic rather than rewritten from scratch.

---

## Current Status -- 2026-06-20

### Launch Stabilization Snapshot

- App/package version is now `0.0.1` for the upcoming first public release pass.
- Branding/name work has moved the desktop identity from Moku/Tauri defaults toward Aethon/Aethon Nocturne in the user-facing shell.
- Local profiles are no longer limited to hardcoded visible built-ins:
  - `MAIN` remains the required primary profile.
  - Additional profiles can be created from Settings with their own localhost port and separate local workspace root.
  - Additional profiles can be removed from Settings when they are not the active session.
  - Profile workspace data can be reset for `MAIN` and for additional profiles from Settings after a second confirmation click.
  - Resetting the active profile stops its local server first; the user should restart Aethon afterward so the active profile is recreated cleanly from disk.
- The legacy `TEST` profile remains reserved for launch/restore compatibility, but it is not exposed as a normal Settings profile choice.
- Settings now contains the first app-language package wiring:
  - Paraglide/Inlang is installed and compiled through Vite.
  - `project.inlang/settings.json` and `messages/{locale}.json` are the source translation catalogs.
  - Settings exposes an `App language` selector independent from `Preferred source language`.
  - The language selector supports a broad locale list through `Intl.DisplayNames`.
  - Settings language controls plus the shared sidebar, Home, Downloads, and page/detail loading states now use message keys; full-app localization still requires extracting domain-specific strings from the remaining major pages and readers.
- Settings storage/expansion controls were hardened:
  - dropdown menus use opaque Nocturne surfaces instead of transparent backgrounds;
  - Storage action rows are aligned;
  - expandable Settings sections can be collapsed by clicking the same action again.
- Library/Shell/details visual polish from the latest pass is in the working tree:
  - global window drag was restored through the top chrome;
  - Downloads/Settings search placement and animation were aligned with other primary pages;
  - Settings app card positioning and icon presentation were adjusted;
  - detail-page header action sizing, migrate labeling, status icon columns, and notification badge styling were adjusted across shared detail shell usage.
- Latest focused validation after the profile reset and Settings hardening:
  - `npm test -- src/lib/localProfiles.test.ts` passed with 8 tests.
  - `npm test -- --project shell-jsdom src/components/settings/Settings.test.ts` passed with 8 tests.
  - `cargo test reset_local_profile_data_resolves_builtin_profiles` passed before the dev app was opened.
  - `npm run build` passed after the profile reset change.
  - A fresh real dev app was restarted from `target/debug/aethon.exe` against Vite `127.0.0.1:1420`, MAIN Suwayomi `127.0.0.1:4567`, and WebView2 CDP `127.0.0.1:9223`.
  - Dev-app CDP smoke confirmed title `Aethon [MAIN :4567]`, Settings rendered visually, Profiles showed `MAIN`, and `Reset data` was visible without testing destructive reset on real user data.
- Latest small follow-up:
  - Library preload aborts caused by navigation are now treated as normal cancellation instead of `console.error` noise.
  - `npm test -- src/lib/localProfiles.test.ts` and `npm test -- --project shell-jsdom src/components/settings/Settings.test.ts` passed after that adjustment.
  - After closing the dev app, `cargo test reset_local_profile_data_resolves_builtin_profiles` passed.
  - `npm run build` passed after the Library abort-noise adjustment.
  - The dev app was restarted again from `target/debug/aethon.exe`; Vite `127.0.0.1:1420`, MAIN Suwayomi `127.0.0.1:4567`, and WebView2 CDP `127.0.0.1:9223` were all live.
  - Final CDP smoke covered Home, Library, Browse, Downloads, and Settings. It recorded `0` JavaScript `pageerror` entries and `0` `console.error` entries.
  - Final visual screenshot confirmed Settings render with `Aethon Nocturne v0.0.1`, `MAIN`, and `RESET DATA` visible in Profiles.
- Latest profile destructive-smoke result:
  - A temporary profile named `Codex Smoke ...` was created from Settings on a random high localhost port.
  - Its `Reset data` / `Confirm reset` flow was exercised.
  - The temporary profile registration was deleted afterward.
  - The default profile was restored to `MAIN`; final Settings state showed `Active profile ... MAIN Reset data`.
- Latest release signing audit:
  - Local signing key files exist at `C:\Users\jhow-\.tauri\aethon.key` and `C:\Users\jhow-\.tauri\aethon.key.pub`.
  - Signing environment variables were not globally present, which is correct for keeping the private key out of the repo/environment.
  - `npm run tauri -- build --config src-tauri/tauri.conf.json` with `TAURI_SIGNING_PRIVATE_KEY` supplied only for that process generated `src-tauri/target/release/bundle/nsis/Aethon_0.0.1_x64-setup.exe`.
  - Final installer SHA-256 after commit `d82c8c5`: `CB25F62953E3857D86D6CBF8C898412A03C4DB3E03DDC41F55DD9ACCCA278CDB`.
  - Signing was unblocked by passing the encrypted key's empty password as the preserved single argument `--password=` directly to the Tauri CLI shim. The previous npm invocation silently dropped the empty password and waited on an invisible prompt.
  - `src-tauri/target/release/bundle/nsis/Aethon_0.0.1_x64-setup.exe.sig` was generated successfully by Tauri CLI 2.10.1.
  - Final signature SHA-256: `4CBE871C68BCB8A8612F786ECA9885B0886F457AF240C3B6BF21DC1204A1AE33`.
  - Tauri CLI 2.10.1 has no `signer verify` subcommand; successful key decryption/signing and the generated updater signature are the available local CLI validation.
  - The signing key remained outside the repository and was supplied only to the signing process.
- Latest i18n and dev-app smoke:
  - Shared sidebar labels and page/detail loading states now use `svelte-i18n` message keys.
  - The runtime applies `dir=rtl` for Arabic, Persian, Hebrew, and Urdu locales and restores `dir=ltr` when returning to English or Portuguese.
  - Real WebView2 smoke switched English -> Hebrew RTL -> Portuguese (Brazil) -> English; document language/direction and sidebar labels updated without JavaScript errors.
  - Home, Library, Browse, Downloads, and Settings sidebar navigation was exercised in the fresh dev build.
  - Library Comics rendered loaded covers at scroll offsets 0, 22000, and the end of the 48150px virtual surface; Books/Comics switching and Library keep-alive navigation also passed.
  - Visual smoke found and fixed the missing `settings-row--stacked` CSS contract that compressed the Create profile label into a one-character column in narrow windows.
  - `npm run test:browser -- src/components/settings/Settings.browser.test.ts -t "keeps the profile creation row readable"`, `npm test -- src/lib/i18n/runtime.test.ts`, and `npm run build` passed.
  - With the dev app closed, `cargo test local_server_java_args_enable_extension_bytecode_compatibility` passed.
  - The final signed NSIS installer completed a silent install with exit code `0` at `C:\Users\jhow-\AppData\Local\Aethon\aethon.exe`.
  - Installed-release smoke opened `http://tauri.localhost/` with title `Aethon [MAIN :4567]`, rendered the real 633-title Library and Settings/Profiles, and recorded no JavaScript or console errors.
  - The temporary localization smoke state was restored to English before leaving the installed app open.
- Latest release-readiness cleanup:
  - Commit `2f26fcf` fixed the Library folder snapshot regression: transient category refresh failures no longer overwrite persisted folders with an empty category list, and Library category fetch now wakes the local server before querying.
  - Settings General was reorganized into separate `Startup`, `Profiles`, and `Desktop defaults` cards, with updated browser snapshots.
  - Settings General and related shared labels received the next i18n message-key slice while keeping app language separate from `Preferred source language`.
  - The GitHub CLI was installed locally and authenticated as `johnnylord1`; repository/release publishing is intentionally postponed until local release readiness is complete.
  - Local release cleanup removed Aethon-owned unused CSS build warnings in `NovelDetail.svelte` and `SeriesDetail.svelte`.
  - Backup test fixtures were aligned to release version `0.0.1`.
  - `npm test -- src/lib/backup/aethonBackup.test.ts src/lib/backup/booksBackup.test.ts` passed with 9 tests.
  - `npm run build` passed after the release cleanup; the previous Aethon-owned Svelte unused-selector warnings are gone.
  - The i18n runtime was migrated from `svelte-i18n` to Paraglide with a compatibility wrapper for existing `$_("section.key")` call sites.
  - Home and Downloads received the next message-key slice in Paraglide catalogs.
  - `npm test -- src/lib/i18n/runtime.test.ts src/components/pages/Downloads.test.ts`, `npm test -- --project shell-jsdom src/components/settings/Settings.test.ts src/components/pages/Downloads.test.ts src/lib/i18n/runtime.test.ts`, and `npm run build` passed after the Paraglide migration.
  - Library received the next Paraglide message-key slice for section tabs, hero labels, counts, system collections, search placeholders, sort/filter options, Books type filters, display popovers, refresh modal text, and the Suwayomi error state.
  - Library localization was kept at the presentation layer so user folders/categories, filters, card data, cover cache, and virtual-grid behavior were not rewritten.
  - Validation after the Library localization slice:
    - `npm test -- src/lib/i18n/runtime.test.ts src/components/pages/Downloads.test.ts` passed with 11 tests.
    - `npm test -- --project shell-jsdom src/components/library/LibraryToolbar.test.ts src/components/library/LibraryShell.test.ts src/components/library/ComicsLibraryBody.test.ts src/components/library/BooksLibraryBody.test.ts src/lib/i18n/runtime.test.ts` passed for the discovered shell-jsdom Library files.
    - `npm run test:browser -- src/components/library/ComicsLibraryBody.test.ts src/components/library/LibraryCardGrid.test.ts src/components/library/BooksLibraryBody.test.ts` passed with 15 browser-component tests.
    - `npm run build` passed with Paraglide compilation.


### Remaining Work

- Full app localization:
  - Continue the hybrid production strategy: curated shared/core messages first, then machine-assisted domain catalogs with human review.
  - Extract hardcoded user-facing strings from the remaining primary/detail surfaces: Browse/Sources, SeriesDetail, BookDetail, NovelDetail, readers, dialogs/toasts, and the rest of Settings beyond General.
  - Revisit Library later only for deeper card/empty-state/domain strings that are generated by lower-level builders, after the remaining primary pages are covered.
  - Expand message-key coverage tests beyond the locale resolver so new native strings do not bypass the i18n layer.
  - Expand locale-specific visual coverage beyond the completed Hebrew RTL smoke.
- Local release readiness before GitHub publishing:
  - Optional final installed-app smoke after the next signed installer is generated, if release artifacts are rebuilt again before publishing.
- Final GitHub publishing step:
  - Create or select the GitHub repository after local readiness is complete.
  - Create the `v0.0.1` GitHub Release.
  - Upload the signed NSIS installer and generated `.sig`.
  - Publish updater metadata using the GitHub Release installer URL and signature value.
  - Add the production updater endpoint once the metadata URL is stable.
- Known non-blocking build warnings to clean later:
  - protobuf `eval` warning from dependency code;
  - Vite dynamic/static import chunking warnings.

## Historical Status -- 2026-06-19

### Final Continuation Snapshot

- Worktree is clean after `cad418c test: cover large source novel library virtualization`.
- Latest focused Books/Novels scale audit:
  - `npm run test:browser -- src/components/library/BooksLibraryBody.test.ts` passed with the new 320 source-novel virtual-grid coverage.
  - `npm run test:unit -- src/lib/novels/libraryShelf.test.ts` passed.
  - `npm run build` passed.
- Latest real dev-app visual smoke via `npm run tauri:dev:gate` and WebView2 CDP covered:
  - Home;
  - Library Comics top/scroll;
  - Comics -> Books -> Comics;
  - Browse;
  - Downloads;
  - Settings;
  - Recent Activity opening from Library;
  - Recent Activity closing when navigating to Browse from the sidebar.
- Final blockers / decisions:
  - Updater signing keypair was generated locally at `C:\Users\jhow-\.tauri\aethon.key` and `C:\Users\jhow-\.tauri\aethon.key.pub`; the private key was generated without a password and must not be committed.
  - `src-tauri/tauri.conf.json` and `src-tauri/tauri.windows.conf.json` now use the generated public updater key.
  - Signed NSIS artifacts were generated under `src-tauri/target/release/bundle/nsis/`, including `Aethon_0.6.7_x64-setup.exe.sig`.
  - The installed app remains present at `C:\Users\jhow-\AppData\Local\Aethon\Aethon.exe` with `uninstall.exe`; do not remove it unless explicitly requested.
  - A larger live Books/Novels shelf smoke remains data-dependent. Synthetic 320-novel browser coverage is in place, but the current real profile only has a small Books/Novels shelf.

## Historical Status -- 2026-06-18

### Validation Snapshot

- Latest continuation after the phased stabilization commits:
  - `npm run test:unit` passed with 83 files and 419 tests.
  - `npm run test:browser` passed with 5 files and 21 browser-component tests.
  - `npm run build` passed after the Sources, TTS, and downloaded-manga offline-reader fixes.
  - `cargo test local_server_java_args_enable_extension_bytecode_compatibility --lib` passed from `src-tauri`.
  - Real Tauri dev-app smoke via `npm run tauri:dev:gate` was performed during this pass, not only browser tests:
    - manual Comics update completed against 633 titles with source-grouped failures in Recent Activity;
    - manual Books update completed with `1/1 source novels refreshed`;
    - Update All ran Comics then Books, and repeated clicks respected the in-flight update lock;
    - FlareSolverr recovery started the local service on `:8191`;
    - a source retry for Comix retried only the 38 affected titles;
    - Suwayomi WebView recovery opened the expected source challenge URL instead of changing the main app route;
    - Browse > Sources install/remove/update behavior was validated with a disposable Comic Fury install/remove and existing updateable manga extensions;
    - PDF Reflow and TTS were validated with a real imported PDF, including Web Speech playback state and persisted voice/rate preferences after reader remount;
    - a downloaded MangaDex chapter opened offline from its local `.cbz` after Java/Suwayomi was stopped;
    - Settings cache cleanup did not change the downloads folder count, total bytes, or SHA-256 for the downloaded chapter archive.
- Latest fixes from this continuation:
  - Browse > Sources no longer reloads stale Suwayomi extension state immediately after update/remove operations that only fully unload on server restart; it updates local UI state and explains the restart behavior in the toast.
  - TTS controls persist playback rate and selected Web Speech voice in localStorage and restore them after reader remount without blocking use when storage is unavailable.
  - The manga Reader can fall back to local downloaded `.cbz` archives when a downloaded chapter cannot fetch pages from Suwayomi, and revokes generated blob URLs on chapter changes/destroy.
  - The default downloads path now points at the embedded MAIN server profile (`aethon-main/downloads`) instead of the generic Tachidesk default, matching the real files written by the app.
- Latest release/no-bundle smoke:
  - `npm run tauri -- build --no-bundle --config src-tauri/tauri.automation.conf.json` produced `src-tauri/target/release/aethon.exe`.
  - The release executable launched with the packaged Suwayomi JRE from `src-tauri/target/release/binaries/suwayomi-bundle/jre/bin/java.exe` and MAIN root `C:\Users\jhow-\AppData\Roaming\aethon-main`.
  - WebDriver automation could not be used because the installed `msedgedriver.exe` supports Edge 146 while the local WebView/Edge runtime is 149.0.4022.69. No system driver was changed.
  - Release smoke was completed through WebView2 CDP by launching with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`.
  - Release app title was `Aethon [MAIN :4567]`, and MAIN Suwayomi listened on `127.0.0.1:4567`.
  - Visual screenshots confirmed Library, Browse, Downloads, and Settings render as separate primary pages; Settings and Browse do not show Library keep-alive residue.
  - Library release scroll reached `scrollTop=9000` with bounded visible cards and loaded images still present; Comics/Books/Comics tab switching did not produce a page error.
  - Release smoke captured source/backend resource errors for some external requests (`400`, `500`, `504`) and Cloudflare recommendation warnings, but no JavaScript `pageerror` or app freeze.
  - After release navigation/Library smoke, process working sets were about `aethon.exe 38.7 MB` and `java.exe 526.0 MB`.
- Latest NSIS installer and release soak validation:
  - `npm run tauri -- build --config src-tauri/tauri.conf.json` generated `src-tauri/target/release/bundle/nsis/Aethon_0.6.7_x64-setup.exe`.
  - Installer artifact size was `191,234,755` bytes with SHA-256 `122FE1406D1FE79AFC9575C8284C54E8EE6EA45D3F03A8CD2FBAB34AB9BA42F0`.
  - The Tauri build command returned non-zero after generating the NSIS installer because the updater public key is configured but `TAURI_SIGNING_PRIVATE_KEY` is not present. Distribution signing remains the only blocker for a fully green installer build.
  - Release bundle contents were validated without installing into Windows: `aethon.exe`, `aethon-syncd.exe`, packaged `java.exe`, and `Suwayomi-Server.jar` were present under `src-tauri/target/release`.
  - A release soak via CDP ran 4 navigation cycles across Library, Home, Browse, Downloads, and Settings, alternating Comics/Books and scrolling Library to deep positions.
  - Soak samples showed `aethon.exe` staying around `37.8-38.9 MB`; `java.exe` ranged around `603.7-673.1 MB` during source/page activity.
  - The soak recorded `0` JavaScript `pageerror` entries. Console noise was limited to external/source resource warnings/errors already observed during release smoke.
- Latest installed-app validation:
  - Signing audit found no `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `TAURI_PRIVATE_KEY`, or `MINISIGN_PRIVATE_KEY` in the environment. No private signing key is present in the repo.
  - The generated NSIS installer was run with `/S` and exited `0`.
  - The installed app was found at `C:\Users\jhow-\AppData\Local\Aethon\Aethon.exe`; uninstall metadata exists under HKCU with DisplayName `Aethon`, DisplayVersion `0.6.7`, and InstallLocation `C:\Users\jhow-\AppData\Local\Aethon`.
  - Installed files include `aethon.exe`, `aethon-syncd.exe`, `uninstall.exe`, packaged `binaries/suwayomi-bundle/jre/bin/java.exe`, and packaged `binaries/suwayomi-bundle/bin/Suwayomi-Server.jar`.
  - The installed app launched with `--main`, title `Aethon [MAIN :4567]`, and Suwayomi using the installed JRE while keeping MAIN data rooted at `C:\Users\jhow-\AppData\Roaming\aethon-main`.
  - Installed-app smoke covered Home, Library, Browse, Downloads, Settings, Books Library, and explicit Comics Library. The explicit Comics Library pass rendered `77` visible cards and `96` loaded images.
  - Installed-app smoke recorded `0` console errors and `0` JavaScript `pageerror` entries. After the smoke, process working sets were about `aethon.exe 46.4 MB` and `java.exe 585.8 MB`.
- Latest external-source hardening:
  - Browse Search recommendations now classify source failures through `sourceAccess` before logging them.
  - Expected source-side failures such as Cloudflare/source-challenge, timeout, rate-limit, network, missing source, and source-error are logged once per source/context as `console.info` instead of repeated `console.warn` spam.
  - Unknown recommendation failures still use `console.warn` with the original error object.
  - `npm run test:unit -- src/components/pages/BrowseV3.test.ts src/lib/sourceAccess.test.ts` passed with 11 tests.
  - `npm run build` passed after the recommendation logging change.
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
- Latest safe phased stabilization pass after checkpoint `fe04871`:
  - `npm run test:unit -- src/lib/library/updateRuntime.test.ts src/lib/library/comicsChapterSnapshot.test.ts src/lib/novels/libraryRefresh.test.ts` passed with 18 tests.
  - `npm run test:unit -- src/lib/sourceAccess.test.ts src/lib/novels/pluginRuntime.test.ts src/lib/novels/libraryRefresh.test.ts src/lib/library/updateRuntime.test.ts src/store/navigation.test.ts` passed with 34 tests.
  - `npm run test:unit -- src/lib/library/coverCache.test.ts src/lib/library/chapterCounts.test.ts src/lib/manga/coverResolver.test.ts src/lib/imageCache.test.ts` passed with 17 tests.
  - `npm run test:browser -- src/components/library/ComicsLibraryBody.test.ts src/components/library/LibraryCardGrid.test.ts src/components/library/BooksLibraryBody.test.ts` passed with 13 tests.
  - `npm run test:unit -- src/components/pages/BrowseV3.test.ts src/components/pages/NovelSources.test.ts src/store/navigation.test.ts src/lib/novels/packages.test.ts src/lib/novels/repositories.test.ts` passed with 31 tests.
  - `npm run test -- --project shell-jsdom src/components/reader/TtsControls.test.ts src/lib/reader/tts.test.ts` passed with 8 tests.
  - `npx vitest run --project unit src/lib/books/pdfReflow.test.ts src/lib/reader/contracts.test.ts` passed with 12 tests.
  - `npm run test:unit -- src/components/pages/Downloads.test.ts src/lib/cache.test.ts src/lib/localProfiles.test.ts src/lib/backup/appBackup.test.ts src/lib/backup/aethonBackup.test.ts src/lib/backup/aethonRestorePlanner.test.ts` passed with 36 tests.
  - `npm run build` passed after the source retry guard and PDF Reflow opt-in fixes.
  - Final `npm run test:unit` passed with 83 files and 416 tests.
  - Final `npm run build` passed.
  - Full `npm run test:browser` had one Settings screenshot timeout on the first run; isolated rerun `npm run test:browser -- src/components/settings/Settings.browser.test.ts` passed with 5 tests, so the failure is tracked as a browser screenshot timing flake rather than an accepted visual drift.
  - `cargo test local_server_java_args_enable_extension_bytecode_compatibility` passed with the dev app/JRE lock clear.
  - Recent Activity source retries now respect the global Library update in-flight lock instead of starting an invisible retry while another update is active.
  - PDF Reflow is opt-in by default again and retained extracted reflow pages are pruned with the existing `pruneReflowedPages` helper.
  - Downloads/data, bulk Library actions, and fullscreen were code-audited: bulk mutations use `Promise.allSettled` plus consolidated client updates, fullscreen Escape is global, and fullscreen keybinds ignore editable targets.
- Latest Phase 1 update-runtime hardening:
  - Final Comics update progress now uses `formatLibraryUpdateFinalSummary`, preserving checked/total counts and issue counts after UI reconciliation instead of replacing the detailed runtime result with a generic finished message.
  - Automatic update final progress now reports the Comics portion explicitly while the system notification remains the overall Comics+Books summary.
  - `npm run test:unit -- src/lib/library/updateRuntime.test.ts src/lib/library/comicsChapterSnapshot.test.ts src/lib/novels/libraryRefresh.test.ts` passed with 19 tests.
  - `npm run build` passed after the final-summary change.
  - A real Tauri dev-app smoke opened `Aethon [MAIN :4567]`, navigated to Library, rendered Comics cards, and captured no WebView console/page errors.
- Latest Phase 2 source-challenge classifier hardening:
  - `sourceAccess` now classifies common anti-bot page text such as `Just a moment`, `checking your browser`, `attention required`, `access denied`, and `DDoS-Guard` as source-wide `source-challenge` issues with FlareSolverr recovery.
  - Plain `HTTP 403 Forbidden` remains a non-source-wide `source-error`, avoiding an overly broad Cloudflare assumption.
  - `npm run test:unit -- src/lib/sourceAccess.test.ts src/lib/library/updateRuntime.test.ts src/lib/novels/libraryRefresh.test.ts src/lib/novels/pluginRuntime.test.ts` passed with 24 tests.
  - `npm run build` passed after the classifier change.
- Latest Phase 3 cover/placeholder hardening:
  - Books/Novels source cover errors now clear the stable source-cover entry and mark that novel cover identity as broken, so a failing source novel cover stays on the placeholder instead of retrying/reappearing after tab churn.
  - Books Library empty-state rendering now uses the actual lazy grid card count, allowing a novels-only Books view to render instead of showing the empty shelf state.
  - `npm run test:unit -- src/lib/library/coverCache.test.ts src/lib/manga/coverResolver.test.ts src/lib/imageCache.test.ts` passed with 13 tests.
  - `npm run test:browser -- src/components/library/BooksLibraryBody.test.ts src/components/library/ComicsLibraryBody.test.ts src/components/library/LibraryCardGrid.test.ts` passed with 14 tests.
- Latest Phase 4 Browse/Sources hardening:
  - Sources `Update all` now filters candidates by the active mode (`manga` vs `novels`) and reports partial per-extension failures as an error toast instead of a generic success.
  - Novel source bulk updates now continue past a failed plugin update and keep the failed source highlighted with its operation error.
  - `npm run test:unit -- src/components/pages/BrowseV3.test.ts src/components/pages/NovelSources.test.ts src/lib/novels/packages.test.ts src/lib/novels/repositories.test.ts` passed with 21 tests.
- Latest Phase 5 Reader/PDF/TTS hardening:
  - BookReader now clears the TTS provider during reader disposal and while a PDF is in canvas mode or reflow mode before any reflowed text exists, preventing stale EPUB/reflow providers from leaking into the next document.
  - PDF reflow TTS controls remain gated until at least one reflowed page is loaded; before that, the settings row reports that it is waiting for reflow instead of opening active controls with no readable text.
  - `npm run test -- --project shell-jsdom src/components/reader/TtsControls.test.ts src/lib/reader/tts.test.ts` passed with 8 tests.
  - `npx vitest run --project unit src/lib/books/pdfReflow.test.ts src/lib/reader/contracts.test.ts` passed with 12 tests.
- Latest Phase 6 downloads/data/bulk/fullscreen hardening:
  - Editable keyboard-target detection is now shared through `src/lib/keybinds.ts` and used by the app fullscreen handler, Manga Reader, and BookReader, so textareas, selects, and contenteditable surfaces do not trigger reader/fullscreen shortcuts.
  - Downloads/data and backup/cache safety were revalidated; cache cleanup remains in-memory/session scoped and does not delete downloads, imports, history, library, or progress.
  - `npm run test:unit -- src/components/pages/Downloads.test.ts src/lib/cache.test.ts src/lib/localProfiles.test.ts src/lib/backup/appBackup.test.ts src/lib/backup/aethonBackup.test.ts src/lib/backup/aethonRestorePlanner.test.ts` passed with 36 tests.
  - `npm run test -- --project shell-jsdom src/components/reader/TtsControls.test.ts src/lib/reader/tts.test.ts src/components/reader/ReaderHud.test.ts` passed with 14 tests.
- Latest Phase 7 final validation:
  - `npm run test:unit` passed with 83 files and 418 tests.
  - `npm run test:browser` passed with 5 files and 21 browser-component tests.
  - `npm run build` passed after the phased fixes.
  - `cargo test local_server_java_args_enable_extension_bytecode_compatibility` passed with no dev app/JRE lock active.
  - Real Tauri dev-app smoke via `npm run tauri:dev:gate` and WebView2 CDP confirmed `Aethon [MAIN :4567]`, primary sidebar navigation active-state changes for Home/Library/Browse/Downloads/Settings, bounded Library virtual card counts during deep scroll, loaded images still present after scroll, and Comics/Books/Comics tab switching completed without a visible app freeze.
  - A follow-up no-watch memory smoke kept the Library virtual window stable at 46 mounted cards across top/deep/back scroll samples. Process working set moved from about `aethon.exe 47.9 MB / Java 417.8 MB` to `aethon.exe 56.8 MB / Java 483.9 MB` after navigation and long Library scroll; the WebView renderer did not grow into multi-GB memory. One console 500 resource load was observed during this second smoke, but no JS `pageerror` or app freeze was captured.
- Latest desktop dev WebView smoke after the safe phased commits:
  - `npm run tauri:dev:gate` opened the real Tauri dev app against `http://127.0.0.1:1420` and MAIN Suwayomi on `:4567`.
  - WebView2 CDP inspection confirmed the real app page title was `Aethon [MAIN :4567]` with no captured console/page errors during smoke.
  - Primary navigation was validated in the dev app for Home, Library, Browse, Downloads, and Settings; the active sidebar state changed correctly and each page rendered visible page-specific controls.
  - Recent Activity overlay was reopened during smoke and verified to close when switching primary sidebar pages.
  - Library Comics/Books tab switching in the dev app measured about 150-170 ms in the audited run, even while a real Library update was active.
  - Library virtual scroll was validated against the real scroll container at top, middle, deep, near-bottom, and back-middle positions; visible card counts remained stable, DOM card count stayed bounded, and visible card images were loaded.
  - During this smoke, the Library update toast progressed from early items to `349/633 - 55%`, confirming it was live progress rather than a stuck toast at that point.
- Desktop dev/no-watch auditing has now covered update completion/final-state, source recovery actions, navigation, Library scroll/tab switching, reader/TTS behavior, and downloaded offline reading. A packaged release smoke remains useful before distribution, but it is no longer blocking the current stabilization phase.

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
- Recent Activity source retry actions now set and clear `libraryUpdateInFlight`, and report `Library update already running` instead of launching a retry while another update is active.
- Library page keep-alive is implemented in `Layout.svelte`; the Library component remains mounted when navigating away to other primary pages.
- `VirtualLibraryCardGrid.svelte` supports lazy `itemCount`/`getItem`/`getItemId` rendering and bounded virtual rows for both Comics and Books.
- Comics Library card opening uses `openMangaDetail`, so SeriesDetail routing receives full manga detail state from Library cards.
- Books Library card resolution is lazy for books and novels, including stable cover reveal after local/source cover decoding.
- `Library.svelte` no longer subscribes to the same `CACHE_KEYS.LIBRARY` key that `loadData()` writes, avoiding the previous self-triggered cache reload loop.
- Library snapshot commits during Comics update are throttled/batched in `updateRuntime.ts`, reducing cache-write churn while updates are running.
- Nocturne theme tokens and UI surface styling were partially centralized and applied to popovers/panels.
- PDF Reflow Mode is partially implemented and guarded in `BookReader.svelte`:
  - persisted `pdfReflowMode` setting;
  - `pdfReflowMode = false` by default, so PDF Reflow is opt-in;
  - `pdf.reflow.ready` runtime stage;
  - page-level PDF.js text extraction;
  - reflow DOM rendering;
  - bounded retained reflow pages through `pruneReflowedPages`;
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
  - Books/Novels source scale now has synthetic browser coverage with 320 source novels in a bounded app-like viewport, confirming the virtual grid path keeps mounted cards bounded and opens the correct novel through the lazy resolver.
  - Remaining risk is only real-data tuning under a larger live Books/Novel shelf and slower disks/network caches.
- Comics and Books update flows are now more similar at the orchestration level, but they use different canonical backends:
  - Comics: Suwayomi and `fetchChapters`.
  - Books/Novels: LNReader-style local runtime/source plugins.
- The Reader HUD visual redesign is explicitly out of scope for this pass unless a functional bug requires a small fix.

### Still Pending / Known Risk

- The Fast Comics update path has partial real desktop dev-app coverage:
  - titles updated in the latest smoke and produced real chapter notifications;
  - failures classified correctly for the observed missing-source, source-challenge, timeout, and generic source errors;
  - Recent Activity issue groups were actionable for the observed Comix source challenge;
  - the latest dev smoke confirmed active progress at `349/633 - 55%`;
  - update completion/final-state still needs to be observed after a full live run;
  - CPU/Java load still needs a release/no-watch measurement.
- Update toast can still show confusing states near completion or while waiting on slow sources; live mid-run progress was verified, but final settle/close still needs real-run validation.
- Manual, automatic, and "Update All Libraries" need stress testing:
  - repeated clicks;
  - mixed Comics/Books update clicks;
  - cancel/close modal behavior;
  - navigation during update.
- Library/Home/Browse/Sources must be checked after update to verify they all reflect updated data.
- Cloudflare challenge handling has classifier/retry plumbing and guarded Recent Activity retry actions, but still needs broader real-source validation:
  - verify source challenge detection for multiple Comics and Books sources;
  - verify source-level actions are useful;
  - verify Suwayomi WebView fallback still writes usable Comics cookies;
  - verify retry only affects the blocked source/titles.
- Comics cover fallback is unit/browser tested for one controlled retry and then a stable placeholder until URL/manual recovery changes.
- Books/Novels source covers have synthetic large-shelf browser coverage for the lazy virtualized path; they still need real-data cover stress validation when a sufficiently large live Books/Novel shelf is available.
- Library keep-alive/virtualization has real dev-app smoke coverage and still needs release/no-watch measurement:
  - confirmed primary navigation across Home, Library, Browse, Downloads, and Settings in the real dev WebView;
  - confirmed Library long-scroll positions load visible cards at top/middle/deep/near-bottom without an empty grid;
  - confirmed long scroll keeps DOM cards bounded in the audited real dev run;
  - confirm retained decoded cover memory stays acceptable after visiting all major pages.
- Books/Comics tab switching is fixed for the current real dev data and now keeps both tab bodies mounted. Latest dev-app smoke measured about 150-170 ms for tab changes while an update was active. Synthetic browser coverage now exercises a 320-entry source novel shelf; only a larger live Books/Novel shelf smoke remains when real data is available.
- The Activity/notification overlay close-on-navigation is implemented, unit-tested, and checked in the real dev WebView after reload.
- Browse > Sources extension install/search/update/remove passes the current component/unit coverage; it still needs a final desktop audit against a live Suwayomi instance.
- PDF Reflow is now opt-in and trims retained reflow pages; it still needs release QA and a final PDF TTS policy check on real PDFs.
- TTS still needs real release audio QA, stable voice/rate persistence, and native OS voice discovery only if WebView voices remain insufficient.
- Downloads/data paths, release-data isolation, bulk actions, and fullscreen escape pass current code/test audit; remaining work is real download/offline/cache-cleanup smoke in desktop release data.
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
