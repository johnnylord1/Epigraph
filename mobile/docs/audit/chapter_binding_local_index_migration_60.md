# Migration 60: chapter binding lookup by local chapter

## Cause

Marking a series as read on the phone took 1.5-2.5 s before its commands reached the outbox, about
18 ms per chapter. For every chapter, `EpigraphReaderProgressRouter.resolveChapter` runs
`selectChapterBindingByLocalChapterId`, and `aethon_chapter_binding` had no index on
`local_chapter_id` alone (only `UNIQUE(work_entity_id, local_chapter_id)`), so each lookup scanned every
legacy binding. The emulator library holds 44,267 bindings; `EXPLAIN QUERY PLAN` showed
`SCAN aethon_chapter_binding`. Reader progress writes, the progress backfill and the
`ON DELETE CASCADE` from `chapters` hit the same scan.

## What the migration touches

One index, no data:

- `aethon_chapter_binding_local_chapter_index` on `aethon_chapter_binding(local_chapter_id)`

On a copy of the emulator database, 85 lookups went from about 3.6 s to 1.4 ms. On the emulator, the
85 commands of a bulk mark reached the dev Core 8.4-9.2 s after the tap before the index and
2.9-4.9 s after it.

## Verification

`60.db` is the pre-migration fixture. `verifySqlDelightMigration` and
`ChapterBindingLocalIndexMigration60Test` cover the upgrade, a repeated run, and the fresh schema plan.

## Rollback

Older builds ignore extra indexes, so installing a previous APK is safe. A manual downgrade only needs
`DROP INDEX aethon_chapter_binding_local_chapter_index` and `PRAGMA user_version = 60`; no user data is
involved.
