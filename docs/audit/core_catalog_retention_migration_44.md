# Core catalog retention migration 44

Migration `44.sqm` upgrades schema 44 to 45. It marks only persisted manga rows
whose source is the reserved Epigraph Core source (`3238364976084580419`) as
initialized. No manga identity, favorite state, category, chapter, tracker,
download, progress, extension inventory, book or outbox row is rewritten.

The migration fixes rows produced by older builds that already contained a
complete catalog summary but were marked uninitialized. That marker caused the
details screen to request Core metadata again even after the device had been
unpaired. The new schema fixture `44.db` and `CoreCatalogMigrationTest` prove
that unrelated source rows are unchanged.

## Runtime behavior

- Catalog summaries are last-known-good local metadata.
- Unpairing removes credentials only.
- Automatic detail/chapter hydration is skipped for the internal Core source
  while no credential is present.
- Existing local chapters and downloads remain available.
- Missing remote chapter lists, pages and covers are not fabricated.
- While paired, confirmed covers are copied sequentially into the normal cover
  cache in bounded batches.

## Rollback

There is no automatic downgrade. Reverting the `initialized` bit is not needed
to preserve compatibility because older clients already accept initialized
manga rows. If a manual diagnostic rollback is required, stop the application,
back up the database, and set `initialized = 0` only for the reserved Epigraph
Core source. Never delete those manga rows, their categories, chapters,
downloads, progress or cached covers as part of rollback.
