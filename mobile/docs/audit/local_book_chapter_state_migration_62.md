# Migration 62: EPUB and PDF chapters get their own flags

## Cause

A local book had one saved position and nothing per chapter. Every chapter before the position counted
as read, so marking chapter 15 read also marked 11 to 14, marking 3 unread unmarked everything after it,
and opening an earlier chapter moved the marks back. A bookmark on a chapter row was a reader bookmark,
so one made while reading also flagged the row and removing the row's bookmark deleted all of them.

## What changes

- `local_book_chapter_state` holds a chapter's explicit read choice (`read_override`, null when there
  is none) and its row bookmark. A row with neither is deleted.
- `local_book_reading_state` holds `read_through`, the chapters that count as read because a position
  got past them, and `local_locator_json`, the last position this device saved.
- A position that lands in another chapter than `local_locator_json`, or finishes the book, came from
  another device or an older build. It raises `read_through`. An explicit choice still wins, and going
  back to an earlier chapter lowers nothing.
- No row is seeded, because a chapter index depends on the publication's structure. A book without a
  reading state derives it from its position the next time it opens, so existing progress keeps showing.
- Reader bookmarks stay in `local_book_bookmarks` and sync as before, but they no longer flag a row.

Both tables stay on this device. The sync contract has no per-chapter book command, so no outbox command
is written for them. The reading position still syncs through `SetProgress`. Backups carry both tables in
new `BackupLocalBook` fields 17 to 19, and older backups restore with no chapter state. Indexes beyond a
publication's chapter count are ignored when read.

## Verification

`62.db` is the pre-migration fixture. `verifySqlDelightMigration`, `LocalBookChapterStateMigration62Test`,
`BookChapterProgressTest` and `BackupLocalBookTest` cover the upgrade, a repeated run, the cascade from
`local_books`, the marking rules and the backup round trip.

## Rollback

An older build ignores the new tables and goes back to deriving chapters from the position, so chapter
flags stop showing but nothing breaks. A manual downgrade needs only `PRAGMA user_version = 62`. The two
tables may then be dropped; nothing else refers to them.
