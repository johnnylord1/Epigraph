use axum::extract::State;
use axum::response::Json;

use crate::syncd::db;
use crate::syncd::models::{
    AppError, SharedAppState, SyncdClientDiscoveryContract, SyncdClientDiscoveryGuidanceContract,
    SyncdDiscoveryDescriptor, SyncdDiscoveryProviderStatus,
};

pub async fn get_discovery_descriptor(
    State(state): State<SharedAppState>,
) -> Result<Json<SyncdDiscoveryDescriptor>, AppError> {
    let server_identity = db::load_server_identity(&state.pool)
        .await
        .map_err(|error| {
            AppError::Internal(format!("Failed to load discovery descriptor: {error}"))
        })?;
    let effective_origin = {
        let guard = state.discovery_provider_state.read().await;
        guard.effective_origin.as_advertised_origin()
    };
    let descriptor = state
        .discovery_descriptor_provider
        .build_descriptor_with_origin(effective_origin, &server_identity)
        .map_err(|error| {
            AppError::Internal(format!("Failed to build discovery descriptor: {error}"))
        })?;

    Ok(Json(descriptor))
}

pub async fn get_discovery_status(
    State(state): State<SharedAppState>,
) -> Json<SyncdDiscoveryProviderStatus> {
    Json(state.discovery_provider_state.read().await.clone())
}

pub async fn get_client_discovery_contract(
    State(state): State<SharedAppState>,
) -> Result<Json<SyncdClientDiscoveryContract>, AppError> {
    let server_identity = db::load_server_identity(&state.pool)
        .await
        .map_err(|error| {
            AppError::Internal(format!("Failed to load discovery client contract: {error}"))
        })?;
    let status = state.discovery_provider_state.read().await.clone();
    let contract = state
        .client_discovery_contract_provider
        .build_contract(&server_identity, &status)
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to build discovery client contract: {error}"
            ))
        })?;

    Ok(Json(contract))
}

