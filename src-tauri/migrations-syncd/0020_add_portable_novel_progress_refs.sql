ALTER TABLE novel_progress ADD COLUMN portable_work_ref_json TEXT
  CHECK (portable_work_ref_json IS NULL OR json_valid(portable_work_ref_json));

ALTER TABLE novel_progress ADD COLUMN portable_chapter_ref_json TEXT
  CHECK (portable_chapter_ref_json IS NULL OR json_valid(portable_chapter_ref_json));

UPDATE novel_progress
SET portable_work_ref_json = NULL,
    portable_chapter_ref_json = NULL;
