# Trilha do Syncd - Real Discovery Backend Phase Gate

## Scope

This slice adds the first real backend discovery provider layer on top of the existing discovery descriptor surface.

Entered scope:
- typed discovery provider abstraction
- provider lifecycle/status reporting
- first LAN publication provider backend
- published service metadata derived from the discovery descriptor
- runtime proof that descriptor, bootstrap, and live pairing still work after provider wiring

Stayed out of scope:
- mDNS / DNS-SD broadcasting
- manual-IP UX or policy
- QR rendering
- mobile/UI flows
- books file serving
- owner semantics
- full sync bootstrap / replication

## What changed

- Added a pluggable discovery provider manager in `src-tauri/src/syncd/discovery.rs`
- Added typed provider/publication models in `src-tauri/src/syncd/models.rs`
- Added provider config in `src-tauri/src/syncd/config.rs`
- Wired provider startup and state into app state in `src-tauri/src/syncd/app.rs`
- Added read-only provider state route:
  - `GET /v1/discovery/status`
- Kept `GET /v1/discovery/descriptor` stable
- Kept bootstrap create/fetch stable
- Kept live pairing WebSocket stable

## Why this slice exists before discovery UI/manual-IP UX

Bootstrap and pairing already needed a stable backend notion of "what origin should discovery talk about," but we did not yet want to lock in a UX or transport strategy.

This slice creates the backend publication surface first so future discovery providers can plug into:
- one typed descriptor truth
- one typed provider lifecycle
- one typed publication model

That lets future mDNS/manual-IP work attach to existing backend contracts instead of rewriting bootstrap or pairing again.

## How it builds on the discovery descriptor surface

The publication model is built from the existing discovery descriptor, which already resolves:
- server identity
- advertised origin
- protocol/version
- safe capability flags
- TLS fingerprint hint

The provider does **not** invent a second source of truth for public origin.
It wraps the descriptor in publication metadata:
- provider kind
- service type
- instance name
- lifecycle state

## Provider failure containment

Provider failure is contained to `/v1/discovery/status`.

If provider startup fails:
- lifecycle becomes `failed`
- failure code/message are exposed in typed status
- descriptor route still works
- bootstrap create/fetch still works
- live pairing still works

No trust-bearing token material is exposed in descriptor or provider publication status.

## Commands run

```powershell
cargo test --manifest-path C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src-tauri\Cargo.toml --bin aethon-syncd
powershell -ExecutionPolicy Bypass -File C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\scripts\run-syncd-discovery-phase-gate.ps1
powershell -ExecutionPolicy Bypass -File C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\scripts\run-syncd-live-pairing-phase-gate.ps1
```

## Runtime evidence

Artifacts:
- descriptor:
  - `tmp/syncd-discovery-phase-gate/discovery-descriptor.json`
- provider status:
  - `tmp/syncd-discovery-phase-gate/discovery-status.json`
- bootstrap payload:
  - `tmp/syncd-discovery-phase-gate/bootstrap-created.json`
  - `tmp/syncd-discovery-phase-gate/bootstrap-fetched.json`
- bootstrap cache headers:
  - `tmp/syncd-discovery-phase-gate/bootstrap-created.headers.txt`
  - `tmp/syncd-discovery-phase-gate/bootstrap-fetched.headers.txt`
- live pairing compatibility:
  - `tmp/syncd-live-pairing-phase-gate/pairing-live-events.json`

Observed:
- provider state reached `active`
- published origin matched the discovery descriptor origin
- bootstrap payload origin still matched the discovery descriptor origin
- live pairing still emitted the expected claimed/approved/final-token-ready sequence

## Tests added/confirmed

- provider disabled state
- provider active state
- provider startup failure state
- descriptor/publication origin consistency
- bootstrap route still works when provider startup failed
- no token leakage in descriptor/publication payloads
- no regression in bootstrap routes
- no regression in live pairing route

## Remaining for the real discovery slice

- actual mDNS / DNS-SD publication
- manual-IP provider and policy
- candidate ranking / selection policy
- any future cross-subnet policy, if that ever becomes necessary

## Remaining for full sync bootstrap / replication

- discovery transport selection
- client-side consumption policy
- any broader sync bootstrap orchestration beyond pairing/bootstrap

## Gate

PASS

Reason:
- discovery is now provider-backed on the backend side
- provider lifecycle is typed and observable
- provider failure is contained
- bootstrap and pairing contracts stayed intact
