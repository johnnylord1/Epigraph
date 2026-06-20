# Trilha do Syncd - Discovery Wiring Surface Phase Gate

## Status

PASS

## What Changed

This slice stayed inside the syncd backend track only.

- introduced an explicit typed discovery descriptor surface for syncd
- added a discovery descriptor provider that reuses the already-frozen advertised-endpoint resolver
- exposed a read-only descriptor route:
  - `/v1/discovery/descriptor`
- kept bootstrap create/fetch unchanged
- kept live pairing status unchanged
- preserved the trust boundary:
  - no final token in discovery metadata
  - no final token in bootstrap payload
  - approval still required in the existing pairing flow
- fixed a narrow identity defect so seeded `pending-server-id` is replaced with a real persisted server UUID during `upsert_server_identity`

## Why This Slice Exists Before Real Discovery

Real LAN discovery has not started yet.

This slice exists so later discovery mechanisms can plug into a stable backend description instead of forcing another bootstrap rewrite.

That means future work can add:

- mDNS / DNS-SD advertisement
- manual IP entry policy
- candidate endpoint ranking

without changing:

- bootstrap payload semantics
- pairing claim semantics
- live pairing status semantics

## Descriptor Contract

The new descriptor is explicit and versioned.

Current route:

- `GET /v1/discovery/descriptor`

Current payload fields:

- `descriptorVersion`
- `serverId`
- `serverProtocolVersion`
- `minClientVersion`
- `tlsCertSha256`
- `advertisedOrigin`
  - `baseUrl`
  - `policyName`
- `capabilities`
  - `supportsBootstrapSessionCreate`
  - `supportsBootstrapSessionFetch`
  - `supportsLivePairingStatus`
  - `hasAdvertisedEndpoint`

What it deliberately does **not** contain:

- final access token
- approval bypass
- pairing trust state
- sync state payloads

## How It Reuses Advertised Endpoint Resolution

The discovery descriptor provider resolves its public origin from the same advertised-endpoint layer already used by bootstrap.

That freezes one source of truth:

- **bind address** = where syncd listens
- **advertised origin** = what discovery-facing clients should use

The bootstrap route now derives `syncdBaseUrl` through the same discovery-facing origin helper.

That keeps:

- discovery descriptor
- bootstrap payload

aligned without changing their external contracts.

## Runtime Evidence

Commands run:

```powershell
cargo fmt --manifest-path C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src-tauri\Cargo.toml
cargo test --manifest-path C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src-tauri\Cargo.toml --bin aethon-syncd
powershell -ExecutionPolicy Bypass -File C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\scripts\run-syncd-discovery-phase-gate.ps1
powershell -ExecutionPolicy Bypass -File C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\scripts\run-syncd-live-pairing-phase-gate.ps1
```

Observed:

- `56` syncd tests passed
- discovery descriptor resolved the advertised origin from override policy, not raw bind
- bootstrap payload used the same advertised origin
- bootstrap anti-cache headers remained intact
- live pairing status route still passed its existing runtime gate after the discovery changes

Artifacts:

- discovery descriptor:
  - [discovery-descriptor.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-discovery-phase-gate/discovery-descriptor.json)
- descriptor response headers:
  - [discovery-descriptor.headers.txt](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-discovery-phase-gate/discovery-descriptor.headers.txt)
- bootstrap payload created under the same advertised origin:
  - [bootstrap-created.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-discovery-phase-gate/bootstrap-created.json)
- bootstrap fetch under the same advertised origin:
  - [bootstrap-fetched.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-discovery-phase-gate/bootstrap-fetched.json)
- bootstrap anti-cache headers still present:
  - [bootstrap-created.headers.txt](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-discovery-phase-gate/bootstrap-created.headers.txt)
  - [bootstrap-fetched.headers.txt](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-discovery-phase-gate/bootstrap-fetched.headers.txt)
- unchanged live pairing runtime proof rerun after this slice:
  - [pairing-live-events.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-live-pairing-phase-gate/pairing-live-events.json)

## Why Bind != Discovery Origin

The listening socket is not the same thing as the origin a LAN client should bootstrap from.

Examples:

- syncd may bind to `127.0.0.1` while the desired discovery-facing origin is `https://localhost:<port>`
- a future mDNS provider may publish a LAN hostname or interface-specific address
- a future manual-IP policy may choose a human-entered origin without changing the actual bind socket

This slice freezes that distinction into typed backend plumbing before broadcasting/discovery work begins.

## What Remains For The Real Discovery Slice

Still deliberately out of scope:

- mDNS / DNS-SD broadcasting
- manual IP fallback policy
- interface probing and ranking
- candidate advertisement selection policy beyond the current resolver
- any desktop/mobile discovery UX

## What Remains For Full Sync Bootstrap / Replication

Still deliberately out of scope:

- full sync bootstrap orchestration
- books asset serving
- owner semantics / owner transfer
- broader sync replication startup beyond the existing `events` / `changes` / `mutations` contract

## Gate Decision

PASS

Reason:

- syncd now has a typed, versioned, discovery-facing descriptor surface
- the descriptor is derived from the advertised-endpoint resolver, not bind guessing
- no trust-bearing token leaked into discovery metadata
- bootstrap and live pairing contracts remained stable
- runtime proof exists for descriptor output, bootstrap consistency, and live pairing compatibility
