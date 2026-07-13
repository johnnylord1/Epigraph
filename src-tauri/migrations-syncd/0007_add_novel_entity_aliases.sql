CREATE TABLE novel_entity_aliases (
  scope_id TEXT NOT NULL CHECK (scope_id GLOB 'novels:profile:*'),
  alias_entity_id TEXT NOT NULL,
  canonical_entity_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_id, alias_entity_id),
  CHECK (alias_entity_id <> canonical_entity_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_novel_entity_alias_canonical
  ON novel_entity_aliases(scope_id, canonical_entity_id);
