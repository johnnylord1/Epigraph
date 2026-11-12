//! Completes the comics a sync imported. A synced work is restored with only the chapters devices
//! have progress on and no details, which Suwayomi keeps as `initialized: false`. This fetches its
//! chapter list, details and cover from the source, as a library update does, so the desktop
//! library is whole without opening each work.
//!
//! Progress is left alone: Suwayomi matches listed chapters by URL and never changes their read,
//! bookmark or page state, and the chapters it adds start unread, which the progress mirror does
//! not emit. Stand-ins the source no longer lists under their URL (a source that moved host) take
//! their progress along: the stored progress is projected again onto the chapters that replaced
//! them.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use anyhow::Context;
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};

use super::lifecycle::{wait_for_shutdown_request, ShutdownRequest};
use super::models::{AppError, AuthenticatedSession, PortableWorkBindingRow, SharedAppState};
use super::routes::suwayomi_catalog;
use super::{catalog_revision, db, landed_works, suwayomi_projection};

/// Sources fetched at once, one work at a time each, as Mihon's library update does: sources keep
/// their own rate limits, so a library on a single source is not hammered.
const MAX_PARALLEL_SOURCES: usize = 5;
const PASS_INTERVAL: Duration = Duration::from_secs(15);
const BASE_RETRY: Duration = Duration::from_secs(60);
const MAX_RETRY: Duration = Duration::from_secs(30 * 60);
const WORK_PAGE_SIZE: i64 = 500;
const MAX_WORK_PAGES: usize = 40;
const PENDING_WORK_BATCH_SIZE: usize = 100;
const CHAPTER_PAGE_SIZE: i64 = 250;
const MAX_CHAPTER_PAGES: usize = 80;

const UNHYDRATED_COMICS_QUERY: &str = r#"
  query EpigraphUnhydratedComics($first: Int!, $offset: Int!) {
    mangas(condition: { inLibrary: true, initialized: false }, first: $first, offset: $offset) {
      pageInfo { hasNextPage }
      nodes { id sourceId }
    }
  }
"#;

const PENDING_CHAPTER_HYDRATION_QUERY: &str = r#"
  query EpigraphPendingChapterHydration($ids: [Int!]!, $first: Int!) {
    mangas(filter: { id: { in: $ids } }, first: $first) {
      nodes { id sourceId url inLibrary chapters { totalCount } }
    }
  }
"#;

const STAND_IN_CHAPTERS_QUERY: &str = r#"
  query EpigraphStandInChapters($mangaId: Int!, $first: Int!, $offset: Int!) {
    chapters(condition: { mangaId: $mangaId }, first: $first, offset: $offset) {
      pageInfo { hasNextPage }
      nodes { url isRead isBookmarked lastPageRead }
    }
  }
"#;

const FETCH_CHAPTERS_MUTATION: &str = r#"
  mutation EpigraphHydrateChapters($mangaId: Int!) {
    fetchChapters(input: { mangaId: $mangaId }) { chapters { url } }
  }
"#;

/// Last, since it is what clears `initialized: false`: a work whose chapters could not be fetched
/// stays listed and is tried again.
const FETCH_MANGA_MUTATION: &str = r#"
  mutation EpigraphHydrateManga($id: Int!) {
    fetchManga(input: { id: $id }) { manga { id } }
  }
"#;

const RUNTIME_PROBE_QUERY: &str = "query EpigraphHydrationProbe { __typename }";

static PENDING: AtomicI64 = AtomicI64::new(0);

/// Library works still waiting for their details and chapter list, as of the last pass.
pub fn pending_count() -> i64 {
    PENDING.load(Ordering::Relaxed).max(0)
}

pub fn spawn_hydration_task(
    state: SharedAppState,
    mut shutdown: tokio::sync::watch::Receiver<Option<ShutdownRequest>>,
) {
    tokio::spawn(async move {
        let mut retries = RetryBook::load(&state.pool, db::now_ms())
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(error = %error, "failed to read when synced comics are due again");
                RetryBook::default()
            });
        let mut ticker = tokio::time::interval(PASS_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    tokio::select! {
                        result = hydrate_profiles(&state, &mut retries) => {
                            if let Err(error) = result {
                                tracing::warn!(error = %error, "failed to complete synced comics");
                            }
                        }
                        _ = wait_for_shutdown_request(&mut shutdown) => break,
                    }
                }
                _ = wait_for_shutdown_request(&mut shutdown) => break,
            }
        }
    });
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UnhydratedWork {
    manga_id: i64,
    source_id: String,
    needs_chapters: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Hydrated,
    Failed,
    /// The runtime stopped answering or went into maintenance: not the work's fault.
    RuntimeUnavailable,
}

