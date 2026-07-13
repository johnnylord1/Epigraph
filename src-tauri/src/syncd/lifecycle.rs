use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use axum::extract::{ConnectInfo, Extension, State};
use axum::http::StatusCode;
use axum::response::Json;
use reqwest::Client;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error as RustlsError, SignatureScheme};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::config::SyncdConfig;
use super::middleware::{CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER};
use super::models::{
    AppError, AuthenticatedSession, ErrorBody, PairingTokenResponse, SharedAppState,
    SyncdDiscoveryDescriptor,
};
use super::runtime_manifest::{read_runtime_manifest, runtime_manifest_path, SyncdRuntimeManifest};

const SHUTDOWN_RESPONSE_DELAY: Duration = Duration::from_millis(100);
const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);
const MAINTENANCE_CLIENT_VERSION: &str = "0.1.0";
const LOCAL_AUTHORITY_DEVICE_ID: &str = "aethon-core-maintenance";
const LOCAL_AUTHORITY_PROFILE_ID: &str = "main";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownRequest {
    pub server_id: String,
    pub expected_pid: u32,
    pub reason: ShutdownReason,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ShutdownReason {
    Manual,
    Restart,
    PreUpdate,
    Uninstall,
    ParentExited,
    OsSignal,
}

impl ShutdownReason {
    fn parse_cli(value: &str) -> anyhow::Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "manual" => Ok(Self::Manual),
            "restart" => Ok(Self::Restart),
            "pre-update" => Ok(Self::PreUpdate),
            "uninstall" => Ok(Self::Uninstall),
            other => bail!("unsupported shutdown reason '{other}'"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownResponse {
    pub accepted: bool,
    pub server_id: String,
    pub pid: u32,
}

#[derive(Clone, Debug)]
pub struct ShutdownCoordinator {
    sender: watch::Sender<Option<ShutdownRequest>>,
}

impl ShutdownCoordinator {
    pub fn channel() -> (Self, watch::Receiver<Option<ShutdownRequest>>) {
        let (sender, receiver) = watch::channel(None);
        (Self { sender }, receiver)
    }

    pub fn subscribe(&self) -> watch::Receiver<Option<ShutdownRequest>> {
        self.sender.subscribe()
    }

    pub fn request(&self, request: ShutdownRequest) -> bool {
        self.sender.send_if_modified(|current| {
            if current.is_some() {
                false
            } else {
                *current = Some(request.clone());
                true
            }
        })
    }
}

pub async fn wait_for_shutdown_request(
    receiver: &mut watch::Receiver<Option<ShutdownRequest>>,
) -> Option<ShutdownRequest> {
    loop {
        if let Some(request) = receiver.borrow().clone() {
            return Some(request);
        }
        if receiver.changed().await.is_err() {
            return None;
        }
    }
}

pub async fn post_local_shutdown(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Extension(coordinator): Extension<ShutdownCoordinator>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Json(request): Json<ShutdownRequest>,
) -> Result<(StatusCode, Json<ShutdownResponse>), AppError> {
    if !remote_addr.ip().is_loopback() {
        return Err(AppError::Forbidden(
            "Core shutdown is only available from loopback.".to_string(),
        ));
    }
    if !session.token_id.starts_with("local-authority-") {
        return Err(AppError::Forbidden(
            "Core shutdown requires a local-authority token.".to_string(),
        ));
    }
    if request.expected_pid != std::process::id() {
        return Err(AppError::Forbidden(
            "Core shutdown PID does not match the running process.".to_string(),
        ));
    }

    let identity = super::db::load_server_identity(&state.pool)
        .await
        .map_err(|_| AppError::Internal("Failed to load Core identity.".to_string()))?;
    if request.server_id != identity.server_id {
        return Err(AppError::Forbidden(
            "Core shutdown serverId does not match the running server.".to_string(),
        ));
    }

    let accepted = coordinator.request(request.clone());
    Ok((
        StatusCode::ACCEPTED,
        Json(ShutdownResponse {
            accepted,
            server_id: identity.server_id,
            pid: std::process::id(),
        }),
    ))
}

pub async fn run_command_line() -> anyhow::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let Some(command) = args.next() else {
        return super::app::run().await;
    };
    match command.to_string_lossy().as_ref() {
        "serve" => run_serve_command(args.collect()).await,
        "shutdown" => run_shutdown_command(args.collect()).await,
        "autostart" => run_autostart_command(args.collect()),
        other => bail!("unsupported aethon-syncd command '{other}'"),
    }
}

async fn run_serve_command(arguments: Vec<std::ffi::OsString>) -> anyhow::Result<()> {
    match arguments.as_slice() {
        [] => super::app::run().await,
        [mode] if mode == "--lan" => {
            let lan_ip = detect_lan_ip()?;
            std::env::set_var("AETHON_SYNCD_BIND_HOST", "0.0.0.0");
            std::env::set_var("AETHON_SYNCD_OWNERSHIP", "persistent-attached");
            std::env::set_var(
                "AETHON_SYNCD_ADVERTISED_BASE_URL",
                format!("https://{lan_ip}:4777"),
            );
            super::app::run().await
        }
        _ => bail!("serve accepts only the optional --lan argument"),
    }
}

async fn run_shutdown_command(arguments: Vec<std::ffi::OsString>) -> anyhow::Result<()> {
    let mut args = arguments.into_iter();

    let mut data_dir = None;
    let mut reason = ShutdownReason::Manual;
    let mut timeout = DEFAULT_SHUTDOWN_TIMEOUT;
    while let Some(argument) = args.next() {
        match argument.to_string_lossy().as_ref() {
            "--data-dir" => {
                let value = args.next().context("--data-dir requires a path")?;
                data_dir = Some(PathBuf::from(value));
            }
            "--reason" => {
                let value = args.next().context("--reason requires a value")?;
                reason = ShutdownReason::parse_cli(&value.to_string_lossy())?;
            }
            "--timeout-seconds" => {
                let value = args.next().context("--timeout-seconds requires a value")?;
                let seconds = value
                    .to_string_lossy()
                    .parse::<u64>()
                    .context("--timeout-seconds must be a positive integer")?;
                if seconds == 0 || seconds > 300 {
                    bail!("--timeout-seconds must be between 1 and 300");
                }
                timeout = Duration::from_secs(seconds);
            }
            other => bail!("unsupported shutdown argument '{other}'"),
        }
    }

    let data_dir = data_dir.unwrap_or_else(|| SyncdConfig::from_env().data_dir);
    request_persistent_shutdown(&data_dir, reason, timeout).await?;
    if matches!(
        reason,
        ShutdownReason::PreUpdate | ShutdownReason::Uninstall
    ) {
        let stopped = super::suwayomi_process::stop_owned_instances(timeout)
            .await
            .map_err(anyhow::Error::msg)?;
        for instance in stopped {
            tracing::info!(
                profile = instance.profile_key,
                pid = instance.java_pid,
                root = %instance.root_dir.display(),
                "stopped owned Suwayomi for Core maintenance"
            );
        }
    }
    Ok(())
}

fn run_autostart_command(arguments: Vec<std::ffi::OsString>) -> anyhow::Result<()> {
    let [action] = arguments.as_slice() else {
        bail!("autostart requires exactly one action: install, remove, or status");
    };
    let executable = std::env::current_exe()
        .context("failed to resolve Aethon Core executable")?
        .canonicalize()
        .context("failed to canonicalize Aethon Core executable")?;
    match action.to_string_lossy().as_ref() {
        "install" => super::autostart::install(&executable),
        "remove" => {
            super::autostart::remove(&executable)?;
            Ok(())
        }
        "status" => {
            println!(
                "{}",
                if super::autostart::is_registered(&executable)? {
                    "registered"
                } else {
                    "not-registered"
                }
            );
            Ok(())
        }
        other => bail!("unsupported autostart action '{other}'"),
    }
}

fn detect_lan_ip() -> anyhow::Result<std::net::IpAddr> {
    use std::net::{Ipv4Addr, UdpSocket};

    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .context("failed to open LAN discovery socket")?;
    socket
        .connect((Ipv4Addr::new(8, 8, 8, 8), 80))
        .context("failed to resolve a LAN route")?;
    let ip = socket
        .local_addr()
        .context("failed to resolve local LAN address")?
        .ip();
    if ip.is_loopback() || ip.is_unspecified() {
        bail!("resolved LAN address is not reachable from another device");
    }
    Ok(ip)
}

pub async fn request_persistent_shutdown(
    data_dir: &Path,
    reason: ShutdownReason,
    timeout: Duration,
) -> anyhow::Result<bool> {
    let manifest_path = runtime_manifest_path(data_dir);
    if !manifest_path.exists() {
        return Ok(false);
    }
    let manifest = read_runtime_manifest(data_dir).map_err(anyhow::Error::msg)?;
    let client = build_pinned_client(&manifest.fingerprint)?;
    let descriptor = fetch_descriptor(&client, &manifest).await?;
    verify_runtime_identity(&manifest, &descriptor)?;

    let token = issue_local_authority_token(&client, &manifest).await?;
    let url = format!("https://127.0.0.1:{}/v1/local/shutdown", manifest.port);
    let response = client
        .post(url)
        .header("authorization", format!("Bearer {}", token.access_token))
        .header(CLIENT_VERSION_HEADER, MAINTENANCE_CLIENT_VERSION)
        .header(CLIENT_PROTOCOL_HEADER, "1")
        .json(&ShutdownRequest {
            server_id: manifest.server_id.clone(),
            expected_pid: manifest.pid,
            reason,
        })
        .send()
        .await
        .context("failed to request Core shutdown")?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response
            .json::<ErrorBody>()
            .await
            .map(|body| body.error.message)
            .unwrap_or_else(|_| "Core rejected shutdown".to_string());
        bail!("Core shutdown failed with {status}: {detail}");
    }
    let response = response
        .json::<ShutdownResponse>()
        .await
        .context("Core returned an invalid shutdown response")?;
    if response.server_id != manifest.server_id || response.pid != manifest.pid {
        bail!("Core shutdown acknowledgement identity mismatch");
    }

    wait_for_process_exit(data_dir, manifest.pid, timeout).await?;
    Ok(true)
}

async fn fetch_descriptor(
    client: &Client,
    manifest: &SyncdRuntimeManifest,
) -> anyhow::Result<SyncdDiscoveryDescriptor> {
    client
        .get(format!(
            "https://127.0.0.1:{}/v1/discovery/descriptor",
            manifest.port
        ))
        .send()
        .await
        .context("failed to probe Core identity")?
        .error_for_status()
        .context("Core identity probe was rejected")?
        .json()
        .await
        .context("Core returned an invalid discovery descriptor")
}

fn verify_runtime_identity(
    manifest: &SyncdRuntimeManifest,
    descriptor: &SyncdDiscoveryDescriptor,
) -> anyhow::Result<()> {
    if descriptor.server_id != manifest.server_id {
        bail!("Core descriptor serverId does not match runtime.json");
    }
    if !descriptor
        .tls_cert_sha256
        .eq_ignore_ascii_case(&manifest.fingerprint)
    {
        bail!("Core descriptor fingerprint does not match runtime.json");
    }
    Ok(())
}

async fn issue_local_authority_token(
    client: &Client,
    manifest: &SyncdRuntimeManifest,
) -> anyhow::Result<PairingTokenResponse> {
    client
        .post(format!(
            "https://127.0.0.1:{}/v1/local/authority-token",
            manifest.port
        ))
        .json(&serde_json::json!({
            "profileId": LOCAL_AUTHORITY_PROFILE_ID,
            "deviceId": LOCAL_AUTHORITY_DEVICE_ID,
        }))
        .send()
        .await
        .context("failed to request local Core authority token")?
        .error_for_status()
        .context("Core rejected local authority token request")?
        .json()
        .await
        .context("Core returned an invalid local authority token")
}

async fn wait_for_process_exit(data_dir: &Path, pid: u32, timeout: Duration) -> anyhow::Result<()> {
    let started = Instant::now();
    loop {
        if !runtime_manifest_path(data_dir).exists() && !process_exists(pid) {
            return Ok(());
        }
        if started.elapsed() >= timeout {
            bail!("timed out waiting for Core PID {pid} to shut down");
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

fn process_exists(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).is_some()
}

#[derive(Debug)]
struct FingerprintVerifier {
    expected_fingerprint: String,
}

impl ServerCertVerifier for FingerprintVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        use sha2::{Digest, Sha256};

        let actual = Sha256::digest(end_entity.as_ref())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if actual.eq_ignore_ascii_case(&self.expected_fingerprint) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(RustlsError::General(
                "TLS fingerprint mismatch for Core lifecycle client".to_string(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::ED25519,
        ]
    }
}

fn build_pinned_client(fingerprint: &str) -> anyhow::Result<Client> {
    super::tls::ensure_crypto_provider();
    let mut tls = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(FingerprintVerifier {
            expected_fingerprint: fingerprint.trim().to_string(),
        }))
        .with_no_client_auth();
    tls.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Client::builder()
        .use_preconfigured_tls(tls)
        .build()
        .context("failed to build pinned Core lifecycle client")
}

pub fn response_delay() -> Duration {
    SHUTDOWN_RESPONSE_DELAY
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use sha2::{Digest, Sha256};
    use tower::ServiceExt;

    use crate::syncd::config::SyncdAdvertisedEndpointResolver;
    use crate::syncd::db::{
        connect, ensure_test_token, issue_local_authority_token as issue_test_local_token,
        upsert_server_identity,
    };
    use crate::syncd::discovery::{
        SyncdClientDiscoveryContractProvider, SyncdClientDiscoveryGuidanceProvider,
        SyncdDiscoveryDescriptorProvider, SyncdDiscoveryProviderManager,
    };
    use crate::syncd::models::AppState;
    use tokio::sync::{broadcast, Mutex, RwLock};

    #[test]
    fn coordinator_accepts_only_the_first_shutdown_request() {
        let (coordinator, receiver) = ShutdownCoordinator::channel();
        let first = ShutdownRequest {
            server_id: "server-a".to_string(),
            expected_pid: 10,
            reason: ShutdownReason::PreUpdate,
        };
        let second = ShutdownRequest {
            server_id: "server-a".to_string(),
            expected_pid: 10,
            reason: ShutdownReason::Uninstall,
        };

        assert!(coordinator.request(first.clone()));
        assert!(!coordinator.request(second));
        assert_eq!(receiver.borrow().clone(), Some(first));
    }

    #[tokio::test]
    async fn wait_observes_an_existing_request() {
        let (coordinator, mut receiver) = ShutdownCoordinator::channel();
        coordinator.request(ShutdownRequest {
            server_id: "server-a".to_string(),
            expected_pid: 10,
            reason: ShutdownReason::Manual,
        });
        assert_eq!(
            wait_for_shutdown_request(&mut receiver)
                .await
                .unwrap()
                .reason,
            ShutdownReason::Manual
        );
    }

    async fn test_state() -> (tempfile::TempDir, SharedAppState) {
        let temp = tempfile::tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, &"a".repeat(64))
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
            mutation_gate: Arc::new(Mutex::new(())),
            tls_cert_sha256: "a".repeat(64),
        });
        (temp, state)
    }

    fn token_hash(raw: &str) -> String {
        Sha256::digest(raw.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn shutdown_http_request(token: &str, server_id: &str, remote: &str) -> Request<Body> {
        Request::post("/v1/local/shutdown")
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {token}"))
            .header(CLIENT_VERSION_HEADER, MAINTENANCE_CLIENT_VERSION)
            .header(CLIENT_PROTOCOL_HEADER, "1")
            .extension(ConnectInfo(remote.parse::<SocketAddr>().unwrap()))
            .body(Body::from(
                serde_json::to_vec(&ShutdownRequest {
                    server_id: server_id.to_string(),
                    expected_pid: std::process::id(),
                    reason: ShutdownReason::PreUpdate,
                })
                .unwrap(),
            ))
            .unwrap()
    }

    #[tokio::test]
    async fn shutdown_route_requires_local_authority_and_matching_identity() {
        let (_temp, state) = test_state().await;
        let identity = super::super::db::load_server_identity(&state.pool)
            .await
            .unwrap();
        let local = issue_test_local_token(
            &state.pool,
            &state.config,
            LOCAL_AUTHORITY_DEVICE_ID,
            LOCAL_AUTHORITY_PROFILE_ID,
        )
        .await
        .unwrap();
        let (coordinator, receiver) = ShutdownCoordinator::channel();
        let app = super::super::app::build_test_router_with_shutdown(state, coordinator);

        let response = app
            .oneshot(shutdown_http_request(
                &local.access_token,
                &identity.server_id,
                "127.0.0.1:61234",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let payload: ShutdownResponse =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert!(payload.accepted);
        assert_eq!(payload.server_id, identity.server_id);
        assert_eq!(
            receiver.borrow().as_ref().unwrap().reason,
            ShutdownReason::PreUpdate
        );
    }

    #[tokio::test]
    async fn shutdown_route_rejects_remote_or_paired_tokens() {
        let (_temp, state) = test_state().await;
        let identity = super::super::db::load_server_identity(&state.pool)
            .await
            .unwrap();
        ensure_test_token(
            &state.pool,
            "mobile-device",
            "main",
            &token_hash("paired-token"),
            &["books:global"],
        )
        .await
        .unwrap();
        let local = issue_test_local_token(
            &state.pool,
            &state.config,
            LOCAL_AUTHORITY_DEVICE_ID,
            LOCAL_AUTHORITY_PROFILE_ID,
        )
        .await
        .unwrap();
        let (coordinator, receiver) = ShutdownCoordinator::channel();
        let app = super::super::app::build_test_router_with_shutdown(state, coordinator);

        let paired = app
            .clone()
            .oneshot(shutdown_http_request(
                "paired-token",
                &identity.server_id,
                "127.0.0.1:61234",
            ))
            .await
            .unwrap();
        assert_eq!(paired.status(), StatusCode::FORBIDDEN);

        let remote = app
            .oneshot(shutdown_http_request(
                &local.access_token,
                &identity.server_id,
                "192.168.1.20:61234",
            ))
            .await
            .unwrap();
        assert_eq!(remote.status(), StatusCode::FORBIDDEN);
        assert!(receiver.borrow().is_none());
    }
}
