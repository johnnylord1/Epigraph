//! Brings works another desktop holds into this Suwayomi without asking their sources.
//!
//! Searching a source for each work fails for sources behind Cloudflare or whose site is gone,
//! so the works are written as a minimal Mihon backup (the work and its chapters, nothing else)
//! and restored. Suwayomi fetches details and the cover from the source later, when shown.

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

use crate::syncd::models::{AppError, AuthenticatedSession, SharedAppState};
use crate::syncd::routes::{suwayomi_catalog, suwayomi_commands, suwayomi_proxy};

pub(crate) const MAX_IMPORT_WORKS: usize = 25;
const MAX_IMPORT_CHAPTERS: usize = 10_000;
const MAX_TEXT_BYTES: usize = 2048;
const MAX_TITLE_BYTES: usize = 512;
const MAX_GENRES: usize = 64;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const RESTORE_POLL_INTERVAL: Duration = Duration::from_millis(500);
const RESTORE_TIMEOUT: Duration = Duration::from_secs(180);

pub(crate) const RESTORE_MUTATION: &str = r#"
  mutation EpigraphCoreImportWorks($backup: Upload!, $portableRelations: Boolean!) {
    restoreBackup(input: {
      backup: $backup
      flags: {
        includeManga: true
        includeChapters: true
        includeCategories: $portableRelations
        includeHistory: $portableRelations
        includeTracking: $portableRelations
        includeServerSettings: false
        includeClientData: false
      }
    }) {
      id
      status { state }
    }
  }
"#;

const RESTORE_STATUS_QUERY: &str = r#"
  query EpigraphCoreImportStatus($id: String!) {
    restoreStatus(id: $id) { state }
  }
"#;

/// Mihon's `MangaStatus` numbers for Suwayomi's status names.
const STATUSES: [(&str, i64); 7] = [
    ("UNKNOWN", 0),
    ("ONGOING", 1),
    ("COMPLETED", 2),
    ("LICENSED", 3),
    ("PUBLISHING_FINISHED", 4),
    ("CANCELLED", 5),
    ("ON_HIATUS", 6),
];

