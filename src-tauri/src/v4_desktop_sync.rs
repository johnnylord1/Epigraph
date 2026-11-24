//! Realtime Sync V4 client for the Desktop Tauri shell (Novels & Books via `library_sqlite`).
//!
//! Connects each hosted profile to the Core's `/v4/*` endpoints:
//! 1. Startup catch-up (`GET /v4/capabilities`, initial `POST /v4/sync/bulk` + `GET /v4/snapshot`,
//!    or paginated `GET /v4/changes?sinceSeq=...` with `410 GONE` fallback).
//! 2. Persistent SSE stream (`GET /v4/events?sinceSeq=...`) applying remote `novels` & `books`
//!    deltas directly into `library_sqlite` in $O(N)$ time (< 5 ms) and notifying the UI.
//! 3. Immediate delta push (`POST /v4/deltas`) whenever the Desktop UI saves `novels` or `books`
//!    (including real delete tombstones when an item is removed on Desktop).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex};

use crate::library_sqlite;
use crate::syncd::db::now_ms;
use crate::syncd::middleware::{
    CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER, CURRENT_CLIENT_VERSION,
};
use crate::syncd::v4::db::{V4ChangesResponse, V4IncomingItem, V4SnapshotResponse, V4WireRecord};
use crate::syncd::v4::desktop_library::{
    apply_v4_records_to_desktop_books, apply_v4_records_to_desktop_novels,
    export_desktop_books_to_v4, export_desktop_novels_to_v4,
};
use crate::syncd::v4::hlc::{canonical_work_key, Hlc};
use crate::syncd_desktop::desktop_state_dir;
use crate::{
    book_library_state_path_for_profile, novel_library_state_path_for_target, LaunchTarget,
};

const RECONNECT_DELAY: Duration = Duration::from_secs(3);
const V4_EVENT_LIBRARY_UPDATED: &str = "epigraph:v4-library-updated";

#[derive(Clone)]
struct ActiveV4Connection {
    profile_id: String,
    base_url: String,
    access_token: String,
    device_id: String,
}

#[derive(Default)]
struct V4DesktopRegistry {
    connections: HashMap<String, ActiveV4Connection>,
    running_workers: HashSet<String>,
}

static REGISTRY: OnceLock<Arc<Mutex<V4DesktopRegistry>>> = OnceLock::new();
static CURSOR_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static FRONTEND_LOADED_BOOKS: OnceLock<StdMutex<HashMap<String, HashSet<String>>>> =
    OnceLock::new();
static FRONTEND_LOADED_NOVELS: OnceLock<StdMutex<HashMap<String, HashSet<String>>>> =
    OnceLock::new();
static LIBRARY_LOCKS: OnceLock<StdMutex<HashMap<String, Arc<StdMutex<()>>>>> = OnceLock::new();
static LIBRARY_REVISIONS: OnceLock<StdMutex<HashMap<String, (u64, u64)>>> = OnceLock::new();
static PROFILE_DEVICES: OnceLock<StdMutex<HashMap<String, String>>> = OnceLock::new();
static PROFILE_HLCS: OnceLock<StdMutex<HashMap<String, (i64, i64)>>> = OnceLock::new();
static PUBLISH_QUEUES: OnceLock<StdMutex<HashMap<String, mpsc::UnboundedSender<PublishBatch>>>> =
    OnceLock::new();

struct PublishBatch {
    profile_id: String,
    domain: &'static str,
    items: Vec<V4IncomingItem>,
}

fn registry() -> &'static Arc<Mutex<V4DesktopRegistry>> {
    REGISTRY.get_or_init(|| Arc::new(Mutex::new(V4DesktopRegistry::default())))
}

fn cursor_lock() -> &'static Mutex<()> {
    CURSOR_LOCK.get_or_init(|| Mutex::new(()))
}

fn loaded_books() -> &'static StdMutex<HashMap<String, HashSet<String>>> {
    FRONTEND_LOADED_BOOKS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn loaded_novels() -> &'static StdMutex<HashMap<String, HashSet<String>>> {
    FRONTEND_LOADED_NOVELS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn library_locks() -> &'static StdMutex<HashMap<String, Arc<StdMutex<()>>>> {
    LIBRARY_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn library_revisions() -> &'static StdMutex<HashMap<String, (u64, u64)>> {
    LIBRARY_REVISIONS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn profile_devices() -> &'static StdMutex<HashMap<String, String>> {
    PROFILE_DEVICES.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn profile_hlcs() -> &'static StdMutex<HashMap<String, (i64, i64)>> {
    PROFILE_HLCS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn publish_queues() -> &'static StdMutex<HashMap<String, mpsc::UnboundedSender<PublishBatch>>> {
    PUBLISH_QUEUES.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn next_profile_hlc(profile_id: &str, device_id: &str, now: i64) -> Hlc {
    let mut clocks = profile_hlcs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let clock = clocks.entry(profile_id.to_owned()).or_default();
    if now > clock.0 {
        *clock = (now, 0);
    } else {
        clock.1 = clock.1.saturating_add(1);
    }
    Hlc::new(clock.0.max(1), clock.1, device_id)
}

fn observe_profile_hlc(profile_id: &str, remote: &Hlc) {
    let mut clocks = profile_hlcs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let clock = clocks.entry(profile_id.to_owned()).or_default();
    if (remote.ts_ms, remote.counter) > *clock {
        *clock = (remote.ts_ms, remote.counter);
    }
}

fn enqueue_stamped_diff(
    profile_id: &str,
    domain: &'static str,
    previous_contents: Option<&str>,
    next_contents: &str,
) -> Result<(), String> {
    let device_id = profile_devices()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(profile_id)
        .cloned();
    let Some(device_id) = device_id else {
        return Ok(());
    };
    let loaded = if domain == "books" {
        loaded_books()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(profile_id)
            .cloned()
            .unwrap_or_default()
    } else {
        loaded_novels()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(profile_id)
            .cloned()
            .unwrap_or_default()
    };
    let now = now_ms();
    let previous = previous_contents
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .map(|doc| {
            if domain == "books" {
                export_desktop_books_to_v4(&doc, &device_id, now)
            } else {
                export_desktop_novels_to_v4(&doc, &device_id, now)
            }
        })
        .unwrap_or_default();
    let next_doc: Value = serde_json::from_str(next_contents).map_err(|error| error.to_string())?;
    let next = if domain == "books" {
        export_desktop_books_to_v4(&next_doc, &device_id, now)
    } else {
        export_desktop_novels_to_v4(&next_doc, &device_id, now)
    };
    let work_type = if domain == "books" {
        "book.work"
    } else {
        "novel.work"
    };
    let mut items = diff_v4_items_with_work_delete_gate(
        previous,
        next,
        &device_id,
        now,
        Some((work_type, &loaded)),
    );
    for item in &mut items {
        item.hlc = next_profile_hlc(profile_id, &device_id, now);
    }
    if items.is_empty() {
        return Ok(());
    }
    let sender = {
        let mut queues = publish_queues().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sender) = queues.get(profile_id) {
            sender.clone()
        } else {
            let (sender, mut receiver) = mpsc::unbounded_channel::<PublishBatch>();
            let queue_profile = profile_id.to_owned();
            tauri::async_runtime::spawn(async move {
                while let Some(batch) = receiver.recv().await {
                    let conn = registry()
                        .lock()
                        .await
                        .connections
                        .get(&queue_profile)
                        .cloned();
                    let Some(conn) = conn else { continue };
                    let deleted: HashSet<String> = batch
                        .items
                        .iter()
                        .filter(|item| {
                            item.deleted
                                && item.entity_type
                                    == if batch.domain == "books" {
                                        "book.work"
                                    } else {
                                        "novel.work"
                                    }
                        })
                        .map(|item| item.entity_key.clone())
                        .collect();
                    if let Err(error) = push_v4_items(&conn, batch.items).await {
                        tracing::debug!(profile = %queue_profile, error = %error, "V4 desktop queued publish failed");
                    } else if batch.domain == "books" {
                        forget_published_books(Some(&batch.profile_id), &deleted);
                    } else {
                        forget_published_novels(Some(&batch.profile_id), &deleted);
                    }
                }
            });
            queues.insert(profile_id.to_owned(), sender.clone());
            sender
        }
    };
    sender
        .send(PublishBatch {
            profile_id: profile_id.to_owned(),
            domain,
            items,
        })
        .map_err(|error| error.to_string())
}

