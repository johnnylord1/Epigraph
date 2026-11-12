# Migration 63: a PDF's sections come from its own outline

## Cause

A PDF imported on the phone was one chapter however long its outline. Sections only arrived from the
Core replica, for books the desktop had already read the outline of, so the same file listed its chapters
on one device and a single row on another.

## What changes

- `local_book_pdf_outline` holds the sections read from the file, in the Core's own summary format, once
  per book. It is read on import, on relink, on restore, when details opens and in the start-up
  maintenance, as soon as the file is on the device.
- The rules are the desktop's (`desktop/src/lib/books/pdf.ts`): every depth, in page order, entries without
  a page left out, one entry per page and lowercased title, a blank title replaced by the page number.
  One section alone gives no chapters. Pages before the first section count as the first section.
- An empty array in the table means there is nothing to show. It is written before the read, so a file
  that takes the process down is not read again at every start, and it stays when the outline cannot be
  read, such as a password-protected PDF. Those books stay as one chapter.
- Sections from the Core win. A later replica summary replaces the local ones, and a persisted count above
  one, which only the Core can raise, keeps a book out of the local sections.
- State kept while a book was one chapter is converted once, when its sections are first read and the Core
  has none: marked read or finished reads every section, marked unread reads none, and a position in
  progress reads the sections before it. A book never marked stays derived from its position.
- A section sharing its first page with the next one has no pages of its own, so reaching the end of the
  later one marks both.
- Start-up maintenance no longer lowers a PDF's chapter count to the one chapter it inspects, which undid a
  count from the Core until details was opened.

The table stays on this device and no outbox command is written for it. `chapter_count` stays at what it
was, so the local count never reaches the Core through `saveStructure`. `page_count` is corrected
directly, as `find` already does. Backups carry the sections in `BackupLocalBook` field 20, next to the
per-section state in fields 17 to 19. A restore without sections but with chapter state deletes the row,
so the outline is read again and that state is converted.

## Verification

`63.db` is the pre-migration fixture. `verifySqlDelightMigration`, `LocalBookPdfOutlineMigration63Test`,
`PdfOutlineTest`, `BookChapterProgressTest`, `BookChapterMetricsTest` and `BackupLocalBookTest` cover the
upgrade, a repeated run, the cascade from `local_books`, the outline rules, the state conversion, shared
first pages and the backup round trip.

## Rollback

An older build ignores the table and shows one row per PDF again. Chapter state already converted stays
counted in sections until a position reconciles it, so a marked book can show as read or unread by its
`read_through`, and nothing breaks. A manual downgrade needs only `PRAGMA user_version = 63`. The table may
then be dropped; nothing else refers to it.
