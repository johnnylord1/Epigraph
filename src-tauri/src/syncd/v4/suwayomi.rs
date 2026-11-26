//! Converts portable comic state to the same Mihon backup format supported by Suwayomi.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{ensure, Context};
use serde_json::{json, Value};
use tokio::sync::{watch, Notify};

use super::{
    db,
    db::V4WireRecord,
    hlc::{canonical_chapter_key, canonical_work_key},
    V4LiveEvent, V4LiveEventKind, V4Runtime,
};
use crate::syncd::lifecycle::{wait_for_shutdown_request, ShutdownRequest};
use crate::syncd::models::{AuthenticatedSession, SharedAppState};
use crate::syncd::routes::suwayomi_commands::{self, CommandOperation};
use crate::syncd::routes::suwayomi_import::{
    restore_backup_confirmed, ImportCategory, ImportChapter, ImportTracking, ImportWork,
};
use crate::syncd::landed_works;
use crate::syncd::routes::{suwayomi_catalog, suwayomi_proxy};

/// Comic batches Suwayomi confirmed since Core started; the desktop window watches it move.
static APPLIED_PROJECTIONS: AtomicU64 = AtomicU64::new(0);

pub fn applied_projection_count() -> u64 {
    APPLIED_PROJECTIONS.load(Ordering::Relaxed)
}

const WORK_PAGE_SIZE: usize = 500;
const CHAPTER_PAGE_SIZE: usize = 2_000;
const COMIC_PROJECTION_TOKEN: &str = "epigraph-v4-comics-projection";
const LOCAL_DESKTOP_ORIGIN: &str = "epigraph-desktop";
/// How long a catalog capture waits for remote comic records to reach Suwayomi.
const CATALOG_PROJECTION_WAIT: Duration = Duration::from_secs(30);
const CATALOG_PROJECTION_POLL: Duration = Duration::from_millis(200);
/// Snapshots retried when another device commits between the snapshot and the write gate.
const CATALOG_CAPTURE_ATTEMPTS: usize = 3;

pub(in crate::syncd) async fn capture_local_edits(
    state: &SharedAppState,
    runtime: &V4Runtime,
    profile: &str,
    work_ids: Vec<i64>,
    chapter_ids: Vec<i64>,
    catalog: bool,
) -> anyhow::Result<()> {
    capture_local_edits_with_wait(
        state,
        runtime,
        profile,
        work_ids,
        chapter_ids,
        catalog,
        CATALOG_PROJECTION_WAIT,
    )
    .await
}

pub(super) async fn capture_local_edits_with_wait(
    state: &SharedAppState,
    runtime: &V4Runtime,
    profile: &str,
    work_ids: Vec<i64>,
    chapter_ids: Vec<i64>,
    catalog: bool,
    projection_wait: Duration,
) -> anyhow::Result<()> {
    // Only project local edits onto V4 profiles after that protocol has initialized.
    if db::load_watermark(&state.pool, profile).await?.current_seq == 0 {
        return Ok(());
    }
    let session = AuthenticatedSession {
        profile_id: profile.to_owned(),
        token_id: COMIC_PROJECTION_TOKEN.to_owned(),
        device_id: LOCAL_DESKTOP_ORIGIN.to_owned(),
        scopes: BTreeSet::from([format!("comics:profile:{profile}")]),
        mutation_receipt: None,
    };
    let work_query = r#"
      query EpigraphV4EditedWorks($ids: [Int!]!, $first: Int!, $offset: Int!) {
        mangas(filter: { id: { in: $ids } }, first: $first, offset: $offset) {
          nodes { sourceId url title inLibrary }
          pageInfo { hasNextPage }
        }
      }
    "#;
    let chapter_query = r#"
      query EpigraphV4EditedChapters($ids: [Int!]!, $first: Int!, $offset: Int!) {
        chapters(filter: { id: { in: $ids } }, first: $first, offset: $offset) {
          nodes { url name chapterNumber scanlator isRead isBookmarked lastPageRead
                  manga { sourceId url title inLibrary } }
          pageInfo { hasNextPage }
        }
      }
    "#;
    let mut updates = Vec::new();
    let mut parents = BTreeMap::new();
    let mut explicitly_changed_works = BTreeSet::new();
    if !work_ids.is_empty() {
        let works = read_nodes(
            state,
            &session,
            work_query,
            "mangas",
            500,
            json!({"ids":work_ids}),
        )
        .await?;
        for work in works {
            if let Some((key, payload)) = capture_work(&work) {
                explicitly_changed_works.insert(key.clone());
                parents.insert(key, payload);
            }
        }
    }
    // A chapter moved back on the desktop may reset progress other devices made only if this
    // Suwayomi read already showed every stored comic record; see `stamp_desktop_reset`.
    let reset_baseline = if chapter_ids.is_empty() {
        None
    } else {
        Some(load_projection_progress(&state.pool, profile).await?)
    };
    if !chapter_ids.is_empty() {
        let chapters = read_nodes(
            state,
            &session,
            chapter_query,
            "chapters",
            500,
            json!({"ids":chapter_ids}),
        )
        .await?;
        for chapter in chapters {
            let Some((work, payload)) = capture_work(&chapter["manga"]) else {
                continue;
            };
            if payload["favorite"] != true {
                continue;
            }
            let Some(url) = chapter["url"].as_str() else {
                continue;
            };
            updates.push(("comic.chapter", canonical_chapter_key(&work, url), json!({
                "workKey": work, "url": url, "name": chapter["name"], "chapterNumber": chapter["chapterNumber"],
                "scanlator": chapter["scanlator"], "isRead": chapter["isRead"], "isBookmarked": chapter["isBookmarked"],
                "lastPageRead": chapter["lastPageRead"],
            })));
            parents.entry(work).or_insert(payload);
        }
    }
    // The catalog diff tombstones what Suwayomi lacks and re-sends what differs, so it may only
    // read a Suwayomi that already shows every stored comic record. Otherwise a phone's category
    // change that is still waiting for projection would be undone for every device.
    let mut catalog_guard = None;
    let mut catalog_snapshot = None;
    let capture_started = Instant::now();
    if catalog {
        let categories_query = COMIC_CATEGORY_MEMBERSHIP_QUERY;
        let library_query = COMIC_LIBRARY_QUERY;
        for _ in 0..CATALOG_CAPTURE_ATTEMPTS {
            let Some(before) =
                wait_for_settled_projection(&state.pool, profile, projection_wait).await?
            else {
                break;
            };
            let categories = read_nodes(
                state,
                &session,
                categories_query,
                "categories",
                500,
                json!({}),
            )
            .await?;
            let library_works =
                read_nodes(state, &session, library_query, "mangas", 500, json!({})).await?;
            let guard = runtime.write_gate.lock().await;
            let after = load_projection_progress(&state.pool, profile).await?;
            if catalog_snapshot_is_current(before, after) {
                catalog_guard = Some(guard);
                catalog_snapshot = Some((categories, library_works));
                break;
            }
        }
        if catalog_snapshot.is_none() {
            // Retried by the projection loop once Suwayomi caught up; dropping it would leave a
            // desktop folder move or removal out of Core until the next unrelated desktop edit.
            runtime
                .comic_baseline
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .defer_catalog(profile, Instant::now());
            tracing::warn!(
                %profile,
                "V4 desktop category capture deferred: remote comic changes are still reaching Suwayomi"
            );
        }
    }
    let catalog_captured = catalog_snapshot.is_some();
    if updates.is_empty() && parents.is_empty() && catalog_snapshot.is_none() {
        return Ok(());
    }
    let _guard = match catalog_guard {
        Some(guard) => guard,
        None => runtime.write_gate.lock().await,
    };
    let now = crate::syncd::db::now_ms();
    let watermark = db::load_watermark(&state.pool, profile).await?;
    let mut items = Vec::new();
    let known = sqlx::query_scalar::<_, String>(
        "SELECT entity_key FROM v4_records WHERE profile_id = ? AND entity_type = 'comic.work'",
    )
    .bind(profile)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .collect::<BTreeSet<_>>();
    for (key, payload) in parents {
        if !explicitly_changed_works.contains(&key) && known.contains(&key) {
            continue;
        }
        let deleted = payload["favorite"] == false;
        items.push(("comic.work", key, payload, deleted));
    }
    let mut stored_chapters = BTreeMap::new();
    if let Some(before) = reset_baseline {
        if catalog_snapshot_is_current(
            before,
            load_projection_progress(&state.pool, profile).await?,
        ) {
            for (entity_type, key, _) in &updates {
                if *entity_type != "comic.chapter" {
                    continue;
                }
                let stored = sqlx::query_scalar::<_, String>(
                    "SELECT payload_json FROM v4_records
                     WHERE profile_id = ? AND entity_type = 'comic.chapter' AND entity_key = ? AND deleted = 0",
                )
                .bind(profile)
                .bind(key)
                .fetch_optional(&state.pool)
                .await?;
                if let Some(stored) = stored.and_then(|json| serde_json::from_str(&json).ok()) {
                    stored_chapters.insert(key.clone(), stored);
                }
            }
        }
    }
    for (entity_type, key, payload) in updates {
        items.push((entity_type, key, payload, false));
    }
    if let Some((categories, library_works)) = catalog_snapshot {
        let existing_categories: Vec<(String, String)> = sqlx::query_as(
            "SELECT entity_key, payload_json FROM v4_records WHERE profile_id = ? AND entity_type = 'comic.category' AND deleted = 0",
        )
        .bind(profile)
        .fetch_all(&state.pool)
        .await?;
        let existing_assignments: Vec<(String, String)> = sqlx::query_as(
            "SELECT entity_key, payload_json FROM v4_records WHERE profile_id = ? AND entity_type = 'comic.category_assignment' AND deleted = 0",
        )
        .bind(profile)
        .fetch_all(&state.pool)
        .await?;
        items.extend(plan_catalog_category_edits(
            &categories,
            &library_works,
            &existing_categories,
            &existing_assignments,
            &known,
        ));
    }
    if items.is_empty() {
        if catalog_captured {
            runtime
                .comic_baseline
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .catalog_done(profile, capture_started);
        }
        return Ok(());
    }
    let items = items
        .into_iter()
        .enumerate()
        .map(|(index, (entity_type, entity_key, mut payload, deleted))| {
            let hlc = super::hlc::Hlc::new(
                now,
                watermark.current_seq.saturating_add(index as i64),
                LOCAL_DESKTOP_ORIGIN,
            );
            if let Some(stored) = stored_chapters.get(&entity_key) {
                stamp_desktop_reset(&mut payload, stored, &hlc);
            }
            db::V4IncomingItem {
                client_mutation_id: None,
                domain: "comics".to_owned(),
                entity_type: entity_type.to_owned(),
                entity_key,
                deleted,
                hlc,
                payload,
            }
        })
        .collect();
    let summary =
        db::apply_v4_batch(&state.pool, profile, LOCAL_DESKTOP_ORIGIN, items, true).await?;
    for record in summary.committed_records {
        let _ = runtime.live_sender.send(V4LiveEvent {
            profile_id: profile.to_owned(),
            origin_device_id: LOCAL_DESKTOP_ORIGIN.to_owned(),
            server_seq: record.server_seq,
            kind: V4LiveEventKind::Delta(record),
        });
    }
    wake_projection();
    if catalog_captured {
        runtime
            .comic_baseline
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .catalog_done(profile, capture_started);
    }
    Ok(())
}

