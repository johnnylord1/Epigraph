use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use axum::middleware;
use axum::routing::{get, post};
use axum::Router;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tokio::sync::{broadcast, Mutex, RwLock};
use tracing_subscriber::EnvFilter;

use super::config::{SyncdAdvertisedEndpointResolver, SyncdConfig};
use super::db;
use super::discovery::{
    start_discovery_provider, SyncdClientDiscoveryContractProvider,
    SyncdClientDiscoveryGuidanceProvider, SyncdDiscoveryDescriptorProvider,
    SyncdDiscoveryProviderManager,
};
use super::middleware::require_authenticated_session;
use super::models::AppState;
use super::routes::{
    bootstrap, capabilities, discovery, events, health, local, mutations, pairing,
};
use super::tls;

pub async fn run() -> anyhow::Result<()> {
    install_tracing();

    let config = SyncdConfig::from_env();
    let advertised_endpoint_resolver = SyncdAdvertisedEndpointResolver::from_config(&config)
        .context("failed to resolve syncd advertised endpoint policy")?;
    let discovery_descriptor_provider = SyncdDiscoveryDescriptorProvider::from_config(&config)
        .context("failed to prepare syncd discovery descriptor provider")?;
    let discovery_provider_manager = SyncdDiscoveryProviderManager::from_config(&config)
        .context("failed to prepare syncd discovery provider manager")?;
    let tls = tls::load_or_create(&config).await?;
    let pool = db::connect(&config).await?;
    db::upsert_server_identity(&pool, &config, &tls.fingerprint_sha256).await?;
    db::prune_expired_rows(&pool, db::now_ms()).await?;

    let (change_sender, _) = broadcast::channel(1_024);
    let (pairing_status_sender, _) = broadcast::channel(256);
    let state = Arc::new(AppState {
        config: config.clone(),
        advertised_endpoint_resolver: advertised_endpoint_resolver.clone(),
        discovery_descriptor_provider,
        client_discovery_contract_provider: SyncdClientDiscoveryContractProvider::default(),
        client_discovery_guidance_provider: SyncdClientDiscoveryGuidanceProvider::default(),
        discovery_provider_manager: discovery_provider_manager.clone(),
        discovery_provider_state: Arc::new(RwLock::new(
            discovery_provider_manager.initial_status(&config, &advertised_endpoint_resolver),
        )),
        discovery_provider_runtime: Arc::new(Mutex::new(None)),
        pool,
        change_sender,
        pairing_status_sender,
        tls_cert_sha256: tls.fingerprint_sha256.clone(),
    });

    let advertised_resolution = advertised_endpoint_resolver.resolve(config.bind_addr);

    spawn_gc_task(state.clone());
    spawn_parent_watchdog(state.clone());
    spawn_discovery_provider_task(state.clone());
    let router = build_router(state.clone());

    tracing::info!(
        bind = %config.bind_addr,
        advertised_base_url = %advertised_resolution.selected.base_url(),
        advertised_policy = advertised_resolution.policy_name,
        effective_discovery_policy = %config.effective_discovery_policy.as_str(),
        tls_cert_sha256 = %state.tls_cert_sha256,
        "aethon-syncd starting"
    );

    axum_server::bind_rustls(config.bind_addr, tls.rustls_config)
        .serve(router.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .context("aethon-syncd failed while serving")
}

fn build_router(state: Arc<AppState>) -> Router {
    let protected = Router::new()
        .route("/v1/events", get(events::get_events))
        .route("/v1/changes", get(events::get_changes))
        .route("/v1/mutations", post(mutations::post_mutations))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_authenticated_session,
        ));

    let mut router = Router::new()
        .route("/healthz", get(health::get_health))
        .route("/v1/capabilities", get(capabilities::get_capabilities))
        .route(
            "/v1/discovery/descriptor",
            get(discovery::get_discovery_descriptor),
        )
        .route(
            "/v1/discovery/client-contract",
            get(discovery::get_client_discovery_contract),
        )
        .route(
            "/v1/discovery/client-guidance",
            get(discovery::get_client_discovery_guidance),
        )
        .route("/v1/discovery/status", get(discovery::get_discovery_status))
        .route(
            "/v1/bootstrap/session",
            post(bootstrap::post_bootstrap_session),
        )
        .route(
            "/v1/bootstrap/session/:session_id",
            get(bootstrap::get_bootstrap_session),
        )
        .route(
            "/v1/bootstrap/session/:session_id/live",
            get(pairing::get_pairing_status_live),
        )
        .route(
            "/v1/pairing/session/:session_id/decision",
            post(pairing::post_pairing_host_decision),
        )
        .route(
            "/v1/local/authority-token",
            post(local::post_local_authority_token),
        )
        .route("/v1/pairing/claim", post(pairing::post_pairing_claim))
        .merge(protected)
        .with_state(state.clone());

    if std::env::var("AETHON_SYNCD_ENABLE_AUDIT_ROUTES").as_deref() == Ok("1") {
        tracing::warn!("syncd audit routes enabled");
        router = router.merge(super::routes::audit::router(state));
    }

    router
}

fn spawn_gc_task(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60 * 60));
        loop {
            ticker.tick().await;
            if let Err(error) = db::prune_expired_rows(&state.pool, db::now_ms()).await {
                tracing::warn!(error = %error, "failed to prune expired syncd rows");
            }
        }
    });
}

