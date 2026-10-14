use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

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
use super::middleware::{
    CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER, CURRENT_CLIENT_VERSION,
    LEGACY_CLIENT_PROTOCOL_HEADER, LEGACY_CLIENT_VERSION_HEADER,
};
use super::models::{
    AppError, AuthenticatedSession, ErrorBody, PairingTokenResponse, SharedAppState,
    SyncdDiscoveryDescriptor,
};
use super::network::detect_lan_ip;
use super::runtime_manifest::{
    reconcile_exited_runtime_manifest, runtime_manifest_path, SyncdRuntimeManifest,
};

const SHUTDOWN_RESPONSE_DELAY: Duration = Duration::from_millis(100);
const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);
// Stable persisted device identity; the display name may be Epigraph while
// the database identity remains compatible with existing installations.
const LOCAL_AUTHORITY_DEVICE_ID: &str = "aethon-core-maintenance";
const LOCAL_AUTHORITY_PROFILE_ID: &str = "main";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownRequest {
    #[serde(default)]
    pub run_id: String,
    #[serde(default)]
    pub nonce: String,
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
    pub run_id: String,
    pub nonce: String,
    pub accepted: bool,
    pub server_id: String,
    pub pid: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SuwayomiMaintenanceAction {
    Stop,
    Start,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuwayomiMaintenanceRequest {
    #[serde(default)]
    pub run_id: String,
    #[serde(default)]
    pub nonce: String,
    pub server_id: String,
    pub expected_pid: u32,
    pub action: SuwayomiMaintenanceAction,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuwayomiMaintenanceResponse {
    pub run_id: String,
    pub nonce: String,
    pub pid: u32,
    /// The Java stopped or started; none when there was nothing running to stop.
    pub java_pid: Option<u32>,
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
    let identity = verify_local_control(
        &state,
        &session,
        remote_addr,
        "Core shutdown",
        &request.run_id,
        &request.nonce,
        &request.server_id,
        request.expected_pid,
    )
    .await?;

    static CONTROL_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _control = CONTROL_GATE.lock().await;
    if coordinator.subscribe().borrow().is_some() {
        return Err(AppError::Forbidden("Core shutdown already pending; request not accepted".into()));
    }
    if state.config.ownership_mode == super::config::SyncdOwnershipMode::PersistentAttached {
        super::suwayomi_process::prepare_shutdown().await.map_err(AppError::Internal)?;
    }
    let accepted = coordinator.request(request.clone());
    Ok((
        StatusCode::ACCEPTED,
        Json(ShutdownResponse {
            run_id: request.run_id,
            nonce: request.nonce,
            accepted,
            server_id: identity.server_id,
            pid: std::process::id(),
        }),
    ))
}

/// Stops or starts the main profile's Suwayomi for the Epigraph process that holds its runtime for
/// maintenance; see `suwayomi_process::stop_main_for_maintenance`.
pub async fn post_local_suwayomi_maintenance(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Json(request): Json<SuwayomiMaintenanceRequest>,
) -> Result<Json<SuwayomiMaintenanceResponse>, AppError> {
    verify_local_control(
        &state,
        &session,
        remote_addr,
        "Core Suwayomi maintenance",
        &request.run_id,
        &request.nonce,
        &request.server_id,
        request.expected_pid,
    )
    .await?;
    if state.config.ownership_mode != super::config::SyncdOwnershipMode::PersistentAttached {
        return Err(AppError::Forbidden(
            "This Core does not run the main Suwayomi profile.".to_string(),
        ));
    }
    let java_pid = match request.action {
        SuwayomiMaintenanceAction::Stop => {
            super::suwayomi_process::stop_main_for_maintenance().await
        }
        SuwayomiMaintenanceAction::Start => {
            super::suwayomi_process::start_main_for_maintenance().await.map(Some)
        }
    }
    .map_err(AppError::Internal)?;
    Ok(Json(SuwayomiMaintenanceResponse {
        run_id: request.run_id,
        nonce: request.nonce,
        pid: std::process::id(),
        java_pid,
    }))
}

/// Checks a local control request: loopback, a local-authority token, and this exact Core run and
/// identity. Returns the Core identity.
async fn verify_local_control(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    remote_addr: SocketAddr,
    what: &str,
    run_id: &str,
    nonce: &str,
    server_id: &str,
    expected_pid: u32,
) -> Result<super::db::ServerIdentityRow, AppError> {
    if !remote_addr.ip().is_loopback() {
        return Err(AppError::Forbidden(format!(
            "{what} is only available from loopback."
        )));
    }
    if !session.token_id.starts_with("local-authority-") {
        return Err(AppError::Forbidden(format!(
            "{what} requires a local-authority token."
        )));
    }
    if expected_pid != std::process::id() {
        return Err(AppError::Forbidden(format!(
            "{what} PID does not match the running process."
        )));
    }
    if run_id != crate::syncd::runtime_manifest::current_run_id()
        || uuid::Uuid::parse_str(nonce).ok().is_none_or(|id| id.is_nil() || id.to_string() != nonce) {
        return Err(AppError::Forbidden("Core control run or nonce mismatch".into()));
    }

    let identity = super::db::load_server_identity(&state.pool)
        .await
        .map_err(|_| AppError::Internal("Failed to load Core identity.".to_string()))?;
    if server_id != identity.server_id {
        return Err(AppError::Forbidden(format!(
            "{what} serverId does not match the running server."
        )));
    }
    Ok(identity)
}

/// Asks the running Core to stop or start the main profile's Suwayomi while this process holds the
/// Suwayomi runtime for maintenance.
pub async fn request_suwayomi_maintenance(
    data_dir: &Path,
    action: SuwayomiMaintenanceAction,
    timeout: Duration,
) -> anyhow::Result<Option<u32>> {
    tokio::time::timeout(timeout, async {
        let manifest_path = runtime_manifest_path(data_dir);
        if reconcile_exited_runtime_manifest(&manifest_path) {
            bail!("Epigraph Core is not running");
        }
        let original = std::fs::read(&manifest_path).context("Missing Core ownership")?;
        let manifest: SyncdRuntimeManifest =
            serde_json::from_slice(&original).context("Malformed Core evidence preserved")?;
        manifest.validate().map_err(anyhow::Error::msg)?;
        let client = build_pinned_client(&manifest.fingerprint)?;
        let descriptor = fetch_descriptor(&client, &manifest).await?;
        verify_runtime_identity(&manifest, &descriptor)?;
        let token = issue_local_authority_token(&client, &manifest).await?;
        let nonce = uuid::Uuid::new_v4().to_string();
        let response = client
            .post(format!(
                "https://127.0.0.1:{}/v1/local/suwayomi-maintenance",
                manifest.port
            ))
            .timeout(timeout)
            .header("authorization", format!("Bearer {}", token.access_token))
            .header(CLIENT_VERSION_HEADER, CURRENT_CLIENT_VERSION)
            .header(LEGACY_CLIENT_VERSION_HEADER, CURRENT_CLIENT_VERSION)
            .header(CLIENT_PROTOCOL_HEADER, "1")
            .header(LEGACY_CLIENT_PROTOCOL_HEADER, "1")
            .json(&SuwayomiMaintenanceRequest {
                run_id: manifest.run_id.clone(),
                nonce: nonce.clone(),
                server_id: manifest.server_id.clone(),
                expected_pid: manifest.pid,
                action,
            })
            .send()
            .await
            .context("failed to reach Epigraph Core")?;
        if !response.status().is_success() {
            let status = response.status();
            let detail = response
                .json::<ErrorBody>()
                .await
                .map(|body| body.error.message)
                .unwrap_or_else(|_| "Core rejected the request".to_string());
            bail!("Core Suwayomi {action:?} failed with {status}: {detail}");
        }
        let response = response
            .json::<SuwayomiMaintenanceResponse>()
            .await
            .context("Core returned an invalid maintenance response")?;
        if response.run_id != manifest.run_id || response.nonce != nonce || response.pid != manifest.pid {
            bail!("Core maintenance acknowledgement identity mismatch");
        }
        Ok(response.java_pid)
    })
    .await
    .context("Epigraph Core did not answer in time")?
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
        other => bail!("unsupported epigraph-syncd command '{other}'"),
    }
}

async fn run_serve_command(arguments: Vec<std::ffi::OsString>) -> anyhow::Result<()> {
    match arguments.as_slice() {
        [] => super::app::run().await,
        [mode] if mode == "--lan" => {
            let lan_ip = detect_lan_ip()?;
            let port = SyncdConfig::from_env().bind_addr.port();
            std::env::set_var("EPIGRAPH_SYNCD_BIND_HOST", "0.0.0.0");
            std::env::set_var("EPIGRAPH_SYNCD_OWNERSHIP", "persistent-attached");
            std::env::set_var(
                "EPIGRAPH_SYNCD_ADVERTISED_BASE_URL",
                lan_advertised_base_url(lan_ip, port),
            );
            super::app::run().await
        }
        _ => bail!("serve accepts only the optional --lan argument"),
    }
}

fn lan_advertised_base_url(lan_ip: IpAddr, port: u16) -> String {
    let host = match lan_ip {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    format!("https://{host}:{port}")
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
    Ok(())
}

fn run_autostart_command(arguments: Vec<std::ffi::OsString>) -> anyhow::Result<()> {
    let [action] = arguments.as_slice() else {
        bail!("autostart requires exactly one action: install, remove, or status");
    };
    let executable = std::env::current_exe()
        .context("failed to resolve Epigraph Core executable")?
        .canonicalize()
        .context("failed to canonicalize Epigraph Core executable")?;
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

pub async fn request_persistent_shutdown(
    data_dir: &Path,
    reason: ShutdownReason,
    timeout: Duration,
) -> anyhow::Result<bool> {
    tokio::time::timeout(timeout, request_shutdown_inner(data_dir, reason, timeout, None))
        .await.context("Core shutdown deadline exceeded; evidence retained")?
}

pub async fn request_exact_shutdown(data_dir: &Path, reason: ShutdownReason, timeout: Duration, expected: &SyncdRuntimeManifest) -> anyhow::Result<bool> {
    tokio::time::timeout(timeout, request_shutdown_inner(data_dir, reason, timeout, Some(expected)))
        .await.context("Exact Core shutdown deadline exceeded; evidence retained")?
}

async fn request_shutdown_inner(data_dir: &Path, reason: ShutdownReason, timeout: Duration, retained: Option<&SyncdRuntimeManifest>) -> anyhow::Result<bool> {
    let manifest_path = runtime_manifest_path(data_dir);
    // Nothing to stop when no Core ever ran here, it already stopped gracefully, or it was ended
    // by a reboot/crash. Installer hooks and repeated requests rely on this being idempotent.
    if reconcile_exited_runtime_manifest(&manifest_path) {
        return Ok(false);
    }
    let original = std::fs::read(&manifest_path).context("Missing Core ownership; graceful/manual reconciliation required")?;
    let manifest: SyncdRuntimeManifest = serde_json::from_slice(&original).context("Malformed Core evidence preserved")?;
    manifest.validate().map_err(anyhow::Error::msg)?;
    if retained.is_some_and(|expected| expected != &manifest) { bail!("Core run evidence differs from retained spawn; control refused"); }
    if uuid::Uuid::parse_str(&manifest.run_id).ok().is_none_or(|id| id.is_nil() || id.to_string() != manifest.run_id) {
        bail!("Legacy Core run identity missing; process and evidence preserved");
    }
    #[cfg(windows)]
    let process = {
        use crate::suwayomi_runtime::ownership::ProcessObject;
        let expected = manifest.process_identity.as_ref().and_then(|i| i.for_termination()).context("Core birth identity missing")?;
        let process = crate::suwayomi_runtime::ownership::windows::Process::open(manifest.pid, crate::suwayomi_runtime::command_line_hash).map_err(anyhow::Error::msg)?;
        if process.identity().map_err(anyhow::Error::msg)? != expected { bail!("Core process identity changed"); }
        process
    };
    #[cfg(not(windows))]
    bail!("Retained Core exit proof unavailable on this platform");
    let client = build_pinned_client(&manifest.fingerprint)?;
    let descriptor = fetch_descriptor(&client, &manifest).await?;
    verify_runtime_identity(&manifest, &descriptor)?;

    let token = issue_local_authority_token(&client, &manifest).await?;
    let url = format!("https://127.0.0.1:{}/v1/local/shutdown", manifest.port);
    let nonce = uuid::Uuid::new_v4().to_string();
    if std::fs::read(&manifest_path).ok().as_deref() != Some(original.as_slice()) { bail!("Core evidence changed"); }
    let response = client
        .post(url)
        .header("authorization", format!("Bearer {}", token.access_token))
        .header(CLIENT_VERSION_HEADER, CURRENT_CLIENT_VERSION)
        .header(LEGACY_CLIENT_VERSION_HEADER, CURRENT_CLIENT_VERSION)
        .header(CLIENT_PROTOCOL_HEADER, "1")
        .header(LEGACY_CLIENT_PROTOCOL_HEADER, "1")
        .json(&ShutdownRequest {
            run_id: manifest.run_id.clone(),
            nonce: nonce.clone(),
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
    if !response.accepted || response.run_id != manifest.run_id || response.nonce != nonce
        || response.server_id != manifest.server_id || response.pid != manifest.pid {
        bail!("Core shutdown acknowledgement identity mismatch");
    }

    #[cfg(windows)]
    {
        use crate::suwayomi_runtime::ownership::ProcessObject;
        tokio::task::spawn_blocking(move || process.wait(timeout.as_millis().min(u32::MAX as u128) as u32))
            .await?.map_err(anyhow::Error::msg)?;
        if std::fs::read(&manifest_path).ok().as_deref() != Some(original.as_slice()) { bail!("Core evidence replaced; completion receipt refused"); }
        crate::suwayomi_runtime::record_confirmed_stop(&manifest_path, &original).map_err(anyhow::Error::msg)?;
    }
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
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &rustls::crypto::CryptoProvider::get_default().ok_or_else(|| RustlsError::General("Crypto provider unavailable".into()))?.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &rustls::crypto::CryptoProvider::get_default().ok_or_else(|| RustlsError::General("Crypto provider unavailable".into()))?.signature_verification_algorithms)
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
        .timeout(Duration::from_secs(30))
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
    fn lan_advertisement_uses_the_effective_configured_port() {
        assert_eq!(
            lan_advertised_base_url("192.168.1.20".parse().unwrap(), 4779),
            "https://192.168.1.20:4779"
        );
        assert_eq!(
            lan_advertised_base_url("::1".parse().unwrap(), 4780),
            "https://[::1]:4780"
        );
    }

    #[test]
    fn coordinator_accepts_only_the_first_shutdown_request() {
        let (coordinator, receiver) = ShutdownCoordinator::channel();
        let first = ShutdownRequest {
            run_id: crate::syncd::runtime_manifest::current_run_id().into(),
            nonce: uuid::Uuid::new_v4().to_string(),
            server_id: "server-a".to_string(),
            expected_pid: 10,
            reason: ShutdownReason::PreUpdate,
        };
        let second = ShutdownRequest {
            run_id: crate::syncd::runtime_manifest::current_run_id().into(),
            nonce: uuid::Uuid::new_v4().to_string(),
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
            run_id: crate::syncd::runtime_manifest::current_run_id().into(),
            nonce: uuid::Uuid::new_v4().to_string(),
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
        let mut config = SyncdConfig::for_test(temp.path().to_path_buf());
        config.ownership_mode = super::super::config::SyncdOwnershipMode::EphemeralOwned;
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

    #[tokio::test]
    async fn b1_shutdown_rejects_missing_foreign_and_nil_run_or_nonce() {
        let (_temp, state) = test_state().await;
        let identity = super::super::db::load_server_identity(&state.pool).await.unwrap();
        let token = issue_test_local_token(&state.pool, &state.config, LOCAL_AUTHORITY_DEVICE_ID, LOCAL_AUTHORITY_PROFILE_ID).await.unwrap();
        let (coordinator, receiver) = ShutdownCoordinator::channel();
        let app = super::super::app::build_test_router_with_shutdown(state, coordinator);
        for (field, value) in [("runId", ""), ("runId", "3de1e5e7-51b8-4527-932f-62262013a814"),
            ("nonce", ""), ("nonce", "00000000-0000-0000-0000-000000000000")] {
            let req = shutdown_http_request(&token.access_token, &identity.server_id, "127.0.0.1:61234");
            let (parts, body) = req.into_parts();
            let mut value_json: serde_json::Value = serde_json::from_slice(&body.collect().await.unwrap().to_bytes()).unwrap();
            value_json[field] = serde_json::json!(value);
            let response = app.clone().oneshot(Request::from_parts(parts, Body::from(serde_json::to_vec(&value_json).unwrap()))).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{field}");
            assert!(receiver.borrow().is_none());
        }
    }

    #[tokio::test]
    async fn suwayomi_maintenance_route_is_local_and_for_the_persistent_core_only() {
        let (_temp, state) = test_state().await;
        let identity = super::super::db::load_server_identity(&state.pool).await.unwrap();
        let token = issue_test_local_token(&state.pool, &state.config, LOCAL_AUTHORITY_DEVICE_ID, LOCAL_AUTHORITY_PROFILE_ID).await.unwrap();
        assert_ne!(state.config.ownership_mode, super::super::config::SyncdOwnershipMode::PersistentAttached);
        let (coordinator, _receiver) = ShutdownCoordinator::channel();
        let app = super::super::app::build_test_router_with_shutdown(state, coordinator);
        let request = |remote: &str, run_id: String| {
            Request::post("/v1/local/suwayomi-maintenance")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {}", token.access_token))
                .header(CLIENT_VERSION_HEADER, CURRENT_CLIENT_VERSION)
                .header(LEGACY_CLIENT_VERSION_HEADER, CURRENT_CLIENT_VERSION)
                .header(CLIENT_PROTOCOL_HEADER, "1")
                .header(LEGACY_CLIENT_PROTOCOL_HEADER, "1")
                .extension(ConnectInfo(remote.parse::<SocketAddr>().unwrap()))
                .body(Body::from(
                    serde_json::to_vec(&SuwayomiMaintenanceRequest {
                        run_id,
                        nonce: uuid::Uuid::new_v4().to_string(),
                        server_id: identity.server_id.clone(),
                        expected_pid: std::process::id(),
                        action: SuwayomiMaintenanceAction::Stop,
                    })
                    .unwrap(),
                ))
                .unwrap()
        };
        let current = || crate::syncd::runtime_manifest::current_run_id().to_string();
        for (remote, run_id) in [
            ("192.168.1.20:61234", current()),
            ("127.0.0.1:61234", "3de1e5e7-51b8-4527-932f-62262013a814".to_string()),
            // Exact identity, but this Core does not run the main profile.
            ("127.0.0.1:61234", current()),
        ] {
            let response = app.clone().oneshot(request(remote, run_id.clone())).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{remote} {run_id}");
        }
    }

    fn shutdown_http_request(token: &str, server_id: &str, remote: &str) -> Request<Body> {
        Request::post("/v1/local/shutdown")
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {token}"))
            .header(CLIENT_VERSION_HEADER, CURRENT_CLIENT_VERSION)
            .header(LEGACY_CLIENT_VERSION_HEADER, CURRENT_CLIENT_VERSION)
            .header(CLIENT_PROTOCOL_HEADER, "1")
            .header(LEGACY_CLIENT_PROTOCOL_HEADER, "1")
            .extension(ConnectInfo(remote.parse::<SocketAddr>().unwrap()))
            .body(Body::from(
                serde_json::to_vec(&ShutdownRequest {
                    run_id: crate::syncd::runtime_manifest::current_run_id().into(),
                    nonce: uuid::Uuid::new_v4().to_string(),
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
