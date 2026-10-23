# Migration 59: sync lookup indexes

## Cause

Since 0.1.0-alpha.18 the Core sync worker backfills comic chapter progress before every run
(`selectComicChapterProgressBackfill`). The query joins `aethon_portable_work_binding` and
`aethon_portable_chapter_binding` by `local_reference`, and checks `aethon_sync_outbox` by entity id.
None of those columns had an index, so every chapter scanned every binding and the whole outbox. On a
real library the query held the database connection for 14-50 s, on every app start, network change,
retry and periodic run. The main thread waited for the same connection (Epigraph Core screen,
opening a series), which produced the ANRs; with the desktop closed the worker retried and repeated it.

## What the migration touches

Three indexes, no data (the query rewrites above need no migration):

- `aethon_portable_work_local_index` on `aethon_portable_work_binding(local_reference)`
- `aethon_portable_chapter_local_index` on `aethon_portable_chapter_binding(local_reference)`
- `aethon_sync_outbox_entity_index` on `aethon_sync_outbox(scope_id, entity_type, entity_id)`

## Query rewrites in the same change

Indexes alone were not enough on a large library (55 s for 1,500 series × 200 chapters):

- `selectComicChapterProgressBackfill` and `selectComicHistoryBackfill` matched the work binding with
  `local_reference = CAST(C.manga_id AS TEXT)`, so SQLite paired every work with every favorite before
  reaching chapters. Both now find the manga by primary key from the binding, still requiring the
  exact text match, so the rows are the same.
- `selectComicHistoryBackfill` recomputed each series' latest read with a correlated `max()` per history
  row. It now computes it once per series in a grouped subquery.

Measured on synthetic libraries, with identical results before and after:

| Library | Progress backfill | History backfill |
| --- | --- | --- |
| 300 series × 100 chapters | 10.2 s → 0.09 s | 7.7 s → 0.02 s |
| 1,500 series × 200 chapters | minutes → 0.43 s | 14.1 s → 0.22 s |

On the reporting phone the old progress query was still running after 270 s.

## Verification

`59.db` is the pre-migration fixture. `verifySqlDelightMigration` and
`SyncLookupIndexesMigration59Test` cover the upgrade, a repeated run, and the fresh schema plan.

## Rollback

Older builds ignore extra indexes, so installing a previous APK is safe. A manual downgrade only needs
`DROP INDEX` for the three names above and `PRAGMA user_version = 59`; no user data is involved.
