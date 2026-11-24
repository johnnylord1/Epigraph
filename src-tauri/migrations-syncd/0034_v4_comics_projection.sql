CREATE TABLE v4_comics_projection (
    profile_id TEXT PRIMARY KEY,
    target_seq INTEGER NOT NULL CHECK(target_seq > 0),
    applied_seq INTEGER NOT NULL DEFAULT 0 CHECK(applied_seq >= 0),
    next_attempt_ms INTEGER NOT NULL DEFAULT 0
);
