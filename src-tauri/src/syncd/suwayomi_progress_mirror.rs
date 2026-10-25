use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::Context;
use serde_json::{json, Value};
use sqlx::{FromRow, QueryBuilder, Sqlite};
use tokio::sync::Notify;

use super::lifecycle::{wait_for_shutdown_request, ShutdownRequest};
use super::models::{
    canonical_portable_chapter_id, canonical_portable_work_id, AuthenticatedSession,
    ComicHistoryPatch, EventClock, PortableChapterBindingRow, PortableChapterRefV3,
    PortableWorkBindingRow, PortableWorkRefV3, SharedAppState,
};
use super::routes::suwayomi_catalog;
use super::{catalog_revision, db, suwayomi_category_mirror, suwayomi_process};

/// How often the desktop's Suwayomi reading progress is re-imported into the syncd
/// replica so the snapshot/replay serve it to paired mobile devices.
const MIRROR_INTERVAL: Duration = Duration::from_secs(45);
/// Lower bound between two ticks requested by desktop edits, so a burst of edits shares one
/// Suwayomi round trip instead of queueing a tick per click.
const MIN_REQUESTED_INTERVAL: Duration = Duration::from_millis(1_500);
/// Lower bound between two catalog revision computations, so a burst of writes, each of which
/// would discard a computation still reading, shares one.
const MIN_CATALOG_REFRESH_INTERVAL: Duration = Duration::from_millis(400);
/// How often the catalog revisions are computed while a device streams catalog events. Edits made
/// in Suwayomi itself bypass Core, so only a computation notices them; it reads the library's
/// light fields in tens of milliseconds, which would otherwise wait for the next progress tick.
const CATALOG_WATCH_INTERVAL: Duration = Duration::from_secs(5);
const MIRROR_PAGE_SIZE: i64 = 250;
const MAX_MIRROR_PAGES: usize = 32;
const MIRROR_DEVICE_ID: &str = "epigraph-core-mirror";
pub(crate) const MIRROR_TOKEN_ID: &str = "epigraph-core-mirror";
/// Mangas whose chapters are fetched in one `chapters` query.
const MANGAS_PER_CHAPTER_QUERY: usize = 16;
/// Library titles whose summary changed are rescanned at most this many per tick; the rest stay
/// dirty and are picked up by the following ticks.
const MAX_DIRTY_SCANS_PER_TICK: usize = 48;
/// Titles rescanned per tick regardless of their summary, so changes the library summary cannot
/// reveal (a read and an unread in the same title between ticks) still converge.
const SWEEP_SCANS_PER_TICK: usize = 16;
/// Chapter-state writes applied under one `mutation_gate` acquisition.
const WRITE_BATCH_SIZE: usize = 64;
/// Bound for SQLite `IN (...)` lists.
const SQL_IN_CHUNK: usize = 500;
/// Bound for desktop edit hints that wait for the next tick.
const MAX_PENDING_HINTS: usize = 4_096;

const LIBRARY_WITH_PROGRESS_QUERY: &str = r#"
  query EpigraphProgressMirrorLibrary($first: Int!, $offset: Int!) {
    mangas(condition: { inLibrary: true }, first: $first, offset: $offset) {
      totalCount
      pageInfo { hasNextPage }
      nodes {
        id
        url
        sourceId
        unreadCount
        bookmarkCount
        chapters { totalCount }
        latestReadChapter {
          id
          url
          isRead
          lastReadAt
          lastPageRead
          pageCount
        }
        lastReadChapter {
          id
          isRead
          lastReadAt
          lastPageRead
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
        isBookmarked
        lastReadAt
        lastPageRead
        pageCount
      }
    }
  }
"#;

const CHAPTERS_FOR_MANGAS_QUERY: &str = r#"
  query EpigraphProgressMirrorChapters($mangaIds: [Int!]!, $first: Int!, $offset: Int!) {
    chapters(
      filter: { mangaId: { in: $mangaIds } }
      orderBy: ID
      orderByType: ASC
      first: $first
      offset: $offset
    ) {
      pageInfo { hasNextPage }
      nodes {
        id
        mangaId
        url
        isRead
        isBookmarked
        lastReadAt
        lastPageRead
      }
    }
  }
"#;

const HINTED_CHAPTERS_QUERY: &str = r#"
  query EpigraphProgressMirrorHintedChapters($ids: [Int!]!, $first: Int!, $offset: Int!) {
    chapters(
      filter: { id: { in: $ids } }
      orderBy: ID
      orderByType: ASC
      first: $first
      offset: $offset
    ) {
      pageInfo { hasNextPage }
      nodes {
        id
        mangaId
        url
        isRead
        isBookmarked
        lastReadAt
        lastPageRead
      }
    }
  }
"#;

/// Desktop edits waiting for the next mirror tick. Chapter ids map to the time Core learned of
/// the edit, which is the evidence that lets the edit win over an older phone record.
#[derive(Default)]
struct MirrorHints {
    manga_ids: BTreeSet<i64>,
    chapter_edits: HashMap<i64, i64>,
}

impl MirrorHints {
    fn record(&mut self, manga_ids: &[i64], chapter_ids: &[i64], requested_at_ms: i64) {
        for manga_id in manga_ids.iter().copied().filter(|id| *id > 0) {
            if self.manga_ids.len() < MAX_PENDING_HINTS {
                self.manga_ids.insert(manga_id);
            }
        }
        for chapter_id in chapter_ids.iter().copied().filter(|id| *id > 0) {
            if let Some(at) = self.chapter_edits.get_mut(&chapter_id) {
                *at = (*at).max(requested_at_ms);
            } else if self.chapter_edits.len() < MAX_PENDING_HINTS {
                self.chapter_edits.insert(chapter_id, requested_at_ms);
            }
        }
    }

    fn is_empty(&self) -> bool {
        self.manga_ids.is_empty() && self.chapter_edits.is_empty()
    }
}

struct MirrorRequests {
    wake: Notify,
    pending: std::sync::Mutex<MirrorHints>,
}

fn mirror_requests() -> &'static MirrorRequests {
    static REQUESTS: OnceLock<MirrorRequests> = OnceLock::new();
    REQUESTS.get_or_init(|| MirrorRequests {
        wake: Notify::new(),
        pending: std::sync::Mutex::new(MirrorHints::default()),
    })
}

/// Asks the mirror to run now instead of on its next periodic tick. The desktop calls this after
/// it changes chapter read, bookmark or page state in Suwayomi; the ids narrow the work to the
/// edited titles and mark the edited chapters as desktop-originated at the current time.
pub fn request_immediate_mirror(manga_ids: &[i64], chapter_ids: &[i64]) {
    let requests = mirror_requests();
    requests
        .pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .record(manga_ids, chapter_ids, db::now_ms());
    requests.wake.notify_one();
}

fn catalog_refresh_requests() -> &'static Notify {
    static REQUESTS: OnceLock<Notify> = OnceLock::new();
    REQUESTS.get_or_init(Notify::new)
}

/// Asks for the catalog revisions to be computed again now. They run on their own task, so a catalog
/// change is announced without waiting for a progress tick that is reading the whole library.
pub fn request_catalog_refresh() {
    catalog_refresh_requests().notify_one();
}