/// Suwayomi's `UpdateStrategy` names, in the order its backups number them.
const UPDATE_STRATEGIES: [&str; 2] = ["ALWAYS_UPDATE", "ONLY_FETCH_ONCE"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportWorksVariables {
    works: Vec<ImportWork>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportWork {
    pub source_id: String,
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub genre: Vec<String>,
    #[serde(default)]
    pub status: Option<String>,
    /// Milliseconds since the epoch.
    #[serde(default)]
    pub date_added: i64,
    /// Whether the work goes into the library; absent means it does. Suwayomi keeps a work that is
    /// already in its library there whatever this says, so `false` leaves the work as it is.
    #[serde(default)]
    pub in_library: Option<bool>,
    /// Suwayomi's `UpdateStrategy` name. A restore overwrites the strategy of a work it already
    /// has, so a work that is only given missing chapters passes its own.
    #[serde(default)]
    pub update_strategy: Option<String>,
    #[serde(default)]
    pub chapters: Vec<ImportChapter>,
    #[serde(skip)]
    pub category_orders: Vec<u64>,
    #[serde(skip)]
    pub history: Option<(String, i64)>,
    #[serde(skip)]
    pub tracking: Vec<ImportTracking>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportChapter {
    pub url: String,
    pub name: String,
    #[serde(default)]
    pub scanlator: Option<String>,
    #[serde(default)]
    pub is_read: bool,
    #[serde(default)]
    pub is_bookmarked: bool,
    #[serde(default)]
    pub last_page_read: i64,
    /// Milliseconds since the epoch.
    #[serde(default)]
    pub fetched_at: i64,
    /// Milliseconds since the epoch.
    #[serde(default)]
    pub upload_date: i64,
    #[serde(default)]
    pub chapter_number: f32,
    #[serde(default)]
    pub source_order: i64,
}

#[derive(Debug)]
pub(crate) struct ImportCategory {
    pub name: String,
    pub order: u64,
}

#[derive(Debug)]
pub(crate) struct ImportTracking {
    pub tracker_id: u64,
    pub library_id: u64,
    pub remote_id: u64,
    pub url: String,
    pub title: String,
    pub last_chapter_read: f32,
    pub total_chapters: u64,
    pub score: f32,
    pub status: u64,
    pub start_date: u64,
    pub finish_date: u64,
}

/// Checks the works and answers with the variables `import_works_confirmed` expects.
pub(crate) fn normalized_import(variables: Value) -> Result<Value, AppError> {
    let parsed: ImportWorksVariables = serde_json::from_value(variables.clone()).map_err(|_| {
        AppError::BadRequest(
            "ImportWorks requires works with sourceId, url, title and chapters.".to_string(),
        )
    })?;
    if parsed.works.is_empty() || parsed.works.len() > MAX_IMPORT_WORKS {
        return Err(AppError::BadRequest(format!(
            "ImportWorks takes between 1 and {MAX_IMPORT_WORKS} works."
        )));
    }
    for work in &parsed.works {
        suwayomi_commands::ensure_source_id(&work.source_id)?;
        suwayomi_commands::ensure_manga_url(&work.url)?;
        let title = work.title.trim();
        if title.is_empty() || title.len() > MAX_TITLE_BYTES || title.chars().any(char::is_control)
        {
            return Err(AppError::BadRequest(
                "title must be a work title of at most 512 bytes.".to_string(),
            ));
        }
        if work
            .update_strategy
            .as_deref()
            .is_some_and(|strategy| !UPDATE_STRATEGIES.contains(&strategy))
        {
            return Err(AppError::BadRequest(
                "updateStrategy must be ALWAYS_UPDATE or ONLY_FETCH_ONCE.".to_string(),
            ));
        }
        let texts = [&work.author, &work.artist, &work.status]
            .into_iter()
            .flatten()
            .chain(&work.genre);
        if work.genre.len() > MAX_GENRES
            || texts.into_iter().any(|text| text.len() > MAX_TEXT_BYTES)
        {
            return Err(AppError::BadRequest(
                "Work details must be short texts.".to_string(),
            ));
        }
        if work.chapters.len() > MAX_IMPORT_CHAPTERS {
            return Err(AppError::BadRequest(format!(
                "A work takes at most {MAX_IMPORT_CHAPTERS} chapters."
            )));
        }
        for chapter in &work.chapters {
            suwayomi_commands::ensure_manga_url(&chapter.url)?;
            let scanlator = chapter.scanlator.as_deref().unwrap_or_default();
            if chapter.name.len() > MAX_TEXT_BYTES
                || scanlator.len() > MAX_TEXT_BYTES
                || !chapter.chapter_number.is_finite()
            {
                return Err(AppError::BadRequest(
                    "Chapter details must be short texts and finite numbers.".to_string(),
                ));
            }
        }
    }
    Ok(variables)
}

/// Restores the works and waits until Suwayomi says it finished.
pub(crate) async fn import_works_confirmed(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    variables: Value,
) -> Result<Value, AppError> {
    let parsed: ImportWorksVariables = serde_json::from_value(variables)
        .map_err(|_| AppError::BadRequest("ImportWorks variables are invalid.".to_string()))?;
    restore_backup_confirmed(state, session, &parsed.works, &[], false).await?;
    Ok(json!({ "imported": parsed.works.len() }))
}

pub(crate) async fn restore_backup_confirmed(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    works: &[ImportWork],
    categories: &[ImportCategory],
    portable_relations: bool,
) -> Result<(), AppError> {
    let backup = gzip_stored(&encode_backup(works, categories));
    let maintained = || {
        AppError::service_unavailable(
            "SUWAYOMI_MAINTENANCE",
            "The comics runtime is being maintained. Try again shortly.",
            true,
        )
    };
    let runtime_root = crate::suwayomi_maintenance::default_runtime_root();
    // Held until the restore finishes, so maintenance does not stop Suwayomi halfway through it.
    let _lease = crate::suwayomi_maintenance::try_acquire_shared_file_lease(&runtime_root)
        .map_err(|_| maintained())?;
    if crate::suwayomi_recovery::abandoned_work_for_profile(&runtime_root, &session.profile_id) {
        return Err(maintained());
    }

    let id = start_restore(state, session, backup, portable_relations).await?;
    let started = tokio::time::Instant::now();
    loop {
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            RESTORE_STATUS_QUERY,
            json!({ "id": id }),
            false,
        )
        .await?;
        // Suwayomi forgets a restore some time after it ends.
        match data.pointer("/restoreStatus/state").and_then(Value::as_str) {
            Some("SUCCESS") => break,
            None if !portable_relations => break,
            Some("FAILURE") => {
                return Err(AppError::service_unavailable(
                    "SUWAYOMI_IMPORT_FAILED",
                    "The comics runtime could not bring the works in.",
                    false,
                ))
            }
            None | Some(_) => {}
        }
        if started.elapsed() > RESTORE_TIMEOUT {
            return Err(AppError::service_unavailable(
                "SUWAYOMI_IMPORT_TIMEOUT",
                "The comics runtime is still bringing the works in.",
                true,
            ));
        }
        tokio::time::sleep(RESTORE_POLL_INTERVAL).await;
    }
    Ok(())
}

async fn start_restore(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    backup: Vec<u8>,
    portable_relations: bool,
) -> Result<String, AppError> {
    let unavailable = || {
        AppError::service_unavailable(
            "SUWAYOMI_CATALOG_UNAVAILABLE",
            "The comics runtime is temporarily unavailable.",
            true,
        )
    };
    let base = suwayomi_proxy::resolve_upstream_base(state, &session.profile_id)
        .map_err(|_| unavailable())?;
    let url =
        suwayomi_proxy::build_upstream_url(base, "api/graphql", None).map_err(|_| unavailable())?;
    let form = reqwest::multipart::Form::new()
        .text(
            "operations",
            json!({
                "query": RESTORE_MUTATION,
                "variables": { "backup": null, "portableRelations": portable_relations }
            })
            .to_string(),
        )
        .text("map", json!({ "0": ["variables.backup"] }).to_string())
        .part(
            "0",
            reqwest::multipart::Part::bytes(backup)
                .file_name("epigraph-sync.tachibk")
                .mime_str("application/octet-stream")
                .map_err(|_| unavailable())?,
        );
    let response = suwayomi_proxy::proxy_client()
        .post(url)
        .header("accept", "application/json")
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(
                profile = session.profile_id,
                error_class = suwayomi_proxy::proxy_reqwest_error_class(&error),
                "Suwayomi import request failed"
            );
            unavailable()
        })?;
    if !response.status().is_success() {
        tracing::warn!(
            profile = session.profile_id,
            status = response.status().as_u16(),
            "Suwayomi import returned a non-success status"
        );
        return Err(unavailable());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| unavailable())?;
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(unavailable());
        }
        body.extend_from_slice(&chunk);
    }
    let payload: Value = serde_json::from_slice(&body).map_err(|_| unavailable())?;
    let restore = payload.pointer("/data/restoreBackup");
    if restore
        .and_then(|restore| restore.pointer("/status/state"))
        .and_then(Value::as_str)
        == Some("FAILURE")
        || payload
            .get("errors")
            .and_then(Value::as_array)
            .is_some_and(|errors| !errors.is_empty())
    {
        return Err(AppError::service_unavailable(
            "SUWAYOMI_IMPORT_FAILED",
            "The comics runtime could not bring the works in.",
            false,
        ));
    }
    restore
        .and_then(|restore| restore.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(unavailable)
}

