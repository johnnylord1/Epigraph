use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Disks, Pid, System};
use tauri::{AppHandle, Manager};
use url::Url;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::suwayomi_maintenance::{
    self, ExclusiveMaintenanceGuard, MaintenancePhase, UpdateJournalState,
};
use crate::{
    find_java_pid_for_rootdir, is_loopback_http_url, stop_runtime_for_maintenance, patch_conf_key,
    process_is_alive, read_conf_value, read_server_owner, resolve_local_server_target,
    server_owner_path, server_spawn_lock_path, spawn_managed_server_for_update, strip_unc,
    suwayomi_data_dir, validate_server_owner, LaunchTarget, LocalServerTarget, OwnerReuseDecision,
};

const SUWAYOMI_SERVER_JAR: &str = "Suwayomi-Server.jar";
const SUWAYOMI_COMPATIBILITY_MANIFEST: &str =
    include_str!("../resources/suwayomi-compatibility.json");
const SUWAYOMI_RELEASES_API_URL: &str =
    "https://api.github.com/repos/Suwayomi/Suwayomi-Server/releases?per_page=50";
const SUWAYOMI_RELEASES_USER_AGENT: &str = "Epigraph-Suwayomi-Updater";
const SUWAYOMI_RELEASES_CACHE_TTL: Duration = Duration::from_secs(60);
const SUWAYOMI_SNAPSHOT_DIR: &str = "epigraph-update-snapshots";
const SUWAYOMI_SNAPSHOT_MANIFEST: &str = "snapshot-manifest.json";
const SUWAYOMI_SNAPSHOT_VERSION: &str = "2";
const SUWAYOMI_SNAPSHOT_SPACE_MARGIN_BYTES: u64 = 1024 * 1024;
const SUWAYOMI_RUNTIME_DIR: &str = "suwayomi-runtime";
const SUWAYOMI_STAGING_DIR: &str = "staging";
const SUWAYOMI_CURRENT_DIR: &str = "current";
const SUWAYOMI_PREVIOUS_DIR: &str = "previous";
const SUWAYOMI_STAGING_MANIFEST: &str = "staging-manifest.json";
const SUWAYOMI_DIAGNOSTICS_DIR: &str = "diagnostics";
const MIN_STAGED_JAR_BYTES: u64 = 1024 * 1024;
const PROMOTED_RUNTIME_MIN_ALIVE_MS: u64 = 2_000;
const SUWAYOMI_HEALTH_MAX_WAIT_MS: u64 = 90_000;
const SUWAYOMI_HEALTH_DELAY_MS: u64 = 1_000;
const SUWAYOMI_HEALTH_TIMEOUT_SECS: u64 = 5;
const SUWAYOMI_SNAPSHOT_ALLOWLIST: &[&str] = &[
    "server.conf",
    "database.mv.db",
    "database.trace.db",
    "server.owner.json",
];
const SUWAYOMI_SNAPSHOT_DIRECTORY_ALLOWLIST: &[&str] = &["extensions", "settings"];
const SUWAYOMI_SERVER_OWNER_FILE: &str = "server.owner.json";
const EXTENSION_BATCH_ROOT: &str = "extension-update-batches";
const EXTENSION_BATCH_JOURNAL: &str = "extension-update-journal.json";
const MAX_EXTENSION_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SuwayomiRuntimeMode {
    ManagedBundled,
    ManagedRuntime,
    ManagedUserBinary,
    External,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuwayomiJarVersion {
    pub version: Option<String>,
    pub revision: Option<String>,
    pub build_type: Option<String>,
    pub webui_tag: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuwayomiRuntimeStatus {
    pub mode: SuwayomiRuntimeMode,
    pub version: Option<String>,
    pub jar_version: Option<SuwayomiJarVersion>,
    pub jar_path: Option<String>,
    pub profile_id: Option<String>,
    pub root_dir: Option<String>,
    pub server_url: String,
    pub update_allowed: bool,
    pub block_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateCheckStatus {
    UpToDate,
    UpdateAvailable,
    Blocked,
    CheckFailed,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuwayomiUpdateCheckResult {
    pub status: UpdateCheckStatus,
    pub current_version: Option<String>,
    pub latest_compatible_version: Option<String>,
    pub release_tag: Option<String>,
    pub release_url: Option<String>,
    pub update_allowed: bool,
    pub block_reason: Option<String>,
    pub notes: Option<String>,
    pub release_notes: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuwayomiUpdateSnapshotResult {
    pub snapshot_path: String,
    pub manifest_path: String,
    pub copied_files: Vec<String>,
    pub stopped_runtime: bool,
    pub restarted_runtime: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuwayomiUpdateStageResult {
    pub staging_path: String,
    pub jar_path: String,
    pub version: String,
    pub sha256: String,
    pub asset_name: String,
    pub checksum_asset: String,
    pub release_tag: String,
    pub release_url: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuwayomiUpdatePromotionResult {
    pub current_path: String,
    pub previous_path: Option<String>,
    pub version: String,
    pub rolled_back: bool,
    pub restarted_runtime: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SuwayomiSnapshotManifest {
    schema_version: u32,
    snapshot_version: String,
    created_at: u128,
    profile_id: Option<String>,
    runtime_mode: SuwayomiRuntimeMode,
    suwayomi_version: Option<String>,
    source_root: String,
    files: Vec<SuwayomiSnapshotFile>,
    rollback_ready: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SuwayomiSnapshotFile {
    name: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SuwayomiStagingManifest {
    schema_version: u32,
    created_at: u128,
    version: String,
    sha256: String,
    asset_name: String,
    checksum_asset: String,
    release_tag: String,
    release_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SnapshotPlanFile {
    name: String,
    source_path: PathBuf,
    size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SuwayomiCompatibilityManifest {
    schema_version: u32,
    repository: String,
    min_supported_version: String,
    max_tested_version: String,
    checksum_asset: String,
    signature_asset: Option<String>,
    allowed_versions: Vec<SuwayomiAllowedVersion>,
    blocked_versions: Vec<SuwayomiBlockedVersion>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SuwayomiAllowedVersion {
    version: String,
    asset: String,
    sha256: String,
    compatibility_profile: SuwayomiCompatibilityProfile,
    transactional_extension_updates: bool,
    notes: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum SuwayomiCompatibilityProfile {
    V21,
    V23,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SuwayomiBlockedVersion {
    version: String,
    reason: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
    size: Option<u64>,
}

#[derive(Clone, Debug)]
struct CachedGithubReleases {
    fetched_at: Instant,
    releases: Vec<GithubRelease>,
}

static SUWAYOMI_RELEASES_CACHE: OnceLock<Mutex<Option<CachedGithubReleases>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SuwayomiUpdateErrorKind {
    OwnershipError,
    CompatibilityError,
    DownloadError,
    ChecksumError,
    SnapshotError,
    PromotionError,
    RollbackError,
    HealthCheckError,
}

impl SuwayomiUpdateErrorKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::OwnershipError => "OwnershipError",
            Self::CompatibilityError => "CompatibilityError",
            Self::DownloadError => "DownloadError",
            Self::ChecksumError => "ChecksumError",
            Self::SnapshotError => "SnapshotError",
            Self::PromotionError => "PromotionError",
            Self::RollbackError => "RollbackError",
            Self::HealthCheckError => "HealthCheckError",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ActiveSuwayomiUpdateLock {
    token: String,
    owner: String,
    started_at_ms: u128,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SuwayomiHealthDiagnosticCheck {
    attempt: usize,
    check: String,
    ok: bool,
    duration_ms: u128,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SuwayomiHealthDiagnosticReport {
    schema_version: u8,
    target_version: String,
    endpoint: String,
    started_at_ms: u128,
    elapsed_ms: u128,
    max_wait_ms: u64,
    timeout_secs: u64,
    delay_ms: u64,
    attempts: usize,
    last_error: String,
    checks: Vec<SuwayomiHealthDiagnosticCheck>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuwayomiUpdateLockStatus {
    pub in_progress: bool,
    pub owner: Option<String>,
    pub started_at_ms: Option<u128>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionUpdateBatchItem {
    package_name: String,
    version_code: String,
    version_name: String,
    store_id: String,
    store_url_canonical: String,
    artifact_url: String,
    artifact_type: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionUpdateBatchEvidence {
    package_name: String,
    version_code: String,
    version_name: String,
    artifact_sha256: String,
    store_id: String,
    store_url_canonical: String,
    source_ids: Vec<String>,
    status: String,
    failure_owner: String,
    failure_code: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionUpdateBatchResult {
    batch_id: String,
    runtime_version: String,
    runtime_artifact_sha256: String,
    approved: Vec<ExtensionUpdateBatchEvidence>,
    rejected: Vec<ExtensionUpdateBatchEvidence>,
    restarted_runtime: bool,
}

#[derive(Clone, Debug)]
struct StagedExtensionArtifact {
    input: ExtensionUpdateBatchItem,
    file_name: String,
    path: PathBuf,
    sha256: String,
}

struct ExtensionBatchCleanup {
    root: PathBuf,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum ExtensionBatchJournalState {
    Prepared,
    SnapshotCreated,
    Certifying,
    Activating,
    Committed,
    RollbackRunning,
    RolledBack,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionBatchJournal {
    schema_version: u32,
    operation_id: String,
    state: ExtensionBatchJournalState,
    profile_id: String,
    root_dir: String,
    server_url: String,
    runtime_version: String,
    snapshot_path: String,
    batch_root: String,
    candidate_profile_id: String,
    candidate_root_dir: String,
    candidate_server_url: String,
    updated_at_ms: u128,
}

impl ExtensionBatchJournal {
    fn transition(&mut self, state: ExtensionBatchJournalState) {
        self.state = state;
        self.updated_at_ms = unix_now_ms();
    }
}

impl Drop for ExtensionBatchCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub(crate) struct SuwayomiUpdateLockGuard {
    token: String,
    maintenance: Option<ExclusiveMaintenanceGuard>,
}

static SUWAYOMI_UPDATE_LOCK: OnceLock<Mutex<Option<ActiveSuwayomiUpdateLock>>> = OnceLock::new();

fn update_error(kind: SuwayomiUpdateErrorKind, message: impl Into<String>) -> String {
    let message = message.into();
    if message.starts_with(kind.as_str()) {
        message
    } else {
        format!("{}: {}", kind.as_str(), message)
    }
}

fn log_update_start(step: &str) -> Instant {
    eprintln!("[epigraph-suwayomi-update] start step={step}");
    Instant::now()
}

fn log_update_success(step: &str, started: Instant) {
    eprintln!(
        "[epigraph-suwayomi-update] success step={step} duration_ms={}",
        started.elapsed().as_millis()
    );
}

fn log_update_failure(step: &str, started: Instant, error: &str) {
    let sanitized = error.replace('\n', " ");
    eprintln!(
        "[epigraph-suwayomi-update] failure step={step} duration_ms={} reason={sanitized}",
        started.elapsed().as_millis()
    );
}

fn log_update_result<T>(
    step: &str,
    started: Instant,
    result: Result<T, String>,
) -> Result<T, String> {
    match &result {
        Ok(_) => log_update_success(step, started),
        Err(error) => log_update_failure(step, started, error),
    }
    result
}

#[tauri::command]
pub fn get_suwayomi_runtime_status(
    server_url: Option<String>,
    binary: Option<String>,
    profile_id: Option<String>,
    profile_label: Option<String>,
    app: AppHandle,
) -> SuwayomiRuntimeStatus {
    let normalized_server_url = normalize_server_url(server_url.as_deref());
    let binary = binary.unwrap_or_default();

    if normalized_server_url.is_empty() {
        return blocked_status(
            SuwayomiRuntimeMode::Unknown,
            normalized_server_url,
            None,
            None,
            None,
            None,
            "Server URL is not configured.",
        );
    }

    if Url::parse(&normalized_server_url).is_err() {
        return blocked_status(
            SuwayomiRuntimeMode::Unknown,
            normalized_server_url,
            None,
            None,
            None,
            None,
            "Server URL is invalid.",
        );
    }

    if !is_loopback_http_url(&normalized_server_url) {
        return blocked_status(
            SuwayomiRuntimeMode::External,
            normalized_server_url,
            None,
            None,
            None,
            None,
            "External Suwayomi servers are not managed by Epigraph.",
        );
    }

    let launch_target = app.state::<LaunchTarget>().0.clone();
    let target = match resolve_local_server_target(
        &launch_target,
        Some(normalized_server_url.as_str()),
        profile_id.as_deref(),
        profile_label.as_deref(),
    ) {
        Ok(target) => target,
        Err(error) => {
            return blocked_status(
                SuwayomiRuntimeMode::Unknown,
                normalized_server_url,
                None,
                None,
                None,
                None,
                &format!("Could not resolve the local Suwayomi profile: {error:?}"),
            );
        }
    };

    let profile_id = Some(target.profile_key.clone());
    let root_dir = Some(path_to_string(&target.root_dir));

    if target.attach_only {
        return blocked_status(
            SuwayomiRuntimeMode::External,
            target.server_url,
            profile_id,
            root_dir,
            None,
            None,
            "This session is attach-only; Epigraph will not update its Suwayomi server.",
        );
    }

    if !binary.trim().is_empty() {
        let user_binary = strip_unc(PathBuf::from(binary.trim()));
        return blocked_status(
            SuwayomiRuntimeMode::ManagedUserBinary,
            target.server_url,
            profile_id,
            root_dir,
            Some(user_binary),
            None,
            "A user-provided Suwayomi binary is not updated by Epigraph.",
        );
    }

    let java_pid = match prove_epigraph_runtime_ownership(&target) {
        Ok(java_pid) => java_pid,
        Err(reason) => {
            return blocked_status(
                SuwayomiRuntimeMode::Unknown,
                target.server_url,
                profile_id,
                root_dir,
                None,
                None,
                &reason,
            );
        }
    };

    let runtime_jar = managed_runtime_jar_path();
    let bundled_jar = bundled_jar_path(&app);
    if let Some((mode, jar_path)) =
        select_effective_managed_jar(&runtime_jar, &bundled_jar, |jar_path| {
            java_pid_uses_jar(java_pid, jar_path)
        })
    {
        return allowed_status(mode, target.server_url, profile_id, root_dir, jar_path);
    }

    let fallback_jar = if runtime_jar.exists() {
        Some(runtime_jar)
    } else if bundled_jar.exists() {
        Some(bundled_jar)
    } else {
        None
    };
    let reason = if fallback_jar.is_some() {
        "Epigraph owns the local server, but the effective Suwayomi JAR is not a managed Epigraph JAR."
    } else {
        "Epigraph could not find a managed Suwayomi JAR."
    };
    blocked_status(
        SuwayomiRuntimeMode::Unknown,
        target.server_url,
        profile_id,
        root_dir,
        fallback_jar,
        None,
        reason,
    )
}

#[tauri::command]
pub fn get_suwayomi_update_lock_status() -> SuwayomiUpdateLockStatus {
    current_suwayomi_update_lock_status()
}

#[tauri::command]
pub fn create_suwayomi_update_snapshot(
    server_url: Option<String>,
    binary: Option<String>,
    profile_id: Option<String>,
    profile_label: Option<String>,
    app: AppHandle,
) -> Result<SuwayomiUpdateSnapshotResult, String> {
    let started = log_update_start("snapshot");
    let result = (|| {
        let mut guard = try_acquire_suwayomi_update_lock("snapshot")?;
        guard.begin_maintenance("snapshot", MaintenancePhase::Updating)?;
        create_suwayomi_update_snapshot_unlocked(
            server_url,
            binary,
            profile_id,
            profile_label,
            true,
            app,
        )
    })()
    .map_err(|error| update_error(SuwayomiUpdateErrorKind::SnapshotError, error));
    log_update_result("snapshot", started, result)
}

fn create_suwayomi_update_snapshot_unlocked(
    server_url: Option<String>,
    binary: Option<String>,
    profile_id: Option<String>,
    profile_label: Option<String>,
    restart_after_success: bool,
    app: AppHandle,
) -> Result<SuwayomiUpdateSnapshotResult, String> {
    let runtime = get_suwayomi_runtime_status(
        server_url.clone(),
        binary.clone(),
        profile_id.clone(),
        profile_label.clone(),
        app.clone(),
    );
    if !runtime.update_allowed {
        return Err(runtime
            .block_reason
            .unwrap_or_else(|| "This Suwayomi runtime is not managed by Epigraph.".to_string()));
    }

    let target = resolve_update_target(server_url, profile_id, profile_label, &app)?;
    let stopped_runtime = stop_managed_runtime_for_snapshot(&app, &target)?;
    let snapshot = (|| {
        assert_profile_database_unlocked(&target.root_dir)?;
        let plan = plan_snapshot_files(&target.root_dir)?;
        ensure_snapshot_disk_space(&target.root_dir, &plan)?;
        create_snapshot_for_plan(
            &target.root_dir,
            plan,
            Some(target.profile_key.clone()),
            runtime.mode,
            runtime.version,
        )
    })();
    match snapshot {
        Ok(mut result) => {
            result.stopped_runtime = stopped_runtime;
            result.restarted_runtime = if restart_after_success {
                restart_runtime_after_snapshot_failure(stopped_runtime, || {
                    restart_managed_runtime(&app, &target)
                })?
            } else {
                false
            };
            Ok(result)
        }
        Err(error) => {
            let restart_result = restart_runtime_after_snapshot_failure(stopped_runtime, || {
                restart_managed_runtime(&app, &target)
            });
            let restart_note = match restart_result {
                Ok(true) => " The managed runtime was restarted.",
                Ok(false) => "",
                Err(restart_error) => {
                    return Err(format!(
                        "Snapshot failed: {error}. The managed runtime could not be restarted: {restart_error}"
                    ));
                }
            };
            Err(format!("Snapshot failed: {error}.{restart_note}"))
        }
    }
}

#[tauri::command]
pub async fn stage_suwayomi_runtime_update(
    server_url: Option<String>,
    binary: Option<String>,
    profile_id: Option<String>,
    profile_label: Option<String>,
    target_version: Option<String>,
    app: AppHandle,
) -> Result<SuwayomiUpdateStageResult, String> {
    let started = log_update_start("staging");
    let result = async {
        let _guard = try_acquire_suwayomi_update_lock("staging")?;
        let runtime =
            get_suwayomi_runtime_status(server_url, binary, profile_id, profile_label, app);
        if let Some(blocked) = runtime_update_preflight_block(&runtime) {
            return Err(blocked
                .block_reason
                .unwrap_or_else(|| "This Suwayomi runtime is not managed by Epigraph.".to_string()));
        }

        let manifest = load_compatibility_manifest()?;
        if let Some(blocked) = manifest_preflight_block(&runtime, &manifest) {
            return Err(blocked.block_reason.unwrap_or_else(|| {
                "This Suwayomi version is not eligible for update.".to_string()
            }));
        }
        let releases = fetch_suwayomi_releases().await?;
        let candidate =
            select_staging_candidate(&runtime, &manifest, &releases, target_version.as_deref())?;

        let checksum_text = download_release_text(&candidate.checksum_url).await?;
        let published_sha256 = checksum_for_asset(&checksum_text, &candidate.asset_name)?;
        let expected_sha256 = certified_release_checksum(
            &manifest,
            &candidate.version,
            &candidate.asset_name,
            &published_sha256,
        )?;

        stage_release_jar(
            &managed_runtime_staging_root(),
            &candidate,
            &manifest,
            &expected_sha256,
            MIN_STAGED_JAR_BYTES,
        )
        .await
    }
    .await
    .map_err(|error| {
        if error.contains("SHA-256") || error.contains("Checksum") {
            update_error(SuwayomiUpdateErrorKind::ChecksumError, error)
        } else if error.contains("allowlist")
            || error.contains("blocked")
            || error.contains("tested range")
        {
            update_error(SuwayomiUpdateErrorKind::CompatibilityError, error)
        } else if error.contains("not managed") || error.contains("ownership") {
            update_error(SuwayomiUpdateErrorKind::OwnershipError, error)
        } else {
            update_error(SuwayomiUpdateErrorKind::DownloadError, error)
        }
    });
    log_update_result("staging", started, result)
}

#[tauri::command]
pub async fn promote_suwayomi_runtime_update(
    server_url: Option<String>,
    binary: Option<String>,
    profile_id: Option<String>,
    profile_label: Option<String>,
    staged_version: String,
    snapshot_path: String,
    auth_header: Option<String>,
    app: AppHandle,
) -> Result<SuwayomiUpdatePromotionResult, String> {
    let started = log_update_start("promotion");
    let result = async {
        let mut guard = try_acquire_suwayomi_update_lock("promotion")?;
        guard.begin_maintenance("promotion", MaintenancePhase::Updating)?;
        promote_suwayomi_runtime_update_unlocked(
            server_url,
            binary,
            profile_id,
            profile_label,
            staged_version,
            snapshot_path,
            auth_header,
            app,
            false,
        )
        .await
    }
    .await
    .map_err(|error| {
        if error.contains("Automatic rollback also failed") {
            update_error(SuwayomiUpdateErrorKind::RollbackError, error)
        } else {
            update_error(SuwayomiUpdateErrorKind::PromotionError, error)
        }
    });
    log_update_result("promotion", started, result)
}

#[tauri::command]
pub async fn install_suwayomi_runtime_update(
    server_url: Option<String>,
    binary: Option<String>,
    profile_id: Option<String>,
    profile_label: Option<String>,
    staged_version: String,
    auth_header: Option<String>,
    app: AppHandle,
) -> Result<SuwayomiUpdatePromotionResult, String> {
    let started = log_update_start("install");
    let result = async {
        let mut guard = try_acquire_suwayomi_update_lock("install")?;
        guard.begin_maintenance("install", MaintenancePhase::Updating)?;
        let snapshot = create_suwayomi_update_snapshot_unlocked(
            server_url.clone(),
            binary.clone(),
            profile_id.clone(),
            profile_label.clone(),
            false,
            app.clone(),
        )?;
        promote_suwayomi_runtime_update_unlocked(
            server_url,
            binary,
            profile_id,
            profile_label,
            staged_version,
            snapshot.snapshot_path,
            auth_header,
            app,
            true,
        )
        .await
    }
    .await
    .map_err(|error| {
        if error.contains("Automatic rollback also failed") {
            update_error(SuwayomiUpdateErrorKind::RollbackError, error)
        } else if error.contains("Snapshot failed") || error.contains("snapshot") {
            update_error(SuwayomiUpdateErrorKind::SnapshotError, error)
        } else {
            update_error(SuwayomiUpdateErrorKind::PromotionError, error)
        }
    });
    log_update_result("install", started, result)
}

async fn promote_suwayomi_runtime_update_unlocked(
    server_url: Option<String>,
    binary: Option<String>,
    profile_id: Option<String>,
    profile_label: Option<String>,
    staged_version: String,
    snapshot_path: String,
    auth_header: Option<String>,
    app: AppHandle,
    runtime_already_stopped: bool,
) -> Result<SuwayomiUpdatePromotionResult, String> {
    if !runtime_already_stopped {
        let runtime = get_suwayomi_runtime_status(
            server_url.clone(),
            binary.clone(),
            profile_id.clone(),
            profile_label.clone(),
            app.clone(),
        );
        if !runtime.update_allowed {
            return Err(runtime
                .block_reason
                .unwrap_or_else(|| "This Suwayomi runtime is not managed by Epigraph.".to_string()));
        }
    }

    let target = resolve_update_target(server_url, profile_id, profile_label, &app)?;
    let manifest = match load_compatibility_manifest() {
        Ok(manifest) => manifest,
        Err(error) => {
            restart_after_preparation_failure(runtime_already_stopped, &app, &target)?;
            return Err(error);
        }
    };
    let snapshot_dir = PathBuf::from(snapshot_path);
    if let Err(error) = validate_snapshot_for_restore(&snapshot_dir) {
        restart_after_preparation_failure(runtime_already_stopped, &app, &target)?;
        return Err(error);
    }
    let staging_dir = managed_runtime_staging_root().join(normalize_version_tag(&staged_version));
    let staging_manifest = match validate_staging_dir(&staging_dir, &manifest) {
        Ok(manifest) => manifest,
        Err(error) => {
            restart_after_preparation_failure(runtime_already_stopped, &app, &target)?;
            return Err(error);
        }
    };

    let stopped_runtime = if runtime_already_stopped {
        true
    } else {
        stop_managed_runtime_for_snapshot(&app, &target)?
    };
    let runtime_root = managed_runtime_root();
    let operation_id = Uuid::new_v4().to_string();
    let promotion =
        match plan_runtime_promotion(&runtime_root, &staging_manifest.version, &operation_id) {
            Ok(promotion) => promotion,
            Err(error) => {
                let _ = restart_runtime_after_snapshot_failure(stopped_runtime, || {
                    restart_managed_runtime(&app, &target)
                });
                return Err(error);
            }
        };
    let journal_path = suwayomi_maintenance::update_journal_path(&runtime_root);
    let previous_dir = runtime_root.join(SUWAYOMI_PREVIOUS_DIR);
    let mut journal = suwayomi_maintenance::new_update_journal(
        operation_id,
        target.profile_key.clone(),
        path_to_string(&target.root_dir),
        target.server_url.clone(),
        staging_manifest.version.clone(),
        path_to_string(&snapshot_dir),
        path_to_string(&promotion.current_dir),
        path_to_string(&previous_dir),
        promotion
            .previous_backup_dir
            .as_ref()
            .map(|path| path_to_string(path))
            .unwrap_or_default(),
        path_to_string(&promotion.staging_dir),
        promotion.had_current,
    );
    if let Err(error) = suwayomi_maintenance::write_update_journal(&journal_path, &journal) {
        let _ = restart_runtime_after_snapshot_failure(stopped_runtime, || {
            restart_managed_runtime(&app, &target)
        });
        return Err(error);
    }
    if let Err(error) = apply_runtime_promotion(&promotion) {
        journal.transition(UpdateJournalState::RollbackRunning);
        let _ = suwayomi_maintenance::write_update_journal(&journal_path, &journal);
        let rollback = rollback_promoted_runtime(
            &app,
            &target,
            &promotion,
            &snapshot_dir,
            auth_header.as_deref(),
        )
        .await;
        if rollback.is_ok() {
            journal.transition(UpdateJournalState::RolledBack);
            let _ = suwayomi_maintenance::write_update_journal(&journal_path, &journal);
            let _ = suwayomi_maintenance::remove_update_journal(&journal_path);
        }
        return match rollback {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(format!(
                "Promotion failed: {error}. Automatic rollback also failed: {rollback_error}"
            )),
        };
    }
    journal.transition(UpdateJournalState::RuntimePromoted);
    if let Err(error) = suwayomi_maintenance::write_update_journal(&journal_path, &journal) {
        return rollback_after_journal_failure(
            error,
            &journal_path,
            &mut journal,
            &app,
            &target,
            &promotion,
            &snapshot_dir,
            auth_header.as_deref(),
        )
        .await;
    }
    if let Err(error) = migrate_extension_store_config(&target.root_dir, &staging_manifest.version)
    {
        return rollback_after_journal_failure(
            error,
            &journal_path,
            &mut journal,
            &app,
            &target,
            &promotion,
            &snapshot_dir,
            auth_header.as_deref(),
        )
        .await;
    }
    journal.transition(UpdateJournalState::ProfileMigrated);
    if let Err(error) = suwayomi_maintenance::write_update_journal(&journal_path, &journal) {
        return rollback_after_journal_failure(
            error,
            &journal_path,
            &mut journal,
            &app,
            &target,
            &promotion,
            &snapshot_dir,
            auth_header.as_deref(),
        )
        .await;
    }
    journal.transition(UpdateJournalState::PostCheckRunning);
    if let Err(error) = suwayomi_maintenance::write_update_journal(&journal_path, &journal) {
        return rollback_after_journal_failure(
            error,
            &journal_path,
            &mut journal,
            &app,
            &target,
            &promotion,
            &snapshot_dir,
            auth_header.as_deref(),
        )
        .await;
    }

    let start_result = restart_managed_runtime(&app, &target).and_then(|_| {
        wait_for_runtime_jar(
            &target,
            &promotion.current_dir.join(SUWAYOMI_SERVER_JAR),
            runtime_stability_window(),
        )
    });
    let health_result = match start_result {
        Ok(()) => {
            run_suwayomi_graphql_health_check(
                &target.server_url,
                auth_header.as_deref(),
                &staging_manifest.version,
            )
            .await
        }
        Err(error) => Err(error),
    };
    match health_result {
        Ok(()) => {
            journal.transition(UpdateJournalState::Committed);
            suwayomi_maintenance::write_update_journal(&journal_path, &journal)?;
            if cleanup_previous_backup(&promotion).is_ok() {
                let _ = suwayomi_maintenance::remove_update_journal(&journal_path);
            }
            Ok(SuwayomiUpdatePromotionResult {
                current_path: path_to_string(&promotion.current_dir),
                previous_path: promotion
                    .previous_dir
                    .as_ref()
                    .map(|path| path_to_string(path)),
                version: staging_manifest.version,
                rolled_back: false,
                restarted_runtime: true,
            })
        }
        Err(error) => {
            journal.transition(UpdateJournalState::RollbackRunning);
            let _ = suwayomi_maintenance::write_update_journal(&journal_path, &journal);
            let rollback_result = rollback_promoted_runtime(
                &app,
                &target,
                &promotion,
                &snapshot_dir,
                auth_header.as_deref(),
            )
            .await
            .map_err(|rollback_error| {
                format!(
                    "Promotion failed: {error}. Automatic rollback also failed: {rollback_error}"
                )
            });
            match rollback_result {
                Ok(()) => {
                    journal.transition(UpdateJournalState::RolledBack);
                    let _ = suwayomi_maintenance::write_update_journal(&journal_path, &journal);
                    let _ = suwayomi_maintenance::remove_update_journal(&journal_path);
                    Err(format!(
                        "Promotion failed: {error}. The previous Suwayomi runtime was restored."
                    ))
                }
                Err(rollback_error) => Err(rollback_error),
            }
        }
    }
}

fn migrate_extension_store_config(root_dir: &Path, version: &str) -> Result<bool, String> {
    if compare_versions(version, "v2.3.0") != Some(std::cmp::Ordering::Greater)
        && compare_versions(version, "v2.3.0") != Some(std::cmp::Ordering::Equal)
    {
        return Ok(false);
    }
    let conf_path = root_dir.join("server.conf");
    let contents = fs::read_to_string(&conf_path)
        .map_err(|error| format!("Could not read Suwayomi configuration for migration: {error}"))?;
    let Some(legacy_value) = read_conf_value(&contents, "server.extensionRepos") else {
        return Ok(false);
    };
    let legacy = parse_store_list(&legacy_value, "server.extensionRepos")?;
    if legacy.is_empty() {
        return Ok(false);
    }
    let current = read_conf_value(&contents, "server.extensionStores")
        .map(|value| parse_store_list(&value, "server.extensionStores"))
        .transpose()?
        .unwrap_or_default();
    let mut merged = current;
    for url in legacy {
        let normalized = normalize_store_url(&url);
        if !merged
            .iter()
            .any(|existing| normalize_store_url(existing) == normalized)
        {
            merged.push(url);
        }
    }
    let serialized = serde_json::to_string(&merged)
        .map_err(|error| format!("Could not serialize migrated Extension Stores: {error}"))?;
    let patched = patch_conf_key(contents, "server.extensionStores", &serialized);
    let patched = remove_conf_key(patched, "server.extensionRepos");
    let temp_path = conf_path.with_extension(format!("conf.{}.tmp", Uuid::new_v4()));
    let mut file = File::create(&temp_path)
        .map_err(|error| format!("Could not create migrated Suwayomi configuration: {error}"))?;
    file.write_all(patched.as_bytes())
        .map_err(|error| format!("Could not write migrated Suwayomi configuration: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not sync migrated Suwayomi configuration: {error}"))?;
    suwayomi_maintenance::atomic_replace_file(&temp_path, &conf_path)
        .map_err(|error| format!("Could not publish migrated Suwayomi configuration: {error}"))?;
    Ok(true)
}

fn parse_store_list(value: &str, key: &str) -> Result<Vec<String>, String> {
    serde_json::from_str::<Vec<String>>(value)
        .map_err(|error| format!("Could not parse {key} during Suwayomi migration: {error}"))
}

fn normalize_store_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn remove_conf_key(text: String, key: &str) -> String {
    let mut lines = text
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            !trimmed
                .strip_prefix(key)
                .is_some_and(|suffix| suffix.trim_start().starts_with('='))
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !lines.is_empty() {
        lines.push('\n');
    }
    lines
}

fn restart_after_preparation_failure(
    runtime_already_stopped: bool,
    app: &AppHandle,
    target: &LocalServerTarget,
) -> Result<(), String> {
    if runtime_already_stopped {
        restart_managed_runtime(app, target)?;
    }
    Ok(())
}

async fn rollback_after_journal_failure(
    journal_error: String,
    journal_path: &Path,
    journal: &mut suwayomi_maintenance::SuwayomiUpdateJournal,
    app: &AppHandle,
    target: &LocalServerTarget,
    promotion: &RuntimePromotionState,
    snapshot_dir: &Path,
    auth_header: Option<&str>,
) -> Result<SuwayomiUpdatePromotionResult, String> {
    journal.transition(UpdateJournalState::RollbackRunning);
    let _ = suwayomi_maintenance::write_update_journal(journal_path, journal);
    match rollback_promoted_runtime(
        app,
        target,
        promotion,
        snapshot_dir,
        auth_header,
    )
    .await
    {
        Ok(()) => {
            journal.transition(UpdateJournalState::RolledBack);
            let _ = suwayomi_maintenance::write_update_journal(journal_path, journal);
            let _ = suwayomi_maintenance::remove_update_journal(journal_path);
            Err(format!(
                "Promotion journal failed: {journal_error}. The previous Suwayomi runtime was restored."
            ))
        }
        Err(rollback_error) => Err(format!(
            "Promotion journal failed: {journal_error}. Automatic rollback also failed: {rollback_error}"
        )),
    }
}

pub(crate) fn recover_suwayomi_update_before_spawn(
    app: &AppHandle,
    requested_target: &LocalServerTarget,
) -> Result<(), String> {
    recover_extension_batch_before_spawn(app, requested_target)?;
    let runtime_root = managed_runtime_root();
    let journal_path = suwayomi_maintenance::update_journal_path(&runtime_root);
    let Some(mut journal) = suwayomi_maintenance::read_update_journal(&journal_path)? else {
        return Ok(());
    };

    let mut guard = try_acquire_suwayomi_update_lock("recovery")?;
    guard.begin_maintenance("recovery", MaintenancePhase::Recovering)?;
    validate_recovery_journal_paths(&journal, &runtime_root)?;
    crate::set_runtime_status(
        app,
        crate::suwayomi_runtime::RuntimeLifecycleState::Recovering,
        Some(journal.profile_id.clone()),
        Some(journal.server_url.clone()),
        None,
        Some("Recovering an interrupted Suwayomi update.".to_string()),
    );

    let journal_root = PathBuf::from(&journal.root_dir);
    if find_java_pid_for_rootdir(&journal_root).is_some() {
        return Err(
            "An interrupted Suwayomi update cannot be recovered while its runtime is still active."
                .to_string(),
        );
    }
    if journal.state == UpdateJournalState::Committed {
        let backup = PathBuf::from(&journal.previous_backup_dir);
        if !journal.previous_backup_dir.is_empty() && backup.exists() {
            fs::remove_dir_all(&backup)
                .map_err(|error| format!("Could not clean committed runtime backup: {error}"))?;
        }
        suwayomi_maintenance::remove_update_journal(&journal_path)?;
        return Ok(());
    }

    journal.transition(UpdateJournalState::RollbackRunning);
    suwayomi_maintenance::write_update_journal(&journal_path, &journal)?;
    recover_runtime_directories(&journal)?;
    restore_snapshot_to_root(Path::new(&journal.snapshot_path), &journal_root)?;
    journal.transition(UpdateJournalState::RolledBack);
    suwayomi_maintenance::write_update_journal(&journal_path, &journal)?;
    suwayomi_maintenance::remove_update_journal(&journal_path)?;

    if requested_target.profile_key == journal.profile_id
        && comparable_path(&requested_target.root_dir) != comparable_path(&journal_root)
    {
        return Err(
            "Recovered Suwayomi profile does not match the requested runtime root.".to_string(),
        );
    }
    Ok(())
}

fn recover_runtime_directories(
    journal: &suwayomi_maintenance::SuwayomiUpdateJournal,
) -> Result<(), String> {
    let current_dir = PathBuf::from(&journal.current_dir);
    let previous_dir = PathBuf::from(&journal.previous_dir);
    let backup_dir = (!journal.previous_backup_dir.is_empty())
        .then(|| PathBuf::from(&journal.previous_backup_dir));
    let current_is_promoted = current_dir.join(SUWAYOMI_SERVER_JAR).is_file()
        && read_suwayomi_jar_version(&current_dir.join(SUWAYOMI_SERVER_JAR))
            .and_then(|version| version.version)
            .is_some_and(|version| {
                normalize_version_tag(&version) == normalize_version_tag(&journal.staged_version)
            });
    // A journal state can be replayed after the directory rollback already completed.
    // Only the staged runtime version proves that `current` is still the candidate.
    let promotion_was_published = current_is_promoted;

    if journal.had_current {
        if promotion_was_published && current_dir.exists() {
            fs::remove_dir_all(&current_dir)
                .map_err(|error| format!("Could not remove interrupted runtime: {error}"))?;
        }
        if !current_dir.exists() && previous_dir.exists() {
            rename_same_parent(&previous_dir, &current_dir)?;
        }
    } else if promotion_was_published && current_dir.exists() {
        fs::remove_dir_all(&current_dir)
            .map_err(|error| format!("Could not remove interrupted runtime: {error}"))?;
    }

    if let Some(backup_dir) = backup_dir {
        if backup_dir.exists() {
            if previous_dir.exists() {
                fs::remove_dir_all(&previous_dir).map_err(|error| {
                    format!("Could not replace previous runtime backup: {error}")
                })?;
            }
            rename_same_parent(&backup_dir, &previous_dir)?;
        }
    }
    Ok(())
}

fn validate_recovery_journal_paths(
    journal: &suwayomi_maintenance::SuwayomiUpdateJournal,
    runtime_root: &Path,
) -> Result<(), String> {
    let current_dir = PathBuf::from(&journal.current_dir);
    let previous_dir = PathBuf::from(&journal.previous_dir);
    let staging_dir = PathBuf::from(&journal.staging_dir);
    let expected_current = runtime_root.join(SUWAYOMI_CURRENT_DIR);
    let expected_previous = runtime_root.join(SUWAYOMI_PREVIOUS_DIR);
    let expected_staging = runtime_root
        .join(SUWAYOMI_STAGING_DIR)
        .join(normalize_version_tag(&journal.staged_version));
    if comparable_path(&current_dir) != comparable_path(&expected_current)
        || comparable_path(&previous_dir) != comparable_path(&expected_previous)
        || comparable_path(&staging_dir) != comparable_path(&expected_staging)
    {
        return Err("Suwayomi update journal contains unexpected runtime paths.".to_string());
    }
    if !journal.previous_backup_dir.is_empty() {
        let backup = PathBuf::from(&journal.previous_backup_dir);
        if backup.parent().map(comparable_path) != Some(comparable_path(runtime_root))
            || !backup
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(".previous-replaced-"))
        {
            return Err("Suwayomi update journal contains an unexpected backup path.".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn check_suwayomi_runtime_update(
    server_url: Option<String>,
    binary: Option<String>,
    profile_id: Option<String>,
    profile_label: Option<String>,
    app: AppHandle,
) -> SuwayomiUpdateCheckResult {
    let started = log_update_start("check");
    let runtime = get_suwayomi_runtime_status(server_url, binary, profile_id, profile_label, app);
    if let Some(blocked) = runtime_update_preflight_block(&runtime) {
        log_update_success("check", started);
        return blocked;
    }

    let manifest = match load_compatibility_manifest() {
        Ok(manifest) => manifest,
        Err(reason) => {
            log_update_failure("check", started, &reason);
            return failed_update_check(runtime.version, reason);
        }
    };

    if let Some(blocked) = manifest_preflight_block(&runtime, &manifest) {
        log_update_success("check", started);
        return blocked;
    }

    let releases = match fetch_suwayomi_releases().await {
        Ok(releases) => releases,
        Err(reason) => {
            log_update_failure("check", started, &reason);
            return failed_update_check(runtime.version, reason);
        }
    };

    let result = calculate_update_check(&runtime, &manifest, &releases);
    log_update_success("check", started);
    result
}

fn load_compatibility_manifest() -> Result<SuwayomiCompatibilityManifest, String> {
    let manifest =
        serde_json::from_str::<SuwayomiCompatibilityManifest>(SUWAYOMI_COMPATIBILITY_MANIFEST)
            .map_err(|err| format!("Could not parse Suwayomi compatibility manifest: {err}"))?;
    validate_compatibility_manifest(manifest)
}

fn validate_compatibility_manifest(
    manifest: SuwayomiCompatibilityManifest,
) -> Result<SuwayomiCompatibilityManifest, String> {
    if manifest.schema_version != 3 {
        return Err(format!(
            "Unsupported Suwayomi compatibility manifest schema {}.",
            manifest.schema_version
        ));
    }
    if manifest.repository != "Suwayomi/Suwayomi-Server" {
        return Err(
            "Suwayomi compatibility manifest points to an unexpected repository.".to_string(),
        );
    }
    if manifest.checksum_asset.trim().is_empty() {
        return Err("Suwayomi compatibility manifest is missing checksum asset.".to_string());
    }
    if manifest.allowed_versions.is_empty() {
        return Err("Suwayomi compatibility manifest has no allowed versions.".to_string());
    }
    if compare_versions(
        &manifest.min_supported_version,
        &manifest.max_tested_version,
    )
    .map_or(true, |ordering| ordering == std::cmp::Ordering::Greater)
    {
        return Err(
            "Suwayomi compatibility manifest has an invalid tested version range.".to_string(),
        );
    }
    for allowed in &manifest.allowed_versions {
        if allowed.version.trim().is_empty()
            || allowed.asset.trim().is_empty()
            || !is_sha256(&allowed.sha256)
        {
            return Err(
                "Suwayomi compatibility manifest contains an incomplete allowed version or invalid certified SHA-256."
                    .to_string(),
            );
        }
        if compare_versions(&allowed.version, &manifest.min_supported_version)
            .map_or(true, |ordering| ordering == std::cmp::Ordering::Less)
            || compare_versions(&allowed.version, &manifest.max_tested_version)
                .map_or(true, |ordering| ordering == std::cmp::Ordering::Greater)
        {
            return Err(format!(
                "Allowed Suwayomi version {} is outside Epigraph's tested range.",
                allowed.version
            ));
        }
        if allowed.transactional_extension_updates
            && allowed.compatibility_profile != SuwayomiCompatibilityProfile::V23
        {
            return Err(format!(
                "Allowed Suwayomi version {} enables transactional extension updates with an incompatible profile.",
                allowed.version
            ));
        }
    }
    Ok(manifest)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn suwayomi_update_lock() -> &'static Mutex<Option<ActiveSuwayomiUpdateLock>> {
    SUWAYOMI_UPDATE_LOCK.get_or_init(|| Mutex::new(None))
}

fn try_acquire_suwayomi_update_lock(owner: &str) -> Result<SuwayomiUpdateLockGuard, String> {
    let mut lock = suwayomi_update_lock()
        .lock()
        .map_err(|_| "Suwayomi update lock is poisoned.".to_string())?;
    if lock.is_some() {
        return Err("A Suwayomi update is already in progress.".to_string());
    }
    let token = Uuid::new_v4().to_string();
    *lock = Some(ActiveSuwayomiUpdateLock {
        token: token.clone(),
        owner: owner.trim().to_string(),
        started_at_ms: unix_now_ms(),
    });
    Ok(SuwayomiUpdateLockGuard {
        token,
        maintenance: None,
    })
}

impl SuwayomiUpdateLockGuard {
    fn begin_maintenance(&mut self, owner: &str, phase: MaintenancePhase) -> Result<(), String> {
        if self.maintenance.is_some() {
            return Ok(());
        }
        self.maintenance = Some(suwayomi_maintenance::begin_exclusive_maintenance(
            &managed_runtime_root(),
            owner,
            phase,
        )?);
        Ok(())
    }
}

fn release_suwayomi_update_lock(token: &str) -> bool {
    let Ok(mut lock) = suwayomi_update_lock().lock() else {
        return false;
    };
    if lock.as_ref().is_some_and(|active| active.token == token) {
        *lock = None;
        true
    } else {
        false
    }
}

fn current_suwayomi_update_lock_status() -> SuwayomiUpdateLockStatus {
    let active = suwayomi_update_lock()
        .lock()
        .ok()
        .and_then(|lock| lock.clone());
    SuwayomiUpdateLockStatus {
        in_progress: active.is_some(),
        owner: active.as_ref().map(|active| active.owner.clone()),
        started_at_ms: active.as_ref().map(|active| active.started_at_ms),
    }
}

fn unix_now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

impl Drop for SuwayomiUpdateLockGuard {
    fn drop(&mut self) {
        let _ = release_suwayomi_update_lock(&self.token);
    }
}

fn resolve_update_target(
    server_url: Option<String>,
    profile_id: Option<String>,
    profile_label: Option<String>,
    app: &AppHandle,
) -> Result<LocalServerTarget, String> {
    let normalized_server_url = normalize_server_url(server_url.as_deref());
    let launch_target = app.state::<LaunchTarget>().0.clone();
    resolve_local_server_target(
        &launch_target,
        Some(normalized_server_url.as_str()),
        profile_id.as_deref(),
        profile_label.as_deref(),
    )
    .map_err(|error| format!("Could not resolve managed Suwayomi runtime: {error:?}"))
}

fn stop_managed_runtime_for_snapshot(
    app: &AppHandle,
    target: &LocalServerTarget,
) -> Result<bool, String> {
    let java_pid = prove_epigraph_runtime_ownership(target)?;
    stop_runtime_for_maintenance(app, target)?;
    wait_for_managed_runtime_stop(&target.root_dir, java_pid)?;
    assert_local_port_released(target.port)?;
    Ok(true)
}

fn wait_for_managed_runtime_stop(root_dir: &Path, java_pid: u32) -> Result<(), String> {
    for _ in 0..50 {
        if !process_is_alive(java_pid) && find_java_pid_for_rootdir(root_dir).is_none() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("Managed Suwayomi did not release its database before snapshot.".to_string())
}

fn assert_profile_database_unlocked(root_dir: &Path) -> Result<(), String> {
    for name in ["database.mv.db", "database.trace.db"] {
        let path = root_dir.join(name);
        if !path.exists() {
            continue;
        }
        assert_file_exclusively_openable(&path).map_err(|error| {
            format!("Suwayomi database file {name} is still locked after shutdown: {error}")
        })?;
    }
    Ok(())
}

fn assert_local_port_released(port: u16) -> Result<(), String> {
    TcpListener::bind(("127.0.0.1", port))
        .map(|_| ())
        .map_err(|error| {
            format!("Managed Suwayomi port {port} is still occupied after shutdown: {error}")
        })
}

#[cfg(windows)]
fn assert_file_exclusively_openable(path: &Path) -> std::io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(path)
        .map(|_| ())
}

#[cfg(not(windows))]
fn assert_file_exclusively_openable(path: &Path) -> std::io::Result<()> {
    use fs2::FileExt;

    let file = OpenOptions::new().read(true).open(path)?;
    file.try_lock_exclusive()?;
    FileExt::unlock(&file)
}

fn restart_managed_runtime(app: &AppHandle, target: &LocalServerTarget) -> Result<(), String> {
    spawn_managed_server_for_update(
        target.server_url.clone(),
        Some(target.profile_key.clone()),
        app.clone(),
    )
    .map_err(|error| format!("{error:?}"))
}

fn restart_runtime_after_snapshot_failure<F>(
    stopped_runtime: bool,
    restart: F,
) -> Result<bool, String>
where
    F: FnOnce() -> Result<(), String>,
{
    if !stopped_runtime {
        return Ok(false);
    }
    restart()?;
    Ok(true)
}

#[cfg(test)]
fn create_snapshot_for_root(root_dir: &Path) -> Result<SuwayomiUpdateSnapshotResult, String> {
    let plan = plan_snapshot_files(root_dir)?;
    ensure_snapshot_disk_space(root_dir, &plan)?;
    create_snapshot_for_plan(root_dir, plan, None, SuwayomiRuntimeMode::Unknown, None)
}

fn create_snapshot_for_plan(
    root_dir: &Path,
    plan: Vec<SnapshotPlanFile>,
    profile_id: Option<String>,
    runtime_mode: SuwayomiRuntimeMode,
    suwayomi_version: Option<String>,
) -> Result<SuwayomiUpdateSnapshotResult, String> {
    if !root_dir.is_dir() {
        return Err("Suwayomi root directory does not exist.".to_string());
    }
    let snapshots_dir = root_dir.join(SUWAYOMI_SNAPSHOT_DIR);
    fs::create_dir_all(&snapshots_dir)
        .map_err(|error| format!("Could not create snapshot directory: {error}"))?;

    let snapshot_id = format!("snapshot-{}-{}", unix_now_ms(), Uuid::new_v4());
    let temp_dir = snapshots_dir.join(format!(".tmp-{snapshot_id}"));
    let final_dir = snapshots_dir.join(snapshot_id);
    fs::create_dir(&temp_dir)
        .map_err(|error| format!("Could not create temporary snapshot: {error}"))?;

    let result = (|| {
        let files = copy_snapshot_plan(&plan, &temp_dir)?;
        let manifest = SuwayomiSnapshotManifest {
            schema_version: 2,
            snapshot_version: SUWAYOMI_SNAPSHOT_VERSION.to_string(),
            created_at: unix_now_ms(),
            profile_id,
            runtime_mode,
            suwayomi_version,
            source_root: path_to_string(root_dir),
            files: files.clone(),
            rollback_ready: true,
        };
        let manifest_path = temp_dir.join(SUWAYOMI_SNAPSHOT_MANIFEST);
        write_snapshot_manifest(&manifest_path, &manifest)?;
        validate_snapshot_files(&temp_dir, &files)?;
        finalize_snapshot_directory(&temp_dir, &final_dir)?;
        let final_manifest = final_dir.join(SUWAYOMI_SNAPSHOT_MANIFEST);
        if !final_manifest.is_file() {
            let _ = fs::remove_dir_all(&final_dir);
            return Err("Finalized snapshot is missing its manifest.".to_string());
        }
        Ok(SuwayomiUpdateSnapshotResult {
            snapshot_path: path_to_string(&final_dir),
            manifest_path: path_to_string(&final_manifest),
            copied_files: files.iter().map(|file| file.name.clone()).collect(),
            stopped_runtime: false,
            restarted_runtime: false,
        })
    })();

    if result.is_err() && temp_dir.exists() {
        if let Err(cleanup_error) = fs::remove_dir_all(&temp_dir) {
            return Err(format!(
                "{} Temporary snapshot cleanup also failed: {cleanup_error}",
                result.unwrap_err()
            ));
        }
    }
    result
}

fn plan_snapshot_files(root_dir: &Path) -> Result<Vec<SnapshotPlanFile>, String> {
    if !root_dir.is_dir() {
        return Err("Suwayomi root directory does not exist.".to_string());
    }
    let mut files = Vec::new();
    for name in SUWAYOMI_SNAPSHOT_ALLOWLIST {
        let source = root_dir.join(name);
        if !source.exists() {
            continue;
        }
        if !source.is_file() {
            return Err(format!("Snapshot allowlist entry is not a file: {name}"));
        }
        let size_bytes = fs::metadata(&source)
            .map_err(|error| format!("Could not read metadata for {name}: {error}"))?
            .len();
        files.push(SnapshotPlanFile {
            name: (*name).to_string(),
            source_path: source,
            size_bytes,
        });
    }
    for directory in SUWAYOMI_SNAPSHOT_DIRECTORY_ALLOWLIST {
        let source_root = root_dir.join(directory);
        if !source_root.exists() {
            continue;
        }
        if !source_root.is_dir() {
            return Err(format!(
                "Snapshot allowlist entry is not a directory: {directory}"
            ));
        }
        for entry in WalkDir::new(&source_root).follow_links(false) {
            let entry = entry.map_err(|error| {
                format!("Could not inspect snapshot directory {directory}: {error}")
            })?;
            if entry.file_type().is_symlink() {
                return Err(format!(
                    "Snapshot directory {directory} contains an unsupported symbolic link."
                ));
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry.path().strip_prefix(root_dir).map_err(|_| {
                format!(
                    "Snapshot file escaped the Suwayomi profile: {}",
                    entry.path().display()
                )
            })?;
            let name = relative_path_string(relative)?;
            let size_bytes = entry
                .metadata()
                .map_err(|error| format!("Could not read metadata for {name}: {error}"))?
                .len();
            files.push(SnapshotPlanFile {
                name,
                source_path: entry.path().to_path_buf(),
                size_bytes,
            });
        }
    }
    files.sort_by(|left, right| left.name.cmp(&right.name));
    if files.is_empty() {
        return Err("No allowlisted Suwayomi files were available for snapshot.".to_string());
    }
    Ok(files)
}

fn ensure_snapshot_disk_space(root_dir: &Path, files: &[SnapshotPlanFile]) -> Result<(), String> {
    let required = files
        .iter()
        .try_fold(SUWAYOMI_SNAPSHOT_SPACE_MARGIN_BYTES, |total, file| {
            total.checked_add(file.size_bytes)
        })
        .ok_or_else(|| "Snapshot size estimate overflowed.".to_string())?;
    ensure_required_space(root_dir, required, available_space_for_path(root_dir))
}

fn ensure_required_space(
    root_dir: &Path,
    required_bytes: u64,
    available_bytes: Option<u64>,
) -> Result<(), String> {
    let Some(available) = available_bytes else {
        return Ok(());
    };
    if available < required_bytes {
        return Err(format!(
            "Not enough disk space to create Suwayomi snapshot at {}. Required at least {} bytes, available {} bytes.",
            path_to_string(root_dir),
            required_bytes,
            available
        ));
    }
    Ok(())
}

fn available_space_for_path(path: &Path) -> Option<u64> {
    let target = existing_ancestor(path)?;
    let disks = Disks::new_with_refreshed_list();
    disks
        .iter()
        .filter(|disk| target.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.available_space())
}

fn existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = path;
    loop {
        if current.exists() {
            return Some(current.to_path_buf());
        }
        current = current.parent()?;
    }
}

fn copy_snapshot_plan(
    plan: &[SnapshotPlanFile],
    temp_dir: &Path,
) -> Result<Vec<SuwayomiSnapshotFile>, String> {
    let mut files = Vec::new();
    for planned in plan {
        let target = temp_dir.join(&planned.name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Could not create snapshot parent for {}: {error}",
                    planned.name
                )
            })?;
        }
        match fs::copy(&planned.source_path, &target) {
            Ok(_) => {}
            Err(error)
                if planned.name == SUWAYOMI_SERVER_OWNER_FILE
                    && error.kind() == ErrorKind::NotFound =>
            {
                continue;
            }
            Err(error) => return Err(format!("Could not copy {}: {error}", planned.name)),
        }
        let metadata = fs::metadata(&target).map_err(|error| {
            format!(
                "Could not read copied metadata for {}: {error}",
                planned.name
            )
        })?;
        let sha256 = sha256_file(&target)?;
        files.push(SuwayomiSnapshotFile {
            name: planned.name.clone(),
            size_bytes: metadata.len(),
            sha256,
        });
    }
    if files.is_empty() {
        return Err("No allowlisted Suwayomi files were available for snapshot.".to_string());
    }
    Ok(files)
}

fn write_snapshot_manifest(
    manifest_path: &Path,
    manifest: &SuwayomiSnapshotManifest,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("Could not serialize snapshot manifest: {error}"))?;
    let mut file = File::create(manifest_path)
        .map_err(|error| format!("Could not create snapshot manifest: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("Could not write snapshot manifest: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not sync snapshot manifest: {error}"))
}

fn validate_snapshot_files(
    snapshot_dir: &Path,
    files: &[SuwayomiSnapshotFile],
) -> Result<(), String> {
    for file in files {
        validate_snapshot_relative_path(&file.name)?;
        let path = snapshot_dir.join(&file.name);
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Could not validate snapshot file {}: {error}", file.name))?;
        if !metadata.is_file() || metadata.len() != file.size_bytes {
            return Err(format!(
                "Snapshot file {} did not validate after copy.",
                file.name
            ));
        }
        let actual_sha256 = sha256_file(&path)?;
        if !actual_sha256.eq_ignore_ascii_case(&file.sha256) {
            return Err(format!(
                "Snapshot file {} failed SHA-256 validation.",
                file.name
            ));
        }
    }
    Ok(())
}

fn finalize_snapshot_directory(temp_dir: &Path, final_dir: &Path) -> Result<(), String> {
    if temp_dir.parent() != final_dir.parent() {
        return Err(
            "Atomic finalize requires temporary and final directories to share a parent."
                .to_string(),
        );
    }
    if final_dir.exists() {
        return Err("Final snapshot directory already exists.".to_string());
    }
    fs::rename(temp_dir, final_dir)
        .map_err(|error| format!("Could not finalize snapshot atomically: {error}"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| {
        format!(
            "Could not open {} for SHA-256: {error}",
            path_to_string(path)
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash {}: {error}", path_to_string(path)))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

#[cfg(test)]
fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_lower(&hasher.finalize())
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

async fn fetch_suwayomi_releases() -> Result<Vec<GithubRelease>, String> {
    let now = Instant::now();
    if let Some(releases) = cached_suwayomi_releases(now) {
        return Ok(releases);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|err| format!("Could not create GitHub client: {err}"))?;
    let response = client
        .get(SUWAYOMI_RELEASES_API_URL)
        .header(reqwest::header::USER_AGENT, SUWAYOMI_RELEASES_USER_AGENT)
        .send()
        .await
        .map_err(|err| format!("Could not check Suwayomi releases: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub release check returned HTTP {}.",
            response.status()
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|err| format!("Could not read Suwayomi releases: {err}"))?;
    let releases = parse_github_releases(&body)?;
    store_cached_suwayomi_releases(now, releases.clone());
    Ok(releases)
}

fn parse_github_releases(body: &str) -> Result<Vec<GithubRelease>, String> {
    serde_json::from_str::<Vec<GithubRelease>>(body)
        .map_err(|err| format!("Could not parse Suwayomi releases: {err}"))
}

fn suwayomi_releases_cache() -> &'static Mutex<Option<CachedGithubReleases>> {
    SUWAYOMI_RELEASES_CACHE.get_or_init(|| Mutex::new(None))
}

fn cached_suwayomi_releases(now: Instant) -> Option<Vec<GithubRelease>> {
    let guard = suwayomi_releases_cache().lock().ok()?;
    let cached = guard.as_ref()?;
    if now.duration_since(cached.fetched_at) <= SUWAYOMI_RELEASES_CACHE_TTL {
        Some(cached.releases.clone())
    } else {
        None
    }
}

fn store_cached_suwayomi_releases(now: Instant, releases: Vec<GithubRelease>) {
    if let Ok(mut guard) = suwayomi_releases_cache().lock() {
        *guard = Some(CachedGithubReleases {
            fetched_at: now,
            releases,
        });
    }
}

fn runtime_update_preflight_block(
    runtime: &SuwayomiRuntimeStatus,
) -> Option<SuwayomiUpdateCheckResult> {
    if runtime.update_allowed {
        return None;
    }
    Some(blocked_update_check(
        runtime.version.clone(),
        runtime
            .block_reason
            .clone()
            .unwrap_or_else(|| "This Suwayomi runtime is not managed by Epigraph.".to_string()),
    ))
}

fn manifest_preflight_block(
    runtime: &SuwayomiRuntimeStatus,
    manifest: &SuwayomiCompatibilityManifest,
) -> Option<SuwayomiUpdateCheckResult> {
    let Some(current) = runtime.version.as_deref() else {
        return Some(blocked_update_check(
            None,
            "Current Suwayomi version could not be detected.".to_string(),
        ));
    };
    if let Some(blocked) = manifest.blocked_reason(current) {
        return Some(blocked_update_check(
            runtime.version.clone(),
            format!("Current Suwayomi version is blocked by Epigraph: {blocked}"),
        ));
    }
    if compare_versions(current, &manifest.min_supported_version)
        .is_some_and(|ordering| ordering == std::cmp::Ordering::Less)
    {
        return Some(blocked_update_check(
            runtime.version.clone(),
            format!(
                "Current Suwayomi version is below Epigraph's minimum supported version {}.",
                manifest.min_supported_version
            ),
        ));
    }
    if compare_versions(current, &manifest.max_tested_version)
        .is_some_and(|ordering| ordering == std::cmp::Ordering::Greater)
    {
        return Some(blocked_update_check(
            runtime.version.clone(),
            format!(
                "Current Suwayomi version is newer than Epigraph's maximum tested version {}.",
                manifest.max_tested_version
            ),
        ));
    }
    None
}

fn calculate_update_check(
    runtime: &SuwayomiRuntimeStatus,
    manifest: &SuwayomiCompatibilityManifest,
    releases: &[GithubRelease],
) -> SuwayomiUpdateCheckResult {
    let Some(current_version) = runtime.version.clone() else {
        return blocked_update_check(
            None,
            "Current Suwayomi version could not be detected.".to_string(),
        );
    };

    let Some(latest) = latest_compatible_release(manifest, releases) else {
        return blocked_update_check(
            Some(current_version),
            "No compatible Suwayomi release from Epigraph's allowlist was found.".to_string(),
        );
    };

    match compare_versions(&latest.allowed.version, &current_version) {
        Some(std::cmp::Ordering::Greater) => SuwayomiUpdateCheckResult {
            status: UpdateCheckStatus::UpdateAvailable,
            current_version: Some(current_version),
            latest_compatible_version: Some(latest.allowed.version.clone()),
            release_tag: Some(latest.release.tag_name.clone()),
            release_url: Some(latest.release.html_url.clone()),
            update_allowed: true,
            block_reason: None,
            notes: latest.allowed.notes.clone(),
            release_notes: latest.release.body.as_ref().and_then(non_empty_string),
        },
        Some(_) => SuwayomiUpdateCheckResult {
            status: UpdateCheckStatus::UpToDate,
            current_version: Some(current_version),
            latest_compatible_version: Some(latest.allowed.version.clone()),
            release_tag: Some(latest.release.tag_name.clone()),
            release_url: Some(latest.release.html_url.clone()),
            update_allowed: false,
            block_reason: None,
            notes: latest.allowed.notes.clone(),
            release_notes: latest.release.body.as_ref().and_then(non_empty_string),
        },
        None => blocked_update_check(
            Some(current_version),
            "Could not compare Suwayomi versions safely.".to_string(),
        ),
    }
}

#[derive(Clone, Debug)]
struct CompatibleRelease<'a> {
    allowed: &'a SuwayomiAllowedVersion,
    release: &'a GithubRelease,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StagingCandidate {
    version: String,
    asset_name: String,
    checksum_asset: String,
    release_tag: String,
    release_url: String,
    jar_url: String,
    checksum_url: String,
}

fn latest_compatible_release<'a>(
    manifest: &'a SuwayomiCompatibilityManifest,
    releases: &'a [GithubRelease],
) -> Option<CompatibleRelease<'a>> {
    releases
        .iter()
        .filter_map(|release| compatible_release(manifest, release))
        .max_by(|left, right| {
            compare_versions_for_sort(&left.allowed.version, &right.allowed.version)
        })
}

fn compatible_release<'a>(
    manifest: &'a SuwayomiCompatibilityManifest,
    release: &'a GithubRelease,
) -> Option<CompatibleRelease<'a>> {
    if release.draft || release.prerelease {
        return None;
    }
    if manifest.blocked_reason(&release.tag_name).is_some() {
        return None;
    }
    if !manifest.version_within_tested_range(&release.tag_name) {
        return None;
    }
    let allowed = manifest.allowed_version(&release.tag_name)?;
    if !release_has_asset(release, &allowed.asset) {
        return None;
    }
    if !release_has_asset(release, &manifest.checksum_asset) {
        return None;
    }
    Some(CompatibleRelease { allowed, release })
}

fn release_has_asset(release: &GithubRelease, asset_name: &str) -> bool {
    release.assets.iter().any(|asset| asset.name == asset_name)
}

fn release_asset<'a>(
    release: &'a GithubRelease,
    asset_name: &str,
) -> Option<&'a GithubReleaseAsset> {
    release.assets.iter().find(|asset| asset.name == asset_name)
}

fn select_staging_candidate(
    runtime: &SuwayomiRuntimeStatus,
    manifest: &SuwayomiCompatibilityManifest,
    releases: &[GithubRelease],
    target_version: Option<&str>,
) -> Result<StagingCandidate, String> {
    let current = runtime
        .version
        .as_deref()
        .ok_or_else(|| "Current Suwayomi version could not be detected.".to_string())?;
    let compatible = if let Some(target) = target_version {
        releases
            .iter()
            .filter_map(|release| compatible_release(manifest, release))
            .find(|candidate| {
                normalize_version_tag(&candidate.allowed.version) == normalize_version_tag(target)
            })
    } else {
        latest_compatible_release(manifest, releases)
    }
    .ok_or_else(|| {
        "No compatible Suwayomi release from Epigraph's allowlist was found.".to_string()
    })?;

    match compare_versions(&compatible.allowed.version, current) {
        Some(std::cmp::Ordering::Greater) => {}
        Some(_) => {
            return Err("No newer compatible Suwayomi update is available.".to_string());
        }
        None => return Err("Could not compare Suwayomi versions safely.".to_string()),
    }

    let jar_asset = release_asset(compatible.release, &compatible.allowed.asset)
        .ok_or_else(|| "Compatible release is missing the expected JAR asset.".to_string())?;
    let checksum_asset = release_asset(compatible.release, &manifest.checksum_asset)
        .ok_or_else(|| "Compatible release is missing its checksum asset.".to_string())?;

    Ok(StagingCandidate {
        version: compatible.allowed.version.clone(),
        asset_name: compatible.allowed.asset.clone(),
        checksum_asset: manifest.checksum_asset.clone(),
        release_tag: compatible.release.tag_name.clone(),
        release_url: compatible.release.html_url.clone(),
        jar_url: jar_asset.browser_download_url.clone(),
        checksum_url: checksum_asset.browser_download_url.clone(),
    })
}

async fn download_release_text(url: &str) -> Result<String, String> {
    let bytes = download_release_bytes(url).await?;
    String::from_utf8(bytes).map_err(|error| format!("Downloaded checksum is not UTF-8: {error}"))
}

async fn download_release_bytes(url: &str) -> Result<Vec<u8>, String> {
    let parsed =
        Url::parse(url).map_err(|error| format!("Release asset URL is invalid: {error}"))?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
        return Err("Release asset URL is not an official GitHub HTTPS URL.".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|err| format!("Could not create GitHub download client: {err}"))?;
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, SUWAYOMI_RELEASES_USER_AGENT)
        .send()
        .await
        .map_err(|err| format!("Could not download Suwayomi release asset: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Suwayomi release asset download returned HTTP {}.",
            response.status()
        ));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|err| format!("Could not read Suwayomi release asset: {err}"))
}

fn checksum_for_asset(checksums: &str, asset_name: &str) -> Result<String, String> {
    for line in checksums.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let Some(hash) = parts.next() else {
            continue;
        };
        let Some(name) = parts.next() else {
            continue;
        };
        if name.trim_start_matches('*') == asset_name {
            if hash.len() == 64 && hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
                return Ok(hash.to_ascii_lowercase());
            }
            return Err(format!(
                "Checksum for {asset_name} is not a valid SHA-256 hash."
            ));
        }
    }
    Err(format!("Checksum file does not contain {asset_name}."))
}

fn certified_release_checksum(
    manifest: &SuwayomiCompatibilityManifest,
    version: &str,
    asset_name: &str,
    published_sha256: &str,
) -> Result<String, String> {
    let allowed = manifest
        .allowed_version(version)
        .ok_or_else(|| "Target Suwayomi version is not in Epigraph's allowlist.".to_string())?;
    if allowed.asset != asset_name {
        return Err("Target Suwayomi asset does not match Epigraph's allowlist.".to_string());
    }
    if !allowed.sha256.eq_ignore_ascii_case(published_sha256) {
        return Err(
            "Published Suwayomi checksum does not match Epigraph's certified SHA-256.".to_string(),
        );
    }
    Ok(allowed.sha256.to_ascii_lowercase())
}

fn managed_runtime_staging_root() -> PathBuf {
    managed_runtime_root().join(SUWAYOMI_STAGING_DIR)
}

fn managed_runtime_root() -> PathBuf {
    suwayomi_data_dir().join(SUWAYOMI_RUNTIME_DIR)
}

async fn stage_release_jar(
    staging_root: &Path,
    candidate: &StagingCandidate,
    manifest: &SuwayomiCompatibilityManifest,
    expected_sha256: &str,
    min_size_bytes: u64,
) -> Result<SuwayomiUpdateStageResult, String> {
    validate_staging_candidate(candidate, manifest)?;

    fs::create_dir_all(staging_root)
        .map_err(|error| format!("Could not create Suwayomi staging directory: {error}"))?;
    let version_dir = normalize_version_tag(&candidate.version);
    let temp_dir = staging_root.join(format!(".tmp-{version_dir}-{}", Uuid::new_v4()));
    let final_dir = staging_root.join(&version_dir);
    fs::create_dir(&temp_dir)
        .map_err(|error| format!("Could not create temporary staging directory: {error}"))?;

    let jar_path = temp_dir.join(SUWAYOMI_SERVER_JAR);
    let part_path = temp_dir.join(format!("{SUWAYOMI_SERVER_JAR}.part"));
    let result = async {
        let actual_sha256 = download_release_to_part(&candidate.jar_url, &part_path).await?;
        if actual_sha256 != expected_sha256.to_ascii_lowercase() {
            return Err("Downloaded Suwayomi JAR failed SHA-256 validation.".to_string());
        }
        fs::rename(&part_path, &jar_path)
            .map_err(|error| format!("Could not finalize staged JAR download: {error}"))?;
        finalize_staging_directory(
            &temp_dir,
            &final_dir,
            candidate,
            manifest,
            expected_sha256,
            min_size_bytes,
        )
    }
    .await;

    if result.is_err() && temp_dir.exists() {
        let original = result.unwrap_err();
        if let Err(cleanup_error) = fs::remove_dir_all(&temp_dir) {
            return Err(format!(
                "{original} Temporary staging cleanup also failed: {cleanup_error}"
            ));
        }
        return Err(original);
    }
    result
}

#[cfg(test)]
fn stage_downloaded_jar(
    staging_root: &Path,
    candidate: &StagingCandidate,
    manifest: &SuwayomiCompatibilityManifest,
    jar_bytes: &[u8],
    expected_sha256: &str,
    min_size_bytes: u64,
) -> Result<SuwayomiUpdateStageResult, String> {
    stage_downloaded_jar_from_reader(
        staging_root,
        candidate,
        manifest,
        std::io::Cursor::new(jar_bytes),
        expected_sha256,
        min_size_bytes,
    )
}

#[cfg(test)]
fn stage_downloaded_jar_from_reader<R: Read>(
    staging_root: &Path,
    candidate: &StagingCandidate,
    manifest: &SuwayomiCompatibilityManifest,
    reader: R,
    expected_sha256: &str,
    min_size_bytes: u64,
) -> Result<SuwayomiUpdateStageResult, String> {
    validate_staging_candidate(candidate, manifest)?;
    fs::create_dir_all(staging_root)
        .map_err(|error| format!("Could not create Suwayomi staging directory: {error}"))?;
    let version_dir = normalize_version_tag(&candidate.version);
    let temp_dir = staging_root.join(format!(".tmp-{version_dir}-{}", Uuid::new_v4()));
    let final_dir = staging_root.join(&version_dir);
    fs::create_dir(&temp_dir)
        .map_err(|error| format!("Could not create temporary staging directory: {error}"))?;

    let jar_path = temp_dir.join(SUWAYOMI_SERVER_JAR);
    let part_path = temp_dir.join(format!("{SUWAYOMI_SERVER_JAR}.part"));
    let result = (|| {
        let actual_sha256 = write_reader_to_part(reader, &part_path)?;
        if actual_sha256 != expected_sha256.to_ascii_lowercase() {
            return Err("Downloaded Suwayomi JAR failed SHA-256 validation.".to_string());
        }
        fs::rename(&part_path, &jar_path)
            .map_err(|error| format!("Could not finalize staged JAR download: {error}"))?;
        finalize_staging_directory(
            &temp_dir,
            &final_dir,
            candidate,
            manifest,
            expected_sha256,
            min_size_bytes,
        )
    })();

    if result.is_err() && temp_dir.exists() {
        let original = result.unwrap_err();
        if let Err(cleanup_error) = fs::remove_dir_all(&temp_dir) {
            return Err(format!(
                "{original} Temporary staging cleanup also failed: {cleanup_error}"
            ));
        }
        return Err(original);
    }
    result
}

async fn download_release_to_part(url: &str, part_path: &Path) -> Result<String, String> {
    let parsed =
        Url::parse(url).map_err(|error| format!("Release asset URL is invalid: {error}"))?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
        return Err("Release asset URL is not an official GitHub HTTPS URL.".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|err| format!("Could not create GitHub download client: {err}"))?;
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, SUWAYOMI_RELEASES_USER_AGENT)
        .send()
        .await
        .map_err(|err| format!("Could not download Suwayomi release asset: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Suwayomi release asset download returned HTTP {}.",
            response.status()
        ));
    }

    let mut file =
        File::create(part_path).map_err(|error| format!("Could not create JAR .part: {error}"))?;
    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Suwayomi JAR download interrupted: {error}"))?;
        file.write_all(&chunk)
            .map_err(|error| format!("Could not write JAR .part: {error}"))?;
        hasher.update(&chunk);
    }
    file.sync_all()
        .map_err(|error| format!("Could not sync JAR .part: {error}"))?;
    Ok(hex_lower(&hasher.finalize()))
}

#[cfg(test)]
fn write_reader_to_part<R: Read>(mut reader: R, part_path: &Path) -> Result<String, String> {
    let mut file =
        File::create(part_path).map_err(|error| format!("Could not create JAR .part: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Suwayomi JAR stream interrupted: {error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("Could not write JAR .part: {error}"))?;
        hasher.update(&buffer[..read]);
    }
    file.sync_all()
        .map_err(|error| format!("Could not sync JAR .part: {error}"))?;
    Ok(hex_lower(&hasher.finalize()))
}

fn finalize_staging_directory(
    temp_dir: &Path,
    final_dir: &Path,
    candidate: &StagingCandidate,
    manifest: &SuwayomiCompatibilityManifest,
    expected_sha256: &str,
    min_size_bytes: u64,
) -> Result<SuwayomiUpdateStageResult, String> {
    let jar_path = temp_dir.join(SUWAYOMI_SERVER_JAR);
    validate_staged_jar(
        &jar_path,
        expected_sha256,
        &candidate.version,
        manifest,
        min_size_bytes,
    )?;
    let staging_manifest = SuwayomiStagingManifest {
        schema_version: 1,
        created_at: unix_now_ms(),
        version: normalize_version_tag(&candidate.version),
        sha256: expected_sha256.to_ascii_lowercase(),
        asset_name: candidate.asset_name.clone(),
        checksum_asset: candidate.checksum_asset.clone(),
        release_tag: candidate.release_tag.clone(),
        release_url: candidate.release_url.clone(),
    };
    write_staging_manifest(&temp_dir.join(SUWAYOMI_STAGING_MANIFEST), &staging_manifest)?;
    finalize_snapshot_directory(temp_dir, final_dir)?;
    let final_jar = final_dir.join(SUWAYOMI_SERVER_JAR);
    if !final_jar.is_file() {
        let _ = fs::remove_dir_all(final_dir);
        return Err("Finalized staging directory is missing its JAR.".to_string());
    }
    Ok(SuwayomiUpdateStageResult {
        staging_path: path_to_string(final_dir),
        jar_path: path_to_string(&final_jar),
        version: staging_manifest.version,
        sha256: staging_manifest.sha256,
        asset_name: staging_manifest.asset_name,
        checksum_asset: staging_manifest.checksum_asset,
        release_tag: staging_manifest.release_tag,
        release_url: staging_manifest.release_url,
    })
}

fn write_staging_manifest(
    manifest_path: &Path,
    manifest: &SuwayomiStagingManifest,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("Could not serialize staging manifest: {error}"))?;
    let mut file = File::create(manifest_path)
        .map_err(|error| format!("Could not create staging manifest: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("Could not write staging manifest: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not sync staging manifest: {error}"))
}

fn validate_staging_candidate(
    candidate: &StagingCandidate,
    manifest: &SuwayomiCompatibilityManifest,
) -> Result<(), String> {
    let allowed = manifest
        .allowed_version(&candidate.version)
        .ok_or_else(|| "Target Suwayomi version is not in Epigraph's allowlist.".to_string())?;
    if manifest.blocked_reason(&candidate.version).is_some() {
        return Err("Target Suwayomi version is blocked by Epigraph.".to_string());
    }
    if !manifest.version_within_tested_range(&candidate.version) {
        return Err("Target Suwayomi version is outside Epigraph's tested range.".to_string());
    }
    if allowed.asset != candidate.asset_name {
        return Err("Target Suwayomi asset does not match Epigraph's allowlist.".to_string());
    }
    Ok(())
}

fn validate_staged_jar(
    jar_path: &Path,
    expected_sha256: &str,
    expected_version: &str,
    manifest: &SuwayomiCompatibilityManifest,
    min_size_bytes: u64,
) -> Result<(), String> {
    validate_staging_candidate(
        &StagingCandidate {
            version: expected_version.to_string(),
            asset_name: manifest
                .allowed_version(expected_version)
                .map(|allowed| allowed.asset.clone())
                .unwrap_or_default(),
            checksum_asset: manifest.checksum_asset.clone(),
            release_tag: expected_version.to_string(),
            release_url: String::new(),
            jar_url: String::new(),
            checksum_url: String::new(),
        },
        manifest,
    )?;
    let metadata = fs::metadata(jar_path)
        .map_err(|error| format!("Could not read staged JAR metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("Staged Suwayomi JAR is not a file.".to_string());
    }
    if metadata.len() < min_size_bytes {
        return Err("Staged Suwayomi JAR is smaller than expected.".to_string());
    }
    if sha256_file(jar_path)? != expected_sha256.to_ascii_lowercase() {
        return Err("Staged Suwayomi JAR hash changed after write.".to_string());
    }
    let mut archive = zip::ZipArchive::new(
        File::open(jar_path).map_err(|error| format!("Could not open staged JAR: {error}"))?,
    )
    .map_err(|error| format!("Staged Suwayomi JAR is not readable: {error}"))?;
    archive
        .by_name("META-INF/MANIFEST.MF")
        .map_err(|error| format!("Staged Suwayomi JAR is missing its manifest: {error}"))?;
    drop(archive);
    let version = read_suwayomi_jar_version(jar_path)
        .and_then(|jar_version| jar_version.version)
        .ok_or_else(|| "Could not detect staged Suwayomi JAR version.".to_string())?;
    if normalize_version_tag(&version) != normalize_version_tag(expected_version) {
        return Err(format!(
            "Staged Suwayomi JAR version {version} does not match expected {expected_version}."
        ));
    }
    Ok(())
}

fn validate_staging_dir(
    staging_dir: &Path,
    manifest: &SuwayomiCompatibilityManifest,
) -> Result<SuwayomiStagingManifest, String> {
    if !staging_dir.is_dir() {
        return Err("Requested Suwayomi staging directory does not exist.".to_string());
    }
    let staging_manifest_path = staging_dir.join(SUWAYOMI_STAGING_MANIFEST);
    let staging_manifest = read_staging_manifest(&staging_manifest_path)?;
    if staging_manifest.schema_version != 1 {
        return Err("Staging manifest has an unsupported schema.".to_string());
    }
    validate_staging_candidate(
        &StagingCandidate {
            version: staging_manifest.version.clone(),
            asset_name: staging_manifest.asset_name.clone(),
            checksum_asset: staging_manifest.checksum_asset.clone(),
            release_tag: staging_manifest.release_tag.clone(),
            release_url: staging_manifest.release_url.clone(),
            jar_url: String::new(),
            checksum_url: String::new(),
        },
        manifest,
    )?;
    let certified_sha256 = manifest
        .allowed_version(&staging_manifest.version)
        .map(|allowed| allowed.sha256.as_str())
        .ok_or_else(|| "Staged Suwayomi version is not in Epigraph's allowlist.".to_string())?;
    if !staging_manifest
        .sha256
        .eq_ignore_ascii_case(certified_sha256)
    {
        return Err("Staged Suwayomi JAR does not match Epigraph's certified SHA-256.".to_string());
    }
    validate_staged_jar(
        &staging_dir.join(SUWAYOMI_SERVER_JAR),
        &staging_manifest.sha256,
        &staging_manifest.version,
        manifest,
        MIN_STAGED_JAR_BYTES,
    )?;
    Ok(staging_manifest)
}

fn read_staging_manifest(path: &Path) -> Result<SuwayomiStagingManifest, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("Could not read staging manifest: {error}"))?;
    serde_json::from_str(&text)
        .map_err(|error| format!("Could not parse staging manifest: {error}"))
}

#[derive(Clone, Debug)]
struct RuntimePromotionState {
    current_dir: PathBuf,
    previous_dir: Option<PathBuf>,
    previous_backup_dir: Option<PathBuf>,
    staging_dir: PathBuf,
    had_current: bool,
}

#[cfg(test)]
fn promote_staging_directories(
    runtime_root: &Path,
    version: &str,
) -> Result<RuntimePromotionState, String> {
    let promotion = plan_runtime_promotion(runtime_root, version, &Uuid::new_v4().to_string())?;
    apply_runtime_promotion(&promotion)?;
    Ok(promotion)
}

fn plan_runtime_promotion(
    runtime_root: &Path,
    version: &str,
    operation_id: &str,
) -> Result<RuntimePromotionState, String> {
    let current_dir = runtime_root.join(SUWAYOMI_CURRENT_DIR);
    let previous_dir = runtime_root.join(SUWAYOMI_PREVIOUS_DIR);
    let staging_dir = runtime_root
        .join(SUWAYOMI_STAGING_DIR)
        .join(normalize_version_tag(version));
    if !staging_dir.is_dir() {
        return Err("Validated staging directory disappeared before promotion.".to_string());
    }
    if current_dir.exists() && !current_dir.is_dir() {
        return Err("Current Suwayomi runtime path is not a directory.".to_string());
    }
    if previous_dir.exists() && !previous_dir.is_dir() {
        return Err("Previous Suwayomi runtime path is not a directory.".to_string());
    }

    let had_current = current_dir.exists();
    let previous_backup_dir = if had_current && previous_dir.exists() {
        Some(runtime_root.join(format!(".previous-replaced-{operation_id}")))
    } else {
        None
    };

    Ok(RuntimePromotionState {
        current_dir,
        previous_dir: had_current.then_some(previous_dir),
        previous_backup_dir,
        staging_dir,
        had_current,
    })
}

fn apply_runtime_promotion(promotion: &RuntimePromotionState) -> Result<(), String> {
    let runtime_root = promotion
        .current_dir
        .parent()
        .ok_or_else(|| "Suwayomi runtime directory has no parent.".to_string())?;
    fs::create_dir_all(runtime_root)
        .map_err(|error| format!("Could not create Suwayomi runtime directory: {error}"))?;
    let previous_dir = runtime_root.join(SUWAYOMI_PREVIOUS_DIR);
    if let Some(backup) = &promotion.previous_backup_dir {
        rename_same_parent(&previous_dir, backup)?;
    }

    if promotion.had_current {
        if let Err(error) = rename_same_parent(&promotion.current_dir, &previous_dir) {
            restore_previous_backup(&previous_dir, promotion.previous_backup_dir.as_ref());
            return Err(error);
        }
    }

    if let Err(error) = rename_same_parent(&promotion.staging_dir, &promotion.current_dir) {
        let _ = rollback_promoted_directories(promotion);
        return Err(error);
    }
    Ok(())
}

fn rename_same_parent(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        return Err(format!(
            "Cannot promote Suwayomi runtime because {} already exists.",
            path_to_string(to)
        ));
    }
    fs::rename(from, to).map_err(|error| {
        format!(
            "Could not atomically move {} to {}: {error}",
            path_to_string(from),
            path_to_string(to)
        )
    })
}

async fn rollback_promoted_runtime(
    app: &AppHandle,
    target: &LocalServerTarget,
    promotion: &RuntimePromotionState,
    snapshot_dir: &Path,
    auth_header: Option<&str>,
) -> Result<(), String> {
    stop_runtime_for_maintenance(app, target)?;
    wait_for_managed_runtime_stop(&target.root_dir, 0)?;
    assert_local_port_released(target.port)?;
    assert_profile_database_unlocked(&target.root_dir)?;
    rollback_promoted_directories(promotion)?;
    restore_snapshot_to_root(snapshot_dir, &target.root_dir)?;
    restart_managed_runtime(app, target)?;
    let expected_jar = if promotion.had_current {
        promotion.current_dir.join(SUWAYOMI_SERVER_JAR)
    } else {
        bundled_jar_path(app)
    };
    wait_for_runtime_jar(target, &expected_jar, runtime_stability_window())?;
    let restored_version = read_suwayomi_jar_version(&expected_jar)
        .and_then(|version| version.version)
        .unwrap_or_else(|| "restored".to_string());
    run_suwayomi_graphql_health_check(&target.server_url, auth_header, &restored_version).await
}

fn rollback_promoted_directories(promotion: &RuntimePromotionState) -> Result<(), String> {
    if promotion.current_dir.exists() {
        fs::remove_dir_all(&promotion.current_dir)
            .map_err(|error| format!("Could not remove failed current runtime: {error}"))?;
    }
    if promotion.had_current {
        let previous_dir = promotion
            .previous_dir
            .as_ref()
            .ok_or_else(|| "Rollback is missing previous runtime path.".to_string())?;
        if previous_dir.exists() {
            rename_same_parent(previous_dir, &promotion.current_dir)?;
        } else {
            return Err("Previous Suwayomi runtime is missing during rollback.".to_string());
        }
    }
    restore_previous_backup(
        promotion
            .previous_dir
            .as_ref()
            .unwrap_or(&promotion.current_dir),
        promotion.previous_backup_dir.as_ref(),
    );
    Ok(())
}

fn restore_previous_backup(previous_dir: &Path, backup: Option<&PathBuf>) {
    let Some(backup) = backup else {
        return;
    };
    if backup.exists() && !previous_dir.exists() {
        let _ = fs::rename(backup, previous_dir);
    }
}

fn cleanup_previous_backup(promotion: &RuntimePromotionState) -> Result<(), String> {
    if let Some(backup) = &promotion.previous_backup_dir {
        if backup.exists() {
            fs::remove_dir_all(backup)
                .map_err(|error| format!("Could not clean old previous runtime backup: {error}"))?;
        }
    }
    Ok(())
}

fn runtime_stability_window() -> Duration {
    Duration::from_millis(PROMOTED_RUNTIME_MIN_ALIVE_MS)
}

fn wait_for_runtime_jar(
    target: &LocalServerTarget,
    expected_jar: &Path,
    min_alive: Duration,
) -> Result<(), String> {
    let java_pid = prove_epigraph_runtime_ownership(target)?;
    if !java_pid_uses_jar(java_pid, expected_jar) {
        return Err("Suwayomi process is not using the expected managed JAR.".to_string());
    }
    thread::sleep(min_alive);
    if !process_is_alive(java_pid) {
        return Err("Suwayomi process exited during the stability window.".to_string());
    }
    Ok(())
}

fn allocate_extension_candidate_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| format!("Could not allocate extension candidate port: {error}"))
}

fn validate_extension_batch_item(item: &ExtensionUpdateBatchItem) -> Result<Url, String> {
    if item.package_name.trim().is_empty()
        || item.version_code.trim().is_empty()
        || item.version_name.trim().is_empty()
    {
        return Err("Extension update metadata is incomplete.".to_string());
    }
    if item.artifact_type != "apk" && item.artifact_type != "jar" {
        return Err("Extension artifact type must be apk or jar.".to_string());
    }
    if item.store_id.trim().is_empty() || item.store_id == "manual" {
        return Err("Automatic extension updates require known store provenance.".to_string());
    }
    let store_url = Url::parse(&item.store_url_canonical)
        .map_err(|_| "Extension store provenance URL is invalid.".to_string())?;
    if store_url.scheme() != "https" || store_url.username() != "" || store_url.password().is_some()
    {
        return Err("Extension store provenance must be credential-free HTTPS.".to_string());
    }
    let url = Url::parse(&item.artifact_url)
        .map_err(|error| format!("Extension artifact URL is invalid: {error}"))?;
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return Err("Extension artifact URL must be credential-free HTTPS.".to_string());
    }
    let suffix = format!(".{}", item.artifact_type);
    if !url.path().to_ascii_lowercase().ends_with(&suffix) {
        return Err(format!("Extension artifact URL must end with {suffix}."));
    }
    Ok(url)
}

async fn stage_extension_artifact(
    client: &reqwest::Client,
    root: &Path,
    item: ExtensionUpdateBatchItem,
) -> Result<StagedExtensionArtifact, String> {
    let url = validate_extension_batch_item(&item)?;
    let file_name = url
        .path_segments()
        .and_then(|segments| segments.last())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Extension artifact URL has no file name.".to_string())?
        .to_string();
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Could not download extension artifact: {error}"))?;
    if response.url().scheme() != "https"
        || response.url().username() != ""
        || response.url().password().is_some()
    {
        return Err("Extension artifact redirect left credential-free HTTPS.".to_string());
    }
    if !response.status().is_success() {
        return Err(format!(
            "Extension artifact download returned HTTP {}.",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_EXTENSION_ARTIFACT_BYTES)
    {
        return Err("Extension artifact exceeds the staging size limit.".to_string());
    }
    fs::create_dir_all(root)
        .map_err(|error| format!("Could not create extension staging directory: {error}"))?;
    let path = root.join(format!("{}-{}", Uuid::new_v4(), file_name));
    let mut file = File::create(&path)
        .map_err(|error| format!("Could not create staged extension artifact: {error}"))?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("Extension artifact download failed: {error}"))?;
        total = total.saturating_add(chunk.len() as u64);
        if total > MAX_EXTENSION_ARTIFACT_BYTES {
            let _ = fs::remove_file(&path);
            return Err("Extension artifact exceeds the staging size limit.".to_string());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .map_err(|error| format!("Could not write staged extension artifact: {error}"))?;
    }
    if total == 0 {
        let _ = fs::remove_file(&path);
        return Err("Extension artifact download was empty.".to_string());
    }
    file.sync_all()
        .map_err(|error| format!("Could not flush staged extension artifact: {error}"))?;
    Ok(StagedExtensionArtifact {
        input: item,
        file_name,
        path,
        sha256: hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    })
}

fn materialize_snapshot_for_candidate(
    snapshot_dir: &Path,
    candidate_root: &Path,
) -> Result<(), String> {
    let manifest = validate_snapshot_for_restore(snapshot_dir)?;
    if candidate_root.exists() {
        fs::remove_dir_all(candidate_root)
            .map_err(|error| format!("Could not reset extension candidate profile: {error}"))?;
    }
    fs::create_dir_all(candidate_root)
        .map_err(|error| format!("Could not create extension candidate profile: {error}"))?;
    for entry in manifest.files {
        validate_snapshot_relative_path(&entry.name)?;
        let source = snapshot_dir.join(&entry.name);
        let destination = candidate_root.join(&entry.name);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("Could not create candidate profile directory: {error}")
            })?;
        }
        fs::copy(&source, &destination)
            .map_err(|error| format!("Could not materialize candidate profile: {error}"))?;
        if sha256_file(&destination)? != entry.sha256 {
            return Err(format!(
                "Candidate profile file {} failed SHA-256 validation.",
                entry.name
            ));
        }
    }
    remove_server_owner_files_for_update(candidate_root);
    Ok(())
}

fn remove_server_owner_files_for_update(root: &Path) {
    let _ = fs::remove_file(server_owner_path(root));
    let _ = fs::remove_file(server_spawn_lock_path(root));
    let _ = fs::remove_file(root.join("server.owner.json.tmp"));
}

fn write_extension_candidate_config(root: &Path, port: u16) -> Result<(), String> {
    let config = format!(
        "server.ip = \"127.0.0.1\"\nserver.port = {port}\nserver.webUIEnabled = false\nserver.initialOpenInBrowserEnabled = false\nserver.systemTrayEnabled = false\nserver.debugLogsEnabled = false\nserver.autoDownloadNewChapters = false\nserver.globalUpdateInterval = 0\nserver.webUIUpdateCheckInterval = 0\nserver.maxSourcesInParallel = 1\nserver.extensionStores = []\n"
    );
    fs::write(root.join("server.conf"), config)
        .map_err(|error| format!("Could not write extension candidate config: {error}"))
}

async fn upload_exact_extension_artifact(
    client: &reqwest::Client,
    server_url: &str,
    auth_header: Option<&str>,
    artifact: &StagedExtensionArtifact,
) -> Result<Vec<String>, String> {
    let endpoint = graphql_endpoint(server_url)?;
    let part = reqwest::multipart::Part::file(&artifact.path)
        .await
        .map_err(|error| format!("Could not open staged extension artifact: {error}"))?
        .file_name(artifact.file_name.clone());
    let operations = json!({
        "operationName": "EpigraphInstallExactExtension",
        "query": "mutation EpigraphInstallExactExtension($extensionFile: Upload!) { installExternalExtension(input: { extensionFile: $extensionFile }) { extension { pkgName versionName versionCodeLong isInstalled } } }",
        "variables": { "extensionFile": Value::Null }
    });
    let form = reqwest::multipart::Form::new()
        .text("operations", operations.to_string())
        .text(
            "map",
            json!({ "0": ["variables.extensionFile"] }).to_string(),
        )
        .part("0", part);
    let mut request = client.post(&endpoint).multipart(form);
    if let Some(auth) = auth_header.filter(|value| !value.trim().is_empty()) {
        request = request.header(reqwest::header::AUTHORIZATION, auth);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Exact extension install failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Exact extension install returned HTTP {}.",
            response.status()
        ));
    }
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Exact extension install returned invalid JSON: {error}"))?;
    if payload
        .get("errors")
        .and_then(Value::as_array)
        .is_some_and(|errors| !errors.is_empty())
    {
        return Err("Suwayomi rejected the exact extension artifact.".to_string());
    }
    let installed = payload
        .pointer("/data/installExternalExtension/extension")
        .ok_or_else(|| "Exact extension install returned no extension identity.".to_string())?;
    if installed.get("pkgName").and_then(Value::as_str) != Some(&artifact.input.package_name)
        || installed.get("isInstalled").and_then(Value::as_bool) != Some(true)
        || installed
            .get("versionCodeLong")
            .map(|value| value.to_string())
            != Some(artifact.input.version_code.clone())
    {
        return Err("Exact extension install returned an unexpected identity.".to_string());
    }
    extension_source_ids(
        client,
        server_url,
        auth_header,
        &artifact.input.package_name,
        &artifact.input.version_code,
    )
    .await
}

async fn query_extension_source_ids_once(
    client: &reqwest::Client,
    server_url: &str,
    auth_header: Option<&str>,
    package_name: &str,
    expected_version_code: &str,
) -> Result<Vec<String>, String> {
    let endpoint = graphql_endpoint(server_url)?;
    let mut request = client.post(endpoint).json(&json!({
        "query": "query EpigraphExtensionIdentity { extensions { nodes { pkgName versionCodeLong isInstalled } } sources { nodes { id extension { pkgName } } } }"
    }));
    if let Some(auth) = auth_header.filter(|value| !value.trim().is_empty()) {
        request = request.header(reqwest::header::AUTHORIZATION, auth);
    }
    let payload = request
        .send()
        .await
        .map_err(|error| format!("Could not verify extension identity: {error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("Extension identity response was invalid: {error}"))?;
    if payload
        .get("errors")
        .and_then(Value::as_array)
        .is_some_and(|errors| !errors.is_empty())
    {
        return Err("Suwayomi could not verify extension source registration.".to_string());
    }
    let extension_matches = payload
        .pointer("/data/extensions/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|extension| {
            extension.get("pkgName").and_then(Value::as_str) == Some(package_name)
                && extension.get("isInstalled").and_then(Value::as_bool) == Some(true)
                && extension
                    .get("versionCodeLong")
                    .map(Value::to_string)
                    .as_deref()
                    == Some(expected_version_code)
        });
    if !extension_matches {
        return Err("Installed extension identity does not match the staged artifact.".to_string());
    }
    let mut source_ids = payload
        .pointer("/data/sources/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|source| {
            source.pointer("/extension/pkgName").and_then(Value::as_str) == Some(package_name)
        })
        .filter_map(|source| {
            source.get("id").map(|id| {
                id.as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| id.to_string())
            })
        })
        .collect::<Vec<_>>();
    source_ids.sort();
    source_ids.dedup();
    Ok(source_ids)
}

async fn extension_source_ids(
    client: &reqwest::Client,
    server_url: &str,
    auth_header: Option<&str>,
    package_name: &str,
    expected_version_code: &str,
) -> Result<Vec<String>, String> {
    let mut last_error = None;
    for attempt in 0..30 {
        match query_extension_source_ids_once(
            client,
            server_url,
            auth_header,
            package_name,
            expected_version_code,
        )
        .await
        {
            Ok(source_ids) if !source_ids.is_empty() => return Ok(source_ids),
            Ok(_) => last_error = Some("Installed extension registered no sources.".to_string()),
            Err(error) => last_error = Some(error),
        }
        if attempt < 29 {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    Err(last_error.unwrap_or_else(|| "Installed extension registered no sources.".to_string()))
}

fn extension_evidence(
    artifact: &StagedExtensionArtifact,
    source_ids: Vec<String>,
    status: &str,
    failure_code: Option<String>,
) -> ExtensionUpdateBatchEvidence {
    ExtensionUpdateBatchEvidence {
        package_name: artifact.input.package_name.clone(),
        version_code: artifact.input.version_code.clone(),
        version_name: artifact.input.version_name.clone(),
        artifact_sha256: artifact.sha256.clone(),
        store_id: artifact.input.store_id.clone(),
        store_url_canonical: artifact.input.store_url_canonical.clone(),
        source_ids,
        status: status.to_string(),
        // Structural rejection alone does not prove whether the runtime or the
        // extension owns the failure. Detailed diagnostics classify it later.
        failure_owner: "unknown".to_string(),
        failure_code,
    }
}

fn stop_target_if_running(app: &AppHandle, target: &LocalServerTarget) -> Result<(), String> {
    if let Some(pid) = find_java_pid_for_rootdir(&target.root_dir) {
        stop_runtime_for_maintenance(app, target)?;
        wait_for_managed_runtime_stop(&target.root_dir, pid)?;
    }
    assert_local_port_released(target.port)?;
    assert_profile_database_unlocked(&target.root_dir)
}

fn extension_batch_journal_path() -> PathBuf {
    managed_runtime_root().join(EXTENSION_BATCH_JOURNAL)
}

fn write_extension_batch_journal_at(
    path: &Path,
    journal: &ExtensionBatchJournal,
) -> Result<(), String> {
    fs::create_dir_all(path.parent().unwrap_or_else(|| Path::new(".")))
        .map_err(|error| format!("Could not create extension journal directory: {error}"))?;
    let temp_path = path.with_extension(format!("{}.tmp", journal.operation_id));
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|error| format!("Could not serialize extension update journal: {error}"))?;
    let mut file = File::create(&temp_path)
        .map_err(|error| format!("Could not create extension update journal: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("Could not write extension update journal: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not flush extension update journal: {error}"))?;
    suwayomi_maintenance::atomic_replace_file(&temp_path, &path)
        .map_err(|error| format!("Could not publish extension update journal: {error}"))
}

fn write_extension_batch_journal(journal: &ExtensionBatchJournal) -> Result<(), String> {
    write_extension_batch_journal_at(&extension_batch_journal_path(), journal)
}

fn read_extension_batch_journal_at(path: &Path) -> Result<Option<ExtensionBatchJournal>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read extension update journal: {error}")),
    };
    let journal = serde_json::from_str::<ExtensionBatchJournal>(&text)
        .map_err(|error| format!("Could not parse extension update journal: {error}"))?;
    if journal.schema_version != 1 {
        return Err("Extension update journal has an unsupported schema.".to_string());
    }
    Ok(Some(journal))
}

fn read_extension_batch_journal() -> Result<Option<ExtensionBatchJournal>, String> {
    read_extension_batch_journal_at(&extension_batch_journal_path())
}

fn remove_extension_batch_journal() -> Result<(), String> {
    match fs::remove_file(extension_batch_journal_path()) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Could not remove extension update journal: {error}"
        )),
    }
}

fn validate_extension_batch_journal_paths(
    journal: &ExtensionBatchJournal,
    requested_target: &LocalServerTarget,
    app: &AppHandle,
) -> Result<LocalServerTarget, String> {
    if journal.profile_id != requested_target.profile_key
        || comparable_path(Path::new(&journal.root_dir))
            != comparable_path(&requested_target.root_dir)
        || normalize_server_url(Some(&journal.server_url))
            != normalize_server_url(Some(&requested_target.server_url))
    {
        return Err("Extension update journal does not match the requested profile.".to_string());
    }
    let expected_batch_parent = suwayomi_data_dir().join(EXTENSION_BATCH_ROOT);
    let batch_root = PathBuf::from(&journal.batch_root);
    if batch_root.parent().map(comparable_path) != Some(comparable_path(&expected_batch_parent)) {
        return Err("Extension update journal contains an invalid batch path.".to_string());
    }
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let candidate = resolve_local_server_target(
        &launch_target,
        Some(&journal.candidate_server_url),
        Some(&journal.candidate_profile_id),
        Some("Extension staging"),
    )
    .map_err(|error| format!("Could not resolve extension recovery candidate: {error:?}"))?;
    if comparable_path(&candidate.root_dir)
        != comparable_path(Path::new(&journal.candidate_root_dir))
    {
        return Err("Extension update journal contains an invalid candidate path.".to_string());
    }
    if !journal.snapshot_path.is_empty() {
        validate_snapshot_for_restore(Path::new(&journal.snapshot_path))?;
    }
    Ok(candidate)
}

fn recover_extension_batch_before_spawn(
    app: &AppHandle,
    requested_target: &LocalServerTarget,
) -> Result<(), String> {
    let Some(mut journal) = read_extension_batch_journal()? else {
        return Ok(());
    };
    let mut guard = try_acquire_suwayomi_update_lock("extension-recovery")?;
    guard.begin_maintenance("extension-recovery", MaintenancePhase::Recovering)?;
    let candidate = validate_extension_batch_journal_paths(&journal, requested_target, app)?;
    stop_target_if_running(app, &candidate)?;
    if journal.state != ExtensionBatchJournalState::Committed {
        stop_target_if_running(app, requested_target)?;
        if journal.state != ExtensionBatchJournalState::Prepared {
            journal.transition(ExtensionBatchJournalState::RollbackRunning);
            write_extension_batch_journal(&journal)?;
            restore_snapshot_to_root(
                Path::new(&journal.snapshot_path),
                &requested_target.root_dir,
            )?;
            journal.transition(ExtensionBatchJournalState::RolledBack);
            write_extension_batch_journal(&journal)?;
        }
    }
    let _ = fs::remove_dir_all(&candidate.root_dir);
    let _ = fs::remove_dir_all(&journal.batch_root);
    remove_extension_batch_journal()
}

async fn rollback_extension_batch(
    app: &AppHandle,
    target: &LocalServerTarget,
    snapshot_dir: &Path,
    auth_header: Option<&str>,
    runtime_version: &str,
) -> Result<(), String> {
    stop_target_if_running(app, target)?;
    restore_snapshot_to_root(snapshot_dir, &target.root_dir)?;
    restart_managed_runtime(app, target)?;
    run_suwayomi_graphql_health_check(&target.server_url, auth_header, runtime_version).await
}

async fn restore_extension_candidate_after_rejection(
    app: &AppHandle,
    target: &LocalServerTarget,
    snapshot_dir: &Path,
    port: u16,
    runtime_version: &str,
    client: &reqwest::Client,
    approved: &[(StagedExtensionArtifact, Vec<String>)],
) -> Result<(), String> {
    stop_target_if_running(app, target)?;
    materialize_snapshot_for_candidate(snapshot_dir, &target.root_dir)?;
    write_extension_candidate_config(&target.root_dir, port)?;
    restart_managed_runtime(app, target)?;
    run_suwayomi_graphql_health_check(&target.server_url, None, runtime_version).await?;
    for (artifact, expected_source_ids) in approved {
        let source_ids =
            upload_exact_extension_artifact(client, &target.server_url, None, artifact).await?;
        if &source_ids != expected_source_ids {
            return Err(
                "An approved extension changed identity while rebuilding staging.".to_string(),
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn certify_suwayomi_extension_update_batch(
    server_url: Option<String>,
    binary: Option<String>,
    profile_id: Option<String>,
    profile_label: Option<String>,
    authorization: Option<String>,
    items: Vec<ExtensionUpdateBatchItem>,
    app: AppHandle,
) -> Result<ExtensionUpdateBatchResult, String> {
    if items.is_empty() {
        return Err("Extension update batch is empty.".to_string());
    }
    if items.len() > 100 {
        return Err("Extension update batch exceeds the supported size.".to_string());
    }
    let unique_packages = items
        .iter()
        .map(|item| item.package_name.trim())
        .collect::<std::collections::HashSet<_>>();
    if unique_packages.len() != items.len() {
        return Err("Extension update batch contains duplicate packages.".to_string());
    }
    if read_extension_batch_journal()?.is_some() {
        return Err(
            "An interrupted extension update must be recovered before starting another batch."
                .to_string(),
        );
    }
    let mut guard = try_acquire_suwayomi_update_lock("extension-batch")?;
    let runtime = get_suwayomi_runtime_status(
        server_url.clone(),
        binary.clone(),
        profile_id.clone(),
        profile_label.clone(),
        app.clone(),
    );
    if !runtime.update_allowed {
        return Err(runtime.block_reason.unwrap_or_else(|| {
            "This Suwayomi runtime cannot certify extension updates.".to_string()
        }));
    }
    let runtime_version = runtime.version.clone().unwrap_or_default();
    let compatibility_manifest = load_compatibility_manifest()?;
    let allowed_runtime = compatibility_manifest
        .allowed_version(&runtime_version)
        .ok_or_else(|| {
            "Transactional extension updates require an allowlisted Suwayomi runtime.".to_string()
        })?;
    if !allowed_runtime.transactional_extension_updates {
        return Err(format!(
            "Transactional extension updates are not certified for Suwayomi {} ({:?}).",
            allowed_runtime.version, allowed_runtime.compatibility_profile
        ));
    }
    let runtime_jar = runtime
        .jar_path
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| "Managed Suwayomi JAR path is unavailable.".to_string())?;
    let runtime_artifact_sha256 = sha256_file(&runtime_jar)?;
    if !runtime_artifact_sha256.eq_ignore_ascii_case(&allowed_runtime.sha256) {
        return Err(
            "The active Suwayomi runtime does not match its certified artifact SHA-256."
                .to_string(),
        );
    }
    let batch_id = Uuid::new_v4().to_string();
    let batch_root = suwayomi_data_dir()
        .join(EXTENSION_BATCH_ROOT)
        .join(&batch_id);
    let _batch_cleanup = ExtensionBatchCleanup {
        root: batch_root.clone(),
    };
    let artifacts_root = batch_root.join("artifacts");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("Could not create extension update client: {error}"))?;
    let mut artifacts = Vec::with_capacity(items.len());
    for item in items {
        match stage_extension_artifact(&client, &artifacts_root, item).await {
            Ok(artifact) => artifacts.push(artifact),
            Err(error) => return Err(error),
        }
    }

    // Resolve every owned resource before stopping the current runtime. From the
    // snapshot onward, all failures are handled by the transaction rollback.
    let target = resolve_update_target(
        server_url.clone(),
        profile_id.clone(),
        profile_label.clone(),
        &app,
    )?;
    let candidate_port = allocate_extension_candidate_port()?;
    let compact_batch_id = batch_id.replace('-', "");
    let candidate_profile = format!("ext-stage-{}", &compact_batch_id[..20]);
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let candidate_url = format!("http://127.0.0.1:{candidate_port}");
    let candidate_target = resolve_local_server_target(
        &launch_target,
        Some(&candidate_url),
        Some(&candidate_profile),
        Some("Extension staging"),
    )
    .map_err(|error| format!("Could not resolve extension candidate profile: {error:?}"))?;

    guard.begin_maintenance("extension-batch", MaintenancePhase::Updating)?;
    let mut journal = ExtensionBatchJournal {
        schema_version: 1,
        operation_id: batch_id.clone(),
        state: ExtensionBatchJournalState::Prepared,
        profile_id: target.profile_key.clone(),
        root_dir: path_to_string(&target.root_dir),
        server_url: target.server_url.clone(),
        runtime_version: runtime_version.clone(),
        snapshot_path: String::new(),
        batch_root: path_to_string(&batch_root),
        candidate_profile_id: candidate_target.profile_key.clone(),
        candidate_root_dir: path_to_string(&candidate_target.root_dir),
        candidate_server_url: candidate_target.server_url.clone(),
        updated_at_ms: unix_now_ms(),
    };
    write_extension_batch_journal(&journal)?;
    let snapshot = match create_suwayomi_update_snapshot_unlocked(
        Some(target.server_url.clone()),
        binary,
        Some(target.profile_key.clone()),
        None,
        false,
        app.clone(),
    ) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let _ = remove_extension_batch_journal();
            return Err(error);
        }
    };
    let snapshot_dir = PathBuf::from(&snapshot.snapshot_path);
    journal.snapshot_path = snapshot.snapshot_path.clone();
    journal.transition(ExtensionBatchJournalState::SnapshotCreated);
    if let Err(error) = write_extension_batch_journal(&journal) {
        let restart = restart_managed_runtime(&app, &target);
        let _ = remove_extension_batch_journal();
        return match restart {
            Ok(()) => Err(error),
            Err(restart_error) => Err(format!(
                "{error}. The managed runtime could not be restarted: {restart_error}"
            )),
        };
    }

    let transaction = async {
        journal.transition(ExtensionBatchJournalState::Certifying);
        write_extension_batch_journal(&journal)?;
        materialize_snapshot_for_candidate(&snapshot_dir, &candidate_target.root_dir)?;
        write_extension_candidate_config(&candidate_target.root_dir, candidate_port)?;
        spawn_managed_server_for_update(
            candidate_target.server_url.clone(),
            Some(candidate_target.profile_key.clone()),
            app.clone(),
        )
        .map_err(|error| format!("Could not start extension candidate: {error:?}"))?;
        run_suwayomi_graphql_health_check(&candidate_target.server_url, None, &runtime_version)
            .await?;

        let mut candidate_approved: Vec<(StagedExtensionArtifact, Vec<String>)> = Vec::new();
        let mut rejected = Vec::new();
        for artifact in &artifacts {
            match upload_exact_extension_artifact(
                &client,
                &candidate_target.server_url,
                None,
                artifact,
            )
            .await
            {
                Ok(source_ids) => candidate_approved.push((artifact.clone(), source_ids)),
                Err(error) => {
                    rejected.push(extension_evidence(
                        artifact,
                        Vec::new(),
                        "INCOMPATIBLE",
                        Some(
                            if error.contains("unexpected identity") {
                                "ARTIFACT_IDENTITY_MISMATCH"
                            } else if error.contains("registered no sources") {
                                "NO_SOURCES_REGISTERED"
                            } else {
                                "STRUCTURAL_CERTIFICATION_FAILED"
                            }
                            .to_string(),
                        ),
                    ));
                    restore_extension_candidate_after_rejection(
                        &app,
                        &candidate_target,
                        &snapshot_dir,
                        candidate_port,
                        &runtime_version,
                        &client,
                        &candidate_approved,
                    )
                    .await?;
                }
            }
        }

        stop_target_if_running(&app, &candidate_target)?;
        restart_managed_runtime(&app, &candidate_target)?;
        run_suwayomi_graphql_health_check(&candidate_target.server_url, None, &runtime_version)
            .await?;
        let mut approved = Vec::new();
        let mut approved_artifacts = Vec::new();
        for (artifact, expected_source_ids) in candidate_approved {
            match extension_source_ids(
                &client,
                &candidate_target.server_url,
                None,
                &artifact.input.package_name,
                &artifact.input.version_code,
            )
            .await
            {
                Ok(source_ids) if source_ids == expected_source_ids => {
                    approved.push(extension_evidence(&artifact, source_ids, "HEALTHY", None));
                    approved_artifacts.push(artifact);
                }
                Ok(_) => rejected.push(extension_evidence(
                    &artifact,
                    Vec::new(),
                    "INCOMPATIBLE",
                    Some("SOURCE_IDENTITY_CHANGED_AFTER_RESTART".to_string()),
                )),
                Err(error) => rejected.push(extension_evidence(
                    &artifact,
                    Vec::new(),
                    "INCOMPATIBLE",
                    Some(
                        if error.contains("registered no sources") {
                            "NO_SOURCES_AFTER_RESTART"
                        } else {
                            "RESTART_CERTIFICATION_FAILED"
                        }
                        .to_string(),
                    ),
                )),
            }
        }
        stop_target_if_running(&app, &candidate_target)?;

        journal.transition(ExtensionBatchJournalState::Activating);
        write_extension_batch_journal(&journal)?;
        restart_managed_runtime(&app, &target)?;
        run_suwayomi_graphql_health_check(
            &target.server_url,
            authorization.as_deref(),
            &runtime_version,
        )
        .await?;
        for artifact in &approved_artifacts {
            upload_exact_extension_artifact(
                &client,
                &target.server_url,
                authorization.as_deref(),
                artifact,
            )
            .await?;
        }
        stop_target_if_running(&app, &target)?;
        restart_managed_runtime(&app, &target)?;
        run_suwayomi_graphql_health_check(
            &target.server_url,
            authorization.as_deref(),
            &runtime_version,
        )
        .await?;
        for evidence in &approved {
            let source_ids = extension_source_ids(
                &client,
                &target.server_url,
                authorization.as_deref(),
                &evidence.package_name,
                &evidence.version_code,
            )
            .await?;
            if source_ids != evidence.source_ids {
                return Err(format!(
                    "Extension {} diverged during activation.",
                    evidence.package_name
                ));
            }
        }
        journal.transition(ExtensionBatchJournalState::Committed);
        write_extension_batch_journal(&journal)?;
        Ok::<_, String>((approved, rejected))
    }
    .await;

    let candidate_stop = stop_target_if_running(&app, &candidate_target);
    if let Err(stop_error) = candidate_stop {
        return Err(format!(
            "Extension staging could not be stopped safely; startup recovery is required: {stop_error}"
        ));
    }
    let candidate_cleanup_error = match fs::remove_dir_all(&candidate_target.root_dir) {
        Ok(()) => None,
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => Some(format!(
            "Could not remove extension staging profile: {error}"
        )),
    };
    let result = match transaction {
        Ok((approved, rejected)) => {
            if let Some(error) = candidate_cleanup_error {
                return Err(format!("{error}. Startup cleanup is required."));
            }
            let _ = remove_extension_batch_journal();
            Ok(ExtensionUpdateBatchResult {
                batch_id,
                runtime_version,
                runtime_artifact_sha256,
                approved,
                rejected,
                restarted_runtime: true,
            })
        }
        Err(error) => {
            journal.transition(ExtensionBatchJournalState::RollbackRunning);
            let _ = write_extension_batch_journal(&journal);
            match rollback_extension_batch(
                &app,
                &target,
                &snapshot_dir,
                authorization.as_deref(),
                &runtime_version,
            )
            .await
            {
                Ok(()) => {
                    journal.transition(ExtensionBatchJournalState::RolledBack);
                    let _ = write_extension_batch_journal(&journal);
                    if let Some(cleanup_error) = candidate_cleanup_error {
                        return Err(format!(
                            "Extension update batch failed and was rolled back, but staging cleanup failed: {cleanup_error}"
                        ));
                    }
                    let _ = remove_extension_batch_journal();
                    Err(format!("Extension update batch failed and was rolled back: {error}"))
                }
                Err(rollback_error) => Err(format!(
                    "Extension update batch failed: {error}. Automatic rollback also failed: {rollback_error}"
                )),
            }
        }
    };
    result
}

async fn run_suwayomi_graphql_health_check(
    server_url: &str,
    auth_header: Option<&str>,
    target_version: &str,
) -> Result<(), String> {
    let endpoint = graphql_endpoint(server_url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(SUWAYOMI_HEALTH_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("Could not create Suwayomi health client: {error}"))?;
    let checks = [
        (
            "typename",
            "query EpigraphHealthTypename { __typename }",
            "GraphQL typename check failed.",
        ),
        (
            "library",
            "query EpigraphHealthLibrary { library: mangas(condition: { inLibrary: true }, first: 1) { nodes { id } } }",
            "Library health check failed.",
        ),
        (
            "sources",
            "query EpigraphHealthSources { sources(first: 1) { nodes { id displayName } } }",
            "Sources health check failed.",
        ),
        (
            "extensions",
            "query EpigraphHealthExtensions { extensions(first: 1) { nodes { pkgName isInstalled } } }",
            "Extensions health check failed.",
        ),
    ];

    let mut last_error = String::new();
    let started = Instant::now();
    let started_at_ms = unix_now_ms();
    let max_wait = Duration::from_millis(SUWAYOMI_HEALTH_MAX_WAIT_MS);
    let mut attempt = 0usize;
    let mut diagnostic_checks = Vec::new();
    while started.elapsed() < max_wait {
        attempt += 1;
        let mut failed = None;
        for (key, query, message) in checks {
            let check_started = Instant::now();
            match run_graphql_health_query(&client, &endpoint, auth_header, key, query).await {
                Ok(()) => {
                    diagnostic_checks.push(SuwayomiHealthDiagnosticCheck {
                        attempt,
                        check: key.to_string(),
                        ok: true,
                        duration_ms: check_started.elapsed().as_millis(),
                        error: None,
                    });
                }
                Err(error) => {
                    diagnostic_checks.push(SuwayomiHealthDiagnosticCheck {
                        attempt,
                        check: key.to_string(),
                        ok: false,
                        duration_ms: check_started.elapsed().as_millis(),
                        error: Some(error.clone()),
                    });
                    failed = Some(format!("{message} {error}"));
                    break;
                }
            }
        }
        if failed.is_none() {
            return Ok(());
        }
        last_error = failed.unwrap_or_default();
        if started.elapsed() < max_wait {
            tokio::time::sleep(Duration::from_millis(SUWAYOMI_HEALTH_DELAY_MS)).await;
        }
    }
    let report = SuwayomiHealthDiagnosticReport {
        schema_version: 1,
        target_version: target_version.to_string(),
        endpoint,
        started_at_ms,
        elapsed_ms: started.elapsed().as_millis(),
        max_wait_ms: SUWAYOMI_HEALTH_MAX_WAIT_MS,
        timeout_secs: SUWAYOMI_HEALTH_TIMEOUT_SECS,
        delay_ms: SUWAYOMI_HEALTH_DELAY_MS,
        attempts: attempt,
        last_error: last_error.clone(),
        checks: diagnostic_checks,
    };
    match write_suwayomi_health_diagnostic_report(&report) {
        Ok(path) => eprintln!(
            "[epigraph-suwayomi-update] health_diagnostic path={}",
            path.display()
        ),
        Err(error) => eprintln!(
            "[epigraph-suwayomi-update] health_diagnostic_failed reason={}",
            error.replace('\n', " ")
        ),
    }
    Err(update_error(
        SuwayomiUpdateErrorKind::HealthCheckError,
        "The downloaded Suwayomi runtime could not be verified safely. Epigraph kept the current runtime.",
    ))
}

fn write_suwayomi_health_diagnostic_report(
    report: &SuwayomiHealthDiagnosticReport,
) -> Result<PathBuf, String> {
    write_suwayomi_health_diagnostic_report_to_dir(
        &managed_runtime_root().join(SUWAYOMI_DIAGNOSTICS_DIR),
        report,
    )
}

fn write_suwayomi_health_diagnostic_report_to_dir(
    diagnostics_dir: &Path,
    report: &SuwayomiHealthDiagnosticReport,
) -> Result<PathBuf, String> {
    fs::create_dir_all(diagnostics_dir)
        .map_err(|error| format!("Could not create Suwayomi diagnostics directory: {error}"))?;
    let version = normalize_version_tag(&report.target_version);
    let path = diagnostics_dir.join(format!("health-{version}-{}.json", report.started_at_ms));
    let bytes = serde_json::to_vec_pretty(report)
        .map_err(|error| format!("Could not serialize Suwayomi health diagnostic: {error}"))?;
    fs::write(&path, bytes)
        .map_err(|error| format!("Could not write Suwayomi health diagnostic: {error}"))?;
    Ok(path)
}

async fn run_graphql_health_query(
    client: &reqwest::Client,
    endpoint: &str,
    auth_header: Option<&str>,
    expected_key: &str,
    query: &str,
) -> Result<(), String> {
    let mut request = client.post(endpoint).json(&json!({ "query": query }));
    if let Some(auth) = auth_header.filter(|value| !value.trim().is_empty()) {
        request = request.header(reqwest::header::AUTHORIZATION, auth);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Suwayomi GraphQL request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Suwayomi GraphQL returned HTTP {}.",
            response.status()
        ));
    }
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Suwayomi GraphQL returned invalid JSON: {error}"))?;
    validate_graphql_health_payload(&payload, expected_key)
}

fn graphql_endpoint(server_url: &str) -> Result<String, String> {
    let mut parsed = Url::parse(server_url)
        .map_err(|error| format!("Suwayomi server URL is invalid: {error}"))?;
    parsed.set_path("/api/graphql");
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.to_string())
}

fn validate_graphql_health_payload(payload: &Value, expected_key: &str) -> Result<(), String> {
    if let Some(errors) = payload.get("errors").and_then(Value::as_array) {
        if !errors.is_empty() {
            let message = errors
                .iter()
                .filter_map(|error| error.get("message").and_then(Value::as_str))
                .filter(|message| !message.trim().is_empty())
                .collect::<Vec<_>>()
                .join("; ");
            return Err(if message.is_empty() {
                "Suwayomi returned a GraphQL error.".to_string()
            } else {
                message
            });
        }
    }
    let data = payload
        .get("data")
        .ok_or_else(|| "Suwayomi GraphQL payload is missing data.".to_string())?;
    if expected_key == "typename" {
        return data
            .get("__typename")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(|_| ())
            .ok_or_else(|| "Suwayomi GraphQL typename is missing.".to_string());
    }
    let connection = data
        .get(expected_key)
        .ok_or_else(|| format!("Suwayomi GraphQL payload is missing {expected_key}."))?;
    if !connection.get("nodes").is_some_and(Value::is_array) {
        return Err(format!(
            "Suwayomi GraphQL {expected_key} response has no nodes array."
        ));
    }
    Ok(())
}

fn validate_snapshot_for_restore(snapshot_dir: &Path) -> Result<SuwayomiSnapshotManifest, String> {
    if !snapshot_dir.is_dir() {
        return Err("Rollback snapshot directory does not exist.".to_string());
    }
    let manifest_path = snapshot_dir.join(SUWAYOMI_SNAPSHOT_MANIFEST);
    let text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Could not read rollback snapshot manifest: {error}"))?;
    let manifest: SuwayomiSnapshotManifest = serde_json::from_str(&text)
        .map_err(|error| format!("Could not parse rollback snapshot manifest: {error}"))?;
    let supported = (manifest.schema_version == 1 && manifest.snapshot_version == "1")
        || (manifest.schema_version == 2 && manifest.snapshot_version == SUWAYOMI_SNAPSHOT_VERSION);
    if !supported {
        return Err("Rollback snapshot manifest has an unsupported schema.".to_string());
    }
    validate_snapshot_files(snapshot_dir, &manifest.files)?;
    Ok(manifest)
}

fn restore_snapshot_to_root(snapshot_dir: &Path, root_dir: &Path) -> Result<(), String> {
    let manifest = validate_snapshot_for_restore(snapshot_dir)?;
    if comparable_path(Path::new(&manifest.source_root)) != comparable_path(root_dir) {
        return Err("Rollback snapshot belongs to a different Suwayomi root.".to_string());
    }
    let snapshot_names = manifest
        .files
        .iter()
        .map(|file| file.name.as_str())
        .collect::<std::collections::HashSet<_>>();
    for name in SUWAYOMI_SNAPSHOT_ALLOWLIST {
        let target = root_dir.join(name);
        if !snapshot_names.contains(name) && target.exists() {
            fs::remove_file(&target)
                .map_err(|error| format!("Could not remove restored-absent {name}: {error}"))?;
        }
    }
    remove_snapshot_directory_extras(root_dir, &snapshot_names)?;
    for file in &manifest.files {
        validate_snapshot_relative_path(&file.name)?;
        let source = snapshot_dir.join(&file.name);
        let target = root_dir.join(&file.name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("Could not create restore parent for {}: {error}", file.name)
            })?;
        }
        let temp_target = target.with_extension(format!("{}.restore.tmp", Uuid::new_v4()));
        fs::copy(&source, &temp_target)
            .map_err(|error| format!("Could not restore {} from snapshot: {error}", file.name))?;
        OpenOptions::new()
            .write(true)
            .open(&temp_target)
            .and_then(|restored| restored.sync_all())
            .map_err(|error| format!("Could not sync restored {}: {error}", file.name))?;
        let restored_sha256 = sha256_file(&temp_target)?;
        if restored_sha256 != file.sha256 {
            let _ = fs::remove_file(&temp_target);
            return Err(format!(
                "Restored snapshot file {} failed SHA-256 validation.",
                file.name
            ));
        }
        suwayomi_maintenance::atomic_replace_file(&temp_target, &target)
            .map_err(|error| format!("Could not publish restored {}: {error}", file.name))?;
    }
    Ok(())
}

fn relative_path_string(path: &Path) -> Result<String, String> {
    validate_snapshot_relative_path(&path.to_string_lossy())?;
    Ok(path
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn validate_snapshot_relative_path(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if value.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("Snapshot manifest contains an unsafe relative path.".to_string());
    }
    Ok(())
}

fn remove_snapshot_directory_extras(
    root_dir: &Path,
    snapshot_names: &std::collections::HashSet<&str>,
) -> Result<(), String> {
    for directory in SUWAYOMI_SNAPSHOT_DIRECTORY_ALLOWLIST {
        let directory_root = root_dir.join(directory);
        if !directory_root.exists() {
            continue;
        }
        let entries = WalkDir::new(&directory_root)
            .follow_links(false)
            .contents_first(true)
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not inspect restore directory {directory}: {error}"))?;
        for entry in entries {
            if entry.file_type().is_symlink() {
                return Err(format!(
                    "Restore directory {directory} contains an unsupported symbolic link."
                ));
            }
            if entry.file_type().is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root_dir)
                    .map_err(|_| "Restore file escaped the Suwayomi profile.".to_string())?;
                let name = relative_path_string(relative)?;
                if !snapshot_names.contains(name.as_str()) {
                    fs::remove_file(entry.path()).map_err(|error| {
                        format!("Could not remove restored-absent {name}: {error}")
                    })?;
                }
            } else if entry.file_type().is_dir()
                && entry.path() != directory_root
                && fs::read_dir(entry.path())
                    .map(|mut children| children.next().is_none())
                    .unwrap_or(false)
            {
                let _ = fs::remove_dir(entry.path());
            }
        }
    }
    Ok(())
}