/// Spawns the task that computes catalog revisions on request, and on its own every
/// [`CATALOG_WATCH_INTERVAL`] while a device streams catalog events. Requests made while it
/// computes coalesce into one more computation.
pub fn spawn_catalog_refresh_task(
    state: SharedAppState,
    mut shutdown: tokio::sync::watch::Receiver<Option<ShutdownRequest>>,
) {
    tokio::spawn(async move {
        let requests = catalog_refresh_requests();
        let mut last_refresh: Option<tokio::time::Instant> = None;
        let mut watch = tokio::time::interval_at(
            tokio::time::Instant::now() + CATALOG_WATCH_INTERVAL,
            CATALOG_WATCH_INTERVAL,
        );
        watch.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = requests.notified() => {}
                _ = watch.tick() => {
                    let recent = last_refresh.is_some_and(|at| at.elapsed() < CATALOG_WATCH_INTERVAL);
                    if recent || !catalog_revision::has_listeners() {
                        continue;
                    }
                }
                _ = wait_for_shutdown_request(&mut shutdown) => break,
            }
            let wait = last_refresh
                .map(|at| MIN_CATALOG_REFRESH_INTERVAL.saturating_sub(at.elapsed()))
                .unwrap_or_default();
            if !wait.is_zero() {
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = wait_for_shutdown_request(&mut shutdown) => break,
                }
            }
            for instance in suwayomi_process::attach_owned_instances() {
                let session = mirror_session(&instance.profile_key);
                match db::load_server_identity(&state.pool).await {
                    Ok(identity) => catalog_revision::refresh(&state, &session, &identity.server_id).await,
                    Err(error) => tracing::debug!(error = %error, "catalog revision skipped: no server identity"),
                }
            }
            last_refresh = Some(tokio::time::Instant::now());
        }
    });
}

fn mirror_session(profile_id: &str) -> AuthenticatedSession {
    AuthenticatedSession {
        token_id: MIRROR_TOKEN_ID.to_string(),
        device_id: MIRROR_DEVICE_ID.to_string(),
        profile_id: profile_id.to_string(),
        scopes: BTreeSet::from([format!("comics:profile:{profile_id}")]),
        mutation_receipt: None,
    }
}

fn take_mirror_hints() -> MirrorHints {
    std::mem::take(
        &mut *mirror_requests()
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    )
}

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
        // publish confirmed progress synchronously. Desktop edits request a tick explicitly.
        let mut ticker = tokio::time::interval_at(
            tokio::time::Instant::now() + MIRROR_INTERVAL,
            MIRROR_INTERVAL,
        );
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let requests = mirror_requests();
        let mut memory = MirrorMemory::default();
        let mut last_tick: Option<tokio::time::Instant> = None;
        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = requests.wake.notified() => {
                    let wait = last_tick
                        .map(|at| MIN_REQUESTED_INTERVAL.saturating_sub(at.elapsed()))
                        .unwrap_or_default();
                    if !wait.is_zero() {
                        tokio::select! {
                            _ = tokio::time::sleep(wait) => {}
                            _ = wait_for_shutdown_request(&mut shutdown) => break,
                        }
                    }
                    // The periodic tick stays a fallback; it restarts its interval from here.
                    ticker.reset();
                }
                _ = wait_for_shutdown_request(&mut shutdown) => break,
            }
            let hints = take_mirror_hints();
            match mirror_all_profiles(&state, &mut memory, &hints).await {
                Ok(mirrored) => tracing::debug!(
                    mirrored,
                    requested = !hints.is_empty(),
                    "Suwayomi progress mirror tick completed"
                ),
                Err(error) => {
                    tracing::warn!(error = %error, "failed to mirror Suwayomi reading progress")
                }
            }
            last_tick = Some(tokio::time::Instant::now());
        }
    });
}

