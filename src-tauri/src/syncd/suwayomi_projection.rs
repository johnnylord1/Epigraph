use std::collections::BTreeSet;
use std::time::Duration;

use anyhow::Context;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::FromRow;

use super::lifecycle::{wait_for_shutdown_request, ShutdownRequest};
use super::models::{
    canonical_portable_chapter_id, canonical_portable_work_id, AppError, AuthenticatedSession,
    PortableChapterRefV3, PortableResolutionStateV3, PortableWorkBindingRow, PortableWorkRefV3,
    SharedAppState,
};
use super::routes::suwayomi_commands::{self, CommandOperation};
use super::routes::suwayomi_proxy;
use super::{db, routes::suwayomi_catalog};

const MAX_BATCH: usize = 8;
const LEASE_MS: i64 = 60_000;
const BASE_RETRY_MS: i64 = 30_000;
const MAX_RETRY_MS: i64 = 6 * 60 * 60 * 1_000;
/// Backoff ceiling while the local Suwayomi runtime is unreachable. Retrying rows count as pending
/// in `/v1/sync/status` and mobile defers its whole catalog reconciliation meanwhile, so once the
/// runtime is back the queue must clear within minutes instead of waiting out an hours-long delay.
/// Probing a local runtime this often is cheap.
const MAX_RUNTIME_RETRY_MS: i64 = 5 * 60 * 1_000;
const RUNTIME_UNAVAILABLE: &str = "runtime_unavailable";
/// How long a probe of a runtime that projections wait on may take before it counts as down.
const RUNTIME_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// While an earlier projection of the same profile is in its first retries (a Suwayomi restart,
/// a brief outage), later ones wait so Suwayomi sees commands in commit order: removing a manga
/// from a category must not land after the category itself is deleted. After this many attempts
/// the earlier row stops holding the queue, so one failing command cannot stall a profile.
const ORDERED_RETRY_ATTEMPTS: i64 = 3;
/// Attempts after which a command the runtime rejected as non-retryable (for example a GraphQL
/// error on an id Suwayomi no longer has) stops retrying. Retrying rows count as pending in
/// `/v1/sync/status`, and mobile defers its catalog reconciliation while anything is pending, so a
/// permanent failure must end in `blocked` instead of retrying forever.
const MAX_NON_RETRYABLE_ATTEMPTS: i64 = 3;
/// Attempts after which a command Suwayomi accepted but whose answer does not show the expected
/// state stops retrying. The commands are idempotent, so a few retries cover a lost race; a
/// mismatch that survives them is deterministic (for example a chapter id Suwayomi dropped on a
/// source refresh, or a category position it clamps) and would otherwise retry forever.
const MAX_CONFIRMATION_ATTEMPTS: i64 = 5;
/// Blocked codes that may succeed later without a new user edit (Suwayomi state or the runtime
/// changed). They get one fresh bounded cycle each time the daemon starts. Codes caused by the
/// command itself (`command_rejected`, `invalid_variables`, `unsupported_operation`) stay blocked
/// until a newer version supersedes them.
const RECOVERABLE_BLOCKED_CODES: [&str; 3] = [
    "confirmation_mismatch",
    "command_failed",
    PORTABLE_WORK_NOT_FOUND,
];
/// A device added a work Suwayomi could not find, for example because its extension is not
/// installed here. Blocked after a few attempts so it stops counting as pending.
const PORTABLE_WORK_NOT_FOUND: &str = "portable_work_not_found";
const PORTABLE_CHAPTER_PAGE_SIZE: i64 = 250;
const MAX_PORTABLE_CHAPTER_PAGES: usize = 80;
const CATEGORY_ASSIGNMENT_PAGE_SIZE: i64 = 100;
const MAX_CATEGORY_ASSIGNMENT_PAGES: usize = 20;

const PORTABLE_COMIC_LOOKUP_QUERY: &str = r#"
  query EpigraphResolvePortableComic($sourceId: LongString!, $url: String!) {
    mangas(condition: { sourceId: $sourceId, url: $url }, first: 2) {
      nodes { id url }
    }
  }
"#;
const PORTABLE_COMIC_SEARCH_MUTATION: &str = r#"
  mutation EpigraphSearchPortableComic($source: LongString!, $query: String!) {
    fetchSourceManga(input: { source: $source, type: SEARCH, query: $query, page: 1 }) {
      mangas { id url }
    }
  }
"#;

const PORTABLE_CHAPTER_LOOKUP_QUERY: &str = r#"
  query EpigraphResolvePortableChapter($mangaId: Int!, $first: Int!, $offset: Int!) {
    chapters(condition: { mangaId: $mangaId }, first: $first, offset: $offset) {
      pageInfo { hasNextPage }
      nodes { id mangaId url }
    }
  }
"#;

const CATEGORY_ASSIGNMENT_LOOKUP_QUERY: &str = r#"
  query EpigraphResolveCategoryAssignment($first: Int!, $offset: Int!) {
    categories(first: $first, offset: $offset) {
      pageInfo { hasNextPage }
      nodes { id mangas { nodes { id } } }
    }
  }
"#;

#[derive(Debug, Clone, FromRow)]
struct ProjectionRow {
    operation_id: String,
    profile_id: String,
    operation_name: String,
    variables_json: String,
    attempt_count: i64,
}

pub fn spawn_projection_task(
    state: SharedAppState,
    mut shutdown: tokio::sync::watch::Receiver<Option<ShutdownRequest>>,
) {
    tokio::spawn(async move {
        {
            let _writer_guard = state.mutation_gate.lock().await;
            match requeue_recoverable_blocked(&state.pool, super::db::now_ms()).await {
                Ok(0) => {}
                Ok(count) => {
                    tracing::info!(count, "requeued recoverable blocked Suwayomi projections")
                }
                Err(error) => {
                    tracing::warn!(error = %error, "failed to requeue blocked Suwayomi projections")
                }
            }
            match rearm_runtime_retries(&state.pool, super::db::now_ms(), None).await {
                Ok(0) => {}
                Ok(count) => tracing::info!(count, "rearmed Suwayomi projections waiting on the runtime"),
                Err(error) => {
                    tracing::warn!(error = %error, "failed to rearm Suwayomi projections")
                }
            }
        }
        let mut ticker = tokio::time::interval(Duration::from_secs(2));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let runtime_root = crate::suwayomi_maintenance::default_runtime_root();
        let mut maintenance = MaintenanceWatch::default();
        let mut runtime_return = RuntimeReturnWatch::default();
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    // An update keeps the runtime down while it holds the maintenance lease, and
                    // hands it back healthy when it releases it. Writes that failed meanwhile are
                    // due then, not after a backoff that grew with the length of the update.
                    let held = crate::suwayomi_maintenance::exclusive_file_lease_held(&runtime_root)
                        .unwrap_or(false);
                    if maintenance.ended(held) {
                        let _writer_guard = state.mutation_gate.lock().await;
                        match rearm_runtime_retries(&state.pool, super::db::now_ms(), None).await {
                            Ok(0) => {}
                            Ok(count) => tracing::info!(count, "rearmed Suwayomi projections after runtime maintenance"),
                            Err(error) => {
                                tracing::warn!(error = %error, "failed to rearm Suwayomi projections")
                            }
                        }
                    }
                    // Outside maintenance the runtime can still go down and come back (a crash the
                    // supervisor restarts). While writes wait on it, its return makes them due.
                    if held {
                        runtime_return.retain(&[]);
                    } else {
                        rearm_returned_runtimes(&state, &mut runtime_return).await;
                    }
                    if let Err(error) = drain_ready(&state).await {
                        tracing::warn!(error = %error, "failed to drain canonical Suwayomi projections");
                    }
                }
                _ = wait_for_shutdown_request(&mut shutdown) => break,
            }
        }
    });
}

