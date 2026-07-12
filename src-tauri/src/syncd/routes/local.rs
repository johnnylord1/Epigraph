use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::response::Json;
use serde::Deserialize;

use crate::syncd::db;
use crate::syncd::models::{AppError, PairingTokenResponse, SharedAppState};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAuthorityTokenRequest {
    pub profile_id: String,
    pub device_id: String,
}

pub async fn post_local_authority_token(
    State(state): State<SharedAppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Json(request): Json<LocalAuthorityTokenRequest>,
) -> Result<Json<PairingTokenResponse>, AppError> {
    if !remote_addr.ip().is_loopback() {
        return Err(AppError::Forbidden(
            "Local authority token is only available from loopback.".to_string(),
        ));
    }
    if request.profile_id.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Local authority profileId must not be empty.".to_string(),
        ));
    }
    if request.device_id.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Local authority deviceId must not be empty.".to_string(),
        ));
    }

    let issued = db::issue_local_authority_token(
        &state.pool,
        &state.config,
        request.device_id.trim(),
        request.profile_id.trim(),
    )
    .await
    .map_err(|error| {
        AppError::Internal(format!("Failed to issue local authority token: {error}"))
    })?;

    Ok(Json(PairingTokenResponse {
        access_token: issued.access_token,
        token_id: issued.token_id,
        profile_id: issued.profile_id,
        scopes: issued.scopes,
        inactivity_expires_at_ms: issued.inactivity_expires_at_ms,
        granted_via: issued.granted_via,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syncd::config::{SyncdAdvertisedEndpointResolver, SyncdConfig};
    use crate::syncd::db::{connect, upsert_server_identity};
    use crate::syncd::discovery::{
        SyncdClientDiscoveryContractProvider, SyncdClientDiscoveryGuidanceProvider,
        SyncdDiscoveryDescriptorProvider, SyncdDiscoveryProviderManager,
    };
    use crate::syncd::models::AppState;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use serde_json::Value;
    use std::sync::Arc;
    use tempfile::tempdir;
    use tokio::sync::{broadcast, Mutex, RwLock};
    use tower::ServiceExt;

    async fn build_state() -> SharedAppState {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let advertised_endpoint_resolver =
            SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let discovery_provider_manager =
            SyncdDiscoveryProviderManager::from_config(&config).unwrap();
        let initial_status =
            discovery_provider_manager.initial_status(&config, &advertised_endpoint_resolver);
        let (change_sender, _) = broadcast::channel(32);
        let (pairing_status_sender, _) = broadcast::channel(32);
        Arc::new(AppState {
            config,
            advertised_endpoint_resolver,
            discovery_descriptor_provider: SyncdDiscoveryDescriptorProvider::default(),
            client_discovery_contract_provider: SyncdClientDiscoveryContractProvider::default(),
            client_discovery_guidance_provider: SyncdClientDiscoveryGuidanceProvider::default(),
            discovery_provider_manager,
            discovery_provider_state: Arc::new(RwLock::new(initial_status)),
            discovery_provider_runtime: Arc::new(Mutex::new(None)),
            pool,
            change_sender,
            pairing_status_sender,
            mutation_gate: Arc::new(Mutex::new(())),
            tls_cert_sha256: "fingerprint".to_string(),
        })
    }

    fn router(state: SharedAppState) -> axum::Router {
        axum::Router::new()
            .route(
                "/v1/local/authority-token",
                axum::routing::post(post_local_authority_token),
            )
            .with_state(state)
    }

    #[tokio::test]
    async fn local_authority_token_route_requires_loopback() {
        let state = build_state().await;
        let response = router(state)
            .oneshot(
                Request::post("/v1/local/authority-token")
                    .header("content-type", "application/json")
                    .extension(ConnectInfo(
                        "192.168.1.7:4777".parse::<SocketAddr>().unwrap(),
                    ))
                    .body(Body::from(
                        r#"{"profileId":"main","deviceId":"desktop-main"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn local_authority_token_route_issues_scoped_token() {
        let state = build_state().await;
        let response = router(state.clone())
            .oneshot(
                Request::post("/v1/local/authority-token")
                    .header("content-type", "application/json")
                    .extension(ConnectInfo("127.0.0.1:4777".parse::<SocketAddr>().unwrap()))
                    .body(Body::from(
                        r#"{"profileId":"main","deviceId":"desktop-main"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["profileId"], "main");
        assert_eq!(payload["grantedVia"], "local-authority");
        let scopes = payload["scopes"].as_array().unwrap();
        assert!(scopes.iter().any(|scope| scope == "books:global"));
        assert!(scopes.iter().any(|scope| scope == "novels:profile:main"));
    }
}
