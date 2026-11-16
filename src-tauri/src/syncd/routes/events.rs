use std::convert::Infallible;

use async_stream::stream;
use axum::extract::{Extension, Query, State};
use axum::http::HeaderMap;
use axum::response::sse::{Event, Sse};
use axum::response::Json;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::{interval, MissedTickBehavior};

use crate::syncd::models::{AppError, AuthenticatedSession, ChangeEnvelope, SharedAppState};
use crate::syncd::replay::{self, ReplayContext};
use crate::syncd::device_presence::StreamLease;
use crate::syncd::lifecycle::{wait_for_shutdown_request, ShutdownCoordinator, ShutdownRequest};
use crate::syncd::{catalog_revision, db};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsQuery {
    pub scope_id: Option<String>,
    /// The client handles `catalog_revision` events. Older clients reject unknown event types, so
    /// the stream sends them only on request.
    #[serde(default)]
    pub catalog_events: bool,
    /// The client confirms its applied merges from the acknowledgement, so the live stream leaves
    /// out their echo (`supportsSkipOwnEchoesV1`).
    #[serde(default)]
    pub skip_own_echoes: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesQuery {
    pub since_version: i64,
    pub scope_id: Option<String>,
    /// Server versions the client already applied, as `a-b,c` ranges (`supportsHeldVersionsV1`).
    /// They are left out of the response; the client would only skip them on arrival.
    #[serde(default)]
    pub held_versions: Option<String>,
}

/// Bounds the query string; versions past the last range are simply returned as before.
const MAX_HELD_VERSION_RANGES: usize = 512;

/// Parses `heldVersions` into sorted, inclusive ranges.
fn parse_held_versions(raw: &str) -> Result<Vec<(i64, i64)>, AppError> {
    let invalid = || AppError::BadRequest("heldVersions must be comma-separated a-b ranges.".to_string());
    let mut ranges = Vec::new();
    for part in raw.split(',').filter(|part| !part.is_empty()) {
        if ranges.len() == MAX_HELD_VERSION_RANGES {
            return Err(AppError::BadRequest(format!(
                "heldVersions allows at most {MAX_HELD_VERSION_RANGES} ranges."
            )));
        }
        let (start, end) = match part.split_once('-') {
            Some((start, end)) => (start, end),
            None => (part, part),
        };
        let start = start.parse::<i64>().map_err(|_| invalid())?;
        let end = end.parse::<i64>().map_err(|_| invalid())?;
        if start < 0 || end < start {
            return Err(invalid());
        }
        ranges.push((start, end));
    }
    ranges.sort_unstable();
    Ok(ranges)
}

fn is_held(ranges: &[(i64, i64)], version: i64) -> bool {
    let index = ranges.partition_point(|(start, _)| *start <= version);
    index > 0 && version <= ranges[index - 1].1
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesResponse {
    pub current_server_version: i64,
    pub min_replayable_server_version: i64,
    pub changes: Vec<ChangeEnvelope>,
}

pub async fn get_events(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Extension(shutdown): Extension<ShutdownCoordinator>,
    Query(query): Query<EventsQuery>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let receiver = state.change_sender.subscribe();
    let catalog = query.catalog_events.then(catalog_revision::subscribe);
    let replay =
        replay::prepare_replay(&state, &session, query.scope_id.as_deref(), &headers).await?;
    let presence = state
        .device_presence
        .open_stream(&session.token_id, &session.device_id);
    let stream = sse_stream(
        state,
        replay,
        receiver,
        catalog,
        session.token_id,
        query.skip_own_echoes.then_some(session.device_id),
        presence,
        shutdown.subscribe(),
    );
    Ok(Sse::new(stream))
}

pub async fn get_changes(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<ChangesQuery>,
) -> Result<Json<ChangesResponse>, AppError> {
    let runtime = db::load_server_runtime(&state.pool)
        .await
        .map_err(|_| AppError::Internal("Failed to load replay state.".to_string()))?;
    if query.since_version < runtime.min_replayable_server_version {
        return Err(AppError::replay_window_expired(
            runtime.current_server_version,
            runtime.min_replayable_server_version,
        ));
    }
    if query.since_version > runtime.current_server_version {
        return Err(AppError::replay_cursor_ahead(
            query.since_version,
            runtime.current_server_version,
            runtime.min_replayable_server_version,
        ));
    }

    let allowed_scopes =
        crate::syncd::middleware::filter_allowed_scopes(&session, query.scope_id.as_deref())?;
    let held = match query.held_versions.as_deref() {
        Some(raw) => parse_held_versions(raw)?,
        None => Vec::new(),
    };
    let rows = db::fetch_replay_changes(
        &state.pool,
        query.since_version,
        runtime.current_server_version,
    )
    .await
    .map_err(|_| AppError::Internal("Failed to fetch change feed.".to_string()))?;
    let mut changes = Vec::new();
    for row in rows {
        if !allowed_scopes.contains(&row.scope_id) || is_held(&held, row.server_version) {
            continue;
        }
        changes
            .push(ChangeEnvelope::try_from(row).map_err(|_| {
                AppError::Internal("Failed to decode change envelope.".to_string())
            })?);
    }

    Ok(Json(ChangesResponse {
        current_server_version: runtime.current_server_version,
        min_replayable_server_version: runtime.min_replayable_server_version,
        changes,
    }))
}

fn sse_stream(
    state: SharedAppState,
    replay: ReplayContext,
    mut receiver: tokio::sync::broadcast::Receiver<ChangeEnvelope>,
    mut catalog: Option<tokio::sync::broadcast::Receiver<String>>,
    token_id: String,
    own_echoes_of: Option<String>,
    presence: StreamLease,
    mut shutdown: tokio::sync::watch::Receiver<Option<ShutdownRequest>>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    stream! {
        // Counts this device as connected until the client goes away and the stream drops.
        let _presence = presence;
        for envelope in replay.backlog {
            yield Ok(change_event(&envelope));
        }

        let mut last_sent_version = replay.snapshot_version;
        let mut ping = interval(state.config.ping_interval);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                // An open stream would hold the server's graceful shutdown; clients reconnect.
                Some(_) = wait_for_shutdown_request(&mut shutdown) => break,
                _ = ping.tick() => {
                    if !token_still_grants(&state, &token_id, &replay.allowed_scopes).await {
                        break;
                    }
                    // Best effort: a failed refresh is retried on the next ping.
                    let _ = db::extend_streaming_token_activity(
                        &state.pool,
                        &token_id,
                        db::now_ms(),
                        state.config.token_inactivity_window.as_millis() as i64,
                    )
                    .await;
                    yield Ok(Event::default().event("ping").data(""));
                }
                recv = receiver.recv() => {
                    match recv {
                        Ok(envelope) => {
                            if envelope.server_version <= last_sent_version {
                                continue;
                            }
                            if !replay.allowed_scopes.contains(&envelope.scope_id) {
                                continue;
                            }
                            if own_echoes_of
                                .as_deref()
                                .is_some_and(|device_id| state.own_echoes.take(device_id, envelope.server_version))
                            {
                                // The device already holds this record from its acknowledgement.
                                last_sent_version = envelope.server_version;
                                continue;
                            }
                            if !token_still_grants(&state, &token_id, &replay.allowed_scopes).await {
                                break;
                            }
                            last_sent_version = envelope.server_version;
                            yield Ok(change_event(&envelope));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let runtime = match db::load_server_runtime(&state.pool).await {
                                Ok(runtime) => runtime,
                                Err(_) => {
                                    yield Ok(replay_required_event(json!({
                                        "reasonCode": "LIVE_STREAM_LAGGED",
                                        "requiredAction": "full_bootstrap",
                                    })));
                                    break;
                                }
                            };

                            let required_action = if last_sent_version < runtime.min_replayable_server_version {
                                "full_bootstrap"
                            } else {
                                "reconnect_and_replay"
                            };
                            yield Ok(replay_required_event(json!({
                                "reasonCode": "LIVE_STREAM_LAGGED",
                                "requiredAction": required_action,
                                "currentServerVersion": runtime.current_server_version,
                                "minReplayableServerVersion": runtime.min_replayable_server_version,
                                "lastSentVersion": last_sent_version,
                            })));
                            break;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            break;
                        }
                    }
                }
                changed = next_catalog_change(&mut catalog) => {
                    // A lagged receiver missed some profiles, so it reports every streamed scope.
                    let scopes = replay
                        .allowed_scopes
                        .iter()
                        .filter(|scope| match &changed {
                            Some(profile_id) => {
                                scope.strip_prefix(COMICS_SCOPE_PREFIX) == Some(profile_id.as_str())
                            }
                            None => scope.starts_with(COMICS_SCOPE_PREFIX),
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    if scopes.is_empty() {
                        continue;
                    }
                    if !token_still_grants(&state, &token_id, &replay.allowed_scopes).await {
                        break;
                    }
                    for scope_id in scopes {
                        yield Ok(catalog_revision_event(&scope_id));
                    }
                }
            }
        }
    }
}

const COMICS_SCOPE_PREFIX: &str = "comics:profile:";

/// The next profile whose catalog revisions changed, or `None` after the receiver lagged. Pends
/// forever for a stream that did not ask for catalog events.
async fn next_catalog_change(
    catalog: &mut Option<tokio::sync::broadcast::Receiver<String>>,
) -> Option<String> {
    let Some(receiver) = catalog.as_mut() else {
        return std::future::pending().await;
    };
    match receiver.recv().await {
        Ok(profile_id) => Some(profile_id),
        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => None,
        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
            *catalog = None;
            std::future::pending().await
        }
    }
}

/// Authentication happens once when the stream opens, but the stream can stay open for days.
/// Revoking a device, letting its token expire or narrowing its scopes must stop delivery
/// immediately; the client reconnects and receives the regular authorization error. Storage
/// failures also close the stream so a transient error can never extend access.
async fn token_still_grants(
    state: &SharedAppState,
    token_id: &str,
    allowed_scopes: &std::collections::BTreeSet<String>,
) -> bool {
    match db::load_active_token_scopes(&state.pool, token_id, db::now_ms()).await {
        Ok(Some(granted)) => allowed_scopes.iter().all(|scope| granted.contains(scope)),
        Ok(None) | Err(_) => false,
    }
}

fn change_event(envelope: &ChangeEnvelope) -> Event {
    let payload = serde_json::to_string(envelope).unwrap_or_else(|_| "{}".to_string());
    Event::default()
        .event("change")
        .id(envelope.server_version.to_string())
        .data(payload)
}

/// Tells the client that `/v1/sync/status` announces new catalog revisions for the scope. It has no
/// id: it is not a change, and must not move the client's replay cursor.
fn catalog_revision_event(scope_id: &str) -> Event {
    Event::default()
        .event("catalog_revision")
        .data(json!({ "scopeId": scope_id }).to_string())
}

fn replay_required_event(payload: serde_json::Value) -> Event {
    Event::default()
        .event("replay_required")
        .data(payload.to_string())
}

#[cfg(test)]
mod held_versions_tests {
    use super::{is_held, parse_held_versions, MAX_HELD_VERSION_RANGES};

    #[test]
    fn parses_ranges_and_single_versions() {
        let ranges = parse_held_versions("40-50,7,12-13").unwrap();
        assert_eq!(ranges, vec![(7, 7), (12, 13), (40, 50)]);
        for held in [7, 12, 13, 40, 45, 50] {
            assert!(is_held(&ranges, held), "{held}");
        }
        for returned in [0, 6, 8, 11, 14, 39, 51] {
            assert!(!is_held(&ranges, returned), "{returned}");
        }
        assert!(parse_held_versions("").unwrap().is_empty());
    }

    #[test]
    fn rejects_malformed_or_oversized_lists() {
        for raw in ["a", "5-3", "-1", "1-", "1-2-3"] {
            assert!(parse_held_versions(raw).is_err(), "{raw}");
        }
        let too_many = (0..=MAX_HELD_VERSION_RANGES).map(|v| (v * 2).to_string()).collect::<Vec<_>>();
        assert!(parse_held_versions(&too_many.join(",")).is_err());
    }
}
