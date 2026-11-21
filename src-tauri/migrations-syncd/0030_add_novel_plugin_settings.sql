PRAGMA foreign_keys = OFF;

-- LNReader novel plugin settings (`novel.plugin_setting`): one record per novel
-- plugin and declared setting key, such as a plugin's preferred translation.
-- Records reuse `tracking_records` (record-level LWW) with work_id = plugin id
-- and tracker_key = setting key.  Credentials, sessions and caches never enter
-- these records.

CREATE TABLE tracking_records_new (
  scope_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN ('comic.tracking', 'novel.tracking', 'novel.plugin_setting')
  ),
  entity_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  tracker_key TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, entity_type, entity_id)
) STRICT, WITHOUT ROWID;

INSERT INTO tracking_records_new (
  scope_id, entity_type, entity_id, work_id, tracker_key, record_json,
  record_updated_at_ms, record_updated_by_device_id, record_lamport,
  record_server_version
)
SELECT
  scope_id, entity_type, entity_id, work_id, tracker_key, record_json,
  record_updated_at_ms, record_updated_by_device_id, record_lamport,
  record_server_version
FROM tracking_records;

DROP TABLE tracking_records;
ALTER TABLE tracking_records_new RENAME TO tracking_records;

CREATE INDEX idx_tracking_records_work
  ON tracking_records(scope_id, entity_type, work_id, tracker_key);

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
      'novel.tracking',
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
      'comic.page_bookmark',
      'comic.tracking',
      'comic.source_preference',
      'novel.plugin_setting'
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

-- A pruned change log must never let server versions restart below the
-- version already published to clients.
INSERT INTO sqlite_sequence (name, seq)
SELECT 'change_log', 0
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'change_log');

UPDATE sqlite_sequence
SET seq = MAX(
  seq,
  COALESCE((SELECT current_server_version FROM server_runtime WHERE singleton_id = 1), 0)
)
WHERE name = 'change_log';

PRAGMA foreign_keys = ON;
