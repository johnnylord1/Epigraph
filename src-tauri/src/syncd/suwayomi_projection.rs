use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

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
use super::{db, landed_works, routes::suwayomi_catalog};

const MAX_BATCH: usize = 8;
/// How long one tick keeps draining a backlog batch after batch. The 2 s tick only paces an idle or
/// failing queue; a synced backlog would otherwise wait out a tick after every eight rows.
const DRAIN_BUDGET: Duration = Duration::from_secs(4);
/// A synced library arrives as runs of the same change (every work into the library, every work
/// of one category into it); a run is sent to Suwayomi as one bulk mutation of up to this many.
/// A device's progress arrives as runs of chapters of one work, which share one chapter lookup and
/// go out as one mutation per distinct progress state.
const MAX_GROUPED_ROWS: usize = 50;
/// Progress groups share one chapter listing of their work, the slow part of applying them, so a
/// work's whole run (a first sync sends hundreds of chapters of one work) goes in a few groups.
const MAX_GROUPED_PROGRESS_ROWS: usize = 250;
/// Works one import pass brings in with a single Suwayomi restore. Restoring is one job however
/// many works it carries, so a first sync's library arrives in a handful of restores.
const IMPORT_BATCH_WORKS: usize = 500;
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
    COMMAND_FAILED,
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
/// update. Status reports it as blocked so unfinished progress remains visible without holding
/// catalog revisions back or changing the durable retry lifecycle.
const WAITING_CHAPTER_CODE: &str = UNBOUND_WORK_CODES[1];
/// A command Suwayomi answered with a non-retryable error (for example a category id it does not
/// have). Its few remaining retries do not hold later rows: a rejection is not an outage, and each
/// rejected row used to stall every later row of the profile for its whole retry cycle.
const COMMAND_FAILED: &str = "command_failed";
/// Retry codes that never hold later rows of the profile in the ordered queue.
const NON_HOLDING_RETRY_CODES: [&str; 3] =
    [UNBOUND_WORK_CODES[0], UNBOUND_WORK_CODES[1], COMMAND_FAILED];
/// A row whose record names a category of another Core server (the desktop before a reinstall).
/// Its numeric id means nothing to this Suwayomi, so it stays blocked.
/// The earliest retry of each profile still in its first [ORDERED_RETRY_ATTEMPTS] attempts, for
/// all rows and for library rows: later rows of its kind wait behind it (see [claim_next_at]).
/// Materialized once per claim; binds the attempt limit and [NON_HOLDING_RETRY_CODES].
const CLAIM_BARRIER_CTE: &str = r#"
    WITH barrier AS MATERIALIZED (
        SELECT profile_id, MIN(source_server_version) AS version,
               MIN(CASE WHEN operation_name <> 'UpdateChaptersProgress'
                   THEN source_server_version END) AS library_version
        FROM suwayomi_projection_outbox
        WHERE status = 'retry' AND attempt_count < ?
          AND COALESCE(last_error, '') NOT IN (?, ?, ?)
        GROUP BY profile_id
    )
"#;
const CLAIM_BARRIER_CONDITION: &str = r#"
    candidate.source_server_version <= COALESCE((
        SELECT CASE WHEN candidate.operation_name = 'UpdateChaptersProgress'
            THEN barrier.version ELSE barrier.library_version END
        FROM barrier WHERE barrier.profile_id = candidate.profile_id
    ), candidate.source_server_version)
"#;
/// How many rows after a claimed one are read, per row a group can take, to find the rows that
/// join it past the rows it passes over.
const GROUP_SCAN_FACTOR: usize = 4;
const FOREIGN_SERVER_IDENTITY: &str = "foreign_server_identity";
/// How a phone names a chapter it only knows through a Core listing, in place of the source's
/// chapter key: `aethon-core://suwayomi/<server>/<profile>/chapter/<id>`.
const CORE_LISTED_CHAPTER_PREFIX: &str = "aethon-core://suwayomi/";
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

const CHAPTER_PAGE_COUNTS_QUERY: &str = r#"
  query EpigraphProjectionChapterPageCounts($ids: [Int!]!, $first: Int!) {
    chapters(filter: { id: { in: $ids } }, first: $first) {
      nodes { id pageCount }
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

/// The session Core uses to apply synced changes to Suwayomi.
pub(crate) const PROJECTION_TOKEN_ID: &str = "epigraph-core-projection";
/// Devices hear about catalog changes when the queue empties, or this often while it does not.
const MAX_CATALOG_NOTICE_WAIT: Duration = Duration::from_secs(30);

static CATALOG_WRITTEN: AtomicBool = AtomicBool::new(false);

/// A projection may have changed the catalog; it is announced as the queue allows.
pub(crate) fn note_catalog_write() {
    CATALOG_WRITTEN.store(true, Ordering::Relaxed);
}

/// When the catalog writes a queue made are announced.
#[derive(Default)]
struct CatalogNotice {
    last: Option<Instant>,
}

impl CatalogNotice {
    fn due(&mut self, drained: bool, now: Instant) -> bool {
        let waited = self
            .last
            .is_none_or(|at| now.duration_since(at) >= MAX_CATALOG_NOTICE_WAIT);
        let due = drained || waited;
        if due {
            self.last = Some(now);
        }
        due
    }

    fn announce_if_due(&mut self, drained: bool) {
        if CATALOG_WRITTEN.load(Ordering::Relaxed)
            && self.due(drained, Instant::now())
            && CATALOG_WRITTEN.swap(false, Ordering::Relaxed)
        {
            super::suwayomi_progress_mirror::request_catalog_refresh();
            super::suwayomi_progress_mirror::request_immediate_mirror(&[], &[]);
        }
    }
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
            match block_foreign_server_projections(&state.pool, super::db::now_ms()).await {
                Ok(0) => {}
                Ok(count) => {
                    tracing::info!(count, "blocked Suwayomi projections of another Core server")
                }
                Err(error) => {
                    tracing::warn!(error = %error, "failed to block foreign Suwayomi projections")
                }
            }
            match rearm_runtime_retries(&state.pool, super::db::now_ms(), None).await {
                Ok(0) => {}
                Ok(count) => tracing::info!(count, "rearmed Suwayomi projections waiting on the runtime"),
                Err(error) => {
                    tracing::warn!(error = %error, "failed to rearm Suwayomi projections")
                }
            }
            match rearm_missing_chapter_retries(&state.pool, super::db::now_ms()).await {
                Ok(0) => {}
                Ok(count) => tracing::info!(count, "rearmed Suwayomi progress waiting on missing chapters"),
                Err(error) => {
                    tracing::warn!(error = %error, "failed to rearm Suwayomi progress")
                }
            }
        }
        let mut ticker = tokio::time::interval(Duration::from_secs(2));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let runtime_root = crate::suwayomi_maintenance::default_runtime_root();
        let mut maintenance = MaintenanceWatch::default();
        let mut runtime_return = RuntimeReturnWatch::default();
        let mut import = ImportWatch::default();
        let mut bulk_progress = BulkProgressWatch::default();
        let mut catalog_notice = CatalogNotice::default();
        let mut ingest_yield = IngestYield::default();
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    // The next tick, 2 s away, checks again; the ingest's own wakes end sooner.
                    if ingest_yield.holds_now() {
                        continue;
                    }
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
                            Ok(ImportPass::Busy) => {
                                // The next batch goes right away: a first sync brings in
                                // hundreds of works before their rows can drain.
                                catalog_notice.announce_if_due(false);
                                ticker.reset_immediately();
                                continue;
                            }
                            Ok(ImportPass::Retrying) => {
                                catalog_notice.announce_if_due(false);
                                continue;
                            }
                            Err(error) => {
                                tracing::warn!(error = %error, "failed to import synced works into Suwayomi")
                            }
                        }
                    }
                    // Progress of works already here settles in bulk; while it does, the queue
                    // drains only library changes, which the per-row path handles quickly.
                    let mut library_only = false;
                    if !held {
                        match settle_progress_in_bulk(&state, &mut bulk_progress).await {
                            Ok(0) => {}
                            Ok(_) => library_only = true,
                            Err(error) => {
                                tracing::warn!(error = %error, "failed to settle synced progress in bulk")
                            }
                        }
                    }
                    let started = Instant::now();
                    let drained = loop {
                        match drain_ready(&state, library_only).await {
                            Ok(claimed) if claimed == MAX_BATCH && started.elapsed() < DRAIN_BUDGET => {}
                            Ok(claimed) => break claimed < MAX_BATCH,
                            Err(error) => {
                                tracing::warn!(error = %error, "failed to drain canonical Suwayomi projections");
                                break true;
                            }
                        }
                    };
                    if library_only {
                        catalog_notice.announce_if_due(false);
                        ticker.reset_immediately();
                        continue;
                    }
                    catalog_notice.announce_if_due(drained);
                }
                _ = PROJECTION_WAKE.notified() => ticker.reset_immediately(),
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, FromRow)]
pub struct PendingProjectionCounts {
    pub total: i64,
    /// Rows other than chapter progress: the library, its categories and assignments. Chapter
    /// progress can number in the tens of thousands after a first sync and lands afterwards.
    pub catalog: i64,
}

pub async fn pending_projection_counts(
    state: &SharedAppState,
) -> anyhow::Result<PendingProjectionCounts> {
    pending_projection_counts_in(&state.pool).await
}

async fn pending_projection_counts_in(
    pool: &sqlx::SqlitePool,
) -> anyhow::Result<PendingProjectionCounts> {
    sqlx::query_as(
        r#"
        SELECT COUNT(*) AS total,
               COALESCE(SUM(operation_name <> 'UpdateChaptersProgress'), 0) AS catalog
        FROM suwayomi_projection_outbox
        WHERE status IN ('pending', 'in_flight', 'retry')
        "#,
    )
    .fetch_one(pool)
    .await
    .context("failed to count pending Suwayomi projections")
}

/// A profile's projection counts for `/v1/sync/status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, FromRow)]
pub struct ProjectionStatusCounts {
    pub pending: i64,
    /// Persisted blocked rows and chapter retries waiting for a missing chapter after the
    /// confirmation budget. The latter keep their durable retry state and slow backoff.
    pub blocked: i64,
    pub in_flight: i64,
    /// Rows other than chapter progress still to project, which hold the catalog revisions back.
    pub catalog_pending: i64,
    /// Blocked rows that hold the catalog revisions back. A work this desktop could not find is
    /// not part of its library, so the revisions describe that library correctly without it.
    pub catalog_blocked: i64,
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
            COALESCE(SUM(CASE WHEN status = 'blocked' OR waiting THEN 1 ELSE 0 END), 0) AS blocked,
            COALESCE(SUM(CASE WHEN status = 'in_flight' THEN 1 ELSE 0 END), 0) AS in_flight,
            COALESCE(SUM(CASE WHEN status IN ('pending', 'retry', 'in_flight') AND NOT waiting
                AND operation_name <> 'UpdateChaptersProgress' THEN 1 ELSE 0 END), 0) AS catalog_pending,
            COALESCE(SUM(CASE WHEN status = 'blocked' AND last_error IS NOT ? THEN 1 ELSE 0 END), 0)
                AS catalog_blocked
        FROM (
            SELECT status, operation_name, last_error,
                (status = 'retry' AND operation_name = 'UpdateChaptersProgress'
                    AND last_error IS ? AND attempt_count >= ?) AS waiting
            FROM suwayomi_projection_outbox
            WHERE profile_id = ?
        )
        "#,
    )
    .bind(PORTABLE_WORK_NOT_FOUND)
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

/// Committed mutations wake the projection loop, so a device's changes reach Suwayomi without
/// waiting out the 2 s tick. Wakes that arrive while a pass runs collapse into one more pass.
static PROJECTION_WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

pub fn wake_projection() {
    PROJECTION_WAKE.notify_one();
}

/// A device sending its backlog (a first sync carries thousands of mutations) and the projection
/// both write the same database, and passes that start between its batches made each batch wait
/// seconds for the writer. While such a backlog arrives the projection holds its passes, so the
/// device finishes in a few round trips and the projection catches up right after.
const BULK_INGEST_MIN_MUTATIONS: usize = 100;
/// Ingest counts as ongoing until this long after the last bulk batch arrived or committed.
const INGEST_QUIET_MS: i64 = 2_000;
/// The longest the projection holds its passes for an ingest that never pauses.
const MAX_INGEST_DEFERRAL: Duration = Duration::from_secs(10);

static LAST_BULK_INGEST_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// Records a batch of `mutations` arriving or committing; only a bulk batch holds the projection,
/// so a device's single changes still reach Suwayomi at once.
pub fn note_ingest(mutations: usize) {
    if mutations >= BULK_INGEST_MIN_MUTATIONS {
        LAST_BULK_INGEST_MS.store(super::db::now_ms(), Ordering::Relaxed);
    }
}

/// Whether a bulk batch arrived or committed within the last [`INGEST_QUIET_MS`].
pub fn bulk_ingest_ongoing() -> bool {
    let last_ingest_ms = LAST_BULK_INGEST_MS.load(Ordering::Relaxed);
    last_ingest_ms > 0 && super::db::now_ms().saturating_sub(last_ingest_ms) < INGEST_QUIET_MS
}

/// Whether the projection holds its pass for an ongoing bulk ingest.
#[derive(Default)]
struct IngestYield {
    since: Option<Instant>,
}

impl IngestYield {
    fn holds(&mut self, last_ingest_ms: i64, now_ms: i64, now: Instant) -> bool {
        let ongoing = last_ingest_ms > 0 && now_ms.saturating_sub(last_ingest_ms) < INGEST_QUIET_MS;
        if !ongoing {
            self.since = None;
            return false;
        }
        let since = *self.since.get_or_insert(now);
        if now.duration_since(since) >= MAX_INGEST_DEFERRAL {
            // One pass goes through, then the projection holds again.
            self.since = None;
            return false;
        }
        true
    }

