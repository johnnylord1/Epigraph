# Gate 0 decision

## Decision: conditional GO

Proceed with the Epigraph fork, built on Hayai, using commit `248146acfb87e97540d719f4a34bf1f362754882` as the immutable upstream baseline.

Do not use `v1.13.0`: its published source does not compile locally and it does not contain the novel feature set assumed by the original plan. Do not use current `master`: both upstream CI and the local build fail.

## Remaining conditions before product features

- Keep the checkout detached and do not push upstream.
- Retest onboarding and manga/novel repository flows on API 24 and 36.
- Keep protocol evolution additive while the Android v1 client is exercised against a running Epigraph Core/syncd instance.
- Do not call the app synchronized until confirmed-replica projection and two-device convergence have passed.

The Epigraph identity/privacy gate, base contracts, SQLDelight verification, atomic download finalization,
idempotent history restore, novel render hardening, EPUB structural validator, pairing vault/transport,
outbox drainer and snapshot replica foundation are complete, and API 24 plus API 36 reader smokes
passed. Clean Linux CI, real Core pairing and confirmed-replica projection remain conditions.

## Release checklist status (2026-09-28)

Done on the Android side: QuickJS limits, permission/backup audit, Linux CI with the syncd contract
gate, remote novel image broker, backup secret policy and size limits, EPUB TOC titles, bridge
labels and the novels-without-chapters warning. Still open before calling the app synchronized:

1. Real pairing against a running syncd (port 4777): open pairing on the desktop, pair by PIN or
   QR on the phone and confirm the 4-digit code on both sides.
2. Edit on each side (favorite, category rename/reorder, chapter read state, reader progress) and
   confirm both converge; Settings must not show "synced" while the outbox has pending commands.
3. Offline/reconnect: make edits in airplane mode, reconnect, and confirm the outbox drains.
4. Concurrency: edit the same entry on both sides before syncing.
5. Revocation: revoke the device on the desktop; the phone must report "action needed" and stop.
6. Two devices: pair a second emulator/phone and confirm all three converge.
7. Release-build smoke beyond onboarding (readers, backup, pairing) on a real phone. The signed
   release APKs verify with `apksigner`/`zipalign` and start without R8 crashes. The onboarding
   "install unknown apps" step is now optional; the extension installer asks for it on demand.

API 24 install/onboarding/library/CBZ/EPUB/PDF reader smoke passed on 2026-09-28 (no fatal errors).

Status 2026-10-06 (devDebug from CI against the desktop in dev mode, see `TASKS.md` §12): items 1–5
passed; revocation needed a fix (the revoked token's 401 was swallowed by the endpoint probe and
the phone kept retrying). Item 6 was not executed. Item 7 is out of scope for dev builds.

## Explicit non-claims

This gate approves the current client foundation only. It does not claim a successful real Core pairing,
bidirectional library sync, live SSE, full EPUB/PDF readers, broad LNReader compatibility, release signing,
or Google Play distribution. Those capabilities remain later milestones with their own acceptance tests.
