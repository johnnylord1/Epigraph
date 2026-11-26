//! HTTP & SSE route handlers for Sync V4 (`/v4/*`).
//!
//! Security & multi-profile invariants:
//! - `profile_id` is ALWAYS derived from `AuthenticatedSession.profile_id` (never trusted from
//!   client request payloads).
//! - Tracker credentials live in per-profile DPAPI-sealed vaults and never enter snapshots,
//!   change logs, backups, or logs.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use async_stream::stream;
use axum::body::Bytes;
use axum::extract::{Extension, Path, Query, Request, State};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE, ETAG, IF_NONE_MATCH};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::db::{
    self as v4_db, V4ChangesResult, V4ExtensionPackageMeta, V4IncomingItem, V4WireRecord,
    V4_DEFAULT_CHANGES_LIMIT, V4_MAX_BULK_ITEMS, V4_MAX_DELTA_ITEMS,
};
use super::{V4LiveEvent, V4LiveEventKind, V4Runtime};
use crate::syncd::db::now_ms;
use crate::syncd::lifecycle::{wait_for_shutdown_request, ShutdownCoordinator};
use crate::syncd::middleware::{
    authenticate_token_public, bearer_token_public, validate_scope, CLIENT_PROTOCOL_HEADER,
    CLIENT_VERSION_HEADER, LEGACY_CLIENT_PROTOCOL_HEADER, LEGACY_CLIENT_VERSION_HEADER,
};
use crate::syncd::models::{AppError, AuthenticatedSession, ErrorDetail, SharedAppState};
use crate::syncd::suwayomi_tracking_mirror;
use crate::syncd::tracker_credentials::{
    self, CredentialValues, CredentialWriteError, TrackerCredentialView,
    TRACKER_CREDENTIALS_SCHEMA_VERSION,
};

/// Max size of a single extension package uploaded to the Core LAN cache (64 MiB).
pub const MAX_EXTENSION_PACKAGE_BYTES: usize = 64 * 1024 * 1024;