    fn holds_now(&mut self) -> bool {
        self.holds(
            LAST_BULK_INGEST_MS.load(Ordering::Relaxed),
            super::db::now_ms(),
            Instant::now(),
        )
    }
}

/// Applies up to `MAX_BATCH` ready projections (each with the rows grouped behind it) and returns
/// how many it claimed, so a full batch tells the caller more are waiting.
async fn drain_ready(state: &SharedAppState, library_only: bool) -> anyhow::Result<usize> {
    let mut claimed = 0;
    for _ in 0..MAX_BATCH {
        let Some(row) = claim_next(state, library_only).await? else {
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
        let outcomes = match change {
            Some(change) if !companions.is_empty() => {
                let mut rows = Vec::with_capacity(companions.len() + 1);
                rows.push(row);
                rows.extend(companions);
                apply_group(state, rows, &change).await
            }
            _ => {
                let outcome = apply_projection(state, &row).await;
                vec![(row, outcome)]
            }
        };
        settle(state, &outcomes).await?;
    }
    Ok(claimed)
}

/// Stores the outcomes of one group in one write: applied rows leave the outbox, the rest are
/// rescheduled or blocked.
async fn settle(
    state: &SharedAppState,
    outcomes: &[(ProjectionRow, ProjectionOutcome)],
) -> anyhow::Result<()> {
    let now = super::db::now_ms();
    let _writer_guard = state.mutation_gate.lock().await;
    let mut tx = super::db::begin_write(&state.pool).await?;
    let mut applied = 0;
    for (row, outcome) in outcomes {
        match outcome {
            ProjectionOutcome::Applied => {
                sqlx::query("DELETE FROM suwayomi_projection_outbox WHERE operation_id = ?")
                    .bind(&row.operation_id)
                    .execute(&mut *tx)
                    .await?;
                applied += 1;
            }
            ProjectionOutcome::Retry(code) => {
                let delay = retry_delay_ms(code, row.attempt_count);
                sqlx::query(
                    r#"
                    UPDATE suwayomi_projection_outbox
                    SET status = 'retry', next_attempt_at_ms = ?, lease_until_ms = NULL,
                        last_error = ?, updated_at_ms = ?
                    WHERE operation_id = ?
                    "#,
                )
                .bind(now.saturating_add(delay))
                .bind(*code)
                .bind(now)
                .bind(&row.operation_id)
                .execute(&mut *tx)
                .await?;
            }
            ProjectionOutcome::Blocked(code) => {
                sqlx::query(
                    r#"
                    UPDATE suwayomi_projection_outbox
                    SET status = 'blocked', lease_until_ms = NULL, last_error = ?, updated_at_ms = ?
                    WHERE operation_id = ?
                    "#,
                )
                .bind(*code)
                .bind(now)
                .bind(&row.operation_id)
                .execute(&mut *tx)
                .await?;
            }
        }
    }
    tx.commit().await?;
    APPLIED_PROJECTIONS.fetch_add(applied, Ordering::Relaxed);
    Ok(())
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

async fn claim_next(
    state: &SharedAppState,
    library_only: bool,
) -> anyhow::Result<Option<ProjectionRow>> {
    let _writer_guard = state.mutation_gate.lock().await;
    let kinds: &[bool] = if library_only { &[false] } else { &[false, true] };
    claim_next_of(&state.pool, super::db::now_ms(), kinds).await
}

/// Claims the earliest ready row, library and category changes first. Chapter progress only needs
/// its work to exist and nothing waits on it, so a first sync's thousands of progress rows no
/// longer keep the library and its folders waiting behind them (the desktop first run waits for
/// those). Each kind keeps commit order: a progress retry holds later progress only, while a
/// library retry still holds everything after it.
#[cfg(test)]
async fn claim_next_at(pool: &sqlx::SqlitePool, now: i64) -> anyhow::Result<Option<ProjectionRow>> {
    claim_next_of(pool, now, &[false, true]).await
}

/// [claim_next_at] for the given kinds only (`true` is chapter progress).
async fn claim_next_of(
    pool: &sqlx::SqlitePool,
    now: i64,
    kinds: &[bool],
) -> anyhow::Result<Option<ProjectionRow>> {
    let mut tx = super::db::begin_write(pool).await?;
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
    // One kind at a time, so the claim walks idx_suwayomi_projection_claim in commit order and
    // stops at the first due row instead of sorting the whole queue.
    let mut row = None;
    for &progress in kinds {
        row = sqlx::query_as::<_, ProjectionRow>(&format!(
            r#"
            {CLAIM_BARRIER_CTE}
            SELECT candidate.operation_id, candidate.profile_id, candidate.operation_name,
                   candidate.variables_json, candidate.attempt_count
            FROM suwayomi_projection_outbox AS candidate
            WHERE candidate.status IN ('pending', 'retry')
              AND (candidate.operation_name = 'UpdateChaptersProgress') = ?
              AND +candidate.next_attempt_at_ms <= ?
              AND {CLAIM_BARRIER_CONDITION}
            ORDER BY candidate.source_server_version ASC
            LIMIT 1
            "#
        ))
        .bind(ORDERED_RETRY_ATTEMPTS)
        .bind(NON_HOLDING_RETRY_CODES[0])
        .bind(NON_HOLDING_RETRY_CODES[1])
        .bind(NON_HOLDING_RETRY_CODES[2])
        .bind(progress)
        .bind(now)
        .fetch_optional(&mut *tx)
        .await?;
        if row.is_some() {
            break;
        }
    }
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

/// The work a row changes, when its variables name one portably. Rows of different works can be
/// applied in either order; rows that name no work (category edits, old clients) order everything.
fn row_work(row: &ProjectionRow) -> Option<String> {
    let variables = serde_json::from_str::<Value>(&row.variables_json).ok()?;
    let reference = variables.get("portableWorkRef")?.clone();
    let reference = serde_json::from_value::<PortableWorkRefV3>(reference).ok()?;
    Some(canonical_portable_work_id(&reference))
}

/// Claims ready rows after `first` (already claimed) that make the same change, so they can go to
/// Suwayomi together. Only rows of its kind (chapter progress, or everything else; see
/// [claim_next_at]) are read. A row that does something else is passed over, and so is every later
/// row of its work, so each work still sees its changes in commit order: a synced library's
/// alternating "into the library" and "into these categories" rows become two bulk mutations
/// instead of one per row. A row that names no work joins only while nothing was passed over,
/// and otherwise ends the group.
async fn claim_group_at(
    pool: &sqlx::SqlitePool,
    now: i64,
    first: &ProjectionRow,
    change: &Value,
) -> anyhow::Result<Vec<ProjectionRow>> {
    let progress = first.operation_name == "UpdateChaptersProgress";
    let limit = if progress {
        MAX_GROUPED_PROGRESS_ROWS
    } else {
        MAX_GROUPED_ROWS
    };
    let mut tx = super::db::begin_write(pool).await?;
    let candidates = sqlx::query_as::<_, ProjectionRow>(&format!(
        r#"
        {CLAIM_BARRIER_CTE}
        SELECT candidate.operation_id, candidate.profile_id, candidate.operation_name,
               candidate.variables_json, candidate.attempt_count
        FROM suwayomi_projection_outbox AS candidate
        WHERE candidate.status IN ('pending', 'retry')
          AND (candidate.operation_name = 'UpdateChaptersProgress') = ?
          AND candidate.source_server_version > (
            SELECT source_server_version FROM suwayomi_projection_outbox WHERE operation_id = ?
          )
          AND candidate.profile_id = ? AND candidate.operation_id != ?
          AND +candidate.next_attempt_at_ms <= ?
          AND {CLAIM_BARRIER_CONDITION}
        ORDER BY candidate.source_server_version ASC
        LIMIT ?
        "#
    ))
    .bind(ORDERED_RETRY_ATTEMPTS)
    .bind(NON_HOLDING_RETRY_CODES[0])
    .bind(NON_HOLDING_RETRY_CODES[1])
    .bind(NON_HOLDING_RETRY_CODES[2])
    .bind(progress)
    .bind(&first.operation_id)
    .bind(&first.profile_id)
    .bind(&first.operation_id)
    .bind(now)
    .bind((GROUP_SCAN_FACTOR * limit) as i64)
    .fetch_all(&mut *tx)
    .await?;
    let mut passed_over = std::collections::HashSet::new();
    let mut group = Vec::new();
    for row in candidates {
        if group.len() + 1 >= limit {
            break;
        }
        let same = row.operation_name == first.operation_name
            && serde_json::from_str::<Value>(&row.variables_json)
                .ok()
                .and_then(|variables| group_change(&row.operation_name, &variables))
                .as_ref()
                == Some(change);
        match row_work(&row) {
            Some(work) if same && !passed_over.contains(&work) => group.push(row),
            Some(work) => {
                passed_over.insert(work);
            }
            // A row that names no work may change any of them: it joins only an unbroken run.
            None if same && passed_over.is_empty() => group.push(row),
            None => break,
        }
    }
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
                for (row, manga_id, variables) in members {
                    let outcome =
                        confirmation_outcome(confirmed.contains(&manga_id), row.attempt_count);
                    note_landed(&row, &row.operation_name, &variables, &outcome);
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
    let paged: Vec<i64> = members
        .iter()
        .filter(|(_, _, variables)| sets_page(variables))
        .map(|(_, chapter_id, _)| *chapter_id)
        .collect();
    let unknown = chapters_without_page_count(state, &members[0].0.profile_id, &paged).await;
    let mut by_patch: Vec<(Value, Vec<(ProjectionRow, i64, Value)>)> = Vec::new();
    for mut member in members {
        leave_out_unknown_page(&mut member.2, &unknown);
        let patch = chapter_progress_patch(&member.2);
        match by_patch.iter_mut().find(|(existing, _)| *existing == patch) {
            Some((_, rows)) => rows.push(member),
            None => by_patch.push((patch, vec![member])),
        }
    }
    for (mut variables, members) in by_patch {
        if !writes_progress(&variables) {
            outcomes.extend(members.into_iter().map(|(row, ..)| (row, ProjectionOutcome::Applied)));
            continue;
        }
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
                    note_landed(&row, &row.operation_name, &variables, &outcome);
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

fn sets_page(variables: &Value) -> bool {
    variables.get("lastPageRead").is_some_and(|page| !page.is_null())
}

/// Whether a progress patch still changes anything once its unknown page is left out.
fn writes_progress(patch: &Value) -> bool {
    ["isRead", "isBookmarked", "lastPageRead"]
        .iter()
        .any(|field| patch.get(*field).is_some_and(|value| !value.is_null()))
}

/// Chapters among `ids` whose page count Suwayomi does not know yet: one never opened here, or one
/// a restore recreated. `updateChapters` clamps `lastPageRead` below that count, so a page written
/// to one of them is stored as page 0 over the page it had. A failed lookup reports none; the
/// command that follows meets the same failure and retries.
async fn chapters_without_page_count(
    state: &SharedAppState,
    profile_id: &str,
    ids: &[i64],
) -> BTreeSet<i64> {
    if ids.is_empty() {
        return BTreeSet::new();
    }
    suwayomi_catalog::execute_graphql_document(
        state,
        &projection_session(profile_id),
        CHAPTER_PAGE_COUNTS_QUERY,
        json!({ "ids": ids, "first": ids.len() }),
        false,
    )
    .await
    .map(|data| unknown_page_counts(&data))
    .unwrap_or_default()
}

fn unknown_page_counts(data: &Value) -> BTreeSet<i64> {
    data.pointer("/chapters/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|chapter| {
            chapter
                .get("pageCount")
                .and_then(Value::as_i64)
                .map_or(true, |count| count <= 0)
        })
        .filter_map(|chapter| chapter.get("id").and_then(Value::as_i64))
        .collect()
}

/// Leaves the page out of a resolved progress row whose chapter has no page count here, so the
/// chapter keeps the page it has; read and bookmark state still apply.
fn leave_out_unknown_page(variables: &mut Value, unknown: &BTreeSet<i64>) {
    let names_unknown = variables
        .get("ids")
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().filter_map(Value::as_i64).any(|id| unknown.contains(&id)));
    if names_unknown {
        if let Some(object) = variables.as_object_mut() {
            object.remove("lastPageRead");
        }
    }
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
        let mut command_variables = Value::Object(object);
        if sets_page(&command_variables) {
            let ids: Vec<i64> = command_variables
                .get("ids")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_i64).collect())
                .unwrap_or_default();
            let unknown = chapters_without_page_count(state, &row.profile_id, &ids).await;
            leave_out_unknown_page(&mut command_variables, &unknown);
            if !writes_progress(&command_variables) {
                return ProjectionOutcome::Applied;
            }
        }
        command_variables
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
            return ProjectionOutcome::Blocked("command_rejected");
        }
        Err(error) => return failed_command_outcome(&error, row.attempt_count),
    };
    let outcome = confirmation_outcome(
        projection_confirmed(operation, &variables, &data),
        row.attempt_count,
    );
    note_landed(row, operation_name, &variables, &outcome);
    outcome
}

