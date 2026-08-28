-- Early desktop builds used epub-<sha256>/pdf-<sha256> as their local ids.
-- Normalize those identities to the cross-device content-addressed contract.
CREATE TEMP TABLE book_progress_canonical_hashes AS
SELECT
  scope_id,
  canonical_book_id AS book_id,
  renderer,
  location,
  href,
  progress_percent,
  last_read_at_ms,
  page_index,
  total_pages,
  section_label,
  record_updated_at_ms,
  record_updated_by_device_id,
  record_lamport,
  record_server_version
FROM (
  SELECT
    *,
    CASE
      WHEN length(book_id) = 69
        AND substr(book_id, 1, 5) = 'epub-'
        AND substr(book_id, 6) NOT GLOB '*[^0-9A-Fa-f]*'
        THEN 'epub:sha256:' || lower(substr(book_id, 6))
      WHEN length(book_id) = 68
        AND substr(book_id, 1, 4) = 'pdf-'
        AND substr(book_id, 5) NOT GLOB '*[^0-9A-Fa-f]*'
        THEN 'pdf:sha256:' || lower(substr(book_id, 5))
      ELSE book_id
    END AS canonical_book_id,
    row_number() OVER (
      PARTITION BY
        scope_id,
        CASE
          WHEN length(book_id) = 69
            AND substr(book_id, 1, 5) = 'epub-'
            AND substr(book_id, 6) NOT GLOB '*[^0-9A-Fa-f]*'
            THEN 'epub:sha256:' || lower(substr(book_id, 6))
          WHEN length(book_id) = 68
            AND substr(book_id, 1, 4) = 'pdf-'
            AND substr(book_id, 5) NOT GLOB '*[^0-9A-Fa-f]*'
            THEN 'pdf:sha256:' || lower(substr(book_id, 5))
          ELSE book_id
        END
      ORDER BY record_server_version DESC, record_lamport DESC, record_updated_at_ms DESC
    ) AS winner_rank
  FROM book_progress
)
WHERE winner_rank = 1;

DELETE FROM book_progress;

INSERT INTO book_progress (
  scope_id,
  book_id,
  renderer,
  location,
  href,
  progress_percent,
  last_read_at_ms,
  page_index,
  total_pages,
  section_label,
  record_updated_at_ms,
  record_updated_by_device_id,
  record_lamport,
  record_server_version
)
SELECT
  scope_id,
  book_id,
  renderer,
  location,
  href,
  progress_percent,
  last_read_at_ms,
  page_index,
  total_pages,
  section_label,
  record_updated_at_ms,
  record_updated_by_device_id,
  record_lamport,
  record_server_version
FROM book_progress_canonical_hashes;

DROP TABLE book_progress_canonical_hashes;
