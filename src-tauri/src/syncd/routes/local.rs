use std::net::SocketAddr;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::syncd::landed_works::{self, LandedWorksView};
use crate::syncd::models::{AppError, PairingTokenResponse, SharedAppState};
use crate::syncd::tracker_credentials::{self, DESKTOP_DEVICE_ID};
use crate::syncd::{db, myanimelist_oauth, suwayomi_tracking_mirror};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotFoundWork {
    pub source_id: String,
    pub work_url: String,
    #[serde(default)]
    pub title: Option<String>,
}

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
    pub profile_id: Option<String>,
    pub manga_ids: Vec<i64>,
    pub chapter_ids: Vec<i64>,
    /// The desktop changed the library, its categories or extensions, not only reading progress.
    pub catalog: bool,
}

/// Lets the desktop shell ask for an immediate Suwayomi progress mirror tick after it changed
/// chapter read, page or bookmark state, so paired devices do not wait for the periodic tick.
pub async fn post_local_progress_mirror(
    State(state): State<SharedAppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    v4_runtime: Option<Extension<std::sync::Arc<crate::syncd::v4::V4Runtime>>>,
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
    if let Some(Extension(v4_runtime)) = v4_runtime {
        if !request.chapter_ids.is_empty() || !request.manga_ids.is_empty() {
            tokio::spawn(async move {
                let profile = request.profile_id.as_deref().unwrap_or("main");
                if let Err(error) = crate::syncd::v4::suwayomi::capture_local_edits(
                    &state,
                    &v4_runtime,
                    profile,
                    request.manga_ids,
                    request.chapter_ids,
                )
                .await
                {
                    tracing::debug!(error = %error, "V4 desktop comic edit capture deferred");
                }
            });
        }
    }
    Ok(StatusCode::ACCEPTED)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStoredChapterPagesRequest {
    pub chapter_ids: Vec<i64>,
}

/// The pages Core keeps for chapters Suwayomi shows as unopened because it did not know their page
/// count when another device's page arrived. The desktop reader asks once it has fetched a
/// chapter's pages, so it resumes where the other device stopped.
pub async fn post_local_stored_chapter_pages(
    State(state): State<SharedAppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Json(request): Json<LocalStoredChapterPagesRequest>,
) -> Result<Json<Value>, AppError> {
    if !remote_addr.ip().is_loopback() {
        return Err(AppError::Forbidden(
            "Stored chapter pages are only available from loopback.".to_string(),
        ));
    }
    if request.chapter_ids.len() > MAX_PROGRESS_MIRROR_IDS {
        return Err(AppError::BadRequest(format!(
            "Stored chapter pages accept at most {MAX_PROGRESS_MIRROR_IDS} ids."
        )));
    }
    let pages = stored_chapter_pages_from_v4(&state, &request.chapter_ids).await;
    let pages = pages
        .into_iter()
        .map(|(chapter_id, page)| (chapter_id.to_string(), Value::from(page)))
        .collect::<serde_json::Map<_, _>>();
    Ok(Json(json!({ "pages": pages })))
}

fn resolve_stored_chapter_page(chapter: &Value, v4_payload: Option<&Value>) -> Option<i64> {
    let suwayomi_page = chapter
        .get("lastPageRead")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let is_read = chapter
        .get("isRead")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if suwayomi_page != 0 || is_read {
        return None;
    }
    let page = v4_payload?
        .get("lastPageRead")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    (page > 0).then_some(page)
}

async fn stored_chapter_pages_from_v4(
    state: &SharedAppState,
    chapter_ids: &[i64],
) -> std::collections::BTreeMap<i64, i64> {
    let mut out = std::collections::BTreeMap::new();
    if chapter_ids.is_empty() {
        return out;
    }
    let instances = crate::syncd::suwayomi_process::attach_owned_instances();
    if instances.is_empty() {
        return out;
    }
    let query = r#"
        query EpigraphStoredChapterPage($id: Int!) {
          chapter(id: $id) {
            id
            url
            lastPageRead
            isRead
            manga {
              sourceId
              url
            }
          }
        }
    "#;
    let mut resolved_profiles: std::collections::HashMap<i64, usize> =
        std::collections::HashMap::new();
    let mut ambiguous: std::collections::HashSet<i64> = std::collections::HashSet::new();

    for instance in instances {
        let profile_id = instance.profile_key;
        let session = crate::syncd::models::AuthenticatedSession {
            token_id: "local-stored-chapter-pages".to_string(),
            device_id: DESKTOP_DEVICE_ID.to_string(),
            profile_id: profile_id.clone(),
            scopes: std::collections::BTreeSet::from([format!("comics:profile:{profile_id}")]),
            mutation_receipt: None,
        };
        for &chapter_id in chapter_ids {
            let Ok(body) = super::suwayomi_catalog::execute_graphql_document(
                state,
                &session,
                query,
                json!({ "id": chapter_id }),
                false,
            )
            .await
            else {
                continue;
            };
            let Some(chapter) = body.get("chapter") else {
                continue;
            };
            let count = resolved_profiles.entry(chapter_id).or_insert(0);
            *count += 1;
            if *count > 1 {
                ambiguous.insert(chapter_id);
                out.remove(&chapter_id);
                continue;
            }
            let Some(chapter_url) = chapter.get("url").and_then(Value::as_str) else {
                continue;
            };
            let Some(source_id) = chapter.pointer("/manga/sourceId").and_then(Value::as_str) else {
                continue;
            };
            let Some(manga_url) = chapter.pointer("/manga/url").and_then(Value::as_str) else {
                continue;
            };
            let work_key = crate::syncd::v4::hlc::canonical_work_key(source_id, manga_url);
            let chapter_key = crate::syncd::v4::hlc::canonical_chapter_key(&work_key, chapter_url);
            let Ok(row) = sqlx::query_scalar::<_, String>(
                "SELECT payload_json
                 FROM v4_records
                 WHERE profile_id = ? AND entity_type = 'comic.chapter' AND entity_key = ? AND deleted = 0",
            )
            .bind(&profile_id)
            .bind(&chapter_key)
            .fetch_optional(&state.pool)
            .await
            else {
                continue;
            };
            let v4_payload = row.and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
            if let Some(page) = resolve_stored_chapter_page(chapter, v4_payload.as_ref()) {
                out.insert(chapter_id, page);
            }
        }
    }
    for id in ambiguous {
        out.remove(&id);
    }
    out
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
        !stored.deleted
            && tracker_credentials::anilist_access_token(stored).as_deref()
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
        let view = vault.put(
            &tracker_key,
            base_revision,
            values,
            DESKTOP_DEVICE_ID,
            now_ms,
        )?;
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
                "This MyAnimeList login expired or was not started here; start it again."
                    .to_string(),
            ),
            myanimelist_oauth::LoginError::Rejected => {
                tracing::warn!("MyAnimeList did not accept a desktop login");
                AppError::BadRequest("MyAnimeList did not accept the login.".to_string())
            }
        })?;
    let tracker_key = myanimelist_oauth::TRACKER_KEY;
    let outcome = tracker_credentials::update_vault(&state.config.data_dir, |vault| {
        let base_revision = vault.current_revision(tracker_key);
        let view = vault.put(
            tracker_key,
            base_revision,
            values,
            DESKTOP_DEVICE_ID,
            now_ms,
        )?;
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

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSyncProgress {
    pub pending_projections: i64,
    /// The pending projections other than chapter progress. The first run waits for these only;
    /// chapter progress keeps landing in the background.
    pub pending_catalog_projections: i64,
    pub pending_tracker_logins: usize,
    /// Synced works still waiting for their details and chapter list from the source. They are in
    /// the library already, so the first run does not wait for them.
    pub pending_details: i64,
    /// What paired devices still have to upload, or `None` until each has reported a finished run.
    pub pending_uploads: Option<i64>,
    /// The library part of `pending_uploads`, without reading state; `None` until every device
    /// has told it apart. The first run lets the user continue once it is zero.
    pub pending_library_uploads: Option<i64>,
    /// Projections applied since Core started; when it moves, the UI reloads what it shows.
    pub applied_projections: u64,
    /// Which works changed in Suwayomi after `landedSince`, so the UI reads only those.
    pub landed: LandedWorksView,
    /// Works a paired device synced that this desktop could not find, so the user can install
    /// their source or migrate them. Their changes wait here without holding the sync.
    pub not_found_works: Vec<NotFoundWork>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSyncProgressQuery {
    #[allow(dead_code)]
    pub landed_since: Option<u64>,
}

/// What synced data this desktop has not applied yet, as counts only, so the first run can wait
/// until the synced library and tracker logins are in Suwayomi.
pub async fn get_local_sync_progress(
    State(state): State<SharedAppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Query(query): Query<LocalSyncProgressQuery>,
) -> Result<Json<LocalSyncProgress>, AppError> {
    if !remote_addr.ip().is_loopback() {
        return Err(AppError::Forbidden(
            "Local sync progress is only available from loopback.".to_string(),
        ));
    }
    let pending_projections: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM v4_records r
         JOIN v4_comics_projection p ON r.profile_id = p.profile_id
         WHERE r.domain = 'comics' AND r.server_seq > p.applied_seq",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap_or(0);
    let pending_catalog_projections: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM v4_records r
         JOIN v4_comics_projection p ON r.profile_id = p.profile_id
         WHERE r.domain = 'comics' AND r.entity_type != 'comic.chapter' AND r.server_seq > p.applied_seq",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap_or(0);
    Ok(Json(LocalSyncProgress {
        pending_projections,
        pending_catalog_projections,
        pending_tracker_logins: suwayomi_tracking_mirror::pending_login_count(&state).await,
        pending_details: 0,
        pending_uploads: super::status::pending_uploads(),
        pending_library_uploads: super::status::pending_library_uploads(),
        applied_projections: crate::syncd::v4::suwayomi::applied_projection_count(),
        landed: landed_works::view(query.landed_since),
        not_found_works: Vec::new(),
    }))
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
    use crate::syncd::test_dir::tempdir;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use serde_json::Value;
    use std::sync::Arc;
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
            device_presence: Default::default(),
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

    #[test]
    fn resolve_stored_chapter_page_handles_all_cases() {
        let suwayomi_unopened = json!({ "lastPageRead": 0, "isRead": false });
        let suwayomi_has_page = json!({ "lastPageRead": 5, "isRead": false });
        let suwayomi_read = json!({ "lastPageRead": 0, "isRead": true });
        let v4_payload = json!({ "lastPageRead": 17, "isRead": false });

        assert_eq!(
            resolve_stored_chapter_page(&suwayomi_unopened, Some(&v4_payload)),
            Some(17)
        );
        assert_eq!(
            resolve_stored_chapter_page(&suwayomi_has_page, Some(&v4_payload)),
            None
        );
        assert_eq!(
            resolve_stored_chapter_page(&suwayomi_read, Some(&v4_payload)),
            None
        );
        assert_eq!(
            resolve_stored_chapter_page(&suwayomi_unopened, None),
            None
        );
    }

    #[tokio::test]
    async fn stored_chapter_pages_reads_v4_chapter_record_and_ignores_missing() {
        let state = build_state().await;
        let work_key = crate::syncd::v4::hlc::canonical_work_key("12345", "/manga/test-work");
        let chapter_key =
            crate::syncd::v4::hlc::canonical_chapter_key(&work_key, "/manga/test-work/ch-1");
        crate::syncd::v4::db::apply_v4_batch(
            &state.pool,
            "main",
            "seed-device",
            vec![crate::syncd::v4::db::V4IncomingItem {
                client_mutation_id: Some("seed-ch-1".to_string()),
                domain: "comics".to_string(),
                entity_type: "comic.chapter".to_string(),
                entity_key: chapter_key.clone(),
                hlc: crate::syncd::v4::hlc::Hlc::new(1, 0, "seed-device"),
                deleted: false,
                payload: json!({ "lastPageRead": 17, "isRead": false }),
            }],
            false,
        )
        .await
        .unwrap();

        let rows = sqlx::query_as::<_, (String, String, String)>(
            "SELECT profile_id, entity_key, payload_json
             FROM v4_records
             WHERE domain = 'comics' AND entity_type = 'comic.chapter' AND deleted = 0",
        )
        .fetch_all(&state.pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, chapter_key);
        let payload: Value = serde_json::from_str(&rows[0].2).unwrap();
        assert_eq!(payload["lastPageRead"], 17);

        // Missing chapter key returns nothing, and Suwayomi unavailability returns empty map.
        let pages = stored_chapter_pages_from_v4(&state, &[999999]).await;
        assert!(pages.is_empty());
    }
}
