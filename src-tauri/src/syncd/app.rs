use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use axum::middleware;
use axum::routing::{get, post, put};
use axum::{Extension, Router};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tokio::sync::{broadcast, Mutex, RwLock};
use tracing_subscriber::EnvFilter;

use super::config::{SyncdAdvertisedEndpointResolver, SyncdConfig, SyncdOwnershipMode};
use super::db;
use super::discovery::{
    start_discovery_provider, SyncdClientDiscoveryContractProvider,
    SyncdClientDiscoveryGuidanceProvider, SyncdDiscoveryDescriptorProvider,
    SyncdDiscoveryProviderManager,
};
use super::lifecycle::{
    response_delay, wait_for_shutdown_request, ShutdownCoordinator, ShutdownReason, ShutdownRequest,
};
use super::middleware::require_authenticated_session;
use super::models::AppState;
use super::routes::{
    assets, bootstrap, capabilities, discovery, health, local, pairing, session, status,
    suwayomi_catalog, suwayomi_commands, suwayomi_content, suwayomi_extensions, suwayomi_proxy,
    tracker_credentials,
};
use super::runtime_manifest::{RuntimeManifestLease, RuntimeProcessLock, SyncdRuntimeManifest};
use super::tls;

pub async fn run() -> anyhow::Result<()> {
    install_tracing();

    let config = SyncdConfig::from_env();
    let _runtime_process_lock = if config.ownership_mode == SyncdOwnershipMode::PersistentAttached {
        Some(
            RuntimeProcessLock::acquire(&config.data_dir)
                .context("failed to acquire persistent Core process lock")?,
        )
    } else {
        None
    };
    let advertised_endpoint_resolver = SyncdAdvertisedEndpointResolver::from_config(&config)
        .context("failed to resolve syncd advertised endpoint policy")?;
    let discovery_descriptor_provider = SyncdDiscoveryDescriptorProvider::from_config(&config)
        .context("failed to prepare syncd discovery descriptor provider")?;
    let discovery_provider_manager = SyncdDiscoveryProviderManager::from_config(&config)
        .context("failed to prepare syncd discovery provider manager")?;
    // Resolve the effective advertised endpoints before creating TLS material.  The
    // certificate must cover every endpoint that discovery can hand to a client;
    // otherwise a LAN client will correctly reject the self-signed certificate
    // during hostname verification.
    let advertised_resolution = advertised_endpoint_resolver.resolve(config.bind_addr);
    let tls = tls::load_or_create(&config, &advertised_resolution.candidates).await?;
    let pool = db::connect(&config).await?;
    db::upsert_server_identity(&pool, &config, &tls.fingerprint_sha256).await?;
    let server_identity = db::load_server_identity(&pool).await?;
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
        mutation_gate: Arc::new(Mutex::new(())),
        tls_cert_sha256: tls.fingerprint_sha256.clone(),
        device_presence: Default::default(),
    });

    for instance in super::suwayomi_process::attach_owned_instances() {
        tracing::info!(
            profile = instance.profile_key,
            pid = instance.java_pid,
            endpoint = instance.server_url,
            root = %instance.root_dir.display(),
            "attached Core lifecycle to existing owned Suwayomi"
        );
    }
    if config.ownership_mode == SyncdOwnershipMode::PersistentAttached {
        let desired_stores = desired_extension_stores();
        if !desired_stores.is_empty() {
            match super::extension_store_seed::ensure_extension_stores(
                &super::extension_store_seed::active_profile_root(),
                &desired_stores,
            ) {
                Ok(stores) => {
                    tracing::info!(count = stores.len(), "operator extension stores reconciled");
                }
                Err(error) => {
                    tracing::warn!(error = %error, "failed to apply operator extension stores");
                }
            }
        }
    }
    let (shutdown, shutdown_receiver) = ShutdownCoordinator::channel();
    spawn_gc_task(state.clone(), shutdown.subscribe());
    spawn_wal_checkpoint_task(state.clone(), shutdown.subscribe());
    super::v4::suwayomi::spawn_projection(state.clone(), shutdown.subscribe());
    super::suwayomi_tracking_mirror::spawn_tracking_mirror_task(
        state.clone(),
        shutdown.subscribe(),
    );
    spawn_parent_watchdog(state.clone(), shutdown.clone());
    spawn_discovery_provider_task(state.clone(), shutdown.subscribe());
    let router = build_router(state.clone(), shutdown.clone());

    tracing::info!(
        bind = %config.bind_addr,
        advertised_base_url = %advertised_resolution.selected.base_url(),
        advertised_policy = advertised_resolution.policy_name,
        effective_discovery_policy = %config.effective_discovery_policy.as_str(),
        tls_cert_sha256 = %state.tls_cert_sha256,
        "epigraph-syncd starting"
    );

    let _runtime_manifest_lease = {
        let executable =
            std::env::current_exe().context("failed to resolve epigraph-syncd executable path")?;
        let executable = std::fs::canonicalize(&executable).unwrap_or(executable);
        let manifest = SyncdRuntimeManifest::new(
            std::process::id(),
            &server_identity.server_id,
            config.bind_addr.port(),
            &tls.fingerprint_sha256,
            executable.to_string_lossy().into_owned(),
        );
        Some(
            RuntimeManifestLease::publish(&config.data_dir, &manifest)
                .context("failed to publish syncd runtime manifest")?,
        )
    };

    // Bind before starting anything capable of spawning a JVM.
    let listener = super::listener::bind_core_listener(config.bind_addr)
        .context("Core listener bind failed")?;
    listener.set_nonblocking(true)?;
    if config.ownership_mode == SyncdOwnershipMode::PersistentAttached {
        super::suwayomi_process::start_headless_supervisor(shutdown.subscribe());
    }
    let server_handle = axum_server::Handle::new();
    let shutdown_task = spawn_shutdown_task(
        state.clone(),
        shutdown_receiver,
        shutdown.clone(),
        server_handle.clone(),
    );
    let serve_result = axum_server::from_tcp_rustls(listener, tls.rustls_config)
        .handle(server_handle)
        .serve(router.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .context("epigraph-syncd failed while serving");

    shutdown_task.abort();
    stop_discovery_provider(&state).await;
    state.pool.close().await;
    serve_result
}

