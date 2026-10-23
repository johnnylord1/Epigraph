use std::cmp::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::ConnectOptions;
use sqlx::FromRow;
use uuid::Uuid;

use super::config::SyncdConfig;
use super::models::{
    canonical_novel_identity_key, canonical_novel_identity_key_from_source,
    canonical_novel_plugin_id, canonical_novel_repository_id, canonical_portable_chapter_id,
    canonical_portable_work_id, AuthenticatedSession, BookBookmarkPatch, BookBookmarkRecord,
    BookBookmarkRow, BookCategoryAssignmentPatch, BookCategoryAssignmentRecord,
    BookCategoryAssignmentRow, BookCategoryPatch, BookCategoryRecord, BookCategoryRow,
    BookEntryPatch, BookEntryRecord, BookEntryRow, BookHighlightPatch, BookHighlightRecord,
    BookHighlightRow, BookHistoryPatch, BookHistoryRecord, BookHistoryRow, BookLibraryUiPatch,
    BookLibraryUiRecord, BookLibraryUiRow, BookProgressPatch, BookProgressRecord, BookProgressRow,
    ChangeEnvelope, ChangeLogRow, ComicHistoryPatch, ComicHistoryRecord, ComicHistoryRow,
    ComicPageBookmarkPatch, ComicPageBookmarkRecord, ComicPageBookmarkRow, EventClock,
    MutationOperation, MutationReceiptContext, MutationResult, MutationResultStatus,
    NovelBookmarkPatch, NovelBookmarkRecord, NovelBookmarkRow, NovelCategoryAssignmentPatch,
    NovelCategoryAssignmentRecord, NovelCategoryAssignmentRow, NovelCategoryPatch,
    NovelCategoryRecord, NovelCategoryRow, NovelChapterAssetPatch, NovelChapterAssetRecord,
    NovelChapterAssetRow, NovelChapterPatch, NovelChapterRecord, NovelChapterRow,
    NovelClassificationPatch, NovelClassificationRecord, NovelClassificationRow, NovelEntryPatch,
    NovelEntryRecord, NovelEntryRow, NovelHistoryPatch, NovelHistoryRecord, NovelHistoryRow,
    NovelPluginPatch, NovelPluginRecord, NovelPluginRow, NovelProgressPatch, NovelProgressRecord,
    NovelProgressRow, NovelRepositoryPatch, NovelRepositoryRecord, NovelRepositoryRow,
    PairingGrantVia, PairingPlatform, PortableChapterBindingRow, PortableChapterRefV3,
    PortableResolutionReasonV3, PortableResolutionStateV3, PortableWorkBindingRow,
    PortableWorkRefV3, ServerRuntimeRow, SnapshotEntity, SnapshotResponse, SnapshotTombstone,
    SyncdPairedDeviceView, SNAPSHOT_SCHEMA_VERSION,
};

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStateRow {
    pub token_id: String,
    pub device_id: String,
    pub profile_id: String,
    pub last_seen_at_ms: i64,
    pub inactivity_expires_at_ms: i64,
    pub revoked_at_ms: Option<i64>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingSessionRow {
    pub session_id: String,
    pub profile_id: String,
    pub pairing_code: String,
    pub tls_cert_sha256: String,
    pub status: String,
    pub claimed_device_id: Option<String>,
    pub claimed_device_name: Option<String>,
    pub claimed_platform: Option<String>,
    pub expires_at_ms: i64,
    pub claimed_at_ms: Option<i64>,
    pub approved_at_ms: Option<i64>,
    pub rejected_at_ms: Option<i64>,
    pub created_at_ms: i64,
    pub requested_scopes_json: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
struct PairedDeviceCatalogRow {
    device_id: String,
    device_name: String,
    platform: String,
    profile_id: String,
    last_seen_at_ms: Option<i64>,
    inactivity_expires_at_ms: i64,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerIdentityRow {
    pub server_id: String,
    pub server_protocol_version: i64,
    pub min_client_version: String,
    pub tls_cert_sha256: String,
    pub mdns_service_name: String,
}

#[derive(Debug, Clone)]
pub struct IssuedPairingToken {
    pub access_token: String,
    pub token_id: String,
    pub profile_id: String,
    pub scopes: Vec<String>,
    pub inactivity_expires_at_ms: i64,
    pub granted_via: PairingGrantVia,
}

#[derive(Debug, Clone)]
pub enum PairingClaimOutcome {
    PendingApproval {
        session: PairingSessionRow,
        just_claimed: bool,
    },
    Approved {
        session: PairingSessionRow,
        token: IssuedPairingToken,
    },
    Rejected(PairingSessionRow),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingClaimError {
    NotFound,
    InvalidCode,
    Expired,
    ClaimedByOtherDevice,
    RejectedForDifferentDevice,
    ApprovedForDifferentDevice,
    InvalidRequestedScopes(String),
    RequestedScopesMismatch,
    InvalidStatus(String),
    Storage(String),
}

#[derive(Debug, Clone)]
pub struct MutationWriteOutcome {
    pub envelope: ChangeEnvelope,
    pub record: Value,
    pub applied_lamport: i64,
}

#[derive(Debug, Clone)]
pub enum CausalMutationWriteOutcome {
    Applied(MutationWriteOutcome),
    Superseded {
        record: Value,
        winning_clock: EventClock,
        server_version: i64,
        applied_lamport: i64,
    },
}

#[derive(Debug, Clone, FromRow)]
struct EntityEventClockRow {
    physical_ms: i64,
    logical: i64,
    device_generation_id: String,
    authenticated_device_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MutationReceiptLookup {
    Missing,
    Match(MutationResult),
    Conflict { existing_hash: String },
}

#[derive(Debug, Clone, FromRow)]
struct MutationReceiptRow {
    mutation_hash: String,
    mutation_json: String,
    result_json: String,
}

#[derive(Debug, Clone, FromRow)]
struct ComicSyncStateRow {
    entity_type: String,
    entity_id: String,
    record_json: String,
    record_lamport: i64,
    record_server_version: i64,
}

pub async fn lookup_mutation_receipt(
    pool: &sqlx::SqlitePool,
    device_id: &str,
    client_mutation_id: &str,
    mutation_hash: &str,
    mutation_json: &str,
) -> anyhow::Result<MutationReceiptLookup> {
    let row = sqlx::query_as::<_, MutationReceiptRow>(
        r#"
        SELECT mutation_hash, mutation_json, result_json
        FROM mutation_receipts
        WHERE device_id = ? AND client_mutation_id = ?
        "#,
    )
    .bind(device_id)
    .bind(client_mutation_id)
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Ok(MutationReceiptLookup::Missing);
    };
    if row.mutation_hash != mutation_hash
        && !mutation_receipts_are_semantically_equivalent(&row.mutation_json, mutation_json)?
    {
        return Ok(MutationReceiptLookup::Conflict {
            existing_hash: row.mutation_hash,
        });
    }

    let result = serde_json::from_str(&row.result_json)
        .context("stored mutation receipt contains an invalid result")?;
    Ok(MutationReceiptLookup::Match(result))
}

fn mutation_receipts_are_semantically_equivalent(
    stored_json: &str,
    incoming_json: &str,
) -> anyhow::Result<bool> {
    let mut stored: serde_json::Value = serde_json::from_str(stored_json)
        .context("stored mutation receipt contains invalid mutation JSON")?;
    let mut incoming: serde_json::Value = serde_json::from_str(incoming_json)
        .context("incoming mutation receipt contains invalid mutation JSON")?;

    let stored_has_event_clock = stored.get("eventClock").is_some();
    let incoming_has_event_clock = incoming.get("eventClock").is_some();
    for value in [&mut stored, &mut incoming] {
        if let Some(object) = value.as_object_mut() {
            object.remove("lamport");
            if !stored_has_event_clock || !incoming_has_event_clock {
                object.remove("eventClock");
            }
        }
    }

    Ok(stored == incoming)
}

pub async fn persist_rejected_mutation_receipt(
    pool: &sqlx::SqlitePool,
    context: &MutationReceiptContext,
    result: &MutationResult,
) -> anyhow::Result<MutationReceiptLookup> {
    let result_json = serde_json::to_string(result)?;
    sqlx::query(
        r#"
        INSERT OR IGNORE INTO mutation_receipts (
            device_id,
            client_mutation_id,
            mutation_hash,
            mutation_json,
            result_json,
            applied_server_version,
            created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&context.device_id)
    .bind(&context.client_mutation_id)
    .bind(&context.mutation_hash)
    .bind(&context.mutation_json)
    .bind(result_json)
    .bind(result.applied_server_version)
    .bind(now_ms())
    .execute(pool)
    .await?;

    lookup_mutation_receipt(
        pool,
        &context.device_id,
        &context.client_mutation_id,
        &context.mutation_hash,
        &context.mutation_json,
    )
    .await
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
struct TombstoneRow {
    pub scope_id: String,
    pub profile_id: Option<String>,
    pub entity_type: String,
    pub entity_id: String,
    pub deleted_by_device_id: String,
    pub lamport: i64,
    pub deleted_at_ms: i64,
    pub server_version: i64,
    pub retain_until_ms: i64,
    pub reason_code: String,
}

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations-syncd");

/// Starts a transaction that holds the write lock from the start. A deferred transaction that
/// reads first cannot upgrade once another connection has committed: SQLite fails it with
/// "database is locked" without waiting. Taking the lock up front waits through busy_timeout.
pub(crate) async fn begin_write(
    pool: &sqlx::SqlitePool,
) -> sqlx::Result<sqlx::Transaction<'static, sqlx::Sqlite>> {
    pool.begin_with("BEGIN IMMEDIATE").await
}

pub async fn connect(config: &SyncdConfig) -> anyhow::Result<sqlx::SqlitePool> {
    std::fs::create_dir_all(&config.data_dir).with_context(|| {
        format!(
            "failed to create syncd data dir {}",
            config.data_dir.display()
        )
    })?;

    let options = SqliteConnectOptions::new()
        .filename(&config.db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_millis(5_000))
        .synchronous(SqliteSynchronous::Normal)
        .disable_statement_logging();

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .after_connect(|connection, _meta| {
            Box::pin(async move {
                sqlx::query("PRAGMA foreign_keys = ON;")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("PRAGMA busy_timeout = 5000;")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("PRAGMA synchronous = NORMAL;")
                    .execute(&mut *connection)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .context("failed to connect to syncd sqlite database")?;

    reconcile_line_ending_checksums(&pool)
        .await
        .context("failed to reconcile syncd migration checksums")?;
    MIGRATOR
        .run(&pool)
        .await
        .context("failed to run syncd migrations")?;
    preserve_change_log_sequence(&pool)
        .await
        .context("failed to preserve the change log sequence")?;
    Ok(pool)
}

/// `server_version` is the `change_log` AUTOINCREMENT key. Migrations that add an entity type rebuild
/// `change_log` (its CHECK lists the types), and a rebuilt table restarts its sequence at the highest
/// copied row: after a fully pruned log that is 1, below every cursor clients hold, so they would drop
/// every new change as already seen. The sequence must never fall below the version already published.
pub(crate) async fn preserve_change_log_sequence(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    let mut tx = begin_write(pool).await?;
    let published: Option<i64> = sqlx::query_scalar(
        "SELECT current_server_version FROM server_runtime WHERE singleton_id = 1",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(published) = published.filter(|version| *version > 0) else {
        tx.commit().await?;
        return Ok(());
    };
    let max_row: Option<i64> = sqlx::query_scalar("SELECT MAX(server_version) FROM change_log")
        .fetch_one(&mut *tx)
        .await?;
    let floor = published.max(max_row.unwrap_or(0));
    let updated = sqlx::query(
        "UPDATE sqlite_sequence SET seq = ? WHERE name = 'change_log' AND seq < ?",
    )
    .bind(floor)
    .bind(floor)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated == 0 {
        sqlx::query(
            r#"
            INSERT INTO sqlite_sequence (name, seq)
            SELECT 'change_log', ?
            WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'change_log')
            "#,
        )
        .bind(floor)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// The migration checksum hashes the script bytes as they were in the build checkout, so a build from a CRLF
/// checkout (0.0.1) recorded different checksums for the same SQL. Re-record those that differ only by line
/// endings; any other difference is left for the migrator to reject.
async fn reconcile_line_ending_checksums(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    let has_table: Option<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_optional(pool)
    .await?;
    if has_table.is_none() {
        return Ok(());
    }

    let applied: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations")
            .fetch_all(pool)
            .await?;
    for (version, recorded) in applied {
        let Some(migration) = MIGRATOR
            .iter()
            .find(|migration| migration.version == version)
        else {
            continue;
        };
        if recorded.as_slice() == migration.checksum.as_ref() {
            continue;
        }
        let lf = migration.sql.replace("\r\n", "\n");
        let crlf = lf.replace('\n', "\r\n");
        let same_script = [lf, crlf]
            .iter()
            .any(|sql| sha2::Sha384::digest(sql.as_bytes()).as_slice() == recorded.as_slice());
        if same_script {
            sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
                .bind(migration.checksum.as_ref())
                .bind(version)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

pub async fn upsert_server_identity(
    pool: &sqlx::SqlitePool,
    config: &SyncdConfig,
    tls_cert_sha256: &str,
) -> anyhow::Result<()> {
    let existing_server_id: Option<String> =
        sqlx::query_scalar("SELECT server_id FROM server_identity WHERE singleton_id = 1")
            .fetch_optional(pool)
            .await?;
    let server_id = existing_server_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "pending-server-id")
        .unwrap_or_else(|| Uuid::now_v7().to_string());
    let now_ms = now_ms();

    sqlx::query(
        r#"
        INSERT INTO server_identity (
            singleton_id,
            server_id,
            server_protocol_version,
            min_client_version,
            tls_cert_sha256,
            mdns_service_name,
            created_at_ms,
            updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
            server_id = excluded.server_id,
            server_protocol_version = excluded.server_protocol_version,
            min_client_version = excluded.min_client_version,
            tls_cert_sha256 = excluded.tls_cert_sha256,
            mdns_service_name = excluded.mdns_service_name,
            updated_at_ms = excluded.updated_at_ms
        "#,
    )
    .bind(1_i64)
    .bind(server_id)
    .bind(i64::from(config.server_protocol_version))
    .bind(&config.min_client_version)
    .bind(tls_cert_sha256)
    .bind(&config.mdns_service_name)
    .bind(now_ms)
    .bind(now_ms)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn load_server_runtime(pool: &sqlx::SqlitePool) -> anyhow::Result<ServerRuntimeRow> {
    let row = sqlx::query_as::<_, ServerRuntimeRow>(
        r#"
        SELECT current_server_version, min_replayable_server_version
        FROM server_runtime
        WHERE singleton_id = 1
        "#,
    )
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn load_scope_snapshot(
    pool: &sqlx::SqlitePool,
    scope_id: &str,
) -> anyhow::Result<SnapshotResponse> {
    let mut tx = pool.begin().await?;
    let runtime = sqlx::query_as::<_, ServerRuntimeRow>(
        r#"
        SELECT current_server_version, min_replayable_server_version
        FROM server_runtime
        WHERE singleton_id = 1
        "#,
    )
    .fetch_one(&mut *tx)
    .await?;

    let mut entities = Vec::new();
    if scope_id == "books:global" {
        let rows = sqlx::query_as::<_, BookEntryRow>(
            "SELECT * FROM book_library_entries WHERE scope_id = ? ORDER BY book_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.book_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "book.entry",
                entity_id,
                server_version,
                lamport,
                BookEntryRecord::try_from(row)?,
            )?;
        }

        let rows = sqlx::query_as::<_, BookCategoryRow>(
            "SELECT * FROM book_categories WHERE scope_id = ? ORDER BY category_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.category_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "book.category",
                entity_id,
                server_version,
                lamport,
                BookCategoryRecord::from(row),
            )?;
        }

        let rows = sqlx::query_as::<_, BookCategoryAssignmentRow>(
            "SELECT * FROM book_category_assignments WHERE scope_id = ? ORDER BY book_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.book_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "book.category_assignment",
                entity_id,
                server_version,
                lamport,
                BookCategoryAssignmentRecord::try_from(row)?,
            )?;
        }

        let rows = sqlx::query_as::<_, BookLibraryUiRow>(
            "SELECT * FROM book_library_ui_state WHERE scope_id = ? ORDER BY ui_state_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.ui_state_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "book.library_ui",
                entity_id,
                server_version,
                lamport,
                BookLibraryUiRecord::from(row),
            )?;
        }

        let rows = sqlx::query_as::<_, BookProgressRow>(
            "SELECT * FROM book_progress WHERE scope_id = ? ORDER BY book_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.book_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "book.progress",
                entity_id,
                server_version,
                lamport,
                BookProgressRecord::from(row),
            )?;
        }

        let rows = sqlx::query_as::<_, BookBookmarkRow>(
            "SELECT * FROM book_bookmarks WHERE scope_id = ? ORDER BY bookmark_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.bookmark_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "book.bookmark",
                entity_id,
                server_version,
                lamport,
                BookBookmarkRecord::from(row),
            )?;
        }

        let rows = sqlx::query_as::<_, BookHighlightRow>(
            "SELECT * FROM book_highlights WHERE scope_id = ? ORDER BY highlight_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.highlight_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "book.highlight",
                entity_id,
                server_version,
                lamport,
                BookHighlightRecord::try_from(row)?,
            )?;
        }

        let rows = sqlx::query_as::<_, BookHistoryRow>(
            "SELECT * FROM book_history WHERE scope_id = ? ORDER BY history_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.history_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "book.history",
                entity_id,
                server_version,
                lamport,
                BookHistoryRecord::from(row),
            )?;
        }
    } else if scope_id.starts_with("novels:profile:") {
        let rows = sqlx::query_as::<_, NovelEntryRow>(
            "SELECT * FROM novel_library_entries WHERE scope_id = ? ORDER BY novel_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.novel_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "novel.entry",
                entity_id,
                server_version,
                lamport,
                NovelEntryRecord::try_from(row)?,
            )?;
        }

        let rows = sqlx::query_as::<_, NovelChapterRow>(
            "SELECT * FROM novel_chapters WHERE scope_id = ? ORDER BY chapter_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.chapter_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "novel.chapter",
                entity_id,
                server_version,
                lamport,
                NovelChapterRecord::from(row),
            )?;
        }

        let rows = sqlx::query_as::<_, NovelChapterAssetRow>(
            "SELECT * FROM novel_chapter_assets WHERE scope_id = ? ORDER BY chapter_asset_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.chapter_asset_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "novel.chapter_asset",
                entity_id,
                server_version,
                lamport,
                NovelChapterAssetRecord::from(row),
            )?;
        }

        let rows = sqlx::query_as::<_, NovelProgressRow>(
            "SELECT * FROM novel_progress WHERE scope_id = ? ORDER BY novel_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.novel_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            // Progress rows use the mutation entity key (`novel.progress::<novel_id>`) as
            // their primary key internally, while the public record is keyed by the novel
            // itself.  Snapshot consumers must receive the same canonical id as replay/change
            // events; leaking the storage prefix makes a fresh mobile replica unable to join the
            // progress record to its novel entry.
            let mut record = NovelProgressRecord::from(row);
            record.novel_id = record
                .novel_id
                .strip_prefix("novel.progress::")
                .unwrap_or(&record.novel_id)
                .to_string();
            push_snapshot_entity(
                &mut entities,
                "novel.progress",
                entity_id,
                server_version,
                lamport,
                record,
            )?;
        }

        let rows = sqlx::query_as::<_, NovelBookmarkRow>(
            "SELECT * FROM novel_bookmarks WHERE scope_id = ? ORDER BY bookmark_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.bookmark_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "novel.bookmark",
                entity_id,
                server_version,
                lamport,
                NovelBookmarkRecord::from(row),
            )?;
        }

        let rows = sqlx::query_as::<_, NovelHistoryRow>(
            "SELECT * FROM novel_history WHERE scope_id = ? ORDER BY history_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.history_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "novel.history",
                entity_id,
                server_version,
                lamport,
                NovelHistoryRecord::from(row),
            )?;
        }

        let rows = sqlx::query_as::<_, NovelClassificationRow>(
            "SELECT * FROM novel_source_classification_records WHERE scope_id = ? ORDER BY plugin_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.plugin_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "novel.classification",
                entity_id,
                server_version,
                lamport,
                NovelClassificationRecord::try_from(row)?,
            )?;
        }

        let rows = sqlx::query_as::<_, NovelRepositoryRow>(
            "SELECT * FROM novel_repositories WHERE scope_id = ? ORDER BY repository_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.repository_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "novel.repository",
                entity_id,
                server_version,
                lamport,
                NovelRepositoryRecord::from(row),
            )?;
        }

        let rows = sqlx::query_as::<_, NovelPluginRow>(
            "SELECT * FROM novel_plugins WHERE scope_id = ? ORDER BY plugin_entity_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.plugin_entity_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "novel.plugin",
                entity_id,
                server_version,
                lamport,
                NovelPluginRecord::try_from(row)?,
            )?;
        }

        let rows = sqlx::query_as::<_, NovelCategoryRow>(
            "SELECT * FROM novel_categories WHERE scope_id = ? ORDER BY category_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.category_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "novel.category",
                entity_id,
                server_version,
                lamport,
                NovelCategoryRecord::from(row),
            )?;
        }

        let rows = sqlx::query_as::<_, NovelCategoryAssignmentRow>(
            "SELECT * FROM novel_category_assignments WHERE scope_id = ? ORDER BY assignment_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.assignment_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "novel.category_assignment",
                entity_id,
                server_version,
                lamport,
                NovelCategoryAssignmentRecord::from(row),
            )?;
        }
        push_tracking_snapshot_entities_in_tx(&mut tx, &mut entities, scope_id, "novel.tracking")
            .await?;
    } else if scope_id.starts_with("comics:profile:") {
        let rows = sqlx::query_as::<_, ComicSyncStateRow>(
            r#"
            SELECT entity_type, entity_id, record_json, record_lamport, record_server_version
            FROM comic_sync_state
            WHERE scope_id = ?
            ORDER BY entity_type, entity_id
            "#,
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            entities.push(SnapshotEntity {
                entity_type: row.entity_type,
                entity_id: row.entity_id,
                server_version: row.record_server_version,
                lamport: row.record_lamport,
                record: serde_json::from_str(&row.record_json)?,
            });
        }

        let rows = sqlx::query_as::<_, ComicHistoryRow>(
            "SELECT * FROM comic_history WHERE scope_id = ? ORDER BY history_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.history_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "comic.history",
                entity_id,
                server_version,
                lamport,
                ComicHistoryRecord::from(row),
            )?;
        }

        let rows = sqlx::query_as::<_, ComicPageBookmarkRow>(
            "SELECT * FROM comic_page_bookmarks WHERE scope_id = ? ORDER BY bookmark_id",
        )
        .bind(scope_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let entity_id = row.bookmark_id.clone();
            let server_version = row.record_server_version;
            let lamport = row.record_lamport;
            push_snapshot_entity(
                &mut entities,
                "comic.page_bookmark",
                entity_id,
                server_version,
                lamport,
                ComicPageBookmarkRecord::from(row),
            )?;
        }
        push_tracking_snapshot_entities_in_tx(&mut tx, &mut entities, scope_id, "comic.tracking")
            .await?;
    } else {
        bail!("unsupported snapshot scope: {scope_id}");
    }

    let tombstones = sqlx::query_as::<_, SnapshotTombstone>(
        r#"
        SELECT entity_type, entity_id, server_version, lamport, deleted_at_ms, reason_code
        FROM tombstones
        WHERE scope_id = ?
        ORDER BY server_version, entity_type, entity_id
        "#,
    )
    .bind(scope_id)
    .fetch_all(&mut *tx)
    .await?;

    tx.commit().await?;
    let entity_count = entities.len();
    let tombstone_count = tombstones.len();
    let snapshot_identity = serde_json::to_vec(&(
        scope_id,
        runtime.current_server_version,
        runtime.min_replayable_server_version,
        &entities,
        &tombstones,
    ))?;
    Ok(SnapshotResponse {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        snapshot_id: Some(format!("{:x}", Sha256::digest(snapshot_identity))),
        complete: Some(true),
        entity_count: Some(entity_count),
        tombstone_count: Some(tombstone_count),
        scope_id: scope_id.to_string(),
        snapshot_version: runtime.current_server_version,
        min_replayable_server_version: runtime.min_replayable_server_version,
        entities,
        tombstones,
    })
}

fn push_snapshot_entity<T: Serialize>(
    entities: &mut Vec<SnapshotEntity>,
    entity_type: &str,
    entity_id: String,
    server_version: i64,
    lamport: i64,
    record: T,
) -> anyhow::Result<()> {
    entities.push(SnapshotEntity {
        entity_type: entity_type.to_string(),
        entity_id,
        server_version,
        lamport,
        record: serde_json::to_value(record)?,
    });
    Ok(())
}

