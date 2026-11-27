# Sync V4

Sync V4 is the profile-scoped replication protocol and client layer shared between Epigraph Core (`syncd`), the Desktop Tauri shell, and Epigraph Mobile.

## Persistence and Migrations

Sync V4 state is stored in Syncd SQLite via migrations `0031`–`0034`:

- `v4_records`: current replicated state per `(profile_id, domain, entity_type, entity_key)` with Hybrid Logical Clock (`hlc`), `origin_device_id`, `deleted` tombstone flag, and JSON payload.
- `v4_change_log`: ordered sequence (`server_seq`) for paginated catch-up and SSE replay.
- `v4_mutation_receipts`: client mutation idempotency receipts (retained 30 days).
- `v4_profile_watermarks`: per-profile sync watermarks.
- `v4_extension_packages`: LAN cache metadata for uploaded extension packages (64 MiB max per package).

Tombstones are retained for 90 days before compaction.

## Endpoints (`/v4/*`)

All `/v4/*` routes require `require_v4_session`, which validates `X-Epigraph-Client-Version`, `X-Epigraph-Client-Protocol-Version: 4`, and the bearer token. `profile_id` is always derived from `AuthenticatedSession.profile_id` and never trusted from client payloads.

- `GET /v4/capabilities`: protocol and feature capabilities. Includes `supportsPagedSnapshot: true` and `maxSnapshotPageItems: 5000`.
- `GET /v4/snapshot`: authoritative snapshot for cold-start hydration and `410 GONE` recovery.
  - Query: `domain`, `includeTombstones` and the session's grant filter apply as before. Optional `limit` (i64) and `afterSeq` (i64, exclusive cursor) page the snapshot. `limit` is clamped to 1..=5000. Without `limit`, `afterSeq` is ignored and the full snapshot is returned.
  - With `limit`, rows are ordered by `server_seq` ascending with `server_seq > afterSeq`. Paging is applied in SQL before grant filtering, so a page can hold fewer records than `limit` while `hasMore` is still true.
  - Every response carries `hasMore` (bool) and `nextAfterSeq` (i64, the last scanned row's `server_seq`, or `afterSeq` when the page is empty). The full snapshot sends `hasMore: false`. Clients loop on `nextAfterSeq` until `hasMore` is false.
  - `serverSeq` and `minReplayableSeq` are the watermark for the current page.
  - `ETag` uses the unchanged formula. `If-None-Match` returns `304` only on a first page (`afterSeq` absent or `0`); later pages always return the body.
- `GET /v4/changes?sinceSeq=...`: paginated change feed (default 1,000, max 2,000 records per page).
- `GET /v4/events?sinceSeq=...`: persistent SSE stream for realtime updates.
- `POST /v4/deltas`: incremental delta push (max 500 items per request).
- `POST /v4/sync/bulk`: bulk initial sync (max 50,000 items per request).
- Extension package upload/download and tracker credential endpoints (tracker credentials live in per-profile DPAPI-sealed vaults and never enter snapshots, change logs, backups, or logs).
- Book/cover binary asset transfers continue to use `/v1/assets/:sha256` (`HEAD`/`GET`/`PUT`) scoped by `scopeId`.
- The legacy record sync routes (`POST /v1/mutations`, `GET /v1/changes`, `GET /v1/snapshot`) and the Portable Sync V3 manifests are removed; Desktop and Android replicate records only through `/v4/*`. Pairing, discovery, capabilities, the Suwayomi proxy and `/v1/assets` stay on `/v1`.

## Domains and Conflict Resolution

- **Allowed domains**: `comics`, `novels`, `books`, `extensions`, `preferences`.
- **HLC conflict resolution**: incoming mutations carry an `Hlc` timestamp and are merged deterministically against stored record state (`FIELD_CLOCKS`, `CHAPTER_CLOCKS`, `BOOK_POSITION_CLOCK`).
- **Desktop client (`src-tauri/src/v4_desktop_sync.rs`)**:
  - **Novels & Books**: connects each hosted profile to `/v4/*`, performs startup catch-up, subscribes to `GET /v4/events` SSE to apply remote deltas directly into `library_sqlite`, uploads book files and covers to `/v1/assets/:sha256`, and pushes local Desktop UI saves (including delete tombstones) via `POST /v4/deltas`.
  - **Extensions & Preferences**: syncs desktop novel repositories, plugins, and settings over Sync V4.
  - **Comics**: projected through the Suwayomi integration; local Desktop edits—including comic category creation, reordering, assignment changes, and deletions (`catalog: true` on `/v1/local/progress-mirror`)—are captured into Sync V4 records.
    - Desktop category edits are captured right away, even while remote comic changes are still being projected into Suwayomi. Under the V4 write lock the capture reads Desktop categories, confirms the projection did not advance during the read, and leaves out only the keys (and assignment removals for works) that still have a remote change waiting to be projected, so a phone edit that has not reached Suwayomi yet is never overwritten. Anything left out stays owed: the projection loop captures it again as soon as Suwayomi shows every stored comic record (every 2 s, backing off 10 s after a Suwayomi error). Chapter progress written to Suwayomi is clamped to the chapter's known page range (page 0 when the page count is unknown).
    - Desktop library baseline: once per profile per Core process, after its projection settles, Core publishes Desktop library works that Sync V4 has never recorded (including Default-only and Completed-only works, with their titles), real categories and memberships, and chapter progress (read, bookmarked, partly read) as records. It only fills gaps: works, categories, and chapters already in Sync V4, live or tombstoned, are never re-emitted, chapter progress only moves forward, and Default and Completed are never shared as categories. A second run commits nothing. If Suwayomi is unavailable or projection is still settling, it retries on later ticks.

## Compatibility Boundaries

- Clients must send `X-Epigraph-Client-Protocol-Version: 4`; mismatched protocol versions receive an upgrade-required error.
- Schema changes within protocol v4 must remain additive (ignore unknown fields; never rename or remove existing fields).