/// A Mihon backup holding works, chapters and any supplied portable relations.
fn encode_backup(works: &[ImportWork], categories: &[ImportCategory]) -> Vec<u8> {
    let mut backup = Vec::new();
    for work in works {
        let mut manga = Vec::new();
        put_varint_field(
            &mut manga,
            1,
            work.source_id.parse::<i64>().unwrap_or_default() as u64,
        );
        put_text_field(&mut manga, 2, &work.url);
        put_text_field(&mut manga, 3, work.title.trim());
        put_text_field(&mut manga, 4, work.artist.as_deref().unwrap_or_default());
        put_text_field(&mut manga, 5, work.author.as_deref().unwrap_or_default());
        // No description: without one Suwayomi fetches the details and cover when first shown.
        for genre in &work.genre {
            put_text_field(&mut manga, 7, genre);
        }
        let status = work.status.as_deref().unwrap_or_default();
        let status = STATUSES
            .iter()
            .find(|(name, _)| *name == status)
            .map_or(0, |(_, n)| *n);
        put_varint_field(&mut manga, 8, status as u64);
        put_varint_field(&mut manga, 13, work.date_added.max(0) as u64);
        for chapter in &work.chapters {
            let mut encoded = Vec::new();
            put_text_field(&mut encoded, 1, &chapter.url);
            put_text_field(&mut encoded, 2, &chapter.name);
            put_text_field(
                &mut encoded,
                3,
                chapter.scanlator.as_deref().unwrap_or_default(),
            );
            put_varint_field(&mut encoded, 4, chapter.is_read as u64);
            put_varint_field(&mut encoded, 5, chapter.is_bookmarked as u64);
            put_varint_field(&mut encoded, 6, chapter.last_page_read.max(0) as u64);
            put_varint_field(&mut encoded, 7, chapter.fetched_at.max(0) as u64);
            put_varint_field(&mut encoded, 8, chapter.upload_date.max(0) as u64);
            put_float_field(&mut encoded, 9, chapter.chapter_number);
            put_varint_field(&mut encoded, 10, chapter.source_order.max(0) as u64);
            put_bytes_field(&mut manga, 16, &encoded);
        }
        for order in &work.category_orders {
            // Category index 0 is a valid member of this repeated scalar field.
            put_varint(&mut manga, 17 << 3);
            put_varint(&mut manga, *order);
        }
        for track in &work.tracking {
            let mut encoded = Vec::new();
            put_varint_field(&mut encoded, 1, track.tracker_id);
            put_varint_field(&mut encoded, 2, track.library_id);
            if track.remote_id <= i32::MAX as u64 {
                put_varint_field(&mut encoded, 3, track.remote_id);
            }
            put_text_field(&mut encoded, 4, &track.url);
            put_text_field(&mut encoded, 5, &track.title);
            put_float_field(&mut encoded, 6, track.last_chapter_read);
            put_varint_field(&mut encoded, 7, track.total_chapters);
            put_float_field(&mut encoded, 8, track.score);
            put_varint_field(&mut encoded, 9, track.status);
            put_varint_field(&mut encoded, 10, track.start_date);
            put_varint_field(&mut encoded, 11, track.finish_date);
            put_varint_field(&mut encoded, 100, track.remote_id);
            put_bytes_field(&mut manga, 18, &encoded);
        }
        // `favorite` defaults to true when left out, so false is written out.
        put_varint(&mut manga, 100 << 3);
        put_varint(&mut manga, u64::from(work.in_library != Some(false)));
        if let Some((chapter_url, when)) = &work.history {
            let mut encoded = Vec::new();
            put_text_field(&mut encoded, 1, chapter_url);
            put_varint_field(&mut encoded, 2, (*when).max(0) as u64);
            put_bytes_field(&mut manga, 104, &encoded);
        }
        let strategy = work.update_strategy.as_deref().unwrap_or_default();
        let strategy = UPDATE_STRATEGIES
            .iter()
            .position(|name| *name == strategy)
            .unwrap_or(0);
        put_varint_field(&mut manga, 105, strategy as u64);
        put_bytes_field(&mut backup, 1, &manga);
    }
    for category in categories {
        let mut encoded = Vec::new();
        put_text_field(&mut encoded, 1, &category.name);
        put_varint_field(&mut encoded, 2, category.order);
        put_bytes_field(&mut backup, 2, &encoded);
    }
    backup
}