/// Marks a desktop chapter edit that moved the chapter back (unread, or an earlier page) as an
/// explicit reset, as the phone does. Without one the merge keeps the furthest progress any device
/// reported and the desktop edit is lost. The reset sits one tick before the edit itself, so the
/// merge drops every older progress but keeps the page the desktop now shows.
///
/// `stored` must come from a Core whose records Suwayomi already showed when it was read; a
/// remote read that had not reached Suwayomi yet would otherwise look like a desktop rewind.
fn stamp_desktop_reset(payload: &mut Value, stored: &Value, hlc: &super::hlc::Hlc) {
    let page = |record: &Value| record["lastPageRead"].as_i64().unwrap_or(0);
    let unread = payload["isRead"] == false && stored["isRead"] == true;
    let rewound = payload["lastPageRead"].is_i64() && page(payload) < page(stored);
    if !(unread || rewound) || hlc.counter == 0 {
        return;
    }
    let reset = super::hlc::Hlc::new(hlc.ts_ms, hlc.counter - 1, hlc.device_id.clone());
    if let (Some(object), Ok(reset)) = (payload.as_object_mut(), serde_json::to_value(reset)) {
        object.insert("explicitResetHlc".to_owned(), reset);
    }
}

/// The comic projection cursor of a profile: Suwayomi shows every record up to `applied`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProjectionProgress {
    applied: i64,
    target: i64,
}

impl ProjectionProgress {
    fn settled(progress: Option<Self>) -> bool {
        progress.is_none_or(|progress| progress.applied >= progress.target)
    }
}

async fn load_projection_progress(
    pool: &sqlx::SqlitePool,
    profile: &str,
) -> anyhow::Result<Option<ProjectionProgress>> {
    let row: Option<(i64, i64)> = sqlx::query_as(
        "SELECT applied_seq, target_seq FROM v4_comics_projection WHERE profile_id = ?",
    )
    .bind(profile)
    .fetch_optional(pool)
    .await
    .context("failed to read the V4 comic projection cursor")?;
    Ok(row.map(|(applied, target)| ProjectionProgress { applied, target }))
}

/// Waits until Suwayomi shows every stored comic record of the profile. Returns the settled
/// cursor (`None` inside when the profile never projected), or `None` when the wait ran out.
async fn wait_for_settled_projection(
    pool: &sqlx::SqlitePool,
    profile: &str,
    timeout: Duration,
) -> anyhow::Result<Option<Option<ProjectionProgress>>> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let progress = load_projection_progress(pool, profile).await?;
        if ProjectionProgress::settled(progress) {
            return Ok(Some(progress));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(None);
        }
        wake_projection();
        tokio::time::sleep(CATALOG_PROJECTION_POLL.min(timeout)).await;
    }
}

/// A snapshot read after `before` is complete only if nothing new was committed for the
/// profile before the write gate was taken and the projection is still settled.
fn catalog_snapshot_is_current(
    before: Option<ProjectionProgress>,
    after: Option<ProjectionProgress>,
) -> bool {
    before == after && ProjectionProgress::settled(after)
}

fn is_reserved_category_name(name: &str) -> bool {
    let normalized = name.trim();
    normalized.eq_ignore_ascii_case("default") || normalized.eq_ignore_ascii_case("completed")
}

fn plan_catalog_category_edits(
    categories: &[Value],
    library_works: &[Value],
    existing_categories: &[(String, String)],
    existing_assignments: &[(String, String)],
    known_works: &BTreeSet<String>,
) -> Vec<(&'static str, String, Value, bool)> {
    let mut live_library_works = BTreeSet::new();
    let mut missing_parent_works = BTreeMap::new();
    // Every library work is published, including works only in Default or Completed, which
    // belong to no shared category.
    for work in library_works {
        let Some((work_key, source, url)) = comic_identity(work) else {
            continue;
        };
        if !known_works.contains(&work_key) {
            missing_parent_works
                .entry(work_key.clone())
                .or_insert_with(|| missing_work_payload(&source, url, &work["title"]));
        }
        live_library_works.insert(work_key);
    }

    let mut live_categories = BTreeMap::new();
    let mut live_assignments = BTreeMap::new();
    for category in categories {
        if category["id"].as_i64() == Some(0) {
            continue;
        }
        let Some(raw_name) = category["name"].as_str() else {
            continue;
        };
        if is_reserved_category_name(raw_name) {
            continue;
        }
        let trimmed_name = raw_name.trim();
        let category_key = trimmed_name.to_lowercase();
        let order = category["order"].as_i64().unwrap_or(0);
        live_categories.insert(
            category_key.clone(),
            json!({
                "name": trimmed_name,
                "order": order,
                "flags": 0,
            }),
        );
        if let Some(mangas) = category["mangas"]["nodes"].as_array() {
            for manga in mangas {
                if manga["inLibrary"].as_bool() == Some(false) {
                    continue;
                }
                let Some(source) = scalar_text(&manga["sourceId"]) else {
                    continue;
                };
                if source == "0" {
                    continue;
                }
                let Some(url) = manga["url"].as_str() else {
                    continue;
                };
                let work_key = canonical_work_key(&source, url);
                live_library_works.insert(work_key.clone());
                if !known_works.contains(&work_key) {
                    missing_parent_works
                        .entry(work_key.clone())
                        .or_insert_with(|| missing_work_payload(&source, url, &manga["title"]));
                }
                let assignment_key = format!("{work_key}|{category_key}");
                live_assignments.insert(
                    assignment_key,
                    json!({
                        "workKey": work_key,
                        "categoryKey": category_key,
                    }),
                );
            }
        }
    }

    let existing_cat_map: HashMap<&str, Value> = existing_categories
        .iter()
        .filter_map(|(key, payload_json)| {
            serde_json::from_str::<Value>(payload_json)
                .ok()
                .map(|payload| (key.as_str(), payload))
        })
        .collect();
    let existing_assign_map: HashMap<&str, Value> = existing_assignments
        .iter()
        .filter_map(|(key, payload_json)| {
            serde_json::from_str::<Value>(payload_json)
                .ok()
                .map(|payload| (key.as_str(), payload))
        })
        .collect();

    let mut out = Vec::new();
    for (key, payload) in missing_parent_works {
        out.push(("comic.work", key, payload, false));
    }
    for (key, payload) in &live_categories {
        let unchanged = existing_cat_map.get(key.as_str()).is_some_and(|prev| {
            prev["name"].as_str() == payload["name"].as_str()
                && prev["order"].as_i64() == payload["order"].as_i64()
        });
        if !unchanged {
            out.push(("comic.category", key.clone(), payload.clone(), false));
        }
    }
    for (key, prev) in &existing_cat_map {
        if live_categories.contains_key(*key) {
            continue;
        }
        let prev_name = prev["name"].as_str().unwrap_or(*key);
        if is_reserved_category_name(prev_name) || is_reserved_category_name(key) {
            continue;
        }
        out.push(("comic.category", (*key).to_owned(), json!({}), true));
    }

    for (key, payload) in &live_assignments {
        if !existing_assign_map.contains_key(key.as_str()) {
            out.push((
                "comic.category_assignment",
                key.clone(),
                payload.clone(),
                false,
            ));
        }
    }
    for (key, prev) in &existing_assign_map {
        if live_assignments.contains_key(*key) {
            continue;
        }
        let work_key = prev["workKey"]
            .as_str()
            .or_else(|| key.split('|').next())
            .unwrap_or_default();
        let category_key = prev["categoryKey"]
            .as_str()
            .or_else(|| key.split('|').nth(1))
            .unwrap_or_default();
        if work_key.is_empty()
            || category_key.is_empty()
            || is_reserved_category_name(category_key)
            || !live_library_works.contains(work_key)
        {
            continue;
        }
        out.push((
            "comic.category_assignment",
            (*key).to_owned(),
            json!({
                "workKey": work_key,
                "categoryKey": category_key,
            }),
            true,
        ));
    }

    out
}

fn capture_work(work: &Value) -> Option<(String, Value)> {
    let source = scalar_text(&work["sourceId"])?;
    if source == "0" {
        return None;
    }
    let url = work["url"].as_str()?;
    let key = canonical_work_key(&source, url);
    Some((
        key,
        json!({
            "sourceId": source, "url": url, "title": work["title"], "favorite": work["inLibrary"],
        }),
    ))
}

fn projection_wake() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

pub(super) fn wake_projection() {
    projection_wake().notify_one();
}

pub(in crate::syncd) fn spawn_projection(
    state: SharedAppState,
    runtime: Arc<V4Runtime>,
    mut shutdown: watch::Receiver<Option<ShutdownRequest>>,
) {
    tokio::spawn(async move {
        let mut retry_tick = tokio::time::interval(Duration::from_secs(2));
        retry_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = wait_for_shutdown_request(&mut shutdown) => break,
                _ = projection_wake().notified() => {},
                _ = retry_tick.tick() => {},
            }
            tokio::select! {
                _ = wait_for_shutdown_request(&mut shutdown) => break,
                result = drain_projection_once(&state) => {
                    if let Err(error) = result {
                        tracing::warn!(error = %error, "V4 comic projection queue unavailable");
                    }
                }
            }
            tokio::select! {
                _ = wait_for_shutdown_request(&mut shutdown) => break,
                result = run_comic_library_baselines(&state, &runtime) => {
                    if let Err(error) = result {
                        tracing::warn!(error = %error, "V4 desktop comic baseline check failed");
                    }
                }
            }
            tokio::select! {
                _ = wait_for_shutdown_request(&mut shutdown) => break,
                result = retry_deferred_catalog_captures(&state, &runtime) => {
                    if let Err(error) = result {
                        tracing::warn!(error = %error, "V4 desktop category capture retry failed");
                    }
                }
            }
        }
    });
}

