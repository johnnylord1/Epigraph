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
use crate::syncd::{catalog_revision, db};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsQuery {
    pub scope_id: Option<String>,
    /// The client handles `catalog_revision` events. Older clients reject unknown event types, so
    /// the stream sends them only on request.
    #[serde(default)]
    pub catalog_events: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesQuery {
    pub since_version: i64,
    pub scope_id: Option<String>,
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
    Query(query): Query<EventsQuery>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let receiver = state.change_sender.subscribe();
    let catalog = query.catalog_events.then(catalog_revision::subscribe);
    let replay =
        replay::prepare_replay(&state, &session, query.scope_id.as_deref(), &headers).await?;
    let stream = sse_stream(state, replay, receiver, catalog, session.token_id);
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
    let rows = db::fetch_replay_changes(
        &state.pool,
        query.since_version,
        runtime.current_server_version,
    )
    .await
    .map_err(|_| AppError::Internal("Failed to fetch change feed.".to_string()))?;
    let mut changes = Vec::new();
    for row in rows {
        if !allowed_scopes.contains(&row.scope_id) {
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
) -> impl Stream<Item = Result<Event, Infallible>> {
    stream! {
        for envelope in replay.backlog {
            yield Ok(change_event(&envelope));
        }

        let mut last_sent_version = replay.snapshot_version;
        let mut ping = interval(state.config.ping_interval);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);

        loop {
            tokio::select! {
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
