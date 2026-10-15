mod cloudflare_solver;
mod discord_cover;
mod discord_rpc;
mod compat;
mod migration_journal;
mod offline_chapter;
mod suwayomi_lan;
mod suwayomi_maintenance;
mod restore_commands;
mod suwayomi_recovery;
mod suwayomi_runtime;
mod suwayomi_runtime_store;
mod suwayomi_update;
pub mod syncd;
mod syncd_desktop;
mod syncd_replication;
mod syncd_sidecar;
mod session_control_protocol;
mod session_control;

pub use compat::{
    migrate_legacy_core_storage, migrate_legacy_storage, promote_legacy_environment,
};

use base64::Engine;
use fs2::FileExt;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use percent_encoding::percent_decode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(not(windows))]
use std::process::Stdio;
use std::sync::{mpsc, Mutex, Once};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::{Disks, Pid, System};
use tauri::http::{
    header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE},
    Request, Response, StatusCode,
};
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use url::Url;
use walkdir::WalkDir;
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            QueryInformationJobObject, JobObjectBasicAccountingInformation, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            CreateProcessW, ResumeThread, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
            PROCESS_INFORMATION, STARTUPINFOW,
        },
    },
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackerOAuthCallbackPayload {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
}

fn tracker_oauth_window_label(session_id: Option<&str>) -> Result<String, String> {
    let id = match session_id {
        Some(value) => uuid::Uuid::parse_str(value).map_err(|_| "Invalid tracker login session.".to_string())?,
        None => uuid::Uuid::new_v4(),
    };
    Ok(format!("tracker-oauth-{}", id.simple()))
}

fn is_tracker_oauth_callback(url: &Url) -> bool {
    if syncd::myanimelist_oauth::is_login_callback(url) {
        return true;
    }
    let host_matches = url
        .host_str()
        .map(|host| host.eq_ignore_ascii_case("suwayomi.org"))
        .unwrap_or(false);
    if !host_matches || url.path() != "/tracker-oauth" {
        return false;
    }

    url.query_pairs()
        .any(|(key, value)| matches!(key.as_ref(), "code" | "access_token") && !value.is_empty())
        || url.fragment().is_some_and(|fragment| {
            let params = url::form_urlencoded::parse(fragment.as_bytes());
            params.into_iter().any(|(key, value)| {
                matches!(key.as_ref(), "code" | "access_token") && !value.is_empty()
            })
        })
}

const READER_WEBVIEW_INIT_SCRIPT: &str = r#"
(() => {
  const SAME_ORIGIN = location.origin;
  const SAME_HOST = location.hostname;
  const AD_HOST_RE = /doubleclick|googlesyndication|googleadservices|adsystem|adnxs|taboola|outbrain|exoclick|popads|propellerads|adsterra|trafficjunky|juicyads|hilltopads|clickadu|onesignal|histats|analytics/i;
  const AD_ATTR_RE = /(ad-|ads-|_ad|banner|popup|popunder|sticky-ad|advert|sponsor|promo)/i;
  const AD_STYLE_ID = "epigraph-reader-webview-cleanup";
  const SELECTORS = [
    "iframe[src*='doubleclick']",
    "iframe[src*='googlesyndication']",
    "iframe[src*='googleadservices']",
    "iframe[src*='adnxs']",
    "iframe[src*='taboola']",
    "iframe[src*='outbrain']",
    "iframe[id*='google_ads']",
    "iframe[class*='ads']",
    ".adsbygoogle",
    "[id*='banner']",
    "[class*='banner']",
    "[id*='popup']",
    "[class*='popup']",
    "[id*='advert']",
    "[class*='advert']",
    "[id*='sponsor']",
    "[class*='sponsor']"
  ];

  function installCss() {
    if (document.getElementById(AD_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = AD_STYLE_ID;
    style.textContent = `
      ${SELECTORS.join(",\n")} {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function isAdLikeElement(el) {
    if (!(el instanceof HTMLElement)) return false;
    const attrs = `${el.id} ${el.className} ${el.getAttribute("role") ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
    if (AD_ATTR_RE.test(attrs)) return true;
    const iframe = el.querySelector("iframe");
    if (iframe instanceof HTMLIFrameElement && AD_HOST_RE.test(iframe.src || "")) return true;
    const style = window.getComputedStyle(el);
    const z = Number.parseInt(style.zIndex || "0", 10);
    if (style.position === "fixed" && z >= 1000 && (AD_ATTR_RE.test(attrs) || iframe)) return true;
    return false;
  }

  function clean(root = document) {
    if (!(root instanceof Document || root instanceof HTMLElement || root instanceof DocumentFragment)) return;
    root.querySelectorAll?.("*").forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      if (isAdLikeElement(node)) node.remove();
      if (node instanceof HTMLIFrameElement && AD_HOST_RE.test(node.src || "")) node.remove();
    });
  }

  function clampLinks(root = document) {
    root.querySelectorAll?.("a[target='_blank']").forEach((node) => {
      if (!(node instanceof HTMLAnchorElement)) return;
      try {
        const url = new URL(node.href, location.href);
        if (url.hostname === SAME_HOST) {
          node.target = "_self";
          return;
        }
        if (AD_HOST_RE.test(url.hostname)) {
          node.removeAttribute("href");
          node.style.pointerEvents = "none";
        }
      } catch {}
    });
  }

  const originalOpen = window.open;
  window.open = function(url, target, features) {
    try {
      const next = new URL(String(url || ""), location.href);
      if (next.hostname === SAME_HOST) {
        location.assign(next.toString());
        return null;
      }
      if (AD_HOST_RE.test(next.hostname)) {
        return null;
      }
    } catch {}
    return null;
  };

  installCss();
  clean();
  clampLinks();
  document.addEventListener("DOMContentLoaded", () => {
    installCss();
    clean();
    clampLinks();
  }, { once: true });
  new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement || node instanceof DocumentFragment) {
          clean(node);
          clampLinks(node);
        }
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
"#;

const LIBRARY_COVER_CACHE_MAX_BYTES: u64 = 256 * 1024 * 1024;
const LIBRARY_COVER_MAX_DOWNLOAD_BYTES: u64 = 5 * 1024 * 1024;
const LIBRARY_COVER_THUMB_MAX_EDGE: u32 = 420;
const LIBRARY_COVER_THUMB_JPEG_QUALITY: u8 = 82;
const NOVEL_RUNTIME_HOST_LABEL: &str = "novel-runtime-host";
const DEFAULT_EPIGRAPH_GITHUB_REPO: &str = "johnnylord1/Epigraph";
const EPIGRAPH_GITHUB_REPO: Option<&str> = option_env!("EPIGRAPH_GITHUB_REPO");
const VITE_EPIGRAPH_GITHUB_REPO: Option<&str> = option_env!("VITE_EPIGRAPH_GITHUB_REPO");
const LEGACY_AETHON_GITHUB_REPO: Option<&str> = option_env!("AETHON_GITHUB_REPO");
const LEGACY_VITE_AETHON_GITHUB_REPO: Option<&str> = option_env!("VITE_AETHON_GITHUB_REPO");

struct RunningServer {
    child: CommandChild,
    owner_path: PathBuf,
    run_id: String,
    birth_identity: Option<suwayomi_runtime::RuntimeProcessIdentity>,
    profile_key: String,
    server_url: String,
    port: u16,
}

struct ServerState(Mutex<Option<RunningServer>>);

struct RuntimeSupervisorState(Mutex<suwayomi_runtime::RuntimeStatus>);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchTargetInfo {
    server_url_override: Option<String>,
    profile_label_override: Option<String>,
    server_auth_enabled_override: Option<bool>,
    server_auth_user_override: Option<String>,
    server_auth_pass_override: Option<String>,
    attach_only_override: Option<bool>,
    audit_open_override: Option<String>,
    audit_manga_id_override: Option<i32>,
    audit_chapter_id_override: Option<i32>,
    audit_book_id_override: Option<String>,
    audit_manga_backup_override: Option<String>,
    audit_books_backup_override: Option<String>,
    audit_novels_backup_override: Option<String>,
    audit_epigraph_backup_override: Option<String>,
    restore_manga_backup_override: Option<String>,
    restore_epigraph_backup_override: Option<String>,
    restore_handoff_override: Option<bool>,
    restore_source_profile_override: Option<String>,
}

struct LaunchTarget(LaunchTargetInfo);

#[derive(Default, Clone, Debug)]
struct AutomationLaunchOverrides {
    local_app_data_dir: Option<PathBuf>,
    syncd_port: Option<u16>,
    local_server_ports: Option<(u16, u16)>,
    syncd_bootstrap_ttl_seconds: Option<u64>,
    webdriver_automation: bool,
}

#[derive(Serialize)]
pub struct StorageInfo {
    manga_bytes: u64,
    total_bytes: u64,
    free_bytes: u64,
    path: String,
}

#[derive(Serialize)]
struct RuntimeDiagnostics {
    app_pid: u32,
    app_memory_bytes: u64,
    app_virtual_memory_bytes: u64,
    app_cpu_percent: f32,
    java_pid: Option<u32>,
    java_memory_bytes: Option<u64>,
    java_virtual_memory_bytes: Option<u64>,
    java_cpu_percent: Option<f32>,
    local_server_profile: Option<String>,
    server_conf: Option<ServerConfDiagnostics>,
    total_processes: usize,
    startup_diagnostics_enabled: bool,
}

#[derive(Serialize)]
struct ServerConfDiagnostics {
    global_update_interval: Option<String>,
    max_sources_in_parallel: Option<String>,
    web_ui_enabled: Option<String>,
    web_ui_update_check_interval: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(tag = "kind", content = "message")]
pub enum SpawnError {
    NotConfigured(String),
    SpawnFailed(String),
    AttachOnlyTarget(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalServerProfile {
    Main,
    Test,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalServerUpdateIntensity {
    Eco,
    Balanced,
    Fast,
}

impl LocalServerUpdateIntensity {
    fn from_option(value: Option<&str>) -> Self {
        match value
            .unwrap_or("balanced")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "eco" => Self::Eco,
            "fast" => Self::Fast,
            _ => Self::Balanced,
        }
    }

    fn max_sources_in_parallel(self) -> u8 {
        match self {
            Self::Eco => 1,
            Self::Balanced => 2,
            Self::Fast => 3,
        }
    }
}

impl LocalServerProfile {
    fn key(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Test => "test",
        }
    }
}

fn default_local_server_port(profile: LocalServerProfile) -> u16 {
    match profile {
        LocalServerProfile::Main => suwayomi_runtime::main_server_port(),
        LocalServerProfile::Test => suwayomi_runtime::test_server_port(),
    }
}

fn builtin_server_url(profile: LocalServerProfile) -> String {
    format!("http://127.0.0.1:{}", default_local_server_port(profile))
}

#[derive(Serialize)]
struct BuiltinServerPorts {
    main: u16,
    test: u16,
}

/// The MAIN and TEST ports this build uses, so the interface follows a debug build off the release's ports.
#[tauri::command]
fn get_builtin_server_ports() -> BuiltinServerPorts {
    BuiltinServerPorts {
        main: default_local_server_port(LocalServerProfile::Main),
        test: default_local_server_port(LocalServerProfile::Test),
    }
}

fn sanitize_custom_profile_key(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() || normalized.len() > 32 {
        return None;
    }
    if !normalized
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return None;
    }
    if normalized.starts_with('-') || normalized.ends_with('-') {
        return None;
    }
    Some(normalized)
}

fn local_server_profile_key_from_id(value: Option<&str>) -> Option<String> {
    value.and_then(sanitize_custom_profile_key)
}

#[derive(Clone, Debug)]
struct LocalServerTarget {
    profile: LocalServerProfile,
    profile_key: String,
    root_dir: PathBuf,
    server_url: String,
    port: u16,
    attach_only: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ManagedStartupOwner {
    PersistentCore,
    Desktop,
}

fn managed_startup_owner(profile_key: &str, port: u16) -> ManagedStartupOwner {
    if profile_key.eq_ignore_ascii_case("main") && port == default_local_server_port(LocalServerProfile::Main) {
        ManagedStartupOwner::PersistentCore
    } else {
        ManagedStartupOwner::Desktop
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerOwner {
    profile_key: String,
    root_dir: String,
    app_pid: u32,
    java_pid: u32,
    port: u16,
    server_url: String,
    started_at: u64,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    process_identity: Option<suwayomi_runtime::RuntimeProcessIdentity>,
    #[serde(default)]
    spawned_by_app: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OwnerReuseDecision {
    Reusable,
    Stale,
    ConflictingLiveProcess,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DockerFlareSolverrStatus {
    installed: bool,
    daemon: bool,
    running: bool,
    version: Option<String>,
    message: Option<String>,
    started_now: bool,
    endpoint_owned: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFlareSolverrStatus {
    installed: bool,
    running: bool,
    path: Option<String>,
    message: Option<String>,
    started_now: bool,
    endpoint_owned: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFlareSolverrOwner {
    pid: u32,
    process_creation_time: u64,
    executable_path: String,
    #[serde(default)]
    job_bound: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalFlareSolverrOwnerState {
    CurrentInstance,
    OtherInstance,
    Stale,
}

fn classify_local_flaresolverr_owner(
    identity_matches: bool,
    job_bound: bool,
    current_job_owns: bool,
) -> LocalFlareSolverrOwnerState {
    if identity_matches && job_bound && current_job_owns {
        LocalFlareSolverrOwnerState::CurrentInstance
    } else if identity_matches {
        LocalFlareSolverrOwnerState::OtherInstance
    } else {
        LocalFlareSolverrOwnerState::Stale
    }
}

#[cfg(windows)]
struct LocalFlareSolverrJob {
    pid: u32,
    handle: usize,
}

const FLARESOLVERR_CONTAINER_NAME: &str = "epigraph-flaresolverr";
const FLARESOLVERR_IMAGE: &str = "ghcr.io/flaresolverr/flaresolverr@sha256:7962759d99d7e125e108e0f5e7f3cdbcd36161776d058d1d9b7153b92ef1af9e";
const FLARESOLVERR_LOCAL_VERSION: &str = "v3.4.6";
const FLARESOLVERR_DOCKER_OWNER_LABEL: &str = "com.epigraph.managed";
const FLARESOLVERR_DOCKER_OWNER_VALUE: &str = "flaresolverr";
const FLARESOLVERR_DOCKER_LEASE_LABEL: &str = "com.epigraph.owner";
const FLARESOLVERR_DOCKER_MEMORY_BYTES: u64 = 1024 * 1024 * 1024;
const FLARESOLVERR_DOCKER_NANO_CPUS: u64 = 1_000_000_000;
const FLARESOLVERR_DOCKER_PIDS_LIMIT: u64 = 256;
static FLARESOLVERR_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());
#[cfg(windows)]
static FLARESOLVERR_LOCAL_JOB: Mutex<Option<LocalFlareSolverrJob>> = Mutex::new(None);

struct FlareSolverrLifecycleFileLock {
    file: fs::File,
}

impl Drop for FlareSolverrLifecycleFileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

fn acquire_flaresolverr_lifecycle_file_lock() -> Result<FlareSolverrLifecycleFileLock, String> {
    fs::create_dir_all(local_flaresolverr_tools_dir()).map_err(|error| error.to_string())?;
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(local_flaresolverr_tools_dir().join("lifecycle.lock"))
        .map_err(|error| error.to_string())?;
    file.lock_exclusive().map_err(|error| error.to_string())?;
    Ok(FlareSolverrLifecycleFileLock { file })
}

fn run_docker(args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("docker")
        .args(args)
        .output()
        .map_err(|err| err.to_string())
}

fn docker_output_text(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

fn inspect_flaresolverr_running() -> bool {
    let Ok(output) = run_docker(&[
        "inspect",
        "-f",
        "{{.State.Running}}",
        FLARESOLVERR_CONTAINER_NAME,
    ]) else {
        return false;
    };
    output.status.success() && docker_output_text(&output).eq_ignore_ascii_case("true")
}

fn local_flaresolverr_docker_lease_path() -> PathBuf {
    local_flaresolverr_tools_dir().join("docker-owner-token")
}

fn read_flaresolverr_docker_lease() -> Option<String> {
    let token = fs::read_to_string(local_flaresolverr_docker_lease_path()).ok()?;
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_string())
}

fn create_flaresolverr_docker_lease() -> Result<String, String> {
    if let Some(token) = read_flaresolverr_docker_lease() {
        return Ok(token);
    }
    fs::create_dir_all(local_flaresolverr_tools_dir()).map_err(|error| error.to_string())?;
    let token = uuid::Uuid::new_v4().to_string();
    write_text_file_atomic(&local_flaresolverr_docker_lease_path(), &token)?;
    Ok(token)
}

fn docker_container_has_ownership_lease(inspect: &serde_json::Value, lease: &str) -> bool {
    let container = inspect
        .as_array()
        .and_then(|items| items.first())
        .unwrap_or(inspect);
    let labels = container.pointer("/Config/Labels");

    labels
        .and_then(|value| value.get(FLARESOLVERR_DOCKER_OWNER_LABEL))
        .and_then(serde_json::Value::as_str)
        == Some(FLARESOLVERR_DOCKER_OWNER_VALUE)
        && labels
            .and_then(|value| value.get(FLARESOLVERR_DOCKER_LEASE_LABEL))
            .and_then(serde_json::Value::as_str)
            == Some(lease)
}

fn docker_container_matches_policy(inspect: &serde_json::Value, lease: &str) -> bool {
    let container = inspect
        .as_array()
        .and_then(|items| items.first())
        .unwrap_or(inspect);
    let port_bindings = container.pointer("/HostConfig/PortBindings/8191~1tcp");
    let host_port_matches = port_bindings
        .and_then(serde_json::Value::as_array)
        .is_some_and(|bindings| {
            bindings.iter().any(|binding| {
                binding.get("HostIp").and_then(serde_json::Value::as_str) == Some("127.0.0.1")
                    && binding.get("HostPort").and_then(serde_json::Value::as_str) == Some("8191")
            })
        });

    docker_container_has_ownership_lease(inspect, lease)
        && container
            .pointer("/Config/Image")
            .and_then(serde_json::Value::as_str)
            == Some(FLARESOLVERR_IMAGE)
        && container
            .pointer("/HostConfig/Memory")
            .and_then(serde_json::Value::as_u64)
            == Some(FLARESOLVERR_DOCKER_MEMORY_BYTES)
        && container
            .pointer("/HostConfig/NanoCpus")
            .and_then(serde_json::Value::as_u64)
            == Some(FLARESOLVERR_DOCKER_NANO_CPUS)
        && container
            .pointer("/HostConfig/PidsLimit")
            .and_then(serde_json::Value::as_u64)
            == Some(FLARESOLVERR_DOCKER_PIDS_LIMIT)
        && container
            .pointer("/HostConfig/RestartPolicy/Name")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|name| name.is_empty() || name.eq_ignore_ascii_case("no"))
        && host_port_matches
}

fn inspect_flaresolverr_container() -> Option<serde_json::Value> {
    let output = run_docker(&["inspect", FLARESOLVERR_CONTAINER_NAME]).ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

fn inspect_flaresolverr_owned() -> bool {
    let Some(lease) = read_flaresolverr_docker_lease() else {
        return false;
    };
    inspect_flaresolverr_container()
        .is_some_and(|inspect| docker_container_has_ownership_lease(&inspect, &lease))
}

fn inspect_flaresolverr_policy_compliant() -> bool {
    let Some(lease) = read_flaresolverr_docker_lease() else {
        return false;
    };
    inspect_flaresolverr_container()
        .is_some_and(|inspect| docker_container_matches_policy(&inspect, &lease))
}

fn inspect_flaresolverr_container_exists() -> bool {
    run_docker(&["inspect", FLARESOLVERR_CONTAINER_NAME])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn local_flaresolverr_exe_path() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")));
    base.join("Epigraph")
        .join("tools")
        .join("flaresolverr")
        .join(FLARESOLVERR_LOCAL_VERSION)
        .join("flaresolverr")
        .join("flaresolverr.exe")
}

fn local_flaresolverr_tools_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")));
    base.join("Epigraph").join("tools").join("flaresolverr")
}

fn local_flaresolverr_logs_dir() -> PathBuf {
    local_flaresolverr_tools_dir().join("logs")
}

fn app_logs_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")));
    base.join("Epigraph").join("logs")
}

#[cfg(all(debug_assertions, windows))]
fn has_webview2_remote_debugging_flag(arguments: &str) -> bool {
    arguments
        .split_whitespace()
        .any(|part| part.starts_with("--remote-debugging-port="))
}

#[cfg(all(debug_assertions, windows))]
fn ensure_dev_webview2_debug_port() {
    const CDP_FLAG: &str = "--remote-debugging-port=9223";
    let mut existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    if has_webview2_remote_debugging_flag(&existing) {
        return;
    }

    if existing.trim().is_empty() {
        existing = CDP_FLAG.to_string();
    } else {
        existing.push(' ');
        existing.push_str(CDP_FLAG);
    }

    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", existing);
}

#[cfg(not(all(debug_assertions, windows)))]
fn ensure_dev_webview2_debug_port() {}

fn ensure_process_rustls_crypto_provider() {
    static INSTALL_ONCE: Once = Once::new();

    INSTALL_ONCE.call_once(|| {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });
}

fn local_flaresolverr_stdout_log_path() -> PathBuf {
    local_flaresolverr_logs_dir().join("flaresolverr.out.log")
}

#[cfg(not(windows))]
fn local_flaresolverr_stderr_log_path() -> PathBuf {
    local_flaresolverr_logs_dir().join("flaresolverr.err.log")
}

fn local_flaresolverr_owner_path() -> PathBuf {
    local_flaresolverr_tools_dir().join("owner.json")
}

fn normalized_process_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn process_paths_match(left: &Path, right: &Path) -> bool {
    let left = normalized_process_path(left);
    let right = normalized_process_path(right);
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn process_matches_local_flaresolverr(process: &sysinfo::Process, expected_path: &Path) -> bool {
    process
        .exe()
        .map(|path| process_paths_match(path, expected_path))
        .unwrap_or(false)
}

fn discovered_local_flaresolverr_pid(system: &System, expected_path: &Path) -> Option<u32> {
    system
        .processes()
        .values()
        .find(|process| process_matches_local_flaresolverr(process, expected_path))
        .map(|process| process.pid().as_u32())
}

fn read_local_flaresolverr_owner() -> Option<LocalFlareSolverrOwner> {
    let text = fs::read_to_string(local_flaresolverr_owner_path()).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_local_flaresolverr_owner(owner: &LocalFlareSolverrOwner) -> Result<(), String> {
    let contents = serde_json::to_string_pretty(owner).map_err(|error| error.to_string())?;
    write_text_file_atomic(&local_flaresolverr_owner_path(), &contents)
}

#[cfg(windows)]
fn local_flaresolverr_job_owns(pid: u32) -> bool {
    FLARESOLVERR_LOCAL_JOB
        .lock()
        .ok()
        .and_then(|job| job.as_ref().map(|job| job.pid == pid))
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn local_flaresolverr_job_owns(_pid: u32) -> bool {
    true
}

#[cfg(windows)]
fn assign_local_flaresolverr_job(pid: u32, process: HANDLE) -> Result<(), String> {
    let mut job_guard = FLARESOLVERR_LOCAL_JOB
        .lock()
        .map_err(|_| "FlareSolverr Job Object state is unavailable.".to_string())?;
    if job_guard.is_some() {
        return Err("A FlareSolverr Job Object is already active.".to_string());
    }

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err("Could not create the FlareSolverr Job Object.".to_string());
        }

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            CloseHandle(job);
            return Err("Could not configure the FlareSolverr Job Object.".to_string());
        }

        let assigned = AssignProcessToJobObject(job, process) != 0;
        if !assigned {
            CloseHandle(job);
            return Err("Could not contain the FlareSolverr process tree.".to_string());
        }

        *job_guard = Some(LocalFlareSolverrJob {
            pid,
            handle: job as usize,
        });
    }
    Ok(())
}

#[cfg(not(windows))]
fn assign_local_flaresolverr_job(_pid: u32) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn spawn_local_flaresolverr_contained(path: &Path) -> Result<u32, String> {
    let application: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let current_dir = path.parent().unwrap_or_else(|| Path::new("."));
    let current_dir: Vec<u16> = current_dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut process_info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            std::ptr::null(),
            current_dir.as_ptr(),
            &startup,
            &mut process_info,
        )
    };
    if created == 0 {
        return Err("Could not start the local FlareSolverr process.".to_string());
    }

    let pid = process_info.dwProcessId;
    if let Err(error) = assign_local_flaresolverr_job(pid, process_info.hProcess) {
        let confirmed = unsafe {
            let terminated = TerminateProcess(process_info.hProcess, 1) != 0;
            let confirmed = terminated && WaitForSingleObject(process_info.hProcess, 5000) == 0;
            CloseHandle(process_info.hThread);
            CloseHandle(process_info.hProcess);
            confirmed
        };
        if !confirmed { return Err(format!("{error}; suspended spawn {pid} termination unconfirmed")); }
        return Err(error);
    }

    let resumed = unsafe { ResumeThread(process_info.hThread) };
    unsafe {
        CloseHandle(process_info.hThread);
        CloseHandle(process_info.hProcess);
    }
    if resumed == u32::MAX {
        release_local_flaresolverr_job(pid);
        return Err("Could not resume the contained FlareSolverr process.".to_string());
    }
    Ok(pid)
}

#[cfg(not(windows))]
fn spawn_local_flaresolverr_contained(path: &Path) -> Result<u32, String> {
    fs::create_dir_all(local_flaresolverr_logs_dir()).map_err(|err| err.to_string())?;
    let stdout_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(local_flaresolverr_stdout_log_path())
        .map_err(|err| err.to_string())?;
    let stderr_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(local_flaresolverr_stderr_log_path())
        .map_err(|err| err.to_string())?;
    let child = Command::new(path)
        .current_dir(path.parent().unwrap_or_else(|| Path::new(".")))
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log))
        .spawn()
        .map_err(|err| err.to_string())?;
    let pid = child.id();
    assign_local_flaresolverr_job(pid)?;
    Ok(pid)
}

#[cfg(windows)]
fn terminate_local_flaresolverr_job(pid: u32) -> Result<(), String> {
    let mut guard = FLARESOLVERR_LOCAL_JOB
        .lock()
        .map_err(|_| "FlareSolverr Job Object state is unavailable.".to_string())?;
    let job = guard.as_ref().ok_or("The FlareSolverr process tree has no active Job Object.")?;
    if job.pid != pid {
        return Err("The FlareSolverr Job Object does not match the ownership lease.".to_string());
    }
    let handle = job.handle as HANDLE;
    if unsafe { TerminateJobObject(handle, 1) } == 0 {
        return Err("FlareSolverr termination failed; job and ownership retained".into());
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let queried = unsafe { QueryInformationJobObject(handle, JobObjectBasicAccountingInformation,
            &mut accounting as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of_val(&accounting) as u32, std::ptr::null_mut()) };
        if queried == 0 { return Err("Cannot confirm FlareSolverr termination; evidence retained".into()); }
        if accounting.ActiveProcesses == 0 {
            unsafe { CloseHandle(handle); }
            guard.take();
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err("FlareSolverr termination timed out; evidence retained".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(not(windows))]
fn terminate_local_flaresolverr_job(_pid: u32) -> Result<(), String> {
    Err("Handle-bound FlareSolverr cleanup unavailable; process preserved".into())
}

#[cfg(windows)]
fn release_local_flaresolverr_job(pid: u32) {
    if !local_flaresolverr_job_owns(pid) {
        return;
    }
    let _ = terminate_local_flaresolverr_job(pid);
}

#[cfg(not(windows))]
fn release_local_flaresolverr_job(_pid: u32) {}

fn validated_owned_local_flaresolverr_pid() -> Option<u32> {
    let expected_path = local_flaresolverr_exe_path();
    let system = System::new_all();
    if let Some(owner) = read_local_flaresolverr_owner() {
        let identity_matches = system
            .process(Pid::from_u32(owner.pid))
            .map(|process| {
                process.start_time() == owner.process_creation_time
                    && process_matches_local_flaresolverr(process, &expected_path)
                    && process_paths_match(Path::new(&owner.executable_path), &expected_path)
            })
            .unwrap_or(false);
        match classify_local_flaresolverr_owner(
            identity_matches,
            owner.job_bound,
            local_flaresolverr_job_owns(owner.pid),
        ) {
            LocalFlareSolverrOwnerState::CurrentInstance => return Some(owner.pid),
            LocalFlareSolverrOwnerState::OtherInstance => {
                // Another Epigraph instance may own the in-memory Job Object.
                // Preserve its lease so only the creating instance can stop it.
                return None;
            }
            LocalFlareSolverrOwnerState::Stale => {}
        }
        // Stale or inconsistent evidence never authorizes termination or deletion.
    }
    None
}

fn get_flaresolverr_local_status_unlocked() -> LocalFlareSolverrStatus {
    let path = local_flaresolverr_exe_path();
    let installed = path.exists();
    let system = System::new_all();
    let discovered_pid = discovered_local_flaresolverr_pid(&system, &path);
    let owned_pid = validated_owned_local_flaresolverr_pid();
    let listener_pid = listener_pid_for_port(8191);
    let endpoint_owned = owned_pid.is_some() && listener_pid == owned_pid;
    LocalFlareSolverrStatus {
        installed,
        running: discovered_pid.is_some(),
        path: installed.then(|| path.to_string_lossy().to_string()),
        message: if discovered_pid.is_some() && owned_pid.is_none() {
            Some(
                "A matching FlareSolverr process is running without an Epigraph ownership lease."
                    .to_string(),
            )
        } else if installed {
            None
        } else {
            Some("Not installed".to_string())
        },
        started_now: false,
        endpoint_owned,
    }
}

#[tauri::command]
fn get_flaresolverr_local_status() -> Result<LocalFlareSolverrStatus, String> {
    let _lifecycle_guard = FLARESOLVERR_LIFECYCLE_LOCK
        .lock()
        .map_err(|_| "FlareSolverr lifecycle is unavailable.".to_string())?;
    let _file_guard = acquire_flaresolverr_lifecycle_file_lock()?;
    Ok(get_flaresolverr_local_status_unlocked())
}

#[tauri::command]
fn start_flaresolverr_local() -> Result<LocalFlareSolverrStatus, String> {
    let _launch = session_control::begin_launch()?;
    let _lifecycle_guard = FLARESOLVERR_LIFECYCLE_LOCK
        .lock()
        .map_err(|_| "FlareSolverr lifecycle is unavailable.".to_string())?;
    let _file_guard = acquire_flaresolverr_lifecycle_file_lock()?;
    let path = local_flaresolverr_exe_path();
    let mut started_now = false;
    if !path.exists() {
        return Ok(get_flaresolverr_local_status_unlocked());
    }
    if validated_owned_local_flaresolverr_pid().is_none() {
        let system = System::new_all();
        if discovered_local_flaresolverr_pid(&system, &path).is_some() {
            return Err(
                "A matching FlareSolverr process is already running without an Epigraph ownership lease."
                    .to_string(),
            );
        }
        if let Some(listener_pid) = listener_pid_for_port(8191) {
            return Err(format!(
                "FlareSolverr port 8191 is already owned by process {listener_pid}."
            ));
        }
        let pid = spawn_local_flaresolverr_contained(&path)?;
        let mut identity = None;
        for _ in 0..20 {
            let system = System::new_all();
            identity = system.process(Pid::from_u32(pid)).and_then(|process| {
                process_matches_local_flaresolverr(process, &path).then(|| LocalFlareSolverrOwner {
                    pid,
                    process_creation_time: process.start_time(),
                    executable_path: path.to_string_lossy().into_owned(),
                    job_bound: true,
                })
            });
            if identity.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let Some(owner) = identity else {
            release_local_flaresolverr_job(pid);
            return Err("FlareSolverr started without a verifiable process identity.".to_string());
        };
        if let Err(error) = write_local_flaresolverr_owner(&owner) {
            release_local_flaresolverr_job(pid);
            return Err(error);
        }
        started_now = true;
    }
    let mut status = get_flaresolverr_local_status_unlocked();
    status.started_now = started_now;
    Ok(status)
}

#[tauri::command]
fn stop_flaresolverr_local() -> Result<LocalFlareSolverrStatus, String> {
    let _lifecycle_guard = FLARESOLVERR_LIFECYCLE_LOCK
        .lock()
        .map_err(|_| "FlareSolverr lifecycle is unavailable.".to_string())?;
    let _file_guard = acquire_flaresolverr_lifecycle_file_lock()?;
    let Some(pid) = validated_owned_local_flaresolverr_pid() else {
        let system = System::new_all();
        if discovered_local_flaresolverr_pid(&system, &local_flaresolverr_exe_path()).is_some() {
            return Err(
                "Refusing to stop a FlareSolverr process without an Epigraph ownership lease."
                    .to_string(),
            );
        }
        return Ok(get_flaresolverr_local_status_unlocked());
    };

    terminate_local_flaresolverr_job(pid)?;
    let _ = fs::remove_file(local_flaresolverr_owner_path());

    for _ in 0..20 {
        let system = System::new_all();
        if discovered_local_flaresolverr_pid(&system, &local_flaresolverr_exe_path()).is_none() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let system = System::new_all();
    if discovered_local_flaresolverr_pid(&system, &local_flaresolverr_exe_path()).is_some() {
        return Err("FlareSolverr did not stop within the ownership timeout.".to_string());
    }
    Ok(get_flaresolverr_local_status_unlocked())
}

fn get_flaresolverr_docker_status_unlocked() -> DockerFlareSolverrStatus {
    let version_output = match run_docker(&["--version"]) {
        Ok(output) => output,
        Err(_) => {
            return DockerFlareSolverrStatus {
                installed: false,
                daemon: false,
                running: false,
                version: None,
                message: Some("Docker not found".to_string()),
                started_now: false,
                endpoint_owned: false,
            };
        }
    };

    if !version_output.status.success() {
        return DockerFlareSolverrStatus {
            installed: false,
            daemon: false,
            running: false,
            version: None,
            message: Some("Docker not found".to_string()),
            started_now: false,
            endpoint_owned: false,
        };
    }

    let version = Some(docker_output_text(&version_output));
    let ps_output = match run_docker(&["ps", "--format", "{{.Names}}"]) {
        Ok(output) => output,
        Err(err) => {
            return DockerFlareSolverrStatus {
                installed: true,
                daemon: false,
                running: false,
                version,
                message: Some(err),
                started_now: false,
                endpoint_owned: false,
            };
        }
    };

    if !ps_output.status.success() {
        return DockerFlareSolverrStatus {
            installed: true,
            daemon: false,
            running: false,
            version,
            message: Some("Docker unavailable".to_string()),
            started_now: false,
            endpoint_owned: false,
        };
    }

    let names = docker_output_text(&ps_output);
    let owned = inspect_flaresolverr_owned();
    let policy_compliant = owned && inspect_flaresolverr_policy_compliant();
    let named_container_running = names
        .lines()
        .any(|name| name.trim() == FLARESOLVERR_CONTAINER_NAME);
    DockerFlareSolverrStatus {
        installed: true,
        daemon: true,
        running: named_container_running && policy_compliant,
        version,
        message: if named_container_running && !owned {
            Some(
                "A Docker container with the Epigraph FlareSolverr name is not owned by Epigraph."
                    .to_string(),
            )
        } else if named_container_running && !policy_compliant {
            Some(
                "The Epigraph-owned FlareSolverr container does not match the current safety policy."
                    .to_string(),
            )
        } else {
            None
        },
        started_now: false,
        endpoint_owned: named_container_running && policy_compliant,
    }
}

#[tauri::command]
fn get_flaresolverr_docker_status() -> Result<DockerFlareSolverrStatus, String> {
    let _lifecycle_guard = FLARESOLVERR_LIFECYCLE_LOCK
        .lock()
        .map_err(|_| "FlareSolverr lifecycle is unavailable.".to_string())?;
    let _file_guard = acquire_flaresolverr_lifecycle_file_lock()?;
    Ok(get_flaresolverr_docker_status_unlocked())
}

#[tauri::command]
fn start_flaresolverr_docker() -> Result<DockerFlareSolverrStatus, String> {
    let _lifecycle_guard = FLARESOLVERR_LIFECYCLE_LOCK
        .lock()
        .map_err(|_| "FlareSolverr lifecycle is unavailable.".to_string())?;
    let _file_guard = acquire_flaresolverr_lifecycle_file_lock()?;
    let mut existing_container = inspect_flaresolverr_container_exists();
    if existing_container && !inspect_flaresolverr_owned() {
        return Err(
            "Refusing to reuse a Docker container without the Epigraph ownership label.".to_string(),
        );
    }

    if existing_container && !inspect_flaresolverr_policy_compliant() {
        if inspect_flaresolverr_running() {
            return Err(
                "Stop the Epigraph-owned FlareSolverr container before applying the current safety policy."
                    .to_string(),
            );
        }
        let output = run_docker(&["rm", FLARESOLVERR_CONTAINER_NAME])?;
        if !output.status.success() {
            return Err(
                "Docker could not replace the outdated Epigraph FlareSolverr container.".to_string(),
            );
        }
        existing_container = false;
    }

    let was_running = existing_container && inspect_flaresolverr_running();
    let started_now = if existing_container {
        let output = run_docker(&["start", FLARESOLVERR_CONTAINER_NAME])?;
        if !output.status.success() {
            return Err("Docker start failed".to_string());
        }
        !was_running
    } else {
        let lease = create_flaresolverr_docker_lease()?;
        let owner_label =
            format!("{FLARESOLVERR_DOCKER_OWNER_LABEL}={FLARESOLVERR_DOCKER_OWNER_VALUE}");
        let lease_label = format!("{FLARESOLVERR_DOCKER_LEASE_LABEL}={lease}");
        let output = run_docker(&[
            "run",
            "-d",
            "--name",
            FLARESOLVERR_CONTAINER_NAME,
            "--label",
            owner_label.as_str(),
            "--label",
            lease_label.as_str(),
            "-p",
            "127.0.0.1:8191:8191",
            "--restart",
            "no",
            "--memory",
            "1g",
            "--cpus",
            "1.0",
            "--pids-limit",
            "256",
            FLARESOLVERR_IMAGE,
        ])?;
        if !output.status.success() {
            return Err("Docker start failed".to_string());
        }
        true
    };

    let mut status = get_flaresolverr_docker_status_unlocked();
    status.started_now = started_now;
    Ok(status)
}

#[tauri::command]
fn stop_flaresolverr_docker() -> Result<DockerFlareSolverrStatus, String> {
    let _lifecycle_guard = FLARESOLVERR_LIFECYCLE_LOCK
        .lock()
        .map_err(|_| "FlareSolverr lifecycle is unavailable.".to_string())?;
    let _file_guard = acquire_flaresolverr_lifecycle_file_lock()?;
    if !inspect_flaresolverr_container_exists() {
        return Ok(get_flaresolverr_docker_status_unlocked());
    }
    if !inspect_flaresolverr_owned() {
        return Err("Refusing to stop a Docker container not owned by Epigraph.".to_string());
    }
    let output = run_docker(&["stop", FLARESOLVERR_CONTAINER_NAME])?;
    if !output.status.success() {
        return Err(format!(
            "Docker stop failed: {}",
            docker_output_text(&output)
        ));
    }
    Ok(get_flaresolverr_docker_status_unlocked())
}

#[tauri::command]
fn open_flaresolverr_local_folder() -> Result<(), String> {
    let folder = local_flaresolverr_exe_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(local_flaresolverr_tools_dir);
    if !folder.exists() {
        return Err("Not installed".to_string());
    }
    Command::new("explorer.exe")
        .arg(folder)
        .spawn()
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_flaresolverr_local_logs() -> Result<(), String> {
    let logs_dir = local_flaresolverr_logs_dir();
    if !logs_dir.exists() {
        return Err("Logs unavailable".to_string());
    }

    let stdout_log = local_flaresolverr_stdout_log_path();
    if stdout_log.exists() {
        Command::new("notepad.exe")
            .arg(stdout_log)
            .spawn()
            .map_err(|err| err.to_string())?;
        return Ok(());
    }

    Command::new("explorer.exe")
        .arg(logs_dir)
        .spawn()
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_app_logs() -> Result<(), String> {
    let logs_dir = app_logs_dir();
    if !logs_dir.exists() {
        return Err("Logs unavailable".to_string());
    }

    let application_log = logs_dir.join("application.log");
    if application_log.exists() {
        Command::new("notepad.exe")
            .arg(application_log)
            .spawn()
            .map_err(|err| err.to_string())?;
        return Ok(());
    }

    Command::new("explorer.exe")
        .arg(logs_dir)
        .spawn()
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_reader_webview(
    app: tauri::AppHandle,
    url: String,
    title: Option<String>,
) -> Result<(), String> {
    let parsed = url::Url::parse(url.trim()).map_err(|e| e.to_string())?;
    let window_title = title.unwrap_or_else(|| "Chapter Web View".to_string());
    let reader_host = parsed.host_str().map(str::to_owned);
    let handle = app.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let label = "reader-webview";

            if let Some(window) = handle.get_webview_window(label) {
                let _ = window.destroy();
            }

            let window = tauri::WebviewWindowBuilder::new(
                &handle,
                label,
                tauri::WebviewUrl::External(parsed),
            )
            .title(window_title)
            .initialization_script(READER_WEBVIEW_INIT_SCRIPT)
            .on_navigation({
                let reader_host = reader_host.clone();
                move |next_url| is_allowed_reader_navigation(reader_host.as_deref(), next_url)
            })
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .inner_size(1280.0, 900.0)
            .min_inner_size(960.0, 700.0)
            .resizable(true)
            .focused(true)
            .build()
            .map_err(|e| e.to_string())?;

            let app_handle = handle.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    let _ = app_handle.emit("reader-webview-state", false);
                }
            });

            handle
                .emit("reader-webview-state", true)
                .map_err(|e| e.to_string())
        })();

        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
async fn close_reader_webview(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    app.run_on_main_thread(move || {
        let result = if let Some(window) = handle.get_webview_window("reader-webview") {
            window.destroy().map_err(|e| e.to_string())
        } else {
            Ok(())
        };
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_tracker_oauth_window(app: tauri::AppHandle, url: String, session_id: Option<String>) -> Result<(), String> {
    let parsed = url::Url::parse(url.trim()).map_err(|e| e.to_string())?;
    let label = tracker_oauth_window_label(session_id.as_deref())?;
    let handle = app.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            for (existing_label, window) in handle.webview_windows() {
                if existing_label == "tracker-oauth" || existing_label.starts_with("tracker-oauth-") {
                    let _ = window.destroy();
                }
            }

            let nav_handle = handle.clone();
            let nav_label = label.clone();
            let window = tauri::WebviewWindowBuilder::new(
                &handle,
                &label,
                tauri::WebviewUrl::External(parsed),
            )
            .title("Tracker Login")
            .on_navigation(move |next_url| {
                if is_tracker_oauth_callback(next_url) {
                    let callback_url = next_url.to_string();
                    let _ = nav_handle.emit(
                        "tracker-oauth-callback",
                        TrackerOAuthCallbackPayload { url: callback_url, session_id: session_id.clone() },
                    );

                    let close_handle = nav_handle.clone();
                    // A delayed close belongs only to this window, never its replacement.
                    let close_label = nav_label.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(250));
                        if let Some(window) = close_handle.get_webview_window(&close_label) {
                            let _ = window.destroy();
                        }
                    });

                    return false;
                }

                true
            })
            .inner_size(980.0, 760.0)
            .min_inner_size(760.0, 600.0)
            .resizable(true)
            .focused(true)
            .build()
            .map_err(|e| e.to_string())?;

            let app_handle = handle.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    let _ = app_handle.emit("tracker-oauth-window-state", false);
                }
            });

            handle
                .emit("tracker-oauth-window-state", true)
                .map_err(|e| e.to_string())
        })();

        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
async fn close_tracker_oauth_window(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let label = tracker_oauth_window_label(Some(&session_id))?;
    if let Some(window) = app.get_webview_window(&label) {
        window.destroy().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn reader_webview_is_open(app: tauri::AppHandle) -> Result<bool, String> {
    let handle = app.clone();
    let (tx, rx) = mpsc::channel::<bool>();

    app.run_on_main_thread(move || {
        let _ = tx.send(handle.get_webview_window("reader-webview").is_some());
    })
    .map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())
}

#[tauri::command]
async fn close_novel_runtime_host(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    app.run_on_main_thread(move || {
        let result = if let Some(window) = handle.get_webview_window(NOVEL_RUNTIME_HOST_LABEL) {
            window.destroy().map_err(|e| e.to_string())
        } else {
            Ok(())
        };
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
async fn novel_runtime_host_is_open(app: tauri::AppHandle) -> Result<bool, String> {
    let handle = app.clone();
    let (tx, rx) = mpsc::channel::<bool>();

    app.run_on_main_thread(move || {
        let _ = tx.send(
            handle
                .get_webview_window(NOVEL_RUNTIME_HOST_LABEL)
                .is_some(),
        );
    })
    .map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())
}

pub(crate) fn books_data_dir() -> PathBuf {
    if let Ok(path) = std::env::var("EPIGRAPH_BOOKS_DATA_DIR_OVERRIDE") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    suwayomi_data_dir().join("books")
}

pub(crate) fn library_cover_cache_dir() -> PathBuf {
    suwayomi_data_dir().join("library-cover-cache")
}

fn library_cover_cache_key(
    profile_id: &str,
    server_url: &str,
    manga_id: i64,
    thumbnail_url: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(profile_id.trim().to_ascii_lowercase().as_bytes());
    hasher.update(b"\0");
    hasher.update(server_url.trim().to_ascii_lowercase().as_bytes());
    hasher.update(b"\0");
    hasher.update(manga_id.to_string().as_bytes());
    hasher.update(b"\0");
    hasher.update(thumbnail_url.trim().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn library_cover_extension_from_content_type(content_type: Option<&str>) -> Option<&'static str> {
    let normalized = content_type?.split(';').next()?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn library_cover_extension_from_url(raw: &str) -> Option<&'static str> {
    let parsed = Url::parse(raw).ok()?;
    let path = parsed.path().to_ascii_lowercase();
    if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        Some("jpg")
    } else if path.ends_with(".png") {
        Some("png")
    } else if path.ends_with(".webp") {
        Some("webp")
    } else if path.ends_with(".gif") {
        Some("gif")
    } else {
        None
    }
}

fn library_cover_cache_candidates(key: &str) -> Vec<PathBuf> {
    ["webp", "jpg", "png", "gif"]
        .into_iter()
        .map(|ext| library_cover_cache_dir().join(format!("{key}.{ext}")))
        .collect()
}

fn find_cached_library_cover_path(key: &str) -> Option<PathBuf> {
    library_cover_cache_candidates(key)
        .into_iter()
        .find(|path| path.is_file())
}

fn downscale_library_cover_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    let image = image::load_from_memory(bytes).ok()?;
    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return None;
    }

    let max_edge = width.max(height);
    let resized = if max_edge > LIBRARY_COVER_THUMB_MAX_EDGE {
        image.resize(
            LIBRARY_COVER_THUMB_MAX_EDGE,
            LIBRARY_COVER_THUMB_MAX_EDGE,
            FilterType::Lanczos3,
        )
    } else {
        image
    };

    let rgb = resized.to_rgb8();
    let mut output = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut output, LIBRARY_COVER_THUMB_JPEG_QUALITY);
    encoder
        .encode(
            &rgb,
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .ok()?;
    Some(output)
}

fn resolve_library_cover_asset_path(
    request: &Request<Vec<u8>>,
) -> Result<PathBuf, Response<Cow<'static, [u8]>>> {
    let encoded_path = request.uri().path();
    if encoded_path.len() <= 1 {
        return Err(book_asset_error(
            StatusCode::BAD_REQUEST,
            "Missing library cover path.",
        ));
    }

    let decoded_path = percent_decode(&encoded_path.as_bytes()[1..])
        .decode_utf8_lossy()
        .to_string();
    if decoded_path.is_empty() {
        return Err(book_asset_error(
            StatusCode::BAD_REQUEST,
            "Missing library cover path.",
        ));
    }

    let candidate = PathBuf::from(decoded_path);
    let root = library_cover_cache_dir();
    let canonical_root = root.canonicalize().map_err(|_| {
        book_asset_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Library cover cache root is unavailable.",
        )
    })?;
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|_| book_asset_error(StatusCode::NOT_FOUND, "Library cover was not found."))?;

    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(book_asset_error(
            StatusCode::FORBIDDEN,
            "Library cover is outside the allowed scope.",
        ));
    }

    Ok(canonical_candidate)
}

