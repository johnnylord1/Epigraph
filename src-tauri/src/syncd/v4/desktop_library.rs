//! Bidirectional Sync V4 adapter for Desktop Novels & Books stored in `library_sqlite`.
//!
//! Converts Desktop's SQLite-backed library documents (`novels.sqlite3` and `books.sqlite3`)
//! directly to and from canonical V4 records without JSON diffing or $O(N^2)$ scans.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{json, Map, Value};

use super::db::{V4IncomingItem, V4WireRecord};
use super::hlc::{canonical_chapter_key, canonical_work_key, Hlc};

/// Exports a Desktop `novels` library document (as stored in `library_sqlite`) into canonical
/// V4 items (`novel.work`, `novel.chapter`, `novel.history`, and `novel.bookmark`).
pub fn export_desktop_novels_to_v4(
    doc: &Value,
    device_id: &str,
    base_ts_ms: i64,
) -> Vec<V4IncomingItem> {
    let mut items = Vec::new();
    let mut counter: i64 = 0;
    let mut next_hlc = || {
        let hlc = Hlc::new(base_ts_ms.max(1), counter, device_id);
        counter += 1;
        hlc
    };

    // Works. Current Desktop entries keep plugin identity under `source`.
    let mut work_keys_by_local_id: HashMap<String, String> = HashMap::new();
    if let Some(entries) = doc
        .get("entries")
        .and_then(Value::as_array)
        .or_else(|| doc.get("novels").and_then(Value::as_array))
    {
        for novel in entries {
            let Some(plugin_id) = novel
                .get("source")
                .and_then(|source| source.get("pluginId"))
                .or_else(|| novel.get("pluginId"))
                .or_else(|| novel.get("sourceId"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let Some(url) = novel
                .get("path")
                .or_else(|| novel.get("url"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let work_key = canonical_work_key(plugin_id, url);
            if let Some(id) = novel.get("id").and_then(Value::as_str) {
                work_keys_by_local_id.insert(id.to_string(), work_key.clone());
            }
            items.push(V4IncomingItem {
                client_mutation_id: None,
                domain: "novels".to_string(),
                entity_type: "novel.work".to_string(),
                entity_key: work_key.clone(),
                deleted: false,
                hlc: next_hlc(),
                payload: json!({
                    "pluginId": plugin_id,
                "sourceLang": novel.get("source").and_then(|source| source.get("lang")).and_then(Value::as_str)
                    .or_else(|| novel.get("sourceLang").and_then(Value::as_str)).unwrap_or("en"),
                    "url": url,
                    "title": novel.get("title").or_else(|| novel.get("name")).and_then(Value::as_str).unwrap_or(""),
                    "author": novel.get("author"),
                    "description": novel.get("description").or_else(|| novel.get("summary")),
                    "genre": novel.get("tags").and_then(Value::as_array).map(|tags| tags.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
                        .or_else(|| novel.get("genre").and_then(Value::as_str).map(str::to_owned)),
                    "coverUrl": novel.get("coverUrl").or_else(|| novel.get("cover")),
                    "favorite": novel.get("favorite").or_else(|| novel.get("inLibrary")).and_then(Value::as_bool).unwrap_or(true),
                    "dateAdded": novel.get("addedAt").or_else(|| novel.get("dateAdded")),
                    "updatedAtMs": novel.get("updatedAt"),
                    "status": novel.get("status"),
                    "chapterCount": novel.get("chapterCount"),
                }),
            });
        }
    }

    let progress_by_chapter_id: HashMap<String, &Value> = doc
        .get("progress")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            entry
                .get("chapterId")
                .and_then(Value::as_str)
                .map(|id| (id.to_owned(), entry))
        })
        .collect();
    let bookmarked_chapter_ids: HashSet<String> = doc
        .get("bookmarks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            entry
                .get("chapterId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();

    // Chapters — Desktop stores `unread`; V4 stores its inverse, `isRead`.
    if let Some(chapters) = doc.get("chapters").and_then(Value::as_array) {
        for ch in chapters {
            let Some(novel_id) = ch.get("novelId").and_then(Value::as_str) else {
                continue;
            };
            let Some(work_key) = work_keys_by_local_id.get(novel_id) else {
                continue;
            };
            let Some(ch_url) = ch
                .get("path")
                .or_else(|| ch.get("url"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let ch_key = canonical_chapter_key(work_key, ch_url);
            let progress_entry = ch
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| progress_by_chapter_id.get(id).copied());
            items.push(V4IncomingItem {
                client_mutation_id: None,
                domain: "novels".to_string(),
                entity_type: "novel.chapter".to_string(),
                entity_key: ch_key,
                deleted: false,
                hlc: next_hlc(),
                payload: json!({
                    "workKey": work_key,
                    "url": ch_url,
                "name": ch.get("title").or_else(|| ch.get("name")).and_then(Value::as_str).unwrap_or(""),
                    "chapterNumber": ch.get("chapterNumber").or_else(|| ch.get("order").or_else(|| ch.get("position"))),
                    "sourceOrder": ch.get("order").or_else(|| ch.get("position")).or_else(|| ch.get("sourceOrder")),
                "isRead": ch.get("unread").and_then(Value::as_bool).map(|unread| !unread)
                    .or_else(|| ch.get("isRead").or_else(|| ch.get("read")).and_then(Value::as_bool)).unwrap_or(false),
                    "isBookmarked": ch.get("isBookmarked").or_else(|| ch.get("bookmark")).and_then(Value::as_bool)
                        .or_else(|| ch.get("id").and_then(Value::as_str).map(|id| bookmarked_chapter_ids.contains(id))).unwrap_or(false),
                    "progressPercent": progress_entry.and_then(|entry| entry.get("progressPercent"))
                        .or_else(|| ch.get("progress").or_else(|| ch.get("progressPercent")))
                        .and_then(Value::as_f64),
                    "progressChapterTitle": progress_entry.and_then(|entry| entry.get("chapterTitle")),
                    "progressLocator": progress_entry.and_then(|entry| entry.get("locator")),
                    "progressUpdatedAtMs": progress_entry.and_then(|entry| entry.get("updatedAt")),
                    "dateUpload": ch.get("releaseTime").or_else(|| ch.get("dateUpload")),
                    "updatedAtMs": ch.get("updatedAt"),
                }),
            });
        }
    }

    let chapter_keys_by_id: HashMap<String, (String, String)> = doc
        .get("chapters")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|chapter| {
            let novel_id = chapter.get("novelId")?.as_str()?;
            let chapter_id = chapter.get("id")?.as_str()?;
            let path = chapter.get("path")?.as_str()?;
            Some((
                chapter_id.to_owned(),
                (
                    work_keys_by_local_id.get(novel_id)?.clone(),
                    path.to_owned(),
                ),
            ))
        })
        .collect();

    if let Some(entries) = doc.get("bookmarks").and_then(Value::as_array) {
        for entry in entries {
            let Some(novel_id) = entry.get("novelId").and_then(Value::as_str) else {
                continue;
            };
            let Some(work_key) = work_keys_by_local_id.get(novel_id) else {
                continue;
            };
            let chapter_id = entry.get("chapterId").and_then(Value::as_str);
            let chapter_key = chapter_id
                .and_then(|id| chapter_keys_by_id.get(id))
                .map(|(work, path)| canonical_chapter_key(work, path));
            let mut payload = entry.as_object().cloned().unwrap_or_default();
            payload.remove("novelId");
            payload.remove("chapterId");
            payload.insert("workKey".into(), json!(work_key));
            if let Some(chapter_key) = chapter_key.clone() {
                payload.insert("chapterKey".into(), json!(chapter_key));
            }
            let stable_child_id = entry
                .get("syncId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "{}|{}",
                        chapter_key.as_deref().unwrap_or(""),
                        entry.get("savedAt").and_then(Value::as_i64).unwrap_or(0)
                    )
                });
            items.push(V4IncomingItem {
                client_mutation_id: None,
                domain: "novels".to_string(),
                entity_type: "novel.bookmark".to_string(),
                entity_key: format!("{work_key}|{stable_child_id}"),
                deleted: false,
                hlc: next_hlc(),
                payload: Value::Object(payload),
            });
        }
    }

    // History is stored as per-read local rows; V4 stores a per-work envelope.
    if let Some(history) = doc.get("history").and_then(Value::as_array) {
        let mut by_work: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for entry in history {
            let Some(novel_id) = entry.get("novelId").and_then(Value::as_str) else {
                continue;
            };
            let Some(work_key) = work_keys_by_local_id.get(novel_id) else {
                continue;
            };
            let chapter_key = entry
                .get("chapterId")
                .and_then(Value::as_str)
                .and_then(|id| chapter_keys_by_id.get(id))
                .map(|(work, path)| canonical_chapter_key(work, path))
                .or_else(|| {
                    entry
                        .get("chapterPath")
                        .or_else(|| entry.get("chapterUrl"))
                        .and_then(Value::as_str)
                        .map(|path| canonical_chapter_key(work_key, path))
                });
            let Some(ch_key) = chapter_key else { continue };
            by_work.entry(work_key.clone()).or_default().push(json!({
                "chapterKey": ch_key,
                "lastReadAtMs": entry.get("readAt").or_else(|| entry.get("lastReadAtMs")).and_then(Value::as_i64).unwrap_or(0),
                "historyId": entry.get("historyId"),
                "chapterTitle": entry.get("chapterTitle"),
                "locator": entry.get("locator"),
            }));
        }
        for (work_key, entries) in by_work {
            items.push(V4IncomingItem {
                client_mutation_id: None,
                domain: "novels".to_string(),
                entity_type: "novel.history".to_string(),
                entity_key: work_key.clone(),
                deleted: false,
                hlc: next_hlc(),
                payload: json!({
                    "workKey": work_key,
                    "historyEntries": entries,
                }),
            });
        }
    }

    items
}

/// Applies canonical V4 `novels` records directly into a Desktop novels document in $O(N)$ time
/// using hash indexes (zero quadratic scans).
pub fn apply_v4_records_to_desktop_novels(doc: &mut Value, records: &[V4WireRecord]) {
    let root = ensure_object(doc);

    let legacy_entries = root.get("entries").and_then(Value::as_array).is_none();
    // Index current persisted `entries`, with `novels` accepted only as a legacy input.
    let mut works_map: BTreeMap<String, Value> = BTreeMap::new();
    let mut local_id_to_work_key: HashMap<String, String> = HashMap::new();
    if let Some(existing) = root
        .get("entries")
        .and_then(Value::as_array)
        .or_else(|| root.get("novels").and_then(Value::as_array))
    {
        for novel in existing {
            if let (Some(pid), Some(url)) = (
                novel
                    .get("source")
                    .and_then(|source| source.get("pluginId"))
                    .and_then(Value::as_str)
                    .or_else(|| novel.get("pluginId").and_then(Value::as_str))
                    .or_else(|| novel.get("sourceId").and_then(Value::as_str)),
                novel
                    .get("path")
                    .or_else(|| novel.get("url"))
                    .and_then(Value::as_str),
            ) {
                let wk = canonical_work_key(pid, url);
                if let Some(id) = novel.get("id").and_then(Value::as_str) {
                    local_id_to_work_key.insert(id.to_string(), wk.clone());
                }
                works_map.insert(wk, novel.clone());
            }
        }
    }

    // Index existing chapters by canonical chapterKey -> Value.
    let mut chapters_map: BTreeMap<String, Value> = BTreeMap::new();
    let mut local_chapter_ids: HashMap<String, String> = HashMap::new();
    if let Some(existing) = root.get("chapters").and_then(Value::as_array) {
        for ch in existing {
            if let (Some(nid), Some(url)) = (
                ch.get("novelId").and_then(Value::as_str),
                ch.get("path")
                    .or_else(|| ch.get("url"))
                    .and_then(Value::as_str),
            ) {
                let wk = local_id_to_work_key
                    .get(nid)
                    .cloned()
                    .unwrap_or_else(|| nid.to_string());
                let ck = canonical_chapter_key(&wk, url);
                if let Some(id) = ch.get("id").and_then(Value::as_str) {
                    local_chapter_ids.insert(ck.clone(), id.to_owned());
                }
                chapters_map.insert(ck, ch.clone());
            }
        }
    }

    // Index existing history by workKey.
    let mut history_map: BTreeMap<String, Value> = BTreeMap::new();
    if let Some(existing) = root.get("history").and_then(Value::as_array) {
        for entry in existing {
            if let Some(nid) = entry.get("novelId").and_then(Value::as_str) {
                let wk = local_id_to_work_key
                    .get(nid)
                    .cloned()
                    .unwrap_or_else(|| nid.to_string());
                let key = entry
                    .get("historyId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        format!(
                            "{}|{}",
                            wk,
                            entry.get("chapterId").and_then(Value::as_str).unwrap_or("")
                        )
                    });
                history_map.insert(key, entry.clone());
            }
        }
    }

    let mut progress_map = root
        .get("progress")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            entry
                .get("novelId")
                .and_then(Value::as_str)
                .map(|id| (id.to_owned(), entry.clone()))
        })
        .collect::<BTreeMap<_, _>>();
    let mut bookmarks_map = BTreeMap::new();
    for entry in root
        .get("bookmarks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let key = entry
            .get("syncId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("local:{}", novel_bookmark_fallback_id(entry)));
        bookmarks_map.insert(key, entry.clone());
    }

    let mut ordered = records
        .iter()
        .filter(|r| r.domain == "novels")
        .collect::<Vec<_>>();
    ordered.sort_by_key(|record| match record.entity_type.as_str() {
        "novel.work" => 0,
        "novel.chapter" => 1,
        _ => 2,
    });
    for rec in ordered {
        match rec.entity_type.as_str() {
            "novel.work" => {
                if rec.deleted {
                    works_map.remove(&rec.entity_key);
                } else {
                    let p = &rec.payload;
                    let mut obj = works_map
                        .get(&rec.entity_key)
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    obj.entry("id".to_string())
                        .or_insert_with(|| json!(rec.entity_key));
                    let mut source = obj
                        .get("source")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    if let Some(v) = p.get("pluginId") {
                        source.insert("pluginId".into(), v.clone());
                    }
                    if let Some(v) = p.get("sourceLang") {
                        source.insert("lang".into(), v.clone());
                    }
                    obj.insert("source".into(), Value::Object(source));
                    if let Some(v) = p.get("url") {
                        obj.insert("path".into(), v.clone());
                    }
                    if let Some(v) = p.get("title") {
                        obj.insert("title".into(), v.clone());
                    }
                    if let Some(v) = p.get("author") {
                        obj.insert("author".into(), v.clone());
                    }
                    if let Some(v) = p.get("description") {
                        obj.insert("description".into(), v.clone());
                    }
                    if let Some(v) = p.get("status") {
                        obj.insert("status".into(), v.clone());
                    }
                    if let Some(v) = p.get("chapterCount") {
                        obj.insert("chapterCount".into(), v.clone());
                    }
                    if let Some(v) = p.get("genre") {
                        let tags = match v {
                            Value::Array(tags) => tags.clone(),
                            Value::String(value) => value
                                .split(',')
                                .map(str::trim)
                                .filter(|v| !v.is_empty())
                                .map(|v| json!(v))
                                .collect(),
                            _ => Vec::new(),
                        };
                        obj.insert("tags".into(), Value::Array(tags));
                    }
                    if let Some(v) = p.get("coverUrl") {
                        obj.insert("coverUrl".into(), v.clone());
                    }
                    if let Some(v) = p.get("dateAdded") {
                        obj.insert("addedAt".into(), v.clone());
                    }
                    obj.insert(
                        "updatedAt".into(),
                        p.get("updatedAtMs")
                            .cloned()
                            .unwrap_or(json!(rec.updated_at_ms)),
                    );
                    if let Some(id) = obj.get("id").and_then(Value::as_str) {
                        local_id_to_work_key.insert(id.to_owned(), rec.entity_key.clone());
                    }
                    works_map.insert(rec.entity_key.clone(), Value::Object(obj));
                }
            }
            "novel.chapter" => {
                if rec.deleted {
                    chapters_map.remove(&rec.entity_key);
                    if let Some(chapter_id) = local_chapter_ids.remove(&rec.entity_key) {
                        progress_map.retain(|_, progress| {
                            progress.get("chapterId").and_then(Value::as_str) != Some(&chapter_id)
                        });
                    }
                } else {
                    let p = &rec.payload;
                    let work_key = p
                        .get("workKey")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| rec.entity_key.split('|').next().unwrap_or_default());
                    let novel_id = works_map
                        .get(work_key)
                        .and_then(|w| w.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or(work_key)
                        .to_string();
                    let mut obj = chapters_map
                        .get(&rec.entity_key)
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    obj.entry("id".to_string())
                        .or_insert_with(|| json!(rec.entity_key));
                    obj.insert("novelId".into(), json!(novel_id));
                    if let Some(v) = p.get("url") {
                        obj.insert("path".into(), v.clone());
                    }
                    if let Some(v) = p.get("name") {
                        obj.insert("title".into(), v.clone());
                    }
                    if let Some(v) = p.get("chapterNumber") {
                        obj.insert("chapterNumber".into(), v.clone());
                    }
                    if let Some(v) = p.get("sourceOrder") {
                        obj.insert("order".into(), v.clone());
                    }
                    if let Some(v) = p.get("isRead") {
                        obj.insert("unread".into(), json!(!v.as_bool().unwrap_or(false)));
                    }
                    if let Some(v) = p.get("isBookmarked") {
                        obj.insert("isBookmarked".into(), v.clone());
                    }
                    if let Some(v) = p.get("progressPercent") {
                        obj.insert("progress".into(), v.clone());
                    }
                    if let Some(v) = p.get("dateUpload") {
                        obj.insert("releaseTime".into(), v.clone());
                    }
                    obj.insert(
                        "updatedAt".into(),
                        p.get("updatedAtMs")
                            .cloned()
                            .unwrap_or(json!(rec.updated_at_ms)),
                    );
                    chapters_map.insert(rec.entity_key.clone(), Value::Object(obj));
                    if let Some(id) = chapters_map
                        .get(&rec.entity_key)
                        .and_then(|ch| ch.get("id"))
                        .and_then(Value::as_str)
                    {
                        local_chapter_ids.insert(rec.entity_key.clone(), id.to_owned());
                        if let Some(progress_percent) = p
                            .get("progressPercent")
                            .and_then(Value::as_f64)
                            .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
                        {
                            let previous = progress_map.get(&novel_id);
                            let previous_updated = previous
                                .and_then(|value| value.get("updatedAt"))
                                .and_then(Value::as_i64)
                                .unwrap_or(i64::MIN);
                            let same_chapter = previous
                                .and_then(|value| value.get("chapterId"))
                                .and_then(Value::as_str)
                                == Some(id);
                            let progress_updated_at = p
                                .get("progressUpdatedAtMs")
                                .and_then(Value::as_i64)
                                .unwrap_or(rec.updated_at_ms);
                            if (progress_percent > 0.0
                                || same_chapter
                                || p.get("progressUpdatedAtMs")
                                    .and_then(Value::as_i64)
                                    .is_some())
                                && progress_updated_at >= previous_updated
                            {
                                progress_map.insert(novel_id.clone(), json!({
                                    "novelId": novel_id,
                                    "chapterId": id,
                                    "chapterTitle": p.get("progressChapterTitle").or_else(|| p.get("name")),
                                    "progressPercent": progress_percent,
                                    "locator": p.get("progressLocator").or_else(|| if same_chapter { previous.and_then(|value| value.get("locator")) } else { None }),
                                    "updatedAt": progress_updated_at,
                                }));
                            }
                        }
                    }
                }
            }
            "novel.history" => {
                if rec.deleted {
                    history_map.retain(|_, value| {
                        value
                            .get("novelId")
                            .and_then(Value::as_str)
                            .and_then(|id| local_id_to_work_key.get(id))
                            .is_none_or(|key| key != &rec.entity_key)
                    });
                } else {
                    let p = &rec.payload;
                    let novel_id = works_map
                        .get(&rec.entity_key)
                        .and_then(|w| w.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or(&rec.entity_key)
                        .to_string();
                    let visits = p
                        .get("historyEntries")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_else(|| vec![p.clone()]);
                    for visit in visits {
                        let chapter_key = visit
                            .get("chapterKey")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let chapter_id = local_chapter_ids.get(chapter_key).cloned();
                        let history_id = visit
                            .get("historyId")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .or_else(|| {
                                chapter_id.as_deref().and_then(|chapter_id| {
                                    history_map
                                        .iter()
                                        .find(|(_, row)| {
                                            row.get("novelId").and_then(Value::as_str)
                                                == Some(&novel_id)
                                                && row.get("chapterId").and_then(Value::as_str)
                                                    == Some(chapter_id)
                                        })
                                        .and_then(|(id, _)| Some(id.clone()))
                                })
                            })
                            .unwrap_or_else(|| format!("{}|{}", rec.entity_key, chapter_key));
                        history_map.insert(history_id.clone(), json!({
                            "novelId": novel_id, "chapterId": chapter_id,
                            "chapterTitle": visit.get("chapterTitle"), "locator": visit.get("locator"),
                            "historyId": history_id,
                            "readAt": visit.get("lastReadAtMs").and_then(Value::as_i64).unwrap_or_else(|| p.get("lastReadAtMs").and_then(Value::as_i64).unwrap_or(0)),
                        }));
                    }
                }
            }
            "novel.bookmark" => {
                if rec.deleted {
                    let suffix = rec
                        .entity_key
                        .split_once('|')
                        .map(|(_, id)| id)
                        .unwrap_or(&rec.entity_key);
                    bookmarks_map.remove(suffix);
                } else {
                    let p = &rec.payload;
                    let work_key = p
                        .get("workKey")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| rec.entity_key.split('|').next().unwrap_or_default());
                    let novel_id = works_map
                        .get(work_key)
                        .and_then(|w| w.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or(work_key);
                    let suffix = rec
                        .entity_key
                        .split_once('|')
                        .map(|(_, id)| id)
                        .unwrap_or(&rec.entity_key);
                    let sync_id = p
                        .get("syncId")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .unwrap_or(suffix);
                    let chapter_key = p
                        .get("chapterKey")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let chapter_id = local_chapter_ids.get(chapter_key).cloned();
                    let updated_at = p
                        .get("updatedAtMs")
                        .and_then(Value::as_i64)
                        .unwrap_or(rec.updated_at_ms);
                    let matched_local_key = bookmarks_map
                        .iter()
                        .find(|(key, row)| {
                            key.starts_with("local:")
                                && row.get("novelId").and_then(Value::as_str) == Some(novel_id)
                                && row.get("chapterId").and_then(Value::as_str)
                                    == chapter_id.as_deref()
                                && p.get("savedAt")
                                    .and_then(Value::as_i64)
                                    .is_none_or(|saved_at| {
                                        row.get("savedAt").and_then(Value::as_i64) == Some(saved_at)
                                    })
                        })
                        .map(|(key, _)| key.clone());
                    let mut bookmark = bookmarks_map
                        .remove(sync_id)
                        .or_else(|| {
                            matched_local_key
                                .as_ref()
                                .and_then(|key| bookmarks_map.remove(key))
                        })
                        .and_then(|value| value.as_object().cloned())
                        .unwrap_or_default();
                    bookmark.insert("novelId".into(), json!(novel_id));
                    bookmark.insert("chapterId".into(), json!(chapter_id));
                    for field in ["chapterTitle", "locator", "label"] {
                        if let Some(value) = p.get(field) {
                            bookmark.insert(field.into(), value.clone());
                        }
                    }
                    let saved_at = p
                        .get("savedAt")
                        .cloned()
                        .or_else(|| bookmark.get("savedAt").cloned())
                        .unwrap_or(json!(updated_at));
                    bookmark.insert("savedAt".into(), saved_at);
                    bookmark.insert("syncId".into(), json!(sync_id));
                    bookmarks_map.insert(sync_id.to_owned(), Value::Object(bookmark));
                }
            }
            _ => {}
        }
    }

    let entries = works_map.into_values().collect::<Vec<_>>();
    root.remove("novels");
    root.insert("entries".into(), Value::Array(entries));
    root.insert(
        "chapters".into(),
        Value::Array(chapters_map.into_values().collect()),
    );
    root.insert(
        "history".into(),
        Value::Array(history_map.into_values().collect()),
    );
    root.insert(
        "progress".into(),
        Value::Array(progress_map.into_values().collect()),
    );
    root.insert(
        "bookmarks".into(),
        Value::Array(bookmarks_map.into_values().collect()),
    );
    root.entry("version").or_insert(json!(1));
    root.entry("updatedAtMs").or_insert(Value::Null);
    if legacy_entries {
        root.entry("scopeKey").or_insert(Value::Null);
    }
}

/// Exports a Desktop `books` library document into canonical V4 items (`book.work`, `book.progress`,
/// `book.bookmark`, `book.highlight`, `book.category`, `book.category_assignment`).
pub fn export_desktop_books_to_v4(
    doc: &Value,
    device_id: &str,
    base_ts_ms: i64,
) -> Vec<V4IncomingItem> {
    let mut items = Vec::new();
    let mut counter: i64 = 0;
    let mut next_hlc = || {
        let hlc = Hlc::new(base_ts_ms.max(1), counter, device_id);
        counter += 1;
        hlc
    };

    let mut book_key_by_id: HashMap<String, String> = HashMap::new();
    if let Some(books) = doc.get("books").and_then(Value::as_array) {
        for book in books {
            let Some(sha) = book_sha(book) else {
                continue;
            };
            if let Some(id) = book.get("id").and_then(Value::as_str) {
                book_key_by_id.insert(id.to_string(), sha.clone());
            }
            let subtype = book
                .get("subtype")
                .and_then(Value::as_str)
                .unwrap_or("epub");
            let mime_type = book
                .get("mimeType")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    if subtype == "pdf" {
                        "application/pdf".to_string()
                    } else {
                        "application/epub+zip".to_string()
                    }
                });
            let cover_sha = book
                .get("coverAssetSha256")
                .and_then(Value::as_str)
                .filter(|sha| is_lower_sha256(sha));
            let cover_size = book
                .get("coverAssetByteSize")
                .and_then(Value::as_i64)
                .filter(|size| (1..=8_388_608).contains(size));
            let cover_mime = book
                .get("coverAssetMimeType")
                .and_then(Value::as_str)
                .filter(|mime| matches!(*mime, "image/png" | "image/webp" | "image/jpeg"));
            let mut payload = json!({
                "title": book.get("title").and_then(Value::as_str).unwrap_or(""),
                "author": book.get("author"),
                "description": book.get("description"),
                "subtype": subtype,
                "fileSha256": sha,
                "byteSize": book.get("byteSize"),
                "mimeType": mime_type,
                "pageCount": book.get("pageCount"),
                "createdAtMs": book.get("createdAt"),
                "updatedAtMs": book.get("updatedAt"),
                "hasCover": book.get("hasCover"),
            });
            if let (Some(sha), Some(size), Some(mime)) = (cover_sha, cover_size, cover_mime) {
                let fields = payload.as_object_mut().expect("work payload is an object");
                fields.insert("coverSha256".into(), json!(sha));
                fields.insert("coverByteSize".into(), json!(size));
                fields.insert("coverMimeType".into(), json!(mime));
            }
            items.push(V4IncomingItem {
                client_mutation_id: None,
                domain: "books".to_string(),
                entity_type: "book.work".to_string(),
                entity_key: sha.clone(),
                deleted: false,
                hlc: next_hlc(),
                payload,
            });
        }
    }

    if let Some(progress_rows) = doc.get("bookProgress").and_then(Value::as_array) {
        for progress in progress_rows {
            let Some(book_id) = progress.get("bookId").and_then(Value::as_str) else {
                continue;
            };
            let Some(book_key) = book_key_by_id.get(book_id) else {
                continue;
            };
            let Some(book) = doc
                .get("books")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|book| book.get("id").and_then(Value::as_str) == Some(book_id))
            else {
                continue;
            };
            let locator = reader_locator_from_desktop(
                progress,
                book_id,
                book.get("subtype")
                    .and_then(Value::as_str)
                    .unwrap_or("epub"),
            );
            items.push(V4IncomingItem {
                client_mutation_id: None,
                domain: "books".into(),
                entity_type: "book.progress".into(),
                entity_key: book_key.clone(),
                deleted: false,
                hlc: next_hlc(),
                payload: json!({
                    "locator": locator,
                    "progressPercent": progress.get("progressPercent"),
                    "lastReadAtMs": progress.get("lastReadAt"),
                    "sectionLabel": progress.get("sectionLabel"),
                }),
            });
        }
    }

    if let Some(categories) = doc.get("booksCategories").and_then(Value::as_array) {
        for (index, category) in categories.iter().enumerate() {
            let Some(name) = category
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
            else {
                continue;
            };
            let key = name.to_ascii_lowercase();
            items.push(V4IncomingItem {
                client_mutation_id: None, domain: "books".into(), entity_type: "book.category".into(),
                entity_key: key, deleted: false, hlc: next_hlc(),
                payload: json!({ "name": name, "order": category.get("order").and_then(Value::as_i64).unwrap_or(index as i64) }),
            });
        }
    }

    let mut category_key_by_id = HashMap::new();
    if let Some(categories) = doc.get("booksCategories").and_then(Value::as_array) {
        for category in categories {
            if let (Some(id), Some(name)) = (
                category.get("id").and_then(Value::as_str),
                category.get("name").and_then(Value::as_str),
            ) {
                category_key_by_id.insert(id.to_owned(), name.trim().to_ascii_lowercase());
            }
        }
    }
    if let Some(assignments) = doc
        .get("booksCategoryAssignments")
        .and_then(Value::as_object)
    {
        for (book_id, category_ids) in assignments {
            let Some(book_key) = book_key_by_id.get(book_id) else {
                continue;
            };
            for category_id in category_ids
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                let Some(category_key) = category_key_by_id.get(category_id) else {
                    continue;
                };
                items.push(V4IncomingItem {
                    client_mutation_id: None,
                    domain: "books".into(),
                    entity_type: "book.category_assignment".into(),
                    entity_key: format!("{book_key}|{category_key}"),
                    deleted: false,
                    hlc: next_hlc(),
                    payload: json!({ "categoryKey": category_key }),
                });
            }
        }
    }

    if let Some(highlights) = doc.get("bookHighlights").and_then(Value::as_array) {
        for hl in highlights {
            let Some(book_id) = hl.get("bookId").and_then(Value::as_str) else {
                continue;
            };
            let Some(hl_id) = hl.get("highlightId").and_then(Value::as_str) else {
                continue;
            };
            let Some(book_key) = book_key_by_id.get(book_id) else {
                continue;
            };
            items.push(V4IncomingItem {
                client_mutation_id: None,
                domain: "books".to_string(),
                entity_type: "book.highlight".to_string(),
                entity_key: format!("{book_key}|{hl_id}"),
                deleted: false,
                hlc: next_hlc(),
                payload: json!({
                    "startLocator": hl.get("startLocatorJson"), "endLocator": hl.get("endLocatorJson"),
                    "selectedText": hl.get("selectedText"), "colorArgb": hl.get("colorArgb"), "note": hl.get("note"),
                    "createdAtMs": hl.get("createdAtMs"), "updatedAtMs": hl.get("updatedAtMs"),
                }),
            });
        }
    }

    if let Some(bookmarks) = doc.get("bookBookmarks").and_then(Value::as_array) {
        for bm in bookmarks {
            let Some(book_id) = bm.get("bookId").and_then(Value::as_str) else {
                continue;
            };
            let Some(book_key) = book_key_by_id.get(book_id) else {
                continue;
            };
            let bm_id = book_bookmark_id(bm);
            let book = doc
                .get("books")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|book| book.get("id").and_then(Value::as_str) == Some(book_id));
            let locator = reader_locator_from_desktop(
                bm,
                book_id,
                book.and_then(|book| book.get("subtype"))
                    .and_then(Value::as_str)
                    .unwrap_or("epub"),
            );
            items.push(V4IncomingItem {
                client_mutation_id: None,
                domain: "books".to_string(),
                entity_type: "book.bookmark".to_string(),
                entity_key: format!("{book_key}|{bm_id}"),
                deleted: false,
                hlc: next_hlc(),
                payload: json!({
                    "locator": locator, "label": bm.get("label"), "note": bm.get("note"),
                    "createdAtMs": bm.get("createdAtMs").or_else(|| bm.get("savedAt")),
                    "updatedAtMs": bm.get("updatedAtMs").or_else(|| bm.get("savedAt")),
                }),
            });
        }
    }

    items
}

