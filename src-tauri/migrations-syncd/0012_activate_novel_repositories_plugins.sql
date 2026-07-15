PRAGMA foreign_keys = OFF;

-- The v1 tables were placeholders that never participated in snapshot or
-- mutations. Preserve them verbatim for audit/recovery instead of coercing
-- incomplete rows into the active v2 contract.
ALTER TABLE novel_plugins RENAME TO novel_plugins_v1_legacy;
ALTER TABLE novel_repositories RENAME TO novel_repositories_v1_legacy;

CREATE TABLE novel_repositories (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'novels:profile:*'),
  repository_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, repository_id),
  UNIQUE (scope_id, canonical_url)
) STRICT, WITHOUT ROWID;

CREATE TABLE novel_plugins (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'novels:profile:*'),
  plugin_entity_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  lang TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  artifact_sha256 TEXT NOT NULL CHECK (
    length(artifact_sha256) = 64
    AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_byte_length INTEGER NOT NULL CHECK (
    artifact_byte_length > 0 AND artifact_byte_length <= 2097152
  ),
  public_settings_json TEXT NOT NULL CHECK (
    json_valid(public_settings_json)
    AND json_type(public_settings_json) = 'object'
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, plugin_entity_id),
  UNIQUE (scope_id, repository_id, plugin_id, source_id),
  FOREIGN KEY (scope_id, repository_id)
    REFERENCES novel_repositories(scope_id, repository_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_novel_plugins_repository
  ON novel_plugins(scope_id, repository_id, plugin_id, source_id);
CREATE INDEX idx_novel_plugins_artifact
  ON novel_plugins(scope_id, artifact_sha256);

-- Retained across plugin deletes so a previously observed version can never
-- be rebound to different executable bytes. This also makes rollback safe.
CREATE TABLE novel_plugin_artifact_versions (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'novels:profile:*'),
  plugin_entity_id TEXT NOT NULL,
  version TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK (
    length(artifact_sha256) = 64
    AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_byte_length INTEGER NOT NULL CHECK (
    artifact_byte_length > 0 AND artifact_byte_length <= 2097152
  ),
  first_seen_at_ms INTEGER NOT NULL CHECK (first_seen_at_ms >= 0),
  PRIMARY KEY (scope_id, plugin_entity_id, version)
) STRICT, WITHOUT ROWID;

CREATE TABLE novel_repository_aliases (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'novels:profile:*'),
  alias_entity_id TEXT NOT NULL,
  canonical_entity_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_id, alias_entity_id),
  CHECK (alias_entity_id <> canonical_entity_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_novel_repository_alias_canonical
  ON novel_repository_aliases(scope_id, canonical_entity_id);

CREATE TABLE novel_plugin_aliases (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'novels:profile:*'),
  alias_entity_id TEXT NOT NULL,
  canonical_entity_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_id, alias_entity_id),
  CHECK (alias_entity_id <> canonical_entity_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_novel_plugin_alias_canonical
  ON novel_plugin_aliases(scope_id, canonical_entity_id);

PRAGMA foreign_keys = ON;