fn trim_library_cover_cache_to_limit(max_bytes: u64) -> Result<(), String> {
    let root = library_cover_cache_dir();
    if !root.is_dir() {
        return Ok(());
    }

    let mut entries: Vec<(PathBuf, u64, SystemTime)> = fs::read_dir(&root)
        .map_err(|err| err.to_string())?
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let metadata = fs::metadata(&path).ok()?;
            if !metadata.is_file() {
                return None;
            }
            let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
            Some((path, metadata.len(), modified))
        })
        .collect();

    let mut total: u64 = entries.iter().map(|(_, size, _)| *size).sum();
    if total <= max_bytes {
        return Ok(());
    }

    entries.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in entries {
        if total <= max_bytes {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }

    Ok(())
}

#[tauri::command]
fn get_cached_library_cover(
    profile_id: String,
    server_url: String,
    manga_id: i64,
    thumbnail_url: String,
) -> Result<Option<String>, String> {
    fs::create_dir_all(library_cover_cache_dir()).map_err(|err| err.to_string())?;
    let key = library_cover_cache_key(&profile_id, &server_url, manga_id, &thumbnail_url);
    Ok(find_cached_library_cover_path(&key).map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn cache_library_cover(
    profile_id: String,
    server_url: String,
    manga_id: i64,
    thumbnail_url: String,
    cover_url: String,
    auth_header: Option<String>,
) -> Result<Option<String>, String> {
    let parsed_url = Url::parse(cover_url.trim()).map_err(|err| err.to_string())?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Ok(None);
    }

    let root = library_cover_cache_dir();
    fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    let key = library_cover_cache_key(&profile_id, &server_url, manga_id, &thumbnail_url);
    if let Some(path) = find_cached_library_cover_path(&key) {
        return Ok(Some(path.to_string_lossy().into_owned()));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|err| err.to_string())?;
    let mut request = client.get(parsed_url);
    if let Some(header) = auth_header
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.header(reqwest::header::AUTHORIZATION, header);
    }

    let response = request.send().await.map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Ok(None);
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let bytes = response.bytes().await.map_err(|err| err.to_string())?;
    if bytes.is_empty() || bytes.len() as u64 > LIBRARY_COVER_MAX_DOWNLOAD_BYTES {
        return Ok(None);
    }

    let (cache_bytes, ext): (Vec<u8>, &'static str) =
        if let Some(thumbnail_bytes) = downscale_library_cover_bytes(&bytes) {
            (thumbnail_bytes, "jpg")
        } else {
            let ext = library_cover_extension_from_content_type(content_type.as_deref())
                .or_else(|| library_cover_extension_from_url(&cover_url))
                .unwrap_or("jpg");
            (bytes.to_vec(), ext)
        };

    for candidate in library_cover_cache_candidates(&key) {
        let _ = fs::remove_file(candidate);
    }

    let target = root.join(format!("{key}.{ext}"));
    let tmp = root.join(format!("{key}.{ext}.tmp"));
    fs::write(&tmp, &cache_bytes).map_err(|err| err.to_string())?;
    fs::rename(&tmp, &target).map_err(|err| err.to_string())?;
    let _ = trim_library_cover_cache_to_limit(LIBRARY_COVER_CACHE_MAX_BYTES);

    Ok(Some(target.to_string_lossy().into_owned()))
}

fn book_library_profile_key(profile_id: Option<&str>) -> String {
    profile_id
        .and_then(sanitize_custom_profile_key)
        .unwrap_or_else(|| "main".to_string())
}

/// Desktop Syncd replication reads and writes only the main book library
/// (`book_library_state_path`). Other local profiles keep their own library files and must
/// not be diffed against, or copied into, that file.
fn book_library_write_notifies_replication(profile_id: Option<&str>) -> bool {
    book_library_profile_key(profile_id) == "main"
}

fn book_library_state_path_for_profile(profile_id: Option<&str>) -> Result<PathBuf, String> {
    let root = books_data_dir();
    let profile_key = book_library_profile_key(profile_id);

    if profile_key == "main" {
        std::fs::create_dir_all(&root).map_err(|err| err.to_string())?;
        return Ok(root.join("library-state.json"));
    }

    let scoped_root = root.join("profiles").join(profile_key);
    std::fs::create_dir_all(&scoped_root).map_err(|err| err.to_string())?;
    Ok(scoped_root.join("library-state.json"))
}

pub(crate) fn book_library_state_path() -> Result<PathBuf, String> {
    book_library_state_path_for_profile(Some("main"))
}

fn migration_journal_state_path() -> Result<PathBuf, String> {
    let root = suwayomi_data_dir().join("migration");
    std::fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    Ok(root.join("journal-state.json"))
}

fn book_asset_content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("epub") => "application/epub+zip",
        _ => "application/octet-stream",
    }
}

fn book_asset_response_builder(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", "Range")
        .header(
            "Access-Control-Expose-Headers",
            "Accept-Ranges, Content-Range, Content-Length, Content-Type",
        )
}

fn book_asset_error(status: StatusCode, message: &str) -> Response<Cow<'static, [u8]>> {
    book_asset_response_builder(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Cow::Owned(message.as_bytes().to_vec()))
        .unwrap()
}

fn resolve_book_asset_path(
    request: &Request<Vec<u8>>,
    root: &Path,
) -> Result<PathBuf, Response<Cow<'static, [u8]>>> {
    let encoded_path = request.uri().path();
    if encoded_path.len() <= 1 {
        return Err(book_asset_error(
            StatusCode::BAD_REQUEST,
            "Missing book asset path.",
        ));
    }

    let decoded_path = percent_decode(&encoded_path.as_bytes()[1..])
        .decode_utf8_lossy()
        .to_string();
    if decoded_path.is_empty() {
        return Err(book_asset_error(
            StatusCode::BAD_REQUEST,
            "Missing book asset path.",
        ));
    }

    let candidate = PathBuf::from(decoded_path);

    let canonical_root = root.canonicalize().map_err(|_| {
        book_asset_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Books storage root is unavailable.",
        )
    })?;
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|_| book_asset_error(StatusCode::NOT_FOUND, "Book asset was not found."))?;

    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(book_asset_error(
            StatusCode::FORBIDDEN,
            "Book asset is outside the allowed scope.",
        ));
    }

    Ok(canonical_candidate)
}

fn book_asset_range_not_satisfiable(file_len: u64) -> Response<Cow<'static, [u8]>> {
    book_asset_response_builder(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(CONTENT_RANGE, format!("bytes */{file_len}"))
        .body(Cow::Owned(b"Requested range is invalid.".to_vec()))
        .unwrap()
}

fn book_asset_preflight_response() -> Response<Cow<'static, [u8]>> {
    book_asset_response_builder(StatusCode::NO_CONTENT)
        .header(CONTENT_LENGTH, "0")
        .body(Cow::Owned(Vec::new()))
        .unwrap()
}

fn parse_book_asset_range_header(
    header_value: &str,
    file_len: u64,
) -> Result<Option<(u64, u64)>, Response<Cow<'static, [u8]>>> {
    let trimmed = header_value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let Some(spec) = trimmed.strip_prefix("bytes=") else {
        return Err(book_asset_error(
            StatusCode::BAD_REQUEST,
            "Unsupported range header.",
        ));
    };

    if spec.contains(',') {
        return Err(book_asset_error(
            StatusCode::BAD_REQUEST,
            "Multiple byte ranges are not supported.",
        ));
    }

    if file_len == 0 {
        return Err(book_asset_range_not_satisfiable(file_len));
    }

    let Some((start_raw, end_raw)) = spec.split_once('-') else {
        return Err(book_asset_error(
            StatusCode::BAD_REQUEST,
            "Malformed range header.",
        ));
    };

    if start_raw.is_empty() {
        let suffix_len = end_raw
            .parse::<u64>()
            .map_err(|_| book_asset_error(StatusCode::BAD_REQUEST, "Malformed range header."))?;
        if suffix_len == 0 {
            return Err(book_asset_range_not_satisfiable(file_len));
        }
        let start = file_len.saturating_sub(suffix_len);
        return Ok(Some((start, file_len - 1)));
    }

    let start = start_raw
        .parse::<u64>()
        .map_err(|_| book_asset_error(StatusCode::BAD_REQUEST, "Malformed range header."))?;
    if start >= file_len {
        return Err(book_asset_range_not_satisfiable(file_len));
    }

    let end = if end_raw.trim().is_empty() {
        file_len - 1
    } else {
        let requested_end = end_raw
            .parse::<u64>()
            .map_err(|_| book_asset_error(StatusCode::BAD_REQUEST, "Malformed range header."))?;
        requested_end.min(file_len - 1)
    };

    if end < start {
        return Err(book_asset_range_not_satisfiable(file_len));
    }

    Ok(Some((start, end)))
}

