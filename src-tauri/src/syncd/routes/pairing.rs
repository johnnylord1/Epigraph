use std::time::Duration;

use axum::extract::{
    ws::{close_code, CloseFrame, Message, WebSocket, WebSocketUpgrade},
    ConnectInfo, Path, Query, State,
};
use axum::response::{Json, Response};
use futures_util::StreamExt;
use std::net::SocketAddr;

use crate::syncd::db::{self, PairingClaimError, PairingClaimOutcome};
use crate::syncd::middleware::validate_client_version_fields;
use crate::syncd::models::{
    AppError, ErrorDetail, PairedDeviceScopesUpdateRequest, PairingClaimRequest,
    PairingClaimResponse, PairingClaimStatus, PairingHostDecision, PairingHostDecisionRequest,
    PairingHostDecisionResponse, PairingSessionStatus, PairingStatusEvent, PairingStatusEventType,
    PairingStatusSubscribeQuery, PairingTokenResponse, SharedAppState, SyncdPairedDeviceView,
};

pub async fn post_pairing_claim(
    State(state): State<SharedAppState>,
    Json(request): Json<PairingClaimRequest>,
) -> Result<Json<PairingClaimResponse>, AppError> {
    validate_pairing_claim_request(&request)?;
    validate_client_version_fields(
        &request.client_version,
        request.client_protocol_version,
        &state,
    )?;

    // Pairing claims update the same SQLite database used by the mirror and projection workers.
    // Serialize the write transaction so a WAL read transaction cannot be upgraded concurrently
    // and surface SQLITE_BUSY_SNAPSHOT to a first-time mobile client.
    let _writer_guard = state.mutation_gate.lock().await;
    let outcome = db::claim_pairing_session(
        &state.pool,
        &state.config,
        &request.session_id,
        &request.pairing_code,
        &request.device_id,
        &request.device_name,
        request.platform,
        request.requested_scopes.as_deref(),
    )
    .await
    .map_err(map_pairing_claim_error)?;

    Ok(Json(match outcome {
        PairingClaimOutcome::PendingApproval {
            session,
            just_claimed,
        } => {
            if just_claimed {
                publish_pairing_transition(&state, &session, true);
            }
            let requested_scopes = requested_scopes_for_response(&session)?;
            PairingClaimResponse {
                status: PairingClaimStatus::PendingApproval,
                session_id: session.session_id,
                profile_id: session.profile_id,
                claimed_device_id: session.claimed_device_id,
                expires_at_ms: session.expires_at_ms,
                requested_scopes,
                token: None,
            }
        }
        PairingClaimOutcome::Approved { session, token } => {
            let requested_scopes = requested_scopes_for_response(&session)?;
            PairingClaimResponse {
                status: PairingClaimStatus::Approved,
                session_id: session.session_id,
                profile_id: session.profile_id,
                claimed_device_id: session.claimed_device_id,
                expires_at_ms: session.expires_at_ms,
                requested_scopes,
                token: Some(PairingTokenResponse {
                    access_token: token.access_token,
                    token_id: token.token_id,
                    profile_id: token.profile_id,
                    scopes: token.scopes,
                    inactivity_expires_at_ms: token.inactivity_expires_at_ms,
                    granted_via: token.granted_via,
                }),
            }
        }
        PairingClaimOutcome::Rejected(session) => {
            let requested_scopes = requested_scopes_for_response(&session)?;
            PairingClaimResponse {
                status: PairingClaimStatus::Rejected,
                session_id: session.session_id,
                profile_id: session.profile_id,
                claimed_device_id: session.claimed_device_id,
                expires_at_ms: session.expires_at_ms,
                requested_scopes,
                token: None,
            }
        }
    }))
}

pub async fn get_pairing_status_live(
    State(state): State<SharedAppState>,
    Path(session_id): Path<String>,
    Query(query): Query<PairingStatusSubscribeQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    validate_pairing_status_subscription(&query)?;
    let session = load_pairing_status_session(&state, &session_id, &query.pairing_code).await?;
    Ok(ws.on_upgrade(move |socket| handle_pairing_status_socket(socket, state, session)))
}

pub async fn post_pairing_host_decision(
    State(state): State<SharedAppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Path(session_id): Path<String>,
    Json(request): Json<PairingHostDecisionRequest>,
) -> Result<Json<PairingHostDecisionResponse>, AppError> {
    require_loopback_control(remote_addr, "Pairing host decision")?;

    let _writer_guard = state.mutation_gate.lock().await;
    let session = match request.decision {
        PairingHostDecision::Approve => db::approve_pairing_session(&state.pool, &session_id)
            .await
            .map_err(|error| {
                AppError::Internal(format!("Failed to approve pairing session: {error}"))
            })?,
        PairingHostDecision::Reject => db::reject_pairing_session(&state.pool, &session_id)
            .await
            .map_err(|error| {
            AppError::Internal(format!("Failed to reject pairing session: {error}"))
        })?,
    }
    .ok_or_else(|| {
        AppError::not_found(
            "PAIRING_SESSION_NOT_FOUND",
            "Pairing session was not found.",
            None,
        )
    })?;

    publish_pairing_transition(&state, &session, true);

    let status = pairing_session_status(&session);
    let requested_scopes = requested_scopes_for_response(&session)?;
    Ok(Json(PairingHostDecisionResponse {
        session_id: session.session_id,
        status,
        claimed_device_id: session.claimed_device_id,
        expires_at_ms: session.expires_at_ms,
        requested_scopes,
    }))
}

