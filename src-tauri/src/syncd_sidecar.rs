use serde::Serialize;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri::RunEvent;
use tauri_plugin_http::reqwest;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::syncd::config::SyncdOwnershipMode;
use crate::syncd::models::SyncdDiscoveryDescriptor;
use crate::syncd::runtime_manifest::{
    read_runtime_manifest, runtime_manifest_path, SyncdRuntimeManifest,
};

const DEFAULT_SYNCD_PORT: u16 = 4777;
const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(20);

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncdLaunchMode {
    Loopback,
    LanHost { advertised_base_url: String },
}

impl SyncdLaunchMode {
    fn bind_host(&self) -> &'static str {
        match self {
            Self::Loopback => "127.0.0.1",
            Self::LanHost { .. } => "0.0.0.0",
        }
    }

    fn advertised_base_url(&self, local_base_url: &str) -> String {
        match self {
            Self::Loopback => local_base_url.to_string(),
            Self::LanHost {
                advertised_base_url,
            } => advertised_base_url.clone(),
        }
    }
}

pub struct RunningSyncd {
    pub child: Option<CommandChild>,
    pub ownership: SyncdOwnershipMode,
    pub pid: u32,
    pub local_base_url: String,
    pub advertised_base_url: String,
    pub bind_host: String,
    pub port: u16,
    pub host_mode: bool,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub cert_path: PathBuf,
    pub log_path: PathBuf,
}

#[derive(Default)]
pub struct SyncdState {
    runtime: Mutex<Option<RunningSyncd>>,
    ensure_gate: tokio::sync::Mutex<()>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncdRuntimeInfo {
    pub pid: u32,
    pub local_base_url: String,
    pub advertised_base_url: String,
    pub bind_host: String,
    pub port: u16,
    pub host_mode: bool,
    pub ownership: SyncdOwnershipMode,
    pub data_dir: String,
    pub db_path: String,
    pub cert_path: String,
    pub log_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncdPhaseGateStatus {
    endpoint: String,
    pid: u32,
    data_dir: String,
    db_path: String,
    cert_path: String,
    log_path: String,
    ready_at_ms: u128,
}

#[derive(Clone, Debug)]
struct SpawnRequest {
    data_dir: PathBuf,
    bind_host: String,
    port: u16,
    advertised_base_url: Option<String>,
    enable_audit_routes: bool,
    ownership: SyncdOwnershipMode,
}

#[derive(Debug)]
struct ValidatedPersistentRuntime {
    manifest: SyncdRuntimeManifest,
    descriptor: SyncdDiscoveryDescriptor,
}

pub fn maybe_install_exit_sentinel(app: &AppHandle) {
    let Some(path) = phase_gate_exit_sentinel() else {
        return;
    };

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        loop {
            tick.tick().await;
            if path.exists() {
                let _ = fs::remove_file(&path);
                app.exit(0);
                break;
            }
        }
    });
}

