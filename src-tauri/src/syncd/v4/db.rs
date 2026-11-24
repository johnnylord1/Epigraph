//! SQLite persistence layer for Sync V4 (`v4_records`, `v4_change_log`,
//! `v4_mutation_receipts`, `v4_profile_watermarks`, `v4_extension_packages`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Value};
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool, Transaction};

use super::hlc::Hlc;
use super::merge::{
    merge_record, StoredRecordState, BOOK_POSITION_CLOCK, CHAPTER_CLOCKS, FIELD_CLOCKS,
};
use crate::syncd::db::now_ms;
use crate::syncd::{novel_plugin_settings, source_preferences};

/// Tombstones are retained for 90 days before compaction.
pub const V4_TOMBSTONE_RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// Client mutation idempotency receipts are retained for 30 days.
pub const V4_RECEIPT_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Maximum records returned by one `GET /v4/changes` page.
pub const V4_MAX_CHANGES_LIMIT: i64 = 2_000;
/// Default page size for `GET /v4/changes`.
pub const V4_DEFAULT_CHANGES_LIMIT: i64 = 1_000;
/// Maximum items accepted in a single `/v4/sync/bulk` request.
pub const V4_MAX_BULK_ITEMS: usize = 50_000;
/// Maximum items accepted in a single `/v4/deltas` request.
pub const V4_MAX_DELTA_ITEMS: usize = 500;

