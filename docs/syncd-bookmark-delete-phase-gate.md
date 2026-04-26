# Trilha do Syncd — Bookmark Delete Phase Gate

## Scope Entered
- `book.bookmark` delete
- `novel.bookmark` delete
- tombstones only for bookmark delete
- stale bookmark merge rejection when blocked by a newer tombstone

## Scope Intentionally Left Out
- progress delete
- generic delete engine
- tombstones for non-bookmark entities
- owner transfer
- QR pairing
- mDNS rollout
- mobile work
- LNReader compatibility
- UI work

## Contract Summary
Accepted bookmark operations:
- `book.bookmark`
  - `op: merge`
  - `op: delete`
- `novel.bookmark`
  - `op: merge`
  - `op: delete`

Still forbidden:
- `book.progress` with `op: delete`
- `novel.progress` with `op: delete`

Delete request shape:
- bookmark mutation item
- `entityType`
- `clientMutationId`
- `scopeId`
- `entityId`
- `op: delete`
- `lamport`
- no `patch`

Delete response shape:
- same `results[]` envelope as the previous slice
- `op: delete`
- `status: applied`
- `record: null`
- `appliedServerVersion`
- `appliedLamport`

Batch semantics remain frozen:
- per-item transactional
- not request-atomic

## Delete Strategy
For accepted bookmark delete:
1. begin transaction
2. load existing bookmark tombstone if any
3. reject stale delete if client lamport is older than or equal to the tombstone lamport
4. delete canonical bookmark row
5. append `change_log(op='delete')`
6. advance `server_runtime.current_server_version`
7. upsert tombstone with 30-day retention
8. commit
9. publish delete envelope after commit

For bookmark merge after delete:
- if a bookmark tombstone exists and incoming lamport is stale, reject the merge
- if a future bookmark merge arrives with a newer lamport, resurrection is allowed and the tombstone is removed in the same merge transaction
- the dedicated resurrection proof for this behavior now lives in `docs/syncd-bookmark-resurrection-phase-gate.md`

## Commands Run
```powershell
cargo test --manifest-path src-tauri/Cargo.toml --bin aethon-syncd
powershell -ExecutionPolicy Bypass -File .\scripts\run-syncd-mutations-phase-gate.ps1
```

## Runtime Evidence
Observed in runtime harness:
- accepted `book.bookmark` merge
- accepted `book.bookmark` delete
- accepted `novel.bookmark` merge
- accepted `novel.bookmark` delete
- stale `book.bookmark` merge after delete was rejected
- replay returned a `book.bookmark` delete event with `op: delete`

Artifacts:
- `tmp/syncd-mutations-phase-gate/events-replay-bookmark.log`
- `tmp/syncd-mutations-phase-gate/syncd.stdout.log`

## Automated Proof
Route/integration tests now cover:
- `deletes_book_bookmark_and_replays_delete_event`
- `deletes_novel_bookmark_and_replays_delete_event`
- `rejects_stale_bookmark_merge_after_delete_tombstone`

## Gate Result
**Pass**

Reason:
- delete remained narrow
- tombstones entered only for bookmark delete
- replay behavior remained consistent with the existing change-log/SSE contract
- no generic delete framework was introduced

## Remaining Risks
- stale delete is rejected per item, but there is still no generalized delete policy for other entity types.
- resurrection of a deleted bookmark is allowed only through a newer bookmark merge using the same `entityId`; clients need stable bookmark ids for that to be meaningful.