/// Runs the desktop category captures that had to wait for remote comic changes to reach
/// Suwayomi, once the projection has settled.
pub(super) async fn retry_deferred_catalog_captures(
    state: &SharedAppState,
    runtime: &V4Runtime,
) -> anyhow::Result<()> {
    let now = Instant::now();
    let due = runtime
        .comic_baseline
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .due_catalogs(now);
    for profile in due {
        if !ProjectionProgress::settled(load_projection_progress(&state.pool, &profile).await?) {
            continue;
        }
        // Zero wait: a projection that moved again keeps the capture deferred instead of blocking.
        let outcome = capture_local_edits_with_wait(
            state,
            runtime,
            &profile,
            Vec::new(),
            Vec::new(),
            true,
            Duration::ZERO,
        )
        .await;
        if let Err(error) = outcome {
            tracing::debug!(%profile, error = %error, "V4 desktop category capture retry deferred");
            runtime
                .comic_baseline
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .defer_catalog(&profile, Instant::now() + BASELINE_RETRY);
        }
    }
    Ok(())
}

/// How long a profile waits before the baseline runs again after a deferral.
const BASELINE_RETRY: Duration = Duration::from_secs(10);
/// Chapter reads cover this many library works per request instead of one request per work.
const BASELINE_WORKS_PER_CHAPTER_REQUEST: usize = 100;

/// Per-profile state of the desktop comic library baseline, kept in memory.
#[derive(Debug, Default)]
pub(super) struct ComicBaselineProgress {
    done: BTreeSet<String>,
    retry_after: BTreeMap<String, Instant>,
    /// Profiles whose desktop category capture is owed: when it was first owed and when to retry.
    catalog_retry_after: BTreeMap<String, (Instant, Instant)>,
}

impl ComicBaselineProgress {
    fn is_ready(&self, profile: &str, now: Instant) -> bool {
        !self.done.contains(profile) && self.retry_after.get(profile).is_none_or(|at| now >= *at)
    }

    fn defer(&mut self, profile: &str, now: Instant) {
        self.retry_after
            .insert(profile.to_owned(), now + BASELINE_RETRY);
    }

    fn mark_done(&mut self, profile: &str) {
        self.done.insert(profile.to_owned());
        self.retry_after.remove(profile);
    }

    /// Keeps the earliest pending retry so repeated skips never push an owed capture back.
    fn defer_catalog(&mut self, profile: &str, at: Instant) {
        let owed_since = Instant::now().min(at);
        self.catalog_retry_after
            .entry(profile.to_owned())
            .and_modify(|(_, retry)| *retry = at)
            .or_insert((owed_since, at));
    }

    /// Settles the debt only when the successful capture began after it was owed: a capture that
    /// was skipped while an earlier one was still writing stays owed.
    fn catalog_done(&mut self, profile: &str, capture_started: Instant) {
        if self
            .catalog_retry_after
            .get(profile)
            .is_some_and(|(owed_since, _)| *owed_since <= capture_started)
        {
            self.catalog_retry_after.remove(profile);
        }
    }

    fn due_catalogs(&self, now: Instant) -> Vec<String> {
        self.catalog_retry_after
            .iter()
            .filter(|(_, (_, retry))| now >= *retry)
            .map(|(profile, _)| profile.clone())
            .collect()
    }

    #[cfg(test)]
    pub(super) fn catalog_pending(&self, profile: &str) -> bool {
        self.catalog_retry_after.contains_key(profile)
    }
}

/// Publishes desktop library state that Core has never recorded: works (including Default-only
/// and Completed-only ones), real categories, memberships, and chapter progress. It only fills
/// gaps, so it never re-emits a record Core already holds, live or tombstoned.
pub(super) async fn run_comic_library_baselines(
    state: &SharedAppState,
    runtime: &V4Runtime,
) -> anyhow::Result<()> {
    let profiles: Vec<String> =
        sqlx::query_scalar("SELECT profile_id FROM v4_profile_watermarks WHERE current_seq > 0")
            .fetch_all(&state.pool)
            .await?;
    for profile in profiles {
        let now = Instant::now();
        let ready = runtime
            .comic_baseline
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_ready(&profile, now);
        if !ready {
            continue;
        }
        let outcome = capture_comic_library_baseline(state, runtime, &profile).await;
        let mut progress = runtime
            .comic_baseline
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match outcome {
            Ok(true) => progress.mark_done(&profile),
            // Projection has not settled yet: try again once it has.
            Ok(false) => progress.defer(&profile, Instant::now()),
            Err(error) => {
                tracing::debug!(%profile, error = %error, "V4 desktop comic baseline deferred");
                progress.defer(&profile, Instant::now());
            }
        }
    }
    Ok(())
}

/// Returns `Ok(true)` once the baseline has run against a settled projection, and `Ok(false)`
/// when it had to wait for remote comic changes to reach Suwayomi first.
pub(super) async fn capture_comic_library_baseline(
    state: &SharedAppState,
    runtime: &V4Runtime,
    profile: &str,
) -> anyhow::Result<bool> {
    let before = load_projection_progress(&state.pool, profile).await?;
    if !ProjectionProgress::settled(before) {
        return Ok(false);
    }
    let session = AuthenticatedSession {
        profile_id: profile.to_owned(),
        token_id: COMIC_PROJECTION_TOKEN.to_owned(),
        device_id: LOCAL_DESKTOP_ORIGIN.to_owned(),
        scopes: BTreeSet::from([format!("comics:profile:{profile}")]),
        mutation_receipt: None,
    };
    let library = read_nodes(
        state,
        &session,
        COMIC_LIBRARY_QUERY,
        "mangas",
        WORK_PAGE_SIZE,
        json!({}),
    )
    .await?;
    let categories = read_nodes(
        state,
        &session,
        COMIC_CATEGORY_MEMBERSHIP_QUERY,
        "categories",
        WORK_PAGE_SIZE,
        json!({}),
    )
    .await?;
    let work_ids: Vec<i64> = library.iter().filter_map(|work| work["id"].as_i64()).collect();
    let mut chapters = Vec::new();
    for ids in work_ids.chunks(BASELINE_WORKS_PER_CHAPTER_REQUEST) {
        chapters.extend(
            read_nodes(
                state,
                &session,
                COMIC_CHAPTERS_QUERY,
                "chapters",
                CHAPTER_PAGE_SIZE,
                json!({ "ids": ids }),
            )
            .await?,
        );
    }

    // Same ordering as the catalog capture: plan from Core only while holding the write gate,
    // and only if nothing was committed while Suwayomi was read.
    let _guard = runtime.write_gate.lock().await;
    let after = load_projection_progress(&state.pool, profile).await?;
    if !catalog_snapshot_is_current(before, after) {
        return Ok(false);
    }
    let stored = load_stored_comic_records(&state.pool, profile).await?;
    let planned = plan_comic_library_baseline(&library, &chapters, &categories, &stored);
    if planned.is_empty() {
        return Ok(true);
    }
    let now = crate::syncd::db::now_ms();
    let watermark = db::load_watermark(&state.pool, profile).await?;
    let items = planned
        .into_iter()
        .enumerate()
        .map(|(index, (entity_type, entity_key, payload))| db::V4IncomingItem {
            client_mutation_id: None,
            domain: "comics".to_owned(),
            entity_type: entity_type.to_owned(),
            entity_key,
            deleted: false,
            hlc: super::hlc::Hlc::new(
                now,
                watermark.current_seq.saturating_add(index as i64),
                LOCAL_DESKTOP_ORIGIN,
            ),
            payload,
        })
        .collect();
    let summary =
        db::apply_v4_batch(&state.pool, profile, LOCAL_DESKTOP_ORIGIN, items, true).await?;
    for record in summary.committed_records {
        let _ = runtime.live_sender.send(V4LiveEvent {
            profile_id: profile.to_owned(),
            origin_device_id: LOCAL_DESKTOP_ORIGIN.to_owned(),
            server_seq: record.server_seq,
            kind: V4LiveEventKind::Delta(record),
        });
    }
    wake_projection();
    Ok(true)
}

#[derive(Debug, Clone)]
struct StoredComicRecord {
    deleted: bool,
    payload: Value,
}

async fn load_stored_comic_records(
    pool: &sqlx::SqlitePool,
    profile: &str,
) -> anyhow::Result<BTreeMap<(String, String), StoredComicRecord>> {
    let rows: Vec<(String, String, i64, String)> = sqlx::query_as(
        "SELECT entity_type, entity_key, deleted, payload_json FROM v4_records
         WHERE profile_id = ? AND entity_type IN
           ('comic.work', 'comic.category', 'comic.category_assignment', 'comic.chapter')",
    )
    .bind(profile)
    .fetch_all(pool)
    .await
    .context("failed to read stored V4 comic records")?;
    Ok(rows
        .into_iter()
        .map(|(entity_type, entity_key, deleted, payload_json)| {
            (
                (entity_type, entity_key),
                StoredComicRecord {
                    deleted: deleted != 0,
                    payload: serde_json::from_str(&payload_json).unwrap_or(Value::Null),
                },
            )
        })
        .collect())
}

/// Reading progress of one chapter. Merging keeps the furthest value of each field, so the
/// desktop can never move a device backwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChapterProgress {
    read: bool,
    bookmarked: bool,
    page: i64,
}

impl ChapterProgress {
    fn from_suwayomi(chapter: &Value) -> Self {
        Self {
            read: chapter["isRead"] == true,
            bookmarked: chapter["isBookmarked"] == true,
            page: chapter["lastPageRead"].as_i64().unwrap_or(0),
        }
    }

    fn from_record(payload: &Value) -> Option<Self> {
        payload.is_object().then(|| Self {
            read: payload["isRead"] == true,
            bookmarked: payload["isBookmarked"] == true,
            page: payload["lastPageRead"].as_i64().unwrap_or(0),
        })
    }

    fn has_progress(self) -> bool {
        self.read || self.bookmarked || self.page > 0
    }

    fn furthest(self, other: Self) -> Self {
        Self {
            read: self.read || other.read,
            bookmarked: self.bookmarked || other.bookmarked,
            page: self.page.max(other.page),
        }
    }
}

fn missing_work_payload(source: &str, url: &str, title: &Value) -> Value {
    json!({
        "sourceId": source,
        "url": url,
        "title": title.as_str().unwrap_or(url),
        "favorite": true,
    })
}

/// The canonical key, Suwayomi source id and url of a comic. Internal Suwayomi ids are not
/// global identities, so they are never returned here.
fn comic_identity(work: &Value) -> Option<(String, String, &str)> {
    let source = scalar_text(&work["sourceId"])?;
    if source == "0" {
        return None;
    }
    let url = work["url"].as_str()?;
    Some((canonical_work_key(&source, url), source, url))
}