impl SuwayomiCompatibilityManifest {
    fn allowed_version(&self, version: &str) -> Option<&SuwayomiAllowedVersion> {
        let normalized = normalize_version_tag(version);
        self.allowed_versions
            .iter()
            .find(|allowed| normalize_version_tag(&allowed.version) == normalized)
    }

    fn blocked_reason(&self, version: &str) -> Option<&str> {
        let normalized = normalize_version_tag(version);
        self.blocked_versions
            .iter()
            .find(|blocked| normalize_version_tag(&blocked.version) == normalized)
            .map(|blocked| blocked.reason.as_str())
    }

    fn version_within_tested_range(&self, version: &str) -> bool {
        compare_versions(version, &self.min_supported_version)
            .is_some_and(|ordering| ordering != std::cmp::Ordering::Less)
            && compare_versions(version, &self.max_tested_version)
                .is_some_and(|ordering| ordering != std::cmp::Ordering::Greater)
    }
}

fn blocked_update_check(
    current_version: Option<String>,
    block_reason: String,
) -> SuwayomiUpdateCheckResult {
    SuwayomiUpdateCheckResult {
        status: UpdateCheckStatus::Blocked,
        current_version,
        latest_compatible_version: None,
        release_tag: None,
        release_url: None,
        update_allowed: false,
        block_reason: Some(block_reason),
        notes: None,
        release_notes: None,
    }
}