async fn mirror_all_profiles(
    state: &SharedAppState,
    memory: &mut MirrorMemory,
    hints: &MirrorHints,
) -> anyhow::Result<usize> {
    let mut total = 0usize;
    let instances = suwayomi_process::attach_owned_instances();
    tracing::debug!(
        profiles = instances.len(),
        "Suwayomi progress mirror discovered profiles"
    );
    let live_profiles = instances
        .iter()
        .map(|instance| instance.profile_key.clone())
        .collect::<HashSet<_>>();
    memory
        .profiles
        .retain(|profile, _| live_profiles.contains(profile));
    for instance in instances {
        let profile_memory = memory
            .profiles
            .entry(instance.profile_key.clone())
            .or_default();
        match mirror_profile(state, &instance.profile_key, profile_memory, hints).await {
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

async fn mirror_profile(
    state: &SharedAppState,
    profile_id: &str,
    memory: &mut ProfileMirrorMemory,
    hints: &MirrorHints,
) -> anyhow::Result<usize> {
    let session = mirror_session(profile_id);
    let scope_id = format!("comics:profile:{profile_id}");
    let retention_window = state.config.retention_window;
    let server_identity = db::load_server_identity(&state.pool).await?;
    let server_id = &server_identity.server_id;

    // The revisions are computed on their own task, so devices hear about a catalog change without
    // waiting for the progress read below; this keeps them from expiring.
    request_catalog_refresh();
    let library = fetch_library_with_progress(state, &session).await?;
    // Bookmarks keep their original eligibility (titles with read progress); chapter states below
    // cover the whole library.
    let manga_refs = library
        .iter()
        .filter(|(_, node)| node.latest_read_chapter.is_some())
        .map(|(manga_id, _)| *manga_id)
        .collect::<HashSet<_>>();

    let mut mirrored = 0usize;
    // Chapter states first: they carry desktop edit hints, which then reach devices without
    // waiting for the history and bookmark scans. Those write through the same semantic-equality
    // guard from a later snapshot, so this order changes no outcome.
    mirrored += mirror_chapter_states(
        state, &session, &scope_id, server_id, profile_id, &library, memory, hints,
    )
    .await?;
    let read_chapters = library
        .iter()
        .filter_map(|(manga_id, node)| {
            let chapter = node.latest_read_chapter.as_ref()?;
            Some(ChapterNode {
                manga_id: *manga_id,
                chapter_id: chapter.chapter_id,
                url: chapter.url.clone(),
                is_read: chapter.is_read,
                is_bookmarked: false,
                last_read_at: chapter.last_read_at,
                last_page_read: chapter.last_page_read,
            })
        })
        .collect::<Vec<_>>();
    let mut read_portable = load_portable_refs_batch(state, profile_id, &read_chapters).await?;
    for (manga_id, node) in &library {
        let Some(chapter) = node.latest_read_chapter.as_ref() else {
            continue;
        };
        let portable = read_portable.remove(&chapter.chapter_id);
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
            let outcome = db::apply_mirrored_comic_history_mutation(
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
    let mut bookmark_portable = load_portable_refs_batch(state, profile_id, &bookmarks).await?;
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
        let portable = bookmark_portable.remove(&bookmark.chapter_id);
        let identity = chapter_state_identity(
            server_id,
            profile_id,
            bookmark.manga_id,
            bookmark.chapter_id,
            portable,
        );
        let entity_id = identity.entity_id.clone();
        observed_bookmark_entities.insert(entity_id.clone());
        let portable_identity = identity.portable_work_ref.is_some();
        if portable_identity {
            // The progress pass keeps a device's server-local record of a bound chapter following
            // Suwayomi; clearing its bookmark here would undo that write on every tick.
            observed_bookmark_entities.insert(
                chapter_state_identity(server_id, profile_id, bookmark.manga_id, bookmark.chapter_id, None)
                    .entity_id,
            );
        }
        // Suwayomi does not expose a bookmark-updated timestamp. The observation time lets a
        // newer desktop command win over an older mobile record, while the semantic equality
        // guard below prevents a revision on every mirror tick.
        let record = chapter_state_record(
            &identity,
            server_id,
            profile_id,
            bookmark,
            bookmark_observed_at_ms,
        );
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
    let library_titles = library
        .iter()
        .map(|(manga_id, node)| suwayomi_category_mirror::LibraryTitle {
            manga_id: *manga_id,
            portable_comic_id: Some(node.portable_comic_id.clone()),
        })
        .collect::<Vec<_>>();
    // Category failures must not hide the progress already mirrored above.
    match suwayomi_category_mirror::mirror_categories(
        state,
        &session,
        &scope_id,
        server_id,
        profile_id,
        &library_titles,
        retention_window,
    )
    .await
    {
        Ok(count) => mirrored += count,
        Err(error) => tracing::warn!(error = %error, "Suwayomi category mirror failed"),
    }
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

/// In-memory view of what the mirror last saw in Suwayomi, per profile. It is rebuilt after a
/// Core restart; until a title has a baseline only edits with explicit evidence (a desktop edit
/// request or a Suwayomi read time newer than the stored record) reach chapters syncd has never
/// stored. Paired devices learn that baseline from the Suwayomi catalog itself.
#[derive(Default)]
struct MirrorMemory {
    profiles: HashMap<String, ProfileMirrorMemory>,
}

#[derive(Default)]
struct ProfileMirrorMemory {
    fingerprints: HashMap<i64, MangaFingerprint>,
    baselines: HashMap<i64, MangaBaseline>,
    sweep_cursor: usize,
}

/// Per-title library summary. A change means some chapter's read or page state changed, so
/// the title's chapters are rescanned without fetching every chapter of the library.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct MangaFingerprint {
    unread_count: i64,
    bookmark_count: i64,
    chapter_count: i64,
    latest_read: Option<(i64, bool, i64, i64)>,
    last_read: Option<(i64, bool, i64, i64)>,
}

/// Chapter states observed in one scan of a title and when they were observed.
struct MangaBaseline {
    observed_at_ms: i64,
    chapters: HashMap<i64, ChapterProgressState>,
}

/// The reader state a `comic.chapter_state` record carries, normalized so absent fields and
/// legacy aliases compare equal to their defaults.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ChapterProgressState {
    read: bool,
    bookmarked: bool,
    last_page_read: i64,
}

/// Mirrors chapter read / page / bookmark state for library titles whose state may have changed:
/// titles named by a desktop edit request, titles whose library summary changed since the last
/// tick, and a small rotating sweep. Each candidate chapter is compared with the stored
/// `comic.chapter_state` record and written only when it differs and the write is provably not
/// older than a phone-originated record.
#[allow(clippy::too_many_arguments)]
async fn mirror_chapter_states(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    scope_id: &str,
    server_id: &str,
    profile_id: &str,
    library: &[(i64, LibraryMangaNode)],
    memory: &mut ProfileMirrorMemory,
    hints: &MirrorHints,
) -> anyhow::Result<usize> {
    let library_ids = library.iter().map(|(id, _)| *id).collect::<BTreeSet<_>>();
    memory
        .fingerprints
        .retain(|manga_id, _| library_ids.contains(manga_id));
    memory
        .baselines
        .retain(|manga_id, _| library_ids.contains(manga_id));

    let mut hinted = hints
        .manga_ids
        .iter()
        .copied()
        .filter(|manga_id| library_ids.contains(manga_id))
        .collect::<BTreeSet<_>>();
    if !hints.chapter_edits.is_empty() {
        let chapter_ids = hints.chapter_edits.keys().copied().collect::<Vec<_>>();
        for chapter in fetch_chapters(
            state,
            session,
            HINTED_CHAPTERS_QUERY,
            json!({ "ids": chapter_ids }),
            "hinted chapters",
        )
        .await?
        {
            if library_ids.contains(&chapter.manga_id) {
                hinted.insert(chapter.manga_id);
            }
        }
    }
    let dirty = library
        .iter()
        .filter(|(manga_id, node)| {
            memory
                .fingerprints
                .get(manga_id)
                .is_some_and(|previous| previous != &node.fingerprint)
        })
        .map(|(manga_id, _)| *manga_id)
        .collect::<BTreeSet<_>>();
    let library_order = library_ids.iter().copied().collect::<Vec<_>>();
    let plan = plan_manga_scans(
        &library_order,
        &hinted,
        &dirty,
        |manga_id| memory.baselines.contains_key(&manga_id),
        memory.sweep_cursor,
    );
    memory.sweep_cursor = plan.next_sweep_cursor;
    tracing::debug!(
        hinted = hinted.len(),
        dirty = dirty.len(),
        scanned = plan.scan.len(),
        deferred = plan.deferred.len(),
        "Suwayomi chapter state mirror planned"
    );

    let mut mirrored = 0usize;
    for chunk in plan.scan.chunks(MANGAS_PER_CHAPTER_QUERY) {
        let chapters = fetch_chapters(
            state,
            session,
            CHAPTERS_FOR_MANGAS_QUERY,
            json!({ "mangaIds": chunk }),
            "library chapters",
        )
        .await?;
        let observed_at_ms = db::now_ms();
        let chunk_ids = chunk.iter().copied().collect::<HashSet<_>>();
        let chapters = chapters
            .into_iter()
            .filter(|chapter| chunk_ids.contains(&chapter.manga_id))
            .collect::<Vec<_>>();
        let portable = load_portable_refs_batch(state, profile_id, &chapters).await?;
        let identities = chapters
            .iter()
            .map(|chapter| {
                chapter_state_identity(
                    server_id,
                    profile_id,
                    chapter.manga_id,
                    chapter.chapter_id,
                    portable.get(&chapter.chapter_id).cloned(),
                )
            })
            .collect::<Vec<_>>();
        let stored = load_stored_chapter_states(
            state,
            scope_id,
            identities
                .iter()
                .map(|identity| identity.entity_id.as_str()),
        )
        .await?;
        // Records under the server-local ids of portable chapters; see
        // `planned_chapter_state_writes`.
        let legacy_ids = chapters
            .iter()
            .zip(&identities)
            .filter(|(_, identity)| identity.portable_chapter_ref.is_some())
            .map(|(chapter, _)| {
                (
                    chapter.chapter_id,
                    chapter_state_identity(
                        server_id,
                        profile_id,
                        chapter.manga_id,
                        chapter.chapter_id,
                        None,
                    )
                    .entity_id,
                )
            })
            .collect::<HashMap<_, _>>();
        let legacy =
            load_stored_chapter_states(state, scope_id, legacy_ids.values().map(String::as_str))
                .await?;

        let mut writes = Vec::new();
        for (chapter, identity) in chapters.iter().zip(&identities) {
            let planned = planned_chapter_state_writes(
                chapter,
                memory.baselines.get(&chapter.manga_id),
                hints.chapter_edits.get(&chapter.chapter_id).copied(),
                stored.get(&identity.entity_id),
                legacy_ids
                    .get(&chapter.chapter_id)
                    .and_then(|entity_id| legacy.get(entity_id)),
                observed_at_ms,
            );
            if let Some(updated_at_ms) = planned.identity {
                writes.push((
                    identity.entity_id.clone(),
                    chapter_state_record(identity, server_id, profile_id, chapter, updated_at_ms),
                    updated_at_ms,
                ));
            }
            if let Some(updated_at_ms) = planned.legacy {
                let legacy_identity = chapter_state_identity(
                    server_id,
                    profile_id,
                    chapter.manga_id,
                    chapter.chapter_id,
                    None,
                );
                writes.push((
                    legacy_identity.entity_id.clone(),
                    chapter_state_record(
                        &legacy_identity,
                        server_id,
                        profile_id,
                        chapter,
                        updated_at_ms,
                    ),
                    updated_at_ms,
                ));
            }
        }
        for batch in writes.chunks(WRITE_BATCH_SIZE) {
            let _writer_guard = state.mutation_gate.lock().await;
            for (entity_id, record, updated_at_ms) in batch {
                // Re-check against the current row under the gate: a phone mutation may have
                // landed since the stored states were loaded.
                let record_json = serde_json::to_string(record)?;
                if !needs_chapter_state_write(state, scope_id, entity_id, &record_json).await? {
                    continue;
                }
                let event_clock = EventClock {
                    physical_ms: *updated_at_ms,
                    logical: 0,
                    device_generation_id: MIRROR_DEVICE_ID.to_string(),
                };
                let outcome = db::apply_mirrored_comic_sync_state_mutation(
                    &state.pool,
                    session,
                    scope_id,
                    "comic.chapter_state",
                    entity_id,
                    record,
                    *updated_at_ms,
                    Some(&event_clock),
                    state.config.retention_window,
                )
                .await?;
                if publish_applied_change(state, &outcome) {
                    mirrored += 1;
                }
            }
        }

        let mut baselines = chunk
            .iter()
            .map(|manga_id| (*manga_id, HashMap::new()))
            .collect::<HashMap<i64, HashMap<i64, ChapterProgressState>>>();
        for chapter in &chapters {
            baselines
                .entry(chapter.manga_id)
                .or_default()
                .insert(chapter.chapter_id, chapter.progress_state());
        }
        for (manga_id, chapters) in baselines {
            memory.baselines.insert(
                manga_id,
                MangaBaseline {
                    observed_at_ms,
                    chapters,
                },
            );
        }
    }
    // Deferred dirty titles keep their previous summary so the next tick still sees them dirty.
    for (manga_id, node) in library {
        if !plan.deferred.contains(manga_id) {
            memory
                .fingerprints
                .insert(*manga_id, node.fingerprint.clone());
        }
    }
    Ok(mirrored)
}

#[derive(Debug, PartialEq, Eq)]
struct MangaScanPlan {
    scan: Vec<i64>,
    deferred: HashSet<i64>,
    next_sweep_cursor: usize,
}

/// Chooses the titles whose chapters are fetched this tick: every hinted title, dirty titles up
/// to a bound, then a sweep that first baselines titles never scanned since Core started and then
/// rotates through the library.
fn plan_manga_scans(
    library_ids: &[i64],
    hinted: &BTreeSet<i64>,
    dirty: &BTreeSet<i64>,
    has_baseline: impl Fn(i64) -> bool,
    sweep_cursor: usize,
) -> MangaScanPlan {
    let mut scan = hinted.iter().copied().collect::<Vec<_>>();
    let mut selected = hinted.clone();
    let mut deferred = HashSet::new();
    let mut dirty_scans = 0usize;
    for manga_id in dirty.iter().copied().filter(|id| !hinted.contains(id)) {
        if dirty_scans < MAX_DIRTY_SCANS_PER_TICK {
            scan.push(manga_id);
            selected.insert(manga_id);
            dirty_scans += 1;
        } else {
            deferred.insert(manga_id);
        }
    }
    let mut sweep = 0usize;
    for manga_id in library_ids.iter().copied() {
        if sweep == SWEEP_SCANS_PER_TICK {
            break;
        }
        if !has_baseline(manga_id) && selected.insert(manga_id) {
            deferred.remove(&manga_id);
            scan.push(manga_id);
            sweep += 1;
        }
    }
    let mut next_sweep_cursor = sweep_cursor;
    if sweep < SWEEP_SCANS_PER_TICK && !library_ids.is_empty() {
        let len = library_ids.len();
        for step in 0..len {
            if sweep == SWEEP_SCANS_PER_TICK {
                break;
            }
            let index = (sweep_cursor + step) % len;
            next_sweep_cursor = (index + 1) % len;
            let manga_id = library_ids[index];
            if selected.insert(manga_id) {
                deferred.remove(&manga_id);
                scan.push(manga_id);
                sweep += 1;
            }
        }
    }
    MangaScanPlan {
        scan,
        deferred,
        next_sweep_cursor,
    }
}

/// Decides whether an observed Suwayomi chapter becomes a `comic.chapter_state` write and with
/// which `updatedAtMs`. Returns `None` when the stored record already matches, or when nothing
/// proves the Suwayomi state is newer than a record a phone wrote.
///
/// Evidence, newest first: a desktop edit request for the chapter (its request time), a change
/// against the previous scan of the title (just after that scan, the earliest the change can
/// have happened), and for phone records Suwayomi's own `lastReadAt`.
fn planned_chapter_state_updated_at(
    observed: &ChapterNode,
    baseline: Option<&MangaBaseline>,
    desktop_edit_at_ms: Option<i64>,
    stored: Option<&StoredChapterStateRow>,
    observed_at_ms: i64,
) -> Option<i64> {
    let current = observed.progress_state();
    if let Some(row) = stored {
        if stored_progress_state(&row.record_json) == Some(current) {
            return None;
        }
    }
    let transition_at_ms = baseline.and_then(|baseline| {
        let previous = baseline
            .chapters
            .get(&observed.chapter_id)
            .copied()
            .unwrap_or_default();
        (previous != current).then_some(baseline.observed_at_ms.saturating_add(1))
    });
    let evidence_at_ms = desktop_edit_at_ms.max(transition_at_ms);
    match stored {
        // Unread, unbookmarked chapters without a record need nothing: devices take that
        // baseline from the catalog. Only an observed change is emitted, including read=false.
        None => evidence_at_ms,
        // The mirror's own record is stale: Suwayomi is the authority. Stay ahead of the clock the
        // mirror stored for it so the write is not superseded by the mirror itself.
        Some(row) if row.record_updated_by_device_id == MIRROR_DEVICE_ID => Some(
            evidence_at_ms
                .unwrap_or(observed_at_ms)
                .max(row.record_updated_at_ms.saturating_add(1)),
        ),
        Some(row) => {
            let at_ms =
                evidence_at_ms.or((observed.last_read_at > 0).then_some(observed.last_read_at))?;
            (at_ms > row.record_updated_at_ms).then_some(at_ms)
        }
    }
}

/// `updatedAtMs` of the writes one observed chapter needs, if any.
#[derive(Debug, PartialEq, Eq)]
struct PlannedChapterStateWrites {
    /// The chapter's own (portable when bound) identity.
    identity: Option<i64>,
    /// The server-local identity of a bound chapter, when a device wrote a record under it.
    legacy: Option<i64>,
}

/// Plans a chapter's writes. `legacy` is the record stored under the server-local id of a chapter
/// whose identity is portable. A mirror-owned one is a desktop edit from an earlier build that
/// the portable record carries over when it has none yet. Either kind must follow Suwayomi as
/// well: a device that has not bound the chapter writes and reads it through that id, and would
/// otherwise keep showing a state the desktop has since changed.
fn planned_chapter_state_writes(
    observed: &ChapterNode,
    baseline: Option<&MangaBaseline>,
    desktop_edit_at_ms: Option<i64>,
    stored: Option<&StoredChapterStateRow>,
    legacy: Option<&StoredChapterStateRow>,
    observed_at_ms: i64,
) -> PlannedChapterStateWrites {
    let legacy_edit_at_ms = legacy
        .filter(|row| stored.is_none() && row.record_updated_by_device_id == MIRROR_DEVICE_ID)
        .map(|row| row.record_updated_at_ms);
    PlannedChapterStateWrites {
        identity: planned_chapter_state_updated_at(
            observed,
            baseline,
            desktop_edit_at_ms.max(legacy_edit_at_ms),
            stored,
            observed_at_ms,
        ),
        legacy: legacy.and_then(|row| {
            planned_chapter_state_updated_at(
                observed,
                baseline,
                desktop_edit_at_ms,
                Some(row),
                observed_at_ms,
            )
        }),
    }
}

/// Identity of one chapter's `comic.chapter_state` entity.
struct ChapterStateIdentity {
    entity_id: String,
    comic_id: String,
    chapter_id: String,
    portable_work_ref: Option<PortableWorkRefV3>,
    portable_chapter_ref: Option<PortableChapterRefV3>,
}

fn chapter_state_identity(
    server_id: &str,
    profile_id: &str,
    manga_id: i64,
    chapter_id: i64,
    portable: Option<PortableComicRefs>,
) -> ChapterStateIdentity {
    let (comic_id, chapter_id, portable_work_ref, portable_chapter_ref) =
        history_identity(server_id, profile_id, manga_id, chapter_id, portable);
    ChapterStateIdentity {
        entity_id: format!("comic.chapter_state::{comic_id}::{chapter_id}"),
        comic_id,
        chapter_id,
        portable_work_ref,
        portable_chapter_ref,
    }
}

fn chapter_state_record(
    identity: &ChapterStateIdentity,
    server_id: &str,
    profile_id: &str,
    chapter: &ChapterNode,
    updated_at_ms: i64,
) -> Value {
    let mut record = json!({
        "chapterStateId": identity.entity_id,
        "comicId": identity.comic_id,
        "chapterId": identity.chapter_id,
        "coreServerId": server_id,
        "coreProfileId": profile_id,
        "suwayomiMangaId": chapter.manga_id,
        "suwayomiChapterId": chapter.chapter_id,
        "read": chapter.is_read,
        "bookmarked": chapter.is_bookmarked,
        "lastPageRead": (chapter.last_page_read > 0).then_some(chapter.last_page_read),
        "lastReadAtMs": (chapter.last_read_at > 0).then_some(chapter.last_read_at),
        "updatedAtMs": updated_at_ms,
        "explicitProgressReset": false,
    });
    // Mobile projections treat a present portable ref key as a claim of portable identity, so a
    // record under server-local ids must omit the keys rather than carry nulls.
    if let (Some(work), Some(chapter)) =
        (&identity.portable_work_ref, &identity.portable_chapter_ref)
    {
        record["portableWorkRef"] = json!(work);
        record["portableChapterRef"] = json!(chapter);
    }
    record
}

type PortableComicRefs = (PortableWorkRefV3, PortableChapterRefV3);

/// Portable identities of `chapters`, with one bindings query per [`SQL_IN_CHUNK`] chapters: a
/// chapter's single bound chapter binding, else its title's binding and source chapter key. A
/// chapter with several bound bindings has none.
async fn load_portable_refs_batch(
    state: &SharedAppState,
    profile_id: &str,
    chapters: &[ChapterNode],
) -> anyhow::Result<HashMap<i64, PortableComicRefs>> {
    let mut bindings: HashMap<i64, Vec<PortableChapterBindingRow>> = HashMap::new();
    for chunk in chapters.chunks(SQL_IN_CHUNK) {
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT * FROM portable_chapter_bindings WHERE profile_id = ",
        );
        query.push_bind(profile_id);
        query.push(" AND resolution_state = 'BOUND' AND local_reference IN (");
        let mut separated = query.separated(", ");
        for chapter in chunk {
            separated.push_bind(chapter.chapter_id.to_string());
        }
        separated.push_unseparated(")");
        let rows = query
            .build_query_as::<PortableChapterBindingRow>()
            .fetch_all(&state.pool)
            .await
            .context("failed to resolve portable chapters for the progress mirror")?;
        for row in rows {
            if let Some(chapter_id) = row
                .local_reference
                .as_deref()
                .and_then(|value| value.parse::<i64>().ok())
            {
                bindings.entry(chapter_id).or_default().push(row);
            }
        }
    }
    let mut works: HashMap<String, Option<PortableWorkBindingRow>> = HashMap::new();
    let mut manga_works: HashMap<i64, Option<PortableWorkBindingRow>> = HashMap::new();
    let mut refs = HashMap::new();
    for chapter in chapters {
        let Some(chapter_bindings) = bindings.get(&chapter.chapter_id) else {
            // No chapter binding yet: derive the chapter identity from the title's binding and
            // the source chapter key, as devices do.
            let Some(chapter_url) = chapter.url.as_deref() else {
                continue;
            };
            if !manga_works.contains_key(&chapter.manga_id) {
                let work = load_bound_work_for_manga(state, profile_id, chapter.manga_id).await?;
                manga_works.insert(chapter.manga_id, work);
            }
            if let Some(portable) = manga_works
                .get(&chapter.manga_id)
                .and_then(Option::as_ref)
                .and_then(|work| portable_refs_from_work(work, chapter.manga_id, chapter_url))
            {
                refs.insert(chapter.chapter_id, portable);
            }
            continue;
        };
        let [binding] = chapter_bindings.as_slice() else {
            continue;
        };
        if !works.contains_key(&binding.portable_work_id) {
            let work =
                db::load_portable_work_binding(&state.pool, profile_id, &binding.portable_work_id)
                    .await?;
            works.insert(binding.portable_work_id.clone(), work);
        }
        let Some(Some(work)) = works.get(&binding.portable_work_id) else {
            continue;
        };
        if let Some(portable) =
            portable_refs_from_bindings(work, binding, chapter.manga_id, chapter.chapter_id)
        {
            refs.insert(chapter.chapter_id, portable);
        }
    }
    Ok(refs)
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

/// The title's bound Suwayomi work binding, when exactly one exists for this manga.
async fn load_bound_work_for_manga(
    state: &SharedAppState,
    profile_id: &str,
    manga_id: i64,
) -> anyhow::Result<Option<PortableWorkBindingRow>> {
    let mut rows = sqlx::query_as::<_, PortableWorkBindingRow>(
        r#"
        SELECT * FROM portable_work_bindings
        WHERE profile_id = ? AND ecosystem = 'SUWAYOMI' AND local_reference = ?
          AND resolution_state = 'BOUND'
        ORDER BY updated_at_ms DESC
        LIMIT 2
        "#,
    )
    .bind(profile_id)
    .bind(manga_id.to_string())
    .fetch_all(&state.pool)
    .await
    .context("failed to resolve portable work for the progress mirror")?;
    Ok((rows.len() == 1).then(|| rows.remove(0)))
}

fn portable_refs_from_work(
    work: &PortableWorkBindingRow,
    manga_id: i64,
    chapter_url: &str,
) -> Option<PortableComicRefs> {
    if work.ecosystem != "SUWAYOMI"
        || work.resolution_state != "BOUND"
        || work.local_reference.as_deref()?.parse::<i64>().ok()? != manga_id
        || chapter_url.trim().is_empty()
    {
        return None;
    }
    let work_ref = work.portable_ref().ok()?;
    if canonical_portable_work_id(&work_ref) != work.portable_id {
        return None;
    }
    let chapter_ref = PortableChapterRefV3::comic(work_ref.clone(), chapter_url.to_string());
    chapter_ref.validate().ok()?;
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
    /// Canonical portable id from the title's source identity.
    portable_comic_id: String,
    latest_read_chapter: Option<ReadChapterNode>,
    fingerprint: MangaFingerprint,
}

#[derive(Clone)]
struct ReadChapterNode {
    chapter_id: i64,
    /// Source chapter key; the portable chapter identity when no chapter binding exists yet.
    url: Option<String>,
    is_read: bool,
    last_read_at: i64,
    last_page_read: i64,
    page_count: Option<i64>,
}

impl ReadChapterNode {
    fn fingerprint(&self) -> (i64, bool, i64, i64) {
        (
            self.chapter_id,
            self.is_read,
            self.last_page_read,
            self.last_read_at,
        )
    }
}

/// Every library title, with its read-progress summary. Titles without a read chapter are
/// included so their chapter state is mirrored too.
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
            let portable_comic_id =
                canonical_portable_work_id(&PortableWorkRefV3::comic(source_id, manga_key));
            let latest_read_chapter = node
                .get("latestReadChapter")
                .filter(|value| !value.is_null())
                .and_then(parse_read_chapter);
            let last_read_chapter = node
                .get("lastReadChapter")
                .filter(|value| !value.is_null())
                .and_then(parse_read_chapter);
            let fingerprint = MangaFingerprint {
                unread_count: node.get("unreadCount").and_then(Value::as_i64).unwrap_or(0),
                bookmark_count: node
                    .get("bookmarkCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                chapter_count: node
                    .get("chapters")
                    .and_then(|value| value.get("totalCount"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                latest_read: latest_read_chapter
                    .as_ref()
                    .map(ReadChapterNode::fingerprint),
                last_read: last_read_chapter.as_ref().map(ReadChapterNode::fingerprint),
            };
            mangas.push((
                manga_id,
                LibraryMangaNode {
                    portable_comic_id,
                    latest_read_chapter: latest_read_chapter.filter(|chapter| chapter.is_read),
                    fingerprint,
                },
            ));
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
        url: text(chapter.get("url")).map(str::to_string),
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
struct ChapterNode {
    manga_id: i64,
    chapter_id: i64,
    /// Source chapter key; the portable chapter identity when no chapter binding exists yet.
    url: Option<String>,
    is_read: bool,
    is_bookmarked: bool,
    last_read_at: i64,
    last_page_read: i64,
}

impl ChapterNode {
    fn progress_state(&self) -> ChapterProgressState {
        ChapterProgressState {
            read: self.is_read,
            bookmarked: self.is_bookmarked,
            last_page_read: self.last_page_read.max(0),
        }
    }
}

fn parse_chapter_node(node: &Value) -> Option<ChapterNode> {
    let manga_id = node
        .get("mangaId")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)?;
    let chapter_id = node
        .get("id")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)?;
    Some(ChapterNode {
        manga_id,
        chapter_id,
        url: text(node.get("url")).map(str::to_string),
        is_read: node.get("isRead").and_then(Value::as_bool).unwrap_or(false),
        is_bookmarked: node
            .get("isBookmarked")
            .and_then(Value::as_bool)
            .unwrap_or(false),
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
    })
}

async fn fetch_bookmarked_chapters(
    state: &SharedAppState,
    session: &AuthenticatedSession,
) -> anyhow::Result<Vec<ChapterNode>> {
    fetch_chapters(
        state,
        session,
        BOOKMARKED_CHAPTERS_QUERY,
        json!({}),
        "bookmarked chapters",
    )
    .await
}

/// Runs a paged `chapters` query. `variables` carries the query's filter arguments; paging
/// arguments are added here.
async fn fetch_chapters(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    document: &str,
    variables: Value,
    label: &str,
) -> anyhow::Result<Vec<ChapterNode>> {
    let mut chapters = Vec::new();
    for page in 0..MAX_MIRROR_PAGES {
        let offset = (page as i64).saturating_mul(MIRROR_PAGE_SIZE);
        let mut page_variables = variables.clone();
        if let Some(object) = page_variables.as_object_mut() {
            object.insert("first".to_string(), Value::from(MIRROR_PAGE_SIZE));
            object.insert("offset".to_string(), Value::from(offset));
        }
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            document,
            page_variables,
            false,
        )
        .await
        .map_err(|error| anyhow::anyhow!("{label} mirror query failed: {error:?}"))?;
        let connection = data
            .get("chapters")
            .and_then(Value::as_object)
            .with_context(|| format!("invalid {label} mirror response"))?;
        let nodes = connection
            .get("nodes")
            .and_then(Value::as_array)
            .with_context(|| format!("invalid {label} mirror nodes"))?;
        chapters.extend(nodes.iter().filter_map(parse_chapter_node));
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
    entity_id: String,
    record_updated_by_device_id: String,
    record_updated_at_ms: i64,
    record_json: String,
}

async fn load_stored_chapter_states<'a>(
    state: &SharedAppState,
    scope_id: &str,
    entity_ids: impl Iterator<Item = &'a str>,
) -> anyhow::Result<HashMap<String, StoredChapterStateRow>> {
    let entity_ids = entity_ids.collect::<Vec<_>>();
    let mut rows = HashMap::with_capacity(entity_ids.len());
    for chunk in entity_ids.chunks(SQL_IN_CHUNK) {
        let mut query = QueryBuilder::<Sqlite>::new(
            r#"
            SELECT entity_id, record_updated_by_device_id, record_updated_at_ms, record_json
            FROM comic_sync_state
            WHERE entity_type = 'comic.chapter_state' AND scope_id = "#,
        );
        query.push_bind(scope_id);
        query.push(" AND entity_id IN (");
        let mut separated = query.separated(", ");
        for entity_id in chunk {
            separated.push_bind(*entity_id);
        }
        separated.push_unseparated(")");
        for row in query
            .build_query_as::<StoredChapterStateRow>()
            .fetch_all(&state.pool)
            .await
            .context("failed to load stored comic chapter states for the progress mirror")?
        {
            rows.insert(row.entity_id.clone(), row);
        }
    }
    Ok(rows)
}

async fn needs_chapter_state_write(
    state: &SharedAppState,
    scope_id: &str,
    entity_id: &str,
    record_json: &str,
) -> anyhow::Result<bool> {
    let row = sqlx::query_as::<_, StoredChapterStateRow>(
        r#"
        SELECT entity_id, record_updated_by_device_id, record_updated_at_ms, record_json
        FROM comic_sync_state
        WHERE scope_id = ? AND entity_type = 'comic.chapter_state' AND entity_id = ?
        "#,
    )
    .bind(scope_id)
    .bind(entity_id)
    .fetch_optional(&state.pool)
    .await
    .context("failed to load stored comic chapter state for the progress mirror")?;
    Ok(chapter_state_write_allowed(row.as_ref(), record_json))
}

/// Skips writes that would not change the reader state, and never replaces a record another
/// device wrote unless the incoming `updatedAtMs` is strictly newer than that record.
fn chapter_state_write_allowed(stored: Option<&StoredChapterStateRow>, record_json: &str) -> bool {
    let Some(row) = stored else {
        return true;
    };
    if chapter_state_semantically_equal(&row.record_json, record_json) {
        return false;
    }
    if row.record_updated_by_device_id != MIRROR_DEVICE_ID {
        let incoming_updated_at = serde_json::from_str::<Value>(record_json)
            .ok()
            .and_then(|value| value.get("updatedAtMs").and_then(Value::as_i64))
            .unwrap_or(0);
        return incoming_updated_at > row.record_updated_at_ms;
    }
    true
}

fn stored_progress_state(raw: &str) -> Option<ChapterProgressState> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    if !value.is_object() {
        return None;
    }
    Some(ChapterProgressState {
        read: value.get("read").and_then(Value::as_bool).unwrap_or(false),
        bookmarked: value
            .get("bookmarked")
            .or_else(|| value.get("bookmark"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        last_page_read: value
            .get("lastPageRead")
            .or_else(|| value.get("pageIndex"))
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0),
    })
}

fn chapter_state_semantically_equal(stored_json: &str, incoming_json: &str) -> bool {
    match (
        stored_progress_state(stored_json),
        stored_progress_state(incoming_json),
    ) {
        (Some(stored), Some(incoming)) => stored == incoming,
        _ => false,
    }
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

    fn chapter(chapter_id: i64, is_read: bool, last_page_read: i64) -> ChapterNode {
        ChapterNode {
            manga_id: 3,
            chapter_id,
            url: None,
            is_read,
            is_bookmarked: false,
            last_read_at: 0,
            last_page_read,
        }
    }

    fn baseline(observed_at_ms: i64, chapters: &[(i64, bool, i64)]) -> MangaBaseline {
        MangaBaseline {
            observed_at_ms,
            chapters: chapters
                .iter()
                .map(|(id, read, page)| {
                    (
                        *id,
                        ChapterProgressState {
                            read: *read,
                            bookmarked: false,
                            last_page_read: *page,
                        },
                    )
                })
                .collect(),
        }
    }

    fn stored_row(device: &str, updated_at_ms: i64, record: Value) -> StoredChapterStateRow {
        StoredChapterStateRow {
            entity_id: "comic.chapter_state::comic::chapter".to_string(),
            record_updated_by_device_id: device.to_string(),
            record_updated_at_ms: updated_at_ms,
            record_json: record.to_string(),
        }
    }

    /// Runs the planner and the write guard together, as the mirror does, and returns the
    /// record that would be written.
    fn planned_record(
        observed: &ChapterNode,
        baseline: Option<&MangaBaseline>,
        desktop_edit_at_ms: Option<i64>,
        stored: Option<&StoredChapterStateRow>,
        observed_at_ms: i64,
    ) -> Option<Value> {
        let updated_at_ms = planned_chapter_state_updated_at(
            observed,
            baseline,
            desktop_edit_at_ms,
            stored,
            observed_at_ms,
        )?;
        let identity = chapter_state_identity(
            "server",
            "main",
            observed.manga_id,
            observed.chapter_id,
            None,
        );
        let record = chapter_state_record(&identity, "server", "main", observed, updated_at_ms);
        chapter_state_write_allowed(stored, &record.to_string()).then_some(record)
    }

    #[test]
    fn server_local_chapter_state_omits_portable_ref_keys() {
        let observed = chapter(211, false, 0);
        let identity = chapter_state_identity(
            "server",
            "main",
            observed.manga_id,
            observed.chapter_id,
            None,
        );
        let record = chapter_state_record(&identity, "server", "main", &observed, 1);
        assert!(record.get("portableWorkRef").is_none());
        assert!(record.get("portableChapterRef").is_none());
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
    fn derives_portable_chapter_from_work_binding_and_chapter_key() {
        let (work, chapter) = bound_comic_rows();
        let refs = portable_refs_from_work(&work, 3, &chapter.provider_key).unwrap();
        let identity = history_identity("server", "main", 3, 508, Some(refs));
        assert_eq!(identity.0, work.portable_id);
        assert_eq!(identity.1, chapter.portable_chapter_id);
        assert!(portable_refs_from_work(&work, 4, &chapter.provider_key).is_none());
        assert!(portable_refs_from_work(&work, 3, " ").is_none());
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
        // A cleared page position is the same state whether it is absent, null or zero.
        assert!(chapter_state_semantically_equal(
            r#"{"read":true,"bookmarked":false,"lastPageRead":0}"#,
            r#"{"read":true,"bookmarked":false,"lastPageRead":null}"#,
        ));
    }

    #[test]
    fn rejects_read_chapters_without_a_positive_id() {
        assert!(parse_read_chapter(&json!({ "url": "/chapter/1" })).is_none());
        assert!(parse_read_chapter(&json!({ "id": 0 })).is_none());
        assert!(parse_read_chapter(&json!({ "id": -1 })).is_none());
    }

    #[test]
    fn parses_library_chapter_nodes_and_rejects_missing_ids() {
        let parsed = parse_chapter_node(&json!({
            "id": 508,
            "mangaId": 3,
            "isRead": true,
            "isBookmarked": true,
            "lastReadAt": "1699999999",
            "lastPageRead": 12,
        }))
        .unwrap();
        assert_eq!((parsed.manga_id, parsed.chapter_id), (3, 508));
        assert_eq!(
            parsed.progress_state(),
            ChapterProgressState {
                read: true,
                bookmarked: true,
                last_page_read: 12
            }
        );
        assert_eq!(parsed.last_read_at, 1_699_999_999_000);
        assert!(parse_chapter_node(&json!({ "id": 508 })).is_none());
        assert!(parse_chapter_node(&json!({ "mangaId": 3 })).is_none());
    }

    #[test]
    fn emits_read_observed_since_the_previous_scan() {
        let observed = chapter(508, true, 0);
        let previous = baseline(1_000, &[(508, false, 0)]);
        let record = planned_record(&observed, Some(&previous), None, None, 5_000).unwrap();
        assert_eq!(record["read"], true);
        assert_eq!(record["suwayomiChapterId"], 508);
        // The change happened after the previous scan; that is the earliest it can claim.
        assert_eq!(record["updatedAtMs"], 1_001);
    }

    #[test]
    fn emits_read_requested_by_a_desktop_edit_without_a_baseline() {
        let observed = chapter(508, true, 0);
        let record = planned_record(&observed, None, Some(4_200), None, 5_000).unwrap();
        assert_eq!(record["read"], true);
        assert_eq!(record["updatedAtMs"], 4_200);
    }

    #[test]
    fn emits_unread_for_a_chapter_syncd_stored_as_read() {
        let observed = chapter(508, false, 0);
        // The mirror's own record goes stale even without a baseline (e.g. after a Core restart).
        let mirror_row = stored_row(
            MIRROR_DEVICE_ID,
            2_000,
            json!({ "read": true, "bookmarked": false, "updatedAtMs": 2_000 }),
        );
        let record = planned_record(&observed, None, None, Some(&mirror_row), 5_000).unwrap();
        assert_eq!(record["read"], false);
        assert_eq!(record["updatedAtMs"], 5_000);

        // A phone marked it read earlier; the desktop un-read it afterwards.
        let phone_row = stored_row(
            "phone-1",
            2_000,
            json!({ "read": true, "bookmarked": false, "updatedAtMs": 1_900 }),
        );
        let record = planned_record(&observed, None, Some(3_000), Some(&phone_row), 5_000).unwrap();
        assert_eq!(record["read"], false);
        assert_eq!(record["updatedAtMs"], 3_000);

        // Observed transition with no stored record: devices still learn the chapter is unread.
        let previous = baseline(1_000, &[(508, true, 0)]);
        let record = planned_record(&observed, Some(&previous), None, None, 5_000).unwrap();
        assert_eq!(record["read"], false);
    }

    #[test]
    fn device_written_legacy_record_follows_a_later_desktop_edit() {
        // A phone without the chapter binding marked it read under the server-local id; the
        // portable record still says unread, which matches Suwayomi after the desktop un-read it.
        let observed = chapter(508, false, 0);
        let portable_row = stored_row(
            MIRROR_DEVICE_ID,
            1_000,
            json!({ "read": false, "bookmarked": false, "updatedAtMs": 1_000 }),
        );
        let phone_legacy = stored_row(
            "phone-1",
            2_000,
            json!({ "read": true, "bookmarked": null, "updatedAtMs": 1_900 }),
        );
        let planned = planned_chapter_state_writes(
            &observed,
            None,
            Some(3_000),
            Some(&portable_row),
            Some(&phone_legacy),
            5_000,
        );
        assert_eq!(
            planned,
            PlannedChapterStateWrites {
                identity: None,
                legacy: Some(3_000)
            }
        );
        // Without evidence newer than the phone record the legacy record is left alone.
        let planned = planned_chapter_state_writes(
            &observed,
            None,
            Some(1_500),
            Some(&portable_row),
            Some(&phone_legacy),
            5_000,
        );
        assert_eq!(planned.legacy, None);
        // A legacy record that already matches Suwayomi needs nothing.
        let read = chapter(508, true, 0);
        let planned = planned_chapter_state_writes(
            &read,
            None,
            Some(3_000),
            None,
            Some(&phone_legacy),
            5_000,
        );
        assert_eq!(planned.legacy, None);
        assert_eq!(planned.identity, Some(3_000));
    }

    #[test]
    fn mirror_owned_legacy_record_seeds_a_missing_portable_record_and_follows_suwayomi() {
        let observed = chapter(508, true, 0);
        let mirror_legacy = stored_row(
            MIRROR_DEVICE_ID,
            2_500,
            json!({ "read": true, "bookmarked": false, "updatedAtMs": 2_500 }),
        );
        let planned =
            planned_chapter_state_writes(&observed, None, None, None, Some(&mirror_legacy), 5_000);
        assert_eq!(
            planned,
            PlannedChapterStateWrites {
                identity: Some(2_500),
                legacy: None
            }
        );
        // Once a portable record exists, the mirror-owned legacy one is no longer evidence.
        let phone_portable = stored_row(
            "phone-1",
            2_000,
            json!({ "read": false, "bookmarked": false, "updatedAtMs": 2_000 }),
        );
        let planned = planned_chapter_state_writes(
            &observed,
            None,
            None,
            Some(&phone_portable),
            Some(&mirror_legacy),
            5_000,
        );
        assert_eq!(planned.identity, None);
        // A stale mirror-owned legacy record still follows Suwayomi for devices that read it.
        let stale_legacy = stored_row(
            MIRROR_DEVICE_ID,
            2_500,
            json!({ "read": false, "bookmarked": false, "updatedAtMs": 2_500 }),
        );
        let desktop_portable = stored_row(
            MIRROR_DEVICE_ID,
            3_000,
            json!({ "read": true, "bookmarked": false, "updatedAtMs": 3_000 }),
        );
        let planned = planned_chapter_state_writes(
            &observed,
            None,
            None,
            Some(&desktop_portable),
            Some(&stale_legacy),
            5_000,
        );
        assert_eq!(
            planned,
            PlannedChapterStateWrites {
                identity: None,
                legacy: Some(5_000)
            }
        );
    }

    #[test]
    fn never_overwrites_newer_phone_state() {
        // Phone marked the chapter read at 4_000; Suwayomi has not caught up yet.
        let observed = chapter(508, false, 0);
        let phone_row = stored_row(
            "phone-1",
            4_000,
            json!({ "read": true, "bookmarked": false, "updatedAtMs": 3_990 }),
        );
        // No evidence at all: a stale snapshot never replaces a phone record.
        assert!(planned_record(&observed, None, None, Some(&phone_row), 9_000).is_none());
        // An older desktop edit loses.
        assert!(planned_record(&observed, None, Some(3_500), Some(&phone_row), 9_000).is_none());
        // A transition whose earliest possible time predates the phone record loses too.
        let previous = baseline(3_000, &[(508, true, 0)]);
        assert!(
            planned_record(&observed, Some(&previous), None, Some(&phone_row), 9_000).is_none()
        );
        // An older Suwayomi read time loses.
        let mut stale = chapter(508, false, 4);
        stale.last_read_at = 3_000;
        assert!(planned_record(&stale, None, None, Some(&phone_row), 9_000).is_none());
        // The write guard alone also refuses an older updatedAtMs.
        assert!(!chapter_state_write_allowed(
            Some(&phone_row),
            &json!({ "read": false, "bookmarked": false, "updatedAtMs": 4_000 }).to_string(),
        ));
    }

    #[test]
    fn does_not_re_emit_unchanged_chapters() {
        let observed = chapter(508, true, 7);
        let stored = stored_row(
            MIRROR_DEVICE_ID,
            2_000,
            json!({ "read": true, "bookmarked": false, "lastPageRead": 7, "updatedAtMs": 2_000 }),
        );
        // Matches the stored record, even with a desktop edit request.
        assert!(planned_record(&observed, None, Some(9_000), Some(&stored), 9_000).is_none());
        // Unchanged since the previous scan and never stored.
        let previous = baseline(1_000, &[(508, true, 7)]);
        assert!(planned_record(&observed, Some(&previous), None, None, 9_000).is_none());
        // Never stored and no evidence of a change: the catalog already carries it.
        assert!(planned_record(&observed, None, None, None, 9_000).is_none());
        // A new, default-state chapter that the previous scan did not know about.
        let fresh = chapter(509, false, 0);
        assert!(planned_record(&fresh, Some(&previous), None, None, 9_000).is_none());
    }

    #[test]
    fn mirror_rewrites_stay_ahead_of_its_own_stored_clock() {
        let observed = chapter(508, true, 3);
        let stored = stored_row(
            MIRROR_DEVICE_ID,
            8_000,
            json!({ "read": false, "bookmarked": false, "updatedAtMs": 7_990 }),
        );
        let previous = baseline(1_000, &[(508, false, 0)]);
        let record =
            planned_record(&observed, Some(&previous), None, Some(&stored), 9_000).unwrap();
        assert_eq!(record["updatedAtMs"], 8_001);
        assert_eq!(record["lastPageRead"], 3);
    }

    #[test]
    fn plans_hinted_then_dirty_then_unbaselined_then_rotating_scans() {
        let library = (1..=40).collect::<Vec<i64>>();
        let hinted = BTreeSet::from([7]);
        let dirty = BTreeSet::from([7, 9]);
        // Everything but 1..=3 already has a baseline.
        let plan = plan_manga_scans(&library, &hinted, &dirty, |id| id > 3, 10);
        assert_eq!(&plan.scan[..5], &[7, 9, 1, 2, 3]);
        assert_eq!(plan.scan.len(), 2 + SWEEP_SCANS_PER_TICK);
        // Rotation resumes at the cursor and skips titles already selected.
        assert_eq!(plan.scan[5], library[10]);
        assert!(plan.deferred.is_empty());
        let unique = plan.scan.iter().collect::<HashSet<_>>();
        assert_eq!(unique.len(), plan.scan.len());
        assert_eq!(plan.next_sweep_cursor, 10 + SWEEP_SCANS_PER_TICK - 3);
    }

    #[test]
    fn defers_dirty_titles_beyond_the_per_tick_bound() {
        let library = (1..=200).collect::<Vec<i64>>();
        let dirty = library.iter().copied().collect::<BTreeSet<_>>();
        let plan = plan_manga_scans(&library, &BTreeSet::new(), &dirty, |_| true, 0);
        // The sweep may take a deferred title, which is then no longer deferred.
        assert_eq!(
            plan.deferred.len(),
            200 - MAX_DIRTY_SCANS_PER_TICK - SWEEP_SCANS_PER_TICK
        );
        assert_eq!(
            plan.scan.len(),
            MAX_DIRTY_SCANS_PER_TICK + SWEEP_SCANS_PER_TICK
        );
        assert!(plan.scan.iter().all(|id| !plan.deferred.contains(id)));
    }

    #[test]
    fn coalesces_desktop_edit_hints() {
        let mut hints = MirrorHints::default();
        hints.record(&[3, 0, -1], &[508, 509], 1_000);
        hints.record(&[3], &[508], 2_000);
        assert_eq!(hints.manga_ids, BTreeSet::from([3]));
        assert_eq!(hints.chapter_edits.get(&508), Some(&2_000));
        assert_eq!(hints.chapter_edits.get(&509), Some(&1_000));
        assert!(!hints.is_empty());
        assert!(MirrorHints::default().is_empty());
    }
}