fn put_varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push(value as u8 | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

/// Zero is the field's default, so it is left out like protobuf encoders do.
fn put_varint_field(out: &mut Vec<u8>, field: u64, value: u64) {
    if value != 0 {
        put_varint(out, field << 3);
        put_varint(out, value);
    }
}

fn put_float_field(out: &mut Vec<u8>, field: u64, value: f32) {
    if value != 0.0 {
        put_varint(out, field << 3 | 5);
        out.extend_from_slice(&value.to_le_bytes());
    }
}
fn put_bytes_field(out: &mut Vec<u8>, field: u64, bytes: &[u8]) {
    put_varint(out, field << 3 | 2);
    put_varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

fn put_text_field(out: &mut Vec<u8>, field: u64, text: &str) {
    if !text.is_empty() {
        put_bytes_field(out, field, text.as_bytes());
    }
}

/// Gzip with uncompressed deflate blocks; Suwayomi only restores gzip backups.
fn gzip_stored(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 0xFFFF * 5 + 23);
    out.extend_from_slice(&[0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
    let mut blocks = data.chunks(0xFFFF).peekable();
    if blocks.peek().is_none() {
        out.extend_from_slice(&[1, 0, 0, 0xff, 0xff]);
    }
    while let Some(block) = blocks.next() {
        let len = block.len() as u16;
        out.push(u8::from(blocks.peek().is_none()));
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(block);
    }
    out.extend_from_slice(&crc32(data).to_le_bytes());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work(chapters: Value) -> Value {
        json!({ "works": [{
            "sourceId": "2499283573021220255",
            "url": "/manga/a",
            "title": "A",
            "genre": ["Action"],
            "status": "ONGOING",
            "dateAdded": 1_700_000_000_000_i64,
            "chapters": chapters,
        }] })
    }

    #[test]
    fn crc32_matches_the_standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn gzip_stored_frames_every_block() {
        let data: Vec<u8> = (0..70_000u32).map(|n| n as u8).collect();
        let gz = gzip_stored(&data);
        assert_eq!(&gz[..3], &[0x1f, 0x8b, 8]);
        // Two blocks: the first is full and not final.
        assert_eq!(gz[10], 0);
        assert_eq!(u16::from_le_bytes([gz[11], gz[12]]), 0xFFFF);
        let second = 10 + 5 + 0xFFFF;
        assert_eq!(gz[second], 1);
        assert_eq!(
            u16::from_le_bytes([gz[second + 1], gz[second + 2]]) as usize,
            70_000 - 0xFFFF
        );
        let trailer = &gz[gz.len() - 8..];
        assert_eq!(
            u32::from_le_bytes(trailer[..4].try_into().unwrap()),
            crc32(&data)
        );
        assert_eq!(u32::from_le_bytes(trailer[4..].try_into().unwrap()), 70_000);
        assert_eq!(gzip_stored(b"").len(), 10 + 5 + 8);
    }

    #[test]
    fn encodes_works_as_mihon_backup_fields() {
        let variables = work(json!([{ "url": "/c/1", "name": "Ch 1", "isRead": true,
            "lastPageRead": 3, "chapterNumber": 1.5, "sourceOrder": 2 }]));
        let parsed: ImportWorksVariables =
            serde_json::from_value(normalized_import(variables).unwrap()).unwrap();
        let backup = encode_backup(&parsed.works, &[]);
        // backupManga = 1, length-delimited, then source = 1 as a varint.
        assert_eq!(backup[0], 1 << 3 | 2);
        let mut source = Vec::new();
        put_varint_field(&mut source, 1, 2_499_283_573_021_220_255);
        assert!(backup
            .windows(source.len())
            .any(|window| window == source.as_slice()));
        // favorite = 100 is a two-byte tag.
        assert!(backup.ends_with(&[0xA0, 0x06, 1]));
        assert!(backup
            .windows(5)
            .any(|window| window == [9 << 3 | 5, 0, 0, 0xC0, 0x3F]));
        let mut varint = Vec::new();
        put_varint(&mut varint, u64::MAX);
        assert_eq!(varint.len(), 10);
    }

    #[test]
    fn a_work_kept_out_of_the_library_says_so_and_keeps_its_strategy() {
        let mut variables = work(json!([]));
        variables["works"][0]["inLibrary"] = json!(false);
        variables["works"][0]["updateStrategy"] = json!("ONLY_FETCH_ONCE");
        let parsed: ImportWorksVariables =
            serde_json::from_value(normalized_import(variables).unwrap()).unwrap();
        let backup = encode_backup(&parsed.works, &[]);
        // favorite = 100 written as false, then updateStrategy = 105 as ONLY_FETCH_ONCE.
        assert!(backup.ends_with(&[0xA0, 0x06, 0, 0xC8, 0x06, 1]));

        let mut bad = work(json!([]));
        bad["works"][0]["updateStrategy"] = json!("SOMETIMES");
        assert!(normalized_import(bad).is_err());
    }

    #[test]
    fn rejects_bad_import_variables() {
        assert!(normalized_import(json!({ "works": [] })).is_err());
        assert!(normalized_import(
            json!({ "works": [{ "sourceId": "x", "url": "/a", "title": "A" }] })
        )
        .is_err());
        assert!(normalized_import(
            json!({ "works": [{ "sourceId": "1", "url": "", "title": "A" }] })
        )
        .is_err());
        assert!(normalized_import(
            json!({ "works": [{ "sourceId": "1", "url": "/a", "title": " " }] })
        )
        .is_err());
        assert!(normalized_import(work(json!([{ "url": "", "name": "Ch" }]))).is_err());
        let many: Vec<Value> = (0..=MAX_IMPORT_WORKS)
            .map(|n| json!({ "sourceId": "1", "url": format!("/{n}"), "title": "A" }))
            .collect();
        assert!(normalized_import(json!({ "works": many })).is_err());
        assert!(normalized_import(work(json!([]))).is_ok());
    }
}
