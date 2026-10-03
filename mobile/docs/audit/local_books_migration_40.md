# Local books migration 40

Migration `40.sqm` adds only the app-local publication tables: `local_books`, progress,
bookmarks, highlights and category links. It does not write to `epigraph_sync`, the Suwayomi
queue, or any Core-owned table.

## Upgrade

SQLDelight applies the migration transactionally. Existing rows are untouched. The private
files referenced by `private_path` are created by the importer before a row is published, so a
database upgrade never exposes a partial asset.

## Rollback

There is no destructive automatic downgrade. To roll back an APK, first export the normal
application backup. The older APK can then be installed after uninstalling the newer build; local
book files are private application data and are intentionally removed with that uninstall. A
future downgrade tool must drop the five local-book tables in dependency order and remove only
`files/books/{epub,pdf}` after an explicit user confirmation. It must never touch manga, novel,
sync or Core tables.
