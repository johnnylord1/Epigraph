# Project Brief

## What Epigraph Is
Epigraph is a Windows-first desktop library and reader for comics, manga, source
novels, EPUB, and PDF. It is implemented with Tauri v2, Svelte 5, Rust, and
WebView2.

## Upstream Base
- Base repository: Epigraph
- License: Apache-2.0, with upstream attribution preserved
- Current product identity and release infrastructure: Epigraph

## Current Mission
Ship a stable desktop product while keeping manga/Suwayomi, novels/LNReader,
imported books, readers, and synchronization as explicit domains with typed and
testable boundaries.

## Long-Term Direction
Keep one coherent library and reader experience without collapsing the
different persistence, runtime, rendering, or synchronization semantics of
each content type.

## Current Reality
- The repo/documentation foundation is established.
- The reusable theme infrastructure, ThemeEditor authoring contract, active
  visual surfaces, and Legacy theme cleanup are complete.
- Local EPUB/PDF import, backup/restore, offline behavior, integrations,
  navigation performance, and release gates have deterministic certification.
- Manga sources use a managed, versioned Suwayomi runtime behind
  `SourceRuntime/SuwayomiAdapter`. Runtime and extension promotion preserve
  profile state through maintenance, snapshot, journal, and rollback.
- Source novels use the separate LNReader-compatible plugin runtime. Its
  repositories, source state, Library data, and Syncd scopes remain separate
  from Suwayomi extensions.
- FlareSolverr is optional. Suwayomi owns its use for manga extensions; the
  LNReader runtime has its own bounded anti-bot recovery path.
- Epigraph Mobile is a separate native Android fork of Hayai, implemented with Kotlin/Compose/SQLDelight in `C:\Users\jhow-\Documents\Projetos\Aethon-Mobile\Hayai`. It is not implemented or packaged from this repository, and the upstream Hayai repository must not receive a new branch or push as part of this work.
- This desktop app hosts the shared Epigraph Core and Syncd services consumed by mobile. The Core owns pairing, TLS, discovery, secure LAN access, the managed Suwayomi lifecycle, and the authenticated Suwayomi GraphQL proxy; mobile UI and platform code remain isolated in its own workspace.

## Cross-device authority contract

- Comics/manga catalog, library membership, categories, chapters, chapter read/bookmark state, sources, extensions, and server downloads remain authoritative in the hosted Suwayomi profile.
- Mobile accesses that authority through `/v1/suwayomi/{path}?scopeId=comics%3Aprofile%3A{pairedProfile}`. The Core must never expose the bearer token or forward the mobile scope to Suwayomi.
- Syncd carries complementary normalized entities such as `comic.history` and `comic.page_bookmark`, plus the complete books and novels scopes already defined by the desktop contract.
- Current boundary: the desktop Core exposes a profile-scoped, read-only Suwayomi catalog bridge for library, categories, and chapters. The mobile gateway still must materialize those responses; the current cross-device comic scope remains primarily history and page bookmarks until that consumer is complete.
- A transient Suwayomi failure, partial page, maintenance window, or Core reconnect must not be interpreted as an empty library or a delete.
- EPUB/PDF bytes are explicit assets; comics and novels are not downloaded automatically during bootstrap.

## Current Release Work

- Re-run the aggregate release gate on the current HEAD after runtime changes.
- Exercise conditional checks that require Docker, signed updater artifacts,
  live opt-in services, an accessible manga catalog, or a screen reader.
- Keep diagnostics, storage growth, bundle budgets, and runtime capabilities
  observable without exposing infrastructure complexity to standard users.

## Repository Boundary
This repository does not contain Android/iOS UI, mobile packaging, or a Tauri mobile shell. Mobile work belongs exclusively to the separate Epigraph Mobile workspace. PC-hosted Core services, shared protocol contracts, pairing, and secure LAN access remain valid desktop responsibilities.
