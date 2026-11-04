use serde::Serialize;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
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
use crate::syncd::lifecycle::ShutdownOutcome;
use crate::syncd::models::SyncdDiscoveryDescriptor;
use crate::syncd::network::detect_lan_ip;
use crate::syncd::runtime_manifest::{
    read_runtime_manifest, runtime_manifest_path, SyncdRuntimeManifest,
};

const DEFAULT_SYNCD_PORT: u16 = 4777;
const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(20);
/// The sidecar log keeps at most this much, plus one older file of about the same size.
const MAX_SIDECAR_LOG_BYTES: u64 = 8 * 1024 * 1024;

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
    pub manifest: Option<SyncdRuntimeManifest>,
    pub birth: Option<crate::suwayomi_runtime::RuntimeProcessIdentity>,
    pub child: Option<CommandChild>,
    pub ownership: SyncdOwnershipMode,
    pub pid: u32,
    pub server_id: Option<String>,
    pub local_base_url: String,
    pub advertised_base_url: String,
    pub bind_host: String,
    pub port: u16,
    pub host_mode: bool,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub cert_path: PathBuf,
    pub log_path: PathBuf,
    /// Set when this desktop launched the Core and must end it on Quit. `None` for a Core this
    /// desktop only attached to, such as the one started at sign-in for paired devices.
    pub desktop_owned: Option<DesktopOwnedCore>,
}

/// A Core this desktop launched and owns: phase-gate Cores, and a persistent Core started while
/// no sign-in autostart is registered for its executable, so nothing else would keep it running
/// for paired devices.
pub struct DesktopOwnedCore {
    /// Kill-on-close containment, used when the graceful shutdown cannot finish. `None` when the
    /// job could not be created; the graceful shutdown is then the only way to end the Core.
    job: Option<OwnedCoreJob>,
}

/// Whether the desktop owns a Core it just launched. A persistent Core registered to start at
/// sign-in is a background service for paired devices, so the desktop only attaches to it.
fn desktop_owns_launched_core(
    ownership: SyncdOwnershipMode,
    autostart_registered: Result<bool, String>,
) -> bool {
    match ownership {
        SyncdOwnershipMode::EphemeralOwned => true,
        // When the registration cannot be read, keep the documented daemon behaviour.
        SyncdOwnershipMode::PersistentAttached => autostart_registered == Ok(false),
    }
}

/// A Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` holding a desktop-owned Core. The
/// Suwayomi Java the Core starts inherits the job, so the whole tree ends when the job is
/// terminated, and the OS ends it when the desktop exits without a clean shutdown (a crash or
/// Task Manager). Dropping this value never terminates anything; only `terminate` does.
pub struct OwnedCoreJob {
    #[cfg(windows)]
    handle: usize,
}

#[cfg(windows)]
impl OwnedCoreJob {
    /// Contain a child this desktop spawned. The caller keeps the spawn handle (`CommandChild`)
    /// alive, so the PID cannot be reused while the birth identity is compared.
    fn contain(
        pid: u32,
        birth: Option<&crate::suwayomi_runtime::RuntimeProcessIdentity>,
    ) -> Result<Self, String> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        let birth = birth.ok_or("Core birth identity missing; containment skipped")?;
        if birth.pid != pid
            || crate::suwayomi_runtime::capture_process_identity(pid).as_ref() != Some(birth)
        {
            return Err("Core process identity changed before containment".into());
        }
        unsafe {
            let process = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            );
            if process.is_null() {
                return Err("Could not open the Core process for containment".into());
            }
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                CloseHandle(process);
                return Err("Could not create the Core Job Object".into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0;
            let assigned = configured && AssignProcessToJobObject(job, process) != 0;
            CloseHandle(process);
            if !assigned {
                CloseHandle(job);
                return Err("Could not contain the Core process tree".into());
            }
            Ok(Self {
                handle: job as usize,
            })
        }
    }

    fn active_processes(&self) -> Result<u32, String> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let queried = unsafe {
            QueryInformationJobObject(
                self.handle as windows_sys::Win32::Foundation::HANDLE,
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of_val(&accounting) as u32,
                std::ptr::null_mut(),
            )
        };
        if queried == 0 {
            return Err("Cannot read the Core Job Object".into());
        }
        Ok(accounting.ActiveProcesses)
    }

    /// Let the Core outlive this desktop: clear kill-on-close and close the handle, so neither
    /// the desktop exiting nor this call ends the tree.
    fn release(self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        };
        let handle = self.handle as windows_sys::Win32::Foundation::HANDLE;
        unsafe {
            let limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            CloseHandle(handle);
        }
    }

    /// End every process still in the job and wait until none remains. Safe to repeat: an empty
    /// job terminates at once.
    fn terminate(self, timeout: Duration) -> Result<(), (Self, String)> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        let handle = self.handle as windows_sys::Win32::Foundation::HANDLE;
        let active = match self.active_processes() {
            Ok(active) => active,
            Err(error) => return Err((self, error)),
        };
        if active > 0 && unsafe { TerminateJobObject(handle, 1) } == 0 {
            return Err((self, "Core tree termination failed; job retained".into()));
        }
        let deadline = std::time::Instant::now() + timeout;
        loop {
            match self.active_processes() {
                Ok(0) => {
                    unsafe { CloseHandle(handle) };
                    return Ok(());
                }
                Ok(_) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                Ok(remaining) => {
                    return Err((
                        self,
                        format!("{remaining} Core process(es) still running; job retained"),
                    ))
                }
                Err(error) => return Err((self, error)),
            }
        }
    }
}

