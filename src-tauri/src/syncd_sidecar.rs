use serde::Serialize;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri::RunEvent;
use tauri_plugin_http::reqwest;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

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
    pub child: CommandChild,
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
pub struct SyncdState(pub Mutex<Option<RunningSyncd>>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncdRuntimeInfo {
    pub pid: u32,
    pub local_base_url: String,
    pub advertised_base_url: String,
    pub bind_host: String,
    pub port: u16,
    pub host_mode: bool,
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
        let mut guard = state.0.lock().unwrap();
        guard.take()
    };

    if let Some(running) = running {
        let _ = append_line(
            &running.log_path,
            &format!("[{}] shutdown requested by app", running.pid),
        );
        let _ = running.child.kill();
    }

    if let Some(status_path) = phase_gate_status_path() {
        let _ = fs::remove_file(status_path);
    }
}

pub(crate) fn current_runtime_info(app: &AppHandle) -> Option<SyncdRuntimeInfo> {
    let state = app.state::<SyncdState>();
    let guard = state.0.lock().unwrap();
    guard.as_ref().map(runtime_info_from_running)
}

async fn ensure_spawned(
    app: &AppHandle,
    request: SpawnRequest,
) -> Result<SyncdRuntimeInfo, String> {
    {
        let state = app.state::<SyncdState>();
        let mut guard = state.0.lock().unwrap();
        if let Some(running) = guard.as_ref() {
            if running.bind_host == request.bind_host
                && running.port == request.port
                && running.advertised_base_url
                    == request
                        .advertised_base_url
                        .clone()
                        .unwrap_or_else(|| running.local_base_url.clone())
            {
                return Ok(runtime_info_from_running(running));
            }
        }
        if let Some(running) = guard.take() {
            let _ = append_line(
                &running.log_path,
                &format!(
                    "[{}] restarting syncd sidecar for bind_host={} advertised_base_url={:?}",
                    running.pid, request.bind_host, request.advertised_base_url
                ),
            );
            let _ = running.child.kill();
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

    let (rx, child) = app
        .shell()
        .sidecar("aethon-syncd")
        .map_err(|err| format!("failed to create syncd sidecar command: {err}"))?
        .env("AETHON_SYNCD_DATA_DIR", &request.data_dir)
        .env("AETHON_SYNCD_BIND_HOST", &request.bind_host)
        .env("AETHON_SYNCD_PORT", request.port.to_string())
        .env("AETHON_SYNCD_PARENT_PID", std::process::id().to_string())
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
        .env("AETHON_SYNCD_EFFECTIVE_DISCOVERY_POLICY", "advertised-only")
        .spawn()
        .map_err(|err| format!("failed to spawn syncd sidecar: {err}"))?;

    let pid = child.pid();
    spawn_log_drain(rx, log_path.clone(), pid);

    if let Err(err) = wait_for_ready(&local_base_url).await {
        let _ = child.kill();
        return Err(format!("syncd sidecar failed readiness probe: {err}"));
    }

    let host_mode = request.bind_host != "127.0.0.1";
    let bind_host = request.bind_host;
    let running = RunningSyncd {
        child,
        pid,
        local_base_url,
        advertised_base_url,
        bind_host,
        port: request.port,
        host_mode,
        data_dir: request.data_dir,
        db_path,
        cert_path,
        log_path,
    };
    let info = runtime_info_from_running(&running);
    *app.state::<SyncdState>().0.lock().unwrap() = Some(running);
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
        data_dir: running.data_dir.to_string_lossy().into_owned(),
        db_path: running.db_path.to_string_lossy().into_owned(),
        cert_path: running.cert_path.to_string_lossy().into_owned(),
        log_path: running.log_path.to_string_lossy().into_owned(),
    }
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
