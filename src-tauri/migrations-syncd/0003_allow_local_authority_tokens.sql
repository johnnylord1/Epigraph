PRAGMA foreign_keys = OFF;

CREATE TABLE paired_device_tokens_new (
  token_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES trusted_devices(device_id),
  profile_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  issued_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  inactivity_expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  granted_via TEXT NOT NULL CHECK (granted_via IN ('qr','trusted-pool','local-authority'))
) STRICT;

INSERT INTO paired_device_tokens_new (
  token_id,
  device_id,
  profile_id,
  token_hash,
  issued_at_ms,
  last_seen_at_ms,
  inactivity_expires_at_ms,
  revoked_at_ms,
  granted_via
)
SELECT
  token_id,
  device_id,
  profile_id,
  token_hash,
  issued_at_ms,
  last_seen_at_ms,
  inactivity_expires_at_ms,
  revoked_at_ms,
  granted_via
FROM paired_device_tokens;

DROP TABLE paired_device_tokens;
ALTER TABLE paired_device_tokens_new RENAME TO paired_device_tokens;

PRAGMA foreign_keys = ON;
