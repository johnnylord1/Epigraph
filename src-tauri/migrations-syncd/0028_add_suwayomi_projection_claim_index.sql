-- Claiming a projection takes the earliest due row of one kind (library and category changes,
-- then chapter progress). Without an index in that order every claim sorted the whole due queue:
-- about 150 ms per claim with 25,000 queued progress rows, twice per applied row and all while
-- holding the syncd write gate, so a first sync drained one or two rows a second and device
-- pushes waited behind it. Walking this index the claim stops at its first due row.
-- A later migration that rebuilds suwayomi_projection_outbox must recreate this index.
CREATE INDEX IF NOT EXISTS idx_suwayomi_projection_claim
  ON suwayomi_projection_outbox((operation_name = 'UpdateChaptersProgress'), source_server_version)
  WHERE status IN ('pending', 'retry');
