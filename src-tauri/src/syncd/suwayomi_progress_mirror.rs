use std::collections::{BTreeSet, HashSet};
use std::time::Duration;

use anyhow::Context;
use serde_json::{json, Value};
use sqlx::FromRow;

use super::lifecycle::{wait_for_shutdown_request, ShutdownRequest};
use super::models::{
    canonical_portable_chapter_id, canonical_portable_work_id, AuthenticatedSession,
    ComicHistoryPatch, EventClock, PortableChapterBindingRow, PortableChapterRefV3,
    PortableWorkBindingRow, PortableWorkRefV3, SharedAppState,
};
use super::routes::suwayomi_catalog;
use super::{db, suwayomi_process};

/// How often the desktop's Suwayomi reading progress is re-imported into the syncd
/// replica so the snapshot/replay serve it to paired mobile devices.
const MIRROR_INTERVAL: Duration = Duration::from_secs(45);
const MIRROR_PAGE_SIZE: i64 = 250;
const MAX_MIRROR_PAGES: usize = 32;
const MIRROR_DEVICE_ID: &str = "epigraph-core-mirror";
const MIRROR_TOKEN_ID: &str = "epigraph-core-mirror";

const LIBRARY_WITH_PROGRESS_QUERY: &str = r#"
  query EpigraphProgressMirrorLibrary($first: Int!, $offset: Int!) {
    mangas(condition: { inLibrary: true }, first: $first, offset: $offset) {
      totalCount
      pageInfo { hasNextPage }
      nodes {
        id
        url
        sourceId
        latestReadChapter {
          id
          url
          isRead
          lastReadAt
          lastPageRead
          pageCount
        }
      }
    }
  }
"#;

const BOOKMARKED_CHAPTERS_QUERY: &str = r#"
  query EpigraphProgressMirrorBookmarks($first: Int!, $offset: Int!) {
    chapters(condition: { isBookmarked: true }, first: $first, offset: $offset) {
      pageInfo { hasNextPage }
      nodes {
        id
        mangaId
        url
        isRead
        lastReadAt
        lastPageRead
        pageCount
      }
    }
  }
"#;
/// Spawns the periodic Suwayomi progress mirror. It fills `comic.history` and
/// `comic.chapter_state` rows from the desktop runtime so the authoritative
/// snapshot serves reading progress to paired mobile devices.
pub fn spawn_progress_mirror_task(
    state: SharedAppState,
    mut shutdown: tokio::sync::watch::Receiver<Option<ShutdownRequest>>,
) {
    tokio::spawn(async move {
        tracing::info!("Suwayomi progress mirror started");
        // Do not contend with pairing/bootstrap writes during Core startup. The mirror is a
        // repair loop; it does not need an immediate tick because successful Suwayomi commands
        // publish confirmed progress synchronously.
        let mut ticker = tokio::time::interval_at(
            tokio::time::Instant::now() + MIRROR_INTERVAL,
            MIRROR_INTERVAL,
        );
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    match mirror_all_profiles(&state).await {
                        Ok(mirrored) => tracing::debug!(mirrored, "Suwayomi progress mirror tick completed"),
                        Err(error) => tracing::warn!(error = %error, "failed to mirror Suwayomi reading progress"),
                    }
                }
                _ = wait_for_shutdown_request(&mut shutdown) => break,
            }
        }
    });
}

async fn mirror_all_profiles(state: &SharedAppState) -> anyhow::Result<usize> {
    let mut total = 0usize;
    let instances = suwayomi_process::attach_owned_instances();
    tracing::debug!(
        profiles = instances.len(),
        "Suwayomi progress mirror discovered profiles"
    );
    for instance in instances {
        match mirror_profile(state, &instance.profile_key).await {
            Ok(mirrored) => total += mirrored,
            Err(error) => {
                tracing::warn!(
                    profile = %instance.profile_key,
                    error = %error,
                    "Suwayomi progress mirror skipped profile",
                );
            }
        }
    }
    Ok(total)
}