/// Applies canonical V4 `books` records into Desktop's persisted `PersistedBookLibraryState`.
pub fn apply_v4_records_to_desktop_books(doc: &mut Value, records: &[V4WireRecord]) {
    let root = ensure_object(doc);

    let mut books_map: BTreeMap<String, Value> = BTreeMap::new();
    if let Some(existing) = root.get("books").and_then(Value::as_array) {
        for book in existing {
            if let Some(sha) = book_sha(book) {
                books_map.insert(sha, book.clone());
            }
        }
    }

    let mut progress_map = rows_by_key(root.get("bookProgress"), "bookId", None);
    let mut highlights_map: BTreeMap<String, Value> = BTreeMap::new();
    if let Some(existing) = root.get("bookHighlights").and_then(Value::as_array) {
        for hl in existing {
            if let (Some(bid), Some(hid)) = (
                hl.get("bookId").and_then(Value::as_str),
                hl.get("highlightId").and_then(Value::as_str),
            ) {
                highlights_map.insert(format!("{bid}|{hid}"), hl.clone());
            }
        }
    }

    let mut bookmarks_map: BTreeMap<String, Value> = BTreeMap::new();
    if let Some(existing) = root.get("bookBookmarks").and_then(Value::as_array) {
        for bm in existing {
            if let Some(bid) = bm.get("bookId").and_then(Value::as_str) {
                bookmarks_map.insert(format!("{bid}|{}", book_bookmark_id(bm)), bm.clone());
            }
        }
    }

    let mut categories_map: BTreeMap<String, Value> = root
        .get("booksCategories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|category| {
            category
                .get("name")
                .and_then(Value::as_str)
                .map(|name| (name.trim().to_ascii_lowercase(), category.clone()))
        })
        .collect();
    let mut assignment_map = root
        .get("booksCategoryAssignments")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut ordered = records
        .iter()
        .filter(|r| r.domain == "books")
        .collect::<Vec<_>>();
    ordered.sort_by_key(|record| match record.entity_type.as_str() {
        "book.work" | "book.category" => 0,
        _ => 1,
    });
    let mut book_id_by_sha = books_map
        .iter()
        .filter_map(|(sha, book)| {
            book.get("id")
                .and_then(Value::as_str)
                .map(|id| (sha.clone(), id.to_owned()))
        })
        .collect::<HashMap<_, _>>();

    for rec in ordered {
        match rec.entity_type.as_str() {
            "book.work" => {
                if rec.deleted {
                    let sha =
                        canonical_sha256(&rec.entity_key).unwrap_or_else(|| rec.entity_key.clone());
                    if let Some(book) = books_map.remove(&sha) {
                        if let Some(id) = book.get("id").and_then(Value::as_str) {
                            book_id_by_sha.remove(&sha);
                            progress_map.remove(id);
                            highlights_map.retain(|_, row| {
                                row.get("bookId").and_then(Value::as_str) != Some(id)
                            });
                            bookmarks_map.retain(|_, row| {
                                row.get("bookId").and_then(Value::as_str) != Some(id)
                            });
                            assignment_map.remove(id);
                        }
                    }
                } else {
                    let p = &rec.payload;
                    let sha =
                        canonical_sha256(&rec.entity_key).unwrap_or_else(|| rec.entity_key.clone());
                    let mut obj = books_map
                        .get(&sha)
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    let subtype = p
                        .get("subtype")
                        .and_then(Value::as_str)
                        .unwrap_or("epub")
                        .to_ascii_lowercase();
                    let local_id = obj
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("{subtype}:sha256:{sha}"));
                    obj.insert("id".into(), json!(local_id));
                    obj.insert("assetFingerprint".into(), json!(sha));
                    for (wire, local) in [
                        ("title", "title"),
                        ("author", "author"),
                        ("description", "description"),
                        ("byteSize", "byteSize"),
                        ("pageCount", "pageCount"),
                    ] {
                        if let Some(value) = p.get(wire) {
                            obj.insert(local.into(), value.clone());
                        }
                    }
                    obj.insert("subtype".into(), json!(subtype));
                    let mime = p
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| {
                            if subtype == "pdf" {
                                "application/pdf".to_string()
                            } else {
                                "application/epub+zip".to_string()
                            }
                        });
                    obj.insert("mimeType".into(), json!(mime));
                    let created_at = p
                        .get("createdAtMs")
                        .cloned()
                        .or_else(|| obj.get("createdAt").cloned())
                        .unwrap_or(json!(rec.updated_at_ms));
                    obj.insert("createdAt".into(), created_at);
                    obj.insert(
                        "updatedAt".into(),
                        p.get("updatedAtMs")
                            .cloned()
                            .unwrap_or(json!(rec.updated_at_ms)),
                    );
                    let valid_cover = p
                        .get("coverSha256")
                        .and_then(Value::as_str)
                        .is_some_and(is_lower_sha256)
                        && p.get("coverByteSize")
                            .and_then(Value::as_i64)
                            .is_some_and(|size| (1..=8_388_608).contains(&size))
                        && p.get("coverMimeType")
                            .and_then(Value::as_str)
                            .is_some_and(|mime| {
                                matches!(mime, "image/png" | "image/webp" | "image/jpeg")
                            });
                    if valid_cover {
                        obj.insert("coverAssetSha256".into(), p["coverSha256"].clone());
                        obj.insert("coverAssetByteSize".into(), p["coverByteSize"].clone());
                        obj.insert("coverAssetMimeType".into(), p["coverMimeType"].clone());
                        obj.insert("hasCover".into(), json!(true));
                    } else if let Some(value) = p.get("hasCover") {
                        obj.insert("hasCover".into(), value.clone());
                    } else if !obj.contains_key("hasCover") {
                        obj.insert("hasCover".into(), json!(false));
                    }
                    book_id_by_sha.insert(sha.clone(), local_id);
                    books_map.insert(sha, Value::Object(obj));
                }
            }
            "book.progress" => {
                if let Some(book_id) = book_id_by_sha.get(&rec.entity_key) {
                    if rec.deleted {
                        progress_map.remove(book_id);
                    } else {
                        let locator = rec.payload.get("locator").cloned().unwrap_or(Value::Null);
                        let fields = locator_to_local_fields(&locator, book_id);
                        let mut row = fields;
                        if let Some(previous) = progress_map.get(book_id).and_then(Value::as_object)
                        {
                            for field in ["href", "sectionLabel"] {
                                if row.get(field).is_none_or(Value::is_null) {
                                    if let Some(value) =
                                        previous.get(field).filter(|value| !value.is_null())
                                    {
                                        row.insert(field.to_owned(), value.clone());
                                    }
                                }
                            }
                        }
                        row.insert("bookId".into(), json!(book_id));
                        row.insert(
                            "progressPercent".into(),
                            rec.payload
                                .get("progressPercent")
                                .cloned()
                                .unwrap_or(json!(0.0)),
                        );
                        row.insert(
                            "lastReadAt".into(),
                            rec.payload
                                .get("lastReadAtMs")
                                .cloned()
                                .unwrap_or(json!(rec.updated_at_ms)),
                        );
                        if let Some(value) = rec.payload.get("sectionLabel") {
                            row.insert("sectionLabel".into(), value.clone());
                        }
                        progress_map.insert(book_id.clone(), Value::Object(row));
                    }
                }
            }
            "book.category" => {
                if rec.deleted {
                    categories_map.remove(&rec.entity_key);
                } else {
                    let mut category = categories_map
                        .get(&rec.entity_key)
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    category.insert(
                        "id".into(),
                        category
                            .get("id")
                            .cloned()
                            .unwrap_or_else(|| json!(rec.entity_key)),
                    );
                    if let Some(name) = rec.payload.get("name") {
                        category.insert("name".into(), name.clone());
                    }
                    if let Some(order) = rec.payload.get("order") {
                        category.insert("order".into(), order.clone());
                    }
                    categories_map.insert(rec.entity_key.clone(), Value::Object(category));
                }
            }
            "book.category_assignment" => {
                let (sha, category_key) = rec
                    .entity_key
                    .split_once('|')
                    .unwrap_or((&rec.entity_key, ""));
                if let Some(book_id) = book_id_by_sha.get(sha) {
                    let category_key = rec
                        .payload
                        .get("categoryKey")
                        .and_then(Value::as_str)
                        .unwrap_or(category_key);
                    let category_id = categories_map
                        .get(category_key)
                        .and_then(|row| row.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or(category_key);
                    let mut ids = assignment_map
                        .get(book_id)
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    if rec.deleted {
                        ids.retain(|id| id.as_str() != Some(category_id));
                    } else if !ids.iter().any(|id| id.as_str() == Some(category_id)) {
                        ids.push(json!(category_id));
                    }
                    assignment_map.insert(book_id.clone(), Value::Array(ids));
                }
            }
            "book.highlight" => {
                let (book_key, hl_id) = rec
                    .entity_key
                    .split_once('|')
                    .unwrap_or((&rec.entity_key, ""));
                let book_id = book_id_by_sha
                    .get(book_key)
                    .map(String::as_str)
                    .unwrap_or(book_key);
                let local_key = format!("{book_id}|{hl_id}");
                if rec.deleted {
                    highlights_map.remove(&local_key);
                } else {
                    let mut obj = Map::new();
                    obj.insert("bookId".into(), json!(book_id));
                    obj.insert("highlightId".into(), json!(hl_id));
                    obj.insert(
                        "startLocatorJson".into(),
                        locator_with_local_book_id(
                            rec.payload.get("startLocator").unwrap_or(&Value::Null),
                            book_id,
                        ),
                    );
                    obj.insert(
                        "endLocatorJson".into(),
                        locator_with_local_book_id(
                            rec.payload.get("endLocator").unwrap_or(&Value::Null),
                            book_id,
                        ),
                    );
                    for field in [
                        "selectedText",
                        "colorArgb",
                        "note",
                        "createdAtMs",
                        "updatedAtMs",
                    ] {
                        if let Some(value) = rec.payload.get(field) {
                            obj.insert(field.into(), value.clone());
                        }
                    }
                    highlights_map.insert(local_key, Value::Object(obj));
                }
            }
            "book.bookmark" => {
                let (book_key, bm_id) = rec
                    .entity_key
                    .split_once('|')
                    .unwrap_or((&rec.entity_key, ""));
                let book_id = book_id_by_sha
                    .get(book_key)
                    .map(String::as_str)
                    .unwrap_or(book_key);
                let local_key = format!("{book_id}|{bm_id}");
                if rec.deleted {
                    bookmarks_map.remove(&local_key);
                } else {
                    let mut obj = locator_to_local_fields(&rec.payload["locator"], book_id);
                    if let Some(previous) = bookmarks_map.get(&local_key).and_then(Value::as_object)
                    {
                        for field in ["href", "label", "note"] {
                            if obj.get(field).is_none_or(Value::is_null) {
                                if let Some(value) =
                                    previous.get(field).filter(|value| !value.is_null())
                                {
                                    obj.insert(field.to_owned(), value.clone());
                                }
                            }
                        }
                    }
                    obj.insert("bookId".into(), json!(book_id));
                    obj.insert("bookmarkId".into(), json!(bm_id));
                    for field in ["label", "note"] {
                        if let Some(value) = rec.payload.get(field) {
                            obj.insert(field.into(), value.clone());
                        }
                    }
                    obj.insert(
                        "createdAtMs".into(),
                        rec.payload
                            .get("createdAtMs")
                            .cloned()
                            .unwrap_or(json!(rec.updated_at_ms)),
                    );
                    obj.insert(
                        "updatedAtMs".into(),
                        rec.payload
                            .get("updatedAtMs")
                            .cloned()
                            .unwrap_or(json!(rec.updated_at_ms)),
                    );
                    obj.insert(
                        "savedAt".into(),
                        rec.payload
                            .get("createdAtMs")
                            .cloned()
                            .or_else(|| rec.payload.get("updatedAtMs").cloned())
                            .unwrap_or(json!(rec.updated_at_ms)),
                    );
                    bookmarks_map.insert(local_key, Value::Object(obj));
                }
            }
            _ => {}
        }
    }

    root.insert(
        "books".into(),
        Value::Array(books_map.into_values().collect()),
    );
    root.insert(
        "bookProgress".into(),
        Value::Array(progress_map.into_values().collect()),
    );
    root.insert(
        "bookHighlights".into(),
        Value::Array(highlights_map.into_values().collect()),
    );
    root.insert(
        "bookBookmarks".into(),
        Value::Array(bookmarks_map.into_values().collect()),
    );
    root.insert(
        "booksCategories".into(),
        Value::Array(categories_map.into_values().collect()),
    );
    root.insert(
        "booksCategoryAssignments".into(),
        Value::Object(assignment_map),
    );
    root.entry("version").or_insert(json!(1));
    root.entry("booksLibraryUi").or_insert_with(|| {
        json!({
            "activeCategoryId": null, "typeFilter": "all", "statusFilter": "all", "search": "",
            "sortMode": "recentlyAdded", "sortDir": "desc"
        })
    });
    root.entry("updatedAtMs").or_insert(Value::Null);
}

fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn canonical_sha256(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    is_lower_sha256(&normalized).then_some(normalized)
}

fn book_sha(book: &Value) -> Option<String> {
    ["assetFingerprint", "fileSha256", "sha256"]
        .iter()
        .filter_map(|field| book.get(*field).and_then(Value::as_str))
        .find_map(canonical_sha256)
}

fn rows_by_key(
    value: Option<&Value>,
    key: &str,
    fallback_key: Option<&str>,
) -> BTreeMap<String, Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            row.get(key)
                .or_else(|| fallback_key.and_then(|fallback| row.get(fallback)))
                .and_then(Value::as_str)
                .map(|id| (id.to_owned(), row.clone()))
        })
        .collect()
}

fn book_bookmark_id(bookmark: &Value) -> String {
    bookmark
        .get("bookmarkId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let saved_at = bookmark.get("savedAt").and_then(Value::as_i64).unwrap_or(0);
            let page_index = bookmark
                .get("pageIndex")
                .and_then(Value::as_i64)
                .unwrap_or(-1);
            let progress_micros = bookmark
                .get("progressPercent")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .clamp(0.0, 1.0)
                .mul_add(1_000_000.0, 0.0)
                .round() as i64;
            format!("legacy-{saved_at}-{page_index}-{progress_micros}")
        })
}