pub async fn get_paired_devices(
    State(state): State<SharedAppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
) -> Result<Json<Vec<SyncdPairedDeviceView>>, AppError> {
    require_loopback_control(remote_addr, "Paired device catalog")?;
    let devices = db::list_paired_devices(&state.pool)
        .await
        .map_err(|error| AppError::Internal(format!("Failed to list paired devices: {error}")))?;
    Ok(Json(devices))
}

pub async fn post_paired_device_scopes(
    State(state): State<SharedAppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Json(request): Json<PairedDeviceScopesUpdateRequest>,
) -> Result<Json<SyncdPairedDeviceView>, AppError> {
    require_loopback_control(remote_addr, "Paired device scope update")?;
    if request.device_id.trim().is_empty() || request.profile_id.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Paired device id and profile id must not be empty.".to_string(),
        ));
    }
    db::canonicalize_pairing_scopes(&request.profile_id, &request.granted_scopes, false)
        .map_err(AppError::BadRequest)?;

    let device = db::update_paired_device_granted_scopes(
        &state.pool,
        &request.device_id,
        &request.profile_id,
        &request.granted_scopes,
    )
    .await
    .map_err(|error| AppError::Internal(format!("Failed to update paired device scopes: {error}")))?
    .ok_or_else(|| {
        AppError::not_found(
            "PAIRED_DEVICE_NOT_FOUND",
            "Paired device was not found for the requested profile.",
            None,
        )
    })?;
    Ok(Json(device))
}

fn require_loopback_control(remote_addr: SocketAddr, action: &str) -> Result<(), AppError> {
    if remote_addr.ip().is_loopback() {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "{action} is only available from loopback."
        )))
    }
}

fn requested_scopes_for_response(session: &db::PairingSessionRow) -> Result<Vec<String>, AppError> {
    db::pairing_session_requested_scopes(session).map_err(|error| {
        AppError::Internal(format!("Failed to load pairing session scopes: {error}"))
    })
}

pub(crate) fn publish_pairing_transition(
    state: &SharedAppState,
    session: &db::PairingSessionRow,
    include_status_changed: bool,
) {
    for event in transition_events_for_session(session, include_status_changed) {
        let _ = state.pairing_status_sender.send(event);
    }
}

pub(crate) fn pairing_session_status(session: &db::PairingSessionRow) -> PairingSessionStatus {
    match session.status.as_str() {
        "pending" => PairingSessionStatus::Pending,
        "claimed" => PairingSessionStatus::Claimed,
        "approved" => PairingSessionStatus::Approved,
        "rejected" => PairingSessionStatus::Rejected,
        "expired" => PairingSessionStatus::Expired,
        other => {
            tracing::warn!(
                status = other,
                "unknown pairing session status; coercing to pending"
            );
            PairingSessionStatus::Pending
        }
    }
}

fn transition_events_for_session(
    session: &db::PairingSessionRow,
    include_status_changed: bool,
) -> Vec<PairingStatusEvent> {
    let status = pairing_session_status(session);
    let mut events = Vec::new();

    if include_status_changed && !matches!(status, PairingSessionStatus::Pending) {
        events.push(pairing_status_event(
            session,
            PairingStatusEventType::StatusChanged,
        ));
    }

    match status {
        PairingSessionStatus::Pending | PairingSessionStatus::Claimed => {}
        PairingSessionStatus::Approved => {
            events.push(pairing_status_event(
                session,
                PairingStatusEventType::Approved,
            ));
            events.push(pairing_status_event(
                session,
                PairingStatusEventType::FinalTokenReady,
            ));
        }
        PairingSessionStatus::Rejected => {
            events.push(pairing_status_event(
                session,
                PairingStatusEventType::Rejected,
            ));
        }
        PairingSessionStatus::Expired => {
            events.push(pairing_status_event(
                session,
                PairingStatusEventType::Expired,
            ));
        }
    }

    events
}

fn pairing_status_event(
    session: &db::PairingSessionRow,
    event_type: PairingStatusEventType,
) -> PairingStatusEvent {
    let requested_scopes = db::pairing_session_requested_scopes(session).unwrap_or_else(|error| {
        tracing::error!(
            session_id = %session.session_id,
            error = %error,
            "failed to resolve pairing scopes for status event"
        );
        Vec::new()
    });
    PairingStatusEvent {
        event_type,
        session_id: session.session_id.clone(),
        profile_id: session.profile_id.clone(),
        status: pairing_session_status(session),
        expires_at_ms: session.expires_at_ms,
        claimed_device_id: session.claimed_device_id.clone(),
        requested_scopes,
    }
}

fn initial_subscription_events(session: &db::PairingSessionRow) -> [PairingStatusEvent; 2] {
    [
        pairing_status_event(session, PairingStatusEventType::Hello),
        pairing_status_event(session, PairingStatusEventType::Subscribed),
    ]
}

fn terminal_snapshot_events(session: &db::PairingSessionRow) -> Vec<PairingStatusEvent> {
    if pairing_session_status(session).is_terminal() {
        transition_events_for_session(session, false)
    } else {
        Vec::new()
    }
}

async fn load_pairing_status_session(
    state: &SharedAppState,
    session_id: &str,
    pairing_code: &str,
) -> Result<db::PairingSessionRow, AppError> {
    let now_ms = db::now_ms();
    let session = db::expire_pairing_session_if_needed(&state.pool, session_id, now_ms)
        .await
        .map_err(|error| {
            AppError::Internal(format!("Failed to load pairing live session: {error}"))
        })?
        .ok_or_else(|| {
            AppError::not_found(
                "PAIRING_SESSION_NOT_FOUND",
                "Pairing session was not found.",
                None,
            )
        })?;

    if session.pairing_code != pairing_code {
        return Err(AppError::Unauthorized(
            "Pairing code is invalid for the requested session.".to_string(),
        ));
    }

    if pairing_session_status(&session) == PairingSessionStatus::Expired {
        return Err(AppError::gone(
            "PAIRING_SESSION_EXPIRED",
            "Pairing session has expired.",
            None,
        ));
    }

    Ok(session)
}

