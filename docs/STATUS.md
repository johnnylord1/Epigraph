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
- **Settings Screen Panes**: IN PROGRESS. Requires methodical DOM mapping per settings category.

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

## Reference Docs
- Historical refactor detail: [`docs/LIBRARY_SHARED_SHELL_REFACTOR.md`](docs/LIBRARY_SHARED_SHELL_REFACTOR.md)
