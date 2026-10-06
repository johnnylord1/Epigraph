//! `/v1/tracker-credentials`: compare-and-set tracker logins for paired devices.
//!
//! Bodies are decoded by hand so that every malformed request is a 400 and no
//! value ever reaches an extractor rejection message or a log line.

use axum::body::Bytes;
use axum::extract::{Extension, Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::syncd::models::{AppError, AuthenticatedSession, ErrorDetail, SharedAppState};
use crate::syncd::tracker_credentials::{
    self, CredentialValues, CredentialWriteError, TrackerCredentialView,
    TRACKER_CREDENTIALS_SCHEMA_VERSION,
};
use crate::syncd::suwayomi_tracking_mirror;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerCredentialListResponse {
    pub schema_version: u32,
    pub credentials: Vec<TrackerCredentialView>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackerCredentialWriteRequest {
    base_revision: i64,
    #[serde(default)]
    #[allow(dead_code)]
    device_id: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackerCredentialDeleteRequest {
    base_revision: i64,
    #[serde(default)]
    #[allow(dead_code)]
    device_id: String,
}

pub async fn get_tracker_credentials(
    State(state): State<SharedAppState>,
    Extension(_session): Extension<AuthenticatedSession>,
) -> Result<Json<TrackerCredentialListResponse>, AppError> {
    ensure_supported()?;
    let vault = tracker_credentials::load_vault(&state.config.data_dir)
        .await
        .map_err(vault_error)?;
    Ok(Json(TrackerCredentialListResponse {
        schema_version: TRACKER_CREDENTIALS_SCHEMA_VERSION,
        credentials: vault.views(),
    }))
}

pub async fn put_tracker_credential(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(tracker_key): Path<String>,
    body: Bytes,
) -> Result<Json<TrackerCredentialView>, AppError> {
    ensure_supported()?;
    let request: TrackerCredentialWriteRequest = serde_json::from_slice(&body).map_err(|_| {
        AppError::BadRequest(
            "Tracker credential body must be {baseRevision, deviceId, username, password, token}."
                .to_string(),
        )
    })?;
    validate_base_revision(request.base_revision)?;
    let audit_device_id = session.device_id.clone();
    let now_ms = now_ms();
    let values = CredentialValues {
        username: request.username,
        password: request.password,
        token: request.token,
    };
    let outcome = tracker_credentials::update_vault(&state.config.data_dir, |vault| {
        vault
            .put(
                &tracker_key,
                request.base_revision,
                values,
                &audit_device_id,
                now_ms,
            )
            .map(|view| (view, true))
    })
    .await
    .map_err(vault_error)?;
    let view = outcome.map_err(|error| write_error(&tracker_key, error))?;
    tracing::info!(
        tracker_key = %view.tracker_key,
        revision = view.revision,
        "tracker credential stored"
    );
    suwayomi_tracking_mirror::request_immediate_mirror();
    Ok(Json(view))
}

pub async fn delete_tracker_credential(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(tracker_key): Path<String>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_supported()?;
    let request: TrackerCredentialDeleteRequest = serde_json::from_slice(&body).map_err(|_| {
        AppError::BadRequest(
            "Tracker credential delete body must be {baseRevision, deviceId}.".to_string(),
        )
    })?;
    validate_base_revision(request.base_revision)?;
    let audit_device_id = session.device_id.clone();
    let now_ms = now_ms();
    let outcome = tracker_credentials::update_vault(&state.config.data_dir, |vault| {
        vault
            .delete(&tracker_key, request.base_revision, &audit_device_id, now_ms)
            .map(|view| (view, true))
    })
    .await
    .map_err(vault_error)?;
    let view = outcome.map_err(|error| write_error(&tracker_key, error))?;
    tracing::info!(
        tracker_key = %view.tracker_key,
        revision = view.revision,
        "tracker credential tombstoned"
    );
    suwayomi_tracking_mirror::request_immediate_mirror();
    Ok(Json(json!({
        "trackerKey": view.tracker_key,
        "revision": view.revision,
        "deleted": true,
        "username": "",
        "password": "",
        "token": "",
        "updatedAtMs": view.updated_at_ms,
    })))
}

fn ensure_supported() -> Result<(), AppError> {
    if tracker_credentials::is_supported() {
        return Ok(());
    }
    Err(AppError::ServiceUnavailable(ErrorDetail {
        code: "TRACKER_CREDENTIALS_UNSUPPORTED".to_string(),
        message: "Tracker credential sync needs a machine-bound key on this host.".to_string(),
        retryable: Some(false),
        min_client_version: None,
        current_server_version: None,
        min_replayable_server_version: None,
        required_action: None,
        details: None,
    }))
}

fn validate_base_revision(base_revision: i64) -> Result<(), AppError> {
    if base_revision < 0 || base_revision >= i64::MAX - 1 {
        return Err(AppError::BadRequest(
            "baseRevision must be a non-negative revision.".to_string(),
        ));
    }
    Ok(())
}

fn write_error(tracker_key: &str, error: CredentialWriteError) -> AppError {
    match error {
        CredentialWriteError::InvalidKey => AppError::BadRequest(
            "trackerKey must match ^[a-z][a-z0-9_]{0,63}$.".to_string(),
        ),
        CredentialWriteError::InvalidValue(field) => AppError::BadRequest(format!(
            "Tracker credential field '{field}' is invalid or larger than 8 KiB."
        )),
        CredentialWriteError::Stale { current_revision } => AppError::Conflict(ErrorDetail {
            code: "TRACKER_CREDENTIAL_REVISION_CONFLICT".to_string(),
            message: "baseRevision is not the current revision; nothing was written.".to_string(),
            retryable: Some(false),
            min_client_version: None,
            current_server_version: None,
            min_replayable_server_version: None,
            required_action: Some("refetch".to_string()),
            details: Some(json!({
                "trackerKey": tracker_key,
                "currentRevision": current_revision,
            })),
        }),
    }
}

fn vault_error(error: anyhow::Error) -> AppError {
    // The vault error chain never contains credential values, only I/O and DPAPI context.
    tracing::error!(error = %error, "tracker credential vault failed");
    AppError::Internal("Tracker credential vault is unavailable.".to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
