ALTER TABLE comic_history ADD COLUMN portable_work_ref_json TEXT
  CHECK (portable_work_ref_json IS NULL OR json_valid(portable_work_ref_json));
ALTER TABLE comic_history ADD COLUMN portable_chapter_ref_json TEXT
  CHECK (portable_chapter_ref_json IS NULL OR json_valid(portable_chapter_ref_json));

ALTER TABLE comic_page_bookmarks ADD COLUMN portable_work_ref_json TEXT
  CHECK (portable_work_ref_json IS NULL OR json_valid(portable_work_ref_json));
ALTER TABLE comic_page_bookmarks ADD COLUMN portable_chapter_ref_json TEXT
  CHECK (portable_chapter_ref_json IS NULL OR json_valid(portable_chapter_ref_json));

CREATE UNIQUE INDEX idx_portable_work_comic_identity
  ON portable_work_bindings(profile_id, source_id, provider_key)
  WHERE ecosystem = 'SUWAYOMI';

CREATE UNIQUE INDEX idx_portable_work_novel_identity
  ON portable_work_bindings(profile_id, plugin_id, provider_key)
  WHERE ecosystem = 'LNREADER';