pub async fn load_server_identity(pool: &sqlx::SqlitePool) -> anyhow::Result<ServerIdentityRow> {
    let row = sqlx::query_as::<_, ServerIdentityRow>(
        r#"
        SELECT
            server_id,
            server_protocol_version,
            min_client_version,
            tls_cert_sha256,
            mdns_service_name
        FROM server_identity
        WHERE singleton_id = 1
        "#,
    )
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub fn allowed_pairing_scopes(profile_id: &str) -> Vec<String> {
    vec![
        "books:global".to_string(),
        format!("novels:profile:{profile_id}"),
        format!("comics:profile:{profile_id}"),
    ]
}

pub fn canonicalize_pairing_scopes(
    profile_id: &str,
    scopes: &[String],
    require_non_empty: bool,
) -> Result<Vec<String>, String> {
    if require_non_empty && scopes.is_empty() {
        return Err("At least one pairing scope must be requested.".to_string());
    }

    let allowed = allowed_pairing_scopes(profile_id);
    let mut canonical = Vec::with_capacity(scopes.len());
    for scope in scopes {
        let scope = scope.trim();
        if !allowed.iter().any(|candidate| candidate == scope) {
            return Err(format!(
                "Pairing scope '{scope}' is not allowed for profile '{profile_id}'."
            ));
        }
        if !canonical.iter().any(|candidate| candidate == scope) {
            canonical.push(scope.to_string());
        }
    }
    canonical.sort();
    Ok(canonical)
}

pub fn pairing_session_requested_scopes(
    session: &PairingSessionRow,
) -> anyhow::Result<Vec<String>> {
    let Some(raw) = session.requested_scopes_json.as_deref() else {
        return Ok(allowed_pairing_scopes(&session.profile_id));
    };
    let scopes = serde_json::from_str::<Vec<String>>(raw)
        .context("pairing session requested scopes are invalid")?;
    canonicalize_pairing_scopes(&session.profile_id, &scopes, true).map_err(anyhow::Error::msg)
}

pub async fn create_pairing_session(
    pool: &sqlx::SqlitePool,
    session_id: &str,
    profile_id: &str,
    pairing_code: &str,
    tls_cert_sha256: &str,
    expires_at_ms: i64,
) -> anyhow::Result<PairingSessionRow> {
    let now_ms = now_ms();
    sqlx::query(
        r#"
        INSERT INTO pairing_sessions (
            session_id,
            profile_id,
            pairing_code,
            tls_cert_sha256,
            status,
            claimed_device_id,
            claimed_device_name,
            claimed_platform,
            expires_at_ms,
            claimed_at_ms,
            approved_at_ms,
            rejected_at_ms,
            created_at_ms,
            requested_scopes_json
        ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, NULL)
        "#,
    )
    .bind(session_id)
    .bind(profile_id)
    .bind(pairing_code)
    .bind(tls_cert_sha256)
    .bind(expires_at_ms)
    .bind(now_ms)
    .execute(pool)
    .await?;

    load_pairing_session(pool, session_id)
        .await?
        .context("created pairing session could not be reloaded")
}

pub async fn create_bootstrap_pairing_session(
    pool: &sqlx::SqlitePool,
    tls_cert_sha256: &str,
    profile_id: &str,
    expires_at_ms: i64,
) -> anyhow::Result<PairingSessionRow> {
    let session_id = format!("bootstrap-{}", Uuid::now_v7());
    let pairing_code = Uuid::now_v7()
        .simple()
        .to_string()
        .chars()
        .take(12)
        .collect::<String>()
        .to_uppercase();

    create_pairing_session(
        pool,
        &session_id,
        profile_id,
        &pairing_code,
        tls_cert_sha256,
        expires_at_ms,
    )
    .await
}

pub async fn load_pairing_session(
    pool: &sqlx::SqlitePool,
    session_id: &str,
) -> anyhow::Result<Option<PairingSessionRow>> {
    let row = sqlx::query_as::<_, PairingSessionRow>(
        r#"
        SELECT
            session_id,
            profile_id,
            pairing_code,
            tls_cert_sha256,
            status,
            claimed_device_id,
            claimed_device_name,
            claimed_platform,
            expires_at_ms,
            claimed_at_ms,
            approved_at_ms,
            rejected_at_ms,
            created_at_ms,
            requested_scopes_json
        FROM pairing_sessions
        WHERE session_id = ?
        "#,
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn approve_pairing_session(
    pool: &sqlx::SqlitePool,
    session_id: &str,
) -> anyhow::Result<Option<PairingSessionRow>> {
    let mut tx = begin_write(pool).await?;
    let now_ms = now_ms();
    let session = load_pairing_session_in_tx(&mut tx, session_id).await?;
    let Some(session) = session else {
        tx.commit().await?;
        return Ok(None);
    };

    if session.expires_at_ms < now_ms {
        mark_pairing_session_expired_in_tx(&mut tx, session_id, now_ms).await?;
        tx.commit().await?;
        return load_pairing_session(pool, session_id).await;
    }

    if session.claimed_device_id.is_none() {
        bail!("pairing session cannot be approved before it is claimed");
    }

    sqlx::query(
        r#"
        UPDATE pairing_sessions
        SET status = 'approved',
            approved_at_ms = ?,
            rejected_at_ms = NULL
        WHERE session_id = ?
        "#,
    )
    .bind(now_ms)
    .bind(session_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    load_pairing_session(pool, session_id).await
}

pub async fn expire_pairing_session_if_needed(
    pool: &sqlx::SqlitePool,
    session_id: &str,
    now_ms: i64,
) -> anyhow::Result<Option<PairingSessionRow>> {
    let mut tx = begin_write(pool).await?;
    let session = load_pairing_session_in_tx(&mut tx, session_id).await?;
    let Some(session) = session else {
        tx.commit().await?;
        return Ok(None);
    };

    if session.status != "expired" && session.expires_at_ms <= now_ms {
        mark_pairing_session_expired_in_tx(&mut tx, session_id, now_ms).await?;
    }

    let updated = load_pairing_session_in_tx(&mut tx, session_id).await?;
    tx.commit().await?;
    Ok(updated)
}

pub async fn reject_pairing_session(
    pool: &sqlx::SqlitePool,
    session_id: &str,
) -> anyhow::Result<Option<PairingSessionRow>> {
    let mut tx = begin_write(pool).await?;
    let now_ms = now_ms();
    let session = load_pairing_session_in_tx(&mut tx, session_id).await?;
    let Some(session) = session else {
        tx.commit().await?;
        return Ok(None);
    };

    if session.expires_at_ms < now_ms {
        mark_pairing_session_expired_in_tx(&mut tx, session_id, now_ms).await?;
        tx.commit().await?;
        return load_pairing_session(pool, session_id).await;
    }

    sqlx::query(
        r#"
        UPDATE pairing_sessions
        SET status = 'rejected',
            rejected_at_ms = ?,
            approved_at_ms = NULL
        WHERE session_id = ?
        "#,
    )
    .bind(now_ms)
    .bind(session_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    load_pairing_session(pool, session_id).await
}

pub async fn claim_pairing_session(
    pool: &sqlx::SqlitePool,
    config: &SyncdConfig,
    session_id: &str,
    pairing_code: &str,
    device_id: &str,
    device_name: &str,
    platform: PairingPlatform,
    requested_scopes: Option<&[String]>,
) -> Result<PairingClaimOutcome, PairingClaimError> {
    let mut tx = begin_write(pool).await.map_err(storage_pairing_claim_error)?;
    let now_ms = now_ms();
    let mut session = load_pairing_session_in_tx(&mut tx, session_id)
        .await
        .map_err(storage_pairing_claim_error)?
        .ok_or(PairingClaimError::NotFound)?;

    if session.pairing_code != pairing_code {
        return Err(PairingClaimError::InvalidCode);
    }

    if session.expires_at_ms < now_ms {
        mark_pairing_session_expired_in_tx(&mut tx, session_id, now_ms)
            .await
            .map_err(storage_pairing_claim_error)?;
        tx.commit().await.map_err(storage_pairing_claim_error)?;
        return Err(PairingClaimError::Expired);
    }

    let requested_scopes_were_explicit = requested_scopes.is_some();
    let requested_scopes = match requested_scopes {
        Some(scopes) => canonicalize_pairing_scopes(&session.profile_id, scopes, true)
            .map_err(PairingClaimError::InvalidRequestedScopes)?,
        None => allowed_pairing_scopes(&session.profile_id),
    };
    let persisted_scopes = pairing_session_requested_scopes(&session)
        .map_err(|error| PairingClaimError::Storage(error.to_string()))?;

    match session.status.as_str() {
        "pending" => {
            let requested_scopes_json = if !requested_scopes_were_explicit {
                None
            } else {
                Some(
                    serde_json::to_string(&requested_scopes)
                        .map_err(storage_pairing_claim_error)?,
                )
            };
            sqlx::query(
                r#"
                UPDATE pairing_sessions
                SET status = 'claimed',
                    claimed_device_id = ?,
                    claimed_device_name = ?,
                    claimed_platform = ?,
                    claimed_at_ms = COALESCE(claimed_at_ms, ?),
                    requested_scopes_json = ?
                WHERE session_id = ?
                "#,
            )
            .bind(device_id)
            .bind(device_name)
            .bind(platform.as_str())
            .bind(now_ms)
            .bind(requested_scopes_json)
            .bind(session_id)
            .execute(&mut *tx)
            .await
            .map_err(storage_pairing_claim_error)?;

            session = load_pairing_session_in_tx(&mut tx, session_id)
                .await
                .map_err(storage_pairing_claim_error)?
                .context("claimed pairing session disappeared")
                .map_err(|error| PairingClaimError::Storage(error.to_string()))?;
            tx.commit().await.map_err(storage_pairing_claim_error)?;
            return Ok(PairingClaimOutcome::PendingApproval {
                session,
                just_claimed: true,
            });
        }
        "claimed" => {
            if session.claimed_device_id.as_deref() != Some(device_id) {
                return Err(PairingClaimError::ClaimedByOtherDevice);
            }
            if persisted_scopes != requested_scopes {
                return Err(PairingClaimError::RequestedScopesMismatch);
            }
            tx.commit().await.map_err(storage_pairing_claim_error)?;
            return Ok(PairingClaimOutcome::PendingApproval {
                session,
                just_claimed: false,
            });
        }
        "rejected" => {
            if session.claimed_device_id.as_deref() != Some(device_id) {
                return Err(PairingClaimError::RejectedForDifferentDevice);
            }
            if persisted_scopes != requested_scopes {
                return Err(PairingClaimError::RequestedScopesMismatch);
            }
            tx.commit().await.map_err(storage_pairing_claim_error)?;
            return Ok(PairingClaimOutcome::Rejected(session));
        }
        "approved" => {
            if session.claimed_device_id.as_deref() != Some(device_id) {
                return Err(PairingClaimError::ApprovedForDifferentDevice);
            }
            if persisted_scopes != requested_scopes {
                return Err(PairingClaimError::RequestedScopesMismatch);
            }

            let trusted_before = has_active_trusted_device_in_tx(&mut tx, device_id)
                .await
                .map_err(storage_pairing_claim_error)?;
            let granted_via = if trusted_before {
                PairingGrantVia::TrustedPool
            } else {
                PairingGrantVia::Qr
            };
            let issued = issue_pairing_token_in_tx(
                &mut tx,
                config,
                &session,
                device_id,
                device_name,
                &platform,
                granted_via,
            )
            .await
            .map_err(storage_pairing_claim_error)?;
            tx.commit().await.map_err(storage_pairing_claim_error)?;
            return Ok(PairingClaimOutcome::Approved {
                session,
                token: issued,
            });
        }
        "expired" => {
            tx.commit().await.map_err(storage_pairing_claim_error)?;
            return Err(PairingClaimError::Expired);
        }
        other => {
            return Err(PairingClaimError::InvalidStatus(other.to_string()));
        }
    }
}

fn storage_pairing_claim_error(error: impl std::fmt::Display) -> PairingClaimError {
    PairingClaimError::Storage(error.to_string())
}

async fn load_pairing_session_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    session_id: &str,
) -> anyhow::Result<Option<PairingSessionRow>> {
    let row = sqlx::query_as::<_, PairingSessionRow>(
        r#"
        SELECT
            session_id,
            profile_id,
            pairing_code,
            tls_cert_sha256,
            status,
            claimed_device_id,
            claimed_device_name,
            claimed_platform,
            expires_at_ms,
            claimed_at_ms,
            approved_at_ms,
            rejected_at_ms,
            created_at_ms,
            requested_scopes_json
        FROM pairing_sessions
        WHERE session_id = ?
        "#,
    )
    .bind(session_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row)
}

/// Bootstrap sessions that can still be resolved by PIN: pending (not yet claimed) and not expired.
pub async fn list_open_bootstrap_sessions(
    pool: &sqlx::SqlitePool,
    now_ms: i64,
) -> anyhow::Result<Vec<PairingSessionRow>> {
    let rows = sqlx::query_as::<_, PairingSessionRow>(
        r#"
        SELECT
            session_id,
            profile_id,
            pairing_code,
            tls_cert_sha256,
            status,
            claimed_device_id,
            claimed_device_name,
            claimed_platform,
            expires_at_ms,
            claimed_at_ms,
            approved_at_ms,
            rejected_at_ms,
            created_at_ms,
            requested_scopes_json
        FROM pairing_sessions
        WHERE status = 'pending'
          AND expires_at_ms > ?
          AND session_id LIKE 'bootstrap-%'
        ORDER BY created_at_ms DESC
        "#,
    )
    .bind(now_ms)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Ends every PIN-resolvable session, so the host shows a new PIN after repeated wrong guesses.
pub async fn expire_open_bootstrap_sessions(pool: &sqlx::SqlitePool) -> anyhow::Result<u64> {
    let result = sqlx::query(
        r#"
        UPDATE pairing_sessions
        SET status = 'expired'
        WHERE status = 'pending'
          AND session_id LIKE 'bootstrap-%'
        "#,
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

async fn mark_pairing_session_expired_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    session_id: &str,
    _now_ms: i64,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        UPDATE pairing_sessions
        SET status = 'expired'
        WHERE session_id = ?
          AND status != 'expired'
        "#,
    )
    .bind(session_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn has_active_trusted_device_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
) -> anyhow::Result<bool> {
    let revoked_at_ms: Option<Option<i64>> = sqlx::query_scalar(
        r#"
        SELECT revoked_at_ms
        FROM trusted_devices
        WHERE device_id = ?
        "#,
    )
    .bind(device_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(matches!(revoked_at_ms, Some(None)))
}

async fn issue_pairing_token_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    config: &SyncdConfig,
    session: &PairingSessionRow,
    device_id: &str,
    device_name: &str,
    platform: &PairingPlatform,
    granted_via: PairingGrantVia,
) -> anyhow::Result<IssuedPairingToken> {
    let now_ms = now_ms();
    let inactivity_expires_at_ms = now_ms + config.token_inactivity_window.as_millis() as i64;
    let token_id = format!("pairing-{}", session.session_id);
    // Token prefixes are part of the persisted/protocol surface. Keep the
    // legacy prefix so existing clients and audit tooling remain compatible.
    let access_token = format!("aethon_{}", Uuid::now_v7());
    let token_hash = hash_token(&access_token);
    let trusted_host_id = "syncd-local-host";
    let scopes = pairing_session_requested_scopes(session)?;

    sqlx::query(
        r#"
        INSERT INTO trusted_devices (
            device_id,
            trusted_host_id,
            device_name,
            platform,
            first_trusted_at_ms,
            last_seen_at_ms,
            revoked_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(device_id) DO UPDATE SET
            trusted_host_id = excluded.trusted_host_id,
            device_name = excluded.device_name,
            platform = excluded.platform,
            last_seen_at_ms = excluded.last_seen_at_ms,
            revoked_at_ms = NULL
        "#,
    )
    .bind(device_id)
    .bind(trusted_host_id)
    .bind(device_name)
    .bind(platform.as_str())
    .bind(now_ms)
    .bind(now_ms)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO paired_device_tokens (
            token_id,
            device_id,
            profile_id,
            token_hash,
            issued_at_ms,
            last_seen_at_ms,
            inactivity_expires_at_ms,
            revoked_at_ms,
            granted_via
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(token_id) DO UPDATE SET
            device_id = excluded.device_id,
            profile_id = excluded.profile_id,
            token_hash = excluded.token_hash,
            issued_at_ms = excluded.issued_at_ms,
            last_seen_at_ms = excluded.last_seen_at_ms,
            inactivity_expires_at_ms = excluded.inactivity_expires_at_ms,
            revoked_at_ms = NULL,
            granted_via = excluded.granted_via
        "#,
    )
    .bind(&token_id)
    .bind(device_id)
    .bind(&session.profile_id)
    .bind(token_hash)
    .bind(now_ms)
    .bind(now_ms)
    .bind(inactivity_expires_at_ms)
    .bind(granted_via.as_str())
    .execute(&mut **tx)
    .await?;

    sqlx::query("DELETE FROM paired_device_scopes WHERE token_id = ?")
        .bind(&token_id)
        .execute(&mut **tx)
        .await?;

    for scope in &scopes {
        sqlx::query("INSERT INTO paired_device_scopes (token_id, scope_id) VALUES (?, ?)")
            .bind(&token_id)
            .bind(scope)
            .execute(&mut **tx)
            .await?;
    }

    Ok(IssuedPairingToken {
        access_token,
        token_id,
        profile_id: session.profile_id.clone(),
        scopes,
        inactivity_expires_at_ms,
        granted_via,
    })
}

pub async fn list_paired_devices(
    pool: &sqlx::SqlitePool,
) -> anyhow::Result<Vec<SyncdPairedDeviceView>> {
    let rows = sqlx::query_as::<_, PairedDeviceCatalogRow>(
        r#"
        SELECT
            trusted.device_id,
            trusted.device_name,
            trusted.platform,
            tokens.profile_id,
            MAX(tokens.last_seen_at_ms) AS last_seen_at_ms,
            MAX(tokens.inactivity_expires_at_ms) AS inactivity_expires_at_ms
        FROM trusted_devices AS trusted
        INNER JOIN paired_device_tokens AS tokens
            ON tokens.device_id = trusted.device_id
        WHERE trusted.revoked_at_ms IS NULL
          AND tokens.revoked_at_ms IS NULL
          AND tokens.granted_via != 'local-authority'
        GROUP BY
            trusted.device_id,
            trusted.device_name,
            trusted.platform,
            tokens.profile_id
        ORDER BY trusted.device_name, trusted.device_id, tokens.profile_id
        "#,
    )
    .fetch_all(pool)
    .await?;

    let now_ms = now_ms();
    let mut devices = Vec::with_capacity(rows.len());
    for row in rows {
        let granted_scopes = sqlx::query_scalar::<_, String>(
            r#"
            SELECT DISTINCT scopes.scope_id
            FROM paired_device_scopes AS scopes
            INNER JOIN paired_device_tokens AS tokens
                ON tokens.token_id = scopes.token_id
            WHERE tokens.device_id = ?
              AND tokens.profile_id = ?
              AND tokens.revoked_at_ms IS NULL
              AND tokens.granted_via != 'local-authority'
            ORDER BY scopes.scope_id
            "#,
        )
        .bind(&row.device_id)
        .bind(&row.profile_id)
        .fetch_all(pool)
        .await?;

        let platform = match row.platform.as_str() {
            "android" => PairingPlatform::Android,
            "desktop" => PairingPlatform::Desktop,
            _ => PairingPlatform::Unknown,
        };
        devices.push(SyncdPairedDeviceView {
            device_id: row.device_id,
            device_name: row.device_name,
            platform,
            profile_id: row.profile_id,
            granted_scopes,
            last_seen_at_ms: row.last_seen_at_ms,
            inactive: row.inactivity_expires_at_ms < now_ms,
        });
    }
    Ok(devices)
}

/// Revokes every paired token of a device and its trust, so its next request is rejected and it
/// must pair again. Local authority tokens are not paired devices and stay untouched.
pub async fn revoke_paired_device(pool: &sqlx::SqlitePool, device_id: &str) -> anyhow::Result<bool> {
    let now_ms = now_ms();
    let mut tx = begin_write(pool).await?;
    let revoked = sqlx::query(
        r#"
        UPDATE paired_device_tokens
        SET revoked_at_ms = ?
        WHERE device_id = ?
          AND revoked_at_ms IS NULL
          AND granted_via != 'local-authority'
        "#,
    )
    .bind(now_ms)
    .bind(device_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if revoked > 0 {
        sqlx::query(
            "UPDATE trusted_devices SET revoked_at_ms = ? WHERE device_id = ? AND revoked_at_ms IS NULL",
        )
        .bind(now_ms)
        .bind(device_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(revoked > 0)
}

pub async fn update_paired_device_granted_scopes(
    pool: &sqlx::SqlitePool,
    device_id: &str,
    profile_id: &str,
    scopes: &[String],
) -> anyhow::Result<Option<SyncdPairedDeviceView>> {
    let scopes =
        canonicalize_pairing_scopes(profile_id, scopes, false).map_err(anyhow::Error::msg)?;
    let mut tx = begin_write(pool).await?;
    let token_ids = sqlx::query_scalar::<_, String>(
        r#"
        SELECT token_id
        FROM paired_device_tokens
        WHERE device_id = ?
          AND profile_id = ?
          AND revoked_at_ms IS NULL
          AND granted_via != 'local-authority'
        "#,
    )
    .bind(device_id)
    .bind(profile_id)
    .fetch_all(&mut *tx)
    .await?;

    if token_ids.is_empty() {
        tx.commit().await?;
        return Ok(None);
    }

    for token_id in token_ids {
        sqlx::query("DELETE FROM paired_device_scopes WHERE token_id = ?")
            .bind(&token_id)
            .execute(&mut *tx)
            .await?;
        for scope in &scopes {
            sqlx::query("INSERT INTO paired_device_scopes (token_id, scope_id) VALUES (?, ?)")
                .bind(&token_id)
                .bind(scope)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;

    Ok(list_paired_devices(pool)
        .await?
        .into_iter()
        .find(|device| device.device_id == device_id && device.profile_id == profile_id))
}

pub async fn set_server_runtime_for_audit(
    pool: &sqlx::SqlitePool,
    current_server_version: i64,
    min_replayable_server_version: i64,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        UPDATE server_runtime
        SET current_server_version = ?,
            min_replayable_server_version = ?,
            updated_at_ms = ?
        WHERE singleton_id = 1
        "#,
    )
    .bind(current_server_version)
    .bind(min_replayable_server_version)
    .bind(now_ms())
    .execute(pool)
    .await?;

    Ok(())
}

#[allow(dead_code)]
pub async fn append_change_log_entry(
    pool: &sqlx::SqlitePool,
    scope_id: &str,
    profile_id: Option<&str>,
    entity_type: &str,
    entity_id: &str,
    op: &str,
    lamport: i64,
    changed_by_device_id: &str,
    patch: Option<&Value>,
    retention_window: Duration,
) -> anyhow::Result<ChangeEnvelope> {
    let mut tx = begin_write(pool).await?;
    let applied_at_ms = now_ms();
    let replay_until_ms = applied_at_ms + retention_window.as_millis() as i64;
    let patch_json = patch.map(serde_json::to_string).transpose()?;

    let result = sqlx::query(
        r#"
        INSERT INTO change_log (
            scope_id,
            profile_id,
            entity_type,
            entity_id,
            op,
            lamport,
            changed_by_device_id,
            patch_json,
            replay_until_ms,
            applied_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(scope_id)
    .bind(profile_id)
    .bind(entity_type)
    .bind(entity_id)
    .bind(op)
    .bind(lamport)
    .bind(changed_by_device_id)
    .bind(patch_json.as_deref())
    .bind(replay_until_ms)
    .bind(applied_at_ms)
    .execute(&mut *tx)
    .await?;
    let server_version = result.last_insert_rowid();

    sqlx::query(
        r#"
        UPDATE server_runtime
        SET current_server_version = ?,
            updated_at_ms = ?
        WHERE singleton_id = 1
        "#,
    )
    .bind(server_version)
    .bind(applied_at_ms)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(ChangeEnvelope {
        server_version,
        scope_id: scope_id.to_string(),
        profile_id: profile_id.map(str::to_string),
        entity_type: entity_type.to_string(),
        entity_id: entity_id.to_string(),
        op: op.to_string(),
        lamport,
        patch: patch.cloned(),
        applied_at_ms,
    })
}

pub async fn fetch_replay_changes(
    pool: &sqlx::SqlitePool,
    after_server_version: i64,
    up_to_server_version: i64,
) -> anyhow::Result<Vec<ChangeLogRow>> {
    let rows = sqlx::query_as::<_, ChangeLogRow>(
        r#"
        SELECT
            server_version,
            scope_id,
            profile_id,
            entity_type,
            entity_id,
            op,
            lamport,
            changed_by_device_id,
            patch_json,
            replay_until_ms,
            applied_at_ms
        FROM change_log
        WHERE server_version > ? AND server_version <= ?
        ORDER BY server_version ASC
        "#,
    )
    .bind(after_server_version)
    .bind(up_to_server_version)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Ninety days: three times the default change-log replay window.
pub(crate) const MUTATION_RECEIPT_RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;
pub(crate) const STALE_PAIRED_DEVICE_RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;

pub async fn prune_expired_rows(pool: &sqlx::SqlitePool, now_ms: i64) -> anyhow::Result<()> {
    let mut tx = begin_write(pool).await?;

    sqlx::query("DELETE FROM tombstones WHERE retain_until_ms < ?")
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM change_log WHERE replay_until_ms < ?")
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;
    // Receipts make a retried mutation idempotent. A phone retries within hours or days; after
    // MUTATION_RECEIPT_RETENTION_MS a resend is decided again by the entity's event clock, which
    // supersedes stale writes on its own. Without this bound the table grows with every write.
    sqlx::query("DELETE FROM mutation_receipts WHERE created_at_ms < ?")
        .bind(now_ms.saturating_sub(MUTATION_RECEIPT_RETENTION_MS))
        .execute(&mut *tx)
        .await?;
    // A reinstalled phone pairs as a new device and leaves the old record behind. Its tokens stop
    // authenticating after the inactivity window; past STALE_PAIRED_DEVICE_RETENTION_MS without a
    // request the device is revoked so it leaves the paired device list. Pairing again restores it.
    let stale_before_ms = now_ms.saturating_sub(STALE_PAIRED_DEVICE_RETENTION_MS);
    sqlx::query(
        r#"
        UPDATE trusted_devices
        SET revoked_at_ms = ?
        WHERE revoked_at_ms IS NULL
          AND device_id IN (
            SELECT device_id
            FROM paired_device_tokens
            WHERE revoked_at_ms IS NULL
              AND granted_via != 'local-authority'
            GROUP BY device_id
            HAVING MAX(last_seen_at_ms) < ?
          )
        "#,
    )
    .bind(now_ms)
    .bind(stale_before_ms)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        UPDATE paired_device_tokens
        SET revoked_at_ms = ?
        WHERE revoked_at_ms IS NULL
          AND granted_via != 'local-authority'
          AND device_id IN (SELECT device_id FROM trusted_devices WHERE revoked_at_ms = ?)
        "#,
    )
    .bind(now_ms)
    .bind(now_ms)
    .execute(&mut *tx)
    .await?;

    let current_server_version: i64 = sqlx::query_scalar(
        "SELECT current_server_version FROM server_runtime WHERE singleton_id = 1",
    )
    .fetch_one(&mut *tx)
    .await?;

    let min_server_version: Option<i64> =
        sqlx::query_scalar("SELECT MIN(server_version) FROM change_log")
            .fetch_one(&mut *tx)
            .await?;

    let min_replayable = match min_server_version {
        Some(value) => (value - 1).max(0),
        None => current_server_version,
    };

    sqlx::query(
        r#"
        UPDATE server_runtime
        SET min_replayable_server_version = ?,
            oldest_retained_change_at_ms = (
                SELECT MIN(applied_at_ms) FROM change_log
            ),
            updated_at_ms = ?
        WHERE singleton_id = 1
        "#,
    )
    .bind(min_replayable)
    .bind(now_ms)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

pub async fn apply_book_entry_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &BookEntryPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, BookEntryRow>(
        r#"
        SELECT
            scope_id, book_id, asset_fingerprint, mime_type, byte_size, cover_asset_sha256,
            cover_asset_byte_size, cover_asset_mime_type,
            title, author, description, subtype, page_count,
            toc_count, spine_count, section_count, sections_summary_json, has_cover, created_at_ms,
            book_updated_at_ms, record_updated_at_ms, record_updated_by_device_id, record_lamport,
            record_server_version
        FROM book_library_entries
        WHERE scope_id = ? AND book_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;

    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "book.entry", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_book_entry_against_tombstone(client_lamport, tombstone)?;
    }

    let merged = merge_book_entry(
        current.map(BookEntryRecord::try_from).transpose()?,
        entity_id,
        patch,
        client_lamport,
    )?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.entry",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;

    sqlx::query(
        r#"
        INSERT INTO book_library_entries (
            scope_id, book_id, asset_fingerprint, mime_type, byte_size, cover_asset_sha256,
            cover_asset_byte_size, cover_asset_mime_type,
            title, author, description, subtype, page_count,
            toc_count, spine_count, section_count, sections_summary_json, has_cover, created_at_ms,
            book_updated_at_ms, record_updated_at_ms, record_updated_by_device_id, record_lamport,
            record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, book_id) DO UPDATE SET
            asset_fingerprint = excluded.asset_fingerprint,
            mime_type = excluded.mime_type,
            byte_size = excluded.byte_size,
            cover_asset_sha256 = excluded.cover_asset_sha256,
            cover_asset_byte_size = excluded.cover_asset_byte_size,
            cover_asset_mime_type = excluded.cover_asset_mime_type,
            title = excluded.title,
            author = excluded.author,
            description = excluded.description,
            subtype = excluded.subtype,
            page_count = excluded.page_count,
            toc_count = excluded.toc_count,
            spine_count = excluded.spine_count,
            section_count = excluded.section_count,
            sections_summary_json = excluded.sections_summary_json,
            has_cover = excluded.has_cover,
            created_at_ms = excluded.created_at_ms,
            book_updated_at_ms = excluded.book_updated_at_ms,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(merged.asset_fingerprint.as_deref())
    .bind(merged.mime_type.as_deref())
    .bind(merged.byte_size)
    .bind(merged.cover_asset_sha256.as_deref())
    .bind(merged.cover_asset_byte_size)
    .bind(merged.cover_asset_mime_type.as_deref())
    .bind(&merged.title)
    .bind(merged.author.as_deref())
    .bind(merged.description.as_deref())
    .bind(&merged.subtype)
    .bind(merged.page_count)
    .bind(merged.toc_count)
    .bind(merged.spine_count)
    .bind(merged.section_count)
    .bind(merged.sections_summary_json.as_ref().map(Value::to_string))
    .bind(if merged.has_cover { 1_i64 } else { 0_i64 })
    .bind(merged.created_at_ms)
    .bind(merged.book_updated_at_ms)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;

    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "book.entry", entity_id).await?;
    }

    tx.commit().await?;

    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.entry".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookEntryIdentityConflict {
    AssetFingerprint,
    MimeType,
    ByteSize,
    Subtype,
}

pub async fn book_entry_identity_conflict(
    pool: &sqlx::SqlitePool,
    scope_id: &str,
    entity_id: &str,
    patch: &BookEntryPatch,
) -> anyhow::Result<Option<BookEntryIdentityConflict>> {
    let existing = sqlx::query_as::<_, (Option<String>, Option<String>, Option<i64>, String)>(
        "SELECT asset_fingerprint, mime_type, byte_size, subtype FROM book_library_entries WHERE scope_id = ? AND book_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(pool)
    .await?;
    let Some((asset_fingerprint, mime_type, byte_size, subtype)) = existing else {
        return Ok(None);
    };
    if asset_fingerprint.is_some()
        && patch.asset_fingerprint.is_some()
        && asset_fingerprint != patch.asset_fingerprint
    {
        return Ok(Some(BookEntryIdentityConflict::AssetFingerprint));
    }
    if mime_type.is_some() && patch.mime_type.is_some() && mime_type != patch.mime_type {
        return Ok(Some(BookEntryIdentityConflict::MimeType));
    }
    if byte_size.is_some() && patch.byte_size.is_some() && byte_size != patch.byte_size {
        return Ok(Some(BookEntryIdentityConflict::ByteSize));
    }
    if subtype != patch.subtype {
        return Ok(Some(BookEntryIdentityConflict::Subtype));
    }
    Ok(None)
}

pub async fn delete_book_entry_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "book.entry", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_book_entry_against_tombstone(client_lamport, tombstone)?;
    }

    sqlx::query("DELETE FROM book_library_entries WHERE scope_id = ? AND book_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM book_category_assignments WHERE scope_id = ? AND book_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;

    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.entry",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.entry",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "book_deleted",
    )
    .await?;

    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.entry".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    })
}

pub async fn apply_book_category_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &BookCategoryPatch,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, BookCategoryRow>(
        r#"SELECT scope_id, category_id, name, sort_order, record_updated_at_ms, record_updated_by_device_id, record_lamport, record_server_version
        FROM book_categories WHERE scope_id = ? AND category_id = ?"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let current_server_version = current.as_ref().map(|row| row.record_server_version);
    let current = current.map(BookCategoryRecord::from);
    if let Some(outcome) = superseded_category_outcome_in_tx(
        &mut tx,
        scope_id,
        "book.category",
        entity_id,
        event_clock,
        session,
        current.as_ref().map(serde_json::to_value).transpose()?,
        current.as_ref().map(|record| record.record_lamport),
        current_server_version,
    )
    .await?
    {
        tx.commit().await?;
        return Ok(outcome);
    }
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "book.category", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let merged = merge_book_category(current, entity_id, patch, client_lamport)?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.category",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO book_categories (
            scope_id, category_id, name, sort_order, record_updated_at_ms, record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, category_id) DO UPDATE SET
            name = excluded.name,
            sort_order = excluded.sort_order,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&merged.name)
    .bind(merged.order)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "book.category", entity_id).await?;
    }
    if let Some(clock) = event_clock {
        upsert_event_clock_in_tx(
            &mut tx,
            scope_id,
            "book.category",
            entity_id,
            clock,
            &session.device_id,
            applied_at_ms,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(CausalMutationWriteOutcome::Applied(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.category".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    }))
}

pub async fn delete_book_category_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, BookCategoryRow>(
        r#"SELECT scope_id, category_id, name, sort_order, record_updated_at_ms, record_updated_by_device_id, record_lamport, record_server_version
        FROM book_categories WHERE scope_id = ? AND category_id = ?"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let current_server_version = current.as_ref().map(|row| row.record_server_version);
    let current = current.map(BookCategoryRecord::from);
    if let Some(outcome) = superseded_category_outcome_in_tx(
        &mut tx,
        scope_id,
        "book.category",
        entity_id,
        event_clock,
        session,
        current.as_ref().map(serde_json::to_value).transpose()?,
        current.as_ref().map(|record| record.record_lamport),
        current_server_version,
    )
    .await?
    {
        tx.commit().await?;
        return Ok(outcome);
    }
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "book.category", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    sqlx::query("DELETE FROM book_categories WHERE scope_id = ? AND category_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.category",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.category",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "book_category_deleted",
    )
    .await?;
    if let Some(clock) = event_clock {
        upsert_event_clock_in_tx(
            &mut tx,
            scope_id,
            "book.category",
            entity_id,
            clock,
            &session.device_id,
            applied_at_ms,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(CausalMutationWriteOutcome::Applied(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.category".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    }))
}

pub async fn apply_book_category_assignment_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &BookCategoryAssignmentPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, BookCategoryAssignmentRow>(
        r#"SELECT scope_id, book_id, category_ids_json, record_updated_at_ms, record_updated_by_device_id, record_lamport, record_server_version
        FROM book_category_assignments WHERE scope_id = ? AND book_id = ?"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let tombstone =
        load_tombstone_in_tx(&mut tx, scope_id, "book.category_assignment", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let merged = merge_book_category_assignment(
        current
            .map(BookCategoryAssignmentRecord::try_from)
            .transpose()?,
        entity_id,
        patch,
        client_lamport,
    )?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.category_assignment",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO book_category_assignments (
            scope_id, book_id, category_ids_json, record_updated_at_ms, record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, book_id) DO UPDATE SET
            category_ids_json = excluded.category_ids_json,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(serde_json::to_string(&merged.category_ids)?)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "book.category_assignment", entity_id).await?;
    }
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.category_assignment".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    })
}

pub async fn delete_book_category_assignment_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone =
        load_tombstone_in_tx(&mut tx, scope_id, "book.category_assignment", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    sqlx::query("DELETE FROM book_category_assignments WHERE scope_id = ? AND book_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.category_assignment",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.category_assignment",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "book_category_assignment_deleted",
    )
    .await?;
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.category_assignment".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    })
}

pub async fn apply_book_library_ui_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &BookLibraryUiPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, BookLibraryUiRow>(
        r#"SELECT scope_id, ui_state_id, active_category_id, type_filter, status_filter, search, sort_mode, sort_dir,
            record_updated_at_ms, record_updated_by_device_id, record_lamport, record_server_version
        FROM book_library_ui_state WHERE scope_id = ? AND ui_state_id = ?"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let merged = merge_book_library_ui(current.map(Into::into), entity_id, patch, client_lamport)?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.library_ui",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO book_library_ui_state (
            scope_id, ui_state_id, active_category_id, type_filter, status_filter, search, sort_mode, sort_dir,
            record_updated_at_ms, record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, ui_state_id) DO UPDATE SET
            active_category_id = excluded.active_category_id,
            type_filter = excluded.type_filter,
            status_filter = excluded.status_filter,
            search = excluded.search,
            sort_mode = excluded.sort_mode,
            sort_dir = excluded.sort_dir,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(merged.active_category_id.as_deref())
    .bind(&merged.type_filter)
    .bind(&merged.status_filter)
    .bind(&merged.search)
    .bind(&merged.sort_mode)
    .bind(&merged.sort_dir)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.library_ui".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    })
}

pub async fn apply_novel_entry_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelEntryPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, NovelEntryRow>(
        r#"SELECT
            scope_id, novel_id, identity_key, title, author, description, cover_url, external_novel_id, external_url,
            status, tags_json, source_json, added_at_ms, entry_updated_at_ms, record_updated_at_ms,
            record_updated_by_device_id, record_lamport, record_server_version
        FROM novel_library_entries WHERE scope_id = ? AND novel_id = ?"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.entry", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let merged = merge_novel_entry(
        current.map(NovelEntryRecord::try_from).transpose()?,
        entity_id,
        patch,
        client_lamport,
    )?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.entry",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO novel_library_entries (
            scope_id, novel_id, identity_key, title, author, description, cover_url, external_novel_id, external_url,
            status, tags_json, source_json, added_at_ms, entry_updated_at_ms, record_updated_at_ms,
            record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, novel_id) DO UPDATE SET
            identity_key = excluded.identity_key,
            title = excluded.title,
            author = excluded.author,
            description = excluded.description,
            cover_url = excluded.cover_url,
            external_url = excluded.external_url,
            status = excluded.status,
            tags_json = excluded.tags_json,
            source_json = excluded.source_json,
            added_at_ms = excluded.added_at_ms,
            entry_updated_at_ms = excluded.entry_updated_at_ms,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&merged.identity_key)
    .bind(&merged.title)
    .bind(merged.author.as_deref())
    .bind(merged.description.as_deref())
    .bind(merged.cover_url.as_deref())
    .bind(&merged.path)
    .bind(merged.status.as_deref())
    .bind(serde_json::to_string(&merged.tags)?)
    .bind(serde_json::to_string(&merged.source)?)
    .bind(merged.added_at_ms)
    .bind(merged.updated_at_ms)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    if let Some(context) = session.mutation_receipt.as_ref() {
        if context.entity_type == super::models::MutationEntityType::NovelEntry
            && context.entity_id != entity_id
        {
            sqlx::query(
                r#"INSERT INTO novel_entity_aliases (
                    scope_id, alias_entity_id, canonical_entity_id, created_at_ms
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(scope_id, alias_entity_id) DO UPDATE SET
                    canonical_entity_id = excluded.canonical_entity_id"#,
            )
            .bind(scope_id)
            .bind(&context.entity_id)
            .bind(entity_id)
            .bind(applied_at_ms)
            .execute(&mut *tx)
            .await?;
        }
    }
    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "novel.entry", entity_id).await?;
    }
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.entry".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    })
}

/// Resolves a requested novel entry to the already persisted entity with the
/// same canonical mobile identity. The caller holds the process-wide mutation
/// gate, so the lookup and subsequent write cannot race another mutation.
pub async fn resolve_novel_entry_entity_id(
    pool: &sqlx::SqlitePool,
    scope_id: &str,
    requested_entity_id: &str,
    patch: &NovelEntryPatch,
) -> anyhow::Result<String> {
    let resolved_alias = resolve_novel_entity_id(pool, scope_id, requested_entity_id).await?;
    if resolved_alias != requested_entity_id {
        return Ok(resolved_alias);
    }

    let identity_key = canonical_novel_identity_key(patch)
        .unwrap_or_else(|| patch.identity_key.trim().to_string());

    let rows = sqlx::query_as::<_, (String, String, String, Option<String>)>(
        r#"SELECT novel_id, identity_key, source_json, external_url
        FROM novel_library_entries
        WHERE scope_id = ?
        ORDER BY novel_id"#,
    )
    .bind(scope_id)
    .fetch_all(pool)
    .await?;

    if let Some((novel_id, _, _, _)) = rows
        .iter()
        .find(|(_, persisted_identity, _, _)| persisted_identity == &identity_key)
    {
        return Ok(novel_id.clone());
    }

    for (novel_id, _, source_json, path) in rows {
        let source: Value = serde_json::from_str(&source_json)?;
        let Some(path) = path else {
            continue;
        };
        if canonical_novel_identity_key_from_source(&source, &path).as_deref()
            == Some(identity_key.as_str())
        {
            return Ok(novel_id);
        }
    }

    Ok(requested_entity_id.to_string())
}

/// Resolves a persisted alias (or a canonical identity key used as an entity
/// reference) to the entity id that owns the novel record.
pub async fn resolve_novel_entity_id(
    pool: &sqlx::SqlitePool,
    scope_id: &str,
    requested_entity_id: &str,
) -> anyhow::Result<String> {
    let mut resolved = requested_entity_id.to_string();
    for _ in 0..8 {
        let next: Option<String> = sqlx::query_scalar(
            r#"SELECT canonical_entity_id
            FROM novel_entity_aliases
            WHERE scope_id = ? AND alias_entity_id = ?"#,
        )
        .bind(scope_id)
        .bind(&resolved)
        .fetch_optional(pool)
        .await?;
        let Some(next) = next else {
            break;
        };
        if next == resolved {
            break;
        }
        resolved = next;
    }
    if resolved != requested_entity_id {
        return Ok(resolved);
    }

    let identity_owner: Option<String> = sqlx::query_scalar(
        r#"SELECT novel_id
        FROM novel_library_entries
        WHERE scope_id = ? AND identity_key = ?"#,
    )
    .bind(scope_id)
    .bind(requested_entity_id)
    .fetch_optional(pool)
    .await?;
    Ok(identity_owner.unwrap_or(resolved))
}

pub async fn resolve_novel_repository_entity_id(
    pool: &sqlx::SqlitePool,
    scope_id: &str,
    requested_entity_id: &str,
) -> anyhow::Result<String> {
    let alias = sqlx::query_scalar::<_, String>(
        "SELECT canonical_entity_id FROM novel_repository_aliases WHERE scope_id = ? AND alias_entity_id = ?",
    )
    .bind(scope_id)
    .bind(requested_entity_id)
    .fetch_optional(pool)
    .await?;
    Ok(alias.unwrap_or_else(|| requested_entity_id.to_string()))
}

pub async fn resolve_novel_repository_merge_id(
    pool: &sqlx::SqlitePool,
    scope_id: &str,
    requested_entity_id: &str,
    canonical_url: &str,
) -> anyhow::Result<String> {
    let resolved = resolve_novel_repository_entity_id(pool, scope_id, requested_entity_id).await?;
    if resolved != requested_entity_id {
        return Ok(resolved);
    }
    let owner = sqlx::query_scalar::<_, String>(
        "SELECT repository_id FROM novel_repositories WHERE scope_id = ? AND canonical_url = ?",
    )
    .bind(scope_id)
    .bind(canonical_url)
    .fetch_optional(pool)
    .await?;
    Ok(owner.unwrap_or_else(|| canonical_novel_repository_id(canonical_url)))
}

pub async fn resolve_novel_plugin_entity_id(
    pool: &sqlx::SqlitePool,
    scope_id: &str,
    requested_entity_id: &str,
) -> anyhow::Result<String> {
    let alias = sqlx::query_scalar::<_, String>(
        "SELECT canonical_entity_id FROM novel_plugin_aliases WHERE scope_id = ? AND alias_entity_id = ?",
    )
    .bind(scope_id)
    .bind(requested_entity_id)
    .fetch_optional(pool)
    .await?;
    Ok(alias.unwrap_or_else(|| requested_entity_id.to_string()))
}

pub async fn resolve_novel_plugin_merge_id(
    pool: &sqlx::SqlitePool,
    scope_id: &str,
    requested_entity_id: &str,
    repository_id: &str,
    plugin_id: &str,
    source_id: &str,
) -> anyhow::Result<String> {
    let resolved = resolve_novel_plugin_entity_id(pool, scope_id, requested_entity_id).await?;
    if resolved != requested_entity_id {
        return Ok(resolved);
    }
    let owner = sqlx::query_scalar::<_, String>(
        "SELECT plugin_entity_id FROM novel_plugins WHERE scope_id = ? AND repository_id = ? AND plugin_id = ? AND source_id = ?",
    )
    .bind(scope_id)
    .bind(repository_id)
    .bind(plugin_id)
    .bind(source_id)
    .fetch_optional(pool)
    .await?;
    Ok(owner.unwrap_or_else(|| canonical_novel_plugin_id(repository_id, plugin_id, source_id)))
}

pub async fn delete_novel_entry_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.entry", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let assignment_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM novel_category_assignments WHERE scope_id = ? AND novel_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_one(&mut *tx)
    .await?;
    anyhow::ensure!(
        assignment_count == 0,
        "novel entry is still referenced by active category assignments"
    );
    sqlx::query("DELETE FROM novel_library_entries WHERE scope_id = ? AND novel_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.entry",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.entry",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "novel_deleted",
    )
    .await?;
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.entry".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    })
}

pub async fn apply_novel_chapter_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelChapterPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, NovelChapterRow>(
        r#"SELECT scope_id, chapter_id, novel_id, path, title, chapter_order_key, release_time_ms, unread,
            record_updated_at_ms, record_updated_by_device_id, record_lamport, record_server_version
        FROM novel_chapters WHERE scope_id = ? AND chapter_id = ?"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.chapter", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let merged = merge_novel_chapter(current.map(Into::into), entity_id, patch, client_lamport)?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.chapter",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO novel_chapters (
            scope_id, chapter_id, novel_id, path, title, chapter_order_key, release_time_ms, unread,
            record_updated_at_ms, record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, chapter_id) DO UPDATE SET
            novel_id = excluded.novel_id,
            path = excluded.path,
            title = excluded.title,
            chapter_order_key = excluded.chapter_order_key,
            release_time_ms = excluded.release_time_ms,
            unread = excluded.unread,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&merged.novel_id)
    .bind(&merged.path)
    .bind(&merged.title)
    .bind(merged.chapter_order_key)
    .bind(merged.release_time_ms)
    .bind(if merged.unread { 1_i64 } else { 0_i64 })
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "novel.chapter", entity_id).await?;
    }
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.chapter".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    })
}

pub async fn delete_novel_chapter_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.chapter", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    sqlx::query("DELETE FROM novel_chapters WHERE scope_id = ? AND chapter_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.chapter",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.chapter",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "novel_chapter_deleted",
    )
    .await?;
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.chapter".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    })
}

pub async fn apply_novel_chapter_asset_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelChapterAssetPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let novel_exists = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM novel_library_entries WHERE scope_id = ? AND novel_id = ?",
    )
    .bind(scope_id)
    .bind(&patch.novel_id)
    .fetch_optional(&mut *tx)
    .await?
    .is_some();
    if !novel_exists {
        bail!("novel chapter asset references missing novel");
    }
    let chapter_owner = sqlx::query_scalar::<_, String>(
        "SELECT novel_id FROM novel_chapters WHERE scope_id = ? AND chapter_id = ?",
    )
    .bind(scope_id)
    .bind(&patch.chapter_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(chapter_owner) = chapter_owner else {
        bail!("novel chapter asset references missing chapter");
    };
    if chapter_owner != patch.novel_id {
        bail!("novel chapter asset chapter belongs to another novel");
    }

    let current = sqlx::query_as::<_, NovelChapterAssetRow>(
        "SELECT * FROM novel_chapter_assets WHERE scope_id = ? AND chapter_asset_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let tombstone =
        load_tombstone_in_tx(&mut tx, scope_id, "novel.chapter_asset", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_novel_chapter_asset(client_lamport, tombstone)?;
    }
    let merged =
        merge_novel_chapter_asset(current.map(Into::into), entity_id, patch, client_lamport)?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.chapter_asset",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO novel_chapter_assets (
            scope_id, chapter_asset_id, novel_id, chapter_id, schema_version, blob_sha256,
            byte_length, archive_format, created_at_ms, updated_at_ms, record_updated_at_ms,
            record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, chapter_asset_id) DO UPDATE SET
            novel_id = excluded.novel_id,
            chapter_id = excluded.chapter_id,
            schema_version = excluded.schema_version,
            blob_sha256 = excluded.blob_sha256,
            byte_length = excluded.byte_length,
            archive_format = excluded.archive_format,
            created_at_ms = excluded.created_at_ms,
            updated_at_ms = excluded.updated_at_ms,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&merged.novel_id)
    .bind(&merged.chapter_id)
    .bind(i64::from(merged.schema_version))
    .bind(&merged.blob_sha256)
    .bind(merged.byte_length)
    .bind(&merged.archive_format)
    .bind(merged.created_at_ms)
    .bind(merged.updated_at_ms)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "novel.chapter_asset", entity_id).await?;
    }
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.chapter_asset".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    })
}

