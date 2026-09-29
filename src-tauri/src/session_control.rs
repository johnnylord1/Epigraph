//! Managed desktop control; the application acts on its own window and leases.
use crate::session_control_protocol::{canonical_uuid, sha256, Gate, Request};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::{Arc, Condvar, Mutex, OnceLock}, time::{Duration, Instant}};
use tauri::Manager;

#[derive(Default)]
struct LaunchState { closing: bool, active: usize }
static LAUNCHES: (Mutex<LaunchState>, Condvar) = (Mutex::new(LaunchState { closing: false, active: 0 }), Condvar::new());
pub struct LaunchPermit;
pub fn require_native_install_handoff() -> Result<(), String> {
    Err("Native installation requires graceful close and an attested installer handoff; application and runtime preserved".into())
}
pub fn shutdown_pending() -> bool {
    LAUNCHES.0.lock().map(|state| state.closing).unwrap_or(true)
}
pub fn begin_launch() -> Result<LaunchPermit, String> {
    let mut state = LAUNCHES.0.lock().map_err(|_| "Launch state unavailable")?;
    if state.closing { return Err("Application shutdown is pending; launch refused".into()); }
    state.active += 1;
    Ok(LaunchPermit)
}
impl Drop for LaunchPermit {
    fn drop(&mut self) { if let Ok(mut state) = LAUNCHES.0.lock() { state.active -= 1; LAUNCHES.1.notify_all(); } }
}
pub fn quiesce(timeout: Duration) -> Result<(), String> {
    let mut state = LAUNCHES.0.lock().map_err(|_| "Launch state unavailable")?;
    state.closing = true;
    let (state, _) = LAUNCHES.1.wait_timeout_while(state, timeout, |s| s.active != 0).map_err(|_| "Launch state unavailable")?;
    if state.active != 0 { return Err("Runtime launch still in flight; shutdown unconfirmed".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn b1_native_installer_cannot_bypass_the_owned_exit_handoff() {
        let mut invoked = false;
        let result = require_native_install_handoff().map(|_| { invoked = true; });
        assert!(result.is_err());
        assert!(!invoked, "installer execution must not be enabled without a handoff");
    }
    #[test]
    fn b1_shutdown_blocks_late_launch_and_preserves_an_inflight_permit_on_timeout() {
        let permit = begin_launch().unwrap();
        assert!(quiesce(Duration::from_millis(1)).is_err());
        assert!(shutdown_pending());
        assert!(begin_launch().is_err());
        drop(permit);
        assert!(quiesce(Duration::from_millis(10)).is_ok());
        assert!(begin_launch().is_err());
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Record {
    schema: u32, project: String, profile: String, run_id: String, build: String,
    job: String, app_exe: String, root_pid: u32, root_created: String, root_executable: String,
    control_version: u32, capability: String, artifact_sha256: String, core_sha256: String, build_id: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    version: u32, run_id: String, nonce: String, action: String, accepted: bool,
    record_hash: String, build: String, artifact_sha256: String, build_id: String,
    pid: u32, created: String, detail: String, document: String,
}
struct Challenge { proof: String, document: String, expires: Instant, observed: bool }
pub struct Session {
    gate: Mutex<Gate>, record_path: std::path::PathBuf, record: Record,
    document: Mutex<String>, challenges: Mutex<HashMap<String, Challenge>>,
    // Read-only anchor keeps the EXISTING named job reopenable after host loss.
    #[cfg(windows)]
    _job: JobAnchor,
    _artifact: std::fs::File,
    _core_artifact: std::fs::File,
}
static SESSION: OnceLock<Arc<Session>> = OnceLock::new();
static READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn ready() { READY.store(true, std::sync::atomic::Ordering::Release); }

#[cfg(windows)]
struct JobAnchor(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for JobAnchor {}
#[cfg(windows)]
unsafe impl Sync for JobAnchor {}
#[cfg(windows)]
impl Drop for JobAnchor { fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); } } }

#[cfg(windows)]
fn anchor(record: &Record) -> Result<JobAnchor, String> {
    use windows_sys::Win32::System::{JobObjects::*, Threading::GetCurrentProcess};
    let name: Vec<u16> = record.job.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let handle = OpenJobObjectW(4 /* JOB_OBJECT_QUERY */, 0, name.as_ptr());
        if handle.is_null() { return Err("Existing run job unavailable; control refused".into()); }
        let job = JobAnchor(handle);
        let mut member = 0;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        if IsProcessInJob(GetCurrentProcess(), handle, &mut member) == 0 || member == 0
            || QueryInformationJobObject(handle, JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as _, std::mem::size_of_val(&limits) as u32, std::ptr::null_mut()) == 0
            || limits.BasicLimitInformation.LimitFlags != 0 {
            return Err("Run job membership/configuration unverifiable; control refused".into());
        }
        Ok(job)
    }
}

pub fn page_loaded() {
    if let Some(session) = SESSION.get() {
        if let Ok(mut document) = session.document.lock() { *document = uuid::Uuid::new_v4().to_string(); }
        if let Ok(mut challenges) = session.challenges.lock() { challenges.clear(); }
    }
}

#[tauri::command]
pub fn session_page_attestation(window: tauri::WebviewWindow, nonce: String) -> Result<serde_json::Value, String> {
    if window.label() != "main" { return Err("Attestation requires the main application webview".into()); }
    let session = SESSION.get().ok_or("Unmanaged session")?;
    let document = session.document.lock().map_err(|_| "Document unavailable")?.clone();
    let mut challenges = session.challenges.lock().map_err(|_| "Challenge unavailable")?;
    let challenge = challenges.get_mut(&nonce).ok_or("No active control challenge")?;
    if challenge.expires < Instant::now() || challenge.document != document || challenge.observed {
        return Err("Stale or already observed challenge".into());
    }
    challenge.observed = true;
    Ok(serde_json::json!({"runId":session.record.run_id,"nonce":nonce,"proof":challenge.proof,"document":document}))
}

impl Session {
    fn reply(&self, request: &Request, result: Result<String, String>) -> Reply {
        Reply { version: 1, run_id: self.record.run_id.clone(), nonce: request.nonce.clone(),
            action: request.action.clone(), accepted: result.is_ok(), detail: result.unwrap_or_else(|e| e),
            record_hash: self.gate.lock().unwrap().expected.record_hash.clone(), build: self.record.build.clone(),
            artifact_sha256: self.record.artifact_sha256.clone(), build_id: self.record.build_id.clone(),
            pid: std::process::id(), created: self.record.root_created.clone(), document: self.document.lock().unwrap().clone() }
    }
    fn validate(&self, request: &Request) -> Result<(), String> {
        let raw = std::fs::read(&self.record_path).map_err(|_| "Session evidence unavailable")?;
        let hash = format!("{:x}", Sha256::digest(raw));
        let mut gate = self.gate.lock().map_err(|_| "Control state unavailable")?;
        let unchanged = hash == gate.expected.record_hash;
        gate.accept(request, unchanged)
    }
    async fn action(&self, app: &tauri::AppHandle, request: &Request) -> Result<String, String> {
        self.validate(request)?;
        if !READY.load(std::sync::atomic::Ordering::Acquire) { return Err("Application startup still in progress".into()); }
        match request.action.as_str() {
            "shutdown" => {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || crate::prepare_owned_desktop_shutdown(&app)).await.map_err(|e| e.to_string())??;
                Ok("Runtime cleanup confirmed; awaiting desktop exit".into())
            }
            "focus" | "focus-main" => {
                let window = app.get_webview_window("main").ok_or("Main window unavailable")?;
                if request.action == "focus-main" {
                    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
                    let monitor = monitors.iter().find(|m| m.position().x == 1920)
                        .or_else(|| monitors.iter().max_by_key(|m| m.position().x)).ok_or("Monitor unavailable")?;
                    window.set_position(*monitor.position()).map_err(|e| e.to_string())?;
                    window.set_size(*monitor.size()).map_err(|e| e.to_string())?;
                }
                window.unminimize().map_err(|e| e.to_string())?;
                window.show().map_err(|e| e.to_string())?;
                window.set_focus().map_err(|e| e.to_string())?;
                let position = window.outer_position().map_err(|e| e.to_string())?;
                Ok(format!("main window focus requested at {},{}", position.x, position.y))
            }
            "challenge" => {
                let document = self.document.lock().map_err(|_| "Document unavailable")?.clone();
                let mut challenges = self.challenges.lock().map_err(|_| "Challenge unavailable")?;
                challenges.retain(|_, c| c.expires > Instant::now());
                if challenges.len() >= 64 { return Err("Too many outstanding challenges".into()); }
                challenges.insert(request.nonce.clone(), Challenge { proof: uuid::Uuid::new_v4().to_string(),
                    document, expires: Instant::now() + Duration::from_secs(30), observed: false });
                Ok("Challenge ready for native webview attestation".into())
            }
            "verify-page" => {
                let document = self.document.lock().map_err(|_| "Document unavailable")?.clone();
                let challenge = self.challenges.lock().map_err(|_| "Challenge unavailable")?
                    .remove(request.challenge.as_deref().ok_or("Missing challenge")?).ok_or("Unknown challenge")?;
                if !challenge.observed || challenge.expires < Instant::now() || challenge.document != document
                    || request.proof.as_deref() != Some(challenge.proof.as_str()) { return Err("Page attestation rejected".into()); }
                Ok("Native main webview attested for this document".into())
            }
            "attest" => Ok("Exact application run ready".into()),
            _ => Err("Unsupported action".into()),
        }
    }
}