async fn rearm_returned_runtimes(state: &SharedAppState, watch: &mut RuntimeReturnWatch) {
    let waiting = match runtime_waiting_profiles(&state.pool, super::db::now_ms()).await {
        Ok(waiting) => waiting,
        Err(error) => {
            tracing::warn!(error = %error, "failed to list Suwayomi projections waiting on the runtime");
            return;
        }
    };
    watch.retain(&waiting);
    for profile_id in waiting {
        let answers = runtime_answers(state, &profile_id).await;
        if !watch.returned(&profile_id, answers) {
            continue;
        }
        let _writer_guard = state.mutation_gate.lock().await;
        match rearm_runtime_retries(&state.pool, super::db::now_ms(), Some(&profile_id)).await {
            Ok(0) => {}
            Ok(count) => tracing::info!(count, profile = profile_id, "rearmed Suwayomi projections after the runtime came back"),
            Err(error) => tracing::warn!(error = %error, "failed to rearm Suwayomi projections"),
        }
    }
}

/// Whether the profile's Suwayomi answers GraphQL. Read-only and silent, since it runs every tick
/// while projections wait on the runtime.
async fn runtime_answers(state: &SharedAppState, profile_id: &str) -> bool {
    let Ok(base) = suwayomi_proxy::resolve_upstream_base(state, profile_id) else {
        return false;
    };
    let Ok(url) = suwayomi_proxy::build_upstream_url(base, "api/graphql", None) else {
        return false;
    };
    suwayomi_proxy::proxy_client()
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(&json!({ "query": "{ __typename }" }))
        .timeout(RUNTIME_PROBE_TIMEOUT)
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

/// Profiles with projections backing off because their runtime was unreachable.
async fn runtime_waiting_profiles(pool: &sqlx::SqlitePool, now: i64) -> anyhow::Result<Vec<String>> {
    sqlx::query_scalar(
        r#"
        SELECT DISTINCT profile_id FROM suwayomi_projection_outbox
        WHERE status = 'retry' AND last_error = ? AND next_attempt_at_ms > ?
        ORDER BY profile_id
        "#,
    )
    .bind(RUNTIME_UNAVAILABLE)
    .bind(now)
    .fetch_all(pool)
    .await
    .context("failed to list Suwayomi projections waiting on the runtime")
}

/// Follows whether each waiting profile's runtime answers, to notice when it comes back. Only a
/// runtime seen down counts: one that answers while a write still failed (a slow or rejected
/// command) keeps the normal backoff instead of being retried every tick.
#[derive(Default)]
struct RuntimeReturnWatch {
    down: BTreeSet<String>,
}

impl RuntimeReturnWatch {
    /// Records a probe; true when the runtime answers after it was last seen down.
    fn returned(&mut self, profile_id: &str, answers: bool) -> bool {
        if answers {
            self.down.remove(profile_id)
        } else {
            self.down.insert(profile_id.to_string());
            false
        }
    }

    /// Forgets profiles with nothing waiting any more: their next outage starts over.
    fn retain(&mut self, waiting: &[String]) {
        self.down.retain(|profile_id| waiting.contains(profile_id));
    }
}

/// Follows the runtime maintenance lease across ticks to notice when maintenance ends.
#[derive(Default)]
struct MaintenanceWatch {
    held: bool,
}

impl MaintenanceWatch {
    fn ended(&mut self, held: bool) -> bool {
        let ended = self.held && !held;
        self.held = held;
        ended
    }
}

#[allow(dead_code)]
pub async fn pending_projection_count(state: &SharedAppState) -> anyhow::Result<i64> {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM suwayomi_projection_outbox WHERE status IN ('pending', 'in_flight', 'retry', 'blocked')",
    )
    .fetch_one(&state.pool)
    .await
    .context("failed to count pending Suwayomi projections")
}

async fn drain_ready(state: &SharedAppState) -> anyhow::Result<usize> {
    let mut completed = 0;
    for _ in 0..MAX_BATCH {
        let Some(row) = claim_next(state).await? else {
            break;
        };
        match apply_projection(state, &row).await {
            ProjectionOutcome::Applied => {
                let _writer_guard = state.mutation_gate.lock().await;
                sqlx::query("DELETE FROM suwayomi_projection_outbox WHERE operation_id = ?")
                    .bind(&row.operation_id)
                    .execute(&state.pool)
                    .await?;
                completed += 1;
            }
            ProjectionOutcome::Retry(code) => {
                let delay = retry_delay_ms(code, row.attempt_count);
                let now = super::db::now_ms();
                let _writer_guard = state.mutation_gate.lock().await;
                sqlx::query(
                    r#"
                    UPDATE suwayomi_projection_outbox
                    SET status = 'retry', next_attempt_at_ms = ?, lease_until_ms = NULL,
                        last_error = ?, updated_at_ms = ?
                    WHERE operation_id = ?
                    "#,
                )
                .bind(now.saturating_add(delay))
                .bind(code)
                .bind(now)
                .bind(&row.operation_id)
                .execute(&state.pool)
                .await?;
            }
            ProjectionOutcome::Blocked(code) => {
                let now = super::db::now_ms();
                let _writer_guard = state.mutation_gate.lock().await;
                sqlx::query(
                    r#"
                    UPDATE suwayomi_projection_outbox
                    SET status = 'blocked', lease_until_ms = NULL, last_error = ?, updated_at_ms = ?
                    WHERE operation_id = ?
                    "#,
                )
                .bind(code)
                .bind(now)
                .bind(&row.operation_id)
                .execute(&state.pool)
                .await?;
            }
        }
    }
    Ok(completed)
}

fn retry_delay_ms(code: &str, attempt_count: i64) -> i64 {
    let shift = attempt_count.clamp(0, 8) as u32;
    let ceiling = if code == RUNTIME_UNAVAILABLE {
        MAX_RUNTIME_RETRY_MS
    } else {
        MAX_RETRY_MS
    };
    BASE_RETRY_MS.saturating_mul(1_i64 << shift).min(ceiling)
}