async fn mirror_profile(state: &SharedAppState, profile_id: &str) -> anyhow::Result<usize> {
    let session = AuthenticatedSession {
        token_id: MIRROR_TOKEN_ID.to_string(),
        device_id: MIRROR_DEVICE_ID.to_string(),
        profile_id: profile_id.to_string(),
        scopes: BTreeSet::from([format!("comics:profile:{profile_id}")]),
        mutation_receipt: None,
    };
    let scope_id = format!("comics:profile:{profile_id}");
    let retention_window = state.config.retention_window;
    let server_identity = db::load_server_identity(&state.pool).await?;
    let server_id = &server_identity.server_id;

    let library = fetch_library_with_progress(state, &session).await?;
    let manga_refs = library
        .iter()
        .map(|(manga_id, _)| *manga_id)
        .collect::<HashSet<_>>();

    let mut mirrored = 0usize;
    for (manga_id, node) in &library {
        let Some(chapter) = node.latest_read_chapter.as_ref() else {
            continue;
        };
        let portable = load_portable_refs(state, profile_id, *manga_id, chapter.chapter_id).await?;
        let (comic_id, chapter_id, portable_work_ref, portable_chapter_ref) = history_identity(
            server_id,
            profile_id,
            *manga_id,
            chapter.chapter_id,
            portable,
        );
        let entity_id = format!("comic.history::{comic_id}");
        let progress_percent = match (chapter.page_count, chapter.last_page_read) {
            (Some(page_count), page) if page > 0 => {
                (page as f64 / page_count as f64).clamp(0.0, 1.0)
            }
            _ => 1.0,
        };
        let patch = ComicHistoryPatch {
            history_id: entity_id.clone(),
            comic_id: comic_id.clone(),
            chapter_id: chapter_id.clone(),
            portable_work_ref,
            portable_chapter_ref,
            page_index: chapter.last_page_read,
            page_count: chapter.page_count,
            progress_percent,
            read_at_ms: chapter.last_read_at,
        };
        if needs_comic_history_write(state, &scope_id, &entity_id, &patch).await? {
            let _writer_guard = state.mutation_gate.lock().await;
            let outcome = db::apply_comic_history_mutation(
                &state.pool,
                &session,
                &scope_id,
                &entity_id,
                &patch,
                0,
                None,
                retention_window,
            )
            .await?;
            if publish_applied_change(state, &outcome) {
                mirrored += 1;
            }
        }
    }
    let bookmarks = fetch_bookmarked_chapters(state, &session).await?;
    tracing::debug!(
        bookmarks = bookmarks.len(),
        eligible_mangas = manga_refs.len(),
        "Suwayomi bookmark mirror inventory loaded"
    );
    let bookmark_observed_at_ms = db::now_ms();
    let mut observed_bookmark_entities = HashSet::with_capacity(bookmarks.len());
    for bookmark in &bookmarks {
        if !manga_refs.contains(&bookmark.manga_id) {
            tracing::debug!(
                manga_id = bookmark.manga_id,
                chapter_id = bookmark.chapter_id,
                "Suwayomi bookmark ignored because its manga is outside the eligible library set"
            );
            continue;
        }
        let portable =
            load_portable_refs(state, profile_id, bookmark.manga_id, bookmark.chapter_id).await?;
        let (comic_id, chapter_id, portable_work_ref, portable_chapter_ref) = history_identity(
            server_id,
            profile_id,
            bookmark.manga_id,
            bookmark.chapter_id,
            portable,
        );
        let entity_id = format!("comic.chapter_state::{comic_id}::{chapter_id}");
        observed_bookmark_entities.insert(entity_id.clone());
        let portable_identity = portable_work_ref.is_some();
        let record = json!({
            "chapterStateId": entity_id,
            "comicId": comic_id,
            "chapterId": chapter_id,
            "portableWorkRef": portable_work_ref,
            "portableChapterRef": portable_chapter_ref,
            "coreServerId": server_id,
            "coreProfileId": profile_id,
            "suwayomiMangaId": bookmark.manga_id,
            "suwayomiChapterId": bookmark.chapter_id,
            "read": bookmark.is_read,
            "bookmarked": true,
            "lastPageRead": (bookmark.last_page_read > 0).then_some(bookmark.last_page_read),
            "lastReadAtMs": (bookmark.last_read_at > 0).then_some(bookmark.last_read_at),
            // Suwayomi does not expose a bookmark-updated timestamp. The observation time lets a
            // newer desktop command win over an older mobile record, while the semantic equality
            // guard below prevents a revision on every mirror tick.
            "updatedAtMs": bookmark_observed_at_ms,
            "explicitProgressReset": false,
        });
        let record_json = serde_json::to_string(&record)?;
        let needs_write =
            needs_chapter_state_write(state, &scope_id, &entity_id, &record_json).await?;
        tracing::debug!(
            manga_id = bookmark.manga_id,
            chapter_id = bookmark.chapter_id,
            portable = portable_identity,
            needs_write,
            "Suwayomi bookmark mirror evaluated chapter state"
        );
        if needs_write {
            let event_clock = EventClock {
                physical_ms: bookmark_observed_at_ms,
                logical: 0,
                device_generation_id: MIRROR_DEVICE_ID.to_string(),
            };
            let _writer_guard = state.mutation_gate.lock().await;
            let outcome = db::apply_mirrored_comic_sync_state_mutation(
                &state.pool,
                &session,
                &scope_id,
                "comic.chapter_state",
                &entity_id,
                &record,
                bookmark_observed_at_ms,
                Some(&event_clock),
                retention_window,
            )
            .await?;
            tracing::debug!(?outcome, "Suwayomi bookmark mirror write completed");
            if publish_applied_change(state, &outcome) {
                mirrored += 1;
            }
        }
    }
    mirrored += clear_removed_bookmarks(
        state,
        &session,
        &scope_id,
        server_id,
        profile_id,
        &manga_refs,
        &observed_bookmark_entities,
        bookmark_observed_at_ms,
        retention_window,
    )
    .await?;
    Ok(mirrored)
}

