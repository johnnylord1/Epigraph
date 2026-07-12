use std::collections::BTreeSet;

use axum::extract::{Request, State};
use axum::http::header::{HeaderMap, HeaderName, AUTHORIZATION};
use axum::middleware::Next;
use axum::response::Response;
use semver::Version;
use sha2::{Digest, Sha256};
use sqlx::Row;

use super::db;
use super::models::{AppError, AuthenticatedSession, SharedAppState};

pub const CLIENT_VERSION_HEADER: HeaderName = HeaderName::from_static("x-aethon-client-version");
pub const CLIENT_PROTOCOL_HEADER: HeaderName =
    HeaderName::from_static("x-aethon-client-protocol-version");

pub async fn require_authenticated_session(
    State(state): State<SharedAppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, AppError> {
    validate_client_headers(request.headers(), &state)?;
    let token = bearer_token(request.headers())?;
    let session = authenticate_token(&state, &token).await?;
    request.extensions_mut().insert(session);
    Ok(next.run(request).await)
}

pub fn validate_client_headers(
    headers: &HeaderMap,
    state: &SharedAppState,
) -> Result<(), AppError> {
    let client_version = headers
        .get(CLIENT_VERSION_HEADER)
        .ok_or_else(|| AppError::BadRequest("Missing X-Aethon-Client-Version header.".to_string()))?
        .to_str()
        .map_err(|_| AppError::BadRequest("Invalid X-Aethon-Client-Version header.".to_string()))?;

    let client_protocol_version = headers
        .get(CLIENT_PROTOCOL_HEADER)
        .ok_or_else(|| {
            AppError::BadRequest("Missing X-Aethon-Client-Protocol-Version header.".to_string())
        })?
        .to_str()
        .map_err(|_| {
            AppError::BadRequest("Invalid X-Aethon-Client-Protocol-Version header.".to_string())
        })?
        .parse::<u32>()
        .map_err(|_| AppError::BadRequest("Invalid client protocol version.".to_string()))?;

    validate_client_version_fields(client_version, client_protocol_version, state)
}

pub fn validate_client_version_fields(
    client_version: &str,
    client_protocol_version: u32,
    state: &SharedAppState,
) -> Result<(), AppError> {
    if client_protocol_version != state.config.server_protocol_version {
        return Err(AppError::upgrade_required(
            "PROTOCOL_VERSION_MISMATCH",
            "Client protocol version is incompatible with the server.",
            Some(state.config.min_client_version.clone()),
        ));
    }

    let client_version = Version::parse(client_version).map_err(|_| {
        AppError::BadRequest("Client version must be a semantic version.".to_string())
    })?;
    let min_version = Version::parse(&state.config.min_client_version)
        .map_err(|_| AppError::Internal("Server min client version is invalid.".to_string()))?;

    if client_version < min_version {
        return Err(AppError::upgrade_required(
            "CLIENT_VERSION_TOO_OLD",
            "Client version is older than the minimum supported version.",
            Some(state.config.min_client_version.clone()),
        ));
    }

    Ok(())
}

pub fn validate_scope(session: &AuthenticatedSession, scope: &str) -> Result<(), AppError> {
    let expected = format!("novels:profile:{}", session.profile_id);
    let scope_is_available = scope == "books:global" || scope == expected;
    if scope_is_available && session.scopes.contains(scope) {
        return Ok(());
    }

    Err(AppError::Forbidden(format!(
        "Scope '{scope}' is not granted to this token or available for profile '{}'.",
        session.profile_id
    )))
}

pub fn filter_allowed_scopes<'a>(
    session: &'a AuthenticatedSession,
    scope_filter: Option<&'a str>,
) -> Result<BTreeSet<String>, AppError> {
    let mut allowed = BTreeSet::new();
    if let Some(scope) = scope_filter {
        validate_scope(session, scope)?;
        allowed.insert(scope.to_string());
        return Ok(allowed);
    }

    for scope in &session.scopes {
        if scope == "books:global" || scope == &format!("novels:profile:{}", session.profile_id) {
            allowed.insert(scope.clone());
        }
    }

    if allowed.is_empty() {
        return Err(AppError::Forbidden(
            "Authenticated token has no usable scopes.".to_string(),
        ));
    }

    Ok(allowed)
}

