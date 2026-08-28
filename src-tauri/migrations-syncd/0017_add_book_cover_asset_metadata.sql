ALTER TABLE book_library_entries ADD COLUMN cover_asset_byte_size INTEGER CHECK (
  cover_asset_byte_size IS NULL OR cover_asset_byte_size > 0
);

ALTER TABLE book_library_entries ADD COLUMN cover_asset_mime_type TEXT CHECK (
  cover_asset_mime_type IS NULL OR cover_asset_mime_type IN (
    'image/jpeg',
    'image/png',
    'image/webp'
  )
);

-- Hash-only cover references were never transferable because the old contract did not
-- publish size or MIME metadata. Keep local cover files untouched and stop advertising
-- those incomplete remote references.
UPDATE book_library_entries
SET cover_asset_sha256 = NULL,
    cover_asset_byte_size = NULL,
    cover_asset_mime_type = NULL,
    has_cover = 0
WHERE cover_asset_sha256 IS NOT NULL
  AND (cover_asset_byte_size IS NULL OR cover_asset_mime_type IS NULL);