fn read_book_asset_bytes(
    path: &Path,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, Response<Cow<'static, [u8]>>> {
    let mut file = fs::File::open(path)
        .map_err(|_| book_asset_error(StatusCode::NOT_FOUND, "Book asset could not be read."))?;
    file.seek(SeekFrom::Start(start)).map_err(|_| {
        book_asset_error(StatusCode::INTERNAL_SERVER_ERROR, "Book asset seek failed.")
    })?;

    let mut bytes = Vec::new();
    let length = end.saturating_sub(start) + 1;
    file.take(length).read_to_end(&mut bytes).map_err(|_| {
        book_asset_error(StatusCode::INTERNAL_SERVER_ERROR, "Book asset read failed.")
    })?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};

    #[test]
    fn server_health_probes_do_not_hold_the_calling_thread() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server_url = format!("http://{}", listener.local_addr().unwrap());
        let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        let started = std::time::Instant::now();
        let (healthy, ticked_at) = runtime.block_on(async move {
            let probe = tokio::spawn(probe_server_health(server_url));
            let ticker = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                started.elapsed()
            });
            let ticked_at = ticker.await.unwrap();
            (probe.await.unwrap(), ticked_at)
        });
        drop(listener);
        assert!(!healthy, "a server that never answers is not healthy");
        assert!(ticked_at < Duration::from_millis(1000), "other work waited {ticked_at:?} behind a hanging probe");
    }

    #[test]
    fn tracker_oauth_callbacks_identify_the_request_without_breaking_legacy_payloads() {
        let legacy = TrackerOAuthCallbackPayload { url: "https://suwayomi.org/tracker-oauth?code=test".into(), session_id: None };
        assert_eq!(serde_json::to_value(legacy).unwrap(), serde_json::json!({ "url": "https://suwayomi.org/tracker-oauth?code=test" }));
        let scoped = TrackerOAuthCallbackPayload { url: "callback".into(), session_id: Some("request-id".into()) };
        assert_eq!(serde_json::to_value(scoped).unwrap()["sessionId"], "request-id");
    }

    #[test]
    fn tracker_oauth_window_identity_cannot_close_a_later_request() {
        let first = tracker_oauth_window_label(None).unwrap();
        let second = tracker_oauth_window_label(None).unwrap();
        assert_ne!(first, second);
        let session = uuid::Uuid::new_v4().to_string();
        assert_eq!(tracker_oauth_window_label(Some(&session)).unwrap(), tracker_oauth_window_label(Some(&session)).unwrap());
        assert!(tracker_oauth_window_label(Some("../main")).is_err());
    }

    #[test]
    fn book_storage_names_reject_paths_devices_and_alternate_streams() {
        for id in ["../../escape", "..\\escape", "C:\\escape", "CON", "book:stream", "", ".", "book."] {
            assert!(validated_book_filename(id, "epub").is_err(), "accepted {id}");
        }
        for ext in ["../../exe", "pdf:stream", "", "pdf\\escape"] {
            assert!(validated_book_filename("book-123", ext).is_err(), "accepted {ext}");
        }
        assert_eq!(validated_book_filename("book-123", ".EPUB").unwrap(), "book-123.epub");
    }

    #[test]
    fn book_cover_bytes_must_match_a_supported_image_format() {
        assert!(validate_book_cover_bytes(b"not an image", "png").is_err());

        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .unwrap();
        assert!(validate_book_cover_bytes(&png, "png").is_ok());
        assert!(validate_book_cover_bytes(&png, "jpg").is_err());
    }

    #[test]
    fn removing_book_assets_cannot_escape_the_managed_root() {
        let root = std::env::temp_dir().join(format!("epigraph-book-remove-{}", uuid::Uuid::new_v4()));
        let managed = root.join("covers").join("book.png");
        let outside = std::env::temp_dir().join(format!("epigraph-outside-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(managed.parent().unwrap()).unwrap();
        fs::write(&managed, b"managed").unwrap();
        fs::write(&outside, b"outside").unwrap();

        assert!(remove_managed_book_asset(&root, &managed).is_ok());
        assert!(!managed.exists());
        assert!(remove_managed_book_asset(&root, &outside).is_err());
        assert!(outside.exists());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&outside);
    }

    fn encode_book_asset_uri(path: &Path) -> String {
        format!(
            "http://book.localhost/{}",
            utf8_percent_encode(&path.to_string_lossy(), NON_ALPHANUMERIC)
        )
    }

    #[test]
    fn decodes_percent_encoded_windows_book_asset_paths() {
        let request = Request::builder()
            .uri("http://book.localhost/C%3A%5CUsers%5Cjhow-%5CAppData%5CRoaming%5Cepigraph%5Cbooks%5Ccovers%5Ccover.jpg")
            .body(Vec::<u8>::new())
            .unwrap();

        let decoded_path = percent_decode(&request.uri().path().as_bytes()[1..])
            .decode_utf8_lossy()
            .to_string();

        assert_eq!(
            decoded_path,
            r"C:\Users\jhow-\AppData\Roaming\epigraph\books\covers\cover.jpg"
        );
    }

    #[test]
    fn parses_explicit_book_asset_range() {
        assert_eq!(
            parse_book_asset_range_header("bytes=100-199", 1000).unwrap(),
            Some((100, 199))
        );
    }

    #[test]
    fn parses_suffix_book_asset_range() {
        assert_eq!(
            parse_book_asset_range_header("bytes=-200", 1000).unwrap(),
            Some((800, 999))
        );
    }

    #[test]
    fn rejects_unsatisfiable_book_asset_range() {
        let response = parse_book_asset_range_header("bytes=1000-1200", 1000).unwrap_err();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }

    #[test]
    fn stable_release_policy_excludes_drafts_prereleases_and_malformed_tags() {
        assert!(is_public_stable_release("v1.2.3", false, false));
        assert!(is_public_stable_release("1.2.3", false, false));
        assert!(!is_public_stable_release("v1.2.3", true, false));
        assert!(!is_public_stable_release("v1.2.3", false, true));
        assert!(!is_public_stable_release("v1.2.3-beta.1", false, false));
        assert!(!is_public_stable_release("latest", false, false));
    }

    #[test]
    fn flaresolverr_runtime_artifacts_are_pinned_and_owned() {
        assert_eq!(
            FLARESOLVERR_IMAGE,
            "ghcr.io/flaresolverr/flaresolverr@sha256:7962759d99d7e125e108e0f5e7f3cdbcd36161776d058d1d9b7153b92ef1af9e"
        );
        assert_eq!(FLARESOLVERR_DOCKER_OWNER_LABEL, "com.epigraph.managed");
        assert_eq!(FLARESOLVERR_DOCKER_OWNER_VALUE, "flaresolverr");

        let owner = LocalFlareSolverrOwner {
            pid: 42,
            process_creation_time: 100,
            executable_path: r"C:\Epigraph\tools\flaresolverr.exe".to_string(),
            job_bound: true,
        };
        let serialized = serde_json::to_string(&owner).unwrap();
        let restored: LocalFlareSolverrOwner = serde_json::from_str(&serialized).unwrap();

        assert_eq!(restored.pid, owner.pid);
        assert_eq!(restored.process_creation_time, owner.process_creation_time);
        assert_eq!(restored.executable_path, owner.executable_path);
        assert!(restored.job_bound);

        assert_eq!(
            classify_local_flaresolverr_owner(true, true, true),
            LocalFlareSolverrOwnerState::CurrentInstance
        );
        assert_eq!(
            classify_local_flaresolverr_owner(true, true, false),
            LocalFlareSolverrOwnerState::OtherInstance
        );
        assert_eq!(
            classify_local_flaresolverr_owner(false, true, false),
            LocalFlareSolverrOwnerState::Stale
        );
    }

    #[test]
    fn flaresolverr_docker_policy_rejects_spoofed_or_unbounded_containers() {
        let lease = "lease-123";
        let valid = serde_json::json!([{
            "Config": {
                "Image": FLARESOLVERR_IMAGE,
                "Labels": {
                    "com.epigraph.managed": FLARESOLVERR_DOCKER_OWNER_VALUE,
                    "com.epigraph.owner": lease,
                }
            },
            "HostConfig": {
                "Memory": FLARESOLVERR_DOCKER_MEMORY_BYTES,
                "NanoCpus": FLARESOLVERR_DOCKER_NANO_CPUS,
                "PidsLimit": FLARESOLVERR_DOCKER_PIDS_LIMIT,
                "RestartPolicy": { "Name": "no" },
                "PortBindings": { "8191/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "8191" }] }
            }
        }]);
        assert!(docker_container_has_ownership_lease(&valid, lease));
        assert!(docker_container_matches_policy(&valid, lease));

        let mut wrong_image = valid.clone();
        wrong_image[0]["Config"]["Image"] =
            serde_json::json!("ghcr.io/flaresolverr/flaresolverr:latest");
        assert!(docker_container_has_ownership_lease(&wrong_image, lease));
        assert!(!docker_container_matches_policy(&wrong_image, lease));

        let mut wrong_lease = valid.clone();
        wrong_lease[0]["Config"]["Labels"][FLARESOLVERR_DOCKER_LEASE_LABEL] =
            serde_json::json!("other-install");
        assert!(!docker_container_has_ownership_lease(&wrong_lease, lease));
        assert!(!docker_container_matches_policy(&wrong_lease, lease));

        let mut public_binding = valid.clone();
        public_binding[0]["HostConfig"]["PortBindings"]["8191/tcp"][0]["HostIp"] =
            serde_json::json!("0.0.0.0");
        assert!(docker_container_has_ownership_lease(&public_binding, lease));
        assert!(!docker_container_matches_policy(&public_binding, lease));

        let mut unbounded = valid;
        unbounded[0]["HostConfig"]["Memory"] = serde_json::json!(0);
        assert!(docker_container_has_ownership_lease(&unbounded, lease));
        assert!(!docker_container_matches_policy(&unbounded, lease));
    }

    #[test]
    fn serve_book_asset_options_returns_cors_headers() {
        let request = Request::builder()
            .method("OPTIONS")
            .uri("http://book.localhost/C%3A%5Cbooks%5Cdemo.epub")
            .body(Vec::<u8>::new())
            .unwrap();

        let response = serve_book_asset(request);

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response
                .headers()
                .get("Access-Control-Allow-Origin")
                .and_then(|value| value.to_str().ok()),
            Some("*")
        );
        assert_eq!(
            response
                .headers()
                .get("Access-Control-Allow-Methods")
                .and_then(|value| value.to_str().ok()),
            Some("GET, HEAD, OPTIONS")
        );
        assert_eq!(
            response
                .headers()
                .get("Access-Control-Allow-Headers")
                .and_then(|value| value.to_str().ok()),
            Some("Range")
        );
        assert_eq!(
            response
                .headers()
                .get("Access-Control-Expose-Headers")
                .and_then(|value| value.to_str().ok()),
            Some("Accept-Ranges, Content-Range, Content-Length, Content-Type")
        );
    }

    #[test]
    fn serve_book_asset_head_and_get_share_functional_header_contract() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("reader-contract.epub");
        std::fs::write(&path, b"epub-contract").unwrap();
        let uri = encode_book_asset_uri(&path);

        let head_request = Request::builder()
            .method("HEAD")
            .uri(&uri)
            .body(Vec::<u8>::new())
            .unwrap();
        let get_request = Request::builder()
            .method("GET")
            .uri(&uri)
            .body(Vec::<u8>::new())
            .unwrap();

        let head_response = serve_book_asset_from(head_request, folder.path());
        let get_response = serve_book_asset_from(get_request, folder.path());

        for header_name in [
            "Access-Control-Allow-Origin",
            "Access-Control-Allow-Methods",
            "Access-Control-Allow-Headers",
            "Access-Control-Expose-Headers",
            "Accept-Ranges",
            "Content-Length",
            "Content-Type",
        ] {
            assert_eq!(
                head_response.headers().get(header_name),
                get_response.headers().get(header_name),
                "header mismatch for {header_name}"
            );
        }

        assert_eq!(head_response.status(), StatusCode::OK);
        assert_eq!(get_response.status(), StatusCode::OK);
    }

    #[test]
    fn serve_book_asset_range_returns_partial_content_with_exposed_headers() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("reader-contract.pdf");
        std::fs::write(&path, b"0123456789").unwrap();
        let uri = encode_book_asset_uri(&path);

        let request = Request::builder()
            .method("GET")
            .uri(&uri)
            .header(RANGE, "bytes=0-0")
            .body(Vec::<u8>::new())
            .unwrap();

        let response = serve_book_asset_from(request, folder.path());

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok()),
            Some("bytes 0-0/10")
        );
        assert_eq!(
            response
                .headers()
                .get("Access-Control-Expose-Headers")
                .and_then(|value| value.to_str().ok()),
            Some("Accept-Ranges, Content-Range, Content-Length, Content-Type")
        );
    }

    #[test]
    fn writes_server_owner_atomically_without_leaving_tmp_file() {
        let temp = std::env::temp_dir().join(format!("epigraph-owner-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();

        let owner_path = server_owner_path(&temp);
        let owner = ServerOwner {
            profile_key: "TEST".to_string(),
            root_dir: temp.to_string_lossy().into_owned(),
            app_pid: 123,
            java_pid: 456,
            port: 4667,
            server_url: "http://127.0.0.1:4667".to_string(),
            started_at: 1,
            run_id: None,
            spawned_by_app: false,
            process_identity: None,
        };

        write_server_owner_atomic(&owner_path, &owner).unwrap();

        assert!(owner_path.exists());
        assert!(!server_owner_tmp_path(&temp).exists());
        let round_trip = read_server_owner(&owner_path).unwrap();
        assert_eq!(round_trip.profile_key, "TEST");
        assert_eq!(round_trip.port, 4667);

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn patches_suwayomi_runtime_conf_for_balanced_updates() {
        let patched = patch_suwayomi_runtime_conf(
            r#"server.webUIEnabled = true
server.initialOpenInBrowserEnabled = true
server.systemTrayEnabled = true
server.globalUpdateInterval = 12
server.webUIUpdateCheckInterval = 23
server.maxSourcesInParallel = 6
"#
            .to_string(),
            "\"127.0.0.1\"",
            4567,
            LocalServerUpdateIntensity::Balanced,
        );

        assert!(patched.contains("server.webUIEnabled = false"));
        assert!(patched.contains("server.initialOpenInBrowserEnabled = false"));
        assert!(patched.contains("server.systemTrayEnabled = false"));
        assert!(patched.contains("server.globalUpdateInterval = 0"));
        assert!(patched.contains("server.webUIUpdateCheckInterval = 0"));
        assert!(patched.contains("server.maxSourcesInParallel = 2"));
    }

    #[test]
    fn maps_update_intensity_to_source_parallelism() {
        assert_eq!(
            LocalServerUpdateIntensity::from_option(Some("eco")).max_sources_in_parallel(),
            1
        );
        assert_eq!(
            LocalServerUpdateIntensity::from_option(Some("balanced")).max_sources_in_parallel(),
            2
        );
        assert_eq!(
            LocalServerUpdateIntensity::from_option(Some("fast")).max_sources_in_parallel(),
            3
        );
        assert_eq!(
            LocalServerUpdateIntensity::from_option(Some("unknown")).max_sources_in_parallel(),
            2
        );
        assert_eq!(
            LocalServerUpdateIntensity::from_option(None).max_sources_in_parallel(),
            2
        );
    }

    #[test]
    fn local_server_java_args_enable_extension_bytecode_compatibility() {
        let args = local_server_java_args(Path::new("C:\\fake\\Suwayomi-Server.jar"));
        assert!(args
            .iter()
            .any(|arg| arg == LOCAL_SERVER_JAVA_EXTENSION_COMPAT_FLAG));
        assert!(
            args.iter()
                .position(|arg| arg == LOCAL_SERVER_JAVA_EXTENSION_COMPAT_FLAG)
                < args.iter().position(|arg| arg == "-jar")
        );
    }

    #[test]
    fn startup_event_drain_keeps_reading_while_the_spawning_worker_blocks() {
        // spawn_server probes synchronously on a runtime worker; the child's output must
        // still be consumed or Suwayomi blocks writing its log before binding the port.
        let drained = tauri::async_runtime::block_on(tauri::async_runtime::spawn(async {
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            spawn_main_startup_event_drain(rx, std::env::temp_dir().join("unused.log"), 0);
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut sent = 0;
            while sent < 32 && std::time::Instant::now() < deadline {
                if tx.try_send(CommandEvent::Stdout(b"line".to_vec())).is_ok() {
                    sent += 1;
                } else {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            sent
        }))
        .expect("probe task");
        assert_eq!(drained, 32);
    }

    #[test]
    fn resolve_local_server_target_marks_main_and_test_profiles() {
        let main_target = LaunchTargetInfo {
            server_url_override: Some("http://127.0.0.1:4567".to_string()),
            profile_label_override: Some("MAIN".to_string()),
            server_auth_enabled_override: None,
            server_auth_user_override: None,
            server_auth_pass_override: None,
            audit_open_override: None,
            audit_manga_id_override: None,
            audit_chapter_id_override: None,
            audit_book_id_override: None,
            audit_manga_backup_override: None,
            audit_books_backup_override: None,
            audit_novels_backup_override: None,
            audit_epigraph_backup_override: None,
            restore_manga_backup_override: None,
            restore_epigraph_backup_override: None,
            restore_handoff_override: None,
            restore_source_profile_override: None,
            attach_only_override: None,
        };
        let main =
            resolve_local_server_target(&main_target, Some("http://127.0.0.1:4567"), None, None)
                .unwrap();
        assert_eq!(main.profile.key(), "main");
        assert_eq!(main.port, 4567);
        assert!(!main.attach_only);

        let test_target = LaunchTargetInfo {
            server_url_override: Some("http://127.0.0.1:4667".to_string()),
            profile_label_override: Some("TEST".to_string()),
            server_auth_enabled_override: None,
            server_auth_user_override: None,
            server_auth_pass_override: None,
            audit_open_override: None,
            audit_manga_id_override: None,
            audit_chapter_id_override: None,
            audit_book_id_override: None,
            audit_manga_backup_override: None,
            audit_books_backup_override: None,
            audit_novels_backup_override: None,
            audit_epigraph_backup_override: None,
            restore_manga_backup_override: None,
            restore_epigraph_backup_override: None,
            restore_handoff_override: None,
            restore_source_profile_override: None,
            attach_only_override: Some(true),
        };
        let test =
            resolve_local_server_target(&test_target, Some("http://127.0.0.1:4667"), None, None)
                .unwrap();
        assert_eq!(test.profile.key(), "test");
        assert_eq!(test.port, 4667);
        assert!(test.attach_only);
    }
    #[test]
    fn resolve_local_server_target_uses_custom_profile_root() {
        let launch_target = LaunchTargetInfo {
            server_url_override: None,
            profile_label_override: None,
            server_auth_enabled_override: None,
            server_auth_user_override: None,
            server_auth_pass_override: None,
            audit_open_override: None,
            audit_manga_id_override: None,
            audit_chapter_id_override: None,
            audit_book_id_override: None,
            audit_manga_backup_override: None,
            audit_books_backup_override: None,
            audit_novels_backup_override: None,
            audit_epigraph_backup_override: None,
            restore_manga_backup_override: None,
            restore_epigraph_backup_override: None,
            restore_handoff_override: None,
            restore_source_profile_override: None,
            attach_only_override: None,
        };

        let target = resolve_local_server_target(
            &launch_target,
            Some("http://127.0.0.1:4777"),
            Some("sandbox"),
            Some("Sandbox"),
        )
        .unwrap();

        assert_eq!(target.profile_key, "sandbox");
        assert_eq!(target.port, 4777);
        assert_eq!(target.root_dir, local_server_custom_profile_root("sandbox"));
    }

    #[test]
    fn managed_startup_assigns_only_main_to_the_persistent_core() {
        assert_eq!(
            managed_startup_owner("main", 4567),
            ManagedStartupOwner::PersistentCore
        );
        assert_eq!(
            managed_startup_owner("test", 4667),
            ManagedStartupOwner::Desktop
        );
        assert_eq!(
            managed_startup_owner("sandbox", 4781),
            ManagedStartupOwner::Desktop
        );
    }

    #[test]
    fn reset_local_profile_data_resolves_builtin_profiles() {
        let main_root = reset_local_profile_root("main").unwrap();
        let test_root = reset_local_profile_root("test").unwrap();

        assert_eq!(
            main_root,
            local_server_profile_root(LocalServerProfile::Main)
        );
        assert_eq!(
            test_root,
            local_server_profile_root(LocalServerProfile::Test)
        );
    }

    #[test]
    fn reconciliation_overlay_root_follows_active_profile_root() {
        let launch_target = LaunchTargetInfo {
            server_url_override: None,
            profile_label_override: None,
            server_auth_enabled_override: None,
            server_auth_user_override: None,
            server_auth_pass_override: None,
            audit_open_override: None,
            audit_manga_id_override: None,
            audit_chapter_id_override: None,
            audit_book_id_override: None,
            audit_manga_backup_override: None,
            audit_books_backup_override: None,
            audit_novels_backup_override: None,
            audit_epigraph_backup_override: None,
            restore_manga_backup_override: None,
            restore_epigraph_backup_override: None,
            restore_handoff_override: None,
            restore_source_profile_override: None,
            attach_only_override: None,
        };

        let main_root = reconciliation_overlay_root_for_server_url(
            &launch_target,
            Some("http://127.0.0.1:4567"),
        );
        let test_root = reconciliation_overlay_root_for_server_url(
            &launch_target,
            Some("http://127.0.0.1:4667"),
        );

        assert_eq!(
            main_root,
            local_server_profile_root(LocalServerProfile::Main)
        );
        assert_eq!(
            test_root,
            local_server_profile_root(LocalServerProfile::Test)
        );
        assert_ne!(main_root, test_root);
    }

    #[test]
    fn default_downloads_path_follows_requested_profile() {
        let main = resolve_downloads_path_for_profile("", Some("main"));
        let test = resolve_downloads_path_for_profile("", Some("test"));
        let custom = resolve_downloads_path_for_profile("", Some("sandbox"));

        assert_eq!(
            main,
            local_server_profile_root(LocalServerProfile::Main).join("downloads")
        );
        assert_eq!(
            test,
            local_server_custom_profile_root("test").join("downloads")
        );
        assert_eq!(
            custom,
            local_server_custom_profile_root("sandbox").join("downloads")
        );
        assert_ne!(main, test);
        assert_ne!(main, custom);
    }

    #[test]
    fn reconciliation_overlay_root_falls_back_for_non_local_targets() {
        let launch_target = LaunchTargetInfo {
            server_url_override: Some("https://example.com".to_string()),
            profile_label_override: Some("CUSTOM".to_string()),
            server_auth_enabled_override: None,
            server_auth_user_override: None,
            server_auth_pass_override: None,
            audit_open_override: None,
            audit_manga_id_override: None,
            audit_chapter_id_override: None,
            audit_book_id_override: None,
            audit_manga_backup_override: None,
            audit_books_backup_override: None,
            audit_novels_backup_override: None,
            audit_epigraph_backup_override: None,
            restore_manga_backup_override: None,
            restore_epigraph_backup_override: None,
            restore_handoff_override: None,
            restore_source_profile_override: None,
            attach_only_override: None,
        };

        let root =
            reconciliation_overlay_root_for_server_url(&launch_target, Some("https://example.com"));
        assert_eq!(root, suwayomi_data_dir());
    }

    #[test]
    fn automation_launch_overrides_parse_local_app_data_dir_and_syncd_port() {
        let overrides = parse_automation_launch_overrides_from_args([
            "--local-app-data-dir=C:\\Temp\\EpigraphHost",
            "--syncd-port=4988",
            "--syncd-bootstrap-ttl-seconds=9",
            "--webdriver-automation",
        ]);

        assert_eq!(
            overrides.local_app_data_dir,
            Some(PathBuf::from("C:\\Temp\\EpigraphHost"))
        );
        assert_eq!(overrides.syncd_port, Some(4988));
        assert_eq!(overrides.syncd_bootstrap_ttl_seconds, Some(9));
        assert!(overrides.webdriver_automation);
    }

    #[test]
    fn dev_isolation_uses_its_own_folder_unless_one_is_given() {
        let root = PathBuf::from(r"C:\Users\dev\AppData\Local\Epigraph-dev");
        let mut isolated = AutomationLaunchOverrides {
            syncd_port: Some(4988),
            ..AutomationLaunchOverrides::default()
        };
        apply_dev_data_isolation(&mut isolated, &root);
        assert_eq!(isolated.local_app_data_dir, Some(root.join("LocalAppData")));
        assert_eq!(isolated.syncd_port, Some(4988));
        assert_eq!(isolated.local_server_ports, Some(DEV_LOCAL_SERVER_PORTS));
        assert_ne!(DEV_LOCAL_SERVER_PORTS.0, 4567, "the release's MAIN server port");
        assert_ne!(DEV_LOCAL_SERVER_PORTS.1, 4667, "the release's TEST server port");
        assert_eq!(
            automation_local_server_root(isolated.local_app_data_dir.as_ref().unwrap(), LocalServerProfile::Main),
            root.join("LocalServerMain")
        );
        assert_eq!(
            automation_roaming_app_data_path(isolated.local_app_data_dir.as_ref().unwrap()),
            root.join("RoamingAppData")
        );

        let mut explicit = parse_automation_launch_overrides_from_args([
            r"--local-app-data-dir=C:\Temp\EpigraphHost",
            "--syncd-port=4988",
        ]);
        apply_dev_data_isolation(&mut explicit, &root);
        assert_eq!(explicit.local_app_data_dir, Some(PathBuf::from(r"C:\Temp\EpigraphHost")));
        assert_eq!(explicit.syncd_port, Some(4988));
        assert_eq!(explicit.local_server_ports, None, "a gate's own --server-url picks its ports");
    }

    #[test]
    fn automation_launch_overrides_ignore_invalid_syncd_port() {
        let overrides = parse_automation_launch_overrides_from_args([
            "--local-app-data-dir=C:\\Temp\\EpigraphJoiner",
            "--syncd-port=not-a-port",
            "--syncd-bootstrap-ttl-seconds=still-bad",
        ]);

        assert_eq!(
            overrides.local_app_data_dir,
            Some(PathBuf::from("C:\\Temp\\EpigraphJoiner"))
        );
        assert_eq!(overrides.syncd_port, None);
        assert_eq!(overrides.syncd_bootstrap_ttl_seconds, None);
        assert!(!overrides.webdriver_automation);
    }

    #[test]
    fn automation_launch_overrides_roaming_neighbor_is_deterministic() {
        let local = PathBuf::from(r"C:\Temp\EpigraphHost\LocalAppData");
        let roaming = automation_roaming_app_data_path(&local);

        assert_eq!(roaming, PathBuf::from(r"C:\Temp\EpigraphHost\RoamingAppData"));
    }

    #[test]
    fn automation_launch_overrides_local_server_roots_are_isolated_per_profile() {
        let local = PathBuf::from(r"C:\Temp\EpigraphHost\LocalAppData");

        assert_eq!(
            automation_local_server_root(&local, LocalServerProfile::Main),
            PathBuf::from(r"C:\Temp\EpigraphHost\LocalServerMain")
        );
        assert_eq!(
            automation_local_server_root(&local, LocalServerProfile::Test),
            PathBuf::from(r"C:\Temp\EpigraphHost\LocalServerTest")
        );
    }

    #[cfg(all(debug_assertions, windows))]
    #[test]
    fn webview2_remote_debugging_flag_detection_is_generic() {
        assert!(has_webview2_remote_debugging_flag(
            "--enable-logging --remote-debugging-port=0 --test-type=webdriver"
        ));
        assert!(has_webview2_remote_debugging_flag(
            "--remote-debugging-port=9223"
        ));
        assert!(!has_webview2_remote_debugging_flag(
            "--enable-logging --test-type=webdriver"
        ));
    }

    #[test]
    fn relocated_managed_server_is_used_only_when_its_owner_record_names_the_serving_java() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("LocalServerMain");
        std::fs::create_dir_all(&root).unwrap();
        // No owner record in the relocated root: whatever answers on the port belongs to someone else.
        assert!(!managed_owner_accepts(&root, 4567, |_, _| true));

        let owner = |root_dir: &Path, port: u16| {
            serde_json::json!({
                "profileKey": "main", "rootDir": root_dir.to_string_lossy(), "appPid": 1, "javaPid": 4242,
                "port": port, "serverUrl": format!("http://127.0.0.1:{port}"), "startedAt": 1,
            })
            .to_string()
        };
        std::fs::write(root.join("server.owner.json"), owner(&root, 4567)).unwrap();
        assert!(managed_owner_accepts(&root, 4567, |pid, served| pid == 4242 && served == root.as_path()));
        assert!(!managed_owner_accepts(&root, 4567, |_, _| false), "the recorded Java must serve this root");
        assert!(!managed_owner_accepts(&root, 4667, |_, _| true), "the record must be for this port");

        std::fs::write(root.join("server.owner.json"), owner(&temp.path().join("epigraph-main"), 4567)).unwrap();
        assert!(!managed_owner_accepts(&root, 4567, |_, _| true), "a record for another root is foreign");
    }

    #[test]
    fn ownership_refresh_loads_the_command_line_it_checks() {
        let mut system = System::new();
        let pid = Pid::from_u32(std::process::id());
        refresh_process_command_line(&mut system, pid);
        let cmd = system.process(pid).map(|process| process.cmd().to_vec()).unwrap_or_default();
        assert!(!cmd.is_empty(), "the rootDir proof lives in the command line, so it must be refreshed");
    }

    #[test]
    fn validate_server_owner_rejects_dead_java_pid() {
        let temp =
            std::env::temp_dir().join(format!("epigraph-owner-validate-{}", std::process::id()));
        let target = LocalServerTarget {
            profile: LocalServerProfile::Test,
            profile_key: "test".to_string(),
            root_dir: temp.clone(),
            server_url: "http://127.0.0.1:4667".to_string(),
            port: 4667,
            attach_only: false,
        };
        let owner = ServerOwner {
            profile_key: "TEST".to_string(),
            root_dir: temp.to_string_lossy().into_owned(),
            app_pid: 1,
            java_pid: u32::MAX,
            port: 4667,
            server_url: "http://127.0.0.1:4667".to_string(),
            started_at: 1,
            run_id: None,
            spawned_by_app: false,
            process_identity: None,
        };

        assert!(matches!(
            validate_server_owner(&target, &owner),
            OwnerReuseDecision::Stale
        ));
    }

    #[cfg(windows)]
    #[test]
    fn desktop_server_owner_is_reconciled_only_after_its_java_process_is_gone() {
        use std::os::windows::process::CommandExt;
        let temp = tempfile::tempdir().unwrap();
        let owner_path = server_owner_path(temp.path());
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 60"])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let owner = ServerOwner {
            profile_key: "test".to_string(),
            root_dir: temp.path().to_string_lossy().into_owned(),
            app_pid: std::process::id(),
            java_pid: child.id(),
            port: 4667,
            server_url: "http://127.0.0.1:4667".to_string(),
            started_at: 1,
            run_id: Some(uuid::Uuid::new_v4().to_string()),
            spawned_by_app: true,
            process_identity: runtime_process_identity(child.id()),
        };
        write_server_owner_atomic(&owner_path, &owner).unwrap();
        assert!(
            !confirm_exited_server_owner(&owner_path),
            "a live server keeps its ownership"
        );
        child.kill().unwrap(); // Only this disposable child; simulates a reboot or crash.
        child.wait().unwrap();
        assert!(confirm_exited_server_owner(&owner_path));
        assert!(suwayomi_runtime::has_confirmed_stop(&owner_path));
    }

    #[test]
    fn spawn_lock_left_by_a_dead_start_never_blocks_but_a_live_one_does() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("server.spawn.lock");
        std::fs::write(&path, b"pid=invalid\ntimestamp=0\n").unwrap();
        let lease = acquire_spawn_lock(&path, temp.path()).unwrap().unwrap();
        assert!(acquire_spawn_lock(&path, temp.path()).unwrap().is_none());
        drop(lease);
        assert!(acquire_spawn_lock(&path, temp.path()).unwrap().is_some());
    }

    #[cfg(windows)]
    #[test]
    fn parse_windows_listener_pid_for_port_finds_listening_pid() {
        let sample = r#"
  TCP    127.0.0.1:4567         0.0.0.0:0              LISTENING       18756
  TCP    127.0.0.1:4667         0.0.0.0:0              LISTENING       16164
"#;
        assert_eq!(
            parse_windows_listener_pid_for_port(sample, 4567),
            Some(18756)
        );
        assert_eq!(
            parse_windows_listener_pid_for_port(sample, 4667),
            Some(16164)
        );
        assert_eq!(parse_windows_listener_pid_for_port(sample, 9999), None);
    }

    #[test]
    fn rootdir_flag_matches_exact_profile_root_only() {
        let test_flag =
            r"-Dsuwayomi.tachidesk.config.server.rootDir=C:\Users\jhow-\AppData\Roaming\epigraph";
        let main_flag = r"-Dsuwayomi.tachidesk.config.server.rootDir=C:\Users\jhow-\AppData\Roaming\epigraph-main";

        assert!(rootdir_flag_matches_arg(test_flag, test_flag));
        assert!(rootdir_flag_matches_arg(main_flag, main_flag));
        assert!(!rootdir_flag_matches_arg(main_flag, test_flag));
        assert!(!rootdir_flag_matches_arg(test_flag, main_flag));
    }
}

fn serve_book_asset(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    serve_book_asset_from(request, &books_data_dir())
}

/// Serves a file under `root`; the tests pass a temporary folder so they never write into the user's books.
fn serve_book_asset_from(request: Request<Vec<u8>>, root: &Path) -> Response<Cow<'static, [u8]>> {
    if request.method().as_str().eq_ignore_ascii_case("OPTIONS") {
        return book_asset_preflight_response();
    }

    let path = match resolve_book_asset_path(&request, root) {
        Ok(path) => path,
        Err(response) => return response,
    };

    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(_) => return book_asset_error(StatusCode::NOT_FOUND, "Book asset could not be read."),
    };
    let file_len = metadata.len();

    let requested_range = match request
        .headers()
        .get(RANGE)
        .and_then(|value| value.to_str().ok())
    {
        Some(value) => match parse_book_asset_range_header(value, file_len) {
            Ok(range) => range,
            Err(response) => return response,
        },
        None => None,
    };

    let (status, start, end) = match requested_range {
        Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end),
        None => (StatusCode::OK, 0, file_len.saturating_sub(1)),
    };
    let content_len = if file_len == 0 || end < start {
        0
    } else {
        end - start + 1
    };

    let mut builder = book_asset_response_builder(status)
        .header(CONTENT_TYPE, book_asset_content_type(&path))
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_LENGTH, content_len.to_string());

    if requested_range.is_some() {
        builder = builder.header(CONTENT_RANGE, format!("bytes {start}-{end}/{file_len}"));
    }

    if request.method().as_str().eq_ignore_ascii_case("HEAD") {
        return builder.body(Cow::Owned(Vec::new())).unwrap();
    }

    match read_book_asset_bytes(&path, start, end) {
        Ok(bytes) => builder.body(Cow::Owned(bytes)).unwrap(),
        Err(response) => response,
    }
}