async fn claim_next(state: &SharedAppState) -> anyhow::Result<Option<ProjectionRow>> {
    let _writer_guard = state.mutation_gate.lock().await;
    let now = super::db::now_ms();
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE suwayomi_projection_outbox
        SET status = 'retry', next_attempt_at_ms = ?, lease_until_ms = NULL,
            last_error = 'lease_expired', updated_at_ms = ?
        WHERE status = 'in_flight' AND lease_until_ms IS NOT NULL AND lease_until_ms <= ?
        "#,
    )
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let row = sqlx::query_as::<_, ProjectionRow>(
        r#"
        SELECT operation_id, profile_id, operation_name, variables_json, attempt_count
        FROM suwayomi_projection_outbox AS candidate
        WHERE status IN ('pending', 'retry') AND next_attempt_at_ms <= ?
          AND NOT EXISTS (
            SELECT 1 FROM suwayomi_projection_outbox AS earlier
            WHERE earlier.profile_id = candidate.profile_id
              AND earlier.source_server_version < candidate.source_server_version
              AND earlier.status = 'retry'
              AND earlier.attempt_count < ?
          )
        ORDER BY source_server_version ASC
        LIMIT 1
        "#,
    )
    .bind(now)
    .bind(ORDERED_RETRY_ATTEMPTS)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(row) = &row {
        sqlx::query(
            r#"
            UPDATE suwayomi_projection_outbox
            SET status = 'in_flight', attempt_count = attempt_count + 1,
                lease_until_ms = ?, last_error = NULL, updated_at_ms = ?
            WHERE operation_id = ?
            "#,
        )
        .bind(now.saturating_add(LEASE_MS))
        .bind(now)
        .bind(&row.operation_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(row)
}

async fn apply_projection(state: &SharedAppState, row: &ProjectionRow) -> ProjectionOutcome {
    let variables: Value = match serde_json::from_str(&row.variables_json) {
        Ok(value) => value,
        Err(_) => return ProjectionOutcome::Blocked("invalid_variables"),
    };
    let (operation_name, variables) =
        if row.operation_name == db::REMOVE_COMIC_CATEGORY_ASSIGNMENT_OPERATION {
            match resolve_category_assignment_removal(state, &row.profile_id, &variables).await {
                Ok(Some(variables)) => ("UpdateMangaCategories", variables),
                // Suwayomi no longer has the pair, so the delete already holds there.
                Ok(None) => return ProjectionOutcome::Applied,
                Err(outcome) => return outcome,
            }
        } else {
            (row.operation_name.as_str(), variables)
        };
    let variables = match resolve_portable_projection_identity(state, row, variables).await {
        Ok(variables) => variables,
        Err(outcome) => return outcome,
    };
    let operation = match operation_name {
        "UpdateManga" => CommandOperation::UpdateManga,
        "UpdateMangaCategories" => CommandOperation::UpdateMangaCategories,
        "UpdateChaptersProgress" => CommandOperation::UpdateChaptersProgress,
        "UpdateCategory" => CommandOperation::UpdateCategory,
        "DeleteCategory" => CommandOperation::DeleteCategory,
        "UpdateCategoryOrder" => CommandOperation::UpdateCategoryOrder,
        _ => return ProjectionOutcome::Blocked("unsupported_operation"),
    };
    let command_variables = if operation == CommandOperation::UpdateChaptersProgress {
        let Some(object) = variables.as_object() else {
            return ProjectionOutcome::Blocked("invalid_variables");
        };
        let mut object = object.clone();
        object.remove("mangaId");
        Value::Object(object)
    } else {
        variables.clone()
    };
    let data = match suwayomi_commands::execute_internal_command(
        state,
        &row.profile_id,
        operation,
        command_variables,
    )
    .await
    {
        Ok(data) => data,
        Err(AppError::BadRequest(_) | AppError::Forbidden(_)) => {
            return ProjectionOutcome::Blocked("command_rejected")
        }
        Err(error) => return failed_command_outcome(&error, row.attempt_count),
    };
    confirmation_outcome(
        projection_confirmed(operation, &variables, &data),
        row.attempt_count,
    )
}

/// Applies a confirmed command, retries a mismatch, and blocks it once it has mismatched
/// [MAX_CONFIRMATION_ATTEMPTS] times. `attempt_count` already includes the current attempt.
fn confirmation_outcome(confirmed: bool, attempt_count: i64) -> ProjectionOutcome {
    if confirmed {
        ProjectionOutcome::Applied
    } else if attempt_count >= MAX_CONFIRMATION_ATTEMPTS {
        ProjectionOutcome::Blocked("confirmation_mismatch")
    } else {
        ProjectionOutcome::Retry("confirmation_mismatch")
    }
}

/// Gives rows blocked by a [RECOVERABLE_BLOCKED_CODES] failure one new bounded cycle. Runs once at
/// daemon start; running it again only re-arms the same rows, so it is idempotent. A blocked row
/// is always the newest version of its entity (a newer version deletes it), so re-sending it
/// cannot overwrite a later edit.
async fn requeue_recoverable_blocked(pool: &sqlx::SqlitePool, now: i64) -> anyhow::Result<u64> {
    let result = sqlx::query(
        r#"
        UPDATE suwayomi_projection_outbox
        SET status = 'retry', attempt_count = 0, next_attempt_at_ms = ?, lease_until_ms = NULL,
            updated_at_ms = ?
        WHERE status = 'blocked' AND last_error IN (?, ?, ?)
        "#,
    )
    .bind(now)
    .bind(now)
    .bind(RECOVERABLE_BLOCKED_CODES[0])
    .bind(RECOVERABLE_BLOCKED_CODES[1])
    .bind(RECOVERABLE_BLOCKED_CODES[2])
    .execute(pool)
    .await
    .context("failed to requeue recoverable blocked Suwayomi projections")?;
    Ok(result.rows_affected())
}

/// Makes rows that were waiting on an unreachable runtime due now, for one profile or all. Runs at
/// daemon start, when maintenance ends and when a runtime seen down answers again, so a backoff
/// earned during an outage does not keep the queue pending. Attempt counts are kept, so ordering
/// and bounded-attempt rules hold.
async fn rearm_runtime_retries(
    pool: &sqlx::SqlitePool,
    now: i64,
    profile_id: Option<&str>,
) -> anyhow::Result<u64> {
    let result = sqlx::query(
        r#"
        UPDATE suwayomi_projection_outbox
        SET next_attempt_at_ms = ?, updated_at_ms = ?
        WHERE status = 'retry' AND last_error = ? AND next_attempt_at_ms > ?
          AND (? IS NULL OR profile_id = ?)
        "#,
    )
    .bind(now)
    .bind(now)
    .bind(RUNTIME_UNAVAILABLE)
    .bind(now)
    .bind(profile_id)
    .bind(profile_id)
    .execute(pool)
    .await
    .context("failed to rearm Suwayomi projections waiting on the runtime")?;
    Ok(result.rows_affected())
}

async fn resolve_portable_projection_identity(
    state: &SharedAppState,
    row: &ProjectionRow,
    mut variables: Value,
) -> Result<Value, ProjectionOutcome> {
    let Some(object) = variables.as_object_mut() else {
        return Err(ProjectionOutcome::Blocked("invalid_variables"));
    };
    let title_hint = object
        .remove(db::PORTABLE_TITLE_HINT_FIELD)
        .and_then(|value| value.as_str().map(str::to_string));
    let work_value = object.get("portableWorkRef").cloned();
    let chapter_value = object.get("portableChapterRef").cloned();
    if work_value.is_none() && chapter_value.is_none() {
        return Ok(variables);
    }
    let Some(work_value) = work_value else {
        return Err(ProjectionOutcome::Blocked("incomplete_portable_reference"));
    };
    let work: PortableWorkRefV3 = serde_json::from_value(work_value)
        .map_err(|_| ProjectionOutcome::Blocked("invalid_portable_work_reference"))?;
    work.validate()
        .map_err(|_| ProjectionOutcome::Blocked("invalid_portable_work_reference"))?;
    if !matches!(work, PortableWorkRefV3::Comic { .. }) {
        return Err(ProjectionOutcome::Blocked(
            "portable_reference_type_mismatch",
        ));
    }

    let portable_work_id = canonical_portable_work_id(&work);
    let binding =
        match db::load_portable_work_binding(&state.pool, &row.profile_id, &portable_work_id)
            .await
            .map_err(|_| ProjectionOutcome::Retry("portable_binding_unavailable"))?
        {
            Some(binding) => binding,
            None => {
                bind_unseen_comic(state, row, &work, &portable_work_id, title_hint.as_deref())
                    .await?
            }
        };
    if binding.portable_ref().ok().as_ref() != Some(&work) || binding.resolution_state != "BOUND" {
        return Err(ProjectionOutcome::Blocked("portable_work_binding_mismatch"));
    }
    let manga_id = binding
        .local_reference
        .as_deref()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0 && *value <= i32::MAX as i64)
        .ok_or(ProjectionOutcome::Blocked(
            "portable_work_local_reference_invalid",
        ))?;

    let Some(chapter_value) = chapter_value else {
        object.remove("portableWorkRef");
        match row.operation_name.as_str() {
            "UpdateManga" => object.insert("id".to_string(), Value::from(manga_id)),
            "UpdateMangaCategories" => object.insert("mangaId".to_string(), Value::from(manga_id)),
            _ => return Err(ProjectionOutcome::Blocked("incomplete_portable_reference")),
        };
        return Ok(variables);
    };
    let chapter: PortableChapterRefV3 = serde_json::from_value(chapter_value)
        .map_err(|_| ProjectionOutcome::Blocked("invalid_portable_chapter_reference"))?;
    chapter
        .validate()
        .map_err(|_| ProjectionOutcome::Blocked("invalid_portable_chapter_reference"))?;
    let PortableChapterRefV3::Comic {
        work: chapter_work,
        chapter_key,
    } = &chapter
    else {
        return Err(ProjectionOutcome::Blocked(
            "portable_reference_type_mismatch",
        ));
    };
    if chapter_work != &work {
        return Err(ProjectionOutcome::Blocked(
            "portable_reference_parent_mismatch",
        ));
    }

    let portable_chapter_id = canonical_portable_chapter_id(&chapter);
    let cached_chapter_id =
        db::load_portable_chapter_binding(&state.pool, &row.profile_id, &portable_chapter_id)
            .await
            .map_err(|_| ProjectionOutcome::Retry("portable_binding_unavailable"))?
            .filter(|binding| {
                binding.portable_work_id == portable_work_id
                    && binding.provider_key == *chapter_key
                    && binding.resolution_state == "BOUND"
            })
            .and_then(|binding| binding.local_reference)
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|value| *value > 0 && *value <= i32::MAX as i64);
    let chapter_id = match cached_chapter_id {
        Some(chapter_id) if trusts_cached_chapter_id(row.attempt_count) => chapter_id,
        // A failed lookup keeps the cached id, so the row still ends in the bounded
        // confirmation path instead of retrying the lookup forever.
        Some(chapter_id) => resolve_chapter_id(state, &row.profile_id, manga_id, chapter_key)
            .await
            .unwrap_or(chapter_id),
        None => resolve_chapter_id(state, &row.profile_id, manga_id, chapter_key).await?,
    };
    let local_chapter_reference = chapter_id.to_string();
    db::upsert_portable_chapter_binding(
        &state.pool,
        &row.profile_id,
        &portable_chapter_id,
        &portable_work_id,
        chapter_key,
        Some(&local_chapter_reference),
        PortableResolutionStateV3::Bound,
        None,
        0,
        db::now_ms(),
    )
    .await
    .map_err(|_| ProjectionOutcome::Retry("portable_binding_unavailable"))?;

    object.remove("portableWorkRef");
    object.remove("portableChapterRef");
    object.insert("mangaId".to_string(), Value::from(manga_id));
    object.insert(
        "ids".to_string(),
        Value::Array(vec![Value::from(chapter_id)]),
    );
    Ok(variables)
}

