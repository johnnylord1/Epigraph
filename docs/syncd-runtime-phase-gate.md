# Syncd Runtime Phase Gate

## Scope
This gate covers the current `aethon-syncd` core phase only:

- sidecar-compatible desktop launch
- HTTPS local boot
- `/v1/capabilities`
- `/v1/events`
- `/v1/changes`
- replay, reconnect, and expired replay window behavior
- token/profile/scope isolation
- explicit SSE lag handling
- SQLite connection discipline and replay GC behavior

Out of scope for this gate:

- `/mutations`
- owner transfer endpoint
- QR pairing
- mDNS full flow
- mobile client work
- UI redesign

## Files Audited
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.dev.conf.json`
- `src-tauri/src/syncd_main.rs`
- `src-tauri/src/syncd/app.rs`
- `src-tauri/src/syncd/config.rs`
- `src-tauri/src/syncd/db.rs`
- `src-tauri/src/syncd/middleware.rs`
- `src-tauri/src/syncd/replay.rs`
- `src-tauri/src/syncd/tls.rs`
- `src-tauri/src/syncd/routes/capabilities.rs`
- `src-tauri/src/syncd/routes/events.rs`
- `src-tauri/src/syncd/routes/health.rs`
- `src-tauri/src/syncd/routes/audit.rs`
- `src-tauri/src/syncd_sidecar.rs`
- `scripts/prepare-syncd-sidecar.mjs`
- `scripts/run-syncd-phase-gate.ps1`
- `scripts/capture-syncd-sse.mjs`

## Commands Run

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --bin aethon-syncd
```

```powershell
node .\scripts\prepare-syncd-sidecar.mjs
```

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-syncd-phase-gate.ps1
```

## Runtime Evidence

### Sidecar packaging and lifecycle
- Tauri sidecar registration is wired through `bundle.externalBin = ["binaries/aethon-syncd"]`.
- Desktop launch path uses `app.shell().sidecar("aethon-syncd")` and matches the packaged sidecar name.
- Readiness is proven through `GET /healthz` before the app records the phase-gate status file.
- The runtime phase-gate script launched the real desktop binary and reported:
  - endpoint `https://127.0.0.1:47771`
  - stable TLS fingerprint `65b37a9b911ec1444ba2117179475415b1151ea58beb85c6a83f2c36ad62e56e`
- Graceful app exit was proven twice. The script verified the syncd PID was gone after shutdown.
- `tmp/syncd-phase-gate/data/syncd-sidecar.log` contains `shutdown requested by app`, confirming the desktop-side shutdown path ran.

### HTTPS and handshake
- `GET /v1/capabilities` without version headers returned `400`.
- `GET /v1/capabilities` with incompatible protocol returned `426`.
- `GET /v1/capabilities` with compatible client returned `200`.
- Restart with the same syncd data dir preserved the TLS certificate fingerprint across boots.

### Replay, reconnect, and JSON fallback
- `GET /v1/events` kept the connection alive and emitted `event: ping`.
- `tmp/syncd-phase-gate/events-handoff.log` proves backlog-to-live handoff:
  - replayed `id: 1`
  - stayed open long enough to emit `event: ping`
  - delivered live `id: 2`
- `tmp/syncd-phase-gate/events-reconnect.log` proves reconnect replay from `Last-Event-ID: 2`:
  - delivered `id: 3`
  - delivered `id: 4`
- The runtime harness also proved expired replay window enforcement:
  - `/v1/changes?sinceVersion=3` returned `409`
  - `/v1/events` with `Last-Event-ID: 3` returned `409`

### Auth, token activity, and scope isolation
- Valid token + `books:global` works for both `main` and `test` profile tokens.
- Valid token + `novels:profile:main` works for the `main` token.
- `main` token against `novels:profile:test` returned `403`.
- Missing bearer token against `/v1/changes` returned `401`.
- Revoked token could not open `/v1/events`.
- Inactivity-expired token could not open `/v1/events`.
- The harness also verified successful authenticated use refreshed `last_seen_at_ms`.

### SSE lag/backpressure
- Live lag is now explicit and non-silent:
  - on `tokio::sync::broadcast` lag, the server emits `event: replay_required`
  - includes `reasonCode = LIVE_STREAM_LAGGED`
  - closes the stream instead of pretending live sync remained lossless
- This behavior is covered by the automated test:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --bin aethon-syncd
```

with the case:
- `syncd::app::tests::events_emit_replay_required_when_live_receiver_lags`

### SQLite discipline
- SQLite is opened with:
  - WAL
  - `foreign_keys = ON`
  - `busy_timeout = 5000`
  - `synchronous = NORMAL`
- Connection discipline is enforced in two places:
  - connect options
  - explicit `after_connect` PRAGMA setup
- Replay retention GC runs on startup and hourly thereafter.
- `min_replayable_server_version` is recalculated from retained `change_log` rows.

## Defects Found During Audit

### 1. Backlog/live gap in SSE subscription order
Found by code inspection.

Problem:
- `/v1/events` prepared replay before subscribing to the broadcast channel.
- A change could land after the snapshot/backlog query and before live subscription.

Fix:
- subscribe to the broadcast channel before replay preparation
- keep filtering live events to versions strictly greater than the snapshot

### 2. SSE capture harness was not reliable on PowerShell 5.1
Problem:
- the old `curl.exe` capture helper buffered poorly and did not give deterministic file output for runtime proof

Fix:
- replaced the runtime SSE harness with `scripts/capture-syncd-sse.mjs`
- runtime proof now reads the SSE stream directly with Node fetch

### 3. SQLite connection PRAGMAs were not explicit enough on every pooled connection
Problem:
- connect options were present, but the phase required explicit per-connection discipline

Fix:
- added `after_connect` PRAGMA enforcement in `src-tauri/src/syncd/db.rs`

### 4. Sidecar orphan risk on unexpected parent disappearance
Problem:
- graceful shutdown was covered, but abrupt parent disappearance was a real lifecycle risk

Fix:
- syncd now accepts `AETHON_SYNCD_PARENT_PID`
- a parent watchdog exits syncd when the parent process disappears

## Remaining Limits
- `/mutations` is still intentionally out of scope.
- Owner transfer final flow is still intentionally out of scope.
- Runtime lag was proven by explicit automated test, not by forcing a production-sized live channel to overflow in the desktop harness.
- The Windows/Tauri build environment still emits unrelated frontend/build noise during phase-gate runs. This did not invalidate the assertions above, but it is worth keeping an eye on.

## Gate Decision
**Pass**

Why:
- sidecar-compatible desktop launch was proven with the real app binary
- HTTPS local boot was proven end-to-end
- `/v1/capabilities`, `/v1/events`, and `/v1/changes` were proven in runtime
- replay, reconnect, and expired replay window behavior were proven
- lag/backpressure is now explicit and tested
- token/profile/scope isolation was proven
- the dangerous SSE handoff gap was fixed before closing the gate