async fn handle_pairing_status_socket(
    mut socket: WebSocket,
    state: SharedAppState,
    session: db::PairingSessionRow,
) {
    let mut receiver = state.pairing_status_sender.subscribe();
    for event in initial_subscription_events(&session) {
        if send_pairing_status_event(&mut socket, &event)
            .await
            .is_err()
        {
            let _ = close_socket(&mut socket, "pairing_live_write_failed").await;
            return;
        }
    }

    let snapshot_events = terminal_snapshot_events(&session);
    if !snapshot_events.is_empty() {
        for event in snapshot_events {
            if send_pairing_status_event(&mut socket, &event)
                .await
                .is_err()
            {
                return;
            }
        }
        let _ = close_socket(&mut socket, "pairing_session_terminal").await;
        return;
    }

    let now_ms = db::now_ms();
    let wait_duration = (session.expires_at_ms - now_ms).max(0) as u64;
    let expiry = tokio::time::sleep(Duration::from_millis(wait_duration));
    tokio::pin!(expiry);

    loop {
        tokio::select! {
            _ = &mut expiry => {
                match db::expire_pairing_session_if_needed(&state.pool, &session.session_id, db::now_ms()).await {
                    Ok(Some(expired_session)) if pairing_session_status(&expired_session) == PairingSessionStatus::Expired => {
                        publish_pairing_transition(&state, &expired_session, true);
                        for event in transition_events_for_session(&expired_session, true) {
                            if send_pairing_status_event(&mut socket, &event).await.is_err() {
                                return;
                            }
                        }
                        let _ = close_socket(&mut socket, "pairing_session_expired").await;
                        return;
                    }
                    Ok(_) => {
                        let _ = close_socket(&mut socket, "pairing_session_closed").await;
                        return;
                    }
                    Err(error) => {
                        tracing::warn!(error = %error, session_id = %session.session_id, "failed to expire pairing session for live channel");
                        let _ = close_socket(&mut socket, "pairing_session_expiry_failed").await;
                        return;
                    }
                }
            }
            message = receiver.recv() => match message {
                Ok(event) => {
                    if event.session_id != session.session_id {
                        continue;
                    }
                    if send_pairing_status_event(&mut socket, &event).await.is_err() {
                        return;
                    }
                    if event.event_type.closes_socket() {
                        let _ = close_socket(&mut socket, "pairing_session_terminal").await;
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(session_id = %session.session_id, skipped, "pairing status receiver lagged");
                    let _ = close_socket(&mut socket, "pairing_status_lagged").await;
                    return;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    let _ = close_socket(&mut socket, "pairing_status_closed").await;
                    return;
                }
            },
            inbound = socket.next() => match inbound {
                Some(Ok(Message::Close(_))) | None => return,
                Some(Ok(Message::Ping(payload))) => {
                    if socket.send(Message::Pong(payload)).await.is_err() {
                        return;
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => {
                    tracing::debug!(session_id = %session.session_id, error = %error, "pairing live websocket receive failed");
                    return;
                }
            }
        }
    }
}

async fn send_pairing_status_event(
    socket: &mut WebSocket,
    event: &PairingStatusEvent,
) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(event)
        .map_err(|error| axum::Error::new(std::io::Error::other(error.to_string())))?;
    socket.send(Message::Text(payload.into())).await
}

async fn close_socket(socket: &mut WebSocket, reason: &str) -> Result<(), axum::Error> {
    socket
        .send(Message::Close(Some(CloseFrame {
            code: close_code::NORMAL,
            reason: reason.to_string().into(),
        })))
        .await
}

fn validate_pairing_claim_request(request: &PairingClaimRequest) -> Result<(), AppError> {
    if request.session_id.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Pairing sessionId must not be empty.".to_string(),
        ));
    }
    if request.pairing_code.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Pairing pairingCode must not be empty.".to_string(),
        ));
    }
    if request.device_id.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Pairing deviceId must not be empty.".to_string(),
        ));
    }
    if request.device_name.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Pairing deviceName must not be empty.".to_string(),
        ));
    }
    Ok(())
}

fn validate_pairing_status_subscription(
    query: &PairingStatusSubscribeQuery,
) -> Result<(), AppError> {
    if query.pairing_code.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Pairing live pairingCode must not be empty.".to_string(),
        ));
    }
    Ok(())
}