/// Tells the window which work a confirmed projection changed, so it reads only that one.
fn note_landed(row: &ProjectionRow, operation: &str, variables: &Value, outcome: &ProjectionOutcome) {
    if matches!(outcome, ProjectionOutcome::Applied) {
        landed_works::record_projection(&row.profile_id, operation, variables);
    }
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

/// Blocks unapplied category rows whose record names a category of another Core server. Older
/// daemons mapped such ids onto this Suwayomi's numeric ids; once this Suwayomi creates categories
/// with those numbers, re-sending the rows would file works under the wrong category. Runs at
/// daemon start after [requeue_recoverable_blocked], so those rows are not re-armed; idempotent.
async fn block_foreign_server_projections(
    pool: &sqlx::SqlitePool,
    now: i64,
) -> anyhow::Result<u64> {
    let server_id = super::db::load_server_identity(pool).await?.server_id;
    if server_id.is_empty() || server_id == "pending-server-id" {
        return Ok(0);
    }
    let local_prefix = format!("suwayomi:server:{server_id}:");
    let result = sqlx::query(
        r#"
        UPDATE suwayomi_projection_outbox
        SET status = 'blocked', lease_until_ms = NULL, last_error = ?, updated_at_ms = ?
        WHERE COALESCE(last_error, '') != ?
          AND entity_type IN ('comic.category', 'comic.category_assignment')
          AND EXISTS (
            SELECT 1 FROM comic_sync_state AS state
            WHERE state.scope_id = 'comics:profile:' || suwayomi_projection_outbox.profile_id
              AND state.entity_type = suwayomi_projection_outbox.entity_type
              AND state.entity_id = suwayomi_projection_outbox.entity_id
              AND json_valid(state.record_json)
              AND substr(json_extract(state.record_json, '$.categoryId'), 1, 16) = 'suwayomi:server:'
              AND substr(json_extract(state.record_json, '$.categoryId'), 1, ?) != ?
          )
        "#,
    )
    .bind(FOREIGN_SERVER_IDENTITY)
    .bind(now)
    .bind(FOREIGN_SERVER_IDENTITY)
    .bind(local_prefix.len() as i64)
    .bind(&local_prefix)
    .execute(pool)
    .await
    .context("failed to block Suwayomi projections of another Core server")?;
    Ok(result.rows_affected())
}

/// Makes rows that were waiting on an unreachable runtime due now, for one profile or all. Runs at
/// daemon start, when maintenance ends and when a runtime seen down answers again, so a backoff
/// earned during an outage does not keep the queue pending. Attempt counts are kept, so ordering
/// and bounded-attempt rules hold.
/// Progress waiting on a chapter Suwayomi does not list gets one bulk pass when the daemon starts,
/// which adds the chapter. Its attempts are kept.
async fn rearm_missing_chapter_retries(pool: &sqlx::SqlitePool, now: i64) -> anyhow::Result<u64> {
    let result = sqlx::query(
        r#"
        UPDATE suwayomi_projection_outbox
        SET next_attempt_at_ms = ?, updated_at_ms = ?
        WHERE status = 'retry' AND operation_name = 'UpdateChaptersProgress'
          AND last_error = ? AND next_attempt_at_ms > ?
        "#,
    )
    .bind(now)
    .bind(now)
    .bind(WAITING_CHAPTER_CODE)
    .bind(now)
    .execute(pool)
    .await
    .context("failed to rearm Suwayomi progress waiting on missing chapters")?;
    Ok(result.rows_affected())
}

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

    // A Core-listed address binds nothing: the chapter already has its source key binding, and a
    // chapter with two bindings has none for the progress mirror.
    if chapter_key.starts_with(CORE_LISTED_CHAPTER_PREFIX) {
        let chapter_id =
            resolve_core_listed_chapter(state, &row.profile_id, manga_id, chapter_key, lookup)
                .await?;
        target_chapter(object, manga_id, chapter_id);
        return Ok(variables);
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

    target_chapter(object, manga_id, chapter_id);
    Ok(variables)
}

/// Replaces a row's portable references with the Suwayomi ids they resolved to.
fn target_chapter(object: &mut serde_json::Map<String, Value>, manga_id: i64, chapter_id: i64) {
    object.remove("portableWorkRef");
    object.remove("portableChapterRef");
    object.insert("mangaId".to_string(), Value::from(manga_id));
    object.insert(
        "ids".to_string(),
        Value::Array(vec![Value::from(chapter_id)]),
    );
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
    /// A batch was handled; the next pass looks for more right away, before draining.
    Busy,
    /// The runtime asked to retry the batch; the next tick tries again before draining.
    Retrying,
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
                // A Core-listed address is no source key, so it must not become a stand-in chapter.
                if let Some(key) = variables
                    .pointer("/portableChapterRef/chapterKey")
                    .and_then(Value::as_str)
                    .filter(|key| !key.starts_with(CORE_LISTED_CHAPTER_PREFIX))
                {
                    // Rows come oldest first and each carries only what changed, so a later
                    // row's fields override and the ones it leaves out keep the earlier value.
                    let merged = entry.chapters.entry(key.to_string()).or_insert_with(|| json!({}));
                    merge_progress_fields(merged, &variables);
                }
            }
            _ => {}
        }
    }
    works
}

/// Lays the fields `newer` sets over `merged`; a field `newer` leaves out or nulls keeps its
/// earlier value.
fn merge_progress_fields(merged: &mut Value, newer: &Value) {
    let (Some(merged), Some(newer)) = (merged.as_object_mut(), newer.as_object()) else {
        return;
    };
    for (field, value) in newer {
        if !value.is_null() {
            merged.insert(field.clone(), value.clone());
        }
    }
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
///
/// Every step of a pass works on the whole batch at once: one lookup of the works Suwayomi lists,
/// one restore of the rest, one transaction binding them all. A lookup and a transaction per work
/// made a first sync of a few thousand works take minutes.
async fn import_unseen_comics(
    state: &SharedAppState,
    watch: &mut ImportWatch,
) -> anyhow::Result<ImportPass> {
    // Only library entries decide what to import; a work's progress and categories are read
    // below for the works of this batch. Reading and parsing every queued row instead cost about
    // half a second a tick with a first sync's 25,000 progress rows.
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        r#"
        SELECT operation_id, profile_id, operation_name, variables_json
        FROM suwayomi_projection_outbox
        WHERE operation_name = 'UpdateManga' AND status IN ('pending', 'retry', 'blocked')
          AND variables_json LIKE '%"portableWorkRef"%'
        ORDER BY profile_id, source_server_version
        "#,
    )
    .fetch_all(&state.pool)
    .await
    .context("failed to list Suwayomi projections of portable works")?;
    let mut bound_by_profile: HashMap<String, HashMap<String, String>> = HashMap::new();
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
        if !bound_by_profile.contains_key(&work.profile_id) {
            let bound = db::load_bound_comic_references(&state.pool, &work.profile_id).await?;
            bound_by_profile.insert(work.profile_id.clone(), bound);
        }
        if bound_by_profile[&work.profile_id].contains_key(&work.portable_work_id) {
            watch
                .attempted
                .insert(ImportWatch::key(&work.profile_id, &work.portable_work_id));
            continue;
        }
        batch.push(work);
        if batch.len() == IMPORT_BATCH_WORKS {
            break;
        }
    }
    let Some(profile_id) = batch.first().map(|work| work.profile_id.clone()) else {
        return Ok(ImportPass::Idle);
    };
    let batch = with_work_rows(&state.pool, &profile_id, &rows, batch).await?;
    let session = projection_session(&profile_id);

    // Works Suwayomi already lists are only bound.
    let Ok(listed) = lookup_local_comics(state, &session, batch.iter().map(|work| &work.work)).await
    else {
        // The runtime is not answering; its rows back off and are rearmed when it returns.
        return Ok(ImportPass::Idle);
    };
    let (found, missing): (Vec<UnseenWork>, Vec<UnseenWork>) = batch
        .into_iter()
        .partition(|work| comic_key(&work.work).is_some_and(|key| listed.contains_key(&key)));
    bind_imported_comics(state, &profile_id, &found, &listed).await?;
    for work in &found {
        watch
            .attempted
            .insert(ImportWatch::key(&work.profile_id, &work.portable_work_id));
    }

    let works: Vec<Value> = missing.iter().filter_map(import_work_variables).collect();
    if !works.is_empty() {
        let started = Instant::now();
        match suwayomi_import::import_works_confirmed(state, &session, json!({ "works": works })).await
        {
            Ok(_) => watch.failures = 0,
            // A restore that failed or timed out is tried again, the whole batch: Suwayomi
            // restores nothing of a failed backup, and its upload can race the temporary file.
            Err(error) if watch.failures + 1 < MAX_IMPORT_ATTEMPTS => {
                watch.failures += 1;
                tracing::warn!(profile = %profile_id, error = ?error, failures = watch.failures, "Suwayomi import of synced works will retry");
                return Ok(ImportPass::Retrying);
            }
            Err(error) => {
                watch.failures = 0;
                tracing::warn!(profile = %profile_id, error = ?error, "Suwayomi import of synced works failed; its works resolve one by one");
            }
        }
        tracing::info!(profile = %profile_id, works = works.len(), elapsed_ms = started.elapsed().as_millis() as u64, "Suwayomi restore of synced works finished");
    }
    for work in &missing {
        watch
            .attempted
            .insert(ImportWatch::key(&work.profile_id, &work.portable_work_id));
    }
    if !missing.is_empty() {
        let listed = lookup_local_comics(state, &session, missing.iter().map(|work| &work.work))
            .await
            .unwrap_or_default();
        let imported: Vec<UnseenWork> = missing
            .into_iter()
            .filter(|work| comic_key(&work.work).is_some_and(|key| listed.contains_key(&key)))
            .collect();
        bind_imported_comics(state, &profile_id, &imported, &listed).await?;
        tracing::info!(profile = profile_id, imported = imported.len(), tried = works.len(), "imported synced works into Suwayomi");
    }
    Ok(ImportPass::Busy)
}

/// Restores of one batch before its works are given up on and resolve one by one.
const MAX_IMPORT_ATTEMPTS: u32 = 3;

/// Works one listing query asks Suwayomi about; their keys go in the query's filter.
const COMIC_LOOKUP_CHUNK: usize = 100;
const COMIC_LOOKUP_PAGE: usize = 500;
const PORTABLE_COMICS_LOOKUP_QUERY: &str = r#"
  query EpigraphResolvePortableComics($sourceIds: [LongString!]!, $urls: [String!]!, $first: Int!, $offset: Int!) {
    mangas(filter: { sourceId: { in: $sourceIds }, url: { in: $urls } }, orderBy: ID, orderByType: ASC, first: $first, offset: $offset) {
      pageInfo { hasNextPage }
      nodes { id sourceId url }
    }
  }
"#;

/// A comic's source and exact key, as Suwayomi lists them.
fn comic_key(work: &PortableWorkRefV3) -> Option<(String, String)> {
    match work {
        PortableWorkRefV3::Comic { source_id, manga_key } => {
            Some((source_id.clone(), manga_key.clone()))
        }
        PortableWorkRefV3::Novel { .. } => None,
    }
}