pub async fn delete_novel_chapter_asset_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone =
        load_tombstone_in_tx(&mut tx, scope_id, "novel.chapter_asset", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_novel_chapter_asset(client_lamport, tombstone)?;
    }
    sqlx::query("DELETE FROM novel_chapter_assets WHERE scope_id = ? AND chapter_asset_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.chapter_asset",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.chapter_asset",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "novel_chapter_asset_deleted",
    )
    .await?;
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.chapter_asset".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    })
}

pub async fn apply_novel_history_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelHistoryPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, NovelHistoryRow>(
        r#"SELECT scope_id, history_id, novel_id, chapter_id, chapter_title, chapter_order_key, locator, locator_sort_key,
            read_at_ms, record_updated_at_ms, record_updated_by_device_id, record_lamport, record_server_version
        FROM novel_history WHERE scope_id = ? AND history_id = ?"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.history", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let merged = merge_novel_history(current.map(Into::into), entity_id, patch, client_lamport)?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.history",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO novel_history (
            scope_id, history_id, novel_id, chapter_id, chapter_title, chapter_order_key, locator, locator_sort_key,
            read_at_ms, record_updated_at_ms, record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, history_id) DO UPDATE SET
            novel_id = excluded.novel_id,
            chapter_id = excluded.chapter_id,
            chapter_title = excluded.chapter_title,
            locator = excluded.locator,
            read_at_ms = excluded.read_at_ms,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&merged.novel_id)
    .bind(merged.chapter_id.as_deref())
    .bind(merged.chapter_title.as_deref())
    .bind(merged.locator.as_deref())
    .bind(merged.read_at_ms)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "novel.history", entity_id).await?;
    }
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.history".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    })
}

pub async fn delete_novel_history_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.history", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    sqlx::query("DELETE FROM novel_history WHERE scope_id = ? AND history_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.history",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.history",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "novel_history_deleted",
    )
    .await?;
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.history".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    })
}

pub async fn apply_novel_classification_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelClassificationPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, NovelClassificationRow>(
        r#"
        SELECT
            scope_id, plugin_id, repository_id, repository_url, lang, version, status, notes,
            baseline_status, baseline_notes, issues_json, smoke_json, filter_keys_json,
            plugin_settings_keys_json, classified_at_ms, record_updated_at_ms,
            record_updated_by_device_id, record_lamport, record_server_version
        FROM novel_source_classification_records
        WHERE scope_id = ? AND plugin_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let tombstone =
        load_tombstone_in_tx(&mut tx, scope_id, "novel.classification", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let merged = merge_novel_classification(
        current
            .map(NovelClassificationRecord::try_from)
            .transpose()?,
        entity_id,
        patch,
        client_lamport,
    )?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.classification",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO novel_source_classification_records (
            scope_id, plugin_id, repository_id, repository_url, lang, version, status, notes,
            baseline_status, baseline_notes, issues_json, smoke_json, filter_keys_json,
            plugin_settings_keys_json, classified_at_ms, record_updated_at_ms,
            record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, plugin_id) DO UPDATE SET
            repository_id = excluded.repository_id,
            repository_url = excluded.repository_url,
            lang = excluded.lang,
            version = excluded.version,
            status = excluded.status,
            notes = excluded.notes,
            baseline_status = excluded.baseline_status,
            baseline_notes = excluded.baseline_notes,
            issues_json = excluded.issues_json,
            smoke_json = excluded.smoke_json,
            filter_keys_json = excluded.filter_keys_json,
            plugin_settings_keys_json = excluded.plugin_settings_keys_json,
            classified_at_ms = excluded.classified_at_ms,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version
        "#,
    )
    .bind(scope_id)
    .bind(&merged.plugin_id)
    .bind(&merged.repository_id)
    .bind(&merged.repository_url)
    .bind(&merged.lang)
    .bind(&merged.version)
    .bind(&merged.status)
    .bind(&merged.notes)
    .bind(&merged.baseline_status)
    .bind(&merged.baseline_notes)
    .bind(serde_json::to_string(&merged.issues_json)?)
    .bind(serde_json::to_string(&merged.smoke_json)?)
    .bind(serde_json::to_string(&merged.filter_keys)?)
    .bind(serde_json::to_string(&merged.plugin_settings_keys)?)
    .bind(merged.classified_at_ms)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.classification".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    })
}

pub async fn delete_novel_classification_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone =
        load_tombstone_in_tx(&mut tx, scope_id, "novel.classification", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    sqlx::query(
        "DELETE FROM novel_source_classification_records WHERE scope_id = ? AND plugin_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .execute(&mut *tx)
    .await?;
    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.classification",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.classification",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "novel_classification_deleted",
    )
    .await?;
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.classification".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    })
}

pub async fn apply_novel_repository_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelRepositoryPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, NovelRepositoryRow>(
        "SELECT * FROM novel_repositories WHERE scope_id = ? AND repository_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?
    .map(NovelRepositoryRecord::from);
    if let Some(existing) = current.as_ref() {
        anyhow::ensure!(
            existing.canonical_url == patch.canonical_url,
            "novel repository identity is immutable"
        );
    }
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.repository", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let record = NovelRepositoryRecord {
        repository_id: entity_id.to_string(),
        canonical_url: patch.canonical_url.clone(),
        name: patch.name.trim().to_string(),
        enabled: patch.enabled,
        created_at_ms: patch.created_at_ms,
        updated_at_ms: patch.updated_at_ms,
        record_lamport: current
            .as_ref()
            .map(|value| next_lamport(value.record_lamport, client_lamport))
            .unwrap_or(client_lamport),
    };
    let value = serde_json::to_value(&record)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.repository",
        entity_id,
        "merge",
        record.record_lamport,
        session,
        Some(&value),
        retention_window,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO novel_repositories (
            scope_id, repository_id, canonical_url, name, enabled, created_at_ms, updated_at_ms,
            record_updated_at_ms, record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, repository_id) DO UPDATE SET
            name = excluded.name, enabled = excluded.enabled,
            created_at_ms = excluded.created_at_ms, updated_at_ms = excluded.updated_at_ms,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&record.canonical_url)
    .bind(&record.name)
    .bind(i64::from(record.enabled))
    .bind(record.created_at_ms)
    .bind(record.updated_at_ms)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(record.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    persist_typed_alias_in_tx(
        &mut tx,
        "novel_repository_aliases",
        scope_id,
        session,
        entity_id,
        applied_at_ms,
    )
    .await?;
    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "novel.repository", entity_id).await?;
    }
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.repository".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: record.record_lamport,
            patch: Some(value.clone()),
            applied_at_ms,
        },
        record: value,
        applied_lamport: record.record_lamport,
    })
}

pub async fn delete_novel_repository_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.repository", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let plugin_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM novel_plugins WHERE scope_id = ? AND repository_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_one(&mut *tx)
    .await?;
    anyhow::ensure!(
        plugin_count == 0,
        "novel repository still has active plugins"
    );
    sqlx::query("DELETE FROM novel_repositories WHERE scope_id = ? AND repository_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    let lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    delete_with_tombstone(
        tx,
        session,
        scope_id,
        "novel.repository",
        entity_id,
        lamport,
        retention_window,
        "novel_repository_deleted",
    )
    .await
}

pub async fn apply_novel_plugin_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelPluginPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let repository_exists = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM novel_repositories WHERE scope_id = ? AND repository_id = ?",
    )
    .bind(scope_id)
    .bind(&patch.repository_id)
    .fetch_optional(&mut *tx)
    .await?
    .is_some();
    anyhow::ensure!(repository_exists, "novel plugin repository does not exist");
    let current = sqlx::query_as::<_, NovelPluginRow>(
        "SELECT * FROM novel_plugins WHERE scope_id = ? AND plugin_entity_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?
    .map(NovelPluginRecord::try_from)
    .transpose()?;
    if let Some(existing) = current.as_ref() {
        anyhow::ensure!(
            existing.repository_id == patch.repository_id
                && existing.plugin_id == patch.plugin_id
                && existing.source_id == patch.source_id,
            "novel plugin identity is immutable"
        );
        anyhow::ensure!(
            existing.version != patch.version
                || (existing.artifact_sha256 == patch.artifact_sha256
                    && existing.artifact_byte_length == patch.artifact_byte_length),
            "novel plugin artifact is immutable within a version"
        );
    }
    let historical_artifact = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT artifact_sha256, artifact_byte_length
        FROM novel_plugin_artifact_versions
        WHERE scope_id = ? AND plugin_entity_id = ? AND version = ?"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(patch.version.trim())
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((sha256, byte_length)) = historical_artifact {
        anyhow::ensure!(
            sha256 == patch.artifact_sha256 && byte_length == patch.artifact_byte_length,
            "novel plugin artifact is immutable for every observed version"
        );
    }
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.plugin", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let record = NovelPluginRecord {
        plugin_entity_id: entity_id.to_string(),
        repository_id: patch.repository_id.clone(),
        plugin_id: patch.plugin_id.trim().to_string(),
        source_id: patch.source_id.trim().to_string(),
        name: patch.name.trim().to_string(),
        version: patch.version.trim().to_string(),
        lang: patch.lang.trim().to_string(),
        enabled: patch.enabled,
        artifact_sha256: patch.artifact_sha256.clone(),
        artifact_byte_length: patch.artifact_byte_length,
        public_settings: patch.public_settings.clone(),
        created_at_ms: patch.created_at_ms,
        updated_at_ms: patch.updated_at_ms,
        record_lamport: current
            .as_ref()
            .map(|value| next_lamport(value.record_lamport, client_lamport))
            .unwrap_or(client_lamport),
    };
    let value = serde_json::to_value(&record)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.plugin",
        entity_id,
        "merge",
        record.record_lamport,
        session,
        Some(&value),
        retention_window,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO novel_plugins (
            scope_id, plugin_entity_id, repository_id, plugin_id, source_id, name, version, lang,
            enabled, artifact_sha256, artifact_byte_length, public_settings_json, created_at_ms,
            updated_at_ms, record_updated_at_ms, record_updated_by_device_id, record_lamport,
            record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, plugin_entity_id) DO UPDATE SET
            name = excluded.name, version = excluded.version, lang = excluded.lang,
            enabled = excluded.enabled, artifact_sha256 = excluded.artifact_sha256,
            artifact_byte_length = excluded.artifact_byte_length,
            public_settings_json = excluded.public_settings_json,
            created_at_ms = excluded.created_at_ms, updated_at_ms = excluded.updated_at_ms,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&record.repository_id)
    .bind(&record.plugin_id)
    .bind(&record.source_id)
    .bind(&record.name)
    .bind(&record.version)
    .bind(&record.lang)
    .bind(i64::from(record.enabled))
    .bind(&record.artifact_sha256)
    .bind(record.artifact_byte_length)
    .bind(serde_json::to_string(&record.public_settings)?)
    .bind(record.created_at_ms)
    .bind(record.updated_at_ms)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(record.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"INSERT OR IGNORE INTO novel_plugin_artifact_versions (
            scope_id, plugin_entity_id, version, artifact_sha256,
            artifact_byte_length, first_seen_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&record.version)
    .bind(&record.artifact_sha256)
    .bind(record.artifact_byte_length)
    .bind(applied_at_ms)
    .execute(&mut *tx)
    .await?;
    persist_typed_alias_in_tx(
        &mut tx,
        "novel_plugin_aliases",
        scope_id,
        session,
        entity_id,
        applied_at_ms,
    )
    .await?;
    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "novel.plugin", entity_id).await?;
    }
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.plugin".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: record.record_lamport,
            patch: Some(value.clone()),
            applied_at_ms,
        },
        record: value,
        applied_lamport: record.record_lamport,
    })
}

pub async fn delete_novel_plugin_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.plugin", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    sqlx::query("DELETE FROM novel_plugins WHERE scope_id = ? AND plugin_entity_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    let lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    delete_with_tombstone(
        tx,
        session,
        scope_id,
        "novel.plugin",
        entity_id,
        lamport,
        retention_window,
        "novel_plugin_deleted",
    )
    .await
}

pub async fn apply_novel_category_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelCategoryPatch,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, NovelCategoryRow>(
        "SELECT * FROM novel_categories WHERE scope_id = ? AND category_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let current_server_version = current.as_ref().map(|row| row.record_server_version);
    let current = current.map(NovelCategoryRecord::from);
    if let Some(outcome) = superseded_category_outcome_in_tx(
        &mut tx,
        scope_id,
        "novel.category",
        entity_id,
        event_clock,
        session,
        current.as_ref().map(serde_json::to_value).transpose()?,
        current.as_ref().map(|record| record.record_lamport),
        current_server_version,
    )
    .await?
    {
        tx.commit().await?;
        return Ok(outcome);
    }
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.category", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_novel_category_against_tombstone(client_lamport, tombstone)?;
    }
    let merged = merge_novel_category(current, entity_id, patch, client_lamport)?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.category",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO novel_categories (
            scope_id, category_id, name, sort_order, record_updated_at_ms,
            record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, category_id) DO UPDATE SET
            name = excluded.name,
            sort_order = excluded.sort_order,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&merged.name)
    .bind(merged.order)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "novel.category", entity_id).await?;
    }
    if let Some(clock) = event_clock {
        upsert_event_clock_in_tx(
            &mut tx,
            scope_id,
            "novel.category",
            entity_id,
            clock,
            &session.device_id,
            applied_at_ms,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(CausalMutationWriteOutcome::Applied(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.category".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    }))
}

pub async fn delete_novel_category_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, NovelCategoryRow>(
        "SELECT * FROM novel_categories WHERE scope_id = ? AND category_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let current_server_version = current.as_ref().map(|row| row.record_server_version);
    let current = current.map(NovelCategoryRecord::from);
    if let Some(outcome) = superseded_category_outcome_in_tx(
        &mut tx,
        scope_id,
        "novel.category",
        entity_id,
        event_clock,
        session,
        current.as_ref().map(serde_json::to_value).transpose()?,
        current.as_ref().map(|record| record.record_lamport),
        current_server_version,
    )
    .await?
    {
        tx.commit().await?;
        return Ok(outcome);
    }
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.category", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_novel_category_against_tombstone(client_lamport, tombstone)?;
    }
    let assignment_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM novel_category_assignments WHERE scope_id = ? AND category_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_one(&mut *tx)
    .await?;
    anyhow::ensure!(
        assignment_count == 0,
        "novel category is still referenced by active assignments"
    );
    sqlx::query("DELETE FROM novel_categories WHERE scope_id = ? AND category_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.category",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.category",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "novel_category_deleted",
    )
    .await?;
    if let Some(clock) = event_clock {
        upsert_event_clock_in_tx(
            &mut tx,
            scope_id,
            "novel.category",
            entity_id,
            clock,
            &session.device_id,
            applied_at_ms,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(CausalMutationWriteOutcome::Applied(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.category".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    }))
}

pub async fn apply_novel_category_assignment_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelCategoryAssignmentPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, NovelCategoryAssignmentRow>(
        "SELECT * FROM novel_category_assignments WHERE scope_id = ? AND assignment_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let tombstone =
        load_tombstone_in_tx(&mut tx, scope_id, "novel.category_assignment", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_novel_category_against_tombstone(client_lamport, tombstone)?;
    }
    let novel_exists: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM novel_library_entries WHERE scope_id = ? AND novel_id = ?)",
    )
    .bind(scope_id)
    .bind(&patch.novel_id)
    .fetch_one(&mut *tx)
    .await?;
    anyhow::ensure!(
        novel_exists == 1,
        "novel category assignment references missing novel"
    );
    let category_exists: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM novel_categories WHERE scope_id = ? AND category_id = ?)",
    )
    .bind(scope_id)
    .bind(&patch.category_id)
    .fetch_one(&mut *tx)
    .await?;
    anyhow::ensure!(
        category_exists == 1,
        "novel category assignment references missing category"
    );
    let merged =
        merge_novel_category_assignment(current.map(Into::into), entity_id, patch, client_lamport)?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.category_assignment",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO novel_category_assignments (
            scope_id, assignment_id, novel_id, category_id, record_updated_at_ms,
            record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, assignment_id) DO UPDATE SET
            novel_id = excluded.novel_id,
            category_id = excluded.category_id,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&merged.novel_id)
    .bind(&merged.category_id)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "novel.category_assignment", entity_id).await?;
    }
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.category_assignment".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    })
}

pub async fn delete_novel_category_assignment_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone =
        load_tombstone_in_tx(&mut tx, scope_id, "novel.category_assignment", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_novel_category_against_tombstone(client_lamport, tombstone)?;
    }
    sqlx::query("DELETE FROM novel_category_assignments WHERE scope_id = ? AND assignment_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.category_assignment",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.category_assignment",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "novel_category_assignment_deleted",
    )
    .await?;
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.category_assignment".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    })
}

/// Books & novels folders are newest-wins by edit time: an edit made offline and replayed after a
/// newer edit from another device keeps the newer folder value instead of the later arrival.
#[allow(clippy::too_many_arguments)]
async fn superseded_category_outcome_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
    event_clock: Option<&EventClock>,
    session: &AuthenticatedSession,
    current_record: Option<Value>,
    current_lamport: Option<i64>,
    current_server_version: Option<i64>,
) -> anyhow::Result<Option<CausalMutationWriteOutcome>> {
    let Some(winning_clock) = superseding_event_clock_in_tx(
        tx,
        scope_id,
        entity_type,
        entity_id,
        event_clock,
        &session.device_id,
    )
    .await?
    else {
        return Ok(None);
    };
    let server_version = superseded_server_version_in_tx(tx, current_server_version).await?;
    Ok(Some(CausalMutationWriteOutcome::Superseded {
        record: current_record.unwrap_or(Value::Null),
        winning_clock,
        server_version,
        applied_lamport: current_lamport.unwrap_or_default(),
    }))
}

async fn superseding_event_clock_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
    incoming: Option<&EventClock>,
    authenticated_device_id: &str,
) -> anyhow::Result<Option<EventClock>> {
    let current = sqlx::query_as::<_, EntityEventClockRow>(
        r#"
        SELECT physical_ms, logical, device_generation_id, authenticated_device_id
        FROM entity_event_clocks
        WHERE scope_id = ? AND entity_type = ? AND entity_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_type)
    .bind(entity_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(current) = current else {
        return Ok(None);
    };
    let winning = EventClock {
        physical_ms: current.physical_ms,
        logical: current.logical,
        device_generation_id: current.device_generation_id.clone(),
    };
    let Some(incoming) = incoming else {
        return Ok(Some(winning));
    };
    let incoming_order = (
        incoming.physical_ms,
        incoming.logical,
        authenticated_device_id,
    )
        .cmp(&(
            current.physical_ms,
            current.logical,
            current.authenticated_device_id.as_str(),
        ))
        .then_with(|| {
            incoming
                .device_generation_id
                .cmp(&current.device_generation_id)
        });
    Ok((incoming_order != Ordering::Greater).then_some(winning))
}

async fn upsert_event_clock_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
    clock: &EventClock,
    authenticated_device_id: &str,
    updated_at_ms: i64,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO entity_event_clocks (
            scope_id, entity_type, entity_id, physical_ms, logical,
            device_generation_id, authenticated_device_id, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, entity_type, entity_id) DO UPDATE SET
            physical_ms = excluded.physical_ms,
            logical = excluded.logical,
            device_generation_id = excluded.device_generation_id,
            authenticated_device_id = excluded.authenticated_device_id,
            updated_at_ms = excluded.updated_at_ms
        "#,
    )
    .bind(scope_id)
    .bind(entity_type)
    .bind(entity_id)
    .bind(clock.physical_ms)
    .bind(clock.logical)
    .bind(&clock.device_generation_id)
    .bind(authenticated_device_id)
    .bind(updated_at_ms)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// A superseded write reports the version of the record that won: replicas wait for that version
/// of this entity, and no later version of it may ever come.
async fn superseded_server_version_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    winning_record_server_version: Option<i64>,
) -> anyhow::Result<i64> {
    match winning_record_server_version {
        Some(server_version) => Ok(server_version),
        None => current_server_version_in_tx(tx).await,
    }
}

async fn current_server_version_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> anyhow::Result<i64> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT current_server_version FROM server_runtime WHERE singleton_id = 1",
    )
    .fetch_one(&mut **tx)
    .await?)
}

pub async fn apply_book_progress_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &BookProgressPatch,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let book_id = normalize_book_progress_book_id(entity_id);
    let canonical_entity_id = if entity_id.starts_with("book.progress::") {
        format!("book.progress::{book_id}")
    } else {
        book_id.clone()
    };
    let current = sqlx::query_as::<_, BookProgressRow>(
        r#"
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
        FROM book_progress
        WHERE scope_id = ? AND book_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(&book_id)
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(winning_clock) = superseding_event_clock_in_tx(
        &mut tx,
        scope_id,
        "book.progress",
        &canonical_entity_id,
        event_clock,
        &session.device_id,
    )
    .await?
    {
        let server_version = superseded_server_version_in_tx(
            &mut tx,
            current.as_ref().map(|row| row.record_server_version),
        )
        .await?;
        let record = current
            .clone()
            .map(BookProgressRecord::from)
            .map(serde_json::to_value)
            .transpose()?
            .unwrap_or(Value::Null);
        let applied_lamport = current
            .as_ref()
            .map(|row| row.record_lamport)
            .unwrap_or_default();
        tx.commit().await?;
        return Ok(CausalMutationWriteOutcome::Superseded {
            record,
            winning_clock,
            server_version,
            applied_lamport,
        });
    }

    let merged = merge_book_progress(
        current.map(Into::into),
        &canonical_entity_id,
        patch,
        client_lamport,
        event_clock.is_some(),
    )?;
    let record = serde_json::to_value(&merged)?;
    let profile_id = None;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        profile_id,
        "book.progress",
        &canonical_entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;

    sqlx::query(
        r#"
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, book_id) DO UPDATE SET
            renderer = excluded.renderer,
            location = excluded.location,
            href = excluded.href,
            progress_percent = excluded.progress_percent,
            last_read_at_ms = excluded.last_read_at_ms,
            page_index = excluded.page_index,
            total_pages = excluded.total_pages,
            section_label = excluded.section_label,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version
        "#,
    )
    .bind(scope_id)
    .bind(&merged.book_id)
    .bind(merged.renderer.as_deref())
    .bind(merged.location.as_deref())
    .bind(merged.href.as_deref())
    .bind(merged.progress_percent)
    .bind(merged.last_read_at_ms)
    .bind(merged.page_index)
    .bind(merged.total_pages)
    .bind(merged.section_label.as_deref())
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;

    if let Some(clock) = event_clock {
        upsert_event_clock_in_tx(
            &mut tx,
            scope_id,
            "book.progress",
            &canonical_entity_id,
            clock,
            &session.device_id,
            applied_at_ms,
        )
        .await?;
    }

    tx.commit().await?;

    Ok(CausalMutationWriteOutcome::Applied(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.progress".to_string(),
            entity_id: canonical_entity_id,
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    }))
}

async fn enqueue_comic_history_projection_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    scope_id: &str,
    entity_id: &str,
    record: &ComicHistoryRecord,
    patch: &ComicHistoryPatch,
    server_version: i64,
    now: i64,
) -> anyhow::Result<()> {
    let Some(profile_id) = scope_id.strip_prefix("comics:profile:") else {
        return Ok(());
    };
    if profile_id.is_empty() || profile_id.chars().any(char::is_control) {
        return Ok(());
    }
    let mut projection_variables = match (&patch.portable_work_ref, &patch.portable_chapter_ref) {
        (Some(work), Some(chapter)) => json!({
            "portableWorkRef": work,
            "portableChapterRef": chapter,
        }),
        (None, None) => {
            let Some(manga_id) =
                suwayomi_numeric_id_for_profile(&record.comic_id, profile_id, ":manga:")
            else {
                return Ok(());
            };
            let Some(chapter_id) =
                suwayomi_numeric_id_for_profile(&record.chapter_id, profile_id, ":chapter:")
            else {
                return Ok(());
            };
            json!({ "mangaId": manga_id, "ids": [chapter_id] })
        }
        _ => return Ok(()),
    };
    let operation_id = format!("comic-history:{profile_id}:{entity_id}:{server_version}");
    projection_variables["lastPageRead"] = json!(record.page_index);
    let variables = serde_json::to_string(&projection_variables)?;

    sqlx::query(
        r#"
        DELETE FROM suwayomi_projection_outbox
        WHERE profile_id = ? AND entity_type = 'comic.history' AND entity_id = ?
          AND status IN ('pending', 'retry', 'blocked') AND source_server_version < ?
        "#,
    )
    .bind(profile_id)
    .bind(entity_id)
    .bind(server_version)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO suwayomi_projection_outbox (
            operation_id, profile_id, operation_name, variables_json,
            entity_type, entity_id, source_server_version,
            next_attempt_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, 'UpdateChaptersProgress', ?, 'comic.history', ?, ?, ?, ?, ?)
        "#,
    )
    .bind(operation_id)
    .bind(profile_id)
    .bind(variables)
    .bind(entity_id)
    .bind(server_version)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn suwayomi_numeric_id_for_profile(
    entity_id: &str,
    expected_profile_id: &str,
    marker: &str,
) -> Option<i64> {
    let profile_and_remote = if let Some(value) = entity_id.strip_prefix("suwayomi:profile:") {
        value
    } else {
        let value = entity_id.strip_prefix("suwayomi:server:")?;
        let profile_marker = value.find(":profile:")?;
        if profile_marker == 0 {
            return None;
        }
        &value[profile_marker + ":profile:".len()..]
    };
    let remote_marker = profile_and_remote.rfind(marker)?;
    let profile_id = &profile_and_remote[..remote_marker];
    if profile_id != expected_profile_id {
        return None;
    }
    profile_and_remote[remote_marker + marker.len()..]
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0 && *value <= i32::MAX as i64)
}

