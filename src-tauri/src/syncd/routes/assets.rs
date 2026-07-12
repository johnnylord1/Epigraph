use std::io::SeekFrom;
use std::path::{Path as FilePath, PathBuf};
use std::time::Duration;

use async_stream::stream;
use axum::body::{Body, Bytes};
use axum::extract::{Extension, Path, Query, State};
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, RANGE,
};
use axum::http::{HeaderMap, Response, StatusCode};
use futures_util::StreamExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::syncd::middleware::validate_scope;
use crate::syncd::models::{AppError, AuthenticatedSession, SharedAppState};

const ASSET_UPLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const STREAM_CHUNK_SIZE: usize = 64 * 1024;
static ASSET_UPLOADS: Semaphore = Semaphore::const_new(2);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetScopeQuery {
    scope_id: String,
}

pub async fn head_asset(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(raw_sha256): Path<String>,
    Query(query): Query<AssetScopeQuery>,
) -> Result<Response<Body>, AppError> {
    validate_scope(&session, &query.scope_id)?;
    let asset_id = AssetId::parse(&raw_sha256)?;
    let store = AssetStore::new(state.config.data_dir.join("assets"));
    let asset = store.authorized_asset(&asset_id, &query.scope_id).await?;

    asset_response(StatusCode::OK, &asset_id, asset.size, None, Body::empty())
}

pub async fn get_asset(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(raw_sha256): Path<String>,
    Query(query): Query<AssetScopeQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, AppError> {
    validate_scope(&session, &query.scope_id)?;
    let asset_id = AssetId::parse(&raw_sha256)?;
    let store = AssetStore::new(state.config.data_dir.join("assets"));
    let asset = store.authorized_asset(&asset_id, &query.scope_id).await?;

    let byte_range = match headers.get(RANGE) {
        Some(value) => {
            let raw = value
                .to_str()
                .map_err(|_| AppError::BadRequest("Invalid Range header.".to_string()))?;
            match ByteRange::parse(raw, asset.size) {
                Ok(range) => Some(range),
                Err(()) => return Ok(range_not_satisfiable(asset.size)),
            }
        }
        None => None,
    };

    let range = byte_range.unwrap_or(ByteRange {
        start: 0,
        end: asset.size.saturating_sub(1),
        total: asset.size,
    });
    let response_size = if asset.size == 0 { 0 } else { range.len() };
    let status = if byte_range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };

    let mut file = File::open(&asset.path)
        .await
        .map_err(|_| AppError::Internal("Failed to open asset blob.".to_string()))?;
    if response_size > 0 {
        file.seek(SeekFrom::Start(range.start))
            .await
            .map_err(|_| AppError::Internal("Failed to seek asset blob.".to_string()))?;
    }

    let body = if response_size == 0 {
        Body::empty()
    } else {
        Body::from_stream(stream! {
            let mut remaining = response_size;
            let mut buffer = vec![0u8; STREAM_CHUNK_SIZE];
            while remaining > 0 {
                let requested = remaining.min(buffer.len() as u64) as usize;
                match file.read(&mut buffer[..requested]).await {
                    Ok(0) => {
                        yield Err::<Bytes, std::io::Error>(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "asset blob ended before its recorded size",
                        ));
                        break;
                    }
                    Ok(read) => {
                        remaining -= read as u64;
                        yield Ok::<Bytes, std::io::Error>(Bytes::copy_from_slice(&buffer[..read]));
                    }
                    Err(error) => {
                        yield Err::<Bytes, std::io::Error>(error);
                        break;
                    }
                }
            }
        })
    };

    asset_response(status, &asset_id, response_size, byte_range, body)
}

