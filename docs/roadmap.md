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
- Updater improvements: harden release metadata, changelog presentation, and assisted update recovery.
- Expanded source/extension support: improve source diagnostics, language preferences, and extension repository flows.

## Long Term

- Aethon Core host: productize managed Suwayomi, Syncd, pairing, TLS, discovery, and secure LAN access so this desktop app can host the separate Aethon Mobile client.
- Mobile boundary: keep all Flutter UI, Android/iOS packaging, device storage, and mobile release work in the separate Aethon Mobile repository; share only explicit protocols, schemas, design tokens, and compatibility fixtures.
- Planned capabilities: expand migration, tracking, and source-management workflows only after release blockers stay stable.
- Infrastructure: harden release packaging, updater metadata, Suwayomi runtime ownership, and cross-platform build automation.
- Optimizations: reduce bundle size, improve startup sequencing, and keep downloads/cache/thumbnails isolated from user-owned data.
