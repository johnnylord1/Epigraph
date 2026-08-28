# Device sync selection migrations 45-46

Migration `45.sqm` upgrades schema 45 to 46. It adds a non-secret, per-device
sync selection keyed by `server_id + profile_id + device_id`. The table stores
domain choices, dependency-inventory modes and the only supported book asset
policy, `ON_DEMAND`.

The same migration adds a bounded LNReader dependency-inventory cache keyed by
server and profile. It stores only declarative repository/plugin parity JSON,
its SHA-256 fingerprint and timestamps. It never stores JavaScript, cookies,
tokens, plugin bytes or private settings. Keeping this cache durable prevents a
previously acknowledged inventory from appearing as new after every process
restart.

The table intentionally has no foreign key to credentials or paired-Core
metadata. Disconnecting, replacing a credential or deleting one selection must
not delete the materialized Library, categories, covers, chapters, progress,
bookmarks, highlights, assets or pending outbox work. The policy controls later
sync execution; it does not own synchronized content.

The recommended default enables Comics, Novels and Books plus inventory-only
comparison for comic repositories, comic extensions, LNReader repositories and
LNReader plugins.
Executable dependencies are never installed automatically, and EPUB/PDF assets
remain on-demand.

Migration `46.sqm` upgrades schema 46 to 47 by adding the independent
`comic_repositories` policy. It defaults to `INVENTORY_ONLY` for enabled Comics
sessions and is normalized to `DISABLED` when Comics is disabled. This setting
only controls whether the mobile repository catalog is refreshed during
reconciliation. Suwayomi Extension Store URLs are never copied to Android.

The `45.db` and `46.db` upgrade fixtures, `DeviceSyncSelectionMigrationTest` and
focused store tests verify schema creation, sequential upgrade, key isolation,
dependency normalization and offline-content retention.

## Rollback

There is no automatic database downgrade. Builds at schema 46 ignore the added
column; older builds ignore the new tables. If a manual diagnostic downgrade is
required, stop background sync and create a normal backup first. A schema 47 to
46 downgrade must rebuild only `aethon_device_sync_selection` without the
`comic_repositories` column. Downgrading below schema 46 may additionally drop
only `aethon_device_sync_selection` and
`aethon_core_novel_dependency_inventory_cache`. Never delete Library rows,
categories, chapters, downloads, covers, local books, assets, progress,
bookmarks, highlights, credentials or outbox rows as part of rollback.