fn novel_bookmark_fallback_id(bookmark: &Value) -> String {
    serde_json::to_string(&json!([
        bookmark.get("novelId"),
        bookmark.get("chapterId"),
        bookmark.get("savedAt"),
        bookmark.get("locator"),
        bookmark.get("label"),
    ]))
    .unwrap_or_default()
}

fn reader_locator_from_desktop(row: &Value, book_id: &str, subtype: &str) -> Value {
    let raw_location = row.get("location").and_then(Value::as_str);
    let parsed = raw_location.and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let object = parsed.as_ref().and_then(Value::as_object);
    let progress = row
        .get("progressPercent")
        .and_then(Value::as_f64)
        .or_else(|| {
            object
                .and_then(|value| {
                    value
                        .get("progression")
                        .or_else(|| value.get("documentProgression"))
                })
                .and_then(Value::as_f64)
        })
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);

    if subtype.eq_ignore_ascii_case("pdf") {
        let pages = row
            .get("totalPages")
            .and_then(Value::as_i64)
            .or_else(|| {
                object
                    .and_then(|value| value.get("totalPages"))
                    .and_then(Value::as_i64)
            })
            .filter(|value| *value > 0);
        let mut page = row
            .get("pageIndex")
            .and_then(Value::as_i64)
            .or_else(|| {
                object
                    .and_then(|value| value.get("pageIndex"))
                    .and_then(Value::as_i64)
            })
            .unwrap_or(0)
            .max(0);
        if let Some(total) = pages {
            page = page.min(total - 1);
        }
        let page_offset = object
            .and_then(|value| value.get("pageOffset"))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
            .unwrap_or(0.0);
        let character_offset = object
            .and_then(|value| value.get("characterOffset"))
            .and_then(Value::as_i64)
            .filter(|value| *value >= 0);
        json!({
            "type": "pdf", "entityId": book_id, "pageIndex": page, "pageOffset": page_offset,
            "characterOffset": character_offset, "totalPages": pages, "documentProgression": progress
        })
    } else {
        let raw_cfi = raw_location.filter(|value| value.starts_with("epubcfi("));
        let cfi = object
            .and_then(|value| value.get("cfi"))
            .and_then(Value::as_str)
            .or(raw_cfi);
        let href = row
            .get("href")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                object
                    .and_then(|value| value.get("href"))
                    .and_then(Value::as_str)
            });
        let mut locator =
            json!({ "type": "epub", "entityId": book_id, "cfi": cfi, "progression": progress });
        if let Some(href) = href {
            locator["href"] = json!(href);
        }
        locator
    }
}

