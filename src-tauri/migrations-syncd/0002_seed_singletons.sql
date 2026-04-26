INSERT INTO server_identity (
  singleton_id,
  server_id,
  server_protocol_version,
  min_client_version,
  tls_cert_sha256,
  mdns_service_name,
  created_at_ms,
  updated_at_ms
) VALUES (
  1,
  'pending-server-id',
  1,
  '0.1.0',
  '',
  '_aethon-sync._tcp.local',
  0,
  0
)
ON CONFLICT(singleton_id) DO NOTHING;

INSERT INTO server_runtime (
  singleton_id,
  current_server_version,
  min_replayable_server_version,
  oldest_retained_change_at_ms,
  lan_exposure_mode,
  lan_bind_host,
  lan_port,
  lan_expires_at_ms,
  updated_at_ms
) VALUES (
  1,
  0,
  0,
  NULL,
  'loopback',
  NULL,
  NULL,
  NULL,
  0
)
ON CONFLICT(singleton_id) DO NOTHING;
