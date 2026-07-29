# Aethon Roadmap

This roadmap records known development priorities without committing to dates or adding new scope.

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

## Short Term

- Complete the verified 72A-72H sequence with the consolidated 72H structural
  gate and current-head release verification.
- Re-run `pnpm release:verify` on the current HEAD after the SR9-SR13 source
  runtime sequence.
- Exercise the real Docker FlareSolverr lifecycle when Docker is available;
  deterministic ownership and resource-policy tests remain the blocking gate.
- Validate manga/fullscreen with an accessible catalog and complete a manual
  screen-reader pass.
- Keep source failure ownership clear: runtime, extension, website, anti-bot,
  authentication, network, or Aethon.

## Medium Term

- Revalidate prioritized LNReader sources observationally and harden only
  reproducible runtime gaps.
- Improve diagnostics for theme gates, frontend/Tauri command inventory,
  runtime capabilities, and bounded storage growth.
- Reduce Discord cover-compositor test duration without removing SSRF,
  dimension, privacy, or fallback coverage.
- Continue reader, TTS, Library, updater, and source-management refinements
  without replacing their certified contracts.

## Long Term

- Aethon Core host: productize managed Suwayomi, Syncd, pairing, TLS, discovery, and secure LAN access so this desktop app can host the separate Aethon Mobile client.
- Mobile boundary: keep all Flutter UI, Android/iOS packaging, device storage, and mobile release work in the separate Aethon Mobile repository; share only explicit protocols, schemas, design tokens, and compatibility fixtures.
- Planned capabilities: expand migration, tracking, and source-management
  workflows only after release blockers stay stable.
- Infrastructure: improve signed release packaging, updater evidence, runtime
  ownership, and cross-platform build automation.
- Optimizations: preserve startup and navigation budgets while keeping
  downloads, imports, cache, and thumbnails isolated by ownership.