pub async fn apply_novel_progress_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelProgressPatch,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, NovelProgressRow>(
        r#"
        SELECT
            scope_id,
            novel_id,
            chapter_id,
            portable_work_ref_json,
            portable_chapter_ref_json,
            chapter_title,
            chapter_order_key,
            progress_percent,
            locator,
            locator_sort_key,
            updated_at_ms,
            record_updated_at_ms,
            record_updated_by_device_id,
            record_lamport,
            record_server_version
        FROM novel_progress
        WHERE scope_id = ? AND novel_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(winning_clock) = superseding_event_clock_in_tx(
        &mut tx,
        scope_id,
        "novel.progress",
        entity_id,
        event_clock,
        &session.device_id,
    )
    .await?
    {
        let server_version = superseded_server_version_in_tx(
            &mut tx,
            current.as_ref().map(|row| row.record_server_version),
        )
        .await?;
        let record = current
            .clone()
            .map(NovelProgressRecord::from)
            .map(serde_json::to_value)
            .transpose()?
            .unwrap_or(Value::Null);
        let applied_lamport = current
            .as_ref()
            .map(|row| row.record_lamport)
            .unwrap_or_default();
        tx.commit().await?;
        return Ok(CausalMutationWriteOutcome::Superseded {
            record,
            winning_clock,
            server_version,
            applied_lamport,
        });
    }

    let merged = merge_novel_progress(
        current.map(Into::into),
        entity_id,
        patch,
        client_lamport,
        event_clock.is_some(),
    )?;
    let record = serde_json::to_value(&merged)?;
    let profile_id = Some(session.profile_id.as_str());
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        profile_id,
        "novel.progress",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;

    sqlx::query(
        r#"
        INSERT INTO novel_progress (
            scope_id,
            novel_id,
            chapter_id,
            portable_work_ref_json,
            portable_chapter_ref_json,
            chapter_title,
            chapter_order_key,
            progress_percent,
            locator,
            locator_sort_key,
            updated_at_ms,
            record_updated_at_ms,
            record_updated_by_device_id,
            record_lamport,
            record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, novel_id) DO UPDATE SET
            chapter_id = excluded.chapter_id,
            portable_work_ref_json = excluded.portable_work_ref_json,
            portable_chapter_ref_json = excluded.portable_chapter_ref_json,
            chapter_title = excluded.chapter_title,
            chapter_order_key = excluded.chapter_order_key,
            progress_percent = excluded.progress_percent,
            locator = excluded.locator,
            locator_sort_key = excluded.locator_sort_key,
            updated_at_ms = excluded.updated_at_ms,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(merged.chapter_id.as_deref())
    .bind(
        merged
            .portable_work_ref
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?,
    )
    .bind(
        merged
            .portable_chapter_ref
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?,
    )
    .bind(merged.chapter_title.as_deref())
    .bind(merged.chapter_order_key)
    .bind(merged.progress_percent)
    .bind(merged.locator.as_deref())
    .bind(merged.locator_sort_key)
    .bind(merged.updated_at_ms)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;

    if let Some(clock) = event_clock {
        upsert_event_clock_in_tx(
            &mut tx,
            scope_id,
            "novel.progress",
            entity_id,
            clock,
            &session.device_id,
            applied_at_ms,
        )
        .await?;
    }

    tx.commit().await?;

    Ok(CausalMutationWriteOutcome::Applied(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.progress".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    }))
}

pub async fn apply_book_bookmark_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &BookBookmarkPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, BookBookmarkRow>(
        r#"
        SELECT
            scope_id,
            bookmark_id,
            book_id,
            location,
            href,
            page_index,
            progress_percent,
            label,
            note,
            created_at_ms,
            updated_at_ms,
            saved_at_ms,
            record_updated_at_ms,
            record_updated_by_device_id,
            record_lamport,
            record_server_version
        FROM book_bookmarks
        WHERE scope_id = ? AND bookmark_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "book.bookmark", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }

    let merged = merge_book_bookmark(current.map(Into::into), entity_id, patch, client_lamport)?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.bookmark",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;

    sqlx::query(
        r#"
        INSERT INTO book_bookmarks (
            scope_id,
            bookmark_id,
            book_id,
            location,
            href,
            page_index,
            progress_percent,
            label,
            note,
            created_at_ms,
            updated_at_ms,
            saved_at_ms,
            record_updated_at_ms,
            record_updated_by_device_id,
            record_lamport,
            record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, bookmark_id) DO UPDATE SET
            book_id = excluded.book_id,
            location = excluded.location,
            href = excluded.href,
            page_index = excluded.page_index,
            progress_percent = excluded.progress_percent,
            label = excluded.label,
            note = excluded.note,
            created_at_ms = excluded.created_at_ms,
            updated_at_ms = excluded.updated_at_ms,
            saved_at_ms = excluded.saved_at_ms,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&merged.book_id)
    .bind(merged.location.as_deref())
    .bind(merged.href.as_deref())
    .bind(merged.page_index)
    .bind(merged.progress_percent)
    .bind(merged.label.as_deref())
    .bind(merged.note.as_deref())
    .bind(merged.created_at_ms)
    .bind(merged.updated_at_ms)
    .bind(merged.saved_at_ms)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;

    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "book.bookmark", entity_id).await?;
    }

    tx.commit().await?;

    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.bookmark".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    })
}

pub async fn apply_book_highlight_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &BookHighlightPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, BookHighlightRow>(
        "SELECT * FROM book_highlights WHERE scope_id = ? AND highlight_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?
    .map(BookHighlightRecord::try_from)
    .transpose()?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "book.highlight", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }

    let merged = merge_book_highlight(current, entity_id, patch, client_lamport)?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.highlight",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;

    sqlx::query(
        r#"INSERT INTO book_highlights (
            scope_id, highlight_id, book_id, start_locator_json, end_locator_json,
            selected_text, color_argb, note, created_at_ms, updated_at_ms,
            record_updated_at_ms, record_updated_by_device_id, record_lamport,
            record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, highlight_id) DO UPDATE SET
            book_id = excluded.book_id,
            start_locator_json = excluded.start_locator_json,
            end_locator_json = excluded.end_locator_json,
            selected_text = excluded.selected_text,
            color_argb = excluded.color_argb,
            note = excluded.note,
            created_at_ms = excluded.created_at_ms,
            updated_at_ms = excluded.updated_at_ms,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&merged.book_id)
    .bind(serde_json::to_string(&merged.start_locator_json)?)
    .bind(serde_json::to_string(&merged.end_locator_json)?)
    .bind(&merged.selected_text)
    .bind(merged.color_argb)
    .bind(merged.note.as_deref())
    .bind(merged.created_at_ms)
    .bind(merged.updated_at_ms)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;

    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "book.highlight", entity_id).await?;
    }
    tx.commit().await?;

    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.highlight".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    })
}

pub async fn apply_novel_bookmark_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelBookmarkPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, NovelBookmarkRow>(
        r#"
        SELECT
            scope_id,
            bookmark_id,
            novel_id,
            chapter_id,
            chapter_title,
            chapter_order_key,
            locator,
            locator_sort_key,
            label,
            saved_at_ms,
            record_updated_at_ms,
            record_updated_by_device_id,
            record_lamport,
            record_server_version
        FROM novel_bookmarks
        WHERE scope_id = ? AND bookmark_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.bookmark", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }

    let merged = merge_novel_bookmark(current.map(Into::into), entity_id, patch, client_lamport)?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.bookmark",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;

    sqlx::query(
        r#"
        INSERT INTO novel_bookmarks (
            scope_id,
            bookmark_id,
            novel_id,
            chapter_id,
            chapter_title,
            chapter_order_key,
            locator,
            locator_sort_key,
            label,
            saved_at_ms,
            record_updated_at_ms,
            record_updated_by_device_id,
            record_lamport,
            record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, bookmark_id) DO UPDATE SET
            novel_id = excluded.novel_id,
            chapter_id = excluded.chapter_id,
            chapter_title = excluded.chapter_title,
            chapter_order_key = excluded.chapter_order_key,
            locator = excluded.locator,
            locator_sort_key = excluded.locator_sort_key,
            label = excluded.label,
            saved_at_ms = excluded.saved_at_ms,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&merged.novel_id)
    .bind(merged.chapter_id.as_deref())
    .bind(merged.chapter_title.as_deref())
    .bind(merged.chapter_order_key)
    .bind(merged.locator.as_deref())
    .bind(merged.locator_sort_key)
    .bind(merged.label.as_deref())
    .bind(merged.saved_at_ms)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;

    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "novel.bookmark", entity_id).await?;
    }

    tx.commit().await?;

    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.bookmark".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    })
}

pub async fn apply_book_history_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &BookHistoryPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, BookHistoryRow>(
        "SELECT * FROM book_history WHERE scope_id = ? AND history_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "book.history", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }

    let merged = merge_book_history(current.map(Into::into), entity_id, patch, client_lamport)?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.history",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;

    sqlx::query(
        r#"INSERT INTO book_history (
            scope_id, history_id, book_id, renderer, location, href, page_index,
            progress_percent, section_label, read_at_ms, record_updated_at_ms,
            record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, history_id) DO UPDATE SET
            book_id = excluded.book_id,
            renderer = excluded.renderer,
            location = excluded.location,
            href = excluded.href,
            page_index = excluded.page_index,
            progress_percent = excluded.progress_percent,
            section_label = excluded.section_label,
            read_at_ms = excluded.read_at_ms,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&merged.book_id)
    .bind(merged.renderer.as_deref())
    .bind(merged.location.as_deref())
    .bind(merged.href.as_deref())
    .bind(merged.page_index)
    .bind(merged.progress_percent)
    .bind(merged.section_label.as_deref())
    .bind(merged.read_at_ms)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "book.history", entity_id).await?;
    }
    tx.commit().await?;

    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.history".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    })
}

pub async fn delete_book_bookmark_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "book.bookmark", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }

    sqlx::query("DELETE FROM book_bookmarks WHERE scope_id = ? AND bookmark_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;

    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.bookmark",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.bookmark",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "bookmark_deleted",
    )
    .await?;

    tx.commit().await?;

    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.bookmark".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    })
}

pub async fn delete_book_highlight_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "book.highlight", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }

    sqlx::query("DELETE FROM book_highlights WHERE scope_id = ? AND highlight_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;

    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.highlight",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.highlight",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "book_highlight_deleted",
    )
    .await?;
    tx.commit().await?;

    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.highlight".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    })
}

pub async fn delete_novel_bookmark_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.bookmark", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }

    sqlx::query("DELETE FROM novel_bookmarks WHERE scope_id = ? AND bookmark_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;

    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.bookmark",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "novel.bookmark",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "bookmark_deleted",
    )
    .await?;

    tx.commit().await?;

    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "novel.bookmark".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    })
}

pub async fn delete_book_history_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "book.history", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    sqlx::query("DELETE FROM book_history WHERE scope_id = ? AND history_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.history",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        None,
        "book.history",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "book_history_deleted",
    )
    .await?;
    tx.commit().await?;

    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.history".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    })
}

pub async fn apply_comic_sync_state_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
    record: &Value,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    apply_comic_sync_state_mutation_inner(
        pool,
        session,
        scope_id,
        entity_type,
        entity_id,
        record,
        client_lamport,
        event_clock,
        retention_window,
        true,
    )
    .await
}

pub async fn apply_mirrored_comic_sync_state_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
    record: &Value,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    apply_comic_sync_state_mutation_inner(
        pool,
        session,
        scope_id,
        entity_type,
        entity_id,
        record,
        client_lamport,
        event_clock,
        retention_window,
        false,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn apply_comic_sync_state_mutation_inner(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
    record: &Value,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
    enqueue_projection: bool,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, ComicSyncStateRow>(
        r#"
        SELECT entity_type, entity_id, record_json, record_lamport, record_server_version
        FROM comic_sync_state
        WHERE scope_id = ? AND entity_type = ? AND entity_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_type)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(winning_clock) = superseding_event_clock_in_tx(
        &mut tx,
        scope_id,
        entity_type,
        entity_id,
        event_clock,
        &session.device_id,
    )
    .await?
    {
        let server_version = superseded_server_version_in_tx(
            &mut tx,
            current.as_ref().map(|row| row.record_server_version),
        )
        .await?;
        let record = current
            .as_ref()
            .map(|row| serde_json::from_str(&row.record_json))
            .transpose()?
            .unwrap_or(Value::Null);
        let applied_lamport = current
            .as_ref()
            .map(|row| row.record_lamport)
            .unwrap_or_default();
        tx.commit().await?;
        return Ok(CausalMutationWriteOutcome::Superseded {
            record,
            winning_clock,
            server_version,
            applied_lamport,
        });
    }
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, entity_type, entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let applied_lamport = current
        .as_ref()
        .map(|row| next_lamport(row.record_lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        entity_type,
        entity_id,
        "merge",
        applied_lamport,
        session,
        Some(record),
        retention_window,
    )
    .await?;
    sqlx::query(
        r#"
        INSERT INTO comic_sync_state (
            scope_id, entity_type, entity_id, record_json, record_updated_at_ms,
            record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, entity_type, entity_id) DO UPDATE SET
            record_json = excluded.record_json,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version
        "#,
    )
    .bind(scope_id)
    .bind(entity_type)
    .bind(entity_id)
    .bind(serde_json::to_string(record)?)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(applied_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    if enqueue_projection {
        enqueue_comic_state_projection_in_tx(
            &mut tx,
            scope_id,
            entity_type,
            entity_id,
            record,
            false,
            server_version,
            applied_at_ms,
        )
        .await?;
    }
    if let Some(clock) = event_clock {
        upsert_event_clock_in_tx(
            &mut tx,
            scope_id,
            entity_type,
            entity_id,
            clock,
            &session.device_id,
            applied_at_ms,
        )
        .await?;
    }
    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, entity_type, entity_id).await?;
    }
    tx.commit().await?;
    Ok(CausalMutationWriteOutcome::Applied(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: entity_type.to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: applied_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record: record.clone(),
        applied_lamport,
    }))
}

pub async fn delete_comic_sync_state_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    delete_comic_sync_state_mutation_inner(
        pool,
        session,
        scope_id,
        entity_type,
        entity_id,
        client_lamport,
        event_clock,
        retention_window,
        true,
    )
    .await
}

/// Deletes a record the desktop already removed from Suwayomi. Unlike a client delete it does
/// not enqueue a Suwayomi projection, because Suwayomi is the source of this change.
pub async fn delete_mirrored_comic_sync_state_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    delete_comic_sync_state_mutation_inner(
        pool,
        session,
        scope_id,
        entity_type,
        entity_id,
        client_lamport,
        event_clock,
        retention_window,
        false,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn delete_comic_sync_state_mutation_inner(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
    enqueue_projection: bool,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, ComicSyncStateRow>(
        r#"
        SELECT entity_type, entity_id, record_json, record_lamport, record_server_version
        FROM comic_sync_state
        WHERE scope_id = ? AND entity_type = ? AND entity_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_type)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(winning_clock) = superseding_event_clock_in_tx(
        &mut tx,
        scope_id,
        entity_type,
        entity_id,
        event_clock,
        &session.device_id,
    )
    .await?
    {
        let server_version = superseded_server_version_in_tx(
            &mut tx,
            current.as_ref().map(|row| row.record_server_version),
        )
        .await?;
        let record = current
            .as_ref()
            .map(|row| serde_json::from_str(&row.record_json))
            .transpose()?
            .unwrap_or(Value::Null);
        let applied_lamport = current
            .as_ref()
            .map(|row| row.record_lamport)
            .unwrap_or_default();
        tx.commit().await?;
        return Ok(CausalMutationWriteOutcome::Superseded {
            record,
            winning_clock,
            server_version,
            applied_lamport,
        });
    }
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, entity_type, entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let applied_lamport = current
        .as_ref()
        .map(|row| next_lamport(row.record_lamport, client_lamport))
        .or_else(|| {
            tombstone
                .as_ref()
                .map(|row| next_lamport(row.lamport, client_lamport))
        })
        .unwrap_or(client_lamport);
    let previous_record = current
        .as_ref()
        .map(|row| serde_json::from_str(&row.record_json))
        .transpose()?;
    sqlx::query(
        "DELETE FROM comic_sync_state WHERE scope_id = ? AND entity_type = ? AND entity_id = ?",
    )
    .bind(scope_id)
    .bind(entity_type)
    .bind(entity_id)
    .execute(&mut *tx)
    .await?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        entity_type,
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        entity_type,
        entity_id,
        &session.device_id,
        applied_lamport,
        server_version,
        applied_at_ms,
        retention_window,
        "client_delete",
    )
    .await?;
    let projection_record = match previous_record {
        _ if !enqueue_projection => None,
        Some(record) => Some(record),
        None => portable_comic_entry_delete_record_in_tx(&mut tx, scope_id, entity_type, entity_id)
            .await?
            .or_else(|| comic_delete_projection_record_from_id(entity_type, entity_id)),
    };
    if let Some(record) = projection_record.as_ref() {
        enqueue_comic_state_projection_in_tx(
            &mut tx,
            scope_id,
            entity_type,
            entity_id,
            record,
            true,
            server_version,
            applied_at_ms,
        )
        .await?;
    }
    if let Some(clock) = event_clock {
        upsert_event_clock_in_tx(
            &mut tx,
            scope_id,
            entity_type,
            entity_id,
            clock,
            &session.device_id,
            applied_at_ms,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(CausalMutationWriteOutcome::Applied(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: entity_type.to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    }))
}

#[derive(Debug, Clone, FromRow)]
#[allow(dead_code)]
pub struct TrackingRecordRow {
    pub entity_type: String,
    pub entity_id: String,
    pub work_id: String,
    pub tracker_key: String,
    pub record_json: String,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct TrackingTombstoneRow {
    pub entity_id: String,
    pub server_version: i64,
    #[allow(dead_code)]
    pub deleted_by_device_id: String,
}

#[derive(Debug, Clone, FromRow, PartialEq, Eq)]
pub struct SuwayomiTrackingMirrorStateRow {
    pub entity_id: String,
    pub suwayomi_fingerprint: Option<String>,
    pub core_server_version: i64,
}

async fn load_tracking_record_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
) -> anyhow::Result<Option<TrackingRecordRow>> {
    Ok(sqlx::query_as::<_, TrackingRecordRow>(
        r#"
        SELECT entity_type, entity_id, work_id, tracker_key, record_json,
               record_updated_by_device_id, record_lamport, record_server_version
        FROM tracking_records
        WHERE scope_id = ? AND entity_type = ? AND entity_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_type)
    .bind(entity_id)
    .fetch_optional(&mut **tx)
    .await?)
}

fn superseded_tracking_outcome(
    current: Option<&TrackingRecordRow>,
    winning_clock: EventClock,
    server_version: i64,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    let record = current
        .map(|row| serde_json::from_str(&row.record_json))
        .transpose()?
        .unwrap_or(Value::Null);
    Ok(CausalMutationWriteOutcome::Superseded {
        record,
        winning_clock,
        server_version,
        applied_lamport: current.map(|row| row.record_lamport).unwrap_or_default(),
    })
}

/// Stores a full-state tracker binding (`comic.tracking` / `novel.tracking`).
///
/// The record replaces the previous one as a whole.  Causal clocks decide
/// concurrent writers.  Mobile Lamport counters are small device-local values,
/// so a tombstone written by another clock domain (for example the Suwayomi
/// mirror) must not block a causally newer re-bind; the Lamport tombstone
/// guard only applies to legacy writes without an event clock.
#[allow(clippy::too_many_arguments)]
pub async fn apply_tracking_record_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
    work_id: &str,
    tracker_key: &str,
    record: &Value,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = load_tracking_record_in_tx(&mut tx, scope_id, entity_type, entity_id).await?;
    if let Some(winning_clock) = superseding_event_clock_in_tx(
        &mut tx,
        scope_id,
        entity_type,
        entity_id,
        event_clock,
        &session.device_id,
    )
    .await?
    {
        let server_version = superseded_server_version_in_tx(
            &mut tx,
            current.as_ref().map(|row| row.record_server_version),
        )
        .await?;
        let outcome = superseded_tracking_outcome(current.as_ref(), winning_clock, server_version)?;
        tx.commit().await?;
        return Ok(outcome);
    }
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, entity_type, entity_id).await?;
    if let (Some(tombstone), None) = (tombstone.as_ref(), event_clock) {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let applied_lamport = current
        .as_ref()
        .map(|row| next_lamport(row.record_lamport, client_lamport))
        .or_else(|| {
            tombstone
                .as_ref()
                .map(|row| next_lamport(row.lamport, client_lamport))
        })
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        entity_type,
        entity_id,
        "merge",
        applied_lamport,
        session,
        Some(record),
        retention_window,
    )
    .await?;
    sqlx::query(
        r#"
        INSERT INTO tracking_records (
            scope_id, entity_type, entity_id, work_id, tracker_key, record_json,
            record_updated_at_ms, record_updated_by_device_id, record_lamport,
            record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, entity_type, entity_id) DO UPDATE SET
            work_id = excluded.work_id,
            tracker_key = excluded.tracker_key,
            record_json = excluded.record_json,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version
        "#,
    )
    .bind(scope_id)
    .bind(entity_type)
    .bind(entity_id)
    .bind(work_id)
    .bind(tracker_key)
    .bind(serde_json::to_string(record)?)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(applied_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;
    if let Some(clock) = event_clock {
        upsert_event_clock_in_tx(
            &mut tx,
            scope_id,
            entity_type,
            entity_id,
            clock,
            &session.device_id,
            applied_at_ms,
        )
        .await?;
    }
    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, entity_type, entity_id).await?;
    }
    tx.commit().await?;
    Ok(CausalMutationWriteOutcome::Applied(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: entity_type.to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: applied_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record: record.clone(),
        applied_lamport,
    }))
}

/// Unbinds a tracker: removes the stored binding and records a tombstone.
#[allow(clippy::too_many_arguments)]
pub async fn delete_tracking_record_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = load_tracking_record_in_tx(&mut tx, scope_id, entity_type, entity_id).await?;
    if let Some(winning_clock) = superseding_event_clock_in_tx(
        &mut tx,
        scope_id,
        entity_type,
        entity_id,
        event_clock,
        &session.device_id,
    )
    .await?
    {
        let server_version = superseded_server_version_in_tx(
            &mut tx,
            current.as_ref().map(|row| row.record_server_version),
        )
        .await?;
        let outcome = superseded_tracking_outcome(current.as_ref(), winning_clock, server_version)?;
        tx.commit().await?;
        return Ok(outcome);
    }
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, entity_type, entity_id).await?;
    if let (Some(tombstone), None) = (tombstone.as_ref(), event_clock) {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let applied_lamport = current
        .as_ref()
        .map(|row| next_lamport(row.record_lamport, client_lamport))
        .or_else(|| {
            tombstone
                .as_ref()
                .map(|row| next_lamport(row.lamport, client_lamport))
        })
        .unwrap_or(client_lamport);
    sqlx::query(
        "DELETE FROM tracking_records WHERE scope_id = ? AND entity_type = ? AND entity_id = ?",
    )
    .bind(scope_id)
    .bind(entity_type)
    .bind(entity_id)
    .execute(&mut *tx)
    .await?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        entity_type,
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        entity_type,
        entity_id,
        &session.device_id,
        applied_lamport,
        server_version,
        applied_at_ms,
        retention_window,
        "client_delete",
    )
    .await?;
    if let Some(clock) = event_clock {
        upsert_event_clock_in_tx(
            &mut tx,
            scope_id,
            entity_type,
            entity_id,
            clock,
            &session.device_id,
            applied_at_ms,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(CausalMutationWriteOutcome::Applied(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: entity_type.to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    }))
}

pub async fn list_tracking_records(
    pool: &sqlx::SqlitePool,
    scope_id: &str,
    entity_type: &str,
) -> anyhow::Result<Vec<TrackingRecordRow>> {
    Ok(sqlx::query_as::<_, TrackingRecordRow>(
        r#"
        SELECT entity_type, entity_id, work_id, tracker_key, record_json,
               record_updated_by_device_id, record_lamport, record_server_version
        FROM tracking_records
        WHERE scope_id = ? AND entity_type = ?
        ORDER BY entity_id
        "#,
    )
    .bind(scope_id)
    .bind(entity_type)
    .fetch_all(pool)
    .await?)
}

pub async fn list_tracking_tombstones(
    pool: &sqlx::SqlitePool,
    scope_id: &str,
    entity_type: &str,
) -> anyhow::Result<Vec<TrackingTombstoneRow>> {
    Ok(sqlx::query_as::<_, TrackingTombstoneRow>(
        r#"
        SELECT entity_id, server_version, deleted_by_device_id
        FROM tombstones
        WHERE scope_id = ? AND entity_type = ?
        ORDER BY entity_id
        "#,
    )
    .bind(scope_id)
    .bind(entity_type)
    .fetch_all(pool)
    .await?)
}

pub async fn list_suwayomi_tracking_mirror_state(
    pool: &sqlx::SqlitePool,
    profile_id: &str,
) -> anyhow::Result<Vec<SuwayomiTrackingMirrorStateRow>> {
    Ok(sqlx::query_as::<_, SuwayomiTrackingMirrorStateRow>(
        r#"
        SELECT entity_id, suwayomi_fingerprint, core_server_version
        FROM suwayomi_tracking_mirror_state
        WHERE profile_id = ?
        "#,
    )
    .bind(profile_id)
    .fetch_all(pool)
    .await?)
}

pub async fn upsert_suwayomi_tracking_mirror_state(
    pool: &sqlx::SqlitePool,
    profile_id: &str,
    entity_id: &str,
    suwayomi_fingerprint: Option<&str>,
    core_server_version: i64,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO suwayomi_tracking_mirror_state (
            profile_id, entity_id, suwayomi_fingerprint, core_server_version, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, entity_id) DO UPDATE SET
            suwayomi_fingerprint = excluded.suwayomi_fingerprint,
            core_server_version = excluded.core_server_version,
            updated_at_ms = excluded.updated_at_ms
        "#,
    )
    .bind(profile_id)
    .bind(entity_id)
    .bind(suwayomi_fingerprint)
    .bind(core_server_version)
    .bind(now_ms())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_suwayomi_tracking_mirror_state(
    pool: &sqlx::SqlitePool,
    profile_id: &str,
    entity_id: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "DELETE FROM suwayomi_tracking_mirror_state WHERE profile_id = ? AND entity_id = ?",
    )
    .bind(profile_id)
    .bind(entity_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn push_tracking_snapshot_entities_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    entities: &mut Vec<SnapshotEntity>,
    scope_id: &str,
    entity_type: &str,
) -> anyhow::Result<()> {
    let rows = sqlx::query_as::<_, TrackingRecordRow>(
        r#"
        SELECT entity_type, entity_id, work_id, tracker_key, record_json,
               record_updated_by_device_id, record_lamport, record_server_version
        FROM tracking_records
        WHERE scope_id = ? AND entity_type = ?
        ORDER BY entity_id
        "#,
    )
    .bind(scope_id)
    .bind(entity_type)
    .fetch_all(&mut **tx)
    .await?;
    for row in rows {
        let record: Value = serde_json::from_str(&row.record_json)?;
        push_snapshot_entity(
            entities,
            entity_type,
            row.entity_id,
            row.record_server_version,
            row.record_lamport,
            record,
        )?;
    }
    Ok(())
}

pub(crate) const COMIC_CATEGORY_ASSIGNMENT_ID_PREFIX: &str = "comic-category-assignment:";
/// Outbox operation for an assignment delete whose comic/category pair is only known by
/// its hashed id; the projection worker resolves the pair against Suwayomi.
pub(crate) const REMOVE_COMIC_CATEGORY_ASSIGNMENT_OPERATION: &str =
    "RemoveComicCategoryAssignment";
/// Projection variable carrying a portable comic's title hint; removed before Suwayomi sees it.
pub(crate) const PORTABLE_TITLE_HINT_FIELD: &str = "portableTitleHint";

/// `comic_sync_state` is only written by client merges, so deleting an item that already
/// existed in Suwayomi has no stored record. Rebuild the projection input from the id.
/// Entries restored from a backup on both devices were never published, so their delete arrives
/// without a stored record. The portable binding still names the Suwayomi manga to project.
async fn portable_comic_entry_delete_record_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
) -> anyhow::Result<Option<Value>> {
    if entity_type != "comic.entry" {
        return Ok(None);
    }
    let Some(profile_id) = scope_id.strip_prefix("comics:profile:") else {
        return Ok(None);
    };
    let binding = sqlx::query_as::<_, PortableWorkBindingRow>(
        "SELECT * FROM portable_work_bindings WHERE profile_id = ? AND portable_id = ?",
    )
    .bind(profile_id)
    .bind(entity_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(work) = binding
        .filter(|binding| binding.resolution_state == "BOUND")
        .and_then(|binding| binding.portable_ref().ok())
        .filter(|work| matches!(work, PortableWorkRefV3::Comic { .. }))
    else {
        return Ok(None);
    };
    Ok(Some(json!({ "comicId": entity_id, "portableWorkRef": work })))
}

fn comic_delete_projection_record_from_id(entity_type: &str, entity_id: &str) -> Option<Value> {
    match entity_type {
        "comic.entry" => Some(json!({ "comicId": entity_id })),
        "comic.category" => Some(json!({ "categoryId": entity_id })),
        "comic.category_assignment" => Some(json!({ "assignmentId": entity_id })),
        _ => None,
    }
}

async fn enqueue_comic_state_projection_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
    record: &Value,
    deleting: bool,
    server_version: i64,
    now: i64,
) -> anyhow::Result<()> {
    let Some(profile_id) = scope_id.strip_prefix("comics:profile:") else {
        return Ok(());
    };
    let projections: Vec<(&str, Value)> = match entity_type {
        "comic.entry" => {
            let Some(comic_id) = record.get("comicId").and_then(Value::as_str) else {
                return Ok(());
            };
            let variables = if let Some(work) = record
                .get("portableWorkRef")
                .filter(|value| !value.is_null())
            {
                let mut variables = json!({ "portableWorkRef": work, "inLibrary": !deleting });
                if let Some(title) = record.get("titleHint").filter(|value| value.is_string()) {
                    variables[PORTABLE_TITLE_HINT_FIELD] = title.clone();
                }
                variables
            } else {
                let Some(manga_id) =
                    suwayomi_numeric_id_for_profile(comic_id, profile_id, ":manga:")
                else {
                    return Ok(());
                };
                json!({ "id": manga_id, "inLibrary": !deleting })
            };
            vec![("UpdateManga", variables)]
        }
        "comic.category_assignment" => {
            let Some(comic_id) = record.get("comicId").and_then(Value::as_str) else {
                if deleting && entity_id.starts_with(COMIC_CATEGORY_ASSIGNMENT_ID_PREFIX) {
                    return enqueue_comic_projections_in_tx(
                        tx,
                        profile_id,
                        entity_type,
                        entity_id,
                        vec![(
                            REMOVE_COMIC_CATEGORY_ASSIGNMENT_OPERATION,
                            json!({ "assignmentId": entity_id }),
                        )],
                        server_version,
                        now,
                    )
                    .await;
                }
                return Ok(());
            };
            let Some(category_id) = record.get("categoryId").and_then(Value::as_str) else {
                return Ok(());
            };
            let Some(category_id) =
                suwayomi_numeric_id_for_profile(category_id, profile_id, ":category:")
            else {
                return Ok(());
            };
            let (add_to, remove_from) = if deleting {
                (Vec::<i64>::new(), vec![category_id])
            } else {
                (vec![category_id], Vec::<i64>::new())
            };
            let variables = if let Some(work) = record
                .get("portableWorkRef")
                .filter(|value| !value.is_null())
            {
                json!({
                    "portableWorkRef": work,
                    "addTo": add_to,
                    "removeFrom": remove_from,
                })
            } else {
                let Some(manga_id) =
                    suwayomi_numeric_id_for_profile(comic_id, profile_id, ":manga:")
                else {
                    return Ok(());
                };
                json!({
                    "mangaId": manga_id,
                    "addTo": add_to,
                    "removeFrom": remove_from,
                })
            };
            vec![("UpdateMangaCategories", variables)]
        }
        "comic.chapter_state" if !deleting => {
            let portable_work_ref = record
                .get("portableWorkRef")
                .filter(|value| !value.is_null());
            let portable_chapter_ref = record
                .get("portableChapterRef")
                .filter(|value| !value.is_null());
            let mut variables = match (portable_work_ref, portable_chapter_ref) {
                (Some(work), Some(chapter)) => json!({
                    "portableWorkRef": work,
                    "portableChapterRef": chapter,
                }),
                (None, None) => {
                    let Some(comic_id) = record.get("comicId").and_then(Value::as_str) else {
                        return Ok(());
                    };
                    let Some(chapter_id) = record.get("chapterId").and_then(Value::as_str) else {
                        return Ok(());
                    };
                    let Some(manga_id) =
                        suwayomi_numeric_id_for_profile(comic_id, profile_id, ":manga:")
                    else {
                        return Ok(());
                    };
                    let Some(chapter_id) =
                        suwayomi_numeric_id_for_profile(chapter_id, profile_id, ":chapter:")
                    else {
                        return Ok(());
                    };
                    json!({ "mangaId": manga_id, "ids": [chapter_id] })
                }
                _ => return Ok(()),
            };
            variables["isRead"] = record.get("read").cloned().unwrap_or(Value::Null);
            variables["isBookmarked"] = record.get("bookmarked").cloned().unwrap_or(Value::Null);
            variables["lastPageRead"] = record.get("lastPageRead").cloned().unwrap_or(Value::Null);
            vec![("UpdateChaptersProgress", variables)]
        }
        "comic.category" => {
            let Some(category_id) = record.get("categoryId").and_then(Value::as_str) else {
                return Ok(());
            };
            let Some(category_id) =
                suwayomi_numeric_id_for_profile(category_id, profile_id, ":category:")
            else {
                return Ok(());
            };
            if deleting {
                vec![("DeleteCategory", json!({ "id": category_id }))]
            } else {
                let mut category_projections = Vec::with_capacity(2);
                if let Some(name) = record.get("name").and_then(Value::as_str) {
                    category_projections
                        .push(("UpdateCategory", json!({ "id": category_id, "name": name })));
                }
                if let Some(order) = record.get("order").and_then(Value::as_i64) {
                    category_projections.push((
                        "UpdateCategoryOrder",
                        json!({ "id": category_id, "position": order }),
                    ));
                }
                category_projections
            }
        }
        _ => Vec::new(),
    };
    enqueue_comic_projections_in_tx(
        tx,
        profile_id,
        entity_type,
        entity_id,
        projections,
        server_version,
        now,
    )
    .await
}