fn locator_to_local_fields(locator: &Value, book_id: &str) -> Map<String, Value> {
    let locator = locator_with_local_book_id(locator, book_id);
    let kind = locator
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("epub");
    let epub_position = if kind == "epub" {
        locator.get("cfi").and_then(Value::as_str)
    } else {
        None
    };
    let location = epub_position
        .filter(|position| position.starts_with("epubcfi("))
        .map(|position| {
            if let Some(href) = locator.get("href").and_then(Value::as_str) {
                json!(json!({ "cfi": position, "href": href, "progression": locator.get("progression").and_then(Value::as_f64).unwrap_or(0.0) }).to_string())
            } else {
                json!(position)
            }
        })
        .unwrap_or(Value::Null);
    let href = locator
        .get("href")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| json!(value))
        .unwrap_or(Value::Null);
    let mut row = Map::new();
    row.insert("location".into(), location);
    row.insert("href".into(), href);
    row.insert("renderer".into(), json!(kind));
    let progress = if kind == "pdf" {
        locator.get("documentProgression")
    } else {
        locator.get("progression")
    }
    .and_then(Value::as_f64)
    .filter(|value| value.is_finite() && (0.0..=1.0).contains(value));
    row.insert(
        "progressPercent".into(),
        progress.map(|value| json!(value)).unwrap_or(json!(0.0)),
    );
    for field in ["pageIndex", "totalPages"] {
        if let Some(value) = locator.get(field) {
            row.insert(field.into(), value.clone());
        }
    }
    row
}