fn build_router(state: Arc<AppState>, shutdown: ShutdownCoordinator) -> Router {
    let protected = Router::new()
        .route("/v1/sync/status", get(status::get_sync_status))
        .route(
            "/v1/session",
            get(session::get_session).delete(session::delete_session),
        )
        .route(
            "/v1/local/shutdown",
            post(super::lifecycle::post_local_shutdown),
        )
        .route(
            "/v1/local/suwayomi-maintenance",
            post(super::lifecycle::post_local_suwayomi_maintenance),
        )
        .route(
            "/v1/assets/:sha256",
            get(assets::get_asset)
                .head(assets::head_asset)
                .put(assets::put_asset),
        )
        .route(
            "/v1/suwayomi/*path",
            get(suwayomi_proxy::get_or_head)
                .head(suwayomi_proxy::get_or_head)
                .post(suwayomi_proxy::post_graphql),
        )
        .route("/v1/suwayomi/catalog", get(suwayomi_catalog::get_catalog))
        .route(
            "/v1/suwayomi/extensions",
            get(suwayomi_extensions::get_extensions),
        )
        .route(
            "/v1/suwayomi/commands",
            post(suwayomi_commands::post_command),
        )
        .route("/v1/suwayomi/content", post(suwayomi_content::post_content))
        .route(
            "/v1/tracker-credentials",
            get(tracker_credentials::get_tracker_credentials),
        )
        .route(
            "/v1/tracker-credentials/:tracker_key",
            put(tracker_credentials::put_tracker_credential)
                .delete(tracker_credentials::delete_tracker_credential),
        )
        .layer(Extension(shutdown.clone()))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_authenticated_session,
        ));

    let v4_runtime = Arc::new(super::v4::V4Runtime::new());
    let v4_router =
        super::v4::build_v4_router(state.clone(), v4_runtime.clone()).layer(Extension(shutdown));

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
            "/v1/pairing/pin/resolve",
            post(bootstrap::post_pairing_pin_resolve),
        )
        .route(
            "/v1/bootstrap/session/:session_id/live",
            get(pairing::get_pairing_status_live),
        )
        .route(
            "/v1/pairing/session/:session_id/decision",
            post(pairing::post_pairing_host_decision),
        )
        .route("/v1/pairing/devices", get(pairing::get_paired_devices))
        .route(
            "/v1/pairing/devices/scopes",
            post(pairing::post_paired_device_scopes),
        )
        .route(
            "/v1/pairing/devices/revoke",
            post(pairing::post_paired_device_revoke),
        )
        .route(
            "/v1/local/authority-token",
            post(local::post_local_authority_token),
        )
        .route(
            "/v1/local/progress-mirror",
            post(local::post_local_progress_mirror),
        )
        .route(
            "/v1/local/stored-chapter-pages",
            post(local::post_local_stored_chapter_pages),
        )
        .route(
            "/v1/local/sync-progress",
            get(local::get_local_sync_progress),
        )
        .route(
            "/v1/local/tracker-credentials/:tracker_key",
            put(local::put_local_tracker_credential).delete(local::delete_local_tracker_credential),
        )
        .route(
            "/v1/local/tracker-oauth/myanimelist/start",
            post(local::post_local_myanimelist_login_start),
        )
        .route(
            "/v1/local/tracker-oauth/myanimelist/complete",
            post(local::post_local_myanimelist_login_complete),
        )
        .route("/v1/pairing/claim", post(pairing::post_pairing_claim))
        .merge(protected)
        .merge(v4_router)
        .layer(Extension(v4_runtime))
        .layer(middleware::from_fn(super::compression::gzip_sync_bodies))
        .layer(middleware::map_response(
            super::middleware::stamp_server_time,
        ))
        .with_state(state.clone());

    if std::env::var("EPIGRAPH_SYNCD_ENABLE_AUDIT_ROUTES").as_deref() == Ok("1") {
        tracing::warn!("syncd audit routes enabled");
        router = router.merge(super::routes::audit::router(state));
    }

    router
}