/// The ids Suwayomi has for the works' exact source and key, for those it lists. `Err` means the
/// runtime did not answer.
async fn lookup_local_comics<'a>(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    works: impl Iterator<Item = &'a PortableWorkRefV3>,
) -> Result<HashMap<(String, String), i64>, ()> {
    let keys: Vec<(String, String)> = works
        .filter_map(comic_key)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut found = HashMap::new();
    for chunk in keys.chunks(COMIC_LOOKUP_CHUNK) {
        let source_ids: Vec<&str> = chunk
            .iter()
            .map(|(source, _)| source.as_str())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let urls: Vec<&str> = chunk.iter().map(|(_, url)| url.as_str()).collect();
        let mut offset = 0;
        loop {
            let data = suwayomi_catalog::execute_graphql_document(
                state,
                session,
                PORTABLE_COMICS_LOOKUP_QUERY,
                json!({ "sourceIds": source_ids, "urls": urls, "first": COMIC_LOOKUP_PAGE, "offset": offset }),
                false,
            )
            .await
            .map_err(|_| ())?;
            let nodes = data
                .pointer("/mangas/nodes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            collect_listed_comics(&nodes, chunk, &mut found);
            let more = data
                .pointer("/mangas/pageInfo/hasNextPage")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !more || nodes.is_empty() {
                break;
            }
            offset += nodes.len();
        }
    }
    Ok(found)
}

/// Keeps the listed comics whose source and key are exactly one of `wanted`. The filter narrows by
/// source and by key separately, so a key of one source can come back for another; the first id
/// (the oldest entry) wins when Suwayomi lists the same work twice.
fn collect_listed_comics(
    nodes: &[Value],
    wanted: &[(String, String)],
    found: &mut HashMap<(String, String), i64>,
) {
    let wanted: std::collections::HashSet<&(String, String)> = wanted.iter().collect();
    for node in nodes {
        let Some(id) = node
            .get("id")
            .and_then(Value::as_i64)
            .filter(|id| *id > 0 && *id <= i32::MAX as i64)
        else {
            continue;
        };
        let source = match node.get("sourceId") {
            Some(Value::String(source)) => source.clone(),
            Some(Value::Number(source)) => source.to_string(),
            _ => continue,
        };
        let Some(url) = node.get("url").and_then(Value::as_str) else {
            continue;
        };
        let key = (source, url.to_string());
        if wanted.contains(&key) {
            found.entry(key).or_insert(id);
        }
    }
}

/// Progress rows one bulk pass settles at most.
const BULK_PROGRESS_ROWS: usize = 5_000;
/// Works whose chapters one listing query reads.
const BULK_CHAPTER_WORKS: usize = 100;
const BULK_CHAPTER_PAGE: usize = 2_000;
/// Chapters one bulk `updateChapters` names: as many as the command takes, which refuses a
/// longer list outright.
const BULK_UPDATE_CHAPTERS: usize = suwayomi_commands::MAX_CHAPTER_IDS;
/// Rows a bulk pass could not settle are left to the per-row path; past this many remembered
/// rows the memory is dropped and they get one more bulk try.
const BULK_PROGRESS_MAX_TRIED: usize = 200_000;
const BULK_CHAPTERS_QUERY: &str = r#"
  query EpigraphBulkProgressChapters($mangaIds: [Int!]!, $first: Int!, $offset: Int!) {
    chapters(filter: { mangaId: { in: $mangaIds } }, orderBy: ID, orderByType: ASC, first: $first, offset: $offset) {
      pageInfo { hasNextPage }
      nodes { id mangaId url isRead isBookmarked lastPageRead pageCount }
    }
  }
"#;

/// Remembers the progress rows a bulk pass claimed but could not settle, so the next pass leaves
/// them to the per-row path instead of claiming them again.
#[derive(Default)]
struct BulkProgressWatch {
    tried: std::collections::HashSet<String>,
    /// Rows whose missing chapter a restore already added: if the chapter still does not show up,
    /// they go to the per-row path instead of being restored again every pass.
    topped_up: std::collections::HashSet<String>,
}

/// A progress row the bulk pass claimed, with where it goes.
struct BulkProgressRow {
    operation_id: String,
    status: String,
    manga_id: i64,
    portable_work_id: String,
    chapter: PortableChapterRefV3,
    chapter_key: String,
    variables: Value,
}

/// Settles in a few queries the chapter progress of works already in Suwayomi. A first sync's
/// tens of thousands of progress rows otherwise go one work at a time, each with its own chapter
/// listing, mutations and transactions: about a quarter of a second a work.
///
/// The import restore carries most of that progress already, so most rows only need to be seen
/// to match. Rows whose chapter matches are applied; the others get one `updateChapters` per
/// distinct state. Rows it cannot settle (a chapter Suwayomi does not list, a rejected command)
/// are handed back untouched to the per-row path, which knows how to retry or block them.
/// Returns how many rows it settled.
async fn settle_progress_in_bulk(
    state: &SharedAppState,
    watch: &mut BulkProgressWatch,
) -> anyhow::Result<usize> {
    if watch.tried.len() + watch.topped_up.len() > BULK_PROGRESS_MAX_TRIED {
        watch.tried.clear();
        watch.topped_up.clear();
    }
    let Some((profile_id, rows)) = claim_bulk_progress(state, watch).await? else {
        return Ok(0);
    };
    let manga_ids: Vec<i64> = rows
        .iter()
        .map(|row| row.manga_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let session = projection_session(&profile_id);
    let chapters = match list_chapters_of(state, &session, &manga_ids).await {
        Ok(chapters) => chapters,
        Err(()) => {
            // The runtime is not answering; the per-row path backs these rows off.
            release_bulk_progress(state, &rows, &[]).await?;
            return Ok(0);
        }
    };

    // Each chapter's rows, oldest first, folded into the state they leave it in.
    let mut by_chapter: Vec<(i64, Vec<&BulkProgressRow>)> = Vec::new();
    let mut chapter_index: HashMap<i64, usize> = HashMap::new();
    let mut unresolved: Vec<&BulkProgressRow> = Vec::new();
    // Rows whose chapter Suwayomi lists under no key like theirs, not merely ambiguously.
    let mut missing: Vec<&BulkProgressRow> = Vec::new();
    for row in &rows {
        let nodes = chapters.get(&row.manga_id);
        let (exact, same_path) = chapter_key_matches(nodes, row.manga_id, &row.chapter_key);
        if exact.is_none() && same_path.is_empty() {
            missing.push(row);
        }
        let chapter_id = exact.or(match same_path.as_slice() {
            [only] => Some(*only),
            _ => None,
        });
        match chapter_id {
            Some(chapter_id) => {
                let index = *chapter_index.entry(chapter_id).or_insert_with(|| {
                    by_chapter.push((chapter_id, Vec::new()));
                    by_chapter.len() - 1
                });
                by_chapter[index].1.push(row);
            }
            None => unresolved.push(row),
        }
    }
    let nodes_by_id: HashMap<i64, &Value> = chapters
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|node| Some((node.get("id")?.as_i64()?, node)))
        .collect();

    let mut applied: Vec<&BulkProgressRow> = Vec::new();
    let mut bound_chapters: Vec<(&BulkProgressRow, i64)> = Vec::new();
    let mut by_patch: Vec<(Value, Vec<(i64, Vec<&BulkProgressRow>)>)> = Vec::new();
    for (chapter_id, chapter_rows) in by_chapter {
        let mut patch = json!({ "isRead": null, "isBookmarked": null, "lastPageRead": null });
        for row in &chapter_rows {
            merge_progress_fields(&mut patch, &chapter_progress_patch(&row.variables));
        }
        let node = nodes_by_id.get(&chapter_id).copied().unwrap_or(&Value::Null);
        if node.get("pageCount").and_then(Value::as_i64).map_or(true, |count| count <= 0) {
            // Suwayomi clamps the page below a page count it does not know yet.
            patch["lastPageRead"] = Value::Null;
        }
        bound_chapters.push((chapter_rows[0], chapter_id));
        if chapter_matches_patch(node, &patch) {
            applied.extend(chapter_rows);
            continue;
        }
        match by_patch.iter_mut().find(|(existing, _)| *existing == patch) {
            Some((_, members)) => members.push((chapter_id, chapter_rows)),
            None => by_patch.push((patch, vec![(chapter_id, chapter_rows)])),
        }
    }

    let mut runtime_down = false;
    // Rows whose command Suwayomi rejected, and rows it accepted without showing their state.
    let mut rejected = 0usize;
    let mut unconfirmed = 0usize;
    let mut landed: BTreeSet<i64> = applied.iter().map(|row| row.manga_id).collect();
    for (patch, members) in by_patch {
        for chunk in members.chunks(BULK_UPDATE_CHAPTERS) {
            if runtime_down {
                break;
            }
            let mut variables = patch.clone();
            variables["ids"] = chunk.iter().map(|(chapter_id, _)| *chapter_id).collect();
            match suwayomi_commands::execute_internal_command(
                state,
                &profile_id,
                CommandOperation::UpdateChaptersProgress,
                variables,
            )
            .await
            {
                Ok(data) => {
                    for (chapter_id, chapter_rows) in chunk {
                        let mut expected = patch.clone();
                        expected["ids"] = json!([chapter_id]);
                        if chapters_projection_confirmed(&expected, &data) {
                            landed.insert(chapter_rows[0].manga_id);
                            applied.extend(chapter_rows.iter().copied());
                        } else {
                            unconfirmed += chapter_rows.len();
                        }
                    }
                }
                Err(AppError::ServiceUnavailable(detail)) if detail.retryable != Some(false) => {
                    runtime_down = true;
                }
                // A rejected command is the per-row path's to retry or block.
                Err(error) => {
                    rejected += chunk.iter().map(|(_, rows)| rows.len()).sum::<usize>();
                    tracing::warn!(profile = %profile_id, chapters = chunk.len(), error = ?error, "Suwayomi rejected synced chapter progress in bulk");
                }
            }
        }
    }

    let applied_ids: std::collections::HashSet<&str> =
        applied.iter().map(|row| row.operation_id.as_str()).collect();
    let applied_chapters: Vec<db::BoundPortableChapter<'_>> = bound_chapters
        .iter()
        .filter(|(row, _)| applied_ids.contains(row.operation_id.as_str()))
        .map(|(row, chapter_id)| db::BoundPortableChapter {
            reference: &row.chapter,
            portable_work_id: &row.portable_work_id,
            local_reference: chapter_id.to_string(),
        })
        .collect();
    let applied_list: Vec<&str> = applied_ids.iter().copied().collect();
    // Chapters the device read that this Suwayomi does not list yet are added now, as a restore
    // would add them, instead of waiting for the work's source to list them: a source behind rate
    // limits can take hours. Their rows settle on the next pass, right after this one.
    let topped_up = if runtime_down || missing.is_empty() {
        std::collections::HashSet::new()
    } else {
        top_up_missing_chapters(state, &session, &missing, watch).await
    };
    release_bulk_progress(state, &rows, &applied_list).await?;
    {
        let _writer_guard = state.mutation_gate.lock().await;
        db::upsert_bound_portable_chapters(&state.pool, &profile_id, &applied_chapters, db::now_ms())
            .await?;
    }
    // Rows it could not settle go to the per-row path; after an outage they get another bulk try.
    if !runtime_down {
        for row in rows.iter().filter(|row| {
            !applied_ids.contains(row.operation_id.as_str())
                && !topped_up.contains(row.operation_id.as_str())
        }) {
            watch.tried.insert(row.operation_id.clone());
        }
    }
    APPLIED_PROJECTIONS.fetch_add(applied_list.len() as u64, Ordering::Relaxed);
    for manga_id in landed {
        landed_works::record_projection(&profile_id, "UpdateChaptersProgress", &json!({ "mangaId": manga_id }));
    }
    if !applied_list.is_empty() || !unresolved.is_empty() {
        tracing::info!(
            profile = %profile_id,
            claimed = rows.len(),
            applied = applied_list.len(),
            unresolved = unresolved.len(),
            rejected,
            unconfirmed,
            topped_up = topped_up.len(),
            "settled synced chapter progress in bulk"
        );
    }
    // Topped-up rows count as progress: the next pass, which settles them, goes right away.
    Ok(applied_list.len() + topped_up.len())
}

const TOP_UP_WORKS_QUERY: &str = r#"
  query EpigraphTopUpWorks($ids: [Int!]!, $first: Int!) {
    mangas(filter: { id: { in: $ids } }, first: $first) {
      nodes { id sourceId url title status inLibrary inLibraryAt updateStrategy }
    }
  }
"#;

/// Adds to Suwayomi, with one restore, the chapters the rows name that it does not list, carrying
/// the state the rows leave them in. Answers the rows whose chapter was added.
///
/// A restore only inserts chapters it lacks by URL and merges into the ones it has, and every
/// chapter it is given here is one it lacks, so nothing Suwayomi already holds is overwritten. The
/// sync's own clock still decides the state: the rows are settled afterwards like any other, and a
/// row that leaves a chapter unread writes it back unread. What a restore overwrites on the work
/// itself (status, update strategy, the date it joined the library) is passed as Suwayomi has it,
/// and the work is not put into the library: a restore only ever keeps a work there.
///
/// Like an import's, the stand-ins carry no chapter number, and the source's own listing replaces
/// their name and order when the work is next fetched.
async fn top_up_missing_chapters(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    missing: &[&BulkProgressRow],
    watch: &mut BulkProgressWatch,
) -> std::collections::HashSet<String> {
    let mut by_work: std::collections::BTreeMap<i64, Vec<&BulkProgressRow>> = Default::default();
    for row in missing {
        if !watch.topped_up.contains(&row.operation_id) {
            by_work.entry(row.manga_id).or_default().push(row);
        }
    }
    let ids: Vec<i64> = by_work.keys().copied().collect();
    let mut works: Vec<(Value, Vec<String>)> = Vec::new();
    for chunk in ids.chunks(COMIC_LOOKUP_CHUNK) {
        let Ok(data) = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            TOP_UP_WORKS_QUERY,
            json!({ "ids": chunk, "first": chunk.len() }),
            false,
        )
        .await
        else {
            return Default::default();
        };
        for node in data.pointer("/mangas/nodes").and_then(Value::as_array).into_iter().flatten() {
            let Some(rows) = node.get("id").and_then(Value::as_i64).and_then(|id| by_work.get(&id))
            else {
                continue;
            };
            if let Some(work) = top_up_work(node, rows) {
                works.push((work, rows.iter().map(|row| row.operation_id.clone()).collect()));
            }
        }
    }
    let mut topped_up = std::collections::HashSet::new();
    for batch in works.chunks(IMPORT_BATCH_WORKS) {
        let started = Instant::now();
        let payload: Vec<&Value> = batch.iter().map(|(work, _)| work).collect();
        match suwayomi_import::import_works_confirmed(state, session, json!({ "works": payload })).await
        {
            Ok(_) => {
                let rows: Vec<&String> = batch.iter().flat_map(|(_, rows)| rows).collect();
                tracing::info!(
                    profile = %session.profile_id,
                    works = batch.len(),
                    rows = rows.len(),
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "added the chapters synced progress names to Suwayomi"
                );
                watch.topped_up.extend(rows.iter().map(|id| (*id).clone()));
                topped_up.extend(rows.into_iter().cloned());
            }
            Err(error) => {
                tracing::warn!(profile = %session.profile_id, error = ?error, "failed to add the chapters synced progress names to Suwayomi");
                break;
            }
        }
    }
    topped_up
}

/// The work as the restore takes it: Suwayomi's own details, so the restore keeps them, and the
/// missing chapters with the state the rows leave them in, oldest row first. `None` when Suwayomi
/// lists the work under another identity than the rows name.
fn top_up_work(node: &Value, rows: &[&BulkProgressRow]) -> Option<Value> {
    let work = serde_json::from_value::<PortableWorkRefV3>(
        rows.first()?.variables.get("portableWorkRef")?.clone(),
    )
    .ok()?;
    let PortableWorkRefV3::Comic { source_id, manga_key } = &work else {
        return None;
    };
    let node_source = match node.get("sourceId")? {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => return None,
    };
    if node_source != *source_id || node.get("url").and_then(Value::as_str) != Some(manga_key) {
        return None;
    }
    let joined_ms = match node.get("inLibraryAt") {
        Some(Value::String(text)) => text.parse::<i64>().ok(),
        Some(Value::Number(number)) => number.as_i64(),
        _ => None,
    }
    .unwrap_or(0)
    .max(0)
    .saturating_mul(1000);
    let mut chapters: std::collections::BTreeMap<&str, Value> = Default::default();
    for row in rows {
        let merged = chapters.entry(row.chapter_key.as_str()).or_insert_with(|| json!({}));
        merge_progress_fields(merged, &chapter_progress_patch(&row.variables));
    }
    let chapters: Vec<Value> = chapters
        .into_iter()
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
    let title = node
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or(manga_key);
    let mut entry = json!({
        "sourceId": source_id,
        "url": manga_key,
        "title": title,
        "dateAdded": joined_ms,
        "inLibrary": node.get("inLibrary").and_then(Value::as_bool).unwrap_or(false),
        "chapters": chapters,
    });
    for field in ["status", "updateStrategy"] {
        if let Some(value) = node.get(field).and_then(Value::as_str) {
            entry[field] = json!(value);
        }
    }
    suwayomi_import::normalized_import(json!({ "works": [entry] }))
        .ok()
        .and_then(|mut value| value.get_mut("works")?.as_array_mut()?.pop())
}