#[cfg(not(windows))]
impl OwnedCoreJob {
    fn contain(
        _pid: u32,
        _birth: Option<&crate::suwayomi_runtime::RuntimeProcessIdentity>,
    ) -> Result<Self, String> {
        Err("Core containment is available only on Windows".into())
    }

    fn terminate(self, _timeout: Duration) -> Result<(), (Self, String)> {
        Err((self, "Core containment is available only on Windows".into()))
    }

    fn release(self) {}
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
    pub server_id: Option<String>,
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
                // The phase-gate process owns an ephemeral Core. Shut that
                // child down before asking Tauri to exit instead of relying
                // solely on RunEvent::Exit, which can race the WebView
                // teardown on Windows and leave epigraph-syncd alive.
                crate::request_owned_desktop_shutdown(&app);
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
        advertised_base_url: std::env::var("EPIGRAPH_SYNCD_ADVERTISED_BASE_URL")
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

    match detect_lan_ip() {
        Ok(lan_ip) => {
            ensure_for_desktop(
                app,
                SyncdLaunchMode::LanHost {
                    advertised_base_url: format!("https://{}:{}", lan_ip, phase_gate_port()),
                },
            )
            .await
        }
        Err(_) => ensure_for_desktop(app, SyncdLaunchMode::Loopback).await,
    }
}

/// Asks the persistent Core to stop or start the main profile's Suwayomi while this process holds the
/// Suwayomi runtime for maintenance: only the Core holds the handle of the Java it spawned.
pub(crate) fn request_main_suwayomi_maintenance(
    action: crate::syncd::lifecycle::SuwayomiMaintenanceAction,
) -> Result<Option<u32>, String> {
    let timeout = match action {
        crate::syncd::lifecycle::SuwayomiMaintenanceAction::Stop => Duration::from_secs(30),
        // The Core answers once the server does, which can take minutes on a large library.
        crate::syncd::lifecycle::SuwayomiMaintenanceAction::Start => Duration::from_secs(420),
    };
    block_on_core(crate::syncd::lifecycle::request_suwayomi_maintenance(
        &desktop_syncd_data_dir(),
        action,
        timeout,
    ))
    .map_err(|error| format!("{error:#}"))
}

/// Waits for a Core request from the synchronous update steps, which async commands also reach.
pub(crate) fn block_on_core<F: std::future::Future>(future: F) -> F::Output {
    if tokio::runtime::Handle::try_current().is_ok() {
        tokio::task::block_in_place(|| tauri::async_runtime::block_on(future))
    } else {
        tauri::async_runtime::block_on(future)
    }
}

/// Reattach the desktop UI to an already-initialized local Core without making
/// first-run users start the service before they choose to pair a device.
pub fn attach_existing_host_in_background(app: &AppHandle) {
    // Phase gates own an ephemeral Core with an isolated data directory. Do
    // not reattach the user's persistent Core while a gate is running: doing
    // so races the gate's migrations and can terminate the ephemeral child.
    if phase_gate_autostart_enabled() {
        return;
    }

    let data_dir = desktop_syncd_data_dir();
    if !has_persisted_core_identity(&data_dir) {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match ensure_host_mode(&app).await {
            Ok(_) => {
                // `setup()` also starts the replication bootstrap, but the Core
                // reattachment deliberately happens in the background.  On a
                // normal desktop restart the first bootstrap can therefore run
                // before `SyncdState` contains the persistent runtime and skip
                // creation of the local-authority session entirely.  Repeat the
                // idempotent bootstrap after the runtime is attached so books,
                // novel dependencies, and reader state are published without
                // requiring the user to reopen the pairing screen.
                let replication_state = app
                    .state::<crate::syncd_replication::SyncdReplicationState>()
                    .inner()
                    .clone();
                if let Err(error) =
                    crate::syncd_replication::bootstrap_runtime(app.clone(), replication_state)
                        .await
                {
                    tracing::warn!(
                        %error,
                        "failed to bootstrap replication after reattaching Epigraph Core"
                    );
                }
            }
            Err(error) => {
                tracing::warn!(%error, "failed to reattach the persisted Epigraph Core host");
            }
        }
    });
}