async fn enqueue_comic_projections_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    profile_id: &str,
    entity_type: &str,
    entity_id: &str,
    projections: Vec<(&str, Value)>,
    server_version: i64,
    now: i64,
) -> anyhow::Result<()> {
    if projections.is_empty() {
        return Ok(());
    }
    let mut projections = projections;
    // Chapter progress records are patches whose null fields mean "unchanged", so a superseded
    // projection's values still apply unless the newer record sets them; otherwise a read flag
    // followed quickly by a page-only update would never reach Suwayomi.
    if projections
        .iter()
        .any(|(operation_name, _)| *operation_name == "UpdateChaptersProgress")
    {
        let superseded: Vec<String> = sqlx::query_scalar(
            r#"
            SELECT variables_json FROM suwayomi_projection_outbox
            WHERE profile_id = ? AND entity_type = ? AND entity_id = ?
              AND operation_name = 'UpdateChaptersProgress'
              AND status IN ('pending', 'retry', 'blocked') AND source_server_version < ?
            ORDER BY source_server_version DESC
            "#,
        )
        .bind(profile_id)
        .bind(entity_type)
        .bind(entity_id)
        .bind(server_version)
        .fetch_all(&mut **tx)
        .await?;
        for older in &superseded {
            let older: Value = serde_json::from_str(older)?;
            for (_, variables) in projections
                .iter_mut()
                .filter(|(operation_name, _)| *operation_name == "UpdateChaptersProgress")
            {
                for key in ["isRead", "isBookmarked", "lastPageRead"] {
                    if variables.get(key).is_none_or(Value::is_null) {
                        if let Some(value) = older.get(key).filter(|value| !value.is_null()) {
                            variables[key] = value.clone();
                        }
                    }
                }
            }
        }
    }
    sqlx::query(
        r#"
        DELETE FROM suwayomi_projection_outbox
        WHERE profile_id = ? AND entity_type = ? AND entity_id = ?
          AND status IN ('pending', 'retry', 'blocked') AND source_server_version < ?
        "#,
    )
    .bind(profile_id)
    .bind(entity_type)
    .bind(entity_id)
    .bind(server_version)
    .execute(&mut **tx)
    .await?;
    for (projection_index, (operation_name, variables)) in projections.into_iter().enumerate() {
        sqlx::query(
            r#"
            INSERT OR IGNORE INTO suwayomi_projection_outbox (
                operation_id, profile_id, operation_name, variables_json,
                entity_type, entity_id, source_server_version,
                next_attempt_at_ms, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(format!(
            "comic-state:{profile_id}:{entity_type}:{entity_id}:{server_version}:{projection_index}"
        ))
        .bind(profile_id)
        .bind(operation_name)
        .bind(serde_json::to_string(&variables)?)
        .bind(entity_type)
        .bind(entity_id)
        .bind(server_version)
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// Queues the stored progress of a work's chapters again, exactly as it was queued when it
/// arrived. For chapters Suwayomi replaced after the progress was applied to them (a source that
/// now lists them under another host): the projection finds the chapters that took their place.
/// Returns how many records were queued.
pub async fn reproject_comic_chapter_states(
    pool: &sqlx::SqlitePool,
    profile_id: &str,
    work: &PortableWorkRefV3,
    chapter_keys: &std::collections::BTreeSet<String>,
) -> anyhow::Result<usize> {
    let PortableWorkRefV3::Comic { manga_key, .. } = work else {
        return Ok(0);
    };
    if chapter_keys.is_empty() {
        return Ok(0);
    }
    let scope_id = format!("comics:profile:{profile_id}");
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        r#"
        SELECT entity_id, record_json, record_server_version FROM comic_sync_state
        WHERE scope_id = ? AND entity_type = 'comic.chapter_state' AND instr(record_json, ?) > 0
        "#,
    )
    .bind(&scope_id)
    .bind(serde_json::to_string(manga_key)?)
    .fetch_all(pool)
    .await
    .context("failed to load stored chapter progress to project again")?;
    let now = now_ms();
    let mut tx = pool.begin().await?;
    let mut queued = 0;
    for (entity_id, record_json, server_version) in rows {
        let Ok(record) = serde_json::from_str::<Value>(&record_json) else {
            continue;
        };
        let matches = record
            .get("portableChapterRef")
            .cloned()
            .and_then(|value| serde_json::from_value::<PortableChapterRefV3>(value).ok())
            .is_some_and(|chapter| {
                matches!(&chapter, PortableChapterRefV3::Comic { work: chapter_work, chapter_key }
                    if chapter_work == work && chapter_keys.contains(chapter_key))
            });
        if !matches {
            continue;
        }
        enqueue_comic_state_projection_in_tx(
            &mut tx,
            &scope_id,
            "comic.chapter_state",
            &entity_id,
            &record,
            false,
            server_version,
            now,
        )
        .await?;
        queued += 1;
    }
    tx.commit().await?;
    Ok(queued)
}

pub async fn apply_comic_history_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &ComicHistoryPatch,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    apply_comic_history_mutation_inner(
        pool,
        session,
        scope_id,
        entity_id,
        patch,
        client_lamport,
        event_clock,
        retention_window,
        true,
    )
    .await
}

/// History read from Suwayomi itself. Projecting it back would rewrite `lastPageRead`, and
/// Suwayomi stamps `lastReadAt` with the current time on that write, so every restored or
/// mirrored read would look like it happened just now.
pub async fn apply_mirrored_comic_history_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &ComicHistoryPatch,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    apply_comic_history_mutation_inner(
        pool,
        session,
        scope_id,
        entity_id,
        patch,
        client_lamport,
        event_clock,
        retention_window,
        false,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn apply_comic_history_mutation_inner(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &ComicHistoryPatch,
    client_lamport: i64,
    event_clock: Option<&EventClock>,
    retention_window: Duration,
    project_to_suwayomi: bool,
) -> anyhow::Result<CausalMutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, ComicHistoryRow>(
        r#"
        SELECT
            scope_id, history_id, comic_id, chapter_id,
            portable_work_ref_json, portable_chapter_ref_json, page_index, page_count,
            progress_percent, read_at_ms, record_updated_at_ms,
            record_updated_by_device_id, record_lamport, record_server_version
        FROM comic_history
        WHERE scope_id = ? AND history_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(winning_clock) = superseding_event_clock_in_tx(
        &mut tx,
        scope_id,
        "comic.history",
        entity_id,
        event_clock,
        &session.device_id,
    )
    .await?
    {
        let server_version = superseded_server_version_in_tx(
            &mut tx,
            current.as_ref().map(|row| row.record_server_version),
        )
        .await?;
        let record = current
            .clone()
            .map(ComicHistoryRecord::from)
            .map(serde_json::to_value)
            .transpose()?
            .unwrap_or(Value::Null);
        let applied_lamport = current
            .as_ref()
            .map(|row| row.record_lamport)
            .unwrap_or_default();
        tx.commit().await?;
        return Ok(CausalMutationWriteOutcome::Superseded {
            record,
            winning_clock,
            server_version,
            applied_lamport,
        });
    }
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "comic.history", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }

    let merged = merge_comic_history(current.map(Into::into), entity_id, patch, client_lamport)?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "comic.history",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;

    let portable_work_ref_json = merged
        .portable_work_ref
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let portable_chapter_ref_json = merged
        .portable_chapter_ref
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    sqlx::query(
        r#"
        INSERT INTO comic_history (
            scope_id, history_id, comic_id, chapter_id,
            portable_work_ref_json, portable_chapter_ref_json, page_index, page_count,
            progress_percent, read_at_ms, record_updated_at_ms,
            record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, history_id) DO UPDATE SET
            comic_id = excluded.comic_id,
            chapter_id = excluded.chapter_id,
            portable_work_ref_json = excluded.portable_work_ref_json,
            portable_chapter_ref_json = excluded.portable_chapter_ref_json,
            page_index = excluded.page_index,
            page_count = excluded.page_count,
            progress_percent = excluded.progress_percent,
            read_at_ms = excluded.read_at_ms,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&merged.comic_id)
    .bind(&merged.chapter_id)
    .bind(portable_work_ref_json)
    .bind(portable_chapter_ref_json)
    .bind(merged.page_index)
    .bind(merged.page_count)
    .bind(merged.progress_percent)
    .bind(merged.read_at_ms)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;

    if project_to_suwayomi {
        enqueue_comic_history_projection_in_tx(
            &mut tx,
            scope_id,
            entity_id,
            &merged,
            patch,
            server_version,
            applied_at_ms,
        )
        .await?;
    }

    if let Some(clock) = event_clock {
        upsert_event_clock_in_tx(
            &mut tx,
            scope_id,
            "comic.history",
            entity_id,
            clock,
            &session.device_id,
            applied_at_ms,
        )
        .await?;
    }

    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "comic.history", entity_id).await?;
    }
    tx.commit().await?;

    Ok(CausalMutationWriteOutcome::Applied(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "comic.history".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    }))
}

pub async fn delete_comic_history_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "comic.history", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    sqlx::query("DELETE FROM comic_history WHERE scope_id = ? AND history_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "comic.history",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "comic.history",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        "comic_history_deleted",
    )
    .await?;
    tx.commit().await?;

    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "comic.history".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    })
}

pub async fn apply_comic_page_bookmark_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &ComicPageBookmarkPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let current = sqlx::query_as::<_, ComicPageBookmarkRow>(
        r#"
        SELECT
            scope_id, bookmark_id, comic_id, chapter_id,
            portable_work_ref_json, portable_chapter_ref_json, page_index, page_count,
            label, saved_at_ms, record_updated_at_ms, record_updated_by_device_id,
            record_lamport, record_server_version
        FROM comic_page_bookmarks
        WHERE scope_id = ? AND bookmark_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let tombstone =
        load_tombstone_in_tx(&mut tx, scope_id, "comic.page_bookmark", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
        ensure_comic_parent_matches_tombstone(tombstone, &patch.comic_id)?;
    }

    let merged =
        merge_comic_page_bookmark(current.map(Into::into), entity_id, patch, client_lamport)?;
    let record = serde_json::to_value(&merged)?;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "comic.page_bookmark",
        entity_id,
        "merge",
        merged.record_lamport,
        session,
        Some(&record),
        retention_window,
    )
    .await?;

    let portable_work_ref_json = merged
        .portable_work_ref
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let portable_chapter_ref_json = merged
        .portable_chapter_ref
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    sqlx::query(
        r#"
        INSERT INTO comic_page_bookmarks (
            scope_id, bookmark_id, comic_id, chapter_id,
            portable_work_ref_json, portable_chapter_ref_json, page_index, page_count,
            label, saved_at_ms, record_updated_at_ms, record_updated_by_device_id,
            record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, bookmark_id) DO UPDATE SET
            comic_id = excluded.comic_id,
            chapter_id = excluded.chapter_id,
            portable_work_ref_json = excluded.portable_work_ref_json,
            portable_chapter_ref_json = excluded.portable_chapter_ref_json,
            page_index = excluded.page_index,
            page_count = excluded.page_count,
            label = excluded.label,
            saved_at_ms = excluded.saved_at_ms,
            record_updated_at_ms = excluded.record_updated_at_ms,
            record_updated_by_device_id = excluded.record_updated_by_device_id,
            record_lamport = excluded.record_lamport,
            record_server_version = excluded.record_server_version
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .bind(&merged.comic_id)
    .bind(&merged.chapter_id)
    .bind(portable_work_ref_json)
    .bind(portable_chapter_ref_json)
    .bind(merged.page_index)
    .bind(merged.page_count)
    .bind(merged.label.as_deref())
    .bind(merged.saved_at_ms)
    .bind(applied_at_ms)
    .bind(&session.device_id)
    .bind(merged.record_lamport)
    .bind(server_version)
    .execute(&mut *tx)
    .await?;

    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "comic.page_bookmark", entity_id).await?;
    }
    tx.commit().await?;

    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "comic.page_bookmark".to_string(),
            entity_id: entity_id.to_string(),
            op: "merge".to_string(),
            lamport: merged.record_lamport,
            patch: Some(record.clone()),
            applied_at_ms,
        },
        record,
        applied_lamport: merged.record_lamport,
    })
}

pub async fn delete_comic_page_bookmark_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = begin_write(pool).await?;
    let tombstone =
        load_tombstone_in_tx(&mut tx, scope_id, "comic.page_bookmark", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let current_comic_id: Option<String> = sqlx::query_scalar(
        "SELECT comic_id FROM comic_page_bookmarks WHERE scope_id = ? AND bookmark_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM comic_page_bookmarks WHERE scope_id = ? AND bookmark_id = ?")
        .bind(scope_id)
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    let applied_lamport = tombstone
        .as_ref()
        .map(|value| next_lamport(value.lamport, client_lamport))
        .unwrap_or(client_lamport);
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "comic.page_bookmark",
        entity_id,
        "delete",
        applied_lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    let reason_code = current_comic_id
        .as_deref()
        .map(comic_page_bookmark_tombstone_reason)
        .or_else(|| tombstone.as_ref().map(|value| value.reason_code.clone()))
        .unwrap_or_else(|| "comic_page_bookmark_deleted".to_string());
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        "comic.page_bookmark",
        entity_id,
        &session.device_id,
        applied_lamport,
        applied_at_ms,
        server_version,
        retention_window,
        &reason_code,
    )
    .await?;
    tx.commit().await?;

    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: "comic.page_bookmark".to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport: applied_lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport,
    })
}

async fn persist_typed_alias_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    table: &str,
    scope_id: &str,
    session: &AuthenticatedSession,
    canonical_entity_id: &str,
    created_at_ms: i64,
) -> anyhow::Result<()> {
    let Some(context) = session.mutation_receipt.as_ref() else {
        return Ok(());
    };
    if context.entity_id == canonical_entity_id {
        return Ok(());
    }
    anyhow::ensure!(
        matches!(table, "novel_repository_aliases" | "novel_plugin_aliases"),
        "unsupported alias table"
    );
    let query = format!(
        "SELECT canonical_entity_id FROM {table} WHERE scope_id = ? AND alias_entity_id = ?"
    );
    let existing = sqlx::query_scalar::<_, String>(&query)
        .bind(scope_id)
        .bind(&context.entity_id)
        .fetch_optional(&mut **tx)
        .await?;
    anyhow::ensure!(
        existing.as_deref().is_none() || existing.as_deref() == Some(canonical_entity_id),
        "entity alias already belongs to another canonical identity"
    );
    let query = format!(
        "INSERT OR IGNORE INTO {table} (scope_id, alias_entity_id, canonical_entity_id, created_at_ms) VALUES (?, ?, ?, ?)"
    );
    sqlx::query(&query)
        .bind(scope_id)
        .bind(&context.entity_id)
        .bind(canonical_entity_id)
        .bind(created_at_ms)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn delete_with_tombstone(
    mut tx: sqlx::Transaction<'_, sqlx::Sqlite>,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
    lamport: i64,
    retention_window: Duration,
    reason_code: &str,
) -> anyhow::Result<MutationWriteOutcome> {
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        entity_type,
        entity_id,
        "delete",
        lamport,
        session,
        None,
        retention_window,
    )
    .await?;
    upsert_tombstone_in_tx(
        &mut tx,
        scope_id,
        Some(session.profile_id.as_str()),
        entity_type,
        entity_id,
        &session.device_id,
        lamport,
        applied_at_ms,
        server_version,
        retention_window,
        reason_code,
    )
    .await?;
    tx.commit().await?;
    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: Some(session.profile_id.clone()),
            entity_type: entity_type.to_string(),
            entity_id: entity_id.to_string(),
            op: "delete".to_string(),
            lamport,
            patch: None,
            applied_at_ms,
        },
        record: Value::Null,
        applied_lamport: lamport,
    })
}

async fn append_change_log_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    scope_id: &str,
    profile_id: Option<&str>,
    entity_type: &str,
    entity_id: &str,
    op: &str,
    lamport: i64,
    session: &AuthenticatedSession,
    patch: Option<&Value>,
    retention_window: Duration,
) -> anyhow::Result<(i64, i64)> {
    let applied_at_ms = now_ms();
    let replay_until_ms = applied_at_ms + retention_window.as_millis() as i64;
    let patch_json = patch.map(serde_json::to_string).transpose()?;

    let result = sqlx::query(
        r#"
        INSERT INTO change_log (
            scope_id,
            profile_id,
            entity_type,
            entity_id,
            op,
            lamport,
            changed_by_device_id,
            patch_json,
            replay_until_ms,
            applied_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(scope_id)
    .bind(profile_id)
    .bind(entity_type)
    .bind(entity_id)
    .bind(op)
    .bind(lamport)
    .bind(&session.device_id)
    .bind(patch_json.as_deref())
    .bind(replay_until_ms)
    .bind(applied_at_ms)
    .execute(&mut **tx)
    .await?;
    let server_version = result.last_insert_rowid();

    sqlx::query(
        r#"
        UPDATE server_runtime
        SET current_server_version = ?,
            updated_at_ms = ?
        WHERE singleton_id = 1
        "#,
    )
    .bind(server_version)
    .bind(applied_at_ms)
    .execute(&mut **tx)
    .await?;

    if let Some(context) = session.mutation_receipt.as_ref() {
        let persisted_entity_id = context
            .canonical_entity_id
            .as_deref()
            .unwrap_or(context.entity_id.as_str());
        if context.device_id != session.device_id
            || context.entity_type.as_str() != entity_type
            || persisted_entity_id != entity_id
            || context.scope_id != scope_id
            || match context.op {
                MutationOperation::Merge => op != "merge",
                MutationOperation::Delete => op != "delete",
            }
        {
            bail!("active mutation receipt context does not match the persisted change");
        }

        let result = MutationResult {
            client_mutation_id: context.client_mutation_id.clone(),
            entity_type: context.entity_type,
            entity_id: context.entity_id.clone(),
            canonical_entity_id: context.canonical_entity_id.clone(),
            scope_id: context.scope_id.clone(),
            op: context.op,
            status: MutationResultStatus::Applied,
            applied_server_version: Some(server_version),
            applied_lamport: Some(lamport),
            event_clock: context.event_clock.clone(),
            record: Some(patch.cloned().unwrap_or(Value::Null)),
            error: None,
        };
        let result_json = serde_json::to_string(&result)?;
        sqlx::query(
            r#"
            INSERT INTO mutation_receipts (
                device_id,
                client_mutation_id,
                mutation_hash,
                mutation_json,
                result_json,
                applied_server_version,
                created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&context.device_id)
        .bind(&context.client_mutation_id)
        .bind(&context.mutation_hash)
        .bind(&context.mutation_json)
        .bind(result_json)
        .bind(server_version)
        .bind(applied_at_ms)
        .execute(&mut **tx)
        .await?;
    }

    Ok((server_version, applied_at_ms))
}

async fn load_tombstone_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
) -> anyhow::Result<Option<TombstoneRow>> {
    let tombstone = sqlx::query_as::<_, TombstoneRow>(
        r#"
        SELECT
            scope_id,
            profile_id,
            entity_type,
            entity_id,
            deleted_by_device_id,
            lamport,
            deleted_at_ms,
            server_version,
            retain_until_ms,
            reason_code
        FROM tombstones
        WHERE scope_id = ? AND entity_type = ? AND entity_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_type)
    .bind(entity_id)
    .fetch_optional(&mut **tx)
    .await?;

    Ok(tombstone)
}

async fn upsert_tombstone_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    scope_id: &str,
    profile_id: Option<&str>,
    entity_type: &str,
    entity_id: &str,
    deleted_by_device_id: &str,
    lamport: i64,
    deleted_at_ms: i64,
    server_version: i64,
    retention_window: Duration,
    reason_code: &str,
) -> anyhow::Result<()> {
    let retain_until_ms = deleted_at_ms + retention_window.as_millis() as i64;
    sqlx::query(
        r#"
        INSERT INTO tombstones (
            scope_id,
            profile_id,
            entity_type,
            entity_id,
            deleted_by_device_id,
            lamport,
            deleted_at_ms,
            server_version,
            retain_until_ms,
            reason_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, entity_type, entity_id) DO UPDATE SET
            profile_id = excluded.profile_id,
            deleted_by_device_id = excluded.deleted_by_device_id,
            lamport = excluded.lamport,
            deleted_at_ms = excluded.deleted_at_ms,
            server_version = excluded.server_version,
            retain_until_ms = excluded.retain_until_ms,
            reason_code = excluded.reason_code
        "#,
    )
    .bind(scope_id)
    .bind(profile_id)
    .bind(entity_type)
    .bind(entity_id)
    .bind(deleted_by_device_id)
    .bind(lamport)
    .bind(deleted_at_ms)
    .bind(server_version)
    .bind(retain_until_ms)
    .bind(reason_code)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn delete_tombstone_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    scope_id: &str,
    entity_type: &str,
    entity_id: &str,
) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM tombstones WHERE scope_id = ? AND entity_type = ? AND entity_id = ?")
        .bind(scope_id)
        .bind(entity_type)
        .bind(entity_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

fn ensure_not_stale_against_tombstone(
    client_lamport: i64,
    tombstone: &TombstoneRow,
) -> anyhow::Result<()> {
    if client_lamport <= tombstone.lamport {
        bail!(
            "stale bookmark mutation rejected by tombstone lamport {}",
            tombstone.lamport
        );
    }
    Ok(())
}

fn ensure_not_stale_book_entry_against_tombstone(
    client_lamport: i64,
    tombstone: &TombstoneRow,
) -> anyhow::Result<()> {
    if client_lamport <= tombstone.lamport {
        bail!(
            "stale book entry mutation rejected by tombstone lamport {}",
            tombstone.lamport
        );
    }
    Ok(())
}

fn ensure_not_stale_novel_category_against_tombstone(
    client_lamport: i64,
    tombstone: &TombstoneRow,
) -> anyhow::Result<()> {
    if client_lamport <= tombstone.lamport {
        bail!(
            "stale novel category mutation rejected by tombstone lamport {}",
            tombstone.lamport
        );
    }
    Ok(())
}

fn ensure_not_stale_novel_chapter_asset(
    client_lamport: i64,
    tombstone: &TombstoneRow,
) -> anyhow::Result<()> {
    if client_lamport <= tombstone.lamport {
        bail!("stale novel chapter asset mutation rejected by tombstone lamport");
    }
    Ok(())
}

const COMIC_BOOKMARK_PARENT_REASON_PREFIX: &str = "comic_page_bookmark_deleted:parent_sha256:";

fn comic_page_bookmark_tombstone_reason(comic_id: &str) -> String {
    use sha2::{Digest, Sha256};

    format!(
        "{COMIC_BOOKMARK_PARENT_REASON_PREFIX}{:x}",
        Sha256::digest(comic_id.as_bytes())
    )
}

fn ensure_comic_parent_matches_tombstone(
    tombstone: &TombstoneRow,
    comic_id: &str,
) -> anyhow::Result<()> {
    let Some(expected_hash) = tombstone
        .reason_code
        .strip_prefix(COMIC_BOOKMARK_PARENT_REASON_PREFIX)
    else {
        return Ok(());
    };
    let incoming_reason = comic_page_bookmark_tombstone_reason(comic_id);
    let incoming_hash = incoming_reason
        .strip_prefix(COMIC_BOOKMARK_PARENT_REASON_PREFIX)
        .expect("generated comic bookmark tombstone reason has its prefix");
    anyhow::ensure!(
        expected_hash == incoming_hash,
        "comic page bookmark parent comic_id does not match tombstone"
    );
    Ok(())
}

fn merge_book_entry(
    current: Option<BookEntryRecord>,
    entity_id: &str,
    patch: &BookEntryPatch,
    client_lamport: i64,
) -> anyhow::Result<BookEntryRecord> {
    let incoming = BookEntryRecord {
        book_id: entity_id.to_string(),
        asset_fingerprint: normalize_optional_string(patch.asset_fingerprint.as_deref()),
        mime_type: normalize_optional_string(patch.mime_type.as_deref()),
        byte_size: patch.byte_size,
        cover_asset_sha256: normalize_optional_string(patch.cover_asset_sha256.as_deref()),
        cover_asset_byte_size: patch.cover_asset_byte_size,
        cover_asset_mime_type: normalize_optional_string(patch.cover_asset_mime_type.as_deref()),
        title: patch.title.clone(),
        author: normalize_optional_string(patch.author.as_deref()),
        description: normalize_optional_string(patch.description.as_deref()),
        subtype: patch.subtype.clone(),
        page_count: patch.page_count,
        toc_count: patch.toc_count,
        spine_count: patch.spine_count,
        section_count: patch.section_count,
        sections_summary_json: patch.sections_summary_json.clone(),
        has_cover: patch.has_cover,
        created_at_ms: patch.created_at_ms,
        book_updated_at_ms: patch.book_updated_at_ms,
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => {
            if let (Some(current), Some(next)) = (
                existing.asset_fingerprint.as_deref(),
                incoming.asset_fingerprint.as_deref(),
            ) {
                anyhow::ensure!(current == next, "book asset identity cannot change");
            }
            anyhow::ensure!(
                existing.subtype == incoming.subtype,
                "book subtype cannot change"
            );
            if let (Some(current), Some(next)) = (existing.byte_size, incoming.byte_size) {
                anyhow::ensure!(current == next, "book byte size cannot change");
            }
            if let (Some(current), Some(next)) =
                (existing.mime_type.as_deref(), incoming.mime_type.as_deref())
            {
                anyhow::ensure!(current == next, "book mime type cannot change");
            }
            BookEntryRecord {
                asset_fingerprint: incoming.asset_fingerprint.or(existing.asset_fingerprint),
                mime_type: incoming.mime_type.or(existing.mime_type),
                byte_size: incoming.byte_size.or(existing.byte_size),
                record_lamport: next_lamport(existing.record_lamport, client_lamport),
                ..incoming
            }
        }
    })
}

fn merge_book_category(
    current: Option<BookCategoryRecord>,
    entity_id: &str,
    patch: &BookCategoryPatch,
    client_lamport: i64,
) -> anyhow::Result<BookCategoryRecord> {
    anyhow::ensure!(
        patch.category_id == entity_id,
        "book category patch category_id must match entity_id",
    );

    let incoming = BookCategoryRecord {
        category_id: entity_id.to_string(),
        name: patch.name.clone(),
        order: patch.order,
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => BookCategoryRecord {
            record_lamport: next_lamport(existing.record_lamport, client_lamport),
            ..incoming
        },
    })
}

fn merge_book_category_assignment(
    current: Option<BookCategoryAssignmentRecord>,
    entity_id: &str,
    patch: &BookCategoryAssignmentPatch,
    client_lamport: i64,
) -> anyhow::Result<BookCategoryAssignmentRecord> {
    anyhow::ensure!(
        patch.book_id == entity_id,
        "book category assignment patch book_id must match entity_id",
    );

    let incoming = BookCategoryAssignmentRecord {
        book_id: entity_id.to_string(),
        category_ids: patch.category_ids.clone(),
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => BookCategoryAssignmentRecord {
            record_lamport: next_lamport(existing.record_lamport, client_lamport),
            ..incoming
        },
    })
}

fn merge_book_library_ui(
    current: Option<BookLibraryUiRecord>,
    entity_id: &str,
    patch: &BookLibraryUiPatch,
    client_lamport: i64,
) -> anyhow::Result<BookLibraryUiRecord> {
    let incoming = BookLibraryUiRecord {
        ui_state_id: entity_id.to_string(),
        active_category_id: normalize_optional_string(patch.active_category_id.as_deref()),
        type_filter: patch.type_filter.clone(),
        status_filter: patch.status_filter.clone(),
        search: patch.search.clone(),
        sort_mode: patch.sort_mode.clone(),
        sort_dir: patch.sort_dir.clone(),
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => BookLibraryUiRecord {
            record_lamport: next_lamport(existing.record_lamport, client_lamport),
            ..incoming
        },
    })
}

fn merge_novel_entry(
    current: Option<NovelEntryRecord>,
    entity_id: &str,
    patch: &NovelEntryPatch,
    client_lamport: i64,
) -> anyhow::Result<NovelEntryRecord> {
    let incoming = NovelEntryRecord {
        novel_id: entity_id.to_string(),
        identity_key: canonical_novel_identity_key(patch)
            .unwrap_or_else(|| patch.identity_key.trim().to_string()),
        title: patch.title.clone(),
        author: normalize_optional_string(patch.author.as_deref()),
        description: normalize_optional_string(patch.description.as_deref()),
        cover_url: normalize_optional_string(patch.cover_url.as_deref()),
        path: patch.path.clone(),
        status: normalize_optional_string(patch.status.as_deref()),
        tags: patch.tags.clone(),
        source: patch.source.clone(),
        added_at_ms: patch.added_at_ms,
        updated_at_ms: patch.updated_at_ms,
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => NovelEntryRecord {
            record_lamport: next_lamport(existing.record_lamport, client_lamport),
            ..incoming
        },
    })
}

fn merge_novel_chapter(
    current: Option<NovelChapterRecord>,
    entity_id: &str,
    patch: &NovelChapterPatch,
    client_lamport: i64,
) -> anyhow::Result<NovelChapterRecord> {
    let incoming = NovelChapterRecord {
        chapter_id: entity_id.to_string(),
        novel_id: patch.novel_id.clone(),
        path: patch.path.clone(),
        title: patch.title.clone(),
        chapter_order_key: patch.chapter_order_key,
        release_time_ms: patch.release_time_ms,
        unread: patch.unread,
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => NovelChapterRecord {
            record_lamport: next_lamport(existing.record_lamport, client_lamport),
            ..incoming
        },
    })
}

fn merge_novel_chapter_asset(
    current: Option<NovelChapterAssetRecord>,
    entity_id: &str,
    patch: &NovelChapterAssetPatch,
    client_lamport: i64,
) -> anyhow::Result<NovelChapterAssetRecord> {
    let incoming = NovelChapterAssetRecord {
        chapter_asset_id: entity_id.to_string(),
        schema_version: patch.schema_version,
        novel_id: patch.novel_id.clone(),
        chapter_id: patch.chapter_id.clone(),
        blob_sha256: patch.blob_sha256.clone(),
        byte_length: patch.byte_length,
        archive_format: patch.archive_format.clone(),
        created_at_ms: patch.created_at_ms,
        updated_at_ms: patch.updated_at_ms,
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => {
            anyhow::ensure!(
                existing.novel_id == incoming.novel_id
                    && existing.chapter_id == incoming.chapter_id,
                "novel chapter asset parent identity is immutable"
            );
            NovelChapterAssetRecord {
                record_lamport: next_lamport(existing.record_lamport, client_lamport),
                ..incoming
            }
        }
    })
}

fn merge_novel_history(
    current: Option<NovelHistoryRecord>,
    entity_id: &str,
    patch: &NovelHistoryPatch,
    client_lamport: i64,
) -> anyhow::Result<NovelHistoryRecord> {
    let incoming = NovelHistoryRecord {
        history_id: entity_id.to_string(),
        novel_id: patch.novel_id.clone(),
        chapter_id: normalize_optional_string(patch.chapter_id.as_deref()),
        chapter_title: normalize_optional_string(patch.chapter_title.as_deref()),
        locator: normalize_optional_string(patch.locator.as_deref()),
        read_at_ms: patch.read_at_ms,
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => NovelHistoryRecord {
            record_lamport: next_lamport(existing.record_lamport, client_lamport),
            ..incoming
        },
    })
}

