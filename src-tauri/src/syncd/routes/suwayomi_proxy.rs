use std::sync::OnceLock;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::extract::{Path, Request, State};
use axum::http::header::{
    ACCEPT, ACCEPT_ENCODING, ACCEPT_LANGUAGE, ACCEPT_RANGES, CACHE_CONTROL, CONTENT_DISPOSITION,
    CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, EXPIRES,
    IF_MODIFIED_SINCE, IF_NONE_MATCH, IF_RANGE, LAST_MODIFIED, RANGE, VARY,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use futures_util::StreamExt;
use reqwest::redirect::Policy;
use serde_json::json;
use url::{Host, Url};

use crate::syncd::models::{AuthenticatedSession, ErrorBody, ErrorDetail, SharedAppState};
use crate::syncd::suwayomi_process;

const MAX_PROXY_PATH_BYTES: usize = 2_048;
const MAX_PROXY_QUERY_BYTES: usize = 16 * 1_024;
const MAX_GRAPHQL_BODY_BYTES: usize = 2 * 1024 * 1024;

static PROXY_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub async fn get_or_head(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(path): Path<String>,
    request: Request,
) -> Response {
    proxy_http(state, session, path, request, false).await
}

pub async fn post_graphql(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(path): Path<String>,
    request: Request,
) -> Response {
    if path.trim_end_matches('/') != "api/graphql" {
        return proxy_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "SUWAYOMI_PROXY_POST_NOT_ALLOWED",
            "POST is only allowed for the Suwayomi GraphQL endpoint.",
            false,
        );
    }
    let content_type_is_json = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
        });
    if !content_type_is_json {
        return proxy_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "SUWAYOMI_PROXY_CONTENT_TYPE_REQUIRED",
            "Suwayomi GraphQL requests must use application/json.",
            false,
        );
    }
    proxy_http(state, session, path, request, true).await
}

async fn proxy_http(
    state: SharedAppState,
    session: AuthenticatedSession,
    path: String,
    request: Request,
    include_body: bool,
) -> Response {
    let raw_query = request.uri().query().unwrap_or_default();
    let (scope_id, upstream_query) = match extract_scope_query(raw_query) {
        Ok(value) => value,
        Err(message) => {
            return proxy_error(StatusCode::BAD_REQUEST, "BAD_REQUEST", &message, false)
        }
    };
    let expected_scope = format!("comics:profile:{}", session.profile_id);
    if scope_id.as_deref() != Some(expected_scope.as_str())
        || !session.scopes.contains(&expected_scope)
    {
        return proxy_error(
            StatusCode::FORBIDDEN,
            "SUWAYOMI_PROXY_SCOPE_FORBIDDEN",
            "The comics scope is not granted to this token and paired profile.",
            false,
        );
    }

    let upstream_base = match resolve_upstream_base(&state, &session.profile_id) {
        Ok(url) => url,
        Err(message) => {
            return proxy_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "SUWAYOMI_UPSTREAM_UNAVAILABLE",
                &message,
                true,
            )
        }
    };
    let upstream_url = match build_upstream_url(upstream_base, &path, upstream_query.as_deref()) {
        Ok(url) => url,
        Err(message) => {
            return proxy_error(StatusCode::BAD_REQUEST, "BAD_REQUEST", &message, false)
        }
    };

    let (parts, body) = request.into_parts();
    let method = parts.method;
    let client = proxy_client();
    let mut upstream_request = client.request(method.clone(), upstream_url);
    upstream_request = copy_request_headers(upstream_request, &parts.headers, include_body);
    if include_body {
        let bytes = match to_bytes(body, MAX_GRAPHQL_BODY_BYTES).await {
            Ok(bytes) => bytes,
            Err(_) => {
                return proxy_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "SUWAYOMI_PROXY_BODY_TOO_LARGE",
                    "Suwayomi GraphQL request exceeds the 2 MiB limit.",
                    false,
                )
            }
        };
        upstream_request = upstream_request.body(bytes);
    }

    let upstream_response = match upstream_request.send().await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(
                profile = session.profile_id,
                error_class = proxy_reqwest_error_class(&error),
                "Suwayomi proxy upstream request failed"
            );
            return proxy_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "SUWAYOMI_UPSTREAM_UNAVAILABLE",
                "The owned Suwayomi instance is unavailable.",
                true,
            );
        }
    };

    if upstream_response.status().is_redirection() {
        tracing::warn!(
            profile = session.profile_id,
            status = upstream_response.status().as_u16(),
            "Suwayomi proxy blocked an upstream redirect"
        );
        return proxy_error(
            StatusCode::BAD_GATEWAY,
            "SUWAYOMI_UPSTREAM_REDIRECT_BLOCKED",
            "The owned Suwayomi instance returned a redirect, which the Core does not follow.",
            true,
        );
    }

    stream_upstream_response(upstream_response, method == Method::HEAD)
}

