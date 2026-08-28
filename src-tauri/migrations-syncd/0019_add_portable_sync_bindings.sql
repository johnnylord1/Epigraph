CREATE TABLE portable_work_bindings (
  profile_id TEXT NOT NULL,
  portable_id TEXT NOT NULL,
  ecosystem TEXT NOT NULL CHECK (ecosystem IN ('SUWAYOMI', 'LNREADER')),
  source_id TEXT,
  plugin_id TEXT,
  provider_key TEXT NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 4096),
  dependency_key TEXT,
  local_reference TEXT,
  resolution_state TEXT NOT NULL CHECK (
    resolution_state IN (
        'PENDING_DEPENDENCY', 'PENDING_PROVIDER', 'RESOLVING', 'READY', 'BOUND',
      'RETRYABLE_FAILURE', 'REQUIRES_USER_ACTION', 'LEGACY_UNBOUND', 'CONFLICT'
    )
  ),
  resolution_reason TEXT,
  title_hint TEXT,
  provider_label_hint TEXT,
  record_lamport INTEGER NOT NULL DEFAULT 0 CHECK (record_lamport >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (profile_id, portable_id),
  UNIQUE (profile_id, ecosystem, source_id, plugin_id, provider_key),
  CHECK (
    (ecosystem = 'SUWAYOMI' AND source_id IS NOT NULL AND plugin_id IS NULL) OR
    (ecosystem = 'LNREADER' AND source_id IS NULL AND plugin_id IS NOT NULL)
  ),
  CHECK (resolution_state <> 'BOUND' OR local_reference IS NOT NULL)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_portable_work_resolution
  ON portable_work_bindings(profile_id, resolution_state, ecosystem, updated_at_ms);

CREATE TABLE portable_chapter_bindings (
  profile_id TEXT NOT NULL,
  portable_chapter_id TEXT NOT NULL,
  portable_work_id TEXT NOT NULL,
  provider_key TEXT NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 4096),
  local_reference TEXT,
  resolution_state TEXT NOT NULL CHECK (
    resolution_state IN (
        'PENDING_DEPENDENCY', 'PENDING_PROVIDER', 'RESOLVING', 'READY', 'BOUND',
      'RETRYABLE_FAILURE', 'REQUIRES_USER_ACTION', 'LEGACY_UNBOUND', 'CONFLICT'
    )
  ),
  resolution_reason TEXT,
  record_lamport INTEGER NOT NULL DEFAULT 0 CHECK (record_lamport >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (profile_id, portable_chapter_id),
  UNIQUE (profile_id, portable_work_id, provider_key),
  FOREIGN KEY (profile_id, portable_work_id)
    REFERENCES portable_work_bindings(profile_id, portable_id) ON DELETE CASCADE,
  CHECK (resolution_state <> 'BOUND' OR local_reference IS NOT NULL)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_portable_chapter_resolution
  ON portable_chapter_bindings(profile_id, resolution_state, portable_work_id, updated_at_ms);

CREATE TABLE portable_comic_dependencies (
  profile_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  required_source_ids_json TEXT NOT NULL CHECK (json_valid(required_source_ids_json)),
  observed_version_code TEXT,
  extension_store_index_url TEXT,
  observed_manifest_sha256 TEXT,
  display_name_hint TEXT,
  trust_state TEXT NOT NULL CHECK (trust_state IN ('TRUSTED', 'APPROVAL_REQUIRED', 'REJECTED')),
  resolution_state TEXT NOT NULL CHECK (
    resolution_state IN (
        'PENDING_DEPENDENCY', 'PENDING_PROVIDER', 'RESOLVING', 'READY', 'BOUND',
      'RETRYABLE_FAILURE', 'REQUIRES_USER_ACTION', 'LEGACY_UNBOUND', 'CONFLICT'
    )
  ),
  resolution_reason TEXT,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (profile_id, package_name)
) STRICT, WITHOUT ROWID;

CREATE TABLE portable_novel_dependencies (
  profile_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  observed_version TEXT,
  repository_index_url TEXT,
  observed_manifest_sha256 TEXT,
  observed_artifact_sha256 TEXT,
  display_name_hint TEXT,
  trust_state TEXT NOT NULL CHECK (trust_state IN ('TRUSTED', 'APPROVAL_REQUIRED', 'REJECTED')),
  resolution_state TEXT NOT NULL CHECK (
    resolution_state IN (
        'PENDING_DEPENDENCY', 'PENDING_PROVIDER', 'RESOLVING', 'READY', 'BOUND',
      'RETRYABLE_FAILURE', 'REQUIRES_USER_ACTION', 'LEGACY_UNBOUND', 'CONFLICT'
    )
  ),
  resolution_reason TEXT,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (profile_id, plugin_id)
) STRICT, WITHOUT ROWID;
