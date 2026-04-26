# Trilha do Syncd - QR / Bootstrap Backend Phase Gate

## Status

PASS

## Scope Entered

This phase stayed inside the syncd backend track only:

- short-lived bootstrap session creation
- public bootstrap payload creation route
- public bootstrap payload fetch route
- bootstrap payload wired to the existing pairing claim flow
- runtime proof that approval is still required before token issuance
- runtime proof that expired bootstrap payloads fail cleanly

## Scope Left Out

Still deliberately out of scope:

- QR rendering UI
- camera scanning UI
- desktop approval UI
- mobile UI flows
- mDNS rollout
- manual IP fallback
- books file serving
- owner transfer
- LNReader / plugin runtime

## Bootstrap Contract

### Route: create bootstrap payload

`POST /v1/bootstrap/session`

Request body:

- `profileId`

Behavior:

- creates a short-lived pairing session
- returns a minimal bootstrap payload
- does **not** issue a final token

### Route: fetch bootstrap payload

`GET /v1/bootstrap/session/:sessionId`

Behavior:

- returns the current bootstrap payload for that session while it is still valid
- returns `410` if the bootstrap session is expired
- returns `404` if the bootstrap session does not exist

### Payload fields

The payload is intentionally minimal:

- `pairingSessionId`
- `pairingCode`
- `syncdBaseUrl`
- `claimUrl`
- `profileId`
- `expiresAtMs`
- `tlsCertSha256`
- optional `suwayomiHint`

### Security / trust rules

- the bootstrap payload is only a bootstrap envelope
- it never embeds the final long-lived pairing token
- approval and token issuance still happen in the existing pairing/auth flow
- token remains profile-bound
- TLS pin material is present in the payload via `tlsCertSha256`

### Expiry semantics

- bootstrap payload lifetime uses the syncd bootstrap session window
- expired payload fetch returns:
  - `410`
  - `BOOTSTRAP_SESSION_EXPIRED`
- expired payload does not bypass the existing claim expiry behavior

### Suwayomi hint semantics

- `suwayomiHint` is omitted by default
- it is only included when:
  - the profile is a local managed profile (`main` or `test`)
  - a valid temporary LAN exposure session exists
  - the session still has a usable advertised host
- this phase did **not** widen into discovery or LAN address selection logic

## Runtime Evidence

Commands run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --bin aethon-syncd
powershell -ExecutionPolicy Bypass -File .\scripts\run-syncd-bootstrap-phase-gate.ps1
```

Observed results:

- `38` syncd tests passed
- syncd booted over local HTTPS and reached `/healthz`
- bootstrap payload creation succeeded and wrote:
  - [bootstrap-created.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-created.json)
- bootstrap payload fetch returned the same bootstrap truth in:
  - [bootstrap-fetched.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-fetched.json)
- bootstrap claim stayed pending before approval in:
  - [bootstrap-claim-pending.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-claim-pending.json)
- bootstrap claim returned a final token only after approval in:
  - [bootstrap-claim-approved.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-claim-approved.json)
- expired bootstrap payload fetch failed cleanly in:
  - [bootstrap-expired.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-expired.json)

## Specific Proof Points

### Final token is not embedded in the bootstrap payload

Proven by runtime harness assertions against:

- [bootstrap-created.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-created.json)
- [bootstrap-fetched.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-bootstrap-phase-gate/bootstrap-fetched.json)

Neither payload contains `accessToken` or `token`.

### Approval still gates trust

Proven by runtime sequence:

1. create bootstrap payload
2. fetch bootstrap payload
3. claim with `pairingSessionId + pairingCode`
4. receive `pending_approval`
5. approve via the existing pairing flow
6. claim again
7. only then receive the final token

### Expired bootstrap payload fails cleanly

Proven by:

- expired bootstrap session created through audit-only proof route
- fetch route returns structured `410`
- no token is ever issued through the bootstrap payload itself

## Fixes Applied In This Slice

- added bootstrap session TTL to syncd config
- added bootstrap payload request/response models
- added a DB helper for short-lived bootstrap pairing session creation
- added public bootstrap create/fetch routes
- added bootstrap route tests
- added runtime bootstrap phase-gate harness

## Remaining Limits

- `syncdBaseUrl` currently derives from the syncd bind address; this slice does not solve LAN host discovery
- `suwayomiHint` is intentionally conservative and absent unless a valid temporary LAN session is already present
- QR rendering itself is still out of scope here; this slice only prepares the payload contract

## Gate Decision

PASS

Reason:

- the QR/bootstrap backend now exists
- payload is minimal and short-lived
- final token is never embedded in the bootstrap payload
- bootstrap flows into the existing pairing/auth core instead of replacing it
- expired bootstrap payloads fail cleanly
- no widening into mDNS, UI, or mobile occurred
