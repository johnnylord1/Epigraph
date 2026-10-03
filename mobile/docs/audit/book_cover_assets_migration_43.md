# Book cover assets migration 43

Migration `43.sqm` upgrades schema 43 to 44. It adds nullable, content-addressed cover metadata
to `local_books` and extends the existing immutable asset manifest with the `BOOK_COVER` kind.
Existing `cover_path` values remain local-only and are not converted into synchronized metadata.

The migration copies every existing asset manifest row without changing its state, ownership,
hash, local path or remote availability. EPUB, PDF and novel chapter assets are unaffected.

## Rollback

There is no automatic database downgrade. Older builds ignore the additional `local_books`
columns but do not understand `BOOK_COVER` manifest rows. Before a manual downgrade, stop Core
sync, export a normal backup, delete only `BOOK_COVER` links and manifest rows after confirming
that no transfer is active, then rebuild `local_books` without the three cover metadata columns.
Never delete `cover_path` files, publication assets, outbox rows or user books as part of rollback.
