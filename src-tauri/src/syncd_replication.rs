use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use tokio::time::sleep;
use uuid::Uuid;

use crate::syncd::middleware::{CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER};
use crate::syncd::models::{
    BookBookmarkPatch, BookBookmarkRecord, BookCategoryAssignmentPatch,
    BookCategoryAssignmentRecord, BookCategoryPatch, BookCategoryRecord, BookEntryPatch,
    BookEntryRecord, BookLibraryUiPatch, BookLibraryUiRecord, BookProgressPatch,
    BookProgressRecord, ChangeEnvelope, ErrorBody, MutationOperation, NovelBookmarkPatch,
    NovelBookmarkRecord, NovelChapterPatch, NovelChapterRecord, NovelClassificationPatch,
    NovelClassificationRecord, NovelEntryPatch, NovelEntryRecord, NovelHistoryPatch,
    NovelHistoryRecord, NovelProgressPatch, NovelProgressRecord, SyncdEffectiveDiscoverySource,
};
use crate::syncd_desktop::{
    build_pinned_http_client, desktop_state_dir, is_connection_error, is_needs_reauth_error,
    load_persisted_state, now_ms, revalidate_session, save_persisted_state, PersistedSyncSession,
    SyncdDesktopConnectionStatus, SyncdDesktopPersistedState, SyncdReconnectStatus,
};
use crate::{
    book_library_state_path, novel_library_state_path_for_target,
    novel_source_classification_state_path_for_target, LaunchTarget, LaunchTargetInfo,
};

