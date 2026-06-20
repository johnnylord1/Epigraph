# Trilha do Syncd - Advertised Endpoint Resolution Phase Gate

## Status

PASS

## What Changed

This slice stayed inside the syncd backend track only:

- introduced an explicit syncd advertised-endpoint resolver
- separated bind address from advertised/bootstrap-facing address
- moved bootstrap payload generation onto the advertised-endpoint resolver
- kept the bootstrap payload shape unchanged
- added strict anti-cache headers to bootstrap create/fetch responses, including expired responses
- extended the runtime harness to prove advertised endpoint behavior in real HTTPS runtime

## Why Bind != Advertised Endpoint

The syncd bind address is only where the server listens locally.
It is not a reliable statement about what a client should use as the bootstrap-facing origin.

Examples of why they diverge:

- the server may bind to `127.0.0.1` while the intended bootstrap origin is `https://localhost:<port>`
- a future discovery policy may prefer a LAN interface over the raw bind host
- future manual-IP or mDNS policies must be able to plug into origin selection without rewriting bootstrap payload generation

This slice freezes that separation early:

- **bind** = listening socket
- **advertised endpoint** = bootstrap-facing origin selected by policy

## Resolver Contract

The resolver is explicit and typed.

Supported internal policies:

- `AutoBind`
- `Override`
- `Candidates`

Current behavior:

- default path uses `AutoBind`
- explicit override uses `AETHON_SYNCD_ADVERTISED_BASE_URL`
- candidate list support exists internally for the future discovery slice, but the current payload contract still returns only one selected origin

The bootstrap payload still returns:

- `pairingSessionId`
- `pairingCode`
- `syncdBaseUrl`
- `claimUrl`
- `profileId`
- `expiresAtMs`
- `tlsCertSha256`
- optional `suwayomiHint`

No final token is embedded.
Approval still happens in the existing pairing flow.

## Cache-Control Behavior

Bootstrap responses now explicitly set:

- `Cache-Control: no-store, max-age=0`
- `Pragma: no-cache`
- `Expires: 0`

This applies to:

- bootstrap create success
- bootstrap fetch success
- expired bootstrap fetch (`410 BOOTSTRAP_SESSION_EXPIRED`)

## Runtime Evidence

Commands run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --bin aethon-syncd
powershell -ExecutionPolicy Bypass -File .\scripts\run-syncd-bootstrap-phase-gate.ps1
```

Observed:

- syncd tests passed with advertised-endpoint coverage
- runtime harness forced:
  - bind: `https://127.0.0.1:47774`
  - advertised endpoint override: `https://localhost:47774`
- bootstrap payload returned the advertised origin instead of the raw bind origin
- claim still used the existing approval-gated pairing flow
- expired bootstrap fetch still returned `410 BOOTSTRAP_SESSION_EXPIRED`
- bootstrap header captures proved the anti-cache headers on:
  - [bootstrap-created.headers.txt](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-created.headers.txt)
  - [bootstrap-fetched.headers.txt](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-fetched.headers.txt)
  - [bootstrap-expired.headers.txt](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-expired.headers.txt)

Payload/runtime artifacts:

- [bootstrap-created.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-created.json)
- [bootstrap-fetched.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-fetched.json)
- [bootstrap-claim-pending.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-claim-pending.json)
- [bootstrap-claim-approved.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-claim-approved.json)
- [bootstrap-expired.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-expired.json)

## What Remains For The Later Discovery Slice

Still deliberately out of scope here:

- mDNS / Zeroconf rollout
- manual IP fallback policy
- interface probing and ranking
- exposing multiple advertised candidates to clients
- dynamic LAN endpoint selection

The later discovery slice should plug policy into the existing resolver instead of reworking bootstrap payload generation again.

## What Remains For The Later Live Pairing Channel Slice

Still deliberately out of scope here:

- websocket or SSE pairing approval status channel
- desktop/mobile live pairing progress updates
- QR rendering or scanner UI

This slice only ensures bootstrap returns a stable advertised origin and remains cache-safe.

## Gate Decision

PASS

Reason:

- bootstrap no longer depends on naive raw bind derivation
- advertised endpoint resolution is explicit and injectable
- payload contract stayed stable
- expired bootstrap behavior stayed correct
- runtime proof exists for advertised origin override and anti-cache headers
