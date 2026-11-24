-- Rotate a scope's validator with every manifest input write, in the same transaction.
-- Random revisions remain distinct when a restored database resumes an older sequence.
CREATE TABLE novel_manifest_revisions (
  scope_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL CHECK (length(revision) = 32)
) STRICT, WITHOUT ROWID;

INSERT INTO novel_manifest_revisions (scope_id, revision)
SELECT scope_id, lower(hex(randomblob(16)))
FROM (
  SELECT scope_id FROM novel_library_entries
  UNION SELECT scope_id FROM novel_plugins
  UNION SELECT scope_id FROM novel_repositories
);

CREATE TRIGGER novel_library_entries_manifest_insert
AFTER INSERT ON novel_library_entries
BEGIN
  INSERT INTO novel_manifest_revisions (scope_id, revision)
  VALUES (NEW.scope_id, lower(hex(randomblob(16))))
  ON CONFLICT(scope_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER novel_library_entries_manifest_update
AFTER UPDATE ON novel_library_entries
BEGIN
  INSERT INTO novel_manifest_revisions (scope_id, revision)
  VALUES (NEW.scope_id, lower(hex(randomblob(16))))
  ON CONFLICT(scope_id) DO UPDATE SET revision = excluded.revision;
  INSERT INTO novel_manifest_revisions (scope_id, revision)
  SELECT OLD.scope_id, lower(hex(randomblob(16))) WHERE OLD.scope_id <> NEW.scope_id
  ON CONFLICT(scope_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER novel_library_entries_manifest_delete
AFTER DELETE ON novel_library_entries
BEGIN
  INSERT INTO novel_manifest_revisions (scope_id, revision)
  VALUES (OLD.scope_id, lower(hex(randomblob(16))))
  ON CONFLICT(scope_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER novel_plugins_manifest_insert
AFTER INSERT ON novel_plugins
BEGIN
  INSERT INTO novel_manifest_revisions (scope_id, revision)
  VALUES (NEW.scope_id, lower(hex(randomblob(16))))
  ON CONFLICT(scope_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER novel_plugins_manifest_update
AFTER UPDATE ON novel_plugins
BEGIN
  INSERT INTO novel_manifest_revisions (scope_id, revision)
  VALUES (NEW.scope_id, lower(hex(randomblob(16))))
  ON CONFLICT(scope_id) DO UPDATE SET revision = excluded.revision;
  INSERT INTO novel_manifest_revisions (scope_id, revision)
  SELECT OLD.scope_id, lower(hex(randomblob(16))) WHERE OLD.scope_id <> NEW.scope_id
  ON CONFLICT(scope_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER novel_plugins_manifest_delete
AFTER DELETE ON novel_plugins
BEGIN
  INSERT INTO novel_manifest_revisions (scope_id, revision)
  VALUES (OLD.scope_id, lower(hex(randomblob(16))))
  ON CONFLICT(scope_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER novel_repositories_manifest_insert
AFTER INSERT ON novel_repositories
BEGIN
  INSERT INTO novel_manifest_revisions (scope_id, revision)
  VALUES (NEW.scope_id, lower(hex(randomblob(16))))
  ON CONFLICT(scope_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER novel_repositories_manifest_update
AFTER UPDATE ON novel_repositories
BEGIN
  INSERT INTO novel_manifest_revisions (scope_id, revision)
  VALUES (NEW.scope_id, lower(hex(randomblob(16))))
  ON CONFLICT(scope_id) DO UPDATE SET revision = excluded.revision;
  INSERT INTO novel_manifest_revisions (scope_id, revision)
  SELECT OLD.scope_id, lower(hex(randomblob(16))) WHERE OLD.scope_id <> NEW.scope_id
  ON CONFLICT(scope_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER novel_repositories_manifest_delete
AFTER DELETE ON novel_repositories
BEGIN
  INSERT INTO novel_manifest_revisions (scope_id, revision)
  VALUES (OLD.scope_id, lower(hex(randomblob(16))))
  ON CONFLICT(scope_id) DO UPDATE SET revision = excluded.revision;
END;