fn map_pairing_claim_error(error: PairingClaimError) -> AppError {
    match error {
        PairingClaimError::NotFound => AppError::not_found(
            "PAIRING_SESSION_NOT_FOUND",
            "Pairing session was not found.",
            None,
        ),
        PairingClaimError::InvalidCode => {
            AppError::Unauthorized("Pairing code is invalid for the requested session.".to_string())
        }
        PairingClaimError::Expired => AppError::gone(
            "PAIRING_SESSION_EXPIRED",
            "Pairing session has expired.",
            None,
        ),
        PairingClaimError::ClaimedByOtherDevice => AppError::Conflict(ErrorDetail {
            code: "PAIRING_SESSION_ALREADY_CLAIMED".to_string(),
            message: "Pairing session is already claimed by another device.".to_string(),
            retryable: Some(false),
            min_client_version: None,
            current_server_version: None,
            min_replayable_server_version: None,
            required_action: None,
            details: None,
        }),
        PairingClaimError::RejectedForDifferentDevice => AppError::Conflict(ErrorDetail {
            code: "PAIRING_SESSION_REJECTED".to_string(),
            message: "Pairing session was rejected for another device.".to_string(),
            retryable: Some(false),
            min_client_version: None,
            current_server_version: None,
            min_replayable_server_version: None,
            required_action: None,
            details: None,
        }),
        PairingClaimError::ApprovedForDifferentDevice => AppError::Conflict(ErrorDetail {
            code: "PAIRING_SESSION_APPROVED_FOR_OTHER_DEVICE".to_string(),
            message: "Pairing session was approved for another device.".to_string(),
            retryable: Some(false),
            min_client_version: None,
            current_server_version: None,
            min_replayable_server_version: None,
            required_action: None,
            details: None,
        }),
        PairingClaimError::InvalidRequestedScopes(message) => AppError::BadRequest(message),
        PairingClaimError::RequestedScopesMismatch => AppError::Conflict(ErrorDetail {
            code: "PAIRING_REQUESTED_SCOPES_MISMATCH".to_string(),
            message: "Pairing requested scopes changed after the session was claimed.".to_string(),
            retryable: Some(false),
            min_client_version: None,
            current_server_version: None,
            min_replayable_server_version: None,
            required_action: None,
            details: None,
        }),
        PairingClaimError::InvalidStatus(status) => AppError::Conflict(ErrorDetail {
            code: "PAIRING_SESSION_INVALID_STATUS".to_string(),
            message: format!("Pairing session is in unsupported status '{status}'."),
            retryable: Some(false),
            min_client_version: None,
            current_server_version: None,
            min_replayable_server_version: None,
            required_action: None,
            details: None,
        }),
        PairingClaimError::Storage(message) => {
            AppError::Internal(format!("Failed to process pairing claim: {message}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syncd::app::build_test_router;
    use crate::syncd::config::{SyncdAdvertisedEndpointResolver, SyncdConfig};
    use crate::syncd::db::{
        approve_pairing_session, connect, create_bootstrap_pairing_session, create_pairing_session,
        ensure_test_token, expire_pairing_session_if_needed, reject_pairing_session,
        upsert_server_identity,
    };
    use crate::syncd::discovery::{
        SyncdClientDiscoveryContractProvider, SyncdClientDiscoveryGuidanceProvider,
        SyncdDiscoveryDescriptorProvider, SyncdDiscoveryProviderManager,
    };
    use crate::syncd::middleware::{CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER};
    use crate::syncd::models::AppState;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::sync::Arc;
    use tempfile::tempdir;
    use tokio::sync::{broadcast, Mutex, RwLock};
    use tower::ServiceExt;

    fn token_hash(raw: &str) -> String {
        let digest = Sha256::digest(raw.as_bytes());
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    async fn build_state() -> (tempfile::TempDir, SharedAppState) {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        ensure_test_token(
            &pool,
            "device-main",
            "main",
            &token_hash("main-token"),
            &["books:global", "novels:profile:main"],
        )
        .await
        .unwrap();
        let advertised_endpoint_resolver =
            SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let discovery_provider_manager =
            SyncdDiscoveryProviderManager::from_config(&config).unwrap();
        let initial_status =
            discovery_provider_manager.initial_status(&config, &advertised_endpoint_resolver);
        let (change_sender, _) = broadcast::channel(32);
        let (pairing_status_sender, _) = broadcast::channel(64);
        (
            temp,
            Arc::new(AppState {
                config,
                advertised_endpoint_resolver,
                discovery_descriptor_provider: SyncdDiscoveryDescriptorProvider::default(),
                client_discovery_contract_provider: SyncdClientDiscoveryContractProvider::default(),
                client_discovery_guidance_provider: SyncdClientDiscoveryGuidanceProvider::default(),
                discovery_provider_state: Arc::new(RwLock::new(initial_status)),
                discovery_provider_manager,
                discovery_provider_runtime: Arc::new(Mutex::new(None)),
                pool,
                change_sender,
                pairing_status_sender,
                mutation_gate: Arc::new(Mutex::new(())),
                tls_cert_sha256: "fingerprint".to_string(),
            }),
        )
    }

    fn claim_request(
        session_id: &str,
        pairing_code: &str,
        device_id: &str,
        device_name: &str,
    ) -> Request<Body> {
        claim_request_with_scopes(session_id, pairing_code, device_id, device_name, None)
    }

    fn claim_request_with_scopes(
        session_id: &str,
        pairing_code: &str,
        device_id: &str,
        device_name: &str,
        requested_scopes: Option<&[&str]>,
    ) -> Request<Body> {
        let mut payload = json!({
            "sessionId": session_id,
            "pairingCode": pairing_code,
            "deviceId": device_id,
            "deviceName": device_name,
            "platform": "android",
            "clientVersion": "0.1.0",
            "clientProtocolVersion": 1
        });
        if let Some(requested_scopes) = requested_scopes {
            payload["requestedScopes"] = json!(requested_scopes);
        }
        Request::builder()
            .method("POST")
            .uri("/v1/pairing/claim")
            .header("content-type", "application/json")
            .body(Body::from(payload.to_string()))
            .unwrap()
    }

    fn loopback_request(method: &str, uri: &str, payload: Option<Value>) -> Request<Body> {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(
                payload.map(|value| value.to_string()).unwrap_or_default(),
            ))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo::<SocketAddr>("127.0.0.1:4777".parse().unwrap()));
        request
    }

    fn host_decision_request(
        session_id: &str,
        decision: PairingHostDecision,
        remote_addr: SocketAddr,
    ) -> Request<Body> {
        let mut request = Request::builder()
            .method("POST")
            .uri(format!("/v1/pairing/session/{session_id}/decision"))
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "decision": decision,
                })
                .to_string(),
            ))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo::<SocketAddr>(remote_addr));
        request
    }

    fn authorized_get(uri: &str, token: &str) -> Request<Body> {
        Request::builder()
            .method("GET")
            .uri(uri)
            .header("authorization", format!("Bearer {token}"))
            .header(CLIENT_VERSION_HEADER, "0.1.0")
            .header(CLIENT_PROTOCOL_HEADER, "1")
            .body(Body::empty())
            .unwrap()
    }

    async fn json_body(response: axum::response::Response) -> Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn claim_returns_pending_until_session_is_approved() {
        let (_temp, state) = build_state().await;
        create_pairing_session(
            &state.pool,
            "session-main",
            "main",
            "123456",
            "fingerprint",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();

        let app = build_test_router(state.clone());
        let response = app
            .clone()
            .oneshot(claim_request(
                "session-main",
                "123456",
                "android-main",
                "Pixel",
            ))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["status"], "pending_approval");

        approve_pairing_session(&state.pool, "session-main")
            .await
            .unwrap();

        let approved = app
            .oneshot(claim_request(
                "session-main",
                "123456",
                "android-main",
                "Pixel",
            ))
            .await
            .unwrap();
        assert_eq!(approved.status(), StatusCode::OK);
        let payload = json_body(approved).await;
        assert_eq!(payload["status"], "approved");
        assert_eq!(payload["token"]["profileId"], "main");
        assert_eq!(payload["token"]["grantedVia"], "qr");
    }

    #[tokio::test]
    async fn approved_pairing_token_is_profile_bound() {
        let (_temp, state) = build_state().await;
        create_pairing_session(
            &state.pool,
            "session-main",
            "main",
            "123456",
            "fingerprint",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();
        let app = build_test_router(state.clone());

        let claim_pending = app
            .clone()
            .oneshot(claim_request(
                "session-main",
                "123456",
                "android-main",
                "Pixel",
            ))
            .await
            .unwrap();
        assert_eq!(claim_pending.status(), StatusCode::OK);

        approve_pairing_session(&state.pool, "session-main")
            .await
            .unwrap();

        let claim_approved = app
            .clone()
            .oneshot(claim_request(
                "session-main",
                "123456",
                "android-main",
                "Pixel",
            ))
            .await
            .unwrap();
        assert_eq!(claim_approved.status(), StatusCode::OK);
        let approved_payload = json_body(claim_approved).await;
        let access_token = approved_payload["token"]["accessToken"]
            .as_str()
            .unwrap()
            .to_string();

        let books_response = app
            .clone()
            .oneshot(authorized_get(
                "/v1/changes?scopeId=books%3Aglobal&sinceVersion=0",
                &access_token,
            ))
            .await
            .unwrap();
        assert_eq!(books_response.status(), StatusCode::OK);

        let novels_main = app
            .clone()
            .oneshot(authorized_get(
                "/v1/changes?scopeId=novels%3Aprofile%3Amain&sinceVersion=0",
                &access_token,
            ))
            .await
            .unwrap();
        assert_eq!(novels_main.status(), StatusCode::OK);

        let novels_test = app
            .oneshot(authorized_get(
                "/v1/changes?scopeId=novels%3Aprofile%3Atest&sinceVersion=0",
                &access_token,
            ))
            .await
            .unwrap();
        assert_eq!(novels_test.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn requested_scopes_are_persisted_emitted_and_granted_exactly() {
        let (_temp, state) = build_state().await;
        create_pairing_session(
            &state.pool,
            "session-scoped",
            "main",
            "123456",
            "fingerprint",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();
        let mut receiver = state.pairing_status_sender.subscribe();
        let app = build_test_router(state.clone());
        let requested = ["comics:profile:main", "books:global"];

        let pending = app
            .clone()
            .oneshot(claim_request_with_scopes(
                "session-scoped",
                "123456",
                "android-scoped",
                "Scoped Pixel",
                Some(&requested),
            ))
            .await
            .unwrap();
        assert_eq!(pending.status(), StatusCode::OK);
        let pending_payload = json_body(pending).await;
        assert_eq!(
            pending_payload["requestedScopes"],
            json!(["books:global", "comics:profile:main"])
        );
        let claimed_event = receiver.recv().await.unwrap();
        assert_eq!(
            claimed_event.requested_scopes,
            vec!["books:global", "comics:profile:main"]
        );

        approve_pairing_session(&state.pool, "session-scoped")
            .await
            .unwrap();
        let approved = app
            .clone()
            .oneshot(claim_request_with_scopes(
                "session-scoped",
                "123456",
                "android-scoped",
                "Scoped Pixel",
                Some(&requested),
            ))
            .await
            .unwrap();
        assert_eq!(approved.status(), StatusCode::OK);
        let approved_payload = json_body(approved).await;
        assert_eq!(
            approved_payload["token"]["scopes"],
            json!(["books:global", "comics:profile:main"])
        );
        let access_token = approved_payload["token"]["accessToken"].as_str().unwrap();

        let books = app
            .clone()
            .oneshot(authorized_get(
                "/v1/changes?scopeId=books%3Aglobal&sinceVersion=0",
                access_token,
            ))
            .await
            .unwrap();
        assert_eq!(books.status(), StatusCode::OK);
        let novels = app
            .oneshot(authorized_get(
                "/v1/changes?scopeId=novels%3Aprofile%3Amain&sinceVersion=0",
                access_token,
            ))
            .await
            .unwrap();
        assert_eq!(novels.status(), StatusCode::FORBIDDEN);

        let stored = db::load_pairing_session(&state.pool, "session-scoped")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            db::pairing_session_requested_scopes(&stored).unwrap(),
            vec!["books:global", "comics:profile:main"]
        );
    }

    #[tokio::test]
    async fn invalid_or_changed_requested_scopes_are_rejected() {
        let (_temp, state) = build_state().await;
        create_pairing_session(
            &state.pool,
            "session-invalid-scopes",
            "main",
            "123456",
            "fingerprint",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();
        let app = build_test_router(state.clone());

        let invalid = app
            .clone()
            .oneshot(claim_request_with_scopes(
                "session-invalid-scopes",
                "123456",
                "android-scoped",
                "Scoped Pixel",
                Some(&["novels:profile:other"]),
            ))
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

        let initial = app
            .clone()
            .oneshot(claim_request_with_scopes(
                "session-invalid-scopes",
                "123456",
                "android-scoped",
                "Scoped Pixel",
                Some(&["books:global"]),
            ))
            .await
            .unwrap();
        assert_eq!(initial.status(), StatusCode::OK);

        let changed = app
            .oneshot(claim_request_with_scopes(
                "session-invalid-scopes",
                "123456",
                "android-scoped",
                "Scoped Pixel",
                Some(&["comics:profile:main"]),
            ))
            .await
            .unwrap();
        assert_eq!(changed.status(), StatusCode::CONFLICT);
        let payload = json_body(changed).await;
        assert_eq!(
            payload["error"]["code"],
            "PAIRING_REQUESTED_SCOPES_MISMATCH"
        );
    }

    #[tokio::test]
    async fn loopback_catalog_updates_granted_scopes_immediately() {
        let (_temp, state) = build_state().await;
        create_pairing_session(
            &state.pool,
            "session-catalog",
            "main",
            "123456",
            "fingerprint",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();
        let app = build_test_router(state.clone());
        let requested = ["books:global", "comics:profile:main"];
        let pending = app
            .clone()
            .oneshot(claim_request_with_scopes(
                "session-catalog",
                "123456",
                "android-catalog",
                "Catalog Pixel",
                Some(&requested),
            ))
            .await
            .unwrap();
        assert_eq!(pending.status(), StatusCode::OK);
        approve_pairing_session(&state.pool, "session-catalog")
            .await
            .unwrap();
        let approved = app
            .clone()
            .oneshot(claim_request_with_scopes(
                "session-catalog",
                "123456",
                "android-catalog",
                "Catalog Pixel",
                Some(&requested),
            ))
            .await
            .unwrap();
        let approved_payload = json_body(approved).await;
        let access_token = approved_payload["token"]["accessToken"]
            .as_str()
            .unwrap()
            .to_string();

        let catalog = app
            .clone()
            .oneshot(loopback_request("GET", "/v1/pairing/devices", None))
            .await
            .unwrap();
        assert_eq!(catalog.status(), StatusCode::OK);
        let catalog_payload = json_body(catalog).await;
        let device = catalog_payload
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["deviceId"] == "android-catalog")
            .unwrap();
        assert_eq!(
            device["grantedScopes"],
            json!(["books:global", "comics:profile:main"])
        );

        let updated = app
            .clone()
            .oneshot(loopback_request(
                "POST",
                "/v1/pairing/devices/scopes",
                Some(json!({
                    "deviceId": "android-catalog",
                    "profileId": "main",
                    "grantedScopes": ["novels:profile:main"]
                })),
            ))
            .await
            .unwrap();
        assert_eq!(updated.status(), StatusCode::OK);
        let updated_payload = json_body(updated).await;
        assert_eq!(
            updated_payload["grantedScopes"],
            json!(["novels:profile:main"])
        );

        let books = app
            .clone()
            .oneshot(authorized_get(
                "/v1/changes?scopeId=books%3Aglobal&sinceVersion=0",
                &access_token,
            ))
            .await
            .unwrap();
        assert_eq!(books.status(), StatusCode::FORBIDDEN);
        let novels = app
            .oneshot(authorized_get(
                "/v1/changes?scopeId=novels%3Aprofile%3Amain&sinceVersion=0",
                &access_token,
            ))
            .await
            .unwrap();
        assert_eq!(novels.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn claim_returns_rejected_after_rejection() {
        let (_temp, state) = build_state().await;
        create_pairing_session(
            &state.pool,
            "session-rejected",
            "main",
            "123456",
            "fingerprint",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();

        let app = build_test_router(state.clone());
        let _ = app
            .clone()
            .oneshot(claim_request(
                "session-rejected",
                "123456",
                "android-main",
                "Pixel",
            ))
            .await
            .unwrap();

        reject_pairing_session(&state.pool, "session-rejected")
            .await
            .unwrap();

        let rejected = app
            .oneshot(claim_request(
                "session-rejected",
                "123456",
                "android-main",
                "Pixel",
            ))
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::OK);
        let payload = json_body(rejected).await;
        assert_eq!(payload["status"], "rejected");
    }

    #[tokio::test]
    async fn claim_returns_gone_for_expired_session() {
        let (_temp, state) = build_state().await;
        create_pairing_session(
            &state.pool,
            "session-expired",
            "main",
            "123456",
            "fingerprint",
            db::now_ms() - 1,
        )
        .await
        .unwrap();

        let app = build_test_router(state);
        let response = app
            .oneshot(claim_request(
                "session-expired",
                "123456",
                "android-main",
                "Pixel",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::GONE);
    }

    #[tokio::test]
    async fn trusted_device_can_pair_another_profile_via_trusted_pool() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());

        create_pairing_session(
            &state.pool,
            "session-main",
            "main",
            "111111",
            "fingerprint",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();
        let _ = app
            .clone()
            .oneshot(claim_request(
                "session-main",
                "111111",
                "android-shared",
                "Pixel",
            ))
            .await
            .unwrap();
        approve_pairing_session(&state.pool, "session-main")
            .await
            .unwrap();
        let first_claim = app
            .clone()
            .oneshot(claim_request(
                "session-main",
                "111111",
                "android-shared",
                "Pixel",
            ))
            .await
            .unwrap();
        let first_payload = json_body(first_claim).await;
        assert_eq!(first_payload["token"]["grantedVia"], "qr");

        create_pairing_session(
            &state.pool,
            "session-test",
            "test",
            "222222",
            "fingerprint",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();
        let _ = app
            .clone()
            .oneshot(claim_request(
                "session-test",
                "222222",
                "android-shared",
                "Pixel",
            ))
            .await
            .unwrap();
        approve_pairing_session(&state.pool, "session-test")
            .await
            .unwrap();
        let second_claim = app
            .clone()
            .oneshot(claim_request(
                "session-test",
                "222222",
                "android-shared",
                "Pixel",
            ))
            .await
            .unwrap();
        assert_eq!(second_claim.status(), StatusCode::OK);
        let second_payload = json_body(second_claim).await;
        assert_eq!(second_payload["status"], "approved");
        assert_eq!(second_payload["token"]["grantedVia"], "trusted-pool");

        let access_token = second_payload["token"]["accessToken"]
            .as_str()
            .unwrap()
            .to_string();
        let allowed = app
            .clone()
            .oneshot(authorized_get(
                "/v1/changes?scopeId=novels%3Aprofile%3Atest&sinceVersion=0",
                &access_token,
            ))
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::OK);

        let forbidden = app
            .oneshot(authorized_get(
                "/v1/changes?scopeId=novels%3Aprofile%3Amain&sinceVersion=0",
                &access_token,
            ))
            .await
            .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn live_subscription_accepts_valid_bootstrap_session() {
        let (_temp, state) = build_state().await;
        let session = create_bootstrap_pairing_session(
            &state.pool,
            &state.tls_cert_sha256,
            "main",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();
        let loaded =
            load_pairing_status_session(&state, &session.session_id, &session.pairing_code)
                .await
                .unwrap();
        assert_eq!(loaded.session_id, session.session_id);
        assert_eq!(loaded.pairing_code, session.pairing_code);
    }

    #[tokio::test]
    async fn live_subscription_rejects_invalid_or_expired_sessions() {
        let (_temp, state) = build_state().await;
        let session = create_bootstrap_pairing_session(
            &state.pool,
            &state.tls_cert_sha256,
            "main",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();
        let expired = create_pairing_session(
            &state.pool,
            "bootstrap-expired-live",
            "main",
            "EXPIREDLIVE",
            "fingerprint",
            db::now_ms() - 1,
        )
        .await
        .unwrap();
        let missing = load_pairing_status_session(&state, "bootstrap-missing-live", "123456")
            .await
            .unwrap_err();
        assert!(matches!(missing, AppError::NotFound(_)));

        let wrong_code = load_pairing_status_session(&state, &session.session_id, "WRONGCODE")
            .await
            .unwrap_err();
        assert!(matches!(wrong_code, AppError::Unauthorized(_)));

        let expired_response =
            load_pairing_status_session(&state, &expired.session_id, &expired.pairing_code)
                .await
                .unwrap_err();
        assert!(matches!(expired_response, AppError::Gone(_)));
    }

    #[tokio::test]
    async fn live_pairing_emits_claimed_event_when_session_is_first_claimed() {
        let (_temp, state) = build_state().await;
        create_pairing_session(
            &state.pool,
            "session-live-claimed",
            "main",
            "123456",
            "fingerprint",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();
        let mut receiver = state.pairing_status_sender.subscribe();
        let app = build_test_router(state);

        let response = app
            .oneshot(claim_request(
                "session-live-claimed",
                "123456",
                "android-main",
                "Pixel",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let event = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.event_type, PairingStatusEventType::StatusChanged);
        assert_eq!(event.status, PairingSessionStatus::Claimed);
        let raw = serde_json::to_string(&event).unwrap();
        assert!(!raw.contains("accessToken"));
    }

    #[tokio::test]
    async fn live_pairing_emits_approved_and_final_token_ready_only_after_approval() {
        let (_temp, state) = build_state().await;
        create_pairing_session(
            &state.pool,
            "session-live-approved",
            "main",
            "123456",
            "fingerprint",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();
        let mut receiver = state.pairing_status_sender.subscribe();
        let app = build_test_router(state.clone());

        let pending = app
            .clone()
            .oneshot(claim_request(
                "session-live-approved",
                "123456",
                "android-main",
                "Pixel",
            ))
            .await
            .unwrap();
        assert_eq!(pending.status(), StatusCode::OK);

        let claimed = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claimed.status, PairingSessionStatus::Claimed);

        let approved_session = approve_pairing_session(&state.pool, "session-live-approved")
            .await
            .unwrap()
            .unwrap();
        publish_pairing_transition(&state, &approved_session, true);

        let approved_events = vec![
            tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
        ];
        assert_eq!(
            approved_events[0].event_type,
            PairingStatusEventType::StatusChanged
        );
        assert_eq!(approved_events[0].status, PairingSessionStatus::Approved);
        assert_eq!(
            approved_events[1].event_type,
            PairingStatusEventType::Approved
        );
        assert_eq!(
            approved_events[2].event_type,
            PairingStatusEventType::FinalTokenReady
        );
        let raw = serde_json::to_string(&approved_events[2]).unwrap();
        assert!(!raw.contains("accessToken"));
        assert!(PairingStatusEventType::FinalTokenReady.closes_socket());
    }

    #[tokio::test]
    async fn live_pairing_emits_rejected_event() {
        let (_temp, state) = build_state().await;
        create_pairing_session(
            &state.pool,
            "session-live-rejected",
            "main",
            "123456",
            "fingerprint",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();
        let mut receiver = state.pairing_status_sender.subscribe();

        let rejected_session = reject_pairing_session(&state.pool, "session-live-rejected")
            .await
            .unwrap()
            .unwrap();
        publish_pairing_transition(&state, &rejected_session, true);

        let first = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        let second = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.event_type, PairingStatusEventType::StatusChanged);
        assert_eq!(first.status, PairingSessionStatus::Rejected);
        assert_eq!(second.event_type, PairingStatusEventType::Rejected);
        assert!(PairingStatusEventType::Rejected.closes_socket());
    }

    #[tokio::test]
    async fn live_pairing_emits_expired_event() {
        let (_temp, state) = build_state().await;
        create_pairing_session(
            &state.pool,
            "session-live-expired",
            "main",
            "123456",
            "fingerprint",
            db::now_ms(),
        )
        .await
        .unwrap();
        let mut receiver = state.pairing_status_sender.subscribe();

        let expired_session =
            expire_pairing_session_if_needed(&state.pool, "session-live-expired", db::now_ms() + 1)
                .await
                .unwrap()
                .unwrap();
        publish_pairing_transition(&state, &expired_session, true);

        let first = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        let second = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.event_type, PairingStatusEventType::StatusChanged);
        assert_eq!(first.status, PairingSessionStatus::Expired);
        assert_eq!(second.event_type, PairingStatusEventType::Expired);
        assert!(PairingStatusEventType::Expired.closes_socket());
    }

    #[tokio::test]
    async fn host_decision_route_requires_loopback() {
        let (_temp, state) = build_state().await;
        create_pairing_session(
            &state.pool,
            "session-host-forbidden",
            "main",
            "123456",
            "fingerprint",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();
        let app = build_test_router(state);

        let response = app
            .oneshot(host_decision_request(
                "session-host-forbidden",
                PairingHostDecision::Approve,
                "192.168.1.20:9000".parse().unwrap(),
            ))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn host_decision_route_approves_claimed_session_from_loopback() {
        let (_temp, state) = build_state().await;
        create_pairing_session(
            &state.pool,
            "session-host-approved",
            "main",
            "123456",
            "fingerprint",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();
        let mut receiver = state.pairing_status_sender.subscribe();
        let app = build_test_router(state.clone());

        let claim_response = app
            .clone()
            .oneshot(claim_request(
                "session-host-approved",
                "123456",
                "desktop-joiner",
                "Joiner",
            ))
            .await
            .unwrap();
        assert_eq!(claim_response.status(), StatusCode::OK);
        let _claimed = receiver.recv().await.unwrap();

        let response = app
            .oneshot(host_decision_request(
                "session-host-approved",
                PairingHostDecision::Approve,
                "127.0.0.1:4777".parse().unwrap(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["status"], "approved");
        assert_eq!(payload["claimedDeviceId"], "desktop-joiner");
        assert_eq!(
            payload["requestedScopes"],
            json!(["books:global", "novels:profile:main", "comics:profile:main"])
        );

        let first = receiver.recv().await.unwrap();
        let second = receiver.recv().await.unwrap();
        let third = receiver.recv().await.unwrap();
        assert_eq!(first.event_type, PairingStatusEventType::StatusChanged);
        assert_eq!(second.event_type, PairingStatusEventType::Approved);
        assert_eq!(third.event_type, PairingStatusEventType::FinalTokenReady);
    }

    #[tokio::test]
    async fn host_decision_route_rejects_claimed_session_from_loopback() {
        let (_temp, state) = build_state().await;
        create_pairing_session(
            &state.pool,
            "session-host-rejected",
            "main",
            "123456",
            "fingerprint",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();
        let mut receiver = state.pairing_status_sender.subscribe();
        let app = build_test_router(state.clone());

        let claim_response = app
            .clone()
            .oneshot(claim_request(
                "session-host-rejected",
                "123456",
                "desktop-joiner",
                "Joiner",
            ))
            .await
            .unwrap();
        assert_eq!(claim_response.status(), StatusCode::OK);
        let _claimed = receiver.recv().await.unwrap();

        let response = app
            .oneshot(host_decision_request(
                "session-host-rejected",
                PairingHostDecision::Reject,
                "[::1]:4777".parse().unwrap(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["status"], "rejected");
        assert_eq!(payload["claimedDeviceId"], "desktop-joiner");

        let first = receiver.recv().await.unwrap();
        let second = receiver.recv().await.unwrap();
        assert_eq!(first.event_type, PairingStatusEventType::StatusChanged);
        assert_eq!(second.event_type, PairingStatusEventType::Rejected);
    }
}
