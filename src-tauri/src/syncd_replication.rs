use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, ETAG, RANGE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio::time::sleep;
use uuid::Uuid;

use crate::syncd::middleware::{
    ASSET_SHA256_HEADER, CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER,
    CURRENT_CLIENT_VERSION, LEGACY_ASSET_SHA256_HEADER, LEGACY_CLIENT_PROTOCOL_HEADER,
    LEGACY_CLIENT_VERSION_HEADER,
};
use crate::syncd::models::{
    canonical_novel_identity_key, canonical_novel_plugin_id, canonical_novel_repository_id,
    canonical_portable_chapter_id, canonical_portable_work_id, canonicalize_novel_repository_url,
    BookBookmarkPatch, BookBookmarkRecord, BookCategoryAssignmentPatch,
    BookCategoryAssignmentRecord, BookCategoryPatch, BookCategoryRecord, BookEntryPatch,
    BookEntryRecord, BookHighlightRecord, BookHistoryPatch, BookHistoryRecord, BookLibraryUiPatch,
    BookLibraryUiRecord, BookProgressPatch, BookProgressRecord, ChangeEnvelope, ComicHistoryPatch,
    ComicPageBookmarkPatch, ErrorBody, MutationOperation, MutationResultStatus, MutationsResponse,
    NovelBookmarkPatch, NovelBookmarkRecord, NovelChapterPatch, NovelChapterRecord,
    NovelClassificationPatch, NovelClassificationRecord, NovelEntryPatch, NovelEntryRecord,
    NovelHistoryPatch, NovelHistoryRecord, NovelPluginPatch, NovelProgressPatch,
    NovelProgressRecord, NovelRepositoryPatch, PortableChapterRefV3, PortableWorkRefV3,
    SnapshotResponse, SyncdEffectiveDiscoverySource, MIN_SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
    SNAPSHOT_SCHEMA_VERSION,
};
use crate::syncd_desktop::{
    build_pinned_http_client, desktop_state_dir, is_connection_error, is_needs_reauth_error,
    load_persisted_state, now_ms, revalidate_session, save_persisted_state, PersistedSyncSession,
    SyncdDesktopConnectionStatus, SyncdDesktopPersistedState, SyncdReconnectStatus,
};
use crate::{
    book_library_state_path, books_data_dir, novel_library_state_path_for_target,
    novel_repository_state_path_for_target, novel_source_classification_state_path_for_target,
    LaunchTarget, LaunchTargetInfo,
};

const CLIENT_PROTOCOL_VERSION: u32 = 1;
const BOOKS_SCOPE_ID: &str = "books:global";
const EVENT_REPLICATION_STATE: &str = "syncd-replication-state";
const EVENT_REPLICATION_ERROR: &str = "syncd-replication-error";
const EVENT_COMIC_READER_STATE_APPLIED: &str = "syncd-comic-reader-state-applied";
// This domain is hashed into the persisted comic-server fingerprint. It must
// stay stable across the product rename.
const COMIC_SERVER_IDENTITY_DOMAIN: &str = "aethon-core-suwayomi-v1";
const RECONNECT_DELAY: Duration = Duration::from_secs(3);
const ASSET_STREAM_CHUNK_SIZE: usize = 64 * 1024;

#[derive(Clone)]
struct BookAssetEndpoint {
    client: reqwest::Client,
    origin: String,
    access_token: String,
    scope_id: String,
}

impl BookAssetEndpoint {
    fn new(client: reqwest::Client, origin: &str, access_token: &str) -> Self {
        Self {
            client,
            origin: origin.trim_end_matches('/').to_string(),
            access_token: access_token.to_string(),
            scope_id: BOOKS_SCOPE_ID.to_string(),
        }
    }

    fn for_scope(
        client: reqwest::Client,
        origin: &str,
        access_token: &str,
        scope_id: &str,
    ) -> Self {
        let mut endpoint = Self::new(client, origin, access_token);
        endpoint.scope_id = scope_id.to_string();
        endpoint
    }

    fn asset_url(&self, sha256: &str) -> String {
        format!("{}/v1/assets/{sha256}", self.origin)
    }
}

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
    pub comics_scope_checkpoint: Option<SyncdReplicationScopeCheckpoint>,
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
    #[serde(default)]
    comics_scope_checkpoint: Option<SyncdReplicationScopeCheckpoint>,
    #[serde(default)]
    pending_comic_reader_changes: Vec<ChangeEnvelope>,
    #[serde(default)]
    pending_comic_reader_snapshot: Option<SyncdComicReaderSnapshotMarker>,
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
            comics_scope_checkpoint: self.comics_scope_checkpoint.clone(),
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
            comics_scope_checkpoint: None,
            pending_comic_reader_changes: Vec::new(),
            pending_comic_reader_snapshot: None,
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
    ) || matches!(
        std::env::var("EPIGRAPH_SYNCD_REPLICATION_LOG")
            .ok()
            .as_deref(),
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
    let mut state = serde_json::from_str::<PersistedReplicationState>(&raw)
        .map_err(|error| error.to_string())?;
    // Older builds retained every replayed version of a comic reader entity. That made the
    // desktop state grow without bound (tens of thousands of history revisions for fewer than
    // two thousand current entities) and forced each atomic state write to serialize the entire
    // backlog. Delivery is state based: the latest server version for an entity causally
    // supersedes its earlier merge/delete commands, so compact them during every load. The next
    // normal save atomically migrates the persisted file without discarding any final state.
    for profile in state.profiles.values_mut() {
        compact_pending_comic_reader_changes(&mut profile.pending_comic_reader_changes);
    }
    Ok(state)
}

fn compact_pending_comic_reader_changes(changes: &mut Vec<ChangeEnvelope>) {
    let mut latest = BTreeMap::<(String, String, String), ChangeEnvelope>::new();
    for change in changes.drain(..) {
        let key = (
            change.scope_id.clone(),
            change.entity_type.clone(),
            change.entity_id.clone(),
        );
        let replaces_current = latest
            .get(&key)
            .map(|current| {
                (change.server_version, change.lamport) > (current.server_version, current.lamport)
            })
            .unwrap_or(true);
        if replaces_current {
            latest.insert(key, change);
        }
    }
    *changes = latest.into_values().collect();
    changes.sort_by(|left, right| {
        left.server_version
            .cmp(&right.server_version)
            .then_with(|| left.lamport.cmp(&right.lamport))
            .then_with(|| left.entity_type.cmp(&right.entity_type))
            .then_with(|| left.entity_id.cmp(&right.entity_id))
    });
}

fn write_file_atomic(path: &Path, payload: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp_path = path.with_extension(format!(
        "{}.{}.tmp",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("state"),
        Uuid::now_v7()
    ));
    let result = (|| -> io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        file.write_all(payload)?;
        file.sync_all()?;
        drop(file);
        replace_file_atomic(&temp_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result.map_err(|error| error.to_string())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = [0_u8; ASSET_STREAM_CHUNK_SIZE];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

async fn sha256_file_async(path: PathBuf) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || sha256_file(&path))
        .await
        .map_err(|error| error.to_string())?
}

fn validate_asset_sha256(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Book asset fingerprint must be a 64-character SHA-256.".to_string());
    }
    Ok(normalized)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BookCoverAssetMetadata {
    sha256: String,
    byte_size: i64,
    mime_type: &'static str,
}

fn cover_asset_metadata(value: &Value) -> Option<BookCoverAssetMetadata> {
    let sha256 = value_string_field(value, "coverAssetSha256")?;
    let byte_size = value_i64_field(value, "coverAssetByteSize")?;
    let mime_type = match value_string_field(value, "coverAssetMimeType")?.as_str() {
        "image/jpeg" => "image/jpeg",
        "image/png" => "image/png",
        "image/webp" => "image/webp",
        _ => return None,
    };
    if byte_size <= 0 || validate_asset_sha256(&sha256).is_err() {
        return None;
    }
    Some(BookCoverAssetMetadata {
        sha256,
        byte_size,
        mime_type,
    })
}

fn apply_cover_asset_metadata(value: &mut Value, metadata: Option<&BookCoverAssetMetadata>) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    match metadata {
        Some(metadata) => {
            object.insert(
                "coverAssetSha256".to_string(),
                Value::String(metadata.sha256.clone()),
            );
            object.insert(
                "coverAssetByteSize".to_string(),
                Value::Number(metadata.byte_size.into()),
            );
            object.insert(
                "coverAssetMimeType".to_string(),
                Value::String(metadata.mime_type.to_string()),
            );
            object.insert("hasCover".to_string(), Value::Bool(true));
        }
        None => {
            object.remove("coverAssetSha256");
            object.remove("coverAssetByteSize");
            object.remove("coverAssetMimeType");
            object.insert("hasCover".to_string(), Value::Bool(false));
        }
    }
}

fn detected_cover_mime_type(header: &[u8]) -> Option<&'static str> {
    if header.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if header.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if header.len() >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

async fn inspect_local_book_cover(path: &Path) -> Result<Option<BookCoverAssetMetadata>, String> {
    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => metadata,
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Book cover metadata is unavailable: {error}")),
    };
    let byte_size = i64::try_from(metadata.len())
        .map_err(|_| "Book cover size exceeds the supported contract range.".to_string())?;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("Book cover could not be opened: {error}"))?;
    let mut header = [0_u8; 12];
    let read = file
        .read(&mut header)
        .await
        .map_err(|error| format!("Book cover header could not be read: {error}"))?;
    let Some(mime_type) = detected_cover_mime_type(&header[..read]) else {
        return Ok(None);
    };
    Ok(Some(BookCoverAssetMetadata {
        sha256: sha256_file_async(path.to_path_buf()).await?,
        byte_size,
        mime_type,
    }))
}

async fn enrich_book_cover_assets(
    previous: &PersistedBookLibraryState,
    next: &mut PersistedBookLibraryState,
) -> Result<bool, String> {
    let previous_by_id: HashMap<String, &Value> = previous
        .books
        .iter()
        .filter_map(|entry| Some((book_entry_entity_id(entry)?, entry)))
        .collect();
    let mut changed = false;

    for entry in &mut next.books {
        let Some(book_id) = book_entry_entity_id(entry) else {
            continue;
        };
        let previous_entry = previous_by_id.get(&book_id).copied();
        let next_path =
            value_string_field(entry, "coverPath").filter(|path| !path.trim().is_empty());
        let previous_path = previous_entry
            .and_then(|value| value_string_field(value, "coverPath"))
            .filter(|path| !path.trim().is_empty());
        let before = (
            value_string_field(entry, "coverAssetSha256"),
            value_i64_field(entry, "coverAssetByteSize"),
            value_string_field(entry, "coverAssetMimeType"),
            value_bool_field(entry, "hasCover", false),
        );

        let metadata = if next_path != previous_path {
            match next_path.as_deref() {
                Some(path) => inspect_local_book_cover(Path::new(path)).await?,
                None => cover_asset_metadata(entry),
            }
        } else if let Some(metadata) = cover_asset_metadata(entry)
            .or_else(|| previous_entry.and_then(|value| cover_asset_metadata(value)))
        {
            Some(metadata)
        } else {
            match next_path.as_deref() {
                Some(path) => inspect_local_book_cover(Path::new(path)).await?,
                None => None,
            }
        };
        apply_cover_asset_metadata(entry, metadata.as_ref());

        let after = (
            value_string_field(entry, "coverAssetSha256"),
            value_i64_field(entry, "coverAssetByteSize"),
            value_string_field(entry, "coverAssetMimeType"),
            value_bool_field(entry, "hasCover", false),
        );
        changed |= before != after;
    }
    Ok(changed)
}

fn expected_book_mime_type(subtype: &str) -> Result<&'static str, String> {
    match subtype.trim().to_ascii_lowercase().as_str() {
        "epub" => Ok("application/epub+zip"),
        "pdf" => Ok("application/pdf"),
        other => Err(format!(
            "Unsupported synchronized book subtype '{other}'; expected epub or pdf."
        )),
    }
}

fn enrich_book_asset_metadata(
    previous: &PersistedBookLibraryState,
    next: &mut PersistedBookLibraryState,
) -> Result<bool, String> {
    let previous_by_id: HashMap<String, &Value> = previous
        .books
        .iter()
        .filter_map(|entry| Some((book_entry_entity_id(entry)?, entry)))
        .collect();
    let mut changed = false;

    for entry in &mut next.books {
        let Some(book_id) = book_entry_entity_id(entry) else {
            continue;
        };
        let Some(object) = entry.as_object_mut() else {
            continue;
        };
        let previous_entry = previous_by_id.get(&book_id).copied();
        for field in ["assetFingerprint", "assetPath", "mimeType", "byteSize"] {
            let missing = object
                .get(field)
                .is_none_or(|value| value.is_null() || value.as_str().is_some_and(str::is_empty));
            if missing {
                if let Some(value) = previous_entry.and_then(|entry| entry.get(field)).cloned() {
                    object.insert(field.to_string(), value);
                    changed = true;
                }
            }
        }

        let subtype = object
            .get("subtype")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("Book {book_id} is missing its immutable subtype."))?;
        let expected_mime = expected_book_mime_type(&subtype)?;
        match object
            .get("mimeType")
            .and_then(Value::as_str)
            .map(str::trim)
        {
            None | Some("") | Some("application/octet-stream") => {
                object.insert(
                    "mimeType".to_string(),
                    Value::String(expected_mime.to_string()),
                );
                changed = true;
            }
            Some(actual) if actual != expected_mime => {
                return Err(format!(
                    "Book {book_id} MIME type '{actual}' does not match subtype '{subtype}'."
                ));
            }
            Some(_) => {}
        }

        if let Some(path) = object
            .get("assetPath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            if let Ok(metadata) = fs::metadata(path) {
                if metadata.is_file() {
                    let byte_size = i64::try_from(metadata.len()).map_err(|_| {
                        format!("Book {book_id} exceeds the supported contract size range.")
                    })?;
                    if object.get("byteSize").and_then(Value::as_i64) != Some(byte_size) {
                        object.insert("byteSize".to_string(), Value::Number(byte_size.into()));
                        changed = true;
                    }
                }
            }
        }
    }
    Ok(changed)
}

fn book_asset_extension(subtype: &str) -> Result<&'static str, String> {
    match subtype.trim().to_ascii_lowercase().as_str() {
        "epub" => Ok("epub"),
        "pdf" => Ok("pdf"),
        other => Err(format!(
            "Unsupported synchronized book subtype '{other}'; expected epub or pdf."
        )),
    }
}

fn synchronized_book_asset_path(
    root: &Path,
    sha256: &str,
    subtype: &str,
) -> Result<PathBuf, String> {
    let extension = book_asset_extension(subtype)?;
    Ok(root
        .join("synced")
        .join(extension)
        .join(format!("{sha256}.{extension}")))
}

fn response_error_message(status: reqwest::StatusCode, body: &str, action: &str) -> String {
    if let Ok(error_body) = serde_json::from_str::<ErrorBody>(body) {
        if error_body.error.code == "UNAUTHORIZED" {
            return "needs_reauth".to_string();
        }
        return error_body.error.message;
    }
    format!("{action} failed with HTTP {status}.")
}

fn authenticated_asset_request(
    request: reqwest::RequestBuilder,
    endpoint: &BookAssetEndpoint,
) -> reqwest::RequestBuilder {
    request
        .query(&[("scopeId", endpoint.scope_id.as_str())])
        .header("Authorization", format!("Bearer {}", endpoint.access_token))
        .header(CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(LEGACY_CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(
            CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .header(
            LEGACY_CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
}

async fn remote_asset_size(
    endpoint: &BookAssetEndpoint,
    sha256: &str,
) -> Result<Option<u64>, String> {
    let response =
        authenticated_asset_request(endpoint.client.head(endpoint.asset_url(sha256)), endpoint)
            .send()
            .await
            .map_err(|error| error.to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(response_error_message(status, &body, "Book asset lookup"));
    }
    let declared_sha = response
        .headers()
        .get(ASSET_SHA256_HEADER)
        .or_else(|| response.headers().get(LEGACY_ASSET_SHA256_HEADER))
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !declared_sha.eq_ignore_ascii_case(sha256) {
        return Err("Core returned a mismatched book asset fingerprint.".to_string());
    }
    let expected_etag = format!("\"{sha256}\"");
    let etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if etag != expected_etag {
        return Err("Core returned a mismatched book asset ETag.".to_string());
    }
    let size = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "Core omitted the book asset Content-Length.".to_string())?;
    Ok(Some(size))
}

async fn upload_book_asset(
    endpoint: &BookAssetEndpoint,
    path: &Path,
    sha256: &str,
) -> Result<(), String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("Book asset is unavailable: {error}"))?;
    if !metadata.is_file() {
        return Err("Book asset path is not a file.".to_string());
    }
    let actual_sha256 = sha256_file_async(path.to_path_buf()).await?;
    if actual_sha256 != sha256 {
        return Err(format!(
            "Book asset changed before upload: expected {sha256}, found {actual_sha256}."
        ));
    }
    if let Some(remote_size) = remote_asset_size(endpoint, sha256).await? {
        return if remote_size == metadata.len() {
            Ok(())
        } else {
            Err(format!(
                "Core already stores book asset {sha256} with {remote_size} bytes; expected {}.",
                metadata.len()
            ))
        };
    }

    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("Book asset could not be opened for upload: {error}"))?;
    let stream = futures_util::stream::try_unfold(file, |mut file| async move {
        let mut buffer = vec![0_u8; ASSET_STREAM_CHUNK_SIZE];
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            return Ok::<_, io::Error>(None);
        }
        buffer.truncate(read);
        Ok(Some((buffer, file)))
    });
    let response = authenticated_asset_request(
        endpoint
            .client
            .put(endpoint.asset_url(sha256))
            .header(CONTENT_LENGTH, metadata.len())
            .body(reqwest::Body::wrap_stream(stream)),
        endpoint,
    )
    .send()
    .await
    .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(response_error_message(status, &body, "Book asset upload"));
    }
    match remote_asset_size(endpoint, sha256).await? {
        Some(size) if size == metadata.len() => Ok(()),
        Some(size) => Err(format!(
            "Core stored an unexpected book asset size: expected {}, found {size}.",
            metadata.len()
        )),
        None => Err("Core did not publish the uploaded book asset.".to_string()),
    }
}

async fn download_book_asset(
    endpoint: &BookAssetEndpoint,
    sha256: &str,
    subtype: &str,
) -> Result<PathBuf, String> {
    download_book_asset_to_root(endpoint, sha256, subtype, &books_data_dir()).await
}

async fn download_book_asset_to_root(
    endpoint: &BookAssetEndpoint,
    sha256: &str,
    subtype: &str,
    root: &Path,
) -> Result<PathBuf, String> {
    let expected_size = remote_asset_size(endpoint, sha256)
        .await?
        .ok_or_else(|| format!("Core does not have book asset {sha256}."))?;
    let destination = synchronized_book_asset_path(root, sha256, subtype)?;
    if let Ok(metadata) = tokio::fs::metadata(&destination).await {
        if metadata.is_file()
            && metadata.len() == expected_size
            && sha256_file_async(destination.clone()).await? == sha256
        {
            return Ok(destination);
        }
        return Err(format!(
            "A different local file already occupies synchronized asset path {}.",
            destination.display()
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "Synchronized book asset path has no parent.".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| error.to_string())?;
    let part_path = destination.with_extension(format!(
        "{}.part",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("asset")
    ));
    let mut downloaded = tokio::fs::metadata(&part_path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    if downloaded > expected_size {
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&part_path)
            .await
            .map_err(|error| error.to_string())?;
        file.set_len(0).await.map_err(|error| error.to_string())?;
        downloaded = 0;
    }

    if downloaded < expected_size {
        let mut request =
            authenticated_asset_request(endpoint.client.get(endpoint.asset_url(sha256)), endpoint);
        if downloaded > 0 {
            request = request.header(RANGE, format!("bytes={downloaded}-"));
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(response_error_message(status, &body, "Book asset download"));
        }
        let append = downloaded > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
        if append {
            let expected_prefix = format!("bytes {downloaded}-");
            let content_range = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            if !content_range.starts_with(&expected_prefix)
                || !content_range.ends_with(&format!("/{expected_size}"))
            {
                return Err(
                    "Core returned an invalid Content-Range for book asset resume.".to_string(),
                );
            }
        } else {
            downloaded = 0;
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(&part_path)
            .await
            .map_err(|error| error.to_string())?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| error.to_string())?;
            downloaded = downloaded
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| "Book asset download size overflowed.".to_string())?;
            if downloaded > expected_size {
                file.set_len(0).await.map_err(|error| error.to_string())?;
                return Err("Core sent more book asset bytes than declared.".to_string());
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| error.to_string())?;
        }
        file.flush().await.map_err(|error| error.to_string())?;
        file.sync_all().await.map_err(|error| error.to_string())?;
    }

    if downloaded != expected_size {
        return Err(format!(
            "Book asset download is incomplete: expected {expected_size} bytes, received {downloaded}."
        ));
    }
    let actual_sha256 = sha256_file_async(part_path.clone()).await?;
    if actual_sha256 != sha256 {
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&part_path)
            .await
            .map_err(|error| error.to_string())?;
        file.set_len(0).await.map_err(|error| error.to_string())?;
        return Err(format!(
            "Downloaded book asset failed SHA-256 validation: expected {sha256}, found {actual_sha256}."
        ));
    }
    match tokio::fs::rename(&part_path, &destination).await {
        Ok(()) => Ok(destination),
        Err(error) if tokio::fs::try_exists(&destination).await.unwrap_or(false) => {
            let actual = sha256_file_async(destination.clone()).await?;
            if actual == sha256 {
                Ok(destination)
            } else {
                Err(format!(
                    "Synchronized asset appeared concurrently with different bytes: {error}."
                ))
            }
        }
        Err(error) => Err(format!("Failed to publish book asset atomically: {error}.")),
    }
}

