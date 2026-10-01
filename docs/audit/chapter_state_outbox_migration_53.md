# Blocked comic chapter-state recovery (migration 53)

Migration `53.sqm` upgrades schema 53 to 54. It changes no schema; it only
reopens outbox rows that earlier builds could never deliver.

## Cause

The reader router keys a comic chapter-state row as
`comic.chapter_state::<comic>::<chapter>`. Before this fix the Core v1 adapter
sent that whole key as `comicId`. The Core accepts only a Suwayomi-scoped
comic id there, so it rejected the mutation with `INVALID_SUWAYOMI_ENTITY_ID`
and the drainer parked the row as `blocked:INVALID_SUWAYOMI_ENTITY_ID`. The
sync status correctly reported the row as blocked and never as synced.

The adapter now strips the prefix and the chapter suffix to recover the bare
comic id. Rows keyed by the bare comic id keep working unchanged.

## What the migration touches

Only rows that match all of:

- `status = 'ERROR'` and `last_error = 'blocked:INVALID_SUWAYOMI_ENTITY_ID'`
- `entity_type = 'comic.chapter_state'`
- `entity_id GLOB 'comic.chapter_state::suwayomi:*:manga:*::*'`

Each such row gets a fresh random `clientMutationId` (in the column and in
`payload_json`), because the Core keeps a receipt for the rejected id and would
replay the rejection. The row returns to `PENDING` with no backoff. Any other
blocked row stays blocked for explicit recovery.

`BlockedComicOutboxMigrationTest` covers the recovered row and the rows that
must stay untouched. `54.db` is the schema fixture for the upgraded database.

## Rollback

There is no automatic downgrade. An older build at schema 53 reads the
reopened rows as ordinary pending commands and, with the old adapter, would
block them again with the same error. No local reading state is lost either
way, because the chapter state itself lives in `chapters` and the row only
carries the outbound copy.
