# Splash Gate Restoration Report

Date: 2026-04-08
Repository: `C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon`

## Objective

Restore the global gate infrastructure required to truthfully evaluate the already-ported Splash phase, without starting Settings or touching any later UI phase.

## Commands Baseline

### Global diagnostics path

Command:

```powershell
.\node_modules\.bin\svelte-check.CMD
```

Observed before gate fixes:

- `147 errors`
- `47 warnings`
- `44 files`

Observed after gate fixes:

- `143 errors`
- `46 warnings`
- `42 files`

Evidence files:

- `.phase-gate-svelte-check.log`
- `.phase-gate-svelte-check-rerun.log`
- `.phase-gate-svelte-check-rerun2.log`

### Splash local validation

Commands:

```powershell
.\node_modules\.bin\vitest.CMD run --project shell-jsdom src/components/layout/SplashScreen.test.ts
.\node_modules\.bin\vitest.CMD run --project browser-components src/components/layout/SplashScreen.browser.test.ts
```

Observed before gate fixes:

- jsdom: pass
- browser screenshots: pass

Observed after gate fixes:

- jsdom: pass (`4/4`)
- browser screenshots: pass (`2/2`)

Evidence files:

- `.phase-gate-splash-jsdom.log`
- `.phase-gate-splash-browser.log`
- `.phase-gate-splash-jsdom-rerun2.log`
- `.phase-gate-splash-browser-rerun2.log`

### Tauri runtime sanity path

Command:

```powershell
npm exec pnpm -- tauri:dev
```

Observed before gate fixes:

- Vite/Tauri path did not reliably reach a usable real window
- `beforeDevCommand` depended on `pnpm` being directly available in PATH
- frontend build could be blocked before the real Splash sanity pass

Observed after gate fixes:

- Vite starts on `http://127.0.0.1:1420`
- Rust side launches `target\debug\aethon.exe`
- real Tauri window opens
- test profile server becomes healthy in runtime

Evidence files:

- `.phase-gate-tauri-dev.log`
- `.phase-gate-tauri-dev-rerun.log`
- `.phase-gate-tauri-window.png`
- `.phase-gate-tauri-window-ready.png`
- `%APPDATA%\aethon\test-app-driven-startup.log`

## Blocker Table

| ID | Triggering command | Layer | Scope | Severity | Minimal fix | Status |
| --- | --- | --- | --- | --- | --- | --- |
| B001 | `npm exec pnpm -- tauri:dev` | Tauri config / dev wiring | infra/config | hard block | replace fragile `beforeDevCommand` with direct Node+Vite invocation | resolved |
| B002 | `npm exec pnpm -- tauri:dev` | frontend build | unrelated but gate-blocking | hard block | mark TS module scripts with `lang="ts"` so Vite/esbuild can parse them | resolved |
| B003 | `npm exec pnpm -- tauri:dev` | runtime observability | cross-workspace | hard block for attribution | emit per-profile startup logs so test-profile boot can be audited | resolved |
| B004 | `.\node_modules\.bin\svelte-check.CMD` | Svelte diagnostics | Splash-local | hard block for attribution | add Vite type reference for asset imports and widen `splashRoot` binding type | resolved |
| B005 | `.\node_modules\.bin\svelte-check.CMD` | Svelte diagnostics | cross-workspace | soft block / baseline noise | existing repo-wide TS/Svelte debt in non-Splash files | external, still present |
| B006 | `npm exec pnpm -- tauri:dev` | runtime environment | unrelated but gate-blocking | hard block when present | clear stale repo-scoped Java sidecar processes locking the bundled server target | operational, resolved during sanity run |

## Exact Owning Files

### Resolved hard blockers

- `src-tauri/tauri.dev.conf.json`
  - fixed dev boot wiring by replacing `pnpm dev` with direct Vite startup:
    - `node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1420`

- `src/components/pages/MigrateModal.svelte`
  - corrected `<script module>` to `<script module lang="ts">`

- `src/components/shared/TrackingPanel.svelte`
  - corrected `<script module>` to `<script module lang="ts">`
  - removed one unused `.hidden` selector from a touched file to avoid carrying a new warning

- `src/components/pages/Tracking.svelte`
  - corrected `<script module>` to `<script module lang="ts">`

- `src-tauri/src/lib.rs`
  - changed startup diagnostics so all profiles, including `test`, emit app-driven spawn logs