pub async fn get_client_discovery_guidance(
    State(state): State<SharedAppState>,
) -> Result<Json<SyncdClientDiscoveryGuidanceContract>, AppError> {
    let server_identity = db::load_server_identity(&state.pool)
        .await
        .map_err(|error| {
            AppError::Internal(format!("Failed to load discovery client guidance: {error}"))
        })?;
    let status = state.discovery_provider_state.read().await.clone();
    let contract = state
        .client_discovery_contract_provider
        .build_contract(&server_identity, &status)
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to build discovery client contract for guidance: {error}"
            ))
        })?;
    let guidance = state
        .client_discovery_guidance_provider
        .build_guidance(&contract)
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to build discovery client guidance: {error}"
            ))
        })?;

    Ok(Json(guidance))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use tempfile::tempdir;
    use tokio::sync::broadcast;
    use tower::ServiceExt;

    use crate::syncd::app::build_test_router;
    use crate::syncd::config::{
        SyncdAdvertisedEndpointResolver, SyncdConfig, SyncdDiscoveryProviderMode,
        SyncdEffectiveDiscoveryPolicy, SyncdManualDiscoveryProviderMode,
    };
    use crate::syncd::db::{connect, upsert_server_identity};
    use crate::syncd::discovery::{
        SyncdClientDiscoveryContractProvider, SyncdClientDiscoveryGuidanceProvider,
        SyncdDiscoveryDescriptorProvider, SyncdDiscoveryProviderManager,
    };
    use crate::syncd::models::{
        AppState, SharedAppState, SyncdDiscoveryProviderLifecycle, SyncdDiscoveryProviderStatus,
    };
    use tokio::sync::{Mutex, RwLock};

    async fn build_state(
        configure: impl FnOnce(&mut SyncdConfig),
        initial_status: Option<SyncdDiscoveryProviderStatus>,
    ) -> (tempfile::TempDir, SharedAppState) {
        let temp = tempdir().unwrap();
        let mut config = SyncdConfig::for_test(temp.path().to_path_buf());
        configure(&mut config);
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let advertised_endpoint_resolver =
            SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let discovery_descriptor_provider =
            SyncdDiscoveryDescriptorProvider::from_config(&config).unwrap();
        let discovery_provider_manager =
            SyncdDiscoveryProviderManager::from_config(&config).unwrap();
        let (change_sender, _) = broadcast::channel(32);
        let (pairing_status_sender, _) = broadcast::channel(64);
        let discovery_provider_state = Arc::new(RwLock::new(initial_status.unwrap_or_else(|| {
            discovery_provider_manager.initial_status(&config, &advertised_endpoint_resolver)
        })));
        (
            temp,
            Arc::new(AppState {
                config,
                advertised_endpoint_resolver,
                discovery_descriptor_provider,
                client_discovery_contract_provider: SyncdClientDiscoveryContractProvider::default(),
                client_discovery_guidance_provider: SyncdClientDiscoveryGuidanceProvider::default(),
                discovery_provider_manager,
                discovery_provider_state,
                discovery_provider_runtime: Arc::new(Mutex::new(None)),
                pool,
                change_sender,
                pairing_status_sender,
                mutation_gate: Arc::new(Mutex::new(())),
                tls_cert_sha256: "fingerprint".to_string(),
            }),
        )
    }

    async fn json_body(response: axum::response::Response) -> Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn active_status_for_config(config: &SyncdConfig) -> SyncdDiscoveryProviderStatus {
        let resolver = SyncdAdvertisedEndpointResolver::from_config(config).unwrap();
        let descriptor_provider = SyncdDiscoveryDescriptorProvider::from_config(config).unwrap();
        let manager = SyncdDiscoveryProviderManager::from_config(config).unwrap();
        manager.start_status(
            config,
            &descriptor_provider,
            &resolver,
            &crate::syncd::db::ServerIdentityRow {
                server_id: "syncd-server".to_string(),
                server_protocol_version: 1,
                min_client_version: "0.1.0".to_string(),
                tls_cert_sha256: "fingerprint".to_string(),
                mdns_service_name: config.mdns_service_name.clone(),
            },
        )
    }

    #[tokio::test]
    async fn discovery_descriptor_returns_default_origin_and_capabilities() {
        let (_temp, state) = build_state(|_| {}, None).await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/descriptor")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["descriptorVersion"], 1);
        assert_eq!(
            payload["advertisedOrigin"]["baseUrl"],
            "https://127.0.0.1:4777"
        );
        assert_eq!(payload["advertisedOrigin"]["policyName"], "advertised-only");
        assert_eq!(
            payload["capabilities"]["supportsBootstrapSessionCreate"],
            true
        );
        assert_eq!(
            payload["capabilities"]["supportsBootstrapSessionFetch"],
            true
        );
        assert_eq!(payload["capabilities"]["supportsLivePairingStatus"], true);
        assert_eq!(payload["capabilities"]["supportsDescriptor"], true);
        assert_eq!(payload["capabilities"]["hasAdvertisedEndpoint"], true);
        let server_id = payload["serverId"].as_str().unwrap();
        assert!(!server_id.trim().is_empty());
        let raw = serde_json::to_string(&payload).unwrap();
        assert!(!raw.contains("accessToken"));
        assert!(!raw.contains("\"token\""));
    }

    #[tokio::test]
    async fn discovery_descriptor_reflects_override_origin() {
        let (_temp, state) = build_state(
            |config| {
                config.advertised_base_url = Some("https://localhost:9443".to_string());
            },
            None,
        )
        .await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/descriptor")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(
            payload["advertisedOrigin"]["baseUrl"],
            "https://localhost:9443"
        );
        assert_eq!(payload["advertisedOrigin"]["policyName"], "advertised-only");
    }

    #[tokio::test]
    async fn discovery_descriptor_uses_effective_manual_origin_when_policy_prefers_it() {
        let mut initial_config = SyncdConfig::for_test(std::path::PathBuf::from(
            "C:\\temp\\syncd-descriptor-manual",
        ));
        initial_config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
        initial_config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
        initial_config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
        initial_config.manual_discovery_origins = vec!["https://localhost:9443/".to_string()];
        let (_temp, state) = build_state(
            |config| {
                config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
                config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
                config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
                config.manual_discovery_origins = vec!["https://localhost:9443/".to_string()];
            },
            Some(active_status_for_config(&initial_config)),
        )
        .await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/descriptor")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(
            payload["advertisedOrigin"]["baseUrl"],
            "https://localhost:9443"
        );
        assert_eq!(
            payload["advertisedOrigin"]["policyName"],
            "manual-preferred"
        );
    }

    #[tokio::test]
    async fn discovery_descriptor_stays_consistent_with_bootstrap_origin() {
        let (_temp, state) = build_state(
            |config| {
                config.advertised_base_url = Some("https://localhost:9443".to_string());
            },
            None,
        )
        .await;
        let app = build_test_router(state);

        let descriptor_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/descriptor")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let descriptor = json_body(descriptor_response).await;

        let bootstrap_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/bootstrap/session")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "profileId": "main"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(bootstrap_response.status(), StatusCode::OK);
        let bootstrap = json_body(bootstrap_response).await;
        assert_eq!(
            bootstrap["syncdBaseUrl"],
            descriptor["advertisedOrigin"]["baseUrl"]
        );
        assert_eq!(
            bootstrap["claimUrl"],
            format!(
                "{}/v1/pairing/claim",
                descriptor["advertisedOrigin"]["baseUrl"].as_str().unwrap()
            )
        );
        assert!(!bootstrap.as_object().unwrap().contains_key("token"));
    }

    #[tokio::test]
    async fn client_contract_returns_canonical_advertised_origin_under_advertised_only_policy() {
        let (_temp, state) = build_state(
            |config| {
                config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
            },
            None,
        )
        .await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/client-contract")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["contractVersion"], 1);
        assert_eq!(payload["effectiveOrigin"], "https://127.0.0.1:9443");
        assert_eq!(payload["effectiveSource"], "advertised-endpoint");
        assert_eq!(payload["effectivePolicy"], "advertised-only");
        assert_eq!(payload["candidates"][0]["usageHint"], "canonical");
        assert_eq!(
            payload["candidates"][0]["providers"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            payload["capabilities"]["supportsBootstrapSessionCreate"],
            true
        );
        assert_eq!(payload["capabilities"]["supportsLivePairingStatus"], true);
        let raw = serde_json::to_string(&payload).unwrap();
        assert!(!raw.contains("accessToken"));
        assert!(!raw.contains("\"token\""));
    }

    #[tokio::test]
    async fn client_contract_manual_preferred_marks_canonical_and_fallback_candidates() {
        let mut initial_config = SyncdConfig::for_test(std::path::PathBuf::from(
            "C:\\temp\\syncd-client-contract-manual",
        ));
        initial_config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
        initial_config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
        initial_config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
        initial_config.manual_discovery_origins = vec![
            "https://localhost:9443/".to_string(),
            "https://localhost:9443".to_string(),
            "https://[::1]:9443".to_string(),
        ];
        let (_temp, state) = build_state(
            |config| {
                config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
                config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
                config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
                config.manual_discovery_origins = vec![
                    "https://localhost:9443/".to_string(),
                    "https://localhost:9443".to_string(),
                    "https://[::1]:9443".to_string(),
                ];
            },
            Some(active_status_for_config(&initial_config)),
        )
        .await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/client-contract")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["effectiveOrigin"], "https://localhost:9443");
        assert_eq!(payload["effectiveSource"], "manual-endpoint");
        assert_eq!(payload["effectivePolicy"], "manual-preferred");
        let candidates = payload["candidates"].as_array().unwrap();
        assert_eq!(candidates.len(), 3);
        assert_eq!(candidates[0]["baseUrl"], "https://localhost:9443");
        assert_eq!(candidates[0]["usageHint"], "canonical");
        assert_eq!(candidates[0]["originSource"], "manual-endpoint");
        assert_eq!(candidates[0]["providers"][0], "manual-endpoint");
        assert_eq!(candidates[0]["providers"][1], "lan-publication");
        assert_eq!(candidates[1]["baseUrl"], "https://[::1]:9443");
        assert_eq!(candidates[1]["usageHint"], "fallback");
        assert_eq!(candidates[2]["baseUrl"], "https://127.0.0.1:9443");
        assert_eq!(candidates[2]["usageHint"], "fallback");
    }

    #[tokio::test]
    async fn client_contract_invalid_manual_provider_falls_back_cleanly() {
        let mut initial_config = SyncdConfig::for_test(std::path::PathBuf::from(
            "C:\\temp\\syncd-client-contract-invalid-manual",
        ));
        initial_config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
        initial_config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
        initial_config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
        initial_config.manual_discovery_origins = vec!["http://localhost:9443".to_string()];
        let (_temp, state) = build_state(
            |config| {
                config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
                config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
                config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
                config.manual_discovery_origins = vec!["http://localhost:9443".to_string()];
            },
            Some(active_status_for_config(&initial_config)),
        )
        .await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/client-contract")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["effectiveOrigin"], "https://127.0.0.1:9443");
        assert_eq!(payload["effectiveSource"], "advertised-endpoint");
        assert_eq!(payload["effectivePolicy"], "manual-preferred");
        let candidates = payload["candidates"].as_array().unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0]["usageHint"], "canonical");
        assert_eq!(candidates[0]["providers"][0], "lan-publication");
    }

    #[tokio::test]
    async fn client_guidance_returns_canonical_only_plan_under_advertised_only_policy() {
        let (_temp, state) = build_state(
            |config| {
                config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
            },
            None,
        )
        .await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/client-guidance")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["guidanceVersion"], 1);
        assert_eq!(payload["contractVersion"], 1);
        assert_eq!(payload["effectiveOrigin"], "https://127.0.0.1:9443");
        assert_eq!(payload["effectiveSource"], "advertised-endpoint");
        assert_eq!(
            payload["canonicalAttempt"]["origin"],
            "https://127.0.0.1:9443"
        );
        assert_eq!(payload["canonicalAttempt"]["usageHint"], "canonical");
        assert_eq!(payload["canonicalAttempt"]["bootstrapEligible"], true);
        assert_eq!(payload["canonicalAttempt"]["livePairingEligible"], true);
        assert_eq!(payload["canonicalAttempt"]["informationalOnly"], false);
        assert_eq!(payload["fallbackAttempts"].as_array().unwrap().len(), 0);
        assert_eq!(payload["behavior"]["continueOnConnectionFailure"], false);
        assert_eq!(payload["behavior"]["continueOnTlsMismatch"], false);
        assert_eq!(payload["behavior"]["continueOnBootstrapRejection"], false);
        assert_eq!(payload["behavior"]["continueOnNotFoundOrExpired"], false);
        assert_eq!(payload["candidatesAreNormalizedAndDeduped"], true);
        let raw = serde_json::to_string(&payload).unwrap();
        assert!(!raw.contains("accessToken"));
        assert!(!raw.contains("\"token\""));
    }

    #[tokio::test]
    async fn client_guidance_manual_preferred_exposes_ordered_fallbacks() {
        let mut initial_config = SyncdConfig::for_test(std::path::PathBuf::from(
            "C:\\temp\\syncd-client-guidance-manual",
        ));
        initial_config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
        initial_config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
        initial_config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
        initial_config.manual_discovery_origins = vec![
            "https://localhost:9443/".to_string(),
            "https://localhost:9443".to_string(),
            "https://[::1]:9443".to_string(),
        ];
        let (_temp, state) = build_state(
            |config| {
                config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
                config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
                config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
                config.manual_discovery_origins = vec![
                    "https://localhost:9443/".to_string(),
                    "https://localhost:9443".to_string(),
                    "https://[::1]:9443".to_string(),
                ];
            },
            Some(active_status_for_config(&initial_config)),
        )
        .await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/client-guidance")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["effectiveOrigin"], "https://localhost:9443");
        assert_eq!(payload["effectiveSource"], "manual-endpoint");
        assert_eq!(payload["effectivePolicy"], "manual-preferred");
        assert_eq!(
            payload["canonicalAttempt"]["origin"],
            "https://localhost:9443"
        );
        assert_eq!(
            payload["canonicalAttempt"]["providers"][0],
            "manual-endpoint"
        );
        assert_eq!(
            payload["canonicalAttempt"]["providers"][1],
            "lan-publication"
        );
        let fallbacks = payload["fallbackAttempts"].as_array().unwrap();
        assert_eq!(fallbacks.len(), 2);
        assert_eq!(fallbacks[0]["origin"], "https://[::1]:9443");
        assert_eq!(fallbacks[0]["usageHint"], "fallback");
        assert_eq!(fallbacks[1]["origin"], "https://127.0.0.1:9443");
        assert_eq!(payload["behavior"]["continueOnConnectionFailure"], true);
        assert_eq!(payload["behavior"]["continueOnTlsMismatch"], false);
        assert_eq!(payload["behavior"]["continueOnBootstrapRejection"], false);
        assert_eq!(payload["behavior"]["continueOnNotFoundOrExpired"], false);
    }

    #[tokio::test]
    async fn client_guidance_invalid_manual_provider_falls_back_cleanly() {
        let mut initial_config = SyncdConfig::for_test(std::path::PathBuf::from(
            "C:\\temp\\syncd-client-guidance-invalid-manual",
        ));
        initial_config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
        initial_config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
        initial_config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
        initial_config.manual_discovery_origins = vec!["http://localhost:9443".to_string()];
        let (_temp, state) = build_state(
            |config| {
                config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
                config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
                config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
                config.manual_discovery_origins = vec!["http://localhost:9443".to_string()];
            },
            Some(active_status_for_config(&initial_config)),
        )
        .await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/client-guidance")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["effectiveOrigin"], "https://127.0.0.1:9443");
        assert_eq!(payload["effectiveSource"], "advertised-endpoint");
        assert_eq!(
            payload["canonicalAttempt"]["origin"],
            "https://127.0.0.1:9443"
        );
        assert_eq!(payload["fallbackAttempts"].as_array().unwrap().len(), 0);
        assert_eq!(payload["behavior"]["continueOnConnectionFailure"], false);
    }

    #[tokio::test]
    async fn client_guidance_stays_consistent_with_descriptor_contract_and_bootstrap() {
        let mut initial_config = SyncdConfig::for_test(std::path::PathBuf::from(
            "C:\\temp\\syncd-client-guidance-consistency",
        ));
        initial_config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
        initial_config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
        initial_config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
        initial_config.manual_discovery_origins = vec!["https://localhost:9443".to_string()];
        let (_temp, state) = build_state(
            |config| {
                config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
                config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
                config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
                config.manual_discovery_origins = vec!["https://localhost:9443".to_string()];
            },
            Some(active_status_for_config(&initial_config)),
        )
        .await;
        let app = build_test_router(state);

        let descriptor_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/descriptor")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let descriptor = json_body(descriptor_response).await;

        let contract_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/client-contract")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let contract = json_body(contract_response).await;

        let guidance_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/client-guidance")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let guidance = json_body(guidance_response).await;

        let bootstrap_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/bootstrap/session")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "profileId": "main" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let bootstrap = json_body(bootstrap_response).await;

        assert_eq!(
            guidance["canonicalAttempt"]["origin"],
            contract["effectiveOrigin"]
        );
        assert_eq!(
            guidance["canonicalAttempt"]["origin"],
            descriptor["advertisedOrigin"]["baseUrl"]
        );
        assert_eq!(
            guidance["canonicalAttempt"]["origin"],
            bootstrap["syncdBaseUrl"]
        );
    }

    #[tokio::test]
    async fn discovery_status_returns_disabled_provider_state() {
        let (_temp, state) = build_state(
            |config| {
                config.discovery_provider_mode = SyncdDiscoveryProviderMode::Disabled;
            },
            None,
        )
        .await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["providerMode"], "disabled");
        assert_eq!(payload["lifecycle"], "disabled");
        assert!(payload["publication"].is_null());
        assert_eq!(
            payload["effectiveOrigin"]["baseUrl"],
            "https://127.0.0.1:4777"
        );
        assert_eq!(payload["effectiveOrigin"]["source"], "advertised-endpoint");
        assert_eq!(payload["effectiveOrigin"]["policy"], "advertised-only");
        assert_eq!(payload["manualProvider"]["providerMode"], "disabled");
        assert_eq!(payload["manualProvider"]["lifecycle"], "disabled");
    }

    #[tokio::test]
    async fn discovery_status_returns_active_publication_metadata() {
        let mut status_config =
            SyncdConfig::for_test(std::path::PathBuf::from("C:\\temp\\syncd-discovery-status"));
        status_config.advertised_base_url = Some("https://localhost:9443".to_string());
        let (_temp, state) = build_state(
            |config| {
                config.advertised_base_url = Some("https://localhost:9443".to_string());
            },
            Some(active_status_for_config(&status_config)),
        )
        .await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["providerMode"], "lan-publication");
        assert_eq!(payload["lifecycle"], "active");
        assert_eq!(payload["publication"]["providerKind"], "lan-publication");
        assert_eq!(payload["publication"]["port"], 9443);
        assert_eq!(
            payload["publication"]["hostName"],
            "epigraph-syncd-syncd-se.local."
        );
        assert_eq!(
            payload["publication"]["descriptor"]["advertisedOrigin"]["baseUrl"],
            "https://localhost:9443"
        );
        assert_eq!(
            payload["publication"]["txtRecords"]["advertisedBaseUrl"],
            "https://localhost:9443"
        );
        assert_eq!(
            payload["publication"]["txtRecords"]["supportsDescriptor"],
            true
        );
        assert_eq!(
            payload["effectiveOrigin"]["baseUrl"],
            "https://localhost:9443"
        );
        assert_eq!(payload["effectiveOrigin"]["source"], "advertised-endpoint");
        assert_eq!(payload["manualProvider"]["providerMode"], "disabled");
        assert_eq!(payload["manualProvider"]["lifecycle"], "disabled");
        let raw = serde_json::to_string(&payload).unwrap();
        assert!(!raw.contains("accessToken"));
        assert!(!raw.contains("\"token\""));
    }

    #[tokio::test]
    async fn discovery_status_reports_active_manual_provider_origins() {
        let mut status_config =
            SyncdConfig::for_test(std::path::PathBuf::from("C:\\temp\\syncd-discovery-status"));
        status_config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
        status_config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
        status_config.manual_discovery_origins = vec![
            "https://localhost:9443/".to_string(),
            "https://localhost:9443".to_string(),
            "https://[::1]:9443".to_string(),
        ];
        let (_temp, state) = build_state(
            |config| {
                config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
                config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
                config.manual_discovery_origins = vec![
                    "https://localhost:9443/".to_string(),
                    "https://localhost:9443".to_string(),
                    "https://[::1]:9443".to_string(),
                ];
            },
            Some(active_status_for_config(&status_config)),
        )
        .await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["manualProvider"]["providerMode"], "enabled");
        assert_eq!(payload["manualProvider"]["lifecycle"], "active");
        assert_eq!(
            payload["manualProvider"]["publication"]["providerKind"],
            "manual-endpoint"
        );
        assert_eq!(
            payload["manualProvider"]["publication"]["origins"][0]["baseUrl"],
            "https://localhost:9443"
        );
        assert_eq!(
            payload["manualProvider"]["publication"]["origins"][1]["baseUrl"],
            "https://localhost:9443"
        );
        assert_eq!(
            payload["manualProvider"]["publication"]["origins"][2]["baseUrl"],
            "https://[::1]:9443"
        );
        assert_eq!(
            payload["effectiveOrigin"]["baseUrl"],
            "https://localhost:9443"
        );
        assert_eq!(payload["effectiveOrigin"]["source"], "manual-endpoint");
        assert_eq!(payload["effectiveOrigin"]["policy"], "manual-preferred");
        assert_eq!(
            payload["effectiveOrigin"]["candidates"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }

    #[tokio::test]
    async fn discovery_status_can_report_failed_provider_state() {
        let (_temp, state) = build_state(
            |config| {
                config.mdns_service_name = "invalid-service".to_string();
            },
            Some(SyncdDiscoveryProviderStatus {
                provider_mode: SyncdDiscoveryProviderMode::LanPublication,
                lifecycle: SyncdDiscoveryProviderLifecycle::Failed,
                publication: None,
                failure: Some(crate::syncd::models::SyncdDiscoveryFailure {
                    code: "DISCOVERY_PROVIDER_START_FAILED".to_string(),
                    message: "invalid service type".to_string(),
                }),
                effective_origin: crate::syncd::models::SyncdEffectiveDiscoveryOrigin {
                    base_url: "https://127.0.0.1:4777".to_string(),
                    source: crate::syncd::models::SyncdEffectiveDiscoverySource::AdvertisedEndpoint,
                    policy: SyncdEffectiveDiscoveryPolicy::AdvertisedOnly,
                    candidates: vec![crate::syncd::models::SyncdEffectiveDiscoveryCandidate {
                        base_url: "https://127.0.0.1:4777".to_string(),
                        source:
                            crate::syncd::models::SyncdEffectiveDiscoverySource::AdvertisedEndpoint,
                    }],
                },
                manual_provider: crate::syncd::models::SyncdManualDiscoveryProviderStatus {
                    provider_mode: crate::syncd::config::SyncdManualDiscoveryProviderMode::Disabled,
                    lifecycle: SyncdDiscoveryProviderLifecycle::Disabled,
                    publication: None,
                    failure: None,
                    updated_at_ms: 123,
                },
                updated_at_ms: 123,
            }),
        )
        .await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["lifecycle"], "failed");
        assert_eq!(
            payload["failure"]["code"],
            "DISCOVERY_PROVIDER_START_FAILED"
        );
        assert_eq!(payload["effectiveOrigin"]["source"], "advertised-endpoint");
        assert_eq!(payload["manualProvider"]["lifecycle"], "disabled");
    }

    #[tokio::test]
    async fn discovery_status_can_report_failed_manual_provider_state() {
        let mut status_config = SyncdConfig::for_test(std::path::PathBuf::from(
            "C:\\temp\\syncd-discovery-status-manual-failed",
        ));
        status_config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
        status_config.manual_discovery_origins = vec!["http://localhost:9443".to_string()];
        let (_temp, state) = build_state(
            |config| {
                config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
                config.manual_discovery_origins = vec!["http://localhost:9443".to_string()];
            },
            Some(active_status_for_config(&status_config)),
        )
        .await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["lifecycle"], "active");
        assert_eq!(payload["manualProvider"]["providerMode"], "enabled");
        assert_eq!(payload["manualProvider"]["lifecycle"], "failed");
        assert_eq!(
            payload["manualProvider"]["failure"]["code"],
            "MANUAL_DISCOVERY_PROVIDER_START_FAILED"
        );
        assert_eq!(
            payload["effectiveOrigin"]["baseUrl"],
            "https://127.0.0.1:4777"
        );
        assert_eq!(payload["effectiveOrigin"]["source"], "advertised-endpoint");
    }

    #[tokio::test]
    async fn discovery_status_manual_preferred_policy_selects_manual_origin() {
        let mut status_config = SyncdConfig::for_test(std::path::PathBuf::from(
            "C:\\temp\\syncd-discovery-status-manual-policy",
        ));
        status_config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
        status_config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
        status_config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
        status_config.manual_discovery_origins = vec![
            "https://localhost:9443/".to_string(),
            "https://localhost:9443".to_string(),
        ];
        let (_temp, state) = build_state(
            |config| {
                config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
                config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
                config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
                config.manual_discovery_origins = vec![
                    "https://localhost:9443/".to_string(),
                    "https://localhost:9443".to_string(),
                ];
            },
            Some(active_status_for_config(&status_config)),
        )
        .await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/discovery/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(
            payload["effectiveOrigin"]["baseUrl"],
            "https://localhost:9443"
        );
        assert_eq!(payload["effectiveOrigin"]["source"], "manual-endpoint");
        assert_eq!(payload["effectiveOrigin"]["policy"], "manual-preferred");
        assert_eq!(
            payload["effectiveOrigin"]["candidates"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
}
