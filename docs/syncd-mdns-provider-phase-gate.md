# Trilha do Syncd - mDNS / DNS-SD Provider Phase Gate

## Scope

This slice turns the existing `lan-publication` discovery provider from backend-only state into real mDNS / DNS-SD service publication.

Entered scope:
- real mDNS / DNS-SD publisher startup for the `lan-publication` provider
- typed TXT/publication metadata derived from the existing discovery descriptor
- runtime handle ownership inside the discovery provider layer
- failure containment for publisher startup/runtime errors
- runtime proof that bootstrap and live pairing still work after publisher wiring

Stayed out of scope:
- discovery UI
- mobile flows
- QR rendering
- manual-IP UX/policy
- books serving
- owner transfer
- full sync bootstrap/replication

## What changed

- Added `mdns-sd` as the first real discovery transport dependency
- Added a real publisher runtime handle to the provider layer in `src-tauri/src/syncd/discovery.rs`
- Added typed published TXT metadata in `src-tauri/src/syncd/models.rs`
- Added configurable mDNS publication port in `src-tauri/src/syncd/config.rs`
- Wired publisher runtime ownership into `AppState`
- Kept `/v1/discovery/descriptor`, bootstrap create/fetch, and live pairing contracts unchanged

## Why mDNS / DNS-SD is the right next slice

We already had:
- a typed discovery descriptor
- a typed advertised endpoint resolver
- a typed provider/status surface

The next smallest real step was to plug an actual LAN publication transport into that provider surface.

That gives us:
- real discoverability backend behavior
- no contract churn in bootstrap or pairing
- a clean seam for later discovery clients to consume

## Descriptor/publication consistency

Publication metadata is built from the existing discovery descriptor.

That means:
- advertised origin still comes from the advertised-endpoint resolver
- server identity still comes from persisted syncd identity
- capability flags stay aligned with the descriptor
- TLS fingerprint hint stays aligned with the descriptor

No second source of truth for public origin was introduced.

## Failure containment

Publisher failure is contained to discovery provider state:
- startup failure -> `failed`
- runtime monitor failure -> `failed`

Contained impact:
- bootstrap create/fetch still works
- live pairing still works
- trust boundary does not move

No final token is published in:
- TXT records
- discovery descriptor
- bootstrap payload

## Commands run

```powershell
cargo test --manifest-path C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\src-tauri\Cargo.toml --bin aethon-syncd
powershell -ExecutionPolicy Bypass -File C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\scripts\run-syncd-discovery-phase-gate.ps1
powershell -ExecutionPolicy Bypass -File C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\scripts\run-syncd-live-pairing-phase-gate.ps1
```

## Runtime evidence

Artifacts:
- discovery descriptor:
  - `tmp/syncd-discovery-phase-gate/discovery-descriptor.json`
- discovery provider status:
  - `tmp/syncd-discovery-phase-gate/discovery-status.json`
- bootstrap payloads:
  - `tmp/syncd-discovery-phase-gate/bootstrap-created.json`
  - `tmp/syncd-discovery-phase-gate/bootstrap-fetched.json`
- bootstrap cache headers:
  - `tmp/syncd-discovery-phase-gate/bootstrap-created.headers.txt`
  - `tmp/syncd-discovery-phase-gate/bootstrap-fetched.headers.txt`
- live pairing compatibility:
  - `tmp/syncd-live-pairing-phase-gate/pairing-live-events.json`

Observed:
- discovery provider reached `active`
- provider status metadata matched descriptor advertised origin
- bootstrap payload still matched the same advertised origin
- live pairing still emitted the expected claimed/approved/final-token-ready sequence after real publisher wiring

## Test coverage added/confirmed

- provider disabled state
- provider startup success
- provider startup failure for invalid service type
- real local mDNS browse/resolve against the published service
- active publication metadata consistency
- safe TXT publication with no token leakage
- bootstrap still works when provider startup fails
- no regression in bootstrap routes
- no regression in live pairing route

## Remaining for manual-IP policy

- a separate manual-IP provider
- policy for choosing between discovery providers
- any user-facing fallback path

## Remaining for broader sync bootstrap / replication

- discovery consumer policy
- broader bootstrap orchestration beyond pairing/bootstrap
- any future full sync startup flow

## Gate

PASS

Reason:
- syncd now performs real mDNS / DNS-SD service publication through the existing provider layer
- publication metadata stays derived from descriptor truth
- provider lifecycle remains typed and observable
- publisher failure remains contained
- bootstrap and pairing contracts stayed intact
