-- Sync V4 canonical state, change log, idempotency receipts, profile watermarks,
-- and LAN extension package cache metadata.
-- Designed with zero rigid CHECK(entity_type IN ...) constraints so new entity types
-- never require destructive table rebuild migrations.

CREATE TABLE IF NOT EXISTS v4_records (
    profile_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    hlc_ts_ms INTEGER NOT NULL,
    hlc_counter INTEGER NOT NULL,
    hlc_device_id TEXT NOT NULL,
    origin_device_id TEXT NOT NULL,
    server_seq INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    PRIMARY KEY (profile_id, entity_type, entity_key)
);

CREATE INDEX IF NOT EXISTS idx_v4_records_profile_seq
    ON v4_records (profile_id, server_seq);

CREATE INDEX IF NOT EXISTS idx_v4_records_profile_domain
    ON v4_records (profile_id, domain, entity_type, deleted);

CREATE INDEX IF NOT EXISTS idx_v4_records_tombstone_gc
    ON v4_records (deleted, deleted_at_ms)
    WHERE deleted = 1;

CREATE TABLE IF NOT EXISTS v4_change_log (
    server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    hlc_ts_ms INTEGER NOT NULL,
    hlc_counter INTEGER NOT NULL,
    hlc_device_id TEXT NOT NULL,
    origin_device_id TEXT NOT NULL,
    client_mutation_id TEXT,
    payload_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v4_change_log_profile_seq
    ON v4_change_log (profile_id, server_seq);

CREATE INDEX IF NOT EXISTS idx_v4_change_log_created
    ON v4_change_log (created_at_ms);

CREATE TABLE IF NOT EXISTS v4_mutation_receipts (
    profile_id TEXT NOT NULL,
    origin_device_id TEXT NOT NULL,
    client_mutation_id TEXT NOT NULL,
    server_seq INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (profile_id, origin_device_id, client_mutation_id)
);

CREATE INDEX IF NOT EXISTS idx_v4_mutation_receipts_created
    ON v4_mutation_receipts (created_at_ms);

CREATE TABLE IF NOT EXISTS v4_profile_watermarks (
    profile_id TEXT PRIMARY KEY,
    current_seq INTEGER NOT NULL DEFAULT 0,
    min_replayable_seq INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v4_extension_packages (
    kind TEXT NOT NULL,
    package_id TEXT NOT NULL,
    version TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    uploaded_by_device_id TEXT NOT NULL,
    uploaded_at_ms INTEGER NOT NULL,
    PRIMARY KEY (kind, package_id, version)
);

CREATE INDEX IF NOT EXISTS idx_v4_extension_packages_sha256
    ON v4_extension_packages (sha256);

-- Repair any legacy tombstones poisoned by the swapped deleted_at_ms / server_version args.
UPDATE tombstones
SET
    deleted_at_ms = server_version,
    server_version = deleted_at_ms,
    retain_until_ms = server_version + 2592000000
WHERE server_version > 1000000000000
  AND deleted_at_ms < 1000000000000;