#[cfg(test)]
pub fn build_router_for_tests(state: Arc<AppState>) -> Router {
    let (shutdown, _rx) = ShutdownCoordinator::channel();
    build_router(state, shutdown)
}

fn desired_extension_stores() -> Vec<String> {
    desired_extension_stores_from_env(
        std::env::var("EPIGRAPH_SYNCD_EXTENSION_STORES")
            .ok()
            .as_deref(),
    )
}

fn desired_extension_stores_from_env(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn spawn_gc_task(
    state: Arc<AppState>,
    mut shutdown: tokio::sync::watch::Receiver<Option<ShutdownRequest>>,
) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60 * 60));
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let now = db::now_ms();
                    if let Err(error) = db::prune_expired_rows(&state.pool, now).await {
                        tracing::warn!(error = %error, "failed to prune expired syncd rows");
                    }
                    if let Err(error) = super::v4::db::prune_v4_expired(&state.pool, now).await {
                        tracing::warn!(error = %error, "failed to prune expired syncd v4 rows");
                    }
                }
                changed = shutdown.changed() => {
                    if changed.is_err() || shutdown.borrow().is_some() {
                        break;
                    }
                }
            }
        }
    });
}

/// Checkpoints the WAL off the request path, so commits never wait on SQLite's automatic
/// checkpoint during a large sync. A checkpoint syncs the database file to disk, which slows the
/// commits running beside it, so it waits for a bulk ingest to pause.
fn spawn_wal_checkpoint_task(
    state: Arc<AppState>,
    mut shutdown: tokio::sync::watch::Receiver<Option<ShutdownRequest>>,
) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(2));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    if let Err(error) = db::checkpoint_wal(&state.pool).await {
                        tracing::debug!(error = %error, "syncd WAL checkpoint failed");
                    }
                }
                changed = shutdown.changed() => {
                    if changed.is_err() || shutdown.borrow().is_some() {
                        break;
                    }
                }
            }
        }
    });
}