async fn hydrate_profiles(state: &SharedAppState, retries: &mut RetryBook) -> anyhow::Result<()> {
    let runtime_root = crate::suwayomi_maintenance::default_runtime_root();
    if crate::suwayomi_maintenance::exclusive_file_lease_held(&runtime_root).unwrap_or(false) {
        return Ok(());
    }
    let profiles: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT profile_id FROM portable_work_bindings
        WHERE ecosystem = 'SUWAYOMI' AND resolution_state = 'BOUND'
        ORDER BY profile_id
        "#,
    )
    .fetch_all(&state.pool)
    .await
    .context("failed to list profiles with synced comics")?;

    let mut listed = Vec::new();
    for profile_id in profiles {
        let session = suwayomi_projection::projection_session(&profile_id);
        // A runtime that does not answer is skipped; its works are listed again next pass.
        if let Ok(works) = list_unhydrated(state, &session).await {
            listed.push((session, works));
        }
    }
    PENDING.store(
        listed.iter().map(|(_, works)| works.len() as i64).sum(),
        Ordering::Relaxed,
    );
    retries.retain(|profile_id, manga_id| {
        // A profile whose runtime did not answer says nothing about its works.
        listed
            .iter()
            .find(|(session, _)| session.profile_id == profile_id)
            .is_none_or(|(_, works)| works.iter().any(|work| work.manga_id == manga_id))
    });
    save_retries(state, retries).await;

    for (session, works) in &listed {
        let now = db::now_ms();
        let queues = due_queues_by_source(works, |manga_id| {
            retries.is_due(&session.profile_id, manga_id, now)
        });
        if queues.is_empty() {
            continue;
        }
        let results: Vec<Vec<(i64, Outcome)>> = stream::iter(queues)
            .map(|queue| hydrate_queue(state, session, queue))
            .buffer_unordered(MAX_PARALLEL_SOURCES)
            .collect()
            .await;
        let mut hydrated = 0;
        for (manga_id, outcome) in results.into_iter().flatten() {
            match outcome {
                Outcome::Hydrated => {
                    retries.clear(&session.profile_id, manga_id);
                    landed_works::record_work(&session.profile_id, manga_id);
                    hydrated += 1;
                }
                Outcome::Failed => retries.fail(&session.profile_id, manga_id, db::now_ms()),
                Outcome::RuntimeUnavailable => {}
            }
        }
        save_retries(state, retries).await;
        if hydrated > 0 {
            tracing::info!(profile = session.profile_id, hydrated, "completed synced comics from their sources");
        }
    }
    Ok(())
}

async fn save_retries(state: &SharedAppState, retries: &mut RetryBook) {
    if !retries.dirty {
        return;
    }
    let _writer_guard = state.mutation_gate.lock().await;
    if let Err(error) = retries.save(&state.pool).await {
        tracing::warn!(error = %error, "failed to save when synced comics are due again");
    }
}

/// One source's works, in order. Stops when the runtime goes away, leaving the rest due.
async fn hydrate_queue(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    queue: Vec<UnhydratedWork>,
) -> Vec<(i64, Outcome)> {
    let mut outcomes = Vec::with_capacity(queue.len());
    for work in queue {
        let manga_id = work.manga_id;
        let outcome = match hydrate_work(state, session, manga_id, work.needs_chapters).await {
            Ok(()) => {
                PENDING.fetch_sub(1, Ordering::Relaxed);
                Outcome::Hydrated
            }
            Err(error) => failure_outcome(state, session, &error).await,
        };
        outcomes.push((manga_id, outcome));
        if outcome == Outcome::RuntimeUnavailable {
            break;
        }
    }
    outcomes
}

async fn hydrate_work(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    manga_id: i64,
    needs_chapters: bool,
) -> Result<(), AppError> {
    let stand_ins = chapters_with_progress(state, session, manga_id).await?;
    let fetched = suwayomi_catalog::execute_source_fetch(
        state,
        session,
        FETCH_CHAPTERS_MUTATION,
        json!({ "mangaId": manga_id }),
    )
    .await?;
    let listed = listed_chapter_urls(fetched.pointer("/fetchChapters/chapters"));
    if needs_chapters && listed.is_empty() {
        return Err(AppError::service_unavailable(
            "SUWAYOMI_HYDRATION_CHAPTERS_EMPTY",
            "The source has not provided the chapters required by synchronized progress.",
            true,
        ));
    }
    if !listed.is_empty() {
        rearm_chapter_retries(state, &session.profile_id, manga_id).await?;
    }
    let replaced: BTreeSet<String> = stand_ins.difference(&listed).cloned().collect();
    if !replaced.is_empty() {
        match carry_progress(state, &session.profile_id, manga_id, &replaced).await {
            Ok(queued) => tracing::info!(
                profile = session.profile_id,
                manga_id,
                replaced = replaced.len(),
                queued,
                "projecting progress again onto chapters the source replaced"
            ),
            Err(error) => {
                tracing::warn!(error = %error, manga_id, "failed to carry progress to replaced chapters")
            }
        }
    }
    suwayomi_catalog::execute_source_fetch(
        state,
        session,
        FETCH_MANGA_MUTATION,
        json!({ "id": manga_id }),
    )
    .await?;
    // Only a work that is now complete changed the catalog the devices apply: a work whose source
    // keeps failing is fetched again on every retry and must not keep the revisions hidden.
    catalog_revision::invalidate(&session.profile_id);
    Ok(())
}

