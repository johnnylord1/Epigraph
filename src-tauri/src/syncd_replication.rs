use std::cell::OnceCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use percent_encoding::percent_decode_str;
use reqwest::header::{CONTENT_LENGTH, ETAG};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::syncd::middleware::{
    ASSET_SHA256_HEADER, CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER, CURRENT_CLIENT_VERSION,
    LEGACY_ASSET_SHA256_HEADER, LEGACY_CLIENT_PROTOCOL_HEADER, LEGACY_CLIENT_VERSION_HEADER,
};
use crate::syncd::v4::db::{V4IncomingItem, V4WireRecord};
use crate::syncd::models::{
    canonical_novel_identity_key, canonical_novel_plugin_id, canonical_novel_repository_id,
    canonical_portable_chapter_id, canonical_portable_work_id, canonicalize_novel_repository_url,
    BookEntryPatch, ChangeEnvelope, ErrorBody, MutationOperation, NovelEntryPatch,
    NovelRepositoryPatch, PortableChapterRefV3, PortableWorkRefV3, SyncdEffectiveDiscoverySource,
};
use crate::syncd_desktop::{
    build_pinned_http_client, desktop_state_dir, is_connection_error, load_persisted_state,
    now_ms, revalidate_session, save_persisted_state, transport_error_message,
    PersistedSyncSession, SyncdDesktopConnectionStatus, SyncdDesktopPersistedState,
    SyncdReconnectStatus,
};
use crate::{
    book_library_state_path,
    novel_repository_state_path_for_target, LaunchTarget, LaunchTargetInfo,
};

const EVENT_REPLICATION_STATE: &str = "syncd-replication-state";
// This domain is hashed into the persisted comic-server fingerprint. It must
// stay stable across the product rename.
const COMIC_SERVER_IDENTITY_DOMAIN: &str = "aethon-core-suwayomi-v1";

#[derive(Clone)]
struct BookAssetEndpoint {
    client: reqwest::Client,
    origin: String,
    access_token: String,
    scope_id: String,
}

impl BookAssetEndpoint {
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
    // Runtime-only acknowledgement; never recovered from persisted Live state.
    pub remote_bootstrap_generation: Option<u64>,
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
    /// LNReader repositories and plugins the Core declares for this profile's novels, by entity
    /// id. The webview installs what is missing from the declared repository, never from Syncd.
    #[serde(default)]
    novel_dependency_declarations: BTreeMap<String, SyncdNovelDependencyDeclaration>,
    /// Novel dependency deletes the Core confirmed, by entity id, with the delete's Lamport.
    #[serde(default)]
    novel_dependency_tombstones: BTreeMap<String, i64>,
    /// Novel dependencies this desktop and the Core both held when last reconciled, by entity id,
    /// with the local state they had. Only these are removed here when another device deletes
    /// them, and only these are skipped when the session republishes the local state.
    #[serde(default)]
    novel_dependency_baseline: BTreeMap<String, String>,
    /// Novel dependencies removed here whose delete the Core has not confirmed yet, by entity id,
    /// with when the delete was sent. They are not installed again from the old declaration.
    #[serde(default)]
    novel_dependency_pending_deletes: BTreeMap<String, i64>,
    /// Novel plugins other devices reported through Sync V4, by plugin id. Each becomes a
    /// declaration once it can be tied to a declared repository.
    #[serde(default)]
    v4_novel_plugins: BTreeMap<String, V4NovelPluginReport>,
    per_entity_remote_clock: BTreeMap<String, i64>,
    last_local_snapshot_digest_books: Option<String>,
    last_local_snapshot_digest_novels: Option<String>,
    #[serde(default)]
    last_local_snapshot_digest_novel_categories: Option<String>,
    paused: bool,
    last_applied_scopes: Vec<String>,
    last_applied_at_ms: Option<i64>,
    /// The Core the checkpoints, clocks and digests above belong to. Server versions only mean
    /// something on the Core that issued them.
    #[serde(default)]
    cursor_owner: Option<String>,
}

