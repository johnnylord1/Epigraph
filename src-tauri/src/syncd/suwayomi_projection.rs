use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
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
use super::routes::suwayomi_import;
use super::routes::suwayomi_proxy;
use super::{db, routes::suwayomi_catalog};

const MAX_BATCH: usize = 8;
/// How long one tick keeps draining a backlog batch after batch. The 2 s tick only paces an idle or
/// failing queue; a synced backlog would otherwise wait out a tick after every eight rows.
const DRAIN_BUDGET: Duration = Duration::from_secs(4);
/// A synced library arrives as runs of the same change (every work into the library, every work
/// of one category into it); a run is sent to Suwayomi as one bulk mutation of up to this many.
/// A device's progress arrives as runs of chapters of one work, which share one chapter lookup and
/// go out as one mutation per distinct progress state.
const MAX_GROUPED_ROWS: usize = 50;
const UPDATE_MANGAS_MUTATION: &str = r#"
mutation EpigraphCoreUpdateMangas($ids: [Int!]!, $inLibrary: Boolean) {
  updateMangas(input: { ids: $ids, patch: { inLibrary: $inLibrary } }) { mangas { id inLibrary } }
}
"#;
const UPDATE_MANGAS_CATEGORIES_MUTATION: &str = r#"
mutation EpigraphCoreUpdateMangasCategories($ids: [Int!]!, $addTo: [Int!], $removeFrom: [Int!]) {
  updateMangasCategories(input: { ids: $ids, patch: { addToCategories: $addTo, removeFromCategories: $removeFrom } }) { mangas { id } }
}
"#;
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
/// Rows waiting on their own work or chapter to appear here. They concern no other work, so they
/// do not hold later rows of the profile: one comic whose source is down must not stall the rest.
const UNBOUND_WORK_CODES: [&str; 2] = ["portable_work_not_bound", "portable_chapter_not_resolved"];
/// Chapter progress whose chapter this Suwayomi still lacks after [MAX_CONFIRMATION_ATTEMPTS]
/// lookups. It keeps retrying on the slow backoff, since the chapter can appear on a later library
/// update, but it stops counting as pending: a source whose chapter keys differ between devices
/// would otherwise keep every device syncing forever.
const WAITING_CHAPTER_CODE: &str = UNBOUND_WORK_CODES[1];
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
        let mut import = ImportWatch::default();
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
                        // Works first: their categories and progress need them to be here.
                        match import_unseen_comics(&state, &mut import).await {
                            Ok(ImportPass::Idle) => {}
                            Ok(ImportPass::Busy) => continue,
                            Err(error) => {
                                tracing::warn!(error = %error, "failed to import synced works into Suwayomi")
                            }
                        }
                    }
                    let started = std::time::Instant::now();
                    loop {
                        match drain_ready(&state).await {
                            Ok(claimed) if claimed == MAX_BATCH && started.elapsed() < DRAIN_BUDGET => {}
                            Ok(_) => break,
                            Err(error) => {
                                tracing::warn!(error = %error, "failed to drain canonical Suwayomi projections");
                                break;
                            }
                        }
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

/// Projections still expected to land without a user action. Blocked rows and chapter progress
/// still waiting for its chapter are left out, so they cannot hold the first run forever.
pub async fn pending_projection_count(state: &SharedAppState) -> anyhow::Result<i64> {
    pending_projection_count_in(&state.pool).await
}

async fn pending_projection_count_in(pool: &sqlx::SqlitePool) -> anyhow::Result<i64> {
    sqlx::query_scalar(
        r#"
        SELECT COUNT(*) FROM suwayomi_projection_outbox
        WHERE status IN ('pending', 'in_flight', 'retry')
          AND NOT (status = 'retry' AND last_error IS ? AND attempt_count >= ?)
        "#,
    )
    .bind(WAITING_CHAPTER_CODE)
    .bind(MAX_CONFIRMATION_ATTEMPTS)
    .fetch_one(pool)
    .await
    .context("failed to count pending Suwayomi projections")
}

/// A profile's projection counts for `/v1/sync/status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, FromRow)]
pub struct ProjectionStatusCounts {
    pub pending: i64,
    pub blocked: i64,
    pub in_flight: i64,
    /// Rows other than chapter progress still to project, which hold the catalog revisions back.
    pub catalog_pending: i64,
}

pub async fn projection_status_counts(
    pool: &sqlx::SqlitePool,
    profile_id: &str,
) -> anyhow::Result<ProjectionStatusCounts> {
    sqlx::query_as(
        r#"
        SELECT
            COALESCE(SUM(CASE WHEN status IN ('pending', 'retry') AND NOT waiting THEN 1 ELSE 0 END), 0)
                AS pending,
            COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked,
            COALESCE(SUM(CASE WHEN status = 'in_flight' THEN 1 ELSE 0 END), 0) AS in_flight,
            COALESCE(SUM(CASE WHEN status IN ('pending', 'retry', 'in_flight') AND NOT waiting
                AND operation_name <> 'UpdateChaptersProgress' THEN 1 ELSE 0 END), 0) AS catalog_pending
        FROM (
            SELECT status, operation_name,
                (status = 'retry' AND last_error IS ? AND attempt_count >= ?) AS waiting
            FROM suwayomi_projection_outbox
            WHERE profile_id = ?
        )
        "#,
    )
    .bind(WAITING_CHAPTER_CODE)
    .bind(MAX_CONFIRMATION_ATTEMPTS)
    .bind(profile_id)
    .fetch_one(pool)
    .await
    .context("failed to count Suwayomi projections for the sync status")
}

/// Projections this process has applied to Suwayomi. The desktop UI watches it to reload what it
/// shows once synced changes land there.
static APPLIED_PROJECTIONS: AtomicU64 = AtomicU64::new(0);

pub fn applied_projection_count() -> u64 {
    APPLIED_PROJECTIONS.load(Ordering::Relaxed)
}

/// Applies up to `MAX_BATCH` ready projections (each with the rows grouped behind it) and returns
/// how many it claimed, so a full batch tells the caller more are waiting.
async fn drain_ready(state: &SharedAppState) -> anyhow::Result<usize> {
    let mut claimed = 0;
    for _ in 0..MAX_BATCH {
        let Some(row) = claim_next(state).await? else {
            break;
        };
        claimed += 1;
        let change = serde_json::from_str::<Value>(&row.variables_json)
            .ok()
            .and_then(|variables| group_change(&row.operation_name, &variables));
        let companions = match &change {
            Some(change) => claim_group(state, &row, change).await?,
            None => Vec::new(),
        };
        match change {
            Some(change) if !companions.is_empty() => {
                let mut rows = Vec::with_capacity(companions.len() + 1);
                rows.push(row);
                rows.extend(companions);
                for (row, outcome) in apply_group(state, rows, &change).await {
                    settle(state, &row, outcome).await?;
                }
            }
            _ => {
                let outcome = apply_projection(state, &row).await;
                settle(state, &row, outcome).await?;
            }
        }
    }
    Ok(claimed)
}

/// Stores a projection's outcome; true when it was applied and left the outbox.
async fn settle(
    state: &SharedAppState,
    row: &ProjectionRow,
    outcome: ProjectionOutcome,
) -> anyhow::Result<bool> {
    match outcome {
        ProjectionOutcome::Applied => {
            let _writer_guard = state.mutation_gate.lock().await;
            sqlx::query("DELETE FROM suwayomi_projection_outbox WHERE operation_id = ?")
                .bind(&row.operation_id)
                .execute(&state.pool)
                .await?;
            APPLIED_PROJECTIONS.fetch_add(1, Ordering::Relaxed);
            return Ok(true);
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
    Ok(false)
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
    claim_next_at(&state.pool, super::db::now_ms()).await
}

async fn claim_next_at(pool: &sqlx::SqlitePool, now: i64) -> anyhow::Result<Option<ProjectionRow>> {
    let mut tx = pool.begin().await?;
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
              AND COALESCE(earlier.last_error, '') NOT IN (?, ?)
          )
        ORDER BY source_server_version ASC
        LIMIT 1
        "#,
    )
    .bind(now)
    .bind(ORDERED_RETRY_ATTEMPTS)
    .bind(UNBOUND_WORK_CODES[0])
    .bind(UNBOUND_WORK_CODES[1])
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

/// The part of a work change that is the same for every work it applies to, when it can be sent
/// in one bulk mutation: `inLibrary` for UpdateManga, the category lists for
/// UpdateMangaCategories.
fn group_change(operation_name: &str, variables: &Value) -> Option<Value> {
    match operation_name {
        "UpdateManga" => {
            let in_library = variables.get("inLibrary")?.as_bool()?;
            Some(json!({ "inLibrary": in_library }))
        }
        "UpdateMangaCategories" => {
            let categories = |key: &str| -> Option<Vec<i64>> {
                variables
                    .get(key)?
                    .as_array()?
                    .iter()
                    .map(|id| id.as_i64().filter(|id| (0..=i32::MAX as i64).contains(id)))
                    .collect()
            };
            let add_to = categories("addTo")?;
            let remove_from = categories("removeFrom")?;
            if add_to.is_empty() && remove_from.is_empty() {
                return None;
            }
            Some(json!({ "addTo": add_to, "removeFrom": remove_from }))
        }
        "UpdateChaptersProgress" => {
            variables.get("portableChapterRef").filter(|value| !value.is_null())?;
            let work = variables.get("portableWorkRef").filter(|value| !value.is_null())?;
            Some(json!({ "portableWorkRef": work }))
        }
        _ => None,
    }
}

async fn claim_group(
    state: &SharedAppState,
    first: &ProjectionRow,
    change: &Value,
) -> anyhow::Result<Vec<ProjectionRow>> {
    let _writer_guard = state.mutation_gate.lock().await;
    claim_group_at(&state.pool, super::db::now_ms(), first, change).await
}

/// Claims the rows right after `first` (already claimed) that make the same change, so they can
/// go to Suwayomi together. Only an unbroken run is taken: it stops at the first ready row that
/// does something else, so no change is applied ahead of an earlier, different one.
async fn claim_group_at(
    pool: &sqlx::SqlitePool,
    now: i64,
    first: &ProjectionRow,
    change: &Value,
) -> anyhow::Result<Vec<ProjectionRow>> {
    let mut tx = pool.begin().await?;
    let candidates = sqlx::query_as::<_, ProjectionRow>(
        r#"
        SELECT operation_id, profile_id, operation_name, variables_json, attempt_count
        FROM suwayomi_projection_outbox AS candidate
        WHERE candidate.profile_id = ? AND candidate.operation_id != ?
          AND status IN ('pending', 'retry') AND next_attempt_at_ms <= ?
          AND source_server_version >= (
            SELECT source_server_version FROM suwayomi_projection_outbox WHERE operation_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM suwayomi_projection_outbox AS earlier
            WHERE earlier.profile_id = candidate.profile_id
              AND earlier.source_server_version < candidate.source_server_version
              AND earlier.status = 'retry'
              AND earlier.attempt_count < ?
              AND COALESCE(earlier.last_error, '') NOT IN (?, ?)
          )
        ORDER BY source_server_version ASC
        LIMIT ?
        "#,
    )
    .bind(&first.profile_id)
    .bind(&first.operation_id)
    .bind(now)
    .bind(&first.operation_id)
    .bind(ORDERED_RETRY_ATTEMPTS)
    .bind(UNBOUND_WORK_CODES[0])
    .bind(UNBOUND_WORK_CODES[1])
    .bind((MAX_GROUPED_ROWS - 1) as i64)
    .fetch_all(&mut *tx)
    .await?;
    let group: Vec<ProjectionRow> = candidates
        .into_iter()
        .take_while(|row| {
            row.operation_name == first.operation_name
                && serde_json::from_str::<Value>(&row.variables_json)
                    .ok()
                    .and_then(|variables| group_change(&row.operation_name, &variables))
                    .as_ref()
                    == Some(change)
        })
        .collect();
    for row in &group {
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
    Ok(group)
}

/// Applies rows that make the same change with one bulk mutation. Each row resolves its work as
/// it would alone; rows that cannot join (a failed resolution, the same work twice) and every row
/// of a bulk mutation Suwayomi rejects are applied one by one instead.
async fn apply_group(
    state: &SharedAppState,
    rows: Vec<ProjectionRow>,
    change: &Value,
) -> Vec<(ProjectionRow, ProjectionOutcome)> {
    let mut outcomes = Vec::with_capacity(rows.len());
    let mut lookup = ChapterLookup::default();
    // The work, or for progress the chapter, each row changes, with its resolved variables.
    let mut members: Vec<(ProjectionRow, i64, Value)> = Vec::new();
    let mut alone = Vec::new();
    let mut target_ids = BTreeSet::new();
    let updates_chapters = rows
        .first()
        .is_some_and(|row| row.operation_name == "UpdateChaptersProgress");
    for row in rows {
        let Ok(variables) = serde_json::from_str::<Value>(&row.variables_json) else {
            outcomes.push((row, ProjectionOutcome::Blocked("invalid_variables")));
            continue;
        };
        let variables =
            match resolve_portable_projection_identity(state, &row, variables, &mut lookup).await {
                Ok(variables) => variables,
                Err(outcome) => {
                    outcomes.push((row, outcome));
                    continue;
                }
            };
        let target = match row.operation_name.as_str() {
            "UpdateManga" => variables.get("id"),
            "UpdateChaptersProgress" => variables.pointer("/ids/0"),
            _ => variables.get("mangaId"),
        };
        match target
            .and_then(Value::as_i64)
            .filter(|id| (1..=i32::MAX as i64).contains(id))
        {
            Some(id) if target_ids.insert(id) => members.push((row, id, variables)),
            _ => alone.push(row),
        }
    }
    if members.len() < 2 {
        alone.extend(members.drain(..).map(|(row, ..)| row));
    } else if updates_chapters {
        apply_chapter_members(state, members, &mut outcomes, &mut alone).await;
    } else {
        let profile_id = members[0].0.profile_id.clone();
        let ids: Vec<i64> = members.iter().map(|(_, manga_id, _)| *manga_id).collect();
        let updates_library = members[0].0.operation_name == "UpdateManga";
        let (document, variables) = if updates_library {
            (UPDATE_MANGAS_MUTATION, json!({ "ids": ids, "inLibrary": change["inLibrary"] }))
        } else {
            (
                UPDATE_MANGAS_CATEGORIES_MUTATION,
                json!({ "ids": ids, "addTo": change["addTo"], "removeFrom": change["removeFrom"] }),
            )
        };
        match suwayomi_catalog::execute_graphql_document(
            state,
            &projection_session(&profile_id),
            document,
            variables,
            true,
        )
        .await
        {
            Ok(data) => {
                let confirmed = group_confirmed_ids(updates_library, change, &data);
                for (row, manga_id, _) in members {
                    let outcome =
                        confirmation_outcome(confirmed.contains(&manga_id), row.attempt_count);
                    outcomes.push((row, outcome));
                }
            }
            Err(AppError::ServiceUnavailable(detail)) if detail.retryable != Some(false) => {
                let error = AppError::ServiceUnavailable(detail);
                for (row, ..) in members {
                    let outcome = failed_command_outcome(&error, row.attempt_count);
                    outcomes.push((row, outcome));
                }
            }
            Err(_) => alone.extend(members.into_iter().map(|(row, ..)| row)),
        }
    }
    for row in alone {
        let outcome = apply_projection_with(state, &row, &mut lookup).await;
        outcomes.push((row, outcome));
    }
    outcomes
}

/// Sends grouped progress rows as one `updateChapters` per distinct progress state. Each row names
/// a different chapter, so the order between those mutations does not matter; a row is confirmed
/// on its own chapter as it would be alone.
async fn apply_chapter_members(
    state: &SharedAppState,
    members: Vec<(ProjectionRow, i64, Value)>,
    outcomes: &mut Vec<(ProjectionRow, ProjectionOutcome)>,
    alone: &mut Vec<ProjectionRow>,
) {
    let mut by_patch: Vec<(Value, Vec<(ProjectionRow, i64, Value)>)> = Vec::new();
    for member in members {
        let patch = chapter_progress_patch(&member.2);
        match by_patch.iter_mut().find(|(existing, _)| *existing == patch) {
            Some((_, rows)) => rows.push(member),
            None => by_patch.push((patch, vec![member])),
        }
    }
    for (mut variables, members) in by_patch {
        let profile_id = members[0].0.profile_id.clone();
        variables["ids"] = members.iter().map(|(_, chapter_id, _)| *chapter_id).collect();
        match suwayomi_commands::execute_internal_command(
            state,
            &profile_id,
            CommandOperation::UpdateChaptersProgress,
            variables,
        )
        .await
        {
            Ok(data) => {
                for (row, _, variables) in members {
                    let confirmed = chapters_projection_confirmed(&variables, &data);
                    let outcome = confirmation_outcome(confirmed, row.attempt_count);
                    outcomes.push((row, outcome));
                }
            }
            Err(AppError::ServiceUnavailable(detail)) if detail.retryable != Some(false) => {
                let error = AppError::ServiceUnavailable(detail);
                for (row, ..) in members {
                    let outcome = failed_command_outcome(&error, row.attempt_count);
                    outcomes.push((row, outcome));
                }
            }
            Err(_) => alone.extend(members.into_iter().map(|(row, ..)| row)),
        }
    }
}

/// The progress a resolved `UpdateChaptersProgress` row sets, without the chapter it sets it on.
fn chapter_progress_patch(variables: &Value) -> Value {
    let field = |name: &str| variables.get(name).cloned().unwrap_or(Value::Null);
    json!({
        "isRead": field("isRead"),
        "isBookmarked": field("isBookmarked"),
        "lastPageRead": field("lastPageRead"),
    })
}

/// Works the bulk mutation answered for, in the state it asked for.
fn group_confirmed_ids(updates_library: bool, change: &Value, data: &Value) -> BTreeSet<i64> {
    let (payload, expected_membership) = if updates_library {
        ("updateMangas", change.get("inLibrary").and_then(Value::as_bool))
    } else {
        ("updateMangasCategories", None)
    };
    data.get(payload)
        .and_then(|value| value.get("mangas"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|manga| {
            expected_membership.map_or(true, |expected| {
                manga.get("inLibrary").and_then(Value::as_bool) == Some(expected)
            })
        })
        .filter_map(|manga| manga.get("id").and_then(Value::as_i64))
        .collect()
}

async fn apply_projection(state: &SharedAppState, row: &ProjectionRow) -> ProjectionOutcome {
    apply_projection_with(state, row, &mut ChapterLookup::default()).await
}

async fn apply_projection_with(
    state: &SharedAppState,
    row: &ProjectionRow,
    lookup: &mut ChapterLookup,
) -> ProjectionOutcome {
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
    let variables = match resolve_portable_projection_identity(state, row, variables, lookup).await {
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
    lookup: &mut ChapterLookup,
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
        Some(chapter_id) => resolve_chapter_id(state, &row.profile_id, manga_id, chapter_key, lookup)
            .await
            .unwrap_or(chapter_id),
        None => resolve_chapter_id(state, &row.profile_id, manga_id, chapter_key, lookup).await?,
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
    let mut manga_id = lookup_local_comic(state, &session, work)
        .await
        .map_err(|()| ProjectionOutcome::Retry(RUNTIME_UNAVAILABLE))?;
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

/// Remembers which unseen works an import pass already tried, so a work Suwayomi still does not
/// list afterwards falls back to the per-row path instead of being restored every tick.
#[derive(Default)]
struct ImportWatch {
    attempted: BTreeSet<String>,
    failures: u32,
}

impl ImportWatch {
    fn key(profile_id: &str, portable_work_id: &str) -> String {
        format!("{profile_id}\0{portable_work_id}")
    }
}

enum ImportPass {
    /// Nothing left to bring in; the queue drains normally.
    Idle,
    /// A batch was handled; the next tick looks for more before draining.
    Busy,
}

/// A work some device keeps in its library, with what the outbox holds about it.
#[derive(Debug)]
struct UnseenWork {
    profile_id: String,
    portable_work_id: String,
    work: PortableWorkRefV3,
    title_hint: Option<String>,
    in_library: bool,
    operation_ids: Vec<String>,
    /// Chapter key → the newest progress the outbox carries for it.
    chapters: std::collections::BTreeMap<String, Value>,
}

/// Groups outbox rows that name a portable comic by profile and work, oldest first.
fn collect_portable_works(rows: &[(String, String, String, String)]) -> Vec<UnseenWork> {
    let mut works: Vec<UnseenWork> = Vec::new();
    let mut indexes = std::collections::HashMap::new();
    for (operation_id, profile_id, operation_name, variables_json) in rows {
        let Ok(variables) = serde_json::from_str::<Value>(variables_json) else {
            continue;
        };
        let Some(work) = variables
            .get("portableWorkRef")
            .cloned()
            .and_then(|value| serde_json::from_value::<PortableWorkRefV3>(value).ok())
            .filter(|work| work.validate().is_ok() && matches!(work, PortableWorkRefV3::Comic { .. }))
        else {
            continue;
        };
        let portable_work_id = canonical_portable_work_id(&work);
        let index = *indexes
            .entry(ImportWatch::key(profile_id, &portable_work_id))
            .or_insert_with(|| {
                works.push(UnseenWork {
                    profile_id: profile_id.clone(),
                    portable_work_id,
                    work,
                    title_hint: None,
                    in_library: false,
                    operation_ids: Vec::new(),
                    chapters: Default::default(),
                });
                works.len() - 1
            });
        let entry = &mut works[index];
        entry.operation_ids.push(operation_id.clone());
        match operation_name.as_str() {
            "UpdateManga" => {
                if let Some(in_library) = variables.get("inLibrary").and_then(Value::as_bool) {
                    entry.in_library = in_library;
                }
                if let Some(title) = variables
                    .get(db::PORTABLE_TITLE_HINT_FIELD)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                {
                    entry.title_hint = Some(title.to_string());
                }
            }
            "UpdateChaptersProgress" => {
                if let Some(key) = variables
                    .pointer("/portableChapterRef/chapterKey")
                    .and_then(Value::as_str)
                {
                    entry.chapters.insert(key.to_string(), variables.clone());
                }
            }
            _ => {}
        }
    }
    works
}

/// The work as `suwayomi_import` takes it: in the library, with the chapters a device has progress
/// on. `suwayomi_hydration` then fetches its details, cover and full chapter list from the source.
///
/// The stand-in chapters carry no chapter number (-1). Suwayomi gives a chapter it adds the read
/// and bookmark state of a removed chapter with the same number, so a stand-in numbered 0 that the
/// source drops would mark the source's chapter 0 read.
fn import_work_variables(work: &UnseenWork) -> Option<Value> {
    let PortableWorkRefV3::Comic {
        source_id,
        manga_key,
    } = &work.work
    else {
        return None;
    };
    let title = work
        .title_hint
        .clone()
        .unwrap_or_else(|| manga_key.clone());
    let chapters: Vec<Value> = work
        .chapters
        .iter()
        .map(|(key, progress)| {
            json!({
                "url": key,
                "name": chapter_name_hint(key),
                "isRead": progress.get("isRead").and_then(Value::as_bool).unwrap_or(false),
                "isBookmarked": progress.get("isBookmarked").and_then(Value::as_bool).unwrap_or(false),
                "lastPageRead": progress.get("lastPageRead").and_then(Value::as_i64).unwrap_or(0),
                "chapterNumber": -1.0,
            })
        })
        .collect();
    let variables = json!({ "works": [{
        "sourceId": source_id,
        "url": manga_key,
        "title": title,
        "dateAdded": db::now_ms(),
        "chapters": chapters,
    }] });
    suwayomi_import::normalized_import(variables)
        .ok()
        .and_then(|mut value| value.get_mut("works")?.as_array_mut()?.pop())
}

/// A readable stand-in for a chapter name until the source lists the chapter: the last segment of
/// its key (`/manga/a/chapter-12` → `chapter-12`).
fn chapter_name_hint(chapter_key: &str) -> String {
    chapter_key
        .trim_end_matches('/')
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or(chapter_key)
        .to_string()
}

/// Brings in, one restore at a time, the works devices keep in their library that this Suwayomi
/// has never listed: a desktop that joins (or was reset) gets the whole library at once instead of
/// searching every source for every title. Categories and progress then drain as usual.
async fn import_unseen_comics(
    state: &SharedAppState,
    watch: &mut ImportWatch,
) -> anyhow::Result<ImportPass> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        r#"
        SELECT operation_id, profile_id, operation_name, variables_json
        FROM suwayomi_projection_outbox
        WHERE status IN ('pending', 'retry', 'blocked') AND variables_json LIKE '%"portableWorkRef"%'
        ORDER BY profile_id, source_server_version
        "#,
    )
    .fetch_all(&state.pool)
    .await
    .context("failed to list Suwayomi projections of portable works")?;
    let mut batch = Vec::new();
    for work in collect_portable_works(&rows) {
        if !work.in_library
            || watch
                .attempted
                .contains(&ImportWatch::key(&work.profile_id, &work.portable_work_id))
            || batch
                .first()
                .is_some_and(|first: &UnseenWork| first.profile_id != work.profile_id)
        {
            continue;
        }
        let bound = db::load_portable_work_binding(&state.pool, &work.profile_id, &work.portable_work_id)
            .await?
            .is_some_and(|binding| binding.resolution_state == "BOUND");
        if bound {
            watch
                .attempted
                .insert(ImportWatch::key(&work.profile_id, &work.portable_work_id));
            continue;
        }
        batch.push(work);
        if batch.len() == suwayomi_import::MAX_IMPORT_WORKS {
            break;
        }
    }
    let Some(profile_id) = batch.first().map(|work| work.profile_id.clone()) else {
        return Ok(ImportPass::Idle);
    };
    let session = projection_session(&profile_id);

    // Works Suwayomi already lists are only bound.
    let mut missing = Vec::new();
    for work in batch {
        match lookup_local_comic(state, &session, &work.work).await {
            Ok(Some(manga_id)) => bind_imported_comic(state, &work, manga_id).await?,
            Ok(None) => missing.push(work),
            // The runtime is not answering; its rows back off and are rearmed when it returns.
            Err(()) => return Ok(ImportPass::Idle),
        }
    }
    let works: Vec<Value> = missing.iter().filter_map(import_work_variables).collect();
    if !works.is_empty() {
        match suwayomi_import::import_works_confirmed(state, &session, json!({ "works": works })).await
        {
            Ok(_) => watch.failures = 0,
            Err(AppError::ServiceUnavailable(detail))
                if detail.retryable == Some(true) && watch.failures < 2 =>
            {
                watch.failures += 1;
                tracing::warn!(profile = %profile_id, code = %detail.code, "Suwayomi import of synced works will retry");
                return Ok(ImportPass::Busy);
            }
            Err(error) => {
                watch.failures = 0;
                tracing::warn!(profile = %profile_id, error = ?error, "Suwayomi import of synced works failed");
            }
        }
    }
    let mut imported = 0;
    for work in &missing {
        watch
            .attempted
            .insert(ImportWatch::key(&work.profile_id, &work.portable_work_id));
        if let Ok(Some(manga_id)) = lookup_local_comic(state, &session, &work.work).await {
            bind_imported_comic(state, work, manga_id).await?;
            imported += 1;
        }
    }
    if !missing.is_empty() {
        tracing::info!(profile = profile_id, imported, tried = missing.len(), "imported synced works into Suwayomi");
    }
    Ok(ImportPass::Busy)
}

/// The id Suwayomi has for the work's exact source and key, if it lists it.
async fn lookup_local_comic(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    work: &PortableWorkRefV3,
) -> Result<Option<i64>, ()> {
    let PortableWorkRefV3::Comic {
        source_id,
        manga_key,
    } = work
    else {
        return Ok(None);
    };
    let data = suwayomi_catalog::execute_graphql_document(
        state,
        session,
        PORTABLE_COMIC_LOOKUP_QUERY,
        json!({ "sourceId": source_id, "url": manga_key }),
        false,
    )
    .await
    .map_err(|_| ())?;
    Ok(exact_comic_match(data.pointer("/mangas/nodes"), manga_key))
}

/// Binds the work and makes its waiting rows due again with fresh attempts, so its category and
/// progress land now instead of after the backoff they earned while it was missing.
async fn bind_imported_comic(
    state: &SharedAppState,
    work: &UnseenWork,
    manga_id: i64,
) -> anyhow::Result<()> {
    let local_reference = manga_id.to_string();
    db::upsert_portable_work_binding(
        &state.pool,
        &work.profile_id,
        &work.portable_work_id,
        &work.work,
        None,
        Some(&local_reference),
        PortableResolutionStateV3::Bound,
        None,
        work.title_hint.as_deref(),
        None,
        0,
        db::now_ms(),
    )
    .await?;
    let now = db::now_ms();
    let _writer_guard = state.mutation_gate.lock().await;
    for operation_id in &work.operation_ids {
        sqlx::query(
            r#"
            UPDATE suwayomi_projection_outbox
            SET status = 'retry', attempt_count = 0, next_attempt_at_ms = ?, lease_until_ms = NULL,
                updated_at_ms = ?
            WHERE operation_id = ? AND status IN ('retry', 'blocked')
            "#,
        )
        .bind(now)
        .bind(now)
        .bind(operation_id)
        .execute(&state.pool)
        .await?;
    }
    Ok(())
}

/// Chapter pages fetched while resolving one batch, per work, so rows for chapters of the same
/// work share one lookup. A work's pages are fetched only as far as a row needs them.
#[derive(Default)]
struct ChapterLookup {
    works: HashMap<i64, ChapterPages>,
}

struct ChapterPages {
    nodes: Value,
    fetched: usize,
    complete: bool,
}

impl Default for ChapterPages {
    fn default() -> Self {
        Self { nodes: Value::Array(Vec::new()), fetched: 0, complete: false }
    }
}

async fn resolve_chapter_id(
    state: &SharedAppState,
    profile_id: &str,
    manga_id: i64,
    chapter_key: &str,
    lookup: &mut ChapterLookup,
) -> Result<i64, ProjectionOutcome> {
    let session = projection_session(profile_id);
    let pages = lookup.works.entry(manga_id).or_default();
    loop {
        let (exact, same_path) = chapter_key_matches(Some(&pages.nodes), manga_id, chapter_key);
        if let Some(id) = exact {
            return Ok(id);
        }
        if pages.complete {
            // A host-only difference binds only when it names a single chapter of the manga.
            let path_matches: BTreeSet<i64> = same_path.into_iter().collect();
            return path_matches
                .first()
                .copied()
                .filter(|_| path_matches.len() == 1)
                .ok_or(ProjectionOutcome::Retry("portable_chapter_not_resolved"));
        }
        if pages.fetched >= MAX_PORTABLE_CHAPTER_PAGES {
            return Err(ProjectionOutcome::Retry("portable_chapter_lookup_limit"));
        }
        let offset = (pages.fetched as i64).saturating_mul(PORTABLE_CHAPTER_PAGE_SIZE);
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
        if let (Some(nodes), Some(page)) = (
            pages.nodes.as_array_mut(),
            chapters.get("nodes").and_then(Value::as_array),
        ) {
            nodes.extend(page.iter().cloned());
        }
        pages.fetched += 1;
        pages.complete = !chapters
            .get("pageInfo")
            .and_then(|value| value.get("hasNextPage"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
    }
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

pub(crate) fn projection_session(profile_id: &str) -> AuthenticatedSession {
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
        CommandOperation::AddExtensionRepos
        | CommandOperation::InstallExtension
        | CommandOperation::ResolveManga
        | CommandOperation::FetchChapters
        | CommandOperation::ImportWorks => false,
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

    #[tokio::test]
    async fn binding_a_work_requeues_only_its_progress_that_gave_up() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        let work = |key: &str| json!({ "type": "comic", "sourceId": "10002", "mangaKey": key });
        for (id, key, status, error) in [
            ("bound-gave-up", "/series/a", "blocked", Some("portable_work_not_found")),
            ("bound-rejected", "/series/a", "blocked", Some("command_rejected")),
            ("other-gave-up", "/series/b", "blocked", Some("portable_work_not_found")),
        ] {
            sqlx::query(
                r#"
                INSERT INTO suwayomi_projection_outbox (
                  operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
                  source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
                  created_at_ms, updated_at_ms
                ) VALUES (?, 'main', 'UpdateChaptersProgress', ?, 'comic.chapter_state', ?, 1, ?, 6, 99, ?, 1, 1)
                "#,
            )
            .bind(id)
            .bind(json!({ "isRead": true, "portableWorkRef": work(key) }).to_string())
            .bind(id)
            .bind(status)
            .bind(error)
            .execute(&pool)
            .await
            .unwrap();
        }

        let reference = PortableWorkRefV3::comic("10002", "/series/a");
        db::upsert_portable_work_binding(
            &pool,
            "main",
            &canonical_portable_work_id(&reference),
            &reference,
            None,
            Some("7"),
            PortableResolutionStateV3::Bound,
            None,
            None,
            None,
            0,
            1,
        )
        .await
        .unwrap();

        let rows: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT operation_id, status, attempt_count FROM suwayomi_projection_outbox ORDER BY operation_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                ("bound-gave-up".to_string(), "retry".to_string(), 0),
                ("bound-rejected".to_string(), "blocked".to_string(), 6),
                ("other-gave-up".to_string(), "blocked".to_string(), 6),
            ]
        );
    }

    #[tokio::test]
    async fn a_manifest_snapshot_binds_its_works_in_one_pass_and_requeues_only_theirs() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        for (id, key) in [("a", "/series/a"), ("b", "/series/b"), ("c", "/series/c")] {
            sqlx::query(
                r#"
                INSERT INTO suwayomi_projection_outbox (
                  operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
                  source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
                  created_at_ms, updated_at_ms
                ) VALUES (?, 'main', 'UpdateChaptersProgress', ?, 'comic.chapter_state', ?, 1, 'blocked', 6, 99, 'portable_work_not_found', 1, 1)
                "#,
            )
            .bind(id)
            .bind(
                json!({
                    "isRead": true,
                    "portableWorkRef": { "type": "comic", "sourceId": "10002", "mangaKey": key },
                })
                .to_string(),
            )
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        }
        let first = PortableWorkRefV3::comic("10002", "/series/a");
        let second = PortableWorkRefV3::comic("10002", "/series/b");
        let novel = PortableWorkRefV3::Novel {
            plugin_id: "fixture.plugin".to_string(),
            novel_key: "/novel/a".to_string(),
        };
        let ids = [&first, &second, &novel].map(canonical_portable_work_id);
        let works = [
            db::BoundPortableWork {
                portable_id: &ids[0],
                reference: &first,
                dependency_key: None,
                local_reference: "7",
                title_hint: Some("First"),
                provider_label_hint: None,
            },
            db::BoundPortableWork {
                portable_id: &ids[1],
                reference: &second,
                dependency_key: None,
                local_reference: "8",
                title_hint: None,
                provider_label_hint: None,
            },
            db::BoundPortableWork {
                portable_id: &ids[2],
                reference: &novel,
                dependency_key: Some("fixture.plugin"),
                local_reference: "novel-1",
                title_hint: None,
                provider_label_hint: None,
            },
        ];

        db::upsert_bound_portable_works(&pool, "main", &works, 5).await.unwrap();

        for (id, local) in ids.iter().zip(["7", "8", "novel-1"]) {
            let row = db::load_portable_work_binding(&pool, "main", id).await.unwrap().unwrap();
            assert_eq!(row.local_reference.as_deref(), Some(local));
            assert_eq!(row.updated_at_ms, 5);
        }
        let rows: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT operation_id, status, attempt_count FROM suwayomi_projection_outbox ORDER BY operation_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                ("a".to_string(), "retry".to_string(), 0),
                ("b".to_string(), "retry".to_string(), 0),
                ("c".to_string(), "blocked".to_string(), 6),
            ]
        );
    }

    #[tokio::test]
    async fn the_ordered_claim_check_uses_the_order_index() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        // Without the index each claim read the whole profile queue once per due row (quadratic).
        let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(
            r#"
            EXPLAIN QUERY PLAN
            SELECT 1 FROM suwayomi_projection_outbox AS earlier
            WHERE earlier.profile_id = 'main' AND earlier.source_server_version < 10
              AND earlier.status = 'retry' AND earlier.attempt_count < 3
            "#,
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(
            plan.iter().any(|(_, _, _, detail)| detail.contains("idx_suwayomi_projection_order")),
            "{plan:?}"
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

    #[tokio::test]
    async fn a_work_waiting_to_be_found_does_not_hold_later_rows() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        for (id, version, status, error, next) in [
            ("unbound", 1, "retry", Some("portable_work_not_bound"), 9_000),
            ("chapter", 2, "retry", Some("portable_chapter_not_resolved"), 9_000),
            ("next", 3, "pending", None, 0),
        ] {
            sqlx::query(
                r#"
                INSERT INTO suwayomi_projection_outbox (
                  operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
                  source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
                  created_at_ms, updated_at_ms
                ) VALUES (?, 'main', 'UpdateManga', '{"id":7}', 'comic.library', ?, ?, ?, 1, ?, ?, 1, 1)
                "#,
            )
            .bind(id)
            .bind(id)
            .bind(version)
            .bind(status)
            .bind(next)
            .bind(error)
            .execute(&pool)
            .await
            .unwrap();
        }
        let claimed = claim_next_at(&pool, 500).await.unwrap().unwrap();
        assert_eq!(claimed.operation_id, "next");

        // Any other early failure still holds the profile's queue in order.
        sqlx::query(
            r#"
            INSERT INTO suwayomi_projection_outbox (
              operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
              source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
              created_at_ms, updated_at_ms
            ) VALUES ('outage', 'main', 'UpdateManga', '{"id":7}', 'comic.library', 'outage', 0,
                      'retry', 1, 9000, 'runtime_unavailable', 1, 1),
                     ('later', 'main', 'UpdateManga', '{"id":7}', 'comic.library', 'later', 4,
                      'pending', 0, 0, NULL, 1, 1)
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(claim_next_at(&pool, 600).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn chapter_progress_still_waiting_for_its_chapter_stops_counting_as_pending() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        for (id, operation, status, attempts, error) in [
            ("waiting", "UpdateChaptersProgress", "retry", MAX_CONFIRMATION_ATTEMPTS, Some(WAITING_CHAPTER_CODE)),
            ("young", "UpdateChaptersProgress", "retry", MAX_CONFIRMATION_ATTEMPTS - 1, Some(WAITING_CHAPTER_CODE)),
            ("outage", "UpdateChaptersProgress", "retry", 9, Some("runtime_unavailable")),
            ("fresh", "UpdateManga", "pending", 0, None),
            ("library", "UpdateManga", "retry", 9, Some(WAITING_CHAPTER_CODE)),
            ("gave_up", "UpdateManga", "blocked", 5, Some(PORTABLE_WORK_NOT_FOUND)),
        ] {
            sqlx::query(
                r#"
                INSERT INTO suwayomi_projection_outbox (
                  operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
                  source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
                  created_at_ms, updated_at_ms
                ) VALUES (?, 'main', ?, '{}', 'comic.history', ?, 1, ?, ?, 0, ?, 1, 1)
                "#,
            )
            .bind(id)
            .bind(operation)
            .bind(id)
            .bind(status)
            .bind(attempts)
            .bind(error)
            .execute(&pool)
            .await
            .unwrap();
        }
        let counts = projection_status_counts(&pool, "main").await.unwrap();
        assert_eq!(
            counts,
            ProjectionStatusCounts { pending: 3, blocked: 1, in_flight: 0, catalog_pending: 1 }
        );
        assert_eq!(projection_status_counts(&pool, "other").await.unwrap().pending, 0);
        // The first run waits only on rows that can still land on their own.
        assert_eq!(pending_projection_count_in(&pool).await.unwrap(), 3);
    }

    #[test]
    fn only_shared_work_changes_group() {
        assert_eq!(
            group_change("UpdateManga", &json!({ "id": 3, "inLibrary": true })),
            Some(json!({ "inLibrary": true }))
        );
        assert_eq!(group_change("UpdateManga", &json!({ "id": 3 })), None);
        assert_eq!(
            group_change(
                "UpdateMangaCategories",
                &json!({ "portableWorkRef": {}, "addTo": [2], "removeFrom": [] })
            ),
            Some(json!({ "addTo": [2], "removeFrom": [] }))
        );
        assert_eq!(
            group_change("UpdateMangaCategories", &json!({ "mangaId": 3, "addTo": [], "removeFrom": [] })),
            None
        );
        assert_eq!(
            group_change("UpdateMangaCategories", &json!({ "mangaId": 3, "addTo": [-1], "removeFrom": [] })),
            None
        );
        assert_eq!(
            group_change(db::REMOVE_COMIC_CATEGORY_ASSIGNMENT_OPERATION, &json!({ "assignmentId": "a" })),
            None
        );
        assert_eq!(group_change("UpdateChaptersProgress", &json!({ "mangaId": 3 })), None);
        let work = json!({ "type": "COMIC", "sourceId": "1", "mangaKey": "/m/1" });
        // Progress groups by work, whatever each chapter's state, so its chapters share a lookup.
        assert_eq!(
            group_change(
                "UpdateChaptersProgress",
                &json!({ "portableWorkRef": work, "portableChapterRef": { "chapterKey": "/c/1" }, "isRead": true })
            ),
            Some(json!({ "portableWorkRef": work }))
        );
        assert_eq!(
            group_change("UpdateChaptersProgress", &json!({ "portableWorkRef": work, "isRead": true })),
            None
        );
    }

    #[tokio::test]
    async fn chapter_progress_groups_the_unbroken_run_of_one_work() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        let progress = |manga_key: &str, chapter_key: &str, read: bool| {
            json!({
                "portableWorkRef": { "type": "COMIC", "sourceId": "1", "mangaKey": manga_key },
                "portableChapterRef": { "chapterKey": chapter_key },
                "isRead": read,
            })
            .to_string()
        };
        for (id, variables, version) in [
            ("first", progress("/m/1", "/c/1", true), 1),
            ("unread", progress("/m/1", "/c/2", false), 2),
            ("read", progress("/m/1", "/c/3", true), 3),
            ("other-work", progress("/m/2", "/c/1", true), 4),
            ("after-break", progress("/m/1", "/c/4", true), 5),
        ] {
            sqlx::query(
                r#"
                INSERT INTO suwayomi_projection_outbox (
                  operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
                  source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
                  created_at_ms, updated_at_ms
                ) VALUES (?, 'main', 'UpdateChaptersProgress', ?, 'comic.chapter_state', ?, ?, 'pending', 0, 0, NULL, 1, 1)
                "#,
            )
            .bind(id)
            .bind(variables)
            .bind(id)
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
        }
        let first = claim_next_at(&pool, 500).await.unwrap().unwrap();
        let change = group_change(&first.operation_name, &serde_json::from_str(&first.variables_json).unwrap())
            .unwrap();
        let group = claim_group_at(&pool, 500, &first, &change).await.unwrap();
        assert_eq!(
            group.iter().map(|row| row.operation_id.as_str()).collect::<Vec<_>>(),
            vec!["unread", "read"]
        );
    }

    #[test]
    fn chapter_progress_patch_leaves_out_the_chapter() {
        let resolved = json!({ "mangaId": 4, "ids": [9], "isRead": true, "lastPageRead": 3 });
        assert_eq!(
            chapter_progress_patch(&resolved),
            json!({ "isRead": true, "isBookmarked": null, "lastPageRead": 3 })
        );
        assert_eq!(
            chapter_progress_patch(&json!({ "ids": [10], "isRead": true, "lastPageRead": 3 })),
            chapter_progress_patch(&resolved)
        );
    }

    #[tokio::test]
    async fn a_group_takes_only_the_unbroken_run_of_the_same_change() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        let into_one = r#"{"mangaId":1,"addTo":[1],"removeFrom":[]}"#;
        for (id, profile, operation, variables, version, status, attempts, next) in [
            ("first", "main", "UpdateMangaCategories", into_one, 1, "pending", 0, 0),
            ("same", "main", "UpdateMangaCategories", into_one, 2, "pending", 0, 0),
            ("other-profile", "other", "UpdateMangaCategories", into_one, 3, "pending", 0, 0),
            // Past its ordered retries, so it no longer holds the rows after it.
            ("not-due", "main", "UpdateMangaCategories", into_one, 4, "retry", ORDERED_RETRY_ATTEMPTS, 9_000),
            ("also-same", "main", "UpdateMangaCategories", into_one, 5, "pending", 0, 0),
            ("into-two", "main", "UpdateMangaCategories", r#"{"mangaId":1,"addTo":[2],"removeFrom":[]}"#, 6, "pending", 0, 0),
            ("after-break", "main", "UpdateMangaCategories", into_one, 7, "pending", 0, 0),
        ] {
            sqlx::query(
                r#"
                INSERT INTO suwayomi_projection_outbox (
                  operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
                  source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
                  created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, 'comic.category_assignment', ?, ?, ?, ?, ?, NULL, 1, 1)
                "#,
            )
            .bind(id)
            .bind(profile)
            .bind(operation)
            .bind(variables)
            .bind(id)
            .bind(version)
            .bind(status)
            .bind(attempts)
            .bind(next)
            .execute(&pool)
            .await
            .unwrap();
        }
        let first = claim_next_at(&pool, 500).await.unwrap().unwrap();
        assert_eq!(first.operation_id, "first");
        let change = group_change(&first.operation_name, &serde_json::from_str(&first.variables_json).unwrap())
            .unwrap();
        let group = claim_group_at(&pool, 500, &first, &change).await.unwrap();
        assert_eq!(
            group.iter().map(|row| row.operation_id.as_str()).collect::<Vec<_>>(),
            vec!["same", "also-same"]
        );
        let states: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT operation_id, status, attempt_count FROM suwayomi_projection_outbox ORDER BY source_server_version",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            states,
            vec![
                ("first".to_string(), "in_flight".to_string(), 1),
                ("same".to_string(), "in_flight".to_string(), 1),
                ("other-profile".to_string(), "pending".to_string(), 0),
                ("not-due".to_string(), "retry".to_string(), ORDERED_RETRY_ATTEMPTS),
                ("also-same".to_string(), "in_flight".to_string(), 1),
                ("into-two".to_string(), "pending".to_string(), 0),
                ("after-break".to_string(), "pending".to_string(), 0),
            ]
        );
    }

    #[test]
    fn a_bulk_mutation_confirms_only_the_works_it_answered_for() {
        let library = json!({ "updateMangas": { "mangas": [
            { "id": 1, "inLibrary": true },
            { "id": 2, "inLibrary": false },
        ] } });
        assert_eq!(
            group_confirmed_ids(true, &json!({ "inLibrary": true }), &library),
            BTreeSet::from([1])
        );
        let categories = json!({ "updateMangasCategories": { "mangas": [{ "id": 4 }, { "id": 5 }] } });
        assert_eq!(
            group_confirmed_ids(false, &json!({ "addTo": [1], "removeFrom": [] }), &categories),
            BTreeSet::from([4, 5])
        );
        assert!(group_confirmed_ids(false, &json!({}), &json!({})).is_empty());
    }

    fn outbox_row(id: &str, operation: &str, variables: Value) -> (String, String, String, String) {
        (id.to_string(), "main".to_string(), operation.to_string(), variables.to_string())
    }

    #[test]
    fn groups_outbox_rows_by_portable_work() {
        let work = json!({ "type": "comic", "sourceId": "2499283573021220255", "mangaKey": "/manga/a" });
        let other = json!({ "type": "comic", "sourceId": "1", "mangaKey": "/manga/b" });
        let chapter = |key: &str| json!({ "type": "comic", "work": work, "chapterKey": key });
        let rows = vec![
            outbox_row("entry", "UpdateManga", json!({
                "inLibrary": true, "portableTitleHint": " A ", "portableWorkRef": work })),
            outbox_row("old", "UpdateChaptersProgress", json!({
                "isRead": false, "lastPageRead": 2, "isBookmarked": null,
                "portableWorkRef": work, "portableChapterRef": chapter("/manga/a/chapter-1") })),
            outbox_row("new", "UpdateChaptersProgress", json!({
                "isRead": true, "lastPageRead": null, "isBookmarked": null,
                "portableWorkRef": work, "portableChapterRef": chapter("/manga/a/chapter-1") })),
            outbox_row("category", "UpdateMangaCategories", json!({
                "addTo": [3], "removeFrom": [], "portableWorkRef": work })),
            outbox_row("other", "UpdateMangaCategories", json!({
                "addTo": [3], "removeFrom": [], "portableWorkRef": other })),
            outbox_row("plain", "UpdateCategory", json!({ "id": 3, "name": "X" })),
            outbox_row("broken", "UpdateManga", json!({ "portableWorkRef": { "type": "comic" } })),
        ];
        let works = collect_portable_works(&rows);
        assert_eq!(works.len(), 2);
        let first = &works[0];
        assert!(first.in_library);
        assert_eq!(first.title_hint.as_deref(), Some("A"));
        assert_eq!(first.operation_ids, ["entry", "old", "new", "category"]);
        assert_eq!(first.chapters.len(), 1);
        assert_eq!(first.chapters["/manga/a/chapter-1"]["isRead"], json!(true));
        // A work only categorised here is not in any device's library.
        assert!(!works[1].in_library);

        let import = import_work_variables(first).unwrap();
        assert_eq!(import["sourceId"], json!("2499283573021220255"));
        assert_eq!(import["url"], json!("/manga/a"));
        assert_eq!(import["title"], json!("A"));
        assert_eq!(
            import["chapters"],
            json!([{ "url": "/manga/a/chapter-1", "name": "chapter-1", "isRead": true,
                     "isBookmarked": false, "lastPageRead": 0, "chapterNumber": -1.0 }])
        );
        // Without a title hint the key stands in until the source fills the details.
        assert_eq!(import_work_variables(&works[1]).unwrap()["title"], json!("/manga/b"));
    }

    #[test]
    fn chapter_name_hint_is_the_last_key_segment() {
        assert_eq!(chapter_name_hint("/manga/a/chapter-12/"), "chapter-12");
        assert_eq!(chapter_name_hint("https://host.example/c/99"), "99");
        assert_eq!(chapter_name_hint("chapter-1"), "chapter-1");
        assert_eq!(chapter_name_hint("/"), "/");
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
