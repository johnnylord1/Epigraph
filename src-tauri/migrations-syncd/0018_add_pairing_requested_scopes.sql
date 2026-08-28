ALTER TABLE pairing_sessions
ADD COLUMN requested_scopes_json TEXT
CHECK (requested_scopes_json IS NULL OR json_valid(requested_scopes_json));

-- Preserve the historical all-domain grant once for databases created before
-- per-pairing scope selection. Future scope changes must not be overwritten at startup.
INSERT OR IGNORE INTO paired_device_scopes (token_id, scope_id)
SELECT token_id, 'comics:profile:' || profile_id
FROM paired_device_tokens
WHERE revoked_at_ms IS NULL;
