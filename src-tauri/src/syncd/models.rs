use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use std::collections::BTreeSet;
use std::net::IpAddr;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex, RwLock};
use url::Url;

use super::config::{
    SyncdAdvertisedEndpointResolver, SyncdConfig, SyncdDiscoveryProviderMode,
    SyncdEffectiveDiscoveryPolicy, SyncdManualDiscoveryProviderMode,
};
use super::discovery::{
    SyncdClientDiscoveryContractProvider, SyncdClientDiscoveryGuidanceProvider,
    SyncdDiscoveryDescriptorProvider, SyncdDiscoveryProviderManager, SyncdDiscoveryRuntimeHandle,
};

#[derive(Clone)]
pub struct AppState {
    pub config: SyncdConfig,
    pub advertised_endpoint_resolver: SyncdAdvertisedEndpointResolver,
    pub discovery_descriptor_provider: SyncdDiscoveryDescriptorProvider,
    pub client_discovery_contract_provider: SyncdClientDiscoveryContractProvider,
    pub client_discovery_guidance_provider: SyncdClientDiscoveryGuidanceProvider,
    pub discovery_provider_manager: SyncdDiscoveryProviderManager,
    pub discovery_provider_state: Arc<RwLock<SyncdDiscoveryProviderStatus>>,
    pub discovery_provider_runtime: Arc<Mutex<Option<SyncdDiscoveryRuntimeHandle>>>,
    pub pool: sqlx::SqlitePool,
    pub change_sender: broadcast::Sender<ChangeEnvelope>,
    pub pairing_status_sender: broadcast::Sender<PairingStatusEvent>,
    pub mutation_gate: Arc<Mutex<()>>,
    pub tls_cert_sha256: String,
}

pub type SharedAppState = Arc<AppState>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_client_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_server_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_replayable_server_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    Unauthorized(String),
    Forbidden(String),
    NotFound(ErrorDetail),
    Gone(ErrorDetail),
    Conflict(ErrorDetail),
    UpgradeRequired(ErrorDetail),
    ServiceUnavailable(ErrorDetail),
    Internal(String),
}

impl AppError {
    pub fn replay_window_expired(
        current_server_version: i64,
        min_replayable_server_version: i64,
    ) -> Self {
        Self::Conflict(ErrorDetail {
            code: "REPLAY_WINDOW_EXPIRED".to_string(),
            message: "Client fell behind the replay retention window.".to_string(),
            retryable: Some(false),
            min_client_version: None,
            current_server_version: Some(current_server_version),
            min_replayable_server_version: Some(min_replayable_server_version),
            required_action: Some("full_bootstrap".to_string()),
            details: None,
        })
    }

    /// A cursor beyond the newest published version can only come from an earlier server history
    /// (for example a rewound change log). The client must rebuild from a snapshot; the code stays
    /// `REPLAY_WINDOW_EXPIRED` so every client already knows how to recover.
    pub fn replay_cursor_ahead(
        cursor: i64,
        current_server_version: i64,
        min_replayable_server_version: i64,
    ) -> Self {
        Self::Conflict(ErrorDetail {
            code: "REPLAY_WINDOW_EXPIRED".to_string(),
            message: format!(
                "Client cursor {cursor} is ahead of the server history ({current_server_version})."
            ),
            retryable: Some(false),
            min_client_version: None,
            current_server_version: Some(current_server_version),
            min_replayable_server_version: Some(min_replayable_server_version),
            required_action: Some("full_bootstrap".to_string()),
            details: Some(serde_json::json!({ "reasonCode": "CURSOR_AHEAD_OF_SERVER" })),
        })
    }

    pub fn upgrade_required(
        code: impl Into<String>,
        message: impl Into<String>,
        min_client_version: Option<String>,
    ) -> Self {
        Self::UpgradeRequired(ErrorDetail {
            code: code.into(),
            message: message.into(),
            retryable: Some(false),
            min_client_version,
            current_server_version: None,
            min_replayable_server_version: None,
            required_action: Some("reconnect".to_string()),
            details: None,
        })
    }

    pub fn not_found(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self::NotFound(ErrorDetail {
            code: code.into(),
            message: message.into(),
            retryable: Some(false),
            min_client_version: None,
            current_server_version: None,
            min_replayable_server_version: None,
            required_action: None,
            details,
        })
    }

    pub fn gone(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self::Gone(ErrorDetail {
            code: code.into(),
            message: message.into(),
            retryable: Some(false),
            min_client_version: None,
            current_server_version: None,
            min_replayable_server_version: None,
            required_action: Some("reconnect".to_string()),
            details,
        })
    }