pub async fn maybe_spawn_for_phase_gate(app: &AppHandle) -> Result<(), String> {
    if !phase_gate_autostart_enabled() {
        return Ok(());
    }

    let request = SpawnRequest {
        data_dir: phase_gate_data_dir(),
        bind_host: phase_gate_bind_host(),
        port: phase_gate_port(),
        advertised_base_url: std::env::var("AETHON_SYNCD_ADVERTISED_BASE_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        enable_audit_routes: audit_routes_flag(),
        ownership: SyncdOwnershipMode::EphemeralOwned,
    };

    let runtime = ensure_spawned(app, request).await?;

    if let Some(status_path) = phase_gate_status_path() {
        let status = SyncdPhaseGateStatus {
            endpoint: runtime.local_base_url.clone(),
            pid: runtime.pid,
            data_dir: runtime.data_dir.clone(),
            db_path: runtime.db_path.clone(),
            cert_path: runtime.cert_path.clone(),
            log_path: runtime.log_path.clone(),
            ready_at_ms: unix_now_millis(),
        };
        if let Some(parent) = status_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let payload = serde_json::to_vec_pretty(&status).map_err(|err| err.to_string())?;
        fs::write(status_path, payload).map_err(|err| err.to_string())?;
    }

    let _ = app.emit("syncd-phase-gate-ready", &runtime.local_base_url);
    Ok(())
}

pub async fn ensure_for_desktop(
    app: &AppHandle,
    mode: SyncdLaunchMode,
) -> Result<SyncdRuntimeInfo, String> {
    let request = SpawnRequest {
        data_dir: desktop_syncd_data_dir(),
        bind_host: mode.bind_host().to_string(),
        port: phase_gate_port(),
        advertised_base_url: Some(
            mode.advertised_base_url(&format!("https://127.0.0.1:{}", phase_gate_port())),
        ),
        enable_audit_routes: false,
        ownership: SyncdOwnershipMode::PersistentAttached,
    };
    ensure_spawned(app, request).await
}

pub async fn ensure_host_mode(app: &AppHandle) -> Result<SyncdRuntimeInfo, String> {
    if automation_mode_enabled() {
        return ensure_for_desktop(app, SyncdLaunchMode::Loopback).await;
    }

    let lan_ip = detect_lan_ip()?;
    ensure_for_desktop(
        app,
        SyncdLaunchMode::LanHost {
            advertised_base_url: format!("https://{}:{}", lan_ip, phase_gate_port()),
        },
    )
    .await
}

fn automation_mode_enabled() -> bool {
    matches!(
        env::var("TAURI_AUTOMATION").ok().as_deref(),
        Some("1" | "true" | "TRUE" | "True")
    ) || matches!(
        env::var("TAURI_WEBVIEW_AUTOMATION").ok().as_deref(),
        Some("1" | "true" | "TRUE" | "True")
    )
}

pub fn handle_run_event(app: &AppHandle, event: &RunEvent) {
    if matches!(event, RunEvent::Exit) {
        shutdown(app);
    }
}

pub fn shutdown(app: &AppHandle) {
    let running = {
        let state = app.state::<SyncdState>();
        let mut guard = state.runtime.lock().unwrap();
        guard.take()
    };

    if let Some(running) = running {
        match running.ownership {
            SyncdOwnershipMode::EphemeralOwned => {
                let _ = append_line(
                    &running.log_path,
                    &format!("[{}] ephemeral shutdown requested by app", running.pid),
                );
                if let Some(child) = running.child {
                    let _ = child.kill();
                }
            }
            SyncdOwnershipMode::PersistentAttached => {
                let _ = append_line(
                    &running.log_path,
                    &format!("[{}] desktop detached from persistent syncd", running.pid),
                );
            }
        }
    }

    if let Some(status_path) = phase_gate_status_path() {
        let _ = fs::remove_file(status_path);
    }
}

pub(crate) fn current_runtime_info(app: &AppHandle) -> Option<SyncdRuntimeInfo> {
    let state = app.state::<SyncdState>();
    let guard = state.runtime.lock().unwrap();
    guard.as_ref().map(runtime_info_from_running)
}

async fn ensure_spawned(
    app: &AppHandle,
    request: SpawnRequest,
) -> Result<SyncdRuntimeInfo, String> {
    let state = app.state::<SyncdState>();
    let _ensure_guard = state.ensure_gate.lock().await;

    let current = {
        let guard = state.runtime.lock().unwrap();
        guard.as_ref().map(runtime_info_from_running)
    };

    if let Some(current) = current {
        if runtime_matches_request(&current, &request) {
            let healthy = match current.ownership {
                SyncdOwnershipMode::EphemeralOwned => {
                    probe_health(&current.local_base_url).await.is_ok()
                }
                SyncdOwnershipMode::PersistentAttached => {
                    matches!(
                        validate_existing_persistent_runtime(&request).await,
                        Ok(Some(_))
                    )
                }
            };
            if healthy {
                return Ok(current);
            }

            let stale = state.runtime.lock().unwrap().take();
            if let Some(stale) = stale {
                if stale.ownership == SyncdOwnershipMode::EphemeralOwned {
                    if let Some(child) = stale.child {
                        let _ = child.kill();
                    }
                }
            }
        } else {
            let existing = state.runtime.lock().unwrap().take();
            if let Some(existing) = existing {
                if existing.ownership == SyncdOwnershipMode::PersistentAttached {
                    *state.runtime.lock().unwrap() = Some(existing);
                    return Err(
                        "persistent syncd is already attached with an incompatible launch request"
                            .to_string(),
                    );
                }
                if let Some(child) = existing.child {
                    let _ = child.kill();
                }
            }
        }
    }

    if request.ownership == SyncdOwnershipMode::PersistentAttached {
        if let Some(validated) = validate_existing_persistent_runtime(&request).await? {
            let running = running_from_validated(&request, validated, None);
            let info = runtime_info_from_running(&running);
            *state.runtime.lock().unwrap() = Some(running);
            return Ok(info);
        }
    }

    fs::create_dir_all(&request.data_dir).map_err(|err| err.to_string())?;
    let log_path = request.data_dir.join("syncd-sidecar.log");
    let db_path = request.data_dir.join("syncd.sqlite");
    let cert_path = request.data_dir.join("cert.pem");
    let local_base_url = format!("https://127.0.0.1:{}", request.port);
    let advertised_base_url = request
        .advertised_base_url
        .clone()
        .unwrap_or_else(|| local_base_url.clone());

    let command = app
        .shell()
        .sidecar("aethon-syncd")
        .map_err(|err| format!("failed to create syncd sidecar command: {err}"))?
        .env("AETHON_SYNCD_DATA_DIR", &request.data_dir)
        .env("AETHON_SYNCD_BIND_HOST", &request.bind_host)
        .env("AETHON_SYNCD_PORT", request.port.to_string())
        .env("AETHON_SYNCD_OWNERSHIP", request.ownership.as_env_value())
        .env(
            "AETHON_SYNCD_ENABLE_AUDIT_ROUTES",
            if request.enable_audit_routes {
                "1"
            } else {
                "0"
            },
        )
        .env("AETHON_SYNCD_ADVERTISED_BASE_URL", &advertised_base_url)
        .env("AETHON_SYNCD_DISCOVERY_PROVIDER", "lan-publication")
        .env("AETHON_SYNCD_MANUAL_PROVIDER", "disabled")
        .env("AETHON_SYNCD_EFFECTIVE_DISCOVERY_POLICY", "advertised-only");
    let command = if request.ownership == SyncdOwnershipMode::EphemeralOwned {
        command.env("AETHON_SYNCD_PARENT_PID", std::process::id().to_string())
    } else {
        command
    };
    let (rx, child) = command
        .spawn()
        .map_err(|err| format!("failed to spawn syncd sidecar: {err}"))?;

    let pid = child.pid();
    spawn_log_drain(rx, log_path.clone(), pid);

    let running = match request.ownership {
        SyncdOwnershipMode::EphemeralOwned => {
            if let Err(err) = wait_for_ready(&local_base_url).await {
                let _ = child.kill();
                return Err(format!("syncd sidecar failed readiness probe: {err}"));
            }
            let host_mode = request.bind_host != "127.0.0.1";
            RunningSyncd {
                child: Some(child),
                ownership: request.ownership,
                pid,
                local_base_url,
                advertised_base_url,
                bind_host: request.bind_host,
                port: request.port,
                host_mode,
                data_dir: request.data_dir,
                db_path,
                cert_path,
                log_path,
            }
        }
        SyncdOwnershipMode::PersistentAttached => {
            let validated = match wait_for_persistent_runtime(&request, pid).await {
                Ok(validated) => validated,
                Err(error) => {
                    drop(child);
                    return Err(format!(
                        "persistent syncd failed identity readiness probe: {error}"
                    ));
                }
            };
            running_from_validated(&request, validated, Some(child))
        }
    };
    let info = runtime_info_from_running(&running);
    *state.runtime.lock().unwrap() = Some(running);
    Ok(info)
}

fn runtime_info_from_running(running: &RunningSyncd) -> SyncdRuntimeInfo {
    SyncdRuntimeInfo {
        pid: running.pid,
        local_base_url: running.local_base_url.clone(),
        advertised_base_url: running.advertised_base_url.clone(),
        bind_host: running.bind_host.clone(),
        port: running.port,
        host_mode: running.host_mode,
        ownership: running.ownership,
        data_dir: running.data_dir.to_string_lossy().into_owned(),
        db_path: running.db_path.to_string_lossy().into_owned(),
        cert_path: running.cert_path.to_string_lossy().into_owned(),
        log_path: running.log_path.to_string_lossy().into_owned(),
    }
}

fn runtime_matches_request(runtime: &SyncdRuntimeInfo, request: &SpawnRequest) -> bool {
    if runtime.ownership != request.ownership
        || runtime.bind_host != request.bind_host
        || runtime.port != request.port
        || !paths_identical(Path::new(&runtime.data_dir), &request.data_dir)
    {
        return false;
    }
    if request.ownership == SyncdOwnershipMode::PersistentAttached {
        return true;
    }
    runtime.advertised_base_url
        == request
            .advertised_base_url
            .clone()
            .unwrap_or_else(|| runtime.local_base_url.clone())
}

fn running_from_validated(
    request: &SpawnRequest,
    validated: ValidatedPersistentRuntime,
    child: Option<CommandChild>,
) -> RunningSyncd {
    let local_base_url = format!("https://127.0.0.1:{}", validated.manifest.port);
    RunningSyncd {
        child,
        ownership: SyncdOwnershipMode::PersistentAttached,
        pid: validated.manifest.pid,
        local_base_url,
        advertised_base_url: validated.descriptor.advertised_origin.base_url,
        bind_host: request.bind_host.clone(),
        port: validated.manifest.port,
        host_mode: request.bind_host != "127.0.0.1",
        data_dir: request.data_dir.clone(),
        db_path: request.data_dir.join("syncd.sqlite"),
        cert_path: request.data_dir.join("cert.pem"),
        log_path: request.data_dir.join("syncd-sidecar.log"),
    }
}

async fn validate_existing_persistent_runtime(
    request: &SpawnRequest,
) -> Result<Option<ValidatedPersistentRuntime>, String> {
    if !runtime_manifest_path(&request.data_dir).exists() {
        return Ok(None);
    }
    let manifest = match read_runtime_manifest(&request.data_dir) {
        Ok(manifest) => manifest,
        Err(error) => return Err(error),
    };

    if manifest.port != request.port {
        return Err(format!(
            "persistent syncd runtime port {} does not match requested port {}",
            manifest.port, request.port
        ));
    }

    if !runtime_process_matches(&manifest)? {
        let _ = fs::remove_file(runtime_manifest_path(&request.data_dir));
        return Ok(None);
    }

    let descriptor = fetch_pinned_descriptor(&manifest).await?;
    validate_descriptor_identity(&manifest, &descriptor)?;
    Ok(Some(ValidatedPersistentRuntime {
        manifest,
        descriptor,
    }))
}

async fn wait_for_persistent_runtime(
    request: &SpawnRequest,
    expected_pid: u32,
) -> Result<ValidatedPersistentRuntime, String> {
    let started = std::time::Instant::now();
    let mut last_error = "runtime manifest has not been published".to_string();
    loop {
        if started.elapsed() > DEFAULT_READY_TIMEOUT {
            return Err(last_error);
        }

        match read_runtime_manifest(&request.data_dir) {
            Ok(manifest) if manifest.pid == expected_pid => {
                match runtime_process_matches(&manifest) {
                    Ok(true) => {}
                    Ok(false) => {
                        return Err(format!(
                            "spawned persistent syncd PID {} is no longer running",
                            expected_pid
                        ));
                    }
                    Err(error) => return Err(error),
                }
                match fetch_pinned_descriptor(&manifest).await {
                    Ok(descriptor) => {
                        validate_descriptor_identity(&manifest, &descriptor)?;
                        return Ok(ValidatedPersistentRuntime {
                            manifest,
                            descriptor,
                        });
                    }
                    Err(error) => last_error = error,
                }
            }
            Ok(manifest) => {
                last_error = format!(
                    "runtime manifest PID {} does not match spawned PID {}",
                    manifest.pid, expected_pid
                );
            }
            Err(error) => last_error = error,
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn fetch_pinned_descriptor(
    manifest: &SyncdRuntimeManifest,
) -> Result<SyncdDiscoveryDescriptor, String> {
    let client = crate::syncd_desktop::build_pinned_http_client(&manifest.fingerprint)?;
    let url = format!(
        "https://127.0.0.1:{}/v1/discovery/descriptor",
        manifest.port
    );
    let response = tokio::time::timeout(Duration::from_secs(3), client.get(url).send())
        .await
        .map_err(|_| "persistent syncd identity probe timed out".to_string())?
        .map_err(|error| format!("persistent syncd identity probe failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("persistent syncd identity probe was rejected: {error}"))?;
    response
        .json::<SyncdDiscoveryDescriptor>()
        .await
        .map_err(|error| format!("persistent syncd returned an invalid identity: {error}"))
}

fn validate_descriptor_identity(
    manifest: &SyncdRuntimeManifest,
    descriptor: &SyncdDiscoveryDescriptor,
) -> Result<(), String> {
    if descriptor.server_id != manifest.server_id {
        return Err("persistent syncd serverId does not match runtime.json".to_string());
    }
    if !descriptor
        .tls_cert_sha256
        .eq_ignore_ascii_case(&manifest.fingerprint)
    {
        return Err("persistent syncd fingerprint does not match runtime.json".to_string());
    }
    Ok(())
}

fn runtime_process_matches(manifest: &SyncdRuntimeManifest) -> Result<bool, String> {
    let pid = Pid::from_u32(manifest.pid);
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    let Some(process) = system.process(pid) else {
        return Ok(false);
    };
    let Some(process_exe) = process.exe() else {
        return Err(format!(
            "cannot resolve executable for persistent syncd PID {}",
            manifest.pid
        ));
    };
    Ok(paths_identical(process_exe, Path::new(&manifest.exe)))
}

#[cfg(windows)]
fn paths_identical(left: &Path, right: &Path) -> bool {
    normalize_windows_path(left) == normalize_windows_path(right)
}

#[cfg(windows)]
fn normalize_windows_path(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', r"\")
        .to_ascii_lowercase()
}

#[cfg(not(windows))]
fn paths_identical(left: &Path, right: &Path) -> bool {
    left == right
}

fn spawn_log_drain(
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    log_path: PathBuf,
    pid: u32,
) {
    tauri::async_runtime::spawn(async move {
        let _ = append_line(&log_path, &format!("[{pid}] syncd sidecar drain started"));
        while let Some(event) = rx.recv().await {
            let line = match event {
                CommandEvent::Stdout(bytes) => {
                    format!("[{pid}] stdout {}", String::from_utf8_lossy(&bytes))
                }
                CommandEvent::Stderr(bytes) => {
                    format!("[{pid}] stderr {}", String::from_utf8_lossy(&bytes))
                }
                CommandEvent::Error(error) => format!("[{pid}] error {error}"),
                CommandEvent::Terminated(payload) => {
                    format!(
                        "[{pid}] terminated code={:?} signal={:?}",
                        payload.code, payload.signal
                    )
                }
                other => format!("[{pid}] event {:?}", other),
            };
            let _ = append_line(&log_path, line.trim_end());
        }
    });
}

async fn wait_for_ready(local_base_url: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|err| err.to_string())?;
    let started = std::time::Instant::now();

    loop {
        if started.elapsed() > DEFAULT_READY_TIMEOUT {
            return Err("health probe timed out".to_string());
        }

        match client.get(format!("{local_base_url}/healthz")).send().await {
            Ok(response) if response.status().is_success() => return Ok(()),
            _ => {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
    }
}

async fn probe_health(local_base_url: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|err| err.to_string())?;
    let response = tokio::time::timeout(
        Duration::from_secs(3),
        client.get(format!("{local_base_url}/healthz")).send(),
    )
    .await
    .map_err(|_| "health probe timed out".to_string())?
    .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("health probe returned {}", response.status()))
    }
}

fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{line}")?;
    Ok(())
}

fn detect_lan_ip() -> Result<IpAddr, String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|err| err.to_string())?;
    socket
        .connect((Ipv4Addr::new(8, 8, 8, 8), 80))
        .map_err(|err| err.to_string())?;
    let ip = socket.local_addr().map_err(|err| err.to_string())?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        return Err("failed to resolve a LAN-reachable local IP address".to_string());
    }
    Ok(ip)
}

