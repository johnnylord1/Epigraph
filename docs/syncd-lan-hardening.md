# Syncd LAN Hardening

## Contract
This document freezes the temporary-session LAN exposure contract for the current phase.

### Defaults
- default state is **loopback only**
- no local-managed Suwayomi profile should remain LAN-exposed by accident across restart
- Books scope remains global and is unrelated to this hardening work

### Temporary LAN session rules
- LAN exposure is represented by `suwayomi-lan-session.json` in the profile root
- a session is valid only when all of the following match:
  - profile key matches the effective profile
  - expiry is still in the future
  - `owner_app_pid` matches the current desktop process
- invalid or stale session state must collapse back to loopback
- selected profile may temporarily use `0.0.0.0`
- other local profiles must remain loopback-only

### Session end conditions
- app shutdown
- expired TTL
- stale startup state
- profile mismatch

### Cleanup behavior
- on session end, the desktop app:
  - removes the temporary session file
  - rewrites `server.conf` back to loopback
  - stops the app-owned managed Suwayomi instance for that profile so the next spawn comes back on loopback

## Files Involved
- `src-tauri/src/suwayomi_lan.rs`
- `src-tauri/src/lib.rs`
- `scripts/run-syncd-lan-hardening.ps1`

## Implementation Summary

### State model
`src-tauri/src/suwayomi_lan.rs` now owns the temporary LAN session record:
- `TemporaryLanExposureSession`
- `load_and_sanitize()`
- `read_session()`
- `start_temporary_session()`
- `clear_temporary_session()`
- `bind_host_for_mode()`

### App wiring
`src-tauri/src/lib.rs` now:
- sanitizes Suwayomi LAN state on startup
- seeds `server.conf` with either loopback or temporary LAN bind
- clears temporary session state on app exit
- schedules expiry watchers for valid temporary sessions

### Runtime-only harness hooks
To avoid touching real user data during this phase gate, the app now supports harness overrides:
- `AETHON_LOCAL_SERVER_MAIN_ROOT`
- `AETHON_LOCAL_SERVER_TEST_ROOT`
- `AETHON_PHASE_GATE_TEMPORARY_LAN_PROFILE`
- `AETHON_PHASE_GATE_TEMPORARY_LAN_TTL_SECONDS`
- `AETHON_PHASE_GATE_TEMPORARY_LAN_HOST`
- `AETHON_PHASE_GATE_TEMPORARY_LAN_REASON`

These are phase-gate hooks, not a user-facing product flow.

## Commands Run

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-syncd-lan-hardening.ps1
```

## Runtime Evidence

### Default startup collapses to loopback
The harness created isolated `main-root` and `test-root` server configs that started at `0.0.0.0`.

After desktop startup:
- `tmp/syncd-lan-hardening/main-root/server.conf` was rewritten to `server.ip = "127.0.0.1"`
- `tmp/syncd-lan-hardening/test-root/server.conf` was rewritten to `server.ip = "127.0.0.1"`

### Temporary session enables only the selected profile
The harness started a temporary session for `main`.

Observed:
- `main-root/server.conf` switched to `server.ip = "0.0.0.0"`
- `test-root/server.conf` remained `server.ip = "127.0.0.1"`
- a valid `main-root/suwayomi-lan-session.json` was created for the active desktop PID

### TTL expiry now performs real cleanup
The harness used a short TTL.

Observed before shutdown:
- the temporary session file disappeared after TTL expiry
- `main-root/server.conf` returned to `server.ip = "127.0.0.1"`

This is important: the cleanup now happens during the same desktop session, not only on next boot.

### Stale and mismatched session state is rejected
The harness wrote invalid state manually and restarted the app.

Observed:
- expired session file was removed
- profile-mismatched session file was removed
- affected `server.conf` files were rewritten back to loopback

### Shutdown cleanup remains in place
The harness also verified app shutdown still clears the temporary session state and leaves loopback config behind.

## Edge Cases Handled
- missing session file -> loopback
- malformed session file -> file removed, loopback
- expired session file -> file removed, loopback
- owner PID mismatch -> file removed, loopback
- profile mismatch -> file removed, loopback
- selected profile temporary session does not leak into the other builtin local profile

## Residual Risk
- The user-facing control surface for starting/stopping temporary LAN exposure is not implemented in this phase.
- The harness pre-cleans lingering repo-bundled Suwayomi Java processes to avoid false negatives from previous local dev runs.
- Expiry cleanup stops the app-owned managed server for the affected profile. That is intentional for safety, but it means temporary exposure expiry can interrupt a running local server session.

## What This Does Not Add
- QR pairing
- mDNS full flow
- remote exposure
- persistent always-on LAN mode
- profile hot-switching

## Gate Decision
**Pass**

Why:
- default state is loopback-only
- temporary LAN exposure is session-scoped
- cleanup happens on startup, expiry, mismatch, and shutdown
- profile leakage was explicitly checked
- no accidental persistent LAN exposure remained in the audited runtime paths