fn spawn_parent_watchdog(state: Arc<AppState>, shutdown: ShutdownCoordinator) {
    let Some(parent_pid) = watchdog_parent_pid(&state.config) else {
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
                tracing::warn!(
                    parent_pid,
                    "syncd parent process missing; shutting down sidecar"
                );
                shutdown.request(ShutdownRequest {
                    run_id: super::runtime_manifest::current_run_id().into(),
                    nonce: uuid::Uuid::new_v4().to_string(),
                    server_id: String::new(),
                    expected_pid: std::process::id(),
                    reason: ShutdownReason::ParentExited,
                    unless_devices_connected: false,
                });
                break;
            }
        }
    });
}

fn spawn_shutdown_task(
    state: Arc<AppState>,
    mut receiver: tokio::sync::watch::Receiver<Option<ShutdownRequest>>,
    coordinator: ShutdownCoordinator,
    server_handle: axum_server::Handle,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let request = tokio::select! {
            request = wait_for_shutdown_request(&mut receiver) => request,
            signal = tokio::signal::ctrl_c() => {
                if let Err(error) = signal {
                    tracing::warn!(error = %error, "failed to listen for Core shutdown signal");
                }
                let request = ShutdownRequest {
                    run_id: super::runtime_manifest::current_run_id().into(),
                    nonce: uuid::Uuid::new_v4().to_string(),
                    server_id: String::new(),
                    expected_pid: std::process::id(),
                    reason: ShutdownReason::OsSignal,
                    unless_devices_connected: false,
                };
                coordinator.request(request.clone());
                Some(request)
            }
        };
        let Some(request) = request else {
            return;
        };

        tracing::info!(reason = ?request.reason, "graceful Core shutdown requested");
        if state.config.ownership_mode == SyncdOwnershipMode::PersistentAttached {
            if let Err(error) = super::suwayomi_process::prepare_shutdown().await {
                tracing::error!(%error, "Core shutdown refused; ownership state retained");
                return;
            }
        }
        tokio::time::sleep(response_delay()).await;
        stop_discovery_provider(&state).await;
        server_handle.graceful_shutdown(Some(std::time::Duration::from_secs(15)));
    })
}

async fn stop_discovery_provider(state: &Arc<AppState>) {
    let stopping = state
        .discovery_provider_manager
        .stopping_status(&state.config, &state.advertised_endpoint_resolver);
    *state.discovery_provider_state.write().await = stopping;
    let runtime = state.discovery_provider_runtime.lock().await.take();
    if let Some(runtime) = runtime {
        if let Err(error) = runtime.shutdown(std::time::Duration::from_secs(5)).await {
            tracing::warn!(error = %error, "failed to confirm mDNS shutdown");
        }
    }
}

fn watchdog_parent_pid(config: &SyncdConfig) -> Option<u32> {
    if config.ownership_mode == SyncdOwnershipMode::EphemeralOwned {
        config.parent_pid
    } else {
        None
    }
}

fn spawn_discovery_provider_task(
    state: Arc<AppState>,
    mut shutdown: tokio::sync::watch::Receiver<Option<ShutdownRequest>>,
) {
    tokio::spawn(async move {
        tokio::select! {
            _ = start_discovery_provider(state.clone()) => {}
            _ = wait_for_shutdown_request(&mut shutdown) => {
                stop_discovery_provider(&state).await;
            }
        }
    });
}

