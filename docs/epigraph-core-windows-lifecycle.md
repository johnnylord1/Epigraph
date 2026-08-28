# Epigraph Core Windows lifecycle

The Windows Core is a current-user daemon. Closing the Epigraph desktop window only detaches the desktop client; it does not terminate a persistent Core.

## Commands

- `epigraph-syncd.exe serve --lan` starts the persistent LAN Core.
- `epigraph-syncd.exe shutdown --reason <manual|restart|pre-update|uninstall>` performs an authenticated shutdown and waits for the process to exit.
- `epigraph-syncd.exe autostart install|remove|status` manages only `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Epigraph Core`.

The shutdown client reads `runtime.json`, pins its TLS certificate fingerprint, verifies the discovery descriptor's `serverId`, obtains a loopback-only local-authority token, submits the expected PID, and waits for both the manifest and process to disappear. The server stops mDNS, drains Axum with a bounded grace period, and closes SQLite before releasing the runtime manifest and process lock.

No command deletes the Core database, certificates, paired-device state, imported content, downloads, or Suwayomi data.

## Installer behavior

`src-tauri/windows/epigraph-core-hooks.nsh` is configured as the Tauri NSIS installer hook file. Pre-update and pre-uninstall stop the identified Core and Epigraph-owned Suwayomi processes before installed binaries are changed. Failure aborts before file replacement or removal. Post-install registers current-user autostart and starts the Core; an autostart registration failure is logged but does not roll back an otherwise valid installation.

The release gate is:

```powershell
pnpm syncd:prepare-sidecar:release
pnpm tauri:build
```

The sidecar preparation step builds the release binary, verifies it is not a placeholder, runs a command-line smoke check, and copies the target-triple binary expected by Tauri.

## Suwayomi ownership boundary

At startup, Core can attach lifecycle metadata for an already-running Suwayomi whose `server.owner.json`, loopback endpoint, PID, Java executable, and exact `rootDir` argument agree. During update/uninstall it stops only such validated owned processes.

The persistent Core now starts or reattaches the main owned Suwayomi profile without a Tauri `AppHandle`. The shared Rust supervisor resolves the managed or bundled JAR relative to `epigraph-syncd.exe`, prefers `javaw.exe`, applies `CREATE_NO_WINDOW`, reuses the existing `server.owner.json` identity contract, and coordinates with the desktop through `server.spawn.lock`. Readiness requires the exact rootDir process and the expected loopback listener; a foreign process or occupied port is reported but never terminated.

Headless startup is deliberately limited to an existing managed profile. A directory with managed evidence (`server.conf`, H2 data, extensions, or an owner manifest) may be recovered after login; an absent profile is not created. Remote and shared Suwayomi endpoints remain external dependencies and are never started, restarted, or stopped by this supervisor. Persistent startup runs in the background so Core pairing and non-Suwayomi domains remain available while Suwayomi becomes ready.

## Mobile consumer contract

After pairing, Epigraph Mobile (built on the Hayai foundation) does not connect directly to the
Suwayomi loopback port. It uses authenticated, profile-scoped Core routes:

- `/v1/suwayomi/catalog` for paged library, categories and chapter snapshots;
- `/v1/suwayomi/extensions` for the loaded extension inventory;
- `/v1/suwayomi/commands` for the allowlisted library/category/progress writes;
  category lifecycle writes use the official `UpdateCategory`,
  `UpdateCategoryOrder` and `DeleteCategory` mutations and are accepted only
  after a read-back confirmation;
- `/v1/suwayomi/content` for the fixed `FetchManga`, `FetchChapters` and
  `FetchChapterPages` operations;
- `/v1/suwayomi/resource/*` for authenticated covers and reader assets.

The Core validates the paired device and `comics:profile:<profileId>` scope,
constructs the upstream GraphQL documents itself and rejects unknown
operations or variables. Mobile callers cannot submit arbitrary GraphQL or
reach the Suwayomi loopback endpoint directly. Operations which may refresh
source-owned state use the same maintenance lease as desktop mutations.

This makes the desktop window optional after pairing, but not the PC itself:
the PC user session and Core/Suwayomi processes must be alive for online comic
catalog and chapter operations. Cached/downloaded content and the mobile
outbox remain usable while the PC is offline. Once a managed profile has been
created by the desktop, Core autostart can restore it after a fresh Windows
login without launching the desktop UI.

## Real mobile smoke (2026-08-09)

The updated Core and mobile development APK were exercised against the real
profile without opening a desktop UI. The mobile worker completed, paged a
library larger than 600 entries, converged categories, loaded authenticated
covers and opened current details and chapters through `EpigraphCoreSource`.

Two reader outcomes were distinguished correctly:

- a source which reports that chapter pages are no longer provided returned
  the same error through direct Suwayomi GraphQL and through Core;
- an Asura Scans title returned seven pages and opened a real reader page
  through the authenticated resource route.

Catalog summaries now remain `initialized = false` until the first full detail
hydration. The runtime smoke confirmed author, artist, status, description,
genres and 25 chapters after opening the Asura title.

The installed Core release binary was updated and matched the compiled
SHA-256. Windows retained an orphan TCP listener for the terminated process on
port 4777, so the validated Core instance used port 4778 temporarily. No
unknown process was killed and autostart remains configured for the default
port. Reclaiming 4777 after a Windows restart remains an environmental gate;
it is not evidence of a catalog, authentication or content-bridge failure.

Reader progress was also validated end to end. The Android reader advanced a
real seven-page chapter and the upstream Suwayomi chapter changed from
`lastPageRead = 0` to `3`, then to `5`, through the typed Core command route.
The mobile identity parser accepts the current server-scoped identity while
retaining the Legacy profile-scoped form. Rapid progress writes remain durable
in SQLDelight but their WorkManager wake is debounced; outbox-only wakes skip
the full catalog replica, preventing a catalog refresh for every reader page.

The explicit offline flow was also exercised. Chapter `1057` was downloaded
through the mobile UI, the test proxy was removed, and the reader reopened the
local CBZ while Core was unreachable from the emulator. Seven upstream pages
became eleven display images because the existing tall-image preference split
some files. Mobile now preserves the display-segment index locally while
sending the original source-page index through the typed Core command. This
prevents offline reading from writing an out-of-range Suwayomi progress value.
