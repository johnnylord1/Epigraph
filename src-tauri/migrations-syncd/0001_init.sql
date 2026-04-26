CREATE TABLE server_identity (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  server_id TEXT NOT NULL UNIQUE,
  server_protocol_version INTEGER NOT NULL CHECK (server_protocol_version >= 1),
  min_client_version TEXT NOT NULL,
  tls_cert_sha256 TEXT NOT NULL,
  mdns_service_name TEXT NOT NULL DEFAULT '_aethon-sync._tcp.local',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE server_runtime (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  current_server_version INTEGER NOT NULL DEFAULT 0 CHECK (current_server_version >= 0),
  min_replayable_server_version INTEGER NOT NULL DEFAULT 0 CHECK (min_replayable_server_version >= 0),
  oldest_retained_change_at_ms INTEGER,
  lan_exposure_mode TEXT NOT NULL CHECK (lan_exposure_mode IN ('loopback','temporary-lan')),
  lan_bind_host TEXT,
  lan_port INTEGER,
  lan_expires_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE pairing_sessions (
  session_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  pairing_code TEXT NOT NULL UNIQUE,
  tls_cert_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','approved','rejected','expired')),
  claimed_device_id TEXT,
  claimed_device_name TEXT,
  claimed_platform TEXT CHECK (claimed_platform IN ('android','desktop','unknown')),
  expires_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER,
  approved_at_ms INTEGER,
  rejected_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE trusted_devices (
  device_id TEXT PRIMARY KEY,
  trusted_host_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('android','desktop','unknown')),
  first_trusted_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER,
  revoked_at_ms INTEGER
) STRICT;

CREATE TABLE paired_device_tokens (
  token_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES trusted_devices(device_id),
  profile_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  issued_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  inactivity_expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  granted_via TEXT NOT NULL CHECK (granted_via IN ('qr','trusted-pool'))
) STRICT;

CREATE TABLE paired_device_scopes (
  token_id TEXT NOT NULL REFERENCES paired_device_tokens(token_id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  PRIMARY KEY (token_id, scope_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE novel_library_entries (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'novels:profile:*'),
  novel_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  description TEXT,
  cover_url TEXT,
  external_novel_id TEXT,
  external_url TEXT,
  status TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  added_at_ms INTEGER NOT NULL,
  entry_updated_at_ms INTEGER NOT NULL,
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, novel_id),
  UNIQUE (scope_id, identity_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE novel_progress (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'novels:profile:*'),
  novel_id TEXT NOT NULL,
  chapter_id TEXT,
  chapter_title TEXT,
  chapter_order_key REAL,
  progress_percent REAL NOT NULL CHECK (progress_percent >= 0 AND progress_percent <= 1),
  locator TEXT,
  locator_sort_key REAL,
  updated_at_ms INTEGER NOT NULL,
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, novel_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE novel_bookmarks (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'novels:profile:*'),
  bookmark_id TEXT NOT NULL,
  novel_id TEXT NOT NULL,
  chapter_id TEXT,
  chapter_title TEXT,
  chapter_order_key REAL,
  locator TEXT,
  locator_sort_key REAL,
  label TEXT,
  saved_at_ms INTEGER NOT NULL,
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, bookmark_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE novel_history (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'novels:profile:*'),
  history_id TEXT NOT NULL,
  novel_id TEXT NOT NULL,
  chapter_id TEXT,
  chapter_title TEXT,
  chapter_order_key REAL,
  locator TEXT,
  locator_sort_key REAL,
  read_at_ms INTEGER NOT NULL,
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, history_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE novel_repositories (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'novels:profile:*'),
  repository_id TEXT NOT NULL,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  name TEXT,
  equivalence_group TEXT,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('enabled','disabled')),
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, repository_id),
  UNIQUE (scope_id, canonical_url)
) STRICT, WITHOUT ROWID;

CREATE TABLE novel_plugins (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'novels:profile:*'),
  plugin_instance_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  repository_id TEXT,
  name TEXT,
  version TEXT,
  source_id TEXT,
  source_name TEXT,
  lang TEXT,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('enabled','disabled')),
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, plugin_instance_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE book_library_entries (
  scope_id TEXT NOT NULL CHECK (scope_id = 'books:global'),
  book_id TEXT NOT NULL,
  asset_fingerprint TEXT,
  title TEXT NOT NULL,
  author TEXT,
  description TEXT,
  subtype TEXT NOT NULL CHECK (subtype IN ('epub','pdf')),
  page_count INTEGER,
  toc_count INTEGER,
  spine_count INTEGER,
  section_count INTEGER,
  sections_summary_json TEXT CHECK (sections_summary_json IS NULL OR json_valid(sections_summary_json)),
  has_cover INTEGER NOT NULL CHECK (has_cover IN (0,1)),
  created_at_ms INTEGER NOT NULL,
  book_updated_at_ms INTEGER NOT NULL,
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, book_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE book_assets (
  scope_id TEXT NOT NULL CHECK (scope_id = 'books:global'),
  book_id TEXT NOT NULL,
  owner_device_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL DEFAULT 1 CHECK (owner_generation >= 1),
  subtype TEXT NOT NULL CHECK (subtype IN ('epub','pdf')),
  asset_fingerprint TEXT NOT NULL,
  etag TEXT,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  cover_available INTEGER NOT NULL CHECK (cover_available IN (0,1)),
  cover_etag TEXT,
  manifest_updated_at_ms INTEGER NOT NULL,
  owner_last_seen_at_ms INTEGER,
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, book_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE book_progress (
  scope_id TEXT NOT NULL CHECK (scope_id = 'books:global'),
  book_id TEXT NOT NULL,
  renderer TEXT CHECK (renderer IN ('epub','pdf')),
  location TEXT,
  href TEXT,
  progress_percent REAL NOT NULL CHECK (progress_percent >= 0 AND progress_percent <= 1),
  last_read_at_ms INTEGER NOT NULL,
  page_index INTEGER,
  total_pages INTEGER,
  section_label TEXT,
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, book_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE book_bookmarks (
  scope_id TEXT NOT NULL CHECK (scope_id = 'books:global'),
  bookmark_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  location TEXT,
  href TEXT,
  page_index INTEGER,
  progress_percent REAL NOT NULL CHECK (progress_percent >= 0 AND progress_percent <= 1),
  label TEXT,
  saved_at_ms INTEGER NOT NULL,
  record_updated_at_ms INTEGER NOT NULL,
  record_updated_by_device_id TEXT NOT NULL,
  record_lamport INTEGER NOT NULL CHECK (record_lamport >= 0),
  record_server_version INTEGER NOT NULL CHECK (record_server_version >= 0),
  PRIMARY KEY (scope_id, bookmark_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE book_owner_transfers (
  transfer_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL CHECK (scope_id = 'books:global'),
  book_id TEXT NOT NULL,
  previous_owner_device_id TEXT NOT NULL,
  new_owner_device_id TEXT NOT NULL,
  previous_owner_generation INTEGER NOT NULL,
  new_owner_generation INTEGER NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('owner_offline_cache_promote','manual_repair')),
  approved_at_ms INTEGER NOT NULL,
  approved_by_device_id TEXT NOT NULL,
  integrity_snapshot_json TEXT NOT NULL CHECK (json_valid(integrity_snapshot_json))
) STRICT;

CREATE TABLE change_log (
  server_version INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  profile_id TEXT,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'novel.entry','novel.progress','novel.bookmark','novel.history','novel.repository','novel.plugin',
      'book.entry','book.asset','book.progress','book.bookmark'
    )
  ),
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('merge','delete')),
  lamport INTEGER NOT NULL CHECK (lamport >= 0),
  changed_by_device_id TEXT NOT NULL,
  patch_json TEXT CHECK (patch_json IS NULL OR json_valid(patch_json)),
  replay_until_ms INTEGER NOT NULL,
  applied_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE tombstones (
  scope_id TEXT NOT NULL,
  profile_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  deleted_by_device_id TEXT NOT NULL,
  lamport INTEGER NOT NULL CHECK (lamport >= 0),
  deleted_at_ms INTEGER NOT NULL,
  server_version INTEGER NOT NULL,
  retain_until_ms INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  PRIMARY KEY (scope_id, entity_type, entity_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE diagnostic_events (
  event_id TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  event_type TEXT NOT NULL,
  device_id TEXT,
  profile_id TEXT,
  scope_id TEXT,
  entity_id TEXT,
  reason_code TEXT NOT NULL,
  lamport INTEGER,
  server_version INTEGER,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_change_log_scope_version ON change_log(scope_id, server_version);
CREATE INDEX idx_change_log_replay_until ON change_log(replay_until_ms);
CREATE INDEX idx_tombstones_retain_until ON tombstones(retain_until_ms);
CREATE INDEX idx_tokens_expiry ON paired_device_tokens(inactivity_expires_at_ms, revoked_at_ms);
CREATE INDEX idx_book_assets_owner ON book_assets(owner_device_id, owner_generation);
CREATE INDEX idx_novel_identity ON novel_library_entries(scope_id, identity_key);
