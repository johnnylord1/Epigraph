-- When a synced work whose source failed is due again. Kept only in memory, every Core restart tried
-- all of them at once, each one costing Suwayomi a source request. Losing these rows is harmless:
-- the works are simply tried again.
CREATE TABLE IF NOT EXISTS suwayomi_hydration_retries (
  profile_id TEXT NOT NULL,
  manga_id INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  next_attempt_at_ms INTEGER NOT NULL,
  PRIMARY KEY (profile_id, manga_id)
) STRICT, WITHOUT ROWID;
