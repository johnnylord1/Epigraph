CREATE TABLE entity_event_clocks (
  scope_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  physical_ms INTEGER NOT NULL CHECK (physical_ms >= 0),
  logical INTEGER NOT NULL CHECK (logical >= 0),
  device_generation_id TEXT NOT NULL CHECK (
    length(device_generation_id) BETWEEN 1 AND 256
    AND device_generation_id = trim(device_generation_id)
  ),
  authenticated_device_id TEXT NOT NULL CHECK (
    length(authenticated_device_id) BETWEEN 1 AND 256
    AND authenticated_device_id = trim(authenticated_device_id)
  ),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_id, entity_type, entity_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_entity_event_clocks_updated_at
  ON entity_event_clocks(updated_at_ms);