fn proxy_client() -> &'static reqwest::Client {
    PROXY_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .read_timeout(Duration::from_secs(30))
            .pool_idle_timeout(Duration::from_secs(30))
            .tcp_nodelay(true)
            .build()
            .expect("static Suwayomi proxy client configuration must be valid")
    })
}

fn copy_request_headers(
    mut request: reqwest::RequestBuilder,
    headers: &HeaderMap,
    include_body: bool,
) -> reqwest::RequestBuilder {
    let allowed = [
        ACCEPT,
        ACCEPT_LANGUAGE,
        RANGE,
        IF_RANGE,
        IF_NONE_MATCH,
        IF_MODIFIED_SINCE,
    ];
    for name in allowed {
        if let Some(value) = headers.get(&name) {
            request = request.header(name, value);
        }
    }
    if include_body {
        if let Some(value) = headers.get(CONTENT_TYPE) {
            request = request.header(CONTENT_TYPE, value);
        }
    }
    request.header(ACCEPT_ENCODING, HeaderValue::from_static("identity"))
}

fn stream_upstream_response(upstream: reqwest::Response, is_head: bool) -> Response {
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let mut builder = Response::builder().status(status);
    let response_headers = builder
        .headers_mut()
        .expect("response builder remains valid before body construction");
    for name in [
        CONTENT_TYPE,
        CONTENT_LENGTH,
        CONTENT_RANGE,
        CONTENT_DISPOSITION,
        CONTENT_ENCODING,
        ACCEPT_RANGES,
        CACHE_CONTROL,
        ETAG,
        LAST_MODIFIED,
        EXPIRES,
        VARY,
    ] {
        if let Some(value) = headers.get(&name) {
            response_headers.insert(name, value.clone());
        }
    }
    response_headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );

    let body = if is_head {
        Body::empty()
    } else {
        Body::from_stream(
            upstream
                .bytes_stream()
                .map(|item| item.map_err(std::io::Error::other)),
        )
    };
    builder.body(body).unwrap_or_else(|_| {
        proxy_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            "Failed to construct the Suwayomi proxy response.",
            true,
        )
    })
}

fn resolve_upstream_base(_state: &SharedAppState, profile_id: &str) -> Result<Url, String> {
    #[cfg(test)]
    if let Some(raw) = _state
        .config
        .suwayomi_proxy_test_upstreams
        .read()
        .map_err(|_| "The test Suwayomi upstream registry is unavailable.".to_string())?
        .get(profile_id)
        .cloned()
    {
        return validate_loopback_base_url(&raw);
    }

    let mut matching = suwayomi_process::attach_owned_instances()
        .into_iter()
        .filter(|instance| instance.profile_key == profile_id);
    let instance = matching.next().ok_or_else(|| {
        "No running Aethon-owned Suwayomi instance is available for the paired profile.".to_string()
    })?;
    if matching.next().is_some() {
        return Err(
            "Multiple owned Suwayomi instances claim the paired profile; proxying was refused."
                .to_string(),
        );
    }
    validate_loopback_base_url(&instance.server_url)
}

fn validate_loopback_base_url(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw).map_err(|_| "Owned Suwayomi URL is invalid.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
        || url.port_or_known_default().is_none()
    {
        return Err("Owned Suwayomi URL failed the loopback proxy policy.".to_string());
    }

    match url.host() {
        Some(Host::Ipv4(address)) if address.is_loopback() => {}
        Some(Host::Ipv6(address)) if address.is_loopback() => {}
        Some(Host::Domain(domain)) if domain.eq_ignore_ascii_case("localhost") => {
            url.set_host(Some("127.0.0.1"))
                .map_err(|_| "Owned Suwayomi URL host is invalid.".to_string())?;
        }
        _ => return Err("Owned Suwayomi URL is not loopback.".to_string()),
    }
    url.set_path("/");
    Ok(url)
}