/// A failure caused by the runtime itself (down, restarting, maintained) is not held against the
/// work. A request that timed out while the runtime still answers is: the source was too slow.
async fn failure_outcome(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    error: &AppError,
) -> Outcome {
    let AppError::ServiceUnavailable(detail) = error else {
        return Outcome::Failed;
    };
    match detail.code.as_str() {
        "SUWAYOMI_MAINTENANCE" => Outcome::RuntimeUnavailable,
        "SUWAYOMI_CATALOG_UNAVAILABLE" => {
            let answers = suwayomi_catalog::execute_graphql_document(
                state,
                session,
                RUNTIME_PROBE_QUERY,
                json!({}),
                false,
            )
            .await
            .is_ok();
            if answers {
                Outcome::Failed
            } else {
                Outcome::RuntimeUnavailable
            }
        }
        _ => Outcome::Failed,
    }
}

async fn list_unhydrated(
    state: &SharedAppState,
    session: &AuthenticatedSession,
) -> Result<Vec<UnhydratedWork>, AppError> {
    let mut works = BTreeMap::new();
    for page in 0..MAX_WORK_PAGES {
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            UNHYDRATED_COMICS_QUERY,
            json!({ "first": WORK_PAGE_SIZE, "offset": page as i64 * WORK_PAGE_SIZE }),
            false,
        )
        .await?;
        for work in parse_unhydrated(data.pointer("/mangas/nodes")) {
            works.insert(work.manga_id, work);
        }
        if data
            .pointer("/mangas/pageInfo/hasNextPage")
            .and_then(Value::as_bool)
            != Some(true)
        {
            break;
        }
    }
    // A work's details may already be initialized while its chapter list was never loaded.
    // Look only at exact bound identities with pending progress, not at the whole library.
    let bindings: Vec<PortableWorkBindingRow> = sqlx::query_as(
        r#"
        WITH pending AS (
            SELECT profile_id, variables_json FROM suwayomi_projection_outbox
            WHERE profile_id = ? AND operation_name = 'UpdateChaptersProgress'
              AND status IN ('pending', 'retry')
        )
        SELECT DISTINCT b.* FROM portable_work_bindings b
        JOIN pending p ON p.profile_id = b.profile_id
          AND json_extract(p.variables_json, '$.portableWorkRef.type') = 'comic'
          AND CAST(json_extract(p.variables_json, '$.portableWorkRef.sourceId') AS TEXT) = b.source_id
          AND json_extract(p.variables_json, '$.portableWorkRef.mangaKey') = b.provider_key
        WHERE b.ecosystem = 'SUWAYOMI' AND b.resolution_state = 'BOUND'
        ORDER BY b.local_reference, b.portable_id
        LIMIT ?
        "#,
    )
    .bind(&session.profile_id)
    .bind(MAX_WORK_PAGES as i64 * WORK_PAGE_SIZE)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| AppError::Internal("Failed to list comics awaiting chapter hydration.".into()))?;
    let mut expected = BTreeMap::<i64, Vec<(String, String)>>::new();
    for binding in bindings {
        let Some(local) = binding.local_reference.as_deref() else {
            continue;
        };
        let Some(id) = local
            .parse::<i64>()
            .ok()
            .filter(|id| *id > 0 && *id <= i32::MAX as i64)
        else {
            continue;
        };
        if local != id.to_string() {
            continue;
        }
        let Ok(super::models::PortableWorkRefV3::Comic {
            source_id,
            manga_key,
        }) = binding.portable_ref()
        else {
            continue;
        };
        expected.entry(id).or_default().push((source_id, manga_key));
    }
    let ids: Vec<i64> = expected.keys().copied().collect();
    for batch in ids.chunks(PENDING_WORK_BATCH_SIZE) {
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            PENDING_CHAPTER_HYDRATION_QUERY,
            json!({ "ids": batch, "first": batch.len() }),
            false,
        )
        .await?;
        for node in data
            .pointer("/mangas/nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = node.get("id").and_then(Value::as_i64) else {
                continue;
            };
            let Some(references) = expected.get(&id) else {
                continue;
            };
            if node.get("inLibrary").and_then(Value::as_bool) != Some(true)
                || node.pointer("/chapters/totalCount").and_then(Value::as_i64) != Some(0)
            {
                continue;
            }
            let source_id = match node.get("sourceId") {
                Some(Value::String(value)) => value.clone(),
                Some(Value::Number(value)) => value.to_string(),
                _ => continue,
            };
            let Some(key) = node.get("url").and_then(Value::as_str) else {
                continue;
            };
            if references
                .iter()
                .any(|(source, provider_key)| source == &source_id && provider_key == key)
            {
                works.insert(
                    id,
                    UnhydratedWork {
                        manga_id: id,
                        source_id,
                        needs_chapters: true,
                    },
                );
            }
        }
    }
    Ok(works.into_values().collect())
}

