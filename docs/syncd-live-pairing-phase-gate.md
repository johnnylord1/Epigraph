# Trilha do Syncd - Live Pairing Status Channel Phase Gate

## Status

PASS

## What Changed

This slice stayed inside the syncd backend track only:

- added a session-specific live pairing status channel over WebSocket
- kept bootstrap payload unchanged and bootstrap-only
- kept approval and token issuance in the existing pairing/auth flow
- wired claim / approve / reject / expire transitions into typed pairing status events
- kept the live channel limited to pairing lifecycle only

No sync state replication, no discovery rollout, no UI, and no mobile flow were added here.

## Why This Slice Exists Before Discovery UI / Mobile Work

Before any discovery UX or mobile-side screens exist, the backend needs a clean way for a scanning client to observe pairing progress without:

- polling bootstrap fetch repeatedly
- polling claim state with ad-hoc retries
- opening broader sync scope before trust is established

This slice solves that backend gap first:

- QR/bootstrap still only gives the client enough material to start
- the live channel only carries pairing progress
- the final token still comes only from the existing approved claim path

That keeps trust boundaries intact while making pairing progress observable in real time.

## Contract

### Route

`GET /v1/bootstrap/session/:sessionId/live?pairingCode=...`

### Validation

- session must exist
- pairing code must match
- expired session returns `410`
- invalid session returns `404`
- invalid code returns `401`

### Event types

The WebSocket emits typed JSON messages:

- `hello`
- `subscribed`
- `status_changed`
- `approved`
- `rejected`
- `expired`
- `final_token_ready`

### Status lifecycle

Supported states:

- `pending`
- `claimed`
- `approved`
- `rejected`
- `expired`

### Trust boundary

- no final token is embedded in bootstrap payload
- no final token is emitted on the live channel
- `final_token_ready` only means the existing claim path may now return the token
- token still remains profile-bound

## Runtime Evidence

Commands run:

```powershell
cmd /c cargo test --manifest-path C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src-tauri\Cargo.toml --bin aethon-syncd
powershell -ExecutionPolicy Bypass -File C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\scripts\run-syncd-live-pairing-phase-gate.ps1
```

Observed:

- `49` syncd tests passed
- syncd booted over local HTTPS
- bootstrap session creation still worked
- WebSocket subscription connected successfully using bootstrap session identity and pairing code
- live event sequence was captured in:
  - [pairing-live-events.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-live-pairing-phase-gate/pairing-live-events.json)
- pending claim still had no token in:
  - [claim-pending.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-live-pairing-phase-gate/claim-pending.json)
- final token was still only returned after approval in:
  - [claim-approved.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-live-pairing-phase-gate/claim-approved.json)
- bootstrap source payload still stayed bootstrap-only in:
  - [bootstrap-created.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-live-pairing-phase-gate/bootstrap-created.json)

Observed event order:

1. `hello`
2. `subscribed`
3. `status_changed` -> `claimed`
4. `status_changed` -> `approved`
5. `approved`
6. `final_token_ready`

The captured live channel did not contain `accessToken`.

## Tests Added In This Slice

- valid live subscription validation for bootstrap session
- invalid / nonexistent / expired live subscription validation
- claimed event emission
- approved event emission
- rejected event emission
- expired event emission
- no token material on live pairing events
- terminal-close semantics via event-type close markers

## What Still Remains For Discovery

Still intentionally out of scope:

- mDNS / Zeroconf rollout
- manual IP fallback
- discovery policy UI
- exposing multiple advertised endpoint candidates to clients

The later discovery slice can reuse:

- advertised endpoint resolution
- bootstrap create/fetch
- live pairing status channel

without redesigning pairing again.

## What Still Remains For Full Sync Bootstrap / Replication

Still intentionally out of scope:

- sync bootstrap beyond pairing
- state snapshot transport
- live sync replication
- books asset serving
- owner/file semantics

This slice only transports pairing progress, not sync data.

## Gate Decision

PASS

Reason:

- the scanning side can now observe pairing progress live
- claim / approval transitions are observable
- final token is still only obtainable after approval through the existing claim flow
- bootstrap semantics and trust boundary remain unchanged