fn merge_novel_classification(
    current: Option<NovelClassificationRecord>,
    entity_id: &str,
    patch: &NovelClassificationPatch,
    client_lamport: i64,
) -> anyhow::Result<NovelClassificationRecord> {
    anyhow::ensure!(
        patch.plugin_id == entity_id,
        "novel classification patch plugin_id must match entity_id",
    );

    let incoming = NovelClassificationRecord {
        plugin_id: entity_id.to_string(),
        repository_id: normalize_optional_string(patch.repository_id.as_deref()),
        repository_url: normalize_optional_string(patch.repository_url.as_deref()),
        lang: normalize_optional_string(patch.lang.as_deref()),
        version: normalize_optional_string(patch.version.as_deref()),
        status: patch.status.clone(),
        notes: patch.notes.clone(),
        baseline_status: normalize_optional_string(patch.baseline_status.as_deref()),
        baseline_notes: normalize_optional_string(patch.baseline_notes.as_deref()),
        issues_json: patch.issues_json.clone(),
        smoke_json: patch.smoke_json.clone(),
        filter_keys: patch.filter_keys.clone(),
        plugin_settings_keys: patch.plugin_settings_keys.clone(),
        classified_at_ms: patch.classified_at_ms,
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => NovelClassificationRecord {
            record_lamport: next_lamport(existing.record_lamport, client_lamport),
            ..incoming
        },
    })
}

fn merge_novel_category(
    current: Option<NovelCategoryRecord>,
    entity_id: &str,
    patch: &NovelCategoryPatch,
    client_lamport: i64,
) -> anyhow::Result<NovelCategoryRecord> {
    anyhow::ensure!(
        patch.category_id == entity_id,
        "novel category patch category_id must match entity_id"
    );
    let incoming = NovelCategoryRecord {
        category_id: entity_id.to_string(),
        name: patch.name.trim().to_string(),
        order: patch.order,
        record_lamport: client_lamport,
    };
    Ok(match current {
        None => incoming,
        Some(existing) => NovelCategoryRecord {
            record_lamport: next_lamport(existing.record_lamport, client_lamport),
            ..incoming
        },
    })
}

fn merge_novel_category_assignment(
    current: Option<NovelCategoryAssignmentRecord>,
    entity_id: &str,
    patch: &NovelCategoryAssignmentPatch,
    client_lamport: i64,
) -> anyhow::Result<NovelCategoryAssignmentRecord> {
    anyhow::ensure!(
        patch.assignment_id == entity_id,
        "novel category assignment patch assignment_id must match entity_id"
    );
    let incoming = NovelCategoryAssignmentRecord {
        assignment_id: entity_id.to_string(),
        novel_id: patch.novel_id.clone(),
        category_id: patch.category_id.clone(),
        record_lamport: client_lamport,
    };
    Ok(match current {
        None => incoming,
        Some(existing) => NovelCategoryAssignmentRecord {
            record_lamport: next_lamport(existing.record_lamport, client_lamport),
            ..incoming
        },
    })
}

fn merge_book_progress(
    current: Option<BookProgressRecord>,
    entity_id: &str,
    patch: &BookProgressPatch,
    client_lamport: i64,
    causal_event: bool,
) -> anyhow::Result<BookProgressRecord> {
    let book_id = normalize_book_progress_book_id(entity_id);
    let renderer = normalize_book_renderer(
        patch.renderer.as_deref().or_else(|| {
            current
                .as_ref()
                .and_then(|record| record.renderer.as_deref())
        }),
        patch.location.as_deref(),
        patch.href.as_deref(),
        patch.page_index,
    )?;
    let incoming = BookProgressRecord {
        book_id,
        renderer,
        location: normalize_optional_string(patch.location.as_deref()),
        href: normalize_optional_string(patch.href.as_deref()),
        progress_percent: patch.progress_percent,
        last_read_at_ms: patch.last_read_at_ms,
        page_index: patch.page_index,
        total_pages: patch.total_pages,
        section_label: normalize_optional_string(patch.section_label.as_deref()),
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => {
            let applied_lamport = next_lamport(existing.record_lamport, client_lamport);
            let winner = if patch.reset || causal_event {
                incoming
            } else {
                match effective_book_renderer(&existing, &incoming) {
                    Some("pdf") => pick_book_pdf_progress(existing, incoming),
                    _ => pick_book_epub_progress(existing, incoming),
                }
            };
            BookProgressRecord {
                record_lamport: applied_lamport,
                ..winner
            }
        }
    })
}

fn merge_novel_progress(
    current: Option<NovelProgressRecord>,
    entity_id: &str,
    patch: &NovelProgressPatch,
    client_lamport: i64,
    causal_event: bool,
) -> anyhow::Result<NovelProgressRecord> {
    let novel_id = entity_id
        .strip_prefix("novel.progress::")
        .unwrap_or(entity_id)
        .to_string();
    let incoming = NovelProgressRecord {
        novel_id,
        chapter_id: normalize_optional_string(patch.chapter_id.as_deref()),
        portable_work_ref: patch.portable_work_ref.clone(),
        portable_chapter_ref: patch.portable_chapter_ref.clone(),
        chapter_title: normalize_optional_string(patch.chapter_title.as_deref()),
        chapter_order_key: patch.chapter_order_key,
        progress_percent: patch.progress_percent,
        locator: normalize_optional_string(patch.locator.as_deref()),
        locator_sort_key: patch.locator_sort_key,
        updated_at_ms: patch.updated_at_ms,
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => {
            let applied_lamport = next_lamport(existing.record_lamport, client_lamport);
            let winner = if patch.reset || causal_event {
                incoming
            } else {
                pick_novel_progress(existing, incoming)
            };
            NovelProgressRecord {
                record_lamport: applied_lamport,
                ..winner
            }
        }
    })
}

fn normalize_book_progress_book_id(value: &str) -> String {
    let mut normalized = value;
    while let Some(book_id) = normalized.strip_prefix("book.progress::") {
        normalized = book_id;
    }
    for (legacy_prefix, canonical_prefix) in [("epub-", "epub:sha256:"), ("pdf-", "pdf:sha256:")] {
        if let Some(fingerprint) = normalized.strip_prefix(legacy_prefix) {
            if fingerprint.len() == 64 && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return format!("{canonical_prefix}{}", fingerprint.to_ascii_lowercase());
            }
        }
    }
    normalized.to_string()
}

fn merge_book_bookmark(
    current: Option<BookBookmarkRecord>,
    entity_id: &str,
    patch: &BookBookmarkPatch,
    client_lamport: i64,
) -> anyhow::Result<BookBookmarkRecord> {
    let created_at_ms = patch.effective_created_at_ms();
    let updated_at_ms = patch.effective_updated_at_ms();
    let incoming = BookBookmarkRecord {
        bookmark_id: entity_id.to_string(),
        book_id: patch.book_id.clone(),
        location: normalize_optional_string(patch.location.as_deref()),
        href: normalize_optional_string(patch.href.as_deref()),
        page_index: patch.page_index,
        progress_percent: patch.progress_percent,
        label: normalize_optional_string(patch.label.as_deref()),
        note: normalize_optional_string(patch.note.as_deref()),
        created_at_ms,
        updated_at_ms,
        saved_at_ms: patch.saved_at_ms,
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => {
            let applied_lamport = next_lamport(existing.record_lamport, client_lamport);
            let winner = pick_book_bookmark(existing, incoming);
            BookBookmarkRecord {
                record_lamport: applied_lamport,
                ..winner
            }
        }
    })
}

fn merge_novel_bookmark(
    current: Option<NovelBookmarkRecord>,
    entity_id: &str,
    patch: &NovelBookmarkPatch,
    client_lamport: i64,
) -> anyhow::Result<NovelBookmarkRecord> {
    let incoming = NovelBookmarkRecord {
        bookmark_id: entity_id.to_string(),
        novel_id: patch.novel_id.clone(),
        chapter_id: normalize_optional_string(patch.chapter_id.as_deref()),
        chapter_title: normalize_optional_string(patch.chapter_title.as_deref()),
        chapter_order_key: patch.chapter_order_key,
        locator: normalize_optional_string(patch.locator.as_deref()),
        locator_sort_key: patch.locator_sort_key,
        label: normalize_optional_string(patch.label.as_deref()),
        saved_at_ms: patch.saved_at_ms,
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => {
            let applied_lamport = next_lamport(existing.record_lamport, client_lamport);
            let winner = pick_novel_bookmark(existing, incoming);
            NovelBookmarkRecord {
                record_lamport: applied_lamport,
                ..winner
            }
        }
    })
}

fn merge_book_highlight(
    current: Option<BookHighlightRecord>,
    entity_id: &str,
    patch: &BookHighlightPatch,
    client_lamport: i64,
) -> anyhow::Result<BookHighlightRecord> {
    anyhow::ensure!(
        patch.highlight_id == entity_id,
        "book highlight patch highlight_id must match entity_id"
    );
    if let Some(existing) = current.as_ref() {
        anyhow::ensure!(
            existing.book_id == patch.book_id,
            "book highlight parent book_id is immutable"
        );
    }
    let incoming = BookHighlightRecord {
        highlight_id: entity_id.to_string(),
        book_id: patch.book_id.clone(),
        start_locator_json: patch.start_locator_json.clone(),
        end_locator_json: patch.end_locator_json.clone(),
        selected_text: patch.selected_text.clone(),
        color_argb: patch.color_argb,
        note: normalize_optional_string(patch.note.as_deref()),
        created_at_ms: patch.created_at_ms,
        updated_at_ms: patch.updated_at_ms,
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => {
            let applied_lamport = next_lamport(existing.record_lamport, client_lamport);
            let winner = if existing.updated_at_ms >= incoming.updated_at_ms {
                existing
            } else {
                incoming
            };
            BookHighlightRecord {
                record_lamport: applied_lamport,
                ..winner
            }
        }
    })
}

fn merge_book_history(
    current: Option<BookHistoryRecord>,
    entity_id: &str,
    patch: &BookHistoryPatch,
    client_lamport: i64,
) -> anyhow::Result<BookHistoryRecord> {
    anyhow::ensure!(
        patch.history_id == entity_id,
        "book history patch history_id must match entity_id"
    );
    let incoming = BookHistoryRecord {
        history_id: entity_id.to_string(),
        book_id: patch.book_id.clone(),
        renderer: normalize_book_renderer(
            patch.renderer.as_deref(),
            patch.location.as_deref(),
            patch.href.as_deref(),
            patch.page_index,
        )?,
        location: normalize_optional_string(patch.location.as_deref()),
        href: normalize_optional_string(patch.href.as_deref()),
        page_index: patch.page_index,
        progress_percent: patch.progress_percent,
        section_label: normalize_optional_string(patch.section_label.as_deref()),
        read_at_ms: patch.read_at_ms,
        record_lamport: client_lamport,
    };

    Ok(match current {
        None => incoming,
        Some(existing) => {
            anyhow::ensure!(
                existing.book_id == incoming.book_id,
                "book history entries cannot move between books"
            );
            BookHistoryRecord {
                record_lamport: next_lamport(existing.record_lamport, client_lamport),
                ..incoming
            }
        }
    })
}

fn merge_comic_history(
    current: Option<ComicHistoryRecord>,
    entity_id: &str,
    patch: &ComicHistoryPatch,
    client_lamport: i64,
) -> anyhow::Result<ComicHistoryRecord> {
    anyhow::ensure!(
        patch.history_id == entity_id,
        "comic history patch history_id must match entity_id"
    );
    if let Some(existing) = current.as_ref() {
        anyhow::ensure!(
            existing.comic_id == patch.comic_id,
            "comic history parent comic_id is immutable"
        );
    }
    let applied_lamport = current
        .as_ref()
        .map(|existing| next_lamport(existing.record_lamport, client_lamport))
        .unwrap_or(client_lamport);
    Ok(ComicHistoryRecord {
        history_id: entity_id.to_string(),
        comic_id: patch.comic_id.clone(),
        chapter_id: patch.chapter_id.clone(),
        portable_work_ref: patch.portable_work_ref.clone(),
        portable_chapter_ref: patch.portable_chapter_ref.clone(),
        page_index: patch.page_index,
        page_count: patch.page_count,
        progress_percent: patch.progress_percent,
        read_at_ms: patch.read_at_ms,
        record_lamport: applied_lamport,
    })
}

fn merge_comic_page_bookmark(
    current: Option<ComicPageBookmarkRecord>,
    entity_id: &str,
    patch: &ComicPageBookmarkPatch,
    client_lamport: i64,
) -> anyhow::Result<ComicPageBookmarkRecord> {
    anyhow::ensure!(
        patch.bookmark_id == entity_id,
        "comic page bookmark patch bookmark_id must match entity_id"
    );
    if let Some(existing) = current.as_ref() {
        anyhow::ensure!(
            existing.comic_id == patch.comic_id,
            "comic page bookmark parent comic_id is immutable"
        );
    }
    let applied_lamport = current
        .as_ref()
        .map(|existing| next_lamport(existing.record_lamport, client_lamport))
        .unwrap_or(client_lamport);
    Ok(ComicPageBookmarkRecord {
        bookmark_id: entity_id.to_string(),
        comic_id: patch.comic_id.clone(),
        chapter_id: patch.chapter_id.clone(),
        portable_work_ref: patch.portable_work_ref.clone(),
        portable_chapter_ref: patch.portable_chapter_ref.clone(),
        page_index: patch.page_index,
        page_count: patch.page_count,
        label: normalize_optional_string(patch.label.as_deref()),
        saved_at_ms: patch.saved_at_ms,
        record_lamport: applied_lamport,
    })
}

fn pick_book_pdf_progress(
    existing: BookProgressRecord,
    incoming: BookProgressRecord,
) -> BookProgressRecord {
    match compare_pdf_progress(&existing, &incoming) {
        Ordering::Greater | Ordering::Equal => existing,
        Ordering::Less => incoming,
    }
}

fn pick_book_epub_progress(
    existing: BookProgressRecord,
    incoming: BookProgressRecord,
) -> BookProgressRecord {
    match compare_epub_progress(&existing, &incoming) {
        Ordering::Greater | Ordering::Equal => existing,
        Ordering::Less => incoming,
    }
}

fn pick_novel_progress(
    existing: NovelProgressRecord,
    incoming: NovelProgressRecord,
) -> NovelProgressRecord {
    match compare_novel_progress(&existing, &incoming) {
        Ordering::Greater | Ordering::Equal => existing,
        Ordering::Less => incoming,
    }
}

fn pick_book_bookmark(
    existing: BookBookmarkRecord,
    incoming: BookBookmarkRecord,
) -> BookBookmarkRecord {
    match compare_book_bookmark(&existing, &incoming) {
        Ordering::Greater | Ordering::Equal => existing,
        Ordering::Less => incoming,
    }
}

fn pick_novel_bookmark(
    existing: NovelBookmarkRecord,
    incoming: NovelBookmarkRecord,
) -> NovelBookmarkRecord {
    match compare_novel_bookmark(&existing, &incoming) {
        Ordering::Greater | Ordering::Equal => existing,
        Ordering::Less => incoming,
    }
}

fn compare_pdf_progress(left: &BookProgressRecord, right: &BookProgressRecord) -> Ordering {
    compare_option_i64(left.page_index, right.page_index)
        .then(compare_f64(left.progress_percent, right.progress_percent))
        .then(left.last_read_at_ms.cmp(&right.last_read_at_ms))
        .then(left.record_lamport.cmp(&right.record_lamport))
}

fn compare_epub_progress(left: &BookProgressRecord, right: &BookProgressRecord) -> Ordering {
    book_locator_precision(left)
        .cmp(&book_locator_precision(right))
        .then(compare_f64(left.progress_percent, right.progress_percent))
        .then(left.last_read_at_ms.cmp(&right.last_read_at_ms))
        .then(left.record_lamport.cmp(&right.record_lamport))
}

fn compare_novel_progress(left: &NovelProgressRecord, right: &NovelProgressRecord) -> Ordering {
    compare_option_f64(left.chapter_order_key, right.chapter_order_key)
        .then(compare_option_f64(
            left.locator_sort_key,
            right.locator_sort_key,
        ))
        .then(compare_f64(left.progress_percent, right.progress_percent))
        .then(left.updated_at_ms.cmp(&right.updated_at_ms))
        .then(left.record_lamport.cmp(&right.record_lamport))
}

fn compare_book_bookmark(left: &BookBookmarkRecord, right: &BookBookmarkRecord) -> Ordering {
    left.updated_at_ms
        .cmp(&right.updated_at_ms)
        .then(book_bookmark_strength(left).cmp(&book_bookmark_strength(right)))
        .then(left.saved_at_ms.cmp(&right.saved_at_ms))
        .then(compare_f64(left.progress_percent, right.progress_percent))
        .then(left.record_lamport.cmp(&right.record_lamport))
}

fn compare_novel_bookmark(left: &NovelBookmarkRecord, right: &NovelBookmarkRecord) -> Ordering {
    compare_option_f64(left.chapter_order_key, right.chapter_order_key)
        .then(compare_option_f64(
            left.locator_sort_key,
            right.locator_sort_key,
        ))
        .then(left.saved_at_ms.cmp(&right.saved_at_ms))
        .then(left.record_lamport.cmp(&right.record_lamport))
}

fn effective_book_renderer<'a>(
    existing: &'a BookProgressRecord,
    incoming: &'a BookProgressRecord,
) -> Option<&'a str> {
    incoming
        .renderer
        .as_deref()
        .or(existing.renderer.as_deref())
        .or_else(|| {
            if incoming.page_index.is_some() || existing.page_index.is_some() {
                Some("pdf")
            } else {
                None
            }
        })
}

fn normalize_book_renderer(
    renderer: Option<&str>,
    location: Option<&str>,
    href: Option<&str>,
    page_index: Option<i64>,
) -> anyhow::Result<Option<String>> {
    match renderer.map(str::trim).filter(|value| !value.is_empty()) {
        Some("epub") => Ok(Some("epub".to_string())),
        Some("pdf") => Ok(Some("pdf".to_string())),
        Some(other) => bail!("invalid book renderer '{other}'"),
        None => {
            if page_index.is_some() {
                Ok(Some("pdf".to_string()))
            } else if location.is_some() || href.is_some() {
                Ok(Some("epub".to_string()))
            } else {
                Ok(None)
            }
        }
    }
}

fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn book_locator_precision(record: &BookProgressRecord) -> u8 {
    if record.location.is_some() {
        2
    } else if record.href.is_some() {
        1
    } else {
        0
    }
}

fn book_bookmark_strength(record: &BookBookmarkRecord) -> u8 {
    if record.location.is_some() {
        3
    } else if record.page_index.is_some() {
        2
    } else if record.href.is_some() {
        1
    } else {
        0
    }
}

fn compare_option_i64(left: Option<i64>, right: Option<i64>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => Ordering::Equal,
    }
}

fn compare_option_f64(left: Option<f64>, right: Option<f64>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => compare_f64(left, right),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => Ordering::Equal,
    }
}

fn compare_f64(left: f64, right: f64) -> Ordering {
    left.partial_cmp(&right).unwrap_or(Ordering::Equal)
}

fn next_lamport(current_lamport: i64, incoming_lamport: i64) -> i64 {
    current_lamport.max(incoming_lamport) + 1
}

fn hash_token(raw_token: &str) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(raw_token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
pub async fn ensure_test_token(
    pool: &sqlx::SqlitePool,
    device_id: &str,
    profile_id: &str,
    token_hash: &str,
    scopes: &[&str],
) -> anyhow::Result<()> {
    ensure_token_with_hash(pool, device_id, profile_id, token_hash, scopes).await
}

pub async fn ensure_token_with_hash(
    pool: &sqlx::SqlitePool,
    device_id: &str,
    profile_id: &str,
    token_hash: &str,
    scopes: &[&str],
) -> anyhow::Result<()> {
    let now_ms = now_ms();
    let token_id = format!("token-{device_id}-{profile_id}");
    sqlx::query(
        r#"
        INSERT OR REPLACE INTO trusted_devices (
            device_id, trusted_host_id, device_name, platform, first_trusted_at_ms, last_seen_at_ms, revoked_at_ms
        ) VALUES (?, 'test-host', 'Test Device', 'android', ?, ?, NULL)
        "#,
    )
    .bind(device_id)
    .bind(now_ms)
    .bind(now_ms)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR REPLACE INTO paired_device_tokens (
            token_id,
            device_id,
            profile_id,
            token_hash,
            issued_at_ms,
            last_seen_at_ms,
            inactivity_expires_at_ms,
            revoked_at_ms,
            granted_via
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'qr')
        "#,
    )
    .bind(&token_id)
    .bind(device_id)
    .bind(profile_id)
    .bind(token_hash)
    .bind(now_ms)
    .bind(now_ms)
    .bind(now_ms + 30 * 24 * 60 * 60 * 1000_i64)
    .execute(pool)
    .await?;

    sqlx::query("DELETE FROM paired_device_scopes WHERE token_id = ?")
        .bind(&token_id)
        .execute(pool)
        .await?;

    for scope in scopes {
        sqlx::query("INSERT INTO paired_device_scopes (token_id, scope_id) VALUES (?, ?)")
            .bind(&token_id)
            .bind(scope)
            .execute(pool)
            .await?;
    }

    Ok(())
}