fn bearer_token(headers: &HeaderMap) -> Result<String, AppError> {
    let value = headers
        .get(AUTHORIZATION)
        .ok_or_else(|| AppError::Unauthorized("Missing bearer token.".to_string()))?
        .to_str()
        .map_err(|_| AppError::Unauthorized("Invalid Authorization header.".to_string()))?;
    let Some(token) = value.strip_prefix("Bearer ") else {
        return Err(AppError::Unauthorized(
            "Authorization header must use Bearer.".to_string(),
        ));
    };
    if token.trim().is_empty() {
        return Err(AppError::Unauthorized("Bearer token is empty.".to_string()));
    }
    Ok(token.trim().to_string())
}

async fn authenticate_token(
    state: &SharedAppState,
    raw_token: &str,
) -> Result<AuthenticatedSession, AppError> {
    let token_hash = hash_token(raw_token);
    let now_ms = db::now_ms();
    let row = sqlx::query(
        r#"
        SELECT token_id, device_id, profile_id, inactivity_expires_at_ms, revoked_at_ms
        FROM paired_device_tokens
        WHERE token_hash = ?
        "#,
    )
    .bind(token_hash)
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| AppError::Internal("Failed to validate token.".to_string()))?
    .ok_or_else(|| AppError::Unauthorized("Unknown bearer token.".to_string()))?;

    let token_id: String = row.get("token_id");
    let device_id: String = row.get("device_id");
    let profile_id: String = row.get("profile_id");
    let inactivity_expires_at_ms: i64 = row.get("inactivity_expires_at_ms");
    let revoked_at_ms: Option<i64> = row.get("revoked_at_ms");

    if revoked_at_ms.is_some() {
        return Err(AppError::Unauthorized(
            "Bearer token has been revoked.".to_string(),
        ));
    }
    if inactivity_expires_at_ms < now_ms {
        return Err(AppError::Unauthorized(
            "Bearer token is inactive and expired.".to_string(),
        ));
    }

    let new_expiry = now_ms + state.config.token_inactivity_window.as_millis() as i64;
    sqlx::query(
        r#"
        UPDATE paired_device_tokens
        SET last_seen_at_ms = ?, inactivity_expires_at_ms = ?
        WHERE token_id = ?
        "#,
    )
    .bind(now_ms)
    .bind(new_expiry)
    .bind(&token_id)
    .execute(&state.pool)
    .await
    .map_err(|_| AppError::Internal("Failed to refresh token activity window.".to_string()))?;

    let scope_rows = sqlx::query("SELECT scope_id FROM paired_device_scopes WHERE token_id = ?")
        .bind(&token_id)
        .fetch_all(&state.pool)
        .await
        .map_err(|_| AppError::Internal("Failed to load token scopes.".to_string()))?;

    let scopes = scope_rows
        .into_iter()
        .map(|row| row.get::<String, _>("scope_id"))
        .collect::<BTreeSet<_>>();

    Ok(AuthenticatedSession {
        token_id,
        device_id,
        profile_id,
        scopes,
        mutation_receipt: None,
    })
}

