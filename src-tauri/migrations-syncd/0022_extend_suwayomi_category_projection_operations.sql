PRAGMA foreign_keys = OFF;

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
      'UpdateCategoryOrder'
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

PRAGMA foreign_keys = ON;
