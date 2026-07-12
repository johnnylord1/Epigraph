use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use axum::middleware;
use axum::routing::{get, post};
use axum::Router;
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
use super::middleware::require_authenticated_session;
use super::models::AppState;
use super::routes::{
    bootstrap, capabilities, discovery, events, health, local, mutations, pairing, snapshot,
};
use super::runtime_manifest::{RuntimeManifestLease, SyncdRuntimeManifest};
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

    let _runtime_manifest_lease = if config.ownership_mode == SyncdOwnershipMode::PersistentAttached
    {
        let executable =
            std::env::current_exe().context("failed to resolve aethon-syncd executable path")?;
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
    } else {
        None
    };

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
        .route("/v1/snapshot", get(snapshot::get_snapshot))
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
                tracing::warn!(parent_pid, "syncd parent process missing; exiting sidecar");
                std::process::exit(0);
            }
        }
    });
}

fn watchdog_parent_pid(config: &SyncdConfig) -> Option<u32> {
    if config.ownership_mode == SyncdOwnershipMode::EphemeralOwned {
        config.parent_pid
    } else {
        None
    }
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
                        "assetFingerprint": "sha256:book-1",
                        "title": "Book One",
                        "author": "Aethon",
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
                        "savedAtMs": 2000
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
                        "author": "Aethon",
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
        assert_eq!(payload["supportsSnapshot"], true);
        assert_eq!(payload["snapshotSchemaVersion"], 1);
        assert_eq!(payload["snapshotEntityTypes"].as_array().unwrap().len(), 12);
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
        assert_eq!(payload["schemaVersion"], 1);
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
        assert_eq!(payload["snapshotVersion"], 6);
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
            ]
        );
        assert_eq!(entities[0]["record"]["title"], "Book One");
        assert!(entities.iter().all(|entity| entity["serverVersion"]
            .as_i64()
            .is_some_and(|version| version <= 6)));
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
        assert_eq!(entities[5]["record"]["status"], "compatible");
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
