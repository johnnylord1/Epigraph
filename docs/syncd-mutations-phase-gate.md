# Syncd Mutations Phase Gate

## Scope Entered
- `POST /v1/mutations`
- `book.progress`
- `novel.progress`
- `book.bookmark`
- `novel.bookmark`
- atomic persistence for accepted mutations:
  - canonical merge
  - `change_log`
  - `server_runtime.current_server_version`
  - broadcaster publication after commit

## Scope Intentionally Left Out
- generic delete flows
- broad tombstone coverage
- owner transfer final flow
- QR pairing
- full mDNS rollout
- mobile client work
- LNReader compatibility
- UI work

## Contract Summary
Request:
- `requestId`
- `mutations[]`
- each mutation is explicit by `entityType`
- each mutation carries:
  - `clientMutationId`
  - `scopeId`
  - `entityId`
  - `lamport`
  - `patch`

Supported entity/scope combinations:
- `book.progress` -> `books:global`
- `novel.progress` -> `novels:profile:<token_profile>`
- `book.bookmark` -> `books:global`
- `novel.bookmark` -> `novels:profile:<token_profile>`

Response:
- `requestId`
- `currentServerVersion`
- `results[]`
- each result includes:
  - `status` = `applied` or `rejected`
  - `appliedServerVersion` when accepted
  - `appliedLamport` when accepted
  - canonical `record` when accepted
  - structured `error` when rejected

Batch semantics:
- `mutations[]` is **per-item transactional**
- it is **not request-atomic**
- the server processes mutations sequentially
- one failed item does not roll back already-committed earlier items in the same request
- this contract is intentional for the current syncd line and must not be treated as ambiguous

Structured rejection cases proven:
- `INVALID_SCOPE_FOR_ENTITY`
- `FORBIDDEN_SCOPE`
- `INVALID_LAMPORT`
- `INVALID_RENDERER`
- `INVALID_PROGRESS_PERCENT`
- `INVALID_TIMESTAMP`
- `INVALID_PARENT_ID`

## Merge Rules
### Book Progress
- `book.progress` never leaves `books:global`
- renderer validation is explicit: `epub` or `pdf`
- applied lamport is `max(current, incoming) + 1`
- PDF:
  - compare `pageIndex`
  - then `progressPercent`
  - then `lastReadAtMs`
  - then lamport
  - higher page always wins, even if the later logical write is behind
- EPUB:
  - precise `location` beats weaker `href`
  - same precision then compares `progressPercent`
  - then `lastReadAtMs`
  - then lamport
  - weaker fallback never overwrites a stronger precise locator

### Novel Progress
- `novel.progress` stays inside `novels:profile:<id>`
- applied lamport is `max(current, incoming) + 1`
- compare `chapterOrderKey`
- tie on chapter then compare `locatorSortKey`
- then `progressPercent`
- then `updatedAtMs`
- then lamport
- higher chapter order always wins; later logical time cannot regress canonical reading progress

### Bookmarks
- no delete flow in this slice
- no tombstones in this slice
- `book.bookmark`
  - prefers stronger locator material:
    - `location`
    - then `pageIndex`
    - then `href`
  - ties by `savedAtMs`, then `progressPercent`, then lamport
- `novel.bookmark`
  - compares `chapterOrderKey`
  - then `locatorSortKey`
  - then `savedAtMs`
  - then lamport

## Transaction Strategy
For each accepted mutation:
1. begin transaction
2. load current canonical row
3. apply domain-specific merge
4. serialize canonical merged record
5. insert `change_log`
6. advance `server_runtime.current_server_version`
7. upsert canonical state row
8. commit
9. publish the resulting `ChangeEnvelope` on the broadcaster

If the transaction fails, no partial state survives.

Rollback proof added:
- direct DB test intentionally calls `apply_book_progress_mutation()` with an invalid scope that triggers the table `CHECK` constraint after `change_log` insert was attempted
- result:
  - mutation fails
  - `change_log` count stays unchanged
  - `current_server_version` stays unchanged

## Commands Run
```powershell
cargo test --manifest-path src-tauri/Cargo.toml --bin aethon-syncd
powershell -ExecutionPolicy Bypass -File .\scripts\run-syncd-mutations-phase-gate.ps1
```

## Runtime Evidence
Runtime gate script:
- starts `aethon-syncd` directly with HTTPS and audit routes
- seeds profile-bound tokens for `main` and `test`
- exercises `POST /v1/mutations`
- proves live SSE and replay through `/v1/events`

Observed:
- accepted `book.progress`
- accepted `novel.progress`
- rejected invalid `book.progress` scope with structured error
- second lower-page `book.progress` did not regress canonical `pageIndex`
- second lower-chapter `novel.progress` did not regress canonical `chapterOrderKey`
- accepted `book.bookmark`
- accepted `novel.bookmark`
- live SSE emitted mutation-derived `book.progress`
- replay via `Last-Event-ID` returned both `book.progress` and `book.bookmark`

Artifacts from runtime gate:
- `tmp/syncd-mutations-phase-gate/events-live.log`
- `tmp/syncd-mutations-phase-gate/events-replay-progress.log`
- `tmp/syncd-mutations-phase-gate/events-replay-bookmark.log`
- `tmp/syncd-mutations-phase-gate/syncd.stdout.log`

## Rejected Cases Proven
- `book.progress` in `novels:profile:main` -> rejected
- `novel.bookmark` in `books:global` -> rejected

## Gate Result
**Pass**

Reason:
- progress mutations are implemented and monotonic
- bookmark mutations are implemented without widening into deletes
- atomic persistence is in place
- `server_version` and `change_log` advance correctly
- broadcaster publication happens after commit
- live SSE and replay both proved mutation visibility
- rollback behavior was tested with a real SQLite constraint failure path

## Remaining Risks
- `change_log.patch` now carries the canonical merged record for supported mutation types, but consumers still need to keep treating the envelope as entity-specific rather than assuming a universal schema.
- Bookmark updates are narrow upserts only; delete semantics are intentionally deferred.
- Multi-mutation requests are processed sequentially, one transaction per mutation, not one transaction for the whole request. This is now an explicit contract choice, not an accidental behavior.
