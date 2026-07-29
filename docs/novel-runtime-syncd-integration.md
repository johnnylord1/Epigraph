# Novel Runtime syncd Integration

## Summary

Aethon integrates novels runtime state into the existing Syncd model without widening sync semantics.

The existing scope rules remain authoritative:
- novels are `novels:profile:<id>`
- books are `books:global`

## Primary scope references

Confirmed against:
- [mutations.rs](../src-tauri/src/syncd/routes/mutations.rs)
- [middleware.rs](../src-tauri/src/syncd/middleware.rs)
- [0001_init.sql](../src-tauri/migrations-syncd/0001_init.sql)
- [contracts.ts](../src/lib/novels/contracts.ts)

## What novels sync in v1

Under `novels:profile:<id>`:
- library entries
- progress
- bookmarks
- history
- repository metadata snapshot
- installed plugin metadata snapshot
- available source id snapshot
- explicitly whitelisted plugin settings metadata

## What novels do not sync in v1

- chapter HTML or text
- downloaded chapter content
- plugin artifact files
- cookies
- tokens
- credentials
- arbitrary plugin web storage
- any non-whitelisted secret-bearing plugin state

## What books keep doing

Under `books:global`:
- library metadata
- progress
- bookmarks

Books file assets remain outside sync v1.

## Snapshot whitelist rule

`novel.source_snapshot` must be sanitized before sync.

Allowed:
- repository URLs
- plugin ids
- plugin versions
- enabled state
- minimal trust state
- explicitly whitelisted plugin settings

Denied:
- cookies
- tokens
- credentials
- arbitrary web storage
- secrets

## Integration flow

1. novels runtime state changes
2. domain normalizes change into sync-safe entity
3. entity is scoped to `novels:profile:<id>`
4. syncd mutation and replay proceed through the existing contract
5. replay hydrates only the matching profile scope

## No profile leakage

Novels runtime state must never leak across profiles:
- repo lists
- installed plugin sets
- plugin settings
- library entries
- progress
- bookmarks
- history

Books remain global and intentionally separate from novels profile scope.

## Current status

Reviewed on `2026-07-28`.

- Scope validation, novel/book mutation handling, snapshots, replay, tombstone
  behavior, reconnect, pause/resume, and two-instance desktop scenarios are
  covered by the current Rust and WebView2 gates.
- Syncd remains part of AethonCore and continues to replicate repository and
  plugin snapshot metadata allowed by this contract.
- Chapter content, plugin binaries, cookies, tokens, credentials, and arbitrary
  plugin storage remain excluded.
- Harness port/process concurrency is future automation work and must not
  narrow the production scopes for comics, novels, or books.
