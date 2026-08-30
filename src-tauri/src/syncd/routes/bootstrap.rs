use std::path::PathBuf;

use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, EXPIRES, PRAGMA};
use axum::http::HeaderValue;
use axum::response::{IntoResponse, Json, Response};
use serde::Deserialize;

use crate::syncd::db::{self, PairingSessionRow};
use crate::syncd::models::{
    AppError, BootstrapPayloadResponse, BootstrapSessionCreateRequest, BootstrapSuwayomiHint,
    ErrorDetail, SharedAppState,
};

pub async fn post_bootstrap_session(
    State(state): State<SharedAppState>,
    Json(request): Json<BootstrapSessionCreateRequest>,
) -> Response {
    bootstrap_response(create_bootstrap_session(state, request).await)
}

async fn create_bootstrap_session(
    state: SharedAppState,
    request: BootstrapSessionCreateRequest,
) -> Result<BootstrapPayloadResponse, AppError> {
    if request.profile_id.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Bootstrap profileId must not be empty.".to_string(),
        ));
    }

    let expires_at_ms = db::now_ms() + state.config.bootstrap_session_window.as_millis() as i64;
    let session = db::create_bootstrap_pairing_session(
        &state.pool,
        &state.tls_cert_sha256,
        request.profile_id.trim(),
        expires_at_ms,
    )
    .await
    .map_err(|error| AppError::Internal(format!("Failed to create bootstrap session: {error}")))?;

    build_bootstrap_payload(&state, &session).await
}

pub async fn get_bootstrap_session(
    State(state): State<SharedAppState>,
    Path(session_id): Path<String>,
) -> Response {
    bootstrap_response(fetch_bootstrap_session(state, session_id).await)
}

async fn fetch_bootstrap_session(
    state: SharedAppState,
    session_id: String,
) -> Result<BootstrapPayloadResponse, AppError> {
    let session = db::load_pairing_session(&state.pool, &session_id)
        .await
        .map_err(|error| AppError::Internal(format!("Failed to load bootstrap session: {error}")))?
        .ok_or_else(|| {
            AppError::not_found(
                "BOOTSTRAP_SESSION_NOT_FOUND",
                "Bootstrap session was not found.",
                None,
            )
        })?;

    if session.expires_at_ms <= db::now_ms() || session.status == "expired" {
        return Err(AppError::gone(
            "BOOTSTRAP_SESSION_EXPIRED",
            "Bootstrap session has expired.",
            None,
        ));
    }

    if session.status == "rejected" {
        return Err(AppError::Conflict(ErrorDetail {
            code: "BOOTSTRAP_SESSION_REJECTED".to_string(),
            message: "Bootstrap session was rejected and can no longer be used.".to_string(),
            retryable: Some(false),
            min_client_version: None,
            current_server_version: None,
            min_replayable_server_version: None,
            required_action: Some("reconnect".to_string()),
            details: None,
        }));
    }

    build_bootstrap_payload(&state, &session).await
}