pub(super) const ALLOWED_DOMAINS: &[&str] =
    &["comics", "novels", "books", "extensions", "preferences"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V4IncomingItem {
    #[serde(default)]
    pub client_mutation_id: Option<String>,
    pub domain: String,
    pub entity_type: String,
    pub entity_key: String,
    #[serde(default)]
    pub deleted: bool,
    pub hlc: Hlc,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V4WireRecord<Payload = Value> {
    pub server_seq: i64,
    pub domain: String,
    pub entity_type: String,
    pub entity_key: String,
    pub deleted: bool,
    pub hlc: Hlc,
    pub origin_device_id: String,
    pub payload: Payload,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V4RejectedItem {
    pub index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_mutation_id: Option<String>,
    pub entity_type: String,
    pub entity_key: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V4WriteSummary {
    pub server_seq: i64,
    pub server_time_ms: i64,
    pub accepted_count: usize,
    pub merged_count: usize,
    pub deduplicated_count: usize,
    pub noop_count: usize,
    pub rejected: Vec<V4RejectedItem>,
    #[serde(skip)]
    pub committed_records: Vec<V4WireRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V4Watermark {
    pub current_seq: i64,
    pub min_replayable_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V4SnapshotResponse<Payload = Value> {
    pub protocol_version: u32,
    pub profile_id: String,
    pub server_seq: i64,
    pub min_replayable_seq: i64,
    pub server_time_ms: i64,
    pub record_count: usize,
    pub records: Vec<V4WireRecord<Payload>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V4ChangesResponse {
    pub protocol_version: u32,
    pub profile_id: String,
    pub server_seq: i64,
    pub min_replayable_seq: i64,
    pub next_seq: i64,
    pub has_more: bool,
    pub server_time_ms: i64,
    pub changes: Vec<V4WireRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V4ExtensionPackageMeta {
    pub kind: String,
    pub package_id: String,
    pub version: String,
    pub sha256: String,
    pub byte_size: i64,
    pub mime_type: String,
    pub uploaded_at_ms: i64,
}

pub async fn load_watermark(pool: &SqlitePool, profile_id: &str) -> anyhow::Result<V4Watermark> {
    read_watermark(pool, profile_id).await
}

async fn read_watermark<'a>(
    executor: impl sqlx::Executor<'a, Database = Sqlite>,
    profile_id: &str,
) -> anyhow::Result<V4Watermark> {
    let row = sqlx::query(
        r#"
        SELECT current_seq, min_replayable_seq
        FROM v4_profile_watermarks
        WHERE profile_id = ?
        "#,
    )
    .bind(profile_id)
    .fetch_optional(executor)
    .await?;

    Ok(match row {
        Some(row) => V4Watermark {
            current_seq: row.try_get("current_seq")?,
            min_replayable_seq: row.try_get("min_replayable_seq")?,
        },
        None => V4Watermark {
            current_seq: 0,
            min_replayable_seq: 0,
        },
    })
}

fn validate_incoming_item(item: &V4IncomingItem) -> Result<(), (&'static str, &'static str)> {
    if !ALLOWED_DOMAINS.contains(&item.domain.as_str()) {
        return Err((
            "INVALID_DOMAIN",
            "domain must be one of comics, novels, books, extensions, preferences",
        ));
    }
    if item.entity_type.trim().is_empty() || item.entity_type.len() > 96 {
        return Err(("INVALID_ENTITY_TYPE", "entityType must be 1..=96 chars"));
    }
    let domain_matches_type = match item.entity_type.split_once('.') {
        Some(("comic", suffix)) => !suffix.is_empty() && item.domain == "comics",
        Some(("novel", suffix)) => !suffix.is_empty() && item.domain == "novels",
        Some(("book", suffix)) => !suffix.is_empty() && item.domain == "books",
        Some(("extension", "pref")) | Some(("app", "pref")) => item.domain == "preferences",
        Some(("extension", suffix)) => !suffix.is_empty() && item.domain == "extensions",
        _ => false,
    };
    if !domain_matches_type {
        return Err((
            "INVALID_ENTITY_TYPE",
            "entityType must belong to its domain",
        ));
    }
    let expected_domain = match item.entity_type.split_once('.') {
        Some(("comic", _)) => "comics",
        Some(("novel", _)) => "novels",
        Some(("book", _)) => "books",
        Some(("extension", "repo" | "installed")) => "extensions",
        Some(("extension" | "app", "pref")) => "preferences",
        _ => {
            return Err((
                "INVALID_ENTITY_TYPE",
                "entityType is not supported by Sync V4",
            ))
        }
    };
    if item.domain != expected_domain {
        return Err((
            "INVALID_ENTITY_TYPE",
            "entityType does not belong to the supplied domain",
        ));
    }
    if item.entity_key.trim().is_empty() || item.entity_key.len() > 1024 {
        return Err(("INVALID_ENTITY_KEY", "entityKey must be 1..=1024 chars"));
    }
    if item.domain == "preferences" && !syncable_v4_preference(item) {
        return Err((
            "INVALID_PREFERENCE",
            "preference identity or value cannot be synchronized",
        ));
    }
    if let Err(msg) = item.hlc.validate() {
        return Err(("INVALID_HLC", msg));
    }
    if let Some(id) = &item.client_mutation_id {
        if id.trim().is_empty() || id.len() > 128 {
            return Err((
                "INVALID_MUTATION_ID",
                "clientMutationId must be 1..=128 chars",
            ));
        }
    }
    Ok(())
}

fn syncable_v4_preference(item: &V4IncomingItem) -> bool {
    let valid_key = if item.entity_type == "extension.pref" {
        let mut identity = item.entity_key.splitn(3, ':');
        match (identity.next(), identity.next(), identity.next()) {
            (Some("comic"), Some(owner), Some(key)) => {
                source_preferences::is_valid_source_id(owner)
                    && source_preferences::is_syncable_key(key)
            }
            (Some("novel"), Some(owner), Some(key)) => {
                novel_plugin_settings::is_syncable_setting(owner, key)
            }
            _ => false,
        }
    } else {
        item.entity_key
            .split_once(':')
            .is_some_and(|(namespace, key)| {
                source_preferences::is_syncable_key(namespace)
                    && source_preferences::is_syncable_key(key)
            })
    };
    valid_key
        && (item.deleted
            || item.payload.as_object().is_some_and(|fields| {
                if fields.len() != 2 {
                    return false;
                }
                let value = fields
                    .get("valueType")
                    .and_then(Value::as_str)
                    .zip(fields.get("value"));
                value
                    .and_then(|(kind, value)| {
                        source_preferences::PreferenceValue::from_typed(kind, value)
                    })
                    .is_some_and(|value| value.is_syncable())
            }))
}

const V4_SQL_BATCH_SIZE: usize = 256;

struct V4PendingChange {
    server_seq: i64,
    client_mutation_id: Option<String>,
    payload_json: String,
    state: StoredRecordState,
}

impl V4PendingChange {
    fn wire_record(&self, now: i64) -> V4WireRecord {
        V4WireRecord {
            server_seq: self.server_seq,
            domain: self.state.domain.clone(),
            entity_type: self.state.entity_type.clone(),
            entity_key: self.state.entity_key.clone(),
            deleted: self.state.deleted,
            hlc: self.state.hlc.clone(),
            origin_device_id: self.state.origin_device_id.clone(),
            payload: self.state.payload.clone(),
            updated_at_ms: now,
        }
    }
}

async fn load_v4_receipts(
    tx: &mut Transaction<'_, Sqlite>,
    profile_id: &str,
    device_id: &str,
    ids: HashSet<&str>,
) -> anyhow::Result<HashSet<String>> {
    let ids: Vec<_> = ids.into_iter().collect();
    let mut seen = HashSet::with_capacity(ids.len());
    for chunk in ids.chunks(V4_SQL_BATCH_SIZE) {
        let mut query = QueryBuilder::new(
            "SELECT client_mutation_id FROM v4_mutation_receipts WHERE profile_id = ",
        );
        query.push_bind(profile_id).push(" AND origin_device_id = ");
        query
            .push_bind(device_id)
            .push(" AND client_mutation_id IN (");
        let mut list = query.separated(", ");
        for id in chunk {
            list.push_bind(*id);
        }
        list.push_unseparated(")");
        seen.extend(
            query
                .build_query_scalar::<String>()
                .fetch_all(&mut **tx)
                .await?,
        );
    }
    Ok(seen)
}

async fn load_v4_records_for_keys(
    tx: &mut Transaction<'_, Sqlite>,
    profile_id: &str,
    keys: Vec<(&str, &str)>,
) -> anyhow::Result<HashMap<(String, String), StoredRecordState>> {
    let mut records = HashMap::new();
    for chunk in keys.chunks(V4_SQL_BATCH_SIZE) {
        let mut query = QueryBuilder::new("WITH keys(entity_type, entity_key) AS (");
        query.push_values(chunk, |mut row, (kind, key)| {
            row.push_bind(*kind).push_bind(*key);
        });
        query.push(
            ") SELECT r.domain, r.entity_type, r.entity_key, r.payload_json, r.deleted,
                      r.hlc_ts_ms, r.hlc_counter, r.hlc_device_id, r.origin_device_id
               FROM keys AS k CROSS JOIN v4_records AS r
               WHERE r.entity_type = k.entity_type AND r.entity_key = k.entity_key
                 AND r.profile_id = ",
        );
        query.push_bind(profile_id);
        for row in query.build().fetch_all(&mut **tx).await? {
            let entity_type: String = row.try_get("entity_type")?;
            let entity_key: String = row.try_get("entity_key")?;
            let payload_json: String = row.try_get("payload_json")?;
            let state = StoredRecordState {
                domain: row.try_get("domain")?,
                entity_type: entity_type.clone(),
                entity_key: entity_key.clone(),
                payload: serde_json::from_str(&payload_json)
                    .context("decode existing V4 record")?,
                deleted: row.try_get::<i64, _>("deleted")? != 0,
                hlc: Hlc::new(
                    row.try_get("hlc_ts_ms")?,
                    row.try_get("hlc_counter")?,
                    row.try_get::<String, _>("hlc_device_id")?,
                ),
                origin_device_id: row.try_get("origin_device_id")?,
            };
            records.insert((entity_type, entity_key), state);
        }
    }
    Ok(records)
}

async fn write_v4_changes(
    tx: &mut Transaction<'_, Sqlite>,
    profile_id: &str,
    now: i64,
    changes: &[V4PendingChange],
) -> anyhow::Result<()> {
    if changes.is_empty() {
        return Ok(());
    }
    let mut log = QueryBuilder::new(
        "INSERT INTO v4_change_log (
            server_seq, profile_id, domain, entity_type, entity_key, deleted, hlc_ts_ms,
            hlc_counter, hlc_device_id, origin_device_id, client_mutation_id, payload_json,
            created_at_ms)",
    );
    log.push_values(changes, |mut row, change| {
        let state = &change.state;
        row.push_bind(change.server_seq)
            .push_bind(profile_id)
            .push_bind(&state.domain)
            .push_bind(&state.entity_type)
            .push_bind(&state.entity_key)
            .push_bind(state.deleted)
            .push_bind(state.hlc.ts_ms)
            .push_bind(state.hlc.counter)
            .push_bind(&state.hlc.device_id)
            .push_bind(&state.origin_device_id)
            .push_bind(change.client_mutation_id.as_deref())
            .push_bind(&change.payload_json)
            .push_bind(now);
    });
    log.build().execute(&mut **tx).await?;
    let mut records = QueryBuilder::new(
        "INSERT INTO v4_records (
            profile_id, domain, entity_type, entity_key, payload_json, deleted, hlc_ts_ms,
            hlc_counter, hlc_device_id, origin_device_id, server_seq, updated_at_ms,
            deleted_at_ms)",
    );
    records.push_values(changes, |mut row, change| {
        let state = &change.state;
        row.push_bind(profile_id)
            .push_bind(&state.domain)
            .push_bind(&state.entity_type)
            .push_bind(&state.entity_key)
            .push_bind(&change.payload_json)
            .push_bind(state.deleted)
            .push_bind(state.hlc.ts_ms)
            .push_bind(state.hlc.counter)
            .push_bind(&state.hlc.device_id)
            .push_bind(&state.origin_device_id)
            .push_bind(change.server_seq)
            .push_bind(now)
            .push_bind(state.deleted.then_some(now));
    });
    records.push(
        " ON CONFLICT(profile_id, entity_type, entity_key) DO UPDATE SET
            domain = excluded.domain, payload_json = excluded.payload_json,
            deleted = excluded.deleted, hlc_ts_ms = excluded.hlc_ts_ms,
            hlc_counter = excluded.hlc_counter, hlc_device_id = excluded.hlc_device_id,
            origin_device_id = excluded.origin_device_id, server_seq = excluded.server_seq,
            updated_at_ms = excluded.updated_at_ms, deleted_at_ms = excluded.deleted_at_ms",
    );
    records.build().execute(&mut **tx).await?;
    Ok(())
}

async fn write_v4_receipts(
    tx: &mut Transaction<'_, Sqlite>,
    profile_id: &str,
    device_id: &str,
    now: i64,
    receipts: &[(String, i64)],
) -> anyhow::Result<()> {
    if receipts.is_empty() {
        return Ok(());
    }
    let mut query = QueryBuilder::new(
        "INSERT INTO v4_mutation_receipts
            (profile_id, origin_device_id, client_mutation_id, server_seq, created_at_ms)",
    );
    query.push_values(receipts, |mut row, (id, seq)| {
        row.push_bind(profile_id)
            .push_bind(device_id)
            .push_bind(id)
            .push_bind(*seq)
            .push_bind(now);
    });
    query.build().execute(&mut **tx).await?;
    Ok(())
}

/// Applies a batch of V4 records (either bulk initial sync or realtime deltas) inside a single
/// SQLite transaction. Invalid items are reported in `rejected` without EVER dropping valid items.
///
/// Caller MUST hold `V4Runtime::write_gate` so `server_seq` commits and broadcasts stay strictly ordered.
pub async fn apply_v4_batch(
    pool: &SqlitePool,
    profile_id: &str,
    origin_device_id: &str,
    items: Vec<V4IncomingItem>,
    collect_committed_records: bool,
) -> anyhow::Result<V4WriteSummary> {
    apply_v4_batch_with_bulk_state(
        pool,
        profile_id,
        origin_device_id,
        items,
        collect_committed_records,
        true,
    )
    .await
}

pub(super) async fn apply_v4_batch_with_bulk_state(
    pool: &SqlitePool,
    profile_id: &str,
    origin_device_id: &str,
    items: Vec<V4IncomingItem>,
    collect_committed_records: bool,
    final_bulk_batch: bool,
) -> anyhow::Result<V4WriteSummary> {
    let server_now = now_ms();
    let mut tx = pool.begin().await.context("begin v4 batch transaction")?;

    // Ensure profile watermark row exists.
    sqlx::query(
        r#"
        INSERT INTO v4_profile_watermarks (profile_id, current_seq, min_replayable_seq, updated_at_ms)
        VALUES (?, 0, 0, ?)
        ON CONFLICT(profile_id) DO NOTHING
        "#,
    )
    .bind(profile_id)
    .bind(server_now)
    .execute(&mut *tx)
    .await?;

    let mut current_seq: i64 =
        sqlx::query_scalar("SELECT current_seq FROM v4_profile_watermarks WHERE profile_id = ?")
            .bind(profile_id)
            .fetch_one(&mut *tx)
            .await?;
    // The watermark insert above already holds SQLite's writer lock. Reserve the next
    // global sequences from AUTOINCREMENT under that lock, including across profiles
    // and after retention removes the last rows from the log.
    let mut global_seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'v4_change_log'), 0)",
    )
    .fetch_one(&mut *tx)
    .await?;
    let wanted_receipts = items
        .iter()
        .filter_map(|item| item.client_mutation_id.as_deref())
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .collect::<HashSet<_>>();
    let mut seen_receipts =
        load_v4_receipts(&mut tx, profile_id, origin_device_id, wanted_receipts).await?;

    // Initial uploads can arrive as several disjoint batches. Read existing rows for
    // the current batch only and preserve intermediate merge state for repeated keys.
    let mut unique = HashSet::with_capacity(items.len());
    let mut repeated = HashSet::new();
    for item in &items {
        let key = (item.entity_type.as_str(), item.entity_key.as_str());
        if !unique.insert(key) {
            repeated.insert((item.entity_type.clone(), item.entity_key.clone()));
        }
    }
    let mut existing_cache = if current_seq == 0 {
        HashMap::new()
    } else {
        load_v4_records_for_keys(&mut tx, profile_id, unique.into_iter().collect()).await?
    };

    let mut accepted_count = 0usize;
    let mut merged_count = 0usize;
    let mut deduplicated_count = 0usize;
    let mut noop_count = 0usize;
    let mut rejected = Vec::new();
    let mut committed_records = Vec::new();
    let mut changes = Vec::with_capacity(V4_SQL_BATCH_SIZE);
    let mut receipts = Vec::with_capacity(V4_SQL_BATCH_SIZE);
    let mut comics_target = None;

    for (index, item) in items.into_iter().enumerate() {
        if let Err((code, message)) = validate_incoming_item(&item) {
            rejected.push(V4RejectedItem {
                index,
                client_mutation_id: item.client_mutation_id,
                entity_type: item.entity_type,
                entity_key: item.entity_key,
                code: code.to_string(),
                message: message.to_string(),
            });
            continue;
        }

        // Idempotency receipt check.
        if let Some(mutation_id) = &item.client_mutation_id {
            if !seen_receipts.insert(mutation_id.clone()) {
                deduplicated_count += 1;
                continue;
            }
        }

        let cache_key = (item.entity_type.clone(), item.entity_key.clone());

        let clamped_hlc = item.hlc.clamp_to_server_now(server_now);
        let mut payload = if item.deleted {
            Value::Null
        } else {
            item.payload
        };
        if let Some(object) = payload.as_object_mut() {
            object.remove(FIELD_CLOCKS);
            object.remove(CHAPTER_CLOCKS);
            object.remove(BOOK_POSITION_CLOCK);
        }
        let incoming_state = StoredRecordState {
            domain: item.domain,
            entity_type: item.entity_type,
            entity_key: item.entity_key,
            payload,
            deleted: item.deleted,
            hlc: clamped_hlc,
            origin_device_id: origin_device_id.to_string(),
        };

        let outcome = merge_record(existing_cache.get(&cache_key), incoming_state);
        let receipt_seq = if !outcome.changed {
            noop_count += 1;
            current_seq
        } else {
            global_seq = global_seq
                .checked_add(1)
                .context("V4 change sequence exhausted")?;
            current_seq = global_seq;
            let change = V4PendingChange {
                server_seq: current_seq,
                client_mutation_id: item.client_mutation_id.clone(),
                payload_json: serde_json::to_string(&outcome.state.payload)
                    .context("serialize v4 record payload")?,
                state: outcome.state,
            };
            if change.state.domain == "comics" {
                comics_target = Some(current_seq);
            }
            if outcome.merged {
                merged_count += 1;
            } else {
                accepted_count += 1;
            }
            if collect_committed_records {
                committed_records.push(change.wire_record(server_now));
            }
            if repeated.contains(&cache_key) {
                existing_cache.insert(cache_key, change.state.clone());
            }
            changes.push(change);
            current_seq
        };
        if let Some(mutation_id) = item.client_mutation_id {
            receipts.push((mutation_id, receipt_seq));
        }
        if changes.len() == V4_SQL_BATCH_SIZE || receipts.len() == V4_SQL_BATCH_SIZE {
            write_v4_changes(&mut tx, profile_id, server_now, &changes).await?;
            write_v4_receipts(&mut tx, profile_id, origin_device_id, server_now, &receipts).await?;
            changes.clear();
            receipts.clear();
        }
    }
    write_v4_changes(&mut tx, profile_id, server_now, &changes).await?;
    write_v4_receipts(&mut tx, profile_id, origin_device_id, server_now, &receipts).await?;

    if let Some(target) = comics_target {
        sqlx::query(
            "INSERT INTO v4_comics_projection (profile_id, target_seq, next_attempt_ms)
             VALUES (?, ?, ?)
             ON CONFLICT(profile_id) DO UPDATE SET
               target_seq = excluded.target_seq,
               next_attempt_ms = CASE
                 WHEN ? AND v4_comics_projection.applied_seq = 0
                      AND v4_comics_projection.next_attempt_ms > ?
                 THEN v4_comics_projection.next_attempt_ms
                 ELSE excluded.next_attempt_ms END",
        )
        .bind(profile_id)
        .bind(target)
        .bind(if final_bulk_batch {
            server_now
        } else {
            server_now + 30_000
        })
        .bind(collect_committed_records)
        .bind(server_now)
        .execute(&mut *tx)
        .await?;
    }
    if final_bulk_batch && !collect_committed_records {
        // The final chunk can contain just novels or books. It still releases the
        // comic restore accumulated by the preceding chunks.
        sqlx::query(
            "UPDATE v4_comics_projection SET next_attempt_ms = ?
             WHERE profile_id = ? AND applied_seq < target_seq AND next_attempt_ms > ?",
        )
        .bind(server_now)
        .bind(profile_id)
        .bind(server_now)
        .execute(&mut *tx)
        .await?;
    }

    if accepted_count > 0 || merged_count > 0 {
        sqlx::query(
            r#"
            UPDATE v4_profile_watermarks
            SET current_seq = ?, updated_at_ms = ?
            WHERE profile_id = ?
            "#,
        )
        .bind(current_seq)
        .bind(server_now)
        .bind(profile_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await.context("commit v4 batch transaction")?;

    Ok(V4WriteSummary {
        server_seq: current_seq,
        server_time_ms: server_now,
        accepted_count,
        merged_count,
        deduplicated_count,
        noop_count,
        rejected,
        committed_records,
    })
}

pub async fn load_snapshot(
    pool: &SqlitePool,
    profile_id: &str,
    domain_filter: Option<&str>,
    include_tombstones: bool,
) -> anyhow::Result<V4SnapshotResponse<Box<RawValue>>> {
    let mut tx = pool.begin().await?;
    let watermark = read_watermark(&mut *tx, profile_id).await?;
    let rows = match (domain_filter, include_tombstones) {
        (Some(domain), true) => {
            sqlx::query(
                r#"
                SELECT server_seq, domain, entity_type, entity_key, deleted,
                       hlc_ts_ms, hlc_counter, hlc_device_id, origin_device_id,
                       payload_json, updated_at_ms
                FROM v4_records
                WHERE profile_id = ? AND domain = ?
                ORDER BY server_seq ASC
                "#,
            )
            .bind(profile_id)
            .bind(domain)
            .fetch_all(&mut *tx)
            .await?
        }
        (Some(domain), false) => {
            sqlx::query(
                r#"
                SELECT server_seq, domain, entity_type, entity_key, deleted,
                       hlc_ts_ms, hlc_counter, hlc_device_id, origin_device_id,
                       payload_json, updated_at_ms
                FROM v4_records
                WHERE profile_id = ? AND domain = ? AND deleted = 0
                ORDER BY server_seq ASC
                "#,
            )
            .bind(profile_id)
            .bind(domain)
            .fetch_all(&mut *tx)
            .await?
        }
        (None, true) => {
            sqlx::query(
                r#"
                SELECT server_seq, domain, entity_type, entity_key, deleted,
                       hlc_ts_ms, hlc_counter, hlc_device_id, origin_device_id,
                       payload_json, updated_at_ms
                FROM v4_records
                WHERE profile_id = ?
                ORDER BY server_seq ASC
                "#,
            )
            .bind(profile_id)
            .fetch_all(&mut *tx)
            .await?
        }
        (None, false) => {
            sqlx::query(
                r#"
                SELECT server_seq, domain, entity_type, entity_key, deleted,
                       hlc_ts_ms, hlc_counter, hlc_device_id, origin_device_id,
                       payload_json, updated_at_ms
                FROM v4_records
                WHERE profile_id = ? AND deleted = 0
                ORDER BY server_seq ASC
                "#,
            )
            .bind(profile_id)
            .fetch_all(&mut *tx)
            .await?
        }
    };
    tx.commit().await?;

    let mut records = Vec::with_capacity(rows.len());
    for row in rows {
        let payload_raw: String = row.try_get("payload_json")?;
        records.push(V4WireRecord {
            server_seq: row.try_get("server_seq")?,
            domain: row.try_get("domain")?,
            entity_type: row.try_get("entity_type")?,
            entity_key: row.try_get("entity_key")?,
            deleted: row.try_get::<i64, _>("deleted")? != 0,
            hlc: Hlc::new(
                row.try_get("hlc_ts_ms")?,
                row.try_get("hlc_counter")?,
                row.try_get::<String, _>("hlc_device_id")?,
            ),
            origin_device_id: row.try_get("origin_device_id")?,
            payload: RawValue::from_string(payload_raw).context("decode V4 snapshot payload")?,
            updated_at_ms: row.try_get("updated_at_ms")?,
        });
    }

    let record_count = records.len();
    Ok(V4SnapshotResponse {
        protocol_version: 4,
        profile_id: profile_id.to_string(),
        server_seq: watermark.current_seq,
        min_replayable_seq: watermark.min_replayable_seq,
        server_time_ms: now_ms(),
        record_count,
        records,
    })
}

pub(super) async fn load_changed_comics(
    pool: &SqlitePool,
    profile: &str,
    after: i64,
    through: i64,
) -> anyhow::Result<Vec<V4WireRecord>> {
    let rows = sqlx::query(
        "SELECT server_seq, domain, entity_type, entity_key, deleted, hlc_ts_ms, hlc_counter,
                hlc_device_id, origin_device_id, payload_json, updated_at_ms
         FROM v4_records
         WHERE profile_id = ? AND domain = 'comics' AND server_seq > ? AND server_seq <= ?
         ORDER BY server_seq",
    )
    .bind(profile)
    .bind(after)
    .bind(through)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            let payload_json: String = row.try_get("payload_json")?;
            Ok(V4WireRecord {
                server_seq: row.try_get("server_seq")?,
                domain: row.try_get("domain")?,
                entity_type: row.try_get("entity_type")?,
                entity_key: row.try_get("entity_key")?,
                deleted: row.try_get("deleted")?,
                hlc: Hlc::new(
                    row.try_get("hlc_ts_ms")?,
                    row.try_get("hlc_counter")?,
                    row.try_get::<String, _>("hlc_device_id")?,
                ),
                origin_device_id: row.try_get("origin_device_id")?,
                payload: serde_json::from_str(&payload_json)?,
                updated_at_ms: row.try_get("updated_at_ms")?,
            })
        })
        .collect()
}

pub enum V4ChangesResult {
    Page(V4ChangesResponse),
    ReplayWindowExpired {
        current_seq: i64,
        min_replayable_seq: i64,
    },
    CursorAhead {
        cursor: i64,
        current_seq: i64,
        min_replayable_seq: i64,
    },
}

pub async fn load_changes_paged(
    pool: &SqlitePool,
    profile_id: &str,
    since_seq: i64,
    limit: i64,
) -> anyhow::Result<V4ChangesResult> {
    let mut tx = pool.begin().await?;
    let watermark = read_watermark(&mut *tx, profile_id).await?;
    if since_seq < watermark.min_replayable_seq {
        return Ok(V4ChangesResult::ReplayWindowExpired {
            current_seq: watermark.current_seq,
            min_replayable_seq: watermark.min_replayable_seq,
        });
    }
    if since_seq > watermark.current_seq {
        return Ok(V4ChangesResult::CursorAhead {
            cursor: since_seq,
            current_seq: watermark.current_seq,
            min_replayable_seq: watermark.min_replayable_seq,
        });
    }

    let clamped_limit = limit.clamp(1, V4_MAX_CHANGES_LIMIT);
    let fetch_limit = clamped_limit + 1;

    let rows = sqlx::query(
        r#"
        SELECT server_seq, domain, entity_type, entity_key, deleted,
               hlc_ts_ms, hlc_counter, hlc_device_id, origin_device_id,
               payload_json, created_at_ms
        FROM v4_change_log
        WHERE profile_id = ? AND server_seq > ?
        ORDER BY server_seq ASC
        LIMIT ?
        "#,
    )
    .bind(profile_id)
    .bind(since_seq)
    .bind(fetch_limit)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    let has_more = rows.len() as i64 > clamped_limit;
    let take_len = rows.len().min(clamped_limit as usize);
    let mut changes = Vec::with_capacity(take_len);
    for row in rows.into_iter().take(take_len) {
        let payload_raw: String = row.try_get("payload_json")?;
        changes.push(V4WireRecord {
            server_seq: row.try_get("server_seq")?,
            domain: row.try_get("domain")?,
            entity_type: row.try_get("entity_type")?,
            entity_key: row.try_get("entity_key")?,
            deleted: row.try_get::<i64, _>("deleted")? != 0,
            hlc: Hlc::new(
                row.try_get("hlc_ts_ms")?,
                row.try_get("hlc_counter")?,
                row.try_get::<String, _>("hlc_device_id")?,
            ),
            origin_device_id: row.try_get("origin_device_id")?,
            payload: serde_json::from_str(&payload_raw).unwrap_or(Value::Null),
            updated_at_ms: row.try_get("created_at_ms")?,
        });
    }

    let next_seq = changes
        .last()
        .map(|item| item.server_seq)
        .unwrap_or(since_seq);

    Ok(V4ChangesResult::Page(V4ChangesResponse {
        protocol_version: 4,
        profile_id: profile_id.to_string(),
        server_seq: watermark.current_seq,
        min_replayable_seq: watermark.min_replayable_seq,
        next_seq,
        has_more,
        server_time_ms: now_ms(),
        changes,
    }))
}

pub async fn prune_v4_expired(pool: &SqlitePool, now_ms: i64) -> anyhow::Result<()> {
    let receipt_cutoff = now_ms.saturating_sub(V4_RECEIPT_RETENTION_MS);
    sqlx::query("DELETE FROM v4_mutation_receipts WHERE created_at_ms < ?")
        .bind(receipt_cutoff)
        .execute(pool)
        .await?;

    let tombstone_cutoff = now_ms.saturating_sub(V4_TOMBSTONE_RETENTION_MS);
    let mut tx = pool.begin().await?;

    // Advance min_replayable_seq for profiles that have expired change_log entries.
    let expired_profiles = sqlx::query(
        r#"
        SELECT profile_id, MAX(server_seq) AS max_expired_seq
        FROM v4_change_log
        WHERE created_at_ms < ?
        GROUP BY profile_id
        "#,
    )
    .bind(tombstone_cutoff)
    .fetch_all(&mut *tx)
    .await?;

    for row in expired_profiles {
        let profile_id: String = row.try_get("profile_id")?;
        let max_expired_seq: i64 = row.try_get("max_expired_seq")?;
        sqlx::query(
            r#"
            UPDATE v4_profile_watermarks
            SET min_replayable_seq = MAX(min_replayable_seq, ?), updated_at_ms = ?
            WHERE profile_id = ?
            "#,
        )
        .bind(max_expired_seq)
        .bind(now_ms)
        .bind(&profile_id)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query("DELETE FROM v4_change_log WHERE created_at_ms < ?")
        .bind(tombstone_cutoff)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM v4_records WHERE deleted = 1 AND deleted_at_ms < ?")
        .bind(tombstone_cutoff)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(())
}

// --- LAN Extension Package Cache (Pista 2: APKs & JS Plugins) ---

pub fn extension_package_blob_path(data_dir: &Path, sha256: &str) -> PathBuf {
    data_dir.join("v4-ext-packages").join(sha256)
}

pub async fn load_extension_package_meta(
    pool: &SqlitePool,
    kind: &str,
    package_id: &str,
    version: &str,
) -> anyhow::Result<Option<V4ExtensionPackageMeta>> {
    let row = sqlx::query(
        r#"
        SELECT kind, package_id, version, sha256, byte_size, mime_type, uploaded_at_ms
        FROM v4_extension_packages
        WHERE kind = ? AND package_id = ? AND version = ?
        "#,
    )
    .bind(kind)
    .bind(package_id)
    .bind(version)
    .fetch_optional(pool)
    .await?;

    Ok(match row {
        Some(row) => Some(V4ExtensionPackageMeta {
            kind: row.try_get("kind")?,
            package_id: row.try_get("package_id")?,
            version: row.try_get("version")?,
            sha256: row.try_get("sha256")?,
            byte_size: row.try_get("byte_size")?,
            mime_type: row.try_get("mime_type")?,
            uploaded_at_ms: row.try_get("uploaded_at_ms")?,
        }),
        None => None,
    })
}

pub async fn upsert_extension_package_meta(
    pool: &SqlitePool,
    meta: &V4ExtensionPackageMeta,
    uploaded_by_device_id: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO v4_extension_packages (
            kind, package_id, version, sha256, byte_size, mime_type,
            uploaded_by_device_id, uploaded_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(kind, package_id, version) DO UPDATE SET
            sha256 = excluded.sha256,
            byte_size = excluded.byte_size,
            mime_type = excluded.mime_type,
            uploaded_by_device_id = excluded.uploaded_by_device_id,
            uploaded_at_ms = excluded.uploaded_at_ms
        "#,
    )
    .bind(&meta.kind)
    .bind(&meta.package_id)
    .bind(&meta.version)
    .bind(&meta.sha256)
    .bind(meta.byte_size)
    .bind(&meta.mime_type)
    .bind(uploaded_by_device_id)
    .bind(meta.uploaded_at_ms)
    .execute(pool)
    .await?;
    Ok(())
}
