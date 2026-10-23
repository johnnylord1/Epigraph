-- Claiming a projection checks, for every due row, whether an earlier row of the same profile is
-- still in its ordered retries. Without an index on (profile, status, version) that check read the
-- whole profile queue per candidate: about 36 s per claim with 3,400 queued rows, all while holding
-- the syncd write gate, so device pushes timed out behind it. With it the claim takes milliseconds.
-- A later migration that rebuilds suwayomi_projection_outbox must recreate this index.
CREATE INDEX IF NOT EXISTS idx_suwayomi_projection_order
  ON suwayomi_projection_outbox(profile_id, status, source_server_version);