/// Binds a comic a device added that this desktop never listed. Suwayomi only knows works it has
/// already fetched, so when the exact source and key are not there yet, searching the source for
/// the title fetches it; only an exact key match is accepted.
async fn bind_unseen_comic(
    state: &SharedAppState,
    row: &ProjectionRow,
    work: &PortableWorkRefV3,
    portable_work_id: &str,
    title_hint: Option<&str>,
) -> Result<PortableWorkBindingRow, ProjectionOutcome> {
    let PortableWorkRefV3::Comic {
        source_id,
        manga_key,
    } = work
    else {
        return Err(ProjectionOutcome::Blocked(
            "portable_reference_type_mismatch",
        ));
    };
    let session = projection_session(&row.profile_id);
    let data = suwayomi_catalog::execute_graphql_document(
        state,
        &session,
        PORTABLE_COMIC_LOOKUP_QUERY,
        json!({ "sourceId": source_id, "url": manga_key }),
        false,
    )
    .await
    .map_err(|_| ProjectionOutcome::Retry(RUNTIME_UNAVAILABLE))?;
    let mut manga_id = exact_comic_match(data.pointer("/mangas/nodes"), manga_key);
    if let (None, Some(title)) = (manga_id, title_hint) {
        // An extension that is missing or failing here answers with an error; that is retried
        // like a work that was not found.
        if let Ok(data) = suwayomi_catalog::execute_graphql_document(
            state,
            &session,
            PORTABLE_COMIC_SEARCH_MUTATION,
            json!({ "source": source_id, "query": title }),
            true,
        )
        .await
        {
            manga_id = exact_comic_match(data.pointer("/fetchSourceManga/mangas"), manga_key);
        }
    }
    let Some(manga_id) = manga_id else {
        return Err(if row.attempt_count >= MAX_CONFIRMATION_ATTEMPTS {
            ProjectionOutcome::Blocked(PORTABLE_WORK_NOT_FOUND)
        } else {
            ProjectionOutcome::Retry("portable_work_not_bound")
        });
    };
    let local_reference = manga_id.to_string();
    db::upsert_portable_work_binding(
        &state.pool,
        &row.profile_id,
        portable_work_id,
        work,
        None,
        Some(&local_reference),
        PortableResolutionStateV3::Bound,
        None,
        title_hint,
        None,
        0,
        db::now_ms(),
    )
    .await
    .map_err(|_| ProjectionOutcome::Retry("portable_binding_unavailable"))?;
    db::load_portable_work_binding(&state.pool, &row.profile_id, portable_work_id)
        .await
        .map_err(|_| ProjectionOutcome::Retry("portable_binding_unavailable"))?
        .ok_or(ProjectionOutcome::Retry("portable_binding_unavailable"))
}

fn exact_comic_match(nodes: Option<&Value>, manga_key: &str) -> Option<i64> {
    nodes?
        .as_array()?
        .iter()
        .filter(|node| node.get("url").and_then(Value::as_str) == Some(manga_key))
        .filter_map(|node| node.get("id").and_then(Value::as_i64))
        .find(|id| *id > 0 && *id <= i32::MAX as i64)
}

