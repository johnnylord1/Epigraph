-- Older book progress mutations persisted their entity id (book.progress::<book id>)
-- as the book id itself. Rebuild the table contents with canonical book ids and,
-- when both aliases exist, retain the most recently accepted server record.
CREATE TEMP TABLE book_progress_normalized AS
SELECT
  scope_id,
  normalized_book_id AS book_id,
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
      WHEN book_id LIKE 'book.progress::%'
        THEN substr(book_id, length('book.progress::') + 1)
      ELSE book_id
    END AS normalized_book_id,
    row_number() OVER (
      PARTITION BY
        scope_id,
        CASE
          WHEN book_id LIKE 'book.progress::%'
            THEN substr(book_id, length('book.progress::') + 1)
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
FROM book_progress_normalized;

DROP TABLE book_progress_normalized;
