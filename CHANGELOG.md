# Changelog

All notable user-facing changes to Epigraph are documented here.

## [0.0.1] - 2026-08-30

### Added

- Desktop library for comics, novels, EPUB and PDF content.
- Managed source and extension browsing backed by Suwayomi.
- Syncd desktop pairing with localized connection status and device context.
- Discord Rich Presence with privacy controls for titles, covers and reading progress.
- Built-in Nocturne, AMOLED, Dark, Midnight, Light, Warm and high-contrast themes, plus custom theme persistence.

### Changed

- Redesigned source browsing, extension details, pairing, toast and status surfaces around the shared theme tokens.
- Standardized typography, alignment, feedback icons and notification sizing across the desktop interface.
- Completed translations for English, Brazilian Portuguese, Spanish, Japanese and Simplified Chinese.

### Fixed

- Rich Presence now reconnects after Discord restarts and retries activity updates without overriding an active reader session.
- Source and repository counts now reflect runtime state instead of stale recommendation totals.
- Extension installation, APK selection, migration and update controls follow the active theme and preserve readable interaction states.
- Syncd startup, pairing and replication recover safely across daemon restarts.
- Release certification now waits for source indexing to converge before comparing workflow identity.

### Security

- Rotated the updater signing identity before publication.
- Audited the repository and release diff for embedded credentials and sensitive files.
