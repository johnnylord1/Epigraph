mod discord_cover;
mod discord_rpc;
mod compat;
mod migration_journal;
mod suwayomi_lan;
mod suwayomi_maintenance;
mod suwayomi_runtime;
mod suwayomi_update;
pub mod syncd;
mod syncd_desktop;
mod syncd_replication;
mod syncd_sidecar;

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
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            CreateProcessW, ResumeThread, TerminateProcess, CREATE_NO_WINDOW, CREATE_SUSPENDED,
            PROCESS_INFORMATION, STARTUPINFOW,
        },
    },
};

#[derive(Clone, Serialize)]
struct TrackerOAuthCallbackPayload {
    url: String,
}

fn is_tracker_oauth_callback(url: &Url) -> bool {
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
    spawn_lock_path: PathBuf,
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
        LocalServerProfile::Main => 4567,
        LocalServerProfile::Test => 4667,
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
        unsafe {
            TerminateProcess(process_info.hProcess, 1);
            CloseHandle(process_info.hThread);
            CloseHandle(process_info.hProcess);
        }
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
    let job = FLARESOLVERR_LOCAL_JOB
        .lock()
        .map_err(|_| "FlareSolverr Job Object state is unavailable.".to_string())?
        .take();
    let Some(job) = job else {
        return Err("The FlareSolverr process tree has no active Job Object.".to_string());
    };
    if job.pid != pid {
        unsafe { CloseHandle(job.handle as HANDLE) };
        return Err("The FlareSolverr Job Object does not match the ownership lease.".to_string());
    }
    let terminated = unsafe {
        let handle = job.handle as HANDLE;
        let result = TerminateJobObject(handle, 1) != 0;
        CloseHandle(handle);
        result
    };
    if !terminated {
        return Err(
            "Could not terminate the Epigraph-managed FlareSolverr process tree.".to_string(),
        );
    }
    Ok(())
}