fn serve_library_cover_asset(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    if request.method().as_str().eq_ignore_ascii_case("OPTIONS") {
        return book_asset_preflight_response();
    }

    let path = match resolve_library_cover_asset_path(&request) {
        Ok(path) => path,
        Err(response) => return response,
    };

    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return book_asset_error(StatusCode::NOT_FOUND, "Library cover could not be read.")
        }
    };
    let file_len = metadata.len();

    let builder = book_asset_response_builder(StatusCode::OK)
        .header(CONTENT_TYPE, book_asset_content_type(&path))
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .header(CONTENT_LENGTH, file_len.to_string());

    if request.method().as_str().eq_ignore_ascii_case("HEAD") {
        return builder.body(Cow::Owned(Vec::new())).unwrap();
    }

    match fs::read(&path) {
        Ok(bytes) => builder.body(Cow::Owned(bytes)).unwrap(),
        Err(_) => book_asset_error(StatusCode::NOT_FOUND, "Library cover could not be read."),
    }
}

fn is_allowed_reader_navigation(reader_host: Option<&str>, next_url: &url::Url) -> bool {
    let Some(host) = next_url.host_str() else {
        return matches!(next_url.scheme(), "about" | "data" | "blob");
    };

    if let Some(reader_host) = reader_host {
        if host == reader_host {
            return true;
        }
    }

    let blocked = [
        "doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "adnxs.com",
        "taboola.com",
        "outbrain.com",
        "exoclick.com",
        "popads.net",
        "propellerads.com",
        "adsterra.com",
        "clickadu.com",
        "hilltopads.net",
        "trafficjunky.net",
        "juicyads.com",
    ];

    !blocked
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(PathBuf::from(path)).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn write_file_base64(path: String, bytes_base64: String) -> Result<String, String> {
    let destination = PathBuf::from(path.trim());
    if destination.as_os_str().is_empty() {
        return Err("Destination path cannot be empty.".to_string());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|err| err.to_string())?;
    // Exports and offline chapters may overwrite an earlier good file; never leave it torn.
    write_book_bytes_atomic(&destination, &bytes)?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn compute_file_sha256(path: String) -> Result<String, String> {
    let mut file = fs::File::open(PathBuf::from(path)).map_err(|err| err.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let read = file.read(&mut buffer).map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
fn copy_book_import(source_path: String, book_id: String) -> Result<String, String> {
    let source = PathBuf::from(source_path);
    if !source.exists() {
        return Err("Selected book file no longer exists.".to_string());
    }

    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim_matches('.').to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "epub" | "pdf"))
        .ok_or_else(|| "Only EPUB and PDF book files are supported.".to_string())?;

    let folder = match ext.as_str() {
        "epub" => "epubs",
        "pdf" => "pdfs",
        _ => unreachable!("validated extension"),
    };

    let dest_dir = books_data_dir().join(folder);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest_path = dest_dir.join(validated_book_filename(&book_id, &ext)?);
    let temp_path = dest_path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut input = std::fs::File::open(&source).map_err(|e| e.to_string())?;
        let mut output = std::fs::File::create(&temp_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        atomic_replace_file(&temp_path, &dest_path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result?;
    Ok(dest_path.to_string_lossy().to_string())
}

fn validated_book_filename(book_id: &str, ext: &str) -> Result<String, String> {
    let id = book_id.trim();
    if id.is_empty()
        || id.len() > 160
        || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid book identifier.".to_string());
    }

    let upper = id.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit()
            && upper.as_bytes()[3] != b'0');
    if reserved {
        return Err("Invalid book identifier.".to_string());
    }

    let normalized_ext = ext.trim().trim_matches('.').to_ascii_lowercase();
    if normalized_ext.is_empty()
        || normalized_ext.len() > 10
        || !normalized_ext.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err("Invalid book file extension.".to_string());
    }

    Ok(format!("{id}.{normalized_ext}"))
}

#[cfg(test)]
mod restore_library_persistence_tests {
    use super::*;
    #[test]
    fn invalid_snapshot_preserves_existing_library() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("library.json");
        fs::write(&path, b"{\"version\":1}").unwrap();
        assert!(write_restore_library_snapshot(&path, "{broken").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"version\":1}");
    }
    #[test]
    fn acknowledged_snapshot_is_complete_and_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("library.json");
        fs::write(&path, b"{\"version\":1}").unwrap();
        write_restore_library_snapshot(&path, "{\"version\":1,\"entries\":[]}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"version\":1,\"entries\":[]}");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn application_commands_are_reserved_for_the_main_window() {
        assert!(is_trusted_command_webview("main"));
        assert!(!is_trusted_command_webview(NOVEL_RUNTIME_HOST_LABEL));
        assert!(!is_trusted_command_webview("reader-webview"));
        assert!(!is_trusted_command_webview("tracker-oauth"));
        assert!(!is_trusted_command_webview("detached-reader-1"));
        assert!(!is_trusted_command_webview("Main"));
    }
    #[test]
    fn only_main_book_library_writes_reach_the_main_bound_replication() {
        assert!(book_library_write_notifies_replication(None));
        assert!(book_library_write_notifies_replication(Some("main")));
        assert!(book_library_write_notifies_replication(Some(" Main ")));
        assert!(book_library_write_notifies_replication(Some(
            "not a valid key"
        )));
        assert!(!book_library_write_notifies_replication(Some("work")));
        assert!(!book_library_write_notifies_replication(Some("Reading-2")));
    }
    #[test]
    fn base64_export_replaces_an_existing_file_without_temporary_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backup.tachibk");
        fs::write(&path, b"previous backup").unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"new backup");
        write_file_base64(path.to_string_lossy().into_owned(), encoded).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new backup");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        assert!(write_file_base64(
            path.to_string_lossy().into_owned(),
            "not base64!".to_string()
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"new backup");
    }
}

fn write_restore_library_snapshot(path: &Path, contents: &str) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(contents).map_err(|_| "RESTORE_LIBRARY_INVALID_JSON")?;
    if !value.is_object() { return Err("RESTORE_LIBRARY_INVALID_JSON".into()); }
    write_book_bytes_atomic(path, contents.as_bytes())
}

fn write_book_bytes_atomic(dest_path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp_path = dest_path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = std::fs::File::create(&temp_path).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        atomic_replace_file(&temp_path, dest_path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

#[tauri::command]
fn write_book_cover(book_id: String, bytes_base64: String, ext: String) -> Result<String, String> {
    let ext = ext.trim().trim_matches('.').to_ascii_lowercase();
    if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif") {
        return Err("Unsupported book cover format.".to_string());
    }
    let filename = validated_book_filename(&book_id, &ext)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|e| e.to_string())?;
    validate_book_cover_bytes(&bytes, &ext)?;
    let dest_dir = books_data_dir().join("covers");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest_path = dest_dir.join(filename);
    write_book_bytes_atomic(&dest_path, &bytes)?;
    Ok(dest_path.to_string_lossy().to_string())
}

fn validate_book_cover_bytes(bytes: &[u8], ext: &str) -> Result<(), String> {
    let detected = image::guess_format(bytes).map_err(|_| "Book cover is not a valid image.".to_string())?;
    let matches_extension = match ext {
        "jpg" | "jpeg" => detected == image::ImageFormat::Jpeg,
        "png" => detected == image::ImageFormat::Png,
        "webp" => detected == image::ImageFormat::WebP,
        "gif" => detected == image::ImageFormat::Gif,
        _ => false,
    };
    if !matches_extension {
        return Err("Book cover bytes do not match the selected image format.".to_string());
    }
    image::load_from_memory_with_format(bytes, detected)
        .map(|_| ())
        .map_err(|_| "Book cover image could not be decoded.".to_string())
}

#[tauri::command]
fn write_book_asset(book_id: String, bytes_base64: String, ext: String) -> Result<String, String> {
    let ext = ext.trim().trim_matches('.').to_ascii_lowercase();
    let folder = match ext.as_str() {
        "epub" => "epubs",
        "pdf" => "pdfs",
        _ => return Err("Only EPUB and PDF book assets are supported.".to_string()),
    };

    let filename = validated_book_filename(&book_id, &ext)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|e| e.to_string())?;
    let dest_dir = books_data_dir().join(folder);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest_path = dest_dir.join(filename);
    write_book_bytes_atomic(&dest_path, &bytes)?;
    Ok(dest_path.to_string_lossy().to_string())
}

#[tauri::command]
fn remove_book_assets(
    asset_path: Option<String>,
    cover_path: Option<String>,
) -> Result<(), String> {
    let root = books_data_dir();
    for path in [asset_path, cover_path].into_iter().flatten() {
        let candidate = PathBuf::from(path);
        if !candidate.exists() {
            continue;
        }
        remove_managed_book_asset(&root, &candidate)?;
    }
    Ok(())
}

fn remove_managed_book_asset(root: &Path, candidate: &Path) -> Result<(), String> {
    let canonical_root = fs::canonicalize(root)
        .map_err(|_| "Managed books directory is unavailable.".to_string())?;
    let canonical_candidate = fs::canonicalize(candidate)
        .map_err(|_| "Book asset no longer exists.".to_string())?;
    if !canonical_candidate.starts_with(&canonical_root) || !canonical_candidate.is_file() {
        return Err("Refusing to remove a file outside the managed books directory.".to_string());
    }
    fs::remove_file(canonical_candidate).map_err(|e| e.to_string())
}

// ── Update types ──────────────────────────────────────────────────────────────

/// A single GitHub release returned to the frontend.
#[derive(Serialize, Clone)]
pub struct ReleaseInfo {
    pub tag_name: String,
    pub name: String,
    pub body: String,
    pub published_at: String,
    pub html_url: String,
}

#[derive(Serialize, Clone)]
pub struct EpigraphUpdateStatus {
    pub update_available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub body: Option<String>,
    pub published_at: Option<String>,
}

/// Progress event emitted during download — matches what the frontend listens for.
#[derive(Clone, serde::Serialize)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Strip the \\?\ extended-length path prefix that Windows adds to long paths.
/// Java and many other tools do not accept this prefix and will fail silently.
fn strip_unc(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

fn resolve_downloads_path_for_profile(downloads_path: &str, profile_id: Option<&str>) -> PathBuf {
    if !downloads_path.trim().is_empty() {
        return PathBuf::from(downloads_path);
    }
    let profile_key =
        local_server_profile_key_from_id(profile_id).unwrap_or_else(|| "main".to_string());
    let root = if profile_key == "main" {
        local_server_profile_root(LocalServerProfile::Main)
    } else {
        local_server_custom_profile_root(&profile_key)
    };
    root.join("downloads")
}

#[tauri::command]
fn get_storage_info(downloads_path: String, profile_id: Option<String>) -> Result<StorageInfo, String> {
    let path = resolve_downloads_path_for_profile(&downloads_path, profile_id.as_deref());

    let manga_bytes = if path.exists() {
        WalkDir::new(&path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter_map(|e| e.metadata().ok())
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .sum()
    } else {
        0
    };

    let stat_path = if path.exists() {
        path.clone()
    } else {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
    };

    let disks = Disks::new_with_refreshed_list();
    let disk = disks
        .iter()
        .filter(|d| stat_path.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .ok_or_else(|| "Could not find disk for path".to_string())?;

    Ok(StorageInfo {
        manga_bytes,
        total_bytes: disk.total_space(),
        free_bytes: disk.available_space(),
        path: path.to_string_lossy().into_owned(),
    })
}

/// Returns the resolved default downloads path for the current platform/profile.
/// This mirrors resolve_downloads_path_for_profile("") so the frontend can display it.
#[tauri::command]
fn get_default_downloads_path(profile_id: Option<String>) -> String {
    resolve_downloads_path_for_profile("", profile_id.as_deref())
        .to_string_lossy()
        .into_owned()
}

/// Suwayomi's `SafePath.buildValidFilename`, which names a source's and a series' download folders: trims
/// dots and spaces, replaces characters FAT/NTFS reject with `_`, and keeps at most 240 UTF-8 bytes.
fn suwayomi_safe_filename(value: &str) -> String {
    let trimmed = value.trim_matches(|ch| ch == '.' || ch == ' ');
    if trimmed.is_empty() {
        return "(invalid)".to_string();
    }
    let mut name = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        let ch = if (ch as u32) <= 31 || matches!(ch, '"' | '*' | '/' | ':' | '<' | '>' | '?' | '\\' | '|' | '\u{7f}') {
            '_'
        } else {
            ch
        };
        if name.len() + ch.len_utf8() > 240 {
            break;
        }
        name.push(ch);
    }
    name
}

fn download_name_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Finds the CBZ Suwayomi wrote for a downloaded chapter, without reading it.
fn find_downloaded_chapter_archive(
    downloads_path: &str,
    source_name: &str,
    manga_title: &str,
    chapter_name: &str,
    scanlator: Option<&str>,
    profile_id: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let root = resolve_downloads_path_for_profile(downloads_path, profile_id);
    let manga_dir = root
        .join("mangas")
        .join(suwayomi_safe_filename(&source_name))
        .join(suwayomi_safe_filename(&manga_title));
    if !manga_dir.is_dir() {
        return Ok(None);
    }

    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let manga_dir = manga_dir
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !manga_dir.starts_with(&root) {
        return Err("Downloaded chapter path escaped the downloads directory.".to_string());
    }

    let chapter_key = download_name_key(chapter_name);
    let scanlator_key = scanlator
        .map(download_name_key)
        .filter(|value| !value.is_empty());
    let mut best_match: Option<(u8, PathBuf)> = None;

    for entry in std::fs::read_dir(&manga_dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file()
            || path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| !value.eq_ignore_ascii_case("cbz"))
                .unwrap_or(true)
        {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let stem_key = download_name_key(stem);
        let score = if stem_key == chapter_key {
            2
        } else if stem_key.ends_with(&chapter_key)
            && scanlator_key
                .as_ref()
                .map(|value| stem_key.starts_with(value))
                .unwrap_or(true)
        {
            3
        } else {
            0
        };
        if score > best_match.as_ref().map(|(best, _)| *best).unwrap_or(0) {
            best_match = Some((score, path));
        }
    }

    Ok(best_match.map(|(_, path)| path))
}

/// Returns true if the given path exists and is a directory.
#[tauri::command]
fn check_path_exists(path: String) -> bool {
    std::path::Path::new(path.trim()).is_dir()
}

/// Creates a directory and all missing parent directories.
#[tauri::command]
fn create_directory(path: String) -> Result<(), String> {
    std::fs::create_dir_all(path.trim()).map_err(|e| e.to_string())
}

pub(crate) fn process_is_alive(pid: u32) -> bool {
    let system = System::new_all();
    system.process(Pid::from_u32(pid)).is_some()
}

fn rootdir_flag_matches_arg(arg: &str, rootdir_flag: &str) -> bool {
    let normalized_arg = arg.trim().trim_matches('"');
    let normalized_flag = rootdir_flag.trim().trim_matches('"');
    #[cfg(windows)]
    {
        normalized_arg.eq_ignore_ascii_case(normalized_flag)
    }
    #[cfg(not(windows))]
    {
        normalized_arg == normalized_flag
    }
}

fn java_process_uses_rootdir(process: &sysinfo::Process, rootdir_flag: &str) -> bool {
    let name = process.name().to_string_lossy().to_ascii_lowercase();
    if !name.contains("java") {
        return false;
    }

    process
        .cmd()
        .iter()
        .any(|arg| rootdir_flag_matches_arg(&arg.to_string_lossy(), rootdir_flag))
}

pub(crate) fn find_java_pid_for_rootdir(data_dir: &Path) -> Option<u32> {
    let rootdir_flag = format!(
        "-Dsuwayomi.tachidesk.config.server.rootDir={}",
        data_dir.to_string_lossy()
    );
    let system = System::new_all();
    system
        .processes()
        .values()
        .find(|process| java_process_uses_rootdir(process, &rootdir_flag))
        .map(|process| process.pid().as_u32())
}

fn java_pid_uses_rootdir(pid: u32, data_dir: &Path) -> bool {
    let rootdir_flag = format!(
        "-Dsuwayomi.tachidesk.config.server.rootDir={}",
        data_dir.to_string_lossy()
    );
    let system = System::new_all();
    system
        .process(Pid::from_u32(pid))
        .map(|process| java_process_uses_rootdir(process, &rootdir_flag))
        .unwrap_or(false)
}

fn runtime_process_identity(pid: u32) -> Option<suwayomi_runtime::RuntimeProcessIdentity> {
    suwayomi_runtime::capture_process_identity(pid)
}

pub(crate) fn set_runtime_status(
    app: &tauri::AppHandle,
    state: suwayomi_runtime::RuntimeLifecycleState,
    profile_id: Option<String>,
    server_url: Option<String>,
    pid: Option<u32>,
    message: Option<String>,
) {
    if let Ok(mut status) = app.state::<RuntimeSupervisorState>().0.lock() {
        *status = suwayomi_runtime::RuntimeStatus {
            state,
            profile_id,
            server_url,
            pid,
            message,
        };
    }
}

#[tauri::command]
fn get_local_runtime_status(
    state: tauri::State<'_, RuntimeSupervisorState>,
) -> suwayomi_runtime::RuntimeStatus {
    state
        .0
        .lock()
        .map(|status| status.clone())
        .unwrap_or_default()
}

#[cfg(windows)]
fn parse_windows_listener_pid_for_port(netstat_output: &str, port: u16) -> Option<u32> {
    let suffix = format!(":{}", port);
    for line in netstat_output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with("TCP") {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        let local_addr = parts[1];
        let state = parts[3];
        if !local_addr.ends_with(&suffix) || !state.eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        if let Ok(pid) = parts[4].parse::<u32>() {
            return Some(pid);
        }
    }
    None
}

fn listener_pid_for_port(port: u16) -> Option<u32> {
    #[cfg(windows)]
    {
        let output = Command::new("netstat")
            .args(["-ano", "-p", "tcp"])
            .output()
            .ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        return parse_windows_listener_pid_for_port(&stdout, port);
    }

    #[cfg(unix)]
    {
        let output = Command::new("lsof")
            .args(["-nP", &format!("-iTCP:{}", port), "-sTCP:LISTEN", "-t"])
            .output()
            .ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        return stdout
            .lines()
            .find_map(|line| line.trim().parse::<u32>().ok());
    }

    #[allow(unreachable_code)]
    None
}

fn server_owner_path(data_dir: &Path) -> PathBuf {
    data_dir.join("server.owner.json")
}

fn server_owner_tmp_path(data_dir: &Path) -> PathBuf {
    data_dir.join("server.owner.json.tmp")
}

fn server_spawn_lock_path(data_dir: &Path) -> PathBuf {
    data_dir.join("server.spawn.lock")
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn unix_now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn local_server_profile_root(profile: LocalServerProfile) -> PathBuf {
    if let Some(override_path) = local_server_profile_root_override(profile) {
        return override_path;
    }

    match profile {
        LocalServerProfile::Test => suwayomi_data_dir(),
        LocalServerProfile::Main => {
            #[cfg(target_os = "windows")]
            {
                dirs::data_dir()
                    .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"))
                    .join("epigraph-main")
            }
            #[cfg(target_os = "macos")]
            {
                dirs::data_dir()
                    .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from("~")))
                    .join("epigraph-main")
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                let base = std::env::var("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|_| dirs::data_dir().unwrap_or_else(|| PathBuf::from("/tmp")));
                base.join("epigraph-main")
            }
        }
    }
}

/// Follows `APPDATA` like the Core's `profile_roots_base`, so a debug build's redirected app data also holds its
/// custom profiles instead of the installed release's roaming folder.
fn local_server_custom_profile_root(profile_key: &str) -> PathBuf {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from).or_else(dirs::data_dir);
    #[cfg(not(target_os = "windows"))]
    let base = dirs::data_dir();
    base.unwrap_or_else(suwayomi_data_dir)
        .join(format!("epigraph-profile-{profile_key}"))
}

fn local_server_root_for_profile_key(profile_key: &str) -> PathBuf {
    match profile_key {
        "main" => local_server_profile_root(LocalServerProfile::Main),
        "test" => local_server_profile_root(LocalServerProfile::Test),
        custom => local_server_custom_profile_root(custom),
    }
}

fn local_server_builtin_profile_from_key(profile_key: &str) -> LocalServerProfile {
    match profile_key {
        "main" => LocalServerProfile::Main,
        _ => LocalServerProfile::Test,
    }
}

fn is_builtin_local_server_profile_key(profile_key: &str) -> bool {
    matches!(profile_key, "main" | "test")
}

fn is_loopback_http_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
}

fn resolve_local_server_target(
    launch_target: &LaunchTargetInfo,
    requested_url: Option<&str>,
    requested_profile_id: Option<&str>,
    requested_profile_label: Option<&str>,
) -> Result<LocalServerTarget, SpawnError> {
    let attach_only = launch_target.attach_only_override.unwrap_or(false);
    let normalized_url = requested_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| SpawnError::SpawnFailed("Missing local server URL".to_string()))?
        .trim_end_matches('/')
        .to_string();

    if !is_loopback_http_url(&normalized_url) {
        return Err(SpawnError::SpawnFailed(
            "Auto-start only supports localhost targets.".to_string(),
        ));
    }

    let parsed = Url::parse(&normalized_url)
        .map_err(|_| SpawnError::SpawnFailed("Invalid local server URL".to_string()))?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| SpawnError::SpawnFailed("Local server URL is missing a port".to_string()))?;

    let label = requested_profile_label
        .or(launch_target.profile_label_override.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let profile_key = local_server_profile_key_from_id(requested_profile_id)
        .or_else(|| label.and_then(sanitize_custom_profile_key))
        .or_else(|| match launch_target.profile_label_override.as_deref() {
            Some("MAIN") => Some("main".to_string()),
            Some("TEST") => Some("test".to_string()),
            _ => None,
        })
        .or_else(|| {
            Some(if port == default_local_server_port(LocalServerProfile::Main) {
                "main".to_string()
            } else if port == default_local_server_port(LocalServerProfile::Test) {
                "test".to_string()
            } else {
                format!("profile-{port}")
            })
        })
        .unwrap_or_else(|| "test".to_string());
    let profile = local_server_builtin_profile_from_key(&profile_key);

    Ok(LocalServerTarget {
        profile,
        profile_key: profile_key.clone(),
        root_dir: local_server_root_for_profile_key(&profile_key),
        server_url: normalized_url,
        port,
        attach_only,
    })
}

fn probe_local_server(server_url: &str, timeout: Duration) -> bool {
    let Ok(url) = Url::parse(server_url) else {
        return false;
    };
    let host = match url.host_str() {
        Some(host) => host,
        None => return false,
    };
    let port = match url.port_or_known_default() {
        Some(port) => port,
        None => return false,
    };
    let address = format!("{host}:{port}");
    let Ok(socket_addr) = address
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
        .ok_or(())
    else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&socket_addr, timeout) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let body = r#"{"query":"query{__typename}"}"#;
    let request = format!(
        "POST /api/graphql HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );

    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let _ = stream.shutdown(Shutdown::Write);

    let mut response = String::new();
    let Ok(read) = stream.read_to_string(&mut response) else {
        return false;
    };
    if read == 0 {
        return false;
    }

    let status_ok = response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200");
    status_ok
        && response.contains("\"data\"")
        && response.contains("\"__typename\"")
        && response.contains("\"Query\"")
}

const LOCAL_SERVER_HEALTH_PROBE_TIMEOUT: Duration = Duration::from_millis(2500);

// Synchronous commands run on the main thread, and a refused loopback connect takes ~2s on
// Windows; queued probes while Suwayomi is down would stall every other IPC call, including
// opening downloaded chapters offline.
#[tauri::command]
async fn probe_server_health(server_url: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        probe_local_server(&server_url, LOCAL_SERVER_HEALTH_PROBE_TIMEOUT)
            && relocated_managed_server_is_owned(&server_url)
    })
    .await
    .unwrap_or(false)
}

/// A launch with a relocated profile root (automation, disposable profiles) shares the managed
/// ports with the user's own install. Whatever answers there is only this launch's server when the
/// owner record in the relocated root names the Java process that serves it; otherwise another
/// profile's Suwayomi would silently receive this profile's reads and writes.
fn relocated_managed_server_is_owned(server_url: &str) -> bool {
    let Ok(url) = Url::parse(server_url) else {
        return true;
    };
    if !matches!(url.host_str(), Some("127.0.0.1") | Some("localhost")) {
        return true;
    }
    let Some(port) = url.port_or_known_default() else {
        return true;
    };
    for profile in [LocalServerProfile::Main, LocalServerProfile::Test] {
        if default_local_server_port(profile) != port {
            continue;
        }
        if let Some(root) = local_server_profile_root_override(profile) {
            return managed_owner_accepts(&root, port, java_pid_serves_root);
        }
    }
    true
}

fn managed_owner_accepts(root: &Path, port: u16, java_serves_root: impl Fn(u32, &Path) -> bool) -> bool {
    let Some(owner) = read_server_owner(&root.join("server.owner.json")) else {
        return false;
    };
    owner.port == port
        && owner.java_pid != 0
        && syncd_sidecar::paths_identical(Path::new(&owner.root_dir), root)
        && java_serves_root(owner.java_pid, root)
}

fn java_pid_serves_root(pid: u32, root: &Path) -> bool {
    let rootdir_flag = format!(
        "-Dsuwayomi.tachidesk.config.server.rootDir={}",
        root.to_string_lossy()
    );
    let mut system = System::new();
    let pid = Pid::from_u32(pid);
    refresh_process_command_line(&mut system, pid);
    system
        .process(pid)
        .is_some_and(|process| java_process_uses_rootdir(process, &rootdir_flag))
}