impl PersistedReplicationProfileState {
    fn snapshot(&self, local_profile_id: &str) -> SyncdReplicationSnapshot {
        SyncdReplicationSnapshot {
            local_profile_id: local_profile_id.to_string(),
            active_session_key: self.active_session_key.clone(),
            replication_status: self.replication_status.clone(),
            last_connected_at_ms: self.last_connected_at_ms,
            remote_bootstrap_generation: None,
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
            novel_dependency_declarations: BTreeMap::new(),
            novel_dependency_tombstones: BTreeMap::new(),
            novel_dependency_baseline: BTreeMap::new(),
            novel_dependency_pending_deletes: BTreeMap::new(),
            v4_novel_plugins: BTreeMap::new(),
            per_entity_remote_clock: BTreeMap::new(),
            last_local_snapshot_digest_books: None,
            last_local_snapshot_digest_novels: None,
            last_local_snapshot_digest_novel_categories: None,
            paused: false,
            last_applied_scopes: Vec::new(),
            last_applied_at_ms: None,
            cursor_owner: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PersistedReplicationState {
    profiles: BTreeMap<String, PersistedReplicationProfileState>,
}

#[derive(Default)]
struct ReplicationRuntime {
    local_authority: HashMap<String, LocalAuthoritySession>,
    /// Going back to this desktop's own Core after a disconnect, per profile. It filters what it
    /// publishes against that Core, so it must not outlive the moment the profile joins another.
    authority_restores: HashMap<String, tauri::async_runtime::JoinHandle<()>>,
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

/// The cover the Core last streamed or accepted for this book.
fn core_book_cover_metadata(entry: &Value) -> Option<BookCoverAssetMetadata> {
    let book_id = canonical_book_id_for_entry(entry).or_else(|| book_entry_entity_id(entry))?;
    CORE_BOOK_ENTRIES
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&book_id)
        .and_then(cover_asset_metadata)
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
                // No local cover file and no cover fields in the write: the frontend does not
                // carry the synced cover, so its absence says nothing. Keep the Core's.
                None => core_book_cover_metadata(entry),
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
        .header(
            LEGACY_CLIENT_VERSION_HEADER.as_str(),
            CURRENT_CLIENT_VERSION,
        )
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
            .map_err(transport_error_message)?;
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

/// Asset scope the phone downloads book files and covers from.
const BOOKS_ASSET_SCOPE_ID: &str = "books:global";

/// Uploads one book's file and cover to the local Core so other devices can download them.
/// V4 only carries the book record; these bytes travel separately. Anything the Core already
/// stores is skipped before the local file is hashed, so a full pass over the library is cheap.
pub(crate) async fn upload_book_entry_assets_to_core(
    client: &reqwest::Client,
    origin: &str,
    access_token: &str,
    sha256: &str,
    entry: &Value,
) -> Result<(), String> {
    let endpoint = BookAssetEndpoint {
        client: client.clone(),
        origin: origin.trim_end_matches('/').to_string(),
        access_token: access_token.to_string(),
        scope_id: BOOKS_ASSET_SCOPE_ID.to_string(),
    };
    let sha256 = validate_asset_sha256(sha256)?;
    if remote_asset_size(&endpoint, &sha256).await?.is_none() {
        let path = value_string_field(entry, "assetPath")
            .filter(|path| !path.trim().is_empty())
            .ok_or_else(|| format!("Book {sha256} has no local file to upload."))?;
        upload_book_asset(&endpoint, Path::new(&path), &sha256).await?;
    }
    let cover_path = value_string_field(entry, "coverPath").filter(|path| !path.trim().is_empty());
    if let (Some(cover), Some(cover_path)) = (cover_asset_metadata(entry), cover_path) {
        if remote_asset_size(&endpoint, &cover.sha256).await?.is_none() {
            // `upload_book_asset` re-hashes the file, so a cover that changed since its metadata
            // was recorded is refused rather than published under the wrong fingerprint.
            upload_book_asset(&endpoint, Path::new(&cover_path), &cover.sha256).await?;
        }
    }
    Ok(())
}

/// Records the fingerprint of the book's local cover file in `entry`, so the cover can be
/// published and other devices can fetch it. Returns true when the recorded cover changed.
/// A book without a local cover file keeps whatever cover the Core gave it.
pub(crate) async fn refresh_local_book_cover_metadata(entry: &mut Value) -> Result<bool, String> {
    let Some(cover_path) = value_string_field(entry, "coverPath").filter(|path| !path.trim().is_empty())
    else {
        return Ok(false);
    };
    let Some(local) = inspect_local_book_cover(Path::new(&cover_path)).await? else {
        return Ok(false);
    };
    if cover_asset_metadata(entry).as_ref() == Some(&local) {
        return Ok(false);
    }
    apply_cover_asset_metadata(entry, Some(&local));
    Ok(true)
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
    .map_err(transport_error_message)?;
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

/// Shares the long-path-safe replace used by the runtime maintenance state.
fn replace_file_atomic(source: &Path, destination: &Path) -> io::Result<()> {
    crate::suwayomi_maintenance::atomic_replace_file(source, destination)
}

fn save_replication_state(state: &PersistedReplicationState) -> Result<(), String> {
    let path = replication_state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    write_file_atomic(&path, &payload)
}

// Atomic replacement protects a reader from partial JSON, but does not protect concurrent
// read/modify/write operations. All production writers share this short, synchronous gate.
static REPLICATION_STATE_WRITE_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn mutate_replication_state<T>(
    mutator: impl FnOnce(&mut PersistedReplicationState) -> Result<T, String>,
) -> Result<T, String> {
    let _gate = REPLICATION_STATE_WRITE_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = load_replication_state()?;
    let result = mutator(&mut state)?;
    save_replication_state(&state)?;
    Ok(result)
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

async fn emit_replication_state_for_profile(
    app: &AppHandle,
    profile_id: &str,
) -> Result<(), String> {
    let state = load_replication_state()?;
    let snapshot = profile_snapshot(&state, profile_id);
    app.emit(EVENT_REPLICATION_STATE, snapshot)
        .map_err(|error| error.to_string())
}


fn update_profile_state(
    profile_id: &str,
    mutator: impl FnOnce(&mut PersistedReplicationProfileState),
) -> Result<SyncdReplicationSnapshot, String> {
    mutate_replication_state(|state| {
        let profile = profile_state_mut(state, profile_id);
        mutator(profile);
        Ok(profile.snapshot(profile_id))
    })
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
    leave_local_authority(&state, &input.profile_id).await;
    ensure_worker_for_profile(&app, &state, &input.profile_id).await?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn syncd_pause_replication(
    input: SyncdReplicationProfileInput,
    app: AppHandle,
) -> Result<SyncdReplicationSnapshot, String> {
    let snapshot = update_profile_state(&input.profile_id, |profile| {
        profile.paused = true;
        profile.replication_status = SyncdReplicationStatus::Paused;
        profile.last_error = None;
    })?;
    cancel_worker_for_profile(&input.profile_id).await;
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
    mutate_replication_state(|replication| {
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
            !(session.local_profile_id == input.profile_id
                && session.session_key == input.session_key)
        });
        save_persisted_state(&persisted)?;
        let profile = profile_state_mut(replication, &input.profile_id);
        if profile.active_session_key.is_none()
            && choose_default_session(&persisted.sessions, &input.profile_id).is_none()
        {
            profile.replication_status = SyncdReplicationStatus::Idle;
            profile.last_error = None;
        }
        Ok(())
    })?;
    emit_replication_state_for_profile(&app, &input.profile_id).await?;
    Ok(())
}

// The fields are part of the command's JSON contract. The command only validates
// the payload today and returns an error, so nothing reads them yet.
#[allow(dead_code)]
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
    /// The id this bookmark has on the Core when another device created it. Devices name the same
    /// novel differently, so it cannot be worked out from the local ids.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sync_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SyncdNovelDependencyDeclaration {
    Repository(SyncdNovelRepositoryDeclaration),
    Plugin(SyncdNovelPluginDeclaration),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncdNovelRepositoryDeclaration {
    pub repository_id: String,
    pub canonical_url: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncdNovelPluginDeclaration {
    pub repository_id: String,
    pub plugin_id: String,
    pub version: String,
    pub enabled: bool,
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

/// Profiles this desktop hosts: known locally and not joined to a remote session.
fn local_authority_profiles(
    known_profiles: &HashSet<String>,
    replication: &PersistedReplicationState,
) -> Vec<String> {
    let mut profiles = known_profiles
        .iter()
        .filter(|profile_id| {
            replication
                .profiles
                .get(profile_id.as_str())
                .map_or(true, |profile| profile.active_session_key.is_none())
        })
        .cloned()
        .collect::<Vec<_>>();
    profiles.sort();
    profiles
}

pub async fn bootstrap_runtime(app: AppHandle, state: SyncdReplicationState) -> Result<(), String> {
    let desktop = load_persisted_state()?;
    let (replication, known_profiles) = mutate_replication_state(|replication| {
        let mut known_profiles = desktop
            .sessions
            .iter()
            .map(|session| session.local_profile_id.clone())
            .collect::<HashSet<_>>();
        known_profiles.extend(replication.profiles.keys().cloned());

        for profile_id in known_profiles.iter().cloned() {
            let profile = profile_state_mut(replication, &profile_id);
            reconcile_profile_sessions(profile, &desktop.sessions, &profile_id);
        }
        Ok((replication.clone(), known_profiles))
    })?;

    // A profile replicates either through this desktop's own Core (it hosts) or through a paired
    // remote session (it joined), never both: the local authority takes precedence for submits and
    // the worker, so granting it to a joined profile would divert its changes to the local Core.
    // The bind address does not decide this; a loopback Core (automation, or no LAN address at
    // startup) still hosts, and skipping it left a restarted host without its worker.
    if let Some(runtime) = crate::syncd_sidecar::current_runtime_info(&app) {
        for profile_id in local_authority_profiles(&known_profiles, &replication) {
            ensure_local_authority_for_profile(&app, &state, &profile_id, &runtime.local_base_url)
                .await?;
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
    // A join sets the active session before it takes this lock, so a grant that was waiting for it
    // sees the join here instead of taking the profile back to this desktop's own Core.
    if profile_joined_remote_core(
        &load_replication_state()?,
        &load_persisted_state()?.sessions,
        profile_id,
    ) {
        return Ok(());
    }
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
            device_id: desktop.device_id.clone(),
        })
        .send()
        .await
        .map_err(transport_error_message)?;
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
    // V4 publishes this Core's library through its own SQLite sync, so no JSON re-publish is needed.
    ensure_worker_for_profile(app, state, profile_id).await?;
    Ok(())
}

/// Starts the V4 worker for a profile this desktop hosts. Only a local Core has a V4 client, so a
/// joined remote session gets a clear error in its replication state and no V1 fallback.
async fn ensure_worker_for_profile(
    app: &AppHandle,
    state: &SyncdReplicationState,
    profile_id: &str,
) -> Result<(), String> {
    let authority = state.runtime.lock().await.local_authority.get(profile_id).cloned();
    match authority {
        Some(session) => {
            let device_id = load_persisted_state()?.device_id;
            crate::v4_desktop_sync::start_local_worker(
                app.clone(),
                profile_id.to_string(),
                session.local_base_url,
                session.access_token,
                device_id,
            )
            .await;
        }
        None => {
            update_profile_state(profile_id, |profile| {
                profile.replication_status = SyncdReplicationStatus::Degraded;
                profile.last_error = Some(REMOTE_SESSION_V4_UNAVAILABLE.to_string());
            })?;
        }
    }
    emit_replication_state_for_profile(app, profile_id).await
}

/// Shown for a joined remote session. Its Core has no V4 client yet, so nothing syncs for it.
const REMOTE_SESSION_V4_UNAVAILABLE: &str =
    "Sync with a remote Core needs a V4 client, which this desktop does not have yet. Local data is kept.";

/// Ends the V4 worker for a profile that is leaving its own Core.
async fn cancel_worker_for_profile(profile_id: &str) {
    crate::v4_desktop_sync::stop_local_worker(profile_id).await;
}

/// A profile replicates whenever it is not paused. A joined profile without V4 reports its error.
fn profile_state_needs_worker(profile: &PersistedReplicationProfileState) -> bool {
    !profile.paused
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
    let joined = snapshot.active_session_key.as_deref() == Some(session.session_key.as_str());
    if joined {
        leave_local_authority(state, &session.local_profile_id).await;
    }
    if joined && !snapshot.paused {
        ensure_worker_for_profile(app, state, &session.local_profile_id).await?;
    } else {
        emit_replication_state_for_profile(app, &session.local_profile_id).await?;
    }
    Ok(())
}

/// A profile replicates through its own Core or through a joined session, never both, and the local
/// authority wins wherever both are found. Joining therefore has to end it.
async fn leave_local_authority(state: &SyncdReplicationState, profile_id: &str) {
    {
        let mut runtime = state.runtime.lock().await;
        runtime.local_authority.remove(profile_id);
        if let Some(restore) = runtime.authority_restores.remove(profile_id) {
            restore.abort();
        }
    }
    // The V4 worker still running belongs to the Core this profile just left.
    cancel_worker_for_profile(profile_id).await;
}

fn profile_joined_remote_core(
    replication: &PersistedReplicationState,
    sessions: &[PersistedSyncSession],
    profile_id: &str,
) -> bool {
    let Some(active_key) = replication
        .profiles
        .get(profile_id)
        .and_then(|profile| profile.active_session_key.as_deref())
    else {
        return false;
    };
    sessions
        .iter()
        .any(|session| session.local_profile_id == profile_id && session.session_key == active_key)
}

/// Takes a profile that has no session left back to this desktop's own Core. It runs apart from the
/// disconnect because publishing a large library takes a while, and a later join aborts it.
async fn restore_local_authority(app: &AppHandle, state: &SyncdReplicationState, profile_id: &str) {
    let Some(core) = crate::syncd_sidecar::current_runtime_info(app) else {
        return;
    };
    let task_app = app.clone();
    let task_state = state.clone();
    let task_profile = profile_id.to_string();
    let mut runtime = state.runtime.lock().await;
    let task = tauri::async_runtime::spawn(async move {
        let restored = ensure_local_authority_for_profile(
            &task_app,
            &task_state,
            &task_profile,
            &core.local_base_url,
        )
        .await;
        if let Err(error) = restored {
            replication_log(format!(
                "restore_local_authority profile_id={task_profile} status=failed error={error}"
            ));
            return;
        }
        if !crate::v4_desktop_sync::is_profile_active(Some(&task_profile)).await {
            if let Err(error) =
                ensure_worker_for_profile(&task_app, &task_state, &task_profile).await
            {
                replication_log(format!(
                    "restore_local_authority profile_id={task_profile} status=no_worker error={error}"
                ));
            }
        }
    });
    if let Some(previous) = runtime
        .authority_restores
        .insert(profile_id.to_string(), task)
    {
        previous.abort();
    }
}

pub async fn handle_persisted_session_removed(
    app: &AppHandle,
    state: &SyncdReplicationState,
    profile_id: &str,
    session_key: &str,
) -> Result<(), String> {
    let desktop = load_persisted_state()?;
    let replication = mutate_replication_state(|replication| {
        let profile = profile_state_mut(replication, profile_id);
        if profile.active_session_key.as_deref() == Some(session_key) {
            profile.active_session_key = choose_default_session(&desktop.sessions, profile_id);
            profile.paused = false;
            profile.last_error = None;
            profile.replication_status = SyncdReplicationStatus::Idle;
        }
        Ok(replication.clone())
    })?;
    cancel_worker_for_profile(profile_id).await;
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
    let has_session = replication
        .profiles
        .get(profile_id)
        .is_some_and(|profile| profile.active_session_key.is_some());
    if !has_session {
        restore_local_authority(app, state, profile_id).await;
    }
    Ok(())
}

pub async fn notify_book_state_written(
    _app: &AppHandle,
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
    let mut next = serde_json::from_value::<PersistedBookLibraryState>(next_value.clone())
        .map_err(|error| error.to_string())?;
    if !frontend_included_history {
        next.book_history = previous.book_history.clone();
    }
    if !frontend_included_highlights {
        next.book_highlights = previous.book_highlights.clone();
    }
    // Writes land in order, and each one's metadata is filled in before the next is compared
    // against it.
    let _ordered = BOOK_STATE_NOTIFY_LOCK.lock().await;
    let mut previous = previous;
    // The previous write may not have had its Rust-owned metadata filled in yet. Filling it the
    // same way on both sides keeps that metadata from reading as an edit of every book.
    let previous_snapshot = previous.clone();
    let _ = enrich_book_asset_metadata(&previous_snapshot, &mut previous);
    let _ = enrich_book_cover_assets(&previous_snapshot, &mut previous).await;
    let remote_applies_kept = keep_remote_book_applies(&previous, &mut next);
    let unloaded_books_kept = keep_books_the_frontend_has_not_loaded(&previous, &mut next);
    let asset_metadata_changed = enrich_book_asset_metadata(&previous, &mut next)?;
    let cover_assets_changed = enrich_book_cover_assets(&previous, &mut next).await?;
    let projected_history_changed = project_latest_book_history(&previous, &mut next);
    if !frontend_included_history
        || !frontend_included_highlights
        || projected_history_changed
        || asset_metadata_changed
        || cover_assets_changed
        || remote_applies_kept
        || unloaded_books_kept
    {
        // Keep the Rust-owned history collection in the canonical JSON even
        // while the current frontend is unaware of that field. This write does
        // not call the Tauri command again, so it cannot recurse. A newer write
        // already on disk is left alone; its own notification fills it in.
        let expected = next_value.as_object().ok_or("Invalid book library state")?;
        let replacement = serde_json::to_string(&next).map_err(|error| error.to_string())?;
        crate::library_sqlite::save_if_current(
            &book_library_state_path()?,
            expected,
            &replacement,
        )?;
    }
    // Book changes reach the Core through the V4 SQLite path (`v4_desktop_sync`), not a JSON diff.
    drop(_ordered);
    Ok(())
}

static BOOK_STATE_NOTIFY_LOCK: Mutex<()> = Mutex::const_new(());

/// How long a delete sent from here keeps the old declaration from being installed again. A
/// delete the Core refused, because another device changed the entry later, stops blocking it.
const NOVEL_DEPENDENCY_PENDING_DELETE_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SyncdNovelDependencyRemoval {
    #[serde(rename_all = "camelCase")]
    Repository { local_repository_id: String },
    #[serde(rename_all = "camelCase")]
    Plugin { plugin_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncdNovelDependencySyncPlan {
    /// Declarations to install when missing here.
    pub declarations: Vec<SyncdNovelDependencyDeclaration>,
    /// Local entries another device deleted after both held them, plugins first.
    pub removals: Vec<SyncdNovelDependencyRemoval>,
}

#[derive(Debug, Clone)]
struct LocalNovelDependency {
    removal: SyncdNovelDependencyRemoval,
    fingerprint: String,
    /// When the entry was last written here; 0 when unknown.
    changed_at_ms: i64,
}

fn local_novel_dependencies(
    state: &PersistedNovelRepositoryState,
) -> BTreeMap<String, LocalNovelDependency> {
    let repositories = novel_repository_records(state);
    let mut local = BTreeMap::new();
    for repository in &state.repositories {
        let raw_url = if repository.normalized_url.trim().is_empty() {
            repository.url.as_str()
        } else {
            repository.normalized_url.as_str()
        };
        let Some(canonical_url) = canonicalize_novel_repository_url(raw_url) else {
            continue;
        };
        let entity_id = canonical_novel_repository_id(&canonical_url);
        let Some(record) = repositories.get(&entity_id) else {
            continue;
        };
        local
            .entry(entity_id)
            .or_insert_with(|| LocalNovelDependency {
                removal: SyncdNovelDependencyRemoval::Repository {
                    local_repository_id: repository.id.clone(),
                },
                fingerprint: format!("repository|{}|{}", record.canonical_url, record.enabled),
                changed_at_ms: 0,
            });
    }
    for (entity_id, (plugin, _)) in novel_plugin_identities(state, &repositories) {
        local
            .entry(entity_id)
            .or_insert_with(|| LocalNovelDependency {
                removal: SyncdNovelDependencyRemoval::Plugin {
                    plugin_id: plugin.plugin_id.trim().to_string(),
                },
                fingerprint: format!(
                    "plugin|{}|{}|{}",
                    plugin.version, plugin.enabled, plugin.updated_at_ms
                ),
                changed_at_ms: plugin.updated_at_ms.max(plugin.installed_at_ms).max(0),
            });
    }
    local
}

/// Brings the replica's view of the shared dependency list up to date with this desktop and says
/// what to install and what to remove here.
///
/// An entry leaves this desktop only when the Core confirmed its delete and both sides held it
/// before. A plugin installed here after that delete is the newer change and stays. Entries
/// removed here wait for the Core instead of being installed again from the old declaration.
fn plan_novel_dependency_sync(
    profile: &mut PersistedReplicationProfileState,
    state: &PersistedNovelRepositoryState,
    now_ms: i64,
) -> SyncdNovelDependencySyncPlan {
    let declared = &profile.novel_dependency_declarations;
    profile
        .novel_dependency_pending_deletes
        .retain(|entity_id, sent_at_ms| {
            declared.contains_key(entity_id)
                && now_ms.saturating_sub(*sent_at_ms) < NOVEL_DEPENDENCY_PENDING_DELETE_MS
        });
    let local = local_novel_dependencies(state);

    let mut plugin_removals = Vec::new();
    let mut repository_removals = Vec::new();
    let mut baseline = BTreeMap::new();
    for (entity_id, agreed) in &profile.novel_dependency_baseline {
        let (Some(deleted_at), Some(entry)) = (
            profile.novel_dependency_tombstones.get(entity_id),
            local.get(entity_id),
        ) else {
            continue;
        };
        if entry.changed_at_ms > *deleted_at {
            continue;
        }
        match entry.removal {
            SyncdNovelDependencyRemoval::Plugin { .. } => {
                plugin_removals.push(entry.removal.clone())
            }
            SyncdNovelDependencyRemoval::Repository { .. } => {
                repository_removals.push(entry.removal.clone())
            }
        }
        // Kept until the removal is written here.
        baseline.insert(entity_id.clone(), agreed.clone());
    }
    for (entity_id, entry) in &local {
        if declared.contains_key(entity_id) {
            baseline.insert(entity_id.clone(), entry.fingerprint.clone());
        }
    }
    profile.novel_dependency_baseline = baseline;

    let declarations = declared
        .iter()
        .filter(|(entity_id, _)| {
            !profile
                .novel_dependency_pending_deletes
                .contains_key(*entity_id)
        })
        .map(|(_, declaration)| declaration.clone())
        .collect();
    plugin_removals.extend(repository_removals);
    SyncdNovelDependencySyncPlan {
        declarations,
        removals: plugin_removals,
    }
}


/// A novel plugin another device reported through Sync V4. Phones send the plugin's site as
/// `repoUrl`, not its repository, so the repository is worked out when the plan is made.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V4NovelPluginReport {
    version: String,
    #[serde(default)]
    repo_url: Option<String>,
    enabled: bool,
}

fn local_repository_url(repository: &LocalNovelRepository) -> &str {
    if repository.normalized_url.trim().is_empty() {
        repository.url.as_str()
    } else {
        repository.normalized_url.as_str()
    }
}

/// `(entity id, canonical URL)` of a novel repository.
fn novel_repository_entity(raw_url: &str) -> Option<(String, String)> {
    let canonical_url = canonicalize_novel_repository_url(raw_url)?;
    Some((canonical_novel_repository_id(&canonical_url), canonical_url))
}

fn declared_plugin_entities(
    profile: &PersistedReplicationProfileState,
    plugin_id: &str,
) -> Vec<String> {
    profile
        .novel_dependency_declarations
        .iter()
        .filter(|(_, declaration)| {
            matches!(declaration, SyncdNovelDependencyDeclaration::Plugin(plugin) if plugin.plugin_id == plugin_id)
        })
        .map(|(entity_id, _)| entity_id.clone())
        .collect()
}

/// The declared repository a reported plugin comes from: the one the report names, else the one
/// whose catalog here lists the plugin, else the only declared repository. None when unclear.
fn v4_novel_plugin_repository(
    profile: &PersistedReplicationProfileState,
    state: &PersistedNovelRepositoryState,
    plugin_id: &str,
    report: &V4NovelPluginReport,
) -> Option<String> {
    let declared = profile
        .novel_dependency_declarations
        .values()
        .filter_map(|declaration| match declaration {
            SyncdNovelDependencyDeclaration::Repository(repository) => {
                Some(repository.repository_id.as_str())
            }
            SyncdNovelDependencyDeclaration::Plugin(_) => None,
        })
        .collect::<BTreeSet<_>>();
    if let Some((named, _)) = report.repo_url.as_deref().and_then(novel_repository_entity) {
        if declared.contains(named.as_str()) {
            return Some(named);
        }
    }
    let listing = state
        .catalog_entries
        .iter()
        .filter(|entry| entry.plugin_id.trim() == plugin_id)
        .filter_map(|entry| {
            state
                .repositories
                .iter()
                .find(|repository| repository.id == entry.repository_id)
        })
        .filter_map(|repository| novel_repository_entity(local_repository_url(repository)))
        .map(|(entity_id, _)| entity_id)
        .filter(|entity_id| declared.contains(entity_id.as_str()))
        .collect::<BTreeSet<_>>();
    match (listing.len(), declared.len()) {
        (1, _) => listing.into_iter().next(),
        (0, 1) => declared.into_iter().next().map(str::to_string),
        _ => None,
    }
}

fn v4_novel_records<'a>(
    records: &'a [V4WireRecord],
    entity_type: &'static str,
) -> impl Iterator<Item = (&'a V4WireRecord, &'a str)> {
    records.iter().filter_map(move |record| {
        let kind = record.payload.get("kind").and_then(Value::as_str);
        if record.domain != "extensions"
            || record.entity_type != entity_type
            || !kind.is_none_or(|kind| kind == "novel")
        {
            return None;
        }
        record
            .entity_key
            .strip_prefix("novel:")
            .map(|id| (record, id))
    })
}

/// Turns Sync V4 `extensions` records of kind `novel` into the declarations and confirmed deletes
/// `plan_novel_dependency_sync` works from. Returns whether any of them changed.
fn apply_v4_novel_dependency_records_to_profile(
    profile: &mut PersistedReplicationProfileState,
    state: &PersistedNovelRepositoryState,
    records: &[V4WireRecord],
) -> bool {
    let before = (
        profile.novel_dependency_declarations.clone(),
        profile.novel_dependency_tombstones.clone(),
        profile.v4_novel_plugins.clone(),
    );
    // Repositories first, so a plugin in the same batch finds its repository declared.
    for (record, key_url) in v4_novel_records(records, "extension.repo") {
        let raw_url = record
            .payload
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or(key_url);
        let Some((entity_id, canonical_url)) = novel_repository_entity(raw_url) else {
            continue;
        };
        if record.deleted {
            profile.novel_dependency_declarations.remove(&entity_id);
            profile
                .novel_dependency_tombstones
                .insert(entity_id, record.hlc.ts_ms);
            continue;
        }
        profile.novel_dependency_tombstones.remove(&entity_id);
        profile.novel_dependency_declarations.insert(
            entity_id.clone(),
            SyncdNovelDependencyDeclaration::Repository(SyncdNovelRepositoryDeclaration {
                repository_id: entity_id,
                canonical_url,
                enabled: record
                    .payload
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            }),
        );
    }
    let local = local_novel_dependencies(state);
    for (record, key_id) in v4_novel_records(records, "extension.installed") {
        let plugin_id = record
            .payload
            .get("packageId")
            .and_then(Value::as_str)
            .unwrap_or(key_id)
            .trim();
        if plugin_id.is_empty() {
            continue;
        }
        if record.deleted {
            profile.v4_novel_plugins.remove(plugin_id);
            let mut entities = declared_plugin_entities(profile, plugin_id)
                .into_iter()
                .collect::<BTreeSet<_>>();
            entities.extend(local.iter().filter_map(|(entity_id, entry)| {
                matches!(&entry.removal, SyncdNovelDependencyRemoval::Plugin { plugin_id: local_id } if local_id == plugin_id)
                    .then(|| entity_id.clone())
            }));
            for entity_id in entities {
                profile.novel_dependency_declarations.remove(&entity_id);
                profile
                    .novel_dependency_tombstones
                    .insert(entity_id, record.hlc.ts_ms);
            }
            continue;
        }
        let text = |key: &str| {
            record
                .payload
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
        };
        profile.v4_novel_plugins.insert(
            plugin_id.to_string(),
            V4NovelPluginReport {
                version: text("versionName").unwrap_or("").to_string(),
                repo_url: text("repoUrl").map(str::to_string),
                enabled: record
                    .payload
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            },
        );
    }
    // Every report is placed again, since a repository may arrive after its plugins.
    for (plugin_id, report) in profile.v4_novel_plugins.clone() {
        let Some(repository_id) = v4_novel_plugin_repository(profile, state, &plugin_id, &report)
        else {
            continue;
        };
        let entity_id = canonical_novel_plugin_id(&repository_id, &plugin_id, &plugin_id);
        for other in declared_plugin_entities(profile, &plugin_id) {
            if other != entity_id {
                profile.novel_dependency_declarations.remove(&other);
            }
        }
        profile.novel_dependency_tombstones.remove(&entity_id);
        profile.novel_dependency_declarations.insert(
            entity_id,
            SyncdNovelDependencyDeclaration::Plugin(SyncdNovelPluginDeclaration {
                repository_id,
                plugin_id,
                version: report.version,
                enabled: report.enabled,
            }),
        );
    }
    before
        != (
            profile.novel_dependency_declarations.clone(),
            profile.novel_dependency_tombstones.clone(),
            profile.v4_novel_plugins.clone(),
        )
}

/// Records the novel repositories and plugins other devices declared through Sync V4 and, when
/// that changed anything, asks the webview to install or remove them here.
pub fn apply_v4_novel_dependency_records(
    app: &AppHandle,
    profile_id: &str,
    records: &[V4WireRecord],
) -> Result<(), String> {
    if !records.iter().any(|record| record.domain == "extensions") {
        return Ok(());
    }
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let current = read_novel_repository_state(&launch_target, profile_id)?;
    let snapshot = mutate_replication_state(|state| {
        let profile = profile_state_mut(state, profile_id);
        if !apply_v4_novel_dependency_records_to_profile(profile, &current, records) {
            return Ok(None);
        }
        profile.last_applied_scopes = vec![format!("novels:profile:{profile_id}")];
        profile.last_applied_at_ms = Some(now_ms());
        Ok(Some(profile.snapshot(profile_id)))
    })?;
    if let Some(snapshot) = snapshot {
        let _ = app.emit(EVENT_REPLICATION_STATE, snapshot);
    }
    Ok(())
}

/// Repositories and plugins removed here wait for the Core to confirm their delete, so the
/// declaration another device sent earlier does not install them again in the meantime.
pub fn note_v4_novel_dependency_deletes(
    profile_id: &str,
    items: &[V4IncomingItem],
) -> Result<(), String> {
    if !items
        .iter()
        .any(|item| item.deleted && item.domain == "extensions")
    {
        return Ok(());
    }
    let now = now_ms();
    mutate_replication_state(|state| {
        if let Some(profile) = state.profiles.get_mut(profile_id) {
            note_novel_dependency_deletes(profile, items, now);
        }
        Ok(())
    })
}

fn note_novel_dependency_deletes(
    profile: &mut PersistedReplicationProfileState,
    items: &[V4IncomingItem],
    now: i64,
) {
    for item in items
        .iter()
        .filter(|item| item.deleted && item.domain == "extensions")
    {
        let Some(id) = item.entity_key.strip_prefix("novel:") else {
            continue;
        };
        let entities = match item.entity_type.as_str() {
            "extension.repo" => novel_repository_entity(id)
                .map(|(entity_id, _)| entity_id)
                .into_iter()
                .collect(),
            "extension.installed" => declared_plugin_entities(profile, id),
            _ => Vec::new(),
        };
        for entity_id in entities {
            if profile.novel_dependency_declarations.contains_key(&entity_id) {
                profile
                    .novel_dependency_pending_deletes
                    .insert(entity_id, now);
            }
        }
    }
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
    _app: AppHandle,
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
    // Comic reader state reaches the Core through the V4 path, which has no publish command for it
    // yet. The legacy JSON submit was removed, so nothing is written here.
    Err("Comic reader changes cannot be published yet: the V4 sync path has no command for them.".to_string())
}

/// The paired session a joined profile reaches the other desktop's comics through. A profile
/// whose comics this desktop's own Core hosts, or whose sync is paused, has none.
async fn joined_comic_session(
    app: &AppHandle,
    profile_id: &str,
) -> Result<Option<PersistedSyncSession>, String> {
    let hosted = {
        let state = app.state::<SyncdReplicationState>();
        let runtime = state.runtime.lock().await;
        runtime.local_authority.contains_key(profile_id)
    };
    if hosted {
        return Ok(None);
    }
    let replication = load_replication_state()?;
    let Some(active_session_key) = replication
        .profiles
        .get(profile_id)
        .filter(|profile| !profile.paused)
        .and_then(|profile| profile.active_session_key.clone())
    else {
        return Ok(None);
    };
    Ok(load_persisted_state()?
        .sessions
        .into_iter()
        .find(|session| {
            session.local_profile_id == profile_id && session.session_key == active_session_key
        }))
}

async fn required_joined_comic_session(
    app: &AppHandle,
    profile_id: &str,
) -> Result<PersistedSyncSession, String> {
    let profile_id = profile_id.trim();
    if profile_id.is_empty() || profile_id.contains('\0') {
        return Err("profileId is invalid.".to_string());
    }
    joined_comic_session(app, profile_id)
        .await?
        .ok_or_else(|| "This profile has no paired desktop for comics.".to_string())
}

/// Posts to the other desktop's comics bridge, trying its known addresses in order, and answers
/// with the bridge's JSON body.
async fn post_remote_comic_bridge(
    session: &PersistedSyncSession,
    path: &str,
    body: &Value,
) -> Result<Value, String> {
    let client = build_pinned_http_client(&session.tls_cert_sha256)?;
    let scope_id = comics_scope_id(&session.remote_profile_id);
    let origins = session_origins(session);
    let mut last_error = None;
    for (index, origin) in origins.iter().enumerate() {
        let response = client
            .post(format!("{origin}{path}"))
            .query(&[("scopeId", scope_id.as_str())])
            .header("Authorization", format!("Bearer {}", session.access_token))
            .header(CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
            .header(
                LEGACY_CLIENT_VERSION_HEADER.as_str(),
                CURRENT_CLIENT_VERSION,
            )
            .header(
                CLIENT_PROTOCOL_HEADER.as_str(),
                CLIENT_PROTOCOL_VERSION.to_string(),
            )
            .header(
                LEGACY_CLIENT_PROTOCOL_HEADER.as_str(),
                CLIENT_PROTOCOL_VERSION.to_string(),
            )
            .json(body)
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                return response.json::<Value>().await.map_err(|error| {
                    format!("Invalid comics answer from the other computer: {error}")
                });
            }
            Ok(response) => {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                return Err(match serde_json::from_str::<ErrorBody>(&text) {
                    Ok(body) if body.error.code == "UNAUTHORIZED" => "needs_reauth".to_string(),
                    Ok(body) => format!("{}: {}", body.error.code, body.error.message),
                    Err(_) => format!("The other computer answered HTTP {status}."),
                });
            }
            Err(error) => {
                let message = transport_error_message(error);
                if is_connection_error(&message) && index + 1 < origins.len() {
                    last_error = Some(message);
                    continue;
                }
                return Err(message);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "The other computer is unreachable.".to_string()))
}

/// Whether this profile's comics come from another desktop through a paired session. Its Core
/// mirrors only reading state, so the webview reconciles both Suwayomi libraries itself.
#[tauri::command]
pub async fn syncd_comic_bridge_available(
    app: AppHandle,
    profile_id: String,
) -> Result<bool, String> {
    let profile_id = profile_id.trim();
    if profile_id.is_empty() || profile_id.contains('\0') {
        return Err("profileId is invalid.".to_string());
    }
    Ok(joined_comic_session(&app, profile_id).await?.is_some())
}

/// Reads the other desktop's Suwayomi. Its Core refuses mutations here; changes go through
/// `syncd_remote_comic_command`.
#[tauri::command]
pub async fn syncd_remote_comic_query(
    app: AppHandle,
    profile_id: String,
    query: String,
    variables: Option<Value>,
) -> Result<Value, String> {
    let session = required_joined_comic_session(&app, &profile_id).await?;
    let body = post_remote_comic_bridge(
        &session,
        "/v1/suwayomi/api/graphql",
        &json!({ "query": query, "variables": variables.unwrap_or_else(|| json!({})) }),
    )
    .await?;
    if let Some(error) = body
        .get("errors")
        .and_then(Value::as_array)
        .and_then(|errors| errors.first())
    {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The other computer's comics query failed.")
            .to_string());
    }
    Ok(body.get("data").cloned().unwrap_or(Value::Null))
}

/// Runs one of the Core's typed Suwayomi commands on the other desktop.
#[tauri::command]
pub async fn syncd_remote_comic_command(
    app: AppHandle,
    profile_id: String,
    operation: String,
    variables: Value,
) -> Result<Value, String> {
    let session = required_joined_comic_session(&app, &profile_id).await?;
    let body = post_remote_comic_bridge(
        &session,
        "/v1/suwayomi/commands",
        &json!({ "operation": operation, "variables": variables }),
    )
    .await?;
    Ok(body.get("data").cloned().unwrap_or(Value::Null))
}

/// One file per profile and paired desktop, so pairing with another desktop starts from a merge
/// instead of reading the old one's removals into the new one.
fn comic_sync_baseline_path(session: &PersistedSyncSession) -> PathBuf {
    let key = hash_digest(&format!(
        "{}\0{}\0{}",
        session.local_profile_id, session.remote_server_id, session.remote_profile_id
    ));
    desktop_state_dir()
        .join("comic-sync")
        .join(format!("{}.json", &key[..32]))
}

/// What both desktops held after the last comics reconciliation, so the next one can tell an
/// addition on one side from a removal on the other.
#[tauri::command]
pub async fn syncd_read_comic_sync_baseline(
    app: AppHandle,
    profile_id: String,
) -> Result<Option<Value>, String> {
    let session = required_joined_comic_session(&app, &profile_id).await?;
    match fs::read(comic_sync_baseline_path(&session)) {
        // An unreadable baseline only costs a merge without removals.
        Ok(bytes) => Ok(serde_json::from_slice::<Value>(&bytes)
            .ok()
            .filter(Value::is_object)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn syncd_write_comic_sync_baseline(
    app: AppHandle,
    profile_id: String,
    baseline: Value,
) -> Result<(), String> {
    if !baseline.is_object() {
        return Err("baseline must be a JSON object.".to_string());
    }
    let session = required_joined_comic_session(&app, &profile_id).await?;
    let path = comic_sync_baseline_path(&session);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_vec(&baseline).map_err(|error| error.to_string())?;
    write_file_atomic(&path, &payload)
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

/// Novel repositories and plugins the paired devices declared, for the webview to install.
#[tauri::command]
pub fn syncd_get_novel_dependency_declarations(
    profile_id: String,
) -> Result<Vec<SyncdNovelDependencyDeclaration>, String> {
    let profile_id = profile_id.trim();
    if profile_id.is_empty() || profile_id.contains('\0') {
        return Err("profileId is invalid.".to_string());
    }
    Ok(load_replication_state()?
        .profiles
        .get(profile_id)
        .map(|profile| {
            profile
                .novel_dependency_declarations
                .values()
                .cloned()
                .collect()
        })
        .unwrap_or_default())
}

/// What to install and remove here so this desktop and the paired devices keep one list of novel
/// repositories and plugins.
#[tauri::command]
pub fn syncd_plan_novel_dependency_sync(
    app: AppHandle,
    profile_id: String,
) -> Result<SyncdNovelDependencySyncPlan, String> {
    let profile_id = profile_id.trim();
    if profile_id.is_empty() || profile_id.contains(' ') {
        return Err("profileId is invalid.".to_string());
    }
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let current = read_novel_repository_state(&launch_target, profile_id)?;
    mutate_replication_state(|state| {
        let Some(profile) = state.profiles.get_mut(profile_id) else {
            return Ok(SyncdNovelDependencySyncPlan {
                declarations: Vec::new(),
                removals: Vec::new(),
            });
        };
        let plan = plan_novel_dependency_sync(profile, &current, now_ms());
        Ok(plan)
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
    mutate_replication_state(|replication| {
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
        }
        Ok(())
    })
}

/// Books a remote apply added that the frontend has not loaded yet, with what the apply wrote.
/// The frontend writes its own copy of the books back whole, and a copy taken before the apply
/// lacks the book. That absence is not a removal: published as one, it deleted the book on every
/// device. The frontend can only remove a book it has.
static UNLOADED_REMOTE_BOOKS: std::sync::Mutex<BTreeMap<String, Value>> =
    std::sync::Mutex::new(BTreeMap::new());


/// The frontend read the books state: the books in it are now its own to keep or remove.
pub fn note_book_state_loaded_by_frontend(contents: &str) {
    let Ok(state) = serde_json::from_str::<Value>(contents) else {
        return;
    };
    let Some(books) = state.get("books").and_then(Value::as_array) else {
        return;
    };
    let mut unloaded = UNLOADED_REMOTE_BOOKS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    for entry in books {
        if let Some(book_id) = book_entry_entity_id(entry) {
            unloaded.remove(&book_id);
        }
    }
}

/// Puts back the books a remote apply added after the frontend last loaded the state, with their
/// progress, bookmarks and category assignment, when its write lacks them.
fn keep_books_the_frontend_has_not_loaded(
    previous: &PersistedBookLibraryState,
    next: &mut PersistedBookLibraryState,
) -> bool {
    let mut unloaded = UNLOADED_REMOTE_BOOKS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if unloaded.is_empty() {
        return false;
    }
    let in_next: HashSet<String> = next.books.iter().filter_map(book_entry_entity_id).collect();
    // A write that has the book came from a frontend that loaded it.
    unloaded.retain(|book_id, _| !in_next.contains(book_id));
    let mut kept = false;
    for (book_id, applied) in unloaded.iter() {
        let entry = previous
            .books
            .iter()
            .find(|entry| book_entry_entity_id(entry).as_deref() == Some(book_id.as_str()))
            .unwrap_or(applied);
        next.books.push(entry.clone());
        if !next
            .book_progress
            .iter()
            .any(|progress| &progress.book_id == book_id)
        {
            next.book_progress.extend(
                previous
                    .book_progress
                    .iter()
                    .filter(|progress| &progress.book_id == book_id)
                    .cloned(),
            );
        }
        let next_bookmarks: HashSet<String> = next
            .book_bookmarks
            .iter()
            .map(bookmark_entity_id_for_book)
            .collect();
        next.book_bookmarks.extend(
            previous
                .book_bookmarks
                .iter()
                .filter(|bookmark| {
                    &bookmark.book_id == book_id
                        && !next_bookmarks.contains(&bookmark_entity_id_for_book(bookmark))
                })
                .cloned(),
        );
        if let Some(category_ids) = previous.books_category_assignments.get(book_id) {
            next.books_category_assignments
                .entry(book_id.clone())
                .or_insert_with(|| category_ids.clone());
        }
        kept = true;
    }
    kept
}

/// The book entry fields a remote apply writes; every other field belongs to this desktop.
const BOOK_ENTRY_SYNCED_FIELDS: &[&str] = &[
    "assetFingerprint",
    "mimeType",
    "byteSize",
    "coverAssetSha256",
    "coverAssetByteSize",
    "coverAssetMimeType",
    "title",
    "author",
    "description",
    "subtype",
    "pageCount",
    "createdAt",
    "updatedAt",
    "tocCount",
    "spineCount",
    "sectionsSummary",
    "sectionCount",
    "hasCover",
];

/// A book entry a remote apply changed: the synced fields it replaced and the ones it wrote.
struct RemoteBookApply {
    superseded: Vec<Value>,
    applied: Value,
}

/// The frontend keeps its own copy of the books until it reloads them after an apply. A write it
/// makes in between still carries the replaced fields and would publish them as a revert of the
/// other device's change, which that device then reapplies, and so on.
/// Last book entry state the Core accepted, per book. Feeds the cover guard in the save path.
static CORE_BOOK_ENTRIES: std::sync::Mutex<BTreeMap<String, Value>> =
    std::sync::Mutex::new(BTreeMap::new());

static REMOTE_BOOK_APPLIES: std::sync::Mutex<BTreeMap<String, RemoteBookApply>> =
    std::sync::Mutex::new(BTreeMap::new());


/// Keeps what a remote apply wrote when the frontend writes a book back with the fields that apply
/// replaced. A book the frontend changed in any other way is its own edit and goes through.
fn keep_remote_book_applies(
    previous: &PersistedBookLibraryState,
    next: &mut PersistedBookLibraryState,
) -> bool {
    let mut applies = REMOTE_BOOK_APPLIES
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if applies.is_empty() {
        return false;
    }
    let on_disk: BTreeMap<String, (&Value, Value)> = previous
        .books
        .iter()
        .filter_map(|entry| {
            let (book_id, patch) = book_entry_patch_value(entry)?;
            Some((book_id, (entry, patch)))
        })
        .collect();
    let mut kept = false;
    for entry in &mut next.books {
        let Some((book_id, patch)) = book_entry_patch_value(entry) else {
            continue;
        };
        let Some(apply) = applies.get(&book_id) else {
            continue;
        };
        if patch == apply.applied || !apply.superseded.contains(&patch) {
            // The frontend reloaded the apply, or edited the book after it.
            applies.remove(&book_id);
            continue;
        }
        let Some((disk_entry, disk_patch)) = on_disk.get(&book_id) else {
            continue;
        };
        if *disk_patch != apply.applied {
            continue;
        }
        if let (Some(target), Some(source)) = (entry.as_object_mut(), disk_entry.as_object()) {
            for field in BOOK_ENTRY_SYNCED_FIELDS {
                match source.get(*field) {
                    Some(value) => {
                        target.insert((*field).to_string(), value.clone());
                    }
                    None => {
                        target.remove(*field);
                    }
                }
            }
            kept = true;
        }
    }
    kept
}

// The desktop keeps one Books category list for books and novels, so `novel.category` records
// land in the same `booksCategories` / `booksCategoryAssignments` the Books library renders.
/// A chapter id written by another device in the form `chapter:<novel>:<encoded path>`.
fn novel_chapter_path_from_local_id(chapter_id: &str) -> Option<String> {
    let encoded = chapter_id.strip_prefix("chapter:")?.rsplit(':').next()?;
    percent_decode_str(encoded)
        .decode_utf8()
        .ok()
        .map(|path| path.into_owned())
}

/// What this desktop calls its novels and chapters, to read the ids other devices write.
struct NovelReferenceIndex<'a> {
    entries: &'a [Value],
    novel_ids: BTreeSet<String>,
    /// Local novel id -> its chapters as (local id, path).
    chapters_by_novel: BTreeMap<String, Vec<(String, String)>>,
    /// Hashing every novel is only worth it once a record names one that is not a local id.
    canonical_novels: OnceCell<BTreeMap<String, String>>,
}

impl<'a> NovelReferenceIndex<'a> {
    fn new(entries: &'a [Value], chapters: &[Value]) -> Self {
        let mut chapters_by_novel: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
        for chapter in chapters {
            let (Some(novel_id), Some(id), Some(path)) = (
                value_string_field(chapter, "novelId"),
                novel_chapter_entity_id(chapter),
                value_string_field(chapter, "path"),
            ) else {
                continue;
            };
            chapters_by_novel
                .entry(novel_id)
                .or_default()
                .push((id, path));
        }
        Self {
            entries,
            novel_ids: entries.iter().filter_map(novel_entry_entity_id).collect(),
            chapters_by_novel,
            canonical_novels: OnceCell::new(),
        }
    }

    fn local_novel_id(&self, novel_id: &str) -> Option<String> {
        if self.novel_ids.contains(novel_id) {
            return Some(novel_id.to_string());
        }
        self.canonical_novels
            .get_or_init(|| {
                self.entries
                    .iter()
                    .filter_map(|entry| {
                        Some((
                            canonical_novel_id_for_entry(entry)?,
                            novel_entry_entity_id(entry)?,
                        ))
                    })
                    .collect()
            })
            .get(novel_id)
            .cloned()
    }

    fn local_chapter_id(&self, local_novel_id: &str, chapter_id: &str) -> Option<String> {
        let chapters = self.chapters_by_novel.get(local_novel_id)?;
        if chapters.iter().any(|(id, _)| id == chapter_id) {
            return Some(chapter_id.to_string());
        }
        if let Some(path) = novel_chapter_path_from_local_id(chapter_id) {
            return chapters
                .iter()
                .find(|(_, candidate)| *candidate == path)
                .map(|(id, _)| id.clone());
        }
        let work = self
            .entries
            .iter()
            .find(|entry| novel_entry_entity_id(entry).as_deref() == Some(local_novel_id))
            .and_then(portable_novel_work_ref_from_entry)?;
        chapters.iter().find_map(|(id, path)| {
            let reference = PortableChapterRefV3::Novel {
                work: work.clone(),
                chapter_key: path.clone(),
            };
            (canonical_portable_chapter_id(&reference) == chapter_id).then(|| id.clone())
        })
    }

    fn heal(&self, novel_id: &mut String, chapter_id: &mut Option<String>) -> bool {
        let mut changed = false;
        if let Some(local) = self
            .local_novel_id(novel_id)
            .filter(|local| local != novel_id)
        {
            *novel_id = local;
            changed = true;
        }
        let local_chapter = chapter_id
            .as_deref()
            .and_then(|chapter| self.local_chapter_id(novel_id, chapter));
        if local_chapter.is_some() && local_chapter != *chapter_id {
            *chapter_id = local_chapter;
            changed = true;
        }
        changed
    }
}

/// Points progress, bookmarks and history written by other devices at the novels and chapters this
/// desktop holds. Anything it cannot place yet stays as it is and is tried again on the next change.
/// Returns whether anything changed; running it again changes nothing.
fn heal_novel_references(state: &mut PersistedNovelLibraryState) -> bool {
    let index = NovelReferenceIndex::new(&state.entries, &state.chapters);
    let mut changed = false;
    for entry in &mut state.progress {
        changed |= index.heal(&mut entry.novel_id, &mut entry.chapter_id);
    }
    for entry in &mut state.bookmarks {
        changed |= index.heal(&mut entry.novel_id, &mut entry.chapter_id);
    }
    for entry in &mut state.history {
        let Some(mut novel_id) = value_string_field(entry, "novelId") else {
            continue;
        };
        let mut chapter_id = value_string_field(entry, "chapterId");
        if index.heal(&mut novel_id, &mut chapter_id) {
            entry["novelId"] = json!(novel_id);
            entry["chapterId"] = json!(chapter_id);
            changed = true;
        }
    }

    // Once healed, two records can turn out to be the same one; the newest stays.
    let mut progress_positions: BTreeMap<String, usize> = BTreeMap::new();
    let mut unique_progress: Vec<LocalNovelProgress> = Vec::with_capacity(state.progress.len());
    for entry in std::mem::take(&mut state.progress) {
        match progress_positions.get(&entry.novel_id) {
            Some(&position) => {
                if entry.updated_at >= unique_progress[position].updated_at {
                    unique_progress[position] = entry;
                }
                changed = true;
            }
            None => {
                progress_positions.insert(entry.novel_id.clone(), unique_progress.len());
                unique_progress.push(entry);
            }
        }
    }
    state.progress = unique_progress;

    let mut bookmark_positions: BTreeMap<String, usize> = BTreeMap::new();
    let mut unique_bookmarks: Vec<LocalNovelBookmark> = Vec::with_capacity(state.bookmarks.len());
    for mut entry in std::mem::take(&mut state.bookmarks) {
        let key = bookmark_entity_id_for_novel(&entry);
        match bookmark_positions.get(&key) {
            Some(&position) => {
                let kept = &mut unique_bookmarks[position];
                // Keeps a Core id whichever copy wins, so removing the bookmark reaches that row.
                if entry.saved_at >= kept.saved_at {
                    entry.sync_id = entry.sync_id.take().or_else(|| kept.sync_id.take());
                    *kept = entry;
                } else {
                    kept.sync_id = kept.sync_id.take().or_else(|| entry.sync_id.take());
                }
                changed = true;
            }
            None => {
                bookmark_positions.insert(key, unique_bookmarks.len());
                unique_bookmarks.push(entry);
            }
        }
    }
    state.bookmarks = unique_bookmarks;
    changed
}

/// The state the app is about to save with its references healed, or `None` when nothing changes.
/// Listing a novel from its plugin creates the chapters that bookmarks and history were waiting for.
pub fn heal_novel_state_contents(contents: &str) -> Option<String> {
    let mut state = serde_json::from_str::<PersistedNovelLibraryState>(contents).ok()?;
    if !heal_novel_references(&mut state) {
        return None;
    }
    serde_json::to_string_pretty(&state).ok()
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

// The desktop orders novel chapters by list position from 0; the Core and the phone read
// chapterOrderKey as the chapter number, which starts at 1.
// Helpers kept from the V1 module for the V4-backed book/novel save path.
const ASSET_STREAM_CHUNK_SIZE: usize = 64 * 1024;

const CLIENT_PROTOCOL_VERSION: u32 = 1;

fn book_entry_entity_id(value: &Value) -> Option<String> {
    value_string_field(value, "id")
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

fn novel_entry_entity_id(value: &Value) -> Option<String> {
    value_string_field(value, "id")
}

fn portable_novel_work_ref_from_entry(entry: &Value) -> Option<PortableWorkRefV3> {
    portable_novel_work_ref(entry.get("source")?, &value_string_field(entry, "path")?)
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
fn value_bool_field(value: &Value, field: &str, default: bool) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(default)
}

// Helpers kept from the V1 module, used by the V4-backed book/novel paths.
/// The synchronized fields of a desktop book entry, keyed the way its mutations are.
fn book_entry_patch_value(entry: &Value) -> Option<(String, Value)> {
    let book_id = canonical_book_id_for_entry(entry).or_else(|| book_entry_entity_id(entry))?;
    let patch = serde_json::to_value(build_book_entry_patch(entry)?).ok()?;
    Some((book_id, patch))
}

fn book_history_entity_id(book_id: &str) -> String {
    format!("book.history::{book_id}")
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

/// Canonical Syncd novel id for a desktop library entry, the id `novel.*` records carry.
fn canonical_novel_id_for_entry(entry: &Value) -> Option<String> {
    portable_novel_work_ref_from_entry(entry)
        .map(|reference| canonical_portable_work_id(&reference))
        .or_else(|| build_novel_entry_patch(entry).map(|patch| patch.identity_key))
}

fn novel_chapter_entity_id(value: &Value) -> Option<String> {
    value_string_field(value, "id")
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

/// Named after the owner of the repository path, the same way the mobile LNReader backup
/// converter names it, because every GitHub-hosted repository shares one host.
fn novel_repository_display_name(canonical_url: &str) -> String {
    let owner = url::Url::parse(canonical_url).ok().and_then(|url| {
        url.path_segments()?
            .find(|segment| !segment.is_empty())
            .map(ToString::to_string)
    });
    match owner {
        Some(owner) if !owner.eq_ignore_ascii_case("lnreader") => format!("{owner} plugins"),
        _ => "LNReader plugins".to_string(),
    }
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
            let name = novel_repository_display_name(&canonical_url);
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

fn portable_novel_work_ref(source: &Value, novel_key: &str) -> Option<PortableWorkRefV3> {
    let plugin_id = value_string_field(source, "pluginId")?;
    let reference = PortableWorkRefV3::Novel {
        plugin_id,
        novel_key: novel_key.to_string(),
    };
    reference.validate().ok()?;
    Some(reference)
}

/// The addresses of a joined Core, the current one first.
fn session_origins(session: &PersistedSyncSession) -> Vec<String> {
    let mut origins = vec![session.canonical_origin.clone()];
    for origin in &session.fallback_origins {
        if !origins.contains(origin) {
            origins.push(origin.clone());
        }
    }
    origins
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

#[cfg(test)]
mod tests {
    /// A Core asset store that answers HEAD/PUT `/v1/assets/{sha}` for one scope.
    async fn spawn_asset_store() -> (
        String,
        std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>>,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) {
        use axum::extract::{Path as AxumPath, Query, State};
        use axum::http::{HeaderMap, StatusCode};
        use axum::response::IntoResponse;
        use axum::routing::head;
        use std::sync::{Arc, Mutex};

        type Store = Arc<Mutex<std::collections::HashMap<String, Vec<u8>>>>;
        type Log = Arc<Mutex<Vec<String>>>;

        fn present(sha: &str, len: usize) -> axum::response::Response {
            let mut headers = HeaderMap::new();
            headers.insert(super::ASSET_SHA256_HEADER, sha.parse().unwrap());
            headers.insert(reqwest::header::ETAG, format!("\"{sha}\"").parse().unwrap());
            headers.insert(reqwest::header::CONTENT_LENGTH, len.into());
            (StatusCode::OK, headers).into_response()
        }
        fn authorized(headers: &HeaderMap, query: &std::collections::HashMap<String, String>) -> bool {
            headers.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer token-1")
                && query.get("scopeId").map(String::as_str) == Some("books:global")
        }

        let store: Store = Arc::default();
        let log: Log = Arc::default();
        let app = axum::Router::new()
            .route(
                "/v1/assets/:sha",
                head(
                    |State((store, log)): State<(Store, Log)>,
                     AxumPath(sha): AxumPath<String>,
                     Query(query): Query<std::collections::HashMap<String, String>>,
                     headers: HeaderMap| async move {
                        log.lock().unwrap().push(format!("HEAD {sha}"));
                        if !authorized(&headers, &query) {
                            return StatusCode::UNAUTHORIZED.into_response();
                        }
                        match store.lock().unwrap().get(&sha) {
                            Some(bytes) => present(&sha, bytes.len()),
                            None => StatusCode::NOT_FOUND.into_response(),
                        }
                    },
                )
                .put(
                    |State((store, log)): State<(Store, Log)>,
                     AxumPath(sha): AxumPath<String>,
                     Query(query): Query<std::collections::HashMap<String, String>>,
                     headers: HeaderMap,
                     body: axum::body::Bytes| async move {
                        log.lock().unwrap().push(format!("PUT {sha}"));
                        if !authorized(&headers, &query) {
                            return StatusCode::UNAUTHORIZED.into_response();
                        }
                        store.lock().unwrap().insert(sha, body.to_vec());
                        StatusCode::CREATED.into_response()
                    },
                ),
            )
            .with_state((store.clone(), log.clone()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (origin, store, log)
    }

    #[tokio::test]
    async fn v4_book_upload_sends_the_file_and_cover_once() {
        use super::*;

        let dir = tempfile::tempdir().unwrap();
        let book_path = dir.path().join("book.epub");
        std::fs::write(&book_path, b"epub bytes").unwrap();
        let cover_path = dir.path().join("cover.png");
        std::fs::write(
            &cover_path,
            [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3],
        )
        .unwrap();
        let book_sha = sha256_file_async(book_path.clone()).await.unwrap();
        let mut entry = json!({
            "id": "b1", "assetFingerprint": book_sha, "subtype": "epub",
            "assetPath": book_path.to_string_lossy(),
            "coverPath": cover_path.to_string_lossy(),
        });
        assert!(refresh_local_book_cover_metadata(&mut entry).await.unwrap());
        let cover_sha = entry["coverAssetSha256"].as_str().unwrap().to_string();
        let (origin, store, log) = spawn_asset_store().await;
        let client = reqwest::Client::new();

        upload_book_entry_assets_to_core(&client, &origin, "token-1", &book_sha, &entry)
            .await
            .unwrap();
        {
            let store = store.lock().unwrap();
            assert_eq!(store.get(&book_sha).unwrap(), b"epub bytes");
            assert_eq!(store.get(&cover_sha).unwrap().len(), 11);
        }

        // A second pass only asks; nothing is sent again.
        log.lock().unwrap().clear();
        upload_book_entry_assets_to_core(&client, &origin, "token-1", &book_sha, &entry)
            .await
            .unwrap();
        assert!(log.lock().unwrap().iter().all(|line| line.starts_with("HEAD ")));

        // A book file that changed since it was fingerprinted is refused, not published.
        let changed_sha = "e".repeat(64);
        let mut changed = entry.clone();
        changed["assetFingerprint"] = json!(changed_sha);
        let error =
            upload_book_entry_assets_to_core(&client, &origin, "token-1", &changed_sha, &changed)
                .await
                .unwrap_err();
        assert!(error.contains("changed before upload"), "{error}");
        assert!(!store.lock().unwrap().contains_key(&changed_sha));
    }

    #[test]
    fn local_authority_is_only_granted_to_hosted_profiles() {
        use super::*;

        let mut replication = PersistedReplicationState::default();
        let mut joined = PersistedReplicationProfileState::default();
        joined.active_session_key = Some("joined:remote:profile".to_string());
        replication.profiles.insert("joined".to_string(), joined);
        replication.profiles.insert(
            "hosted".to_string(),
            PersistedReplicationProfileState::default(),
        );
        let known = ["joined", "hosted", "fresh"]
            .into_iter()
            .map(str::to_string)
            .collect::<HashSet<_>>();

        assert_eq!(
            local_authority_profiles(&known, &replication),
            vec!["fresh".to_string(), "hosted".to_string()]
        );
    }













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
            remote_device_name: None,
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

    fn novel_dependency_fixture(
        plugin_updated_at_ms: i64,
    ) -> (super::PersistedNovelRepositoryState, String, String) {
        use super::*;
        let url = "https://example.com/someone/plugins.min.json";
        let repository_id = canonical_novel_repository_id(url);
        let plugin_entity_id =
            canonical_novel_plugin_id(&repository_id, "someone.source", "someone.source");
        let state = PersistedNovelRepositoryState {
            repositories: vec![LocalNovelRepository {
                id: "local-repo".to_string(),
                url: url.to_string(),
                normalized_url: url.to_string(),
                enabled: true,
            }],
            catalog_entries: Vec::new(),
            installed_plugins: vec![LocalInstalledNovelPlugin {
                repository_id: "local-repo".to_string(),
                plugin_id: "someone.source".to_string(),
                version: "1.0.0".to_string(),
                enabled: true,
                artifact_path: String::new(),
                installed_at_ms: 1,
                updated_at_ms: plugin_updated_at_ms,
            }],
        };
        (state, repository_id, plugin_entity_id)
    }

    fn declare_novel_dependencies(
        profile: &mut super::PersistedReplicationProfileState,
        repository_id: &str,
        plugin_entity_id: &str,
    ) {
        use super::*;
        profile.novel_dependency_declarations.insert(
            repository_id.to_string(),
            SyncdNovelDependencyDeclaration::Repository(SyncdNovelRepositoryDeclaration {
                repository_id: repository_id.to_string(),
                canonical_url: "https://example.com/someone/plugins.min.json".to_string(),
                enabled: true,
            }),
        );
        profile.novel_dependency_declarations.insert(
            plugin_entity_id.to_string(),
            SyncdNovelDependencyDeclaration::Plugin(SyncdNovelPluginDeclaration {
                repository_id: repository_id.to_string(),
                plugin_id: "someone.source".to_string(),
                version: "1.0.0".to_string(),
                enabled: true,
            }),
        );
    }

    #[test]
    fn novel_dependencies_both_sides_held_follow_the_other_device_delete() {
        use super::*;
        let (state, repository_id, plugin_entity_id) = novel_dependency_fixture(10);
        let mut profile = PersistedReplicationProfileState::default();
        declare_novel_dependencies(&mut profile, &repository_id, &plugin_entity_id);

        // First meeting: nothing is removed, and both entries become agreed.
        let plan = plan_novel_dependency_sync(&mut profile, &state, 1_000);
        assert!(plan.removals.is_empty());
        assert_eq!(plan.declarations.len(), 2);
        assert_eq!(
            profile
                .novel_dependency_baseline
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([repository_id.clone(), plugin_entity_id.clone()])
        );

        // The phone removes the plugin, then the repository.
        profile.novel_dependency_declarations.clear();
        profile
            .novel_dependency_tombstones
            .insert(plugin_entity_id.clone(), 50);
        profile
            .novel_dependency_tombstones
            .insert(repository_id.clone(), 51);
        let plan = plan_novel_dependency_sync(&mut profile, &state, 1_000);
        assert_eq!(
            plan.removals,
            vec![
                SyncdNovelDependencyRemoval::Plugin {
                    plugin_id: "someone.source".to_string()
                },
                SyncdNovelDependencyRemoval::Repository {
                    local_repository_id: "local-repo".to_string()
                },
            ]
        );
        // Still agreed until the removal is written here; then the baseline empties.
        assert_eq!(profile.novel_dependency_baseline.len(), 2);
        let plan = plan_novel_dependency_sync(
            &mut profile,
            &PersistedNovelRepositoryState::default(),
            1_000,
        );
        assert!(plan.removals.is_empty());
        assert!(profile.novel_dependency_baseline.is_empty());
    }

    #[test]
    fn novel_dependency_removal_spares_newer_installs_and_entries_never_agreed() {
        use super::*;
        let (state, repository_id, plugin_entity_id) = novel_dependency_fixture(90);
        let mut profile = PersistedReplicationProfileState::default();
        declare_novel_dependencies(&mut profile, &repository_id, &plugin_entity_id);
        plan_novel_dependency_sync(&mut profile, &state, 1_000);
        profile
            .novel_dependency_declarations
            .remove(&plugin_entity_id);
        profile
            .novel_dependency_tombstones
            .insert(plugin_entity_id.clone(), 50);

        // Installed here at 90, after the delete at 50: the newer install stays.
        let plan = plan_novel_dependency_sync(&mut profile, &state, 1_000);
        assert!(plan.removals.is_empty());

        // A tombstone for something this desktop never agreed on removes nothing.
        let mut fresh = PersistedReplicationProfileState::default();
        fresh
            .novel_dependency_tombstones
            .insert(plugin_entity_id.clone(), 500);
        fresh
            .novel_dependency_tombstones
            .insert(repository_id.clone(), 500);
        assert!(plan_novel_dependency_sync(&mut fresh, &state, 1_000)
            .removals
            .is_empty());
    }

    #[test]
    fn novel_dependencies_removed_here_are_not_installed_again_while_the_delete_is_pending() {
        use super::*;
        let (_, repository_id, plugin_entity_id) = novel_dependency_fixture(10);
        let mut profile = PersistedReplicationProfileState::default();
        declare_novel_dependencies(&mut profile, &repository_id, &plugin_entity_id);
        profile
            .novel_dependency_pending_deletes
            .insert(plugin_entity_id.clone(), 1_000);
        let empty = PersistedNovelRepositoryState::default();

        let plan = plan_novel_dependency_sync(&mut profile, &empty, 2_000);
        assert_eq!(plan.declarations.len(), 1);

        // A delete the Core never confirmed stops blocking the declaration.
        let plan = plan_novel_dependency_sync(
            &mut profile,
            &empty,
            1_000 + NOVEL_DEPENDENCY_PENDING_DELETE_MS,
        );
        assert_eq!(plan.declarations.len(), 2);
        assert!(profile.novel_dependency_pending_deletes.is_empty());
    }

    const PHONE_REPO: &str = "https://example.com/someone/plugins.min.json";

    fn v4_record(
        entity_type: &str,
        key: &str,
        deleted: bool,
        ts_ms: i64,
        payload: serde_json::Value,
    ) -> super::V4WireRecord {
        super::V4WireRecord {
            server_seq: 1,
            domain: "extensions".to_string(),
            entity_type: entity_type.to_string(),
            entity_key: key.to_string(),
            deleted,
            hlc: crate::syncd::v4::hlc::Hlc::new(ts_ms, 0, "phone"),
            origin_device_id: "phone".to_string(),
            payload,
            updated_at_ms: ts_ms,
        }
    }

    fn phone_repo(deleted: bool, ts_ms: i64) -> super::V4WireRecord {
        use super::*;
        v4_record(
            "extension.repo",
            &format!("novel:{PHONE_REPO}"),
            deleted,
            ts_ms,
            if deleted {
                Value::Null
            } else {
                json!({"kind": "novel", "baseUrl": PHONE_REPO, "name": "someone"})
            },
        )
    }

    fn phone_plugin(deleted: bool, ts_ms: i64) -> super::V4WireRecord {
        use super::*;
        v4_record(
            "extension.installed",
            "novel:someone.source",
            deleted,
            ts_ms,
            if deleted {
                Value::Null
            } else {
                // Phones send the plugin's site as `repoUrl`, not its repository.
                json!({
                    "kind": "novel", "packageId": "someone.source", "name": "Someone",
                    "versionName": "1.2.0", "versionCode": 0, "lang": "en",
                    "signatureHash": "", "isNsfw": false, "repoUrl": "https://someone.example/"
                })
            },
        )
    }

    #[test]
    fn v4_phone_repositories_and_plugins_become_declarations_in_either_order() {
        use super::*;
        let (entity, url) = novel_repository_entity(PHONE_REPO).unwrap();
        let plugin_entity = canonical_novel_plugin_id(&entity, "someone.source", "someone.source");
        let expected = BTreeMap::from([
            (
                entity.clone(),
                SyncdNovelDependencyDeclaration::Repository(SyncdNovelRepositoryDeclaration {
                    repository_id: entity.clone(),
                    canonical_url: url,
                    enabled: true,
                }),
            ),
            (
                plugin_entity,
                SyncdNovelDependencyDeclaration::Plugin(SyncdNovelPluginDeclaration {
                    repository_id: entity.clone(),
                    plugin_id: "someone.source".to_string(),
                    version: "1.2.0".to_string(),
                    enabled: true,
                }),
            ),
        ]);
        let empty = PersistedNovelRepositoryState::default();

        let mut together = PersistedReplicationProfileState::default();
        assert!(apply_v4_novel_dependency_records_to_profile(
            &mut together,
            &empty,
            &[phone_plugin(false, 10), phone_repo(false, 10)],
        ));
        assert_eq!(together.novel_dependency_declarations, expected);
        // The same records again change nothing.
        assert!(!apply_v4_novel_dependency_records_to_profile(
            &mut together,
            &empty,
            &[phone_plugin(false, 10), phone_repo(false, 10)],
        ));

        // A plugin that arrives before its repository waits for it.
        let mut split = PersistedReplicationProfileState::default();
        apply_v4_novel_dependency_records_to_profile(&mut split, &empty, &[phone_plugin(false, 10)]);
        assert!(split.novel_dependency_declarations.is_empty());
        apply_v4_novel_dependency_records_to_profile(&mut split, &empty, &[phone_repo(false, 11)]);
        assert_eq!(split.novel_dependency_declarations, expected);
    }

    #[test]
    fn v4_plugin_goes_to_the_repository_whose_catalog_lists_it() {
        use super::*;
        let other = "https://other.example/plugins.json";
        let mut state = PersistedNovelRepositoryState::default();
        for (id, url) in [("local-a", PHONE_REPO), ("local-b", other)] {
            state.repositories.push(LocalNovelRepository {
                id: id.to_string(),
                url: url.to_string(),
                normalized_url: url.to_string(),
                enabled: true,
            });
        }
        let mut profile = PersistedReplicationProfileState::default();
        let other_repo = v4_record(
            "extension.repo",
            &format!("novel:{other}"),
            false,
            10,
            json!({"kind": "novel", "baseUrl": other, "name": other}),
        );
        let records = [phone_repo(false, 10), other_repo, phone_plugin(false, 10)];
        // Two declared repositories and no catalog: the plugin stays undeclared.
        apply_v4_novel_dependency_records_to_profile(&mut profile, &state, &records);
        assert_eq!(declared_plugin_entities(&profile, "someone.source").len(), 0);

        state.catalog_entries.push(LocalNovelCatalogEntry {
            repository_id: "local-b".to_string(),
            plugin_id: "someone.source".to_string(),
            ..Default::default()
        });
        apply_v4_novel_dependency_records_to_profile(&mut profile, &state, &records);
        let (other_entity, _) = novel_repository_entity(other).unwrap();
        assert_eq!(
            declared_plugin_entities(&profile, "someone.source"),
            vec![canonical_novel_plugin_id(&other_entity, "someone.source", "someone.source")]
        );
    }

    #[test]
    fn v4_phone_deletes_remove_what_both_sides_held_and_ignore_other_kinds() {
        use super::*;
        let (state, repository_id, plugin_entity_id) = novel_dependency_fixture(10);
        let mut profile = PersistedReplicationProfileState::default();
        apply_v4_novel_dependency_records_to_profile(
            &mut profile,
            &state,
            &[phone_repo(false, 5), phone_plugin(false, 5)],
        );
        assert!(plan_novel_dependency_sync(&mut profile, &state, 1_000)
            .removals
            .is_empty());

        // Comic extensions and other domains never touch the novel declarations.
        let mut comic = phone_plugin(true, 60);
        comic.payload = json!({"kind": "comic"});
        comic.entity_key = "comic:someone.source".to_string();
        assert!(!apply_v4_novel_dependency_records_to_profile(&mut profile, &state, &[comic]));

        apply_v4_novel_dependency_records_to_profile(
            &mut profile,
            &state,
            &[phone_plugin(true, 50), phone_repo(true, 51)],
        );
        assert!(profile.novel_dependency_declarations.is_empty());
        assert!(profile.v4_novel_plugins.is_empty());
        assert_eq!(profile.novel_dependency_tombstones.get(&plugin_entity_id), Some(&50));
        assert_eq!(profile.novel_dependency_tombstones.get(&repository_id), Some(&51));
        assert_eq!(
            plan_novel_dependency_sync(&mut profile, &state, 1_000).removals,
            vec![
                SyncdNovelDependencyRemoval::Plugin {
                    plugin_id: "someone.source".to_string()
                },
                SyncdNovelDependencyRemoval::Repository {
                    local_repository_id: "local-repo".to_string()
                },
            ]
        );
    }

    #[test]
    fn v4_deletes_sent_from_here_hold_the_declaration_back_until_confirmed() {
        use super::*;
        let mut profile = PersistedReplicationProfileState::default();
        apply_v4_novel_dependency_records_to_profile(
            &mut profile,
            &PersistedNovelRepositoryState::default(),
            &[phone_repo(false, 5), phone_plugin(false, 5)],
        );
        let item = |entity_type: &str, key: &str| V4IncomingItem {
            client_mutation_id: None,
            domain: "extensions".to_string(),
            entity_type: entity_type.to_string(),
            entity_key: key.to_string(),
            deleted: true,
            hlc: crate::syncd::v4::hlc::Hlc::new(70, 0, "desktop"),
            payload: Value::Null,
        };
        note_novel_dependency_deletes(
            &mut profile,
            &[
                item("extension.installed", "novel:someone.source"),
                item("extension.repo", &format!("novel:{PHONE_REPO}")),
            ],
            2_000,
        );
        assert_eq!(profile.novel_dependency_pending_deletes.len(), 2);
        let plan = plan_novel_dependency_sync(
            &mut profile,
            &PersistedNovelRepositoryState::default(),
            2_500,
        );
        assert!(plan.declarations.is_empty());
    }
}
