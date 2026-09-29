use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const RUNTIME_MANIFEST_SCHEMA_VERSION: u32 = 1;
const RUNTIME_MANIFEST_FILE_NAME: &str = "runtime.json";
const RUNTIME_LOCK_FILE_NAME: &str = "runtime.lock";
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdRuntimeManifest {
    pub schema_version: u32,
    pub pid: u32,
    pub server_id: String,
    pub port: u16,
    pub fingerprint: String,
    pub exe: String,
    pub started_at_ms: u128,
    #[serde(default)]
    pub run_id: String,
    #[serde(default)]
    pub process_identity: Option<crate::suwayomi_runtime::RuntimeProcessIdentity>,
}

impl SyncdRuntimeManifest {
    pub fn new(
        pid: u32,
        server_id: impl Into<String>,
        port: u16,
        fingerprint: impl Into<String>,
        exe: impl Into<String>,
    ) -> Self {
        Self {
            schema_version: RUNTIME_MANIFEST_SCHEMA_VERSION,
            pid,
            server_id: server_id.into(),
            port,
            fingerprint: fingerprint.into(),
            exe: exe.into(),
            started_at_ms: unix_now_millis(),
            run_id: current_run_id().to_string(),
            process_identity: if pid == std::process::id() { crate::suwayomi_runtime::capture_process_identity(pid) } else { None },
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != RUNTIME_MANIFEST_SCHEMA_VERSION {
            return Err(format!(
                "unsupported syncd runtime manifest schema version {}",
                self.schema_version
            ));
        }
        if self.pid == 0 {
            return Err("syncd runtime manifest has an invalid PID".to_string());
        }
        if self.server_id.trim().is_empty() {
            return Err("syncd runtime manifest is missing serverId".to_string());
        }
        if self.port == 0 {
            return Err("syncd runtime manifest has an invalid port".to_string());
        }
        if !is_sha256_hex(&self.fingerprint) {
            return Err("syncd runtime manifest has an invalid fingerprint".to_string());
        }
        if self.exe.trim().is_empty() || !Path::new(&self.exe).is_absolute() {
            return Err("syncd runtime manifest has an invalid executable path".to_string());
        }
        Ok(())
    }
}

pub fn current_run_id() -> &'static str {
    static RUN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    RUN.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

#[derive(Debug)]
pub struct RuntimeManifestLease;

#[derive(Debug)]
pub struct RuntimeProcessLock {
    file: std::fs::File,
}

impl RuntimeProcessLock {
    pub fn acquire(data_dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(data_dir)?;
        let path = data_dir.join(RUNTIME_LOCK_FILE_NAME);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&path)?;
        file.try_lock_exclusive().map_err(|error| {
            io::Error::new(
                error.kind(),
                format!(
                    "another persistent Core process owns {}: {error}",
                    path.display()
                ),
            )
        })?;
        file.set_len(0)?;
        writeln!(&file, "pid={}", std::process::id())?;
        file.sync_all()?;
        Ok(Self { file })
    }
}

impl Drop for RuntimeProcessLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

impl RuntimeManifestLease {
    pub fn publish(data_dir: &Path, manifest: &SyncdRuntimeManifest) -> io::Result<Self> {
        manifest
            .validate()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let path = runtime_manifest_path(data_dir);
        if !reconcile_exited_runtime_manifest(&path) {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "Unconfirmed Core evidence preserved; graceful/manual reconciliation required"));
        }
        let payload = serde_json::to_vec_pretty(manifest)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        atomic_write(&path, &payload)?;
        Ok(Self)
    }
}

impl Drop for RuntimeManifestLease {
    fn drop(&mut self) {
        // Self teardown cannot certify our own OS exit. The controller retains
        // the process handle and records completion; preserve original evidence.
    }
}

pub fn runtime_manifest_path(data_dir: &Path) -> PathBuf {
    data_dir.join(RUNTIME_MANIFEST_FILE_NAME)
}

/// Returns `true` when no live process can own the manifest at `path`: it is absent, carries a
/// stop receipt, or the Core it records is proven gone. A Core ended by a reboot, logoff or crash
/// never receives a graceful stop, so its proven exit is recorded as the receipt here; otherwise
/// the next Core, the installer and the desktop would refuse that data directory forever.
/// Live, unverifiable or malformed evidence is preserved and returns `false`.
pub fn reconcile_exited_runtime_manifest(path: &Path) -> bool {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) => return error.kind() == io::ErrorKind::NotFound,
    };
    if crate::suwayomi_runtime::has_confirmed_stop(path) {
        return true;
    }
    let Ok(manifest) = serde_json::from_slice::<SyncdRuntimeManifest>(&raw) else {
        return false;
    };
    crate::suwayomi_runtime::confirm_exited_owner(
        path,
        &raw,
        manifest.pid,
        manifest.process_identity.as_ref(),
    )
}

#[allow(dead_code)]
pub fn read_runtime_manifest(data_dir: &Path) -> Result<SyncdRuntimeManifest, String> {
    read_runtime_manifest_path(&runtime_manifest_path(data_dir))
}