fn build_upstream_url(mut base: Url, path: &str, query: Option<&str>) -> Result<Url, String> {
    if path.is_empty() || path.len() > MAX_PROXY_PATH_BYTES {
        return Err("Suwayomi proxy path is empty or too long.".to_string());
    }
    let segments = path.split('/').collect::<Vec<_>>();
    if segments.iter().any(|segment| {
        segment.is_empty()
            || *segment == "."
            || *segment == ".."
            || segment.contains('%')
            || segment.contains('\\')
            || segment.chars().any(char::is_control)
    }) {
        return Err("Suwayomi proxy path contains an unsafe segment.".to_string());
    }
    {
        let mut target_segments = base
            .path_segments_mut()
            .map_err(|_| "Owned Suwayomi URL cannot contain path segments.".to_string())?;
        target_segments.clear();
        target_segments.extend(segments);
    }
    base.set_query(query.filter(|value| !value.is_empty()));
    Ok(base)
}

fn extract_scope_query(raw: &str) -> Result<(Option<String>, Option<String>), String> {
    if raw.len() > MAX_PROXY_QUERY_BYTES {
        return Err("Suwayomi proxy query is too long.".to_string());
    }
    let mut scope_id = None;
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        if key == "scopeId" {
            if scope_id.replace(value.into_owned()).is_some() {
                return Err("Suwayomi proxy accepts exactly one scopeId.".to_string());
            }
        } else {
            serializer.append_pair(&key, &value);
        }
    }
    let upstream_query = serializer.finish();
    Ok((
        scope_id,
        (!upstream_query.is_empty()).then_some(upstream_query),
    ))
}

fn proxy_reqwest_error_class(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_body() {
        "body"
    } else {
        "request"
    }
}

