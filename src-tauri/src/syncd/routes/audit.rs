use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Request, State};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::post;
use axum::Router;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::syncd::db;
use crate::syncd::models::{AppError, ChangeEnvelope, SharedAppState};
use crate::syncd::routes::pairing::publish_pairing_transition;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureTokenRequest {
    pub device_id: String,
    pub profile_id: String,
    pub raw_token: String,
    pub scopes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendChangeRequest {
    pub scope_id: String,
    pub profile_id: Option<String>,
    pub entity_type: String,
    pub entity_id: String,
    pub op: String,
    pub lamport: i64,
    pub changed_by_device_id: String,
    pub patch: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOverrideRequest {
    pub current_server_version: i64,
    pub min_replayable_server_version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenMutationRequest {
    pub raw_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePairingSessionRequest {
    pub session_id: Option<String>,
    pub profile_id: String,
    pub pairing_code: String,
    pub expires_at_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingSessionActionRequest {
    pub session_id: String,
}

pub fn router(state: SharedAppState) -> Router {
    Router::new()
        .route("/__audit/ensure-token", post(ensure_token))
        .route("/__audit/append-change", post(append_change))
        .route("/__audit/runtime", post(set_runtime))
        .route("/__audit/pairing-session", post(create_pairing_session))
        .route(
            "/__audit/pairing-session/state",
            post(pairing_session_state),
        )
        .route(
            "/__audit/pairing-session/approve",
            post(approve_pairing_session),
        )
        .route(
            "/__audit/pairing-session/reject",
            post(reject_pairing_session),
        )
        .route("/__audit/token-state", post(token_state))
        .route("/__audit/revoke-token", post(revoke_token))
        .route("/__audit/expire-token", post(expire_token))
        .with_state(state)
        .layer(middleware::from_fn(loopback_only))
}

/// Audit routes mint tokens and rewrite server state for the phase-gate scripts. Even when the
/// environment switch is on, they answer only callers on this machine, never the LAN listener.
async fn loopback_only(request: Request, next: Next) -> Response {
    let from_loopback = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|ConnectInfo(remote)| remote.ip().is_loopback());
    if !from_loopback {
        return AppError::Forbidden("Audit routes are only available from loopback.".to_string())
            .into_response();
    }
    next.run(request).await
}

async fn ensure_token(
    State(state): State<SharedAppState>,
    Json(request): Json<EnsureTokenRequest>,
) -> Result<Json<Value>, AppError> {
    let scopes = request
        .scopes
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    db::ensure_token_with_hash(
        &state.pool,
        &request.device_id,
        &request.profile_id,
        &hash_token(&request.raw_token),
        &scopes,
    )
    .await
    .map_err(|_| AppError::Internal("Failed to seed audit token.".to_string()))?;

    Ok(Json(serde_json::json!({
        "ok": true,
        "profileId": request.profile_id,
        "scopes": request.scopes,
    })))
}

async fn append_change(
    State(state): State<SharedAppState>,
    Json(request): Json<AppendChangeRequest>,
) -> Result<Json<ChangeEnvelope>, AppError> {
    let envelope = db::append_change_log_entry(
        &state.pool,
        &request.scope_id,
        request.profile_id.as_deref(),
        &request.entity_type,
        &request.entity_id,
        &request.op,
        request.lamport,
        &request.changed_by_device_id,
        request.patch.as_ref(),
        state.config.retention_window,
    )
    .await
    .map_err(|_| AppError::Internal("Failed to append audit change.".to_string()))?;

    let _ = state.change_sender.send(envelope.clone());
    Ok(Json(envelope))
}

async fn set_runtime(
    State(state): State<SharedAppState>,
    Json(request): Json<RuntimeOverrideRequest>,
) -> Result<Json<Value>, AppError> {
    db::set_server_runtime_for_audit(
        &state.pool,
        request.current_server_version,
        request.min_replayable_server_version,
    )
    .await
    .map_err(|_| AppError::Internal("Failed to override runtime state.".to_string()))?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn revoke_token(
    State(state): State<SharedAppState>,
    Json(request): Json<TokenMutationRequest>,
) -> Result<Json<Value>, AppError> {
    db::revoke_token(&state.pool, &hash_token(&request.raw_token))
        .await
        .map_err(|_| AppError::Internal("Failed to revoke audit token.".to_string()))?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn expire_token(
    State(state): State<SharedAppState>,
    Json(request): Json<TokenMutationRequest>,
) -> Result<Json<Value>, AppError> {
    db::expire_token_now(&state.pool, &hash_token(&request.raw_token))
        .await
        .map_err(|_| AppError::Internal("Failed to expire audit token.".to_string()))?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn token_state(
    State(state): State<SharedAppState>,
    Json(request): Json<TokenMutationRequest>,
) -> Result<Json<Value>, AppError> {
    let token = db::load_token_state(&state.pool, &hash_token(&request.raw_token))
        .await
        .map_err(|_| AppError::Internal("Failed to load audit token state.".to_string()))?;

    Ok(Json(
        serde_json::to_value(token).unwrap_or_else(|_| serde_json::json!({})),
    ))
}

async fn create_pairing_session(
    State(state): State<SharedAppState>,
    Json(request): Json<CreatePairingSessionRequest>,
) -> Result<Json<Value>, AppError> {
    if request.profile_id.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Audit pairing profileId must not be empty.".to_string(),
        ));
    }
    if request.pairing_code.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Audit pairing pairingCode must not be empty.".to_string(),
        ));
    }

    let session_id = request
        .session_id
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let expires_at_ms = request
        .expires_at_ms
        .unwrap_or_else(|| db::now_ms() + 5 * 60 * 1000);
    let session = db::create_pairing_session(
        &state.pool,
        &session_id,
        &request.profile_id,
        &request.pairing_code,
        &state.tls_cert_sha256,
        expires_at_ms,
    )
    .await
    .map_err(|_| AppError::Internal("Failed to create audit pairing session.".to_string()))?;

    Ok(Json(
        serde_json::to_value(session).unwrap_or_else(|_| serde_json::json!({})),
    ))
}

async fn pairing_session_state(
    State(state): State<SharedAppState>,
    Json(request): Json<PairingSessionActionRequest>,
) -> Result<Json<Value>, AppError> {
    let session = db::load_pairing_session(&state.pool, &request.session_id)
        .await
        .map_err(|_| AppError::Internal("Failed to load audit pairing session.".to_string()))?;
    Ok(Json(
        serde_json::to_value(session).unwrap_or_else(|_| serde_json::json!({})),
    ))
}

async fn approve_pairing_session(
    State(state): State<SharedAppState>,
    Json(request): Json<PairingSessionActionRequest>,
) -> Result<Json<Value>, AppError> {
    let session = db::approve_pairing_session(&state.pool, &request.session_id)
        .await
        .map_err(|error| {
            AppError::Internal(format!("Failed to approve audit pairing session: {error}"))
        })?;
    if let Some(session_ref) = session.as_ref() {
        publish_pairing_transition(&state, session_ref, true);
    }
    Ok(Json(
        serde_json::to_value(session).unwrap_or_else(|_| serde_json::json!({})),
    ))
}

async fn reject_pairing_session(
    State(state): State<SharedAppState>,
    Json(request): Json<PairingSessionActionRequest>,
) -> Result<Json<Value>, AppError> {
    let session = db::reject_pairing_session(&state.pool, &request.session_id)
        .await
        .map_err(|error| {
            AppError::Internal(format!("Failed to reject audit pairing session: {error}"))
        })?;
    if let Some(session_ref) = session.as_ref() {
        publish_pairing_transition(&state, session_ref, true);
    }
    Ok(Json(
        serde_json::to_value(session).unwrap_or_else(|_| serde_json::json!({})),
    ))
}

fn hash_token(raw_token: &str) -> String {
    let digest = Sha256::digest(raw_token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