const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const CLIENT_PROTOCOL_VERSION: u32 = 1;
const BOOKS_SCOPE_ID: &str = "books:global";
const EVENT_REPLICATION_STATE: &str = "syncd-replication-state";
const EVENT_REPLICATION_ERROR: &str = "syncd-replication-error";
const RECONNECT_DELAY: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncdReplicationStatus {
    Idle,
    Connecting,
    Replaying,
    Live,
    Paused,
    Degraded,
    Offline,
    NeedsReauth,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncdReplicationReplayMode {
    ChangesBootstrap,
    SseLive,
    RecoveryReplay,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdReplicationScopeCheckpoint {
    pub scope_id: String,
    pub last_applied_server_version: i64,
    pub min_replayable_seen: i64,
    pub last_replay_mode: SyncdReplicationReplayMode,
    pub last_applied_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdReplicationSnapshot {
    pub local_profile_id: String,
    pub active_session_key: Option<String>,
    pub replication_status: SyncdReplicationStatus,
    pub last_connected_at_ms: Option<i64>,
    pub last_error: Option<String>,
    pub books_scope_checkpoint: Option<SyncdReplicationScopeCheckpoint>,
    pub novels_scope_checkpoint: Option<SyncdReplicationScopeCheckpoint>,
    pub paused: bool,
    pub last_applied_scopes: Vec<String>,
    pub last_applied_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdSessionActionAvailability {
    pub can_set_active: bool,
    pub can_pause: bool,
    pub can_resume: bool,
    pub can_revalidate: bool,
    pub can_disconnect: bool,
    pub can_forget: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSyncSessionView {
    pub session_key: String,
    pub local_profile_id: String,
    pub remote_server_id: String,
    pub remote_profile_id: String,
    pub canonical_origin: String,
    pub fallback_origins: Vec<String>,
    pub tls_cert_sha256: String,
    pub last_discovery_source: SyncdEffectiveDiscoverySource,
    pub last_validated_at_ms: Option<i64>,
    pub last_known_status: SyncdDesktopConnectionStatus,
    pub is_active_for_sync: bool,
    pub replication_status: Option<SyncdReplicationStatus>,
    pub actions: SyncdSessionActionAvailability,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdSessionCatalog {
    pub local_profile_id: String,
    pub active_session_key: Option<String>,
    pub replication: SyncdReplicationSnapshot,
    pub sessions: Vec<PersistedSyncSessionView>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncdSetActiveReplicationSessionInput {
    pub profile_id: String,
    pub session_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncdReplicationProfileInput {
    pub profile_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncdRevalidateSessionInput {
    pub profile_id: String,
    pub session_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncdForgetPersistedSessionInput {
    pub profile_id: String,
    pub session_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedReplicationProfileState {
    active_session_key: Option<String>,
    replication_status: SyncdReplicationStatus,
    last_connected_at_ms: Option<i64>,
    last_error: Option<String>,
    books_scope_checkpoint: Option<SyncdReplicationScopeCheckpoint>,
    novels_scope_checkpoint: Option<SyncdReplicationScopeCheckpoint>,
    per_entity_remote_clock: BTreeMap<String, i64>,
    last_local_snapshot_digest_books: Option<String>,
    last_local_snapshot_digest_novels: Option<String>,
    paused: bool,
    last_applied_scopes: Vec<String>,
    last_applied_at_ms: Option<i64>,
}

impl PersistedReplicationProfileState {
    fn snapshot(&self, local_profile_id: &str) -> SyncdReplicationSnapshot {
        SyncdReplicationSnapshot {
            local_profile_id: local_profile_id.to_string(),
            active_session_key: self.active_session_key.clone(),
            replication_status: self.replication_status.clone(),
            last_connected_at_ms: self.last_connected_at_ms,
            last_error: self.last_error.clone(),
            books_scope_checkpoint: self.books_scope_checkpoint.clone(),
            novels_scope_checkpoint: self.novels_scope_checkpoint.clone(),
            paused: self.paused,
            last_applied_scopes: self.last_applied_scopes.clone(),
            last_applied_at_ms: self.last_applied_at_ms,
        }
    }
}

impl Default for PersistedReplicationProfileState {
    fn default() -> Self {
        Self {
            active_session_key: None,
            replication_status: SyncdReplicationStatus::Idle,
            last_connected_at_ms: None,
            last_error: None,
            books_scope_checkpoint: None,
            novels_scope_checkpoint: None,
            per_entity_remote_clock: BTreeMap::new(),
            last_local_snapshot_digest_books: None,
            last_local_snapshot_digest_novels: None,
            paused: false,
            last_applied_scopes: Vec::new(),
            last_applied_at_ms: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PersistedReplicationState {
    profiles: BTreeMap<String, PersistedReplicationProfileState>,
}

#[derive(Default)]
struct ReplicationRuntime {
    workers: HashMap<String, WorkerHandle>,
    local_authority: HashMap<String, LocalAuthoritySession>,
}

struct WorkerHandle {
    generation: u64,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Debug, Clone)]
struct LocalAuthoritySession {
    profile_id: String,
    local_base_url: String,
    access_token: String,
}

#[derive(Clone, Default)]
pub struct SyncdReplicationState {
    runtime: Arc<Mutex<ReplicationRuntime>>,
}

fn replication_state_path() -> PathBuf {
    desktop_state_dir().join("syncd-replication-state.json")
}

fn replication_log_path() -> PathBuf {
    desktop_state_dir().join("syncd-replication.log")
}

fn replication_log_enabled() -> bool {
    matches!(
        std::env::var("TAURI_AUTOMATION").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE")
    ) || matches!(
        std::env::var("TAURI_WEBVIEW_AUTOMATION").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE")
    )
}

fn replication_log(message: impl AsRef<str>) {
    if !replication_log_enabled() {
        return;
    }

    let path = replication_log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{}] {}", now_ms(), message.as_ref());
    }
}

fn load_replication_state() -> Result<PersistedReplicationState, String> {
    let path = replication_state_path();
    if !path.exists() {
        return Ok(PersistedReplicationState::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn save_replication_state(state: &PersistedReplicationState) -> Result<(), String> {
    let path = replication_state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, payload).map_err(|error| error.to_string())
}

fn profile_state_mut<'a>(
    state: &'a mut PersistedReplicationState,
    profile_id: &str,
) -> &'a mut PersistedReplicationProfileState {
    state.profiles.entry(profile_id.to_string()).or_default()
}

fn profile_snapshot(
    state: &PersistedReplicationState,
    profile_id: &str,
) -> SyncdReplicationSnapshot {
    state
        .profiles
        .get(profile_id)
        .cloned()
        .unwrap_or_default()
        .snapshot(profile_id)
}

fn choose_default_session(sessions: &[PersistedSyncSession], profile_id: &str) -> Option<String> {
    sessions
        .iter()
        .filter(|session| session.local_profile_id == profile_id)
        .max_by_key(|session| session.last_validated_at_ms.unwrap_or_default())
        .map(|session| session.session_key.clone())
}

fn build_session_catalog(
    persisted: &SyncdDesktopPersistedState,
    replication: &PersistedReplicationState,
    profile_id: &str,
) -> SyncdSessionCatalog {
    let snapshot = profile_snapshot(replication, profile_id);
    let active_session_key = snapshot.active_session_key.clone();
    let sessions = persisted
        .sessions
        .iter()
        .filter(|session| session.local_profile_id == profile_id)
        .map(|session| {
            let is_active = active_session_key.as_deref() == Some(session.session_key.as_str());
            let replication_status = is_active.then_some(snapshot.replication_status.clone());
            PersistedSyncSessionView {
                session_key: session.session_key.clone(),
                local_profile_id: session.local_profile_id.clone(),
                remote_server_id: session.remote_server_id.clone(),
                remote_profile_id: session.remote_profile_id.clone(),
                canonical_origin: session.canonical_origin.clone(),
                fallback_origins: session.fallback_origins.clone(),
                tls_cert_sha256: session.tls_cert_sha256.clone(),
                last_discovery_source: session.last_discovery_source,
                last_validated_at_ms: session.last_validated_at_ms,
                last_known_status: session.last_known_status.clone(),
                is_active_for_sync: is_active,
                replication_status: replication_status.clone(),
                actions: SyncdSessionActionAvailability {
                    can_set_active: !is_active,
                    can_pause: is_active && !snapshot.paused,
                    can_resume: is_active && snapshot.paused,
                    can_revalidate: true,
                    can_disconnect: true,
                    can_forget: !is_active,
                },
            }
        })
        .collect();

    SyncdSessionCatalog {
        local_profile_id: profile_id.to_string(),
        active_session_key,
        replication: snapshot,
        sessions,
    }
}

async fn emit_replication_state_for_profile(
    app: &AppHandle,
    profile_id: &str,
) -> Result<(), String> {
    let state = load_replication_state()?;
    app.emit(
        EVENT_REPLICATION_STATE,
        profile_snapshot(&state, profile_id),
    )
    .map_err(|error| error.to_string())
}

fn emit_replication_error(app: &AppHandle, profile_id: &str, error: impl Into<String>) {
    let payload = serde_json::json!({
        "profileId": profile_id,
        "error": error.into(),
    });
    let _ = app.emit(EVENT_REPLICATION_ERROR, payload);
}

fn update_profile_state(
    profile_id: &str,
    mutator: impl FnOnce(&mut PersistedReplicationProfileState),
) -> Result<SyncdReplicationSnapshot, String> {
    let mut state = load_replication_state()?;
    let profile = profile_state_mut(&mut state, profile_id);
    mutator(profile);
    let snapshot = profile.snapshot(profile_id);
    save_replication_state(&state)?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn syncd_get_replication_state(
    profile_id: String,
) -> Result<SyncdReplicationSnapshot, String> {
    let state = load_replication_state()?;
    Ok(profile_snapshot(&state, &profile_id))
}

#[tauri::command]
pub async fn syncd_get_session_catalog(profile_id: String) -> Result<SyncdSessionCatalog, String> {
    let persisted = load_persisted_state()?;
    let replication = load_replication_state()?;
    Ok(build_session_catalog(&persisted, &replication, &profile_id))
}

#[tauri::command]
pub async fn syncd_set_active_replication_session(
    input: SyncdSetActiveReplicationSessionInput,
    app: AppHandle,
    state: State<'_, SyncdReplicationState>,
) -> Result<SyncdReplicationSnapshot, String> {
    let persisted = load_persisted_state()?;
    if !persisted.sessions.iter().any(|session| {
        session.local_profile_id == input.profile_id && session.session_key == input.session_key
    }) {
        return Err("The selected sync session no longer exists locally.".to_string());
    }
    let snapshot = update_profile_state(&input.profile_id, |profile| {
        profile.active_session_key = Some(input.session_key.clone());
        profile.paused = false;
        profile.last_error = None;
        profile.replication_status = SyncdReplicationStatus::Idle;
    })?;
    ensure_worker_for_profile(&app, &state, &input.profile_id).await?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn syncd_pause_replication(
    input: SyncdReplicationProfileInput,
    app: AppHandle,
    state: State<'_, SyncdReplicationState>,
) -> Result<SyncdReplicationSnapshot, String> {
    let snapshot = update_profile_state(&input.profile_id, |profile| {
        profile.paused = true;
        profile.replication_status = SyncdReplicationStatus::Paused;
        profile.last_error = None;
    })?;
    cancel_worker_for_profile(&state, &input.profile_id).await;
    emit_replication_state_for_profile(&app, &input.profile_id).await?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn syncd_resume_replication(
    input: SyncdReplicationProfileInput,
    app: AppHandle,
    state: State<'_, SyncdReplicationState>,
) -> Result<SyncdReplicationSnapshot, String> {
    let snapshot = update_profile_state(&input.profile_id, |profile| {
        profile.paused = false;
        if profile.active_session_key.is_some() {
            profile.replication_status = SyncdReplicationStatus::Idle;
        }
        profile.last_error = None;
    })?;
    ensure_worker_for_profile(&app, &state, &input.profile_id).await?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn syncd_force_replication_reconnect(
    input: SyncdReplicationProfileInput,
    app: AppHandle,
    state: State<'_, SyncdReplicationState>,
) -> Result<SyncdReplicationSnapshot, String> {
    let snapshot = update_profile_state(&input.profile_id, |profile| {
        profile.last_error = None;
        if profile.paused {
            profile.replication_status = SyncdReplicationStatus::Paused;
        } else if profile.active_session_key.is_some() {
            profile.replication_status = SyncdReplicationStatus::Idle;
        }
    })?;
    ensure_worker_for_profile(&app, &state, &input.profile_id).await?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn syncd_revalidate_session(
    input: SyncdRevalidateSessionInput,
    app: AppHandle,
    state: State<'_, SyncdReplicationState>,
) -> Result<SyncdReconnectStatus, String> {
    let mut persisted = load_persisted_state()?;
    let Some(session) = persisted.sessions.iter_mut().find(|session| {
        session.local_profile_id == input.profile_id && session.session_key == input.session_key
    }) else {
        return Err("The selected sync session no longer exists locally.".to_string());
    };
    let result = revalidate_session(session).await;
    session.last_known_status = result.status.clone();
    if matches!(result.status, SyncdDesktopConnectionStatus::Connected) {
        session.last_validated_at_ms = Some(now_ms());
    }
    save_persisted_state(&persisted)?;
    if matches!(result.status, SyncdDesktopConnectionStatus::Connected) {
        ensure_worker_for_profile(&app, &state, &input.profile_id).await?;
    } else {
        emit_replication_state_for_profile(&app, &input.profile_id).await?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn syncd_forget_persisted_session(
    input: SyncdForgetPersistedSessionInput,
    app: AppHandle,
) -> Result<(), String> {
    let mut replication = load_replication_state()?;
    if replication
        .profiles
        .get(&input.profile_id)
        .and_then(|profile| profile.active_session_key.as_deref())
        == Some(input.session_key.as_str())
    {
        return Err("Disconnect the active session before forgetting it.".to_string());
    }

    let mut persisted = load_persisted_state()?;
    persisted.sessions.retain(|session| {
        !(session.local_profile_id == input.profile_id && session.session_key == input.session_key)
    });
    save_persisted_state(&persisted)?;
    let profile = profile_state_mut(&mut replication, &input.profile_id);
    if profile.active_session_key.is_none()
        && choose_default_session(&persisted.sessions, &input.profile_id).is_none()
    {
        profile.replication_status = SyncdReplicationStatus::Idle;
        profile.last_error = None;
    }
    save_replication_state(&replication)?;
    emit_replication_state_for_profile(&app, &input.profile_id).await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerializableMutationsRequest {
    request_id: String,
    mutations: Vec<SerializableMutationInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "entityType")]
#[allow(dead_code)]
enum SerializableMutationInput {
    #[serde(rename = "book.entry")]
    BookEntry {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: Option<BookEntryPatch>,
    },
    #[serde(rename = "book.category")]
    BookCategory {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: Option<BookCategoryPatch>,
    },
    #[serde(rename = "book.category_assignment")]
    BookCategoryAssignment {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: Option<BookCategoryAssignmentPatch>,
    },
    #[serde(rename = "book.library_ui")]
    BookLibraryUi {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: BookLibraryUiPatch,
    },
    #[serde(rename = "book.progress")]
    BookProgress {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: BookProgressPatch,
    },
    #[serde(rename = "novel.progress")]
    NovelProgress {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: NovelProgressPatch,
    },
    #[serde(rename = "book.bookmark")]
    BookBookmark {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: Option<BookBookmarkPatch>,
    },
    #[serde(rename = "novel.entry")]
    NovelEntry {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: Option<NovelEntryPatch>,
    },
    #[serde(rename = "novel.chapter")]
    NovelChapter {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: Option<NovelChapterPatch>,
    },
    #[serde(rename = "novel.bookmark")]
    NovelBookmark {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: Option<NovelBookmarkPatch>,
    },
    #[serde(rename = "novel.history")]
    NovelHistory {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: Option<NovelHistoryPatch>,
    },
    #[serde(rename = "novel.classification")]
    NovelClassification {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: Option<NovelClassificationPatch>,
    },
}

impl SerializableMutationInput {
    fn entity_type_label(&self) -> &'static str {
        match self {
            Self::BookEntry { .. } => "book.entry",
            Self::BookCategory { .. } => "book.category",
            Self::BookCategoryAssignment { .. } => "book.category_assignment",
            Self::BookLibraryUi { .. } => "book.library_ui",
            Self::BookProgress { .. } => "book.progress",
            Self::NovelProgress { .. } => "novel.progress",
            Self::BookBookmark { .. } => "book.bookmark",
            Self::NovelEntry { .. } => "novel.entry",
            Self::NovelChapter { .. } => "novel.chapter",
            Self::NovelBookmark { .. } => "novel.bookmark",
            Self::NovelHistory { .. } => "novel.history",
            Self::NovelClassification { .. } => "novel.classification",
        }
    }

    fn op_label(&self) -> &'static str {
        let op = match self {
            Self::BookEntry { base, .. }
            | Self::BookCategory { base, .. }
            | Self::BookCategoryAssignment { base, .. }
            | Self::BookProgress { base, .. }
            | Self::NovelProgress { base, .. }
            | Self::BookBookmark { base, .. }
            | Self::NovelEntry { base, .. }
            | Self::NovelChapter { base, .. }
            | Self::NovelBookmark { base, .. }
            | Self::NovelHistory { base, .. }
            | Self::NovelClassification { base, .. } => &base.op,
            Self::BookLibraryUi { base, .. } => &base.op,
        };
        match op {
            MutationOperation::Merge => "merge",
            MutationOperation::Delete => "delete",
        }
    }

    fn entity_id(&self) -> &str {
        match self {
            Self::BookEntry { base, .. }
            | Self::BookCategory { base, .. }
            | Self::BookCategoryAssignment { base, .. }
            | Self::BookProgress { base, .. }
            | Self::NovelProgress { base, .. }
            | Self::BookBookmark { base, .. }
            | Self::NovelEntry { base, .. }
            | Self::NovelChapter { base, .. }
            | Self::NovelBookmark { base, .. }
            | Self::NovelHistory { base, .. }
            | Self::NovelClassification { base, .. } => &base.entity_id,
            Self::BookLibraryUi { base, .. } => &base.entity_id,
        }
    }
}

fn summarize_mutations(mutations: &[SerializableMutationInput]) -> String {
    let summary = mutations
        .iter()
        .map(|mutation| {
            format!(
                "{}:{}:{}",
                mutation.entity_type_label(),
                mutation.op_label(),
                mutation.entity_id()
            )
        })
        .collect::<Vec<_>>();
    if summary.is_empty() {
        "none".to_string()
    } else {
        summary.join(", ")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerializableMutationBase {
    client_mutation_id: String,
    scope_id: String,
    entity_id: String,
    op: MutationOperation,
    lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedBookLibraryState {
    version: Option<i64>,
    books: Vec<Value>,
    book_progress: Vec<LocalBookProgress>,
    book_bookmarks: Vec<LocalBookBookmark>,
    books_categories: Vec<Value>,
    books_category_assignments: BTreeMap<String, Vec<String>>,
    books_library_ui: Value,
    updated_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedNovelLibraryState {
    version: Option<i64>,
    scope_key: Option<String>,
    entries: Vec<Value>,
    chapters: Vec<Value>,
    progress: Vec<LocalNovelProgress>,
    bookmarks: Vec<LocalNovelBookmark>,
    history: Vec<Value>,
    updated_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedNovelSourceClassificationState {
    version: Option<i64>,
    scope_key: Option<String>,
    records: Vec<Value>,
    updated_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LocalBookProgress {
    book_id: String,
    location: Option<String>,
    href: Option<String>,
    progress_percent: f64,
    last_read_at: i64,
    page_index: Option<i64>,
    total_pages: Option<i64>,
    section_label: Option<String>,
    renderer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LocalBookBookmark {
    book_id: String,
    location: Option<String>,
    href: Option<String>,
    page_index: Option<i64>,
    progress_percent: f64,
    label: Option<String>,
    saved_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LocalNovelProgress {
    novel_id: String,
    chapter_id: Option<String>,
    chapter_title: Option<String>,
    progress_percent: f64,
    locator: Option<String>,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LocalNovelBookmark {
    novel_id: String,
    chapter_id: Option<String>,
    chapter_title: Option<String>,
    locator: Option<String>,
    label: Option<String>,
    saved_at: i64,
}

#[derive(Debug, Clone, Default)]
struct RemoteApplyOutcome {
    books_changed: bool,
    novels_changed: bool,
    applied_scopes: HashSet<String>,
}

fn novels_scope_id(remote_profile_id: &str) -> String {
    format!("novels:profile:{remote_profile_id}")
}

fn hash_digest(input: &str) -> String {
    let digest = sha2::Sha256::digest(input.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn profile_state_needs_worker(profile: &PersistedReplicationProfileState) -> bool {
    profile.active_session_key.is_some() && !profile.paused
}

fn read_books_state() -> Result<PersistedBookLibraryState, String> {
    let path = book_library_state_path()?;
    if !path.exists() {
        return Ok(PersistedBookLibraryState::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn write_books_state(state: &PersistedBookLibraryState) -> Result<(), String> {
    let path = book_library_state_path()?;
    let payload = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, payload).map_err(|error| error.to_string())
}

fn read_novels_state(
    launch_target: &LaunchTargetInfo,
    profile_id: &str,
) -> Result<PersistedNovelLibraryState, String> {
    let path = novel_library_state_path_for_target(launch_target, Some(profile_id), None)?;
    if !path.exists() {
        return Ok(PersistedNovelLibraryState::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn write_novels_state(
    launch_target: &LaunchTargetInfo,
    profile_id: &str,
    state: &PersistedNovelLibraryState,
) -> Result<(), String> {
    let path = novel_library_state_path_for_target(launch_target, Some(profile_id), None)?;
    let payload = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, payload).map_err(|error| error.to_string())
}

fn read_novel_classification_state(
    launch_target: &LaunchTargetInfo,
    profile_id: &str,
) -> Result<PersistedNovelSourceClassificationState, String> {
    let path =
        novel_source_classification_state_path_for_target(launch_target, Some(profile_id), None)?;
    if !path.exists() {
        return Ok(PersistedNovelSourceClassificationState::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn write_novel_classification_state(
    launch_target: &LaunchTargetInfo,
    profile_id: &str,
    state: &PersistedNovelSourceClassificationState,
) -> Result<(), String> {
    let path =
        novel_source_classification_state_path_for_target(launch_target, Some(profile_id), None)?;
    let payload = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, payload).map_err(|error| error.to_string())
}

pub async fn bootstrap_runtime(app: AppHandle, state: SyncdReplicationState) -> Result<(), String> {
    let desktop = load_persisted_state()?;
    let mut replication = load_replication_state()?;
    let mut known_profiles = desktop
        .sessions
        .iter()
        .map(|session| session.local_profile_id.clone())
        .collect::<HashSet<_>>();
    known_profiles.extend(replication.profiles.keys().cloned());

    for profile_id in known_profiles.iter().cloned() {
        let profile = profile_state_mut(&mut replication, &profile_id);
        if profile.active_session_key.is_none() {
            profile.active_session_key = choose_default_session(&desktop.sessions, &profile_id);
        }
    }
    save_replication_state(&replication)?;

    if let Some(runtime) = crate::syncd_sidecar::current_runtime_info(&app) {
        if runtime.host_mode {
            for profile_id in &known_profiles {
                ensure_local_authority_for_profile(
                    &app,
                    &state,
                    profile_id,
                    &runtime.local_base_url,
                )
                .await?;
            }
        }
    }

    for (profile_id, profile) in replication.profiles {
        if profile_state_needs_worker(&profile) {
            ensure_worker_for_profile(&app, &state, &profile_id).await?;
        } else {
            emit_replication_state_for_profile(&app, &profile_id).await?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAuthorityTokenRequest {
    profile_id: String,
    device_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalAuthorityTokenResponse {
    access_token: String,
}

fn insecure_local_syncd_client() -> Result<reqwest::Client, String> {
    crate::ensure_process_rustls_crypto_provider();
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| error.to_string())
}

pub async fn ensure_local_authority_for_profile(
    app: &AppHandle,
    state: &SyncdReplicationState,
    profile_id: &str,
    local_base_url: &str,
) -> Result<(), String> {
    {
        let runtime = state.runtime.lock().await;
        if runtime
            .local_authority
            .get(profile_id)
            .map(|session| session.local_base_url == local_base_url)
            .unwrap_or(false)
        {
            return Ok(());
        }
    }

    let desktop = load_persisted_state()?;
    let client = insecure_local_syncd_client()?;
    let response = client
        .post(format!("{local_base_url}/v1/local/authority-token"))
        .json(&LocalAuthorityTokenRequest {
            profile_id: profile_id.to_string(),
            device_id: desktop.device_id,
        })
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(if body.trim().is_empty() {
            "Failed to issue local authority token.".to_string()
        } else {
            body
        });
    }
    let payload: LocalAuthorityTokenResponse =
        response.json().await.map_err(|error| error.to_string())?;

    {
        let mut runtime = state.runtime.lock().await;
        runtime.local_authority.insert(
            profile_id.to_string(),
            LocalAuthoritySession {
                profile_id: profile_id.to_string(),
                local_base_url: local_base_url.to_string(),
                access_token: payload.access_token,
            },
        );
    }

    let _ = update_profile_state(profile_id, |profile| {
        if profile.active_session_key.is_none() && !profile.paused {
            profile.replication_status = SyncdReplicationStatus::Idle;
            profile.last_error = None;
        }
    });
    ensure_worker_for_profile(app, state, profile_id).await?;
    Ok(())
}

pub async fn handle_new_approved_session(
    app: &AppHandle,
    state: &SyncdReplicationState,
    session: &PersistedSyncSession,
) -> Result<(), String> {
    let snapshot = update_profile_state(&session.local_profile_id, |profile| {
        if profile.active_session_key.is_none() {
            profile.active_session_key = Some(session.session_key.clone());
        }
        if !profile.paused {
            profile.replication_status = SyncdReplicationStatus::Idle;
            profile.last_error = None;
        }
    })?;
    if snapshot.active_session_key.as_deref() == Some(session.session_key.as_str())
        && !snapshot.paused
    {
        ensure_worker_for_profile(app, state, &session.local_profile_id).await?;
    } else {
        emit_replication_state_for_profile(app, &session.local_profile_id).await?;
    }
    Ok(())
}

pub async fn handle_persisted_session_removed(
    app: &AppHandle,
    state: &SyncdReplicationState,
    profile_id: &str,
    session_key: &str,
) -> Result<(), String> {
    let desktop = load_persisted_state()?;
    let mut replication = load_replication_state()?;
    let profile = profile_state_mut(&mut replication, profile_id);
    if profile.active_session_key.as_deref() == Some(session_key) {
        profile.active_session_key = choose_default_session(&desktop.sessions, profile_id);
        profile.paused = false;
        profile.last_error = None;
        profile.replication_status = SyncdReplicationStatus::Idle;
    }
    save_replication_state(&replication)?;
    cancel_worker_for_profile(state, profile_id).await;
    if replication
        .profiles
        .get(profile_id)
        .map(profile_state_needs_worker)
        .unwrap_or(false)
    {
        ensure_worker_for_profile(app, state, profile_id).await?;
    } else {
        emit_replication_state_for_profile(app, profile_id).await?;
    }
    Ok(())
}

async fn ensure_worker_for_profile(
    app: &AppHandle,
    state: &SyncdReplicationState,
    profile_id: &str,
) -> Result<(), String> {
    let generation = now_ms() as u64;
    {
        let mut runtime = state.runtime.lock().await;
        if let Some(existing) = runtime.workers.remove(profile_id) {
            existing.task.abort();
        }
        let app_handle = app.clone();
        let state_handle = state.clone();
        let profile = profile_id.to_string();
        let task = tauri::async_runtime::spawn(async move {
            run_profile_worker(app_handle, state_handle, profile.clone(), generation).await;
        });
        runtime
            .workers
            .insert(profile_id.to_string(), WorkerHandle { generation, task });
    }
    Ok(())
}

async fn cancel_worker_for_profile(state: &SyncdReplicationState, profile_id: &str) {
    let mut runtime = state.runtime.lock().await;
    if let Some(existing) = runtime.workers.remove(profile_id) {
        existing.task.abort();
    }
}

async fn worker_generation_matches(
    state: &SyncdReplicationState,
    profile_id: &str,
    generation: u64,
) -> bool {
    let runtime = state.runtime.lock().await;
    runtime
        .workers
        .get(profile_id)
        .map(|worker| worker.generation == generation)
        .unwrap_or(false)
}

async fn run_profile_worker(
    app: AppHandle,
    state: SyncdReplicationState,
    profile_id: String,
    generation: u64,
) {
    enum WorkerEndpoint {
        LocalAuthority(LocalAuthoritySession),
        PersistedSession {
            session: PersistedSyncSession,
            connected_origin: String,
            novels_profile_id: String,
        },
    }

    loop {
        if !worker_generation_matches(&state, &profile_id, generation).await {
            return;
        }
        let replication = match load_replication_state() {
            Ok(state) => state,
            Err(error) => {
                emit_replication_error(&app, &profile_id, error);
                return;
            }
        };
        let profile = replication
            .profiles
            .get(&profile_id)
            .cloned()
            .unwrap_or_default();
        if profile.paused {
            let _ = emit_replication_state_for_profile(&app, &profile_id).await;
            return;
        }
        let local_authority = {
            let runtime = state.runtime.lock().await;
            runtime.local_authority.get(&profile_id).cloned()
        };
        let endpoint = if let Some(local_authority) = local_authority {
            WorkerEndpoint::LocalAuthority(local_authority)
        } else {
            let desktop = match load_persisted_state() {
                Ok(state) => state,
                Err(error) => {
                    emit_replication_error(&app, &profile_id, error);
                    return;
                }
            };
            let Some(active_session_key) = profile.active_session_key.clone() else {
                let _ = emit_replication_state_for_profile(&app, &profile_id).await;
                return;
            };
            let Some(session) = desktop
                .sessions
                .iter()
                .find(|session| {
                    session.local_profile_id == profile_id
                        && session.session_key == active_session_key
                })
                .cloned()
            else {
                let _ = update_profile_state(&profile_id, |profile| {
                    profile.active_session_key = None;
                    profile.replication_status = SyncdReplicationStatus::Idle;
                    profile.last_error =
                        Some("The active sync session no longer exists locally.".to_string());
                });
                let _ = emit_replication_state_for_profile(&app, &profile_id).await;
                return;
            };

            let revalidated = revalidate_session(&session).await;
            if !matches!(revalidated.status, SyncdDesktopConnectionStatus::Connected) {
                let message = revalidated
                    .error
                    .clone()
                    .unwrap_or_else(|| "Session revalidation failed.".to_string());
                let next_status = if matches!(
                    revalidated.status,
                    SyncdDesktopConnectionStatus::NeedsReauth
                ) {
                    SyncdReplicationStatus::NeedsReauth
                } else {
                    SyncdReplicationStatus::Offline
                };
                let _ = update_profile_state(&profile_id, |profile| {
                    profile.replication_status = next_status;
                    profile.last_error = Some(message.clone());
                });
                emit_replication_error(&app, &profile_id, message);
                let _ = emit_replication_state_for_profile(&app, &profile_id).await;
                sleep(RECONNECT_DELAY).await;
                continue;
            }
            WorkerEndpoint::PersistedSession {
                novels_profile_id: session.remote_profile_id.clone(),
                connected_origin: revalidated.remote_origin,
                session,
            }
        };

        let _ = update_profile_state(&profile_id, |profile| {
            profile.replication_status = SyncdReplicationStatus::Connecting;
            profile.last_error = None;
        });
        let _ = emit_replication_state_for_profile(&app, &profile_id).await;

        let replay_result = match &endpoint {
            WorkerEndpoint::LocalAuthority(local) => {
                replay_and_stream_local_authority(&app, &profile_id, local).await
            }
            WorkerEndpoint::PersistedSession {
                session,
                connected_origin,
                novels_profile_id,
            } => {
                replay_and_stream_remote(
                    &app,
                    &profile_id,
                    session,
                    connected_origin,
                    novels_profile_id,
                )
                .await
            }
        };

        match replay_result {
            Ok(()) => {
                sleep(RECONNECT_DELAY).await;
            }
            Err(error) if is_needs_reauth_error(&error) => {
                let _ = update_profile_state(&profile_id, |profile| {
                    profile.replication_status = SyncdReplicationStatus::NeedsReauth;
                    profile.last_error = Some(error.clone());
                });
                emit_replication_error(&app, &profile_id, error);
                let _ = emit_replication_state_for_profile(&app, &profile_id).await;
                return;
            }
            Err(error) => {
                let next_status = if is_connection_error(&error) {
                    SyncdReplicationStatus::Offline
                } else {
                    SyncdReplicationStatus::Degraded
                };
                let _ = update_profile_state(&profile_id, |profile| {
                    profile.replication_status = next_status;
                    profile.last_error = Some(error.clone());
                });
                emit_replication_error(&app, &profile_id, error);
                let _ = emit_replication_state_for_profile(&app, &profile_id).await;
                sleep(RECONNECT_DELAY).await;
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangesResponsePayload {
    #[allow(dead_code)]
    current_server_version: i64,
    min_replayable_server_version: i64,
    changes: Vec<ChangeEnvelope>,
}

async fn replay_and_stream_remote(
    app: &AppHandle,
    profile_id: &str,
    session: &PersistedSyncSession,
    connected_origin: &str,
    novels_profile_id: &str,
) -> Result<(), String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    loop {
        let snapshot = profile_snapshot(&load_replication_state()?, profile_id);
        let since_version = [
            snapshot
                .books_scope_checkpoint
                .as_ref()
                .map(|checkpoint| checkpoint.last_applied_server_version)
                .unwrap_or_default(),
            snapshot
                .novels_scope_checkpoint
                .as_ref()
                .map(|checkpoint| checkpoint.last_applied_server_version)
                .unwrap_or_default(),
        ]
        .into_iter()
        .min()
        .unwrap_or_default();
        let changes = fetch_changes_remote(session, connected_origin, since_version).await?;
        let _ = update_profile_state(profile_id, |profile| {
            profile.replication_status = SyncdReplicationStatus::Replaying;
            profile.last_error = None;
        });
        if !changes.changes.is_empty() {
            apply_remote_envelopes(
                app,
                &launch_target,
                profile_id,
                novels_profile_id,
                &changes.changes,
                changes.min_replayable_server_version,
                SyncdReplicationReplayMode::ChangesBootstrap,
            )
            .await?;
        }
        let _ = update_profile_state(profile_id, |profile| {
            profile.replication_status = SyncdReplicationStatus::Live;
            profile.last_connected_at_ms = Some(now_ms());
            profile.last_error = None;
        });
        let _ = emit_replication_state_for_profile(app, profile_id).await;
        match stream_live_events(
            app,
            &launch_target,
            profile_id,
            session,
            connected_origin,
            novels_profile_id,
        )
        .await
        {
            Ok(StreamExit::ReplayRequired) => continue,
            Ok(StreamExit::Disconnected) => {
                return Err("Live sync stream disconnected.".to_string())
            }
            Err(error) => return Err(error),
        }
    }
}

enum StreamExit {
    ReplayRequired,
    Disconnected,
}

async fn replay_and_stream_local_authority(
    app: &AppHandle,
    profile_id: &str,
    authority: &LocalAuthoritySession,
) -> Result<(), String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    loop {
        let snapshot = profile_snapshot(&load_replication_state()?, profile_id);
        let since_version = [
            snapshot
                .books_scope_checkpoint
                .as_ref()
                .map(|checkpoint| checkpoint.last_applied_server_version)
                .unwrap_or_default(),
            snapshot
                .novels_scope_checkpoint
                .as_ref()
                .map(|checkpoint| checkpoint.last_applied_server_version)
                .unwrap_or_default(),
        ]
        .into_iter()
        .min()
        .unwrap_or_default();
        let changes = fetch_changes_local_authority(authority, since_version).await?;
        let _ = update_profile_state(profile_id, |profile| {
            profile.replication_status = SyncdReplicationStatus::Replaying;
            profile.last_error = None;
        });
        if !changes.changes.is_empty() {
            apply_remote_envelopes(
                app,
                &launch_target,
                profile_id,
                &authority.profile_id,
                &changes.changes,
                changes.min_replayable_server_version,
                SyncdReplicationReplayMode::ChangesBootstrap,
            )
            .await?;
        }
        let _ = update_profile_state(profile_id, |profile| {
            profile.replication_status = SyncdReplicationStatus::Live;
            profile.last_connected_at_ms = Some(now_ms());
            profile.last_error = None;
        });
        let _ = emit_replication_state_for_profile(app, profile_id).await;
        match stream_live_events_local_authority(app, &launch_target, profile_id, authority).await {
            Ok(StreamExit::ReplayRequired) => continue,
            Ok(StreamExit::Disconnected) => {
                return Err("Live sync stream disconnected.".to_string())
            }
            Err(error) => return Err(error),
        }
    }
}

async fn fetch_changes_remote(
    session: &PersistedSyncSession,
    origin: &str,
    since_version: i64,
) -> Result<ChangesResponsePayload, String> {
    let client = build_pinned_http_client(&session.tls_cert_sha256)?;
    let response = client
        .get(format!("{origin}/v1/changes"))
        .query(&[("sinceVersion", since_version)])
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header(CLIENT_VERSION_HEADER.as_str(), CLIENT_VERSION)
        .header(
            CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        return response.json().await.map_err(|error| error.to_string());
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<ErrorBody>(&body)
        .ok()
        .map(|body| body.error);
    if let Some(detail) = detail {
        if detail.code == "REPLAY_WINDOW_EXPIRED" {
            return Err("Replication fell behind syncd's replay window and syncd still has no authoritative snapshot route for recovery.".to_string());
        }
        if detail.code == "UNAUTHORIZED" {
            return Err("needs_reauth".to_string());
        }
        return Err(detail.message);
    }
    Err(format!("Changes replay failed with HTTP {status}."))
}

async fn fetch_changes_local_authority(
    authority: &LocalAuthoritySession,
    since_version: i64,
) -> Result<ChangesResponsePayload, String> {
    let client = insecure_local_syncd_client()?;
    let response = client
        .get(format!("{}/v1/changes", authority.local_base_url))
        .query(&[("sinceVersion", since_version)])
        .header(
            "Authorization",
            format!("Bearer {}", authority.access_token),
        )
        .header(CLIENT_VERSION_HEADER.as_str(), CLIENT_VERSION)
        .header(
            CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        return response.json().await.map_err(|error| error.to_string());
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<ErrorBody>(&body)
        .ok()
        .map(|body| body.error);
    if let Some(detail) = detail {
        if detail.code == "REPLAY_WINDOW_EXPIRED" {
            return Err("Replication fell behind syncd's replay window and syncd still has no authoritative snapshot route for recovery.".to_string());
        }
        if detail.code == "UNAUTHORIZED" {
            return Err("needs_reauth".to_string());
        }
        return Err(detail.message);
    }
    Err(format!("Changes replay failed with HTTP {status}."))
}

async fn stream_live_events(
    app: &AppHandle,
    launch_target: &LaunchTargetInfo,
    profile_id: &str,
    session: &PersistedSyncSession,
    origin: &str,
    novels_profile_id: &str,
) -> Result<StreamExit, String> {
    let client = build_pinned_http_client(&session.tls_cert_sha256)?;
    let response = client
        .get(format!("{origin}/v1/events"))
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header(CLIENT_VERSION_HEADER.as_str(), CLIENT_VERSION)
        .header(
            CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Live sync stream failed with HTTP {}.",
            response.status()
        ));
    }

    let mut event_name = String::new();
    let mut data_lines: Vec<String> = Vec::new();
    let mut buffer = String::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(index) = buffer.find('\n') {
            let mut line = buffer[..index].to_string();
            buffer = buffer[index + 1..].to_string();
            if line.ends_with('\r') {
                line.pop();
            }
            if line.is_empty() {
                match event_name.as_str() {
                    "change" => {
                        let payload = data_lines.join("\n");
                        let envelope = serde_json::from_str::<ChangeEnvelope>(&payload)
                            .map_err(|error| error.to_string())?;
                        apply_remote_envelopes(
                            app,
                            launch_target,
                            profile_id,
                            novels_profile_id,
                            &[envelope],
                            0,
                            SyncdReplicationReplayMode::SseLive,
                        )
                        .await?;
                    }
                    "replay_required" => return Ok(StreamExit::ReplayRequired),
                    _ => {}
                }
                event_name.clear();
                data_lines.clear();
                continue;
            }
            if let Some(value) = line.strip_prefix("event:") {
                event_name = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("data:") {
                data_lines.push(value.trim_start().to_string());
            }
        }
    }
    Ok(StreamExit::Disconnected)
}

async fn stream_live_events_local_authority(
    app: &AppHandle,
    launch_target: &LaunchTargetInfo,
    profile_id: &str,
    authority: &LocalAuthoritySession,
) -> Result<StreamExit, String> {
    let client = insecure_local_syncd_client()?;
    let response = client
        .get(format!("{}/v1/events", authority.local_base_url))
        .header(
            "Authorization",
            format!("Bearer {}", authority.access_token),
        )
        .header(CLIENT_VERSION_HEADER.as_str(), CLIENT_VERSION)
        .header(
            CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Live sync stream failed with HTTP {}.",
            response.status()
        ));
    }

    let mut event_name = String::new();
    let mut data_lines: Vec<String> = Vec::new();
    let mut buffer = String::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(index) = buffer.find('\n') {
            let mut line = buffer[..index].to_string();
            buffer = buffer[index + 1..].to_string();
            if line.ends_with('\r') {
                line.pop();
            }
            if line.is_empty() {
                match event_name.as_str() {
                    "change" => {
                        let payload = data_lines.join("\n");
                        let envelope = serde_json::from_str::<ChangeEnvelope>(&payload)
                            .map_err(|error| error.to_string())?;
                        apply_remote_envelopes(
                            app,
                            launch_target,
                            profile_id,
                            &authority.profile_id,
                            &[envelope],
                            0,
                            SyncdReplicationReplayMode::SseLive,
                        )
                        .await?;
                    }
                    "replay_required" => return Ok(StreamExit::ReplayRequired),
                    _ => {}
                }
                event_name.clear();
                data_lines.clear();
                continue;
            }
            if let Some(value) = line.strip_prefix("event:") {
                event_name = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("data:") {
                data_lines.push(value.trim_start().to_string());
            }
        }
    }
    Ok(StreamExit::Disconnected)
}

async fn apply_remote_envelopes(
    app: &AppHandle,
    launch_target: &LaunchTargetInfo,
    profile_id: &str,
    novels_profile_id: &str,
    envelopes: &[ChangeEnvelope],
    min_replayable_seen: i64,
    replay_mode: SyncdReplicationReplayMode,
) -> Result<(), String> {
    if envelopes.is_empty() {
        return Ok(());
    }
    let mut books_state = read_books_state()?;
    let mut novels_state = read_novels_state(launch_target, profile_id)?;
    let mut classification_state = read_novel_classification_state(launch_target, profile_id)?;
    let novels_scope = novels_scope_id(novels_profile_id);
    let mut outcome = RemoteApplyOutcome::default();
    let mut replication = load_replication_state()?;
    let profile = profile_state_mut(&mut replication, profile_id);

    let mut ordered = envelopes.to_vec();
    ordered.sort_by_key(|envelope| envelope.server_version);
    for envelope in ordered {
        let checkpoint = if envelope.scope_id == BOOKS_SCOPE_ID {
            &mut profile.books_scope_checkpoint
        } else if envelope.scope_id == novels_scope {
            &mut profile.novels_scope_checkpoint
        } else {
            continue;
        };
        if checkpoint
            .as_ref()
            .map(|current| current.last_applied_server_version >= envelope.server_version)
            .unwrap_or(false)
        {
            continue;
        }
        match envelope.entity_type.as_str() {
            "book.entry" => {
                if let Some(patch) = envelope.patch.clone() {
                    let record = serde_json::from_value::<BookEntryRecord>(patch)
                        .map_err(|error| error.to_string())?;
                    upsert_book_entry(&mut books_state, record);
                } else {
                    delete_book_entry(&mut books_state, &envelope.entity_id);
                }
                outcome.books_changed = true;
            }
            "book.category" => {
                if let Some(patch) = envelope.patch.clone() {
                    let record = serde_json::from_value::<BookCategoryRecord>(patch)
                        .map_err(|error| error.to_string())?;
                    upsert_book_category(&mut books_state, record);
                } else {
                    delete_book_category(&mut books_state, &envelope.entity_id);
                }
                outcome.books_changed = true;
            }
            "book.category_assignment" => {
                if let Some(patch) = envelope.patch.clone() {
                    let record = serde_json::from_value::<BookCategoryAssignmentRecord>(patch)
                        .map_err(|error| error.to_string())?;
                    upsert_book_category_assignment(&mut books_state, record);
                } else {
                    delete_book_category_assignment(&mut books_state, &envelope.entity_id);
                }
                outcome.books_changed = true;
            }
            "book.library_ui" => {
                if let Some(patch) = envelope.patch.clone() {
                    let record = serde_json::from_value::<BookLibraryUiRecord>(patch)
                        .map_err(|error| error.to_string())?;
                    upsert_book_library_ui(&mut books_state, record);
                    outcome.books_changed = true;
                }
            }
            "book.progress" => {
                replication_log(format!(
                    "apply_remote_envelope profile_id={} scope={} entity_type=book.progress entity_id={} server_version={} op={:?}",
                    profile_id,
                    envelope.scope_id,
                    envelope.entity_id,
                    envelope.server_version,
                    envelope.op
                ));
                if let Some(patch) = envelope.patch.clone() {
                    let record = serde_json::from_value::<BookProgressRecord>(patch)
                        .map_err(|error| error.to_string())?;
                    upsert_book_progress(&mut books_state, record);
                    outcome.books_changed = true;
                }
            }
            "book.bookmark" => {
                replication_log(format!(
                    "apply_remote_envelope profile_id={} scope={} entity_type=book.bookmark entity_id={} server_version={} op={:?}",
                    profile_id,
                    envelope.scope_id,
                    envelope.entity_id,
                    envelope.server_version,
                    envelope.op
                ));
                if let Some(patch) = envelope.patch.clone() {
                    let record = serde_json::from_value::<BookBookmarkRecord>(patch)
                        .map_err(|error| error.to_string())?;
                    upsert_book_bookmark(&mut books_state, record);
                    outcome.books_changed = true;
                } else {
                    delete_book_bookmark(&mut books_state, &envelope.entity_id);
                    outcome.books_changed = true;
                }
            }
            "novel.progress" => {
                if let Some(patch) = envelope.patch.clone() {
                    let record = serde_json::from_value::<NovelProgressRecord>(patch)
                        .map_err(|error| error.to_string())?;
                    upsert_novel_progress(&mut novels_state, record);
                    outcome.novels_changed = true;
                }
            }
            "novel.entry" => {
                if let Some(patch) = envelope.patch.clone() {
                    let record = serde_json::from_value::<NovelEntryRecord>(patch)
                        .map_err(|error| error.to_string())?;
                    upsert_novel_entry(&mut novels_state, record);
                } else {
                    delete_novel_entry(&mut novels_state, &envelope.entity_id);
                }
                outcome.novels_changed = true;
            }
            "novel.chapter" => {
                if let Some(patch) = envelope.patch.clone() {
                    let record = serde_json::from_value::<NovelChapterRecord>(patch)
                        .map_err(|error| error.to_string())?;
                    upsert_novel_chapter(&mut novels_state, record);
                } else {
                    delete_novel_chapter(&mut novels_state, &envelope.entity_id);
                }
                outcome.novels_changed = true;
            }
            "novel.bookmark" => {
                if let Some(patch) = envelope.patch.clone() {
                    let record = serde_json::from_value::<NovelBookmarkRecord>(patch)
                        .map_err(|error| error.to_string())?;
                    upsert_novel_bookmark(&mut novels_state, record);
                    outcome.novels_changed = true;
                } else {
                    delete_novel_bookmark(&mut novels_state, &envelope.entity_id);
                    outcome.novels_changed = true;
                }
            }
            "novel.history" => {
                if let Some(patch) = envelope.patch.clone() {
                    let record = serde_json::from_value::<NovelHistoryRecord>(patch)
                        .map_err(|error| error.to_string())?;
                    upsert_novel_history(&mut novels_state, record);
                } else {
                    delete_novel_history(&mut novels_state, &envelope.entity_id);
                }
                outcome.novels_changed = true;
            }
            "novel.classification" => {
                if let Some(patch) = envelope.patch.clone() {
                    let record = serde_json::from_value::<NovelClassificationRecord>(patch)
                        .map_err(|error| error.to_string())?;
                    upsert_novel_classification(&mut classification_state, record);
                } else {
                    delete_novel_classification(&mut classification_state, &envelope.entity_id);
                }
                classification_state.updated_at_ms = Some(now_ms());
            }
            _ => continue,
        }
        profile.per_entity_remote_clock.insert(
            remote_clock_key(
                &envelope.scope_id,
                &envelope.entity_type,
                &envelope.entity_id,
            ),
            envelope.lamport,
        );
        *checkpoint = Some(SyncdReplicationScopeCheckpoint {
            scope_id: envelope.scope_id.clone(),
            last_applied_server_version: envelope.server_version,
            min_replayable_seen,
            last_replay_mode: replay_mode.clone(),
            last_applied_at_ms: now_ms(),
        });
        outcome.applied_scopes.insert(envelope.scope_id);
    }

    if outcome.books_changed {
        books_state.updated_at_ms = Some(now_ms());
        write_books_state(&books_state)?;
    }
    if outcome.novels_changed {
        novels_state.updated_at_ms = Some(now_ms());
        write_novels_state(launch_target, profile_id, &novels_state)?;
    }
    if classification_state.updated_at_ms.is_some() {
        write_novel_classification_state(launch_target, profile_id, &classification_state)?;
    }
    if !outcome.applied_scopes.is_empty() {
        profile.last_applied_scopes = outcome.applied_scopes.iter().cloned().collect();
        profile.last_applied_at_ms = Some(now_ms());
        profile.last_connected_at_ms = Some(now_ms());
        profile.last_error = None;
        save_replication_state(&replication)?;
        let _ = emit_replication_state_for_profile(app, profile_id).await;
    }
    Ok(())
}

pub async fn notify_book_state_written(
    app: &AppHandle,
    previous_contents: Option<String>,
    next_contents: &str,
) -> Result<(), String> {
    let previous = previous_contents
        .as_deref()
        .map(serde_json::from_str::<PersistedBookLibraryState>)
        .transpose()
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    let next = serde_json::from_str::<PersistedBookLibraryState>(next_contents)
        .map_err(|error| error.to_string())?;
    let diff = diff_book_mutations(&previous, &next);
    replication_log(format!(
        "notify_book_state_written prev_progress={} next_progress={} prev_bookmarks={} next_bookmarks={} diff_count={} diff=[{}]",
        previous.book_progress.len(),
        next.book_progress.len(),
        previous.book_bookmarks.len(),
        next.book_bookmarks.len(),
        diff.len(),
        summarize_mutations(&diff)
    ));
    if diff.is_empty() {
        return Ok(());
    }
    submit_mutations_for_active_profiles(app, None, diff).await
}

pub async fn notify_novel_state_written(
    app: &AppHandle,
    local_profile_id: Option<&str>,
    previous_contents: Option<String>,
    next_contents: &str,
) -> Result<(), String> {
    let Some(profile_id) = local_profile_id.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    let previous = previous_contents
        .as_deref()
        .map(serde_json::from_str::<PersistedNovelLibraryState>)
        .transpose()
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    let next = serde_json::from_str::<PersistedNovelLibraryState>(next_contents)
        .map_err(|error| error.to_string())?;
    let diff = diff_novel_mutations(profile_id, &previous, &next);
    if diff.is_empty() {
        return Ok(());
    }
    submit_mutations_for_active_profiles(app, Some(profile_id), diff).await
}

pub async fn notify_novel_source_classification_state_written(
    app: &AppHandle,
    local_profile_id: Option<&str>,
    previous_contents: Option<String>,
    next_contents: &str,
) -> Result<(), String> {
    let Some(profile_id) = local_profile_id.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    let previous = previous_contents
        .as_deref()
        .map(serde_json::from_str::<PersistedNovelSourceClassificationState>)
        .transpose()
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    let next = serde_json::from_str::<PersistedNovelSourceClassificationState>(next_contents)
        .map_err(|error| error.to_string())?;
    let diff = diff_novel_classification_mutations(profile_id, &previous, &next);
    if diff.is_empty() {
        return Ok(());
    }
    submit_mutations_for_active_profiles(app, Some(profile_id), diff).await
}

fn upsert_book_progress(state: &mut PersistedBookLibraryState, record: BookProgressRecord) {
    let next = LocalBookProgress {
        book_id: record.book_id.clone(),
        location: record.location,
        href: record.href,
        progress_percent: record.progress_percent,
        last_read_at: record.last_read_at_ms,
        page_index: record.page_index,
        total_pages: record.total_pages,
        section_label: record.section_label,
        renderer: record.renderer,
    };
    if let Some(index) = state
        .book_progress
        .iter()
        .position(|entry| entry.book_id == next.book_id)
    {
        state.book_progress[index] = next;
    } else {
        state.book_progress.push(next);
    }
}

fn upsert_book_entry(state: &mut PersistedBookLibraryState, record: BookEntryRecord) {
    let next = json!({
        "id": record.book_id,
        "assetFingerprint": record.asset_fingerprint,
        "title": record.title,
        "author": record.author,
        "description": record.description,
        "coverPath": Value::Null,
        "coverUrl": Value::Null,
        "subtype": record.subtype,
        "pageCount": record.page_count,
        "createdAt": record.created_at_ms,
        "updatedAt": record.book_updated_at_ms,
        "importPath": "",
        "assetPath": "",
        "tocCount": record.toc_count,
        "spineCount": record.spine_count,
        "sectionsSummary": record.sections_summary_json.unwrap_or_else(|| json!([])),
        "sectionCount": record.section_count,
        "hasCover": record.has_cover,
    });
    let book_id = value_string_field(&next, "id").unwrap_or_default();
    if let Some(index) = state
        .books
        .iter()
        .position(|entry| book_entry_entity_id(entry).as_deref() == Some(book_id.as_str()))
    {
        state.books[index] = next;
    } else {
        state.books.push(next);
    }
}

fn delete_book_entry(state: &mut PersistedBookLibraryState, book_id: &str) {
    state
        .books
        .retain(|entry| book_entry_entity_id(entry).as_deref() != Some(book_id));
    state.book_progress.retain(|entry| entry.book_id != book_id);
    state
        .book_bookmarks
        .retain(|entry| entry.book_id != book_id);
    state.books_category_assignments.remove(book_id);
}

fn upsert_book_category(state: &mut PersistedBookLibraryState, record: BookCategoryRecord) {
    let next = json!({
        "id": record.category_id,
        "name": record.name,
        "order": record.order,
    });
    let category_id = value_string_field(&next, "id").unwrap_or_default();
    if let Some(index) = state
        .books_categories
        .iter()
        .position(|entry| book_category_entity_id(entry).as_deref() == Some(category_id.as_str()))
    {
        state.books_categories[index] = next;
    } else {
        state.books_categories.push(next);
    }
}

fn delete_book_category(state: &mut PersistedBookLibraryState, category_id: &str) {
    state
        .books_categories
        .retain(|entry| book_category_entity_id(entry).as_deref() != Some(category_id));
    for category_ids in state.books_category_assignments.values_mut() {
        category_ids.retain(|entry| entry != category_id);
    }
}

fn upsert_book_category_assignment(
    state: &mut PersistedBookLibraryState,
    record: BookCategoryAssignmentRecord,
) {
    state
        .books_category_assignments
        .insert(record.book_id, record.category_ids);
}

fn delete_book_category_assignment(state: &mut PersistedBookLibraryState, book_id: &str) {
    state.books_category_assignments.remove(book_id);
}

fn upsert_book_library_ui(state: &mut PersistedBookLibraryState, record: BookLibraryUiRecord) {
    state.books_library_ui = json!({
        "activeCategoryId": record.active_category_id,
        "typeFilter": record.type_filter,
        "statusFilter": record.status_filter,
        "search": record.search,
        "sortMode": record.sort_mode,
        "sortDir": record.sort_dir,
    });
}

fn upsert_book_bookmark(state: &mut PersistedBookLibraryState, record: BookBookmarkRecord) {
    let next = LocalBookBookmark {
        book_id: record.book_id,
        location: record.location,
        href: record.href,
        page_index: record.page_index,
        progress_percent: record.progress_percent,
        label: record.label,
        saved_at: record.saved_at_ms,
    };
    let bookmark_id = bookmark_entity_id_for_book(&next);
    if let Some(index) = state
        .book_bookmarks
        .iter()
        .position(|entry| bookmark_entity_id_for_book(entry) == bookmark_id)
    {
        state.book_bookmarks[index] = next;
    } else {
        state.book_bookmarks.push(next);
    }
}

fn delete_book_bookmark(state: &mut PersistedBookLibraryState, bookmark_id: &str) {
    state
        .book_bookmarks
        .retain(|entry| bookmark_entity_id_for_book(entry) != bookmark_id);
}

fn upsert_novel_progress(state: &mut PersistedNovelLibraryState, record: NovelProgressRecord) {
    let next = LocalNovelProgress {
        novel_id: record.novel_id.clone(),
        chapter_id: record.chapter_id,
        chapter_title: record.chapter_title,
        progress_percent: record.progress_percent,
        locator: record.locator,
        updated_at: record.updated_at_ms,
    };
    if let Some(index) = state
        .progress
        .iter()
        .position(|entry| entry.novel_id == next.novel_id)
    {
        state.progress[index] = next;
    } else {
        state.progress.push(next);
    }
}

fn refresh_novel_entry_chapter_count(state: &mut PersistedNovelLibraryState, novel_id: &str) {
    let chapter_count = state
        .chapters
        .iter()
        .filter(|entry| value_string_field(entry, "novelId").as_deref() == Some(novel_id))
        .count() as i64;
    for entry in &mut state.entries {
        if novel_entry_entity_id(entry).as_deref() == Some(novel_id) {
            if let Some(record) = entry.as_object_mut() {
                record.insert("chapterCount".to_string(), json!(chapter_count));
                record.insert("updatedAt".to_string(), json!(now_ms()));
            }
            break;
        }
    }
}

fn upsert_novel_entry(state: &mut PersistedNovelLibraryState, record: NovelEntryRecord) {
    let chapter_count = state
        .chapters
        .iter()
        .filter(|entry| {
            value_string_field(entry, "novelId").as_deref() == Some(record.novel_id.as_str())
        })
        .count() as i64;
    let next = json!({
        "id": record.novel_id,
        "title": record.title,
        "author": record.author,
        "description": record.description,
        "coverUrl": record.cover_url,
        "path": record.path,
        "status": record.status,
        "tags": record.tags,
        "source": record.source,
        "chapterCount": chapter_count,
        "addedAt": record.added_at_ms,
        "updatedAt": record.updated_at_ms,
    });
    let novel_id = value_string_field(&next, "id").unwrap_or_default();
    if let Some(index) = state
        .entries
        .iter()
        .position(|entry| novel_entry_entity_id(entry).as_deref() == Some(novel_id.as_str()))
    {
        state.entries[index] = next;
    } else {
        state.entries.push(next);
    }
}

fn delete_novel_entry(state: &mut PersistedNovelLibraryState, novel_id: &str) {
    state
        .entries
        .retain(|entry| novel_entry_entity_id(entry).as_deref() != Some(novel_id));
    state
        .chapters
        .retain(|entry| value_string_field(entry, "novelId").as_deref() != Some(novel_id));
    state.progress.retain(|entry| entry.novel_id != novel_id);
    state.bookmarks.retain(|entry| entry.novel_id != novel_id);
    state
        .history
        .retain(|entry| value_string_field(entry, "novelId").as_deref() != Some(novel_id));
}

fn upsert_novel_chapter(state: &mut PersistedNovelLibraryState, record: NovelChapterRecord) {
    let next = json!({
        "id": record.chapter_id,
        "novelId": record.novel_id,
        "path": record.path,
        "title": record.title,
        "order": record.chapter_order_key,
        "releaseTime": record.release_time_ms,
        "unread": record.unread,
    });
    let chapter_id = value_string_field(&next, "id").unwrap_or_default();
    let novel_id = value_string_field(&next, "novelId").unwrap_or_default();
    if let Some(index) = state
        .chapters
        .iter()
        .position(|entry| novel_chapter_entity_id(entry).as_deref() == Some(chapter_id.as_str()))
    {
        state.chapters[index] = next;
    } else {
        state.chapters.push(next);
    }
    if !novel_id.is_empty() {
        refresh_novel_entry_chapter_count(state, &novel_id);
    }
}

fn delete_novel_chapter(state: &mut PersistedNovelLibraryState, chapter_id: &str) {
    let novel_id = state
        .chapters
        .iter()
        .find(|entry| novel_chapter_entity_id(entry).as_deref() == Some(chapter_id))
        .and_then(|entry| value_string_field(entry, "novelId"));
    state
        .chapters
        .retain(|entry| novel_chapter_entity_id(entry).as_deref() != Some(chapter_id));
    if let Some(novel_id) = novel_id {
        refresh_novel_entry_chapter_count(state, &novel_id);
    }
}

fn upsert_novel_bookmark(state: &mut PersistedNovelLibraryState, record: NovelBookmarkRecord) {
    let next = LocalNovelBookmark {
        novel_id: record.novel_id,
        chapter_id: record.chapter_id,
        chapter_title: record.chapter_title,
        locator: record.locator,
        label: record.label,
        saved_at: record.saved_at_ms,
    };
    let bookmark_id = bookmark_entity_id_for_novel(&next);
    if let Some(index) = state
        .bookmarks
        .iter()
        .position(|entry| bookmark_entity_id_for_novel(entry) == bookmark_id)
    {
        state.bookmarks[index] = next;
    } else {
        state.bookmarks.push(next);
    }
}

fn delete_novel_bookmark(state: &mut PersistedNovelLibraryState, bookmark_id: &str) {
    state
        .bookmarks
        .retain(|entry| bookmark_entity_id_for_novel(entry) != bookmark_id);
}

fn upsert_novel_history(state: &mut PersistedNovelLibraryState, record: NovelHistoryRecord) {
    let next = json!({
        "historyId": record.history_id,
        "novelId": record.novel_id,
        "chapterId": record.chapter_id,
        "chapterTitle": record.chapter_title,
        "locator": record.locator,
        "readAt": record.read_at_ms,
    });
    let history_id = novel_history_entity_id(&next).unwrap_or_default();
    if let Some(index) = state
        .history
        .iter()
        .position(|entry| novel_history_entity_id(entry).as_deref() == Some(history_id.as_str()))
    {
        state.history[index] = next;
    } else {
        state.history.push(next);
    }
}

fn delete_novel_history(state: &mut PersistedNovelLibraryState, history_id: &str) {
    state
        .history
        .retain(|entry| novel_history_entity_id(entry).as_deref() != Some(history_id));
}

fn upsert_novel_classification(
    state: &mut PersistedNovelSourceClassificationState,
    record: NovelClassificationRecord,
) {
    let next = json!({
        "pluginId": record.plugin_id,
        "repositoryId": record.repository_id,
        "repositoryUrl": record.repository_url,
        "lang": record.lang,
        "version": record.version,
        "status": record.status,
        "notes": record.notes,
        "baselineStatus": record.baseline_status,
        "baselineNotes": record.baseline_notes,
        "issues": record.issues_json,
        "smoke": record.smoke_json,
        "filterKeys": record.filter_keys,
        "pluginSettingsKeys": record.plugin_settings_keys,
        "classifiedAtMs": record.classified_at_ms,
    });
    let plugin_id = novel_classification_entity_id(&next).unwrap_or_default();
    if let Some(index) = state.records.iter().position(|entry| {
        novel_classification_entity_id(entry).as_deref() == Some(plugin_id.as_str())
    }) {
        state.records[index] = next;
    } else {
        state.records.push(next);
    }
}

fn delete_novel_classification(
    state: &mut PersistedNovelSourceClassificationState,
    plugin_id: &str,
) {
    state
        .records
        .retain(|entry| novel_classification_entity_id(entry).as_deref() != Some(plugin_id));
}

fn bookmark_entity_id_for_book(entry: &LocalBookBookmark) -> String {
    let locator = entry
        .location
        .clone()
        .or_else(|| entry.href.clone())
        .or_else(|| entry.page_index.map(|value| value.to_string()))
        .unwrap_or_else(|| "unknown".to_string());
    format!(
        "book.bookmark::{}",
        hash_digest(&format!("{}::{locator}", entry.book_id))
    )
}

fn bookmark_entity_id_for_novel(entry: &LocalNovelBookmark) -> String {
    let locator = entry
        .locator
        .clone()
        .or_else(|| entry.chapter_id.clone())
        .or_else(|| entry.chapter_title.clone())
        .unwrap_or_else(|| "unknown".to_string());
    format!(
        "novel.bookmark::{}",
        hash_digest(&format!("{}::{locator}", entry.novel_id))
    )
}

fn remote_clock_key(scope_id: &str, entity_type: &str, entity_id: &str) -> String {
    format!("{scope_id}::{entity_type}::{entity_id}")
}

fn value_string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn value_i64_field(value: &Value, field: &str) -> Option<i64> {
    value.get(field).and_then(Value::as_i64)
}

#[allow(dead_code)]
fn value_f64_field(value: &Value, field: &str) -> Option<f64> {
    value.get(field).and_then(Value::as_f64)
}

#[allow(dead_code)]
fn value_bool_field(value: &Value, field: &str, default: bool) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(default)
}

fn value_string_array_field(value: &Value, field: &str) -> Vec<String> {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn book_entry_entity_id(value: &Value) -> Option<String> {
    value_string_field(value, "id")
}

fn book_category_entity_id(value: &Value) -> Option<String> {
    value_string_field(value, "id")
}

fn novel_entry_entity_id(value: &Value) -> Option<String> {
    value_string_field(value, "id")
}

fn novel_chapter_entity_id(value: &Value) -> Option<String> {
    value_string_field(value, "id")
}

fn novel_history_entity_id(value: &Value) -> Option<String> {
    value_string_field(value, "historyId")
        .or_else(|| value_string_field(value, "id"))
        .or_else(|| {
            let novel_id = value_string_field(value, "novelId")?;
            let locator = value_string_field(value, "locator")
                .or_else(|| value_string_field(value, "chapterId"))
                .or_else(|| value_string_field(value, "chapterTitle"))
                .unwrap_or_else(|| "unknown".to_string());
            let read_at = value_i64_field(value, "readAt").unwrap_or_default();
            Some(format!(
                "novel.history::{}",
                hash_digest(&format!("{novel_id}::{locator}::{read_at}"))
            ))
        })
}

fn novel_classification_entity_id(value: &Value) -> Option<String> {
    value_string_field(value, "pluginId")
}

#[allow(dead_code)]
fn build_book_entry_patch(value: &Value) -> Option<BookEntryPatch> {
    Some(BookEntryPatch {
        asset_fingerprint: value_string_field(value, "assetFingerprint"),
        title: value_string_field(value, "title")?,
        author: value_string_field(value, "author"),
        description: value_string_field(value, "description"),
        subtype: value_string_field(value, "subtype")?,
        page_count: value_i64_field(value, "pageCount"),
        toc_count: value_i64_field(value, "tocCount"),
        spine_count: value_i64_field(value, "spineCount"),
        section_count: value_i64_field(value, "sectionCount"),
        sections_summary_json: value.get("sectionsSummary").cloned(),
        has_cover: value_bool_field(value, "hasCover", false),
        created_at_ms: value_i64_field(value, "createdAt").unwrap_or_else(now_ms),
        book_updated_at_ms: value_i64_field(value, "updatedAt").unwrap_or_else(now_ms),
    })
}

#[allow(dead_code)]
fn build_book_category_patch(value: &Value) -> Option<BookCategoryPatch> {
    let category_id = book_category_entity_id(value)?;
    Some(BookCategoryPatch {
        category_id,
        name: value_string_field(value, "name")?,
        order: value_i64_field(value, "order").unwrap_or_default(),
    })
}

#[allow(dead_code)]
fn build_book_library_ui_patch(value: &Value) -> BookLibraryUiPatch {
    BookLibraryUiPatch {
        active_category_id: value_string_field(value, "activeCategoryId"),
        type_filter: value_string_field(value, "typeFilter").unwrap_or_else(|| "all".to_string()),
        status_filter: value_string_field(value, "statusFilter")
            .unwrap_or_else(|| "all".to_string()),
        search: value_string_field(value, "search").unwrap_or_default(),
        sort_mode: value_string_field(value, "sortMode")
            .unwrap_or_else(|| "recentlyAdded".to_string()),
        sort_dir: value_string_field(value, "sortDir").unwrap_or_else(|| "desc".to_string()),
    }
}

#[allow(dead_code)]
fn build_novel_entry_patch(value: &Value) -> Option<NovelEntryPatch> {
    Some(NovelEntryPatch {
        identity_key: value_string_field(value, "id")?,
        title: value_string_field(value, "title")?,
        author: value_string_field(value, "author"),
        description: value_string_field(value, "description"),
        cover_url: value_string_field(value, "coverUrl"),
        path: value_string_field(value, "path")?,
        status: value_string_field(value, "status"),
        tags: value_string_array_field(value, "tags"),
        source: value.get("source").cloned().unwrap_or(Value::Null),
        added_at_ms: value_i64_field(value, "addedAt").unwrap_or_else(now_ms),
        updated_at_ms: value_i64_field(value, "updatedAt").unwrap_or_else(now_ms),
    })
}

#[allow(dead_code)]
fn build_novel_chapter_patch(value: &Value) -> Option<NovelChapterPatch> {
    Some(NovelChapterPatch {
        novel_id: value_string_field(value, "novelId")?,
        path: value_string_field(value, "path")?,
        title: value_string_field(value, "title")?,
        chapter_order_key: value_f64_field(value, "order").unwrap_or_default(),
        release_time_ms: value_i64_field(value, "releaseTime"),
        unread: value_bool_field(value, "unread", true),
    })
}

#[allow(dead_code)]
fn build_novel_history_patch(value: &Value) -> Option<NovelHistoryPatch> {
    Some(NovelHistoryPatch {
        novel_id: value_string_field(value, "novelId")?,
        chapter_id: value_string_field(value, "chapterId"),
        chapter_title: value_string_field(value, "chapterTitle"),
        locator: value_string_field(value, "locator"),
        read_at_ms: value_i64_field(value, "readAt").unwrap_or_else(now_ms),
    })
}

fn build_novel_classification_patch(value: &Value) -> Option<NovelClassificationPatch> {
    Some(NovelClassificationPatch {
        plugin_id: novel_classification_entity_id(value)?,
        repository_id: value_string_field(value, "repositoryId"),
        repository_url: value_string_field(value, "repositoryUrl"),
        lang: value_string_field(value, "lang"),
        version: value_string_field(value, "version"),
        status: value_string_field(value, "status")?,
        notes: value_string_field(value, "notes")?,
        baseline_status: value_string_field(value, "baselineStatus"),
        baseline_notes: value_string_field(value, "baselineNotes"),
        issues_json: value.get("issues").cloned().unwrap_or_else(|| json!([])),
        smoke_json: value.get("smoke").cloned().unwrap_or_else(|| json!({})),
        filter_keys: value_string_array_field(value, "filterKeys"),
        plugin_settings_keys: value_string_array_field(value, "pluginSettingsKeys"),
        classified_at_ms: value_i64_field(value, "classifiedAtMs").unwrap_or_else(now_ms),
    })
}

fn diff_book_mutations(
    previous: &PersistedBookLibraryState,
    next: &PersistedBookLibraryState,
) -> Vec<SerializableMutationInput> {
    let mut mutations = Vec::new();
    let previous_progress: BTreeMap<String, LocalBookProgress> = previous
        .book_progress
        .iter()
        .cloned()
        .map(|entry| (entry.book_id.clone(), entry))
        .collect();
    let next_progress: BTreeMap<String, LocalBookProgress> = next
        .book_progress
        .iter()
        .cloned()
        .map(|entry| (entry.book_id.clone(), entry))
        .collect();
    for (book_id, entry) in &next_progress {
        if previous_progress.get(book_id) == Some(entry) {
            continue;
        }
        mutations.push(SerializableMutationInput::BookProgress {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: BOOKS_SCOPE_ID.to_string(),
                entity_id: format!("book.progress::{book_id}"),
                op: MutationOperation::Merge,
                lamport: now_ms(),
            },
            patch: BookProgressPatch {
                renderer: entry.renderer.clone(),
                location: entry.location.clone(),
                href: entry.href.clone(),
                progress_percent: entry.progress_percent,
                last_read_at_ms: entry.last_read_at,
                page_index: entry.page_index,
                total_pages: entry.total_pages,
                section_label: entry.section_label.clone(),
            },
        });
    }

    let previous_bookmarks: BTreeMap<String, LocalBookBookmark> = previous
        .book_bookmarks
        .iter()
        .cloned()
        .map(|entry| (bookmark_entity_id_for_book(&entry), entry))
        .collect();
    let next_bookmarks: BTreeMap<String, LocalBookBookmark> = next
        .book_bookmarks
        .iter()
        .cloned()
        .map(|entry| (bookmark_entity_id_for_book(&entry), entry))
        .collect();
    for (bookmark_id, entry) in &next_bookmarks {
        if previous_bookmarks.get(bookmark_id) == Some(entry) {
            continue;
        }
        mutations.push(SerializableMutationInput::BookBookmark {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: BOOKS_SCOPE_ID.to_string(),
                entity_id: bookmark_id.clone(),
                op: MutationOperation::Merge,
                lamport: now_ms(),
            },
            patch: Some(BookBookmarkPatch {
                book_id: entry.book_id.clone(),
                location: entry.location.clone(),
                href: entry.href.clone(),
                page_index: entry.page_index,
                progress_percent: entry.progress_percent,
                label: entry.label.clone(),
                saved_at_ms: entry.saved_at,
            }),
        });
    }
    for bookmark_id in previous_bookmarks.keys() {
        if next_bookmarks.contains_key(bookmark_id) {
            continue;
        }
        mutations.push(SerializableMutationInput::BookBookmark {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: BOOKS_SCOPE_ID.to_string(),
                entity_id: bookmark_id.clone(),
                op: MutationOperation::Delete,
                lamport: now_ms(),
            },
            patch: None,
        });
    }
    mutations
}
fn diff_novel_mutations(
    local_profile_id: &str,
    previous: &PersistedNovelLibraryState,
    next: &PersistedNovelLibraryState,
) -> Vec<SerializableMutationInput> {
    let scope_id = novels_scope_id(local_profile_id);
    let mut mutations = Vec::new();
    let previous_progress: BTreeMap<String, LocalNovelProgress> = previous
        .progress
        .iter()
        .cloned()
        .map(|entry| (entry.novel_id.clone(), entry))
        .collect();
    let next_progress: BTreeMap<String, LocalNovelProgress> = next
        .progress
        .iter()
        .cloned()
        .map(|entry| (entry.novel_id.clone(), entry))
        .collect();
    for (novel_id, entry) in &next_progress {
        if previous_progress.get(novel_id) == Some(entry) {
            continue;
        }
        mutations.push(SerializableMutationInput::NovelProgress {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: scope_id.clone(),
                entity_id: format!("novel.progress::{novel_id}"),
                op: MutationOperation::Merge,
                lamport: now_ms(),
            },
            patch: NovelProgressPatch {
                chapter_id: entry.chapter_id.clone(),
                chapter_title: entry.chapter_title.clone(),
                chapter_order_key: None,
                progress_percent: entry.progress_percent,
                locator: entry.locator.clone(),
                locator_sort_key: None,
                updated_at_ms: entry.updated_at,
            },
        });
    }

    let previous_bookmarks: BTreeMap<String, LocalNovelBookmark> = previous
        .bookmarks
        .iter()
        .cloned()
        .map(|entry| (bookmark_entity_id_for_novel(&entry), entry))
        .collect();
    let next_bookmarks: BTreeMap<String, LocalNovelBookmark> = next
        .bookmarks
        .iter()
        .cloned()
        .map(|entry| (bookmark_entity_id_for_novel(&entry), entry))
        .collect();
    for (bookmark_id, entry) in &next_bookmarks {
        if previous_bookmarks.get(bookmark_id) == Some(entry) {
            continue;
        }
        mutations.push(SerializableMutationInput::NovelBookmark {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: scope_id.clone(),
                entity_id: bookmark_id.clone(),
                op: MutationOperation::Merge,
                lamport: now_ms(),
            },
            patch: Some(NovelBookmarkPatch {
                novel_id: entry.novel_id.clone(),
                chapter_id: entry.chapter_id.clone(),
                chapter_title: entry.chapter_title.clone(),
                chapter_order_key: None,
                locator: entry.locator.clone(),
                locator_sort_key: None,
                label: entry.label.clone(),
                saved_at_ms: entry.saved_at,
            }),
        });
    }
    for bookmark_id in previous_bookmarks.keys() {
        if next_bookmarks.contains_key(bookmark_id) {
            continue;
        }
        mutations.push(SerializableMutationInput::NovelBookmark {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: scope_id.clone(),
                entity_id: bookmark_id.clone(),
                op: MutationOperation::Delete,
                lamport: now_ms(),
            },
            patch: None,
        });
    }
    mutations
}
fn diff_novel_classification_mutations(
    local_profile_id: &str,
    previous: &PersistedNovelSourceClassificationState,
    next: &PersistedNovelSourceClassificationState,
) -> Vec<SerializableMutationInput> {
    let scope_id = novels_scope_id(local_profile_id);
    let mut mutations = Vec::new();
    let previous_records: BTreeMap<String, Value> = previous
        .records
        .iter()
        .filter_map(|entry| novel_classification_entity_id(entry).map(|id| (id, entry.clone())))
        .collect();
    let next_records: BTreeMap<String, Value> = next
        .records
        .iter()
        .filter_map(|entry| novel_classification_entity_id(entry).map(|id| (id, entry.clone())))
        .collect();

    for (plugin_id, entry) in &next_records {
        if previous_records.get(plugin_id) == Some(entry) {
            continue;
        }
        let Some(patch) = build_novel_classification_patch(entry) else {
            continue;
        };
        mutations.push(SerializableMutationInput::NovelClassification {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: scope_id.clone(),
                entity_id: plugin_id.clone(),
                op: MutationOperation::Merge,
                lamport: now_ms(),
            },
            patch: Some(patch),
        });
    }

    for plugin_id in previous_records.keys() {
        if next_records.contains_key(plugin_id) {
            continue;
        }
        mutations.push(SerializableMutationInput::NovelClassification {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: scope_id.clone(),
                entity_id: plugin_id.clone(),
                op: MutationOperation::Delete,
                lamport: now_ms(),
            },
            patch: None,
        });
    }

    mutations
}

async fn submit_mutations_for_active_profiles(
    app: &AppHandle,
    restrict_profile_id: Option<&str>,
    mutations: Vec<SerializableMutationInput>,
) -> Result<(), String> {
    if mutations.is_empty() {
        return Ok(());
    }

    let desktop = load_persisted_state()?;
    let replication = load_replication_state()?;
    let local_authority = {
        let state = app.state::<SyncdReplicationState>();
        let runtime = state.runtime.lock().await;
        runtime.local_authority.clone()
    };
    replication_log(format!(
        "submit_mutations start restrict_profile_id={restrict_profile_id:?} mutation_count={} mutations=[{}]",
        mutations.len(),
        summarize_mutations(&mutations)
    ));
    for (profile_id, profile) in &replication.profiles {
        if restrict_profile_id.is_some() && restrict_profile_id != Some(profile_id.as_str()) {
            continue;
        }
        if profile.paused {
            replication_log(format!(
                "submit_mutations skip profile_id={} reason=paused",
                profile_id
            ));
            continue;
        }
        if let Some(authority) = local_authority.get(profile_id) {
            replication_log(format!(
                "submit_mutations target profile_id={} mode=local_authority base_url={}",
                profile_id, authority.local_base_url
            ));
            if let Err(error) = post_mutations_for_local_authority(authority, &mutations).await {
                replication_log(format!(
                    "submit_mutations result profile_id={} mode=local_authority status=error error={}",
                    profile_id, error
                ));
                emit_replication_error(app, profile_id, error.clone());
                let _ = update_profile_state(profile_id, |profile| {
                    profile.last_error = Some(error.clone());
                    profile.replication_status = if is_needs_reauth_error(&error) {
                        SyncdReplicationStatus::NeedsReauth
                    } else if is_connection_error(&error) {
                        SyncdReplicationStatus::Offline
                    } else {
                        SyncdReplicationStatus::Degraded
                    };
                });
                let _ = emit_replication_state_for_profile(app, profile_id).await;
            } else {
                replication_log(format!(
                    "submit_mutations result profile_id={} mode=local_authority status=ok",
                    profile_id
                ));
            }
            continue;
        }
        let Some(active_key) = profile.active_session_key.as_deref() else {
            continue;
        };
        let Some(session) = desktop.sessions.iter().find(|session| {
            session.local_profile_id == *profile_id && session.session_key == active_key
        }) else {
            replication_log(format!(
                "submit_mutations skip profile_id={} reason=missing_active_session key={}",
                profile_id, active_key
            ));
            continue;
        };
        replication_log(format!(
            "submit_mutations target profile_id={} mode=remote canonical_origin={}",
            profile_id, session.canonical_origin
        ));
        if let Err(error) = post_mutations_for_session(session, &mutations).await {
            replication_log(format!(
                "submit_mutations result profile_id={} mode=remote status=error error={}",
                profile_id, error
            ));
            emit_replication_error(app, profile_id, error.clone());
            let _ = update_profile_state(profile_id, |profile| {
                profile.last_error = Some(error.clone());
                profile.replication_status = if is_needs_reauth_error(&error) {
                    SyncdReplicationStatus::NeedsReauth
                } else if is_connection_error(&error) {
                    SyncdReplicationStatus::Offline
                } else {
                    SyncdReplicationStatus::Degraded
                };
            });
            let _ = emit_replication_state_for_profile(app, profile_id).await;
        } else {
            replication_log(format!(
                "submit_mutations result profile_id={} mode=remote status=ok",
                profile_id
            ));
        }
    }
    Ok(())
}

async fn post_mutations_for_local_authority(
    authority: &LocalAuthoritySession,
    mutations: &[SerializableMutationInput],
) -> Result<(), String> {
    let request = SerializableMutationsRequest {
        request_id: Uuid::now_v7().to_string(),
        mutations: mutations.to_vec(),
    };
    let client = insecure_local_syncd_client()?;
    replication_log(format!(
        "post_mutations_for_local_authority profile_id={} url={}/v1/mutations mutation_count={} mutations=[{}]",
        authority.profile_id,
        authority.local_base_url,
        mutations.len(),
        summarize_mutations(mutations)
    ));
    let response = client
        .post(format!("{}/v1/mutations", authority.local_base_url))
        .header(
            "Authorization",
            format!("Bearer {}", authority.access_token),
        )
        .header(CLIENT_VERSION_HEADER.as_str(), CLIENT_VERSION)
        .header(
            CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .json(&request)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        replication_log(format!(
            "post_mutations_for_local_authority profile_id={} http_status=success",
            authority.profile_id
        ));
        return Ok(());
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if let Ok(error_body) = serde_json::from_str::<ErrorBody>(&body) {
        if error_body.error.code == "UNAUTHORIZED" {
            return Err("needs_reauth".to_string());
        }
        return Err(error_body.error.message);
    }
    Err(format!("Mutation submit failed with HTTP {status}."))
}

async fn post_mutations_for_session(
    session: &PersistedSyncSession,
    mutations: &[SerializableMutationInput],
) -> Result<(), String> {
    if mutations.is_empty() {
        return Ok(());
    }
    let request = SerializableMutationsRequest {
        request_id: Uuid::now_v7().to_string(),
        mutations: mutations.to_vec(),
    };
    let client = build_pinned_http_client(&session.tls_cert_sha256)?;
    let mut origins = vec![session.canonical_origin.clone()];
    for origin in &session.fallback_origins {
        if !origins.contains(origin) {
            origins.push(origin.clone());
        }
    }
    let mut last_error = None;
    for (index, origin) in origins.iter().enumerate() {
        replication_log(format!(
            "post_mutations_for_session session_key={} origin={} attempt={} mutation_count={} mutations=[{}]",
            session.session_key,
            origin,
            index + 1,
            mutations.len(),
            summarize_mutations(mutations)
        ));
        let response = client
            .post(format!("{origin}/v1/mutations"))
            .header("Authorization", format!("Bearer {}", session.access_token))
            .header(CLIENT_VERSION_HEADER.as_str(), CLIENT_VERSION)
            .header(
                CLIENT_PROTOCOL_HEADER.as_str(),
                CLIENT_PROTOCOL_VERSION.to_string(),
            )
            .json(&request)
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                replication_log(format!(
                    "post_mutations_for_session session_key={} origin={} http_status=success",
                    session.session_key, origin
                ));
                return Ok(());
            }
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                if let Ok(error_body) = serde_json::from_str::<ErrorBody>(&body) {
                    if error_body.error.code == "UNAUTHORIZED" {
                        return Err("needs_reauth".to_string());
                    }
                    return Err(error_body.error.message);
                }
                last_error = Some(format!("Mutation submit failed with HTTP {status}."));
            }
            Err(error) if is_connection_error(&error.to_string()) && index + 1 < origins.len() => {
                last_error = Some(error.to_string());
                continue;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(last_error.unwrap_or_else(|| "Mutation submit failed.".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syncd::models::SyncdEffectiveDiscoverySource;

    fn fixture_session(
        session_key: &str,
        local_profile_id: &str,
        remote_profile_id: &str,
        last_validated_at_ms: Option<i64>,
        last_known_status: SyncdDesktopConnectionStatus,
    ) -> PersistedSyncSession {
        PersistedSyncSession {
            session_key: session_key.to_string(),
            local_profile_id: local_profile_id.to_string(),
            remote_server_id: format!("server-{remote_profile_id}"),
            remote_profile_id: remote_profile_id.to_string(),
            canonical_origin: format!("https://{remote_profile_id}.example"),
            fallback_origins: vec![format!("https://fallback-{remote_profile_id}.example")],
            tls_cert_sha256: "sha256".to_string(),
            access_token: "token".to_string(),
            last_discovery_source: SyncdEffectiveDiscoverySource::AdvertisedEndpoint,
            last_validated_at_ms,
            last_known_status,
        }
    }

    #[test]
    fn book_bookmark_entity_id_is_stable() {
        let entry = LocalBookBookmark {
            book_id: "book-1".to_string(),
            location: Some("epubcfi(/6/2)".to_string()),
            href: None,
            page_index: None,
            progress_percent: 0.4,
            label: Some("Here".to_string()),
            saved_at: 10,
        };
        assert_eq!(
            bookmark_entity_id_for_book(&entry),
            bookmark_entity_id_for_book(&entry)
        );
    }

    #[test]
    fn diff_book_mutations_emits_merge_and_delete() {
        let previous = PersistedBookLibraryState {
            book_bookmarks: vec![LocalBookBookmark {
                book_id: "book-1".to_string(),
                location: Some("old".to_string()),
                href: None,
                page_index: None,
                progress_percent: 0.1,
                label: None,
                saved_at: 1,
            }],
            ..PersistedBookLibraryState::default()
        };
        let next = PersistedBookLibraryState {
            book_progress: vec![LocalBookProgress {
                book_id: "book-1".to_string(),
                location: Some("new".to_string()),
                href: None,
                progress_percent: 0.5,
                last_read_at: 20,
                page_index: None,
                total_pages: None,
                section_label: None,
                renderer: Some("epub".to_string()),
            }],
            ..PersistedBookLibraryState::default()
        };
        let diff = diff_book_mutations(&previous, &next);
        assert_eq!(diff.len(), 2);
    }

    #[test]
    fn diff_book_mutations_ignores_catalog_changes() {
        let previous = PersistedBookLibraryState {
            books: vec![json!({
                "id": "book-1",
                "title": "Old title",
                "updatedAt": 1,
            })],
            books_categories: vec![json!({
                "id": "category-1",
                "name": "Old category",
                "order": 1,
            })],
            books_category_assignments: BTreeMap::from([(
                "book-1".to_string(),
                vec!["category-1".to_string()],
            )]),
            books_library_ui: json!({
                "activeCategoryId": "category-1",
                "typeFilter": "all",
                "statusFilter": "all",
                "search": "old",
                "sortMode": "recentlyAdded",
                "sortDir": "desc",
            }),
            ..PersistedBookLibraryState::default()
        };
        let next = PersistedBookLibraryState {
            books: vec![json!({
                "id": "book-1",
                "title": "New title",
                "updatedAt": 2,
            })],
            books_categories: vec![json!({
                "id": "category-1",
                "name": "New category",
                "order": 2,
            })],
            books_category_assignments: BTreeMap::from([(
                "book-1".to_string(),
                vec!["category-1".to_string(), "category-2".to_string()],
            )]),
            books_library_ui: json!({
                "activeCategoryId": null,
                "typeFilter": "epub",
                "statusFilter": "finished",
                "search": "new",
                "sortMode": "author",
                "sortDir": "asc",
            }),
            ..PersistedBookLibraryState::default()
        };

        let diff = diff_book_mutations(&previous, &next);
        assert!(diff.is_empty());
    }

    #[test]
    fn diff_novel_mutations_emits_merge_and_delete() {
        let previous = PersistedNovelLibraryState {
            bookmarks: vec![LocalNovelBookmark {
                novel_id: "novel-1".to_string(),
                chapter_id: Some("ch-1".to_string()),
                chapter_title: Some("Old".to_string()),
                locator: Some("old-locator".to_string()),
                label: None,
                saved_at: 1,
            }],
            ..PersistedNovelLibraryState::default()
        };
        let next = PersistedNovelLibraryState {
            progress: vec![LocalNovelProgress {
                novel_id: "novel-1".to_string(),
                chapter_id: Some("ch-2".to_string()),
                chapter_title: Some("New".to_string()),
                progress_percent: 0.75,
                locator: Some("new-locator".to_string()),
                updated_at: 20,
            }],
            ..PersistedNovelLibraryState::default()
        };
        let diff = diff_novel_mutations("local-main", &previous, &next);
        assert_eq!(diff.len(), 2);
        assert!(matches!(
            diff[0],
            SerializableMutationInput::NovelProgress { .. }
        ));
        assert!(matches!(
            diff[1],
            SerializableMutationInput::NovelBookmark {
                base: SerializableMutationBase {
                    op: MutationOperation::Delete,
                    ..
                },
                ..
            }
        ));
    }

    #[test]
    fn diff_novel_mutations_ignores_library_metadata_changes() {
        let previous = PersistedNovelLibraryState {
            entries: vec![json!({
                "id": "novel-1",
                "title": "Old novel",
                "path": "/old",
            })],
            chapters: vec![json!({
                "id": "chapter-1",
                "novelId": "novel-1",
                "path": "/old/ch-1",
                "title": "Old chapter",
                "order": 1,
            })],
            history: vec![json!({
                "novelId": "novel-1",
                "chapterId": "chapter-1",
                "chapterTitle": "Old chapter",
                "locator": "old",
                "readAt": 1,
            })],
            ..PersistedNovelLibraryState::default()
        };
        let next = PersistedNovelLibraryState {
            entries: vec![json!({
                "id": "novel-1",
                "title": "New novel",
                "path": "/new",
            })],
            chapters: vec![json!({
                "id": "chapter-1",
                "novelId": "novel-1",
                "path": "/new/ch-1",
                "title": "New chapter",
                "order": 2,
            })],
            history: vec![json!({
                "novelId": "novel-1",
                "chapterId": "chapter-1",
                "chapterTitle": "New chapter",
                "locator": "new",
                "readAt": 2,
            })],
            ..PersistedNovelLibraryState::default()
        };

        let diff = diff_novel_mutations("local-main", &previous, &next);
        assert!(diff.is_empty());
    }

    #[test]
    fn remote_book_progress_and_bookmark_apply_to_local_state() {
        let mut state = PersistedBookLibraryState::default();

        upsert_book_progress(
            &mut state,
            BookProgressRecord {
                book_id: "book-1".to_string(),
                renderer: Some("epub".to_string()),
                location: Some("epubcfi(/6/2)".to_string()),
                href: Some("chapter.xhtml".to_string()),
                progress_percent: 0.42,
                last_read_at_ms: 1234,
                page_index: None,
                total_pages: None,
                section_label: Some("Chapter 1".to_string()),
                record_lamport: 10,
            },
        );
        upsert_book_bookmark(
            &mut state,
            BookBookmarkRecord {
                bookmark_id: "remote-bookmark-id".to_string(),
                book_id: "book-1".to_string(),
                location: Some("epubcfi(/6/4)".to_string()),
                href: Some("chapter.xhtml".to_string()),
                page_index: None,
                progress_percent: 0.5,
                label: Some("Good bit".to_string()),
                saved_at_ms: 1300,
                record_lamport: 11,
            },
        );

        assert_eq!(state.book_progress.len(), 1);
        assert_eq!(state.book_progress[0].book_id, "book-1");
        assert_eq!(state.book_progress[0].progress_percent, 0.42);
        assert_eq!(state.book_bookmarks.len(), 1);
        assert_eq!(state.book_bookmarks[0].label.as_deref(), Some("Good bit"));

        let bookmark_id = bookmark_entity_id_for_book(&state.book_bookmarks[0]);
        delete_book_bookmark(&mut state, &bookmark_id);
        assert!(state.book_bookmarks.is_empty());
    }

    #[test]
    fn remote_novel_progress_and_bookmark_apply_to_local_state() {
        let mut state = PersistedNovelLibraryState::default();

        upsert_novel_progress(
            &mut state,
            NovelProgressRecord {
                novel_id: "novel-1".to_string(),
                chapter_id: Some("chapter-9".to_string()),
                chapter_title: Some("Nine".to_string()),
                chapter_order_key: Some(9.0),
                progress_percent: 0.8,
                locator: Some("para-12".to_string()),
                locator_sort_key: Some(12.0),
                updated_at_ms: 2000,
                record_lamport: 20,
            },
        );
        upsert_novel_bookmark(
            &mut state,
            NovelBookmarkRecord {
                bookmark_id: "remote-novel-bookmark-id".to_string(),
                novel_id: "novel-1".to_string(),
                chapter_id: Some("chapter-9".to_string()),
                chapter_title: Some("Nine".to_string()),
                chapter_order_key: Some(9.0),
                locator: Some("para-14".to_string()),
                locator_sort_key: Some(14.0),
                label: Some("Remember".to_string()),
                saved_at_ms: 2100,
                record_lamport: 21,
            },
        );

        assert_eq!(state.progress.len(), 1);
        assert_eq!(state.progress[0].novel_id, "novel-1");
        assert_eq!(state.progress[0].progress_percent, 0.8);
        assert_eq!(state.bookmarks.len(), 1);
        assert_eq!(state.bookmarks[0].label.as_deref(), Some("Remember"));

        let bookmark_id = bookmark_entity_id_for_novel(&state.bookmarks[0]);
        delete_novel_bookmark(&mut state, &bookmark_id);
        assert!(state.bookmarks.is_empty());
    }

    #[test]
    fn choose_default_session_picks_most_recent_for_profile() {
        let sessions = vec![
            fixture_session(
                "session-old",
                "local-a",
                "remote-a",
                Some(10),
                SyncdDesktopConnectionStatus::Connected,
            ),
            fixture_session(
                "session-new",
                "local-a",
                "remote-b",
                Some(20),
                SyncdDesktopConnectionStatus::Connected,
            ),
            fixture_session(
                "session-other-profile",
                "local-b",
                "remote-c",
                Some(30),
                SyncdDesktopConnectionStatus::Connected,
            ),
        ];

        assert_eq!(
            choose_default_session(&sessions, "local-a"),
            Some("session-new".to_string())
        );
    }

    #[test]
    fn build_session_catalog_marks_active_session_actions() {
        let persisted = SyncdDesktopPersistedState {
            device_id: "desktop-a".to_string(),
            sessions: vec![
                fixture_session(
                    "session-active",
                    "local-a",
                    "remote-a",
                    Some(100),
                    SyncdDesktopConnectionStatus::Connected,
                ),
                fixture_session(
                    "session-secondary",
                    "local-a",
                    "remote-b",
                    Some(90),
                    SyncdDesktopConnectionStatus::Connected,
                ),
            ],
        };
        let mut replication = PersistedReplicationState::default();
        let profile = profile_state_mut(&mut replication, "local-a");
        profile.active_session_key = Some("session-active".to_string());
        profile.replication_status = SyncdReplicationStatus::Live;
        profile.paused = false;

        let catalog = build_session_catalog(&persisted, &replication, "local-a");
        assert_eq!(
            catalog.active_session_key.as_deref(),
            Some("session-active")
        );
        assert_eq!(catalog.sessions.len(), 2);

        let active = catalog
            .sessions
            .iter()
            .find(|session| session.session_key == "session-active")
            .unwrap();
        assert!(active.is_active_for_sync);
        assert_eq!(
            active.replication_status,
            Some(SyncdReplicationStatus::Live)
        );
        assert!(!active.actions.can_set_active);
        assert!(active.actions.can_pause);
        assert!(!active.actions.can_resume);
        assert!(active.actions.can_disconnect);
        assert!(!active.actions.can_forget);

        let secondary = catalog
            .sessions
            .iter()
            .find(|session| session.session_key == "session-secondary")
            .unwrap();
        assert!(!secondary.is_active_for_sync);
        assert_eq!(secondary.replication_status, None);
        assert!(secondary.actions.can_set_active);
        assert!(!secondary.actions.can_pause);
        assert!(!secondary.actions.can_resume);
        assert!(secondary.actions.can_forget);
    }

    #[test]
    fn replication_state_roundtrip_uses_override_directory() {
        let temp = tempfile::tempdir().unwrap();
        std::env::set_var("AETHON_SYNCD_DESKTOP_STATE_DIR", temp.path());
        let mut state = PersistedReplicationState::default();
        profile_state_mut(&mut state, "local-a").active_session_key = Some("session-a".to_string());
        save_replication_state(&state).unwrap();
        let loaded = load_replication_state().unwrap();
        assert_eq!(
            loaded
                .profiles
                .get("local-a")
                .and_then(|profile| profile.active_session_key.clone()),
            Some("session-a".to_string())
        );
        std::env::remove_var("AETHON_SYNCD_DESKTOP_STATE_DIR");
    }
}