#[cfg(windows)]
fn replace_file_atomic(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file_atomic(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

fn save_replication_state(state: &PersistedReplicationState) -> Result<(), String> {
    let path = replication_state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    write_file_atomic(&path, &payload)
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

fn reconcile_profile_sessions(
    profile: &mut PersistedReplicationProfileState,
    sessions: &[PersistedSyncSession],
    profile_id: &str,
) {
    if profile.active_session_key.is_none() {
        profile.active_session_key = choose_default_session(sessions, profile_id);
    }
    if profile.active_session_key.is_none() && !profile.paused {
        profile.replication_status = SyncdReplicationStatus::Idle;
        profile.last_error = None;
    }
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
    #[serde(rename = "book.history")]
    BookHistory {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: Option<BookHistoryPatch>,
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
    #[serde(rename = "novel.repository")]
    NovelRepository {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: Option<NovelRepositoryPatch>,
    },
    #[serde(rename = "novel.plugin")]
    NovelPlugin {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: Option<NovelPluginPatch>,
    },
    #[serde(rename = "comic.history")]
    ComicHistory {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: Option<ComicHistoryPatch>,
    },
    #[serde(rename = "comic.page_bookmark")]
    ComicPageBookmark {
        #[serde(flatten)]
        base: SerializableMutationBase,
        patch: Option<ComicPageBookmarkPatch>,
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
            Self::BookHistory { .. } => "book.history",
            Self::NovelProgress { .. } => "novel.progress",
            Self::BookBookmark { .. } => "book.bookmark",
            Self::NovelEntry { .. } => "novel.entry",
            Self::NovelChapter { .. } => "novel.chapter",
            Self::NovelBookmark { .. } => "novel.bookmark",
            Self::NovelHistory { .. } => "novel.history",
            Self::NovelClassification { .. } => "novel.classification",
            Self::NovelRepository { .. } => "novel.repository",
            Self::NovelPlugin { .. } => "novel.plugin",
            Self::ComicHistory { .. } => "comic.history",
            Self::ComicPageBookmark { .. } => "comic.page_bookmark",
        }
    }

    fn op_label(&self) -> &'static str {
        let op = match self {
            Self::BookEntry { base, .. }
            | Self::BookCategory { base, .. }
            | Self::BookCategoryAssignment { base, .. }
            | Self::BookProgress { base, .. }
            | Self::BookHistory { base, .. }
            | Self::NovelProgress { base, .. }
            | Self::BookBookmark { base, .. }
            | Self::NovelEntry { base, .. }
            | Self::NovelChapter { base, .. }
            | Self::NovelBookmark { base, .. }
            | Self::NovelHistory { base, .. }
            | Self::NovelClassification { base, .. }
            | Self::NovelRepository { base, .. }
            | Self::NovelPlugin { base, .. }
            | Self::ComicHistory { base, .. }
            | Self::ComicPageBookmark { base, .. } => &base.op,
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
            | Self::BookHistory { base, .. }
            | Self::NovelProgress { base, .. }
            | Self::BookBookmark { base, .. }
            | Self::NovelEntry { base, .. }
            | Self::NovelChapter { base, .. }
            | Self::NovelBookmark { base, .. }
            | Self::NovelHistory { base, .. }
            | Self::NovelClassification { base, .. }
            | Self::NovelRepository { base, .. }
            | Self::NovelPlugin { base, .. }
            | Self::ComicHistory { base, .. }
            | Self::ComicPageBookmark { base, .. } => &base.entity_id,
            Self::BookLibraryUi { base, .. } => &base.entity_id,
        }
    }

    fn client_mutation_id(&self) -> &str {
        match self {
            Self::BookEntry { base, .. }
            | Self::BookCategory { base, .. }
            | Self::BookCategoryAssignment { base, .. }
            | Self::BookProgress { base, .. }
            | Self::BookHistory { base, .. }
            | Self::NovelProgress { base, .. }
            | Self::BookBookmark { base, .. }
            | Self::NovelEntry { base, .. }
            | Self::NovelChapter { base, .. }
            | Self::NovelBookmark { base, .. }
            | Self::NovelHistory { base, .. }
            | Self::NovelClassification { base, .. }
            | Self::NovelRepository { base, .. }
            | Self::NovelPlugin { base, .. }
            | Self::ComicHistory { base, .. }
            | Self::ComicPageBookmark { base, .. }
            | Self::BookLibraryUi { base, .. } => &base.client_mutation_id,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncdPublishComicReaderMutationInput {
    pub profile_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub op: MutationOperation,
    pub patch: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncdAckComicReaderChangesInput {
    pub profile_id: String,
    pub through_server_version: i64,
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
    /// Highlights are currently owned by the native book readers and must survive frontend JSON
    /// rewrites even when the desktop UI does not expose an editor for them yet.
    #[serde(default)]
    book_highlights: Vec<LocalBookHighlight>,
    /// Rust-owned bridge state. The current desktop frontend does not expose
    /// book reading sessions, so it must survive frontend JSON rewrites.
    #[serde(default)]
    book_history: Vec<LocalBookHistory>,
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
    #[serde(default)]
    bookmark_id: String,
    book_id: String,
    location: Option<String>,
    href: Option<String>,
    page_index: Option<i64>,
    progress_percent: f64,
    label: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    created_at_ms: i64,
    #[serde(default)]
    updated_at_ms: i64,
    saved_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct PersistedNovelRepositoryState {
    repositories: Vec<LocalNovelRepository>,
    catalog_entries: Vec<LocalNovelCatalogEntry>,
    installed_plugins: Vec<LocalInstalledNovelPlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct LocalNovelRepository {
    id: String,
    url: String,
    normalized_url: String,
    enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct LocalNovelCatalogEntry {
    repository_id: String,
    plugin_id: String,
    name: String,
    lang: String,
    version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct LocalInstalledNovelPlugin {
    repository_id: String,
    plugin_id: String,
    version: String,
    enabled: bool,
    artifact_path: String,
    installed_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LocalBookHighlight {
    highlight_id: String,
    book_id: String,
    start_locator_json: Value,
    end_locator_json: Value,
    selected_text: String,
    color_argb: i64,
    note: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LocalBookHistory {
    history_id: String,
    book_id: String,
    renderer: Option<String>,
    location: Option<String>,
    href: Option<String>,
    page_index: Option<i64>,
    progress_percent: f64,
    section_label: Option<String>,
    read_at_ms: i64,
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
    comic_reader_changes: Vec<ChangeEnvelope>,
    applied_scopes: HashSet<String>,
}

fn novels_scope_id(remote_profile_id: &str) -> String {
    format!("novels:profile:{remote_profile_id}")
}

fn comics_scope_id(profile_id: &str) -> String {
    format!("comics:profile:{profile_id}")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncdComicReaderStateAppliedPayload {
    pub local_profile_id: String,
    pub changes: Vec<ChangeEnvelope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authoritative_snapshot: Option<SyncdComicReaderSnapshotMarker>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdComicReaderSnapshotMarker {
    pub scope_id: String,
    pub snapshot_version: i64,
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
    write_file_atomic(&path, &payload)
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
    write_file_atomic(&path, &payload)
}

fn read_novel_repository_state(
    launch_target: &LaunchTargetInfo,
    profile_id: &str,
) -> Result<PersistedNovelRepositoryState, String> {
    let path = novel_repository_state_path_for_target(launch_target, Some(profile_id), None)?;
    if !path.exists() {
        return Ok(PersistedNovelRepositoryState::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
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
    write_file_atomic(&path, &payload)
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
        reconcile_profile_sessions(profile, &desktop.sessions, &profile_id);
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
    // Bootstrap can be triggered by setup and by persistent-Core reattachment at
    // nearly the same time. Issuing two tokens for the same deterministic tokenId
    // revokes the first token hash, so keep the runtime lock until the winning
    // token is stored and let concurrent callers observe that session.
    let mut runtime = state.runtime.lock().await;
    if runtime
        .local_authority
        .get(profile_id)
        .map(|session| session.local_base_url == local_base_url)
        .unwrap_or(false)
    {
        drop(runtime);
        clear_hosted_comic_reader_inbox(profile_id)?;
        return Ok(());
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

    runtime.local_authority.insert(
        profile_id.to_string(),
        LocalAuthoritySession {
            profile_id: profile_id.to_string(),
            local_base_url: local_base_url.to_string(),
            access_token: payload.access_token,
        },
    );
    drop(runtime);

    clear_hosted_comic_reader_inbox(profile_id)?;
    if let Err(error) = publish_current_novel_repository_state(app, profile_id).await {
        replication_log(format!(
            "publish_current_novel_repository_state profile_id={profile_id} status=deferred error={error}"
        ));
    }
    if let Err(error) = publish_current_novel_library_state(app, profile_id).await {
        replication_log(format!(
            "publish_current_novel_library_state profile_id={profile_id} status=deferred error={error}"
        ));
    }
    if let Err(error) = publish_current_book_library_state(app, profile_id).await {
        replication_log(format!(
            "publish_current_book_library_state profile_id={profile_id} status=deferred error={error}"
        ));
    }
    ensure_worker_for_profile(app, state, profile_id).await?;
    Ok(())
}

fn clear_hosted_comic_reader_inbox(profile_id: &str) -> Result<(), String> {
    update_profile_state(profile_id, |profile| {
        // The hosted Core is the invisible desktop bridge for comic reader state and already
        // projects it into Suwayomi. Keeping a second GUI inbox would retain the same state twice
        // and previously grew to tens of thousands of revisions while the window was closed.
        profile.pending_comic_reader_changes.clear();
        profile.pending_comic_reader_snapshot = None;
        if profile.active_session_key.is_none() && !profile.paused {
            profile.replication_status = SyncdReplicationStatus::Idle;
            profile.last_error = None;
        }
    })?;
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

enum ChangesFetchOutcome {
    Changes(ChangesResponsePayload),
    ReplayWindowExpired,
}

async fn replay_and_stream_remote(
    app: &AppHandle,
    profile_id: &str,
    session: &PersistedSyncSession,
    connected_origin: &str,
    novels_profile_id: &str,
) -> Result<(), String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let asset_endpoint = BookAssetEndpoint::new(
        build_pinned_http_client(&session.tls_cert_sha256)?,
        connected_origin,
        &session.access_token,
    );
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
            snapshot
                .comics_scope_checkpoint
                .as_ref()
                .map(|checkpoint| checkpoint.last_applied_server_version)
                .unwrap_or_default(),
        ]
        .into_iter()
        .min()
        .unwrap_or_default();
        let changes = match fetch_changes_remote(session, connected_origin, since_version).await? {
            ChangesFetchOutcome::Changes(changes) => changes,
            ChangesFetchOutcome::ReplayWindowExpired => {
                recover_from_snapshots_remote(
                    app,
                    &launch_target,
                    profile_id,
                    session,
                    connected_origin,
                    novels_profile_id,
                )
                .await?;
                continue;
            }
        };
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
                &asset_endpoint,
                true,
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
            &asset_endpoint,
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
    let asset_endpoint = BookAssetEndpoint::new(
        insecure_local_syncd_client()?,
        &authority.local_base_url,
        &authority.access_token,
    );
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
            snapshot
                .comics_scope_checkpoint
                .as_ref()
                .map(|checkpoint| checkpoint.last_applied_server_version)
                .unwrap_or_default(),
        ]
        .into_iter()
        .min()
        .unwrap_or_default();
        let changes = match fetch_changes_local_authority(authority, since_version).await? {
            ChangesFetchOutcome::Changes(changes) => changes,
            ChangesFetchOutcome::ReplayWindowExpired => {
                recover_from_snapshots_local_authority(app, &launch_target, profile_id, authority)
                    .await?;
                continue;
            }
        };
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
                &asset_endpoint,
                false,
            )
            .await?;
        }
        let _ = update_profile_state(profile_id, |profile| {
            profile.replication_status = SyncdReplicationStatus::Live;
            profile.last_connected_at_ms = Some(now_ms());
            profile.last_error = None;
        });
        let _ = emit_replication_state_for_profile(app, profile_id).await;
        match stream_live_events_local_authority(
            app,
            &launch_target,
            profile_id,
            authority,
            &asset_endpoint,
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

async fn fetch_changes_remote(
    session: &PersistedSyncSession,
    origin: &str,
    since_version: i64,
) -> Result<ChangesFetchOutcome, String> {
    let client = build_pinned_http_client(&session.tls_cert_sha256)?;
    let response = client
        .get(format!("{origin}/v1/changes"))
        .query(&[("sinceVersion", since_version)])
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header(CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(LEGACY_CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(
            CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .header(
            LEGACY_CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        return response
            .json()
            .await
            .map(ChangesFetchOutcome::Changes)
            .map_err(|error| error.to_string());
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<ErrorBody>(&body)
        .ok()
        .map(|body| body.error);
    if let Some(detail) = detail {
        if detail.code == "REPLAY_WINDOW_EXPIRED" {
            return Ok(ChangesFetchOutcome::ReplayWindowExpired);
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
) -> Result<ChangesFetchOutcome, String> {
    let client = insecure_local_syncd_client()?;
    let response = client
        .get(format!("{}/v1/changes", authority.local_base_url))
        .query(&[("sinceVersion", since_version)])
        .header(
            "Authorization",
            format!("Bearer {}", authority.access_token),
        )
        .header(CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(LEGACY_CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(
            CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .header(
            LEGACY_CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        return response
            .json()
            .await
            .map(ChangesFetchOutcome::Changes)
            .map_err(|error| error.to_string());
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<ErrorBody>(&body)
        .ok()
        .map(|body| body.error);
    if let Some(detail) = detail {
        if detail.code == "REPLAY_WINDOW_EXPIRED" {
            return Ok(ChangesFetchOutcome::ReplayWindowExpired);
        }
        if detail.code == "UNAUTHORIZED" {
            return Err("needs_reauth".to_string());
        }
        return Err(detail.message);
    }
    Err(format!("Changes replay failed with HTTP {status}."))
}

async fn fetch_authoritative_snapshot(
    client: &reqwest::Client,
    origin: &str,
    access_token: &str,
    scope_id: &str,
) -> Result<SnapshotResponse, String> {
    let response = client
        .get(format!("{origin}/v1/snapshot"))
        .query(&[("scopeId", scope_id)])
        .header("Authorization", format!("Bearer {access_token}"))
        .header(CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(LEGACY_CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(
            CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .header(
            LEGACY_CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        let snapshot = response
            .json::<SnapshotResponse>()
            .await
            .map_err(|error| format!("Invalid snapshot response for {scope_id}: {error}"))?;
        validate_snapshot(&snapshot, scope_id)?;
        return Ok(snapshot);
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if let Ok(error_body) = serde_json::from_str::<ErrorBody>(&body) {
        if error_body.error.code == "UNAUTHORIZED" {
            return Err("needs_reauth".to_string());
        }
        return Err(error_body.error.message);
    }
    Err(format!(
        "Authoritative snapshot failed for {scope_id} with HTTP {status}."
    ))
}

fn validate_snapshot(snapshot: &SnapshotResponse, expected_scope_id: &str) -> Result<(), String> {
    if !(MIN_SUPPORTED_SNAPSHOT_SCHEMA_VERSION..=SNAPSHOT_SCHEMA_VERSION)
        .contains(&snapshot.schema_version)
    {
        return Err(format!(
            "Unsupported snapshot schema {} for {expected_scope_id}; supported range is {}..={}.",
            snapshot.schema_version, MIN_SUPPORTED_SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_SCHEMA_VERSION
        ));
    }
    if snapshot.scope_id != expected_scope_id {
        return Err(format!(
            "Snapshot scope mismatch: expected {expected_scope_id}, received {}.",
            snapshot.scope_id
        ));
    }
    if snapshot.snapshot_version < 0
        || snapshot.min_replayable_server_version < 0
        || snapshot.snapshot_version < snapshot.min_replayable_server_version
    {
        return Err(format!(
            "Snapshot checkpoint is invalid for {expected_scope_id}."
        ));
    }
    if snapshot.schema_version >= 3 {
        if snapshot.complete != Some(true) {
            return Err(format!(
                "Snapshot is not declared complete for {expected_scope_id}."
            ));
        }
        if snapshot
            .snapshot_id
            .as_deref()
            .is_none_or(|snapshot_id| snapshot_id.is_empty() || snapshot_id.len() > 128)
        {
            return Err(format!(
                "Snapshot identity is invalid for {expected_scope_id}."
            ));
        }
        if snapshot.entity_count != Some(snapshot.entities.len())
            || snapshot.tombstone_count != Some(snapshot.tombstones.len())
        {
            return Err(format!(
                "Snapshot counts do not match its payload for {expected_scope_id}."
            ));
        }
    }
    Ok(())
}

fn materialize_book_snapshot(
    current: &PersistedBookLibraryState,
    snapshot: &SnapshotResponse,
) -> Result<PersistedBookLibraryState, String> {
    validate_snapshot(snapshot, BOOKS_SCOPE_ID)?;
    let mut next = PersistedBookLibraryState {
        version: current.version,
        ..PersistedBookLibraryState::default()
    };
    for entity in &snapshot.entities {
        match entity.entity_type.as_str() {
            "book.entry" => {
                let record = serde_json::from_value::<BookEntryRecord>(entity.record.clone())
                    .map_err(|error| error.to_string())?;
                let local_asset_path = current
                    .books
                    .iter()
                    .find(|entry| {
                        book_entry_entity_id(entry).as_deref() == Some(record.book_id.as_str())
                            || canonical_book_id_for_entry(entry).as_deref()
                                == Some(record.book_id.as_str())
                    })
                    .and_then(|entry| value_string_field(entry, "assetPath"));
                upsert_book_entry(&mut next, record, local_asset_path);
            }
            "book.category" => upsert_book_category(
                &mut next,
                serde_json::from_value::<BookCategoryRecord>(entity.record.clone())
                    .map_err(|error| error.to_string())?,
            ),
            "book.category_assignment" => upsert_book_category_assignment(
                &mut next,
                serde_json::from_value::<BookCategoryAssignmentRecord>(entity.record.clone())
                    .map_err(|error| error.to_string())?,
            ),
            "book.library_ui" => upsert_book_library_ui(
                &mut next,
                serde_json::from_value::<BookLibraryUiRecord>(entity.record.clone())
                    .map_err(|error| error.to_string())?,
            ),
            "book.progress" => upsert_book_progress(
                &mut next,
                serde_json::from_value::<BookProgressRecord>(entity.record.clone())
                    .map_err(|error| error.to_string())?,
            ),
            "book.history" => upsert_book_history(
                &mut next,
                serde_json::from_value::<BookHistoryRecord>(entity.record.clone())
                    .map_err(|error| error.to_string())?,
            ),
            "book.bookmark" => upsert_book_bookmark(
                &mut next,
                serde_json::from_value::<BookBookmarkRecord>(entity.record.clone())
                    .map_err(|error| error.to_string())?,
            ),
            "book.highlight" => upsert_book_highlight(
                &mut next,
                serde_json::from_value::<BookHighlightRecord>(entity.record.clone())
                    .map_err(|error| error.to_string())?,
            ),
            other => return Err(format!("Unsupported book snapshot entity: {other}.")),
        }
    }
    next.updated_at_ms = Some(now_ms());
    Ok(next)
}

fn materialize_novel_snapshot(
    current: &PersistedNovelLibraryState,
    current_classification: &PersistedNovelSourceClassificationState,
    snapshot: &SnapshotResponse,
) -> Result<
    (
        PersistedNovelLibraryState,
        PersistedNovelSourceClassificationState,
    ),
    String,
> {
    let mut next = PersistedNovelLibraryState {
        version: current.version,
        scope_key: current.scope_key.clone(),
        ..PersistedNovelLibraryState::default()
    };
    let mut next_classification = PersistedNovelSourceClassificationState {
        version: current_classification.version,
        scope_key: current_classification.scope_key.clone(),
        ..PersistedNovelSourceClassificationState::default()
    };
    for entity in &snapshot.entities {
        match entity.entity_type.as_str() {
            "novel.entry" => upsert_novel_entry(
                &mut next,
                serde_json::from_value::<NovelEntryRecord>(entity.record.clone())
                    .map_err(|error| error.to_string())?,
            ),
            "novel.chapter" => upsert_novel_chapter(
                &mut next,
                serde_json::from_value::<NovelChapterRecord>(entity.record.clone())
                    .map_err(|error| error.to_string())?,
            ),
            "novel.progress" => upsert_novel_progress(
                &mut next,
                serde_json::from_value::<NovelProgressRecord>(entity.record.clone())
                    .map_err(|error| error.to_string())?,
            ),
            "novel.bookmark" => upsert_novel_bookmark(
                &mut next,
                serde_json::from_value::<NovelBookmarkRecord>(entity.record.clone())
                    .map_err(|error| error.to_string())?,
            ),
            "novel.history" => upsert_novel_history(
                &mut next,
                serde_json::from_value::<NovelHistoryRecord>(entity.record.clone())
                    .map_err(|error| error.to_string())?,
            ),
            "novel.classification" => upsert_novel_classification(
                &mut next_classification,
                serde_json::from_value::<NovelClassificationRecord>(entity.record.clone())
                    .map_err(|error| error.to_string())?,
            ),
            // Executable plugin state is reconciled from the LNReader repository file, never
            // materialized from Syncd into the desktop runtime.
            "novel.repository" | "novel.plugin" => {}
            other => return Err(format!("Unsupported novel snapshot entity: {other}.")),
        }
    }
    next.updated_at_ms = Some(now_ms());
    next_classification.updated_at_ms = Some(now_ms());
    Ok((next, next_classification))
}

fn comic_snapshot_changes(
    snapshot: &SnapshotResponse,
    remote_profile_id: &str,
) -> Result<Vec<ChangeEnvelope>, String> {
    let expected_scope = comics_scope_id(remote_profile_id);
    validate_snapshot(snapshot, &expected_scope)?;
    let mut changes = Vec::with_capacity(snapshot.entities.len() + snapshot.tombstones.len());
    for entity in &snapshot.entities {
        if !matches!(
            entity.entity_type.as_str(),
            "comic.entry"
                | "comic.category"
                | "comic.category_assignment"
                | "comic.chapter_state"
                | "comic.history"
                | "comic.page_bookmark"
        ) {
            return Err(format!(
                "Unsupported comic snapshot entity: {}.",
                entity.entity_type
            ));
        }
        if !matches!(
            entity.entity_type.as_str(),
            "comic.history" | "comic.page_bookmark"
        ) {
            continue;
        }
        changes.push(ChangeEnvelope {
            server_version: entity.server_version,
            scope_id: snapshot.scope_id.clone(),
            profile_id: Some(remote_profile_id.to_string()),
            entity_type: entity.entity_type.clone(),
            entity_id: entity.entity_id.clone(),
            op: "merge".to_string(),
            lamport: entity.lamport,
            patch: Some(entity.record.clone()),
            applied_at_ms: now_ms(),
        });
    }
    for tombstone in &snapshot.tombstones {
        if !matches!(
            tombstone.entity_type.as_str(),
            "comic.entry"
                | "comic.category"
                | "comic.category_assignment"
                | "comic.chapter_state"
                | "comic.history"
                | "comic.page_bookmark"
        ) {
            return Err(format!(
                "Unsupported comic snapshot tombstone: {}.",
                tombstone.entity_type
            ));
        }
        if !matches!(
            tombstone.entity_type.as_str(),
            "comic.history" | "comic.page_bookmark"
        ) {
            continue;
        }
        changes.push(ChangeEnvelope {
            server_version: tombstone.server_version,
            scope_id: snapshot.scope_id.clone(),
            profile_id: Some(remote_profile_id.to_string()),
            entity_type: tombstone.entity_type.clone(),
            entity_id: tombstone.entity_id.clone(),
            op: "delete".to_string(),
            lamport: tombstone.lamport,
            patch: None,
            applied_at_ms: tombstone.deleted_at_ms,
        });
    }
    changes.sort_by(|left, right| {
        left.server_version
            .cmp(&right.server_version)
            .then_with(|| left.entity_type.cmp(&right.entity_type))
            .then_with(|| left.entity_id.cmp(&right.entity_id))
    });
    Ok(changes)
}

fn snapshot_checkpoint(snapshot: &SnapshotResponse) -> SyncdReplicationScopeCheckpoint {
    SyncdReplicationScopeCheckpoint {
        scope_id: snapshot.scope_id.clone(),
        last_applied_server_version: snapshot.snapshot_version,
        min_replayable_seen: snapshot.min_replayable_server_version,
        last_replay_mode: SyncdReplicationReplayMode::RecoveryReplay,
        last_applied_at_ms: now_ms(),
    }
}

fn stage_snapshot_recovery(
    profile: &mut PersistedReplicationProfileState,
    books_snapshot: &SnapshotResponse,
    novels_snapshot: &SnapshotResponse,
    comics_snapshot: &SnapshotResponse,
    comic_changes: &[ChangeEnvelope],
    stage_comic_reader_inbox: bool,
) -> Option<SyncdComicReaderSnapshotMarker> {
    let recovered_scopes = [
        books_snapshot.scope_id.clone(),
        novels_snapshot.scope_id.clone(),
        comics_snapshot.scope_id.clone(),
    ];
    profile.per_entity_remote_clock.retain(|key, _| {
        !recovered_scopes
            .iter()
            .any(|scope_id| key.starts_with(&format!("{scope_id}::")))
    });
    for snapshot in [books_snapshot, novels_snapshot, comics_snapshot] {
        for entity in &snapshot.entities {
            profile.per_entity_remote_clock.insert(
                remote_clock_key(&snapshot.scope_id, &entity.entity_type, &entity.entity_id),
                entity.lamport,
            );
        }
        for tombstone in &snapshot.tombstones {
            profile.per_entity_remote_clock.insert(
                remote_clock_key(
                    &snapshot.scope_id,
                    &tombstone.entity_type,
                    &tombstone.entity_id,
                ),
                tombstone.lamport,
            );
        }
    }
    profile
        .pending_comic_reader_changes
        .retain(|change| change.scope_id != comics_snapshot.scope_id);
    let comic_marker = if stage_comic_reader_inbox {
        profile
            .pending_comic_reader_changes
            .extend(comic_changes.iter().cloned());
        compact_pending_comic_reader_changes(&mut profile.pending_comic_reader_changes);
        Some(SyncdComicReaderSnapshotMarker {
            scope_id: comics_snapshot.scope_id.clone(),
            snapshot_version: comics_snapshot.snapshot_version,
        })
    } else {
        None
    };
    // The durable inbox and its reset marker are staged before checkpoints.
    // save_replication_state atomically publishes this complete profile state.
    profile.pending_comic_reader_snapshot = comic_marker.clone();
    profile.books_scope_checkpoint = Some(snapshot_checkpoint(books_snapshot));
    profile.novels_scope_checkpoint = Some(snapshot_checkpoint(novels_snapshot));
    profile.comics_scope_checkpoint = Some(snapshot_checkpoint(comics_snapshot));
    profile.last_applied_scopes = recovered_scopes.into_iter().collect();
    profile.last_applied_at_ms = Some(now_ms());
    profile.last_connected_at_ms = Some(now_ms());
    profile.last_error = None;
    comic_marker
}

async fn apply_authoritative_snapshots(
    app: &AppHandle,
    launch_target: &LaunchTargetInfo,
    local_profile_id: &str,
    remote_profile_id: &str,
    books_snapshot: SnapshotResponse,
    novels_snapshot: SnapshotResponse,
    comics_snapshot: SnapshotResponse,
    asset_endpoint: &BookAssetEndpoint,
    stage_comic_reader_inbox: bool,
) -> Result<(), String> {
    validate_snapshot(&books_snapshot, BOOKS_SCOPE_ID)?;
    validate_snapshot(&novels_snapshot, &novels_scope_id(remote_profile_id))?;
    validate_snapshot(&comics_snapshot, &comics_scope_id(remote_profile_id))?;

    let mut books_state = materialize_book_snapshot(&read_books_state()?, &books_snapshot)?;
    materialize_snapshot_book_assets(asset_endpoint, &mut books_state, &books_snapshot).await?;
    let (novels_state, classification_state) = materialize_novel_snapshot(
        &read_novels_state(launch_target, local_profile_id)?,
        &read_novel_classification_state(launch_target, local_profile_id)?,
        &novels_snapshot,
    )?;
    let comic_changes = comic_snapshot_changes(&comics_snapshot, remote_profile_id)?;

    // Scope files are replaced before their checkpoints. A failed write leaves
    // the old checkpoint in place, so the authoritative recovery is retried.
    write_books_state(&books_state)?;
    write_novels_state(launch_target, local_profile_id, &novels_state)?;
    write_novel_classification_state(launch_target, local_profile_id, &classification_state)?;

    let mut replication = load_replication_state()?;
    let profile = profile_state_mut(&mut replication, local_profile_id);
    let comic_marker = stage_snapshot_recovery(
        profile,
        &books_snapshot,
        &novels_snapshot,
        &comics_snapshot,
        &comic_changes,
        stage_comic_reader_inbox,
    );
    save_replication_state(&replication)?;

    let _ = emit_replication_state_for_profile(app, local_profile_id).await;
    if stage_comic_reader_inbox {
        let _ = app.emit(
            EVENT_COMIC_READER_STATE_APPLIED,
            SyncdComicReaderStateAppliedPayload {
                local_profile_id: local_profile_id.to_string(),
                changes: comic_changes,
                authoritative_snapshot: comic_marker,
            },
        );
    }
    Ok(())
}

async fn recover_from_snapshots_remote(
    app: &AppHandle,
    launch_target: &LaunchTargetInfo,
    local_profile_id: &str,
    session: &PersistedSyncSession,
    origin: &str,
    remote_profile_id: &str,
) -> Result<(), String> {
    let client = build_pinned_http_client(&session.tls_cert_sha256)?;
    let books =
        fetch_authoritative_snapshot(&client, origin, &session.access_token, BOOKS_SCOPE_ID)
            .await?;
    let novels_scope = novels_scope_id(remote_profile_id);
    let novels =
        fetch_authoritative_snapshot(&client, origin, &session.access_token, &novels_scope).await?;
    let comics_scope = comics_scope_id(remote_profile_id);
    let comics =
        fetch_authoritative_snapshot(&client, origin, &session.access_token, &comics_scope).await?;
    let asset_endpoint = BookAssetEndpoint::new(client, origin, &session.access_token);
    apply_authoritative_snapshots(
        app,
        launch_target,
        local_profile_id,
        remote_profile_id,
        books,
        novels,
        comics,
        &asset_endpoint,
        true,
    )
    .await
}

async fn recover_from_snapshots_local_authority(
    app: &AppHandle,
    launch_target: &LaunchTargetInfo,
    local_profile_id: &str,
    authority: &LocalAuthoritySession,
) -> Result<(), String> {
    let client = insecure_local_syncd_client()?;
    let books = fetch_authoritative_snapshot(
        &client,
        &authority.local_base_url,
        &authority.access_token,
        BOOKS_SCOPE_ID,
    )
    .await?;
    let novels_scope = novels_scope_id(&authority.profile_id);
    let novels = fetch_authoritative_snapshot(
        &client,
        &authority.local_base_url,
        &authority.access_token,
        &novels_scope,
    )
    .await?;
    let comics_scope = comics_scope_id(&authority.profile_id);
    let comics = fetch_authoritative_snapshot(
        &client,
        &authority.local_base_url,
        &authority.access_token,
        &comics_scope,
    )
    .await?;
    let asset_endpoint =
        BookAssetEndpoint::new(client, &authority.local_base_url, &authority.access_token);
    apply_authoritative_snapshots(
        app,
        launch_target,
        local_profile_id,
        &authority.profile_id,
        books,
        novels,
        comics,
        &asset_endpoint,
        false,
    )
    .await
}

async fn stream_live_events(
    app: &AppHandle,
    launch_target: &LaunchTargetInfo,
    profile_id: &str,
    session: &PersistedSyncSession,
    origin: &str,
    novels_profile_id: &str,
    asset_endpoint: &BookAssetEndpoint,
) -> Result<StreamExit, String> {
    let client = build_pinned_http_client(&session.tls_cert_sha256)?;
    let response = client
        .get(format!("{origin}/v1/events"))
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header(CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(LEGACY_CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(
            CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .header(
            LEGACY_CLIENT_PROTOCOL_HEADER.as_str(),
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
                            asset_endpoint,
                            true,
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
    asset_endpoint: &BookAssetEndpoint,
) -> Result<StreamExit, String> {
    let client = insecure_local_syncd_client()?;
    let response = client
        .get(format!("{}/v1/events", authority.local_base_url))
        .header(
            "Authorization",
            format!("Bearer {}", authority.access_token),
        )
        .header(CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(LEGACY_CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(
            CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .header(
            LEGACY_CLIENT_PROTOCOL_HEADER.as_str(),
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
                            asset_endpoint,
                            false,
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
    asset_endpoint: &BookAssetEndpoint,
    stage_comic_reader_inbox: bool,
) -> Result<(), String> {
    if envelopes.is_empty() {
        return Ok(());
    }
    let mut books_state = read_books_state()?;
    let mut novels_state = read_novels_state(launch_target, profile_id)?;
    let mut classification_state = read_novel_classification_state(launch_target, profile_id)?;
    let novels_scope = novels_scope_id(novels_profile_id);
    let comics_scope = comics_scope_id(novels_profile_id);
    let mut outcome = RemoteApplyOutcome::default();
    let mut replication = load_replication_state()?;
    let profile = profile_state_mut(&mut replication, profile_id);
    let cleared_hosted_comic_reader_inbox = if stage_comic_reader_inbox {
        false
    } else {
        let had_pending = !profile.pending_comic_reader_changes.is_empty()
            || profile.pending_comic_reader_snapshot.is_some();
        profile.pending_comic_reader_changes.clear();
        profile.pending_comic_reader_snapshot = None;
        had_pending
    };

    let mut ordered = envelopes.to_vec();
    ordered.sort_by_key(|envelope| envelope.server_version);
    for envelope in ordered {
        let checkpoint = if envelope.scope_id == BOOKS_SCOPE_ID {
            &mut profile.books_scope_checkpoint
        } else if envelope.scope_id == novels_scope {
            &mut profile.novels_scope_checkpoint
        } else if envelope.scope_id == comics_scope {
            &mut profile.comics_scope_checkpoint
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
                    let asset_path =
                        materialize_book_entry_asset(asset_endpoint, &books_state, &record).await?;
                    upsert_book_entry(&mut books_state, record, asset_path);
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
            "book.history" => {
                replication_log(format!(
                    "apply_remote_envelope profile_id={} scope={} entity_type=book.history entity_id={} server_version={} op={:?}",
                    profile_id,
                    envelope.scope_id,
                    envelope.entity_id,
                    envelope.server_version,
                    envelope.op
                ));
                if let Some(patch) = envelope.patch.clone() {
                    let record = serde_json::from_value::<BookHistoryRecord>(patch)
                        .map_err(|error| error.to_string())?;
                    upsert_book_history(&mut books_state, record);
                } else {
                    delete_book_history(&mut books_state, &envelope.entity_id);
                }
                outcome.books_changed = true;
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
            "book.highlight" => {
                if let Some(patch) = envelope.patch.clone() {
                    let record = serde_json::from_value::<BookHighlightRecord>(patch)
                        .map_err(|error| error.to_string())?;
                    upsert_book_highlight(&mut books_state, record);
                } else {
                    delete_book_highlight(&mut books_state, &envelope.entity_id);
                }
                outcome.books_changed = true;
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
            // Syncd carries dependency evidence only. The desktop remains bound to its local
            // LNReader repository manager and does not install executable bytes from replay.
            "novel.repository" | "novel.plugin" => {}
            "comic.history" | "comic.page_bookmark" => {
                if stage_comic_reader_inbox {
                    outcome.comic_reader_changes.push(envelope.clone());
                }
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
    if !outcome.comic_reader_changes.is_empty() {
        profile
            .pending_comic_reader_changes
            .extend(outcome.comic_reader_changes.iter().cloned());
        compact_pending_comic_reader_changes(&mut profile.pending_comic_reader_changes);
    }
    if !outcome.applied_scopes.is_empty() || cleared_hosted_comic_reader_inbox {
        profile.last_applied_scopes = outcome.applied_scopes.iter().cloned().collect();
        profile.last_applied_at_ms = Some(now_ms());
        profile.last_connected_at_ms = Some(now_ms());
        profile.last_error = None;
        save_replication_state(&replication)?;
        let _ = emit_replication_state_for_profile(app, profile_id).await;
    }
    if !outcome.comic_reader_changes.is_empty() {
        let _ = app.emit(
            EVENT_COMIC_READER_STATE_APPLIED,
            SyncdComicReaderStateAppliedPayload {
                local_profile_id: profile_id.to_string(),
                changes: outcome.comic_reader_changes,
                authoritative_snapshot: None,
            },
        );
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
    let next_value =
        serde_json::from_str::<Value>(next_contents).map_err(|error| error.to_string())?;
    let frontend_included_history = next_value.get("bookHistory").is_some();
    let frontend_included_highlights = next_value.get("bookHighlights").is_some();
    let mut next = serde_json::from_value::<PersistedBookLibraryState>(next_value)
        .map_err(|error| error.to_string())?;
    if !frontend_included_history {
        next.book_history = previous.book_history.clone();
    }
    if !frontend_included_highlights {
        next.book_highlights = previous.book_highlights.clone();
    }
    let asset_metadata_changed = enrich_book_asset_metadata(&previous, &mut next)?;
    let cover_assets_changed = enrich_book_cover_assets(&previous, &mut next).await?;
    let projected_history_changed = project_latest_book_history(&previous, &mut next);
    if !frontend_included_history
        || projected_history_changed
        || asset_metadata_changed
        || cover_assets_changed
    {
        // Keep the Rust-owned history collection in the canonical JSON even
        // while the current frontend is unaware of that field. This write does
        // not call the Tauri command again, so it cannot recurse.
        write_books_state(&next)?;
    }
    let diff = diff_book_mutations(&previous, &next);
    replication_log(format!(
        "notify_book_state_written prev_progress={} next_progress={} prev_bookmarks={} next_bookmarks={} prev_history={} next_history={} diff_count={} diff=[{}]",
        previous.book_progress.len(),
        next.book_progress.len(),
        previous.book_bookmarks.len(),
        next.book_bookmarks.len(),
        previous.book_history.len(),
        next.book_history.len(),
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

pub async fn notify_novel_repository_state_written(
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
        .map(serde_json::from_str::<PersistedNovelRepositoryState>)
        .transpose()
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    let next = serde_json::from_str::<PersistedNovelRepositoryState>(next_contents)
        .map_err(|error| error.to_string())?;
    let diff = diff_novel_dependency_mutations(profile_id, &previous, &next);
    if diff.is_empty() {
        return Ok(());
    }
    submit_mutations_for_active_profiles(app, Some(profile_id), diff).await
}

async fn publish_current_novel_repository_state(
    app: &AppHandle,
    profile_id: &str,
) -> Result<(), String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let current = read_novel_repository_state(&launch_target, profile_id)?;
    let payload = serde_json::to_string(&current).map_err(|error| error.to_string())?;
    notify_novel_repository_state_written(app, Some(profile_id), None, &payload).await
}

fn serialized_state_digest<T: Serialize>(state: &T) -> Result<String, String> {
    serde_json::to_string(state)
        .map(|payload| hash_digest(&payload))
        .map_err(|error| error.to_string())
}

async fn publish_current_novel_library_state(
    app: &AppHandle,
    profile_id: &str,
) -> Result<(), String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let current = read_novels_state(&launch_target, profile_id)?;
    let digest = serialized_state_digest(&current)?;
    let already_published = load_replication_state()?
        .profiles
        .get(profile_id)
        .and_then(|profile| profile.last_local_snapshot_digest_novels.as_deref())
        == Some(digest.as_str());
    if already_published {
        return Ok(());
    }

    let mutations =
        diff_novel_mutations(profile_id, &PersistedNovelLibraryState::default(), &current);
    submit_mutations_for_active_profiles(app, Some(profile_id), mutations).await?;
    update_profile_state(profile_id, |profile| {
        profile.last_local_snapshot_digest_novels = Some(digest.clone());
    })?;
    Ok(())
}

async fn publish_current_book_library_state(
    app: &AppHandle,
    profile_id: &str,
) -> Result<(), String> {
    let mut current = read_books_state()?;
    let empty = PersistedBookLibraryState::default();
    let asset_metadata_changed = enrich_book_asset_metadata(&empty, &mut current)?;
    let cover_assets_changed = enrich_book_cover_assets(&empty, &mut current).await?;
    let projected_history_changed = project_latest_book_history(&empty, &mut current);
    if asset_metadata_changed || cover_assets_changed || projected_history_changed {
        write_books_state(&current)?;
    }
    let digest = serialized_state_digest(&current)?;
    let already_published = load_replication_state()?
        .profiles
        .get(profile_id)
        .and_then(|profile| profile.last_local_snapshot_digest_books.as_deref())
        == Some(digest.as_str());
    if already_published {
        return Ok(());
    }

    let mutations = diff_book_mutations(&empty, &current);
    submit_mutations_for_active_profiles(app, Some(profile_id), mutations).await?;
    update_profile_state(profile_id, |profile| {
        profile.last_local_snapshot_digest_books = Some(digest.clone());
    })?;
    Ok(())
}

async fn remote_profile_id_for_local_profile(
    app: &AppHandle,
    local_profile_id: &str,
) -> Result<String, String> {
    let local_authority_profile_id = {
        let state = app.state::<SyncdReplicationState>();
        let runtime = state.runtime.lock().await;
        runtime
            .local_authority
            .get(local_profile_id)
            .map(|authority| authority.profile_id.clone())
    };
    if let Some(profile_id) = local_authority_profile_id {
        return Ok(profile_id);
    }

    let replication = load_replication_state()?;
    let active_session_key = replication
        .profiles
        .get(local_profile_id)
        .and_then(|profile| profile.active_session_key.as_deref())
        .ok_or_else(|| "No active Core sync session for this profile.".to_string())?;
    let desktop = load_persisted_state()?;
    desktop
        .sessions
        .iter()
        .find(|session| {
            session.local_profile_id == local_profile_id
                && session.session_key == active_session_key
        })
        .map(|session| session.remote_profile_id.clone())
        .ok_or_else(|| "The active Core sync session no longer exists locally.".to_string())
}

fn derive_comic_server_fingerprint(core_fingerprint: &str, remote_profile_id: &str) -> String {
    hash_digest(&format!(
        "{COMIC_SERVER_IDENTITY_DOMAIN}\0{}\0{remote_profile_id}",
        core_fingerprint.trim().to_ascii_lowercase()
    ))
}

fn local_core_runtime_fingerprint(app: &AppHandle) -> Result<String, String> {
    let runtime = crate::syncd_sidecar::current_runtime_info(app)
        .ok_or_else(|| "No hosted Core runtime is available.".to_string())?;
    let raw = fs::read_to_string(PathBuf::from(runtime.data_dir).join("runtime.json"))
        .map_err(|error| error.to_string())?;
    let manifest = serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?;
    manifest
        .get("fingerprint")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "Core runtime fingerprint is invalid.".to_string())
}

#[tauri::command]
pub async fn syncd_get_comic_server_fingerprint(
    app: AppHandle,
    profile_id: String,
) -> Result<String, String> {
    let profile_id = profile_id.trim();
    if profile_id.is_empty() || profile_id.contains('\0') {
        return Err("profileId is invalid.".to_string());
    }
    let authority_profile_id = {
        let state = app.state::<SyncdReplicationState>();
        let runtime = state.runtime.lock().await;
        runtime
            .local_authority
            .get(profile_id)
            .map(|authority| authority.profile_id.clone())
    };
    if let Some(authority_profile_id) = authority_profile_id {
        return Ok(derive_comic_server_fingerprint(
            &local_core_runtime_fingerprint(&app)?,
            &authority_profile_id,
        ));
    }

    let replication = load_replication_state()?;
    if let Some(active_session_key) = replication
        .profiles
        .get(profile_id)
        .and_then(|profile| profile.active_session_key.as_deref())
    {
        let desktop = load_persisted_state()?;
        if let Some(session) = desktop.sessions.iter().find(|session| {
            session.local_profile_id == profile_id && session.session_key == active_session_key
        }) {
            return Ok(derive_comic_server_fingerprint(
                &session.tls_cert_sha256,
                &session.remote_profile_id,
            ));
        }
    }
    Err("No paired Core identity is available for this profile.".to_string())
}

#[tauri::command]
pub async fn syncd_publish_comic_reader_mutation(
    app: AppHandle,
    input: SyncdPublishComicReaderMutationInput,
) -> Result<(), String> {
    let profile_id = input.profile_id.trim();
    if profile_id.is_empty() || profile_id.contains('\0') {
        return Err("profileId is invalid.".to_string());
    }
    let entity_id = input.entity_id.trim();
    if entity_id.is_empty() || entity_id.contains('\0') {
        return Err("entityId is invalid.".to_string());
    }
    let remote_profile_id = remote_profile_id_for_local_profile(&app, profile_id).await?;

    let patch = input.patch;
    let base = SerializableMutationBase {
        client_mutation_id: Uuid::now_v7().to_string(),
        scope_id: comics_scope_id(&remote_profile_id),
        entity_id: entity_id.to_string(),
        op: input.op.clone(),
        lamport: now_ms(),
    };
    let mutation = match input.entity_type.trim() {
        "comic.history" => SerializableMutationInput::ComicHistory {
            base,
            patch: match input.op {
                MutationOperation::Merge => Some(
                    serde_json::from_value::<ComicHistoryPatch>(
                        patch.ok_or_else(|| "comic.history merge requires patch.".to_string())?,
                    )
                    .map_err(|error| format!("Invalid comic.history patch: {error}"))?,
                ),
                MutationOperation::Delete => None,
            },
        },
        "comic.page_bookmark" => {
            SerializableMutationInput::ComicPageBookmark {
                base,
                patch: match input.op {
                    MutationOperation::Merge => Some(
                        serde_json::from_value::<ComicPageBookmarkPatch>(patch.ok_or_else(
                            || "comic.page_bookmark merge requires patch.".to_string(),
                        )?)
                        .map_err(|error| format!("Invalid comic.page_bookmark patch: {error}"))?,
                    ),
                    MutationOperation::Delete => None,
                },
            }
        }
        _ => return Err("Unsupported comic reader entityType.".to_string()),
    };

    submit_mutations_for_active_profiles(&app, Some(profile_id), vec![mutation]).await
}

#[tauri::command]
pub fn syncd_get_pending_comic_reader_changes(
    profile_id: String,
) -> Result<SyncdComicReaderStateAppliedPayload, String> {
    let profile_id = profile_id.trim();
    if profile_id.is_empty() || profile_id.contains('\0') {
        return Err("profileId is invalid.".to_string());
    }
    let replication = load_replication_state()?;
    let mut changes = replication
        .profiles
        .get(profile_id)
        .map(|profile| profile.pending_comic_reader_changes.clone())
        .unwrap_or_default();
    changes.sort_by_key(|change| change.server_version);
    Ok(SyncdComicReaderStateAppliedPayload {
        local_profile_id: profile_id.to_string(),
        changes,
        authoritative_snapshot: replication
            .profiles
            .get(profile_id)
            .and_then(|profile| profile.pending_comic_reader_snapshot.clone()),
    })
}

#[tauri::command]
pub fn syncd_ack_comic_reader_changes(
    input: SyncdAckComicReaderChangesInput,
) -> Result<(), String> {
    let profile_id = input.profile_id.trim();
    if profile_id.is_empty() || profile_id.contains('\0') {
        return Err("profileId is invalid.".to_string());
    }
    if input.through_server_version < 0 {
        return Err("throughServerVersion must be non-negative.".to_string());
    }
    let mut replication = load_replication_state()?;
    if let Some(profile) = replication.profiles.get_mut(profile_id) {
        profile
            .pending_comic_reader_changes
            .retain(|change| change.server_version > input.through_server_version);
        if profile
            .pending_comic_reader_snapshot
            .as_ref()
            .map(|marker| marker.snapshot_version <= input.through_server_version)
            .unwrap_or(false)
        {
            profile.pending_comic_reader_snapshot = None;
        }
        save_replication_state(&replication)?;
    }
    Ok(())
}

fn upsert_book_progress(state: &mut PersistedBookLibraryState, record: BookProgressRecord) {
    let local_book_id = local_book_id_for_canonical_id(state, &record.book_id);
    let canonical_book_id = strip_book_progress_entity_prefix(&record.book_id).to_string();
    let next = LocalBookProgress {
        book_id: local_book_id,
        location: record.location,
        href: record.href,
        progress_percent: record.progress_percent,
        last_read_at: record.last_read_at_ms,
        page_index: record.page_index,
        total_pages: record.total_pages,
        section_label: record.section_label,
        renderer: record.renderer,
    };
    state.book_progress.retain(|entry| {
        entry.book_id == next.book_id
            || strip_book_progress_entity_prefix(&entry.book_id) != canonical_book_id
    });
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

fn upsert_book_history(state: &mut PersistedBookLibraryState, record: BookHistoryRecord) {
    let local_book_id = local_book_id_for_canonical_id(state, &record.book_id);
    let next = LocalBookHistory {
        history_id: record.history_id,
        book_id: local_book_id,
        renderer: record.renderer,
        location: record.location,
        href: record.href,
        page_index: record.page_index,
        progress_percent: record.progress_percent,
        section_label: record.section_label,
        read_at_ms: record.read_at_ms,
    };
    if let Some(index) = state
        .book_history
        .iter()
        .position(|entry| entry.history_id == next.history_id)
    {
        state.book_history[index] = next;
    } else {
        state.book_history.push(next);
    }
}

fn delete_book_history(state: &mut PersistedBookLibraryState, history_id: &str) {
    state
        .book_history
        .retain(|entry| entry.history_id != history_id);
}

fn upsert_book_entry(
    state: &mut PersistedBookLibraryState,
    record: BookEntryRecord,
    materialized_asset_path: Option<String>,
) {
    let remote_book_id = record.book_id.clone();
    let existing = state.books.iter().find(|entry| {
        book_entry_entity_id(entry).as_deref() == Some(remote_book_id.as_str())
            || canonical_book_id_for_entry(entry).as_deref() == Some(remote_book_id.as_str())
    });
    let book_id = existing
        .and_then(book_entry_entity_id)
        .unwrap_or(remote_book_id);
    let preserved_asset_path = materialized_asset_path
        .or_else(|| existing.and_then(|entry| value_string_field(entry, "assetPath")));
    let preserved_import_path = existing
        .and_then(|entry| value_string_field(entry, "importPath"))
        .unwrap_or_default();
    let preserved_cover_path = existing
        .and_then(|entry| entry.get("coverPath").cloned())
        .unwrap_or(Value::Null);
    let preserved_cover_url = existing
        .and_then(|entry| entry.get("coverUrl").cloned())
        .unwrap_or(Value::Null);
    let next = json!({
        "id": book_id,
        "assetFingerprint": record.asset_fingerprint,
        "mimeType": record.mime_type,
        "byteSize": record.byte_size,
        "coverAssetSha256": record.cover_asset_sha256,
        "coverAssetByteSize": record.cover_asset_byte_size,
        "coverAssetMimeType": record.cover_asset_mime_type,
        "title": record.title,
        "author": record.author,
        "description": record.description,
        "coverPath": preserved_cover_path,
        "coverUrl": preserved_cover_url,
        "subtype": record.subtype,
        "pageCount": record.page_count,
        "createdAt": record.created_at_ms,
        "updatedAt": record.book_updated_at_ms,
        "importPath": preserved_import_path,
        "assetPath": preserved_asset_path.unwrap_or_default(),
        "tocCount": record.toc_count,
        "spineCount": record.spine_count,
        "sectionsSummary": record.sections_summary_json.unwrap_or_else(|| json!([])),
        "sectionCount": record.section_count,
        "hasCover": record.has_cover,
    });
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

async fn matching_local_asset_path(
    raw_path: Option<String>,
    expected_sha256: &str,
) -> Result<Option<String>, String> {
    let Some(raw_path) = raw_path.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(&raw_path);
    let Ok(metadata) = tokio::fs::metadata(&path).await else {
        return Ok(None);
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    if sha256_file_async(path).await? == expected_sha256 {
        Ok(Some(raw_path))
    } else {
        // The path belongs to the user/import library. Never overwrite or
        // delete it when a remote immutable asset has different bytes.
        Ok(None)
    }
}

async fn materialize_book_entry_asset(
    endpoint: &BookAssetEndpoint,
    state: &PersistedBookLibraryState,
    record: &BookEntryRecord,
) -> Result<Option<String>, String> {
    let Some(fingerprint) = record.asset_fingerprint.as_deref() else {
        return Ok(state
            .books
            .iter()
            .find(|entry| {
                book_entry_entity_id(entry).as_deref() == Some(record.book_id.as_str())
                    || canonical_book_id_for_entry(entry).as_deref()
                        == Some(record.book_id.as_str())
            })
            .and_then(|entry| value_string_field(entry, "assetPath")));
    };
    let fingerprint = validate_asset_sha256(fingerprint)?;
    let current_path = state
        .books
        .iter()
        .find(|entry| {
            book_entry_entity_id(entry).as_deref() == Some(record.book_id.as_str())
                || canonical_book_id_for_entry(entry).as_deref() == Some(record.book_id.as_str())
        })
        .and_then(|entry| value_string_field(entry, "assetPath"));
    if let Some(path) = matching_local_asset_path(current_path, &fingerprint).await? {
        return Ok(Some(path));
    }
    let path = download_book_asset(endpoint, &fingerprint, &record.subtype).await?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

async fn materialize_snapshot_book_assets(
    endpoint: &BookAssetEndpoint,
    state: &mut PersistedBookLibraryState,
    snapshot: &SnapshotResponse,
) -> Result<(), String> {
    for entity in &snapshot.entities {
        if entity.entity_type != "book.entry" {
            continue;
        }
        let record = serde_json::from_value::<BookEntryRecord>(entity.record.clone())
            .map_err(|error| error.to_string())?;
        let asset_path = materialize_book_entry_asset(endpoint, state, &record).await?;
        upsert_book_entry(state, record, asset_path);
    }
    Ok(())
}

fn delete_book_entry(state: &mut PersistedBookLibraryState, book_id: &str) {
    let local_book_id = local_book_id_for_canonical_id(state, book_id);
    state
        .books
        .retain(|entry| book_entry_entity_id(entry).as_deref() != Some(local_book_id.as_str()));
    state
        .book_progress
        .retain(|entry| entry.book_id != local_book_id);
    state
        .book_bookmarks
        .retain(|entry| entry.book_id != local_book_id);
    state
        .book_highlights
        .retain(|entry| entry.book_id != local_book_id);
    state.books_category_assignments.remove(&local_book_id);
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
    let local_book_id = local_book_id_for_canonical_id(state, &record.book_id);
    state
        .books_category_assignments
        .insert(local_book_id, record.category_ids);
}

fn delete_book_category_assignment(state: &mut PersistedBookLibraryState, book_id: &str) {
    let local_book_id = local_book_id_for_canonical_id(state, book_id);
    state.books_category_assignments.remove(&local_book_id);
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
    let local_book_id = local_book_id_for_canonical_id(state, &record.book_id);
    let next = LocalBookBookmark {
        bookmark_id: record.bookmark_id,
        book_id: local_book_id,
        location: record.location,
        href: record.href,
        page_index: record.page_index,
        progress_percent: record.progress_percent,
        label: record.label,
        note: record.note,
        created_at_ms: record.created_at_ms,
        updated_at_ms: record.updated_at_ms,
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

fn upsert_book_highlight(state: &mut PersistedBookLibraryState, record: BookHighlightRecord) {
    let local_book_id = local_book_id_for_canonical_id(state, &record.book_id);
    let next = LocalBookHighlight {
        highlight_id: record.highlight_id,
        book_id: local_book_id,
        start_locator_json: record.start_locator_json,
        end_locator_json: record.end_locator_json,
        selected_text: record.selected_text,
        color_argb: record.color_argb,
        note: record.note,
        created_at_ms: record.created_at_ms,
        updated_at_ms: record.updated_at_ms,
    };
    if let Some(index) = state
        .book_highlights
        .iter()
        .position(|entry| entry.highlight_id == next.highlight_id)
    {
        state.book_highlights[index] = next;
    } else {
        state.book_highlights.push(next);
    }
}

fn delete_book_highlight(state: &mut PersistedBookLibraryState, highlight_id: &str) {
    state
        .book_highlights
        .retain(|entry| entry.highlight_id != highlight_id);
}

fn delete_book_bookmark(state: &mut PersistedBookLibraryState, bookmark_id: &str) {
    state
        .book_bookmarks
        .retain(|entry| bookmark_entity_id_for_book(entry) != bookmark_id);
}

fn upsert_novel_progress(state: &mut PersistedNovelLibraryState, record: NovelProgressRecord) {
    let local_novel_id = record
        .portable_work_ref
        .as_ref()
        .and_then(|reference| local_novel_id_for_portable_ref(state, reference))
        .unwrap_or_else(|| record.novel_id.clone());
    let local_chapter_id = match (
        record.portable_chapter_ref.as_ref(),
        Some(local_novel_id.as_str()),
    ) {
        (Some(reference), Some(local_novel_id)) => {
            local_novel_chapter_id_for_portable_ref(state, local_novel_id, reference)
                .or_else(|| record.chapter_id.clone())
        }
        _ => record.chapter_id.clone(),
    };
    let next = LocalNovelProgress {
        novel_id: local_novel_id,
        chapter_id: local_chapter_id,
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
    let incoming_ref = portable_novel_work_ref(&record.source, &record.path);
    let local_novel_id = incoming_ref
        .as_ref()
        .and_then(|reference| local_novel_id_for_portable_ref(state, reference))
        .unwrap_or_else(|| record.novel_id.clone());
    let chapter_count = state
        .chapters
        .iter()
        .filter(|entry| {
            value_string_field(entry, "novelId").as_deref() == Some(local_novel_id.as_str())
        })
        .count() as i64;
    let next = json!({
        "id": local_novel_id,
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
    let local_novel_id = state
        .entries
        .iter()
        .find_map(|entry| {
            let reference = portable_novel_work_ref_from_entry(entry)?;
            (canonical_portable_work_id(&reference) == record.novel_id)
                .then(|| novel_entry_entity_id(entry))
                .flatten()
        })
        .unwrap_or_else(|| record.novel_id.clone());
    let local_chapter_id = state
        .chapters
        .iter()
        .find(|entry| {
            value_string_field(entry, "novelId").as_deref() == Some(local_novel_id.as_str())
                && value_string_field(entry, "path").as_deref() == Some(record.path.as_str())
        })
        .and_then(novel_chapter_entity_id)
        .unwrap_or_else(|| record.chapter_id.clone());
    let next = json!({
        "id": local_chapter_id,
        "novelId": local_novel_id,
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
    if !entry.bookmark_id.trim().is_empty() {
        return entry.bookmark_id.clone();
    }
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

fn book_history_entity_id(book_id: &str) -> String {
    format!("book.history::{book_id}")
}

fn book_renderer_for_progress(
    state: &PersistedBookLibraryState,
    progress: &LocalBookProgress,
) -> Option<String> {
    progress
        .renderer
        .as_deref()
        .filter(|renderer| matches!(*renderer, "epub" | "pdf"))
        .map(ToString::to_string)
        .or_else(|| {
            state.books.iter().find_map(|book| {
                (book_entry_entity_id(book).as_deref() == Some(progress.book_id.as_str()))
                    .then(|| value_string_field(book, "subtype"))
                    .flatten()
                    .filter(|renderer| matches!(renderer.as_str(), "epub" | "pdf"))
            })
        })
}

/// The desktop currently exposes only latest progress for imported books. Map
/// each changed progress record to one independently persisted latest-history
/// entry, leaving mobile session-level history entries untouched.
fn project_latest_book_history(
    previous: &PersistedBookLibraryState,
    next: &mut PersistedBookLibraryState,
) -> bool {
    let previous_progress = previous
        .book_progress
        .iter()
        .map(|entry| (entry.book_id.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let changed = next
        .book_progress
        .iter()
        .filter(|entry| previous_progress.get(entry.book_id.as_str()).copied() != Some(*entry))
        .cloned()
        .collect::<Vec<_>>();
    let mut projected = false;
    for progress in changed {
        let Some(renderer) = book_renderer_for_progress(next, &progress) else {
            continue;
        };
        let history = LocalBookHistory {
            history_id: book_history_entity_id(&progress.book_id),
            book_id: progress.book_id,
            renderer: Some(renderer),
            location: progress.location,
            href: progress.href,
            page_index: progress.page_index,
            progress_percent: progress.progress_percent,
            section_label: progress.section_label,
            read_at_ms: progress.last_read_at,
        };
        if let Some(index) = next
            .book_history
            .iter()
            .position(|entry| entry.history_id == history.history_id)
        {
            if next.book_history[index] != history {
                next.book_history[index] = history;
                projected = true;
            }
        } else {
            next.book_history.push(history);
            projected = true;
        }
    }
    projected
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

fn portable_novel_work_ref(source: &Value, novel_key: &str) -> Option<PortableWorkRefV3> {
    let plugin_id = value_string_field(source, "pluginId")?;
    let reference = PortableWorkRefV3::Novel {
        plugin_id,
        novel_key: novel_key.to_string(),
    };
    reference.validate().ok()?;
    Some(reference)
}

fn portable_novel_work_ref_from_entry(entry: &Value) -> Option<PortableWorkRefV3> {
    portable_novel_work_ref(entry.get("source")?, &value_string_field(entry, "path")?)
}

fn local_novel_id_for_portable_ref(
    state: &PersistedNovelLibraryState,
    reference: &PortableWorkRefV3,
) -> Option<String> {
    state.entries.iter().find_map(|entry| {
        (portable_novel_work_ref_from_entry(entry).as_ref() == Some(reference))
            .then(|| novel_entry_entity_id(entry))
            .flatten()
    })
}

fn local_novel_chapter_id_for_portable_ref(
    state: &PersistedNovelLibraryState,
    local_novel_id: &str,
    reference: &PortableChapterRefV3,
) -> Option<String> {
    let PortableChapterRefV3::Novel { chapter_key, .. } = reference else {
        return None;
    };
    state.chapters.iter().find_map(|entry| {
        (value_string_field(entry, "novelId").as_deref() == Some(local_novel_id)
            && value_string_field(entry, "path").as_deref() == Some(chapter_key.as_str()))
        .then(|| novel_chapter_entity_id(entry))
        .flatten()
    })
}

fn portable_novel_refs_for_progress(
    state: &PersistedNovelLibraryState,
    progress: &LocalNovelProgress,
) -> Option<(PortableWorkRefV3, PortableChapterRefV3)> {
    let entry = state.entries.iter().find(|entry| {
        novel_entry_entity_id(entry).as_deref() == Some(progress.novel_id.as_str())
    })?;
    let work = portable_novel_work_ref_from_entry(entry)?;
    let local_chapter_id = progress.chapter_id.as_deref()?;
    let chapter = state.chapters.iter().find(|chapter| {
        novel_chapter_entity_id(chapter).as_deref() == Some(local_chapter_id)
            && value_string_field(chapter, "novelId").as_deref() == Some(progress.novel_id.as_str())
    })?;
    let chapter_key = value_string_field(chapter, "path")?;
    let chapter_ref = PortableChapterRefV3::Novel {
        work: work.clone(),
        chapter_key,
    };
    chapter_ref.validate().ok()?;
    Some((work, chapter_ref))
}

fn canonical_book_id_for_entry(value: &Value) -> Option<String> {
    let subtype = value_string_field(value, "subtype")?
        .trim()
        .to_ascii_lowercase();
    if !matches!(subtype.as_str(), "epub" | "pdf") {
        return None;
    }
    let fingerprint = value_string_field(value, "assetFingerprint")?
        .trim()
        .to_ascii_lowercase();
    if fingerprint.len() != 64 || !fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("{subtype}:sha256:{fingerprint}"))
}

fn canonical_book_id_for_local_id(state: &PersistedBookLibraryState, book_id: &str) -> String {
    let book_id = strip_book_progress_entity_prefix(book_id);
    state
        .books
        .iter()
        .find(|entry| book_entry_entity_id(entry).as_deref() == Some(book_id))
        .and_then(canonical_book_id_for_entry)
        .unwrap_or_else(|| book_id.to_string())
}

fn local_book_id_for_canonical_id(state: &PersistedBookLibraryState, book_id: &str) -> String {
    let book_id = strip_book_progress_entity_prefix(book_id);
    state
        .books
        .iter()
        .find_map(|entry| {
            let local_id = book_entry_entity_id(entry)?;
            (local_id == book_id || canonical_book_id_for_entry(entry).as_deref() == Some(book_id))
                .then_some(local_id)
        })
        .unwrap_or_else(|| book_id.to_string())
}

fn strip_book_progress_entity_prefix(mut value: &str) -> &str {
    while let Some(book_id) = value.strip_prefix("book.progress::") {
        value = book_id;
    }
    value
}

#[allow(dead_code)]
fn build_book_entry_patch(value: &Value) -> Option<BookEntryPatch> {
    Some(BookEntryPatch {
        asset_fingerprint: value_string_field(value, "assetFingerprint"),
        mime_type: value_string_field(value, "mimeType"),
        byte_size: value_i64_field(value, "byteSize"),
        cover_asset_sha256: value_string_field(value, "coverAssetSha256"),
        cover_asset_byte_size: value_i64_field(value, "coverAssetByteSize"),
        cover_asset_mime_type: value_string_field(value, "coverAssetMimeType"),
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
    let path = value_string_field(value, "path")?;
    let source = value.get("source").cloned().unwrap_or(Value::Null);
    let mut patch = NovelEntryPatch {
        identity_key: value_string_field(value, "id")?,
        title: value_string_field(value, "title")?,
        author: value_string_field(value, "author"),
        description: value_string_field(value, "description"),
        cover_url: value_string_field(value, "coverUrl"),
        path: path.clone(),
        status: value_string_field(value, "status"),
        tags: value_string_array_field(value, "tags"),
        source: source.clone(),
        added_at_ms: value_i64_field(value, "addedAt").unwrap_or_else(now_ms),
        updated_at_ms: value_i64_field(value, "updatedAt").unwrap_or_else(now_ms),
        portable_work_ref: value
            .get("portableWorkRef")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .or_else(|| portable_novel_work_ref(&source, &path)),
    };
    if let Some(identity_key) = canonical_novel_identity_key(&patch) {
        patch.identity_key = identity_key;
    }
    Some(patch)
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
    let previous_entries: BTreeMap<String, BookEntryPatch> = previous
        .books
        .iter()
        .filter_map(|entry| {
            Some((
                canonical_book_id_for_entry(entry).or_else(|| book_entry_entity_id(entry))?,
                build_book_entry_patch(entry)?,
            ))
        })
        .collect();
    let next_entries: BTreeMap<String, BookEntryPatch> = next
        .books
        .iter()
        .filter_map(|entry| {
            Some((
                canonical_book_id_for_entry(entry).or_else(|| book_entry_entity_id(entry))?,
                build_book_entry_patch(entry)?,
            ))
        })
        .collect();
    for (book_id, patch) in &next_entries {
        let unchanged = previous_entries.get(book_id).is_some_and(|previous| {
            serde_json::to_value(previous).ok() == serde_json::to_value(patch).ok()
        });
        if unchanged {
            continue;
        }
        mutations.push(SerializableMutationInput::BookEntry {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: BOOKS_SCOPE_ID.to_string(),
                entity_id: book_id.clone(),
                op: MutationOperation::Merge,
                lamport: now_ms(),
            },
            patch: Some(patch.clone()),
        });
    }
    for book_id in previous_entries.keys() {
        if next_entries.contains_key(book_id) {
            continue;
        }
        mutations.push(SerializableMutationInput::BookEntry {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: BOOKS_SCOPE_ID.to_string(),
                entity_id: book_id.clone(),
                op: MutationOperation::Delete,
                lamport: now_ms(),
            },
            patch: None,
        });
    }
    let previous_progress: BTreeMap<String, LocalBookProgress> = previous
        .book_progress
        .iter()
        .cloned()
        .map(|mut entry| {
            let book_id = canonical_book_id_for_local_id(previous, &entry.book_id);
            entry.book_id = book_id.clone();
            (book_id, entry)
        })
        .collect();
    let next_progress: BTreeMap<String, LocalBookProgress> = next
        .book_progress
        .iter()
        .cloned()
        .map(|mut entry| {
            let book_id = canonical_book_id_for_local_id(next, &entry.book_id);
            entry.book_id = book_id.clone();
            (book_id, entry)
        })
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
                reset: false,
            },
        });
    }

    let previous_history: BTreeMap<String, LocalBookHistory> = previous
        .book_history
        .iter()
        .cloned()
        .map(|entry| (entry.history_id.clone(), entry))
        .collect();
    let next_history: BTreeMap<String, LocalBookHistory> = next
        .book_history
        .iter()
        .cloned()
        .map(|entry| (entry.history_id.clone(), entry))
        .collect();
    for (history_id, entry) in &next_history {
        if previous_history.get(history_id) == Some(entry) {
            continue;
        }
        let canonical_book_id = canonical_book_id_for_local_id(next, &entry.book_id);
        let canonical_history_id = if history_id == &format!("book.history::{}", entry.book_id) {
            format!("book.history::{canonical_book_id}")
        } else {
            history_id.clone()
        };
        if canonical_history_id != *history_id {
            mutations.push(SerializableMutationInput::BookHistory {
                base: SerializableMutationBase {
                    client_mutation_id: Uuid::now_v7().to_string(),
                    scope_id: BOOKS_SCOPE_ID.to_string(),
                    entity_id: history_id.clone(),
                    op: MutationOperation::Delete,
                    lamport: now_ms(),
                },
                patch: None,
            });
        }
        mutations.push(SerializableMutationInput::BookHistory {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: BOOKS_SCOPE_ID.to_string(),
                entity_id: canonical_history_id.clone(),
                op: MutationOperation::Merge,
                lamport: now_ms(),
            },
            patch: Some(BookHistoryPatch {
                history_id: canonical_history_id,
                book_id: canonical_book_id,
                renderer: entry.renderer.clone(),
                location: entry.location.clone(),
                href: entry.href.clone(),
                page_index: entry.page_index,
                progress_percent: entry.progress_percent,
                section_label: entry.section_label.clone(),
                read_at_ms: entry.read_at_ms,
            }),
        });
    }
    for history_id in previous_history.keys() {
        if next_history.contains_key(history_id) {
            continue;
        }
        mutations.push(SerializableMutationInput::BookHistory {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: BOOKS_SCOPE_ID.to_string(),
                entity_id: history_id.clone(),
                op: MutationOperation::Delete,
                lamport: now_ms(),
            },
            patch: None,
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
        let canonical_book_id = canonical_book_id_for_local_id(next, &entry.book_id);
        mutations.push(SerializableMutationInput::BookBookmark {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: BOOKS_SCOPE_ID.to_string(),
                entity_id: bookmark_id.clone(),
                op: MutationOperation::Merge,
                lamport: now_ms(),
            },
            patch: Some(BookBookmarkPatch {
                book_id: canonical_book_id,
                location: entry.location.clone(),
                href: entry.href.clone(),
                page_index: entry.page_index,
                progress_percent: entry.progress_percent,
                label: entry.label.clone(),
                note: entry.note.clone(),
                created_at_ms: if entry.created_at_ms > 0 {
                    entry.created_at_ms
                } else {
                    entry.saved_at
                },
                updated_at_ms: if entry.updated_at_ms > 0 {
                    entry.updated_at_ms
                } else {
                    entry.saved_at
                },
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
    // Publish library membership before progress/bookmarks. Mobile can then hydrate chapters
    // directly from the exact LNReader plugin and provider-owned work key.
    let previous_entries: BTreeMap<String, NovelEntryPatch> = previous
        .entries
        .iter()
        .filter_map(|entry| {
            let patch = build_novel_entry_patch(entry)?;
            Some((patch.identity_key.clone(), patch))
        })
        .collect();
    let next_entries: BTreeMap<String, NovelEntryPatch> = next
        .entries
        .iter()
        .filter_map(|entry| {
            let patch = build_novel_entry_patch(entry)?;
            Some((patch.identity_key.clone(), patch))
        })
        .collect();
    for (novel_id, patch) in &next_entries {
        let unchanged = previous_entries.get(novel_id).is_some_and(|previous| {
            serde_json::to_value(previous).ok() == serde_json::to_value(patch).ok()
        });
        if unchanged {
            continue;
        }
        mutations.push(SerializableMutationInput::NovelEntry {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: scope_id.clone(),
                entity_id: novel_id.clone(),
                op: MutationOperation::Merge,
                lamport: now_ms(),
            },
            patch: Some(patch.clone()),
        });
    }
    // Entry deletes are appended after dependent bookmark/progress changes below.
    let deleted_entries = previous_entries
        .keys()
        .filter(|novel_id| !next_entries.contains_key(*novel_id))
        .cloned()
        .collect::<Vec<_>>();
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
        let portable_refs = portable_novel_refs_for_progress(next, entry);
        let entity_novel_id = portable_refs
            .as_ref()
            .map(|(work, _)| canonical_portable_work_id(work))
            .unwrap_or_else(|| novel_id.clone());
        let chapter_id = portable_refs
            .as_ref()
            .map(|(_, chapter)| canonical_portable_chapter_id(chapter))
            .or_else(|| entry.chapter_id.clone());
        mutations.push(SerializableMutationInput::NovelProgress {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: scope_id.clone(),
                entity_id: format!("novel.progress::{entity_novel_id}"),
                op: MutationOperation::Merge,
                lamport: now_ms(),
            },
            patch: NovelProgressPatch {
                portable_work_ref: portable_refs.as_ref().map(|(work, _)| work.clone()),
                portable_chapter_ref: portable_refs.map(|(_, chapter)| chapter),
                chapter_id,
                chapter_title: entry.chapter_title.clone(),
                chapter_order_key: None,
                progress_percent: entry.progress_percent,
                locator: entry.locator.clone(),
                locator_sort_key: None,
                updated_at_ms: entry.updated_at,
                reset: false,
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
        let novel_id = next
            .entries
            .iter()
            .find(|candidate| {
                novel_entry_entity_id(candidate).as_deref() == Some(entry.novel_id.as_str())
            })
            .and_then(build_novel_entry_patch)
            .map(|patch| patch.identity_key)
            .unwrap_or_else(|| entry.novel_id.clone());
        mutations.push(SerializableMutationInput::NovelBookmark {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: scope_id.clone(),
                entity_id: bookmark_id.clone(),
                op: MutationOperation::Merge,
                lamport: now_ms(),
            },
            patch: Some(NovelBookmarkPatch {
                novel_id,
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
    let previous_history: BTreeMap<String, Value> = previous
        .history
        .iter()
        .filter_map(|entry| novel_history_entity_id(entry).map(|id| (id, entry.clone())))
        .collect();
    let next_history: BTreeMap<String, Value> = next
        .history
        .iter()
        .filter_map(|entry| novel_history_entity_id(entry).map(|id| (id, entry.clone())))
        .collect();
    for (history_id, entry) in &next_history {
        if previous_history.get(history_id) == Some(entry) {
            continue;
        }
        let Some(mut patch) = build_novel_history_patch(entry) else {
            continue;
        };
        patch.novel_id = next
            .entries
            .iter()
            .find(|candidate| {
                novel_entry_entity_id(candidate).as_deref() == Some(patch.novel_id.as_str())
            })
            .and_then(build_novel_entry_patch)
            .map(|entry| entry.identity_key)
            .unwrap_or(patch.novel_id);
        mutations.push(SerializableMutationInput::NovelHistory {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: scope_id.clone(),
                entity_id: history_id.clone(),
                op: MutationOperation::Merge,
                lamport: now_ms(),
            },
            patch: Some(patch),
        });
    }
    for history_id in previous_history.keys() {
        if next_history.contains_key(history_id) {
            continue;
        }
        mutations.push(SerializableMutationInput::NovelHistory {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: scope_id.clone(),
                entity_id: history_id.clone(),
                op: MutationOperation::Delete,
                lamport: now_ms(),
            },
            patch: None,
        });
    }
    deleted_entries.into_iter().for_each(|novel_id| {
        mutations.push(SerializableMutationInput::NovelEntry {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: scope_id.clone(),
                entity_id: novel_id,
                op: MutationOperation::Delete,
                lamport: now_ms(),
            },
            patch: None,
        });
    });
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

fn novel_repository_records(
    state: &PersistedNovelRepositoryState,
) -> BTreeMap<String, NovelRepositoryPatch> {
    state
        .repositories
        .iter()
        .filter_map(|repository| {
            let raw_url = if repository.normalized_url.trim().is_empty() {
                repository.url.as_str()
            } else {
                repository.normalized_url.as_str()
            };
            let canonical_url = canonicalize_novel_repository_url(raw_url)?;
            let repository_id = canonical_novel_repository_id(&canonical_url);
            let name = url::Url::parse(&canonical_url)
                .ok()
                .and_then(|url| url.host_str().map(ToString::to_string))
                .map(|host| format!("{host} LNReader repository"))
                .unwrap_or_else(|| "LNReader repository".to_string());
            Some((
                repository_id,
                NovelRepositoryPatch {
                    canonical_url,
                    name,
                    enabled: repository.enabled,
                    created_at_ms: 0,
                    updated_at_ms: now_ms(),
                },
            ))
        })
        .collect()
}

fn novel_plugin_identities<'a>(
    state: &'a PersistedNovelRepositoryState,
    repositories: &BTreeMap<String, NovelRepositoryPatch>,
) -> BTreeMap<String, (&'a LocalInstalledNovelPlugin, String)> {
    let repository_ids = state
        .repositories
        .iter()
        .filter_map(|repository| {
            let raw_url = if repository.normalized_url.trim().is_empty() {
                repository.url.as_str()
            } else {
                repository.normalized_url.as_str()
            };
            let canonical_url = canonicalize_novel_repository_url(raw_url)?;
            let repository_id = canonical_novel_repository_id(&canonical_url);
            repositories
                .contains_key(&repository_id)
                .then(|| (repository.id.as_str(), repository_id))
        })
        .collect::<HashMap<_, _>>();

    state
        .installed_plugins
        .iter()
        .filter_map(|plugin| {
            let repository_id = repository_ids.get(plugin.repository_id.as_str())?.clone();
            let plugin_id = plugin.plugin_id.trim();
            if plugin_id.is_empty() {
                return None;
            }
            let entity_id = canonical_novel_plugin_id(&repository_id, plugin_id, plugin_id);
            Some((entity_id, (plugin, repository_id)))
        })
        .collect()
}

fn build_novel_plugin_patch(
    state: &PersistedNovelRepositoryState,
    plugin: &LocalInstalledNovelPlugin,
    repository_id: String,
) -> Option<NovelPluginPatch> {
    let catalog = state.catalog_entries.iter().find(|entry| {
        entry.repository_id == plugin.repository_id
            && entry.plugin_id == plugin.plugin_id
            && entry.version == plugin.version
    })?;
    let artifact_path = Path::new(plugin.artifact_path.trim());
    let byte_length = i64::try_from(fs::metadata(artifact_path).ok()?.len()).ok()?;
    if !(1..=2_097_152).contains(&byte_length) {
        return None;
    }
    Some(NovelPluginPatch {
        repository_id,
        plugin_id: plugin.plugin_id.trim().to_string(),
        source_id: plugin.plugin_id.trim().to_string(),
        name: catalog.name.trim().to_string(),
        version: plugin.version.trim().to_string(),
        lang: catalog.lang.trim().to_string(),
        enabled: plugin.enabled,
        artifact_sha256: sha256_file(artifact_path).ok()?,
        artifact_byte_length: byte_length,
        public_settings: json!({}),
        created_at_ms: plugin.installed_at_ms.max(0),
        updated_at_ms: plugin.updated_at_ms.max(plugin.installed_at_ms).max(0),
    })
}

fn diff_novel_dependency_mutations(
    local_profile_id: &str,
    previous: &PersistedNovelRepositoryState,
    next: &PersistedNovelRepositoryState,
) -> Vec<SerializableMutationInput> {
    let scope_id = novels_scope_id(local_profile_id);
    let previous_repositories = novel_repository_records(previous);
    let next_repositories = novel_repository_records(next);
    let previous_plugins = novel_plugin_identities(previous, &previous_repositories);
    let next_plugins = novel_plugin_identities(next, &next_repositories);
    let mut mutations = Vec::new();

    for (repository_id, patch) in &next_repositories {
        let unchanged = previous_repositories
            .get(repository_id)
            .is_some_and(|previous| {
                previous.canonical_url == patch.canonical_url && previous.enabled == patch.enabled
            });
        if unchanged {
            continue;
        }
        mutations.push(SerializableMutationInput::NovelRepository {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: scope_id.clone(),
                entity_id: repository_id.clone(),
                op: MutationOperation::Merge,
                lamport: now_ms(),
            },
            patch: Some(patch.clone()),
        });
    }

    for (plugin_id, (plugin, repository_id)) in &next_plugins {
        let Some(patch) = build_novel_plugin_patch(next, plugin, repository_id.to_string()) else {
            continue;
        };
        let unchanged = previous_plugins
            .get(plugin_id)
            .is_some_and(|(previous, _)| {
                previous.version == plugin.version
                    && previous.enabled == plugin.enabled
                    && previous.artifact_path == plugin.artifact_path
                    && previous.updated_at_ms == plugin.updated_at_ms
            });
        if unchanged {
            continue;
        }
        mutations.push(SerializableMutationInput::NovelPlugin {
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

    for plugin_id in previous_plugins.keys() {
        if next_plugins.contains_key(plugin_id) {
            continue;
        }
        mutations.push(SerializableMutationInput::NovelPlugin {
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

    for repository_id in previous_repositories.keys() {
        if next_repositories.contains_key(repository_id) {
            continue;
        }
        mutations.push(SerializableMutationInput::NovelRepository {
            base: SerializableMutationBase {
                client_mutation_id: Uuid::now_v7().to_string(),
                scope_id: scope_id.clone(),
                entity_id: repository_id.clone(),
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

    let novel_plugin_assets =
        collect_novel_plugin_asset_paths(app, restrict_profile_id, &mutations)?;

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
    let mut attempted = false;
    let mut delivered = false;
    let mut last_delivery_error: Option<String> = None;
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
            attempted = true;
            replication_log(format!(
                "submit_mutations target profile_id={} mode=local_authority base_url={}",
                profile_id, authority.local_base_url
            ));
            if let Err(error) =
                post_mutations_for_local_authority(authority, &mutations, &novel_plugin_assets)
                    .await
            {
                last_delivery_error = Some(error.clone());
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
                delivered = true;
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
        attempted = true;
        replication_log(format!(
            "submit_mutations target profile_id={} mode=remote canonical_origin={}",
            profile_id, session.canonical_origin
        ));
        if let Err(error) =
            post_mutations_for_session(session, &mutations, &novel_plugin_assets).await
        {
            last_delivery_error = Some(error.clone());
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
            delivered = true;
            replication_log(format!(
                "submit_mutations result profile_id={} mode=remote status=ok",
                profile_id
            ));
        }
    }
    if restrict_profile_id.is_some() && !delivered {
        return Err(last_delivery_error.unwrap_or_else(|| {
            if attempted {
                "Core rejected the comic reader mutation.".to_string()
            } else {
                "No active Core sync endpoint for this profile.".to_string()
            }
        }));
    }
    Ok(())
}

fn collect_novel_plugin_asset_paths(
    app: &AppHandle,
    local_profile_id: Option<&str>,
    mutations: &[SerializableMutationInput],
) -> Result<HashMap<String, PathBuf>, String> {
    let required = mutations
        .iter()
        .filter_map(|mutation| match mutation {
            SerializableMutationInput::NovelPlugin {
                patch: Some(patch), ..
            } => Some((
                patch.plugin_id.as_str(),
                patch.version.as_str(),
                patch.artifact_sha256.as_str(),
                patch.artifact_byte_length,
            )),
            _ => None,
        })
        .collect::<Vec<_>>();
    if required.is_empty() {
        return Ok(HashMap::new());
    }
    let profile_id = local_profile_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Novel plugin publication requires a local profile.".to_string())?;
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let state = read_novel_repository_state(&launch_target, profile_id)?;
    let mut resolved = HashMap::new();
    for (plugin_id, version, expected_sha256, expected_size) in required {
        let installed = state
            .installed_plugins
            .iter()
            .find(|plugin| plugin.plugin_id == plugin_id && plugin.version == version)
            .ok_or_else(|| {
                format!(
                    "Novel plugin {plugin_id} {version} disappeared before its artifact could be published."
                )
            })?;
        let path = PathBuf::from(installed.artifact_path.trim());
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Novel plugin artifact is unavailable: {error}"))?;
        if !metadata.is_file() || i64::try_from(metadata.len()).ok() != Some(expected_size) {
            return Err(format!(
                "Novel plugin {plugin_id} {version} changed size before publication."
            ));
        }
        let actual_sha256 = sha256_file(&path).map_err(|error| error.to_string())?;
        if actual_sha256 != expected_sha256 {
            return Err(format!(
                "Novel plugin {plugin_id} {version} changed before publication."
            ));
        }
        resolved.insert(expected_sha256.to_string(), path);
    }
    Ok(resolved)
}

fn validate_mutation_receipts(
    request: &SerializableMutationsRequest,
    response: &MutationsResponse,
) -> Result<(), String> {
    if response.request_id != request.request_id {
        return Err(format!(
            "Core mutation receipt requestId mismatch: expected {}, received {}.",
            request.request_id, response.request_id
        ));
    }
    let mut results = BTreeMap::new();
    for result in &response.results {
        if results
            .insert(result.client_mutation_id.as_str(), result)
            .is_some()
        {
            return Err(format!(
                "Core returned duplicate receipt for clientMutationId {}.",
                result.client_mutation_id
            ));
        }
    }
    for mutation in &request.mutations {
        let mutation_id = mutation.client_mutation_id();
        let result = results
            .get(mutation_id)
            .ok_or_else(|| format!("Core omitted receipt for clientMutationId {mutation_id}."))?;
        // `superseded` is a successful, terminal receipt: the Core accepted the
        // mutation but retained an equal or newer canonical value. Treating it
        // as a rejection makes idempotent inventory repair loop forever.
        if !matches!(
            result.status,
            MutationResultStatus::Applied | MutationResultStatus::Superseded
        ) {
            let detail = result
                .error
                .as_ref()
                .map(|error| error.message.as_str())
                .unwrap_or("mutation rejected without details");
            return Err(format!(
                "Core rejected clientMutationId {mutation_id}: {detail}."
            ));
        }
    }
    Ok(())
}

async fn ensure_book_assets_uploaded(
    endpoint: &BookAssetEndpoint,
    mutations: &[SerializableMutationInput],
) -> Result<(), String> {
    let state = read_books_state()?;
    let mut uploaded = HashSet::new();
    for mutation in mutations {
        let SerializableMutationInput::BookEntry {
            base,
            patch: Some(patch),
        } = mutation
        else {
            continue;
        };
        let fingerprint = patch
            .asset_fingerprint
            .as_deref()
            .ok_or_else(|| {
                format!(
                    "Book {} cannot be published without an asset fingerprint.",
                    base.entity_id
                )
            })
            .and_then(validate_asset_sha256)?;
        if !uploaded.insert(fingerprint.clone()) {
            continue;
        }
        let local = state
            .books
            .iter()
            .find(|entry| {
                book_entry_entity_id(entry).as_deref() == Some(base.entity_id.as_str())
                    || canonical_book_id_for_entry(entry).as_deref()
                        == Some(base.entity_id.as_str())
            })
            .ok_or_else(|| {
                format!(
                    "Book {} disappeared before its asset could be published.",
                    base.entity_id
                )
            })?;
        let asset_path = value_string_field(local, "assetPath")
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                format!(
                    "Book {} cannot be published without local asset bytes.",
                    base.entity_id
                )
            })?;
        upload_book_asset(endpoint, &PathBuf::from(asset_path), &fingerprint).await?;

        match (
            patch.cover_asset_sha256.as_deref(),
            patch.cover_asset_byte_size,
            patch.cover_asset_mime_type.as_deref(),
        ) {
            (Some(cover_sha256), Some(cover_byte_size), Some(cover_mime_type)) => {
                let expected_cover_size = u64::try_from(cover_byte_size)
                    .map_err(|_| "Book cover byte size is invalid.".to_string())?;
                if !matches!(cover_mime_type, "image/jpeg" | "image/png" | "image/webp") {
                    return Err("Book cover MIME type is not eligible for sync.".to_string());
                }
                if let Some(remote_size) = remote_asset_size(endpoint, cover_sha256).await? {
                    if remote_size != expected_cover_size {
                        return Err(format!(
                            "Core stores book cover {cover_sha256} with {remote_size} bytes; expected {expected_cover_size}."
                        ));
                    }
                    continue;
                }
                let cover_path = value_string_field(local, "coverPath")
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        format!(
                            "Book {} cannot publish its cover without local cover bytes.",
                            base.entity_id
                        )
                    })?;
                let inspected = inspect_local_book_cover(Path::new(&cover_path))
                    .await?
                    .ok_or_else(|| {
                        format!(
                            "Book {} cover must be a valid JPEG, PNG, or WebP image.",
                            base.entity_id
                        )
                    })?;
                if inspected.sha256 != cover_sha256
                    || inspected.byte_size != cover_byte_size
                    || inspected.mime_type != cover_mime_type
                {
                    return Err(format!(
                        "Book {} cover changed before publication.",
                        base.entity_id
                    ));
                }
                if uploaded.insert(cover_sha256.to_string()) {
                    upload_book_asset(endpoint, Path::new(&cover_path), cover_sha256).await?;
                }
            }
            (None, None, None) => {}
            _ => {
                return Err(format!(
                    "Book {} has an incomplete cover asset reference.",
                    base.entity_id
                ));
            }
        }
    }
    Ok(())
}

async fn ensure_novel_plugin_assets_uploaded(
    client: reqwest::Client,
    origin: &str,
    access_token: &str,
    mutations: &[SerializableMutationInput],
    artifact_paths: &HashMap<String, PathBuf>,
) -> Result<(), String> {
    let mut uploaded = HashSet::new();
    for mutation in mutations {
        let SerializableMutationInput::NovelPlugin {
            base,
            patch: Some(patch),
        } = mutation
        else {
            continue;
        };
        if !uploaded.insert((base.scope_id.clone(), patch.artifact_sha256.clone())) {
            continue;
        }
        let path = artifact_paths.get(&patch.artifact_sha256).ok_or_else(|| {
            format!(
                "Novel plugin {} {} cannot be published without local artifact bytes.",
                patch.plugin_id, patch.version
            )
        })?;
        let endpoint =
            BookAssetEndpoint::for_scope(client.clone(), origin, access_token, &base.scope_id);
        upload_book_asset(&endpoint, path, &patch.artifact_sha256).await?;
    }
    Ok(())
}

async fn post_mutations_for_local_authority(
    authority: &LocalAuthoritySession,
    mutations: &[SerializableMutationInput],
    novel_plugin_assets: &HashMap<String, PathBuf>,
) -> Result<(), String> {
    let request = SerializableMutationsRequest {
        request_id: Uuid::now_v7().to_string(),
        mutations: mutations.to_vec(),
    };
    let client = insecure_local_syncd_client()?;
    let asset_endpoint = BookAssetEndpoint::new(
        client.clone(),
        &authority.local_base_url,
        &authority.access_token,
    );
    ensure_book_assets_uploaded(&asset_endpoint, mutations).await?;
    ensure_novel_plugin_assets_uploaded(
        client.clone(),
        &authority.local_base_url,
        &authority.access_token,
        mutations,
        novel_plugin_assets,
    )
    .await?;
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
        .header(CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(LEGACY_CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(
            CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .header(
            LEGACY_CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .json(&request)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        let receipts = response
            .json::<MutationsResponse>()
            .await
            .map_err(|error| format!("Invalid Core mutation receipt response: {error}"))?;
        validate_mutation_receipts(&request, &receipts)?;
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
    novel_plugin_assets: &HashMap<String, PathBuf>,
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
        let asset_endpoint = BookAssetEndpoint::new(client.clone(), origin, &session.access_token);
        if let Err(error) = ensure_book_assets_uploaded(&asset_endpoint, mutations).await {
            if is_connection_error(&error) && index + 1 < origins.len() {
                last_error = Some(error);
                continue;
            }
            return Err(error);
        }
        if let Err(error) = ensure_novel_plugin_assets_uploaded(
            client.clone(),
            origin,
            &session.access_token,
            mutations,
            novel_plugin_assets,
        )
        .await
        {
            if is_connection_error(&error) && index + 1 < origins.len() {
                last_error = Some(error);
                continue;
            }
            return Err(error);
        }
        let response = client
            .post(format!("{origin}/v1/mutations"))
            .header("Authorization", format!("Bearer {}", session.access_token))
            .header(CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
            .header(LEGACY_CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
            .header(
                CLIENT_PROTOCOL_HEADER.as_str(),
                CLIENT_PROTOCOL_VERSION.to_string(),
            )
            .header(
                LEGACY_CLIENT_PROTOCOL_HEADER.as_str(),
                CLIENT_PROTOCOL_VERSION.to_string(),
            )
            .json(&request)
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                let receipts = response
                    .json::<MutationsResponse>()
                    .await
                    .map_err(|error| format!("Invalid Core mutation receipt response: {error}"))?;
                validate_mutation_receipts(&request, &receipts)?;
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
    use crate::syncd::models::{
        MutationEntityType, MutationResult, SnapshotEntity, SnapshotTombstone,
        SyncdEffectiveDiscoverySource,
    };
    use axum::body::{to_bytes, Body};
    use axum::extract::{Path as AxumPath, State as AxumState};
    use axum::http::{HeaderMap, Response, StatusCode};
    use axum::routing::get;
    use axum::Router;

    #[derive(Clone, Default)]
    struct TestAssetState {
        bytes: Arc<Mutex<Option<Vec<u8>>>>,
        events: Arc<Mutex<Vec<String>>>,
    }

    async fn test_asset_head(
        AxumState(state): AxumState<TestAssetState>,
        AxumPath(sha256): AxumPath<String>,
    ) -> Response<Body> {
        state.events.lock().await.push("HEAD".to_string());
        let bytes = state.bytes.lock().await.clone();
        let Some(bytes) = bytes else {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .unwrap();
        };
        Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_LENGTH, bytes.len())
            .header(ETAG, format!("\"{sha256}\""))
            .header(ASSET_SHA256_HEADER, &sha256)
            .header(LEGACY_ASSET_SHA256_HEADER, &sha256)
            .body(Body::empty())
            .unwrap()
    }

    async fn test_asset_get(
        AxumState(state): AxumState<TestAssetState>,
        AxumPath(sha256): AxumPath<String>,
        headers: HeaderMap,
    ) -> Response<Body> {
        let bytes = state.bytes.lock().await.clone().unwrap_or_default();
        let range_start = headers
            .get(RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("bytes="))
            .and_then(|value| value.strip_suffix('-'))
            .and_then(|value| value.parse::<usize>().ok());
        state.events.lock().await.push(match range_start {
            Some(start) => format!("GET:{start}"),
            None => "GET".to_string(),
        });
        let start = range_start.unwrap_or_default();
        let status = if range_start.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        };
        let mut builder = Response::builder()
            .status(status)
            .header(CONTENT_LENGTH, bytes.len().saturating_sub(start))
            .header(ETAG, format!("\"{sha256}\""))
            .header(ASSET_SHA256_HEADER, &sha256)
            .header(LEGACY_ASSET_SHA256_HEADER, &sha256);
        if range_start.is_some() {
            builder = builder.header(
                CONTENT_RANGE,
                format!("bytes {start}-{}/{}", bytes.len() - 1, bytes.len()),
            );
        }
        builder.body(Body::from(bytes[start..].to_vec())).unwrap()
    }

    async fn test_asset_put(
        AxumState(state): AxumState<TestAssetState>,
        AxumPath(sha256): AxumPath<String>,
        body: Body,
    ) -> Response<Body> {
        state.events.lock().await.push("PUT".to_string());
        let bytes = to_bytes(body, usize::MAX).await.unwrap().to_vec();
        assert_eq!(sha256_file_bytes(&bytes), sha256);
        *state.bytes.lock().await = Some(bytes);
        Response::builder()
            .status(StatusCode::CREATED)
            .header(CONTENT_LENGTH, 0)
            .header(ETAG, format!("\"{sha256}\""))
            .header(ASSET_SHA256_HEADER, &sha256)
            .header(LEGACY_ASSET_SHA256_HEADER, &sha256)
            .body(Body::empty())
            .unwrap()
    }

    fn sha256_file_bytes(bytes: &[u8]) -> String {
        format!("{:x}", sha2::Sha256::digest(bytes))
    }

    async fn spawn_test_asset_server(
        initial: Option<Vec<u8>>,
    ) -> (
        BookAssetEndpoint,
        TestAssetState,
        tokio::task::JoinHandle<()>,
    ) {
        let state = TestAssetState {
            bytes: Arc::new(Mutex::new(initial)),
            events: Arc::new(Mutex::new(Vec::new())),
        };
        let app = Router::new()
            .route(
                "/v1/assets/:sha256",
                get(test_asset_get)
                    .head(test_asset_head)
                    .put(test_asset_put),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (
            BookAssetEndpoint::new(reqwest::Client::new(), &origin, "test-token"),
            state,
            task,
        )
    }

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

    #[tokio::test]
    async fn desktop_asset_upload_publishes_verified_bytes_before_entry_mutation() {
        let bytes = b"desktop imported epub bytes".to_vec();
        let sha256 = sha256_file_bytes(&bytes);
        let source = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(source.path(), &bytes).unwrap();
        let (endpoint, state, task) = spawn_test_asset_server(None).await;

        upload_book_asset(&endpoint, source.path(), &sha256)
            .await
            .unwrap();

        assert_eq!(state.bytes.lock().await.as_deref(), Some(bytes.as_slice()));
        assert_eq!(
            state.events.lock().await.as_slice(),
            ["HEAD", "PUT", "HEAD"]
        );
        task.abort();
    }

    #[tokio::test]
    async fn desktop_cover_metadata_is_atomic_supported_and_path_free_on_wire() {
        let root = tempfile::tempdir().unwrap();
        let cover_path = root.path().join("cover.png");
        let cover = b"\x89PNG\r\n\x1a\nverified-cover";
        std::fs::write(&cover_path, cover).unwrap();
        let mut next = PersistedBookLibraryState {
            books: vec![json!({
                "id": "epub:sha256:fixture",
                "assetFingerprint": "a".repeat(64),
                "mimeType": "application/epub+zip",
                "byteSize": 128,
                "title": "Covered book",
                "subtype": "epub",
                "coverPath": cover_path,
                "createdAt": 1,
                "updatedAt": 1,
            })],
            ..PersistedBookLibraryState::default()
        };

        assert!(
            enrich_book_cover_assets(&PersistedBookLibraryState::default(), &mut next)
                .await
                .unwrap()
        );
        let book = &next.books[0];
        let cover_sha256 = sha256_file_bytes(cover);
        assert_eq!(
            value_string_field(book, "coverAssetSha256").as_deref(),
            Some(cover_sha256.as_str())
        );
        assert_eq!(
            value_i64_field(book, "coverAssetByteSize"),
            Some(cover.len() as i64)
        );
        assert_eq!(
            value_string_field(book, "coverAssetMimeType").as_deref(),
            Some("image/png")
        );
        assert!(value_bool_field(book, "hasCover", false));

        let patch = build_book_entry_patch(book).unwrap();
        let wire = serde_json::to_value(patch).unwrap();
        assert_eq!(wire["coverAssetMimeType"], "image/png");
        assert!(wire.get("coverPath").is_none());
        assert!(wire.get("assetPath").is_none());
        assert!(wire.get("privatePath").is_none());
    }

    #[test]
    fn desktop_cover_signature_allowlist_is_jpeg_png_and_webp_only() {
        assert_eq!(
            detected_cover_mime_type(&[0xff, 0xd8, 0xff]),
            Some("image/jpeg")
        );
        assert_eq!(
            detected_cover_mime_type(b"\x89PNG\r\n\x1a\n"),
            Some("image/png")
        );
        assert_eq!(
            detected_cover_mime_type(b"RIFF\x04\0\0\0WEBP"),
            Some("image/webp")
        );
        assert_eq!(detected_cover_mime_type(b"GIF89a"), None);
        assert_eq!(detected_cover_mime_type(b"<svg"), None);
    }

    #[tokio::test]
    async fn remote_asset_download_resumes_validates_and_materializes_atomically() {
        let bytes = b"mobile uploaded pdf bytes with resumable tail".to_vec();
        let sha256 = sha256_file_bytes(&bytes);
        let (endpoint, state, task) = spawn_test_asset_server(Some(bytes.clone())).await;
        let root = tempfile::tempdir().unwrap();
        let destination = synchronized_book_asset_path(root.path(), &sha256, "pdf").unwrap();
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        let part_path = destination.with_extension("pdf.part");
        std::fs::write(&part_path, &bytes[..11]).unwrap();

        let materialized = download_book_asset_to_root(&endpoint, &sha256, "pdf", root.path())
            .await
            .unwrap();

        assert_eq!(materialized, destination);
        assert_eq!(std::fs::read(&materialized).unwrap(), bytes);
        assert!(!part_path.exists());
        assert_eq!(sha256_file(&materialized).unwrap(), sha256);
        assert_eq!(state.events.lock().await.as_slice(), ["HEAD", "GET:11"]);
        task.abort();
    }

    #[tokio::test]
    async fn mismatched_existing_user_asset_is_preserved() {
        let root = tempfile::tempdir().unwrap();
        let user_asset = root.path().join("user-import.epub");
        std::fs::write(&user_asset, b"user bytes that must remain").unwrap();
        let expected = sha256_file_bytes(b"different remote bytes");

        assert_eq!(
            matching_local_asset_path(Some(user_asset.to_string_lossy().into_owned()), &expected,)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            std::fs::read(&user_asset).unwrap(),
            b"user bytes that must remain"
        );
    }

    #[test]
    fn book_bookmark_entity_id_is_stable() {
        let entry = LocalBookBookmark {
            bookmark_id: String::new(),
            book_id: "book-1".to_string(),
            location: Some("epubcfi(/6/2)".to_string()),
            href: None,
            page_index: None,
            progress_percent: 0.4,
            label: Some("Here".to_string()),
            note: None,
            created_at_ms: 10,
            updated_at_ms: 10,
            saved_at: 10,
        };
        assert_eq!(
            bookmark_entity_id_for_book(&entry),
            bookmark_entity_id_for_book(&entry)
        );
    }

    #[test]
    fn book_asset_metadata_is_restored_before_publication() {
        let asset = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(asset.path(), b"%PDF fixture").unwrap();
        let mut current = PersistedBookLibraryState {
            books: vec![json!({
                "id": "pdf-local",
                "title": "Fixture",
                "subtype": "pdf",
                "assetFingerprint": "fingerprint",
                "assetPath": asset.path(),
            })],
            ..PersistedBookLibraryState::default()
        };

        assert!(
            enrich_book_asset_metadata(&PersistedBookLibraryState::default(), &mut current,)
                .unwrap()
        );
        let entry = &current.books[0];
        assert_eq!(
            value_string_field(entry, "mimeType").as_deref(),
            Some("application/pdf")
        );
        assert_eq!(
            value_i64_field(entry, "byteSize"),
            Some(b"%PDF fixture".len() as i64)
        );
    }

    #[test]
    fn legacy_book_ids_publish_and_resolve_by_canonical_content_identity() {
        let fingerprint = "e6047bf8a0a95f7840849c55983bf4f07b8b881091c3417340b4872fe81eecce";
        let state = PersistedBookLibraryState {
            books: vec![json!({
                "id": format!("pdf-{fingerprint}"),
                "title": "Legacy fixture",
                "subtype": "pdf",
                "assetFingerprint": fingerprint,
                "mimeType": "application/pdf",
                "byteSize": 10,
            })],
            book_history: vec![LocalBookHistory {
                history_id: format!("book.history::pdf-{fingerprint}"),
                book_id: format!("pdf-{fingerprint}"),
                renderer: Some("pdf".to_string()),
                location: Some("1".to_string()),
                href: None,
                page_index: Some(1),
                progress_percent: 0.1,
                section_label: None,
                read_at_ms: 10,
            }],
            ..PersistedBookLibraryState::default()
        };
        let canonical = format!("pdf:sha256:{fingerprint}");

        assert_eq!(
            canonical_book_id_for_entry(&state.books[0]),
            Some(canonical.clone())
        );
        assert_eq!(
            canonical_book_id_for_local_id(&state, &format!("pdf-{fingerprint}")),
            canonical
        );
        assert_eq!(
            local_book_id_for_canonical_id(&state, &canonical),
            format!("pdf-{fingerprint}")
        );
        let diff = diff_book_mutations(&PersistedBookLibraryState::default(), &state);
        assert!(matches!(
            &diff[0],
            SerializableMutationInput::BookEntry { base, .. } if base.entity_id == canonical
        ));
        assert!(matches!(
            &diff[1],
            SerializableMutationInput::BookHistory { base, patch: None }
                if base.entity_id == format!("book.history::pdf-{fingerprint}")
        ));
        assert!(matches!(
            &diff[2],
            SerializableMutationInput::BookHistory { base, patch: Some(patch) }
                if base.entity_id == format!("book.history::{canonical}")
                    && patch.book_id == canonical
        ));
    }

    #[test]
    fn diff_book_mutations_emits_merge_and_delete() {
        let previous = PersistedBookLibraryState {
            book_bookmarks: vec![LocalBookBookmark {
                bookmark_id: String::new(),
                book_id: "book-1".to_string(),
                location: Some("old".to_string()),
                href: None,
                page_index: None,
                progress_percent: 0.1,
                label: None,
                note: None,
                created_at_ms: 1,
                updated_at_ms: 1,
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
    fn changed_book_progress_projects_canonical_latest_history() {
        let previous = PersistedBookLibraryState::default();
        let mut next = PersistedBookLibraryState {
            books: vec![json!({
                "id": "epub-1",
                "subtype": "epub",
            })],
            book_progress: vec![LocalBookProgress {
                book_id: "epub-1".to_string(),
                location: Some("epubcfi(/6/2)".to_string()),
                href: Some("chapter.xhtml".to_string()),
                progress_percent: 0.4,
                last_read_at: 1234,
                page_index: None,
                total_pages: None,
                section_label: Some("Chapter 1".to_string()),
                renderer: None,
            }],
            ..PersistedBookLibraryState::default()
        };

        assert!(project_latest_book_history(&previous, &mut next));
        assert_eq!(next.book_history.len(), 1);
        assert_eq!(next.book_history[0].history_id, "book.history::epub-1");
        assert_eq!(next.book_history[0].renderer.as_deref(), Some("epub"));
        assert_eq!(next.book_history[0].read_at_ms, 1234);

        let diff = diff_book_mutations(&previous, &next);
        assert!(diff.iter().any(|mutation| matches!(
            mutation,
            SerializableMutationInput::BookHistory {
                base: SerializableMutationBase {
                    entity_id,
                    op: MutationOperation::Merge,
                    ..
                },
                patch: Some(BookHistoryPatch { history_id, .. }),
            } if entity_id == "book.history::epub-1" && history_id == entity_id
        )));
    }

    #[test]
    fn unchanged_progress_does_not_resurrect_deleted_latest_history() {
        let progress = LocalBookProgress {
            book_id: "pdf-1".to_string(),
            location: Some("0.5".to_string()),
            href: None,
            progress_percent: 0.5,
            last_read_at: 500,
            page_index: Some(10),
            total_pages: Some(20),
            section_label: None,
            renderer: Some("pdf".to_string()),
        };
        let previous = PersistedBookLibraryState {
            book_progress: vec![progress.clone()],
            ..PersistedBookLibraryState::default()
        };
        let mut next = PersistedBookLibraryState {
            book_progress: vec![progress],
            ..PersistedBookLibraryState::default()
        };

        assert!(!project_latest_book_history(&previous, &mut next));
        assert!(next.book_history.is_empty());
    }

    #[test]
    fn diff_book_mutations_syncs_entries_but_ignores_other_catalog_changes() {
        let fingerprint = "a".repeat(64);
        let previous = PersistedBookLibraryState {
            books: vec![json!({
                "id": "book-1",
                "assetFingerprint": fingerprint,
                "title": "Old title",
                "subtype": "epub",
                "createdAt": 1,
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
                "assetFingerprint": "a".repeat(64),
                "title": "New title",
                "subtype": "epub",
                "createdAt": 1,
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
        assert_eq!(diff.len(), 1);
        assert!(matches!(
            &diff[0],
            SerializableMutationInput::BookEntry {
                base: SerializableMutationBase {
                    entity_id,
                    op: MutationOperation::Merge,
                    ..
                },
                patch: Some(BookEntryPatch { title, .. }),
            } if entity_id == &format!("epub:sha256:{}", "a".repeat(64))
                && title == "New title"
        ));
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
    fn diff_novel_progress_emits_portable_refs_from_exact_provider_keys() {
        let next = PersistedNovelLibraryState {
            entries: vec![json!({
                "id": "local-novel-42",
                "title": "Fixture",
                "path": "/Novel/KeepCase?chapter=A%2FB",
                "source": { "pluginId": "fixture.plugin" }
            })],
            chapters: vec![json!({
                "id": "local-chapter-7",
                "novelId": "local-novel-42",
                "path": "/Chapter/KeepCase?part=1",
                "title": "Chapter"
            })],
            progress: vec![LocalNovelProgress {
                novel_id: "local-novel-42".to_string(),
                chapter_id: Some("local-chapter-7".to_string()),
                chapter_title: Some("Chapter".to_string()),
                progress_percent: 0.4,
                locator: Some("block:4".to_string()),
                updated_at: 20,
            }],
            ..PersistedNovelLibraryState::default()
        };

        let diff =
            diff_novel_mutations("local-main", &PersistedNovelLibraryState::default(), &next);
        let SerializableMutationInput::NovelProgress { base, patch } = diff
            .iter()
            .find(|mutation| matches!(mutation, SerializableMutationInput::NovelProgress { .. }))
            .expect("expected novel progress mutation")
        else {
            panic!("expected novel progress mutation");
        };
        let work = patch.portable_work_ref.as_ref().unwrap();
        let chapter = patch.portable_chapter_ref.as_ref().unwrap();
        let chapter_id = canonical_portable_chapter_id(chapter);

        assert_eq!(
            base.entity_id,
            format!("novel.progress::{}", canonical_portable_work_id(work))
        );
        assert_eq!(patch.chapter_id.as_deref(), Some(chapter_id.as_str()));
        assert!(matches!(
            work,
            PortableWorkRefV3::Novel { plugin_id, novel_key }
                if plugin_id == "fixture.plugin"
                    && novel_key == "/Novel/KeepCase?chapter=A%2FB"
        ));
    }

    #[test]
    fn diff_novel_mutations_publishes_library_metadata_and_history_changes() {
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
        assert_eq!(diff.len(), 3);
        assert!(matches!(
            &diff[0],
            SerializableMutationInput::NovelEntry {
                patch: Some(NovelEntryPatch { title, path, .. }),
                ..
            } if title == "New novel" && path == "/new"
        ));
        assert!(diff.iter().any(|mutation| matches!(
            mutation,
            SerializableMutationInput::NovelHistory {
                patch: Some(NovelHistoryPatch { locator: Some(locator), .. }),
                ..
            } if locator == "new"
        )));
    }

    #[test]
    fn lnreader_dependencies_publish_metadata_without_executable_bytes() {
        let root = tempfile::tempdir().unwrap();
        let artifact_path = root.path().join("plugin.js");
        let artifact = b"module.exports = { id: 'fixture' };";
        std::fs::write(&artifact_path, artifact).unwrap();
        let repository_url = "https://raw.githubusercontent.com/lnreader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json";
        let repository_id = "desktop-repository";
        let state = PersistedNovelRepositoryState {
            repositories: vec![LocalNovelRepository {
                id: repository_id.to_string(),
                url: repository_url.to_string(),
                normalized_url: repository_url.to_string(),
                enabled: true,
            }],
            catalog_entries: vec![LocalNovelCatalogEntry {
                repository_id: repository_id.to_string(),
                plugin_id: "fixture.plugin".to_string(),
                name: "Fixture plugin".to_string(),
                lang: "en".to_string(),
                version: "1.0.0".to_string(),
            }],
            installed_plugins: vec![LocalInstalledNovelPlugin {
                repository_id: repository_id.to_string(),
                plugin_id: "fixture.plugin".to_string(),
                version: "1.0.0".to_string(),
                enabled: true,
                artifact_path: artifact_path.to_string_lossy().into_owned(),
                installed_at_ms: 10,
                updated_at_ms: 20,
            }],
        };

        let created = diff_novel_dependency_mutations(
            "main",
            &PersistedNovelRepositoryState::default(),
            &state,
        );
        assert_eq!(created.len(), 2);
        assert!(matches!(
            created[0],
            SerializableMutationInput::NovelRepository { .. }
        ));
        let plugin = serde_json::to_value(&created[1]).unwrap();
        assert_eq!(plugin["entityType"], "novel.plugin");
        assert_eq!(plugin["patch"]["artifactByteLength"], artifact.len());
        assert_eq!(
            plugin["patch"]["artifactSha256"],
            sha256_file_bytes(artifact)
        );
        assert!(plugin["patch"].get("artifactPath").is_none());
        assert!(plugin["patch"].get("artifactBytes").is_none());

        let removed = diff_novel_dependency_mutations(
            "main",
            &state,
            &PersistedNovelRepositoryState::default(),
        );
        assert_eq!(removed.len(), 2);
        assert!(matches!(
            removed[0],
            SerializableMutationInput::NovelPlugin {
                base: SerializableMutationBase {
                    op: MutationOperation::Delete,
                    ..
                },
                ..
            }
        ));
        assert!(matches!(
            removed[1],
            SerializableMutationInput::NovelRepository {
                base: SerializableMutationBase {
                    op: MutationOperation::Delete,
                    ..
                },
                ..
            }
        ));
    }

    #[test]
    fn desktop_bridge_uses_canonical_novel_identity_when_source_is_complete() {
        let patch = build_novel_entry_patch(&json!({
            "id": "novel:source:%2Fnovel%2F1",
            "title": "Example",
            "path": "/novel/1",
            "source": {
                "repositoryUrl": "HTTPS://Example.COM:443/repository/",
                "pluginId": "plugin",
                "sourceId": "source"
            },
            "addedAt": 1,
            "updatedAt": 1
        }))
        .unwrap();

        assert_eq!(
            patch.identity_key,
            canonical_portable_work_id(&PortableWorkRefV3::Novel {
                plugin_id: "plugin".to_string(),
                novel_key: "/novel/1".to_string(),
            })
        );
    }

    #[test]
    fn desktop_bridge_uses_portable_identity_when_plugin_and_path_are_available() {
        let patch = build_novel_entry_patch(&json!({
            "id": "novel:legacy:%2Fnovel%2F1",
            "title": "Legacy",
            "path": "/novel/1",
            "source": {
                "pluginId": "plugin"
            },
            "addedAt": 1,
            "updatedAt": 1
        }))
        .unwrap();

        assert_eq!(
            patch.identity_key,
            canonical_portable_work_id(&PortableWorkRefV3::Novel {
                plugin_id: "plugin".to_string(),
                novel_key: "/novel/1".to_string(),
            })
        );
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
                note: Some("Keep".to_string()),
                created_at_ms: 1200,
                updated_at_ms: 1300,
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
    fn legacy_book_progress_alias_is_rebound_without_duplicate_local_progress() {
        let fingerprint = "a".repeat(64);
        let canonical = format!("epub:sha256:{fingerprint}");
        let local = format!("epub-{fingerprint}");
        let mut state = PersistedBookLibraryState {
            books: vec![json!({
                "id": local,
                "subtype": "epub",
                "assetFingerprint": fingerprint,
            })],
            book_progress: vec![LocalBookProgress {
                book_id: format!("book.progress::{canonical}"),
                location: Some("legacy".to_string()),
                href: None,
                progress_percent: 0.1,
                last_read_at: 1,
                page_index: None,
                total_pages: None,
                section_label: None,
                renderer: Some("epub".to_string()),
            }],
            ..PersistedBookLibraryState::default()
        };

        upsert_book_progress(
            &mut state,
            BookProgressRecord {
                book_id: canonical.clone(),
                renderer: Some("epub".to_string()),
                location: Some("current".to_string()),
                href: None,
                progress_percent: 0.8,
                last_read_at_ms: 2,
                page_index: None,
                total_pages: None,
                section_label: None,
                record_lamport: 2,
            },
        );

        assert_eq!(state.book_progress.len(), 1);
        assert_eq!(state.book_progress[0].book_id, local);
        assert_eq!(state.book_progress[0].progress_percent, 0.8);
        assert_eq!(
            canonical_book_id_for_local_id(&state, &format!("book.progress::{canonical}")),
            canonical
        );
    }

    #[test]
    fn remote_book_history_merge_and_tombstone_preserve_reader_state() {
        let progress = LocalBookProgress {
            book_id: "book-1".to_string(),
            location: Some("epubcfi(/6/2)".to_string()),
            href: None,
            progress_percent: 0.4,
            last_read_at: 100,
            page_index: None,
            total_pages: None,
            section_label: None,
            renderer: Some("epub".to_string()),
        };
        let bookmark = LocalBookBookmark {
            bookmark_id: "bookmark-1".to_string(),
            book_id: "book-1".to_string(),
            location: Some("epubcfi(/6/4)".to_string()),
            href: None,
            page_index: None,
            progress_percent: 0.5,
            label: Some("Keep".to_string()),
            note: None,
            created_at_ms: 110,
            updated_at_ms: 110,
            saved_at: 110,
        };
        let mut state = PersistedBookLibraryState {
            book_progress: vec![progress.clone()],
            book_bookmarks: vec![bookmark.clone()],
            ..PersistedBookLibraryState::default()
        };

        upsert_book_history(
            &mut state,
            BookHistoryRecord {
                history_id: "mobile-session-1".to_string(),
                book_id: "book-1".to_string(),
                renderer: Some("epub".to_string()),
                location: Some("epubcfi(/6/6)".to_string()),
                href: None,
                page_index: None,
                progress_percent: 0.6,
                section_label: Some("Two".to_string()),
                read_at_ms: 120,
                record_lamport: 5,
            },
        );
        delete_book_history(&mut state, "mobile-session-1");

        assert!(state.book_history.is_empty());
        assert_eq!(state.book_progress, vec![progress]);
        assert_eq!(state.book_bookmarks, vec![bookmark]);
    }

    #[test]
    fn remote_novel_progress_and_bookmark_apply_to_local_state() {
        let mut state = PersistedNovelLibraryState::default();

        upsert_novel_progress(
            &mut state,
            NovelProgressRecord {
                novel_id: "novel-1".to_string(),
                chapter_id: Some("chapter-9".to_string()),
                portable_work_ref: None,
                portable_chapter_ref: None,
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
    fn remote_portable_novel_progress_resolves_to_existing_local_ids() {
        let work = PortableWorkRefV3::Novel {
            plugin_id: "fixture.plugin".to_string(),
            novel_key: "/novel/opaque".to_string(),
        };
        let chapter = PortableChapterRefV3::Novel {
            work: work.clone(),
            chapter_key: "/chapter/opaque".to_string(),
        };
        let mut state = PersistedNovelLibraryState {
            entries: vec![json!({
                "id": "local-novel-1",
                "title": "Local",
                "path": "/novel/opaque",
                "source": { "pluginId": "fixture.plugin" }
            })],
            chapters: vec![json!({
                "id": "local-chapter-9",
                "novelId": "local-novel-1",
                "path": "/chapter/opaque",
                "title": "Nine"
            })],
            ..PersistedNovelLibraryState::default()
        };

        upsert_novel_progress(
            &mut state,
            NovelProgressRecord {
                novel_id: canonical_portable_work_id(&work),
                chapter_id: Some(canonical_portable_chapter_id(&chapter)),
                portable_work_ref: Some(work),
                portable_chapter_ref: Some(chapter),
                chapter_title: Some("Nine".to_string()),
                chapter_order_key: Some(9.0),
                progress_percent: 0.8,
                locator: Some("block:9".to_string()),
                locator_sort_key: Some(9.0),
                updated_at_ms: 2000,
                record_lamport: 20,
            },
        );

        assert_eq!(state.progress[0].novel_id, "local-novel-1");
        assert_eq!(
            state.progress[0].chapter_id.as_deref(),
            Some("local-chapter-9")
        );
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
    fn reconcile_profile_clears_stale_error_without_sessions() {
        let mut profile = PersistedReplicationProfileState {
            replication_status: SyncdReplicationStatus::Degraded,
            last_error: Some("stale error".to_string()),
            ..PersistedReplicationProfileState::default()
        };

        reconcile_profile_sessions(&mut profile, &[], "local-a");

        assert_eq!(profile.replication_status, SyncdReplicationStatus::Idle);
        assert_eq!(profile.last_error, None);
    }

    #[test]
    fn reconcile_profile_preserves_explicit_pause_without_sessions() {
        let mut profile = PersistedReplicationProfileState {
            replication_status: SyncdReplicationStatus::Paused,
            last_error: None,
            paused: true,
            ..PersistedReplicationProfileState::default()
        };

        reconcile_profile_sessions(&mut profile, &[], "local-a");

        assert_eq!(profile.replication_status, SyncdReplicationStatus::Paused);
        assert!(profile.paused);
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
    fn comic_history_mutation_serializes_with_profile_scope() {
        let comic_id = format!("suwayomi:{}:manga:42", "a".repeat(64));
        let history_id = format!("comic.history::{comic_id}");
        let mutation = SerializableMutationInput::ComicHistory {
            base: SerializableMutationBase {
                client_mutation_id: "mutation-a".to_string(),
                scope_id: "comics:profile:remote-a".to_string(),
                entity_id: history_id.clone(),
                op: MutationOperation::Merge,
                lamport: 123,
            },
            patch: Some(ComicHistoryPatch {
                portable_work_ref: None,
                portable_chapter_ref: None,
                history_id: history_id.clone(),
                comic_id,
                chapter_id: "9".to_string(),
                page_index: 3,
                page_count: Some(20),
                progress_percent: 0.2,
                read_at_ms: 123,
            }),
        };
        let value = serde_json::to_value(mutation).unwrap();
        assert_eq!(value["entityType"], "comic.history");
        assert_eq!(value["scopeId"], "comics:profile:remote-a");
        assert_eq!(value["entityId"], history_id);
        assert_eq!(value["op"], "merge");
    }

    #[test]
    fn old_replication_profiles_default_new_comic_state_fields() {
        let mut value = serde_json::to_value(PersistedReplicationState {
            profiles: BTreeMap::from([(
                "local-a".to_string(),
                PersistedReplicationProfileState::default(),
            )]),
        })
        .unwrap();
        let profile = value["profiles"]["local-a"].as_object_mut().unwrap();
        profile.remove("comicsScopeCheckpoint");
        profile.remove("pendingComicReaderChanges");
        profile.remove("pendingComicReaderSnapshot");
        let decoded: PersistedReplicationState = serde_json::from_value(value).unwrap();
        let profile = decoded.profiles.get("local-a").unwrap();
        assert!(profile.comics_scope_checkpoint.is_none());
        assert!(profile.pending_comic_reader_changes.is_empty());
        assert!(profile.pending_comic_reader_snapshot.is_none());
    }

    #[test]
    fn comic_server_fingerprint_matches_mobile_golden_and_separates_profiles() {
        let tls = "a".repeat(64);
        assert_eq!(
            derive_comic_server_fingerprint(&tls.to_ascii_uppercase(), "main"),
            "c47cc567e6c7ed7481dca23ed601f99a0d5f3beaa10b3cadae703c09505ed63f"
        );
        assert_ne!(
            derive_comic_server_fingerprint(&tls, "main"),
            derive_comic_server_fingerprint(&tls, "secondary")
        );
    }

    #[test]
    fn authoritative_book_snapshot_replaces_stale_scope_state() {
        let current = PersistedBookLibraryState {
            version: Some(7),
            book_progress: vec![LocalBookProgress {
                book_id: "stale-book".to_string(),
                location: None,
                href: None,
                progress_percent: 0.1,
                last_read_at: 1,
                page_index: None,
                total_pages: None,
                section_label: None,
                renderer: None,
            }],
            ..PersistedBookLibraryState::default()
        };
        let record = BookProgressRecord {
            book_id: "book-remote".to_string(),
            renderer: Some("epub".to_string()),
            location: Some("epubcfi(/6/2)".to_string()),
            href: None,
            progress_percent: 0.75,
            last_read_at_ms: 20,
            page_index: None,
            total_pages: None,
            section_label: None,
            record_lamport: 9,
        };
        let snapshot = SnapshotResponse {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            snapshot_id: Some("book-progress-snapshot".to_string()),
            complete: Some(true),
            entity_count: Some(1),
            tombstone_count: Some(1),
            scope_id: BOOKS_SCOPE_ID.to_string(),
            snapshot_version: 40,
            min_replayable_server_version: 10,
            entities: vec![SnapshotEntity {
                entity_type: "book.progress".to_string(),
                entity_id: "book.progress::book-remote".to_string(),
                server_version: 39,
                lamport: 9,
                record: serde_json::to_value(record).unwrap(),
            }],
            tombstones: vec![SnapshotTombstone {
                entity_type: "book.progress".to_string(),
                entity_id: "book.progress::stale-book".to_string(),
                server_version: 38,
                lamport: 8,
                deleted_at_ms: 18,
                reason_code: "deleted".to_string(),
            }],
        };

        let next = materialize_book_snapshot(&current, &snapshot).unwrap();
        assert_eq!(next.version, Some(7));
        assert_eq!(next.book_progress.len(), 1);
        assert_eq!(next.book_progress[0].book_id, "book-remote");
    }

    #[test]
    fn authoritative_book_snapshot_materializes_history_independently() {
        let history = BookHistoryRecord {
            history_id: "mobile-session-1".to_string(),
            book_id: "book-remote".to_string(),
            renderer: Some("pdf".to_string()),
            location: Some("0.75".to_string()),
            href: None,
            page_index: Some(15),
            progress_percent: 0.75,
            section_label: Some("Page 15".to_string()),
            read_at_ms: 50,
            record_lamport: 12,
        };
        let snapshot = SnapshotResponse {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            snapshot_id: Some("book-history-snapshot".to_string()),
            complete: Some(true),
            entity_count: Some(1),
            tombstone_count: Some(0),
            scope_id: BOOKS_SCOPE_ID.to_string(),
            snapshot_version: 60,
            min_replayable_server_version: 20,
            entities: vec![SnapshotEntity {
                entity_type: "book.history".to_string(),
                entity_id: history.history_id.clone(),
                server_version: 59,
                lamport: 12,
                record: serde_json::to_value(history).unwrap(),
            }],
            tombstones: Vec::new(),
        };

        let next =
            materialize_book_snapshot(&PersistedBookLibraryState::default(), &snapshot).unwrap();
        assert_eq!(next.book_history.len(), 1);
        assert_eq!(next.book_history[0].history_id, "mobile-session-1");
        assert!(next.book_progress.is_empty());
        assert!(next.book_bookmarks.is_empty());
    }

    #[test]
    fn legacy_book_state_defaults_hidden_history_collection() {
        let mut value = serde_json::to_value(PersistedBookLibraryState::default()).unwrap();
        value.as_object_mut().unwrap().remove("bookHistory");

        let state: PersistedBookLibraryState = serde_json::from_value(value).unwrap();
        assert!(state.book_history.is_empty());
    }

    #[test]
    fn authoritative_novel_snapshot_replaces_library_and_classification() {
        let current = PersistedNovelLibraryState {
            version: Some(3),
            scope_key: Some("local-main".to_string()),
            progress: vec![LocalNovelProgress {
                novel_id: "stale".to_string(),
                chapter_id: None,
                chapter_title: None,
                progress_percent: 0.2,
                locator: None,
                updated_at: 1,
            }],
            ..PersistedNovelLibraryState::default()
        };
        let current_classification = PersistedNovelSourceClassificationState {
            version: Some(2),
            scope_key: Some("local-main".to_string()),
            records: vec![json!({"pluginId": "stale"})],
            updated_at_ms: Some(1),
        };
        let record = NovelProgressRecord {
            novel_id: "novel-remote".to_string(),
            chapter_id: Some("chapter-2".to_string()),
            portable_work_ref: None,
            portable_chapter_ref: None,
            chapter_title: Some("Two".to_string()),
            chapter_order_key: Some(2.0),
            progress_percent: 0.6,
            locator: Some("paragraph-4".to_string()),
            locator_sort_key: Some(4.0),
            updated_at_ms: 25,
            record_lamport: 11,
        };
        let snapshot = SnapshotResponse {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            snapshot_id: Some("novel-progress-snapshot".to_string()),
            complete: Some(true),
            entity_count: Some(1),
            tombstone_count: Some(0),
            scope_id: "novels:profile:remote-main".to_string(),
            snapshot_version: 50,
            min_replayable_server_version: 12,
            entities: vec![SnapshotEntity {
                entity_type: "novel.progress".to_string(),
                entity_id: "novel.progress::novel-remote".to_string(),
                server_version: 49,
                lamport: 11,
                record: serde_json::to_value(record).unwrap(),
            }],
            tombstones: Vec::new(),
        };

        let (next, classification) =
            materialize_novel_snapshot(&current, &current_classification, &snapshot).unwrap();
        assert_eq!(next.version, Some(3));
        assert_eq!(next.scope_key.as_deref(), Some("local-main"));
        assert_eq!(next.progress.len(), 1);
        assert_eq!(next.progress[0].novel_id, "novel-remote");
        assert_eq!(classification.version, Some(2));
        assert!(classification.records.is_empty());
    }

    #[test]
    fn comic_snapshot_becomes_ordered_persistent_inbox_payload() {
        let comic_id = format!("suwayomi:{}:manga:7", "b".repeat(64));
        let record = crate::syncd::models::ComicHistoryRecord {
            history_id: format!("comic.history::{comic_id}"),
            comic_id: comic_id.clone(),
            chapter_id: "2".to_string(),
            portable_work_ref: None,
            portable_chapter_ref: None,
            page_index: 4,
            page_count: Some(20),
            progress_percent: 0.25,
            read_at_ms: 100,
            record_lamport: 12,
        };
        let snapshot = SnapshotResponse {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            snapshot_id: Some("comic-reader-snapshot".to_string()),
            complete: Some(true),
            entity_count: Some(3),
            tombstone_count: Some(1),
            scope_id: "comics:profile:remote-main".to_string(),
            snapshot_version: 80,
            min_replayable_server_version: 20,
            entities: vec![
                SnapshotEntity {
                    entity_type: "comic.entry".to_string(),
                    entity_id: "portable:comic:entry".to_string(),
                    server_version: 77,
                    lamport: 10,
                    record: json!({ "comicId": "portable:comic:entry", "inLibrary": true }),
                },
                SnapshotEntity {
                    entity_type: "comic.chapter_state".to_string(),
                    entity_id: "portable:comic:chapter-state".to_string(),
                    server_version: 78,
                    lamport: 11,
                    record: json!({ "chapterStateId": "portable:comic:chapter-state" }),
                },
                SnapshotEntity {
                    entity_type: "comic.history".to_string(),
                    entity_id: record.history_id.clone(),
                    server_version: 79,
                    lamport: 12,
                    record: serde_json::to_value(record).unwrap(),
                },
            ],
            tombstones: vec![SnapshotTombstone {
                entity_type: "comic.page_bookmark".to_string(),
                entity_id: "bookmark-old".to_string(),
                server_version: 78,
                lamport: 10,
                deleted_at_ms: 90,
                reason_code: "deleted".to_string(),
            }],
        };

        let changes = comic_snapshot_changes(&snapshot, "remote-main").unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].op, "delete");
        assert_eq!(changes[1].op, "merge");
        let checkpoint = snapshot_checkpoint(&snapshot);
        assert_eq!(checkpoint.last_applied_server_version, 80);
        assert_eq!(
            checkpoint.last_replay_mode,
            SyncdReplicationReplayMode::RecoveryReplay
        );

        let books_snapshot = SnapshotResponse {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            snapshot_id: Some("empty-books-snapshot".to_string()),
            complete: Some(true),
            entity_count: Some(0),
            tombstone_count: Some(0),
            scope_id: BOOKS_SCOPE_ID.to_string(),
            snapshot_version: 80,
            min_replayable_server_version: 20,
            entities: Vec::new(),
            tombstones: Vec::new(),
        };
        let novels_snapshot = SnapshotResponse {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            snapshot_id: Some("empty-novels-snapshot".to_string()),
            complete: Some(true),
            entity_count: Some(0),
            tombstone_count: Some(0),
            scope_id: "novels:profile:remote-main".to_string(),
            snapshot_version: 80,
            min_replayable_server_version: 20,
            entities: Vec::new(),
            tombstones: Vec::new(),
        };
        let mut profile = PersistedReplicationProfileState::default();
        let marker = stage_snapshot_recovery(
            &mut profile,
            &books_snapshot,
            &novels_snapshot,
            &snapshot,
            &changes,
            true,
        );
        assert_eq!(profile.pending_comic_reader_snapshot, marker);
        assert_eq!(profile.pending_comic_reader_changes.len(), changes.len());
        assert_eq!(
            profile.pending_comic_reader_changes[0].server_version,
            changes[0].server_version
        );
        assert_eq!(
            profile
                .comics_scope_checkpoint
                .as_ref()
                .unwrap()
                .last_applied_server_version,
            80
        );
    }

    #[test]
    fn hosted_local_authority_does_not_stage_redundant_comic_reader_inbox() {
        let empty_snapshot = |scope_id: &str| SnapshotResponse {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            snapshot_id: Some(format!("{scope_id}-snapshot")),
            complete: Some(true),
            entity_count: Some(0),
            tombstone_count: Some(0),
            scope_id: scope_id.to_string(),
            snapshot_version: 80,
            min_replayable_server_version: 20,
            entities: Vec::new(),
            tombstones: Vec::new(),
        };
        let books_snapshot = empty_snapshot(BOOKS_SCOPE_ID);
        let novels_snapshot = empty_snapshot("novels:profile:main");
        let comics_snapshot = empty_snapshot("comics:profile:main");
        let comic_change = ChangeEnvelope {
            server_version: 79,
            scope_id: comics_snapshot.scope_id.clone(),
            profile_id: Some("main".to_string()),
            entity_type: "comic.history".to_string(),
            entity_id: "history-1".to_string(),
            op: "merge".to_string(),
            lamport: 79,
            patch: Some(json!({ "pageIndex": 12 })),
            applied_at_ms: 79,
        };
        let mut profile = PersistedReplicationProfileState {
            pending_comic_reader_changes: vec![comic_change.clone()],
            pending_comic_reader_snapshot: Some(SyncdComicReaderSnapshotMarker {
                scope_id: comics_snapshot.scope_id.clone(),
                snapshot_version: 70,
            }),
            ..Default::default()
        };

        let marker = stage_snapshot_recovery(
            &mut profile,
            &books_snapshot,
            &novels_snapshot,
            &comics_snapshot,
            &[comic_change],
            false,
        );

        assert!(marker.is_none());
        assert!(profile.pending_comic_reader_changes.is_empty());
        assert!(profile.pending_comic_reader_snapshot.is_none());
        assert_eq!(
            profile
                .comics_scope_checkpoint
                .as_ref()
                .unwrap()
                .last_applied_server_version,
            80
        );
    }

    #[test]
    fn comic_reader_inbox_compacts_revisions_by_scoped_entity_identity() {
        let change = |scope: &str, entity_id: &str, server_version: i64, op: &str| ChangeEnvelope {
            server_version,
            scope_id: scope.to_string(),
            profile_id: Some("main".to_string()),
            entity_type: "comic.history".to_string(),
            entity_id: entity_id.to_string(),
            op: op.to_string(),
            lamport: server_version,
            patch: (op == "merge").then(|| json!({ "pageIndex": server_version })),
            applied_at_ms: server_version,
        };
        let mut pending = vec![
            change("comics:profile:main", "history-1", 10, "merge"),
            change("comics:profile:main", "history-2", 11, "merge"),
            change("comics:profile:main", "history-1", 12, "delete"),
            // An older replay arriving after the delete must not resurrect the entity.
            change("comics:profile:main", "history-1", 9, "merge"),
            // The same entity ID in another profile is a different durable state.
            change("comics:profile:secondary", "history-1", 13, "merge"),
        ];

        compact_pending_comic_reader_changes(&mut pending);

        assert_eq!(pending.len(), 3);
        assert_eq!(
            pending
                .iter()
                .find(|change| {
                    change.scope_id == "comics:profile:main" && change.entity_id == "history-1"
                })
                .map(|change| (change.server_version, change.op.as_str())),
            Some((12, "delete")),
        );
        assert!(pending
            .windows(2)
            .all(|window| window[0].server_version <= window[1].server_version));
    }

    fn receipt_fixture(
        status: MutationResultStatus,
    ) -> (SerializableMutationsRequest, MutationsResponse) {
        let mutation = SerializableMutationInput::ComicHistory {
            base: SerializableMutationBase {
                client_mutation_id: "mutation-1".to_string(),
                scope_id: "comics:profile:main".to_string(),
                entity_id: "history-1".to_string(),
                op: MutationOperation::Delete,
                lamport: 1,
            },
            patch: None,
        };
        let request = SerializableMutationsRequest {
            request_id: "request-1".to_string(),
            mutations: vec![mutation],
        };
        let response = MutationsResponse {
            request_id: "request-1".to_string(),
            current_server_version: 1,
            results: vec![MutationResult {
                client_mutation_id: "mutation-1".to_string(),
                entity_type: MutationEntityType::ComicHistory,
                entity_id: "history-1".to_string(),
                canonical_entity_id: None,
                scope_id: "comics:profile:main".to_string(),
                op: MutationOperation::Delete,
                status,
                applied_server_version: Some(1),
                applied_lamport: Some(1),
                event_clock: None,
                record: None,
                error: None,
            }],
        };
        (request, response)
    }

    #[test]
    fn mutation_receipts_accept_applied_or_superseded_terminal_results() {
        let (request, applied) = receipt_fixture(MutationResultStatus::Applied);
        validate_mutation_receipts(&request, &applied).unwrap();

        let (_, superseded) = receipt_fixture(MutationResultStatus::Superseded);
        validate_mutation_receipts(&request, &superseded).unwrap();

        let (_, rejected) = receipt_fixture(MutationResultStatus::Rejected);
        assert!(validate_mutation_receipts(&request, &rejected)
            .unwrap_err()
            .contains("rejected"));

        let (_, mut missing) = receipt_fixture(MutationResultStatus::Applied);
        missing.results.clear();
        assert!(validate_mutation_receipts(&request, &missing)
            .unwrap_err()
            .contains("omitted receipt"));
    }

    #[test]
    fn replication_state_roundtrip_uses_override_directory() {
        let temp = tempfile::tempdir().unwrap();
        let _env = crate::syncd_desktop::DesktopStateDirTestGuard::override_with(temp.path());
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
    }
}