pub async fn grant_comics_scopes_to_existing_tokens(
    pool: &sqlx::SqlitePool,
) -> anyhow::Result<u64> {
    let result = sqlx::query(
        r#"
        INSERT OR IGNORE INTO paired_device_scopes (token_id, scope_id)
        SELECT token_id, 'comics:profile:' || profile_id
        FROM paired_device_tokens
        WHERE revoked_at_ms IS NULL
        "#,
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn issue_local_authority_token(
    pool: &sqlx::SqlitePool,
    config: &SyncdConfig,
    device_id: &str,
    profile_id: &str,
) -> anyhow::Result<IssuedPairingToken> {
    let now_ms = now_ms();
    let inactivity_expires_at_ms = now_ms + config.token_inactivity_window.as_millis() as i64;
    let token_id = format!("local-authority-{device_id}-{profile_id}");
    // Local authority tokens keep their legacy prefix for persisted clients.
    let access_token = format!("aethon_local_{}", Uuid::now_v7());
    let token_hash = hash_token(&access_token);
    let trusted_host_id = "syncd-local-authority";
    let scopes = vec![
        "books:global".to_string(),
        format!("novels:profile:{profile_id}"),
        format!("comics:profile:{profile_id}"),
    ];

    let mut tx = begin_write(pool).await?;

    sqlx::query(
        r#"
        INSERT INTO trusted_devices (
            device_id,
            trusted_host_id,
            device_name,
            platform,
            first_trusted_at_ms,
            last_seen_at_ms,
            revoked_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(device_id) DO UPDATE SET
            trusted_host_id = excluded.trusted_host_id,
            device_name = excluded.device_name,
            platform = excluded.platform,
            last_seen_at_ms = excluded.last_seen_at_ms,
            revoked_at_ms = NULL
        "#,
    )
    .bind(device_id)
    .bind(trusted_host_id)
    .bind("Epigraph local authority")
    .bind(PairingPlatform::Desktop.as_str())
    .bind(now_ms)
    .bind(now_ms)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO paired_device_tokens (
            token_id,
            device_id,
            profile_id,
            token_hash,
            issued_at_ms,
            last_seen_at_ms,
            inactivity_expires_at_ms,
            revoked_at_ms,
            granted_via
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(token_id) DO UPDATE SET
            device_id = excluded.device_id,
            profile_id = excluded.profile_id,
            token_hash = excluded.token_hash,
            issued_at_ms = excluded.issued_at_ms,
            last_seen_at_ms = excluded.last_seen_at_ms,
            inactivity_expires_at_ms = excluded.inactivity_expires_at_ms,
            revoked_at_ms = NULL,
            granted_via = excluded.granted_via
        "#,
    )
    .bind(&token_id)
    .bind(device_id)
    .bind(profile_id)
    .bind(token_hash)
    .bind(now_ms)
    .bind(now_ms)
    .bind(inactivity_expires_at_ms)
    .bind(PairingGrantVia::LocalAuthority.as_str())
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM paired_device_scopes WHERE token_id = ?")
        .bind(&token_id)
        .execute(&mut *tx)
        .await?;

    for scope in &scopes {
        sqlx::query("INSERT INTO paired_device_scopes (token_id, scope_id) VALUES (?, ?)")
            .bind(&token_id)
            .bind(scope)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    Ok(IssuedPairingToken {
        access_token,
        token_id,
        profile_id: profile_id.to_string(),
        scopes,
        inactivity_expires_at_ms,
        granted_via: PairingGrantVia::LocalAuthority,
    })
}

pub async fn revoke_token(pool: &sqlx::SqlitePool, token_hash: &str) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        UPDATE paired_device_tokens
        SET revoked_at_ms = ?
        WHERE token_hash = ?
        "#,
    )
    .bind(now_ms())
    .bind(token_hash)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn expire_token_now(pool: &sqlx::SqlitePool, token_hash: &str) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        UPDATE paired_device_tokens
        SET inactivity_expires_at_ms = ?, last_seen_at_ms = ?
        WHERE token_hash = ?
        "#,
    )
    .bind(now_ms() - 1)
    .bind(now_ms() - 1)
    .bind(token_hash)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_token_state(
    pool: &sqlx::SqlitePool,
    token_hash: &str,
) -> anyhow::Result<Option<TokenStateRow>> {
    let row = sqlx::query_as::<_, TokenStateRow>(
        r#"
        SELECT token_id, device_id, profile_id, last_seen_at_ms, inactivity_expires_at_ms, revoked_at_ms
        FROM paired_device_tokens
        WHERE token_hash = ?
        "#,
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Returns the scopes a token still grants, or `None` when the token is unknown, revoked or
/// past its inactivity window. Long-lived streams use this to stop delivering data after the
/// host revokes a device or narrows its scopes.
pub async fn load_active_token_scopes(
    pool: &sqlx::SqlitePool,
    token_id: &str,
    now_ms: i64,
) -> anyhow::Result<Option<std::collections::BTreeSet<String>>> {
    let row: Option<(i64, Option<i64>)> = sqlx::query_as(
        r#"
        SELECT inactivity_expires_at_ms, revoked_at_ms
        FROM paired_device_tokens
        WHERE token_id = ?
        "#,
    )
    .bind(token_id)
    .fetch_optional(pool)
    .await?;
    let Some((inactivity_expires_at_ms, revoked_at_ms)) = row else {
        return Ok(None);
    };
    if revoked_at_ms.is_some() || inactivity_expires_at_ms < now_ms {
        return Ok(None);
    }
    let scopes = sqlx::query_scalar::<_, String>(
        "SELECT scope_id FROM paired_device_scopes WHERE token_id = ?",
    )
    .bind(token_id)
    .fetch_all(pool)
    .await?;
    Ok(Some(scopes.into_iter().collect()))
}

/// An open live stream is device activity even when the device sends no other request. Extends
/// the inactivity window of a still-active token once less than half of it remains, so a listening
/// device is not signed out while connected and the write happens rarely.
pub async fn extend_streaming_token_activity(
    pool: &sqlx::SqlitePool,
    token_id: &str,
    now_ms: i64,
    window_ms: i64,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        UPDATE paired_device_tokens
        SET last_seen_at_ms = ?, inactivity_expires_at_ms = ?
        WHERE token_id = ?
          AND revoked_at_ms IS NULL
          AND inactivity_expires_at_ms >= ?
          AND inactivity_expires_at_ms < ?
        "#,
    )
    .bind(now_ms)
    .bind(now_ms + window_ms)
    .bind(token_id)
    .bind(now_ms)
    .bind(now_ms + window_ms / 2)
    .execute(pool)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert_portable_work_binding(
    pool: &sqlx::SqlitePool,
    profile_id: &str,
    portable_id: &str,
    reference: &PortableWorkRefV3,
    dependency_key: Option<&str>,
    local_reference: Option<&str>,
    state: PortableResolutionStateV3,
    reason: Option<PortableResolutionReasonV3>,
    title_hint: Option<&str>,
    provider_label_hint: Option<&str>,
    record_lamport: i64,
    updated_at_ms: i64,
) -> anyhow::Result<()> {
    reference
        .validate()
        .map_err(|error| anyhow::anyhow!(error))?;
    if canonical_portable_work_id(reference) != portable_id {
        bail!("portable work ID does not match its canonical reference");
    }
    validate_portable_persistence_input(profile_id, "profile ID")?;
    validate_portable_persistence_input(portable_id, "portable ID")?;
    if let Some(dependency_key) = dependency_key {
        validate_portable_persistence_input(dependency_key, "dependency key")?;
    }
    if let Some(local_reference) = local_reference {
        validate_portable_persistence_input(local_reference, "local reference")?;
    }
    if matches!(state, PortableResolutionStateV3::Bound) && local_reference.is_none() {
        bail!("bound portable work requires a local reference");
    }
    if record_lamport < 0 || updated_at_ms < 0 {
        bail!("portable binding clocks must not be negative");
    }
    for (hint, label) in [
        (title_hint, "title hint"),
        (provider_label_hint, "provider label hint"),
    ] {
        if let Some(hint) = hint {
            validate_portable_hint(hint, label)?;
        }
    }
    let (ecosystem, source_id, plugin_id, provider_key) = match reference {
        PortableWorkRefV3::Comic {
            source_id,
            manga_key,
        } => (
            "SUWAYOMI",
            Some(source_id.as_str()),
            None,
            manga_key.as_str(),
        ),
        PortableWorkRefV3::Novel {
            plugin_id,
            novel_key,
        } => (
            "LNREADER",
            None,
            Some(plugin_id.as_str()),
            novel_key.as_str(),
        ),
    };

    sqlx::query(
        r#"
        INSERT INTO portable_work_bindings (
          profile_id, portable_id, ecosystem, source_id, plugin_id, provider_key,
          dependency_key, local_reference, resolution_state, resolution_reason, title_hint, provider_label_hint,
          record_lamport, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, portable_id) DO UPDATE SET
          dependency_key = COALESCE(excluded.dependency_key, portable_work_bindings.dependency_key),
          local_reference = COALESCE(excluded.local_reference, portable_work_bindings.local_reference),
          resolution_state = excluded.resolution_state,
          resolution_reason = excluded.resolution_reason,
          title_hint = COALESCE(excluded.title_hint, portable_work_bindings.title_hint),
          provider_label_hint = COALESCE(excluded.provider_label_hint, portable_work_bindings.provider_label_hint),
          record_lamport = excluded.record_lamport,
          updated_at_ms = excluded.updated_at_ms
        WHERE excluded.record_lamport >= portable_work_bindings.record_lamport
        "#,
    )
    .bind(profile_id)
    .bind(portable_id)
    .bind(ecosystem)
    .bind(source_id)
    .bind(plugin_id)
    .bind(provider_key)
    .bind(dependency_key)
    .bind(local_reference)
    .bind(portable_resolution_state_wire(state))
    .bind(reason.map(portable_resolution_reason_wire))
    .bind(title_hint)
    .bind(provider_label_hint)
    .bind(record_lamport)
    .bind(updated_at_ms)
    .execute(pool)
    .await?;
    if matches!(state, PortableResolutionStateV3::Bound) {
        if let PortableWorkRefV3::Comic { source_id, manga_key } = reference {
            requeue_unfound_comic_projections(pool, profile_id, source_id.as_str(), manga_key.as_str())
                .await?;
        }
        requeue_blocked_portable_projections(pool, profile_id).await?;
    }
    Ok(())
}

pub async fn load_portable_work_binding(
    pool: &sqlx::SqlitePool,
    profile_id: &str,
    portable_id: &str,
) -> anyhow::Result<Option<PortableWorkBindingRow>> {
    Ok(sqlx::query_as::<_, PortableWorkBindingRow>(
        "SELECT * FROM portable_work_bindings WHERE profile_id = ? AND portable_id = ?",
    )
    .bind(profile_id)
    .bind(portable_id)
    .fetch_optional(pool)
    .await?)
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert_portable_chapter_binding(
    pool: &sqlx::SqlitePool,
    profile_id: &str,
    portable_chapter_id: &str,
    portable_work_id: &str,
    provider_key: &str,
    local_reference: Option<&str>,
    state: PortableResolutionStateV3,
    reason: Option<PortableResolutionReasonV3>,
    record_lamport: i64,
    updated_at_ms: i64,
) -> anyhow::Result<()> {
    validate_portable_persistence_input(profile_id, "profile ID")?;
    validate_portable_persistence_input(portable_chapter_id, "portable chapter ID")?;
    validate_portable_persistence_input(portable_work_id, "portable work ID")?;
    if provider_key.is_empty()
        || provider_key.len() > 4096
        || provider_key.chars().any(char::is_control)
    {
        bail!("portable chapter provider key is invalid");
    }
    if let Some(local_reference) = local_reference {
        validate_portable_persistence_input(local_reference, "local chapter reference")?;
    }
    if matches!(state, PortableResolutionStateV3::Bound) && local_reference.is_none() {
        bail!("bound portable chapter requires a local reference");
    }
    if record_lamport < 0 || updated_at_ms < 0 {
        bail!("portable chapter clocks must not be negative");
    }

    let work = load_portable_work_binding(pool, profile_id, portable_work_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("portable work binding does not exist"))?;
    let work_reference = work
        .portable_ref()
        .map_err(|error| anyhow::anyhow!(error))?;
    if canonical_portable_work_id(&work_reference) != portable_work_id {
        bail!("portable work binding is not canonical");
    }
    let chapter_reference = match work_reference {
        PortableWorkRefV3::Comic { .. } => PortableChapterRefV3::Comic {
            work: work_reference,
            chapter_key: provider_key.to_string(),
        },
        PortableWorkRefV3::Novel { .. } => PortableChapterRefV3::Novel {
            work: work_reference,
            chapter_key: provider_key.to_string(),
        },
    };
    chapter_reference
        .validate()
        .map_err(|error| anyhow::anyhow!(error))?;
    if canonical_portable_chapter_id(&chapter_reference) != portable_chapter_id {
        bail!("portable chapter ID does not match its canonical reference");
    }

    sqlx::query(
        r#"
        INSERT INTO portable_chapter_bindings (
          profile_id, portable_chapter_id, portable_work_id, provider_key, local_reference,
          resolution_state, resolution_reason, record_lamport, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, portable_chapter_id) DO UPDATE SET
          local_reference = COALESCE(excluded.local_reference, portable_chapter_bindings.local_reference),
          resolution_state = excluded.resolution_state,
          resolution_reason = excluded.resolution_reason,
          record_lamport = excluded.record_lamport,
          updated_at_ms = excluded.updated_at_ms
        WHERE excluded.record_lamport >= portable_chapter_bindings.record_lamport
        "#,
    )
    .bind(profile_id)
    .bind(portable_chapter_id)
    .bind(portable_work_id)
    .bind(provider_key)
    .bind(local_reference)
    .bind(portable_resolution_state_wire(state))
    .bind(reason.map(portable_resolution_reason_wire))
    .bind(record_lamport)
    .bind(updated_at_ms)
    .execute(pool)
    .await?;
    if matches!(state, PortableResolutionStateV3::Bound) {
        requeue_blocked_portable_projections(pool, profile_id).await?;
    }
    Ok(())
}

/// Gives the projections of a comic that gave up waiting for it (`portable_work_not_found`) a new
/// bounded cycle once it is bound, for example after the import pass brought it in. Otherwise the
/// progress a device sent before the work existed here would wait for the next daemon start.
async fn requeue_unfound_comic_projections(
    pool: &sqlx::SqlitePool,
    profile_id: &str,
    source_id: &str,
    manga_key: &str,
) -> anyhow::Result<()> {
    let now = now_ms();
    sqlx::query(
        r#"
        UPDATE suwayomi_projection_outbox
        SET status = 'retry', attempt_count = 0, next_attempt_at_ms = ?, lease_until_ms = NULL,
            last_error = 'portable_binding_updated', updated_at_ms = ?
        WHERE profile_id = ? AND status IN ('blocked', 'retry')
          AND last_error = 'portable_work_not_found'
          AND json_valid(variables_json)
          AND json_extract(variables_json, '$.portableWorkRef.sourceId') = ?
          AND json_extract(variables_json, '$.portableWorkRef.mangaKey') = ?
        "#,
    )
    .bind(now)
    .bind(now)
    .bind(profile_id)
    .bind(source_id)
    .bind(manga_key)
    .execute(pool)
    .await?;
    Ok(())
}

async fn requeue_blocked_portable_projections(
    pool: &sqlx::SqlitePool,
    profile_id: &str,
) -> anyhow::Result<()> {
    let now = now_ms();
    sqlx::query(
        r#"
        UPDATE suwayomi_projection_outbox
        SET status = 'retry', next_attempt_at_ms = ?, lease_until_ms = NULL,
            last_error = 'portable_binding_updated', updated_at_ms = ?
        WHERE profile_id = ? AND status = 'blocked'
          AND last_error IN (
            'portable_work_not_bound', 'portable_work_binding_mismatch',
            'portable_chapter_not_resolved', 'portable_binding_unavailable'
          )
        "#,
    )
    .bind(now)
    .bind(now)
    .bind(profile_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_portable_chapter_binding(
    pool: &sqlx::SqlitePool,
    profile_id: &str,
    portable_chapter_id: &str,
) -> anyhow::Result<Option<PortableChapterBindingRow>> {
    Ok(sqlx::query_as::<_, PortableChapterBindingRow>(
        "SELECT * FROM portable_chapter_bindings WHERE profile_id = ? AND portable_chapter_id = ?",
    )
    .bind(profile_id)
    .bind(portable_chapter_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn list_portable_chapter_bindings(
    pool: &sqlx::SqlitePool,
    profile_id: &str,
    portable_work_id: &str,
) -> anyhow::Result<Vec<PortableChapterBindingRow>> {
    Ok(sqlx::query_as::<_, PortableChapterBindingRow>(
        r#"
        SELECT * FROM portable_chapter_bindings
        WHERE profile_id = ? AND portable_work_id = ?
        ORDER BY updated_at_ms, portable_chapter_id
        "#,
    )
    .bind(profile_id)
    .bind(portable_work_id)
    .fetch_all(pool)
    .await?)
}

fn validate_portable_persistence_input(value: &str, label: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value != value.trim()
        || value.len() > 512
        || value.chars().any(char::is_control)
    {
        bail!("{label} is invalid");
    }
    Ok(())
}

fn validate_portable_hint(value: &str, label: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value != value.trim()
        || value.len() > 512
        || value.chars().any(char::is_control)
    {
        bail!("{label} is invalid");
    }
    Ok(())
}

fn portable_resolution_state_wire(state: PortableResolutionStateV3) -> &'static str {
    match state {
        PortableResolutionStateV3::PendingDependency => "PENDING_DEPENDENCY",
        PortableResolutionStateV3::PendingProvider => "PENDING_PROVIDER",
        PortableResolutionStateV3::Resolving => "RESOLVING",
        PortableResolutionStateV3::Ready => "READY",
        PortableResolutionStateV3::Bound => "BOUND",
        PortableResolutionStateV3::RetryableFailure => "RETRYABLE_FAILURE",
        PortableResolutionStateV3::RequiresUserAction => "REQUIRES_USER_ACTION",
        PortableResolutionStateV3::LegacyUnbound => "LEGACY_UNBOUND",
        PortableResolutionStateV3::Conflict => "CONFLICT",
    }
}

fn portable_resolution_reason_wire(reason: PortableResolutionReasonV3) -> &'static str {
    match reason {
        PortableResolutionReasonV3::ExtensionNotFound => "EXTENSION_NOT_FOUND",
        PortableResolutionReasonV3::ExtensionStoreMissing => "EXTENSION_STORE_MISSING",
        PortableResolutionReasonV3::ExtensionStoreApprovalRequired => {
            "EXTENSION_STORE_APPROVAL_REQUIRED"
        }
        PortableResolutionReasonV3::ExtensionNotLoaded => "EXTENSION_NOT_LOADED",
        PortableResolutionReasonV3::PluginNotFound => "PLUGIN_NOT_FOUND",
        PortableResolutionReasonV3::PluginRepositoryMissing => "PLUGIN_REPOSITORY_MISSING",
        PortableResolutionReasonV3::PluginRepositoryApprovalRequired => {
            "PLUGIN_REPOSITORY_APPROVAL_REQUIRED"
        }
        PortableResolutionReasonV3::SourceNotFound => "SOURCE_NOT_FOUND",
        PortableResolutionReasonV3::SourceNotLoaded => "SOURCE_NOT_LOADED",
        PortableResolutionReasonV3::SourceOffline => "SOURCE_OFFLINE",
        PortableResolutionReasonV3::SourceAuthRequired => "SOURCE_AUTH_REQUIRED",
        PortableResolutionReasonV3::SourceConfigurationRequired => "SOURCE_CONFIGURATION_REQUIRED",
        PortableResolutionReasonV3::WorkNotFound => "WORK_NOT_FOUND",
        PortableResolutionReasonV3::WorkResolutionUnsupported => "WORK_RESOLUTION_UNSUPPORTED",
        PortableResolutionReasonV3::WorkResolutionFailed => "WORK_RESOLUTION_FAILED",
        PortableResolutionReasonV3::ChapterNotFound => "CHAPTER_NOT_FOUND",
        PortableResolutionReasonV3::ChapterResolutionFailed => "CHAPTER_RESOLUTION_FAILED",
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use tempfile::tempdir;

    #[tokio::test]
    async fn book_progress_id_migration_collapses_legacy_aliases_and_keeps_newest_record() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(":memory:")
                    .create_if_missing(true)
                    .foreign_keys(true),
            )
            .await
            .unwrap();

        for migration in MIGRATOR.iter().filter(|migration| migration.version < 23) {
            sqlx::raw_sql(migration.sql.as_ref())
                .execute(&pool)
                .await
                .unwrap();
        }
        for (book_id, progress, version) in [
            ("epub:sha256:fixture", 0.75_f64, 20_i64),
            ("book.progress::epub:sha256:fixture", 0.25_f64, 10_i64),
            ("book.progress::pdf:sha256:legacy-only", 0.5_f64, 30_i64),
        ] {
            sqlx::query(
                r#"INSERT INTO book_progress (
                    scope_id, book_id, renderer, location, href, progress_percent,
                    last_read_at_ms, page_index, total_pages, section_label,
                    record_updated_at_ms, record_updated_by_device_id,
                    record_lamport, record_server_version
                ) VALUES ('books:global', ?, 'epub', NULL, NULL, ?, 1, NULL, NULL,
                    NULL, ?, 'fixture-device', ?, ?)"#,
            )
            .bind(book_id)
            .bind(progress)
            .bind(version)
            .bind(version)
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
        }

        let migration = MIGRATOR
            .iter()
            .find(|migration| migration.version == 23)
            .unwrap();
        sqlx::raw_sql(migration.sql.as_ref())
            .execute(&pool)
            .await
            .unwrap();

        let rows: Vec<(String, f64, i64)> = sqlx::query_as(
            "SELECT book_id, progress_percent, record_server_version FROM book_progress ORDER BY book_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                ("epub:sha256:fixture".to_string(), 0.75, 20),
                ("pdf:sha256:legacy-only".to_string(), 0.5, 30),
            ]
        );
    }

    #[tokio::test]
    async fn hashed_book_id_migration_collapses_desktop_local_aliases() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(":memory:")
                    .create_if_missing(true)
                    .foreign_keys(true),
            )
            .await
            .unwrap();
        for migration in MIGRATOR.iter().filter(|migration| migration.version < 24) {
            sqlx::raw_sql(migration.sql.as_ref())
                .execute(&pool)
                .await
                .unwrap();
        }
        let fingerprint = "A".repeat(64);
        for (book_id, progress, version) in [
            (format!("pdf-{fingerprint}"), 0.25_f64, 10_i64),
            (
                format!("pdf:sha256:{}", fingerprint.to_ascii_lowercase()),
                0.75_f64,
                20_i64,
            ),
        ] {
            sqlx::query(
                r#"INSERT INTO book_progress (
                    scope_id, book_id, renderer, location, href, progress_percent,
                    last_read_at_ms, page_index, total_pages, section_label,
                    record_updated_at_ms, record_updated_by_device_id,
                    record_lamport, record_server_version
                ) VALUES ('books:global', ?, 'pdf', NULL, NULL, ?, 1, NULL, NULL,
                    NULL, ?, 'fixture-device', ?, ?)"#,
            )
            .bind(book_id)
            .bind(progress)
            .bind(version)
            .bind(version)
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
        }

        let migration = MIGRATOR
            .iter()
            .find(|migration| migration.version == 24)
            .unwrap();
        sqlx::raw_sql(migration.sql.as_ref())
            .execute(&pool)
            .await
            .unwrap();

        let row: (String, f64, i64) = sqlx::query_as(
            "SELECT book_id, progress_percent, record_server_version FROM book_progress",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            row,
            (
                format!("pdf:sha256:{}", fingerprint.to_ascii_lowercase()),
                0.75,
                20,
            )
        );
    }

    #[tokio::test]
    async fn novel_plugin_migration_preserves_v1_rows_without_publishing_them() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(":memory:")
                    .create_if_missing(true)
                    .foreign_keys(true),
            )
            .await
            .unwrap();

        for migration in MIGRATOR.iter().filter(|migration| migration.version < 12) {
            sqlx::raw_sql(migration.sql.as_ref())
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query(
            r#"INSERT INTO novel_repositories (
                scope_id, repository_id, url, canonical_url, name, equivalence_group,
                desired_state, record_updated_at_ms, record_updated_by_device_id,
                record_lamport, record_server_version
            ) VALUES (?, ?, ?, ?, ?, NULL, 'enabled', 1, 'legacy-device', 1, 1)"#,
        )
        .bind("novels:profile:main")
        .bind("legacy-repo")
        .bind("https://legacy.example/repo.json")
        .bind("https://legacy.example/repo.json")
        .bind("Legacy")
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO novel_plugins (
                scope_id, plugin_instance_id, plugin_id, repository_id, name, version,
                source_id, source_name, lang, desired_state, record_updated_at_ms,
                record_updated_by_device_id, record_lamport, record_server_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'enabled', 1, 'legacy-device', 1, 1)"#,
        )
        .bind("novels:profile:main")
        .bind("legacy-instance")
        .bind("legacy-plugin")
        .bind("legacy-repo")
        .bind("Legacy plugin")
        .bind("1.0.0")
        .bind("legacy-source")
        .bind("Legacy source")
        .bind("en")
        .execute(&pool)
        .await
        .unwrap();

        let migration = MIGRATOR
            .iter()
            .find(|migration| migration.version == 12)
            .unwrap();
        sqlx::raw_sql(migration.sql.as_ref())
            .execute(&pool)
            .await
            .unwrap();

        let archived_repositories: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM novel_repositories_v1_legacy")
                .fetch_one(&pool)
                .await
                .unwrap();
        let archived_plugins: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM novel_plugins_v1_legacy")
                .fetch_one(&pool)
                .await
                .unwrap();
        let active_repositories: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM novel_repositories")
                .fetch_one(&pool)
                .await
                .unwrap();
        let active_plugins: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM novel_plugins")
            .fetch_one(&pool)
            .await
            .unwrap();
        let active_artifact_versions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM novel_plugin_artifact_versions")
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(archived_repositories, 1);
        assert_eq!(archived_plugins, 1);
        assert_eq!(active_repositories, 0);
        assert_eq!(active_plugins, 0);
        assert_eq!(active_artifact_versions, 0);
    }

    #[tokio::test]
    async fn novel_category_migration_upgrades_v9_without_losing_changes() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(":memory:")
                    .create_if_missing(true)
                    .foreign_keys(true),
            )
            .await
            .unwrap();

        for migration in MIGRATOR.iter().filter(|migration| migration.version < 10) {
            sqlx::raw_sql(migration.sql.as_ref())
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query(
            r#"INSERT INTO change_log (
                scope_id, profile_id, entity_type, entity_id, op, lamport,
                changed_by_device_id, applied_at_ms, patch_json, replay_until_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind("novels:profile:main")
        .bind("main")
        .bind("novel.entry")
        .bind("novel-before-v10")
        .bind("merge")
        .bind(1_i64)
        .bind("device-main")
        .bind(1_i64)
        .bind(r#"{"novelId":"novel-before-v10"}"#)
        .bind(60_000_i64)
        .execute(&pool)
        .await
        .unwrap();

        let migration = MIGRATOR
            .iter()
            .find(|migration| migration.version == 10)
            .unwrap();
        sqlx::raw_sql(migration.sql.as_ref())
            .execute(&pool)
            .await
            .unwrap();

        let preserved: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM change_log WHERE entity_id = 'novel-before-v10'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let category_table: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'novel_categories'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let assignment_table: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'novel_category_assignments'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(preserved, 1);
        assert_eq!(category_table, 1);
        assert_eq!(assignment_table, 1);
    }

    use super::*;
    use crate::syncd::config::SyncdConfig;

    async fn record_checksum(pool: &sqlx::SqlitePool, version: i64, sql: &str) {
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
            .bind(sha2::Sha384::digest(sql.as_bytes()).to_vec())
            .bind(version)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn database_migrated_from_a_crlf_build_still_opens() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        let first = MIGRATOR.iter().next().unwrap();
        let crlf = first.sql.replace("\r\n", "\n").replace('\n', "\r\n");
        record_checksum(&pool, first.version, &crlf).await;
        pool.close().await;

        let pool = connect(&config).await.unwrap();

        let recorded: Vec<u8> =
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = ?")
                .bind(first.version)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(recorded.as_slice(), first.checksum.as_ref());
    }

    #[tokio::test]
    async fn edited_migration_is_still_rejected() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        let first = MIGRATOR.iter().next().unwrap();
        record_checksum(&pool, first.version, &format!("{}\n-- edited", first.sql)).await;
        pool.close().await;

        let error = connect(&config).await.unwrap_err();

        assert!(format!("{error:#}").contains("previously applied but has been modified"));
    }

    #[tokio::test]
    async fn portable_bindings_preserve_opaque_provider_keys() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        let reference = PortableWorkRefV3::Comic {
            source_id: "-10002".to_string(),
            manga_key: "/Manga/Keep-Case?chapter=AbC%2F123".to_string(),
        };
        let portable_id = canonical_portable_work_id(&reference);

        upsert_portable_work_binding(
            &pool,
            "main",
            &portable_id,
            &reference,
            Some("eu.kanade.tachiyomi.extension.en.fixture"),
            Some("42"),
            PortableResolutionStateV3::RequiresUserAction,
            Some(PortableResolutionReasonV3::ExtensionStoreApprovalRequired),
            Some("Display hint"),
            Some("Provider hint"),
            1,
            1,
        )
        .await
        .unwrap();

        let row = load_portable_work_binding(&pool, "main", &portable_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.portable_ref().unwrap(), reference);
        assert_eq!(
            row.dependency_key.as_deref(),
            Some("eu.kanade.tachiyomi.extension.en.fixture")
        );
        assert_eq!(row.local_reference.as_deref(), Some("42"));
        assert_eq!(row.title_hint.as_deref(), Some("Display hint"));
    }

    #[tokio::test]
    async fn portable_chapter_binding_requires_an_existing_portable_work() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();

        let error = upsert_portable_chapter_binding(
            &pool,
            "main",
            "portable:chapter:missing",
            "portable:work:missing",
            "/chapter/1",
            None,
            PortableResolutionStateV3::PendingProvider,
            None,
            1,
            1,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("does not exist"));
    }

    #[tokio::test]
    async fn portable_bindings_reject_noncanonical_ids() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        let work = PortableWorkRefV3::Novel {
            plugin_id: "fixture.plugin".to_string(),
            novel_key: "/novel/opaque".to_string(),
        };

        let error = upsert_portable_work_binding(
            &pool,
            "main",
            "portable:work:not-canonical",
            &work,
            Some("fixture.plugin"),
            None,
            PortableResolutionStateV3::PendingProvider,
            None,
            None,
            None,
            1,
            1,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("canonical reference"));

        let work_id = canonical_portable_work_id(&work);
        upsert_portable_work_binding(
            &pool,
            "main",
            &work_id,
            &work,
            Some("fixture.plugin"),
            Some("local-novel"),
            PortableResolutionStateV3::Bound,
            None,
            None,
            None,
            1,
            1,
        )
        .await
        .unwrap();

        let error = upsert_portable_chapter_binding(
            &pool,
            "main",
            "portable:chapter:not-canonical",
            &work_id,
            "/chapter/opaque",
            Some("local-chapter"),
            PortableResolutionStateV3::Bound,
            None,
            1,
            1,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("canonical reference"));
    }

    #[tokio::test]
    async fn comic_reader_snapshot_preserves_portable_refs_after_persistence() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        let session = AuthenticatedSession {
            token_id: "token-main".to_string(),
            device_id: "device-main".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["comics:profile:main".to_string()]),
            mutation_receipt: None,
        };
        let work = PortableWorkRefV3::Comic {
            source_id: "10002".to_string(),
            manga_key: "/Manga/KeepCase?token=A%2FB".to_string(),
        };
        let chapter = PortableChapterRefV3::Comic {
            work: work.clone(),
            chapter_key: "/Chapter/KeepCase?part=1".to_string(),
        };
        let work_id = canonical_portable_work_id(&work);
        let chapter_id = canonical_portable_chapter_id(&chapter);

        apply_comic_history_mutation(
            &pool,
            &session,
            "comics:profile:main",
            "history-portable",
            &ComicHistoryPatch {
                history_id: "history-portable".to_string(),
                comic_id: work_id.clone(),
                chapter_id: chapter_id.clone(),
                portable_work_ref: Some(work.clone()),
                portable_chapter_ref: Some(chapter.clone()),
                page_index: 3,
                page_count: Some(20),
                progress_percent: 0.15,
                read_at_ms: 100,
            },
            1,
            None,
            config.retention_window,
        )
        .await
        .unwrap();

        apply_comic_page_bookmark_mutation(
            &pool,
            &session,
            "comics:profile:main",
            "bookmark-portable",
            &ComicPageBookmarkPatch {
                bookmark_id: "bookmark-portable".to_string(),
                comic_id: work_id,
                chapter_id,
                portable_work_ref: Some(work.clone()),
                portable_chapter_ref: Some(chapter.clone()),
                page_index: 4,
                page_count: Some(20),
                label: Some("Opaque page".to_string()),
                saved_at_ms: 101,
            },
            2,
            config.retention_window,
        )
        .await
        .unwrap();

        let snapshot = load_scope_snapshot(&pool, "comics:profile:main")
            .await
            .unwrap();
        let history: ComicHistoryRecord = serde_json::from_value(
            snapshot
                .entities
                .iter()
                .find(|entity| entity.entity_type == "comic.history")
                .unwrap()
                .record
                .clone(),
        )
        .unwrap();
        let bookmark: ComicPageBookmarkRecord = serde_json::from_value(
            snapshot
                .entities
                .iter()
                .find(|entity| entity.entity_type == "comic.page_bookmark")
                .unwrap()
                .record
                .clone(),
        )
        .unwrap();

        assert_eq!(history.portable_work_ref.as_ref(), Some(&work));
        assert_eq!(history.portable_chapter_ref.as_ref(), Some(&chapter));
        assert_eq!(bookmark.portable_work_ref.as_ref(), Some(&work));
        assert_eq!(bookmark.portable_chapter_ref.as_ref(), Some(&chapter));
    }

    #[test]
    fn legacy_receipt_matches_v3_retry_when_only_transport_metadata_changed() {
        let stored = r#"{"clientMutationId":"stable","entityId":"book-1","entityType":"book.progress","lamport":7,"op":"merge","patch":{"progressPercent":0.5},"scopeId":"books:global"}"#;
        let incoming = r#"{"clientMutationId":"stable","entityId":"book-1","entityType":"book.progress","eventClock":{"deviceGenerationId":"device-1","logical":2,"physicalMs":1000},"lamport":19,"op":"merge","patch":{"progressPercent":0.5},"scopeId":"books:global"}"#;

        assert!(mutation_receipts_are_semantically_equivalent(stored, incoming).unwrap());
    }

    #[test]
    fn v3_receipt_rejects_a_retry_with_a_different_event_clock() {
        let stored = r#"{"clientMutationId":"stable","entityId":"book-1","entityType":"book.progress","eventClock":{"deviceGenerationId":"device-1","logical":2,"physicalMs":1000},"lamport":7,"op":"merge","patch":{"progressPercent":0.5},"scopeId":"books:global"}"#;
        let incoming = r#"{"clientMutationId":"stable","entityId":"book-1","entityType":"book.progress","eventClock":{"deviceGenerationId":"device-1","logical":3,"physicalMs":1001},"lamport":19,"op":"merge","patch":{"progressPercent":0.5},"scopeId":"books:global"}"#;

        assert!(!mutation_receipts_are_semantically_equivalent(stored, incoming).unwrap());
    }

    #[tokio::test]
    async fn recalculates_min_replayable_after_gc() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();

        let old = now_ms() - (31 * 24 * 60 * 60 * 1000_i64);
        sqlx::query(
            r#"
            INSERT INTO change_log (
                scope_id, profile_id, entity_type, entity_id, op, lamport, changed_by_device_id,
                patch_json, replay_until_ms, applied_at_ms
            ) VALUES ('books:global', NULL, 'book.progress', 'book-1', 'merge', 1, 'device-1', NULL, ?, ?)
            "#,
        )
        .bind(old)
        .bind(old - 1000)
        .execute(&pool)
        .await
        .unwrap();

        let recent = append_change_log_entry(
            &pool,
            "books:global",
            None,
            "book.progress",
            "book-2",
            "merge",
            2,
            "device-1",
            None,
            config.retention_window,
        )
        .await
        .unwrap();

        prune_expired_rows(&pool, now_ms()).await.unwrap();
        let runtime = load_server_runtime(&pool).await.unwrap();
        assert_eq!(runtime.current_server_version, recent.server_version);
        assert_eq!(
            runtime.min_replayable_server_version,
            recent.server_version - 1
        );
    }

    #[tokio::test]
    async fn change_log_sequence_never_restarts_below_the_published_version() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let mut last = 0;
        for index in 0..3 {
            last = append_change_log_entry(
                &pool,
                "books:global",
                None,
                "book.progress",
                &format!("book-{index}"),
                "merge",
                index + 1,
                "device-1",
                None,
                config.retention_window,
            )
            .await
            .unwrap()
            .server_version;
        }
        // A fully pruned log rebuilt the way the entity-type migrations rebuild it.
        sqlx::raw_sql(
            r#"
            DELETE FROM change_log;
            DELETE FROM sqlite_sequence WHERE name = 'change_log';
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        drop(pool);

        let pool = connect(&config).await.unwrap();
        let next = append_change_log_entry(
            &pool,
            "books:global",
            None,
            "book.progress",
            "book-after-rebuild",
            "merge",
            10,
            "device-1",
            None,
            config.retention_window,
        )
        .await
        .unwrap();
        assert!(
            next.server_version > last,
            "server_version restarted at {} after publishing {last}",
            next.server_version
        );
    }

    #[tokio::test]
    async fn prune_drops_mutation_receipts_past_their_retention() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let now = now_ms();
        for (id, created_at) in [
            ("old", now - MUTATION_RECEIPT_RETENTION_MS - 1),
            ("fresh", now - 1_000),
        ] {
            sqlx::query(
                r#"
                INSERT INTO mutation_receipts (
                    device_id, client_mutation_id, mutation_hash, mutation_json, result_json,
                    applied_server_version, created_at_ms
                ) VALUES ('device-1', ?, ?, '{}', '{}', NULL, ?)
                "#,
            )
            .bind(id)
            .bind("a".repeat(64))
            .bind(created_at)
            .execute(&pool)
            .await
            .unwrap();
        }

        prune_expired_rows(&pool, now).await.unwrap();

        let remaining: Vec<String> = sqlx::query_scalar(
            "SELECT client_mutation_id FROM mutation_receipts ORDER BY client_mutation_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(remaining, vec!["fresh".to_string()]);
    }

    #[tokio::test]
    async fn prune_revokes_paired_devices_idle_past_retention_and_flags_inactive_ones() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let now = now_ms();
        let day = 24 * 60 * 60 * 1000;
        // (device, last request, token inactivity expiry)
        for (device_id, last_seen, expires) in [
            ("abandoned", now - STALE_PAIRED_DEVICE_RETENTION_MS - day, now - 60 * day),
            ("idle", now - 40 * day, now - 10 * day),
            ("active", now - day, now + 29 * day),
        ] {
            sqlx::query(
                r#"
                INSERT INTO trusted_devices (
                    device_id, trusted_host_id, device_name, platform,
                    first_trusted_at_ms, last_seen_at_ms, revoked_at_ms
                ) VALUES (?, 'syncd-local-host', 'Pixel', 'android', ?, ?, NULL)
                "#,
            )
            .bind(device_id)
            .bind(last_seen)
            .bind(last_seen)
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query(
                r#"
                INSERT INTO paired_device_tokens (
                    token_id, device_id, profile_id, token_hash, issued_at_ms,
                    last_seen_at_ms, inactivity_expires_at_ms, revoked_at_ms, granted_via
                ) VALUES (?, ?, 'main', ?, ?, ?, ?, NULL, 'qr')
                "#,
            )
            .bind(format!("token-{device_id}"))
            .bind(device_id)
            .bind(format!("hash-{device_id}"))
            .bind(last_seen)
            .bind(last_seen)
            .bind(expires)
            .execute(&pool)
            .await
            .unwrap();
        }

        prune_expired_rows(&pool, now).await.unwrap();

        let devices = list_paired_devices(&pool).await.unwrap();
        let listed: Vec<(&str, bool)> = devices
            .iter()
            .map(|device| (device.device_id.as_str(), device.inactive))
            .collect();
        assert_eq!(listed, vec![("active", false), ("idle", true)]);
        let abandoned_token_revoked: Option<i64> = sqlx::query_scalar(
            "SELECT revoked_at_ms FROM paired_device_tokens WHERE device_id = 'abandoned'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(abandoned_token_revoked.is_some());
    }

    #[tokio::test]
    async fn upsert_server_identity_replaces_seed_placeholder_server_id() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();

        let seeded: String =
            sqlx::query_scalar("SELECT server_id FROM server_identity WHERE singleton_id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(seeded, "pending-server-id");

        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();

        let identity = load_server_identity(&pool).await.unwrap();
        assert_ne!(identity.server_id, "pending-server-id");
        assert!(!identity.server_id.trim().is_empty());
        assert_eq!(identity.tls_cert_sha256, "fingerprint");
    }

    #[test]
    fn book_progress_merge_keeps_higher_page_even_with_newer_lamport() {
        let current = BookProgressRecord {
            book_id: "book-1".to_string(),
            renderer: Some("pdf".to_string()),
            location: None,
            href: None,
            progress_percent: 0.6,
            last_read_at_ms: 1000,
            page_index: Some(20),
            total_pages: Some(100),
            section_label: Some("Chapter 4".to_string()),
            record_lamport: 5,
        };

        let patch = BookProgressPatch {
            renderer: Some("pdf".to_string()),
            location: None,
            href: None,
            progress_percent: 0.2,
            last_read_at_ms: 2000,
            page_index: Some(5),
            total_pages: Some(100),
            section_label: Some("Backslide".to_string()),
            reset: false,
        };

        let merged = merge_book_progress(Some(current), "book-1", &patch, 99, false).unwrap();
        assert_eq!(merged.page_index, Some(20));
        assert_eq!(merged.progress_percent, 0.6);
        assert_eq!(merged.record_lamport, 100);
    }

    #[test]
    fn novel_progress_merge_keeps_higher_chapter_even_with_newer_lamport() {
        let current = NovelProgressRecord {
            portable_work_ref: None,
            portable_chapter_ref: None,
            novel_id: "novel-1".to_string(),
            chapter_id: Some("c20".to_string()),
            chapter_title: Some("Twenty".to_string()),
            chapter_order_key: Some(20.0),
            progress_percent: 0.2,
            locator: Some("/20#p2".to_string()),
            locator_sort_key: Some(2.0),
            updated_at_ms: 1000,
            record_lamport: 5,
        };

        let patch = NovelProgressPatch {
            portable_work_ref: None,
            portable_chapter_ref: None,
            chapter_id: Some("c19".to_string()),
            chapter_title: Some("Nineteen".to_string()),
            chapter_order_key: Some(19.0),
            progress_percent: 0.9,
            locator: Some("/19#p9".to_string()),
            locator_sort_key: Some(9.0),
            updated_at_ms: 2000,
            reset: false,
        };

        let merged = merge_novel_progress(Some(current), "novel-1", &patch, 77, false).unwrap();
        assert_eq!(merged.chapter_order_key, Some(20.0));
        assert_eq!(merged.chapter_id.as_deref(), Some("c20"));
        assert_eq!(merged.record_lamport, 78);
    }

    #[test]
    fn causal_novel_progress_accepts_an_intentional_regression() {
        let current = NovelProgressRecord {
            portable_work_ref: None,
            portable_chapter_ref: None,
            novel_id: "novel-1".to_string(),
            chapter_id: Some("c20".to_string()),
            chapter_title: Some("Twenty".to_string()),
            chapter_order_key: Some(20.0),
            progress_percent: 0.8,
            locator: Some("/20#p8".to_string()),
            locator_sort_key: Some(8.0),
            updated_at_ms: 1000,
            record_lamport: 5,
        };
        let patch = NovelProgressPatch {
            portable_work_ref: None,
            portable_chapter_ref: None,
            chapter_id: Some("c19".to_string()),
            chapter_title: Some("Nineteen".to_string()),
            chapter_order_key: Some(19.0),
            progress_percent: 0.1,
            locator: Some("/19#p1".to_string()),
            locator_sort_key: Some(1.0),
            updated_at_ms: 2000,
            reset: false,
        };

        let merged = merge_novel_progress(Some(current), "novel-1", &patch, 8, true).unwrap();

        assert_eq!(merged.chapter_id.as_deref(), Some("c19"));
        assert_eq!(merged.progress_percent, 0.1);
    }

    #[test]
    fn legacy_novel_progress_does_not_inherit_stale_portable_refs() {
        let work = PortableWorkRefV3::Novel {
            plugin_id: "fixture.plugin".to_string(),
            novel_key: "/novel/one".to_string(),
        };
        let chapter = PortableChapterRefV3::Novel {
            work: work.clone(),
            chapter_key: "/chapter/one".to_string(),
        };
        let current = NovelProgressRecord {
            novel_id: canonical_portable_work_id(&work),
            chapter_id: Some(canonical_portable_chapter_id(&chapter)),
            portable_work_ref: Some(work),
            portable_chapter_ref: Some(chapter),
            chapter_title: Some("Portable".to_string()),
            chapter_order_key: Some(1.0),
            progress_percent: 0.5,
            locator: Some("block:1".to_string()),
            locator_sort_key: Some(1.0),
            updated_at_ms: 100,
            record_lamport: 1,
        };
        let patch = NovelProgressPatch {
            chapter_id: Some("legacy-chapter-2".to_string()),
            portable_work_ref: None,
            portable_chapter_ref: None,
            chapter_title: Some("Legacy".to_string()),
            chapter_order_key: Some(2.0),
            progress_percent: 0.25,
            locator: Some("legacy:2".to_string()),
            locator_sort_key: Some(2.0),
            updated_at_ms: 200,
            reset: false,
        };

        let merged = merge_novel_progress(Some(current), "legacy-novel", &patch, 2, true).unwrap();

        assert_eq!(merged.novel_id, "legacy-novel");
        assert_eq!(merged.chapter_id.as_deref(), Some("legacy-chapter-2"));
        assert!(merged.portable_work_ref.is_none());
        assert!(merged.portable_chapter_ref.is_none());
    }

    #[test]
    fn portable_novel_progress_replaces_legacy_identity_atomically() {
        let current = NovelProgressRecord {
            novel_id: "legacy-novel".to_string(),
            chapter_id: Some("legacy-chapter".to_string()),
            portable_work_ref: None,
            portable_chapter_ref: None,
            chapter_title: Some("Legacy".to_string()),
            chapter_order_key: Some(1.0),
            progress_percent: 0.5,
            locator: Some("legacy:1".to_string()),
            locator_sort_key: Some(1.0),
            updated_at_ms: 100,
            record_lamport: 1,
        };
        let work = PortableWorkRefV3::Novel {
            plugin_id: "fixture.plugin".to_string(),
            novel_key: "/novel/one".to_string(),
        };
        let chapter = PortableChapterRefV3::Novel {
            work: work.clone(),
            chapter_key: "/chapter/two".to_string(),
        };
        let patch = NovelProgressPatch {
            chapter_id: Some(canonical_portable_chapter_id(&chapter)),
            portable_work_ref: Some(work.clone()),
            portable_chapter_ref: Some(chapter.clone()),
            chapter_title: Some("Portable".to_string()),
            chapter_order_key: Some(2.0),
            progress_percent: 0.25,
            locator: Some("block:2".to_string()),
            locator_sort_key: Some(2.0),
            updated_at_ms: 200,
            reset: false,
        };

        let merged = merge_novel_progress(
            Some(current),
            &canonical_portable_work_id(&work),
            &patch,
            2,
            true,
        )
        .unwrap();

        assert_eq!(merged.novel_id, canonical_portable_work_id(&work));
        assert_eq!(merged.portable_work_ref.as_ref(), Some(&work));
        assert_eq!(merged.portable_chapter_ref.as_ref(), Some(&chapter));
    }

    #[test]
    fn book_progress_merge_strips_entity_prefix_from_persisted_book_id() {
        let patch = BookProgressPatch {
            renderer: Some("pdf".to_string()),
            location: None,
            href: None,
            progress_percent: 0.4,
            last_read_at_ms: 1000,
            page_index: Some(12),
            total_pages: Some(100),
            section_label: None,
            reset: false,
        };

        let merged = merge_book_progress(None, "book.progress::book-1", &patch, 3, false).unwrap();
        assert_eq!(merged.book_id, "book-1");
        assert_eq!(
            normalize_book_progress_book_id("book.progress::book.progress::book-1"),
            "book-1"
        );
        assert_eq!(
            normalize_book_progress_book_id(&format!("pdf-{}", "A".repeat(64))),
            format!("pdf:sha256:{}", "a".repeat(64))
        );
    }

    #[test]
    fn novel_progress_merge_strips_entity_prefix_from_persisted_novel_id() {
        let patch = NovelProgressPatch {
            portable_work_ref: None,
            portable_chapter_ref: None,
            chapter_id: Some("c1".to_string()),
            chapter_title: Some("One".to_string()),
            chapter_order_key: Some(1.0),
            progress_percent: 1.0,
            locator: Some("/1".to_string()),
            locator_sort_key: Some(1.0),
            updated_at_ms: 1000,
            reset: false,
        };

        let merged =
            merge_novel_progress(None, "novel.progress::novel-1", &patch, 7, false).unwrap();
        assert_eq!(merged.novel_id, "novel-1");
    }

    #[tokio::test]
    async fn failed_progress_write_rolls_back_change_log_insert() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();

        let session = AuthenticatedSession {
            token_id: "token-main".to_string(),
            device_id: "device-main".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from([
                "books:global".to_string(),
                "novels:profile:main".to_string(),
            ]),
            mutation_receipt: None,
        };

        let before_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM change_log")
            .fetch_one(&pool)
            .await
            .unwrap();

        let error = apply_book_progress_mutation(
            &pool,
            &session,
            "novels:profile:main",
            "book-rollback",
            &BookProgressPatch {
                renderer: Some("pdf".to_string()),
                location: None,
                href: None,
                progress_percent: 0.4,
                last_read_at_ms: 1000,
                page_index: Some(12),
                total_pages: Some(100),
                section_label: None,
                reset: false,
            },
            3,
            None,
            config.retention_window,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("CHECK constraint failed"));

        let after_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM change_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        let runtime = load_server_runtime(&pool).await.unwrap();

        assert_eq!(before_count, after_count);
        assert_eq!(runtime.current_server_version, 0);
    }

    #[tokio::test]
    async fn causal_book_progress_accepts_recent_rewind_and_supersedes_late_delivery() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let session = AuthenticatedSession {
            token_id: "token-main".to_string(),
            device_id: "device-main".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["books:global".to_string()]),
            mutation_receipt: None,
        };
        let patch = |page_index, progress_percent, last_read_at_ms| BookProgressPatch {
            renderer: Some("pdf".to_string()),
            location: None,
            href: None,
            progress_percent,
            last_read_at_ms,
            page_index: Some(page_index),
            total_pages: Some(100),
            section_label: None,
            reset: false,
        };
        let clock = |physical_ms| EventClock {
            physical_ms,
            logical: 1,
            device_generation_id: "generation-main".to_string(),
        };

        assert!(matches!(
            apply_book_progress_mutation(
                &pool,
                &session,
                "books:global",
                "book-1",
                &patch(50, 0.5, 200),
                1,
                Some(&clock(200)),
                config.retention_window,
            )
            .await
            .unwrap(),
            CausalMutationWriteOutcome::Applied(_)
        ));
        assert!(matches!(
            apply_book_progress_mutation(
                &pool,
                &session,
                "books:global",
                "book-1",
                &patch(5, 0.05, 300),
                2,
                Some(&clock(300)),
                config.retention_window,
            )
            .await
            .unwrap(),
            CausalMutationWriteOutcome::Applied(_)
        ));
        assert!(matches!(
            apply_book_progress_mutation(
                &pool,
                &session,
                "books:global",
                "book-1",
                &patch(80, 0.8, 250),
                3,
                Some(&clock(250)),
                config.retention_window,
            )
            .await
            .unwrap(),
            CausalMutationWriteOutcome::Superseded { .. }
        ));

        let stored: BookProgressRow = sqlx::query_as(
            r#"SELECT scope_id, book_id, renderer, location, href, progress_percent,
            last_read_at_ms, page_index, total_pages, section_label, record_updated_at_ms,
            record_updated_by_device_id, record_lamport, record_server_version
            FROM book_progress WHERE scope_id = ? AND book_id = ?"#,
        )
        .bind("books:global")
        .bind("book-1")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored.page_index, Some(5));
        assert_eq!(stored.progress_percent, 0.05);
    }

    #[tokio::test]
    async fn folder_edit_made_offline_does_not_override_a_newer_edit_delivered_first() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let session = |device_id: &str| AuthenticatedSession {
            token_id: format!("token-{device_id}"),
            device_id: device_id.to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from([
                "books:global".to_string(),
                "novels:profile:main".to_string(),
            ]),
            mutation_receipt: None,
        };
        let desktop = session("desktop");
        let phone = session("phone");
        let clock = |physical_ms| EventClock {
            physical_ms,
            logical: 0,
            device_generation_id: "generation".to_string(),
        };
        let book = |name: &str| BookCategoryPatch {
            category_id: "folder-1".to_string(),
            name: name.to_string(),
            order: 1,
        };
        let novel = |name: &str| NovelCategoryPatch {
            category_id: "folder-1".to_string(),
            name: name.to_string(),
            order: 1,
        };
        let book_name = || async {
            sqlx::query_scalar::<_, String>(
                "SELECT name FROM book_categories WHERE scope_id = 'books:global' AND category_id = 'folder-1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap()
        };
        let novel_name = || async {
            sqlx::query_scalar::<_, String>(
                "SELECT name FROM novel_categories WHERE scope_id = 'novels:profile:main' AND category_id = 'folder-1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap()
        };

        // The desktop renames at 300; the phone's offline rename from 200 arrives afterwards with
        // a higher Lamport value, as a reconnecting device's replay does.
        for (lamport, at, name) in [(1, 100, "Lendo"), (10, 300, "B_Desk")] {
            assert!(matches!(
                apply_book_category_mutation(
                    &pool, &desktop, "books:global", "folder-1", &book(name), lamport,
                    Some(&clock(at)), config.retention_window,
                )
                .await
                .unwrap(),
                CausalMutationWriteOutcome::Applied(_)
            ));
            assert!(matches!(
                apply_novel_category_mutation(
                    &pool, &desktop, "novels:profile:main", "folder-1", &novel(name), lamport,
                    Some(&clock(at)), config.retention_window,
                )
                .await
                .unwrap(),
                CausalMutationWriteOutcome::Applied(_)
            ));
        }
        let CausalMutationWriteOutcome::Superseded { record, winning_clock, server_version, .. } =
            apply_book_category_mutation(
                &pool, &phone, "books:global", "folder-1", &book("B_Cel"), 11,
                Some(&clock(200)), config.retention_window,
            )
            .await
            .unwrap()
        else {
            panic!("an older offline rename must not win");
        };
        assert_eq!(record["name"], "B_Desk");
        assert_eq!(winning_clock.physical_ms, 300);
        // The phone waits for the winning folder's own version; the novel write after it is a
        // later version of another entity, so the global version would never arrive for this one.
        let winning_version: i64 = sqlx::query_scalar(
            "SELECT record_server_version FROM book_categories WHERE category_id = 'folder-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(server_version, winning_version);
        assert!(matches!(
            apply_novel_category_mutation(
                &pool, &phone, "novels:profile:main", "folder-1", &novel("B_Cel"), 11,
                Some(&clock(200)), config.retention_window,
            )
            .await
            .unwrap(),
            CausalMutationWriteOutcome::Superseded { .. }
        ));
        assert_eq!(book_name().await, "B_Desk");
        assert_eq!(novel_name().await, "B_Desk");

        // An offline delete older than the rename keeps the folder; a republish without an edit
        // time does not outrank an edit either.
        assert!(matches!(
            delete_book_category_mutation(
                &pool, &phone, "books:global", "folder-1", 12, Some(&clock(250)),
                config.retention_window,
            )
            .await
            .unwrap(),
            CausalMutationWriteOutcome::Superseded { .. }
        ));
        assert!(matches!(
            delete_novel_category_mutation(
                &pool, &phone, "novels:profile:main", "folder-1", 12, Some(&clock(250)),
                config.retention_window,
            )
            .await
            .unwrap(),
            CausalMutationWriteOutcome::Superseded { .. }
        ));
        assert!(matches!(
            apply_book_category_mutation(
                &pool, &desktop, "books:global", "folder-1", &book("Lendo"), 13, None,
                config.retention_window,
            )
            .await
            .unwrap(),
            CausalMutationWriteOutcome::Superseded { .. }
        ));
        assert_eq!(book_name().await, "B_Desk");

        // A newer edit wins wherever it comes from, and a newer delete removes the folder.
        assert!(matches!(
            apply_book_category_mutation(
                &pool, &phone, "books:global", "folder-1", &book("Depois"), 14,
                Some(&clock(400)), config.retention_window,
            )
            .await
            .unwrap(),
            CausalMutationWriteOutcome::Applied(_)
        ));
        assert_eq!(book_name().await, "Depois");
        assert!(matches!(
            delete_novel_category_mutation(
                &pool, &phone, "novels:profile:main", "folder-1", 15, Some(&clock(500)),
                config.retention_window,
            )
            .await
            .unwrap(),
            CausalMutationWriteOutcome::Applied(_)
        ));
        let remaining: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM novel_categories WHERE category_id = 'folder-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(remaining, 0);
    }

    #[tokio::test]
    async fn causal_comic_history_enqueues_only_the_latest_canonical_projection() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let session = AuthenticatedSession {
            token_id: "token-main".to_string(),
            device_id: "device-main".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["comics:profile:main".to_string()]),
            mutation_receipt: None,
        };
        let patch = |page_index, read_at_ms| ComicHistoryPatch {
            portable_work_ref: None,
            portable_chapter_ref: None,
            history_id: "comic.history::suwayomi:profile:main:manga:7".to_string(),
            comic_id: "suwayomi:profile:main:manga:7".to_string(),
            chapter_id: "suwayomi:profile:main:chapter:11".to_string(),
            page_index,
            page_count: Some(100),
            progress_percent: page_index as f64 / 100.0,
            read_at_ms,
        };
        let clock = |physical_ms| EventClock {
            physical_ms,
            logical: 1,
            device_generation_id: "generation-main".to_string(),
        };

        for (page, physical_ms) in [(50, 200), (5, 300)] {
            assert!(matches!(
                apply_comic_history_mutation(
                    &pool,
                    &session,
                    "comics:profile:main",
                    "comic.history::suwayomi:profile:main:manga:7",
                    &patch(page, physical_ms),
                    page,
                    Some(&clock(physical_ms)),
                    config.retention_window,
                )
                .await
                .unwrap(),
                CausalMutationWriteOutcome::Applied(_)
            ));
        }
        assert!(matches!(
            apply_comic_history_mutation(
                &pool,
                &session,
                "comics:profile:main",
                "comic.history::suwayomi:profile:main:manga:7",
                &patch(80, 250),
                80,
                Some(&clock(250)),
                config.retention_window,
            )
            .await
            .unwrap(),
            CausalMutationWriteOutcome::Superseded { .. }
        ));

        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT variables_json FROM suwayomi_projection_outbox ORDER BY source_server_version",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        let variables: Value = serde_json::from_str(&rows[0].0).unwrap();
        assert_eq!(variables["mangaId"], 7);
        assert_eq!(variables["ids"], json!([11]));
        assert_eq!(variables["lastPageRead"], 5);
    }

    #[tokio::test]
    async fn mirrored_comic_history_never_echoes_back_to_suwayomi() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let session = AuthenticatedSession {
            token_id: "epigraph-core-mirror".to_string(),
            device_id: "epigraph-core-mirror".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["comics:profile:main".to_string()]),
            mutation_receipt: None,
        };
        let entity_id = "comic.history::suwayomi:profile:main:manga:7";
        let patch = ComicHistoryPatch {
            portable_work_ref: None,
            portable_chapter_ref: None,
            history_id: entity_id.to_string(),
            comic_id: "suwayomi:profile:main:manga:7".to_string(),
            chapter_id: "suwayomi:profile:main:chapter:11".to_string(),
            page_index: 12,
            page_count: Some(20),
            progress_percent: 0.6,
            read_at_ms: 1_600_000_000_000,
        };

        assert!(matches!(
            apply_mirrored_comic_history_mutation(
                &pool,
                &session,
                "comics:profile:main",
                entity_id,
                &patch,
                0,
                None,
                config.retention_window,
            )
            .await
            .unwrap(),
            CausalMutationWriteOutcome::Applied(_)
        ));
        let read_at_ms: i64 =
            sqlx::query_scalar("SELECT read_at_ms FROM comic_history WHERE history_id = ?")
                .bind(entity_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let projection_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM suwayomi_projection_outbox")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(read_at_ms, 1_600_000_000_000);
        assert_eq!(projection_count, 0);
    }

    #[tokio::test]
    async fn superseded_chapter_progress_projection_keeps_fields_the_newer_patch_leaves_null() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let session = AuthenticatedSession {
            token_id: "token-main".to_string(),
            device_id: "device-main".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["comics:profile:main".to_string()]),
            mutation_receipt: None,
        };
        let comic_id = "suwayomi:profile:main:manga:7";
        let chapter_id = "suwayomi:profile:main:chapter:11";
        let entity_id = format!("comic.chapter_state::{comic_id}::{chapter_id}");
        let patch = |read: Value, last_page_read: i64, at: i64| {
            json!({
                "chapterStateId": entity_id,
                "comicId": comic_id,
                "chapterId": chapter_id,
                "read": read,
                "bookmarked": null,
                "lastPageRead": last_page_read,
                "updatedAtMs": at,
                "explicitProgressReset": false
            })
        };

        for (lamport, record) in [
            (1, patch(json!(true), 13, 100)),
            (2, patch(Value::Null, 9, 200)),
        ] {
            apply_comic_sync_state_mutation(
                &pool,
                &session,
                "comics:profile:main",
                "comic.chapter_state",
                &entity_id,
                &record,
                lamport,
                None,
                config.retention_window,
            )
            .await
            .unwrap();
        }

        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT variables_json FROM suwayomi_projection_outbox WHERE entity_type = 'comic.chapter_state'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        let variables: Value = serde_json::from_str(&rows[0]).unwrap();
        assert_eq!(variables["isRead"], true);
        assert_eq!(variables["lastPageRead"], 9);
        assert!(variables["isBookmarked"].is_null());
    }

    #[tokio::test]
    async fn portable_comic_chapter_state_enqueues_exact_refs_for_binding_resolution() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let session = AuthenticatedSession {
            token_id: "token-main".to_string(),
            device_id: "device-main".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["comics:profile:main".to_string()]),
            mutation_receipt: None,
        };
        let work = PortableWorkRefV3::Comic {
            source_id: "10002".to_string(),
            manga_key: "/Manga/KeepCase?token=A%2FB".to_string(),
        };
        let chapter = PortableChapterRefV3::Comic {
            work: work.clone(),
            chapter_key: "/Chapter/KeepCase?part=1".to_string(),
        };
        let work_id = canonical_portable_work_id(&work);
        let chapter_id = canonical_portable_chapter_id(&chapter);
        let entity_id = format!("comic.chapter_state::{work_id}::{chapter_id}");
        let record = json!({
            "chapterStateId": entity_id,
            "comicId": work_id,
            "chapterId": chapter_id,
            "portableWorkRef": work,
            "portableChapterRef": chapter,
            "read": true,
            "bookmarked": false,
            "lastPageRead": 8,
            "lastReadAtMs": 100,
            "updatedAtMs": 100,
            "explicitProgressReset": false
        });

        apply_comic_sync_state_mutation(
            &pool,
            &session,
            "comics:profile:main",
            "comic.chapter_state",
            &entity_id,
            &record,
            1,
            None,
            config.retention_window,
        )
        .await
        .unwrap();

        let variables_json: String = sqlx::query_scalar(
            "SELECT variables_json FROM suwayomi_projection_outbox WHERE entity_type = 'comic.chapter_state'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let variables: Value = serde_json::from_str(&variables_json).unwrap();
        assert_eq!(variables["portableWorkRef"], record["portableWorkRef"]);
        assert_eq!(
            variables["portableChapterRef"],
            record["portableChapterRef"]
        );
        assert_eq!(variables["lastPageRead"], 8);
        assert!(variables.get("mangaId").is_none());
    }

    #[tokio::test]
    async fn mirrored_comic_chapter_state_never_echoes_back_to_suwayomi() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let session = AuthenticatedSession {
            token_id: "mirror-token".to_string(),
            device_id: "epigraph-core-mirror".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["comics:profile:main".to_string()]),
            mutation_receipt: None,
        };
        let entity_id =
            "comic.chapter_state::suwayomi:profile:main:manga:7::suwayomi:profile:main:chapter:11";
        let record = json!({
            "chapterStateId": entity_id,
            "comicId": "suwayomi:profile:main:manga:7",
            "chapterId": "suwayomi:profile:main:chapter:11",
            "read": false,
            "bookmarked": true,
            "updatedAtMs": 200,
        });
        let clock = EventClock {
            physical_ms: 200,
            logical: 0,
            device_generation_id: "epigraph-core-mirror".to_string(),
        };

        assert!(matches!(
            apply_mirrored_comic_sync_state_mutation(
                &pool,
                &session,
                "comics:profile:main",
                "comic.chapter_state",
                entity_id,
                &record,
                200,
                Some(&clock),
                config.retention_window,
            )
            .await
            .unwrap(),
            CausalMutationWriteOutcome::Applied(_)
        ));
        let state_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM comic_sync_state WHERE entity_id = ?")
                .bind(entity_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let projection_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM suwayomi_projection_outbox")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(state_count, 1);
        assert_eq!(projection_count, 0);
    }

    #[tokio::test]
    async fn portable_comic_library_state_enqueues_work_ref_without_local_manga_id() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let session = AuthenticatedSession {
            token_id: "token-main".to_string(),
            device_id: "device-main".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["comics:profile:main".to_string()]),
            mutation_receipt: None,
        };
        let work = PortableWorkRefV3::Comic {
            source_id: "10002".to_string(),
            manga_key: "/Manga/KeepCase?token=A%2FB".to_string(),
        };
        let work_id = canonical_portable_work_id(&work);
        let record = json!({
            "comicId": work_id,
            "inLibrary": true,
            "portableWorkRef": work,
        });

        apply_comic_sync_state_mutation(
            &pool,
            &session,
            "comics:profile:main",
            "comic.entry",
            &work_id,
            &record,
            1,
            None,
            config.retention_window,
        )
        .await
        .unwrap();

        let variables_json: String = sqlx::query_scalar(
            "SELECT variables_json FROM suwayomi_projection_outbox WHERE entity_type = 'comic.entry'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let variables: Value = serde_json::from_str(&variables_json).unwrap();
        assert_eq!(variables["portableWorkRef"], record["portableWorkRef"]);
        assert_eq!(variables["inLibrary"], true);
        assert!(variables.get("id").is_none());
        assert!(variables.get("mangaId").is_none());
    }

    #[tokio::test]
    async fn comic_delete_without_prior_record_projects_legacy_ids() {
        for prefix in ["suwayomi:profile:main", "suwayomi:server:desktop-a:profile:main"] {
            let temp = tempdir().unwrap();
            let config = SyncdConfig::for_test(temp.path().to_path_buf());
            let pool = connect(&config).await.unwrap();
            upsert_server_identity(&pool, &config, "fingerprint")
                .await
                .unwrap();
            let session = AuthenticatedSession {
                token_id: "token-main".to_string(),
                device_id: "device-main".to_string(),
                profile_id: "main".to_string(),
                scopes: BTreeSet::from(["comics:profile:main".to_string()]),
                mutation_receipt: None,
            };
            let comic_id = format!("{prefix}:manga:42");
            let category_id = format!("{prefix}:category:3");
            let assignment_id = "comic-category-assignment:".to_string() + &"ab".repeat(32);
            for (entity_type, entity_id) in [
                ("comic.category_assignment", assignment_id.as_str()),
                ("comic.entry", comic_id.as_str()),
                ("comic.category", category_id.as_str()),
            ] {
                assert!(matches!(
                    delete_comic_sync_state_mutation(
                        &pool,
                        &session,
                        "comics:profile:main",
                        entity_type,
                        entity_id,
                        1,
                        None,
                        config.retention_window,
                    )
                    .await
                    .unwrap(),
                    CausalMutationWriteOutcome::Applied(_)
                ));
            }

            let rows: Vec<(String, String, String, String)> = sqlx::query_as(
                r#"
                SELECT entity_type, entity_id, operation_name, variables_json
                FROM suwayomi_projection_outbox
                WHERE profile_id = 'main'
                ORDER BY source_server_version
                "#,
            )
            .fetch_all(&pool)
            .await
            .unwrap();
            let rows: Vec<(String, String, String, Value)> = rows
                .into_iter()
                .map(|(entity_type, entity_id, operation, variables)| {
                    (
                        entity_type,
                        entity_id,
                        operation,
                        serde_json::from_str(&variables).unwrap(),
                    )
                })
                .collect();
            assert_eq!(
                rows,
                vec![
                    (
                        "comic.category_assignment".to_string(),
                        assignment_id.clone(),
                        REMOVE_COMIC_CATEGORY_ASSIGNMENT_OPERATION.to_string(),
                        json!({ "assignmentId": assignment_id }),
                    ),
                    (
                        "comic.entry".to_string(),
                        comic_id.clone(),
                        "UpdateManga".to_string(),
                        json!({ "id": 42, "inLibrary": false }),
                    ),
                    (
                        "comic.category".to_string(),
                        category_id.clone(),
                        "DeleteCategory".to_string(),
                        json!({ "id": 3 }),
                    ),
                ],
                "{prefix}"
            );
        }
    }

    #[tokio::test]
    async fn comic_entry_delete_without_prior_record_projects_its_portable_binding() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let session = AuthenticatedSession {
            token_id: "token-main".to_string(),
            device_id: "device-main".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["comics:profile:main".to_string()]),
            mutation_receipt: None,
        };
        let work = PortableWorkRefV3::Comic {
            source_id: "6247824327199706550".to_string(),
            manga_key: "/series/restored".to_string(),
        };
        let work_id = canonical_portable_work_id(&work);
        upsert_portable_work_binding(
            &pool,
            "main",
            &work_id,
            &work,
            None,
            Some("160"),
            PortableResolutionStateV3::Bound,
            None,
            Some("Restored"),
            None,
            0,
            1,
        )
        .await
        .unwrap();

        delete_comic_sync_state_mutation(
            &pool,
            &session,
            "comics:profile:main",
            "comic.entry",
            &work_id,
            1,
            None,
            config.retention_window,
        )
        .await
        .unwrap();

        let (operation, variables_json): (String, String) = sqlx::query_as(
            "SELECT operation_name, variables_json FROM suwayomi_projection_outbox WHERE entity_type = 'comic.entry'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let variables: Value = serde_json::from_str(&variables_json).unwrap();
        assert_eq!(operation, "UpdateManga");
        assert_eq!(variables["portableWorkRef"], serde_json::to_value(&work).unwrap());
        assert_eq!(variables["inLibrary"], false);
    }

    #[tokio::test]
    async fn comic_delete_without_prior_record_ignores_foreign_profile_ids() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let session = AuthenticatedSession {
            token_id: "token-main".to_string(),
            device_id: "device-main".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["comics:profile:main".to_string()]),
            mutation_receipt: None,
        };
        for (entity_type, entity_id) in [
            ("comic.entry", "suwayomi:profile:other:manga:42"),
            ("comic.category", "suwayomi:server:desktop-a:profile:other:category:3"),
            ("comic.category_assignment", "not-an-assignment-id"),
        ] {
            delete_comic_sync_state_mutation(
                &pool,
                &session,
                "comics:profile:main",
                entity_type,
                entity_id,
                1,
                None,
                config.retention_window,
            )
            .await
            .unwrap();
        }
        let projection_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM suwayomi_projection_outbox")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(projection_count, 0);
    }

    #[tokio::test]
    async fn comic_category_merges_without_prior_record_project_legacy_ids() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let session = AuthenticatedSession {
            token_id: "token-main".to_string(),
            device_id: "device-main".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["comics:profile:main".to_string()]),
            mutation_receipt: None,
        };
        let category_id = "suwayomi:server:desktop-a:profile:main:category:7";
        let mutations = [
            (
                "comic.category_assignment",
                "comic-category-assignment:merge",
                json!({
                    "comicId": "suwayomi:profile:main:manga:42",
                    "categoryId": category_id,
                }),
            ),
            (
                "comic.category",
                category_id,
                json!({ "categoryId": category_id, "name": "Reading", "order": 2 }),
            ),
        ];
        for (entity_type, entity_id, record) in &mutations {
            apply_comic_sync_state_mutation(
                &pool,
                &session,
                "comics:profile:main",
                entity_type,
                entity_id,
                record,
                1,
                None,
                config.retention_window,
            )
            .await
            .unwrap();
        }

        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT operation_name, variables_json FROM suwayomi_projection_outbox \n             ORDER BY source_server_version, operation_name",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let rows: Vec<(String, Value)> = rows
            .into_iter()
            .map(|(name, variables)| (name, serde_json::from_str(&variables).unwrap()))
            .collect();
        assert_eq!(
            rows,
            vec![
                (
                    "UpdateMangaCategories".to_string(),
                    json!({ "mangaId": 42, "addTo": [7], "removeFrom": [] }),
                ),
                (
                    "UpdateCategory".to_string(),
                    json!({ "id": 7, "name": "Reading" }),
                ),
                (
                    "UpdateCategoryOrder".to_string(),
                    json!({ "id": 7, "position": 2 }),
                ),
            ]
        );
    }

    #[tokio::test]
    async fn newer_comic_merge_supersedes_blocked_projection() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let session = AuthenticatedSession {
            token_id: "token-main".to_string(),
            device_id: "device-main".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["comics:profile:main".to_string()]),
            mutation_receipt: None,
        };
        let category_id = "suwayomi:server:desktop-a:profile:main:category:7";
        for (name, lamport) in [("Default", 1), ("Reading", 2)] {
            apply_comic_sync_state_mutation(
                &pool,
                &session,
                "comics:profile:main",
                "comic.category",
                category_id,
                &json!({ "categoryId": category_id, "name": name }),
                lamport,
                None,
                config.retention_window,
            )
            .await
            .unwrap();
            if lamport == 1 {
                // Suwayomi rejected the first rename permanently, so its projection ended blocked.
                sqlx::query(
                    "UPDATE suwayomi_projection_outbox SET status = 'blocked', last_error = 'command_rejected'",
                )
                .execute(&pool)
                .await
                .unwrap();
            }
        }

        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT status, variables_json FROM suwayomi_projection_outbox ORDER BY source_server_version",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let rows: Vec<(String, Value)> = rows
            .into_iter()
            .map(|(status, variables)| (status, serde_json::from_str(&variables).unwrap()))
            .collect();
        assert_eq!(
            rows,
            vec![("pending".to_string(), json!({ "id": 7, "name": "Reading" }))]
        );
    }

    #[tokio::test]
    async fn book_annotations_preserve_full_metadata_and_highlight_tombstones() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let session = AuthenticatedSession {
            token_id: "token-main".to_string(),
            device_id: "device-main".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["books:global".to_string()]),
            mutation_receipt: None,
        };

        apply_book_bookmark_mutation(
            &pool,
            &session,
            "books:global",
            "bookmark-1",
            &BookBookmarkPatch {
                book_id: "book-1".to_string(),
                location: Some("epubcfi(/6/2)".to_string()),
                href: Some("chapter-1.xhtml".to_string()),
                page_index: None,
                progress_percent: 0.25,
                label: Some("Start".to_string()),
                note: Some("Keep this note".to_string()),
                created_at_ms: 100,
                updated_at_ms: 200,
                saved_at_ms: 200,
            },
            1,
            config.retention_window,
        )
        .await
        .unwrap();
        let bookmark: BookBookmarkRow =
            sqlx::query_as("SELECT * FROM book_bookmarks WHERE scope_id = ? AND bookmark_id = ?")
                .bind("books:global")
                .bind("bookmark-1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(bookmark.note.as_deref(), Some("Keep this note"));
        assert_eq!(bookmark.created_at_ms, 100);
        assert_eq!(bookmark.updated_at_ms, 200);

        apply_book_highlight_mutation(
            &pool,
            &session,
            "books:global",
            "highlight-1",
            &BookHighlightPatch {
                highlight_id: "highlight-1".to_string(),
                book_id: "book-1".to_string(),
                start_locator_json: json!({ "cfi": "epubcfi(/6/2!/4/2:0)" }),
                end_locator_json: json!({ "cfi": "epubcfi(/6/2!/4/2:8)" }),
                selected_text: "Selected".to_string(),
                color_argb: 0xffaa33,
                note: Some("Annotation".to_string()),
                created_at_ms: 300,
                updated_at_ms: 300,
            },
            2,
            config.retention_window,
        )
        .await
        .unwrap();
        let highlight_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM book_highlights WHERE scope_id = ? AND highlight_id = ?",
        )
        .bind("books:global")
        .bind("highlight-1")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(highlight_count, 1);

        delete_book_highlight_mutation(
            &pool,
            &session,
            "books:global",
            "highlight-1",
            3,
            config.retention_window,
        )
        .await
        .unwrap();
        let highlight_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM book_highlights WHERE scope_id = ? AND highlight_id = ?",
        )
        .bind("books:global")
        .bind("highlight-1")
        .fetch_one(&pool)
        .await
        .unwrap();
        let tombstone_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tombstones WHERE scope_id = ? AND entity_type = ? AND entity_id = ?",
        )
        .bind("books:global")
        .bind("book.highlight")
        .bind("highlight-1")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(highlight_count, 0);
        assert_eq!(tombstone_count, 1);
    }
}
