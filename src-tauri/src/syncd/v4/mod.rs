//! Epigraph Sync V4 core engine (`/v4/*`).
//!
//! Single canonical state table (`v4_records`), append-only ordered change log (`v4_change_log`),
//! HLC + domain-aware offline merge, compressed bulk sync + realtime SSE deltas, LAN extension
//! package cache, and profile-scoped tracker credentials.

pub mod db;
pub mod desktop_extensions;
pub mod desktop_library;
pub mod hlc;
pub mod merge;
pub mod routes;
pub(super) mod suwayomi;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::middleware;
use axum::routing::{get, post, put};
use axum::{Extension, Router};
use tokio::sync::{broadcast, Mutex};

use crate::syncd::models::SharedAppState;
use crate::syncd::routes::assets;

/// Live SSE broadcast channel capacity (16x larger than V1's 1,024 slots).
pub const V4_LIVE_CHANNEL_CAPACITY: usize = 16_384;
/// Maximum uncompressed body for `/v4/sync/bulk` (32 MiB; gzipped ~3–4 MiB on wire).
pub const V4_MAX_BULK_BODY_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone)]
pub enum V4LiveEventKind {
    Delta(db::V4WireRecord),
    BulkCommitted {
        record_count: usize,
        server_seq: i64,
        server_time_ms: i64,
    },
}

#[derive(Debug, Clone)]
pub struct V4LiveEvent {
    pub profile_id: String,
    pub origin_device_id: String,
    pub server_seq: i64,
    pub kind: V4LiveEventKind,
}

/// Shared runtime state for Sync V4, attached via Axum `Extension` so every route (including
/// Suwayomi proxy hooks in Marco 2) can publish realtime V4 events without touching legacy structs.
pub struct V4Runtime {
    pub live_sender: broadcast::Sender<V4LiveEvent>,
    pub write_gate: Arc<Mutex<()>>,
    /// Per-profile state of the desktop comic library baseline. In memory only: a fresh process
    /// runs the baseline again, and the fill-gaps rule makes that a no-op.
    comic_baseline: std::sync::Mutex<suwayomi::ComicBaselineProgress>,
}

impl Default for V4Runtime {
    fn default() -> Self {
        Self::new()
    }
}

impl V4Runtime {
    pub fn new() -> Self {
        let (live_sender, _) = broadcast::channel(V4_LIVE_CHANNEL_CAPACITY);
        Self {
            live_sender,
            write_gate: Arc::new(Mutex::new(())),
            comic_baseline: std::sync::Mutex::new(suwayomi::ComicBaselineProgress::default()),
        }
    }
}

pub fn build_v4_router(state: SharedAppState, runtime: Arc<V4Runtime>) -> Router<SharedAppState> {
    Router::new()
        .route("/v4/capabilities", get(routes::get_capabilities))
        .route("/v4/snapshot", get(routes::get_snapshot))
        .route(
            "/v4/sync/bulk",
            post(routes::post_sync_bulk).layer(DefaultBodyLimit::max(V4_MAX_BULK_BODY_BYTES)),
        )
        .route(
            "/v4/deltas",
            post(routes::post_deltas).layer(DefaultBodyLimit::max(4 * 1024 * 1024)),
        )
        .route("/v4/changes", get(routes::get_changes))
        .route("/v4/events", get(routes::get_events))
        .route(
            "/v4/assets/:sha256",
            get(assets::get_asset)
                .head(assets::head_asset)
                .put(assets::put_asset),
        )
        .route(
            "/v4/extensions/packages/:kind/:package_id/:version",
            get(routes::get_extension_package)
                .head(routes::head_extension_package)
                .put(routes::put_extension_package)
                .layer(DefaultBodyLimit::max(routes::MAX_EXTENSION_PACKAGE_BYTES)),
        )
        .route(
            "/v4/tracker-credentials",
            get(routes::get_tracker_credentials),
        )
        .route(
            "/v4/tracker-credentials/:tracker_key",
            put(routes::put_tracker_credential).delete(routes::delete_tracker_credential),
        )
        .layer(Extension(runtime))
        .route_layer(middleware::from_fn_with_state(
            state,
            routes::require_v4_session,
        ))
}