async fn build_bootstrap_payload(
    state: &SharedAppState,
    session: &PairingSessionRow,
) -> Result<BootstrapPayloadResponse, AppError> {
    let syncd_base_url = state
        .discovery_provider_state
        .read()
        .await
        .effective_origin
        .base_url
        .clone();
    let claim_url = format!("{syncd_base_url}/v1/pairing/claim");

    let server_identity = db::load_server_identity(&state.pool)
        .await
        .map_err(|error| AppError::Internal(format!("Failed to load server identity: {error}")))?;

    Ok(BootstrapPayloadResponse {
        schema_version: 2,
        server_id: server_identity.server_id,
        device_name: std::env::var("COMPUTERNAME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "Epigraph Desktop".to_string()),
        pairing_session_id: session.session_id.clone(),
        pairing_code: session.pairing_code.clone(),
        syncd_base_url,
        claim_url,
        profile_id: session.profile_id.clone(),
        expires_at_ms: session.expires_at_ms,
        tls_cert_sha256: state.tls_cert_sha256.clone(),
        mdns_service_name: server_identity.mdns_service_name,
        suwayomi_hint: suwayomi_hint_for_profile(&session.profile_id),
    })
}

fn bootstrap_response(result: Result<BootstrapPayloadResponse, AppError>) -> Response {
    let mut response = match result {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => error.into_response(),
    };
    let headers = response.headers_mut();
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    headers.insert(PRAGMA, HeaderValue::from_static("no-cache"));
    headers.insert(EXPIRES, HeaderValue::from_static("0"));
    response
}

fn suwayomi_hint_for_profile(profile_id: &str) -> Option<BootstrapSuwayomiHint> {
    let profile = BootstrapLocalServerProfile::from_profile_id(profile_id)?;
    let path = local_server_profile_root(profile).join("suwayomi-lan-session.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let session: SuwayomiLanSession = serde_json::from_str(&raw).ok()?;
    if session.profile_key != profile_id {
        return None;
    }
    let advertised_host = session
        .advertised_host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let expires_at_ms = i64::try_from(session.expires_at_ms).ok()?;
    if expires_at_ms <= db::now_ms() {
        return None;
    }

    Some(BootstrapSuwayomiHint {
        base_url: format!("http://{}:{}", advertised_host, profile.default_port()),
        expires_at_ms,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BootstrapLocalServerProfile {
    Main,
    Test,
}

impl BootstrapLocalServerProfile {
    fn from_profile_id(profile_id: &str) -> Option<Self> {
        match profile_id.trim().to_ascii_lowercase().as_str() {
            "main" => Some(Self::Main),
            "test" => Some(Self::Test),
            _ => None,
        }
    }

    fn default_port(self) -> u16 {
        match self {
            Self::Main => 4567,
            Self::Test => 4667,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuwayomiLanSession {
    profile_key: String,
    advertised_host: Option<String>,
    expires_at_ms: u128,
}

fn local_server_profile_root(profile: BootstrapLocalServerProfile) -> PathBuf {
    if let Some(override_path) = local_server_profile_root_override(profile) {
        return override_path;
    }

    match profile {
        BootstrapLocalServerProfile::Test => suwayomi_data_dir(),
        BootstrapLocalServerProfile::Main => {
            #[cfg(target_os = "windows")]
            {
                dirs::data_dir()
                    .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"))
                    .join("epigraph-main")
            }
            #[cfg(target_os = "macos")]
            {
                dirs::data_dir()
                    .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from("~")))
                    .join("epigraph-main")
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                let base = std::env::var("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|_| dirs::data_dir().unwrap_or_else(|| PathBuf::from("/tmp")));
                base.join("epigraph-main")
            }
        }
    }
}

fn local_server_profile_root_override(profile: BootstrapLocalServerProfile) -> Option<PathBuf> {
    let var_name = match profile {
        BootstrapLocalServerProfile::Main => "EPIGRAPH_LOCAL_SERVER_MAIN_ROOT",
        BootstrapLocalServerProfile::Test => "EPIGRAPH_LOCAL_SERVER_TEST_ROOT",
    };
    std::env::var_os(var_name).map(PathBuf::from)
}

fn suwayomi_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"))
            .join("epigraph")
    }
    #[cfg(target_os = "macos")]
    {
        dirs::data_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from("~")))
            .join("epigraph")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs::data_dir().unwrap_or_else(|| PathBuf::from("/tmp")));
        base.join("epigraph")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syncd::app::build_test_router;
    use crate::syncd::config::{
        SyncdAdvertisedEndpointResolver, SyncdConfig, SyncdEffectiveDiscoveryPolicy,
    };
    use crate::syncd::db::{
        approve_pairing_session, connect, create_pairing_session, upsert_server_identity,
    };
    use crate::syncd::discovery::{
        SyncdClientDiscoveryContractProvider, SyncdClientDiscoveryGuidanceProvider,
        SyncdDiscoveryDescriptorProvider, SyncdDiscoveryProviderManager,
    };
    use crate::syncd::models::AppState;
    use axum::body::Body;
    use axum::http::header::{CACHE_CONTROL, EXPIRES, PRAGMA};
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use std::sync::Arc;
    use tempfile::{tempdir, TempDir};
    use tokio::sync::{broadcast, Mutex, RwLock};
    use tower::ServiceExt;

    async fn build_state() -> (TempDir, SharedAppState) {
        build_state_with_config(|_| {}).await
    }

    async fn build_state_with_config(
        configure: impl FnOnce(&mut SyncdConfig),
    ) -> (TempDir, SharedAppState) {
        let temp = tempdir().unwrap();
        let mut config = SyncdConfig::for_test(temp.path().to_path_buf());
        configure(&mut config);
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

    fn create_request(profile_id: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/v1/bootstrap/session")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "profileId": profile_id
                })
                .to_string(),
            ))
            .unwrap()
    }

    fn claim_request(session_id: &str, pairing_code: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/v1/pairing/claim")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "sessionId": session_id,
                    "pairingCode": pairing_code,
                    "deviceId": "android-bootstrap",
                    "deviceName": "Pixel",
                    "platform": "android",
                    "clientVersion": "0.1.0",
                    "clientProtocolVersion": 1
                })
                .to_string(),
            ))
            .unwrap()
    }

    async fn json_body(response: axum::response::Response) -> Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn assert_no_store_headers(response: &axum::response::Response) {
        assert_eq!(
            response.headers().get(CACHE_CONTROL).unwrap(),
            "no-store, max-age=0"
        );
        assert_eq!(response.headers().get(PRAGMA).unwrap(), "no-cache");
        assert_eq!(response.headers().get(EXPIRES).unwrap(), "0");
    }

    #[tokio::test]
    async fn bootstrap_session_returns_minimal_payload_without_token() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);

        let response = app.oneshot(create_request("main")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_no_store_headers(&response);
        let payload = json_body(response).await;

        assert_eq!(payload["profileId"], "main");
        assert_eq!(payload["tlsCertSha256"], "fingerprint");
        assert!(payload["pairingSessionId"]
            .as_str()
            .unwrap()
            .starts_with("bootstrap-"));
        assert!(!payload.as_object().unwrap().contains_key("token"));
        assert!(payload["suwayomiHint"].is_null());
        assert_eq!(
            payload["claimUrl"],
            "https://127.0.0.1:4777/v1/pairing/claim"
        );
        assert!(payload["pairingCode"].as_str().unwrap().len() >= 12);
    }

    #[tokio::test]
    async fn bootstrap_fetch_returns_payload_for_valid_session() {
        let (_temp, state) = build_state().await;
        let session = db::create_bootstrap_pairing_session(
            &state.pool,
            &state.tls_cert_sha256,
            "main",
            db::now_ms() + 60_000,
        )
        .await
        .unwrap();

        let app = build_test_router(state);
        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/v1/bootstrap/session/{}", session.session_id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_no_store_headers(&response);
        let payload = json_body(response).await;
        assert_eq!(payload["pairingSessionId"], session.session_id);
        assert_eq!(payload["pairingCode"], session.pairing_code);
    }

    #[tokio::test]
    async fn bootstrap_payload_uses_advertised_endpoint_override() {
        let (_temp, state) = build_state_with_config(|config| {
            config.advertised_base_url = Some("https://localhost:9443".to_string());
        })
        .await;
        let app = build_test_router(state);

        let response = app.oneshot(create_request("main")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_no_store_headers(&response);
        let payload = json_body(response).await;

        assert_eq!(payload["syncdBaseUrl"], "https://localhost:9443");
        assert_eq!(
            payload["claimUrl"],
            "https://localhost:9443/v1/pairing/claim"
        );
    }

    #[tokio::test]
    async fn bootstrap_payload_uses_effective_manual_origin_when_policy_prefers_it() {
        let (_temp, state) = build_state_with_config(|config| {
            config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
            config.advertised_base_url = Some("https://127.0.0.1:9443".to_string());
            config.manual_discovery_provider_mode =
                crate::syncd::config::SyncdManualDiscoveryProviderMode::Enabled;
            config.manual_discovery_origins = vec!["https://localhost:9443/".to_string()];
        })
        .await;
        let status = state.discovery_provider_manager.start_status(
            &state.config,
            &state.discovery_descriptor_provider,
            &state.advertised_endpoint_resolver,
            &crate::syncd::db::load_server_identity(&state.pool)
                .await
                .unwrap(),
        );
        *state.discovery_provider_state.write().await = status;
        let app = build_test_router(state);

        let response = app.oneshot(create_request("main")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;

        assert_eq!(payload["syncdBaseUrl"], "https://localhost:9443");
        assert_eq!(
            payload["claimUrl"],
            "https://localhost:9443/v1/pairing/claim"
        );
    }

    #[tokio::test]
    async fn bootstrap_fetch_returns_gone_for_expired_session() {
        let (_temp, state) = build_state().await;
        let session = create_pairing_session(
            &state.pool,
            "expired-bootstrap",
            "main",
            "EXPIREDCODE",
            "fingerprint",
            db::now_ms() - 1,
        )
        .await
        .unwrap();

        let app = build_test_router(state);
        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/v1/bootstrap/session/{}", session.session_id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::GONE);
        assert_no_store_headers(&response);
        let payload = json_body(response).await;
        assert_eq!(payload["error"]["code"], "BOOTSTRAP_SESSION_EXPIRED");
    }

    #[tokio::test]
    async fn bootstrap_payload_claim_still_requires_approval() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());

        let created = app.clone().oneshot(create_request("main")).await.unwrap();
        let payload = json_body(created).await;
        let session_id = payload["pairingSessionId"].as_str().unwrap().to_string();
        let pairing_code = payload["pairingCode"].as_str().unwrap().to_string();

        let pending = app
            .clone()
            .oneshot(claim_request(&session_id, &pairing_code))
            .await
            .unwrap();
        assert_eq!(pending.status(), StatusCode::OK);
        let pending_payload = json_body(pending).await;
        assert_eq!(pending_payload["status"], "pending_approval");
        assert!(!pending_payload.as_object().unwrap().contains_key("token"));

        approve_pairing_session(&state.pool, &session_id)
            .await
            .unwrap();

        let approved = app
            .oneshot(claim_request(&session_id, &pairing_code))
            .await
            .unwrap();
        assert_eq!(approved.status(), StatusCode::OK);
        let approved_payload = json_body(approved).await;
        assert_eq!(approved_payload["status"], "approved");
        assert!(approved_payload["token"]["accessToken"].is_string());
    }

    #[tokio::test]
    async fn bootstrap_routes_keep_working_when_discovery_provider_failed() {
        let (_temp, state) = build_state_with_config(|config| {
            config.mdns_service_name = "invalid-service".to_string();
        })
        .await;
        let failed_status = state.discovery_provider_manager.start_status(
            &state.config,
            &state.discovery_descriptor_provider,
            &state.advertised_endpoint_resolver,
            &crate::syncd::db::load_server_identity(&state.pool)
                .await
                .unwrap(),
        );
        assert_eq!(
            failed_status.lifecycle,
            crate::syncd::models::SyncdDiscoveryProviderLifecycle::Failed
        );
        *state.discovery_provider_state.write().await = failed_status;
        let app = build_test_router(state);

        let response = app.oneshot(create_request("main")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_no_store_headers(&response);
        let payload = json_body(response).await;
        assert_eq!(payload["profileId"], "main");
        assert!(payload["claimUrl"]
            .as_str()
            .unwrap()
            .ends_with("/v1/pairing/claim"));
        assert!(!payload.as_object().unwrap().contains_key("token"));
    }

    #[tokio::test]
    async fn bootstrap_routes_keep_working_when_manual_provider_failed() {
        let (_temp, state) = build_state_with_config(|config| {
            config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
            config.manual_discovery_provider_mode =
                crate::syncd::config::SyncdManualDiscoveryProviderMode::Enabled;
            config.manual_discovery_origins = vec!["http://localhost:4777".to_string()];
        })
        .await;
        let failed_status = state.discovery_provider_manager.start_status(
            &state.config,
            &state.discovery_descriptor_provider,
            &state.advertised_endpoint_resolver,
            &crate::syncd::db::load_server_identity(&state.pool)
                .await
                .unwrap(),
        );
        assert_eq!(
            failed_status.lifecycle,
            crate::syncd::models::SyncdDiscoveryProviderLifecycle::Active
        );
        assert_eq!(
            failed_status.manual_provider.lifecycle,
            crate::syncd::models::SyncdDiscoveryProviderLifecycle::Failed
        );
        assert_eq!(
            failed_status.effective_origin.base_url,
            "https://127.0.0.1:4777"
        );
        *state.discovery_provider_state.write().await = failed_status;
        let app = build_test_router(state);

        let response = app.oneshot(create_request("main")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_no_store_headers(&response);
        let payload = json_body(response).await;
        assert_eq!(payload["profileId"], "main");
        assert_eq!(payload["syncdBaseUrl"], "https://127.0.0.1:4777");
        assert!(!payload.as_object().unwrap().contains_key("token"));
    }
}
