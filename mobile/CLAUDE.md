@AGENTS.md

## Claude Code additions

These rules complement `AGENTS.md`; when they overlap, `AGENTS.md` wins.

- Keep the existing stack: Koin for DI, Voyager for navigation, SQLDelight for the database. Never introduce Hilt, Navigation Compose, Navigation 3 or Room, even when a skill, sample or doc suggests them.
- Compose uses BOM 2026.05 with Material3 alpha. Check APIs against current docs instead of memory; alpha APIs change between releases.
- Run module-scoped Gradle tasks (for example `./gradlew :app:testDebugUnitTest`). Ask before a full local build; full builds run on CI.
- The release keystore is local-only and has no other copy: `%USERPROFILE%\secrets\aethon-release.p12` and `aethon-keystore.properties`. Never read, move, delete or commit them, `*.jks`, `*.keystore`, `*.p12` or `local.properties`, and exclude `%USERPROFILE%\secrets\` from any cleanup.
- Test on the emulator before pushing. Ask before any push, and push once per finished batch of work: a push that touches `mobile/` starts "Build Android" (about 40 minutes).
- Release builds and publishing happen only when the user explicitly asks, after all gates pass.
