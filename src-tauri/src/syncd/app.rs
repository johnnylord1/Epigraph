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
    assets, bootstrap, capabilities, discovery, events, health, local, mutations, pairing,
    portable_manifest, session, snapshot, status, suwayomi_catalog, suwayomi_commands,
    suwayomi_content, suwayomi_extensions, suwayomi_proxy, tracker_credentials,
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
    super::suwayomi_projection::spawn_projection_task(state.clone(), shutdown.subscribe());
    super::suwayomi_hydration::spawn_hydration_task(state.clone(), shutdown.subscribe());
    super::suwayomi_progress_mirror::spawn_progress_mirror_task(
        state.clone(),
        shutdown.subscribe(),
    );
    super::suwayomi_progress_mirror::spawn_catalog_refresh_task(
        state.clone(),
        shutdown.subscribe(),
    );
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
    let listener = super::listener::bind_core_listener(config.bind_addr).context("Core listener bind failed")?;
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
        .route("/v1/events", get(events::get_events))
        .route("/v1/changes", get(events::get_changes))
        .route("/v1/mutations", post(mutations::post_mutations))
        .route("/v1/snapshot", get(snapshot::get_snapshot))
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
            "/v1/portable/manifest",
            get(portable_manifest::get_portable_manifest),
        )
        .route(
            "/v1/portable/novel-manifest",
            get(portable_manifest::get_portable_novel_manifest),
        )
        .route(
            "/v1/tracker-credentials",
            get(tracker_credentials::get_tracker_credentials),
        )
        .route(
            "/v1/tracker-credentials/:tracker_key",
            put(tracker_credentials::put_tracker_credential)
                .delete(tracker_credentials::delete_tracker_credential),
        )
        .layer(Extension(shutdown))
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
            "/v1/local/sync-progress",
            get(local::get_local_sync_progress),
        )
        .route(
            "/v1/local/tracker-credentials/:tracker_key",
            put(local::put_local_tracker_credential)
                .delete(local::delete_local_tracker_credential),
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
        .with_state(state.clone());

    if std::env::var("EPIGRAPH_SYNCD_ENABLE_AUDIT_ROUTES").as_deref() == Ok("1") {
        tracing::warn!("syncd audit routes enabled");
        router = router.merge(super::routes::audit::router(state));
    }

    router
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
                    if let Err(error) = db::prune_expired_rows(&state.pool, db::now_ms()).await {
                        tracing::warn!(error = %error, "failed to prune expired syncd rows");
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
        append_change_log_entry, connect, ensure_test_token, upsert_server_identity,
    };
    use crate::syncd::middleware::{CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER};
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use tempfile::tempdir;
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
            .header(CLIENT_PROTOCOL_HEADER, "1");
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
        assert_eq!(status, StatusCode::NOT_FOUND, "an expired session no longer resolves");
    }

    async fn request_bytes(
        app: &Router,
        method: Method,
        uri: &str,
        token: &str,
        bytes: Vec<u8>,
    ) -> StatusCode {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header(CLIENT_VERSION_HEADER, "0.1.0")
                    .header(CLIENT_PROTOCOL_HEADER, "1")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-length", bytes.len().to_string())
                    .body(Body::from(bytes))
                    .unwrap(),
            )
            .await
            .unwrap();
        response.status()
    }

    fn complete_book_mutations() -> Value {
        serde_json::json!({
            "requestId": "seed-books",
            "mutations": [
                {
                    "entityType": "book.entry",
                    "clientMutationId": "book-entry-1",
                    "scopeId": "books:global",
                    "entityId": "book-1",
                    "op": "merge",
                    "lamport": 1,
                    "patch": {
                        "assetFingerprint": null,
                        "mimeType": null,
                        "byteSize": null,
                        "coverAssetSha256": null,
                        "title": "Book One",
                        "author": "Epigraph",
                        "description": null,
                        "subtype": "epub",
                        "pageCount": null,
                        "tocCount": 1,
                        "spineCount": 1,
                        "sectionCount": 1,
                        "sectionsSummaryJson": null,
                        "hasCover": false,
                        "createdAtMs": 1000,
                        "bookUpdatedAtMs": 1000
                    }
                },
                {
                    "entityType": "book.category",
                    "clientMutationId": "book-category-1",
                    "scopeId": "books:global",
                    "entityId": "category-1",
                    "op": "merge",
                    "lamport": 1,
                    "patch": {"categoryId": "category-1", "name": "Reading", "order": 0}
                },
                {
                    "entityType": "book.category_assignment",
                    "clientMutationId": "book-assignment-1",
                    "scopeId": "books:global",
                    "entityId": "book-1",
                    "op": "merge",
                    "lamport": 1,
                    "patch": {"bookId": "book-1", "categoryIds": ["category-1"]}
                },
                {
                    "entityType": "book.library_ui",
                    "clientMutationId": "book-ui-1",
                    "scopeId": "books:global",
                    "entityId": "default",
                    "op": "merge",
                    "lamport": 1,
                    "patch": {
                        "activeCategoryId": "category-1",
                        "typeFilter": "all",
                        "statusFilter": "all",
                        "search": "",
                        "sortMode": "recentlyAdded",
                        "sortDir": "desc"
                    }
                },
                {
                    "entityType": "book.progress",
                    "clientMutationId": "book-progress-1",
                    "scopeId": "books:global",
                    "entityId": "book-1",
                    "op": "merge",
                    "lamport": 1,
                    "patch": {
                        "renderer": "epub",
                        "location": "epubcfi(/6/2)",
                        "href": "chapter-1.xhtml",
                        "progressPercent": 0.25,
                        "lastReadAtMs": 2000,
                        "pageIndex": null,
                        "totalPages": null,
                        "sectionLabel": "Chapter 1"
                    }
                },
                {
                    "entityType": "book.bookmark",
                    "clientMutationId": "book-bookmark-1",
                    "scopeId": "books:global",
                    "entityId": "bookmark-1",
                    "op": "merge",
                    "lamport": 1,
                    "patch": {
                        "bookId": "book-1",
                        "location": "epubcfi(/6/2)",
                        "href": "chapter-1.xhtml",
                        "pageIndex": null,
                        "progressPercent": 0.25,
                        "label": "Start",
                        "note": null,
                        "createdAtMs": 2000,
                        "updatedAtMs": 2000,
                        "savedAtMs": 2000
                    }
                },
                {
                    "entityType": "book.history",
                    "clientMutationId": "book-history-1",
                    "scopeId": "books:global",
                    "entityId": "history-1",
                    "op": "merge",
                    "lamport": 1,
                    "patch": {
                        "historyId": "history-1",
                        "bookId": "book-1",
                        "renderer": "epub",
                        "location": "epubcfi(/6/2)",
                        "href": "chapter-1.xhtml",
                        "pageIndex": null,
                        "progressPercent": 0.25,
                        "sectionLabel": "Chapter 1",
                        "readAtMs": 2000
                    }
                }
            ]
        })
    }

    fn complete_novel_mutations() -> Value {
        serde_json::json!({
            "requestId": "seed-novels",
            "mutations": [
                {
                    "entityType": "novel.entry",
                    "clientMutationId": "novel-entry-1",
                    "scopeId": "novels:profile:main",
                    "entityId": "novel-1",
                    "op": "merge",
                    "lamport": 1,
                    "patch": {
                        "identityKey": "repo:plugin:source:/novel-1",
                        "title": "Novel One",
                        "author": "Epigraph",
                        "description": null,
                        "coverUrl": "https://example.test/cover.jpg",
                        "path": "/novel-1",
                        "status": "ongoing",
                        "tags": ["fantasy"],
                        "source": {"pluginId": "plugin-1", "sourceId": "source-1"},
                        "addedAtMs": 1000,
                        "updatedAtMs": 1000
                    }
                },
                {
                    "entityType": "novel.chapter",
                    "clientMutationId": "novel-chapter-1",
                    "scopeId": "novels:profile:main",
                    "entityId": "chapter-1",
                    "op": "merge",
                    "lamport": 1,
                    "patch": {
                        "novelId": "novel-1",
                        "path": "/novel-1/chapter-1",
                        "title": "Chapter 1",
                        "chapterOrderKey": 1.0,
                        "releaseTimeMs": 1000,
                        "unread": false
                    }
                },
                {
                    "entityType": "novel.progress",
                    "clientMutationId": "novel-progress-1",
                    "scopeId": "novels:profile:main",
                    "entityId": "novel-1",
                    "op": "merge",
                    "lamport": 1,
                    "patch": {
                        "chapterId": "chapter-1",
                        "chapterTitle": "Chapter 1",
                        "chapterOrderKey": 1.0,
                        "progressPercent": 0.5,
                        "locator": "block-4:20",
                        "locatorSortKey": 4.2,
                        "updatedAtMs": 2000
                    }
                },
                {
                    "entityType": "novel.bookmark",
                    "clientMutationId": "novel-bookmark-1",
                    "scopeId": "novels:profile:main",
                    "entityId": "bookmark-1",
                    "op": "merge",
                    "lamport": 1,
                    "patch": {
                        "novelId": "novel-1",
                        "chapterId": "chapter-1",
                        "chapterTitle": "Chapter 1",
                        "chapterOrderKey": 1.0,
                        "locator": "block-4:20",
                        "locatorSortKey": 4.2,
                        "label": "Important",
                        "savedAtMs": 2000
                    }
                },
                {
                    "entityType": "novel.history",
                    "clientMutationId": "novel-history-1",
                    "scopeId": "novels:profile:main",
                    "entityId": "history-1",
                    "op": "merge",
                    "lamport": 1,
                    "patch": {
                        "novelId": "novel-1",
                        "chapterId": "chapter-1",
                        "chapterTitle": "Chapter 1",
                        "locator": "block-4:20",
                        "readAtMs": 2000
                    }
                },
                {
                    "entityType": "novel.classification",
                    "clientMutationId": "novel-classification-1",
                    "scopeId": "novels:profile:main",
                    "entityId": "plugin-1",
                    "op": "merge",
                    "lamport": 1,
                    "patch": {
                        "pluginId": "plugin-1",
                        "repositoryId": "official",
                        "repositoryUrl": "https://example.test/repository.json",
                        "lang": "en",
                        "version": "1.0.0",
                        "status": "compatible",
                        "notes": "Synthetic compatibility fixture",
                        "baselineStatus": null,
                        "baselineNotes": null,
                        "issuesJson": [],
                        "smokeJson": {"search": true, "chapter": true},
                        "filterKeys": [],
                        "pluginSettingsKeys": [],
                        "classifiedAtMs": 2000
                    }
                }
            ]
        })
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
        assert_eq!(payload["supportsComicDeleteProjectionWithoutRecord"], true);
        assert_eq!(payload["supportsSuwayomiCategoryCreate"], true);
        assert_eq!(payload["supportsSuwayomiExtensionInstall"], true);
        assert_eq!(payload["snapshotSchemaVersion"], 3);
        assert_eq!(
            payload["supportsTrackerCredentialsV1"],
            crate::syncd::tracker_credentials::is_supported()
        );
        let entity_types = payload["snapshotEntityTypes"].as_array().unwrap();
        assert_eq!(entity_types.len(), 27);
        assert!(entity_types.iter().any(|value| value == "comic.tracking"));
        assert!(entity_types.iter().any(|value| value == "novel.tracking"));
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

        let (status, _) =
            request_json(&app, Method::DELETE, "/v1/session", Some("phone-token"), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (status, _) =
            request_json(&app, Method::GET, "/v1/session", Some("phone-token"), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) =
            request_json(&app, Method::GET, "/v1/session", Some("other-token"), None).await;
        assert_eq!(status, StatusCode::OK);
        let listed = crate::syncd::db::list_paired_devices(&state.pool).await.unwrap();
        assert_eq!(
            listed.iter().map(|device| device.device_id.as_str()).collect::<Vec<_>>(),
            vec!["device-b"]
        );
    }

    #[tokio::test]
    async fn snapshot_rejects_scope_not_granted_to_token() {
        let (_temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("novels-only-token"),
            &["novels:profile:main"],
        )
        .await
        .unwrap();
        let app = build_test_router(state);

        let (status, _) = request_json(
            &app,
            Method::GET,
            "/v1/snapshot?scopeId=books%3Aglobal",
            Some("novels-only-token"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn sync_status_reports_authoritative_projection_readiness() {
        let (_temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("comic-token"),
            &["comics:profile:main"],
        )
        .await
        .unwrap();
        let app = build_test_router(state.clone());

        let (status, payload) = request_json(
            &app,
            Method::GET,
            "/v1/sync/status?scopeId=comics%3Aprofile%3Amain",
            Some("comic-token"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["scopeId"], "comics:profile:main");
        assert_eq!(payload["comicAuthorityMode"], "suwayomi-confirmed-v1");
        assert_eq!(payload["suwayomiProjectionPending"], 0);
        assert_eq!(payload["suwayomiProjectionBlocked"], 0);
        assert_eq!(payload["suwayomiProjectionInFlight"], 0);
        assert_eq!(payload["suwayomiCatalogProjectionPending"], 0);
        assert_eq!(payload["ready"], true);

        // Chapter progress is pending work but leaves the library catalog unchanged.
        sqlx::query(
            r#"
            INSERT INTO suwayomi_projection_outbox (
              operation_id, profile_id, operation_name, variables_json,
              entity_type, entity_id, source_server_version, status,
              attempt_count, next_attempt_at_ms, created_at_ms, updated_at_ms
            ) VALUES (?, ?, 'UpdateChaptersProgress', ?, 'comic.chapter_state', ?, 1, 'pending', 0, ?, ?, ?)
            "#,
        )
        .bind("status-test-progress")
        .bind("main")
        .bind(r#"{"ids":[11],"patch":{"isRead":true}}"#)
        .bind("comic.chapter_state::test")
        .bind(db::now_ms())
        .bind(db::now_ms())
        .bind(db::now_ms())
        .execute(&state.pool)
        .await
        .unwrap();
        let (status, payload) = request_json(
            &app,
            Method::GET,
            "/v1/sync/status?scopeId=comics%3Aprofile%3Amain",
            Some("comic-token"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["suwayomiProjectionPending"], 1);
        assert_eq!(payload["suwayomiCatalogProjectionPending"], 0);
        assert_eq!(payload["ready"], false);

        sqlx::query(
            r#"
            INSERT INTO suwayomi_projection_outbox (
              operation_id, profile_id, operation_name, variables_json,
              entity_type, entity_id, source_server_version, status,
              attempt_count, next_attempt_at_ms, created_at_ms, updated_at_ms
            ) VALUES (?, ?, 'UpdateManga', ?, 'comic.entry', ?, 1, 'pending', 0, ?, ?, ?)
            "#,
        )
        .bind("status-test-operation")
        .bind("main")
        .bind(r#"{"id":7,"inLibrary":true}"#)
        .bind("comic:test")
        .bind(db::now_ms())
        .bind(db::now_ms())
        .bind(db::now_ms())
        .execute(&state.pool)
        .await
        .unwrap();

        let (status, payload) = request_json(
            &app,
            Method::GET,
            "/v1/sync/status?scopeId=comics%3Aprofile%3Amain",
            Some("comic-token"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["suwayomiProjectionPending"], 2);
        assert_eq!(payload["suwayomiCatalogProjectionPending"], 1);
        assert_eq!(payload["ready"], false);
    }

    #[tokio::test]
    async fn snapshot_returns_empty_authoritative_scope() {
        let (_temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("secret-token"),
            &["books:global"],
        )
        .await
        .unwrap();
        let app = build_test_router(state);

        let (status, payload) = request_json(
            &app,
            Method::GET,
            "/v1/snapshot?scopeId=books%3Aglobal",
            Some("secret-token"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["schemaVersion"], 3);
        assert_eq!(payload["complete"], true);
        assert_eq!(payload["entityCount"], 0);
        assert_eq!(payload["tombstoneCount"], 0);
        assert_eq!(payload["snapshotId"].as_str().unwrap().len(), 64);
        assert_eq!(payload["scopeId"], "books:global");
        assert_eq!(payload["snapshotVersion"], 0);
        assert_eq!(payload["minReplayableServerVersion"], 0);
        assert_eq!(payload["entities"], serde_json::json!([]));
        assert_eq!(payload["tombstones"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn snapshot_returns_every_supported_book_entity() {
        let (_temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("secret-token"),
            &["books:global"],
        )
        .await
        .unwrap();
        let app = build_test_router(state);

        let (mutation_status, mutation_payload) = request_json(
            &app,
            Method::POST,
            "/v1/mutations",
            Some("secret-token"),
            Some(complete_book_mutations()),
        )
        .await;
        assert_eq!(mutation_status, StatusCode::OK);
        assert!(
            mutation_payload["results"]
                .as_array()
                .unwrap()
                .iter()
                .all(|result| result["status"] == "applied"),
            "{mutation_payload}"
        );

        let (status, payload) = request_json(
            &app,
            Method::GET,
            "/v1/snapshot?scopeId=books%3Aglobal",
            Some("secret-token"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["snapshotVersion"], 7);
        assert_eq!(payload["complete"], true);
        assert_eq!(payload["entityCount"], 7);
        assert_eq!(payload["tombstoneCount"], 0);
        let entities = payload["entities"].as_array().unwrap();
        let entity_types = entities
            .iter()
            .map(|entity| entity["entityType"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            entity_types,
            vec![
                "book.entry",
                "book.category",
                "book.category_assignment",
                "book.library_ui",
                "book.progress",
                "book.bookmark",
                "book.history",
            ]
        );
        assert_eq!(entities[0]["record"]["title"], "Book One");
        assert!(entities.iter().all(|entity| entity["serverVersion"]
            .as_i64()
            .is_some_and(|version| version <= 7)));
    }

    #[tokio::test]
    async fn book_history_delete_replays_and_is_snapshotted_as_tombstone() {
        let (_temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("secret-token"),
            &["books:global"],
        )
        .await
        .unwrap();
        let app = build_test_router(state);
        let (seed_status, seed_payload) = request_json(
            &app,
            Method::POST,
            "/v1/mutations",
            Some("secret-token"),
            Some(complete_book_mutations()),
        )
        .await;
        assert_eq!(seed_status, StatusCode::OK);
        assert_eq!(seed_payload["results"][6]["entityType"], "book.history");
        assert_eq!(
            seed_payload["results"][6]["record"]["historyId"],
            "history-1"
        );

        let (delete_status, delete_payload) = request_json(
            &app,
            Method::POST,
            "/v1/mutations",
            Some("secret-token"),
            Some(serde_json::json!({
                "requestId": "delete-book-history",
                "mutations": [{
                    "entityType": "book.history",
                    "clientMutationId": "delete-book-history-1",
                    "scopeId": "books:global",
                    "entityId": "history-1",
                    "op": "delete",
                    "lamport": 2
                }]
            })),
        )
        .await;
        assert_eq!(delete_status, StatusCode::OK);
        assert_eq!(delete_payload["results"][0]["status"], "applied");
        let delete_version = delete_payload["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();

        let (changes_status, changes) = request_json(
            &app,
            Method::GET,
            "/v1/changes?sinceVersion=7&scopeId=books%3Aglobal",
            Some("secret-token"),
            None,
        )
        .await;
        assert_eq!(changes_status, StatusCode::OK);
        assert_eq!(changes["changes"][0]["entityType"], "book.history");
        assert_eq!(changes["changes"][0]["op"], "delete");
        assert_eq!(changes["changes"][0]["serverVersion"], delete_version);

        let (snapshot_status, snapshot) = request_json(
            &app,
            Method::GET,
            "/v1/snapshot?scopeId=books%3Aglobal",
            Some("secret-token"),
            None,
        )
        .await;
        assert_eq!(snapshot_status, StatusCode::OK);
        assert!(!snapshot["entities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entity| {
                entity["entityType"] == "book.history" && entity["entityId"] == "history-1"
            }));
        assert!(snapshot["tombstones"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entity| {
                entity["entityType"] == "book.history" && entity["entityId"] == "history-1"
            }));
    }

    #[tokio::test]
    async fn snapshot_returns_every_supported_novel_entity() {
        let (_temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("secret-token"),
            &["novels:profile:main"],
        )
        .await
        .unwrap();
        let app = build_test_router(state);

        let (mutation_status, mutation_payload) = request_json(
            &app,
            Method::POST,
            "/v1/mutations",
            Some("secret-token"),
            Some(complete_novel_mutations()),
        )
        .await;
        assert_eq!(mutation_status, StatusCode::OK);
        assert!(
            mutation_payload["results"]
                .as_array()
                .unwrap()
                .iter()
                .all(|result| result["status"] == "applied"),
            "{mutation_payload}"
        );

        let (status, payload) = request_json(
            &app,
            Method::GET,
            "/v1/snapshot?scopeId=novels%3Aprofile%3Amain",
            Some("secret-token"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["snapshotVersion"], 6);
        let entities = payload["entities"].as_array().unwrap();
        let entity_types = entities
            .iter()
            .map(|entity| entity["entityType"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            entity_types,
            vec![
                "novel.entry",
                "novel.chapter",
                "novel.progress",
                "novel.bookmark",
                "novel.history",
                "novel.classification",
            ]
        );
        assert_eq!(entities[0]["record"]["title"], "Novel One");
        // The storage row is keyed by novel.progress::<novel_id>, but snapshots expose the
        // canonical novel identity used by replay and mobile projection.
        assert_eq!(entities[2]["record"]["novelId"], "novel-1");
        assert_eq!(entities[5]["record"]["status"], "compatible");
    }

    #[tokio::test]
    async fn novel_chapter_asset_requires_scoped_blob_and_is_replayable_and_tombstone_safe() {
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
        let app = build_test_router(state.clone());
        let (seed_status, seed_payload) = request_json(
            &app,
            Method::POST,
            "/v1/mutations",
            Some("secret-token"),
            Some(complete_novel_mutations()),
        )
        .await;
        assert_eq!(seed_status, StatusCode::OK);
        assert!(seed_payload["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|result| result["status"] == "applied"));

        let archive = b"PK\x03\x04synthetic-lnreader-chapter".to_vec();
        let blob_sha256 = format!("{:x}", Sha256::digest(&archive));
        let entity_id =
            crate::syncd::models::canonical_novel_chapter_asset_id("novel-1", "chapter-1");
        let patch = serde_json::json!({
            "schemaVersion": 1,
            "novelId": "novel-1",
            "chapterId": "chapter-1",
            "blobSha256": blob_sha256,
            "byteLength": archive.len(),
            "archiveFormat": "zip",
            "createdAtMs": 3000,
            "updatedAtMs": 3000
        });
        let mutation = |request_id: &str,
                        client_mutation_id: &str,
                        lamport: i64,
                        op: &str,
                        patch: Option<Value>| {
            serde_json::json!({
                "requestId": request_id,
                "mutations": [{
                    "entityType": "novel.chapter_asset",
                    "clientMutationId": client_mutation_id,
                    "scopeId": "novels:profile:main",
                    "entityId": entity_id,
                    "op": op,
                    "lamport": lamport,
                    "patch": patch
                }]
            })
        };

        let before_upload = mutation(
            "chapter-asset-before-upload",
            "chapter-asset-before-upload",
            1,
            "merge",
            Some(patch.clone()),
        );
        let (status, payload) = request_json(
            &app,
            Method::POST,
            "/v1/mutations",
            Some("secret-token"),
            Some(before_upload.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["results"][0]["status"], "rejected");
        assert_eq!(
            payload["results"][0]["error"]["code"],
            "ASSET_NOT_AVAILABLE_FOR_SCOPE"
        );

        let books_uri = format!("/v1/assets/{blob_sha256}?scopeId=books%3Aglobal");
        assert_eq!(
            request_bytes(
                &app,
                Method::PUT,
                &books_uri,
                "secret-token",
                archive.clone(),
            )
            .await,
            StatusCode::CREATED
        );
        let wrong_scope = mutation(
            "chapter-asset-wrong-scope",
            "chapter-asset-wrong-scope",
            2,
            "merge",
            Some(patch.clone()),
        );
        let (_, payload) = request_json(
            &app,
            Method::POST,
            "/v1/mutations",
            Some("secret-token"),
            Some(wrong_scope),
        )
        .await;
        assert_eq!(
            payload["results"][0]["error"]["code"],
            "ASSET_NOT_AVAILABLE_FOR_SCOPE"
        );

        let novels_uri = format!("/v1/assets/{blob_sha256}?scopeId=novels%3Aprofile%3Amain");
        assert_eq!(
            request_bytes(
                &app,
                Method::PUT,
                &novels_uri,
                "secret-token",
                archive.clone(),
            )
            .await,
            StatusCode::NO_CONTENT
        );

        let (_, replayed_rejection) = request_json(
            &app,
            Method::POST,
            "/v1/mutations",
            Some("secret-token"),
            Some(before_upload),
        )
        .await;
        assert_eq!(replayed_rejection["results"][0]["status"], "rejected");
        assert_eq!(
            replayed_rejection["results"][0]["error"]["code"],
            "ASSET_NOT_AVAILABLE_FOR_SCOPE"
        );

        let mut live_changes = state.change_sender.subscribe();
        let valid = mutation(
            "chapter-asset-valid",
            "chapter-asset-valid",
            3,
            "merge",
            Some(patch.clone()),
        );
        let (_, valid_payload) = request_json(
            &app,
            Method::POST,
            "/v1/mutations",
            Some("secret-token"),
            Some(valid),
        )
        .await;
        assert_eq!(valid_payload["results"][0]["status"], "applied");
        assert!(valid_payload["results"][0]["canonicalEntityId"].is_null());
        assert_eq!(
            valid_payload["results"][0]["record"]["blobSha256"],
            blob_sha256
        );
        let valid_version = valid_payload["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();
        let live_change =
            tokio::time::timeout(std::time::Duration::from_secs(1), live_changes.recv())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(live_change.entity_type, "novel.chapter_asset");

        let (_, changes) = request_json(
            &app,
            Method::GET,
            "/v1/changes?sinceVersion=6&scopeId=novels%3Aprofile%3Amain",
            Some("secret-token"),
            None,
        )
        .await;
        assert!(changes["changes"].as_array().unwrap().iter().any(|change| {
            change["entityType"] == "novel.chapter_asset"
                && change["entityId"] == entity_id
                && change["op"] == "merge"
        }));
        let (_, snapshot) = request_json(
            &app,
            Method::GET,
            "/v1/snapshot?scopeId=novels%3Aprofile%3Amain",
            Some("secret-token"),
            None,
        )
        .await;
        assert!(snapshot["entities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| {
                entry["entityType"] == "novel.chapter_asset"
                    && entry["entityId"] == entity_id
                    && entry["record"]["byteLength"] == archive.len()
            }));

        let delete = mutation(
            "chapter-asset-delete",
            "chapter-asset-delete",
            10,
            "delete",
            None,
        );
        let (_, delete_payload) = request_json(
            &app,
            Method::POST,
            "/v1/mutations",
            Some("secret-token"),
            Some(delete),
        )
        .await;
        assert_eq!(delete_payload["results"][0]["status"], "applied");

        let (_, delete_changes) = request_json(
            &app,
            Method::GET,
            &format!("/v1/changes?sinceVersion={valid_version}&scopeId=novels%3Aprofile%3Amain"),
            Some("secret-token"),
            None,
        )
        .await;
        assert!(delete_changes["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| {
                change["entityType"] == "novel.chapter_asset"
                    && change["entityId"] == entity_id
                    && change["op"] == "delete"
            }));

        let (_, deleted_snapshot) = request_json(
            &app,
            Method::GET,
            "/v1/snapshot?scopeId=novels%3Aprofile%3Amain",
            Some("secret-token"),
            None,
        )
        .await;
        assert!(!deleted_snapshot["entities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| {
                entry["entityType"] == "novel.chapter_asset" && entry["entityId"] == entity_id
            }));
        assert!(deleted_snapshot["tombstones"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| {
                entry["entityType"] == "novel.chapter_asset" && entry["entityId"] == entity_id
            }));

        let stale = mutation(
            "chapter-asset-stale",
            "chapter-asset-stale",
            9,
            "merge",
            Some(patch),
        );
        let (_, stale_payload) = request_json(
            &app,
            Method::POST,
            "/v1/mutations",
            Some("secret-token"),
            Some(stale),
        )
        .await;
        assert_eq!(stale_payload["results"][0]["status"], "rejected");
        assert_eq!(
            stale_payload["results"][0]["error"]["code"],
            "STALE_NOVEL_CHAPTER_ASSET_MUTATION"
        );
    }

    #[tokio::test]
    async fn snapshot_includes_tombstone_after_delete() {
        let (_temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("secret-token"),
            &["books:global"],
        )
        .await
        .unwrap();
        let app = build_test_router(state);
        let (seed_status, _) = request_json(
            &app,
            Method::POST,
            "/v1/mutations",
            Some("secret-token"),
            Some(complete_book_mutations()),
        )
        .await;
        assert_eq!(seed_status, StatusCode::OK);

        let (delete_status, delete_payload) = request_json(
            &app,
            Method::POST,
            "/v1/mutations",
            Some("secret-token"),
            Some(serde_json::json!({
                "requestId": "delete-book",
                "mutations": [{
                    "entityType": "book.entry",
                    "clientMutationId": "delete-book-1",
                    "scopeId": "books:global",
                    "entityId": "book-1",
                    "op": "delete",
                    "lamport": 10
                }]
            })),
        )
        .await;
        assert_eq!(delete_status, StatusCode::OK);
        assert_eq!(delete_payload["results"][0]["status"], "applied");

        let (status, payload) = request_json(
            &app,
            Method::GET,
            "/v1/snapshot?scopeId=books%3Aglobal",
            Some("secret-token"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert!(!payload["entities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entity| entity["entityType"] == "book.entry"));
        assert_eq!(payload["tombstones"].as_array().unwrap().len(), 1);
        assert_eq!(payload["tombstones"][0]["entityType"], "book.entry");
        assert_eq!(payload["tombstones"][0]["entityId"], "book-1");
        assert_eq!(payload["tombstones"][0]["reasonCode"], "book_deleted");
        assert_eq!(
            payload["tombstones"][0]["serverVersion"],
            payload["snapshotVersion"]
        );
    }

    #[tokio::test]
    async fn snapshot_checkpoint_has_no_replay_gap() {
        let (_temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("secret-token"),
            &["books:global"],
        )
        .await
        .unwrap();
        let app = build_test_router(state);

        let (_, before) = request_json(
            &app,
            Method::GET,
            "/v1/snapshot?scopeId=books%3Aglobal",
            Some("secret-token"),
            None,
        )
        .await;
        let checkpoint = before["snapshotVersion"].as_i64().unwrap();

        let (mutation_status, mutation_payload) = request_json(
            &app,
            Method::POST,
            "/v1/mutations",
            Some("secret-token"),
            Some(serde_json::json!({
                "requestId": "after-snapshot",
                "mutations": [{
                    "entityType": "book.category",
                    "clientMutationId": "after-snapshot-category",
                    "scopeId": "books:global",
                    "entityId": "category-after",
                    "op": "merge",
                    "lamport": 1,
                    "patch": {"categoryId": "category-after", "name": "Later", "order": 0}
                }]
            })),
        )
        .await;
        assert_eq!(mutation_status, StatusCode::OK);
        let applied_version = mutation_payload["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();
        assert!(applied_version > checkpoint);

        let (changes_status, changes) = request_json(
            &app,
            Method::GET,
            &format!("/v1/changes?sinceVersion={checkpoint}&scopeId=books%3Aglobal"),
            Some("secret-token"),
            None,
        )
        .await;

        assert_eq!(changes_status, StatusCode::OK);
        assert_eq!(changes["changes"].as_array().unwrap().len(), 1);
        assert_eq!(changes["changes"][0]["serverVersion"], applied_version);
        assert_eq!(changes["changes"][0]["entityId"], "category-after");
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

    async fn open_books_event_stream(app: Router) -> axum::response::Response {
        app.oneshot(
            Request::builder()
                .uri("/v1/events?scopeId=books:global")
                .header(CLIENT_VERSION_HEADER, "0.1.0")
                .header(CLIENT_PROTOCOL_HEADER, "1")
                .header("authorization", "Bearer secret-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    }

    async fn open_catalog_event_stream(app: Router, opt_in: bool) -> axum::response::Response {
        let query = if opt_in { "&catalogEvents=true" } else { "" };
        app.oneshot(
            Request::builder()
                .uri(format!(
                    "/v1/events?scopeId=comics:profile:catalog-events{query}"
                ))
                .header(CLIENT_VERSION_HEADER, "0.1.0")
                .header(CLIENT_PROTOCOL_HEADER, "1")
                .header("authorization", "Bearer secret-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    }

    /// Reads the stream for `window` and returns everything it sent.
    async fn read_stream_for(
        response: axum::response::Response,
        window: std::time::Duration,
    ) -> String {
        let mut body = response.into_body();
        let mut text = String::new();
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(Some(Ok(frame))) = tokio::time::timeout_at(deadline, body.frame()).await {
            if let Ok(bytes) = frame.into_data() {
                text.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
        text
    }

    #[tokio::test]
    async fn events_stream_sends_catalog_revisions_only_on_request() {
        let (_temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "catalog-events",
            &token_hash("secret-token"),
            &["comics:profile:catalog-events"],
        )
        .await
        .unwrap();

        let opted_in = open_catalog_event_stream(build_test_router(state.clone()), true).await;
        let legacy = open_catalog_event_stream(build_test_router(state), false).await;
        assert_eq!(opted_in.status(), StatusCode::OK);
        assert_eq!(legacy.status(), StatusCode::OK);
        crate::syncd::catalog_revision::announce_change_for_test("another-profile");
        crate::syncd::catalog_revision::announce_change_for_test("catalog-events");

        let window = std::time::Duration::from_millis(500);
        let (opted_in, legacy) = tokio::join!(
            read_stream_for(opted_in, window),
            read_stream_for(legacy, window)
        );
        assert_eq!(opted_in.matches("event: catalog_revision").count(), 1);
        assert!(opted_in.contains("\"scopeId\":\"comics:profile:catalog-events\""));
        // No id: the event must not move the client's replay cursor.
        assert!(!opted_in.contains("id:"));
        assert!(!legacy.contains("catalog_revision"));
    }

    #[tokio::test]
    async fn events_stream_closes_after_token_revocation() {
        let (_temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("secret-token"),
            &["books:global"],
        )
        .await
        .unwrap();

        let response = open_books_event_stream(build_test_router(state.clone())).await;
        assert_eq!(response.status(), StatusCode::OK);
        crate::syncd::db::revoke_token(&state.pool, &token_hash("secret-token"))
            .await
            .unwrap();

        let body = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            response.into_body().collect(),
        )
        .await
        .expect("a revoked token must not keep its live stream open")
        .unwrap()
        .to_bytes();
        assert!(!String::from_utf8_lossy(&body).contains("event: change"));
    }

    #[tokio::test]
    async fn open_event_stream_keeps_a_connected_device_active() {
        let (_temp, state) = build_state_for_http().await;
        ensure_test_token(
            &state.pool,
            "device-a",
            "main",
            &token_hash("secret-token"),
            &["books:global"],
        )
        .await
        .unwrap();

        let response = open_books_event_stream(build_test_router(state.clone())).await;
        assert_eq!(response.status(), StatusCode::OK);
        // A device that only listens sends no other requests; its window is about to lapse.
        let nearly_expired = crate::syncd::db::now_ms() + 60_000;
        sqlx::query("UPDATE paired_device_tokens SET inactivity_expires_at_ms = ? WHERE token_hash = ?")
            .bind(nearly_expired)
            .bind(token_hash("secret-token"))
            .execute(&state.pool)
            .await
            .unwrap();

        let body = tokio::spawn(response.into_body().collect());
        let extended = nearly_expired + state.config.token_inactivity_window.as_millis() as i64 / 2;
        // Wait for a ping to extend the window rather than a fixed delay a busy machine can outlast.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        let token = loop {
            let token = crate::syncd::db::load_token_state(&state.pool, &token_hash("secret-token"))
                .await
                .unwrap()
                .expect("token");
            if token.inactivity_expires_at_ms > extended || tokio::time::Instant::now() >= deadline {
                break token;
            }
            tokio::time::sleep(state.config.ping_interval).await;
        };
        assert!(
            token.inactivity_expires_at_ms > extended,
            "the open stream must extend the inactivity window"
        );
        // Later pings keep the stream open too.
        tokio::time::sleep(state.config.ping_interval * 4).await;
        assert!(!body.is_finished(), "an active device must keep its live stream");
        body.abort();
    }

    #[tokio::test]
    async fn events_stream_closes_when_streamed_scope_is_removed() {
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

        let response = open_books_event_stream(build_test_router(state.clone())).await;
        assert_eq!(response.status(), StatusCode::OK);
        crate::syncd::db::update_paired_device_granted_scopes(
            &state.pool,
            "device-a",
            "main",
            &["novels:profile:main".to_string()],
        )
        .await
        .unwrap()
        .expect("paired device");
        let envelope = append_change_log_entry(
            &state.pool,
            "books:global",
            None,
            "book.progress",
            "book-1",
            "merge",
            1,
            "device-b",
            Some(&serde_json::json!({"progressPercent": 0.5})),
            state.config.retention_window,
        )
        .await
        .unwrap();
        let _ = state.change_sender.send(envelope);

        let body = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            response.into_body().collect(),
        )
        .await
        .expect("a stream must close once its scope is no longer granted")
        .unwrap()
        .to_bytes();
        assert!(!String::from_utf8_lossy(&body).contains("event: change"));
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
    async fn replay_rejects_a_cursor_ahead_of_the_server_history() {
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

        for (uri, last_event_id) in [
            ("/v1/events?scopeId=books:global", Some("42")),
            ("/v1/changes?sinceVersion=42&scopeId=books:global", None),
        ] {
            let app = build_test_router(state.clone());
            let mut request = Request::builder()
                .uri(uri)
                .header(CLIENT_VERSION_HEADER, "0.1.0")
                .header(CLIENT_PROTOCOL_HEADER, "1")
                .header("authorization", "Bearer secret-token");
            if let Some(last_event_id) = last_event_id {
                request = request.header("last-event-id", last_event_id);
            }
            let response = app
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::CONFLICT, "{uri}");
            let body = response.into_body().collect().await.unwrap().to_bytes();
            let payload: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(payload["error"]["code"], "REPLAY_WINDOW_EXPIRED", "{uri}");
            assert_eq!(payload["error"]["requiredAction"], "full_bootstrap", "{uri}");
            assert_eq!(payload["error"]["currentServerVersion"], 10, "{uri}");
        }
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

        let (status, _) = request_json(&app, Method::GET, "/v1/tracker-credentials", None, None).await;
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
        let (_, snapshot) = request_json(
            &app,
            Method::GET,
            "/v1/snapshot?scopeId=comics%3Aprofile%3Amain",
            Some("secret-token"),
            None,
        )
        .await;
        assert!(!snapshot.to_string().contains("tr4ck3r-secret"));
        let (_, changes) = request_json(
            &app,
            Method::GET,
            "/v1/changes?sinceVersion=0&scopeId=comics%3Aprofile%3Amain",
            Some("secret-token"),
            None,
        )
        .await;
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