/// Publishes an applied mirror write to live `/v1/events` subscribers.
///
/// Mirror writes append to `change_log` exactly like `/v1/mutations`. SSE subscribers
/// deduplicate by `server_version` and resume with `Last-Event-ID`, so a change that is
/// persisted but never broadcast is skipped permanently once any later change is delivered.
/// Callers hold `mutation_gate`, which keeps broadcast order equal to commit order.
fn publish_applied_change(
    state: &SharedAppState,
    outcome: &db::CausalMutationWriteOutcome,
) -> bool {
    match outcome {
        db::CausalMutationWriteOutcome::Applied(applied) => {
            let _ = state.change_sender.send(applied.envelope.clone());
            true
        }
        db::CausalMutationWriteOutcome::Superseded { .. } => false,
    }
}

#[derive(FromRow)]
struct StoredBookmarkRow {
    entity_id: String,
    record_json: String,
}

#[allow(clippy::too_many_arguments)]
async fn clear_removed_bookmarks(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    scope_id: &str,
    server_id: &str,
    profile_id: &str,
    library_manga_ids: &HashSet<i64>,
    observed_entities: &HashSet<String>,
    observed_at_ms: i64,
    retention_window: Duration,
) -> anyhow::Result<usize> {
    let rows = sqlx::query_as::<_, StoredBookmarkRow>(
        r#"
        SELECT entity_id, record_json
        FROM comic_sync_state
        WHERE scope_id = ? AND entity_type = 'comic.chapter_state'
        "#,
    )
    .bind(scope_id)
    .fetch_all(&state.pool)
    .await
    .context("failed to load stored comic bookmarks for mirror reconciliation")?;
    let mut cleared = 0usize;
    for row in rows {
        if observed_entities.contains(&row.entity_id) {
            continue;
        }
        let Ok(mut record) = serde_json::from_str::<Value>(&row.record_json) else {
            continue;
        };
        let Some(object) = record.as_object_mut() else {
            continue;
        };
        let bookmarked = object
            .get("bookmarked")
            .or_else(|| object.get("bookmark"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !bookmarked
            || !chapter_state_belongs_to_library(
                state,
                profile_id,
                server_id,
                object,
                library_manga_ids,
            )
            .await?
        {
            continue;
        }
        object.remove("bookmark");
        object.insert("bookmarked".to_string(), Value::Bool(false));
        object.insert("updatedAtMs".to_string(), Value::from(observed_at_ms));
        let event_clock = EventClock {
            physical_ms: observed_at_ms,
            logical: 0,
            device_generation_id: MIRROR_DEVICE_ID.to_string(),
        };
        let _writer_guard = state.mutation_gate.lock().await;
        let outcome = db::apply_mirrored_comic_sync_state_mutation(
            &state.pool,
            session,
            scope_id,
            "comic.chapter_state",
            &row.entity_id,
            &record,
            observed_at_ms,
            Some(&event_clock),
            retention_window,
        )
        .await?;
        if publish_applied_change(state, &outcome) {
            cleared += 1;
        }
    }
    Ok(cleared)
}

async fn chapter_state_belongs_to_library(
    state: &SharedAppState,
    profile_id: &str,
    server_id: &str,
    record: &serde_json::Map<String, Value>,
    library_manga_ids: &HashSet<i64>,
) -> anyhow::Result<bool> {
    if let Some(manga_id) = record.get("suwayomiMangaId").and_then(Value::as_i64) {
        return Ok(library_manga_ids.contains(&manga_id));
    }
    if let Some(work_value) = record
        .get("portableWorkRef")
        .filter(|value| !value.is_null())
    {
        let Ok(work) = serde_json::from_value::<PortableWorkRefV3>(work_value.clone()) else {
            return Ok(false);
        };
        if work.validate().is_err() {
            return Ok(false);
        }
        let work_id = canonical_portable_work_id(&work);
        let binding = db::load_portable_work_binding(&state.pool, profile_id, &work_id).await?;
        let manga_id = binding
            .filter(|binding| binding.resolution_state == "BOUND")
            .and_then(|binding| binding.local_reference)
            .and_then(|value| value.parse::<i64>().ok());
        return Ok(manga_id.is_some_and(|id| library_manga_ids.contains(&id)));
    }
    let prefix = format!("suwayomi:server:{server_id}:profile:{profile_id}:manga:");
    let manga_id = record
        .get("comicId")
        .and_then(Value::as_str)
        .and_then(|value| value.strip_prefix(&prefix))
        .and_then(|value| value.parse::<i64>().ok());
    Ok(manga_id.is_some_and(|id| library_manga_ids.contains(&id)))
}

type PortableComicRefs = (PortableWorkRefV3, PortableChapterRefV3);

async fn load_portable_refs(
    state: &SharedAppState,
    profile_id: &str,
    manga_id: i64,
    chapter_id: i64,
) -> anyhow::Result<Option<PortableComicRefs>> {
    let chapter_rows = sqlx::query_as::<_, PortableChapterBindingRow>(
        r#"
        SELECT * FROM portable_chapter_bindings
        WHERE profile_id = ? AND local_reference = ? AND resolution_state = 'BOUND'
        ORDER BY updated_at_ms DESC
        LIMIT 2
        "#,
    )
    .bind(profile_id)
    .bind(chapter_id.to_string())
    .fetch_all(&state.pool)
    .await
    .context("failed to resolve portable chapter for the progress mirror")?;
    if chapter_rows.len() != 1 {
        return Ok(None);
    }
    let chapter = &chapter_rows[0];
    let Some(work) =
        db::load_portable_work_binding(&state.pool, profile_id, &chapter.portable_work_id).await?
    else {
        return Ok(None);
    };
    Ok(portable_refs_from_bindings(
        &work, chapter, manga_id, chapter_id,
    ))
}

fn portable_refs_from_bindings(
    work: &PortableWorkBindingRow,
    chapter: &PortableChapterBindingRow,
    manga_id: i64,
    chapter_id: i64,
) -> Option<PortableComicRefs> {
    if work.profile_id != chapter.profile_id
        || work.portable_id != chapter.portable_work_id
        || work.ecosystem != "SUWAYOMI"
        || work.resolution_state != "BOUND"
        || chapter.resolution_state != "BOUND"
        || work.local_reference.as_deref()?.parse::<i64>().ok()? != manga_id
        || chapter.local_reference.as_deref()?.parse::<i64>().ok()? != chapter_id
    {
        return None;
    }
    let work_ref = work.portable_ref().ok()?;
    let chapter_ref = PortableChapterRefV3::comic(work_ref.clone(), chapter.provider_key.clone());
    chapter_ref.validate().ok()?;
    if canonical_portable_work_id(&work_ref) != work.portable_id
        || canonical_portable_chapter_id(&chapter_ref) != chapter.portable_chapter_id
    {
        return None;
    }
    Some((work_ref, chapter_ref))
}

fn history_identity(
    server_id: &str,
    profile_id: &str,
    manga_id: i64,
    chapter_id: i64,
    portable: Option<PortableComicRefs>,
) -> (
    String,
    String,
    Option<PortableWorkRefV3>,
    Option<PortableChapterRefV3>,
) {
    match portable {
        Some((work, chapter)) => (
            canonical_portable_work_id(&work),
            canonical_portable_chapter_id(&chapter),
            Some(work),
            Some(chapter),
        ),
        None => (
            format!("suwayomi:server:{server_id}:profile:{profile_id}:manga:{manga_id}"),
            format!("suwayomi:server:{server_id}:profile:{profile_id}:chapter:{chapter_id}"),
            None,
            None,
        ),
    }
}

#[derive(Clone)]
struct LibraryMangaNode {
    latest_read_chapter: Option<ReadChapterNode>,
}

#[derive(Clone)]
struct ReadChapterNode {
    chapter_id: i64,
    is_read: bool,
    last_read_at: i64,
    last_page_read: i64,
    page_count: Option<i64>,
}

async fn fetch_library_with_progress(
    state: &SharedAppState,
    session: &AuthenticatedSession,
) -> anyhow::Result<Vec<(i64, LibraryMangaNode)>> {
    let mut mangas = Vec::new();
    for page in 0..MAX_MIRROR_PAGES {
        let offset = (page as i64).saturating_mul(MIRROR_PAGE_SIZE);
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            LIBRARY_WITH_PROGRESS_QUERY,
            json!({ "first": MIRROR_PAGE_SIZE, "offset": offset }),
            false,
        )
        .await
        .map_err(|error| anyhow::anyhow!("library progress mirror query failed: {error:?}"))?;
        let connection = data
            .get("mangas")
            .and_then(Value::as_object)
            .context("invalid library progress mirror response")?;
        let nodes = connection
            .get("nodes")
            .and_then(Value::as_array)
            .context("invalid library progress mirror nodes")?;
        for node in nodes {
            let Some(manga_id) = node
                .get("id")
                .and_then(Value::as_i64)
                .filter(|value| *value > 0)
            else {
                continue;
            };
            let Some(source_id) = scalar_string(node.get("sourceId")) else {
                continue;
            };
            let Some(manga_key) = text(node.get("url")).map(str::to_string) else {
                continue;
            };
            let latest_read_chapter = node
                .get("latestReadChapter")
                .filter(|value| !value.is_null())
                .and_then(parse_read_chapter)
                .filter(|chapter| chapter.is_read);
            if latest_read_chapter.is_some() {
                let _ = (source_id, manga_key);
                mangas.push((
                    manga_id,
                    LibraryMangaNode {
                        latest_read_chapter,
                    },
                ));
            }
        }
        let has_next = connection
            .get("pageInfo")
            .and_then(|value| value.get("hasNextPage"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !has_next {
            break;
        }
    }
    Ok(mangas)
}
fn parse_read_chapter(chapter: &Value) -> Option<ReadChapterNode> {
    let chapter_id = chapter
        .get("id")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)?;
    Some(ReadChapterNode {
        chapter_id,
        is_read: chapter
            .get("isRead")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        last_read_at: chapter
            .get("lastReadAt")
            .and_then(Value::as_str)
            .map(suwayomi_epoch_ms)
            .unwrap_or(0),
        last_page_read: chapter
            .get("lastPageRead")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0),
        page_count: chapter
            .get("pageCount")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0),
    })
}

