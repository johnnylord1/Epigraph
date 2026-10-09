use std::net::SocketAddr;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use serde::Deserialize;

use crate::syncd::models::{AppError, PairingTokenResponse, SharedAppState};
use crate::syncd::tracker_credentials::{self, DESKTOP_DEVICE_ID};
use crate::syncd::{db, myanimelist_oauth, suwayomi_progress_mirror, suwayomi_tracking_mirror};

/// Upper bound for ids accepted by one progress-mirror request.
const MAX_PROGRESS_MIRROR_IDS: usize = 1_024;

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

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalProgressMirrorRequest {
    pub manga_ids: Vec<i64>,
    pub chapter_ids: Vec<i64>,
}

/// Lets the desktop shell ask for an immediate Suwayomi progress mirror tick after it changed
/// chapter read, page or bookmark state, so paired devices do not wait for the periodic tick.
pub async fn post_local_progress_mirror(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Json(request): Json<LocalProgressMirrorRequest>,
) -> Result<StatusCode, AppError> {
    if !remote_addr.ip().is_loopback() {
        return Err(AppError::Forbidden(
            "Local progress mirror is only available from loopback.".to_string(),
        ));
    }
    if request.manga_ids.len() > MAX_PROGRESS_MIRROR_IDS
        || request.chapter_ids.len() > MAX_PROGRESS_MIRROR_IDS
    {
        return Err(AppError::BadRequest(format!(
            "Local progress mirror accepts at most {MAX_PROGRESS_MIRROR_IDS} ids per list."
        )));
    }
    suwayomi_progress_mirror::request_immediate_mirror(&request.manga_ids, &request.chapter_ids);
    Ok(StatusCode::ACCEPTED)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalTrackerLoginRequest {
    access_token: String,
    /// Optional when the shell already knows it; otherwise syncd asks AniList.
    #[serde(default)]
    viewer_id: Option<i64>,
}

/// The desktop shell publishes a tracker login it just completed against its own Suwayomi, so
/// paired devices receive it through `/v1/tracker-credentials`. Only AniList has a portable
/// login shape the mobile can apply (Mihon's viewer id + OAuth JSON).
pub async fn put_local_tracker_credential(
    State(state): State<SharedAppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Path(tracker_key): Path<String>,
    body: Bytes,
) -> Result<StatusCode, AppError> {
    if !remote_addr.ip().is_loopback() {
        return Err(AppError::Forbidden(
            "Local tracker credentials are only available from loopback.".to_string(),
        ));
    }
    if !tracker_credentials::is_supported() {
        return Ok(StatusCode::NO_CONTENT);
    }
    if tracker_key != "anilist" {
        return Err(AppError::BadRequest(
            "Only AniList desktop logins can be shared with paired devices.".to_string(),
        ));
    }
    let request: LocalTrackerLoginRequest = serde_json::from_slice(&body).map_err(|_| {
        AppError::BadRequest("Local tracker login body must be {accessToken}.".to_string())
    })?;
    let access_token = request.access_token.trim().to_string();
    if !tracker_credentials::is_safe_oauth_token(&access_token) {
        return Err(AppError::BadRequest(
            "Local tracker login accessToken is invalid.".to_string(),
        ));
    }

    let current = tracker_credentials::load_vault(&state.config.data_dir)
        .await
        .map_err(local_vault_error)?;
    if current.credentials.get(&tracker_key).is_some_and(|stored| {
        !stored.deleted && tracker_credentials::anilist_access_token(stored).as_deref()
            == Some(access_token.as_str())
    }) {
        return Ok(StatusCode::NO_CONTENT);
    }

    let viewer_id = match request.viewer_id.filter(|id| *id > 0) {
        Some(viewer_id) => viewer_id,
        None => tracker_credentials::fetch_anilist_viewer_id(&access_token)
            .await
            .map_err(|error| {
                tracing::warn!(error = %error, "could not resolve the AniList viewer for a desktop login");
                AppError::BadRequest("AniList did not accept the desktop login token.".to_string())
            })?,
    };
    let now_ms = local_now_ms();
    let values = tracker_credentials::mihon_anilist_credential(viewer_id, &access_token, now_ms);
    let outcome = tracker_credentials::update_vault(&state.config.data_dir, |vault| {
        let base_revision = vault.current_revision(&tracker_key);
        let view = vault.put(&tracker_key, base_revision, values, DESKTOP_DEVICE_ID, now_ms)?;
        // Suwayomi on this desktop already holds this login; nothing to apply back.
        vault.mark_desktop_applied(&tracker_key, view.revision);
        Ok((view, true))
    })
    .await
    .map_err(local_vault_error)?;
    match outcome {
        Ok(view) => {
            tracing::info!(tracker_key = %view.tracker_key, revision = view.revision, "desktop tracker login published");
            Ok(StatusCode::ACCEPTED)
        }
        Err(_) => Err(AppError::BadRequest(
            "Local tracker login could not be stored.".to_string(),
        )),
    }
}

/// The desktop shell logged a tracker out; paired devices converge on the tombstone.
pub async fn delete_local_tracker_credential(
    State(state): State<SharedAppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Path(tracker_key): Path<String>,
) -> Result<StatusCode, AppError> {
    if !remote_addr.ip().is_loopback() {
        return Err(AppError::Forbidden(
            "Local tracker credentials are only available from loopback.".to_string(),
        ));
    }
    if !tracker_credentials::is_supported() {
        return Ok(StatusCode::NO_CONTENT);
    }
    if !crate::syncd::tracking::is_valid_tracker_key(&tracker_key) {
        return Err(AppError::BadRequest("trackerKey is invalid.".to_string()));
    }
    let now_ms = local_now_ms();
    let outcome = tracker_credentials::update_vault(&state.config.data_dir, |vault| {
        let live = vault
            .credentials
            .get(&tracker_key)
            .is_some_and(|stored| !stored.deleted);
        if !live {
            return Ok((false, false));
        }
        let base_revision = vault.current_revision(&tracker_key);
        let view = vault.delete(&tracker_key, base_revision, DESKTOP_DEVICE_ID, now_ms)?;
        vault.mark_desktop_applied(&tracker_key, view.revision);
        Ok((true, true))
    })
    .await
    .map_err(local_vault_error)?;
    match outcome {
        Ok(true) => {
            tracing::info!(tracker_key = %tracker_key, "desktop tracker logout published");
            suwayomi_tracking_mirror::request_immediate_mirror();
            Ok(StatusCode::ACCEPTED)
        }
        Ok(false) => Ok(StatusCode::NO_CONTENT),
        Err(_) => Err(AppError::BadRequest(
            "Local tracker logout could not be stored.".to_string(),
        )),
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMyAnimeListLoginStart {
    pub auth_url: String,
}

/// Starts a MyAnimeList login with Epigraph's client, so syncd can renew it before it expires.
pub async fn post_local_myanimelist_login_start(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
) -> Result<axum::response::Response, AppError> {
    if !remote_addr.ip().is_loopback() {
        return Err(AppError::Forbidden(
            "Local tracker logins are only available from loopback.".to_string(),
        ));
    }
    if !tracker_credentials::is_supported() {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let auth_url = myanimelist_oauth::start_login(local_now_ms());
    Ok(Json(LocalMyAnimeListLoginStart { auth_url }).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMyAnimeListLoginComplete {
    pub callback_url: String,
}

/// Completes a login started by [`post_local_myanimelist_login_start`]. The login is stored as a
/// desktop write Suwayomi has not applied yet, so the tracking mirror writes it into Suwayomi and
/// paired devices receive it.
pub async fn post_local_myanimelist_login_complete(
    State(state): State<SharedAppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Json(request): Json<LocalMyAnimeListLoginComplete>,
) -> Result<StatusCode, AppError> {
    if !remote_addr.ip().is_loopback() {
        return Err(AppError::Forbidden(
            "Local tracker logins are only available from loopback.".to_string(),
        ));
    }
    if !tracker_credentials::is_supported() {
        return Ok(StatusCode::NO_CONTENT);
    }
    let now_ms = local_now_ms();
    let values = myanimelist_oauth::complete_login(&request.callback_url, now_ms)
        .await
        .map_err(|error| match error {
            myanimelist_oauth::LoginError::UnknownLogin => AppError::BadRequest(
                "This MyAnimeList login expired or was not started here; start it again.".to_string(),
            ),
            myanimelist_oauth::LoginError::Rejected => {
                tracing::warn!("MyAnimeList did not accept a desktop login");
                AppError::BadRequest("MyAnimeList did not accept the login.".to_string())
            }
        })?;
    let tracker_key = myanimelist_oauth::TRACKER_KEY;
    let outcome = tracker_credentials::update_vault(&state.config.data_dir, |vault| {
        let base_revision = vault.current_revision(tracker_key);
        let view = vault.put(tracker_key, base_revision, values, DESKTOP_DEVICE_ID, now_ms)?;
        Ok((view, true))
    })
    .await
    .map_err(local_vault_error)?;
    match outcome {
        Ok(view) => {
            tracing::info!(revision = view.revision, "desktop MyAnimeList login stored");
            suwayomi_tracking_mirror::request_immediate_mirror();
            Ok(StatusCode::ACCEPTED)
        }
        Err(_) => Err(AppError::BadRequest(
            "Local tracker login could not be stored.".to_string(),
        )),
    }
}

fn local_vault_error(error: anyhow::Error) -> AppError {
    tracing::error!(error = %error, "tracker credential vault failed");
    AppError::Internal("Tracker credential vault is unavailable.".to_string())
}

fn local_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
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
            .route(
                "/v1/local/progress-mirror",
                axum::routing::post(post_local_progress_mirror),
            )
            .route(
                "/v1/local/tracker-credentials/:tracker_key",
                axum::routing::put(put_local_tracker_credential)
                    .delete(delete_local_tracker_credential),
            )
            .with_state(state)
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn local_tracker_login_publishes_mihon_shape_and_logout_tombstones() {
        let state = build_state().await;
        let send = |method: &str, remote: &str, body: &str| {
            Request::builder()
                .method(method)
                .uri("/v1/local/tracker-credentials/anilist")
                .header("content-type", "application/json")
                .extension(ConnectInfo(remote.parse::<SocketAddr>().unwrap()))
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let login = r#"{"accessToken":"desk.token-1","viewerId":4242}"#;
        let response = router(state.clone())
            .oneshot(send("PUT", "192.168.1.7:4777", login))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let response = router(state.clone())
            .oneshot(send("PUT", "127.0.0.1:4777", login))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let vault = tracker_credentials::load_vault(&state.config.data_dir)
            .await
            .unwrap();
        let stored = &vault.credentials["anilist"];
        assert_eq!(stored.revision, 1);
        assert_eq!(stored.desktop_revision, 1);
        assert_eq!(stored.username, "4242");
        assert_eq!(stored.password, "desk.token-1");
        let token: Value = serde_json::from_str(&stored.token).unwrap();
        assert_eq!(token["access_token"], "desk.token-1");

        // Re-publishing the same login is a no-op (no revision churn, no loop).
        let response = router(state.clone())
            .oneshot(send("PUT", "127.0.0.1:4777", login))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let response = router(state.clone())
            .oneshot(send(
                "PUT",
                "127.0.0.1:4777",
                r#"{"accessToken":"desk.token-2","viewerId":4242}"#,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);

        let response = router(state.clone())
            .oneshot(send("DELETE", "127.0.0.1:4777", ""))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let vault = tracker_credentials::load_vault(&state.config.data_dir)
            .await
            .unwrap();
        let stored = &vault.credentials["anilist"];
        assert!(stored.deleted);
        assert_eq!(stored.revision, 3);
        assert_eq!(stored.desktop_revision, 3);
        assert!(stored.token.is_empty());

        let response = router(state.clone())
            .oneshot(send("DELETE", "127.0.0.1:4777", ""))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let response = router(state)
            .oneshot(
                Request::put("/v1/local/tracker-credentials/kitsu")
                    .header("content-type", "application/json")
                    .extension(ConnectInfo("127.0.0.1:4777".parse::<SocketAddr>().unwrap()))
                    .body(Body::from(login))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
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
    async fn local_progress_mirror_route_requires_loopback() {
        let state = build_state().await;
        let request = |remote: &str| {
            Request::post("/v1/local/progress-mirror")
                .header("content-type", "application/json")
                .extension(ConnectInfo(remote.parse::<SocketAddr>().unwrap()))
                .body(Body::from(r#"{"mangaIds":[3],"chapterIds":[508]}"#))
                .unwrap()
        };
        let response = router(state.clone())
            .oneshot(request("192.168.1.7:4777"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = router(state)
            .oneshot(request("127.0.0.1:4777"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
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
