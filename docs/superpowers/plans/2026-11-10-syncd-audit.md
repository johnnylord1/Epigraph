# Syncd reliability audit implementation plan

> Execute inline using systematic debugging and test-driven development; request an independent code review before completion.

**Goal:** Correct reproducible synchronization defects, preserve pending work, and reduce unnecessary desktop work across devices paired to the same Core.

**Architecture:** Keep Core as the ordered, authenticated authority. Preserve portable identities, atomic outboxes, scope boundaries, and compatibility with protocol v1. Fix individual causes with regression tests rather than replacing the protocol.

**Tech stack:** Rust/Tokio/SQLite, Svelte/TypeScript/Vitest, Kotlin/SQLDelight/Gradle.

**Spec:** `docs/epigraph-mobile-core-implementation-plan.md`, `docs/novel-runtime-syncd-integration.md`, and the user's audit request.

## Constraints

- Preserve all changes already present; no commits, pushes, releases, or user database modifications.
- Books are global; comics and novels remain profile scoped.
- Same-title works from different providers must remain distinct.
- A replay checkpoint advances only after its effects are durable.
- Mobile-to-mobile uses the shared paired Core; direct phone hosting is a separate capability.

## Work and verification

- [x] Inventory pending desktop and mobile changes, documentation, existing tests, and available prior chat context.
- [x] Run baseline Syncd and focused frontend tests; distinguish sandbox permission failures from defects.
- [x] Reproduce Android identity duplication through real SQLDelight projections in both arrival orders; preserve reading state and legacy references when adopting a portable native row.
- [x] Exercise desktop event planning with duplicate, catalog-only, and unknown events; advance consumed checkpoints and avoid loading unrelated library files.
- [x] Review Core snapshots, mobile projections, outboxes, tombstones, and reconnect safety independently; fix confirmed findings with regression cases, including session ownership and fragmented UTF-8.
- [x] Update focused documentation with current architecture, verified findings, results, and remaining device validation limits.
- [x] Run affected Rust, frontend, and module-scoped Android checks, production frontend build, whitespace checks, and independent review. Evidence and physical-device validation limits are in `docs/syncd-audit-2026-11-10.md`.

## Authorized installed-runtime follow-up (2026-11-11)

The user authorized updating the installed application, testing it with the real
library and deleting obsolete generated artifacts. This supersedes the original
read-only restriction for that update; preserve durable user data and signing keys.

- [x] Record the official Suwayomi library and durable projection queue before installation.
- [x] Run all Rust library tests and identify generated outputs not used by live processes.
- [x] Reproduce initialized library works with pending progress but no chapters using a mock GraphQL runtime and real SQLite bindings/outbox.
- [x] Extend hydration discovery with exact profile/source/key bindings and bounded official GraphQL queries; reuse source queues and persisted backoff.
- [x] Treat an empty chapter fetch as a failure for progress-dependent recovery, and wake only matching chapter retries after a successful fetch without changing payloads or attempts.
- [x] Verify the regressions, request review, build and attest a fresh production desktop/Core pair, and install through the existing update lifecycle.
- [x] Compare library identities/progress and status after update; inspect Home/library/scroll, then continue exclusively through APIs after the user's no-keyboard/mouse request. Document source failures separately.
- [x] Remove confirmed disposable compiler outputs; preserve rollback, backups and test profiles/reports after automatic review rejected their broader removal. Keep the current candidate and verification evidence.
