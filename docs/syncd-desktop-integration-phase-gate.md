# Trilha do Syncd — Desktop-to-Desktop Integration

## What changed

- Added the first desktop-owned sync client in `src-tauri/src/syncd_desktop.rs`.
- Added the minimal local-only host decision route:
  - `POST /v1/pairing/session/:sessionId/decision`
- Added a proof-oriented Settings > Security surface for:
  - host bootstrap creation
  - live pairing status
  - host approve/reject
  - discovery/manual connect
  - persisted session summary
  - restart revalidation
- Added QR rendering on the host side and QR-image loading on the joiner side.

## What worked using current syncd contracts

- Discovery through the existing client-contract and client-guidance routes
- Canonical-first / fallback-on-connection-failure desktop consumption
- Bootstrap create/fetch
- Live pairing status websocket
- Approval-gated token retrieval
- Profile-bound local session persistence
- Conservative reconnect/revalidation on restart

## What was unnecessary overengineering

- No new discovery route was needed
- No new bootstrap/guidance route was needed
- No trust redesign was needed
- No second backend gap appeared after integration

## Backend gaps actually discovered

- Exactly one:
  - host approval/rejection was still audit-only
- Closed with the local loopback-only decision route

## Proof status

- `cargo check` passed
- `cargo test` passed
- `npm run build` passed
- A manual two-instance desktop harness is now available at:
  - `scripts/run-syncd-desktop-two-instance-harness.ps1`
- Native two-instance desktop automation now also passes end to end via:
  - `scripts/run-syncd-native-two-instance-automation.ps1`
  - `scripts/run-syncd-native-two-instance-automation.mjs`

## Native proof closed

- The earlier remaining proof gap is closed.
- Native desktop automation now exercises the real two-instance flow, including:
  - mDNS discovery approval
  - restart revalidation
  - manual origin fallback rejection
  - unreachable remote
  - expiry
  - QR approval
- The QR path required no new syncd contract. The only extra work was a narrow automation hook so the harness could feed the joiner the rendered QR image payload while still going through the real app QR decoder.

## Final integration conclusion

- No second syncd backend gap appeared after the native proof closed.
- The existing syncd discovery/bootstrap/live-pairing stack is sufficient for desktop-to-desktop pairing and reconnect.
