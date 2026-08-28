PRAGMA foreign_keys = OFF;

ALTER TABLE book_bookmarks ADD COLUMN note TEXT;
ALTER TABLE book_bookmarks ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE book_bookmarks ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;

ALTER TABLE book_library_entries ADD COLUMN mime_type TEXT;
ALTER TABLE book_library_entries ADD COLUMN byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0);
ALTER TABLE book_library_entries ADD COLUMN cover_asset_sha256 TEXT CHECK (
  cover_asset_sha256 IS NULL OR (
    length(cover_asset_sha256) = 64 AND
    cover_asset_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);

UPDATE book_bookmarks
SET created_at_ms = saved_at_ms,
    updated_at_ms = saved_at_ms
WHERE created_at_ms = 0 OR updated_at_ms = 0;

CREATE TABLE book_highlights (
  scope_id TEXT NOT NULL CHECK (scope_id = 'books:global'),
  highlight_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  start_locator_json TEXT NOT NULL CHECK (json_valid(start_locator_json)),
  end_locator_json TEXT NOT NULL CHECK (json_valid(end_locator_json)),
  selected_text TEXT NOT NULL,
  color_argb INTEGER NOT NULL,
  note TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, highlight_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_book_highlights_book
  ON book_highlights(scope_id, book_id, highlight_id);

CREATE TABLE change_log_new (
  server_version INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  profile_id TEXT,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'novel.entry',
      'novel.chapter',
      'novel.chapter_asset',
      'novel.progress',
      'novel.bookmark',
      'novel.history',
      'novel.classification',
      'novel.category',
      'novel.category_assignment',
      'novel.repository',
      'novel.plugin',
      'book.entry',
      'book.asset',
      'book.category',
      'book.category_assignment',
      'book.library_ui',
      'book.progress',
      'book.bookmark',
      'book.highlight',
      'book.history',
      'comic.entry',
      'comic.category',
      'comic.category_assignment',
      'comic.chapter_state',
      'comic.history',
      'comic.page_bookmark'
    )
  ),
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('merge', 'delete')),
  lamport INTEGER NOT NULL CHECK (lamport >= 0),
  changed_by_device_id TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL,
  patch_json TEXT CHECK (patch_json IS NULL OR json_valid(patch_json)),
  replay_until_ms INTEGER NOT NULL
) STRICT;

INSERT INTO change_log_new (
  server_version,
  scope_id,
  profile_id,
  entity_type,
  entity_id,
  op,
  lamport,
  changed_by_device_id,
  applied_at_ms,
  patch_json,
  replay_until_ms
)
SELECT
  server_version,
  scope_id,
  profile_id,
  entity_type,
  entity_id,
  op,
  lamport,
  changed_by_device_id,
  applied_at_ms,
  patch_json,
  replay_until_ms
FROM change_log;

DROP TABLE change_log;
ALTER TABLE change_log_new RENAME TO change_log;

CREATE INDEX idx_change_log_scope_version ON change_log(scope_id, server_version ASC);
CREATE INDEX idx_change_log_replay_until ON change_log(replay_until_ms);

PRAGMA foreign_keys = ON;
