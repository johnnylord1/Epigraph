# Trilha do Syncd - Client-Facing Discovery / Fallback Contract Surface Phase Gate

## Scope

This slice adds one stable client-facing discovery contract on top of the existing:
- advertised endpoint resolver
- discovery descriptor
- provider layer
- manual provider
- effective discovery policy

Entered scope:
- a typed read-only client-facing discovery contract route
- canonical effective origin exposure for future clients
- deduped candidate set with usage hints
- safe capability flags for bootstrap and live pairing
- runtime proof that descriptor, bootstrap, and client contract share the same canonical truth

Stayed out of scope:
- UI
- mobile flow
- client implementation
- richer ranking UX
- books serving
- owner transfer
- full sync bootstrap/replication

## What changed

- Added client-facing discovery contract models in `src-tauri/src/syncd/models.rs`
- Added a client contract builder in `src-tauri/src/syncd/discovery.rs`
- Added the route:
  - `/v1/discovery/client-contract`
- Kept low-level descriptor and provider status routes intact
- Kept bootstrap and live pairing contracts intact

## Why a client-facing contract is needed now

Syncd already has the backend ingredients for discovery:
- descriptor truth
- provider state
- effective discovery policy

Future clients should not have to reinterpret raw provider internals or invent fallback heuristics.

This slice gives them one stable backend contract that says:
- what is canonical
- what is fallback
- which provider/source sits behind each candidate
- which pairing/bootstrap capabilities are available

## Canonical vs fallback candidates

Current usage hints:
- `canonical`
- `fallback`
- `informational` is reserved in the type system for future use

Rules:
- the chosen effective origin becomes the canonical candidate
- other normalized candidates become fallback candidates
- candidate provider metadata is safe and compact:
  - `manual-endpoint`
  - `lan-publication`

The contract stays separate from raw provider state; it summarizes only the safe client-consumable view.

## Normalization and deduplication

Origins are normalized first:
- `https` only
- host required
- port required
- no path/query/fragment

Equivalent origins are deduplicated before reaching the client-facing contract.

Examples:
- `https://localhost:4778/` -> `https://localhost:4778`
- duplicate normalized manual entries collapse in the client contract candidate set

## Failure / fallback containment

Invalid manual provider config remains contained:
- manual provider can report `failed`
- canonical client contract output falls back to advertised origin deterministically
- bootstrap still works
- live pairing still works

No trust-bearing token is exposed in:
- client discovery contract
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
- bootstrap:
  - `tmp/syncd-discovery-phase-gate/bootstrap-created.json`
  - `tmp/syncd-discovery-phase-gate/bootstrap-created-invalid-manual.json`
- live pairing compatibility:
  - `tmp/syncd-live-pairing-phase-gate/bootstrap-created.json`
  - `tmp/syncd-live-pairing-phase-gate/pairing-live-events.json`

Observed:
- client contract route worked in runtime
- canonical client contract origin matched descriptor and bootstrap
- valid manual provider became canonical under `manual-preferred`
- invalid manual provider fell back cleanly to advertised origin
- alternative candidates remained visible in safe summarized form
- live pairing continued to work after client-contract wiring

## Remaining for actual client UX / consumption

- client-side policy for when to try canonical vs fallback candidates
- user-facing presentation of discovery candidates
- any richer ranking/selection experience

## Remaining for broader sync bootstrap / replication

- client-side bootstrap orchestration beyond pairing/bootstrap
- full sync bootstrap/replication work

## Gate

PASS

Reason:
- syncd now exposes one stable client-facing discovery/fallback contract
- canonical and fallback candidates are explicit
- canonical output stays aligned across descriptor, bootstrap, and client contract
- failure remains contained
- bootstrap and pairing trust boundaries stayed intact