/// Whether the chapter already has every field the patch sets.
fn chapter_matches_patch(node: &Value, patch: &Value) -> bool {
    ["isRead", "isBookmarked", "lastPageRead"].iter().all(|field| {
        match patch.get(*field).filter(|value| !value.is_null()) {
            None => true,
            Some(expected) => match expected {
                Value::Bool(expected) => node.get(*field).and_then(Value::as_bool) == Some(*expected),
                Value::Number(expected) => {
                    node.get(*field).and_then(Value::as_i64) == expected.as_i64()
                }
                _ => false,
            },
        }
    })
}

/// Claims, in commit order and behind the same barrier as [claim_next_at], the due progress rows
/// of one profile that name a chapter of a work bound here.
async fn claim_bulk_progress(
    state: &SharedAppState,
    watch: &BulkProgressWatch,
) -> anyhow::Result<Option<(String, Vec<BulkProgressRow>)>> {
    let _writer_guard = state.mutation_gate.lock().await;
    claim_bulk_progress_at(&state.pool, db::now_ms(), watch).await
}

async fn claim_bulk_progress_at(
    pool: &sqlx::SqlitePool,
    now: i64,
    watch: &BulkProgressWatch,
) -> anyhow::Result<Option<(String, Vec<BulkProgressRow>)>> {
    let candidates: Vec<(String, String, String, String)> = sqlx::query_as(&format!(
        r#"
        {CLAIM_BARRIER_CTE}
        SELECT candidate.operation_id, candidate.profile_id, candidate.variables_json, candidate.status
        FROM suwayomi_projection_outbox AS candidate
        WHERE candidate.status IN ('pending', 'retry')
          AND candidate.operation_name = 'UpdateChaptersProgress'
          AND +candidate.next_attempt_at_ms <= ?
          AND {CLAIM_BARRIER_CONDITION}
        ORDER BY candidate.source_server_version ASC
        LIMIT ?
        "#
    ))
    .bind(ORDERED_RETRY_ATTEMPTS)
    .bind(NON_HOLDING_RETRY_CODES[0])
    .bind(NON_HOLDING_RETRY_CODES[1])
    .bind(NON_HOLDING_RETRY_CODES[2])
    .bind(now)
    .bind((BULK_PROGRESS_ROWS * 4) as i64)
    .fetch_all(pool)
    .await
    .context("failed to list Suwayomi progress projections")?;
    let Some(profile_id) = candidates
        .iter()
        .find(|row| !watch.tried.contains(&row.0))
        .map(|row| row.1.clone())
    else {
        return Ok(None);
    };
    let bound = db::load_bound_comic_references(pool, &profile_id).await?;
    let mut rows = Vec::new();
    // A chapter with a row left to the per-row path keeps its later rows there too, so they do
    // not land before it.
    let mut held_chapters = std::collections::HashSet::new();
    for (operation_id, row_profile, variables_json, status) in candidates {
        if row_profile != profile_id {
            continue;
        }
        let tried = watch.tried.contains(&operation_id);
        let Some(row) = bulk_progress_row(operation_id, status, &variables_json, &bound) else {
            continue;
        };
        let chapter = (row.manga_id, row.chapter_key.clone());
        if tried || held_chapters.contains(&chapter) {
            held_chapters.insert(chapter);
            continue;
        }
        rows.push(row);
        if rows.len() == BULK_PROGRESS_ROWS {
            break;
        }
    }
    if rows.is_empty() {
        return Ok(None);
    }
    let ids = serde_json::to_string(&rows.iter().map(|row| &row.operation_id).collect::<Vec<_>>())?;
    let mut tx = db::begin_write(pool).await?;
    sqlx::query(
        r#"
        UPDATE suwayomi_projection_outbox
        SET status = 'in_flight', lease_until_ms = ?, updated_at_ms = ?
        WHERE status IN ('pending', 'retry') AND operation_id IN (SELECT value FROM json_each(?))
        "#,
    )
    .bind(now.saturating_add(LEASE_MS))
    .bind(now)
    .bind(ids)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some((profile_id, rows)))
}

/// The row as the bulk pass handles it, when it names a source chapter of a work bound here.
fn bulk_progress_row(
    operation_id: String,
    status: String,
    variables_json: &str,
    bound: &HashMap<String, String>,
) -> Option<BulkProgressRow> {
    let variables = serde_json::from_str::<Value>(variables_json).ok()?;
    let work = serde_json::from_value::<PortableWorkRefV3>(variables.get("portableWorkRef")?.clone())
        .ok()
        .filter(|work| work.validate().is_ok() && matches!(work, PortableWorkRefV3::Comic { .. }))?;
    let chapter =
        serde_json::from_value::<PortableChapterRefV3>(variables.get("portableChapterRef")?.clone())
            .ok()
            .filter(|chapter| chapter.validate().is_ok())?;
    let PortableChapterRefV3::Comic { work: chapter_work, chapter_key } = &chapter else {
        return None;
    };
    // A Core-listed address carries this Suwayomi's own id; the per-row path checks it.
    if *chapter_work != work || chapter_key.starts_with(CORE_LISTED_CHAPTER_PREFIX) {
        return None;
    }
    let portable_work_id = canonical_portable_work_id(&work);
    let manga_id = bound
        .get(&portable_work_id)?
        .parse::<i64>()
        .ok()
        .filter(|id| (1..=i32::MAX as i64).contains(id))?;
    Some(BulkProgressRow {
        operation_id,
        status,
        manga_id,
        portable_work_id,
        chapter_key: chapter_key.clone(),
        chapter,
        variables,
    })
}