pub async fn put_asset(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(raw_sha256): Path<String>,
    Query(query): Query<AssetScopeQuery>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response<Body>, AppError> {
    validate_scope(&session, &query.scope_id)?;
    let asset_id = AssetId::parse(&raw_sha256)?;
    let expected_size = parse_content_length(&headers, state.config.asset_max_upload_bytes)?;
    let permit = ASSET_UPLOADS
        .acquire()
        .await
        .map_err(|_| AppError::Internal("Asset upload service is unavailable.".to_string()))?;
    let store = AssetStore::new(state.config.data_dir.join("assets"));
    let publish_result = tokio::time::timeout(
        ASSET_UPLOAD_TIMEOUT,
        store.publish(
            &asset_id,
            &query.scope_id,
            expected_size,
            state.config.asset_max_upload_bytes,
            body,
        ),
    )
    .await;
    drop(permit);

    let outcome = publish_result
        .map_err(|_| AppError::BadRequest("Asset upload timed out.".to_string()))??;
    let status = if outcome.created {
        StatusCode::CREATED
    } else {
        StatusCode::NO_CONTENT
    };
    asset_response(status, &asset_id, 0, None, Body::empty())
}

fn parse_content_length(headers: &HeaderMap, max_bytes: u64) -> Result<Option<u64>, AppError> {
    let Some(value) = headers.get(CONTENT_LENGTH) else {
        return Ok(None);
    };
    let length = value
        .to_str()
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .ok_or_else(|| AppError::BadRequest("Invalid Content-Length header.".to_string()))?;
    if length > max_bytes {
        return Err(AppError::BadRequest(format!(
            "Asset exceeds the maximum upload size of {max_bytes} bytes."
        )));
    }
    Ok(Some(length))
}

fn asset_response(
    status: StatusCode,
    asset_id: &AssetId,
    content_length: u64,
    range: Option<ByteRange>,
    body: Body,
) -> Result<Response<Body>, AppError> {
    let mut builder = Response::builder()
        .status(status)
        .header(ACCEPT_RANGES, "bytes")
        .header(CACHE_CONTROL, "private, max-age=31536000, immutable")
        .header(CONTENT_TYPE, "application/octet-stream")
        .header(CONTENT_LENGTH, content_length.to_string())
        .header(ETAG, asset_id.etag())
        .header("x-aethon-asset-sha256", asset_id.as_str());
    if let Some(range) = range {
        builder = builder.header(
            CONTENT_RANGE,
            format!("bytes {}-{}/{}", range.start, range.end, range.total),
        );
    }
    builder
        .body(body)
        .map_err(|_| AppError::Internal("Failed to build asset response.".to_string()))
}

fn range_not_satisfiable(total: u64) -> Response<Body> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_RANGE, format!("bytes */{total}"))
        .header(CONTENT_LENGTH, "0")
        .body(Body::empty())
        .expect("static range response is valid")
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AssetId(String);

