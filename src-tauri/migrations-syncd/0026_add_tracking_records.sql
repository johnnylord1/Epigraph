PRAGMA foreign_keys = OFF;

-- Full-state tracker bindings (`comic.tracking`, `novel.tracking`).  The record
-- is stored as a whole (record-level LWW); unknown fields are preserved.
-- Credentials never live here: they are sealed separately with DPAPI.
CREATE TABLE tracking_records (
  scope_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('comic.tracking', 'novel.tracking')),
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

CREATE INDEX idx_tracking_records_work
  ON tracking_records(scope_id, entity_type, work_id, tracker_key);

-- Bookkeeping for the Suwayomi tracking mirror: the last Suwayomi state and
-- Core server version that were reconciled for each tracking entity.
CREATE TABLE suwayomi_tracking_mirror_state (
  profile_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  suwayomi_fingerprint TEXT,
  core_server_version INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (profile_id, entity_id)
) STRICT, WITHOUT ROWID;

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
      'comic.tracking'
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
