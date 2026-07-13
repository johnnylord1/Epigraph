PRAGMA foreign_keys = OFF;

CREATE TABLE comic_history (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'comics:profile:*'),
  history_id TEXT NOT NULL,
  comic_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  page_index INTEGER NOT NULL CHECK (page_index >= 0),
  page_count INTEGER CHECK (page_count IS NULL OR page_count > 0),
  progress_percent REAL NOT NULL CHECK (progress_percent >= 0 AND progress_percent <= 1),
  read_at_ms INTEGER NOT NULL CHECK (read_at_ms >= 0),
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, history_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE comic_page_bookmarks (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'comics:profile:*'),
  bookmark_id TEXT NOT NULL,
  comic_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  page_index INTEGER NOT NULL CHECK (page_index >= 0),
  page_count INTEGER CHECK (page_count IS NULL OR page_count > 0),
  label TEXT,
  saved_at_ms INTEGER NOT NULL CHECK (saved_at_ms >= 0),
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, bookmark_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE change_log_new (
  server_version INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  profile_id TEXT,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'novel.entry',
      'novel.chapter',
      'novel.progress',
      'novel.bookmark',
      'novel.history',
      'novel.classification',
      'novel.repository',
      'novel.plugin',
      'book.entry',
      'book.asset',
      'book.category',
      'book.category_assignment',
      'book.library_ui',
      'book.progress',
      'book.bookmark',
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
CREATE INDEX idx_comic_history_parent ON comic_history(scope_id, comic_id);
CREATE INDEX idx_comic_page_bookmarks_parent
  ON comic_page_bookmarks(scope_id, comic_id, chapter_id, page_index);

PRAGMA foreign_keys = ON;