fn locator_with_local_book_id(locator: &Value, book_id: &str) -> Value {
    let mut locator = locator.clone();
    if let Some(fields) = locator.as_object_mut() {
        fields.insert("entityId".into(), json!(book_id));
    }
    locator
}

fn ensure_object(val: &mut Value) -> &mut Map<String, Value> {
    if !val.is_object() {
        *val = Value::Object(Map::new());
    }
    val.as_object_mut().expect("just ensured object")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_persisted_book_library_schema_roundtrips_without_losing_local_fields() {
        let doc = json!({
            "version": 1,
            "books": [{
                "id": "local-book-id",
                "assetFingerprint": "  AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ",
                "title": "Dune", "subtype": "epub", "mimeType": "application/epub+zip", "byteSize": 1200,
                "createdAt": 10, "updatedAt": 20,
                "assetPath": "assets/dune.epub", "importPath": "imports/dune.epub", "coverPath": "covers/dune.png",
                "coverUrl": "https://example.invalid/cover", "genres": ["scifi"], "isbns": ["9780000000000"],
                "hardcoverBookId": 123, "hardcoverCoverUrl": "https://example.invalid/hc.png",
                "metadataBackfillVersion": 2, "toc": [], "spine": [], "tocCount": 0, "spineCount": 0,
                "sectionsSummary": [], "sectionCount": 0, "hasCover": true,
                "coverAssetSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "coverAssetByteSize": 1024, "coverAssetMimeType": "image/webp"
            }],
            "bookProgress": [{"bookId":"local-book-id","location":"epubcfi(/6/2)","href":"OPS/chapter-1.xhtml","progressPercent":0.42,"lastReadAt":50,"sectionLabel":"Chapter 1","renderer":"epub"}],
            "bookBookmarks": [{"bookmarkId":"mark-1","bookId":"local-book-id","location":"epubcfi(/6/4)","href":"OPS/chapter-2.xhtml","progressPercent":0.6,"label":"Chapter 2","savedAt":60}],
            "bookHighlights": [{"highlightId":"highlight-1","bookId":"local-book-id","startLocatorJson":{"type":"epub","entityId":"local-book-id","progression":0.2},"endLocatorJson":{"type":"epub","entityId":"local-book-id","progression":0.3},"selectedText":"Fear","colorArgb":42,"createdAtMs":1,"updatedAtMs":2}],
            "booksCategories": [{"id":"cat-1","name":"Read later","order":0}],
            "booksCategoryAssignments": {"local-book-id":["cat-1"],"novel-local-id":["cat-1"]},
            "bookHistory": [{"historyId":"history-1","bookId":"local-book-id","progressPercent":0.42,"readAtMs":50}],
            "booksLibraryUi": {"search":"Dune"}, "updatedAtMs": 70
        });

        let exported = export_desktop_books_to_v4(&doc, "desktop-1", 10_000);
        let work = exported
            .iter()
            .find(|item| item.entity_type == "book.work")
            .unwrap();
        assert_eq!(work.entity_key, "a".repeat(64));
        assert_eq!(work.payload["coverSha256"], json!("b".repeat(64)));
        assert_eq!(work.payload["coverByteSize"], json!(1024));
        assert_eq!(work.payload["coverMimeType"], json!("image/webp"));
        assert_eq!(work.payload["mimeType"], json!("application/epub+zip"));
        assert_eq!(work.payload["byteSize"], json!(1200));
        let progress = exported
            .iter()
            .find(|item| item.entity_type == "book.progress")
            .unwrap();
        assert_eq!(progress.payload["locator"]["type"], json!("epub"));
        assert_eq!(
            progress.payload["locator"]["entityId"],
            json!("local-book-id")
        );
        assert_eq!(progress.payload["locator"]["cfi"], json!("epubcfi(/6/2)"));
        assert_eq!(
            progress.payload["locator"]["href"],
            json!("OPS/chapter-1.xhtml")
        );
        assert!(exported
            .iter()
            .any(|item| item.entity_type == "book.category_assignment"
                && item.entity_key.starts_with(&format!("{}|", "a".repeat(64)))));
        assert!(!exported
            .iter()
            .any(|item| item.entity_key.contains("novel-local-id")));

        let wire: Vec<V4WireRecord> = exported
            .into_iter()
            .enumerate()
            .map(|(i, item)| V4WireRecord {
                server_seq: (i + 1) as i64,
                domain: item.domain,
                entity_type: item.entity_type,
                entity_key: item.entity_key,
                deleted: item.deleted,
                hlc: item.hlc,
                origin_device_id: "desktop-1".into(),
                payload: item.payload,
                updated_at_ms: 10_000,
            })
            .collect();
        let mut target = doc.clone();
        apply_v4_records_to_desktop_books(&mut target, &wire);
        let book = &target["books"][0];
        assert_eq!(book["id"], json!("local-book-id"));
        assert_eq!(book["assetFingerprint"], json!("a".repeat(64)));
        assert_eq!(book["mimeType"], json!("application/epub+zip"));
        assert_eq!(book["byteSize"], json!(1200));
        assert_eq!(book["assetPath"], json!("assets/dune.epub"));
        assert_eq!(book["coverAssetSha256"], json!("b".repeat(64)));
        assert_eq!(target["bookProgress"][0]["bookId"], json!("local-book-id"));
        let decoded_location: Value = serde_json::from_str(
            target["bookProgress"][0]["location"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(decoded_location["cfi"], json!("epubcfi(/6/2)"));
        assert_eq!(decoded_location["href"], json!("OPS/chapter-1.xhtml"));
        assert_eq!(decoded_location["progression"], json!(0.42));
        assert_eq!(
            target["bookProgress"][0]["href"],
            json!("OPS/chapter-1.xhtml")
        );
        assert_eq!(
            target["bookProgress"][0]["sectionLabel"],
            json!("Chapter 1")
        );
        assert_eq!(target["bookBookmarks"][0]["bookmarkId"], json!("mark-1"));
        assert_eq!(
            target["bookBookmarks"][0]["href"],
            json!("OPS/chapter-2.xhtml")
        );
        assert_eq!(
            target["bookHighlights"][0]["highlightId"],
            json!("highlight-1")
        );
        assert_eq!(target["bookHistory"][0]["historyId"], json!("history-1"));
        assert_eq!(
            target["booksCategoryAssignments"]["novel-local-id"],
            json!(["cat-1"])
        );
        assert_eq!(target["booksLibraryUi"]["search"], json!("Dune"));
    }

    #[test]
    fn desktop_persisted_novel_library_uses_entries_and_preserves_source_and_local_ids() {
        let doc = json!({
            "version":1,"scopeKey":"profile-a","updatedAtMs":90,
            "entries":[{"id":"local-novel","title":"Novel","author":"Author","description":"Desc","coverUrl":"https://example.invalid/cover","path":"/novel/1","status":"ongoing","tags":["fantasy","romance"],"source":{"pluginId":"plugin.a","lang":"pt","sourceId":"legacy-source","custom":"kept"},"chapterCount":1,"addedAt":10,"updatedAt":20}],
            "chapters":[{"id":"local-chapter","novelId":"local-novel","path":"/chapter/1","title":"Chapter 1","order":0,"releaseTime":30,"unread":true,"updatedAt":40}],
            "progress":[{"novelId":"local-novel","chapterId":"local-chapter","chapterTitle":"Chapter 1","progressPercent":0.4,"locator":"local-chapter-position","updatedAt":50}],
            "bookmarks":[
                {"novelId":"local-novel","chapterId":"local-chapter","chapterTitle":"Chapter 1","locator":"bookmark-locator","label":"Save","savedAt":60,"syncId":"sync-bookmark"},
                {"novelId":"local-novel","chapterId":"local-chapter","chapterTitle":"Chapter 1","locator":"older-bookmark","label":"Older Save","savedAt":61}
            ],
            "history":[{"novelId":"local-novel","chapterId":"local-chapter","chapterTitle":"Chapter 1","locator":"history-locator","readAt":70,"historyId":"history-id"}]
        });
        let exported = export_desktop_novels_to_v4(&doc, "desktop-1", 10_000);
        assert!(exported
            .iter()
            .any(|item| item.entity_type == "novel.work" && item.payload["sourceLang"] == "pt"));
        let chapter = exported
            .iter()
            .find(|item| item.entity_type == "novel.chapter")
            .unwrap();
        assert_eq!(chapter.payload["isRead"], json!(false));
        assert_eq!(chapter.payload["sourceOrder"], json!(0));
        assert_eq!(chapter.payload["chapterNumber"], json!(0));
        assert_eq!(chapter.payload["progressPercent"], json!(0.4));
        assert!(exported
            .iter()
            .any(|item| item.entity_type == "novel.bookmark"
                && item.entity_key.ends_with("|sync-bookmark")));
        assert!(exported
            .iter()
            .any(|item| item.entity_type == "novel.bookmark" && item.payload["savedAt"] == 61));
        assert!(exported
            .iter()
            .any(|item| item.entity_type == "novel.history"
                && item.payload["historyEntries"][0]["historyId"] == "history-id"));
        let wire: Vec<V4WireRecord> = exported
            .into_iter()
            .enumerate()
            .map(|(i, item)| V4WireRecord {
                server_seq: (i + 1) as i64,
                domain: item.domain,
                entity_type: item.entity_type,
                entity_key: item.entity_key,
                deleted: item.deleted,
                hlc: item.hlc,
                origin_device_id: "desktop-1".into(),
                payload: item.payload,
                updated_at_ms: 10_000,
            })
            .collect();
        let mut target = doc.clone();
        let mut wire = wire;
        wire.reverse();
        apply_v4_records_to_desktop_novels(&mut target, &wire);
        assert_eq!(target["entries"][0]["id"], json!("local-novel"));
        assert_eq!(target["entries"][0]["source"]["custom"], json!("kept"));
        assert_eq!(target["entries"][0]["source"]["lang"], json!("pt"));
        assert_eq!(target["chapters"][0]["id"], json!("local-chapter"));
        assert_eq!(target["progress"][0]["novelId"], json!("local-novel"));
        assert_eq!(
            target["progress"][0]["locator"],
            json!("local-chapter-position")
        );
        assert_eq!(target["bookmarks"].as_array().unwrap().len(), 2);
        assert!(target["bookmarks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|bookmark| bookmark["syncId"] == "sync-bookmark"
                && bookmark["novelId"] == "local-novel"));
        assert!(target["bookmarks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|bookmark| bookmark["syncId"] != "sync-bookmark"
                && bookmark["chapterId"] == "local-chapter"));
        assert_eq!(target["history"][0]["historyId"], json!("history-id"));
        assert_eq!(target["version"], json!(1));
        assert_eq!(target["scopeKey"], json!("profile-a"));
    }

    #[test]
    fn desktop_novels_v4_roundtrip_handles_7k_chapters_in_linear_time() {
        let mut chapters = Vec::with_capacity(7_000);
        for i in 0..7_000 {
            chapters.push(json!({
                "id": format!("ch-{i}"),
                "novelId": "n-1",
                "path": format!("/novel/shadow-slave/chapter-{i}"),
                "name": format!("Chapter {i}"),
                "isRead": i < 2_500,
                "progress": if i < 2_500 { 1.0 } else { 0.0 },
                "position": i,
            }));
        }
        let doc = json!({
            "categories": [{ "id": "c-1", "name": "Reading", "order": 0 }],
            "novels": [{
                "id": "n-1",
                "pluginId": "novelfull",
                "path": "/novel/shadow-slave",
                "title": "Shadow Slave",
                "favorite": true,
                "categoryIds": ["c-1"]
            }],
            "chapters": chapters,
            "history": [{
                "novelId": "n-1",
                "chapterPath": "/novel/shadow-slave/chapter-2499",
                "readAt": 1700000000000_i64
            }]
        });

        let started = std::time::Instant::now();
        let exported = export_desktop_novels_to_v4(&doc, "desktop-1", 10_000);
        assert_eq!(exported.len(), 7_002); // 1 work + 7000 chapters + 1 history

        let wire: Vec<V4WireRecord> = exported
            .into_iter()
            .enumerate()
            .map(|(i, item)| V4WireRecord {
                server_seq: (i + 1) as i64,
                domain: item.domain,
                entity_type: item.entity_type,
                entity_key: item.entity_key,
                deleted: item.deleted,
                hlc: item.hlc,
                origin_device_id: "desktop-1".into(),
                payload: item.payload,
                updated_at_ms: 10_000,
            })
            .collect();

        let mut target = json!({});
        apply_v4_records_to_desktop_novels(&mut target, &wire);
        let elapsed = started.elapsed();

        assert_eq!(target["entries"].as_array().unwrap().len(), 1);
        assert_eq!(target["chapters"].as_array().unwrap().len(), 7_000);
        assert_eq!(target["history"].as_array().unwrap().len(), 1);
        assert!(
            elapsed.as_secs() < 5,
            "Expected O(N) desktop novel V4 roundtrip (< 5s), got {elapsed:?}"
        );
    }

    #[test]
    fn desktop_books_v4_roundtrip_preserves_highlights_bookmarks_covers_and_deletes() {
        let hash = "a".repeat(64);
        let doc = json!({
            "books": [{
                "id": "b-1",
                "assetFingerprint": hash.clone(),
                "title": "Dune",
                "author": "Frank Herbert",
                "subtype": "epub",
                "coverAssetSha256": "b".repeat(64),
                "coverAssetByteSize": 512,
                "coverAssetMimeType": "image/png"
            }],
            "bookProgress": [{"bookId":"b-1","location":"epubcfi(/6/2)","href":"epubcfi(/6/2)","progressPercent":0.42,"lastReadAt":55,"renderer":"epub"}],
            "bookHighlights": [{
                "highlightId": "hl-1",
                "bookId": "b-1",
                "startLocatorJson": {"type":"epub","entityId":"b-1","progression":0.2},
                "endLocatorJson": {"type":"epub","entityId":"b-1","progression":0.3},
                "selectedText": "Fear is the mind-killer",
                "colorArgb": 123456,
                "createdAtMs": 1,
                "updatedAtMs": 2
            }],
            "bookBookmarks": [{
                "bookmarkId": "bm-1",
                "bookId": "b-1",
                "location": "epubcfi(/6/4)",
                "href": "epubcfi(/6/4)",
                "progressPercent": 0.6,
                "label": "Chapter 3",
                "savedAt": 3
            }]
        });

        let exported = export_desktop_books_to_v4(&doc, "desktop-1", 10_000);
        let wire: Vec<V4WireRecord> = exported
            .into_iter()
            .enumerate()
            .map(|(i, item)| V4WireRecord {
                server_seq: (i + 1) as i64,
                domain: item.domain,
                entity_type: item.entity_type,
                entity_key: item.entity_key,
                deleted: item.deleted,
                hlc: item.hlc,
                origin_device_id: "desktop-1".into(),
                payload: item.payload,
                updated_at_ms: 10_000,
            })
            .collect();

        let mut target = doc.clone();
        apply_v4_records_to_desktop_books(&mut target, &wire);
        assert_eq!(target["books"].as_array().unwrap().len(), 1);
        assert_eq!(
            target["books"][0]["coverAssetSha256"],
            json!("b".repeat(64))
        );
        assert_eq!(target["bookProgress"][0]["progressPercent"], json!(0.42));
        assert_eq!(target["bookHighlights"].as_array().unwrap().len(), 1);
        assert_eq!(target["bookBookmarks"].as_array().unwrap().len(), 1);

        // Book delete tombstone removes book cleanly (never resurrects!).
        apply_v4_records_to_desktop_books(
            &mut target,
            &[V4WireRecord {
                server_seq: 99,
                domain: "books".into(),
                entity_type: "book.work".into(),
                entity_key: hash,
                deleted: true,
                hlc: Hlc::new(20_000, 0, "android-1"),
                origin_device_id: "android-1".into(),
                payload: Value::Null,
                updated_at_ms: 20_000,
            }],
        );
        assert!(target["books"].as_array().unwrap().is_empty());
    }

    #[test]
    fn desktop_book_export_omits_invalid_cover_metadata_and_emits_android_reader_locator_shapes() {
        let sha = "c".repeat(64);
        let invalid_cover_doc = json!({
            "books": [{
                "id":"pdf-local", "assetFingerprint":sha, "title":"PDF", "subtype":"pdf",
                "coverAssetSha256":"d".repeat(64), "coverAssetByteSize":8_388_609, "coverAssetMimeType":"image/png"
            }],
            "bookProgress": [{
                "bookId":"pdf-local", "pageIndex":11, "totalPages":10, "progressPercent":0.75,
                "location":"{\"type\":\"pdf\",\"entityId\":\"pdf-local\",\"pageIndex\":4,\"pageOffset\":0.25,\"characterOffset\":8,\"totalPages\":10,\"documentProgression\":0.5}",
                "lastReadAt":100, "renderer":"pdf"
            }]
        });
        let exported = export_desktop_books_to_v4(&invalid_cover_doc, "desktop-1", 10_000);
        let work = exported
            .iter()
            .find(|item| item.entity_type == "book.work")
            .unwrap();
        assert!(work.payload.get("coverSha256").is_none());
        assert!(work.payload.get("coverByteSize").is_none());
        assert!(work.payload.get("coverMimeType").is_none());
        let locator = &exported
            .iter()
            .find(|item| item.entity_type == "book.progress")
            .unwrap()
            .payload["locator"];
        assert_eq!(locator["type"], json!("pdf"));
        assert_eq!(locator["entityId"], json!("pdf-local"));
        assert_eq!(locator["pageIndex"], json!(9));
        assert_eq!(locator["totalPages"], json!(10));
        assert_eq!(locator["documentProgression"], json!(0.75));
        assert!(locator.get("progression").is_none());
        assert_eq!(locator["pageOffset"], json!(0.25));

        let wire = exported
            .into_iter()
            .enumerate()
            .map(|(index, item)| V4WireRecord {
                server_seq: index as i64 + 1,
                domain: item.domain,
                entity_type: item.entity_type,
                entity_key: item.entity_key,
                deleted: item.deleted,
                hlc: item.hlc,
                origin_device_id: "android".into(),
                payload: item.payload,
                updated_at_ms: 10_000,
            })
            .collect::<Vec<_>>();
        let mut applied = invalid_cover_doc;
        apply_v4_records_to_desktop_books(&mut applied, &wire);
        assert_eq!(applied["bookProgress"][0]["location"], Value::Null);
        assert_eq!(applied["bookProgress"][0]["href"], Value::Null);
        assert_eq!(applied["bookProgress"][0]["pageIndex"], json!(9));
        assert_eq!(applied["bookProgress"][0]["totalPages"], json!(10));
        assert_eq!(applied["bookProgress"][0]["renderer"], json!("pdf"));
        assert_eq!(applied["bookProgress"][0]["progressPercent"], json!(0.75));
    }

    #[test]
    fn android_epub_reader_locator_updates_position_without_fabricating_a_href() {
        let sha = "f".repeat(64);
        let mut state = json!({
            "books": [{"id":"fresh-epub","assetFingerprint":sha,"subtype":"epub"}],
            "bookProgress": []
        });
        apply_v4_records_to_desktop_books(
            &mut state,
            &[V4WireRecord {
                server_seq: 1,
                domain: "books".into(),
                entity_type: "book.progress".into(),
                entity_key: sha,
                deleted: false,
                hlc: Hlc::new(100, 0, "android"),
                origin_device_id: "android".into(),
                payload: json!({
                    "locator": {"type":"epub","entityId":"remote-book","cfi":"epubcfi(/6/12)","progression":0.25},
                    "progressPercent":0.25,
                    "lastReadAtMs":100
                }),
                updated_at_ms: 100,
            }],
        );

        assert_eq!(
            state["bookProgress"][0]["location"],
            json!("epubcfi(/6/12)")
        );
        assert!(state["bookProgress"][0]["href"].is_null());
        assert_eq!(state["bookProgress"][0]["renderer"], json!("epub"));
        assert_eq!(state["bookProgress"][0]["progressPercent"], json!(0.25));
    }

    #[test]
    fn epub_reader_locator_href_round_trips_when_present() {
        let row = json!({
            "location": "{\"cfi\":\"epubcfi(/6/12)\",\"href\":\"OPS/chapter-1.xhtml\",\"progression\":0.25}",
            "progressPercent": 0.25
        });
        let exported = reader_locator_from_desktop(&row, "book-id", "epub");
        assert_eq!(exported["href"], json!("OPS/chapter-1.xhtml"));
        let local = locator_to_local_fields(&exported, "book-id");
        let decoded: Value = serde_json::from_str(local["location"].as_str().unwrap()).unwrap();
        assert_eq!(decoded["href"], json!("OPS/chapter-1.xhtml"));
        assert_eq!(decoded["cfi"], json!("epubcfi(/6/12)"));
    }

    #[test]
    fn desktop_book_apply_creates_canonical_id_and_all_v4_work_fields() {
        let sha = "e".repeat(64);
        let mut state = json!({"booksLibraryUi":{"search":"preserve"},"updatedAtMs":7});
        apply_v4_records_to_desktop_books(
            &mut state,
            &[V4WireRecord {
                server_seq: 1,
                domain: "books".into(),
                entity_type: "book.work".into(),
                entity_key: sha.clone(),
                deleted: false,
                hlc: Hlc::new(20, 0, "android"),
                origin_device_id: "android".into(),
                payload: json!({
                    "subtype":"pdf", "fileSha256":sha, "mimeType":"application/pdf", "byteSize":321,
                    "title":"Local PDF", "author":"Reader", "description":"Description", "pageCount":12,
                    "createdAtMs":10, "updatedAtMs":20, "coverSha256":"f".repeat(64),
                    "coverByteSize":1024, "coverMimeType":"image/jpeg", "hasCover":true
                }),
                updated_at_ms: 20,
            }],
        );

        let book = &state["books"][0];
        assert_eq!(book["id"], json!(format!("pdf:sha256:{}", "e".repeat(64))));
        assert_eq!(book["assetFingerprint"], json!("e".repeat(64)));
        assert_eq!(book["subtype"], json!("pdf"));
        assert_eq!(book["mimeType"], json!("application/pdf"));
        assert_eq!(book["byteSize"], json!(321));
        assert_eq!(book["title"], json!("Local PDF"));
        assert_eq!(book["author"], json!("Reader"));
        assert_eq!(book["description"], json!("Description"));
        assert_eq!(book["pageCount"], json!(12));
        assert_eq!(book["createdAt"], json!(10));
        assert_eq!(book["updatedAt"], json!(20));
        assert_eq!(book["coverAssetSha256"], json!("f".repeat(64)));
        assert_eq!(book["coverAssetByteSize"], json!(1024));
        assert_eq!(book["coverAssetMimeType"], json!("image/jpeg"));
        assert_eq!(book["hasCover"], json!(true));
        assert_eq!(state["version"], json!(1));
        assert_eq!(state["booksLibraryUi"]["search"], json!("preserve"));
        assert_eq!(state["updatedAtMs"], json!(7));
    }
}