fn library_state_key(profile_id: Option<&str>, domain: &str) -> String {
    format!("{}::{domain}", profile_key(profile_id))
}

/// Serializes every load/reconcile/apply/save operation for one profile and library domain.
pub fn with_library_state_lock<T>(
    profile_id: Option<&str>,
    domain: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let key = library_state_key(profile_id, domain);
    let lock = {
        let mut locks = library_locks()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks
            .entry(key)
            .or_insert_with(|| Arc::new(StdMutex::new(())))
            .clone()
    };
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    operation()
}

/// Returns the current on-disk revision and marks this revision as loaded by the frontend.
pub fn note_library_loaded(profile_id: Option<&str>, domain: &str) -> u64 {
    let key = library_state_key(profile_id, domain);
    let mut revisions = library_revisions()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = revisions.entry(key).or_default();
    entry.1 = entry.0;
    entry.0
}

/// True when a queued frontend document was read before a remote SQLite apply.
pub fn frontend_write_is_stale(profile_id: Option<&str>, domain: &str) -> bool {
    let revisions = library_revisions()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    revisions
        .get(&library_state_key(profile_id, domain))
        .is_some_and(|(disk_revision, frontend_revision)| disk_revision > frontend_revision)
}

/// Advances the monotonic disk revision after every SQLite save. Remote applies intentionally do
/// not advance the frontend revision; a later explicit read does.
pub fn note_library_saved(profile_id: Option<&str>, domain: &str, frontend_write: bool) {
    let key = library_state_key(profile_id, domain);
    let mut revisions = library_revisions()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = revisions.entry(key).or_default();
    entry.0 = entry.0.saturating_add(1);
    if frontend_write {
        entry.1 = entry.0;
    }
}

fn profile_key(profile_id: Option<&str>) -> String {
    profile_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("main")
        .to_ascii_lowercase()
}

fn canonical_book_sha(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    (normalized.len() == 64
        && normalized
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then_some(normalized)
}

fn book_sha(book: &Value) -> Option<String> {
    ["assetFingerprint", "fileSha256", "sha256"]
        .iter()
        .filter_map(|field| book.get(*field).and_then(Value::as_str))
        .find_map(canonical_book_sha)
}

fn novel_key(entry: &Value) -> Option<String> {
    let plugin_id = entry
        .get("source")
        .and_then(|source| source.get("pluginId"))
        .and_then(Value::as_str)
        .or_else(|| entry.get("pluginId").and_then(Value::as_str))
        .or_else(|| entry.get("sourceId").and_then(Value::as_str))?;
    let path = entry
        .get("path")
        .and_then(Value::as_str)
        .or_else(|| entry.get("url").and_then(Value::as_str))?;
    Some(canonical_work_key(plugin_id, path))
}

fn keyed_values(doc: &Value, primary: &str, legacy: Option<&str>) -> HashSet<String> {
    doc.get(primary)
        .and_then(Value::as_array)
        .or_else(|| {
            legacy
                .and_then(|key| doc.get(key))
                .and_then(Value::as_array)
        })
        .into_iter()
        .flatten()
        .filter_map(|row| {
            if primary == "books" {
                book_sha(row)
            } else {
                novel_key(row)
            }
        })
        .collect()
}

pub fn note_books_loaded_by_frontend(profile_id: Option<&str>, contents: &str) {
    let Ok(doc) = serde_json::from_str::<Value>(contents) else {
        return;
    };
    let keys = keyed_values(&doc, "books", None);
    loaded_books()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(profile_key(profile_id), keys);
}

pub fn note_novels_loaded_by_frontend(profile_id: Option<&str>, contents: &str) {
    let Ok(doc) = serde_json::from_str::<Value>(contents) else {
        return;
    };
    let keys = keyed_values(&doc, "entries", Some("novels"));
    loaded_novels()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(profile_key(profile_id), keys);
}

fn row_identity(field: &str, row: &Value, id_field: &str) -> Option<String> {
    if let Some(id) = row
        .get(id_field)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        return Some(id.to_owned());
    }
    let components = match field {
        "bookBookmarks" => json!([
            row.get("bookId"),
            row.get("savedAt"),
            row.get("location"),
            row.get("href"),
            row.get("progressPercent"),
            row.get("label")
        ]),
        "novelBookmarks" | "bookmarks" => json!([
            row.get("novelId"),
            row.get("chapterId"),
            row.get("savedAt"),
            row.get("locator"),
            row.get("label")
        ]),
        "history" => json!([
            row.get("novelId"),
            row.get("chapterId"),
            row.get("readAt"),
            row.get("locator")
        ]),
        "bookHistory" => json!([
            row.get("bookId"),
            row.get("readAtMs"),
            row.get("location"),
            row.get("href")
        ]),
        _ => return None,
    };
    serde_json::to_string(&components)
        .ok()
        .map(|key| format!("fallback:{field}:{key}"))
}

fn merge_array_rows(
    next: &mut Value,
    previous: &Value,
    field: &str,
    id_field: &str,
    allowed_ids: &HashSet<String>,
) {
    let Some(previous_rows) = previous.get(field).and_then(Value::as_array) else {
        return;
    };
    let next_rows = next
        .as_object_mut()
        .and_then(|root| root.get_mut(field))
        .and_then(Value::as_array_mut);
    if next_rows.is_none() {
        next.as_object_mut()
            .expect("library state must be object")
            .insert(field.into(), json!([]));
    }
    let next_rows = next
        .as_object_mut()
        .and_then(|root| root.get_mut(field))
        .and_then(Value::as_array_mut)
        .expect("array initialized");
    for row in previous_rows {
        let Some(id) = row_identity(field, row, id_field) else {
            continue;
        };
        if !allowed_ids.contains(&id) {
            continue;
        }
        if let Some(existing) = next_rows
            .iter_mut()
            .find(|entry| row_identity(field, entry, id_field).as_deref() == Some(id.as_str()))
        {
            *existing = row.clone();
        } else {
            next_rows.push(row.clone());
        }
    }
}