#[cfg(not(windows))]
fn terminate_local_flaresolverr_job(pid: u32) -> Result<(), String> {
    let system = System::new_all();
    if let Some(process) = system.process(Pid::from_u32(pid)) {
        let _ = process.kill();
    }
    Ok(())
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
        release_local_flaresolverr_job(owner.pid);
        let _ = fs::remove_file(local_flaresolverr_owner_path());
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
async fn open_tracker_oauth_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(url.trim()).map_err(|e| e.to_string())?;
    let handle = app.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let label = "tracker-oauth";

            if let Some(window) = handle.get_webview_window(label) {
                let _ = window.destroy();
            }

            let nav_handle = handle.clone();
            let window = tauri::WebviewWindowBuilder::new(
                &handle,
                label,
                tauri::WebviewUrl::External(parsed),
            )
            .title("Tracker Login")
            .on_navigation(move |next_url| {
                if is_tracker_oauth_callback(next_url) {
                    let callback_url = next_url.to_string();
                    let _ = nav_handle.emit(
                        "tracker-oauth-callback",
                        TrackerOAuthCallbackPayload { url: callback_url },
                    );

                    let close_handle = nav_handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(250));
                        if let Some(window) = close_handle.get_webview_window(label) {
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

fn book_library_state_path_for_profile(profile_id: Option<&str>) -> Result<PathBuf, String> {
    let root = books_data_dir();
    let profile_key = profile_id
        .and_then(sanitize_custom_profile_key)
        .unwrap_or_else(|| "main".to_string());

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
    let root = books_data_dir();

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
        let folder = books_data_dir().join("test-assets");
        let _ = std::fs::create_dir_all(&folder);
        let path = folder.join("reader-contract.epub");
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

        let head_response = serve_book_asset(head_request);
        let get_response = serve_book_asset(get_request);

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
        let folder = books_data_dir().join("test-assets");
        let _ = std::fs::create_dir_all(&folder);
        let path = folder.join("reader-contract.pdf");
        std::fs::write(&path, b"0123456789").unwrap();
        let uri = encode_book_asset_uri(&path);

        let request = Request::builder()
            .method("GET")
            .uri(&uri)
            .header(RANGE, "bytes=0-0")
            .body(Vec::<u8>::new())
            .unwrap();

        let response = serve_book_asset(request);

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
            process_identity: None,
        };

        assert!(matches!(
            validate_server_owner(&target, &owner),
            OwnerReuseDecision::Stale
        ));
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
    if request.method().as_str().eq_ignore_ascii_case("OPTIONS") {
        return book_asset_preflight_response();
    }

    let path = match resolve_book_asset_path(&request) {
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
    fs::write(&destination, bytes).map_err(|err| err.to_string())?;
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
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "bin".to_string());

    let folder = match ext.as_str() {
        "epub" => "epubs",
        "pdf" => "pdfs",
        _ => "imports",
    };

    let dest_dir = books_data_dir().join(folder);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest_path = dest_dir.join(format!("{book_id}.{ext}"));
    std::fs::copy(&source, &dest_path).map_err(|e| e.to_string())?;
    Ok(dest_path.to_string_lossy().to_string())
}

#[tauri::command]
fn write_book_cover(book_id: String, bytes_base64: String, ext: String) -> Result<String, String> {
    let dest_dir = books_data_dir().join("covers");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest_path = dest_dir.join(format!("{book_id}.{}", ext.trim_matches('.')));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|e| e.to_string())?;
    std::fs::write(&dest_path, bytes).map_err(|e| e.to_string())?;
    Ok(dest_path.to_string_lossy().to_string())
}

#[tauri::command]
fn write_book_asset(book_id: String, bytes_base64: String, ext: String) -> Result<String, String> {
    let ext = ext.trim_matches('.').to_ascii_lowercase();
    let folder = match ext.as_str() {
        "epub" => "epubs",
        "pdf" => "pdfs",
        _ => "imports",
    };

    let dest_dir = books_data_dir().join(folder);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest_path = dest_dir.join(format!("{book_id}.{ext}"));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|e| e.to_string())?;
    std::fs::write(&dest_path, bytes).map_err(|e| e.to_string())?;
    Ok(dest_path.to_string_lossy().to_string())
}

#[tauri::command]
fn remove_book_assets(
    asset_path: Option<String>,
    cover_path: Option<String>,
) -> Result<(), String> {
    for path in [asset_path, cover_path].into_iter().flatten() {
        let candidate = PathBuf::from(path);
        if !candidate.exists() {
            continue;
        }
        std::fs::remove_file(&candidate).map_err(|e| e.to_string())?;
    }
    Ok(())
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

fn resolve_downloads_path(downloads_path: &str) -> PathBuf {
    resolve_downloads_path_for_profile(downloads_path, None)
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
fn get_storage_info(downloads_path: String) -> Result<StorageInfo, String> {
    let path = resolve_downloads_path(&downloads_path);

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

fn download_name_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[tauri::command]
fn read_downloaded_chapter_archive(
    downloads_path: String,
    source_name: String,
    manga_title: String,
    chapter_name: String,
    scanlator: Option<String>,
) -> Result<Option<String>, String> {
    let root = resolve_downloads_path(&downloads_path);
    let manga_dir = root.join("mangas").join(&source_name).join(&manga_title);
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

    let chapter_key = download_name_key(&chapter_name);
    let scanlator_key = scanlator
        .as_deref()
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

    let Some((_, path)) = best_match else {
        return Ok(None);
    };
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(Some(
        base64::engine::general_purpose::STANDARD.encode(bytes),
    ))
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
    let system = System::new_all();
    let process = system.process(Pid::from_u32(pid))?;
    let args = process
        .cmd()
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    Some(suwayomi_runtime::RuntimeProcessIdentity {
        pid,
        process_creation_time: Some(process.start_time()),
        executable_path: process
            .exe()
            .map(|path| path.to_string_lossy().into_owned()),
        command_line_hash: Some(suwayomi_runtime::command_line_hash(&args)),
    })
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

fn backup_local_server_files(data_dir: &Path) -> std::io::Result<Option<PathBuf>> {
    let candidates = ["server.conf", "database.mv.db", "database.trace.db"];
    let existing: Vec<PathBuf> = candidates
        .iter()
        .map(|name| data_dir.join(name))
        .filter(|path| path.exists())
        .collect();

    if existing.is_empty() {
        return Ok(None);
    }

    let backup_dir = data_dir
        .join("epigraph-backups")
        .join(format!("preflight-{}", unix_now_secs()));
    std::fs::create_dir_all(&backup_dir)?;
    for source in existing {
        if let Some(name) = source.file_name() {
            let _ = std::fs::copy(&source, backup_dir.join(name));
        }
    }

    Ok(Some(backup_dir))
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

fn local_server_custom_profile_root(profile_key: &str) -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| suwayomi_data_dir());
    base.join(format!("epigraph-profile-{profile_key}"))
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
        .or_else(|| match port {
            4567 => Some("main".to_string()),
            4667 => Some("test".to_string()),
            _ => Some(format!("profile-{port}")),
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

#[tauri::command]
fn probe_server_health(server_url: String) -> bool {
    probe_local_server(&server_url, LOCAL_SERVER_HEALTH_PROBE_TIMEOUT)
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

#[cfg(windows)]
fn atomic_replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    let from_w: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to_w: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        MoveFileExW(
            from_w.as_ptr(),
            to_w.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
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

fn remove_server_owner_files(data_dir: &Path) {
    let _ = std::fs::remove_file(server_owner_path(data_dir));
    let _ = std::fs::remove_file(server_owner_tmp_path(data_dir));
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

    if let Some(expected) = &owner.process_identity {
        let Some(actual) = runtime_process_identity(owner.java_pid) else {
            return OwnerReuseDecision::Stale;
        };
        if expected.process_creation_time != actual.process_creation_time
            || expected.executable_path != actual.executable_path
            || expected.command_line_hash != actual.command_line_hash
        {
            return OwnerReuseDecision::Stale;
        }
    }

    if !probe_local_server(&target.server_url, LOCAL_SERVER_HEALTH_PROBE_TIMEOUT) {
        return OwnerReuseDecision::ConflictingLiveProcess;
    }

    OwnerReuseDecision::Reusable
}

fn acquire_spawn_lock(lock_path: &Path, data_dir: &Path) -> std::io::Result<bool> {
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock_path)
    {
        Ok(mut file) => {
            let _ = writeln!(file, "pid={}", std::process::id());
            let _ = writeln!(file, "rootDir={}", data_dir.to_string_lossy());
            let _ = writeln!(file, "timestamp={}", unix_now_secs());
            file.sync_all()?;
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = std::fs::metadata(lock_path)?;
            let is_stale = metadata
                .modified()
                .ok()
                .and_then(|time| SystemTime::now().duration_since(time).ok())
                .map(|age| age > Duration::from_secs(45))
                .unwrap_or(true);

            if is_stale {
                let _ = std::fs::remove_file(lock_path);
                acquire_spawn_lock(lock_path, data_dir)
            } else {
                Ok(false)
            }
        }
        Err(err) => Err(err),
    }
}

#[tauri::command]
async fn download_server_file_to_downloads(
    url: String,
    filename: Option<String>,
    auth_header: Option<String>,
) -> Result<String, String> {
    use tauri_plugin_http::reqwest;

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = client.get(url.trim());
    if let Some(header) = auth_header.as_ref().filter(|h| !h.trim().is_empty()) {
        request = request.header("Authorization", header.trim());
    }

    let response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Download failed with HTTP {}", response.status()));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let downloads_dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Could not resolve Downloads directory".to_string())?;

    std::fs::create_dir_all(&downloads_dir).map_err(|e| e.to_string())?;

    let raw_name = filename
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("epigraph-backup.tachibk");
    let safe_name: String = raw_name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect();

    let target = downloads_dir.join(safe_name);
    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;

    Ok(target.to_string_lossy().into_owned())
}

/// Moves all content from `src` into `dst`, then removes `src`.
/// Emits `migrate_progress` events: `{ done, total, current }`.
/// Only deletes the source tree after every file is confirmed copied.
#[tauri::command]
async fn migrate_downloads(app: tauri::AppHandle, src: String, dst: String) -> Result<(), String> {
    use std::fs;
    use tauri::Emitter;

    let src_path = std::path::PathBuf::from(src.trim());
    let dst_path = std::path::PathBuf::from(dst.trim());

    if !src_path.is_dir() {
        return Ok(()); // nothing to migrate
    }

    // Count files first so the frontend can show accurate progress
    let total: u64 = WalkDir::new(&src_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .count() as u64;

    let _ = app.emit(
        "migrate_progress",
        serde_json::json!({
            "done": 0u64, "total": total, "current": ""
        }),
    );

    let mut done: u64 = 0;

    for entry in WalkDir::new(&src_path).into_iter().filter_map(|e| e.ok()) {
        let rel = entry
            .path()
            .strip_prefix(&src_path)
            .map_err(|e| e.to_string())?;
        let target = dst_path.join(rel);

        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
            done += 1;
            let _ = app.emit(
                "migrate_progress",
                serde_json::json!({
                    "done": done,
                    "total": total,
                    "current": rel.to_string_lossy()
                }),
            );
        }
    }

    // Only remove source after all files are confirmed copied
    fs::remove_dir_all(&src_path).map_err(|e| e.to_string())?;
    Ok(())
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
    std::fs::write(path, contents).map_err(|e| e.to_string())
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
    if server_url.as_deref().is_none_or(str::is_empty) {
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
    std::fs::write(&path, contents).map_err(|err| err.to_string())?;
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
    std::fs::write(&path, contents).map_err(|err| err.to_string())?;
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
    std::fs::write(&path, contents).map_err(|err| err.to_string())?;
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

fn kill_tachidesk(app: &tauri::AppHandle, server_url: Option<&str>) {
    let launch_target = app.state::<LaunchTarget>().0.clone();
    let Ok(target) = resolve_local_server_target(&launch_target, server_url, None, None) else {
        return;
    };
    kill_tachidesk_target(app, &target);
}

pub(crate) fn kill_tachidesk_target(app: &tauri::AppHandle, target: &LocalServerTarget) {
    let running = {
        let state = app.state::<ServerState>();
        let mut guard = state.0.lock().unwrap();
        match guard.as_ref() {
            Some(running) if running.owner_path == server_owner_path(&target.root_dir) => {
                guard.take()
            }
            _ => None,
        }
    };

    if let Some(running) = running {
        let _ = running.child.kill();
        let _ = std::fs::remove_file(&running.spawn_lock_path);
        let _ = std::fs::remove_file(&running.owner_path);
        if let Some(parent) = running.owner_path.parent() {
            let _ = std::fs::remove_file(parent.join("server.owner.json.tmp"));
        }
        set_runtime_status(
            app,
            suwayomi_runtime::RuntimeLifecycleState::Unavailable,
            Some(target.profile_key.clone()),
            Some(target.server_url.clone()),
            None,
            None,
        );
        return;
    }

    let owner_path = server_owner_path(&target.root_dir);
    let Some(owner) = read_server_owner(&owner_path) else {
        return;
    };

    let mut system = System::new_all();
    system.refresh_all();
    if let Some(process) = system.process(Pid::from_u32(owner.java_pid)) {
        let _ = process.kill();
    }
    let _ = std::fs::remove_file(server_spawn_lock_path(&target.root_dir));
    remove_server_owner_files(&target.root_dir);
    set_runtime_status(
        app,
        suwayomi_runtime::RuntimeLifecycleState::Unavailable,
        Some(target.profile_key.clone()),
        Some(target.server_url.clone()),
        None,
        None,
    );
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
            kill_tachidesk(&app, Some(&server_url));
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

fn managed_suwayomi_runtime_jar_path() -> PathBuf {
    suwayomi_data_dir()
        .join("suwayomi-runtime")
        .join("current")
        .join("Suwayomi-Server.jar")
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
    tauri::async_runtime::spawn(async move {
        if !startup_diagnostics_enabled() {
            while rx.recv().await.is_some() {}
            return;
        }
        append_timestamped_line(
            &diagnostic_log_path,
            &format!("[child {}] event drain started", java_pid),
        );
        while let Some(event) = rx.recv().await {
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
                let managed_runtime_jar = managed_suwayomi_runtime_jar_path();
                do_log(
                    log,
                    &format!(
                        "[resolve] managed runtime jar = {:?} exists={}",
                        managed_runtime_jar,
                        managed_runtime_jar.exists()
                    ),
                );
                if managed_runtime_jar.exists() {
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
    if target.profile_key == "main" && target.port == 4567 && !target.attach_only {
        let instance = syncd::suwayomi_process::ensure_main_owned_instance()
            .await
            .map_err(SpawnError::SpawnFailed)?;
        match instance {
            syncd::suwayomi_process::HeadlessSuwayomiOutcome::Attached(instance)
            | syncd::suwayomi_process::HeadlessSuwayomiOutcome::Started(instance) => {
                set_runtime_status(
                    &app,
                    suwayomi_runtime::RuntimeLifecycleState::Ready,
                    Some(instance.profile_key),
                    Some(instance.server_url),
                    Some(instance.java_pid),
                    None,
                );
                return Ok(());
            }
            syncd::suwayomi_process::HeadlessSuwayomiOutcome::NotConfigured => {
                return Err(SpawnError::NotConfigured(
                    "Managed Suwayomi is not configured for the main profile.".to_string(),
                ));
            }
        }
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
                do_log(
                    &mut log,
                    &format!(
                        "[spawn_server] tracked server belongs to a different root {:?}; continuing target validation",
                        running.owner_path.parent()
                    ),
                );
            }
        }
        drop(guard);
        if let Some(running) = stale_tracked_server {
            let _ = running.child.kill();
            let _ = std::fs::remove_file(&running.spawn_lock_path);
            let _ = std::fs::remove_file(&running.owner_path);
            if let Some(parent) = running.owner_path.parent() {
                let _ = std::fs::remove_file(parent.join("server.owner.json.tmp"));
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

    match acquire_spawn_lock(&spawn_lock_path, &data_dir) {
        Ok(true) => {
            do_log(
                &mut log,
                &format!("[spawn_server] acquired spawn lock {:?}", spawn_lock_path),
            );
        }
        Ok(false) => {
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
    }

    if owner_tmp_path.exists() {
        do_log(
            &mut log,
            "[spawn_server] removing stale partial owner tmp before validation",
        );
        let _ = std::fs::remove_file(&owner_tmp_path);
    }

    if owner_path.exists() {
        match read_server_owner(&owner_path) {
            Some(owner) => match validate_server_owner(&target, &owner) {
                OwnerReuseDecision::Reusable => {
                    do_log(
                        &mut log,
                        "[spawn_server] owner valid, reusing existing server",
                    );
                    let _ = std::fs::remove_file(&spawn_lock_path);
                    return Ok(());
                }
                OwnerReuseDecision::Stale => {
                    do_log(&mut log, "[spawn_server] owner stale, removing");
                    remove_server_owner_files(&data_dir);
                }
                OwnerReuseDecision::ConflictingLiveProcess => {
                    do_log(
                        &mut log,
                        "[spawn_server] owner points to a live but unhealthy Java process; refusing second spawn",
                    );
                    let _ = std::fs::remove_file(&spawn_lock_path);
                    return Err(SpawnError::SpawnFailed(
                        "Local server process is alive but not healthy. Stop it and retry."
                            .to_string(),
                    ));
                }
            },
            None => {
                do_log(
                    &mut log,
                    "[spawn_server] owner file is malformed or partial; removing stale owner files",
                );
                remove_server_owner_files(&data_dir);
            }
        }
    }

    if let Some(java_pid) = find_java_pid_for_rootdir(&data_dir) {
        if probe_local_server(&target.server_url, LOCAL_SERVER_HEALTH_PROBE_TIMEOUT) {
            let owner = ServerOwner {
                profile_key: target.profile_key.clone(),
                root_dir: data_dir.to_string_lossy().into_owned(),
                app_pid: std::process::id(),
                java_pid,
                port: target.port,
                server_url: target.server_url.clone(),
                started_at: unix_now_secs(),
                run_id: Some(uuid::Uuid::new_v4().to_string()),
                process_identity: runtime_process_identity(java_pid),
            };
            if let Err(err) = write_server_owner_atomic(&owner_path, &owner) {
                let _ = std::fs::remove_file(&spawn_lock_path);
                return Err(SpawnError::SpawnFailed(format!(
                    "Failed to publish local server owner: {}",
                    err
                )));
            }
            do_log(
                &mut log,
                &format!(
                    "[spawn_server] reconstructed owner from existing Java pid {}",
                    java_pid
                ),
            );
            let _ = std::fs::remove_file(&spawn_lock_path);
            return Ok(());
        }

        do_log(
            &mut log,
            &format!(
                "[spawn_server] found live Java pid {} for root {:?}, but probe failed; refusing second spawn",
                java_pid, data_dir
            ),
        );
        let _ = std::fs::remove_file(&spawn_lock_path);
        return Err(SpawnError::SpawnFailed(
            "Local server process is alive but not responding.".to_string(),
        ));
    }

    match backup_local_server_files(&data_dir) {
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

    let mut invocation = match resolve_server_binary(&binary, &app, &mut log) {
        Ok(i) => i,
        Err(e) => {
            let _ = std::fs::remove_file(&spawn_lock_path);
            remove_server_owner_files(&data_dir);
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
                let _ = child.kill();
                let _ = std::fs::remove_file(&spawn_lock_path);
                remove_server_owner_files(&data_dir);
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
                let _ = child.kill();
                let _ = std::fs::remove_file(&spawn_lock_path);
                remove_server_owner_files(&data_dir);
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
                let _ = child.kill();
                let _ = std::fs::remove_file(&spawn_lock_path);
                remove_server_owner_files(&data_dir);
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
            if let Some(diagnostic_log_path) = &main_startup_diagnostic_path {
                append_timestamped_line(
                    diagnostic_log_path,
                    &format!("owner published pid={} path={:?}", java_pid, owner_path),
                );
            }

            let _ = std::fs::remove_file(&spawn_lock_path);
            *app.state::<ServerState>().0.lock().unwrap() = Some(RunningServer {
                child,
                owner_path,
                spawn_lock_path,
            });
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
            let _ = std::fs::remove_file(&spawn_lock_path);
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

#[cfg(test)]
fn reset_local_profile_root(profile_id: &str) -> Result<PathBuf, String> {
    let profile_key = local_server_profile_key_from_id(Some(profile_id))
        .ok_or_else(|| "Invalid profile id.".to_string())?;
    Ok(local_server_root_for_profile_key(&profile_key))
}

#[tauri::command]
fn reset_local_profile_data(profile_id: String, app: tauri::AppHandle) -> Result<bool, String> {
    let _lease = suwayomi_maintenance::try_acquire_shared_file_lease(
        &suwayomi_maintenance::default_runtime_root(),
    )?;
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
    kill_tachidesk_target(app, target);
    if !root_dir.exists() {
        return Ok(false);
    }
    if !root_dir.is_dir() {
        return Err("Profile data path is not a directory.".to_string());
    }

    std::fs::remove_dir_all(&root_dir).map_err(|err| err.to_string())?;
    Ok(true)
}

#[tauri::command]
fn kill_server(server_url: Option<String>, app: tauri::AppHandle) -> Result<(), String> {
    let _lease = suwayomi_maintenance::try_acquire_shared_file_lease(
        &suwayomi_maintenance::default_runtime_root(),
    )?;
    kill_tachidesk(&app, server_url.as_deref());
    Ok(())
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
        update
            .download_and_install(
                move |downloaded, total| {
                    let _ = app_clone.emit(
                        "update-progress",
                        UpdateProgress {
                            downloaded: downloaded as u64,
                            total,
                        },
                    );
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;

        Ok(())
    }
}

/// Restart the app after a successful update install.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    tauri::process::restart(&app.env());
}

#[tauri::command]
fn relaunch_with_args(app: tauri::AppHandle, args: Vec<String>) -> Result<(), String> {
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
            server_url_override = Some("http://127.0.0.1:4567".to_string());
            profile_label_override = Some("MAIN".to_string());
        }
        Some(profile) if profile == "TEST" => {
            server_url_override = Some("http://127.0.0.1:4667".to_string());
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
                server_url_override = Some("http://127.0.0.1:4567".to_string());
                profile_label_override = Some("MAIN".to_string());
            }
            "--test" => {
                server_url_override = Some("http://127.0.0.1:4667".to_string());
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

fn apply_automation_launch_overrides() {
    let overrides = parse_automation_launch_overrides();

    if let Some(path) = overrides.local_app_data_dir {
        let roaming_path = automation_roaming_app_data_path(&path);
        std::env::set_var("LOCALAPPDATA", &path);
        std::env::set_var("APPDATA", &roaming_path);
        std::env::set_var(
            "EPIGRAPH_LOCAL_SERVER_MAIN_ROOT",
            automation_local_server_root(&path, LocalServerProfile::Main),
        );
        std::env::set_var(
            "EPIGRAPH_LOCAL_SERVER_TEST_ROOT",
            automation_local_server_root(&path, LocalServerProfile::Test),
        );
    }

    if let Some(port) = overrides.syncd_port {
        std::env::set_var("EPIGRAPH_SYNCD_PORT", port.to_string());
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
    suwayomi_maintenance::begin_operation(&suwayomi_maintenance::default_runtime_root(), &scope)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    compat::promote_legacy_environment();
    apply_automation_launch_overrides();
    ensure_process_rustls_crypto_provider();
    ensure_dev_webview2_debug_port();
    let app = tauri::Builder::default()
        .register_uri_scheme_protocol("book", |_ctx, request| serve_book_asset(request))
        .register_uri_scheme_protocol("cover", |_ctx, request| serve_library_cover_asset(request))
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
        .invoke_handler(tauri::generate_handler![
            get_launch_target,
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
            syncd_desktop::syncd_host_decide_pairing,
            syncd_desktop::syncd_list_paired_devices,
            syncd_desktop::syncd_update_paired_device_granted_scopes,
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
            read_downloaded_chapter_archive,
            check_path_exists,
            create_directory,
            download_server_file_to_downloads,
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
            open_reader_webview,
            open_tracker_oauth_window,
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
        ])
        .setup(|app| {
            // Do not hold the first paint hostage to a potentially large legacy
            // data tree. The merge is idempotent and conflict-safe; running it
            // in the Tauri blocking pool lets the Epigraph window become usable
            // while legacy data is copied in the background.
            tauri::async_runtime::spawn_blocking(compat::migrate_legacy_storage);
            configure_webdriver_window(app.handle());
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
            Ok(())
        })
        .on_window_event(|_window, _event| {})
        .build(tauri::generate_context!())
        .expect("error while building epigraph");

    app.run(|app_handle, event| {
        syncd_sidecar::handle_run_event(app_handle, &event);
        if matches!(event, tauri::RunEvent::Exit) {
            kill_tachidesk(app_handle, None);
            clear_suwayomi_lan_state();
        }
    });
}