fn has_persisted_core_identity(data_dir: &Path) -> bool {
    data_dir.join("syncd.sqlite").is_file()
        && data_dir.join("cert.pem").is_file()
        && data_dir.join("key.pem").is_file()
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
    if let Err(error) = shutdown_confirmed(app) { eprintln!("[Core cleanup] {error}"); }
}

pub fn shutdown_confirmed(app: &AppHandle) -> Result<(), String> {
    let running = {
        let state = app.state::<SyncdState>();
        let mut guard = state.runtime.lock().unwrap();
        guard.take()
    };

    if let Some(mut running) = running {
        if running.desktop_owned.is_some() {
            if let Err(error) = stop_desktop_owned_core(&mut running) {
                let _ = append_line(&running.log_path, &format!("cleanup unconfirmed: {error}"));
                *app.state::<SyncdState>().runtime.lock().unwrap() = Some(running);
                return Err(error);
            }
        } else {
            stop_attached_core_unless_devices_connected(&running);
        }
    }

    if let Some(status_path) = phase_gate_status_path() {
        let _ = fs::remove_file(status_path);
    }
    Ok(())
}

/// Quit stops a Core this desktop only attached to, such as the one started at sign-in, unless a
/// paired device is connected: then the Core keeps serving it and stops on its own once devices
/// have left. Quit never fails because of it; an attached Core is not this desktop's to kill.
fn stop_attached_core_unless_devices_connected(running: &RunningSyncd) {
    let outcome = match running.manifest.as_ref() {
        Some(manifest) => tauri::async_runtime::block_on(
            crate::syncd::lifecycle::request_exact_shutdown(
                &running.data_dir,
                crate::syncd::lifecycle::ShutdownReason::ParentExited,
                OWNED_CORE_GRACEFUL_SHUTDOWN,
                manifest,
                true,
            ),
        )
        .map_err(|error| error.to_string()),
        None => Err("no Core run identity to address".to_string()),
    };
    let line = match outcome {
        Ok(ShutdownOutcome::KeptForDevices) => {
            "desktop detached; the Core keeps serving connected devices and stops once they leave"
                .to_string()
        }
        Ok(ShutdownOutcome::Stopped | ShutdownOutcome::NotRunning) => {
            "desktop closed the Core; no device was connected".to_string()
        }
        Err(error) => format!("desktop detached without stopping the Core: {error}"),
    };
    let _ = append_line(&running.log_path, &format!("[{}] {line}", running.pid));
}

/// How long Quit waits for an owned persistent Core to stop its Suwayomi and exit before the
/// job ends the tree. Phase gates keep their longer budget.
const OWNED_CORE_GRACEFUL_SHUTDOWN: Duration = Duration::from_secs(8);
const EPHEMERAL_CORE_GRACEFUL_SHUTDOWN: Duration = Duration::from_secs(15);
const OWNED_CORE_TERMINATION_WAIT: Duration = Duration::from_secs(5);