fn failed_update_check(
    current_version: Option<String>,
    block_reason: String,
) -> SuwayomiUpdateCheckResult {
    SuwayomiUpdateCheckResult {
        status: UpdateCheckStatus::CheckFailed,
        current_version,
        latest_compatible_version: None,
        release_tag: None,
        release_url: None,
        update_allowed: false,
        block_reason: Some(block_reason),
        notes: None,
        release_notes: None,
    }
}

fn non_empty_string(value: &String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_version_tag(value: &str) -> String {
    let trimmed = value.trim();
    let without_prefix = trimmed.strip_prefix('v').unwrap_or(trimmed);
    format!("v{}", without_prefix)
}

fn version_parts(value: &str) -> Option<Vec<u64>> {
    let trimmed = value.trim().trim_start_matches('v');
    let parts: Vec<u64> = trimmed
        .split('.')
        .map(|part| part.parse::<u64>())
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

fn compare_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    let mut left_parts = version_parts(left)?;
    let mut right_parts = version_parts(right)?;
    let width = left_parts.len().max(right_parts.len());
    left_parts.resize(width, 0);
    right_parts.resize(width, 0);
    Some(left_parts.cmp(&right_parts))
}

fn compare_versions_for_sort(left: &str, right: &str) -> std::cmp::Ordering {
    compare_versions(left, right)
        .unwrap_or_else(|| normalize_version_tag(left).cmp(&normalize_version_tag(right)))
}

fn normalize_server_url(raw: Option<&str>) -> String {
    let fallback = format!("http://127.0.0.1:{}", crate::suwayomi_runtime::main_server_port());
    raw.unwrap_or(&fallback)
        .trim()
        .trim_end_matches('/')
        .to_string()
}

fn managed_runtime_jar_path() -> PathBuf {
    suwayomi_data_dir()
        .join(SUWAYOMI_RUNTIME_DIR)
        .join(SUWAYOMI_CURRENT_DIR)
        .join(SUWAYOMI_SERVER_JAR)
}

fn bundled_jar_path(app: &AppHandle) -> PathBuf {
    let candidates = bundled_jar_candidates(app);
    candidates
        .iter()
        .find(|path| path.exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

fn bundled_jar_candidates(app: &AppHandle) -> Vec<PathBuf> {
    #[cfg(not(target_os = "macos"))]
    {
        let resource_dir = strip_unc(app.path().resource_dir().unwrap_or_default());
        vec![resource_dir
            .join("binaries")
            .join("suwayomi-bundle")
            .join("bin")
            .join(SUWAYOMI_SERVER_JAR)]
    }

    #[cfg(target_os = "macos")]
    {
        let resource_dir = app.path().resource_dir().unwrap_or_default();
        vec![
            resource_dir
                .join("binaries")
                .join("suwayomi-bundle")
                .join("bin")
                .join(SUWAYOMI_SERVER_JAR),
            resource_dir
                .join("suwayomi-bundle")
                .join("bin")
                .join(SUWAYOMI_SERVER_JAR),
        ]
    }
}

fn prove_epigraph_runtime_ownership(target: &LocalServerTarget) -> Result<u32, String> {
    let spawn_lock = server_spawn_lock_path(&target.root_dir);
    if spawn_lock.exists() {
        return Err(
            "Epigraph is still starting or reconciling this Suwayomi runtime; update is blocked."
                .to_string(),
        );
    }

    let owner_path = server_owner_path(&target.root_dir);
    let Some(owner) = read_server_owner(&owner_path) else {
        return Err(
            "Epigraph has not published ownership for this local Suwayomi runtime.".to_string(),
        );
    };

    match validate_server_owner(target, &owner) {
        OwnerReuseDecision::Reusable => Ok(owner.java_pid),
        OwnerReuseDecision::Stale => {
            Err("The local Suwayomi ownership record is stale; update is blocked.".to_string())
        }
        OwnerReuseDecision::ConflictingLiveProcess => Err(
            "A local Suwayomi process is alive but failed Epigraph ownership health checks."
                .to_string(),
        ),
    }
}

fn select_effective_managed_jar<F>(
    runtime_jar: &Path,
    bundled_jar: &Path,
    mut process_uses_jar: F,
) -> Option<(SuwayomiRuntimeMode, PathBuf)>
where
    F: FnMut(&Path) -> bool,
{
    if runtime_jar.exists() && process_uses_jar(runtime_jar) {
        return Some((
            SuwayomiRuntimeMode::ManagedRuntime,
            runtime_jar.to_path_buf(),
        ));
    }
    if bundled_jar.exists() && process_uses_jar(bundled_jar) {
        return Some((
            SuwayomiRuntimeMode::ManagedBundled,
            bundled_jar.to_path_buf(),
        ));
    }
    None
}

fn java_pid_uses_jar(pid: u32, jar_path: &Path) -> bool {
    let system = System::new_all();
    let Some(process) = system.process(Pid::from_u32(pid)) else {
        return false;
    };
    process
        .cmd()
        .iter()
        .any(|arg| jar_arg_matches_path(&arg.to_string_lossy(), jar_path))
}

fn jar_arg_matches_path(raw_arg: &str, jar_path: &Path) -> bool {
    let arg = raw_arg.trim().trim_matches('"');
    if arg.is_empty() {
        return false;
    }

    let expected = comparable_path(jar_path);
    let arg_path = strip_unc(PathBuf::from(arg));
    comparable_path(&arg_path) == expected
}

fn comparable_path(path: &Path) -> String {
    let normalized = std::fs::canonicalize(path).unwrap_or_else(|_| strip_unc(path.to_path_buf()));
    let value = normalized.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        value.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}

fn allowed_status(
    mode: SuwayomiRuntimeMode,
    server_url: String,
    profile_id: Option<String>,
    root_dir: Option<String>,
    jar_path: PathBuf,
) -> SuwayomiRuntimeStatus {
    let jar_version = read_suwayomi_jar_version(&jar_path);
    SuwayomiRuntimeStatus {
        mode,
        version: jar_version
            .as_ref()
            .and_then(|version| version.version.clone()),
        jar_version,
        jar_path: Some(path_to_string(&jar_path)),
        profile_id,
        root_dir,
        server_url,
        update_allowed: true,
        block_reason: None,
    }
}

fn blocked_status(
    mode: SuwayomiRuntimeMode,
    server_url: String,
    profile_id: Option<String>,
    root_dir: Option<String>,
    jar_path: Option<PathBuf>,
    jar_version: Option<SuwayomiJarVersion>,
    block_reason: &str,
) -> SuwayomiRuntimeStatus {
    let jar_version = jar_version.or_else(|| {
        jar_path
            .as_ref()
            .and_then(|path| read_suwayomi_jar_version(path))
    });
    SuwayomiRuntimeStatus {
        mode,
        version: jar_version
            .as_ref()
            .and_then(|version| version.version.clone()),
        jar_version,
        jar_path: jar_path.as_ref().map(|path| path_to_string(path)),
        profile_id,
        root_dir,
        server_url,
        update_allowed: false,
        block_reason: Some(block_reason.to_string()),
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn read_suwayomi_jar_version(path: &Path) -> Option<SuwayomiJarVersion> {
    read_manifest_version(path).or_else(|| read_build_config_version(path))
}

fn read_manifest_version(path: &Path) -> Option<SuwayomiJarVersion> {
    let mut archive = zip::ZipArchive::new(File::open(path).ok()?).ok()?;
    let mut manifest = String::new();
    archive
        .by_name("META-INF/MANIFEST.MF")
        .ok()?
        .read_to_string(&mut manifest)
        .ok()?;
    parse_manifest_version(&manifest)
}

fn read_build_config_version(path: &Path) -> Option<SuwayomiJarVersion> {
    let mut archive = zip::ZipArchive::new(File::open(path).ok()?).ok()?;
    let mut bytes = Vec::new();
    archive
        .by_name("suwayomi/tachidesk/server/generated/BuildConfig.class")
        .ok()?
        .read_to_end(&mut bytes)
        .ok()?;
    parse_build_config_constants(&bytes)
}

fn parse_manifest_version(manifest: &str) -> Option<SuwayomiJarVersion> {
    let version = manifest_value(manifest, "Specification-Version")
        .or_else(|| manifest_value(manifest, "Implementation-Version"));
    let revision = manifest_value(manifest, "Implementation-Version");
    if version.is_none() && revision.is_none() {
        return None;
    }
    Some(SuwayomiJarVersion {
        version,
        revision,
        build_type: manifest_value(manifest, "Build-Type"),
        webui_tag: manifest_value(manifest, "WebUI-Tag"),
    })
}

fn manifest_value(manifest: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    manifest.lines().find_map(|line| {
        let (line_key, value) = line.split_once(':')?;
        if line_key.trim() != key || !line.trim_start().starts_with(&prefix) {
            return None;
        }
        let value = value.trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

fn parse_build_config_constants(bytes: &[u8]) -> Option<SuwayomiJarVersion> {
    let constants = class_utf8_constants(bytes);
    let version = constants
        .iter()
        .find(|value| looks_like_suwayomi_version(value))
        .cloned();
    let revision = constants
        .iter()
        .find(|value| looks_like_suwayomi_revision(value))
        .cloned();
    if version.is_none() && revision.is_none() {
        return None;
    }
    Some(SuwayomiJarVersion {
        version,
        revision,
        build_type: constants
            .iter()
            .find(|value| matches!(value.as_str(), "Stable" | "Preview" | "Debug"))
            .cloned(),
        webui_tag: constants
            .iter()
            .filter(|value| looks_like_suwayomi_revision(value))
            .nth(1)
            .cloned(),
    })
}

fn looks_like_suwayomi_version(value: &str) -> bool {
    let trimmed = value.trim_start_matches('v');
    let parts: Vec<&str> = trimmed.split('.').collect();
    parts.len() >= 3
        && parts
            .iter()
            .take(3)
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}

fn looks_like_suwayomi_revision(value: &str) -> bool {
    value
        .strip_prefix('r')
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit()))
}

fn class_utf8_constants(bytes: &[u8]) -> Vec<String> {
    if bytes.len() < 10 || &bytes[0..4] != b"\xCA\xFE\xBA\xBE" {
        return Vec::new();
    }
    let constant_pool_count = read_u16(bytes, 8).unwrap_or(0) as usize;
    let mut offset = 10usize;
    let mut constants = Vec::new();
    let mut index = 1usize;

    while index < constant_pool_count && offset < bytes.len() {
        let tag = bytes[offset];
        offset += 1;
        match tag {
            1 => {
                let Some(len) = read_u16(bytes, offset).map(usize::from) else {
                    break;
                };
                offset += 2;
                if offset + len > bytes.len() {
                    break;
                }
                if let Ok(value) = std::str::from_utf8(&bytes[offset..offset + len]) {
                    constants.push(value.to_string());
                }
                offset += len;
            }
            3 | 4 => offset += 4,
            5 | 6 => {
                offset += 8;
                index += 1;
            }
            7 | 8 | 16 | 19 | 20 => offset += 2,
            9 | 10 | 11 | 12 | 18 | 17 => offset += 4,
            15 => offset += 3,
            _ => break,
        }
        index += 1;
    }

    constants
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let slice = bytes.get(offset..offset + 2)?;
    Some(u16::from_be_bytes([slice[0], slice[1]]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error as IoError, ErrorKind};
    use std::sync::Mutex as StdMutex;
    use zip::write::SimpleFileOptions;

    static UPDATE_LOCK_TEST_MUTEX: StdMutex<()> = StdMutex::new(());

    fn test_manifest() -> SuwayomiCompatibilityManifest {
        serde_json::from_str(SUWAYOMI_COMPATIBILITY_MANIFEST).unwrap()
    }

    fn test_manifest_with_allowed_update() -> SuwayomiCompatibilityManifest {
        let mut manifest = test_manifest();
        manifest.max_tested_version = "v2.2.2100".to_string();
        manifest
            .blocked_versions
            .retain(|blocked| blocked.version != "v2.2.2100");
        manifest.allowed_versions.push(SuwayomiAllowedVersion {
            version: "v2.2.2100".to_string(),
            asset: "Suwayomi-Server-v2.2.2100.jar".to_string(),
            sha256: "a".repeat(64),
            compatibility_profile: SuwayomiCompatibilityProfile::V21,
            transactional_extension_updates: false,
            notes: Some("Test-only allowed Suwayomi 2.2 release.".to_string()),
        });
        manifest
    }

    fn release(tag: &str, prerelease: bool, assets: &[&str]) -> GithubRelease {
        release_with_draft(tag, false, prerelease, assets)
    }

    fn release_with_draft(
        tag: &str,
        draft: bool,
        prerelease: bool,
        assets: &[&str],
    ) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_string(),
            html_url: format!("https://github.com/Suwayomi/Suwayomi-Server/releases/tag/{tag}"),
            draft,
            prerelease,
            body: Some(format!("Release notes for {tag}.")),
            assets: assets
                .iter()
                .map(|name| GithubReleaseAsset {
                    name: name.to_string(),
                    browser_download_url: format!(
                        "https://github.com/Suwayomi/Suwayomi-Server/releases/download/{tag}/{name}"
                    ),
                    size: Some(1024),
                })
                .collect(),
        }
    }

    fn runtime(version: Option<&str>, update_allowed: bool) -> SuwayomiRuntimeStatus {
        SuwayomiRuntimeStatus {
            mode: if update_allowed {
                SuwayomiRuntimeMode::ManagedBundled
            } else {
                SuwayomiRuntimeMode::External
            },
            version: version.map(str::to_string),
            jar_version: None,
            jar_path: None,
            profile_id: Some("main".to_string()),
            root_dir: Some("C:/epigraph-main".to_string()),
            server_url: "http://127.0.0.1:4567".to_string(),
            update_allowed,
            block_reason: None,
        }
    }

    #[test]
    fn parses_manifest_version_fields() {
        let parsed = parse_manifest_version(
            "Manifest-Version: 1.0\n\
             Specification-Version: v2.1.1867\n\
             Implementation-Version: r1867\n",
        )
        .unwrap();

        assert_eq!(parsed.version.as_deref(), Some("v2.1.1867"));
        assert_eq!(parsed.revision.as_deref(), Some("r1867"));
    }

    #[test]
    fn rejects_manifest_without_version() {
        assert_eq!(parse_manifest_version("Manifest-Version: 1.0\n"), None);
    }

    #[test]
    fn detects_version_and_revision_shapes() {
        assert!(looks_like_suwayomi_version("v2.2.2100"));
        assert!(looks_like_suwayomi_version("2.2.2100"));
        assert!(!looks_like_suwayomi_version("v2.2"));
        assert!(looks_like_suwayomi_revision("r2100"));
        assert!(!looks_like_suwayomi_revision("release-2100"));
    }

    #[test]
    fn effective_managed_jar_requires_process_match() {
        let runtime = PathBuf::from("C:/epigraph/runtime/current/Suwayomi-Server.jar");
        let bundled =
            PathBuf::from("C:/epigraph/resources/binaries/suwayomi-bundle/bin/Suwayomi-Server.jar");

        assert_eq!(
            select_effective_managed_jar(&runtime, &bundled, |_| true),
            None
        );
    }

    #[test]
    fn effective_managed_jar_prefers_actual_process_jar() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime").join(SUWAYOMI_SERVER_JAR);
        let bundled = temp
            .path()
            .join("binaries")
            .join("suwayomi-bundle")
            .join("bin")
            .join(SUWAYOMI_SERVER_JAR);
        std::fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&runtime, b"runtime").unwrap();
        std::fs::write(&bundled, b"bundled").unwrap();

        let selected = select_effective_managed_jar(&runtime, &bundled, |path| path == bundled)
            .expect("bundled jar should be selected");

        assert_eq!(selected.0, SuwayomiRuntimeMode::ManagedBundled);
        assert_eq!(selected.1, bundled);
    }

    #[test]
    fn jar_path_comparison_normalizes_slashes() {
        let path = PathBuf::from("C:/epigraph/Suwayomi-Server.jar");
        assert!(jar_arg_matches_path(
            "C:\\epigraph\\Suwayomi-Server.jar",
            &path
        ));
    }

    #[test]
    fn compatibility_manifest_parses_allowed_and_blocked_versions() {
        let manifest = test_manifest();

        assert_eq!(manifest.repository, "Suwayomi/Suwayomi-Server");
        let baseline = manifest.allowed_version("v2.1.1867").unwrap();
        assert_eq!(
            baseline.compatibility_profile,
            SuwayomiCompatibilityProfile::V21
        );
        assert!(!baseline.transactional_extension_updates);
        let modern = manifest.allowed_version("v2.3.2243").unwrap();
        assert_eq!(
            modern.compatibility_profile,
            SuwayomiCompatibilityProfile::V23
        );
        assert!(modern.transactional_extension_updates);
        assert!(manifest.blocked_reason("v2.0.1727").is_some());
        assert!(manifest.blocked_reason("v2.2.2100").is_some());
    }

    #[test]
    fn manifest_validation_rejects_invalid_range_and_incomplete_allowlist() {
        let mut invalid_range = test_manifest();
        invalid_range.min_supported_version = "v2.3.0".to_string();
        invalid_range.max_tested_version = "v2.2.0".to_string();
        assert!(validate_compatibility_manifest(invalid_range).is_err());

        let mut incomplete = test_manifest();
        incomplete.allowed_versions[0].asset = String::new();
        assert!(validate_compatibility_manifest(incomplete).is_err());

        let mut invalid_hash = test_manifest();
        invalid_hash.allowed_versions[0].sha256 = "not-a-sha256".to_string();
        assert!(validate_compatibility_manifest(invalid_hash).is_err());

        let mut incompatible_capability = test_manifest();
        incompatible_capability.allowed_versions[0].transactional_extension_updates = true;
        assert!(validate_compatibility_manifest(incompatible_capability).is_err());
    }

    #[test]
    fn certified_checksum_must_match_the_published_release_checksum() {
        let manifest = test_manifest_with_allowed_update();
        let asset = "Suwayomi-Server-v2.2.2100.jar";

        assert_eq!(
            certified_release_checksum(&manifest, "v2.2.2100", asset, &"A".repeat(64)).unwrap(),
            "a".repeat(64),
        );
        assert!(
            certified_release_checksum(&manifest, "v2.2.2100", asset, &"b".repeat(64),).is_err()
        );
    }

    #[test]
    fn compatible_release_requires_allowlist_asset_and_checksum() {
        let manifest = test_manifest_with_allowed_update();
        let allowed = release(
            "v2.2.2100",
            false,
            &["Suwayomi-Server-v2.2.2100.jar", "Checksums.sha256"],
        );
        let missing_checksum = release("v2.2.2100", false, &["Suwayomi-Server-v2.2.2100.jar"]);
        let outside_allowlist = release(
            "v9.9.9999",
            false,
            &["Suwayomi-Server-v9.9.9999.jar", "Checksums.sha256"],
        );

        assert!(compatible_release(&manifest, &allowed).is_some());
        assert!(compatible_release(&manifest, &missing_checksum).is_none());
        assert!(compatible_release(&manifest, &outside_allowlist).is_none());
    }

    #[test]
    fn compatible_release_ignores_draft() {
        let manifest = test_manifest_with_allowed_update();
        let draft = release_with_draft(
            "v2.2.2100",
            true,
            false,
            &["Suwayomi-Server-v2.2.2100.jar", "Checksums.sha256"],
        );

        assert!(compatible_release(&manifest, &draft).is_none());
    }

    #[test]
    fn compatible_release_ignores_prerelease() {
        let manifest = test_manifest_with_allowed_update();
        let preview = release(
            "v2.2.2100",
            true,
            &["Suwayomi-Server-v2.2.2100.jar", "Checksums.sha256"],
        );

        assert!(compatible_release(&manifest, &preview).is_none());
    }

    #[test]
    fn compatible_release_respects_blocklist_before_allowlist() {
        let mut manifest = test_manifest_with_allowed_update();
        manifest.blocked_versions.push(SuwayomiBlockedVersion {
            version: "v2.2.2100".to_string(),
            reason: "test block".to_string(),
        });
        let blocked = release(
            "v2.2.2100",
            false,
            &["Suwayomi-Server-v2.2.2100.jar", "Checksums.sha256"],
        );

        assert!(compatible_release(&manifest, &blocked).is_none());
    }

    #[test]
    fn compatible_release_respects_manifest_tested_range() {
        let mut manifest = test_manifest_with_allowed_update();
        manifest.max_tested_version = "v2.1.1867".to_string();
        let above_max = release(
            "v2.2.2100",
            false,
            &["Suwayomi-Server-v2.2.2100.jar", "Checksums.sha256"],
        );

        assert!(compatible_release(&manifest, &above_max).is_none());
    }

    #[test]
    fn update_check_reports_update_available_from_allowlist() {
        let manifest = test_manifest_with_allowed_update();
        let releases = vec![
            release(
                "v2.2.2100",
                false,
                &["Suwayomi-Server-v2.2.2100.jar", "Checksums.sha256"],
            ),
            release(
                "v2.1.1867",
                false,
                &["Suwayomi-Server-v2.1.1867.jar", "Checksums.sha256"],
            ),
        ];

        let result =
            calculate_update_check(&runtime(Some("v2.1.1867"), true), &manifest, &releases);

        assert_eq!(result.status, UpdateCheckStatus::UpdateAvailable);
        assert_eq!(
            result.latest_compatible_version.as_deref(),
            Some("v2.2.2100")
        );
        assert!(result.update_allowed);
    }

    #[test]
    fn update_check_reports_up_to_date_for_latest_allowed_release() {
        let manifest = test_manifest();
        let releases = vec![release(
            "v2.1.1867",
            false,
            &["Suwayomi-Server-v2.1.1867.jar", "Checksums.sha256"],
        )];

        let result =
            calculate_update_check(&runtime(Some("v2.1.1867"), true), &manifest, &releases);

        assert_eq!(result.status, UpdateCheckStatus::UpToDate);
        assert!(!result.update_allowed);
    }

    #[test]
    fn update_check_blocks_when_current_version_is_unknown() {
        let manifest = test_manifest();
        let releases = vec![release(
            "v2.2.2100",
            false,
            &["Suwayomi-Server-v2.2.2100.jar", "Checksums.sha256"],
        )];

        let result = calculate_update_check(&runtime(None, true), &manifest, &releases);

        assert_eq!(result.status, UpdateCheckStatus::Blocked);
        assert!(!result.update_allowed);
    }

    #[test]
    fn manifest_preflight_blocks_below_minimum() {
        let manifest = test_manifest();
        let result = manifest_preflight_block(&runtime(Some("v2.0.1727"), true), &manifest)
            .expect("blocked version should be rejected");

        assert_eq!(result.status, UpdateCheckStatus::Blocked);
        assert!(!result.update_allowed);
    }

    #[test]
    fn manifest_preflight_blocks_above_maximum() {
        let manifest = test_manifest();
        let result = manifest_preflight_block(&runtime(Some("v2.4.0"), true), &manifest)
            .expect("above max tested version should be rejected");

        assert_eq!(result.status, UpdateCheckStatus::Blocked);
        assert!(!result.update_allowed);
    }

    #[test]
    fn non_managed_runtime_preflight_blocks_without_release_lookup() {
        for mode in [
            SuwayomiRuntimeMode::External,
            SuwayomiRuntimeMode::ManagedUserBinary,
            SuwayomiRuntimeMode::Unknown,
        ] {
            let mut runtime = runtime(Some("v2.1.1867"), false);
            runtime.mode = mode;
            runtime.block_reason = Some("not managed".to_string());

            let result = runtime_update_preflight_block(&runtime)
                .expect("non-managed runtime should block before GitHub");

            assert_eq!(result.status, UpdateCheckStatus::Blocked);
            assert!(!result.update_allowed);
        }
    }

    #[test]
    fn github_release_json_errors_are_check_failures() {
        let error = parse_github_releases("{not-json").unwrap_err();
        let result = failed_update_check(Some("v2.1.1867".to_string()), error);

        assert_eq!(result.status, UpdateCheckStatus::CheckFailed);
        assert!(!result.update_allowed);
    }

    #[test]
    fn update_errors_are_categorized_once() {
        assert_eq!(
            update_error(SuwayomiUpdateErrorKind::DownloadError, "network failed"),
            "DownloadError: network failed"
        );
        assert_eq!(
            update_error(
                SuwayomiUpdateErrorKind::DownloadError,
                "DownloadError: network failed"
            ),
            "DownloadError: network failed"
        );
    }

    #[test]
    fn version_comparison_is_numeric() {
        assert_eq!(
            compare_versions("v2.9.0", "v2.10.0"),
            Some(std::cmp::Ordering::Less)
        );
        assert_eq!(
            compare_versions("v2.10.9", "v2.10.10"),
            Some(std::cmp::Ordering::Less)
        );
        assert_eq!(
            compare_versions("v2.1.1867", "v2.2.2100"),
            Some(std::cmp::Ordering::Less)
        );
    }

    #[test]
    fn graphql_health_payload_accepts_expected_shapes() {
        assert!(validate_graphql_health_payload(
            &serde_json::json!({ "data": { "__typename": "Query" } }),
            "typename"
        )
        .is_ok());
        assert!(validate_graphql_health_payload(
            &serde_json::json!({ "data": { "library": { "nodes": [] } } }),
            "library"
        )
        .is_ok());
        assert!(validate_graphql_health_payload(
            &serde_json::json!({ "data": { "sources": { "nodes": [{ "id": "1", "displayName": "MangaDex" }] } } }),
            "sources"
        )
        .is_ok());
        assert!(validate_graphql_health_payload(
            &serde_json::json!({ "data": { "extensions": { "nodes": [{ "pkgName": "pkg", "isInstalled": true }] } } }),
            "extensions"
        )
        .is_ok());
    }

    #[test]
    fn graphql_health_payload_rejects_errors_and_missing_connections() {
        let error = validate_graphql_health_payload(
            &serde_json::json!({ "errors": [{ "message": "database unavailable" }], "data": null }),
            "sources",
        )
        .unwrap_err();
        assert!(error.contains("database unavailable"));

        let missing_sources = validate_graphql_health_payload(
            &serde_json::json!({ "data": { "sources": null } }),
            "sources",
        )
        .unwrap_err();
        assert!(missing_sources.contains("nodes array"));

        let missing_library = validate_graphql_health_payload(
            &serde_json::json!({ "data": { "library": { "totalCount": 1 } } }),
            "library",
        )
        .unwrap_err();
        assert!(missing_library.contains("nodes array"));
    }

    #[test]
    fn health_diagnostic_report_writer_keeps_structured_internal_details() {
        let temp = tempfile::tempdir().unwrap();
        let report = SuwayomiHealthDiagnosticReport {
            schema_version: 1,
            target_version: "v2.2.2100".to_string(),
            endpoint: "http://127.0.0.1:4567/api/graphql".to_string(),
            started_at_ms: 123,
            elapsed_ms: 456,
            max_wait_ms: SUWAYOMI_HEALTH_MAX_WAIT_MS,
            timeout_secs: SUWAYOMI_HEALTH_TIMEOUT_SECS,
            delay_ms: SUWAYOMI_HEALTH_DELAY_MS,
            attempts: 1,
            last_error: "Sources health check failed.".to_string(),
            checks: vec![
                SuwayomiHealthDiagnosticCheck {
                    attempt: 1,
                    check: "typename".to_string(),
                    ok: true,
                    duration_ms: 10,
                    error: None,
                },
                SuwayomiHealthDiagnosticCheck {
                    attempt: 1,
                    check: "sources".to_string(),
                    ok: false,
                    duration_ms: 12,
                    error: Some("database unavailable".to_string()),
                },
            ],
        };

        let path = write_suwayomi_health_diagnostic_report_to_dir(temp.path(), &report).unwrap();
        let text = std::fs::read_to_string(path).unwrap();

        assert!(text.contains("\"targetVersion\": \"v2.2.2100\""));
        assert!(text.contains("\"check\": \"sources\""));
        assert!(text.contains("database unavailable"));
        assert!(!text.contains("Authorization"));
    }

    #[test]
    fn cached_releases_expire_after_ttl() {
        let now = Instant::now();
        store_cached_suwayomi_releases(
            now,
            vec![release(
                "v2.2.2100",
                false,
                &["Suwayomi-Server-v2.2.2100.jar", "Checksums.sha256"],
            )],
        );

        assert!(cached_suwayomi_releases(now + Duration::from_secs(30)).is_some());
        assert!(cached_suwayomi_releases(now + Duration::from_secs(61)).is_none());
    }

    fn write_root_file(root: &Path, name: &str, content: &[u8]) {
        std::fs::write(root.join(name), content).unwrap();
    }

    fn read_snapshot_manifest(snapshot: &SuwayomiUpdateSnapshotResult) -> SuwayomiSnapshotManifest {
        let text = std::fs::read_to_string(&snapshot.manifest_path).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    fn create_test_jar_bytes(version: &str) -> Vec<u8> {
        let temp = tempfile::NamedTempFile::new().unwrap();
        {
            let file = File::create(temp.path()).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = SimpleFileOptions::default();
            zip.start_file("META-INF/MANIFEST.MF", options).unwrap();
            zip.write_all(
                format!(
                    "Manifest-Version: 1.0\nSpecification-Version: {version}\nImplementation-Version: r2100\n"
                )
                .as_bytes(),
            )
            .unwrap();
            zip.finish().unwrap();
        }
        std::fs::read(temp.path()).unwrap()
    }

    fn staging_candidate(version: &str) -> StagingCandidate {
        StagingCandidate {
            version: version.to_string(),
            asset_name: format!("Suwayomi-Server-{version}.jar"),
            checksum_asset: "Checksums.sha256".to_string(),
            release_tag: version.to_string(),
            release_url: format!(
                "https://github.com/Suwayomi/Suwayomi-Server/releases/tag/{version}"
            ),
            jar_url: format!(
                "https://github.com/Suwayomi/Suwayomi-Server/releases/download/{version}/Suwayomi-Server-{version}.jar"
            ),
            checksum_url: format!(
                "https://github.com/Suwayomi/Suwayomi-Server/releases/download/{version}/Checksums.sha256"
            ),
        }
    }

    struct FailingReader {
        emitted: bool,
    }

    impl Read for FailingReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.emitted {
                Err(IoError::new(ErrorKind::Interrupted, "stream interrupted"))
            } else {
                self.emitted = true;
                buffer[..4].copy_from_slice(b"part");
                Ok(4)
            }
        }
    }

    #[test]
    fn snapshot_is_created_with_allowlisted_files() {
        let temp = tempfile::tempdir().unwrap();
        write_root_file(temp.path(), "server.conf", b"server");
        write_root_file(temp.path(), "database.mv.db", b"db");
        std::fs::create_dir_all(temp.path().join("extensions").join("installed")).unwrap();
        std::fs::write(
            temp.path()
                .join("extensions")
                .join("installed")
                .join("source.jar"),
            b"extension",
        )
        .unwrap();
        std::fs::create_dir_all(temp.path().join("settings")).unwrap();
        std::fs::write(
            temp.path().join("settings").join("source.json"),
            b"settings",
        )
        .unwrap();

        let snapshot = create_snapshot_for_root(temp.path()).unwrap();

        assert!(Path::new(&snapshot.snapshot_path).is_dir());
        assert!(Path::new(&snapshot.manifest_path).is_file());
        assert_eq!(
            snapshot.copied_files,
            vec![
                "database.mv.db",
                "extensions/installed/source.jar",
                "server.conf",
                "settings/source.json",
            ]
        );
        assert!(Path::new(&snapshot.snapshot_path)
            .join("server.conf")
            .is_file());
        assert!(Path::new(&snapshot.snapshot_path)
            .join("database.mv.db")
            .is_file());
        let manifest = read_snapshot_manifest(&snapshot);
        assert_eq!(manifest.schema_version, 2);
        assert_eq!(manifest.snapshot_version, SUWAYOMI_SNAPSHOT_VERSION);
        assert_eq!(manifest.runtime_mode, SuwayomiRuntimeMode::Unknown);
        assert_eq!(manifest.files.len(), 4);
        assert!(manifest.files.iter().all(|file| file.sha256.len() == 64));
    }

    #[test]
    fn database_lock_probe_accepts_quiescent_profile() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("database.mv.db"), b"h2").unwrap();
        assert!(assert_profile_database_unlocked(temp.path()).is_ok());
    }

    #[test]
    fn local_port_probe_requires_the_listener_to_be_released() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(assert_local_port_released(port).is_err());
        drop(listener);
        assert!(assert_local_port_released(port).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn database_lock_probe_rejects_an_open_database_handle() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("database.mv.db");
        std::fs::write(&path, b"h2").unwrap();
        let _open = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert!(assert_profile_database_unlocked(temp.path()).is_err());
    }

    #[test]
    fn snapshot_skips_owner_file_removed_after_planning() {
        let temp = tempfile::tempdir().unwrap();
        write_root_file(temp.path(), "server.conf", b"server");
        write_root_file(temp.path(), SUWAYOMI_SERVER_OWNER_FILE, b"owner");
        let plan = plan_snapshot_files(temp.path()).unwrap();

        std::fs::remove_file(temp.path().join(SUWAYOMI_SERVER_OWNER_FILE)).unwrap();
        let snapshot_dir = temp.path().join("snapshot");
        std::fs::create_dir(&snapshot_dir).unwrap();
        let files = copy_snapshot_plan(&plan, &snapshot_dir).unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "server.conf");
        assert!(snapshot_dir.join("server.conf").is_file());
        assert!(!snapshot_dir.join(SUWAYOMI_SERVER_OWNER_FILE).exists());
    }

    #[test]
    fn snapshot_rejects_missing_root_directory() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing");

        let error = create_snapshot_for_root(&missing).unwrap_err();

        assert!(error.contains("root directory does not exist"));
    }

    #[test]
    fn snapshot_rejects_incomplete_allowlist_entry_and_removes_temp() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("database.mv.db")).unwrap();

        let error = create_snapshot_for_root(temp.path()).unwrap_err();

        assert!(error.contains("not a file"));
        let snapshots_dir = temp.path().join(SUWAYOMI_SNAPSHOT_DIR);
        if snapshots_dir.exists() {
            let tmp_leftovers = std::fs::read_dir(snapshots_dir)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().starts_with(".tmp-"))
                .count();
            assert_eq!(tmp_leftovers, 0);
        }
    }

    #[test]
    fn snapshot_fails_when_no_allowlisted_files_exist() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("downloads")).unwrap();

        let error = create_snapshot_for_root(temp.path()).unwrap_err();

        assert!(error.contains("No allowlisted"));
    }

    #[test]
    fn snapshot_never_copies_downloads_or_cache() {
        let temp = tempfile::tempdir().unwrap();
        write_root_file(temp.path(), "server.conf", b"server");
        std::fs::create_dir(temp.path().join("downloads")).unwrap();
        std::fs::write(
            temp.path().join("downloads").join("chapter.cbz"),
            b"chapter",
        )
        .unwrap();
        std::fs::create_dir(temp.path().join("library-cover-cache")).unwrap();
        std::fs::write(
            temp.path().join("library-cover-cache").join("cover.jpg"),
            b"cover",
        )
        .unwrap();

        let snapshot = create_snapshot_for_root(temp.path()).unwrap();
        let snapshot_path = Path::new(&snapshot.snapshot_path);

        assert!(snapshot_path.join("server.conf").is_file());
        assert!(!snapshot_path.join("downloads").exists());
        assert!(!snapshot_path.join("library-cover-cache").exists());
    }

    #[test]
    fn snapshot_rejects_symlinks_in_recursive_allowlist() {
        let temp = tempfile::tempdir().unwrap();
        write_root_file(temp.path(), "server.conf", b"server");
        std::fs::create_dir_all(temp.path().join("extensions")).unwrap();

        #[cfg(windows)]
        {
            let outside = temp.path().join("outside.jar");
            std::fs::write(&outside, b"outside").unwrap();
            if std::os::windows::fs::symlink_file(
                &outside,
                temp.path().join("extensions").join("linked.jar"),
            )
            .is_ok()
            {
                let error = plan_snapshot_files(temp.path()).unwrap_err();
                assert!(error.contains("symbolic link"));
            }
        }
    }

    #[test]
    fn snapshot_supports_multiple_consecutive_snapshots() {
        let temp = tempfile::tempdir().unwrap();
        write_root_file(temp.path(), "server.conf", b"server");

        let first = create_snapshot_for_root(temp.path()).unwrap();
        let second = create_snapshot_for_root(temp.path()).unwrap();

        assert_ne!(first.snapshot_path, second.snapshot_path);
        assert!(Path::new(&first.manifest_path).is_file());
        assert!(Path::new(&second.manifest_path).is_file());
    }

    #[test]
    fn snapshot_disk_space_check_fails_before_copy() {
        let temp = tempfile::tempdir().unwrap();
        write_root_file(temp.path(), "server.conf", b"server");
        let plan = plan_snapshot_files(temp.path()).unwrap();

        let error = ensure_required_space(temp.path(), 1024 * 1024, Some(10)).unwrap_err();

        assert!(error.contains("Not enough disk space"));
        assert_eq!(plan.len(), 1);
        assert!(!temp.path().join(SUWAYOMI_SNAPSHOT_DIR).exists());
    }

    #[test]
    fn snapshot_validation_rejects_hash_mismatch() {
        let temp = tempfile::tempdir().unwrap();
        write_root_file(temp.path(), "server.conf", b"server");
        let plan = plan_snapshot_files(temp.path()).unwrap();
        let snapshot_dir = temp.path().join("snapshot");
        std::fs::create_dir(&snapshot_dir).unwrap();
        let mut files = copy_snapshot_plan(&plan, &snapshot_dir).unwrap();
        std::fs::write(snapshot_dir.join("server.conf"), b"SERVER").unwrap();

        let error = validate_snapshot_files(&snapshot_dir, &files).unwrap_err();

        assert!(error.contains("SHA-256"));
        files[0].sha256 = sha256_file(&snapshot_dir.join("server.conf")).unwrap();
        assert!(validate_snapshot_files(&snapshot_dir, &files).is_ok());
    }

    #[test]
    fn snapshot_finalize_rejects_existing_final_directory() {
        let temp = tempfile::tempdir().unwrap();
        let tmp = temp.path().join(".tmp");
        let final_dir = temp.path().join("final");
        std::fs::create_dir(&tmp).unwrap();
        std::fs::create_dir(&final_dir).unwrap();

        let error = finalize_snapshot_directory(&tmp, &final_dir).unwrap_err();

        assert!(error.contains("already exists"));
        assert!(tmp.exists());
    }

    #[test]
    fn snapshot_failure_releases_update_lock() {
        let _serial = UPDATE_LOCK_TEST_MUTEX.lock().unwrap();
        clear_update_lock_for_tests();
        let temp = tempfile::tempdir().unwrap();

        let result: Result<(), String> = (|| {
            let _guard = try_acquire_suwayomi_update_lock("snapshot-test")?;
            create_snapshot_for_root(temp.path().join("missing").as_path()).map(|_| ())
        })();

        assert!(result.is_err());
        assert!(!current_suwayomi_update_lock_status().in_progress);
    }

    #[test]
    fn restart_hook_runs_after_snapshot_failure_when_runtime_was_stopped() {
        let mut restarted = false;

        let result = restart_runtime_after_snapshot_failure(true, || {
            restarted = true;
            Ok(())
        });

        assert_eq!(result, Ok(true));
        assert!(restarted);
    }

    #[test]
    fn restart_hook_is_skipped_when_runtime_was_not_stopped() {
        let mut restarted = false;

        let result = restart_runtime_after_snapshot_failure(false, || {
            restarted = true;
            Ok(())
        });

        assert_eq!(result, Ok(false));
        assert!(!restarted);
    }

    #[test]
    fn restart_hook_reports_restart_failure() {
        let result =
            restart_runtime_after_snapshot_failure(true, || Err("restart failed".to_string()));

        assert_eq!(result, Err("restart failed".to_string()));
    }

    #[test]
    fn checksum_parser_finds_expected_asset() {
        let hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let checksums = format!("{hash}  Suwayomi-Server-v2.2.2100.jar\n");

        let parsed = checksum_for_asset(&checksums, "Suwayomi-Server-v2.2.2100.jar").unwrap();

        assert_eq!(parsed, hash);
    }

    #[test]
    fn checksum_parser_rejects_missing_asset() {
        let hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let checksums = format!("{hash}  Other.jar\n");

        let error = checksum_for_asset(&checksums, "Suwayomi-Server-v2.2.2100.jar").unwrap_err();

        assert!(error.contains("does not contain"));
    }

    #[test]
    fn staging_rejects_version_outside_allowlist() {
        let manifest = test_manifest();
        let candidate = staging_candidate("v9.9.9999");

        let error = validate_staging_candidate(&candidate, &manifest).unwrap_err();

        assert!(error.contains("allowlist"));
    }

    #[test]
    fn staging_rejects_unexpected_asset() {
        let manifest = test_manifest_with_allowed_update();
        let mut candidate = staging_candidate("v2.2.2100");
        candidate.asset_name = "Unexpected.jar".to_string();

        let error = validate_staging_candidate(&candidate, &manifest).unwrap_err();

        assert!(error.contains("asset"));
    }

    #[test]
    fn staging_rejects_invalid_checksum_and_cleans_temp() {
        let temp = tempfile::tempdir().unwrap();
        let manifest = test_manifest_with_allowed_update();
        let candidate = staging_candidate("v2.2.2100");
        let jar = create_test_jar_bytes("v2.2.2100");
        let bad_hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        let error = stage_downloaded_jar(temp.path(), &candidate, &manifest, &jar, bad_hash, 1)
            .unwrap_err();

        assert!(error.contains("SHA-256"));
        let tmp_leftovers = std::fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".tmp-"))
            .count();
        assert_eq!(tmp_leftovers, 0);
    }

    #[test]
    fn staging_cleans_part_after_interrupted_stream() {
        let temp = tempfile::tempdir().unwrap();
        let manifest = test_manifest_with_allowed_update();
        let candidate = staging_candidate("v2.2.2100");
        let hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        let error = stage_downloaded_jar_from_reader(
            temp.path(),
            &candidate,
            &manifest,
            FailingReader { emitted: false },
            hash,
            1,
        )
        .unwrap_err();

        assert!(error.contains("interrupted"));
        let leftovers = std::fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().to_string_lossy().contains(".part"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn staging_rejects_unreadable_jar_and_cleans_temp() {
        let temp = tempfile::tempdir().unwrap();
        let manifest = test_manifest_with_allowed_update();
        let candidate = staging_candidate("v2.2.2100");
        let jar = b"not a jar".to_vec();
        let hash = sha256_bytes(&jar);

        let error =
            stage_downloaded_jar(temp.path(), &candidate, &manifest, &jar, &hash, 1).unwrap_err();

        assert!(error.contains("not readable") || error.contains("missing its manifest"));
        let tmp_leftovers = std::fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".tmp-"))
            .count();
        assert_eq!(tmp_leftovers, 0);
    }

    #[test]
    fn staging_accepts_valid_jar_without_touching_current_or_previous() {
        let temp = tempfile::tempdir().unwrap();
        let manifest = test_manifest_with_allowed_update();
        let candidate = staging_candidate("v2.2.2100");
        let jar = create_test_jar_bytes("v2.2.2100");
        let hash = sha256_bytes(&jar);

        let result =
            stage_downloaded_jar(temp.path(), &candidate, &manifest, &jar, &hash, 1).unwrap();

        assert!(Path::new(&result.jar_path).is_file());
        assert_eq!(result.version, "v2.2.2100");
        assert_eq!(result.sha256, hash);
        assert!(!temp.path().join("current").exists());
        assert!(!temp.path().join("previous").exists());
        assert!(Path::new(&result.staging_path)
            .join(SUWAYOMI_STAGING_MANIFEST)
            .is_file());
    }

    #[test]
    fn staging_rejects_jar_version_mismatch() {
        let temp = tempfile::tempdir().unwrap();
        let manifest = test_manifest_with_allowed_update();
        let candidate = staging_candidate("v2.2.2100");
        let jar = create_test_jar_bytes("v2.1.1867");
        let hash = sha256_bytes(&jar);

        let error =
            stage_downloaded_jar(temp.path(), &candidate, &manifest, &jar, &hash, 1).unwrap_err();

        assert!(error.contains("does not match expected"));
        assert!(!temp.path().join("v2.2.2100").exists());
    }

    #[test]
    fn staging_lock_releases_after_error() {
        let _serial = UPDATE_LOCK_TEST_MUTEX.lock().unwrap();
        clear_update_lock_for_tests();
        let temp = tempfile::tempdir().unwrap();
        let manifest = test_manifest();
        let candidate = staging_candidate("v2.2.2100");
        let jar = create_test_jar_bytes("v2.2.2100");

        let result: Result<(), String> = (|| {
            let _guard = try_acquire_suwayomi_update_lock("staging-test")?;
            stage_downloaded_jar(temp.path(), &candidate, &manifest, &jar, "bad", 1).map(|_| ())
        })();

        assert!(result.is_err());
        assert!(!current_suwayomi_update_lock_status().in_progress);
    }

    fn write_runtime_marker(path: &Path, marker: &str) {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(path.join("marker.txt"), marker).unwrap();
    }

    fn read_runtime_marker(path: &Path) -> String {
        std::fs::read_to_string(path.join("marker.txt")).unwrap()
    }

    #[test]
    fn promotion_moves_current_to_previous_and_staging_to_current() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join(SUWAYOMI_CURRENT_DIR);
        let staging = temp.path().join(SUWAYOMI_STAGING_DIR).join("v2.2.2100");
        write_runtime_marker(&current, "old");
        write_runtime_marker(&staging, "new");

        let state = promote_staging_directories(temp.path(), "v2.2.2100").unwrap();

        assert_eq!(read_runtime_marker(&state.current_dir), "new");
        assert_eq!(
            read_runtime_marker(state.previous_dir.as_ref().unwrap()),
            "old"
        );
        assert!(!staging.exists());
    }

    #[test]
    fn promotion_without_existing_current_installs_staging_without_previous() {
        let temp = tempfile::tempdir().unwrap();
        let staging = temp.path().join(SUWAYOMI_STAGING_DIR).join("v2.2.2100");
        write_runtime_marker(&staging, "new");

        let state = promote_staging_directories(temp.path(), "v2.2.2100").unwrap();

        assert_eq!(read_runtime_marker(&state.current_dir), "new");
        assert!(!state.had_current);
        assert!(state.previous_dir.is_none());
        assert!(!temp.path().join(SUWAYOMI_PREVIOUS_DIR).exists());
    }

    #[test]
    fn promotion_preserves_previous_until_success() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join(SUWAYOMI_CURRENT_DIR);
        let previous = temp.path().join(SUWAYOMI_PREVIOUS_DIR);
        let staging = temp.path().join(SUWAYOMI_STAGING_DIR).join("v2.2.2100");
        write_runtime_marker(&current, "old-current");
        write_runtime_marker(&previous, "older-previous");
        write_runtime_marker(&staging, "new");

        let state = promote_staging_directories(temp.path(), "v2.2.2100").unwrap();

        assert_eq!(
            read_runtime_marker(state.previous_dir.as_ref().unwrap()),
            "old-current"
        );
        assert!(state.previous_backup_dir.as_ref().unwrap().exists());
        restore_previous_backup(
            state.previous_dir.as_ref().unwrap(),
            state.previous_backup_dir.as_ref(),
        );
        assert_eq!(
            read_runtime_marker(state.previous_backup_dir.as_ref().unwrap()),
            "older-previous"
        );
    }

    #[test]
    fn promotion_fails_when_current_is_not_directory() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join(SUWAYOMI_CURRENT_DIR), b"file").unwrap();
        let staging = temp.path().join(SUWAYOMI_STAGING_DIR).join("v2.2.2100");
        write_runtime_marker(&staging, "new");

        let error = promote_staging_directories(temp.path(), "v2.2.2100").unwrap_err();

        assert!(error.contains("not a directory"));
        assert!(staging.exists());
    }

    #[test]
    fn promotion_fails_when_staging_missing() {
        let temp = tempfile::tempdir().unwrap();

        let error = promote_staging_directories(temp.path(), "v2.2.2100").unwrap_err();

        assert!(error.contains("staging"));
    }

    #[test]
    fn rollback_restores_previous_as_current() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join(SUWAYOMI_CURRENT_DIR);
        let previous = temp.path().join(SUWAYOMI_PREVIOUS_DIR);
        write_runtime_marker(&current, "new");
        write_runtime_marker(&previous, "old");
        let state = RuntimePromotionState {
            current_dir: current.clone(),
            previous_dir: Some(previous.clone()),
            previous_backup_dir: None,
            staging_dir: temp.path().join(SUWAYOMI_STAGING_DIR).join("unused"),
            had_current: true,
        };

        rollback_promoted_directories(&state).unwrap();

        assert_eq!(read_runtime_marker(&current), "old");
        assert!(!previous.exists());
    }

    #[test]
    fn rollback_fails_when_previous_is_missing_for_existing_current() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join(SUWAYOMI_CURRENT_DIR);
        write_runtime_marker(&current, "new");
        let state = RuntimePromotionState {
            current_dir: current,
            previous_dir: Some(temp.path().join(SUWAYOMI_PREVIOUS_DIR)),
            previous_backup_dir: None,
            staging_dir: temp.path().join(SUWAYOMI_STAGING_DIR).join("unused"),
            had_current: true,
        };

        let error = rollback_promoted_directories(&state).unwrap_err();

        assert!(error.contains("Previous Suwayomi runtime is missing"));
    }

    #[test]
    fn rollback_without_existing_current_removes_failed_current() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join(SUWAYOMI_CURRENT_DIR);
        write_runtime_marker(&current, "new");
        let state = RuntimePromotionState {
            current_dir: current.clone(),
            previous_dir: None,
            previous_backup_dir: None,
            staging_dir: temp.path().join(SUWAYOMI_STAGING_DIR).join("unused"),
            had_current: false,
        };

        rollback_promoted_directories(&state).unwrap();

        assert!(!current.exists());
    }

    #[test]
    fn snapshot_restore_replaces_allowlisted_files_only() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        std::fs::create_dir(&root).unwrap();
        write_root_file(&root, "server.conf", b"old-server");
        write_root_file(&root, "database.mv.db", b"old-db");
        std::fs::create_dir_all(root.join("extensions")).unwrap();
        std::fs::write(root.join("extensions").join("kept.jar"), b"old-extension").unwrap();
        std::fs::create_dir_all(root.join("settings")).unwrap();
        std::fs::write(root.join("settings").join("kept.json"), b"old-setting").unwrap();
        let snapshot = create_snapshot_for_root(&root).unwrap();
        write_root_file(&root, "server.conf", b"new-server");
        write_root_file(&root, "database.trace.db", b"new-trace");
        std::fs::create_dir(root.join("downloads")).unwrap();
        std::fs::write(root.join("downloads").join("chapter.cbz"), b"keep").unwrap();
        std::fs::write(root.join("extensions").join("kept.jar"), b"new-extension").unwrap();
        std::fs::write(root.join("extensions").join("extra.jar"), b"remove").unwrap();
        std::fs::write(root.join("settings").join("kept.json"), b"new-setting").unwrap();

        restore_snapshot_to_root(Path::new(&snapshot.snapshot_path), &root).unwrap();

        assert_eq!(
            std::fs::read(root.join("server.conf")).unwrap(),
            b"old-server"
        );
        assert_eq!(
            std::fs::read(root.join("database.mv.db")).unwrap(),
            b"old-db"
        );
        assert!(!root.join("database.trace.db").exists());
        assert!(root.join("downloads").join("chapter.cbz").is_file());
        assert_eq!(
            std::fs::read(root.join("extensions").join("kept.jar")).unwrap(),
            b"old-extension"
        );
        assert!(!root.join("extensions").join("extra.jar").exists());
        assert_eq!(
            std::fs::read(root.join("settings").join("kept.json")).unwrap(),
            b"old-setting"
        );
    }

    fn recovery_journal(
        root: &Path,
        runtime_root: &Path,
        snapshot: &SuwayomiUpdateSnapshotResult,
        state: UpdateJournalState,
    ) -> suwayomi_maintenance::SuwayomiUpdateJournal {
        let mut journal = suwayomi_maintenance::new_update_journal(
            "recovery-test".into(),
            "main".into(),
            path_to_string(root),
            "http://127.0.0.1:4567".into(),
            "v2.3.2243".into(),
            snapshot.snapshot_path.clone(),
            path_to_string(&runtime_root.join(SUWAYOMI_CURRENT_DIR)),
            path_to_string(&runtime_root.join(SUWAYOMI_PREVIOUS_DIR)),
            path_to_string(&runtime_root.join(".previous-replaced-recovery-test")),
            path_to_string(&runtime_root.join(SUWAYOMI_STAGING_DIR).join("v2.3.2243")),
            true,
        );
        journal.state = state;
        journal
    }

    #[test]
    fn interrupted_promotion_recovery_is_idempotent_before_publish() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("profile");
        let runtime_root = temp.path().join("runtime");
        std::fs::create_dir_all(&root).unwrap();
        write_root_file(&root, "database.mv.db", b"old-db");
        let snapshot = create_snapshot_for_root(&root).unwrap();
        write_root_file(&root, "database.mv.db", b"changed-db");

        let current = runtime_root.join(SUWAYOMI_CURRENT_DIR);
        let previous = runtime_root.join(SUWAYOMI_PREVIOUS_DIR);
        let backup = runtime_root.join(".previous-replaced-recovery-test");
        let staging = runtime_root.join(SUWAYOMI_STAGING_DIR).join("v2.3.2243");
        write_runtime_marker(&previous, "old-current");
        write_runtime_marker(&backup, "older-previous");
        write_runtime_marker(&staging, "candidate");
        let mut journal = recovery_journal(
            &root,
            &runtime_root,
            &snapshot,
            UpdateJournalState::CurrentStopped,
        );

        recover_runtime_directories(&journal).unwrap();
        restore_snapshot_to_root(Path::new(&journal.snapshot_path), &root).unwrap();
        assert_eq!(read_runtime_marker(&current), "old-current");
        assert_eq!(read_runtime_marker(&previous), "older-previous");
        assert_eq!(
            std::fs::read(root.join("database.mv.db")).unwrap(),
            b"old-db"
        );

        journal.state = UpdateJournalState::RollbackRunning;
        recover_runtime_directories(&journal).unwrap();
        restore_snapshot_to_root(Path::new(&journal.snapshot_path), &root).unwrap();
        assert_eq!(read_runtime_marker(&current), "old-current");
        assert_eq!(read_runtime_marker(&previous), "older-previous");
    }

    #[test]
    fn interrupted_promotion_recovery_removes_published_candidate() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("profile");
        let runtime_root = temp.path().join("runtime");
        std::fs::create_dir_all(&root).unwrap();
        write_root_file(&root, "server.conf", b"old-server");
        let snapshot = create_snapshot_for_root(&root).unwrap();

        let current = runtime_root.join(SUWAYOMI_CURRENT_DIR);
        let previous = runtime_root.join(SUWAYOMI_PREVIOUS_DIR);
        let backup = runtime_root.join(".previous-replaced-recovery-test");
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(
            current.join(SUWAYOMI_SERVER_JAR),
            create_test_jar_bytes("v2.3.2243"),
        )
        .unwrap();
        write_runtime_marker(&previous, "old-current");
        write_runtime_marker(&backup, "older-previous");
        let journal = recovery_journal(
            &root,
            &runtime_root,
            &snapshot,
            UpdateJournalState::RuntimePromoted,
        );

        recover_runtime_directories(&journal).unwrap();

        assert_eq!(read_runtime_marker(&current), "old-current");
        assert_eq!(read_runtime_marker(&previous), "older-previous");
    }

    #[test]
    fn snapshot_restore_rejects_incompatible_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let other_root = temp.path().join("other-root");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&other_root).unwrap();
        write_root_file(&root, "server.conf", b"old-server");
        let snapshot = create_snapshot_for_root(&root).unwrap();

        let error =
            restore_snapshot_to_root(Path::new(&snapshot.snapshot_path), &other_root).unwrap_err();

        assert!(error.contains("different Suwayomi root"));
    }

    #[test]
    fn promotion_lock_releases_after_failure() {
        let _serial = UPDATE_LOCK_TEST_MUTEX.lock().unwrap();
        clear_update_lock_for_tests();
        let temp = tempfile::tempdir().unwrap();

        let result: Result<(), String> = (|| {
            let _guard = try_acquire_suwayomi_update_lock("promotion-test")?;
            promote_staging_directories(temp.path(), "v2.2.2100").map(|_| ())
        })();

        assert!(result.is_err());
        assert!(!current_suwayomi_update_lock_status().in_progress);
    }

    #[test]
    fn repeated_promotion_failures_keep_state_clean() {
        let temp = tempfile::tempdir().unwrap();

        assert!(promote_staging_directories(temp.path(), "v2.2.2100").is_err());
        assert!(promote_staging_directories(temp.path(), "v2.2.2100").is_err());
        assert!(!temp.path().join(SUWAYOMI_CURRENT_DIR).exists());
        assert!(!temp.path().join(SUWAYOMI_PREVIOUS_DIR).exists());
    }

    #[test]
    fn v23_promotion_migrates_and_deduplicates_extension_stores() {
        let temp = tempfile::tempdir().unwrap();
        let conf = r#"server.extensionRepos = ["https://one.example/index.json", "https://two.example/index.json/"]
server.extensionStores = ["https://two.example/index.json"]
"#;
        std::fs::write(temp.path().join("server.conf"), conf).unwrap();

        assert!(migrate_extension_store_config(temp.path(), "v2.3.2243").unwrap());

        let migrated = std::fs::read_to_string(temp.path().join("server.conf")).unwrap();
        assert_eq!(read_conf_value(&migrated, "server.extensionRepos"), None);
        let stores = parse_store_list(
            &read_conf_value(&migrated, "server.extensionStores").unwrap(),
            "server.extensionStores",
        )
        .unwrap();
        assert_eq!(stores.len(), 2);
        assert!(stores.contains(&"https://one.example/index.json".to_string()));
        assert!(stores.contains(&"https://two.example/index.json".to_string()));
    }

    #[test]
    fn pre_v23_promotion_preserves_legacy_extension_repositories() {
        let temp = tempfile::tempdir().unwrap();
        let conf = "server.extensionRepos = [\"https://one.example/index.json\"]\n";
        std::fs::write(temp.path().join("server.conf"), conf).unwrap();

        assert!(!migrate_extension_store_config(temp.path(), "v2.1.1867").unwrap());
        assert_eq!(
            std::fs::read_to_string(temp.path().join("server.conf")).unwrap(),
            conf
        );
    }

    #[test]
    fn malformed_extension_repository_config_blocks_promotion_without_rewrite() {
        let temp = tempfile::tempdir().unwrap();
        let conf = "server.extensionRepos = not-a-list\n";
        std::fs::write(temp.path().join("server.conf"), conf).unwrap();

        let error = migrate_extension_store_config(temp.path(), "v2.3.2243").unwrap_err();

        assert!(error.contains("Could not parse server.extensionRepos"));
        assert_eq!(
            std::fs::read_to_string(temp.path().join("server.conf")).unwrap(),
            conf
        );
    }

    fn clear_update_lock_for_tests() {
        if let Ok(mut lock) = suwayomi_update_lock().lock() {
            *lock = None;
        }
    }

    #[test]
    fn update_lock_acquires_and_releases_on_drop() {
        let _serial = UPDATE_LOCK_TEST_MUTEX.lock().unwrap();
        clear_update_lock_for_tests();

        {
            let _guard = try_acquire_suwayomi_update_lock("test").unwrap();
            let status = current_suwayomi_update_lock_status();
            assert!(status.in_progress);
            assert_eq!(status.owner.as_deref(), Some("test"));
        }

        assert!(!current_suwayomi_update_lock_status().in_progress);
    }

    #[test]
    fn update_lock_rejects_concurrent_acquire() {
        let _serial = UPDATE_LOCK_TEST_MUTEX.lock().unwrap();
        clear_update_lock_for_tests();

        let _guard = try_acquire_suwayomi_update_lock("first").unwrap();
        let second = try_acquire_suwayomi_update_lock("second");

        assert!(second.is_err());
        assert!(current_suwayomi_update_lock_status().in_progress);
    }

    #[test]
    fn update_lock_recovers_after_error_scope() {
        let _serial = UPDATE_LOCK_TEST_MUTEX.lock().unwrap();
        clear_update_lock_for_tests();

        let result: Result<(), String> = (|| {
            let _guard = try_acquire_suwayomi_update_lock("failing-update")?;
            Err("simulated update failure".to_string())
        })();

        assert!(result.is_err());
        assert!(!current_suwayomi_update_lock_status().in_progress);
        assert!(try_acquire_suwayomi_update_lock("after-error").is_ok());
    }

    #[test]
    fn update_lock_manual_release_requires_matching_token() {
        let _serial = UPDATE_LOCK_TEST_MUTEX.lock().unwrap();
        clear_update_lock_for_tests();

        let guard = try_acquire_suwayomi_update_lock("manual").unwrap();
        assert!(!release_suwayomi_update_lock("wrong-token"));
        assert!(current_suwayomi_update_lock_status().in_progress);
        assert!(release_suwayomi_update_lock(&guard.token));
        std::mem::forget(guard);
        assert!(!current_suwayomi_update_lock_status().in_progress);
    }

    #[test]
    fn extension_batch_requires_exact_https_artifacts() {
        let valid = ExtensionUpdateBatchItem {
            package_name: "eu.kanade.tachiyomi.extension.en.demo".to_string(),
            version_code: "2".to_string(),
            version_name: "1.4.2".to_string(),
            store_id: "keiyoushi".to_string(),
            store_url_canonical: "https://store.example/index.json".to_string(),
            artifact_url: "https://store.example/demo.apk".to_string(),
            artifact_type: "apk".to_string(),
        };
        assert!(validate_extension_batch_item(&valid).is_ok());
        assert!(validate_extension_batch_item(&ExtensionUpdateBatchItem {
            artifact_url: "http://store.example/demo.apk".to_string(),
            ..valid.clone()
        })
        .is_err());
        assert!(validate_extension_batch_item(&ExtensionUpdateBatchItem {
            artifact_url: "https://user:secret@store.example/demo.apk".to_string(),
            ..valid.clone()
        })
        .is_err());
        assert!(validate_extension_batch_item(&ExtensionUpdateBatchItem {
            artifact_url: "https://store.example/demo.zip".to_string(),
            ..valid
        })
        .is_err());
    }

    #[test]
    fn extension_candidate_materializes_only_the_validated_snapshot() {
        let source = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("server.conf"), b"server").unwrap();
        std::fs::write(source.path().join("database.mv.db"), b"database").unwrap();
        std::fs::create_dir(source.path().join("extensions")).unwrap();
        std::fs::write(
            source.path().join("extensions").join("demo.jar"),
            b"extension",
        )
        .unwrap();
        std::fs::create_dir(source.path().join("downloads")).unwrap();
        std::fs::write(
            source.path().join("downloads").join("user.cbz"),
            b"user-data",
        )
        .unwrap();
        let snapshot = create_snapshot_for_root(source.path()).unwrap();
        let candidate = tempfile::tempdir().unwrap();
        materialize_snapshot_for_candidate(Path::new(&snapshot.snapshot_path), candidate.path())
            .unwrap();

        assert_eq!(
            std::fs::read(candidate.path().join("database.mv.db")).unwrap(),
            b"database"
        );
        assert!(candidate
            .path()
            .join("extensions")
            .join("demo.jar")
            .is_file());
        assert!(!candidate.path().join("downloads").exists());
    }

    #[test]
    fn extension_batch_journal_round_trips_crash_recovery_state() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("extension-update-journal.json");
        let mut journal = ExtensionBatchJournal {
            schema_version: 1,
            operation_id: "batch-test".to_string(),
            state: ExtensionBatchJournalState::Prepared,
            profile_id: "main".to_string(),
            root_dir: "profile".to_string(),
            server_url: "http://127.0.0.1:4567".to_string(),
            runtime_version: "v2.3.2243".to_string(),
            snapshot_path: String::new(),
            batch_root: "batch".to_string(),
            candidate_profile_id: "ext-stage-test".to_string(),
            candidate_root_dir: "candidate".to_string(),
            candidate_server_url: "http://127.0.0.1:4568".to_string(),
            updated_at_ms: 1,
        };
        write_extension_batch_journal_at(&path, &journal).unwrap();
        assert_eq!(
            read_extension_batch_journal_at(&path)
                .unwrap()
                .unwrap()
                .state,
            ExtensionBatchJournalState::Prepared
        );

        journal.snapshot_path = "snapshot".to_string();
        journal.transition(ExtensionBatchJournalState::Activating);
        write_extension_batch_journal_at(&path, &journal).unwrap();
        let recovered = read_extension_batch_journal_at(&path).unwrap().unwrap();
        assert_eq!(recovered.state, ExtensionBatchJournalState::Activating);
        assert_eq!(recovered.snapshot_path, "snapshot");
    }
}
