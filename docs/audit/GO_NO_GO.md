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
outbox drainer and snapshot replica foundation are complete. API 24, clean Linux CI, real Core pairing,
confirmed-replica projection and fresh API 36 reader regression remain conditions.

## Explicit non-claims

This gate approves the current client foundation only. It does not claim a successful real Core pairing,
bidirectional library sync, live SSE, full EPUB/PDF readers, broad LNReader compatibility, release signing,
or Google Play distribution. Those capabilities remain later milestones with their own acceptance tests.