fn merge_book_assignments(next: &mut Value, previous: &Value, book_ids: &HashSet<String>) {
    let previous_assignments = previous
        .get("booksCategoryAssignments")
        .and_then(Value::as_object);
    let Some(previous_assignments) = previous_assignments else {
        return;
    };
    let target = next.as_object_mut().expect("library state must be object");
    if !target
        .get("booksCategoryAssignments")
        .is_some_and(Value::is_object)
    {
        target.insert("booksCategoryAssignments".into(), json!({}));
    }
    let assignments = target
        .get_mut("booksCategoryAssignments")
        .and_then(Value::as_object_mut)
        .expect("object initialized");
    let mut referenced_categories = HashSet::new();
    for book_id in book_ids {
        let Some(values) = previous_assignments.get(book_id).and_then(Value::as_array) else {
            continue;
        };
        referenced_categories.extend(values.iter().filter_map(Value::as_str).map(str::to_owned));
        let current = assignments
            .entry(book_id.clone())
            .or_insert_with(|| json!([]));
        let current = current
            .as_array_mut()
            .expect("category assignments are arrays");
        for category_id in values.iter().filter_map(Value::as_str) {
            if !current
                .iter()
                .any(|entry| entry.as_str() == Some(category_id))
            {
                current.push(json!(category_id));
            }
        }
    }
    merge_array_rows(
        next,
        previous,
        "booksCategories",
        "id",
        &referenced_categories,
    );
}

pub fn reconcile_frontend_book_write(
    profile_id: Option<&str>,
    previous_contents: Option<&str>,
    next_contents: &str,
) -> Result<String, String> {
    let mut next: Value = serde_json::from_str(next_contents).map_err(|error| error.to_string())?;
    if !next.is_object() {
        return Err("book library state must be an object".into());
    }
    let Some(previous_raw) = previous_contents else {
        let keys = keyed_values(&next, "books", None);
        loaded_books()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(profile_key(profile_id))
            .or_default()
            .extend(keys);
        return serde_json::to_string(&next).map_err(|error| error.to_string());
    };
    let previous: Value = serde_json::from_str(previous_raw).map_err(|error| error.to_string())?;
    let key = profile_key(profile_id);
    let loaded = loaded_books()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
        .cloned()
        .unwrap_or_default();
    let previous_rows = previous
        .get("books")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let next_keys = keyed_values(&next, "books", None);
    let mut restored_ids = HashSet::new();
    let next_books = next
        .as_object_mut()
        .and_then(|root| root.get_mut("books"))
        .and_then(Value::as_array_mut);
    if next_books.is_none() {
        next.as_object_mut()
            .unwrap()
            .insert("books".into(), json!([]));
    }
    let next_books = next
        .as_object_mut()
        .and_then(|root| root.get_mut("books"))
        .and_then(Value::as_array_mut)
        .unwrap();
    for book in &previous_rows {
        let Some(sha) = book_sha(book) else { continue };
        if loaded.contains(&sha) {
            continue;
        }
        let id = book
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if let Some(existing) = next_books
            .iter_mut()
            .find(|entry| book_sha(entry).as_deref() == Some(sha.as_str()))
        {
            *existing = book.clone();
        } else if !next_keys.contains(&sha) {
            next_books.push(book.clone());
        }
        if !id.is_empty() {
            restored_ids.insert(id);
        }
    }
    for (field, id_field) in [
        ("bookProgress", "bookId"),
        ("bookBookmarks", "bookmarkId"),
        ("bookHighlights", "highlightId"),
        ("bookHistory", "historyId"),
    ] {
        if field == "bookHistory" || field == "bookHighlights" {
            if next.get(field).is_none() {
                if let Some(value) = previous.get(field) {
                    next.as_object_mut()
                        .unwrap()
                        .insert(field.into(), value.clone());
                }
                continue;
            }
        }
        let allowed = if id_field == "bookId" {
            restored_ids.clone()
        } else {
            previous
                .get(field)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|row| {
                    row.get("bookId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| restored_ids.contains(id))
                })
                .filter_map(|row| row_identity(field, row, id_field))
                .collect()
        };
        merge_array_rows(&mut next, &previous, field, id_field, &allowed);
    }
    merge_book_assignments(&mut next, &previous, &restored_ids);
    let previous_keys = keyed_values(&previous, "books", None);
    let added = keyed_values(&next, "books", None)
        .difference(&previous_keys)
        .cloned()
        .collect::<HashSet<_>>();
    loaded_books()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(key)
        .or_default()
        .extend(added);
    serde_json::to_string(&next).map_err(|error| error.to_string())
}

