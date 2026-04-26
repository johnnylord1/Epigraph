# Trilha do Syncd - Replication Runtime and Session Management UX

## Status

- **Pass**
- Desktop replication runtime and session management UX are implemented.
- The previously discovered host-authority blocker is now closed with one narrow local bridge.

## What changed

Desktop runtime:

- `src-tauri/src/syncd_replication.rs`
  - consumes `/v1/changes` backlog and `/v1/events` SSE
  - applies remote `book.progress`, `book.bookmark`, `novel.progress`, and `novel.bookmark` changes into local desktop state
  - captures local desktop writes and turns progress/bookmark diffs into `/v1/mutations`
  - persists replication checkpoints and replication status per local profile
  - supports one active replication session per profile
  - now prefers a **local-authority session** for the owning desktop when host mode is active

Desktop wiring:

- `src-tauri/src/lib.rs`
  - wires the replication runtime into app setup
  - notifies the replication runtime after desktop state writes
  - exposes replication/session-management Tauri commands
- `src-tauri/src/syncd_desktop.rs`
  - hands newly approved sessions to the replication runtime
  - removes replication ownership when persisted sessions are disconnected
  - now acquires a local-authority token when host pairing starts
- `src-tauri/src/syncd_sidecar.rs`
  - exposes current runtime info so replication can rehydrate host-local authority on startup

Minimal syncd bridge:

- `src-tauri/src/syncd/routes/local.rs`
  - adds `POST /v1/local/authority-token`
  - loopback-only
  - issues a scoped token for the owning desktop only
- `src-tauri/src/syncd/db.rs`
  - adds local-authority token issuance
- `src-tauri/migrations-syncd/0003_allow_local_authority_tokens.sql`
  - extends the token schema to allow `granted_via = 'local-authority'`

Frontend/UI:

- `src/lib/syncdDesktop.ts`
  - adds replication/session catalog types and invoke wrappers
- `src/App.svelte`
  - listens for replication state to refresh local UI state after remote apply
- `src/components/settings/SyncdConnectionPanel.svelte`
  - adds a Replication block
  - adds a Sessions management block
  - supports:
    - set active
    - pause
    - resume
    - reconnect
    - revalidate single session
    - forget inactive session

## What now works

- approved session selection and persistence
- one active replication session per local profile
- remote backlog replay for an approved remote syncd session
- remote live replay over SSE
- local diff-to-mutation upload for the active approved remote session
- local host progress/bookmark writes entering the host syncd authority through the new loopback bridge
- local desktop replay against the owning host syncd authority while host mode is active
- restart-safe replication checkpoint persistence
- session catalog UX inside Settings > Security

## The only additional syncd change that was actually needed here

One narrow host-local bridge:

- `POST /v1/local/authority-token`

Properties:

- loopback-only
- scoped to:
  - `books:global`
  - `novels:profile:{profileId}`
- issues a token marked `granted_via = local-authority`
- does not widen discovery/pairing/bootstrap contracts

## What was not added

- no discovery expansion
- no new pairing contract
- no bootstrap redesign
- no broad local audit bypass

## Validation

Passing:

- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml syncd_replication::tests -- --nocapture`
- `cargo test --manifest-path src-tauri/Cargo.toml syncd::routes::local::tests -- --nocapture`

These cover:

- stable bookmark entity ids
- book diff mutation emission
- novel diff mutation emission
- replication state persistence
- default session selection
- session catalog action state
- loopback enforcement for the local-authority route
- scoped local-authority token issuance

## Technical conclusion

The replication/session UX milestone no longer needs speculative syncd widening.

The desktop runtime now has the minimum production-safe bridge it needed:

- the owning desktop can obtain a loopback-only scoped authority token
- local desktop writes can be pushed into local syncd
- local desktop replay can consume the host syncd authority back out

That keeps the architecture tight:

- remote peers still use approved pairing sessions
- host-local authority stays local-only
- trust boundaries remain intact