/// Plans the baseline. Core holds the authority: a work, category, membership or chapter record
/// that already exists (live or tombstoned) is never emitted again. Tombstoned works and
/// categories are never resurrected, and their memberships and chapters are skipped too.
fn plan_comic_library_baseline(
    library: &[Value],
    chapters: &[Value],
    categories: &[Value],
    stored: &BTreeMap<(String, String), StoredComicRecord>,
) -> Vec<(&'static str, String, Value)> {
    let stored_record = |entity_type: &str, key: &str| {
        stored.get(&(entity_type.to_owned(), key.to_owned()))
    };
    let mut out = Vec::new();
    let mut live_works = BTreeSet::new();
    let mut work_keys_by_id = BTreeMap::new();
    for work in library {
        let Some((key, source, url)) = comic_identity(work) else {
            continue;
        };
        if let Some(id) = work["id"].as_i64() {
            work_keys_by_id.insert(id, key.clone());
        }
        match stored_record("comic.work", &key) {
            Some(record) => {
                if !record.deleted {
                    live_works.insert(key);
                }
            }
            None => {
                if live_works.insert(key.clone()) {
                    out.push(("comic.work", key, missing_work_payload(&source, url, &work["title"])));
                }
            }
        }
    }

    let mut usable_categories = BTreeSet::new();
    let mut emitted_assignments = BTreeSet::new();
    for category in categories {
        if category["id"].as_i64() == Some(0) {
            continue;
        }
        let Some(raw_name) = category["name"].as_str() else {
            continue;
        };
        if is_reserved_category_name(raw_name) {
            continue;
        }
        let name = raw_name.trim();
        let category_key = name.to_lowercase();
        match stored_record("comic.category", &category_key) {
            Some(record) if record.deleted => continue,
            Some(_) => {}
            None if usable_categories.contains(&category_key) => {}
            None => out.push((
                "comic.category",
                category_key.clone(),
                json!({
                    "name": name,
                    "order": category["order"].as_i64().unwrap_or(0),
                    "flags": 0,
                }),
            )),
        }
        usable_categories.insert(category_key.clone());
        for manga in category["mangas"]["nodes"].as_array().into_iter().flatten() {
            if manga["inLibrary"].as_bool() == Some(false) {
                continue;
            }
            let Some((work_key, _, _)) = comic_identity(manga) else {
                continue;
            };
            if !live_works.contains(&work_key) {
                continue;
            }
            let assignment_key = format!("{work_key}|{category_key}");
            if stored_record("comic.category_assignment", &assignment_key).is_some()
                || !emitted_assignments.insert(assignment_key.clone())
            {
                continue;
            }
            out.push((
                "comic.category_assignment",
                assignment_key,
                json!({ "workKey": work_key, "categoryKey": category_key }),
            ));
        }
    }

    for chapter in chapters {
        let Some(work_key) = chapter["mangaId"]
            .as_i64()
            .and_then(|id| work_keys_by_id.get(&id))
        else {
            continue;
        };
        if !live_works.contains(work_key) {
            continue;
        }
        let Some(url) = chapter["url"].as_str() else {
            continue;
        };
        let desktop = ChapterProgress::from_suwayomi(chapter);
        if !desktop.has_progress() {
            continue;
        }
        let key = canonical_chapter_key(work_key, url);
        let progress = match stored_record("comic.chapter", &key) {
            None => desktop,
            Some(record) => {
                // A tombstone or an explicit reset is Core's decision, which the baseline never
                // overrides.
                if record.deleted || record.payload.get("explicitResetHlc").is_some() {
                    continue;
                }
                let Some(stored_progress) = ChapterProgress::from_record(&record.payload) else {
                    continue;
                };
                let merged = stored_progress.furthest(desktop);
                if merged == stored_progress {
                    continue;
                }
                merged
            }
        };
        out.push((
            "comic.chapter",
            key,
            json!({
                "workKey": work_key,
                "url": url,
                "name": chapter["name"],
                "chapterNumber": chapter["chapterNumber"],
                "scanlator": chapter["scanlator"],
                "isRead": progress.read,
                "isBookmarked": progress.bookmarked,
                "lastPageRead": progress.page,
            }),
        ));
    }
    out
}

pub(super) async fn drain_projection_once(state: &SharedAppState) -> anyhow::Result<()> {
    let now = crate::syncd::db::now_ms();
    let ready: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT profile_id, applied_seq, target_seq FROM v4_comics_projection
         WHERE applied_seq < target_seq AND next_attempt_ms <= ? ORDER BY next_attempt_ms LIMIT 8",
    )
    .bind(now)
    .fetch_all(&state.pool)
    .await?;
    for (profile, applied, target) in ready {
        let session = AuthenticatedSession {
            profile_id: profile.clone(),
            token_id: COMIC_PROJECTION_TOKEN.to_owned(),
            device_id: "epigraph-core".to_owned(),
            scopes: BTreeSet::from([format!("comics:profile:{profile}")]),
            mutation_receipt: None,
        };
        let result = async {
            suwayomi_proxy::resolve_upstream_base(state, &profile).map_err(anyhow::Error::msg)?;
            let changes = db::load_changed_comics(&state.pool, &profile, applied, target).await?;
            project_comic_changes(state, &session, applied, &changes).await
        }
        .await;
        let retry = crate::syncd::db::now_ms() + 5_000;
        match result {
            Ok(()) => {
                sqlx::query("UPDATE v4_comics_projection SET applied_seq = ? WHERE profile_id = ?")
                    .bind(target)
                    .bind(&profile)
                    .execute(&state.pool)
                    .await?;
            }
            Err(error) => {
                // A newer upload can wake work immediately. Avoid delaying its retry
                // with the result of a previous projection.
                sqlx::query(
                    "UPDATE v4_comics_projection SET next_attempt_ms = ?
                     WHERE profile_id = ? AND target_seq = ?",
                )
                .bind(retry)
                .bind(&profile)
                .bind(target)
                .execute(&state.pool)
                .await?;
                tracing::debug!(%profile, error = %error, "V4 comics projection deferred");
            }
        }
    }
    Ok(())
}

async fn project_comic_changes(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    applied: i64,
    changes: &[V4WireRecord],
) -> anyhow::Result<()> {
    if changes.is_empty() {
        return Ok(());
    }
    if applied == 0 {
        restore_comic_snapshot(state, session, changes).await?;
    }
    let needs_restore = applied > 0
        && changes
            .iter()
            .any(|record| !record.deleted && record.entity_type != "comic.chapter");
    if needs_restore {
        restore_current_snapshot(state, session).await?;
    }
    // Restore preserves more advanced local progress. Apply explicit resets and removals
    // directly; ordinary initial chapter state already arrived through the backup.
    let direct = changes
        .iter()
        .filter(|record| {
            record.deleted
                || (record.entity_type == "comic.chapter" && applied > 0)
                || record.payload.get("explicitResetHlc").is_some()
                || record.entity_type == "comic.work" && record.payload["favorite"] == false
        })
        .collect::<Vec<_>>();
    let mut restored = applied == 0 || needs_restore;
    let mut touched = Vec::new();
    if !direct.is_empty() {
        let result = apply_direct_updates(state, session, &direct).await;
        if !needs_restore
            && result
                .as_ref()
                .is_err_and(|error| error.is::<MissingComicTarget>())
        {
            restore_current_snapshot(state, session).await?;
            restored = true;
            touched = apply_direct_updates(state, session, &direct).await?;
        } else {
            touched = result?;
        }
    }
    let catalog = restored
        || changes
            .iter()
            .any(|record| record.entity_type != "comic.chapter");
    record_landed_projection(&session.profile_id, catalog, &touched);
    Ok(())
}

fn record_landed_projection(profile_id: &str, catalog: bool, touched: &[i64]) {
    APPLIED_PROJECTIONS.fetch_add(1, Ordering::Relaxed);
    if catalog {
        // A restore or a membership change can reach any work, so the window reads the library.
        landed_works::record_projection(profile_id, "UpdateManga", &json!({}));
        return;
    }
    for &manga_id in touched {
        landed_works::record_work(profile_id, manga_id);
    }
}

