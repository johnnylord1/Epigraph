use std::cmp::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context};
use serde::Serialize;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::ConnectOptions;
use sqlx::FromRow;
use uuid::Uuid;

use super::config::SyncdConfig;
use super::models::{
    canonical_novel_identity_key, canonical_novel_identity_key_from_source, AuthenticatedSession,
    BookBookmarkPatch, BookBookmarkRecord, BookBookmarkRow, BookCategoryAssignmentPatch,
    BookCategoryAssignmentRecord, BookCategoryAssignmentRow, BookCategoryPatch, BookCategoryRecord,
    BookCategoryRow, BookEntryPatch, BookEntryRecord, BookEntryRow, BookHistoryPatch,
    BookHistoryRecord, BookHistoryRow, BookLibraryUiPatch, BookLibraryUiRecord, BookLibraryUiRow,
    BookProgressPatch, BookProgressRecord, BookProgressRow, ChangeEnvelope, ChangeLogRow,
    ComicHistoryPatch, ComicHistoryRecord, ComicHistoryRow, ComicPageBookmarkPatch,
    ComicPageBookmarkRecord, ComicPageBookmarkRow, MutationOperation, MutationReceiptContext,
    MutationResult, MutationResultStatus, NovelBookmarkPatch, NovelBookmarkRecord,
    NovelBookmarkRow, NovelCategoryAssignmentPatch, NovelCategoryAssignmentRecord,
    NovelCategoryAssignmentRow, NovelCategoryPatch, NovelCategoryRecord, NovelCategoryRow,
    NovelChapterPatch, NovelChapterRecord, NovelChapterRow, NovelClassificationPatch,
    NovelClassificationRecord, NovelClassificationRow, NovelEntryPatch, NovelEntryRecord,
    NovelEntryRow, NovelHistoryPatch, NovelHistoryRecord, NovelHistoryRow, NovelProgressPatch,
    NovelProgressRecord, NovelProgressRow, PairingGrantVia, PairingPlatform, ServerRuntimeRow,
    SnapshotEntity, SnapshotResponse, SnapshotTombstone, SNAPSHOT_SCHEMA_VERSION,
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
    InvalidStatus(String),
    Storage(String),
}

#[derive(Debug, Clone)]
pub struct MutationWriteOutcome {
    pub envelope: ChangeEnvelope,
    pub record: Value,
    pub applied_lamport: i64,
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
    result_json: String,
}

