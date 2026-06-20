# Trilha do Syncd - Pairing/Auth Core Phase Gate

## Status

PASS

## Scope Entered

This phase stayed inside the syncd backend track only:

- `POST /v1/pairing/claim`
- pairing session lifecycle support in SQLite
- pending / approved / rejected claim behavior
- profile-bound token issuance
- trusted-pool reuse for the same `deviceId` on a second profile
- runtime proof for token scope isolation
- runtime proof for revoked and inactivity-expired token denial

## Scope Left Out

Deliberately not started here:

- QR payload / QR bootstrap
- mDNS rollout
- mobile client flow
- desktop approval UI
- owner transfer
- books file serving
- LNReader / plugin runtime

Approval and rejection were proven through **audit-only routes**. That was intentional for this phase so the backend contract could be verified without inventing a public admin channel too early.

## Contract Summary

### Claim request

`POST /v1/pairing/claim`

Required body fields:

- `sessionId`
- `pairingCode`
- `deviceId`
- `deviceName`
- `platform`
- `clientVersion`
- `clientProtocolVersion`

### Claim outcomes

- `pending_approval`
  - session has been claimed by the device
  - no token is issued yet
- `approved`
  - token is issued
  - token is bound to:
    - `deviceId`
    - `profileId`
    - scopes
- `rejected`
  - same claimed device sees stable rejected state

### Token scope rules

- every approved pairing token gets:
  - `books:global`
  - `novels:profile:<pairedProfileId>`
- token for `profileId=main` must not access `novels:profile:test`
- token for `profileId=test` must not access `novels:profile:main`

### Trusted-pool rule

- first approved pairing for a device is issued as `grantedVia = "qr"`
- same trusted `deviceId` pairing a second profile on the same host is issued as `grantedVia = "trusted-pool"`
- trusted-pool reuse does **not** bypass profile scoping

## Runtime Evidence

Commands run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-syncd-pairing-phase-gate.ps1
cargo test --manifest-path src-tauri/Cargo.toml --bin aethon-syncd
```

Observed runtime results:

- syncd booted over local HTTPS and reached `/healthz`
- pending claim was recorded in:
  - [claim-main-pending.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-pairing-phase-gate/claim-main-pending.json)
- approved `main` claim issued a profile-bound QR token in:
  - [claim-main-approved.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-pairing-phase-gate/claim-main-approved.json)
- rejected claim stayed rejected in:
  - [claim-rejected.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-pairing-phase-gate/claim-rejected.json)
- expired session returned structured `410` in:
  - [claim-expired.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-pairing-phase-gate/claim-expired.json)
- second-profile trusted-pool issuance was proven in:
  - [claim-test-approved.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-pairing-phase-gate/claim-test-approved.json)
- revoked token was denied with `401` in:
  - [revoked-token-use.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-pairing-phase-gate/revoked-token-use.json)
- inactivity-expired token was denied with `401` in:
  - [expired-token-use.json](/C:/Users/jhow-/Documents/Projetos/ForkAethon/Aethon/tmp/syncd-pairing-phase-gate/expired-token-use.json)

Automated test results:

- `34` syncd tests passed
- pairing tests covered:
  - pending -> approved transition
  - rejected state stability
  - expired session handling
  - profile-bound token scope isolation
  - trusted-pool second-profile issuance
  - inactivity-expired token rejection

## Fixes Applied During the Gate

- Added the pairing claim route and response models.
- Added SQLite helpers for:
  - session create/load/approve/reject/claim
  - trusted-device detection
  - profile-bound token issuance
- Added audit-only pairing helpers for runtime proof.
- Hardened the PowerShell harness after discovering a Windows environment collision where both `Path` and `PATH` existed at once. The harness now starts syncd without relying on `Start-Process` environment enumeration.

## Remaining Limits

- Approval and rejection are still audit-only proof paths, not final desktop-admin flows.
- QR is still absent from this phase by design.
- mDNS and reconnect ergonomics are still absent from this phase by design.
- Pairing tokens currently use deterministic `tokenId = pairing-<sessionId>` for this backend slice. That is sufficient for the frozen contract here, but future token rotation policy should keep that behavior under review.

## Gate Decision

PASS

Reason:

- backend claim/approve/reject flow works
- tokens are profile-bound and scope-safe
- trusted-pool reuse works without cross-profile leakage
- revoked and expired tokens are denied correctly
- runtime evidence is real, not just unit coverage