fn hash_token(raw_token: &str) -> String {
    let digest = Sha256::digest(raw_token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;
    use crate::syncd::config::{SyncdAdvertisedEndpointResolver, SyncdConfig};
    use crate::syncd::db::{connect, ensure_test_token, expire_token_now, upsert_server_identity};
    use crate::syncd::discovery::{
        SyncdClientDiscoveryContractProvider, SyncdClientDiscoveryGuidanceProvider,
        SyncdDiscoveryDescriptorProvider, SyncdDiscoveryProviderManager,
    };
    use crate::syncd::models::AppState;
    use std::sync::Arc;
    use tempfile::tempdir;
    use tokio::sync::{broadcast, Mutex, RwLock};

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
        let (tx, _) = broadcast::channel(16);
        let (pairing_status_sender, _) = broadcast::channel(32);
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
            change_sender: tx,
            pairing_status_sender,
            mutation_gate: Arc::new(Mutex::new(())),
            tls_cert_sha256: "fingerprint".to_string(),
        })
    }

    #[test]
    fn validates_scope_rules() {
        let session = AuthenticatedSession {
            token_id: "t".to_string(),
            device_id: "d".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from([
                "books:global".to_string(),
                "novels:profile:main".to_string(),
            ]),
            mutation_receipt: None,
        };

        assert!(validate_scope(&session, "books:global").is_ok());
        assert!(validate_scope(&session, "novels:profile:main").is_ok());
        assert!(validate_scope(&session, "novels:profile:test").is_err());
    }

    #[test]
    fn rejects_structurally_valid_scope_not_granted_to_token() {
        let session = AuthenticatedSession {
            token_id: "t".to_string(),
            device_id: "d".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["novels:profile:main".to_string()]),
            mutation_receipt: None,
        };

        assert!(validate_scope(&session, "novels:profile:main").is_ok());
        assert!(validate_scope(&session, "books:global").is_err());

        let session = AuthenticatedSession {
            token_id: "t".to_string(),
            device_id: "d".to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from(["books:global".to_string()]),
            mutation_receipt: None,
        };

        assert!(validate_scope(&session, "books:global").is_ok());
        assert!(validate_scope(&session, "novels:profile:main").is_err());
    }

    #[tokio::test]
    async fn validates_client_headers() {
        let state = build_state().await;
        let mut headers = HeaderMap::new();
        headers.insert(CLIENT_VERSION_HEADER, HeaderValue::from_static("0.1.0"));
        headers.insert(CLIENT_PROTOCOL_HEADER, HeaderValue::from_static("1"));
        assert!(validate_client_headers(&headers, &state).is_ok());
    }

    #[tokio::test]
    async fn authenticates_and_refreshes_token() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        ensure_test_token(
            &pool,
            "device-a",
            "main",
            &hash_token("secret-token"),
            &["books:global", "novels:profile:main"],
        )
        .await
        .unwrap();
        let (tx, _) = broadcast::channel(16);
        let advertised_endpoint_resolver =
            SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let discovery_provider_manager =
            SyncdDiscoveryProviderManager::from_config(&config).unwrap();
        let initial_status =
            discovery_provider_manager.initial_status(&config, &advertised_endpoint_resolver);
        let (pairing_status_sender, _) = broadcast::channel(32);
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
            change_sender: tx,
            pairing_status_sender,
            mutation_gate: Arc::new(Mutex::new(())),
            tls_cert_sha256: "fingerprint".to_string(),
        });

        let session = authenticate_token(&state, "secret-token").await.unwrap();
        assert_eq!(session.profile_id, "main");
        assert!(session.scopes.contains("books:global"));
    }

    #[tokio::test]
    async fn rejects_inactivity_expired_token() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        ensure_test_token(
            &pool,
            "device-a",
            "main",
            &hash_token("secret-token"),
            &["books:global", "novels:profile:main"],
        )
        .await
        .unwrap();
        expire_token_now(&pool, &hash_token("secret-token"))
            .await
            .unwrap();

        let (tx, _) = broadcast::channel(16);
        let advertised_endpoint_resolver =
            SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let discovery_provider_manager =
            SyncdDiscoveryProviderManager::from_config(&config).unwrap();
        let initial_status =
            discovery_provider_manager.initial_status(&config, &advertised_endpoint_resolver);
        let (pairing_status_sender, _) = broadcast::channel(32);
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
            change_sender: tx,
            pairing_status_sender,
            mutation_gate: Arc::new(Mutex::new(())),
            tls_cert_sha256: "fingerprint".to_string(),
        });

        let error = authenticate_token(&state, "secret-token")
            .await
            .unwrap_err();
        match error {
            AppError::Unauthorized(message) => {
                assert!(message.contains("inactive and expired"));
            }
            other => panic!("expected unauthorized for expired token, got {other:?}"),
        }
    }
}