pub fn reconcile_frontend_novel_write(
    profile_id: Option<&str>,
    previous_contents: Option<&str>,
    next_contents: &str,
) -> Result<String, String> {
    let mut next: Value = serde_json::from_str(next_contents).map_err(|error| error.to_string())?;
    if !next.is_object() {
        return Err("novel library state must be an object".into());
    }
    let Some(previous_raw) = previous_contents else {
        let keys = keyed_values(&next, "entries", Some("novels"));
        loaded_novels()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(profile_key(profile_id))
            .or_default()
            .extend(keys);
        return serde_json::to_string(&next).map_err(|error| error.to_string());
    };
    let previous: Value = serde_json::from_str(previous_raw).map_err(|error| error.to_string())?;
    let key = profile_key(profile_id);
    let loaded = loaded_novels()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
        .cloned()
        .unwrap_or_default();
    let previous_entries = previous
        .get("entries")
        .and_then(Value::as_array)
        .or_else(|| previous.get("novels").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    let previous_keys = keyed_values(&previous, "entries", Some("novels"));
    let next_keys = keyed_values(&next, "entries", Some("novels"));
    let next_entries = next
        .as_object_mut()
        .and_then(|root| root.get_mut("entries"))
        .and_then(Value::as_array_mut);
    if next_entries.is_none() {
        next.as_object_mut()
            .unwrap()
            .insert("entries".into(), json!([]));
    }
    let next_entries = next
        .as_object_mut()
        .and_then(|root| root.get_mut("entries"))
        .and_then(Value::as_array_mut)
        .unwrap();
    let mut restored_ids = HashSet::new();
    for entry in &previous_entries {
        let Some(work_key) = novel_key(entry) else {
            continue;
        };
        if loaded.contains(&work_key) {
            continue;
        }
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if let Some(existing) = next_entries
            .iter_mut()
            .find(|value| novel_key(value).as_deref() == Some(work_key.as_str()))
        {
            *existing = entry.clone();
        } else if !next_keys.contains(&work_key) {
            next_entries.push(entry.clone());
        }
        if !id.is_empty() {
            restored_ids.insert(id);
        }
    }
    for field in ["chapters", "progress", "bookmarks", "history"] {
        let id_field = if field == "chapters" {
            "id"
        } else if field == "bookmarks" {
            "syncId"
        } else if field == "history" {
            "historyId"
        } else {
            "novelId"
        };
        let allowed: HashSet<String> = previous
            .get(field)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|row| {
                row.get("novelId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| restored_ids.contains(id))
            })
            .filter_map(|row| row_identity(field, row, id_field))
            .collect();
        merge_array_rows(&mut next, &previous, field, id_field, &allowed);
    }
    let added = keyed_values(&next, "entries", Some("novels"))
        .difference(&previous_keys)
        .cloned()
        .collect::<HashSet<_>>();
    loaded_novels()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(key)
        .or_default()
        .extend(added);
    serde_json::to_string(&next).map_err(|error| error.to_string())
}

pub async fn is_profile_active(profile_id: Option<&str>) -> bool {
    registry()
        .lock()
        .await
        .connections
        .contains_key(&profile_key(profile_id))
}

fn forget_published_books(profile_id: Option<&str>, hashes: &HashSet<String>) {
    if let Some(loaded) = loaded_books()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get_mut(&profile_key(profile_id))
    {
        for hash in hashes {
            loaded.remove(hash);
        }
    }
}

fn forget_published_novels(profile_id: Option<&str>, keys: &HashSet<String>) {
    if let Some(loaded) = loaded_novels()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get_mut(&profile_key(profile_id))
    {
        for key in keys {
            loaded.remove(key);
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V4DesktopCursorFile {
    cursors: HashMap<String, i64>,
}

fn cursor_file_path() -> Result<PathBuf, String> {
    Ok(desktop_state_dir().join("sync-v4-desktop-cursors.json"))
}

async fn load_cursor(key: &str) -> i64 {
    let _guard = cursor_lock().lock().await;
    let Ok(path) = cursor_file_path() else {
        return 0;
    };
    let Ok(raw) = tokio::fs::read_to_string(&path).await else {
        return 0;
    };
    serde_json::from_str::<V4DesktopCursorFile>(&raw)
        .ok()
        .and_then(|file| file.cursors.get(key).copied())
        .unwrap_or(0)
}

async fn save_cursor(key: &str, seq: i64) {
    let _guard = cursor_lock().lock().await;
    let Ok(path) = cursor_file_path() else { return };
    let mut file = tokio::fs::read_to_string(&path)
        .await
        .ok()
        .and_then(|raw| serde_json::from_str::<V4DesktopCursorFile>(&raw).ok())
        .unwrap_or_default();
    file.cursors.insert(key.to_string(), seq);
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    if let Ok(encoded) = serde_json::to_vec_pretty(&file) {
        let tmp = path.with_extension("json.tmp");
        if tokio::fs::write(&tmp, &encoded).await.is_ok() {
            let _ = tokio::fs::rename(&tmp, &path).await;
        }
    }
}

fn build_local_v4_client() -> Result<reqwest::Client, String> {
    crate::ensure_process_rustls_crypto_provider();
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|err| err.to_string())
}

fn apply_v4_headers(req: reqwest::RequestBuilder, access_token: &str) -> reqwest::RequestBuilder {
    req.header("Authorization", format!("Bearer {access_token}"))
        .header(CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(CLIENT_PROTOCOL_HEADER.as_str(), "4")
}

/// Registers the local Core V4 session for `profile_id` and spawns at most one live SSE worker.
pub async fn start_local_worker(
    app: AppHandle,
    profile_id: String,
    base_url: String,
    access_token: String,
    device_id: String,
) {
    let profile_id = profile_key(Some(&profile_id));
    let normalized_base = base_url.trim_end_matches('/').to_string();
    let conn = ActiveV4Connection {
        profile_id: profile_id.clone(),
        base_url: normalized_base,
        access_token,
        device_id,
    };
    profile_devices()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(profile_id.clone(), conn.device_id.clone());

    let should_spawn = {
        let mut reg = registry().lock().await;
        reg.connections.insert(profile_id.clone(), conn);
        reg.running_workers.insert(profile_id.clone())
    };

    if !should_spawn {
        return;
    }

    tauri::async_runtime::spawn(async move {
        run_profile_v4_loop(app, profile_id).await;
    });
}

async fn run_profile_v4_loop(app: AppHandle, profile_id: String) {
    loop {
        let conn = {
            let reg = registry().lock().await;
            reg.connections.get(&profile_id).cloned()
        };
        let Some(conn) = conn else {
            break;
        };

        let Ok(client) = build_local_v4_client() else {
            tokio::time::sleep(RECONNECT_DELAY).await;
            continue;
        };

        if let Err(err) = sync_and_stream_once(&app, &client, &conn).await {
            tracing::debug!(profile = %conn.profile_id, error = %err, "V4 desktop SSE loop reconnecting");
        }
        tokio::time::sleep(RECONNECT_DELAY).await;
    }

    let mut reg = registry().lock().await;
    reg.running_workers.remove(&profile_id);
}

async fn sync_and_stream_once(
    app: &AppHandle,
    client: &reqwest::Client,
    conn: &ActiveV4Connection,
) -> Result<(), String> {
    let cursor_key = format!("{}::{}", conn.base_url, conn.profile_id);
    let mut cursor = load_cursor(&cursor_key).await;

    // 1. Initial sync or incremental catch-up.
    if cursor == 0 {
        cursor = run_initial_desktop_merge(app, client, conn, true).await?;
        save_cursor(&cursor_key, cursor).await;
    } else {
        match pull_changes_paged(app, client, conn, cursor).await {
            Ok(next_seq) => {
                cursor = next_seq;
                save_cursor(&cursor_key, cursor).await;
            }
            Err(err) if err == "REPLAY_EXPIRED" => {
                cursor = run_initial_desktop_merge(app, client, conn, false).await?;
                save_cursor(&cursor_key, cursor).await;
            }
            Err(err) => return Err(err),
        }
    }

    // 2. Persistent SSE stream (`/v4/events?sinceSeq=...`).
    let url = format!("{}/v4/events?sinceSeq={cursor}", conn.base_url);
    let resp = apply_v4_headers(client.get(&url), &conn.access_token)
        .header("Accept", "text/event-stream")
        .header("Last-Event-ID", cursor.to_string())
        .send()
        .await
        .map_err(|err| err.to_string())?;

    if resp.status() == reqwest::StatusCode::GONE {
        let next_seq = run_initial_desktop_merge(app, client, conn, false).await?;
        save_cursor(&cursor_key, next_seq).await;
        return Ok(());
    }
    if !resp.status().is_success() {
        return Err(format!("V4 SSE rejected with HTTP {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let mut line_buf = String::new();
    let mut event_name = String::from("message");
    let mut data_buf = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|err| err.to_string())?;
        let text = String::from_utf8_lossy(&bytes);
        line_buf.push_str(&text);

        while let Some(nl) = line_buf.find('\n') {
            let line = line_buf[..nl].trim_end_matches('\r').to_string();
            line_buf.drain(..=nl);

            if line.is_empty() {
                if !data_buf.is_empty() {
                    let payload = std::mem::take(&mut data_buf);
                    let ev = std::mem::replace(&mut event_name, String::from("message"));
                    match ev.as_str() {
                        "delta" => {
                            if let Ok(record) = serde_json::from_str::<V4WireRecord>(&payload) {
                                if record.server_seq > cursor {
                                    apply_remote_records_to_sqlite(
                                        app,
                                        &conn.profile_id,
                                        &[record.clone()],
                                        false,
                                    )?;
                                    cursor = record.server_seq;
                                    save_cursor(&cursor_key, cursor).await;
                                }
                            }
                        }
                        "bulk_committed" | "catchup_required" => {
                            match pull_changes_paged(app, client, conn, cursor).await {
                                Ok(next_seq) => {
                                    cursor = next_seq;
                                    save_cursor(&cursor_key, cursor).await;
                                }
                                Err(err) if err == "REPLAY_EXPIRED" => {
                                    cursor =
                                        run_initial_desktop_merge(app, client, conn, false).await?;
                                    save_cursor(&cursor_key, cursor).await;
                                }
                                Err(err) => return Err(err),
                            }
                        }
                        _ => {}
                    }
                }
            } else if let Some(ev) = line.strip_prefix("event:") {
                event_name = ev.trim().to_string();
            } else if let Some(data) = line.strip_prefix("data:") {
                if !data_buf.is_empty() {
                    data_buf.push('\n');
                }
                data_buf.push_str(data.trim_start());
            }
        }
    }

    Ok(())
}

async fn run_initial_desktop_merge(
    app: &AppHandle,
    client: &reqwest::Client,
    conn: &ActiveV4Connection,
    true_initial_sync: bool,
) -> Result<i64, String> {
    // Seed truly new profiles at baseline HLC 1, so real edits from other devices win.
    // Replay recovery must pull the snapshot without re-uploading old local state.
    let mut local_items = Vec::new();
    if true_initial_sync {
        if let Ok(novels_path) = resolve_novels_path(app, &conn.profile_id) {
            if let Ok(Some(raw)) = library_sqlite::load(&novels_path) {
                if let Ok(doc) = serde_json::from_str::<Value>(&raw) {
                    local_items.extend(export_desktop_novels_to_v4(&doc, &conn.device_id, 1));
                }
            }
        }
        if let Ok(books_path) = book_library_state_path_for_profile(Some(&conn.profile_id)) {
            if let Ok(Some(raw)) = library_sqlite::load(&books_path) {
                if let Ok(doc) = serde_json::from_str::<Value>(&raw) {
                    local_items.extend(export_desktop_books_to_v4(&doc, &conn.device_id, 1));
                }
            }
        }
        for (counter, item) in local_items.iter_mut().enumerate() {
            item.hlc = Hlc::new(1, counter as i64, &conn.device_id);
        }
    }

    if !local_items.is_empty() {
        for chunk in local_items.chunks(15_000) {
            let url = format!("{}/v4/sync/bulk", conn.base_url);
            let resp = apply_v4_headers(client.post(&url), &conn.access_token)
                .json(&json!({ "items": chunk }))
                .send()
                .await
                .map_err(|err| err.to_string())?;
            if !resp.status().is_success() {
                return Err(format!(
                    "V4 desktop bulk upload failed: HTTP {}",
                    resp.status()
                ));
            }
        }
    }

    // Pull full merged snapshot and apply novels & books directly into library_sqlite.
    let snap_url = format!("{}/v4/snapshot?includeTombstones=true", conn.base_url);
    let resp = apply_v4_headers(client.get(&snap_url), &conn.access_token)
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "V4 desktop snapshot failed: HTTP {}",
            resp.status()
        ));
    }
    let snapshot: V4SnapshotResponse = resp.json().await.map_err(|err| err.to_string())?;
    apply_remote_records_to_sqlite(app, &conn.profile_id, &snapshot.records, true_initial_sync)?;
    Ok(snapshot.server_seq)
}

async fn pull_changes_paged(
    app: &AppHandle,
    client: &reqwest::Client,
    conn: &ActiveV4Connection,
    mut cursor: i64,
) -> Result<i64, String> {
    loop {
        let url = format!("{}/v4/changes?sinceSeq={cursor}&limit=2000", conn.base_url);
        let resp = apply_v4_headers(client.get(&url), &conn.access_token)
            .send()
            .await
            .map_err(|err| err.to_string())?;
        if resp.status() == reqwest::StatusCode::GONE {
            return Err("REPLAY_EXPIRED".to_string());
        }
        if !resp.status().is_success() {
            return Err(format!("V4 desktop changes failed: HTTP {}", resp.status()));
        }
        let page: V4ChangesResponse = resp.json().await.map_err(|err| err.to_string())?;
        if !page.changes.is_empty() {
            apply_remote_records_to_sqlite(app, &conn.profile_id, &page.changes, false)?;
        }
        cursor = cursor.max(page.next_seq);
        if !page.has_more {
            cursor = cursor.max(page.server_seq);
            return Ok(cursor);
        }
    }
}

fn resolve_novels_path(app: &AppHandle, profile_id: &str) -> Result<PathBuf, String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    novel_library_state_path_for_target(&launch_target, Some(profile_id), None)
}

fn apply_remote_records_to_sqlite(
    app: &AppHandle,
    profile_id: &str,
    records: &[V4WireRecord],
    preserve_local_work_tombstones: bool,
) -> Result<(), String> {
    let has_novels = records.iter().any(|r| r.domain == "novels");
    let has_books = records.iter().any(|r| r.domain == "books");

    if has_novels {
        with_library_state_lock(Some(profile_id), "novels", || {
            for record in records.iter().filter(|record| record.domain == "novels") {
                observe_profile_hlc(profile_id, &record.hlc);
            }
            if let Ok(path) = resolve_novels_path(app, profile_id) {
                let mut doc = library_sqlite::load(&path)?
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .unwrap_or_else(|| json!({}));
                let local_work_keys: HashSet<String> = doc
                    .get("entries")
                    .and_then(Value::as_array)
                    .or_else(|| doc.get("novels").and_then(Value::as_array))
                    .into_iter()
                    .flatten()
                    .filter_map(novel_key)
                    .collect();
                let safe_records = initial_snapshot_records(
                    records,
                    "novels",
                    &local_work_keys,
                    preserve_local_work_tombstones,
                );
                apply_v4_records_to_desktop_novels(&mut doc, &safe_records);
                let encoded = serde_json::to_string(&doc).map_err(|err| err.to_string())?;
                library_sqlite::save(&path, &encoded)?;
                note_library_saved(Some(profile_id), "novels", false);
                forget_published_novels(
                    Some(profile_id),
                    &safe_records
                        .iter()
                        .filter(|record| record.entity_type == "novel.work" && record.deleted)
                        .map(|record| record.entity_key.clone())
                        .collect(),
                );
                let _ = app.emit(
                    V4_EVENT_LIBRARY_UPDATED,
                    json!({ "profileId": profile_id, "domain": "novels" }),
                );
            }
            Ok(())
        })?;
    }

    if has_books {
        with_library_state_lock(Some(profile_id), "books", || {
            for record in records.iter().filter(|record| record.domain == "books") {
                observe_profile_hlc(profile_id, &record.hlc);
            }
            if let Ok(path) = book_library_state_path_for_profile(Some(profile_id)) {
                let mut doc = library_sqlite::load(&path)?
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .unwrap_or_else(|| json!({}));
                let local_work_keys = keyed_values(&doc, "books", None);
                let safe_records = initial_snapshot_records(
                    records,
                    "books",
                    &local_work_keys,
                    preserve_local_work_tombstones,
                );
                apply_v4_records_to_desktop_books(&mut doc, &safe_records);
                let encoded = serde_json::to_string(&doc).map_err(|err| err.to_string())?;
                library_sqlite::save(&path, &encoded)?;
                note_library_saved(Some(profile_id), "books", false);
                forget_published_books(
                    Some(profile_id),
                    &safe_records
                        .iter()
                        .filter(|record| record.entity_type == "book.work" && record.deleted)
                        .filter_map(|record| canonical_book_sha(&record.entity_key))
                        .collect(),
                );
                let _ = app.emit(
                    V4_EVENT_LIBRARY_UPDATED,
                    json!({ "profileId": profile_id, "domain": "books" }),
                );
            }
            Ok(())
        })?;
    }

    Ok(())
}

fn initial_snapshot_records(
    records: &[V4WireRecord],
    domain: &str,
    local_work_keys: &HashSet<String>,
    preserve_local_work_tombstones: bool,
) -> Vec<V4WireRecord> {
    if !preserve_local_work_tombstones {
        return records.to_vec();
    }
    records
        .iter()
        .filter(|record| {
            if record.domain != domain || !record.deleted {
                return true;
            }
            let Some(parent_key) = parent_work_key_for_gate(&record.entity_type, &record.entity_key)
            else {
                return true;
            };
            let normalized = if domain == "books" {
                canonical_book_sha(parent_key)
            } else {
                Some(parent_key.to_string())
            };
            !normalized.is_some_and(|key| local_work_keys.contains(&key))
        })
        .cloned()
        .collect()
}

/// Computes and queues a books delta while the SQLite profile/domain lock is still held.
pub fn enqueue_books_diff(
    profile_id: Option<&str>,
    previous_contents: Option<&str>,
    next_contents: &str,
) -> Result<(), String> {
    enqueue_stamped_diff(
        &profile_key(profile_id),
        "books",
        previous_contents,
        next_contents,
    )
}

/// Computes and queues a novels delta while the SQLite profile/domain lock is still held.
pub fn enqueue_novels_diff(
    profile_id: Option<&str>,
    previous_contents: Option<&str>,
    next_contents: &str,
) -> Result<(), String> {
    enqueue_stamped_diff(
        &profile_key(profile_id),
        "novels",
        previous_contents,
        next_contents,
    )
}

/// Computes exact changed and deleted V4 items between two exported snapshots in $O(N)$ time.
#[cfg(test)]
fn diff_v4_items(
    previous: Vec<V4IncomingItem>,
    next: Vec<V4IncomingItem>,
    device_id: &str,
    now: i64,
) -> Vec<V4IncomingItem> {
    // Without a profile-scoped frontend-loaded set, work deletion cannot be confirmed.
    diff_v4_items_with_work_delete_gate(previous, next, device_id, now, None)
}

fn parent_work_key_for_gate<'a>(entity_type: &str, entity_key: &'a str) -> Option<&'a str> {
    match entity_type {
        "book.work" | "novel.work" | "book.progress" | "novel.history" => Some(entity_key),
        "book.category_assignment"
        | "book.highlight"
        | "book.bookmark"
        | "book.history"
        | "novel.chapter"
        | "novel.bookmark"
        | "novel.category_assignment"
        | "novel.tracking" => Some(
            entity_key
                .split_once('|')
                .map(|(work, _)| work)
                .unwrap_or(entity_key),
        ),
        _ => None,
    }
}

