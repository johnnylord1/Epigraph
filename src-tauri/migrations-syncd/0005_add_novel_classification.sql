PRAGMA foreign_keys = OFF;

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
      'book.bookmark'
    )
  ),
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('merge', 'delete')),
  lamport INTEGER NOT NULL,
  changed_by_device_id TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL,
  patch_json TEXT,
  replay_until_ms INTEGER NOT NULL
);

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

CREATE TABLE IF NOT EXISTS novel_source_classification_records (
  scope_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  repository_id TEXT,
  repository_url TEXT,
  lang TEXT,
  version TEXT,
  status TEXT NOT NULL,
  notes TEXT NOT NULL,
  baseline_status TEXT,
  baseline_notes TEXT,
  issues_json TEXT NOT NULL,
  smoke_json TEXT NOT NULL,
  filter_keys_json TEXT NOT NULL,
  plugin_settings_keys_json TEXT NOT NULL,
  classified_at_ms INTEGER NOT NULL,
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL,
  record_server_version INTEGER NOT NULL,
  PRIMARY KEY (scope_id, plugin_id)
);

PRAGMA foreign_keys = ON;