/// A plain process refresh leaves the command line empty, and the rootDir argument is the proof.
fn refresh_process_command_line(system: &mut System, pid: Pid) {
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        true,
        sysinfo::ProcessRefreshKind::new().with_cmd(sysinfo::UpdateKind::Always),
    );
}

fn read_conf_value(contents: &str, key: &str) -> Option<String> {
    contents
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            let (line_key, raw_value) = trimmed.split_once('=')?;
            if line_key.trim() != key {
                return None;
            }
            Some(
                raw_value
                    .split('#')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .trim_matches('"')
                    .to_string(),
            )
        })
        .filter(|value| !value.is_empty())
}

fn read_server_conf_diagnostics(root_dir: &Path) -> Option<ServerConfDiagnostics> {
    let contents = std::fs::read_to_string(root_dir.join("server.conf")).ok()?;
    Some(ServerConfDiagnostics {
        global_update_interval: read_conf_value(&contents, "server.globalUpdateInterval"),
        max_sources_in_parallel: read_conf_value(&contents, "server.maxSourcesInParallel"),
        web_ui_enabled: read_conf_value(&contents, "server.webUIEnabled"),
        web_ui_update_check_interval: read_conf_value(&contents, "server.webUIUpdateCheckInterval"),
    })
}

#[tauri::command]
fn get_runtime_diagnostics(app: tauri::AppHandle) -> RuntimeDiagnostics {
    let mut system = System::new_all();
    system.refresh_all();

    let app_pid = std::process::id();
    let app_process = system.process(Pid::from_u32(app_pid));
    let app_memory_bytes = app_process.map(|process| process.memory()).unwrap_or(0);
    let app_virtual_memory_bytes = app_process
        .map(|process| process.virtual_memory())
        .unwrap_or(0);
    let app_cpu_percent = app_process
        .map(|process| process.cpu_usage())
        .unwrap_or(0.0);

    let local_server_root = {
        let state = app.state::<ServerState>();
        let guard = state.0.lock().unwrap();
        guard
            .as_ref()
            .and_then(|running| running.owner_path.parent().map(Path::to_path_buf))
    };
    let java_pid = local_server_root
        .as_ref()
        .and_then(|root_dir| find_java_pid_for_rootdir(root_dir));
    let java_process = java_pid.and_then(|pid| system.process(Pid::from_u32(pid)));
    let java_memory_bytes = java_process.map(|process: &sysinfo::Process| process.memory());
    let java_virtual_memory_bytes =
        java_process.map(|process: &sysinfo::Process| process.virtual_memory());
    let java_cpu_percent = java_process.map(|process: &sysinfo::Process| process.cpu_usage());
    let local_server_profile = local_server_root.as_ref().and_then(|root| {
        if root == &local_server_profile_root(LocalServerProfile::Main) {
            Some("main".to_string())
        } else if root == &local_server_profile_root(LocalServerProfile::Test) {
            Some("test".to_string())
        } else {
            None
        }
    });
    let server_conf = local_server_root
        .as_ref()
        .and_then(|root| read_server_conf_diagnostics(root));

    RuntimeDiagnostics {
        app_pid,
        app_memory_bytes,
        app_virtual_memory_bytes,
        app_cpu_percent,
        java_pid,
        java_memory_bytes,
        java_virtual_memory_bytes,
        java_cpu_percent,
        local_server_profile,
        server_conf,
        total_processes: system.processes().len(),
        startup_diagnostics_enabled: startup_diagnostics_enabled(),
    }
}

/// Shares the long-path-safe replace used by the runtime maintenance state.
fn atomic_replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    suwayomi_maintenance::atomic_replace_file(from, to)
}

fn write_server_owner_atomic(owner_path: &Path, owner: &ServerOwner) -> std::io::Result<()> {
    let tmp_path = owner_path.with_extension("json.tmp");
    if let Some(parent) = owner_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let payload = serde_json::to_vec_pretty(owner)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err.to_string()))?;
    {
        let mut file = std::fs::File::create(&tmp_path)?;
        file.write_all(&payload)?;
        file.sync_all()?;
    }

    atomic_replace_file(&tmp_path, owner_path)?;
    Ok(())
}

fn read_server_owner(owner_path: &Path) -> Option<ServerOwner> {
    let text = std::fs::read_to_string(owner_path).ok()?;
    serde_json::from_str::<ServerOwner>(&text).ok()
}

/// A server ended by a reboot or crash never receives a graceful stop receipt. Records the receipt
/// only when its Java process is proven gone, so the profile can start again; live or
/// unverifiable owners are preserved.
fn confirm_exited_server_owner(owner_path: &Path) -> bool {
    let Ok(raw) = std::fs::read(owner_path) else {
        return false;
    };
    let Ok(owner) = serde_json::from_slice::<ServerOwner>(&raw) else {
        return false;
    };
    suwayomi_runtime::confirm_exited_owner(
        owner_path,
        &raw,
        owner.java_pid,
        owner.process_identity.as_ref(),
    )
}


fn validate_server_owner(target: &LocalServerTarget, owner: &ServerOwner) -> OwnerReuseDecision {
    if owner.profile_key.to_ascii_lowercase() != target.profile_key
        || owner.root_dir != target.root_dir.to_string_lossy()
        || owner.server_url.trim_end_matches('/') != target.server_url
        || owner.port != target.port
    {
        return OwnerReuseDecision::Stale;
    }

    if !process_is_alive(owner.java_pid) {
        return OwnerReuseDecision::Stale;
    }

    let rootdir_flag = format!(
        "-Dsuwayomi.tachidesk.config.server.rootDir={}",
        target.root_dir.to_string_lossy()
    );
    let system = System::new_all();
    let Some(process) = system.process(Pid::from_u32(owner.java_pid)) else {
        return OwnerReuseDecision::Stale;
    };
    if !java_process_uses_rootdir(process, &rootdir_flag) {
        return OwnerReuseDecision::Stale;
    }

    if !owner.run_id.as_ref().is_some_and(|run| uuid::Uuid::parse_str(run).is_ok_and(|id| !id.is_nil())) {
        return OwnerReuseDecision::Stale;
    }
    let Some(expected) = &owner.process_identity else { return OwnerReuseDecision::Stale; };
    let Some(actual) = runtime_process_identity(owner.java_pid) else { return OwnerReuseDecision::Stale; };
    if expected != &actual { return OwnerReuseDecision::Stale; }

    if !probe_local_server(&target.server_url, LOCAL_SERVER_HEALTH_PROBE_TIMEOUT) {
        return OwnerReuseDecision::ConflictingLiveProcess;
    }

    OwnerReuseDecision::Reusable
}

fn acquire_spawn_lock(
    lock_path: &Path,
    data_dir: &Path,
) -> std::io::Result<Option<suwayomi_runtime::SpawnLease>> {
    suwayomi_runtime::SpawnLease::try_acquire(lock_path, data_dir)
}

/// The folders Suwayomi keeps under its downloads root; a migration moves these and nothing else, so a
/// downloads path that also holds the user's own files never loses them.
const SUWAYOMI_DOWNLOAD_FOLDERS: [&str; 2] = ["mangas", "thumbnails"];

/// Resolves a path that may not exist yet through its nearest existing ancestor, so two spellings of one
/// folder (case, separators, `..`, a trailing slash) compare equal.
fn resolve_existing_prefix(path: &Path) -> Result<PathBuf, String> {
    let mut missing = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        if let Ok(resolved) = current.canonicalize() {
            return Ok(missing.into_iter().rev().fold(resolved, |acc: PathBuf, part| acc.join(part)));
        }
        let Some(name) = current.file_name().map(|name| name.to_os_string()) else {
            return Err(format!("Could not resolve {}", path.display()));
        };
        missing.push(name);
        if !current.pop() {
            return Err(format!("Could not resolve {}", path.display()));
        }
    }
}

/// What a downloads move would copy: the resolved roots and the download folders present in `src`.
/// `None` when there is nothing to move (no source, or the same folder spelled differently). A destination
/// inside a folder being moved is refused: the copy would walk into itself and the removal would then
/// delete the copy.
fn plan_download_move(src: &Path, dst: &Path) -> Result<Option<(PathBuf, PathBuf, Vec<&'static str>)>, String> {
    if !src.is_dir() {
        return Ok(None);
    }
    let src = resolve_existing_prefix(src)?;
    let dst = resolve_existing_prefix(dst)?;
    if src == dst {
        return Ok(None);
    }
    let folders: Vec<&'static str> = SUWAYOMI_DOWNLOAD_FOLDERS
        .into_iter()
        .filter(|folder| src.join(folder).is_dir())
        .collect();
    for folder in &folders {
        let from = src.join(folder);
        let to = dst.join(folder);
        if to.starts_with(&from) || from.starts_with(&to) {
            return Err("DOWNLOADS_PATH_NESTED".to_string());
        }
    }
    Ok(Some((src, dst, folders)))
}

/// Moves Suwayomi's download folders from `src` into `dst`, reporting `(done, total, current)` per file.
/// Each folder is removed only after all of its files were copied.
fn move_download_folders(
    src: &Path,
    dst: &Path,
    mut on_progress: impl FnMut(u64, u64, &str),
) -> Result<(), String> {
    let Some((src, dst, folders)) = plan_download_move(src, dst)? else {
        return Ok(());
    };

    let total: u64 = folders
        .iter()
        .flat_map(|folder| WalkDir::new(src.join(folder)).into_iter().filter_map(|e| e.ok()))
        .filter(|e| e.file_type().is_file())
        .count() as u64;
    on_progress(0, total, "");

    let mut done: u64 = 0;
    for folder in &folders {
        let from = src.join(folder);
        let to = dst.join(folder);
        for entry in WalkDir::new(&from).into_iter().filter_map(|e| e.ok()) {
            let rel = entry.path().strip_prefix(&from).map_err(|e| e.to_string())?;
            let target = to.join(rel);
            if entry.file_type().is_dir() {
                fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
                done += 1;
                on_progress(done, total, &Path::new(folder).join(rel).to_string_lossy());
            }
        }
        fs::remove_dir_all(&from).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Refuses a new downloads folder that a later `migrate_downloads` could not move into, before it is saved.
#[tauri::command]
fn check_downloads_move(src: String, dst: String) -> Result<(), String> {
    plan_download_move(Path::new(src.trim()), Path::new(dst.trim())).map(|_| ())
}

/// Moves Suwayomi's downloads from `src` into `dst`, emitting `migrate_progress` events: `{ done, total, current }`.
#[tauri::command]
async fn migrate_downloads(app: tauri::AppHandle, src: String, dst: String) -> Result<(), String> {
    use tauri::Emitter;

    let src_path = std::path::PathBuf::from(src.trim());
    let dst_path = std::path::PathBuf::from(dst.trim());
    move_download_folders(&src_path, &dst_path, |done, total, current| {
        let _ = app.emit(
            "migrate_progress",
            serde_json::json!({ "done": done, "total": total, "current": current }),
        );
    })
}

#[cfg(test)]
mod download_folder_tests {
    use super::*;

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn download_folder_names_match_suwayomi() {
        assert_eq!(suwayomi_safe_filename("Series: Part 1?"), "Series_ Part 1_");
        assert_eq!(suwayomi_safe_filename(" ..A/B\\C|D*E\"F<G>H\u{1}\u{7f}.. "), "A_B_C_D_E_F_G_H__");
        assert_eq!(suwayomi_safe_filename(" . . "), "(invalid)");
        let long = suwayomi_safe_filename(&"\u{00e9}".repeat(200));
        assert_eq!(long.len(), 240);
        assert_eq!(long.chars().count(), 120);
    }

    #[test]
    fn offline_reader_opens_chapters_in_the_folders_suwayomi_writes() {
        let temp = tempfile::tempdir().unwrap();
        let series = temp.path().join("mangas").join("Source_ One").join("Title_ Two_");
        write(&series.join("Group_Chapter 3.cbz"), b"chapter three");
        write(&series.join("Chapter 30.cbz"), b"chapter thirty");
        let root = temp.path().to_string_lossy().to_string();

        let found = find_downloaded_chapter_archive(
            &root, "Source: One", "Title: Two?", "Chapter 3", Some("Group"), None,
        )
        .unwrap();
        assert_eq!(fs::read(found.unwrap()).unwrap(), b"chapter three");
        let missing = find_downloaded_chapter_archive(
            &root, "Source: One", "Another", "Chapter 3", None, None,
        )
        .unwrap();
        assert_eq!(missing, None);
    }

    #[test]
    fn migration_moves_only_download_folders_and_reports_each_file() {
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("old");
        let dst = temp.path().join("new").join("nested");
        write(&src.join("mangas").join("Source").join("Series").join("Chapter 1.cbz"), b"one");
        write(&src.join("thumbnails").join("1.jpg"), b"cover");
        write(&src.join("notes.txt"), b"mine");

        let mut events = Vec::new();
        move_download_folders(&src, &dst, |done, total, _| events.push((done, total))).unwrap();

        assert_eq!(events, vec![(0, 2), (1, 2), (2, 2)]);
        assert_eq!(fs::read(dst.join("mangas").join("Source").join("Series").join("Chapter 1.cbz")).unwrap(), b"one");
        assert_eq!(fs::read(dst.join("thumbnails").join("1.jpg")).unwrap(), b"cover");
        assert!(!src.join("mangas").exists());
        assert!(!src.join("thumbnails").exists());
        assert_eq!(fs::read(src.join("notes.txt")).unwrap(), b"mine");
        assert!(!dst.join("notes.txt").exists());
    }

    #[test]
    fn migration_to_the_same_folder_keeps_every_download() {
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("downloads");
        let chapter = src.join("mangas").join("Source").join("Series").join("Chapter 1.cbz");
        write(&chapter, b"one");

        move_download_folders(&src, &src.join(".").join("mangas").join(".."), |_, _, _| {}).unwrap();

        assert_eq!(fs::read(&chapter).unwrap(), b"one");
    }

    #[test]
    fn migration_into_a_download_folder_is_refused_before_copying() {
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("downloads");
        let chapter = src.join("mangas").join("Source").join("Series").join("Chapter 1.cbz");
        write(&chapter, b"one");

        let mut calls = 0;
        let error = move_download_folders(&src, &src.join("mangas").join("moved"), |_, _, _| calls += 1).unwrap_err();

        assert_eq!(error, "DOWNLOADS_PATH_NESTED");
        assert_eq!(check_downloads_move(src.to_string_lossy().into(), src.join("mangas").join("moved").to_string_lossy().into()).unwrap_err(), "DOWNLOADS_PATH_NESTED");
        assert!(check_downloads_move(src.to_string_lossy().into(), temp.path().join("elsewhere").to_string_lossy().into()).is_ok());
        assert_eq!(calls, 0);
        assert_eq!(fs::read(&chapter).unwrap(), b"one");
        assert!(!src.join("mangas").join("moved").exists());
    }

    #[test]
    fn migration_into_a_sibling_subfolder_of_the_old_root_is_allowed() {
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("downloads");
        write(&src.join("mangas").join("Source").join("Series").join("Chapter 1.cbz"), b"one");

        move_download_folders(&src, &src.join("library"), |_, _, _| {}).unwrap();

        assert_eq!(fs::read(src.join("library").join("mangas").join("Source").join("Series").join("Chapter 1.cbz")).unwrap(), b"one");
        assert!(!src.join("mangas").exists());
    }
}

/// Returns the OS/monitor DPI scale factor for the window's current monitor.
/// This is the real hardware scale — 1.0 on standard displays, 2.0 on HiDPI/4K,
/// 1.25–1.5 on Windows displays with OS-level scaling applied.
/// The frontend multiplies this by the user's uiZoom preference to get the
/// final effective zoom applied to document.documentElement.
#[tauri::command]
fn get_platform_ui_scale(window: tauri::Window) -> f64 {
    window.scale_factor().unwrap_or(1.0)
}

fn reconciliation_overlay_root_for_server_url(
    launch_target: &LaunchTargetInfo,
    server_url: Option<&str>,
) -> PathBuf {
    resolve_local_server_target(launch_target, server_url, None, None)
        .map(|target| target.root_dir)
        .unwrap_or_else(|_| suwayomi_data_dir())
}

fn reconciliation_overlay_path_for_root(root_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(root_dir).map_err(|e| e.to_string())?;
    Ok(root_dir.join("backup-reconciliation-overlay.json"))
}

fn reconciliation_overlay_path_for_server_url(
    launch_target: &LaunchTargetInfo,
    server_url: Option<&str>,
) -> Result<PathBuf, String> {
    let root_dir = reconciliation_overlay_root_for_server_url(launch_target, server_url);
    reconciliation_overlay_path_for_root(&root_dir)
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn novels_scope_root_for_target(
    launch_target: &LaunchTargetInfo,
    profile_id: Option<&str>,
    server_url: Option<&str>,
) -> PathBuf {
    if let Some(profile_key) = local_server_profile_key_from_id(profile_id) {
        return local_server_root_for_profile_key(&profile_key);
    }

    if let Ok(target) = resolve_local_server_target(launch_target, server_url, None, None) {
        return target.root_dir;
    }

    if let Some(server_url) = server_url.map(str::trim).filter(|value| !value.is_empty()) {
        return suwayomi_data_dir()
            .join("novels")
            .join("remote-scopes")
            .join(sha256_hex(server_url.trim_end_matches('/')));
    }

    local_server_profile_root(LocalServerProfile::Test)
}

pub(crate) fn novel_repository_state_path_for_target(
    launch_target: &LaunchTargetInfo,
    profile_id: Option<&str>,
    server_url: Option<&str>,
) -> Result<PathBuf, String> {
    let root_dir = novels_scope_root_for_target(launch_target, profile_id, server_url);
    let novels_dir = root_dir.join("novels");
    std::fs::create_dir_all(&novels_dir).map_err(|err| err.to_string())?;
    Ok(novels_dir.join("repositories-state.json"))
}

pub(crate) fn novel_source_classification_state_path_for_target(
    launch_target: &LaunchTargetInfo,
    profile_id: Option<&str>,
    server_url: Option<&str>,
) -> Result<PathBuf, String> {
    let root_dir = novels_scope_root_for_target(launch_target, profile_id, server_url);
    let novels_dir = root_dir.join("novels");
    std::fs::create_dir_all(&novels_dir).map_err(|err| err.to_string())?;
    Ok(novels_dir.join("source-classification-state.json"))
}

fn extension_compatibility_state_path_for_target(
    launch_target: &LaunchTargetInfo,
    profile_id: Option<&str>,
    server_url: Option<&str>,
) -> Result<PathBuf, String> {
    let scope_root = if let Some(profile_key) = local_server_profile_key_from_id(profile_id) {
        local_server_root_for_profile_key(&profile_key)
    } else if let Ok(target) = resolve_local_server_target(launch_target, server_url, None, None) {
        target.root_dir
    } else {
        let scope = server_url
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(sha256_hex)
            .unwrap_or_else(|| "main".to_string());
        suwayomi_data_dir().join("runtime-scopes").join(scope)
    };
    let metadata_dir = scope_root.join(".epigraph");
    std::fs::create_dir_all(&metadata_dir).map_err(|error| error.to_string())?;
    Ok(metadata_dir.join("extension-compatibility.json"))
}

fn write_text_file_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let temp_path = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    {
        let mut file = std::fs::File::create(&temp_path).map_err(|error| error.to_string())?;
        file.write_all(contents.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    let result = atomic_replace_file(&temp_path, path).map_err(|error| error.to_string());
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

pub(crate) fn novel_library_state_path_for_target(
    launch_target: &LaunchTargetInfo,
    profile_id: Option<&str>,
    server_url: Option<&str>,
) -> Result<PathBuf, String> {
    let root_dir = novels_scope_root_for_target(launch_target, profile_id, server_url);
    let novels_dir = root_dir.join("novels");
    std::fs::create_dir_all(&novels_dir).map_err(|err| err.to_string())?;
    Ok(novels_dir.join("library-state.json"))
}

fn novels_storage_root_path_for_target(
    launch_target: &LaunchTargetInfo,
    profile_id: Option<&str>,
    server_url: Option<&str>,
) -> Result<PathBuf, String> {
    let root_dir = novels_scope_root_for_target(launch_target, profile_id, server_url);
    let novels_dir = root_dir.join("novels");
    std::fs::create_dir_all(&novels_dir).map_err(|err| err.to_string())?;
    Ok(novels_dir)
}

#[tauri::command]
fn read_reconciliation_overlay(
    server_url: Option<String>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let path = reconciliation_overlay_path_for_server_url(&launch_target, server_url.as_deref())?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(Some(text))
}

#[tauri::command]
fn write_reconciliation_overlay(
    contents: String,
    server_url: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let path = reconciliation_overlay_path_for_server_url(&launch_target, server_url.as_deref())?;
    write_text_file_atomic(&path, &contents)
}

#[tauri::command]
fn read_novel_repository_state(
    profile_id: Option<String>,
    server_url: Option<String>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let path = novel_repository_state_path_for_target(
        &launch_target,
        profile_id.as_deref(),
        server_url.as_deref(),
    )?;

    if !path.exists() {
        return Ok(None);
    }

    let text = std::fs::read_to_string(path).map_err(|err| err.to_string())?;
    Ok(Some(text))
}

#[tauri::command]
async fn write_novel_repository_state(
    contents: String,
    profile_id: Option<String>,
    server_url: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let path = novel_repository_state_path_for_target(
        &launch_target,
        profile_id.as_deref(),
        server_url.as_deref(),
    )?;
    let previous_contents = if path.exists() {
        Some(std::fs::read_to_string(&path).map_err(|err| err.to_string())?)
    } else {
        None
    };
    write_text_file_atomic(&path, &contents)?;
    // The profile owns this file even when the UI also passes its runtime server URL.
    if let Err(error) = syncd_replication::notify_novel_repository_state_written(
        &app,
        profile_id.as_deref(),
        previous_contents,
        &contents,
    )
    .await
    {
        eprintln!("Failed to publish LNReader repository state to Syncd: {error}");
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_novel_source_classification_state(
    profile_id: Option<String>,
    server_url: Option<String>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let path = novel_source_classification_state_path_for_target(
        &launch_target,
        profile_id.as_deref(),
        server_url.as_deref(),
    )?;

    if !path.exists() {
        return Ok(None);
    }

    let text = std::fs::read_to_string(path).map_err(|err| err.to_string())?;
    Ok(Some(text))
}

#[tauri::command]
fn write_novel_source_classification_state(
    contents: String,
    profile_id: Option<String>,
    server_url: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let path = novel_source_classification_state_path_for_target(
        &launch_target,
        profile_id.as_deref(),
        server_url.as_deref(),
    )?;
    let previous_contents = fs::read_to_string(&path).ok();
    write_text_file_atomic(&path, &contents)?;
    let next_contents = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let notify_profile_id = profile_id.clone();
    let notify_app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = syncd_replication::notify_novel_source_classification_state_written(
            &notify_app,
            notify_profile_id.as_deref(),
            previous_contents,
            &next_contents,
        )
        .await
        {
            eprintln!("syncd replication novel classification notify failed: {error}");
        }
    });
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_extension_compatibility_state(
    profile_id: Option<String>,
    server_url: Option<String>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let path = extension_compatibility_state_path_for_target(
        &launch_target,
        profile_id.as_deref(),
        server_url.as_deref(),
    )?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(path)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn write_extension_compatibility_state(
    contents: String,
    profile_id: Option<String>,
    server_url: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    if contents.len() > 4 * 1024 * 1024 {
        return Err("Extension compatibility state exceeds the supported size.".to_string());
    }
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let path = extension_compatibility_state_path_for_target(
        &launch_target,
        profile_id.as_deref(),
        server_url.as_deref(),
    )?;
    let parsed = serde_json::from_str::<serde_json::Value>(&contents)
        .map_err(|error| format!("Extension compatibility state is invalid JSON: {error}"))?;
    if !parsed.is_object()
        || !parsed
            .get("records")
            .is_some_and(serde_json::Value::is_array)
    {
        return Err("Extension compatibility state has an invalid shape.".to_string());
    }
    write_text_file_atomic(&path, &contents)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_novel_library_state(
    profile_id: Option<String>,
    server_url: Option<String>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let path = novel_library_state_path_for_target(
        &launch_target,
        profile_id.as_deref(),
        server_url.as_deref(),
    )?;

    if !path.exists() {
        return Ok(None);
    }

    let text = std::fs::read_to_string(path).map_err(|err| err.to_string())?;
    Ok(Some(text))
}

#[tauri::command]
fn read_book_library_state(profile_id: Option<String>) -> Result<Option<String>, String> {
    let path = book_library_state_path_for_profile(profile_id.as_deref())?;

    if !path.exists() {
        return Ok(None);
    }

    let text = std::fs::read_to_string(path).map_err(|err| err.to_string())?;
    Ok(Some(text))
}

#[tauri::command]
fn write_book_library_state(
    contents: String,
    app: tauri::AppHandle,
    profile_id: Option<String>,
) -> Result<String, String> {
    let path = book_library_state_path_for_profile(profile_id.as_deref())?;
    let previous_contents = fs::read_to_string(&path).ok();
    write_restore_library_snapshot(&path, &contents)?;
    if !book_library_write_notifies_replication(profile_id.as_deref()) {
        // Replication would otherwise persist this profile's library over the main one.
        return Ok(path.to_string_lossy().into_owned());
    }
    let next_contents = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            syncd_replication::notify_book_state_written(&app, previous_contents, &next_contents)
                .await
        {
            eprintln!("syncd replication book notify failed: {error}");
        }
    });
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_migration_journal_state() -> Result<Option<String>, String> {
    let path = migration_journal_state_path()?;
    migration_journal::read(&path)
}

#[tauri::command]
fn write_migration_journal_state(
    contents: String,
    expected_sha256: Option<String>,
) -> Result<String, String> {
    let path = migration_journal_state_path()?;
    migration_journal::write(&path, &contents, expected_sha256.as_deref())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn resolve_book_storage_root() -> Result<String, String> {
    let root = books_data_dir();
    std::fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command]
fn write_novel_library_state(
    contents: String,
    profile_id: Option<String>,
    server_url: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let path = novel_library_state_path_for_target(
        &launch_target,
        profile_id.as_deref(),
        server_url.as_deref(),
    )?;
    let previous_contents = fs::read_to_string(&path).ok();
    write_restore_library_snapshot(&path, &contents)?;
    let next_contents = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let notify_profile_id = profile_id.clone();
    let notify_app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = syncd_replication::notify_novel_state_written(
            &notify_app,
            notify_profile_id.as_deref(),
            previous_contents,
            &next_contents,
        )
        .await
        {
            eprintln!("syncd replication novel notify failed: {error}");
        }
    });
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn resolve_novel_storage_root(
    profile_id: Option<String>,
    server_url: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let path = novels_storage_root_path_for_target(
        &launch_target,
        profile_id.as_deref(),
        server_url.as_deref(),
    )?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn remove_novel_plugin_installation(
    plugin_id: String,
    profile_id: Option<String>,
    server_url: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let root = novels_storage_root_path_for_target(
        &launch_target,
        profile_id.as_deref(),
        server_url.as_deref(),
    )?;
    let plugin_root = root.join("plugins").join(plugin_id.trim());
    if plugin_root.exists() {
        std::fs::remove_dir_all(plugin_root).map_err(|err| err.to_string())?;
    }
    Ok(())
}

// Chapters saved for offline reading live at `<novel root>/chapters/<source hash>/<chapter hash>.json`;
// the hashes come from the frontend's stable hash of the source id and chapter path.
fn novel_cache_hash_is_valid(value: &str) -> bool {
    !value.is_empty() && value.len() <= 16 && value.bytes().all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
}

fn novel_chapter_cache_dir(root: &Path, source_hash: &str) -> Result<PathBuf, String> {
    if !novel_cache_hash_is_valid(source_hash) {
        return Err("Invalid novel source reference.".to_string());
    }
    Ok(root.join("chapters").join(source_hash))
}

fn list_novel_chapter_cache_hashes(dir: &Path) -> Result<Vec<String>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut hashes = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
            if novel_cache_hash_is_valid(stem) {
                hashes.push(stem.to_string());
            }
        }
    }
    hashes.sort();
    Ok(hashes)
}

fn delete_novel_chapter_cache_files(dir: &Path, chapter_hashes: &[String]) -> Result<u32, String> {
    let mut removed = 0;
    for hash in chapter_hashes {
        if !novel_cache_hash_is_valid(hash) {
            return Err("Invalid novel chapter reference.".to_string());
        }
        match fs::remove_file(dir.join(format!("{hash}.json"))) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(removed)
}

#[tauri::command]
fn list_novel_cached_chapters(
    profile_id: Option<String>,
    server_url: Option<String>,
    source_hash: String,
    app: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let root = novels_storage_root_path_for_target(&launch_target, profile_id.as_deref(), server_url.as_deref())?;
    list_novel_chapter_cache_hashes(&novel_chapter_cache_dir(&root, &source_hash)?)
}

#[tauri::command]
fn delete_novel_cached_chapters(
    profile_id: Option<String>,
    server_url: Option<String>,
    source_hash: String,
    chapter_hashes: Vec<String>,
    app: tauri::AppHandle,
) -> Result<u32, String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let root = novels_storage_root_path_for_target(&launch_target, profile_id.as_deref(), server_url.as_deref())?;
    delete_novel_chapter_cache_files(&novel_chapter_cache_dir(&root, &source_hash)?, &chapter_hashes)
}

#[cfg(test)]
mod novel_chapter_cache_tests {
    use super::*;

    #[test]
    fn lists_and_deletes_only_hash_named_chapter_files() {
        let root = std::env::temp_dir().join(format!("epigraph-novel-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = novel_chapter_cache_dir(&root, "abc123").unwrap();
        assert_eq!(list_novel_chapter_cache_hashes(&dir).unwrap(), Vec::<String>::new());
        fs::create_dir_all(&dir).unwrap();
        for name in ["k1.json", "z9x.json", "notes.txt", "Bad.json"] {
            fs::write(dir.join(name), "{}").unwrap();
        }
        assert_eq!(list_novel_chapter_cache_hashes(&dir).unwrap(), vec!["k1".to_string(), "z9x".to_string()]);
        assert_eq!(delete_novel_chapter_cache_files(&dir, &["k1".to_string(), "missing".to_string()]).unwrap(), 1);
        assert_eq!(list_novel_chapter_cache_hashes(&dir).unwrap(), vec!["z9x".to_string()]);
        assert!(dir.join("notes.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_references_that_could_leave_the_cache_folder() {
        let root = std::env::temp_dir();
        for bad in ["", "..", "a/b", r"a\b", "A1", "12345678901234567"] {
            assert!(novel_chapter_cache_dir(&root, bad).is_err(), "{bad:?}");
        }
        let dir = root.join("epigraph-novel-cache-unused");
        assert!(delete_novel_chapter_cache_files(&dir, &["../x".to_string()]).is_err());
    }
}

fn kill_tachidesk(app: &tauri::AppHandle, server_url: Option<&str>) -> Result<(), String> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let target = resolve_local_server_target(&launch_target, server_url, None, None)
        .map_err(|_| "Cannot resolve cleanup scope; runtime preserved".to_string())?;
    kill_tachidesk_target(app, &target)
}

pub(crate) fn kill_tachidesk_target(app: &tauri::AppHandle, target: &LocalServerTarget) -> Result<(), String> {
    use suwayomi_runtime::ownership::Ownership;
    if target.attach_only || managed_startup_owner(&target.profile_key, target.port) == ManagedStartupOwner::PersistentCore {
        return Err("Refusing desktop cleanup of an attached/persistent Core runtime".into());
    }
    let owner_path = server_owner_path(&target.root_dir);
    let raw = std::fs::read(&owner_path).map_err(|_| "Missing ownership record; runtime preserved")?;
    let owner: ServerOwner = serde_json::from_slice(&raw).map_err(|_| "Malformed ownership record; runtime preserved")?;
    if owner.app_pid != std::process::id() || owner.java_pid != owner.process_identity.as_ref().map_or(0, |identity| identity.pid)
        || owner.server_url.trim_end_matches('/') != target.server_url || owner.port != target.port {
        return Err("Inconsistent ownership record; runtime preserved".into());
    }
    // Authority comes from this application's retained spawn, never from discovery.
    let state = app.state::<ServerState>();
    let guard = state.0.lock().unwrap();
    let running = guard.as_ref().ok_or("No live spawn lease; runtime preserved")?;
    if running.owner_path != owner_path || running.child.pid() != owner.java_pid
        || owner.run_id.as_deref() != Some(running.run_id.as_str()) {
        return Err("Owner belongs to a different application run; runtime preserved".into());
    }
    let root = target.root_dir.to_string_lossy();
    let ownership = Ownership {
        run_id: owner.run_id.as_deref(), requested_run_id: &running.run_id, profile: &owner.profile_key, root: &owner.root_dir,
        requested_profile: &target.profile_key, requested_root: &root,
        spawned: owner.spawned_by_app, attach_only: target.attach_only,
        identity: owner.process_identity.as_ref().and_then(|identity| identity.for_termination()),
    };
    #[cfg(windows)]
    {
        suwayomi_runtime::ownership::validate_record(&ownership)?;
        let birth = running.birth_identity.as_ref().ok_or("Missing retained birth identity")?;
        let recorded = owner.process_identity.as_ref().ok_or("Missing owner identity")?;
        if !suwayomi_runtime::retained_child_has_exited(&running.child, recorded, birth)? {
            let mut process = suwayomi_runtime::ownership::windows::Process::open(owner.java_pid, suwayomi_runtime::command_line_hash)?;
            suwayomi_runtime::ownership::stop_verified(&ownership, &mut process, || {
                std::fs::read(&owner_path).ok().as_deref() == Some(raw.as_slice())
            })?;
        } else if std::fs::read(&owner_path).ok().as_deref() != Some(raw.as_slice()) {
            return Err("Owner changed during completion validation; evidence retained".into());
        }
        suwayomi_runtime::record_confirmed_stop(&owner_path, &raw)?;
        // Keep the evidence record even after confirmed exit. Startup may reconcile it;
        // cleanup must never race a replacement writer by deleting its ownership record.
        drop(guard);
        let mut guard = state.0.lock().unwrap();
        if guard.as_ref().is_some_and(|running| Some(running.run_id.as_str()) == owner.run_id.as_deref()) { guard.take(); }
        set_runtime_status(app, suwayomi_runtime::RuntimeLifecycleState::Unavailable,
            Some(target.profile_key.clone()), Some(target.server_url.clone()), None, None);
        Ok(())
    }
    #[cfg(not(windows))]
    { let _ = (app, ownership); Err("Handle-bound cleanup is unavailable on this platform; runtime preserved".into()) }
}

fn kill_tachidesk_target_for_retained_restart(running: &RunningServer) -> Result<(), String> {
    let raw = std::fs::read(&running.owner_path).map_err(|_| "Missing retained ownership")?;
    let owner: ServerOwner = serde_json::from_slice(&raw).map_err(|_| "Malformed retained ownership")?;
    if owner.app_pid != std::process::id() || owner.java_pid != running.child.pid()
        || owner.port != running.port || owner.server_url != running.server_url
        || owner.process_identity.as_ref().map(|identity| identity.pid) != Some(owner.java_pid) {
        return Err("Inconsistent retained ownership; process preserved".into());
    }
    let root = running.owner_path.parent().ok_or("Missing retained root")?.to_string_lossy();
    let ownership = suwayomi_runtime::ownership::Ownership {
        run_id: owner.run_id.as_deref(), requested_run_id: &running.run_id,
        profile: &owner.profile_key, root: &owner.root_dir,
        requested_profile: &running.profile_key, requested_root: &root,
        spawned: owner.spawned_by_app,
        attach_only: managed_startup_owner(&running.profile_key, running.port) == ManagedStartupOwner::PersistentCore,
        identity: owner.process_identity.as_ref().and_then(|identity| identity.for_termination()),
    };
    #[cfg(windows)]
    {
        suwayomi_runtime::ownership::validate_record(&ownership)?;
        let birth = running.birth_identity.as_ref().ok_or("Missing retained birth identity")?;
        let recorded = owner.process_identity.as_ref().ok_or("Missing owner identity")?;
        if !suwayomi_runtime::retained_child_has_exited(&running.child, recorded, birth)? {
            let mut process = suwayomi_runtime::ownership::windows::Process::open(owner.java_pid, suwayomi_runtime::command_line_hash)?;
            suwayomi_runtime::ownership::stop_verified(&ownership, &mut process,
                || std::fs::read(&running.owner_path).ok().as_deref() == Some(raw.as_slice()))?;
        } else if std::fs::read(&running.owner_path).ok().as_deref() != Some(raw.as_slice()) {
            return Err("Owner changed during completion validation; evidence retained".into());
        }
        suwayomi_runtime::record_confirmed_stop(&running.owner_path, &raw)
    }
    #[cfg(not(windows))]
    { let _ = ownership; Err("Handle-bound restart cleanup unavailable; process preserved".into()) }
}

const DEFAULT_SERVER_CONF: &str = r#"server.ip = "127.0.0.1"
server.port = 4567
server.webUIEnabled = false
server.initialOpenInBrowserEnabled = false
server.systemTrayEnabled = false
server.webUIInterface = "browser"
server.webUIFlavor = "WebUI"
server.webUIChannel = "stable"
server.electronPath = ""
server.debugLogsEnabled = false
server.downloadAsCbz = true
server.autoDownloadNewChapters = false
server.globalUpdateInterval = 0
server.webUIUpdateCheckInterval = 0
server.maxSourcesInParallel = 2
server.extensionRepos = []
"#;

const LOCAL_SERVER_JAVA_XMS: &str = "96m";
const LOCAL_SERVER_JAVA_XMX: &str = "512m";
const LOCAL_SERVER_JAVA_EXTENSION_COMPAT_FLAG: &str = "-noverify";
const LOCAL_SERVER_JAVA_TOOL_OPTIONS: &str =
    "-Djava.awt.headless=true -Xms96m -Xmx512m -XX:+UseG1GC";

fn local_server_java_args(jar: &Path) -> Vec<String> {
    vec![
        "-Djava.awt.headless=true".to_string(),
        format!("-Xms{LOCAL_SERVER_JAVA_XMS}"),
        format!("-Xmx{LOCAL_SERVER_JAVA_XMX}"),
        "-XX:+UseG1GC".to_string(),
        LOCAL_SERVER_JAVA_EXTENSION_COMPAT_FLAG.to_string(),
        "-jar".to_string(),
        jar.to_string_lossy().into_owned(),
    ]
}

fn seed_server_conf(
    data_dir: &Path,
    profile_key: &str,
    port: u16,
    update_intensity: LocalServerUpdateIntensity,
) {
    let conf_path = data_dir.join("server.conf");
    let exposure_mode = suwayomi_lan::load_and_sanitize(data_dir, profile_key)
        .unwrap_or(suwayomi_lan::LanExposureMode::LoopbackOnly);
    let server_ip = format!("\"{}\"", suwayomi_lan::bind_host_for_mode(&exposure_mode));

    if !conf_path.exists() {
        if let Err(e) = std::fs::create_dir_all(data_dir) {
            eprintln!("Could not create Suwayomi data dir: {e}");
            return;
        }
        let initial = patch_suwayomi_runtime_conf(
            DEFAULT_SERVER_CONF.to_string(),
            &server_ip,
            port,
            update_intensity,
        );
        if let Err(e) = std::fs::write(&conf_path, initial) {
            eprintln!("Could not write server.conf: {e}");
        }
        return;
    }

    let Ok(contents) = std::fs::read_to_string(&conf_path) else {
        return;
    };

    let patched = patch_suwayomi_runtime_conf(contents, &server_ip, port, update_intensity);

    let _ = std::fs::write(&conf_path, patched);
}

fn patch_suwayomi_runtime_conf(
    contents: String,
    server_ip: &str,
    port: u16,
    update_intensity: LocalServerUpdateIntensity,
) -> String {
    let mut patched = patch_conf_key(contents, "server.webUIEnabled", "false");
    patched = patch_conf_key(patched, "server.initialOpenInBrowserEnabled", "false");
    patched = patch_conf_key(patched, "server.systemTrayEnabled", "false");
    patched = patch_conf_key(patched, "server.webUIUpdateCheckInterval", "0");
    patched = patch_conf_key(patched, "server.globalUpdateInterval", "0");
    patched = patch_conf_key(patched, "server.autoDownloadNewChapters", "false");
    patched = patch_conf_key(patched, "server.ip", server_ip);
    patched = patch_conf_key(patched, "server.port", &port.to_string());
    patch_conf_key(
        patched,
        "server.maxSourcesInParallel",
        &update_intensity.max_sources_in_parallel().to_string(),
    )
}

fn patch_conf_key(text: String, key: &str, value: &str) -> String {
    let replacement = format!("{key} = {value}");
    let lines: Vec<&str> = text.lines().collect();

    if let Some(pos) = lines.iter().position(|l| l.trim_start().starts_with(key)) {
        let mut out = lines
            .iter()
            .enumerate()
            .map(|(i, l)| if i == pos { replacement.as_str() } else { l })
            .collect::<Vec<_>>()
            .join("\n");
        out.push('\n');
        return out;
    }

    let mut out = text;
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&replacement);
    out.push('\n');
    out
}

fn sanitize_suwayomi_lan_state() {
    for profile in [LocalServerProfile::Main, LocalServerProfile::Test] {
        let root = local_server_profile_root(profile);
        if !root.exists() {
            continue;
        }
        seed_server_conf(
            &root,
            profile.key(),
            default_local_server_port(profile),
            LocalServerUpdateIntensity::Balanced,
        );
    }
}

fn local_server_profile_root_override(profile: LocalServerProfile) -> Option<PathBuf> {
    let var_name = match profile {
        LocalServerProfile::Main => "EPIGRAPH_LOCAL_SERVER_MAIN_ROOT",
        LocalServerProfile::Test => "EPIGRAPH_LOCAL_SERVER_TEST_ROOT",
    };
    std::env::var_os(var_name).map(PathBuf::from)
}

fn maybe_start_phase_gate_temporary_lan_session() {
    let Some(raw_profile) = std::env::var_os("EPIGRAPH_PHASE_GATE_TEMPORARY_LAN_PROFILE") else {
        return;
    };

    let profile = match raw_profile.to_string_lossy().to_ascii_lowercase().as_str() {
        "main" => LocalServerProfile::Main,
        "test" => LocalServerProfile::Test,
        other => {
            eprintln!("Ignoring invalid EPIGRAPH_PHASE_GATE_TEMPORARY_LAN_PROFILE: {other}");
            return;
        }
    };

    let ttl_seconds = std::env::var("EPIGRAPH_PHASE_GATE_TEMPORARY_LAN_TTL_SECONDS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(60);
    let advertised_host = std::env::var("EPIGRAPH_PHASE_GATE_TEMPORARY_LAN_HOST").ok();
    let reason = std::env::var("EPIGRAPH_PHASE_GATE_TEMPORARY_LAN_REASON")
        .unwrap_or_else(|_| "phase-gate".to_string());
    let root = local_server_profile_root(profile);

    if let Err(error) = suwayomi_lan::start_temporary_session(
        &root,
        profile.key(),
        Duration::from_secs(ttl_seconds),
        advertised_host,
        reason,
    ) {
        eprintln!(
            "Failed to start temporary Suwayomi LAN session for {}: {error}",
            profile.key()
        );
    }
}

fn schedule_suwayomi_lan_session_watchers(app: &tauri::AppHandle) {
    for profile in [LocalServerProfile::Main, LocalServerProfile::Test] {
        let root = local_server_profile_root(profile);
        let Ok(mode) = suwayomi_lan::load_and_sanitize(&root, profile.key()) else {
            continue;
        };
        let suwayomi_lan::LanExposureMode::TemporarySession(session) = mode else {
            continue;
        };

        let delay_ms = session.expires_at_ms.saturating_sub(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        );
        let sleep_ms = delay_ms.min(u128::from(u64::MAX)) as u64;
        let app = app.clone();
        let root = root.clone();
        let server_url = format!("http://127.0.0.1:{}", default_local_server_port(profile));

        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(sleep_ms)).await;

            let Ok(Some(current_session)) = suwayomi_lan::read_session(&root) else {
                return;
            };
            if current_session != session {
                return;
            }
            if current_session.expires_at_ms
                > SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            {
                return;
            }

            let _ = suwayomi_lan::clear_temporary_session(&root);
            seed_server_conf(
                &root,
                profile.key(),
                default_local_server_port(profile),
                LocalServerUpdateIntensity::Balanced,
            );
            if let Err(error) = kill_tachidesk(&app, Some(&server_url)) { eprintln!("[runtime cleanup] {error}"); }
        });
    }
}

fn clear_suwayomi_lan_state() {
    for profile in [LocalServerProfile::Main, LocalServerProfile::Test] {
        let root = local_server_profile_root(profile);
        let _ = suwayomi_lan::clear_temporary_session(&root);
        if root.exists() {
            seed_server_conf(
                &root,
                profile.key(),
                default_local_server_port(profile),
                LocalServerUpdateIntensity::Balanced,
            );
        }
    }
}

fn suwayomi_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::data_dir().unwrap_or_else(|| PathBuf::from("C:\\ProgramData")))
            .join("epigraph")
    }
    #[cfg(target_os = "macos")]
    {
        dirs::data_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from("~")))
            .join("epigraph")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs::data_dir().unwrap_or_else(|| PathBuf::from("/tmp")));
        base.join("epigraph")
    }
}