/// Chapters just became available. Keep the payload and attempts, and advance only the matching
/// profile/work's missing-chapter retries so a successful fetch does not leave them waiting hours.
async fn rearm_chapter_retries(
    state: &SharedAppState,
    profile_id: &str,
    manga_id: i64,
) -> Result<(), AppError> {
    let now = db::now_ms();
    let _writer_guard = state.mutation_gate.lock().await;
    let result = sqlx::query(
        r#"
        UPDATE suwayomi_projection_outbox AS p
        SET next_attempt_at_ms = ?, updated_at_ms = ?
        WHERE p.profile_id = ? AND p.operation_name = 'UpdateChaptersProgress'
          AND p.status = 'retry' AND p.last_error = 'portable_chapter_not_resolved'
          AND p.next_attempt_at_ms > ?
          AND json_extract(p.variables_json, '$.portableWorkRef.type') = 'comic'
          AND EXISTS (
            SELECT 1 FROM portable_work_bindings b
            WHERE b.profile_id = p.profile_id AND b.ecosystem = 'SUWAYOMI'
              AND b.resolution_state = 'BOUND' AND b.local_reference = ?
              AND b.source_id = CAST(json_extract(p.variables_json, '$.portableWorkRef.sourceId') AS TEXT)
              AND b.provider_key = json_extract(p.variables_json, '$.portableWorkRef.mangaKey')
          )
        "#,
    )
    .bind(now).bind(now).bind(profile_id).bind(now).bind(manga_id.to_string())
    .execute(&state.pool).await
    .map_err(|_| AppError::Internal("Failed to resume projections after chapter hydration.".into()))?;
    if result.rows_affected() > 0 {
        suwayomi_projection::wake_projection();
    }
    Ok(())
}

/// URLs of the work's chapters that hold any progress.
async fn chapters_with_progress(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    manga_id: i64,
) -> Result<BTreeSet<String>, AppError> {
    let mut urls = BTreeSet::new();
    for page in 0..MAX_CHAPTER_PAGES {
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            STAND_IN_CHAPTERS_QUERY,
            json!({
                "mangaId": manga_id,
                "first": CHAPTER_PAGE_SIZE,
                "offset": page as i64 * CHAPTER_PAGE_SIZE,
            }),
            false,
        )
        .await?;
        urls.extend(progress_chapter_urls(data.pointer("/chapters/nodes")));
        if data.pointer("/chapters/pageInfo/hasNextPage").and_then(Value::as_bool) != Some(true) {
            break;
        }
    }
    Ok(urls)
}

async fn carry_progress(
    state: &SharedAppState,
    profile_id: &str,
    manga_id: i64,
    chapter_keys: &BTreeSet<String>,
) -> anyhow::Result<usize> {
    let mut rows = sqlx::query_as::<_, PortableWorkBindingRow>(
        r#"
        SELECT * FROM portable_work_bindings
        WHERE profile_id = ? AND ecosystem = 'SUWAYOMI' AND local_reference = ?
          AND resolution_state = 'BOUND'
        LIMIT 2
        "#,
    )
    .bind(profile_id)
    .bind(manga_id.to_string())
    .fetch_all(&state.pool)
    .await
    .context("failed to resolve the synced work of a comic")?;
    if rows.len() != 1 {
        return Ok(0);
    }
    let Ok(work) = rows.remove(0).portable_ref() else {
        return Ok(0);
    };
    let _writer_guard = state.mutation_gate.lock().await;
    db::reproject_comic_chapter_states(&state.pool, profile_id, &work, chapter_keys).await
}

fn parse_unhydrated(nodes: Option<&Value>) -> Vec<UnhydratedWork> {
    nodes
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|node| {
            let manga_id = node
                .get("id")
                .and_then(Value::as_i64)
                .filter(|id| *id > 0 && *id <= i32::MAX as i64)?;
            let source_id = match node.get("sourceId")? {
                Value::String(text) if !text.trim().is_empty() => text.trim().to_string(),
                Value::Number(number) => number.to_string(),
                _ => return None,
            };
            Some(UnhydratedWork {
                manga_id,
                source_id,
                needs_chapters: false,
            })
        })
        .collect()
}

