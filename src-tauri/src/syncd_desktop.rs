use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use mdns_sd::{Receiver, ResolvedService, ServiceDaemon, ServiceEvent};
use reqwest;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error as RustlsError, SignatureScheme};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async_tls_with_config, Connector};
use url::Url;
use uuid::Uuid;

use crate::syncd::middleware::{
    CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER, CURRENT_CLIENT_VERSION,
    LEGACY_CLIENT_PROTOCOL_HEADER, LEGACY_CLIENT_VERSION_HEADER,
};
use crate::syncd::models::{
    BootstrapPayloadResponse, ErrorBody, PairedDeviceScopesUpdateRequest, PairingClaimRequest,
    PairingClaimResponse, PairingClaimStatus, PairingHostDecision, PairingHostDecisionRequest,
    PairingHostDecisionResponse, PairingPlatform, PairingSessionStatus, PairingStatusEvent,
    PairingStatusEventType, SyncdClientDiscoveryContract, SyncdClientDiscoveryGuidanceContract,
    SyncdClientDiscoveryUsageHint, SyncdEffectiveDiscoverySource, SyncdPairedDeviceView,
};
use crate::syncd_sidecar;

const SYNCD_DISCOVERY_SERVICE_NAME: &str = "_epigraph-sync._tcp.local.";
const LEGACY_SYNCD_DISCOVERY_SERVICE_NAME: &str = "_aethon-sync._tcp.local.";
const CLIENT_PROTOCOL_VERSION: u32 = 1;
const EVENT_DESKTOP_STATE: &str = "syncd-desktop-state";
const EVENT_PAIRING_STATUS: &str = "syncd-pairing-status";
const EVENT_RECONNECT_STATUS: &str = "syncd-reconnect-status";
const DISCOVERY_BROWSE_TIMEOUT: Duration = Duration::from_secs(5);
const HOST_DECISION_TIMEOUT: Duration = Duration::from_secs(8);
const PAIRING_LISTENER_RETRY_DELAY: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncdDesktopConnectionStatus {
    Idle,
    Pending,
    Claimed,
    Approved,
    Rejected,
    Expired,
    Connected,
    Unreachable,
    NeedsReauth,
    TlsMismatch,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdBootstrapBundle {
    pub pairing_session_id: String,
    pub pairing_code: String,
    pub syncd_base_url: String,
    pub profile_id: String,
    pub expires_at_ms: i64,
    pub tls_cert_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdDesktopDiscoveryCandidate {
    pub instance_name: String,
    pub server_id: String,
    pub effective_origin: String,
    pub effective_source: SyncdEffectiveDiscoverySource,
    pub discovery_origin: String,
    pub tls_cert_sha256: String,
    pub supports_bootstrap_session_create: bool,
    pub supports_bootstrap_session_fetch: bool,
    pub supports_live_pairing_status: bool,
    pub fallback_origins: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdHostPairingState {
    pub profile_id: String,
    pub session_id: String,
    pub pairing_code: String,
    pub syncd_base_url: String,
    pub local_control_url: String,
    pub advertised_base_url: String,
    pub tls_cert_sha256: String,
    pub expires_at_ms: i64,
    pub status: PairingSessionStatus,
    pub claimed_device_id: Option<String>,
    pub requested_scopes: Vec<String>,
    pub bootstrap_bundle: String,
    pub host_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdConnectState {
    pub local_profile_id: String,
    pub session_id: String,
    pub remote_profile_id: String,
    pub remote_origin: String,
    pub tls_cert_sha256: String,
    pub status: SyncdDesktopConnectionStatus,
    pub attempted_origin: String,
    pub fallback_origins: Vec<String>,
    pub claimed_device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSyncSession {
    pub session_key: String,
    pub local_profile_id: String,
    pub remote_server_id: String,
    pub remote_profile_id: String,
    pub canonical_origin: String,
    pub fallback_origins: Vec<String>,
    pub tls_cert_sha256: String,
    pub access_token: String,
    pub last_discovery_source: SyncdEffectiveDiscoverySource,
    pub last_validated_at_ms: Option<i64>,
    pub last_known_status: SyncdDesktopConnectionStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdReconnectStatus {
    pub session_key: String,
    pub local_profile_id: String,
    pub remote_origin: String,
    pub status: SyncdDesktopConnectionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdRuntimeIdentity {
    pub pid: u32,
    pub server_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdDesktopSnapshot {
    pub host: Option<SyncdHostPairingState>,
    pub connect: Option<SyncdConnectState>,
    pub runtime_identity: Option<SyncdRuntimeIdentity>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncdConnectBootstrapInput {
    pub local_profile_id: String,
    pub bootstrap_bundle: String,
    pub manual_origin: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncdDisconnectSessionInput {
    pub session_key: String,
}

#[derive(Debug, Clone)]
struct SyncdAttemptPlan {
    origin: String,
    source: SyncdEffectiveDiscoverySource,
    bootstrap_eligible: bool,
}

#[derive(Debug, Clone)]
struct SyncdRemoteBootstrapContext {
    contract: SyncdClientDiscoveryContract,
    guidance: SyncdClientDiscoveryGuidanceContract,
    bundle: SyncdBootstrapBundle,
}

#[derive(Debug, Clone)]
struct ClaimAttempt {
    origin: String,
    response: PairingClaimResponse,
    fallback_origins: Vec<String>,
    remote_server_id: String,
    discovery_source: SyncdEffectiveDiscoverySource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncdDesktopPersistedState {
    pub(crate) device_id: String,
    pub(crate) sessions: Vec<PersistedSyncSession>,
}

impl Default for SyncdDesktopPersistedState {
    fn default() -> Self {
        Self {
            device_id: format!("desktop-{}", Uuid::now_v7()),
            sessions: Vec::new(),
        }
    }
}

#[derive(Default)]
struct SyncdDesktopRuntime {
    host: Option<SyncdHostPairingState>,
    connect: Option<SyncdConnectState>,
    host_task: Option<JoinHandle<()>>,
    connect_task: Option<JoinHandle<()>>,
    runtime_identity: Option<SyncdRuntimeIdentity>,
}

#[derive(Clone, Default)]
pub struct SyncdDesktopState {
    runtime: Arc<Mutex<SyncdDesktopRuntime>>,
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
        let actual = sha256_hex(end_entity.as_ref());
        if actual.eq_ignore_ascii_case(&self.expected_fingerprint) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(RustlsError::General(
                "tls fingerprint mismatch for syncd desktop client".to_string(),
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

#[tauri::command]
pub async fn syncd_list_discovery_candidates() -> Result<Vec<SyncdDesktopDiscoveryCandidate>, String>
{
    let browser = ServiceDaemon::new().map_err(|error| error.to_string())?;
    let receiver = browser
        .browse(SYNCD_DISCOVERY_SERVICE_NAME)
        .map_err(|error| error.to_string())?;
    let legacy_receiver = browser
        .browse(LEGACY_SYNCD_DISCOVERY_SERVICE_NAME)
        .map_err(|error| error.to_string())?;
    let mut services = browse_mdns_services(receiver)?;
    services.extend(browse_mdns_services(legacy_receiver)?);
    let _ = browser.shutdown();

    let mut candidates = Vec::new();
    for service in services {
        let Some(origin) = service.get_property_val_str("origin") else {
            continue;
        };
        let Some(tls_cert_sha256) = service.get_property_val_str("tls_sha256") else {
            continue;
        };

        let client = build_pinned_http_client(tls_cert_sha256)?;
        let contract = fetch_client_contract(&client, origin).await?;
        candidates.push(SyncdDesktopDiscoveryCandidate {
            instance_name: service.get_fullname().to_string(),
            server_id: contract.server_id.clone(),
            effective_origin: contract.effective_origin.clone(),
            effective_source: contract.effective_source,
            discovery_origin: origin.to_string(),
            tls_cert_sha256: tls_cert_sha256.to_string(),
            supports_bootstrap_session_create: contract
                .capabilities
                .supports_bootstrap_session_create,
            supports_bootstrap_session_fetch: contract
                .capabilities
                .supports_bootstrap_session_fetch,
            supports_live_pairing_status: contract.capabilities.supports_live_pairing_status,
            fallback_origins: contract
                .candidates
                .iter()
                .filter(|candidate| {
                    candidate.usage_hint != SyncdClientDiscoveryUsageHint::Canonical
                })
                .map(|candidate| candidate.base_url.clone())
                .collect(),
        });
    }

    candidates.sort_by(|left, right| left.instance_name.cmp(&right.instance_name));
    candidates.dedup_by(|left, right| left.effective_origin == right.effective_origin);
    Ok(candidates)
}

#[tauri::command]
pub async fn syncd_start_host_pairing(
    profile_id: String,
    app: AppHandle,
    state: State<'_, SyncdDesktopState>,
) -> Result<SyncdHostPairingState, String> {
    automation_log(format!(
        "syncd_start_host_pairing begin profile_id={profile_id}"
    ));
    let runtime = syncd_sidecar::ensure_host_mode(&app).await?;
    reconcile_runtime_identity(&app, state.inner(), &runtime).await?;
    automation_log(format!(
        "syncd_start_host_pairing host_mode_ready profile_id={} local_base_url={} advertised_base_url={}",
        profile_id, runtime.local_base_url, runtime.advertised_base_url
    ));
    let replication_state = app.state::<crate::syncd_replication::SyncdReplicationState>();
    crate::syncd_replication::ensure_local_authority_for_profile(
        &app,
        replication_state.inner(),
        &profile_id,
        &runtime.local_base_url,
    )
    .await?;
    automation_log(format!(
        "syncd_start_host_pairing local_authority_ready profile_id={profile_id}"
    ));
    let client = insecure_local_client()?;
    let payload: BootstrapPayloadResponse = send_json_request(
        client.post(format!("{}/v1/bootstrap/session", runtime.local_base_url)),
        &json!({ "profileId": profile_id }),
    )
    .await?;
    automation_log(format!(
        "syncd_start_host_pairing bootstrap_ready session_id={} origin={}",
        payload.pairing_session_id, payload.syncd_base_url
    ));

    let bundle = SyncdBootstrapBundle {
        pairing_session_id: payload.pairing_session_id.clone(),
        pairing_code: payload.pairing_code.clone(),
        syncd_base_url: payload.syncd_base_url.clone(),
        profile_id: payload.profile_id.clone(),
        expires_at_ms: payload.expires_at_ms,
        tls_cert_sha256: payload.tls_cert_sha256.clone(),
    };
    let bootstrap_bundle =
        serde_json::to_string_pretty(&bundle).map_err(|error| error.to_string())?;
    let host = SyncdHostPairingState {
        profile_id: payload.profile_id,
        session_id: payload.pairing_session_id,
        pairing_code: payload.pairing_code,
        syncd_base_url: payload.syncd_base_url,
        local_control_url: runtime.local_base_url,
        advertised_base_url: runtime.advertised_base_url,
        tls_cert_sha256: payload.tls_cert_sha256,
        expires_at_ms: payload.expires_at_ms,
        status: PairingSessionStatus::Pending,
        claimed_device_id: None,
        requested_scopes: Vec::new(),
        bootstrap_bundle,
        host_ready: true,
        error: None,
    };

    {
        let mut runtime = state.runtime.lock().await;
        if let Some(task) = runtime.host_task.take() {
            task.abort();
        }
        runtime.host = Some(host.clone());
        runtime.host_task = Some(spawn_host_pairing_listener(
            app.clone(),
            state.inner().clone(),
            host.clone(),
        ));
    }

    emit_desktop_state(&app, state.inner()).await?;
    Ok(host)
}

#[tauri::command]
pub async fn syncd_get_active_host_pairing(
    app: AppHandle,
    state: State<'_, SyncdDesktopState>,
) -> Result<Option<SyncdHostPairingState>, String> {
    let runtime = syncd_sidecar::ensure_host_mode(&app).await?;
    reconcile_runtime_identity(&app, state.inner(), &runtime).await?;
    Ok(state.runtime.lock().await.host.clone())
}

#[tauri::command]
pub async fn syncd_get_runtime_identity(
    app: AppHandle,
    state: State<'_, SyncdDesktopState>,
) -> Result<SyncdRuntimeIdentity, String> {
    let runtime = syncd_sidecar::ensure_host_mode(&app).await?;
    reconcile_runtime_identity(&app, state.inner(), &runtime).await
}

#[tauri::command]
pub async fn syncd_connect_with_bootstrap(
    input: SyncdConnectBootstrapInput,
    app: AppHandle,
    state: State<'_, SyncdDesktopState>,
) -> Result<SyncdConnectState, String> {
    let bundle = parse_bootstrap_bundle(&input.bootstrap_bundle)?;
    let discovery_origin = input
        .manual_origin
        .as_deref()
        .map(normalize_syncd_origin)
        .transpose()?
        .unwrap_or_else(|| bundle.syncd_base_url.clone());
    automation_log(format!(
        "connect requested local_profile_id={} session={} bundle_origin={} manual_origin={:?} discovery_origin={}",
        input.local_profile_id,
        bundle.pairing_session_id,
        bundle.syncd_base_url,
        input.manual_origin,
        discovery_origin
    ));
    let context = match fetch_remote_bootstrap_context(&discovery_origin, &bundle).await {
        Ok(context) => {
            automation_log(format!(
                "connect bootstrap context ready session={} discovery_origin={} effective_origin={} canonical_origin={}",
                bundle.pairing_session_id,
                discovery_origin,
                context.contract.effective_origin,
                context.guidance.canonical_attempt.origin
            ));
            context
        }
        Err(error) => {
            automation_log(format!(
                "connect failed stage=bootstrap_context session={} discovery_origin={} error={}",
                bundle.pairing_session_id, discovery_origin, error
            ));
            return Err(error);
        }
    };
    let attempts = build_attempt_plans(&context.guidance);
    let device_id = ensure_persisted_device_id()?;
    let device_name = local_device_name();
    let claim = match claim_across_attempts(&context, &attempts, &device_id, &device_name).await {
        Ok(claim) => claim,
        Err(error) => {
            automation_log(format!(
                "connect failed stage=claim session={} discovery_origin={} error={}",
                context.bundle.pairing_session_id, discovery_origin, error
            ));
            return Err(error);
        }
    };
    automation_log(format!(
        "claim result session={} attempted_origin={} status={:?} claimed_device_id={:?}",
        context.bundle.pairing_session_id,
        claim.origin,
        claim.response.status,
        claim.response.claimed_device_id
    ));

    let mut connect_state = SyncdConnectState {
        local_profile_id: input.local_profile_id.clone(),
        session_id: context.bundle.pairing_session_id.clone(),
        remote_profile_id: claim.response.profile_id.clone(),
        remote_origin: context.contract.effective_origin.clone(),
        tls_cert_sha256: context.bundle.tls_cert_sha256.clone(),
        status: SyncdDesktopConnectionStatus::Pending,
        attempted_origin: claim.origin.clone(),
        fallback_origins: claim.fallback_origins.clone(),
        claimed_device_id: claim.response.claimed_device_id.clone(),
        session_key: None,
        error: None,
    };

    match claim.response.status {
        PairingClaimStatus::Rejected => {
            connect_state.status = SyncdDesktopConnectionStatus::Rejected;
        }
        PairingClaimStatus::Approved => {
            let token = claim
                .response
                .token
                .clone()
                .ok_or_else(|| "Approved pairing claim did not return a token.".to_string())?;
            let session = PersistedSyncSession {
                session_key: session_key(
                    &input.local_profile_id,
                    &claim.remote_server_id,
                    &claim.response.profile_id,
                ),
                local_profile_id: input.local_profile_id.clone(),
                remote_server_id: claim.remote_server_id.clone(),
                remote_profile_id: claim.response.profile_id.clone(),
                canonical_origin: context.guidance.canonical_attempt.origin.clone(),
                fallback_origins: claim.fallback_origins.clone(),
                tls_cert_sha256: context.bundle.tls_cert_sha256.clone(),
                access_token: token.access_token,
                last_discovery_source: claim.discovery_source,
                last_validated_at_ms: Some(now_ms()),
                last_known_status: SyncdDesktopConnectionStatus::Connected,
            };
            upsert_persisted_session(session.clone())?;
            crate::syncd_replication::handle_new_approved_session(
                &app,
                app.state::<crate::syncd_replication::SyncdReplicationState>()
                    .inner(),
                &session,
            )
            .await?;
            connect_state.status = SyncdDesktopConnectionStatus::Connected;
            connect_state.session_key = Some(session.session_key);
        }
        PairingClaimStatus::PendingApproval => {
            connect_state.status = SyncdDesktopConnectionStatus::Claimed;
            let listener_state = connect_state.clone();
            let listener_context = ConnectListenerContext {
                local_profile_id: input.local_profile_id.clone(),
                remote_server_id: claim.remote_server_id.clone(),
                remote_profile_id: claim.response.profile_id.clone(),
                canonical_origin: context.guidance.canonical_attempt.origin.clone(),
                attempted_origin: claim.origin.clone(),
                fallback_origins: claim.fallback_origins.clone(),
                tls_cert_sha256: context.bundle.tls_cert_sha256.clone(),
                device_id,
                device_name,
                bundle: context.bundle.clone(),
            };
            let mut runtime = state.runtime.lock().await;
            if let Some(task) = runtime.connect_task.take() {
                task.abort();
            }
            runtime.connect = Some(listener_state.clone());
            runtime.connect_task = Some(spawn_connect_pairing_listener(
                app.clone(),
                state.inner().clone(),
                listener_context,
            ));
            drop(runtime);
            emit_desktop_state(&app, state.inner()).await?;
            return Ok(listener_state);
        }
    }

    {
        let mut runtime = state.runtime.lock().await;
        runtime.connect = Some(connect_state.clone());
    }
    emit_desktop_state(&app, state.inner()).await?;
    Ok(connect_state)
}

#[tauri::command]
pub async fn syncd_host_decide_pairing(
    session_id: String,
    decision: PairingHostDecision,
    app: AppHandle,
    state: State<'_, SyncdDesktopState>,
) -> Result<SyncdHostPairingState, String> {
    let sidecar_runtime = syncd_sidecar::ensure_host_mode(&app).await?;
    reconcile_runtime_identity(&app, state.inner(), &sidecar_runtime).await?;

    let host = {
        let runtime = state.runtime.lock().await;
        runtime
            .host
            .clone()
            .ok_or_else(|| "No active host pairing session is running.".to_string())?
    };

    if host.session_id != session_id {
        return Err("Host pairing session id does not match the active session.".to_string());
    }

    let client = insecure_local_client()?;
    let response: PairingHostDecisionResponse = send_json_request(
        client
            .post(format!(
                "{}/v1/pairing/session/{}/decision",
                host.local_control_url, host.session_id
            ))
            .timeout(HOST_DECISION_TIMEOUT),
        &PairingHostDecisionRequest { decision },
    )
    .await?;

    let next = {
        let mut runtime = state.runtime.lock().await;
        let Some(current) = runtime.host.as_mut() else {
            return Err(
                "Host pairing state disappeared before the decision was applied.".to_string(),
            );
        };
        current.status = response.status;
        current.claimed_device_id = response.claimed_device_id.clone();
        current.requested_scopes = response.requested_scopes.clone();
        current.expires_at_ms = response.expires_at_ms;
        current.error = None;
        current.clone()
    };

    app.emit(EVENT_PAIRING_STATUS, &next)
        .map_err(|error| error.to_string())?;
    emit_desktop_state(&app, state.inner()).await?;
    Ok(next)
}

#[tauri::command]
pub async fn syncd_list_paired_devices(
    app: AppHandle,
) -> Result<Vec<SyncdPairedDeviceView>, String> {
    let runtime = syncd_sidecar::ensure_host_mode(&app).await?;
    let client = insecure_local_client()?;
    let response = client
        .get(format!("{}/v1/pairing/devices", runtime.local_base_url))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    parse_json_response(response).await
}

#[tauri::command]
pub async fn syncd_update_paired_device_granted_scopes(
    device_id: String,
    profile_id: String,
    granted_scopes: Vec<String>,
    app: AppHandle,
) -> Result<SyncdPairedDeviceView, String> {
    let runtime = syncd_sidecar::ensure_host_mode(&app).await?;
    let client = insecure_local_client()?;
    send_json_request(
        client.post(format!(
            "{}/v1/pairing/devices/scopes",
            runtime.local_base_url
        )),
        &PairedDeviceScopesUpdateRequest {
            device_id,
            profile_id,
            granted_scopes,
        },
    )
    .await
}

#[tauri::command]
pub async fn syncd_list_persisted_sync_sessions(
    profile_id: String,
) -> Result<Vec<PersistedSyncSession>, String> {
    let state = load_persisted_state()?;
    Ok(state
        .sessions
        .into_iter()
        .filter(|session| session.local_profile_id == profile_id)
        .collect())
}

#[tauri::command]
pub async fn syncd_revalidate_persisted_sync_sessions(
    profile_id: String,
    app: AppHandle,
    state: State<'_, SyncdDesktopState>,
) -> Result<Vec<SyncdReconnectStatus>, String> {
    let mut persisted = load_persisted_state()?;
    let mut results = Vec::new();

    for session in persisted
        .sessions
        .iter_mut()
        .filter(|entry| entry.local_profile_id == profile_id)
    {
        let result = revalidate_session(session).await;
        session.last_known_status = result.status.clone();
        if matches!(result.status, SyncdDesktopConnectionStatus::Connected) {
            session.last_validated_at_ms = Some(now_ms());
        }
        app.emit(EVENT_RECONNECT_STATUS, &result)
            .map_err(|error| error.to_string())?;
        results.push(result);
    }

    save_persisted_state(&persisted)?;

    if let Some(last) = results.last().cloned() {
        let connect_state = SyncdConnectState {
            local_profile_id: last.local_profile_id,
            session_id: String::new(),
            remote_profile_id: String::new(),
            remote_origin: last.remote_origin.clone(),
            tls_cert_sha256: String::new(),
            status: last.status,
            attempted_origin: last.remote_origin,
            fallback_origins: Vec::new(),
            claimed_device_id: None,
            session_key: Some(last.session_key),
            error: last.error,
        };
        let mut runtime = state.runtime.lock().await;
        runtime.connect = Some(connect_state);
    }

    emit_desktop_state(&app, state.inner()).await?;
    Ok(results)
}

#[tauri::command]
pub async fn syncd_disconnect_persisted_session(
    input: SyncdDisconnectSessionInput,
    app: AppHandle,
    state: State<'_, SyncdDesktopState>,
) -> Result<(), String> {
    let removed_session = load_persisted_state()?
        .sessions
        .into_iter()
        .find(|session| session.session_key == input.session_key);
    let mut persisted = load_persisted_state()?;
    persisted
        .sessions
        .retain(|session| session.session_key != input.session_key);
    save_persisted_state(&persisted)?;
    if let Some(session) = removed_session {
        crate::syncd_replication::handle_persisted_session_removed(
            &app,
            app.state::<crate::syncd_replication::SyncdReplicationState>()
                .inner(),
            &session.local_profile_id,
            &session.session_key,
        )
        .await?;
    }

    {
        let mut runtime = state.runtime.lock().await;
        if runtime
            .connect
            .as_ref()
            .and_then(|connect| connect.session_key.as_ref())
            == Some(&input.session_key)
        {
            runtime.connect = None;
        }
    }

    emit_desktop_state(&app, state.inner()).await?;
    Ok(())
}

#[derive(Debug, Clone)]
struct ConnectListenerContext {
    local_profile_id: String,
    remote_server_id: String,
    remote_profile_id: String,
    canonical_origin: String,
    attempted_origin: String,
    fallback_origins: Vec<String>,
    tls_cert_sha256: String,
    device_id: String,
    device_name: String,
    bundle: SyncdBootstrapBundle,
}

fn spawn_host_pairing_listener(
    app: AppHandle,
    state: SyncdDesktopState,
    host: SyncdHostPairingState,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let result = listen_to_pairing_status(
            &host.local_control_url,
            &host.session_id,
            &host.pairing_code,
            &host.tls_cert_sha256,
            |event| {
                let app = app.clone();
                let state = state.clone();
                async move {
                    let next = {
                        let mut runtime = state.runtime.lock().await;
                        let Some(current) = runtime.host.as_mut() else {
                            return Ok::<(), String>(());
                        };
                        current.status = event.status;
                        current.claimed_device_id = event.claimed_device_id.clone();
                        current.requested_scopes = event.requested_scopes.clone();
                        current.expires_at_ms = event.expires_at_ms;
                        current.error = None;
                        current.clone()
                    };
                    app.emit(EVENT_PAIRING_STATUS, &next)
                        .map_err(|error| error.to_string())?;
                    emit_desktop_state(&app, &state).await?;
                    Ok::<(), String>(())
                }
            },
        )
        .await;

        if let Err(error) = result {
            let mut runtime = state.runtime.lock().await;
            if let Some(current) = runtime.host.as_mut() {
                current.error = Some(error);
            }
            drop(runtime);
            let _ = emit_desktop_state(&app, &state).await;
        }
    })
}

async fn reconcile_runtime_identity(
    app: &AppHandle,
    state: &SyncdDesktopState,
    sidecar_runtime: &syncd_sidecar::SyncdRuntimeInfo,
) -> Result<SyncdRuntimeIdentity, String> {
    let next_identity = SyncdRuntimeIdentity {
        pid: sidecar_runtime.pid,
        server_id: sidecar_runtime.server_id.clone(),
    };
    let host_to_reconnect = {
        let mut runtime = state.runtime.lock().await;
        if runtime.runtime_identity.as_ref() == Some(&next_identity) {
            return Ok(next_identity);
        }

        if let Some(task) = runtime.host_task.take() {
            task.abort();
        }
        runtime.runtime_identity = Some(next_identity.clone());
        runtime.host.clone()
    };

    if let Some(host) = host_to_reconnect {
        let task = spawn_host_pairing_listener(app.clone(), state.clone(), host);
        let mut runtime = state.runtime.lock().await;
        if runtime.runtime_identity.as_ref() == Some(&next_identity) {
            runtime.host_task = Some(task);
        } else {
            task.abort();
        }
    }

    emit_desktop_state(app, state).await?;
    Ok(next_identity)
}

fn spawn_connect_pairing_listener(
    app: AppHandle,
    state: SyncdDesktopState,
    context: ConnectListenerContext,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let result = listen_to_pairing_status(
                &context.attempted_origin,
                &context.bundle.pairing_session_id,
                &context.bundle.pairing_code,
                &context.tls_cert_sha256,
                |event| {
                    let app = app.clone();
                    let state = state.clone();
                    let context = context.clone();
                    async move {
                        let next =
                            update_connect_from_pairing_event(&app, &state, &context, &event)
                                .await?;
                        app.emit(EVENT_PAIRING_STATUS, &next)
                            .map_err(|error| error.to_string())?;
                        emit_desktop_state(&app, &state).await?;
                        Ok(())
                    }
                },
            )
            .await;

            let status = {
                let runtime = state.runtime.lock().await;
                let Some(current) = runtime.connect.as_ref() else {
                    return;
                };
                if current.session_id != context.bundle.pairing_session_id {
                    return;
                }
                current.status.clone()
            };
            if connect_pairing_listener_is_terminal(&status) {
                return;
            }

            if let Err(error) = result {
                if is_tls_mismatch_error(&error) {
                    let next = {
                        let mut runtime = state.runtime.lock().await;
                        let Some(current) = runtime.connect.as_mut() else {
                            return;
                        };
                        current.status = SyncdDesktopConnectionStatus::TlsMismatch;
                        current.error = Some(error);
                        current.clone()
                    };
                    let _ = app.emit(EVENT_PAIRING_STATUS, &next);
                    let _ = emit_desktop_state(&app, &state).await;
                    return;
                }
                automation_log(format!(
                    "pairing live reconnect scheduled session={} error={error}",
                    context.bundle.pairing_session_id
                ));
            } else {
                automation_log(format!(
                    "pairing live reconnect scheduled session={} after socket close",
                    context.bundle.pairing_session_id
                ));
            }

            if now_ms() >= context.bundle.expires_at_ms {
                let next = {
                    let mut runtime = state.runtime.lock().await;
                    let Some(current) = runtime.connect.as_mut() else {
                        return;
                    };
                    current.status = SyncdDesktopConnectionStatus::Expired;
                    current.error = None;
                    current.clone()
                };
                let _ = app.emit(EVENT_PAIRING_STATUS, &next);
                let _ = emit_desktop_state(&app, &state).await;
                return;
            }

            tokio::time::sleep(PAIRING_LISTENER_RETRY_DELAY).await;
        }
    })
}

fn connect_pairing_listener_is_terminal(status: &SyncdDesktopConnectionStatus) -> bool {
    matches!(
        status,
        SyncdDesktopConnectionStatus::Connected
            | SyncdDesktopConnectionStatus::Rejected
            | SyncdDesktopConnectionStatus::Expired
            | SyncdDesktopConnectionStatus::NeedsReauth
            | SyncdDesktopConnectionStatus::TlsMismatch
    )
}

async fn update_connect_from_pairing_event(
    app: &AppHandle,
    state: &SyncdDesktopState,
    context: &ConnectListenerContext,
    event: &PairingStatusEvent,
) -> Result<SyncdConnectState, String> {
    let mut connect = {
        let mut runtime = state.runtime.lock().await;
        let Some(current) = runtime.connect.as_mut() else {
            return Err("Connect pairing state is no longer active.".to_string());
        };
        current.claimed_device_id = event.claimed_device_id.clone();
        current.status = match event.status {
            PairingSessionStatus::Pending => SyncdDesktopConnectionStatus::Pending,
            PairingSessionStatus::Claimed => SyncdDesktopConnectionStatus::Claimed,
            PairingSessionStatus::Approved => SyncdDesktopConnectionStatus::Approved,
            PairingSessionStatus::Rejected => SyncdDesktopConnectionStatus::Rejected,
            PairingSessionStatus::Expired => SyncdDesktopConnectionStatus::Expired,
        };
        current.error = None;
        current.clone()
    };

    if matches!(
        event.event_type,
        PairingStatusEventType::Approved | PairingStatusEventType::FinalTokenReady
    ) {
        let approved = claim_once(
            &context.attempted_origin,
            &context.bundle,
            &context.device_id,
            &context.device_name,
            &context.tls_cert_sha256,
        )
        .await?;
        let token = approved
            .token
            .ok_or_else(|| "Final token was not returned after approval.".to_string())?;
        let session = PersistedSyncSession {
            session_key: session_key(
                &context.local_profile_id,
                &context.remote_server_id,
                &context.remote_profile_id,
            ),
            local_profile_id: context.local_profile_id.clone(),
            remote_server_id: context.remote_server_id.clone(),
            remote_profile_id: context.remote_profile_id.clone(),
            canonical_origin: context.canonical_origin.clone(),
            fallback_origins: context.fallback_origins.clone(),
            tls_cert_sha256: context.tls_cert_sha256.clone(),
            access_token: token.access_token,
            last_discovery_source: SyncdEffectiveDiscoverySource::AdvertisedEndpoint,
            last_validated_at_ms: Some(now_ms()),
            last_known_status: SyncdDesktopConnectionStatus::Connected,
        };
        upsert_persisted_session(session.clone())?;
        crate::syncd_replication::handle_new_approved_session(
            app,
            app.state::<crate::syncd_replication::SyncdReplicationState>()
                .inner(),
            &session,
        )
        .await?;

        let mut runtime = state.runtime.lock().await;
        let Some(current) = runtime.connect.as_mut() else {
            return Err("Connect pairing state disappeared after approval.".to_string());
        };
        current.status = SyncdDesktopConnectionStatus::Connected;
        current.session_key = Some(session.session_key);
        current.error = None;
        connect = current.clone();
    }

    if matches!(
        event.event_type,
        PairingStatusEventType::Rejected | PairingStatusEventType::Expired
    ) {
        let mut runtime = state.runtime.lock().await;
        if let Some(task) = runtime.connect_task.take() {
            task.abort();
        }
    }

    Ok(connect)
}

async fn listen_to_pairing_status<F, Fut>(
    base_url: &str,
    session_id: &str,
    pairing_code: &str,
    tls_cert_sha256: &str,
    mut on_event: F,
) -> Result<(), String>
where
    F: FnMut(PairingStatusEvent) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let url = websocket_status_url(base_url, session_id, pairing_code)?;
    automation_log(format!(
        "pairing live subscribe session={session_id} url={url}"
    ));
    let connector = build_pinned_ws_connector(tls_cert_sha256)?;
    let (stream, _response) =
        connect_async_tls_with_config(url.as_str(), None, false, Some(connector))
            .await
            .map_err(|error| error.to_string())?;

    let (_write, mut read) = stream.split();
    let mut last_event: Option<PairingStatusEvent> = None;
    while let Some(message) = read.next().await {
        match message.map_err(|error| error.to_string())? {
            Message::Text(text) => {
                let event: PairingStatusEvent =
                    serde_json::from_str(&text).map_err(|error| error.to_string())?;
                automation_log(format!(
                    "pairing live event session={} type={:?} status={:?} claimed_device_id={:?}",
                    event.session_id, event.event_type, event.status, event.claimed_device_id
                ));
                last_event = Some(event.clone());
                on_event(event).await?;
            }
            Message::Close(frame) => {
                automation_log(format!(
                    "pairing live close session={session_id} frame={frame:?}"
                ));
                let close_reason = frame
                    .as_ref()
                    .map(|value| value.reason.to_string())
                    .unwrap_or_default();
                let should_synthesize_expired = matches!(
                    close_reason.as_str(),
                    "pairing_session_expired" | "pairing_session_expiry_failed"
                ) && !matches!(
                    last_event.as_ref().map(|event| event.status),
                    Some(
                        PairingSessionStatus::Rejected
                            | PairingSessionStatus::Expired
                            | PairingSessionStatus::Approved
                    )
                );

                if should_synthesize_expired {
                    if let Some(previous) = last_event.clone() {
                        on_event(PairingStatusEvent {
                            event_type: PairingStatusEventType::Expired,
                            session_id: previous.session_id,
                            profile_id: previous.profile_id,
                            status: PairingSessionStatus::Expired,
                            expires_at_ms: previous.expires_at_ms,
                            claimed_device_id: previous.claimed_device_id,
                            requested_scopes: previous.requested_scopes,
                        })
                        .await?;
                    }
                }
                break;
            }
            Message::Ping(_) | Message::Pong(_) | Message::Binary(_) | Message::Frame(_) => {}
        }
    }

    Ok(())
}

async fn fetch_remote_bootstrap_context(
    discovery_origin: &str,
    bundle: &SyncdBootstrapBundle,
) -> Result<SyncdRemoteBootstrapContext, String> {
    let client = build_pinned_http_client(&bundle.tls_cert_sha256)?;
    let contract = fetch_client_contract(&client, discovery_origin).await?;
    if !contract
        .tls_cert_sha256
        .eq_ignore_ascii_case(&bundle.tls_cert_sha256)
    {
        return Err(
            "Discovery contract TLS fingerprint did not match the bootstrap bundle.".to_string(),
        );
    }
    let guidance = fetch_client_guidance(&client, discovery_origin).await?;
    let payload =
        fetch_bootstrap_payload(&client, discovery_origin, &bundle.pairing_session_id).await?;
    if payload.pairing_session_id != bundle.pairing_session_id
        || payload.pairing_code != bundle.pairing_code
    {
        return Err(
            "Fetched bootstrap payload did not match the supplied bootstrap bundle.".to_string(),
        );
    }
    if !payload
        .tls_cert_sha256
        .eq_ignore_ascii_case(&bundle.tls_cert_sha256)
    {
        return Err(
            "Fetched bootstrap payload TLS fingerprint did not match the supplied bundle."
                .to_string(),
        );
    }

    Ok(SyncdRemoteBootstrapContext {
        contract,
        guidance,
        bundle: payload.into(),
    })
}

async fn claim_across_attempts(
    context: &SyncdRemoteBootstrapContext,
    attempts: &[SyncdAttemptPlan],
    device_id: &str,
    device_name: &str,
) -> Result<ClaimAttempt, String> {
    let mut connection_errors = Vec::new();

    for (index, attempt) in attempts.iter().enumerate() {
        if !attempt.bootstrap_eligible {
            continue;
        }

        match claim_once(
            &attempt.origin,
            &context.bundle,
            device_id,
            device_name,
            &context.bundle.tls_cert_sha256,
        )
        .await
        {
            Ok(response) => {
                let fallback_origins = attempts
                    .iter()
                    .skip(index + 1)
                    .filter(|candidate| candidate.bootstrap_eligible)
                    .map(|candidate| candidate.origin.clone())
                    .collect::<Vec<_>>();
                return Ok(ClaimAttempt {
                    origin: attempt.origin.clone(),
                    response,
                    fallback_origins,
                    remote_server_id: context.contract.server_id.clone(),
                    discovery_source: attempt.source,
                });
            }
            Err(error) if is_connection_error(&error) => {
                connection_errors.push(format!("{} ({error})", attempt.origin));
                if !context.guidance.behavior.continue_on_connection_failure {
                    break;
                }
            }
            Err(error) => return Err(error),
        }
    }

    Err(if connection_errors.is_empty() {
        "No bootstrap-eligible discovery candidate was available.".to_string()
    } else {
        format!(
            "Unable to reach any discovery candidate: {}",
            connection_errors.join(", ")
        )
    })
}

async fn claim_once(
    origin: &str,
    bundle: &SyncdBootstrapBundle,
    device_id: &str,
    device_name: &str,
    tls_cert_sha256: &str,
) -> Result<PairingClaimResponse, String> {
    let client = build_pinned_http_client(tls_cert_sha256)?;
    let response = send_json(
        client.post(format!("{origin}/v1/pairing/claim")),
        &PairingClaimRequest {
            session_id: bundle.pairing_session_id.clone(),
            pairing_code: bundle.pairing_code.clone(),
            device_id: device_id.to_string(),
            device_name: device_name.to_string(),
            platform: PairingPlatform::Desktop,
            client_version: CURRENT_CLIENT_VERSION.to_string(),
            client_protocol_version: CLIENT_PROTOCOL_VERSION,
            requested_scopes: None,
        },
    )
    .await?;

    if response.status().is_success() {
        return parse_json_response(response).await;
    }

    let status = response.status();
    let body: Result<ErrorBody, _> = parse_json_response(response).await;
    let message = body
        .map(|payload| payload.error.message)
        .unwrap_or_else(|_| format!("Pairing claim failed with HTTP {status}."));

    if status.as_u16() == 410 || message.to_ascii_lowercase().contains("expired") {
        Err("Pairing session expired before approval.".to_string())
    } else if status.as_u16() == 401 {
        Err("Pairing request failed authorization checks.".to_string())
    } else if status.as_u16() == 403 {
        Err("Pairing request was rejected by the remote host.".to_string())
    } else if status.as_u16() == 404 {
        Err("Pairing session was not found on the remote host.".to_string())
    } else {
        Err(message)
    }
}

pub(crate) async fn revalidate_session(session: &PersistedSyncSession) -> SyncdReconnectStatus {
    let mut attempts = vec![session.canonical_origin.clone()];
    for origin in &session.fallback_origins {
        if !attempts.contains(origin) {
            attempts.push(origin.clone());
        }
    }

    for (index, origin) in attempts.iter().enumerate() {
        match validate_token(origin, session).await {
            Ok(()) => {
                return SyncdReconnectStatus {
                    session_key: session.session_key.clone(),
                    local_profile_id: session.local_profile_id.clone(),
                    remote_origin: origin.clone(),
                    status: SyncdDesktopConnectionStatus::Connected,
                    error: None,
                };
            }
            Err(error) if is_tls_mismatch_error(&error) => {
                return SyncdReconnectStatus {
                    session_key: session.session_key.clone(),
                    local_profile_id: session.local_profile_id.clone(),
                    remote_origin: origin.clone(),
                    status: SyncdDesktopConnectionStatus::TlsMismatch,
                    error: Some(error),
                };
            }
            Err(error) if is_needs_reauth_error(&error) => {
                return SyncdReconnectStatus {
                    session_key: session.session_key.clone(),
                    local_profile_id: session.local_profile_id.clone(),
                    remote_origin: origin.clone(),
                    status: SyncdDesktopConnectionStatus::NeedsReauth,
                    error: Some(error),
                };
            }
            Err(error) if is_connection_error(&error) && index + 1 < attempts.len() => continue,
            Err(error) => {
                return SyncdReconnectStatus {
                    session_key: session.session_key.clone(),
                    local_profile_id: session.local_profile_id.clone(),
                    remote_origin: origin.clone(),
                    status: SyncdDesktopConnectionStatus::Unreachable,
                    error: Some(error),
                };
            }
        }
    }

    SyncdReconnectStatus {
        session_key: session.session_key.clone(),
        local_profile_id: session.local_profile_id.clone(),
        remote_origin: session.canonical_origin.clone(),
        status: SyncdDesktopConnectionStatus::Unreachable,
        error: Some("No discovery origin was available for revalidation.".to_string()),
    }
}

async fn validate_token(origin: &str, session: &PersistedSyncSession) -> Result<(), String> {
    let client = build_pinned_http_client(&session.tls_cert_sha256)?;
    let response = client
        .get(format!("{origin}/v1/changes"))
        .query(&[("scopeId", "books:global"), ("sinceVersion", "0")])
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header(CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(LEGACY_CLIENT_VERSION_HEADER.as_str(), CURRENT_CLIENT_VERSION)
        .header(
            CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .header(
            LEGACY_CLIENT_PROTOCOL_HEADER.as_str(),
            CLIENT_PROTOCOL_VERSION.to_string(),
        )
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if response.status().is_success() || response.status().as_u16() == 409 {
        return Ok(());
    }

    let status = response.status();
    let body: Result<ErrorBody, _> = parse_json_response(response).await;
    let message = body
        .map(|payload| payload.error.message)
        .unwrap_or_else(|_| format!("Session validation failed with HTTP {status}."));

    if status.as_u16() == 401 {
        Err(format!("needs_reauth: {message}"))
    } else {
        Err(message)
    }
}

async fn fetch_client_contract(
    client: &reqwest::Client,
    origin: &str,
) -> Result<SyncdClientDiscoveryContract, String> {
    let response = client
        .get(format!("{origin}/v1/discovery/client-contract"))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    parse_json_response(response).await
}

async fn fetch_client_guidance(
    client: &reqwest::Client,
    origin: &str,
) -> Result<SyncdClientDiscoveryGuidanceContract, String> {
    let response = client
        .get(format!("{origin}/v1/discovery/client-guidance"))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    parse_json_response(response).await
}

async fn fetch_bootstrap_payload(
    client: &reqwest::Client,
    origin: &str,
    session_id: &str,
) -> Result<BootstrapPayloadResponse, String> {
    let response = client
        .get(format!("{origin}/v1/bootstrap/session/{session_id}"))
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if response.status().is_success() {
        return parse_json_response(response).await;
    }

    let status = response.status();
    let body: Result<ErrorBody, _> = parse_json_response(response).await;
    let message = body
        .map(|payload| payload.error.message)
        .unwrap_or_else(|_| format!("Bootstrap fetch failed with HTTP {status}."));
    Err(message)
}

fn build_attempt_plans(guidance: &SyncdClientDiscoveryGuidanceContract) -> Vec<SyncdAttemptPlan> {
    let mut plans = Vec::new();
    for candidate in
        std::iter::once(&guidance.canonical_attempt).chain(guidance.fallback_attempts.iter())
    {
        if candidate.informational_only || !candidate.bootstrap_eligible {
            continue;
        }
        if plans
            .iter()
            .any(|existing: &SyncdAttemptPlan| existing.origin == candidate.origin)
        {
            continue;
        }
        plans.push(SyncdAttemptPlan {
            origin: candidate.origin.clone(),
            source: candidate.source,
            bootstrap_eligible: candidate.bootstrap_eligible,
        });
    }
    plans
}

fn browse_mdns_services(receiver: Receiver<ServiceEvent>) -> Result<Vec<ResolvedService>, String> {
    let deadline = std::time::Instant::now() + DISCOVERY_BROWSE_TIMEOUT;
    let mut services = BTreeMap::<String, ResolvedService>::new();
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(service)) if service.is_valid() => {
                services.insert(service.get_fullname().to_string(), (*service).clone());
            }
            Ok(ServiceEvent::SearchStopped(_)) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    Ok(services.into_values().collect())
}

pub(crate) fn build_pinned_http_client(tls_cert_sha256: &str) -> Result<reqwest::Client, String> {
    crate::ensure_process_rustls_crypto_provider();
    let mut tls = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(FingerprintVerifier {
            expected_fingerprint: tls_cert_sha256.trim().to_string(),
        }))
        .with_no_client_auth();
    tls.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .build()
        .map_err(|error| error.to_string())
}

fn build_pinned_ws_connector(tls_cert_sha256: &str) -> Result<Connector, String> {
    crate::ensure_process_rustls_crypto_provider();
    let mut tls = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(FingerprintVerifier {
            expected_fingerprint: tls_cert_sha256.trim().to_string(),
        }))
        .with_no_client_auth();
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Connector::Rustls(Arc::new(tls)))
}

fn insecure_local_client() -> Result<reqwest::Client, String> {
    crate::ensure_process_rustls_crypto_provider();
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| error.to_string())
}

async fn send_json<T: Serialize>(
    request: reqwest::RequestBuilder,
    payload: &T,
) -> Result<reqwest::Response, String> {
    let body = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
    request
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|error| error.to_string())
}

async fn send_json_request<TRequest: Serialize, TResponse: DeserializeOwned>(
    request: reqwest::RequestBuilder,
    payload: &TRequest,
) -> Result<TResponse, String> {
    let response = send_json(request, payload).await?;
    let response = response
        .error_for_status()
        .map_err(|error| error.to_string())?;
    parse_json_response(response).await
}

async fn parse_json_response<T: DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, String> {
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn parse_bootstrap_bundle(raw: &str) -> Result<SyncdBootstrapBundle, String> {
    let bundle: SyncdBootstrapBundle = serde_json::from_str(raw)
        .map_err(|error| format!("Invalid bootstrap bundle JSON: {error}"))?;
    if bundle.pairing_session_id.trim().is_empty()
        || bundle.pairing_code.trim().is_empty()
        || bundle.profile_id.trim().is_empty()
        || bundle.tls_cert_sha256.trim().is_empty()
    {
        return Err("Bootstrap bundle is missing required pairing fields.".to_string());
    }
    let syncd_base_url = normalize_syncd_origin(&bundle.syncd_base_url)?;
    Ok(SyncdBootstrapBundle {
        syncd_base_url,
        ..bundle
    })
}

fn normalize_syncd_origin(raw: &str) -> Result<String, String> {
    let parsed = Url::parse(raw.trim()).map_err(|error| error.to_string())?;
    if parsed.scheme() != "https" {
        return Err("Syncd origins must use https.".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("Syncd origins must include a host.".to_string());
    }
    if parsed.port().is_none() {
        return Err("Syncd origins must include an explicit port.".to_string());
    }
    if parsed.path() != "/" && !parsed.path().is_empty() {
        return Err("Syncd origins must not include a path.".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Syncd origins must not include query or fragment components.".to_string());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "Syncd origins must include a host.".to_string())?;
    let port = parsed
        .port()
        .ok_or_else(|| "Syncd origins must include an explicit port.".to_string())?;
    if host.contains(':') && !host.starts_with('[') {
        Ok(format!("https://[{host}]:{port}"))
    } else {
        Ok(format!("https://{host}:{port}"))
    }
}

fn websocket_status_url(
    base_url: &str,
    session_id: &str,
    pairing_code: &str,
) -> Result<Url, String> {
    let mut url = Url::parse(base_url).map_err(|error| error.to_string())?;
    match url.scheme() {
        "https" => url
            .set_scheme("wss")
            .map_err(|_| "Failed to build wss url.".to_string())?,
        "http" => url
            .set_scheme("ws")
            .map_err(|_| "Failed to build ws url.".to_string())?,
        _ => return Err("Unsupported base URL scheme for websocket.".to_string()),
    }
    url.set_path(&format!("/v1/bootstrap/session/{session_id}/live"));
    url.set_query(Some(&format!("pairingCode={pairing_code}")));
    Ok(url)
}

fn ensure_persisted_device_id() -> Result<String, String> {
    let mut persisted = load_persisted_state()?;
    if persisted.device_id.trim().is_empty() {
        persisted.device_id = format!("desktop-{}", Uuid::now_v7());
        save_persisted_state(&persisted)?;
    }
    Ok(persisted.device_id)
}

pub(crate) fn load_persisted_state() -> Result<SyncdDesktopPersistedState, String> {
    let path = persisted_state_path();
    if !path.exists() {
        return Ok(SyncdDesktopPersistedState::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

pub(crate) fn save_persisted_state(state: &SyncdDesktopPersistedState) -> Result<(), String> {
    let path = persisted_state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, payload).map_err(|error| error.to_string())
}

pub(crate) fn upsert_persisted_session(session: PersistedSyncSession) -> Result<(), String> {
    let mut persisted = load_persisted_state()?;
    if persisted.device_id.trim().is_empty() {
        persisted.device_id = format!("desktop-{}", Uuid::now_v7());
    }
    let index = persisted
        .sessions
        .iter()
        .position(|current| current.session_key == session.session_key);
    if let Some(index) = index {
        persisted.sessions[index] = session;
    } else {
        persisted.sessions.push(session);
    }
    save_persisted_state(&persisted)
}

fn persisted_state_path() -> PathBuf {
    desktop_state_dir().join("syncd-desktop-state.json")
}

pub(crate) fn desktop_state_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("EPIGRAPH_SYNCD_DESKTOP_STATE_DIR") {
        return PathBuf::from(path);
    }
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("Epigraph")
        .join("syncd-desktop")
}

#[cfg(test)]
static DESKTOP_STATE_DIR_ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Serializes process-wide desktop-state overrides and restores the prior
/// value even when a test unwinds. Rust tests share one environment, so a
/// plain set/remove pair can redirect another test between its write and read.
#[cfg(test)]
pub(crate) struct DesktopStateDirTestGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
    previous: Option<std::ffi::OsString>,
}

#[cfg(test)]
impl DesktopStateDirTestGuard {
    pub(crate) fn override_with(path: &std::path::Path) -> Self {
        let lock = DESKTOP_STATE_DIR_ENV_MUTEX
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = std::env::var_os("EPIGRAPH_SYNCD_DESKTOP_STATE_DIR");
        std::env::set_var("EPIGRAPH_SYNCD_DESKTOP_STATE_DIR", path);
        Self {
            _lock: lock,
            previous,
        }
    }
}

#[cfg(test)]
impl Drop for DesktopStateDirTestGuard {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.take() {
            std::env::set_var("EPIGRAPH_SYNCD_DESKTOP_STATE_DIR", previous);
        } else {
            std::env::remove_var("EPIGRAPH_SYNCD_DESKTOP_STATE_DIR");
        }
    }
}

fn automation_log_path() -> PathBuf {
    desktop_state_dir().join("syncd-desktop-automation.log")
}

fn automation_log_enabled() -> bool {
    matches!(
        std::env::var("TAURI_AUTOMATION").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE")
    ) || matches!(
        std::env::var("TAURI_WEBVIEW_AUTOMATION").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE")
    ) || std::env::var_os("LOCALAPPDATA")
        .map(|value| {
            value
                .to_string_lossy()
                .contains("syncd-native-two-instance-automation")
        })
        .unwrap_or(false)
}

fn automation_log(message: impl AsRef<str>) {
    if !automation_log_enabled() {
        return;
    }

    let path = automation_log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{}] {}", now_ms(), message.as_ref());
    }
}

fn session_key(local_profile_id: &str, remote_server_id: &str, remote_profile_id: &str) -> String {
    format!("{local_profile_id}:{remote_server_id}:{remote_profile_id}")
}

fn local_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Epigraph Desktop".to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub(crate) fn is_connection_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("connection")
        || normalized.contains("dns")
        || normalized.contains("refused")
        || normalized.contains("timed out")
        || normalized.contains("unreachable")
        || normalized.contains("tcp")
}

pub(crate) fn is_tls_mismatch_error(error: &str) -> bool {
    error
        .to_ascii_lowercase()
        .contains("tls fingerprint mismatch")
}

pub(crate) fn is_needs_reauth_error(error: &str) -> bool {
    error.to_ascii_lowercase().contains("needs_reauth")
}

async fn emit_desktop_state(app: &AppHandle, state: &SyncdDesktopState) -> Result<(), String> {
    let snapshot = {
        let runtime = state.runtime.lock().await;
        SyncdDesktopSnapshot {
            host: runtime.host.clone(),
            connect: runtime.connect.clone(),
            runtime_identity: runtime.runtime_identity.clone(),
        }
    };
    app.emit(EVENT_DESKTOP_STATE, &snapshot)
        .map_err(|error| error.to_string())?;
    Ok(())
}

impl From<BootstrapPayloadResponse> for SyncdBootstrapBundle {
    fn from(value: BootstrapPayloadResponse) -> Self {
        Self {
            pairing_session_id: value.pairing_session_id,
            pairing_code: value.pairing_code,
            syncd_base_url: value.syncd_base_url,
            profile_id: value.profile_id,
            expires_at_ms: value.expires_at_ms,
            tls_cert_sha256: value.tls_cert_sha256,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syncd::config::SyncdEffectiveDiscoveryPolicy;
    use crate::syncd::models::{
        SyncdClientDiscoveryAttemptGuidance, SyncdClientDiscoveryBehaviorGuidance,
    };

    #[test]
    fn desktop_client_version_satisfies_syncd_default() {
        let config = crate::syncd::config::SyncdConfig::for_test(PathBuf::from(
            "C:\\temp\\syncd-client-version",
        ));

        assert!(
            semver::Version::parse(CURRENT_CLIENT_VERSION).unwrap()
                >= semver::Version::parse(&config.min_client_version).unwrap()
        );
    }

    #[test]
    fn pairing_listener_retries_only_non_terminal_connection_states() {
        assert!(!connect_pairing_listener_is_terminal(
            &SyncdDesktopConnectionStatus::Claimed
        ));
        assert!(!connect_pairing_listener_is_terminal(
            &SyncdDesktopConnectionStatus::Pending
        ));
        assert!(connect_pairing_listener_is_terminal(
            &SyncdDesktopConnectionStatus::Connected
        ));
        assert!(connect_pairing_listener_is_terminal(
            &SyncdDesktopConnectionStatus::Rejected
        ));
        assert!(connect_pairing_listener_is_terminal(
            &SyncdDesktopConnectionStatus::Expired
        ));
        assert!(connect_pairing_listener_is_terminal(
            &SyncdDesktopConnectionStatus::TlsMismatch
        ));
    }

    #[test]
    fn parses_and_normalizes_bootstrap_bundle() {
        let raw = r#"{
            "pairingSessionId":"session-1",
            "pairingCode":"123456",
            "syncdBaseUrl":"https://localhost:4777/",
            "profileId":"main",
            "expiresAtMs":123,
            "tlsCertSha256":"fingerprint"
        }"#;

        let bundle = parse_bootstrap_bundle(raw).unwrap();
        assert_eq!(bundle.syncd_base_url, "https://localhost:4777");
        assert_eq!(bundle.profile_id, "main");
    }

    #[test]
    fn rejects_non_https_origins() {
        let error = normalize_syncd_origin("http://localhost:4777").unwrap_err();
        assert!(error.contains("https"));
    }

    #[test]
    fn normalizes_ipv6_literal_origins() {
        let normalized = normalize_syncd_origin("https://[::1]:4777/").unwrap();
        assert_eq!(normalized, "https://[::1]:4777");
    }

    #[test]
    fn builds_attempt_plans_without_duplicates() {
        let guidance = SyncdClientDiscoveryGuidanceContract {
            guidance_version: 1,
            contract_version: 1,
            effective_origin: "https://localhost:4777".to_string(),
            effective_source: SyncdEffectiveDiscoverySource::AdvertisedEndpoint,
            effective_policy: SyncdEffectiveDiscoveryPolicy::AdvertisedOnly,
            candidates_are_normalized_and_deduped: true,
            canonical_attempt: SyncdClientDiscoveryAttemptGuidance {
                origin: "https://localhost:4777".to_string(),
                source: SyncdEffectiveDiscoverySource::AdvertisedEndpoint,
                usage_hint: SyncdClientDiscoveryUsageHint::Canonical,
                providers: Vec::new(),
                bootstrap_eligible: true,
                live_pairing_eligible: true,
                informational_only: false,
            },
            fallback_attempts: vec![
                SyncdClientDiscoveryAttemptGuidance {
                    origin: "https://localhost:4777".to_string(),
                    source: SyncdEffectiveDiscoverySource::ManualEndpoint,
                    usage_hint: SyncdClientDiscoveryUsageHint::Fallback,
                    providers: Vec::new(),
                    bootstrap_eligible: true,
                    live_pairing_eligible: true,
                    informational_only: false,
                },
                SyncdClientDiscoveryAttemptGuidance {
                    origin: "https://192.168.1.25:4777".to_string(),
                    source: SyncdEffectiveDiscoverySource::ManualEndpoint,
                    usage_hint: SyncdClientDiscoveryUsageHint::Fallback,
                    providers: Vec::new(),
                    bootstrap_eligible: true,
                    live_pairing_eligible: true,
                    informational_only: false,
                },
            ],
            behavior: SyncdClientDiscoveryBehaviorGuidance {
                continue_on_connection_failure: true,
                continue_on_tls_mismatch: false,
                continue_on_bootstrap_rejection: false,
                continue_on_not_found_or_expired: false,
            },
        };

        let attempts = build_attempt_plans(&guidance);
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0].origin, "https://localhost:4777");
        assert_eq!(attempts[1].origin, "https://192.168.1.25:4777");
    }

    #[test]
    fn persisted_state_roundtrip_uses_override_directory() {
        let temp = tempfile::tempdir().unwrap();
        let _env = DesktopStateDirTestGuard::override_with(temp.path());
        let session = PersistedSyncSession {
            session_key: "test".to_string(),
            local_profile_id: "main".to_string(),
            remote_server_id: "server".to_string(),
            remote_profile_id: "main".to_string(),
            canonical_origin: "https://localhost:4777".to_string(),
            fallback_origins: vec!["https://192.168.0.10:4777".to_string()],
            tls_cert_sha256: "fingerprint".to_string(),
            access_token: "token".to_string(),
            last_discovery_source: SyncdEffectiveDiscoverySource::AdvertisedEndpoint,
            last_validated_at_ms: Some(10),
            last_known_status: SyncdDesktopConnectionStatus::Connected,
        };

        upsert_persisted_session(session.clone()).unwrap();
        let persisted = load_persisted_state().unwrap();
        assert_eq!(persisted.sessions, vec![session]);
    }
}