/// The managed runtime JAR a start of `profile_root` uses, `None` for the bundled one.
fn managed_suwayomi_runtime_jar_path(profile_root: &Path) -> Option<PathBuf> {
    suwayomi_runtime_store::resolve_managed_jar(
        &suwayomi_data_dir().join("suwayomi-runtime"),
        Some(profile_root),
    )
}

fn ensure_suwayomi_data_dir(profile: LocalServerProfile) -> PathBuf {
    let canonical = local_server_profile_root(profile);

    if !canonical.exists() {
        compat::migrate_legacy_storage();
    }
    canonical
}

struct ServerInvocation {
    bin: String,
    args: Vec<String>,
    working_dir: Option<PathBuf>,
}

/// Locate the Java runtime binary inside a bundled JRE directory.
///
/// Expected layout (Windows and Linux):
///   <bundle_dir>/jre/bin/java[.exe]
///
/// On Windows prefer `javaw.exe` so Suwayomi stays in the background without a
/// console window, then fall back to `java.exe` if the bundled JRE lacks it.
/// On Windows `strip_unc` is applied so Java doesn't choke on `\\?\` prefixes.
#[cfg(not(target_os = "macos"))]
fn find_java_in_bundle(bundle_dir: &PathBuf, log: &mut Option<std::fs::File>) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let javaw = strip_unc(bundle_dir.join("jre").join("bin").join("javaw.exe"));
        do_log(log, &format!("[find_java] checking path: {:?}", javaw));
        do_log(log, &format!("[find_java] exists: {}", javaw.exists()));
        if javaw.exists() {
            return Some(javaw);
        }

        let java = strip_unc(bundle_dir.join("jre").join("bin").join("java.exe"));
        do_log(log, &format!("[find_java] checking path: {:?}", java));
        do_log(log, &format!("[find_java] exists: {}", java.exists()));
        return java.exists().then_some(java);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let java = bundle_dir.join("jre").join("bin").join("java");
        do_log(log, &format!("[find_java] checking path: {:?}", java));
        do_log(log, &format!("[find_java] exists: {}", java.exists()));
        java.exists().then_some(java)
    }
}

fn do_log(log: &mut Option<std::fs::File>, msg: &str) {
    let sanitized = suwayomi_runtime::sanitize_log_line(msg, &[]);
    eprintln!("{}", sanitized);
    if let Some(f) = log {
        let _ = writeln!(f, "{}", sanitized);
    }
}

fn append_timestamped_line(path: &Path, msg: &str) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let sanitized = suwayomi_runtime::sanitize_log_line(msg, &[]);
        let _ = writeln!(file, "[{}] {}", unix_now_millis(), sanitized);
    }
}

fn command_event_preview(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let compact = text.replace(&['\r', '\n'][..], " ").trim().to_string();
    let mut preview: String = compact.chars().take(240).collect();
    if compact.chars().count() > 240 {
        preview.push_str("...");
    }
    preview
}

fn startup_diagnostics_enabled() -> bool {
    matches!(
        std::env::var("EPIGRAPH_STARTUP_DIAGNOSTICS"),
        Ok(value)
            if matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
    )
}

fn spawn_main_startup_event_drain(
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    diagnostic_log_path: PathBuf,
    java_pid: u32,
) {
    // A dedicated thread, not an async task: the caller blocks its runtime worker while
    // probing, and a task queued there never ran, so the child's stdout pipe filled and
    // Suwayomi stalled on its next log line before binding the port.
    std::thread::spawn(move || {
        if !startup_diagnostics_enabled() {
            while rx.blocking_recv().is_some() {}
            return;
        }
        append_timestamped_line(
            &diagnostic_log_path,
            &format!("[child {}] event drain started", java_pid),
        );
        while let Some(event) = rx.blocking_recv() {
            match event {
                CommandEvent::Stdout(bytes) => append_timestamped_line(
                    &diagnostic_log_path,
                    &format!(
                        "[child {}] stdout {}",
                        java_pid,
                        command_event_preview(&bytes)
                    ),
                ),
                CommandEvent::Stderr(bytes) => append_timestamped_line(
                    &diagnostic_log_path,
                    &format!(
                        "[child {}] stderr {}",
                        java_pid,
                        command_event_preview(&bytes)
                    ),
                ),
                CommandEvent::Error(error) => append_timestamped_line(
                    &diagnostic_log_path,
                    &format!("[child {}] error {}", java_pid, error),
                ),
                CommandEvent::Terminated(payload) => append_timestamped_line(
                    &diagnostic_log_path,
                    &format!(
                        "[child {}] close code={:?} signal={:?}",
                        java_pid, payload.code, payload.signal
                    ),
                ),
                _ => append_timestamped_line(
                    &diagnostic_log_path,
                    &format!("[child {}] unhandled shell event", java_pid),
                ),
            }
        }
        append_timestamped_line(
            &diagnostic_log_path,
            &format!("[child {}] event drain closed", java_pid),
        );
    });
}

fn resolve_server_binary(
    binary: &str,
    profile_root: &Path,
    app: &tauri::AppHandle,
    log: &mut Option<std::fs::File>,
) -> Result<ServerInvocation, SpawnError> {
    do_log(log, &format!("[resolve] binary arg = {:?}", binary));

    // ── 1. User-specified binary path ─────────────────────────────────────────
    // Primary: honour the path as-is (doc-2 behaviour — trust the user).
    // Fallback: if the path doesn't exist after stripping UNC, log a warning
    // and continue so the bundled detection still has a chance.
    if !binary.trim().is_empty() {
        let path = strip_unc(PathBuf::from(binary.trim()));
        do_log(
            log,
            &format!("[resolve] user path: {:?} exists={}", path, path.exists()),
        );
        if path.exists() {
            return Ok(ServerInvocation {
                bin: path.to_string_lossy().into_owned(),
                args: vec![],
                working_dir: path.parent().map(|p| p.to_path_buf()),
            });
        }
        // Fallback: path was set but file is missing — warn and keep trying.
        do_log(
            log,
            "[resolve] WARNING: user-supplied path not found, falling through to bundled detection",
        );
    }

    // Resolve and UNC-strip resource_dir once; used by all non-macOS branches.
    #[cfg(not(target_os = "macos"))]
    let resource_dir = {
        let raw = app.path().resource_dir().unwrap_or_default();
        let stripped = strip_unc(raw);
        do_log(
            log,
            &format!("[resolve] resource_dir (stripped) = {:?}", stripped),
        );
        stripped
    };

    // ── 2. Bundled JRE + JAR (Windows / Linux — specific layout) ─────────────
    // Primary path from doc-2: binaries/suwayomi-bundle/bin/Suwayomi-Server.jar
    #[cfg(not(target_os = "macos"))]
    {
        let bundle_dir = resource_dir.join("binaries").join("suwayomi-bundle");
        let jar = bundle_dir.join("bin").join("Suwayomi-Server.jar");

        do_log(log, &format!("[resolve] bundle_dir = {:?}", bundle_dir));
        do_log(
            log,
            &format!("[resolve] bundle_dir exists: {}", bundle_dir.exists()),
        );
        do_log(log, &format!("[resolve] jar = {:?}", jar));
        do_log(log, &format!("[resolve] jar exists: {}", jar.exists()));

        match find_java_in_bundle(&bundle_dir, log) {
            Some(java) => {
                do_log(log, &format!("[resolve] java found: {:?}", java));
                let managed_runtime_jar = managed_suwayomi_runtime_jar_path(profile_root);
                do_log(
                    log,
                    &format!("[resolve] managed runtime jar = {:?}", managed_runtime_jar),
                );
                if let Some(managed_runtime_jar) = managed_runtime_jar {
                    do_log(
                        log,
                        "[resolve] java found and managed runtime jar found - using managed runtime JAR",
                    );
                    return Ok(ServerInvocation {
                        bin: java.to_string_lossy().into_owned(),
                        args: local_server_java_args(&managed_runtime_jar),
                        working_dir: managed_runtime_jar.parent().map(|path| path.to_path_buf()),
                    });
                }
                if jar.exists() {
                    do_log(log, "[resolve] both java and jar found — using bundled JRE");
                    return Ok(ServerInvocation {
                        bin: java.to_string_lossy().into_owned(),
                        args: local_server_java_args(&jar),
                        working_dir: Some(bundle_dir),
                    });
                }
                do_log(
                    log,
                    "[resolve] java found but jar MISSING — falling through",
                );
            }
            None => {
                do_log(log, "[resolve] java NOT found in bundle — falling through");
            }
        }
    }

    // ── 2b. Bundled launcher scripts / native sidecars (Windows / Linux) ──────
    // Fallback for older bundle layouts that ship a wrapper script instead of a
    // bare JRE + JAR.  Also scans for any *.jar in resource_dir as a last resort.
    #[cfg(not(target_os = "macos"))]
    {
        // Named launcher scripts.
        let script_candidates = [
            "suwayomi-launcher",
            "suwayomi-launcher.sh",
            "tachidesk-server",
        ];
        for name in &script_candidates {
            let p = resource_dir.join(name);
            do_log(
                log,
                &format!("[resolve] sidecar candidate: {:?} exists={}", p, p.exists()),
            );
            if p.exists() {
                do_log(log, &format!("[resolve] using sidecar: {:?}", p));
                return Ok(ServerInvocation {
                    bin: p.to_string_lossy().into_owned(),
                    args: vec![],
                    working_dir: Some(resource_dir.clone()),
                });
            }
        }

        // Generic JRE at resource_dir root + any *.jar alongside it.
        do_log(
            log,
            "[resolve] no named sidecar found, trying generic JRE + any jar in resource_dir",
        );
        if let Some(java) = find_java_in_bundle(&resource_dir, log) {
            let jar = std::fs::read_dir(&resource_dir).ok().and_then(|mut rd| {
                rd.find(|e| {
                    e.as_ref()
                        .map(|e| e.file_name().to_string_lossy().ends_with(".jar"))
                        .unwrap_or(false)
                })
                .and_then(|e| e.ok())
                .map(|e| e.path())
            });

            do_log(log, &format!("[resolve] generic jar candidate: {:?}", jar));

            if let Some(jar_path) = jar {
                do_log(
                    log,
                    &format!(
                        "[resolve] using generic JRE java={:?} jar={:?}",
                        java, jar_path
                    ),
                );
                return Ok(ServerInvocation {
                    bin: java.to_string_lossy().into_owned(),
                    args: local_server_java_args(&jar_path),
                    working_dir: Some(resource_dir),
                });
            }
            do_log(
                log,
                "[resolve] generic JRE found but no .jar — falling through",
            );
        }
    }

    // ── 3. macOS app bundle — MacOS/ then Resources/ ──────────────────────────
    #[cfg(target_os = "macos")]
    {
        let resource_dir = app.path().resource_dir().unwrap_or_default();
        let macos_dir = resource_dir
            .parent()
            .map(|p| p.join("MacOS"))
            .unwrap_or_default();

        do_log(log, &format!("[resolve] macOS macos_dir = {:?}", macos_dir));

        // Tauri strips the target triple when installing externalBin sidecars into
        // Contents/MacOS/, so the binary is "suwayomi-server" at runtime.
        // Triple-suffixed names are kept as a belt-and-suspenders fallback for
        // dev / flat layouts.
        let candidates = [
            "suwayomi-server",
            "suwayomi-server-aarch64-apple-darwin",
            "suwayomi-server-x86_64-apple-darwin",
            "suwayomi-launcher",
            "suwayomi-launcher.sh",
            "tachidesk-server",
        ];

        for search_dir in &[&macos_dir, &resource_dir] {
            for name in &candidates {
                let p = search_dir.join(name);
                do_log(
                    log,
                    &format!("[resolve] macOS candidate: {:?} exists={}", p, p.exists()),
                );
                if p.exists() {
                    do_log(log, &format!("[resolve] using macOS sidecar: {:?}", p));
                    return Ok(ServerInvocation {
                        bin: p.to_string_lossy().into_owned(),
                        args: vec![],
                        working_dir: None,
                    });
                }
            }
        }
    }

    // ── 4. PATH fallback ──────────────────────────────────────────────────────
    // Use `where` on Windows, `which` everywhere else.
    do_log(log, "[resolve] trying PATH fallback");
    for name in &["suwayomi-server", "tachidesk-server"] {
        #[cfg(target_os = "windows")]
        let found = std::process::Command::new("where")
            .arg(name)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        #[cfg(not(target_os = "windows"))]
        let found = std::process::Command::new("which")
            .arg(name)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        do_log(
            log,
            &format!("[resolve] PATH check {:?}: found={}", name, found),
        );

        if found {
            do_log(log, &format!("[resolve] using PATH binary: {}", name));
            return Ok(ServerInvocation {
                bin: name.to_string(),
                args: vec![],
                working_dir: None,
            });
        }
    }

    do_log(log, "[resolve] FAILED — no binary found anywhere");
    Err(SpawnError::NotConfigured(
        "Server binary not found. Install Suwayomi-Server or set the path in Settings.".to_string(),
    ))
}

#[tauri::command]
async fn spawn_server(
    binary: String,
    server_url: String,
    profile_id: Option<String>,
    profile_label: Option<String>,
    update_intensity: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), SpawnError> {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let target = resolve_local_server_target(
        &launch_target,
        Some(server_url.as_str()),
        profile_id.as_deref(),
        profile_label.as_deref(),
    )?;
    if managed_startup_owner(&target.profile_key, target.port)
        == ManagedStartupOwner::PersistentCore
        && !target.attach_only
    {
        syncd_sidecar::ensure_host_mode(&app)
            .await
            .map_err(SpawnError::SpawnFailed)?;
        return Ok(());
    }
    spawn_server_unlocked(
        binary,
        server_url,
        profile_id,
        profile_label,
        update_intensity,
        app,
        true,
    )
}