fn proxy_error(status: StatusCode, code: &str, message: &str, retryable: bool) -> Response {
    (
        status,
        Json(ErrorBody {
            error: ErrorDetail {
                code: code.to_string(),
                message: message.to_string(),
                retryable: Some(retryable),
                min_client_version: None,
                current_server_version: None,
                min_replayable_server_version: None,
                required_action: None,
                details: Some(json!({ "component": "suwayomiProxy" })),
            },
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use axum::http::{Request as HttpRequest, StatusCode};
    use axum::routing::{get, post};
    use axum::Router;
    use http_body_util::BodyExt;
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use tempfile::tempdir;
    use tokio::sync::{broadcast, Mutex, RwLock};
    use tower::ServiceExt;

    use crate::syncd::config::{SyncdAdvertisedEndpointResolver, SyncdConfig};
    use crate::syncd::db;
    use crate::syncd::discovery::{
        SyncdClientDiscoveryContractProvider, SyncdClientDiscoveryGuidanceProvider,
        SyncdDiscoveryDescriptorProvider, SyncdDiscoveryProviderManager,
    };
    use crate::syncd::middleware::{CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER};
    use crate::syncd::models::AppState;

    #[test]
    fn loopback_policy_rejects_credentials_paths_and_remote_hosts() {
        assert!(validate_loopback_base_url("http://127.0.0.1:4567").is_ok());
        assert!(validate_loopback_base_url("http://localhost:4567/").is_ok());
        assert!(validate_loopback_base_url("http://[::1]:4567/").is_ok());
        assert!(validate_loopback_base_url("http://192.168.1.2:4567").is_err());
        assert!(validate_loopback_base_url("http://user:pass@127.0.0.1:4567").is_err());
        assert!(validate_loopback_base_url("http://127.0.0.1:4567/prefix").is_err());
        assert!(validate_loopback_base_url("file:///tmp/suwayomi").is_err());
    }

    #[test]
    fn path_builder_rejects_traversal_and_preserves_safe_segments() {
        let base = validate_loopback_base_url("http://127.0.0.1:4567").unwrap();
        let built = build_upstream_url(
            base.clone(),
            "api/v1/manga/12/thumbnail",
            Some("useCache=true"),
        )
        .unwrap();
        assert_eq!(
            built.as_str(),
            "http://127.0.0.1:4567/api/v1/manga/12/thumbnail?useCache=true"
        );
        assert!(build_upstream_url(base.clone(), "api/../admin", None).is_err());
        assert!(build_upstream_url(base.clone(), "api/%252e%252e/admin", None).is_err());
        assert!(build_upstream_url(base, "https:\\evil.example", None).is_err());
    }

    #[test]
    fn scope_query_is_removed_before_forwarding() {
        let (scope, query) =
            extract_scope_query("scopeId=comics%3Aprofile%3Amain&foo=hello+world&foo=again")
                .unwrap();
        assert_eq!(scope.as_deref(), Some("comics:profile:main"));
        assert_eq!(query.as_deref(), Some("foo=hello+world&foo=again"));
        assert!(extract_scope_query("scopeId=a&scopeId=b").is_err());
    }

    async fn build_test_state(upstream_base_url: &str) -> (tempfile::TempDir, Arc<AppState>) {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        config.set_suwayomi_proxy_test_upstream("main", upstream_base_url);
        let pool = db::connect(&config).await.unwrap();
        db::upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let advertised_endpoint_resolver =
            SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let discovery_provider_manager =
            SyncdDiscoveryProviderManager::from_config(&config).unwrap();
        let initial_status =
            discovery_provider_manager.initial_status(&config, &advertised_endpoint_resolver);
        let (change_sender, _) = broadcast::channel(16);
        let (pairing_status_sender, _) = broadcast::channel(16);
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

    fn token_hash(raw: &str) -> String {
        Sha256::digest(raw.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn core_request(
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Body,
    ) -> HttpRequest<Body> {
        let mut builder = HttpRequest::builder()
            .method(method)
            .uri(uri)
            .header(CLIENT_VERSION_HEADER, "0.1.0")
            .header(CLIENT_PROTOCOL_HEADER, "1");
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        builder.body(body).unwrap()
    }

    async fn spawn_upstream() -> (String, tokio::task::JoinHandle<()>) {
        async fn graphql(headers: HeaderMap, Json(body): Json<Value>) -> Response {
            let authorization_was_forwarded = headers.contains_key("authorization");
            let host = headers
                .get("host")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            Json(json!({
                "data": body,
                "authorizationWasForwarded": authorization_was_forwarded,
                "hostWasLoopback": host.starts_with("127.0.0.1:")
            }))
            .into_response()
        }

        async fn page(headers: HeaderMap) -> Response {
            if headers.contains_key("authorization") {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            if headers.get(RANGE).and_then(|value| value.to_str().ok()) != Some("bytes=2-5") {
                return StatusCode::BAD_REQUEST.into_response();
            }
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(CONTENT_TYPE, "image/jpeg")
                .header(CONTENT_RANGE, "bytes 2-5/10")
                .header(ACCEPT_RANGES, "bytes")
                .header(ETAG, "\"page-v1\"")
                .body(Body::from("2345"))
                .unwrap()
        }

        async fn redirect() -> Response {
            Response::builder()
                .status(StatusCode::FOUND)
                .header("location", "http://169.254.169.254/latest/meta-data")
                .body(Body::empty())
                .unwrap()
        }

        let app = Router::new()
            .route("/api/graphql", post(graphql))
            .route("/api/v1/page", get(page))
            .route("/redirect", get(redirect));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), task)
    }

    #[tokio::test]
    async fn authenticated_graphql_proxy_is_profile_scoped_and_strips_core_token() {
        let (upstream_url, upstream_task) = spawn_upstream().await;
        let (_temp, state) = build_test_state(&upstream_url).await;
        let raw_token = "proxy-token";
        db::ensure_test_token(
            &state.pool,
            "android-1",
            "main",
            &token_hash(raw_token),
            &["comics:profile:main"],
        )
        .await
        .unwrap();
        let app = crate::syncd::app::build_test_router(state);

        let unauthorized = app
            .clone()
            .oneshot(core_request(
                Method::POST,
                "/v1/suwayomi/api/graphql?scopeId=comics%3Aprofile%3Amain",
                None,
                Body::from("{}"),
            ))
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let mut wrong_profile_request = core_request(
            Method::POST,
            "/v1/suwayomi/api/graphql?scopeId=comics%3Aprofile%3Atest",
            Some(raw_token),
            Body::from("{}"),
        );
        wrong_profile_request
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let wrong_profile = app.clone().oneshot(wrong_profile_request).await.unwrap();
        assert_eq!(wrong_profile.status(), StatusCode::FORBIDDEN);

        let mut request = core_request(
            Method::POST,
            "/v1/suwayomi/api/graphql?scopeId=comics%3Aprofile%3Amain",
            Some(raw_token),
            Body::from(r#"{"query":"query { __typename }"}"#),
        );
        request
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        request
            .headers_mut()
            .insert("host", HeaderValue::from_static("evil.example"));
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(payload["authorizationWasForwarded"], false);
        assert_eq!(payload["hostWasLoopback"], true);
        assert_eq!(payload["data"]["query"], "query { __typename }");
        upstream_task.abort();
    }

    #[tokio::test]
    async fn streaming_proxy_preserves_range_and_blocks_redirects() {
        let (upstream_url, upstream_task) = spawn_upstream().await;
        let (_temp, state) = build_test_state(&upstream_url).await;
        let raw_token = "range-token";
        db::ensure_test_token(
            &state.pool,
            "android-2",
            "main",
            &token_hash(raw_token),
            &["comics:profile:main"],
        )
        .await
        .unwrap();
        let app = crate::syncd::app::build_test_router(state);

        let mut page_request = core_request(
            Method::GET,
            "/v1/suwayomi/api/v1/page?scopeId=comics%3Aprofile%3Amain",
            Some(raw_token),
            Body::empty(),
        );
        page_request
            .headers_mut()
            .insert(RANGE, HeaderValue::from_static("bytes=2-5"));
        let page_response = app.clone().oneshot(page_request).await.unwrap();
        assert_eq!(page_response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            page_response.headers().get(CONTENT_RANGE).unwrap(),
            "bytes 2-5/10"
        );
        assert_eq!(page_response.headers().get(ETAG).unwrap(), "\"page-v1\"");
        assert_eq!(
            page_response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes(),
            "2345"
        );

        let redirect_response = app
            .clone()
            .oneshot(core_request(
                Method::GET,
                "/v1/suwayomi/redirect?scopeId=comics%3Aprofile%3Amain",
                Some(raw_token),
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(redirect_response.status(), StatusCode::BAD_GATEWAY);
        assert!(!redirect_response.headers().contains_key("location"));
        upstream_task.abort();
    }

    #[tokio::test]
    async fn unavailable_upstream_returns_retryable_service_unavailable() {
        let (_temp, state) = build_test_state("http://127.0.0.1:9").await;
        let raw_token = "unavailable-token";
        db::ensure_test_token(
            &state.pool,
            "android-3",
            "main",
            &token_hash(raw_token),
            &["comics:profile:main"],
        )
        .await
        .unwrap();
        let app = crate::syncd::app::build_test_router(state);
        let response = app
            .oneshot(core_request(
                Method::GET,
                "/v1/suwayomi/api/v1/page?scopeId=comics%3Aprofile%3Amain",
                Some(raw_token),
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let payload: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(payload["error"]["code"], "SUWAYOMI_UPSTREAM_UNAVAILABLE");
        assert_eq!(payload["error"]["retryable"], true);
    }

    #[tokio::test]
    async fn active_existing_tokens_receive_idempotent_comics_scope_backfill() {
        let (_temp, state) = build_test_state("http://127.0.0.1:9").await;
        db::ensure_test_token(
            &state.pool,
            "legacy-android",
            "main",
            &token_hash("legacy-token"),
            &["books:global", "novels:profile:main"],
        )
        .await
        .unwrap();

        assert_eq!(
            db::grant_comics_scopes_to_existing_tokens(&state.pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            db::grant_comics_scopes_to_existing_tokens(&state.pool)
                .await
                .unwrap(),
            0
        );
        let scope_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM paired_device_scopes
            WHERE token_id = 'token-legacy-android-main'
              AND scope_id = 'comics:profile:main'
            "#,
        )
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert_eq!(scope_count, 1);
    }
}