fn read_runtime_manifest_path(path: &Path) -> Result<SyncdRuntimeManifest, String> {
    let payload =
        fs::read(path).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let manifest: SyncdRuntimeManifest = serde_json::from_slice(&payload)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))?;
    manifest.validate()?;
    Ok(manifest)
}

fn atomic_write(path: &Path, payload: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime manifest path has no parent directory",
        )
    })?;
    fs::create_dir_all(parent)?;

    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp_path = parent.join(format!(
        ".{RUNTIME_MANIFEST_FILE_NAME}.{}.{}.tmp",
        std::process::id(),
        sequence
    ));

    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        file.write_all(payload)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temp_path, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

/// Shares the long-path-safe replace used by the runtime maintenance state.
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    crate::suwayomi_maintenance::atomic_replace_file(source, destination)
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
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
    fn process_lock_rejects_a_second_owner() {
        let temp = tempfile::tempdir().unwrap();
        let first = RuntimeProcessLock::acquire(temp.path()).unwrap();
        let error = RuntimeProcessLock::acquire(temp.path()).unwrap_err();
        assert!(error
            .to_string()
            .contains("another persistent Core process"));
        drop(first);
        RuntimeProcessLock::acquire(temp.path()).unwrap();
    }
    use tempfile::tempdir;

    fn manifest(pid: u32, server_id: &str) -> SyncdRuntimeManifest {
        SyncdRuntimeManifest::new(
            pid,
            server_id,
            4777,
            "a".repeat(64),
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        )
    }

    #[test]
    fn atomic_write_replaces_a_manifest_beyond_max_path() {
        let temp = tempdir().unwrap();
        let deep = temp.path().join("a".repeat(120)).join("b".repeat(120));
        let path = deep.join(RUNTIME_MANIFEST_FILE_NAME);
        assert!(path.as_os_str().len() > 260);

        atomic_write(&path, b"first").unwrap();
        atomic_write(&path, b"second").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert_eq!(fs::read_dir(&deep).unwrap().count(), 1);
    }

    #[test]
    fn manifest_serializes_required_attach_identity() {
        let value = serde_json::to_value(manifest(42, "server-a")).unwrap();
        assert_eq!(value["pid"], 42);
        assert_eq!(value["serverId"], "server-a");
        assert_eq!(value["port"], 4777);
        assert_eq!(value["fingerprint"], "a".repeat(64));
        assert!(value["exe"].as_str().unwrap().contains("epigraph"));
    }

    #[test]
    fn atomic_publish_replaces_previous_manifest() {
        let temp = tempdir().unwrap();
        // The first owner is this live test process, so its evidence cannot be reconciled away.
        let first = RuntimeManifestLease::publish(
            temp.path(),
            &manifest(std::process::id(), "server-a"),
        )
        .unwrap();
        assert!(RuntimeManifestLease::publish(temp.path(), &manifest(42, "server-a")).is_err());
        let raw = fs::read(runtime_manifest_path(temp.path())).unwrap();
        // Fixture certificate represents an externally confirmed old process exit.
        crate::suwayomi_runtime::record_confirmed_stop(&runtime_manifest_path(temp.path()), &raw).unwrap();
        let second = RuntimeManifestLease::publish(temp.path(), &manifest(42, "server-a")).unwrap();

        assert_eq!(read_runtime_manifest(temp.path()).unwrap().pid, 42);
        let temporary_files = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary_files, 0);

        drop(first);
        assert_eq!(read_runtime_manifest(temp.path()).unwrap().pid, 42);
        drop(second);
        assert!(runtime_manifest_path(temp.path()).exists());
    }

    #[cfg(windows)]
    #[test]
    fn manifest_left_by_an_exited_core_is_reconciled_on_the_next_start() {
        use std::os::windows::process::CommandExt;
        let temp = tempdir().unwrap();
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 60"])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let mut crashed = manifest(child.id(), "server-a");
        crashed.process_identity = crate::suwayomi_runtime::capture_process_identity(child.id());
        let path = runtime_manifest_path(temp.path());
        fs::write(&path, serde_json::to_vec_pretty(&crashed).unwrap()).unwrap();

        // While the recorded Core is alive its evidence is preserved.
        assert!(!reconcile_exited_runtime_manifest(&path));
        assert!(RuntimeManifestLease::publish(temp.path(), &manifest(42, "server-a")).is_err());

        // A reboot or crash ends the Core without a graceful stop.
        child.kill().unwrap();
        child.wait().unwrap();
        let _next = RuntimeManifestLease::publish(temp.path(), &manifest(42, "server-a")).unwrap();
        assert_eq!(read_runtime_manifest(temp.path()).unwrap().pid, 42);

        let missing = temp.path().join("missing").join(RUNTIME_MANIFEST_FILE_NAME);
        assert!(reconcile_exited_runtime_manifest(&missing));
        fs::write(&path, b"{ malformed").unwrap();
        assert!(
            !reconcile_exited_runtime_manifest(&path),
            "malformed evidence is preserved"
        );
    }

    #[test]
    fn validation_rejects_unpinnable_fingerprint() {
        let mut invalid = manifest(42, "server-a");
        invalid.fingerprint = "not-a-sha256".to_string();
        assert!(invalid.validate().unwrap_err().contains("fingerprint"));
    }
}