fn install_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    // A persistent Core outlives the desktop that reads its stdout and stderr. Once that pipe is
    // gone, reporting a failed log write would itself print to the broken stderr, and `eprintln!`
    // panics there: the task that logged dies (the shutdown task, so the Core never exits), or the
    // whole process aborts in release builds. Lost log lines are dropped instead.
    let _ = tracing_subscriber::fmt()
        .log_internal_errors(false)
        .with_env_filter(filter)
        .json()
        .with_current_span(false)
        .with_span_list(false)
        .try_init();
}

#[cfg(test)]
pub fn build_test_router(state: Arc<AppState>) -> Router {
    let (shutdown, _) = ShutdownCoordinator::channel();
    build_router(state, shutdown)
}

#[cfg(test)]
pub fn build_test_router_with_shutdown(
    state: Arc<AppState>,
    shutdown: ShutdownCoordinator,
) -> Router {
    build_router(state, shutdown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn does_not_seed_an_extension_store_without_explicit_operator_configuration() {
        assert!(desired_extension_stores_from_env(None).is_empty());
    }
    use crate::syncd::db::{
        connect, ensure_test_token, upsert_server_identity,
    };
    use crate::syncd::middleware::{CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER};
    use crate::syncd::test_dir::tempdir;
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use tower::ServiceExt;

    fn token_hash(raw: &str) -> String {
        let digest = Sha256::digest(raw.as_bytes());
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn parent_watchdog_only_applies_to_ephemeral_owned_processes() {
        let temp = tempdir().unwrap();
        let mut config = SyncdConfig::for_test(temp.path().to_path_buf());
        config.parent_pid = Some(42);

        config.ownership_mode = SyncdOwnershipMode::PersistentAttached;
        assert_eq!(watchdog_parent_pid(&config), None);

        config.ownership_mode = SyncdOwnershipMode::EphemeralOwned;
        assert_eq!(watchdog_parent_pid(&config), Some(42));
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
            mutation_gate: Arc::new(Mutex::new(())),
            tls_cert_sha256: "fingerprint".to_string(),
            device_presence: Default::default(),
        });
        (temp, state)
    }

    async fn request_json(
        app: &Router,
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(CLIENT_VERSION_HEADER, "0.1.0")
            .header(
                CLIENT_PROTOCOL_HEADER,
                if uri.starts_with("/v4/") { "4" } else { "1" },
            )
            .extension(axum::extract::ConnectInfo(SocketAddr::from((
                [127, 0, 0, 1],
                4777,
            ))));
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let body = match body {
            Some(body) => {
                builder = builder.header("content-type", "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = app
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, payload)
    }

    #[tokio::test]
    async fn pairing_pin_resolves_the_open_bootstrap_session_only() {
        let (_temp, state) = build_state_for_http().await;
        let app = build_test_router(state.clone());
        let (status, created) = request_json(
            &app,
            Method::POST,
            "/v1/bootstrap/session",
            None,
            Some(serde_json::json!({ "profileId": "main" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let code = created["pairingCode"].as_str().unwrap();
        let pin = crate::syncd::pairing_pin::pairing_pin(code);

        let (status, resolved) = request_json(
            &app,
            Method::POST,
            "/v1/pairing/pin/resolve",
            None,
            Some(serde_json::json!({ "pin": format!("{} {}", &pin[..3], &pin[3..]) })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(resolved["pairingSessionId"], created["pairingSessionId"]);
        assert_eq!(resolved["tlsCertSha256"], "fingerprint");

        let wrong = if pin == "000000" { "000001" } else { "000000" };
        let (status, body) = request_json(
            &app,
            Method::POST,
            "/v1/pairing/pin/resolve",
            None,
            Some(serde_json::json!({ "pin": wrong })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "PAIRING_PIN_NOT_FOUND");

        let (status, _) = request_json(
            &app,
            Method::POST,
            "/v1/pairing/pin/resolve",
            None,
            Some(serde_json::json!({ "pin": "12ab56" })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        crate::syncd::db::expire_open_bootstrap_sessions(&state.pool)
            .await
            .unwrap();
        let (status, _) = request_json(
            &app,
            Method::POST,
            "/v1/pairing/pin/resolve",
            None,
            Some(serde_json::json!({ "pin": pin })),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "an expired session no longer resolves"
        );
    }

    #[tokio::test]
    async fn capabilities_returns_200_for_compatible_client() {
        let (_temp, state) = build_state_for_http().await;
        let app = build_test_router(state.clone());

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
        let server_time: i64 = response.headers()[crate::syncd::middleware::SERVER_TIME_HEADER]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!((server_time - db::now_ms()).abs() < 60_000);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["supportsSseReplay"], true);
        assert_eq!(payload["supportsSnapshot"], true);
        assert_eq!(payload["supportsAssets"], true);
        assert_eq!(payload["supportsNovelChapterAssets"], true);
        assert_eq!(payload["supportsNovelPluginSync"], true);
        assert_eq!(payload["supportsSuwayomiCatalog"], true);
        assert_eq!(payload["supportsSuwayomiContent"], true);
        assert_eq!(payload["supportsSuwayomiExtensionInventory"], true);
        assert_eq!(payload["comicAuthorityMode"], "suwayomi-confirmed-v1");
        assert_eq!(payload["supportsConfirmedSuwayomiCommandsV1"], true);
        assert_eq!(payload["supportsSyncStatusV1"], true);
        assert_eq!(payload["supportsSessionEndV1"], true);
        assert_eq!(payload["supportsPagedSnapshotV1"], true);
        assert_eq!(payload["supportsGzipRequestBodiesV1"], true);
        assert_eq!(payload["supportsSkipOwnEchoesV1"], true);
        assert_eq!(payload["supportsHeldVersionsV1"], true);
        assert_eq!(payload["supportsComicDeleteProjectionWithoutRecord"], true);
        assert_eq!(payload["supportsSuwayomiCategoryCreate"], true);
        assert_eq!(payload["supportsSuwayomiExtensionInstall"], true);
        assert_eq!(payload["snapshotSchemaVersion"], 3);
        assert_eq!(
            payload["supportsTrackerCredentialsV1"],
            crate::syncd::tracker_credentials::is_supported()
        );
        let entity_types = payload["snapshotEntityTypes"].as_array().unwrap();
        assert_eq!(entity_types.len(), 29);
        assert!(entity_types.iter().any(|value| value == "comic.tracking"));
        assert!(entity_types
            .iter()
            .any(|value| value == "comic.source_preference"));
        assert!(entity_types.iter().any(|value| value == "novel.tracking"));
        assert!(entity_types
            .iter()
            .any(|value| value == "novel.plugin_setting"));
        assert!(entity_types
            .iter()
            .any(|value| value == "novel.chapter_asset"));
        assert!(entity_types.iter().any(|value| value == "novel.category"));
        assert!(entity_types.iter().any(|value| value == "novel.repository"));
        assert!(entity_types.iter().any(|value| value == "novel.plugin"));
        assert!(entity_types
            .iter()
            .any(|value| value == "novel.category_assignment"));
        assert!(entity_types.iter().any(|value| value == "comic.history"));
        assert!(entity_types.iter().any(|value| value == "comic.entry"));
        assert!(entity_types.iter().any(|value| value == "comic.category"));
        assert!(entity_types
            .iter()
            .any(|value| value == "comic.category_assignment"));
        assert!(entity_types
            .iter()
            .any(|value| value == "comic.chapter_state"));
        assert!(entity_types
            .iter()
            .any(|value| value == "comic.page_bookmark"));
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
    async fn a_device_ending_its_session_is_revoked_and_unlisted() {
        let (_temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("phone-token"),
            &["comics:profile:main"],
        )
        .await
        .unwrap();
        ensure_test_token(
            &state.pool,
            "device-b",
            "main",
            &token_hash("other-token"),
            &["comics:profile:main"],
        )
        .await
        .unwrap();
        let app = build_test_router(state.clone());

        let (status, _) = request_json(
            &app,
            Method::DELETE,
            "/v1/session",
            Some("phone-token"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (status, _) =
            request_json(&app, Method::GET, "/v1/session", Some("phone-token"), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) =
            request_json(&app, Method::GET, "/v1/session", Some("other-token"), None).await;
        assert_eq!(status, StatusCode::OK);
        let listed = crate::syncd::db::list_paired_devices(&state.pool)
            .await
            .unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|device| device.device_id.as_str())
                .collect::<Vec<_>>(),
            vec!["device-b"]
        );
    }

    #[tokio::test]
    async fn snapshot_and_concurrent_commit_converge_through_replay() {
        let (_temp, state) = build_state_for_http().await;
        let mut writer = state.pool.begin().await.unwrap();
        let now_ms = db::now_ms();
        let replay_until_ms = now_ms + state.config.retention_window.as_millis() as i64;
        let insert = sqlx::query(
            r#"
            INSERT INTO change_log (
                scope_id, profile_id, entity_type, entity_id, op, lamport,
                changed_by_device_id, patch_json, replay_until_ms, applied_at_ms
            ) VALUES (?, NULL, ?, ?, 'merge', ?, ?, ?, ?, ?)
            "#,
        )
        .bind("books:global")
        .bind("book.category")
        .bind("category-racing")
        .bind(1_i64)
        .bind("device-a")
        .bind(
            serde_json::json!({
                "categoryId": "category-racing",
                "name": "Racing",
                "order": 0,
                "recordLamport": 1
            })
            .to_string(),
        )
        .bind(replay_until_ms)
        .bind(now_ms)
        .execute(&mut *writer)
        .await
        .unwrap();
        let committed_version = insert.last_insert_rowid();
        sqlx::query(
            r#"
            INSERT INTO book_categories (
                scope_id, category_id, name, sort_order, record_updated_at_ms,
                record_updated_by_device_id, record_lamport, record_server_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind("books:global")
        .bind("category-racing")
        .bind("Racing")
        .bind(0_i64)
        .bind(now_ms)
        .bind("device-a")
        .bind(1_i64)
        .bind(committed_version)
        .execute(&mut *writer)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE server_runtime SET current_server_version = ?, updated_at_ms = ? WHERE singleton_id = 1",
        )
        .bind(committed_version)
        .bind(now_ms)
        .execute(&mut *writer)
        .await
        .unwrap();

        let pool = state.pool.clone();
        let snapshot = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            tokio::spawn(async move { db::load_scope_snapshot(&pool, "books:global").await }),
        )
        .await
        .expect("snapshot read must not wait for an uncommitted WAL writer")
        .unwrap()
        .unwrap();
        assert_eq!(snapshot.snapshot_version, 0);
        assert!(snapshot.entities.is_empty());

        writer.commit().await.unwrap();
        let replay =
            db::fetch_replay_changes(&state.pool, snapshot.snapshot_version, committed_version)
                .await
                .unwrap();
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].server_version, committed_version);
        assert_eq!(replay[0].entity_id, "category-racing");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn tracker_credentials_use_per_key_cas_and_stay_out_of_sync_feeds() {
        let (temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("secret-token"),
            &["comics:profile:main"],
        )
        .await
        .unwrap();
        let app = build_test_router(state);
        let token_json = r#"{"access_token":"tr4ck3r-secret","token_type":"Bearer"}"#;

        let (status, _) =
            request_json(&app, Method::GET, "/v1/tracker-credentials", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (status, payload) = request_json(
            &app,
            Method::GET,
            "/v1/tracker-credentials",
            Some("secret-token"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["schemaVersion"], 1);
        assert_eq!(payload["credentials"], serde_json::json!([]));

        let write = |base: i64| {
            serde_json::json!({
                "baseRevision": base,
                "deviceId": "mobile-audit-id",
                "username": "4242",
                "password": "tr4ck3r-secret",
                "token": token_json,
            })
        };
        let (status, payload) = request_json(
            &app,
            Method::PUT,
            "/v1/tracker-credentials/anilist",
            Some("secret-token"),
            Some(write(0)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{payload}");
        assert_eq!(payload["trackerKey"], "anilist");
        assert_eq!(payload["revision"], 1);
        assert_eq!(payload["deleted"], false);
        assert_eq!(payload["token"], token_json);
        assert!(payload.get("deviceId").is_none());
        assert!(!payload.to_string().contains("mobile-audit-id"));

        // A stale base is a 409 and writes nothing.
        let (status, payload) = request_json(
            &app,
            Method::PUT,
            "/v1/tracker-credentials/anilist",
            Some("secret-token"),
            Some(write(0)),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(!payload.to_string().contains("tr4ck3r-secret"));

        // Invalid key, oversized value and malformed bodies are 400.
        let (status, _) = request_json(
            &app,
            Method::PUT,
            "/v1/tracker-credentials/AniList",
            Some("secret-token"),
            Some(write(0)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let mut oversized = write(1);
        oversized["token"] = Value::String("x".repeat(8 * 1024 + 1));
        let (status, _) = request_json(
            &app,
            Method::PUT,
            "/v1/tracker-credentials/anilist",
            Some("secret-token"),
            Some(oversized),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = request_json(
            &app,
            Method::PUT,
            "/v1/tracker-credentials/anilist",
            Some("secret-token"),
            Some(serde_json::json!({ "username": "x" })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = request_json(
            &app,
            Method::PUT,
            "/v1/tracker-credentials/anilist",
            Some("secret-token"),
            Some(serde_json::json!({ "baseRevision": -1 })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // Delete tombstones at base+1; the tombstone keeps its revision and a stale delete is 409.
        let (status, payload) = request_json(
            &app,
            Method::DELETE,
            "/v1/tracker-credentials/anilist",
            Some("secret-token"),
            Some(serde_json::json!({ "baseRevision": 1, "deviceId": "mobile-audit-id" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{payload}");
        assert_eq!(payload["revision"], 2);
        assert_eq!(payload["deleted"], true);
        assert_eq!(payload["token"], "");
        let (status, _) = request_json(
            &app,
            Method::DELETE,
            "/v1/tracker-credentials/anilist",
            Some("secret-token"),
            Some(serde_json::json!({ "baseRevision": 1 })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, payload) = request_json(
            &app,
            Method::GET,
            "/v1/tracker-credentials",
            Some("secret-token"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["credentials"][0]["revision"], 2);
        assert_eq!(payload["credentials"][0]["deleted"], true);
        assert!(!payload.to_string().contains("mobile-audit-id"));

        // Re-login on top of the tombstone continues the revision sequence.
        let (status, payload) = request_json(
            &app,
            Method::PUT,
            "/v1/tracker-credentials/anilist",
            Some("secret-token"),
            Some(write(2)),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["revision"], 3);

        // Credentials never reach the snapshot, the change feed or the replica database.
        let (status, snapshot) = request_json(
            &app,
            Method::GET,
            "/v4/snapshot",
            Some("secret-token"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!snapshot.to_string().contains("tr4ck3r-secret"));
        let (status, changes) = request_json(
            &app,
            Method::GET,
            "/v4/changes?sinceSeq=0",
            Some("secret-token"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!changes.to_string().contains("tr4ck3r-secret"));
        for entry in std::fs::read_dir(temp.path()).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                let bytes = std::fs::read(&path).unwrap();
                assert!(
                    !String::from_utf8_lossy(&bytes).contains("tr4ck3r-secret"),
                    "plaintext credential found in {}",
                    path.display()
                );
            }
        }
    }
}
