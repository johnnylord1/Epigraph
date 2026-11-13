# Migration 64: replica wait canonical index

## Cause

While applying the desktop's change feed, each change asks whether a local mutation still waits for
it (`hasBlockingMutationForObservedVersion` and the related replica-wait lookups). The wait matches by
`entity_id = :id OR canonical_entity_id = :id`. Only `entity_id` had an index, so SQLite answered the
canonical branch by scanning every `aethon_sync_replica_wait` row.

After a first sync that uploads a large library, the phone holds one wait per uploaded mutation and
then applies the same number of echoes from the feed. With about 12,000 rows each lookup took 6.6 ms,
and applying the feed took 178 s on an emulator; profiling put 56% of that time in this query.

## What the migration touches

One index, no data:

- `aethon_sync_replica_wait_canonical_index` on
  `aethon_sync_replica_wait(scope_id, entity_type, canonical_entity_id, required_server_version)`

With it, SQLite plans the OR as a MULTI-INDEX OR over the two indexes. On a copy of the same database
the lookup dropped from 6.6 ms to 0.0025 ms.

## Verification

`64.db` is the pre-migration fixture. `verifySqlDelightMigration` and
`ReplicaWaitCanonicalIndexMigration64Test` cover the upgrade, a repeated run, and the fresh schema plan.

## Rollback

Older builds ignore extra indexes, so installing a previous APK is safe. A manual downgrade only needs
`DROP INDEX aethon_sync_replica_wait_canonical_index` and `PRAGMA user_version = 64`; no user data is
involved.