async fn restore_current_snapshot(
    state: &SharedAppState,
    session: &AuthenticatedSession,
) -> anyhow::Result<()> {
    let snapshot =
        db::load_snapshot(&state.pool, &session.profile_id, Some("comics"), true).await?;
    let records = snapshot
        .records
        .into_iter()
        .map(|record| {
            let payload = serde_json::from_str(record.payload.get())?;
            Ok(V4WireRecord {
                server_seq: record.server_seq,
                domain: record.domain,
                entity_type: record.entity_type,
                entity_key: record.entity_key,
                deleted: record.deleted,
                hlc: record.hlc,
                origin_device_id: record.origin_device_id,
                payload,
                updated_at_ms: record.updated_at_ms,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    restore_comic_snapshot(state, session, &records).await
}

#[derive(Debug)]
struct MissingComicTarget;

impl std::fmt::Display for MissingComicTarget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Suwayomi is missing a chapter or work named in canonical V4 state")
    }
}

impl std::error::Error for MissingComicTarget {}

const COMIC_WORKS_QUERY: &str = r#"
  query EpigraphV4ComicWorks($first: Int!, $offset: Int!) {
    mangas(orderBy: ID, orderByType: ASC, first: $first, offset: $offset) {
      nodes { id sourceId url }
      pageInfo { hasNextPage }
    }
  }
"#;

const COMIC_CHAPTERS_QUERY: &str = r#"
  query EpigraphV4ComicChapters($ids: [Int!]!, $first: Int!, $offset: Int!) {
    chapters(filter: { mangaId: { in: $ids } }, orderBy: ID, orderByType: ASC, first: $first, offset: $offset) {
      nodes { id mangaId url name chapterNumber scanlator isRead isBookmarked lastPageRead }
      pageInfo { hasNextPage }
    }
  }
"#;

const COMIC_LIBRARY_QUERY: &str = r#"
  query EpigraphV4ComicLibrary($first: Int!, $offset: Int!) {
    mangas(condition: { inLibrary: true }, first: $first, offset: $offset) {
      nodes { id sourceId url title }
      pageInfo { hasNextPage }
    }
  }
"#;

/// Categories with their members, so the baseline can tell real categories from the reserved
/// Default and Completed folders, which are never shared as categories.
const COMIC_CATEGORY_MEMBERSHIP_QUERY: &str = r#"
  query EpigraphV4ComicCategoryMembership($first: Int!, $offset: Int!) {
    categories(first: $first, offset: $offset) {
      nodes {
        id
        name
        order
        mangas {
          nodes { id sourceId url title inLibrary }
        }
      }
      pageInfo { hasNextPage }
    }
  }
"#;

const COMIC_CATEGORIES_QUERY: &str = r#"
  query EpigraphV4ComicCategories($first: Int!, $offset: Int!) {
    categories(first: $first, offset: $offset) {
      nodes { id name }
      pageInfo { hasNextPage }
    }
  }
"#;

const REMOVE_WORKS: &str = r#"
  mutation EpigraphV4RemoveComics($ids: [Int!]!) {
    updateMangas(input: { ids: $ids, patch: { inLibrary: false } }) { mangas { id inLibrary } }
  }
"#;

const COMIC_TRACKS_QUERY: &str = r#"
  query EpigraphV4ComicTracks($first: Int!, $offset: Int!) {
    trackRecords(first: $first, offset: $offset) {
      nodes { id mangaId trackerId }
      pageInfo { hasNextPage }
    }
  }
"#;

const UNBIND_TRACK: &str = r#"
  mutation EpigraphV4UnbindTracker($id: Int!) {
    unbindTrack(input: { recordId: $id, deleteRemoteTrack: false }) { trackRecord { id } }
  }
"#;

/// Returns the Suwayomi ids of the works it changed.
async fn apply_direct_updates(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    records: &[&V4WireRecord],
) -> anyhow::Result<Vec<i64>> {
    let manga_nodes = read_nodes(
        state,
        session,
        COMIC_WORKS_QUERY,
        "mangas",
        WORK_PAGE_SIZE,
        json!({}),
    )
    .await?;
    let mut mangas = HashMap::new();
    for work in &manga_nodes {
        let (Some(id), Some(url), Some(source)) = (
            work["id"].as_i64(),
            work["url"].as_str(),
            scalar_text(&work["sourceId"]),
        ) else {
            continue;
        };
        mangas.entry(canonical_work_key(&source, url)).or_insert(id);
    }

    let mut removed = Vec::new();
    let mut chapters = BTreeMap::<i64, Vec<(&str, &V4WireRecord)>>::new();
    for record in records {
        match record.entity_type.as_str() {
            "comic.work" => {
                if let Some(&id) = mangas.get(&record.entity_key) {
                    removed.push(id);
                }
            }
            "comic.chapter" => {
                let key = parent_key(record)?;
                match mangas.get(key) {
                    Some(&id) => chapters.entry(id).or_default().push((key, record)),
                    None if record.deleted => {}
                    None => return Err(MissingComicTarget.into()),
                }
            }
            _ => {}
        }
    }
    for ids in removed.chunks(250) {
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            REMOVE_WORKS,
            json!({ "ids": ids }),
            true,
        )
        .await
        .map_err(|_| anyhow::anyhow!("Suwayomi rejected V4 work membership update"))?;
        let actual = data
            .pointer("/updateMangas/mangas")
            .and_then(Value::as_array)
            .context("Suwayomi did not confirm work removal")?;
        ensure!(
            actual.len() == ids.len() && actual.iter().all(|work| work["inLibrary"] == false),
            "V4 work removal not confirmed"
        );
    }

    for group in chapters.keys().copied().collect::<Vec<_>>().chunks(100) {
        let nodes = read_nodes(
            state,
            session,
            COMIC_CHAPTERS_QUERY,
            "chapters",
            CHAPTER_PAGE_SIZE,
            json!({"ids":group}),
        )
        .await?;
        let mut by_manga = HashMap::<i64, Vec<&Value>>::new();
        for node in &nodes {
            if let Some(id) = node["mangaId"].as_i64() {
                by_manga.entry(id).or_default().push(node);
            }
        }
        let mut patches = BTreeMap::<(Option<bool>, Option<bool>, Option<i64>), Vec<i64>>::new();
        for manga_id in group {
            let local = by_manga
                .get(manga_id)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let changes = &chapters[manga_id];
            let work_key = changes[0].0;
            let exact: HashMap<_, _> = local
                .iter()
                .rev()
                .filter_map(|node| {
                    Some((
                        canonical_chapter_key(work_key, node["url"].as_str()?),
                        *node,
                    ))
                })
                .collect();
            for &(_, record) in changes {
                let node = exact
                    .get(&record.entity_key)
                    .copied()
                    .or_else(|| chapter_by_number(local, &record.payload));
                let Some(node) = node else {
                    if !record.deleted {
                        return Err(MissingComicTarget.into());
                    }
                    continue;
                };
                let id = node["id"]
                    .as_i64()
                    .context("Suwayomi chapter has no numeric id")?;
                let read = if record.deleted {
                    Some(false)
                } else {
                    record.payload["isRead"].as_bool()
                };
                let bookmark = if record.deleted {
                    Some(false)
                } else {
                    record.payload["isBookmarked"].as_bool()
                };
                let page = if record.deleted {
                    Some(0)
                } else {
                    record.payload["lastPageRead"].as_i64()
                };
                let read = read.filter(|value| node["isRead"].as_bool() != Some(*value));
                let bookmark =
                    bookmark.filter(|value| node["isBookmarked"].as_bool() != Some(*value));
                let page = page.filter(|value| node["lastPageRead"].as_i64() != Some(*value));
                if read.is_some() || bookmark.is_some() || page.is_some() {
                    patches.entry((read, bookmark, page)).or_default().push(id);
                }
            }
        }
        for ((read, bookmark, page), ids) in patches {
            for ids in ids.chunks(suwayomi_commands::MAX_CHAPTER_IDS) {
                let result = suwayomi_commands::execute_internal_command(
                    state,
                    &session.profile_id,
                    CommandOperation::UpdateChaptersProgress,
                    json!({"ids":ids,"isRead":read,"isBookmarked":bookmark,"lastPageRead":page}),
                )
                .await
                .map_err(|_| anyhow::anyhow!("Suwayomi rejected V4 chapter progress"))?;
                let actual = result
                    .pointer("/updateChapters/chapters")
                    .and_then(Value::as_array)
                    .context("Suwayomi did not confirm V4 chapter progress")?;
                ensure!(
                    actual.len() == ids.len()
                        && actual.iter().all(|chapter| {
                            read.is_none_or(|value| chapter["isRead"] == value)
                                && bookmark.is_none_or(|value| chapter["isBookmarked"] == value)
                                && page.is_none_or(|value| chapter["lastPageRead"] == value)
                        }),
                    "Suwayomi did not apply V4 chapter progress"
                );
            }
        }
    }
    apply_relation_deletes(state, session, records, &mangas).await?;
    let mut touched = removed;
    touched.extend(chapters.keys().copied());
    touched.sort_unstable();
    touched.dedup();
    Ok(touched)
}

fn chapter_by_number<'a>(chapters: &[&'a Value], fields: &Value) -> Option<&'a Value> {
    let number = fields["chapterNumber"]
        .as_f64()
        .filter(|value| *value >= 0.0)?;
    let scanlator = text(fields, "scanlator").unwrap_or_default();
    let mut candidates = chapters.iter().copied().filter(|chapter| {
        chapter["chapterNumber"]
            .as_f64()
            .is_some_and(|other| (other - number).abs() < 0.000_01)
            && text(chapter, "scanlator").unwrap_or_default() == scanlator
    });
    let found = candidates.next()?;
    candidates.next().is_none().then_some(found)
}

/// Folders an incoming tombstone may delete or unassign. Default and Completed belong to the
/// app on both sides, so a remote deletion never removes them or their members.
fn removable_categories(nodes: &[Value]) -> HashMap<String, i64> {
    nodes
        .iter()
        .filter_map(|node| {
            let id = node["id"].as_i64().filter(|id| *id > 0)?;
            let name = node["name"].as_str()?;
            (!is_reserved_category_name(name)).then(|| (name.trim().to_lowercase(), id))
        })
        .collect()
}

async fn apply_relation_deletes(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    records: &[&V4WireRecord],
    mangas: &HashMap<String, i64>,
) -> anyhow::Result<()> {
    let includes_folders = records.iter().any(|record| {
        record.deleted
            && matches!(
                record.entity_type.as_str(),
                "comic.category" | "comic.category_assignment"
            )
    });
    let mut categories = HashMap::new();
    let mut category_names = HashMap::new();
    if includes_folders {
        let persisted_categories: Vec<(String, String)> = sqlx::query_as(
            "SELECT entity_key, payload_json FROM v4_records WHERE profile_id = ? AND entity_type = 'comic.category'",
        )
        .bind(&session.profile_id)
        .fetch_all(&state.pool)
        .await?;
        for (entity_key, payload_json) in persisted_categories {
            if let Ok(payload) = serde_json::from_str::<Value>(&payload_json) {
                if let Some(name) = text(&payload, "name") {
                    category_names.insert(entity_key, name.trim().to_lowercase());
                }
            }
        }
        for record in records.iter().filter(|r| r.entity_type == "comic.category") {
            if let Some(name) = text(&record.payload, "name") {
                category_names.insert(record.entity_key.clone(), name.trim().to_lowercase());
            }
        }
        let nodes = read_nodes(
            state,
            session,
            COMIC_CATEGORIES_QUERY,
            "categories",
            100,
            json!({}),
        )
        .await?;
        categories = removable_categories(&nodes);
    }
    let mut trackers = HashMap::new();
    if records
        .iter()
        .any(|record| record.deleted && record.entity_type == "comic.tracking")
    {
        let nodes = read_nodes(
            state,
            session,
            COMIC_TRACKS_QUERY,
            "trackRecords",
            250,
            json!({}),
        )
        .await?;
        for node in nodes {
            if let (Some(id), Some(manga), Some(tracker)) = (
                node["id"].as_i64(),
                node["mangaId"].as_i64(),
                node["trackerId"].as_i64(),
            ) {
                trackers.insert((manga, tracker), id);
            }
        }
    }
    for record in records.iter().filter(|record| record.deleted) {
        let command = match record.entity_type.as_str() {
            "comic.category" => {
                let name = text(&record.payload, "name")
                    .map(|n| n.trim().to_lowercase())
                    .or_else(|| category_names.get(&record.entity_key).cloned())
                    .unwrap_or_else(|| record.entity_key.trim().to_lowercase());
                categories
                    .remove(&name)
                    .map(|id| (CommandOperation::DeleteCategory, json!({"id": id})))
            }
            "comic.category_assignment" => {
                let (work, folder) = record
                    .entity_key
                    .rsplit_once('|')
                    .context("Invalid V4 category assignment")?;
                let folder_name = category_names
                    .get(folder)
                    .cloned()
                    .unwrap_or_else(|| folder.trim().to_lowercase());
                mangas
                    .get(work)
                    .zip(categories.get(&folder_name))
                    .map(|(work, folder)| {
                        (
                            CommandOperation::UpdateMangaCategories,
                            json!({"mangaId": work, "addTo": [], "removeFrom": [folder]}),
                        )
                    })
            }
            "comic.tracking" => {
                let (work, tracker) = record
                    .entity_key
                    .rsplit_once('|')
                    .context("Invalid V4 tracker binding")?;
                let tracker = tracker.parse::<i64>().context("Invalid V4 tracker ID")?;
                if let Some(id) = mangas
                    .get(work)
                    .and_then(|work| trackers.get(&(*work, tracker)))
                {
                    let response = suwayomi_catalog::execute_graphql_document(
                        state,
                        session,
                        UNBIND_TRACK,
                        json!({"id":id}),
                        true,
                    )
                    .await
                    .map_err(|_| anyhow::anyhow!("Suwayomi rejected V4 tracker removal"))?;
                    ensure!(
                        response
                            .pointer("/unbindTrack/trackRecord/id")
                            .and_then(Value::as_i64)
                            == Some(*id),
                        "Suwayomi did not confirm V4 tracker removal"
                    );
                }
                None
            }
            "comic.history" => anyhow::bail!("Suwayomi GraphQL does not accept a history clear"),
            _ => None,
        };
        if let Some((operation, variables)) = command {
            suwayomi_commands::execute_internal_command(
                state,
                &session.profile_id,
                operation,
                variables,
            )
            .await
            .map_err(|_| anyhow::anyhow!("Suwayomi rejected V4 category removal"))?;
        }
    }
    Ok(())
}

fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

async fn read_nodes(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    query: &str,
    connection: &str,
    first: usize,
    mut variables: Value,
) -> anyhow::Result<Vec<Value>> {
    let mut nodes = Vec::new();
    variables["first"] = json!(first);
    loop {
        variables["offset"] = json!(nodes.len());
        let mut data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            query,
            variables.clone(),
            false,
        )
        .await
        .map_err(|_| anyhow::anyhow!("Suwayomi could not list V4 projection targets"))?;
        let connection = &mut data[connection];
        let next = connection
            .pointer("/pageInfo/hasNextPage")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let Value::Array(mut page) = connection["nodes"].take() else {
            anyhow::bail!("Invalid Suwayomi V4 projection response");
        };
        ensure!(
            !next || !page.is_empty(),
            "Suwayomi returned an empty intermediate page"
        );
        nodes.append(&mut page);
        if !next {
            return Ok(nodes);
        }
    }
}

pub(super) struct ComicRestore {
    pub works: Vec<ImportWork>,
    pub categories: Vec<ImportCategory>,
}

/// Restores the portable baseline through the Suwayomi API, with one offline backup job.
pub(super) async fn restore_comic_snapshot(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    records: &[V4WireRecord],
) -> anyhow::Result<()> {
    let plan = prepare_restore(records)?;
    if !plan.works.is_empty() || !plan.categories.is_empty() {
        restore_backup_confirmed(state, session, &plan.works, &plan.categories, true)
            .await
            .map_err(|_| anyhow::anyhow!("Suwayomi failed to restore the V4 comic baseline"))?;
    }
    Ok(())
}