#[cfg(windows)]
pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
    use crate::suwayomi_runtime::ownership::ProcessObject;
    use std::{io::Read, os::windows::fs::OpenOptionsExt};
    use tokio::{io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader}, net::windows::named_pipe::ServerOptions};
    let Some(path) = std::env::var_os("EPIGRAPH_SESSION_RECORD") else { return Ok(()); };
    let path = std::path::PathBuf::from(path);
    let raw = std::fs::read(&path).map_err(|e| e.to_string())?;
    let record: Record = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let process = crate::suwayomi_runtime::ownership::windows::Process::open(std::process::id(), crate::suwayomi_runtime::command_line_hash)?;
    let identity = process.identity()?;
    if option_env!("EPIGRAPH_BUILD_ID") != Some(record.build_id.as_str())
        || option_env!("EPIGRAPH_SOURCE_FINGERPRINT") != Some(record.build.as_str())
        || record.schema != 1 || record.control_version != 1 || !canonical_uuid(&record.run_id)
        || !canonical_uuid(&record.build_id) || !sha256(&record.build) || !sha256(&record.capability)
        || !sha256(&record.artifact_sha256) || record.project.is_empty() || record.profile.is_empty()
        || std::env::var("EPIGRAPH_SESSION_RUN").ok().as_deref() != Some(&record.run_id)
        || record.job != format!("Local\\Epigraph-{}", record.run_id)
        || record.root_pid != identity.pid || record.root_created != identity.created.to_string()
        || !record.root_executable.eq_ignore_ascii_case(&identity.executable)
        || !record.app_exe.eq_ignore_ascii_case(&identity.executable) {
        return Err("Incomplete or inconsistent managed run evidence; control refused".into());
    }
    let mut artifact = std::fs::OpenOptions::new().read(true).share_mode(1).open(&record.app_exe).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new(); let mut buffer = [0u8; 65536];
    loop { let n = artifact.read(&mut buffer).map_err(|e| e.to_string())?; if n == 0 { break; } hash.update(&buffer[..n]); }
    if format!("{:x}", hash.finalize()) != record.artifact_sha256 { return Err("Running artifact mismatch".into()); }
    let core_path = std::path::Path::new(&record.app_exe).parent().ok_or("Missing artifact directory")?.join("epigraph-syncd.exe");
    let mut core_artifact = std::fs::OpenOptions::new().read(true).share_mode(1).open(core_path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    loop { let n = core_artifact.read(&mut buffer).map_err(|e| e.to_string())?; if n == 0 { break; } hash.update(&buffer[..n]); }
    if !sha256(&record.core_sha256) || format!("{:x}", hash.finalize()) != record.core_sha256 { return Err("Core artifact mismatch".into()); }
    let gate = Gate::new(Request { version: 1, run_id: record.run_id.clone(), nonce: String::new(), project: record.project.clone(),
        profile: record.profile.clone(), build: record.build.clone(), record_hash: format!("{:x}", Sha256::digest(&raw)),
        capability: record.capability.clone(), action: String::new(), challenge: None, proof: None });
    let job = anchor(&record)?;
    let name = format!(r"\\.\pipe\Epigraph-{}", record.run_id);
    let mut pipe = tauri::async_runtime::block_on(async {
        ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true).create(&name)
    }).map_err(|e| e.to_string())?;
    let session = Arc::new(Session { gate: Mutex::new(gate), record_path: path, record,
        document: Mutex::new(uuid::Uuid::new_v4().to_string()), challenges: Mutex::new(HashMap::new()), _job: job, _artifact: artifact, _core_artifact: core_artifact });
    SESSION.set(session.clone()).map_err(|_| "Duplicate managed session")?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if pipe.connect().await.is_err() { break; }
            // Create the next instance before releasing this one: no name-rebind gap.
            let next = match ServerOptions::new().reject_remote_clients(true).create(&name) { Ok(p) => p, Err(_) => break };
            let mut line = String::new();
            let read = tokio::time::timeout(Duration::from_secs(5), BufReader::new((&mut pipe).take(16385)).read_line(&mut line)).await;
            if matches!(read, Ok(Ok(_))) && line.len() <= 16384 {
                if let Ok(request) = serde_json::from_str::<Request>(&line) {
                    let result = session.action(&app, &request).await;
                    let exiting = result.is_ok() && request.action == "shutdown";
                    let reply = session.reply(&request, result);
                    if let Ok(mut bytes) = serde_json::to_vec(&reply) {
                        bytes.push(b'\n');
                        let sent = tokio::time::timeout(Duration::from_secs(5), pipe.write_all(&bytes)).await;
                        if exiting && matches!(sent, Ok(Ok(()))) { app.exit(0); }
                    }
                }
            }
            pipe = next;
        }
    });
    Ok(())
}
#[cfg(not(windows))]
pub fn install(_: &tauri::AppHandle) -> Result<(), String> {
    if std::env::var_os("EPIGRAPH_SESSION_RECORD").is_some() { Err("Managed control requires Windows".into()) } else { Ok(()) }
}
