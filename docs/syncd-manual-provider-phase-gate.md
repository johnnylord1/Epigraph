# Trilha do Syncd - Manual-IP Provider / Policy Surface Phase Gate

## Scope

This slice adds the second discovery provider on top of the existing discovery provider layer:
- `manual-endpoint`

Entered scope:
- typed manual discovery provider config
- explicit configured manual origins
- strict validation and normalization for manual origins
- manual provider state folded into the existing discovery status surface
- runtime proof that bad manual config is contained and does not break bootstrap or live pairing

Stayed out of scope:
- UI
- mobile flow
- manual connect screen
- trust shortcut
- full discovery ranking/selection policy
- full sync bootstrap/replication

## What changed

- Added manual discovery provider config in `src-tauri/src/syncd/config.rs`
- Added typed manual provider/publication models in `src-tauri/src/syncd/models.rs`
- Extended the discovery provider manager in `src-tauri/src/syncd/discovery.rs` to evaluate:
  - LAN publication provider
  - manual endpoint provider
- Kept bootstrap routes unchanged
- Kept live pairing route unchanged
- Kept mDNS provider behavior unchanged except for provider-manager integration

## Why the manual provider exists even after mDNS

mDNS is useful when multicast discovery works.

The manual provider exists for the opposite case:
- multicast blocked
- multicast undesired
- operator-controlled explicit endpoint publication

This slice gives the backend an explicit, typed place to represent those fallback origins before any UI/mobile work exists.

## Manual origin validation / normalization

Manual origins are validated with the same strict HTTPS-origin rules already used for discovery-facing origins:
- absolute origin only
- `https` only
- no path
- no query
- no fragment
- host required
- port required

Normalization:
- trailing slash is removed into canonical origin form
- IPv6 literals are normalized into bracketed origin form
- obviously bad input is rejected, not patched into something else

Examples:
- `https://localhost:4777/` -> `https://localhost:4777`
- `https://[::1]:4777` -> `https://[::1]:4777`

## Failure containment

Bad manual provider config does not break the rest of syncd.

Contained behavior:
- LAN publication provider can remain `active`
- manual provider can become `failed`
- bootstrap create/fetch still works
- live pairing still works

No trust-bearing token is exposed in:
- manual provider metadata
- descriptor metadata
- bootstrap payload

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
- status with valid manual provider:
  - `tmp/syncd-discovery-phase-gate/discovery-status.json`
- status with invalid manual provider:
  - `tmp/syncd-discovery-phase-gate/discovery-status-invalid-manual.json`
- bootstrap payloads:
  - `tmp/syncd-discovery-phase-gate/bootstrap-created.json`
  - `tmp/syncd-discovery-phase-gate/bootstrap-fetched.json`
  - `tmp/syncd-discovery-phase-gate/bootstrap-created-invalid-manual.json`
- live pairing compatibility:
  - `tmp/syncd-live-pairing-phase-gate/pairing-live-events.json`

Observed:
- valid manual provider config reached `active`
- manual origins were normalized in provider status
- bad manual provider config reached `failed` while LAN publication remained available
- bootstrap payload still matched the effective advertised/discovery-facing origin
- live pairing still worked after manual provider wiring

## Tests added / confirmed

- valid manual endpoint acceptance
- normalization of accepted manual endpoints
- invalid scheme rejection
- missing host rejection
- invalid port rejection
- IPv6 literal normalization
- contained failure on bad manual config
- no regression in mDNS provider
- no regression in bootstrap routes
- no regression in live pairing route

## Remaining for provider selection / ranking policy

- explicit selection policy between manual provider and LAN publication
- ranked candidate policy
- any future operator policy around preferred provider ordering

## Remaining for broader sync bootstrap / replication

- client-side discovery consumption policy
- broader sync bootstrap orchestration beyond pairing/bootstrap
- full sync bootstrap/replication work

## Gate

PASS

Reason:
- syncd now has a second discovery provider for explicit manual endpoint policy
- manual origins are validated and normalized
- failure remains contained
- bootstrap and pairing contracts stayed intact