pub async fn lookup_mutation_receipt(
    pool: &sqlx::SqlitePool,
    device_id: &str,
    client_mutation_id: &str,
    mutation_hash: &str,
) -> anyhow::Result<MutationReceiptLookup> {
    let row = sqlx::query_as::<_, MutationReceiptRow>(
        r#"
        SELECT mutation_hash, result_json
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
    if row.mutation_hash != mutation_hash {
        return Ok(MutationReceiptLookup::Conflict {
            existing_hash: row.mutation_hash,
        });
    }

    let result = serde_json::from_str(&row.result_json)
        .context("stored mutation receipt contains an invalid result")?;
    Ok(MutationReceiptLookup::Match(result))
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
        ) VALUES (?, ?, ?, ?, ?, NULL, ?)
        "#,
    )
    .bind(&context.device_id)
    .bind(&context.client_mutation_id)
    .bind(&context.mutation_hash)
    .bind(&context.mutation_json)
    .bind(result_json)
    .bind(now_ms())
    .execute(pool)
    .await?;

    lookup_mutation_receipt(
        pool,
        &context.device_id,
        &context.client_mutation_id,
        &context.mutation_hash,
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

    MIGRATOR
        .run(&pool)
        .await
        .context("failed to run syncd migrations")?;
    Ok(pool)
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
            push_snapshot_entity(
                &mut entities,
                "novel.progress",
                entity_id,
                server_version,
                lamport,
                NovelProgressRecord::from(row),
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
    } else if scope_id.starts_with("comics:profile:") {
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
    Ok(SnapshotResponse {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
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
            created_at_ms
        ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL, NULL, NULL, ?)
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
            created_at_ms
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
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
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
) -> Result<PairingClaimOutcome, PairingClaimError> {
    let mut tx = pool.begin().await.map_err(storage_pairing_claim_error)?;
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

    match session.status.as_str() {
        "pending" => {
            sqlx::query(
                r#"
                UPDATE pairing_sessions
                SET status = 'claimed',
                    claimed_device_id = ?,
                    claimed_device_name = ?,
                    claimed_platform = ?,
                    claimed_at_ms = COALESCE(claimed_at_ms, ?)
                WHERE session_id = ?
                "#,
            )
            .bind(device_id)
            .bind(device_name)
            .bind(platform.as_str())
            .bind(now_ms)
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
            tx.commit().await.map_err(storage_pairing_claim_error)?;
            return Ok(PairingClaimOutcome::Rejected(session));
        }
        "approved" => {
            if session.claimed_device_id.as_deref() != Some(device_id) {
                return Err(PairingClaimError::ApprovedForDifferentDevice);
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
            created_at_ms
        FROM pairing_sessions
        WHERE session_id = ?
        "#,
    )
    .bind(session_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row)
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
    let access_token = format!("aethon_{}", Uuid::now_v7());
    let token_hash = hash_token(&access_token);
    let trusted_host_id = "syncd-local-host";
    let scopes = vec![
        "books:global".to_string(),
        format!("novels:profile:{}", session.profile_id),
        format!("comics:profile:{}", session.profile_id),
    ];

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
    let mut tx = pool.begin().await?;
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

pub async fn prune_expired_rows(pool: &sqlx::SqlitePool, now_ms: i64) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM tombstones WHERE retain_until_ms < ?")
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM change_log WHERE replay_until_ms < ?")
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
    let mut tx = pool.begin().await?;
    let current = sqlx::query_as::<_, BookEntryRow>(
        r#"
        SELECT
            scope_id, book_id, asset_fingerprint, title, author, description, subtype, page_count,
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
            scope_id, book_id, asset_fingerprint, title, author, description, subtype, page_count,
            toc_count, spine_count, section_count, sections_summary_json, has_cover, created_at_ms,
            book_updated_at_ms, record_updated_at_ms, record_updated_by_device_id, record_lamport,
            record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, book_id) DO UPDATE SET
            asset_fingerprint = excluded.asset_fingerprint,
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

pub async fn delete_book_entry_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = pool.begin().await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "book.entry", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
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
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = pool.begin().await?;
    let current = sqlx::query_as::<_, BookCategoryRow>(
        r#"SELECT scope_id, category_id, name, sort_order, record_updated_at_ms, record_updated_by_device_id, record_lamport, record_server_version
        FROM book_categories WHERE scope_id = ? AND category_id = ?"#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "book.category", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_against_tombstone(client_lamport, tombstone)?;
    }
    let merged = merge_book_category(current.map(Into::into), entity_id, patch, client_lamport)?;
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
    tx.commit().await?;
    Ok(MutationWriteOutcome {
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
    })
}

pub async fn delete_book_category_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = pool.begin().await?;
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
    tx.commit().await?;
    Ok(MutationWriteOutcome {
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
    })
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
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
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

pub async fn delete_novel_entry_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
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

pub async fn apply_novel_history_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelHistoryPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
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

pub async fn apply_novel_category_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelCategoryPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = pool.begin().await?;
    let current = sqlx::query_as::<_, NovelCategoryRow>(
        "SELECT * FROM novel_categories WHERE scope_id = ? AND category_id = ?",
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;
    let tombstone = load_tombstone_in_tx(&mut tx, scope_id, "novel.category", entity_id).await?;
    if let Some(tombstone) = tombstone.as_ref() {
        ensure_not_stale_novel_category_against_tombstone(client_lamport, tombstone)?;
    }
    let merged = merge_novel_category(current.map(Into::into), entity_id, patch, client_lamport)?;
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
    tx.commit().await?;
    Ok(MutationWriteOutcome {
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
    })
}

pub async fn delete_novel_category_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = pool.begin().await?;
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
    tx.commit().await?;
    Ok(MutationWriteOutcome {
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
    })
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
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
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

pub async fn apply_book_progress_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &BookProgressPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = pool.begin().await?;
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
    .bind(entity_id)
    .fetch_optional(&mut *tx)
    .await?;

    let merged = merge_book_progress(current.map(Into::into), entity_id, patch, client_lamport)?;
    let record = serde_json::to_value(&merged)?;
    let profile_id = None;
    let (server_version, applied_at_ms) = append_change_log_in_tx(
        &mut tx,
        scope_id,
        profile_id,
        "book.progress",
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
    .bind(entity_id)
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

    tx.commit().await?;

    Ok(MutationWriteOutcome {
        envelope: ChangeEnvelope {
            server_version,
            scope_id: scope_id.to_string(),
            profile_id: None,
            entity_type: "book.progress".to_string(),
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

pub async fn apply_novel_progress_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelProgressPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = pool.begin().await?;
    let current = sqlx::query_as::<_, NovelProgressRow>(
        r#"
        SELECT
            scope_id,
            novel_id,
            chapter_id,
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

    let merged = merge_novel_progress(current.map(Into::into), entity_id, patch, client_lamport)?;
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, novel_id) DO UPDATE SET
            chapter_id = excluded.chapter_id,
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

    tx.commit().await?;

    Ok(MutationWriteOutcome {
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
    })
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
    let mut tx = pool.begin().await?;
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
            saved_at_ms,
            record_updated_at_ms,
            record_updated_by_device_id,
            record_lamport,
            record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, bookmark_id) DO UPDATE SET
            book_id = excluded.book_id,
            location = excluded.location,
            href = excluded.href,
            page_index = excluded.page_index,
            progress_percent = excluded.progress_percent,
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
    .bind(&merged.book_id)
    .bind(merged.location.as_deref())
    .bind(merged.href.as_deref())
    .bind(merged.page_index)
    .bind(merged.progress_percent)
    .bind(merged.label.as_deref())
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

pub async fn apply_novel_bookmark_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &NovelBookmarkPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
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

pub async fn delete_novel_bookmark_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
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

pub async fn apply_comic_history_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    patch: &ComicHistoryPatch,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = pool.begin().await?;
    let current = sqlx::query_as::<_, ComicHistoryRow>(
        r#"
        SELECT
            scope_id, history_id, comic_id, chapter_id, page_index, page_count,
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

    sqlx::query(
        r#"
        INSERT INTO comic_history (
            scope_id, history_id, comic_id, chapter_id, page_index, page_count,
            progress_percent, read_at_ms, record_updated_at_ms,
            record_updated_by_device_id, record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, history_id) DO UPDATE SET
            comic_id = excluded.comic_id,
            chapter_id = excluded.chapter_id,
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

    if tombstone.is_some() {
        delete_tombstone_in_tx(&mut tx, scope_id, "comic.history", entity_id).await?;
    }
    tx.commit().await?;

    Ok(MutationWriteOutcome {
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
    })
}

pub async fn delete_comic_history_mutation(
    pool: &sqlx::SqlitePool,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    client_lamport: i64,
    retention_window: Duration,
) -> anyhow::Result<MutationWriteOutcome> {
    let mut tx = pool.begin().await?;
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
    let mut tx = pool.begin().await?;
    let current = sqlx::query_as::<_, ComicPageBookmarkRow>(
        r#"
        SELECT
            scope_id, bookmark_id, comic_id, chapter_id, page_index, page_count,
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

    sqlx::query(
        r#"
        INSERT INTO comic_page_bookmarks (
            scope_id, bookmark_id, comic_id, chapter_id, page_index, page_count,
            label, saved_at_ms, record_updated_at_ms, record_updated_by_device_id,
            record_lamport, record_server_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, bookmark_id) DO UPDATE SET
            comic_id = excluded.comic_id,
            chapter_id = excluded.chapter_id,
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
    let mut tx = pool.begin().await?;
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
        Some(existing) => BookEntryRecord {
            record_lamport: next_lamport(existing.record_lamport, client_lamport),
            ..incoming
        },
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
) -> anyhow::Result<BookProgressRecord> {
    let book_id = entity_id
        .strip_prefix("book.progress::")
        .unwrap_or(entity_id)
        .to_string();
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
            let winner = if patch.reset {
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
) -> anyhow::Result<NovelProgressRecord> {
    let novel_id = entity_id
        .strip_prefix("novel.progress::")
        .unwrap_or(entity_id)
        .to_string();
    let incoming = NovelProgressRecord {
        novel_id,
        chapter_id: normalize_optional_string(patch.chapter_id.as_deref()),
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
            let winner = if patch.reset {
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

fn merge_book_bookmark(
    current: Option<BookBookmarkRecord>,
    entity_id: &str,
    patch: &BookBookmarkPatch,
    client_lamport: i64,
) -> anyhow::Result<BookBookmarkRecord> {
    let incoming = BookBookmarkRecord {
        bookmark_id: entity_id.to_string(),
        book_id: patch.book_id.clone(),
        location: normalize_optional_string(patch.location.as_deref()),
        href: normalize_optional_string(patch.href.as_deref()),
        page_index: patch.page_index,
        progress_percent: patch.progress_percent,
        label: normalize_optional_string(patch.label.as_deref()),
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
    book_bookmark_strength(left)
        .cmp(&book_bookmark_strength(right))
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
    let access_token = format!("aethon_local_{}", Uuid::now_v7());
    let token_hash = hash_token(&access_token);
    let trusted_host_id = "syncd-local-authority";
    let scopes = vec![
        "books:global".to_string(),
        format!("novels:profile:{profile_id}"),
        format!("comics:profile:{profile_id}"),
    ];

    let mut tx = pool.begin().await?;

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
    .bind("Aethon local authority")
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

        let merged = merge_book_progress(Some(current), "book-1", &patch, 99).unwrap();
        assert_eq!(merged.page_index, Some(20));
        assert_eq!(merged.progress_percent, 0.6);
        assert_eq!(merged.record_lamport, 100);
    }

    #[test]
    fn novel_progress_merge_keeps_higher_chapter_even_with_newer_lamport() {
        let current = NovelProgressRecord {
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
            chapter_id: Some("c19".to_string()),
            chapter_title: Some("Nineteen".to_string()),
            chapter_order_key: Some(19.0),
            progress_percent: 0.9,
            locator: Some("/19#p9".to_string()),
            locator_sort_key: Some(9.0),
            updated_at_ms: 2000,
            reset: false,
        };

        let merged = merge_novel_progress(Some(current), "novel-1", &patch, 77).unwrap();
        assert_eq!(merged.chapter_order_key, Some(20.0));
        assert_eq!(merged.chapter_id.as_deref(), Some("c20"));
        assert_eq!(merged.record_lamport, 78);
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

        let merged = merge_book_progress(None, "book.progress::book-1", &patch, 3).unwrap();
        assert_eq!(merged.book_id, "book-1");
    }

    #[test]
    fn novel_progress_merge_strips_entity_prefix_from_persisted_novel_id() {
        let patch = NovelProgressPatch {
            chapter_id: Some("c1".to_string()),
            chapter_title: Some("One".to_string()),
            chapter_order_key: Some(1.0),
            progress_percent: 1.0,
            locator: Some("/1".to_string()),
            locator_sort_key: Some(1.0),
            updated_at_ms: 1000,
            reset: false,
        };

        let merged = merge_novel_progress(None, "novel.progress::novel-1", &patch, 7).unwrap();
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
}
