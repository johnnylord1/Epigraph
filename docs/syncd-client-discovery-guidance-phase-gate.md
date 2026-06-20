# Trilha do Syncd - Client Discovery Consumption Guidance Contract Phase Gate

## Scope

This slice adds one narrow, client-facing guidance layer on top of the existing syncd discovery surfaces:
- advertised endpoint resolver
- discovery descriptor
- provider layer
- manual provider
- effective discovery policy
- client-facing discovery contract

Entered scope:
- a typed read-only client guidance route
- canonical-first attempt planning
- ordered fallback attempts
- conservative stop/continue semantics
- runtime proof that descriptor, bootstrap, client contract, and client guidance share the same canonical truth

Stayed out of scope:
- UI
- mobile flow
- client implementation
- richer ranking UX
- books serving
- owner transfer
- full sync bootstrap/replication

## What changed

- Added typed client guidance models in `src-tauri/src/syncd/models.rs`
- Added a guidance builder in `src-tauri/src/syncd/discovery.rs`
- Added the route:
  - `/v1/discovery/client-guidance`
- Kept descriptor, provider status, and client contract routes intact
- Kept bootstrap and live pairing contracts intact

## Why a client guidance contract is needed now

Syncd already exposes:
- canonical discovery truth
- deduped candidates
- safe provider/source metadata

What future clients still need is a backend-approved answer to:
- which candidate should I try first?
- when may I proceed to fallback candidates?
- when must I stop?

This slice gives one stable backend answer without pushing policy into UI or forcing clients to reinterpret raw backend internals.

## Canonical vs fallback attempt planning

The contract now exposes:
- one `canonicalAttempt`
- zero or more ordered `fallbackAttempts`

Current rules:
- the effective origin becomes the canonical attempt
- normalized fallback candidates remain ordered after canonical selection
- informational-only candidates are supported by the type system, but are not emitted yet

Each attempt carries:
- origin
- source/provider metadata
- usage hint
- bootstrap eligibility
- live pairing eligibility
- informational-only flag

## Stop / continue semantics

Current behavior is intentionally conservative:
- `continueOnConnectionFailure = true` only when real fallback attempts exist
- `continueOnTlsMismatch = false`
- `continueOnBootstrapRejection = false`
- `continueOnNotFoundOrExpired = false`

This preserves the trust boundary:
- clients may try another candidate after a connection failure
- clients must not silently continue after TLS mismatch
- clients must not treat bootstrap rejection as a reason to keep probing other candidates

## Normalization and deduplication

Guidance is derived only from already normalized and deduped candidates:
- `https` only
- host required
- port required
- no path/query/fragment

Equivalent origins collapse before they reach the guidance surface.

## Failure / fallback containment

Invalid manual provider config remains contained:
- manual provider can report `failed`
- guidance falls back deterministically to the advertised origin
- bootstrap still works
- live pairing still works

No trust-bearing token is exposed in:
- client guidance
- client contract
- descriptor
- provider status
- bootstrap payload

## Commands run

```powershell
cargo fmt --manifest-path C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src-tauri\Cargo.toml
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
  - `tmp/syncd-discovery-phase-gate/discovery-status-invalid-manual.json`
- client contract:
  - `tmp/syncd-discovery-phase-gate/discovery-client-contract.json`
  - `tmp/syncd-discovery-phase-gate/discovery-client-contract-invalid-manual.json`
- client guidance:
  - `tmp/syncd-discovery-phase-gate/discovery-client-guidance.json`
  - `tmp/syncd-discovery-phase-gate/discovery-client-guidance-invalid-manual.json`
- bootstrap:
  - `tmp/syncd-discovery-phase-gate/bootstrap-created.json`
  - `tmp/syncd-discovery-phase-gate/bootstrap-created-invalid-manual.json`
- live pairing compatibility:
  - `tmp/syncd-live-pairing-phase-gate/bootstrap-created.json`
  - `tmp/syncd-live-pairing-phase-gate/pairing-live-events.json`

Observed:
- client guidance route worked in runtime
- canonical guidance matched descriptor, client contract, and bootstrap
- fallback attempts appeared in deterministic order under `manual-preferred`
- invalid manual provider config fell back cleanly to advertised origin
- live pairing continued to work after guidance wiring

## Remaining for actual client UX / consumption

- user-facing presentation of canonical vs fallback attempts
- client-side retry/backoff behavior on top of this contract
- richer ranking/selection UX

## Remaining for broader sync bootstrap / replication

- broader client bootstrap orchestration beyond pairing/bootstrap
- full sync bootstrap/replication work

## Gate

PASS

Reason:
- syncd now exposes one stable client discovery consumption guidance contract
- canonical and fallback attempt planning are explicit
- stop/continue semantics are conservative and deterministic
- guidance remains aligned with descriptor, bootstrap, and client contract
- bootstrap and pairing trust boundaries stayed intact
