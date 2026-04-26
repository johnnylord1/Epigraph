# Trilha do Syncd — Bookmark Resurrection Phase Gate

## Scope Entered
- bookmark resurrection proof only
- `book.bookmark`
- `novel.bookmark`
- `/v1/changes` verification after resurrection
- SSE replay verification after resurrection
- canonical final-state verification for the resurrected bookmark

## Scope Intentionally Left Out
- progress mutations
- progress delete
- generic delete engine
- non-bookmark tombstones
- pairing/auth
- QR bootstrap
- mDNS rollout
- books file serving
- owner transfer
- LNReader compatibility
- UI work

## Frozen Contract
Batch semantics remain unchanged:
- per-item transactional
- not request-atomic

Tombstone semantics remain unchanged:
- tombstone is entity-specific
- tombstone is scope-specific
- resurrection is not implicit

Resurrection acceptance rule:
- a bookmark resurrection is accepted only when a merge mutation arrives for the same `entityId`
- and the incoming client lamport is **strictly newer** than the effective tombstone lamport for that same bookmark

Resurrection rejection rule:
- if a bookmark tombstone exists and `incomingLamport <= tombstoneLamport`
- reject the merge with `STALE_BOOKMARK_MUTATION`

Scope rules remain hard:
- `book.bookmark` only in `books:global`
- `novel.bookmark` only in `novels:profile:<token_profile>`
- wrong-scope resurrection attempts are rejected before persistence

## Persistence Strategy
For a valid resurrection:
1. begin transaction
2. load canonical bookmark row
3. load bookmark tombstone for the same `scope_id + entity_type + entity_id`
4. reject if the incoming lamport is stale against the tombstone
5. merge the new bookmark payload into the canonical bookmark record
6. append `change_log(op='merge')`
7. advance `server_runtime.current_server_version`
8. upsert the canonical bookmark row
9. delete the matching tombstone in the same transaction
10. commit
11. publish the merge envelope after commit

This keeps resurrection narrow and explicit:
- no generic undelete engine
- no implicit row revival
- no publish-before-commit

## Commands Run
```powershell
cargo test --manifest-path src-tauri/Cargo.toml --bin aethon-syncd
powershell -ExecutionPolicy Bypass -File .\scripts\run-syncd-mutations-phase-gate.ps1
```

## Runtime Evidence
Accepted resurrection proved in runtime:
- `book.bookmark`
  - create
  - delete
  - newer merge resurrects with lamport `21 > 20`
- `novel.bookmark`
  - create
  - delete
  - newer merge resurrects with lamport `22 > 21`

Rejected resurrection proved in runtime:
- stale `book.bookmark` merge after delete returned `STALE_BOOKMARK_MUTATION`
- wrong-scope `book.bookmark` resurrection attempt returned `INVALID_SCOPE_FOR_ENTITY`

`/v1/changes` proof:
- [changes-bookmark-book-sequence.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-mutations-phase-gate/changes-bookmark-book-sequence.json)
  - returns `merge -> delete -> merge`
  - final patch carries `"label":"Restored"` and the precise EPUB locator
- [changes-bookmark-book-post-delete.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-mutations-phase-gate/changes-bookmark-book-post-delete.json)
  - returns only the resurrection merge when queried after the delete version
- [changes-bookmark-novel-sequence.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-mutations-phase-gate/changes-bookmark-novel-sequence.json)
  - returns `merge -> delete -> merge`
  - final patch carries `"chapterId":"c11"` and `"label":"Restored"`
- [changes-bookmark-novel-post-delete.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-mutations-phase-gate/changes-bookmark-novel-post-delete.json)
  - returns only the resurrection merge when queried after the delete version

SSE replay proof:
- [events-replay-bookmark-resurrection-book.log](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-mutations-phase-gate/events-replay-bookmark-resurrection-book.log)
  - replays `merge -> delete -> merge`
  - final truth matches the final `/v1/changes` patch for `bookmark-1`
- [events-replay-bookmark-resurrection-novel.log](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-mutations-phase-gate/events-replay-bookmark-resurrection-novel.log)
  - replays `merge -> delete -> merge`
  - final truth matches the final `/v1/changes` patch for `novel-bookmark-1`

Cross-scope leakage proof:
- [changes-cross-scope-book-into-novels.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-mutations-phase-gate/changes-cross-scope-book-into-novels.json)
  - empty `changes[]`
- [changes-cross-scope-novel-into-books.json](/C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon/tmp/syncd-mutations-phase-gate/changes-cross-scope-novel-into-books.json)
  - empty `changes[]`

## Automated Proof
Route/integration tests now cover:
- accepted book bookmark resurrection with tombstone clearance
- accepted novel bookmark resurrection with tombstone clearance
- stale novel bookmark resurrection rejection
- `/v1/changes` sequence correctness after resurrection
- SSE replay sequence correctness after resurrection
- wrong-scope resurrection rejection
- profile/scope isolation for resurrected novel bookmarks

## Gate Result
**Pass**

Reason:
- bookmark resurrection stayed narrow
- resurrection is explicit and lamport-gated behind the tombstone
- tombstone clearance happens only after a valid resurrection in the same transaction
- `/v1/changes` and SSE replay converge to the same final canonical truth
- no scope leakage was introduced
- no widening into generic delete semantics occurred

## Remaining Risks
- bookmark resurrection still depends on stable client-generated bookmark ids; a client that changes bookmark identity cannot benefit from the narrow resurrection contract.
- tombstone rejection is still surfaced through the shared `STALE_BOOKMARK_MUTATION` code path rather than a more specific resurrection-only code.