async fn resolve_chapter_id(
    state: &SharedAppState,
    profile_id: &str,
    manga_id: i64,
    chapter_key: &str,
) -> Result<i64, ProjectionOutcome> {
    let session = projection_session(profile_id);
    let mut path_matches = BTreeSet::new();
    for page in 0..MAX_PORTABLE_CHAPTER_PAGES {
        let offset = (page as i64).saturating_mul(PORTABLE_CHAPTER_PAGE_SIZE);
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            &session,
            PORTABLE_CHAPTER_LOOKUP_QUERY,
            serde_json::json!({
                "mangaId": manga_id,
                "first": PORTABLE_CHAPTER_PAGE_SIZE,
                "offset": offset,
            }),
            false,
        )
        .await
        .map_err(|_| ProjectionOutcome::Retry(RUNTIME_UNAVAILABLE))?;
        let chapters = data
            .get("chapters")
            .ok_or(ProjectionOutcome::Retry("portable_chapter_lookup_invalid"))?;
        let (exact, same_path) = chapter_key_matches(chapters.get("nodes"), manga_id, chapter_key);
        if let Some(id) = exact {
            return Ok(id);
        }
        path_matches.extend(same_path);
        let has_next = chapters
            .get("pageInfo")
            .and_then(|value| value.get("hasNextPage"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !has_next {
            // A host-only difference binds only when it names a single chapter of the manga.
            return path_matches
                .first()
                .copied()
                .filter(|_| path_matches.len() == 1)
                .ok_or(ProjectionOutcome::Retry("portable_chapter_not_resolved"));
        }
    }
    Err(ProjectionOutcome::Retry("portable_chapter_lookup_limit"))
}

/// A cached chapter id is trusted only on a row's first attempt. Suwayomi gives chapters new ids
/// when it recreates them (for example after a backup restore), and a stale id updates no chapter,
/// so each retry looks the chapter up by key again instead of mismatching until the row blocks.
/// `attempt_count` is the claimed row's count from before this attempt was recorded.
fn trusts_cached_chapter_id(attempt_count: i64) -> bool {
    attempt_count <= 0
}

/// Chapter ids on one lookup page: the chapter whose URL is exactly `chapter_key`, and the
/// chapters whose URL differs from it only in scheme and host. Extensions move sources to new
/// domains, so a device on a newer extension can name a chapter by an absolute URL whose host this
/// desktop does not have yet.
fn chapter_key_matches(
    nodes: Option<&Value>,
    manga_id: i64,
    chapter_key: &str,
) -> (Option<i64>, Vec<i64>) {
    let key_path = chapter_url_path(chapter_key);
    let mut exact = None;
    let mut same_path = Vec::new();
    for node in nodes.and_then(Value::as_array).into_iter().flatten() {
        let Some(id) = node
            .get("id")
            .and_then(Value::as_i64)
            .filter(|id| *id > 0 && *id <= i32::MAX as i64)
        else {
            continue;
        };
        if node.get("mangaId").and_then(Value::as_i64) != Some(manga_id) {
            continue;
        }
        let Some(url) = node.get("url").and_then(Value::as_str) else {
            continue;
        };
        if url == chapter_key {
            exact.get_or_insert(id);
        } else if !key_path.is_empty() && chapter_url_path(url) == key_path {
            same_path.push(id);
        }
    }
    (exact, same_path)
}

/// The path of an absolute URL (`https://host/manga/a/1` → `/manga/a/1`); a relative key is
/// returned as is.
fn chapter_url_path(url: &str) -> &str {
    match url.split_once("://") {
        Some((_, rest)) => rest.find('/').map_or("", |index| &rest[index..]),
        None => url,
    }
}

/// Retries a failed command unless the runtime marked it non-retryable and it already failed
/// [MAX_NON_RETRYABLE_ATTEMPTS] times. `attempt_count` already includes the current attempt.
fn failed_command_outcome(error: &AppError, attempt_count: i64) -> ProjectionOutcome {
    let non_retryable =
        matches!(error, AppError::ServiceUnavailable(detail) if detail.retryable == Some(false));
    if non_retryable && attempt_count >= MAX_NON_RETRYABLE_ATTEMPTS {
        ProjectionOutcome::Blocked("command_failed")
    } else {
        ProjectionOutcome::Retry(RUNTIME_UNAVAILABLE)
    }
}

fn projection_session(profile_id: &str) -> AuthenticatedSession {
    AuthenticatedSession {
        token_id: "epigraph-core-projection".to_string(),
        device_id: "epigraph-core".to_string(),
        profile_id: profile_id.to_string(),
        scopes: BTreeSet::from([format!("comics:profile:{profile_id}")]),
        mutation_receipt: None,
    }
}

async fn resolve_category_assignment_removal(
    state: &SharedAppState,
    profile_id: &str,
    variables: &Value,
) -> Result<Option<Value>, ProjectionOutcome> {
    let assignment_id = variables
        .get("assignmentId")
        .and_then(Value::as_str)
        .ok_or(ProjectionOutcome::Blocked("invalid_variables"))?;
    let server_id = db::load_server_identity(&state.pool)
        .await
        .map_err(|_| ProjectionOutcome::Retry("server_identity_unavailable"))?
        .server_id;
    let session = projection_session(profile_id);
    for page in 0..MAX_CATEGORY_ASSIGNMENT_PAGES {
        let offset = (page as i64).saturating_mul(CATEGORY_ASSIGNMENT_PAGE_SIZE);
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            &session,
            CATEGORY_ASSIGNMENT_LOOKUP_QUERY,
            json!({ "first": CATEGORY_ASSIGNMENT_PAGE_SIZE, "offset": offset }),
            false,
        )
        .await
        .map_err(|_| ProjectionOutcome::Retry(RUNTIME_UNAVAILABLE))?;
        let categories = data
            .get("categories")
            .ok_or(ProjectionOutcome::Retry("category_assignment_lookup_invalid"))?;
        if let Some((manga_id, category_id)) =
            find_category_assignment_pair(assignment_id, profile_id, &server_id, categories)
        {
            return Ok(Some(json!({
                "mangaId": manga_id,
                "addTo": [],
                "removeFrom": [category_id],
            })));
        }
        let has_next = categories
            .get("pageInfo")
            .and_then(|value| value.get("hasNextPage"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !has_next {
            return Ok(None);
        }
    }
    Err(ProjectionOutcome::Retry("category_assignment_lookup_limit"))
}

/// Matches the mobile id `comic-category-assignment:` + hex(sha256(comicId NUL categoryId))
/// against every legacy id form (with or without `server:S:`) of each assigned pair.
fn find_category_assignment_pair(
    assignment_id: &str,
    profile_id: &str,
    server_id: &str,
    categories: &Value,
) -> Option<(i64, i64)> {
    let prefixes = [
        format!("suwayomi:profile:{profile_id}"),
        format!("suwayomi:server:{server_id}:profile:{profile_id}"),
    ];
    let valid_id = |value: &Value| {
        value
            .get("id")
            .and_then(Value::as_i64)
            .filter(|id| *id > 0 && *id <= i32::MAX as i64)
    };
    for category in categories.get("nodes").and_then(Value::as_array)? {
        let Some(category_id) = valid_id(category) else {
            continue;
        };
        let mangas = category
            .get("mangas")
            .and_then(|value| value.get("nodes"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten();
        for manga_id in mangas.filter_map(valid_id) {
            for comic_prefix in &prefixes {
                for category_prefix in &prefixes {
                    let candidate = comic_category_assignment_id(
                        &format!("{comic_prefix}:manga:{manga_id}"),
                        &format!("{category_prefix}:category:{category_id}"),
                    );
                    if candidate == assignment_id {
                        return Some((manga_id, category_id));
                    }
                }
            }
        }
    }
    None
}

fn comic_category_assignment_id(comic_id: &str, category_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(comic_id.as_bytes());
    digest.update([0u8]);
    digest.update(category_id.as_bytes());
    let hex: String = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{}{hex}", db::COMIC_CATEGORY_ASSIGNMENT_ID_PREFIX)
}

fn projection_confirmed(operation: CommandOperation, variables: &Value, data: &Value) -> bool {
    match operation {
        CommandOperation::UpdateManga => {
            let expected_id = variables.get("id").and_then(Value::as_i64);
            let expected_membership = variables.get("inLibrary").and_then(Value::as_bool);
            let manga = data.get("updateManga").and_then(|value| value.get("manga"));
            manga
                .and_then(|value| value.get("id"))
                .and_then(Value::as_i64)
                == expected_id
                && expected_membership.map_or(true, |expected| {
                    manga
                        .and_then(|value| value.get("inLibrary"))
                        .and_then(Value::as_bool)
                        == Some(expected)
                })
        }
        CommandOperation::UpdateMangaCategories => {
            let expected_id = variables.get("mangaId").and_then(Value::as_i64);
            data.get("updateMangaCategories")
                .and_then(|value| value.get("manga"))
                .and_then(|value| value.get("id"))
                .and_then(Value::as_i64)
                == expected_id
        }
        CommandOperation::UpdateChaptersProgress => chapters_projection_confirmed(variables, data),
        CommandOperation::UpdateCategory => {
            let expected_id = variables.get("id").and_then(Value::as_i64);
            let expected_name = variables.get("name").and_then(Value::as_str);
            let category = data
                .get("updateCategory")
                .and_then(|value| value.get("category"));
            category
                .and_then(|value| value.get("id"))
                .and_then(Value::as_i64)
                == expected_id
                && expected_name.map_or(true, |expected| {
                    category
                        .and_then(|value| value.get("name"))
                        .and_then(Value::as_str)
                        == Some(expected)
                })
        }
        // Direct device commands only; the outbox projection never produces them.
        CommandOperation::AddExtensionRepos | CommandOperation::InstallExtension => false,
        CommandOperation::CreateCategory => variables
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| suwayomi_commands::created_category(name, data).is_some()),
        CommandOperation::DeleteCategory => {
            let expected_id = variables.get("id").and_then(Value::as_i64);
            match data
                .get("deleteCategory")
                .and_then(|value| value.get("category"))
            {
                // Suwayomi answers a null category when the id is already gone: a retry after a
                // lost response, or the same category deleted on the desktop meanwhile.
                Some(Value::Null) => true,
                category => {
                    category
                        .and_then(|value| value.get("id"))
                        .and_then(Value::as_i64)
                        == expected_id
                }
            }
        }
        CommandOperation::UpdateCategoryOrder => {
            let expected_id = variables.get("id").and_then(Value::as_i64);
            let Some(expected_position) = variables.get("position").and_then(Value::as_i64) else {
                return false;
            };
            let categories = data
                .get("updateCategoryOrder")
                .and_then(|value| value.get("categories"))
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            // Suwayomi clamps a position past its last category instead of rejecting it, so an
            // order counted on a device with more categories lands last. Confirm that slot, or the
            // row blocks forever and keeps `/v1/sync/status` from ever turning ready.
            let Some(last_order) = categories
                .iter()
                .filter_map(|category| category.get("order").and_then(Value::as_i64))
                .max()
            else {
                return false;
            };
            let expected_position = Some(expected_position.min(last_order));
            categories.iter().any(|category| {
                category.get("id").and_then(Value::as_i64) == expected_id
                    && category.get("order").and_then(Value::as_i64) == expected_position
            })
        }
    }
}

fn chapters_projection_confirmed(variables: &Value, data: &Value) -> bool {
    let Some(expected_ids) = variables
        .get("ids")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_i64).collect::<Vec<_>>())
        .filter(|ids| !ids.is_empty())
    else {
        return false;
    };
    let chapters = data
        .get("updateChapters")
        .and_then(|value| value.get("chapters"))
        .and_then(Value::as_array);
    let Some(chapters) = chapters else {
        return false;
    };
    expected_ids.iter().all(|expected_id| {
        chapters.iter().any(|chapter| {
            chapter.get("id").and_then(Value::as_i64) == Some(*expected_id)
                && optional_field_matches(variables, chapter, "isRead", Value::as_bool)
                && optional_field_matches(variables, chapter, "isBookmarked", Value::as_bool)
            // lastPageRead is intentionally NOT part of the confirmation: Suwayomi
            // clamps it against the chapter's known page count, and extension-fetched
            // chapters carry pageCount = -1, so the echoed value is 0 regardless of the
            // input. The chapter id plus read/bookmark state are the reliable signals.
        })
    })
}

fn optional_field_matches<T: PartialEq>(
    expected: &Value,
    actual: &Value,
    field: &str,
    decode: fn(&Value) -> Option<T>,
) -> bool {
    let Some(expected) = expected.get(field).filter(|value| !value.is_null()) else {
        return true;
    };
    decode(actual.get(field).unwrap_or(&Value::Null)) == decode(expected)
}

enum ProjectionOutcome {
    Applied,
    Retry(&'static str),
    Blocked(&'static str),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permanent_command_failures_block_after_bounded_attempts() {
        let permanent = AppError::service_unavailable("SUWAYOMI_CATALOG_QUERY_FAILED", "x", false);
        let transient = AppError::service_unavailable("SUWAYOMI_CATALOG_UNAVAILABLE", "x", true);
        assert!(matches!(
            failed_command_outcome(&permanent, 1),
            ProjectionOutcome::Retry(_)
        ));
        assert!(matches!(
            failed_command_outcome(&permanent, MAX_NON_RETRYABLE_ATTEMPTS - 1),
            ProjectionOutcome::Retry(_)
        ));
        assert!(matches!(
            failed_command_outcome(&permanent, MAX_NON_RETRYABLE_ATTEMPTS),
            ProjectionOutcome::Blocked("command_failed")
        ));
        // A runtime that is down or busy keeps retrying with backoff no matter how long it takes.
        assert!(matches!(
            failed_command_outcome(&transient, 1_000),
            ProjectionOutcome::Retry(_)
        ));
        assert!(matches!(
            failed_command_outcome(&AppError::Internal("x".to_string()), 1_000),
            ProjectionOutcome::Retry(_)
        ));
    }

    #[test]
    fn confirmation_mismatch_blocks_after_bounded_attempts() {
        assert!(matches!(
            confirmation_outcome(true, 1),
            ProjectionOutcome::Applied
        ));
        assert!(matches!(
            confirmation_outcome(true, 1_000),
            ProjectionOutcome::Applied
        ));
        assert!(matches!(
            confirmation_outcome(false, 1),
            ProjectionOutcome::Retry("confirmation_mismatch")
        ));
        assert!(matches!(
            confirmation_outcome(false, MAX_CONFIRMATION_ATTEMPTS - 1),
            ProjectionOutcome::Retry("confirmation_mismatch")
        ));
        assert!(matches!(
            confirmation_outcome(false, MAX_CONFIRMATION_ATTEMPTS),
            ProjectionOutcome::Blocked("confirmation_mismatch")
        ));
    }

    #[test]
    fn cached_chapter_ids_are_looked_up_again_on_retry() {
        assert!(trusts_cached_chapter_id(0));
        // A stale id (chapters recreated by a backup restore) mismatches once, then the retry
        // resolves the chapter key again before the row can block.
        assert!(!trusts_cached_chapter_id(1));
        assert!(!trusts_cached_chapter_id(MAX_CONFIRMATION_ATTEMPTS));
    }

    #[test]
    fn chapters_match_by_exact_key_or_by_path_when_only_the_host_changed() {
        let old_host = "https://www.mangakakalot.gg/manga/slug/chapter-50";
        let new_host = "https://www.mangakakalove.com/manga/slug/chapter-50";
        let nodes = json!([
            { "id": 407268, "mangaId": 7, "url": old_host },
            { "id": 407269, "mangaId": 7, "url": "https://www.mangakakalot.gg/manga/slug/chapter-51" },
            { "id": 900, "mangaId": 8, "url": "https://www.mangakakalot.gg/manga/slug/chapter-50" },
            { "id": 0, "mangaId": 7, "url": "https://other.example/manga/slug/chapter-50" },
        ]);
        assert_eq!(
            chapter_key_matches(Some(&nodes), 7, old_host),
            (Some(407268), vec![])
        );
        assert_eq!(
            chapter_key_matches(Some(&nodes), 7, new_host),
            (None, vec![407268])
        );
        assert_eq!(
            chapter_key_matches(Some(&nodes), 7, "https://www.mangakakalove.com/manga/slug/chapter-52"),
            (None, vec![])
        );
        // Relative keys still match only exactly or against the path of an absolute URL.
        assert_eq!(
            chapter_key_matches(Some(&nodes), 7, "/manga/slug/chapter-51"),
            (None, vec![407269])
        );
        // A host-only URL has no path to compare.
        assert_eq!(
            chapter_key_matches(
                Some(&json!([{ "id": 1, "mangaId": 7, "url": "https://a.example" }])),
                7,
                "https://b.example"
            ),
            (None, vec![])
        );
        assert_eq!(chapter_key_matches(None, 7, old_host), (None, vec![]));
    }

    #[test]
    fn chapter_url_path_strips_scheme_and_host_only() {
        assert_eq!(
            chapter_url_path("https://www.mangakakalove.com/manga/slug/chapter-50"),
            "/manga/slug/chapter-50"
        );
        assert_eq!(chapter_url_path("/manga/slug/chapter-50"), "/manga/slug/chapter-50");
        assert_eq!(chapter_url_path("https://host.example"), "");
    }

    #[tokio::test]
    async fn startup_requeues_only_recoverable_blocked_rows() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        for (id, status, error) in [
            ("mismatch", "blocked", Some("confirmation_mismatch")),
            ("failed", "blocked", Some("command_failed")),
            ("rejected", "blocked", Some("command_rejected")),
            ("invalid", "blocked", Some("invalid_variables")),
            ("waiting", "retry", Some("confirmation_mismatch")),
            ("fresh", "pending", None),
        ] {
            sqlx::query(
                r#"
                INSERT INTO suwayomi_projection_outbox (
                  operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
                  source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
                  created_at_ms, updated_at_ms
                ) VALUES (?, 'main', 'UpdateManga', '{"id":7}', 'comic.library', ?, 1, ?, 5, 99, ?, 1, 1)
                "#,
            )
            .bind(id)
            .bind(id)
            .bind(status)
            .bind(error)
            .execute(&pool)
            .await
            .unwrap();
        }

        assert_eq!(requeue_recoverable_blocked(&pool, 500).await.unwrap(), 2);
        // Idempotent: nothing recoverable is left blocked.
        assert_eq!(requeue_recoverable_blocked(&pool, 600).await.unwrap(), 0);

        let rows: Vec<(String, String, i64, i64)> = sqlx::query_as(
            "SELECT operation_id, status, attempt_count, next_attempt_at_ms FROM suwayomi_projection_outbox ORDER BY operation_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                ("failed".to_string(), "retry".to_string(), 0, 500),
                ("fresh".to_string(), "pending".to_string(), 5, 99),
                ("invalid".to_string(), "blocked".to_string(), 5, 99),
                ("mismatch".to_string(), "retry".to_string(), 0, 500),
                ("rejected".to_string(), "blocked".to_string(), 5, 99),
                ("waiting".to_string(), "retry".to_string(), 5, 99),
            ]
        );
    }

    #[test]
    fn unseen_comics_bind_only_to_an_exact_key() {
        let nodes = json!([
            { "id": 4, "url": "/manga/a-b" },
            { "id": 0, "url": "/manga/a" },
            { "id": 9, "url": "/manga/a" },
        ]);
        assert_eq!(exact_comic_match(Some(&nodes), "/manga/a"), Some(9));
        assert_eq!(exact_comic_match(Some(&nodes), "/manga/A"), None);
        assert_eq!(exact_comic_match(None, "/manga/a"), None);
    }

    #[test]
    fn runtime_outages_retry_within_minutes() {
        assert_eq!(retry_delay_ms(RUNTIME_UNAVAILABLE, 0), BASE_RETRY_MS);
        assert_eq!(retry_delay_ms(RUNTIME_UNAVAILABLE, 9), MAX_RUNTIME_RETRY_MS);
        assert_eq!(retry_delay_ms("confirmation_mismatch", 9), BASE_RETRY_MS << 8);
    }

    #[tokio::test]
    async fn startup_rearms_only_rows_waiting_on_the_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        for (id, status, error, next) in [
            ("outage", "retry", Some(RUNTIME_UNAVAILABLE), 9_000),
            ("due", "retry", Some(RUNTIME_UNAVAILABLE), 100),
            ("mismatch", "retry", Some("confirmation_mismatch"), 9_000),
            ("blocked", "blocked", Some(RUNTIME_UNAVAILABLE), 9_000),
        ] {
            sqlx::query(
                r#"
                INSERT INTO suwayomi_projection_outbox (
                  operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
                  source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
                  created_at_ms, updated_at_ms
                ) VALUES (?, 'main', 'UpdateManga', '{"id":7}', 'comic.library', ?, 1, ?, 9, ?, ?, 1, 1)
                "#,
            )
            .bind(id)
            .bind(id)
            .bind(status)
            .bind(next)
            .bind(error)
            .execute(&pool)
            .await
            .unwrap();
        }

        assert_eq!(rearm_runtime_retries(&pool, 500, None).await.unwrap(), 1);
        let rows: Vec<(String, i64, i64)> = sqlx::query_as(
            "SELECT operation_id, attempt_count, next_attempt_at_ms FROM suwayomi_projection_outbox ORDER BY operation_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                ("blocked".to_string(), 9, 9_000),
                ("due".to_string(), 9, 100),
                ("mismatch".to_string(), 9, 9_000),
                ("outage".to_string(), 9, 500),
            ]
        );
    }

    #[tokio::test]
    async fn a_returned_runtime_rearms_only_its_own_profile() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        for (id, profile, error, next) in [
            ("main-outage", "main", RUNTIME_UNAVAILABLE, 9_000),
            ("side-outage", "side", RUNTIME_UNAVAILABLE, 9_000),
            ("side-due", "side", RUNTIME_UNAVAILABLE, 100),
            ("other-mismatch", "other", "confirmation_mismatch", 9_000),
        ] {
            sqlx::query(
                r#"
                INSERT INTO suwayomi_projection_outbox (
                  operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
                  source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
                  created_at_ms, updated_at_ms
                ) VALUES (?, ?, 'UpdateManga', '{"id":7}', 'comic.library', ?, 1, 'retry', 2, ?, ?, 1, 1)
                "#,
            )
            .bind(id)
            .bind(profile)
            .bind(id)
            .bind(next)
            .bind(error)
            .execute(&pool)
            .await
            .unwrap();
        }

        assert_eq!(
            runtime_waiting_profiles(&pool, 500).await.unwrap(),
            vec!["main".to_string(), "side".to_string()]
        );
        assert_eq!(rearm_runtime_retries(&pool, 500, Some("side")).await.unwrap(), 1);
        let rows: Vec<(String, i64, i64)> = sqlx::query_as(
            "SELECT operation_id, attempt_count, next_attempt_at_ms FROM suwayomi_projection_outbox ORDER BY operation_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                ("main-outage".to_string(), 2, 9_000),
                ("other-mismatch".to_string(), 2, 9_000),
                ("side-due".to_string(), 2, 100),
                ("side-outage".to_string(), 2, 500),
            ]
        );
        assert_eq!(runtime_waiting_profiles(&pool, 500).await.unwrap(), vec!["main".to_string()]);
    }

    #[test]
    fn runtime_return_watch_reports_only_a_runtime_seen_down_that_answers_again() {
        let mut watch = RuntimeReturnWatch::default();
        // Answering from the first probe is no return: the write failed for another reason.
        assert!(!watch.returned("main", true));
        // Down, still down, back: one return, then none while it keeps answering.
        assert_eq!(
            [false, false, true, true].map(|answers| watch.returned("main", answers)),
            [false, false, true, false]
        );
        // Profiles are followed independently.
        assert!(!watch.returned("main", false));
        assert!(!watch.returned("side", false));
        assert!(watch.returned("side", true));
        // Once nothing waits on it, an earlier outage is forgotten.
        watch.retain(&[]);
        assert!(!watch.returned("main", true));
    }

    #[test]
    fn maintenance_watch_reports_only_the_release_of_the_lease() {
        let mut watch = MaintenanceWatch::default();
        // No maintenance yet, then an update holds the lease across ticks, then releases it.
        let observed = [false, false, true, true, false, false, true, false]
            .map(|held| watch.ended(held));
        assert_eq!(observed, [false, false, false, false, true, false, false, true]);
    }

    #[test]
    fn delete_category_confirms_when_suwayomi_no_longer_has_it() {
        let variables = serde_json::json!({ "id": 7 });
        assert!(projection_confirmed(
            CommandOperation::DeleteCategory,
            &variables,
            &serde_json::json!({ "deleteCategory": { "category": null, "mangas": [] } }),
        ));
        assert!(projection_confirmed(
            CommandOperation::DeleteCategory,
            &variables,
            &serde_json::json!({ "deleteCategory": { "category": { "id": 7 }, "mangas": [] } }),
        ));
        assert!(!projection_confirmed(
            CommandOperation::DeleteCategory,
            &variables,
            &serde_json::json!({ "deleteCategory": { "category": { "id": 8 }, "mangas": [] } }),
        ));
        assert!(!projection_confirmed(
            CommandOperation::DeleteCategory,
            &variables,
            &serde_json::json!({ "deleteCategory": null }),
        ));
        assert!(!projection_confirmed(
            CommandOperation::DeleteCategory,
            &variables,
            &serde_json::json!({ "deleteCategory": {} }),
        ));
    }

    #[test]
    fn confirms_each_allowlisted_projection_shape() {
        assert!(projection_confirmed(
            CommandOperation::UpdateManga,
            &serde_json::json!({ "id": 7, "inLibrary": true }),
            &serde_json::json!({ "updateManga": { "manga": { "id": 7, "inLibrary": true } } }),
        ));
        assert!(projection_confirmed(
            CommandOperation::UpdateMangaCategories,
            &serde_json::json!({ "mangaId": 7, "addTo": [3], "removeFrom": [] }),
            &serde_json::json!({ "updateMangaCategories": { "manga": { "id": 7 } } }),
        ));
        assert!(projection_confirmed(
            CommandOperation::UpdateChaptersProgress,
            &serde_json::json!({
                "mangaId": 7,
                "ids": [11],
                "isRead": true,
                "isBookmarked": false,
                "lastPageRead": 8
            }),
            &serde_json::json!({
                "updateChapters": {
                    "chapters": [{
                        "id": 11,
                        "isRead": true,
                        "isBookmarked": false,
                        "lastPageRead": 8
                    }]
                }
            }),
        ));
        assert!(projection_confirmed(
            CommandOperation::UpdateCategory,
            &serde_json::json!({ "id": 3, "name": "Reading" }),
            &serde_json::json!({
                "updateCategory": { "category": { "id": 3, "name": "Reading", "order": 2 } }
            }),
        ));
        assert!(projection_confirmed(
            CommandOperation::DeleteCategory,
            &serde_json::json!({ "id": 3 }),
            &serde_json::json!({ "deleteCategory": { "category": { "id": 3 } } }),
        ));
        assert!(projection_confirmed(
            CommandOperation::UpdateCategoryOrder,
            &serde_json::json!({ "id": 3, "position": 2 }),
            &serde_json::json!({
                "updateCategoryOrder": { "categories": [{ "id": 3, "order": 2 }] }
            }),
        ));
    }

    #[test]
    fn category_order_past_the_end_confirms_at_the_clamped_last_slot() {
        let categories = serde_json::json!({
            "updateCategoryOrder": { "categories": [
                { "id": 0, "order": 0 },
                { "id": 1, "order": 1 },
                { "id": 2, "order": 2 },
                { "id": 3, "order": 3 }
            ] }
        });
        assert!(projection_confirmed(
            CommandOperation::UpdateCategoryOrder,
            &serde_json::json!({ "id": 3, "position": 6 }),
            &categories,
        ));
        assert!(!projection_confirmed(
            CommandOperation::UpdateCategoryOrder,
            &serde_json::json!({ "id": 2, "position": 4 }),
            &categories,
        ));
    }

    #[test]
    fn category_assignment_id_matches_mobile_derivation() {
        assert_eq!(
            comic_category_assignment_id(
                "suwayomi:profile:main:manga:42",
                "suwayomi:profile:main:category:3",
            ),
            "comic-category-assignment:00c5f18254b2162d827bffb3f61ce9d9d3169ad7ff94970b101ad7273800251f"
        );
    }

    #[test]
    fn resolves_hashed_category_assignment_for_both_legacy_id_forms() {
        let categories = serde_json::json!({
            "nodes": [
                { "id": 0, "mangas": { "nodes": [{ "id": 42 }] } },
                { "id": 3, "mangas": { "nodes": [{ "id": 41 }, { "id": 42 }] } },
                { "id": 5, "mangas": { "nodes": [{ "id": 42 }] } }
            ]
        });
        for prefix in ["suwayomi:profile:main", "suwayomi:server:desktop-a:profile:main"] {
            let assignment_id = comic_category_assignment_id(
                &format!("{prefix}:manga:42"),
                &format!("{prefix}:category:3"),
            );
            assert_eq!(
                find_category_assignment_pair(&assignment_id, "main", "desktop-a", &categories),
                Some((42, 3)),
                "{prefix}"
            );
            assert_eq!(
                find_category_assignment_pair(&assignment_id, "other", "desktop-a", &categories),
                None
            );
        }
        let foreign_server = comic_category_assignment_id(
            "suwayomi:server:desktop-b:profile:main:manga:42",
            "suwayomi:server:desktop-b:profile:main:category:3",
        );
        assert_eq!(
            find_category_assignment_pair(&foreign_server, "main", "desktop-a", &categories),
            None
        );
    }

    #[test]
    fn rejects_incomplete_or_mismatched_projection_confirmation() {
        assert!(!projection_confirmed(
            CommandOperation::UpdateManga,
            &serde_json::json!({ "id": 7, "inLibrary": true }),
            &serde_json::json!({ "updateManga": { "manga": { "id": 7, "inLibrary": false } } }),
        ));
        assert!(!projection_confirmed(
            CommandOperation::UpdateChaptersProgress,
            &serde_json::json!({ "ids": [11], "lastPageRead": 8 }),
            &serde_json::json!({ "updateChapters": { "chapters": [] } }),
        ));
        assert!(!projection_confirmed(
            CommandOperation::UpdateCategoryOrder,
            &serde_json::json!({ "id": 3, "position": 2 }),
            &serde_json::json!({
                "updateCategoryOrder": { "categories": [
                    { "id": 1, "order": 2 },
                    { "id": 3, "order": 1 }
                ] }
            }),
        ));
    }
}