fn spawn_parent_watchdog(state: Arc<AppState>) {
    let Some(parent_pid) = state.config.parent_pid else {
        return;
    };

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
        let mut system = System::new();
        loop {
            ticker.tick().await;
            let refreshed = system
                .refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(parent_pid)]), true);
            if refreshed == 0 || system.process(Pid::from_u32(parent_pid)).is_none() {
                tracing::warn!(parent_pid, "syncd parent process missing; exiting sidecar");
                std::process::exit(0);
            }
        }
    });
}

fn spawn_discovery_provider_task(state: Arc<AppState>) {
    tokio::spawn(async move {
        start_discovery_provider(state).await;
    });
}

fn install_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .with_current_span(false)
        .with_span_list(false)
        .try_init();
}

#[cfg(test)]
pub fn build_test_router(state: Arc<AppState>) -> Router {
    build_router(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syncd::db::{
        append_change_log_entry, connect, ensure_test_token, upsert_server_identity,
    };
    use crate::syncd::middleware::{CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use tempfile::tempdir;
    use tower::ServiceExt;

    fn token_hash(raw: &str) -> String {
        let digest = Sha256::digest(raw.as_bytes());
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    async fn build_state_for_http() -> (tempfile::TempDir, Arc<AppState>) {
        build_state_for_http_with_channel(128).await
    }

    async fn build_state_for_http_with_channel(
        channel_size: usize,
    ) -> (tempfile::TempDir, Arc<AppState>) {
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
        let (change_sender, _) = broadcast::channel(channel_size);
        let (pairing_status_sender, _) = broadcast::channel(256);
        let state = Arc::new(AppState {
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
            tls_cert_sha256: "fingerprint".to_string(),
        });
        (temp, state)
    }

    #[tokio::test]
    async fn capabilities_returns_200_for_compatible_client() {
        let (_temp, state) = build_state_for_http().await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/capabilities")
                    .header(CLIENT_VERSION_HEADER, "0.1.0")
                    .header(CLIENT_PROTOCOL_HEADER, "1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["supportsSseReplay"], true);
        assert_eq!(payload["tlsCertSha256"], "fingerprint");
    }

    #[tokio::test]
    async fn capabilities_rejects_old_client() {
        let (_temp, state) = build_state_for_http().await;
        let app = build_test_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/capabilities")
                    .header(CLIENT_VERSION_HEADER, "0.0.1")
                    .header(CLIENT_PROTOCOL_HEADER, "1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED);
    }

    #[tokio::test]
    async fn events_replays_backlog_from_last_event_id() {
        let (_temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("secret-token"),
            &["books:global", "novels:profile:main"],
        )
        .await
        .unwrap();
        let first = append_change_log_entry(
            &state.pool,
            "books:global",
            None,
            "book.progress",
            "book-1",
            "merge",
            1,
            "device-a",
            Some(&serde_json::json!({"progressPercent":0.2})),
            state.config.retention_window,
        )
        .await
        .unwrap();
        let second = append_change_log_entry(
            &state.pool,
            "books:global",
            None,
            "book.progress",
            "book-2",
            "merge",
            2,
            "device-a",
            Some(&serde_json::json!({"progressPercent":0.4})),
            state.config.retention_window,
        )
        .await
        .unwrap();

        let app = build_test_router(state);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/events?scopeId=books:global")
                    .header(CLIENT_VERSION_HEADER, "0.1.0")
                    .header(CLIENT_PROTOCOL_HEADER, "1")
                    .header("authorization", "Bearer secret-token")
                    .header("last-event-id", first.server_version.to_string())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let mut body = response.into_body();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let bytes = frame.into_data().unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("event: change"));
        assert!(text.contains(&format!("id: {}", second.server_version)));
        assert!(text.contains("\"scopeId\":\"books:global\""));
    }

    #[tokio::test]
    async fn events_returns_409_when_replay_window_expired() {
        let (_temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("secret-token"),
            &["books:global", "novels:profile:main"],
        )
        .await
        .unwrap();
        sqlx::query(
            "UPDATE server_runtime SET current_server_version = 10, min_replayable_server_version = 5 WHERE singleton_id = 1",
        )
        .execute(&state.pool)
        .await
        .unwrap();

        let app = build_test_router(state);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/events?scopeId=books:global")
                    .header(CLIENT_VERSION_HEADER, "0.1.0")
                    .header(CLIENT_PROTOCOL_HEADER, "1")
                    .header("authorization", "Bearer secret-token")
                    .header("last-event-id", "3")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["error"]["code"], "REPLAY_WINDOW_EXPIRED");
        assert_eq!(payload["error"]["requiredAction"], "full_bootstrap");
    }

    #[tokio::test]
    async fn events_emit_replay_required_when_live_receiver_lags() {
        let (_temp, state) = build_state_for_http_with_channel(2).await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("secret-token"),
            &["books:global", "novels:profile:main"],
        )
        .await
        .unwrap();

        let app = build_test_router(state.clone());
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/events?scopeId=books:global")
                    .header(CLIENT_VERSION_HEADER, "0.1.0")
                    .header(CLIENT_PROTOCOL_HEADER, "1")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        for index in 1..=4 {
            let envelope = append_change_log_entry(
                &state.pool,
                "books:global",
                None,
                "book.progress",
                &format!("book-{index}"),
                "merge",
                index,
                "device-a",
                Some(&serde_json::json!({"progressPercent": index as f32 / 10.0})),
                state.config.retention_window,
            )
            .await
            .unwrap();
            let _ = state.change_sender.send(envelope);
        }

        let mut body = response.into_body();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let bytes = frame.into_data().unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("event: replay_required"));
        assert!(text.contains("\"reasonCode\":\"LIVE_STREAM_LAGGED\""));
    }
}
