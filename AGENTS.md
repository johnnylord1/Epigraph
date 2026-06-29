# Aethon Working Rules

## Project Shape

- Aethon is a Tauri v2 desktop app, not Electron: Svelte 5 + TypeScript + Vite in `src/`, Rust/Tauri in `src-tauri/`, and WebView2 on Windows.
- Manga/comics are backed by Suwayomi-Server over GraphQL. Books/novels have separate local/library paths; do not collapse those domains.
- Core UI pages live in `src/components/pages/`; shared library UI in `src/components/library/`; reader UI in `src/components/reader/`.
- Core app state and clients live under `src/store/` and `src/lib/`: manga/Suwayomi in `src/lib/manga/`, migration in `src/lib/migration/`, books in `src/lib/books/`, novels in `src/lib/novels/`, reader/TTS/offline manga in `src/lib/reader/`.
- Runtime/session scripts and policy live in `scripts/` and `docs/runtime-session-policy.md`. Use the managed runtime entry points there; do not open raw gates for routine UI inspection.

## Commands

- Install: `pnpm install`
- Web dev: `pnpm dev`
- Desktop dev: `pnpm tauri:dev`
- Managed desktop gate: `pnpm tauri:dev:gate`
- Build frontend: `pnpm build`
- Test all Vitest projects: `pnpm test`
- Focused unit/jsdom tests: `pnpm test:unit -- <files>`
- Browser component tests: `pnpm test:browser`
- Tauri build: `pnpm tauri -- build --config src-tauri/tauri.conf.json`
- Automation build: `pnpm tauri -- build --no-bundle --config src-tauri/tauri.automation.conf.json`
- Whitespace check before finalizing edits: `git diff --check`
- There is no dedicated npm lint or typecheck script. Use focused Vitest coverage and `pnpm build`; run `npx svelte-check` only when useful for touched Svelte/TS areas and call out any pre-existing global noise.

## Change Rules

- Work in small, controlled milestones and keep the smallest diff that fixes the observed problem.
- Diagnose before implementation: read nearby code/tests, confirm the data path, and check Suwayomi/runtime state before changing UI behavior.
- Never expand scope, rewrite stable systems, or redesign flows unless explicitly requested.
- Preserve upstream Apache-2.0 license files and attribution.
- Preserve local user changes. If the worktree is dirty, touch only files required for the task.
- Update `IMPLEMENTATION_PLAN.md`, `docs/STATUS.md`, or `docs/DECISIONS.md` only when the task materially changes release status, project decisions, or documented milestones.

## UI And Performance

- Preserve the current Nocturne visual language, spacing density, and desktop-first behavior unless the task is explicitly visual.
- Use existing components, stores, icons, Paraglide messages, and CSS patterns before adding new abstractions.
- Do not show destructive empty states for transient Suwayomi errors. Keep the last valid Library/Sources data when GraphQL readiness, reachability, or startup is uncertain.
- Avoid broad GraphQL queries, nested chapter loads, or eager full-library work on initial render. Prefer cached/local data first and refresh in the background where the current architecture supports it.
- Covers, thumbnails, and backdrops must fail to stable placeholders and retry when source/cache generation changes; do not leave broken images or alt text visible.

## Domain Rules

- Library/Comics/Books: keep comics, novels, and imported books separated. Preserve categories, history, read/bookmark state, progress, and library membership when migrating or refreshing.
- Migration: single and mass migration must use the existing Suwayomi contracts and `src/lib/migration/` journal flow. Copy/add the target first, transfer state, then clean up the source only after success.
- Reader: protect reading progress, fullscreen/keyboard behavior, offline manga fallback, EPUB/PDF/prose presentation, and existing HUD interactions.
- TTS: keep browser `speechSynthesis` behavior and existing voice/rate/progress state. Do not add native TTS or new engines unless requested.
- Downloads/cache/thumbnails: downloads and imported books are user data. Cache cleanup must not delete downloads, imports, reading history, or library records.

## Final Response

- Summarize what changed and list the files changed.
- Report checks/tests run, or explicitly say why they were skipped.
- Call out risks, uncertain areas, and manual smoke steps the user should run when relevant.
