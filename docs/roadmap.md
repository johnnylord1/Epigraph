# Epigraph Roadmap

This roadmap records known development priorities without committing to dates or adding new scope.

## Technical audit — 2026-09-26

A repository-wide audit fixed eight defects in live Syncd authorization and
resume, progress-mirror broadcasting, cross-profile book writes, the Tauri
command boundary, atomic state writes and GraphQL timeouts. Its record,
invariants and the remaining outbox/event-boundary work are in
[audit-2026-09-26.md](audit-2026-09-26.md). The new tests still have to be run
with installed dependencies before the checkpoint is treated as verified.

## Current audit checkpoint — 2026-09-19

The original audit items B1, ORIGINAL_B2, B3, B4, B5 and ORIGINAL_B6 are closed
on their verified working-tree checkpoints. B4's final attested candidate
passes clean Fresh, Backup and Sync journeys through completion and restart;
the final receipt and criterion mapping are recorded in
[the audit backlog](project-audit-backlog.md#original_b4-closure-reconciliation--2026-09-19).

The B4 fixes are limited to the active Sync readiness boundary: an in-flight
hydration remains attached across unrelated replication updates, and native
incremental/authoritative Novel snapshots publish strict profile metadata.
Existing post-setup bypass harnesses remain regression gates and do not
substitute for clean-user acceptance. B1 ownership, restore-domain execution,
localization and B6 evidence contracts are preserved. B7-B12 remain unstarted;
the canonical backlog currently defines no named next item, so no new scope is
inferred here.

## Completed Foundation

- Theme infrastructure, active-surface token migration, ThemeEditor V5
  authoring, builtin theme gates, and removal of Legacy CSS aliases.
- Managed Suwayomi runtime V21/V23 adapter, certified `v2.3.2243` candidate,
  transactional runtime promotion, and transactional extension updates.
- Typed search palette and tracker-aware Library, Browse, Settings, Downloads,
  and Home workflows.
- Runtime fingerprint diagnostics, deterministic source contracts, observed
  compatibility reports, official Suwayomi source preferences, and the V2
  migration journal/coordinator with native write-ahead recovery, exact
  chapter-state mapping, profile-scoped links, tracker identity preservation,
  Hardcover source relinking, parent/child Mass Migration journals, and
  non-destructive offline asset manifests.
- Reader command ownership now uses one active manga, book, or novel scope.
  Shell zoom and fullscreen shortcuts no longer race the active reader, while
  each reader owns content zoom, bookmark and fullscreen commands and cleans
  its registration on teardown.
- Reader runtime work is session-bound: longstrip scroll measurement is
  coalesced, resume RAFs are bounded, next chapters are preloaded separately
  from one-time auto append, PDF progress follows one dominant visible page,
  duplicate progress writes are suppressed, and stale EPUB/PDF/novel work is
  ignored after reader or chapter changes.
- Library navigation now has directional cold/warm/cached telemetry in native
  WebView2, including commit/frame phases, CDP layout/style metrics, long tasks,
  CLS, heap, DOM, network, listeners, observers, and RAF growth over 20 cycles.
  The 72G2 gate separates app-owned work from environment-sensitive compositor
  and process startup time, balances five cold samples per direction, measures
  retained heap after GC, and keeps Search state latency blocking. No speculative
  Library lifecycle change was needed; the final native pass is green.
- EPUB/PDF local-data round trips, backup/restore, integration contracts,
  accessibility focus isolation, bundle budgets, and aggregate release gates.
- The 72H structural gate pins browser providers to an isolated IPv4 loopback
  port, runs native evidence on DISPLAY3, executes the deterministic Suwayomi
  workflow, and distinguishes app-owned navigation work from
  environment-sensitive WebView2 frame scheduling.
- The historical aggregate `pnpm release:verify` passed its then-declared gates
  at commit `50f1c8f6` on 2026-08-01. The milestone is closed; the
  remaining items below are conditional release evidence or non-blocking
  follow-up work.

## Short Term

- Keep `pnpm release:verify` as the pre-release gate. Use the
  [verification evidence entry point](verification-evidence.md) for dated,
  artifact-specific results and the runner-derived stage inventory. The historical
  result above does not certify the current working tree.
- Exercise the real Docker FlareSolverr lifecycle when Docker is available;
  deterministic ownership and resource-policy tests remain the blocking gate.
- Validate manga/fullscreen with an accessible catalog and complete a manual
  screen-reader pass.
- Investigate the environment-sensitive startup wall-clock observation
  separately from shell activation and route transitions; it is not currently
  a blocking app-owned regression.
- Keep source failure ownership clear: runtime, extension, website, anti-bot,
  authentication, network, or Epigraph.
- Keep the i18n catalog contract green and extend translations by active
  surface; preserve product names, URLs, formats, units, and protocol terms
  instead of translating them mechanically.
- Keep the desktop/Core documentation aligned with the Epigraph Mobile client;
  the authoritative implementation plan is
  [epigraph-mobile-core-implementation-plan.md](epigraph-mobile-core-implementation-plan.md).
- The Suwayomi -> Core catalog bridge is implemented and advertised separately
  from the generic GraphQL proxy. Mobile Library, remote category assignments,
  chapter read/bookmark/last-page writes now use a durable official-GraphQL
  queue with profile filtering, confirmatory reads and bounded retry. The
  the real Desktop-to-Android smoke now proves pairing, more than 600 catalog
  entries, cover resolution, typed progress/category mutations and explicit
  offline download/read. Remaining release evidence is limited to a physical
  device, a real extension-inventory change and Windows restart recovery of
  the default Core port.
- Portable Sync V3 now keeps provider-owned identities end to end: comics use
  exact source IDs and opaque manga/chapter keys; novels use exact plugin IDs
  and opaque novel/chapter paths. Trust remains device-local, dependencies may
  resolve partially, reader state survives Core restart, full comic snapshots
  no longer fail the desktop consumer, and desktop novel progress maps through
  exact provider keys rather than shared local IDs. V2 remains available only
  for Legacy sessions and identities that cannot be proven without guessing.
  Provider keys that appear to embed credentials are refused instead of being
  normalized or synchronized. Private LNReader repositories remain valid local
  configuration but are intentionally omitted from portable provenance.

## Medium Term

- Add a durable, per-profile desktop replication outbox with event clocks so
  edits made while a remote Core is unreachable are delivered without
  resurrecting remote deletes.

- Inventory remaining V2 sessions and `LEGACY_UNBOUND` rows before retiring
  local-ID synchronization. Never backfill those rows by title matching.
- Run a physical Android bootstrap with a real multi-source extension, one
  untrusted Extension Store, one LNReader repository approval, an interrupted
  hydration, and local IDs intentionally different on desktop and mobile.
- Revalidate prioritized LNReader sources observationally and harden only
  reproducible runtime gaps.
- Improve diagnostics for theme gates, frontend/Tauri command inventory,
  runtime capabilities, and bounded storage growth.
- Reduce Discord cover-compositor test duration without removing SSRF,
  dimension, privacy, or fallback coverage.
- Continue reader, TTS, Library, updater, and source-management refinements
  without replacing their certified contracts.

## Long Term

- Epigraph Core host: productize managed Suwayomi, Syncd, pairing, TLS, discovery, secure LAN access, and headless Suwayomi startup so this desktop app can host the separate Epigraph Mobile client while its window is closed.
- Mobile boundary: keep all Kotlin/Compose Android UI, SQLDelight device storage, packaging, and release work in the separate Android workspace; share only explicit protocols, schemas, design tokens, and compatibility fixtures. Do not create a branch in the upstream Android repository.
- Comics authority: keep catalog, library, categories, chapters, chapter progress, sources, extensions, and server downloads in the hosted Suwayomi profile. The desktop Core exposes a profile-scoped read-only catalog bridge alongside the authenticated GraphQL proxy; mobile materializes it locally and sends supported writes back through the official queue. Syncd complements the boundary mainly with history/page bookmarks and remains the authority for books/novels scopes.
- Planned capabilities: expand migration, tracking, and source-management
  workflows only after release blockers stay stable.
- Infrastructure: improve signed release packaging, updater evidence, runtime
  ownership, and cross-platform build automation.
- Optimizations: preserve startup and navigation budgets while keeping
  downloads, imports, cache, and thumbnails isolated by ownership.
