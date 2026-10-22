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
  mutation EpigraphCoreImportWorks($backup: Upload!) {
    restoreBackup(input: {
      backup: $backup
      flags: {
        includeManga: true
        includeChapters: true
        includeCategories: false
        includeHistory: false
        includeTracking: false
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportWorksVariables {
    works: Vec<ImportWork>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportWork {
    source_id: String,
    url: String,
    title: String,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    artist: Option<String>,
    #[serde(default)]
    genre: Vec<String>,
    #[serde(default)]
    status: Option<String>,
    /// Milliseconds since the epoch.
    #[serde(default)]
    date_added: i64,
    #[serde(default)]
    chapters: Vec<ImportChapter>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportChapter {
    url: String,
    name: String,
    #[serde(default)]
    scanlator: Option<String>,
    #[serde(default)]
    is_read: bool,
    #[serde(default)]
    is_bookmarked: bool,
    #[serde(default)]
    last_page_read: i64,
    /// Milliseconds since the epoch.
    #[serde(default)]
    fetched_at: i64,
    /// Milliseconds since the epoch.
    #[serde(default)]
    upload_date: i64,
    #[serde(default)]
    chapter_number: f32,
    #[serde(default)]
    source_order: i64,
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
    let backup = gzip_stored(&encode_backup(&parsed.works));

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

    let id = start_restore(state, session, backup).await?;
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
            None | Some("SUCCESS") => break,
            Some("FAILURE") => {
                return Err(AppError::service_unavailable(
                    "SUWAYOMI_IMPORT_FAILED",
                    "The comics runtime could not bring the works in.",
                    false,
                ))
            }
            Some(_) => {}
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
    Ok(json!({ "imported": parsed.works.len() }))
}

async fn start_restore(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    backup: Vec<u8>,
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
            json!({ "query": RESTORE_MUTATION, "variables": { "backup": null } }).to_string(),
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

/// A Mihon backup holding only the works and their chapters, in the library and in no category.
fn encode_backup(works: &[ImportWork]) -> Vec<u8> {
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
            if chapter.chapter_number != 0.0 {
                put_varint(&mut encoded, 9 << 3 | 5);
                encoded.extend_from_slice(&chapter.chapter_number.to_le_bytes());
            }
            put_varint_field(&mut encoded, 10, chapter.source_order.max(0) as u64);
            put_bytes_field(&mut manga, 16, &encoded);
        }
        put_varint_field(&mut manga, 100, 1);
        put_bytes_field(&mut backup, 1, &manga);
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
        let backup = encode_backup(&parsed.works);
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