#[derive(Clone)]
struct BookmarkedChapterNode {
    manga_id: i64,
    chapter_id: i64,
    is_read: bool,
    last_read_at: i64,
    last_page_read: i64,
}

async fn fetch_bookmarked_chapters(
    state: &SharedAppState,
    session: &AuthenticatedSession,
) -> anyhow::Result<Vec<BookmarkedChapterNode>> {
    let mut chapters = Vec::new();
    for page in 0..MAX_MIRROR_PAGES {
        let offset = (page as i64).saturating_mul(MIRROR_PAGE_SIZE);
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            BOOKMARKED_CHAPTERS_QUERY,
            json!({ "first": MIRROR_PAGE_SIZE, "offset": offset }),
            false,
        )
        .await
        .map_err(|error| anyhow::anyhow!("bookmarked chapters mirror query failed: {error:?}"))?;
        let connection = data
            .get("chapters")
            .and_then(Value::as_object)
            .context("invalid bookmarked chapters mirror response")?;
        let nodes = connection
            .get("nodes")
            .and_then(Value::as_array)
            .context("invalid bookmarked chapters mirror nodes")?;
        for node in nodes {
            let Some(manga_id) = node
                .get("mangaId")
                .and_then(Value::as_i64)
                .filter(|value| *value > 0)
            else {
                continue;
            };
            let Some(chapter_id) = node
                .get("id")
                .and_then(Value::as_i64)
                .filter(|value| *value > 0)
            else {
                continue;
            };
            chapters.push(BookmarkedChapterNode {
                manga_id,
                chapter_id,
                is_read: node.get("isRead").and_then(Value::as_bool).unwrap_or(false),
                last_read_at: node
                    .get("lastReadAt")
                    .and_then(Value::as_str)
                    .map(suwayomi_epoch_ms)
                    .unwrap_or(0),
                last_page_read: node
                    .get("lastPageRead")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(0),
            });
        }
        let has_next = connection
            .get("pageInfo")
            .and_then(|value| value.get("hasNextPage"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !has_next {
            break;
        }
    }
    Ok(chapters)
}

/// Suwayomi reports `lastReadAt` as a LongString. Recent builds emit epoch seconds;
/// normalize to epoch milliseconds (0 when the runtime does not track a timestamp).
fn suwayomi_epoch_ms(raw: &str) -> i64 {
    let parsed = raw.trim().parse::<i64>().unwrap_or(0);
    if parsed <= 0 {
        return 0;
    }
    if parsed < 10_000_000_000 {
        parsed.saturating_mul(1_000)
    } else {
        parsed
    }
}

fn scalar_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn text(value: Option<&Value>) -> Option<&str> {
    value?.as_str().filter(|value| !value.is_empty())
}

#[derive(FromRow)]
struct StoredComicHistoryRow {
    record_updated_by_device_id: String,
    chapter_id: String,
    page_index: i64,
    page_count: Option<i64>,
    progress_percent: f64,
    read_at_ms: i64,
}

/// Guard that keeps "most recent progress wins" semantics: the mirror never
/// replaces a position written by a mobile device unless Suwayomi can prove its
/// read time is strictly newer, and it skips byte-identical re-imports of its own
/// rows so the change stream stays quiet between real reading-progress changes.
async fn needs_comic_history_write(
    state: &SharedAppState,
    scope_id: &str,
    entity_id: &str,
    patch: &ComicHistoryPatch,
) -> anyhow::Result<bool> {
    let row = sqlx::query_as::<_, StoredComicHistoryRow>(
        r#"
        SELECT record_updated_by_device_id, chapter_id, page_index, page_count,
               progress_percent, read_at_ms
        FROM comic_history
        WHERE scope_id = ? AND history_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&state.pool)
    .await
    .context("failed to load stored comic history for the progress mirror")?;
    let Some(row) = row else {
        return Ok(true);
    };
    if row.record_updated_by_device_id != MIRROR_DEVICE_ID {
        return Ok(patch.read_at_ms > row.read_at_ms);
    }
    // Suwayomi's lastReadAt drifts between polls, so it is intentionally not part of the
    // equality check; semantic fields (chapter, page position) keep the change stream quiet.
    Ok(patch.chapter_id != row.chapter_id
        || patch.page_index != row.page_index
        || patch.page_count != row.page_count
        || (patch.progress_percent - row.progress_percent).abs() > f64::EPSILON)
}

#[derive(FromRow)]
struct StoredChapterStateRow {
    record_updated_by_device_id: String,
    record_updated_at_ms: i64,
    record_json: String,
}

async fn needs_chapter_state_write(
    state: &SharedAppState,
    scope_id: &str,
    entity_id: &str,
    record_json: &str,
) -> anyhow::Result<bool> {
    let row = sqlx::query_as::<_, StoredChapterStateRow>(
        r#"
        SELECT record_updated_by_device_id, record_updated_at_ms, record_json
        FROM comic_sync_state
        WHERE scope_id = ? AND entity_type = 'comic.chapter_state' AND entity_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&state.pool)
    .await
    .context("failed to load stored comic chapter state for the progress mirror")?;
    let Some(row) = row else {
        return Ok(true);
    };
    if chapter_state_semantically_equal(&row.record_json, record_json) {
        return Ok(false);
    }
    if row.record_updated_by_device_id != MIRROR_DEVICE_ID {
        let incoming_updated_at = serde_json::from_str::<Value>(record_json)
            .ok()
            .and_then(|value| value.get("updatedAtMs").and_then(Value::as_i64))
            .unwrap_or(0);
        return Ok(incoming_updated_at > row.record_updated_at_ms);
    }
    Ok(true)
}

fn chapter_state_semantically_equal(stored_json: &str, incoming_json: &str) -> bool {
    fn semantic_state(raw: &str) -> Option<(Option<bool>, Option<bool>, Option<i64>)> {
        let value = serde_json::from_str::<Value>(raw).ok()?;
        Some((
            value.get("read").and_then(Value::as_bool),
            value
                .get("bookmarked")
                .or_else(|| value.get("bookmark"))
                .and_then(Value::as_bool),
            value
                .get("lastPageRead")
                .or_else(|| value.get("pageIndex"))
                .and_then(Value::as_i64),
        ))
    }
    semantic_state(stored_json) == semantic_state(incoming_json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bound_comic_rows() -> (PortableWorkBindingRow, PortableChapterBindingRow) {
        let work_ref = PortableWorkRefV3::comic("1024627298672457456", "/manga/example");
        let work_id = canonical_portable_work_id(&work_ref);
        let chapter_ref =
            PortableChapterRefV3::comic(work_ref, "https://example.test/manga/example/chapter-1");
        let chapter_id = canonical_portable_chapter_id(&chapter_ref);
        (
            PortableWorkBindingRow {
                profile_id: "main".to_string(),
                portable_id: work_id.clone(),
                ecosystem: "SUWAYOMI".to_string(),
                source_id: Some("1024627298672457456".to_string()),
                plugin_id: None,
                provider_key: "/manga/example".to_string(),
                dependency_key: Some("example.extension".to_string()),
                local_reference: Some("3".to_string()),
                resolution_state: "BOUND".to_string(),
                resolution_reason: None,
                title_hint: Some("Example".to_string()),
                provider_label_hint: None,
                record_lamport: 0,
                updated_at_ms: 1,
            },
            PortableChapterBindingRow {
                profile_id: "main".to_string(),
                portable_chapter_id: chapter_id,
                portable_work_id: work_id,
                provider_key: "https://example.test/manga/example/chapter-1".to_string(),
                local_reference: Some("508".to_string()),
                resolution_state: "BOUND".to_string(),
                resolution_reason: None,
                record_lamport: 0,
                updated_at_ms: 1,
            },
        )
    }

    #[test]
    fn promotes_exact_bound_suwayomi_rows_to_portable_identity() {
        let (work, chapter) = bound_comic_rows();
        let refs = portable_refs_from_bindings(&work, &chapter, 3, 508).unwrap();
        let identity = history_identity("server", "main", 3, 508, Some(refs));
        assert_eq!(identity.0, work.portable_id);
        assert_eq!(identity.1, chapter.portable_chapter_id);
        assert!(identity.2.is_some());
        assert!(identity.3.is_some());
    }

    #[test]
    fn refuses_ambiguous_or_mismatched_portable_rows() {
        let (work, mut chapter) = bound_comic_rows();
        chapter.local_reference = Some("509".to_string());
        assert!(portable_refs_from_bindings(&work, &chapter, 3, 508).is_none());
    }

    #[test]
    fn normalizes_suwayomi_last_read_at_to_epoch_millis() {
        assert_eq!(suwayomi_epoch_ms("0"), 0);
        assert_eq!(suwayomi_epoch_ms(""), 0);
        assert_eq!(suwayomi_epoch_ms("not-a-time"), 0);
        // Suwayomi LongString seconds.
        assert_eq!(suwayomi_epoch_ms("1699999999"), 1_699_999_999_000);
        // Already epoch millis.
        assert_eq!(suwayomi_epoch_ms("1699999999000"), 1_699_999_999_000);
    }

    #[test]
    fn reads_chapter_fields_defensively() {
        let chapter = json!({
            "id": 42,
            "url": "/chapter/1",
            "isRead": true,
            "lastReadAt": "0",
            "lastPageRead": -1,
            "pageCount": -1,
        });
        let parsed = parse_read_chapter(&chapter).unwrap();
        assert!(parsed.is_read);
        assert_eq!(parsed.chapter_id, 42);
        assert_eq!(parsed.last_read_at, 0);
        assert_eq!(parsed.last_page_read, 0);
        assert_eq!(parsed.page_count, None);
    }

    #[test]
    fn chapter_state_equality_ignores_transport_metadata_and_aliases() {
        let stored = r#"{"read":false,"bookmark":true,"lastPageRead":17,"updatedAtMs":1}"#;
        let incoming = r#"{"read":false,"bookmarked":true,"lastPageRead":17,"updatedAtMs":999}"#;
        assert!(chapter_state_semantically_equal(stored, incoming));
        assert!(!chapter_state_semantically_equal(
            stored,
            r#"{"read":false,"bookmarked":false,"lastPageRead":17}"#,
        ));
    }

    #[test]
    fn rejects_read_chapters_without_a_positive_id() {
        assert!(parse_read_chapter(&json!({ "url": "/chapter/1" })).is_none());
        assert!(parse_read_chapter(&json!({ "id": 0 })).is_none());
        assert!(parse_read_chapter(&json!({ "id": -1 })).is_none());
    }
}
