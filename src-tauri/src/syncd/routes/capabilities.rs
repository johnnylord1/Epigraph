use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;

use crate::syncd::db;
use crate::syncd::middleware::validate_client_headers;
use crate::syncd::models::{AppError, CapabilitiesResponse, SharedAppState};

pub async fn get_capabilities(
    State(state): State<SharedAppState>,
    headers: HeaderMap,
) -> Result<Json<CapabilitiesResponse>, AppError> {
    validate_client_headers(&headers, &state)?;
    let runtime = db::load_server_runtime(&state.pool)
        .await
        .map_err(|_| AppError::Internal("Failed to load server runtime.".to_string()))?;

    Ok(Json(CapabilitiesResponse {
        server_protocol_version: state.config.server_protocol_version,
        min_client_version: state.config.min_client_version.clone(),
        supported_scopes: vec![
            "books:global".to_string(),
            "novels:profile:<paired-profile>".to_string(),
        ],
        supports_sse_replay: true,
        supports_manual_ip_fallback: true,
        supports_owner_transfer: true,
        tls_cert_sha256: state.tls_cert_sha256.clone(),
        mdns_service_name: state.config.mdns_service_name.clone(),
        current_server_version: runtime.current_server_version,
        min_replayable_server_version: runtime.min_replayable_server_version,
    }))
}
