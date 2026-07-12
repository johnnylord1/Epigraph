use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use std::collections::BTreeSet;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex, RwLock};

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
    pub snapshot_schema_version: u32,
    pub snapshot_entity_types: Vec<String>,
    pub tls_cert_sha256: String,
    pub mdns_service_name: String,
    pub current_server_version: i64,
    pub min_replayable_server_version: i64,
}

pub const SNAPSHOT_SCHEMA_VERSION: u32 = 1;

pub const SNAPSHOT_ENTITY_TYPES: [&str; 12] = [
    "book.entry",
    "book.category",
    "book.category_assignment",
    "book.library_ui",
    "book.progress",
    "book.bookmark",
    "novel.entry",
    "novel.chapter",
    "novel.progress",
    "novel.bookmark",
    "novel.history",
    "novel.classification",
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
    pub expires_at_ms: i64,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<PairingTokenResponse>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapSessionCreateRequest {
    pub profile_id: String,
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
    pub pairing_session_id: String,
    pub pairing_code: String,
    pub syncd_base_url: String,
    pub claim_url: String,
    pub profile_id: String,
    pub expires_at_ms: i64,
    pub tls_cert_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suwayomi_hint: Option<BootstrapSuwayomiHint>,
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
    #[serde(rename = "novel.entry")]
    NovelEntry,
    #[serde(rename = "novel.chapter")]
    NovelChapter,
    #[serde(rename = "novel.bookmark")]
    NovelBookmark,
    #[serde(rename = "novel.history")]
    NovelHistory,
    #[serde(rename = "novel.classification")]
    NovelClassification,
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
            Self::NovelEntry => "novel.entry",
            Self::NovelChapter => "novel.chapter",
            Self::NovelBookmark => "novel.bookmark",
            Self::NovelHistory => "novel.history",
            Self::NovelClassification => "novel.classification",
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationBase {
    pub client_mutation_id: String,
    pub scope_id: String,
    pub entity_id: String,
    #[serde(default)]
    pub op: MutationOperation,
    pub lamport: i64,
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
}

#[derive(Debug, Clone)]
pub struct MutationReceiptContext {
    pub device_id: String,
    pub client_mutation_id: String,
    pub mutation_hash: String,
    pub mutation_json: String,
    pub entity_type: MutationEntityType,
    pub entity_id: String,
    pub scope_id: String,
    pub op: MutationOperation,
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
            Self::NovelEntry { .. } => MutationEntityType::NovelEntry,
            Self::NovelChapter { .. } => MutationEntityType::NovelChapter,
            Self::NovelBookmark { .. } => MutationEntityType::NovelBookmark,
            Self::NovelHistory { .. } => MutationEntityType::NovelHistory,
            Self::NovelClassification { .. } => MutationEntityType::NovelClassification,
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
            | Self::NovelEntry { base, .. }
            | Self::NovelChapter { base, .. }
            | Self::NovelBookmark { base, .. }
            | Self::NovelHistory { base, .. }
            | Self::NovelClassification { base, .. } => base,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookEntryPatch {
    pub asset_fingerprint: Option<String>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelProgressPatch {
    pub chapter_id: Option<String>,
    pub chapter_title: Option<String>,
    pub chapter_order_key: Option<f64>,
    pub progress_percent: f64,
    pub locator: Option<String>,
    pub locator_sort_key: Option<f64>,
    pub updated_at_ms: i64,
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
    pub saved_at_ms: i64,
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

#[derive(Debug, Clone, Serialize)]
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
    pub scope_id: String,
    pub op: MutationOperation,
    pub status: MutationResultStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_server_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_lamport: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorDetail>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MutationResultStatus {
    Applied,
    Rejected,
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
    pub saved_at_ms: i64,
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

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct BookEntryRow {
    pub scope_id: String,
    pub book_id: String,
    pub asset_fingerprint: Option<String>,
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
    pub saved_at_ms: i64,
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

impl TryFrom<BookEntryRow> for BookEntryRecord {
    type Error = serde_json::Error;

    fn try_from(value: BookEntryRow) -> Result<Self, Self::Error> {
        Ok(Self {
            book_id: value.book_id,
            asset_fingerprint: value.asset_fingerprint,
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
            saved_at_ms: value.saved_at_ms,
            record_lamport: value.record_lamport,
        }
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