/// V4 auth middleware: validates the client version, protocol, and bearer token.
pub async fn require_v4_session(
    State(state): State<SharedAppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, AppError> {
    validate_v4_client_headers(request.headers(), &state)?;
    let token = bearer_token_public(request.headers())?;
    let session = authenticate_token_public(&state, &token).await?;
    request.extensions_mut().insert(session);
    Ok(next.run(request).await)
}

fn validate_v4_client_headers(headers: &HeaderMap, state: &SharedAppState) -> Result<(), AppError> {
    let version = headers
        .get(CLIENT_VERSION_HEADER)
        .or_else(|| headers.get(LEGACY_CLIENT_VERSION_HEADER))
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            AppError::BadRequest("Missing X-Epigraph-Client-Version header.".to_string())
        })?;

    let protocol = headers
        .get(CLIENT_PROTOCOL_HEADER)
        .or_else(|| headers.get(LEGACY_CLIENT_PROTOCOL_HEADER))
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            AppError::BadRequest("Missing X-Epigraph-Client-Protocol-Version header.".to_string())
        })?
        .parse::<u32>()
        .map_err(|_| AppError::BadRequest("Invalid client protocol version.".to_string()))?;

    if protocol != 4 {
        return Err(AppError::upgrade_required(
            "PROTOCOL_VERSION_MISMATCH",
            "Sync V4 endpoints require X-Epigraph-Client-Protocol-Version: 4.",
            Some(state.config.min_client_version.clone()),
        ));
    }

    let client_ver = semver::Version::parse(version).map_err(|_| {
        AppError::BadRequest("Client version must be a semantic version.".to_string())
    })?;
    let min_ver = semver::Version::parse(&state.config.min_client_version)
        .map_err(|_| AppError::Internal("Server min client version is invalid.".to_string()))?;
    if client_ver < min_ver {
        return Err(AppError::upgrade_required(
            "CLIENT_VERSION_TOO_OLD",
            "Client version is older than the minimum supported version.",
            Some(state.config.min_client_version.clone()),
        ));
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct GrantedDomains {
    comics: bool,
    novels: bool,
    books: bool,
}

impl GrantedDomains {
    fn for_session(session: &AuthenticatedSession) -> Self {
        Self {
            comics: validate_scope(session, &format!("comics:profile:{}", session.profile_id))
                .is_ok(),
            novels: validate_scope(session, &format!("novels:profile:{}", session.profile_id))
                .is_ok(),
            books: validate_scope(session, "books:global").is_ok(),
        }
    }

    fn domain_allowed(self, domain: &str) -> bool {
        match domain {
            "comics" => self.comics,
            "novels" => self.novels,
            "books" => self.books,
            "extensions" | "preferences" => self.comics || self.novels,
            _ => false,
        }
    }

    fn record_allowed(self, domain: &str, entity_type: &str, key: &str) -> bool {
        match (domain, entity_type) {
            ("extensions", _) | ("preferences", "extension.pref") => key
                .split_once(':')
                .is_some_and(|(kind, _)| self.extension_allowed(kind)),
            ("preferences", "app.pref") => self.comics && self.novels && self.books,
            _ => self.domain_allowed(domain),
        }
    }

    fn extension_allowed(self, kind: &str) -> bool {
        match kind {
            "comic" => self.comics,
            "novel" => self.novels,
            _ => false,
        }
    }

    fn allows<T>(self, record: &V4WireRecord<T>) -> bool {
        self.record_allowed(&record.domain, &record.entity_type, &record.entity_key)
    }

    fn tag(self) -> u8 {
        u8::from(self.comics) | (u8::from(self.novels) << 1) | (u8::from(self.books) << 2)
    }
}

fn require_grant(allowed: bool) -> Result<(), AppError> {
    if !allowed {
        return Err(AppError::Forbidden(
            "The device has no grant for this sync data.".to_string(),
        ));
    }
    Ok(())
}

fn validate_write_grants(
    session: &AuthenticatedSession,
    items: &[V4IncomingItem],
) -> Result<(), AppError> {
    let grants = GrantedDomains::for_session(session);
    require_grant(items.iter().all(|item| {
        // Leave unknown domains to the write validator so malformed items have a receipt.
        !v4_db::ALLOWED_DOMAINS.contains(&item.domain.as_str())
            || grants.record_allowed(&item.domain, &item.entity_type, &item.entity_key)
    }))
}

// --- GET /v4/capabilities ---

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V4CapabilitiesResponse {
    pub protocol_version: u32,
    pub min_client_version: String,
    pub profile_id: String,
    pub device_id: String,
    pub server_seq: i64,
    pub min_replayable_seq: i64,
    pub server_time_ms: i64,
    pub max_bulk_items: usize,
    pub max_delta_items: usize,
    pub max_changes_limit: i64,
    pub supports_gzip_bodies: bool,
    pub supports_conditional_bulk: bool,
    pub supports_extension_lan_cache: bool,
    pub supports_tracker_credentials: bool,
    pub supports_paged_snapshot: bool,
    pub max_snapshot_page_items: usize,
    pub tls_cert_sha256: String,
}

pub async fn get_capabilities(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<V4CapabilitiesResponse>, AppError> {
    let watermark = v4_db::load_watermark(&state.pool, &session.profile_id)
        .await
        .map_err(|err| AppError::Internal(format!("Failed to load V4 watermark: {err}")))?;

    Ok(Json(V4CapabilitiesResponse {
        protocol_version: 4,
        min_client_version: state.config.min_client_version.clone(),
        profile_id: session.profile_id,
        device_id: session.device_id,
        server_seq: watermark.current_seq,
        min_replayable_seq: watermark.min_replayable_seq,
        server_time_ms: now_ms(),
        max_bulk_items: V4_MAX_BULK_ITEMS,
        max_delta_items: V4_MAX_DELTA_ITEMS,
        max_changes_limit: v4_db::V4_MAX_CHANGES_LIMIT,
        supports_gzip_bodies: true,
        supports_conditional_bulk: true,
        supports_extension_lan_cache: true,
        supports_tracker_credentials: tracker_credentials::is_supported(),
        supports_paged_snapshot: true,
        max_snapshot_page_items: v4_db::V4_MAX_SNAPSHOT_PAGE_ITEMS as usize,
        tls_cert_sha256: state.tls_cert_sha256.clone(),
    }))
}

// --- GET /v4/snapshot ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotQuery {
    pub domain: Option<String>,
    #[serde(default = "default_true")]
    pub include_tombstones: bool,
    /// Exclusive cursor for a paged snapshot. Ignored unless `limit` is also present.
    pub after_seq: Option<i64>,
    /// Presence turns the request into one page of at most this many rows (clamped to 1..=5000).
    pub limit: Option<i64>,
}

fn default_true() -> bool {
    true
}

pub async fn get_snapshot(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Query(query): Query<SnapshotQuery>,
) -> Result<Response, AppError> {
    let grants = GrantedDomains::for_session(&session);
    if let Some(domain) = &query.domain {
        require_grant(grants.domain_allowed(domain))?;
    }
    let tomb_tag = if query.include_tombstones { "t1" } else { "t0" };
    let etag = |seq| {
        format!(
            "\"v4:{}:{}:{}:{}:{}\"",
            session.profile_id,
            query.domain.as_deref().unwrap_or("all"),
            tomb_tag,
            grants.tag(),
            seq
        )
    };

    // `afterSeq` only means something with `limit`; without it the response is the full snapshot.
    let page = query.limit.map(|limit| v4_db::SnapshotPage {
        after_seq: query.after_seq.unwrap_or(0).max(0),
        limit: limit.clamp(1, v4_db::V4_MAX_SNAPSHOT_PAGE_ITEMS),
    });
    // A later page is not the response its ETag names, so only a first page may answer 304.
    let first_page = page.is_none_or(|page| page.after_seq == 0);

    if let Some(if_none_match) = headers
        .get(IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .filter(|_| first_page)
    {
        let watermark = v4_db::load_watermark(&state.pool, &session.profile_id)
            .await
            .map_err(|err| AppError::Internal(format!("Failed to load V4 watermark: {err}")))?;
        let etag_value = etag(watermark.current_seq);
        if if_none_match.trim() == etag_value {
            let mut resp = StatusCode::NOT_MODIFIED.into_response();
            if let Ok(hv) = HeaderValue::from_str(&etag_value) {
                resp.headers_mut().insert(ETAG, hv);
            }
            return Ok(resp);
        }
    }

    let mut snapshot = v4_db::load_snapshot_page(
        &state.pool,
        &session.profile_id,
        query.domain.as_deref(),
        query.include_tombstones,
        page,
    )
    .await
    .map_err(|err| AppError::Internal(format!("Failed to load V4 snapshot: {err}")))?;

    snapshot.records.retain(|record| grants.allows(record));
    snapshot.record_count = snapshot.records.len();
    let etag_value = etag(snapshot.server_seq);
    let mut resp = Json(snapshot).into_response();
    if let Ok(hv) = HeaderValue::from_str(&etag_value) {
        resp.headers_mut().insert(ETAG, hv);
    }
    Ok(resp)
}

// --- POST /v4/sync/bulk ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkSyncRequest {
    pub items: Vec<V4IncomingItem>,
    pub expected_server_seq: Option<i64>,
    #[serde(default = "default_true")]
    pub final_batch: bool,
}

pub async fn post_sync_bulk(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Extension(v4_runtime): Extension<Arc<V4Runtime>>,
    Json(request): Json<BulkSyncRequest>,
) -> Result<Json<v4_db::V4WriteSummary>, AppError> {
    if request.items.len() > V4_MAX_BULK_ITEMS {
        return Err(AppError::BadRequest(format!(
            "Bulk batch exceeds max of {V4_MAX_BULK_ITEMS} items."
        )));
    }
    validate_write_grants(&session, &request.items)?;

    let _guard = v4_runtime.write_gate.lock().await;
    if let Some(expected) = request.expected_server_seq {
        let actual = v4_db::load_watermark(&state.pool, &session.profile_id)
            .await
            .map_err(|_| AppError::Internal("Failed to check the V4 bulk watermark.".to_owned()))?
            .current_seq;
        if expected != actual {
            return Err(AppError::Conflict(ErrorDetail {
                code: "V4_BULK_WATERMARK_CHANGED".to_owned(),
                message: "The profile changed during the bulk upload.".to_owned(),
                retryable: Some(true),
                min_client_version: None,
                current_server_version: Some(actual),
                min_replayable_server_version: None,
                required_action: None,
                details: None,
            }));
        }
    }
    let summary = v4_db::apply_v4_batch_with_bulk_state(
        &state.pool,
        &session.profile_id,
        &session.device_id,
        request.items,
        false,
        request.final_batch,
    )
    .await
    .map_err(|err| AppError::Internal(format!("Failed to apply V4 bulk sync: {err}")))?;

    if request.final_batch && summary.server_seq > 0 {
        super::suwayomi::wake_projection();
    }
    // Every committed sequence must reach subscribers before later direct deltas.
    // The final-chunk marker gates the Suwayomi restore, not change visibility.
    if summary.accepted_count > 0 || summary.merged_count > 0 {
        let _ = v4_runtime.live_sender.send(V4LiveEvent {
            profile_id: session.profile_id.clone(),
            origin_device_id: session.device_id.clone(),
            server_seq: summary.server_seq,
            kind: V4LiveEventKind::BulkCommitted {
                record_count: summary.accepted_count + summary.merged_count,
                server_seq: summary.server_seq,
                server_time_ms: summary.server_time_ms,
            },
        });
    }

    Ok(Json(summary))
}

// --- POST /v4/deltas ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltasRequest {
    pub items: Vec<V4IncomingItem>,
}