/// Stop a Core this desktop launched: the authenticated shutdown first, so the Core stops its
/// Suwayomi and closes its database, then the Job Object for anything still running. Repeating
/// it after a success is a no-op because the runtime is taken out of `SyncdState`.
fn stop_desktop_owned_core(running: &mut RunningSyncd) -> Result<(), String> {
    let started = std::time::Instant::now();
    let timeout = match running.ownership {
        SyncdOwnershipMode::EphemeralOwned => EPHEMERAL_CORE_GRACEFUL_SHUTDOWN,
        SyncdOwnershipMode::PersistentAttached => OWNED_CORE_GRACEFUL_SHUTDOWN,
    };
    let _ = append_line(
        &running.log_path,
        &format!("[{}] owned Core shutdown requested by app", running.pid),
    );
    let graceful = (|| {
        let child = running
            .child
            .as_ref()
            .ok_or("Missing retained Core spawn")?;
        let manifest = running
            .manifest
            .as_ref()
            .ok_or("Missing original Core run identity")?;
        if manifest.pid != child.pid()
            || manifest.process_identity != running.birth
            || running.birth.is_none()
        {
            return Err("Core control manifest differs from retained birth identity".to_string());
        }
        tauri::async_runtime::block_on(
            crate::syncd::lifecycle::request_exact_shutdown(
                &running.data_dir,
                crate::syncd::lifecycle::ShutdownReason::ParentExited,
                timeout,
                manifest,
                // A phase gate always ends with its desktop.
                running.ownership == SyncdOwnershipMode::PersistentAttached,
            ),
        )
        .map_err(|error| error.to_string())
    })();
    if let Err(error) = &graceful {
        let _ = append_line(
            &running.log_path,
            &format!("graceful Core shutdown failed: {error}; ending the owned process tree"),
        );
    }

    let owned = running
        .desktop_owned
        .as_mut()
        .expect("caller checked ownership");
    if matches!(graceful, Ok(ShutdownOutcome::KeptForDevices)) {
        if let Some(job) = owned.job.take() {
            job.release();
        }
        let _ = append_line(
            &running.log_path,
            &format!(
                "[{}] owned Core keeps serving connected devices and stops once they leave",
                running.pid
            ),
        );
        return Ok(());
    }
    let graceful = graceful.map(|_| ());
    // The job also ends a Suwayomi the Core could not stop. It is empty after a clean shutdown.
    let swept = match owned.job.take() {
        Some(job) => match job.terminate(OWNED_CORE_TERMINATION_WAIT) {
            Ok(()) => Ok(()),
            Err((job, error)) => {
                owned.job = Some(job);
                Err(error)
            }
        },
        None => graceful.clone(),
    };
    let _ = append_line(
        &running.log_path,
        &format!(
            "owned Core shutdown finished in {} ms (graceful: {}, tree: {})",
            started.elapsed().as_millis(),
            if graceful.is_ok() { "ok" } else { "failed" },
            if swept.is_ok() {
                "ended"
            } else {
                "unconfirmed"
            },
        ),
    );
    swept
}

pub(crate) fn current_runtime_info(app: &AppHandle) -> Option<SyncdRuntimeInfo> {
    let state = app.state::<SyncdState>();
    let guard = state.runtime.lock().unwrap();
    guard.as_ref().map(runtime_info_from_running)
}

/// The server id of this computer's Core. A Core this app spawned only records it in the runtime
/// manifest it validated at startup.
pub(crate) fn current_server_id(app: &AppHandle) -> Option<String> {
    let state = app.state::<SyncdState>();
    let guard = state.runtime.lock().unwrap();
    let running = guard.as_ref()?;
    running.server_id.clone()
        .or_else(|| running.manifest.as_ref().map(|manifest| manifest.server_id.clone()))
}