    pub fn service_unavailable(
        code: impl Into<String>,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self::ServiceUnavailable(ErrorDetail {
            code: code.into(),
            message: message.into(),
            retryable: Some(retryable),
            min_client_version: None,
            current_server_version: None,
            min_replayable_server_version: None,
            required_action: None,
            details: None,
        })
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::BadRequest(message) => (
                StatusCode::BAD_REQUEST,
                Json(ErrorBody {
                    error: ErrorDetail {
                        code: "BAD_REQUEST".to_string(),
                        message,
                        retryable: Some(false),
                        min_client_version: None,
                        current_server_version: None,
                        min_replayable_server_version: None,
                        required_action: None,
                        details: None,
                    },
                }),
            )
                .into_response(),
            AppError::Unauthorized(message) => (
                StatusCode::UNAUTHORIZED,
                Json(ErrorBody {
                    error: ErrorDetail {
                        code: "UNAUTHORIZED".to_string(),
                        message,
                        retryable: Some(false),
                        min_client_version: None,
                        current_server_version: None,
                        min_replayable_server_version: None,
                        required_action: Some("reconnect".to_string()),
                        details: None,
                    },
                }),
            )
                .into_response(),
            AppError::Forbidden(message) => (
                StatusCode::FORBIDDEN,
                Json(ErrorBody {
                    error: ErrorDetail {
                        code: "FORBIDDEN".to_string(),
                        message,
                        retryable: Some(false),
                        min_client_version: None,
                        current_server_version: None,
                        min_replayable_server_version: None,
                        required_action: None,
                        details: None,
                    },
                }),
            )
                .into_response(),
            AppError::NotFound(error) => {
                (StatusCode::NOT_FOUND, Json(ErrorBody { error })).into_response()
            }
            AppError::Gone(error) => (StatusCode::GONE, Json(ErrorBody { error })).into_response(),
            AppError::Conflict(error) => {
                (StatusCode::CONFLICT, Json(ErrorBody { error })).into_response()
            }
            AppError::UpgradeRequired(error) => {
                (StatusCode::UPGRADE_REQUIRED, Json(ErrorBody { error })).into_response()
            }
            AppError::ServiceUnavailable(error) => {
                (StatusCode::SERVICE_UNAVAILABLE, Json(ErrorBody { error })).into_response()
            }
            AppError::Internal(message) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    error: ErrorDetail {
                        code: "INTERNAL".to_string(),
                        message,
                        retryable: Some(true),
                        min_client_version: None,
                        current_server_version: None,
                        min_replayable_server_version: None,
                        required_action: None,
                        details: None,
                    },
                }),
            )
                .into_response(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesResponse {
    pub server_protocol_version: u32,
    pub min_client_version: String,
    pub supported_scopes: Vec<String>,
    pub supports_sse_replay: bool,
    pub supports_manual_ip_fallback: bool,
    pub supports_owner_transfer: bool,
    pub supports_snapshot: bool,
    pub supports_assets: bool,
    pub supports_novel_chapter_assets: bool,
    pub supports_novel_plugin_sync: bool,
    pub supports_suwayomi_proxy: bool,
    pub supports_causal_mutations_v3: bool,
    /// Portable provider identities are negotiated separately from causal mutation receipts.
    pub supports_portable_sync_v3: bool,
    /// The profile-scoped read-only catalog bridge is separate from the generic GraphQL proxy.
    pub supports_suwayomi_catalog: bool,
    /// Typed, profile-scoped details, chapters, and pages operations are available.
    pub supports_suwayomi_content: bool,
    /// Read-only inventory of extensions loaded by the managed Suwayomi runtime is available.
    pub supports_suwayomi_extension_inventory: bool,
    pub supports_suwayomi_websocket_proxy: bool,
    pub suwayomi_proxy_path_template: String,
    /// Comic catalog, library membership, categories and chapter state are
    /// authoritative in the managed Suwayomi instance.  The Core only
    /// mirrors complementary reader state and accepts confirmed commands.
    pub comic_authority_mode: String,
    pub supports_confirmed_suwayomi_commands_v1: bool,
    /// Reserved for the aggregate sync-status endpoint.  It remains false
    /// until that endpoint is available so clients never infer readiness.
    pub supports_sync_status_v1: bool,
    /// Comic entry/category/assignment deletes reach Suwayomi even when the Core never
    /// stored a record for that legacy id.
    pub supports_comic_delete_projection_without_record: bool,
    /// The confirmed command bridge accepts `CreateCategory` (name -> new id).
    pub supports_suwayomi_category_create: bool,
    /// The confirmed command bridge accepts `AddExtensionRepos` and `InstallExtension`, so a
    /// paired device can publish extensions it installed to the desktop runtime.
    pub supports_suwayomi_extension_install: bool,
    /// `/v1/tracker-credentials` (GET, CAS PUT/DELETE) is available on the paired session.
    pub supports_tracker_credentials_v1: bool,
    pub snapshot_schema_version: u32,
    pub snapshot_entity_types: Vec<String>,
    pub tls_cert_sha256: String,
    pub mdns_service_name: String,
    pub current_server_version: i64,
    pub min_replayable_server_version: i64,
}

// The syncd-only binary does not consume remote snapshots, while the desktop library target does.
#[allow(dead_code)]
pub const MIN_SUPPORTED_SNAPSHOT_SCHEMA_VERSION: u32 = 2;
pub const SNAPSHOT_SCHEMA_VERSION: u32 = 3;

pub const SNAPSHOT_ENTITY_TYPES: [&str; 27] = [
    "book.entry",
    "book.category",
    "book.category_assignment",
    "book.library_ui",
    "book.progress",
    "book.bookmark",
    "book.highlight",
    "book.history",
    "novel.entry",
    "novel.chapter",
    "novel.chapter_asset",
    "novel.progress",
    "novel.bookmark",
    "novel.history",
    "novel.classification",
    "novel.repository",
    "novel.plugin",
    "novel.category",
    "novel.category_assignment",
    "comic.entry",
    "comic.category",
    "comic.category_assignment",
    "comic.chapter_state",
    "comic.history",
    "comic.page_bookmark",
    "comic.tracking",
    "novel.tracking",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntity {
    pub entity_type: String,
    pub entity_id: String,
    pub server_version: i64,
    pub lamport: i64,
    pub record: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTombstone {
    pub entity_type: String,
    pub entity_id: String,
    pub server_version: i64,
    pub lamport: i64,
    pub deleted_at_ms: i64,
    pub reason_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResponse {
    pub schema_version: u32,
    #[serde(default)]
    pub snapshot_id: Option<String>,
    #[serde(default)]
    pub complete: Option<bool>,
    #[serde(default)]
    pub entity_count: Option<usize>,
    #[serde(default)]
    pub tombstone_count: Option<usize>,
    pub scope_id: String,
    pub snapshot_version: i64,
    pub min_replayable_server_version: i64,
    pub entities: Vec<SnapshotEntity>,
    pub tombstones: Vec<SnapshotTombstone>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PairingPlatform {
    Android,
    Desktop,
    Unknown,
}

impl PairingPlatform {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Android => "android",
            Self::Desktop => "desktop",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PairingClaimStatus {
    PendingApproval,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PairingSessionStatus {
    Pending,
    Claimed,
    Approved,
    Rejected,
    Expired,
}

impl PairingSessionStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Approved | Self::Rejected | Self::Expired)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PairingStatusEventType {
    Hello,
    Subscribed,
    StatusChanged,
    Approved,
    Rejected,
    Expired,
    FinalTokenReady,
}

impl PairingStatusEventType {
    pub fn closes_socket(self) -> bool {
        matches!(self, Self::Rejected | Self::Expired | Self::FinalTokenReady)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatusEvent {
    #[serde(rename = "type")]
    pub event_type: PairingStatusEventType,
    pub session_id: String,
    pub profile_id: String,
    pub status: PairingSessionStatus,
    pub expires_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_platform: Option<String>,
    pub requested_scopes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatusSubscribeQuery {
    pub pairing_code: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PairingHostDecision {
    Approve,
    Reject,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingHostDecisionRequest {
    pub decision: PairingHostDecision,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingHostDecisionResponse {
    pub session_id: String,
    pub status: PairingSessionStatus,
    pub claimed_device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_platform: Option<String>,
    pub expires_at_ms: i64,
    pub requested_scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PairingGrantVia {
    Qr,
    TrustedPool,
    LocalAuthority,
}

impl PairingGrantVia {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Qr => "qr",
            Self::TrustedPool => "trusted-pool",
            Self::LocalAuthority => "local-authority",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingClaimRequest {
    pub session_id: String,
    pub pairing_code: String,
    pub device_id: String,
    pub device_name: String,
    pub platform: PairingPlatform,
    pub client_version: String,
    pub client_protocol_version: u32,
    #[serde(default)]
    pub requested_scopes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingTokenResponse {
    pub access_token: String,
    pub token_id: String,
    pub profile_id: String,
    pub scopes: Vec<String>,
    pub inactivity_expires_at_ms: i64,
    pub granted_via: PairingGrantVia,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingClaimResponse {
    pub status: PairingClaimStatus,
    pub session_id: String,
    pub profile_id: String,
    pub claimed_device_id: Option<String>,
    pub expires_at_ms: i64,
    pub requested_scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<PairingTokenResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdPairedDeviceView {
    pub device_id: String,
    pub device_name: String,
    pub platform: PairingPlatform,
    pub profile_id: String,
    pub granted_scopes: Vec<String>,
    pub last_seen_at_ms: Option<i64>,
    /// Every token of the device passed its inactivity window: it must pair again to sync.
    #[serde(default)]
    pub inactive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairedDeviceScopesUpdateRequest {
    pub device_id: String,
    pub profile_id: String,
    pub granted_scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairedDeviceRevokeRequest {
    pub device_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapSessionCreateRequest {
    pub profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingPinResolveRequest {
    pub pin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapSuwayomiHint {
    pub base_url: String,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPayloadResponse {
    pub schema_version: u32,
    pub server_id: String,
    pub device_name: String,
    pub pairing_session_id: String,
    pub pairing_code: String,
    pub syncd_base_url: String,
    pub claim_url: String,
    pub profile_id: String,
    pub expires_at_ms: i64,
    pub tls_cert_sha256: String,
    pub mdns_service_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suwayomi_hint: Option<BootstrapSuwayomiHint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub schema_version: u32,
    pub server_id: String,
    pub profile_id: String,
    pub token_id: String,
    pub scopes: Vec<String>,
    pub inactivity_expires_at_ms: i64,
    pub effective_base_url: String,
    pub tls_cert_sha256: String,
    pub mdns_service_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdDiscoveryAdvertisedOrigin {
    pub base_url: String,
    pub policy_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdDiscoveryCapabilities {
    pub supports_bootstrap_session_create: bool,
    pub supports_bootstrap_session_fetch: bool,
    pub supports_live_pairing_status: bool,
    pub supports_descriptor: bool,
    pub has_advertised_endpoint: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdDiscoveryDescriptor {
    pub descriptor_version: u32,
    pub server_id: String,
    pub server_protocol_version: u32,
    pub min_client_version: String,
    pub tls_cert_sha256: String,
    pub advertised_origin: SyncdDiscoveryAdvertisedOrigin,
    pub capabilities: SyncdDiscoveryCapabilities,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SyncdEffectiveDiscoverySource {
    AdvertisedEndpoint,
    ManualEndpoint,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdEffectiveDiscoveryCandidate {
    pub base_url: String,
    pub source: SyncdEffectiveDiscoverySource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdEffectiveDiscoveryOrigin {
    pub base_url: String,
    pub source: SyncdEffectiveDiscoverySource,
    pub policy: SyncdEffectiveDiscoveryPolicy,
    pub candidates: Vec<SyncdEffectiveDiscoveryCandidate>,
}

impl SyncdEffectiveDiscoveryOrigin {
    pub fn as_advertised_origin(&self) -> SyncdDiscoveryAdvertisedOrigin {
        SyncdDiscoveryAdvertisedOrigin {
            base_url: self.base_url.clone(),
            policy_name: self.policy.as_str().to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SyncdDiscoveryProviderKind {
    LanPublication,
    ManualEndpoint,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SyncdClientDiscoveryUsageHint {
    Canonical,
    Fallback,
    Informational,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdClientDiscoveryCapabilities {
    pub supports_bootstrap_session_create: bool,
    pub supports_bootstrap_session_fetch: bool,
    pub supports_live_pairing_status: bool,
    pub supports_descriptor: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdClientDiscoveryCandidate {
    pub base_url: String,
    pub origin_source: SyncdEffectiveDiscoverySource,
    pub usage_hint: SyncdClientDiscoveryUsageHint,
    pub providers: Vec<SyncdDiscoveryProviderKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdClientDiscoveryContract {
    pub contract_version: u32,
    pub server_id: String,
    pub server_protocol_version: u32,
    pub min_client_version: String,
    pub tls_cert_sha256: String,
    pub effective_origin: String,
    pub effective_source: SyncdEffectiveDiscoverySource,
    pub effective_policy: SyncdEffectiveDiscoveryPolicy,
    pub capabilities: SyncdClientDiscoveryCapabilities,
    pub candidates: Vec<SyncdClientDiscoveryCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdClientDiscoveryAttemptGuidance {
    pub origin: String,
    pub source: SyncdEffectiveDiscoverySource,
    pub usage_hint: SyncdClientDiscoveryUsageHint,
    pub providers: Vec<SyncdDiscoveryProviderKind>,
    pub bootstrap_eligible: bool,
    pub live_pairing_eligible: bool,
    pub informational_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdClientDiscoveryBehaviorGuidance {
    pub continue_on_connection_failure: bool,
    pub continue_on_tls_mismatch: bool,
    pub continue_on_bootstrap_rejection: bool,
    pub continue_on_not_found_or_expired: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdClientDiscoveryGuidanceContract {
    pub guidance_version: u32,
    pub contract_version: u32,
    pub effective_origin: String,
    pub effective_source: SyncdEffectiveDiscoverySource,
    pub effective_policy: SyncdEffectiveDiscoveryPolicy,
    pub candidates_are_normalized_and_deduped: bool,
    pub canonical_attempt: SyncdClientDiscoveryAttemptGuidance,
    pub fallback_attempts: Vec<SyncdClientDiscoveryAttemptGuidance>,
    pub behavior: SyncdClientDiscoveryBehaviorGuidance,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncdDiscoveryProviderLifecycle {
    Disabled,
    Starting,
    Active,
    Stopping,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdDiscoveryFailure {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdPublishedDiscoveryService {
    pub provider_kind: SyncdDiscoveryProviderKind,
    pub service_type: String,
    pub instance_name: String,
    pub host_name: String,
    pub port: u16,
    pub txt_records: SyncdPublishedTxtRecords,
    pub descriptor: SyncdDiscoveryDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdPublishedTxtRecords {
    pub descriptor_version: u32,
    pub server_id: String,
    pub server_protocol_version: u32,
    pub min_client_version: String,
    pub advertised_base_url: String,
    pub supports_bootstrap_session_create: bool,
    pub supports_bootstrap_session_fetch: bool,
    pub supports_live_pairing_status: bool,
    pub supports_descriptor: bool,
    pub tls_cert_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdManualDiscoveryOrigin {
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdManualDiscoveryPublication {
    pub provider_kind: SyncdDiscoveryProviderKind,
    pub origins: Vec<SyncdManualDiscoveryOrigin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdManualDiscoveryProviderStatus {
    pub provider_mode: SyncdManualDiscoveryProviderMode,
    pub lifecycle: SyncdDiscoveryProviderLifecycle,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication: Option<SyncdManualDiscoveryPublication>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<SyncdDiscoveryFailure>,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdDiscoveryProviderStatus {
    pub provider_mode: SyncdDiscoveryProviderMode,
    pub lifecycle: SyncdDiscoveryProviderLifecycle,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication: Option<SyncdPublishedDiscoveryService>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<SyncdDiscoveryFailure>,
    pub effective_origin: SyncdEffectiveDiscoveryOrigin,
    pub manual_provider: SyncdManualDiscoveryProviderStatus,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEnvelope {
    pub server_version: i64,
    pub scope_id: String,
    pub profile_id: Option<String>,
    pub entity_type: String,
    pub entity_id: String,
    pub op: String,
    pub lamport: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<Value>,
    pub applied_at_ms: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct ChangeLogRow {
    pub server_version: i64,
    pub scope_id: String,
    pub profile_id: Option<String>,
    pub entity_type: String,
    pub entity_id: String,
    pub op: String,
    pub lamport: i64,
    pub changed_by_device_id: String,
    pub patch_json: Option<String>,
    pub replay_until_ms: i64,
    pub applied_at_ms: i64,
}

impl TryFrom<ChangeLogRow> for ChangeEnvelope {
    type Error = serde_json::Error;

    fn try_from(value: ChangeLogRow) -> Result<Self, Self::Error> {
        let patch = match value.patch_json {
            Some(raw) => Some(serde_json::from_str(&raw)?),
            None => None,
        };
        Ok(Self {
            server_version: value.server_version,
            scope_id: value.scope_id,
            profile_id: value.profile_id,
            entity_type: value.entity_type,
            entity_id: value.entity_id,
            op: value.op,
            lamport: value.lamport,
            patch,
            applied_at_ms: value.applied_at_ms,
        })
    }
}

#[derive(Debug, Clone, FromRow)]
pub struct ServerRuntimeRow {
    pub current_server_version: i64,
    pub min_replayable_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct AuthenticatedSession {
    pub token_id: String,
    pub device_id: String,
    pub profile_id: String,
    pub scopes: BTreeSet<String>,
    pub mutation_receipt: Option<MutationReceiptContext>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub ok: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum MutationEntityType {
    #[serde(rename = "book.entry")]
    BookEntry,
    #[serde(rename = "book.category")]
    BookCategory,
    #[serde(rename = "book.category_assignment")]
    BookCategoryAssignment,
    #[serde(rename = "book.library_ui")]
    BookLibraryUi,
    #[serde(rename = "book.progress")]
    BookProgress,
    #[serde(rename = "novel.progress")]
    NovelProgress,
    #[serde(rename = "book.bookmark")]
    BookBookmark,
    #[serde(rename = "book.highlight")]
    BookHighlight,
    #[serde(rename = "book.history")]
    BookHistory,
    #[serde(rename = "novel.entry")]
    NovelEntry,
    #[serde(rename = "novel.chapter")]
    NovelChapter,
    #[serde(rename = "novel.chapter_asset")]
    NovelChapterAsset,
    #[serde(rename = "novel.bookmark")]
    NovelBookmark,
    #[serde(rename = "novel.history")]
    NovelHistory,
    #[serde(rename = "novel.classification")]
    NovelClassification,
    #[serde(rename = "novel.repository")]
    NovelRepository,
    #[serde(rename = "novel.plugin")]
    NovelPlugin,
    #[serde(rename = "novel.category")]
    NovelCategory,
    #[serde(rename = "novel.category_assignment")]
    NovelCategoryAssignment,
    #[serde(rename = "comic.history")]
    ComicHistory,
    #[serde(rename = "comic.entry")]
    ComicEntry,
    #[serde(rename = "comic.category")]
    ComicCategory,
    #[serde(rename = "comic.category_assignment")]
    ComicCategoryAssignment,
    #[serde(rename = "comic.chapter_state")]
    ComicChapterState,
    #[serde(rename = "comic.page_bookmark")]
    ComicPageBookmark,
    #[serde(rename = "comic.tracking")]
    ComicTracking,
    #[serde(rename = "novel.tracking")]
    NovelTracking,
}

impl MutationEntityType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BookEntry => "book.entry",
            Self::BookCategory => "book.category",
            Self::BookCategoryAssignment => "book.category_assignment",
            Self::BookLibraryUi => "book.library_ui",
            Self::BookProgress => "book.progress",
            Self::NovelProgress => "novel.progress",
            Self::BookBookmark => "book.bookmark",
            Self::BookHighlight => "book.highlight",
            Self::BookHistory => "book.history",
            Self::NovelEntry => "novel.entry",
            Self::NovelChapter => "novel.chapter",
            Self::NovelChapterAsset => "novel.chapter_asset",
            Self::NovelBookmark => "novel.bookmark",
            Self::NovelHistory => "novel.history",
            Self::NovelClassification => "novel.classification",
            Self::NovelRepository => "novel.repository",
            Self::NovelPlugin => "novel.plugin",
            Self::NovelCategory => "novel.category",
            Self::NovelCategoryAssignment => "novel.category_assignment",
            Self::ComicEntry => "comic.entry",
            Self::ComicCategory => "comic.category",
            Self::ComicCategoryAssignment => "comic.category_assignment",
            Self::ComicChapterState => "comic.chapter_state",
            Self::ComicHistory => "comic.history",
            Self::ComicPageBookmark => "comic.page_bookmark",
            Self::ComicTracking => "comic.tracking",
            Self::NovelTracking => "novel.tracking",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum MutationOperation {
    #[default]
    Merge,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationsRequest {
    pub request_id: String,
    pub mutations: Vec<MutationInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventClock {
    pub physical_ms: i64,
    pub logical: i64,
    pub device_generation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationBase {
    pub client_mutation_id: String,
    pub scope_id: String,
    pub entity_id: String,
    #[serde(default)]
    pub op: MutationOperation,
    pub lamport: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_clock: Option<EventClock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "entityType")]
pub enum MutationInput {
    #[serde(rename = "book.entry")]
    BookEntry {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<BookEntryPatch>,
    },
    #[serde(rename = "book.category")]
    BookCategory {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<BookCategoryPatch>,
    },
    #[serde(rename = "book.category_assignment")]
    BookCategoryAssignment {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<BookCategoryAssignmentPatch>,
    },
    #[serde(rename = "book.library_ui")]
    BookLibraryUi {
        #[serde(flatten)]
        base: MutationBase,
        patch: BookLibraryUiPatch,
    },
    #[serde(rename = "book.progress")]
    BookProgress {
        #[serde(flatten)]
        base: MutationBase,
        patch: BookProgressPatch,
    },
    #[serde(rename = "novel.progress")]
    NovelProgress {
        #[serde(flatten)]
        base: MutationBase,
        patch: NovelProgressPatch,
    },
    #[serde(rename = "book.bookmark")]
    BookBookmark {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<BookBookmarkPatch>,
    },
    #[serde(rename = "book.highlight")]
    BookHighlight {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<BookHighlightPatch>,
    },
    #[serde(rename = "book.history")]
    BookHistory {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<BookHistoryPatch>,
    },
    #[serde(rename = "novel.entry")]
    NovelEntry {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<NovelEntryPatch>,
    },
    #[serde(rename = "novel.chapter")]
    NovelChapter {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<NovelChapterPatch>,
    },
    #[serde(rename = "novel.chapter_asset")]
    NovelChapterAsset {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<NovelChapterAssetPatch>,
    },
    #[serde(rename = "novel.bookmark")]
    NovelBookmark {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<NovelBookmarkPatch>,
    },
    #[serde(rename = "novel.history")]
    NovelHistory {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<NovelHistoryPatch>,
    },
    #[serde(rename = "novel.classification")]
    NovelClassification {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<NovelClassificationPatch>,
    },
    #[serde(rename = "novel.repository")]
    NovelRepository {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<NovelRepositoryPatch>,
    },
    #[serde(rename = "novel.plugin")]
    NovelPlugin {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<NovelPluginPatch>,
    },
    #[serde(rename = "novel.category")]
    NovelCategory {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<NovelCategoryPatch>,
    },
    #[serde(rename = "novel.category_assignment")]
    NovelCategoryAssignment {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<NovelCategoryAssignmentPatch>,
    },
    #[serde(rename = "comic.history")]
    ComicHistory {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<ComicHistoryPatch>,
    },
    #[serde(rename = "comic.entry")]
    ComicEntry {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<ComicEntryPatch>,
    },
    #[serde(rename = "comic.category")]
    ComicCategory {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<ComicCategoryPatch>,
    },
    #[serde(rename = "comic.category_assignment")]
    ComicCategoryAssignment {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<ComicCategoryAssignmentPatch>,
    },
    #[serde(rename = "comic.chapter_state")]
    ComicChapterState {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<ComicChapterStatePatch>,
    },
    #[serde(rename = "comic.page_bookmark")]
    ComicPageBookmark {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<ComicPageBookmarkPatch>,
    },
    /// Full-state tracker binding.  The patch is kept as a raw JSON object so
    /// unknown fields survive the Core round trip; validation lives in the
    /// mutation route.
    #[serde(rename = "comic.tracking")]
    ComicTracking {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<serde_json::Value>,
    },
    #[serde(rename = "novel.tracking")]
    NovelTracking {
        #[serde(flatten)]
        base: MutationBase,
        patch: Option<serde_json::Value>,
    },
}

#[derive(Debug, Clone)]
pub struct MutationReceiptContext {
    pub device_id: String,
    pub client_mutation_id: String,
    pub mutation_hash: String,
    pub mutation_json: String,
    pub entity_type: MutationEntityType,
    pub entity_id: String,
    pub canonical_entity_id: Option<String>,
    pub scope_id: String,
    pub op: MutationOperation,
    pub event_clock: Option<EventClock>,
}

impl MutationInput {
    pub fn entity_type(&self) -> MutationEntityType {
        match self {
            Self::BookEntry { .. } => MutationEntityType::BookEntry,
            Self::BookCategory { .. } => MutationEntityType::BookCategory,
            Self::BookCategoryAssignment { .. } => MutationEntityType::BookCategoryAssignment,
            Self::BookLibraryUi { .. } => MutationEntityType::BookLibraryUi,
            Self::BookProgress { .. } => MutationEntityType::BookProgress,
            Self::NovelProgress { .. } => MutationEntityType::NovelProgress,
            Self::BookBookmark { .. } => MutationEntityType::BookBookmark,
            Self::BookHighlight { .. } => MutationEntityType::BookHighlight,
            Self::BookHistory { .. } => MutationEntityType::BookHistory,
            Self::NovelEntry { .. } => MutationEntityType::NovelEntry,
            Self::NovelChapter { .. } => MutationEntityType::NovelChapter,
            Self::NovelChapterAsset { .. } => MutationEntityType::NovelChapterAsset,
            Self::NovelBookmark { .. } => MutationEntityType::NovelBookmark,
            Self::NovelHistory { .. } => MutationEntityType::NovelHistory,
            Self::NovelClassification { .. } => MutationEntityType::NovelClassification,
            Self::NovelRepository { .. } => MutationEntityType::NovelRepository,
            Self::NovelPlugin { .. } => MutationEntityType::NovelPlugin,
            Self::NovelCategory { .. } => MutationEntityType::NovelCategory,
            Self::NovelCategoryAssignment { .. } => MutationEntityType::NovelCategoryAssignment,
            Self::ComicEntry { .. } => MutationEntityType::ComicEntry,
            Self::ComicCategory { .. } => MutationEntityType::ComicCategory,
            Self::ComicCategoryAssignment { .. } => MutationEntityType::ComicCategoryAssignment,
            Self::ComicChapterState { .. } => MutationEntityType::ComicChapterState,
            Self::ComicHistory { .. } => MutationEntityType::ComicHistory,
            Self::ComicPageBookmark { .. } => MutationEntityType::ComicPageBookmark,
            Self::ComicTracking { .. } => MutationEntityType::ComicTracking,
            Self::NovelTracking { .. } => MutationEntityType::NovelTracking,
        }
    }

    pub fn base(&self) -> &MutationBase {
        match self {
            Self::BookEntry { base, .. }
            | Self::BookCategory { base, .. }
            | Self::BookCategoryAssignment { base, .. }
            | Self::BookLibraryUi { base, .. }
            | Self::BookProgress { base, .. }
            | Self::NovelProgress { base, .. }
            | Self::BookBookmark { base, .. }
            | Self::BookHighlight { base, .. }
            | Self::BookHistory { base, .. }
            | Self::NovelEntry { base, .. }
            | Self::NovelChapter { base, .. }
            | Self::NovelChapterAsset { base, .. }
            | Self::NovelBookmark { base, .. }
            | Self::NovelHistory { base, .. }
            | Self::NovelClassification { base, .. }
            | Self::NovelRepository { base, .. }
            | Self::NovelPlugin { base, .. }
            | Self::NovelCategory { base, .. }
            | Self::NovelCategoryAssignment { base, .. }
            | Self::ComicEntry { base, .. }
            | Self::ComicCategory { base, .. }
            | Self::ComicCategoryAssignment { base, .. }
            | Self::ComicChapterState { base, .. }
            | Self::ComicHistory { base, .. }
            | Self::ComicPageBookmark { base, .. }
            | Self::ComicTracking { base, .. }
            | Self::NovelTracking { base, .. } => base,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookEntryPatch {
    pub asset_fingerprint: Option<String>,
    pub mime_type: Option<String>,
    pub byte_size: Option<i64>,
    pub cover_asset_sha256: Option<String>,
    pub cover_asset_byte_size: Option<i64>,
    pub cover_asset_mime_type: Option<String>,
    pub title: String,
    pub author: Option<String>,
    pub description: Option<String>,
    pub subtype: String,
    pub page_count: Option<i64>,
    pub toc_count: Option<i64>,
    pub spine_count: Option<i64>,
    pub section_count: Option<i64>,
    pub sections_summary_json: Option<Value>,
    pub has_cover: bool,
    pub created_at_ms: i64,
    pub book_updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookCategoryPatch {
    pub category_id: String,
    pub name: String,
    pub order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookCategoryAssignmentPatch {
    pub book_id: String,
    pub category_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookLibraryUiPatch {
    pub active_category_id: Option<String>,
    pub type_filter: String,
    pub status_filter: String,
    pub search: String,
    pub sort_mode: String,
    pub sort_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookProgressPatch {
    pub renderer: Option<String>,
    pub location: Option<String>,
    pub href: Option<String>,
    pub progress_percent: f64,
    pub last_read_at_ms: i64,
    pub page_index: Option<i64>,
    pub total_pages: Option<i64>,
    pub section_label: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub reset: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelProgressPatch {
    pub chapter_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portable_work_ref: Option<PortableWorkRefV3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portable_chapter_ref: Option<PortableChapterRefV3>,
    pub chapter_title: Option<String>,
    pub chapter_order_key: Option<f64>,
    pub progress_percent: f64,
    pub locator: Option<String>,
    pub locator_sort_key: Option<f64>,
    pub updated_at_ms: i64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub reset: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookBookmarkPatch {
    pub book_id: String,
    pub location: Option<String>,
    pub href: Option<String>,
    pub page_index: Option<i64>,
    pub progress_percent: f64,
    pub label: Option<String>,
    pub note: Option<String>,
    #[serde(default)]
    pub created_at_ms: i64,
    #[serde(default)]
    pub updated_at_ms: i64,
    pub saved_at_ms: i64,
}

impl BookBookmarkPatch {
    pub fn effective_created_at_ms(&self) -> i64 {
        if self.created_at_ms == 0 {
            self.saved_at_ms
        } else {
            self.created_at_ms
        }
    }

    pub fn effective_updated_at_ms(&self) -> i64 {
        if self.updated_at_ms == 0 {
            self.saved_at_ms
        } else {
            self.updated_at_ms
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookHighlightPatch {
    pub highlight_id: String,
    pub book_id: String,
    pub start_locator_json: Value,
    pub end_locator_json: Value,
    pub selected_text: String,
    pub color_argb: i64,
    pub note: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// A point-in-time book reading event. Unlike `book.progress`, history entries
/// are independently addressable and may be deleted without resetting progress.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookHistoryPatch {
    pub history_id: String,
    pub book_id: String,
    pub renderer: Option<String>,
    pub location: Option<String>,
    pub href: Option<String>,
    pub page_index: Option<i64>,
    pub progress_percent: f64,
    pub section_label: Option<String>,
    pub read_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelBookmarkPatch {
    pub novel_id: String,
    pub chapter_id: Option<String>,
    pub chapter_title: Option<String>,
    pub chapter_order_key: Option<f64>,
    pub locator: Option<String>,
    pub locator_sort_key: Option<f64>,
    pub label: Option<String>,
    pub saved_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PortableWorkRefV3 {
    Comic {
        #[serde(rename = "sourceId")]
        source_id: String,
        #[serde(rename = "mangaKey")]
        manga_key: String,
    },
    Novel {
        #[serde(rename = "pluginId")]
        plugin_id: String,
        #[serde(rename = "novelKey")]
        novel_key: String,
    },
}

impl PortableWorkRefV3 {
    pub fn comic(source_id: impl Into<String>, manga_key: impl Into<String>) -> Self {
        Self::Comic {
            source_id: source_id.into(),
            manga_key: manga_key.into(),
        }
    }

    pub fn novel(plugin_id: impl Into<String>, novel_key: impl Into<String>) -> Self {
        Self::Novel {
            plugin_id: plugin_id.into(),
            novel_key: novel_key.into(),
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Comic {
                source_id,
                manga_key,
            } => {
                validate_decimal_source_id(source_id)?;
                validate_provider_owned_key(manga_key)
            }
            Self::Novel {
                plugin_id,
                novel_key,
            } => {
                validate_portable_identifier(plugin_id)?;
                validate_provider_owned_key(novel_key)
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PortableChapterRefV3 {
    Comic {
        work: PortableWorkRefV3,
        #[serde(rename = "chapterKey")]
        chapter_key: String,
    },
    Novel {
        work: PortableWorkRefV3,
        #[serde(rename = "chapterKey")]
        chapter_key: String,
    },
}

impl PortableChapterRefV3 {
    pub fn comic(work: PortableWorkRefV3, chapter_key: impl Into<String>) -> Self {
        Self::Comic {
            work,
            chapter_key: chapter_key.into(),
        }
    }

    pub fn novel(work: PortableWorkRefV3, chapter_key: impl Into<String>) -> Self {
        Self::Novel {
            work,
            chapter_key: chapter_key.into(),
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Comic { work, chapter_key } => {
                if !matches!(work, PortableWorkRefV3::Comic { .. }) {
                    return Err("comic chapter must reference a comic work");
                }
                work.validate()?;
                validate_provider_owned_key(chapter_key)
            }
            Self::Novel { work, chapter_key } => {
                if !matches!(work, PortableWorkRefV3::Novel { .. }) {
                    return Err("novel chapter must reference a novel work");
                }
                work.validate()?;
                validate_provider_owned_key(chapter_key)
            }
        }
    }
}

pub fn canonical_portable_work_id(reference: &PortableWorkRefV3) -> String {
    let mut digest = Sha256::new();
    match reference {
        PortableWorkRefV3::Comic {
            source_id,
            manga_key,
        } => {
            digest.update(b"comic\0");
            digest.update(source_id.as_bytes());
            digest.update(b"\0");
            digest.update(manga_key.as_bytes());
            format!("comic:{:x}", digest.finalize())
        }
        PortableWorkRefV3::Novel {
            plugin_id,
            novel_key,
        } => {
            digest.update(b"novel\0");
            digest.update(plugin_id.as_bytes());
            digest.update(b"\0");
            digest.update(novel_key.as_bytes());
            format!("novel:{:x}", digest.finalize())
        }
    }
}

pub fn canonical_portable_chapter_id(reference: &PortableChapterRefV3) -> String {
    let mut digest = Sha256::new();
    match reference {
        PortableChapterRefV3::Comic { work, chapter_key } => {
            let PortableWorkRefV3::Comic {
                source_id,
                manga_key,
            } = work
            else {
                unreachable!("validated comic chapter contains a comic work")
            };
            digest.update(b"comic-chapter\0");
            digest.update(source_id.as_bytes());
            digest.update(b"\0");
            digest.update(manga_key.as_bytes());
            digest.update(b"\0");
            digest.update(chapter_key.as_bytes());
            format!("comic-chapter:{:x}", digest.finalize())
        }
        PortableChapterRefV3::Novel { work, chapter_key } => {
            let PortableWorkRefV3::Novel {
                plugin_id,
                novel_key,
            } = work
            else {
                unreachable!("validated novel chapter contains a novel work")
            };
            digest.update(b"novel-chapter\0");
            digest.update(plugin_id.as_bytes());
            digest.update(b"\0");
            digest.update(novel_key.as_bytes());
            digest.update(b"\0");
            digest.update(chapter_key.as_bytes());
            format!("novel-chapter:{:x}", digest.finalize())
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStoreReferenceV3 {
    pub store_index_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_manifest_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComicDependencyV3 {
    pub pkg_name: String,
    pub required_source_ids: BTreeSet<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_version_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension_store: Option<ExtensionStoreReferenceV3>,
}

impl ComicDependencyV3 {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_portable_identifier(&self.pkg_name)?;
        if self.required_source_ids.is_empty() {
            return Err("comic dependency must require at least one source");
        }
        for source_id in &self.required_source_ids {
            validate_decimal_source_id(source_id)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryReferenceV3 {
    pub index_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_manifest_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NovelDependencyV3 {
    pub plugin_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<RepositoryReferenceV3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_artifact_sha256: Option<String>,
}

impl NovelDependencyV3 {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_portable_identifier(&self.plugin_id)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PortableResolutionStateV3 {
    PendingDependency,
    PendingProvider,
    Resolving,
    Ready,
    Bound,
    RetryableFailure,
    RequiresUserAction,
    LegacyUnbound,
    Conflict,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PortableResolutionReasonV3 {
    ExtensionNotFound,
    ExtensionStoreMissing,
    ExtensionStoreApprovalRequired,
    ExtensionNotLoaded,
    PluginNotFound,
    PluginRepositoryMissing,
    PluginRepositoryApprovalRequired,
    SourceNotFound,
    SourceNotLoaded,
    SourceOffline,
    SourceAuthRequired,
    SourceConfigurationRequired,
    WorkNotFound,
    WorkResolutionUnsupported,
    WorkResolutionFailed,
    ChapterNotFound,
    ChapterResolutionFailed,
}

#[derive(Debug, Clone, FromRow, PartialEq, Eq)]
pub struct PortableWorkBindingRow {
    pub profile_id: String,
    pub portable_id: String,
    pub ecosystem: String,
    pub source_id: Option<String>,
    pub plugin_id: Option<String>,
    pub provider_key: String,
    pub dependency_key: Option<String>,
    pub local_reference: Option<String>,
    pub resolution_state: String,
    pub resolution_reason: Option<String>,
    pub title_hint: Option<String>,
    pub provider_label_hint: Option<String>,
    pub record_lamport: i64,
    pub updated_at_ms: i64,
}

impl PortableWorkBindingRow {
    pub fn portable_ref(&self) -> Result<PortableWorkRefV3, &'static str> {
        let reference = match self.ecosystem.as_str() {
            "SUWAYOMI" => PortableWorkRefV3::Comic {
                source_id: self
                    .source_id
                    .clone()
                    .ok_or("comic binding is missing source ID")?,
                manga_key: self.provider_key.clone(),
            },
            "LNREADER" => PortableWorkRefV3::Novel {
                plugin_id: self
                    .plugin_id
                    .clone()
                    .ok_or("novel binding is missing plugin ID")?,
                novel_key: self.provider_key.clone(),
            },
            _ => return Err("portable binding has an unsupported ecosystem"),
        };
        reference.validate()?;
        Ok(reference)
    }
}

#[derive(Debug, Clone, FromRow, PartialEq, Eq)]
pub struct PortableChapterBindingRow {
    pub profile_id: String,
    pub portable_chapter_id: String,
    pub portable_work_id: String,
    pub provider_key: String,
    pub local_reference: Option<String>,
    pub resolution_state: String,
    pub resolution_reason: Option<String>,
    pub record_lamport: i64,
    pub updated_at_ms: i64,
}

fn validate_decimal_source_id(value: &str) -> Result<(), &'static str> {
    let digits = value.strip_prefix('-').unwrap_or(value);
    if value.is_empty()
        || digits.is_empty()
        || (digits.len() > 1 && digits.starts_with('0'))
        || value == "-0"
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
        || value.parse::<i64>().is_err()
    {
        return Err("source ID must be a canonical signed-64-bit decimal string");
    }
    Ok(())
}

fn validate_provider_owned_key(value: &str) -> Result<(), &'static str> {
    if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("provider-owned key is invalid");
    }
    if provider_owned_key_may_contain_secret(value) {
        return Err("provider-owned key may contain private credentials");
    }
    Ok(())
}

fn provider_owned_key_may_contain_secret(value: &str) -> bool {
    if let Ok(url) = Url::parse(value) {
        if !url.username().is_empty() || url.password().is_some() {
            return true;
        }
    }
    let query = value
        .split_once('?')
        .map(|(_, tail)| tail.split('#').next().unwrap_or(tail));
    let fragment = value.split_once('#').map(|(_, fragment)| fragment);
    query
        .into_iter()
        .chain(fragment)
        .any(secret_parameter_segment)
}

fn secret_parameter_segment(segment: &str) -> bool {
    url::form_urlencoded::parse(segment.as_bytes()).any(|(name, _)| {
        matches!(
            name.to_ascii_lowercase().as_str(),
            "token"
                | "access_token"
                | "accesstoken"
                | "auth"
                | "authorization"
                | "api_key"
                | "apikey"
                | "key"
                | "signature"
                | "sig"
                | "session"
                | "sessionid"
                | "cookie"
                | "password"
                | "passwd"
                | "secret"
        )
    })
}

fn validate_portable_identifier(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value != value.trim()
        || value.len() > 512
        || value.chars().any(char::is_control)
    {
        return Err("portable identifier is invalid");
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelEntryPatch {
    pub identity_key: String,
    pub title: String,
    pub author: Option<String>,
    pub description: Option<String>,
    pub cover_url: Option<String>,
    pub path: String,
    pub status: Option<String>,
    pub tags: Vec<String>,
    pub source: Value,
    pub added_at_ms: i64,
    pub updated_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portable_work_ref: Option<PortableWorkRefV3>,
}

/// Returns the mobile-compatible novel identity when the source metadata is
/// complete. Metadata-only legacy records deliberately return `None` so their
/// existing identity key remains usable.
pub fn canonical_novel_identity_key(patch: &NovelEntryPatch) -> Option<String> {
    if let Some(reference) = patch.portable_work_ref.as_ref() {
        return Some(canonical_portable_work_id(reference));
    }
    canonical_novel_identity_key_from_source(&patch.source, &patch.path)
}

pub fn canonical_novel_identity_key_from_source(source: &Value, path: &str) -> Option<String> {
    let source = source.as_object()?;
    let repository = source
        .get("repositoryUrl")
        .or_else(|| source.get("repositoryUri"))?
        .as_str()?;
    let plugin_id = source.get("pluginId")?.as_str()?.trim();
    let source_id = source.get("sourceId")?.as_str()?.trim();
    let path = path.trim();
    if plugin_id.is_empty()
        || source_id.is_empty()
        || path.is_empty()
        || plugin_id.contains('\0')
        || source_id.contains('\0')
        || path.contains('\0')
    {
        return None;
    }

    let repository = canonicalize_novel_repository(repository)?;
    let parts = [repository.as_str(), plugin_id, source_id, path];
    let encoded = serde_json::to_vec(&parts).ok()?;
    Some(format!("novel-{:x}", Sha256::digest(encoded)))
}

fn canonicalize_novel_repository(raw: &str) -> Option<String> {
    let mut repository = Url::parse(raw.trim()).ok()?;
    if !matches!(repository.scheme(), "http" | "https")
        || repository.host_str().is_none()
        || !repository.username().is_empty()
        || repository.password().is_some()
    {
        return None;
    }

    repository.set_fragment(None);
    let path = repository.path().to_string();
    if path.len() > 1 && path.ends_with('/') {
        repository.set_path(path.trim_end_matches('/'));
    }
    Some(repository.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelChapterPatch {
    pub novel_id: String,
    pub path: String,
    pub title: String,
    pub chapter_order_key: f64,
    pub release_time_ms: Option<i64>,
    pub unread: bool,
}

/// Versioned manifest for one explicitly downloaded LNReader chapter archive.
/// The immutable bytes must already exist in the Core asset store for the same
/// scope before this record can be published.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelChapterAssetPatch {
    pub schema_version: u32,
    pub novel_id: String,
    pub chapter_id: String,
    pub blob_sha256: String,
    pub byte_length: i64,
    pub archive_format: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Cross-client identity for a downloaded chapter manifest. NUL is forbidden
/// in both identifiers, so the hash input is unambiguous.
pub fn canonical_novel_chapter_asset_id(novel_id: &str, chapter_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(novel_id.as_bytes());
    digest.update([0]);
    digest.update(chapter_id.as_bytes());
    format!("novel-chapter-asset:{:x}", digest.finalize())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelHistoryPatch {
    pub novel_id: String,
    pub chapter_id: Option<String>,
    pub chapter_title: Option<String>,
    pub locator: Option<String>,
    pub read_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelClassificationPatch {
    pub plugin_id: String,
    pub repository_id: Option<String>,
    pub repository_url: Option<String>,
    pub lang: Option<String>,
    pub version: Option<String>,
    pub status: String,
    pub notes: String,
    pub baseline_status: Option<String>,
    pub baseline_notes: Option<String>,
    pub issues_json: Value,
    pub smoke_json: Value,
    pub filter_keys: Vec<String>,
    pub plugin_settings_keys: Vec<String>,
    pub classified_at_ms: i64,
}

/// A clean, profile-scoped LNReader repository descriptor. Repository URLs do
/// not carry credentials or signed query parameters; secrets remain local.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelRepositoryPatch {
    pub canonical_url: String,
    pub name: String,
    pub enabled: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Returns the normalized HTTPS repository URL used by every client when
/// deriving identity. Query, fragment and userinfo are rejected, not removed.
pub fn canonicalize_novel_repository_url(raw: &str) -> Option<String> {
    let mut repository = Url::parse(raw.trim()).ok()?;
    if repository.scheme() != "https"
        || repository.host_str().is_none()
        || !repository.username().is_empty()
        || repository.password().is_some()
        || repository.query().is_some()
        || repository.fragment().is_some()
    {
        return None;
    }
    let path = repository.path().to_string();
    if path.len() > 1 && path.ends_with('/') {
        repository.set_path(path.trim_end_matches('/'));
    }
    Some(repository.to_string())
}

/// Private repositories remain valid local configuration, but never cross Syncd.
pub fn canonicalize_public_novel_repository_url(raw: &str) -> Option<String> {
    let repository = Url::parse(&canonicalize_novel_repository_url(raw)?).ok()?;
    match repository.host()? {
        url::Host::Domain(host) if is_private_sync_hostname(host) => None,
        url::Host::Ipv4(address) if is_private_sync_ip(IpAddr::V4(address)) => None,
        url::Host::Ipv6(address) if is_private_sync_ip(IpAddr::V6(address)) => None,
        _ => Some(repository.to_string()),
    }
}

fn is_private_sync_hostname(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    !host.contains('.')
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".lan")
}

fn is_private_sync_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(address) => {
            let octets = address.octets();
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_broadcast()
                || address.is_multicast()
                || address.is_unspecified()
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(address) => {
            let first = address.segments()[0];
            address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
        }
    }
}

pub fn canonical_novel_repository_id(canonical_url: &str) -> String {
    format!(
        "novel-repository:{:x}",
        Sha256::digest(canonical_url.as_bytes())
    )
}

/// A locally executable plugin descriptor. In protocol v1 `publicSettings`
/// must be empty because the current catalog has no trustworthy pre-execution
/// allowlist. Secrets and permission grants always remain local.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelPluginPatch {
    pub repository_id: String,
    pub plugin_id: String,
    pub source_id: String,
    pub name: String,
    pub version: String,
    pub lang: String,
    pub enabled: bool,
    pub artifact_sha256: String,
    pub artifact_byte_length: i64,
    pub public_settings: Value,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

pub fn canonical_novel_plugin_id(repository_id: &str, plugin_id: &str, source_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(repository_id.as_bytes());
    digest.update([0]);
    digest.update(plugin_id.as_bytes());
    digest.update([0]);
    digest.update(source_id.as_bytes());
    format!("novel-plugin:{:x}", digest.finalize())
}

/// A user-managed category for novels. This is intentionally separate from
/// `novel.classification`, which describes plugin compatibility evidence.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelCategoryPatch {
    pub category_id: String,
    pub name: String,
    pub order: i64,
}

/// A stable, independently addressable membership edge between one novel and
/// one user category.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelCategoryAssignmentPatch {
    pub assignment_id: String,
    pub novel_id: String,
    pub category_id: String,
}

/// Cross-client canonical identity for a novel/category membership edge.
/// NUL is forbidden in both identifiers, so it is an unambiguous separator.
pub fn canonical_novel_category_assignment_id(novel_id: &str, category_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(novel_id.as_bytes());
    digest.update([0]);
    digest.update(category_id.as_bytes());
    format!("novel-category-assignment:{:x}", digest.finalize())
}

/// Latest persisted comic reader position. `comicId` uses the mobile MediaKey
/// wire format: `suwayomi:<server-fingerprint>:manga:<manga-id>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicHistoryPatch {
    pub history_id: String,
    pub comic_id: String,
    pub chapter_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portable_work_ref: Option<PortableWorkRefV3>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portable_chapter_ref: Option<PortableChapterRefV3>,
    pub page_index: i64,
    pub page_count: Option<i64>,
    pub progress_percent: f64,
    pub read_at_ms: i64,
}

/// Explicit page bookmark. The entity id is client-generated and must equal
/// `bookmarkId`; updating it may not move the bookmark to another comic.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicPageBookmarkPatch {
    pub bookmark_id: String,
    pub comic_id: String,
    pub chapter_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portable_work_ref: Option<PortableWorkRefV3>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portable_chapter_ref: Option<PortableChapterRefV3>,
    pub page_index: i64,
    pub page_count: Option<i64>,
    pub label: Option<String>,
    pub saved_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationsResponse {
    pub request_id: String,
    pub current_server_version: i64,
    pub results: Vec<MutationResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub client_mutation_id: String,
    pub entity_type: MutationEntityType,
    pub entity_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_entity_id: Option<String>,
    pub scope_id: String,
    pub op: MutationOperation,
    pub status: MutationResultStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_server_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_lamport: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_clock: Option<EventClock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorDetail>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MutationResultStatus {
    Applied,
    Superseded,
    Conflict,
    Retry,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicEntryPatch {
    pub comic_id: String,
    pub in_library: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portable_work_ref: Option<PortableWorkRefV3>,
    /// Title of a work first added on a device, so Suwayomi can find it by searching its source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicCategoryPatch {
    pub category_id: String,
    pub name: String,
    pub order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicCategoryAssignmentPatch {
    pub assignment_id: String,
    pub comic_id: String,
    pub category_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portable_work_ref: Option<PortableWorkRefV3>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicChapterStatePatch {
    pub chapter_state_id: String,
    pub comic_id: String,
    pub chapter_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portable_work_ref: Option<PortableWorkRefV3>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portable_chapter_ref: Option<PortableChapterRefV3>,
    pub read: Option<bool>,
    pub bookmarked: Option<bool>,
    pub last_page_read: Option<i64>,
    pub last_read_at_ms: Option<i64>,
    pub updated_at_ms: i64,
    pub explicit_progress_reset: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookProgressRecord {
    pub book_id: String,
    pub renderer: Option<String>,
    pub location: Option<String>,
    pub href: Option<String>,
    pub progress_percent: f64,
    pub last_read_at_ms: i64,
    pub page_index: Option<i64>,
    pub total_pages: Option<i64>,
    pub section_label: Option<String>,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookEntryRecord {
    pub book_id: String,
    pub asset_fingerprint: Option<String>,
    pub mime_type: Option<String>,
    pub byte_size: Option<i64>,
    pub cover_asset_sha256: Option<String>,
    pub cover_asset_byte_size: Option<i64>,
    pub cover_asset_mime_type: Option<String>,
    pub title: String,
    pub author: Option<String>,
    pub description: Option<String>,
    pub subtype: String,
    pub page_count: Option<i64>,
    pub toc_count: Option<i64>,
    pub spine_count: Option<i64>,
    pub section_count: Option<i64>,
    pub sections_summary_json: Option<Value>,
    pub has_cover: bool,
    pub created_at_ms: i64,
    pub book_updated_at_ms: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookCategoryRecord {
    pub category_id: String,
    pub name: String,
    pub order: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookCategoryAssignmentRecord {
    pub book_id: String,
    pub category_ids: Vec<String>,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookLibraryUiRecord {
    pub ui_state_id: String,
    pub active_category_id: Option<String>,
    pub type_filter: String,
    pub status_filter: String,
    pub search: String,
    pub sort_mode: String,
    pub sort_dir: String,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NovelProgressRecord {
    pub novel_id: String,
    pub chapter_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portable_work_ref: Option<PortableWorkRefV3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portable_chapter_ref: Option<PortableChapterRefV3>,
    pub chapter_title: Option<String>,
    pub chapter_order_key: Option<f64>,
    pub progress_percent: f64,
    pub locator: Option<String>,
    pub locator_sort_key: Option<f64>,
    pub updated_at_ms: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookBookmarkRecord {
    pub bookmark_id: String,
    pub book_id: String,
    pub location: Option<String>,
    pub href: Option<String>,
    pub page_index: Option<i64>,
    pub progress_percent: f64,
    pub label: Option<String>,
    pub note: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub saved_at_ms: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookHighlightRecord {
    pub highlight_id: String,
    pub book_id: String,
    pub start_locator_json: Value,
    pub end_locator_json: Value,
    pub selected_text: String,
    pub color_argb: i64,
    pub note: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookHistoryRecord {
    pub history_id: String,
    pub book_id: String,
    pub renderer: Option<String>,
    pub location: Option<String>,
    pub href: Option<String>,
    pub page_index: Option<i64>,
    pub progress_percent: f64,
    pub section_label: Option<String>,
    pub read_at_ms: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NovelBookmarkRecord {
    pub bookmark_id: String,
    pub novel_id: String,
    pub chapter_id: Option<String>,
    pub chapter_title: Option<String>,
    pub chapter_order_key: Option<f64>,
    pub locator: Option<String>,
    pub locator_sort_key: Option<f64>,
    pub label: Option<String>,
    pub saved_at_ms: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NovelEntryRecord {
    pub novel_id: String,
    pub identity_key: String,
    pub title: String,
    pub author: Option<String>,
    pub description: Option<String>,
    pub cover_url: Option<String>,
    pub path: String,
    pub status: Option<String>,
    pub tags: Vec<String>,
    pub source: Value,
    pub added_at_ms: i64,
    pub updated_at_ms: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NovelChapterRecord {
    pub chapter_id: String,
    pub novel_id: String,
    pub path: String,
    pub title: String,
    pub chapter_order_key: f64,
    pub release_time_ms: Option<i64>,
    pub unread: bool,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NovelHistoryRecord {
    pub history_id: String,
    pub novel_id: String,
    pub chapter_id: Option<String>,
    pub chapter_title: Option<String>,
    pub locator: Option<String>,
    pub read_at_ms: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NovelClassificationRecord {
    pub plugin_id: String,
    pub repository_id: Option<String>,
    pub repository_url: Option<String>,
    pub lang: Option<String>,
    pub version: Option<String>,
    pub status: String,
    pub notes: String,
    pub baseline_status: Option<String>,
    pub baseline_notes: Option<String>,
    pub issues_json: Value,
    pub smoke_json: Value,
    pub filter_keys: Vec<String>,
    pub plugin_settings_keys: Vec<String>,
    pub classified_at_ms: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NovelRepositoryRecord {
    pub repository_id: String,
    pub canonical_url: String,
    pub name: String,
    pub enabled: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NovelPluginRecord {
    pub plugin_entity_id: String,
    pub repository_id: String,
    pub plugin_id: String,
    pub source_id: String,
    pub name: String,
    pub version: String,
    pub lang: String,
    pub enabled: bool,
    pub artifact_sha256: String,
    pub artifact_byte_length: i64,
    pub public_settings: Value,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NovelChapterAssetRecord {
    pub chapter_asset_id: String,
    pub schema_version: u32,
    pub novel_id: String,
    pub chapter_id: String,
    pub blob_sha256: String,
    pub byte_length: i64,
    pub archive_format: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NovelCategoryRecord {
    pub category_id: String,
    pub name: String,
    pub order: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NovelCategoryAssignmentRecord {
    pub assignment_id: String,
    pub novel_id: String,
    pub category_id: String,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComicHistoryRecord {
    pub history_id: String,
    pub comic_id: String,
    pub chapter_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portable_work_ref: Option<PortableWorkRefV3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portable_chapter_ref: Option<PortableChapterRefV3>,
    pub page_index: i64,
    pub page_count: Option<i64>,
    pub progress_percent: f64,
    pub read_at_ms: i64,
    pub record_lamport: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComicPageBookmarkRecord {
    pub bookmark_id: String,
    pub comic_id: String,
    pub chapter_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portable_work_ref: Option<PortableWorkRefV3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portable_chapter_ref: Option<PortableChapterRefV3>,
    pub page_index: i64,
    pub page_count: Option<i64>,
    pub label: Option<String>,
    pub saved_at_ms: i64,
    pub record_lamport: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct BookEntryRow {
    pub scope_id: String,
    pub book_id: String,
    pub asset_fingerprint: Option<String>,
    pub mime_type: Option<String>,
    pub byte_size: Option<i64>,
    pub cover_asset_sha256: Option<String>,
    pub cover_asset_byte_size: Option<i64>,
    pub cover_asset_mime_type: Option<String>,
    pub title: String,
    pub author: Option<String>,
    pub description: Option<String>,
    pub subtype: String,
    pub page_count: Option<i64>,
    pub toc_count: Option<i64>,
    pub spine_count: Option<i64>,
    pub section_count: Option<i64>,
    pub sections_summary_json: Option<String>,
    pub has_cover: i64,
    pub created_at_ms: i64,
    pub book_updated_at_ms: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct BookCategoryRow {
    pub scope_id: String,
    pub category_id: String,
    pub name: String,
    pub sort_order: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct BookCategoryAssignmentRow {
    pub scope_id: String,
    pub book_id: String,
    pub category_ids_json: String,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct BookLibraryUiRow {
    pub scope_id: String,
    pub ui_state_id: String,
    pub active_category_id: Option<String>,
    pub type_filter: String,
    pub status_filter: String,
    pub search: String,
    pub sort_mode: String,
    pub sort_dir: String,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct BookProgressRow {
    pub scope_id: String,
    pub book_id: String,
    pub renderer: Option<String>,
    pub location: Option<String>,
    pub href: Option<String>,
    pub progress_percent: f64,
    pub last_read_at_ms: i64,
    pub page_index: Option<i64>,
    pub total_pages: Option<i64>,
    pub section_label: Option<String>,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct NovelProgressRow {
    pub scope_id: String,
    pub novel_id: String,
    pub chapter_id: Option<String>,
    pub portable_work_ref_json: Option<String>,
    pub portable_chapter_ref_json: Option<String>,
    pub chapter_title: Option<String>,
    pub chapter_order_key: Option<f64>,
    pub progress_percent: f64,
    pub locator: Option<String>,
    pub locator_sort_key: Option<f64>,
    pub updated_at_ms: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct BookBookmarkRow {
    pub scope_id: String,
    pub bookmark_id: String,
    pub book_id: String,
    pub location: Option<String>,
    pub href: Option<String>,
    pub page_index: Option<i64>,
    pub progress_percent: f64,
    pub label: Option<String>,
    pub note: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub saved_at_ms: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct BookHighlightRow {
    pub scope_id: String,
    pub highlight_id: String,
    pub book_id: String,
    pub start_locator_json: String,
    pub end_locator_json: String,
    pub selected_text: String,
    pub color_argb: i64,
    pub note: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct BookHistoryRow {
    pub scope_id: String,
    pub history_id: String,
    pub book_id: String,
    pub renderer: Option<String>,
    pub location: Option<String>,
    pub href: Option<String>,
    pub page_index: Option<i64>,
    pub progress_percent: f64,
    pub section_label: Option<String>,
    pub read_at_ms: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct NovelBookmarkRow {
    pub scope_id: String,
    pub bookmark_id: String,
    pub novel_id: String,
    pub chapter_id: Option<String>,
    pub chapter_title: Option<String>,
    pub chapter_order_key: Option<f64>,
    pub locator: Option<String>,
    pub locator_sort_key: Option<f64>,
    pub label: Option<String>,
    pub saved_at_ms: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct NovelEntryRow {
    pub scope_id: String,
    pub novel_id: String,
    pub identity_key: String,
    pub title: String,
    pub author: Option<String>,
    pub description: Option<String>,
    pub cover_url: Option<String>,
    pub external_novel_id: Option<String>,
    pub external_url: Option<String>,
    pub status: Option<String>,
    pub tags_json: String,
    pub source_json: String,
    pub added_at_ms: i64,
    pub entry_updated_at_ms: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct NovelChapterRow {
    pub scope_id: String,
    pub chapter_id: String,
    pub novel_id: String,
    pub path: String,
    pub title: String,
    pub chapter_order_key: f64,
    pub release_time_ms: Option<i64>,
    pub unread: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct NovelHistoryRow {
    pub scope_id: String,
    pub history_id: String,
    pub novel_id: String,
    pub chapter_id: Option<String>,
    pub chapter_title: Option<String>,
    pub chapter_order_key: Option<f64>,
    pub locator: Option<String>,
    pub locator_sort_key: Option<f64>,
    pub read_at_ms: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct NovelClassificationRow {
    pub scope_id: String,
    pub plugin_id: String,
    pub repository_id: Option<String>,
    pub repository_url: Option<String>,
    pub lang: Option<String>,
    pub version: Option<String>,
    pub status: String,
    pub notes: String,
    pub baseline_status: Option<String>,
    pub baseline_notes: Option<String>,
    pub issues_json: String,
    pub smoke_json: String,
    pub filter_keys_json: String,
    pub plugin_settings_keys_json: String,
    pub classified_at_ms: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct NovelRepositoryRow {
    pub scope_id: String,
    pub repository_id: String,
    pub canonical_url: String,
    pub name: String,
    pub enabled: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct NovelPluginRow {
    pub scope_id: String,
    pub plugin_entity_id: String,
    pub repository_id: String,
    pub plugin_id: String,
    pub source_id: String,
    pub name: String,
    pub version: String,
    pub lang: String,
    pub enabled: i64,
    pub artifact_sha256: String,
    pub artifact_byte_length: i64,
    pub public_settings_json: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct NovelChapterAssetRow {
    pub scope_id: String,
    pub chapter_asset_id: String,
    pub novel_id: String,
    pub chapter_id: String,
    pub schema_version: i64,
    pub blob_sha256: String,
    pub byte_length: i64,
    pub archive_format: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct NovelCategoryRow {
    pub scope_id: String,
    pub category_id: String,
    pub name: String,
    pub sort_order: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct NovelCategoryAssignmentRow {
    pub scope_id: String,
    pub assignment_id: String,
    pub novel_id: String,
    pub category_id: String,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct ComicHistoryRow {
    pub scope_id: String,
    pub history_id: String,
    pub comic_id: String,
    pub chapter_id: String,
    pub portable_work_ref_json: Option<String>,
    pub portable_chapter_ref_json: Option<String>,
    pub page_index: i64,
    pub page_count: Option<i64>,
    pub progress_percent: f64,
    pub read_at_ms: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct ComicPageBookmarkRow {
    pub scope_id: String,
    pub bookmark_id: String,
    pub comic_id: String,
    pub chapter_id: String,
    pub portable_work_ref_json: Option<String>,
    pub portable_chapter_ref_json: Option<String>,
    pub page_index: i64,
    pub page_count: Option<i64>,
    pub label: Option<String>,
    pub saved_at_ms: i64,
    pub record_updated_at_ms: i64,
    pub record_updated_by_device_id: String,
    pub record_lamport: i64,
    pub record_server_version: i64,
}

impl From<BookProgressRow> for BookProgressRecord {
    fn from(value: BookProgressRow) -> Self {
        Self {
            book_id: value.book_id,
            renderer: value.renderer,
            location: value.location,
            href: value.href,
            progress_percent: value.progress_percent,
            last_read_at_ms: value.last_read_at_ms,
            page_index: value.page_index,
            total_pages: value.total_pages,
            section_label: value.section_label,
            record_lamport: value.record_lamport,
        }
    }
}

impl From<BookHistoryRow> for BookHistoryRecord {
    fn from(value: BookHistoryRow) -> Self {
        Self {
            history_id: value.history_id,
            book_id: value.book_id,
            renderer: value.renderer,
            location: value.location,
            href: value.href,
            page_index: value.page_index,
            progress_percent: value.progress_percent,
            section_label: value.section_label,
            read_at_ms: value.read_at_ms,
            record_lamport: value.record_lamport,
        }
    }
}

impl TryFrom<BookEntryRow> for BookEntryRecord {
    type Error = serde_json::Error;

    fn try_from(value: BookEntryRow) -> Result<Self, Self::Error> {
        Ok(Self {
            book_id: value.book_id,
            asset_fingerprint: value.asset_fingerprint,
            mime_type: value.mime_type,
            byte_size: value.byte_size,
            cover_asset_sha256: value.cover_asset_sha256,
            cover_asset_byte_size: value.cover_asset_byte_size,
            cover_asset_mime_type: value.cover_asset_mime_type,
            title: value.title,
            author: value.author,
            description: value.description,
            subtype: value.subtype,
            page_count: value.page_count,
            toc_count: value.toc_count,
            spine_count: value.spine_count,
            section_count: value.section_count,
            sections_summary_json: value
                .sections_summary_json
                .map(|raw| serde_json::from_str(&raw))
                .transpose()?,
            has_cover: value.has_cover != 0,
            created_at_ms: value.created_at_ms,
            book_updated_at_ms: value.book_updated_at_ms,
            record_lamport: value.record_lamport,
        })
    }
}

impl From<BookCategoryRow> for BookCategoryRecord {
    fn from(value: BookCategoryRow) -> Self {
        Self {
            category_id: value.category_id,
            name: value.name,
            order: value.sort_order,
            record_lamport: value.record_lamport,
        }
    }
}

impl TryFrom<BookCategoryAssignmentRow> for BookCategoryAssignmentRecord {
    type Error = serde_json::Error;

    fn try_from(value: BookCategoryAssignmentRow) -> Result<Self, Self::Error> {
        Ok(Self {
            book_id: value.book_id,
            category_ids: serde_json::from_str(&value.category_ids_json)?,
            record_lamport: value.record_lamport,
        })
    }
}

impl From<BookLibraryUiRow> for BookLibraryUiRecord {
    fn from(value: BookLibraryUiRow) -> Self {
        Self {
            ui_state_id: value.ui_state_id,
            active_category_id: value.active_category_id,
            type_filter: value.type_filter,
            status_filter: value.status_filter,
            search: value.search,
            sort_mode: value.sort_mode,
            sort_dir: value.sort_dir,
            record_lamport: value.record_lamport,
        }
    }
}

impl From<NovelProgressRow> for NovelProgressRecord {
    fn from(value: NovelProgressRow) -> Self {
        Self {
            novel_id: value.novel_id,
            chapter_id: value.chapter_id,
            portable_work_ref: value
                .portable_work_ref_json
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok()),
            portable_chapter_ref: value
                .portable_chapter_ref_json
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok()),
            chapter_title: value.chapter_title,
            chapter_order_key: value.chapter_order_key,
            progress_percent: value.progress_percent,
            locator: value.locator,
            locator_sort_key: value.locator_sort_key,
            updated_at_ms: value.updated_at_ms,
            record_lamport: value.record_lamport,
        }
    }
}

impl From<BookBookmarkRow> for BookBookmarkRecord {
    fn from(value: BookBookmarkRow) -> Self {
        Self {
            bookmark_id: value.bookmark_id,
            book_id: value.book_id,
            location: value.location,
            href: value.href,
            page_index: value.page_index,
            progress_percent: value.progress_percent,
            label: value.label,
            note: value.note,
            created_at_ms: value.created_at_ms,
            updated_at_ms: value.updated_at_ms,
            saved_at_ms: value.saved_at_ms,
            record_lamport: value.record_lamport,
        }
    }
}

impl TryFrom<BookHighlightRow> for BookHighlightRecord {
    type Error = serde_json::Error;

    fn try_from(value: BookHighlightRow) -> Result<Self, Self::Error> {
        Ok(Self {
            highlight_id: value.highlight_id,
            book_id: value.book_id,
            start_locator_json: serde_json::from_str(&value.start_locator_json)?,
            end_locator_json: serde_json::from_str(&value.end_locator_json)?,
            selected_text: value.selected_text,
            color_argb: value.color_argb,
            note: value.note,
            created_at_ms: value.created_at_ms,
            updated_at_ms: value.updated_at_ms,
            record_lamport: value.record_lamport,
        })
    }
}

impl From<NovelBookmarkRow> for NovelBookmarkRecord {
    fn from(value: NovelBookmarkRow) -> Self {
        Self {
            bookmark_id: value.bookmark_id,
            novel_id: value.novel_id,
            chapter_id: value.chapter_id,
            chapter_title: value.chapter_title,
            chapter_order_key: value.chapter_order_key,
            locator: value.locator,
            locator_sort_key: value.locator_sort_key,
            label: value.label,
            saved_at_ms: value.saved_at_ms,
            record_lamport: value.record_lamport,
        }
    }
}

impl TryFrom<NovelEntryRow> for NovelEntryRecord {
    type Error = serde_json::Error;

    fn try_from(value: NovelEntryRow) -> Result<Self, Self::Error> {
        Ok(Self {
            novel_id: value.novel_id,
            identity_key: value.identity_key,
            title: value.title,
            author: value.author,
            description: value.description,
            cover_url: value.cover_url,
            path: value.external_url.unwrap_or_default(),
            status: value.status,
            tags: serde_json::from_str(&value.tags_json)?,
            source: serde_json::from_str(&value.source_json)?,
            added_at_ms: value.added_at_ms,
            updated_at_ms: value.entry_updated_at_ms,
            record_lamport: value.record_lamport,
        })
    }
}

impl From<NovelChapterRow> for NovelChapterRecord {
    fn from(value: NovelChapterRow) -> Self {
        Self {
            chapter_id: value.chapter_id,
            novel_id: value.novel_id,
            path: value.path,
            title: value.title,
            chapter_order_key: value.chapter_order_key,
            release_time_ms: value.release_time_ms,
            unread: value.unread != 0,
            record_lamport: value.record_lamport,
        }
    }
}

impl From<NovelHistoryRow> for NovelHistoryRecord {
    fn from(value: NovelHistoryRow) -> Self {
        Self {
            history_id: value.history_id,
            novel_id: value.novel_id,
            chapter_id: value.chapter_id,
            chapter_title: value.chapter_title,
            locator: value.locator,
            read_at_ms: value.read_at_ms,
            record_lamport: value.record_lamport,
        }
    }
}

impl TryFrom<NovelClassificationRow> for NovelClassificationRecord {
    type Error = serde_json::Error;

    fn try_from(value: NovelClassificationRow) -> Result<Self, Self::Error> {
        Ok(Self {
            plugin_id: value.plugin_id,
            repository_id: value.repository_id,
            repository_url: value.repository_url,
            lang: value.lang,
            version: value.version,
            status: value.status,
            notes: value.notes,
            baseline_status: value.baseline_status,
            baseline_notes: value.baseline_notes,
            issues_json: serde_json::from_str(&value.issues_json)?,
            smoke_json: serde_json::from_str(&value.smoke_json)?,
            filter_keys: serde_json::from_str(&value.filter_keys_json)?,
            plugin_settings_keys: serde_json::from_str(&value.plugin_settings_keys_json)?,
            classified_at_ms: value.classified_at_ms,
            record_lamport: value.record_lamport,
        })
    }
}

impl From<NovelChapterAssetRow> for NovelChapterAssetRecord {
    fn from(value: NovelChapterAssetRow) -> Self {
        Self {
            chapter_asset_id: value.chapter_asset_id,
            schema_version: value.schema_version as u32,
            novel_id: value.novel_id,
            chapter_id: value.chapter_id,
            blob_sha256: value.blob_sha256,
            byte_length: value.byte_length,
            archive_format: value.archive_format,
            created_at_ms: value.created_at_ms,
            updated_at_ms: value.updated_at_ms,
            record_lamport: value.record_lamport,
        }
    }
}

impl From<NovelRepositoryRow> for NovelRepositoryRecord {
    fn from(value: NovelRepositoryRow) -> Self {
        Self {
            repository_id: value.repository_id,
            canonical_url: value.canonical_url,
            name: value.name,
            enabled: value.enabled != 0,
            created_at_ms: value.created_at_ms,
            updated_at_ms: value.updated_at_ms,
            record_lamport: value.record_lamport,
        }
    }
}

impl TryFrom<NovelPluginRow> for NovelPluginRecord {
    type Error = serde_json::Error;

    fn try_from(value: NovelPluginRow) -> Result<Self, Self::Error> {
        Ok(Self {
            plugin_entity_id: value.plugin_entity_id,
            repository_id: value.repository_id,
            plugin_id: value.plugin_id,
            source_id: value.source_id,
            name: value.name,
            version: value.version,
            lang: value.lang,
            enabled: value.enabled != 0,
            artifact_sha256: value.artifact_sha256,
            artifact_byte_length: value.artifact_byte_length,
            public_settings: serde_json::from_str(&value.public_settings_json)?,
            created_at_ms: value.created_at_ms,
            updated_at_ms: value.updated_at_ms,
            record_lamport: value.record_lamport,
        })
    }
}

impl From<NovelCategoryRow> for NovelCategoryRecord {
    fn from(value: NovelCategoryRow) -> Self {
        Self {
            category_id: value.category_id,
            name: value.name,
            order: value.sort_order,
            record_lamport: value.record_lamport,
        }
    }
}

impl From<NovelCategoryAssignmentRow> for NovelCategoryAssignmentRecord {
    fn from(value: NovelCategoryAssignmentRow) -> Self {
        Self {
            assignment_id: value.assignment_id,
            novel_id: value.novel_id,
            category_id: value.category_id,
            record_lamport: value.record_lamport,
        }
    }
}

impl From<ComicHistoryRow> for ComicHistoryRecord {
    fn from(value: ComicHistoryRow) -> Self {
        Self {
            history_id: value.history_id,
            comic_id: value.comic_id,
            chapter_id: value.chapter_id,
            portable_work_ref: value
                .portable_work_ref_json
                .and_then(|json| serde_json::from_str(&json).ok()),
            portable_chapter_ref: value
                .portable_chapter_ref_json
                .and_then(|json| serde_json::from_str(&json).ok()),
            page_index: value.page_index,
            page_count: value.page_count,
            progress_percent: value.progress_percent,
            read_at_ms: value.read_at_ms,
            record_lamport: value.record_lamport,
        }
    }
}

impl From<ComicPageBookmarkRow> for ComicPageBookmarkRecord {
    fn from(value: ComicPageBookmarkRow) -> Self {
        Self {
            bookmark_id: value.bookmark_id,
            comic_id: value.comic_id,
            chapter_id: value.chapter_id,
            portable_work_ref: value
                .portable_work_ref_json
                .and_then(|json| serde_json::from_str(&json).ok()),
            portable_chapter_ref: value
                .portable_chapter_ref_json
                .and_then(|json| serde_json::from_str(&json).ok()),
            page_index: value.page_index,
            page_count: value.page_count,
            label: value.label,
            saved_at_ms: value.saved_at_ms,
            record_lamport: value.record_lamport,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn portable_v3_keys_remain_opaque_and_source_ids_are_strings() {
        let value = json!({
            "type": "comic",
            "sourceId": "9223372036854775807",
            "mangaKey": "/Manga/Title?chapter=AbC%2F123#fragment"
        });
        let reference: PortableWorkRefV3 = serde_json::from_value(value.clone()).unwrap();

        reference.validate().unwrap();
        assert_eq!(serde_json::to_value(reference).unwrap(), value);
    }

    #[test]
    fn portable_v3_rejects_secret_bearing_provider_keys_without_normalizing_them() {
        for manga_key in [
            "/manga/title?token=secret",
            "/manga/title?API_KEY=secret",
            "/manga/title#token=secret",
            "/manga/title#Authorization=secret",
            "https://user:secret@example.com/manga/title",
        ] {
            assert!(PortableWorkRefV3::Comic {
                source_id: "1".to_string(),
                manga_key: manga_key.to_string(),
            }
            .validate()
            .is_err());
        }
    }

    #[test]
    fn portable_v3_rejects_local_or_noncanonical_source_ids() {
        for source_id in ["", "01", "+1", "-0", "1.0", "9223372036854775808"] {
            let reference = PortableWorkRefV3::Comic {
                source_id: source_id.to_string(),
                manga_key: "/title".to_string(),
            };
            assert!(reference.validate().is_err(), "{source_id}");
        }
        assert!(PortableWorkRefV3::Comic {
            source_id: "-1".to_string(),
            manga_key: "/title".to_string(),
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn portable_v3_keeps_extension_and_source_identity_separate() {
        let dependency = ComicDependencyV3 {
            pkg_name: "eu.kanade.tachiyomi.extension.en.example".to_string(),
            required_source_ids: BTreeSet::from(["10001".to_string(), "10002".to_string()]),
            observed_version_code: None,
            extension_store: None,
        };

        dependency.validate().unwrap();
        assert_eq!(dependency.required_source_ids.len(), 2);
    }

    #[test]
    fn omitted_progress_reset_defaults_to_false() {
        let book: BookProgressPatch = serde_json::from_value(json!({
            "renderer": "pdf",
            "progressPercent": 0.5,
            "lastReadAtMs": 1,
            "pageIndex": 4
        }))
        .unwrap();
        let novel: NovelProgressPatch = serde_json::from_value(json!({
            "chapterId": "chapter-1",
            "progressPercent": 0.5,
            "updatedAtMs": 1
        }))
        .unwrap();

        assert!(!book.reset);
        assert!(!novel.reset);
        assert!(serde_json::to_value(&book).unwrap().get("reset").is_none());
        assert!(serde_json::to_value(&novel).unwrap().get("reset").is_none());
    }

    #[test]
    fn client_payloads_with_unknown_fields_are_accepted_and_the_fields_dropped() {
        // A client on a newer contract may send fields this Core does not know yet.
        let clock: EventClock = serde_json::from_value(json!({
            "physicalMs": 10,
            "logical": 2,
            "deviceGenerationId": "device-1",
            "futureField": true
        }))
        .unwrap();
        let patch: ComicEntryPatch = serde_json::from_value(json!({
            "comicId": "comic-1",
            "inLibrary": true,
            "futureField": { "nested": 1 }
        }))
        .unwrap();

        assert_eq!(clock.device_generation_id, "device-1");
        assert!(patch.in_library);
        assert!(serde_json::to_value(&clock).unwrap().get("futureField").is_none());
        assert!(serde_json::to_value(&patch).unwrap().get("futureField").is_none());
    }

    #[test]
    fn canonical_novel_identity_matches_mobile_contract() {
        let patch = NovelEntryPatch {
            identity_key: "legacy".to_string(),
            title: "Example".to_string(),
            author: None,
            description: None,
            cover_url: None,
            path: "/novel/1".to_string(),
            status: None,
            tags: Vec::new(),
            source: json!({
                "repositoryUrl": "HTTPS://Example.COM:443/repository/",
                "pluginId": "plugin",
                "sourceId": "source"
            }),
            added_at_ms: 1,
            updated_at_ms: 1,
            portable_work_ref: None,
        };

        assert_eq!(
            canonical_novel_identity_key(&patch).as_deref(),
            Some("novel-2ddcfbbb73a4bc27095ac742d5e3355a7f432b5ecd484525fb59fbbaf8a9b127")
        );
    }

    #[test]
    fn repository_and_plugin_identity_vectors_are_cross_client_stable() {
        let url =
            canonicalize_novel_repository_url(" HTTPS://Example.COM:443/repository.json ").unwrap();
        assert_eq!(url, "https://example.com/repository.json");
        let repository_id = canonical_novel_repository_id(&url);
        assert_eq!(
            repository_id,
            "novel-repository:1dae0c9bc42503917273ec8bfd1e4fc3de900db765867042f176cd26fdbff91f"
        );
        assert_eq!(
            canonical_novel_plugin_id(&repository_id, "plugin.test", "source.test"),
            "novel-plugin:c7f378a0a77a9b38db6595eaf913f71a83541ac80f4c5876a8e7079c69ff0d69"
        );
    }

    #[test]
    fn repository_url_rejects_all_secret_bearing_shapes() {
        for url in [
            "http://example.com/repository.json",
            "https://user@example.com/repository.json",
            "https://example.com/repository.json?token=signed",
            "https://example.com/repository.json#fragment",
        ] {
            assert_eq!(canonicalize_public_novel_repository_url(url), None, "{url}");
            assert_eq!(canonicalize_novel_repository_url(url), None, "{url}");
        }
        for url in [
            "https://localhost/plugins.min.json",
            "https://repo.local/plugins.min.json",
            "https://192.168.1.10/plugins.min.json",
            "https://[::1]/plugins.min.json",
        ] {
            assert!(canonicalize_novel_repository_url(url).is_some(), "{url}");
            assert_eq!(canonicalize_public_novel_repository_url(url), None, "{url}");
        }
    }

    #[test]
    fn canonical_novel_category_assignment_identity_is_cross_client_stable() {
        assert_eq!(
            canonical_novel_category_assignment_id("novel-1", "favorites"),
            "novel-category-assignment:be1ba0afe73482b338f0d7cdf212703a1a750803397646c1d9ee59fb80cf15f3"
        );
        assert_ne!(
            canonical_novel_category_assignment_id("novel-1", "favorites"),
            canonical_novel_category_assignment_id("novel-1", "later")
        );
    }

    #[test]
    fn canonical_novel_chapter_asset_identity_is_cross_client_stable() {
        assert_eq!(
            canonical_novel_chapter_asset_id("novel-1", "chapter-1"),
            "novel-chapter-asset:45f0db7cbdb7a96f8b5a958f365871294d289b3c4ba3cc9fc708e411f471e4c6"
        );
        assert_ne!(
            canonical_novel_chapter_asset_id("novel-1", "chapter-1"),
            canonical_novel_chapter_asset_id("novel-1", "chapter-2")
        );
    }
}