fn diff_v4_items_with_work_delete_gate(
    previous: Vec<V4IncomingItem>,
    next: Vec<V4IncomingItem>,
    device_id: &str,
    now: i64,
    gate: Option<(&str, &HashSet<String>)>,
) -> Vec<V4IncomingItem> {
    let prev_map: HashMap<(String, String), V4IncomingItem> = previous
        .into_iter()
        .map(|item| ((item.entity_type.clone(), item.entity_key.clone()), item))
        .collect();
    let mut next_keys: HashSet<(String, String)> = HashSet::with_capacity(next.len());
    let mut delta = Vec::new();
    let mut counter: i64 = 0;

    for mut item in next {
        let key = (item.entity_type.clone(), item.entity_key.clone());
        next_keys.insert(key.clone());
        let unchanged = prev_map
            .get(&key)
            .is_some_and(|old| old.payload == item.payload && old.deleted == item.deleted);
        if !unchanged {
            item.hlc = Hlc::new(now.max(1), counter, device_id);
            counter += 1;
            delta.push(item);
        }
    }

    // Any entity present before and absent now becomes an explicit durable tombstone,
    // except works (and their children) that were not loaded by the frontend.
    for (key, old) in prev_map {
        if !next_keys.contains(&key) {
            if let Some(parent_work_key) =
                parent_work_key_for_gate(&old.entity_type, &old.entity_key)
            {
                let allowed_for_domain = gate
                    .filter(|(work_type, _)| {
                        (*work_type == "book.work" && old.domain == "books")
                            || (*work_type == "novel.work" && old.domain == "novels")
                    })
                    .is_some_and(|(_, allowed)| allowed.contains(parent_work_key));
                if !allowed_for_domain {
                    continue;
                }
            }
            delta.push(V4IncomingItem {
                client_mutation_id: None,
                domain: old.domain,
                entity_type: old.entity_type,
                entity_key: old.entity_key,
                deleted: true,
                hlc: Hlc::new(now.max(1), counter, device_id),
                payload: Value::Null,
            });
            counter += 1;
        }
    }

    delta
}

