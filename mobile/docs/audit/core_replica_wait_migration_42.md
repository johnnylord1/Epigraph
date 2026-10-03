# Core replica wait migration 42

Migration `42.sqm` upgrades schema 42 to 43. It adds the side table
`aethon_sync_replica_wait`, which preserves accepted Core mutation metadata until the
corresponding canonical replica version has been observed locally.

The migration does not rewrite Library, reader state, assets, outbox rows, receipts, categories,
downloads, trackers or extension data. Existing receipts remain valid and are treated as already
reconciled because older rows do not contain enough scope/version evidence to reconstruct a wait
safely.

## Rollback

There is no automatic database downgrade. Older builds ignore the added table. For a manual
downgrade, stop sync, confirm `aethon_sync_outbox` is empty, export a normal backup, and drop
`aethon_sync_replica_wait` before lowering the SQLite user version. Dropping this table removes
only pending confirmation metadata; it must never delete or rewrite local content or outbox rows.
