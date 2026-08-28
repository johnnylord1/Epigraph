CREATE TABLE suwayomi_projection_outbox (
  operation_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  operation_name TEXT NOT NULL CHECK (
    operation_name IN ('UpdateManga', 'UpdateMangaCategories', 'UpdateChaptersProgress')
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

CREATE INDEX idx_suwayomi_projection_ready
  ON suwayomi_projection_outbox(status, next_attempt_at_ms, source_server_version);

CREATE INDEX idx_suwayomi_projection_entity
  ON suwayomi_projection_outbox(profile_id, entity_type, entity_id, source_server_version);