pub async fn post_deltas(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Extension(v4_runtime): Extension<Arc<V4Runtime>>,
    Json(request): Json<DeltasRequest>,
) -> Result<Json<v4_db::V4WriteSummary>, AppError> {
    if request.items.len() > V4_MAX_DELTA_ITEMS {
        return Err(AppError::BadRequest(format!(
            "Delta batch exceeds max of {V4_MAX_DELTA_ITEMS} items; use /v4/sync/bulk for large batches."
        )));
    }
    validate_write_grants(&session, &request.items)?;

    let _guard = v4_runtime.write_gate.lock().await;
    let summary = v4_db::apply_v4_batch(
        &state.pool,
        &session.profile_id,
        &session.device_id,
        request.items,
        true,
    )
    .await
    .map_err(|err| AppError::Internal(format!("Failed to apply V4 deltas: {err}")))?;

    for record in &summary.committed_records {
        let _ = v4_runtime.live_sender.send(V4LiveEvent {
            profile_id: session.profile_id.clone(),
            origin_device_id: session.device_id.clone(),
            server_seq: record.server_seq,
            kind: V4LiveEventKind::Delta(record.clone()),
        });
    }
    if summary
        .committed_records
        .iter()
        .any(|record| record.domain == "comics")
    {
        super::suwayomi::wake_projection();
    }

    Ok(Json(summary))
}

