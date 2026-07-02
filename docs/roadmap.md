# Aethon Roadmap

This roadmap records known development priorities without committing to dates or adding new scope.

## Short Term

- Design System: consolidate reusable cards, buttons, dialogs, toasts, badges, and settings surfaces.
- UI standardization: reduce one-off layouts and keep Nocturne spacing, typography, and density consistent.
- Architecture refactor: keep shared Library, Settings, runtime, and migration boundaries explicit.
- Performance: reduce eager GraphQL work, keep cached Library/Sources data during transient backend states, and profile heavy views.

## Medium Term

- Plugins: continue LNReader-compatible novel plugin hardening and repository management.
- Reader improvements: preserve progress, keyboard/fullscreen behavior, offline fallback, EPUB/PDF/prose presentation, and HUD stability.
- TTS improvements: polish the existing browser speechSynthesis flow without introducing a new engine.
- Library management: improve categories, refresh ergonomics, source visibility, backups, and restore confidence.

## Long Term

- Planned capabilities: expand migration, sync, tracking, and source-management workflows only after release blockers stay stable.
- Infrastructure: harden release packaging, updater metadata, Suwayomi runtime ownership, and cross-platform build automation.
- Optimizations: reduce bundle size, improve startup sequencing, and keep downloads/cache/thumbnails isolated from user-owned data.