- `src/components/layout/SplashScreen.svelte`
  - changed `splashRoot` from `HTMLDivElement | null` to `HTMLElement | null` so the same ref can legally bind to both the idle `<button>` shell and the non-dismissible `<div>` shell

- `src/vite-env.d.ts`
  - added `/// <reference types="vite/client" />` so Vite asset imports used by Splash resolve in global diagnostics

### Remaining external baseline debt

Representative non-Splash owners still present in global diagnostics:

- `src/lib/books/assets.ts`
- `src/lib/backup/aethonBackup.ts`
- `src/lib/backup/mangaBackup.ts`
- `src/lib/backup/mihonBackup.ts`
- `src/lib/backup/aethonRestorePlanner.ts`
- `src/components/shared/MangaPreview.svelte`
- `src/App.svelte`
- `src/routes.ts`
- `src/components/pages/Tracking.svelte`
- several test files under `src/components/library/` and `src/lib/`

These still fail diagnostics, but they are not caused by Splash and no longer prevent the real Splash sanity pass from running.

## Minimal Fix Set

Only these files were changed to restore the blocked gates:

1. `src-tauri/tauri.dev.conf.json`
   - necessary to boot Tauri reliably in this environment
   - broader build-tool changes were avoided

2. `src-tauri/src/lib.rs`
   - necessary to make the `test` profile observable during the runtime sanity gate
   - no backend behavior was redesigned

3. `src/components/pages/MigrateModal.svelte`
4. `src/components/shared/TrackingPanel.svelte`
5. `src/components/pages/Tracking.svelte`
   - necessary because existing invalid `script module` typing blocked the frontend build path before the real window could be validated
   - no UI behavior was changed

6. `src/components/layout/SplashScreen.svelte`
7. `src/vite-env.d.ts`
   - necessary to remove the last Splash-attributed global diagnostics failures
   - no Splash visual/behavior change was made

Broader cleanup was intentionally avoided.

## Gate Rerun Evidence

### Splash smoke

Command:

```powershell
.\node_modules\.bin\vitest.CMD run --project shell-jsdom src/components/layout/SplashScreen.test.ts
```

Result:

- pass
- `4/4 tests`

### Splash browser screenshot

Command:

```powershell
.\node_modules\.bin\vitest.CMD run --project browser-components src/components/layout/SplashScreen.browser.test.ts
```

Result:

- pass
- `2/2 tests`

### Tauri runtime sanity

Command:

```powershell
npm exec pnpm -- tauri:dev
```

Result:

- Vite dev server started successfully
- Rust app launched successfully
- real `aethon.exe` window opened
- bundled Java sidecar launched successfully
- test profile became healthy in runtime

Runtime evidence from `%APPDATA%\aethon\test-app-driven-startup.log`:

- `Listening on http://127.0.0.1:4667/`
- `probeOk=true`
- `listenerMatchesChild=true`
- `owner published pid=... server.owner.json`

### Webview / runtime console health

Observed during Tauri sanity reruns:

- no new unhandled promise rejections were surfaced
- no new Splash-specific frontend runtime errors appeared
- remaining visible runtime noise in `tauri:dev` output came from pre-existing `vite-plugin-svelte` warnings in non-Splash files:
  - `src/components/layout/Toaster.svelte`
  - `src/components/reader/Reader.svelte`
  - `src/components/settings/Settings.svelte`
  - `src/components/pages/SeriesDetail.svelte`
  - `src/components/pages/Search.svelte`
  - `src/components/pages/Extensions.svelte`

These warnings predate the Splash gate restoration work and do not originate from Splash.

### Global diagnostics delta

Before gate restoration:

- `147 errors`
- `47 warnings`
- `44 files`

After gate restoration:

- `143 errors`
- `46 warnings`
- `42 files`

Splash-specific result:

- `SplashScreen.svelte` no longer appears in `svelte-check`
- the remaining diagnostics set is external to Splash

## Final Gate Decision Basis

Splash now satisfies the strict gate sequence because:

1. local smoke passes
2. browser screenshot parity passes
3. Tauri runtime opens a usable real app window
4. Splash can be validated in the real runtime
5. no new Splash-specific diagnostics remain
6. remaining workspace noise is baselined and external to Splash

The repo is **not globally clean**, but Splash is no longer the source of the remaining global gate noise.