// --- GET /v4/changes ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesQuery {
    #[serde(default)]
    pub since_seq: i64,
    #[serde(default = "default_changes_limit")]
    pub limit: i64,
}

fn default_changes_limit() -> i64 {
    V4_DEFAULT_CHANGES_LIMIT
}

pub async fn get_changes(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<ChangesQuery>,
) -> Result<Json<v4_db::V4ChangesResponse>, AppError> {
    if query.since_seq < 0 {
        return Err(AppError::BadRequest(
            "sinceSeq must be non-negative.".to_string(),
        ));
    }

    match v4_db::load_changes_paged(&state.pool, &session.profile_id, query.since_seq, query.limit)
        .await
        .map_err(|err| AppError::Internal(format!("Failed to load V4 changes: {err}")))?
    {
        V4ChangesResult::Page(mut page) => {
            let grants = GrantedDomains::for_session(&session);
            page.changes.retain(|record| grants.allows(record));
            Ok(Json(page))
        }
        V4ChangesResult::ReplayWindowExpired {
            current_seq,
            min_replayable_seq,
        } => Err(AppError::Gone(ErrorDetail {
            code: "REPLAY_WINDOW_EXPIRED".to_string(),
            message: "Client fell behind the V4 replay retention window; perform a snapshot merge."
                .to_string(),
            retryable: Some(false),
            min_client_version: None,
            current_server_version: Some(current_seq),
            min_replayable_server_version: Some(min_replayable_seq),
            required_action: Some("snapshot_merge".to_string()),
            details: None,
        })),
        V4ChangesResult::CursorAhead {
            cursor,
            current_seq,
            min_replayable_seq,
        } => Err(AppError::Gone(ErrorDetail {
            code: "CURSOR_AHEAD_OF_SERVER".to_string(),
            message: format!(
                "Client cursor {cursor} is ahead of server history ({current_seq}); perform a snapshot merge."
            ),
            retryable: Some(false),
            min_client_version: None,
            current_server_version: Some(current_seq),
            min_replayable_server_version: Some(min_replayable_seq),
            required_action: Some("snapshot_merge".to_string()),
            details: None,
        })),
    }
}

// --- GET /v4/events (SSE Realtime Stream) ---

/// Interval of the per-stream clock tick. Each tick re-checks the token (revocation and
/// scope removal), extends the device inactivity window, and emits a `clock` event.
#[cfg(not(test))]
const V4_STREAM_CLOCK_TICK: Duration = Duration::from_secs(30);
#[cfg(test)]
const V4_STREAM_CLOCK_TICK: Duration = Duration::from_millis(200);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsQuery {
    pub since_seq: Option<i64>,
    #[serde(default)]
    pub include_own: bool,
}

