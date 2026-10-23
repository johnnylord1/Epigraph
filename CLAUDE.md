@AGENTS.md

## Claude Code additions

These rules complement `AGENTS.md`; when they overlap, `AGENTS.md` wins.

- Tauri v2 only. Every new command must be registered in `generate_handler!` and allowed in a capability under `src-tauri/capabilities/`; a missing entry compiles but fails at runtime. Never use v1 patterns (`allowlist`, `tauri::api`, `@tauri-apps/api/tauri`).
- Svelte 5 runes only (`$state`, `$derived`, `$effect`, `$props`). Never write `export let`, `$:`, `on:click`, `<slot>` or stores for new component state.
- After editing a `.svelte` file, run the Svelte MCP `svelte-autofixer` on it and fix what it reports before finishing. This app uses Vite without SvelteKit, so skip SvelteKit-only guidance (routes, `load`, form actions, `$app/*`).
- Signing keys are local-only and have no other copy: `%USERPROFILE%\.tauri\epigraph.key*` and `%USERPROFILE%\secrets\`. Never read, move, delete or commit them, and exclude both folders from any cleanup.
- Run the affected tests before pushing. Ask before any push, and push once per finished batch of work: each push can start a long CI build.
- Release builds and publishing happen only when the user explicitly asks, after all tests pass.
