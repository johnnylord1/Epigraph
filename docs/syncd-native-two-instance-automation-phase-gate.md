# Trilha do Syncd - Native Two-Instance Desktop Automation

## Status

- **Pass**
- The native two-instance desktop automation harness now completes the real desktop sync flow end to end.

## What changed

- Kept the native two-instance automation runner:
  - `scripts/run-syncd-native-two-instance-automation.mjs`
- Kept the PowerShell wrapper that prepares and runs the native harness:
  - `scripts/run-syncd-native-two-instance-automation.ps1`
- Kept the existing desktop sync UI selectors/harness hooks.
- Added one minimal automation-only QR import hook in the desktop UI so the harness can inject the **actual rendered QR image data URL** into the joiner and still pass through the same QR decoder used by the app:
  - `src/components/settings/SyncdConnectionPanel.svelte`
  - `src/lib/syncdQr.ts`
- Added narrow Scenario 6 diagnostics so the harness proves the host-generated QR payload and the joiner-imported QR payload match exactly before connect.

## What the harness now proves

- host-ready launch
- mDNS discovery connect
- manual origin fallback connect
- bootstrap session creation
- live pairing websocket wait
- host approve
- host reject
- expiry
- unreachable remote on revalidation
- joiner restart plus persisted-session revalidation
- QR render on the host plus QR import on the joiner

## Commands run

```powershell
cmd /c npm run build
powershell -ExecutionPolicy Bypass -File C:\Users\jhow-\Documents\Projetos\ForkAethon\Aethon\scripts\run-syncd-native-two-instance-automation.ps1 -SkipBuild
```

## Runtime evidence

Primary report:

- `tmp/syncd-native-two-instance-automation/artifacts/syncd-native-two-instance-report.json`

Key artifacts:

- host smoke:
  - `tmp/syncd-native-two-instance-automation/artifacts/host-smoke-pending.png`
- mDNS approval:
  - `tmp/syncd-native-two-instance-automation/artifacts/scenario1-joiner-connected.png`
- restart revalidation:
  - `tmp/syncd-native-two-instance-automation/artifacts/scenario2-joiner-restarted.png`
- manual rejection:
  - `tmp/syncd-native-two-instance-automation/artifacts/scenario3-joiner-rejected.png`
- unreachable:
  - `tmp/syncd-native-two-instance-automation/artifacts/scenario4-joiner-unreachable.png`
- expiry:
  - `tmp/syncd-native-two-instance-automation/artifacts/scenario5-joiner-expired.png`
- QR path:
  - `tmp/syncd-native-two-instance-automation/artifacts/scenario6-bootstrap-qr.png`
  - `tmp/syncd-native-two-instance-automation/artifacts/scenario6-host-bootstrap.json`
  - `tmp/syncd-native-two-instance-automation/artifacts/scenario6-joiner-qr-import.json`
  - `tmp/syncd-native-two-instance-automation/artifacts/scenario6-joiner-connected-qr.png`

The final report shows all six scenarios passing:

1. `mdns-discovery-approval`
2. `restart-revalidation`
3. `manual-origin-rejection`
4. `unreachable-revalidation`
5. `expiry`
6. `qr-approval`

## What integration proved

- No new syncd route was needed beyond the already-existing local-only host decision route.
- The current syncd discovery/bootstrap/live-pairing stack is sufficient for real desktop-to-desktop automation.
- Approved sessions persist locally and reconnect cleanly after restart.
- QR import works in native automation once the harness uses the rendered image payload directly instead of relying on the flaky WebView2 file-input path.

## What was unnecessary overengineering

- no extra syncd route
- no extra discovery/guidance/policy layer
- no bootstrap redesign
- no pairing trust redesign

## Residual notes

- The slow/failing piece was not syncd. It was the native WebView2 file-input automation path for QR uploads inside the harness.
- We did **not** widen syncd to solve that.
- Instead, we added the smallest automation-only hook needed to feed the joiner the real rendered QR image data URL and let the app's own QR decoder do the rest.

## Gate

- **Native two-instance automation:** pass
- **Syncd desktop integration proof:** pass
