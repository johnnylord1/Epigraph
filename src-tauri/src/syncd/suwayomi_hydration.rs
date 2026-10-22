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
use std::time::{Duration, Instant};

use anyhow::Context;
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};

use super::lifecycle::{wait_for_shutdown_request, ShutdownRequest};
use super::models::{AppError, AuthenticatedSession, PortableWorkBindingRow, SharedAppState};
use super::routes::suwayomi_catalog;
use super::{db, suwayomi_projection};

/// Sources fetched at once, one work at a time each, as Mihon's library update does: sources keep
/// their own rate limits, so a library on a single source is not hammered.
const MAX_PARALLEL_SOURCES: usize = 5;
const PASS_INTERVAL: Duration = Duration::from_secs(15);
const BASE_RETRY: Duration = Duration::from_secs(60);
const MAX_RETRY: Duration = Duration::from_secs(30 * 60);
const WORK_PAGE_SIZE: i64 = 500;
const MAX_WORK_PAGES: usize = 40;
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
        let mut retries = RetryBook::default();
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
        listed.iter().any(|(session, works)| {
            session.profile_id == profile_id && works.iter().any(|work| work.manga_id == manga_id)
        })
    });

    for (session, works) in &listed {
        let now = Instant::now();
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
                    hydrated += 1;
                }
                Outcome::Failed => retries.fail(&session.profile_id, manga_id, Instant::now()),
                Outcome::RuntimeUnavailable => {}
            }
        }
        if hydrated > 0 {
            tracing::info!(profile = session.profile_id, hydrated, "completed synced comics from their sources");
        }
    }
    Ok(())
}

/// One source's works, in order. Stops when the runtime goes away, leaving the rest due.
async fn hydrate_queue(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    queue: Vec<i64>,
) -> Vec<(i64, Outcome)> {
    let mut outcomes = Vec::with_capacity(queue.len());
    for manga_id in queue {
        let outcome = match hydrate_work(state, session, manga_id).await {
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
) -> Result<(), AppError> {
    let stand_ins = chapters_with_progress(state, session, manga_id).await?;
    let fetched = suwayomi_catalog::execute_graphql_document(
        state,
        session,
        FETCH_CHAPTERS_MUTATION,
        json!({ "mangaId": manga_id }),
        true,
    )
    .await?;
    let listed = listed_chapter_urls(fetched.pointer("/fetchChapters/chapters"));
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
            Err(error) => tracing::warn!(error = %error, manga_id, "failed to carry progress to replaced chapters"),
        }
    }
    suwayomi_catalog::execute_graphql_document(
        state,
        session,
        FETCH_MANGA_MUTATION,
        json!({ "id": manga_id }),
        true,
    )
    .await?;
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
    let mut works = Vec::new();
    for page in 0..MAX_WORK_PAGES {
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            UNHYDRATED_COMICS_QUERY,
            json!({ "first": WORK_PAGE_SIZE, "offset": page as i64 * WORK_PAGE_SIZE }),
            false,
        )
        .await?;
        works.extend(parse_unhydrated(data.pointer("/mangas/nodes")));
        if data.pointer("/mangas/pageInfo/hasNextPage").and_then(Value::as_bool) != Some(true) {
            break;
        }
    }
    Ok(works)
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
) -> Vec<Vec<i64>> {
    let mut queues = BTreeMap::<&str, Vec<i64>>::new();
    for work in works.iter().filter(|work| is_due(work.manga_id)) {
        queues
            .entry(work.source_id.as_str())
            .or_default()
            .push(work.manga_id);
    }
    queues.into_values().collect()
}

/// Backoff of works whose source failed: a missing extension, a source that is down. It lives in
/// memory, since the work's own `initialized: false` already survives restarts.
#[derive(Default)]
struct RetryBook {
    entries: HashMap<(String, i64), (u32, Instant)>,
}

impl RetryBook {
    fn is_due(&self, profile_id: &str, manga_id: i64, now: Instant) -> bool {
        self.entries
            .get(&(profile_id.to_string(), manga_id))
            .is_none_or(|(_, due_at)| *due_at <= now)
    }

    fn fail(&mut self, profile_id: &str, manga_id: i64, now: Instant) {
        let entry = self
            .entries
            .entry((profile_id.to_string(), manga_id))
            .or_insert((0, now));
        entry.0 = entry.0.saturating_add(1);
        entry.1 = now + retry_delay(entry.0);
    }

    fn clear(&mut self, profile_id: &str, manga_id: i64) {
        self.entries.remove(&(profile_id.to_string(), manga_id));
    }

    /// Forgets works that are no longer waiting.
    fn retain(&mut self, keep: impl Fn(&str, i64) -> bool) {
        self.entries
            .retain(|(profile_id, manga_id), _| keep(profile_id, *manga_id));
    }
}

fn retry_delay(failures: u32) -> Duration {
    let shift = failures.saturating_sub(1).min(10);
    BASE_RETRY.saturating_mul(1 << shift).min(MAX_RETRY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syncd::models::PortableWorkRefV3;

    fn work(manga_id: i64, source_id: &str) -> UnhydratedWork {
        UnhydratedWork {
            manga_id,
            source_id: source_id.to_string(),
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
            [vec![1, 4], vec![2]]
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

        let now = Instant::now();
        let mut book = RetryBook::default();
        assert!(book.is_due("p", 1, now));
        book.fail("p", 1, now);
        assert!(!book.is_due("p", 1, now));
        assert!(book.is_due("p", 1, now + BASE_RETRY));
        assert!(book.is_due("other", 1, now));
        book.fail("p", 1, now);
        assert!(!book.is_due("p", 1, now + BASE_RETRY));
        book.clear("p", 1);
        assert!(book.is_due("p", 1, now));

        book.fail("p", 2, now);
        book.fail("p", 3, now);
        book.retain(|_, manga_id| manga_id == 3);
        assert!(book.is_due("p", 2, now));
        assert!(!book.is_due("p", 3, now));
    }

    #[tokio::test]
    async fn replaced_chapters_have_their_stored_progress_projected_again() {
        let temp = tempfile::tempdir().unwrap();
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
