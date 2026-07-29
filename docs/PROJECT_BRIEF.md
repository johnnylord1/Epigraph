# Project Brief

## What Aethon Is
Aethon is a Windows-first desktop library and reader for comics, manga, source
novels, EPUB, and PDF. It is implemented with Tauri v2, Svelte 5, Rust, and
WebView2.

## Upstream Base
- Base repository: Aethon
- License: Apache-2.0, with upstream attribution preserved
- Current product identity and release infrastructure: Aethon

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
- Aethon Mobile is a separate Flutter/Sorayomi product and is not implemented or packaged from this repository.
- This desktop app may host the shared Suwayomi and Aethon Syncd services consumed by mobile, while mobile UI and platform code remain isolated in its own workspace.

## Current Release Work

- Re-run the aggregate release gate on the current HEAD after runtime changes.
- Exercise conditional checks that require Docker, signed updater artifacts,
  live opt-in services, an accessible manga catalog, or a screen reader.
- Keep diagnostics, storage growth, bundle budgets, and runtime capabilities
  observable without exposing infrastructure complexity to standard users.

## Repository Boundary
This repository does not contain Android/iOS UI, mobile packaging, or a Tauri mobile shell. Mobile work belongs exclusively to the separate Aethon Mobile workspace. PC-hosted Core services, shared protocol contracts, pairing, and secure LAN access remain valid desktop responsibilities.
