# Runtime Session Policy

This document defines the approved entry points for opening Epigraph during manual verification, UI audits, and Syncd protocol gates.

## Goals

- avoid orphaned `epigraph`, `node`, `cargo`, and sidecar processes
- avoid opening the wrong gate for the wrong purpose
- keep normal desktop launches silent
- keep Syncd test flows isolated from the normal desktop session

## Approved Entry Points

### Normal desktop UI verification

Use one of these only:

- Desktop shortcut: `C:\Users\jhow-\Desktop\Epigraph.lnk`
- Launcher script: `scripts/launch-desktop-epigraph.ps1`
- Managed theme audit: `pnpm theme:audit-runtime`

These are the only approved entry points for:

- checking current UI work
- visual audits
- interaction audits
- manual Settings / Home / Library / Search verification

They are designed to:

- focus an existing Epigraph window if one already exists
- clean managed Epigraph sessions before relaunch when needed
- open silently without a visible console window in the normal desktop path

Do not open raw `tauri:dev:gate` for routine manual UI inspection.

### Managed cleanup

Use:

- `scripts/stop-epigraph-orphans.ps1`

This is the approved cleanup path when:

- a prior dev gate is stuck
- a Syncd gate left processes behind
- a release/build audit was interrupted
- the machine is lagging because old Epigraph sessions were not cleaned up

### Syncd phase gates

Use the `run-syncd-*.ps1` scripts only for the specific protocol/runtime contract they were created to verify.

They are not approved as the default way to open the app for manual UI work.

Examples:

- `run-syncd-bootstrap-phase-gate.ps1`: bootstrap payload / claim verification
- `run-syncd-phase-gate.ps1`: runtime/auth/replay contract verification
- `run-syncd-desktop-two-instance-harness.ps1`: explicit two-instance desktop pairing flows
- `run-syncd-native-two-instance-automation.ps1`: automated native two-instance runs

### Browser and component tests

These are not desktop app launchers:

- `npm test -- --project shell-jsdom ...`
- `npm test -- --project browser-components ...`

They are test runners only.

Do not use them as substitutes for the normal desktop launcher.

## Hard Rules

- Do not use a Syncd gate to inspect ordinary UI work.
- Do not use the two-instance harness unless the test really requires two desktop instances.
- Do not open raw `tauri:dev` or raw `tauri:dev:gate` for ordinary manual UI checks when the managed launcher exists.
- Do not keep multiple gate families alive at the same time unless the test explicitly requires it.
- Before switching from one gate family to another, run `stop-epigraph-orphans.ps1` or use the managed launcher that already performs cleanup.

## Session Model

There are three supported session categories:

1. normal desktop UI session
2. Syncd phase-gate session
3. Syncd multi-instance harness session

Each category must be treated as separate.

The normal desktop launcher is allowed to terminate managed test sessions before starting a fresh UI session.

## Agent Guidance

When an agent needs to open the app:

- use the normal launcher for manual UI inspection
- use a Syncd gate only when the task is explicitly about Syncd protocol/runtime verification
- clean managed processes before starting a new gate family
- do not leave build/test sessions running after the task no longer needs them