/// Every chapter Suwayomi lists for the works, per work. `Err` means the runtime did not answer.
async fn list_chapters_of(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    manga_ids: &[i64],
) -> Result<HashMap<i64, Value>, ()> {
    let mut chapters: HashMap<i64, Vec<Value>> = HashMap::new();
    for chunk in manga_ids.chunks(BULK_CHAPTER_WORKS) {
        let mut offset = 0;
        loop {
            let data = suwayomi_catalog::execute_graphql_document(
                state,
                session,
                BULK_CHAPTERS_QUERY,
                json!({ "mangaIds": chunk, "first": BULK_CHAPTER_PAGE, "offset": offset }),
                false,
            )
            .await
            .map_err(|_| ())?;
            let nodes = data
                .pointer("/chapters/nodes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let fetched = nodes.len();
            for node in nodes {
                if let Some(manga_id) = node.get("mangaId").and_then(Value::as_i64) {
                    chapters.entry(manga_id).or_default().push(node);
                }
            }
            let more = data
                .pointer("/chapters/pageInfo/hasNextPage")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !more || fetched == 0 {
                break;
            }
            offset += fetched;
        }
    }
    Ok(chapters
        .into_iter()
        .map(|(manga_id, nodes)| (manga_id, Value::Array(nodes)))
        .collect())
}

/// Removes the applied rows and hands every other claimed row back as it was, in one write.
async fn release_bulk_progress(
    state: &SharedAppState,
    rows: &[BulkProgressRow],
    applied: &[&str],
) -> anyhow::Result<()> {
    let applied_set: std::collections::HashSet<&str> = applied.iter().copied().collect();
    let mut pending = Vec::new();
    let mut retry = Vec::new();
    for row in rows {
        if applied_set.contains(row.operation_id.as_str()) {
            continue;
        }
        if row.status == "pending" {
            pending.push(row.operation_id.as_str());
        } else {
            retry.push(row.operation_id.as_str());
        }
    }
    let _writer_guard = state.mutation_gate.lock().await;
    release_bulk_progress_at(&state.pool, db::now_ms(), &pending, &retry, applied).await
}

async fn release_bulk_progress_at(
    pool: &sqlx::SqlitePool,
    now: i64,
    pending: &[&str],
    retry: &[&str],
    applied: &[&str],
) -> anyhow::Result<()> {
    let mut tx = db::begin_write(pool).await?;
    sqlx::query(
        r#"
        DELETE FROM suwayomi_projection_outbox
        WHERE status = 'in_flight' AND operation_id IN (SELECT value FROM json_each(?))
        "#,
    )
    .bind(serde_json::to_string(applied)?)
    .execute(&mut *tx)
    .await?;
    for (status, ids) in [("pending", pending), ("retry", retry)] {
        if ids.is_empty() {
            continue;
        }
        sqlx::query(
            r#"
            UPDATE suwayomi_projection_outbox
            SET status = ?, lease_until_ms = NULL, updated_at_ms = ?
            WHERE status = 'in_flight' AND operation_id IN (SELECT value FROM json_each(?))
            "#,
        )
        .bind(status)
        .bind(now)
        .bind(serde_json::to_string(ids)?)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// The batch's works with every queued row that concerns them: the chapters a device has progress
/// on become stand-ins of the import, and all their rows are made due once the work is bound.
/// Progress rows name their work in their entity id; category assignments only in their variables.
async fn with_work_rows(
    pool: &sqlx::SqlitePool,
    profile_id: &str,
    entries: &[(String, String, String, String)],
    batch: Vec<UnseenWork>,
) -> anyhow::Result<Vec<UnseenWork>> {
    let wanted: std::collections::HashSet<String> =
        batch.iter().map(|work| work.portable_work_id.clone()).collect();
    let mut rows: Vec<(String, String, String, String)> = entries
        .iter()
        .filter(|row| row.1 == profile_id)
        .cloned()
        .collect();
    for work in &batch {
        let id = &work.portable_work_id;
        rows.extend(
            sqlx::query_as::<_, (String, String, String, String)>(
                r#"
                SELECT operation_id, profile_id, operation_name, variables_json
                FROM suwayomi_projection_outbox
                WHERE profile_id = ? AND status IN ('pending', 'retry', 'blocked')
                  AND ((entity_type = 'comic.history' AND entity_id = ?)
                    OR (entity_type = 'comic.chapter_state' AND entity_id >= ? AND entity_id < ?))
                ORDER BY source_server_version
                "#,
            )
            .bind(profile_id)
            .bind(format!("comic.history::{id}"))
            .bind(format!("comic.chapter_state::{id}::"))
            .bind(format!("comic.chapter_state::{id}:;"))
            .fetch_all(pool)
            .await
            .context("failed to list Suwayomi progress projections of a work")?,
        );
    }
    rows.extend(
        sqlx::query_as::<_, (String, String, String, String)>(
            r#"
            SELECT operation_id, profile_id, operation_name, variables_json
            FROM suwayomi_projection_outbox
            WHERE profile_id = ? AND entity_type = 'comic.category_assignment'
              AND status IN ('pending', 'retry', 'blocked')
            ORDER BY source_server_version
            "#,
        )
        .bind(profile_id)
        .fetch_all(pool)
        .await
        .context("failed to list Suwayomi category projections")?,
    );
    Ok(collect_portable_works(&rows)
        .into_iter()
        .filter(|work| wanted.contains(&work.portable_work_id))
        .collect())
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

/// Binds the works in one transaction and makes their waiting rows due again with fresh attempts,
/// so their categories and progress land now instead of after the backoff they earned while the
/// works were missing.
async fn bind_imported_comics(
    state: &SharedAppState,
    profile_id: &str,
    works: &[UnseenWork],
    listed: &HashMap<(String, String), i64>,
) -> anyhow::Result<()> {
    let references: Vec<(&UnseenWork, String)> = works
        .iter()
        .filter_map(|work| {
            let id = listed.get(&comic_key(&work.work)?)?;
            Some((work, id.to_string()))
        })
        .collect();
    if references.is_empty() {
        return Ok(());
    }
    let bindings: Vec<db::BoundPortableWork<'_>> = references
        .iter()
        .map(|(work, local_reference)| db::BoundPortableWork {
            portable_id: &work.portable_work_id,
            reference: &work.work,
            dependency_key: None,
            local_reference,
            title_hint: work.title_hint.as_deref(),
            provider_label_hint: None,
        })
        .collect();
    let operation_ids: Vec<&str> = references
        .iter()
        .flat_map(|(work, _)| work.operation_ids.iter().map(String::as_str))
        .collect();
    {
        let _writer_guard = state.mutation_gate.lock().await;
        db::upsert_bound_portable_works(&state.pool, profile_id, &bindings, db::now_ms()).await?;
        db::rearm_projection_operations(&state.pool, &operation_ids).await?;
    }
    super::catalog_revision::invalidate(profile_id);
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
    find_chapter_id(state, profile_id, manga_id, lookup, |nodes| {
        chapter_key_matches(Some(nodes), manga_id, chapter_key)
    })
    .await
}

/// The chapter a Core-listed address names. The address carries this Suwayomi's own chapter id, but
/// only for this Core and profile, and the id still has to be a chapter of the row's work. Another
/// Core's numbers mean nothing here, so such a row waits instead of touching a chapter; blocking it
/// would hide the catalog revisions from every device.
async fn resolve_core_listed_chapter(
    state: &SharedAppState,
    profile_id: &str,
    manga_id: i64,
    chapter_key: &str,
    lookup: &mut ChapterLookup,
) -> Result<i64, ProjectionOutcome> {
    let server_id = db::load_server_identity(&state.pool)
        .await
        .map_err(|_| ProjectionOutcome::Retry("portable_binding_unavailable"))?
        .server_id;
    let chapter_id = own_core_listed_chapter(chapter_key, &server_id, profile_id)
        .ok_or(ProjectionOutcome::Retry(WAITING_CHAPTER_CODE))?;
    find_chapter_id(state, profile_id, manga_id, lookup, |nodes| {
        (listed_chapter_match(nodes, manga_id, chapter_id), Vec::new())
    })
    .await
}

/// The Core-listed address of one of this Core's chapters, as a phone names it.
pub(super) fn core_listed_chapter_key(server_id: &str, profile_id: &str, chapter_id: i64) -> String {
    format!("{CORE_LISTED_CHAPTER_PREFIX}{server_id}/{profile_id}/chapter/{chapter_id}")
}

/// The chapter id in a Core-listed address, when it names this Core and profile.
fn own_core_listed_chapter(chapter_key: &str, server_id: &str, profile_id: &str) -> Option<i64> {
    let address = chapter_key.strip_prefix(CORE_LISTED_CHAPTER_PREFIX)?;
    let segments: Vec<&str> = address.split('/').collect();
    let [server, profile, "chapter", chapter_id] = segments.as_slice() else {
        return None;
    };
    if server.is_empty() || *server != server_id || *profile != profile_id {
        return None;
    }
    chapter_id
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0 && *id <= i32::MAX as i64)
}

/// `chapter_id`, when a lookup page lists it as a chapter of `manga_id`.
fn listed_chapter_match(nodes: &Value, manga_id: i64, chapter_id: i64) -> Option<i64> {
    nodes
        .as_array()?
        .iter()
        .any(|node| {
            node.get("id").and_then(Value::as_i64) == Some(chapter_id)
                && node.get("mangaId").and_then(Value::as_i64) == Some(manga_id)
        })
        .then_some(chapter_id)
}

/// Walks a work's chapter pages until `matches` finds the chapter. `matches` answers for the pages
/// read so far with the exact chapter and the chapters that match only by path.
async fn find_chapter_id(
    state: &SharedAppState,
    profile_id: &str,
    manga_id: i64,
    lookup: &mut ChapterLookup,
    matches: impl Fn(&Value) -> (Option<i64>, Vec<i64>),
) -> Result<i64, ProjectionOutcome> {
    let session = projection_session(profile_id);
    let pages = lookup.works.entry(manga_id).or_default();
    loop {
        let (exact, same_path) = matches(&pages.nodes);
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
/// [MAX_NON_RETRYABLE_ATTEMPTS] times. `attempt_count` already includes the current attempt. Only
/// an unreachable or busy runtime retries as [RUNTIME_UNAVAILABLE], which holds the ordered queue;
/// a rejection retries as [COMMAND_FAILED], which does not.
fn failed_command_outcome(error: &AppError, attempt_count: i64) -> ProjectionOutcome {
    let non_retryable =
        matches!(error, AppError::ServiceUnavailable(detail) if detail.retryable == Some(false));
    if !non_retryable {
        ProjectionOutcome::Retry(RUNTIME_UNAVAILABLE)
    } else if attempt_count >= MAX_NON_RETRYABLE_ATTEMPTS {
        ProjectionOutcome::Blocked(COMMAND_FAILED)
    } else {
        ProjectionOutcome::Retry(COMMAND_FAILED)
    }
}

pub(crate) fn projection_session(profile_id: &str) -> AuthenticatedSession {
    AuthenticatedSession {
        token_id: PROJECTION_TOKEN_ID.to_string(),
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
    fn catalog_writes_are_announced_when_the_queue_drains_or_after_a_bounded_wait() {
        let start = Instant::now();
        let mut notice = CatalogNotice::default();
        assert!(notice.due(false, start), "the first one has waited long enough");
        assert!(!notice.due(false, start + Duration::from_secs(5)));
        assert!(notice.due(true, start + Duration::from_secs(6)), "the queue drained");
        assert!(!notice.due(false, start + Duration::from_secs(35)));
        assert!(notice.due(false, start + Duration::from_secs(36)));
    }

    #[test]
    fn permanent_command_failures_block_after_bounded_attempts() {
        let permanent = AppError::service_unavailable("SUWAYOMI_CATALOG_QUERY_FAILED", "x", false);
        let transient = AppError::service_unavailable("SUWAYOMI_CATALOG_UNAVAILABLE", "x", true);
        // A rejection retries under a code that does not hold the profile's later rows.
        assert!(matches!(
            failed_command_outcome(&permanent, 1),
            ProjectionOutcome::Retry(COMMAND_FAILED)
        ));
        assert!(matches!(
            failed_command_outcome(&permanent, MAX_NON_RETRYABLE_ATTEMPTS - 1),
            ProjectionOutcome::Retry(COMMAND_FAILED)
        ));
        assert!(matches!(
            failed_command_outcome(&permanent, MAX_NON_RETRYABLE_ATTEMPTS),
            ProjectionOutcome::Blocked(COMMAND_FAILED)
        ));
        // A runtime that is down or busy keeps retrying with backoff no matter how long it takes.
        assert!(matches!(
            failed_command_outcome(&transient, 1_000),
            ProjectionOutcome::Retry(RUNTIME_UNAVAILABLE)
        ));
        assert!(matches!(
            failed_command_outcome(&AppError::Internal("x".to_string()), 1_000),
            ProjectionOutcome::Retry(RUNTIME_UNAVAILABLE)
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
    fn a_core_listed_address_names_a_chapter_only_on_its_own_core_and_profile() {
        let own = |key: &str| own_core_listed_chapter(key, "server-a", "main");
        assert_eq!(own("aethon-core://suwayomi/server-a/main/chapter/16063"), Some(16063));
        // Another Core's chapter numbers mean nothing here.
        assert_eq!(own("aethon-core://suwayomi/server-b/main/chapter/16063"), None);
        assert_eq!(own("aethon-core://suwayomi/server-a/other/chapter/16063"), None);
        // The form without a server cannot be told from any other Core's.
        assert_eq!(own("aethon-core://suwayomi/main/chapter/16063"), None);
        assert_eq!(own("aethon-core://suwayomi/server-a/main/manga/16063"), None);
        assert_eq!(own("aethon-core://suwayomi/server-a/main/chapter/0"), None);
        assert_eq!(own("aethon-core://suwayomi/server-a/main/chapter/x"), None);
        assert_eq!(own("aethon-core://suwayomi/server-a/main/chapter/16063/extra"), None);
        assert_eq!(own("https://host.example/chapter/16063"), None);
        // The address the progress mirror builds is the one this Core reads back.
        assert_eq!(own(&core_listed_chapter_key("server-a", "main", 16063)), Some(16063));
    }

    #[test]
    fn a_core_listed_chapter_has_to_belong_to_the_work_of_the_row() {
        let nodes = json!([
            { "id": 16063, "mangaId": 125, "url": "/manga/a/chapter-1" },
            { "id": 16064, "mangaId": 126, "url": "/manga/b/chapter-1" },
        ]);
        assert_eq!(listed_chapter_match(&nodes, 125, 16063), Some(16063));
        assert_eq!(listed_chapter_match(&nodes, 125, 16064), None);
        assert_eq!(listed_chapter_match(&nodes, 125, 1), None);
        assert_eq!(listed_chapter_match(&json!(null), 125, 16063), None);
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
    async fn committed_mutations_make_the_next_pass_due_at_once() {
        let mut ticker = tokio::time::interval(Duration::from_secs(2));
        ticker.tick().await;
        // A burst of commits leaves one pending wake for the loop, not one per commit.
        wake_projection();
        wake_projection();
        tokio::time::timeout(Duration::from_millis(500), PROJECTION_WAKE.notified())
            .await
            .expect("a committed mutation wakes the projection loop");
        ticker.reset_immediately();
        tokio::time::timeout(Duration::from_millis(500), ticker.tick())
            .await
            .expect("the woken loop drains without waiting out the tick");
    }

    #[test]
    fn projection_holds_its_passes_while_a_bulk_ingest_arrives() {
        let start = Instant::now();
        let mut ingest = IngestYield::default();
        // Nothing ingested yet, or only long ago: passes run.
        assert!(!ingest.holds(0, 50_000, start));
        assert!(!ingest.holds(40_000, 50_000, start));
        // A bulk batch just arrived: the pass waits.
        assert!(ingest.holds(49_500, 50_000, start));
        assert!(ingest.holds(55_000, 56_000, start + Duration::from_secs(6)));
        // An ingest that never pauses lets one pass through every ten seconds.
        assert!(!ingest.holds(59_900, 60_000, start + Duration::from_secs(10)));
        assert!(ingest.holds(61_900, 62_000, start + Duration::from_secs(12)));
        // Once the device stops sending, the projection resumes at once.
        assert!(!ingest.holds(61_900, 64_000, start + Duration::from_secs(14)));
        assert!(ingest.since.is_none());
    }

    #[test]
    fn single_changes_do_not_hold_the_projection() {
        LAST_BULK_INGEST_MS.store(0, Ordering::Relaxed);
        note_ingest(BULK_INGEST_MIN_MUTATIONS - 1);
        assert_eq!(LAST_BULK_INGEST_MS.load(Ordering::Relaxed), 0);
        note_ingest(BULK_INGEST_MIN_MUTATIONS);
        assert!(LAST_BULK_INGEST_MS.load(Ordering::Relaxed) > 0);
        LAST_BULK_INGEST_MS.store(0, Ordering::Relaxed);
    }

    #[tokio::test]
    async fn startup_requeues_only_recoverable_blocked_rows() {
        let temp = crate::syncd::test_dir::tempdir().unwrap();
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
        let temp = crate::syncd::test_dir::tempdir().unwrap();
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
        let temp = crate::syncd::test_dir::tempdir().unwrap();
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
        let temp = crate::syncd::test_dir::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        // The barrier reads only the retrying rows through an index, once per claim, instead of
        // the whole profile queue once per due row (quadratic; 10 s per claim at 28k rows).
        let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(
            r#"
            EXPLAIN QUERY PLAN
            SELECT profile_id, MIN(source_server_version) AS version
            FROM suwayomi_projection_outbox
            WHERE status = 'retry' AND attempt_count < 3
              AND COALESCE(last_error, '') NOT IN ('a', 'b', 'c')
            GROUP BY profile_id
            "#,
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(
            plan.iter().any(|(_, _, _, detail)| {
                detail.starts_with("SEARCH suwayomi_projection_outbox USING")
                    && detail.contains("idx_suwayomi_projection_")
            }),
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
        let temp = crate::syncd::test_dir::tempdir().unwrap();
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
    async fn a_rejected_command_does_not_hold_later_rows() {
        let temp = crate::syncd::test_dir::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        for (id, version, status, error, next) in [
            ("rejected", 1, "retry", Some(COMMAND_FAILED), 9_000),
            ("next", 2, "pending", None, 0),
            ("after", 3, "pending", None, 0),
        ] {
            sqlx::query(
                r#"
                INSERT INTO suwayomi_projection_outbox (
                  operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
                  source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
                  created_at_ms, updated_at_ms
                ) VALUES (?, 'main', 'UpdateManga', '{"id":7,"inLibrary":true}', 'comic.library', ?, ?, ?, 1, ?, ?, 1, 1)
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
        let group = claim_group_at(&pool, 500, &claimed, &json!({ "inLibrary": true })).await.unwrap();
        assert!(group.iter().any(|row| row.operation_id == "after"), "{group:?}");

        // An unreachable runtime still holds the rows after it.
        sqlx::query(
            r#"
            INSERT INTO suwayomi_projection_outbox (
              operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
              source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
              created_at_ms, updated_at_ms
            ) VALUES ('outage', 'main', 'UpdateManga', '{"id":7}', 'comic.library', 'outage', 4,
                      'retry', 1, 9000, 'runtime_unavailable', 1, 1),
                     ('held', 'main', 'UpdateManga', '{"id":7}', 'comic.library', 'held', 5,
                      'pending', 0, 0, NULL, 1, 1)
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("DELETE FROM suwayomi_projection_outbox WHERE operation_id IN ('next', 'after')")
            .execute(&pool)
            .await
            .unwrap();
        assert!(claim_next_at(&pool, 600).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn library_rows_pass_earlier_chapter_progress() {
        let temp = crate::syncd::test_dir::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        let progress = json!({
            "isRead": true,
            "portableWorkRef": { "type": "comic", "sourceId": "10002", "mangaKey": "/series/a" },
            "portableChapterRef": { "chapterKey": "/series/a/1" },
        })
        .to_string();
        let into_one = r#"{"mangaId":1,"addTo":[1],"removeFrom":[]}"#;
        for (id, operation, variables, version) in [
            ("progress-1", "UpdateChaptersProgress", progress.as_str(), 1),
            ("folder-1", "UpdateMangaCategories", into_one, 2),
            ("progress-2", "UpdateChaptersProgress", progress.as_str(), 3),
            ("folder-2", "UpdateMangaCategories", into_one, 4),
        ] {
            sqlx::query(
                r#"
                INSERT INTO suwayomi_projection_outbox (
                  operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
                  source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
                  created_at_ms, updated_at_ms
                ) VALUES (?, 'main', ?, ?, 'comic.test', ?, ?, 'pending', 0, 0, NULL, 1, 1)
                "#,
            )
            .bind(id)
            .bind(operation)
            .bind(variables)
            .bind(id)
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
        }

        // The folder rows go first and group across the progress row between them.
        let first = claim_next_at(&pool, 500).await.unwrap().unwrap();
        assert_eq!(first.operation_id, "folder-1");
        let change = group_change(&first.operation_name, &serde_json::from_str(&first.variables_json).unwrap())
            .unwrap();
        let group = claim_group_at(&pool, 500, &first, &change).await.unwrap();
        assert_eq!(group.iter().map(|row| row.operation_id.as_str()).collect::<Vec<_>>(), vec!["folder-2"]);

        // Progress then keeps its own order and groups only with progress.
        let next = claim_next_at(&pool, 500).await.unwrap().unwrap();
        assert_eq!(next.operation_id, "progress-1");
        let change = group_change(&next.operation_name, &serde_json::from_str(&next.variables_json).unwrap())
            .unwrap();
        let group = claim_group_at(&pool, 500, &next, &change).await.unwrap();
        assert_eq!(group.iter().map(|row| row.operation_id.as_str()).collect::<Vec<_>>(), vec!["progress-2"]);

        // A progress retry holds later progress but not the library; a library retry holds both.
        sqlx::query("DELETE FROM suwayomi_projection_outbox").execute(&pool).await.unwrap();
        for (id, operation, variables, version, status) in [
            ("progress-outage", "UpdateChaptersProgress", progress.as_str(), 1, "retry"),
            ("progress-held", "UpdateChaptersProgress", progress.as_str(), 2, "pending"),
            ("folder", "UpdateMangaCategories", into_one, 3, "pending"),
        ] {
            sqlx::query(
                r#"
                INSERT INTO suwayomi_projection_outbox (
                  operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
                  source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
                  created_at_ms, updated_at_ms
                ) VALUES (?, 'main', ?, ?, 'comic.test', ?, ?, ?, 1, ?, ?, 1, 1)
                "#,
            )
            .bind(id)
            .bind(operation)
            .bind(variables)
            .bind(id)
            .bind(version)
            .bind(status)
            .bind(if status == "retry" { 9_000 } else { 0 })
            .bind((status == "retry").then_some(RUNTIME_UNAVAILABLE))
            .execute(&pool)
            .await
            .unwrap();
        }
        assert_eq!(claim_next_at(&pool, 600).await.unwrap().unwrap().operation_id, "folder");
        assert!(claim_next_at(&pool, 600).await.unwrap().is_none());
        sqlx::query(
            "UPDATE suwayomi_projection_outbox SET status = 'retry', next_attempt_at_ms = 9000, \
             last_error = 'runtime_unavailable', operation_name = 'UpdateMangaCategories', \
             variables_json = ? WHERE operation_id = 'progress-outage'",
        )
        .bind(into_one)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE suwayomi_projection_outbox SET status = 'pending', lease_until_ms = NULL WHERE operation_id = 'folder'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(claim_next_at(&pool, 600).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn startup_blocks_category_rows_of_another_server_only() {
        let temp = crate::syncd::test_dir::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        // Before the daemon writes its identity no row is foreign.
        assert_eq!(block_foreign_server_projections(&pool, 1).await.unwrap(), 0);
        sqlx::query("UPDATE server_identity SET server_id = 'desktop-a' WHERE singleton_id = 1")
            .execute(&pool)
            .await
            .unwrap();
        for (id, entity_type, category_id, status, error) in [
            ("foreign", "comic.category_assignment", Some("suwayomi:server:desktop-old:profile:main:category:3"), "retry", Some(COMMAND_FAILED)),
            ("foreign-category", "comic.category", Some("suwayomi:server:desktop-old:profile:main:category:3"), "pending", None),
            ("local", "comic.category_assignment", Some("suwayomi:server:desktop-a:profile:main:category:3"), "pending", None),
            ("legacy", "comic.category_assignment", Some("suwayomi:profile:main:category:3"), "pending", None),
            ("no-record", "comic.category_assignment", None, "pending", None),
        ] {
            sqlx::query(
                r#"
                INSERT INTO suwayomi_projection_outbox (
                  operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
                  source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
                  created_at_ms, updated_at_ms
                ) VALUES (?, 'main', 'UpdateMangaCategories', '{"mangaId":7,"addTo":[3],"removeFrom":[]}',
                          ?, ?, 1, ?, 1, 0, ?, 1, 1)
                "#,
            )
            .bind(id)
            .bind(entity_type)
            .bind(id)
            .bind(status)
            .bind(error)
            .execute(&pool)
            .await
            .unwrap();
            if let Some(category_id) = category_id {
                sqlx::query(
                    r#"
                    INSERT INTO comic_sync_state (
                      scope_id, entity_type, entity_id, record_json, record_updated_at_ms,
                      record_updated_by_device_id, record_lamport, record_server_version
                    ) VALUES ('comics:profile:main', ?, ?, ?, 1, 'device', 1, 1)
                    "#,
                )
                .bind(entity_type)
                .bind(id)
                .bind(json!({ "categoryId": category_id }).to_string())
                .execute(&pool)
                .await
                .unwrap();
            }
        }

        assert_eq!(block_foreign_server_projections(&pool, 50).await.unwrap(), 2);
        // Idempotent, and not undone by the recoverable requeue that runs before it.
        assert_eq!(block_foreign_server_projections(&pool, 60).await.unwrap(), 0);
        assert_eq!(requeue_recoverable_blocked(&pool, 70).await.unwrap(), 0);

        let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT operation_id, status, last_error FROM suwayomi_projection_outbox ORDER BY operation_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let blocked = || ("blocked".to_string(), Some(FOREIGN_SERVER_IDENTITY.to_string()));
        let pending = || ("pending".to_string(), None);
        let rows: Vec<(String, (String, Option<String>))> =
            rows.into_iter().map(|(id, status, error)| (id, (status, error))).collect();
        assert_eq!(
            rows,
            vec![
                ("foreign".to_string(), blocked()),
                ("foreign-category".to_string(), blocked()),
                ("legacy".to_string(), pending()),
                ("local".to_string(), pending()),
                ("no-record".to_string(), pending()),
            ]
        );
    }

    #[tokio::test]
    async fn unresolved_chapter_retries_remain_visible_without_holding_catalog() {
        let temp = crate::syncd::test_dir::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        for (id, operation, status, attempts, error) in [
            ("waiting", "UpdateChaptersProgress", "retry", MAX_CONFIRMATION_ATTEMPTS, Some(WAITING_CHAPTER_CODE)),
            ("young", "UpdateChaptersProgress", "retry", MAX_CONFIRMATION_ATTEMPTS - 1, Some(WAITING_CHAPTER_CODE)),
            ("outage", "UpdateChaptersProgress", "retry", 9, Some("runtime_unavailable")),
            ("fresh", "UpdateManga", "pending", 0, None),
            ("library", "UpdateManga", "retry", 9, Some(WAITING_CHAPTER_CODE)),
            ("gave_up", "UpdateManga", "blocked", 5, Some(PORTABLE_WORK_NOT_FOUND)),
            ("rejected", "UpdateManga", "blocked", 1, Some("command_rejected")),
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
            ProjectionStatusCounts {
                pending: 4,
                blocked: 3,
                in_flight: 0,
                catalog_pending: 2,
                catalog_blocked: 1,
            }
        );
        assert_eq!(projection_status_counts(&pool, "other").await.unwrap().pending, 0);
        // Progress remains unfinished, while the first-run catalog gate counts only library work.
        assert_eq!(
            pending_projection_counts_in(&pool).await.unwrap(),
            PendingProjectionCounts { total: 5, catalog: 2 }
        );
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
        let temp = crate::syncd::test_dir::tempdir().unwrap();
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

    #[test]
    fn a_page_is_left_out_only_on_chapters_without_a_page_count() {
        let data = json!({ "chapters": { "nodes": [
            { "id": 203, "pageCount": -1 },
            { "id": 204, "pageCount": 0 },
            { "id": 205, "pageCount": 24 },
            { "id": 206 },
        ] } });
        let unknown = unknown_page_counts(&data);
        assert_eq!(unknown, BTreeSet::from([203, 204, 206]));
        assert!(unknown_page_counts(&json!({})).is_empty());

        let mut known = json!({ "ids": [205], "isRead": false, "lastPageRead": 19 });
        leave_out_unknown_page(&mut known, &unknown);
        assert_eq!(known["lastPageRead"], 19);

        let mut read = json!({ "ids": [203], "isRead": true, "lastPageRead": 19 });
        leave_out_unknown_page(&mut read, &unknown);
        assert_eq!(read, json!({ "ids": [203], "isRead": true }));
        assert!(writes_progress(&chapter_progress_patch(&read)));

        // A row that only moved the page has nothing left to write there.
        let mut page_only = json!({ "ids": [203], "lastPageRead": 19 });
        assert!(sets_page(&page_only));
        leave_out_unknown_page(&mut page_only, &unknown);
        assert!(!sets_page(&page_only));
        assert!(!writes_progress(&chapter_progress_patch(&page_only)));
    }

    #[tokio::test]
    async fn a_group_takes_only_the_unbroken_run_of_the_same_change() {
        let temp = crate::syncd::test_dir::tempdir().unwrap();
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

    #[tokio::test]
    async fn a_group_passes_over_other_changes_of_a_work_but_keeps_its_order() {
        let temp = crate::syncd::test_dir::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        let work = |key: &str| json!({ "type": "comic", "sourceId": "1", "mangaKey": key });
        let entry = |key: &str| json!({ "mangaId": 1, "inLibrary": true, "portableWorkRef": work(key) }).to_string();
        let folder =
            |key: &str| json!({ "mangaId": 1, "addTo": [1], "removeFrom": [], "portableWorkRef": work(key) }).to_string();
        // How a synced library arrives: each work's entry, then its categories.
        for (id, operation, variables, version) in [
            ("entry-a", "UpdateManga", entry("/a"), 1),
            ("folder-a", "UpdateMangaCategories", folder("/a"), 2),
            ("entry-b", "UpdateManga", entry("/b"), 3),
            ("folder-b", "UpdateMangaCategories", folder("/b"), 4),
            ("entry-c", "UpdateManga", entry("/c"), 5),
            ("folder-c", "UpdateMangaCategories", folder("/c"), 6),
            // Waits for folder-a, which came first.
            ("entry-a-again", "UpdateManga", entry("/a"), 7),
        ] {
            sqlx::query(
                r#"
                INSERT INTO suwayomi_projection_outbox (
                  operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
                  source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
                  created_at_ms, updated_at_ms
                ) VALUES (?, 'main', ?, ?, 'comic.test', ?, ?, 'pending', 0, 0, NULL, 1, 1)
                "#,
            )
            .bind(id)
            .bind(operation)
            .bind(variables)
            .bind(id)
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
        }
        let mut claimed = Vec::new();
        while let Some(first) = claim_next_at(&pool, 500).await.unwrap() {
            let change = group_change(&first.operation_name, &serde_json::from_str(&first.variables_json).unwrap())
                .unwrap();
            let group = claim_group_at(&pool, 500, &first, &change).await.unwrap();
            let mut ids = vec![first.operation_id.clone()];
            ids.extend(group.iter().map(|row| row.operation_id.clone()));
            sqlx::query("DELETE FROM suwayomi_projection_outbox WHERE status = 'in_flight'")
                .execute(&pool)
                .await
                .unwrap();
            claimed.push(ids);
        }
        assert_eq!(
            claimed,
            vec![
                vec!["entry-a", "entry-b", "entry-c"],
                vec!["folder-a", "folder-b", "folder-c"],
                vec!["entry-a-again"],
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
        // The newer row leaves the page out, so the older row's page stands, as it would if the
        // rows were applied one after the other.
        assert_eq!(first.chapters["/manga/a/chapter-1"]["lastPageRead"], json!(2));
        // A work only categorised here is not in any device's library.
        assert!(!works[1].in_library);

        let import = import_work_variables(first).unwrap();
        assert_eq!(import["sourceId"], json!("2499283573021220255"));
        assert_eq!(import["url"], json!("/manga/a"));
        assert_eq!(import["title"], json!("A"));
        assert_eq!(
            import["chapters"],
            json!([{ "url": "/manga/a/chapter-1", "name": "chapter-1", "isRead": true,
                     "isBookmarked": false, "lastPageRead": 2, "chapterNumber": -1.0 }])
        );
        // Without a title hint the key stands in until the source fills the details.
        assert_eq!(import_work_variables(&works[1]).unwrap()["title"], json!("/manga/b"));
    }

    #[test]
    fn a_core_listed_address_never_becomes_a_chapter_of_an_imported_work() {
        let work = json!({ "type": "comic", "sourceId": "1", "mangaKey": "/manga/a" });
        let rows = vec![outbox_row("listed", "UpdateChaptersProgress", json!({
            "isRead": true, "lastPageRead": null, "isBookmarked": null, "portableWorkRef": work,
            "portableChapterRef": { "type": "comic", "work": work,
                "chapterKey": "aethon-core://suwayomi/server-a/main/chapter/7" } }))];
        let works = collect_portable_works(&rows);
        assert_eq!(works[0].operation_ids, ["listed"]);
        assert!(works[0].chapters.is_empty());
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
        let temp = crate::syncd::test_dir::tempdir().unwrap();
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
        let temp = crate::syncd::test_dir::tempdir().unwrap();
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

    #[test]
    fn later_progress_fields_override_and_missing_ones_keep_the_earlier_value() {
        let mut merged = json!({ "isRead": true, "lastPageRead": 4 });
        merge_progress_fields(&mut merged, &json!({ "lastPageRead": 9, "isBookmarked": null }));
        assert_eq!(merged, json!({ "isRead": true, "lastPageRead": 9 }));
        merge_progress_fields(&mut merged, &json!({ "isRead": false, "isBookmarked": true }));
        assert_eq!(merged, json!({ "isRead": false, "isBookmarked": true, "lastPageRead": 9 }));
        // Not an object on either side: nothing to merge.
        merge_progress_fields(&mut merged, &json!(null));
        assert_eq!(merged["lastPageRead"], 9);
    }

    #[test]
    fn a_chapter_matches_a_patch_only_on_the_fields_it_sets() {
        let node = json!({ "id": 1, "isRead": true, "isBookmarked": false, "lastPageRead": 12 });
        assert!(chapter_matches_patch(&node, &json!({ "isRead": true, "isBookmarked": null, "lastPageRead": null })));
        assert!(chapter_matches_patch(&node, &json!({ "isRead": true, "isBookmarked": false, "lastPageRead": 12 })));
        assert!(!chapter_matches_patch(&node, &json!({ "isRead": true, "lastPageRead": 13 })));
        assert!(!chapter_matches_patch(&node, &json!({ "isBookmarked": true })));
        // A chapter Suwayomi did not list matches only an empty patch.
        assert!(!chapter_matches_patch(&Value::Null, &json!({ "isRead": true })));
        assert!(chapter_matches_patch(&Value::Null, &json!({ "isRead": null })));
    }

    #[test]
    fn listed_comics_match_their_exact_source_and_key() {
        let wanted = vec![
            ("10002".to_string(), "/series/a".to_string()),
            ("10003".to_string(), "/series/b".to_string()),
        ];
        let nodes = vec![
            json!({ "id": 7, "sourceId": "10002", "url": "/series/a" }),
            // The same work listed twice: the oldest entry wins.
            json!({ "id": 9, "sourceId": "10002", "url": "/series/a" }),
            // A key of one source coming back for another is not the work.
            json!({ "id": 8, "sourceId": "10002", "url": "/series/b" }),
            json!({ "id": 11, "sourceId": 10003, "url": "/series/b" }),
            json!({ "id": 0, "sourceId": "10003", "url": "/series/b" }),
            json!({ "id": 12, "url": "/series/b" }),
        ];
        let mut found = HashMap::new();
        collect_listed_comics(&nodes, &wanted, &mut found);
        assert_eq!(found.len(), 2);
        assert_eq!(found[&wanted[0]], 7);
        assert_eq!(found[&wanted[1]], 11);
        assert_eq!(
            comic_key(&PortableWorkRefV3::comic("10002", "/series/a")),
            Some(wanted[0].clone())
        );
    }

    fn progress_variables(key: &str, chapter_key: &str, fields: Value) -> Value {
        let work = json!({ "type": "comic", "sourceId": "10002", "mangaKey": key });
        let mut variables = json!({
            "portableWorkRef": work,
            "portableChapterRef": { "type": "comic", "work": work, "chapterKey": chapter_key },
        });
        for (field, value) in fields.as_object().unwrap() {
            variables[field] = value.clone();
        }
        variables
    }

    #[test]
    fn a_top_up_restores_only_the_missing_chapters_and_keeps_the_work_as_suwayomi_has_it() {
        let bound: HashMap<String, String> = [(
            canonical_portable_work_id(&PortableWorkRefV3::comic("10002", "/series/a")),
            "7".to_string(),
        )]
        .into_iter()
        .collect();
        let row = |id: &str, chapter: &str, fields: Value| {
            bulk_progress_row(
                id.to_string(),
                "pending".to_string(),
                &progress_variables("/series/a", chapter, fields).to_string(),
                &bound,
            )
            .unwrap()
        };
        let rows = [
            row("1", "/series/a/2", json!({ "isRead": true, "lastPageRead": 3 })),
            row("2", "/series/a/2", json!({ "isBookmarked": true, "lastPageRead": null })),
            row("3", "/series/a/1", json!({ "isRead": false, "lastPageRead": 9 })),
        ];
        let rows: Vec<&BulkProgressRow> = rows.iter().collect();
        let node = json!({
            "id": 7, "sourceId": "10002", "url": "/series/a", "title": " A ",
            "status": "ONGOING", "inLibrary": false, "inLibraryAt": "1700000000",
            "updateStrategy": "ONLY_FETCH_ONCE",
        });
        let work = top_up_work(&node, &rows).expect("the work Suwayomi lists");
        assert_eq!(work["title"], "A");
        assert_eq!(work["inLibrary"], false);
        assert_eq!(work["dateAdded"], 1_700_000_000_000_i64);
        assert_eq!(work["status"], "ONGOING");
        assert_eq!(work["updateStrategy"], "ONLY_FETCH_ONCE");
        assert_eq!(
            work["chapters"],
            json!([
                { "url": "/series/a/1", "name": "1", "isRead": false, "isBookmarked": false, "lastPageRead": 9, "chapterNumber": -1.0 },
                { "url": "/series/a/2", "name": "2", "isRead": true, "isBookmarked": true, "lastPageRead": 3, "chapterNumber": -1.0 },
            ])
        );
        let mut library = node.clone();
        library["inLibrary"] = json!(true);
        library["sourceId"] = json!(10002);
        assert_eq!(top_up_work(&library, &rows).unwrap()["inLibrary"], true);
        let mut moved = node.clone();
        moved["url"] = json!("/series/b");
        assert!(top_up_work(&moved, &rows).is_none(), "another work under the same id");
    }

    #[test]
    fn bulk_rows_name_a_source_chapter_of_a_bound_work() {
        let bound: HashMap<String, String> = [(
            canonical_portable_work_id(&PortableWorkRefV3::comic("10002", "/series/a")),
            "7".to_string(),
        )]
        .into_iter()
        .collect();
        let row = |variables: Value| {
            bulk_progress_row("op".to_string(), "pending".to_string(), &variables.to_string(), &bound)
        };
        let accepted = row(progress_variables("/series/a", "/series/a/1", json!({ "isRead": true })))
            .expect("a chapter of a bound work");
        assert_eq!(accepted.manga_id, 7);
        assert_eq!(accepted.chapter_key, "/series/a/1");
        assert!(row(progress_variables("/series/b", "/series/b/1", json!({}))).is_none(), "not bound");
        assert!(
            row(progress_variables("/series/a", "aethon-core://suwayomi/s/main/chapter/5", json!({})))
                .is_none(),
            "a Core-listed address is checked by the per-row path"
        );
        let mut other_work = progress_variables("/series/a", "/series/b/1", json!({}));
        other_work["portableChapterRef"]["work"]["mangaKey"] = json!("/series/b");
        assert!(row(other_work).is_none(), "the chapter belongs to another work");
        assert!(row(json!({ "portableWorkRef": { "type": "comic", "sourceId": "10002", "mangaKey": "/series/a" } })).is_none());
        let huge: HashMap<String, String> =
            bound.keys().map(|key| (key.clone(), "4294967296".to_string())).collect();
        assert!(bulk_progress_row(
            "op".to_string(),
            "pending".to_string(),
            &progress_variables("/series/a", "/series/a/1", json!({})).to_string(),
            &huge
        )
        .is_none());
    }

    async fn insert_progress(
        pool: &sqlx::SqlitePool,
        id: &str,
        version: i64,
        status: &str,
        attempts: i64,
        error: Option<&str>,
        variables: &Value,
    ) {
        sqlx::query(
            r#"
            INSERT INTO suwayomi_projection_outbox (
              operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
              source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
              created_at_ms, updated_at_ms
            ) VALUES (?, 'main', 'UpdateChaptersProgress', ?, 'comic.chapter_state', ?, ?, ?, ?, 0, ?, 1, 1)
            "#,
        )
        .bind(id)
        .bind(variables.to_string())
        .bind(id)
        .bind(version)
        .bind(status)
        .bind(attempts)
        .bind(error)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn outbox_rows(pool: &sqlx::SqlitePool) -> Vec<(String, String, i64)> {
        sqlx::query_as(
            "SELECT operation_id, status, attempt_count FROM suwayomi_projection_outbox ORDER BY operation_id",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn bulk_progress_claims_bound_rows_in_order_and_releases_what_it_did_not_apply() {
        let temp = crate::syncd::test_dir::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        let bound = PortableWorkRefV3::comic("10002", "/series/a");
        db::upsert_portable_work_binding(
            &pool,
            "main",
            &canonical_portable_work_id(&bound),
            &bound,
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
        let read = |chapter: &str| progress_variables("/series/a", chapter, json!({ "isRead": true }));
        insert_progress(&pool, "a1", 1, "pending", 0, None, &read("/series/a/1")).await;
        insert_progress(&pool, "a2", 2, "retry", 1, Some("command_failed"), &read("/series/a/2")).await;
        insert_progress(&pool, "a3", 3, "pending", 0, None, &read("/series/a/3")).await;
        // A later row of a chapter whose earlier row is left to the per-row path stays there too.
        insert_progress(&pool, "a3-later", 4, "pending", 0, None, &read("/series/a/3")).await;
        insert_progress(&pool, "unbound", 5, "pending", 0, None, &progress_variables("/series/b", "/series/b/1", json!({ "isRead": true }))).await;

        let mut watch = BulkProgressWatch::default();
        watch.tried.insert("a3".to_string());
        let (profile, rows) = claim_bulk_progress_at(&pool, 10, &watch).await.unwrap().unwrap();
        assert_eq!(profile, "main");
        let claimed: Vec<&str> = rows.iter().map(|row| row.operation_id.as_str()).collect();
        assert_eq!(claimed, vec!["a1", "a2"]);
        assert_eq!(
            outbox_rows(&pool).await,
            vec![
                ("a1".to_string(), "in_flight".to_string(), 0),
                ("a2".to_string(), "in_flight".to_string(), 1),
                ("a3".to_string(), "pending".to_string(), 0),
                ("a3-later".to_string(), "pending".to_string(), 0),
                ("unbound".to_string(), "pending".to_string(), 0),
            ]
        );
        // The per-row path does not take the claimed rows meanwhile.
        let next = claim_next_of(&pool, 10, &[true]).await.unwrap().unwrap();
        assert_eq!(next.operation_id, "a3");

        // a1 landed; a2 goes back as it was, without an attempt spent.
        release_bulk_progress_at(&pool, 20, &[], &["a2"], &["a1"]).await.unwrap();
        let rows = outbox_rows(&pool).await;
        assert_eq!(
            rows,
            vec![
                ("a2".to_string(), "retry".to_string(), 1),
                ("a3".to_string(), "in_flight".to_string(), 1),
                ("a3-later".to_string(), "pending".to_string(), 0),
                ("unbound".to_string(), "pending".to_string(), 0),
            ]
        );
        let lease: Option<i64> = sqlx::query_scalar(
            "SELECT lease_until_ms FROM suwayomi_projection_outbox WHERE operation_id = 'a2'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(lease, None);
    }

    #[tokio::test]
    async fn bulk_progress_waits_behind_a_holding_retry_and_library_only_claims_skip_progress() {
        let temp = crate::syncd::test_dir::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        let bound = PortableWorkRefV3::comic("10002", "/series/a");
        db::upsert_portable_work_binding(
            &pool,
            "main",
            &canonical_portable_work_id(&bound),
            &bound,
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
        let read = |chapter: &str| progress_variables("/series/a", chapter, json!({ "isRead": true }));
        // An earlier progress retry that holds the profile's later progress, not yet due.
        sqlx::query(
            r#"
            INSERT INTO suwayomi_projection_outbox (
              operation_id, profile_id, operation_name, variables_json, entity_type, entity_id,
              source_server_version, status, attempt_count, next_attempt_at_ms, last_error,
              created_at_ms, updated_at_ms
            ) VALUES ('held', 'main', 'UpdateChaptersProgress', ?, 'comic.chapter_state', 'held', 1, 'retry', 1, 1000, 'confirmation_mismatch', 1, 1)
            "#,
        )
        .bind(read("/series/a/0").to_string())
        .execute(&pool)
        .await
        .unwrap();
        insert_progress(&pool, "later", 2, "pending", 0, None, &read("/series/a/1")).await;
        let watch = BulkProgressWatch::default();
        assert!(claim_bulk_progress_at(&pool, 10, &watch).await.unwrap().is_none());
        assert!(claim_next_of(&pool, 10, &[false]).await.unwrap().is_none(), "no library rows");
    }

    #[tokio::test]
    async fn rearming_gives_waiting_rows_fresh_attempts_and_leaves_others() {
        let temp = crate::syncd::test_dir::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        let variables = progress_variables("/series/a", "/series/a/1", json!({ "isRead": true }));
        insert_progress(&pool, "retry", 1, "retry", 4, Some("portable_work_not_bound"), &variables).await;
        insert_progress(&pool, "blocked", 2, "blocked", 6, Some("portable_work_not_found"), &variables).await;
        insert_progress(&pool, "flight", 3, "in_flight", 2, None, &variables).await;
        insert_progress(&pool, "untouched", 4, "retry", 4, Some("portable_work_not_bound"), &variables).await;
        let rearmed = db::rearm_projection_operations(&pool, &["retry", "blocked", "flight", "missing"])
            .await
            .unwrap();
        assert_eq!(rearmed, 2);
        assert_eq!(
            outbox_rows(&pool).await,
            vec![
                ("blocked".to_string(), "retry".to_string(), 0),
                ("flight".to_string(), "in_flight".to_string(), 2),
                ("retry".to_string(), "retry".to_string(), 0),
                ("untouched".to_string(), "retry".to_string(), 4),
            ]
        );
    }
}