pub async fn get_events(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Extension(v4_runtime): Extension<Arc<V4Runtime>>,
    Extension(shutdown): Extension<ShutdownCoordinator>,
    headers: HeaderMap,
    Query(query): Query<EventsQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let header_cursor = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<i64>().ok());
    let since_seq = query.since_seq.or(header_cursor).unwrap_or(0).max(0);

    // Subscribe BEFORE reading backlog so no committed event between backlog and live stream is lost.
    let mut rx = v4_runtime.live_sender.subscribe();

    let backlog = match v4_db::load_changes_paged(
        &state.pool,
        &session.profile_id,
        since_seq,
        v4_db::V4_MAX_CHANGES_LIMIT,
    )
    .await
    .map_err(|err| AppError::Internal(format!("Failed to load V4 SSE backlog: {err}")))?
    {
        V4ChangesResult::Page(page) => page,
        V4ChangesResult::ReplayWindowExpired {
            current_seq,
            min_replayable_seq,
        } => {
            return Err(AppError::Gone(ErrorDetail {
                code: "REPLAY_WINDOW_EXPIRED".to_string(),
                message: "SSE cursor expired; perform a snapshot merge.".to_string(),
                retryable: Some(false),
                min_client_version: None,
                current_server_version: Some(current_seq),
                min_replayable_server_version: Some(min_replayable_seq),
                required_action: Some("snapshot_merge".to_string()),
                details: None,
            }));
        }
        V4ChangesResult::CursorAhead {
            cursor,
            current_seq,
            min_replayable_seq,
        } => {
            return Err(AppError::Gone(ErrorDetail {
                code: "CURSOR_AHEAD_OF_SERVER".to_string(),
                message: format!("SSE cursor {cursor} is ahead of server history ({current_seq})."),
                retryable: Some(false),
                min_client_version: None,
                current_server_version: Some(current_seq),
                min_replayable_server_version: Some(min_replayable_seq),
                required_action: Some("snapshot_merge".to_string()),
                details: None,
            }));
        }
    };

    let profile_id = session.profile_id.clone();
    let device_id = session.device_id.clone();
    let grants = GrantedDomains::for_session(&session);
    let include_own = query.include_own;
    let mut shutdown = shutdown.subscribe();
    let presence = state
        .device_presence
        .open_stream(&session.token_id, &session.device_id);

    let event_stream = stream! {
        let _presence = presence;
        let mut last_sent_seq = since_seq;

        // Initial hello event with server clock for HLC calibration.
        let hello_json = json!({
            "protocolVersion": 4,
            "profileId": profile_id,
            "serverSeq": backlog.server_seq,
            "serverTimeMs": now_ms(),
        })
        .to_string();
        yield Ok(Event::default().event("hello").data(hello_json));

        if backlog.has_more {
            // Too many missed changes for SSE replay: tell client to catch up via paginated /v4/changes.
            let catchup = json!({
                "serverSeq": backlog.server_seq,
                "nextSeq": last_sent_seq,
                "serverTimeMs": now_ms(),
            })
            .to_string();
            yield Ok(Event::default().event("catchup_required").data(catchup));
            last_sent_seq = backlog.server_seq;
        } else {
            for change in backlog.changes {
                if !grants.allows(&change) || (!include_own && change.origin_device_id == device_id) {
                    last_sent_seq = last_sent_seq.max(change.server_seq);
                    continue;
                }
                last_sent_seq = last_sent_seq.max(change.server_seq);
                if let Ok(data) = serde_json::to_string(&change) {
                    yield Ok(Event::default()
                        .id(change.server_seq.to_string())
                        .event("delta")
                        .data(data));
                }
            }
        }

        let mut clock_tick = tokio::time::interval(V4_STREAM_CLOCK_TICK);
        clock_tick.tick().await; // consume immediate tick

        loop {
            tokio::select! {
                Some(_) = wait_for_shutdown_request(&mut shutdown) => break,
                recv = rx.recv() => {
                    match recv {
                        Ok(live) => {
                            if live.profile_id != profile_id {
                                continue;
                            }
                            if live.server_seq <= last_sent_seq {
                                continue;
                            }
                            if !include_own && live.origin_device_id == device_id {
                                last_sent_seq = last_sent_seq.max(live.server_seq);
                                continue;
                            }
                            last_sent_seq = live.server_seq;
                            match live.kind {
                                V4LiveEventKind::Delta(record) => {
                                    if !grants.allows(&record) {
                                        continue;
                                    }
                                    if !token_still_grants(&state, &session).await {
                                        break;
                                    }
                                    if let Ok(data) = serde_json::to_string(&record) {
                                        yield Ok(Event::default()
                                            .id(record.server_seq.to_string())
                                            .event("delta")
                                            .data(data));
                                    }
                                }
                                V4LiveEventKind::BulkCommitted { record_count, server_seq, server_time_ms } => {
                                    if !token_still_grants(&state, &session).await {
                                        break;
                                    }
                                    let data = json!({
                                        "recordCount": record_count,
                                        "serverSeq": server_seq,
                                        "serverTimeMs": server_time_ms,
                                    })
                                    .to_string();
                                    yield Ok(Event::default()
                                        .id(server_seq.to_string())
                                        .event("bulk_committed")
                                        .data(data));
                                }
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            let data = json!({
                                "skipped": skipped,
                                "afterSeq": last_sent_seq,
                                "serverTimeMs": now_ms(),
                            })
                            .to_string();
                            yield Ok(Event::default().event("catchup_required").data(data));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = clock_tick.tick() => {
                    if !token_still_grants(&state, &session).await {
                        break;
                    }
                    let _ = crate::syncd::db::extend_streaming_token_activity(
                        &state.pool, &session.token_id, now_ms(),
                        state.config.token_inactivity_window.as_millis() as i64,
                    ).await;
                    let ping = json!({ "serverTimeMs": now_ms(), "lastSeq": last_sent_seq }).to_string();
                    yield Ok(Event::default().event("clock").data(ping));
                }
            }
        }
    };

    Ok(Sse::new(event_stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

async fn token_still_grants(state: &SharedAppState, session: &AuthenticatedSession) -> bool {
    crate::syncd::db::load_active_token_scopes(&state.pool, &session.token_id, now_ms())
        .await
        .is_ok_and(|scopes| scopes.is_some_and(|scopes| scopes == session.scopes))
}

// --- LAN Extension Package Cache (`/v4/extensions/packages/:kind/:package_id/:version`) ---

fn validate_ext_segment(kind: &str, package_id: &str, version: &str) -> Result<(), AppError> {
    if kind != "comic" && kind != "novel" {
        return Err(AppError::BadRequest(
            "Extension kind must be 'comic' or 'novel'.".to_string(),
        ));
    }
    for (name, val) in [("packageId", package_id), ("version", version)] {
        if val.is_empty()
            || val.len() > 160
            || val.contains("..")
            || val.contains('/')
            || val.contains('\\')
        {
            return Err(AppError::BadRequest(format!("Invalid {name}.")));
        }
    }
    Ok(())
}

pub async fn head_extension_package(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((kind, package_id, version)): Path<(String, String, String)>,
) -> Result<Response, AppError> {
    validate_ext_segment(&kind, &package_id, &version)?;
    require_grant(GrantedDomains::for_session(&session).extension_allowed(&kind))?;
    let Some(meta) = v4_db::load_extension_package_meta(&state.pool, &kind, &package_id, &version)
        .await
        .map_err(|err| AppError::Internal(format!("Failed to lookup extension package: {err}")))?
    else {
        return Err(AppError::not_found(
            "EXTENSION_PACKAGE_NOT_FOUND",
            "Extension package is not cached on Core.",
            None,
        ));
    };

    let blob_path = v4_db::extension_package_blob_path(&state.config.data_dir, &meta.sha256);
    if tokio::fs::metadata(&blob_path).await.is_err() {
        return Err(AppError::not_found(
            "EXTENSION_PACKAGE_NOT_FOUND",
            "Extension package blob is missing on disk.",
            None,
        ));
    }

    let mut resp = StatusCode::OK.into_response();
    if let Ok(hv) = HeaderValue::from_str(&meta.sha256) {
        resp.headers_mut().insert("x-epigraph-asset-sha256", hv);
    }
    if let Ok(hv) = HeaderValue::from_str(&meta.byte_size.to_string()) {
        resp.headers_mut().insert("content-length", hv);
    }
    if let Ok(hv) = HeaderValue::from_str(&meta.mime_type) {
        resp.headers_mut().insert(CONTENT_TYPE, hv);
    }
    Ok(resp)
}

pub async fn get_extension_package(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((kind, package_id, version)): Path<(String, String, String)>,
) -> Result<Response, AppError> {
    validate_ext_segment(&kind, &package_id, &version)?;
    require_grant(GrantedDomains::for_session(&session).extension_allowed(&kind))?;
    let Some(meta) = v4_db::load_extension_package_meta(&state.pool, &kind, &package_id, &version)
        .await
        .map_err(|err| AppError::Internal(format!("Failed to lookup extension package: {err}")))?
    else {
        return Err(AppError::not_found(
            "EXTENSION_PACKAGE_NOT_FOUND",
            "Extension package is not cached on Core.",
            None,
        ));
    };

    let blob_path = v4_db::extension_package_blob_path(&state.config.data_dir, &meta.sha256);
    let bytes = tokio::fs::read(&blob_path).await.map_err(|_| {
        AppError::not_found(
            "EXTENSION_PACKAGE_NOT_FOUND",
            "Extension package blob could not be read.",
            None,
        )
    })?;

    let mut resp = (StatusCode::OK, bytes).into_response();
    if let Ok(hv) = HeaderValue::from_str(&meta.mime_type) {
        resp.headers_mut().insert(CONTENT_TYPE, hv);
    }
    if let Ok(hv) = HeaderValue::from_str(&meta.sha256) {
        resp.headers_mut().insert("x-epigraph-asset-sha256", hv);
    }
    Ok(resp)
}

pub async fn put_extension_package(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((kind, package_id, version)): Path<(String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<V4ExtensionPackageMeta>, AppError> {
    validate_ext_segment(&kind, &package_id, &version)?;
    require_grant(GrantedDomains::for_session(&session).extension_allowed(&kind))?;
    if body.is_empty() {
        return Err(AppError::BadRequest(
            "Extension package body must not be empty.".to_string(),
        ));
    }
    if body.len() > MAX_EXTENSION_PACKAGE_BYTES {
        return Err(AppError::BadRequest(format!(
            "Extension package exceeds {MAX_EXTENSION_PACKAGE_BYTES} byte limit."
        )));
    }

    let sha256 = hex_sha256(&body);
    if let Some(expected) = headers
        .get("x-epigraph-asset-sha256")
        .and_then(|v| v.to_str().ok())
    {
        if !expected.trim().eq_ignore_ascii_case(&sha256) {
            return Err(AppError::BadRequest(
                "Uploaded extension package SHA-256 mismatch.".to_string(),
            ));
        }
    }

    let mime_type = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(if kind == "comic" {
            "application/vnd.android.package-archive"
        } else {
            "application/javascript"
        })
        .to_string();

    let blob_path = v4_db::extension_package_blob_path(&state.config.data_dir, &sha256);
    if let Some(parent) = blob_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|err| {
            AppError::Internal(format!("Failed to create package cache dir: {err}"))
        })?;
    }
    if tokio::fs::metadata(&blob_path).await.is_err() {
        let tmp_path = blob_path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
        tokio::fs::write(&tmp_path, &body).await.map_err(|err| {
            AppError::Internal(format!("Failed to write package temp file: {err}"))
        })?;
        tokio::fs::rename(&tmp_path, &blob_path)
            .await
            .map_err(|err| {
                let _ = std::fs::remove_file(&tmp_path);
                AppError::Internal(format!("Failed to finalize package blob: {err}"))
            })?;
    }

    let meta = V4ExtensionPackageMeta {
        kind,
        package_id,
        version,
        sha256,
        byte_size: body.len() as i64,
        mime_type,
        uploaded_at_ms: now_ms(),
    };
    v4_db::upsert_extension_package_meta(&state.pool, &meta, &session.device_id)
        .await
        .map_err(|err| {
            AppError::Internal(format!("Failed to store extension package metadata: {err}"))
        })?;

    Ok(Json(meta))
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// --- Profile-Scoped Tracker Credentials (`/v4/tracker-credentials`) ---

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V4TrackerCredentialListResponse {
    pub schema_version: u32,
    pub profile_id: String,
    pub credentials: Vec<TrackerCredentialView>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct V4TrackerCredentialWriteRequest {
    base_revision: i64,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct V4TrackerCredentialDeleteRequest {
    base_revision: i64,
}

pub async fn get_tracker_credentials(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<V4TrackerCredentialListResponse>, AppError> {
    require_grant(GrantedDomains::for_session(&session).comics)?;
    ensure_tracker_vault_supported()?;
    let vault =
        tracker_credentials::load_vault_for_profile(&state.config.data_dir, &session.profile_id)
            .await
            .map_err(|_| {
                AppError::Internal("Failed to access profile tracker credential vault.".to_string())
            })?;
    Ok(Json(V4TrackerCredentialListResponse {
        schema_version: TRACKER_CREDENTIALS_SCHEMA_VERSION,
        profile_id: session.profile_id,
        credentials: vault.views(),
    }))
}

pub async fn put_tracker_credential(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(tracker_key): Path<String>,
    body: Bytes,
) -> Result<Json<TrackerCredentialView>, AppError> {
    require_grant(GrantedDomains::for_session(&session).comics)?;
    ensure_tracker_vault_supported()?;
    let request: V4TrackerCredentialWriteRequest = serde_json::from_slice(&body).map_err(|_| {
        AppError::BadRequest(
            "Tracker credential body must be {baseRevision, username, password, token}."
                .to_string(),
        )
    })?;
    if !(0..i64::MAX - 1).contains(&request.base_revision) {
        return Err(AppError::BadRequest(
            "baseRevision must be zero or greater.".to_string(),
        ));
    }
    let audit_device_id = session.device_id.clone();
    let timestamp = now_ms();
    let values = CredentialValues {
        username: request.username,
        password: request.password,
        token: request.token,
    };
    let outcome = tracker_credentials::update_vault_for_profile(
        &state.config.data_dir,
        &session.profile_id,
        |vault| {
            vault
                .put(
                    &tracker_key,
                    request.base_revision,
                    values,
                    &audit_device_id,
                    timestamp,
                )
                .map(|view| (view, true))
        },
    )
    .await
    .map_err(|_| {
        AppError::Internal("Failed to access profile tracker credential vault.".to_string())
    })?;
    let view = outcome.map_err(|err| map_credential_error(&tracker_key, err))?;
    suwayomi_tracking_mirror::request_immediate_mirror();
    Ok(Json(view))
}

pub async fn delete_tracker_credential(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(tracker_key): Path<String>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, AppError> {
    require_grant(GrantedDomains::for_session(&session).comics)?;
    ensure_tracker_vault_supported()?;
    let request: V4TrackerCredentialDeleteRequest =
        serde_json::from_slice(&body).map_err(|_| {
            AppError::BadRequest(
                "Tracker credential delete body must be {baseRevision}.".to_string(),
            )
        })?;
    if !(0..i64::MAX - 1).contains(&request.base_revision) {
        return Err(AppError::BadRequest(
            "baseRevision must be zero or greater.".to_string(),
        ));
    }
    let audit_device_id = session.device_id.clone();
    let timestamp = now_ms();
    let outcome = tracker_credentials::update_vault_for_profile(
        &state.config.data_dir,
        &session.profile_id,
        |vault| {
            vault
                .delete(
                    &tracker_key,
                    request.base_revision,
                    &audit_device_id,
                    timestamp,
                )
                .map(|view| (view, true))
        },
    )
    .await
    .map_err(|_| {
        AppError::Internal("Failed to access profile tracker credential vault.".to_string())
    })?;
    let view = outcome.map_err(|err| map_credential_error(&tracker_key, err))?;
    suwayomi_tracking_mirror::request_immediate_mirror();
    Ok(Json(json!({
        "trackerKey": view.tracker_key,
        "profileId": session.profile_id,
        "revision": view.revision,
        "deleted": true,
        "updatedAtMs": view.updated_at_ms,
    })))
}

fn ensure_tracker_vault_supported() -> Result<(), AppError> {
    if tracker_credentials::is_supported() {
        return Ok(());
    }
    Err(AppError::service_unavailable(
        "TRACKER_CREDENTIALS_UNSUPPORTED",
        "Tracker credential vault is not supported on this platform.",
        false,
    ))
}

fn map_credential_error(tracker_key: &str, err: CredentialWriteError) -> AppError {
    match err {
        CredentialWriteError::InvalidKey => {
            AppError::BadRequest(format!("Unsupported trackerKey '{tracker_key}'."))
        }
        CredentialWriteError::InvalidValue(field) => {
            AppError::BadRequest(format!("Invalid tracker credential field '{field}'."))
        }
        CredentialWriteError::Stale { current_revision } => AppError::Conflict(ErrorDetail {
            code: "TRACKER_CREDENTIAL_STALE".to_string(),
            message: format!("Tracker credential '{tracker_key}' has a newer revision."),
            retryable: Some(true),
            min_client_version: None,
            current_server_version: Some(current_revision),
            min_replayable_server_version: None,
            required_action: Some("refresh_credentials".to_string()),
            details: None,
        }),
    }
}

#[allow(dead_code)]
fn _keep_imports_used(_: (&HeaderMap, &V4WireRecord)) {
    let _ = AUTHORIZATION;
}