async fn push_v4_items(
    conn: &ActiveV4Connection,
    items: Vec<V4IncomingItem>,
) -> Result<(), String> {
    let client = build_local_v4_client()?;
    if items.len() <= 250 {
        let url = format!("{}/v4/deltas", conn.base_url);
        let resp = apply_v4_headers(client.post(&url), &conn.access_token)
            .json(&json!({ "items": items }))
            .send()
            .await
            .map_err(|err| err.to_string())?;
        if !resp.status().is_success() {
            return Err(format!(
                "V4 desktop delta push failed: HTTP {}",
                resp.status()
            ));
        }
    } else {
        for chunk in items.chunks(15_000) {
            let url = format!("{}/v4/sync/bulk", conn.base_url);
            let resp = apply_v4_headers(client.post(&url), &conn.access_token)
                .json(&json!({ "items": chunk }))
                .send()
                .await
                .map_err(|err| err.to_string())?;
            if !resp.status().is_success() {
                return Err(format!(
                    "V4 desktop bulk push failed: HTTP {}",
                    resp.status()
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_v4_item_work_tombstones_require_a_frontend_loaded_key() {
        let sha1 = "a".repeat(64);
        let sha2 = "b".repeat(64);
        let prev_doc = json!({
            "books": [
                { "id": "b1", "assetFingerprint": sha1, "title": "Book One", "subtype": "epub" },
                { "id": "b2", "assetFingerprint": sha2, "title": "Book Two", "subtype": "pdf" }
            ]
        });
        let next_doc = json!({
            "books": [
                { "id": "b1", "assetFingerprint": sha1, "title": "Book One (Edited)", "subtype": "epub" }
            ]
        });

        let prev = export_desktop_books_to_v4(&prev_doc, "desktop-1", 1_000);
        let next = export_desktop_books_to_v4(&next_doc, "desktop-1", 2_000);
        let delta = diff_v4_items(prev, next, "desktop-1", 2_000);

        assert_eq!(delta.len(), 1);
        let edited = delta.iter().find(|i| i.entity_key == sha1).unwrap();
        assert!(!edited.deleted);
        assert_eq!(edited.payload["title"], json!("Book One (Edited)"));
        assert!(!delta
            .iter()
            .any(|item| item.entity_type == "book.work" && item.deleted));

        let loaded = HashSet::from([sha2.clone()]);
        let prev = export_desktop_books_to_v4(&prev_doc, "desktop-1", 1_000);
        let next = export_desktop_books_to_v4(&next_doc, "desktop-1", 2_000);
        let delta = diff_v4_items_with_work_delete_gate(
            prev,
            next,
            "desktop-1",
            2_000,
            Some(("book.work", &loaded)),
        );
        assert_eq!(delta.len(), 2);
        let deleted = delta.iter().find(|i| i.entity_key == sha2).unwrap();
        assert!(deleted.deleted);
    }

    #[test]
    fn revision_advances_on_remote_save_and_marks_queued_frontend_write_stale() {
        let profile = "revision-safety-regression";
        let _guard = with_library_state_lock(Some(profile), "books", || {
            note_library_loaded(Some(profile), "books");
            assert!(!frontend_write_is_stale(Some(profile), "books"));
            note_library_saved(Some(profile), "books", false);
            assert!(frontend_write_is_stale(Some(profile), "books"));
            Ok(())
        });
        assert!(_guard.is_ok());
    }

    #[test]
    fn initial_desktop_export_uses_baseline_hlc_and_keeps_local_work_tombstones() {
        let sha = "c".repeat(64);
        let books = json!({ "books": [{"id":"local","assetFingerprint":sha,"title":"Local","subtype":"epub"}] });
        let novels = json!({ "entries": [{"id":"n1","source":{"pluginId":"p"},"path":"/local","title":"Local novel"}] });
        let exported_books = export_desktop_books_to_v4(&books, "desktop", 1);
        let exported_novels = export_desktop_novels_to_v4(&novels, "desktop", 1);
        assert!(!exported_books.is_empty());
        assert!(!exported_novels.is_empty());
        assert!(exported_books
            .iter()
            .chain(exported_novels.iter())
            .all(|item| item.hlc.ts_ms == 1));
        assert!(exported_books
            .windows(2)
            .all(|pair| pair[0].hlc.counter < pair[1].hlc.counter));
        assert!(exported_novels
            .windows(2)
            .all(|pair| pair[0].hlc.counter < pair[1].hlc.counter));

        let tombstone = V4WireRecord {
            server_seq: 1,
            domain: "books".into(),
            entity_type: "book.work".into(),
            entity_key: "c".repeat(64),
            hlc: Hlc::new(5, 0, "remote"),
            origin_device_id: "remote".into(),
            deleted: true,
            payload: Value::Null,
            updated_at_ms: 5,
        };
        let keys = HashSet::from(["c".repeat(64)]);
        assert!(initial_snapshot_records(&[tombstone], "books", &keys, true).is_empty());
    }

    #[test]
    fn local_publish_hlc_advances_after_observing_remote_hlc() {
        let profile = "hlc-order-regression";
        observe_profile_hlc(profile, &Hlc::new(50_000, 9, "remote"));
        let first = next_profile_hlc(profile, "desktop", 40_000);
        let second = next_profile_hlc(profile, "desktop", 40_000);
        assert!(first > Hlc::new(50_000, 9, "remote"));
        assert!(second > first);
    }

    #[test]
    fn unloaded_stale_book_write_restores_all_books_and_never_tombstones_them() {
        let profile = "test-unloaded-books";
        let books = (0..5).map(|index| json!({
            "id": format!("local-{index}"), "assetFingerprint": format!("{:064x}", index + 1),
            "title": format!("Book {index}"), "subtype": "epub", "assetPath": format!("asset-{index}"),
        })).collect::<Vec<_>>();
        let previous = json!({
            "version":1,"books":books,
            "bookProgress":(0..5).map(|index| json!({"bookId":format!("local-{index}"),"progressPercent":0.2})).collect::<Vec<_>>(),
            "bookBookmarks":(0..5).map(|index| if index == 4 {
                json!({"bookId":"local-4","savedAt":4,"location":"epubcfi(/6/4)"})
            } else {
                json!({"bookmarkId":format!("bookmark-{index}"),"bookId":format!("local-{index}")})
            }).collect::<Vec<_>>(),
            "bookHighlights":(0..5).map(|index| json!({"highlightId":format!("highlight-{index}"),"bookId":format!("local-{index}")})).collect::<Vec<_>>(),
            "bookHistory":(0..5).map(|index| json!({"historyId":format!("history-{index}"),"bookId":format!("local-{index}")})).collect::<Vec<_>>(),
            "booksCategories":[{"id":"cat-a","name":"Reading","order":0}],
            "booksCategoryAssignments":(0..5).map(|index| (format!("local-{index}"), json!(["cat-a"]))).collect::<serde_json::Map<_,_>>(),
        });
        let stale = json!({"version":1,"books":[],"bookProgress":[],"bookBookmarks":[],"booksCategories":[],"booksCategoryAssignments":{}});
        let reconciled = reconcile_frontend_book_write(
            Some(profile),
            Some(&previous.to_string()),
            &stale.to_string(),
        )
        .unwrap();
        let reconciled: Value = serde_json::from_str(&reconciled).unwrap();
        assert_eq!(reconciled["books"].as_array().unwrap().len(), 5);
        assert_eq!(reconciled["bookProgress"].as_array().unwrap().len(), 5);
        assert_eq!(reconciled["bookBookmarks"].as_array().unwrap().len(), 5);
        assert_eq!(reconciled["bookHighlights"].as_array().unwrap().len(), 5);
        assert_eq!(reconciled["bookHistory"].as_array().unwrap().len(), 5);
        assert_eq!(
            reconciled["booksCategoryAssignments"]
                .as_object()
                .unwrap()
                .len(),
            5
        );
        assert_eq!(reconciled["booksCategories"].as_array().unwrap().len(), 1);
        let previous_items = export_desktop_books_to_v4(&previous, "desktop", 100);
        let next_items = export_desktop_books_to_v4(&reconciled, "desktop", 100);
        let no_loaded_keys = HashSet::new();
        let delta = diff_v4_items_with_work_delete_gate(
            previous_items,
            next_items,
            "desktop",
            101,
            Some(("book.work", &no_loaded_keys)),
        );
        assert_eq!(
            delta
                .iter()
                .filter(|item| item.entity_type == "book.work" && item.deleted)
                .count(),
            0
        );
    }

    #[test]
    fn loaded_book_write_can_delete_exactly_the_removed_book() {
        let profile = "test-loaded-book-delete";
        let previous = json!({"entries":[],"books":(0..5).map(|index| json!({
            "id":format!("book-{index}"),"assetFingerprint":format!("{:064x}", index + 1),"title":format!("Book {index}"),"subtype":"epub"
        })).collect::<Vec<_>>()});
        note_books_loaded_by_frontend(Some(profile), &previous.to_string());
        let next = json!({"books":previous["books"].as_array().unwrap().iter().take(4).cloned().collect::<Vec<_>>()});
        let reconciled = reconcile_frontend_book_write(
            Some(profile),
            Some(&previous.to_string()),
            &next.to_string(),
        )
        .unwrap();
        let reconciled: Value = serde_json::from_str(&reconciled).unwrap();
        assert_eq!(reconciled["books"].as_array().unwrap().len(), 4);
        let prior_items = export_desktop_books_to_v4(&previous, "desktop", 100);
        let next_items = export_desktop_books_to_v4(&reconciled, "desktop", 100);
        let loaded = loaded_books()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(profile)
            .unwrap()
            .clone();
        let delta = diff_v4_items_with_work_delete_gate(
            prior_items,
            next_items,
            "desktop",
            101,
            Some(("book.work", &loaded)),
        );
        let tombstones = delta
            .iter()
            .filter(|item| item.entity_type == "book.work" && item.deleted)
            .collect::<Vec<_>>();
        assert_eq!(tombstones.len(), 1);
        assert_eq!(tombstones[0].entity_key, format!("{:064x}", 5));
    }

    #[test]
    fn unloaded_stale_novel_write_restores_all_novels_and_loaded_delete_is_allowed() {
        let profile = "test-novel-stale-write";
        let entries = (0..5).map(|index| json!({
            "id":format!("novel-{index}"),"path":format!("/novel/{index}"),"title":format!("Novel {index}"),
            "source":{"pluginId":"plugin.test","lang":"en"},"addedAt":1,"updatedAt":1
        })).collect::<Vec<_>>();
        let previous = json!({
            "version":1,"scopeKey":"profile","entries":entries,
            "chapters":(0..5).map(|index| json!({"id":format!("chapter-{index}"),"novelId":format!("novel-{index}")})).collect::<Vec<_>>(),
            "progress":(0..5).map(|index| json!({"novelId":format!("novel-{index}")})).collect::<Vec<_>>(),
            "bookmarks":(0..5).map(|index| if index == 4 {
                json!({"novelId":"novel-4","chapterId":"chapter-4","savedAt":4,"locator":"chapter-position"})
            } else {
                json!({"novelId":format!("novel-{index}"),"syncId":format!("bookmark-{index}")})
            }).collect::<Vec<_>>(),
            "history":(0..5).map(|index| if index == 4 {
                json!({"novelId":"novel-4","chapterId":"chapter-4","readAt":4,"locator":"chapter-position"})
            } else {
                json!({"novelId":format!("novel-{index}"),"historyId":format!("history-{index}")})
            }).collect::<Vec<_>>()
        });
        let stale = json!({"version":1,"scopeKey":"profile","entries":[],"chapters":[],"progress":[],"bookmarks":[],"history":[]});
        let reconciled = reconcile_frontend_novel_write(
            Some(profile),
            Some(&previous.to_string()),
            &stale.to_string(),
        )
        .unwrap();
        let reconciled: Value = serde_json::from_str(&reconciled).unwrap();
        assert_eq!(reconciled["entries"].as_array().unwrap().len(), 5);
        assert_eq!(reconciled["chapters"].as_array().unwrap().len(), 5);
        assert_eq!(reconciled["progress"].as_array().unwrap().len(), 5);
        assert_eq!(reconciled["bookmarks"].as_array().unwrap().len(), 5);
        assert_eq!(reconciled["history"].as_array().unwrap().len(), 5);
        let prior = export_desktop_novels_to_v4(&previous, "desktop", 100);
        let next = export_desktop_novels_to_v4(&reconciled, "desktop", 100);
        let no_loaded = HashSet::new();
        let delta = diff_v4_items_with_work_delete_gate(
            prior.clone(),
            next,
            "desktop",
            101,
            Some(("novel.work", &no_loaded)),
        );
        assert_eq!(
            delta
                .iter()
                .filter(|item| item.entity_type == "novel.work" && item.deleted)
                .count(),
            0
        );

        note_novels_loaded_by_frontend(Some(profile), &previous.to_string());
        let next = json!({"entries":previous["entries"].as_array().unwrap().iter().take(4).cloned().collect::<Vec<_>>()});
        let reconciled = reconcile_frontend_novel_write(
            Some(profile),
            Some(&previous.to_string()),
            &next.to_string(),
        )
        .unwrap();
        let reconciled: Value = serde_json::from_str(&reconciled).unwrap();
        assert_eq!(reconciled["entries"].as_array().unwrap().len(), 4);
        let allowed = loaded_novels()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(profile)
            .unwrap()
            .clone();
        let delta = diff_v4_items_with_work_delete_gate(
            prior,
            export_desktop_novels_to_v4(&reconciled, "desktop", 100),
            "desktop",
            101,
            Some(("novel.work", &allowed)),
        );
        assert_eq!(
            delta
                .iter()
                .filter(|item| item.entity_type == "novel.work" && item.deleted)
                .count(),
            1
        );
    }

    #[test]
    fn unloaded_work_never_emits_child_tombstones_even_on_fresh_diff() {
        let sha_unloaded = "d".repeat(64);
        let sha_loaded = "e".repeat(64);
        let prev_doc = json!({
            "books": [
                { "id": "b-unloaded", "assetFingerprint": sha_unloaded, "title": "Unloaded", "subtype": "epub" },
                { "id": "b-loaded", "assetFingerprint": sha_loaded, "title": "Loaded", "subtype": "epub" }
            ],
            "bookProgress": [
                { "bookId": "b-unloaded", "progressPercent": 0.5 },
                { "bookId": "b-loaded", "progressPercent": 0.5 }
            ],
            "bookBookmarks": [
                { "bookmarkId": "bm-unloaded", "bookId": "b-unloaded", "location": "epubcfi(/6/2)" },
                { "bookmarkId": "bm-loaded", "bookId": "b-loaded", "location": "epubcfi(/6/4)" }
            ]
        });
        let next_doc = json!({
            "books": [
                { "id": "b-loaded", "assetFingerprint": sha_loaded, "title": "Loaded", "subtype": "epub" }
            ],
            "bookProgress": [
                { "bookId": "b-loaded", "progressPercent": 0.5 }
            ],
            "bookBookmarks": []
        });
        let prev = export_desktop_books_to_v4(&prev_doc, "desktop", 100);
        let next = export_desktop_books_to_v4(&next_doc, "desktop", 200);
        let loaded = HashSet::from([sha_loaded.clone()]);
        let delta = diff_v4_items_with_work_delete_gate(
            prev,
            next,
            "desktop",
            200,
            Some(("book.work", &loaded)),
        );
        // Only the loaded book's bookmark tombstone should be emitted; the unloaded work and its children must emit 0 tombstones.
        assert_eq!(delta.len(), 1);
        assert!(delta[0].deleted);
        assert_eq!(delta[0].entity_type, "book.bookmark");
        assert_eq!(delta[0].entity_key, format!("{sha_loaded}|bm-loaded"));
    }

    #[test]
    fn fifo_publish_queue_preserves_batch_order_and_monotonic_hlc() {
        let profile = "test-fifo-queue-order";
        let (tx, mut rx) = mpsc::unbounded_channel::<PublishBatch>();
        publish_queues()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(profile.to_owned(), tx);
        profile_devices()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(profile.to_owned(), "desktop-fifo".to_owned());

        let sha = "f".repeat(64);
        let doc0 = json!({ "books": [{ "id": "b1", "assetFingerprint": sha, "title": "v0", "subtype": "epub" }] }).to_string();
        let doc1 = json!({ "books": [{ "id": "b1", "assetFingerprint": sha, "title": "v1", "subtype": "epub" }] }).to_string();
        let doc2 = json!({ "books": [{ "id": "b1", "assetFingerprint": sha, "title": "v2", "subtype": "epub" }] }).to_string();

        enqueue_books_diff(Some(profile), Some(&doc0), &doc1).unwrap();
        enqueue_books_diff(Some(profile), Some(&doc1), &doc2).unwrap();

        let first = rx.try_recv().unwrap();
        let second = rx.try_recv().unwrap();
        assert_eq!(first.items[0].payload["title"], json!("v1"));
        assert_eq!(second.items[0].payload["title"], json!("v2"));
        assert!(second.items[0].hlc > first.items[0].hlc);
    }
}