fn progress_chapter_urls(nodes: Option<&Value>) -> BTreeSet<String> {
    nodes
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|node| {
            node.get("isRead").and_then(Value::as_bool) == Some(true)
                || node.get("isBookmarked").and_then(Value::as_bool) == Some(true)
                || node.get("lastPageRead").and_then(Value::as_i64).unwrap_or(0) > 0
        })
        .filter_map(|node| node.get("url").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn listed_chapter_urls(chapters: Option<&Value>) -> BTreeSet<String> {
    chapters
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|chapter| chapter.get("url").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

/// The due works grouped into one queue per source, in listing order.
fn due_queues_by_source(
    works: &[UnhydratedWork],
    is_due: impl Fn(i64) -> bool,
) -> Vec<Vec<UnhydratedWork>> {
    let mut queues = BTreeMap::<&str, Vec<UnhydratedWork>>::new();
    for work in works.iter().filter(|work| is_due(work.manga_id)) {
        queues
            .entry(work.source_id.as_str())
            .or_default()
            .push(work.clone());
    }
    queues.into_values().collect()
}

/// Backoff of works whose source failed: a missing extension, a source that is down. It is stored,
/// or every restart would try them all at once, each one costing Suwayomi a source request.
#[derive(Default)]
struct RetryBook {
    /// Failures so far and when the work is due again, in Unix milliseconds.
    entries: HashMap<(String, i64), (u32, i64)>,
    dirty: bool,
}

impl RetryBook {
    async fn load(pool: &sqlx::SqlitePool, now_ms: i64) -> anyhow::Result<Self> {
        let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(
            "SELECT profile_id, manga_id, failures, next_attempt_at_ms FROM suwayomi_hydration_retries",
        )
        .fetch_all(pool)
        .await
        .context("failed to read the retries of synced comics")?;
        let latest = now_ms.saturating_add(MAX_RETRY.as_millis() as i64 * 5 / 4);
        let entries = rows
            .into_iter()
            .map(|(profile_id, manga_id, failures, due_at_ms)| {
                // A clock that was set back does not make a work wait longer than the longest wait.
                ((profile_id, manga_id), (failures.clamp(0, i64::from(u32::MAX)) as u32, due_at_ms.min(latest)))
            })
            .collect();
        Ok(Self { entries, dirty: false })
    }

    /// Replaces what is stored. The caller holds the write gate.
    async fn save(&mut self, pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
        let mut tx = db::begin_write(pool).await?;
        sqlx::query("DELETE FROM suwayomi_hydration_retries")
            .execute(&mut *tx)
            .await?;
        for ((profile_id, manga_id), (failures, due_at_ms)) in &self.entries {
            sqlx::query(
                "INSERT INTO suwayomi_hydration_retries (profile_id, manga_id, failures, next_attempt_at_ms) VALUES (?, ?, ?, ?)",
            )
            .bind(profile_id)
            .bind(manga_id)
            .bind(i64::from(*failures))
            .bind(due_at_ms)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        self.dirty = false;
        Ok(())
    }

    fn is_due(&self, profile_id: &str, manga_id: i64, now_ms: i64) -> bool {
        self.entries
            .get(&(profile_id.to_string(), manga_id))
            .is_none_or(|(_, due_at_ms)| *due_at_ms <= now_ms)
    }

    fn fail(&mut self, profile_id: &str, manga_id: i64, now_ms: i64) {
        let entry = self
            .entries
            .entry((profile_id.to_string(), manga_id))
            .or_insert((0, now_ms));
        entry.0 = entry.0.saturating_add(1);
        entry.1 = now_ms.saturating_add(spread_retry(retry_delay(entry.0), manga_id).as_millis() as i64);
        self.dirty = true;
    }

    fn clear(&mut self, profile_id: &str, manga_id: i64) {
        if self.entries.remove(&(profile_id.to_string(), manga_id)).is_some() {
            self.dirty = true;
        }
    }

    /// Forgets works that are no longer waiting.
    fn retain(&mut self, keep: impl Fn(&str, i64) -> bool) {
        let before = self.entries.len();
        self.entries
            .retain(|(profile_id, manga_id), _| keep(profile_id, *manga_id));
        self.dirty |= self.entries.len() != before;
    }
}

fn retry_delay(failures: u32) -> Duration {
    let shift = failures.saturating_sub(1).min(10);
    BASE_RETRY.saturating_mul(1 << shift).min(MAX_RETRY)
}

/// Each work waits its own 75% to 125% of the delay, so the works of a source that failed together
/// do not all try again together. Derived from the work, so it stays the same across restarts.
fn spread_retry(delay: Duration, manga_id: i64) -> Duration {
    let share = manga_id.unsigned_abs().wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 32;
    let permille = 750 + (share % 501) as u32;
    delay.saturating_mul(permille) / 1000
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syncd::models::PortableWorkRefV3;

    async fn pending_chapter_fixture(
        empty_fetch: bool,
        uninitialized: bool,
    ) -> (
        tempfile::TempDir,
        SharedAppState,
        std::sync::Arc<std::sync::atomic::AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        use crate::syncd::config::{SyncdAdvertisedEndpointResolver, SyncdConfig};
        use crate::syncd::discovery::*;
        use crate::syncd::models::{
            canonical_portable_work_id, AppState, PortableResolutionStateV3,
        };
        use std::sync::{atomic::AtomicUsize, Arc};
        use tokio::sync::{broadcast, Mutex, RwLock};

        let fetches = Arc::new(AtomicUsize::new(0));
        let counted = fetches.clone();
        let router = axum::Router::new().route("/api/graphql", axum::routing::post(
            move |axum::Json(body): axum::Json<Value>| {
                let counted = counted.clone();
                async move {
                    let query = body["query"].as_str().unwrap();
                    let data = if query.contains("EpigraphUnhydratedComics") {
                        json!({"mangas":{"nodes":if uninitialized {json!([{"id":7,"sourceId":"10"}])} else {json!([])},"pageInfo":{"hasNextPage":false}}})
                    } else if query.contains("EpigraphPendingChapterHydration") {
                        assert_eq!(body["variables"]["ids"], json!([7,8,9,10,11,12]));
                        json!({"mangas":{"nodes":[
                            {"id":7,"sourceId":"10","url":"/manga/7","inLibrary":true,"chapters":{"totalCount":0}},
                            {"id":8,"sourceId":"10","url":"/manga/8","inLibrary":true,"chapters":{"totalCount":2}},
                            {"id":9,"sourceId":"10","url":"/manga/9","inLibrary":false,"chapters":{"totalCount":0}},
                            {"id":10,"sourceId":"99","url":"/manga/10","inLibrary":true,"chapters":{"totalCount":0}},
                            {"id":11,"sourceId":"10","url":"/other/11","inLibrary":true,"chapters":{"totalCount":0}},
                            {"id":12,"sourceId":"10","url":"/manga/12","inLibrary":true}
                        ],"pageInfo":{"hasNextPage":false}}})
                    } else if query.contains("EpigraphStandInChapters") {
                        json!({"chapters":{"nodes":[],"pageInfo":{"hasNextPage":false}}})
                    } else if query.contains("EpigraphHydrateChapters") {
                        assert_eq!(body["variables"]["mangaId"], 7);
                        counted.fetch_add(1, Ordering::Relaxed);
                        json!({"fetchChapters":{"chapters":if empty_fetch {json!([])} else {json!([{"url":"/chapter/1"}])}}})
                    } else if query.contains("EpigraphHydrateManga") {
                        json!({"fetchManga":{"manga":{"id":7}}})
                    } else {
                        panic!("unexpected hydration query: {query}");
                    };
                    axum::Json(json!({"data":data}))
                }
            }
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let temp = crate::syncd::test_dir::tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        config.set_suwayomi_proxy_test_upstream("main", &endpoint);
        let pool = db::connect(&config).await.unwrap();
        let advertised_endpoint_resolver =
            SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let discovery_provider_manager =
            SyncdDiscoveryProviderManager::from_config(&config).unwrap();
        let initial_status =
            discovery_provider_manager.initial_status(&config, &advertised_endpoint_resolver);
        let state = Arc::new(AppState {
            config,
            advertised_endpoint_resolver,
            discovery_provider_manager,
            discovery_descriptor_provider: SyncdDiscoveryDescriptorProvider::default(),
            client_discovery_contract_provider: SyncdClientDiscoveryContractProvider::default(),
            client_discovery_guidance_provider: SyncdClientDiscoveryGuidanceProvider::default(),
            discovery_provider_state: Arc::new(RwLock::new(initial_status)),
            discovery_provider_runtime: Arc::new(Mutex::new(None)),
            pool,
            change_sender: broadcast::channel(128).0,
            pairing_status_sender: broadcast::channel(128).0,
            mutation_gate: Arc::new(Mutex::new(())),
            tls_cert_sha256: "test".to_string(),
            device_presence: Default::default(),
        });
        for id in 7..=13 {
            let reference = PortableWorkRefV3::Comic {
                source_id: "10".into(),
                manga_key: format!("/manga/{id}"),
            };
            db::upsert_portable_work_binding(
                &state.pool,
                "main",
                &canonical_portable_work_id(&reference),
                &reference,
                None,
                Some(&id.to_string()),
                PortableResolutionStateV3::Bound,
                None,
                None,
                None,
                1,
                1,
            )
            .await
            .unwrap();
            let variables = json!({"portableWorkRef":reference,"portableChapterRef":{"type":"comic","work":reference,"chapterKey":"/chapter/1"},"isRead":true,"lastPageRead":9});
            sqlx::query("INSERT INTO suwayomi_projection_outbox (operation_id,profile_id,operation_name,variables_json,entity_type,entity_id,source_server_version,status,attempt_count,next_attempt_at_ms,last_error,created_at_ms,updated_at_ms) VALUES (?,'main','UpdateChaptersProgress',?,'comic.chapter_state',?,1,'retry',75,?,'portable_chapter_not_resolved',1,1)")
                .bind(format!("pending-{id}")).bind(variables.to_string()).bind(format!("chapter-{id}")).bind(db::now_ms()+21_600_000).execute(&state.pool).await.unwrap();
        }
        sqlx::query("UPDATE portable_work_bindings SET local_reference='not-a-number' WHERE provider_key='/manga/13'").execute(&state.pool).await.unwrap();
        for (id, profile, status, variables) in [
            ("in-flight", "main", "in_flight", None),
            ("other-profile", "other", "retry", None),
            ("malformed", "main", "retry", Some("{}")),
        ] {
            sqlx::query("INSERT INTO suwayomi_projection_outbox (operation_id,profile_id,operation_name,variables_json,entity_type,entity_id,source_server_version,status,attempt_count,next_attempt_at_ms,last_error,created_at_ms,updated_at_ms) SELECT ?,?,operation_name,COALESCE(?,variables_json),entity_type,entity_id,source_server_version,?,attempt_count,next_attempt_at_ms,last_error,created_at_ms,updated_at_ms FROM suwayomi_projection_outbox WHERE operation_id='pending-7'")
                .bind(id).bind(profile).bind(variables).bind(status).execute(&state.pool).await.unwrap();
        }
        (temp, state, fetches, server)
    }

    #[tokio::test]
    async fn initialized_work_with_pending_chapters_is_hydrated_and_retries_wake() {
        let (_temp, state, fetches, server) = pending_chapter_fixture(false, false).await;
        let original: String = sqlx::query_scalar(
            "SELECT variables_json FROM suwayomi_projection_outbox WHERE operation_id='pending-7'",
        )
        .fetch_one(&state.pool)
        .await
        .unwrap();
        let mut retries = RetryBook::default();
        hydrate_profiles(&state, &mut retries).await.unwrap();
        server.abort();
        assert_eq!(
            fetches.load(Ordering::Relaxed),
            1,
            "initialized works with pending progress still need their chapters"
        );
        let (payload,attempts,due):(String,i64,i64)=sqlx::query_as("SELECT variables_json,attempt_count,next_attempt_at_ms FROM suwayomi_projection_outbox WHERE operation_id='pending-7'").fetch_one(&state.pool).await.unwrap();
        assert_eq!((payload, attempts), (original, 75));
        assert!(due <= db::now_ms());
        let others:Vec<i64>=sqlx::query_scalar("SELECT next_attempt_at_ms FROM suwayomi_projection_outbox WHERE operation_id<>'pending-7'").fetch_all(&state.pool).await.unwrap();
        assert!(others.iter().all(|due| *due > db::now_ms()));
    }

    #[tokio::test]
    async fn initialized_work_with_empty_chapter_fetch_keeps_durable_backoff() {
        let (_temp, state, fetches, server) = pending_chapter_fixture(true, true).await;
        let mut retries = RetryBook::default();
        hydrate_profiles(&state, &mut retries).await.unwrap();
        assert_eq!(fetches.load(Ordering::Relaxed), 1);
        let mut restarted = RetryBook::load(&state.pool, db::now_ms()).await.unwrap();
        assert!(!restarted.is_due("main", 7, db::now_ms()));
        hydrate_profiles(&state, &mut restarted).await.unwrap();
        server.abort();
        assert_eq!(
            fetches.load(Ordering::Relaxed),
            1,
            "empty responses must not restart fetching every tick"
        );
    }

    fn work(manga_id: i64, source_id: &str) -> UnhydratedWork {
        UnhydratedWork {
            manga_id,
            source_id: source_id.to_string(),
            needs_chapters: false,
        }
    }

    #[test]
    fn parses_listed_works_and_skips_bad_nodes() {
        let nodes = json!([
            { "id": 1, "sourceId": "2499283573021220255" },
            { "id": 2, "sourceId": 7 },
            { "id": 0, "sourceId": "1" },
            { "id": 3 },
            { "id": 4, "sourceId": " " },
        ]);
        assert_eq!(
            parse_unhydrated(Some(&nodes)),
            [work(1, "2499283573021220255"), work(2, "7")]
        );
        assert!(parse_unhydrated(None).is_empty());
    }

    #[test]
    fn queues_one_source_at_a_time_and_skips_works_backing_off() {
        let works = [work(1, "a"), work(2, "b"), work(3, "a"), work(4, "a")];
        assert_eq!(
            due_queues_by_source(&works, |id| id != 3),
            [vec![work(1, "a"), work(4, "a")], vec![work(2, "b")]]
        );
        assert!(due_queues_by_source(&works, |_| false).is_empty());
    }

    #[test]
    fn only_chapters_with_progress_are_stand_ins_to_follow() {
        let nodes = json!([
            { "url": "/c/1", "isRead": true, "isBookmarked": false, "lastPageRead": 0 },
            { "url": "/c/2", "isRead": false, "isBookmarked": true, "lastPageRead": 0 },
            { "url": "/c/3", "isRead": false, "isBookmarked": false, "lastPageRead": 4 },
            { "url": "/c/4", "isRead": false, "isBookmarked": false, "lastPageRead": 0 },
        ]);
        assert_eq!(
            progress_chapter_urls(Some(&nodes)),
            BTreeSet::from(["/c/1".to_string(), "/c/2".to_string(), "/c/3".to_string()])
        );
        let listed = listed_chapter_urls(Some(&json!([{ "url": "/c/1" }, { "url": "/c/9" }])));
        assert_eq!(listed, BTreeSet::from(["/c/1".to_string(), "/c/9".to_string()]));
    }

    #[test]
    fn failed_works_back_off_exponentially_up_to_a_cap() {
        assert_eq!(retry_delay(1), BASE_RETRY);
        assert_eq!(retry_delay(2), BASE_RETRY * 2);
        assert_eq!(retry_delay(3), BASE_RETRY * 4);
        assert_eq!(retry_delay(50), MAX_RETRY);

        let now = 1_000_000;
        let longest_first_wait = BASE_RETRY.as_millis() as i64 * 5 / 4;
        let mut book = RetryBook::default();
        assert!(book.is_due("p", 1, now));
        book.fail("p", 1, now);
        assert!(!book.is_due("p", 1, now));
        assert!(book.is_due("p", 1, now + longest_first_wait));
        assert!(book.is_due("other", 1, now));
        book.fail("p", 1, now);
        book.fail("p", 1, now);
        assert!(!book.is_due("p", 1, now + longest_first_wait));
        book.clear("p", 1);
        assert!(book.is_due("p", 1, now));

        book.fail("p", 2, now);
        book.fail("p", 3, now);
        book.retain(|_, manga_id| manga_id == 3);
        assert!(book.is_due("p", 2, now));
        assert!(!book.is_due("p", 3, now));
    }

    #[test]
    fn works_that_failed_together_try_again_apart() {
        let now = 1_000_000;
        let mut book = RetryBook::default();
        for manga_id in 1..=200 {
            book.fail("p", manga_id, now);
        }
        let base_retry = BASE_RETRY.as_millis() as i64;
        let mut due_at = book
            .entries
            .values()
            .map(|(_, due_at_ms)| *due_at_ms - now)
            .collect::<Vec<_>>();
        due_at.sort_unstable();
        assert!(due_at.first().is_some_and(|wait| *wait >= base_retry * 3 / 4));
        assert!(due_at.last().is_some_and(|wait| *wait <= base_retry * 5 / 4));
        // Spread over the range, with no 5 s window holding more than a tenth of them.
        assert!(due_at.last().unwrap() - due_at.first().unwrap() > base_retry * 2 / 5);
        let crowded = due_at
            .iter()
            .map(|start| due_at.iter().filter(|wait| (*start..*start + 5_000).contains(wait)).count())
            .max()
            .unwrap();
        assert!(crowded <= 40, "{crowded} of 200 in one 5 s window");

        assert_eq!(
            spread_retry(MAX_RETRY, 42),
            spread_retry(MAX_RETRY, 42),
            "a work keeps its share across restarts"
        );
    }

    #[tokio::test]
    async fn the_wait_of_failed_works_survives_a_restart() {
        let temp = crate::syncd::test_dir::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        let now = 1_000_000;
        let base_retry = BASE_RETRY.as_millis() as i64 * 5 / 4;

        let mut book = RetryBook::load(&pool, now).await.unwrap();
        assert!(book.is_due("p", 1, now));
        assert!(!book.dirty);
        book.fail("p", 1, now);
        book.fail("p", 2, now);
        book.fail("p", 2, now);
        book.save(&pool).await.unwrap();
        assert!(!book.dirty);

        let mut restarted = RetryBook::load(&pool, now + 1).await.unwrap();
        assert!(!restarted.is_due("p", 1, now + 1));
        assert!(restarted.is_due("p", 1, now + base_retry));
        assert!(!restarted.is_due("p", 2, now + base_retry), "its failures were kept");
        assert!(restarted.is_due("p", 3, now + 1));

        // Works that stopped waiting are gone from what is stored, too.
        restarted.clear("p", 1);
        assert!(restarted.dirty);
        restarted.save(&pool).await.unwrap();
        let again = RetryBook::load(&pool, now + 1).await.unwrap();
        assert!(again.is_due("p", 1, now + 1));
        assert!(!again.is_due("p", 2, now + 1));

        // A clock that was set back does not make a work wait longer than the longest wait.
        let earlier = now - 86_400_000;
        let set_back = RetryBook::load(&pool, earlier).await.unwrap();
        assert!(set_back.is_due("p", 2, earlier + MAX_RETRY.as_millis() as i64 * 5 / 4));
    }

    #[tokio::test]
    async fn replaced_chapters_have_their_stored_progress_projected_again() {
        let temp = crate::syncd::test_dir::tempdir().unwrap();
        let config = crate::syncd::config::SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = db::connect(&config).await.unwrap();
        let work = PortableWorkRefV3::Comic {
            source_id: "2499283573021220255".to_string(),
            manga_key: "/manga/a".to_string(),
        };
        let other = PortableWorkRefV3::Comic {
            source_id: "2499283573021220255".to_string(),
            manga_key: "/manga/a-side".to_string(),
        };
        for (entity_id, chapter_work, chapter_key, version) in [
            ("ch-1", &work, "https://old.example/manga/a/1", 11),
            ("ch-2", &work, "https://old.example/manga/a/2", 12),
            ("ch-3", &other, "https://old.example/manga/a/1", 13),
        ] {
            let record = json!({
                "comicId": "comic",
                "chapterId": entity_id,
                "portableWorkRef": chapter_work,
                "portableChapterRef": { "type": "comic", "work": chapter_work, "chapterKey": chapter_key },
                "read": true,
                "bookmarked": false,
                "lastPageRead": 3,
            });
            sqlx::query(
                r#"
                INSERT INTO comic_sync_state (
                    scope_id, entity_type, entity_id, record_json, record_updated_at_ms,
                    record_updated_by_device_id, record_lamport, record_server_version
                ) VALUES ('comics:profile:p', 'comic.chapter_state', ?, ?, 1, 'phone', 1, ?)
                "#,
            )
            .bind(entity_id)
            .bind(record.to_string())
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
        }

        let keys = BTreeSet::from(["https://old.example/manga/a/1".to_string()]);
        assert_eq!(
            db::reproject_comic_chapter_states(&pool, "p", &work, &keys).await.unwrap(),
            1
        );
        // Idempotent: the same record is queued once.
        db::reproject_comic_chapter_states(&pool, "p", &work, &keys).await.unwrap();
        let rows: Vec<(String, String, String, i64)> = sqlx::query_as(
            "SELECT entity_id, operation_name, variables_json, source_server_version FROM suwayomi_projection_outbox",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        let (entity_id, operation_name, variables_json, version) = &rows[0];
        assert_eq!(entity_id, "ch-1");
        assert_eq!(operation_name, "UpdateChaptersProgress");
        assert_eq!(*version, 11);
        let variables: Value = serde_json::from_str(variables_json).unwrap();
        assert_eq!(variables["portableChapterRef"]["chapterKey"], json!("https://old.example/manga/a/1"));
        assert_eq!(variables["isRead"], json!(true));
        assert_eq!(variables["lastPageRead"], json!(3));

        assert_eq!(
            db::reproject_comic_chapter_states(&pool, "p", &work, &BTreeSet::new()).await.unwrap(),
            0
        );
    }
}
