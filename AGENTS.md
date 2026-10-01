# Epigraph Working Rules

## Project Shape

- Epigraph is a Tauri v2 desktop app, not Electron: Svelte 5 + TypeScript + Vite in `src/`, Rust/Tauri in `src-tauri/`, and WebView2 on Windows.
- Epigraph Mobile lives only in a separate native Android workspace. It is Kotlin/Compose/SQLDelight-based and is not built, packaged, or branched from this repository. Do not add Android/iOS UI, packaging, or bootstrap code to this desktop repository.
- The Android workspace is consumed as a working tree chosen by the user. Do not create a branch in its upstream repository or push to it without explicit authorization.
- This desktop repository may keep PC-hosted Core services and contracts used by mobile, including managed Suwayomi, Syncd, pairing, TLS, discovery, and secure LAN exposure.
- Manga/comics are backed by Suwayomi-Server over GraphQL. Books/novels have separate local/library paths; do not collapse those domains.
- For comics, Suwayomi is the catalog/library/chapter-state authority. Epigraph Core provides the authenticated, profile-scoped Suwayomi GraphQL proxy; Syncd stores complementary cross-device state such as comic history and page bookmarks. Do not create a second catalog by reading Suwayomi H2 or treating internal Suwayomi IDs as global Epigraph identities.
- Core UI pages live in `src/components/pages/`; shared library UI in `src/components/library/`; reader UI in `src/components/reader/`.
- Core app state and clients live under `src/store/` and `src/lib/`: manga/Suwayomi in `src/lib/manga/`, migration in `src/lib/migration/`, books in `src/lib/books/`, novels in `src/lib/novels/`, reader/TTS/offline manga in `src/lib/reader/`.
- Runtime/session scripts and policy live in `scripts/` and `docs/runtime-session-policy.md`. Use the managed runtime entry points there; do not open raw gates for routine UI inspection.

## Commands

- Install: `pnpm install`
- Web dev: `pnpm dev`
- Desktop dev: `pnpm tauri:dev` (debug builds use `%LOCALAPPDATA%\Epigraph-dev` and Core port 4787 unless `--local-app-data-dir` or `EPIGRAPH_DEV_DATA_DIR` is given)
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
- Keep desktop UI changes out of Core/mobile work. Backend, protocol, lifecycle, and invisible bridge changes are allowed only when they preserve the existing desktop surface.
- Update `docs/roadmap.md` or focused docs only when the task materially changes release status, project decisions, or documented milestones.

## Product And Default-User Experience

- Design for the standard desktop user first. Routine flows should be understandable without knowledge of ports, PIDs, runtimes, sidecars, certificates, manifests, or internal directories.
- Keep technical complexity behind automatic behavior and progressive disclosure. Manual endpoints, raw logs, runtime state, and repair actions belong in an advanced or diagnostic surface, not the primary flow.
- Prefer safe defaults and one clear primary action. Avoid adding settings, confirmations, status labels, or choices unless they help the user make a meaningful decision.
- Do not create application artifacts in Desktop, Documents, Downloads, or other common user folders without an explicit user action and destination choice.
- Store internal state only in the platform-standard application data location. Keep the minimum files required per profile and use stable, predictable ownership and names.
- Bound local growth: rotate logs, cap caches, remove temporary files after success or failure, and clean stale locks/manifests only after proving they are not owned by a live process.
- Generate diagnostic bundles only on explicit request. Redact credentials, tokens, cookies, QR payloads, private paths, and personal content before export.
- Backups, imports, downloads, and user-selected libraries are user data. Make their destination clear, never treat them as disposable cache, and never remove them during routine cleanup.
- Recover automatically when safe. Network loss, an occupied local port, a restarting service, or a temporary source failure should not force the user to understand infrastructure details.
- Present errors in user language with a short impact statement and a useful next action. Keep raw technical details available separately for diagnostics.
- Preserve accessibility, keyboard navigation, focus, contrast, readable loading/error states, and the supported minimum desktop viewport whenever changing a flow.

## Implementation, Refactoring, And Review

- Fix root causes and preserve clear domain boundaries. Refactors and new abstractions are welcome when they reduce complexity, remove duplication, improve correctness, or make ownership explicit; explain the tradeoff and verify affected behavior.
- Keep production behavior separate from test harness concerns. Test-only ports, `runId` values, disposable profiles, fixtures, driver state, and artifact directories must not leak into the normal product UX or persistent user profile.
- Make lifecycle operations idempotent. Start, stop, reconnect, retry, restore, migration, and cleanup should be safe when repeated or interrupted.
- Treat ports and processes as owned resources. Allocate local ports automatically, propagate the effective endpoint to dependent services, track child PIDs, and clean up only resources created by the current operation.
- Do not terminate processes solely by executable name, broad path pattern, or occupied port. Prove ownership through the process tree, runtime manifest, profile/run identifier, or another explicit lease.
- Avoid check-then-bind races. Reserve resources when possible or use bounded retry with a newly allocated resource and an actionable terminal error.
- Write critical manifests and user state atomically. Validate first, write to a temporary sibling, flush when required, replace atomically, and retain or restore the last known-good state on failure.
- Define typed contracts across Svelte/TypeScript, Tauri commands, Rust services, and persisted schemas. Validate inputs at boundaries and return structured, redacted errors.
- Application (Tauri) commands are accepted only from the `main` webview. The novel runtime host and external reader/login webviews run untrusted content and must use events or capability-scoped plugins, never new application commands.
- Every Syncd write that appends to `change_log` must also be broadcast after commit while holding `mutation_gate`; live streams resume by `server_version` and `Last-Event-ID`.
- Keep external-service states explicit: not configured, connecting, online, offline, unauthorized, incompatible, and failed should not collapse into an indefinite loading state.
- Prefer cached or last-known-good user data during transient failures, then reconcile in the background without discarding local progress or library state.
- Keep caches and generated artifacts replaceable and bounded. Keep user data durable, versioned when appropriate, and covered by migration or rollback behavior.
- Add focused tests for the changed contract and regression, then run proportionate checks for affected modules. Include failure, retry, interruption, duplicate submission, and cleanup paths when relevant.
- In review, check user-visible complexity, data-loss risk, privacy/redaction, storage growth, process/port ownership, offline behavior, accessibility, and cleanup—not only the successful path.

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