fn spawn_server_unlocked(
    binary: String,
    server_url: String,
    profile_id: Option<String>,
    profile_label: Option<String>,
    update_intensity: Option<String>,
    app: tauri::AppHandle,
    recover_update: bool,
) -> Result<(), SpawnError> {
    let _launch = session_control::begin_launch().map_err(SpawnError::SpawnFailed)?;
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let mut target = resolve_local_server_target(
        &launch_target,
        Some(server_url.as_str()),
        profile_id.as_deref(),
        profile_label.as_deref(),
    )?;
    let update_intensity = LocalServerUpdateIntensity::from_option(update_intensity.as_deref());
    if target.attach_only {
        return Err(SpawnError::AttachOnlyTarget(
            "Audit targets are attach-only and never auto-start a local server.".to_string(),
        ));
    }
    set_runtime_status(
        &app,
        suwayomi_runtime::RuntimeLifecycleState::Starting,
        Some(target.profile_key.clone()),
        Some(target.server_url.clone()),
        None,
        None,
    );
    if is_builtin_local_server_profile_key(&target.profile_key) {
        target.root_dir = ensure_suwayomi_data_dir(target.profile);
    } else {
        std::fs::create_dir_all(&target.root_dir)
            .map_err(|err| SpawnError::SpawnFailed(err.to_string()))?;
    }
    if recover_update {
        suwayomi_update::recover_suwayomi_update_before_spawn(&app, &target)
            .map_err(SpawnError::SpawnFailed)?;
        set_runtime_status(
            &app,
            suwayomi_runtime::RuntimeLifecycleState::Starting,
            Some(target.profile_key.clone()),
            Some(target.server_url.clone()),
            None,
            None,
        );
    }
    let _lifecycle_lease = if recover_update {
        Some(
            suwayomi_maintenance::try_acquire_shared_file_lease(
                &suwayomi_maintenance::default_runtime_root(),
            )
            .map_err(SpawnError::SpawnFailed)?,
        )
    } else {
        None
    };

    let data_dir = target.root_dir.clone();
    let owner_path = server_owner_path(&data_dir);
    let owner_tmp_path = server_owner_tmp_path(&data_dir);
    let spawn_lock_path = server_spawn_lock_path(&data_dir);
    let main_startup_diagnostic_path =
        Some(data_dir.join(format!("{}-app-driven-startup.log", target.profile_key)));

    let log_path = data_dir.join("epigraph-spawn.log");
    let _ = std::fs::create_dir_all(&data_dir);
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok();

    do_log(&mut log, "");
    do_log(&mut log, "========================================");
    do_log(
        &mut log,
        &format!(
            "[spawn_server] called at {:?}",
            std::time::SystemTime::now()
        ),
    );
    do_log(
        &mut log,
        &format!("[spawn_server] binary arg = {:?}", binary),
    );
    do_log(
        &mut log,
        &format!("[spawn_server] data_dir = {:?}", data_dir),
    );
    do_log(
        &mut log,
        &format!("[spawn_server] log file = {:?}", log_path),
    );
    do_log(
        &mut log,
        &format!(
            "[spawn_server] target profile={} url={} port={} attach_only={}",
            target.profile_key, target.server_url, target.port, target.attach_only
        ),
    );
    do_log(
        &mut log,
        &format!("[spawn_server] APPDATA = {:?}", std::env::var("APPDATA")),
    );
    do_log(
        &mut log,
        &format!(
            "[spawn_server] LOCALAPPDATA = {:?}",
            std::env::var("LOCALAPPDATA")
        ),
    );
    do_log(
        &mut log,
        &format!("[spawn_server] current_dir = {:?}", std::env::current_dir()),
    );

    {
        let state = app.state::<ServerState>();
        let mut guard = state.0.lock().unwrap();
        let mut stale_tracked_server: Option<RunningServer> = None;
        if let Some(running) = guard.as_mut() {
            if running.owner_path == owner_path {
                let reusable = read_server_owner(&running.owner_path)
                    .map(|owner| {
                        validate_server_owner(&target, &owner) == OwnerReuseDecision::Reusable
                    })
                    .unwrap_or(false);
                if reusable {
                    do_log(
                        &mut log,
                        "[spawn_server] tracked server valid, reusing existing server",
                    );
                    return Ok(());
                }

                do_log(
                    &mut log,
                    "[spawn_server] tracked server is stale or unhealthy; clearing in-memory owner",
                );
                stale_tracked_server = guard.take();
            } else {
                return Err(SpawnError::SpawnFailed(
                    "Another profile retains the runtime spawn lease; process and ownership preserved".into(),
                ));
            }
        }
        drop(guard);
        if let Some(running) = stale_tracked_server {
            let result = kill_tachidesk_target_for_retained_restart(&running);
            if let Err(error) = result {
                *app.state::<ServerState>().0.lock().unwrap() = Some(running);
                return Err(SpawnError::SpawnFailed(error));
            }
        }
    }

    if let Some(diagnostic_log_path) = &main_startup_diagnostic_path {
        append_timestamped_line(diagnostic_log_path, "");
        append_timestamped_line(
            diagnostic_log_path,
            "========================================",
        );
        append_timestamped_line(
            diagnostic_log_path,
            &format!(
                "app-driven MAIN spawn start url={} root={:?}",
                target.server_url, data_dir
            ),
        );
    }

    // Held until this start returns; a crash releases it with the process.
    let _spawn_lease = match acquire_spawn_lock(&spawn_lock_path, &data_dir) {
        Ok(Some(lease)) => {
            do_log(
                &mut log,
                &format!("[spawn_server] acquired spawn lock {:?}", spawn_lock_path),
            );
            lease
        }
        Ok(None) => {
            do_log(
                &mut log,
                "[spawn_server] spawn lock held by another attempt; skipping duplicate spawn",
            );
            return Ok(());
        }
        Err(err) => {
            do_log(
                &mut log,
                &format!("[spawn_server] spawn lock FAILED: {}", err),
            );
            return Err(SpawnError::SpawnFailed(err.to_string()));
        }
    };

    // Debris of an owner write that was interrupted. Every writer holds the spawn lease, which this
    // start now holds, so nothing is still writing it.
    if owner_tmp_path.exists() {
        if let Err(err) = std::fs::remove_file(&owner_tmp_path) {
            return Err(SpawnError::SpawnFailed(format!("Could not clear partial ownership metadata: {err}")));
        }
        do_log(&mut log, "[spawn_server] cleared partial ownership metadata from an interrupted write");
    }

    if owner_path.exists() && !suwayomi_runtime::has_confirmed_stop(&owner_path) {
        match read_server_owner(&owner_path) {
            Some(owner) => match validate_server_owner(&target, &owner) {
                OwnerReuseDecision::Reusable => {
                    do_log(
                        &mut log,
                        "[spawn_server] owner valid, reusing existing server",
                    );
                    return Ok(());
                }
                OwnerReuseDecision::Stale if confirm_exited_server_owner(&owner_path) => {
                    do_log(
                        &mut log,
                        "[spawn_server] previous server exited without a graceful stop; ownership reconciled",
                    );
                }
                OwnerReuseDecision::Stale => {
                    return Err(SpawnError::SpawnFailed("Unconfirmed stale ownership retained; refusing takeover".into()));
                }
                OwnerReuseDecision::ConflictingLiveProcess
                    if suwayomi_runtime::stop_unresponsive_server(
                        &data_dir,
                        owner.java_pid,
                        suwayomi_runtime::UNRESPONSIVE_SERVER_GRACE,
                    ) == Ok(true)
                        && confirm_exited_server_owner(&owner_path) =>
                {
                    do_log(
                        &mut log,
                        "[spawn_server] ended a server that stopped responding; ownership reconciled",
                    );
                }
                OwnerReuseDecision::ConflictingLiveProcess => {
                    do_log(
                        &mut log,
                        "[spawn_server] owner points to a live but unhealthy Java process; refusing second spawn",
                    );
                    return Err(SpawnError::SpawnFailed(
                        "Local server process is alive but not healthy. Stop it and retry."
                            .to_string(),
                    ));
                }
            },
            None if suwayomi_runtime::confirm_abandoned_owner(&owner_path) => {
                do_log(
                    &mut log,
                    "[spawn_server] unreadable ownership with no server for the root; reconciled",
                );
            }
            None => {
                do_log(
                    &mut log,
                    "[spawn_server] malformed ownership preserved; refusing takeover",
                );
                return Err(SpawnError::SpawnFailed("Malformed ownership retained".into()));
            }
        }
    }

    let mut discovered = find_java_pid_for_rootdir(&data_dir);
    let responding = discovered.is_some()
        && probe_local_server(&target.server_url, LOCAL_SERVER_HEALTH_PROBE_TIMEOUT);
    if let Some(java_pid) = discovered.filter(|_| !responding) {
        // A Java that never answered within its startup window would keep the profile offline.
        if suwayomi_runtime::stop_unresponsive_server(
            &data_dir,
            java_pid,
            suwayomi_runtime::UNRESPONSIVE_SERVER_GRACE,
        ) == Ok(true)
        {
            do_log(&mut log, &format!("[spawn_server] ended Java pid {java_pid} that stopped responding"));
            discovered = None;
        }
    }
    if let Some(java_pid) = discovered {
        if responding {
            let owner = ServerOwner {
                profile_key: target.profile_key.clone(),
                root_dir: data_dir.to_string_lossy().into_owned(),
                app_pid: std::process::id(),
                java_pid,
                port: target.port,
                server_url: target.server_url.clone(),
                started_at: unix_now_secs(),
                run_id: Some(uuid::Uuid::new_v4().to_string()),
                spawned_by_app: false,
                process_identity: runtime_process_identity(java_pid),
            };
            if let Err(err) = write_server_owner_atomic(&owner_path, &owner) {
                return Err(SpawnError::SpawnFailed(format!(
                    "Failed to publish local server owner: {}",
                    err
                )));
            }
            suwayomi_runtime::prune_stop_receipts(&owner_path);
            do_log(
                &mut log,
                &format!(
                    "[spawn_server] reconstructed owner from existing Java pid {}",
                    java_pid
                ),
            );
            return Ok(());
        }

        do_log(
            &mut log,
            &format!(
                "[spawn_server] found live Java pid {} for root {:?}, but probe failed; refusing second spawn",
                java_pid, data_dir
            ),
        );
        return Err(SpawnError::SpawnFailed(
            "Local server process is alive but not responding.".to_string(),
        ));
    }

    match suwayomi_runtime::backup_local_server_files(&data_dir) {
        Ok(Some(backup_dir)) => do_log(
            &mut log,
            &format!(
                "[spawn_server] preflight backup created at {:?}",
                backup_dir
            ),
        ),
        Ok(None) => {}
        Err(err) => do_log(
            &mut log,
            &format!("[spawn_server] preflight backup skipped: {}", err),
        ),
    }

    seed_server_conf(
        &data_dir,
        &target.profile_key,
        target.port,
        update_intensity,
    );
    do_log(&mut log, "[spawn_server] server.conf seeded");

    let mut invocation = match resolve_server_binary(&binary, &data_dir, &app, &mut log) {
        Ok(i) => i,
        Err(e) => {
            do_log(&mut log, &format!("[spawn_server] resolve FAILED: {:?}", e));
            return Err(e);
        }
    };

    let bin_display = invocation.bin.clone();
    let rootdir_flag = format!(
        "-Dsuwayomi.tachidesk.config.server.rootDir={}",
        data_dir.to_string_lossy()
    );

    invocation.args.insert(0, rootdir_flag);
    invocation
        .args
        .insert(1, suwayomi_runtime::managed_java_temp_dir_flag(&data_dir));

    let working_dir = invocation
        .working_dir
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

    do_log(&mut log, &format!("[spawn_server] bin = {:?}", bin_display));
    do_log(
        &mut log,
        &format!("[spawn_server] args = {:?}", invocation.args),
    );
    do_log(
        &mut log,
        &format!("[spawn_server] working_dir = {:?}", working_dir),
    );

    let cmd = app
        .shell()
        .command(&invocation.bin)
        .env("JAVA_TOOL_OPTIONS", LOCAL_SERVER_JAVA_TOOL_OPTIONS)
        .args(&invocation.args)
        .current_dir(&working_dir);

    do_log(&mut log, "[spawn_server] calling cmd.spawn()...");

    match cmd.spawn() {
        Ok((rx, child)) => {
            do_log(
                &mut log,
                &format!("[spawn_server] SUCCESS — spawned: {}", bin_display),
            );
            let java_pid = child.pid();
            do_log(
                &mut log,
                &format!("[spawn_server] child pid = {}", java_pid),
            );
            if let Some(diagnostic_log_path) = &main_startup_diagnostic_path {
                append_timestamped_line(
                    diagnostic_log_path,
                    &format!("spawned child pid={} bin={}", java_pid, bin_display),
                );
                append_timestamped_line(
                    diagnostic_log_path,
                    &format!(
                        "probe target=POST {}/api/graphql timeoutMs=2500",
                        target.server_url
                    ),
                );
                spawn_main_startup_event_drain(rx, diagnostic_log_path.clone(), java_pid);
            }
            let run_id = uuid::Uuid::new_v4().to_string();
            let owner = ServerOwner {
                profile_key: target.profile_key.clone(),
                root_dir: data_dir.to_string_lossy().into_owned(),
                app_pid: std::process::id(),
                java_pid,
                port: target.port,
                server_url: target.server_url.clone(),
                started_at: unix_now_secs(),
                run_id: Some(run_id),
                spawned_by_app: true,
                process_identity: runtime_process_identity(java_pid),
            };

            if let Err(err) = write_server_owner_atomic(&owner_path, &owner) {
                do_log(
                    &mut log,
                    &format!("[spawn_server] owner publish FAILED: {}", err),
                );
                if let Some(diagnostic_log_path) = &main_startup_diagnostic_path {
                    append_timestamped_line(
                        diagnostic_log_path,
                        &format!("owner publish failed: {}", err),
                    );
                }
                if let Err(error) = suwayomi_runtime::stop_spawned_child(&child) { return Err(SpawnError::SpawnFailed(error)); }
                set_runtime_status(
                    &app,
                    suwayomi_runtime::RuntimeLifecycleState::Unavailable,
                    Some(target.profile_key.clone()),
                    Some(target.server_url.clone()),
                    None,
                    Some(format!("Failed to publish local server owner: {err}")),
                );
                return Err(SpawnError::SpawnFailed(format!(
                    "Failed to publish local server owner: {}",
                    err
                )));
            }
            suwayomi_runtime::prune_stop_receipts(&owner_path);
            if let Some(diagnostic_log_path) = &main_startup_diagnostic_path {
                append_timestamped_line(
                    diagnostic_log_path,
                    &format!("owner published pid={} path={:?}", java_pid, owner_path),
                );
            }

            let running = RunningServer {
                child,
                owner_path,
                profile_key: target.profile_key.clone(),
                server_url: target.server_url.clone(),
                port: target.port,
                run_id: owner.run_id.clone().expect("spawn generated run identity"),
                birth_identity: owner.process_identity.clone(),
            };
            let boot_probe_attempts = if data_dir.join("database.mv.db").exists() {
                // Existing profiles can run scheduled backup/update work before binding the API port.
                // Give them enough room to finish startup instead of killing a healthy-but-slow boot.
                150
            } else {
                90
            };
            let mut healthy = false;
            let mut port_collision_message: Option<String> = None;
            let boot_started_at = std::time::Instant::now();
            for attempt in 1..=boot_probe_attempts {
                // Stop waiting for health when the app is closing. The existing
                // failure path below validates this retained run and confirms
                // exit; a shutdown request itself never grants ownership.
                if session_control::shutdown_pending() { break; }
                let probe_started_at = std::time::Instant::now();
                let probe_ok =
                    probe_local_server(&target.server_url, LOCAL_SERVER_HEALTH_PROBE_TIMEOUT);
                let probe_elapsed_ms = probe_started_at.elapsed().as_millis();
                let child_alive = process_is_alive(java_pid);
                let listener_pid = if probe_ok {
                    listener_pid_for_port(target.port)
                } else {
                    None
                };
                let child_matches_root = java_pid_uses_rootdir(java_pid, &data_dir);
                let listener_matches_child = listener_pid == Some(java_pid);
                if let Some(diagnostic_log_path) = &main_startup_diagnostic_path {
                    append_timestamped_line(
                        diagnostic_log_path,
                        &format!(
                            "probe attempt={} elapsedSinceSpawnMs={} probeOk={} probeElapsedMs={} childAlive={} listenerPid={:?} childMatchesRoot={} listenerMatchesChild={}",
                            attempt,
                            boot_started_at.elapsed().as_millis(),
                            probe_ok,
                            probe_elapsed_ms,
                            child_alive,
                            listener_pid,
                            child_matches_root,
                            listener_matches_child
                        ),
                    );
                }
                if probe_ok && child_alive && child_matches_root && listener_matches_child {
                    healthy = true;
                    do_log(
                        &mut log,
                        &format!(
                            "[spawn_server] probe success after spawn on attempt {}",
                            attempt
                        ),
                    );
                    if let Some(diagnostic_log_path) = &main_startup_diagnostic_path {
                        append_timestamped_line(
                            diagnostic_log_path,
                            &format!(
                                "first healthy probe at attempt={} totalElapsedMs={}",
                                attempt,
                                boot_started_at.elapsed().as_millis()
                            ),
                        );
                    }
                    break;
                }
                if probe_ok && (!child_alive || !child_matches_root || !listener_matches_child) {
                    port_collision_message = Some(match listener_pid {
                        Some(pid) if pid != java_pid => format!(
                            "Local server port collision detected on {}: listener pid {} is not spawned child {}.",
                            target.server_url, pid, java_pid
                        ),
                        Some(pid) => format!(
                            "Local server health matched pid {} on {}, but ownership proof failed for root {:?}.",
                            pid, target.server_url, data_dir
                        ),
                        None => format!(
                            "Local server port collision detected on {}: port is healthy but listener ownership could not be verified.",
                            target.server_url
                        ),
                    });
                    do_log(
                        &mut log,
                        &format!(
                            "[spawn_server] probe hit foreign or unverifiable listener on attempt {} listenerPid={:?} childPid={} childAlive={} childMatchesRoot={}",
                            attempt,
                            listener_pid,
                            java_pid,
                            child_alive,
                            child_matches_root
                        ),
                    );
                    if let Some(diagnostic_log_path) = &main_startup_diagnostic_path {
                        append_timestamped_line(
                            diagnostic_log_path,
                            &format!(
                                "port collision classified attempt={} listenerPid={:?} childPid={} childAlive={} childMatchesRoot={}",
                                attempt,
                                listener_pid,
                                java_pid,
                                child_alive,
                                child_matches_root
                            ),
                        );
                    }
                    break;
                }
                if !child_alive {
                    do_log(
                        &mut log,
                        &format!(
                            "[spawn_server] spawned process exited before health check on attempt {}",
                            attempt
                        ),
                    );
                    if let Some(diagnostic_log_path) = &main_startup_diagnostic_path {
                        append_timestamped_line(
                            diagnostic_log_path,
                            &format!(
                                "child no longer alive before healthy probe on attempt={} totalElapsedMs={}",
                                attempt,
                                boot_started_at.elapsed().as_millis()
                            ),
                        );
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }

            if let Some(message) = port_collision_message {
                if let Some(diagnostic_log_path) = &main_startup_diagnostic_path {
                    append_timestamped_line(diagnostic_log_path, &message);
                }
                if let Err(error) = kill_tachidesk_target_for_retained_restart(&running) {
                    *app.state::<ServerState>().0.lock().unwrap() = Some(running);
                    return Err(SpawnError::SpawnFailed(error));
                }
                set_runtime_status(
                    &app,
                    suwayomi_runtime::RuntimeLifecycleState::Unavailable,
                    Some(target.profile_key.clone()),
                    Some(target.server_url.clone()),
                    None,
                    Some(message.clone()),
                );
                return Err(SpawnError::SpawnFailed(message));
            }

            if !healthy {
                do_log(
                    &mut log,
                    "[spawn_server] spawned process never became healthy; killing child",
                );
                if let Some(diagnostic_log_path) = &main_startup_diagnostic_path {
                    append_timestamped_line(
                        diagnostic_log_path,
                        &format!(
                            "spawn failed to become healthy after {} attempts totalElapsedMs={}; killing child",
                            boot_probe_attempts,
                            boot_started_at.elapsed().as_millis()
                        ),
                    );
                }
                if let Err(error) = kill_tachidesk_target_for_retained_restart(&running) {
                    *app.state::<ServerState>().0.lock().unwrap() = Some(running);
                    return Err(SpawnError::SpawnFailed(error));
                }
                set_runtime_status(
                    &app,
                    suwayomi_runtime::RuntimeLifecycleState::Unavailable,
                    Some(target.profile_key.clone()),
                    Some(target.server_url.clone()),
                    None,
                    Some("Local server failed health check after spawn.".to_string()),
                );
                return Err(SpawnError::SpawnFailed(
                    "Local server failed health check after spawn.".to_string(),
                ));
            }

            *app.state::<ServerState>().0.lock().unwrap() = Some(running);
            set_runtime_status(
                &app,
                suwayomi_runtime::RuntimeLifecycleState::Ready,
                Some(target.profile_key),
                Some(target.server_url),
                Some(java_pid),
                None,
            );
            Ok(())
        }
        Err(e) => {
            do_log(&mut log, &format!("[spawn_server] SPAWN FAILED: {}", e));
            do_log(&mut log, &format!("[spawn_server] error kind: {:?}", e));
            set_runtime_status(
                &app,
                suwayomi_runtime::RuntimeLifecycleState::Unavailable,
                Some(target.profile_key),
                Some(target.server_url),
                None,
                Some(e.to_string()),
            );
            Err(SpawnError::SpawnFailed(e.to_string()))
        }
    }
}

pub(crate) fn spawn_managed_server_for_update(
    server_url: String,
    profile_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), SpawnError> {
    if profile_id.as_deref() == Some("main") {
        syncd_sidecar::block_on_core(syncd_sidecar::ensure_host_mode(&app))
            .map_err(SpawnError::SpawnFailed)?;
        // While this process holds the runtime, the Core's supervisor cannot start Suwayomi; the
        // Core starts it on request so the update can check it before letting go.
        if suwayomi_maintenance::exclusive_maintenance_active() {
            syncd_sidecar::request_main_suwayomi_maintenance(
                syncd::lifecycle::SuwayomiMaintenanceAction::Start,
            )
            .map_err(SpawnError::SpawnFailed)?;
        }
        return Ok(());
    }
    spawn_server_unlocked(
        String::new(),
        server_url,
        profile_id,
        None,
        None,
        app,
        false,
    )
}

#[tauri::command]
fn configure_local_server_runtime(
    server_url: String,
    profile_id: Option<String>,
    profile_label: Option<String>,
    update_intensity: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), SpawnError> {
    let _lease = suwayomi_maintenance::try_acquire_shared_file_lease(
        &suwayomi_maintenance::default_runtime_root(),
    )
    .map_err(SpawnError::SpawnFailed)?;
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let mut target = resolve_local_server_target(
        &launch_target,
        Some(server_url.as_str()),
        profile_id.as_deref(),
        profile_label.as_deref(),
    )?;
    if target.attach_only {
        return Ok(());
    }
    if is_builtin_local_server_profile_key(&target.profile_key) {
        target.root_dir = ensure_suwayomi_data_dir(target.profile);
    } else {
        std::fs::create_dir_all(&target.root_dir)
            .map_err(|err| SpawnError::SpawnFailed(err.to_string()))?;
    }
    seed_server_conf(
        &target.root_dir,
        &target.profile_key,
        target.port,
        LocalServerUpdateIntensity::from_option(update_intensity.as_deref()),
    );
    Ok(())
}

#[tauri::command]
async fn prepare_managed_server_startup(
    binary: String,
    server_url: String,
    profile_id: Option<String>,
    profile_label: Option<String>,
    update_intensity: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), SpawnError> {
    configure_local_server_runtime(
        server_url.clone(),
        profile_id.clone(),
        profile_label.clone(),
        update_intensity.clone(),
        app.clone(),
    )?;

    let launch_target = app.state::<LaunchTarget>().0.clone();
    let target = resolve_local_server_target(
        &launch_target,
        Some(server_url.as_str()),
        profile_id.as_deref(),
        profile_label.as_deref(),
    )?;
    if target.attach_only {
        return Ok(());
    }

    match managed_startup_owner(&target.profile_key, target.port) {
        ManagedStartupOwner::PersistentCore => {
            syncd_sidecar::ensure_host_mode(&app)
                .await
                .map_err(SpawnError::SpawnFailed)?;
            Ok(())
        }
        ManagedStartupOwner::Desktop => spawn_server_unlocked(
            binary,
            server_url,
            profile_id,
            profile_label,
            update_intensity,
            app,
            true,
        ),
    }
}

#[cfg(test)]
fn reset_local_profile_root(profile_id: &str) -> Result<PathBuf, String> {
    let profile_key = local_server_profile_key_from_id(Some(profile_id))
        .ok_or_else(|| "Invalid profile id.".to_string())?;
    Ok(local_server_root_for_profile_key(&profile_key))
}

#[tauri::command]
fn reset_local_profile_data(profile_id: String, app: tauri::AppHandle) -> Result<bool, String> {
    let profile_key = local_server_profile_key_from_id(Some(profile_id.as_str()))
        .ok_or_else(|| "Invalid profile id.".to_string())?;
    let server_url = format!(
        "http://127.0.0.1:{}",
        match profile_key.as_str() {
            "main" => default_local_server_port(LocalServerProfile::Main),
            "test" => default_local_server_port(LocalServerProfile::Test),
            _ => {
                return reset_custom_local_profile_data(&profile_key, &app);
            }
        }
    );
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let target = resolve_local_server_target(
        &launch_target,
        Some(server_url.as_str()),
        Some(profile_key.as_str()),
        Some(profile_key.as_str()),
    )
    .map_err(|err| format!("{err:?}"))?;
    reset_resolved_local_profile_data(&target, &app)
}

fn reset_custom_local_profile_data(
    profile_key: &str,
    app: &tauri::AppHandle,
) -> Result<bool, String> {
    let root_dir = local_server_root_for_profile_key(profile_key);
    let server_url = format!("http://127.0.0.1:{}", profile_key);
    let target = LocalServerTarget {
        profile: LocalServerProfile::Test,
        profile_key: profile_key.to_string(),
        root_dir,
        server_url,
        port: 0,
        attach_only: false,
    };
    reset_resolved_local_profile_data(&target, app)
}

fn reset_resolved_local_profile_data(
    target: &LocalServerTarget,
    app: &tauri::AppHandle,
) -> Result<bool, String> {
    let root_dir = target.root_dir.clone();
    let _exclusive = suwayomi_maintenance::begin_exclusive_maintenance(
        &suwayomi_maintenance::default_runtime_root(), "profile-reset", suwayomi_maintenance::MaintenancePhase::Updating,
    )?;
    stop_runtime_for_maintenance(app, target)?;
    if !root_dir.exists() {
        return Ok(false);
    }
    if !root_dir.is_dir() {
        return Err("Profile data path is not a directory.".to_string());
    }

    std::fs::remove_dir_all(&root_dir).map_err(|err| err.to_string())?;
    Ok(true)
}

pub(crate) fn stop_runtime_for_maintenance(app: &tauri::AppHandle, target: &LocalServerTarget) -> Result<(), String> {
    if target.attach_only { return Err("Attached runtime maintenance refused".into()); }
    if managed_startup_owner(&target.profile_key, target.port) != ManagedStartupOwner::PersistentCore {
        return kill_tachidesk_target(app, target);
    }
    // Only the Core holds the handle of the Java it spawned, so it stops it. The exclusive runtime
    // lease held here keeps its supervisor from starting Suwayomi again until maintenance ends.
    if !suwayomi_maintenance::exclusive_maintenance_active() {
        return Err("Persistent Core maintenance requires the exclusive runtime lease; process and profile preserved".into());
    }
    syncd_sidecar::request_main_suwayomi_maintenance(
        syncd::lifecycle::SuwayomiMaintenanceAction::Stop,
    )
    .map(|_| ())
}

#[tauri::command]
fn kill_server(server_url: Option<String>, app: tauri::AppHandle) -> Result<(), String> {
    let _lease = suwayomi_maintenance::try_acquire_shared_file_lease(
        &suwayomi_maintenance::default_runtime_root(),
    )?;
    kill_tachidesk(&app, server_url.as_deref())
}

// ── Update commands ───────────────────────────────────────────────────────────

/// Fetch the list of all GitHub releases so the frontend can show a version picker.
/// Uses tauri-plugin-http so it goes through Tauri's permission system.
#[tauri::command]
async fn list_releases() -> Result<Vec<ReleaseInfo>, String> {
    use tauri_plugin_http::reqwest;

    let repo = EPIGRAPH_GITHUB_REPO
        .or(VITE_EPIGRAPH_GITHUB_REPO)
        .or(LEGACY_AETHON_GITHUB_REPO)
        .or(LEGACY_VITE_AETHON_GITHUB_REPO)
        .map(str::trim)
        .filter(|repo| !repo.is_empty())
        .unwrap_or(DEFAULT_EPIGRAPH_GITHUB_REPO);

    let client = reqwest::Client::builder()
        .user_agent("Epigraph")
        .build()
        .map_err(|e| e.to_string())?;

    let releases_url = format!("https://api.github.com/repos/{repo}/releases?per_page=100");
    let resp = client
        .get(releases_url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {}", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct GhRelease {
        tag_name: String,
        name: Option<String>,
        body: Option<String>,
        published_at: Option<String>,
        html_url: String,
        draft: bool,
        prerelease: bool,
    }

    let body = resp.text().await.map_err(|e| e.to_string())?;
    let releases: Vec<GhRelease> = serde_json::from_str(&body).map_err(|e| e.to_string())?;

    Ok(releases
        .into_iter()
        .filter(|release| {
            is_public_stable_release(&release.tag_name, release.draft, release.prerelease)
        })
        .map(|r| ReleaseInfo {
            tag_name: r.tag_name.clone(),
            name: r.name.unwrap_or_else(|| r.tag_name.clone()),
            body: r.body.unwrap_or_default(),
            published_at: r.published_at.unwrap_or_default(),
            html_url: r.html_url,
        })
        .collect())
}

fn is_public_stable_release(tag_name: &str, draft: bool, prerelease: bool) -> bool {
    !draft
        && !prerelease
        && semver::Version::parse(tag_name.trim().trim_start_matches('v'))
            .map(|version| version.pre.is_empty() && version.build.is_empty())
            .unwrap_or(false)
}

/// Check only the configured signed updater endpoint. GitHub release history is
/// informational and must never be used to announce or authorize installation.
#[tauri::command]
async fn check_epigraph_update(app: tauri::AppHandle) -> Result<EpigraphUpdateStatus, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = tokio::time::timeout(std::time::Duration::from_secs(10), updater.check())
        .await
        .map_err(|_| "Signed update check timed out after 10 seconds.".to_string())?
        .map_err(|e| e.to_string())?;
    let current_version = app.package_info().version.to_string();

    Ok(match update {
        Some(update) => EpigraphUpdateStatus {
            update_available: true,
            current_version,
            version: Some(update.version.to_string()),
            body: update.body,
            published_at: update.date.map(|date| date.to_string()),
        },
        None => EpigraphUpdateStatus {
            update_available: false,
            current_version,
            version: None,
            body: None,
            published_at: None,
        },
    })
}

/// Compatibility alias kept for older frontend bundles and automation scripts.
#[tauri::command]
async fn check_aethon_update(app: tauri::AppHandle) -> Result<EpigraphUpdateStatus, String> {
    check_epigraph_update(app).await
}

/// Download and install the latest update using tauri-plugin-updater.
/// Emits `update-progress` events with `{ downloaded, total }` while downloading.
/// On Windows the installer runs in passive (silent) mode; the frontend prompts restart.
/// On other platforms this command is a no-op — the frontend opens the GitHub page instead.
#[tauri::command]
#[allow(unused_variables)]
async fn download_and_install_update(
    app: tauri::AppHandle,
    expected_version: String,
) -> Result<(), String> {
    // The Windows updater exits through std::process::exit after starting its
    // installer. It cannot bypass the owned shutdown/attested relaunch contract.
    session_control::require_native_install_handoff(std::env::var_os("EPIGRAPH_SESSION_RECORD").is_some())?;
    #[cfg(not(target_os = "windows"))]
    return Err("Native install is Windows-only; open the GitHub release page instead.".into());

    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_updater::UpdaterExt;

        let updater = app.updater().map_err(|e| e.to_string())?;
        let update = updater.check().await.map_err(|e| e.to_string())?;

        let Some(update) = update else {
            return Err("No update available from the updater endpoint.".into());
        };
        let expected = semver::Version::parse(expected_version.trim().trim_start_matches('v'))
            .map_err(|_| "The requested update version is invalid.".to_string())?;
        if update.version.trim().trim_start_matches('v') != expected.to_string() {
            return Err(
                "The signed updater endpoint no longer offers the selected version.".into(),
            );
        }

        let app_clone = app.clone();
        // The updater reports each chunk's length; the event carries the running total, sent
        // once per percent (or per MiB when the size is unknown) instead of once per chunk.
        let mut downloaded: u64 = 0;
        let mut last_step: Option<u64> = None;
        // The signature is verified while downloading, before anything is stopped.
        let bytes = update
            .download(
                move |chunk_length, total| {
                    downloaded += chunk_length as u64;
                    let step = match total {
                        Some(total) if total > 0 => downloaded.saturating_mul(100) / total,
                        _ => downloaded / (1024 * 1024),
                    };
                    if last_step == Some(step) {
                        return;
                    }
                    last_step = Some(step);
                    let _ = app_clone.emit("update-progress", UpdateProgress { downloaded, total });
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;

        // Stopping the owned runtime blocks on Core confirmation, so it runs off the async runtime.
        let handoff_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            session_control::install_after_owned_shutdown(
                || prepare_owned_desktop_shutdown(&handoff_app),
                || update.install(&bytes).map_err(|e| e.to_string()),
            )
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// Restart the app after a successful update install.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    if std::env::var_os("EPIGRAPH_SESSION_RECORD").is_some() {
        return Err("Managed run restart requires graceful close and a fresh attested launcher run".into());
    }
    prepare_owned_desktop_shutdown(&app)?;
    tauri::process::restart(&app.env());
}

#[tauri::command]
fn relaunch_with_args(app: tauri::AppHandle, args: Vec<String>) -> Result<(), String> {
    if std::env::var_os("EPIGRAPH_SESSION_RECORD").is_some() {
        return Err("Managed run relaunch requires graceful close and a fresh run UUID".into());
    }
    prepare_owned_desktop_shutdown(&app)?;
    let exe = std::env::current_exe().map_err(|err| err.to_string())?;
    let mut command = Command::new(exe);
    command.args(args);
    command.spawn().map_err(|err| err.to_string())?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        std::thread::sleep(Duration::from_millis(150));
        app_handle.exit(0);
    });
    Ok(())
}