pub(super) fn prepare_restore(records: &[V4WireRecord]) -> anyhow::Result<ComicRestore> {
    let mut works = BTreeMap::new();
    let mut categories = records
        .iter()
        .filter(|record| {
            record.entity_type == "comic.category"
                && !record.deleted
                && !text(&record.payload, "name")
                    .is_some_and(is_reserved_category_name)
        })
        .collect::<Vec<_>>();
    categories.sort_by_key(|record| {
        (
            integer(&record.payload, "order"),
            record.entity_key.as_str(),
        )
    });
    let mut category_orders = HashMap::with_capacity(categories.len());
    let categories = categories
        .into_iter()
        .enumerate()
        .map(|(index, record)| -> anyhow::Result<ImportCategory> {
            let order = index as u64;
            category_orders.insert(record.entity_key.as_str(), order);
            Ok(ImportCategory {
                name: required_text(&record.payload, "name")?.to_owned(),
                order,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    for record in records
        .iter()
        .filter(|record| record.entity_type == "comic.work" && !record.deleted)
    {
        let fields = &record.payload;
        let source = required_text(fields, "sourceId")?;
        let url = text(fields, "url")
            .or_else(|| text(fields, "workUrl"))
            .context("V4 comic work is missing URL")?;
        ensure!(
            source.parse::<i64>().is_ok_and(|id| id != 0)
                && canonical_work_key(source, url) == record.entity_key,
            "Invalid V4 comic work identity"
        );
        works.insert(
            record.entity_key.as_str(),
            ImportWork {
                source_id: source.to_owned(),
                url: url.to_owned(),
                title: text(fields, "title").unwrap_or(url).to_owned(),
                artist: text(fields, "artist").map(str::to_owned),
                author: text(fields, "author").map(str::to_owned),
                genre: genres(fields),
                status: text(fields, "status").map(str::to_owned).or_else(|| {
                    let code = fields.get("status")?.as_u64()? as usize;
                    [
                        "UNKNOWN",
                        "ONGOING",
                        "COMPLETED",
                        "LICENSED",
                        "PUBLISHING_FINISHED",
                        "CANCELLED",
                        "ON_HIATUS",
                    ]
                    .get(code)
                    .map(|name| (*name).to_owned())
                }),
                date_added: integer(fields, "dateAdded"),
                in_library: Some(
                    fields
                        .get("favorite")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                ),
                update_strategy: text(fields, "updateStrategy").map(str::to_owned),
                chapters: Vec::new(),
                category_orders: Vec::new(),
                history: None,
                tracking: Vec::new(),
            },
        );
    }

    let mut chapters = HashMap::new();
    for record in records
        .iter()
        .filter(|record| record.entity_type == "comic.chapter" && !record.deleted)
    {
        let fields = &record.payload;
        let work_key = parent_key(record)?;
        // A canonical snapshot can contain chapters of a tombstoned work.
        let Some(work) = works.get_mut(work_key) else {
            continue;
        };
        let url = text(fields, "url")
            .or_else(|| text(fields, "chapterUrl"))
            .context("V4 comic chapter is missing URL")?;
        ensure!(
            canonical_chapter_key(work_key, url) == record.entity_key,
            "Invalid V4 comic chapter identity"
        );
        chapters.insert(record.entity_key.as_str(), url);
        work.chapters.push(ImportChapter {
            url: url.to_owned(),
            name: text(fields, "name").unwrap_or(url).to_owned(),
            scanlator: text(fields, "scanlator").map(str::to_owned),
            is_read: fields
                .get("isRead")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            is_bookmarked: fields
                .get("isBookmarked")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            last_page_read: integer(fields, "lastPageRead"),
            fetched_at: integer(fields, "dateFetch"),
            upload_date: integer(fields, "dateUpload"),
            chapter_number: number(fields, "chapterNumber", -1.0),
            source_order: integer(fields, "sourceOrder"),
        });
    }
    for record in records.iter().filter(|record| !record.deleted) {
        let fields = &record.payload;
        match record.entity_type.as_str() {
            "comic.category_assignment" => {
                let category = required_text(fields, "categoryKey")?;
                if let (Some(work), Some(order)) = (
                    works.get_mut(parent_key(record)?),
                    category_orders.get(category),
                ) {
                    work.category_orders.push(*order);
                }
            }
            "comic.history" => {
                let key = required_text(fields, "chapterKey")?;
                if let (Some(work), Some(url)) =
                    (works.get_mut(record.entity_key.as_str()), chapters.get(key))
                {
                    work.history = Some(((*url).to_owned(), integer(fields, "lastReadAtMs")));
                }
            }
            "comic.tracking" => {
                if let Some(work) = works.get_mut(parent_key(record)?) {
                    work.tracking.push(ImportTracking {
                        tracker_id: positive_integer(fields, "trackerId"),
                        library_id: positive_integer(fields, "libraryId"),
                        remote_id: positive_integer(fields, "remoteId"),
                        title: text(fields, "title").unwrap_or(&work.title).to_owned(),
                        url: text(fields, "remoteUrl").unwrap_or_default().to_owned(),
                        last_chapter_read: number(fields, "lastChapterRead", 0.0),
                        total_chapters: positive_integer(fields, "totalChapters"),
                        score: number(fields, "score", 0.0),
                        status: positive_integer(fields, "status"),
                        start_date: positive_integer(fields, "startDate"),
                        finish_date: positive_integer(fields, "finishDate"),
                    });
                }
            }
            _ => {}
        }
    }

    Ok(ComicRestore {
        works: works.into_values().collect(),
        categories,
    })
}

fn parent_key(record: &V4WireRecord) -> anyhow::Result<&str> {
    let (key, _) = record
        .entity_key
        .rsplit_once('|')
        .context("V4 comic relation is missing an identity")?;
    if let Some(parent) = text(&record.payload, "workKey") {
        ensure!(
            key == parent,
            "V4 comic relation parent does not match its identity"
        );
    }
    Ok(key)
}

fn text<'a>(fields: &'a Value, key: &str) -> Option<&'a str> {
    fields
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn required_text<'a>(fields: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    text(fields, key).with_context(|| format!("V4 comic is missing {key}"))
}

fn integer(fields: &Value, key: &str) -> i64 {
    fields
        .get(key)
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(0)
}

fn positive_integer(fields: &Value, key: &str) -> u64 {
    fields
        .get(key)
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(0)
}

fn number(fields: &Value, key: &str, default: f32) -> f32 {
    fields
        .get(key)
        .and_then(Value::as_f64)
        .map(|value| value as f32)
        .filter(|value| value.is_finite())
        .unwrap_or(default)
}

fn genres(fields: &Value) -> Vec<String> {
    match fields.get("genre") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        Some(Value::String(items)) => items
            .split(',')
            .map(str::trim)
            .filter(|genre| !genre.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syncd::v4::hlc::Hlc;
    use serde_json::json;

    #[test]
    fn a_landed_projection_tells_the_desktop_window_what_changed() {
        let profile = "landing-wiring-profile";
        let before = landed_works::view(None);
        let count = applied_projection_count();

        record_landed_projection(profile, false, &[7, 9]);
        let chapters = landed_works::view(Some(before.sequence));
        let mut works = chapters
            .works
            .iter()
            .filter(|work| work.profile_id == profile)
            .map(|work| work.manga_id)
            .collect::<Vec<_>>();
        works.sort_unstable();
        assert_eq!(works, vec![7, 9]);
        assert!(applied_projection_count() > count);

        // A restore or membership change cannot name its works, so the window re-reads the library.
        record_landed_projection(profile, true, &[11]);
        let catalog = landed_works::view(Some(chapters.sequence));
        assert!(catalog.catalog_sequence > chapters.sequence);
        assert!(catalog.floor > chapters.sequence);
        assert!(!catalog
            .works
            .iter()
            .any(|work| work.profile_id == profile && work.manga_id == 11));
    }

    #[test]
    fn backup_plan_restores_bookmarks_history_tracking_and_category_zero() {
        let record = |kind: &str, key: &str, payload| V4WireRecord {
            server_seq: 1,
            domain: "comics".to_owned(),
            entity_type: kind.to_owned(),
            entity_key: key.to_owned(),
            hlc: Hlc::new(1, 0, "android"),
            origin_device_id: "android".to_owned(),
            deleted: false,
            payload,
            updated_at_ms: 1,
        };
        let records = [
            record(
                "comic.category_assignment",
                "123:/work|reading",
                json!({"workKey":"123:/work","categoryKey":"reading"}),
            ),
            record(
                "comic.history",
                "123:/work",
                json!({"chapterKey":"123:/work|/chap/1","lastReadAtMs":12345}),
            ),
            record(
                "comic.chapter",
                "123:/work|/chap/1",
                json!({"workKey":"123:/work", "url":"https://mirror.invalid/chap/1?style=list","isBookmarked":true}),
            ),
            record(
                "comic.tracking",
                "123:/work|2",
                json!({"workKey":"123:/work", "trackerId":2,"remoteId":3_000_000_000_u64}),
            ),
            record(
                "comic.category",
                "reading",
                json!({"name":"Reading","order":7}),
            ),
            record(
                "comic.work",
                "123:/work",
                json!({"sourceId":"123","url":"/work","title":"Example","status":1}),
            ),
        ];
        let plan = prepare_restore(&records).unwrap();
        assert_eq!(plan.categories[0].order, 0);
        assert_eq!(plan.categories[0].name, "Reading");
        let work = &plan.works[0];
        assert_eq!(work.status.as_deref(), Some("ONGOING"));
        assert_eq!(work.category_orders, [0]);
        assert!(!work.chapters[0].is_read);
        assert!(work.chapters[0].is_bookmarked);
        assert_eq!(work.history, Some((work.chapters[0].url.clone(), 12345)));
        assert_eq!(work.tracking[0].remote_id, 3_000_000_000);
    }

    #[test]
    fn restore_omits_completed_category_and_its_assignments() {
        let record = |kind: &str, key: &str, payload| V4WireRecord {
            server_seq: 1,
            domain: "comics".to_owned(),
            entity_type: kind.to_owned(),
            entity_key: key.to_owned(),
            hlc: Hlc::new(1, 0, "android"),
            origin_device_id: "android".to_owned(),
            deleted: false,
            payload,
            updated_at_ms: 1,
        };
        let plan = prepare_restore(&[
            record(
                "comic.category",
                "completed",
                json!({"name":"Completed","order":0}),
            ),
            record(
                "comic.category",
                "done",
                json!({"name":" cOmPlEtEd ","order":1}),
            ),
            record(
                "comic.category",
                "reading",
                json!({"name":"Reading","order":2}),
            ),
            record(
                "comic.work",
                "1:/book",
                json!({"sourceId":"1","url":"/book","title":"Book"}),
            ),
            record(
                "comic.category_assignment",
                "1:/book|completed",
                json!({"workKey":"1:/book","categoryKey":"completed"}),
            ),
            record(
                "comic.category_assignment",
                "1:/book|done",
                json!({"workKey":"1:/book","categoryKey":"done"}),
            ),
            record(
                "comic.category_assignment",
                "1:/book|reading",
                json!({"workKey":"1:/book","categoryKey":"reading"}),
            ),
        ])
        .unwrap();
        assert_eq!(plan.categories.len(), 1);
        assert_eq!(plan.categories[0].name, "Reading");
        assert_eq!(plan.works[0].category_orders, [0]);
    }

    #[test]
    fn remote_tombstones_never_target_default_or_completed() {
        let targets = removable_categories(&[
            json!({"id": 0, "name": "Default"}),
            json!({"id": 3, "name": "Completed"}),
            json!({"id": 4, "name": " default "}),
            json!({"id": 5, "name": "Reading"}),
        ]);
        assert_eq!(targets, HashMap::from([("reading".to_owned(), 5)]));
    }

    #[test]
    fn restore_omits_default_category_and_its_assignments() {
        let record = |kind: &str, key: &str, payload| V4WireRecord {
            server_seq: 1,
            domain: "comics".to_owned(),
            entity_type: kind.to_owned(),
            entity_key: key.to_owned(),
            hlc: Hlc::new(1, 0, "android"),
            origin_device_id: "android".to_owned(),
            deleted: false,
            payload,
            updated_at_ms: 1,
        };
        let plan = prepare_restore(&[
            record("comic.category", "default", json!({"name":"Default","order":0})),
            record("comic.category", "reading", json!({"name":"Reading","order":1})),
            record(
                "comic.work",
                "1:/book",
                json!({"sourceId":"1","url":"/book","title":"Book"}),
            ),
            record(
                "comic.category_assignment",
                "1:/book|default",
                json!({"workKey":"1:/book","categoryKey":"default"}),
            ),
        ])
        .unwrap();
        assert_eq!(plan.categories.len(), 1);
        assert_eq!(plan.categories[0].name, "Reading");
        assert!(plan.works[0].category_orders.is_empty());
    }

    #[test]
    fn plan_catalog_category_edits_captures_add_reorder_assignment_removal_and_exclusions() {
        let categories = vec![
            json!({
                "id": 0,
                "name": "Default",
                "order": 0,
                "mangas": { "nodes": [{ "sourceId": "1", "url": "/a", "inLibrary": true }] }
            }),
            json!({
                "id": 2,
                "name": "Completed",
                "order": 1,
                "mangas": { "nodes": [{ "sourceId": "1", "url": "/a", "inLibrary": true }] }
            }),
            json!({
                "id": 3,
                "name": "Action",
                "order": 2,
                "mangas": { "nodes": [{ "sourceId": "1", "url": "/a", "inLibrary": true }] }
            }),
        ];
        let library_works = vec![
            json!({ "sourceId": "1", "url": "/a" }),
            json!({ "sourceId": "1", "url": "/b" }),
        ];
        let existing_categories = vec![
            (
                "action".to_owned(),
                json!({ "name": "Action", "order": 1, "flags": 0 }).to_string(),
            ),
            (
                "removed".to_owned(),
                json!({ "name": "Removed", "order": 3, "flags": 0 }).to_string(),
            ),
            (
                "completed".to_owned(),
                json!({ "name": "Completed", "order": 4, "flags": 0 }).to_string(),
            ),
        ];
        let existing_assignments = vec![
            // /b is in library_works (moved to Default-only) -> should be tombstoned.
            (
                "1:/b|action".to_owned(),
                json!({ "workKey": "1:/b", "categoryKey": "action" }).to_string(),
            ),
            // /missing is NOT in library_works -> must NOT be tombstoned.
            (
                "1:/missing|action".to_owned(),
                json!({ "workKey": "1:/missing", "categoryKey": "action" }).to_string(),
            ),
            // Completed assignment -> must NOT be tombstoned.
            (
                "1:/a|completed".to_owned(),
                json!({ "workKey": "1:/a", "categoryKey": "completed" }).to_string(),
            ),
        ];

        let known_works = BTreeSet::from(["1:/b".to_owned()]);
        let edits = plan_catalog_category_edits(
            &categories,
            &library_works,
            &existing_categories,
            &existing_assignments,
            &known_works,
        );

        assert!(edits.iter().any(|(ty, key, payload, deleted)| {
            *ty == "comic.work" && key == "1:/a" && payload["favorite"] == true && !*deleted
        }));

        assert!(edits.iter().any(|(ty, key, payload, deleted)| {
            *ty == "comic.category" && key == "action" && payload["order"] == 2 && !*deleted
        }));
        assert!(edits.iter().any(|(ty, key, _, deleted)| {
            *ty == "comic.category" && key == "removed" && *deleted
        }));
        assert!(edits.iter().any(|(ty, key, payload, deleted)| {
            *ty == "comic.category_assignment"
                && key == "1:/a|action"
                && payload["workKey"] == "1:/a"
                && payload["categoryKey"] == "action"
                && !*deleted
        }));
        assert!(edits.iter().any(|(ty, key, _, deleted)| {
            *ty == "comic.category_assignment" && key == "1:/b|action" && *deleted
        }));
        assert!(!edits.iter().any(|(_, key, _, _)| {
            key == "default"
                || key == "completed"
                || key == "1:/missing|action"
                || key == "1:/a|completed"
        }));
    }

    #[test]
    fn catalog_snapshot_is_used_only_while_the_projection_stays_settled() {
        let settled = |seq| Some(ProjectionProgress { applied: seq, target: seq });
        assert!(catalog_snapshot_is_current(None, None));
        assert!(catalog_snapshot_is_current(settled(5), settled(5)));
        // A phone commit between the snapshot and the write gate moves the target.
        assert!(!catalog_snapshot_is_current(
            settled(5),
            Some(ProjectionProgress { applied: 5, target: 6 })
        ));
        // A first remote record for a profile that never projected.
        assert!(!catalog_snapshot_is_current(None, settled(1)));
        assert!(!catalog_snapshot_is_current(settled(5), settled(6)));
        assert!(!ProjectionProgress::settled(Some(ProjectionProgress {
            applied: 0,
            target: 3
        })));
    }

    #[test]
    fn a_desktop_rewind_wins_over_older_progress_from_the_phone() {
        use crate::syncd::v4::merge::{merge_record, StoredRecordState};
        let record = |payload: Value, hlc: Hlc| StoredRecordState {
            domain: "comics".into(),
            entity_type: "comic.chapter".into(),
            entity_key: "1:/work|/work/ch-1".into(),
            payload,
            deleted: false,
            hlc: hlc.clone(),
            origin_device_id: hlc.device_id,
        };
        let phone_read = record(
            json!({"isRead": true, "lastPageRead": 12}),
            Hlc::new(1_000, 0, "phone"),
        );
        let edit_hlc = Hlc::new(2_000, 7, LOCAL_DESKTOP_ORIGIN);

        // Marked unread on the desktop: the phone's older read must not come back.
        let mut unread = json!({"isRead": false, "lastPageRead": 0, "isBookmarked": false});
        stamp_desktop_reset(&mut unread, &phone_read.payload, &edit_hlc);
        assert_eq!(
            unread["explicitResetHlc"],
            json!({"tsMs": 2_000, "counter": 6, "deviceId": LOCAL_DESKTOP_ORIGIN})
        );
        let merged = merge_record(Some(&phone_read), record(unread, edit_hlc.clone())).state;
        assert_eq!(merged.payload["isRead"], false);
        assert_eq!(merged.payload["lastPageRead"], 0);

        // Moved back to an earlier page: that page is kept, not cleared to zero.
        let in_progress = record(
            json!({"isRead": false, "lastPageRead": 12}),
            Hlc::new(1_000, 0, "phone"),
        );
        let mut earlier = json!({"isRead": false, "lastPageRead": 3});
        stamp_desktop_reset(&mut earlier, &in_progress.payload, &edit_hlc);
        let merged = merge_record(Some(&in_progress), record(earlier, edit_hlc.clone())).state;
        assert_eq!(merged.payload["lastPageRead"], 3);
        assert_eq!(merged.payload["isRead"], false);

        // Rereading a read chapter from an earlier page keeps it read.
        let mut reread = json!({"isRead": true, "lastPageRead": 2});
        stamp_desktop_reset(&mut reread, &phone_read.payload, &edit_hlc);
        let merged = merge_record(Some(&phone_read), record(reread, edit_hlc.clone())).state;
        assert_eq!(merged.payload["isRead"], true);
        assert_eq!(merged.payload["lastPageRead"], 2);

        // Forward progress and bookmark-only edits carry no reset.
        for payload in [
            json!({"isRead": true, "lastPageRead": 20}),
            json!({"isRead": true, "lastPageRead": 12, "isBookmarked": true}),
        ] {
            let mut forward = payload;
            stamp_desktop_reset(&mut forward, &phone_read.payload, &edit_hlc);
            assert!(forward.get("explicitResetHlc").is_none());
        }
    }
}

#[cfg(test)]
mod baseline_plan_tests {
    use super::*;
    use serde_json::json;

    const SOURCE: &str = "100";

    fn work(id: i64, url: &str, title: &str, in_library: bool) -> Value {
        json!({ "id": id, "sourceId": SOURCE, "url": url, "title": title, "inLibrary": in_library })
    }

    fn category(id: i64, name: &str, order: i64, members: Vec<Value>) -> Value {
        json!({ "id": id, "name": name, "order": order, "mangas": { "nodes": members } })
    }

    fn chapter(id: i64, manga_id: i64, url: &str, read: bool, bookmarked: bool, page: i64) -> Value {
        json!({
            "id": id, "mangaId": manga_id, "url": url, "name": format!("Chapter {id}"),
            "chapterNumber": id, "scanlator": null,
            "isRead": read, "isBookmarked": bookmarked, "lastPageRead": page,
        })
    }

    fn store(planned: &[(&'static str, String, Value)]) -> BTreeMap<(String, String), StoredComicRecord> {
        planned
            .iter()
            .map(|(entity_type, key, payload)| {
                (
                    ((*entity_type).to_owned(), key.clone()),
                    StoredComicRecord { deleted: false, payload: payload.clone() },
                )
            })
            .collect()
    }

    fn of_type<'a>(
        planned: &'a [(&'static str, String, Value)],
        entity_type: &str,
    ) -> Vec<&'a (&'static str, String, Value)> {
        planned.iter().filter(|(kind, _, _)| *kind == entity_type).collect()
    }

    fn key_of(url: &str) -> String {
        canonical_work_key(SOURCE, url)
    }

    #[test]
    fn default_only_and_completed_only_works_are_published_with_their_title() {
        let library = vec![
            work(1, "https://s/default-only", "Default Only", true),
            work(2, "https://s/completed-only", "Completed Only", true),
        ];
        let categories = vec![
            category(0, "Default", 0, vec![library[0].clone()]),
            category(-2, "Completed", 1, vec![library[1].clone()]),
        ];
        let planned = plan_comic_library_baseline(&library, &[], &categories, &BTreeMap::new());
        let works = of_type(&planned, "comic.work");
        assert_eq!(works.len(), 2);
        let default_only = works.iter().find(|(_, key, _)| *key == key_of("https://s/default-only")).unwrap();
        assert_eq!(default_only.2["title"], "Default Only");
        assert_eq!(default_only.2["favorite"], true);
        assert_eq!(default_only.2["sourceId"], SOURCE);
        assert_eq!(default_only.2["url"], "https://s/default-only");
        let completed_only = works.iter().find(|(_, key, _)| *key == key_of("https://s/completed-only")).unwrap();
        assert_eq!(completed_only.2["title"], "Completed Only");
        // Reserved folders are never shared as categories, and Default is not an assignment.
        assert!(of_type(&planned, "comic.category").is_empty());
        assert!(of_type(&planned, "comic.category_assignment").is_empty());
    }

    #[test]
    fn real_categories_and_their_memberships_are_published_once() {
        let library = vec![work(1, "https://s/a", "Alpha", true)];
        let categories = vec![
            category(0, "Default", 0, vec![library[0].clone()]),
            category(7, "  Reading ", 2, vec![library[0].clone()]),
        ];
        let planned = plan_comic_library_baseline(&library, &[], &categories, &BTreeMap::new());
        let real = of_type(&planned, "comic.category");
        assert_eq!(real.len(), 1);
        assert_eq!(real[0].1, "reading");
        assert_eq!(real[0].2["name"], "Reading");
        assert_eq!(real[0].2["order"], 2);
        let assignments = of_type(&planned, "comic.category_assignment");
        assert_eq!(assignments.len(), 1);
        assert_eq!(assignments[0].1, format!("{}|reading", key_of("https://s/a")));
        assert_eq!(assignments[0].2["workKey"], key_of("https://s/a"));
        assert_eq!(assignments[0].2["categoryKey"], "reading");
    }

    #[test]
    fn a_second_run_plans_nothing_once_the_first_run_is_stored() {
        let library = vec![
            work(1, "https://s/a", "Alpha", true),
            work(2, "https://s/b", "Beta", true),
        ];
        let chapters = vec![
            chapter(11, 1, "https://s/a/1", true, false, 0),
            chapter(12, 1, "https://s/a/2", false, false, 7),
        ];
        let categories = vec![category(7, "Reading", 1, vec![library[0].clone()])];
        let first = plan_comic_library_baseline(&library, &chapters, &categories, &BTreeMap::new());
        assert!(!first.is_empty());
        let second = plan_comic_library_baseline(&library, &chapters, &categories, &store(&first));
        assert!(second.is_empty(), "stored records must not be emitted again: {second:?}");
    }

    #[test]
    fn tombstoned_works_are_never_resurrected_with_their_memberships_or_chapters() {
        let library = vec![work(1, "https://s/gone", "Gone", true)];
        let categories = vec![category(7, "Reading", 1, vec![library[0].clone()])];
        let chapters = vec![chapter(11, 1, "https://s/gone/1", true, true, 4)];
        let mut stored = BTreeMap::new();
        stored.insert(
            ("comic.work".to_owned(), key_of("https://s/gone")),
            StoredComicRecord { deleted: true, payload: Value::Null },
        );
        let planned = plan_comic_library_baseline(&library, &chapters, &categories, &stored);
        // The real category is still shared, but the tombstoned work, its membership and its
        // chapter progress never come back.
        assert!(of_type(&planned, "comic.work").is_empty(), "{planned:?}");
        assert!(of_type(&planned, "comic.category_assignment").is_empty(), "{planned:?}");
        assert!(of_type(&planned, "comic.chapter").is_empty(), "{planned:?}");
    }

    #[test]
    fn a_stored_work_is_kept_and_its_membership_is_still_filled() {
        let library = vec![work(1, "https://s/a", "Alpha", true)];
        let categories = vec![category(7, "Reading", 1, vec![library[0].clone()])];
        let mut stored = BTreeMap::new();
        stored.insert(
            ("comic.work".to_owned(), key_of("https://s/a")),
            StoredComicRecord { deleted: false, payload: json!({ "title": "Core title" }) },
        );
        let planned = plan_comic_library_baseline(&library, &[], &categories, &stored);
        assert!(of_type(&planned, "comic.work").is_empty());
        assert_eq!(of_type(&planned, "comic.category").len(), 1);
        assert_eq!(of_type(&planned, "comic.category_assignment").len(), 1);
    }

    #[test]
    fn chapter_progress_is_published_and_never_moves_backwards() {
        let library = vec![work(1, "https://s/a", "Alpha", true)];
        let work_key = key_of("https://s/a");
        let read_key = canonical_chapter_key(&work_key, "https://s/a/1");
        let ahead_key = canonical_chapter_key(&work_key, "https://s/a/2");
        let untouched_key = canonical_chapter_key(&work_key, "https://s/a/3");
        let chapters = vec![
            chapter(11, 1, "https://s/a/1", true, false, 0),
            // Core already holds further progress on this chapter: nothing is published.
            chapter(12, 1, "https://s/a/2", false, false, 5),
            chapter(13, 1, "https://s/a/3", false, false, 0),
        ];
        let mut stored = BTreeMap::new();
        stored.insert(
            ("comic.work".to_owned(), work_key.clone()),
            StoredComicRecord { deleted: false, payload: Value::Null },
        );
        stored.insert(
            ("comic.chapter".to_owned(), ahead_key.clone()),
            StoredComicRecord {
                deleted: false,
                payload: json!({ "isRead": true, "isBookmarked": false, "lastPageRead": 9 }),
            },
        );
        let planned = plan_comic_library_baseline(&library, &chapters, &[], &stored);
        let published = of_type(&planned, "comic.chapter");
        assert_eq!(published.len(), 1, "{published:?}");
        assert_eq!(published[0].1, read_key);
        assert_eq!(published[0].2["isRead"], true);
        assert_eq!(published[0].2["workKey"], work_key);
        assert!(published.iter().all(|(_, key, _)| *key != ahead_key && *key != untouched_key));
        assert!(published[0].2.get("explicitResetHlc").is_none());
    }

    #[test]
    fn a_chapter_with_a_stored_reset_or_tombstone_is_left_to_core() {
        let library = vec![work(1, "https://s/a", "Alpha", true)];
        let work_key = key_of("https://s/a");
        let reset_key = canonical_chapter_key(&work_key, "https://s/a/1");
        let tomb_key = canonical_chapter_key(&work_key, "https://s/a/2");
        let chapters = vec![
            chapter(11, 1, "https://s/a/1", true, false, 3),
            chapter(12, 1, "https://s/a/2", true, false, 3),
        ];
        let mut stored = BTreeMap::new();
        stored.insert(
            ("comic.work".to_owned(), work_key),
            StoredComicRecord { deleted: false, payload: Value::Null },
        );
        stored.insert(
            ("comic.chapter".to_owned(), reset_key),
            StoredComicRecord {
                deleted: false,
                payload: json!({ "isRead": false, "lastPageRead": 0, "explicitResetHlc": "1" }),
            },
        );
        stored.insert(
            ("comic.chapter".to_owned(), tomb_key),
            StoredComicRecord { deleted: true, payload: Value::Null },
        );
        let planned = plan_comic_library_baseline(&library, &chapters, &[], &stored);
        assert!(of_type(&planned, "comic.chapter").is_empty(), "{planned:?}");
    }
}