fn phase_gate_autostart_enabled() -> bool {
    std::env::var("AETHON_SYNCD_PHASE_GATE_AUTOSTART").as_deref() == Ok("1")
}

fn audit_routes_flag() -> bool {
    std::env::var("AETHON_SYNCD_ENABLE_AUDIT_ROUTES").as_deref() == Ok("1")
}

fn phase_gate_status_path() -> Option<PathBuf> {
    std::env::var_os("AETHON_SYNCD_PHASE_GATE_STATUS_PATH").map(PathBuf::from)
}

fn phase_gate_exit_sentinel() -> Option<PathBuf> {
    std::env::var_os("AETHON_SYNCD_PHASE_GATE_EXIT_SENTINEL").map(PathBuf::from)
}

fn phase_gate_data_dir() -> PathBuf {
    std::env::var_os("AETHON_SYNCD_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("aethon").join("syncd-phase-gate"))
}

fn desktop_syncd_data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("Aethon")
        .join("syncd")
}

fn phase_gate_bind_host() -> String {
    std::env::var("AETHON_SYNCD_BIND_HOST").unwrap_or_else(|_| "127.0.0.1".to_string())
}

fn phase_gate_port() -> u16 {
    std::env::var("AETHON_SYNCD_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_SYNCD_PORT)
}

fn unix_now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(ownership: SyncdOwnershipMode) -> SpawnRequest {
        SpawnRequest {
            data_dir: PathBuf::from(r"C:\temp\aethon-syncd"),
            bind_host: "0.0.0.0".to_string(),
            port: 4777,
            advertised_base_url: Some("https://192.168.1.20:4777".to_string()),
            enable_audit_routes: false,
            ownership,
        }
    }

    fn descriptor(server_id: &str, fingerprint: &str) -> SyncdDiscoveryDescriptor {
        serde_json::from_value(serde_json::json!({
            "descriptorVersion": 1,
            "serverId": server_id,
            "serverProtocolVersion": 1,
            "minClientVersion": "0.1.0",
            "tlsCertSha256": fingerprint,
            "advertisedOrigin": {
                "baseUrl": "https://192.168.1.20:4777",
                "policyName": "override"
            },
            "capabilities": {
                "supportsBootstrapSessionCreate": true,
                "supportsBootstrapSessionFetch": true,
                "supportsLivePairingStatus": true,
                "supportsDescriptor": true,
                "hasAdvertisedEndpoint": true
            }
        }))
        .unwrap()
    }

    #[test]
    fn launch_request_never_confuses_ephemeral_and_persistent_ownership() {
        let runtime = SyncdRuntimeInfo {
            pid: 42,
            local_base_url: "https://127.0.0.1:4777".to_string(),
            advertised_base_url: "https://192.168.1.20:4777".to_string(),
            bind_host: "0.0.0.0".to_string(),
            port: 4777,
            host_mode: true,
            ownership: SyncdOwnershipMode::PersistentAttached,
            data_dir: r"C:\temp\aethon-syncd".to_string(),
            db_path: r"C:\temp\aethon-syncd\syncd.sqlite".to_string(),
            cert_path: r"C:\temp\aethon-syncd\cert.pem".to_string(),
            log_path: r"C:\temp\aethon-syncd\syncd-sidecar.log".to_string(),
        };

        assert!(runtime_matches_request(
            &runtime,
            &request(SyncdOwnershipMode::PersistentAttached)
        ));
        assert!(!runtime_matches_request(
            &runtime,
            &request(SyncdOwnershipMode::EphemeralOwned)
        ));
    }

    #[test]
    fn attach_identity_requires_both_server_id_and_fingerprint() {
        let fingerprint = "a".repeat(64);
        let manifest = SyncdRuntimeManifest::new(
            42,
            "server-a",
            4777,
            &fingerprint,
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );

        assert!(
            validate_descriptor_identity(&manifest, &descriptor("server-a", &fingerprint)).is_ok()
        );
        assert!(
            validate_descriptor_identity(&manifest, &descriptor("server-b", &fingerprint))
                .unwrap_err()
                .contains("serverId")
        );
        assert!(
            validate_descriptor_identity(&manifest, &descriptor("server-a", &"b".repeat(64)))
                .unwrap_err()
                .contains("fingerprint")
        );
    }

    #[test]
    fn attach_process_identity_matches_current_pid_and_executable() {
        let executable = std::env::current_exe().unwrap();
        let executable = fs::canonicalize(&executable).unwrap_or(executable);
        let manifest = SyncdRuntimeManifest::new(
            std::process::id(),
            "server-a",
            4777,
            "a".repeat(64),
            executable.to_string_lossy().into_owned(),
        );

        assert!(runtime_process_matches(&manifest).unwrap());
    }

    #[test]
    fn stale_runtime_pid_is_not_attachable() {
        let manifest = SyncdRuntimeManifest::new(
            u32::MAX,
            "server-a",
            4777,
            "a".repeat(64),
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );

        assert!(!runtime_process_matches(&manifest).unwrap());
    }
}
