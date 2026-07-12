CREATE TABLE mutation_receipts (
  device_id TEXT NOT NULL,
  client_mutation_id TEXT NOT NULL,
  mutation_hash TEXT NOT NULL CHECK (length(mutation_hash) = 64),
  mutation_json TEXT NOT NULL CHECK (json_valid(mutation_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  applied_server_version INTEGER,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, client_mutation_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_mutation_receipts_created_at
  ON mutation_receipts(created_at_ms);
