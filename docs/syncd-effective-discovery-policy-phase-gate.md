# Trilha do Syncd - Provider Selection / Effective Discovery Policy Phase Gate

## Scope

This slice adds the narrow backend policy that decides which discovery-facing origin becomes canonical for:
- discovery descriptor output
- bootstrap payload output

Entered scope:
- typed effective discovery policy config
- deterministic effective-origin selection
- normalized origin candidate deduplication
- explicit effective origin/source visibility in discovery status
- runtime proof that valid manual endpoints can win when policy allows it
- runtime proof that invalid manual config falls back cleanly to advertised origin

Stayed out of scope:
- UI
- mobile flow
- provider ranking UX
- books serving
- owner transfer
- full sync bootstrap/replication

## What changed

- Added `SyncdEffectiveDiscoveryPolicy` in `src-tauri/src/syncd/config.rs`
- Added typed effective-origin/source/candidate models in `src-tauri/src/syncd/models.rs`
- Extended `SyncdDiscoveryProviderManager` in `src-tauri/src/syncd/discovery.rs` with:
  - effective-origin selection
  - policy-based precedence
  - normalized candidate deduplication
- Kept provider publication state separate from effective-origin choice
- Updated bootstrap payload generation in `src-tauri/src/syncd/routes/bootstrap.rs` to consume effective origin
- Updated descriptor generation in `src-tauri/src/syncd/routes/discovery.rs` to consume the same effective origin
- Kept bootstrap and pairing route contracts unchanged

## Why provider selection is needed now

At this point syncd has more than one discovery surface:
- advertised endpoint policy
- mDNS publication
- manual endpoint provider

Without an explicit selection layer, bootstrap/descriptor truth becomes implicit and brittle.

This slice makes that choice:
- typed
- deterministic
- testable
- reusable by later discovery work

## Effective origin selection

Current policies:
- `advertised-only`
- `manual-preferred`

Current sources:
- `advertised-endpoint`
- `manual-endpoint`

Rules:
- `advertised-only`: advertised endpoint remains canonical even if valid manual origins exist
- `manual-preferred`: first valid manual origin wins, otherwise syncd falls back to advertised origin
- mDNS publication state does not automatically become bootstrap truth by itself
- provider failure does not become effective origin unless policy chooses a valid source

## Normalization and deduplication

All candidate origins are normalized before comparison:
- `https` only
- host required
- port required
- no path/query/fragment

Examples:
- `https://localhost:4778/` -> `https://localhost:4778`
- `https://[::1]:4778` -> `https://[::1]:4778`

After normalization:
- equivalent origins are deduplicated
- first occurrence in policy order wins
- the chosen source is preserved from that first normalized occurrence

## Failure / fallback containment

Contained behavior:
- invalid manual config can fail only the manual provider
- effective origin falls back deterministically to advertised origin
- bootstrap create/fetch keeps working
- live pairing keeps working
- mDNS provider can remain active even when manual provider fails

No trust-bearing token is exposed in:
- effective origin metadata
- discovery descriptor
- provider status
- bootstrap payload

## Commands run

```powershell
cargo fmt --manifest-path C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src-tauri\Cargo.toml
cargo test --manifest-path C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src-tauri\Cargo.toml --bin aethon-syncd
powershell -ExecutionPolicy Bypass -File C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\scripts\run-syncd-discovery-phase-gate.ps1
powershell -ExecutionPolicy Bypass -File C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\scripts\run-syncd-live-pairing-phase-gate.ps1
```

## Runtime evidence

Artifacts:
- descriptor:
  - `tmp/syncd-discovery-phase-gate/discovery-descriptor.json`
- discovery status with valid manual provider:
  - `tmp/syncd-discovery-phase-gate/discovery-status.json`
- discovery status with invalid manual provider:
  - `tmp/syncd-discovery-phase-gate/discovery-status-invalid-manual.json`
- bootstrap payload with valid manual-preferred policy:
  - `tmp/syncd-discovery-phase-gate/bootstrap-created.json`
  - `tmp/syncd-discovery-phase-gate/bootstrap-fetched.json`
- bootstrap payload after deterministic fallback:
  - `tmp/syncd-discovery-phase-gate/bootstrap-created-invalid-manual.json`
- live pairing compatibility:
  - `tmp/syncd-live-pairing-phase-gate/bootstrap-created.json`
  - `tmp/syncd-live-pairing-phase-gate/pairing-live-events.json`

Observed:
- descriptor reported the effective origin chosen by policy
- discovery status exposed:
  - effective origin
  - effective source
  - effective policy
  - deduped candidate set
- valid manual provider became effective under `manual-preferred`
- invalid manual provider fell back to advertised origin cleanly
- bootstrap payload matched the effective discovery policy output
- live pairing still worked after policy wiring

## Remaining for future client-facing discovery / fallback UX

- client-side provider preference UX
- explicit fallback/selection UX for manual vs discovered endpoints
- richer ranking/selection policy beyond current deterministic precedence

## Remaining for broader sync bootstrap / replication

- client-side discovery consumption policy
- broader sync bootstrap orchestration beyond pairing/bootstrap
- full sync replication work

## Gate

PASS

Reason:
- syncd now has an explicit effective discovery policy layer
- bootstrap and descriptor output are deterministic and shared
- normalization/deduplication are explicit
- failure/fallback remains contained
- bootstrap and pairing contracts stayed intact
