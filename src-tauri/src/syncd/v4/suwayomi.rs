//! Converts portable comic state to the same Mihon backup format supported by Suwayomi.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

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

pub(in crate::syncd) async fn capture_local_edits(
    state: &SharedAppState,
    runtime: &V4Runtime,
    profile: &str,
    work_ids: Vec<i64>,
    chapter_ids: Vec<i64>,
    catalog: bool,
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
    let catalog_snapshot = if catalog {
        let categories_query = r#"
          query EpigraphV4LocalCategories($first: Int!, $offset: Int!) {
            categories(first: $first, offset: $offset) {
              nodes {
                id
                name
                order
                mangas {
                  nodes { sourceId url title inLibrary }
                }
              }
              pageInfo { hasNextPage }
            }
          }
        "#;
        let library_query = r#"
          query EpigraphV4LocalLibraryWorks($first: Int!, $offset: Int!) {
            mangas(condition: { inLibrary: true }, first: $first, offset: $offset) {
              nodes { sourceId url }
              pageInfo { hasNextPage }
            }
          }
        "#;
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
        Some((categories, library_works))
    } else {
        None
    };
    if updates.is_empty() && parents.is_empty() && catalog_snapshot.is_none() {
        return Ok(());
    }
    let _guard = runtime.write_gate.lock().await;
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
        return Ok(());
    }
    let items = items
        .into_iter()
        .enumerate()
        .map(
            |(index, (entity_type, entity_key, payload, deleted))| db::V4IncomingItem {
                client_mutation_id: None,
                domain: "comics".to_owned(),
                entity_type: entity_type.to_owned(),
                entity_key,
                deleted,
                hlc: super::hlc::Hlc::new(
                    now,
                    watermark.current_seq.saturating_add(index as i64),
                    LOCAL_DESKTOP_ORIGIN,
                ),
                payload,
            },
        )
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
    Ok(())
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
    for work in library_works {
        let Some(source) = scalar_text(&work["sourceId"]) else {
            continue;
        };
        if source == "0" {
            continue;
        }
        let Some(url) = work["url"].as_str() else {
            continue;
        };
        live_library_works.insert(canonical_work_key(&source, url));
    }

    let mut live_categories = BTreeMap::new();
    let mut live_assignments = BTreeMap::new();
    let mut missing_parent_works = BTreeMap::new();
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
                    missing_parent_works.entry(work_key.clone()).or_insert_with(|| {
                        json!({
                            "sourceId": source,
                            "url": url,
                            "title": manga["title"].as_str().unwrap_or(url),
                            "favorite": true,
                        })
                    });
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
        }
    });
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
      nodes { id mangaId url chapterNumber scanlator isRead isBookmarked lastPageRead }
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
        for node in nodes {
            if let (Some(id), Some(name)) = (
                node["id"].as_i64().filter(|id| *id > 0),
                node["name"].as_str(),
            ) {
                categories.insert(name.trim().to_lowercase(), id);
            }
        }
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
                    .is_some_and(|name| name.trim().eq_ignore_ascii_case("completed"))
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
}
