PRAGMA foreign_keys = OFF;

CREATE TABLE change_log_new (
  server_version INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  profile_id TEXT,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'novel.entry','novel.chapter','novel.progress','novel.bookmark','novel.history','novel.repository','novel.plugin',
      'book.entry','book.category','book.category_assignment','book.library_ui','book.asset','book.progress','book.bookmark'
    )
  ),
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('merge','delete')),
  lamport INTEGER NOT NULL CHECK (lamport >= 0),
  changed_by_device_id TEXT NOT NULL,
  patch_json TEXT CHECK (patch_json IS NULL OR json_valid(patch_json)),
  replay_until_ms INTEGER NOT NULL,
  applied_at_ms INTEGER NOT NULL
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
  patch_json,
  replay_until_ms,
  applied_at_ms
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
  patch_json,
  replay_until_ms,
  applied_at_ms
FROM change_log;

DROP TABLE change_log;
ALTER TABLE change_log_new RENAME TO change_log;

CREATE INDEX idx_change_log_scope_version ON change_log(scope_id, server_version);
CREATE INDEX idx_change_log_replay_until ON change_log(replay_until_ms);

CREATE TABLE book_categories (
  scope_id TEXT NOT NULL CHECK (scope_id = 'books:global'),
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, category_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE book_category_assignments (
  scope_id TEXT NOT NULL CHECK (scope_id = 'books:global'),
  book_id TEXT NOT NULL,
  category_ids_json TEXT NOT NULL CHECK (json_valid(category_ids_json)),
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, book_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE book_library_ui_state (
  scope_id TEXT NOT NULL CHECK (scope_id = 'books:global'),
  ui_state_id TEXT NOT NULL,
  active_category_id TEXT,
  type_filter TEXT NOT NULL,
  status_filter TEXT NOT NULL,
  search TEXT NOT NULL,
  sort_mode TEXT NOT NULL,
  sort_dir TEXT NOT NULL,
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, ui_state_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE novel_chapters (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'novels:profile:*'),
  chapter_id TEXT NOT NULL,
  novel_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  chapter_order_key REAL NOT NULL,
  release_time_ms INTEGER,
  unread INTEGER NOT NULL CHECK (unread IN (0,1)),
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, chapter_id)
) STRICT, WITHOUT ROWID;

PRAGMA foreign_keys = ON;
