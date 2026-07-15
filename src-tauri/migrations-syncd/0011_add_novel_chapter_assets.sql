PRAGMA foreign_keys = OFF;

CREATE TABLE novel_chapter_assets (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'novels:profile:*'),
  chapter_asset_id TEXT NOT NULL,
  novel_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  blob_sha256 TEXT NOT NULL CHECK (
    length(blob_sha256) = 64
    AND blob_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  archive_format TEXT NOT NULL CHECK (archive_format = 'zip'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, chapter_asset_id),
  UNIQUE (scope_id, novel_id, chapter_id),
  FOREIGN KEY (scope_id, novel_id)
    REFERENCES novel_library_entries(scope_id, novel_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, chapter_id)
    REFERENCES novel_chapters(scope_id, chapter_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_novel_chapter_assets_novel
  ON novel_chapter_assets(scope_id, novel_id, chapter_id);
CREATE INDEX idx_novel_chapter_assets_blob
  ON novel_chapter_assets(scope_id, blob_sha256);

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
      'book.history',
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