async fn ensure_spawned(
    app: &AppHandle,
    request: SpawnRequest,
) -> Result<SyncdRuntimeInfo, String> {
    let _launch = crate::session_control::begin_launch()?;
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
                    match validate_existing_persistent_runtime(&request).await? {
                        Some(validated)
                            if runtime_matches_validated_identity(&current, &validated) =>
                        {
                            true
                        }
                        Some(validated) => {
                            let running = running_from_validated(&request, validated, None, None);
                            let info = runtime_info_from_running(&running);
                            *state.runtime.lock().unwrap() = Some(running);
                            return Ok(info);
                        }
                        None => false,
                    }
                }
            };
            if healthy {
                return Ok(current);
            }

            let stale = state.runtime.lock().unwrap().take();
            if let Some(stale) = stale {
                if stale.ownership == SyncdOwnershipMode::EphemeralOwned {
                    if let Err(error) = terminate_ephemeral_syncd(stale.child.as_ref()) {
                        *state.runtime.lock().unwrap() = Some(stale);
                        return Err(error);
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
                if let Err(error) = terminate_ephemeral_syncd(existing.child.as_ref()) {
                    *state.runtime.lock().unwrap() = Some(existing);
                    return Err(error);
                }
            }
        }
    }

    if request.ownership == SyncdOwnershipMode::PersistentAttached {
        if let Some(validated) = validate_existing_persistent_runtime(&request).await? {
            let running = running_from_validated(&request, validated, None, None);
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
        .sidecar("epigraph-syncd")
        .or_else(|canonical_error| {
            app.shell().sidecar("aethon-syncd").map_err(|legacy_error| {
                format!(
                    "failed to create Epigraph syncd sidecar ({canonical_error}); legacy sidecar also unavailable ({legacy_error})"
                )
            })
        })?
        .env("EPIGRAPH_SYNCD_DATA_DIR", &request.data_dir)
        .env("AETHON_SYNCD_DATA_DIR", &request.data_dir)
        .env("EPIGRAPH_SYNCD_BIND_HOST", &request.bind_host)
        .env("AETHON_SYNCD_BIND_HOST", &request.bind_host)
        .env("EPIGRAPH_SYNCD_PORT", request.port.to_string())
        .env("AETHON_SYNCD_PORT", request.port.to_string())
        .env("EPIGRAPH_SYNCD_OWNERSHIP", request.ownership.as_env_value())
        .env("AETHON_SYNCD_OWNERSHIP", request.ownership.as_env_value())
        .env(
            "EPIGRAPH_SYNCD_ENABLE_AUDIT_ROUTES",
            if request.enable_audit_routes {
                "1"
            } else {
                "0"
            },
        )
        .env(
            "AETHON_SYNCD_ENABLE_AUDIT_ROUTES",
            if request.enable_audit_routes { "1" } else { "0" },
        )
        .env("EPIGRAPH_SYNCD_ADVERTISED_BASE_URL", &advertised_base_url)
        .env("AETHON_SYNCD_ADVERTISED_BASE_URL", &advertised_base_url)
        .env("EPIGRAPH_SYNCD_DISCOVERY_PROVIDER", "lan-publication")
        .env("AETHON_SYNCD_DISCOVERY_PROVIDER", "lan-publication")
        .env("EPIGRAPH_SYNCD_MANUAL_PROVIDER", "disabled")
        .env("AETHON_SYNCD_MANUAL_PROVIDER", "disabled")
        .env("EPIGRAPH_SYNCD_EFFECTIVE_DISCOVERY_POLICY", "advertised-only")
        .env("AETHON_SYNCD_EFFECTIVE_DISCOVERY_POLICY", "advertised-only");
    let command = if request.ownership == SyncdOwnershipMode::EphemeralOwned {
        command
            .env("EPIGRAPH_SYNCD_PARENT_PID", std::process::id().to_string())
            .env("AETHON_SYNCD_PARENT_PID", std::process::id().to_string())
    } else {
        command
    };
    let (rx, child) = command
        .spawn()
        .map_err(|err| format!("failed to spawn syncd sidecar: {err}"))?;

    let pid = child.pid();
    let birth = crate::suwayomi_runtime::capture_process_identity(pid);
    let desktop_owned = claim_launched_core(request.ownership, &child, birth.as_ref(), &log_path);
    spawn_log_drain(rx, log_path.clone(), pid);

    let running = match request.ownership {
        SyncdOwnershipMode::EphemeralOwned => {
            if let Err(err) = wait_for_ready(&local_base_url).await {
                if let Err(cleanup_error) = terminate_ephemeral_syncd(Some(&child)) {
                    let _ = append_line(&log_path, &format!("readiness failed: {err}; cleanup unconfirmed: {cleanup_error}"));
                    *state.runtime.lock().unwrap() = Some(RunningSyncd {
                        manifest: None, birth,
                        child: Some(child), ownership: request.ownership, pid, server_id: None,
                        local_base_url, advertised_base_url, host_mode: request.bind_host != "127.0.0.1",
                        bind_host: request.bind_host, port: request.port, data_dir: request.data_dir,
                        db_path, cert_path, log_path, desktop_owned,
                    });
                    return Err(cleanup_error);
                }
                return Err(format!("syncd sidecar failed readiness probe: {err}"));
            }
            let host_mode = request.bind_host != "127.0.0.1";
            let manifest = read_runtime_manifest(&request.data_dir).ok()
                .filter(|manifest| birth.is_some() && manifest.process_identity == birth);
            let running = RunningSyncd {
                manifest, birth,
                child: Some(child),
                ownership: request.ownership,
                pid,
                server_id: None,
                local_base_url,
                advertised_base_url,
                bind_host: request.bind_host,
                port: request.port,
                host_mode,
                data_dir: request.data_dir,
                db_path,
                cert_path,
                log_path,
                desktop_owned,
            };
            if running.manifest.is_none() {
                *state.runtime.lock().unwrap() = Some(running);
                return Err("Core readiness did not agree with captured birth; process and evidence retained".into());
            }
            running
        }
        SyncdOwnershipMode::PersistentAttached => {
            let validated = match wait_for_persistent_runtime(&request, pid, birth.as_ref()).await {
                Ok(validated) => validated,
                Err(error) => {
                    *state.runtime.lock().unwrap() = Some(RunningSyncd {
                        manifest: None, birth, child: Some(child), ownership: request.ownership,
                        pid, server_id: None, local_base_url, advertised_base_url,
                        host_mode: request.bind_host != "127.0.0.1", bind_host: request.bind_host,
                        port: request.port, data_dir: request.data_dir, db_path, cert_path, log_path,
                        desktop_owned,
                    });
                    return Err(format!("persistent Core identity readiness failed; evidence retained: {error}"));
                }
            };
            running_from_validated(&request, validated, Some(child), desktop_owned)
        }
    };
    let info = runtime_info_from_running(&running);
    *state.runtime.lock().unwrap() = Some(running);
    Ok(info)
}

/// Decide whether this desktop owns the Core it just launched and, when it does, contain the Core
/// so it and the Suwayomi it starts cannot outlive the desktop.
fn claim_launched_core(
    ownership: SyncdOwnershipMode,
    child: &CommandChild,
    birth: Option<&crate::suwayomi_runtime::RuntimeProcessIdentity>,
    log_path: &Path,
) -> Option<DesktopOwnedCore> {
    let autostart_registered = birth
        .and_then(|birth| birth.executable_path.as_deref())
        .ok_or_else(|| "Core executable unknown".to_string())
        .and_then(|executable| {
            crate::syncd::autostart::is_registered(Path::new(executable))
                .map_err(|error| error.to_string())
        });
    if !desktop_owns_launched_core(ownership, autostart_registered.clone()) {
        let _ = append_line(
            log_path,
            &format!(
                "[{}] Core registered to start at sign-in ({autostart_registered:?}); it keeps running for paired devices after Quit",
                child.pid()
            ),
        );
        return None;
    }
    let job = match OwnedCoreJob::contain(child.pid(), birth) {
        Ok(job) => Some(job),
        Err(error) => {
            let _ = append_line(
                log_path,
                &format!("[{}] Core containment unavailable: {error}", child.pid()),
            );
            None
        }
    };
    Some(DesktopOwnedCore { job })
}

/// Only a retained spawn object grants authority; a remembered PID never does.
fn terminate_ephemeral_syncd(child: Option<&CommandChild>) -> Result<(), String> {
    let child = child.ok_or("Missing spawn handle; process preserved")?;
    crate::suwayomi_runtime::stop_spawned_child(child)
}

fn runtime_info_from_running(running: &RunningSyncd) -> SyncdRuntimeInfo {
    SyncdRuntimeInfo {
        pid: running.pid,
        server_id: running.server_id.clone(),
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
        || !paths_identical(Path::new(&runtime.data_dir), &request.data_dir)
    {
        return false;
    }
    if request.ownership == SyncdOwnershipMode::PersistentAttached {
        // A persistent Core may have selected a different free port during an earlier launch.
        // Its live manifest plus process/server/certificate identity is authoritative; forcing
        // the default launch port here prevents the desktop from reattaching after a restart.
        return true;
    }
    if runtime.port != request.port {
        return false;
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
    desktop_owned: Option<DesktopOwnedCore>,
) -> RunningSyncd {
    let local_base_url = format!("https://127.0.0.1:{}", validated.manifest.port);
    RunningSyncd {
        birth: validated.manifest.process_identity.clone(), manifest: Some(validated.manifest.clone()),
        child,
        ownership: SyncdOwnershipMode::PersistentAttached,
        pid: validated.manifest.pid,
        server_id: Some(validated.manifest.server_id.clone()),
        local_base_url,
        advertised_base_url: validated.descriptor.advertised_origin.base_url,
        bind_host: request.bind_host.clone(),
        port: validated.manifest.port,
        host_mode: request.bind_host != "127.0.0.1",
        data_dir: request.data_dir.clone(),
        db_path: request.data_dir.join("syncd.sqlite"),
        cert_path: request.data_dir.join("cert.pem"),
        log_path: request.data_dir.join("syncd-sidecar.log"),
        desktop_owned,
    }
}

fn runtime_matches_validated_identity(
    runtime: &SyncdRuntimeInfo,
    validated: &ValidatedPersistentRuntime,
) -> bool {
    runtime.pid == validated.manifest.pid
        && runtime.server_id.as_deref() == Some(validated.manifest.server_id.as_str())
}

async fn validate_existing_persistent_runtime(
    request: &SpawnRequest,
) -> Result<Option<ValidatedPersistentRuntime>, String> {
    if !runtime_manifest_path(&request.data_dir).exists() {
        return Ok(None);
    }
    if crate::syncd::runtime_manifest::reconcile_exited_runtime_manifest(&runtime_manifest_path(
        &request.data_dir,
    )) {
        return Ok(None);
    }
    let manifest = match read_runtime_manifest(&request.data_dir) {
        Ok(manifest) => manifest,
        Err(error) => return Err(error),
    };

    if !runtime_process_matches(&manifest)? {
        return Err("Stale or unverifiable persistent Core identity; manifest and process preserved".into());
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
    birth: Option<&crate::suwayomi_runtime::RuntimeProcessIdentity>,
) -> Result<ValidatedPersistentRuntime, String> {
    let birth = birth.ok_or("Missing captured Core birth identity")?;
    let started = std::time::Instant::now();
    let mut last_error = "runtime manifest has not been published".to_string();
    loop {
        if started.elapsed() > DEFAULT_READY_TIMEOUT {
            return Err(last_error);
        }

        match read_runtime_manifest(&request.data_dir) {
            Ok(manifest) if manifest.pid == expected_pid => {
                if manifest.process_identity.as_ref() != Some(birth) {
                    return Err("Core manifest does not match retained spawn identity".into());
                }
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
pub(crate) fn paths_identical(left: &Path, right: &Path) -> bool {
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
pub(crate) fn paths_identical(left: &Path, right: &Path) -> bool {
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
    rotate_log_when_full(path, MAX_SIDECAR_LOG_BYTES);
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{line}")?;
    Ok(())
}

/// Moves a full log aside, replacing the older one, so the two together stay bounded. A log that
/// cannot be moved keeps growing for now: losing a line would be worse, and the next one tries again.
fn rotate_log_when_full(path: &Path, max_bytes: u64) {
    let full = fs::metadata(path).is_ok_and(|metadata| metadata.len() >= max_bytes);
    if full {
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
}

fn phase_gate_autostart_enabled() -> bool {
    std::env::var("EPIGRAPH_SYNCD_PHASE_GATE_AUTOSTART").as_deref() == Ok("1")
}

fn audit_routes_flag() -> bool {
    std::env::var("EPIGRAPH_SYNCD_ENABLE_AUDIT_ROUTES").as_deref() == Ok("1")
}

fn phase_gate_status_path() -> Option<PathBuf> {
    std::env::var_os("EPIGRAPH_SYNCD_PHASE_GATE_STATUS_PATH").map(PathBuf::from)
}

fn phase_gate_exit_sentinel() -> Option<PathBuf> {
    std::env::var_os("EPIGRAPH_SYNCD_PHASE_GATE_EXIT_SENTINEL").map(PathBuf::from)
}

fn phase_gate_data_dir() -> PathBuf {
    std::env::var_os("EPIGRAPH_SYNCD_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("epigraph").join("syncd-phase-gate"))
}

fn desktop_syncd_data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("Epigraph")
        .join("syncd")
}

fn phase_gate_bind_host() -> String {
    std::env::var("EPIGRAPH_SYNCD_BIND_HOST").unwrap_or_else(|_| "127.0.0.1".to_string())
}

fn phase_gate_port() -> u16 {
    std::env::var("EPIGRAPH_SYNCD_PORT")
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

    #[test]
    fn a_full_log_moves_aside_and_replaces_the_older_one() {
        let dir = std::env::temp_dir().join(format!("epigraph-sidecar-log-{}", unix_now_millis()));
        fs::create_dir_all(&dir).unwrap();
        let log = dir.join("syncd-sidecar.log");
        let older = dir.join("syncd-sidecar.log.1");

        // Nothing to move yet, and a log below the limit stays where it is.
        rotate_log_when_full(&log, 8);
        fs::write(&log, "small").unwrap();
        rotate_log_when_full(&log, 8);
        assert_eq!(fs::read_to_string(&log).unwrap(), "small");
        assert!(!older.exists());

        fs::write(&older, "oldest").unwrap();
        fs::write(&log, "full log").unwrap();
        rotate_log_when_full(&log, 8);
        assert!(!log.exists());
        assert_eq!(fs::read_to_string(&older).unwrap(), "full log");

        // The next line starts a new log.
        append_line(&log, "next").unwrap();
        assert_eq!(fs::read_to_string(&log).unwrap().trim_end(), "next");
        assert_eq!(fs::read_to_string(&older).unwrap(), "full log");

        fs::remove_dir_all(&dir).unwrap();
    }

    fn request(ownership: SyncdOwnershipMode) -> SpawnRequest {
        SpawnRequest {
            data_dir: PathBuf::from(r"C:\temp\epigraph-syncd"),
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
            server_id: Some("server-a".to_string()),
            local_base_url: "https://127.0.0.1:4777".to_string(),
            advertised_base_url: "https://192.168.1.20:4777".to_string(),
            bind_host: "0.0.0.0".to_string(),
            port: 4777,
            host_mode: true,
            ownership: SyncdOwnershipMode::PersistentAttached,
            data_dir: r"C:\temp\epigraph-syncd".to_string(),
            db_path: r"C:\temp\epigraph-syncd\syncd.sqlite".to_string(),
            cert_path: r"C:\temp\epigraph-syncd\cert.pem".to_string(),
            log_path: r"C:\temp\epigraph-syncd\syncd-sidecar.log".to_string(),
        };

        assert!(runtime_matches_request(
            &runtime,
            &request(SyncdOwnershipMode::PersistentAttached)
        ));
        assert!(!runtime_matches_request(
            &runtime,
            &request(SyncdOwnershipMode::EphemeralOwned)
        ));

        let mut restarted_request = request(SyncdOwnershipMode::PersistentAttached);
        restarted_request.port = 4779;
        assert!(runtime_matches_request(&runtime, &restarted_request));

        let mut ephemeral_on_another_port = request(SyncdOwnershipMode::EphemeralOwned);
        ephemeral_on_another_port.port = 4779;
        let mut ephemeral_runtime = runtime;
        ephemeral_runtime.ownership = SyncdOwnershipMode::EphemeralOwned;
        assert!(!runtime_matches_request(
            &ephemeral_runtime,
            &ephemeral_on_another_port
        ));
    }

    #[test]
    fn attached_runtime_identity_changes_with_pid_or_server_id() {
        let fingerprint = "a".repeat(64);
        let runtime = SyncdRuntimeInfo {
            pid: 42,
            server_id: Some("server-a".to_string()),
            local_base_url: "https://127.0.0.1:4777".to_string(),
            advertised_base_url: "https://192.168.1.20:4777".to_string(),
            bind_host: "0.0.0.0".to_string(),
            port: 4777,
            host_mode: true,
            ownership: SyncdOwnershipMode::PersistentAttached,
            data_dir: r"C:\temp\epigraph-syncd".to_string(),
            db_path: r"C:\temp\epigraph-syncd\syncd.sqlite".to_string(),
            cert_path: r"C:\temp\epigraph-syncd\cert.pem".to_string(),
            log_path: r"C:\temp\epigraph-syncd\syncd-sidecar.log".to_string(),
        };
        let validated = |pid, server_id: &str| ValidatedPersistentRuntime {
            manifest: SyncdRuntimeManifest::new(
                pid,
                server_id,
                4777,
                &fingerprint,
                std::env::current_exe()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            ),
            descriptor: descriptor(server_id, &fingerprint),
        };

        assert!(runtime_matches_validated_identity(
            &runtime,
            &validated(42, "server-a")
        ));
        assert!(!runtime_matches_validated_identity(
            &runtime,
            &validated(43, "server-a")
        ));
        assert!(!runtime_matches_validated_identity(
            &runtime,
            &validated(42, "server-b")
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

    #[test]
    fn desktop_owns_only_cores_nothing_else_keeps_running() {
        use SyncdOwnershipMode::{EphemeralOwned, PersistentAttached};
        assert!(desktop_owns_launched_core(EphemeralOwned, Ok(false)));
        assert!(desktop_owns_launched_core(EphemeralOwned, Ok(true)));
        assert!(desktop_owns_launched_core(EphemeralOwned, Err("unreadable".into())));
        assert!(desktop_owns_launched_core(PersistentAttached, Ok(false)));
        // A Core started at sign-in serves paired devices after the desktop closes.
        assert!(!desktop_owns_launched_core(PersistentAttached, Ok(true)));
        assert!(!desktop_owns_launched_core(PersistentAttached, Err("unreadable".into())));
    }

    #[cfg(windows)]
    #[test]
    fn owned_core_job_ends_the_child_and_its_descendants() {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // cmd starts the long ping about a second later, after containment, the way the Core
        // starts Suwayomi after it is running.
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "ping -n 2 127.0.0.1 >nul & ping -n 60 127.0.0.1 >nul"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        let pid = child.id();
        let birth = crate::suwayomi_runtime::capture_process_identity(pid);
        let job = OwnedCoreJob::contain(pid, birth.as_ref()).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while job.active_processes().unwrap() < 2 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(job.active_processes().unwrap() >= 2, "descendant joined the job");

        let started = std::time::Instant::now();
        assert!(job.terminate(Duration::from_secs(5)).is_ok());
        assert!(started.elapsed() < Duration::from_secs(5));
        // The job's count drops as the processes end; their handles are signaled a moment later.
        let exit_deadline = std::time::Instant::now() + Duration::from_secs(2);
        while child.try_wait().unwrap().is_none() && std::time::Instant::now() < exit_deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(child.try_wait().unwrap().is_some(), "contained child ended");
    }

    #[cfg(windows)]
    #[test]
    fn owned_core_job_refuses_a_mismatched_birth_identity() {
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"])
            .spawn()
            .unwrap();
        let mut birth = crate::suwayomi_runtime::capture_process_identity(child.id()).unwrap();
        birth.command_line_hash = Some("different".into());
        assert!(OwnedCoreJob::contain(child.id(), Some(&birth)).is_err());
        assert!(OwnedCoreJob::contain(child.id(), None).is_err());
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