fn parse_launch_target() -> LaunchTargetInfo {
    let mut server_url_override = None;
    let mut profile_label_override = None;
    let mut server_auth_enabled_override = None;
    let mut server_auth_user_override = None;
    let mut server_auth_pass_override = None;
    let mut audit_open_override = None;
    let mut audit_manga_id_override = None;
    let mut audit_chapter_id_override = None;
    let mut audit_book_id_override = None;
    let mut audit_manga_backup_override = None;
    let mut audit_books_backup_override = None;
    let mut audit_novels_backup_override = None;
    let mut audit_epigraph_backup_override = None;
    let mut restore_manga_backup_override = None;
    let mut restore_epigraph_backup_override = None;
    let mut restore_handoff_override = None;
    let mut restore_source_profile_override = None;
    let mut attach_only_override = None;

    match std::env::var("EPIGRAPH_LAUNCH_PROFILE")
        .ok()
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_uppercase())
    {
        Some(profile) if profile == "MAIN" => {
            server_url_override = Some(builtin_server_url(LocalServerProfile::Main));
            profile_label_override = Some("MAIN".to_string());
        }
        Some(profile) if profile == "TEST" => {
            server_url_override = Some(builtin_server_url(LocalServerProfile::Test));
            profile_label_override = Some("TEST".to_string());
        }
        Some(profile) if !profile.is_empty() => {
            profile_label_override = Some(profile);
        }
        _ => {}
    }

    for arg in std::env::args().skip(1) {
        if let Some(value) = arg.strip_prefix("--server-url=") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                server_url_override = Some(trimmed.trim_end_matches('/').to_string());
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--profile-label=") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                profile_label_override = Some(trimmed.to_uppercase());
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--server-auth-enabled=") {
            let trimmed = value.trim().to_lowercase();
            server_auth_enabled_override =
                Some(matches!(trimmed.as_str(), "1" | "true" | "yes" | "on"));
            continue;
        }

        if let Some(value) = arg.strip_prefix("--server-auth-user=") {
            server_auth_user_override = Some(value.trim().to_string());
            continue;
        }

        if let Some(value) = arg.strip_prefix("--server-auth-pass=") {
            server_auth_pass_override = Some(value.trim().to_string());
            continue;
        }

        if let Some(value) = arg.strip_prefix("--audit-open=") {
            let trimmed = value.trim().to_lowercase();
            if matches!(
                trimmed.as_str(),
                "library"
                    | "manga"
                    | "reader"
                    | "books"
                    | "book"
                    | "book-reader"
                    | "settings"
                    | "settings-security"
            ) {
                audit_open_override = Some(trimmed);
                attach_only_override = Some(true);
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--audit-manga-id=") {
            audit_manga_id_override = value.trim().parse::<i32>().ok();
            continue;
        }

        if let Some(value) = arg.strip_prefix("--audit-chapter-id=") {
            audit_chapter_id_override = value.trim().parse::<i32>().ok();
            continue;
        }

        if let Some(value) = arg.strip_prefix("--audit-book-id=") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                audit_book_id_override = Some(trimmed.to_string());
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--audit-manga-backup=") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                audit_manga_backup_override = Some(trimmed.to_string());
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--audit-books-backup=") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                audit_books_backup_override = Some(trimmed.to_string());
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--audit-novels-backup=") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                audit_novels_backup_override = Some(trimmed.to_string());
            }
            continue;
        }

        if let Some(value) = arg
            .strip_prefix("--audit-epigraph-backup=")
            .or_else(|| arg.strip_prefix("--audit-aethon-backup="))
        {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                audit_epigraph_backup_override = Some(trimmed.to_string());
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--restore-manga-backup=") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                restore_manga_backup_override = Some(trimmed.to_string());
            }
            continue;
        }

        if let Some(value) = arg
            .strip_prefix("--restore-epigraph-backup=")
            .or_else(|| arg.strip_prefix("--restore-aethon-backup="))
        {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                restore_epigraph_backup_override = Some(trimmed.to_string());
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--restore-source-profile=") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                restore_source_profile_override = Some(trimmed.to_ascii_lowercase());
            }
            continue;
        }

        match arg.as_str() {
            "--attach-only" => {
                attach_only_override = Some(true);
            }
            "--restore-handoff" => {
                restore_handoff_override = Some(true);
            }
            "--main" => {
                server_url_override = Some(builtin_server_url(LocalServerProfile::Main));
                profile_label_override = Some("MAIN".to_string());
            }
            "--test" => {
                server_url_override = Some(builtin_server_url(LocalServerProfile::Test));
                profile_label_override = Some("TEST".to_string());
            }
            _ => {}
        }
    }

    LaunchTargetInfo {
        server_url_override,
        profile_label_override,
        server_auth_enabled_override,
        server_auth_user_override,
        server_auth_pass_override,
        audit_open_override,
        audit_manga_id_override,
        audit_chapter_id_override,
        audit_book_id_override,
        audit_manga_backup_override,
        audit_books_backup_override,
        audit_novels_backup_override,
        audit_epigraph_backup_override,
        restore_manga_backup_override,
        restore_epigraph_backup_override,
        restore_handoff_override,
        restore_source_profile_override,
        attach_only_override,
    }
}

fn parse_automation_launch_overrides() -> AutomationLaunchOverrides {
    parse_automation_launch_overrides_from_args(std::env::args().skip(1))
}

fn automation_roaming_app_data_path(local_app_data_dir: &Path) -> PathBuf {
    local_app_data_dir
        .parent()
        .map(|parent| parent.join("RoamingAppData"))
        .unwrap_or_else(|| local_app_data_dir.join("RoamingAppData"))
}

fn automation_local_server_root(local_app_data_dir: &Path, profile: LocalServerProfile) -> PathBuf {
    let sibling_name = match profile {
        LocalServerProfile::Main => "LocalServerMain",
        LocalServerProfile::Test => "LocalServerTest",
    };

    local_app_data_dir
        .parent()
        .map(|parent| parent.join(sibling_name))
        .unwrap_or_else(|| local_app_data_dir.join(sibling_name))
}

fn parse_automation_launch_overrides_from_args<I, S>(args: I) -> AutomationLaunchOverrides
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut overrides = AutomationLaunchOverrides::default();

    for arg in args {
        let arg = arg.as_ref();
        if let Some(value) = arg.strip_prefix("--local-app-data-dir=") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                overrides.local_app_data_dir = Some(PathBuf::from(trimmed));
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--syncd-port=") {
            overrides.syncd_port = value.trim().parse::<u16>().ok();
            continue;
        }

        if let Some(value) = arg.strip_prefix("--syncd-bootstrap-ttl-seconds=") {
            overrides.syncd_bootstrap_ttl_seconds = value.trim().parse::<u64>().ok();
            continue;
        }

        if arg == "--webdriver-automation" {
            overrides.webdriver_automation = true;
        }
    }

    overrides
}

/// Core port of a debug build, so `pnpm tauri:dev` never answers as, or reaches, an installed release's Core.
const DEV_SYNCD_PORT: u16 = 4787;
/// MAIN and TEST Suwayomi ports of a debug build. Sharing 4567 let the development window attach to the
/// installed release's server and show (and risk changing) the real library.
const DEV_LOCAL_SERVER_PORTS: (u16, u16) = (4577, 4677);

/// Where a debug build keeps its data unless `--local-app-data-dir` says otherwise: `EPIGRAPH_DEV_DATA_DIR`, or
/// `Epigraph-dev` beside the real local app data. An installed release never uses this folder.
fn dev_data_root() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os("EPIGRAPH_DEV_DATA_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::data_local_dir().map(|base| base.join("Epigraph-dev")))
}

/// A debug build takes the same isolated layout the automation flag gives, plus its own WebView profile and
/// Core port, so developing never reads or writes an installed release's library, servers or settings.
fn apply_dev_data_isolation(overrides: &mut AutomationLaunchOverrides, root: &Path) {
    if overrides.local_app_data_dir.is_some() {
        return;
    }
    overrides.local_app_data_dir = Some(root.join("LocalAppData"));
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", root.join("WebView2"));
    }
    if overrides.syncd_port.is_none() && std::env::var_os("EPIGRAPH_SYNCD_PORT").is_none() {
        overrides.syncd_port = Some(DEV_SYNCD_PORT);
    }
    if overrides.local_server_ports.is_none()
        && std::env::var_os("EPIGRAPH_LOCAL_SERVER_MAIN_PORT").is_none()
        && std::env::var_os("EPIGRAPH_LOCAL_SERVER_TEST_PORT").is_none()
    {
        overrides.local_server_ports = Some(DEV_LOCAL_SERVER_PORTS);
    }
}

fn apply_automation_launch_overrides() {
    let mut overrides = parse_automation_launch_overrides();
    let explicit_data_dir = overrides.local_app_data_dir.is_some();
    if let Some(root) = dev_data_root() {
        apply_dev_data_isolation(&mut overrides, &root);
    }

    if let Some(path) = overrides.local_app_data_dir {
        let roaming_path = automation_roaming_app_data_path(&path);
        std::env::set_var("LOCALAPPDATA", &path);
        std::env::set_var("APPDATA", &roaming_path);
        // A gate script that already chose its server folders keeps them when only the dev default moved app data.
        if explicit_data_dir || std::env::var_os("EPIGRAPH_LOCAL_SERVER_MAIN_ROOT").is_none() {
            std::env::set_var(
                "EPIGRAPH_LOCAL_SERVER_MAIN_ROOT",
                automation_local_server_root(&path, LocalServerProfile::Main),
            );
        }
        if explicit_data_dir || std::env::var_os("EPIGRAPH_LOCAL_SERVER_TEST_ROOT").is_none() {
            std::env::set_var(
                "EPIGRAPH_LOCAL_SERVER_TEST_ROOT",
                automation_local_server_root(&path, LocalServerProfile::Test),
            );
        }
    }

    if let Some(port) = overrides.syncd_port {
        std::env::set_var("EPIGRAPH_SYNCD_PORT", port.to_string());
    }

    if let Some((main, test)) = overrides.local_server_ports {
        std::env::set_var("EPIGRAPH_LOCAL_SERVER_MAIN_PORT", main.to_string());
        std::env::set_var("EPIGRAPH_LOCAL_SERVER_TEST_PORT", test.to_string());
    }

    if let Some(ttl_seconds) = overrides.syncd_bootstrap_ttl_seconds {
        std::env::set_var(
            "EPIGRAPH_SYNCD_BOOTSTRAP_TTL_SECONDS",
            ttl_seconds.to_string(),
        );
    }

    if overrides.webdriver_automation {
        std::env::set_var("TAURI_WEBVIEW_AUTOMATION", "true");
        std::env::set_var("TAURI_AUTOMATION", "true");
    }
}

#[tauri::command]
fn get_launch_target(state: tauri::State<'_, LaunchTarget>) -> LaunchTargetInfo {
    state.0.clone()
}

#[tauri::command]
fn is_webdriver_automation() -> bool {
    std::env::var("TAURI_WEBVIEW_AUTOMATION")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn configure_webdriver_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if !is_webdriver_automation() {
        return;
    }

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let parse_dimension = |name: &str, fallback: f64| {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite())
            .unwrap_or(fallback)
    };

    let x = parse_dimension("EPIGRAPH_WEBDRIVER_WINDOW_X", 0.0);
    let y = parse_dimension("EPIGRAPH_WEBDRIVER_WINDOW_Y", 0.0);
    let width = parse_dimension("EPIGRAPH_WEBDRIVER_WINDOW_WIDTH", 1280.0).max(800.0);
    let height = parse_dimension("EPIGRAPH_WEBDRIVER_WINDOW_HEIGHT", 800.0).max(600.0);

    // Automation windows are hidden by configuration. Position them before the
    // optional show so a visible capture never flashes on the primary monitor.
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = window.set_size(tauri::PhysicalSize::new(width, height));

    let show_window = std::env::var("EPIGRAPH_WEBDRIVER_SHOW_WINDOW")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false);
    if show_window {
        let _ = window.show();
    }
}

#[tauri::command]
fn begin_suwayomi_runtime_operation(scope: String) -> Result<String, String> {
    let runtime_root = suwayomi_maintenance::default_runtime_root();
    let token = suwayomi_maintenance::begin_operation(&runtime_root, &scope)?;
    // The main profile's server outlives this app, so an update abandoned on it can leave it running
    // something unverified until the Core undoes it; writes made before that would be lost.
    if suwayomi_recovery::abandoned_work_for_profile(&runtime_root, LocalServerProfile::Main.key()) {
        suwayomi_maintenance::end_operation(&token);
        return Err(
            "Suwayomi is temporarily unavailable while its runtime is maintained.".to_string(),
        );
    }
    Ok(token)
}

#[tauri::command]
fn end_suwayomi_runtime_operation(token: String) -> bool {
    suwayomi_maintenance::end_operation(&token)
}

#[tauri::command]
fn record_media_audit_event(event: String) -> Result<(), String> {
    let path = match std::env::var("EPIGRAPH_MEDIA_AUDIT_LOG") {
        Ok(path) if !path.trim().is_empty() => PathBuf::from(path),
        _ => return Ok(()),
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    let sanitized = event.replace(&['\r', '\n'][..], " ");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| err.to_string())?;
    writeln!(file, "{}", sanitized).map_err(|err| err.to_string())
}

// ── App entry point ───────────────────────────────────────────────────────────

static DESKTOP_EXIT_CONFIRMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static DESKTOP_SHUTDOWN: Mutex<()> = Mutex::new(());

pub(crate) fn prepare_owned_desktop_shutdown(app: &tauri::AppHandle) -> Result<(), String> {
    let _shutdown = DESKTOP_SHUTDOWN.lock().map_err(|_| "Shutdown state unavailable")?;
    if DESKTOP_EXIT_CONFIRMED.load(std::sync::atomic::Ordering::Acquire) { return Ok(()); }
    session_control::quiesce(Duration::from_secs(15))?;
    // Use the retained scope even when the selected UI profile changed. An empty
    // retained state means this app has no spawn authority, not that other PIDs died.
    let state = app.state::<ServerState>();
    let mut running = state.0.lock().map_err(|_| "Runtime state unavailable")?;
    if let Some(owned) = running.as_ref() { kill_tachidesk_target_for_retained_restart(owned)?; }
    running.take();
    drop(running);
    syncd_sidecar::shutdown_confirmed(app)?;
    #[cfg(windows)]
    if FLARESOLVERR_LOCAL_JOB.lock().map_err(|_| "FlareSolverr state unavailable")?.is_some() {
        stop_flaresolverr_local()?;
    }
    clear_suwayomi_lan_state();
    DESKTOP_EXIT_CONFIRMED.store(true, std::sync::atomic::Ordering::Release);
    Ok(())
}

fn request_owned_desktop_shutdown(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        match prepare_owned_desktop_shutdown(&app) {
            Ok(()) => app.exit(0),
            Err(error) => eprintln!("[desktop shutdown] {error}; application and evidence preserved"),
        }
    });
}

const MAIN_WINDOW_LABEL: &str = "main";

/// Application commands are registered without an ACL app manifest, so Tauri would accept them
/// from every webview. Secondary webviews run untrusted content: the novel runtime host executes
/// third-party LNReader plugin code with `globalThis`, and the reader/tracker windows load remote
/// sites. None of them needs an application command (the runtime host talks to the main window
/// through events only), so filesystem, process, pairing and profile commands stay reserved for the
/// main window. Plugin commands keep their capability-based permissions.
fn main_window_commands_only<F>(
    handler: F,
) -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static
where
    F: Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static,
{
    move |invoke: tauri::ipc::Invoke| {
        if !is_trusted_command_webview(invoke.message.webview().label()) {
            invoke
                .resolver
                .reject("This command is only available to the main Epigraph window.");
            return true;
        }
        handler(invoke)
    }
}

fn is_trusted_command_webview(label: &str) -> bool {
    label == MAIN_WINDOW_LABEL
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    compat::promote_legacy_environment();
    apply_automation_launch_overrides();
    ensure_process_rustls_crypto_provider();
    ensure_dev_webview2_debug_port();
    let app = tauri::Builder::default()
        .register_uri_scheme_protocol("book", |_ctx, request| serve_book_asset(request))
        .register_uri_scheme_protocol("cover", |_ctx, request| serve_library_cover_asset(request))
        .register_asynchronous_uri_scheme_protocol("offline-page", |ctx, request, responder| {
            let trusted = offline_chapter::may_read_pages(ctx.webview_label());
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(offline_chapter::serve_page(trusted, &request))
            });
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(LaunchTarget(parse_launch_target()))
        .manage(ServerState(Mutex::new(None)))
        .manage(RuntimeSupervisorState(Mutex::new(
            suwayomi_runtime::RuntimeStatus::default(),
        )))
        .manage(syncd_desktop::SyncdDesktopState::default())
        .manage(syncd_replication::SyncdReplicationState::default())
        .manage(syncd_sidecar::SyncdState::default())
        .invoke_handler(main_window_commands_only(tauri::generate_handler![
            restore_commands::restore_context,
            cloudflare_solver::builtin_cloudflare_solver_url,
            restore_commands::restore_session_admit,
            restore_commands::restore_session_release,
            restore_commands::restore_input_put,
            restore_commands::restore_input_read,
            restore_commands::restore_journal_list,
            restore_commands::restore_journal_read,
            restore_commands::restore_journal_cas,
            restore_commands::restore_operation_admit,
            restore_commands::restore_operation_validate,
            restore_commands::restore_operation_settle,
            restore_commands::restore_operation_settle_terminal,
            session_control::session_page_attestation,
            get_launch_target,
            get_builtin_server_ports,
            is_webdriver_automation,
            record_media_audit_event,
            discord_rpc::discord_rpc_start,
            discord_rpc::discord_rpc_stop,
            discord_rpc::discord_rpc_clear_activity,
            discord_rpc::discord_rpc_set_activity,
            discord_cover::optimize_discord_cover,
            syncd_desktop::syncd_list_discovery_candidates,
            syncd_desktop::syncd_start_host_pairing,
            syncd_desktop::syncd_get_active_host_pairing,
            syncd_desktop::syncd_get_runtime_identity,
            syncd_desktop::syncd_connect_with_bootstrap,
            syncd_desktop::syncd_resolve_pairing_pin,
            syncd_desktop::syncd_host_decide_pairing,
            syncd_desktop::syncd_list_paired_devices,
            syncd_desktop::syncd_request_progress_mirror,
            syncd_desktop::syncd_publish_tracker_login,
            syncd_desktop::syncd_publish_tracker_logout,
            syncd_desktop::syncd_start_myanimelist_login,
            syncd_desktop::syncd_complete_myanimelist_login,
            syncd_desktop::syncd_update_paired_device_granted_scopes,
            syncd_desktop::syncd_revoke_paired_device,
            syncd_desktop::syncd_list_persisted_sync_sessions,
            syncd_desktop::syncd_revalidate_persisted_sync_sessions,
            syncd_desktop::syncd_disconnect_persisted_session,
            syncd_replication::syncd_get_replication_state,
            syncd_replication::syncd_set_active_replication_session,
            syncd_replication::syncd_pause_replication,
            syncd_replication::syncd_resume_replication,
            syncd_replication::syncd_force_replication_reconnect,
            syncd_replication::syncd_get_session_catalog,
            syncd_replication::syncd_revalidate_session,
            syncd_replication::syncd_forget_persisted_session,
            syncd_replication::syncd_publish_comic_reader_mutation,
            syncd_replication::syncd_get_comic_server_fingerprint,
            syncd_replication::syncd_get_pending_comic_reader_changes,
            syncd_replication::syncd_ack_comic_reader_changes,
            get_storage_info,
            get_default_downloads_path,
            offline_chapter::open_downloaded_chapter,
            check_path_exists,
            create_directory,
            check_downloads_move,
            migrate_downloads,
            read_reconciliation_overlay,
            write_reconciliation_overlay,
            read_novel_repository_state,
            write_novel_repository_state,
            read_novel_source_classification_state,
            write_novel_source_classification_state,
            read_extension_compatibility_state,
            write_extension_compatibility_state,
            read_book_library_state,
            write_book_library_state,
            read_migration_journal_state,
            write_migration_journal_state,
            resolve_book_storage_root,
            read_novel_library_state,
            write_novel_library_state,
            resolve_novel_storage_root,
            remove_novel_plugin_installation,
            list_novel_cached_chapters,
            delete_novel_cached_chapters,
            open_reader_webview,
            open_tracker_oauth_window,
            close_tracker_oauth_window,
            close_reader_webview,
            reader_webview_is_open,
            close_novel_runtime_host,
            novel_runtime_host_is_open,
            read_file_base64,
            write_file_base64,
            compute_file_sha256,
            get_cached_library_cover,
            cache_library_cover,
            copy_book_import,
            write_book_asset,
            write_book_cover,
            remove_book_assets,
            spawn_server,
            configure_local_server_runtime,
            prepare_managed_server_startup,
            reset_local_profile_data,
            kill_server,
            get_platform_ui_scale,
            get_flaresolverr_local_status,
            start_flaresolverr_local,
            stop_flaresolverr_local,
            open_flaresolverr_local_folder,
            open_flaresolverr_local_logs,
            open_app_logs,
            get_flaresolverr_docker_status,
            start_flaresolverr_docker,
            stop_flaresolverr_docker,
            list_releases,
            check_epigraph_update,
            check_aethon_update,
            suwayomi_update::get_suwayomi_runtime_status,
            suwayomi_update::check_suwayomi_runtime_update,
            suwayomi_update::get_suwayomi_update_lock_status,
            begin_suwayomi_runtime_operation,
            end_suwayomi_runtime_operation,
            suwayomi_update::create_suwayomi_update_snapshot,
            suwayomi_update::stage_suwayomi_runtime_update,
            suwayomi_update::promote_suwayomi_runtime_update,
            suwayomi_update::install_suwayomi_runtime_update,
            suwayomi_update::certify_suwayomi_extension_update_batch,
            download_and_install_update,
            probe_server_health,
            get_runtime_diagnostics,
            get_local_runtime_status,
            restart_app,
            relaunch_with_args,
        ]))
        .setup(|app| {
            // Do not hold the first paint hostage to a potentially large legacy
            // data tree. The merge is idempotent and conflict-safe; running it
            // in the Tauri blocking pool lets the Epigraph window become usable
            // while legacy data is copied in the background.
            tauri::async_runtime::spawn_blocking(compat::migrate_legacy_storage);
            configure_webdriver_window(app.handle());
            cloudflare_solver::start(app.handle());
            session_control::install(app.handle())
                .map_err(|err| -> Box<dyn std::error::Error> { err.into() })?;
            maybe_start_phase_gate_temporary_lan_session();
            sanitize_suwayomi_lan_state();
            schedule_suwayomi_lan_session_watchers(app.handle());
            syncd_sidecar::maybe_install_exit_sentinel(app.handle());
            tauri::async_runtime::block_on(syncd_sidecar::maybe_spawn_for_phase_gate(app.handle()))
                .map_err(|err| -> Box<dyn std::error::Error> { err.into() })?;
            syncd_sidecar::attach_existing_host_in_background(app.handle());
            tauri::async_runtime::block_on(syncd_replication::bootstrap_runtime(
                app.handle().clone(),
                app.state::<syncd_replication::SyncdReplicationState>()
                    .inner()
                    .clone(),
            ))
            .map_err(|err| -> Box<dyn std::error::Error> { err.into() })?;
            session_control::ready();
            Ok(())
        })
        .on_page_load(|window, _payload| { if window.label() == "main" { session_control::page_loaded(); } })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    request_owned_desktop_shutdown(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building epigraph");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = &event {
            if !DESKTOP_EXIT_CONFIRMED.load(std::sync::atomic::Ordering::Acquire) {
                api.prevent_exit();
                request_owned_desktop_shutdown(app_handle);
                return;
            }
        }
        if DESKTOP_EXIT_CONFIRMED.load(std::sync::atomic::Ordering::Acquire) { return; }
        syncd_sidecar::handle_run_event(app_handle, &event);
        if matches!(event, tauri::RunEvent::Exit) {
            if let Err(error) = kill_tachidesk(app_handle, None) { eprintln!("[runtime cleanup] {error}"); }
            clear_suwayomi_lan_state();
        }
    });
}
