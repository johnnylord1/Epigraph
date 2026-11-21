PRAGMA foreign_keys = OFF;

-- Extension source preferences (`comic.source_preference`): one record per
-- Suwayomi/Tachiyomi source and preference key, such as a source's preferred
-- mirror.  Only simple user choices are synced; secrets and extension caches
-- never enter these records.

-- Bookkeeping for the Suwayomi source preference mirror: the desktop value and
-- Core server version that were last reconciled for each preference entity.
CREATE TABLE suwayomi_source_preference_mirror_state (
  profile_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  agreed_fingerprint TEXT,
  core_server_version INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (profile_id, entity_id)
) STRICT, WITHOUT ROWID;

-- Profiles whose desktop preferences the mirror already looked at once.  Values
-- found on that first look are remembered, not published; keys stored later are
-- desktop choices.
CREATE TABLE suwayomi_source_preference_mirror_profiles (
  profile_id TEXT PRIMARY KEY,
  baselined_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE comic_sync_state_new (
  scope_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'comic.entry',
      'comic.category',
      'comic.category_assignment',
      'comic.chapter_state',
      'comic.source_preference'
    )
  ),
  entity_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL,
  record_server_version INTEGER NOT NULL,
  PRIMARY KEY (scope_id, entity_type, entity_id)
) STRICT, WITHOUT ROWID;

INSERT INTO comic_sync_state_new (
  scope_id, entity_type, entity_id, record_json, record_updated_at_ms,
  record_updated_by_device_id, record_lamport, record_server_version
)
SELECT
  scope_id, entity_type, entity_id, record_json, record_updated_at_ms,
  record_updated_by_device_id, record_lamport, record_server_version
FROM comic_sync_state;

DROP TABLE comic_sync_state;
ALTER TABLE comic_sync_state_new RENAME TO comic_sync_state;

CREATE INDEX idx_comic_sync_state_snapshot
  ON comic_sync_state(scope_id, entity_type, entity_id);

CREATE TABLE suwayomi_projection_outbox_new (
  operation_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  operation_name TEXT NOT NULL CHECK (
    operation_name IN (
      'UpdateManga',
      'UpdateMangaCategories',
      'UpdateChaptersProgress',
      'UpdateCategory',
      'DeleteCategory',
      'UpdateCategoryOrder',
      'RemoveComicCategoryAssignment',
      'UpdateSourcePreference'
    )
  ),
  variables_json TEXT NOT NULL CHECK (json_valid(variables_json)),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_server_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'in_flight', 'retry', 'blocked')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL,
  lease_until_ms INTEGER,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

INSERT INTO suwayomi_projection_outbox_new (
  operation_id, profile_id, operation_name, variables_json,
  entity_type, entity_id, source_server_version, status, attempt_count,
  next_attempt_at_ms, lease_until_ms, last_error, created_at_ms, updated_at_ms
)
SELECT
  operation_id, profile_id, operation_name, variables_json,
  entity_type, entity_id, source_server_version, status, attempt_count,
  next_attempt_at_ms, lease_until_ms, last_error, created_at_ms, updated_at_ms
FROM suwayomi_projection_outbox;

DROP TABLE suwayomi_projection_outbox;
ALTER TABLE suwayomi_projection_outbox_new RENAME TO suwayomi_projection_outbox;

CREATE INDEX idx_suwayomi_projection_ready
  ON suwayomi_projection_outbox(status, next_attempt_at_ms, source_server_version);

CREATE INDEX idx_suwayomi_projection_entity
  ON suwayomi_projection_outbox(profile_id, entity_type, entity_id, source_server_version);

-- Recreated from 0027 and 0028.  A later migration that rebuilds
-- suwayomi_projection_outbox must recreate these indexes too.
CREATE INDEX idx_suwayomi_projection_order
  ON suwayomi_projection_outbox(profile_id, status, source_server_version);

CREATE INDEX idx_suwayomi_projection_claim
  ON suwayomi_projection_outbox((operation_name = 'UpdateChaptersProgress'), source_server_version)
  WHERE status IN ('pending', 'retry');

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
      'comic.source_preference'
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
