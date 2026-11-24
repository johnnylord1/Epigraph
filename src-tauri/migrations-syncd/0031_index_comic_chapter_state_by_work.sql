-- Source refreshes look up one comic's stored chapter state while holding the sync write gate.
-- Keep that lookup proportional to the comic's chapters, even during a large first sync.
CREATE INDEX idx_comic_chapter_state_by_work ON comic_sync_state (
  scope_id,
  json_extract(record_json, '$.portableChapterRef.work.sourceId'),
  json_extract(record_json, '$.portableChapterRef.work.mangaKey')
) WHERE entity_type = 'comic.chapter_state';