impl AssetId {
    fn parse(raw: &str) -> Result<Self, AppError> {
        if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(AppError::BadRequest(
                "Asset SHA-256 must contain exactly 64 hexadecimal characters.".to_string(),
            ));
        }
        Ok(Self(raw.to_ascii_lowercase()))
    }

    fn as_str(&self) -> &str {
        &self.0
    }

    fn prefix(&self) -> &str {
        &self.0[..2]
    }

    fn etag(&self) -> String {
        format!("\"{}\"", self.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
    total: u64,
}

impl ByteRange {
    fn parse(raw: &str, total: u64) -> Result<Self, ()> {
        let value = raw.strip_prefix("bytes=").ok_or(())?;
        if value.contains(',') || total == 0 {
            return Err(());
        }
        let (start, end) = value.split_once('-').ok_or(())?;
        if start.is_empty() {
            let suffix = end.parse::<u64>().map_err(|_| ())?;
            if suffix == 0 {
                return Err(());
            }
            let length = suffix.min(total);
            return Ok(Self {
                start: total - length,
                end: total - 1,
                total,
            });
        }

        let start = start.parse::<u64>().map_err(|_| ())?;
        if start >= total {
            return Err(());
        }
        let end = if end.is_empty() {
            total - 1
        } else {
            end.parse::<u64>().map_err(|_| ())?.min(total - 1)
        };
        if end < start {
            return Err(());
        }
        Ok(Self { start, end, total })
    }

    fn len(self) -> u64 {
        self.end - self.start + 1
    }
}

#[derive(Clone, Debug)]
struct AssetStore {
    root: PathBuf,
}

#[derive(Debug)]
struct AuthorizedAsset {
    path: PathBuf,
    size: u64,
}

#[derive(Debug)]
struct PublishOutcome {
    created: bool,
}

impl AssetStore {
    fn new(root: PathBuf) -> Self {
        Self { root }
    }

    async fn publish(
        &self,
        asset_id: &AssetId,
        scope_id: &str,
        expected_size: Option<u64>,
        max_bytes: u64,
        body: Body,
    ) -> Result<PublishOutcome, AppError> {
        let blob_parent = self.blob_parent(asset_id);
        fs::create_dir_all(&blob_parent)
            .await
            .map_err(|_| AppError::Internal("Failed to prepare asset storage.".to_string()))?;
        let staging_dir = blob_parent.join(format!(".upload-{}", Uuid::new_v4()));
        fs::create_dir(&staging_dir)
            .await
            .map_err(|_| AppError::Internal("Failed to create asset staging area.".to_string()))?;
        let mut staging = StagingUpload::new(staging_dir);
        let staging_path = staging.path().join("blob");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging_path)
            .await
            .map_err(|_| AppError::Internal("Failed to create asset staging file.".to_string()))?;

        let mut stream = body.into_data_stream();
        let mut hasher = Sha256::new();
        let mut received = 0u64;
        while let Some(next) = stream.next().await {
            let chunk =
                next.map_err(|_| AppError::BadRequest("Asset upload stream failed.".to_string()))?;
            received = received
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| AppError::BadRequest("Asset upload is too large.".to_string()))?;
            if received > max_bytes {
                return Err(AppError::BadRequest(format!(
                    "Asset exceeds the maximum upload size of {max_bytes} bytes."
                )));
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|_| AppError::Internal("Failed to write asset upload.".to_string()))?;
        }

        if let Some(expected_size) = expected_size {
            if received != expected_size {
                return Err(AppError::BadRequest(format!(
                    "Asset size mismatch: expected {expected_size} bytes, received {received}."
                )));
            }
        }
        let actual_sha256 = hex_digest(hasher.finalize());
        if actual_sha256 != asset_id.as_str() {
            return Err(AppError::BadRequest(
                "Asset bytes do not match the SHA-256 in the URL.".to_string(),
            ));
        }

        file.flush()
            .await
            .map_err(|_| AppError::Internal("Failed to flush asset upload.".to_string()))?;
        file.sync_all()
            .await
            .map_err(|_| AppError::Internal("Failed to persist asset upload.".to_string()))?;
        drop(file);

        let destination = self.blob_dir(asset_id);
        let created = match fs::rename(staging.path(), &destination).await {
            Ok(()) => {
                staging.disarm();
                true
            }
            Err(_) if fs::try_exists(&destination).await.unwrap_or(false) => {
                let existing = fs::metadata(destination.join("blob"))
                    .await
                    .map_err(|_| AppError::Internal("Stored asset is incomplete.".to_string()))?;
                if existing.len() != received {
                    return Err(AppError::Internal(
                        "Stored asset size does not match its content hash.".to_string(),
                    ));
                }
                false
            }
            Err(_) => {
                return Err(AppError::Internal(
                    "Failed to publish asset atomically.".to_string(),
                ))
            }
        };

        self.grant_scope(asset_id, scope_id).await?;
        Ok(PublishOutcome { created })
    }

    async fn authorized_asset(
        &self,
        asset_id: &AssetId,
        scope_id: &str,
    ) -> Result<AuthorizedAsset, AppError> {
        let grant = self.grant_path(asset_id, scope_id);
        let granted_scope = fs::read_to_string(&grant).await.map_err(|_| {
            AppError::not_found(
                "ASSET_NOT_FOUND",
                "Asset is not available for this scope.",
                None,
            )
        })?;
        if granted_scope != scope_id {
            return Err(AppError::not_found(
                "ASSET_NOT_FOUND",
                "Asset is not available for this scope.",
                None,
            ));
        }

        let path = self.blob_dir(asset_id).join("blob");
        let metadata = fs::metadata(&path).await.map_err(|_| {
            AppError::not_found("ASSET_NOT_FOUND", "Asset blob is not available.", None)
        })?;
        if !metadata.is_file() {
            return Err(AppError::not_found(
                "ASSET_NOT_FOUND",
                "Asset blob is not available.",
                None,
            ));
        }
        Ok(AuthorizedAsset {
            path,
            size: metadata.len(),
        })
    }

    async fn grant_scope(&self, asset_id: &AssetId, scope_id: &str) -> Result<(), AppError> {
        let grant = self.grant_path(asset_id, scope_id);
        let parent = grant
            .parent()
            .ok_or_else(|| AppError::Internal("Invalid asset grant path.".to_string()))?;
        fs::create_dir_all(parent)
            .await
            .map_err(|_| AppError::Internal("Failed to prepare asset grant.".to_string()))?;
        if let Ok(existing) = fs::read_to_string(&grant).await {
            if existing == scope_id {
                return Ok(());
            }
            return Err(AppError::Internal(
                "Asset scope grant hash collision detected.".to_string(),
            ));
        }

        let staging = parent.join(format!(".grant-{}", Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .await
            .map_err(|_| AppError::Internal("Failed to stage asset grant.".to_string()))?;
        file.write_all(scope_id.as_bytes())
            .await
            .map_err(|_| AppError::Internal("Failed to write asset grant.".to_string()))?;
        file.sync_all()
            .await
            .map_err(|_| AppError::Internal("Failed to persist asset grant.".to_string()))?;
        drop(file);
        match fs::rename(&staging, &grant).await {
            Ok(()) => Ok(()),
            Err(_) => {
                if fs::read_to_string(&grant)
                    .await
                    .is_ok_and(|existing| existing == scope_id)
                {
                    let _ = fs::remove_file(&staging).await;
                    return Ok(());
                }
                let _ = fs::remove_file(&staging).await;
                Err(AppError::Internal(
                    "Failed to publish asset grant atomically.".to_string(),
                ))
            }
        }
    }

    fn blob_parent(&self, asset_id: &AssetId) -> PathBuf {
        self.root.join("v1").join("blobs").join(asset_id.prefix())
    }

    fn blob_dir(&self, asset_id: &AssetId) -> PathBuf {
        self.blob_parent(asset_id).join(asset_id.as_str())
    }

    fn grant_path(&self, asset_id: &AssetId, scope_id: &str) -> PathBuf {
        let scope_hash = sha256_hex(scope_id.as_bytes());
        self.root
            .join("v1")
            .join("grants")
            .join(&scope_hash[..2])
            .join(scope_hash)
            .join(asset_id.as_str())
    }
}

struct StagingUpload {
    path: PathBuf,
    armed: bool,
}

impl StagingUpload {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn path(&self) -> &FilePath {
        &self.path
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StagingUpload {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_digest(Sha256::digest(bytes))
}

fn hex_digest(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::http::{HeaderValue, Method, Request};
    use http_body_util::BodyExt;
    use tempfile::tempdir;
    use tokio::sync::{broadcast, Mutex, RwLock};
    use tower::ServiceExt;

    use super::*;
    use crate::syncd::app::build_test_router;
    use crate::syncd::config::{SyncdAdvertisedEndpointResolver, SyncdConfig};
    use crate::syncd::db::{connect, ensure_test_token, upsert_server_identity};
    use crate::syncd::discovery::{
        SyncdClientDiscoveryContractProvider, SyncdClientDiscoveryGuidanceProvider,
        SyncdDiscoveryDescriptorProvider, SyncdDiscoveryProviderManager,
    };
    use crate::syncd::middleware::{CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER};
    use crate::syncd::models::AppState;

    const TOKEN: &str = "asset-test-token";
    const NOVEL_TOKEN: &str = "asset-novel-token";

    async fn build_app(max_upload_bytes: Option<u64>) -> (tempfile::TempDir, axum::Router) {
        let temp = tempdir().unwrap();
        let mut config = SyncdConfig::for_test(temp.path().to_path_buf());
        if let Some(max_upload_bytes) = max_upload_bytes {
            config.asset_max_upload_bytes = max_upload_bytes;
        }
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        ensure_test_token(
            &pool,
            "asset-device",
            "main",
            &sha256_hex(TOKEN.as_bytes()),
            &["books:global"],
        )
        .await
        .unwrap();
        ensure_test_token(
            &pool,
            "asset-novel-device",
            "main",
            &sha256_hex(NOVEL_TOKEN.as_bytes()),
            &["novels:profile:main"],
        )
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
            discovery_provider_manager,
            discovery_provider_state: Arc::new(RwLock::new(initial_status)),
            discovery_provider_runtime: Arc::new(Mutex::new(None)),
            pool,
            change_sender,
            pairing_status_sender,
            tls_cert_sha256: "fingerprint".to_string(),
        });
        (temp, build_test_router(state))
    }

    fn request(method: Method, uri: &str, token: Option<&str>, body: Body) -> Request<Body> {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(CLIENT_VERSION_HEADER, "0.1.0")
            .header(CLIENT_PROTOCOL_HEADER, "1");
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        builder.body(body).unwrap()
    }

    async fn put_bytes(
        app: &axum::Router,
        sha256: &str,
        scope: &str,
        token: &str,
        bytes: &'static [u8],
    ) -> Response<Body> {
        let uri = format!("/v1/assets/{sha256}?scopeId={scope}");
        let mut request = request(Method::PUT, &uri, Some(token), Body::from(bytes));
        request.headers_mut().insert(
            CONTENT_LENGTH,
            HeaderValue::from_str(&bytes.len().to_string()).unwrap(),
        );
        app.clone().oneshot(request).await.unwrap()
    }

    #[test]
    fn asset_id_is_strict_and_canonical() {
        let upper = "AB".repeat(32);
        assert_eq!(AssetId::parse(&upper).unwrap().as_str(), "ab".repeat(32));
        assert!(AssetId::parse("../secret").is_err());
        assert!(AssetId::parse(&format!("{}z", "a".repeat(63))).is_err());
        assert!(AssetId::parse(&"a".repeat(65)).is_err());
    }

    #[test]
    fn parses_supported_single_byte_ranges() {
        assert_eq!(
            ByteRange::parse("bytes=2-5", 10).unwrap(),
            ByteRange {
                start: 2,
                end: 5,
                total: 10
            }
        );
        assert_eq!(ByteRange::parse("bytes=7-", 10).unwrap().len(), 3);
        assert_eq!(ByteRange::parse("bytes=-4", 10).unwrap().start, 6);
        assert_eq!(ByteRange::parse("bytes=-20", 10).unwrap().start, 0);
        assert_eq!(ByteRange::parse("bytes=8-99", 10).unwrap().end, 9);
    }

    #[test]
    fn rejects_ambiguous_or_unsatisfiable_ranges() {
        assert!(ByteRange::parse("bytes=0-1,3-4", 10).is_err());
        assert!(ByteRange::parse("items=0-1", 10).is_err());
        assert!(ByteRange::parse("bytes=10-", 10).is_err());
        assert!(ByteRange::parse("bytes=5-4", 10).is_err());
        assert!(ByteRange::parse("bytes=0-0", 0).is_err());
    }

    #[tokio::test]
    async fn put_head_get_and_range_preserve_hash_and_headers() {
        let (_temp, app) = build_app(None).await;
        let bytes = b"immutable aethon asset";
        let sha256 = sha256_hex(bytes);

        let put = put_bytes(&app, &sha256, "books%3Aglobal", TOKEN, bytes).await;
        assert_eq!(put.status(), StatusCode::CREATED);
        assert_eq!(put.headers()[ETAG], format!("\"{sha256}\""));
        assert_eq!(put.headers()["x-aethon-asset-sha256"], sha256);

        let duplicate = put_bytes(&app, &sha256, "books%3Aglobal", TOKEN, bytes).await;
        assert_eq!(duplicate.status(), StatusCode::NO_CONTENT);

        let uri = format!("/v1/assets/{sha256}?scopeId=books%3Aglobal");
        let head = app
            .clone()
            .oneshot(request(Method::HEAD, &uri, Some(TOKEN), Body::empty()))
            .await
            .unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()[CONTENT_LENGTH], bytes.len().to_string());
        assert_eq!(head.headers()[ACCEPT_RANGES], "bytes");
        assert!(head
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .is_empty());

        let full = app
            .clone()
            .oneshot(request(Method::GET, &uri, Some(TOKEN), Body::empty()))
            .await
            .unwrap();
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.headers()[ETAG], format!("\"{sha256}\""));
        assert_eq!(
            full.into_body().collect().await.unwrap().to_bytes(),
            bytes.as_slice()
        );

        let mut ranged_request = request(Method::GET, &uri, Some(TOKEN), Body::empty());
        ranged_request
            .headers_mut()
            .insert(RANGE, HeaderValue::from_static("bytes=10-15"));
        let ranged = app.clone().oneshot(ranged_request).await.unwrap();
        assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            ranged.headers()[CONTENT_RANGE],
            format!("bytes 10-15/{}", bytes.len())
        );
        assert_eq!(ranged.headers()[CONTENT_LENGTH], "6");
        assert_eq!(
            ranged.into_body().collect().await.unwrap().to_bytes(),
            &bytes[10..=15]
        );
    }

    #[tokio::test]
    async fn authentication_scope_grants_and_existence_are_isolated() {
        let (_temp, app) = build_app(None).await;
        let bytes = b"scope isolated";
        let sha256 = sha256_hex(bytes);
        let put = put_bytes(&app, &sha256, "books%3Aglobal", TOKEN, bytes).await;
        assert_eq!(put.status(), StatusCode::CREATED);

        let books_uri = format!("/v1/assets/{sha256}?scopeId=books%3Aglobal");
        let unauthenticated = app
            .clone()
            .oneshot(request(Method::GET, &books_uri, None, Body::empty()))
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

        let wrong_token_scope = app
            .clone()
            .oneshot(request(
                Method::GET,
                &books_uri,
                Some(NOVEL_TOKEN),
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(wrong_token_scope.status(), StatusCode::FORBIDDEN);

        let novels_uri = format!("/v1/assets/{sha256}?scopeId=novels%3Aprofile%3Amain");
        let no_cross_scope_grant = app
            .clone()
            .oneshot(request(
                Method::GET,
                &novels_uri,
                Some(NOVEL_TOKEN),
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(no_cross_scope_grant.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn rejects_wrong_hash_size_and_oversized_uploads_without_publication() {
        let (temp, app) = build_app(Some(8)).await;
        let bytes = b"12345678";
        let wrong_sha = "a".repeat(64);
        let mismatch = put_bytes(&app, &wrong_sha, "books%3Aglobal", TOKEN, bytes).await;
        assert_eq!(mismatch.status(), StatusCode::BAD_REQUEST);

        let store = AssetStore::new(temp.path().join("assets"));
        let wrong_id = AssetId::parse(&wrong_sha).unwrap();
        assert!(!fs::try_exists(store.blob_dir(&wrong_id)).await.unwrap());

        let sha256 = sha256_hex(bytes);
        let uri = format!("/v1/assets/{sha256}?scopeId=books%3Aglobal");
        let mut truncated = request(Method::PUT, &uri, Some(TOKEN), Body::from(bytes.as_slice()));
        truncated
            .headers_mut()
            .insert(CONTENT_LENGTH, HeaderValue::from_static("9"));
        let truncated = app.clone().oneshot(truncated).await.unwrap();
        assert_eq!(truncated.status(), StatusCode::BAD_REQUEST);
        assert!(
            !fs::try_exists(store.blob_dir(&AssetId::parse(&sha256).unwrap()))
                .await
                .unwrap()
        );

        let oversized_bytes = b"123456789";
        let oversized_sha = sha256_hex(oversized_bytes);
        let oversized = put_bytes(
            &app,
            &oversized_sha,
            "books%3Aglobal",
            TOKEN,
            oversized_bytes,
        )
        .await;
        assert_eq!(oversized.status(), StatusCode::BAD_REQUEST);
        assert!(
            !fs::try_exists(store.blob_dir(&AssetId::parse(&oversized_sha).unwrap()))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn interrupted_upload_is_cleaned_and_never_published() {
        let (temp, app) = build_app(None).await;
        let complete = b"first second";
        let sha256 = sha256_hex(complete);
        let uri = format!("/v1/assets/{sha256}?scopeId=books%3Aglobal");
        let body_stream = futures_util::stream::iter(vec![
            Ok::<Bytes, std::io::Error>(Bytes::from_static(b"first ")),
            Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "simulated disconnect",
            )),
        ]);
        let response = app
            .clone()
            .oneshot(request(
                Method::PUT,
                &uri,
                Some(TOKEN),
                Body::from_stream(body_stream),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let store = AssetStore::new(temp.path().join("assets"));
        let asset_id = AssetId::parse(&sha256).unwrap();
        assert!(!fs::try_exists(store.blob_dir(&asset_id)).await.unwrap());
        let entries = std::fs::read_dir(store.blob_parent(&asset_id))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(entries.is_empty(), "staging directories must be removed");
    }

    #[tokio::test]
    async fn invalid_or_multi_range_returns_416_with_total_length() {
        let (_temp, app) = build_app(None).await;
        let bytes = b"range me";
        let sha256 = sha256_hex(bytes);
        assert_eq!(
            put_bytes(&app, &sha256, "books%3Aglobal", TOKEN, bytes)
                .await
                .status(),
            StatusCode::CREATED
        );
        let uri = format!("/v1/assets/{sha256}?scopeId=books%3Aglobal");
        let mut request = request(Method::GET, &uri, Some(TOKEN), Body::empty());
        request
            .headers_mut()
            .insert(RANGE, HeaderValue::from_static("bytes=0-1,4-5"));
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            response.headers()[CONTENT_RANGE],
            format!("bytes */{}", bytes.len())
        );
    }

    #[tokio::test]
    async fn concurrent_identical_puts_publish_once_without_partial_visibility() {
        let (_temp, app) = build_app(None).await;
        let bytes = b"concurrent immutable asset";
        let sha256 = sha256_hex(bytes);
        let first = put_bytes(&app, &sha256, "books%3Aglobal", TOKEN, bytes);
        let second = put_bytes(&app, &sha256, "books%3Aglobal", TOKEN, bytes);
        let (first, second) = tokio::join!(first, second);
        let statuses = [first.status(), second.status()];
        assert!(statuses.contains(&StatusCode::CREATED));
        assert!(statuses.contains(&StatusCode::NO_CONTENT));

        let uri = format!("/v1/assets/{sha256}?scopeId=books%3Aglobal");
        let response = app
            .clone()
            .oneshot(request(Method::GET, &uri, Some(TOKEN), Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            bytes.as_slice()
        );
    }
}
