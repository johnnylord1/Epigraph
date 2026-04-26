# Novel Runtime syncd Integration

## Summary

Aethon will integrate novels runtime state into the existing syncd model without widening sync semantics.

The existing scope rules remain authoritative:
- novels are `novels:profile:<id>`
- books are `books:global`

## Primary scope references

Confirmed against:
- [mutations.rs](C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src-tauri\src\syncd\routes\mutations.rs)
- [middleware.rs](C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src-tauri\src\syncd\middleware.rs)
- [0001_init.sql](C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\src-tauri\migrations-syncd\0001_init.sql)
- [syncd-mutations-phase-gate.md](C:\Users\jhow-\Documents\Projetos\ForkMoku\Aethon\docs\syncd-mutations-phase-gate.md)

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

## Phase target

This document is the contract target for Phase 6.
It is not a request to reopen the syncd replay core.
