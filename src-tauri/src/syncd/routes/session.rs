use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::Json;
use sqlx::Row;

use crate::syncd::db;
use crate::syncd::models::{AppError, AuthenticatedSession, SessionResponse, SharedAppState};

pub async fn get_session(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<SessionResponse>, AppError> {
    let row =
        sqlx::query("SELECT inactivity_expires_at_ms FROM paired_device_tokens WHERE token_id = ?")
            .bind(&session.token_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|_| AppError::Internal("Failed to refresh session metadata.".to_string()))?
            .ok_or_else(|| {
                AppError::Unauthorized("Authenticated session no longer exists.".to_string())
            })?;

    let identity = db::load_server_identity(&state.pool)
        .await
        .map_err(|_| AppError::Internal("Failed to load server identity.".to_string()))?;
    let effective_base_url = state
        .discovery_provider_state
        .read()
        .await
        .effective_origin
        .base_url
        .clone();

    Ok(Json(SessionResponse {
        schema_version: 2,
        server_id: identity.server_id,
        profile_id: session.profile_id,
        token_id: session.token_id,
        scopes: session.scopes.into_iter().collect(),
        inactivity_expires_at_ms: row.get("inactivity_expires_at_ms"),
        effective_base_url,
        tls_cert_sha256: state.tls_cert_sha256.clone(),
        mdns_service_name: identity.mdns_service_name,
    }))
}

/// Ends the calling device's pairing, as "Forget connection" on that device: its tokens and trust
/// are revoked exactly as when the desktop revokes it, so it leaves the paired devices list and
/// must pair again. The desktop's own local-authority session cannot end itself this way.
pub async fn delete_session(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<StatusCode, AppError> {
    if session.token_id.starts_with("local-authority-") {
        return Err(AppError::Forbidden(
            "The local authority session cannot be ended.".to_string(),
        ));
    }
    db::revoke_paired_device(&state.pool, &session.device_id)
        .await
        .map_err(|_| AppError::Internal("Failed to end the session.".to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}
